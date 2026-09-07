import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import type { AdvisoryFinding } from "@/review/review-audit";
import type { DroppedFindingSummary, ReviewDecisionPayload } from "./types";

/** Narrows to the union rather than casting — an unrecognised value becomes
 * `undefined` so it can never be written into the audit as if it were a real,
 * governing threshold. */
function toBlockingThreshold(value: unknown): "error" | "warning" | "info" | undefined {
  return value === "error" || value === "warning" || value === "info" ? value : undefined;
}

export function toReviewDecisionPayload(opName: string, output: unknown): ReviewDecisionPayload | null {
  if (output === null || output === undefined || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;

  const reviewer = opName === "semantic-review" ? "semantic" : opName === "adversarial-review" ? "adversarial" : null;
  if (!reviewer) return null;

  const unparsedPreview = typeof record.unparsedPreview === "string" ? record.unparsedPreview : undefined;
  // Read regardless of parse outcome — both ops now stamp blockingThreshold on
  // their failOpen/looksLikeFail branches too (mirrors AdversarialReviewOutput
  // AC8 and semantic's equivalent), so a fail-open give-up under a mis-set
  // threshold is diagnosable (#1889).
  const blockingThreshold = toBlockingThreshold(record.blockingThreshold);
  if (record.failOpen === true) {
    return { reviewer, parsed: false, passed: true, failOpen: true, result: null, unparsedPreview, blockingThreshold };
  }
  if (record.looksLikeFail === true) {
    return {
      reviewer,
      parsed: false,
      passed: false,
      looksLikeFail: true,
      result: null,
      unparsedPreview,
      blockingThreshold,
    };
  }

  if (typeof record.passed !== "boolean" || !Array.isArray(record.findings)) {
    return null;
  }

  const acDropped = Array.isArray(record.acDropped)
    ? (record.acDropped as unknown[]).map((d): DroppedFindingSummary => {
        const entry = (d ?? {}) as Record<string, unknown>;
        const finding = (entry.finding ?? {}) as Record<string, unknown>;
        return {
          code: typeof entry.code === "string" ? entry.code : undefined,
          severity: typeof finding.severity === "string" ? finding.severity : undefined,
          file: typeof finding.file === "string" ? finding.file : undefined,
          line: typeof finding.line === "number" ? finding.line : undefined,
          issue: typeof finding.issue === "string" ? finding.issue : undefined,
          acIndex: typeof finding.acIndex === "number" ? finding.acIndex : undefined,
        };
      })
    : undefined;

  // #1423 acknowledgements. Both ops return `ReviewAck[]` at the top level of
  // their output; kept as `unknown[]` here (like advisoryFindings/acDropped
  // above) since this seam only guards shape, not the element type — the
  // review-audit middleware is the typed boundary (ReviewAck cast).
  const acks = Array.isArray(record.acks) ? (record.acks as unknown[]) : undefined;

  return {
    reviewer,
    parsed: true,
    passed: record.passed,
    result: { passed: record.passed, findings: record.findings },
    acDropped,
    acks,
    blockingThreshold,
    // Op output crosses this seam untyped (`output: unknown`), so the shape is asserted
    // rather than checked. Upstream both ops return `Finding[]`
    // (operations/{adversarial,semantic}-review.ts) and every consumer downstream is now
    // typed, so this is the single explicit trust point — not an implicit any (#1816).
    ...(Array.isArray(record.advisoryFindings)
      ? { advisoryFindings: record.advisoryFindings as readonly AdvisoryFinding[] }
      : {}),
  };
}

export function emitReviewDecision(ctx: CallContext, opName: string, output: unknown): void {
  const payload = toReviewDecisionPayload(opName, output);
  if (!payload) return;

  ctx.runtime.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    runId: ctx.runtime.runId,
    reviewer: payload.reviewer,
    workdir: ctx.packageDir,
    projectDir: ctx.runtime.projectDir,
    outputDir: ctx.runtime.outputDir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    timestamp: Date.now(),
    parsed: payload.parsed,
    looksLikeFail: payload.parsed ? undefined : payload.looksLikeFail,
    failOpen: payload.parsed ? false : payload.failOpen,
    passed: payload.passed,
    // advisoryFindings and acDropped were computed by both review ops and then
    // dropped here, so every review-audit record wrote them as null. See F3 of
    // docs/findings/2026-08-01-review-pipeline-gap-analysis.md. `acks` was the
    // same bug, never added to that rescued list (third pass over this seam) —
    // it joins them here, gated behind `parsed` like the other two: an unparsed
    // turn has no acks to report.
    result: payload.result,
    advisoryFindings: payload.parsed ? payload.advisoryFindings : undefined,
    acDropped: payload.parsed ? payload.acDropped : undefined,
    acks: payload.parsed ? payload.acks : undefined,
    // Unlike acks, blockingThreshold is NOT gated behind `parsed` — it is read
    // from both branches of ReviewDecisionPayload (see toReviewDecisionPayload,
    // which threads it through the failOpen/looksLikeFail early returns too). A
    // fail-open review under a mis-set threshold is exactly the case #1889 needs
    // this data for; gating it here would silently re-introduce the same bug for
    // every give-up.
    blockingThreshold: payload.blockingThreshold,
    unparsedPreview: payload.parsed ? undefined : payload.unparsedPreview,
  });
}

export function logUnifiedReviewPhaseStart(storyId: string | undefined, opName: string): void {
  const logger = getSafeLogger();
  if (opName === "semantic-review") {
    logger?.info("review", "Running semantic check", { storyId });
  } else if (opName === "adversarial-review") {
    logger?.info("review", "Running adversarial check", { storyId });
  }
}

export function logUnifiedReviewPhaseResult(storyId: string | undefined, opName: string, output: unknown): void {
  const logger = getSafeLogger();
  const payload = toReviewDecisionPayload(opName, output);
  if (!payload) return;

  if (!payload.parsed) {
    if (payload.failOpen) {
      logger?.warn("review", `${payload.reviewer} review fail-open`, { storyId });
    } else if (payload.looksLikeFail) {
      logger?.warn("review", `${payload.reviewer} review returned truncated failure`, { storyId });
    }
    return;
  }

  const findingsCount = payload.result.findings.length;
  const title = payload.reviewer === "semantic" ? "Semantic review" : "Adversarial review";

  if (payload.passed) {
    logger?.info("review", `${title} passed`, { storyId });
    return;
  }

  // passed:false with empty findings = model emitted failure without grounding
  // any concern in an AC. Surface this explicitly — otherwise the warn line
  // ("0 findings") reads as a silent success.
  if (findingsCount === 0) {
    const dropped = payload.acDropped ?? [];
    const droppedSummary = dropped.slice(0, 5);
    logger?.warn(
      "review",
      `${title} failed: 0 findings — ${
        dropped.length > 0
          ? `${dropped.length} blocking finding(s) dropped as ungrounded by AC-grounding filter`
          : "model emitted passed:false but produced no findings (likely empty output)"
      }`,
      {
        storyId,
        findingsCount,
        reason: dropped.length > 0 ? "ac-grounding-drop" : "passed-false-no-findings",
        droppedCount: dropped.length || undefined,
        droppedFindings: droppedSummary.length > 0 ? droppedSummary : undefined,
        droppedTruncated: dropped.length > droppedSummary.length || undefined,
      },
    );
    return;
  }

  const findingsSummary = payload.result.findings.slice(0, 5).map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    return {
      severity: typeof r.severity === "string" ? r.severity : undefined,
      file: typeof r.file === "string" ? r.file : undefined,
      line: typeof r.line === "number" ? r.line : undefined,
      rule: typeof r.rule === "string" ? r.rule : undefined,
      issue: typeof r.issue === "string" ? r.issue : typeof r.message === "string" ? r.message : undefined,
      acIndex: typeof r.acIndex === "number" ? r.acIndex : undefined,
    };
  });
  logger?.warn("review", `${title} failed: ${findingsCount} findings`, {
    storyId,
    findingsCount,
    findings: findingsSummary,
    truncated: findingsCount > findingsSummary.length,
  });
}
