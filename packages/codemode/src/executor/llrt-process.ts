import { spawn } from "node:child_process";
import type { Executor, ExecuteResult, ExecuteStats, SandboxOptions } from "../types.js";
import { rejectDataOnlyFunctions } from "./data-only.js";

export interface LlrtProcessExecutorOptions extends SandboxOptions {
  binaryPath?: string;
}

/**
 * Experimental LLRT process executor.
 *
 * This is intentionally a JSON-safe POC, not the production backend. It proves
 * that codemode can drive an LLRT-compatible runtime and collect the same
 * high-level ExecuteResult shape before we invest in a native napi-rs addon.
 */
export class LlrtProcessExecutor implements Executor {
  private readonly binaryPath: string;
  private readonly wallTimeMs: number;

  constructor(options: LlrtProcessExecutorOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.LLRT_BINARY ?? "llrt";
    this.wallTimeMs = options.wallTimeMs ?? 60_000;
  }

  async execute(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    if (Object.keys(globals).length > 0) {
      return {
        result: undefined,
        error: "LlrtProcessExecutor POC does not support globals or host callbacks yet",
        stats: captureStats(Date.now()),
      };
    }

    return await this.executeProcess(code, {});
  }

  private async executeProcess(
    code: string,
    globals: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    const start = Date.now();

    try {
      const stdout = await runLlrt(this.binaryPath, wrapCode(code, globals), this.wallTimeMs);
      const encoded = lastJsonLine(stdout);
      const envelope = JSON.parse(encoded) as
        | { ok: true; value?: unknown }
        | { ok: false; error: string };

      if (!envelope.ok) {
        return {
          result: undefined,
          error: envelope.error,
          stats: captureStats(start),
        };
      }

      return {
        result: envelope.value,
        stats: captureStats(start),
      };
    } catch (err) {
      return {
        result: undefined,
        error: err instanceof Error ? err.message : String(err),
        stats: captureStats(start),
      };
    }
  }

  async executeData(
    code: string,
    input: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    const rejection = rejectDataOnlyFunctions(input, captureStats(Date.now()));
    if (rejection) return rejection;

    return await this.executeProcess(code, input);
  }
}

function wrapCode(code: string, globals: Record<string, unknown>): string {
  const globalsJson = JSON.stringify(globals);
  return `
(async () => {
  try {
    Object.assign(globalThis, ${globalsJson});
    const value = await (${code})();
    console.log(JSON.stringify({ ok: true, value }));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
})()
`;
}

async function runLlrt(
  binaryPath: string,
  source: string,
  wallTimeMs: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binaryPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Wall-clock timeout exceeded after ${wallTimeMs}ms`));
    }, wallTimeMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout);
        return;
      }

      const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? "unknown"}`;
      reject(new Error(`LLRT process exited with code ${code ?? "null"}: ${detail}`));
    });
  });
}

function lastJsonLine(stdout: string): string {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .findLast((entry) => entry.length > 0);
  if (!line) {
    throw new Error("LLRT process produced no JSON result");
  }
  return line;
}

function captureStats(start: number): ExecuteStats {
  const wallTimeMs = Date.now() - start;
  return {
    cpuTimeMs: wallTimeMs,
    wallTimeMs,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    heapSizeLimitBytes: 0,
    totalPhysicalBytes: 0,
    availableBytes: 0,
    executableBytes: 0,
    mallocedBytes: 0,
    peakMallocedBytes: 0,
  };
}
