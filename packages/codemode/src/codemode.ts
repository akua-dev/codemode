import { createExecutor } from "./executor/auto.js";
import {
  createRequestBridge,
  type RequestBridgeContext,
  type RequestBridgeOptions,
  type SandboxRequestOptions,
} from "./request-bridge.js";
import { extractTags, processSpec } from "./spec.js";
import { createExecuteToolDefinition, createSearchToolDefinition } from "./tools.js";
import { truncateResponse } from "./truncate.js";
import type {
  CodeModeOptions,
  Executor,
  OpenAPISpec,
  RequestHandler,
  SpecProvider,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";

const RESERVED_NAMES = new Set([
  "Object", "Array", "Promise", "Function", "String", "Number", "Boolean",
  "Symbol", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Error",
  "JSON", "Math", "Proxy", "Reflect", "globalThis", "undefined", "null",
  "NaN", "Infinity", "console", "spec", "global",
]);

const VALID_JS_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function validateNamespace(namespace: string): void {
  if (!VALID_JS_IDENTIFIER.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}": must be a valid JavaScript identifier`,
    );
  }
  if (RESERVED_NAMES.has(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}": conflicts with reserved name`,
    );
  }
}

/**
 * CodeMode provides `search` and `execute` MCP tools that let an AI agent
 * discover and call your API by writing JavaScript code in a sandboxed runtime.
 *
 * Instead of defining hundreds of individual MCP tools (one per API endpoint),
 * CodeMode exposes just two tools:
 * - `search` — the agent writes JS to filter your OpenAPI spec
 * - `execute` — the agent writes JS to call your API via a typed client
 *
 * @example
 * ```ts
 * import { CodeMode } from 'codemode';
 * import { Hono } from 'hono';
 *
 * const app = new Hono();
 * // ... define routes ...
 *
 * const codemode = new CodeMode({
 *   spec: () => generateOpenAPISpec(app),
 *   request: app.request.bind(app),
 *   namespace: 'cnap',
 * });
 *
 * // Get MCP tool definitions
 * const tools = codemode.tools();
 *
 * // Handle a tool call
 * const result = await codemode.callTool('search', { code: 'async () => ...' });
 * ```
 */
export class CodeMode {
  private specProvider: SpecProvider;
  private namespace: string;
  private executor: Executor | null;
  private executorPromise: Promise<Executor> | null = null;
  private options: CodeModeOptions;
  private searchToolName: string;
  private executeToolName: string;
  private maxResponseTokens: number;

  // Bridge config — a fresh bridge is created per execute() call
  // so the request counter resets each time.
  private bridgeHandler: RequestHandler;
  private bridgeBaseUrl: string;
  private bridgeOptions: RequestBridgeOptions;

  // Cached processed spec & context for tool descriptions
  private processedSpec: Record<string, unknown> | null = null;
  private specContext: { tags: string[]; endpointCount: number } | null = null;

  constructor(options: CodeModeOptions) {
    this.options = options;
    this.specProvider = options.spec;
    this.namespace = options.namespace ?? "api";
    this.executor = options.executor ?? null;
    this.searchToolName = "search";
    this.executeToolName = "execute";
    this.maxResponseTokens = options.maxResponseTokens ?? 6_000;

    validateNamespace(this.namespace);

    this.bridgeHandler = options.request;
    this.bridgeBaseUrl = options.baseUrl ?? "http://localhost";
    this.bridgeOptions = {
      maxRequests: options.maxRequests,
      maxRequestBytes: options.maxRequestBytes,
      maxResponseBytes: options.maxResponseBytes,
      allowedHeaders: options.allowedHeaders,
      exposedResponseHeaders: options.exposedResponseHeaders,
    };
  }

  /**
   * Override the default tool names.
   */
  setToolNames(search: string, execute: string): this {
    this.searchToolName = search;
    this.executeToolName = execute;
    return this;
  }

  /**
   * Returns MCP tool definitions for search and execute.
   */
  tools(): ToolDefinition[] {
    return [
      createSearchToolDefinition(this.searchToolName, this.specContext ?? undefined),
      createExecuteToolDefinition(this.executeToolName, this.namespace),
    ];
  }

  /**
   * Handle an MCP tool call.
   */
  async callTool(
    toolName: string,
    args: { code: string },
  ): Promise<ToolCallResult> {
    if (toolName === this.searchToolName) {
      return this.search(args.code);
    }
    if (toolName === this.executeToolName) {
      return this.execute(args.code);
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  /**
   * Execute a search against the OpenAPI spec.
   * The code runs in a sandbox with `spec` available as a global.
   * All $refs are pre-resolved inline.
   */
  async search(code: string): Promise<ToolCallResult> {
    const executor = await this.getExecutor();
    const spec = await this.getProcessedSpec();

    const result = await executor.execute(code, { spec });

    return this.formatResult(result);
  }

  /**
   * Execute API calls in the sandbox.
   * The code runs with `{namespace}.request()` available as a global.
   */
  async execute(code: string): Promise<ToolCallResult> {
    const executor = await this.getExecutor();

    // Fresh bridge per execution — request counter resets each time
    const bridge = createRequestBridge(
      this.bridgeHandler, this.bridgeBaseUrl, this.bridgeOptions,
    );
    const client = {
      request(this: RequestBridgeContext, options: SandboxRequestOptions) {
        return bridge(options, this);
      },
    };

    const result = await executor.execute(code, {
      [this.namespace]: client,
    });

    return this.formatResult(result);
  }

  /**
   * Clean up sandbox resources.
   */
  dispose(): void {
    this.executor?.dispose?.();
  }

  private async resolveSpec(): Promise<OpenAPISpec> {
    if (typeof this.specProvider === "function") {
      return await this.specProvider();
    }
    return this.specProvider;
  }

  /**
   * Get the processed spec (refs resolved, fields extracted).
   * Caches the result after first call.
   */
  private async getProcessedSpec(): Promise<Record<string, unknown>> {
    if (this.processedSpec) return this.processedSpec;

    const raw = await this.resolveSpec();
    this.processedSpec = processSpec(raw, this.options.maxRefDepth);

    // Extract context for tool descriptions
    const tags = extractTags(raw);
    const endpointCount = Object.keys(raw.paths ?? {}).length;
    this.specContext = { tags, endpointCount };

    return this.processedSpec;
  }

  private async getExecutor(): Promise<Executor> {
    if (this.executor) return this.executor;

    // Lazy-init with deduplication
    if (!this.executorPromise) {
      this.executorPromise = createExecutor(this.options.sandbox).then(
        (executor) => {
          this.executor = executor;
          return executor;
        },
      );
    }
    return this.executorPromise;
  }

  private formatResult(result: {
    result: unknown;
    error?: string;
  }): ToolCallResult {
    if (result.error) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    const resultText =
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2);

    return {
      content: [{ type: "text", text: truncateResponse(resultText, this.maxResponseTokens) }],
    };
  }
}
