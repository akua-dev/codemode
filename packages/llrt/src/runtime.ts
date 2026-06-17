import { randomUUID } from "node:crypto";
import { emptyStats, errorInfo } from "./errors.js";
import { loadNativeBinding } from "./native.js";
import type {
  LlrtCallOptions,
  LlrtCallFailure,
  LlrtExecutionErrorInfo,
  LlrtHostCallContext,
  LlrtHostFunction,
  LlrtHostManifest,
  LlrtResult,
  LlrtRuntimeOptions,
  LlrtStats,
} from "./types.js";

const DEFAULT_WALL_TIME_MS = 30_000;
const DEFAULT_MAX_HOST_CALLS = 100;
const DEFAULT_MAX_HOST_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_HOST_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const HOST_ERROR_PREFIX = "__LLRT_HOST_ERROR__";
const SAFE_HOST_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UNSAFE_HOST_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

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
    return await this.callJsonInternal(source, input, {
      ...options,
      hostFunctions: options.functions,
      hostMode: options.functions ? "legacyGlobal" : "none",
    });
  }

  async callJsonWithHost<TInput = unknown, TOutput = unknown>(
    source: string,
    input: TInput,
    manifest: LlrtHostManifest,
    options: Omit<LlrtCallOptions, "functions"> = {},
  ): Promise<LlrtResult<TOutput>> {
    const validation = validateHostManifest(manifest);
    if (!validation.ok) return validation;
    const flattened = flattenHostManifest(manifest);
    return await this.callJsonInternal(source, input, {
      ...options,
      hostFunctions: flattened.functions,
      hostPaths: flattened.paths,
      hostMode: "nativeArgument",
    });
  }

  private async callJsonInternal<TInput = unknown, TOutput = unknown>(
    source: string,
    input: TInput,
    options: LlrtCallOptions & {
      hostFunctions?: Record<string, LlrtHostFunction>;
      hostPaths?: string[];
      hostMode: HostMode;
    },
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

    const mergedOptions = this.mergeOptions(options);
    const optionsValidation = validateOptions(mergedOptions);
    if (!optionsValidation.ok) {
      return optionsValidation;
    }

    const inputJson = this.stringifyInput(input);
    if (!inputJson.ok) {
      return inputJson;
    }

    try {
      const binding = loadNativeBinding();
      const abortController = new AbortController();
      const errorMarker = `${HOST_ERROR_PREFIX}${randomUUID()}:`;
      const hostDispatcher = options.hostFunctions
        ? createHostDispatcher(
            options.hostFunctions,
            abortController.signal,
            mergedOptions,
            errorMarker,
          )
        : undefined;
      const result = await (async () => {
        try {
          return await binding.callJson(
            wrapSource(source, {
              maxHostPayloadBytes: mergedOptions.maxHostPayloadBytes,
              maxResultBytes: mergedOptions.maxResultBytes,
              errorMarker,
              hostMode: options.hostMode,
            }),
            inputJson.value,
            {
              memoryMb: mergedOptions.memoryMB,
              wallTimeMs: mergedOptions.wallTimeMs,
              cpuTimeMs: undefined,
              maxStackBytes: mergedOptions.maxStackBytes,
              maxHostPayloadBytes: mergedOptions.maxHostPayloadBytes,
              maxResultBytes: mergedOptions.maxResultBytes,
              errorMarker,
              hostPaths: options.hostPaths,
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

  private mergeOptions(options: LlrtCallOptions): RequiredHostLimits & {
    memoryMB?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
    maxStackBytes?: number;
    maxResultBytes: number;
  } {
    return {
      memoryMB: options.memoryMB ?? this.options.memoryMB,
      wallTimeMs: options.wallTimeMs ?? this.options.wallTimeMs ?? DEFAULT_WALL_TIME_MS,
      cpuTimeMs: options.cpuTimeMs ?? this.options.cpuTimeMs,
      maxStackBytes: options.maxStackBytes ?? this.options.maxStackBytes,
      maxHostCalls: options.maxHostCalls ?? this.options.maxHostCalls ?? DEFAULT_MAX_HOST_CALLS,
      maxHostPayloadBytes:
        options.maxHostPayloadBytes ??
        this.options.maxHostPayloadBytes ??
        DEFAULT_MAX_HOST_PAYLOAD_BYTES,
      maxHostResultBytes:
        options.maxHostResultBytes ??
        this.options.maxHostResultBytes ??
        DEFAULT_MAX_HOST_RESULT_BYTES,
      maxResultBytes: options.maxResultBytes ?? this.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    };
  }
}

type HostMode = "none" | "legacyGlobal" | "nativeArgument";

interface RequiredHostLimits {
  maxHostCalls: number;
  maxHostPayloadBytes: number;
  maxHostResultBytes: number;
}

function flattenHostManifest(manifest: LlrtHostManifest): {
  functions: Record<string, LlrtHostFunction>;
  paths: string[];
} {
  const functions: Record<string, LlrtHostFunction> = {};
  const paths: string[] = [];

  for (const [namespace, namespaceFunctions] of Object.entries(manifest.namespaces)) {
    for (const [name, hostFunction] of Object.entries(namespaceFunctions)) {
      const path = `${namespace}.${name}`;
      functions[path] = hostFunction;
      paths.push(path);
    }
  }

  return { functions, paths };
}

function validateHostManifest(manifest: LlrtHostManifest): { ok: true } | LlrtCallFailure {
  for (const [namespace, namespaceFunctions] of Object.entries(manifest.namespaces)) {
    const namespaceValidation = validateHostSegment(namespace);
    if (!namespaceValidation.ok) return namespaceValidation;
    for (const methodName of Object.keys(namespaceFunctions)) {
      const methodValidation = validateHostSegment(methodName);
      if (!methodValidation.ok) return methodValidation;
    }
  }

  return { ok: true };
}

function validateHostSegment(segment: string): { ok: true } | LlrtCallFailure {
  if (!SAFE_HOST_SEGMENT.test(segment) || UNSAFE_HOST_SEGMENTS.has(segment)) {
    return unsupported(`Invalid LLRT host capability name: ${segment}`);
  }
  return { ok: true };
}

function unsupported(message: string): LlrtCallFailure {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED",
      name: "LlrtUnsupportedOptionError",
      message,
    },
    stats: emptyStats,
  };
}

function validateOptions(options: {
  memoryMB?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  maxStackBytes?: number;
  maxHostCalls: number;
  maxHostPayloadBytes: number;
  maxHostResultBytes: number;
  maxResultBytes: number;
}): { ok: true } | LlrtCallFailure {
  if (options.cpuTimeMs !== undefined) {
    return unsupported("cpuTimeMs is not enforced by LLRT native bindings; use wallTimeMs");
  }

  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      return unsupported(`${name} must be a finite positive number`);
    }
  }

  return { ok: true };
}

function createHostDispatcher(
  functions: Record<string, LlrtHostFunction>,
  signal: AbortSignal,
  limits: RequiredHostLimits,
  errorMarker: string,
): (payloadJson: string) => Promise<string> {
  let hostCalls = 0;
  return async (payloadJson) => {
    try {
      hostCalls += 1;
      if (hostCalls > limits.maxHostCalls) {
        throw hostLimitError(
          "HOST_CALL_LIMIT",
          `LLRT host call limit exceeded: max ${limits.maxHostCalls} calls`,
          errorMarker,
        );
      }
      if (Buffer.byteLength(payloadJson, "utf8") > limits.maxHostPayloadBytes) {
        throw hostLimitError(
          "HOST_PAYLOAD_LIMIT",
          `LLRT host call payload exceeds limit of ${limits.maxHostPayloadBytes} bytes`,
          errorMarker,
        );
      }
      const { name, argsJson } = JSON.parse(payloadJson) as {
        name: string;
        argsJson: string;
      };
      if (Buffer.byteLength(argsJson, "utf8") > limits.maxHostPayloadBytes) {
        throw hostLimitError(
          "HOST_PAYLOAD_LIMIT",
          `LLRT host call arguments exceed limit of ${limits.maxHostPayloadBytes} bytes`,
          errorMarker,
        );
      }
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
      if (Buffer.byteLength(resultJson, "utf8") > limits.maxHostResultBytes) {
        throw hostLimitError(
          "HOST_RESULT_LIMIT",
          `LLRT host call result exceeds limit of ${limits.maxHostResultBytes} bytes`,
          errorMarker,
        );
      }
      return resultJson;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(errorMarker)) {
        return error.message;
      }
      throw error;
    }
  };
}

function hostLimitError(
  code: "HOST_CALL_LIMIT" | "HOST_PAYLOAD_LIMIT" | "HOST_RESULT_LIMIT",
  message: string,
  errorMarker: string,
): Error {
  return llrtLimitError(code, "LlrtHostLimitError", message, errorMarker);
}

function llrtLimitError(
  code: "HOST_CALL_LIMIT" | "HOST_PAYLOAD_LIMIT" | "HOST_RESULT_LIMIT" | "RESULT_LIMIT",
  name: "LlrtHostLimitError" | "LlrtResultLimitError",
  message: string,
  errorMarker: string,
): Error {
  const info = {
    code,
    name,
    message,
  } satisfies LlrtExecutionErrorInfo;
  return Object.assign(new Error(message), {
    message: `${errorMarker}${JSON.stringify(info)}`,
    llrtError: info,
  });
}

function wrapSource(
  source: string,
  options: {
    maxHostPayloadBytes: number;
    maxResultBytes: number;
    errorMarker: string;
    hostMode: HostMode;
  },
): string {
  return `async ({ input, host: nativeHost }) => {
    function utf8ByteLength(value) {
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
    }

    ${
      options.hostMode === "legacyGlobal"
        ? `
    const host = new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return async (...args) => {
          const argsJson = JSON.stringify(args);
          if (utf8ByteLength(argsJson) > ${options.maxHostPayloadBytes}) {
            throw new Error("LLRT host call arguments exceed limit of ${options.maxHostPayloadBytes} bytes");
          }
          return JSON.parse(await globalThis.__llrtHostCall(property, argsJson));
        };
      },
    });`
        : ""
    }
    ${
      options.hostMode === "nativeArgument"
        ? `
    function wrapNativeHost(value) {
      const wrapped = {};
      for (const [namespace, methods] of Object.entries(value ?? {})) {
        const wrappedMethods = {};
        for (const [methodName, raw] of Object.entries(methods ?? {})) {
          wrappedMethods[methodName] = async (...args) => {
            const argsJson = JSON.stringify(args);
            if (utf8ByteLength(argsJson) > ${options.maxHostPayloadBytes}) {
              throw new Error("LLRT host call arguments exceed limit of ${options.maxHostPayloadBytes} bytes");
            }
            return JSON.parse(await raw(argsJson));
          };
        }
        wrapped[namespace] = wrappedMethods;
      }
      return wrapped;
    }
    const host = wrapNativeHost(nativeHost);`
        : ""
    }
    ${options.hostMode === "none" ? "const host = undefined;" : ""}

    return await (${source})({ input, host });
  }`;
}
