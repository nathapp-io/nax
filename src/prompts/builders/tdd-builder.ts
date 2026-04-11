/**
 * TddPromptBuilder — prompt builder for the TDD execution pipeline.
 *
 * Composes prompts from ordered sections via SectionAccumulator:
 *   (1) Constitution
 *   (2) Role task body  (user disk override OR default template)
 *   (3) Story context             [non-overridable]
 *   (3.5) Acceptance test context [non-overridable, when provided]
 *   (4) Verdict section           [verifier only, non-overridable]
 *   (5) Isolation rules           [non-overridable]
 *   (5.5) TDD language convention [non-overridable, when language is set]
 *   (5.6) Hermetic test rules     [non-overridable, when hermetic=true]
 *   (6) Context markdown
 *   (7) Conventions footer        [non-overridable, always last]
 *
 * Section ordering in Phase 1 is preserved from the original PromptBuilder
 * (deferred in build()). Call-order semantics will be introduced in a later
 * phase once all callsites are migrated to the new builder family.
 *
 * Replaces: src/prompts/builder.ts (PromptBuilder)
 * Backwards-compat alias: PromptBuilder re-exported from src/prompts/index.ts
 */

import type { NaxConfig } from "../../config/types";
import type { UserStory } from "../../prd";
import { SectionAccumulator } from "../core";
import type { PromptOptions, PromptRole, PromptSection } from "../core";
import { universalConstitutionSection, universalContextSection } from "../core";
import type { AcceptanceEntry } from "../sections";
import {
  buildAcceptanceSection,
  buildBatchStorySection,
  buildConventionsSection,
  buildHermeticSection,
  buildIsolationSection,
  buildRoleTaskSection,
  buildStorySection,
  buildTddLanguageSection,
  buildVerdictSection,
} from "../sections";

export class TddPromptBuilder {
  private readonly role: PromptRole;
  private readonly options: PromptOptions;

  private story_: UserStory | undefined;
  private stories_: UserStory[] | undefined;
  private constitution_: string | undefined;
  private contextMd_: string | undefined;
  private overridePath_: string | undefined;
  private loaderWorkdir_: string | undefined;
  private loaderConfig_: NaxConfig | undefined;
  private testCommand_: string | undefined;
  private hermeticConfig_: { hermetic?: boolean; externalBoundaries?: string[]; mockGuidance?: string } | undefined;
  private noTestJustification_: string | undefined;
  private acceptanceEntries_: AcceptanceEntry[] | undefined;

  private constructor(role: PromptRole, options: PromptOptions = {}) {
    this.role = role;
    this.options = options;
  }

  static for(role: PromptRole, options?: PromptOptions): TddPromptBuilder {
    return new TddPromptBuilder(role, options ?? {});
  }

  story(story: UserStory): this {
    this.story_ = story;
    return this;
  }

  stories(stories: UserStory[]): this {
    this.stories_ = stories;
    return this;
  }

  context(md: string | undefined): this {
    if (md) this.contextMd_ = md;
    return this;
  }

  constitution(c: string | undefined): this {
    if (c) this.constitution_ = c;
    return this;
  }

  override(path: string): this {
    this.overridePath_ = path;
    return this;
  }

  testCommand(cmd: string | undefined): this {
    if (cmd) this.testCommand_ = cmd;
    return this;
  }

  /**
   * Configure disk-based prompt override loading.
   * Both workdir and config are stored on the builder so they are available
   * to tddLanguage and hermetic sections (which need config.project) as well
   * as to the override loader.
   */
  withLoader(workdir: string, config: NaxConfig): this {
    this.loaderWorkdir_ = workdir;
    this.loaderConfig_ = config;
    return this;
  }

  hermeticConfig(
    config: { hermetic?: boolean; externalBoundaries?: string[]; mockGuidance?: string } | undefined,
  ): this {
    this.hermeticConfig_ = config;
    return this;
  }

  noTestJustification(justification: string | undefined): this {
    this.noTestJustification_ = justification;
    return this;
  }

  acceptanceContext(entries: AcceptanceEntry[]): this {
    this.acceptanceEntries_ = entries;
    return this;
  }

  /**
   * Compose and return the final prompt string.
   *
   * A fresh SectionAccumulator is created on each call so that calling build()
   * more than once on the same instance is safe and idempotent.
   */
  async build(): Promise<string> {
    const acc = new SectionAccumulator();

    // (1) Constitution
    acc.add(universalConstitutionSection(this.constitution_));

    // (2) Role task body — disk override or default template
    acc.add(this.s("role-task", await this.resolveRoleBody()));

    // (3) Story context
    if (this.role === "batch" && this.stories_ && this.stories_.length > 0) {
      acc.add(this.s("story", buildBatchStorySection(this.stories_)));
    } else if (this.story_) {
      acc.add(this.s("story", buildStorySection(this.story_)));
    }

    // (3.5) Acceptance test context
    if (this.acceptanceEntries_ && this.acceptanceEntries_.length > 0) {
      const content = buildAcceptanceSection(this.acceptanceEntries_);
      if (content) acc.add(this.s("acceptance", content));
    }

    // (4) Verdict — verifier only
    if (this.role === "verifier" && this.story_) {
      acc.add(this.s("verdict", buildVerdictSection(this.story_)));
    }

    // (5) Isolation rules
    const isolation = this.options.isolation as "strict" | "lite" | undefined;
    acc.add(this.s("isolation", buildIsolationSection(this.role, isolation, this.testCommand_)));

    // (5.5) TDD language convention
    const tddLang = buildTddLanguageSection(this.loaderConfig_?.project?.language);
    if (tddLang) acc.add(this.s("tdd-language", tddLang));

    // (5.6) Hermetic test rules
    if (this.hermeticConfig_ !== undefined && this.hermeticConfig_.hermetic !== false) {
      const hermeticSection = buildHermeticSection(
        this.role,
        this.hermeticConfig_.externalBoundaries,
        this.hermeticConfig_.mockGuidance,
        this.loaderConfig_?.project,
      );
      if (hermeticSection) acc.add(this.s("hermetic", hermeticSection));
    }

    // (6) Context markdown
    acc.add(universalContextSection(this.contextMd_));

    // (7) Conventions footer — always last
    acc.add(this.s("conventions", buildConventionsSection()));

    return acc.join();
  }

  /** Wrap a string-returning section builder into a PromptSection for the accumulator. */
  private s(id: string, content: string): PromptSection {
    return { id, content, overridable: false };
  }

  private async resolveRoleBody(): Promise<string> {
    // Disk override via withLoader takes priority
    if (this.loaderWorkdir_ && this.loaderConfig_) {
      const { loadOverride } = await import("../loader");
      const content = await loadOverride(this.role, this.loaderWorkdir_, this.loaderConfig_);
      if (content !== null) return content;
    }

    // Explicit override path fallback
    if (this.overridePath_) {
      try {
        const file = Bun.file(this.overridePath_);
        if (await file.exists()) return file.text();
      } catch {
        // fall through to default section
      }
    }

    const variant = this.options.variant as "standard" | "lite" | undefined;
    const isolation = this.options.isolation as "strict" | "lite" | undefined;
    return buildRoleTaskSection(this.role, variant, this.testCommand_, isolation, this.noTestJustification_);
  }
}
