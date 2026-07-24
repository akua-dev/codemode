export function createDepth18TransportFanOut(): Record<string, unknown> {
  let schema: Record<string, unknown> = {
    type: "string",
    description: "x".repeat(35),
  };

  for (let depth = 0; depth < 18; depth += 1) {
    schema = { left: schema, right: schema };
  }

  return { spec: schema };
}

export function createDepth18TransportNodeFanOut(): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };

  for (let depth = 0; depth < 18; depth += 1) {
    schema = { left: schema, right: schema };
  }

  return { spec: schema };
}

export function createCyclicTransportInput(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return { value };
}

export function createCustomToJSONTransportInput(): Record<string, unknown> {
  class CustomJSONValue {
    toJSON(): never {
      throw new Error("custom toJSON should not run");
    }
  }

  return { value: new CustomJSONValue() };
}
