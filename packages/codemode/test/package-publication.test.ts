import { describe, expect, it } from "vitest";
import codemodePackageJson from "../package.json" with { type: "json" };

describe("codemode package publication", () => {
  it("publishes the LLRT executor release with a compatible optional peer range", () => {
    expect(codemodePackageJson.version).toMatch(/^(?!0\.2\.0$)\d+\.\d+\.\d+(?:[-+].*)?$/);
    expect(codemodePackageJson.peerDependencies["@robinbraemer/llrt"]).toBe("^0.1.0");
    expect(codemodePackageJson.devDependencies["@robinbraemer/llrt"]).toBe("workspace:*");
  });
});
