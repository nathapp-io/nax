/**
 * Durable store for remembered approvals (P2 design section 6.6).
 *
 * A remembered approval is a CACHED HUMAN DECISION, not a rule. Lookup is
 * BYTE-EXACT on (stage, command) with no normalization of any kind -- not
 * trimming, not whitespace collapsing, not quote folding. Any normalization is
 * a place where the string that was approved and the string that runs can
 * diverge, and the whole value of the cache is that they cannot.
 *
 * Synthesizing a `Bash(...)` rule instead would be materially broader than what
 * the operator approved: rule matching is a token-wise PREFIX match with no
 * length ceiling (src/tools/policy-bash.ts:72-83), so a rule made from
 * `bun run test` would also grant `bun run test --reporter=./x`.
 *
 * The file may also carry a `taint` marker (#2199) -- see approvals-taint.ts.
 *
 * Revocation goes through `src/cli/approvals.ts`, the surface D20 relies on:
 * `removeApprovals` here is the locked, taint-preserving read-decide-write
 * primitive that surface calls into.
 */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withPathFileLock } from "../utils/path-file-lock";

export interface ApprovalEntry {
  readonly stage: string;
  readonly command: string;
  readonly root: string;
  readonly origin: "escalate" | "askRule";
  readonly matchedRule: string | null;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly naxCommit: string;
}

/**
 * Written by nax itself when a FORGE-CAPABLE run uses the store (#2199): every
 * entry beside it is untrusted, and the next run that trusts the cache
 * discards them. See approvals-taint.ts for the trust argument.
 */
export interface ApprovalsTaint {
  readonly since: string;
  readonly runId: string;
  /** The tainting nax process; `undefined` when absent or malformed on disk. */
  readonly pid: number | undefined;
}

export interface ApprovalsFile {
  readonly entries: readonly ApprovalEntry[];
  readonly taint: ApprovalsTaint | undefined;
}

const EMPTY_FILE: ApprovalsFile = { entries: [], taint: undefined };

/**
 * The classification a `readApprovalsFileDetailed` call reports. `missing` is a
 * path that resolves to no file at all (ENOENT, or a parent dir that does not
 * exist); `unparseable` is a file whose contents the read could not turn into
 * the entries+taint shape the cache needs; `ok` is a file the read accepts.
 */
export type ApprovalsFileState = "ok" | "missing" | "unparseable";

/**
 * What `readApprovalsFileDetailed` returns: the same `ApprovalsFile` shape
 * `readApprovalsFile` always has, plus a classification and the count of array
 * elements the read dropped for not being approval entries. `droppedMalformed`
 * is `0` unless `state === "ok"` -- an unparseable file has no entries to
 * drop, and a missing file has no file at all.
 */
export interface ApprovalsFileRead {
  readonly file: ApprovalsFile;
  readonly state: ApprovalsFileState;
  readonly droppedMalformed: number;
}

/**
 * The run's output dir, NOT the tool root. `root` is storyExecRoot -- the repo
 * OR WORKTREE root -- so a root-relative file is deleted by the
 * `git worktree remove --force` that ends the run. That is the exact defect
 * recorded in toolAuditDir's docblock (src/config/paths/index.ts:138-150).
 */
export function approvalsPath(outputDir: string): string {
  return join(outputDir, "approvals.json");
}

/**
 * The shape findApproval relies on. A malformed element (null, a string, an
 * object missing `stage`/`command`) is DROPPED rather than returned: an
 * unvalidated array makes `findApproval`'s `e.stage` throw, and a poisoned
 * cache read would fail the whole ask chain instead of just this entry.
 */
function isApprovalEntry(value: unknown): value is ApprovalEntry {
  if (typeof value !== "object" || value === null) return false;
  if (!("stage" in value) || !("command" in value)) return false;
  return typeof value.stage === "string" && typeof value.command === "string";
}

/**
 * ANY present `taint` value taints, however malformed: the marker exists to
 * withhold trust, so an unparseable one must not grant it.
 */
function parseTaint(value: unknown): ApprovalsTaint | undefined {
  if (value === undefined || value === null) return undefined;
  const raw: Record<string, unknown> = typeof value === "object" ? { ...value } : {};
  return {
    since: typeof raw.since === "string" ? raw.since : "",
    runId: typeof raw.runId === "string" ? raw.runId : "",
    pid: typeof raw.pid === "number" && Number.isInteger(raw.pid) ? raw.pid : undefined,
  };
}

/**
 * Stable, derived id for an entry. The id is a function of (stage, command,
 * approvedAt) alone -- NOT of the entry's position in the file, or of any
 * sibling entry -- so it survives other entries being added or removed and
 * two entries recorded for the same triple share an id and are removed
 * together (US-001).
 *
 * Computed on every read and never stored. A missing or non-string
 * `approvedAt` reads as the empty string so the id is still a well-defined
 * 8-character hex value for the malformed-on-disk entries the cache admits.
 */
export function approvalId(entry: ApprovalEntry): string {
  const approvedAt = typeof entry.approvedAt === "string" ? entry.approvedAt : "";
  const digest = createHash("sha256");
  digest.update(`${entry.stage}\0${entry.command}\0${approvedAt}`);
  return digest.digest("hex").slice(0, 8);
}

/**
 * Classify a store read. `missing` means the file is absent (or its parent
 * directory is); `unparseable` means a file is present but its contents are
 * not a `{ entries, taint }` object the cache can trust; `ok` means the read
 * accepted the file and `file.entries` lists every element `isApprovalEntry`
 * accepted, with `droppedMalformed` counting the rejections.
 *
 * A present `taint` is still parsed when the rest of the file is unparseable:
 * a forged `entries` array must not strip the marker.
 *
 * A read failure (EACCES/EIO) is not a parse failure and is not classified
 * here — it propagates so a caller that must surface it (the `nax approvals`
 * CLI) can report it instead of mislabelling it `unparseable`. Callers that
 * must stay fail-closed use `readApprovalsFile`, which catches it.
 */
export async function readApprovalsFileDetailed(path: string): Promise<ApprovalsFileRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { state: "missing", file: EMPTY_FILE, droppedMalformed: 0 };
  }
  const contents = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { state: "unparseable", file: EMPTY_FILE, droppedMalformed: 0 };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unparseable", file: EMPTY_FILE, droppedMalformed: 0 };
  }
  const { entries, taint } = parsed as { entries?: unknown; taint?: unknown };
  if ("entries" in parsed && !Array.isArray(entries)) {
    return { state: "unparseable", file: { entries: [], taint: parseTaint(taint) }, droppedMalformed: 0 };
  }
  const array = Array.isArray(entries) ? entries : [];
  const kept: ApprovalEntry[] = [];
  let dropped = 0;
  for (const element of array) {
    if (isApprovalEntry(element)) {
      kept.push(element);
    } else {
      dropped += 1;
    }
  }
  return { state: "ok", file: { entries: kept, taint: parseTaint(taint) }, droppedMalformed: dropped };
}

/**
 * Missing, malformed OR unreadable reads as empty: the CACHE fails, the chain
 * does not. A permissions/IO error is caught here (rather than propagating
 * from `readApprovalsFileDetailed`) so it cannot abort an approval lookup; a
 * caller that must distinguish it calls the detailed read directly.
 */
export async function readApprovalsFile(path: string): Promise<ApprovalsFile> {
  try {
    return (await readApprovalsFileDetailed(path)).file;
  } catch {
    return EMPTY_FILE;
  }
}

export async function readApprovals(path: string): Promise<readonly ApprovalEntry[]> {
  return (await readApprovalsFile(path)).entries;
}

/** Serialize the whole store. Callers hold the path lock. */
export async function writeApprovalsFile(path: string, file: ApprovalsFile): Promise<void> {
  const body = file.taint === undefined ? { entries: file.entries } : { taint: file.taint, entries: file.entries };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * Lock the read-modify-write. Worktree-isolated parallel stories share one
 * project-scoped file BY DESIGN (that is why `root` is not part of the key), so
 * two "Allow + remember" taps can race and drop one. `withPathFileLock` is the
 * shared primitive for exactly this shape; it fails closed on timeout rather
 * than entering over a possible holder.
 *
 * The taint marker is PRESERVED: a "remember" tapped during a forge-capable run
 * lands in a store that stays untrusted.
 */
export async function appendApproval(path: string, entry: ApprovalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withPathFileLock(path, async () => {
    const existing = await readApprovalsFile(path);
    await writeApprovalsFile(path, { taint: existing.taint, entries: [...existing.entries, entry] });
  });
}

/**
 * The decision `removeApprovals` asks the caller for, once the read has
 * classified the file. The caller picks which entries to drop with `remove` --
 * a predicate over the kept entries from the read -- or refuses the operation
 * with `refuse`. The two arms are mutually exclusive: a single decision is
 * either "remove these" or "I will not act, because: ...".
 */
export type RemovalDecision = { readonly remove: (entry: ApprovalEntry) => boolean } | { readonly refuse: string };

/**
 * What `removeApprovals` reports back. `refused` covers both the file being
 * unparseable (so the read refuses the call to `decide`) and the caller's own
 * `refuse` decision: the caller cannot distinguish the two from the result
 * alone, only from the message. `removed` reports exactly the entries the
 * caller chose to drop plus the count of malformed array elements the read
 * dropped for being non-entries. `unchanged` is returned for both a missing
 * file and a present file whose predicate selected nothing.
 */
export type RemovalResult =
  | { readonly outcome: "removed"; readonly removed: readonly ApprovalEntry[]; readonly droppedMalformed: number }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * The locked read-decide-write body shared by the two `removeApprovals` arms.
 * Pure read -> guard -> decide -> filter -> write: no mkdir, no lock handling.
 */
async function applyRemoval(
  path: string,
  decide: (read: ApprovalsFileRead) => RemovalDecision,
): Promise<RemovalResult> {
  const read = await readApprovalsFileDetailed(path);
  if (read.state === "unparseable") {
    return { outcome: "refused", reason: "approvals.json could not be parsed; not rewriting it" };
  }
  const decision = decide(read);
  if ("refuse" in decision) {
    return { outcome: "refused", reason: decision.refuse };
  }
  const removed: ApprovalEntry[] = [];
  const kept: ApprovalEntry[] = [];
  for (const entry of read.file.entries) {
    if (decision.remove(entry)) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  if (removed.length === 0) {
    return { outcome: "unchanged" };
  }
  await writeApprovalsFile(path, { taint: read.file.taint, entries: kept });
  return { outcome: "removed", removed, droppedMalformed: read.droppedMalformed };
}

/** `true` iff `dir` exists and is a directory (symlinks followed). */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locked, taint-preserving removal. Holds the same path-scoped lock
 * `appendApproval` holds, so a removal racing an append cannot drop one of the
 * two writes; whichever runs first inside the lock, the other sees the
 * post-write state on its next read.
 *
 * The order of the guards matters and is documented in the story:
 *   1. `state === "unparseable"` -> `refused`, no `decide` call, no write.
 *      Rewriting would erase whatever the file holds, including a taint
 *      marker we did not write.
 *   2. `decide(read)` returns `{ refuse }` -> `refused`, no write.
 *   3. The predicate selected no entry (or the file was missing) ->
 *      `unchanged`, no write, and neither the data file nor its parent
 *      directory is created.
 *   4. Otherwise write `{ taint: read.file.taint, entries: kept }` with the
 *      SAME taint that was read. Nothing in this function clears a taint;
 *      only `clearApprovalsTaint` (approvals-taint.ts) does, and only from a
 *      trusted run.
 *
 * The lock file must live next to the target, so the lock is only taken when
 * that parent directory already exists. A path whose parent is missing is by
 * definition a missing store: the read-decide path runs without the lock and
 * creates nothing -- taking the lock there would require `mkdir`, which rule 3
 * forbids. `decide` is still invoked exactly once in that arm, so the missing
 * read reaches the caller as it does under the lock.
 */
export async function removeApprovals(
  path: string,
  decide: (read: ApprovalsFileRead) => RemovalDecision,
): Promise<RemovalResult> {
  if (!(await directoryExists(dirname(path)))) {
    return applyRemoval(path, decide);
  }
  return withPathFileLock(path, () => applyRemoval(path, decide));
}

/**
 * BYTE-EXACT. No normalization. See the module docblock.
 *
 * `projectRoot`, when given, also requires the entry's `root` to be that root
 * or lie inside it. Worktrees (`<projectRoot>/.nax-wt/<id>`) and monorepo
 * package dirs both do, so parallel stories still share entries. This is
 * HYGIENE, not authentication: it drops entries another project wrote into a
 * shared outputDir, but a forger can write any `root` it likes (#2199).
 */
export function findApproval(
  entries: readonly ApprovalEntry[],
  stage: string,
  command: string,
  projectRoot?: string,
): ApprovalEntry | undefined {
  return entries.find(
    (e) => e.stage === stage && e.command === command && (projectRoot === undefined || isWithin(projectRoot, e.root)),
  );
}

function isWithin(projectRoot: string, root: unknown): boolean {
  if (typeof root !== "string" || root === "") return false;
  const rel = relative(resolve(projectRoot), resolve(root));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
