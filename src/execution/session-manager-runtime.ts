import type { AgentGetFn } from "../pipeline/types";
import type { ISessionManager, SessionDescriptor, SessionState } from "../session/types";

async function closePhysicalSession(
  descriptor: SessionDescriptor,
  agentGetFn?: AgentGetFn,
): Promise<void> {
  if (!descriptor.handle) return;

  const adapter = agentGetFn?.(descriptor.agent);
  if (!adapter) return;

  try {
    await adapter.closePhysicalSession(descriptor.handle, descriptor.workdir);
  } catch {
    // Best-effort cleanup: session close errors must not block run teardown.
  }
}

async function closeStorylessSession(
  sessionManager: Pick<ISessionManager, "transition">,
  descriptor: SessionDescriptor,
  agentGetFn?: AgentGetFn,
): Promise<number> {
  const transitionChain: SessionState[] = getStorylessCloseChain(descriptor.state);
  for (const targetState of transitionChain) {
    try {
      sessionManager.transition(descriptor.id, targetState);
    } catch {
      // Best-effort cleanup: invalid transition states must not block teardown.
    }
  }

  await closePhysicalSession(descriptor, agentGetFn);
  return 1;
}

function getStorylessCloseChain(state: SessionState): SessionState[] {
  switch (state) {
    case "CREATED":
      return ["RUNNING", "COMPLETED"];
    case "PAUSED":
      return ["RESUMING", "RUNNING", "COMPLETED"];
    case "RESUMING":
      return ["RUNNING", "COMPLETED"];
    case "RUNNING":
      return ["COMPLETED"];
    case "CLOSING":
      return ["COMPLETED"];
    default:
      return [];
  }
}

export async function closeStorySessions(
  sessionManager: Pick<ISessionManager, "closeStory">,
  storyId: string,
  agentGetFn?: AgentGetFn,
): Promise<number> {
  const closedSessions = sessionManager.closeStory(storyId);

  for (const descriptor of closedSessions) {
    await closePhysicalSession(descriptor, agentGetFn);
  }

  return closedSessions.length;
}

export async function closeAllRunSessions(
  sessionManager: Pick<ISessionManager, "listActive" | "closeStory" | "transition">,
  agentGetFn?: AgentGetFn,
): Promise<number> {
  const storyIds = new Set<string>();
  const storylessSessionIds = new Set<string>();
  const activeSessions = sessionManager.listActive();

  for (const descriptor of activeSessions) {
    if (descriptor.storyId) {
      storyIds.add(descriptor.storyId);
    }
  }

  let totalClosed = 0;
  for (const storyId of storyIds) {
    totalClosed += await closeStorySessions(sessionManager, storyId, agentGetFn);
  }

  for (const descriptor of activeSessions) {
    if (descriptor.storyId || storylessSessionIds.has(descriptor.id)) continue;
    storylessSessionIds.add(descriptor.id);
    totalClosed += await closeStorylessSession(sessionManager, descriptor, agentGetFn);
  }

  return totalClosed;
}
