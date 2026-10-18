/**
 * US-007 — the run's project-context override, end to end through the three
 * surfaces that carry it.
 *
 *   1. `writeBrief` — the story brief gets a "## Project context (run override)"
 *      section from `_workflowDeps.loadProjectContextOverride`.
 *   2. `runBranchReview` — the branch review package gets the same section,
 *      appended inside the package callback so a failure skips the review rather
 *      than handing the reviewer a half-built package. It is independent of rules
 *      delivery mode.
 *   3. `initializeAfterLock` — the file is validated where the rules override is,
 *      before `configureLoopHandlers` and before any story runs, and a
 *      `mode: "replace"` run whose default agent is not `native` is warned about
 *      once and continues.
 *
 * The loader's own byte-cap and error codes are
 * `test/unit/context/project-context-override.test.ts`; the deny paths it feeds
 * are `test/unit/session/instruction-options.test.ts`. This file covers the
 * wiring between them.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import {
  assertNaxError,
  cleanupTempDir,
  makeFeatureContext,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeSessionManager,
  makeStatusWriter,
  makeStepContext,
  makeStory,
  makeTempDir,
  makeTestStory,
  withWarnSpy,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _runRulesSetupDeps } from "@/execution/lifecycle/run-rules-setup";
import type { InitializeAfterLockResult } from "@/execution/lifecycle/run-setup-init";
import { initializeAfterLock } from "@/execution/lifecycle/run-setup-init";
import { workflowBranchReviewOp } from "@/operations";
import { runBranchReview } from "@/workflow/branch-review";
import { writeBrief } from "@/workflow/brief";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict } from "@/workflow/types";

const HEADING = "## Project context (run override)";
const OVERRIDE = "X-OVERRIDE";
const FEATURE = "lazy-rules-us-007";
const RUN_ID = "run-us-007";

const dirs: string[] = [];

afterEach(() => {
  Object.assign(_workflowDeps, workflowDepsOriginal);
  _runRulesSetupDeps.loadProjectContextOverride = realLoadProjectContextOverride;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

const workflowDepsOriginal = { ..._workflowDeps };
const realLoadProjectContextOverride = _runRulesSetupDeps.loadProjectContextOverride;

/** A fresh temp dir, removed by the file-level afterEach. */
function freshDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

/** Pin `_workflowDeps.loadProjectContextOverride` for one test. */
function stubWorkflowLoader(load: (config: NaxConfig) => Promise<string | undefined>): void {
  _workflowDeps.loadProjectContextOverride = load;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — the story brief
// ─────────────────────────────────────────────────────────────────────────────

/** A `StepContext` that writes a real brief into a temp project dir. */
function briefContext(config: NaxConfig) {
  const root = freshDir("wf-project-context-brief-");
  const runDir = join(root, "run");
  return makeStepContext({
    story: makeTestStory({ id: "US-007", acceptanceCriteria: ["deliver the override"] }),
    projectDir: root,
    workdir: root,
    runDir,
    outputDir: join(root, "out"),
    storyDir: join(runDir, "US-007"),
    briefPath: join(runDir, "US-007", "brief.md"),
    reportPath: join(runDir, "US-007", "report.md"),
    config,
    callCtx: makeMockCallContext({ agentName: "claude" }),
  });
}

describe("writeBrief — the project-context override (AC-8)", () => {
  test("AC-8: the configured override lands in brief.md under the section heading", async () => {
    const seen: NaxConfig[] = [];
    stubWorkflowLoader(async (config) => {
      seen.push(config);
      return OVERRIDE;
    });
    const sc = briefContext(makeNaxConfig({ context: { projectContext: { file: "/abs/org-context.md" } } }));

    await writeBrief(sc);

    const text = await Bun.file(sc.briefPath).text();
    expect(text).toContain(HEADING);
    expect(text).toContain(`${HEADING}\n\n${OVERRIDE}`);
    // The loader was asked with the run's own config, not a default.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(sc.config);
  });

  test("AC-8: the override body is verbatim, including trailing whitespace", async () => {
    stubWorkflowLoader(async () => "# Org context\n\n  Indented body.  \n");
    const sc = briefContext(makeNaxConfig());

    await writeBrief(sc);

    expect(await Bun.file(sc.briefPath).text()).toContain(`${HEADING}\n\n# Org context\n\n  Indented body.  \n`);
  });

  test("no configured file writes no section", async () => {
    stubWorkflowLoader(async () => undefined);
    const sc = briefContext(makeNaxConfig());

    await writeBrief(sc);

    expect(await Bun.file(sc.briefPath).text()).not.toContain(HEADING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — the branch review package
// ─────────────────────────────────────────────────────────────────────────────

/** Stub git: every query answers empty except `--name-status`, which answers one added file. */
function stubPackageGit(records = "A\0a.ts\0"): void {
  _workflowDeps.git = async (args) => ({ stdout: args.includes("--name-status") ? records : "", exitCode: 0 });
}

const BRANCH_VERDICT: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};

const FACTS = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

/**
 * A feature context with a temp runDir, its package queries closed and the rules
 * map stubbed. `events` records the order the rules append and the review op ran
 * in, so a test can assert the section lands in the package the reviewer opens.
 */
function branchReviewContext(config = makeNaxConfig(), events: string[] = []) {
  const runDir = freshDir("wf-project-context-branch-");
  stubPackageGit();
  _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
  _workflowDeps.appendChangedFileRules = async () => {
    events.push("rules");
  };
  _workflowDeps.callOp = makeScriptedCallOp((op) => {
    expect(op.name).toBe(workflowBranchReviewOp.name);
    events.push("op");
    return BRANCH_VERDICT;
  });
  return makeFeatureContext({ runDir, config });
}

describe("runBranchReview — the project-context override (AC-9)", () => {
  test("AC-9: the package ends with the section heading followed by the override", async () => {
    stubWorkflowLoader(async () => OVERRIDE);
    const events: string[] = [];
    const fc = branchReviewContext(makeNaxConfig(), events);

    const outcome = await runBranchReview(fc, { seed: "seed0", facts: FACTS });

    expect(outcome.ran).toBe(true);
    const text = await Bun.file(join(fc.runDir, "package-branch.diff")).text();
    expect(text).toContain(HEADING);
    expect(text).toContain(`${HEADING}\n\n${OVERRIDE}\n`);
    // The append is in the package callback: it happens before the review op runs.
    expect(events).toEqual(["rules", "op"]);
  });

  test("AC-9: the prior package content and its requiredFiles processing survive the append", async () => {
    stubWorkflowLoader(async () => OVERRIDE);
    const fc = branchReviewContext();

    const outcome = await runBranchReview(fc, { seed: "seed0", facts: FACTS });

    const text = await Bun.file(join(fc.runDir, "package-branch.diff")).text();
    expect(text).toContain("## Commits (seed0..HEAD)");
    expect(text).toContain("## Changed files (1)");
    // The heading is appended, not prepended: the package writer's own text comes first.
    expect(text.indexOf("## Commits")).toBeLessThan(text.indexOf(HEADING));
    // The required-set processing still ran: the verdict's one changed file is unread.
    expect(outcome.ran && outcome.verdict.unreadFiles).toEqual(["a.ts"]);
  });

  test("AC-9: the section is independent of rules delivery mode — 'push' still gets it", async () => {
    stubWorkflowLoader(async () => OVERRIDE);
    const fc = branchReviewContext(makeNaxConfig({ context: { rules: { delivery: "push" } } }));

    expect((await runBranchReview(fc, { seed: "seed0", facts: FACTS })).ran).toBe(true);

    expect(await Bun.file(join(fc.runDir, "package-branch.diff")).text()).toContain(`${HEADING}\n\n${OVERRIDE}`);
  });

  test("no configured file leaves the package exactly as the writer produced it", async () => {
    stubWorkflowLoader(async () => undefined);
    const fc = branchReviewContext();

    await runBranchReview(fc, { seed: "seed0", facts: FACTS });

    expect(await Bun.file(join(fc.runDir, "package-branch.diff")).text()).not.toContain(HEADING);
  });

  test("a loader that throws skips the review instead of handing over a half-built package", async () => {
    stubWorkflowLoader(async () => {
      throw new Error("context exploded");
    });
    const fc = branchReviewContext();

    const outcome = await runBranchReview(fc, { seed: "seed0", facts: FACTS });

    expect(outcome.ran).toBe(false);
    expect(!outcome.ran && outcome.why).toBe("review package failed: context exploded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 / AC-6 / AC-15 / AC-16 / AC-17 / AC-18 — run-start validation
// ─────────────────────────────────────────────────────────────────────────────

const DEPS = {
  detectProjectProfile: async () => ({}),
  sweepFeatureTranscripts: async () => 0,
};

/** A temp workdir holding the feature's prd.json and one loop-handler plugin. */
async function makeRunWorkdir(prefix: string): Promise<string> {
  const dir = freshDir(prefix);
  const pluginDir = join(dir, ".nax", "plugins");
  await fs.mkdir(pluginDir, { recursive: true });
  await Bun.write(
    join(pluginDir, "seed-note-plugin.ts"),
    `export default {
  name: "seed-note-plugin",
  version: "1.0.0",
  provides: ["loop-handlers"],
  extensions: { loopHandlers: { register(on) { on("before_turn", () => ({ seed: [] })); } } },
};
`,
  );
  return dir;
}

/** Run the real post-lock initialization, counting `configureLoopHandlers` calls. */
async function runInitializeAfterLock(
  workdir: string,
  config: NaxConfig,
): Promise<{ result?: InitializeAfterLockResult; error?: unknown; configureCalls: number }> {
  const prdPath = join(workdir, ".nax", "features", FEATURE, "prd.json");
  await fs.mkdir(dirname(prdPath), { recursive: true });
  const prd = makePRD({ feature: FEATURE, userStories: [makeStory({ id: "US-007" })] });
  await Bun.write(prdPath, JSON.stringify(prd, null, 2));
  let configureCalls = 0;
  try {
    const result = await initializeAfterLock({
      config,
      workdir,
      feature: FEATURE,
      dryRun: true,
      runtime: makeMockRuntime({
        workdir,
        sessionManager: makeSessionManager({ configureLoopHandlers: (_set: LoopHandlerSet) => configureCalls++ }),
      }),
      prdPath,
      prd,
      interactionChain: null,
      runId: RUN_ID,
      statusWriter: makeStatusWriter(),
      deps: DEPS,
    });
    return { result, configureCalls };
  } catch (error) {
    return { error, configureCalls };
  }
}

/** A file of exactly `bytes` bytes, so the size gate has something real to measure. */
async function writeSizedContextFile(path: string, bytes: number): Promise<void> {
  await Bun.write(path, "x".repeat(bytes));
}

describe("initializeAfterLock — a missing project-context file (AC-5, AC-6)", () => {
  /** The exact failure the real loader produces for `file`; the seam only replaces the disk read. */
  function rejectWithNotFound(file: string): void {
    _runRulesSetupDeps.loadProjectContextOverride = async () => {
      throw new NaxError(`context.projectContext.file does not exist: ${file}`, "PROJECT_CONTEXT_FILE_NOT_FOUND", {
        stage: "run-setup",
        file,
      });
    };
  }

  test("AC-5: the loader's PROJECT_CONTEXT_FILE_NOT_FOUND rejects the run", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-missing-");
    const file = join(workdir, "gone.md");
    rejectWithNotFound(file);

    const { error, configureCalls } = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { projectContext: { file } } }),
    );

    assertNaxError(error, "initializeAfterLock rejection");
    expect(error.code).toBe("PROJECT_CONTEXT_FILE_NOT_FOUND");
    expect(configureCalls).toBe(0);
  });

  test("AC-6: the same failure leaves configureLoopHandlers uncalled", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-uncalled-");
    const file = join(workdir, "gone.md");
    rejectWithNotFound(file);

    const { configureCalls, result } = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { projectContext: { file } } }),
    );

    expect(configureCalls).toBe(0);
    expect(result).toBeUndefined();
  });
});

describe("initializeAfterLock — the file really is loaded at run start (AC-15..AC-18)", () => {
  test("AC-15: replace mode with a configured file and default agent claude warns once on run-setup", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-warn-");
    const file = join(workdir, "org-context.md");
    await Bun.write(file, "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      const { error } = await runInitializeAfterLock(
        workdir,
        makeNaxConfig({ agent: { default: "claude" }, context: { projectContext: { file, mode: "replace" } } }),
      );

      expect(error).toBeUndefined();
      const runSetup = warnSpy.mock.calls.filter((call) => call[0] === "run-setup");
      expect(runSetup).toHaveLength(1);
      const message = runSetup[0]?.[1] ?? "";
      expect(message).toContain("native sessions only");
      expect(message).toContain("still load the repository's own instruction files");
    });
  });

  test("AC-16: the run continues past the native-only warning", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-continues-");
    const file = join(workdir, "org-context.md");
    await Bun.write(file, "# Org context\n");

    const { result, error, configureCalls } = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ agent: { default: "claude" }, context: { projectContext: { file, mode: "replace" } } }),
    );

    expect(error).toBeUndefined();
    expect(result?.pluginRegistry.getLoopHandlers()).toHaveLength(1);
    expect(configureCalls).toBe(1);
  });

  test("AC-17: a native default agent gets no such warning", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-native-");
    const file = join(workdir, "org-context.md");
    await Bun.write(file, "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      const { error } = await runInitializeAfterLock(
        workdir,
        makeNaxConfig({ agent: { default: "native" }, context: { projectContext: { file, mode: "replace" } } }),
      );

      expect(error).toBeUndefined();
      const runSetup = warnSpy.mock.calls.filter((call) => call[0] === "run-setup");
      expect(runSetup).toEqual([]);
    });
  });

  test("AC-17: claude in append mode gets no such warning either", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-append-");
    const file = join(workdir, "org-context.md");
    await Bun.write(file, "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      const { error } = await runInitializeAfterLock(
        workdir,
        makeNaxConfig({ agent: { default: "claude" }, context: { projectContext: { file, mode: "append" } } }),
      );

      expect(error).toBeUndefined();
      expect(warnSpy.mock.calls.filter((call) => call[0] === "run-setup")).toEqual([]);
    });
  });

  test("AC-18: a file over 32,768 bytes rejects with PROJECT_CONTEXT_FILE_TOO_LARGE before any story runs", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-large-");
    const file = join(workdir, "org-context.md");
    await writeSizedContextFile(file, 32_769);

    const { error, configureCalls } = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { projectContext: { file, mode: "append" } } }),
    );

    assertNaxError(error, "initializeAfterLock rejection");
    expect(error.code).toBe("PROJECT_CONTEXT_FILE_TOO_LARGE");
    expect(error.context).toMatchObject({ stage: "run-setup", file, bytes: 32_769, maxBytes: 32_768 });
    expect(configureCalls).toBe(0);
  });

  test("a file of exactly 32,768 bytes is accepted", async () => {
    const workdir = await makeRunWorkdir("nax-project-context-at-cap-");
    const file = join(workdir, "org-context.md");
    await writeSizedContextFile(file, 32_768);

    const { error, result } = await runInitializeAfterLock(
      workdir,
      makeNaxConfig({ context: { projectContext: { file, mode: "append" } } }),
    );

    expect(error).toBeUndefined();
    expect(result).toBeDefined();
  });
});
