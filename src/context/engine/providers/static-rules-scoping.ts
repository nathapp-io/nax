/**
 * Context Engine v2 — StaticRulesProvider scoping helpers (nax#2060).
 *
 * `ruleMatchesScopeFiles` in static-rules.ts matches a rule's `appliesTo:`
 * frontmatter against `request.scopeFiles` — the resolved evidence set of
 * files the story already touches. That is correct for stages that *read*
 * an existing file set, but wrong for a stage whose entire job is to
 * *produce* files that do not exist yet: no `test/**` pattern can ever
 * match a scope set that only contains source files.
 *
 * `buildEffectiveScopeFiles` extends the match set, for stages that declare
 * `producesTestFiles` in their StageContextConfig, with the prospective test
 * paths derived from each scope file via the shared ADR-009 SSOT resolver
 * output (`request.resolvedTestPatterns`) — the same derivation
 * `CodeNeighborProvider` uses for sibling-test hints, extracted to
 * `test-path-derivation.ts` so both call sites share one implementation.
 * Fails open (returns `request.scopeFiles` unchanged) whenever the stage
 * doesn't author tests or the resolver output is absent, so behaviour for
 * every other stage is unchanged.
 *
 * `warnOnAppliesToStageContradiction` covers the observability half of the
 * fix: when every rule that explicitly named the current stage in its
 * `stages:` frontmatter gets removed by the `appliesTo:` filter, that is a
 * scoping contradiction — the rule author said "this stage needs me" and
 * the path filter said "no file here is yours" — and today it drops silently.
 */

import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { Logger } from "@/logger";
import { getStageContextConfig } from "../stage-config";
import type { ContextRequest } from "../types";
import { deriveSiblingTestCandidates, isTestFile } from "./test-path-derivation";

/**
 * Extend `request.scopeFiles` with prospective test paths for stages that
 * declare `producesTestFiles` (nax#2060). Returns `request.scopeFiles`
 * unchanged for every other stage, or when `resolvedTestPatterns` is absent
 * — fail-open, never invents paths without the SSOT resolver's globs.
 */
export function buildEffectiveScopeFiles(request: ContextRequest): string[] | undefined {
  const { scopeFiles, resolvedTestPatterns, stage } = request;
  if (!scopeFiles || scopeFiles.length === 0) return scopeFiles;
  if (!resolvedTestPatterns || !getStageContextConfig(stage).producesTestFiles) return scopeFiles;

  const { globs, regex } = resolvedTestPatterns;
  const prospective = new Set<string>();
  for (const file of scopeFiles) {
    if (isTestFile(file, regex)) continue;
    for (const candidate of deriveSiblingTestCandidates(file, globs)) prospective.add(candidate);
  }
  return prospective.size === 0 ? scopeFiles : [...scopeFiles, ...prospective];
}

/**
 * Log a warning when the `appliesTo:` filter removed every rule that
 * explicitly declared the current stage in its `stages:` frontmatter — a
 * scoping contradiction that was previously silent (nax#2060).
 *
 * "Explicitly declared" excludes rules with no `stages:` key: those are
 * universal by fail-open design (`ruleMatchesStage`), not a stage-specific
 * claim the `appliesTo:` filter could contradict.
 */
export function warnOnAppliesToStageContradiction(
  logger: Logger,
  request: Pick<ContextRequest, "storyId" | "stage">,
  stageMatchedRules: readonly CanonicalRule[],
  appliesToFilteredIds: readonly string[],
  ruleId: (rule: CanonicalRule) => string,
): void {
  const explicit = stageMatchedRules.filter((rule) => rule.stages?.includes(request.stage));
  if (explicit.length === 0) return;

  const explicitIds = explicit.map(ruleId);
  const survivedFiltering = explicitIds.some((id) => !appliesToFilteredIds.includes(id));
  if (survivedFiltering) return;

  logger.warn("static-rules", "appliesTo filter dropped every rule that named this stage explicitly", {
    storyId: request.storyId,
    stage: request.stage,
    contradictedRuleIds: explicitIds,
  });
}
