/**
 * Registry routing, instance reuse, health and the BUG-19 module-level
 * functions (salvaged from the acpx-era ACP-003 suite in S4b-5). Installed-ness
 * of ACP agents comes from _acpSdkDeps.launchCandidateKind; never the real PATH.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
import { _registryTestAdapters, checkAgentHealth, createAgentRegistry, getInstalledAgents } from "@/agents/registry";
import type { NaxConfig } from "@/config/schema";
import { DEFAULT_CONFIG } from "@/config/schema";
import { logActiveProtocol } from "@/execution/lifecycle/run-initialization";

const origLaunchKind = _acpSdkDeps.launchCandidateKind;

function launcherFound(found: boolean): void {
  _acpSdkDeps.launchCandidateKind = mock(() => (found ? "local" : undefined));
}

afterEach(() => {
  _acpSdkDeps.launchCandidateKind = origLaunchKind;
  mock.restore();
});

describe("createAgentRegistry — protocol selection", () => {
  test("returns the ACP adapter for 'claude', named 'claude'", () => {
    const agent = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).getAgent("claude");
    expect(agent).toBeInstanceOf(AcpSdkAgentAdapter);
    expect(agent?.name).toBe("claude");
  });

  test("returns undefined for an unknown agent name", () => {
    expect(
      createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).getAgent("unknown-agent-xyz"),
    ).toBeUndefined();
  });

  test("resolves the protocol field from config", () => {
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp", default: "claude" } })).protocol).toBe("acp");
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "native" } })).protocol).toBe("native");
    expect(createAgentRegistry(makeNaxConfig({ agent: { protocol: "hybrid" } })).protocol).toBe("hybrid");
  });
});

describe("createAgentRegistry — instance reuse", () => {
  test("returns the same instance on repeated getAgent calls", () => {
    const registry = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(registry.getAgent("claude")).toBe(registry.getAgent("claude"));
  });

  test("creates distinct instances for different names and for separate registries", () => {
    const r1 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    const r2 = createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } }));
    expect(r1.getAgent("claude")).not.toBe(r1.getAgent("codex"));
    expect(r1.getAgent("claude")).not.toBe(r2.getAgent("claude"));
  });
});

describe("Config schema — AgentConfig", () => {
  test("NaxConfig accepts agent.protocol 'acp'", () => {
    const config: NaxConfig = makeNaxConfig({ agent: { protocol: "acp" } });
    expect(config.agent?.protocol).toBe("acp");
  });

  test("DEFAULT_CONFIG has agent.protocol 'hybrid'", () => {
    expect(DEFAULT_CONFIG.agent?.protocol).toBe("hybrid");
  });
});

describe("createAgentRegistry — checkAgentHealth()", () => {
  test("every entry has name, displayName and installed", async () => {
    launcherFound(true);
    const health = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(health.length).toBeGreaterThan(0);
    for (const entry of health) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.displayName).toBe("string");
      expect(typeof entry.installed).toBe("boolean");
    }
  });

  test("claude is installed exactly when its ACP launcher is found", async () => {
    launcherFound(true);
    const found = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(found.find((e) => e.name === "claude")?.installed).toBe(true);
    launcherFound(false);
    const missing = await createAgentRegistry(makeNaxConfig({ agent: { protocol: "acp" } })).checkAgentHealth();
    expect(missing.find((e) => e.name === "claude")?.installed).toBe(false);
  });
});

describe("module-level getInstalledAgents() / checkAgentHealth() (BUG-19)", () => {
  beforeEach(() => _registryTestAdapters.clear());
  afterEach(() => _registryTestAdapters.clear());

  test("getInstalledAgents returns installed adapters instead of an unconditional []", async () => {
    launcherFound(true);
    const installed = await getInstalledAgents();
    expect(installed.some((a) => a.name === "claude")).toBe(true);
  });

  test("getInstalledAgents returns no ACP agents when no launcher is available", async () => {
    launcherFound(false);
    const installed = await getInstalledAgents();
    expect(installed.filter((a) => a.name !== "native")).toEqual([]);
  });

  test("checkAgentHealth reflects real installed status", async () => {
    launcherFound(true);
    const health = await checkAgentHealth();
    expect(health.find((e) => e.name === "claude")?.installed).toBe(true);
  });
});

describe("logActiveProtocol()", () => {
  test("does not throw for protocol 'acp' or an unset agent config", () => {
    expect(() => logActiveProtocol(makeNaxConfig({ agent: { protocol: "acp" } }))).not.toThrow();
    expect(() => logActiveProtocol(makeNaxConfig())).not.toThrow();
  });
});
