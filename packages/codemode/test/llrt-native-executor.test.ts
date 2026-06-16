import { expect, it } from "vitest";
import { LlrtNativeExecutor } from "../src/executor/llrt-native.js";
import { executorContract } from "./executor-contract.js";
import {
  describeWithLlrtNativeBinding as describe,
  llrtNativeBindingAvailable,
} from "./llrt-native-test-helper.js";
import type { LlrtHostCallContext } from "@robinbraemer/llrt";

if (llrtNativeBindingAvailable) {
  executorContract(
    "LlrtNativeExecutor",
    (opts) => new LlrtNativeExecutor(opts),
    { memoryStress: { memoryMB: 1, iterations: 100_000 } },
  );
} else {
  describe.skip("LlrtNativeExecutor", () => {
    it("requires a built LLRT native binding", () => {});
  });
}

describe("LlrtNativeExecutor", () => {
  it("executes code with JSON-safe globals through the native LLRT runtime", async () => {
    const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 1000 });

    const result = await executor.execute(
      `async () => spec.info.title.toUpperCase()`,
      { spec: { info: { title: "Petstore" } } },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("PETSTORE");
    expect(result.stats.heapSizeLimitBytes).toBe(8 * 1024 * 1024);
  });

  it("returns runtime errors as ExecuteResult errors", async () => {
    const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 1000 });

    const result = await executor.execute(
      `async () => { throw new Error("guest exploded"); }`,
      {},
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toContain("guest exploded");
  });

  it("executes async host functions in namespaces", async () => {
    const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 1000 });

    const result = await executor.execute(
      `async () => {
        const response = await api.request({ path: "/v1/pets" });
        return response.body;
      }`,
      {
        api: {
          request: async (request: { path: string }) => ({
            status: 200,
            body: { title: "Petstore", path: request.path },
          }),
        },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ title: "Petstore", path: "/v1/pets" });
  });

  it("does not expose host call context as a guest argument", async () => {
    const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 1000 });

    const result = await executor.execute(
      `async () => countArgs("a", "b")`,
      { countArgs: (...args: unknown[]) => args.length },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(2);
  });

  it("aborts in-flight host functions when execution times out", async () => {
    const executor = new LlrtNativeExecutor({ memoryMB: 8, wallTimeMs: 20 });
    let sawAbortSignal = false;
    let resolveAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });

    const result = await executor.execute(
      `async () => {
        await api.request({ path: "/slow" });
      }`,
      {
        api: {
          request: async function (
            this: LlrtHostCallContext,
            _request: { path: string },
          ) {
            if (!this.signal) {
              throw new Error("missing abort signal");
            }
            sawAbortSignal = true;
            await new Promise<void>((resolve) => {
              this.signal.addEventListener("abort", resolve, { once: true });
            });
            resolveAborted?.();
            return { status: 499, body: { aborted: true } };
          },
        },
      },
    );

    expect(result.error).toContain("Wall-clock timeout exceeded");
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("host function was not aborted")), 100);
      }),
    ]);
    expect(sawAbortSignal).toBe(true);
  });
});
