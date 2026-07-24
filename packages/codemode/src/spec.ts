import type { OpenAPISpec } from "./types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const DEFAULT_MAX_REF_DEPTH = 50;

/** Keys that must never be traversed or copied during $ref resolution. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface ResolutionResult {
  value: unknown;
  contextDependent: boolean;
}

function resolveRefsWithContext(
  obj: unknown,
  root: Record<string, unknown>,
  seen: Set<string>,
  maxDepth: number,
  cache: Map<string, unknown>,
): ResolutionResult {
  if (obj === null || obj === undefined) {
    return { value: obj, contextDependent: false };
  }
  if (typeof obj !== "object") return { value: obj, contextDependent: false };

  if (Array.isArray(obj)) {
    const items = obj.map((item) =>
      resolveRefsWithContext(item, root, seen, maxDepth, cache),
    );
    return {
      value: items.map(({ value }) => value),
      contextDependent: items.some(({ contextDependent }) => contextDependent),
    };
  }

  const record = obj as Record<string, unknown>;

  if ("$ref" in record && typeof record.$ref === "string") {
    const ref = record.$ref;

    // Circular: this $ref is already in the current ancestor chain
    if (seen.has(ref)) {
      return { value: { $circular: ref }, contextDependent: true };
    }

    // Depth limit
    if (seen.size >= maxDepth) {
      return {
        value: { $circular: ref, $reason: "max depth exceeded" },
        contextDependent: true,
      };
    }

    // A finite expansion is reusable only with the same remaining depth budget.
    const cacheKey = JSON.stringify([maxDepth - seen.size, ref]);
    if (cache.has(cacheKey)) {
      return { value: cache.get(cacheKey), contextDependent: false };
    }

    const parts = ref.replace("#/", "").split("/");
    let resolved: unknown = root;
    for (const part of parts) {
      if (DANGEROUS_KEYS.has(part)) {
        return { value: { $ref: ref, $error: "unsafe ref path" }, contextDependent: false };
      }
      resolved = (resolved as Record<string, unknown>)?.[part];
    }

    // Clone seen for this branch so siblings don't share state
    const branchSeen = new Set(seen);
    branchSeen.add(ref);

    const result = resolveRefsWithContext(resolved, root, branchSeen, maxDepth, cache);
    if (!result.contextDependent) cache.set(cacheKey, result.value);
    return result;
  }

  const result: Record<string, unknown> = {};
  let contextDependent = false;
  for (const [key, value] of Object.entries(record)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const resolved = resolveRefsWithContext(value, root, seen, maxDepth, cache);
    result[key] = resolved.value;
    contextDependent ||= resolved.contextDependent;
  }
  return { value: result, contextDependent };
}

/**
 * Recursively resolve all `$ref` pointers in an OpenAPI spec inline.
 * Circular references are replaced with `{ $circular: ref }`.
 *
 * The `seen` set tracks the current ancestor chain only (not globally),
 * so the same $ref used in sibling positions resolves correctly.
 * A memoization cache avoids re-resolving context-independent $refs.
 *
 * @param maxDepth - Maximum $ref resolution depth (default: 50)
 */
export function resolveRefs(
  obj: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>(),
  maxDepth = DEFAULT_MAX_REF_DEPTH,
  _cache = new Map<string, unknown>(),
): unknown {
  return resolveRefsWithContext(obj, root, seen, maxDepth, _cache).value;
}

interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

/**
 * Extract the base path from the first server URL in the spec.
 * e.g. "https://petstore.io/api/v3" → "/api/v3"
 * e.g. "/api/v3" → "/api/v3"
 * e.g. "https://api.example.com" → ""
 */
export function extractServerBasePath(spec: OpenAPISpec): string {
  const servers = (spec as Record<string, unknown>).servers as
    | Array<{ url: string }>
    | undefined;
  if (!servers?.length) return "";

  const url = servers[0]!.url;
  try {
    // Full URL like "https://petstore.io/api/v3"
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "");
  } catch {
    // Relative path like "/api/v3"
    return url.replace(/\/+$/, "");
  }
}

/**
 * Process an OpenAPI spec into a simplified format for the search tool.
 * Resolves all $refs inline and extracts only the fields needed for search.
 * Prepends the server base path to all path keys so they're directly usable.
 * Only paths are returned — info and components are omitted since refs are resolved inline.
 *
 * @param maxRefDepth - Maximum $ref resolution depth (default: 50)
 */
export function processSpec(
  spec: OpenAPISpec,
  maxRefDepth = DEFAULT_MAX_REF_DEPTH,
): Record<string, unknown> {
  const rawPaths = (spec.paths ?? {}) as Record<
    string,
    Record<string, OperationObject>
  >;
  const basePath = extractServerBasePath(spec);
  const paths: Record<string, Record<string, unknown>> = {};
  const refCache = new Map<string, unknown>();

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue;
    const fullPath = basePath ? basePath + path : path;
    paths[fullPath] = {};

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op) {
        paths[fullPath][method] = {
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters: resolveRefs(
            op.parameters,
            spec as Record<string, unknown>,
            undefined,
            maxRefDepth,
            refCache,
          ),
          requestBody: resolveRefs(
            op.requestBody,
            spec as Record<string, unknown>,
            undefined,
            maxRefDepth,
            refCache,
          ),
          responses: resolveRefs(
            op.responses,
            spec as Record<string, unknown>,
            undefined,
            maxRefDepth,
            refCache,
          ),
        };
      }
    }
  }

  // Only paths — info and components are omitted since all $refs are resolved inline.
  return { paths };
}

/**
 * Extract unique tags from the spec, sorted by frequency (most common first).
 */
export function extractTags(spec: OpenAPISpec): string[] {
  const rawPaths = spec.paths as
    | Record<string, Record<string, OperationObject>>
    | undefined;
  if (!rawPaths) return [];

  const tags = new Map<string, number>();
  for (const pathItem of Object.values(rawPaths)) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op?.tags) {
        for (const tag of op.tags) {
          tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  return [...tags.entries()].toSorted((a, b) => b[1] - a[1]).map(([t]) => t);
}
