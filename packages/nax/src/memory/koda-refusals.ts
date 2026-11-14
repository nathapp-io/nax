/**
 * koda-refusals.ts — the bounded, lenient report of the proposals koda refused.
 *
 * A refused save or forget is a settled fact the user never hears about otherwise:
 * the mirror's note is put back (a save) or confirmed still there (a forget), and
 * the approval record is dropped. Nothing in the mirror remembers what was
 * proposed and turned down. This module keeps that as a report in the project
 * mirror directory, beside `koda-approvals.json`:
 *
 *   { "version": 1, "refusals": [ { "approvalId": "apr_1", "kind": "forget",
 *     "scope": "project", "slug": "proposed-rule", "status": "rejected",
 *     "refusedAt": "2026-11-14T05:00:00.000Z" } ] }
 *
 * Nothing resolves from it, so its failure handling is lenient where
 * `koda-approvals.ts` refuses: a file that is not a version-1 refusals file, or
 * cannot be read, reads as no refusals with one warn per instance and the next
 * `record` overwrites it; a failed write warns and never throws, and the caller —
 * a pull that still has approvals to drop — carries on.
 *
 * The log is bounded so it cannot grow without limit: entries expire after
 * `KODA_REFUSAL_REPORT_MS` (7 days) and at most `KODA_REFUSALS_MAX` (20) are kept,
 * the newest. `record` dedupes by `approvalId`, so a pull that resolves the same
 * refusal again after a failed drop adds nothing.
 *
 * Writes go to a temporary file in the same directory and are renamed into place,
 * so a reader always sees the old file or the new one (the `koda-approvals.ts`
 * pattern). Not recovered (documented limits): a temporary file left behind by a
 * failed write — the seam has no `unlink`.
 *
 * Internal to `src/memory/`: the barrel re-exports it, the pull records through it
 * (US-003) and status reads it (US-004).
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryScope } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { MemoryLogger } from "./paths";

const STAGE = "memory";

/** The refusals file name inside the mirror directory the host resolves. */
export const KODA_REFUSALS_FILE = "koda-refusals.json";
/** The only file version this module reads or writes. */
const KODA_REFUSALS_VERSION = 1;
/** How many refusals the log keeps: the newest this many, oldest dropped first. */
export const KODA_REFUSALS_MAX = 20;

/** Milliseconds in a day, as the report window is spelled in days. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a refusal stays in the report: old news the user no longer needs. */
export const KODA_REFUSAL_REPORT_MS = 7 * DAY_MS;

/** The scopes a refusal may name. */
const KODA_REFUSAL_SCOPES = ["project", "user"] as const satisfies readonly MemoryScope[];

/** The statuses that refused a proposal: the words a logged refusal may carry. */
const KODA_REFUSAL_STATUSES = ["rejected", "expired", "cancelled", "failed"] as const;

/** One proposal koda refused: the write, the note, and koda's own word for the answer. */
export interface KodaRefusal {
  /** koda's id for the approval request that was refused. */
  readonly approvalId: string;
  /** The write that was refused: a save or a forget. */
  readonly kind: "save" | "forget";
  /** The scope of the note the write was for. */
  readonly scope: MemoryScope;
  /** The slug of the note the write was for. */
  readonly slug: string;
  /** koda's status word for the refusal: one of `APPROVAL_REFUSED_STATUSES`. */
  readonly status: (typeof KODA_REFUSAL_STATUSES)[number];
  /** The ISO instant the pull logged the refusal. */
  readonly refusedAt: string;
}

/** A refusal as status presents it: the log's entry less koda's approval id. */
export type MemoryKodaRefusal = Omit<KodaRefusal, "approvalId">;

/** The report of proposals koda refused. */
export interface KodaRefusals {
  /** The logged refusals still inside the report window, oldest first; `[]` when unusable. */
  list(): Promise<readonly KodaRefusal[]>;
  /**
   * Log refusals, stamped now, after the ones already logged.
   *
   * An `approvalId` already in the file, or repeated earlier in the same call, is
   * dropped: the existing entry and its `refusedAt` stay. Never throws — a write
   * that fails is warned about and the refusals are lost.
   */
  record(entries: readonly Omit<KodaRefusal, "refusedAt">[]): Promise<void>;
}

/**
 * Filesystem seam for tests: the read and the two calls of the atomic write.
 *
 * The read defaults to `Bun.file(...).text()` — a test drives the unusable paths
 * by writing the file it wants read, and the unreadable ones by making the read
 * fail.
 */
export const _kodaRefusalsDeps: {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
} = {
  read: (path: string): Promise<string> => Bun.file(path).text(),
  write: async (path: string, text: string): Promise<void> => {
    await Bun.write(path, text);
  },
  rename: (from: string, to: string): Promise<void> => rename(from, to),
};

function isScope(value: unknown): value is MemoryScope {
  return KODA_REFUSAL_SCOPES.some((scope) => scope === value);
}

function isStatus(value: unknown): value is KodaRefusal["status"] {
  return KODA_REFUSAL_STATUSES.some((status) => status === value);
}

/** Whether `value` is an ISO instant the expiry comparison can use. */
function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * A refusal read back from the file, or `undefined` when the entry is not one.
 *
 * Every field is required and read strictly: a logged refusal is a whole fact or
 * nothing, so an entry missing one — a `kind`, say — makes the file unusable rather
 * than being repaired into a different record.
 */
function refusalOf(value: unknown): KodaRefusal | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<keyof KodaRefusal, unknown>;
  if (typeof entry.approvalId !== "string" || entry.approvalId === "") return undefined;
  if (entry.kind !== "save" && entry.kind !== "forget") return undefined;
  if (!isScope(entry.scope)) return undefined;
  if (typeof entry.slug !== "string" || entry.slug === "") return undefined;
  if (!isStatus(entry.status)) return undefined;
  if (!isInstant(entry.refusedAt)) return undefined;
  return {
    approvalId: entry.approvalId,
    kind: entry.kind,
    scope: entry.scope,
    slug: entry.slug,
    status: entry.status,
    refusedAt: entry.refusedAt,
  };
}

/** What a read found: usable refusals, no file at all, or a file that cannot be used. */
interface RefusalsRead {
  readonly refusals: readonly KodaRefusal[];
  readonly state: "valid" | "missing" | "unusable" | "unreadable";
  /** Why an unusable or unreadable file was not used, for the one warn it earns. */
  readonly reason?: string;
}

/**
 * The refused entries of a parsed file, or the reason it is not a usable version-1 file.
 *
 * Read strictly: a file holding one entry the module cannot read back is unusable
 * as a whole, rather than silently thinned to the entries that parsed.
 */
function refusalsOf(parsed: unknown): { readonly refusals: readonly KodaRefusal[] } | { readonly reason: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { reason: "not an object" };
  const file = parsed as { version?: unknown; refusals?: unknown };
  if (file.version !== KODA_REFUSALS_VERSION) return { reason: `version ${String(file.version)}` };
  if (!Array.isArray(file.refusals)) return { reason: "refusals is not an array" };
  const refusals: KodaRefusal[] = [];
  for (const entry of file.refusals) {
    const refusal = refusalOf(entry);
    if (refusal === undefined) return { reason: "a refusals entry is not a record" };
    refusals.push(refusal);
  }
  return { refusals };
}

/** Read the file, treating every unusable answer as no refusals. */
async function readRefusals(path: string): Promise<RefusalsRead> {
  let text: string;
  try {
    text = await _kodaRefusalsDeps.read(path);
  } catch (cause) {
    const missing = (cause as { code?: unknown } | null)?.code === "ENOENT";
    return missing
      ? { refusals: [], state: "missing" }
      : { refusals: [], state: "unreadable", reason: errorMessage(cause) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    // Not JSON: reads as no refusals, overwritten by the next record.
    return { refusals: [], state: "unusable", reason: errorMessage(cause) };
  }
  const read = refusalsOf(parsed);
  if ("reason" in read) return { refusals: [], state: "unusable", reason: read.reason };
  return { refusals: read.refusals, state: "valid" };
}

/** Write `refusals` to `path` through a same-directory temporary file, replacing any file there. */
async function writeRefusals(path: string, refusals: readonly KodaRefusal[]): Promise<void> {
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  const text = `${JSON.stringify({ version: KODA_REFUSALS_VERSION, refusals }, null, 2)}\n`;
  await _kodaRefusalsDeps.write(tmpPath, text);
  await _kodaRefusalsDeps.rename(tmpPath, path);
}

/** Whether `refusedAt` is inside the report window ending at `at`. */
function withinReport(refusedAt: string, at: Date): boolean {
  return at.getTime() - Date.parse(refusedAt) <= KODA_REFUSAL_REPORT_MS;
}

/**
 * The incoming entries whose `approvalId` is neither in `existing` nor repeated earlier in
 * the call, in the order they were given.
 */
function withoutDuplicates(
  entries: readonly Omit<KodaRefusal, "refusedAt">[],
  existing: readonly KodaRefusal[],
): readonly Omit<KodaRefusal, "refusedAt">[] {
  const seen = new Set(existing.map((entry) => entry.approvalId));
  const fresh: Omit<KodaRefusal, "refusedAt">[] = [];
  for (const entry of entries) {
    if (seen.has(entry.approvalId)) continue;
    seen.add(entry.approvalId);
    fresh.push(entry);
  }
  return fresh;
}

/**
 * Create the refusal report over one mirror directory.
 *
 * Read-modify-write sequences of one instance are serialised, so concurrent
 * `record` calls on it lose no refusals.
 *
 * @param input.dir - The project mirror directory the log lives in
 * @param input.logger - Logger the unusable-file and failed-write warns go to
 * @param input.now - Clock, defaulting to `() => new Date()`; the expiry and the
 *   `refusedAt` stamp are both taken from it
 */
export function createKodaRefusals(input: {
  readonly dir: string;
  readonly logger: MemoryLogger;
  readonly now?: () => Date;
}): KodaRefusals {
  const { dir, logger } = input;
  const now = input.now ?? (() => new Date());
  const path = join(dir, KODA_REFUSALS_FILE);
  let warnedUnusable = false;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * The file's entries, warning about an unusable or unreadable file at most once per
   * instance: the pull asks on every run, and the user needs to hear about it once.
   */
  async function read(): Promise<RefusalsRead> {
    const file = await readRefusals(path);
    if ((file.state === "unusable" || file.state === "unreadable") && !warnedUnusable) {
      warnedUnusable = true;
      logger.warn(STAGE, "koda refusals file is unusable", { path, reason: file.reason });
    }
    return file;
  }

  /** Run `task` after every earlier mutation of this report has settled, whether it failed or not. */
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await queue;
      const at = now();
      return (await read()).refusals.filter((entry) => withinReport(entry.refusedAt, at));
    },
    record(entries) {
      // Nothing to log: the file is left exactly as it is, not even rewritten.
      if (entries.length === 0) return Promise.resolve();
      return serialised(async () => {
        const file = await read();
        const at = now();
        const stamped = withoutDuplicates(entries, file.refusals).map((entry) => ({
          ...entry,
          refusedAt: at.toISOString(),
        }));
        const kept = [...file.refusals, ...stamped]
          .filter((entry) => withinReport(entry.refusedAt, at))
          .slice(-KODA_REFUSALS_MAX);
        try {
          await writeRefusals(path, kept);
        } catch (cause) {
          // A report, not a record anything resolves from: the pull carries on and still drops
          // the approvals. The refusals are lost, and that is the whole cost.
          logger.warn(STAGE, "koda refusals were not recorded", { path, error: errorMessage(cause) });
        }
      });
    },
  };
}
