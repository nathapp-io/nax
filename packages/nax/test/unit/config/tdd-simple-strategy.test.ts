/**
 * TS-001: tdd-simple TestStrategy type and router validation
 *
 * Failing tests (RED phase):
 * - TestStrategy type includes 'tdd-simple'
 * - determineTestStrategy returns tdd-simple for simple complexity in auto mode
 * - test-after is only returned when tddStrategy is 'off'
 *
 * Note: Prompt-building tests (buildRoutingPrompt, buildBatchRoutingPrompt) were
 * parity tests removed in Phase 6 when prompts migrated to OneShotPromptBuilder.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { TddConfigSchema } from "@/config";
import { _applyTddStrategyAliasShim } from "@/config/compat-shims";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import { initLogger, resetLogger } from "@/logger";
import { determineTestStrategy } from "@/routing/classify";
import { validateRoutingDecision } from "@/routing/strategies/llm";

beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent" });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// ---------------------------------------------------------------------------
// TS-001: determineTestStrategy returns tdd-simple for simple in auto mode
// ---------------------------------------------------------------------------

describe("TS-001: determineTestStrategy returns tdd-simple for simple complexity", () => {
  test("simple + auto → tdd-simple", () => {
    const result = determineTestStrategy("simple", "Update label", "Change button copy", [], "auto");
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + default tddStrategy → tdd-simple", () => {
    // tddStrategy defaults to 'auto' when omitted
    const result = determineTestStrategy("simple", "Add tooltip", "Show help text on hover", []);
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + off → test-after (off disables TDD)", () => {
    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "off");
    expect(result).toBe("test-after");
  });

  test("simple + strict → three-session-tdd (strict overrides all)", () => {
    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "strict");
    expect(result).toBe("three-session-tdd");
  });

  test("tdd-simple is in the set of valid TestStrategy values", () => {
    const validStrategies = ["test-after", "tdd-simple", "three-session-tdd-lite", "three-session-tdd"];
    const result = determineTestStrategy("simple", "Add button", "A simple story", [], "auto");

    expect(validStrategies).toContain(result);
    expect(result as string).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// TS-001: LLM-derived testStrategy via validateRoutingDecision uses tdd-simple
// ---------------------------------------------------------------------------

describe("TS-001: LLM routing derives tdd-simple for simple stories", () => {
  test("validateRoutingDecision derives tdd-simple for simple complexity", () => {
    const story = {
      id: "TS-001",
      title: "Add submit button",
      description: "Simple UI feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const parsed = {
      complexity: "simple",
      modelTier: "fast",
      reasoning: "Simple button addition",
    };

    const decision = validateRoutingDecision(parsed, DEFAULT_CONFIG, story);
    expect(decision.testStrategy as string).toBe("tdd-simple");
  });
});

describe("tdd.strategy 'simple' and its 'tdd-simple' alias", () => {
  test("the schema accepts 'simple'", () => {
    expect(TddConfigSchema.parse({ maxRetries: 0, strategy: "simple" }).strategy).toBe("simple");
  });

  test("'simple' routes every story to tdd-simple, whatever its complexity", () => {
    expect(determineTestStrategy("expert", "Auth login", "", [], "simple")).toBe("tdd-simple");
  });

  test("the alias shim rewrites 'tdd-simple' to 'simple' without touching other keys", () => {
    const input = { tdd: { strategy: "tdd-simple", maxRetries: 2 }, other: 1 };
    expect(_applyTddStrategyAliasShim(input)).toEqual({ tdd: { strategy: "simple", maxRetries: 2 }, other: 1 });
    expect(input.tdd.strategy).toBe("tdd-simple"); // immutable
  });

  test("the alias shim leaves every other value alone", () => {
    const input = { tdd: { strategy: "lite" } };
    expect(_applyTddStrategyAliasShim(input)).toBe(input);
  });

  describe("end to end through loadConfig", () => {
    let tempDir = "";
    let originalGlobalDir: string | undefined;
    beforeEach(() => {
      _clearRootConfigCache();
      tempDir = makeTempDir("nax-tdd-simple-alias-");
      mkdirSync(join(tempDir, ".nax"), { recursive: true });
      originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    });
    afterEach(() => {
      cleanupTempDir(tempDir);
      if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    });

    test.each(["simple", "tdd-simple"])("a project config with tdd.strategy '%s' loads as 'simple'", async (value) => {
      await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify({ tdd: { strategy: value } }));
      const config = await loadConfig(tempDir);
      expect(config.tdd.strategy).toBe("simple");
    });
  });
});
