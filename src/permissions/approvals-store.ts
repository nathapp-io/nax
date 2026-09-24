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
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
 */
export async function readApprovalsFileDetailed(path: string): Promise<ApprovalsFileRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { state: "missing", file: EMPTY_FILE, droppedMalformed: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
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

/** Missing or malformed reads as empty: the CACHE fails, the chain does not. */
export async function readApprovalsFile(path: string): Promise<ApprovalsFile> {
  return (await readApprovalsFileDetailed(path)).file;
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
