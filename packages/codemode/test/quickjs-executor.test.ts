import { describe, it, expect } from "vitest";
import { QuickJSExecutor } from "../src/executor/quickjs.js";
import { CodeMode } from "../src/codemode.js";

describe("QuickJSExecutor", () => {
  it("executes simple code", async () => {
    const executor = new QuickJSExecutor();
    const result = await executor.execute(
      `async () => 1 + 2`,
      {},
    );
    expect(result.result).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("injects and reads data globals", async () => {
    const executor = new QuickJSExecutor();
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

  it("injects async host functions in a namespace", async () => {
    const executor = new QuickJSExecutor();
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

  it("console.log is a no-op (does not crash)", async () => {
    const executor = new QuickJSExecutor();
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
    const executor = new QuickJSExecutor();
    const result = await executor.execute(
      `not valid code!!!`,
      {},
    );
    expect(result.error).toBeDefined();
  });

  it("returns error for runtime exceptions", async () => {
    const executor = new QuickJSExecutor();
    const result = await executor.execute(
      `async () => { throw new Error("boom"); }`,
      {},
    );
    expect(result.error).toContain("boom");
  });

  it("enforces memory limits", async () => {
    const executor = new QuickJSExecutor({ memoryMB: 4 });
    const result = await executor.execute(
      `async () => {
        const arr = [];
        for (let i = 0; i < 1_000_000; i++) {
          arr.push("x".repeat(1000));
        }
        return arr.length;
      }`,
      {},
    );
    expect(result.error).toBeDefined();
  });

  it("enforces CPU timeout", async () => {
    const executor = new QuickJSExecutor({ timeoutMs: 100 });
    const result = await executor.execute(
      `async () => { while(true) {} }`,
      {},
    );
    expect(result.error).toBeDefined();
  });

  it("enforces wall-clock timeout on stalled async host calls", async () => {
    const executor = new QuickJSExecutor({ timeoutMs: 5_000, wallTimeMs: 200 });
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

  it("isolates executions (no state leakage)", async () => {
    const executor = new QuickJSExecutor();

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
    const executor = new QuickJSExecutor();
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

  it("chains multiple async host calls", async () => {
    const executor = new QuickJSExecutor();
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
    const executor = new QuickJSExecutor();
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
});

describe("CodeMode with QuickJSExecutor", () => {
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
      executor: new QuickJSExecutor({ memoryMB: 32, timeoutMs: 10_000 }),
    });

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
      executor: new QuickJSExecutor(),
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

describe("ExecuteStats shape parity (QuickJS vs IsolatedVM)", () => {
  it("both executors produce ExecuteStats with the same keys", async () => {
    const { IsolatedVMExecutor } = await import("../src/executor/isolated-vm.js");
    const code = `async () => { let s = 0; for (let i = 0; i < 100; i++) s += i; return s; }`;

    const ivmExec = new IsolatedVMExecutor();
    const qjsExec = new QuickJSExecutor();

    const ivmRes = await ivmExec.execute(code, {});
    const qjsRes = await qjsExec.execute(code, {});

    expect(ivmRes.error).toBeUndefined();
    expect(qjsRes.error).toBeUndefined();
    expect(ivmRes.result).toBe(qjsRes.result);

    const ivmKeys = Object.keys(ivmRes.stats).toSorted();
    const qjsKeys = Object.keys(qjsRes.stats).toSorted();
    expect(qjsKeys).toEqual(ivmKeys);

    // Every value must be a finite number — no NaN/Infinity leaking from
    // either backend.
    for (const key of ivmKeys) {
      const ivmVal = (ivmRes.stats as Record<string, number>)[key];
      const qjsVal = (qjsRes.stats as Record<string, number>)[key];
      expect(typeof ivmVal).toBe("number");
      expect(typeof qjsVal).toBe("number");
      expect(Number.isFinite(ivmVal)).toBe(true);
      expect(Number.isFinite(qjsVal)).toBe(true);
    }
  });

  it("documents the return-value semantic divergence (structured clone vs JSON)", async () => {
    // isolated-vm uses structured clone (`{ copy: true }`) — preserves Date,
    // Map, Set, BigInt as their original types. QuickJSExecutor uses a
    // JSON.stringify envelope as a workaround for upstream GC-anchoring bugs
    // in quickjs-emscripten@0.32.0 release-asyncify, so those types degrade
    // to their JSON representation.
    //
    // This test locks the divergence so any future change (e.g. an upstream
    // fix that lets us drop the JSON envelope) breaks loudly.
    const { IsolatedVMExecutor } = await import("../src/executor/isolated-vm.js");
    const code = `async () => new Date("2026-01-15T00:00:00Z")`;

    const ivmExec = new IsolatedVMExecutor();
    const qjsExec = new QuickJSExecutor();

    const ivmRes = await ivmExec.execute(code, {});
    const qjsRes = await qjsExec.execute(code, {});

    expect(ivmRes.error).toBeUndefined();
    expect(qjsRes.error).toBeUndefined();

    // isolated-vm: structured clone preserves the Date instance.
    expect(ivmRes.result).toBeInstanceOf(Date);
    expect((ivmRes.result as Date).toISOString()).toBe("2026-01-15T00:00:00.000Z");

    // QuickJS: JSON envelope returns the date as an ISO-8601 string.
    expect(typeof qjsRes.result).toBe("string");
    expect(qjsRes.result).toBe("2026-01-15T00:00:00.000Z");
  });
});
