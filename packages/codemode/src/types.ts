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

/**
 * Sandbox executor interface. Implement this to use a custom sandbox runtime.
 *
 * Built-in implementations:
 * - `LlrtNativeExecutor` (requires `@robinbraemer/llrt` peer dependency)
 * - `IsolatedVMExecutor` (requires `isolated-vm` peer dependency)
 * - `QuickJSExecutor` (requires `quickjs-emscripten` peer dependency)
 */
export interface Executor {
  /**
   * Execute JavaScript code in a sandboxed environment.
   *
   * @param code - An async arrow function as a string, e.g. `async () => { ... }`
   * @param globals - Named globals to inject into the sandbox. Each value is either:
   *   - A plain object/array/primitive (injected as a frozen read-only value)
   *   - A function (injected as a callable host function)
   *   - An object with function values (injected as a namespace with callable methods)
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
   * Maximum number of requests per execution.
   * Default: 50.
   */
  maxRequests?: number;

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
