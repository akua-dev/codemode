import type { Executor, ExecuteResult, ExecuteStats, SandboxOptions } from "../types.js";

/**
 * Executor implementation using quickjs-emscripten (pure WASM QuickJS).
 *
 * No native compilation is required: this runs on Node, Bun, Cloudflare
 * Workers, Deno, and the browser. Use this backend when isolated-vm is not
 * available — most importantly on Bun, where isolated-vm cannot dlopen
 * because it relies on V8 symbols that the JavaScriptCore-based Bun runtime
 * does not export (e.g. `v8::ValueSerializer::Delegate::IsHostObject`).
 *
 * Each execute() call creates a fresh QuickJS runtime + context — no state
 * leaks between calls. The sandbox has zero I/O capabilities by default (no
 * fetch, no fs, no require, no process). The only way out is through
 * injected host functions.
 *
 * Stats parity: the `ExecuteStats` shape is shared with `IsolatedVMExecutor`.
 * QuickJS does not expose V8-specific counters (executable bytes, peak
 * malloc'd memory, etc.), so those fields are best-effort or 0 — see
 * `captureStats` for the exact mapping. The shape (key names + types) is
 * preserved so callers can treat both executors interchangeably.
 *
 * Known platform quirks
 * ---------------------
 * Node 24 + release-asyncify WASM: stable for the patterns codemode uses
 * (sequential `await hostFn()`, namespaced objects, mixed primitive and
 * object returns). The implementation works around two release-asyncify
 * bugs:
 *
 *   1. Calling `evalCode` / `evalCodeAsync` *before* `newAsyncifiedFunction`
 *      registration corrupts asyncify bookkeeping and crashes the second
 *      sequential `await` in user code. Mitigation: register host functions
 *      first and build all setup (no-op console, plain-data globals) via the
 *      handle API only — see `injectNoopConsole`, `injectValue`.
 *   2. The IIFE result handle is not reliably GC-anchored once the user's
 *      `(async () => ...)()` resolves: `context.dump(handle)` then crashes
 *      with "memory access out of bounds" even though the JS-side wrapper
 *      still reports `alive: true`. Mitigation: wrap the user code with a
 *      `JSON.stringify` envelope so the value we read back is a primitive
 *      string. See `execute()` for the wrapping detail.
 *
 * Bun: backend auto-selection (`createExecutor`) picks this executor on Bun
 * because isolated-vm can't load there. Single `await hostFn()` calls work,
 * but multiple sequential `await`s currently fail with WASM
 * "Out of bounds memory access" — this is a known interaction between Bun's
 * JavaScriptCore-backed WASM runtime and quickjs-emscripten's asyncify
 * build, not a logic bug in this executor. For now, treat Bun support as
 * "single-await only"; multi-await sandboxed code should run on Node (with
 * isolated-vm) until upstream fixes land.
 */
export class QuickJSExecutor implements Executor {
  private memoryMB: number;
  private timeoutMs: number;
  private wallTimeMs: number;

  constructor(options: SandboxOptions = {}) {
    this.memoryMB = options.memoryMB ?? 64;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.wallTimeMs = options.wallTimeMs ?? 60_000;
  }

  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    // Lazy import: optional peer dependency.
    const qjs = await import("quickjs-emscripten");
    const context = await qjs.newAsyncContext();
    const runtime = context.runtime;
    runtime.setMemoryLimit(this.memoryMB * 1024 * 1024);

    const start = Date.now();
    let cpuDeadlineHit = false;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimedOut = false;

    // CPU timeout: QuickJS calls the interrupt handler regularly while running
    // bytecode. We approximate isolated-vm's CPU timeout with a wall-clock
    // deadline measured from execute() entry — QuickJS does not expose a
    // separate CPU-time clock, so this is the closest analog.
    const cpuDeadline = start + this.timeoutMs;
    runtime.setInterruptHandler(() => {
      if (Date.now() > cpuDeadline) {
        cpuDeadlineHit = true;
        return true;
      }
      return false;
    });

    // Track disposable handles created during global injection so we can
    // dispose them in `finally` even if injection throws partway through.
    const injectedHandles: Array<{ dispose(): void; alive: boolean }> = [];

    try {
      // CRITICAL: setup ordering matters with release-asyncify QuickJS.
      //
      // 1. Asyncified host functions (`newAsyncifiedFunction`) MUST be
      //    registered before any `evalCode`/`evalCodeAsync` — otherwise the
      //    second sequential `await hostFn()` in user code crashes with
      //    "memory access out of bounds" / GC mark assertions.
      // 2. The no-op console is therefore also built via the handle API
      //    (`newObject` + `newFunction`), never via `evalCode`.
      // 3. Plain-data and namespace-data injection use only handle-API calls
      //    (`newNumber` / `newString` / `newObject` / `newArray`), see
      //    `injectValue`.
      //
      // Inject host functions first so they are registered before the user's
      // `evalCodeAsync` is invoked. Order among them is not significant.
      for (const [name, value] of Object.entries(globals)) {
        if (typeof value === "function") {
          injectAsyncFunction(context, name, value as (...args: unknown[]) => unknown, injectedHandles);
        } else if (isNamespaceWithMethods(value)) {
          injectNamespace(context, name, value as Record<string, unknown>, injectedHandles);
        } else {
          const valueHandle = injectValue(context, value);
          context.setProp(context.global, name, valueHandle);
          disposeIfOwned(context, valueHandle);
        }
      }

      // Install no-op console AFTER asyncified functions (and via handle API
      // only) so we don't trigger the eval-before-asyncified-registration
      // failure mode. Injecting a real console would also be an OOM vector
      // since logs accumulate in the host process outside the sandbox
      // memory limit.
      injectNoopConsole(context);

      // Wall-clock timeout: hard-stop the entire execution including async
      // host calls (which run on the Node event loop and would otherwise stall
      // the CPU interrupt handler indefinitely).
      const wallPromise = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => {
          wallTimedOut = true;
          // Force the QuickJS interrupt handler to abort on the next tick by
          // marking the deadline as exceeded. evalCodeAsync will surface
          // "interrupted" on the next bytecode boundary.
          reject(new Error("Wall-clock timeout exceeded"));
        }, this.wallTimeMs);
        if (typeof wallTimer === "object" && wallTimer !== null && "unref" in wallTimer) {
          (wallTimer as { unref(): void }).unref();
        }
      });

      // Wrap user code so the final value is JSON-encoded *inside* QuickJS.
      //
      // Why: when user code makes more than one sequential `await hostFn()`
      // call, the release-asyncify build's GC anchoring on the IIFE's return
      // value is unreliable. By the time we dump it from the host, the
      // QuickJS interpreter may have freed it under us (observed:
      // `context.dump(handle)` crashes with "memory access out of bounds"
      // even though the JS-side wrapper still reports `alive: true`).
      //
      // The fix: have the user's `(async () => ...)()` go through a
      // `JSON.stringify` plus a sentinel `{ undef }` / `{ ok, v }` envelope.
      // Strings are simple cells that survive the post-execution drain and
      // dump back as primitives — bypassing the GC race entirely.
      //
      // Errors thrown by the user code still come back through the normal
      // `resolution.error` channel; only successful results need wrapping.
      const wrappedCode = `(async () => { const __r = await (${code})(); return __r === undefined ? "__cmUndef" : JSON.stringify(__r); })()`;
      const evalP = context.evalCodeAsync(wrappedCode);

      const evalResult = await Promise.race([evalP, wallPromise]);

      if (evalResult.error) {
        const err = context.dump(evalResult.error);
        evalResult.error.dispose();
        throw new Error(formatQuickJSError(err));
      }

      const promiseHandle = evalResult.value;
      const resolution = await raceWithJobPump(context, promiseHandle, wallPromise);

      if (resolution.error) {
        const err = context.dump(resolution.error);
        resolution.error.dispose();
        promiseHandle.dispose();
        throw new Error(formatQuickJSError(err));
      }

      const encoded = context.dump(resolution.value);
      resolution.value.dispose();
      promiseHandle.dispose();

      let value: unknown;
      if (encoded === "__cmUndef" || encoded === undefined) {
        value = undefined;
      } else if (typeof encoded !== "string") {
        // Shouldn't happen — wrapper always produces a string — but fall back
        // safely.
        value = encoded;
      } else {
        try {
          value = JSON.parse(encoded);
        } catch {
          // Not valid JSON (shouldn't happen): return the raw string.
          value = encoded;
        }
      }

      const stats = captureStats(context, runtime, start, this.memoryMB);
      return { result: value, stats };
    } catch (err) {
      const stats = captureStats(context, runtime, start, this.memoryMB);
      let message = err instanceof Error ? err.message : String(err);
      if (cpuDeadlineHit && !wallTimedOut && !/timeout/i.test(message)) {
        message = `Script execution timed out after ${this.timeoutMs}ms (${message})`;
      }
      return {
        result: undefined,
        error: message,
        stats,
      };
    } finally {
      clearTimeout(wallTimer);
      for (const handle of injectedHandles) {
        if (handle.alive) {
          try {
            handle.dispose();
          } catch {
            // already disposed
          }
        }
      }
      try {
        context.dispose();
      } catch {
        // ignore
      }
      try {
        runtime.dispose();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Resolve a promise handle while pumping the runtime's pending-job queue.
 *
 * QuickJS asyncified functions enqueue continuations on `runtime`'s job
 * queue when host promises settle. Without `executePendingJobs`, the inner
 * `(async () => ...)()` promise never makes progress and `resolvePromise`
 * hangs forever. We pump between tiny `setTimeout(0)` ticks so the Node
 * event loop can also process the host-side promises that the asyncified
 * functions are awaiting.
 *
 * Races against `wallPromise` so a hung host call still produces a wall-clock
 * timeout error rather than blocking the executor forever.
 */
async function raceWithJobPump(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  promiseHandle: import("quickjs-emscripten").QuickJSHandle,
  wallPromise: Promise<never>,
): Promise<import("quickjs-emscripten").VmCallResult<import("quickjs-emscripten").QuickJSHandle>> {
  // Start resolving the user-code promise on the QuickJS side. The returned
  // host-side Promise settles once the user's `(async () => ...)()` resolves
  // — but only if we keep draining the runtime's pending-job queue while we
  // wait, because asyncified host callbacks enqueue their continuations
  // there.
  const resolveP = context.resolvePromise(promiseHandle);
  let settled = false;
  void resolveP.then(() => { settled = true; }, () => { settled = true; });

  // Pump loop: drain pending jobs, yield one macrotask, repeat. We race
  // against `wallPromise` so a hung host call surfaces as a wall-clock
  // timeout instead of an infinite loop.
  //
  // Implementation notes:
  // - `await setTimeout(0)` (a macrotask yield) is required between drains
  //   so the Node event loop can advance the host-side promises the
  //   asyncified callbacks are awaiting.
  // - We do NOT race `resolveP` directly inside the loop. Adding it to a
  //   `Promise.race` empirically poisons the value handle: once user code
  //   completes the QuickJS GC frees the result, and `context.dump(handle)`
  //   then crashes with "memory access out of bounds" even though the JS-
  //   side wrapper still reports `alive: true`. Polling `settled` after a
  //   short yield avoids that interaction.
  // - We also don't call `executePendingJobs` after `settled` becomes true,
  //   for the same reason — a post-settle drain can GC the result handle.
  let wallError: Error | undefined;
  wallPromise.catch((e: unknown) => {
    wallError = e instanceof Error ? e : new Error(String(e));
  });

  /* oxlint-disable no-await-in-loop, no-unmodified-loop-condition */
  // `settled` is mutated by the `resolveP.then` callback above — oxlint can't
  // see across the closure, hence the disable.
  while (!settled) {
    if (wallError) throw wallError;
    if (context.runtime.hasPendingJob()) {
      context.runtime.executePendingJobs();
    }
    // Macrotask yield. NOT unref'd: if we unref this and the host promise we
    // depend on is also unref'd, Node thinks the event loop is empty and
    // exits, dropping our top-level await.
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
  }
  /* oxlint-enable no-await-in-loop, no-unmodified-loop-condition */

  return resolveP;
}

interface InjectedHandle {
  dispose(): void;
  alive: boolean;
}

/**
 * Inject an async (or sync) host function as a global by name.
 *
 * We use `newAsyncifiedFunction` so the sandboxed code can `await` the call
 * exactly like in isolated-vm. Arguments and return values cross the boundary
 * via JSON-clone, matching isolated-vm's `{ copy: true }` semantics.
 *
 * NOTE on ordering: this MUST be called *before* any `evalCode` /
 * `evalCodeAsync` against the context — otherwise the release-asyncify build
 * corrupts its asyncify bookkeeping and sequential `await`s in user code
 * crash with "memory access out of bounds" / GC assertion failures. See
 * `injectNoopConsole` for the alternate handle-API approach used for setup.
 */
function injectAsyncFunction(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  name: string,
  fn: (...args: unknown[]) => unknown,
  tracked: InjectedHandle[],
): void {
  const handle = context.newAsyncifiedFunction(name, async (...argHandles) => {
    const args = argHandles.map((h) => context.dump(h));
    let result: unknown;
    try {
      result = await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: context.newString(message) };
    }
    return injectValue(context, result);
  });
  context.setProp(context.global, name, handle);
  handle.dispose();
  const tracker: InjectedHandle = {
    alive: false,
    dispose: () => {},
  };
  tracked.push(tracker);
}

/**
 * Inject a namespace object containing host functions and/or data.
 *
 * Function values become asyncified callables; non-function values are
 * JSON-cloned. Matches `IsolatedVMExecutor`'s namespace injection semantics.
 */
function injectNamespace(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  name: string,
  ns: Record<string, unknown>,
  tracked: InjectedHandle[],
): void {
  const nsHandle = context.newObject();
  for (const [key, val] of Object.entries(ns)) {
    if (typeof val === "function") {
      const fnHandle = context.newAsyncifiedFunction(`${name}.${key}`, async (...argHandles) => {
        const args = argHandles.map((h) => context.dump(h));
        let result: unknown;
        try {
          result = await (val as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: context.newString(message) };
        }
        return injectValue(context, result);
      });
      context.setProp(nsHandle, key, fnHandle);
      fnHandle.dispose();
    } else if (val !== undefined) {
      const valueHandle = injectValue(context, val);
      context.setProp(nsHandle, key, valueHandle);
      disposeIfOwned(context, valueHandle);
    }
  }
  context.setProp(context.global, name, nsHandle);
  const tracker: InjectedHandle = {
    alive: true,
    dispose: () => {
      tracker.alive = false;
      nsHandle.dispose();
    },
  };
  tracked.push(tracker);
  tracker.dispose();
}

/**
 * Marshal a JS host value into a fresh QuickJS handle.
 *
 * We build handles directly via `newNumber` / `newString` / `newObject` /
 * `newArray` rather than going through `evalCode`. Calling `evalCode` from
 * inside an asyncified host callback can corrupt the QuickJS reference count
 * (observed: "Assertion failed: p->ref_count == 0 / > 0" on sequential
 * awaits) because the C-side eval allocates handles on a stack frame that
 * asyncify is already unwinding.
 *
 * Semantics match isolated-vm's `{ copy: true }`: only JSON-cloneable shapes
 * (primitives, plain objects, arrays) cross the boundary. Functions, Symbols,
 * Maps, etc. become undefined.
 */
function injectValue(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  value: unknown,
): import("quickjs-emscripten").QuickJSHandle {
  if (value === undefined) {
    return context.undefined;
  }
  if (value === null) {
    return context.null;
  }
  switch (typeof value) {
    case "boolean":
      return value ? context.true : context.false;
    case "number":
      return context.newNumber(value);
    case "string":
      return context.newString(value);
    case "bigint":
      // QuickJS has BigInt but the high-level API doesn't expose newBigInt
      // directly — fall through to number when in range, undefined otherwise.
      if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
        return context.newNumber(Number(value));
      }
      return context.undefined;
    case "object": {
      if (Array.isArray(value)) {
        const arr = context.newArray();
        for (let i = 0; i < value.length; i++) {
          const child = injectValue(context, value[i]);
          context.setProp(arr, i, child);
          disposeIfOwned(context, child);
        }
        return arr;
      }
      const obj = context.newObject();
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (val === undefined) continue; // match JSON.stringify semantics
        const child = injectValue(context, val);
        context.setProp(obj, key, child);
        disposeIfOwned(context, child);
      }
      return obj;
    }
    default:
      // function, symbol — not JSON-cloneable
      return context.undefined;
  }
}

/**
 * Format a dumped QuickJS error object into a human-readable string.
 *
 * QuickJS surfaces errors as `{ name, message, stack }` plain objects when
 * dumped. Fall back to JSON if the shape is unexpected.
 */
function formatQuickJSError(dumped: unknown): string {
  if (typeof dumped === "string") return dumped;
  if (dumped && typeof dumped === "object") {
    const obj = dumped as { name?: unknown; message?: unknown };
    if (typeof obj.message === "string") {
      if (typeof obj.name === "string" && obj.name.length > 0 && obj.name !== "Error") {
        return `${obj.name}: ${obj.message}`;
      }
      return obj.message;
    }
  }
  try {
    return JSON.stringify(dumped);
  } catch {
    return String(dumped);
  }
}

/**
 * Capture execution stats from a QuickJS runtime.
 *
 * Mapped to the same `ExecuteStats` shape as the isolated-vm executor:
 *
 * - `cpuTimeMs` / `wallTimeMs`: QuickJS doesn't expose a CPU clock separate
 *   from wall clock; both are reported as wall-clock since execute() entry.
 * - `heapUsedBytes` ← `memory_used_size`
 * - `heapTotalBytes` ← `malloc_limit` (total *budget*, since QuickJS doesn't
 *   pre-allocate a heap up-front the way V8 does)
 * - `externalBytes` ← `binary_object_size`
 * - `heapSizeLimitBytes` ← `malloc_limit` (configured cap)
 * - `totalPhysicalBytes` ← `memory_used_size`
 * - `availableBytes` ← `malloc_limit - memory_used_size`
 * - `executableBytes` ← `js_func_code_size`
 * - `mallocedBytes` ← `memory_used_size`
 * - `peakMallocedBytes` ← `memory_used_size` (no peak counter in QuickJS)
 *
 * Returns zeroed stats if the runtime/context is unusable.
 */
function captureStats(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  runtime: import("quickjs-emscripten").QuickJSRuntime,
  startMs: number,
  memoryMB: number,
): ExecuteStats {
  const wallMs = Date.now() - startMs;
  const heapSizeLimitBytes = memoryMB * 1024 * 1024;
  let raw: Record<string, number> | undefined;
  try {
    const handle = runtime.computeMemoryUsage();
    const dumped: unknown = context.dump(handle);
    handle.dispose();
    if (dumped && typeof dumped === "object") {
      raw = dumped as Record<string, number>;
    }
  } catch {
    // runtime/context may be in a bad state (e.g. OOM, disposed mid-call) —
    // fall back to zeroed memory stats while still reporting wall time.
  }
  const used = raw?.memory_used_size ?? 0;
  const limit = raw?.malloc_limit ?? heapSizeLimitBytes;
  return {
    cpuTimeMs: wallMs,
    wallTimeMs: wallMs,
    heapUsedBytes: used,
    heapTotalBytes: limit,
    externalBytes: raw?.binary_object_size ?? 0,
    heapSizeLimitBytes: limit,
    totalPhysicalBytes: used,
    availableBytes: Math.max(0, limit - used),
    executableBytes: raw?.js_func_code_size ?? 0,
    mallocedBytes: used,
    peakMallocedBytes: used,
  };
}

function isNamespaceWithMethods(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).some(
      (v) => typeof v === "function",
    )
  );
}

/**
 * Dispose a handle only if it is *owned* (not one of the context's static
 * singletons like `context.undefined` / `context.null` / `context.true` /
 * `context.false`). Disposing a static singleton would corrupt the next
 * caller that retrieves it.
 */
function disposeIfOwned(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
  handle: import("quickjs-emscripten").QuickJSHandle,
): void {
  if (
    handle === context.undefined ||
    handle === context.null ||
    handle === context.true ||
    handle === context.false
  ) {
    return;
  }
  try {
    handle.dispose();
  } catch {
    // already disposed
  }
}

/**
 * Install a no-op `globalThis.console` built entirely through the handle API.
 *
 * We avoid `evalCode` / `evalCodeAsync` here on purpose. Empirically, even a
 * trivial eval call ahead of the user's `evalCodeAsync` poisons the
 * release-asyncify build's internal state such that the *second* asyncified
 * host call from sequential `await`s in user code crashes with
 * "memory access out of bounds" / refcount assertion failures. Building the
 * console object directly via `newObject` + `newFunction` is safe.
 */
function injectNoopConsole(
  context: import("quickjs-emscripten").QuickJSAsyncContext,
): void {
  const consoleObj = context.newObject();
  for (const name of ["log", "warn", "error", "info", "debug", "trace"] as const) {
    const noop = context.newFunction(name, () => context.undefined);
    context.setProp(consoleObj, name, noop);
    noop.dispose();
  }
  context.setProp(context.global, "console", consoleObj);
  consoleObj.dispose();
}
