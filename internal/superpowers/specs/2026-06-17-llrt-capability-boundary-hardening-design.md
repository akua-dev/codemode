# LLRT Capability Boundary Hardening Design

**Date:** 2026-06-17

**Status:** Draft implementation contract.

**Goal:** Re-architect codemode's LLRT execution boundary so data-only execution cannot accidentally expose host capabilities, API-capable execution is explicitly capability-based, and the raw LLRT host bridge is not reachable from guest JavaScript.

## Decision

Replace the current generic `Executor.execute(code, globals)` capability model with explicit execution modes:

- `dataOnly`: JSON input/output only. No host dispatcher, no `host` object, no raw host bridge, no function globals.
- `capability`: JSON input/output plus a small, named capability manifest. Codemode's first capability is exactly `{namespace}.request()`.

The current `globals` abstraction is too broad for a security boundary because it treats any function value as a host callback. That makes capability injection an accidental property of data injection. The new API must make host capabilities a separate type and a separate method.

## Source Findings

LLRT module loading is disabled for `LlrtRuntime.callJson()`:

- `packages/llrt/native/src/runtime.rs` constructs the VM with `ModuleBuilder::new()` and `allow_module_loading: false`.
- Upstream `llrt_core/src/vm.rs` only enables embedded, package, and file resolvers when `allow_module_loading` is true.
- Upstream `llrt_modules/src/module_builder.rs` shows `ModuleBuilder::default()` attaches built-in globals/modules, while `ModuleBuilder::new()` starts empty.

Host callbacks are optional but currently string-dispatched:

- `packages/llrt/src/runtime.ts` creates a host dispatcher only when `options.functions` is present.
- `packages/llrt/native/src/runtime.rs` installs `globalThis.__llrtHostCall` only when a host dispatcher exists.
- The wrapper exposes `host` as a `Proxy`; any string property becomes a host call name.
- Guest code can bypass the proxy and call `globalThis.__llrtHostCall(name, argsJson)` directly when host mode is enabled.

Limits are split between Rust and TypeScript:

- Rust enforces VM heap, stack, wall timeout, native host payload bytes, and final serialized result bytes.
- TypeScript enforces option validation, host call count, host result bytes, input serialization, and wrapper-side result checks.
- CPU time is explicitly unsupported by the current LLRT binding; wall time is the enforceable execution timeout.

Codemode entrypoints are already semantically split, but the shared executor API is not:

- `CodeMode.search()` injects only the OpenAPI `spec` data.
- `CodeMode.execute()` constructs a fresh request bridge and injects `{namespace}.request()`.
- `LlrtNativeExecutor` accepts arbitrary top-level function globals and one-level namespace methods.
- `IsolatedVMExecutor` and `QuickJSExecutor` now reject host function globals.

CNAP integration depends on the loose API:

- Snippet execution creates an explicit `LlrtNativeExecutor` and calls `executor.execute(code, { platform: { request: bridge } })`.
- MCP `createCodeMode()` creates `new CodeMode({ spec, request, namespace: "platform" })` without passing CNAP's explicit executor or sandbox limits, so it relies on codemode auto-selection.
- CNAP forwarding sets `Authorization: Bearer <token>` in the host request handler. Sandbox-supplied credential and routing headers are stripped by codemode's request bridge.
- Workspace context headers are defaults and may be overridden by guest code; public API authorization is the enforcement boundary for workspace access.

## Threat Model

Untrusted input:

- model-generated JavaScript passed to `search`, `execute`, or snippets;
- request objects passed to `{namespace}.request()`;
- returned values and thrown values from guest code.

Protected assets:

- Node host process APIs such as `fs`, `process`, environment variables, network APIs, and native bindings;
- authenticated CNAP bearer token held by the host request handler;
- workspace-scoped data reachable through the public API;
- host memory and event loop availability.

Allowed behavior:

- `dataOnly` code may compute over JSON globals and return JSON-compatible values.
- `capability` code may call only capabilities named in its manifest.
- Codemode capability mode may call only the request capability exposed as `{namespace}.request(options)`.

Forbidden behavior:

- importing host modules such as `fs`, `node:fs`, or `node:process`;
- observing or invoking a raw host bridge global;
- passing arbitrary function globals through the executor;
- calling host capability names not declared by the manifest;
- forging typed host/limit errors;
- bypassing request count, concurrency, payload, result, memory, or wall-time limits;
- forwarding guest-supplied credential, routing override, forwarding, or hop-by-hop headers.

Non-goals:

- defending against a malicious native `@robinbraemer/llrt` package after installation;
- providing `isolated-vm`-style live object references;
- supporting arbitrary host function injection as a public codemode feature.

## Architecture

### Public Executor API

Replace the current function-global contract with mode-specific APIs:

```ts
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
```

`CapabilityManifest` is explicit data, not inferred from `input`:

```ts
export interface CapabilityManifest {
  namespaces: Record<string, Record<string, HostCapability>>;
}

export interface HostCapability {
  call(this: HostCallContext, ...args: unknown[]): unknown | Promise<unknown>;
}
```

Rules:

- `input` must be JSON-serializable and must not contain functions.
- `executeData()` must fail closed if any function value appears in `input`.
- `executeWithCapabilities()` is available only on LLRT.
- `IsolatedVMExecutor` and `QuickJSExecutor` implement `DataExecutor` only.
- Auto-selection may return a data executor for `search`, but API-capable `execute` must require a `CapabilityExecutor`.

### LLRT Runtime API

Split low-level LLRT calls:

```ts
runtime.callJson(source, input, options)
runtime.callJsonWithHost(source, input, hostManifest, options)
```

`callJson()` never passes a host dispatcher to native code.

`callJsonWithHost()` passes:

- a host dispatcher;
- a manifest of allowed capability paths;
- host call limits.

The native binding creates the `host` object inside the QuickJS context. Each exposed function is bound to one fixed capability name. Guest code receives `host` as an argument, but no raw `globalThis.__llrtHostCall` is installed.

Target shape inside native execution:

```text
argument = {
  input: <json parsed input>,
  host: {
    platform: {
      request: <native async function bound to "platform.request">
    }
  }
}
```

The wrapper no longer needs a JavaScript `Proxy` for host calls. Unknown host names cannot be synthesized by property access because only manifest-declared functions exist.

### Codemode API

`CodeMode.search()` uses `executeData()`:

```ts
executor.executeData(code, { spec });
```

`CodeMode.execute()` uses `executeWithCapabilities()`:

```ts
executor.executeWithCapabilities(
  code,
  {},
  {
    namespaces: {
      [namespace]: {
        request: { call: requestBridge },
      },
    },
  },
);
```

No codemode caller should pass request functions through plain globals. The tool surface still shows `{namespace}.request()`, but internally it is a declared capability.

### Request Capability Policy

Request bridge limits stay separate from LLRT host-call limits:

```ts
export interface RequestCapabilityPolicy {
  maxRequests: number;
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  allowedHeaders?: string[];
  exposedResponseHeaders?: string[];
}

export interface HostBridgePolicy {
  maxHostCalls: number;
  maxHostPayloadBytes: number;
  maxHostResultBytes: number;
  maxResultBytes: number;
}
```

The request bridge continues to enforce:

- relative-path-only requests;
- method whitelist;
- request count and concurrency limits;
- request and response byte limits;
- credential, routing, forwarding, and hop-by-hop header stripping;
- explicit response-header exposure.

Align docs and behavior for `HEAD` and `OPTIONS`: either document them as allowed or remove them from the bridge. The recommended choice is to keep them allowed and document them, because the bridge already validates path and headers.

### CNAP Integration

CNAP should pass the same explicit executor and sandbox limits to both MCP and snippets.

Required changes:

- `CodeModeService.createCodeMode()` must construct `CodeMode` with the service's explicit LLRT capability executor and sandbox policy.
- `CodeModeService.execute()` must call codemode's capability API instead of calling `executor.execute()` with `{ platform: { request } }`.
- CNAP tests must prove:
  - MCP `search` uses data-only execution;
  - MCP/snippet `execute` uses capability mode;
  - bearer token forwarding still happens only in the host request handler;
  - `Akua-Context` remains an overridable request header and authorization remains enforced by the public API layer;
  - configured sandbox limits are used for MCP and snippets.

## Test Requirements

LLRT package:

- `callJson()` does not expose `host` or any raw bridge global.
- `callJsonWithHost()` exposes only manifest-declared host functions.
- `callJsonWithHost()` does not expose `globalThis.__llrtHostCall`.
- Direct attempts to call undeclared host names fail before invoking host code.
- Host call count, payload bytes, result bytes, wall timeout, memory, and final result limits still pass.
- Guest-forged host error markers remain ignored.
- Dynamic imports of `node:fs`, `fs`, and `node:process` remain blocked.

Codemode package:

- `executeData()` accepts JSON globals and rejects functions.
- `executeWithCapabilities()` exposes `{namespace}.request()` only through a capability manifest.
- Existing `CodeMode.search()` behavior works through data-only mode.
- Existing `CodeMode.execute()` behavior works through capability mode.
- `isolated-vm` and QuickJS remain data-only and reject capability execution.
- Auto executor selection cannot silently route API-capable execution to a data-only executor.
- Request bridge tests cover method docs, header stripping, path validation, body/result limits, request count, and concurrency.

CNAP:

- `CodeModeService.createCodeMode()` passes explicit executor and sandbox limits.
- MCP `search` and `execute` are still quota-gated.
- Snippet execution still forwards bearer token and workspace context.
- Snippet execution still records request count and execution stats.
- Data-only execution cannot call `platform.request()`.

## Migration Plan

1. Add the new `DataExecutor`, `CapabilityExecutor`, `CapabilityManifest`, `ExecuteOptions`, and policy types while keeping temporary compatibility adapters inside codemode only.
2. Update `LlrtNativeExecutor` to implement `executeData()` and `executeWithCapabilities()`.
3. Update `@robinbraemer/llrt` to expose `callJson()` and `callJsonWithHost()`, then remove raw bridge global exposure from host mode.
4. Update `CodeMode.search()` and `CodeMode.execute()` to use the explicit modes.
5. Update executor contract tests to separate data-only and capability contracts.
6. Update CNAP integration to use the explicit LLRT capability executor for both MCP and snippets.
7. Remove public documentation that suggests arbitrary function globals are supported.
8. Run codemode CI, LLRT native tests, CNAP domain-codemode tests, CNAP MCP checks, and CNAP preflight before PR/release.

## Open Decisions

- Whether to keep a deprecated `Executor.execute()` compatibility method for one release or break immediately. Recommendation: break immediately; the only known consumer is CNAP and this is a security boundary.
- Whether the low-level LLRT package should expose general host capabilities to external users. Recommendation: yes, but only through `callJsonWithHost()` manifest-bound functions, never through raw global dispatch.
- Whether to keep QuickJS as an explicit data-only executor. Recommendation: keep it for now, but never allow host callbacks through it.

## Promotion Standard

The refactor is complete only when current evidence proves:

- data-only execution installs no host dispatcher and exposes no host object;
- capability execution exposes only manifest-declared functions;
- no guest-visible raw bridge global exists in either mode;
- codemode no longer treats function values in globals as capabilities;
- CNAP MCP and snippets both use the explicit LLRT capability executor and configured limits;
- focused security regression tests pass in `@robinbraemer/llrt`, `@robinbraemer/codemode`, and CNAP;
- full codemode CI and CNAP preflight pass or any skipped checks are documented with a concrete reason.
