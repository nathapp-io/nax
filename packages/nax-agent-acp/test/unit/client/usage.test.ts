import { describe, expect, test } from "bun:test";
import { createCostMeter, tokenUsageOf, turnSpend, usageEvent } from "#src/client/usage";

const usd = (amount: number) => ({ amount, currency: "USD" });

describe("tokenUsageOf (S4-5 D5-a: per turn, as reported)", () => {
  test("maps tokens; thoughts count as output; cache fields when reported", () => {
    expect(
      tokenUsageOf({
        totalTokens: 175,
        inputTokens: 100,
        outputTokens: 20,
        thoughtTokens: 5,
        cachedReadTokens: 50,
        cachedWriteTokens: 0,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 50, cacheWriteTokens: 0 });
  });

  test("absent or null cache fields stay absent, never 0", () => {
    expect(tokenUsageOf({ totalTokens: 3, inputTokens: 1, outputTokens: 2, cachedReadTokens: null })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  test("no usage, or malformed numbers, count as 0", () => {
    expect(tokenUsageOf(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokenUsageOf(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokenUsageOf(JSON.parse('{"inputTokens": -4, "outputTokens": "9", "thoughtTokens": 1.5}'))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("createCostMeter (S4-5 D5-b: cumulative readings, per-turn difference)", () => {
  test("turn 1 from zero, turn 2 the difference", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.004));
    meter.observe(usd(0.01));
    expect(meter.settle()).toEqual({ costUsd: 0.01, costSource: "reported" });
    meter.beginTurn();
    meter.observe(usd(0.025));
    const second = meter.settle();
    expect(second.costSource).toBe("reported");
    expect(second.costUsd).toBeCloseTo(0.015, 10);
  });

  test("a turn with no reading is unpriced and keeps the baseline: its spend lands in the next priced turn", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.01));
    meter.settle();
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    meter.beginTurn();
    meter.observe(usd(0.04));
    expect(meter.settle().costUsd).toBeCloseTo(0.03, 10);
  });

  test("a reading below the baseline (counter restarted) reports the raw reading", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.5));
    meter.settle();
    meter.beginTurn();
    meter.observe(usd(0.02));
    expect(meter.settle()).toEqual({ costUsd: 0.02, costSource: "reported" });
  });

  test("non-USD, non-finite, negative or malformed readings are ignored", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 3, currency: "EUR" });
    meter.observe({ amount: Number.NaN, currency: "USD" });
    meter.observe({ amount: -1, currency: "USD" });
    meter.observe(JSON.parse('{"amount": "1", "currency": "USD"}'));
    meter.observe(null);
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
  });

  test("beginTurn forgets readings of a turn that never settled; the baseline is unchanged", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.2));
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    meter.beginTurn();
    meter.observe(usd(0.3));
    expect(meter.settle()).toEqual({ costUsd: 0.3, costSource: "reported" });
  });

  test("currency is matched trimmed and case-insensitively", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 0.1, currency: " usd " });
    expect(meter.settle()).toEqual({ costUsd: 0.1, costSource: "reported" });
  });
});

describe("turnSpend and usageEvent (S4-5 D5-h)", () => {
  test("a response with usage and a cost reading", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.01));
    const spend = turnSpend(
      { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 4 } },
      meter,
    );
    expect(spend).toEqual({
      tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4 },
      costUsd: 0.01,
      costSource: "reported",
    });
    expect(usageEvent(spend)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 4,
      costUsd: 0.01,
      costSource: "reported",
    });
  });

  test("no usage and no cost: zeros, unpriced", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    const spend = turnSpend({ stopReason: "end_turn" }, meter);
    expect(usageEvent(spend)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: "unpriced",
    });
  });
});

describe("createCostMeter: a seeded baseline (S4-6 D6-a)", () => {
  test("a resumed agent whose total includes earlier turns: the turn costs its own share", () => {
    const meter = createCostMeter(0.01);
    expect(meter.baseline()).toBe(0.01);
    meter.beginTurn();
    meter.observe(usd(0.025));
    const turn = meter.settle();
    expect(turn.costSource).toBe("reported");
    expect(turn.costUsd).toBeCloseTo(0.015, 10);
    expect(meter.baseline()).toBe(0.025);
  });

  test("an agent whose counter restarted below the seed: the raw reading, never negative", () => {
    const meter = createCostMeter(0.5);
    meter.beginTurn();
    meter.observe(usd(0.004));
    expect(meter.settle()).toEqual({ costUsd: 0.004, costSource: "reported" });
    expect(meter.baseline()).toBe(0.004);
  });

  test("an unpriced turn keeps the seed", () => {
    const meter = createCostMeter(0.2);
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    expect(meter.baseline()).toBe(0.2);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a seed of %p is 0", (seed) => {
    expect(createCostMeter(seed).baseline()).toBe(0);
  });

  test("no seed is 0", () => {
    expect(createCostMeter().baseline()).toBe(0);
  });
});
