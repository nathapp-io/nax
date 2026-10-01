/**
 * SectionAccumulator — shared engine for all prompt builders.
 *
 * Responsibilities:
 *   - Accumulate PromptSection objects in insertion order (call-order = section order).
 *   - Join sections into a final prompt string using the canonical separator.
 *   - Expose a read-only snapshot for debugging and audit.
 *
 * Builders wrap this via composition — no inheritance.
 *
 * Design notes:
 *   - Disk-based override loading is NOT handled here. Each builder is responsible
 *     for resolving overrides before calling add(), keeping this class focused
 *     and free of cross-module dependencies.
 *   - Instances are intended to be single-use (one build() per instance). Builders
 *     should create a fresh SectionAccumulator per build() call to prevent
 *     double-section accumulation if build() is called more than once.
 */

import type { PromptSection } from "./types";
import { SECTION_SEP } from "./wrappers";

export class SectionAccumulator {
  private readonly sections: PromptSection[] = [];

  /**
   * Append a section. Null/undefined sections are silently skipped,
   * so callers can write `acc.add(maybeNull)` without an extra guard.
   */
  add(section: PromptSection | null | undefined): this {
    if (section) this.sections.push(section);
    return this;
  }

  /**
   * Join all accumulated sections into the final prompt string.
   * Sections appear in insertion order, separated by SECTION_SEP.
   * Sections with empty content are skipped to avoid blank separator blocks —
   * this guards against section builders that return "" for certain configurations.
   */
  join(): string {
    return this.sections
      .filter((s) => s.content.length > 0)
      .map((s) => s.content)
      .join(SECTION_SEP);
  }

  /**
   * Return a read-only view of accumulated sections (for debug/audit).
   * Does not affect the accumulator state.
   */
  snapshot(): readonly PromptSection[] {
    return this.sections;
  }
}
