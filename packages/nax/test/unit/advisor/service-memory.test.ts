import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdvisorCallContext, QuestionDraft } from "@/advisor";
import { _advisorServiceDeps, buildMenu, createAdvisor } from "@/advisor";
import { ADVISOR_DEFAULTS } from "@/config";
import type { AdviseOpInput, AdviseOpOutput } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const original = { ..._advisorServiceDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, original);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

let seq = 0;
const ok: AdviseOpOutput = {
  ok: true,
  reply: {
    optionId: "A",
    instruction: "x",
    rationale: "r",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
  },
};
const q: QuestionDraft = {
  kind: "finish-judgment",
  feature: "feat",
  summary: "s",
  evidence: [],
  options: buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }),
};

function setup(dir: string, memory: "stateless" | "warm"): AdvisorCallContext {
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "s", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  _advisorServiceDeps.newId = () => `Q-${++seq}`;
  _advisorServiceDeps.costTotal = () => 0;
  const callCtx = makeMockCallContext({
    config: makeNaxConfig({ advisor: { ...ADVISOR_DEFAULTS, enabled: true, memory } }),
  });
  runtimes.push(callCtx.runtime);
  return {
    callCtx,
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    runId: `run-${++seq}`,
    specPath: "spec.md",
    workdir: dir,
  };
}

function record(inputs: AdviseOpInput[], impl?: (i: AdviseOpInput) => Promise<AdviseOpOutput>): void {
  _advisorServiceDeps.callOp = (async (_c: unknown, _o: unknown, input: AdviseOpInput) => {
    inputs.push(input);
    return impl ? impl(input) : ok;
  }) as typeof _advisorServiceDeps.callOp;
}

describe("advisor memory modes", () => {
  test("warm: the first question opens the session, later ones continue it", async () => {
    await withTempDir(async (dir) => {
      const inputs: AdviseOpInput[] = [];
      record(inputs);
      const advisor = createAdvisor(setup(dir, "warm"));
      await advisor.advise(q);
      await advisor.advise(q);
      expect(inputs.map((i) => [i.continuation, i.keepOpen])).toEqual([
        [false, true],
        [true, true],
      ]);
    });
  });

  test("warm: a lost session is rebuilt from the ledger and retried once", async () => {
    await withTempDir(async (dir) => {
      const inputs: AdviseOpInput[] = [];
      let n = 0;
      record(inputs, async (i) => {
        n++;
        if (n === 2 && i.continuation) throw new Error("session gone");
        return ok;
      });
      const advisor = createAdvisor(setup(dir, "warm"));
      await advisor.advise(q);
      const second = await advisor.advise(q);
      expect(second.decision?.id).toBe("D-2");
      expect(inputs.map((i) => i.continuation)).toEqual([false, true, false]);
      expect(inputs[2]?.priorDecisions.map((d) => d.id)).toEqual(["D-1"]);
    });
  });

  test("warm: concurrent questions run one after another", async () => {
    await withTempDir(async (dir) => {
      const events: string[] = [];
      record([], async (i) => {
        events.push(`start:${i.question.id}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${i.question.id}`);
        return ok;
      });
      const advisor = createAdvisor(setup(dir, "warm"));
      await Promise.all([advisor.advise(q), advisor.advise(q)]);
      expect(events[0]?.startsWith("start:")).toBe(true);
      expect(events[1]?.startsWith("end:")).toBe(true);
      expect(events[2]?.startsWith("start:")).toBe(true);
    });
  });

  test("stateless: every call is fresh and closes", async () => {
    await withTempDir(async (dir) => {
      const inputs: AdviseOpInput[] = [];
      record(inputs);
      const advisor = createAdvisor(setup(dir, "stateless"));
      await advisor.advise(q);
      await advisor.advise(q);
      expect(inputs.map((i) => [i.continuation, i.keepOpen])).toEqual([
        [false, false],
        [false, false],
      ]);
    });
  });
});

describe("advisor memory — warm session identity", () => {
  test("a different story's first question opens with full context, not as a continuation", async () => {
    await withTempDir(async (dir) => {
      const inputs: AdviseOpInput[] = [];
      record(inputs);
      const actx = setup(dir, "warm");
      const a = createAdvisor({ ...actx, callCtx: { ...actx.callCtx, storyId: "US-1" } });
      const b = createAdvisor({ ...actx, callCtx: { ...actx.callCtx, storyId: "US-2" } });
      await a.advise({ ...q, storyId: "US-1" });
      await b.advise({ ...q, storyId: "US-2" });
      await a.advise({ ...q, storyId: "US-1" });
      expect(inputs.map((i) => i.continuation)).toEqual([false, false, true]);
    });
  });

  test("when the warm retry also fails, the question gets one stateless call", async () => {
    await withTempDir(async (dir) => {
      const inputs: AdviseOpInput[] = [];
      let n = 0;
      record(inputs, async () => {
        n++;
        return n === 1 || n === 4 ? ok : { ok: false, error: "no-json", preview: "" };
      });
      const advisor = createAdvisor(setup(dir, "warm"));
      await advisor.advise(q);
      const second = await advisor.advise(q);
      expect(inputs.slice(1).map((i) => [i.continuation, i.keepOpen])).toEqual([
        [true, true],
        [false, true],
        [false, false],
      ]);
      expect(second.decision?.id).toBe("D-2");
    });
  });
});
