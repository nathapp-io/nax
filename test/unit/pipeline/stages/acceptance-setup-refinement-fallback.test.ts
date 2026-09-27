/**
 * US-003 (acceptance-refine fails loud): acceptance-setup persists the
 * per-entry `refinementFallback` flag to `acceptance-refined.json`.
 *
 * When a story's refinement rejects after its retries, its unrefined criteria
 * must still reach the generator, and the persisted artifact must mark exactly
 * that story's entries `refinementFallback: true` — every other entry, and
 * every entry when refinement is off, stays `false`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeDispatchContext, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORIES: UserStory[] = [
  makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: first criterion"] }),
  makeStory({ id: "US-002", acceptanceCriteria: ["AC-2: second criterion"] }),
  makeStory({ id: "US-003", acceptanceCriteria: ["AC-3: third criterion"] }),
];

function makeCtx(refinement: boolean): PipelineContext {
  return {
    config: makeNaxConfig({
      acceptance: { enabled: true, refinement, redGate: true, model: "fast" },
    }),
    prd: makePRD({ userStories: STORIES }),
    story: STORIES[0],
    stories: STORIES,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

let savedDeps: typeof _acceptanceSetupDeps;
let writtenFiles: Map<string, string>;
let capturedCriteriaLists: string[];

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
  writtenFiles = new Map();
  capturedCriteriaLists = [];

  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.writeFile = async (filePath, content) => {
    writtenFiles.set(filePath, content);
  };
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "(fail) AC-1: x" });
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

/** Refine op rejects for every story in `rejectFor`; every other path refines. */
function wireCallOp(rejectFor: readonly string[] = []): void {
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      if (rejectFor.includes(storyId)) throw new Error(`acceptance-refine: empty output (${storyId})`);
      return criteria.map((c) => ({ original: c, refined: `R:${c}`, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      capturedCriteriaLists.push((input as { criteriaList: string }).criteriaList);
      return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
    }
    throw new Error(`unexpected op: ${op.name}`);
  };
}

interface RefinedJsonEntry {
  original?: string;
  refined?: string;
  storyId?: string;
  refinementFallback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRefinedJson(): RefinedJsonEntry[] {
  const entry = [...writtenFiles.entries()].find(([filePath]) => filePath.endsWith("acceptance-refined.json"));
  assertDefined(entry, "acceptance-refined.json was written");
  const parsed: unknown = JSON.parse(entry[1]);
  if (!Array.isArray(parsed)) throw new Error("acceptance-refined.json did not contain a JSON array");
  return parsed.filter(isRecord).map((record) => ({
    original: typeof record.original === "string" ? record.original : undefined,
    refined: typeof record.refined === "string" ? record.refined : undefined,
    storyId: typeof record.storyId === "string" ? record.storyId : undefined,
    refinementFallback: typeof record.refinementFallback === "boolean" ? record.refinementFallback : undefined,
  }));
}

// ---------------------------------------------------------------------------
// AC8: one story falls back
// ---------------------------------------------------------------------------

describe("US-003 AC8: refinement fallback reaches the generator and the artifact", () => {
  test("US-003 AC8: a rejected refine for US-002 keeps its original AC and flags only its entries", async () => {
    wireCallOp(["US-002"]);

    await acceptanceSetupStage.execute(makeCtx(true));

    // The generator must still see US-002's original AC text.
    expect(capturedCriteriaLists).toHaveLength(1);
    expect(capturedCriteriaLists[0]).toContain("AC-2: second criterion");

    const entries = readRefinedJson();
    const us002 = entries.filter((entry) => entry.storyId === "US-002");
    expect(us002.length).toBeGreaterThan(0);
    for (const entry of us002) {
      expect(entry.refinementFallback).toBe(true);
      expect(entry.refined).toBe("AC-2: second criterion");
    }

    const others = entries.filter((entry) => entry.storyId !== "US-002");
    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) {
      expect(entry.refinementFallback).toBe(false);
    }
  });

  test("US-003 AC8 boundary: nothing is flagged when every story refines", async () => {
    wireCallOp();

    await acceptanceSetupStage.execute(makeCtx(true));

    const entries = readRefinedJson();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.refinementFallback === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC9: refinement disabled
// ---------------------------------------------------------------------------

describe("US-003 AC9: refinement off writes refinementFallback false", () => {
  test("US-003 AC9: every entry carries refinementFallback false when acceptance.refinement is off", async () => {
    wireCallOp(["US-001"]);

    await acceptanceSetupStage.execute(makeCtx(false));

    const entries = readRefinedJson();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.refinementFallback).toBe(false);
    }
  });
});
