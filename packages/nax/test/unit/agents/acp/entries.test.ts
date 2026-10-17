import { describe, expect, test } from "bun:test";
import type { AcpEntry } from "@/agents/acp/entries";
import { ACP_AGENT_NAMES, acpEntry, UNSUPPORTED_ENTRY } from "@/agents/acp/entries";
import type { ModelTier } from "@/config/schema";

/** The tiers a three-tier ACP agent declares (claude, cursor, gemini, opencode, pi). */
const ALL_TIERS: readonly ModelTier[] = ["fast", "balanced", "powerful"];

describe("acp entries", () => {
  test("lists the agents that have an ACP launcher (no aider)", () => {
    expect([...ACP_AGENT_NAMES].sort()).toEqual(["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
  });

  test("cursor launches cursor-agent acp with its own display name and tiers (SPEC US-005 AC-5)", () => {
    const expected: AcpEntry = {
      agent: "cursor",
      binary: "cursor-agent",
      displayName: "Cursor Agent (ACP)",
      supportedTiers: ALL_TIERS,
      maxContextTokens: 200_000,
    };
    expect(acpEntry("cursor")).toEqual(expected);
  });

  test("each entry launches the nax-agent-acp agent of its own name", () => {
    for (const name of ACP_AGENT_NAMES) {
      const entry = acpEntry(name);
      expect(entry === undefined || entry.agent === name).toBe(true);
    }
  });

  test("aider and unknown names have no entry", () => {
    expect(acpEntry("aider")).toBeUndefined();
    expect(acpEntry("toString")).toBeUndefined();
  });

  test("the unsupported row is the generic ACP Agent display", () => {
    expect(UNSUPPORTED_ENTRY.displayName).toBe("ACP Agent");
    expect(UNSUPPORTED_ENTRY.supportedTiers).toEqual(["balanced"]);
  });
});
