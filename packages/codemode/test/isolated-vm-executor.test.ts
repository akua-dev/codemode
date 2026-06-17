import { expect, it } from "vitest";
import { IsolatedVMExecutor } from "../src/executor/isolated-vm.js";
import { executorContract } from "./executor-contract.js";

executorContract(
  "IsolatedVMExecutor",
  (opts) => new IsolatedVMExecutor(opts),
  { supportsHostFunctions: false },
);

it("fails closed when host functions are provided", async () => {
  const executor = new IsolatedVMExecutor({ memoryMB: 8, wallTimeMs: 20 });

  const result = await executor.execute(
    `async () => {
      await api.request({ path: "/slow" });
    }`,
    {
      api: {
        request: async function (
          this: { signal?: AbortSignal },
          _request: { path: string },
        ) {
          return { status: 499, body: { aborted: true } };
        },
      },
    },
  );

  expect(result.error).toContain("does not support host functions");
});
