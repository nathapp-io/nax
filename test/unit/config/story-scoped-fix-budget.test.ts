/**
 * US-004 — execution.rectification.storyScopedFixBudget config knob.
 *
 * Acceptance criteria covered here:
 *   AC 1 — defaults to true when the field is unset
 *   AC 2 — explicit project-layer override to false is preserved through resolution
 *   AC 3 — string values are rejected (no coercion)
 *
 * AC 2 specifically asserts the layered-resolution path: the project layer
 * `<workdir>/.nax/config.json` MUST win over the schema default. Going through
 * `loadConfig()` (rather than `NaxConfigSchema.parse(...)`) is the only way
 * to exercise deepMergeConfig's project-layer handling — a schema parse
 * shortcut cannot detect a regression in the layering path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/config";
import { loadConfig, NaxConfigSchema } from "@/config";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

function rectificationConfig(overrides: Record<string, unknown> | undefined) {
  const base = { ...(DEFAULT_CONFIG as Record<string, unknown>) };
  if (overrides !== undefined) {
    const execution = base.execution as Record<string, unknown>;
    base.execution = { ...execution, rectification: overrides };
  }
  return base;
}

describe("execution.rectification.storyScopedFixBudget (US-004)", () => {
  test("[US-004 AC 1] defaults to true when execution.rectification is unset", () => {
    const config = NaxConfigSchema.parse({});
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(true);
  });

  test("[US-004 AC 1] defaults to true when execution.rectification is set without storyScopedFixBudget", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ enabled: true }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(true);
  });

  test("[US-004 AC 3] string value 'yes' is rejected without coercion", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: "yes" }));
    expect(result.success).toBe(false);
  });

  test("[US-004 AC 3] string value 'true' is rejected without coercion", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: "true" }));
    expect(result.success).toBe(false);
  });

  test("[US-004 AC 3] numeric value 1 is rejected (only true/false accepted)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: 1 }));
    expect(result.success).toBe(false);
  });
});

// ─── AC 2 — layered-resolution test (project .nax/config.json overrides default) ──
//
// Pattern matches test/unit/config/loader-startdir.test.ts: isolated temp project
// dir + isolated NAX_GLOBAL_CONFIG_DIR (so ~/.nax/config.json is never read),
// write the project config, call loadConfig(workdir), assert.

describe("execution.rectification.storyScopedFixBudget — layered resolution (US-004 AC 2)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-story-scoped-fix-budget-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    // Isolate the global layer so ~/.nax/config.json is never read.
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("[US-004 AC 2] project layer override of storyScopedFixBudget=false is preserved through loadConfig", async () => {
    await Bun.write(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({
        execution: {
          rectification: { storyScopedFixBudget: false },
        },
      }),
    );

    const config = await loadConfig(tempDir);

    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(false);
  });
});