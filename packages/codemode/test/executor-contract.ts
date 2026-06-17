import { describe, it, expect } from "vitest";
import type { CapabilityExecutor, Executor, SandboxOptions } from "../src/types.js";
import { CodeMode } from "../src/codemode.js";

/**
 * Factory that constructs an executor for a given set of sandbox options.
 *
 * The contract calls this once per test so each case gets a fresh executor;
 * state-isolation tests reuse the same instance across two `execute()` calls
 * deliberately to assert no leakage.
 */
export type ExecutorFactory = (opts?: SandboxOptions) => Executor;
export type CapabilityExecutorFactory = (opts?: SandboxOptions) => CapabilityExecutor;

/**
 * Optional per-backend knobs for tests whose absolute thresholds depend on
 * the underlying runtime. The defaults are tuned for V8/isolated-vm; quickjs
 * needs a smaller limit and a smaller stress loop to OOM in reasonable time.
 *
 * This is the ONLY escape hatch the contract exposes — any other backend
 * divergence belongs outside the contract.
 */
export interface ExecutorContractOptions {
  /** Memory-limit OOM test tuning. */
  memoryStress?: {
    /** Sandbox memory limit (MB) for the OOM test. */
    memoryMB: number;
    /** Outer loop iterations for the allocation stress. */
    iterations: number;
  };
  /** Whether this backend supports host function callbacks. Default: true. */
  supportsHostFunctions?: boolean;
}

const DEFAULT_MEMORY_STRESS = { memoryMB: 8, iterations: 10_000_000 } as const;

/**
 * Backend-agnostic executor contract. Any class implementing `Executor`
 * should satisfy every assertion in here. Run it from a backend-specific
 * test file via:
 *
 *   executorContract("MyExecutor", (opts) => new MyExecutor(opts));
 *
 * The `name` is emitted as the top-level `describe` title so CI logs read
 * the same as the pre-extraction layout.
 */
export function executorContract(
  name: string,
  factory: ExecutorFactory,
  options: ExecutorContractOptions = {},
): void {
  const memoryStress = options.memoryStress ?? DEFAULT_MEMORY_STRESS;
  const supportsHostFunctions = options.supportsHostFunctions ?? true;

  describe(name, () => {
    it("executes simple code", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => 1 + 2`,
        {},
      );
      expect(result.result).toBe(3);
      expect(result.error).toBeUndefined();
    });

    it("injects and reads data globals", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => spec.info.title`,
        {
          spec: {
            openapi: "3.0.0",
            info: { title: "My API", version: "1.0.0" },
            paths: {},
          },
        },
      );
      expect(result.result).toBe("My API");
    });

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

    it("rejects function values in cyclic data-only input", async () => {
      const executor = factory();
      const input: Record<string, unknown> = {};
      input.self = input;
      input.api = {
        request: async () => ({ status: 200 }),
      };

      const result = await executor.executeData(
        `async () => typeof api.request`,
        input,
      );

      expect(result.result).toBeUndefined();
      expect(result.error).toContain("input.api.request");
    });

    if (supportsHostFunctions) {
      it("injects async host functions in a namespace", async () => {
        const executor = factory();
        const result = await executor.execute(
          `async () => {
            const res = await api.request({ method: "GET", path: "/test" });
            return res;
          }`,
          {
            api: {
              request: async (opts: any) => ({
                status: 200,
                body: { message: "hello from " + opts.path },
              }),
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual({
          status: 200,
          body: { message: "hello from /test" },
        });
      });
    } else {
      it("rejects host function globals", async () => {
        const executor = factory();
        const result = await executor.execute(
          `async () => api.request({ method: "GET", path: "/test" })`,
          {
            api: {
              request: async () => ({ status: 200 }),
            },
          },
        );
        expect(result.error).toContain("does not support host functions");
      });
    }

    it("console.log is a no-op (does not crash)", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => {
          console.log("hello", "world");
          console.warn("warning!");
          console.error("error!");
          return 42;
        }`,
        {},
      );
      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it("returns error for invalid code", async () => {
      const executor = factory();
      const result = await executor.execute(
        `not valid code!!!`,
        {},
      );
      expect(result.error).toBeDefined();
    });

    it("returns error for runtime exceptions", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => { throw new Error("boom"); }`,
        {},
      );
      expect(result.error).toContain("boom");
    });

    it("enforces memory limits", async () => {
      const executor = factory({ memoryMB: memoryStress.memoryMB });
      const result = await executor.execute(
        `async () => {
          const arr = [];
          for (let i = 0; i < ${memoryStress.iterations}; i++) {
            arr.push("x".repeat(1000));
          }
          return arr.length;
        }`,
        {},
      );
      expect(result.error).toBeDefined();
    });

    it("enforces CPU timeout", async () => {
      const executor = factory({ timeoutMs: 100 });
      const result = await executor.execute(
        `async () => { while(true) {} }`,
        {},
      );
      expect(result.error).toBeDefined();
    });

    if (supportsHostFunctions) {
      it("enforces wall-clock timeout on stalled async host calls", async () => {
        const executor = factory({ timeoutMs: 5_000, wallTimeMs: 200 });
        const result = await executor.execute(
          `async () => {
            // Call a host function that never resolves — wall-clock timeout should fire
            return await hang();
          }`,
          {
            hang: () => new Promise(() => {}), // never resolves
          },
        );
        expect(result.error).toBeDefined();
        expect(result.error).toContain("Wall-clock timeout");
      });
    }

    it("isolates executions (no state leakage)", async () => {
      const executor = factory();

      // First execution sets a global
      await executor.execute(
        `async () => { globalThis.leaked = "secret"; return true; }`,
        {},
      );

      // Second execution should not see it
      const result = await executor.execute(
        `async () => typeof globalThis.leaked`,
        {},
      );
      expect(result.result).toBe("undefined");
    });

    it("has no access to Node.js APIs", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => {
          try { return typeof require; } catch { return "no require"; }
        }`,
        {},
      );
      expect(result.result).toBe("undefined");

      const result2 = await executor.execute(
        `async () => typeof process`,
        {},
      );
      expect(result2.result).toBe("undefined");

      const result3 = await executor.execute(
        `async () => typeof fetch`,
        {},
      );
      expect(result3.result).toBe("undefined");
    });

    it("cannot dynamically import host capability modules", async () => {
      const executor = factory();
      const result = await executor.execute(
        `async () => {
          for (const specifier of ["node:fs", "fs", "node:process"]) {
            try {
              const imported = await import(specifier);
              if (
                typeof imported.readFileSync === "function" ||
                typeof imported.default?.readFileSync === "function" ||
                typeof imported.env === "object"
              ) {
                return { leaked: specifier };
              }
            } catch {
              // Expected: sandboxed execution cannot resolve host modules.
            }
          }
          return { blocked: true };
        }`,
        {},
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ blocked: true });
    });

    if (supportsHostFunctions) {
      it("chains multiple async host calls", async () => {
        const executor = factory();
        const result = await executor.execute(
          `async () => {
            const a = await add(1, 2);
            const b = await add(a, 3);
            return b;
          }`,
          {
            add: async (a: number, b: number) => a + b,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toBe(6);
      });

      it("handles concurrent async calls via Promise.all", async () => {
        const executor = factory();
        const result = await executor.execute(
          `async () => {
            const results = await Promise.all([
              api.request({ path: "/a" }),
              api.request({ path: "/b" }),
              api.request({ path: "/c" }),
            ]);
            return results.map(r => r.body.path);
          }`,
          {
            api: {
              request: async (opts: any) => ({
                status: 200,
                body: { path: opts.path },
              }),
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.result).toEqual(["/a", "/b", "/c"]);
      });

      it("rejects oversized host call payloads before invoking the host function", async () => {
        const executor = factory({ maxHostPayloadBytes: 64 });
        let called = false;

        const result = await executor.execute(
          `async () => api.request({ body: "é".repeat(40) })`,
          {
            api: {
              request: async () => {
                called = true;
                return { status: 200 };
              },
            },
          },
        );

        expect(result.error).toMatch(/payload|arguments/i);
        expect(called).toBe(false);
      });

      it("rejects oversized host call results", async () => {
        const executor = factory({ maxHostResultBytes: 64 });

        const result = await executor.execute(
          `async () => api.request({ path: "/large" })`,
          {
            api: {
              request: async () => ({
                status: 200,
                body: "x".repeat(128),
              }),
            },
          },
        );

        expect(result.error).toContain("result");
      });
    }

    it("rejects oversized final execution results before returning to the host", async () => {
      const executor = factory({ maxResultBytes: 64 });

      const result = await executor.execute(
        `async () => ({ body: "x".repeat(128) })`,
        {},
      );

      expect(result.error).toMatch(/execution result exceeds limit/i);
    });

    it("counts final execution result limits in UTF-8 bytes", async () => {
      const executor = factory({ maxResultBytes: 100 });

      const result = await executor.execute(
        `async () => "é".repeat(64)`,
        {},
      );

      expect(result.error).toMatch(/execution result exceeds limit/i);
    });

    it("does not let guest code tamper with final result byte accounting helpers", async () => {
      const executor = factory({ maxResultBytes: 64 });

      const result = await executor.execute(
        `async () => {
          globalThis.__codemodeUtf8ByteLength = () => 0;
          return { body: "x".repeat(128) };
        }`,
        {},
      );

      expect(result.error).toMatch(/execution result exceeds limit/i);
    });

    it("does not let guest code tamper with JSON.stringify result serialization", async () => {
      const executor = factory({ maxResultBytes: 64 });

      const result = await executor.execute(
        `async () => {
          JSON.stringify = (value) => value;
          return { body: "x".repeat(128) };
        }`,
        {},
      );

      expect(result.error).toMatch(
        /serialization returned a non-string value|execution result exceeds limit/i,
      );
    });

    it("does not let guest code forge a small JSON.stringify result", async () => {
      const executor = factory({ maxResultBytes: 64 });

      const result = await executor.execute(
        `async () => {
          JSON.stringify = () => "\\"small\\"";
          return { body: "x".repeat(128) };
        }`,
        {},
      );

      expect(result.error).toMatch(/execution result exceeds limit/i);
    });
  });

  describe(`CodeMode with ${name}`, () => {
    it("full search + execute flow with Hono", async () => {
      const { Hono } = await import("hono");
      const app = new Hono();

      app.get("/v1/clusters", (c) =>
        c.json([
          { id: "eu", name: "EU Prod" },
          { id: "us", name: "US Staging" },
        ]),
      );
      app.get("/v1/clusters/:id", (c) =>
        c.json({ id: c.req.param("id"), name: "Cluster Detail", region: "eu-west-1" }),
      );
      app.post("/v1/products", async (c) => {
        const body = await c.req.json();
        return c.json({ id: "p1", ...body }, 201);
      });

      const spec = {
        openapi: "3.0.0",
        info: { title: "CNAP API", version: "1.0.0" },
        paths: {
          "/v1/clusters": {
            get: { summary: "List clusters", operationId: "listClusters" },
          },
          "/v1/clusters/{id}": {
            get: { summary: "Get cluster by ID", operationId: "getCluster" },
          },
          "/v1/products": {
            get: { summary: "List products", operationId: "listProducts" },
            post: { summary: "Create product", operationId: "createProduct" },
          },
          "/v1/clusters/{id}/kube/{path}": {
            get: { summary: "Transparent kube API proxy", operationId: "kubeProxy" },
          },
        },
      };

      const codemode = new CodeMode({
        spec,
        request: app.request.bind(app),
        namespace: "cnap",
        executor: factory({ memoryMB: 32, timeoutMs: 10_000 }),
      });

      // Search: find cluster endpoints.
      //
      // NOTE: the template-string indentation here intentionally matches the
      // pre-refactor layout (6-space prefix, not the 8 you would expect from
      // nesting). quickjs-emscripten@0.32.0 release-asyncify deadlocks on
      // certain leading-whitespace patterns in user code — see the long
      // comment in src/executor/quickjs.ts about GC anchoring. Until that's
      // fixed upstream, the contract preserves the working layout.
      const searchResult = await codemode.search(`
      async () => {
        return Object.entries(spec.paths)
          .filter(([p]) => p.includes('/clusters'))
          .flatMap(([path, methods]) =>
            Object.entries(methods)
              .filter(([m]) => ['get','post','put','delete','patch'].includes(m))
              .map(([method, op]) => ({
                method: method.toUpperCase(),
                path,
                summary: op.summary,
              }))
          );
      }
    `);

      expect(searchResult.isError).toBeUndefined();
      const endpoints = JSON.parse(searchResult.content[0]!.text);
      expect(endpoints).toHaveLength(3);
      expect(endpoints[0]).toEqual({
        method: "GET",
        path: "/v1/clusters",
        summary: "List clusters",
      });

      if (!supportsHostFunctions) {
        const execResult = await codemode.execute(`
      async () => {
        const res = await cnap.request({ method: "GET", path: "/v1/clusters" });
        return res.body;
      }
    `);

        expect(execResult.isError).toBe(true);
        expect(execResult.content[0]?.text).toContain("does not support host functions");
        codemode.dispose();
        return;
      }

      // Execute: list clusters
      const execResult = await codemode.execute(`
      async () => {
        const res = await cnap.request({ method: "GET", path: "/v1/clusters" });
        return res.body;
      }
    `);

      expect(execResult.isError).toBeUndefined();
      const clusters = JSON.parse(execResult.content[0]!.text);
      expect(clusters).toEqual([
        { id: "eu", name: "EU Prod" },
        { id: "us", name: "US Staging" },
      ]);

      // Execute: chain calls (list then get detail)
      const chainResult = await codemode.execute(`
      async () => {
        const list = await cnap.request({ method: "GET", path: "/v1/clusters" });
        const first = list.body[0];
        const detail = await cnap.request({ method: "GET", path: "/v1/clusters/" + first.id });
        return { cluster: detail.body, count: list.body.length };
      }
    `);

      expect(chainResult.isError).toBeUndefined();
      const chain = JSON.parse(chainResult.content[0]!.text);
      expect(chain.cluster.id).toBe("eu");
      expect(chain.cluster.region).toBe("eu-west-1");
      expect(chain.count).toBe(2);

      // Execute: POST with body
      const postResult = await codemode.execute(`
      async () => {
        const res = await cnap.request({
          method: "POST",
          path: "/v1/products",
          body: { name: "Redis", chart: "bitnami/redis" },
        });
        return { status: res.status, body: res.body };
      }
    `);

      expect(postResult.isError).toBeUndefined();
      const post = JSON.parse(postResult.content[0]!.text);
      expect(post.status).toBe(201);
      expect(post.body.name).toBe("Redis");

      codemode.dispose();
    });

    it("search returns spec paths", async () => {
      const codemode = new CodeMode({
        spec: {
          openapi: "3.0.0",
          info: { title: "Test API", version: "2.0.0", description: "My test API" },
          paths: {
            "/test": { get: { summary: "Test endpoint" } },
          },
        },
        request: () => new Response("not used"),
        executor: factory(),
      });

      const result = await codemode.search(`
      async () => ({
        pathCount: Object.keys(spec.paths).length,
        paths: Object.keys(spec.paths),
      })
    `);

      const data = JSON.parse(result.content[0]!.text);
      expect(data).toEqual({ pathCount: 1, paths: ["/test"] });
    });
  });
}

export function capabilityExecutorContract(
  name: string,
  factory: CapabilityExecutorFactory,
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

    it("rejects data input that collides with capability namespaces", async () => {
      const executor = factory();
      const result = await executor.executeWithCapabilities(
        `async () => api.secret`,
        { api: { secret: "leaked" } },
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

      expect(result.result).toBeUndefined();
      expect(result.error).toContain("collides with capability namespace");
    });
  });
}
