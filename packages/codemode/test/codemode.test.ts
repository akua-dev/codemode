import { describe, it, expect, beforeEach } from "vitest";
import { CodeMode } from "../src/codemode.js";
import type {
  CapabilityManifest,
  Executor,
  ExecuteResult,
} from "../src/types.js";

// A simple in-memory executor for testing (no sandbox dependency needed)
class TestExecutor implements Executor {
  calls = 0;
  dataCalls = 0;
  capabilityCalls = 0;

  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    this.calls += 1;
    return await this.runCode(code, globals);
  }

  async executeData(
    code: string,
    input: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    this.dataCalls += 1;
    return await this.runCode(code, input);
  }

  async executeWithCapabilities(
    code: string,
    input: Record<string, unknown>,
    capabilities: CapabilityManifest,
  ): Promise<ExecuteResult> {
    this.capabilityCalls += 1;
    const globals: Record<string, unknown> = { ...input };
    for (const [namespace, methods] of Object.entries(capabilities.namespaces)) {
      const namespaceValue: Record<string, unknown> = {};
      for (const [method, capability] of Object.entries(methods)) {
        namespaceValue[method] = (...args: unknown[]) =>
          capability.call.apply({ signal: new AbortController().signal }, args);
      }
      globals[namespace] = namespaceValue;
    }
    return await this.runCode(code, globals);
  }

  private async runCode(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    // Create a minimal sandbox using Function constructor
    // (NOT safe for production - only for testing)
    const globalNames = Object.keys(globals);
    const globalValues = Object.values(globals);

    const noopConsole = { log: () => {}, warn: () => {}, error: () => {} };

    try {
      const fn = new Function(
        "console",
        ...globalNames,
        `return (${code})();`,
      );
      const result = await fn(noopConsole, ...globalValues);
      return { result };
    } catch (err) {
      return {
        result: undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

const testSpec = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/v1/clusters": {
      get: {
        summary: "List clusters",
        operationId: "listClusters",
        responses: { "200": { description: "OK" } },
      },
    },
    "/v1/clusters/{id}": {
      get: {
        summary: "Get cluster",
        operationId: "getCluster",
        parameters: [{ name: "id", in: "path", required: true }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/v1/products": {
      get: {
        summary: "List products",
        operationId: "listProducts",
        responses: { "200": { description: "OK" } },
      },
      post: {
        summary: "Create product",
        operationId: "createProduct",
        responses: { "201": { description: "Created" } },
      },
    },
  },
};

// Simple fetch-like handler for testing
function testHandler(input: string | URL | Request): Response {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const path = url.pathname;

  if (path === "/v1/clusters") {
    return Response.json([
      { id: "eu", name: "EU Prod" },
      { id: "us", name: "US Prod" },
    ]);
  }
  if (path.startsWith("/v1/clusters/")) {
    const id = path.split("/").pop();
    return Response.json({ id, name: `Cluster ${id}` });
  }
  if (path === "/v1/products") {
    return Response.json([{ id: "p1", name: "Redis" }]);
  }

  return new Response("Not Found", { status: 404 });
}

describe("CodeMode", () => {
  let codemode: CodeMode;

  beforeEach(() => {
    codemode = new CodeMode({
      spec: testSpec,
      request: testHandler,
      namespace: "api",
      executor: new TestExecutor(),
    });
  });

  describe("namespace validation", () => {
    it("rejects reserved names", () => {
      for (const name of ["Object", "Array", "Promise", "spec", "console", "global"]) {
        expect(() => new CodeMode({
          spec: testSpec,
          request: testHandler,
          namespace: name,
          executor: new TestExecutor(),
        })).toThrow("reserved name");
      }
    });

    it("rejects invalid JS identifiers", () => {
      for (const name of ["123abc", "my-ns", "my ns", "a.b", ""]) {
        expect(() => new CodeMode({
          spec: testSpec,
          request: testHandler,
          namespace: name,
          executor: new TestExecutor(),
        })).toThrow("valid JavaScript identifier");
      }
    });

    it("accepts valid namespaces", () => {
      for (const name of ["api", "cnap", "_private", "$app", "myApi2"]) {
        expect(() => new CodeMode({
          spec: testSpec,
          request: testHandler,
          namespace: name,
          executor: new TestExecutor(),
        })).not.toThrow();
      }
    });
  });

  describe("tools()", () => {
    it("returns search and execute tool definitions", () => {
      const tools = codemode.tools();
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("search");
      expect(tools[1]!.name).toBe("execute");
      expect(tools[0]!.inputSchema.properties).toHaveProperty("code");
      expect(tools[1]!.inputSchema.properties).toHaveProperty("code");
    });

    it("supports custom tool names", () => {
      codemode.setToolNames("discover", "run");
      const tools = codemode.tools();
      expect(tools[0]!.name).toBe("discover");
      expect(tools[1]!.name).toBe("run");
    });
  });

  describe("search()", () => {
    it("searches the OpenAPI spec by path", async () => {
      const result = await codemode.search(`
        async () => {
          return Object.entries(spec.paths)
            .filter(([p]) => p.includes('/clusters'))
            .flatMap(([path, methods]) =>
              Object.entries(methods)
                .filter(([m]) => ['get','post','put','delete'].includes(m))
                .map(([method, op]) => ({
                  method: method.toUpperCase(), path, summary: op.summary
                }))
            );
        }
      `);

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({
        method: "GET",
        path: "/v1/clusters",
        summary: "List clusters",
      });
    });

    it("can access spec paths", async () => {
      const result = await codemode.search(`
        async () => Object.keys(spec.paths)
      `);
      const data = JSON.parse(result.content[0]!.text);
      expect(data).toContain("/v1/clusters");
    });

    it("returns error for invalid code", async () => {
      const result = await codemode.search(`not valid code at all!!!`);
      expect(result.isError).toBe(true);
    });

    it("rejects oversized code before invoking the executor", async () => {
      const executor = new TestExecutor();
      const cm = new CodeMode({
        spec: testSpec,
        request: testHandler,
        executor,
        maxCodeBytes: 12,
      });

      const result = await cm.search(`async () => "this is too large"`);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Code too large");
      expect(executor.calls).toBe(0);
    });

    it("runs search in data-only mode", async () => {
      const executor = new TestExecutor();
      const cm = new CodeMode({
        spec: testSpec,
        request: testHandler,
        executor,
      });

      const result = await cm.search(`
        async () => ({ pathCount: Object.keys(spec.paths).length, request: typeof api })
      `);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        pathCount: 3,
        request: "undefined",
      });
      expect(executor.dataCalls).toBe(1);
      expect(executor.calls).toBe(0);
    });

    it("supports spec as async getter", async () => {
      const cm = new CodeMode({
        spec: async () => testSpec,
        request: testHandler,
        executor: new TestExecutor(),
      });

      const result = await cm.search(`
        async () => Object.keys(spec.paths)
      `);
      const paths = JSON.parse(result.content[0]!.text);
      expect(paths).toContain("/v1/clusters");
    });
  });

  describe("execute()", () => {
    it("makes GET requests", async () => {
      const result = await codemode.execute(`
        async () => {
          const res = await api.request({ method: "GET", path: "/v1/clusters" });
          return res.body;
        }
      `);

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data).toEqual([
        { id: "eu", name: "EU Prod" },
        { id: "us", name: "US Prod" },
      ]);
    });

    it("supports path parameters", async () => {
      const result = await codemode.execute(`
        async () => {
          const res = await api.request({ method: "GET", path: "/v1/clusters/eu" });
          return res.body;
        }
      `);

      const data = JSON.parse(result.content[0]!.text);
      expect(data).toEqual({ id: "eu", name: "Cluster eu" });
    });

    it("chains multiple requests", async () => {
      const result = await codemode.execute(`
        async () => {
          const clusters = await api.request({ method: "GET", path: "/v1/clusters" });
          const first = clusters.body[0];
          const detail = await api.request({ method: "GET", path: "/v1/clusters/" + first.id });
          return { cluster: detail.body };
        }
      `);

      const data = JSON.parse(result.content[0]!.text);
      expect(data.cluster.id).toBe("eu");
    });

    it("handles 404 responses", async () => {
      const result = await codemode.execute(`
        async () => {
          const res = await api.request({ method: "GET", path: "/v1/nonexistent" });
          return { status: res.status };
        }
      `);

      const data = JSON.parse(result.content[0]!.text);
      expect(data.status).toBe(404);
    });

    it("returns a controlled error for non-JSON-serializable results", async () => {
      const result = await codemode.execute(`
        async () => 1n
      `);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Result serialization failed");
    });

    it("respects custom namespace", async () => {
      const cm = new CodeMode({
        spec: testSpec,
        request: testHandler,
        namespace: "cnap",
        executor: new TestExecutor(),
      });

      const result = await cm.execute(`
        async () => {
          const res = await cnap.request({ method: "GET", path: "/v1/clusters" });
          return res.body;
        }
      `);

      const data = JSON.parse(result.content[0]!.text);
      expect(data).toHaveLength(2);
    });
  });

  describe("callTool()", () => {
    it("routes to search", async () => {
      const result = await codemode.callTool("search", {
        code: `async () => Object.keys(spec.paths)`,
      });
      expect(result.isError).toBeUndefined();
    });

    it("routes to execute", async () => {
      const result = await codemode.callTool("execute", {
        code: `async () => {
          const res = await api.request({ method: "GET", path: "/v1/products" });
          return res.body;
        }`,
      });
      expect(result.isError).toBeUndefined();
    });

    it("returns error for unknown tool", async () => {
      const result = await codemode.callTool("unknown", { code: "" });
      expect(result.isError).toBe(true);
    });
  });

});

describe("Hono integration", () => {
  it("works with Hono app.request()", async () => {
    // Dynamically import Hono to verify integration works
    const { Hono } = await import("hono");
    const app = new Hono();

    app.get("/v1/health", (c) => c.json({ status: "ok" }));
    app.get("/v1/items", (c) => c.json([{ id: 1, name: "Widget" }]));
    app.post("/v1/items", async (c) => {
      const body = await c.req.json();
      return c.json({ id: 2, ...body }, 201);
    });

    const codemode = new CodeMode({
      spec: {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/v1/health": { get: { summary: "Health check" } },
          "/v1/items": {
            get: { summary: "List items" },
            post: { summary: "Create item" },
          },
        },
      },
      request: app.request.bind(app),
      namespace: "myapp",
      executor: new TestExecutor(),
    });

    // Search
    const searchResult = await codemode.search(`
      async () => Object.keys(spec.paths)
    `);
    const paths = JSON.parse(searchResult.content[0]!.text);
    expect(paths).toEqual(["/v1/health", "/v1/items"]);

    // Execute GET
    const getResult = await codemode.execute(`
      async () => {
        const res = await myapp.request({ method: "GET", path: "/v1/items" });
        return res.body;
      }
    `);
    const items = JSON.parse(getResult.content[0]!.text);
    expect(items).toEqual([{ id: 1, name: "Widget" }]);

    // Execute POST
    const postResult = await codemode.execute(`
      async () => {
        const res = await myapp.request({
          method: "POST",
          path: "/v1/items",
          body: { name: "Gadget" }
        });
        return { status: res.status, body: res.body };
      }
    `);
    const created = JSON.parse(postResult.content[0]!.text);
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Gadget");
  });
});

describe("request counter resets per execution", () => {
  it("returns error (not crash) when request limit exceeded", async () => {
    const cm = new CodeMode({
      spec: testSpec,
      request: testHandler,
      maxRequests: 1,
      executor: new TestExecutor(),
    });

    const result = await cm.execute(`
      async () => {
        await api.request({ method: "GET", path: "/v1/clusters" });
        await api.request({ method: "GET", path: "/v1/products" });
        return "should not reach here";
      }
    `);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Request limit exceeded");
  });

  it("allows maxRequests per execute() call, not per instance", async () => {
    const cm = new CodeMode({
      spec: testSpec,
      request: testHandler,
      maxRequests: 2,
      executor: new TestExecutor(),
    });

    // First execution: 2 requests (at limit)
    const r1 = await cm.execute(`
      async () => {
        await api.request({ method: "GET", path: "/v1/clusters" });
        await api.request({ method: "GET", path: "/v1/products" });
        return "ok";
      }
    `);
    expect(r1.isError).toBeUndefined();

    // Second execution: should also get 2 fresh requests (counter reset)
    const r2 = await cm.execute(`
      async () => {
        await api.request({ method: "GET", path: "/v1/clusters" });
        await api.request({ method: "GET", path: "/v1/products" });
        return "ok";
      }
    `);
    expect(r2.isError).toBeUndefined();
  });
});
