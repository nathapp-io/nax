/**
 * .nax/ artifact immutability guard.
 *
 * Always-on safety invariant for code-touching prompts. Files under `.nax/`
 * are nax's own artifacts (acceptance scaffolds, plan state, generated acceptance
 * tests) and must never be moved, renamed, or deleted by an agent. The section
 * also clarifies that a `.nax/` test does not replace a source-tree test, and
 * a source-tree test does not justify removing a `.nax/` test.
 *
 * `.nax/scratchpad/` is named as the one exception — without it the prohibition
 * reads as absolute and contradicts the scratchpad tools' invitation to write
 * there (see `./scratchpad.ts`). It is an exception to *modifying*, not to
 * moving/renaming/deleting the other artifacts, so the standing rule still holds.
 *
 * Mirrors `buildBehavioralGuardrailsSection`'s signature for the role arg
 * and accepts (but currently ignores) `_variant` / `_isolation` so future
 * rule differentiation stays signature-compatible.
 */

import type { GuardrailRole } from "./behavioral-guardrails";

export function buildNaxArtifactsSection(
  role: GuardrailRole,
  // Reserved for future per-variant / per-isolation rule differentiation.
  // Currently unused — all variants/isolation modes produce identical output per role.
  _variant?: "standard" | "lite",
  _isolation?: "strict" | "lite",
): string {
  void role;
  return `# .nax/ artifact immutability

Files under \`.nax/\` are nax's own artifacts (acceptance scaffolds, plan state, generated acceptance
tests). They must NEVER be moved, renamed, or deleted — \`.nax/\` is a tool-managed directory and
modifying it breaks the orchestrator.

The one exception is \`.nax/scratchpad/\` — a throwaway directory you may write to and overwrite
freely. Every other path under \`.nax/\` stays off limits.

- A test under \`.nax/\` is NOT a reason to skip writing source-tree tests. \`.nax/\` is generated
  scaffolding, not real coverage of the package's code.
- A source-tree test is NOT a reason to remove a test under \`.nax/\`. The two serve different
  purposes and must coexist.

nax updates \`.nax/features/<feature>/prd.json\` itself during a run, so it shows as modified in
\`git status\`. Do not diff or revert it: this story's criteria are already in this prompt, and if you
need its contents, read it with the \`Read\` tool. Shell commands that name it may be refused.`;
}
