/**
 * StaticRulesProvider — rule-set extraction seam and override layer (US-001).
 *
 * The repo/package merge moved out of `StaticRulesProvider.fetch` into
 * `resolveRuleSet`. These are the seam pins that make the extraction safe:
 *
 *  - AC-13/AC-14: `_staticRulesDeps.loadCanonicalRules` is still the loader
 *    behind BOTH the repo and the package layer, and still receives both paths,
 *    so the six existing test files that stub it keep driving `fetch`.
 *  - AC-17: repo-level `appliesTo:` literals are still framed for a
 *    package-contained story even when the package has no rules of its own
 *    (nax#2113).
 *  - AC-15: `config.context.rules.overrideDir` reaches `fetch` through
 *    `createDefaultOrchestrator`, with a negative control proving the chunk
 *    comes from the configured directory and not from a chance scan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeNaxConfig, makeStory, withTempDir } from "@test/helpers";
import { createDefaultOrchestrator } from "@/context/engine/orchestrator-factory";
import { _codeNeighborDeps } from "@/context/engine/providers/code-neighbor";
import { _gitHistoryDeps } from "@/context/engine/providers/git-history";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

const REPO_ROOT = "/repo";
const PACKAGE_DIR = "/repo/packages/api";

const PACKAGE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: REPO_ROOT,
  packageDir: PACKAGE_DIR,
  storyWorkdir: "packages/api",
  stage: "single-session",
  role: "implementer",
  budgetTokens: 12_000,
  touchedFiles: [],
  storyScratchDirs: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// AC-13 / AC-14 — the loader seam survives the extraction
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — canonical loader seam", () => {
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  let loadedWorkdirs: string[];

  beforeEach(() => {
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    loadedWorkdirs = [];
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      loadedWorkdirs.push(workdir);
      return [{ fileName: "stub.md", content: "STUB-BODY" }];
    };
  });

  afterEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("AC-13: a stubbed loader still reaches the emitted chunks", async () => {
    const result = await new StaticRulesProvider().fetch(PACKAGE_REQUEST);

    expect(result.chunks.some((chunk) => chunk.content.includes("STUB-BODY"))).toBe(true);
  });

  test("AC-14: the stub receives both the repo root and the package dir", async () => {
    await new StaticRulesProvider().fetch(PACKAGE_REQUEST);

    expect(loadedWorkdirs).toContain(REPO_ROOT);
    expect(loadedWorkdirs).toContain(PACKAGE_DIR);
  });

  test("AC-17: a repo-level package-relative appliesTo is framed even with no package rules", async () => {
    const literal: CanonicalRule = {
      id: "literal",
      fileName: "literal.md",
      content: "LITERAL-BODY",
      appliesTo: ["src/a.ts"],
    };
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => {
      loadedWorkdirs.push(workdir);
      return workdir === PACKAGE_DIR ? [] : [literal];
    };

    const result = await new StaticRulesProvider().fetch({
      ...PACKAGE_REQUEST,
      scopeFiles: ["packages/api/src/a.ts"],
    });

    expect(loadedWorkdirs).toContain(PACKAGE_DIR);
    expect(result.chunks.some((chunk) => chunk.content.includes("LITERAL-BODY"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15 — the override directory reaches the pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — rules override directory", () => {
  let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;
  let origNeighborGlob: typeof _codeNeighborDeps.glob;
  let origNeighborReadFile: typeof _codeNeighborDeps.readFile;
  let origNeighborDetectLanguage: typeof _codeNeighborDeps.detectLanguage;

  beforeEach(() => {
    origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
    origNeighborGlob = _codeNeighborDeps.glob;
    origNeighborReadFile = _codeNeighborDeps.readFile;
    origNeighborDetectLanguage = _codeNeighborDeps.detectLanguage;
    // The stage's provider set includes git-history and code-neighbor; the
    // request touches no files, so these keep them off the real filesystem.
    _gitHistoryDeps.gitWithTimeout = async () => ({ stdout: "", exitCode: 0, stderr: "" });
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
    _codeNeighborDeps.readFile = async () => "";
    _codeNeighborDeps.detectLanguage = async () => undefined;
  });

  afterEach(() => {
    _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
    _codeNeighborDeps.glob = origNeighborGlob;
    _codeNeighborDeps.readFile = origNeighborReadFile;
    _codeNeighborDeps.detectLanguage = origNeighborDetectLanguage;
  });

  async function assembleWith(
    overrideDir: string | undefined,
    repoRoot: string,
  ): Promise<{ pushMarkdown: string; contents: string[] }> {
    const config = makeNaxConfig({
      context: {
        ...(overrideDir !== undefined && { rules: { overrideDir, overrideMode: "merge" } }),
        testCoverage: { enabled: false },
      },
    });
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const bundle = await orchestrator.assemble({
      ...PACKAGE_REQUEST,
      repoRoot,
      packageDir: repoRoot,
      storyWorkdir: undefined,
      scopeFiles: [],
    });
    return {
      pushMarkdown: bundle.pushMarkdown,
      contents: bundle.chunks.filter((chunk) => chunk.providerId === "static-rules").map((c) => c.content),
    };
  }

  test("AC-15: assembles a static-rules chunk carrying the override rule's body", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await Bun.write(join(overrideDir, "org.md"), "## Org\n\nORG-BODY");

        const bundle = await assembleWith(overrideDir, repoRoot);

        expect(bundle.contents.some((content) => content.includes("ORG-BODY"))).toBe(true);
        expect(bundle.pushMarkdown).toContain("ORG-BODY");
      });
    });
  });

  test("AC-15 (control): the same directory delivers nothing when it is not configured", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await Bun.write(join(overrideDir, "org.md"), "## Org\n\nORG-BODY");

        const bundle = await assembleWith(undefined, repoRoot);

        expect(bundle.contents.every((content) => !content.includes("ORG-BODY"))).toBe(true);
        expect(bundle.pushMarkdown).not.toContain("ORG-BODY");
      });
    });
  });

  test("AC-15: an override rule's id replaces a same-id repo rule across the pipeline", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await Bun.write(join(repoRoot, ".nax/rules/a.md"), "## A\n\nREPO-A");
        await Bun.write(join(overrideDir, "a.md"), "## A\n\nOVERRIDE-A");

        const bundle = await assembleWith(overrideDir, repoRoot);

        expect(bundle.contents).toHaveLength(1);
        const content = bundle.contents[0];
        assertDefined(content, "static-rules chunk");
        expect(content).toContain("OVERRIDE-A");
        expect(bundle.pushMarkdown).not.toContain("REPO-A");
      });
    });
  });
});
