import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import type { DroppedFindingSummary, ReviewDecisionPayload } from "./types";

export function toReviewDecisionPayload(opName: string, output: unknown): ReviewDecisionPayload | null {
  if (output === null || output === undefined || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;

  const reviewer = opName === "semantic-review" ? "semantic" : opName === "adversarial-review" ? "adversarial" : null;
  if (!reviewer) return null;

  if (record.failOpen === true) {
    return { reviewer, parsed: false, passed: true, failOpen: true, result: null };
  }
  if (record.looksLikeFail === true) {
    return { reviewer, parsed: false, passed: false, looksLikeFail: true, result: null };
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

  return {
    reviewer,
    parsed: true,
    passed: record.passed,
    result: { passed: record.passed, findings: record.findings },
    acDropped,
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
    result: payload.result,
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
