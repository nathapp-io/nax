/**
 * Tests for src/cli/agents.ts (US-005 AC8)
 *
 * The agents list must be driven by ACP_SDK_AGENT_NAMES (the agents that have
 * an ACP launcher) rather than KNOWN_AGENT_NAMES — the registry is
 * intentionally broader (it also serves context generation and precheck
 * loops). Adapterless names like `aider` must not appear in the listing, and
 * no row may carry the generic "ACP Agent" display name.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { KNOWN_AGENT_NAMES } from "@/agents";
import { _acpSdkDeps, ACP_SDK_AGENT_NAMES } from "@/agents/acp-sdk";
import { _cliAgentsDeps, agentsListCommand } from "@/cli/agents";
import { DEFAULT_CONFIG } from "@/config";

interface CapturedLog {
  args: unknown[];
}

describe("agentsListCommand (US-005 AC8: listing driven by ACP_SDK_AGENT_NAMES)", () => {
  let captured: CapturedLog[];
  let originalLog: typeof console.log;
  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;
  let origLaunchKind: typeof _acpSdkDeps.launchCandidateKind;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push({ args });
    };

    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    origLaunchKind = _acpSdkDeps.launchCandidateKind;

    // Mock getAgentVersion to return immediately
    _cliAgentsDeps.getAgentVersion = mock(async () => "1.0.0");
    // Pretend only "claude" is launchable. Stubbing the launcher probe keeps
    // the status column off the machine's PATH.
    _acpSdkDeps.launchCandidateKind = mock((agent: string) => (agent === "claude" ? "local" : undefined));
  });

  afterEach(() => {
    console.log = originalLog;
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    _acpSdkDeps.launchCandidateKind = origLaunchKind;
  });

  test("US-005 AC8: output contains no row for 'aider' (adapterless registry name) and no row whose display name is 'ACP Agent' (DEFAULT_ENTRY fallback)", async () => {
    const config = makeNaxConfig({ agent: { default: "claude" } });
    await agentsListCommand(config, "/tmp/workdir");

    const flat = captured.map((entry) => entry.args.map((a) => (typeof a === "string" ? a : "")).join(" ")).join("\n");

    // 'aider' is in KNOWN_AGENT_NAMES but NOT in ACP_SDK_AGENT_NAMES — the
    // listing must not render a row for it. Also, no row may carry the
    // DEFAULT_ENTRY display name ("ACP Agent").
    expect(flat).not.toContain("aider");
    expect(flat).not.toContain("ACP Agent");
  });

  test("US-005 AC8: output contains rows for every name in ACP_SDK_AGENT_NAMES, installed when it has an ACP launcher", async () => {
    const config = DEFAULT_CONFIG;
    await agentsListCommand(config, "/tmp/workdir");

    const flat = captured.map((entry) => entry.args.map((a) => (typeof a === "string" ? a : "")).join(" ")).join("\n");

    // Every name in ACP_SDK_AGENT_NAMES (claude, codex, gemini, opencode, pi)
    // must appear in the listing. The mocks resolve only "claude" so only
    // claude is "installed"; the others must still appear as rows (with
    // status "unavailable").
    for (const name of ACP_SDK_AGENT_NAMES) {
      expect(flat).toContain(name);
    }
    const rows = flat.split("\n");
    expect(rows.find((line) => line.includes("Claude Code (ACP)"))).toContain("installed");
    expect(rows.find((line) => line.includes("OpenAI Codex (ACP)"))).toContain("unavailable");
  });

  test("US-005 AC8: KNOWN_AGENT_NAMES invariant preserved — registry still contains 'aider' (AC9 cross-check)", () => {
    // Cross-check: even though the listing no longer prints 'aider', the
    // registry still names it (so context-generation and precheck loops
    // that walk KNOWN_AGENT_NAMES keep working).
    expect(KNOWN_AGENT_NAMES).toContain("aider");
  });
});
