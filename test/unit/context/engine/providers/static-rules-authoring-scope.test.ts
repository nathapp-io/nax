/**
 * StaticRulesProvider — appliesTo scoping for authoring stages (nax#2060).
 *
 * Regression coverage for: rules scoped to prospective test paths are
 * filtered out of `tdd-test-writer` — the one stage whose job is to author
 * those files — because `appliesTo:` was matched only against
 * `request.scopeFiles` (the resolved evidence set of files the story
 * already touches, which at test-writing time contains only source files).
 *
 * The decisive block below runs against the REAL config loader and the
 * REAL `resolveTestFilePatterns()` resolver — no stubbed `ResolvedTestPatterns`.
 * A prior version of this fix passed a unit test that stubbed
 * `resolvedTestPatterns` with a directory-prefixed glob
 * (`test/unit/**\/*.test.ts`), but nax's own real config resolves to
 * extension-only globs (`**\/*.test.ts`) with `testDirs: []` — the stub
 * hid the actual defect (see `isTestShapedPattern` in
 * `static-rules-scoping.ts` for why a directory-scoped rule like
 * `test/**\/*.ts` needs a second check beyond regex classification).
 *
 * Split from static-rules-scoping.test.ts per test-architecture.md — that
 * file already covers the general stages:/appliesTo: filter behaviour;
 * this file is scoped to the authoring-stage extension on top of it.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { Logger } from "@/logger";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";
import { resolveTestFilePatterns } from "@/test-runners/resolver";

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

// ─────────────────────────────────────────────────────────────────────────────
// Decisive check — REAL loadConfig + REAL resolveTestFilePatterns
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — real resolver output (nax#2060 decisive check)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    _clearRootConfigCache();
  });

  /** A root config mirroring nax's own — extension-only testFilePatterns, no directory prefix. */
  async function makeExtensionOnlyConfigRoot(): Promise<string> {
    const root = makeTempDir("nax-2060-real-resolver-");
    tempDirs.push(root);
    await mkdir(join(root, ".nax"), { recursive: true });
    const config = { execution: { smartTestRunner: { testFilePatterns: ["**/*.test.ts", "**/*.spec.ts"] } } };
    await Bun.write(join(root, ".nax", "config.json"), JSON.stringify(config, null, 2));
    return root;
  }

  test("admits both an extension-shaped and a directory-shaped test rule; still filters an unrelated rule", async () => {
    const root = await makeExtensionOnlyConfigRoot();
    const config = await loadConfig(root);
    const resolvedTestPatterns = await resolveTestFilePatterns(config, root, undefined);

    // Confirms the real defect precondition: no directory prefix in the resolved globs.
    expect(resolvedTestPatterns.testDirs).toEqual([]);
    expect(resolvedTestPatterns.resolution).toBe("root-config");

    const restore = setupCanonical([
      {
        id: "test-writing",
        fileName: "test-writing.md",
        content: "Extension-shaped test rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["**/*.test.ts"],
      },
      {
        id: "test-ratchets",
        fileName: "test-ratchets.md",
        content: "Directory-shaped test rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["test/**/*.ts"],
      },
      {
        id: "unrelated-docs",
        fileName: "unrelated-docs.md",
        content: "Unrelated docs rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["docs/**/*.md"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...BASE_REQUEST,
        repoRoot: root,
        packageDir: root,
        scopeFiles: ["src/agents/acp/adapter.ts", "src/session/session-keeper.ts"],
        resolvedTestPatterns,
      });

      expect(result.scopingReport?.appliesToFilteredIds).not.toContain("test-writing");
      expect(result.scopingReport?.appliesToFilteredIds).not.toContain("test-ratchets");
      expect(result.scopingReport?.appliesToFilteredIds).toContain("unrelated-docs");
      // scopeFileCount stays the real evidence-set size — no fabricated candidate paths added.
      expect(result.scopingReport?.scopeFileCount).toBe(2);

      const contents = result.chunks.map((c) => c.content).join("\n");
      expect(contents).toContain("Extension-shaped test rule.");
      expect(contents).toContain("Directory-shaped test rule.");
      expect(contents).not.toContain("Unrelated docs rule.");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard-condition coverage (stubbed resolvedTestPatterns — mechanism edges,
// not the appliesTo-matching defect itself, which the block above covers)
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — authoring-stage appliesTo scoping guard conditions (nax#2060)", () => {
  test("does not extend matching for non-authoring stages (e.g. tdd-implementer)", async () => {
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

  test("does not extend matching when resolvedTestPatterns is absent (fail-open)", async () => {
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
