/**
 * Agent-friendly output env for nax's own agent-facing spawn sites.
 *
 * `AGENT_OUTPUT_MARKERS` / `withAgentOutputEnv` are the rule the quality and
 * verification runners already share; this module is where they live so the
 * other spawn sites (Bash, RunCommand's Exec branch) can apply the identical
 * rule instead of a second copy of it. `src/verification/executor.ts`
 * re-exports both, so `src/quality/runner.ts` keeps importing them unchanged.
 */

/**
 * Env vars that tell an agent-aware test runner to emit failures-only output.
 * `bun test` honours all three (https://bun.com/docs/test): failures keep their
 * full code frame, diff and stack, and the summary line is preserved — only the
 * per-test pass/skip/todo roll call is dropped.
 *
 * Exported so the quality runner applies the identical rule at its own spawn
 * site; the two env paths must not drift.
 */
export const AGENT_OUTPUT_MARKERS = ["CLAUDECODE", "REPL_ID", "AGENT"] as const;

/**
 * Add `AGENT=1` unless a marker is already present or the caller stripped it.
 */
export function withAgentOutputEnv(
  env: Record<string, string | undefined>,
  strippedVars: readonly string[] = [],
): Record<string, string | undefined> {
  if (strippedVars.includes("AGENT")) return env;
  if (AGENT_OUTPUT_MARKERS.some((marker) => env[marker] !== undefined)) return env;
  return { ...env, AGENT: "1" };
}

/** Where marker presence is read from; tests replace it. */
export const _agentOutputEnvDeps = {
  processEnv: (): Record<string, string | undefined> => process.env,
};

/**
 * `{ AGENT: "1" }`, or undefined when a marker is already inherited or AGENT
 * is stripped.
 *
 * The spawn sites here overlay a small record onto the child's inherited
 * environment rather than normalizing a whole env, so "no overlay" has to be
 * distinguishable from "an empty overlay": undefined means the caller passes
 * no `env` key at all and the child inherits `process.env` untouched.
 *
 * STUB (US-004): the marker rule lands with the implementation session.
 */
export function agentOutputOverlay(strippedVars: readonly string[]): Readonly<Record<string, string>> | undefined {
  void strippedVars;
  return undefined;
}
