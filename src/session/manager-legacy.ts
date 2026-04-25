/**
 * Legacy runInSession body — extracted from SessionManager to keep manager.ts
 * within the 400-line project limit. Called only via the IAgentManager overload.
 */

import type { AgentRunRequest, IAgentManager } from "../agents/manager-types";
import type { AgentResult } from "../agents/types";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import type { ProtocolIds, SessionDescriptor, SessionRunOptions, SessionState } from "./types";

export interface LegacyRunDeps {
  sessions: Map<string, SessionDescriptor>;
  transition: (id: string, state: SessionState) => SessionDescriptor;
  bindHandle: (id: string, handle: string, protocolIds: ProtocolIds) => SessionDescriptor;
  handoff: (id: string, newAgent: string, reason?: string) => SessionDescriptor;
  persistDescriptor: (descriptor: SessionDescriptor) => void;
  now: () => string;
}

/**
 * Per-session lifecycle primitive for the legacy IAgentManager call path.
 *
 * Bookkeeping order:
 *   1. CREATED → RUNNING (only if currently CREATED; RESUMING is left alone
 *      so rectification loops that re-enter an already-RUNNING session don't
 *      throw SESSION_INVALID_TRANSITION).
 *   2. Call the runner. Result.protocolIds (if present) is bound via
 *      bindHandle so the disk descriptor captures the audit correlation.
 *   3. RUNNING → COMPLETED on success, RUNNING → FAILED on failure. If the
 *      runner threw, we transition to FAILED and re-throw.
 *
 * ADR-013 Phase 1: accepts IAgentManager + AgentRunRequest instead of the
 * raw SessionAgentRunner function. Calls agentManager.run(injectedRequest)
 * after injecting the onSessionEstablished callback for eager handle binding.
 */
export async function runInSessionLegacy(
  id: string,
  agentManager: IAgentManager,
  request: AgentRunRequest,
  deps: LegacyRunDeps,
  _options?: SessionRunOptions,
): Promise<AgentResult> {
  const pre = deps.sessions.get(id);
  if (!pre) {
    throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
      stage: "session",
      sessionId: id,
    });
  }

  if (pre.state === "CREATED") {
    deps.transition(id, "RUNNING");
  }

  // #591: inject onSessionEstablished so the adapter can bind protocolIds
  // eagerly — before any prompt runs. If the run is interrupted between
  // session-established and result-returned, the descriptor already
  // carries the correlation needed to resume. The caller's own callback
  // (if any) is chained afterwards so both fire.
  const callerCallback = request.runOptions.onSessionEstablished;
  const injectedRequest: AgentRunRequest = {
    ...request,
    runOptions: {
      ...request.runOptions,
      onSessionEstablished: (protocolIds, sessionName) => {
        try {
          deps.bindHandle(id, sessionName, protocolIds);
        } catch (err) {
          getLogger().warn("session", "bindHandle via onSessionEstablished failed", {
            storyId: deps.sessions.get(id)?.storyId,
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        callerCallback?.(protocolIds, sessionName);
      },
    },
  };

  const config = request.runOptions.config;
  const maxRetriable = config?.execution?.sessionErrorRetryableMaxRetries ?? 3;
  const maxNonRetriable = config?.execution?.sessionErrorMaxRetries ?? 1;
  let sessionRetries = 0;

  let result: AgentResult;
  // Session-transport retry loop: retries only on fail-adapter-error.
  // Auth/rate-limit failures surface immediately so AgentManager's fallback
  // and backoff logic fires without a SessionManager-level retry doubling up.
  while (true) {
    try {
      result = await agentManager.run(injectedRequest);
    } catch (err) {
      if (deps.sessions.get(id)?.state === "RUNNING") {
        deps.transition(id, "FAILED");
      }
      throw err;
    }

    if (result.adapterFailure?.outcome === "fail-adapter-error") {
      const max = result.adapterFailure.retriable ? maxRetriable : maxNonRetriable;
      if (sessionRetries < max && !request.signal?.aborted) {
        sessionRetries++;
        getLogger().warn("session", "Session transport error — retrying with fresh session", {
          sessionId: id,
          storyId: deps.sessions.get(id)?.storyId,
          retriable: result.adapterFailure.retriable,
          attempt: sessionRetries,
          maxAttempts: max,
        });
        continue;
      }
    }
    break;
  }

  if (result.protocolIds) {
    const current = deps.sessions.get(id);
    const handle = current?.handle;
    if (handle) {
      deps.bindHandle(id, handle, result.protocolIds);
    } else {
      const updated: SessionDescriptor = {
        ...(current as SessionDescriptor),
        protocolIds: result.protocolIds,
        lastActivityAt: deps.now(),
      };
      deps.sessions.set(id, updated);
      deps.persistDescriptor(updated);
    }
  }

  // Gap A: reconcile descriptor.agent after an agent swap in AgentManager.
  // agentFallbacks.at(-1).newAgent is the final agent used; handoff() updates
  // the descriptor so crash recovery and metrics see the correct agent name.
  const finalAgent = result.agentFallbacks?.at(-1)?.newAgent;
  if (finalAgent) {
    const current = deps.sessions.get(id);
    if (current && finalAgent !== current.agent) {
      deps.handoff(id, finalAgent, "post-run-reconcile");
    }
  }

  const current = deps.sessions.get(id);
  if (current?.state === "RUNNING") {
    deps.transition(id, result.success ? "COMPLETED" : "FAILED");
  }

  return result;
}
