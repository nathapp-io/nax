/**
 * Which findings the next branch-fix round targets (#2496, nax#2547). Pure apart from the injected
 * diff listing: the feature machine owns the ledger and the record.
 *
 * A round runs while the cap allows it and the last re-review left a blocking review finding open
 * (PARTIAL or NOT addressed) or the fix introduced one in a file it changed. A follow-up round that
 * made no progress (nothing addressed, no PARTIAL residual narrowed) ends the loop: the same fix would
 * meet the same verdict again.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { WorkflowFinding, WorkflowFindingDraft } from "./types";

export interface FeatureLimits {
  /** Branch fix -> re-review cycles (`workflow.maxBranchFixRounds`). */
  readonly maxBranchFixRounds: number;
  /** Repair rounds for final gates the branch fix turned red (`workflow.finalGateRepairRounds`). */
  readonly finalGateRepairRounds: number;
}

export interface NextRoundInput {
  /** The round that just ran (1-based). */
  readonly round: number;
  readonly max: number;
  /** The round that just ran targeted earlier rounds' leftovers, not the whole review. */
  readonly followUp: boolean;
  /** What the round's re-review was asked about. */
  readonly items: readonly WorkflowFinding[];
  readonly addressed: ReadonlySet<string>;
  /** The review findings still open after the re-review (fix-now minors excluded). */
  readonly open: readonly WorkflowFinding[];
  /** Blocking findings the re-review raised, already given ids. */
  readonly added: readonly WorkflowFinding[];
  readonly fixBase: string | undefined;
  readonly changedFiles: (base: string) => Promise<readonly string[]>;
}

export interface NextRound {
  readonly targets: readonly string[];
  /** Ledger lines explaining the decision, in order. */
  readonly notes: readonly string[];
}

const repoPath = (file: string): string => file.replace(/^\.\//, "");
const siteOf = (f: { readonly file?: string; readonly line?: number }): string | undefined =>
  f.file !== undefined && f.line !== undefined ? `${repoPath(f.file)}:${f.line}` : undefined;

/**
 * A follow-up re-review reads the whole fix since round 1, so it can meet the code of a finding that
 * is already open and file it again. A new draft at an open finding's file:line is that restatement.
 */
export function dropKnownRestatements<T extends WorkflowFindingDraft>(
  drafts: readonly T[],
  open: readonly WorkflowFinding[],
): T[] {
  const known = new Set(open.map(siteOf).filter((s): s is string => s !== undefined));
  return drafts.filter((d) => {
    const site = siteOf(d);
    return site === undefined || !known.has(site);
  });
}

/** Something moved: an asked item was addressed, or a PARTIAL came back with a narrower residual. */
function madeProgress(input: NextRoundInput): boolean {
  if (input.items.some((f) => input.addressed.has(f.id))) return true;
  const before = new Map(input.items.map((f) => [f.id, f.issue]));
  return input.open.some((f) => before.has(f.id) && before.get(f.id) !== f.issue);
}
const NONE: NextRound = { targets: [], notes: [] };

/** The added findings sitting in a file the fix changed; a finding with no file never qualifies. */
async function introducedByFix(input: NextRoundInput): Promise<{ ids: string[]; notes: string[] }> {
  const located = input.added.filter((f) => f.file !== undefined);
  if (located.length === 0 || !input.fixBase) return { ids: [], notes: [] };
  try {
    const changed = new Set((await input.changedFiles(input.fixBase)).map(repoPath));
    return { ids: located.filter((f) => changed.has(repoPath(f.file ?? ""))).map((f) => f.id), notes: [] };
  } catch (err) {
    return {
      ids: [],
      notes: [`next branch fix: new findings skipped, could not list the fix diff (${errorMessage(err)})`],
    };
  }
}

export async function nextBranchFixRound(input: NextRoundInput): Promise<NextRound> {
  const asked = new Set(input.items.map((f) => f.id));
  const stillOpen = input.open.filter((f) => asked.has(f.id)).map((f) => f.id);
  if (stillOpen.length === 0 && input.added.length === 0) return NONE;
  if (input.round >= input.max) {
    return { targets: [], notes: [`branch fix rounds used: ${input.round}/${input.max}`] };
  }
  if (input.followUp && !madeProgress(input)) {
    return { targets: [], notes: [`branch fix stopped: round ${input.round} addressed nothing`] };
  }
  const introduced = await introducedByFix(input);
  const targets = [...stillOpen, ...introduced.ids];
  if (targets.length === 0) return { targets, notes: introduced.notes };
  const why = [
    ...(stillOpen.length > 0 ? [`${stillOpen.join(", ")} still open`] : []),
    ...(introduced.ids.length > 0 ? [`${introduced.ids.join(", ")} introduced by the fix`] : []),
  ];
  return { targets, notes: [...introduced.notes, `next branch fix: ${why.join("; ")}`] };
}
