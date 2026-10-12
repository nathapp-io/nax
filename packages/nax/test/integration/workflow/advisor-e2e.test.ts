/** A5 PR3 end to end: residual carry into a dependent's brief, and an answered implementer question. */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestContext,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { AdviceOption, AdvisorReply } from "@/advisor";
import { _advisorServiceDeps } from "@/advisor";
import {
  type AdviseBatchOpOutput,
  type AdviseOpOutput,
  adviseBatchOp,
  adviseOp,
  fullSuiteGateOp,
  lintCheckOp,
  typecheckCheckOp,
  verifyScopedOp,
  workflowImplementOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";
import { _workflowDeps } from "@/workflow/step-context";

const originalDeps = { ..._workflowDeps };
const originalStage = { ..._workflowStageDeps };
const originalAdvisor = { ..._advisorServiceDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_workflowDeps, originalDeps);
  Object.assign(_workflowStageDeps, originalStage);
  Object.assign(_advisorServiceDeps, originalAdvisor);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`command failed (${code}): ${args.join(" ")}\n${stderr}`);
}

const US1 = makeTestStory({ id: "US-1", title: "First", acceptanceCriteria: ["AC-1: locks are ordered"] });
const US2 = makeTestStory({ id: "US-2", title: "Second", dependencies: ["US-1"] });

async function setup() {
  const repo = makeTempDir("wf-adv-repo-");
  const out = makeTempDir("wf-adv-out-");
  dirs.push(repo, out);
  await sh(repo, "git", "init", "-q");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.ts"), "export const a = 1;\n");
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-qm", "seed");
  const config = makeNaxConfig({
    execution: { mode: "workflow" },
    quality: { commands: {} },
    outputDir: out,
    workflow: { maxFixRounds: 1 },
  });
  const runtime = makeTestRuntime({ config, workdir: repo });
  const prd = makeTestPRD([US1, US2]);
  const ctxFor = (story: typeof US1) =>
    makeTestContext({
      config,
      rootConfig: config,
      workdir: repo,
      projectDir: repo,
      runtime,
      prd,
      story,
      stories: [story],
    });
  _workflowStageDeps.buildWorkflowCallContext = async () => ({
    callCtx: makeMockCallContext(),
    dispose: async () => {},
  });
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "seed-sha", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  return { repo, out, ctxFor, feature: prd.feature };
}

interface AgentScript {
  readonly implementer: (n: number, prompt: string) => { status: string; concerns?: string };
  readonly review: unknown;
}

function fakeWorkflowAgent(repo: string, script: AgentScript): string[] {
  const prompts: string[] = [];
  let turns = 0;
  _workflowDeps.callOp = makeScriptedCallOp(async (op, input) => {
    if (op.name === workflowImplementOp.name) {
      turns += 1;
      const prompt = typeof input === "object" && input !== null && "prompt" in input ? String(input.prompt) : "";
      prompts.push(prompt);
      await Bun.write(join(repo, `impl-${turns}.ts`), "export const x = 1;\n");
      await sh(repo, "git", "add", ".");
      await sh(repo, "git", "commit", "-qm", "feat: work");
      return { commits: [], testSummary: "1 pass", interrupted: false, ...script.implementer(turns, prompt) };
    }
    if (op.name === workflowStoryReviewOp.name) return script.review;
    if (op.name === workflowReReviewOp.name) {
      return { verdicts: [{ id: "F1", addressed: false, note: "still open" }], newFindings: [] };
    }
    if (op.name === lintCheckOp.name || op.name === typecheckCheckOp.name) {
      return { success: true, status: "skipped", findings: [], durationMs: 1 };
    }
    if (op.name === verifyScopedOp.name) {
      return { success: true, status: "passed", findings: [], durationMs: 1, passCount: 1, isFullSuite: false };
    }
    if (op.name === fullSuiteGateOp.name) {
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, findings: [], rawOutput: "" };
    }
    throw new Error(`unexpected op ${op.name}`);
  });
  return prompts;
}

const reply = (optionId: string, extra: Partial<AdvisorReply> = {}): AdvisorReply => ({
  optionId,
  rationale: "because",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  ...extra,
});

function optionOfType(options: readonly AdviceOption[], type: AdviceOption["type"]): AdviceOption {
  const found = options.find((o) => o.type === type);
  if (!found) throw new Error(`no ${type} option on the menu`);
  return found;
}

function itemsOf(input: unknown): { id: string; options: readonly AdviceOption[] }[] {
  if (typeof input !== "object" || input === null || !("items" in input) || !Array.isArray(input.items)) return [];
  return input.items;
}

function questionOptionsOf(input: unknown): readonly AdviceOption[] {
  if (typeof input !== "object" || input === null || !("question" in input)) return [];
  const q = input.question;
  return typeof q === "object" && q !== null && "options" in q && Array.isArray(q.options) ? q.options : [];
}

async function readDecisions(repo: string, feature: string) {
  const text = await Bun.file(join(repo, ".nax", "features", feature, "decisions.jsonl")).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("workflow advisor kinds end to end", () => {
  test("residual carry: US-1 closes with rulings; US-2's brief carries the instruction", async () => {
    const { repo, out, ctxFor, feature } = await setup();
    fakeWorkflowAgent(repo, {
      implementer: () => ({ status: "DONE" }),
      review: {
        spec: "fail",
        quality: "approved",
        findings: [{ severity: "important", kind: "spec", acId: "AC-1", issue: "lock order differs" }],
        cannotVerify: [],
      },
    });
    _advisorServiceDeps.callOp = makeScriptedCallOp((op, input): AdviseBatchOpOutput => {
      if (op.name !== adviseBatchOp.name) throw new Error(`unexpected advisor op ${op.name}`);
      const answers = itemsOf(input).map((item) => ({
        itemId: item.id,
        reply: reply(optionOfType(item.options, "carry").id, { instruction: "Keep the lock order from US-1" }),
        raw: {},
      }));
      return { ok: true, answers, diagnoses: {}, conflicts: [], overlap: [] };
    });

    const ctx1 = ctxFor(US1);
    expect(await workflowStage.execute(ctx1)).toEqual({ action: "continue" });

    const runDir = join(out, "workflow", feature, ctx1.runtime.runId);
    const result = await Bun.file(join(runDir, "result.json")).json();
    expect(result.stories["US-1"].state).toBe("complete-with-rulings");
    const decisions = await readDecisions(repo, feature);
    const residual = decisions.filter((d) => d.kind === "residual");
    expect(residual).toHaveLength(1);
    expect(residual[0].action).toMatchObject({ type: "carry", toStories: ["US-2"] });
    expect(residual[0].appliesTo).toEqual(["US-2"]);
    const ledger = await Bun.file(join(runDir, "ledger.md")).text();
    expect(ledger).toContain("US-1: Ruling: Keep the lock order from US-1 — ");

    await workflowStage.execute(ctxFor(US2));
    const brief = await Bun.file(join(runDir, "US-2", "brief.md")).text();
    expect(brief).toContain(`Carried from US-1 (${residual[0].id}): Keep the lock order from US-1`);
  });

  test("implementer question: an answered NEEDS_CONTEXT reaches the next implementer turn", async () => {
    const { repo, ctxFor, feature } = await setup();
    const prompts = fakeWorkflowAgent(repo, {
      implementer: (n) => (n === 1 ? { status: "NEEDS_CONTEXT", concerns: "Which DB?" } : { status: "DONE" }),
      review: { spec: "pass", quality: "approved", findings: [], cannotVerify: [] },
    });
    _advisorServiceDeps.callOp = makeScriptedCallOp((op, input): AdviseOpOutput => {
      if (op.name !== adviseOp.name) throw new Error(`unexpected advisor op ${op.name}`);
      const options = questionOptionsOf(input);
      return { ok: true, reply: reply(optionOfType(options, "answer").id, { instruction: "Use Postgres." }) };
    });

    await workflowStage.execute(ctxFor(US1));

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Use Postgres.");
    const decisions = await readDecisions(repo, feature);
    const asked = decisions.filter((d) => d.kind === "implementer-question");
    expect(asked).toHaveLength(1);
    expect(asked[0].action).toMatchObject({ type: "answer", text: "Use Postgres." });
  });

  test("implementer question: a hold reply sends no answer turn", async () => {
    const { repo, ctxFor, feature } = await setup();
    const prompts = fakeWorkflowAgent(repo, {
      implementer: () => ({ status: "NEEDS_CONTEXT", concerns: "Which DB?" }),
      review: { spec: "pass", quality: "approved", findings: [], cannotVerify: [] },
    });
    _advisorServiceDeps.callOp = makeScriptedCallOp((op, input): AdviseOpOutput => {
      if (op.name !== adviseOp.name) throw new Error(`unexpected advisor op ${op.name}`);
      const options = questionOptionsOf(input);
      return { ok: true, reply: reply(optionOfType(options, "hold").id, { reason: "needs a human" }) };
    });

    await workflowStage.execute(ctxFor(US1));

    expect(prompts).toHaveLength(1);
    const decisions = await readDecisions(repo, feature);
    const asked = decisions.filter((d) => d.kind === "implementer-question");
    expect(asked).toHaveLength(1);
    expect(asked[0].action.type).toBe("hold");
  });
});
