/**
 * What a server session needs from its client (S5 spec §4.3): session updates,
 * permission requests and form elicitations, plus the optional features the
 * client declared in `initialize`. Sessions and brokers depend on this port,
 * not on the SDK connection.
 */
import type {
  AgentContext,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationSchema,
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ClientUpdates } from "#src/server/translate/events";

export interface ClientFeatures {
  readonly updates: ClientUpdates;
  /** The client declared form elicitation (`clientCapabilities.elicitation.form`). */
  readonly elicitation: boolean;
  /** The client runs terminal auth methods (`clientCapabilities.auth.terminal: true`, S5-4). */
  readonly terminalAuth: boolean;
}

export const NO_CLIENT_FEATURES: ClientFeatures = {
  updates: { notices: false, compaction: false },
  elicitation: false,
  terminalAuth: false,
};

const present = (value: unknown): boolean => value !== undefined && value !== null;

export function clientFeatures(caps: ClientCapabilities | undefined): ClientFeatures {
  return {
    updates: { notices: present(caps?.session?.notices), compaction: present(caps?.session?.compaction) },
    elicitation: present(caps?.elicitation?.form),
    terminalAuth: caps?.auth?.terminal === true,
  };
}

export interface PermissionAsk {
  readonly toolCall: ToolCallUpdate;
  readonly options: readonly PermissionOption[];
}

export interface ElicitationForm {
  readonly message: string;
  readonly requestedSchema: ElicitationSchema;
}

export interface ClientPort {
  readonly features: ClientFeatures;
  update(update: SessionUpdate): Promise<void>;
  /** Aborting `signal` sends `$/cancel_request`; callers stop waiting with `untilAborted`. */
  requestPermission(ask: PermissionAsk, signal: AbortSignal): Promise<RequestPermissionResponse>;
  elicit(form: ElicitationForm, signal: AbortSignal): Promise<CreateElicitationResponse>;
}

export function clientPort(context: AgentContext, sessionId: string, features: ClientFeatures): ClientPort {
  return {
    features,
    update: (update) => context.notify("session/update", { sessionId, update }),
    requestPermission: (ask, signal) =>
      context.request(
        "session/request_permission",
        { sessionId, toolCall: ask.toolCall, options: [...ask.options] },
        { cancellationSignal: signal },
      ),
    elicit: (form, signal) => {
      const request: CreateElicitationRequest = {
        sessionId,
        mode: "form",
        message: form.message,
        requestedSchema: form.requestedSchema,
      };
      return context.request("elicitation/create", request, { cancellationSignal: signal });
    },
  };
}

/**
 * The work's result, or a rejection as soon as `signal` aborts. SDK cancellation
 * is cooperative (the request promise waits for the peer), so a client that never
 * answers would otherwise hold the turn.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
