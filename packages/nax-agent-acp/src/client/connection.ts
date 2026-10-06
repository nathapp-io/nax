/**
 * The ACP client connection (S4 spec §6.1 connection). One ClientApp per agent
 * process, attached with connect() for the session's lifetime (not connectWith).
 * Outbound calls use the connection's request API directly; inbound
 * session/update, session/request_permission and elicitation/create go to the
 * backend's handlers. Requests are not bounded here: callers race them (race.ts),
 * because the SDK's cancellation is cooperative and still waits for the agent's answer.
 */
import {
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  client,
  type InitializeRequest,
  type InitializeResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "#src/client/launch";

export interface InboundHandlers {
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export interface AcpLink {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** Resolves when the connection closes, for any reason. */
  readonly closed: Promise<void>;
  /** Closes the connection; pending requests reject. */
  close(reason?: unknown): void;
}

export function openConnection(target: LaunchTarget, handlers: InboundHandlers): AcpLink {
  const app = client({ name: "nax-agent-acp" })
    .onNotification(methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
    .onRequest(methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params))
    .onRequest(methods.client.elicitation.create, (ctx) => handlers.onElicitation(ctx.params));
  const connection: ClientConnection =
    target.kind === "stream" ? app.connect(target.stream) : app.connect(target.agent);
  const agent = connection.agent;
  return {
    initialize: (params) => agent.request(methods.agent.initialize, params),
    newSession: (params) => agent.request(methods.agent.session.new, params),
    setConfigOption: (params) => agent.request(methods.agent.session.setConfigOption, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    cancel: (sessionId) => agent.notify(methods.agent.session.cancel, { sessionId }),
    closeSession: async (sessionId) => {
      await agent.request(methods.agent.session.close, { sessionId });
    },
    closed: connection.closed,
    close: (reason) => connection.close(reason),
  };
}
