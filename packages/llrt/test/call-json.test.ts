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
});
