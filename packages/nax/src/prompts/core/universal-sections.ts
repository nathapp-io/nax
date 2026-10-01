/**
 * Universal Section Helpers
 *
 * Null-guarded constructors for sections that every prompt builder uses.
 * Centralises wrapping logic so builder methods are pure one-line delegations.
 * Bug fixes or wrapping changes propagate to all builders automatically.
 *
 * Returns PromptSection objects (not raw strings) so the SectionAccumulator
 * can track ids and sources for debug/audit.
 */

import type { PromptSection } from "./types";
import { wrapConstitution, wrapContext } from "./wrappers";

/**
 * Build the constitution section.
 * Returns null if no constitution string is provided — callers can safely
 * pass `config.constitution` without an extra guard.
 */
export function universalConstitutionSection(content: string | undefined): PromptSection | null {
  if (!content) return null;
  return {
    id: "constitution",
    overridable: false,
    content: wrapConstitution(content),
  };
}

/**
 * Build the context markdown section.
 * Returns null if no context string is provided.
 */
export function universalContextSection(md: string | undefined): PromptSection | null {
  if (!md) return null;
  return {
    id: "context",
    overridable: false,
    content: wrapContext(md),
  };
}
