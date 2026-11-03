/**
 * workflow-memory-prompts.test.ts — US-007: the workflow steps read the run's fresh memory
 * index once and put it in the brief or prompt they build.
 *
 * Three caller seams, each driven through a call context whose runtime carries a fake run
 * memory: `writeBrief` (asserted on the brief file it writes), `runBranchFix` (asserted on the
 * exact prompt `_workflowDeps.callOp` receives, for the branch fix, the CI repair and an
 * explicit override) and `runBranchReview` (the read-only reference section). The bots compose
 * their runtime without a run memory, which is why the no-memory cases matter as much as the
 * index ones: both stay byte for byte what they were.
 *
 * An index read costs a render, so the override case counts the reads: a prompt nax is handed
 * whole is not a prompt nax built, and building nothing must not touch the mirror.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  type FakeRunMemory,
  makeFakeRunMemory,
  makeFeatureContext,
  makeMockCallContext,
  makeScriptedCallOp,
  makeStepContext,
  makeTempDir,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { RunMemory } from "@/memory";
import type { CallContext } from "@/operations";
import { buildMemoryReferenceSection, memorySectionOf } from "@/prompts";
import { runBranchFix } from "@/workflow/branch-fix";
import { runBranchReview } from "@/workflow/branch-review";
import { writeBrief } from "@/workflow/brief";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";

/** The index every positive case hands over; the sections around it are the assertion. */
const INDEX_LINE = "INDEX-LINE";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** A run memory whose `index()` answers `INDEX_LINE`, and how many times it was asked. */
function fakeRunMemory(): FakeRunMemory {
  return makeFakeRunMemory({ index: async () => INDEX_LINE });
}

/** A call context over a real runtime carrying `memory`, or none at all when it is omitted. */
function callCtxWith(memory?: RunMemory): CallContext {
  return makeMockCallContext({ runtime: makeTestRuntime({ memory }) });
}

/** A `StepContext` that writes its brief into a temp project dir. */
function briefContext(callCtx: CallContext): StepContext {
  const root = makeTempDir("wf-memory-brief-");
  dirs.push(root);
  const runDir = join(root, "run");
  return makeStepContext({
    story: makeTestStory({ id: "US-007", acceptanceCriteria: ["carries memory"] }),
    projectDir: root,
    workdir: root,
    runDir,
    outputDir: join(root, "out"),
    storyDir: join(runDir, "US-007"),
    briefPath: join(runDir, "US-007", "brief.md"),
    reportPath: join(runDir, "US-007", "report.md"),
    callCtx,
  });
}

/** Hermetic brief inputs: no feature spec, no advisor ledger, no rules — memory is the only variable. */
function stubBriefInputs(): void {
  _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
  _workflowDeps.readTrustedDecisions = async () => [];
}

/** The brief file `writeBrief` wrote, as text. */
async function briefText(sc: StepContext): Promise<string> {
  stubBriefInputs();
  await writeBrief(sc);
  return await Bun.file(sc.briefPath).text();
}

/** A feature context over a temp run dir, with the git and commit seams stubbed out. */
function featureContext(callCtx: CallContext) {
  const runDir = makeTempDir("wf-memory-fix-");
  dirs.push(runDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  _workflowDeps.autoCommitIfDirty = async () => {};
  return makeFeatureContext({ runDir, reportPath: join(runDir, "feature-report.md"), callCtx });
}

/** The prompt every dispatched op received, in dispatch order. */
function capturePrompts(reply: unknown): string[] {
  const prompts: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((_op, input) => {
    prompts.push((input as { prompt: string }).prompt);
    return reply;
  });
  return prompts;
}

const FINDINGS = [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }] as const;
const DONE_REPLY = { status: "DONE", commits: [], testSummary: "3 pass", interrupted: false };
const PASS_VERDICT = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const REVIEW_FACTS = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

const memorySection = memorySectionOf(INDEX_LINE);

describe("writeBrief — the run's memory index (AC-1..AC-3)", () => {
  test("AC-1: a run memory's index reaches the brief file", async () => {
    const fake = fakeRunMemory();
    const text = await briefText(briefContext(callCtxWith(fake.memory)));
    assertDefined(memorySection, "the implementer memory section");
    expect(text).toContain("# Brief: US-007");
    expect(text).toContain(memorySection);
    // Once per brief, not once per section: the positive control for AC-7's zero.
    expect(fake.reads()).toBe(1);
  });

  test("AC-2: a call context without a run memory writes no ## Memory heading", async () => {
    const text = await briefText(briefContext(callCtxWith()));
    expect(text).toContain("# Brief: US-007");
    expect(text).not.toContain("## Memory");
  });

  test("AC-3: a run memory whose index is undefined writes no ## Memory heading", async () => {
    const { memory } = makeFakeRunMemory();
    const text = await briefText(briefContext(callCtxWith(memory)));
    expect(text).toContain("# Brief: US-007");
    expect(text).not.toContain("## Memory");
  });
});

describe("runBranchFix — the run's memory index (AC-4..AC-8)", () => {
  test("AC-4: the branch fix prompt carries the index", async () => {
    const fake = fakeRunMemory();
    const prompts = capturePrompts(DONE_REPLY);
    await runBranchFix(featureContext(callCtxWith(fake.memory)), { findings: [...FINDINGS] });
    expect(prompts).toHaveLength(1);
    assertDefined(memorySection, "the fix memory section");
    expect(prompts[0]).toContain(memorySection);
    expect(fake.reads()).toBe(1);
  });

  test("AC-5: the CI repair prompt carries the index after its own opening", async () => {
    const { memory } = fakeRunMemory();
    const prompts = capturePrompts(DONE_REPLY);
    await runBranchFix(featureContext(callCtxWith(memory)), {
      findings: [...FINDINGS],
      kind: "repair",
      ciRepair: { round: 1 },
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    expect(prompt.startsWith("You are repairing the CI of")).toBe(true);
    assertDefined(memorySection, "the CI repair memory section");
    expect(prompt).toContain(memorySection);
  });

  test("AC-6: an explicit prompt is used as given, memory and all", async () => {
    const { memory } = fakeRunMemory();
    const prompts = capturePrompts(DONE_REPLY);
    await runBranchFix(featureContext(callCtxWith(memory)), { findings: [...FINDINGS], prompt: "OWN PROMPT" });
    expect(prompts).toEqual(["OWN PROMPT"]);
  });

  test("AC-7: an explicit prompt reads no index at all", async () => {
    const fake = fakeRunMemory();
    capturePrompts(DONE_REPLY);
    await runBranchFix(featureContext(callCtxWith(fake.memory)), {
      findings: [...FINDINGS],
      prompt: "OWN PROMPT",
    });
    expect(fake.reads()).toBe(0);
  });

  test("AC-8: a call context without a run memory builds the prompt without ## Memory", async () => {
    const prompts = capturePrompts(DONE_REPLY);
    await runBranchFix(featureContext(callCtxWith()), { findings: [...FINDINGS] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You are fixing a feature branch");
    expect(prompts[0]).not.toContain("## Memory");
  });
});

describe("runBranchReview — the run's memory index (AC-9..AC-10)", () => {
  test("AC-9: the branch review prompt carries the read-only reference section", async () => {
    const fake = fakeRunMemory();
    const prompts = capturePrompts(PASS_VERDICT);
    const out = await runBranchReview(featureContext(callCtxWith(fake.memory)), {
      seed: "seed0",
      facts: REVIEW_FACTS,
    });
    expect(out.ran).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(buildMemoryReferenceSection(INDEX_LINE));
    expect(fake.reads()).toBe(1);
  });

  test("AC-10: a call context without a run memory reviews without ## Memory", async () => {
    const prompts = capturePrompts(PASS_VERDICT);
    const out = await runBranchReview(featureContext(callCtxWith()), { seed: "seed0", facts: REVIEW_FACTS });
    expect(out.ran).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You are reviewing a whole feature branch");
    expect(prompts[0]).not.toContain("## Memory");
  });
});
