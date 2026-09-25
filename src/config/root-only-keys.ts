/**
 * ADR-031: the agent-command safety knobs are root-scoped. A package config or
 * package profile that sets one is warned about and ignored. The permissions
 * map (including per-stage bashApproval) and permissionProfile stay
 * per-package: a package's permissions map REPLACES root's, and a stage's
 * rules resolve through that map, so pinning a per-stage mode would change
 * which block a stage's allow/deny come from.
 */
import type { NaxConfig } from "./schema";

export const ROOT_ONLY_EXECUTION_KEYS = ["bashApproval", "approvalTimeout", "sandbox", "commandSafety"] as const;

const ROOT_ONLY = new Set<string>(ROOT_ONLY_EXECUTION_KEYS);

/** Typed form, for callers holding a parsed config (runtime/packages.ts). Silent. */
export function pinRootOnlyKeys(merged: NaxConfig, root: NaxConfig): NaxConfig {
  return {
    ...merged,
    execution: {
      ...merged.execution,
      bashApproval: root.execution.bashApproval,
      approvalTimeout: root.execution.approvalTimeout,
      sandbox: root.execution.sandbox,
      commandSafety: root.execution.commandSafety,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw form, for loadConfigForWorkdir before safeParse. Warns per differing key. */
export function pinRootOnlyKeysRaw(
  raw: Record<string, unknown>,
  root: NaxConfig,
  packageDir: string,
  onIgnored: (msg: string) => void,
): Record<string, unknown> {
  const execution = isRecord(raw.execution) ? raw.execution : {};
  const rootExecution: Record<string, unknown> = { ...root.execution };
  for (const key of ROOT_ONLY_EXECUTION_KEYS) {
    if (key in execution && !Bun.deepEquals(execution[key], rootExecution[key])) {
      onIgnored(`execution.${key} is root-only (ADR-031); the value set for package "${packageDir}" is ignored`);
    }
  }
  const rest = Object.fromEntries(Object.entries(execution).filter(([k]) => !ROOT_ONLY.has(k)));
  const pinned = Object.fromEntries(
    ROOT_ONLY_EXECUTION_KEYS.flatMap((k) => (rootExecution[k] === undefined ? [] : [[k, rootExecution[k]]])),
  );
  return { ...raw, execution: { ...rest, ...pinned } };
}
