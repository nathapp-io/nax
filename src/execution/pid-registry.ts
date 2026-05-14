/** Track spawned agent PIDs and clean them up on crash without process-group kills. */

import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { getSafeLogger } from "@/logger";

const PID_REGISTRY_FILE = ".nax-pids";
const PID_TREE_KILL_GRACE_MS = 250;

export const _pidRegistryDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  sleep: Bun.sleep,
};

interface PidEntry {
  pid: number;
  spawnedAt: string;
  workdir: string;
}

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  startedAt: string;
}

export class PidRegistry {
  private readonly workdir: string;
  private readonly pidsFilePath: string;
  private readonly pids: Set<number> = new Set();
  private frozen = false;

  constructor(workdir: string, _platform?: NodeJS.Platform) {
    this.workdir = workdir;
    this.pidsFilePath = `${workdir}/${PID_REGISTRY_FILE}`;
  }

  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    getSafeLogger()?.debug("pid-registry", "Registry frozen — new registrations blocked");
  }

  isFrozen(): boolean {
    return this.frozen;
  }

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
      const line = `${JSON.stringify(entry)}\n`;
      await appendFile(this.pidsFilePath, line);
      logger?.debug("pid-registry", `Registered PID ${pid}`, { pid });
    } catch (err) {
      logger?.warn("pid-registry", `Failed to write PID ${pid} to registry`, {
        error: (err as Error).message,
      });
    }
  }

  async unregister(pid: number): Promise<void> {
    const logger = getSafeLogger();
    this.pids.delete(pid);

    try {
      await this.writePidsFile();
      logger?.debug("pid-registry", `Unregistered PID ${pid}`, { pid });
    } catch (err) {
      logger?.warn("pid-registry", `Failed to unregister PID ${pid}`, {
        error: (err as Error).message,
      });
    }
  }

  async killAll(): Promise<void> {
    const logger = getSafeLogger();
    const pids = Array.from(this.pids);

    if (pids.length === 0) {
      logger?.debug("pid-registry", "No PIDs to kill");
      return;
    }

    logger?.info("pid-registry", `Killing ${pids.length} registered processes`, { pids });

    const killPromises = pids.map((pid) => this.killPidTree(pid));
    await Promise.allSettled(killPromises);

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
      logger?.info(
        "pid-registry",
        `Found ${stalePids.length} stale PID entries from previous run; clearing file without signaling (PIDs likely recycled)`,
        { pids: stalePids },
      );

      await Bun.write(this.pidsFilePath, "");
      logger?.info("pid-registry", "Stale PIDs file cleared");
    } catch (err) {
      logger?.warn("pid-registry", "Failed to cleanup stale PIDs", {
        error: (err as Error).message,
      });
    }
  }

  private async killPidTree(rootPid: number): Promise<void> {
    const logger = getSafeLogger();

    if (!Number.isInteger(rootPid) || rootPid <= 1) {
      logger?.warn("pid-registry", `Refusing to signal non-positive or reserved PID ${rootPid}`, { pid: rootPid });
      return;
    }

    const rootIdentity = await this.readProcessIdentity(rootPid);
    if (!rootIdentity) {
      logger?.debug("pid-registry", `PID ${rootPid} not found before tree kill`, { pid: rootPid });
      return;
    }

    const descendants = await this.listDescendantProcesses(rootPid);
    const targets = [...descendants.reverse(), rootIdentity];
    await Promise.allSettled(targets.map((proc) => this.signalIfUnchanged(proc, "TERM")));
    await _pidRegistryDeps.sleep(PID_TREE_KILL_GRACE_MS);
    await Promise.allSettled(targets.map((proc) => this.signalIfUnchanged(proc, "KILL")));
  }

  private async listDescendantProcesses(rootPid: number): Promise<ProcessIdentity[]> {
    const logger = getSafeLogger();
    try {
      const proc = _pidRegistryDeps.spawn(["ps", "-eo", "pid=,ppid=,lstart="], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text().catch(() => "")]);
      if (exitCode !== 0) {
        return [];
      }

      const processesByPid = new Map<number, ProcessIdentity>();
      const childrenByParent = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const parsed = this.parsePsTreeLine(line);
        if (!parsed || parsed.pid <= 1 || parsed.parentPid <= 1) continue;
        const { pid, parentPid } = parsed;
        processesByPid.set(pid, parsed);
        const siblings = childrenByParent.get(parentPid) ?? [];
        siblings.push(pid);
        childrenByParent.set(parentPid, siblings);
      }

      const descendants: ProcessIdentity[] = [];
      const queue = [...(childrenByParent.get(rootPid) ?? [])];
      const seen = new Set<number>();
      while (queue.length > 0) {
        const pid = queue.shift();
        if (pid === undefined || seen.has(pid)) continue;
        seen.add(pid);
        const process = processesByPid.get(pid);
        if (process) descendants.push(process);
        queue.push(...(childrenByParent.get(pid) ?? []));
      }
      return descendants;
    } catch (err) {
      logger?.warn("pid-registry", `Failed to inspect descendants for PID ${rootPid}`, {
        pid: rootPid,
        error: (err as Error).message,
      });
      return [];
    }
  }

  private parsePsTreeLine(line: string): ProcessIdentity | null {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    const startedAt = match[3]?.trim() ?? "";
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || startedAt.length === 0) {
      return null;
    }
    return { pid, parentPid, startedAt };
  }

  private async readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
    const logger = getSafeLogger();
    if (!Number.isInteger(pid) || pid <= 1) return null;

    try {
      const proc = _pidRegistryDeps.spawn(["ps", "-o", "ppid=,lstart=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text().catch(() => "")]);
      if (exitCode !== 0) {
        return null;
      }
      const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const parentPid = Number.parseInt(match[1], 10);
      const startedAt = match[2]?.trim() ?? "";
      if (!Number.isInteger(parentPid) || startedAt.length === 0) return null;
      return { pid, parentPid, startedAt };
    } catch (err) {
      logger?.warn("pid-registry", `Failed to inspect PID ${pid}`, {
        pid,
        error: (err as Error).message,
      });
      return null;
    }
  }

  private async signalIfUnchanged(proc: ProcessIdentity, signal: "TERM" | "KILL"): Promise<void> {
    const current = await this.readProcessIdentity(proc.pid);
    if (!current) {
      getSafeLogger()?.debug("pid-registry", `PID ${proc.pid} exited before SIG${signal}`, {
        pid: proc.pid,
        signal,
      });
      return;
    }
    if (current.parentPid !== proc.parentPid || current.startedAt !== proc.startedAt) {
      getSafeLogger()?.warn("pid-registry", `Skipping SIG${signal} for PID ${proc.pid} after identity changed`, {
        pid: proc.pid,
        signal,
        expectedParentPid: proc.parentPid,
        currentParentPid: current.parentPid,
        expectedStartedAt: proc.startedAt,
        currentStartedAt: current.startedAt,
      });
      return;
    }
    await this.signalPid(proc.pid, signal);
  }

  private async signalPid(pid: number, signal: "TERM" | "KILL"): Promise<void> {
    const logger = getSafeLogger();

    if (!Number.isInteger(pid) || pid <= 1) {
      logger?.warn("pid-registry", `Refusing to signal non-positive or reserved PID ${pid}`, { pid });
      return;
    }

    try {
      // Check if process exists first. Note: this is best-effort — there is an
      // inherent TOCTOU between this check and the kill below. The pid<=1 guard
      // and the explicit single-PID (non-group) signaling bound the worst case
      // to "we signal a recycled, unrelated process" rather than "we slaughter
      // an entire process group containing the user's desktop session."
      const checkProc = _pidRegistryDeps.spawn(["kill", "-0", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const checkCode = await checkProc.exited;

      if (checkCode !== 0) {
        logger?.debug("pid-registry", `PID ${pid} not found (already exited)`, { pid });
        return;
      }

      const killProc = _pidRegistryDeps.spawn(["kill", `-${signal}`, String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const killCode = await killProc.exited;

      if (killCode === 0) {
        logger?.debug("pid-registry", `Sent SIG${signal} to PID ${pid}`, { pid, signal });
      } else {
        const stderr = await new Response(killProc.stderr).text();
        logger?.warn("pid-registry", `Failed to send SIG${signal} to PID ${pid}`, {
          pid,
          signal,
          exitCode: killCode,
          stderr: stderr.trim(),
        });
      }
    } catch (err) {
      logger?.warn("pid-registry", `Error sending SIG${signal} to PID ${pid}`, {
        pid,
        signal,
        error: (err as Error).message,
      });
    }
  }

  private async writePidsFile(): Promise<void> {
    const entries = Array.from(this.pids).map((pid) => ({
      pid,
      spawnedAt: new Date().toISOString(),
      workdir: this.workdir,
    }));

    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await Bun.write(this.pidsFilePath, content ? `${content}\n` : "");
  }

  getPids(): number[] {
    return Array.from(this.pids);
  }
}
