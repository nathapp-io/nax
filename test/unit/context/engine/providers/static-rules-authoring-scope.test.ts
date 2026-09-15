/**
 * StaticRulesProvider — appliesTo scoping for authoring stages (nax#2060).
 *
 * Regression coverage for: rules scoped to prospective test paths are
 * filtered out of `tdd-test-writer` — the one stage whose job is to author
 * those files — because `appliesTo:` was matched only against
 * `request.scopeFiles` (the resolved evidence set of files the story
 * already touches, which at test-writing time contains only source files).
 *
 * Split from static-rules-scoping.test.ts per test-architecture.md — that
 * file already covers the general stages:/appliesTo: filter behaviour;
 * this file is scoped to the authoring-stage extension on top of it.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { Logger } from "@/logger";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";

/** Mirrors resolveTestFilePatterns() output via buildResolved() (ADR-009). */
function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

const TEST_PATTERNS = makePatterns(["test/unit/**/*.test.ts"]);

const BASE_REQUEST: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "tdd-test-writer",
  role: "tdd",
  budgetTokens: 8000,
};

function setupCanonical(rules: CanonicalRule[]) {
  const orig = _staticRulesDeps.loadCanonicalRules;
  _staticRulesDeps.loadCanonicalRules = async () => rules;
  return () => {
    _staticRulesDeps.loadCanonicalRules = orig;
  };
}

describe("StaticRulesProvider — authoring-stage appliesTo scoping (nax#2060)", () => {
  test("admits a rule declaring stages:[tdd-test-writer] + appliesTo:[test/**] when scopeFiles are all under src/", async () => {
    const restore = setupCanonical([
      {
        fileName: "test-writing.md",
        content: "Test-authoring rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["test/**/*.test.ts"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...BASE_REQUEST,
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
        resolvedTestPatterns: TEST_PATTERNS,
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]?.content).toContain("Test-authoring rule.");
      expect(result.scopingReport?.appliesToFilteredIds).not.toContain("test-writing");
    } finally {
      restore();
    }
  });

  test("still filters a rule genuinely unrelated to the story's prospective test paths", async () => {
    const restore = setupCanonical([
      {
        fileName: "unrelated.md",
        content: "Unrelated docs rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["docs/**/*.md"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...BASE_REQUEST,
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
        resolvedTestPatterns: TEST_PATTERNS,
      });

      expect(result.chunks).toHaveLength(0);
      expect(result.scopingReport?.appliesToFilteredIds).toContain("unrelated");
    } finally {
      restore();
    }
  });

  test("does not extend scope for non-authoring stages (e.g. tdd-implementer)", async () => {
    const restore = setupCanonical([
      {
        fileName: "test-writing.md",
        content: "Test-authoring rule.",
        stages: ["tdd-implementer"],
        appliesTo: ["test/**/*.test.ts"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...BASE_REQUEST,
        stage: "tdd-implementer",
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
        resolvedTestPatterns: TEST_PATTERNS,
      });

      expect(result.chunks).toHaveLength(0);
      expect(result.scopingReport?.appliesToFilteredIds).toContain("test-writing");
    } finally {
      restore();
    }
  });

  test("does not extend scope when resolvedTestPatterns is absent (fail-open)", async () => {
    const restore = setupCanonical([
      {
        fileName: "test-writing.md",
        content: "Test-authoring rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["test/**/*.test.ts"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...BASE_REQUEST,
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
      });

      expect(result.chunks).toHaveLength(0);
      expect(result.scopingReport?.appliesToFilteredIds).toContain("test-writing");
    } finally {
      restore();
    }
  });

  describe("stage-contradiction warning", () => {
    let warnSpy: Mock<Logger["warn"]> | undefined;

    beforeEach(async () => {
      const { resetLogger, initLogger } = await import("@/logger");
      resetLogger();
      const logger = initLogger({ level: "silent" });
      warnSpy = spyOn(logger, "warn");
    });

    afterEach(async () => {
      warnSpy?.mockRestore();
      warnSpy = undefined;
      const { resetLogger } = await import("@/logger");
      resetLogger();
    });

    test("logs a warning when appliesTo drops every rule that explicitly named this stage", async () => {
      const restore = setupCanonical([
        {
          id: "unrelated",
          fileName: "unrelated.md",
          content: "Unrelated docs rule.",
          stages: ["tdd-test-writer"],
          appliesTo: ["docs/**/*.md"],
        },
      ]);
      try {
        const provider = new StaticRulesProvider();
        await provider.fetch({
          ...BASE_REQUEST,
          scopeFiles: ["src/cost-row-rate-provenance.ts"],
          resolvedTestPatterns: TEST_PATTERNS,
        });

        const call = warnSpy?.mock.calls.find(
          (c) =>
            c[0] === "static-rules" && c[1] === "appliesTo filter dropped every rule that named this stage explicitly",
        );
        expect(call).toBeDefined();
        expect(call?.[2]).toMatchObject({
          storyId: "US-002",
          stage: "tdd-test-writer",
          contradictedRuleIds: ["unrelated"],
        });
      } finally {
        restore();
      }
    });
  });
});
