declare module "@robinbraemer/llrt" {
  interface LlrtRuntimeOptions {
    memoryMB?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
    maxStackBytes?: number;
    maxHostCalls?: number;
    maxHostPayloadBytes?: number;
    maxHostResultBytes?: number;
    maxResultBytes?: number;
  }

  interface LlrtCallOptions {
    memoryMB?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
    maxStackBytes?: number;
    maxHostCalls?: number;
    maxHostPayloadBytes?: number;
    maxHostResultBytes?: number;
    maxResultBytes?: number;
    functions?: Record<string, LlrtHostFunction>;
  }

  interface LlrtHostCallContext {
    signal: AbortSignal;
  }

  type LlrtHostFunction = (
    this: LlrtHostCallContext,
    ...args: unknown[]
  ) => unknown | Promise<unknown>;

  interface LlrtHostManifest {
    namespaces: Record<string, Record<string, LlrtHostFunction>>;
  }

  interface LlrtStats {
    wallTimeMs: number;
    cpuTimeMs: number | null;
    memoryUsedBytes: number | null;
    memoryLimitBytes: number | null;
  }

  type LlrtResult<TOutput> =
    | { ok: true; value: TOutput; stats: LlrtStats }
    | {
        ok: false;
        error: { code: string; name: string; message: string };
        stats: LlrtStats;
      };

  export class LlrtRuntime {
    constructor(options?: LlrtRuntimeOptions);

    callJson<TInput = unknown, TOutput = unknown>(
      source: string,
      input: TInput,
      options?: LlrtCallOptions,
    ): Promise<LlrtResult<TOutput>>;

    callJsonWithHost<TInput = unknown, TOutput = unknown>(
      source: string,
      input: TInput,
      manifest: LlrtHostManifest,
      options?: Omit<LlrtCallOptions, "functions">,
    ): Promise<LlrtResult<TOutput>>;

    dispose(): void;
  }

  export function isNativeBindingAvailable(): boolean;

  export type NativeBindingAvailability =
    | { available: true }
    | { available: false; error: unknown };

  export function getNativeBindingAvailability(): NativeBindingAvailability;
}
