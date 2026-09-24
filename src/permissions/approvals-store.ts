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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Missing or malformed reads as empty: the CACHE fails, the chain does not. */
export async function readApprovalsFile(path: string): Promise<ApprovalsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_FILE;
    const { entries, taint } = parsed as { entries?: unknown; taint?: unknown };
    return {
      entries: Array.isArray(entries) ? entries.filter(isApprovalEntry) : [],
      taint: parseTaint(taint),
    };
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
