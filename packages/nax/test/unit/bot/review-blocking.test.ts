/** US-003: which blocking set a fix or readiness pass applies to a review artifact. */
import { describe, expect, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { hasPushWorthyItem, reviewBlockingTriggers } from "@/bot/review-blocking";
import type { FindingOrigin } from "@/workflow/blocking-findings";

/** The newer review of the same head: conversation-only, so it read no code and raised nothing itself. */
function conversationOnly(base: BotFixEnv): BotFixEnv["review"] {
  return { ...base.review, scope: "conversation-only", quality: "not-reviewed", agreed: [] };
}

describe("reviewBlockingTriggers", () => {
  test("US-003 AC-20 a newer conversation-only review's set wins over the older code review's", () => {
    const base = makeBotFixEnv();
    const env: BotFixEnv = {
      ...base,
      review: { ...conversationOnly(base), blockingTriggers: ["normal"] },
      codeReview: { ...base.review, blockingTriggers: ["normal", "own-concurrency"] },
    };
    expect(reviewBlockingTriggers(env)).toEqual(["normal"]);
  });

  test("falls back to the older code review's set when the newer review states none", () => {
    const base = makeBotFixEnv();
    const env: BotFixEnv = {
      ...base,
      review: conversationOnly(base),
      codeReview: { ...base.review, blockingTriggers: ["manual"] },
    };
    expect(reviewBlockingTriggers(env)).toEqual(["manual"]);
  });

  test("falls back to the configured set for an artifact written before the set existed", () => {
    const base = makeBotFixEnv();
    const env: BotFixEnv = { ...base, config: makeNaxConfig({ bot: { blockingTriggers: ["manual"] } }) };
    expect(reviewBlockingTriggers(env)).toEqual(["manual"]);
  });
});

/** The only agreed item a fix session would act on: one normal important finding with one origin. */
function findingItem(origin: FindingOrigin): AgreedItem {
  return {
    key: "f-0",
    kind: "finding",
    severity: "important",
    issue: "Lock leaks",
    file: "src/a.ts",
    line: 12,
    trigger: "normal",
    origin,
  };
}

describe("hasPushWorthyItem", () => {
  test("AC-17 does not count a fix-gap finding as worth a fix session", () => {
    expect(hasPushWorthyItem(makeBotFixEnv([findingItem("fix-gap")]))).toBe(false);
  });

  test("AC-18 counts a fix-regression finding as worth a fix session", () => {
    expect(hasPushWorthyItem(makeBotFixEnv([findingItem("fix-regression")]))).toBe(true);
  });
});
