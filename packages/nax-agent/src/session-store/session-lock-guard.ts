/** Short interprocess mutex for lock-file mutations, never stolen from a live process. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { NaxError } from "#src/infra/nax-error";

/** Distinguishes retryable mutex contention from mutation and filesystem failures. */
export class SessionLockGuardBusy extends NaxError {
  constructor() {
    super("session in use by another process", "SESSION_LOCKED", { stage: "session-store" });
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function removeMarker(guard: string, marker: string): void {
  try {
    unlinkSync(`${guard}/${marker}`);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
  try {
    // A contender can replace the now-empty directory. rmdir cannot remove its
    // non-empty replacement; never recursively delete the shared guard path.
    rmdirSync(guard);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(codeOf(error)))) throw error;
  }
}

function reapDeadGuard(guard: string): void {
  let markers: string[];
  try {
    markers = readdirSync(guard);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  for (const marker of markers) {
    const pid = /^(\d+)\.[0-9a-f-]+$/.exec(marker)?.[1];
    if (pid === undefined) continue; // Unrecognized guards fail closed.
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      // Only proven death permits recovery, never heartbeat age or EPERM.
      // The unique marker path prevents two reapers from deleting a new owner.
      if (codeOf(error) === "ESRCH") removeMarker(guard, marker);
    }
  }
}

export function withSessionLockGuard(path: string, mutate: () => void): void {
  const guard = `${path}.guard`;
  const marker = `${process.pid}.${randomUUID()}`;
  const prepared = `${guard}.${marker}.tmp`;
  mkdirSync(prepared);
  try {
    writeFileSync(`${prepared}/${marker}`, "", { flag: "wx" });
    reapDeadGuard(guard);
    try {
      // Publish an already non-empty directory atomically. rename can replace
      // an empty (released/reaped) guard, but never a live non-empty guard.
      renameSync(prepared, guard);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(String(codeOf(error)))) throw new SessionLockGuardBusy();
      throw error;
    }
    try {
      mutate();
    } finally {
      removeMarker(guard, marker);
    }
  } finally {
    removeMarker(prepared, marker);
  }
}
