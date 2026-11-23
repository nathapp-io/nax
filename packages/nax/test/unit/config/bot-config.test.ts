import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import type { BotConfig, BotModelsConfig } from "@/config";
import * as config from "@/config";

describe("NaxConfigSchema bot config", () => {
  test("AC-13/14/24: supplies schema defaults while preserving models", () => {
    const models = { review: "powerful", fix: { agent: "native", model: "m" } };
    expect(config.BotConfigSchema.parse({})).toEqual({
      models: {},
      gateRepairRounds: 1,
      costLimit: 5,
      blockingTriggers: ["normal", "own-concurrency"],
      chainNoticeGeneration: 2,
    });
    expect(config.BotConfigSchema.parse({ models })).toEqual({
      models,
      gateRepairRounds: 1,
      costLimit: 5,
      blockingTriggers: ["normal", "own-concurrency"],
      chainNoticeGeneration: 2,
    });
    expect(config.BotConfigSchema.parse({ gateRepairRounds: 0, costLimit: 2 })).toMatchObject({
      gateRepairRounds: 0,
      costLimit: 2,
    });
  });
  test.each([{ gateRepairRounds: -1 }, { gateRepairRounds: 1.5 }, { costLimit: 0 }, { costLimit: -1 }])(
    "AC-15/16: rejects invalid budget %j",
    (value) => {
      expect(config.BotConfigSchema.safeParse(value).success).toBe(false);
    },
  );
  test.each(["bot.gateRepairRounds", "bot.costLimit"])("AC-17/18: describes %s", (key) => {
    expect(FIELD_DESCRIPTIONS[key]?.length).toBeGreaterThan(0);
  });
  test("US-001 AC-1: preserves the checks model", () => {
    const models: BotModelsConfig = { checks: "fast" };
    expect(config.NaxConfigSchema.parse({ bot: { models } })).toHaveProperty("bot.models.checks", "fast");
  });
  test("US-001 AC-2: leaves checks unset by default", () => {
    expect(config.NaxConfigSchema.parse({}).bot.models.checks).toBeUndefined();
  });
  test("US-001 AC-3: describes the checks model", () => {
    expect(FIELD_DESCRIPTIONS["bot.models.checks"]).toBeString();
    expect(FIELD_DESCRIPTIONS["bot.models.checks"]?.length).toBeGreaterThan(0);
  });
  test("AC-1: defaults bot.models to an empty object", () => {
    expect(config.NaxConfigSchema.parse({})).toHaveProperty("bot.models", {});
  });

  test("AC-2: preserves a review tier", () => {
    const parsed = config.NaxConfigSchema.parse({ bot: { models: { review: "powerful" } } });
    expect(parsed).toHaveProperty("bot.models.review", "powerful");
  });

  test("AC-3: preserves an explicit fix model", () => {
    const model = { agent: "native", model: "m" };
    const parsed = config.NaxConfigSchema.parse({ bot: { models: { fix: model } } });
    expect(parsed).toHaveProperty("bot.models.fix", model);
  });

  test("AC-4: rejects an empty review model", () => {
    expect(config.NaxConfigSchema.safeParse({ bot: { models: { review: "" } } }).success).toBe(false);
  });

  test.each(["bot", "bot.models", "bot.models.review", "bot.models.fix"])("AC-5: describes %s", (key) => {
    expect(FIELD_DESCRIPTIONS[key]).toBeString();
    expect(FIELD_DESCRIPTIONS[key]?.length).toBeGreaterThan(0);
  });

  test("exports the bot schema and types through the config public surface", () => {
    const models: BotModelsConfig = { review: "fast" };
    const bot: BotConfig = { models };
    expect(config.BotConfigSchema.parse(bot)).toEqual({
      ...bot,
      gateRepairRounds: 1,
      costLimit: 5,
      blockingTriggers: ["normal", "own-concurrency"],
      chainNoticeGeneration: 2,
    });
    expect(config.BotConfigSchema.parse({})).toEqual({
      models: {},
      gateRepairRounds: 1,
      costLimit: 5,
      blockingTriggers: ["normal", "own-concurrency"],
      chainNoticeGeneration: 2,
    });
  });

  test.each(["review", "fix"])("rejects invalid %s configured models", (role) => {
    for (const model of ["", { agent: "", model: "m" }, { agent: "native", model: "" }]) {
      expect(config.NaxConfigSchema.safeParse({ bot: { models: { [role]: model } } }).success).toBe(false);
    }
  });
});

/** Unwraps optional/default/prefault/effects wrappers down to the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const inner = (schema as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
  if (inner?.innerType !== undefined) return unwrap(inner.innerType);
  if (inner?.schema !== undefined) return unwrap(inner.schema);
  return schema;
}

/** Every dotted key path `bot` declares, e.g. bot.models.review. */
function keyPaths(prefix: string, schema: z.ZodTypeAny): string[] {
  const shape = (unwrap(schema) as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (shape === undefined) return [prefix];
  return [prefix, ...Object.entries(shape).flatMap(([key, value]) => keyPaths(`${prefix}.${key}`, value))];
}

const BOT_KEY_PATHS = keyPaths("bot", config.BotConfigSchema);

describe("bot blocking vocabulary (US-002)", () => {
  test("US-002 AC-1 defaults the blocking set and the notice generation", () => {
    const parsed = config.BotConfigSchema.parse({});
    expect(parsed.blockingTriggers).toEqual(["normal", "own-concurrency"]);
    expect(parsed.chainNoticeGeneration).toBe(2);
  });

  test("US-002 AC-2 rejects an empty blocking set", () => {
    expect(config.BotConfigSchema.safeParse({ blockingTriggers: [] }).success).toBe(false);
  });

  test("bot-trigger-classes AC-8 accepts version-skew as a blocking trigger", () => {
    const parsed = config.BotConfigSchema.safeParse({ blockingTriggers: ["normal", "version-skew"] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.blockingTriggers).toEqual(["normal", "version-skew"]);
  });

  test("US-002 AC-3 rejects an unknown blocking trigger", () => {
    expect(config.BotConfigSchema.safeParse({ blockingTriggers: ["normal", "race"] }).success).toBe(false);
  });

  test("US-002 AC-4 rejects a notice generation below 1", () => {
    expect(config.BotConfigSchema.safeParse({ chainNoticeGeneration: 0 }).success).toBe(false);
  });

  test("US-002 AC-4 rejects a fractional notice generation", () => {
    expect(config.BotConfigSchema.safeParse({ chainNoticeGeneration: 1.5 }).success).toBe(false);
  });

  test("US-002 AC-5 documents every bot.<key> path of BotConfigSchema", () => {
    // Guard the walker itself: a shape it cannot unwrap would pass vacuously.
    expect(BOT_KEY_PATHS).toContain("bot.blockingTriggers");
    expect(BOT_KEY_PATHS).toContain("bot.chainNoticeGeneration");
    expect(BOT_KEY_PATHS).toContain("bot.models.review");
  });

  test.each(["bot.blockingTriggers", "bot.chainNoticeGeneration"])("US-002 AC-5 describes %s", (key) => {
    expect(BOT_KEY_PATHS).toContain(key);
    expect(FIELD_DESCRIPTIONS[key]).toBeString();
    expect(FIELD_DESCRIPTIONS[key]?.trim().length).toBeGreaterThan(0);
  });

  test("US-002 AC-5 leaves no bot key undocumented", () => {
    const undocumented = BOT_KEY_PATHS.filter((key) => (FIELD_DESCRIPTIONS[key]?.trim().length ?? 0) === 0);
    expect(undocumented).toEqual([]);
  });
});
