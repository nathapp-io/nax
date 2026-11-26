import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import type { AdviceDecision, AdviceResult, QuestionDraft } from "@/advisor";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { _chainAdviseDeps, chainRoutingContext, withChainRulings } from "@/bot/chain-advise";
import { chainRulingKey, parseChainRuling, renderChainRuling } from "@/bot/chain-rulings";
import { type PrThread, withNaxBotMarker } from "@/forge";

const PRD = ".nax/features/alpha/prd.json";
const SPEC = ".nax/features/alpha/spec.md";

type Finding = Extract<AgreedItem, { kind: "finding" }>;

function finding(key: string): Finding {
  return {
    kind: "finding",
    key,
    issue: `issue ${key}`,
    severity: "important",
    trigger: "normal",
    lineage: { generation: 2, parents: ["p-1"], pushSha: "abcdef1" },
  };
}

function threadFor(author: string, key: string): PrThread {
  return {
    id: `t-${key}`,
    replyTo: `r-${key}`,
    resolved: false,
    outdated: false,
    comments: [{ id: `c-${key}`, kind: "thread", author, body: withNaxBotMarker("body", key), createdAt: "" }],
  };
}

function routed(keys: readonly string[] = ["f-1"], opts: { botFixChain?: boolean; threads?: boolean } = {}): BotFixEnv {
  const base = makeBotFixEnv(keys.map(finding));
  const config = makeNaxConfig({ advisor: { enabled: true, callers: { botFixChain: opts.botFixChain ?? true } } });
  return {
    ...base,
    config,
    threads: opts.threads === false ? [] : keys.map((k) => threadFor(base.user.login, k)),
    checkout: { ...base.checkout, changedFiles: [PRD, SPEC] },
  };
}

type Action = AdviceDecision["action"];

function decision(action: Action, extra: Partial<AdviceDecision> = {}): AdviceResult {
  return {
    decision: {
      id: "D-1",
      questionId: "Q-1",
      kind: "bot-fix-chain",
      chosenOptionId: "o",
      action,
      rationale: "not sure",
      confidence: "high",
      reversible: true,
      needsHumanConfirm: false,
      decidedAt: "",
      model: "m",
      memoryMode: "stateless",
      auditRef: "",
      ...extra,
    },
  };
}

const FIX = decision({ type: "fix", instruction: "restore the guard" });
const WAIVE = decision({ type: "waive", reason: "base behaviour" });

const DRAFT: QuestionDraft = { kind: "bot-fix-chain", feature: "alpha", summary: "s", evidence: [], options: [] };

const original = { ..._chainAdviseDeps };
const advise = mock(async (_d: QuestionDraft, _o?: { findingSeverity?: string }): Promise<AdviceResult> => FIX);
const createAdvisor = mock((_a: unknown) => ({ advise }));
const reply = mock(async (..._a: unknown[]) => ({ id: "1" }));
const resolve = mock(async (..._a: unknown[]) => {});
const warn = mock((..._a: unknown[]) => {});

beforeEach(() => {
  for (const m of [advise, createAdvisor, reply, resolve, warn]) m.mockClear();
  advise.mockImplementation(async () => FIX);
  reply.mockImplementation(async () => ({ id: "1" }));
  resolve.mockImplementation(async () => {});
  Object.assign(_chainAdviseDeps, {
    createAdvisor,
    buildChainQuestion: async () => DRAFT,
    readFindingDispositions: async () => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }),
    replyToThread: reply,
    resolveThread: resolve,
    getLogger: () => ({ warn }),
  });
});

afterEach(() => {
  Object.assign(_chainAdviseDeps, original);
});

const postedBody = (): string => String(reply.mock.calls[0]?.[2]);
const keysOf = (env: BotFixEnv): string[] => env.review.agreed.map((i) => i.key);

describe("withChainRulings gating", () => {
  test("AC-1 returns the same env when botFixChain is false", async () => {
    const env = routed(["f-1"], { botFixChain: false });
    expect(await withChainRulings(env)).toBe(env);
  });

  test("AC-2 returns the same env with no chain finding", async () => {
    const env = routed([]);
    expect(await withChainRulings(env)).toBe(env);
    expect(createAdvisor).not.toHaveBeenCalled();
  });
});

describe("withChainRulings advisor call", () => {
  test("AC-3 creates the advisor with the routing's context", async () => {
    const env = routed();
    await withChainRulings(env);
    const ctx = chainRoutingContext(env);
    expect(createAdvisor.mock.calls[0]?.[0]).toMatchObject({
      callCtx: env.ctx.callCtx,
      repoRoot: env.repoRoot,
      workdir: env.checkout.worktree,
      outputDir: env.ctx.callCtx.runtime.outputDir,
      runId: env.ctx.callCtx.runtime.runId,
      feature: ctx?.feature,
      specPath: ctx?.specPath,
    });
  });

  test("AC-4 advises with the built draft and the finding severity", async () => {
    await withChainRulings(routed());
    expect(advise.mock.calls[0]?.[0]).toBe(DRAFT);
    expect(advise.mock.calls[0]?.[1]).toEqual({ findingSeverity: "important" });
  });

  test("AC-5 advises while the session scope is running", async () => {
    let running = false;
    let during: boolean | undefined;
    advise.mockImplementation(async () => {
      during = running;
      return FIX;
    });
    const env = routed();
    const sessionScope = async <T>(run: () => Promise<T>): Promise<T> => {
      running = true;
      try {
        return await run();
      } finally {
        running = false;
      }
    };
    await withChainRulings({ ...env, ctx: { ...env.ctx, sessionScope } });
    expect(during).toBe(true);
  });

  test("AC-23 does not advise a finding with no own thread", async () => {
    await withChainRulings(routed(["f-1"], { threads: false }));
    expect(advise).not.toHaveBeenCalled();
  });
});

describe("withChainRulings fix outcome", () => {
  test("AC-6 keeps agreed unchanged", async () => {
    const env = routed();
    expect((await withChainRulings(env)).review.agreed).toEqual(env.review.agreed);
  });

  test("AC-7 records the fix ruling", async () => {
    const out = await withChainRulings(routed());
    expect(out.chainRulings).toEqual([{ key: "f-1", outcome: "fix", text: "restore the guard" }]);
  });

  test("AC-8 replies on the own thread with the marked ruling", async () => {
    const env = routed();
    await withChainRulings(env);
    const expected = withNaxBotMarker(
      renderChainRuling({ key: "f-1", outcome: "fix", text: "restore the guard" }),
      chainRulingKey("f-1"),
    );
    expect(reply.mock.calls[0]?.[1]).toBe(env.threads[0]);
    expect(postedBody()).toBe(expected);
  });

  test("AC-9 does not resolve the thread", async () => {
    await withChainRulings(routed());
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("withChainRulings waive and hold outcomes", () => {
  test("AC-10 removes a waived item", async () => {
    advise.mockImplementation(async () => WAIVE);
    expect(keysOf(await withChainRulings(routed()))).not.toContain("f-1");
  });

  test("AC-11 posts a parseable waived ruling", async () => {
    advise.mockImplementation(async () => WAIVE);
    await withChainRulings(routed());
    expect(parseChainRuling(postedBody())).toEqual({ outcome: "waived", text: "base behaviour" });
  });

  test("AC-12 resolves the thread after a waive", async () => {
    advise.mockImplementation(async () => WAIVE);
    const env = routed();
    await withChainRulings(env);
    expect(resolve.mock.calls[0]?.[1]).toBe(env.threads[0]);
  });

  test("AC-13 posts a held ruling for a hold", async () => {
    advise.mockImplementation(async () => decision({ type: "hold", reason: "needs a product call" }));
    await withChainRulings(routed());
    expect(parseChainRuling(postedBody())).toEqual({ outcome: "held", text: "needs a product call" });
  });

  test("AC-14 removes a held item", async () => {
    advise.mockImplementation(async () => decision({ type: "hold", reason: "needs a product call" }));
    expect(keysOf(await withChainRulings(routed()))).not.toContain("f-1");
  });

  test("AC-15 holds a confirm-needing waive with the proposal", async () => {
    advise.mockImplementation(async () => decision({ type: "waive", reason: "r" }, { needsHumanConfirm: true }));
    await withChainRulings(routed());
    expect(parseChainRuling(postedBody())).toEqual({
      outcome: "held",
      text: "not sure",
      proposed: { outcome: "waived", text: "r" },
    });
  });

  test("AC-16 holds a confirm-needing fix with the proposal", async () => {
    advise.mockImplementation(async () => decision({ type: "fix", instruction: "i" }, { needsHumanConfirm: true }));
    await withChainRulings(routed());
    expect(parseChainRuling(postedBody())).toEqual({
      outcome: "held",
      text: "not sure",
      proposed: { outcome: "fix", text: "i" },
    });
  });
});

describe("withChainRulings failures", () => {
  test("AC-17 leaves agreed unchanged on a null decision", async () => {
    advise.mockImplementation(async () => ({ decision: null, fallbackReason: "no-output" }));
    const env = routed();
    expect((await withChainRulings(env)).review.agreed).toEqual(env.review.agreed);
  });

  test("AC-18 posts nothing on a null decision", async () => {
    advise.mockImplementation(async () => ({ decision: null, fallbackReason: "no-output" }));
    await withChainRulings(routed());
    expect(reply).not.toHaveBeenCalled();
  });

  test("AC-19 posts nothing for an unsupported action", async () => {
    advise.mockImplementation(async () => decision({ type: "defer", reason: "later" }));
    await withChainRulings(routed());
    expect(reply).not.toHaveBeenCalled();
  });

  test("AC-20 continues after a rejected advise", async () => {
    advise.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    advise.mockImplementationOnce(async () => WAIVE);
    const out = await withChainRulings(routed(["f-1", "f-2"]));
    expect(keysOf(out)).toEqual(["f-1"]);
  });

  test("AC-21 leaves agreed unchanged when the reply rejects", async () => {
    advise.mockImplementation(async () => WAIVE);
    reply.mockImplementation(async () => {
      throw new Error("post failed");
    });
    const env = routed();
    const out = await withChainRulings(env);
    expect(out.review.agreed).toEqual(env.review.agreed);
    expect(out.chainRulings ?? []).toEqual([]);
  });

  test("AC-22 keeps the waive when resolve rejects", async () => {
    advise.mockImplementation(async () => WAIVE);
    resolve.mockImplementation(async () => {
      throw new Error("resolve failed");
    });
    const out = await withChainRulings(routed());
    expect(out.chainRulings).toEqual([{ key: "f-1", outcome: "waived", text: "base behaviour" }]);
  });

  test("AC-24 does not resolve the thread when posting fails", async () => {
    advise.mockImplementation(async () => WAIVE);
    reply.mockImplementation(async () => {
      throw new Error("post failed");
    });
    await withChainRulings(routed());
    expect(resolve).not.toHaveBeenCalled();
  });
});
