/**
 * Execution statistics captured from the V8 isolate.
 */
export interface ExecuteStats {
  /** CPU time consumed by the isolate in milliseconds */
  cpuTimeMs: number;
  /** Wall-clock time of the execution in milliseconds */
  wallTimeMs: number;
  /** V8 heap used by the isolate in bytes (at end of execution) */
  heapUsedBytes: number;
  /** V8 heap total allocated by the isolate in bytes */
  heapTotalBytes: number;
  /** Memory allocated outside V8 heap (ArrayBuffers etc.) that counts against memoryLimit */
  externalBytes: number;
  /** The configured memory limit in bytes — useful for "% of limit used" dashboards */
  heapSizeLimitBytes: number;
  /** OS-level committed memory in bytes */
  totalPhysicalBytes: number;
  /** Remaining bytes before OOM */
  availableBytes: number;
  /** Size of JIT-compiled code in bytes */
  executableBytes: number;
  /** V8 internal malloc'd memory in bytes */
  mallocedBytes: number;
  /** Peak V8 internal malloc'd memory in bytes */
  peakMallocedBytes: number;
}

/**
 * Result from executing sandboxed code.
 */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  /** Execution statistics from the isolate. Always present, even on error. */
  stats: ExecuteStats;
}

export interface HostCallContext {
  signal: AbortSignal;
}

export interface HostCapability {
  call(this: HostCallContext, ...args: unknown[]): unknown | Promise<unknown>;
}

export interface CapabilityManifest {
  namespaces: Record<string, Record<string, HostCapability>>;
}

export interface DataExecutor {
  executeData(
    code: string,
    input: Record<string, unknown>,
  ): Promise<ExecuteResult>;

  /** Clean up resources. */
  dispose?(): void;
}

export interface CapabilityExecutor extends DataExecutor {
  executeWithCapabilities(
    code: string,
    input: Record<string, unknown>,
    capabilities: CapabilityManifest,
  ): Promise<ExecuteResult>;
}

export function isCapabilityExecutor(
  executor: DataExecutor,
): executor is DataExecutor & CapabilityExecutor {
  return (
    "executeWithCapabilities" in executor &&
    typeof executor.executeWithCapabilities === "function"
  );
}

export function emptyExecuteStats(options: {
  memoryMB?: number;
  wallTimeMs?: number;
} = {}): ExecuteStats {
  const wallTimeMs = options.wallTimeMs ?? 0;
  const heapSizeLimitBytes = (options.memoryMB ?? 0) * 1024 * 1024;
  return {
    cpuTimeMs: wallTimeMs,
    wallTimeMs,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    heapSizeLimitBytes,
    totalPhysicalBytes: 0,
    availableBytes: heapSizeLimitBytes,
    executableBytes: 0,
    mallocedBytes: 0,
    peakMallocedBytes: 0,
  };
}

/**
 * Sandbox executor interface. Implement this to use a custom sandbox runtime.
 *
 * Built-in implementations:
 * - `LlrtNativeExecutor` (requires `@robinbraemer/llrt` peer dependency)
 * - `IsolatedVMExecutor` (requires `isolated-vm` peer dependency; data-only,
 *   rejects host function globals)
 * - `QuickJSExecutor` (requires `quickjs-emscripten` peer dependency; data-only,
 *   rejects host function globals)
 */
export interface Executor extends DataExecutor {
  /**
   * Legacy execution entrypoint. Prefer `executeData()` for JSON-only code and
   * `CapabilityExecutor.executeWithCapabilities()` for host-capable code.
   *
   * @param code - An async arrow function as a string, e.g. `async () => { ... }`
   * @param globals - Named JSON-compatible globals to inject into the sandbox.
   *   Only LLRT's legacy path accepts function values; data-only executors reject
   *   them.
   */
  execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult>;

  /** Clean up resources. */
  dispose?(): void;
}

/**
 * Options for configuring the sandbox executor.
 */
export interface SandboxOptions {
  /** Memory limit in MB (default: 64) */
  memoryMB?: number;
  /** CPU timeout in ms — caps pure compute time (default: 30000) */
  timeoutMs?: number;
  /** Wall-clock timeout in ms — caps total elapsed time including async I/O (default: 60000) */
  wallTimeMs?: number;
  /** Maximum number of host calls per execution (default: 100). */
  maxHostCalls?: number;
  /** Maximum JSON-encoded host-call arguments in bytes (default: 1MB). */
  maxHostPayloadBytes?: number;
  /** Maximum JSON-encoded host-call result in bytes (default: 10MB). */
  maxHostResultBytes?: number;
  /** Maximum JSON-encoded final execution result in bytes (default: 10MB). */
  maxResultBytes?: number;
}

/**
 * A fetch-compatible request handler.
 * Works with Hono's `app.request()`, standard `fetch`, or any function
 * that takes a Request and returns a Response.
 */
export type RequestHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * OpenAPI specification object (JSON-parsed OpenAPI 3.x document).
 */
export type OpenAPISpec = {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Spec provider: a static spec, a URL to fetch, or an async getter function.
 */
export type SpecProvider = OpenAPISpec | (() => OpenAPISpec | Promise<OpenAPISpec>);

/**
 * Options for creating a CodeMode instance.
 */
export interface CodeModeOptions {
  /**
   * OpenAPI spec or async getter that returns one.
   * The spec is made available inside the `search()` tool as a `spec` global.
   */
  spec: SpecProvider;

  /**
   * Fetch-compatible request handler for API calls from the `execute()` tool.
   *
   * For Hono: `app.request.bind(app)` (in-process, no network hop)
   * For standard fetch: `fetch` or any `(Request) => Response` function
   */
  request: RequestHandler;

  /**
   * Namespace for the client object inside the execute sandbox.
   * Default: `"api"`
   *
   * Example: with namespace "cnap", sandbox code calls `cnap.request(...)`.
   */
  namespace?: string;

  /**
   * Base URL prepended to relative paths in sandbox requests.
   * Default: `"http://localhost"`
   *
   * Only used when the sandbox code provides a relative path like `/v1/clusters`.
   * For Hono app.request(), any base URL works since it doesn't hit the network.
   */
  baseUrl?: string;

  /**
   * Sandbox configuration.
   */
  sandbox?: SandboxOptions;

  /**
   * Custom executor instance. If not provided, `createExecutor()` chooses
   * the best installed runtime.
   */
  executor?: Executor;

  /**
   * Maximum tokens for response truncation.
   * Default: 25000 (~100KB). Set to 0 to disable truncation.
   */
  maxResponseTokens?: number;

  /**
   * Maximum JavaScript source size in bytes before sandbox compilation.
   * Default: 256KB.
   */
  maxCodeBytes?: number;

  /**
   * Maximum number of requests per execution.
   * Default: 50.
   */
  maxRequests?: number;

  /**
   * Maximum number of in-flight requests per execution.
   * Default: 8.
   */
  maxConcurrentRequests?: number;

  /**
   * Maximum response body size in bytes.
   * Default: 10MB (10_485_760).
   */
  maxResponseBytes?: number;

  /**
   * Maximum request body size in bytes.
   * Default: 1MB (1_048_576).
   */
  maxRequestBytes?: number;

  /**
   * Allowed headers whitelist. When set, only these headers are forwarded.
   * Credential, routing override, forwarding, and hop-by-hop headers are
   * always stripped even when listed here.
   */
  allowedHeaders?: string[];

  /**
   * Response headers exposed to sandbox code.
   * Default: none.
   */
  exposedResponseHeaders?: string[];

  /**
   * Maximum $ref resolution depth.
   * Default: 50.
   */
  maxRefDepth?: number;
}

/**
 * MCP tool definition (compatible with @modelcontextprotocol/sdk).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP tool call result.
 */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
