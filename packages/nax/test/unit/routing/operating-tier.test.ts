/**
 * resolveOperatingTier — the SSOT for "which rung will this story run at?".
 *
 * Both the routing stage (authoritative, post-classification) and
 * buildPreviewRouting (pre-classification, display only) answer this question.
 * When they disagree the run announces one tier and executes another (#1575),
 * so the rule lives in one place and both callers are pinned to it here.
 */

import { describe, expect, test } from "bun:test";
import { resolveOperatingTier } from "@/routing";

const BUILTIN_LADDER = [
  { tier: "fast", attempts: 1 },
  { tier: "balanced", attempts: 1 },
  { tier: "powerful", attempts: 1 },
];
const CUSTOM_LADDER = [
  { tier: "cheap", attempts: 3, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "claude" },
  { tier: "powerful", attempts: 1, agent: "claude" },
];

describe("resolveOperatingTier: profile target seeds the starting rung", () => {
  test("profile tier overrides the complexity-derived tier when nothing is persisted", () => {
    const result = resolveOperatingTier({
      profileTier: "balanced",
      derivedTier: "fast",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(false);
  });

  test("derived tier is used when the story has no profile", () => {
    const result = resolveOperatingTier({
      derivedTier: "powerful",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("powerful");
    expect(result.isEscalated).toBe(false);
  });

  test("profile tier beats a stale lower-ranked persisted tier (the #1575 shape)", () => {
    // prd.json still carries modelTier "fast" from an earlier write; the story's
    // profile targets balanced and has never escalated.
    const result = resolveOperatingTier({
      previousTier: "fast",
      profileTier: "balanced",
      derivedTier: "fast",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(false);
  });
});

describe("resolveOperatingTier: a genuine escalation wins", () => {
  test("an escalation record is honoured outright, even escalating sideways or down (#1522)", () => {
    // Cross-agent ladders escalate agentA/powerful -> agentB/balanced; rank
    // comparison alone would discard that as "not an escalation".
    const result = resolveOperatingTier({
      previousTier: "balanced",
      profileTier: "powerful",
      derivedTier: "powerful",
      hasEscalationRecords: true,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(true);
  });

  test("without escalation records, a higher-ranked persisted tier is still kept", () => {
    const result = resolveOperatingTier({
      previousTier: "powerful",
      derivedTier: "fast",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("powerful");
    expect(result.isEscalated).toBe(true);
  });

  test("without escalation records, a lower-ranked persisted tier does not stick", () => {
    const result = resolveOperatingTier({
      previousTier: "fast",
      derivedTier: "powerful",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("powerful");
    expect(result.isEscalated).toBe(false);
  });
});

describe("resolveOperatingTier: unknown persisted tiers", () => {
  test("an unrankable persisted tier is reported and not treated as an escalation", () => {
    const result = resolveOperatingTier({
      previousTier: "turbo",
      derivedTier: "balanced",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(false);
    expect(result.unknownPreviousTier).toBe(true);
  });

  test("an unrankable persisted tier backed by an escalation record is honoured, not flagged", () => {
    const result = resolveOperatingTier({
      previousTier: "turbo",
      derivedTier: "balanced",
      hasEscalationRecords: true,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.tier).toBe("turbo");
    expect(result.isEscalated).toBe(true);
    expect(result.unknownPreviousTier).toBe(false);
  });

  test("candidateTier is returned so callers can log what was rejected", () => {
    const result = resolveOperatingTier({
      previousTier: "powerful",
      profileTier: "fast",
      derivedTier: "balanced",
      hasEscalationRecords: false,
      tierOrder: BUILTIN_LADDER,
    });

    expect(result.candidateTier).toBe("fast");
    expect(result.tier).toBe("powerful");
  });
});

describe("ladder-derived rank (spec §5)", () => {
  test("recordless higher custom rung is kept", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced",
      previousAgent: "native",
      derivedTier: "cheap",
      derivedAgent: "native",
      hasEscalationRecords: false,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced");
    expect(r.isEscalated).toBe(true);
  });

  test("recordless lower custom rung is discarded", () => {
    const r = resolveOperatingTier({
      previousTier: "cheap",
      previousAgent: "native",
      derivedTier: "balanced",
      derivedAgent: "native",
      hasEscalationRecords: false,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced");
    expect(r.isEscalated).toBe(false);
  });

  test("same tier name ranks by rung, not by name", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced",
      previousAgent: "claude",
      profileTier: "balanced",
      profileAgent: "native",
      derivedTier: "cheap",
      hasEscalationRecords: false,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced"); // claude/balanced (idx 2) beats native/balanced (idx 1)
    expect(r.isEscalated).toBe(true);
  });

  test("escalation record wins regardless of rank (#1522 sideways/down)", () => {
    const r = resolveOperatingTier({
      previousTier: "cheap",
      previousAgent: "native",
      derivedTier: "powerful",
      derivedAgent: "claude",
      hasEscalationRecords: true,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("cheap");
    expect(r.isEscalated).toBe(true);
  });

  test("off-ladder recordless previous rung is discarded and flagged", () => {
    const r = resolveOperatingTier({
      previousTier: "ultra",
      previousAgent: "native",
      derivedTier: "cheap",
      derivedAgent: "native",
      hasEscalationRecords: false,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("cheap");
    expect(r.unknownPreviousTier).toBe(true);
  });

  test("absent ladder: nothing is rankable, records still win", () => {
    const recordless = resolveOperatingTier({
      previousTier: "powerful",
      derivedTier: "fast",
      hasEscalationRecords: false,
    });
    expect(recordless.tier).toBe("fast");
    expect(recordless.unknownPreviousTier).toBe(true);
    const recorded = resolveOperatingTier({
      previousTier: "powerful",
      derivedTier: "fast",
      hasEscalationRecords: true,
    });
    expect(recorded.tier).toBe("powerful");
  });

  test("agentless tier on an agent-qualified ladder ranks at first name match", () => {
    const r = resolveOperatingTier({
      previousTier: "balanced", // no previousAgent
      derivedTier: "cheap",
      derivedAgent: "native",
      hasEscalationRecords: false,
      tierOrder: CUSTOM_LADDER,
    });
    expect(r.tier).toBe("balanced"); // first "balanced" = idx 1 > cheap idx 0
    expect(r.isEscalated).toBe(true);
  });
});
