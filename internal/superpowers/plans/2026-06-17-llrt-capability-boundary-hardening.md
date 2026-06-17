# LLRT Capability Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace codemode's loose function-global host callback model with explicit data-only and capability execution modes backed by an LLRT host manifest that exposes no raw bridge global.

**Architecture:** `DataExecutor` runs JSON-only snippets and is implemented by all engines. `CapabilityExecutor` extends it with manifest-declared host capabilities and is implemented only by LLRT. The LLRT native binding builds a per-call `host` object with bound functions from the manifest instead of installing `globalThis.__llrtHostCall`.

**Tech Stack:** TypeScript, Vitest, Rust, napi-rs, rquickjs, LLRT, pnpm, CNAP Bun/Nx integration.

---

## Source Spec

Implement against:

`internal/superpowers/specs/2026-06-17-llrt-capability-boundary-hardening-design.md`

## Task 1: Split The Codemode Executor Contract

**Files:**

- Modify: `packages/codemode/src/types.ts`
- Modify: `packages/codemode/test/executor-contract.ts`
- Modify: `packages/codemode/test/isolated-vm-executor.test.ts`
- Modify: `packages/codemode/test/quickjs-executor.test.ts`
- Modify: `packages/codemode/test/llrt-native-executor.test.ts`

- [ ] **Step 1: Write failing type and behavior tests**

Add data-only contract tests in `packages/codemode/test/executor-contract.ts`:

```ts
it("rejects function values in data-only input", async () => {
  const executor = factory();
  const result = await executor.executeData(
    `async () => typeof api.request`,
    {
      api: {
        request: async () => ({ status: 200 }),
      },
    },
  );

  expect(result.result).toBeUndefined();
  expect(result.error).toContain("data-only");
});
```

Add a capability contract helper in the same file:

```ts
export function capabilityExecutorContract(
  name: string,
  factory: (opts?: SandboxOptions) => CapabilityExecutor,
): void {
  describe(`${name} capability execution`, () => {
    it("exposes only manifest-declared namespace capabilities", async () => {
      const executor = factory();
      const result = await executor.executeWithCapabilities(
        `async () => {
          const response = await api.request({ path: "/test" });
          return {
            status: response.status,
            secret: typeof api.secret,
            topLevel: typeof request,
          };
        }`,
        {},
        {
          namespaces: {
            api: {
              request: {
                call: async (request: { path: string }) => ({
                  status: 200,
                  body: { path: request.path },
                }),
              },
            },
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        status: 200,
        secret: "undefined",
        topLevel: "undefined",
      });
    });
  });
}
```

Update backend test files so LLRT runs both contracts, while `isolated-vm` and QuickJS run only the data contract.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode exec vitest run \
  test/llrt-native-executor.test.ts \
  test/isolated-vm-executor.test.ts \
  test/quickjs-executor.test.ts
```

Expected: TypeScript or runtime failures because `executeData`, `CapabilityExecutor`, and `executeWithCapabilities` do not exist.

- [ ] **Step 3: Add executor types**

Replace the public executor interface in `packages/codemode/src/types.ts` with:

```ts
export interface ExecuteOptions {
  memoryMB?: number;
  timeoutMs?: number;
  wallTimeMs?: number;
  maxHostCalls?: number;
  maxHostPayloadBytes?: number;
  maxHostResultBytes?: number;
  maxResultBytes?: number;
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
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  dispose?(): void;
}

export interface CapabilityExecutor extends DataExecutor {
  executeWithCapabilities(
    code: string,
    input: Record<string, unknown>,
    capabilities: CapabilityManifest,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
}

export type Executor = DataExecutor;
```

Keep `SandboxOptions` as construction-time defaults for now, but make per-call `ExecuteOptions` the executor method option type.

- [ ] **Step 4: Add JSON-input guard helper**

Create a local helper in each executor or shared module:

```ts
export function findFunctionPath(value: unknown, path = "input"): string | null {
  if (typeof value === "function") return path;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findFunctionPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = findFunctionPath(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}
```

If the repo already has an equivalent helper by this point, reuse it instead.

- [ ] **Step 5: Implement data-only methods**

Add `executeData()` to each executor. Keep a temporary `execute()` compatibility wrapper only if existing codemode code still needs it during this task:

```ts
async executeData(
  code: string,
  input: Record<string, unknown>,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const functionPath = findFunctionPath(input);
  if (functionPath) {
    return {
      result: undefined,
      error: `data-only execution does not accept function values at ${functionPath}`,
      stats: emptyStats(0, this.memoryMB),
    };
  }

  return await this.runDataOnly(code, input, options);
}
```

For `isolated-vm` and QuickJS, move existing `execute()` logic under `executeData()` and delete host-function support paths.

- [ ] **Step 6: Verify green**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode exec vitest run \
  test/llrt-native-executor.test.ts \
  test/isolated-vm-executor.test.ts \
  test/quickjs-executor.test.ts
```

Expected: data-only contract passes for all engines. Capability contract remains skipped or fails until Task 3 wires LLRT capabilities.

- [ ] **Step 7: Commit**

Stage only files from this task:

```bash
git add \
  packages/codemode/src/types.ts \
  packages/codemode/test/executor-contract.ts \
  packages/codemode/test/isolated-vm-executor.test.ts \
  packages/codemode/test/quickjs-executor.test.ts \
  packages/codemode/test/llrt-native-executor.test.ts
git commit -m "refactor: split codemode executor contract"
```

## Task 2: Replace LLRT Raw Global Host Dispatch With A Native Host Manifest

**Files:**

- Modify: `packages/llrt/src/types.ts`
- Modify: `packages/llrt/src/runtime.ts`
- Modify: `packages/llrt/src/native.ts`
- Modify: `packages/llrt/native/index.d.ts`
- Modify: `packages/llrt/native/src/runtime.rs`
- Modify: `packages/llrt/test/call-json.test.ts`
- Modify: `packages/llrt/test/runtime.test.ts`

- [ ] **Step 1: Write failing LLRT tests**

In `packages/llrt/test/call-json.test.ts`, add:

```ts
it("does not expose a raw host bridge in data-only execution", async () => {
  const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

  const result = await runtime.callJson(
    `async ({ host }) => ({
      host: typeof host,
      raw: typeof globalThis.__llrtHostCall,
    })`,
    {},
  );

  expect(result).toMatchObject({
    ok: true,
    value: { host: "undefined", raw: "undefined" },
  });
});

it("does not expose a raw host bridge in capability execution", async () => {
  const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

  const result = await runtime.callJsonWithHost(
    `async ({ host }) => ({
      response: await host.api.request({ path: "/pets" }),
      raw: typeof globalThis.__llrtHostCall,
      missing: typeof host.api.secret,
    })`,
    {},
    {
      namespaces: {
        api: {
          request: async (request: { path: string }) => ({
            status: 200,
            path: request.path,
          }),
        },
      },
    },
  );

  expect(result).toMatchObject({
    ok: true,
    value: {
      response: { status: 200, path: "/pets" },
      raw: "undefined",
      missing: "undefined",
    },
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/llrt exec vitest run \
  test/call-json.test.ts \
  test/runtime.test.ts \
  --pool=forks --maxWorkers=1 --testTimeout=20000
```

Expected: `callJsonWithHost` does not exist and host-mode still exposes the raw bridge.

- [ ] **Step 3: Add LLRT manifest types**

In `packages/llrt/src/types.ts`, add:

```ts
export interface LlrtHostManifest {
  namespaces: Record<string, Record<string, LlrtHostFunction>>;
}
```

Keep `LlrtCallOptions.functions` only temporarily if codemode still uses it during this task. Mark it internal in comments and remove it after Task 3.

- [ ] **Step 4: Add native host path option**

In `packages/llrt/src/native.ts` and `packages/llrt/native/index.d.ts`, extend native runtime options:

```ts
hostPaths?: string[];
```

Each path must be a dot-separated manifest path such as `api.request`.

- [ ] **Step 5: Implement `callJsonWithHost()` in TypeScript**

In `packages/llrt/src/runtime.ts`, add:

```ts
async callJsonWithHost<TInput = unknown, TOutput = unknown>(
  source: string,
  input: TInput,
  manifest: LlrtHostManifest,
  options: Omit<LlrtCallOptions, "functions"> = {},
): Promise<LlrtResult<TOutput>> {
  const flattened = flattenHostManifest(manifest);
  return await this.callJsonInternal(source, input, {
    ...options,
    hostFunctions: flattened.functions,
    hostPaths: flattened.paths,
  });
}
```

Refactor existing `callJson()` into a private `callJsonInternal()` so `callJson()` never passes a host dispatcher.

- [ ] **Step 6: Build host object natively**

In `packages/llrt/native/src/runtime.rs`, replace global bridge installation with native host object creation:

```rust
if let Some(host_dispatcher) = host_dispatcher {
    let host = build_host_object(
        &ctx,
        host_dispatcher,
        host_paths.unwrap_or_default(),
        max_host_payload_bytes,
        error_marker.clone(),
    )?;
    argument.set("host", host)?;
}
```

`build_host_object` must:

- split each path on `.`;
- create namespace objects as needed;
- attach an async function only at the declared leaf;
- bind the full path into the closure so guest code cannot choose arbitrary host names;
- never write to `ctx.globals()`.

- [ ] **Step 7: Keep native size and error checks**

The bound native function must call the existing dispatcher with the bound name:

```rust
call_host_function(
    Arc::clone(&host_dispatcher),
    bound_name.clone(),
    args_json,
    max_host_payload_bytes,
    host_error_marker.clone(),
)
```

Keep `host_error_from_message`, `host_error_to_quickjs`, payload checks, result parsing, timeout mapping, and memory mapping unchanged except for removing global installation.

- [ ] **Step 8: Verify green**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/llrt exec vitest run \
  test/call-json.test.ts \
  test/runtime.test.ts \
  --pool=forks --maxWorkers=1 --testTimeout=20000
```

Expected: all LLRT native host/data tests pass, including raw bridge absence.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/llrt/src/types.ts \
  packages/llrt/src/runtime.ts \
  packages/llrt/src/native.ts \
  packages/llrt/native/index.d.ts \
  packages/llrt/native/src/runtime.rs \
  packages/llrt/test/call-json.test.ts \
  packages/llrt/test/runtime.test.ts
git commit -m "fix: bind llrt host capabilities without raw bridge globals"
```

## Task 3: Wire Codemode Capability Execution To LLRT

**Files:**

- Modify: `packages/codemode/src/executor/llrt-native.ts`
- Modify: `packages/codemode/src/executor/auto.ts`
- Modify: `packages/codemode/src/codemode.ts`
- Modify: `packages/codemode/src/mcp.ts`
- Modify: `packages/codemode/test/llrt-native-executor.test.ts`
- Modify: `packages/codemode/test/codemode.test.ts`
- Modify: `packages/codemode/test/auto-executor.test.ts`

- [ ] **Step 1: Write failing codemode capability tests**

In `packages/codemode/test/llrt-native-executor.test.ts`, assert:

```ts
it("does not expose the LLRT raw bridge during capability execution", async () => {
  const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 1000 });

  const result = await executor.executeWithCapabilities(
    `async () => ({
      response: await api.request({ path: "/pets" }),
      raw: typeof globalThis.__llrtHostCall,
    })`,
    {},
    {
      namespaces: {
        api: {
          request: {
            call: async () => ({ status: 200 }),
          },
        },
      },
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.result).toEqual({
    response: { status: 200 },
    raw: "undefined",
  });
});
```

In `packages/codemode/test/codemode.test.ts`, assert `search()` has no request capability:

```ts
it("runs search in data-only mode", async () => {
  const result = await codemode.search(
    `async () => ({ spec: spec.info.title, request: typeof api })`,
  );

  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('"request":"undefined"');
});
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode exec vitest run \
  test/llrt-native-executor.test.ts \
  test/codemode.test.ts \
  test/auto-executor.test.ts
```

Expected: `executeWithCapabilities` is missing or `CodeMode` still uses the old `execute` path.

- [ ] **Step 3: Implement `LlrtNativeExecutor.executeData()`**

Move current JSON-global behavior to `executeData()`:

```ts
async executeData(
  code: string,
  input: Record<string, unknown>,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const functionPath = findFunctionPath(input);
  if (functionPath) return dataOnlyFunctionError(functionPath, this.memoryMB);
  return await this.run(code, input, undefined, options);
}
```

- [ ] **Step 4: Implement `LlrtNativeExecutor.executeWithCapabilities()`**

Build an LLRT host manifest from `CapabilityManifest`:

```ts
async executeWithCapabilities(
  code: string,
  input: Record<string, unknown>,
  capabilities: CapabilityManifest,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const functionPath = findFunctionPath(input);
  if (functionPath) return dataOnlyFunctionError(functionPath, this.memoryMB);
  return await this.run(code, input, capabilities, options);
}
```

`run()` should call `runtime.callJson()` for data-only and `runtime.callJsonWithHost()` for capability mode.

- [ ] **Step 5: Update wrapped guest code**

Change `wrapCode` so guest code receives declared capabilities through globals but does not infer functions from data:

```ts
function wrapCode(code: string): string {
  return `async ({ input, host }) => {
    globalThis.require = undefined;
    globalThis.process = undefined;
    globalThis.fetch = undefined;
    globalThis.console = { log: () => {}, warn: () => {}, error: () => {} };

    for (const [name, value] of Object.entries(input)) {
      globalThis[name] = value;
    }

    if (host) {
      for (const [namespace, value] of Object.entries(host)) {
        globalThis[namespace] = value;
      }
    }

    return await (${code})();
  }`;
}
```

- [ ] **Step 6: Update `CodeMode` to use explicit modes**

In `packages/codemode/src/codemode.ts`:

```ts
const result = await executor.executeData(code, { spec });
```

For execute:

```ts
const executor = await this.getCapabilityExecutor();
const result = await executor.executeWithCapabilities(
  code,
  {},
  {
    namespaces: {
      [this.namespace]: {
        request: { call: bridge },
      },
    },
  },
);
```

Add a `getCapabilityExecutor()` helper that fails clearly when the configured executor lacks `executeWithCapabilities`.

- [ ] **Step 7: Update auto-selection tests**

Assert auto-selection can distinguish data-only fallback from capability requirement:

```ts
expect(typeof executor.executeData).toBe("function");
if (!("executeWithCapabilities" in executor)) {
  await expectCapabilityFailure();
}
```

- [ ] **Step 8: Verify green**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode run test
mise exec -- pnpm --filter @robinbraemer/codemode run typecheck
```

Expected: codemode tests and typecheck pass.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/codemode/src/executor/llrt-native.ts \
  packages/codemode/src/executor/auto.ts \
  packages/codemode/src/codemode.ts \
  packages/codemode/src/mcp.ts \
  packages/codemode/test/llrt-native-executor.test.ts \
  packages/codemode/test/codemode.test.ts \
  packages/codemode/test/auto-executor.test.ts
git commit -m "refactor: route codemode through explicit capability execution"
```

## Task 4: Tighten Request Bridge Policy And Documentation

**Files:**

- Modify: `packages/codemode/src/request-bridge.ts`
- Modify: `packages/codemode/src/tools.ts`
- Modify: `packages/codemode/src/types.ts`
- Modify: `packages/codemode/test/request-bridge.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing policy tests**

Add or update tests in `packages/codemode/test/request-bridge.test.ts`:

```ts
it("allows documented HEAD and OPTIONS methods", async () => {
  const bridge = createRequestBridge(
    async (_input, init) => new Response("", { status: init?.method === "HEAD" ? 204 : 200 }),
    "http://localhost",
  );

  await expect(bridge({ method: "HEAD", path: "/v1/items" })).resolves.toMatchObject({ status: 204 });
  await expect(bridge({ method: "OPTIONS", path: "/v1/items" })).resolves.toMatchObject({ status: 200 });
});
```

- [ ] **Step 2: Run request bridge tests red or green**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode exec vitest run test/request-bridge.test.ts
```

Expected: behavior may already pass; docs still need update.

- [ ] **Step 3: Rename policy docs**

In `types.ts`, distinguish:

- `HostBridgePolicy` for LLRT host callback limits;
- `RequestCapabilityPolicy` for HTTP bridge limits.

Keep `CodeModeOptions` accepting the same fields for now, but document which policy each field belongs to.

- [ ] **Step 4: Align tool docs**

Update `packages/codemode/src/tools.ts` and `README.md` so method examples and descriptions include `HEAD` and `OPTIONS` or explicitly describe them as advanced but allowed.

- [ ] **Step 5: Verify green**

Run:

```bash
mise exec -- pnpm --filter @robinbraemer/codemode exec vitest run test/request-bridge.test.ts
mise exec -- pnpm --filter @robinbraemer/codemode run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add \
  packages/codemode/src/request-bridge.ts \
  packages/codemode/src/tools.ts \
  packages/codemode/src/types.ts \
  packages/codemode/test/request-bridge.test.ts \
  README.md
git commit -m "docs: clarify codemode request capability policy"
```

## Task 5: Update CNAP To Use Explicit Capability Execution

**Files:**

- Modify in CNAP worktree: `packages/domains/codemode/src/index.ts`
- Modify in CNAP worktree: `packages/domains/codemode/src/service.ts`
- Modify in CNAP worktree: `packages/domains/codemode/src/service.test.ts`
- Modify in CNAP worktree: `packages/mcp/src/mcp.ts` if tool registration needs mode-aware wiring

- [ ] **Step 1: Write failing CNAP tests**

In `packages/domains/codemode/src/service.test.ts`, add assertions that MCP `CodeMode` receives the explicit service executor and sandbox limits. Use the existing fake/mocked executor pattern in that file.

Add a test proving snippet execution uses capability mode rather than data-only globals:

```ts
it("executes snippets through explicit capability mode", async () => {
  const result = await service.execute(
    `async () => {
      const response = await platform.request({ method: "GET", path: "/v1/clusters" });
      return response.body;
    }`,
    "token",
    context,
  );

  expect(result.error).toBeUndefined();
  expect(publicApi.requests[0]?.headers.authorization).toBe("Bearer token");
});
```

- [ ] **Step 2: Run CNAP focused tests to verify red**

Run from `/Users/robin/Developer/cnap-tech/cnap/.worktrees/adopt-llrt-runtime`:

```bash
mise exec -- bun run nx -- run @platform/domain-codemode:test --skipNxCache
```

Expected: compile or test failures until codemode dependency/API use is updated.

- [ ] **Step 3: Update CNAP service construction**

Change `CodeModeService.createCodeMode()` so `new CodeMode(...)` receives the explicit executor and sandbox limits used by snippets:

```ts
const codemode = new CodeMode({
  spec: async () => { ... },
  request: this.createRequestHandler(token, undefined, agentUsage),
  namespace: 'platform',
  executor: this.executor,
  sandbox: {
    memoryMB: 64,
    timeoutMs: 30_000,
    wallTimeMs: 60_000
  }
});
```

If codemode replaces `executor` with a `capabilityExecutor` option, use that new option instead.

- [ ] **Step 4: Update snippet execution**

Replace direct `executor.execute(code, { platform: { request: bridge } })` with the new capability API exposed by codemode. The target shape is:

```ts
const result = await this.executor.executeWithCapabilities(
  code,
  {},
  {
    namespaces: {
      platform: {
        request: { call: bridge },
      },
    },
  },
);
```

- [ ] **Step 5: Verify green**

Run from CNAP worktree:

```bash
mise exec -- bun run nx -- run @platform/domain-codemode:test --skipNxCache
mise exec -- bun run nx -- run-many -t check --projects=@platform/domain-codemode,@platform/mcp --skipNxCache
```

- [ ] **Step 6: Commit CNAP changes**

```bash
git add \
  packages/domains/codemode/src/index.ts \
  packages/domains/codemode/src/service.ts \
  packages/domains/codemode/src/service.test.ts \
  packages/mcp/src/mcp.ts
git commit -m "refactor: use explicit codemode capability execution"
```

## Task 6: Final Verification And PR Prep

**Files:**

- Modify: release notes or PR description only if needed.

- [ ] **Step 1: Run codemode verification**

From `/Users/robin/Developer/cnap-tech/codemode`:

```bash
mise exec -- pnpm --filter @robinbraemer/llrt run test:native
mise exec -- pnpm --filter @robinbraemer/codemode run test
mise exec -- pnpm --filter @robinbraemer/codemode run typecheck
mise exec -- pnpm run ci
git diff --check
```

- [ ] **Step 2: Run CNAP verification**

From `/Users/robin/Developer/cnap-tech/cnap/.worktrees/adopt-llrt-runtime`:

```bash
mise exec -- bun run nx -- run @platform/domain-codemode:test --skipNxCache
mise exec -- bun run nx -- run-many -t check --projects=@platform/domain-codemode,@platform/mcp --skipNxCache
task preflight
git diff --check
```

- [ ] **Step 3: Prepare PR text**

Include:

- architecture change summary;
- threat model summary;
- explicit data-only vs capability mode behavior;
- LLRT raw bridge removal;
- CNAP MCP/snippet integration changes;
- verification commands and results;
- remaining release workflow evidence if native package CI still needs a GitHub run.

- [ ] **Step 4: Push and open PRs**

Open codemode PR first. Then open/update CNAP PR pointing at the codemode package version or local workspace link strategy.
