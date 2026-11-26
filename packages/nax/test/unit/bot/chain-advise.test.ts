import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { makeBotFixEnv } from "@test/helpers/bot-fix";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { chainRoutingContext, selectChainFindings } from "@/bot/chain-advise";
import { featureIntentPaths } from "@/bot/intent";
import { ledgerFeature } from "@/bot/ledger-carry";
import { type PrThread, withNaxBotMarker } from "@/forge";

const PRD = ".nax/features/alpha/prd.json";
const SPEC = ".nax/features/alpha/spec.md";

type Finding = Extract<AgreedItem, { kind: "finding" }>;

function finding(key: string, overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "finding",
    key,
    issue: `issue ${key}`,
    severity: "important",
    trigger: "normal",
    lineage: { generation: 2, parents: ["p-1"], pushSha: "abcdef1" },
    ...overrides,
  };
}

interface RoutedOptions {
  files?: string[];
  enabled?: boolean;
  botFixChain?: boolean;
  generation?: number;
}

function routed(agreed: readonly AgreedItem[] = [], opts: RoutedOptions = {}): BotFixEnv {
  const base = makeBotFixEnv(agreed);
  const config = makeNaxConfig({
    advisor: { enabled: opts.enabled ?? true, callers: { botFixChain: opts.botFixChain ?? true } },
    ...(opts.generation === undefined ? {} : { bot: { chainNoticeGeneration: opts.generation } }),
  });
  return { ...base, config, checkout: { ...base.checkout, changedFiles: opts.files ?? [PRD, SPEC] } };
}

function threadBy(author: string, key: string): PrThread {
  return {
    id: "t1",
    replyTo: "1",
    resolved: false,
    outdated: false,
    comments: [{ id: "c1", kind: "thread", author, body: withNaxBotMarker("body", key), createdAt: "" }],
  };
}

describe("chainRoutingContext", () => {
  test("AC-1 returns the changed feature's directory name", () => {
    expect(chainRoutingContext(routed())?.feature).toBe("alpha");
  });

  test("AC-2 returns the specPath featureIntentPaths returns", () => {
    const env = routed();
    const expected = featureIntentPaths(env.checkout).specPath;
    expect(expected).toBeDefined();
    expect(chainRoutingContext(env)?.specPath).toBe(expected as string);
  });

  test("AC-3 null when botFixChain is false", () => {
    expect(chainRoutingContext(routed([], { botFixChain: false }))).toBeNull();
  });

  test("AC-4 null when advisor is disabled but botFixChain is true", () => {
    expect(chainRoutingContext(routed([], { enabled: false, botFixChain: true }))).toBeNull();
  });

  test("AC-5 null when the config has no advisor block", () => {
    const env = routed();
    const { advisor: _advisor, ...rest } = env.config;
    expect(chainRoutingContext({ ...env, config: rest })).toBeNull();
  });

  test("AC-6 null when no prd.json is changed", () => {
    expect(chainRoutingContext(routed([], { files: [SPEC] }))).toBeNull();
  });

  test("AC-7 null when two features' prd.json are changed", () => {
    const files = [PRD, SPEC, ".nax/features/beta/prd.json", ".nax/features/beta/spec.md"];
    expect(chainRoutingContext(routed([], { files }))).toBeNull();
  });

  test("AC-8 null when one prd.json changes without a spec.md", () => {
    expect(chainRoutingContext(routed([], { files: [PRD] }))).toBeNull();
  });
});

describe("ledgerFeature", () => {
  test("AC-9 returns the changed feature's directory name", () => {
    expect(ledgerFeature(routed())).toBe("alpha");
  });
});

describe("selectChainFindings", () => {
  const keys = (env: BotFixEnv) => selectChainFindings(env).map(({ item }) => item.key);

  test("AC-10 returns a chain finding at generation 2 when threshold is 2", () => {
    expect(keys(routed([finding("f-1")], { generation: 2 }))).toEqual(["f-1"]);
  });

  test("AC-11 skips generation 1 when threshold is 2", () => {
    const lineage = { generation: 1, parents: ["p"], pushSha: "a" };
    expect(keys(routed([finding("f-1", { lineage })], { generation: 2 }))).toEqual([]);
  });

  test("AC-12 returns generation 3 when threshold is 3", () => {
    const lineage = { generation: 3, parents: ["p"], pushSha: "a" };
    expect(keys(routed([finding("f-1", { lineage })], { generation: 3 }))).toEqual(["f-1"]);
  });

  test("AC-13 skips generation 2 when threshold is 3", () => {
    expect(keys(routed([finding("f-1")], { generation: 3 }))).toEqual([]);
  });

  test("AC-14 skips a minor finding", () => {
    expect(keys(routed([finding("f-1", { severity: "minor" })]))).toEqual([]);
  });

  test("AC-15 skips a fix-gap finding", () => {
    expect(keys(routed([finding("f-1", { origin: "fix-gap" })]))).toEqual([]);
  });

  test("AC-16 skips a trigger outside the review's blocking set", () => {
    const env = routed([finding("f-1", { trigger: "adversarial" }), finding("f-2")]);
    const narrowed = { ...env, review: { ...env.review, blockingTriggers: ["normal" as const] } };
    expect(keys(narrowed)).toEqual(["f-2"]);
  });

  test("AC-17 skips a finding with no lineage", () => {
    expect(keys(routed([finding("f-1", { lineage: undefined })]))).toEqual([]);
  });

  test("AC-18 skips thread and comment items", () => {
    const items: AgreedItem[] = [
      { kind: "thread", key: "t-1", issue: "i", reason: "r", threadId: "1", replyTo: "1" },
      { kind: "comment", key: "c-1", issue: "i", reason: "r" },
    ];
    expect(keys(routed(items))).toEqual([]);
  });

  test("AC-19 returns findings in review.agreed order", () => {
    expect(keys(routed([finding("f-3"), finding("f-1"), finding("f-2")]))).toEqual(["f-3", "f-1", "f-2"]);
  });

  test("AC-20 attaches the bot's own thread with the item's key", () => {
    const env = routed([finding("f-1")]);
    const thread = threadBy(env.user.login, "f-1");
    expect(selectChainFindings({ ...env, threads: [thread] })[0]?.thread).toBe(thread);
  });

  test("AC-21 ignores a thread authored by another login", () => {
    const env = routed([finding("f-1")]);
    const result = selectChainFindings({ ...env, threads: [threadBy("mallory", "f-1")] });
    expect(result).toHaveLength(1);
    expect(result[0]?.thread).toBeUndefined();
  });
});
