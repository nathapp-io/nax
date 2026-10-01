/**
 * Tests for src/cli/agents.ts (US-005 AC8)
 *
 * The agents list must be driven by ACP_ADAPTER_NAMES (the agents that have a
 * real ACP adapter entry) rather than KNOWN_AGENT_NAMES — the registry is
 * intentionally broader (it also serves context generation and precheck
 * loops). Adapterless names like `aider` must not appear in the listing,
 * and an adapter whose name resolves via `DEFAULT_ENTRY` (which is what
 * `new AcpAgentAdapter(name)` falls back to for unknown names) must not
 * appear either.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { KNOWN_AGENT_NAMES } from "@/agents";
import { ACP_ADAPTER_NAMES } from "@/agents/acp";
import { _acpAdapterDeps } from "@/agents/acp/adapter";
import { _cliAgentsDeps, agentsListCommand } from "@/cli/agents";
import { DEFAULT_CONFIG } from "@/config";

interface CapturedLog {
  args: unknown[];
}

describe("agentsListCommand (US-005 AC8: listing driven by ACP_ADAPTER_NAMES)", () => {
  let captured: CapturedLog[];
  let originalLog: typeof console.log;
  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;
  let origWhich: typeof _acpAdapterDeps.which;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push({ args });
    };

    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    origWhich = _acpAdapterDeps.which;

    // Mock getAgentVersion to return immediately
    _cliAgentsDeps.getAgentVersion = mock(async () => "1.0.0");
    // Pretend "claude" resolves; every other binary does not.
    _acpAdapterDeps.which = mock((binary: string) => (binary === "claude" ? "/usr/bin/claude" : null));
  });

  afterEach(() => {
    console.log = originalLog;
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    _acpAdapterDeps.which = origWhich;
  });

  test("US-005 AC8: output contains no row for 'aider' (adapterless registry name) and no row whose display name is 'ACP Agent' (DEFAULT_ENTRY fallback)", async () => {
    const config = makeNaxConfig({ agent: { default: "claude" } });
    await agentsListCommand(config, "/tmp/workdir");

    const flat = captured.map((entry) => entry.args.map((a) => (typeof a === "string" ? a : "")).join(" ")).join("\n");

    // 'aider' is in KNOWN_AGENT_NAMES but NOT in ACP_ADAPTER_NAMES — the
    // listing must not render a row for it. Also, no row may carry the
    // DEFAULT_ENTRY display name ("ACP Agent").
    expect(flat).not.toContain("aider");
    expect(flat).not.toContain("ACP Agent");
  });

  test("US-005 AC8: output contains rows for every name in ACP_ADAPTER_NAMES that resolves via which()", async () => {
    const config = DEFAULT_CONFIG;
    await agentsListCommand(config, "/tmp/workdir");

    const flat = captured.map((entry) => entry.args.map((a) => (typeof a === "string" ? a : "")).join(" ")).join("\n");

    // Every name in ACP_ADAPTER_NAMES (claude, codex, gemini, opencode, pi)
    // must appear in the listing. The mock resolves only "claude" so only
    // claude is "installed"; the others must still appear as rows (with
    // status "unavailable").
    for (const name of ACP_ADAPTER_NAMES) {
      expect(flat).toContain(name);
    }
  });

  test("US-005 AC8: KNOWN_AGENT_NAMES invariant preserved — registry still contains 'aider' (AC9 cross-check)", () => {
    // Cross-check: even though the listing no longer prints 'aider', the
    // registry still names it (so context-generation and precheck loops
    // that walk KNOWN_AGENT_NAMES keep working).
    expect(KNOWN_AGENT_NAMES).toContain("aider");
  });
});
