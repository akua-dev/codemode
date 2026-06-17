import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlrtProcessExecutor } from "../src/executor/llrt-process.js";

async function createFakeLlrtBinary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codemode-llrt-"));
  const binary = join(dir, "fake-llrt.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const evalIndex = process.argv.indexOf("-e");
if (evalIndex === -1) {
  console.error("expected -e");
  process.exit(64);
}
const source = process.argv[evalIndex + 1];
try {
  const output = await (0, eval)(source);
  if (output !== undefined) {
    process.stdout.write(String(output));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return binary;
}

describe("LlrtProcessExecutor", () => {
  it("executes JSON-safe async functions through an LLRT-compatible binary", async () => {
    const executor = new LlrtProcessExecutor({ binaryPath: await createFakeLlrtBinary() });

    const result = await executor.execute(
      `async () => ({ ok: true, answer: 42 })`,
      {},
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ ok: true, answer: 42 });
    expect(result.stats.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a structured error when globals are requested", async () => {
    const executor = new LlrtProcessExecutor({ binaryPath: await createFakeLlrtBinary() });

    const result = await executor.execute(
      `async () => spec.info.title`,
      { spec: { info: { title: "API" } } },
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toContain("does not support globals");
  });

  it("executes data-only code with JSON globals", async () => {
    const executor = new LlrtProcessExecutor({ binaryPath: await createFakeLlrtBinary() });

    const result = await executor.executeData(
      `async () => spec.info.title`,
      { spec: { info: { title: "API" } } },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("API");
  });

  it("enforces wall-clock timeout for a stuck process", async () => {
    const executor = new LlrtProcessExecutor({
      binaryPath: await createFakeLlrtBinary(),
      wallTimeMs: 50,
    });

    const result = await executor.execute(
      `async () => { while (true) {} }`,
      {},
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toContain("Wall-clock timeout");
  });
});
