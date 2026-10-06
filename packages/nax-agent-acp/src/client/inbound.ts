/**
 * Messages the agent initiates (S4 spec §6.3, §6.4, §6.8). While a turn runs the
 * router holds one binding: the agent session the turn prompts, its collector and
 * its signal. session/update reaches that collector only when it names the bound
 * session; anything else is dropped. session/request_permission and
 * elicitation/create for the bound session go to the backend's decider and
 * elicitation handler with the binding's signal, which aborts when the turn is
 * cancelled, times out or loses its process, and when the binding is released
 * (D3-d, D5-k). A permission request first announces its tool call on the turn's
 * events (D5-c). Any other request (no turn, another session, a request-scoped
 * elicitation, more than MAX_PENDING_DECISIONS pending at once) is answered locally,
 * a permission rejected and an elicitation cancelled, and raises no event; each
 * reason is logged once per session and kind (D3-c). Releasing a binding aborts its
 * pending requests and waits for their answers, so approval_resolved always
 * precedes turn_end.
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { getLogger } from "@nathapp/nax-agent";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";
import { rejectLocally } from "#src/client/permissions";
import { isRecord } from "#src/client/text";

/** Concurrent permission requests and elicitations one turn may hold; further ones are answered locally. */
export const MAX_PENDING_DECISIONS = 16;

export type PermissionDecider = (
  request: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export type ElicitationHandler = (
  request: CreateElicitationRequest,
  signal: AbortSignal,
) => Promise<CreateElicitationResponse>;

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /**
   * Routes `agentSessionId`'s updates, permission requests and elicitations to this
   * turn. `turnSignal` aborts the turn's requests (cancel, timeout, process gone).
   * The returned function detaches the turn, aborts its pending requests and
   * resolves once each has been answered.
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
type RequestKind = "permission" | "elicitation";

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
  readonly scope: AbortController;
  /** The scope and the turn signal: what every request of this turn is given. */
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<unknown>>;
}

const LOG_MESSAGES: Readonly<Record<RequestKind, string>> = {
  permission: "Rejected a permission request locally",
  elicitation: "Cancelled an elicitation locally",
};

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
const CANCEL_ELICITATION: CreateElicitationResponse = { action: "cancel" };
const cancelElicitation = async (): Promise<CreateElicitationResponse> => CANCEL_ELICITATION;

async function track<T>(binding: Binding, answer: Promise<T>): Promise<T> {
  binding.pending.add(answer);
  try {
    return await answer;
  } finally {
    binding.pending.delete(answer);
  }
}

/** The session an elicitation names; undefined for a request-scoped one. */
function sessionOf(request: unknown): string | undefined {
  return isRecord(request) && typeof request.sessionId === "string" ? request.sessionId : undefined;
}

export function createInboundRouter(
  decide: PermissionDecider,
  elicit: ElicitationHandler = cancelElicitation,
): InboundRouter {
  let active: Binding | undefined;
  const logged = new Set<string>();
  const log = (kind: RequestKind, reason: Rejection): void => {
    const key = `${kind}:${reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    try {
      getLogger().warn("acp", LOG_MESSAGES[kind], { reason });
    } catch {
      // A throwing host logger must not change the answer.
    }
  };
  /** The binding a request may use, or why not. */
  const admit = (sessionId: string | undefined): Binding | Rejection => {
    const binding = active;
    if (binding === undefined) return "no-turn";
    if (sessionId !== binding.sessionId) return "foreign-session";
    return binding.pending.size >= MAX_PENDING_DECISIONS ? "too-many" : binding;
  };
  /** A request refused while the turn is being aborted is answered as cancelled, not rejected (S4-3). */
  const aborting = (reason: Rejection): boolean => reason !== "no-turn" && active?.signal.aborted === true;
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => {
        const admitted = admit(request.sessionId);
        if (typeof admitted === "string") {
          if (aborting(admitted)) return cancelled();
          log("permission", admitted);
          return rejectLocally(request);
        }
        if (!admitted.signal.aborted) admitted.collector.announce(request.toolCall);
        return track(admitted, decide(request, admitted.signal).catch(cancelled));
      },
      onElicitation: async (request) => {
        const admitted = admit(sessionOf(request));
        if (typeof admitted === "string") {
          if (!aborting(admitted)) log("elicitation", admitted);
          return CANCEL_ELICITATION;
        }
        return track(admitted, elicit(request, admitted.signal).catch(cancelElicitation));
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
