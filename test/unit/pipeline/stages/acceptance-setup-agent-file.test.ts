/**
 * acceptance-setup: ACP agent-written file handling (ADR-020 Wave 3)
 *
 * Since ADR-020 Wave 3 the 3-tier disk-recovery ladder no longer lives in the
 * stage.  Recovery (Tier-1/2) is now performed by acceptanceGenerateOp.verify
 * inside callOp.  The stage only sees the result:
 *
 *   testCode non-null  → write it directly, no backup.
 *   testCode null      → op exhausted all recovery → write skeleton, no backup.
 *
 * The old "tier 2 backup" and "tier 3 backup" paths are intentionally absent
 * from the stage; they are tested in
 * test/unit/operations/acceptance-generate.test.ts (verify hook coverage).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { makePRD, makeStory } from "../../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const prd = makePRD({
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    userStories: [makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: const name declared", "AC-2: tests pass"] })],
  });
  const stories = prd.userStories;
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: false,
        redGate: true,
        model: "fast",
      },
    } as any,
    prd,
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-agent-file",
    projectDir: "/tmp/test-agent-file",
    featureDir: "/tmp/test-agent-file/.nax/features/test-feature",
    hooks: {} as any,
    ...overrides,
  };
}

// Real acceptance test content (has import + describe → extractTestCode matches).
const REAL_ACCEPTANCE_TEST = `import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: const name declared", async () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/greeting.ts"), "utf8");
    expect(src).toMatch(/const name\\s*=/);
  });

  test("AC-2: tests pass", async () => {
    const result = spawnSync(["bun", "test", "src/greeting.test.ts"], { cwd: join(import.meta.dir, "../../..") });
    expect(result.exitCode).toBe(0);
  });
});
`;

// Bare test content recovered by verify Tier-2 (has test() calls, no import{}/describe()).
const BARE_TIER2_TEST = `test("AC-1: const name declared", () => {
  expect(true).toBe(true); // real assertion placeholder
});

test("AC-2: tests pass", () => {
  expect(2 + 2).toBe(4);
});
`;

// Non-test conversational output — verify hook returns null for this.
const NON_TEST_CONTENT =
  "The acceptance tests have been written. Please verify that the implementation satisfies all the criteria.";

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helper: wire deps so callOp returns the given testCode for acceptance-generate.
// No disk-reading needed — recovery now lives inside callOp/verify (ADR-020 Wave 3).
// ---------------------------------------------------------------------------

function makeCallOpDeps(
  writtenFiles: Array<{ path: string; content: string }>,
  testCodeResult: string | null,
) {
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") return { testCode: testCodeResult };
    throw new Error(`unexpected op: ${op.name}`);
  };
  // fileExists used only by fingerprint pre-backup guard (returns false → no pre-gen backup).
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.writeFile = async (p, c) => {
    writtenFiles.push({ path: p, content: c });
  };
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
}

// ---------------------------------------------------------------------------
// ACP agent-written file handling (ADR-020 Wave 3)
// ---------------------------------------------------------------------------

describe("acceptance-setup: ACP agent-written file handling (ADR-020 Wave 3)", () => {
  test("callOp returns real test code (verify extracted it); written directly, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook extracted code from agent-written file and returned it via callOp.
    makeCallOpDeps(writtenFiles, REAL_ACCEPTANCE_TEST);

    await acceptanceSetupStage.execute(makeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    // Content is the real acceptance test, not a skeleton placeholder.
    expect(testFileWrites[0]!.content).toContain("const name\\s*=");
    expect(testFileWrites[0]!.content).not.toContain("expect(true).toBe(false)");

    // No .llm-recovery.bak — backup is not done at stage level.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns bare test file (verify tier-2 recovery); written directly, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook found bare test content (Tier-2) and returned it via callOp.
    makeCallOpDeps(writtenFiles, BARE_TIER2_TEST);

    await acceptanceSetupStage.execute(makeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toBe(BARE_TIER2_TEST);

    // No backup at stage level — backup was stage-side behavior removed in ADR-020 Wave 3.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns null (verify exhausted, non-test content); skeleton written, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    // Simulate: verify hook found non-test content and returned null → callOp returns null.
    makeCallOpDeps(writtenFiles, null);
    // readFile would return NON_TEST_CONTENT but stage no longer reads disk after callOp.
    void NON_TEST_CONTENT;

    await acceptanceSetupStage.execute(makeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toContain("expect(true).toBe(false)");

    // No backup at stage level.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("callOp returns null (file never written by agent); skeleton written, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    makeCallOpDeps(writtenFiles, null);

    await acceptanceSetupStage.execute(makeCtx());

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toContain("expect(true).toBe(false)");

    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("normal path — callOp returns real testCode; written directly, no recovery", async () => {
    const writtenContents: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode: REAL_ACCEPTANCE_TEST };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async (_p, c) => {
      writtenContents.push(c);
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    // testCode is set from callOp — written as-is, no skeleton substitution
    const testContentWrites = writtenContents.filter((c) => c.includes("describe(") || c.includes("test("));
    expect(testContentWrites.some((c) => c.includes("const name\\s*="))).toBe(true);
    expect(testContentWrites.every((c) => !c.includes("expect(true).toBe(false)"))).toBe(true);
  });
});
