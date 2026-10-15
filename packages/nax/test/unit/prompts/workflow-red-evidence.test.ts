/**
 * US-009 (nax#2540, nax#2530): the workflow implementer and story review prompts carry the
 * failing-run rule and the e2e-awareness lines, and the two workflow callers pass `e2eGate`
 * from the resolved config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeScriptedCallOp, makeStepContext, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { workflowImplementOp, workflowStoryReviewOp } from "@/operations";
import { buildWorkflowImplementPrompt, buildWorkflowStoryReviewPrompt } from "@/prompts";
import { runImplementerTurn } from "@/workflow/implement";
import type { StepContext } from "@/workflow/step-context";
import { _workflowDeps } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";
import type { ImplementerReply, StoryReviewVerdict } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const implementPaths = { storyId: "US-001", briefPath: "/b/brief.md", reportPath: "/r/report.md" };
const reviewPaths = { briefPath: "/b/brief.md", reportPath: "/r/report.md", packagePath: "/p.diff", concerns: [] };

describe("buildWorkflowImplementPrompt — RED evidence (US-009, nax#2540)", () => {
  test.each([
    ["AC-1", "capture the failing run before you write the implementation for that criterion"],
    ["AC-2", "Never stash, revert, move or copy aside implementation files to produce a failing run afterwards"],
    ["AC-3", "If you did not capture the failing run, say so under **Decisions & assumptions**"],
    ["AC-4", "evidence that the test exercises the new code path is acceptable"],
  ])("%s: the implement prompt carries the failing-run rule", (_ac, needle) => {
    expect(buildWorkflowImplementPrompt(implementPaths)).toContain(needle);
  });
});

describe("buildWorkflowStoryReviewPrompt — RED evidence verdict (US-009, nax#2540)", () => {
  test.each([
    [
      "AC-5",
      "A report that says the failing run was not captured is not a spec failure when the test exercises the new code path",
    ],
    ["AC-6", "A failing run produced by reverting or stashing the implementation is a finding"],
  ])("%s: the review prompt carries the not-captured rule", (_ac, needle) => {
    expect(buildWorkflowStoryReviewPrompt(reviewPaths)).toContain(needle);
  });

  test("the spec-failure sentence excepts an honest not-captured note", () => {
    expect(buildWorkflowStoryReviewPrompt(reviewPaths)).toContain(
      "missing evidence for an AC (other than an honest not-captured note), or a test that asserts nothing, is a spec failure",
    );
  });
});

describe("workflow prompts — e2e awareness (US-009, nax#2530)", () => {
  test("AC-7 + AC-8: with e2eGate the implement prompt names the RunCommand and the Bash sandbox", () => {
    const text = buildWorkflowImplementPrompt({ ...implementPaths, e2eGate: true });
    expect(text).toContain('RunCommand {"command":"e2e"}');
    expect(text).toContain("Browser e2e tests cannot launch inside the Bash sandbox");
  });

  test("AC-9: without e2eGate the implement prompt never mentions that RunCommand", () => {
    expect(buildWorkflowImplementPrompt(implementPaths)).not.toContain('RunCommand {"command":"e2e"}');
  });

  test("AC-10: with e2eGate the story review forbids listing e2e journeys in cannotVerify", () => {
    expect(buildWorkflowStoryReviewPrompt({ ...reviewPaths, e2eGate: true })).toContain(
      "do not list e2e journeys in cannotVerify",
    );
  });

  test("AC-11: without e2eGate the story review never mentions e2e journeys", () => {
    expect(buildWorkflowStoryReviewPrompt(reviewPaths)).not.toContain("e2e journeys");
  });
});

const e2eConfig = makeNaxConfig({ quality: { commands: { e2e: "bunx playwright test" } } });
const doneReply: ImplementerReply = { status: "DONE", commits: [], testSummary: "ok", interrupted: false };

/** Captures the `prompt` of every op dispatch; the op name is asserted so a stray call fails loudly. */
function capturePrompts(opName: string, reply: unknown): string[] {
  const prompts: string[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
    expect(op.name).toBe(opName);
    prompts.push((input as { prompt: string }).prompt);
    return reply;
  });
  return prompts;
}

describe("runImplementerTurn passes e2eGate (US-009)", () => {
  test("AC-12: an implement turn with an e2e command sends the e2e RunCommand line", async () => {
    const prompts = capturePrompts(workflowImplementOp.name, doneReply);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ config: e2eConfig }), { kind: "implement" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('RunCommand {"command":"e2e"}');
  });

  test("AC-13: a fresh restart turn with an e2e command sends the e2e RunCommand line", async () => {
    const prompts = capturePrompts(workflowImplementOp.name, doneReply);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ config: e2eConfig }), { kind: "restart", fresh: true, stepUps: 0 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('RunCommand {"command":"e2e"}');
  });

  test("AC-14: an implement turn with no e2e command sends no e2e RunCommand line", async () => {
    const prompts = capturePrompts(workflowImplementOp.name, doneReply);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ config: makeNaxConfig() }), { kind: "implement" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('RunCommand {"command":"e2e"}');
  });

  test("a warm restart keeps the short prompt and never gains the e2e line", async () => {
    const prompts = capturePrompts(workflowImplementOp.name, doneReply);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ config: e2eConfig }), { kind: "restart", fresh: false, stepUps: 0 });
    expect(prompts[0]).toStartWith("You have not started story US-001");
    expect(prompts[0]).not.toContain('RunCommand {"command":"e2e"}');
  });
});

describe("runStoryReview passes e2eGate (US-009)", () => {
  const PASS: StoryReviewVerdict = {
    spec: "pass",
    quality: "approved",
    findings: [],
    cannotVerify: [],
    inspectedFiles: [],
  };

  /** A fresh story dir and a clean git stub: the review writes `package-0.diff` and `review.json`. */
  function makeReviewSc(config: NaxConfig): { sc: StepContext; prompts: string[] } {
    const storyDir = makeTempDir("wf-red-evidence-");
    dirs.push(storyDir);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    return {
      sc: makeStepContext({ config, storyDir, base: "base0" }),
      prompts: capturePrompts(workflowStoryReviewOp.name, PASS),
    };
  }

  test("AC-15: an e2e command reaches the review prompt", async () => {
    const { sc, prompts } = makeReviewSc(e2eConfig);
    expect((await runStoryReview(sc, [])).ran).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("do not list e2e journeys in cannotVerify");
  });

  test("no e2e command leaves the review prompt without e2e journeys", async () => {
    const { sc, prompts } = makeReviewSc(makeNaxConfig());
    expect((await runStoryReview(sc, [])).ran).toBe(true);
    expect(prompts[0]).not.toContain("e2e journeys");
  });
});
