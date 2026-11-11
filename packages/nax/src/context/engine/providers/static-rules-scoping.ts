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
 * `ruleTargetsAuthoredTests` answers a different question than "does this
 * concrete scope file match": for stages that declare `producesTestFiles`,
 * it asks whether the rule's `appliesTo:` pattern *itself* denotes a
 * test-authoring location, independent of any concrete source or
 * destination path. This deliberately avoids deriving concrete prospective
 * paths (an earlier version of this fix did that via
 * `deriveSiblingTestCandidates`, extending `scopeFiles` with computed
 * sibling-test candidates) — that approach silently failed against nax's
 * own real config, where `resolveTestFilePatterns` returns extension-only
 * globs (`**\/*.test.ts`) with no directory prefix (`testDirs: []`), so
 * every derived candidate was colocated (`src/x/x.test.ts`) and none of
 * them ever matched a directory-scoped rule like `test/**\/*.test.ts`.
 * Verified against the real resolver output — see the regression test.
 *
 */

import { DEFAULT_SCAN_TEST_DIRS } from "@/test-runners";
import { getStageContextConfig } from "../stage-config";
import type { ContextRequest } from "../types";
import { isTestFile } from "./test-path-derivation";

/** Substitute glob wildcards with a literal placeholder: `**` and `*` -> `x`. */
function representativePath(pattern: string): string {
  return pattern.replaceAll("**", "x").replaceAll("*", "x");
}

/** The pattern's literal segment(s) before its first wildcard, trailing slash trimmed. */
function literalPrefix(pattern: string): string {
  const idx = pattern.indexOf("*");
  const prefix = idx === -1 ? pattern : pattern.slice(0, idx);
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/**
 * Decide whether an `appliesTo:` glob denotes a test-authoring location,
 * independent of any concrete file (nax#2060). Two checks, either sufficient:
 *
 * 1. A representative expansion of the glob (wildcards -> `x`) classifies as
 *    a test file under the SSOT regex — catches extension-shaped patterns
 *    like `**\/*.test.ts` even with no directory convention configured.
 * 2. The glob's literal prefix is a well-known test directory
 *    (`DEFAULT_SCAN_TEST_DIRS` — the same SSOT fallback `test-runners` uses
 *    elsewhere) — catches directory-shaped patterns like `test/**\/*.ts`
 *    whose suffix alone isn't test-shaped (nax's own `test-ratchets` rule).
 */
export function isTestShapedPattern(pattern: string, regex: readonly RegExp[]): boolean {
  if (isTestFile(representativePath(pattern), regex)) return true;
  const prefix = literalPrefix(pattern);
  if (prefix.length === 0) return false;
  // Pad with slashes so a `.some(dir => …)` substring check covers "is dir",
  // "starts with dir/", "ends with /dir", and "dir in the middle" in one line.
  const padded = `/${prefix}/`;
  return DEFAULT_SCAN_TEST_DIRS.some((dir) => padded.includes(`/${dir}/`));
}

/**
 * True when `appliesTo` genuinely targets files the current authoring stage
 * is about to produce — evaluated independent of `request.scopeFiles`, since
 * the resolved evidence set holds only the story's existing (source) files
 * at authoring time. Fails closed to `false` for every non-authoring stage
 * and whenever `resolvedTestPatterns` is absent, so it only ever widens
 * admission for stages that opted in.
 */
export function ruleTargetsAuthoredTests(
  appliesTo: string[] | undefined,
  request: Pick<ContextRequest, "stage" | "resolvedTestPatterns">,
): boolean {
  if (!appliesTo || appliesTo.length === 0) return false;
  if (!request.resolvedTestPatterns) return false;
  if (!getStageContextConfig(request.stage).producesTestFiles) return false;
  const { regex } = request.resolvedTestPatterns;
  return appliesTo.some((pattern) => isTestShapedPattern(pattern, regex));
}
