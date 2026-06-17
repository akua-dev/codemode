import type { Executor, SandboxOptions } from "../types.js";

/**
 * Detect whether we're running under Bun. On Bun, isolated-vm cannot dlopen
 * (it relies on V8 symbols like `v8::ValueSerializer::Delegate::IsHostObject`
 * that Bun's JavaScriptCore engine does not export), so the automatic runtime
 * selector tries LLRT only and fails closed if it is unavailable.
 *
 * Uses Bun's officially documented detection pattern:
 * https://bun.com/docs/guides/util/detect-bun
 *
 * The `typeof process` guard keeps this safe in non-Node-shaped runtimes
 * (Cloudflare Workers, browser) where `process` is undefined.
 */
function isBun(): boolean {
  // Cast through globalThis to avoid requiring @types/node just for `process`.
  const proc = (globalThis as { process?: { versions?: { bun?: string } } }).process;
  return !!proc?.versions?.bun;
}

/**
 * Pick a sandbox runtime automatically.
 *
 * Order of preference:
 *   - **LLRT native** → first when `@robinbraemer/llrt` is installed. This is
 *     the lightweight default candidate and satisfies the shared executor
 *     contract, including host callbacks.
 *   - **Node without LLRT** → isolated-vm for data-only sandbox execution.
 *
 * QuickJS remains available as an explicit advanced executor, but the automatic
 * selector intentionally does not choose it. Its `quickjs-emscripten` host
 * callback bridge cannot enforce byte limits before values cross into host JS
 * without re-triggering upstream asyncify crashes, so auto-selection fails
 * closed instead of silently weakening host-boundary controls.
 *
 * Request-capable execution requires LLRT. The non-LLRT fallback executors
 * reject host function globals rather than exposing weaker host bridges.
 *
 * All sandbox runtimes are optional peer dependencies.
 */
export async function createExecutor(
  options: SandboxOptions = {},
): Promise<Executor> {
  const order = autoExecutorBackendOrder();

  /* oxlint-disable no-await-in-loop */
  for (const backend of order) {
    if (backend === "llrt") {
      try {
        await import("@robinbraemer/llrt");
      } catch (error) {
        if (isMissingOptionalDependency(error, "@robinbraemer/llrt")) {
          continue;
        }
        throw error;
      }

      const { LlrtNativeExecutor } = await import("./llrt-native.js");
      return new LlrtNativeExecutor(options);
    } else {
      try {
        // @ts-ignore — optional peer dependency
        await import("isolated-vm");
        const { IsolatedVMExecutor } = await import("./isolated-vm.js");
        return new IsolatedVMExecutor(options);
      } catch (error) {
        if (isMissingOptionalDependency(error, "isolated-vm")) {
          continue;
        }
        throw error;
      }
    }
  }
  /* oxlint-enable no-await-in-loop */

  throw new Error(
      "No sandbox runtime found. Install one of:\n" +
      "  npm install @robinbraemer/llrt   # Native LLRT (default candidate)\n" +
      "  npm install isolated-vm          # Data-only V8 isolate fallback\n" +
      "QuickJS is available only by passing new QuickJSExecutor(...) explicitly.",
  );
}

export function autoExecutorBackendOrder(): readonly ("llrt" | "isolated-vm")[] {
  return isBun() ? ["llrt"] : ["llrt", "isolated-vm"];
}

export function isMissingOptionalDependency(
  error: unknown,
  dependency: string,
): boolean {
  const escapedDependency = escapeRegExp(dependency);
  const missingDependencyPattern = new RegExp(
    `Cannot find (?:package|module) ['"]${escapedDependency}['"]`,
  );

  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    missingDependencyPattern.test(error.message)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
