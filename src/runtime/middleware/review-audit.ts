import type { IReviewAuditor } from "../../review/review-audit";
import type { DispatchEvent, IDispatchEventBus, ReviewDecisionEvent } from "../dispatch-events";

function reviewerFromRole(role: string): "semantic" | "adversarial" | null {
  if (role === "reviewer-semantic") return "semantic";
  if (role === "reviewer-adversarial") return "adversarial";
  return null;
}

export function attachReviewAuditSubscriber(
  bus: IDispatchEventBus,
  auditor: IReviewAuditor,
  runId: string,
): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    if (event.kind !== "session-turn") return;
    const reviewer = reviewerFromRole(event.sessionRole);
    if (!reviewer) return;

    auditor.recordDispatch({
      runId,
      reviewer,
      sessionName: event.sessionName,
      sessionId: event.protocolIds.sessionId ?? null,
      recordId: event.protocolIds.recordId ?? null,
      workdir: event.workdir,
      projectDir: event.projectDir,
      agentName: event.agentName,
      storyId: event.storyId,
      featureName: event.featureName,
    });
  });

  const offDecision = bus.onReviewDecision((event: ReviewDecisionEvent) => {
    auditor.recordDecision({
      runId: event.runId,
      reviewer: event.reviewer,
      sessionName: event.sessionName,
      sessionId: event.sessionId,
      recordId: event.recordId,
      workdir: event.workdir,
      projectDir: event.projectDir,
      outputDir: event.outputDir,
      agentName: event.agentName,
      storyId: event.storyId,
      featureName: event.featureName,
      parsed: event.parsed,
      looksLikeFail: event.looksLikeFail,
      failOpen: event.failOpen,
      passed: event.passed,
      blockingThreshold: event.blockingThreshold,
      result: event.result,
      advisoryFindings: event.advisoryFindings,
    });
  });

  return () => {
    offDispatch();
    offDecision();
  };
}
