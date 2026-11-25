/**
 * Reclaim dead owners' identity-matching Linux placeholders, never live mounts.
 * The lock is async; all disk checks, /proc reads and removal inside it are
 * synchronous Node operations. In particular no await separates the final
 * identity check from remove. Host facts are injected through _placeholderDeps.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { withPathFileLock } from "#src/internal/path-file-lock";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "./placeholder-deps.ts";
import { type LedgerEntry, type LedgerFile, readLedgerFile } from "./placeholder-ledger.ts";
import { type PlaceholderIdentity, parseMountPoints, placeholderIdentity } from "./placeholder-paths.ts";

/** Resolve only the parent: the mount's leaf must not be followed as a symlink. */
function mountPath(path: string): string {
  return join(realOrRaw(dirname(path)), basename(path));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * One snapshot of this user's live mount namespaces; undefined means unknown,
 * NOT an empty set. A departed pid is harmless; any other unreadable process
 * makes deletion unsafe -- except, per owner, an unreadable pid that STARTED
 * BEFORE that owner (see `LiveMounts.maxUnreadableTicks`). Don't mark a
 * namespace seen until its read succeeds: another pid in that namespace may
 * still be available after this one exits.
 */
export interface LiveMounts {
  readonly points: ReadonlySet<string>;
  /**
   * The newest start ticks among same-uid pids whose namespace or mountinfo was
   * refused (EACCES/EPERM): `-Infinity` when none was, `Infinity` when one of them
   * has no readable start ticks. A sandbox binds a placeholder only after it
   * exists, and it exists only after its owner started, so an unreadable pid
   * strictly older than a dead owner (same boot) cannot hold that owner's mounts.
   */
  readonly maxUnreadableTicks: number;
}

const REFUSED_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/** Start ticks of an unreadable pid; `Infinity` (blocks every owner) when they cannot be read. */
function unreadableTicks(pid: number): number {
  try {
    return _placeholderDeps.startTicks(pid);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function readLiveMountPoints(): LiveMounts | undefined {
  try {
    const points = new Set<string>();
    const namespaces = new Set<string>();
    const uid = _placeholderDeps.uid();
    const proc = _placeholderDeps.proc;
    let maxUnreadableTicks = Number.NEGATIVE_INFINITY;
    for (const pid of proc.listPids()) {
      try {
        if (proc.realUid(pid) !== uid) continue;
        try {
          const ns = proc.mountNs(pid);
          if (namespaces.has(ns)) continue;
          const text = proc.mountinfo(pid);
          for (const point of parseMountPoints(text)) points.add(mountPath(point));
          namespaces.add(ns);
        } catch (error) {
          const code = errorCode(error);
          if (code === undefined || !REFUSED_CODES.has(code)) throw error;
          maxUnreadableTicks = Math.max(maxUnreadableTicks, unreadableTicks(pid));
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") continue;
        throw error;
      }
    }
    return { points, maxUnreadableTicks };
  } catch (error) {
    getSafeLogger()?.debug("sandbox", "live placeholder mount set unknown", { error: errorMessage(error) });
    return undefined;
  }
}

/** Whether this snapshot proves no same-uid process we could not read can hold `owner`'s mounts. */
function usable(live: LiveMounts | undefined, owner: LedgerFile): live is LiveMounts {
  if (live === undefined) return false;
  if (live.maxUnreadableTicks === Number.NEGATIVE_INFINITY) return true;
  // Start ticks compare only within one boot.
  const sameBoot = owner.bootId === _placeholderDeps.bootId();
  return sameBoot && live.maxUnreadableTicks < owner.startTicks;
}

function ownerIsDead(file: LedgerFile): boolean {
  if (file.bootId !== _placeholderDeps.bootId() || !_placeholderDeps.isProcessAlive(file.pid)) return true;
  try {
    return _placeholderDeps.startTicks(file.pid) !== file.startTicks;
  } catch (error) {
    // Only ENOENT proves this owner left. Inconclusive reads mean alive.
    return errorCode(error) === "ENOENT";
  }
}

type IdentifiedEntry = LedgerEntry & PlaceholderIdentity;

function matchesDisk(entry: LedgerEntry): entry is IdentifiedEntry {
  const identity = placeholderIdentity(entry.path);
  return (
    identity !== undefined && identity.kind === entry.kind && identity.dev === entry.dev && identity.ino === entry.ino
  );
}

/**
 * Atomic, private rewrite of a ledger already trusted under its path lock.
 * Exclusive-create a unique temporary file, rather than following a predictable
 * temp name that could have been left as a symlink by another process.
 */
function persistLedger(path: string, file: LedgerFile, entries: readonly LedgerEntry[]): void {
  if (entries.length === 0) {
    unlinkSync(path);
    return;
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ ...file, entries }, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // A successful rename already removed the temporary name.
    }
  }
}

/** Drop changed identities; retain live mounts and failed removals for the next sweep. */
function removeUnmounted(
  candidates: readonly IdentifiedEntry[],
  mounts: ReadonlySet<string>,
  removed: string[],
): LedgerEntry[] {
  const kept: LedgerEntry[] = [];
  for (const entry of candidates) {
    if (mounts.has(mountPath(entry.path))) {
      kept.push(entry);
      continue;
    }
    try {
      // Intentionally synchronous: no intervening await before remove.
      if (!matchesDisk(entry)) continue;
      _placeholderDeps.remove(entry.path, entry.kind);
      removed.push(entry.path);
    } catch {
      // A failed removal stays recorded; continue with the next entry.
      kept.push(entry);
    }
  }
  return kept;
}

/** Sweep once at Linux backend initialization, sharing one lazy mount snapshot. */
export async function sweepStalePlaceholders(): Promise<void> {
  if (_placeholderDeps.platform() !== "linux") return;
  const dir = _placeholderDeps.ledgerDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const removed: string[] = [];
  let mountsRead = false;
  let loggedBlocked = false;
  let mounts: LiveMounts | undefined;

  for (const name of names) {
    if (!name.endsWith(".json") || name === `${process.pid}.json`) continue;
    const path = join(dir, name);
    try {
      const file = readLedgerFile(path);
      if (file === undefined || !ownerIsDead(file)) continue;
      await withPathFileLock(
        path,
        async () => {
          // Another sweep may have removed it while this one waited for the lock.
          const current = readLedgerFile(path);
          if (current === undefined) return;
          // And the owner may have changed: a live process can inherit the dead
          // owner's pid and write its own ledger at this path while this sweep
          // waits. Re-check against the record actually locked, or the sweep would
          // delete a live process's ledger — losing the provenance of placeholders
          // that process still owns — and, worse, act on its entries (B2).
          if (!ownerIsDead(current)) return;
          const candidates = current.entries.filter(matchesDisk);
          if (candidates.length > 0 && !mountsRead) {
            mountsRead = true;
            mounts = readLiveMountPoints();
          }
          // Unknown means leave ALL original bytes, including pending entries.
          if (candidates.length > 0 && !usable(mounts, current)) {
            if (mounts !== undefined && !loggedBlocked) {
              loggedBlocked = true;
              getSafeLogger()?.debug("sandbox", "live placeholder mount set unknown", {
                error: "a same-uid process not older than the ledger owner has an unreadable mount namespace",
              });
            }
            return;
          }
          persistLedger(path, current, removeUnmounted(candidates, mounts?.points ?? new Set(), removed));
        },
        { timeoutMs: _placeholderDeps.lockTimeoutMs },
      );
    } catch (error) {
      // Lock contention is expected: leave this ledger for a later initialize.
      if (errorCode(error) === "FILE_LOCK_TIMEOUT") continue;
      getSafeLogger()?.warn("sandbox", "placeholder ledger sweep failed", { file: path, error: errorMessage(error) });
    }
  }
  if (removed.length > 0) getSafeLogger()?.info("sandbox", "removed stale placeholders", { removed });
}
