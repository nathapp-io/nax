import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLogger, makeNaxConfig, makeStory, withTempDir } from "../../../test/helpers";
import { NeutralityLintError } from "../../../src/context";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import { StaticRulesProvider, _staticRulesDeps } from "../../../src/context/engine/providers/static-rules";
import { _stageAssemblerDeps, assembleForStage } from "../../../src/context/engine/stage-assembler";
import type { ContextBundle, ContextRequest } from "../../../src/context/engine/types";
import {
  RulesFrontmatterError,
  _canonicalLoaderDeps,
  loadCanonicalRules,
} from "../../../src/context/rules/canonical-loader";
import type { CanonicalRule } from "../../../src/context/rules/canonical-loader";
import { parseFrontmatter } from "../../../src/context/rules/rules-frontmatter";
import { getContextFiles, getExpectedFiles } from "../../../src/prd/types";
import { resolveScopeFiles } from "../../../src/pipeline/context-scope";
import { _contextStageDeps, contextStage } from "../../../src/pipeline/stages/context";
import { promptStage } from "../../../src/pipeline/stages/prompt";
import type { PipelineContext } from "../../../src/pipeline/types";
import { rulesLintCommand as rulesLintCommandFromRules, _rulesCLIDeps } from "../../../src/cli/rules";
import { rulesLintCommand } from "../../../src/cli/rules-lint";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Shared spawn mock helper (mirrors test/helpers/review-audit.ts)
// ─────────────────────────────────────────────────────────────────────────────

function makeSpawnMock(stdout: string, exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ═════════════════════════════════════════════════════════════════════════════
// US-001 — Split canonical-loader.ts and cli/rules.ts (AC-1..AC-7)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-001: canonical-loader / cli/rules split", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
  });

  function setupFiles(files: Record<string, string>) {
    const paths = Object.keys(files).sort();
    _canonicalLoaderDeps.globInDir = () => paths;
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p in files) return files[p]!;
      throw new Error(`File not found: ${p}`);
    };
  }

  test("AC-1: parseFrontmatter('no frontmatter content here') returns priority:100, paths:[], warnings:[]", () => {
    const result = parseFrontmatter("no frontmatter content here", "rule.md");
    expect(result.priority).toBe(100);
    expect(result.paths ?? []).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
  });

  test("AC-2: loadCanonicalRules resolves a CanonicalRule with priority 35", async () => {
    setupFiles({ "/rules/rule1.md": "---\npriority: 35\npaths:\n  - rule1\n---\n\nBody." });
    const rules = await loadCanonicalRules("/rules/..");
    expect(rules[0]?.priority).toBe(35);
  });

  test("AC-3: loadCanonicalRules resolves a CanonicalRule with paths equal to ['apps/api']", async () => {
    setupFiles({ "/rules/rule1.md": "---\npaths:\n  - apps/api\n---\n\nBody." });
    const rules = await loadCanonicalRules("/rules/..");
    expect(JSON.stringify(rules[0]?.paths)).toBe('["apps/api"]');
  });

  test("AC-4: loadCanonicalRules rejects with RulesFrontmatterError for a rule missing a closing fence", async () => {
    setupFiles({ "/rules/broken.md": "---\nbroken frontmatter\nno closing fence" });
    await expect(loadCanonicalRules("/rules/..")).rejects.toBeInstanceOf(RulesFrontmatterError);
  });

  test("AC-5: src/context exports NeutralityLintError as an Error-derived constructor", async () => {
    const mod = await import("../../../src/context");
    expect(typeof mod.NeutralityLintError).toBe("function");
    expect(mod.NeutralityLintError.prototype instanceof Error).toBe(true);
    expect(NeutralityLintError).toBe(mod.NeutralityLintError);
  });

  test("AC-6: rulesLintCommand resolves without throwing when no .nax/rules/**/*.md files exist", async () => {
    const logger = makeLogger();
    const origLogger = _rulesCLIDeps.getLogger;
    const origGlob = _rulesCLIDeps.globCanonicalRuleFiles;
    const origLoad = _rulesCLIDeps.loadCanonicalRules;
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [];

    try {
      await withTempDir(async (emptyDir) => {
        await expect(rulesLintCommand({ dir: emptyDir })).resolves.toBeUndefined();
      });
      expect(logger.calls.filter((c) => c.level === "warn" || c.level === "error")).toHaveLength(0);
    } finally {
      _rulesCLIDeps.getLogger = origLogger;
      _rulesCLIDeps.globCanonicalRuleFiles = origGlob;
      _rulesCLIDeps.loadCanonicalRules = origLoad;
    }
  });

  test("AC-7: src/cli/rules re-exports the same rulesLintCommand reference as src/cli/rules-lint", () => {
    expect(rulesLintCommandFromRules).toBe(rulesLintCommand);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-002 — stages: frontmatter parsing and displaced-frontmatter detection
// (AC-8..AC-21)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-002: stages: frontmatter + displaced-frontmatter detection", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
    origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [];
    _canonicalLoaderDeps.readFile = async () => "";
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  function setupFiles(files: Record<string, string>) {
    const paths = Object.keys(files).sort();
    _canonicalLoaderDeps.globInDir = () => paths;
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p in files) return files[p]!;
      throw new Error(`File not found: ${p}`);
    };
  }

  test("AC-8: parseFrontmatter returns stages equal to ['execution', 'review']", () => {
    const result = parseFrontmatter("---\npriority: 1\nstages:\n  - execution\n  - review\n---", "rule.md");
    expect(result.stages).toEqual(["execution", "review"]);
  });

  test("AC-9: parseFrontmatter returns stages as undefined when the key is absent", () => {
    const result = parseFrontmatter("---\npriority: 1\n---", "rule.md");
    expect(result.stages).toBeUndefined();
  });

  test("AC-10: parseFrontmatter returns stages as undefined for an empty list", () => {
    const result = parseFrontmatter("---\nstages: []\n---", "rule.md");
    expect(result.stages).toBeUndefined();
  });

  test("AC-11: parseFrontmatter throws RulesFrontmatterError for a non-string stages entry", () => {
    expect(() => parseFrontmatter("---\nstages:\n  - execution\n  - 123\n---", "rule.md")).toThrow(
      RulesFrontmatterError,
    );
  });

  test("AC-12: parseFrontmatter does not throw for a rule whose only key is stages", () => {
    expect(() => parseFrontmatter("---\nstages:\n  - execution\n---", "rule.md")).not.toThrow();
  });

  test("AC-13: parseFrontmatter throws RulesFrontmatterError naming the offending unknown key", () => {
    expect(() => parseFrontmatter("---\nunknownKey: value\n---", "rule.md")).toThrow(/unknownKey/);
  });

  test("AC-14: loadCanonicalRules returns a CanonicalRule with stages equal to ['plan']", async () => {
    setupFiles({ "/rules/plan-rule.md": "---\nstages:\n  - plan\n---\n\nBody." });
    const rules = await loadCanonicalRules("/rules/..");
    expect(rules[0]?.stages).toEqual(["plan"]);
  });

  test("AC-15: parseFrontmatter warns on an unrecognised stage name but still returns it", () => {
    const result = parseFrontmatter("---\nstages:\n  - not-a-real-stage\n---", "rule.md");
    expect(result.warnings.some((w) => w.includes("not-a-real-stage"))).toBe(true);
    expect(result.stages).toEqual(["not-a-real-stage"]);
  });

  test("AC-16: parseFrontmatter returns an empty warnings list for a real-but-unmapped stage", () => {
    const result = parseFrontmatter("---\nstages:\n  - acceptance-setup\n---", "rule.md");
    expect(result.warnings).toEqual([]);
  });

  test("AC-17: parseFrontmatter warns on displaced frontmatter preceded by a BOM", () => {
    const result = parseFrontmatter("﻿---\n---", "rule.md");
    expect(result.warnings.some((w) => /displaced|BOM/i.test(w))).toBe(true);
  });

  test("AC-18: parseFrontmatter warns on displaced frontmatter preceded by a blank line", () => {
    const result = parseFrontmatter("\n\n---", "rule.md");
    expect(result.warnings.some((w) => /displaced|frontmatter/i.test(w))).toBe(true);
  });

  test("AC-19: parseFrontmatter loses declared values when frontmatter is displaced by a blank line", () => {
    const result = parseFrontmatter("\n\n---\npriority: 100\n---", "rule.md");
    expect(result.priority).toBe(100);
    expect(result.paths).toBeUndefined();
  });

  test("AC-20: loadCanonicalRules carries the parser's displaced-frontmatter warning on CanonicalRule.warnings", async () => {
    setupFiles({ "/rules/displaced.md": "\n---\npriority: 50\n---\n\nBody." });
    const rules = await loadCanonicalRules("/rules/..");
    expect(rules[0]?.warnings?.some((w) => /displaced|frontmatter/i.test(w))).toBe(true);
  });

  test("AC-21: loadCanonicalRules logs a warning through _canonicalLoaderDeps.getLogger() for a displaced-frontmatter file", async () => {
    setupFiles({ "/rules/displaced.md": "\n---\npriority: 50\n---\n\nBody." });
    const logger = makeLogger();
    _canonicalLoaderDeps.getLogger = () => logger as unknown as ReturnType<typeof _canonicalLoaderDeps.getLogger>;

    await loadCanonicalRules("/rules/..");

    const displacedWarnings = logger.calls.filter(
      (c) => c.level === "warn" && (/displaced/i.test(c.message) || /BOM/i.test(c.message)),
    );
    expect(displacedWarnings).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-003 — resolveScopeFiles + threading into contextStage / promptStage /
// assembleForStage (AC-22..AC-32)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-003: resolveScopeFiles + request producers", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock("");
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  function makeScopeCtx(overrides: { contextFiles?: string[]; expectedFiles?: string[]; storyGitRef?: string } = {}) {
    const story = makeStory({
      contextFiles: overrides.contextFiles,
      expectedFiles: overrides.expectedFiles,
      storyGitRef: overrides.storyGitRef ?? "abc123",
    });
    return { story, workdir: "/repo" } as unknown as PipelineContext;
  }

  test("AC-22: returns the union of contextFiles and expectedFiles when the diff yields nothing extra", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("");
    const ctx = makeScopeCtx({ contextFiles: ["a.ts", "b.ts"], expectedFiles: ["c.ts"] });
    const result = await resolveScopeFiles(ctx);
    expect([...result].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("AC-23: returns no duplicate entries when a path appears in both contextFiles and the diff", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("a.ts\n");
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"] });
    const result = await resolveScopeFiles(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("a.ts");
  });

  test("AC-24: returns entries in ascending lexicographic order", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("z.ts\nm.ts\n");
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"], expectedFiles: ["b.ts"] });
    const result = await resolveScopeFiles(ctx);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.localeCompare(result[i + 1]!)).toBeLessThanOrEqual(0);
    }
  });

  test("AC-25: includes a file returned by the diff that is in neither contextFiles nor expectedFiles", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("new.ts\n");
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"], expectedFiles: ["b.ts"] });
    const result = await resolveScopeFiles(ctx);
    expect(result).toContain("new.ts");
  });

  test("AC-26: fails open to declared files, without throwing, when the git ref is unresolvable", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"], expectedFiles: ["b.ts"] });

    const result = await resolveScopeFiles(ctx);
    expect([...result].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-27: fails open to declared files, without throwing, when collectDiffFileList returns undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 1); // non-zero exit -> collectDiffFileList resolves undefined
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"], expectedFiles: ["b.ts"] });

    const result = await resolveScopeFiles(ctx);
    expect([...result].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-28: fails open to declared files, without throwing, when collectDiffFileList's spawn throws", async () => {
    _diffUtilsDeps.spawn = mock(() => {
      throw new Error("spawn failed");
    }) as unknown as typeof _diffUtilsDeps.spawn;
    const ctx = makeScopeCtx({ contextFiles: ["a.ts"], expectedFiles: ["b.ts"] });

    let threw = false;
    let result: string[] = [];
    try {
      result = await resolveScopeFiles(ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect([...result].sort()).toEqual(["a.ts", "b.ts"]);
  });

  // ── Request producer seams ──────────────────────────────────────────────

  function makeBundle(): ContextBundle {
    return {
      pushMarkdown: "",
      pullTools: [],
      digest: "d",
      manifest: {
        requestId: "req-1",
        stage: "context",
        totalBudgetTokens: 8_000,
        usedTokens: 0,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
      chunks: [],
    } as unknown as ContextBundle;
  }

  test("AC-29: contextStage.execute threads scopeFiles equal to resolveScopeFiles(ctx) into the request", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("");
    const story = makeStory({ contextFiles: ["a.ts", "b.ts"], expectedFiles: ["c.ts"], storyGitRef: "abc123" });

    const origCreateOrchestrator = _contextStageDeps.createOrchestrator;
    const origReadDigest = _contextStageDeps.readDigest;
    const origWriteDigest = _contextStageDeps.writeDigest;
    let captured: ContextRequest | undefined;
    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};
    _contextStageDeps.createOrchestrator = () =>
      ({
        async assemble(req: ContextRequest) {
          captured = req;
          return makeBundle();
        },
        rebuildForAgent: () => makeBundle(),
      }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;

    try {
      const ctx = {
        config: { context: { v2: { enabled: true }, featureEngine: { budgetTokens: 8_000 } } },
        rootConfig: {},
        prd: { feature: "test-feature" },
        story,
        stories: [],
        routing: {},
        projectDir: "/repo",
        workdir: "/repo",
        hooks: {},
        sessionScratchDir: "/repo/.nax/scratch",
        sessionId: "sess-001",
      } as unknown as PipelineContext;

      await contextStage.execute(ctx);
      const expected = await resolveScopeFiles(ctx);

      expect([...(captured?.scopeFiles ?? [])].sort()).toEqual([...expected].sort());
    } finally {
      _contextStageDeps.createOrchestrator = origCreateOrchestrator;
      _contextStageDeps.readDigest = origReadDigest;
      _contextStageDeps.writeDigest = origWriteDigest;
    }
  });

  test("AC-30: promptStage.execute threads scopeFiles equal to resolveScopeFiles(ctx) into the request", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("");
    const story = makeStory({
      id: "US-001",
      title: "T",
      description: "D",
      acceptanceCriteria: [],
      contextFiles: ["a.ts"],
      expectedFiles: ["b.ts"],
      storyGitRef: "abc123",
      status: "in-progress",
    });

    const origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    const origReaddir = _stageAssemblerDeps.readdir;
    const origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    let captured: ContextRequest | undefined;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
    _stageAssemblerDeps.createOrchestrator = () =>
      ({
        async assemble(req: ContextRequest) {
          captured = req;
          return makeBundle();
        },
        rebuildForAgent: () => makeBundle(),
      }) as unknown as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    try {
      const ctx = {
        config: makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } } as never),
        rootConfig: makeNaxConfig(),
        prd: { feature: "test-feature", userStories: [story] },
        story,
        stories: [story],
        routing: { testStrategy: "tdd-simple" },
        projectDir: "/repo",
        workdir: "/repo",
        hooks: {},
      } as unknown as PipelineContext;

      await promptStage.execute(ctx);
      const expected = await resolveScopeFiles(ctx);

      expect([...(captured?.scopeFiles ?? [])].sort()).toEqual([...expected].sort());
    } finally {
      _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
      _stageAssemblerDeps.readdir = origReaddir;
      _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    }
  });

  function makeAssembleCtx(story: ReturnType<typeof makeStory>): PipelineContext {
    return {
      config: { context: { v2: { enabled: true, pluginProviders: [] } }, autoMode: { defaultAgent: "claude" } },
      rootConfig: { autoMode: { defaultAgent: "claude" } },
      prd: { feature: "test-feature", userStories: [] },
      story,
      stories: [],
      routing: { agent: undefined },
      projectDir: undefined,
      workdir: "/repo",
      hooks: {},
    } as unknown as PipelineContext;
  }

  test("AC-31: assembleForStage builds a request whose scopeFiles equals StageAssembleOptions.scopeFiles", async () => {
    const origReaddir = _stageAssemblerDeps.readdir;
    const origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    const origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;

    let captured: ContextRequest | undefined;
    _stageAssemblerDeps.createOrchestrator = () =>
      ({
        async assemble(req: ContextRequest) {
          captured = req;
          return makeBundle();
        },
        rebuildForAgent: () => makeBundle(),
      }) as unknown as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    try {
      const story = makeStory({ contextFiles: ["z.ts"] });
      await assembleForStage(makeAssembleCtx(story), "execution", { scopeFiles: ["x.ts", "y.ts"] });
      expect(captured?.scopeFiles).toEqual(["x.ts", "y.ts"]);
    } finally {
      _stageAssemblerDeps.readdir = origReaddir;
      _stageAssemblerDeps.readDescriptor = origReadDescriptor;
      _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
    }
  });

  test("AC-32: assembleForStage's touchedFiles still equals getContextFiles(story) when scopeFiles is supplied", async () => {
    const origReaddir = _stageAssemblerDeps.readdir;
    const origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    const origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;

    let captured: ContextRequest | undefined;
    _stageAssemblerDeps.createOrchestrator = () =>
      ({
        async assemble(req: ContextRequest) {
          captured = req;
          return makeBundle();
        },
        rebuildForAgent: () => makeBundle(),
      }) as unknown as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    try {
      const story = makeStory({ contextFiles: ["a.ts", "b.ts"] });
      await assembleForStage(makeAssembleCtx(story), "execution", { scopeFiles: ["x.ts"] });
      expect(captured?.touchedFiles).toEqual(getContextFiles(story));
    } finally {
      _stageAssemblerDeps.readdir = origReaddir;
      _stageAssemblerDeps.readDescriptor = origReadDescriptor;
      _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-004 — StaticRulesProvider applies both scoping axes + scopingReport
// (AC-33..AC-45)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-004: StaticRulesProvider scoping filters", () => {
  let origReadFile: typeof _staticRulesDeps.readFile;
  let origFileExists: typeof _staticRulesDeps.fileExists;
  let origGlobInDir: typeof _staticRulesDeps.globInDir;
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    origReadFile = _staticRulesDeps.readFile;
    origFileExists = _staticRulesDeps.fileExists;
    origGlobInDir = _staticRulesDeps.globInDir;
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.fileExists = async () => false;
    _staticRulesDeps.readFile = async () => "";
    _staticRulesDeps.globInDir = () => [];
  });

  afterEach(() => {
    _staticRulesDeps.readFile = origReadFile;
    _staticRulesDeps.fileExists = origFileExists;
    _staticRulesDeps.globInDir = origGlobInDir;
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  const BASE_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
  };

  function setupCanonical(rules: CanonicalRule[]) {
    _staticRulesDeps.loadCanonicalRules = async () => rules;
  }

  test("AC-33: returns no chunk for a rule declaring stages:['plan'] when the request's stage is 'execution'", async () => {
    setupCanonical([{ fileName: "plan-only.md", content: "Plan-only content", stages: ["plan"] } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(result.chunks).toHaveLength(0);
  });

  test("AC-34: returns a chunk for a rule declaring stages:['plan'] when the request's stage is 'plan'", async () => {
    setupCanonical([{ fileName: "plan-only.md", content: "Plan-only content", stages: ["plan"] } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "plan" });
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("AC-35: returns a chunk for a rule with no stages key regardless of the request's stage", async () => {
    setupCanonical([{ fileName: "global.md", content: "Global content" } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    for (const stage of ["execution", "plan", "implement", "review"]) {
      const result = await provider.fetch({ ...BASE_REQUEST, stage });
      expect(result.chunks.some((c) => c.id.startsWith("static-rules:global:"))).toBe(true);
    }
  });

  test("AC-36: returns no chunk for a rule declaring appliesTo:['test/**/*.test.ts'] when scopeFiles is ['src/foo.ts']", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/foo.ts"] } as ContextRequest);
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-rule:"))).toBe(false);
  });

  test("AC-37: returns a chunk when scopeFiles contains a matching test file, even with touchedFiles empty", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...BASE_REQUEST,
      scopeFiles: ["test/unit/foo.test.ts"],
      touchedFiles: [],
    } as ContextRequest);
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-rule:"))).toBe(true);
  });

  test("AC-38: returns a chunk for a rule declaring appliesTo when scopeFiles is empty (fail-open)", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] } as ContextRequest);
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-rule:"))).toBe(true);
  });

  test("AC-39: scopingReport.appliesToInertCount equals 1 when a rule declares appliesTo and scopeFiles is empty", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] } as ContextRequest);
    expect(result.scopingReport?.appliesToInertCount).toBe(1);
  });

  test("AC-40: scopingReport.appliesToInertCount equals 0 when scopeFiles is non-empty", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...BASE_REQUEST,
      scopeFiles: ["test/unit/foo.test.ts"],
    } as ContextRequest);
    expect(result.scopingReport?.appliesToInertCount).toBe(0);
  });

  test("AC-41: scopingReport.stageFilteredIds contains the id of the rule dropped by the stages: filter", async () => {
    setupCanonical([{ fileName: "plan-only.md", content: "Plan-only content", stages: ["plan"] } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(result.scopingReport?.stageFilteredIds).toContain("plan-only");
  });

  test("AC-42: scopingReport.appliesToFilteredIds contains the id of the rule dropped by the appliesTo: filter", async () => {
    setupCanonical([
      { fileName: "test-rule.md", content: "Test-only content", appliesTo: ["test/**/*.test.ts"] } as CanonicalRule,
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/foo.ts"] } as ContextRequest);
    expect(result.scopingReport?.appliesToFilteredIds).toContain("test-rule");
  });

  test("AC-43: scopingReport.scopeFileCount equals the number of entries in request.scopeFiles", async () => {
    setupCanonical([{ fileName: "global.md", content: "Global content" } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      ...BASE_REQUEST,
      scopeFiles: ["a.ts", "b.ts", "c.ts"],
    } as ContextRequest);
    expect(result.scopingReport?.scopeFileCount).toBe(3);
  });

  test("AC-44: budgetPressure is identical whether or not scoping filters remove rules, when the corpus fits the budget either way", async () => {
    const rules: CanonicalRule[] = [
      { fileName: "global.md", content: "Global content" } as CanonicalRule,
      { fileName: "plan-only.md", content: "Plan-only content", stages: ["plan"] } as CanonicalRule,
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });

    const withBothRules = await provider.fetch({ ...BASE_REQUEST, stage: "plan" });
    const withOneFiltered = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });

    expect(withBothRules.budgetPressure).toEqual(withOneFiltered.budgetPressure);
  });

  test("AC-45: orchestrator manifest.providerResults['static-rules'] carries the provider's scopingReport", async () => {
    setupCanonical([{ fileName: "plan-only.md", content: "Plan-only content", stages: ["plan"] } as CanonicalRule]);
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const request: ContextRequest = { ...BASE_REQUEST, stage: "execution", providerIds: ["static-rules"] };

    const directResult = await provider.fetch(request);
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble(request);

    const providerResult = bundle.manifest.providerResults?.find((p) => p.providerId === "static-rules");
    expect(providerResult?.scopingReport).toEqual(directResult.scopingReport);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-005 — nax rules lint surfaces the new scoping warnings (AC-46..AC-50)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-005: rulesLintCommand scoping warnings", () => {
  let origGetLogger: typeof _rulesCLIDeps.getLogger;
  let origLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
  let origGlobCanonicalRuleFiles: typeof _rulesCLIDeps.globCanonicalRuleFiles;
  let origGlobHasMatch: typeof _rulesCLIDeps.globHasMatch;

  beforeEach(() => {
    origGetLogger = _rulesCLIDeps.getLogger;
    origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;
    origGlobCanonicalRuleFiles = _rulesCLIDeps.globCanonicalRuleFiles;
    origGlobHasMatch = _rulesCLIDeps.globHasMatch;
  });

  afterEach(() => {
    _rulesCLIDeps.getLogger = origGetLogger;
    _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
    _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFiles;
    _rulesCLIDeps.globHasMatch = origGlobHasMatch;
  });

  test("AC-46: warns naming the rule file when it declares an unrecognised stage", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      const ruleFile = join(workdir, ".nax", "rules", "bad-stage.md");
      await Bun.write(
        ruleFile,
        ["---", "stages:", '  - "invalid-stage-xyz"', "---", "", "Body."].join("\n"),
      );
      _rulesCLIDeps.globCanonicalRuleFiles = () => [".nax/rules/bad-stage.md"];

      await rulesLintCommand({ dir: workdir });

      const warnings = logger.calls.filter(
        (c) => c.level === "warn" && (/unrecognised stage/i.test(c.message) || c.message.includes("invalid-stage-xyz")),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.data?.ruleFile).toBe(ruleFile);
    });
  });

  test("AC-47: emits no unrecognised-stage warning when every declared stage is recognised", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await Bun.write(
        join(workdir, ".nax", "rules", "good-stage.md"),
        ["---", "stages:", '  - "implement"', '  - "review"', "---", "", "Body."].join("\n"),
      );
      _rulesCLIDeps.globCanonicalRuleFiles = () => [".nax/rules/good-stage.md"];

      await rulesLintCommand({ dir: workdir });

      const warnings = logger.calls.filter((c) => c.level === "warn" && /unrecognised stage/i.test(c.message));
      expect(warnings).toHaveLength(0);
    });
  });

  test("AC-48: warns naming the rule file when its content begins with a blank line before '---'", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      const ruleFile = join(workdir, ".nax", "rules", "displaced.md");
      await Bun.write(ruleFile, "\n---\npriority: 10\n---\n\nBody.");
      _rulesCLIDeps.globCanonicalRuleFiles = () => [".nax/rules/displaced.md"];

      await rulesLintCommand({ dir: workdir });

      const warnings = logger.calls.filter(
        (c) => c.level === "warn" && (/displaced/i.test(c.message) || /frontmatter/i.test(c.message)),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.data?.ruleFile).toBe(ruleFile);
    });
  });

  test("AC-49: resolves without throwing (or rejecting) when a rule file carries displaced frontmatter", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await Bun.write(join(workdir, ".nax", "rules", "displaced.md"), "\n---\npriority: 10\n---\n\nBody.");
      _rulesCLIDeps.globCanonicalRuleFiles = () => [".nax/rules/displaced.md"];

      await expect(rulesLintCommand({ dir: workdir })).resolves.toBeUndefined();
    });
  });

  test("AC-50: still reports the existing dead-glob warning for an appliesTo glob matching no files", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      const ruleFile = join(workdir, ".nax", "rules", "dead-glob.md");
      await Bun.write(
        ruleFile,
        ["---", "appliesTo:", '  - "no/such/path/**"', "---", "", "Body."].join("\n"),
      );
      await Bun.write(join(workdir, "real-file.ts"), "export const x = 1;\n");
      _rulesCLIDeps.globCanonicalRuleFiles = () => [".nax/rules/dead-glob.md"];

      await rulesLintCommand({ dir: workdir });

      const warnings = logger.calls.filter((c) => c.level === "warn");
      const combined = warnings.map((c) => `${c.message} ${JSON.stringify(c.data ?? {})}`).join(" | ");
      expect(combined).toContain("dead-glob.md");
      expect(combined).toContain("no/such/path/**");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// US-006 — stages: declared across the real .nax/rules store (AC-51..AC-56)
// ═════════════════════════════════════════════════════════════════════════════

describe("US-006: real .nax/rules store carries stages: declarations", () => {
  test("AC-51: test-writing.md's CanonicalRule.stages does not contain 'plan'", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => (r.path ?? r.fileName).endsWith("test-writing.md"));
    expect(Array.isArray(rule?.stages)).toBe(true);
    expect(rule?.stages).not.toContain("plan");
  });

  test("AC-52: forbidden-patterns.md's CanonicalRule.stages is undefined", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    const rule = rules.find((r) => (r.path ?? r.fileName).endsWith("forbidden-patterns.md"));
    expect(rule?.stages).toBeUndefined();
  });

  test("AC-53: StaticRulesProvider.fetch({stage:'plan'}) returns no chunk deriving from test-writing.md", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      storyId: "US-006",
      repoRoot: process.cwd(),
      packageDir: process.cwd(),
      stage: "plan",
      role: "implementer",
      budgetTokens: 8_000,
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(false);
  });

  test("AC-54: StaticRulesProvider.fetch({stage:'plan'}) returns a chunk deriving from forbidden-patterns.md", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      storyId: "US-006",
      repoRoot: process.cwd(),
      packageDir: process.cwd(),
      stage: "plan",
      role: "implementer",
      budgetTokens: 8_000,
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:forbidden-patterns:"))).toBe(true);
  });

  test("AC-55: StaticRulesProvider.fetch({stage:'tdd-test-writer'}) returns a chunk deriving from test-writing.md", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({
      storyId: "US-006",
      repoRoot: process.cwd(),
      packageDir: process.cwd(),
      stage: "tdd-test-writer",
      role: "implementer",
      budgetTokens: 8_000,
    });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(true);
  });

  test("AC-56: every CanonicalRule loaded from the repository's .nax/rules directory has an empty warnings list", async () => {
    const rules = await loadCanonicalRules(process.cwd());
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.warnings ?? []).toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: getExpectedFiles is exercised through resolveScopeFiles above; this
// direct check pins its contract independent of the resolver.
// ─────────────────────────────────────────────────────────────────────────────

describe("getExpectedFiles sanity", () => {
  test("returns story.expectedFiles verbatim", () => {
    const story = makeStory({ expectedFiles: ["x.ts"] });
    expect(getExpectedFiles(story)).toEqual(["x.ts"]);
  });
});