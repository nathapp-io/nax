/**
 * StaticRulesProvider — appliesTo matching at the repo path frame (nax#2071).
 *
 * `request.scopeFiles` is repo-rooted per the path-frame convention, so a
 * monorepo story's declared paths reach `ruleMatchesScopeFiles` already framed.
 * These pin the MATCHER's behaviour at that frame. They pass on either side of
 * nax#2071, because they feed `scopeFiles` directly rather than through the
 * resolver -- their job is to guard the properties the fix relies on, chiefly
 * that `globToRegex`'s `(?:^|/)` anchor makes admission MONOTONE under framing.
 *
 * The resolver-side regression is pinned in test/unit/pipeline/scope-files.test.ts
 * and the value that reaches the request in
 * test/unit/pipeline/stages/context-scope-files.test.ts.
 *
 * Lives beside static-rules.test.ts rather than inside it: that file is a
 * baselined size breach (803 lines against the 800 cap), so it may not grow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origReadFile: typeof _staticRulesDeps.readFile;
let origGlobInDir: typeof _staticRulesDeps.globInDir;

beforeEach(() => {
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  origFileExists = _staticRulesDeps.fileExists;
  origReadFile = _staticRulesDeps.readFile;
  origGlobInDir = _staticRulesDeps.globInDir;
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.globInDir = () => [];
});

afterEach(() => {
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.globInDir = origGlobInDir;
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

/** A monorepo story's scope file, as the post-nax#2071 resolver spells it. */
const FRAMED_SCOPE_FILE = "packages/app/src/agents/adapter.ts";

describe("StaticRulesProvider — appliesTo at the repo frame (nax#2071)", () => {
  test("a root-anchored rule matches a repo-framed scope file", async () => {
    // The delta the fix buys: before framing, the declared path was
    // "src/agents/adapter.ts" and this rule could not match it.
    setupCanonical([{ fileName: "app.md", content: "App package rules", appliesTo: ["packages/app/src/**"] }]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("App package rules");
  });

  test("a sibling package's rule is not admitted for a repo-framed scope file", async () => {
    // Framing must not over-admit: over-admission is how rule budgets blow up.
    setupCanonical([
      { fileName: "lib.md", content: "Lib package rules", appliesTo: ["packages/lib/**"] },
      { fileName: "global.md", content: "Global rules" },
    ]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Global rules");
  });

  test("a package-relative rule still matches a repo-framed scope file", async () => {
    // Monotonicity: the (?:^|/) anchor means framing cannot drop a rule that
    // was admitted before. Guards anyone tightening that anchor to ^.
    setupCanonical([{ fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Agent-specific coding rules");
  });
});
