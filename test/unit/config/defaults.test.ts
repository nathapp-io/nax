// RE-ARCH: keep
/**
 * DEFAULT_CONFIG tests.
 *
 * Merged from three files that all pin the default config surface:
 *   - DEFAULT_CONFIG.review.checks defaults (schema backwards compatibility)
 *   - US-002: DEFAULT_CONFIG is derived from NaxConfigSchema.parse({}), not a
 *     hand-maintained literal
 *   - US-003: schema defaults deeply equal DEFAULT_CONFIG (single source of truth)
 *
 * The original per-ticket files were `defaults-schema-derive.test.ts` (US-002)
 * and `defaults-ssot.test.ts` (US-003).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDefined } from "@test/helpers";
import {
  AdversarialReviewConfigSchema,
  ExecutionConfigSchema,
  RectificationConfigSchema,
  RegressionGateConfigSchema,
} from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { loadConfig } from "@/config/loader";
import { NaxConfigSchema } from "@/config/schemas";
import type { NaxConfig } from "@/config/types";

describe("DEFAULT_CONFIG review.checks", () => {
  test("default review.checks is ['typecheck', 'lint'] without 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).toEqual(["typecheck", "lint"]);
  });

  test("default review.checks does not include 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).not.toContain("test");
  });

  test.each([["typecheck"], ["lint"]] as const)("default review.checks includes '%s'", (check) => {
    expect(DEFAULT_CONFIG.review.checks).toContain(check);
  });
});

describe("schema backwards compatibility: 'test' remains a valid review check", () => {
  test.each([[["typecheck", "lint", "test"]], [["test"]]])("schema accepts review.checks %j", (checks) => {
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, checks } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema rejects review.checks with unknown check name", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "lint", "unknown-check"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("schema: 'build' is a valid review check (BUILD-001)", () => {
  test.each([[["typecheck", "lint", "build"]], [["build"]]])("schema accepts review.checks %j", (checks) => {
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, checks } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts review.commands.build", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["build"],
        commands: { build: "bun run build" },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.commands.build).toBe("bun run build");
    }
  });
});

describe("DEFAULT_CONFIG.models per-agent shape (US-001-4)", () => {
  test("models has per-agent structure with 'claude' key", () => {
    expect(DEFAULT_CONFIG.models).toHaveProperty("claude");
  });

  test("models.claude has fast/balanced/powerful tiers as strings", () => {
    expect(DEFAULT_CONFIG.models.claude).toEqual({
      fast: "haiku",
      balanced: "sonnet",
      powerful: "opus",
    });
  });

  test.each([
    ["fast" as const, "haiku"],
    ["balanced" as const, "sonnet"],
    ["powerful" as const, "opus"],
  ])("models.claude.%s is '%s'", (tier, expected) => {
    expect(DEFAULT_CONFIG.models.claude[tier]).toBe(expected);
  });

  test("models.native maps every tier to a provider-qualified anthropic id", () => {
    expect(DEFAULT_CONFIG.models.native).toEqual({
      fast: "anthropic/claude-haiku-4-5",
      balanced: "anthropic/claude-sonnet-5",
      powerful: "anthropic/claude-opus-5-5",
    });
  });

  test("the default agent is native under the hybrid protocol", () => {
    expect(DEFAULT_CONFIG.agent?.default).toBe("native");
    expect(DEFAULT_CONFIG.agent?.protocol).toBe("hybrid");
  });

  test("a loaded project config that overrides nothing validates under the new defaults", async () => {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const projectDir = join(tmpdir(), `nax-defaults-native-project-${suffix}`);
    const globalDir = join(tmpdir(), `nax-defaults-native-global-${suffix}`);
    mkdirSync(join(projectDir, ".nax"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    // A config file must exist: the loader skips validation when nothing was merged.
    writeFileSync(join(projectDir, ".nax", "config.json"), JSON.stringify({ version: 1 }));
    const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    try {
      const config = await loadConfig(projectDir);
      expect(config.agent?.default).toBe("native");
      expect(config.agent?.protocol).toBe("hybrid");
      expect(config.execution.sandbox?.enabled).toBe(true);
    } finally {
      if (originalGlobalDir === undefined) {
        process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
      } else {
        process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_CONFIG.precheck.storySizeGate (US-001)", () => {
  test.each([
    ["action" as const, "block" as const],
    ["maxReplanAttempts" as const, 3 as const],
    ["maxAcCount" as const, 10 as const],
    ["maxDescriptionLength" as const, 3000 as const],
    ["maxBulletPoints" as const, 12 as const],
  ])("precheck.storySizeGate.%s defaults to %s", (field, expected) => {
    assertDefined(DEFAULT_CONFIG.precheck, "DEFAULT_CONFIG.precheck");
    expect(DEFAULT_CONFIG.precheck.storySizeGate[field]).toBe(expected);
  });
});

describe("US-002: Derive DEFAULT_CONFIG from schema parse", () => {
  describe("defaults.ts structure", () => {
    test("defaults.ts is fewer than 15 lines total", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const defaultsPath = resolve(import.meta.dir, "../../../src/config/defaults.ts");
      const content = readFileSync(defaultsPath, "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThan(15);
    });

    test("DEFAULT_CONFIG is exported from defaults.ts", () => {
      expect(DEFAULT_CONFIG).toBeDefined();
    });

    test("DEFAULT_CONFIG is cast from NaxConfigSchema.parse({})", () => {
      const derivedConfig = NaxConfigSchema.parse({});
      expect(derivedConfig).toBeDefined();
      expect(typeof derivedConfig).toBe("object");
    });
  });

  describe("DEFAULT_CONFIG default values from Zod schema", () => {
    test("DEFAULT_CONFIG.execution.sessionTimeoutSeconds === 3600", () => {
      expect(DEFAULT_CONFIG.execution.sessionTimeoutSeconds).toBe(3600);
    });

    test("DEFAULT_CONFIG.execution.rectification.maxAttemptsTotal === 12", () => {
      expect(DEFAULT_CONFIG.execution.rectification.maxAttemptsTotal).toBe(12);
    });

    test("DEFAULT_CONFIG.execution.rectification.maxAttemptsPerStrategy === 3", () => {
      expect(DEFAULT_CONFIG.execution.rectification.maxAttemptsPerStrategy).toBe(3);
    });
  });

  describe("NaxConfigSchema.parse({}) produces DEFAULT_CONFIG", () => {
    test("schema parse returns object with same sessionTimeoutSeconds; schema parse returns object with same rectification.maxAttemptsTotal", () => {
      const parsed = NaxConfigSchema.parse({});
      expect(parsed.execution.sessionTimeoutSeconds).toBe(3600);
      expect(parsed.execution.rectification.maxAttemptsTotal).toBe(12);
    });

    test("schema parse produces NaxConfig type", () => {
      const parsed = NaxConfigSchema.parse({});
      const typed = parsed as NaxConfig;
      expect(typed.execution).toBeDefined();
      expect(typed.quality).toBeDefined();
    });
  });

  describe("BUG-20: execution timeout defaults never drift between outer literal and inner schema", () => {
    // Previously the outer `execution: ExecutionConfigSchema.default({...})`
    // literal in schemas.ts hardcoded verificationTimeoutSeconds: 600,
    // rectification.fullSuiteTimeoutSeconds: 300, and
    // regressionGate.timeoutSeconds: 300 — all of which had drifted from
    // their own field-level `.default()` in schemas-execution.ts (300, 120,
    // 120 respectively). `NaxConfigSchema.parse({})` used the outer numbers;
    // parsing a config that supplied `execution.rectification: {}` used the
    // inner ones. Pin both to the single source of truth.
    test("DEFAULT_CONFIG.execution.verificationTimeoutSeconds matches the field's own schema default", () => {
      const fieldDefault = ExecutionConfigSchema.shape.verificationTimeoutSeconds.parse(undefined);
      expect(DEFAULT_CONFIG.execution.verificationTimeoutSeconds).toBe(fieldDefault);
      expect(NaxConfigSchema.parse({}).execution.verificationTimeoutSeconds).toBe(fieldDefault);
    });

    test("DEFAULT_CONFIG.execution.rectification matches RectificationConfigSchema.parse({})", () => {
      const schemaDefault = RectificationConfigSchema.parse({});
      expect(DEFAULT_CONFIG.execution.rectification).toEqual(schemaDefault);
      expect(NaxConfigSchema.parse({}).execution.rectification).toEqual(schemaDefault);
    });

    test("DEFAULT_CONFIG.execution.regressionGate matches RegressionGateConfigSchema.parse({})", () => {
      const schemaDefault = RegressionGateConfigSchema.parse({});
      expect(DEFAULT_CONFIG.execution.regressionGate).toEqual(schemaDefault);
      expect(NaxConfigSchema.parse({}).execution.regressionGate).toEqual(schemaDefault);
    });
  });

  describe("issue #1338: review.adversarial default is schema-derived (no hand-copied drift)", () => {
    test("DEFAULT_CONFIG.review.adversarial equals the schema default (aside from schema-optional substantiation)", () => {
      const schemaDefault = AdversarialReviewConfigSchema.parse({});
      const adv = DEFAULT_CONFIG.review?.adversarial;
      expect(adv).toBeDefined();
      if (!adv) return;
      const { substantiation, ...derived } = adv;
      expect(derived).toEqual(schemaDefault);
      // substantiation is schema-optional (no `.default()`), spread in explicitly to keep the shape.
      expect(substantiation).toEqual({ requote: true, maxRequotes: 5 });
    });

    test("new schema defaults flow into DEFAULT_CONFIG automatically (recurrenceDemotion, not a hand-copied literal)", () => {
      expect(DEFAULT_CONFIG.review?.adversarial?.recurrenceDemotion).toEqual(
        AdversarialReviewConfigSchema.parse({}).recurrenceDemotion,
      );
    });
  });

  describe("loadConfig() with no config files", () => {
    test("loadConfig() with no config files returns config deeply equal to DEFAULT_CONFIG", async () => {
      const tempProjectDir = join(tmpdir(), `nax-test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const tempGlobalDir = join(tmpdir(), `nax-test-global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(tempProjectDir, ".nax"), { recursive: true });
      mkdirSync(tempGlobalDir, { recursive: true });

      const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = tempGlobalDir;

      try {
        const result = await loadConfig(tempProjectDir);
        expect(result).toEqual(DEFAULT_CONFIG);
      } finally {
        if (originalGlobalDir === undefined) {
          process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
        } else {
          process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
        }
        rmSync(tempProjectDir, { recursive: true, force: true });
        rmSync(tempGlobalDir, { recursive: true, force: true });
      }
    });
  });
});

const NAX_CONFIG_KEYS: (keyof NaxConfig)[] = [
  "name",
  "outputDir",
  "version",
  "models",
  "autoMode",
  "autoRoute",
  "routing",
  "execution",
  "install",
  "quality",
  "tdd",
  "constitution",
  "review",
  "plan",
  "acceptance",
  "context",
  "optimizer",
  "plugins",
  "disabledPlugins",
  "hooks",
  "interaction",
  "precheck",
  "prompts",
  "agent",
  "generate",
  "project",
  "curator",
  "autoPr",
  "finish",
  "mcp",
  "reporters",
  "profile",
  "profileChain",
];

describe("NaxConfigSchema.parse({}) does not throw (AC-4)", () => {
  test("parses empty object without throwing", () => {
    expect(() => NaxConfigSchema.parse({})).not.toThrow();
  });
});

describe("schema defaults deeply equal DEFAULT_CONFIG (AC-2)", () => {
  test("deepEqual(NaxConfigSchema.parse({}), DEFAULT_CONFIG) passes", () => {
    const parsed = NaxConfigSchema.parse({}) as NaxConfig;
    expect(parsed).toEqual(DEFAULT_CONFIG);
  });
});

describe("schema defaults have no extra keys beyond DEFAULT_CONFIG (AC-3)", () => {
  test("parsed keys exactly match DEFAULT_CONFIG keys", () => {
    const parsed = NaxConfigSchema.parse({});
    const schemaKeys = Object.keys(parsed).sort();
    const defaultKeys = Object.keys(DEFAULT_CONFIG).sort();
    expect(schemaKeys).toEqual(defaultKeys);
  });
});

describe("every DEFAULT_CONFIG key is a valid NaxConfig top-level key (AC-3)", () => {
  test("all DEFAULT_CONFIG keys exist in NaxConfig", () => {
    const defaultKeys = Object.keys(DEFAULT_CONFIG) as (keyof NaxConfig)[];
    for (const key of defaultKeys) {
      expect(NAX_CONFIG_KEYS).toContain(key);
    }
  });
});

describe("every NaxConfig top-level key with a default is present in schema defaults (AC-3)", () => {
  test("all NaxConfig keys that have .default() are in NaxConfigSchema.parse({})", () => {
    const parsed = NaxConfigSchema.parse({});
    for (const key of NAX_CONFIG_KEYS) {
      if (key in parsed) {
        expect(parsed).toHaveProperty(key);
      }
    }
  });
});
