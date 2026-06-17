import { afterEach, describe, expect, it } from "vitest";
import { LlrtRuntime } from "../src/index.js";
import { setNativeBindingForTest, type NativeBinding } from "../src/native.js";

const stats = {
  wallTimeMs: 3,
  cpuTimeMs: null,
  memoryUsedBytes: null,
  memoryLimitBytes: null,
  maxStackBytes: null,
};

function nativeResultFromValueJson(
  valueJson: string | undefined,
  options: { errorMarker?: string },
) {
  const errorMarker = options.errorMarker;
  if (errorMarker && valueJson?.startsWith(errorMarker)) {
    return {
      ok: false as const,
      error: JSON.parse(valueJson.slice(errorMarker.length)),
      stats,
    };
  }
  return {
    ok: true as const,
    valueJson: valueJson ?? "null",
    stats,
  };
}

afterEach(() => {
  setNativeBindingForTest(undefined);
});

describe("LlrtRuntime", () => {
  it("passes JSON input to the native binding and parses JSON output", async () => {
    const calls: unknown[] = [];
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      callJson(source, inputJson, options) {
        calls.push({ source, inputJson, options });
        return Promise.resolve({
          ok: true,
          valueJson: JSON.stringify({ title: "Petstore" }),
          stats,
        });
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);

    const runtime = new LlrtRuntime({ wallTimeMs: 1000, memoryMB: 64 });

    const result = await runtime.callJson<
      { spec: { info: { title: string } } },
      { title: string }
    >(
      `async ({ input }) => ({ title: input.spec.info.title })`,
      { spec: { info: { title: "Petstore" } } },
      { wallTimeMs: 50 },
    );

    expect(result).toEqual({
      ok: true,
      value: { title: "Petstore" },
      stats,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      inputJson: JSON.stringify({ spec: { info: { title: "Petstore" } } }),
      options: {
        memoryMb: 64,
        wallTimeMs: 50,
        cpuTimeMs: undefined,
        maxStackBytes: undefined,
          maxHostPayloadBytes: 1024 * 1024,
          maxResultBytes: 10 * 1024 * 1024,
          errorMarker: expect.any(String),
        },
      });
    expect((calls[0] as { source: string }).source).toContain("input.spec.info.title");
  });

  it("rejects raw cpuTimeMs without wallTimeMs because native CPU enforcement is unsupported", async () => {
    const runtime = new LlrtRuntime({ cpuTimeMs: 10 });

    const result = await runtime.callJson(`async () => 1`, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
      expect(result.error.message).toContain("wallTimeMs");
    }
  });

  it("rejects invalid numeric limits before calling native", async () => {
    const calls: unknown[] = [];
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      callJson() {
        calls.push("called");
        return Promise.resolve({
          ok: true,
          valueJson: "null",
          stats,
        });
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);
    const runtime = new LlrtRuntime({ wallTimeMs: Number.POSITIVE_INFINITY });

    const result = await runtime.callJson(`async () => 1`, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
    }
    expect(calls).toEqual([]);
  });

  it("limits host calls before dispatching to native callbacks", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000 });
    let dispatched = 0;
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      async callJson(_source, _inputJson, options, hostDispatcher) {
        await hostDispatcher?.(JSON.stringify({ name: "ping", argsJson: "[]" }));
        const second = await hostDispatcher?.(JSON.stringify({ name: "ping", argsJson: "[]" }));
        return nativeResultFromValueJson(second, options);
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);

    const result = await runtime.callJson(
      `async () => null`,
      {},
      {
        maxHostCalls: 1,
        functions: {
          ping: () => {
            dispatched += 1;
            return "pong";
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_CALL_LIMIT");
    }
    expect(dispatched).toBe(1);
  });

  it("limits UTF-8 host call payload bytes before dispatching host functions", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000 });
    let dispatched = false;
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      async callJson(_source, _inputJson, options, hostDispatcher) {
        const oversizedArgs = JSON.stringify(["é".repeat(40)]);
        const valueJson = await hostDispatcher?.(
          JSON.stringify({ name: "ping", argsJson: oversizedArgs }),
        );
        return nativeResultFromValueJson(valueJson, options);
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);

    const result = await runtime.callJson(
      `async () => null`,
      {},
      {
        maxHostPayloadBytes: 64,
        functions: {
          ping: () => {
            dispatched = true;
            return "pong";
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_PAYLOAD_LIMIT");
    }
    expect(dispatched).toBe(false);
  });

  it("limits host call result bytes", async () => {
    const runtime = new LlrtRuntime({ wallTimeMs: 1000 });
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      async callJson(_source, _inputJson, options, hostDispatcher) {
        const valueJson = await hostDispatcher?.(JSON.stringify({ name: "large", argsJson: "[]" }));
        return nativeResultFromValueJson(valueJson, options);
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);

    const result = await runtime.callJson(
      `async () => null`,
      {},
      {
        maxHostResultBytes: 64,
        functions: {
          large: () => "x".repeat(128),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST_RESULT_LIMIT");
    }
  });

  it("returns a typed serialization failure when input cannot be JSON stringified", async () => {
    const runtime = new LlrtRuntime();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await runtime.callJson(`async () => null`, circular);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SERIALIZATION_ERROR");
      expect(result.error.message).toContain("Converting circular structure");
    }
  });

  it("returns a typed native load failure when no native binding can be loaded", async () => {
    setNativeBindingForTest(null);
    const runtime = new LlrtRuntime();

    const result = await runtime.callJson(`async () => 1`, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NATIVE_LOAD_ERROR");
    }
  });

  it("returns a typed disposed failure without calling native", async () => {
    const calls: unknown[] = [];
    const binding: NativeBinding = {
      nativeSmoke() {
        return "llrt-native-ok";
      },
      callJson() {
        calls.push("called");
        return Promise.resolve({
          ok: true,
          valueJson: "null",
          stats,
        });
      },
      dispose() {},
    };
    setNativeBindingForTest(binding);
    const runtime = new LlrtRuntime();

    runtime.dispose();
    const result = await runtime.callJson(`async () => 1`, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RUNTIME_DISPOSED");
    }
    expect(calls).toEqual([]);
  });
});
