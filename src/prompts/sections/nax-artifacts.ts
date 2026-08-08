/**
 * .nax/ artifact immutability guard.
 *
 * Always-on safety invariant for code-touching prompts. Files under `.nax/`
 * are nax's own artifacts (acceptance scaffolds, plan state, generated acceptance
 * tests) and must never be moved, renamed, or deleted by an agent. The section
 * also clarifies that a `.nax/` test does not replace a source-tree test, and
 * a source-tree test does not justify removing a `.nax/` test.
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

- A test under \`.nax/\` is NOT a reason to skip writing source-tree tests. \`.nax/\` is generated
  scaffolding, not real coverage of the package's code.
- A source-tree test is NOT a reason to remove a test under \`.nax/\`. The two serve different
  purposes and must coexist.`;
}
