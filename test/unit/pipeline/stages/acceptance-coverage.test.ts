/**
 * US-002: acceptance (post-run) — warn when a group's test file covers fewer ACs
 * than the PRD stories in that package declare.
 *
 * The check is advisory: it reads the file that already exists on disk and warns,
 * but a count gap never changes the stage's action or the acceptance verdict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanupTempDir, makeDispatchContext, makePRD, makeSpawn, makeStory, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { acceptanceStage } from "@/pipeline/stages";
import type { PipelineContext, StageResult } from "@/pipeline/types";
import { _executorDeps } from "@/verification";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COVERAGE_WARN = "Acceptance test file does not cover every AC";

/** Three PRD acceptance criteria at the repo root → the group expects AC-1..AC-3. */
const PRD_CRITERIA = ["AC-1: a", "AC-2: b", "AC-3: c"];

const PARTIAL_SOURCE = ['test("AC-1: a", () => {})', 'test("AC-2: b", () => {})'].join("\n");
const FULL_SOURCE = [...PRD_CRITERIA.map((ac) => `test("${ac}", () => {})`)].join("\n");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tempDir: string;
let testPath: string;
let captured: LogEntry[];
let unsubscribe: (() => void) | null = null;
let origSpawn: typeof _executorDeps.spawn;

beforeEach(async () => {
  tempDir = makeTempDir("nax-acceptance-coverage-");
  testPath = path.join(tempDir, ".nax", "features", "test-feature", ".nax-acceptance.test.ts");
  // Materialise the file so the stage reads it from disk, exactly as it does in a run.
  await Bun.write(testPath, "");

  captured = [];
  resetLogger();
  initLogger({ level: "debug", suppressConsole: true });
  unsubscribe = addSink((entry) => {
    captured.push(entry);
  });

  origSpawn = _executorDeps.spawn;
  _executorDeps.spawn = makeSpawn(() => "1 pass\n").spawn;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetLogger();
  _executorDeps.spawn = origSpawn;
  cleanupTempDir(tempDir);
});

function makeCtx(): PipelineContext {
  const stories = [
    makeStory({
      id: "US-001",
      status: "passed",
      passes: true,
      attempts: 0,
      acceptanceCriteria: [...PRD_CRITERIA],
    }),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, testPath: "acceptance.test.ts" },
    },
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: stories }),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: tempDir,
    projectDir: tempDir,
    featureDir: path.join(tempDir, ".nax", "features", "test-feature"),
    acceptanceTestPaths: [{ testPath, packageDir: tempDir, storyCount: 1, acceptanceEnabled: true }],
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

/** Write `source` to the group's test file and run the stage over it. */
async function executeWith(source: string): Promise<StageResult> {
  await Bun.write(testPath, source);
  captured = [];
  return acceptanceStage.execute(makeCtx());
}

function coverageWarns(): LogEntry[] {
  return captured.filter((entry) => entry.level === "warn" && entry.message === COVERAGE_WARN);
}

// ---------------------------------------------------------------------------
// AC14
// ---------------------------------------------------------------------------

describe("US-002 acceptance stage: coverage of an existing test file", () => {
  test("AC14: a file naming 2 of 3 in-scope ACs warns with the unnamed AC", async () => {
    const result = await executeWith(PARTIAL_SOURCE);

    const warns = coverageWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data).toMatchObject({ expected: 3, found: 2, missing: ["AC-3"] });
    expect(result.action).toBe("continue");
  });

  test("AC14: the gap does not change the action taken for a fully covered file", async () => {
    const gapped = await executeWith(PARTIAL_SOURCE);
    const gappedWarns = coverageWarns().length;

    const fullyCovered = await executeWith(FULL_SOURCE);
    const fullyCoveredWarns = coverageWarns().length;

    expect(gappedWarns).toBe(1);
    expect(fullyCoveredWarns).toBe(0);
    expect(gapped.action).toBe("continue");
    expect(fullyCovered).toEqual(gapped);
  });

  test("boundary: a missing test file produces no coverage warning", async () => {
    captured = [];

    const ctx = makeCtx();
    ctx.acceptanceTestPaths = [
      {
        testPath: path.join(tempDir, "does-not-exist.test.ts"),
        packageDir: tempDir,
        storyCount: 1,
        acceptanceEnabled: true,
      },
    ];
    const result = await acceptanceStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect(coverageWarns()).toHaveLength(0);
  });
});
