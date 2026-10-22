import { describe, expect, test } from "bun:test";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { botCostEnv, botCostLimit } from "@/bot/cost";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import { createNoOpCostAggregator } from "@/runtime";

describe("botCostLimit", () => {
  test("AC-7 override takes precedence", () => {
    expect(botCostLimit(makeNaxConfig({ bot: { costLimit: 7 } }), 2)).toBe(2);
  });
  test("AC-8 falls back to configured limit", () => {
    expect(botCostLimit(makeNaxConfig({ bot: { costLimit: 7 } }))).toBe(7);
  });
  test("falls back to schema default when bot config is absent", () => {
    const limit = DEFAULT_CONFIG.bot?.costLimit;
    assertDefined(limit, "schema bot cost limit");
    expect(botCostLimit({ ...makeNaxConfig(), bot: undefined })).toBe(limit);
  });
  test("missing default throws a structured NaxError", () => {
    const original = DEFAULT_CONFIG.bot;
    try {
      DEFAULT_CONFIG.bot = undefined;
      expect(() => botCostLimit({ ...makeNaxConfig(), bot: undefined })).toThrow(NaxError);
      expect(() => botCostLimit({ ...makeNaxConfig(), bot: undefined })).toThrow(
        expect.objectContaining({ code: "BOT_COST_LIMIT_MISSING" }),
      );
    } finally {
      DEFAULT_CONFIG.bot = original;
    }
  });
});

describe("botCostEnv", () => {
  test("reads live successful and failed spend from the runtime snapshot", () => {
    const aggregator = createNoOpCostAggregator();
    const empty = aggregator.snapshot();
    let failed = 0.5;
    aggregator.snapshot = () => ({ ...empty, totalCostUsd: 1, totalErrorCostUsd: failed });
    const env = botCostEnv(makeNaxConfig(), { costAggregator: aggregator }, 2);
    expect(env.limitUsd).toBe(2);
    expect(env.spentUsd()).toBe(1.5);
    failed = 2;
    expect(env.spentUsd()).toBe(3);
  });
});
