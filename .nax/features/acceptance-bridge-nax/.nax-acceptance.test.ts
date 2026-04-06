/**
 * Acceptance Tests: acceptance-bridge-nax
 *
 * Covers 35 ACs across:
 *   - buildAcceptanceSection (prompt section builder)
 *   - PromptBuilder.acceptanceContext() (new method)
 *   - promptStage acceptance file loading
 *   - loadAcceptanceTestContent (new signature)
 *   - GenerateFromPRDOptions: implementationContext + previousFailure
 *   - regenerateAcceptanceTest with git diff integration
 *   - buildSourceFixPrompt with testFileContent
 *   - SemanticVerdict: persist / load
 *   - completionStage: persist on semantic check
 *   - acceptanceSetupStage: clear verdicts on fingerprint mismatch
 *   - runAcceptanceLoop / runFixRouting with semanticVerdicts
 *   - isTestLevelFailure with semanticVerdicts param
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Feature imports (created / modified as part of this feature) ---
import { buildAcceptanceSection } from "../../../src/prompts/sections/acceptance-section";
import { PromptBuilder } from "../../../src/prompts/builder";
import { promptStage } from "../../../src/pipeline/stages/prompt";
import { loadAcceptanceTestContent } from "../../../src/acceptance/content-loader";
import type { SemanticVerdict } from "../../../src/acceptance/semantic-verdict";
import { loadSemanticVerdicts, persistSemanticVerdict } from "../../../src/acceptance/semantic-verdict";
import { buildDiagnosisPrompt } from "../../../src/acceptance/fix-diagnosis";
import { buildSourceFixPrompt } from "../../../src/acceptance/fix-executor";
import type { ExecuteSourceFixOptions } from "../../../src/acceptance/fix-executor";
import {
  _acceptanceLoopDeps,
  _regenerateDeps,
  isTestLevelFailure,
  runFixRouting,
} from "../../../src/execution/lifecycle/acceptance-loop";
import { completionStage } from "../../../src/pipeline/stages/completion";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "../../../src/pipeline/stages/acceptance-setup";
import type { GenerateFromPRDOptions } from "../../../src/acceptance/types";
import { _generatorPRDDeps, generateFromPRD } from "../../../src/acceptance";
import type { ReviewFinding } from "../../../src/plugins/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "nax-acceptance-bridge-"));
}

function makeVerdict(overrides: Partial<SemanticVerdict> = {}): SemanticVerdict {
  return {
    storyId: "US-001",
    passed: true,
    timestamp: new Date().toISOString(),
    acCount: 3,
    findings: [],
    ...overrides,
  };
}

function makeStory(id = "US-001") {
  return {
    id,
    title: "Test story",
    description: "desc",
    acceptanceCriteria: ["AC-1: criterion"],
    tags: [] as string[],
    dependencies: [] as string[],
    status: "pending" as const,
    passes: false,
    escalations: [] as unknown[],
    attempts: 0,
  };
}

function makeConfig(): Record<string, unknown> {
  return {
    autoMode: { defaultAgent: "claude" },
    models: {},
    acceptance: {
      maxRetries: 3,
      testPath: "acceptance.test.ts",
      fix: { strategy: "diagnose-first", maxRetries: 2, fixModel: "balanced", diagnoseModel: "balanced" },
      model: "balanced",
    },
    execution: { sessionTimeoutSeconds: 3600 },
    analyze: { model: "balanced" },
    quality: { commands: { test: "bun test" } },
    project: {},
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const story = makeStory();
  return {
    config: makeConfig(),
    effectiveConfig: makeConfig(),
    prd: { userStories: [story], featureName: "test-feature" },
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "balanced", testStrategy: "tdd-simple", reasoning: "" },
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-feature",
    hooks: { hooks: [] },
    plugins: {
      getReviewPlugins: () => [],
      getContextProviders: () => [],
      getReporters: () => [],
      getRoutingStrategies: () => [],
      getPromptOptimizers: () => [],
      getPostRunActions: () => [],
    },
    agentGetFn: undefined,
    storyStartTime: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: buildAcceptanceSection — heading + fenced block
// ---------------------------------------------------------------------------

describe("buildAcceptanceSection", () => {
  test("AC-1: single entry produces markdown heading and typescript fenced code block", () => {
    const result = buildAcceptanceSection([{ testPath: "test.ts", content: "import { foo } from './foo';" }]);

    expect(result).toMatch(/#{1,3} test\.ts/);
    expect(result).toMatch(/```typescript[\s\S]*```/);
    expect(result).toContain("import { foo } from './foo';");
  });

  // AC-2: empty array → empty string
  test("AC-2: empty array returns empty string", () => {
    const result = buildAcceptanceSection([]);
    expect(result).toBe("");
    expect(result.length).toBe(0);
  });

  // AC-3: truncation of longest entry when total bytes > 51200
  test("AC-3: truncates longest entry when total content exceeds 51200 bytes", () => {
    const shortContent = "const x = 1;";
    const longContent = "x".repeat(52000);
    const entries = [
      { testPath: "short.ts", content: shortContent },
      { testPath: "long.ts", content: longContent },
    ];

    const result = buildAcceptanceSection(entries);
    const resultBytes = Buffer.byteLength(
      result
        .split("```typescript")
        .slice(1)
        .map((s) => s.split("```")[0])
        .join(""),
    );

    expect(result).toContain("[truncated — full file at long.ts]");
    expect(resultBytes).toBeLessThanOrEqual(51200 + 200); // allow heading overhead
  });
});

// ---------------------------------------------------------------------------
// AC-4: PromptBuilder.acceptanceContext() ordering
// ---------------------------------------------------------------------------

describe("PromptBuilder.acceptanceContext()", () => {
  test("AC-4: acceptance section appears after story section in built prompt", async () => {
    const story = makeStory();
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(story as Parameters<PromptBuilder["story"]>[0])
      .acceptanceContext([{ testPath: "test.ts", content: "// test content" }])
      .build();

    const storyIdx = prompt.indexOf(story.title);
    const acceptanceIdx = prompt.indexOf("test.ts");

    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(acceptanceIdx).toBeGreaterThan(storyIdx + story.title.length);
  });

  // AC-5: build() without acceptanceContext() has no typescript blocks referencing test paths
  test("AC-5: build() without acceptanceContext() contains no fenced typescript block", async () => {
    const story = makeStory();
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(story as Parameters<PromptBuilder["story"]>[0])
      .build();

    // Should not contain a typescript fenced block at all, or none referencing test file paths
    const tsBlocks = [...prompt.matchAll(/```typescript([\s\S]*?)```/g)].map((m) => m[1]);
    const anyRefersToTestPath = tsBlocks.some((block) => /\.test\.ts/.test(block));
    expect(anyRefersToTestPath).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / AC-7 / AC-8: promptStage reads acceptanceTestPaths
// ---------------------------------------------------------------------------

describe("promptStage acceptance file loading", () => {
  let origFile: typeof Bun.file;
  const fileCalls: string[] = [];

  beforeEach(() => {
    origFile = Bun.file;
    fileCalls.length = 0;
    (Bun as unknown as Record<string, unknown>).file = (p: string) => {
      fileCalls.push(p);
      return {
        exists: () => Promise.resolve(true),
        text: () => Promise.resolve(`// content of ${p}`),
      };
    };
  });

  afterEach(() => {
    (Bun as unknown as Record<string, unknown>).file = origFile;
  });

  test("AC-6: reads each file in acceptanceTestPaths and passes array to acceptanceContext", async () => {
    const spy = spyOn(PromptBuilder.prototype, "acceptanceContext");
    const ctx = makeCtx({ acceptanceTestPaths: ["a.test.ts", "b.test.ts"] });

    await promptStage.execute(ctx as Parameters<typeof promptStage.execute>[0]);

    const testFileCalls = fileCalls.filter((p) => p === "a.test.ts" || p === "b.test.ts");
    expect(testFileCalls).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);

    const callArg = spy.mock.calls[0][0] as unknown[];
    expect(Array.isArray(callArg)).toBe(true);
    expect(callArg).toHaveLength(2);
    expect((callArg[0] as Record<string, string>).testPath).toBe("a.test.ts");
    expect((callArg[1] as Record<string, string>).testPath).toBe("b.test.ts");
    spy.mockRestore();
  });

  test("AC-7: acceptanceContext not called when acceptanceTestPaths is undefined or empty", async () => {
    const spy = spyOn(PromptBuilder.prototype, "acceptanceContext");

    const ctxUndef = makeCtx({ acceptanceTestPaths: undefined });
    await promptStage.execute(ctxUndef as Parameters<typeof promptStage.execute>[0]);
    expect(spy).not.toHaveBeenCalled();

    spy.mockClear();

    const ctxEmpty = makeCtx({ acceptanceTestPaths: [] });
    await promptStage.execute(ctxEmpty as Parameters<typeof promptStage.execute>[0]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("AC-8: non-existent file path does not throw and is excluded from acceptanceContext", async () => {
    // Simulate non-existent file
    (Bun as unknown as Record<string, unknown>).file = (p: string) => {
      fileCalls.push(p);
      if (p === "missing.test.ts") {
        return {
          exists: () => Promise.resolve(false),
          text: () => Promise.reject(new Error("ENOENT")),
        };
      }
      return {
        exists: () => Promise.resolve(true),
        text: () => Promise.resolve(`// content of ${p}`),
      };
    };

    const debugCalls: unknown[][] = [];
    const spy = spyOn(PromptBuilder.prototype, "acceptanceContext");

    const ctx = makeCtx({ acceptanceTestPaths: ["exists.test.ts", "missing.test.ts"] });

    await promptStage.execute(ctx as Parameters<typeof promptStage.execute>[0]);

    const callArg = (spy.mock.calls[0]?.[0] as unknown[]) ?? [];
    const paths = callArg.map((e) => (e as Record<string, string>).testPath);
    expect(paths).not.toContain("missing.test.ts");
  });
});

// ---------------------------------------------------------------------------
// AC-9: loadAcceptanceTestContent — new array-based signature
// ---------------------------------------------------------------------------

describe("loadAcceptanceTestContent", () => {
  let origFile: typeof Bun.file;

  beforeEach(() => {
    origFile = Bun.file;
    (Bun as unknown as Record<string, unknown>).file = (p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(`content:${p}`),
    });
  });

  afterEach(() => {
    (Bun as unknown as Record<string, unknown>).file = origFile;
  });

  test("AC-9a: returns array of objects with testPath and content for given paths", async () => {
    const result = await loadAcceptanceTestContent(["pkg/a.test.ts", "pkg/b.test.ts"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("testPath", "pkg/a.test.ts");
    expect(result[1]).toHaveProperty("testPath", "pkg/b.test.ts");
    expect(typeof result[0].content).toBe("string");
    expect(typeof result[1].content).toBe("string");
  });

  test("AC-9b: called with no args returns a Promise resolving to an array", async () => {
    const result = await loadAcceptanceTestContent();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-10: runFixRouting uses ctx.acceptanceTestPaths
// ---------------------------------------------------------------------------

describe("runFixRouting acceptanceTestPaths routing", () => {
  test("AC-10a: when ctx.acceptanceTestPaths defined, loadAcceptanceTestContent called with those paths", async () => {
    const spy = spyOn(
      await import("../../../src/acceptance/content-loader"),
      "loadAcceptanceTestContent",
    );
    spy.mockImplementation(async () => []);

    const ctx = makeCtx({
      acceptanceTestPaths: ["a.test.ts"],
      featureDir: "/tmp/some-feature",
    });

    await runFixRouting({ ctx, failures: { failedACs: [], testOutput: "" }, semanticVerdicts: [] } as Parameters<typeof runFixRouting>[0]);

    expect(spy).toHaveBeenCalledWith(["a.test.ts"]);
    spy.mockRestore();
  });

  test("AC-10b: when ctx.acceptanceTestPaths is undefined, path is derived from featureDir", async () => {
    const spy = spyOn(
      await import("../../../src/acceptance/content-loader"),
      "loadAcceptanceTestContent",
    );
    spy.mockImplementation(async () => []);

    const ctx = makeCtx({ acceptanceTestPaths: undefined, featureDir: "/tmp/my-feature" });

    await runFixRouting({ ctx, failures: { failedACs: [], testOutput: "" }, semanticVerdicts: [] } as Parameters<typeof runFixRouting>[0]);

    const callArg = spy.mock.calls[0]?.[0];
    expect(typeof callArg === "string" && callArg.startsWith("/tmp/my-feature")).toBe(true);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-11 / AC-14: GenerateFromPRDOptions type — optional fields
// ---------------------------------------------------------------------------

describe("GenerateFromPRDOptions optional fields", () => {
  test("AC-11: implementationContext is an optional property (omitting does not cause type error)", () => {
    // TypeScript-level: this test compiles only if implementationContext is optional
    const opts: Partial<GenerateFromPRDOptions> & Pick<GenerateFromPRDOptions, "featureName"> = {
      featureName: "test",
      // implementationContext intentionally omitted
    };
    expect(opts.implementationContext).toBeUndefined();
  });

  test("AC-14: previousFailure is an optional property (omitting does not cause type error)", () => {
    const opts: Partial<GenerateFromPRDOptions> & Pick<GenerateFromPRDOptions, "featureName"> = {
      featureName: "test",
      // previousFailure intentionally omitted
    };
    expect(opts.previousFailure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-12 / AC-13 / AC-15: generateFromPRD prompt content
// ---------------------------------------------------------------------------

describe("generateFromPRD prompt injection", () => {
  let capturedPrompt = "";
  let savedDeps: typeof _generatorPRDDeps;

  beforeEach(() => {
    savedDeps = { ..._generatorPRDDeps };
    capturedPrompt = "";
    _generatorPRDDeps.adapter = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return "// generated test";
      },
    } as typeof _generatorPRDDeps.adapter;
    _generatorPRDDeps.writeFile = async () => {};
    _generatorPRDDeps.backupFile = async () => {};
  });

  afterEach(() => {
    Object.assign(_generatorPRDDeps, savedDeps);
  });

  function makeGenOptions(overrides: Partial<GenerateFromPRDOptions> = {}): GenerateFromPRDOptions {
    return {
      featureName: "test-feature",
      workdir: "/tmp/workdir",
      featureDir: "/tmp/feature",
      codebaseContext: "file tree",
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      config: makeConfig() as GenerateFromPRDOptions["config"],
      ...overrides,
    };
  }

  test("AC-12: implementationContext entries appear as fenced blocks under 'Implementation (already exists)'", async () => {
    await generateFromPRD(
      [],
      [],
      makeGenOptions({
        implementationContext: [{ path: "src/foo.ts", content: "const x = 1;" }],
      }),
    );

    expect(capturedPrompt).toContain("Implementation (already exists)");
    expect(capturedPrompt).toContain("src/foo.ts");
    expect(capturedPrompt).toContain("const x = 1;");
    expect(capturedPrompt).toMatch(/```[\s\S]*const x = 1;[\s\S]*```/);
  });

  test("AC-13: empty/omitted implementationContext omits 'Implementation (already exists)'", async () => {
    await generateFromPRD([], [], makeGenOptions({ implementationContext: [] }));
    expect(capturedPrompt).not.toContain("Implementation (already exists)");

    capturedPrompt = "";
    await generateFromPRD([], [], makeGenOptions({ implementationContext: undefined }));
    expect(capturedPrompt).not.toContain("Implementation (already exists)");
  });

  test("AC-15: previousFailure string appears in prompt under expected prefix", async () => {
    const failureMsg = "Assertion error: expected 1 but got 2";
    await generateFromPRD([], [], makeGenOptions({ previousFailure: failureMsg }));

    expect(capturedPrompt).toContain(`Previous test failed because: ${failureMsg}`);
  });
});

// ---------------------------------------------------------------------------
// AC-16: regenerateAcceptanceTest invokes git diff --name-only
// ---------------------------------------------------------------------------

describe("regenerateAcceptanceTest git integration", () => {
  test("AC-16: invokes git with ['diff', '--name-only', storyGitRef] and passes read files as implementationContext", async () => {
    const { regenerateAcceptanceTest } = await import(
      "../../../src/execution/lifecycle/acceptance-loop"
    );

    const tmpDir = makeTempDir();
    const testPath = join(tmpDir, "acceptance.test.ts");
    writeFileSync(testPath, "// stub");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "foo.ts"), "const x = 1;");

    const savedRegen = { ..._regenerateDeps };
    const gitCalls: Array<{ workdir: string; gitRef: string }> = [];
    _regenerateDeps.spawnGitDiff = async (workdir: string, gitRef: string) => {
      gitCalls.push({ workdir, gitRef });
      return "src/foo.ts";
    };
    _regenerateDeps.readFile = async () => "const x = 1;";
    _regenerateDeps.acceptanceSetupExecute = async () => {};

    const ctx = makeCtx({
      featureDir: tmpDir,
      story: { ...makeStory(), storyGitRef: "HEAD~1" },
      storyGitRef: "HEAD~1",
      workdir: tmpDir,
    });

    try {
      await regenerateAcceptanceTest(testPath, ctx as Parameters<typeof regenerateAcceptanceTest>[1]);
      expect(gitCalls).toHaveLength(1);
      expect(gitCalls[0]?.gitRef).toBe("HEAD~1");
      expect(gitCalls[0]?.workdir).toBe(tmpDir);
    } finally {
      Object.assign(_regenerateDeps, savedRegen);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-17 / AC-18: buildSourceFixPrompt testFileContent fenced block
// ---------------------------------------------------------------------------

describe("buildSourceFixPrompt", () => {
  function makeFixOptions(overrides: Partial<ExecuteSourceFixOptions> = {}): ExecuteSourceFixOptions {
    return {
      testOutput: "FAIL: test failed",
      testFileContent: "",
      diagnosis: { verdict: "source_bug", reasoning: "bug in source", confidence: 0.9 },
      config: makeConfig() as ExecuteSourceFixOptions["config"],
      workdir: "/tmp/workdir",
      acceptanceTestPath: "acceptance.test.ts",
      ...overrides,
    };
  }

  test("AC-17: non-empty testFileContent is wrapped in a fenced typescript code block", () => {
    const result = buildSourceFixPrompt(makeFixOptions({ testFileContent: "describe('x', () => {});" }));

    expect(result).toMatch(/```typescript\n[\s\S]*```/);
    expect(result).toContain("describe('x', () => {});");
    // Raw path alone should not be the only reference
    expect(result).not.toMatch(/^acceptance\.test\.ts$/m);
  });

  test("AC-18: empty testFileContent produces no typescript fenced block, only file path reference", () => {
    const resultEmpty = buildSourceFixPrompt(makeFixOptions({ testFileContent: "" }));
    expect(resultEmpty).not.toMatch(/```typescript[\s\S]*```/);
    expect(resultEmpty).toContain("acceptance.test.ts");

    const resultUndef = buildSourceFixPrompt(
      makeFixOptions({ testFileContent: undefined as unknown as string }),
    );
    expect(resultUndef).not.toMatch(/```typescript[\s\S]*```/);
  });
});

// ---------------------------------------------------------------------------
// AC-19: SemanticVerdict type
// ---------------------------------------------------------------------------

describe("SemanticVerdict type", () => {
  test("AC-19: SemanticVerdict can be instantiated with required fields without type errors", () => {
    const findings: ReviewFinding[] = [];
    const verdict: SemanticVerdict = {
      storyId: "US-001",
      passed: true,
      timestamp: new Date().toISOString(),
      acCount: 5,
      findings,
    };
    expect(verdict.storyId).toBe("US-001");
    expect(verdict.passed).toBe(true);
    expect(Array.isArray(verdict.findings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-20 / AC-21: persistSemanticVerdict
// ---------------------------------------------------------------------------

describe("persistSemanticVerdict", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("AC-20: writes verdict JSON with correct fields to <featureDir>/semantic-verdicts/<storyId>.json", async () => {
    const verdict = makeVerdict({ storyId: "story-1", passed: true, acCount: 2 });
    await persistSemanticVerdict(tmpDir, "story-1", verdict);

    const filePath = join(tmpDir, "semantic-verdicts", "story-1.json");
    expect(existsSync(filePath)).toBe(true);

    const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf8")) as SemanticVerdict;
    expect(parsed.storyId).toBe("story-1");
    expect(parsed.passed).toBe(true);
    expect(parsed.acCount).toBe(2);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  test("AC-21: creates semantic-verdicts/ dir if it does not exist, no throw", async () => {
    const verdict = makeVerdict({ storyId: "story-x" });
    await persistSemanticVerdict(tmpDir, "story-x", verdict);
    expect(existsSync(join(tmpDir, "semantic-verdicts", "story-x.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-22 / AC-23 / AC-24 / AC-25: completionStage + persistSemanticVerdict
// ---------------------------------------------------------------------------

describe("completionStage semantic verdict persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  function makeReviewResult(checks: unknown[]) {
    return { checks };
  }

  test("AC-22: persistSemanticVerdict called after markStoryPassed when semantic check present", async () => {
    const ctx = makeCtx({
      featureDir: tmpDir,
      reviewResult: makeReviewResult([{ check: "semantic", success: true, findings: [] }]),
    });

    await completionStage.execute(ctx as Parameters<typeof completionStage.execute>[0]);

    const story = (ctx.prd as Record<string, unknown[]>).userStories[0] as Record<string, unknown>;
    expect(story.passes).toBe(true);
    expect(existsSync(join(tmpDir, "semantic-verdicts", `${String(story.id)}.json`))).toBe(true);
  });

  test("AC-23: persistSemanticVerdict not called when reviewResult is undefined", async () => {
    const ctx = makeCtx({ featureDir: tmpDir, reviewResult: undefined });
    await completionStage.execute(ctx as Parameters<typeof completionStage.execute>[0]);
    expect(existsSync(join(tmpDir, "semantic-verdicts"))).toBe(false);
  });

  test("AC-23b: persistSemanticVerdict not called when no semantic check in checks", async () => {
    const ctx = makeCtx({
      featureDir: tmpDir,
      reviewResult: makeReviewResult([{ check: "lint", success: true }]),
    });
    await completionStage.execute(ctx as Parameters<typeof completionStage.execute>[0]);
    expect(existsSync(join(tmpDir, "semantic-verdicts"))).toBe(false);
  });

  test("AC-24: semantic check success:true → verdict JSON has passed:true and empty findings", async () => {
    const ctx = makeCtx({
      featureDir: tmpDir,
      reviewResult: makeReviewResult([{ check: "semantic", success: true, findings: [] }]),
    });
    await completionStage.execute(ctx as Parameters<typeof completionStage.execute>[0]);

    const storyId = (makeStory() as Record<string, unknown>).id as string;
    const filePath = join(tmpDir, "semantic-verdicts", `${storyId}.json`);
    const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf8")) as SemanticVerdict;
    expect(parsed.passed).toBe(true);
    expect(parsed.findings).toHaveLength(0);
  });

  test("AC-25: semantic check success:false with N findings → passed:false and findings.length===N", async () => {
    const findings: ReviewFinding[] = [
      { severity: "high", description: "issue 1", location: "src/a.ts", acId: "AC-1" },
      { severity: "low", description: "issue 2", location: "src/b.ts", acId: "AC-2" },
    ];
    const ctx = makeCtx({
      featureDir: tmpDir,
      reviewResult: makeReviewResult([{ check: "semantic", success: false, findings }]),
    });
    await completionStage.execute(ctx as Parameters<typeof completionStage.execute>[0]);

    const storyId = makeStory().id;
    const filePath = join(tmpDir, "semantic-verdicts", `${storyId}.json`);
    const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf8")) as SemanticVerdict;
    expect(parsed.passed).toBe(false);
    expect(parsed.findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-26 / AC-27: loadSemanticVerdicts
// ---------------------------------------------------------------------------

describe("loadSemanticVerdicts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("AC-26a: returns array of length M for M valid verdict files", async () => {
    const dir = join(tmpDir, "semantic-verdicts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "US-001.json"), JSON.stringify(makeVerdict({ storyId: "US-001" })));
    writeFileSync(join(dir, "US-002.json"), JSON.stringify(makeVerdict({ storyId: "US-002" })));

    const result = await loadSemanticVerdicts(tmpDir);
    expect(result).toHaveLength(2);
    expect(result.every((v) => typeof v.storyId === "string")).toBe(true);
  });

  test("AC-26b: returns empty array when semantic-verdicts/ dir does not exist", async () => {
    const result = await loadSemanticVerdicts(tmpDir);
    expect(result).toEqual([]);
  });

  test("AC-27: 1 malformed JSON file is skipped, returns 2 valid entries", async () => {
    const dir = join(tmpDir, "semantic-verdicts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "US-001.json"), JSON.stringify(makeVerdict({ storyId: "US-001" })));
    writeFileSync(join(dir, "US-002.json"), JSON.stringify(makeVerdict({ storyId: "US-002" })));
    writeFileSync(join(dir, "bad.json"), "{ not valid json [[[");

    const result = await loadSemanticVerdicts(tmpDir);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-28: acceptanceSetupStage clears semantic-verdicts on fingerprint mismatch
// ---------------------------------------------------------------------------

describe("acceptanceSetupStage semantic-verdicts cleanup", () => {
  let tmpDir: string;
  let savedSetupDeps: typeof _acceptanceSetupDeps;

  beforeEach(() => {
    tmpDir = makeTempDir();
    savedSetupDeps = { ..._acceptanceSetupDeps };
  });

  afterEach(() => {
    Object.assign(_acceptanceSetupDeps, savedSetupDeps);
    rmSync(tmpDir, { recursive: true });
  });

  test("AC-28: semantic-verdicts files absent after fingerprint-mismatch in acceptance-setup", async () => {
    const dir = join(tmpDir, "semantic-verdicts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "US-001.json"), JSON.stringify(makeVerdict()));

    // Simulate fingerprint mismatch: readMeta returns stale fingerprint
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: new Date().toISOString(),
      acFingerprint: "stale-fingerprint",
      storyCount: 1,
      acCount: 1,
      generator: "test",
    });
    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: "// test", criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "FAIL" });

    const story = makeStory();
    (story as Record<string, unknown>).workdir = tmpDir;
    const ctx = makeCtx({
      featureDir: tmpDir,
      prd: { userStories: [story], featureName: "test" },
      story,
      stories: [story],
    });

    await acceptanceSetupStage.execute(ctx as Parameters<typeof acceptanceSetupStage.execute>[0]);

    const files = existsSync(dir) ? require("node:fs").readdirSync(dir) : [];
    expect(files).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-30 / AC-32 / AC-33 / AC-35: isTestLevelFailure + all-passed fast path
// ---------------------------------------------------------------------------

describe("isTestLevelFailure with semanticVerdicts", () => {
  test("AC-32: isTestLevelFailure(k, n, [{passed:true},{passed:true}]) === true for all k<=n", () => {
    const allPassed: SemanticVerdict[] = [makeVerdict({ passed: true }), makeVerdict({ passed: true })];
    for (const [failedACs, totalACs] of [
      [1, 1],
      [1, 5],
      [5, 5],
      [1, 10],
      [5, 10],
      [10, 10],
    ]) {
      expect(isTestLevelFailure(failedACs, totalACs, allPassed)).toBe(true);
    }
  });

  test("AC-33a: isTestLevelFailure(9, 10, undefined) === true (ratio > 0.8)", () => {
    expect(isTestLevelFailure(9, 10, undefined)).toBe(true);
  });

  test("AC-33b: isTestLevelFailure(1, 10, undefined) === false (ratio <= 0.8)", () => {
    expect(isTestLevelFailure(1, 10, undefined)).toBe(false);
  });

  test("AC-33c: isTestLevelFailure(9, 10, []) === true; isTestLevelFailure(1, 10, []) === false", () => {
    expect(isTestLevelFailure(9, 10, [])).toBe(true);
    expect(isTestLevelFailure(1, 10, [])).toBe(false);
  });
});

describe("runFixRouting all-verdicts-passed fast path", () => {
  test("AC-30: all semanticVerdicts passed → returns test_bug verdict, diagnoseAcceptanceFailure not called", async () => {
    const diagnoseSpy = spyOn(
      await import("../../../src/acceptance/fix-diagnosis"),
      "diagnoseAcceptanceFailure",
    );

    const allPassed: SemanticVerdict[] = [
      makeVerdict({ passed: true }),
      makeVerdict({ passed: true }),
    ];

    const result = await runFixRouting({
      ctx: makeCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "FAIL" },
      semanticVerdicts: allPassed,
    } as Parameters<typeof runFixRouting>[0]);

    expect((result as Record<string, unknown>).verdict).toBe("test_bug");
    expect((result as Record<string, unknown>).confidence).toBe(1.0);
    expect(String((result as Record<string, unknown>).reasoning)).toContain(
      "Semantic review confirmed",
    );
    expect(diagnoseSpy).not.toHaveBeenCalled();
    diagnoseSpy.mockRestore();
  });

  test("AC-35: logger.info called with 'All semantic verdicts passed' message when all passed", async () => {
    const { getSafeLogger } = await import("../../../src/logger");
    const logger = getSafeLogger();
    const infoSpy = spyOn(logger!, "info");

    const allPassed: SemanticVerdict[] = [makeVerdict({ passed: true })];
    const ctx = makeCtx({ story: { ...makeStory(), id: "US-TEST" } });

    await runFixRouting({
      ctx,
      failures: { failedACs: [], testOutput: "" },
      semanticVerdicts: allPassed,
    } as Parameters<typeof runFixRouting>[0]);

    const matchingCall = infoSpy.mock.calls.find(
      (args) =>
        args[0] === "acceptance" &&
        typeof args[1] === "string" &&
        args[1].includes("All semantic verdicts passed"),
    );

    expect(matchingCall).toBeDefined();
    const dataArg = matchingCall?.[2] as Record<string, unknown>;
    expect(dataArg?.verdictCount).toBe(1);
    infoSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-31: buildDiagnosisPrompt with mixed semantic verdicts
// ---------------------------------------------------------------------------

describe("buildDiagnosisPrompt with semantic verdicts", () => {
  test("AC-31: prompt contains passed storyId and 'test bug' indication", () => {
    const semanticVerdicts: SemanticVerdict[] = [
      makeVerdict({ storyId: "S1", passed: true }),
      makeVerdict({ storyId: "S2", passed: false }),
    ];

    const result = buildDiagnosisPrompt({
      testOutput: "FAIL",
      testFileContent: "// test file",
      sourceFiles: [],
      semanticVerdicts,
    });

    expect(result).toContain("S1");
    expect(result.toLowerCase()).toMatch(/test.bug/);
  });
});

// ---------------------------------------------------------------------------
// AC-34: empty semanticVerdicts behaves as baseline (no-verdicts) path
// ---------------------------------------------------------------------------

describe("runFixRouting empty semanticVerdicts matches baseline", () => {
  test("AC-34: empty semanticVerdicts does not skip diagnoseAcceptanceFailure", async () => {
    const diagnoseSpy = spyOn(
      await import("../../../src/acceptance/fix-diagnosis"),
      "diagnoseAcceptanceFailure",
    );
    diagnoseSpy.mockImplementation(async () => ({
      verdict: "source_bug" as const,
      reasoning: "baseline",
      confidence: 0.5,
    }));

    // Suppress agent calls
    _acceptanceLoopDeps.getAgent = () => null as unknown as ReturnType<typeof _acceptanceLoopDeps.getAgent>;

    await runFixRouting({
      ctx: makeCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "FAIL" },
      semanticVerdicts: [],
    } as Parameters<typeof runFixRouting>[0]);

    // diagnoseAcceptanceFailure should be called (same as no-verdicts baseline)
    expect(diagnoseSpy).toHaveBeenCalled();
    diagnoseSpy.mockRestore();
  });
});
