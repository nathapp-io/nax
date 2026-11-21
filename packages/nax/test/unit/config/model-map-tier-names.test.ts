/**
 * `models` accepts `model` and `provider` as tier names (US-002 of review-0b834).
 *
 * `isLegacyFlatModels` used to read ANY top-level value holding a `provider` or
 * `model` key as one flat legacy model definition. A per-agent tier map whose
 * tiers happened to be named `model` or `provider` was therefore migrated to
 * `{ claude: <the whole map> }` and then failed `ModelDefSchema` — a config that
 * states one tier per agent exited 1 with `Invalid configuration`.
 *
 * A value now counts as legacy only when it is an actual definition shape: a
 * string, or a non-null object whose `provider` AND `model` are both strings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import { NaxConfigSchema } from "@/config/schemas";

/** Minimal valid config base — everything except models. Mirrors `schemas.test.ts`. */
function baseConfig(models: unknown) {
  return { ...DEFAULT_CONFIG, models };
}

describe("models — a tier named `model` is a tier, not a legacy definition", () => {
  test("AC-1: models.native.model as a string parses and is preserved", () => {
    const result = NaxConfigSchema.safeParse(baseConfig({ native: { model: "openai/one" } }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.native.model).toBe("openai/one");
    expect(Object.hasOwn(result.data.models, "claude")).toBe(false);
  });

  test("AC-6 (control): an unrelated tier name still parses and is preserved", () => {
    const result = NaxConfigSchema.safeParse(baseConfig({ native: { speed: "openai/one" } }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.native.speed).toBe("openai/one");
  });

  test("AC-3: models.native.model holding a model definition survives as a definition", () => {
    const definition = { provider: "openai", model: "openai/one" };
    const result = NaxConfigSchema.safeParse(baseConfig({ native: { model: definition } }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.native.model).toEqual(definition);
  });
});

describe("models — a tier named `provider` is a tier, not a legacy definition", () => {
  test("AC-2: models.native.provider as a string parses, is preserved, and is not migrated under claude", () => {
    const result = NaxConfigSchema.safeParse(baseConfig({ native: { provider: "openai/one" } }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.native.provider).toBe("openai/one");
    expect(Object.hasOwn(result.data.models, "claude")).toBe(false);
  });
});

describe("models — actual legacy definitions still migrate", () => {
  test("AC-4 (control): a value with both provider and model migrates under claude", () => {
    const result = NaxConfigSchema.safeParse(baseConfig({ fast: { provider: "anthropic", model: "haiku" } }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.claude.fast).toEqual({ provider: "anthropic", model: "haiku" });
    expect(Object.hasOwn(result.data.models, "fast")).toBe(false);
  });

  test("AC-5 (control): a string value migrates under claude", () => {
    const result = NaxConfigSchema.safeParse(baseConfig({ fast: "claude-haiku" }));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.claude.fast).toBe("claude-haiku");
    expect(Object.hasOwn(result.data.models, "fast")).toBe(false);
  });
});

describe("loadConfig — a tier named `model` survives the project layer", () => {
  let dir: string;
  let globalDir: string;
  let prevGlobal: string | undefined;

  beforeEach(() => {
    dir = realpathSync(makeTempDir("nax-model-tier-names-"));
    globalDir = join(dir, ".global-nax");
    mkdirSync(join(dir, ".nax"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    prevGlobal = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    _clearRootConfigCache();
  });

  afterEach(() => {
    if (prevGlobal === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = prevGlobal;
    _clearRootConfigCache();
    cleanupTempDir(dir);
  });

  test("AC-7: the project config's models.native.model resolves unchanged", async () => {
    writeFileSync(
      join(dir, ".nax", "config.json"),
      JSON.stringify({ name: "p", models: { native: { model: "openai/one" } } }),
    );

    const config = await loadConfig(dir);

    expect(config.models.native.model).toBe("openai/one");
  });
});
