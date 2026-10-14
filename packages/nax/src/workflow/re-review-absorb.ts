/**
 * US-004 (nax#2524): absorbing a re-review verdict onto the findings it answered.
 *
 * Pure — no I/O, and no `@/operations` or `@/prompts` import — so the story loop and the feature
 * machine apply one rule (spec §6 step 5): a `PARTIAL` verdict keeps its finding open under the same
 * id with the residual as its issue, and a new finding that only restates that residual at the same
 * file and line is dropped instead of filed as a second defect.
 */
import type { ReReviewResidual, ReReviewVerdict, WorkflowFinding, WorkflowFindingDraft } from "./types";

export interface ReReviewAbsorption {
  /** `asked`, in order, minus every addressed finding; a residual replaces its finding's issue. */
  readonly open: readonly WorkflowFinding[];
  /** The verdict's new findings, minus the restatements of a residual. */
  readonly newDrafts: readonly WorkflowFindingDraft[];
}

type VerdictEntry = ReReviewVerdict["verdicts"][number];

/**
 * The finding with the residual's text. `suggestion`, `file` and `line` come from the residual when it
 * gives them and from the finding otherwise; `observed` is dropped, since the proof the reviewer quoted
 * belongs to the issue that no longer stands.
 */
function withResidual(finding: WorkflowFinding, residual: ReReviewResidual): WorkflowFinding {
  const { observed: _observed, file, line, suggestion, ...kept } = finding;
  const at = {
    file: residual.file ?? file,
    line: residual.line ?? line,
    suggestion: residual.suggestion ?? suggestion,
  };
  return {
    ...kept,
    issue: residual.issue,
    ...(at.file !== undefined ? { file: at.file } : {}),
    ...(at.line !== undefined ? { line: at.line } : {}),
    ...(at.suggestion !== undefined ? { suggestion: at.suggestion } : {}),
  };
}

/** Where a residual finding now sits: the residual's location, else the original finding's. */
function residualSite(finding: WorkflowFinding, residual: ReReviewResidual): string | undefined {
  const file = residual.file ?? finding.file;
  const line = residual.line ?? finding.line;
  return file !== undefined && line !== undefined ? `${file}:${line}` : undefined;
}

function restates(sites: ReadonlySet<string>, draft: WorkflowFindingDraft): boolean {
  if (draft.file === undefined || draft.line === undefined) return false;
  return sites.has(`${draft.file}:${draft.line}`);
}

/**
 * `asked` is the list of findings the re-review answered, in the order the consumer holds them. Only
 * those are absorbed: a verdict for an id that was not asked never resurrects a finding.
 */
export function absorbReReviewVerdict(asked: readonly WorkflowFinding[], verdict: ReReviewVerdict): ReReviewAbsorption {
  const byId = new Map<string, VerdictEntry>(verdict.verdicts.map((v) => [v.id, v]));
  const open: WorkflowFinding[] = [];
  const sites = new Set<string>();
  for (const finding of asked) {
    const entry = byId.get(finding.id);
    if (entry?.addressed) continue;
    if (!entry?.residual) {
      open.push(finding);
      continue;
    }
    open.push(withResidual(finding, entry.residual));
    const site = residualSite(finding, entry.residual);
    if (site !== undefined) sites.add(site);
  }
  return { open, newDrafts: verdict.newFindings.filter((draft) => !restates(sites, draft)) };
}
