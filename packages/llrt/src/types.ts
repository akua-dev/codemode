export interface LlrtRuntimeOptions {
  memoryMB?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  maxStackBytes?: number;
}

export interface LlrtCallOptions {
  memoryMB?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  maxStackBytes?: number;
  functions?: Record<string, LlrtHostFunction>;
}

export interface LlrtHostCallContext {
  signal: AbortSignal;
}

export type LlrtHostFunction = (
  this: LlrtHostCallContext,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface LlrtStats {
  wallTimeMs: number;
  cpuTimeMs: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  maxStackBytes: number | null;
}

export type LlrtExecutionErrorCode =
  | "EVALUATION_ERROR"
  | "SERIALIZATION_ERROR"
  | "TIMEOUT"
  | "MEMORY_LIMIT"
  | "RUNTIME_DISPOSED"
  | "NATIVE_LOAD_ERROR"
  | "UNSUPPORTED";

export interface LlrtExecutionErrorInfo {
  name: string;
  message: string;
  stack?: string;
  code: LlrtExecutionErrorCode;
}

export interface LlrtCallResult<TOutput> {
  ok: true;
  value: TOutput;
  stats: LlrtStats;
}

export interface LlrtCallFailure {
  ok: false;
  error: LlrtExecutionErrorInfo;
  stats: LlrtStats;
}

export type LlrtResult<TOutput> = LlrtCallResult<TOutput> | LlrtCallFailure;
