import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { ForgeDeps, PrRef } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { type PipelineEvent, pipelineEventBus } from "@/pipeline/event-bus";
import { _ciFailuresDeps } from "@/workflow/ci-failures";
import { buildFeatureEnv } from "@/workflow/feature-env";
import { newFeatureRecord } from "@/workflow/feature-record";
import { readResult } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { startTokenMeter } from "@/workflow/tokens";
import { resetToolErrorClaims } from "@/workflow/tool-error-outcome";

const original = { ..._workflowDeps };
const originalCi = { ..._ciFailuresDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  Object.assign(_ciFailuresDeps, originalCi);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const noDecisions: Advisor = {
  advise: async () => ({ decision: null, fallbackReason: "off" }),
  recordReuse: async () => null,
  adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
};

function setup(over: (runDir: string) => Parameters<typeof makeFeatureContext>[0] = () => ({})) {
  const runDir = makeTempDir("wf-env-");
  dirs.push(runDir);
  _workflowDeps.createAdvisor = () => noDecisions;
  const fc = makeFeatureContext({ runDir, ...over(runDir) });
  const blocks: unknown[] = [];
  const env = buildFeatureEnv(
    fc,
    {
      runtime: fc.callCtx.runtime,
      config: fc.config,
      prd: fc.prd,
      feature: fc.feature,
      workdir: fc.projectDir,
      branch: fc.branch,
      runId: fc.runId,
      agentName: "claude",
      statusWriter: { setWorkflowStatus: (b) => blocks.push(b) },
    },
    {
      stories: [{ id: "US-001", title: "A", state: "complete", rounds: 2, unreviewed: false, flagged: 0 }],
      ledgerItems: { deferredMinors: [], cannotVerify: [], parked: [] },
      record: {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        tokensByRole: { "wf-implementer": { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 } },
      },
      meter: startTokenMeter(undefined),
      preflight: null,
      specPath: "",
    },
  );
  return { fc, env, blocks };
}

describe("buildFeatureEnv step wiring (nax#2491 P6, P8)", () => {
  test("the branch fix reports repeated tool errors after the step, and names its model", async () => {
    resetLogger();
    resetToolErrorClaims();
    const logs: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    try {
      const { fc, env } = setup((runDir) => ({
        outputDir: join(runDir, "out"),
        reportPath: join(runDir, "feature-report.md"),
      }));
      const audit = join(fc.outputDir, "tool-audit", fc.feature);
      _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
      _workflowDeps.callOp = makeScriptedCallOp(() => {
        const edit = { tool: "Edit", outcome: "error", input: { file_path: "src/a.ts" } };
        mkdirSync(audit, { recursive: true });
        writeFileSync(
          join(audit, `${fc.runId}-${Date.now() + 5}-s.json`),
          JSON.stringify({ calls: [edit, edit, edit] }),
        );
        return { status: "DONE", commits: [], testSummary: "", interrupted: false };
      });
      await env.steps.branchFix([{ id: "B1", kind: "quality", severity: "important", issue: "x" }]);
      expect(env.steps.modelFor?.("branch-fix")).toMatchObject({
        agentName: expect.any(String),
        model: expect.any(String),
      });
      expect(logs.map((e) => e.message)).toContain("branch-fix: 3 Edit errors on src/a.ts, then gave up");
    } finally {
      resetLogger();
    }
  });
});

describe("buildFeatureEnv", () => {
  test("sink.update writes featureWorkflow into this run's result.json, keeping prior tokens", async () => {
    const { fc, env } = setup();
    await env.sink.update({ ...env.record, step: "branch-review" });
    const file = await readResult(fc.runDir);
    expect(file?.featureWorkflow?.step).toBe("branch-review");
    expect(file?.featureWorkflow?.tokensByRole["wf-implementer"]?.calls).toBe(1);
  });

  // nax#2547 / nax#2548: the machine's round caps come from the run's workflow config.
  test("limits carry workflow.maxBranchFixRounds and workflow.finalGateRepairRounds", () => {
    const { env } = setup(() => ({
      workflow: { ...makeFeatureContext().workflow, maxBranchFixRounds: 4, finalGateRepairRounds: 0 },
    }));
    expect(env.limits).toEqual({ maxBranchFixRounds: 4, finalGateRepairRounds: 0, ciRepairRounds: 1 });
  });

  // US-008: the CI repair cap is a workflow config value, like the other two.
  test("AC-1: limits carry the configured workflow.ciRepairRounds", () => {
    const { env } = setup(() => ({
      workflow: { ...makeFeatureContext().workflow, ciRepairRounds: 3 },
    }));
    expect(env.limits).toEqual({ maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 3 });
  });

  test("sink.step sets the status.json workflow block", () => {
    const { env, blocks } = setup();
    env.sink.step("publish", { ...env.record, outcome: "draft", url: "u" });
    expect(blocks).toEqual([
      { step: "publish", stories: { "US-001": { state: "complete", round: 2 } }, outcome: "draft", url: "u" },
    ]);
  });

  test("adjudicate is feature-scoped: default holds land as _run ledger lines (P4-R18)", async () => {
    const { fc, env } = setup();
    const rulings = await env.steps.adjudicate([{ id: "B1", kind: "quality", severity: "important", issue: "drift" }]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0]?.action).toBe("hold");
    expect(await Bun.file(join(fc.runDir, "ledger.md")).text()).toContain("_run: Ruling: hold B1: drift");
  });
});

// US-003: the real sink emits `workflow:step` for every step but the terminal `done`, alongside the
// status block it already wrote. No hook is wired yet (US-004), so these read the singleton bus.
describe("buildFeatureEnv sink step events (US-003)", () => {
  let events: PipelineEvent[] = [];
  let off: (() => void) | undefined;

  beforeEach(() => {
    pipelineEventBus.clear();
    events = [];
    off = pipelineEventBus.onAll((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    off?.();
    off = undefined;
    pipelineEventBus.clear();
  });

  const stepEvents = (): PipelineEvent[] => events.filter((e) => e.type === "workflow:step");

  test("AC-9: sink.step('branch-review', record) emits exactly one workflow:step", () => {
    const { env } = setup();
    env.sink.step("branch-review", env.record);
    expect(stepEvents()).toEqual([{ type: "workflow:step", step: "branch-review" }]);
  });

  test("AC-10: sink.step('done', record) emits no workflow:step", () => {
    const { env } = setup();
    // The control: the same sink does emit for a real step, so the single event below is that one —
    // the terminal `done` call added nothing.
    env.sink.step("branch-review", env.record);
    env.sink.step("done", env.record);
    expect(stepEvents()).toEqual([{ type: "workflow:step", step: "branch-review" }]);
  });

  test("AC-15: sink.step('publish', record) keeps the status-block update alongside the step event", () => {
    const { env, blocks } = setup();
    env.sink.step("publish", { ...env.record, outcome: "draft", url: "u" });
    expect(blocks).toEqual([
      { step: "publish", stories: { "US-001": { state: "complete", round: 2 } }, outcome: "draft", url: "u" },
    ]);
    expect(stepEvents()).toEqual([{ type: "workflow:step", step: "publish" }]);
  });
});

// US-002: `opts.repair` is what routes a repair session's dispatch to `workflow-repair`. These go
// through the real `buildFeatureEnv` seam so the option -> `kind` -> op mapping is the production one.
describe("buildFeatureEnv repair routing (US-002)", () => {
  const findings = [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }] as const;

  /** The op names and call contexts of every dispatch the step made, in order. */
  function dispatched(): { ops: string[]; contexts: CallContext[] } {
    const ops: string[] = [];
    const contexts: CallContext[] = [];
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    _workflowDeps.callOp = makeScriptedCallOp((op, _input, ctx) => {
      ops.push(op.name);
      contexts.push(ctx);
      return { status: "DONE", commits: [], testSummary: "", interrupted: false };
    });
    return { ops, contexts };
  }

  const setupWithReport = () =>
    setup((runDir) => ({ outputDir: join(runDir, "out"), reportPath: join(runDir, "feature-report.md") }));

  test("AC-1: branchFix(findings, { repair: true }) dispatches workflow-repair", async () => {
    const { ops } = dispatched();
    const { env } = setupWithReport();
    await env.steps.branchFix(findings, { repair: true });
    expect(ops).toEqual(["workflow-repair"]);
  });

  test("AC-2: branchFix(findings) dispatches workflow-branch-fix", async () => {
    const { ops } = dispatched();
    const { env } = setupWithReport();
    await env.steps.branchFix(findings);
    expect(ops).toEqual(["workflow-branch-fix"]);
  });

  test("AC-3: a repair with a PR URL keeps the one forge read provider", async () => {
    const { ops, contexts } = dispatched();
    const { env } = setupWithReport();
    await env.steps.branchFix(findings, { repair: true, prUrl: "https://github.com/o/r/pull/7" });
    expect(ops).toEqual(["workflow-repair"]);
    expect(contexts[0]?.toolProviders).toHaveLength(1);
  });
});

// US-008: the production seam. The publish step reads the failed CI checks of the PR it opened, and
// the reader is the real forge reader — so these go through `buildFeatureEnv(...).steps`.
describe("buildFeatureEnv CI failure reader (US-008)", () => {
  const REF: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 9 };
  const PR_URL = "https://github.com/o/r/pull/9";
  const forgeDeps = (): ForgeDeps => ({
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readText: async () => null,
  });

  test("AC-2: the PR number, the forge deps and the project dir resolve the PR ref", async () => {
    const forge = forgeDeps();
    const calls: unknown[][] = [];
    _ciFailuresDeps.forge = forge;
    _ciFailuresDeps.resolvePrRef = async (number, deps, cwd) => {
      calls.push([number, deps, cwd]);
      return REF;
    };
    _ciFailuresDeps.readFailedChecks = async () => [];
    const { env } = setup();
    assertDefined(env.steps.readCiFailures, "steps.readCiFailures");
    await env.steps.readCiFailures({ url: PR_URL, head: "abc" });
    expect(calls).toEqual([[9, forge, "/repo"]]);
  });

  test("AC-3: the resolved ref, the head, the forge deps and the project dir read the failed checks", async () => {
    const forge = forgeDeps();
    const calls: unknown[][] = [];
    _ciFailuresDeps.forge = forge;
    _ciFailuresDeps.resolvePrRef = async () => REF;
    _ciFailuresDeps.readFailedChecks = async (ref, head, deps, cwd) => {
      calls.push([ref, head, deps, cwd]);
      return [];
    };
    const { env } = setup();
    assertDefined(env.steps.readCiFailures, "steps.readCiFailures");
    await env.steps.readCiFailures({ url: PR_URL, head: "abc" });
    expect(calls).toEqual([[REF, "abc", forge, "/repo"]]);
  });

  test("AC-4: the failed checks the forge read are what the step returns", async () => {
    const checks = [{ name: "e2e", url: "u", excerpt: "boom" }];
    _ciFailuresDeps.forge = forgeDeps();
    _ciFailuresDeps.resolvePrRef = async () => REF;
    _ciFailuresDeps.readFailedChecks = async () => checks;
    const { env } = setup();
    assertDefined(env.steps.readCiFailures, "steps.readCiFailures");
    expect(await env.steps.readCiFailures({ url: PR_URL, head: "abc" })).toEqual(checks);
  });
});
