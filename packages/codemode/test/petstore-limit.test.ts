import { describe, it, expect, afterEach } from "vitest";
import { CodeMode } from "../src/codemode.js";
import type {
  CapabilityManifest,
  Executor,
  ExecuteResult,
} from "../src/types.js";

const PETSTORE_BASE = "https://petstore3.swagger.io";

const petstoreSpec = {
  openapi: "3.0.0",
  info: { title: "Swagger Petstore", version: "1.0.27" },
  paths: {
    "/api/v3/pet/findByStatus": {
      get: { summary: "Finds Pets by status", operationId: "findPetsByStatus" },
    },
    "/api/v3/store/inventory": {
      get: { summary: "Returns pet inventories by status", operationId: "getInventory" },
    },
    "/api/v3/user/login": {
      get: { summary: "Logs user into the system", operationId: "loginUser" },
    },
  },
};

class TestExecutor implements Executor {
  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    return await this.runCode(code, globals);
  }

  async executeData(
    code: string,
    input: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    return await this.runCode(code, input);
  }

  async executeWithCapabilities(
    code: string,
    input: Record<string, unknown>,
    capabilities: CapabilityManifest,
  ): Promise<ExecuteResult> {
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
    const globalNames = Object.keys(globals);
    const globalValues = Object.values(globals);
    const noopConsole = { log: () => {}, warn: () => {}, error: () => {} };

    try {
      const fn = new Function("console", ...globalNames, `return (${code})();`);
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

describe("request limiting against live Petstore API", () => {
  let cm: CodeMode;

  afterEach(() => {
    cm?.dispose();
  });

  it("allows requests within the limit", async () => {
    cm = new CodeMode({
      spec: petstoreSpec,
      request: fetch,
      baseUrl: PETSTORE_BASE,
      namespace: "petstore",
      maxRequests: 3,
      executor: new TestExecutor(),
    });

    const result = await cm.execute(`
      async () => {
        const r1 = await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "available" } });
        const r2 = await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "sold" } });
        return { count: 2, r1Status: r1.status, r2Status: r2.status };
      }
    `);

    // We're testing that the request bridge didn't block these — not the petstore response codes
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.count).toBe(2);
    expect(typeof data.r1Status).toBe("number");
    expect(typeof data.r2Status).toBe("number");
  });

  it("returns error (not crash) when limit exceeded", async () => {
    cm = new CodeMode({
      spec: petstoreSpec,
      request: fetch,
      baseUrl: PETSTORE_BASE,
      namespace: "petstore",
      maxRequests: 1,
      executor: new TestExecutor(),
    });

    const result = await cm.execute(`
      async () => {
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "available" } });
        await petstore.request({ method: "GET", path: "/api/v3/user/login", query: { username: "test", password: "test" } });
        return "should not reach here";
      }
    `);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Request limit exceeded");
  });

  it("resets counter between execute() calls", async () => {
    cm = new CodeMode({
      spec: petstoreSpec,
      request: fetch,
      baseUrl: PETSTORE_BASE,
      namespace: "petstore",
      maxRequests: 2,
      executor: new TestExecutor(),
    });

    // First execution: 2 requests (at limit)
    const r1 = await cm.execute(`
      async () => {
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "available" } });
        await petstore.request({ method: "GET", path: "/api/v3/user/login", query: { username: "test", password: "test" } });
        return "first-ok";
      }
    `);
    expect(r1.isError).toBeUndefined();
    expect(r1.content[0]!.text).toBe("first-ok");

    // Second execution: gets a fresh counter, should also succeed
    const r2 = await cm.execute(`
      async () => {
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "sold" } });
        await petstore.request({ method: "GET", path: "/api/v3/user/login", query: { username: "a", password: "b" } });
        return "second-ok";
      }
    `);
    expect(r2.isError).toBeUndefined();
    expect(r2.content[0]!.text).toBe("second-ok");
  });

  it("blocks exactly at the boundary", async () => {
    cm = new CodeMode({
      spec: petstoreSpec,
      request: fetch,
      baseUrl: PETSTORE_BASE,
      namespace: "petstore",
      maxRequests: 2,
      executor: new TestExecutor(),
    });

    // 2 requests: OK (exactly at limit)
    const ok = await cm.execute(`
      async () => {
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "sold" } });
        await petstore.request({ method: "GET", path: "/api/v3/user/login", query: { username: "test", password: "test" } });
        return "within-limit";
      }
    `);
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toBe("within-limit");

    // 3 requests in a new execute(): should fail on the 3rd
    const fail = await cm.execute(`
      async () => {
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "available" } });
        await petstore.request({ method: "GET", path: "/api/v3/pet/findByStatus", query: { status: "sold" } });
        await petstore.request({ method: "GET", path: "/api/v3/user/login", query: { username: "a", password: "b" } });
        return "should not reach here";
      }
    `);
    expect(fail.isError).toBe(true);
    expect(fail.content[0]!.text).toContain("Request limit exceeded");
    expect(fail.content[0]!.text).toContain("max 2");
  });
});
