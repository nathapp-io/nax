/**
 * Debate Persona System — Phase 2
 *
 * Provides curated analytical lenses for debaters to ensure structural divergence
 * in multi-agent debate sessions. Without personas, same-model debaters produce
 * near-identical outputs with 90%+ overlap.
 */

import type { Debater, DebaterPersona } from "./types";

// ─── Persona fragments ────────────────────────────────────────────────────────

export const PERSONA_FRAGMENTS: Record<DebaterPersona, { identity: string; lens: string }> = {
  challenger: {
    identity: "You are the challenger — your job is to stress-test proposals and find weaknesses.",
    lens:
      "Question every assumption. Look for missing edge cases, unhandled error states, " +
      "and scenarios where the proposed approach could break under real-world conditions. " +
      "If a proposal lacks justification for a design choice, call it out.",
  },
  pragmatist: {
    identity: "You are the pragmatist — your job is to find the simplest path that satisfies the spec.",
    lens:
      "Favour minimal scope, fewest files changed, and lowest complexity. " +
      "Challenge any proposal that adds abstraction, configuration, or code beyond what the spec requires. " +
      "If something can be done in 5 lines instead of 50, advocate for the 5-line version.",
  },
  completionist: {
    identity: "You are the completionist — your job is to ensure nothing is missed.",
    lens:
      "Verify every acceptance criterion is addressed. Check that edge cases have tests, " +
      "that error messages are user-friendly, and that the implementation handles all status/state variants. " +
      "If the spec is ambiguous, flag it and propose the safer interpretation.",
  },
  security: {
    identity: "You are the security reviewer — your job is to surface risks before they ship.",
    lens:
      "Evaluate input validation, secret handling, injection vectors, and trust boundaries. " +
      "Check that user-supplied data is never used unsanitised in commands, queries, or file paths. " +
      "If the proposal touches auth, permissions, or external APIs, apply extra scrutiny.",
  },
  testability: {
    identity: "You are the testability advocate — your job is to ensure the design is verifiable.",
    lens:
      "Assess whether the proposed implementation can be tested without mocks, " +
      "whether test boundaries are clean, and whether the acceptance criteria are machine-verifiable. " +
      "Challenge any design that makes testing harder (global state, tight coupling, hidden side effects).",
  },
};

// ─── Rotation tables ──────────────────────────────────────────────────────────

const PLAN_ROTATION: DebaterPersona[] = ["challenger", "pragmatist", "completionist", "security", "testability"];

const REVIEW_ROTATION: DebaterPersona[] = ["security", "completionist", "testability", "challenger", "pragmatist"];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Assign personas to debaters that have no explicit persona.
 *
 * When autoPersona is false, returns the input array unchanged.
 * When autoPersona is true, debaters without a persona receive one from the
 * stage-specific rotation. Explicit personas always take priority.
 *
 * Does not mutate the input array or its elements.
 */
export function resolvePersonas(debaters: Debater[], stage: "plan" | "review", autoPersona: boolean): Debater[] {
  if (!autoPersona) return debaters;

  const rotation = stage === "plan" ? PLAN_ROTATION : REVIEW_ROTATION;
  let rotationIndex = 0;

  return debaters.map((d) => {
    if (d.persona) return d;
    const assigned = rotation[rotationIndex % rotation.length];
    rotationIndex++;
    return { ...d, persona: assigned };
  });
}

/**
 * Build the ## Your Role block for a debater.
 *
 * Returns empty string when the debater has no persona so the caller
 * can safely concatenate without adding blank lines.
 * Returns "\n\n## Your Role\n..." (leading double newline) when persona is set,
 * so it slots cleanly between taskContext and outputFormat.
 */
export function buildPersonaBlock(debater: Debater): string {
  if (!debater.persona) return "";
  const { identity, lens } = PERSONA_FRAGMENTS[debater.persona];
  return `\n\n## Your Role\n${identity}\n${lens}`;
}

/**
 * Build a display label for a debater proposal, including persona when available.
 *
 * Without persona: "claude"
 * With persona:    "claude (challenger)"
 */
export function buildDebaterLabel(debater: Debater): string {
  return debater.persona ? `${debater.agent} (${debater.persona})` : debater.agent;
}
