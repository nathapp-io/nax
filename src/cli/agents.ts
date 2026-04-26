/**
 * Agents Command
 *
 * Lists available agents with their binary paths, versions, and health status.
 */

import { KNOWN_AGENT_NAMES, resolveDefaultAgent } from "../agents";
import { AcpAgentAdapter } from "../agents/acp/adapter";
import { getAgentVersion } from "../agents/shared/version-detection";
import type { NaxConfig } from "../config/schema";

/**
 * Injectable dependencies for agentsListCommand — allows tests to mock
 * getAgentVersion without spawning real processes.
 *
 * @internal
 */
export const _cliAgentsDeps = { getAgentVersion };

/**
 * List all agents with status, version, and capabilities.
 *
 * @param config - nax configuration
 * @param _workdir - Working directory (for consistency with other commands)
 */
export async function agentsListCommand(config: NaxConfig, _workdir: string): Promise<void> {
  // Create ACP adapters for all known agents and collect version info
  const adapters = KNOWN_AGENT_NAMES.map((name) => new AcpAgentAdapter(name));
  const agentVersions = await Promise.all(
    adapters.map(async (agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      binary: agent.binary,
      version: await _cliAgentsDeps.getAgentVersion(agent.binary),
      installed: await agent.isInstalled(),
      capabilities: agent.capabilities,
      isDefault: resolveDefaultAgent(config) === agent.name,
    })),
  );

  // Build table rows
  const rows = agentVersions.map((info) => {
    const status = info.installed ? "installed" : "unavailable";
    const versionStr = info.version || "-";
    const defaultMarker = info.isDefault ? " (default)" : "";

    return {
      name: info.displayName + defaultMarker,
      status,
      version: versionStr,
      binary: info.binary,
      tiers: info.capabilities.supportedTiers.join(", "),
    };
  });

  if (rows.length === 0) {
    console.log("No agents available.");
    return;
  }

  // Calculate column widths
  const widths = {
    name: Math.max(5, ...rows.map((r) => r.name.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    binary: Math.max(6, ...rows.map((r) => r.binary.length)),
    tiers: Math.max(5, ...rows.map((r) => r.tiers.length)),
  };

  // Display table
  console.log("\nAvailable Agents:\n");
  console.log(
    `${pad("Agent", widths.name)}  ${pad("Status", widths.status)}  ${pad("Version", widths.version)}  ${pad("Binary", widths.binary)}  ${pad("Tiers", widths.tiers)}`,
  );
  console.log(
    `${"-".repeat(widths.name)}  ${"-".repeat(widths.status)}  ${"-".repeat(widths.version)}  ${"-".repeat(widths.binary)}  ${"-".repeat(widths.tiers)}`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.name, widths.name)}  ${pad(row.status, widths.status)}  ${pad(row.version, widths.version)}  ${pad(row.binary, widths.binary)}  ${pad(row.tiers, widths.tiers)}`,
    );
  }

  console.log();
}

/**
 * Pad string to width.
 *
 * @param str - String to pad
 * @param width - Target width
 * @returns Padded string
 */
function pad(str: string, width: number): string {
  return str.padEnd(width);
}
