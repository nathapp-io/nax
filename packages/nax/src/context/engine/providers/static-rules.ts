/**
 * Context Engine v2 — StaticRulesProvider
 *
 * Reads project-wide static rules and returns them as "static" kind chunks
 * with budget-floor guarantee.
 *
 * Phase 0: reads only CLAUDE.md (or equivalent agent config file).
 * Phase 5.1: reads from .nax/rules/ canonical store first. Falls back to
 *   CLAUDE.md / .cursorrules / AGENTS.md when allowLegacyClaudeMd is true
 *   and no canonical rules exist, emitting a deprecation warning.
 *
 * Chunks from this provider are always included in the push markdown
 * regardless of budget (floor behavior — see packing.ts).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_CANONICAL_RULES_BUDGET_TOKENS } from "@/context/rules/canonical-loader";
import { applySectionBudget, priorityToRawScore } from "@/context/rules/rule-budget";
import type { RuleSection } from "@/context/rules/rule-sections";
import { splitRuleIntoSections } from "@/context/rules/rule-sections";
import { canonicalRuleId, canonicalRulePath, type ResolvedRule, resolveRuleSet } from "@/context/rules/rule-set";
import { getLogger } from "@/logger";
// Same estimator the section budget uses (via `rule-sections`). A second local
// `length / 4` here would let a chunk's reported token count disagree with the
// number the budget admitted it on.
import { estimateTokens } from "@/optimizer";
import type { ProviderScopingReport } from "../manifest-types";
import { normalizePath, ruleMatchesScopeFiles } from "../scope-path-match";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";
import { memoizedLoadCanonicalRules } from "./canonical-rules-cache";
import { buildBudgetNoticeChunk, buildSectionBudgetPressure } from "./static-rules-budget-notice";
import { ruleTargetsAuthoredTests, warnOnAppliesToStageContradiction } from "./static-rules-scoping";

export { _resetCanonicalRulesCache } from "./canonical-rules-cache";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _staticRulesDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  globInDir: (dir: string): string[] => {
    try {
      return [...new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })].sort().map((f) => join(dir, f));
    } catch {
      return [];
    }
  },
  loadCanonicalRules: memoizedLoadCanonicalRules,
  splitRuleIntoSections,
  applySectionBudget,
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy candidate files (Phase 0 / allowLegacyClaudeMd fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy static rules candidate file names, checked in order.
 * Only used when .nax/rules/ is absent and allowLegacyClaudeMd is true.
 */
const LEGACY_CANDIDATE_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];
const LEGACY_RULES_DIR = ".claude/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface StaticRulesProviderOptions {
  /**
   * Fall back to reading CLAUDE.md / .cursorrules / AGENTS.md when
   * .nax/rules/ is absent. Default: false — opt-in only.
   * Set true only during migration to the canonical .nax/rules/ store.
   */
  allowLegacyClaudeMd?: boolean;
  /** Token budget for static rules chunk emission. Default: 8192 */
  budgetTokens?: number;
  /**
   * Per-stage share of `ContextRequest.budgetTokens` reserved for canonical rules.
   * The provider derives an effective budget of `min(rulesShare * request.budgetTokens, budgetTokens)`,
   * so `budgetTokens` becomes an absolute upper bound. Default: 0.4. US-003.
   */
  rulesShare?: number;
  /**
   * When true, enforce the effective budget via the per-rule section walk:
   * a rule that no longer fits is closed, and the walk continues into later
   * rules (contiguous within a rule, skip across rules). When false (default),
   * every rule is preserved; the gap is reported on the result's
   * `budgetPressure` (`overageTokens`, `droppedCount`, `droppedTokens`, `droppedIds`).
   *
   * Wired from `config.context.v2.rules.enforceBudget` by the default orchestrator. See US-003.
   */
  enforceBudget?: boolean;
  /**
   * Absolute directory of run-level override rules (US-001), laid out like
   * `.nax/rules/`. Wired from `config.context.rules.overrideDir`.
   */
  overrideDir?: string;
  /**
   * How `overrideDir` combines with the repo and package layers (US-001).
   * "merge" (default) adds them; "replace" drops the repo and package layers
   * entirely. Wired from `config.context.rules.overrideMode`.
   */
  overrideMode?: "merge" | "replace";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// `canonicalRuleId` and `canonicalRulePath` moved to the rule-set module
// (`@/context/rules/rule-set`, US-001) — the layer merge is now
// `resolveRuleSet`'s job, and the provider and the resolver must key rules
// identically. `canonicalRulePriority` moved with them; nothing here orders
// rules any more.

// `normalizePath`/`globToRegex` moved to `../scope-path-match` so the matcher
// below and effectiveness.ts share one implementation. Re-exported here to
// preserve this module's public surface (the context-engine barrel and
// effectiveness.ts import them from `./providers/static-rules`).
//
// `ruleMatchesScopeFiles` moved there too (US-001): the rule-set resolver must
// use the same matcher, and importing it from this module would close a
// provider <-> rule-set runtime cycle. Re-exported for the same reason — the
// selection/attribution agreement it guarantees is tested through this path.
export { globToRegex, normalizePath, ruleMatchesScopeFiles } from "../scope-path-match";

/**
 * Returns true when the rule's `stages:` frontmatter includes request.stage.
 * Fail-open: a rule with no `stages:` key applies to every stage.
 */
function ruleMatchesStage(stages: string[] | undefined, stage: string): boolean {
  if (!stages || stages.length === 0) return true;
  return stages.includes(stage);
}

// `ruleMatchesPackage` moved to `../scope-path-match` (file-size gate — this
// file was at 624/600 lines after nax#2113's hoist); the rule-set resolver
// imports it from there too.

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class StaticRulesProvider implements IContextProvider {
  readonly id = "static-rules";
  readonly kind = "static" as const;

  private readonly allowLegacyClaudeMd: boolean;
  private readonly budgetTokens: number;
  private readonly rulesShare: number;
  private readonly enforceBudget: boolean;
  private readonly overrideDir: string | undefined;
  private readonly overrideMode: "merge" | "replace" | undefined;

  constructor(options: StaticRulesProviderOptions = {}) {
    this.allowLegacyClaudeMd = options.allowLegacyClaudeMd ?? false;
    this.budgetTokens = options.budgetTokens ?? DEFAULT_CANONICAL_RULES_BUDGET_TOKENS;
    this.rulesShare = options.rulesShare ?? 0.4;
    // Schema defaults enforceBudget to true; the constructor fallback is
    // deliberately left at false so a directly-constructed provider that
    // names no option keeps today's soft behaviour (US-003).
    this.enforceBudget = options.enforceBudget ?? false;
    // Undefined (rather than a "merge" default) keeps the mode decision in
    // `resolveRuleSet`, the module both this provider and the native
    // rule-delivery handlers resolve through (US-001).
    this.overrideDir = options.overrideDir;
    this.overrideMode = options.overrideMode;
  }

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();

    // Phase 5.1 + AC-57: resolve the canonical repo/package/override rule set.
    try {
      const ruleSet = await resolveRuleSet(
        {
          repoRoot: request.repoRoot,
          packageDir: request.packageDir,
          ...(request.storyWorkdir !== undefined && { storyWorkdir: request.storyWorkdir }),
          ...(this.overrideDir !== undefined && { overrideDir: this.overrideDir }),
          ...(this.overrideMode !== undefined && { overrideMode: this.overrideMode }),
        },
        // `loadRepoRules` drives BOTH the repo and the package layer — the seam
        // six existing test files stub to keep `fetch` off the real filesystem.
        { loadRepoRules: _staticRulesDeps.loadCanonicalRules },
      );
      const mergedRules: readonly ResolvedRule[] = ruleSet.rules;

      if (ruleSet.repoRulesTotal > 0 && ruleSet.repoRulesMatchedPaths < ruleSet.repoRulesTotal) {
        logger.debug("static-rules", "Package-scope filter applied to repo-level rules", {
          storyId: request.storyId,
          total: ruleSet.repoRulesTotal,
          matched: ruleSet.repoRulesMatchedPaths,
          packageDir: request.packageDir,
        });
      }

      // The layer merge, the package frame and the priority/id ordering now live
      // in `@/context/rules/rule-set` (US-001), shared with the native
      // rule-delivery handlers (US-005) and the review maps (US-006). The two
      // invariants that must survive any future edit there are pinned here and
      // in `static-rules-overrides.test.ts`:
      //  - repo-level `appliesTo:` literals are framed whenever this story is
      //    package-contained, NOT only when the package has rules of its own
      //    (a no-package-rules package is the common monorepo shape, nax#2113);
      //  - the frame comes from `request.storyWorkdir`, never from
      //    `relative(repoRoot, packageDir)` — under
      //    `execution.storyIsolation: "worktree"` that derivation yields
      //    ".nax-wt/<storyId>/<pkg>", matches no scope file, and silently drops
      //    the rule (nax#2069 / path-frame C1).

      // #558: rules exist but none apply to this package context — skip legacy fallback
      if (mergedRules.length === 0 && (ruleSet.repoRulesTotal > 0 || ruleSet.packageRulesCount > 0)) {
        logger.warn("static-rules", "Canonical rules found but none apply to this package context", {
          storyId: request.storyId,
          repoRulesTotal: ruleSet.repoRulesTotal,
          repoRulesMatchedPaths: ruleSet.repoRulesMatchedPaths,
          packageRulesCount: ruleSet.packageRulesCount,
          repoRoot: request.repoRoot,
          packageDir: request.packageDir,
        });
        // Report the shape of the drop rather than returning bare. Every other
        // exit from this provider carries a scopingReport, so omitting it here
        // made "rules existed but the package filter rejected all of them" the
        // one scoping outcome invisible to manifest telemetry.
        return {
          chunks: [],
          pullTools: [],
          scopingReport: {
            stageFilteredIds: [],
            appliesToFilteredIds: [],
            appliesToInertCount: 0,
            scopeFileCount: request.scopeFiles?.length ?? 0,
            sectionCount: 0,
          },
        };
      }

      if (mergedRules.length > 0) {
        const stageFilteredIds: string[] = [];
        const stageMatchedRules = mergedRules.filter((rule) => {
          if (ruleMatchesStage(rule.stages, request.stage)) return true;
          stageFilteredIds.push(canonicalRuleId(rule));
          return false;
        });

        const appliesToFilteredIds: string[] = [];
        let appliesToInertCount = 0;
        const scopeIsEmpty = !request.scopeFiles || request.scopeFiles.length === 0;
        // nax#2060: authoring stages also admit an appliesTo that itself denotes test output.
        const admits = (appliesTo?: string[]) =>
          ruleMatchesScopeFiles(appliesTo, request.scopeFiles) || ruleTargetsAuthoredTests(appliesTo, request);
        const scopedRules = stageMatchedRules.filter((rule) => {
          if (rule.appliesTo && rule.appliesTo.length > 0 && scopeIsEmpty) appliesToInertCount++;
          if (admits(rule.appliesTo)) return true;
          appliesToFilteredIds.push(canonicalRuleId(rule));
          return false;
        });
        warnOnAppliesToStageContradiction(logger, request, stageMatchedRules, appliesToFilteredIds, canonicalRuleId);

        const scopingReport: ProviderScopingReport = {
          stageFilteredIds,
          appliesToFilteredIds,
          appliesToInertCount,
          scopeFileCount: request.scopeFiles?.length ?? 0,
          sectionCount: 0,
        };

        // nax#1775: a rule declaring `appliesTo:` that gets admitted only
        // because the scope-file set was empty is a silent scoping bug, not
        // a benign default — `appliesToInertCount` alone was invisible
        // outside manifest telemetry.
        if (appliesToInertCount > 0) {
          logger.warn("static-rules", "appliesTo rules admitted unconditionally — scope-file set is empty", {
            storyId: request.storyId,
            stage: request.stage,
            appliesToInertCount,
          });
        }

        const effectiveBudget = Math.min(this.rulesShare * request.budgetTokens, this.budgetTokens);

        // Split each scoped rule into sections, pairing each section with its parent
        // rule identity so chunk ids/content labels preserve the owning rule's fileName.
        const allSections: RuleSection[] = [];
        const sectionRuleIdMap = new Map<RuleSection, string>();
        const sectionRulePathMap = new Map<RuleSection, string>();
        for (const rule of scopedRules) {
          const rawSections = _staticRulesDeps.splitRuleIntoSections(rule);
          const ruleId = canonicalRuleId(rule);
          const rulePath = canonicalRulePath(rule);
          // When the rule declares precomputed tokens, distribute them proportionally
          // to each section so the section-level budget honours the rule-level estimate.
          // Rebuild rather than mutate: `splitRuleIntoSections` is pure and
          // `RuleSection.tokens` is documented as the estimate of the section's own
          // content, so overwriting it in place would contradict that contract.
          const ruleTokens = rule.tokens;
          const ruleContentLen = rule.content.length;
          const sections =
            ruleTokens != null && ruleContentLen > 0
              ? rawSections.map((section) => ({
                  ...section,
                  tokens: Math.ceil(ruleTokens * (section.content.length / ruleContentLen)),
                }))
              : rawSections;
          for (const section of sections) {
            sectionRuleIdMap.set(section, ruleId);
            sectionRulePathMap.set(section, rulePath);
          }
          allSections.push(...sections);
        }
        scopingReport.sectionCount = allSections.length;

        const budgetResult = _staticRulesDeps.applySectionBudget(allSections, effectiveBudget);
        const budgetData = {
          storyId: request.storyId,
          totalTokens: budgetResult.totalTokens,
          budgetTokens: effectiveBudget,
          droppedCount: budgetResult.droppedIds.length,
        };
        if (budgetResult.totalTokens >= Math.floor(effectiveBudget * 0.75)) {
          const msg = this.enforceBudget
            ? "Canonical rules are approaching/exceeding static rules budget"
            : "Canonical rules are approaching/exceeding static rules budget — set context.v2.rules.enforceBudget to truncate sections";
          logger.warnOnce("static-rules", msg, budgetData);
        }
        if (budgetResult.droppedIds.length > 0) {
          const truncateData = { ...budgetData, usedTokens: budgetResult.usedTokens };
          const msg = this.enforceBudget
            ? "Rule sections truncated by static rules budget"
            : "Rule sections would be truncated by static rules budget (set context.v2.rules.enforceBudget to apply)";
          logger.warnOnce("static-rules", msg, truncateData);
        }

        const effectiveSections = this.enforceBudget ? budgetResult.retainedSections : allSections;
        if (effectiveSections.length === 0) {
          // Two different causes reach zero sections, and conflating them sends
          // an operator to tune a budget that was never the problem: either the
          // stage / appliesTo filters rejected every rule, or sections existed
          // and none fit. `allSections.length` tells them apart.
          if (allSections.length === 0) {
            logger.warn("static-rules", "Every canonical rule was filtered out by stage/appliesTo scoping", {
              storyId: request.storyId,
              stageFilteredCount: stageFilteredIds.length,
              appliesToFilteredCount: appliesToFilteredIds.length,
              stage: request.stage,
              scopeFileCount: request.scopeFiles?.length ?? 0,
            });
          } else {
            logger.warn("static-rules", "No rule sections fit in static rules budget", {
              storyId: request.storyId,
              budgetTokens: effectiveBudget,
              totalScopedSections: allSections.length,
            });
          }
          const emptyPressure = buildSectionBudgetPressure(allSections, budgetResult);
          const emptyChunks: RawChunk[] =
            this.enforceBudget && budgetResult.droppedIds.length > 0
              ? [buildBudgetNoticeChunk(request.storyId, budgetResult.droppedIds.length, budgetResult.droppedIds)]
              : [];
          return {
            chunks: emptyChunks,
            pullTools: [],
            ...(emptyPressure && { budgetPressure: emptyPressure }),
            scopingReport,
          };
        }

        const chunks: RawChunk[] = effectiveSections.map((section) => {
          const ruleId = sectionRuleIdMap.get(section) ?? section.ruleId ?? "unknown";
          const rulePath = sectionRulePathMap.get(section) ?? section.rulePath ?? ruleId;
          const content = `### ${rulePath}\n\n${section.content}`;
          const tokens = estimateTokens(content);
          const hash = contentHash8(section.content);
          // US-002: thread the owning rule's appliesTo through as the chunk's
          // scopePaths carrier. Only populated when appliesTo is a non-empty
          // list — empty/missing appliesTo means "no scoping declared" and the
          // chunk keeps whole-diff behaviour. The field is the same array the
          // rule frontmatter declared, in declared order, so buildManifest can
          // forward it to chunkScopePaths without further mutation.
          const scopePaths = section.appliesTo && section.appliesTo.length > 0 ? section.appliesTo : undefined;
          return {
            id: `static-rules:${ruleId}:${section.slug}:${hash}`,
            kind: "static" as const,
            scope: "project" as const,
            role: ["all"] as ["all"],
            content,
            tokens,
            rawScore: priorityToRawScore(section.priority),
            ...(scopePaths && { scopePaths }),
          } satisfies RawChunk;
        });

        logger.debug("static-rules", "Loaded canonical rules", {
          storyId: request.storyId,
          sectionCount: effectiveSections.length,
          totalCanonicalRules: mergedRules.length,
          files: effectiveSections.map((s) => s.rulePath ?? "unknown"),
        });

        // Standalone notice chunk (not spliced into the last rule chunk) so
        // it survives dedupeChunks independently of whatever rule section
        // happens to sort last (#1610).
        if (this.enforceBudget && budgetResult.droppedIds.length > 0) {
          chunks.push(buildBudgetNoticeChunk(request.storyId, budgetResult.droppedIds.length, budgetResult.droppedIds));
        }

        const pressure = buildSectionBudgetPressure(allSections, budgetResult);
        return {
          chunks,
          pullTools: [],
          ...(pressure && { budgetPressure: pressure }),
          scopingReport,
        };
      }
    } catch (err) {
      // NeutralityLintError or other loader error — propagate so the operator sees it
      logger.warn("static-rules", "Canonical rules loader failed", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
      // Re-throw: linter violations must not silently fall back to legacy rules.
      throw err;
    }

    // No canonical rules found at repo or package level. Apply legacy fallback policy.
    if (!this.allowLegacyClaudeMd) {
      logger.warn("static-rules", "No canonical rules found at repo or package level — loading zero rules", {
        storyId: request.storyId,
        repoRoot: request.repoRoot,
        packageDir: request.packageDir,
      });
      return { chunks: [], pullTools: [] };
    }

    // allowLegacyClaudeMd: true — emit deprecation warning and fall back to legacy files
    logger.warn(
      "static-rules",
      "No canonical rules found at repo or package level — falling back to legacy rule files (deprecation warning). " +
        "Run `nax rules migrate` to create the canonical store.",
      {
        storyId: request.storyId,
        repoRoot: request.repoRoot,
        packageDir: request.packageDir,
      },
    );

    return this.fetchLegacy(request);
  }

  /**
   * Legacy Phase 0 path: reads the first of CLAUDE.md / .cursorrules / AGENTS.md.
   * Only called when .nax/rules/ is absent and allowLegacyClaudeMd is true.
   */
  private async fetchLegacy(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();
    const chunks: RawChunk[] = [];
    const rootDir = request.repoRoot;

    // Detect multiple candidates so operators know which one was chosen when more than one exists.
    const existingCandidates: string[] = [];
    for (const fileName of LEGACY_CANDIDATE_FILES) {
      try {
        if (await _staticRulesDeps.fileExists(join(rootDir, fileName))) {
          existingCandidates.push(fileName);
        }
      } catch {
        // ignore probe failures; the main loop will surface real errors.
      }
    }
    if (existingCandidates.length > 1) {
      logger.warn("static-rules", "Multiple legacy candidate files found — preferring the first in precedence order", {
        storyId: request.storyId,
        candidates: existingCandidates,
        chosen: existingCandidates[0],
      });
    }

    const legacySources: Array<{ sourceId: string; filePath: string; heading: string }> = [];

    for (const fileName of LEGACY_CANDIDATE_FILES) {
      legacySources.push({
        sourceId: fileName,
        filePath: join(rootDir, fileName),
        heading: fileName,
      });
    }

    const rulesDir = join(rootDir, LEGACY_RULES_DIR);
    const nestedRulePaths = _staticRulesDeps.globInDir(rulesDir);
    for (const filePath of nestedRulePaths) {
      const normalized = normalizePath(filePath);
      const rulesRoot = normalizePath(`${rulesDir}/`);
      const rel = normalized.startsWith(rulesRoot) ? normalized.slice(rulesRoot.length) : normalized;
      legacySources.push({
        sourceId: `${LEGACY_RULES_DIR}/${rel}`,
        filePath,
        heading: `${LEGACY_RULES_DIR}/${rel}`,
      });
    }

    for (const { sourceId, filePath, heading } of legacySources) {
      const fileName = heading;

      try {
        const exists = await _staticRulesDeps.fileExists(filePath);
        if (!exists) continue;

        const content = await _staticRulesDeps.readFile(filePath);
        if (!content.trim()) continue;

        const hash = contentHash8(content);
        const tokens = estimateTokens(content);

        chunks.push({
          id: `static-rules:legacy:${sourceId}:${hash}`,
          kind: "static",
          scope: "project",
          role: ["all"],
          content: `### ${heading}\n\n${content.trim()}`,
          tokens,
          rawScore: 1.0,
        });

        logger.debug("static-rules", "Loaded legacy static rules", {
          storyId: request.storyId,
          file: fileName,
          tokens,
        });
      } catch (err) {
        logger.warn("static-rules", `Failed to read ${fileName} — skipping`, {
          storyId: request.storyId,
          file: fileName,
          error: errorMessage(err),
        });
      }
    }

    return { chunks, pullTools: [] };
  }
}
