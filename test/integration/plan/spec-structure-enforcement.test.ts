/**
 * US-002 — the spec's declared story structure is enforced at PRD persistence.
 *
 * The plan strategies persist through `finalizeAndWritePrd`, so this is the one
 * seam where a PRD that folds away a spec story can be refused instead of
 * written. A refusal must also move the draft aside: leaving `prd.json` on disk
 * is exactly the shape every reader treats as a recoverable plan.
 *
 * The dependencies are driven by one in-memory filesystem, so "the draft is on
 * disk", "the draft was renamed" and "nothing was written" are observed on the
 * same object rather than asserted against mocks that cannot disagree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger, makeMockAgentManager, makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { ModelsConfig } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { _refinePlanDeps, _singlePlanDeps, RefinePlanStrategy, SinglePlanStrategy } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies";
import { _persistPrdDeps, finalizeAndWritePrd } from "@/plan/strategies";
import type { PRD } from "@/prd/types";

const OUTPUT_PATH = "/tmp/workdir/.nax/features/feat-x/prd.json";
const REJECTED_PATH = "/tmp/workdir/.nax/features/feat-x/prd.rejected.json";

/** A real ModelsConfig — never a bottom-type cast, which is plugin-banned repo-wide. */
const MODELS: ModelsConfig = makeNaxConfig().models;

/** US-001 to US-004; the planner folds US-004 into US-003, which is the divergence. */
const SPEC_FOUR_STORIES = `# SPEC: fixture

## Stories

### US-001 — Core

### US-002 — API

### US-003 — Lib

### US-004 — API layer

- Workdir: apps/api

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

/** The folded PRD: US-004's work appears on US-003, and US-004 is gone. */
const FOLDED_PRD = makePRD({
  userStories: [
    makeStory({ id: "US-001" }),
    makeStory({ id: "US-002" }),
    makeStory({ id: "US-003", workdir: "packages/lib" }),
  ],
});

/** US-001 and US-004, where only US-004's workdir is stated. */
const SPEC_STATED_WORKDIR = `# SPEC: fixture

## Stories

### US-001 — Core

### US-004 — API layer

- Workdir: apps/api

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

/** US-001 alone — a spec whose sub-story ids only exist after decompose. */
const SPEC_ONE_STORY = `# SPEC: fixture

## Stories

### US-001 — Core

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

/** One story whose Workdir is stated twice, differently — the field cannot be read. */
const SPEC_CONFLICTING_WORKDIR = `# SPEC: fixture

## Stories

### US-001 — Core

Workdir: packages/lib

The author rewrote the line later in the prose:

Workdir: apps/api

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

interface FakeFs {
  readonly files: Map<string, string>;
  readonly writes: string[];
  readonly renames: Array<{ from: string; to: string }>;
}

function makeFakeFs(files: Record<string, string> = {}): FakeFs {
  return { files: new Map(Object.entries(files)), writes: [], renames: [] };
}

let origExistsSync: typeof _persistPrdDeps.existsSync;
let origRenameSync: typeof _persistPrdDeps.renameSync;
let origDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

beforeEach(() => {
  origExistsSync = _persistPrdDeps.existsSync;
  origRenameSync = _persistPrdDeps.renameSync;
  origDiscover = _persistPrdDeps.discoverWorkspacePackages;
});

afterEach(() => {
  _persistPrdDeps.existsSync = origExistsSync;
  _persistPrdDeps.renameSync = origRenameSync;
  _persistPrdDeps.discoverWorkspacePackages = origDiscover;
});

/** Point the plan-time probes at one in-memory filesystem, renames included. */
function installFs(fs: FakeFs): void {
  _persistPrdDeps.existsSync = (path: string): boolean => fs.files.has(path);
  _persistPrdDeps.renameSync = (from: string, to: string): void => {
    const content = fs.files.get(from);
    fs.files.delete(from);
    if (content !== undefined) fs.files.set(to, content);
    fs.renames.push({ from, to });
  };
  _persistPrdDeps.discoverWorkspacePackages = async () => [];
}

interface PersistOptions {
  readonly fs: FakeFs;
  readonly scope?: ReadonlySet<string>;
}

/** Persist through the seam under test, with the fake filesystem behind it. */
async function persist(prd: PRD, specContent: string, opts: PersistOptions): Promise<string> {
  return finalizeAndWritePrd({
    prd,
    specContent,
    featureName: "feat-x",
    projectName: "fixture",
    agentRouting: undefined,
    profileName: undefined,
    models: MODELS,
    defaultAgent: "claude",
    outputPath: OUTPUT_PATH,
    repoRoot: "/tmp/workdir",
    ...(opts.scope ? { scope: opts.scope } : {}),
    writeFile: async (path: string, content: string) => {
      opts.fs.writes.push(path);
      opts.fs.files.set(path, content);
    },
  });
}

/**
 * The rejection of `promise` as plain strings. Asserting on the instance first
 * means a resolved call fails an assertion instead of dereferencing null.
 */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NaxError);
  return err instanceof NaxError ? { code: err.code, message: err.message } : { code: "", message: "" };
}

/** Capture what the plan logger was told, so log assertions read the real call. */
function captureWarnings(): { calls: Array<{ message: string; data?: Record<string, unknown> }>; restore: () => void } {
  const calls: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const logger = getLogger();
  const original = logger.warn.bind(logger);
  logger.warn = (stage: string, message: string, data?: Record<string, unknown>): void => {
    calls.push({ message, data });
    original(stage, message, data);
  };
  return {
    calls,
    restore: () => {
      logger.warn = original;
    },
  };
}

function makeCtx(fs: FakeFs): PlanModeContext {
  const deps: PlanDeps = {
    readFile: async (path: string) => fs.files.get(path) ?? "",
    writeFile: async (path: string, content: string) => {
      fs.writes.push(path);
      fs.files.set(path, content);
    },
    mkdirp: async () => {},
    existsSync: (path: string) => fs.files.has(path),
    readPackageJson: async () => null,
    readPackageJsonAt: async () => null,
    scanSourceRoots: async () => [],
    spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
    initInteractionChain: async () => null,
    createInteractionBridge: () => ({ detectQuestion: async () => false, onQuestionDetected: async () => "" }),
    getLogger: () => makeLogger(),
  };

  return {
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-x",
    outputPath: OUTPUT_PATH,
    specContent: SPEC_FOUR_STORIES,
    codebaseContext: "context",
    normalizedRoots: [],
    relativePackages: ["packages/lib"],
    packageDetails: [],
    projectName: "fixture",
    branchName: "feat/feat-x",
    timeoutSeconds: 30,
    config: makeNaxConfig(),
    profileName: undefined,
    options: { from: "/tmp/spec.md", feature: "feat-x" },
    runtime: makeMockRuntime({ agentManager: makeMockAgentManager({ getDefaultAgent: "agent-x" }) }),
    interactionChain: null,
    interactionBridge: { detectQuestion: async () => false, onQuestionDetected: async () => "" },
    deps,
  };
}

describe("finalizeAndWritePrd — spec structure enforcement (US-002)", () => {
  test("AC17: rejects an unscoped write that omits a spec story and renames the draft aside", async () => {
    const fs = makeFakeFs({ [OUTPUT_PATH]: JSON.stringify(FOLDED_PRD) });
    installFs(fs);

    const { code, message } = await rejection(persist(FOLDED_PRD, SPEC_FOUR_STORIES, { fs }));

    expect(code).toBe("PLAN_SPEC_STRUCTURE_VIOLATION");
    expect(message).toContain("US-004: missing");
    expect(message).toContain("does not match the spec's declared story structure");
    expect(message).toContain("prd.rejected.json");
    expect(fs.renames).toEqual([{ from: OUTPUT_PATH, to: REJECTED_PATH }]);
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(OUTPUT_PATH)).toBe(false);
  });

  test("AC25: throws without renaming anything when no draft is on disk", async () => {
    const fs = makeFakeFs();
    installFs(fs);

    const { code, message } = await rejection(persist(FOLDED_PRD, SPEC_FOUR_STORIES, { fs }));

    expect(code).toBe("PLAN_SPEC_STRUCTURE_VIOLATION");
    expect(message).toContain("US-004: missing");
    expect(fs.renames).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("AC18: backfills the workdir the spec states and logs what it filled", async () => {
    const fs = makeFakeFs();
    installFs(fs);
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-004" })] });

    const cap = captureWarnings();
    let outputPath = "";
    try {
      outputPath = await persist(prd, SPEC_STATED_WORKDIR, { fs });
    } finally {
      cap.restore();
    }

    expect(outputPath).toBe(OUTPUT_PATH);
    const parsed: PRD = JSON.parse(fs.files.get(OUTPUT_PATH) ?? "{}");
    expect(parsed.userStories.find((s) => s.id === "US-004")?.workdir).toBe("apps/api");

    const backfillWarns = cap.calls.filter(
      (c) => c.message === "PRD stories had no workdir — filled from the spec's Workdir",
    );
    expect(backfillWarns).toHaveLength(1);
    expect(backfillWarns[0]?.data).toMatchObject({ storyIds: ["US-004"] });
  });

  test("AC21: a scoped (--decompose) write is not subject to the structure check", async () => {
    const fs = makeFakeFs();
    installFs(fs);
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-001-A", parentStoryId: "US-001" })],
    });

    const outputPath = await persist(prd, SPEC_ONE_STORY, { fs, scope: new Set(["US-001-A"]) });

    expect(outputPath).toBe(OUTPUT_PATH);
    const parsed: PRD = JSON.parse(fs.files.get(OUTPUT_PATH) ?? "{}");
    expect(parsed.userStories.map((s) => s.id)).toEqual(["US-001", "US-001-A"]);
  });

  test("AC26: warns once when the spec's Workdir statements conflict, so the field is not enforced", async () => {
    const fs = makeFakeFs();
    installFs(fs);
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" })] });

    const cap = captureWarnings();
    let outputPath = "";
    try {
      outputPath = await persist(prd, SPEC_CONFLICTING_WORKDIR, { fs });
    } finally {
      cap.restore();
    }

    expect(outputPath).toBe(OUTPUT_PATH);
    const readWarns = cap.calls.filter(
      (c) => c.message === "spec story structure could not be read — field not enforced",
    );
    expect(readWarns).toHaveLength(1);
    expect(readWarns[0]?.data).toMatchObject({ storyId: "US-001", field: "workdir" });
  });
});

describe("plan strategies — spec structure enforcement (US-002)", () => {
  test("AC19: single rejects the folded PRD rather than recovering it as a degraded result", async () => {
    const fs = makeFakeFs({ [OUTPUT_PATH]: JSON.stringify(FOLDED_PRD) });
    installFs(fs);
    const ctx = makeCtx(fs);
    const originalCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = (async () => FOLDED_PRD) as typeof _singlePlanDeps.callOp;

    try {
      const { code } = await rejection(new SinglePlanStrategy().execute(ctx));
      expect(code).toBe("PLAN_SPEC_STRUCTURE_VIOLATION");
    } finally {
      _singlePlanDeps.callOp = originalCallOp;
    }

    expect(fs.renames).toEqual([{ from: OUTPUT_PATH, to: REJECTED_PATH }]);
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(OUTPUT_PATH)).toBe(false);
  });

  test("AC20: refine rejects the folded PRD rather than returning a degraded PlanResult", async () => {
    const fs = makeFakeFs({ [OUTPUT_PATH]: JSON.stringify(FOLDED_PRD) });
    installFs(fs);
    const ctx = makeCtx(fs);
    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = (async () => FOLDED_PRD) as typeof _refinePlanDeps.callOp;

    try {
      const { code } = await rejection(new RefinePlanStrategy().execute(ctx));
      expect(code).toBe("PLAN_SPEC_STRUCTURE_VIOLATION");
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }

    expect(fs.renames).toEqual([{ from: OUTPUT_PATH, to: REJECTED_PATH }]);
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(OUTPUT_PATH)).toBe(false);
  });
});
