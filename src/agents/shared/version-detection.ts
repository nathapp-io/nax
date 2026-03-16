/**
 * Agent version detection utilities
 *
 * Extracts version information from installed agent binaries
 * by running `<agent> --version` and parsing the output.
 */

import { getInstalledAgents } from "../registry";
import type { AgentAdapter } from "../types";

/**
 * Information about an installed agent including its version
 */
export interface AgentVersionInfo {
  /** Agent name (e.g., "codex", "aider") */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Agent version or null if not installed/unable to detect */
  version: string | null;
  /** Whether the agent binary is installed */
  installed: boolean;
}

/**
 * Dependency injection for testability
 */
export const _versionDetectionDeps = {
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe" },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  } {
    return Bun.spawn(cmd, opts) as unknown as {
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number>;
    };
  },
};

/**
 * Get version for a single agent binary
 *
 * Runs `<agent> --version` and extracts version string.
 * Returns null if agent not found or version detection fails.
 */
export async function getAgentVersion(binaryName: string): Promise<string | null> {
  try {
    const proc = _versionDetectionDeps.spawn([binaryName, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }

    const stdout = await new Response(proc.stdout).text();
    const versionLine = stdout.trim().split("\n")[0];

    // Extract version from common formats:
    // "tool version 1.2.3"
    // "v1.2.3"
    // "1.2.3"
    const versionMatch = versionLine.match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/);
    if (versionMatch) {
      return versionMatch[0];
    }

    // If no version pattern matched, return the first line as-is
    return versionLine || null;
  } catch {
    // Bun.spawn throws ENOENT if binary not found
    return null;
  }
}

/**
 * Get version information for all configured agents
 *
 * Returns list of agents with their installation status and version info.
 */
export async function getAgentVersions(): Promise<AgentVersionInfo[]> {
  const agents = await getInstalledAgents();
  const agentsByName = new Map(agents.map((a) => [a.name, a]));

  // Import ALL_AGENTS to include non-installed ones
  const { ALL_AGENTS } = await import("../registry");

  const versions = await Promise.all(
    ALL_AGENTS.map(async (agent: AgentAdapter): Promise<AgentVersionInfo> => {
      const version = agentsByName.has(agent.name) ? await getAgentVersion(agent.binary) : null;

      return {
        name: agent.name,
        displayName: agent.displayName,
        version,
        installed: agentsByName.has(agent.name),
      };
    }),
  );

  return versions;
}
