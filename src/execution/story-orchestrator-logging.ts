import { getSafeLogger } from "../logger";

export function formatPhaseResultMessage(opName: string, success: boolean, stage?: string, status?: string): string {
  if (opName === "greenfield-gate") {
    return success
      ? "Greenfield-gate: pre-existing tests detected (not greenfield) — proceeding with normal TDD"
      : "Greenfield-gate: no pre-existing tests — greenfield run, pausing TDD test-writer";
  }
  if (status === "skipped") {
    return `Phase skipped: ${opName}`;
  }
  if (stage === "rectification") {
    return `Rectification strategy completed: ${opName}`;
  }
  return success ? `Phase passed: ${opName}` : `Phase failed: ${opName}`;
}

export function buildPhaseOutcomeLogData(
  storyId: string | undefined,
  opName: string,
  output: unknown,
  durationMs: number,
): { success: boolean; data: Record<string, unknown> } | null {
  if (output === null || output === undefined || typeof output !== "object") return null;

  const r = output as Record<string, unknown>;
  const success = r.success === true || r.passed === true;
  const findingsCount = Array.isArray(r.normalizedFindings)
    ? r.normalizedFindings.length
    : Array.isArray(r.findings)
      ? r.findings.length
      : undefined;
  const status = typeof r.status === "string" ? r.status : undefined;

  const data: Record<string, unknown> = { storyId, phase: opName, durationMs };
  if (findingsCount !== undefined) data.findingsCount = findingsCount;
  if (status !== undefined) data.status = status;
  if (typeof r.failureCategory === "string") data.failureCategory = r.failureCategory;
  if (typeof r.reviewReason === "string") data.reviewReason = r.reviewReason;

  return { success, data };
}

export function logDeterministicPhaseOutcome(
  storyId: string | undefined,
  opName: string,
  output: unknown,
  durationMs: number,
  isTddPhase: boolean,
  stage?: string,
  progressData: Record<string, unknown> = {},
): void {
  if (isTddPhase) return;
  if (opName === "semantic-review" || opName === "adversarial-review") return;

  const built = buildPhaseOutcomeLogData(storyId, opName, output, durationMs);
  if (!built) return;
  const { success } = built;
  const data = { ...built.data, ...progressData };
  const status = typeof built.data.status === "string" ? built.data.status : undefined;

  const logger = getSafeLogger();
  const message = formatPhaseResultMessage(opName, success, stage, status);

  if (stage === "rectification") {
    logger?.info("story-orchestrator", message, data);
    return;
  }

  if (success) {
    logger?.info("story-orchestrator", message, data);
  } else {
    logger?.warn("story-orchestrator", message, data);
  }
}
