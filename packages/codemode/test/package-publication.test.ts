import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import codemodePackageJson from "../package.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const publishWorkflowPath = join(root, ".github/workflows/publish.yml");

describe("codemode package publication", () => {
  it("publishes the LLRT executor release with a compatible optional peer range", () => {
    expect(codemodePackageJson.version).toMatch(/^(?!0\.2\.0$)\d+\.\d+\.\d+(?:[-+].*)?$/);
    expect(codemodePackageJson.peerDependencies["@robinbraemer/llrt"]).toBe("^0.1.0");
    expect(codemodePackageJson.devDependencies["@robinbraemer/llrt"]).toBe("workspace:*");
  });

  it("publishes from the package directory with the npm CLI", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8");

    expect(workflow).toContain("run: npm publish --access public");
    expect(workflow).toContain("working-directory: packages/codemode");
    expect(workflow).not.toContain("pnpm --filter @robinbraemer/codemode publish");
    expect(workflow).not.toContain("--no-git-checks");
  });
});
