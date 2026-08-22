import { describe, expect, test } from "bun:test";
import { KNOWN_AGENT_NAMES } from "@/agents";
import { ACP_ADAPTER_NAMES, AcpAgentAdapter } from "@/agents/acp";

describe("ACP agent entries", () => {
  test("every adapter entry is also a known agent name", () => {
    for (const name of ACP_ADAPTER_NAMES) {
      expect(KNOWN_AGENT_NAMES).toContain(name);
    }
  });

  test("pi is registered as a selectable ACP agent", () => {
    expect(KNOWN_AGENT_NAMES).toContain("pi");
    expect(ACP_ADAPTER_NAMES.has("pi")).toBe(true);
  });

  test("pi resolves to its own entry rather than the default fallback", () => {
    const pi = new AcpAgentAdapter("pi");
    const unknown = new AcpAgentAdapter("not-a-real-agent");

    expect(pi.binary).toBe("pi");
    expect(pi.displayName).toBe("Pi Coding Agent (ACP)");
    expect(pi.displayName).not.toBe(unknown.displayName);
  });

  test("pi advertises all three model tiers so tier routing can select a model", () => {
    expect([...new AcpAgentAdapter("pi").capabilities.supportedTiers].sort()).toEqual(["balanced", "fast", "powerful"]);
  });
});
