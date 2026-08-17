/**
 * Checking that a review discharged its obligations before its verdict counts.
 *
 * `WORKER_PROTOCOL` has always told the reviewer to enumerate the external
 * touchpoints and open their definitions, and both dimension references have
 * always required a per-item enumeration. Neither was checkable: `routeReview`
 * saw only a route and a finding list, so a reviewer that read the diff and
 * nothing else was indistinguishable from one that did the work — and on the run
 * behind #1614 that is exactly what happened, at 86 seconds for 3,716 changed
 * lines.
 *
 * The disk check is what makes this a gate rather than a ritual. It proves the
 * paths are real, not that they were read: a reviewer can still list files it
 * only globbed. That raises the cost of faking the list without eliminating it,
 * which is the honest ceiling for a check that costs one `stat` per line.
 *
 * A verdict from the legacy JSON parsing tier carries no `saw*` fields (they are
 * optional), so it always reports both gaps and is sent back for one re-review
 * under the new prompt. That is intentional, not a bug: the safe direction is
 * an extra review, never a false approval, and the retry self-corrects because
 * the new prompt contract produces a verdict the gate can actually check.
 *
 * `node:fs` — not `Bun.file` — because `flows/` runs inside acpx's Node process.
 */
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { FindingDisposition, ReviewVerdict } from "../types";

/** Paths stat-ed per review. A reviewer listing more than this is not the failure mode. */
const MAX_CHECKED = 20;

async function exists(workdir: string, rel: string): Promise<boolean> {
  try {
    await stat(path.resolve(workdir, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * What this review failed to do. Empty means it may be routed on.
 *
 * Only ever called for a verdict that already parsed; an unreadable reply is the
 * `reprompt` path's business and is handled before this runs.
 */
export async function auditGaps(verdict: ReviewVerdict, workdir: string): Promise<string[]> {
  const gaps: string[] = [];
  const touchpoints = verdict.touchpoints ?? [];
  if (!verdict.sawTouchpointsSection || touchpoints.length === 0) {
    gaps.push("no `## TOUCHPOINTS` section: list every external definition you opened, or `- none — <justification>`");
  } else if (!touchpoints.some((t) => t.path === "none")) {
    const checked = touchpoints.slice(0, MAX_CHECKED);
    const found = await Promise.all(checked.map((t) => exists(workdir, t.path)));
    if (!found.some(Boolean)) {
      gaps.push(
        `touchpoint path does not exist in the repo (checked: ${checked
          .map((t) => t.path)
          .join(", ")}) — list files you actually opened`,
      );
    }
  }
  if (!verdict.sawWalkSection || (verdict.walk ?? []).length === 0) {
    gaps.push("no `## WALK` section: the per-AC (spec) or per-function (quality) enumeration is required");
  }
  return gaps;
}

/** Mark any rejection whose cited `file:line` does not resolve in the repo. */
export async function validateDispositions(
  workdir: string,
  dispositions: FindingDisposition[],
): Promise<FindingDisposition[]> {
  return Promise.all(
    dispositions.map(async (d) => {
      if (d.disposition !== "rejected" || !d.evidence) return d;
      const file = d.evidence.split(":")[0];
      return (await exists(workdir, file)) ? d : { ...d, evidenceMissing: true };
    }),
  );
}
