import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = join(root, ".github/workflows/llrt-native.yml");

function getNamedStep(workflow: string, stepName: string) {
  const marker = `- name: ${stepName}`;
  const stepStart = workflow.indexOf(marker);
  expect(stepStart).toBeGreaterThanOrEqual(0);

  const nextStepStart = workflow.indexOf("\n      - ", stepStart + marker.length);
  return workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart);
}

describe("LLRT native prebuild workflow", () => {
  it("builds every napi target declared by the package manifest", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    for (const target of packageJson.napi.targets) {
      expect(workflow).toContain(`target: ${target}`);
    }
  });

  it("uses explicit runner labels for each supported native target", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("runner: macos-15");
    expect(workflow).toContain("runner: macos-15-intel");
    expect(workflow).toContain("runner: ubuntu-24.04");
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
  });

  it("packages artifacts before publishing the LLRT package family", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const mainPublishStep = getNamedStep(workflow, "Publish main LLRT package");

    expect(workflow).toContain("pnpm --filter @robinbraemer/llrt run create:native-packages");
    expect(workflow).toContain("pnpm --filter @robinbraemer/llrt run prepare:native-publish");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).not.toContain("--no-git-checks");
    expect(mainPublishStep).toContain("run: npm publish --access public");
    expect(mainPublishStep).toContain("working-directory: packages/llrt");
    expect(workflow).not.toContain(
      "pnpm --filter @robinbraemer/llrt publish --access public",
    );
  });

  it("installs only the LLRT workspace in native packaging jobs", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const scopedInstallMatches = workflow.match(
      /pnpm install --filter @robinbraemer\/llrt\.\.\./g,
    );

    expect(scopedInstallMatches).toHaveLength(2);
    expect(workflow).not.toContain("task install");
  });

  it("passes the native build target through an explicit environment variable", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(packageJson.scripts["build:native:target"]).toBe("node scripts/build-native-target.mjs");
    expect(workflow).toContain("LLRT_TARGET: ${{ matrix.target }}");
    expect(workflow).toContain("pnpm --filter @robinbraemer/llrt run build:native:target");
    expect(workflow).not.toContain("run build:native:target -- --target");
  });

  it("smoke-tests a consumer install from packed main and native tarballs", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const smokeCommand = "pnpm --filter @robinbraemer/llrt run smoke:packed-install";

    expect(packageJson.scripts["smoke:packed-install"]).toBe(
      "node scripts/smoke-packed-install.mjs",
    );
    expect(workflow).toContain(smokeCommand);
    expect([...workflow.matchAll(new RegExp(smokeCommand, "g"))]).toHaveLength(2);
  });

  it("verifies native package manifests locally and downloaded native artifacts in CI", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(packageJson.scripts["verify:native-artifacts"]).toBe(
      "node scripts/verify-native-artifacts.mjs",
    );
    expect(packageJson.scripts["verify:native-artifacts:strict"]).toBe(
      "node scripts/verify-native-artifacts.mjs --require-binaries",
    );
    expect(workflow).toContain("pnpm --filter @robinbraemer/llrt run verify:native-artifacts");
    expect(workflow).toContain(
      "pnpm --filter @robinbraemer/llrt run verify:native-artifacts:strict",
    );
  });

  it("does not rebuild native binaries in the main package prepublish hook", () => {
    expect(packageJson.scripts.prepublishOnly).not.toContain("build:native");
  });
});
