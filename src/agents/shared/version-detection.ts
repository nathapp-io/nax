/**
 * Agent version detection utilities
 *
 * Extracts version information from installed agent binaries
 * by running `<agent> --version` and parsing the output.
 */

import { typedSpawn } from "@/utils/bun-deps";
import { getAllAgents, getInstalledAgents } from "../registry";

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

/** Default deadline for `<agent> --version` — most binaries respond in <1s. */
const VERSION_DETECTION_TIMEOUT_MS = 5_000;

/**
 * Dependency injection for testability
 */
export const _versionDetectionDeps = {
  spawn: typedSpawn,
  getInstalledAgents,
  getAllAgents,
};

/**
 * Get version for a single agent binary
 *
 * Runs `<agent> --version` and extracts version string.
 * Returns null if agent not found or version detection fails.
 */
export async function getAgentVersion(binaryName: string): Promise<string | null> {
  let proc: ReturnType<typeof typedSpawn>;
  try {
    proc = _versionDetectionDeps.spawn([binaryName, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // Bun.spawn throws ENOENT if binary not found
    return null;
  }

  // PERF-32: bound the wait. A wedged wrapper script (or a non-existent
  // binary masquerading as one on PATH) used to hang the multi-agent
  // health precheck indefinitely. Race proc.exited against a SIGKILL
  // deadline; on timeout, return null rather than block.
  const exitPromise = proc.exited.then((code) => ({ kind: "exit" as const, code }));
  type TimeoutResult = { kind: "timeout" };
  const timeoutPromise = new Promise<TimeoutResult>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
      resolve({ kind: "timeout" });
    }, VERSION_DETECTION_TIMEOUT_MS);
  });

  // Drain stderr concurrently — >64KB on stderr would otherwise deadlock
  // the pipe buffer even after exit. .catch handles a SIGKILLed process
  // erroring its pipes.
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");

  const result = await Promise.race([exitPromise, timeoutPromise]);

  if (result.kind === "timeout") {
    return null;
  }

  const exitCode = result.code;
  if (exitCode !== 0) {
    return null;
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  // Surface stderr at debug level for diagnosability — a version-detection
  // failure that produces a non-empty stderr is otherwise silent.
  if (stderr.trim().length > 0) {
    process.stderr.write(`[version-detection] ${binaryName} --version stderr: ${stderr.trim()}\n`);
  }

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
}

/**
 * Get version information for all configured agents
 *
 * Returns list of agents with their installation status and version info.
 */
export async function getAgentVersions(): Promise<AgentVersionInfo[]> {
  // BUG-19: previously called getInstalledAgents() twice and mapped over
  // that result alone — collapsing "all known agents" and "installed
  // agents" into the same set means `installed` is always true, silently
  // dropping the "available but not installed" report (multi-agent-health
  // precheck's second section). getAllAgents() is the full candidate set;
  // getInstalledAgents() is the (possibly smaller) subset actually on PATH.
  const allAgents = _versionDetectionDeps.getAllAgents();
  const installedAgents = await _versionDetectionDeps.getInstalledAgents();
  const installedByName = new Map(installedAgents.map((a) => [a.name, a]));

  const versions = await Promise.all(
    allAgents.map(async (agent): Promise<AgentVersionInfo> => {
      const installed = installedByName.has(agent.name);
      const version = installed ? await getAgentVersion(agent.binary) : null;

      return {
        name: agent.name,
        displayName: agent.displayName,
        version,
        installed,
      };
    }),
  );

  return versions;
}
