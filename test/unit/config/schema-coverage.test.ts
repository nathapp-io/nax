/**
 * NaxConfigSchema coverage test
 *
 * Catches the class of bug where a field is added to the NaxConfig TypeScript
 * interface (runtime-types.ts) but the corresponding Zod schema is omitted from
 * NaxConfigSchema (schemas.ts). Zod strips unknown keys during safeParse, so the
 * field would silently vanish from the loaded config at runtime.
 *
 * Pattern: build a maximal config with every optional section populated, run it
 * through NaxConfigSchema.safeParse, then assert each section survives. A failing
 * assertion means the section is missing from the Zod schema.
 *
 * When adding a new top-level field to NaxConfig:
 *   1. Add the Zod schema to schemas.ts
 *   2. Add a populated fixture here and assert it round-trips
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

/**
 * Maximal config — every optional top-level section populated with a minimal
 * valid value. Extend this whenever a new optional section is added to NaxConfig.
 */
const MAXIMAL_CONFIG = {
  ...(DEFAULT_CONFIG as Record<string, unknown>),

  // Optional sections — each must survive safeParse intact
  optimizer: {
    enabled: true,
    budgetMultiplier: 2.0,
  },
  hooks: {
    skipGlobal: false,
    hooks: { "post-story": "echo done" },
  },
  interaction: {
    plugin: "cli",
    defaults: {
      timeout: 600000,
      fallback: "escalate" as const,
    },
  },
  agent: {
    protocol: "cli" as const,
    maxInteractionTurns: 5,
  },
  precheck: {
    storySizeGate: {
      enabled: false,
      maxAcceptanceCriteria: 8,
      maxComplexity: "expert" as const,
    },
  },
  prompts: {
    overrides: undefined,
  },
  decompose: {
    trigger: "disabled" as const,
    maxAcceptanceCriteria: 6,
    maxSubstories: 5,
    maxSubstoryComplexity: "medium" as const,
    maxRetries: 2,
    model: "balanced",
  },
  generate: {
    agents: ["claude", "opencode"] as Array<"claude" | "opencode">,
  },
  project: {
    language: "typescript" as const,
    type: "library",
    testFramework: "bun:test",
    lintTool: "biome",
  },
};

describe("NaxConfigSchema — optional section coverage", () => {
  test("all optional sections survive safeParse (not stripped by Zod)", () => {
    const result = NaxConfigSchema.safeParse(MAXIMAL_CONFIG);
    expect(result.success, result.success ? "" : JSON.stringify((result as { error: unknown }).error)).toBe(true);
    if (!result.success) return;

    const data = result.data;

    // Each assertion documents one optional section. If it fails, the section
    // was stripped — add a Zod schema entry in schemas.ts.
    expect(data.optimizer, "optimizer stripped by Zod — add OptimizerConfigSchema to NaxConfigSchema").toBeDefined();
    expect(data.hooks, "hooks stripped by Zod — add HooksConfigSchema to NaxConfigSchema").toBeDefined();
    expect(
      data.interaction,
      "interaction stripped by Zod — add InteractionConfigSchema to NaxConfigSchema",
    ).toBeDefined();
    expect(data.agent, "agent stripped by Zod — add AgentConfigSchema to NaxConfigSchema").toBeDefined();
    expect(data.precheck, "precheck stripped by Zod — add PrecheckConfigSchema to NaxConfigSchema").toBeDefined();
    expect(data.decompose, "decompose stripped by Zod — add DecomposeConfigSchema to NaxConfigSchema").toBeDefined();
    expect(data.generate, "generate stripped by Zod — add GenerateConfigSchema to NaxConfigSchema").toBeDefined();
    expect(data.project, "project stripped by Zod — add ProjectProfileSchema to NaxConfigSchema").toBeDefined();
  });

  test("generate.agents value is preserved correctly", () => {
    const result = NaxConfigSchema.safeParse(MAXIMAL_CONFIG);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate?.agents).toEqual(["claude", "opencode"]);
  });

  test("NaxConfigSchema shape contains all known top-level keys", () => {
    // Static guard: if a key appears in this list but is absent from the schema shape,
    // either add it to NaxConfigSchema or remove it from this list.
    const EXPECTED_KEYS = [
      // Required
      "version",
      "models",
      "autoMode",
      "routing",
      "execution",
      "quality",
      "tdd",
      "constitution",
      "analyze",
      "review",
      "plan",
      "acceptance",
      "context",
      // Optional
      "optimizer",
      "plugins",
      "disabledPlugins",
      "hooks",
      "interaction",
      "agent",
      "precheck",
      "prompts",
      "decompose",
      "generate",
      "project",
    ];

    const schemaKeys = Object.keys(NaxConfigSchema._def.shape);
    for (const key of EXPECTED_KEYS) {
      expect(schemaKeys, `Key "${key}" is in EXPECTED_KEYS but missing from NaxConfigSchema`).toContain(key);
    }
  });
});
