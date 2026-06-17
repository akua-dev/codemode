import {
  DEFAULT_MAX_HOST_CALLS,
  DEFAULT_MAX_HOST_PAYLOAD_BYTES,
  DEFAULT_MAX_HOST_RESULT_BYTES,
  DEFAULT_MAX_RESULT_BYTES,
} from "../limits.js";
import type {
  CapabilityExecutor,
  CapabilityManifest,
  ExecuteResult,
  ExecuteStats,
  SandboxOptions,
} from "../types.js";
import { rejectDataOnlyFunctions } from "./data-only.js";

/**
 * Experimental in-process LLRT executor backed by `@robinbraemer/llrt`.
 *
 * Plain globals cross as JSON. Function globals are retained only for legacy
 * compatibility and are internally bound through an explicit LLRT host manifest.
 */
export class LlrtNativeExecutor implements CapabilityExecutor {
  private readonly memoryMB: number;
  private readonly timeoutMs: number;
  private readonly wallTimeMs: number;
  private readonly maxHostCalls: number;
  private readonly maxHostPayloadBytes: number;
  private readonly maxHostResultBytes: number;
  private readonly maxResultBytes: number;

  constructor(options: SandboxOptions = {}) {
    this.memoryMB = options.memoryMB ?? 64;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.wallTimeMs = options.wallTimeMs ?? 60_000;
    this.maxHostCalls = options.maxHostCalls ?? DEFAULT_MAX_HOST_CALLS;
    this.maxHostPayloadBytes = options.maxHostPayloadBytes ?? DEFAULT_MAX_HOST_PAYLOAD_BYTES;
    this.maxHostResultBytes = options.maxHostResultBytes ?? DEFAULT_MAX_HOST_RESULT_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  }

  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    const start = Date.now();

    try {
      const { LlrtRuntime } = await import("@robinbraemer/llrt");
      const runtime = new LlrtRuntime({
        memoryMB: this.memoryMB,
        wallTimeMs: Math.min(this.timeoutMs, this.wallTimeMs),
      });
      const bindings = buildHostBindings(globals);
      const options = {
        maxHostCalls: this.maxHostCalls,
        maxHostPayloadBytes: this.maxHostPayloadBytes,
        maxHostResultBytes: this.maxHostResultBytes,
        maxResultBytes: this.maxResultBytes,
      };
      const result = bindings.hasHostFunctions
        ? await runtime.callJsonWithHost<ExecutionInput, unknown>(
            wrapCode(code),
            bindings.input,
            {
              namespaces: {
                [LEGACY_HOST_NAMESPACE]: bindings.functions,
              },
            },
            options,
          )
        : await runtime.callJson<ExecutionInput, unknown>(
            wrapCode(code),
            bindings.input,
            options,
          );

      if (!result.ok) {
        return {
          result: undefined,
          error: formatLlrtError(result.error),
          stats: statsFromLlrt(result.stats, start, this.memoryMB),
        };
      }

      return {
        result: result.value,
        stats: statsFromLlrt(result.stats, start, this.memoryMB),
      };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
        stats: emptyStats(Date.now() - start, this.memoryMB),
      };
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

  async executeWithCapabilities(
    code: string,
    input: Record<string, unknown>,
    capabilities: CapabilityManifest,
  ): Promise<ExecuteResult> {
    const rejection = rejectDataOnlyFunctions(input, emptyStats(0, this.memoryMB));
    if (rejection) return rejection;
    const collision = capabilityNamespaceCollision(input, capabilities);
    if (collision) {
      return {
        result: undefined,
        error: `input global "${collision}" collides with capability namespace "${collision}"`,
        stats: emptyStats(0, this.memoryMB),
      };
    }

    const start = Date.now();

    try {
      const { LlrtRuntime } = await import("@robinbraemer/llrt");
      const runtime = new LlrtRuntime({
        memoryMB: this.memoryMB,
        wallTimeMs: Math.min(this.timeoutMs, this.wallTimeMs),
      });
      const result = await runtime.callJsonWithHost<CapabilityExecutionInput, unknown>(
        wrapCapabilityCode(code),
        {
          globals: input,
          namespaces: capabilityNamespaces(capabilities),
        },
        capabilityManifestToLlrt(capabilities),
        {
          maxHostCalls: this.maxHostCalls,
          maxHostPayloadBytes: this.maxHostPayloadBytes,
          maxHostResultBytes: this.maxHostResultBytes,
          maxResultBytes: this.maxResultBytes,
        },
      );

      if (!result.ok) {
        return {
          result: undefined,
          error: formatLlrtError(result.error),
          stats: statsFromLlrt(result.stats, start, this.memoryMB),
        };
      }

      return {
        result: result.value,
        stats: statsFromLlrt(result.stats, start, this.memoryMB),
      };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
        stats: emptyStats(Date.now() - start, this.memoryMB),
      };
    }
  }
}

type HostCallable = (...args: unknown[]) => unknown | Promise<unknown>;
const LEGACY_HOST_NAMESPACE = "__codemodeHost";

interface ExecutionInput {
  globals: Record<string, unknown>;
  globalFunctions: Record<string, string>;
  namespaceFunctions: Record<string, Record<string, string>>;
}

interface CapabilityExecutionInput {
  globals: Record<string, unknown>;
  namespaces: Record<string, string[]>;
}

function buildHostBindings(globals: Record<string, unknown>): {
  input: ExecutionInput;
  functions: Record<string, HostCallable>;
  hasHostFunctions: boolean;
} {
  const input: ExecutionInput = {
    globals: {},
    globalFunctions: {},
    namespaceFunctions: {},
  };
  const functions: Record<string, HostCallable> = {};
  let hasHostFunctions = false;
  let hostIndex = 0;

  function nextHostName(): string {
    const name = `f${hostIndex}`;
    hostIndex += 1;
    return name;
  }

  for (const [name, value] of Object.entries(globals)) {
    if (isHostCallable(value)) {
      const hostName = nextHostName();
      input.globalFunctions[name] = hostName;
      functions[hostName] = value;
      hasHostFunctions = true;
      continue;
    }

    if (isNamespace(value)) {
      const namespaceData: Record<string, unknown> = {};
      const namespaceFunctions: Record<string, string> = {};

      for (const [key, entry] of Object.entries(value)) {
        if (isHostCallable(entry)) {
          const hostName = nextHostName();
          namespaceFunctions[key] = hostName;
          functions[hostName] = entry;
          hasHostFunctions = true;
        } else {
          namespaceData[key] = entry;
        }
      }

      input.globals[name] = namespaceData;
      if (Object.keys(namespaceFunctions).length > 0) {
        input.namespaceFunctions[name] = namespaceFunctions;
      }
      continue;
    }

    input.globals[name] = value;
  }

  return { input, functions, hasHostFunctions };
}

function isHostCallable(value: unknown): value is HostCallable {
  return typeof value === "function";
}

function isNamespace(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capabilityManifestToLlrt(capabilities: CapabilityManifest): {
  namespaces: Record<string, Record<string, HostCallable>>;
} {
  const namespaces: Record<string, Record<string, HostCallable>> = {};
  for (const [namespace, methods] of Object.entries(capabilities.namespaces)) {
    const namespaceFunctions: Record<string, HostCallable> = {};
    for (const [methodName, capability] of Object.entries(methods)) {
      namespaceFunctions[methodName] = function (
        this: { signal?: AbortSignal },
        ...args: unknown[]
      ) {
        return capability.call.call({ signal: this.signal ?? new AbortController().signal }, ...args);
      };
    }
    namespaces[namespace] = namespaceFunctions;
  }
  return { namespaces };
}

function capabilityNamespaces(
  capabilities: CapabilityManifest,
): Record<string, string[]> {
  const namespaces: Record<string, string[]> = {};
  for (const [namespace, methods] of Object.entries(capabilities.namespaces)) {
    namespaces[namespace] = Object.keys(methods);
  }
  return namespaces;
}

function capabilityNamespaceCollision(
  input: Record<string, unknown>,
  capabilities: CapabilityManifest,
): string | null {
  for (const namespace of Object.keys(capabilities.namespaces)) {
    if (Object.prototype.hasOwnProperty.call(input, namespace)) {
      return namespace;
    }
  }
  return null;
}

function wrapCode(code: string): string {
  return `async ({ input, host }) => {
    globalThis.require = undefined;
    globalThis.process = undefined;
    globalThis.fetch = undefined;
    globalThis.console = {
      log: () => {},
      warn: () => {},
      error: () => {},
    };

    for (const [name, value] of Object.entries(input.globals)) {
      globalThis[name] = value;
    }

    const hostFunctions = host?.[${JSON.stringify(LEGACY_HOST_NAMESPACE)}];
    for (const [name, hostName] of Object.entries(input.globalFunctions)) {
      globalThis[name] = (...args) => hostFunctions[hostName](...args);
    }

    for (const [namespace, methods] of Object.entries(input.namespaceFunctions)) {
      const namespaceValue = globalThis[namespace] ?? {};
      for (const [methodName, hostName] of Object.entries(methods)) {
        namespaceValue[methodName] = (...args) => hostFunctions[hostName](...args);
      }
      globalThis[namespace] = namespaceValue;
    }

    return await (${code})();
  }`;
}

function wrapCapabilityCode(code: string): string {
  return `async ({ input, host }) => {
    globalThis.require = undefined;
    globalThis.process = undefined;
    globalThis.fetch = undefined;
    globalThis.console = {
      log: () => {},
      warn: () => {},
      error: () => {},
    };

    for (const [name, value] of Object.entries(input.globals)) {
      globalThis[name] = value;
    }

    for (const [namespace, methods] of Object.entries(input.namespaces)) {
      const namespaceValue = Object.create(null);
      for (const methodName of methods) {
        namespaceValue[methodName] = (...args) => host[namespace][methodName](...args);
      }
      globalThis[namespace] = namespaceValue;
    }

    return await (${code})();
  }`;
}

function formatLlrtError(error: {
  code: string;
  name: string;
  message: string;
}): string {
  if (error.code === "TIMEOUT") {
    return `Wall-clock timeout exceeded: ${error.name}: ${error.message}`;
  }
  return `${error.code}: ${error.name}: ${error.message}`;
}

function statsFromLlrt(
  stats: {
    wallTimeMs: number;
    cpuTimeMs: number | null;
    memoryUsedBytes: number | null;
    memoryLimitBytes: number | null;
  },
  start: number,
  memoryMB: number,
): ExecuteStats {
  const wallTimeMs = stats.wallTimeMs || Date.now() - start;
  const heapUsedBytes = stats.memoryUsedBytes ?? 0;
  const heapSizeLimitBytes = stats.memoryLimitBytes ?? memoryMB * 1024 * 1024;

  return {
    cpuTimeMs: stats.cpuTimeMs ?? wallTimeMs,
    wallTimeMs,
    heapUsedBytes,
    heapTotalBytes: heapUsedBytes,
    externalBytes: 0,
    heapSizeLimitBytes,
    totalPhysicalBytes: heapUsedBytes,
    availableBytes: Math.max(0, heapSizeLimitBytes - heapUsedBytes),
    executableBytes: 0,
    mallocedBytes: 0,
    peakMallocedBytes: 0,
  };
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
