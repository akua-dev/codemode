import type { ExecuteResult, ExecuteStats } from "../types.js";

const MAX_GUARD_NODES = 100_000;

interface PendingNode {
  value: unknown;
  path: string;
}

export function findFunctionPath(value: unknown, path = "input"): string | null {
  const seen = new WeakSet<object>();
  const pending: PendingNode[] = [{ value, path }];
  let checked = 0;
  let queued = 1;

  function checkBudget(nextPath: string): string | null {
    checked += 1;
    return checked > MAX_GUARD_NODES ? `${nextPath} (object graph too large)` : null;
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const budgetError = checkBudget(current.path);
    if (budgetError) return budgetError;
    if (typeof current.value === "function") return current.path;
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
        return `${childPath} (accessor property is not data-only)`;
      }
      queued += 1;
      if (queued > MAX_GUARD_NODES) {
        return `${childPath} (object graph too large)`;
      }
      pending.push({
        value: descriptor.value,
        path: childPath,
      });
    }
  }

  return null;
}

export function dataOnlyFunctionError(functionPath: string): string {
  return `data-only execution does not accept function values at ${functionPath}`;
}

export function rejectDataOnlyFunctions(
  input: Record<string, unknown>,
  stats: ExecuteStats,
): ExecuteResult | null {
  const functionPath = findFunctionPath(input);
  if (!functionPath) return null;

  return {
    result: undefined,
    error: dataOnlyFunctionError(functionPath),
    stats,
  };
}
