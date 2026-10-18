/**
 * ADR-031: the agent-command safety knobs are root-scoped. A package config or
 * package profile that sets one is warned about and ignored. The permissions
 * map (including per-stage bashApproval) and permissionProfile stay
 * per-package: a package's permissions map REPLACES root's, and a stage's
 * rules resolve through that map, so pinning a per-stage mode would change
 * which block a stage's allow/deny come from.
 *
 * A1: the whole `advisor` block is root-only too — the advisor rules on
 * feature-level questions that can span packages (spec §4.13). A5: `workflow` and
 * `execution.mode` are root-only for the same reason (the mode is a run-level switch).
 */
import type { NaxConfig } from "./schema";

export const ROOT_ONLY_EXECUTION_KEYS = [
  "bashApproval",
  "approvalTimeout",
  "sandbox",
  "commandSafety",
  "mode",
] as const;

const ROOT_ONLY = new Set<string>(ROOT_ONLY_EXECUTION_KEYS);

/**
 * The two `context` sub-keys the run's operator owns (US-002): the run-level
 * rules override and the run-level project-context file. They are pinned
 * sub-key by sub-key rather than by replacing the whole `context` block — every
 * other `context.*` key (`v2` above all) is genuinely per-package tunable.
 */
const ROOT_ONLY_CONTEXT_KEYS = ["rules", "projectContext"] as const;

/** Typed form, for callers holding a parsed config (runtime/packages.ts). Silent. */
export function pinRootOnlyKeys(merged: NaxConfig, root: NaxConfig): NaxConfig {
  const { auth: _packageAuth, advisor: _packageAdvisor, workflow: _packageWorkflow, ...rootOnlyMerged } = merged;
  return {
    ...rootOnlyMerged,
    ...(root.auth === undefined ? {} : { auth: root.auth }),
    ...(root.advisor === undefined ? {} : { advisor: root.advisor }),
    ...(root.workflow === undefined ? {} : { workflow: root.workflow }),
    context: {
      ...merged.context,
      rules: root.context.rules,
      projectContext: root.context.projectContext,
    },
    execution: {
      ...merged.execution,
      mode: root.execution.mode,
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
  const { auth: _packageAuth, advisor: _packageAdvisor, workflow: _packageWorkflow, ...rawWithoutAuth } = raw;
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
  // US-002: `context.rules` / `context.projectContext` are pinned individually,
  // so the rest of the package's `context` block (v2, testCoverage, …) survives
  // the merge untouched. A raw config with no `context` key gets none — there is
  // nothing to override, and adding one would put root's values into a layer
  // that never asked for them. The record is total by construction, so a third
  // pinned key cannot be added without giving it a root value here.
  const rawContext = isRecord(raw.context) ? raw.context : null;
  const rootContextValues: Record<(typeof ROOT_ONLY_CONTEXT_KEYS)[number], unknown> = {
    rules: root.context.rules,
    projectContext: root.context.projectContext,
  };
  const pinnedContext: Record<string, unknown> = {};
  for (const key of ROOT_ONLY_CONTEXT_KEYS) {
    if (rawContext !== null && key in rawContext && !Bun.deepEquals(rawContext[key], rootContextValues[key])) {
      onIgnored(`context.${key} is root-only; the value set for package "${packageDir}" is ignored`);
      pinnedContext[key] = rootContextValues[key];
    }
  }
  if (Object.hasOwn(raw, "auth") && !Bun.deepEquals(raw.auth, root.auth)) {
    onIgnored(`auth is root-only; the value set for package "${packageDir}" is ignored`);
  }
  if (Object.hasOwn(raw, "advisor") && !Bun.deepEquals(raw.advisor, root.advisor)) {
    onIgnored(`advisor is root-only; the value set for package "${packageDir}" is ignored`);
  }
  if (Object.hasOwn(raw, "workflow") && !Bun.deepEquals(raw.workflow, root.workflow)) {
    onIgnored(`workflow is root-only; the value set for package "${packageDir}" is ignored`);
  }
  return {
    ...rawWithoutAuth,
    ...(root.auth === undefined ? {} : { auth: root.auth }),
    ...(root.advisor === undefined ? {} : { advisor: root.advisor }),
    ...(root.workflow === undefined ? {} : { workflow: root.workflow }),
    ...(rawContext === null ? {} : { context: { ...rawContext, ...pinnedContext } }),
    execution: { ...rest, ...pinned },
  };
}
