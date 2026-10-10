import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdviceAction, AdviceDecision, AdviceResult, Advisor, AdvisorCallContext, QuestionDraft } from "@/advisor";
import { ADVISOR_DEFAULTS } from "@/config";
import { _giveUpAdviceDeps, buildGiveUpHook } from "@/execution/story-orchestrator/give-up-advice";
import type { Finding, FixStrategy, GiveUpInput } from "@/findings";
import type { NaxRuntime } from "@/runtime";

type HookArgs = Parameters<typeof buildGiveUpHook>[0];

function mustHook(h: ReturnType<typeof buildGiveUpHook>): NonNullable<ReturnType<typeof buildGiveUpHook>> {
  if (!h) throw new Error("expected a give-up hook");
  return h;
}

function callHook(args: HookArgs, inp: GiveUpInput<Finding>) {
  return mustHook(buildGiveUpHook(args))(inp);
}

const original = { ..._giveUpAdviceDeps };
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_giveUpAdviceDeps, original);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

const finding: Finding = {
  source: "semantic-review",
  category: "ac",
  severity: "error",
  message: "AC-3 says X",
  file: "src/a.ts",
  line: 3,
  fixTarget: "source",
};

function strat(
  name: string,
  claims: (f: Finding) => boolean = () => true,
): FixStrategy<Finding, unknown, unknown, unknown> {
  return {
    name,
    appliesTo: claims,
    fixOp: {} as FixStrategy<Finding, unknown, unknown, unknown>["fixOp"],
    buildInput: () => ({}),
    maxAttempts: 3,
    coRun: "exclusive",
  };
}

const implementer = strat("autofix-implementer", (f) => f.fixTarget !== "test");
const testWriter = strat("autofix-test-writer", (f) => f.fixTarget === "test");

function input(over: Partial<GiveUpInput<Finding>> = {}): GiveUpInput<Finding> {
  return {
    findings: [finding],
    gaveUp: [{ strategyName: "autofix-implementer", unresolvedDetail: "finding contradicts AC-3's test" }],
    attemptsLeft: { "autofix-implementer": 2, "autofix-test-writer": 3 },
    totalAttemptsLeft: 5,
    ...over,
  };
}

function setup(
  dir: string,
  reply: (q: QuestionDraft) => AdviceResult,
  opts: { enabled?: boolean; maxRulings?: number } = {},
) {
  const asked: QuestionDraft[] = [];
  const actxs: AdvisorCallContext[] = [];
  _giveUpAdviceDeps.createAdvisor = (actx) => {
    actxs.push(actx);
    const advisor: Advisor = {
      advise: async (q) => {
        asked.push(q);
        return reply(q);
      },
      recordReuse: async () => null,
    };
    return advisor;
  };
  _giveUpAdviceDeps.readDecisions = async () => [];
  const config = makeNaxConfig({
    advisor: {
      ...ADVISOR_DEFAULTS,
      enabled: opts.enabled ?? true,
      maxRulingsPerStory: opts.maxRulings ?? 2,
      callers: { ...ADVISOR_DEFAULTS.callers, fixCycleGiveUp: true },
    },
  });
  const ctx = makeMockCallContext({ config, storyId: "US-1", featureName: "feat", packageDir: dir });
  runtimes.push(ctx.runtime);
  return { ctx, asked, actxs };
}

const decided = (action: AdviceAction, extra: Partial<AdviceDecision> = {}): AdviceResult => ({
  decision: {
    id: "D-7",
    questionId: "Q",
    kind: "fix-cycle-give-up",
    chosenOptionId: "A",
    action,
    rationale: "the AC wins",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "m",
    memoryMode: "stateless",
    auditRef: "a",
    ...extra,
  },
});

describe("buildGiveUpHook", () => {
  test("disabled config or an NBF pass → no hook", async () => {
    await withTempDir(async (dir) => {
      const off = setup(dir, () => ({ decision: null }), { enabled: false });
      expect(
        buildGiveUpHook({ ctx: off.ctx, strategies: [implementer], isThreeSession: true, nbfPath: false }),
      ).toBeUndefined();
      const on = setup(dir, () => ({ decision: null }));
      expect(
        buildGiveUpHook({ ctx: on.ctx, strategies: [implementer], isThreeSession: true, nbfPath: true }),
      ).toBeUndefined();
    });
  });

  test("retry reinstates the strategy that gave up", async () => {
    await withTempDir(async (dir) => {
      const { ctx } = setup(dir, () => decided({ type: "retry", instruction: "follow AC-3" }));
      const hook = mustHook(
        buildGiveUpHook({
          ctx,
          strategies: [implementer, testWriter],
          isThreeSession: true,
          nbfPath: false,
        }),
      );
      expect(await hook(input())).toEqual({ findings: [finding], reinstate: ["autofix-implementer"] });
    });
  });

  test("retarget flips fixTarget and reinstates the claimant across the TDD boundary", async () => {
    await withTempDir(async (dir) => {
      const { ctx, asked } = setup(dir, () =>
        decided({ type: "retarget", to: "test", instruction: "the test is wrong" }),
      );
      const hook = mustHook(
        buildGiveUpHook({
          ctx,
          strategies: [implementer, testWriter],
          isThreeSession: true,
          nbfPath: false,
        }),
      );
      const r = await hook(input());
      expect(r?.findings[0]?.fixTarget).toBe("test");
      expect(r?.reinstate).toEqual(["autofix-test-writer"]);
      expect(asked[0]?.options.map((o) => o.type)).toContain("retarget");
      expect(asked[0]?.kind).toBe("fix-cycle-give-up");
      expect(asked[0]?.storyId).toBe("US-1");
    });
  });

  test("single-session: retarget is not offered", async () => {
    await withTempDir(async (dir) => {
      const { ctx, asked } = setup(dir, () => ({ decision: null }));
      await callHook({ ctx, strategies: [implementer], isThreeSession: false, nbfPath: false }, input());
      expect(asked[0]?.options.map((o) => o.type)).not.toContain("retarget");
    });
  });

  test("waive drops the findings; escalate-tier and defer keep the exit with the ruling", async () => {
    await withTempDir(async (dir) => {
      const w = setup(dir, () => decided({ type: "waive", reason: "US-5 owns it" }));
      expect(
        await callHook({ ctx: w.ctx, strategies: [implementer], isThreeSession: true, nbfPath: false }, input()),
      ).toEqual({
        findings: [],
        reinstate: [],
      });
      for (const type of ["escalate-tier", "defer"] as const) {
        const e = setup(dir, () => decided({ type, reason: "r" }));
        const r = await callHook(
          { ctx: e.ctx, strategies: [implementer], isThreeSession: true, nbfPath: false },
          input(),
        );
        expect(r?.exit).toEqual({ detailSuffix: "[advisor D-7: the AC wins]" });
      }
    });
  });

  test("no decision → null (today's exit)", async () => {
    await withTempDir(async (dir) => {
      const { ctx } = setup(dir, () => ({ decision: null, fallbackReason: "no-json" }));
      expect(
        await callHook({ ctx, strategies: [implementer], isThreeSession: true, nbfPath: false }, input()),
      ).toBeNull();
    });
  });

  test("an exhausted ruling budget offers only escalate-tier and defer", async () => {
    await withTempDir(async (dir) => {
      const { ctx, asked } = setup(dir, () => ({ decision: null }), { maxRulings: 0 });
      await callHook({ ctx, strategies: [implementer, testWriter], isThreeSession: true, nbfPath: false }, input());
      expect(asked[0]?.options.map((o) => o.type)).toEqual(["escalate-tier", "defer"]);
    });
  });

  test("mechanical-only findings are never sent to the advisor", async () => {
    await withTempDir(async (dir) => {
      const { ctx, asked } = setup(dir, () => ({ decision: null }));
      const lint: Finding = { source: "lint", category: "lint", severity: "error", message: "unused" };
      expect(
        await callHook(
          { ctx, strategies: [implementer], isThreeSession: true, nbfPath: false },
          input({ findings: [lint] }),
        ),
      ).toBeNull();
      expect(asked).toHaveLength(0);
    });
  });

  test("flagged decisions are queued on the runtime for the stage to send", async () => {
    await withTempDir(async (dir) => {
      const { ctx, actxs } = setup(dir, () => ({ decision: null }));
      await callHook({ ctx, strategies: [implementer], isThreeSession: true, nbfPath: false }, input());
      actxs[0]?.queueHeadsUp?.("US-1", "hello");
      expect(ctx.runtime.advisorHeadsUps.drain("US-1")).toEqual(["hello"]);
    });
  });
});
