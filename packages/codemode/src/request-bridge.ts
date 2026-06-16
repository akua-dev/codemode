import type { RequestHandler } from "./types.js";

/**
 * Options for a sandbox request call.
 * This is what the LLM-generated code passes to `{namespace}.request()`.
 */
export interface SandboxRequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Response returned to the sandbox from a request call.
 */
export interface SandboxResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Options for configuring the request bridge.
 */
export interface RequestBridgeOptions {
  /** Maximum number of requests per bridge instance. Default: 50. */
  maxRequests?: number;
  /** Maximum response body size in bytes. Default: 10MB. */
  maxResponseBytes?: number;
  /** Allowed headers whitelist. When undefined, uses default blocklist. */
  allowedHeaders?: string[];
  /** Response headers exposed to sandbox code. Default: none. */
  exposedResponseHeaders?: string[];
}

const ALLOWED_METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

const BLOCKED_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^host$/i,
  /^origin$/i,
  /^referer$/i,
  /^x-forwarded-/i,
  /^x-real-ip$/i,
  /^x-client-ip$/i,
  /^cf-connecting-ip$/i,
  /^true-client-ip$/i,
  /^proxy-/i,
  /^transfer-encoding$/i,
  /^connection$/i,
  /^upgrade$/i,
  /^te$/i,
  /^forwarded$/i,
  /^content-length$/i,
  /^x-http-method-override$/i,
  /^x-original-url$/i,
  /^x-rewrite-url$/i,
];

const DEFAULT_MAX_REQUESTS = 50;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Read a response body as text, aborting early if it exceeds maxBytes.
 * Streams the body in chunks to avoid buffering the entire response
 * into host memory before checking the size limit.
 */
async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No body stream — fall back to .text() (e.g., empty responses)
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(
        `Response too large: ${text.length} bytes exceeds limit of ${maxBytes} bytes`,
      );
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    // Streaming read — must be sequential
    for (;;) {
      const { done, value } = await reader.read(); // oxlint-disable-line no-await-in-loop
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Response too large: exceeded limit of ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  if (chunks.length === 1) return decoder.decode(chunks[0]);
  // Concatenate chunks
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(combined);
}

/**
 * Validate that a path is safe (no SSRF, no request smuggling).
 */
function validatePath(path: string): void {
  if (path.includes("://")) {
    throw new Error(`Invalid path: must not contain "://" — got "${path}"`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`Invalid path: must start with "/" — got "${path}"`);
  }
  if (path.startsWith("//")) {
    throw new Error(`Invalid path: must not start with "//" — got "${path}"`);
  }
  if (path.includes("\0")) {
    throw new Error("Invalid path: must not contain null bytes");
  }
  if (/[\r\n]/.test(path)) {
    throw new Error("Invalid path: must not contain CR/LF characters");
  }
  if (path.includes("\\")) {
    throw new Error("Invalid path: must not contain backslashes");
  }
}

/**
 * Filter headers based on allowedHeaders whitelist or default blocklist.
 */
function filterHeaders(
  headers: Record<string, string> | undefined,
  allowedHeaders: Set<string> | undefined,
): Record<string, string> {
  if (!headers) return {};

  const isBlocked = (key: string) => BLOCKED_HEADER_PATTERNS.some((p) => p.test(key));

  if (allowedHeaders) {
    // Whitelist mode: only forward explicitly allowed headers after the
    // hard denylist has removed credential, routing, and hop-by-hop headers.
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (allowedHeaders.has(key.toLowerCase()) && !isBlocked(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  // Blocklist mode: strip dangerous headers
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isBlocked(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function filterResponseHeaders(
  headers: Headers,
  exposedResponseHeaders: Set<string> | undefined,
): Record<string, string> {
  if (!exposedResponseHeaders) return {};

  const filtered: Record<string, string> = {};
  for (const key of exposedResponseHeaders) {
    const value = headers.get(key);
    if (value !== null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Creates the `request()` function that gets injected into the execute sandbox.
 * Bridges sandbox API calls to the host request handler (Hono app.request, fetch, etc.).
 */
/** Bridge function with an exposed request count. */
export type RequestBridgeFn = ((options: SandboxRequestOptions) => Promise<SandboxResponse>) & {
  /** Number of requests made through this bridge instance. */
  readonly requestCount: number;
};

export function createRequestBridge(
  handler: RequestHandler,
  baseUrl: string,
  options: RequestBridgeOptions = {},
): RequestBridgeFn {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const allowedHeaders = options.allowedHeaders
    ? new Set(options.allowedHeaders.map((h) => h.toLowerCase()))
    : undefined;
  const exposedResponseHeaders = options.exposedResponseHeaders
    ? new Set(options.exposedResponseHeaders.map((h) => h.toLowerCase()))
    : undefined;

  let requestCount = 0;

  const bridge = async (opts: SandboxRequestOptions): Promise<SandboxResponse> => {
    const { method, path, query, body, headers } = opts;

    // Validate request count
    if (++requestCount > maxRequests) {
      throw new Error(
        `Request limit exceeded: max ${maxRequests} requests per execution`,
      );
    }

    // Validate HTTP method
    const upperMethod = method.toUpperCase();
    if (!ALLOWED_METHODS.has(upperMethod)) {
      throw new Error(
        `Invalid HTTP method: "${method}". Allowed: ${[...ALLOWED_METHODS].join(", ")}`,
      );
    }

    // Validate path (SSRF prevention)
    validatePath(path);

    // Build URL
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }

    // Filter headers
    const filteredHeaders = filterHeaders(headers, allowedHeaders);

    // Build request init
    const init: RequestInit = {
      method: upperMethod,
      headers: { ...filteredHeaders },
    };

    if (body !== undefined && body !== null) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] =
        (init.headers as Record<string, string>)["content-type"] ?? "application/json";
    }

    // Call the host handler
    const response = await handler(url.toString(), init);

    const responseHeaders = filterResponseHeaders(response.headers, exposedResponseHeaders);

    // Read response body with streaming size limit to avoid host OOM.
    // Abort as soon as accumulated bytes exceed the limit.
    const contentType = response.headers.get("content-type") ?? "";
    const text = await readResponseWithLimit(response, maxResponseBytes);

    let responseBody: unknown;
    if (contentType.includes("application/json")) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } else {
      responseBody = text;
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  };

  Object.defineProperty(bridge, 'requestCount', {
    get: () => requestCount,
    enumerable: true,
  });

  return bridge as RequestBridgeFn;
}
