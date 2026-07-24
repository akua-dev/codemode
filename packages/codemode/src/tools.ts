import type { ToolDefinition } from "./types.js";

const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};
`;

export function createSearchToolDefinition(
  toolName: string,
  context?: { tags?: string[]; endpointCount?: number },
): ToolDefinition {
  const parts: string[] = [];

  parts.push(
    `Search the API specification to discover available endpoints. Resolvable $refs are expanded inline; circular and max-depth refs remain marked.`,
  );

  if (context?.tags && context.tags.length > 0) {
    const shown = context.tags.slice(0, 30).join(", ");
    const suffix =
      context.tags.length > 30 ? `... (${context.tags.length} total)` : "";
    parts.push(`Tags: ${shown}${suffix}`);
  }

  if (context?.endpointCount) {
    parts.push(`Endpoints: ${context.endpointCount}`);
  }

  parts.push(`Types:
${SPEC_TYPES}`);

  const hasTags = context?.tags && context.tags.length > 0;
  const exampleTag = context?.tags?.[0]?.toLowerCase() ?? "items";

  const discoverExample = hasTags
    ? `// Find endpoints by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === '${exampleTag}')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}`
    : `// List all endpoints
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      results.push({ method: method.toUpperCase(), path, summary: op.summary });
    }
  }
  return results;
}`;

  parts.push(`Your code must be an async arrow function that returns the result.

Examples:

${discoverExample}

// Get endpoint with requestBody schema (resolvable refs are expanded)
async () => {
  const op = spec.paths['/example']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/example']?.get;
  return op?.parameters;
}`);

  return {
    name: toolName,
    description: parts.join("\n\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript async arrow function to search the `spec` object",
        },
      },
      required: ["code"],
    },
  };
}

export function createExecuteToolDefinition(
  toolName: string,
  namespace: string,
): ToolDefinition {
  const types = `
interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Response<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

declare const ${namespace}: {
  request<T = unknown>(options: RequestOptions): Promise<Response<T>>;
};
`;

  return {
    name: toolName,
    description: `Execute API calls by writing JavaScript code. First use the 'search' tool to find the right endpoints.

Available in your code:
${types}
Your code must be an async arrow function that returns the result.

Examples:

// List resources
async () => {
  const res = await ${namespace}.request({ method: "GET", path: "/v1/items" });
  return res.body;
}

// Create a resource
async () => {
  const res = await ${namespace}.request({
    method: "POST",
    path: "/v1/items",
    body: { name: "Widget" }
  });
  return { status: res.status, body: res.body };
}

// Chain multiple calls
async () => {
  const list = await ${namespace}.request({ method: "GET", path: "/v1/items" });
  const details = await Promise.all(
    list.body.map(item =>
      ${namespace}.request({ method: "GET", path: \`/v1/items/\${item.id}\` })
    )
  );
  return details.map(d => d.body);
}`,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: `JavaScript async arrow function that uses \`${namespace}.request()\` to make API calls`,
        },
      },
      required: ["code"],
    },
  };
}
