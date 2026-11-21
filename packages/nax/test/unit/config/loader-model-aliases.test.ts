/**
 * Alias expansion at config load (US-003): real files through loadConfig /
 * loadConfigForWorkdir, plus the tier-position `@` refusals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { loadConfig, ModelTierSchema, NaxConfigSchema, resolveConfiguredModel } from "@/config";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";
import { NaxError } from "@/errors";

const SOL = "openai-codex/gpt-6.1-sol";
const ALIASES = { modelAliases: { sol: SOL } };

function selectedModel(selector: unknown): unknown {
  return typeof selector === "object" && selector !== null && "model" in selector ? selector.model : undefined;
}

async function rejection(p: Promise<unknown>): Promise<NaxError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("config model alias expansion at load", () => {
  let dir: string;
  let originalGlobalDir: string | undefined;

  const writeRoot = (cfg: Record<string, unknown>) =>
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify(cfg));

  const writePackage = (cfg: Record<string, unknown>) => {
    mkdirSync(join(dir, ".nax", "mono", "packages", "x"), { recursive: true });
    writeFileSync(join(dir, ".nax", "mono", "packages", "x", "config.json"), JSON.stringify(cfg));
  };

  beforeEach(() => {
    dir = makeTempDir("nax-test-alias-load-");
    mkdirSync(join(dir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(dir, ".global-nax");
    _clearRootConfigCache();
    _clearPackageConfigCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalGlobalDir === undefined) process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  });

  test("AC-1: tier entry @sol[medium] expands", async () => {
    writeRoot({ agent: ALIASES, models: { native: { powerful: "@sol[medium]" } } });
    const config = await loadConfig(dir);
    expect(config.models.native?.powerful).toBe(`${SOL}[medium]`);
  });

  test("AC-2: bot.models.review {agent, model} expands", async () => {
    writeRoot({ agent: ALIASES, bot: { models: { review: { agent: "native", model: "@sol[high]" } } } });
    const config = await loadConfig(dir);
    expect(selectedModel(config.bot?.models?.review)).toBe(`${SOL}[high]`);
  });

  test("AC-3: a profile repointing the alias wins for every reference", async () => {
    writeRoot({ agent: ALIASES, bot: { models: { review: { agent: "native", model: "@sol" } } } });
    mkdirSync(join(dir, ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(dir, ".nax", "profiles", "upgrade.json"),
      JSON.stringify({ agent: { modelAliases: { sol: "openai-codex/gpt-6.2-sol" } } }),
    );
    const config = await loadConfig(dir, { profile: "upgrade" });
    expect(selectedModel(config.bot?.models?.review)).toBe("openai-codex/gpt-6.2-sol");
  });

  test("AC-4: package overlay reference expands against the root alias", async () => {
    writeRoot({ agent: ALIASES });
    writePackage({ review: { semantic: { model: { agent: "native", model: "@sol" } } } });
    const config = await loadConfigForWorkdir(join(dir, ".nax", "config.json"), "packages/x");
    expect(selectedModel(config.review.semantic?.model)).toBe(SOL);
  });

  test("AC-5: unknown alias rejects with MODEL_ALIAS_INVALID naming the path", async () => {
    writeRoot({ bot: { models: { review: { agent: "native", model: "@nope" } } } });
    const err = await rejection(loadConfig(dir));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain("bot.models.review.model");
  });

  test("AC-6: string-form @sol in review.semantic.model is refused as a tier", async () => {
    writeRoot({ agent: ALIASES, review: { semantic: { model: "@sol" } } });
    const err = await rejection(loadConfig(dir));
    expect(err.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(err.message).toContain("an @alias is a model id, not a tier");
  });

  test("AC-7: routing.agents.profiles target @sol is refused", async () => {
    writeRoot({
      agent: ALIASES,
      routing: {
        agents: {
          profiles: [{ id: "p", target: { agent: "native", model: "@sol" }, strengths: ["x"] }],
        },
      },
    });
    const err = await rejection(loadConfig(dir));
    expect(err.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(err.message).toContain("an @alias is a model id, not a tier");
  });

  test("AC-8: a models.native tier key starting with @ fails the schema", () => {
    const result = NaxConfigSchema.safeParse({ models: { native: { "@sol": SOL } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message).join("\n")).toContain('tier names cannot start with "@"');
  });

  test("AC-9: an expanded {agent, model} selector resolves as a pin (no modelTier)", async () => {
    writeRoot({ agent: ALIASES, bot: { models: { review: { agent: "native", model: "@sol" } } } });
    const config = await loadConfig(dir);
    const selector = config.bot?.models?.review;
    if (!selector) throw new Error("bot.models.review missing");
    const resolved = resolveConfiguredModel(config.models, "native", selector, "native");
    expect(resolved.modelTier).toBeUndefined();
  });

  test("AC-10: package overlay unknown alias carries packageDir", async () => {
    writeRoot({ agent: ALIASES });
    writePackage({ review: { semantic: { model: { agent: "native", model: "@nope" } } } });
    const err = await rejection(loadConfigForWorkdir(join(dir, ".nax", "config.json"), "packages/x"));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.context?.packageDir).toBe("packages/x");
  });

  test("AC-11: an expanded tier entry is still a tier", async () => {
    writeRoot({ agent: ALIASES, models: { native: { powerful: "@sol[medium]" } } });
    const config = await loadConfig(dir);
    const resolved = resolveConfiguredModel(config.models, "native", "powerful", "native");
    expect(resolved.modelTier).toBe("powerful");
    expect(resolved.modelDef.model).toBe(`${SOL}[medium]`);
  });

  test("AC-12: an unreferenced bad alias value is a schema error", async () => {
    writeRoot({ agent: { modelAliases: { sol: "not-a-valid-target" } } });
    const err = await rejection(loadConfig(dir));
    expect(err.code).toBe("CONFIG_SCHEMA_INVALID");
  });

  test("AC-13: ModelTierSchema rejects a leading @ with the conditional message", () => {
    const result = ModelTierSchema.safeParse("@sol");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(
      'an @alias is a model id, not a tier; where a model pin is accepted, write { "agent": "<agent>", "model": "<value>" }',
    );
  });

  test("AC-14: string tier selector 'balanced' is unchanged", async () => {
    writeRoot({ review: { semantic: { model: "balanced" } } });
    const config = await loadConfig(dir);
    expect(config.review.semantic?.model).toBe("balanced");
  });

  test("AC-15: a literal model id is unchanged", async () => {
    writeRoot({ models: { native: { powerful: `${SOL}[medium]` } } });
    const config = await loadConfig(dir);
    expect(config.models.native?.powerful).toBe(`${SOL}[medium]`);
  });
});
