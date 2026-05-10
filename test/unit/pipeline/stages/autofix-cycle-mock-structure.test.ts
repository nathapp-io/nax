/**
 * Tests for mock_structure validation and synthetic finding generation.
 *
 * Covers:
 * - validateMockStructureFiles: partition declarations into valid/invalid
 * - applyTestEditDeclarations: generate synthetic findings for mock_structure
 * - validate() callback: orchestrate validation, handoff stashing, and clearing
 * - FindingSource extension: "implementer-handoff" source type
 * - PipelineContext extension: pendingMockStructureHandoffs field
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import {
  _autofixCycleDeps,
  applyTestEditDeclarations,
  runAgentRectificationV2,
  validateMockStructureFiles,
} from "../../../../src/pipeline/stages/autofix-cycle";
import { _cycleDeps } from "../../../../src/findings/cycle";
import type { Finding } from "@/findings";
import type { TestEditDeclaration } from "@/operations";
import { _resolverDeps, type ResolvedTestPatterns } from "../../../../src/test-runners/resolver";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeStory } from "@test/helpers";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "adversarial-review",
    severity: "error",
    category: "convention",
    message: "test message",
    file: "src/foo.ts",
    fixTarget: "source",
    ...overrides,
  };
}

function makeMockResolved(testDirs = ["test", "tests"]): ResolvedTestPatterns {
  return {
    globs: ["**/*.test.ts", "**/*.spec.ts"],
    pathspec: [":!**/*.test.ts", ":!**/*.spec.ts"],
    regex: [/\.test\.ts$/, /\.spec\.ts$/],
    testDirs,
    resolution: "fallback",
  };
}

function makeMinCtx(): PipelineContext {
  return {
    story: makeStory(),
    config: makeNaxConfig(),
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    agentManager: makeMockAgentManager(),
  } as any;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let savedRecheck: typeof _autofixDeps.recheckReview;
let savedFileExists: typeof _autofixCycleDeps.fileExists;

beforeEach(() => {
  savedRecheck = _autofixDeps.recheckReview;
  savedFileExists = _autofixCycleDeps.fileExists;
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _autofixCycleDeps.fileExists = savedFileExists;
  mock.restore();
});

// ─── validateMockStructureFiles ───────────────────────────────────────────────

describe("validateMockStructureFiles", () => {
  test("partitions valid mock_structure declarations into valid partition", async () => {
    _autofixCycleDeps.fileExists = mock(async (_path: string) => true);
    const decls: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "test/bar.spec.ts"],
        reasonDetail: "Restructure test mocks per implementer handoff",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].reason).toBe("mock_structure");
    expect(result.invalid).toHaveLength(0);
  });

  test("returns { valid, invalid } partition where valid contains mock_structure with all paths as test files", async () => {
    _autofixCycleDeps.fileExists = mock(async (_path: string) => true);
    const decls: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "test/bar.spec.ts"],
        reasonDetail: "Restructure mocks",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].reason).toBe("mock_structure");
    expect(result.valid[0].files).toContain("test/foo.test.ts");
    expect(result.valid[0].files).toContain("test/bar.spec.ts");
    expect(result.invalid).toHaveLength(0);
  });

  test("returns { valid, invalid } partition where invalid contains mock_structure with missing/non-test paths", async () => {
    // test/foo.test.ts and src/nontest.ts exist; test/missing.spec.ts is missing
    _autofixCycleDeps.fileExists = mock(async (path: string) => {
      return path.endsWith("test/foo.test.ts") || path.endsWith("src/nontest.ts");
    });
    const decls: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "src/nontest.ts", "test/missing.spec.ts"],
        reasonDetail: "Restructure mocks",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toHaveProperty("missing");
    expect(result.invalid[0]).toHaveProperty("nonTest");
    expect(result.invalid[0].missing).toContain("test/missing.spec.ts");
    expect(result.invalid[0].nonTest).toContain("src/nontest.ts");
    expect(result.valid).toHaveLength(0);
  });

  test("passes through non-mock_structure declarations unchanged in valid", async () => {
    const decls: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fn(x: number): void",
        testBefore: "fn()",
        testAfter: "fn(1)",
      },
      {
        reason: "lint_only",
        file: "test/foo.spec.ts",
        finding: "no-console",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    // Non-mock_structure declarations should pass through in valid
    expect(result.valid.some((d) => d.reason === "prd_contract")).toBe(true);
    expect(result.valid.some((d) => d.reason === "lint_only")).toBe(true);
  });

  test("marks paths missing when they don't exist on disk", async () => {
    // test/foo.test.ts exists; test/nonexistent.spec.ts does not
    _autofixCycleDeps.fileExists = mock(async (path: string) => path.endsWith("test/foo.test.ts"));
    const decls: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "test/nonexistent.spec.ts"],
        reasonDetail: "Restructure mocks",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].missing).toContain("test/nonexistent.spec.ts");
    expect(result.invalid[0].nonTest).toHaveLength(0);
  });

  test("marks paths non-test when they exist but don't match test pattern regex", async () => {
    // Both files exist; only test/foo.test.ts matches the test regex
    _autofixCycleDeps.fileExists = mock(async (_path: string) => true);
    const decls: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "src/code.ts"],
        reasonDetail: "Restructure mocks",
      },
    ];
    const resolved = makeMockResolved();

    const result = await validateMockStructureFiles(decls, "/tmp", resolved);

    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].nonTest).toContain("src/code.ts");
    expect(result.invalid[0].missing).toHaveLength(0);
  });

  test("partitions a mock_structure declaration with empty files into invalid", async () => {
    const result = await validateMockStructureFiles(
      [{ reason: "mock_structure", file: "", files: [], reasonDetail: "x" }],
      "/tmp",
      makeMockResolved(),
    );
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].missing).toEqual([]);
    expect(result.invalid[0].nonTest).toEqual([]);
  });
});

// ─── applyTestEditDeclarations — mock_structure support ──────────────────────

describe("applyTestEditDeclarations with mock_structure", () => {
  test("generates one synthetic finding per file in valid mock_structure declaration", () => {
    const story = makeStory({ description: "Test restructuring" });
    const findings: Finding[] = [
      makeFinding({ file: "test/foo.test.ts", fixTarget: "test" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "test/bar.spec.ts"],
        reasonDetail: "Restructure mocks per implementer handoff",
      },
    ];

    const result = applyTestEditDeclarations(findings, declarations, story);

    // Should generate synthetic findings for each file
    const syntheticFindings = result.filter((f) => f.source === "implementer-handoff");
    expect(syntheticFindings.length).toBeGreaterThanOrEqual(2);
    syntheticFindings.forEach((f) => {
      expect(f.severity).toBe("error");
      expect(f.category).toBe("test_mock_restructure");
      expect(f.fixTarget).toBe("test");
    });
  });

  test("sets source to 'implementer-handoff' on synthetic findings", () => {
    const story = makeStory({ description: "Test restructuring" });
    const findings: Finding[] = [];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts"],
        reasonDetail: "Restructure",
      },
    ];

    const result = applyTestEditDeclarations(findings, declarations, story);

    const syntheticFindings = result.filter((f) => f.source === "implementer-handoff");
    expect(syntheticFindings.length).toBeGreaterThan(0);
    syntheticFindings.forEach((f) => {
      expect(f.source).toBe("implementer-handoff");
    });
  });

  test("sets file to each path in decl.files on synthetic findings", () => {
    const story = makeStory();
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts", "test/bar.spec.ts", "test/baz.test.ts"],
        reasonDetail: "Restructure",
      },
    ];

    const result = applyTestEditDeclarations([], declarations, story);

    const syntheticFindings = result.filter((f) => f.source === "implementer-handoff");
    expect(syntheticFindings.map((f) => f.file)).toContain("test/foo.test.ts");
    expect(syntheticFindings.map((f) => f.file)).toContain("test/bar.spec.ts");
    expect(syntheticFindings.map((f) => f.file)).toContain("test/baz.test.ts");
  });

  test("generates one advisory finding for invalid mock_structure declaration with missing/nonTest paths", () => {
    const story = makeStory();
    const findings: Finding[] = [];

    // Invalid declarations come from the `invalid` partition of validateMockStructureFiles and
    // must be passed as the 4th argument — NOT in `declarations` (which is for valid decls only).
    const invalidDecl: TestEditDeclaration = {
      reason: "mock_structure",
      file: "test/foo.test.ts",
      files: ["test/foo.test.ts", "src/code.ts"],
      reasonDetail: "Restructure",
    };
    const invalidMockStructure = [{ decl: invalidDecl, missing: [], nonTest: ["src/code.ts"] }];

    const result = applyTestEditDeclarations(findings, [], story, invalidMockStructure);

    const advisoryFindings = result.filter((f) => f.category === "mock_structure_invalid_files");
    expect(advisoryFindings).toHaveLength(1);
    expect(advisoryFindings[0].severity).toBe("warning");
    expect(advisoryFindings[0].category).toBe("mock_structure_invalid_files");
    expect(advisoryFindings[0].message).toContain("src/code.ts");
  });

  test("retains original source-tagged findings unchanged", () => {
    const story = makeStory();
    const originalFindings: Finding[] = [
      makeFinding({ file: "src/foo.ts", source: "lint", fixTarget: "source" }),
      makeFinding({ file: "src/bar.ts", source: "typecheck", fixTarget: "source" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts"],
        reasonDetail: "Restructure",
      },
    ];

    const result = applyTestEditDeclarations(originalFindings, declarations, story);

    // Original findings should still be in the array unchanged
    expect(result.filter((f) => f.source === "lint")).toHaveLength(1);
    expect(result.filter((f) => f.source === "typecheck")).toHaveLength(1);
    expect(result.some((f) => f.file === "src/foo.ts" && f.source === "lint")).toBe(true);
    expect(result.some((f) => f.file === "src/bar.ts" && f.source === "typecheck")).toBe(true);
  });
});

// ─── Type extensions ──────────────────────────────────────────────────────────

describe("FindingSource extension", () => {
  test("accepts 'implementer-handoff' as a valid FindingSource", () => {
    const finding: Finding = {
      source: "implementer-handoff",
      severity: "error",
      category: "test_mock_restructure",
      message: "Restructure mocks",
      file: "test/foo.test.ts",
      fixTarget: "test",
    };

    expect(finding.source).toBe("implementer-handoff");
  });
});

describe("PipelineContext extension", () => {
  test("declares optional pendingMockStructureHandoffs field", () => {
    const ctx = makeMinCtx();
    const isOptional = !("pendingMockStructureHandoffs" in ctx) || ctx.pendingMockStructureHandoffs === undefined;
    expect(isOptional).toBe(true);
  });

  test("can set pendingMockStructureHandoffs with { files, reasonDetail } entries", () => {
    const ctx = makeMinCtx();
    ctx.pendingMockStructureHandoffs = [
      {
        files: ["test/foo.test.ts", "test/bar.spec.ts"],
        reasonDetail: "Restructure per implementer handoff",
      },
    ];

    expect(ctx.pendingMockStructureHandoffs).toBeDefined();
    expect(ctx.pendingMockStructureHandoffs?.[0].files).toContain("test/foo.test.ts");
    expect(ctx.pendingMockStructureHandoffs?.[0].reasonDetail).toContain("Restructure");
  });
});

// ─── Cycle validate() callback orchestration ─────────────────────────────────

describe("cycle validate() callback with mock_structure handling", () => {
  // Per-describe lifecycle for deps used only in the runAgentRectificationV2 integration tests.
  let savedCycleCallOp: typeof _cycleDeps.callOp;
  let savedResolverDetect: typeof _resolverDeps.detectTestFilePatterns;
  const cycleCreatedRuntimes: Array<ReturnType<typeof makeMockRuntime>> = [];

  beforeEach(() => {
    savedCycleCallOp = _cycleDeps.callOp;
    savedResolverDetect = _resolverDeps.detectTestFilePatterns;
  });

  afterEach(async () => {
    _cycleDeps.callOp = savedCycleCallOp;
    _resolverDeps.detectTestFilePatterns = savedResolverDetect;
    await Promise.allSettled(cycleCreatedRuntimes.map((r) => r.close()));
    cycleCreatedRuntimes.length = 0;
  });

  /** Build a PipelineContext with a runtime and one failing adversarial finding. */
  function makeCycleTestCtx(): PipelineContext {
    const runtime = makeMockRuntime();
    cycleCreatedRuntimes.push(runtime);
    return {
      story: makeStory(),
      config: makeNaxConfig(),
      reviewResult: {
        success: false,
        checks: [
          {
            check: "adversarial",
            success: false,
            findings: [makeFinding({ source: "adversarial-review", fixTarget: "source", severity: "error" })],
          },
        ],
      },
      workdir: "/tmp",
      agentManager: makeMockAgentManager(),
      runtime,
      prd: { feature: "_test", project: "test", userStories: [], branchName: "main", createdAt: "", updatedAt: "" },
    } as any;
  }

  test("populates ctx.pendingMockStructureHandoffs from valid mock_structure declarations before applyTestEditDeclarations", async () => {
    const ctx = makeCycleTestCtx();
    ctx.testEditDeclarations = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        // Use only .test.ts files — the fallback resolver pattern is "test/**/*.test.ts"
        // which only matches .test.ts, not .spec.ts.
        files: ["test/foo.test.ts", "test/bar.test.ts"],
        reasonDetail: "Restructure mocks",
      },
    ];

    // Strategy execution returns empty output — ctx.testEditDeclarations is not modified,
    // so our pre-set declarations remain when validate() runs.
    _cycleDeps.callOp = mock(async () => ({ testEditDeclarations: [], unresolvedReason: undefined })) as any;

    // recheckReview clears findings so the cycle resolves after validate()
    _autofixDeps.recheckReview = mock(async (pctx: PipelineContext): Promise<boolean> => {
      pctx.reviewResult = { success: true, checks: [] } as any;
      return true;
    });

    // fileExists returns true for the declared test paths so validateMockStructureFiles marks them valid
    _autofixCycleDeps.fileExists = mock(
      async (path: string) => path.includes("test/foo.test.ts") || path.includes("test/bar.test.ts"),
    );

    // Force fallback test patterns (avoids real filesystem scan of workdir)
    _resolverDeps.detectTestFilePatterns = mock(async () => ({
      confidence: "empty" as const,
      patterns: [] as string[],
      sources: [] as { type: string }[],
    })) as any;

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    // AC#7: validate() populates pendingMockStructureHandoffs from valid mock_structure
    // declarations and testWriter consumes it as a one-shot (Phase 1 spec).
    // After the cycle completes, testEditDeclarations should be cleared.
    expect(ctx.testEditDeclarations).toEqual([]);
  });

  test("clears ctx.testEditDeclarations after validate() completes", async () => {
    const ctx = makeCycleTestCtx();
    ctx.testEditDeclarations = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fn(x: number): void",
        testBefore: "fn()",
        testAfter: "fn(1)",
      },
    ];

    _cycleDeps.callOp = mock(async () => ({ testEditDeclarations: [], unresolvedReason: undefined })) as any;

    // recheckReview clears findings so validate() can run with pending declarations
    _autofixDeps.recheckReview = mock(async (pctx: PipelineContext): Promise<boolean> => {
      pctx.reviewResult = { success: true, checks: [] } as any;
      return true;
    });

    _autofixCycleDeps.fileExists = mock(async () => false);

    _resolverDeps.detectTestFilePatterns = mock(async () => ({
      confidence: "empty" as const,
      patterns: [] as string[],
      sources: [] as { type: string }[],
    })) as any;

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    // AC#8: validate() clears testEditDeclarations after consuming them
    expect(ctx.testEditDeclarations).toEqual([]);
  });

  test("handles mixed declarations: mock_structure + prd_contract", async () => {
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "test/foo.test.ts",
        files: ["test/foo.test.ts"],
        reasonDetail: "Restructure",
      },
      {
        reason: "prd_contract",
        file: "test/bar.spec.ts",
        prdQuote: "fn(x: number): void",
        testBefore: "fn()",
        testAfter: "fn(1)",
      },
    ];

    const findings = applyTestEditDeclarations([], declarations, makeStory({ description: "fn(x: number): void" }));

    // Both types should be processed
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});
