# codemode

Two MCP tools that replace hundreds. Give an AI agent your OpenAPI spec and a request handler — it discovers and calls your entire API by writing JavaScript in a sandboxed runtime.

Instead of defining individual MCP tools for every API endpoint (`list-pods`, `create-product`, `get-logs`, ...), CodeMode exposes just **two tools**:

- **`search`** — the agent writes JS to filter your OpenAPI spec and discover endpoints
- **`execute`** — the agent writes JS to call your API via an injected client

This is the same pattern [Cloudflare uses](https://blog.cloudflare.com/code-mode-mcp/) to expose 2,500+ API endpoints through just two MCP tools, reducing context window usage by 99.9%.

## Try It

Requires [mise](https://mise.jdx.dev/) for tooling (Node.js, pnpm, Task):

```bash
git clone https://github.com/cnap-tech/codemode.git
cd codemode
mise install   # installs Node 24, pnpm 10, Task
task install   # installs dependencies
task example   # runs the Petstore demo
```

Fetches the real Petstore OpenAPI spec from the web, then runs search + execute against a local Hono mock — no API keys needed.

## Install

```bash
pnpm add @robinbraemer/codemode

# Install a sandbox runtime (at least one):
pnpm add isolated-vm           # V8 isolates — recommended for production on Node
pnpm add quickjs-emscripten    # WASM QuickJS — fallback for Bun / CF Workers / browser
```

If both are installed, the auto-selector (`createExecutor`) picks `isolated-vm` on Node and `quickjs-emscripten` on Bun (where `isolated-vm` cannot dlopen because Bun's JavaScriptCore engine does not export the V8 symbols `isolated-vm` requires).

## Quick Start

```typescript
import { CodeMode } from '@robinbraemer/codemode';
import { Hono } from 'hono';

const app = new Hono();
app.get('/v1/clusters', (c) => c.json([{ id: '1', name: 'prod' }]));
app.post('/v1/clusters', async (c) => {
  const body = await c.req.json();
  return c.json({ id: '2', ...body }, 201);
});

const codemode = new CodeMode({
  spec: myOpenAPISpec,              // OpenAPI 3.x spec, or async getter
  request: app.request.bind(app),   // in-process, no network hop
});

// The agent searches the spec to discover endpoints...
const search = await codemode.callTool('search', {
  code: `async () => {
    const results = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (op.tags?.some(t => t.toLowerCase() === 'clusters')) {
          results.push({ method: method.toUpperCase(), path, summary: op.summary });
        }
      }
    }
    return results;
  }`
});

// ...then executes API calls
const result = await codemode.callTool('execute', {
  code: `async () => {
    const res = await api.request({ method: "GET", path: "/v1/clusters" });
    return res.body;
  }`
});
```

## MCP Server Integration

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CodeMode } from '@robinbraemer/codemode';
import { registerTools } from '@robinbraemer/codemode/mcp';

const codemode = new CodeMode({
  spec: () => fetchOpenAPISpec(),
  request: app.request.bind(app),
});

const server = new McpServer({ name: 'my-api', version: '1.0.0' });
registerTools(codemode, server);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## How It Works

```
AI Agent
  │ writes JavaScript code
  ▼
CodeMode MCP Server
  │
  ├─ search(code) → runs JS with preprocessed OpenAPI spec
  │   → all $refs resolved inline, only essential fields kept
  │   → agent discovers endpoints, schemas, parameters
  │
  └─ execute(code) → runs JS with injected request client
      → api.request() calls your handler in-process
      → no network hop, auth handled automatically
```

All code runs in an isolated V8 sandbox. The sandbox has zero I/O by default — no `require`, no `process`, no `fetch`, no filesystem. The only way to interact with the outside world is through the injected globals (`spec` for search, `{namespace}.request()` for execute).

Each tool call gets a fresh sandbox with no state carried over between calls.

## API

### `new CodeMode(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `spec` | `OpenAPISpec \| () => OpenAPISpec \| Promise<OpenAPISpec>` | required | OpenAPI 3.x spec or async getter |
| `request` | `(input, init?) => Response` | required | Fetch-compatible handler (`app.request.bind(app)` for Hono) |
| `namespace` | `string` | `"api"` | Client name in sandbox (`api.request(...)`). Must be a valid JS identifier, not a reserved name. |
| `baseUrl` | `string` | `"http://localhost"` | Base URL for relative paths |
| `sandbox` | `SandboxOptions` | see below | Sandbox resource limits |
| `executor` | `Executor` | `IsolatedVMExecutor` | Custom sandbox executor |
| `maxResponseTokens` | `number` | `25000` | Token limit for response truncation (0 to disable) |
| `maxRequests` | `number` | `50` | Max requests per `execute()` call |
| `maxResponseBytes` | `number` | `10485760` | Max response body size in bytes (10MB) |
| `allowedHeaders` | `string[]` | `undefined` | Header whitelist. When unset, a blocklist strips `Authorization`, `Cookie`, `Host`, `X-Forwarded-*`, `Proxy-*`. |
| `maxRefDepth` | `number` | `50` | Max `$ref` resolution depth |

#### `SandboxOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `memoryMB` | `number` | `64` | V8 isolate memory limit |
| `timeoutMs` | `number` | `30000` | CPU timeout in ms (caps pure compute) |
| `wallTimeMs` | `number` | `60000` | Wall-clock timeout in ms (caps total elapsed time including async I/O) |

### Methods

#### `codemode.tools(): ToolDefinition[]`

Returns MCP-compatible tool definitions for `search` and `execute`.

#### `codemode.callTool(name, { code }): Promise<ToolCallResult>`

Route a tool call. Returns `{ content: [{ type: "text", text }], isError? }`.

#### `codemode.search(code): Promise<ToolCallResult>`

Run search code directly (shorthand for `callTool('search', { code })`).

#### `codemode.execute(code): Promise<ToolCallResult>`

Run execute code directly (shorthand for `callTool('execute', { code })`).

#### `codemode.setToolNames(search, execute): this`

Override default tool names. Useful when running multiple CodeMode instances.

#### `codemode.dispose(): void`

Clean up sandbox resources.

## Sandbox API

### Inside `search`

The `spec` global is the preprocessed OpenAPI spec with all `$ref` pointers resolved inline:

```javascript
// Find endpoints by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'clusters')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with requestBody schema (refs are already resolved)
async () => {
  const op = spec.paths['/v1/products']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Spec metadata
async () => ({
  title: spec.info.title,
  version: spec.info.version,
  endpoints: Object.keys(spec.paths).length,
})
```

### Inside `execute`

The `{namespace}.request()` function makes API calls through the host handler:

```javascript
// GET with query params
async () => {
  const res = await api.request({
    method: "GET",
    path: "/v1/clusters",
    query: { limit: 10 },
  });
  return res.body;
}

// POST with body
async () => {
  const res = await api.request({
    method: "POST",
    path: "/v1/products",
    body: { name: "Redis", chart: "bitnami/redis" },
  });
  return { status: res.status, body: res.body };
}

// Chain calls
async () => {
  const list = await api.request({ method: "GET", path: "/v1/clusters" });
  const details = await Promise.all(
    list.body.map(c =>
      api.request({ method: "GET", path: `/v1/clusters/${c.id}` })
    )
  );
  return details.map(d => d.body);
}
```

**Request options:**

| Field | Type | Description |
|-------|------|-------------|
| `method` | `string` | HTTP method (`"GET"`, `"POST"`, etc.) |
| `path` | `string` | API path (`"/v1/clusters"`) |
| `query` | `Record<string, string \| number \| boolean>` | Query parameters (optional) |
| `body` | `unknown` | Request body, auto-serialized as JSON (optional) |
| `headers` | `Record<string, string>` | Additional headers (optional) |

**Response:** `{ status: number, headers: Record<string, string>, body: unknown }`

## Spec Preprocessing

CodeMode automatically preprocesses your OpenAPI spec before passing it to the search sandbox:

- **`$ref` resolution** — all `$ref` pointers are resolved inline (circular refs become `{ $circular: ref }`)
- **Field extraction** — only essential fields kept per operation: `summary`, `description`, `tags`, `operationId`, `parameters`, `requestBody`, `responses`
- **Metadata preserved** — `info`, `servers`, and `components.schemas` are kept alongside processed paths

You can also use the preprocessing utilities directly:

```typescript
import { resolveRefs, processSpec, extractTags } from '@robinbraemer/codemode';

const processed = processSpec(rawSpec);
const tags = extractTags(rawSpec);
```

## Executors

CodeMode ships two executor backends. `IsolatedVMExecutor` is the recommended production backend on Node. `QuickJSExecutor` is a compatibility fallback for environments where `isolated-vm` cannot load (Bun, Cloudflare Workers, browser).

Use `createExecutor()` for automatic selection, or pass an executor instance explicitly:

```typescript
import { CodeMode, createExecutor, IsolatedVMExecutor, QuickJSExecutor } from '@robinbraemer/codemode';

// Automatic — picks isolated-vm on Node, quickjs-emscripten on Bun
const codemode = new CodeMode({
  spec,
  request: handler,
  executor: await createExecutor({ memoryMB: 128, timeoutMs: 60_000 }),
});

// Or explicit
const codemode = new CodeMode({
  spec,
  request: handler,
  executor: new IsolatedVMExecutor({
    memoryMB: 128,
    timeoutMs: 60_000,   // CPU time limit
    wallTimeMs: 120_000, // total elapsed time limit
  }),
});
```

| Executor | Package | Performance | Portability | Production-ready |
|----------|---------|-------------|-------------|------------------|
| `IsolatedVMExecutor` | `isolated-vm` | Native V8 speed | Node.js | ✅ |
| `QuickJSExecutor` | `quickjs-emscripten` | Slower (interpreted WASM) | Node, Bun, CF Workers, browser | ⚠️ fallback only — see caveats |

### `QuickJSExecutor` caveats

- **Not a production backend.** Exists so the package loads on runtimes where `isolated-vm` cannot dlopen. Production callers on Node should use `IsolatedVMExecutor`.
- **Sandboxed code must avoid sequential `await` on host functions.** Use `Promise.all([fn1(), fn2()])` for parallel calls instead. Chained sequential `await`s currently crash with an upstream `quickjs-emscripten@0.32.0` release-asyncify regression ([justjake/quickjs-emscripten#258](https://github.com/justjake/quickjs-emscripten/issues/258)) — reproduces identically on Node and Bun.
- **Return-value semantics differ from `isolated-vm`.** Host ↔ guest values cross via a `JSON.stringify` envelope. `Date`, `Map`, `Set`, `BigInt` are converted to strings/objects, not preserved as instances. `isolated-vm` uses structured clone and preserves them. Stick to plain JSON-safe shapes in sandboxed code that targets both backends.
- **CPU timeout is wall-clock-based.** `isolated-vm` uses true CPU time; QuickJS uses elapsed time. Async host calls that take wall time count against the CPU budget under QuickJS.

### Custom Executor

Implement the `Executor` interface to use your own sandbox:

```typescript
import { CodeMode, type Executor, type ExecuteResult } from '@robinbraemer/codemode';

class MyExecutor implements Executor {
  async execute(code: string, globals: Record<string, unknown>): Promise<ExecuteResult> {
    // `code` is an async arrow function as a string: "async () => { ... }"
    // `globals` contains named values to inject:
    //   - plain data (objects, arrays, primitives) → read-only values
    //   - functions → callable host functions
    //   - objects with function values → namespace with callable methods
    return { result: ..., logs: [] };
  }

  dispose() { /* clean up */ }
}

const codemode = new CodeMode({
  spec,
  request: handler,
  executor: new MyExecutor(),
});
```

## Token Efficiency

| Approach | Context Tokens |
|----------|---------------|
| Individual MCP tools (15-50+ tools) | ~15,000-50,000+ |
| Full OpenAPI spec in context | ~1,000,000+ |
| **CodeMode (2 tools)** | **~1,000** |

## License

MIT
