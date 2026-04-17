import type { AgentGetFn } from "../pipeline/types";
import type { ISessionManager, SessionDescriptor } from "../session/types";

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
  sessionManager: Pick<ISessionManager, "listActive" | "closeStory">,
  agentGetFn?: AgentGetFn,
): Promise<number> {
  const storyIds = new Set<string>();

  for (const descriptor of sessionManager.listActive()) {
    if (descriptor.storyId) {
      storyIds.add(descriptor.storyId);
    }
  }

  let totalClosed = 0;
  for (const storyId of storyIds) {
    totalClosed += await closeStorySessions(sessionManager, storyId, agentGetFn);
  }

  return totalClosed;
}
