/**
 * Messages the agent initiates (S4 spec §6.3, §6.4). While a turn runs the router
 * holds one binding: the agent session the turn prompts, its collector and its
 * signal. session/update reaches that collector only when it names the bound
 * session; anything else is dropped. session/request_permission for the bound
 * session goes to the backend's decider with the binding's signal, which aborts
 * when the turn is cancelled, times out or loses its process, and when the binding
 * is released (D3-d). Any other request (no turn, another session, more than
 * MAX_PENDING_DECISIONS at once) is rejected locally and raises no event; each
 * reason is logged once per session (D3-c). Releasing a binding aborts its pending
 * decisions and waits for their answers, so approval_resolved always precedes
 * turn_end.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { getLogger } from "@nathapp/nax-agent";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";
import { rejectLocally } from "#src/client/permissions";

/** Concurrent permission decisions one turn may hold; further requests are rejected locally. */
export const MAX_PENDING_DECISIONS = 16;

export type PermissionDecider = (
  request: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /**
   * Routes `agentSessionId`'s updates and permission requests to this turn.
   * `turnSignal` aborts the turn's decisions (cancel, timeout, process gone). The
   * returned function detaches the turn, aborts its pending permission decisions
   * and resolves once each has been answered.
   */
  attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>;
  /**
   * The running turn's binding signal, or undefined between turns: what an
   * embedder tool call runs under (S4-4 D4-f). It aborts on cancel, timeout,
   * close and process exit, and when the binding is released.
   */
  activeSignal(): AbortSignal | undefined;
}

type Rejection = "no-turn" | "foreign-session" | "too-many";

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
  readonly scope: AbortController;
  /** The scope and the turn signal: what every decision of this turn is given. */
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<RequestPermissionResponse>>;
}

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });

async function decideInTurn(
  binding: Binding,
  decide: PermissionDecider,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const answer = decide(request, binding.signal).catch(cancelled);
  binding.pending.add(answer);
  try {
    return await answer;
  } finally {
    binding.pending.delete(answer);
  }
}

export function createInboundRouter(decide: PermissionDecider): InboundRouter {
  let active: Binding | undefined;
  const logged = new Set<Rejection>();
  const reject = (request: RequestPermissionRequest, reason: Rejection): RequestPermissionResponse => {
    if (!logged.has(reason)) {
      logged.add(reason);
      try {
        getLogger().warn("acp", "Rejected a permission request locally", { reason });
      } catch {
        // A throwing host logger must not change the answer.
      }
    }
    return rejectLocally(request);
  };
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => {
        const binding = active;
        if (binding === undefined) return reject(request, "no-turn");
        const aborted = binding.signal.aborted;
        if (request.sessionId !== binding.sessionId) return aborted ? cancelled() : reject(request, "foreign-session");
        if (binding.pending.size >= MAX_PENDING_DECISIONS) return aborted ? cancelled() : reject(request, "too-many");
        return decideInTurn(binding, decide, request);
      },
    },
    activeSignal: () => active?.signal,
    attach(sessionId, collector, turnSignal) {
      const scope = new AbortController();
      const binding: Binding = {
        sessionId,
        collector,
        scope,
        signal: AbortSignal.any([scope.signal, turnSignal]),
        pending: new Set(),
      };
      active = binding;
      return async () => {
        if (active === binding) active = undefined;
        scope.abort();
        await Promise.allSettled([...binding.pending]);
      };
    },
  };
}
