import type { ExecuteResult, ExecuteStats } from "../types.js";

const MAX_GUARD_NODES = 100_000;

interface PendingNode {
  value: unknown;
  path: string;
}

type DataOnlyViolation =
  | { kind: "function"; path: string }
  | { kind: "accessor"; path: string }
  | { kind: "graph-too-large"; path: string };

function findDataOnlyViolation(value: unknown, path = "input"): DataOnlyViolation | null {
  const seen = new WeakSet<object>();
  const pending: PendingNode[] = [{ value, path }];
  let checked = 0;
  let queued = 1;

  function checkBudget(nextPath: string): DataOnlyViolation | null {
    checked += 1;
    return checked > MAX_GUARD_NODES ? { kind: "graph-too-large", path: nextPath } : null;
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const budgetError = checkBudget(current.path);
    if (budgetError) return budgetError;
    if (typeof current.value === "function") return { kind: "function", path: current.path };
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

export function findFunctionPath(value: unknown, path = "input"): string | null {
  const violation = findDataOnlyViolation(value, path);
  if (!violation) return null;

  switch (violation.kind) {
    case "function":
      return violation.path;
    case "accessor":
      return `${violation.path} (accessor property is not data-only)`;
    case "graph-too-large":
      return `${violation.path} (object graph too large)`;
  }
}

export function dataOnlyFunctionError(functionPath: string): string {
  return `data-only execution does not accept function values at ${functionPath}`;
}

function dataOnlyViolationError(violation: DataOnlyViolation): string {
  switch (violation.kind) {
    case "function":
      return dataOnlyFunctionError(violation.path);
    case "accessor":
      return `data-only execution does not accept accessor properties at ${violation.path}`;
    case "graph-too-large":
      return `data-only execution input graph exceeds ${MAX_GUARD_NODES} nodes at ${violation.path}`;
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
