/**
 * validateConfig — agent key validation against models map
 *
 * Story US-001-5: Update validate() to check agent keys against models map
 *
 * Tests cover:
 * - fallbackOrder agents must exist as keys in config.models
 * - tierOrder entries with an agent field must have that agent in config.models
 * - passes when all referenced agents exist in models
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { NaxConfig } from "@/config/types";
import { validateConfig } from "@/config/validate";

/** Merge overrides into a copy of DEFAULT_CONFIG */
function cfg(overrides: Record<string, unknown>): NaxConfig {
  return {
    ...(DEFAULT_CONFIG as NaxConfig),
    ...overrides,
    agent: {
      ...(DEFAULT_CONFIG as NaxConfig).agent,
      ...((overrides.agent as object) ?? {}),
      fallback: {
        ...(DEFAULT_CONFIG as NaxConfig).agent?.fallback,
        ...(((overrides.agent as Record<string, unknown>)?.fallback as object) ?? {}),
      },
    },
    autoMode: {
      ...(DEFAULT_CONFIG as NaxConfig).autoMode,
      ...((overrides.autoMode as object) ?? {}),
      escalation: {
        ...(DEFAULT_CONFIG as NaxConfig).autoMode.escalation,
        ...(((overrides.autoMode as Record<string, unknown>)?.escalation as object) ?? {}),
      },
    },
  } as NaxConfig;
}

describe("validateConfig — agent.fallback.map agent key validation", () => {
  test("returns error when fallback map references agent not in models", () => {
    const config = cfg({
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      agent: {
        default: "claude",
        fallback: {
          map: { claude: ["codex"] },
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("codex"))).toBe(true);
    expect(result.errors.some((e) => e.toLowerCase().includes("fallback"))).toBe(true);
  });

  test("returns error when fallback map contains multiple agents missing from models", () => {
    const config = cfg({
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      agent: {
        default: "claude",
        fallback: {
          map: { claude: ["codex", "gemini"] },
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    const errors = result.errors.join(" ");
    expect(errors).toMatch(/codex/);
    expect(errors).toMatch(/gemini/);
  });

  test("passes when all fallback map agents exist in models", () => {
    const config = cfg({
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        codex: { fast: "codex-mini", balanced: "codex-mid", powerful: "codex-full" },
      },
      agent: {
        fallback: {
          map: { claude: ["codex"] },
        },
      },
    });

    const result = validateConfig(config);

    const fallbackErrors = result.errors.filter(
      (e) => e.toLowerCase().includes("fallback") && (e.includes("claude") || e.includes("codex")),
    );
    expect(fallbackErrors).toHaveLength(0);
  });

  test("passes when fallback map is empty (default) and models has claude", () => {
    const result = validateConfig(DEFAULT_CONFIG as NaxConfig);
    const fallbackErrors = result.errors.filter((e) => e.toLowerCase().includes("fallback"));
    expect(fallbackErrors).toHaveLength(0);
  });

  test("returns error when fallback agent key exists in models but is missing a required tier", () => {
    const config = cfg({
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        codex: { fast: "codex-mini" },
      },
      agent: {
        fallback: {
          map: { claude: ["codex"] },
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    const errors = result.errors.join(" ");
    expect(errors).toMatch(/codex/);
  });

  test("returns errors for each missing tier on a fallback agent", () => {
    const config = cfg({
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        codex: {},
      },
      agent: {
        fallback: {
          map: { claude: ["codex"] },
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    const errors = result.errors.filter((e) => e.includes("codex"));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateConfig — tierOrder agent key validation", () => {
  test("returns error when tierOrder entry has agent not in models", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [{ tier: "fast", attempts: 5, agent: "codex" }],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("codex"))).toBe(true);
  });

  test("returns error message referencing tierOrder or tier context", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [{ tier: "fast", attempts: 3, agent: "codex" }],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    expect(result.errors.some((e) => e.toLowerCase().includes("tier") || e.toLowerCase().includes("tierorder"))).toBe(
      true,
    );
  });

  test("passes when tierOrder entry has agent that exists in models", () => {
    const config = cfg({
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        codex: { fast: "codex-mini", balanced: "codex-mid", powerful: "codex-full" },
      },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [{ tier: "fast", attempts: 5, agent: "codex" }],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    const tierAgentErrors = result.errors.filter(
      (e) => e.includes("codex") && (e.toLowerCase().includes("tier") || e.toLowerCase().includes("agent")),
    );
    expect(tierAgentErrors).toHaveLength(0);
  });

  test("passes when tierOrder entries have no agent field (backward compat)", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 5 },
            { tier: "balanced", attempts: 3 },
          ],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    // No agent-key errors should appear for tier entries without an agent field
    const agentKeyErrors = result.errors.filter(
      (e) => e.toLowerCase().includes("tierorder") && e.toLowerCase().includes("agent"),
    );
    expect(agentKeyErrors).toHaveLength(0);
  });

  test("returns errors for each invalid agent across multiple tierOrder entries", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 5, agent: "codex" },
            { tier: "balanced", attempts: 3, agent: "gemini" },
          ],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    const errors = result.errors.join(" ");
    expect(errors).toMatch(/codex/);
    expect(errors).toMatch(/gemini/);
  });
});

describe("validateConfig — combined agent.fallback.map and tierOrder validation", () => {
  test("passes when all fallback map and tierOrder agents exist in models", () => {
    const config = cfg({
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        codex: { fast: "codex-mini", balanced: "codex-mid", powerful: "codex-full" },
      },
      agent: {
        fallback: {
          map: { claude: ["codex"] },
        },
      },
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 5, agent: "codex" },
            { tier: "balanced", attempts: 3 },
          ],
          escalateEntireBatch: true,
        },
      },
    });

    const result = validateConfig(config);

    const agentErrors = result.errors.filter(
      (e) =>
        (e.toLowerCase().includes("fallback") || e.toLowerCase().includes("tier")) &&
        (e.includes("claude") || e.includes("codex")),
    );
    expect(agentErrors).toHaveLength(0);
  });
});

describe("validateConfig — complexityRouting rung-qualified entries (spec §6)", () => {
  test("string form error message stays byte-identical to the pre-plan-C one", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        complexityRouting: {
          simple: "ultra",
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
      },
    });

    const result = validateConfig(config);

    expect(result.errors).toContain("complexityRouting.simple must be one of: fast, balanced, powerful (got 'ultra')");
  });

  test("object rung with an unknown agent errors", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        complexityRouting: {
          simple: { tier: "cheap", agent: "codex" },
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('complexityRouting.simple: agent "codex" is not a key in models');
  });

  test("object rung whose tier is missing under its agent errors", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
      autoMode: {
        complexityRouting: {
          simple: { tier: "cheap" },
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
      },
    });

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('complexityRouting.simple: tier "cheap" not found under agent "claude"');
  });

  test("valid object rung produces no complexityRouting errors", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        native: { cheap: "opencode-go/deepseek-v4-flash" },
      },
      autoMode: {
        complexityRouting: {
          simple: { tier: "cheap", agent: "native" },
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
      },
    });

    const result = validateConfig(config);

    const routingErrors = result.errors.filter((e) => e.includes("complexityRouting"));
    expect(routingErrors).toHaveLength(0);
  });
});

describe("agentless tierOrder rungs resolve against the default agent's map (spec §8)", () => {
  const BUILTINS = { fast: "haiku", balanced: "sonnet", powerful: "opus" };
  const MODELS = { claude: BUILTINS, native: { cheap: "opencode-go/deepseek-v4-flash" } };

  test("agentless rung whose tier is missing from the default agent's map is an error", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "cheap", attempts: 2 }] } }, // claude has no "cheap"
    });
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain('tier "cheap" does not resolve under agent "claude" (the default agent)');
  });

  test("agentless rung naming a default-agent tier passes", () => {
    const config = cfg({
      agent: { default: "claude" },
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "fast", attempts: 2 }] } },
    });
    expect(validateConfig(config).valid).toBe(true);
  });

  test("agent-qualified rung is left to the schema gate (no duplicate error here)", () => {
    // schemas.ts:512-517 owns this case; validateConfig must not re-report it.
    const config = cfg({
      agent: { default: "claude" },
      models: MODELS,
      autoMode: { escalation: { tierOrder: [{ tier: "cheap", attempts: 3, agent: "native" }] } },
    });
    expect(validateConfig(config).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Characterisation for the complexity drain (C1a): the basic-field branches
// below were pinned only through NaxConfigSchema.safeParse elsewhere — never
// through validateConfig itself. Every message here is asserted byte-exact
// against the deprecated validator so the extraction keeps it verbatim.
// ---------------------------------------------------------------------------

describe("validateConfig — version and models-mapping guards", () => {
  test("non-1 version produces the exact version error", () => {
    const result = validateConfig(cfg({ version: 2 }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Invalid version: expected 1, got 2");
  });

  test("missing models mapping produces the exact models error (empty complexityRouting)", () => {
    // The models error is only RETURNED when every complexityRouting entry is
    // absent: the routing block below dereferences config.models unguarded.
    const result = validateConfig(cfg({ models: undefined, autoMode: { complexityRouting: {} } }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("models mapping is required");
  });

  test("missing models mapping with a populated complexityRouting THROWS (quirk, pinned as-is)", () => {
    // Recorded quirk, not fixed (behaviour-preserving batch): line 152 reads
    // `config.models[defaultAgentKey]` without re-checking config.models, so a
    // models-less config with any defined routing entry crashes mid-validation.
    expect(() => validateConfig(cfg({ models: undefined }))).toThrow(TypeError);
  });

  test("default agent without a model map produces the exact error", () => {
    const result = validateConfig(
      cfg({ agent: { default: "claude" }, models: { codex: { fast: "f", balanced: "b", powerful: "p" } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("models.claude is required (default agent has no model map)");
  });

  test("each required tier missing on the default agent produces one error per tier", () => {
    const result = validateConfig(cfg({ agent: { default: "claude" }, models: { claude: {} } }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("models.claude.fast is required");
    expect(result.errors).toContain("models.claude.balanced is required");
    expect(result.errors).toContain("models.claude.powerful is required");
  });
});

describe("validateConfig — model entry content checks", () => {
  test("whitespace-only string entry produces the exact identifier error", () => {
    const result = validateConfig(
      cfg({ agent: { default: "claude" }, models: { claude: { fast: "   ", balanced: "b", powerful: "p" } } }),
    );
    expect(result.errors).toContain("models.claude.fast must be a non-empty model identifier");
  });

  test("object entry with empty provider and model produces both exact errors", () => {
    const result = validateConfig(
      cfg({
        agent: { default: "claude" },
        models: { claude: { fast: { provider: "", model: "" }, balanced: "b", powerful: "p" } },
      }),
    );
    expect(result.errors).toContain("models.claude.fast.provider must be non-empty");
    expect(result.errors).toContain("models.claude.fast.model must be non-empty");
  });

  test("object entry with whitespace-only provider produces the provider error", () => {
    const result = validateConfig(
      cfg({
        agent: { default: "claude" },
        models: { claude: { fast: { provider: "  ", model: "m" }, balanced: "b", powerful: "p" } },
      }),
    );
    expect(result.errors).toContain("models.claude.fast.provider must be non-empty");
    expect(result.errors).not.toContain("models.claude.fast.model must be non-empty");
  });
});

describe("validateConfig — execution limits", () => {
  test.each([
    ["maxIterations", 0, "maxIterations must be > 0, got 0"],
    ["costLimit", -1, "costLimit must be > 0, got -1"],
    ["sessionTimeoutSeconds", 0, "sessionTimeoutSeconds must be > 0, got 0"],
  ] as const)("%s <= 0 produces the exact error with the value", (field, value, message) => {
    const result = validateConfig(cfg({ execution: { ...cfg({}).execution, [field]: value } }));
    expect(result.errors).toContain(message);
  });
});

describe("validateConfig — agent.default and escalation.tierOrder guards", () => {
  test("empty agent.default produces the non-empty error", () => {
    const result = validateConfig(cfg({ agent: { default: "" } }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("agent.default must be non-empty");
  });

  test("empty-string agent.default also reads as agent key '' (?? does not catch it)", () => {
    // Quirk pinned as-is: `config.agent?.default ?? DEFAULT_AGENT_NAME` only
    // falls back on null/undefined, so an empty string is used verbatim as the
    // models key and the models error names the empty agent.
    const result = validateConfig(cfg({ agent: { default: "" } }));
    expect(result.errors).toContain("models. is required (default agent has no model map)");
  });

  test("empty tierOrder produces the exact at-least-one-tier error", () => {
    const result = validateConfig(cfg({ agent: { default: "claude" }, autoMode: { escalation: { tierOrder: [] } } }));
    expect(result.errors).toContain("escalation.tierOrder must have at least one tier");
  });

  test.each([
    [0, 'escalation.tierOrder: tier "fast" attempts must be 1-20, got 0'],
    [21, 'escalation.tierOrder: tier "fast" attempts must be 1-20, got 21'],
  ] as const)("tierOrder attempts %i produces the exact range error", (attempts, message) => {
    const result = validateConfig(
      cfg({
        agent: { default: "claude" },
        models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
        autoMode: { escalation: { tierOrder: [{ tier: "fast", attempts }] } },
      }),
    );
    expect(result.errors).toContain(message);
  });
});
