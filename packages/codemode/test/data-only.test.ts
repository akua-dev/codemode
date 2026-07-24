import { describe, expect, it } from "vitest";
import {
  findFunctionPath,
  rejectDataOnlyFunctions,
  rejectDataOnlyTransport,
} from "../src/executor/data-only.js";
import { emptyExecuteStats } from "../src/types.js";
import {
  createCyclicTransportInput,
  createCustomToJSONTransportInput,
  createDepth18TransportFanOut,
  createDepth18TransportNodeFanOut,
} from "./transport-fixtures.js";

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
    expect(findFunctionPath(input)).toBe(
      "input.danger (accessor property is not data-only)",
    );
  });

  it("reports object graphs that exceed the guard limit with their path", () => {
    const input = { entries: Array.from({ length: 100_001 }, () => null) };

    const rejection = rejectDataOnlyFunctions(input, emptyExecuteStats());

    expect(rejection?.error).toBe(
      "data-only execution input graph exceeds 100000 nodes at input.entries[99998]",
    );
    expect(rejection?.error).not.toContain("function values");
    expect(findFunctionPath(input)).toBe("input.entries[99998] (object graph too large)");
  });

  it("checks only present entries in sparse arrays", () => {
    const input: unknown[] = [];
    input.length = 1_000_000;
    input[999_999] = () => "blocked";

    expect(findFunctionPath(input)).toBe("input[999999]");
  });

  it("rejects alias fan-out that exceeds the expanded transport budget", () => {
    const rejection = rejectDataOnlyTransport(
      createDepth18TransportNodeFanOut(),
      emptyExecuteStats(),
    );

    expect(rejection?.error).toMatch(
      /^data-only execution expanded transport graph exceeds 500000 nodes at input\.spec/,
    );
    expect(rejection?.error).not.toContain("function values");
  });

  it("rejects encoded alias fan-out before the occurrence budget", () => {
    const rejection = rejectDataOnlyTransport(
      createDepth18TransportFanOut(),
      emptyExecuteStats(),
    );

    expect(rejection?.error).toMatch(
      /^data-only execution encoded input exceeds 10485760 bytes at input\.spec/,
    );
    expect(rejection?.error).not.toContain("function values");
  });

  it("rejects true cycles before transport marshalling", () => {
    const rejection = rejectDataOnlyTransport(
      createCyclicTransportInput(),
      emptyExecuteStats(),
    );

    expect(rejection?.error).toBe(
      "data-only execution does not accept cyclic object graphs at input.value.self",
    );
  });

  it("rejects custom JSON serialization before invoking it", () => {
    const rejection = rejectDataOnlyTransport(
      createCustomToJSONTransportInput(),
      emptyExecuteStats(),
    );

    expect(rejection?.error).toBe(
      "data-only execution does not accept custom toJSON serialization at input.value.toJSON",
    );
  });

  it("rejects bigint values consistently across JSON transports", () => {
    const rejection = rejectDataOnlyTransport(
      { value: 1n },
      emptyExecuteStats(),
    );

    expect(rejection?.error).toBe(
      "data-only execution does not accept bigint values at input.value",
    );
  });

  it("reuses transport metadata across shared alias occurrences", () => {
    let keyScans = 0;
    const shared = new Proxy(
      { type: "string" },
      {
        ownKeys(target) {
          keyScans += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    const rejection = rejectDataOnlyTransport(
      { aliases: [shared, shared] },
      emptyExecuteStats(),
    );

    expect(rejection).toBeNull();
    expect(keyScans).toBe(2);
  });
});
