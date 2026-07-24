import { describe, expect, it } from "vitest";
import { findFunctionPath, rejectDataOnlyFunctions } from "../src/executor/data-only.js";
import { emptyExecuteStats } from "../src/types.js";

describe("data-only input guard", () => {
  it("reports real function values with their path", () => {
    const rejection = rejectDataOnlyFunctions(
      { callback: () => "blocked" },
      emptyExecuteStats(),
    );

    expect(rejection?.error).toBe(
      "data-only execution does not accept function values at input.callback",
    );
  });

  it("reports accessor properties without invoking them", () => {
    const input = {};
    Object.defineProperty(input, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter should not run");
      },
    });

    const rejection = rejectDataOnlyFunctions(input, emptyExecuteStats());

    expect(rejection?.error).toBe(
      "data-only execution does not accept accessor properties at input.danger",
    );
    expect(rejection?.error).not.toContain("function values");
  });

  it("reports object graphs that exceed the guard limit with their path", () => {
    const input = { entries: Array.from({ length: 100_001 }, () => null) };

    const rejection = rejectDataOnlyFunctions(input, emptyExecuteStats());

    expect(rejection?.error).toBe(
      "data-only execution input graph exceeds 100000 nodes at input.entries[99998]",
    );
    expect(rejection?.error).not.toContain("function values");
  });

  it("checks only present entries in sparse arrays", () => {
    const input: unknown[] = [];
    input.length = 1_000_000;
    input[999_999] = () => "blocked";

    expect(findFunctionPath(input)).toBe("input[999999]");
  });
});
