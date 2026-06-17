import { describe, expect, it } from "vitest";
import { findFunctionPath } from "../src/executor/data-only.js";

describe("data-only input guard", () => {
  it("rejects accessor properties without invoking them", () => {
    const input = {};
    Object.defineProperty(input, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter should not run");
      },
    });

    expect(findFunctionPath(input)).toContain("accessor property is not data-only");
  });

  it("checks only present entries in sparse arrays", () => {
    const input: unknown[] = [];
    input.length = 1_000_000;
    input[999_999] = () => "blocked";

    expect(findFunctionPath(input)).toBe("input[999999]");
  });
});
