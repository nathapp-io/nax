/**
 * Prompt Builder Core Types
 *
 * Shared types for the unified prompt building system.
 * All builders and section functions import types from here.
 */

/** Role determining which default template body to use in TddPromptBuilder. */
export type PromptRole =
  | "no-test"
  | "test-writer"
  | "implementer"
  | "verifier"
  | "single-session"
  | "tdd-simple"
  | "batch";

/** Wave 1 minimal slot set — grows per wave as builders migrate. */
export type SectionSlot = "constitution" | "instructions" | "input" | "candidates" | "json-schema";

/** Canonical slot rendering order for composeSections(). */
export const SLOT_ORDER: readonly SectionSlot[] = [
  "constitution",
  "instructions",
  "input",
  "candidates",
  "json-schema",
];

/** A single section of a composed prompt. */
export interface PromptSection {
  /** Unique section identifier for debugging and audit. */
  id: string;
  /** Section content — the text that appears in the final prompt. */
  content: string;
  /** Whether this section can be removed by a user disk override. */
  overridable: boolean;
  /** Optional slot for ordered composition via composeSections(). Wave 1 — existing builders still compile without it. */
  readonly slot?: SectionSlot;
}

/** Options passed to builder factory methods (e.g. TddPromptBuilder.for()). */
export type PromptOptions = Record<string, unknown>;
