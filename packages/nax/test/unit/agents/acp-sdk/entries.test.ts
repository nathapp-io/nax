import { describe, expect, test } from "bun:test";
import { ACP_ADAPTER_NAMES } from "@/agents/acp";
import { resolveRegistryEntry } from "@/agents/acp/agent-entries";
import { ACP_SDK_AGENT_NAMES, acpSdkEntry, UNSUPPORTED_ENTRY } from "@/agents/acp-sdk/entries";

describe("acp-sdk entries", () => {
  test("covers the same agent names as the acpx adapter", () => {
    expect([...ACP_SDK_AGENT_NAMES].sort()).toEqual([...ACP_ADAPTER_NAMES].sort());
  });

  test("each entry launches the nax-agent-acp agent of its own name", () => {
    for (const name of ACP_SDK_AGENT_NAMES) {
      const entry = acpSdkEntry(name);
      expect(entry === undefined || entry.agent === name).toBe(true);
    }
  });

  test("display name, tiers and context match the acpx rows (parity)", () => {
    for (const name of ACP_SDK_AGENT_NAMES) {
      const acpx = resolveRegistryEntry(name);
      expect(acpSdkEntry(name)).toMatchObject({
        binary: acpx.binary,
        displayName: acpx.displayName,
        supportedTiers: acpx.supportedTiers,
        maxContextTokens: acpx.maxContextTokens,
      });
    }
  });

  test("aider and unknown names have no entry", () => {
    expect(acpSdkEntry("aider")).toBeUndefined();
    expect(acpSdkEntry("toString")).toBeUndefined();
  });

  test("the unsupported row is the acpx DEFAULT_ENTRY display", () => {
    expect(UNSUPPORTED_ENTRY.displayName).toBe("ACP Agent");
    expect(UNSUPPORTED_ENTRY.supportedTiers).toEqual(["balanced"]);
  });
});
