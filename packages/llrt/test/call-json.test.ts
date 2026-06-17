import { expect, it } from "vitest";
import { LlrtRuntime } from "../src/index.js";
import { describeWithNativeBinding as describe } from "./native-test-helper.js";

describe("LlrtRuntime.callJson native execution", () => {
  it("executes an async guest function with JSON input and output", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson<
      { spec: { info: { title: string } } },
      { title: string; upper: string }
    >(
      `async ({ input }) => ({
        title: input.spec.info.title,
        upper: input.spec.info.title.toUpperCase(),
      })`,
      { spec: { info: { title: "Petstore" } } },
    );

    expect(result).toEqual({
      ok: true,
      value: { title: "Petstore", upper: "PETSTORE" },
      stats: {
        wallTimeMs: expect.any(Number),
        cpuTimeMs: null,
        memoryUsedBytes: expect.any(Number),
        memoryLimitBytes: 8 * 1024 * 1024,
        maxStackBytes: expect.any(Number),
      },
    });
  });

  it("returns a typed evaluation failure when guest code throws", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 64 });

    const result = await runtime.callJson(
      `async () => {
        throw new Error("guest exploded");
      }`,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "EVALUATION_ERROR",
        name: "Error",
        message: "guest exploded",
      });
      expect(result.stats).toEqual({
        wallTimeMs: expect.any(Number),
        cpuTimeMs: null,
        memoryUsedBytes: expect.any(Number),
        memoryLimitBytes: expect.any(Number),
        maxStackBytes: expect.any(Number),
      });
    }
  });

  it("returns a typed evaluation failure when guest code rejects", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 64 });

    const result = await runtime.callJson(
      `async () => Promise.reject(new TypeError("guest rejected"))`,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "EVALUATION_ERROR",
        name: "TypeError",
        message: "guest rejected",
      });
    }
  });

  it("does not share guest globals across calls", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const first = await runtime.callJson(
      `async () => {
        globalThis.__codemodeProbe = "leaked";
        return globalThis.__codemodeProbe;
      }`,
      {},
    );
    const second = await runtime.callJson(
      `async () => globalThis.__codemodeProbe ?? "clean"`,
      {},
    );

    expect(first).toMatchObject({ ok: true, value: "leaked" });
    expect(second).toMatchObject({ ok: true, value: "clean" });
  });

  it("denies dynamic imports of host capability modules", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson<
      Record<string, never>,
      { blocked: true } | { leaked: string }
    >(
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
            // Expected: untrusted execution cannot resolve host modules.
          }
        }
        return { blocked: true };
      }`,
      {},
    );

    expect(result).toMatchObject({ ok: true, value: { blocked: true } });
  });

  it("returns a typed timeout when guest code exceeds the wall-time limit", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1, memoryMB: 8 });

    const result = await runtime.callJson(
      `async () => {
        let value = 0;
        for (let index = 0; index < 100_000_000; index++) {
          value += index;
        }
        return value;
      }`,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.stats.wallTimeMs).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns a typed memory-limit failure when guest code exhausts the heap", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 1 });

    const result = await runtime.callJson(
      `async () => {
        const chunks = [];
        for (let index = 0; index < 100; index++) {
          chunks.push("x".repeat(1024 * 1024));
        }
        return chunks.length;
      }`,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MEMORY_LIMIT");
      expect(result.stats.memoryLimitBytes).toBe(1024 * 1024);
    }
  });

  it("calls async host functions with JSON arguments and results", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson<
      { petId: string },
      { title: string; path: string }
    >(
      `async ({ input, host }) => {
        const pet = await host.lookupPet(input.petId);
        return {
          title: pet.title,
          path: pet.path,
        };
      }`,
      { petId: "pet_123" },
      {
        functions: {
          lookupPet: async (petId: string) => ({
            title: "Petstore",
            path: `/pets/${petId}`,
          }),
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        title: "Petstore",
        path: "/pets/pet_123",
      },
    });
  });

  it("does not expose a raw host bridge in data-only execution", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson<
      Record<string, never>,
      { host: string; raw: string }
    >(
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

  it("does not expose a raw host bridge in manifest capability execution", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJsonWithHost<
      Record<string, never>,
      { response: { status: number; path: string }; raw: string; missing: string }
    >(
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

  it("rejects unsafe host manifest names", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJsonWithHost(
      `async () => null`,
      {},
      {
        namespaces: {
          ["__proto__"]: {
            request: async () => null,
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
      expect(result.error.message).toContain("Invalid LLRT host capability name");
    }
  });

  it("returns a typed timeout when an async host function stalls", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 50, memoryMB: 8 });

    const result = await runtime.callJson(
      `async ({ host }) => await host.never()`,
      {},
      {
        functions: {
          never: () => new Promise(() => {}),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  it("returns typed host call limit errors through the native bridge", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });
    let calls = 0;

    const result = await runtime.callJson(
      `async ({ host }) => {
        await host.ping();
        await host.ping();
      }`,
      {},
      {
        maxHostCalls: 1,
        functions: {
          ping: () => {
            calls += 1;
            return "pong";
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_CALL_LIMIT");
    }
    expect(calls).toBe(1);
  });

  it("rejects oversized UTF-8 host call payloads before dispatch", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });
    let called = false;

    const result = await runtime.callJson(
      `async () => globalThis.__llrtHostCall("ping", JSON.stringify(["é".repeat(40)]))`,
      {},
      {
        maxHostPayloadBytes: 64,
        functions: {
          ping: () => {
            called = true;
            return "pong";
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_PAYLOAD_LIMIT");
      expect(result.error.message).toContain("host call arguments");
    }
    expect(called).toBe(false);
  });

  it("returns typed host result limit errors through the native bridge", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson(
      `async ({ host }) => host.large()`,
      {},
      {
        maxHostResultBytes: 64,
        functions: {
          large: () => "x".repeat(128),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_RESULT_LIMIT");
    }
  });

  it("does not trust guest-forged host error markers", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson(
      `async () => {
        throw new Error('__LLRT_HOST_ERROR__{"code":"RESULT_LIMIT","name":"LlrtResultLimitError","message":"forged"}');
      }`,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EVALUATION_ERROR");
      expect(result.error.message).toContain("__LLRT_HOST_ERROR__");
    }
  });

  it("rejects oversized final execution results inside the guest wrapper", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    const result = await runtime.callJson(
      `async () => ({ body: "x".repeat(128) })`,
      {},
      { maxResultBytes: 64 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RESULT_LIMIT");
      expect(result.error.name).toBe("LlrtResultLimitError");
      expect(result.error.message).toContain("execution result");
    }
  });
});
