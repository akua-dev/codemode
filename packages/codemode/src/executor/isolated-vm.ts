import {
  DEFAULT_MAX_RESULT_BYTES,
} from "../limits.js";
import type { Executor, ExecuteResult, ExecuteStats, SandboxOptions } from "../types.js";
import { findFunctionPath, rejectDataOnlyFunctions } from "./data-only.js";

const UTF8_BYTE_LENGTH_SOURCE = `function(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}`;

/**
 * Executor implementation using isolated-vm (V8 isolates).
 * Requires `isolated-vm` v6+ as a peer dependency.
 *
 * Each execute() call creates a fresh V8 isolate with its own heap — no state
 * leaks between calls. The sandbox has zero I/O capabilities by default (no
 * fetch, no fs, no require). Host callbacks fail closed; use LLRT for
 * request-capable execution.
 */
export class IsolatedVMExecutor implements Executor {
  private memoryMB: number;
  private timeoutMs: number;
  private wallTimeMs: number;
  private maxResultBytes: number;

  constructor(options: SandboxOptions = {}) {
    this.memoryMB = options.memoryMB ?? 64;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.wallTimeMs = options.wallTimeMs ?? 60_000;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  }

  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    if (hasHostFunctions(globals)) {
      return {
        result: undefined,
        error:
          "IsolatedVMExecutor does not support host functions; use LlrtNativeExecutor for request-capable execution",
        stats: emptyStats(0, this.memoryMB),
      };
    }

    // @ts-ignore — optional peer dependency
    const ivm = (await import("isolated-vm")).default ?? (await import("isolated-vm"));
    const isolate = new ivm.Isolate({ memoryLimit: this.memoryMB });
    const abortController = new AbortController();

    let context: Awaited<ReturnType<typeof isolate.createContext>> | undefined;
    try {
      context = await isolate.createContext();
      const jail = context.global;
      await jail.set("global", jail.derefInto());

      // No-op console — sandbox code should return data, not log it.
      // Injecting a real console would create an OOM vector since logs
      // accumulate in the host process outside the isolate memory limit.
      await context.eval(`
        globalThis.console = {
          log: () => {},
          warn: () => {},
          error: () => {},
        };
      `);

      // Inject globals — sequential awaits required: each jail.set/context.eval
      // depends on prior state (ref counters, globalThis assignments).
      /* oxlint-disable no-await-in-loop */
      for (const [name, value] of Object.entries(globals)) {
        // Plain data: inject as JSON
        await context.eval(
          `globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value)};`,
        );
      }
      /* oxlint-enable no-await-in-loop */

      // Execute the code with both CPU timeout and wall-clock timeout.
      // The ivm timeout only covers CPU time; async host calls (request bridge)
      // can stall indefinitely without a wall-clock guard.
      const wrappedCode = `(async () => {
        const __codemodeJsonStringify = JSON.stringify.bind(JSON);
        const __codemodeUtf8ByteLength = ${UTF8_BYTE_LENGTH_SOURCE};
        const result = await (${code})();
        if (result === undefined) return "__cmUndef";
        const resultJson = __codemodeJsonStringify(result);
        if (resultJson === undefined) return "__cmUndef";
        if (__codemodeUtf8ByteLength(resultJson) > ${this.maxResultBytes}) {
          throw new Error("Execution result exceeds limit of ${this.maxResultBytes} bytes");
        }
        return resultJson;
      })()`;
      const script = await isolate.compileScript(wrappedCode);

      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        script.run(context, {
          timeout: this.timeoutMs,
          promise: true,
          copy: true,
        }).finally(() => clearTimeout(wallTimer)),
        new Promise<never>((_, reject) => {
          wallTimer = setTimeout(
            () => {
              abortController.abort();
              reject(new Error("Wall-clock timeout exceeded"));
            },
            this.wallTimeMs,
          );
          // Don't prevent process exit
          if (typeof wallTimer === "object" && wallTimer !== null && "unref" in wallTimer) {
            (wallTimer as { unref(): void }).unref();
          }
        }),
      ]);

      const stats = captureStats(isolate);
      validateExecutionResult(result, this.maxResultBytes);
      return { result: parseExecutionResult(result), stats };
    } catch (err) {
      const stats = captureStats(isolate);
      return {
        result: undefined,
        error: err instanceof Error ? err.message : String(err),
        stats,
      };
    } finally {
      context?.release();
      abortController.abort();
      if (!isolate.isDisposed) {
        isolate.dispose();
      }
    }
  }

  async executeData(
    code: string,
    input: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    const rejection = rejectDataOnlyFunctions(input, emptyStats(0, this.memoryMB));
    if (rejection) return rejection;

    return await this.execute(code, input);
  }
}

/**
 * Capture execution stats from an isolate before it is disposed.
 * Safe to call even if the isolate is already disposed (returns zeroed stats).
 */
function captureStats(isolate: { isDisposed: boolean; cpuTime: bigint; wallTime: bigint; getHeapStatisticsSync(): Record<string, number> }): ExecuteStats {
  if (isolate.isDisposed) {
    return {
      cpuTimeMs: 0,
      wallTimeMs: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      heapSizeLimitBytes: 0,
      totalPhysicalBytes: 0,
      availableBytes: 0,
      executableBytes: 0,
      mallocedBytes: 0,
      peakMallocedBytes: 0,
    };
  }
  const heap = isolate.getHeapStatisticsSync();
  return {
    cpuTimeMs: Number(isolate.cpuTime) / 1e6,
    wallTimeMs: Number(isolate.wallTime) / 1e6,
    heapUsedBytes: heap.used_heap_size ?? 0,
    heapTotalBytes: heap.total_heap_size ?? 0,
    externalBytes: heap.externally_allocated_size ?? 0,
    heapSizeLimitBytes: heap.heap_size_limit ?? 0,
    totalPhysicalBytes: heap.total_physical_size ?? 0,
    availableBytes: heap.total_available_size ?? 0,
    executableBytes: heap.total_heap_size_executable ?? 0,
    mallocedBytes: heap.malloced_memory ?? 0,
    peakMallocedBytes: heap.peak_malloced_memory ?? 0,
  };
}

function hasHostFunctions(globals: Record<string, unknown>): boolean {
  return findFunctionPath(globals) !== null;
}

function validateExecutionResult(result: unknown, maxResultBytes: number): void {
  if (result === "__cmUndef" || result === undefined) return;
  if (typeof result !== "string") {
    throw new Error("Execution result serialization returned a non-string value");
  }
  if (Buffer.byteLength(result, "utf8") > maxResultBytes) {
    throw new Error(`Execution result exceeds limit of ${maxResultBytes} bytes`);
  }
}

function emptyStats(wallTimeMs: number, memoryMB: number): ExecuteStats {
  return {
    cpuTimeMs: wallTimeMs,
    wallTimeMs,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    heapSizeLimitBytes: memoryMB * 1024 * 1024,
    totalPhysicalBytes: 0,
    availableBytes: memoryMB * 1024 * 1024,
    executableBytes: 0,
    mallocedBytes: 0,
    peakMallocedBytes: 0,
  };
}

function parseExecutionResult(result: unknown): unknown {
  if (result === "__cmUndef" || result === undefined) {
    return undefined;
  }
  if (typeof result !== "string") {
    return result;
  }
  return JSON.parse(result);
}
