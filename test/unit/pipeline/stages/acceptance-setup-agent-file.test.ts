/**
 * acceptance-setup: ACP agent-written file preservation (3-tier recovery)
 *
 * When the ACP agent writes the acceptance test file directly via tool calls,
 * `extractTestCode(rawOutput)` returns null (conversational summary). The
 * skeleton fallback performs 3-tier recovery on the on-disk file:
 *
 *   Tier 1 — extractTestCode(existing) non-null: re-extract code from the file
 *             and use it as testCode (common for files with import{} or describe()).
 *   Tier 2 — hasLikelyTestContent(existing): file looks like tests but extraction
 *             found no code block → backup to .llm-recovery.bak + preserve full file.
 *   Tier 3 — file exists but no test keywords → backup + fall to skeleton.
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

// Tier 1 fixture: has `import {` — extractTestCode matches the importMatch pattern
// and returns the full content as testCode (non-null → tier 1 fires).
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

// Tier 2 fixture: bare test() calls with no import{} and no describe() wrapper —
// extractTestCode returns null (no importMatch, no describeMatch, no fence) but
// hasLikelyTestContent returns true (has `test(`). Triggers backup + full-file preserve.
const BARE_TIER2_TEST = `test("AC-1: const name declared", () => {
  expect(true).toBe(true); // real assertion placeholder
});

test("AC-2: tests pass", () => {
  expect(2 + 2).toBe(4);
});
`;

// Tier 3 fixture: conversational text — extractTestCode returns null and
// hasLikelyTestContent returns false. Triggers backup + skeleton fallback.
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
// Shared mock builder for the "ACP agent wrote to disk, callOp returned null" path.
// fileExists call-order contract:
//   call 1 — fingerprint backup guard (shouldGenerate=true path); returns false so
//             no pre-generation backup/delete fires for the test path.
//   call 2 — 3-tier recovery guard inside the skeleton fallback; returns true so
//             the recovery logic reads the agent-written file.
// If a new fileExists(testPath) call is added upstream, update callCount accordingly.
// ---------------------------------------------------------------------------

function makeNullCallOpDeps(
  writtenFiles: Array<{ path: string; content: string }>,
  agentFileContent: string,
) {
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") return { testCode: null };
    throw new Error(`unexpected op: ${op.name}`);
  };
  let callCount = 0;
  _acceptanceSetupDeps.fileExists = async (p) => {
    if (!p.endsWith(".nax-acceptance.test.ts")) return false;
    callCount++;
    return callCount > 1;
  };
  _acceptanceSetupDeps.readFile = async () => agentFileContent;
  _acceptanceSetupDeps.writeFile = async (p, c) => {
    writtenFiles.push({ path: p, content: c });
  };
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
}

// ---------------------------------------------------------------------------
// ACP agent-written file: 3-tier recovery
// ---------------------------------------------------------------------------

describe("acceptance-setup: ACP agent-written file preservation", () => {
  test("tier 1 — extractTestCode finds code in agent file (import match); file written back, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    makeNullCallOpDeps(writtenFiles, REAL_ACCEPTANCE_TEST);

    await acceptanceSetupStage.execute(makeCtx());

    // Tier 1: extractTestCode(REAL_ACCEPTANCE_TEST) is non-null (matches import{...} pattern).
    // testCode is set to the extracted content, which equals REAL_ACCEPTANCE_TEST trimmed.
    // The file IS written back with the real content.
    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toContain("const name");

    // No .llm-recovery.bak created at tier 1
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(0);
  });

  test("tier 2 — bare test file (no import/describe); backup created, full content preserved", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    makeNullCallOpDeps(writtenFiles, BARE_TIER2_TEST);

    await acceptanceSetupStage.execute(makeCtx());

    // Tier 2: extractTestCode(BARE_TIER2_TEST) returns null (no import{}, no describe()),
    // but hasLikelyTestContent returns true (has `test(`).
    // A .llm-recovery.bak backup is written first, then the full file is preserved.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(1);
    expect(backupWrites[0]!.content).toBe(BARE_TIER2_TEST);

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toBe(BARE_TIER2_TEST);
  });

  test("tier 3 — non-test content; backup created, skeleton written", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];
    makeNullCallOpDeps(writtenFiles, NON_TEST_CONTENT);

    await acceptanceSetupStage.execute(makeCtx());

    // Tier 3: extractTestCode returns null, hasLikelyTestContent returns false.
    // A .llm-recovery.bak backup is created, then the skeleton is written.
    const backupWrites = writtenFiles.filter((f) => f.path.endsWith(".llm-recovery.bak"));
    expect(backupWrites).toHaveLength(1);
    expect(backupWrites[0]!.content).toBe(NON_TEST_CONTENT);

    const testFileWrites = writtenFiles.filter((f) => f.path.endsWith(".nax-acceptance.test.ts"));
    expect(testFileWrites).toHaveLength(1);
    expect(testFileWrites[0]!.content).toContain("expect(true).toBe(false)");
  });

  test("no file — file does not exist after callOp; skeleton written, no backup", async () => {
    const writtenFiles: Array<{ path: string; content: string }> = [];

    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode: null };
      throw new Error(`unexpected op: ${op.name}`);
    };
    // Agent did not write the file — fileExists always returns false
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.writeFile = async (p, c) => {
      writtenFiles.push({ path: p, content: c });
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

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
    expect(testContentWrites.some((c) => c.includes("const name"))).toBe(true);
    expect(testContentWrites.every((c) => !c.includes("expect(true).toBe(false)"))).toBe(true);
  });
});

