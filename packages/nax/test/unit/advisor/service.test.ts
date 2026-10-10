import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdviceDecision, AdvisorCallContext, QuestionDraft } from "@/advisor";
import { _advisorServiceDeps, buildMenu, createAdvisor, readDecisions } from "@/advisor";
import { ADVISOR_DEFAULTS } from "@/config";
import type { AdviseOpOutput } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const original = { ..._advisorServiceDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, original);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

let seq = 0;
function stubDeps(reply: AdviseOpOutput | (() => Promise<AdviseOpOutput>)): { inputs: unknown[] } {
  const inputs: unknown[] = [];
  _advisorServiceDeps.callOp = (async (_ctx: unknown, _op: unknown, input: unknown) => {
    inputs.push(input);
    return typeof reply === "function" ? reply() : reply;
  }) as typeof _advisorServiceDeps.callOp;
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "sha1", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  _advisorServiceDeps.now = () => "2026-10-10T00:00:00.000Z";
  _advisorServiceDeps.newId = () => `Q-${++seq}`;
  _advisorServiceDeps.costTotal = () => 0;
  return { inputs };
}

function actx(
  dir: string,
  over: Partial<AdvisorCallContext> = {},
  memory: "stateless" | "warm" = "stateless",
): AdvisorCallContext {
  const config = makeNaxConfig({ advisor: { ...ADVISOR_DEFAULTS, enabled: true, memory } });
  const callCtx = makeMockCallContext({ config });
  runtimes.push(callCtx.runtime);
  return {
    callCtx,
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    runId: `run-${++seq}`,
    specPath: "spec.md",
    workdir: dir,
    ...over,
  };
}

const judgment: QuestionDraft = {
  kind: "finish-judgment",
  feature: "feat",
  summary: "Transport widened",
  evidence: [],
  options: buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }), // A fix, B waive, C hold
};

const reply = (optionId: string, extra: Record<string, unknown> = {}): AdviseOpOutput => ({
  ok: true,
  reply: { optionId, rationale: "because", confidence: "high", reversible: true, needsHumanConfirm: false, ...extra },
});

describe("advisor service", () => {
  test("happy path: a decision lands in the ledger and its audit file", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("A", { instruction: "fix it" }));
      const out = await createAdvisor(actx(dir)).advise(judgment);
      expect(out.decision?.id).toBe("D-1");
      expect(out.decision?.action).toEqual({ type: "fix", instruction: "fix it" });
      expect(await readDecisions(dir, "feat")).toHaveLength(1);
      const audit = JSON.parse(await Bun.file(join(dir, "out", "advisor-audit", "feat", "D-1.json")).text());
      expect(audit.result.decision.id).toBe("D-1");
      expect(out.decision?.auditRef).toBe(join("advisor-audit", "feat", "D-1.json"));
    });
  });

  test("an invalid reply falls back: no ledger line, audit records the reason", async () => {
    await withTempDir(async (dir) => {
      stubDeps({ ok: false, error: "optionId Z is not on the menu", preview: "…" });
      const out = await createAdvisor(actx(dir)).advise(judgment);
      expect(out).toEqual({ decision: null, fallbackReason: "optionId Z is not on the menu" });
      expect(await readDecisions(dir, "feat")).toEqual([]);
      const files = await Array.fromAsync(
        new Bun.Glob("*.json").scan({ cwd: join(dir, "out", "advisor-audit", "feat") }),
      );
      expect(files).toHaveLength(1);
    });
  });

  test("a dispatch error falls back with a dispatch: reason", async () => {
    await withTempDir(async (dir) => {
      stubDeps(async () => {
        throw new Error("boom");
      });
      const out = await createAdvisor(actx(dir)).advise(judgment);
      expect(out.decision).toBeNull();
      expect(out.fallbackReason?.startsWith("dispatch:")).toBe(true);
    });
  });

  test("hold is force-flagged and sends one heads-up naming the decision", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("C", { reason: "needs product call" }));
      const sent: string[] = [];
      const out = await createAdvisor(
        actx(dir, {
          headsUp: async (t) => {
            sent.push(t);
            return { sent: true };
          },
        }),
      ).advise(judgment);
      expect(out.decision?.needsHumanConfirm).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("D-1");
    });
  });

  test("a flagged decision with no channel is recorded as not sent", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("C", { reason: "x" }));
      await createAdvisor(actx(dir)).advise(judgment);
      const audit = JSON.parse(await Bun.file(join(dir, "out", "advisor-audit", "feat", "D-1.json")).text());
      expect(audit.headsUp).toEqual({ sent: false, reason: "no-channel" });
    });
  });

  test("story decisions without a channel are queued for the stage", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("C", { reason: "x" }));
      const queued: [string, string][] = [];
      await createAdvisor(actx(dir, { queueHeadsUp: (s, t) => queued.push([s, t]) })).advise({
        ...judgment,
        storyId: "US-2",
      });
      expect(queued.map((q) => q[0])).toEqual(["US-2"]);
    });
  });

  test("an unflagged decision sends nothing", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("A", { instruction: "x" }));
      let calls = 0;
      await createAdvisor(
        actx(dir, {
          headsUp: async () => {
            calls++;
            return { sent: true };
          },
        }),
      ).advise(judgment);
      expect(calls).toBe(0);
    });
  });

  test("recordReuse copies an earlier decision without a model call", async () => {
    await withTempDir(async (dir) => {
      const { inputs } = stubDeps(reply("B", { reason: "spec allows it" }));
      const advisor = createAdvisor(actx(dir));
      const first = (await advisor.advise({ ...judgment, dedupeKey: "k" })).decision as AdviceDecision;
      const reused = await advisor.recordReuse({ ...judgment, dedupeKey: "k" }, first);
      expect(inputs).toHaveLength(1);
      expect(reused?.reusedFrom).toBe("D-1");
      expect(reused?.id).toBe("D-2");
      expect(reused?.action).toEqual(first.action);
    });
  });
});
