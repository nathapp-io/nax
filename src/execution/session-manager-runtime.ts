import type { AgentGetFn } from "../pipeline/types";
import type { ISessionManager, SessionDescriptor, SessionState } from "../session/types";

async function closePhysicalSession(
  descriptor: SessionDescriptor,
  agentGetFn?: AgentGetFn,
  force?: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!descriptor.handle) return;

  const adapter = agentGetFn?.(descriptor.agent);
  if (!adapter) return;

  try {
    // AC-83: pass force=true for errored sessions so the adapter can hard-terminate
    const options: { force?: boolean; signal?: AbortSignal } | undefined =
      force || signal ? { ...(force && { force: true }), ...(signal && { signal }) } : undefined;
    await adapter.closePhysicalSession?.(descriptor.handle, descriptor.workdir, options);
  } catch {
    // Best-effort cleanup: session close errors must not block run teardown.
  }
}

async function closeStorylessSession(
  sessionManager: Pick<ISessionManager, "transition">,
  descriptor: SessionDescriptor,
  agentGetFn?: AgentGetFn,
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<number> {
  const transitionChain: SessionState[] = getStorylessCloseChain(descriptor.state);
  for (const targetState of transitionChain) {
    try {
      sessionManager.transition(descriptor.id, targetState);
    } catch {
      // Best-effort cleanup: invalid transition states must not block teardown.
    }
  }

  // AC-83: force hard-terminate when the session was already in FAILED state,
  // or when the caller explicitly requests force (e.g. signal-driven shutdown).
  const force = opts?.force === true || descriptor.state === "FAILED";
  await closePhysicalSession(descriptor, agentGetFn, force, opts?.signal);
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
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<number> {
  const closedSessions = sessionManager.closeStory(storyId);

  for (const descriptor of closedSessions) {
    // AC-83: force hard-terminate for sessions that were already in FAILED state,
    // or when the caller explicitly requests force (e.g. signal-driven shutdown).
    const force = opts?.force === true || descriptor.state === "FAILED";
    await closePhysicalSession(descriptor, agentGetFn, force, opts?.signal);
  }

  return closedSessions.length;
}

/**
 * Transition a session to FAILED and force-close its physical handle.
 *
 * Called by the execution stage at terminal failure points (agent exhaustion,
 * merge conflict abort). Preserves state fidelity for audit, orphan sweep, and
 * metrics; ensures AC-83 force-terminate fires even though run-completion
 * teardown skips FAILED sessions (listActive() filters them out as terminal).
 *
 * No-op if the session is unknown, already in a terminal state, or the
 * transition is rejected. Physical close is best-effort.
 */
export async function failAndClose(
  sessionManager: Pick<ISessionManager, "get" | "transition">,
  sessionId: string,
  agentGetFn?: AgentGetFn,
): Promise<void> {
  const descriptor = sessionManager.get(sessionId);
  if (!descriptor) return;
  if (descriptor.state === "FAILED" || descriptor.state === "COMPLETED") return;

  try {
    sessionManager.transition(sessionId, "FAILED");
  } catch {
    // Invalid transition — bail out; do not force-close a session in unknown state.
    return;
  }

  const failed = sessionManager.get(sessionId);
  if (failed) {
    await closePhysicalSession(failed, agentGetFn, true);
  }
}

export async function closeAllRunSessions(
  sessionManager: Pick<ISessionManager, "listActive" | "closeStory" | "transition">,
  agentGetFn?: AgentGetFn,
  /**
   * PERF-1: `signal` is threaded all the way down to each physical session
   * close's trackedSpawn deadline race, so an external abort (e.g. the crash
   * signal handler's abortController) can cut a wedged teardown short instead
   * of waiting the full per-call hard deadline.
   */
  opts?: { force?: boolean; signal?: AbortSignal },
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
    totalClosed += await closeStorySessions(sessionManager, storyId, agentGetFn, opts);
  }

  for (const descriptor of activeSessions) {
    if (descriptor.storyId || storylessSessionIds.has(descriptor.id)) continue;
    storylessSessionIds.add(descriptor.id);
    totalClosed += await closeStorylessSession(sessionManager, descriptor, agentGetFn, opts);
  }

  return totalClosed;
}
