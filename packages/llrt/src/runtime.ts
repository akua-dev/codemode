import { emptyStats, errorInfo } from "./errors.js";
import { loadNativeBinding } from "./native.js";
import type {
  LlrtCallOptions,
  LlrtExecutionErrorInfo,
  LlrtHostCallContext,
  LlrtHostFunction,
  LlrtResult,
  LlrtRuntimeOptions,
  LlrtStats,
} from "./types.js";

function hasNativeLoadError(error: unknown): error is { llrtError: LlrtExecutionErrorInfo } {
  if (!(error instanceof Error) || !("llrtError" in error)) {
    return false;
  }

  const maybeInfo = error.llrtError;
  return (
    typeof maybeInfo === "object" &&
    maybeInfo !== null &&
    "code" in maybeInfo &&
    "name" in maybeInfo &&
    "message" in maybeInfo
  );
}

function normalizeStats(stats: LlrtStats): LlrtStats {
  return {
    wallTimeMs: stats.wallTimeMs ?? 0,
    cpuTimeMs: stats.cpuTimeMs ?? null,
    memoryUsedBytes: stats.memoryUsedBytes ?? null,
    memoryLimitBytes: stats.memoryLimitBytes ?? null,
    maxStackBytes: stats.maxStackBytes ?? null,
  };
}

export class LlrtRuntime {
  private disposed = false;

  constructor(private readonly options: LlrtRuntimeOptions = {}) {}

  async callJson<TInput = unknown, TOutput = unknown>(
    source: string,
    input: TInput,
    options: LlrtCallOptions = {},
  ): Promise<LlrtResult<TOutput>> {
    if (this.disposed) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_DISPOSED",
          name: "LlrtRuntimeDisposedError",
          message: "LlrtRuntime has been disposed",
        },
        stats: emptyStats,
      };
    }

    const inputJson = this.stringifyInput(input);
    if (!inputJson.ok) {
      return inputJson;
    }

    try {
      const binding = loadNativeBinding();
      const abortController = new AbortController();
      const hostDispatcher = options.functions
        ? createHostDispatcher(options.functions, abortController.signal)
        : undefined;
      const result = await (async () => {
        try {
          return await binding.callJson(
            hostDispatcher ? wrapSourceForHostFunctions(source) : source,
            inputJson.value,
            {
              memoryMb: options.memoryMB ?? this.options.memoryMB,
              wallTimeMs: options.wallTimeMs ?? this.options.wallTimeMs,
              cpuTimeMs: options.cpuTimeMs ?? this.options.cpuTimeMs,
              maxStackBytes: options.maxStackBytes ?? this.options.maxStackBytes,
            },
            hostDispatcher,
          );
        } finally {
          abortController.abort();
        }
      })();

      if (!result.ok) {
        return {
          ...result,
          stats: normalizeStats(result.stats),
        };
      }

      return {
        ok: true,
        value: JSON.parse(result.valueJson) as TOutput,
        stats: normalizeStats(result.stats),
      };
    } catch (error) {
      return {
        ok: false,
        error: hasNativeLoadError(error)
          ? error.llrtError
          : errorInfo("NATIVE_LOAD_ERROR", error),
        stats: emptyStats,
      };
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private stringifyInput(input: unknown):
    | { ok: true; value: string }
    | { ok: false; error: LlrtExecutionErrorInfo; stats: typeof emptyStats } {
    try {
      const inputJson = JSON.stringify(input);
      if (inputJson !== undefined) {
        return { ok: true, value: inputJson };
      }

      return {
        ok: false,
        error: {
          code: "SERIALIZATION_ERROR",
          name: "LlrtSerializationError",
          message: "Input must serialize to a JSON value",
        },
        stats: emptyStats,
      };
    } catch (error) {
      return {
        ok: false,
        error: errorInfo("SERIALIZATION_ERROR", error),
        stats: emptyStats,
      };
    }
  }
}

function createHostDispatcher(
  functions: Record<string, LlrtHostFunction>,
  signal: AbortSignal,
): (payloadJson: string) => Promise<string> {
  return async (payloadJson) => {
    const { name, argsJson } = JSON.parse(payloadJson) as {
      name: string;
      argsJson: string;
    };
    const hostFunction = functions[name];
    if (!hostFunction) {
      throw new Error(`Unknown LLRT host function: ${name}`);
    }

    const args = JSON.parse(argsJson) as unknown[];
    const context: LlrtHostCallContext = { signal };
    const result = await hostFunction.apply(context, args);
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) {
      return "null";
    }
    return resultJson;
  };
}

function wrapSourceForHostFunctions(source: string): string {
  return `async ({ input }) => {
    const host = new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return async (...args) => JSON.parse(await globalThis.__llrtHostCall(property, JSON.stringify(args)));
      },
    });

    return await (${source})({ input, host });
  }`;
}
