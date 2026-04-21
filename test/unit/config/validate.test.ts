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
import { validateConfig } from "../../../src/config/validate";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config/types";

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

    expect(result.errors.some((e) => e.toLowerCase().includes("tier") || e.toLowerCase().includes("tierorder"))).toBe(true);
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
