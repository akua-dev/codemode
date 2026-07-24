import type { ExecuteResult, ExecuteStats } from "../types.js";

const MAX_GUARD_NODES = 100_000;
// The largest representative pre-resolved OpenAPI fixture expands to 303,708
// transport occurrences and 4,354,110 JSON bytes. These ceilings preserve that
// workload while rejecting alias fan-out before a built-in executor recreates
// a much larger tree (the depth-18 regression expands past 1M occurrences and
// 22.8 MB).
const MAX_TRANSPORT_NODES = 500_000;
const MAX_TRANSPORT_BYTES = 10 * 1024 * 1024;

interface PendingNode {
  value: unknown;
  path: string;
}

type StructuralDataOnlyViolation =
  | { kind: "function"; path: string }
  | { kind: "accessor"; path: string }
  | { kind: "graph-too-large"; path: string };

export type DataOnlyViolation =
  | StructuralDataOnlyViolation
  | { kind: "transport-graph-too-large"; path: string }
  | { kind: "transport-bytes-too-large"; path: string }
  | { kind: "cyclic"; path: string }
  | { kind: "custom-to-json"; path: string }
  | { kind: "bigint"; path: string };

export function findDataOnlyViolation(
  value: unknown,
  path = "input",
): StructuralDataOnlyViolation | null {
  return findStructuralDataOnlyViolation(value, path, false);
}

function findStructuralDataOnlyViolation(
  value: unknown,
  path: string,
  allowFunctions: boolean,
): StructuralDataOnlyViolation | null {
  const seen = new WeakSet<object>();
  const pending: PendingNode[] = [{ value, path }];
  let checked = 0;
  let queued = 1;

  function checkBudget(nextPath: string): StructuralDataOnlyViolation | null {
    checked += 1;
    return checked > MAX_GUARD_NODES ? { kind: "graph-too-large", path: nextPath } : null;
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const budgetError = checkBudget(current.path);
    if (budgetError) return budgetError;
    if (typeof current.value === "function") {
      if (!allowFunctions) return { kind: "function", path: current.path };
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    for (const key in current.value) {
      if (!Object.prototype.propertyIsEnumerable.call(current.value, key)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor) continue;
      const childPath =
        Array.isArray(current.value) && String(Number(key)) === key
          ? `${current.path}[${key}]`
          : `${current.path}.${key}`;
      if (!("value" in descriptor)) {
        return { kind: "accessor", path: childPath };
      }
      queued += 1;
      if (queued > MAX_GUARD_NODES) {
        return { kind: "graph-too-large", path: childPath };
      }
      pending.push({
        value: descriptor.value,
        path: childPath,
      });
    }
  }

  return null;
}

interface TransportGuardOptions {
  allowFunctions?: boolean;
}

interface VisitTransportNode {
  kind: "visit";
  value: unknown;
  path: string;
  arrayElement: boolean;
}

interface LeaveTransportNode {
  kind: "leave";
  value: object;
}

interface VisitArrayEntries {
  kind: "array";
  value: unknown[];
  path: string;
  index: number;
}

interface VisitObjectEntries {
  kind: "object";
  value: Record<string, unknown>;
  path: string;
  keys: string[];
  index: number;
  emittedProperty: boolean;
}

type TransportFrame =
  | VisitTransportNode
  | LeaveTransportNode
  | VisitArrayEntries
  | VisitObjectEntries;

export function findDataOnlyTransportViolation(
  value: unknown,
  path = "input",
  options: TransportGuardOptions = {},
): DataOnlyViolation | null {
  const structuralViolation = findStructuralDataOnlyViolation(
    value,
    path,
    options.allowFunctions ?? false,
  );
  if (structuralViolation) return structuralViolation;

  const active = new WeakSet<object>();
  const jsonSerializationIssues = new WeakMap<object, JSONSerializationIssue | null>();
  const keysByObject = new WeakMap<object, string[]>();
  const bytesByString = new Map<string, number>();
  const pending: TransportFrame[] = [{
    kind: "visit",
    value,
    path,
    arrayElement: false,
  }];
  let nodes = 0;
  let bytes = 0;

  function addNode(nextPath: string): DataOnlyViolation | null {
    nodes += 1;
    return nodes > MAX_TRANSPORT_NODES
      ? { kind: "transport-graph-too-large", path: nextPath }
      : null;
  }

  function addBytes(amount: number, nextPath: string): DataOnlyViolation | null {
    bytes += amount;
    return bytes > MAX_TRANSPORT_BYTES
      ? { kind: "transport-bytes-too-large", path: nextPath }
      : null;
  }

  function encodedStringBytes(input: string): number {
    const cached = bytesByString.get(input);
    if (cached !== undefined) return cached;
    const encodedBytes = jsonStringByteLength(input);
    bytesByString.set(input, encodedBytes);
    return encodedBytes;
  }

  function objectKeys(input: object): string[] {
    const cached = keysByObject.get(input);
    if (cached) return cached;
    const keys = Object.keys(input);
    keysByObject.set(input, keys);
    return keys;
  }

  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;

    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }

    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) continue;

      const childPath = `${frame.path}[${frame.index}]`;
      const commaError = addBytes(frame.index === 0 ? 0 : 1, childPath);
      if (commaError) return commaError;

      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        String(frame.index),
      );
      if (descriptor && !("value" in descriptor)) {
        return { kind: "accessor", path: childPath };
      }

      pending.push({ ...frame, index: frame.index + 1 });
      pending.push({
        kind: "visit",
        value: descriptor?.value,
        path: childPath,
        arrayElement: true,
      });
      continue;
    }

    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) continue;

      const key = frame.keys[frame.index]!;
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      const nextFrame = { ...frame, index: frame.index + 1 };
      if (!descriptor) {
        pending.push(nextFrame);
        continue;
      }

      const childPath = `${frame.path}.${key}`;
      if (!("value" in descriptor)) {
        return { kind: "accessor", path: childPath };
      }
      if (
        descriptor.value === undefined ||
        typeof descriptor.value === "function" ||
        typeof descriptor.value === "symbol"
      ) {
        pending.push(nextFrame);
        continue;
      }

      const propertyBytes =
        (frame.emittedProperty ? 1 : 0) + encodedStringBytes(key) + 1;
      const propertyError = addBytes(propertyBytes, childPath);
      if (propertyError) return propertyError;

      pending.push({ ...nextFrame, emittedProperty: true });
      pending.push({
        kind: "visit",
        value: descriptor.value,
        path: childPath,
        arrayElement: false,
      });
      continue;
    }

    const nodeError = addNode(frame.path);
    if (nodeError) return nodeError;

    if (
      frame.value === undefined ||
      typeof frame.value === "function" ||
      typeof frame.value === "symbol"
    ) {
      const omittedValueError = addBytes(frame.arrayElement ? 4 : 0, frame.path);
      if (omittedValueError) return omittedValueError;
      continue;
    }
    if (frame.value === null) {
      const nullError = addBytes(4, frame.path);
      if (nullError) return nullError;
      continue;
    }
    if (typeof frame.value === "string") {
      const stringError = addBytes(encodedStringBytes(frame.value), frame.path);
      if (stringError) return stringError;
      continue;
    }
    if (typeof frame.value === "number") {
      const numberError = addBytes(
        Number.isFinite(frame.value) ? String(frame.value).length : 4,
        frame.path,
      );
      if (numberError) return numberError;
      continue;
    }
    if (typeof frame.value === "boolean") {
      const booleanError = addBytes(frame.value ? 4 : 5, frame.path);
      if (booleanError) return booleanError;
      continue;
    }
    if (typeof frame.value === "bigint") {
      return { kind: "bigint", path: frame.path };
    }

    const jsonSerializationIssue = findJSONSerializationIssue(
      frame.value,
      jsonSerializationIssues,
    );
    if (jsonSerializationIssue) {
      return { kind: jsonSerializationIssue, path: `${frame.path}.toJSON` };
    }
    if (active.has(frame.value)) {
      return { kind: "cyclic", path: frame.path };
    }
    active.add(frame.value);

    const delimitersError = addBytes(2, frame.path);
    if (delimitersError) return delimitersError;
    pending.push({ kind: "leave", value: frame.value });
    if (Array.isArray(frame.value)) {
      pending.push({
        kind: "array",
        value: frame.value,
        path: frame.path,
        index: 0,
      });
    } else {
      pending.push({
        kind: "object",
        value: frame.value as Record<string, unknown>,
        path: frame.path,
        keys: objectKeys(frame.value),
        index: 0,
        emittedProperty: false,
      });
    }
  }

  return null;
}

type JSONSerializationIssue = "accessor" | "custom-to-json";

function findJSONSerializationIssue(
  value: object,
  cache: WeakMap<object, JSONSerializationIssue | null>,
): JSONSerializationIssue | null {
  if (cache.has(value)) return cache.get(value) ?? null;

  let issue: JSONSerializationIssue | null;
  if (hasNativeDateToJSON(value)) {
    issue = null;
  } else {
    const descriptor = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (descriptor) {
      issue = !("value" in descriptor)
        ? "accessor"
        : typeof descriptor.value === "function"
          ? "custom-to-json"
          : null;
    } else {
      const prototype = Object.getPrototypeOf(value) as object | null;
      issue = prototype ? findJSONSerializationIssue(prototype, cache) : null;
    }
  }
  cache.set(value, issue);
  return issue;
}

function hasNativeDateToJSON(value: object): boolean {
  try {
    Date.prototype.getTime.call(value);
  } catch {
    return false;
  }

  let current: object | null = value;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (descriptor) {
      return "value" in descriptor && descriptor.value === Date.prototype.toJSON;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return false;
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit < 0x20) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function dataOnlyFunctionError(functionPath: string): string {
  return `data-only execution does not accept function values at ${functionPath}`;
}

export function dataOnlyViolationError(violation: DataOnlyViolation): string {
  switch (violation.kind) {
    case "function":
      return dataOnlyFunctionError(violation.path);
    case "accessor":
      return `data-only execution does not accept accessor properties at ${violation.path}`;
    case "graph-too-large":
      return `data-only execution input graph exceeds ${MAX_GUARD_NODES} nodes at ${violation.path}`;
    case "transport-graph-too-large":
      return `data-only execution expanded transport graph exceeds ${MAX_TRANSPORT_NODES} nodes at ${violation.path}`;
    case "transport-bytes-too-large":
      return `data-only execution encoded input exceeds ${MAX_TRANSPORT_BYTES} bytes at ${violation.path}`;
    case "cyclic":
      return `data-only execution does not accept cyclic object graphs at ${violation.path}`;
    case "custom-to-json":
      return `data-only execution does not accept custom toJSON serialization at ${violation.path}`;
    case "bigint":
      return `data-only execution does not accept bigint values at ${violation.path}`;
  }
}

export function rejectDataOnlyFunctions(
  input: Record<string, unknown>,
  stats: ExecuteStats,
): ExecuteResult | null {
  const violation = findDataOnlyViolation(input);
  if (!violation) return null;

  return {
    result: undefined,
    error: dataOnlyViolationError(violation),
    stats,
  };
}

export function rejectDataOnlyTransport(
  input: Record<string, unknown>,
  stats: ExecuteStats,
): ExecuteResult | null {
  const violation = findDataOnlyTransportViolation(input);
  if (!violation) return null;

  return {
    result: undefined,
    error: dataOnlyViolationError(violation),
    stats,
  };
}
