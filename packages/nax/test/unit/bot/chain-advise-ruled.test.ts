import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import type { AdviceDecision, AdviceResult, QuestionDraft } from "@/advisor";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { _chainAdviseDeps, withChainRulings } from "@/bot/chain-advise";
import { chainRulingKey, parseChainRuling, renderChainRuling } from "@/bot/chain-rulings";
import { type PrComment, type PrThread, withNaxBotMarker } from "@/forge";

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

function own(id: string, key: string, body: string): PrComment {
  return { id, kind: "thread", author: "bot", body: withNaxBotMarker(body, key), createdAt: "" };
}
const ruling = (key: string, outcome: "fix" | "waived" | "held", text: string): PrComment =>
  own(`r-${outcome}-${text}`, chainRulingKey(key), renderChainRuling({ key, outcome, text }));

function withReplies(env: BotFixEnv, key: string, replies: readonly PrComment[]): BotFixEnv {
  const threads = env.threads.map((t) => (t.id === `t-${key}` ? { ...t, comments: [...t.comments, ...replies] } : t));
  return { ...env, threads };
}
function withParentRuling(env: BotFixEnv, parent: string, body?: string): BotFixEnv {
  const comment = own(
    "p",
    chainRulingKey(parent),
    body ?? renderChainRuling({ key: parent, outcome: "held", text: "x" }),
  );
  return { ...env, threads: [...env.threads, { ...threadFor("bot", "f-other"), comments: [comment] }] };
}
function parented(keys: string[], parents: Record<string, string[]>): BotFixEnv {
  const env = routed(keys);
  const agreed = env.review.agreed.map((i) =>
    i.kind === "finding" && parents[i.key] && i.lineage
      ? { ...i, lineage: { ...i.lineage, parents: parents[i.key] ?? [] } }
      : i,
  );
  return { ...env, review: { ...env.review, agreed } };
}
const keysOf = (env: BotFixEnv): string[] => env.review.agreed.map((i) => i.key);
const confirmedWith = (...keys: string[]) => {
  _chainAdviseDeps.readFindingDispositions = mock(async () => ({
    confirmed: new Set(keys),
    writerSettled: new Set<string>(),
  }));
};

describe("confirmed keys", () => {
  test("AC-1 reads confirmed keys once with threads and login", async () => {
    const read = mock(async (_i: unknown) => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }));
    _chainAdviseDeps.readFindingDispositions = read;
    const env = routed();
    await withChainRulings(env);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toMatchObject({ threads: env.threads, login: env.user.login });
  });

  test("AC-2 rejects with the read error", async () => {
    const err = new Error("unreadable");
    _chainAdviseDeps.readFindingDispositions = async () => {
      throw err;
    };
    await expect(withChainRulings(routed())).rejects.toBe(err);
  });

  test("AC-3 does not read with no chain finding", async () => {
    const read = mock(async (_i: unknown) => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }));
    _chainAdviseDeps.readFindingDispositions = read;
    await withChainRulings(routed([]));
    expect(read).not.toHaveBeenCalled();
  });

  test("AC-4 AC-5 a confirmed key leaves agreed unchanged and is not advised", async () => {
    confirmedWith("f-1");
    const env = routed();
    expect((await withChainRulings(env)).review.agreed).toEqual(env.review.agreed);
    expect(advise).not.toHaveBeenCalled();
  });

  test("AC-13 a confirmed key releases a held thread", async () => {
    confirmedWith("f-1");
    const env = withReplies(routed(), "f-1", [ruling("f-1", "held", "needs a product call")]);
    expect((await withChainRulings(env)).review.agreed).toEqual(env.review.agreed);
  });
});

describe("existing chain ruling replay", () => {
  test("AC-6 AC-7 AC-8 replays a fix without asking or posting", async () => {
    const env = withReplies(routed(), "f-1", [ruling("f-1", "fix", "restore the guard")]);
    const out = await withChainRulings(env);
    expect(out.chainRulings).toEqual([{ key: "f-1", outcome: "fix", text: "restore the guard" }]);
    expect(advise).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  test("AC-9 AC-10 AC-11 replays a hold", async () => {
    const env = withReplies(routed(), "f-1", [ruling("f-1", "held", "needs a product call")]);
    const out = await withChainRulings(env);
    expect(keysOf(out)).not.toContain("f-1");
    expect(out.chainRulings).toEqual([{ key: "f-1", outcome: "held", text: "needs a product call" }]);
    expect(advise).not.toHaveBeenCalled();
  });

  test("AC-12 replays a waive by removing the item", async () => {
    const env = withReplies(routed(), "f-1", [ruling("f-1", "waived", "base")]);
    const out = await withChainRulings(env);
    expect(keysOf(out)).not.toContain("f-1");
    expect(out.chainRulings ?? []).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
  });

  test("AC-14 the newest ruling decides", async () => {
    const env = withReplies(routed(), "f-1", [ruling("f-1", "held", "old"), ruling("f-1", "fix", "restore the guard")]);
    expect((await withChainRulings(env)).chainRulings).toEqual([
      { key: "f-1", outcome: "fix", text: "restore the guard" },
    ]);
  });

  test("AC-15 AC-16 a fix comment after the fix ruling holds again", async () => {
    const env = withReplies(routed(), "f-1", [
      ruling("f-1", "fix", "restore the guard"),
      own("fx", "fix-f-1", "fixed"),
    ]);
    const out = await withChainRulings(env);
    expect(parseChainRuling(String(reply.mock.calls[0]?.[2]))).toEqual({
      outcome: "held",
      text: "raised again after an advisor-ruled fix",
    });
    expect(out.chainRulings).toEqual([
      { key: "f-1", outcome: "held", text: "raised again after an advisor-ruled fix" },
    ]);
  });

  test("AC-17 a fix comment before the fix ruling still replays the fix", async () => {
    const env = withReplies(routed(), "f-1", [
      own("fx", "fix-f-1", "fixed"),
      ruling("f-1", "fix", "restore the guard"),
    ]);
    expect((await withChainRulings(env)).chainRulings).toEqual([
      { key: "f-1", outcome: "fix", text: "restore the guard" },
    ]);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("lineage parent holds", () => {
  test("AC-18 AC-19 holds a finding whose parent has a chain ruling", async () => {
    const env = withParentRuling(parented(["f-1"], { "f-1": ["f-p1"] }), "f-p1");
    await withChainRulings(env);
    expect(parseChainRuling(postedBody())).toEqual({ outcome: "held", text: "a second finding on this chain" });
    expect(advise).not.toHaveBeenCalled();
  });

  test("AC-20 a sibling naming the first as parent is held after a waive", async () => {
    advise.mockImplementation(async () => WAIVE);
    await withChainRulings(parented(["f-1", "f-2"], { "f-2": ["f-1"] }));
    expect(advise).toHaveBeenCalledTimes(1);
  });

  test("AC-21 an unparseable parent comment does not hold", async () => {
    const env = withParentRuling(parented(["f-1"], { "f-1": ["f-p1"] }), "f-p1", "not a ruling");
    await withChainRulings(env);
    expect(advise).toHaveBeenCalled();
  });

  test("AC-22 an unparseable own-thread comment is not a ruling", async () => {
    const env = withReplies(routed(), "f-1", [own("x", chainRulingKey("f-1"), "not a ruling")]);
    await withChainRulings(env);
    expect(advise).toHaveBeenCalled();
  });
});

describe("cost limit", () => {
  test("AC-23 does not advise once the limit is reached", async () => {
    const env = routed(["f-1", "f-2"]);
    await withChainRulings({ ...env, cost: { limitUsd: 5, spentUsd: () => 5 } });
    expect(advise).not.toHaveBeenCalled();
  });

  test("AC-24 the limit is sticky", async () => {
    const env = routed(["f-1", "f-2"]);
    const spent = mock(() => (spent.mock.calls.length > 1 ? 5 : 0));
    const out = await withChainRulings({ ...env, cost: { limitUsd: 5, spentUsd: spent } });
    expect(advise).toHaveBeenCalledTimes(1);
    expect(keysOf(out)).toContain("f-2");
  });
});
