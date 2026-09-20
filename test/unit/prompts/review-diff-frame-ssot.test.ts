/**
 * Cross-builder invariants for the review builders' git argv (PR 5, M6/M9/M10).
 *
 * A. The three ref-mode diff builders must emit the SAME nax-metadata exclusion
 *    set, and that set must be the SSOT (`src/utils/nax-owned-paths.ts`). #2101
 *    added three hand-rolled copies that disagreed with each other, so a nested
 *    `packages/api/tools/.nax/` was excluded on two arms and visible on the
 *    third. Asserting "one builder equals a snapshot" would not catch that; the
 *    invariant is agreement with the SSOT.
 *
 * E. Native (`Git` tool) and ACP (shell) renderings of the same builder must
 *    carry the same exclusions. Before this change the semantic arm's
 *    native full diff had no `fullExclude`, so a single-package repo on the
 *    native arm saw `.nax/` artifacts the ACP arm did not (#2096 territory — the
 *    delivered prompt is assembled at dispatch, so this asserts builder output).
 *
 * F. The ref-mode prompt must state that out-of-package changes were omitted.
 *    `-- .` scopes the diff to the package cwd, so a monorepo story satisfied by
 *    a sibling-package edit yields zero evidence; nothing else in the prompt
 *    says the edit was dropped (M10).
 */
import { describe, expect, test } from "bun:test";
import { makeAdversarialReviewConfig, makeSemanticReviewConfig } from "@test/helpers";
import { ReviewPromptBuilder } from "@/prompts";
import { AdversarialReviewPromptBuilder } from "@/prompts/builders/adversarial-review-builder";
import { applyDiffAccess, DIFF_SCOPE_OMISSION_NOTICE } from "@/prompts/sections/diff-access";
import type { SemanticStory } from "@/review/types";
import { NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

const REF = "abc123";
const STAT = " src/a.ts | 2 +-";

const STORY: SemanticStory = {
  id: "US-001",
  title: "Add semantic review",
  description: "Implement LLM-based semantic review for story diffs.",
  acceptanceCriteria: ["LLM is called with story diff"],
};

function semanticPrompt(): string {
  return new ReviewPromptBuilder().buildSemanticReviewPrompt(
    STORY,
    makeSemanticReviewConfig({ model: "balanced", diffMode: "ref", rules: [] }),
    { mode: "ref", storyGitRef: REF, stat: STAT, excludePatterns: [":!*.test.ts"] },
  );
}

function adversarialPrompt(): string {
  return new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
    STORY,
    makeAdversarialReviewConfig({ model: "balanced", diffMode: "ref", rules: [], excludePatterns: [":!*.test.ts"] }),
    {
      mode: "ref",
      storyGitRef: REF,
      stat: STAT,
      excludePatterns: [":!*.test.ts"],
      refExcludePatterns: [":!*.test.ts"],
    },
  );
}

const BUILDERS: ReadonlyArray<[string, () => string]> = [
  ["semantic", semanticPrompt],
  ["adversarial", adversarialPrompt],
];

/** Every nax-metadata pathspec quoted anywhere in the prompt, first-seen order. */
function naxPathspecs(prompt: string): string[] {
  const tokens = [...prompt.matchAll(/'(:![^']*nax[^']*)'/g)].map((m) => m[1]);
  return [...new Set(tokens)];
}

/** The ACP full-diff command line's nax-metadata pathspecs. */
function acpFullExclude(prompt: string): string[] {
  const acp = applyDiffAccess(prompt, "acp");
  const line = acp.split("\n").find((l) => /Full diff/i.test(l) && l.includes("git diff "));
  const tokens = [...(line?.matchAll(/'(:![^']*nax[^']*)'/g) ?? [])].map((m) => m[1]);
  return [...new Set(tokens)];
}

/** The native full-diff `Git` call's nax-metadata paths. */
function nativeFullExclude(prompt: string): string[] {
  const native = applyDiffAccess(prompt, "native");
  for (const match of native.matchAll(/\bGit (\{[^\n]*\})/g)) {
    const call = JSON.parse(match[1]) as {
      subcommand?: string;
      nameOnly?: boolean;
      diffFilter?: string;
      paths?: string[];
    };
    if (call.subcommand === "diff" && !call.nameOnly && !call.diffFilter) {
      return [...new Set((call.paths ?? []).filter((p) => p.includes("nax")))];
    }
  }
  return [];
}

describe("review diff frame — nax-exclusion SSOT (Part A)", () => {
  test.each(BUILDERS)("%s: every nax-exclusion pathspec is the SSOT set", (_label, build) => {
    expect(naxPathspecs(build())).toEqual([...NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS]);
  });

  test("the SSOT excludes root and nested .nax/ and .nax-pids", () => {
    expect([...NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS]).toEqual([
      ":!.nax/",
      ":!**/.nax/**",
      ":!.nax-pids",
      ":!**/.nax-pids",
    ]);
  });
});

describe("review diff frame — native/ACP exclusion parity (Part E)", () => {
  test.each([
    ["semantic", semanticPrompt],
  ])("%s: native and ACP full diffs carry the same nax exclusions", (_label, build) => {
    const prompt = build();
    expect(acpFullExclude(prompt)).toEqual([...NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS]);
    expect(nativeFullExclude(prompt)).toEqual([...NAX_OWNED_REVIEW_EXCLUDE_PATHSPECS]);
  });
});

describe("review diff frame — out-of-package omission is stated (Part F)", () => {
  test.each(BUILDERS)("%s: states out-of-package changes are not shown", (_label, build) => {
    const prompt = build();
    expect(prompt).toContain(DIFF_SCOPE_OMISSION_NOTICE);
    expect(prompt).toMatch(/outside it are not shown/i);
  });
});
