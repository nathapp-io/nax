/**
 * US-007: the whole-branch review's slice planning and the merge of its slices' verdicts. Pure — no
 * I/O, no config, no clock, so the planner and the merge are testable without a run.
 *
 * Slicing exists because a branch of 58 changed files is more than one review session takes on.
 * Files are grouped into contiguous runs by parent directory, and the runs are packed greedily,
 * so a directory's files stay together and neighbouring directories tend to share a slice.
 */
import type { BranchReviewSlice, BranchReviewVerdict, MinorTriageDecision } from "./types";

/** One slice of the whole-branch review, as the merge consumes it: its files and what it returned. */
export interface SliceResult {
  readonly files: readonly string[];
  readonly verdict: BranchReviewVerdict | null;
  /** Why the slice did not run. Ignored when `verdict` is set. */
  readonly why?: string;
}

/** The path up to its last `/`, or `""` for a root file — the key files are grouped by. */
function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/**
 * Contiguous runs of `required` that share a parent directory, in input order. A parent directory
 * that recurs after an intervening directory forms a later run rather than being pulled ahead of
 * it, so every input path keeps its place (git's path order can interleave a directory with its
 * own nested directories).
 */
function dirGroups(required: readonly string[]): string[][] {
  const groups: string[][] = [];
  let dir: string | undefined;
  for (const path of required) {
    const parent = parentDir(path);
    const open = groups.at(-1);
    if (open !== undefined && parent === dir) {
      open.push(path);
      continue;
    }
    groups.push([path]);
    dir = parent;
  }
  return groups;
}

/**
 * The review slices for `required`: greedy packing in input order, so every path appears exactly
 * once across the slices. A group that no longer fits starts the next slice; a group larger than
 * `sliceFiles` is cut into consecutive slices of `sliceFiles` and its last, shorter slice stays
 * open, so the following group can still join it. An empty `required` is `[[]]` — one slice, with
 * nothing to review.
 */
export function planReviewSlices(required: readonly string[], sliceFiles: number): string[][] {
  if (required.length === 0) return [[]];
  // `workflow.review.sliceFiles` is schema-validated at >= 1; the clamp keeps a hand-built context
  // (test, plugin, bot path) from dividing the packing loop by zero.
  const size = Math.max(1, Math.trunc(sliceFiles));
  const slices: string[][] = [];
  let open: string[] = [];
  for (const group of dirGroups(required)) {
    if (group.length > size) {
      if (open.length > 0) slices.push(open);
      for (let at = 0; at < group.length; at += size) {
        const chunk = group.slice(at, at + size);
        if (at + size < group.length) slices.push(chunk);
        else open = chunk;
      }
      continue;
    }
    if (open.length + group.length > size) {
      slices.push(open);
      open = [];
    }
    open.push(...group);
  }
  if (open.length > 0) slices.push(open);
  return slices;
}

/** One part's metadata for the merged verdict; a verdict with no `inspectedFiles` reads as empty. */
function sliceOf(part: SliceResult): BranchReviewSlice {
  return {
    files: part.files,
    inspectedFiles: part.verdict?.inspectedFiles ?? [],
    ran: part.verdict !== null,
    ...(part.why !== undefined ? { why: part.why } : {}),
  };
}

/** Whether any ran slice wanted this minor fixed now. */
function wantsFixNow(verdicts: readonly BranchReviewVerdict[], id: string): boolean {
  return verdicts.some((v) => v.minorTriage.some((t) => t.id === id && t.decision === "fix-now"));
}

/**
 * The merged triage: the first ran slice's id order (every slice is given the run's whole minor
 * list, so the order is the run's), with an id `fix-now` when any ran slice said so.
 */
function mergedTriage(
  verdicts: readonly BranchReviewVerdict[],
): readonly { id: string; decision: MinorTriageDecision }[] {
  const first = verdicts.at(0);
  if (first === undefined) return [];
  return first.minorTriage.map(({ id }) => ({
    id,
    decision: wantsFixNow(verdicts, id) ? "fix-now" : "leave",
  }));
}

/**
 * US-007: the branch review's verdict merged across its slices. Conservative by construction — a
 * `fail` or a `changes` from any slice that ran wins, findings and cannotVerify accumulate in slice
 * order, and a slice that did not run contributes only its metadata (`slices`).
 *
 * `null` when no slice ran. A lone ran slice returns the op's own verdict object untouched, so
 * runtime-only members (an attached `adapterFailure`, an `unreadFiles` a caller set) survive and a
 * one-slice review keeps its shape — no `slices` is added.
 */
export function mergeSliceVerdicts(parts: readonly SliceResult[]): BranchReviewVerdict | null {
  const ran = parts.flatMap((part) => (part.verdict === null ? [] : [part.verdict]));
  if (ran.length === 0) return null;
  const lone = parts.length === 1 ? parts.at(0) : undefined;
  if (lone !== undefined && lone.verdict !== null) return lone.verdict;
  return {
    spec: ran.some((v) => v.spec === "fail") ? "fail" : "pass",
    quality: ran.some((v) => v.quality === "changes") ? "changes" : "approved",
    findings: ran.flatMap((v) => v.findings),
    cannotVerify: [...new Set(ran.flatMap((v) => v.cannotVerify))],
    inspectedFiles: [...new Set(ran.flatMap((v) => v.inspectedFiles ?? []))],
    minorTriage: mergedTriage(ran),
    slices: parts.map(sliceOf),
  };
}
