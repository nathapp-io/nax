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

import type { PromptLoaderConfig } from "@/config/selectors";
import type { NaxConfig } from "@/config/types";
import { filterContextByRole, truncateToContextBudget } from "@/context";
import type { UserStory } from "@/prd";
import type { SelfVerificationPromptInput } from "@/quality/self-verification";
import type { PromptOptions, PromptRole, PromptSection } from "../core";
import { SectionAccumulator, universalConstitutionSection, universalContextSection } from "../core";
import type { AcceptanceEntry, GuardrailRole } from "../sections";
import {
  buildAcceptanceSection,
  buildBatchStorySection,
  buildBehavioralGuardrailsSection,
  buildConventionsSection,
  buildHermeticSection,
  buildIsolationSection,
  buildNaxArtifactsSection,
  buildRoleTaskSection,
  buildSelfVerificationSection,
  buildStoryReminderSection,
  buildStorySection,
  buildTddLanguageSection,
  buildTestQualitySection,
  buildVerdictSection,
} from "../sections";

export class TddPromptBuilder {
  private readonly role: PromptRole;
  private readonly options: PromptOptions;

  private story_: UserStory | undefined;
  private stories_: UserStory[] | undefined;
  private constitution_: string | undefined;
  private contextMd_: string | undefined;
  private featureContextMd_: string | undefined;
  /** v2 pushMarkdown — injected directly, bypassing filterContextByRole (Finding 2 fix) */
  private v2PushMarkdown_: string | undefined;
  private overridePath_: string | undefined;
  private loaderWorkdir_: string | undefined;
  private loaderConfig_: PromptLoaderConfig | undefined;
  private testCommand_: string | undefined;
  private hermeticConfig_: { hermetic?: boolean; externalBoundaries?: string[]; mockGuidance?: string } | undefined;
  private noTestJustification_: string | undefined;
  private acceptanceEntries_: AcceptanceEntry[] | undefined;
  private selfVerification_: SelfVerificationPromptInput | undefined;

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

  featureContext(md: string | undefined): this {
    if (md) this.featureContextMd_ = md;
    return this;
  }

  /**
   * Inject a v2 ContextBundle's pushMarkdown directly, bypassing filterContextByRole.
   * Use this instead of featureContext() when assembleForStage() returned a bundle.
   * The orchestrator already applied role filtering — no additional v1 filter needed.
   */
  v2FeatureContext(md: string | undefined): this {
    if (md) this.v2PushMarkdown_ = md;
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
  withLoader(workdir: string, config: PromptLoaderConfig): this {
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

  selfVerification(input: SelfVerificationPromptInput | undefined): this {
    this.selfVerification_ = input;
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

    // (3) Story context — placed immediately after role task (primacy: LLMs attend to content
    // near the top; story must not be buried under rules).
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

    // (4) Feature-level context — after story so rules don't bury the task.
    // v2 path: pushMarkdown is injected directly (already role-filtered by the orchestrator).
    // v1 path: featureContextMd_ goes through filterContextByRole for audience filtering.
    if (this.v2PushMarkdown_) {
      // v2 bundle pushMarkdown: include verbatim, no filter pass needed.
      const md = this.v2PushMarkdown_.trim();
      if (md) acc.add(this.s("feature-context", md));
    } else if (this.featureContextMd_) {
      const budgetTokens = this.loaderConfig_?.context?.featureEngine?.budgetTokens ?? 2048;
      const filtered = filterContextByRole(this.featureContextMd_, this.role);
      if (filtered.trim()) {
        // Extract featureId from the injection header ("_Feature: <id>_") so the
        // truncation warning log names the actual feature instead of a placeholder.
        const headerMatch = this.featureContextMd_.match(/^_Feature: (.+?)_$/m);
        const logFeatureId = headerMatch?.[1] ?? "unknown";
        const truncated = truncateToContextBudget(filtered, budgetTokens, logFeatureId);
        if (truncated.trim()) {
          acc.add(this.s("feature-context", truncated));
        }
      }
    }

    // (5) Verdict — verifier only
    if (this.role === "verifier" && this.story_) {
      acc.add(this.s("verdict", buildVerdictSection(this.story_)));
    }

    // (6) Isolation rules — for implementer, the "lite" variant relaxes the
    // no-test-edits rule (session 2 of three-session-tdd-lite fills coverage
    // gaps), so the variant doubles as the isolation mode.
    const isolation =
      this.role === "implementer" && this.options.variant === "lite"
        ? "lite"
        : (this.options.isolation as "strict" | "lite" | undefined);
    acc.add(this.s("isolation", buildIsolationSection(this.role, isolation, this.testCommand_)));

    // (6.5) TDD language convention
    const tddLang = buildTddLanguageSection(this.loaderConfig_?.project?.language);
    if (tddLang) acc.add(this.s("tdd-language", tddLang));

    // (6.6) Hermetic test rules
    if (this.hermeticConfig_ !== undefined && this.hermeticConfig_.hermetic !== false) {
      const hermeticSection = buildHermeticSection(
        this.role,
        this.hermeticConfig_.externalBoundaries,
        this.hermeticConfig_.mockGuidance,
        this.loaderConfig_?.project,
      );
      if (hermeticSection) acc.add(this.s("hermetic", hermeticSection));
    }

    // (6.7) Behavioral Guardrails
    const guardrailLevel = this.loaderConfig_?.prompts?.behavioralGuardrails ?? "lite";
    const guardrailVariant = this.options.variant as "standard" | "lite" | undefined;
    const guardrailIsolation = this.options.isolation as "strict" | "lite" | undefined;
    const guardrails = buildBehavioralGuardrailsSection(
      this.role as GuardrailRole,
      guardrailLevel,
      guardrailVariant,
      guardrailIsolation,
    );
    if (guardrails) acc.add(this.s("guardrails", guardrails));

    // (6.71) .nax/ artifact immutability — always-on safety invariant for
    // code-touching roles (test-writer, implementer, verifier). Composed
    // alongside the guardrails block; not config-gated.
    const naxArtifacts = buildNaxArtifactsSection(this.role as GuardrailRole, guardrailVariant, guardrailIsolation);
    if (naxArtifacts) acc.add(this.s("nax-artifacts", naxArtifacts));

    // (6.8) Test-quality pre-brief — adversarial test-gap lenses forwarded to
    // test-authoring roles (July 2026 audit: test-gap was 67% of adversarial
    // blocking findings; pre-briefing avoids a review + rectification round).
    const testQuality = buildTestQualitySection(
      this.role,
      this.options.variant as "standard" | "lite" | undefined,
      this.story_?.id,
    );
    if (testQuality) acc.add(this.s("test-quality", testQuality));

    if (this.role !== "verifier") {
      const selfVerify = buildSelfVerificationSection(this.role, this.selfVerification_);
      if (selfVerify) acc.add(this.s("self-verification", selfVerify));
    }

    // (7) Context markdown
    acc.add(universalContextSection(this.contextMd_));

    // (8) Conventions footer
    acc.add(this.s("conventions", buildConventionsSection()));

    // (9) Story restatement — recency anchor: restates the task goal after all rules so the
    // final lines the agent sees are the task, not generic conventions.
    if (this.story_) {
      acc.add(this.s("reminder", buildStoryReminderSection(this.story_)));
    }

    return acc.join();
  }

  static buildForRole(
    role: PromptRole,
    workdir: string,
    config: NaxConfig,
    story: UserStory,
    opts: {
      lite?: boolean;
      contextMarkdown?: string;
      featureContextMarkdown?: string;
      contextBundle?: import("@/context/engine").ContextBundle;
      constitution?: string;
    },
  ): Promise<string> {
    const variant: "standard" | "lite" | undefined =
      role === "implementer" ? (opts.lite ? "lite" : "standard") : undefined;
    const isolation: "strict" | "lite" | undefined =
      role === "test-writer" ? (opts.lite ? "lite" : "strict") : undefined;
    return TddPromptBuilder.for(role, { variant, isolation })
      .withLoader(workdir, config)
      .story(story)
      .context(opts.contextMarkdown)
      .v2FeatureContext(opts.contextBundle?.pushMarkdown)
      .featureContext(opts.contextBundle ? undefined : opts.featureContextMarkdown)
      .constitution(opts.constitution)
      .testCommand(config.quality?.commands?.test)
      .hermeticConfig(config.quality?.testing)
      .build();
  }

  /**
   * Follow-up prompt sent in the same verifier session when the previous
   * reply could not be parsed as a valid VerifierVerdict JSON object.
   * The verifier still has full session context — this turn only asks
   * it to re-emit the verdict in the correct format.
   */
  static verdictRetry(): string {
    return (
      "Your previous reply could not be parsed as a valid VerifierVerdict JSON object.\n" +
      "Re-emit the verdict as the FINAL content of your reply.\n" +
      "Output ONLY the JSON object — no markdown fences, no explanation, no prose.\n" +
      "The reply must start with { and end with } on its own line.\n" +
      "Required top-level fields: version, approved, tests, testModifications, acceptanceCriteria, quality, fixes, reasoning.\n" +
      'Optional testFailureDiagnosis: null, or {"cause":"test-incorrect","assertions":[{"file":"...","testName":"...","reasoning":"..."}]}.'
    );
  }

  /**
   * Follow-up prompt when the previous verifier reply was truncated mid-JSON.
   * Asks for a condensed verdict that drops the long acceptanceCriteria.criteria[]
   * array (the most common source of truncation) and keeps only the minimal
   * required fields so the JSON fits in the output budget.
   */
  static verdictRetryCondensed(): string {
    return (
      "Your previous reply was truncated and could not be parsed as valid JSON.\n" +
      "Re-emit a CONDENSED verdict that omits the acceptanceCriteria.criteria[] entries:\n" +
      "- Keep acceptanceCriteria.allMet (boolean) but use criteria=[] (empty array).\n" +
      "- Keep quality.issues=[] and fixes=[] empty.\n" +
      "- Set testModifications.reasoning to a single sentence.\n" +
      "- Set reasoning to a single sentence.\n" +
      "Output ONLY the JSON object — no markdown fences, no prose.\n" +
      "Schema (minimal):\n" +
      `{"version":1,"approved":boolean,"tests":{"allPassing":boolean,"passCount":number,"failCount":number},"testModifications":{"detected":boolean,"files":[],"legitimate":boolean,"reasoning":"..."},"testFailureDiagnosis":null,"acceptanceCriteria":{"allMet":boolean,"criteria":[]},"quality":{"rating":"good"|"acceptable"|"poor","issues":[]},"fixes":[],"reasoning":"..."}`
    );
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
    return buildRoleTaskSection(
      this.role,
      variant,
      this.testCommand_,
      isolation,
      this.noTestJustification_,
      this.story_?.id,
    );
  }
}
