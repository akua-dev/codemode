import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(packageRoot, "README.md"), "utf8");

describe("LLRT package publication docs", () => {
  it("uses a publishable initial package and native crate version", () => {
    const cargoToml = readFileSync(join(packageRoot, "native", "Cargo.toml"), "utf8");
    const cargoPackageVersion = cargoToml.match(
      /\[package]\s+name = "llrt_node"\s+version = "([^"]+)"/,
    )?.[1];

    expect(packageJson.version).toMatch(/^(?!0\.0\.0$)\d+\.\d+\.\d+(?:[-+].*)?$/);
    expect(packageJson.version).not.toBe("0.0.0");
    expect(cargoPackageVersion).toBe(packageJson.version);
  });

  it("documents install, supported native packages, Node support, and unsupported runtimes", () => {
    expect(readme).toContain("npm install @robinbraemer/llrt");
    expect(readme).toContain("Node.js 24");
    expect(readme).toContain("Unsupported runtimes");
    expect(readme).toContain("Bun");
    expect(readme).toContain("Cloudflare Workers");
    expect(readme).toContain("browser");

    for (const target of packageJson.napi.targets) {
      expect(readme).toContain(target);
    }
  });

  it("documents the runtime contract and safety boundaries", () => {
    expect(readme).toContain("JSON-safe");
    expect(readme).toContain("fresh LLRT VM");
    expect(readme).toContain("Host functions");
    expect(readme).toContain("memoryMB");
    expect(readme).toContain("wallTimeMs");
    expect(readme).toContain("does not expose filesystem, process, require, or fetch");
  });

  it("ships the license file named in package files", () => {
    expect(packageJson.files).toContain("LICENSE");
    expect(existsSync(join(packageRoot, "LICENSE"))).toBe(true);
  });
});
