import { describe, expect, test } from "bun:test";
import { ACP_AGENT_NAMES, acpEntry, UNSUPPORTED_ENTRY } from "@/agents/acp/entries";

describe("acp entries", () => {
  test("lists the agents that have an ACP launcher (no aider)", () => {
    expect([...ACP_AGENT_NAMES].sort()).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
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
