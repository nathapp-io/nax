/** US-003: which blocking set a fix or readiness pass applies to a review artifact. */
import { describe, expect, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import type { BotFixEnv } from "@/bot";
import { reviewBlockingTriggers } from "@/bot/review-blocking";

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
