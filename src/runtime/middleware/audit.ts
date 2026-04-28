import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus } from "../dispatch-events";
import type { IPromptAuditor, PromptAuditEntry, PromptAuditErrorEntry } from "../prompt-auditor";

export function attachAuditSubscriber(bus: IDispatchEventBus, auditor: IPromptAuditor, runId: string): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    const entry: PromptAuditEntry = {
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
      permissionProfile: event.resolvedPermissions.mode,
      prompt: event.prompt,
      response: event.response,
      durationMs: event.durationMs,
      callType: event.kind === "session-turn" ? "run" : "complete",
      workdir: event.workdir,
      projectDir: event.projectDir,
      featureName: event.featureName,
      sessionName: event.sessionName,
      ...(event.kind === "session-turn" && {
        sessionId: event.protocolIds.sessionId ?? null,
        turn: event.turn,
      }),
    };
    auditor.record(entry);
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    const entry: PromptAuditErrorEntry = {
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      durationMs: event.durationMs,
      callType: event.origin === "completeAs" ? "complete" : "run",
      permissionProfile: event.resolvedPermissions.mode,
      prompt: event.prompt,
    };
    auditor.recordError(entry);
  });

  return () => {
    offDispatch();
    offError();
  };
}
