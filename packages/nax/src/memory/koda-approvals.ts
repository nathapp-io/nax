/**
 * koda-approvals.ts — the durable record of the saves koda answered with a 202.
 *
 * A `202` save means koda opened an approval request and wrote no row. If the
 * request is executed the row arrives through the export feed and a later pull
 * replaces the mirror's pending note. If it is rejected nothing ever appears, so
 * the proposal's slug would stay `pending` in the mirror forever. The provider
 * therefore records each `202` save here, and the pull resolves the records
 * against koda's own approval status (US-008).
 *
 * Records for both scopes live in one file in the project mirror directory —
 * `<dir>/koda-approvals.json`, where `dir` is the host's `dirs.projectDir`:
 *
 *   { "version": 1, "approvals": [ { "approvalId": "apr_1", "scope": "project",
 *     "slug": "replay-budget", "clientId": "c_9" } ] }
 *
 * A record for a scope and slug that already has one replaces it, and takes the
 * new position: the replacement names a new approval request, so it is younger
 * than the record it replaces and must sort after it in the oldest-first
 * resolution budget. Records keep the order they were made in.
 *
 * `record` refuses an entry it could not read back — an empty `approvalId` or
 * `slug`, or a scope it does not know — and leaves the file exactly as it was,
 * warning once per refused entry. Writing it would make the whole file unusable,
 * and the next valid write would replace that file with only the new record,
 * losing every proposal it held.
 *
 * Writes go to a temporary file in the same directory and are renamed into
 * place, so a reader sees the old file or the new one (the `mcp-id-map.ts`
 * pattern). A file that is missing reads as no approvals without a word; one
 * that is not JSON, of another version, or not a version-1 approvals array reads
 * as no approvals and is logged at warn once per instance — the provider asks on
 * every pull, and the user needs to hear about it once. A read that fails for
 * any other reason — a permission error, an I/O error, a directory at the path —
 * is not an empty file: `record` and `drop` refuse with
 * `MEMORY_KODA_APPROVALS_READ_FAILED` and write nothing, because a file nax
 * could not read may hold records a write would drop. `list` still resolves no
 * approvals: it writes nothing, so it loses no record, and throwing would fail
 * every pull while the file stays unreadable.
 *
 * Not recovered (documented limits): a temporary file left behind by a failed
 * write — the seam has no `unlink` — and approvals lost between the `202`
 * answer and the write.
 *
 * Internal to `src/memory/`: the barrel re-exports it, US-005 records through it
 * and US-008 reads and drops through it.
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryScope } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { MemoryLogger } from "./paths";

const STAGE = "memory";

/** The approvals file name inside the mirror directory the host resolves. */
export const KODA_APPROVALS_FILE = "koda-approvals.json";
/** The only file version this module reads or writes. */
const KODA_APPROVALS_VERSION = 1;

/** The scopes a record may name. */
const KODA_APPROVAL_SCOPES = ["project", "user"] as const satisfies readonly MemoryScope[];

/** One save a `202` answered: the approval koda opened, and the note it was for. */
export interface KodaApproval {
  /** koda's id for the approval request. */
  readonly approvalId: string;
  /** The scope of the note the save was for. */
  readonly scope: MemoryScope;
  /** The slug of the note the save was for. */
  readonly slug: string;
  /** The id the save gave koda for the pending note; the mirror's note carries the same id. */
  readonly clientId: string;
}

/** The record of proposals koda has not answered yet. */
export interface KodaApprovals {
  /**
   * Every recorded proposal, oldest first; `[]` when the file is missing, unusable
   * or could not be read.
   */
  list(): Promise<readonly KodaApproval[]>;
  /**
   * Record a proposal, replacing the record of the same scope and slug; refuses an
   * unreadable entry.
   *
   * A file that could not be read rejects with `MEMORY_KODA_APPROVALS_READ_FAILED`
   * and is left as it was.
   */
  record(entry: KodaApproval): Promise<void>;
  /**
   * Forget the named proposals, keeping every other record.
   *
   * A file that could not be read rejects with `MEMORY_KODA_APPROVALS_READ_FAILED`
   * and is left as it was.
   */
  drop(approvalIds: readonly string[]): Promise<void>;
}

/**
 * Filesystem seam for tests: the read and the two calls of the atomic write.
 *
 * The read defaults to `Bun.file(...).text()` — a test drives the unusable paths
 * by writing the file it wants read, and the unreadable ones by making the read
 * fail.
 */
export const _kodaApprovalsDeps: {
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
  return KODA_APPROVAL_SCOPES.some((scope) => scope === value);
}

/**
 * A record read back from the file, or `undefined` when the entry is not one.
 *
 * `approvalId` and `slug` are the record's identity and the field a resolution
 * asks about, so neither may be empty; `clientId` may be, because it only has to
 * match the mirror's note.
 */
function approvalOf(value: unknown): KodaApproval | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<keyof KodaApproval, unknown>;
  if (typeof entry.approvalId !== "string" || entry.approvalId === "") return undefined;
  if (typeof entry.slug !== "string" || entry.slug === "") return undefined;
  if (typeof entry.clientId !== "string") return undefined;
  if (!isScope(entry.scope)) return undefined;
  return { approvalId: entry.approvalId, scope: entry.scope, slug: entry.slug, clientId: entry.clientId };
}

/** What a read found: usable records, no file at all, or a file that cannot be used. */
interface ApprovalsRead {
  readonly approvals: readonly KodaApproval[];
  readonly state: "valid" | "missing" | "unusable" | "unreadable";
  /** Why an unusable or unreadable file was not used, for the one warn it earns. */
  readonly reason?: string;
  /** The failure an unreadable file's read threw, for the refusal that names it. */
  readonly error?: unknown;
}

/**
 * The records of a parsed file, or the reason it is not a usable version-1 file.
 *
 * Every entry is read strictly: a record the module cannot read back exactly
 * would be a proposal no pull could ever resolve, so a file holding one is
 * treated as unusable rather than silently thinned to the entries that parsed.
 */
function approvalsOf(parsed: unknown): { readonly approvals: readonly KodaApproval[] } | { readonly reason: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { reason: "not an object" };
  const file = parsed as { version?: unknown; approvals?: unknown };
  if (file.version !== KODA_APPROVALS_VERSION) return { reason: `version ${String(file.version)}` };
  if (!Array.isArray(file.approvals)) return { reason: "approvals is not an array" };
  const approvals: KodaApproval[] = [];
  for (const entry of file.approvals) {
    const approval = approvalOf(entry);
    if (approval === undefined) return { reason: "an approvals entry is not a record" };
    approvals.push(approval);
  }
  return { approvals };
}

/** Read the file, treating every unusable answer as no approvals. */
async function readApprovals(path: string): Promise<ApprovalsRead> {
  let text: string;
  try {
    text = await _kodaApprovalsDeps.read(path);
  } catch (cause) {
    const missing = (cause as { code?: unknown } | null)?.code === "ENOENT";
    return missing
      ? { approvals: [], state: "missing", reason: errorMessage(cause) }
      : { approvals: [], state: "unreadable", reason: errorMessage(cause), error: cause };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    // Not JSON: reads as an empty record, rewritten by the next record or drop.
    return { approvals: [], state: "unusable", reason: errorMessage(cause) };
  }
  const read = approvalsOf(parsed);
  if ("reason" in read) return { approvals: [], state: "unusable", reason: read.reason };
  return { approvals: read.approvals, state: "valid" };
}

/** Write `approvals` to `path` through a same-directory temporary file. */
async function writeApprovals(path: string, approvals: readonly KodaApproval[]): Promise<void> {
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  const text = `${JSON.stringify({ version: KODA_APPROVALS_VERSION, approvals }, null, 2)}\n`;
  try {
    await _kodaApprovalsDeps.write(tmpPath, text);
    await _kodaApprovalsDeps.rename(tmpPath, path);
  } catch (cause) {
    throw new NaxError(
      `[memory] cannot write koda approvals ${path}: ${errorMessage(cause)}`,
      "MEMORY_KODA_APPROVALS_WRITE_FAILED",
      { stage: STAGE, path, cause },
    );
  }
}

/** Key of a record's identity: the scope and slug one approval request is open for. */
function proposalKey(scope: MemoryScope, slug: string): string {
  return `${scope}\u0000${slug}`;
}

/**
 * The refusal an unreadable file earns: the mutation writes nothing over a file
 * nax could not read, so the caller retries rather than losing the records the
 * file holds.
 */
function unreadableFile(path: string, read: ApprovalsRead): NaxError {
  const cause = read.error;
  return new NaxError(
    `[memory] cannot read koda approvals ${path}: ${errorMessage(cause)}`,
    "MEMORY_KODA_APPROVALS_READ_FAILED",
    { stage: STAGE, path, retryable: true, cause },
  );
}

/** `entry` replacing the record of the same scope and slug, kept in record order. */
function withRecorded(approvals: readonly KodaApproval[], entry: KodaApproval): readonly KodaApproval[] {
  const key = proposalKey(entry.scope, entry.slug);
  return [...approvals.filter((existing) => proposalKey(existing.scope, existing.slug) !== key), entry];
}

/**
 * Create the proposal record over one mirror directory.
 *
 * Read-modify-write sequences of one instance are serialised, so concurrent
 * `record` calls on it lose no records.
 *
 * @param input.dir - The project mirror directory both scopes' records live in
 * @param input.logger - Logger the unusable-file warn goes to, once per instance
 */
export function createKodaApprovals(input: { readonly dir: string; readonly logger: MemoryLogger }): KodaApprovals {
  const { dir, logger } = input;
  const path = join(dir, KODA_APPROVALS_FILE);
  let warnedUnusable = false;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * The file's records, warning about an unusable file at most once per instance.
   *
   * The caller asks on every pull and every save, so the same rejected file is
   * met again and again; the user wants to hear about it once. A missing file is
   * the ordinary first-run state and is not warned about. A file that could not
   * be read earns the same warn: it is the same fact for the user — the file
   * holds nothing nax can use.
   */
  async function read(): Promise<ApprovalsRead> {
    const read = await readApprovals(path);
    if ((read.state === "unusable" || read.state === "unreadable") && !warnedUnusable) {
      warnedUnusable = true;
      logger.warn(STAGE, "koda approvals file is unusable", { path, reason: read.reason });
    }
    return read;
  }

  /** Run `task` after every earlier mutation of this record has settled, whether it failed or not. */
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await queue;
      return (await read()).approvals;
    },
    record(entry) {
      return serialised(async () => {
        // The reader treats a file holding one entry it cannot read back as unusable, and the
        // next write replaces that file with only the new record — so an entry it would refuse
        // is not persisted at all, and the records already in the file survive untouched.
        const readable = approvalOf(entry);
        if (readable === undefined) {
          logger.warn(STAGE, "koda approval record is not storable", {
            path,
            scope: entry.scope,
            slug: entry.slug,
            approvalId: entry.approvalId,
          });
          return;
        }
        const file = await read();
        // A file that could not be read is not an empty file: writing over it would drop
        // every record it holds, so the record is refused and the caller retries.
        if (file.state === "unreadable") throw unreadableFile(path, file);
        await writeApprovals(path, withRecorded(file.approvals, readable));
      });
    },
    drop(approvalIds) {
      return serialised(async () => {
        const file = await read();
        if (file.state === "unreadable") throw unreadableFile(path, file);
        const { approvals, state } = file;
        // Nothing to forget in a missing file; an unusable one is rewritten for the records this drop keeps.
        if (state === "missing") return;
        const dropped = new Set(approvalIds);
        const kept = approvals.filter((entry) => !dropped.has(entry.approvalId));
        if (kept.length === approvals.length && state === "valid") return;
        await writeApprovals(path, kept);
      });
    },
  };
}
