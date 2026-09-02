/**
 * runTrackedSession — extracted tracked-session lifecycle from SessionManager.
 *
 * Extracted from manager.ts to keep each file within the 600-line project limit.
 * Receives the subset of SessionManager state it needs via a plain object facade
 * to avoid circular imports.
 */

import { buildCodingToolSupport } from "../agents/coding-tool-support";
import type { AgentResult } from "../agents/types";
import { resolvePermissions } from "../config/permissions";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import type { DispatchErrorEvent, IDispatchEventBus } from "../runtime/dispatch-events";
import type { ProtocolIds } from "../runtime/protocol-types";
import { errorMessage } from "../utils/errors";
import { _sessionManagerDeps } from "./manager-deps";
import type {
  NameForRequest,
  SessionDescriptor,
  SessionManagedRunRequest,
  SessionRunClient,
  SessionState,
  TransitionOptions,
} from "./types";

/** Minimal SessionManager surface needed by runTrackedSession. */
export interface SessionManagerState {
  sessions: Map<string, SessionDescriptor>;
  transition(id: string, to: SessionState, opts?: TransitionOptions): SessionDescriptor;
  bindHandle(id: string, handle: string, protocolIds: ProtocolIds): SessionDescriptor;
  handoff(id: string, agent: string, reason?: string): SessionDescriptor;
  persistDescriptor(descriptor: SessionDescriptor): void;
  dispatchEvents: IDispatchEventBus;
  defaultAgent: string;
  nameFor(req: NameForRequest): string;
}

/**
 * Tracked-session form of runInSession — preserves descriptor lifecycle
 * bookkeeping for callers that provide a run client rather than direct
 * prompt/callback usage.
 */
export async function runTrackedSession(
  state: SessionManagerState,
  id: string,
  runner: SessionRunClient,
  request: SessionManagedRunRequest,
): Promise<AgentResult> {
  const startedAt = Date.now();
  const pre = state.sessions.get(id);
  if (!pre) {
    throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
      stage: "session",
      sessionId: id,
    });
  }

  if (pre.state === "CREATED") {
    state.transition(id, "RUNNING");
  }

  const stage = request.runOptions.pipelineStage ?? "run";
  const resolvedPermissions =
    request.runOptions.resolvedPermissions ?? resolvePermissions(request.runOptions.config, stage);

  // The seam that makes coding tools reachable: turn the op's declared tools
  // plus the resolved grants into a live runtime. Must run before
  // injectedRequest below, which spreads the result into runOptions.
  const codingSupport = buildCodingToolSupport({
    root: request.runOptions.codingToolRoot,
    grants: resolvedPermissions.toolGrants,
    declared: request.runOptions.declaredTools ?? [],
  });

  const callerCallback = request.runOptions.onSessionEstablished;
  const injectedRequest: SessionManagedRunRequest = {
    ...request,
    runOptions: {
      ...request.runOptions,
      onSessionEstablished: (protocolIds, sessionName) => {
        try {
          state.bindHandle(id, sessionName, protocolIds);
        } catch (err) {
          getLogger().warn("session", "bindHandle via onSessionEstablished failed", {
            storyId: state.sessions.get(id)?.storyId,
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        callerCallback?.(protocolIds, sessionName);
      },
      ...(codingSupport ? { codingToolRuntime: codingSupport.runtime, codingTools: codingSupport.tools } : {}),
    },
  };

  const config = request.runOptions.config;
  const maxRetriable = config?.execution?.sessionErrorRetryableMaxRetries ?? 3;
  const maxNonRetriable = config?.execution?.sessionErrorMaxRetries ?? 1;
  let sessionRetries = 0;

  let result: AgentResult;
  while (true) {
    try {
      result = await runner.run(injectedRequest);
    } catch (err) {
      if (state.sessions.get(id)?.state === "RUNNING") {
        state.transition(id, "FAILED");
      }
      state.dispatchEvents.emitDispatchError({
        kind: "error",
        origin: "runTrackedSession",
        agentName: pre.agent ?? state.defaultAgent,
        stage,
        storyId: pre.storyId,
        errorCode: err instanceof NaxError ? err.code : "DISPATCH_ERROR",
        errorMessage: errorMessage(err),
        prompt: request.runOptions.prompt,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
        resolvedPermissions,
      } satisfies DispatchErrorEvent);
      throw err;
    }

    if (result.adapterFailure?.outcome === "fail-adapter-error") {
      const max = result.adapterFailure.retriable ? maxRetriable : maxNonRetriable;
      if (sessionRetries < max && !request.signal?.aborted) {
        sessionRetries++;
        getLogger().warn("session", "Session transport error — retrying with fresh session", {
          sessionId: id,
          storyId: state.sessions.get(id)?.storyId,
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
    const current = state.sessions.get(id);
    const handle = current?.handle;
    if (handle) {
      state.bindHandle(id, handle, result.protocolIds);
    } else if (current) {
      const updated: SessionDescriptor = {
        ...current,
        protocolIds: result.protocolIds,
        lastActivityAt: _sessionManagerDeps.now(),
      };
      state.sessions.set(id, updated);
      state.persistDescriptor(updated);
    }
  }

  const finalAgent = result.agentFallbacks?.at(-1)?.newAgent;
  if (finalAgent) {
    const current = state.sessions.get(id);
    if (current && finalAgent !== current.agent) {
      state.handoff(id, finalAgent, "post-run-reconcile");
    }
  }

  const current = state.sessions.get(id);
  if (current?.state === "RUNNING") {
    state.transition(id, result.success ? "COMPLETED" : "FAILED");
  }

  // Dispatch is intentionally omitted here. runTrackedSession is a lifecycle
  // wrapper (descriptor state transitions, bindHandle, handoff reconciliation).
  // The SessionTurnDispatchEvent is emitted by agentManager.runAsSession, which
  // is called from within runner.run() via createSessionRunHop. Emitting here
  // too produced duplicate audit files — one from runAsSession and one from
  // runTrackedSession — for each TDD session turn. See PR #1007 (which wired
  // runAsSession) and the fix that removed this second emission.
  return result;
}
