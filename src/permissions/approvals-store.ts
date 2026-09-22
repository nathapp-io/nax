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
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * The run's output dir, NOT the tool root. `root` is storyExecRoot -- the repo
 * OR WORKTREE root -- so a root-relative file is deleted by the
 * `git worktree remove --force` that ends the run. That is the exact defect
 * recorded in toolAuditDir's docblock (src/config/paths/index.ts:138-150).
 */
export function approvalsPath(outputDir: string): string {
  return join(outputDir, "approvals.json");
}

/** Missing or malformed reads as empty: the CACHE fails, the chain does not. */
export async function readApprovals(path: string): Promise<readonly ApprovalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as ApprovalEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Lock the read-modify-write. Worktree-isolated parallel stories share one
 * project-scoped file BY DESIGN (that is why `root` is not part of the key), so
 * two "Allow + remember" taps can race and drop one. `withPathFileLock` is the
 * shared primitive for exactly this shape; it fails closed on timeout rather
 * than entering over a possible holder.
 */
export async function appendApproval(path: string, entry: ApprovalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withPathFileLock(path, async () => {
    const existing = await readApprovals(path);
    await writeFile(path, `${JSON.stringify({ entries: [...existing, entry] }, null, 2)}\n`, "utf8");
  });
}

/** BYTE-EXACT. No normalization. See the module docblock. */
export function findApproval(
  entries: readonly ApprovalEntry[],
  stage: string,
  command: string,
): ApprovalEntry | undefined {
  return entries.find((e) => e.stage === stage && e.command === command);
}
