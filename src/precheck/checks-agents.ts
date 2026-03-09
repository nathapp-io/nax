/**
 * Precheck for multi-agent health
 *
 * Detects installed agents, reports version information,
 * and checks health status for each configured agent.
 */

import { getAgentVersions } from "../agents/version-detection";
import type { Check } from "./types";

/**
 * Check multi-agent health: installed agents and their versions
 *
 * This is a Tier 2 warning check. Reports which agents are available
 * and their versions, but doesn't fail if no agents are installed
 * (since the main configured agent is checked in Tier 1).
 */
export async function checkMultiAgentHealth(): Promise<Check> {
  try {
    const versions = await getAgentVersions();

    // Separate installed from not installed
    const installed = versions.filter((v) => v.installed);
    const notInstalled = versions.filter((v) => !v.installed);

    // Build message with agent status
    const lines: string[] = [];

    if (installed.length > 0) {
      lines.push(`Installed agents (${installed.length}):`);
      for (const agent of installed) {
        const versionStr = agent.version ? ` v${agent.version}` : " (version unknown)";
        lines.push(`  • ${agent.displayName}${versionStr}`);
      }
    } else {
      lines.push("No additional agents detected (using default configured agent)");
    }

    if (notInstalled.length > 0) {
      lines.push(`\nAvailable but not installed (${notInstalled.length}):`);
      for (const agent of notInstalled) {
        lines.push(`  • ${agent.displayName}`);
      }
    }

    const message = lines.join("\n");

    return {
      name: "multi-agent-health",
      tier: "warning",
      passed: true, // Always pass - this is informational
      message,
    };
  } catch (error) {
    // If version detection fails, still pass but report error
    return {
      name: "multi-agent-health",
      tier: "warning",
      passed: true,
      message: `Agent detection: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
