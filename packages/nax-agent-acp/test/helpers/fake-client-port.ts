/** A scripted ClientPort: records what the server sends and answers as told. */
import type { CreateElicitationResponse, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type ClientFeatures,
  type ClientPort,
  type ElicitationForm,
  NO_CLIENT_FEATURES,
  type PermissionAsk,
} from "#src/server/client-port";

export const ALL_FEATURES: ClientFeatures = { updates: { notices: true, compaction: true }, elicitation: true };

/** A client that never answers. */
export const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

export function select(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

export interface FakePortOptions {
  readonly features?: ClientFeatures;
  readonly permission?: (ask: PermissionAsk) => Promise<RequestPermissionResponse>;
  readonly elicit?: (form: ElicitationForm) => Promise<CreateElicitationResponse>;
  readonly failUpdates?: boolean;
}

export interface FakePort {
  readonly port: ClientPort;
  readonly updates: SessionUpdate[];
  readonly asks: PermissionAsk[];
  readonly forms: ElicitationForm[];
  readonly signals: AbortSignal[];
}

export function fakePort(options: FakePortOptions = {}): FakePort {
  const updates: SessionUpdate[] = [];
  const asks: PermissionAsk[] = [];
  const forms: ElicitationForm[] = [];
  const signals: AbortSignal[] = [];
  const port: ClientPort = {
    features: options.features ?? NO_CLIENT_FEATURES,
    update: async (update) => {
      if (options.failUpdates === true) throw new Error("client connection closed");
      updates.push(update);
    },
    requestPermission: (ask, signal) => {
      asks.push(ask);
      signals.push(signal);
      return (options.permission ?? (async () => select("allow_once")))(ask);
    },
    elicit: (form, signal) => {
      forms.push(form);
      signals.push(signal);
      return (options.elicit ?? (async (): Promise<CreateElicitationResponse> => ({ action: "cancel" })))(form);
    },
  };
  return { port, updates, asks, forms, signals };
}
