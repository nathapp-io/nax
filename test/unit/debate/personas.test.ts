/**
 * Tests for debate persona system — Phase 2
 *
 * Covers:
 * - PERSONA_FRAGMENTS: 5 presets, each with identity + lens
 * - resolvePersonas(): no-op without autoPersona, rotation with autoPersona, explicit overrides
 * - buildPersonaBlock(): empty when no persona, ## Your Role block when set
 * - buildDebaterLabel(): plain agent when no persona, "agent (persona)" when set
 */

import { describe, expect, test } from "bun:test";
import {
  PERSONA_FRAGMENTS,
  buildDebaterLabel,
  buildPersonaBlock,
  resolvePersonas,
} from "../../../src/debate/personas";
import type { Debater, DebaterPersona } from "../../../src/debate/types";

// ─── PERSONA_FRAGMENTS ───────────────────────────────────────────────────────

describe("PERSONA_FRAGMENTS", () => {
  const EXPECTED_PRESETS: DebaterPersona[] = [
    "challenger",
    "pragmatist",
    "completionist",
    "security",
    "testability",
  ];

  test("has all 5 expected presets", () => {
    for (const preset of EXPECTED_PRESETS) {
      expect(PERSONA_FRAGMENTS[preset]).toBeDefined();
    }
  });

  test("each preset has non-empty identity and lens", () => {
    for (const preset of EXPECTED_PRESETS) {
      const { identity, lens } = PERSONA_FRAGMENTS[preset];
      expect(typeof identity).toBe("string");
      expect(identity.length).toBeGreaterThan(10);
      expect(typeof lens).toBe("string");
      expect(lens.length).toBeGreaterThan(20);
    }
  });

  test("challenger identity emphasises stress-testing / weaknesses", () => {
    const { identity } = PERSONA_FRAGMENTS.challenger;
    expect(identity.toLowerCase()).toMatch(/stress.test|weakness|challeng/);
  });

  test("pragmatist identity emphasises simplicity / minimal scope", () => {
    const { identity } = PERSONA_FRAGMENTS.pragmatist;
    expect(identity.toLowerCase()).toMatch(/simpl|minimal|pragmat/);
  });

  test("security identity emphasises risk / vulnerabilities", () => {
    const { identity } = PERSONA_FRAGMENTS.security;
    expect(identity.toLowerCase()).toMatch(/risk|security|vulnerab/);
  });
});

// ─── resolvePersonas ─────────────────────────────────────────────────────────

describe("resolvePersonas()", () => {
  test("returns debaters unchanged when autoPersona=false", () => {
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "claude" }];
    const result = resolvePersonas(debaters, "plan", false);
    expect(result).toEqual(debaters);
    expect(result[0]?.persona).toBeUndefined();
  });

  test("returns empty array unchanged", () => {
    const result = resolvePersonas([], "plan", true);
    expect(result).toEqual([]);
  });

  test("plan rotation: 2 debaters get challenger + pragmatist", () => {
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "claude" }];
    const result = resolvePersonas(debaters, "plan", true);
    expect(result[0]?.persona).toBe("challenger");
    expect(result[1]?.persona).toBe("pragmatist");
  });

  test("plan rotation: 3 debaters get challenger + pragmatist + completionist", () => {
    const debaters: Debater[] = [{ agent: "a" }, { agent: "b" }, { agent: "c" }];
    const result = resolvePersonas(debaters, "plan", true);
    expect(result[0]?.persona).toBe("challenger");
    expect(result[1]?.persona).toBe("pragmatist");
    expect(result[2]?.persona).toBe("completionist");
  });

  test("review rotation: 2 debaters get security + completionist", () => {
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "claude" }];
    const result = resolvePersonas(debaters, "review", true);
    expect(result[0]?.persona).toBe("security");
    expect(result[1]?.persona).toBe("completionist");
  });

  test("review rotation: 3 debaters get security + completionist + testability", () => {
    const debaters: Debater[] = [{ agent: "a" }, { agent: "b" }, { agent: "c" }];
    const result = resolvePersonas(debaters, "review", true);
    expect(result[0]?.persona).toBe("security");
    expect(result[1]?.persona).toBe("completionist");
    expect(result[2]?.persona).toBe("testability");
  });

  test("explicit persona is never overwritten by auto-assignment", () => {
    const debaters: Debater[] = [
      { agent: "claude", persona: "security" },
      { agent: "claude" },
      { agent: "claude" },
    ];
    const result = resolvePersonas(debaters, "plan", true);
    // First keeps explicit "security"
    expect(result[0]?.persona).toBe("security");
    // Remaining auto-assigned from plan rotation (challenger, pragmatist)
    expect(result[1]?.persona).toBe("challenger");
    expect(result[2]?.persona).toBe("pragmatist");
  });

  test("rotation wraps around for more than 5 debaters", () => {
    const debaters: Debater[] = Array.from({ length: 6 }, (_, i) => ({ agent: `agent-${i}` }));
    const result = resolvePersonas(debaters, "plan", true);
    // indices 0-4: full rotation, index 5 wraps to index 0 of rotation
    expect(result[5]?.persona).toBe("challenger");
  });

  test("does not mutate original debaters array", () => {
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "claude" }];
    resolvePersonas(debaters, "plan", true);
    expect(debaters[0]?.persona).toBeUndefined();
    expect(debaters[1]?.persona).toBeUndefined();
  });
});

// ─── buildPersonaBlock ───────────────────────────────────────────────────────

describe("buildPersonaBlock()", () => {
  test("returns empty string when debater has no persona", () => {
    const debater: Debater = { agent: "claude" };
    expect(buildPersonaBlock(debater)).toBe("");
  });

  test("returns ## Your Role block when persona is set", () => {
    const debater: Debater = { agent: "claude", persona: "challenger" };
    const block = buildPersonaBlock(debater);
    expect(block).toContain("## Your Role");
    expect(block).toContain(PERSONA_FRAGMENTS.challenger.identity);
    expect(block).toContain(PERSONA_FRAGMENTS.challenger.lens);
  });

  test("block starts with double newline for clean prompt joining", () => {
    const debater: Debater = { agent: "claude", persona: "pragmatist" };
    const block = buildPersonaBlock(debater);
    expect(block).toMatch(/^\n\n/);
  });

  test("each persona produces a unique block", () => {
    const personas: DebaterPersona[] = ["challenger", "pragmatist", "completionist", "security", "testability"];
    const blocks = personas.map((p) => buildPersonaBlock({ agent: "claude", persona: p }));
    const unique = new Set(blocks);
    expect(unique.size).toBe(5);
  });
});

// ─── buildDebaterLabel ───────────────────────────────────────────────────────

describe("buildDebaterLabel()", () => {
  test("returns agent name when no persona", () => {
    const debater: Debater = { agent: "claude" };
    expect(buildDebaterLabel(debater)).toBe("claude");
  });

  test("returns 'agent (persona)' format when persona is set", () => {
    const debater: Debater = { agent: "claude", persona: "challenger" };
    expect(buildDebaterLabel(debater)).toBe("claude (challenger)");
  });

  test("works for all 5 personas", () => {
    const personas: DebaterPersona[] = ["challenger", "pragmatist", "completionist", "security", "testability"];
    for (const persona of personas) {
      const label = buildDebaterLabel({ agent: "test-agent", persona });
      expect(label).toBe(`test-agent (${persona})`);
    }
  });
});
