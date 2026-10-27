/**
 * The fixed "nax loop" section a chat session carries: the workflow order, when
 * to read feature state, which steps are billed launches, and what nax never does.
 *
 * Pure fixed text — no config, no file reads, no model calls.
 */
export function buildWorkflowInstructions(): string {
  return [
    "Call `nax-workflow__state` before proposing any workflow step, and call it again after any workflow step ends, so what you propose matches the feature's real state.",
    "The nax loop runs in this order: brainstorm → spec-writing → spec-review (at most two fix rounds) → `nax plan` → PRD fidelity check (spec-review `--prd`) → commit the spec and PRD → `nax run` → `nax bot review` / `nax bot fix` → the user merges → the user releases.",
    "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without the user's explicit approval of that launch.",
    "nax never merges a PR and never releases; the user merges the PR and the user releases.",
  ].join("\n");
}
