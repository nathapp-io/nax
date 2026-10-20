import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import type { BotConfig, BotModelsConfig } from "@/config";
import * as config from "@/config";

describe("NaxConfigSchema bot config", () => {
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
    expect(config.BotConfigSchema.parse(bot)).toEqual(bot);
    expect(config.BotConfigSchema.parse({})).toEqual({ models: {} });
  });

  test.each(["review", "fix"])("rejects invalid %s configured models", (role) => {
    for (const model of ["", { agent: "", model: "m" }, { agent: "native", model: "" }]) {
      expect(config.NaxConfigSchema.safeParse({ bot: { models: { [role]: model } } }).success).toBe(false);
    }
  });
});
