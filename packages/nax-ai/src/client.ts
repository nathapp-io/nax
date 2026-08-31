/**
 * The client: the only thing a consumer constructs.
 *
 * It selects a protocol from `ResolvedModel.protocol`, so a consumer never
 * names one. That indirection is what makes replacing a protocol's backend
 * invisible to callers.
 */

import { collectStream } from "./protocols/collect.ts";
import { type BackendSelection, createRegistry, type ProtocolEntries } from "./protocols/registry.ts";
import { clampThinkingLevel } from "./protocols/thinking.ts";
import type { ProtocolEvent, ProtocolRequest } from "./protocols/types.ts";
import { normaliseCatalog, type RawProvider } from "./providers/catalog.ts";
import type { Pricing, ProviderOverride, ResolvedModel } from "./providers/types.ts";
import type { CompleteResult, CredentialStore } from "./types.ts";

export interface ClientOptions {
  readonly providers: readonly RawProvider[];
  readonly protocols: ProtocolEntries;
  readonly backends?: BackendSelection;
  readonly credentials?: CredentialStore;
  readonly providerOverrides?: readonly ProviderOverride[];
  /** Transport-fault retries before the first event. Default 2; 0 disables. */
  readonly transportRetries?: number;
}

/** Everything on ProtocolRequest except `model`, which the client supplies. */
export type ClientRequest = Omit<ProtocolRequest, "model">;

export interface Client {
  model(provider: string, model: string): Promise<ResolvedModel>;
  listModels(provider?: string): Promise<readonly ResolvedModel[]>;
  pricing(model: ResolvedModel): Pricing;
  stream(model: ResolvedModel, req: ClientRequest): AsyncIterable<ProtocolEvent>;
  complete(model: ResolvedModel, req: ClientRequest): Promise<CompleteResult>;
  validate(): void;
}

export function createClient(options: ClientOptions): Client {
  const catalog = normaliseCatalog(options.providers, options.providerOverrides ?? []);
  const registry = createRegistry(options.protocols, options.backends ?? {});

  async function* streamFrom(model: ResolvedModel, req: ClientRequest): AsyncIterable<ProtocolEvent> {
    const protocol = await registry.resolve(model.protocol);
    const thinking = req.thinking !== undefined ? clampThinkingLevel(req.thinking, model.thinkingLevels) : undefined;

    const protocolRequest: ProtocolRequest = {
      ...req,
      model: model.id,
      ...(thinking !== undefined ? { thinking } : {}),
    };

    yield* protocol.stream(protocolRequest);
  }

  return {
    async model(provider, model) {
      const resolved = catalog.model(provider, model);
      if (resolved === undefined) {
        throw new Error(`Unknown model "${model}" for provider "${provider}".`);
      }
      return resolved;
    },

    async listModels(provider) {
      return catalog.listModels(provider);
    },

    pricing(model) {
      return model.pricing;
    },

    stream(model, req) {
      return streamFrom(model, req);
    },

    complete(model, req) {
      return collectStream(streamFrom(model, req));
    },

    validate() {
      registry.validate();
    },
  };
}
