import { expect, it } from "vitest";
import { LlrtNativeExecutor } from "../src/executor/llrt-native.js";
import { executorContract } from "./executor-contract.js";
import {
  describeWithLlrtNativeBinding as describe,
  llrtNativeBindingAvailable,
} from "./llrt-native-test-helper.js";

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
});
