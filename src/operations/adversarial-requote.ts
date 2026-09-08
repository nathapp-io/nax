/**
 * Same-session requote recovery for adversarial review findings.
 *
 * Extracted from adversarial-review.ts to keep that file under the 600-line hard
 * limit. Mirrors the semantic equivalent's responsibility but for the adversarial
 * shape: when a finding has unmatched evidence, ask the reviewer to requote the
 * verbatim observed text; if the requote matches the file, the finding survives;
 * otherwise it is downgraded via downgradeUnsubstantiatedFinding.
 *
 * Returns a `{ findings, changed, extraCostUsd }` summary so the caller can decide
 * whether to rewrite the turn's `passed` flag based on what survived the requote
 * pass. The hopBody rewrite preserves the model's original claim via
 * `_originalModelPassed` (US-002) so verify() can stamp `modelPassed` with the
 * model's raw verdict, not the framework's flipped one.
 */

import { getSafeLogger } from "../logger";
import { AdversarialReviewPromptBuilder } from "../prompts/builders/adversarial-review-builder";
import type { AdversarialLLMFinding } from "../review/adversarial-helpers";
import { isBlockingSeverity } from "../review/adversarial-helpers";
import { checkFindingEvidence, downgradeUnsubstantiatedFinding } from "../review/finding-filters";
import { parseRequoteResponse } from "../review/requote-response";
import type { AdversarialReviewInput } from "./adversarial-review";
import type { HopBodyContext } from "./types";

export const ADVERSARIAL_REQUOTE_RECOVERED_EVENT = "review.adversarial.finding.requote_recovered";
export const ADVERSARIAL_REQUOTE_FAILED_EVENT = "review.adversarial.finding.requote_failed";
export const DEFAULT_MAX_REQUOTES = 5;

export async function requoteBlockingAdversarialFindings(
  findings: AdversarialLLMFinding[],
  ctx: HopBodyContext<AdversarialReviewInput>,
): Promise<{ findings: AdversarialLLMFinding[]; changed: boolean; extraCostUsd: number }> {
  const threshold = ctx.input.blockingThreshold ?? "error";
  const maxRequotes = ctx.input.adversarialConfig.substantiation?.maxRequotes ?? DEFAULT_MAX_REQUOTES;
  const requoteEnabled = ctx.input.adversarialConfig.substantiation?.requote ?? true;
  if (ctx.input.mode !== "ref" || !requoteEnabled || maxRequotes <= 0) {
    return { findings, changed: false, extraCostUsd: 0 };
  }
  const next = [...findings];
  let changed = false;
  let extraCostUsd = 0;
  let used = 0;
  for (const [index, finding] of next.entries()) {
    if (!isBlockingSeverity(finding.severity, threshold)) continue;
    const initialEvidence = await checkFindingEvidence({
      finding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
    if (initialEvidence.status !== "unmatched") continue;
    if (used >= maxRequotes) break;
    used += 1;

    const retry = await ctx.send(AdversarialReviewPromptBuilder.requoteVerbatim({ finding }));
    extraCostUsd += retry.estimatedCostUsd ?? 0;
    const requote = parseRequoteResponse(retry.output);
    if (!requote) {
      next[index] = downgradeUnsubstantiatedFinding({
        finding,
        storyId: ctx.input.story.id,
        event: ADVERSARIAL_REQUOTE_FAILED_EVENT,
        ...initialEvidence,
      });
      changed = true;
      continue;
    }

    const updatedFinding: AdversarialLLMFinding = {
      ...finding,
      verifiedBy: {
        file: requote.file,
        line: requote.line,
        observed: requote.observed,
      },
    };
    const requotedEvidence = await checkFindingEvidence({
      finding: updatedFinding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
    if (requotedEvidence.status === "matched") {
      getSafeLogger()?.info("review", "Recovered adversarial finding via same-session requote", {
        storyId: ctx.input.story.id,
        event: ADVERSARIAL_REQUOTE_RECOVERED_EVENT,
        file: requotedEvidence.file,
        line: requotedEvidence.line,
      });
      next[index] = updatedFinding;
      changed = true;
      continue;
    }

    next[index] = downgradeUnsubstantiatedFinding({
      finding: updatedFinding,
      storyId: ctx.input.story.id,
      event: ADVERSARIAL_REQUOTE_FAILED_EVENT,
      file: requotedEvidence.file,
      line: requotedEvidence.line,
      observed: requotedEvidence.observed,
    });
    changed = true;
  }
  return { findings: next, changed, extraCostUsd };
}
