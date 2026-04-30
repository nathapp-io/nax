import type { IReviewAuditor } from "../../review/review-audit";
import type { DispatchEvent, IDispatchEventBus } from "../dispatch-events";

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
  return bus.onDispatch((event: DispatchEvent) => {
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
}
