import { describe, expect, test } from "bun:test";
import { parseTestEditDeclarations } from "../../../src/operations/test-edit-declaration";
import { validateMockStructureFiles, applyTestEditDeclarations } from "../../../src/pipeline/stages/autofix-cycle";
import { RectifierPromptBuilder } from "../../../src/prompts/builders/rectifier-builder";
import { assertionSiteDiffCheck, revertDiff, runIsolationGuard, _guardDeps } from "../../../src/pipeline/stages/autofix-guards";
import { makeStory } from "../../../test/helpers/mock-story";
import { makeNaxConfig } from "../../../test/helpers/mock-nax-config";
import { withTempDir } from "../../../test/helpers/temp";
import type { TestEditDeclaration } from "../../../src/operations/test-edit-declaration";
import type { ResolvedTestPatterns } from "../../../src/test-runners";

describe("mock-structure-handoff acceptance tests", () => {
  // ─── AC-1: parseTestEditDeclarations with blank-line separation ─────────────────

  test("AC-1: parseTestEditDeclarations returns two declarations when mock_structure is followed by blank line and another block", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: a.test.ts, b.test.ts
REASON: First mock is wrong

Some middle text or blank line

TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "functionName(): void"
FILE: c.test.ts
TEST_BEFORE: old
TEST_AFTER: new`;

    const declarations = parseTestEditDeclarations(output);

    expect(declarations).toHaveLength(2);
    expect(declarations[0].reason).toBe("mock_structure");
    expect(declarations[0].files).toEqual(["a.test.ts", "b.test.ts"]);
    expect(declarations[1].reason).toBe("prd_contract");
    expect(declarations[1].file).toBe("c.test.ts");
  });

  // ─── AC-2: parseTestEditDeclarations with multi-line REASON ────────────────────

  test("AC-2: parseTestEditDeclarations captures multi-line REASON field as reasonDetail", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: x.test.ts
REASON: Old mock fetched from Service.getUser()

Some intervening text

TEST_EDIT_REASON: mock_structure
FILES: y.test.ts
REASON: The new code dispatches directly via UserClient.fetch()
This requires restructuring the mock setup
Extra text below`;

    const declarations = parseTestEditDeclarations(output);

    expect(declarations).toHaveLength(2);
    expect(declarations[0].reason).toBe("mock_structure");
    expect(declarations[0].reasonDetail).toContain("Old mock fetched from Service.getUser()");
    expect(declarations[1].reasonDetail).toContain("The new code dispatches");
  });

  // ─── AC-3: parseTestEditDeclarations with mixed block types ──────────────────

  test("AC-3: parseTestEditDeclarations returns independent declarations for mock_structure and prd_contract", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts, test/bar.test.ts
REASON: Mocks reference the old API shape

TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "fetchData(id: string): Promise<Data>"
FILE: test/api.test.ts
TEST_BEFORE: await client.fetch(id)
TEST_AFTER: await client.fetchData(id)`;

    const declarations = parseTestEditDeclarations(output);

    expect(declarations).toHaveLength(2);
    expect(declarations[0].reason).toBe("mock_structure");
    expect(declarations[0].file).toBe("test/foo.test.ts");
    expect(declarations[0].files).toHaveLength(2);
    expect(declarations[1].reason).toBe("prd_contract");
    expect(declarations[1].file).toBe("test/api.test.ts");
    // No field overlap: mock_structure has files and reasonDetail, prd_contract has prdQuote/testBefore/testAfter
    expect(declarations[0].prdQuote).toBeUndefined();
    expect(declarations[1].reasonDetail).toBeUndefined();
  });

  // ─── AC-4: validateMockStructureFiles with empty array ───────────────────────

  test("AC-4: validateMockStructureFiles returns empty arrays when input is empty, no filesystem operations performed", async () => {
    const resolved: ResolvedTestPatterns = {
      regex: [],
      pathspec: [],
      testDirs: [],
      globs: [],
      resolution: "detected" as const,
    };

    const result = await validateMockStructureFiles([], "/tmp/workdir", resolved);

    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(0);
  });

  // ─── AC-5: validateMockStructureFiles with non-mock_structure declarations ────

  test("AC-5: validateMockStructureFiles returns all non-mock_structure declarations in valid without filesystem operations", async () => {
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/a.ts",
        prdQuote: "quote1",
        testBefore: "before",
        testAfter: "after",
      },
      {
        reason: "lint_only",
        file: "test/b.ts",
        finding: "some-lint-rule",
      },
      {
        reason: "sibling_scope",
        file: "test/c.ts",
        finding: "some-scope-error",
      },
    ];

    const resolved: ResolvedTestPatterns = {
      regex: [],
      pathspec: [],
      testDirs: [],
      globs: [],
      resolution: "detected" as const,
    };

    const result = await validateMockStructureFiles(declarations, "/tmp/workdir", resolved);

    expect(result.valid).toHaveLength(3); // All three pass through
    expect(result.invalid).toHaveLength(0);
  });

  // ─── AC-6: validateMockStructureFiles with mixed existing/non-existing files ──

  test("AC-6: validateMockStructureFiles returns invalid entry with missing path when 1 of 3 files does not exist", async () => {
    await withTempDir(async (tmpdir: string) => {
      // Create two test files
      await Bun.write(`${tmpdir}/file1.test.ts`, "test content 1");
      await Bun.write(`${tmpdir}/file2.test.ts`, "test content 2");

      const declarations: TestEditDeclaration[] = [
        {
          reason: "mock_structure",
          file: "file1.test.ts",
          files: ["file1.test.ts", "file2.test.ts", "nonexistent.test.ts"],
          reasonDetail: "Test reason",
        },
      ];

      const resolved: ResolvedTestPatterns = {
        regex: [/\.test\.ts$/],
        pathspec: ["**/*.test.ts"],
        testDirs: ["."],
        globs: ["**/*.test.ts"],
        resolution: "detected" as const,
      };

      const result = await validateMockStructureFiles(declarations, tmpdir, resolved);

      expect(result.invalid).toHaveLength(1);
      const invalid = result.invalid[0];
      expect(invalid.decl).toBe(declarations[0]);
      expect(invalid.missing).toContain("nonexistent.test.ts");
      expect(invalid.missing).toHaveLength(1);
      expect(invalid.nonTest).toHaveLength(0);
    });
  });

  // ─── AC-7: testWriterRectification in mock-restructure mode ──────────────────

  test("AC-7: testWriterRectification returns non-empty string in mock-restructure mode without throwing", () => {
    const story = makeStory({
      title: "Test Story",
      acceptanceCriteria: ["AC1: test", "AC2: another"],
    });
    const findings = [];

    const result = RectifierPromptBuilder.testWriterRectification(findings, story, {
      mode: "mock-restructure",
      handoffFiles: undefined,
    });

    expect(result).toBeTruthy();
    expect(result.length > 0).toBe(true);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  // ─── AC-8: testWriterRectification lists all handoff files ───────────────────

  test("AC-8: testWriterRectification includes all handoff files under a 'Files to rewrite' section", () => {
    const story = makeStory({
      title: "Test Story",
      acceptanceCriteria: ["AC1: test"],
    });
    const findings = [];
    const files = ["file1.test.ts", "file2.test.ts", "file3.test.ts"];

    const result = RectifierPromptBuilder.testWriterRectification(findings, story, {
      mode: "mock-restructure",
      handoffFiles: files,
      handoffReason: "Test reason",
    });

    expect(result).toContain("Files to rewrite");
    expect(result).toContain("file1.test.ts");
    expect(result).toContain("file2.test.ts");
    expect(result).toContain("file3.test.ts");
  });

  // ─── AC-9: buildInput deduplicates files across handoffs ────────────────────

  test("AC-9: buildInput deduplicates file paths when multiple handoffs reference the same file", () => {
    const handoffs = [
      { files: ["file1.test.ts", "shared.test.ts"], reasonDetail: "reason1" },
      { files: ["file2.test.ts", "shared.test.ts"], reasonDetail: "reason2" },
    ];

    const allFiles = [...new Set(handoffs.flatMap((h) => h.files))];

    expect(allFiles).toHaveLength(3);
    expect(allFiles).toContain("file1.test.ts");
    expect(allFiles).toContain("file2.test.ts");
    expect(allFiles).toContain("shared.test.ts");
    expect(allFiles.indexOf("shared.test.ts")).toBe(allFiles.lastIndexOf("shared.test.ts")); // Only one occurrence
  });

  // ─── AC-10: buildInput joins reasonDetails with separator ────────────────────

  test("AC-10: buildInput joins reasonDetails from multiple handoffs with correct separator", () => {
    const handoffs = [
      { files: ["a.test.ts"], reasonDetail: "reason1" },
      { files: ["b.test.ts"], reasonDetail: "reason2" },
    ];

    const reason = handoffs.map((h) => h.reasonDetail).join("\n\n---\n\n");

    expect(reason).toBe("reason1\n\n---\n\nreason2");
  });

  // ─── AC-11: assertionSiteDiffCheck with empty files array ───────────────────

  test("AC-11: assertionSiteDiffCheck returns { violated: false } with empty files and never invokes spawn", async () => {
    let spawnCalled = false;
    const originalSpawn = _guardDeps.spawn;

    try {
      _guardDeps.spawn = (() => {
        spawnCalled = true;
        return {} as any;
      }) as any;

      const result = await assertionSiteDiffCheck("/tmp/workdir", "abc123", []);

      expect(result.violated).toBe(false);
      expect(spawnCalled).toBe(false);
    } finally {
      _guardDeps.spawn = originalSpawn;
    }
  });

  // ─── AC-12: revertDiff error handling on failed git checkout ──────────────────

  test("AC-12: revertDiff throws NaxError when git checkout exits non-zero", async () => {
    const originalSpawn = _guardDeps.spawn;
    let capturedError: Error | null = null;

    try {
      _guardDeps.spawn = ((_cmd: string[], _opts: any) => {
        const mockProc = {
          exited: Promise.resolve(1), // Exit code != 0
          stdout: new ReadableStream({ start: (c) => c.close() }),
          stderr: new ReadableStream({ start: (c) => c.close() }),
        };
        return mockProc as any;
      }) as any;

      try {
        await revertDiff("/tmp/workdir", ["file1.ts", "file2.ts"]);
      } catch (err) {
        capturedError = err as Error;
      }

      expect(capturedError).toBeTruthy();
      expect(capturedError?.message || "").toContain("git checkout HEAD failed");
    } finally {
      _guardDeps.spawn = originalSpawn;
    }
  });

  // ─── AC-13: runIsolationGuard respects enforceTestWriterIsolation flag ────────

  test("AC-13: runIsolationGuard returns skipped: true when enforceTestWriterIsolation is false, without invoking verifyTestWriterIsolation", async () => {
    const originalVerify = _guardDeps.verifyTestWriterIsolation;
    let verifyCalled = false;

    try {
      _guardDeps.verifyTestWriterIsolation = async () => {
        verifyCalled = true;
        return { passed: false, violations: ["file.ts"] };
      };

      const config = makeNaxConfig({
        quality: {
          autofix: {
            enforceTestWriterIsolation: false,
          },
        },
      });

      const result = await runIsolationGuard("/tmp/workdir", "abc123", config);

      expect(result.violated).toBe(false);
      expect("skipped" in result && result.skipped).toBe(true);
      expect(verifyCalled).toBe(false); // Verify function was not called
    } finally {
      _guardDeps.verifyTestWriterIsolation = originalVerify;
    }
  });

  // ─── applyTestEditDeclarations tests ──────────────────────────────────────────

  test("applyTestEditDeclarations generates synthetic findings for valid mock_structure declarations", () => {
    const findings = [];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "mock_structure",
        file: "a.test.ts",
        files: ["a.test.ts", "b.test.ts"],
        reasonDetail: "Mock change reason",
      },
    ];
    const story = makeStory();

    const result = applyTestEditDeclarations(findings, declarations, story);

    expect(result).toHaveLength(2); // One finding per file
    expect(result[0].source).toBe("implementer-handoff");
    expect(result[0].category).toBe("test_mock_restructure");
    expect(result[0].file).toBe("a.test.ts");
    expect(result[1].file).toBe("b.test.ts");
  });

  test("applyTestEditDeclarations generates advisory findings for invalid mock_structure declarations", () => {
    const findings = [];
    const declarations: TestEditDeclaration[] = [];
    const story = makeStory();
    const decl: TestEditDeclaration = {
      reason: "mock_structure",
      file: "a.test.ts",
      files: ["missing.test.ts"],
      reasonDetail: "Test reason",
    };
    const invalidMockStructure = [
      {
        decl,
        missing: ["missing.test.ts"],
        nonTest: [],
      },
    ];

    const result = applyTestEditDeclarations(findings, declarations, story, invalidMockStructure);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("implementer-handoff");
    expect(result[0].category).toBe("mock_structure_invalid_files");
    expect(result[0].severity).toBe("warning");
    expect(result[0].message).toContain("missing.test.ts");
  });
});