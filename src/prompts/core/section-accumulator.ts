/**
 * SectionAccumulator — shared engine for all prompt builders.
 *
 * Responsibilities:
 *   - Accumulate PromptSection objects in insertion order (call-order = section order).
 *   - Join sections into a final prompt string using the canonical separator.
 *   - Delegate disk-based override loading to the prompt loader.
 *   - Expose a read-only snapshot for debugging and audit.
 *
 * Builders wrap this via composition — no inheritance.
 */

import type { NaxConfig } from "../../config/types";
import type { PromptRole } from "./types";
import type { PromptSection } from "./types";
import { SECTION_SEP } from "./wrappers";

export class SectionAccumulator {
  private readonly sections: PromptSection[] = [];
  private workdir: string | undefined;
  private config: NaxConfig | undefined;
  private overrideRole: PromptRole | undefined;

  /**
   * Append a section. Null/undefined sections are silently skipped,
   * so callers can write `acc.add(maybeNull)` without an extra guard.
   */
  add(section: PromptSection | null | undefined): this {
    if (section) this.sections.push(section);
    return this;
  }

  /**
   * Configure disk-based override loading. When set, `resolveOverride()`
   * will check config.prompts.overrides[role] for a file path.
   */
  withLoader(workdir: string, config: NaxConfig, role: PromptRole): this {
    this.workdir = workdir;
    this.config = config;
    this.overrideRole = role;
    return this;
  }

  /**
   * Try to load a disk override for the configured role.
   * Returns the file content if an override exists and is readable, otherwise null.
   * Must be called inside an async context (e.g. inside build()).
   */
  async resolveOverride(): Promise<string | null> {
    if (!this.workdir || !this.config || !this.overrideRole) return null;
    const { loadOverride } = await import("../loader");
    return loadOverride(this.overrideRole, this.workdir, this.config);
  }

  /**
   * Join all accumulated sections into the final prompt string.
   * Sections appear in insertion order, separated by SECTION_SEP.
   * Empty-content sections are filtered out to avoid blank separator blocks.
   */
  async join(): Promise<string> {
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
