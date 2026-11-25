/**
 * `nax memory mirrors` — the global mirror inventory, and the one flag that removes from it
 * (US-021).
 *
 * A memory mirror lives under `~/.nax/memory/projects`, one directory per repository, and until
 * now nothing in nax listed them: about fifteen leftovers from probe repositories sat there with
 * nothing in them, and the only way to find one was to look. This command is that listing, plus
 * `--prune` for the empties.
 *
 * It is the one `nax memory` subcommand that takes no `MemoryCliDeps`: the inventory belongs to the
 * machine, not to the repository the terminal happens to sit in, so it opens no config and no
 * memory host — only `memoryProjectsDir()` and `listMemoryMirrors`. That is also why its deps stand
 * alone rather than extending the group's.
 *
 * The listing is a row per mirror: what it holds, who it syncs with, how big its index is, and the
 * repository it says it belongs to. Two marks travel on a row — ` (missing)` on a recorded root that
 * is no longer on disk, and ` (in use)` on a mirror whose `sync.lock` exists. The second is the one
 * that decides anything: this process cannot tell a live lock from a stale one, so `--prune` treats
 * both as "in use" and leaves the mirror alone. A stale lock costs a listing row; removing a mirror
 * under a running sync loses notes.
 *
 * Whether a mirror may go is `isPrunableMirror`'s question, not this file's: it counts the six ways
 * a mirror can still hold something, including an archive and an outbox this read could not see all
 * of. `--prune` asks it and then removes only what it accepted, one directory at a time, printing
 * `Removed <name>` as each one goes.
 *
 * The listing is read before the question and the removals happen after it, so the mirror is asked
 * twice: each removal is taken under that mirror's own `sync.lock` — the file its saves, forgets,
 * approvals, syncs and compactions all contend on — and read again while the lock is held. A mirror
 * another writer owns is left alone ("another writer holds it"), as is one that gained a note while
 * the person was reading the question ("it is no longer empty"): the listing is a snapshot, and
 * deleting a directory on a snapshot is the one mistake a prune cannot take back.
 *
 * Asking follows `compact`'s rule exactly: `--yes` answers in advance, a TTY asks through the seam,
 * and no TTY without `--yes` aborts on stderr before the inventory is even read. A declined question
 * removes nothing and exits 1. Any throw is the group's error contract — `Error: <message>` on
 * stderr and exit 1.
 */
import { rm } from "node:fs/promises";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import {
  isPrunableMirror,
  listMemoryMirrors,
  lockMemoryMirror,
  type MemoryLogger,
  type MemoryMirrorInfo,
  memoryProjectsDir,
} from "@/memory";
import { promptForConfirmation } from "./confirm";

/** What a row says for a mirror that records no provider. */
const NO_PROVIDER = "none";
/** What a row says for a mirror that records no origin. */
const NO_ORIGIN = "unknown";
/** The mark a recorded root that is no longer on disk earns, after the root itself. */
const MISSING_SUFFIX = " (missing)";
/** The mark a mirror whose `sync.lock` exists earns, at the end of its row. */
const IN_USE_SUFFIX = " (in use)";
/** What separates a row's fields. */
const FIELD_GAP = "  ";
/** The line each removed mirror prints, before its name. */
const REMOVED_PREFIX = "Removed ";
/** What a prune with nothing to remove says. */
const NOTHING_TO_PRUNE = "Nothing to prune";
/** What a run nothing may be removed by says. */
const ABORTED = "Aborted";
/** What a mirror skipped during the removals says: it was in the listing, and it was not removed. */
const SKIPPED_PREFIX = "Skipped ";
/** Why a mirror was skipped: another writer owns it. */
const BUSY_REASON = "another writer holds it";
/** Why a mirror was skipped: it is not empty any more. */
const FILLED_REASON = "it is no longer empty";
/** The code a run that succeeded becomes. */
const OK_CODE = 0;
/** The code an abort, a refusal or a throw becomes. */
const FAILED_CODE = 1;

/**
 * The seam this subcommand's external calls go through: its two output channels, the terminal it
 * decides on, the answer it asks for, the global directory it lists, the two filesystem calls —
 * the inventory and the removal — and the mirror lock the removal is taken under.
 */
export interface MemoryMirrorsCliDeps {
  log(msg: string): void;
  logErr(msg: string): void;
  exit(code: number): void;
  isTTY(): boolean;
  confirm(question: string): Promise<boolean>;
  projectsDir(): string;
  listMemoryMirrors: typeof listMemoryMirrors;
  /**
   * Take the mirror's shared writer lock, or answer `null` when another writer holds it.
   *
   * Added by review round 1 (F1): the inventory is read before the question and the removal
   * happens after it, so the removal has to happen under the lock the mirror's own writers take.
   * The release's type is inline because biome's `useAwaitThenable` cannot infer through a
   * function-type alias re-exported from another package (see `@/memory`'s mirror-lock module).
   */
  lockMirror(dir: string): Promise<(() => Promise<void>) | null>;
  removeDir(dir: string): Promise<void>;
}

/** The real process, the real terminal, the real inventory, the real lock and the real removal. */
export const _memoryMirrorsCliDeps: MemoryMirrorsCliDeps = {
  log: (msg) => {
    console.log(msg);
  },
  logErr: (msg) => {
    console.error(msg);
  },
  exit: (code) => {
    process.exit(code);
  },
  isTTY: () => process.stdin.isTTY === true,
  confirm: promptForConfirmation,
  projectsDir: memoryProjectsDir,
  listMemoryMirrors,
  // The protocol reports a takeover and a failed release through a logger; on this command's
  // surface that is the same stderr every other `[memory]` line goes to.
  lockMirror: (dir) => lockMemoryMirror({ dir, logger: mirrorLockLogger((msg) => _memoryMirrorsCliDeps.logErr(msg)) }),
  removeDir: (dir) => rm(dir, { recursive: true, force: true }),
};

/**
 * The logger the lock protocol writes through: its `warn` and `error` lines are terminal lines,
 * its `info` and `debug` are the protocol's internals and are dropped.
 */
function mirrorLockLogger(write: (msg: string) => void): MemoryLogger {
  const line = (stage: string, message: string, data?: Record<string, unknown>): void => {
    write(`[${stage}] ${message}${data === undefined ? "" : `: ${JSON.stringify(data)}`}`);
  };
  return { warn: line, error: line, info: () => {}, debug: () => {} };
}

/** What `mirrors` takes: the one destructive flag, its confirmation, and the JSON switch. */
export interface MemoryMirrorsOptions {
  /** Remove every mirror holding nothing, after confirming. */
  readonly prune?: boolean;
  /** Remove without asking. */
  readonly yes?: boolean;
  /** Emit the inventory as one machine-readable document. */
  readonly json?: boolean;
}

/**
 * The origin a row names: the root it records, that root marked ` (missing)` when it is no longer
 * on disk, or `unknown` for a mirror no host has opened since origins were recorded.
 */
function originField(mirror: MemoryMirrorInfo): string {
  if (mirror.originRoot === null) return NO_ORIGIN;
  return mirror.rootExists === false ? `${mirror.originRoot}${MISSING_SUFFIX}` : mirror.originRoot;
}

/** One mirror as a terminal row: its name, the four counts, and the two marks that can follow. */
function mirrorLine(mirror: MemoryMirrorInfo): string {
  const row = [
    mirror.name,
    `notes ${mirror.notes}`,
    `outbox ${mirror.outbox}`,
    `provider ${mirror.provider ?? NO_PROVIDER}`,
    `index ${mirror.indexBytes} bytes`,
    `origin ${originField(mirror)}`,
  ].join(FIELD_GAP);
  return mirror.inUse ? `${row}${IN_USE_SUFFIX}` : row;
}

/** Write an inventory: one JSON array under `--json`, one row per mirror otherwise. */
function printInventory(mirrors: readonly MemoryMirrorInfo[], json: boolean, deps: MemoryMirrorsCliDeps): void {
  if (json) {
    deps.log(JSON.stringify(mirrors));
    return;
  }
  for (const mirror of mirrors) deps.log(mirrorLine(mirror));
}

/** The one question a prune asks, naming how many mirrors it would remove. */
function removeQuestion(count: number): string {
  return `Remove ${count} mirrors? [y/N]`;
}

/**
 * The mirror as it is now, or `null` when it is gone, with this run's own lock discounted.
 *
 * The lock this run holds is a file inside the mirror, so the inventory reports the mirror as
 * `inUse` — that is this process's lock, not another writer's, and the recheck is about what the
 * mirror *holds*. Everything else the inventory reads is left as it was found.
 */
async function readAgain(mirror: MemoryMirrorInfo, deps: MemoryMirrorsCliDeps): Promise<MemoryMirrorInfo | null> {
  const inventory = await deps.listMemoryMirrors(deps.projectsDir());
  const found = inventory.find((candidate) => candidate.dir === mirror.dir);
  return found === undefined ? null : { ...found, inUse: false };
}

/** What one guarded removal decided: it went, another writer owns it, or it is not empty now. */
type Removal = "removed" | "busy" | "filled";

/**
 * Remove one mirror, or leave it alone, under that mirror's own writer lock.
 *
 * The listing was read before the question and this runs after it, so the mirror is read a second
 * time with the lock held: what was empty may hold a note a session saved while the person was
 * reading the question, and deleting that directory is the one failure `--prune` cannot take back.
 * A mirror another writer holds is not waited for — a sync takes as long as its provider does —
 * and neither is one that is no longer empty: both are reported and left in place.
 *
 * The lock is handed back whatever happens, including a removal that throws; the caller's error
 * still reaches the group's contract.
 */
async function removeOne(mirror: MemoryMirrorInfo, deps: MemoryMirrorsCliDeps): Promise<Removal> {
  const release = await deps.lockMirror(mirror.dir);
  if (release === null) return "busy";
  try {
    const current = await readAgain(mirror, deps);
    if (current !== null && !isPrunableMirror(current)) return "filled";
    await deps.removeDir(mirror.dir);
    return "removed";
  } finally {
    await release();
  }
}

/** Remove each mirror in turn, naming each one as it goes and saying why any was left. */
async function removeAll(mirrors: readonly MemoryMirrorInfo[], deps: MemoryMirrorsCliDeps): Promise<void> {
  for (const mirror of mirrors) {
    const removal = await removeOne(mirror, deps);
    if (removal === "removed") {
      deps.log(`${REMOVED_PREFIX}${mirror.name}`);
      continue;
    }
    deps.logErr(`${SKIPPED_PREFIX}${mirror.name}: ${removal === "busy" ? BUSY_REASON : FILLED_REASON}`);
  }
}

/**
 * The confirmed removal: list what would go, ask (or not, under `--yes`), then remove it.
 *
 * The mirrors are listed before the question because the question is about them — the same order
 * `compact` prints its plan in — and every row here is one `isPrunableMirror` accepted.
 */
async function pruneMirrors(opts: MemoryMirrorsOptions, deps: MemoryMirrorsCliDeps): Promise<number> {
  const inventory = await deps.listMemoryMirrors(deps.projectsDir());
  const prunable = inventory.filter(isPrunableMirror);
  if (prunable.length === 0) {
    deps.log(NOTHING_TO_PRUNE);
    return OK_CODE;
  }
  printInventory(prunable, opts.json === true, deps);
  const confirmed = opts.yes === true || (await deps.confirm(removeQuestion(prunable.length)));
  if (!confirmed) {
    deps.logErr(ABORTED);
    return FAILED_CODE;
  }
  await removeAll(prunable, deps);
  return OK_CODE;
}

/**
 * `nax memory mirrors [--prune] [--yes] [--json]`: list the global mirrors, or remove the empty ones.
 *
 * The TTY check runs before the inventory is read, so a pipe or a CI job costs nothing but the
 * answer — the same gate `compact` puts in front of its model call. A throw from the inventory or
 * from one removal is the group's error contract: `Error: <message>` on stderr and exit 1, naming
 * what failed and leaving every mirror it had not reached in place.
 *
 * @param opts - `--prune`, `--yes` and `--json`
 * @param deps - The seam every external call goes through
 */
export async function memoryMirrorsCommand(
  opts: MemoryMirrorsOptions,
  deps: MemoryMirrorsCliDeps = _memoryMirrorsCliDeps,
): Promise<number> {
  try {
    if (opts.prune !== true) {
      printInventory(await deps.listMemoryMirrors(deps.projectsDir()), opts.json === true, deps);
      return OK_CODE;
    }
    if (opts.yes !== true && !deps.isTTY()) {
      deps.logErr(ABORTED);
      return FAILED_CODE;
    }
    return await pruneMirrors(opts, deps);
  } catch (error) {
    deps.logErr(`Error: ${errorMessage(error)}`);
    return FAILED_CODE;
  }
}

/**
 * Register `mirrors` on the `memory` group, after `undo` — last, because it is the only subcommand
 * that acts on every project's mirror rather than on this one's.
 */
export function registerMemoryMirrorsCommand(
  memory: Command,
  deps: MemoryMirrorsCliDeps = _memoryMirrorsCliDeps,
): Command {
  memory
    .command("mirrors")
    .description("List the global memory mirrors, and remove the ones holding nothing")
    .option("--prune", "Remove every mirror holding nothing, after confirmation", false)
    .option("--yes", "Remove without asking", false)
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryMirrorsOptions) => {
      deps.exit(await memoryMirrorsCommand(opts, deps));
    });
  return memory;
}
