/**
 * PID Registry — Track and cleanup spawned agent processes
 *
 * Implements BUG-002:
 * - Track PIDs of spawned Claude Code processes
 * - Write .nax-pids file for persistence across crashes
 * - Support killAll() for crash signal handlers
 * - Support cleanupStale() for startup cleanup
 * - Use process groups (setsid) on Linux, direct kill on macOS
 */

import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { getSafeLogger } from "../logger";

/**
 * PID registry file name
 */
const PID_REGISTRY_FILE = ".nax-pids";

/**
 * PID registry entry
 */
interface PidEntry {
  pid: number;
  spawnedAt: string;
  workdir: string;
}

/**
 * PID Registry — Track spawned agent processes and cleanup orphans
 *
 * Maintains a .nax-pids file in the workdir to track spawned processes.
 * On crash, signal handlers call killAll() to terminate all tracked PIDs.
 * On startup, runner calls cleanupStale() to kill any orphaned processes from previous runs.
 *
 * @example
 * ```ts
 * const registry = new PidRegistry("/path/to/project");
 * await registry.register(12345);
 * // ... later, on crash or shutdown
 * await registry.killAll();
 * ```
 */
export class PidRegistry {
  private readonly workdir: string;
  private readonly pidsFilePath: string;
  private readonly pids: Set<number> = new Set();
  private readonly platform: NodeJS.Platform;
  private frozen = false;

  /**
   * Create a new PID registry for the given workdir.
   *
   * @param workdir - Working directory where .nax-pids will be stored
   * @param platform - Optional platform override (for testing)
   */
  constructor(workdir: string, platform?: NodeJS.Platform) {
    this.workdir = workdir;
    this.pidsFilePath = `${workdir}/${PID_REGISTRY_FILE}`;
    this.platform = platform ?? process.platform;
  }

  /**
   * Mark the registry frozen. After freeze, `register()` is a no-op that logs
   * a warning, and `killAll()` still works on already-registered PIDs. Called
   * by signal handlers at shutdown so in-flight retry paths cannot register
   * newly-spawned processes that would then outlive the process.
   *
   * Idempotent.
   */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    getSafeLogger()?.debug("pid-registry", "Registry frozen — new registrations blocked");
  }

  /** Whether the registry currently rejects new registrations. */
  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Register a spawned process PID.
   *
   * Adds the PID to the in-memory set and writes to .nax-pids file.
   *
   * When the registry is frozen (see `freeze()`), the PID is NOT recorded and
   * a warning is logged. Callers spawning during shutdown should not register
   * their children; let the OS reap them once the process exits.
   *
   * @param pid - Process ID to register
   */
  async register(pid: number): Promise<void> {
    const logger = getSafeLogger();
    if (this.frozen) {
      logger?.warn("pid-registry", `Registration blocked (registry frozen) PID ${pid}`, { pid });
      return;
    }
    this.pids.add(pid);

    const entry: PidEntry = {
      pid,
      spawnedAt: new Date().toISOString(),
      workdir: this.workdir,
    };

    try {
      // Atomically append to .nax-pids file (one JSON entry per line)
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(this.pidsFilePath, line);
      logger?.debug("pid-registry", `Registered PID ${pid}`, { pid });
    } catch (err) {
      logger?.warn("pid-registry", `Failed to write PID ${pid} to registry`, {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Unregister a process PID (e.g., after clean exit).
   *
   * Removes the PID from the in-memory set and rewrites .nax-pids file.
   *
   * @param pid - Process ID to unregister
   */
  async unregister(pid: number): Promise<void> {
    const logger = getSafeLogger();
    this.pids.delete(pid);

    try {
      // Rewrite .nax-pids file without the unregistered PID
      await this.writePidsFile();
      logger?.debug("pid-registry", `Unregistered PID ${pid}`, { pid });
    } catch (err) {
      logger?.warn("pid-registry", `Failed to unregister PID ${pid}`, {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Kill all registered processes.
   *
   * Called by crash signal handlers to cleanup spawned agent processes.
   * Uses process groups (setsid) on Linux, direct kill on macOS.
   *
   * On Linux: kill -TERM -<pid> kills the entire process group
   * On macOS: kill -TERM <pid> kills the process directly
   */
  async killAll(): Promise<void> {
    const logger = getSafeLogger();
    const pids = Array.from(this.pids);

    if (pids.length === 0) {
      logger?.debug("pid-registry", "No PIDs to kill");
      return;
    }

    logger?.info("pid-registry", `Killing ${pids.length} registered processes`, { pids });

    const killPromises = pids.map((pid) => this.killPid(pid));
    await Promise.allSettled(killPromises);

    // Clear the registry file
    try {
      await Bun.write(this.pidsFilePath, "");
      this.pids.clear();
      logger?.info("pid-registry", "All registered PIDs killed and registry cleared");
    } catch (err) {
      logger?.warn("pid-registry", "Failed to clear registry file", {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Cleanup stale PIDs from previous runs.
   *
   * Called at runner startup before lock acquisition.
   * Reads .nax-pids file and kills any still-running processes.
   */
  async cleanupStale(): Promise<void> {
    const logger = getSafeLogger();

    if (!existsSync(this.pidsFilePath)) {
      logger?.debug("pid-registry", "No stale PIDs file found");
      return;
    }

    try {
      const content = await Bun.file(this.pidsFilePath).text();
      const lines = content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as PidEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is PidEntry => entry !== null);

      if (lines.length === 0) {
        logger?.debug("pid-registry", "No stale PIDs to cleanup");
        await Bun.write(this.pidsFilePath, "");
        return;
      }

      const stalePids = lines.map((entry) => entry.pid);
      logger?.info("pid-registry", `Cleaning up ${stalePids.length} stale PIDs from previous run`, {
        pids: stalePids,
      });

      const killPromises = stalePids.map((pid) => this.killPid(pid));
      await Promise.allSettled(killPromises);

      // Clear the registry file after cleanup
      await Bun.write(this.pidsFilePath, "");
      logger?.info("pid-registry", "Stale PIDs cleanup completed");
    } catch (err) {
      logger?.warn("pid-registry", "Failed to cleanup stale PIDs", {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Kill a single PID.
   *
   * Uses process groups on Linux (kill -TERM -<pid>), direct kill on macOS (kill -TERM <pid>).
   * Ignores ESRCH (process not found) errors.
   *
   * @param pid - Process ID to kill
   */
  private async killPid(pid: number): Promise<void> {
    const logger = getSafeLogger();

    try {
      // Check if process exists first
      const checkProc = Bun.spawn(["kill", "-0", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const checkCode = await checkProc.exited;

      if (checkCode !== 0) {
        // Process doesn't exist, skip
        logger?.debug("pid-registry", `PID ${pid} not found (already exited)`, { pid });
        return;
      }

      // On Linux, use process groups (kill -TERM -<pid>)
      // On macOS, use direct kill (kill -TERM <pid>)
      const killArgs = this.platform === "linux" ? ["kill", "-TERM", `-${pid}`] : ["kill", "-TERM", String(pid)];

      const killProc = Bun.spawn(killArgs, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const killCode = await killProc.exited;

      if (killCode === 0) {
        logger?.debug("pid-registry", `Killed PID ${pid}`, { pid });
      } else {
        const stderr = await new Response(killProc.stderr).text();
        logger?.warn("pid-registry", `Failed to kill PID ${pid}`, {
          pid,
          exitCode: killCode,
          stderr: stderr.trim(),
        });
      }
    } catch (err) {
      logger?.warn("pid-registry", `Error killing PID ${pid}`, {
        pid,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Rewrite .nax-pids file with current in-memory PIDs.
   */
  private async writePidsFile(): Promise<void> {
    const entries = Array.from(this.pids).map((pid) => ({
      pid,
      spawnedAt: new Date().toISOString(),
      workdir: this.workdir,
    }));

    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await Bun.write(this.pidsFilePath, content ? `${content}\n` : "");
  }

  /**
   * Get all registered PIDs (for testing)
   */
  getPids(): number[] {
    return Array.from(this.pids);
  }
}
