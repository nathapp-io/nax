/**
 * The shared harness behind the two `nax memory mirrors` test files.
 *
 * `memory-mirrors.test.ts` owns the listing, the machine-readable document, the confirmation gate
 * and the removal under the mirror's lock; `memory-mirrors-recheck.test.ts` owns the second read
 * that decides whether a removal may happen at all. Both drive the same command through the same
 * stub of every external call, so the stub — one inventory, one projects directory, one lock, one
 * removal, and the recording of what each was asked — lives here rather than being spelled twice.
 */
import { join } from "node:path";
import { type MemoryMirrorsCliDeps, type MemoryMirrorsOptions, memoryMirrorsCommand } from "@/cli";
import type { MemoryMirrorInfo, MemoryMirrorRead } from "@/memory";

/** The global projects directory every stubbed case lists. */
export const PROJECTS_DIR = "/global/nax/memory/projects";

/** A mirror nothing has opened since the feature shipped: no origin, no sync, no content. */
export const PROBE_MIRROR: MemoryMirrorInfo = {
  dir: join(PROJECTS_DIR, "probe-89abcdef"),
  name: "probe-89abcdef",
  notes: 0,
  outbox: 0,
  provider: null,
  originRoot: null,
  rootExists: null,
  indexBytes: 0,
  inUse: false,
  hasArchive: false,
  decisions: 0,
  pendingForgets: 0,
  unreadable: [],
};

/** An empty mirror whose own name is the only difference from {@link PROBE_MIRROR}. */
export function emptyMirror(name: string): MemoryMirrorInfo {
  return { ...PROBE_MIRROR, dir: join(PROJECTS_DIR, name), name };
}

/** {@link PROBE_MIRROR} with the fields a case varies over. */
export function probe(overrides: Partial<MemoryMirrorInfo>): MemoryMirrorInfo {
  return { ...PROBE_MIRROR, ...overrides };
}

/** What one case varies. Absent means the harness default, never a different shape. */
export interface MirrorsFixture {
  /** The inventory `listMemoryMirrors` answers; {@link PROBE_MIRROR} alone by default. */
  readonly mirrors?: readonly MemoryMirrorInfo[];
  /** Whether the terminal is interactive; `true` by default, so the question is reachable. */
  readonly isTTY?: boolean;
  /** What `deps.confirm` answers; `true` by default. */
  readonly confirmAnswer?: boolean;
  /** Asks the question through this seam instead of the recording stub (the real prompt). */
  readonly confirm?: MemoryMirrorsCliDeps["confirm"];
  /**
   * What the recheck answers for one mirror — the mirror as it is now, a directory that went, or
   * one this process could not read. Absent means the listing's own entry, read again.
   */
  readonly recheck?: (dir: string) => MemoryMirrorRead;
  /** Directories another writer holds, so `lockMirror` answers `null` for them. */
  readonly heldByOther?: readonly string[];
  /** Rejects the removal of this directory, as an unwritable filesystem would. */
  readonly removeRejects?: string;
}

/** Everything a case measures: both channels, every seam the run reached, and the order of them. */
export interface MirrorsHarness {
  readonly deps: MemoryMirrorsCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`. */
  readonly codes: number[];
  /** Every directory handed to `removeDir`, in the order it was removed. */
  readonly removed: string[];
  /** Every question that reached `deps.confirm`. */
  readonly asks: string[];
  /** Every directory `listMemoryMirrors` was asked for. */
  readonly listed: string[];
  /** Every directory `readMirror` was asked for, in the order it was asked. */
  readonly reread: string[];
  /** Every directory `lockMirror` was asked to lock, in the order it was asked. */
  readonly locked: string[];
  /** Every directory whose lock was handed back. */
  readonly released: string[];
  /** Every line written and every question asked, in the order it happened. */
  readonly events: string[];
}

/** The CLI with every external call stubbed: one inventory, one projects directory, no filesystem. */
export function makeMirrorsHarness(fixture: MirrorsFixture = {}): MirrorsHarness {
  const mirrors = fixture.mirrors ?? [PROBE_MIRROR];
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const removed: string[] = [];
  const asks: string[] = [];
  const listed: string[] = [];
  const reread: string[] = [];
  const locked: string[] = [];
  const released: string[] = [];
  const events: string[] = [];
  const deps: MemoryMirrorsCliDeps = {
    log: (msg) => {
      out.push(msg);
      events.push(`out:${msg}`);
    },
    logErr: (msg) => {
      err.push(msg);
      events.push(`err:${msg}`);
    },
    exit: (code) => codes.push(code),
    isTTY: () => fixture.isTTY ?? true,
    confirm:
      fixture.confirm ??
      (async (question) => {
        asks.push(question);
        events.push(`ask:${question}`);
        return fixture.confirmAnswer ?? true;
      }),
    projectsDir: () => PROJECTS_DIR,
    listMemoryMirrors: async (dir) => {
      listed.push(dir);
      return mirrors;
    },
    readMirror: async (dir) => {
      reread.push(dir);
      events.push(`read:${dir}`);
      if (fixture.recheck !== undefined) return fixture.recheck(dir);
      const found = mirrors.find((mirror) => mirror.dir === dir);
      // A directory the listing does not hold is not there: the default recheck reads the same
      // world the listing did.
      return found === undefined ? { kind: "absent" } : { kind: "read", mirror: found };
    },
    lockMirror: async (dir) => {
      locked.push(dir);
      events.push(`lock:${dir}`);
      if (fixture.heldByOther?.includes(dir) === true) return null;
      return async () => {
        released.push(dir);
        events.push(`release:${dir}`);
      };
    },
    removeDir: async (dir) => {
      if (fixture.removeRejects === dir) throw new Error(`EACCES: ${dir}`);
      removed.push(dir);
      events.push(`removed:${dir}`);
    },
  };
  return { deps, out, err, codes, removed, asks, listed, reread, locked, released, events };
}

/** `nax memory mirrors` with the given flags. */
export function runMirrors(h: MirrorsHarness, opts: Partial<MemoryMirrorsOptions> = {}): Promise<number> {
  return memoryMirrorsCommand({ ...opts }, h.deps);
}
