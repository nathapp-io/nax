/**
 * US-001 — the host facts the Linux placeholder modules read, behind one seam.
 *
 * The ledger, the sweep and the excludes step all run where a sandboxed command
 * starts and stops (`commandFinished`) or as the process exits, both of which are
 * synchronous — so this seam is synchronous, and every reader is a plain
 * `node:fs` call (nax-agent is a Node library and uses no Bun API).
 *
 * Tests inject these facts. Each field is a function rather than a value because
 * most are re-read per call: `/proc/<pid>/stat` and `/proc/<pid>/mountinfo` go
 * stale, and `credentialsConfig()` throws until the host has configured it, so
 * `ledgerDir()` must be able to fail at the moment it is called and be
 * re-evaluated afterwards.
 *
 * Deliberately NOT re-exported from `src/internal.ts` (which barrel-exports
 * `src/sandbox/index.ts`): this module is broken up and reshaped by later stories
 * in the feature, so it is not part of the seam nax consumes.
 */
import { readdirSync, readFileSync, readlinkSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialsConfig, NaxError } from "#src/infra/index";
import { isProcessAlive } from "#src/internal/process-alive";
import { type PlaceholderKind, parseStartTicks } from "./placeholder-paths.ts";

/** The real `/proc` entry of a pid, named once so every reader spells it the same way. */
function procPath(pid: number, leaf: string): string {
  return `/proc/${pid}/${leaf}`;
}

/** Every numeric entry of `/proc` — the pids the kernel currently exposes. */
function listPids(): number[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => Number(entry));
}

/**
 * The REAL uid of a process, from the first number of its `/proc/<pid>/status`
 * `Uid:` line. Read from `status` rather than from the directory's ownership
 * because `/proc/<pid>` turns to root for a non-dumpable process, which would
 * make another user's sandbox look like ours.
 */
function realUid(pid: number): number {
  const status = readFileSync(procPath(pid, "status"), "utf8");
  for (const line of status.split("\n")) {
    if (!line.startsWith("Uid:")) continue;
    const uid = Number(line.split(/\s+/)[1]);
    if (Number.isInteger(uid)) return uid;
  }
  throw new NaxError("[sandbox] /proc status has no Uid line", "SANDBOX_PROC_STATUS_INVALID", {
    stage: "sandbox",
    pid,
  });
}

/** The target of `/proc/<pid>/ns/mnt`, the process's mount namespace. */
function mountNs(pid: number): string {
  return readlinkSync(procPath(pid, "ns/mnt"));
}

/** The raw content of `/proc/<pid>/mountinfo`. */
function mountinfo(pid: number): string {
  return readFileSync(procPath(pid, "mountinfo"), "utf8");
}

export const _placeholderDeps = {
  platform: (): NodeJS.Platform => process.platform,
  ledgerDir: (): string => join(credentialsConfig().configDir(), "sandbox", "placeholders"),
  bootId: (): string => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  startTicks: (pid: number): number => parseStartTicks(readFileSync(procPath(pid, "stat"), "utf8")),
  isProcessAlive: (pid: number): boolean => isProcessAlive(pid),
  // `process.getuid` is POSIX-only; the fallback keeps the type total without
  // claiming a real uid.
  uid: (): number => process.getuid?.() ?? 0,
  homedir: (): string => homedir(),
  proc: { listPids, realUid, mountNs, mountinfo },
  remove: (path: string, kind: PlaceholderKind): void => {
    // The kind comes from the recorded identity, so a directory is never unlinked
    // as a file (or the other way round).
    if (kind === "dir") rmdirSync(path);
    else unlinkSync(path);
  },
  onExit: (listener: () => void): void => {
    process.once("exit", listener);
  },
  lockTimeoutMs: 2000,
};
