import { describe, it, expect } from "vitest";
import { QuickJSExecutor } from "../src/executor/quickjs.js";
import { executorContract } from "./executor-contract.js";

executorContract(
  "QuickJSExecutor",
  (opts) => new QuickJSExecutor(opts),
  // quickjs OOMs at a lower limit with a tighter loop than V8.
  {
    memoryStress: { memoryMB: 4, iterations: 1_000_000 },
    supportsHostFunctions: false,
  },
);

it("fails closed when host functions are provided", async () => {
  const executor = new QuickJSExecutor({ memoryMB: 8, wallTimeMs: 20 });

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

// ─── Cross-backend tests ────────────────────────────────────────────────────
// These compare BOTH backends side-by-side and therefore cannot live in the
// backend-agnostic contract. They stay here in the quickjs file because that's
// where they were authored when the quickjs backend landed.

describe("ExecuteStats shape parity (QuickJS vs IsolatedVM)", () => {
  it("both executors produce ExecuteStats with the same keys", async () => {
    const IsolatedVMExecutor = await loadIsolatedVMExecutorOrSkip();
    if (!IsolatedVMExecutor) return;
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

  it("returns JSON-safe final values from both backends", async () => {
    const IsolatedVMExecutor = await loadIsolatedVMExecutorOrSkip();
    if (!IsolatedVMExecutor) return;
    const code = `async () => new Date("2026-01-15T00:00:00Z")`;

    const ivmExec = new IsolatedVMExecutor();
    const qjsExec = new QuickJSExecutor();

    const ivmRes = await ivmExec.execute(code, {});
    const qjsRes = await qjsExec.execute(code, {});

    expect(ivmRes.error).toBeUndefined();
    expect(qjsRes.error).toBeUndefined();

    expect(typeof ivmRes.result).toBe("string");
    expect(ivmRes.result).toBe("2026-01-15T00:00:00.000Z");
    expect(typeof qjsRes.result).toBe("string");
    expect(qjsRes.result).toBe("2026-01-15T00:00:00.000Z");
  });
});

async function loadIsolatedVMExecutorOrSkip() {
  try {
    const { IsolatedVMExecutor } = await import("../src/executor/isolated-vm.js");
    const probe = new IsolatedVMExecutor({ memoryMB: 8, wallTimeMs: 1000 });
    await probe.execute(`async () => true`, {});
    return IsolatedVMExecutor;
  } catch {
    return undefined;
  }
}
