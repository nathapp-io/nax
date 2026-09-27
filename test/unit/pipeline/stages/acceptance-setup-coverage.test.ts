/**
 * US-002: acceptance-setup — per-group AC coverage and missing-file regeneration.
 *
 * Two behaviours, both advisory rather than gating:
 *   1. After a group's content is written, count how many of that group's ACs
 *      the content names as tests, warn on a gap, and stamp the count into
 *      `acceptance-meta.json`'s `coverage` field.
 *   2. When the fingerprints match but a group's test file has disappeared, take
 *      the existing regenerate path instead of blessing the missing file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { assertDefined, makeDispatchContext, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  _acceptanceSetupDeps,
  type AcceptanceMeta,
  acceptanceSetupStage,
  computeACFingerprint,
  computeAcceptanceLayoutFingerprint,
} from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKDIR = "/tmp/test-workdir";
const FEATURE_DIR = "/tmp/test-workdir/.nax/features/test-feature";
const RELATIVE_TEST_PATH = path.join(".nax", "features", "test-feature", ".nax-acceptance.test.ts");
const ABSOLUTE_TEST_PATH = path.join(FEATURE_DIR, ".nax-acceptance.test.ts");

const COVERAGE_WARN = "Acceptance test file does not cover every AC";
const REGEN_WARN = "Acceptance test file missing despite fingerprint match — regenerating";

const CRITERIA_5 = ["AC-1: a", "AC-2: b", "AC-3: c", "AC-4: d", "AC-5: e"];

const FAILED_DISPATCH: AdapterFailure = {
  category: "availability",
  outcome: "fail-service-down",
  message: "Upstream idle timeout exceeded",
  retriable: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GenerateInput {
  criteriaList: string;
  targetTestFilePath: string;
}

type GenerateResult = { testCode: string | null; adapterFailure?: AdapterFailure };

interface Wired {
  /** Target path of every acceptance-generate op call, in order. */
  generateCalls: string[];
  /** Name of every op dispatched through callOp, in order. */
  opNames: string[];
  writeMetaCalls: Array<{ metaPath: string; meta: AcceptanceMeta }>;
}

/** Test source naming `AC-1:` through `AC-count:`. */
function titlesThrough(count: number): string {
  return Array.from(
    { length: count },
    (_value, i) => `test("AC-${i + 1}: c${i + 1}", () => { throw new Error("red"); })`,
  ).join("\n");
}

/** Test source covering exactly as many ACs as the criteria list declares. */
function titlesFor(criteriaList: string): string {
  return titlesThrough(criteriaList.split("\n").filter((line) => line.trim().length > 0).length);
}

function makeCtx(stories: UserStory[], refinement = false): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement,
        redGate: true,
        model: "fast",
      },
    },
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: stories }),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: WORKDIR,
    projectDir: WORKDIR,
    featureDir: FEATURE_DIR,
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

/** Wire the injectable deps for a generation run and record what the stage did. */
function wireDeps(generate: (input: GenerateInput) => GenerateResult): Wired {
  const wired: Wired = { generateCalls: [], opNames: [], writeMetaCalls: [] };

  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.writeFile = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.loadGroupConfig = async () => DEFAULT_CONFIG;
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "(fail) AC-1: x\n" });
  _acceptanceSetupDeps.writeMeta = async (metaPath, meta) => {
    wired.writeMetaCalls.push({ metaPath, meta });
  };
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    wired.opNames.push(op.name);
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      const generateInput: GenerateInput = input;
      wired.generateCalls.push(generateInput.targetTestFilePath);
      return generate(generateInput);
    }
    throw new Error(`unexpected op: ${op.name}`);
  };

  return wired;
}

/** The meta a fingerprint-matching run would have written for a root-level group. */
function matchingMeta(stories: UserStory[]): AcceptanceMeta {
  const criteria = stories.flatMap((story) => story.acceptanceCriteria);
  return {
    generatedAt: new Date().toISOString(),
    acFingerprint: computeACFingerprint(criteria),
    layoutFingerprint: computeAcceptanceLayoutFingerprint(WORKDIR, [{ testPath: ABSOLUTE_TEST_PATH, stories }]),
    storyCount: stories.length,
    acCount: criteria.length,
    generator: "nax",
  };
}

/** Wire a run whose fingerprints match the current PRD. */
function wireMatchingFingerprints(
  stories: UserStory[],
  filePresent: boolean,
  generate: (input: GenerateInput) => GenerateResult,
): Wired {
  const wired = wireDeps(generate);
  _acceptanceSetupDeps.readMeta = async () => matchingMeta(stories);
  _acceptanceSetupDeps.fileExists = async () => filePresent;
  return wired;
}

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

let captured: LogEntry[];
let unsubscribe: (() => void) | null = null;
let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
  captured = [];
  resetLogger();
  initLogger({ level: "debug", suppressConsole: true });
  unsubscribe = addSink((entry) => {
    captured.push(entry);
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetLogger();
  Object.assign(_acceptanceSetupDeps, savedDeps);
});

function warnsWith(message: string): LogEntry[] {
  return captured.filter((entry) => entry.level === "warn" && entry.message === message);
}

function coverageWarns(): LogEntry[] {
  return warnsWith(COVERAGE_WARN);
}

// ---------------------------------------------------------------------------
// AC11–AC13, AC18: coverage of freshly generated content
// ---------------------------------------------------------------------------

describe("US-002 acceptance-setup: coverage of generated content", () => {
  test("AC11: a file covering 3 of 5 ACs warns and stamps coverage relative to the workdir", async () => {
    const stories = [makeStory({ id: "US-001", acceptanceCriteria: [...CRITERIA_5] })];
    const wired = wireDeps(() => ({ testCode: titlesThrough(3) }));

    await acceptanceSetupStage.execute(makeCtx(stories));

    const warns = coverageWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data).toMatchObject({ expected: 5, found: 3, missing: ["AC-4", "AC-5"] });

    expect(wired.writeMetaCalls).toHaveLength(1);
    const coverage = wired.writeMetaCalls[0]?.meta.coverage;
    expect(coverage).toEqual([{ testPath: RELATIVE_TEST_PATH, expected: 5, found: 3, missing: ["AC-4", "AC-5"] }]);
    expect(path.isAbsolute(coverage?.[0]?.testPath ?? "")).toBe(false);
  });

  test("AC12: two groups each covering their own ACs log no gap warning", async () => {
    const stories = [
      makeStory({ id: "US-001", workdir: "apps/a", acceptanceCriteria: ["AC-1: a1", "AC-2: a2"] }),
      makeStory({ id: "US-002", workdir: "apps/b", acceptanceCriteria: ["AC-1: b1", "AC-2: b2", "AC-3: b3"] }),
    ];
    const wired = wireDeps((input) => ({ testCode: titlesFor(input.criteriaList) }));

    await acceptanceSetupStage.execute(makeCtx(stories));

    expect(wired.generateCalls).toHaveLength(2);
    expect(coverageWarns()).toHaveLength(0);
  });

  test("AC13: a coverage gap leaves the stage result identical to a fully covered file", async () => {
    const criteria = [...CRITERIA_5];
    const stories = () => [makeStory({ id: "US-001", acceptanceCriteria: criteria })];

    wireDeps(() => ({ testCode: titlesThrough(3) }));
    const gappedResult = await acceptanceSetupStage.execute(makeCtx(stories()));
    const gappedWarns = coverageWarns().length;

    wireDeps(() => ({ testCode: titlesThrough(5) }));
    const fullResult = await acceptanceSetupStage.execute(makeCtx(stories()));

    // The gap is what the two runs differ by...
    expect(gappedWarns).toBe(1);
    expect(coverageWarns()).toHaveLength(gappedWarns);
    // ...and the RED run (exit 1) is identical for both.
    expect(gappedResult.action).toBe("continue");
    expect(fullResult.action).toBe("continue");
    expect(gappedResult).toEqual(fullResult);
  });

  test("AC18: a dispatch failure for the only group logs no gap warning", async () => {
    const stories = [makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: a", "AC-2: b"] })];

    wireDeps(() => ({ testCode: null, adapterFailure: FAILED_DISPATCH }));

    await acceptanceSetupStage.execute(makeCtx(stories));

    expect(coverageWarns()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC15–AC17: missing file despite a fingerprint match
// ---------------------------------------------------------------------------

describe("US-002 acceptance-setup: missing file despite matching fingerprints", () => {
  test("AC15: a missing test file regenerates and names the path in the warning", async () => {
    const stories = [makeStory({ id: "US-001", acceptanceCriteria: [...CRITERIA_5] })];
    const wired = wireMatchingFingerprints(stories, false, () => ({ testCode: titlesThrough(5) }));

    await acceptanceSetupStage.execute(makeCtx(stories));

    expect(wired.generateCalls).toHaveLength(1);

    const warns = warnsWith(REGEN_WARN);
    expect(warns).toHaveLength(1);
    const data = warns[0]?.data;
    expect(data).toMatchObject({ storyId: "US-001" });
    expect(Array.isArray(data?.missingTestPaths)).toBe(true);
    expect(String(data?.missingTestPaths)).toContain(RELATIVE_TEST_PATH);
  });

  test("AC16: every test file present and fingerprints matched dispatch no op at all", async () => {
    const stories = [makeStory({ id: "US-001", acceptanceCriteria: [...CRITERIA_5] })];
    const wired = wireMatchingFingerprints(stories, true, () => ({ testCode: titlesThrough(5) }));

    await acceptanceSetupStage.execute(makeCtx(stories, true));

    expect(wired.opNames).toEqual([]);
    expect(wired.generateCalls).toEqual([]);
  });

  test("AC17: regeneration stamps meta with the current AC fingerprint", async () => {
    const stories = [makeStory({ id: "US-001", acceptanceCriteria: [...CRITERIA_5] })];
    const wired = wireMatchingFingerprints(stories, false, () => ({ testCode: titlesThrough(5) }));

    await acceptanceSetupStage.execute(makeCtx(stories));

    expect(wired.writeMetaCalls).toHaveLength(1);
    const meta = wired.writeMetaCalls[0]?.meta;
    assertDefined(meta, "written acceptance meta");
    expect(meta.acFingerprint).toBe(computeACFingerprint(CRITERIA_5));
  });
});
