# Standalone LLRT TypeScript Runtime Design

**Date:** 2026-06-10

**Status:** Prototype implemented; release gates still open.

**Goal:** Publish a standalone TypeScript-friendly LLRT package and make codemode prefer it as the default executor once packaging, safety, and performance gates are proven.

## Decision

Build `@robinbraemer/llrt` as a general Node/TypeScript package backed by a Rust `napi-rs` binding around LLRT's Rust VM API. Codemode consumes that package through a thin executor adapter.

This is better than embedding LLRT directly in codemode because:

- the runtime package is useful outside codemode;
- codemode-specific OpenAPI and MCP behavior stays out of the LLRT layer;
- native packaging and prebuilds can be solved once;
- codemode can keep `isolated-vm`, QuickJS WASM, and the LLRT process proof of concept as fallback executors.

## Confirmed Source Findings

The upstream `awslabs/llrt` project is a runtime and Lambda-oriented binary distribution, not an importable Node package. The embeddable API is Rust-level:

- `llrt_core::vm::Vm`
- `VmOptions`
- `rquickjs::AsyncRuntime`
- `rquickjs::AsyncContext`
- `Ctx::globals().set(...)`
- `Function::call(...)`
- `Promise::into_future(...)`

That makes `napi-rs` the right path for a TypeScript package. There is no mature existing TypeScript/Node binding to reuse from the earlier web and source scan.

## Package Shape

```text
packages/llrt/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  src/
    errors.ts
    index.ts
    native.ts
    runtime.ts
    types.ts
  native/
    Cargo.toml
    build.rs
    src/
      lib.rs
      runtime.rs
  scripts/
    prepare-llrt-source.mjs
  npm/
    darwin-arm64/
    darwin-x64/
    linux-x64-gnu/
    linux-arm64-gnu/
  test/
    call-json.test.ts
    native-loader.test.ts
    native-prebuild-workflow.test.ts
    native-smoke.test.ts
    runtime.test.ts
    stress.test.ts
```

Public package name:

```text
@robinbraemer/llrt
```

Codemode integration:

```text
packages/codemode/src/executor/llrt-native.ts
```

## Public API

The first API is JSON-safe and generic:

```ts
const runtime = new LlrtRuntime({
  memoryMB: 64,
  wallTimeMs: 1000,
});

const result = await runtime.callJson<Input, Output>(
  `async ({ input, host }) => {
    const response = await host.request({ path: input.path });
    return response.body;
  }`,
  { path: "/v1/clusters" },
  {
    memoryMB: 64,
    wallTimeMs: 500,
    functions: {
      request: async (request) => requestBridge(request),
    },
  },
);
```

Types:

- `LlrtRuntimeOptions`
- `LlrtCallOptions`
- `LlrtHostFunction`
- `LlrtStats`
- `LlrtExecutionErrorInfo`
- `LlrtResult<TOutput>`

The boundary is deliberately JSON-safe. The package does not emulate `isolated-vm` references or expose arbitrary live host objects. Host functions are async, named, explicit, and pass JSON arguments/results through the native bridge.

Constructor options define runtime defaults. Per-call options can override
memory, wall time, CPU-time placeholder, and stack limits for the individual
fresh VM invocation.

## Isolation Model

The prototype creates a fresh LLRT VM per `callJson()` invocation.

This is the safest default for untrusted snippets:

- no guest global state leaks across calls;
- memory limit is per VM;
- interrupt handler and wall timeout are scoped per call;
- disposal is simple.

A reusable VM mode can be considered later, but only behind an explicit option and separate state-leak tests.

## Timeout Model

The native binding enforces wall time in two layers:

- an rquickjs interrupt handler for running guest bytecode;
- an outer `tokio::time::timeout` for stalled async paths, including host callbacks.

Codemode maps LLRT timeout failures to an executor error containing `Wall-clock timeout` so the existing executor contract remains portable.

`cpuTimeMs` remains part of the TypeScript API for future parity, but the current LLRT stats do not expose reliable separate CPU time. Stats use `null` when a value is not known.

## Memory Model

The native binding calls `vm.runtime.set_memory_limit(...)` and reports:

- `memoryUsedBytes`
- `memoryLimitBytes`
- `maxStackBytes`

The current stress tests prove that memory pressure returns a typed `MEMORY_LIMIT` failure for the exercised cases. Before production default, we still need broader stress tests with larger snippets, concurrent executions, and host callback traffic.

The stress suite now also verifies per-call memory overrides, repeated
fresh-VM isolation on one `LlrtRuntime` instance, concurrent calls with host
callback traffic, and concurrent stalled host callbacks returning typed
timeouts.

The benchmark runner can now emit both raw JSON and Markdown reports:

```bash
pnpm benchmark:executors -- \
  --report internal/superpowers/reports/2026-06-10-llrt-executor-benchmark.md \
  --json internal/superpowers/reports/2026-06-10-llrt-executor-benchmark.json
```

The current local report is saved at
`internal/superpowers/reports/2026-06-10-llrt-executor-benchmark.md`.
It compares `llrt-native`, `isolated-vm`, and `quickjs-wasm` on cold
execution, OpenAPI JSON scanning, and parallel host callbacks.

The standalone package README now documents install commands, supported Node
version, unsupported runtimes, native targets, JSON-safe host functions, fresh
VM isolation, memory and timeout controls, and default safety boundaries. The
package also includes its own MIT `LICENSE` file so the manifest's `files`
entry is backed by a real package artifact.

## Codemode Default Policy

`createExecutor()` now tries LLRT first when `@robinbraemer/llrt` is installed.

Fallback rule:

- if `@robinbraemer/llrt` itself is missing, try the next backend;
- if the installed LLRT package or adapter is broken, fail loudly instead of silently falling back.

Fallback engines remain:

- `isolated-vm`
- `quickjs-emscripten`
- `LlrtProcessExecutor` as a process-oriented proof of concept.

## Native Packaging

The package now follows napi-rs's optional platform package layout:

- main package: `@robinbraemer/llrt`, shipping JavaScript and TypeScript declarations;
- native packages:
  - `@robinbraemer/llrt-darwin-arm64`
  - `@robinbraemer/llrt-darwin-x64`
  - `@robinbraemer/llrt-linux-x64-gnu`
  - `@robinbraemer/llrt-linux-arm64-gnu`

The loader tries package-local development binaries first, then the current
platform's optional native package. This keeps source checkouts ergonomic while
letting published installs use small OS/CPU/libc-gated native packages.

Release commands:

```bash
pnpm --filter @robinbraemer/llrt run create:native-packages
pnpm --filter @robinbraemer/llrt run prepare:llrt-source
LLRT_TARGET=aarch64-apple-darwin pnpm --filter @robinbraemer/llrt run build:native:target
pnpm --filter @robinbraemer/llrt run collect:native-artifacts
pnpm --filter @robinbraemer/llrt run smoke:packed-install
pnpm --filter @robinbraemer/llrt run prepublish:native-packages:dry-run
pnpm --filter @robinbraemer/llrt run prepare:native-publish
```

`napi pre-publish` is the step that injects `optionalDependencies` into the
main package at the release version. We intentionally do not commit placeholder
`0.0.0` optional dependencies before those native packages exist in a registry.

Native prebuild CI is defined in `.github/workflows/llrt-native.yml`.
It builds every declared napi target on an explicit GitHub-hosted runner:

- `aarch64-apple-darwin` on `macos-15`;
- `x86_64-apple-darwin` on `macos-15-intel`;
- `x86_64-unknown-linux-gnu` on `ubuntu-24.04`;
- `aarch64-unknown-linux-gnu` on `ubuntu-24.04-arm`.

The workflow dry-run-packs each optional native package, uploads the native
artifact, assembles all artifacts in a packaging job, dry-run-packs the main
package and optional packages together, and publishes the LLRT package family
only when manually dispatched with publishing enabled on the `main` branch.

`pnpm --filter @robinbraemer/llrt run verify:native-artifacts` verifies that
the optional native package manifests match the root package's declared
`napi.targets`. The packaging job runs
`verify:native-artifacts:strict` after downloading artifacts and placing them
into `packages/llrt/npm/*`, so release CI fails if any expected `.node` file is
missing before dry-run packing or publishing.

Targeted native builds use an explicit `LLRT_TARGET` environment variable so
the package script validates the target and passes `--target` directly to
`napi build`; the workflow does not rely on package-manager argument
forwarding.

After the packaging job assembles downloaded native artifacts, it runs a
packed-install smoke test: `npm pack` the main package and current platform's
optional native package, install both tarballs into a temporary consumer
project, import `@robinbraemer/llrt`, and execute `LlrtRuntime.callJson()`.
That catches missing files, incorrect optional package names, and loader
resolution regressions before release publishing.

## Non-Goals

The standalone package does not:

- implement Node.js compatibility inside guest code;
- expose filesystem, process, require, or fetch by default;
- expose OpenAPI-specific behavior;
- expose MCP-specific behavior;
- guarantee browser, Bun, or Workers support;
- publish until native dependency and prebuild strategy are solved.

## Release Gates

Before publishing `@robinbraemer/llrt`:

1. Run native prebuild CI for supported targets on GitHub-hosted runners.
2. Document supported Node versions and unsupported runtimes.
3. Confirm main and optional native package tarballs for all release targets.
4. Add benchmark/stress report comparing LLRT, `isolated-vm`, and QuickJS WASM.
5. Decide whether security policy belongs in the standalone runtime or only in codemode's adapter.
6. Decide whether source builds should keep using the self-prepared upstream checkout or move to an upstream crate/fork once available.

Before making LLRT the production default in CNAP:

1. Run codemode executor contract on LLRT in CI.
2. Run memory, timeout, stalled-host-callback, and concurrency stress tests.
3. Benchmark representative CNAP/codemode snippets.
4. Publish or otherwise consume a reproducible `@robinbraemer/llrt` package.
5. Keep explicit fallback engine selection for emergency rollback.

## Current Verdict

LLRT is a strong default candidate, not yet the proven production default.

The prototype now shows the important properties we needed to see:

- importable TypeScript API is feasible;
- a Rust `napi-rs` bridge is practical;
- a standalone package appears novel: the current web/source sweep found
  Lambda deployment helpers and LLRT type packages, but no existing true
  Node/TypeScript embedded LLRT binding;
- native builds no longer depend on an absolute local LLRT checkout;
- the standalone package README documents supported Node/runtime boundaries;
- napi-rs optional platform packages are generated and loadable by name;
- native package manifests and downloaded native artifact presence are verified
  by an explicit script in CI;
- native prebuild CI is specified and guarded by a workflow/manifest test;
- packed package install smoke test proves the current-platform optional
  native package can be consumed by a fresh Node project;
- JSON input/output works;
- async host callbacks work;
- fresh VM isolation works;
- memory limit and wall-time timeout are enforceable in tested cases;
- per-call resource overrides work for memory and timeout inputs;
- stress tests cover repeated isolation, concurrent host callbacks, and
  concurrent stalled callback timeouts;
- codemode's shared executor contract passes against the native adapter.

The current local benchmark report shows zero errors across LLRT,
`isolated-vm`, and `quickjs-emscripten`. On this darwin/arm64 Node 24 machine,
LLRT is fastest in the OpenAPI JSON scan and parallel host-callback scenarios
and effectively tied with `isolated-vm` in the tiny cold execution scenario
(`0.91ms` vs `0.90ms` mean). Treat that as a positive local signal, not a
universal raw-speed claim. The strongest current argument for LLRT is the
combination of lightweight packaging, fresh-VM isolation, typed JSON-safe host
callbacks, and competitive performance on representative snippets. The
remaining blockers are release engineering and broader CI/runtime evidence, not
basic feasibility.
