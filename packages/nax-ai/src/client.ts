/**
 * The client: the only thing a consumer constructs.
 *
 * It selects a protocol from `ResolvedModel.protocol`, so a consumer never
 * names one. That indirection is what makes replacing a protocol's backend
 * invisible to callers.
 */

import { collectStream } from "./protocols/collect.ts";
import { assertProtocolOverridesDeclared } from "./protocols/override-declaration.ts";
import { type BackendSelection, createRegistry, type ProtocolEntries } from "./protocols/registry.ts";
import { assertValidHeaders, assertValidSessionId } from "./protocols/request-headers.ts";
import { retryTransportFaults } from "./protocols/retry.ts";
import { clampThinkingLevel } from "./protocols/thinking.ts";
import type { ProtocolEvent, ProtocolRequest } from "./protocols/types.ts";
import { normaliseCatalog, type RawProvider } from "./providers/catalog.ts";
import type { Pricing, ProviderOverride, ResolvedModel } from "./providers/types.ts";
import type { CompleteResult } from "./types.ts";

/**
 * Builds protocol entries from the options the client already holds.
 *
 * Its one argument exists so `providerOverrides` can be declared once instead
 * of twice. Both catalogs need them (see ProtocolOptions.providerOverrides),
 * and a consumer who writes the array out separately for each side can get one
 * of the two wrong — which is issue #36 with no diagnostic. Taking the array
 * back from the client removes the second place it could be wrong.
 *
 * The object form, rather than a bare array parameter, is so a later
 * client-held option can be added to it without a breaking signature change.
 */
export type ProtocolFactory = (options: { readonly providerOverrides: readonly ProviderOverride[] }) => ProtocolEntries;

export interface ClientOptions {
  readonly providers: readonly RawProvider[];
  /**
   * The protocol entries, or a factory the client calls with its own options.
   *
   * The union is additive: a caller passing plain entries — including
   * hand-built ones — is unaffected. See {@link ProtocolFactory} for why the
   * factory form is the one to prefer when overrides are in play.
   */
  readonly protocols: ProtocolEntries | ProtocolFactory;
  readonly backends?: BackendSelection;
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

/** Matches the doc comment on `ClientOptions.transportRetries`. */
const DEFAULT_TRANSPORT_RETRIES = 2;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createClient(options: ClientOptions): Client {
  const providerOverrides = options.providerOverrides ?? [];
  const catalog = normaliseCatalog(options.providers, providerOverrides);
  // The factory is handed the client's own overrides, so entries built through
  // it cannot disagree with the client about what was overridden. Entries
  // passed directly are taken as given and merely checked below.
  const protocols =
    typeof options.protocols === "function" ? options.protocols({ providerOverrides }) : options.protocols;
  // Before the registry, and at construction rather than in validate(): an
  // override the protocol side never heard about resolves and prices happily
  // and only fails once a request reaches the wire (issue #36). The base
  // catalog is consulted so that amending a model the providers already carry
  // — correcting stale pricing, say — is not held to a declaration the wire
  // does not need.
  const baseModelIds = new Map<string, ReadonlySet<string>>(
    options.providers.map((provider) => [provider.id, new Set(provider.models.map((model) => model.id))]),
  );
  assertProtocolOverridesDeclared(
    providerOverrides,
    protocols,
    (provider, modelId) => baseModelIds.get(provider)?.has(modelId) ?? false,
  );
  const registry = createRegistry(protocols, options.backends ?? {});

  // A negative value is a config bug, not a policy choice — clamping it to 0
  // would silently disable retry instead of telling the caller their option
  // is nonsense. Checked here, once, rather than per stream() call.
  const transportRetries = options.transportRetries ?? DEFAULT_TRANSPORT_RETRIES;
  if (transportRetries < 0) {
    throw new Error(`transportRetries must be >= 0, got ${transportRetries}.`);
  }

  /**
   * Called by stream() and complete() before either returns, not from inside
   * the generator: a caller error should surface at the call, and an async
   * generator defers its body until the first next(). complete() collected
   * immediately and so already looked eager; stream() did not, and returned a
   * lazy iterable that only failed once someone pulled from it.
   */
  function validateRequest(req: ClientRequest): void {
    assertValidHeaders(req.headers);
    // A session id becomes a header value downstream — in the vendor header
    // here and in pi-ai's own affinity headers — so it gets the same check.
    assertValidSessionId(req.sessionId);
  }

  async function* streamFrom(model: ResolvedModel, req: ClientRequest): AsyncIterable<ProtocolEvent> {
    const protocol = await registry.resolve(model.protocol);
    const thinking = req.thinking !== undefined ? clampThinkingLevel(req.thinking, model.thinkingLevels) : undefined;

    const protocolRequest: ProtocolRequest = {
      ...req,
      model: model.id,
      provider: model.provider,
      ...(thinking !== undefined ? { thinking } : {}),
    };

    yield* retryTransportFaults(() => protocol.stream(protocolRequest), {
      retries: transportRetries,
      sleep: realSleep,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
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
      validateRequest(req);
      return streamFrom(model, req);
    },

    // `async` deliberately: validateRequest throws, and an async function turns
    // that into a rejected promise. A synchronous throw from a promise-returning
    // method would break every caller using .catch() rather than try/await.
    async complete(model, req) {
      validateRequest(req);
      return collectStream(streamFrom(model, req));
    },

    validate() {
      registry.validate();
    },
  };
}
