/**
 * Messages the agent initiates (S4 spec §6.3 "Inbound requests with no active
 * turn"). session/update reaches the running turn's collector only when it names
 * the attached agent session; anything else is dropped. S4-2 answers every
 * session/request_permission locally with the agent's reject_once option, or
 * `cancelled` when it offered none: fail closed, no event (D-d). S4-3 routes
 * them by profile (§6.4).
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /** Routes updates for `agentSessionId` to `collector`; the returned function detaches it. */
  attach(agentSessionId: string, collector: TurnCollector): () => void;
}

export function rejectLocally(request: RequestPermissionRequest): RequestPermissionResponse {
  const options = Array.isArray(request.options) ? request.options : [];
  const reject = options.find((option) => option.kind === "reject_once");
  return reject === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: reject.optionId } };
}

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
}

export function createInboundRouter(): InboundRouter {
  let active: Binding | undefined;
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => rejectLocally(request),
    },
    attach(sessionId, collector) {
      const binding: Binding = { sessionId, collector };
      active = binding;
      return () => {
        if (active === binding) active = undefined;
      };
    },
  };
}
