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

describe("resolveOperatingTier: profile target seeds the starting rung", () => {
  test("profile tier overrides the complexity-derived tier when nothing is persisted", () => {
    const result = resolveOperatingTier({
      profileTier: "balanced",
      derivedTier: "fast",
      hasEscalationRecords: false,
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(false);
  });

  test("derived tier is used when the story has no profile", () => {
    const result = resolveOperatingTier({ derivedTier: "powerful", hasEscalationRecords: false });

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
    });

    expect(result.tier).toBe("balanced");
    expect(result.isEscalated).toBe(true);
  });

  test("without escalation records, a higher-ranked persisted tier is still kept", () => {
    const result = resolveOperatingTier({
      previousTier: "powerful",
      derivedTier: "fast",
      hasEscalationRecords: false,
    });

    expect(result.tier).toBe("powerful");
    expect(result.isEscalated).toBe(true);
  });

  test("without escalation records, a lower-ranked persisted tier does not stick", () => {
    const result = resolveOperatingTier({
      previousTier: "fast",
      derivedTier: "powerful",
      hasEscalationRecords: false,
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
    });

    expect(result.candidateTier).toBe("fast");
    expect(result.tier).toBe("powerful");
  });
});
