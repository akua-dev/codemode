import { expect, it } from "vitest";
import { LlrtRuntime } from "../src/index.js";
import { describeWithNativeBinding as describe } from "./native-test-helper.js";

describe("LlrtRuntime stress behavior", () => {
  it("applies per-call memory limits independently of the runtime default", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 32 });

    const result = await runtime.callJson(
      `async () => {
        const chunks = [];
        for (let index = 0; index < 100; index++) {
          chunks.push("x".repeat(1024 * 1024));
        }
        return chunks.length;
      }`,
      {},
      { memoryMB: 1 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MEMORY_LIMIT");
      expect(result.stats.memoryLimitBytes).toBe(1024 * 1024);
    }
  });

  it("keeps repeated executions isolated on one runtime instance", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 8 });

    for (let index = 0; index < 25; index++) {
      // oxlint-disable-next-line no-await-in-loop -- this test intentionally exercises repeated sequential calls on one runtime instance.
      const result = await runtime.callJson<{ index: number }, { index: number; previous: string }>(
        `async ({ input }) => {
          const previous = globalThis.__stressProbe ?? "clean";
          globalThis.__stressProbe = input.index;
          return { index: input.index, previous };
        }`,
        { index },
      );

      expect(result).toMatchObject({
        ok: true,
        value: { index, previous: "clean" },
      });
    }
  });

  it("handles concurrent executions with independent host callback traffic", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 2000, memoryMB: 16 });

    const results = await Promise.all(
      Array.from({ length: 16 }, async (_, index) =>
        runtime.callJson<{ index: number }, { index: number; echoed: number }>(
          `async ({ input, host }) => ({
            index: input.index,
            echoed: await host.echo(input.index),
          })`,
          { index },
          {
            functions: {
              echo: async (value: number) => value,
            },
          },
        ),
      ),
    );

    expect(results).toHaveLength(16);
    for (let index = 0; index < results.length; index++) {
      expect(results[index]).toMatchObject({
        ok: true,
        value: { index, echoed: index },
      });
    }
  });

  it("returns timeout failures for concurrent stalled host callbacks", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 50, memoryMB: 8 });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.callJson(
          `async ({ host }) => await host.never()`,
          {},
          {
            functions: {
              never: () => new Promise(() => {}),
            },
          },
        ),
      ),
    );

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    }
  });
});
