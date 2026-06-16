declare module "@robinbraemer/llrt" {
  interface LlrtRuntimeOptions {
    memoryMB?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
    maxStackBytes?: number;
  }

  interface LlrtCallOptions {
    memoryMB?: number;
    wallTimeMs?: number;
    cpuTimeMs?: number;
    maxStackBytes?: number;
    functions?: Record<string, LlrtHostFunction>;
  }

  type LlrtHostFunction = (...args: unknown[]) => unknown | Promise<unknown>;

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

    dispose(): void;
  }

  export function isNativeBindingAvailable(): boolean;

  export type NativeBindingAvailability =
    | { available: true }
    | { available: false; error: unknown };

  export function getNativeBindingAvailability(): NativeBindingAvailability;
}
