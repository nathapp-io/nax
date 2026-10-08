import { describe, expect, test } from "bun:test";
import { ACP_SDK_AGENT_NAMES, acpSdkEntry, UNSUPPORTED_ENTRY } from "@/agents/acp-sdk/entries";

describe("acp-sdk entries", () => {
  test("lists the agents that have an ACP launcher (no aider)", () => {
    expect([...ACP_SDK_AGENT_NAMES].sort()).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
  });

  test("each entry launches the nax-agent-acp agent of its own name", () => {
    for (const name of ACP_SDK_AGENT_NAMES) {
      const entry = acpSdkEntry(name);
      expect(entry === undefined || entry.agent === name).toBe(true);
    }
  });

  test("aider and unknown names have no entry", () => {
    expect(acpSdkEntry("aider")).toBeUndefined();
    expect(acpSdkEntry("toString")).toBeUndefined();
  });

  test("the unsupported row is the generic ACP Agent display", () => {
    expect(UNSUPPORTED_ENTRY.displayName).toBe("ACP Agent");
    expect(UNSUPPORTED_ENTRY.supportedTiers).toEqual(["balanced"]);
  });
});
