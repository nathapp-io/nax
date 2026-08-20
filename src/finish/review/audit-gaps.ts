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
 * the new prompt contract produces a report the gate can actually check.
 *
 * Ported from `flows/nax-finish/steps/review-audit.ts` (D3.5) onto the native
 * `ReviewReport` shape. `node:fs/promises`'s `stat`, not `Bun.file(...).exists()`,
 * is kept deliberately: `Bun.file("/tmp").exists()` returns `false` for a
 * directory, so a reviewer citing a real directory touchpoint would be judged to
 * have listed a non-existent path — a spurious gap that escalates the run at
 * `MAX_INCOMPLETE_ATTEMPTS = 1`. `stat` is already used this way in `src/`, e.g.
 * `src/context/test-scanner.ts`.
 *
 * Both `touchpoint.path` and a disposition's `evidence` come from the
 * reviewer/fixer's reply text — untrusted the same way any parsed LLM output
 * is. `exists()` confines its resolved path under `workdir` before stat-ing
 * it, so a `../`-laden path can never be used to probe existence outside the
 * repo; a path that escapes reads as "does not exist," which is the correct
 * verdict anyway since a legitimate touchpoint is always inside it.
 */
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { gitWithTimeout } from "@/utils/git";
import type { FindingDisposition, ReviewReport } from "../types";

/** Paths stat-ed per review. A reviewer listing more than this is not the failure mode. */
const MAX_CHECKED = 20;

async function exists(workdir: string, rel: string): Promise<boolean> {
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  try {
    await stat(resolved);
    return true;
  } catch {
    return false;
  }
}

/**
 * Noise classes the worker protocol already tells the reviewer to ignore
 * (`src/finish/review/references/worker-protocol.md` §"Filter noise"). These
 * are subtracted from the changed-file set before the WALK is gated against it,
 * so churn in them is never reported as an unwalked file.
 */
function isNoise(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.includes(".nax")) return true;
  const name = segments[segments.length - 1];
  if (name.endsWith(".lock") || name === "package-lock.json" || name === "pnpm-lock.yaml") return true;
  if (/(^|\/)(dist|build|\.next|\.turbo|__pycache__)(\/|$)/.test(rel)) return true;
  if (/\.generated\./.test(name)) return true;
  return false;
}

/** The leading whitespace-delimited token of a WALK line, or null when none. */
function walkPathToken(line: string): string | null {
  const token = line.trim().split(/\s+/)[0];
  return token.length > 0 ? token : null;
}

/**
 * The changed files the review range touches, minus noise. Returns `[]` when
 * the git invocation fails (non-zero exit, timeout, or throw) so a git
 * infrastructure problem never produces a spurious unwalked-file gap.
 */
async function changedFiles(workdir: string, range: FinishReviewRange): Promise<string[]> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(
      ["diff", "--name-only", `${range.base}...${range.head}`],
      workdir,
    );
    if (exitCode !== 0) return [];
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isNoise(s));
  } catch {
    return [];
  }
}

/** Review range the audit resolves changed files from (`<base>...<head>`). */
export interface FinishReviewRange {
  base: string;
  head: string;
}

/** Review phase; quality gates WALK coverage against changed files, spec does not. */
export type FinishReviewPhase = "spec" | "quality";

/**
 * What this review failed to do. Empty means it may be routed on.
 *
 * Only ever called for a report that already parsed; an unreadable reply is the
 * `reprompt` path's business and is handled before this runs.
 *
 * US-002: the coverage gate is per-file and exact. For a `quality` review the
 * changed-file set is resolved from `<range.base>...<range.head>` and compared
 * against the leading token of each WALK line, so a WALK naming 4 of 30 changed
 * items now fails exactly like one naming 0. `spec` reviews are deliberately not
 * gated this way (issue #1635 defers that) — only the existing shape checks run.
 */
export async function auditGaps(
  report: ReviewReport,
  workdir: string,
  range?: FinishReviewRange,
  phase: FinishReviewPhase = "spec",
): Promise<string[]> {
  const gaps: string[] = [];
  const touchpoints = report.touchpoints ?? [];
  if (!report.sawTouchpointsSection || touchpoints.length === 0) {
    gaps.push("no `## TOUCHPOINTS` section: list every external definition you opened, or `- none — <justification>`");
  } else if (!touchpoints.some((t) => t.path === "none")) {
    const checked = touchpoints.slice(0, MAX_CHECKED);
    const found = await Promise.all(checked.map((t) => exists(workdir, t.path)));
    // Require most checked cited paths to exist; a reviewer that lists paths it
    // never opened (or that do not exist) is an incomplete review.
    const foundCount = found.filter(Boolean).length;
    if (foundCount * 2 <= checked.length) {
      gaps.push(
        `touchpoint path does not exist in the repo (checked: ${checked
          .map((t) => t.path)
          .join(", ")}) — list files you actually opened`,
      );
    }
  }
  if (!report.sawWalkSection || (report.walk ?? []).length === 0) {
    gaps.push("no `## WALK` section: the per-AC (spec) or per-function (quality) enumeration is required");
  }
  if (phase === "quality" && range) {
    const required = await changedFiles(workdir, range);
    if (required.length > 0) {
      const walked = new Set<string>();
      for (const line of report.walk ?? []) {
        const token = walkPathToken(line);
        if (token && required.includes(token)) walked.add(token);
      }
      const unwalked = required.filter((file) => !walked.has(file));
      if (unwalked.length > 0) {
        gaps.push(
          `unwalked changed files not named in \`## WALK\` (${unwalked.length}): ${unwalked.join(", ")} — walk every changed file`,
        );
      }
    }
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
