/**
 * Deterministic classifier for acceptance-test crashes (stub).
 *
 * A run that exits non-zero with no `AC-N`-tagged failure is either
 * `expected-red` (the acceptance file references a symbol the feature has not
 * created yet — the RED gate should see it) or `repairable` (anything else,
 * including a broken load the acceptance-repair op can fix).
 */

export type AcceptanceCrashClass = "expected-red" | "repairable";

export function classifyAcceptanceCrash(_output: string, _language: string | undefined): AcceptanceCrashClass {
  return "repairable";
}
