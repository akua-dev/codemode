import { describe, it, expect } from "vitest";
import { QuickJSExecutor } from "../src/executor/quickjs.js";
import { executorContract } from "./executor-contract.js";

executorContract(
  "QuickJSExecutor",
  (opts) => new QuickJSExecutor(opts),
  // quickjs OOMs at a lower limit with a tighter loop than V8.
  { memoryStress: { memoryMB: 4, iterations: 1_000_000 } },
);

// ─── Cross-backend tests ────────────────────────────────────────────────────
// These compare BOTH backends side-by-side and therefore cannot live in the
// backend-agnostic contract. They stay here in the quickjs file because that's
// where they were authored when the quickjs backend landed.

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
