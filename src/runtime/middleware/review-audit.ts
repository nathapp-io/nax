import type { IReviewAuditor } from "@/review/review-audit";
import type { ReviewAck } from "@/review/types";
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
      // Note: `outputDir` is deliberately NOT forwarded from the event — the
      // audit writer's own `_outputDir` (set in the constructor) is the
      // authoritative location. Forwarding the event's `outputDir` would
      // override the auditor's location and write the file somewhere the
      // caller (e.g. a test, or a swapped auditor) does not expect.
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
      acks: event.acks ? ([...event.acks] as ReviewAck[]) : undefined,
      acDropped: event.acDropped ? [...event.acDropped] : undefined,
      unparsedPreview: event.unparsedPreview,
      // US-002 — forward modelPassed onto the decision the writer consumes.
      // Mirrors how blockingThreshold is forwarded: preserved as-is (including
      // explicit `false`), omitted when the producer did not declare it.
      modelPassed: event.modelPassed,
    });
  });

  return () => {
    offDispatch();
    offDecision();
  };
}
