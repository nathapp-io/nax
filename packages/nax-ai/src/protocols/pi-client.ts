/**
 * The pi-ai-backed protocol.
 *
 * This file and the two other files on the ALLOWED list in
 * scripts/check-pi-ai-imports.ts are the only places pi-ai may be imported.
 * Nothing exported here may expose a pi-ai type in a shape a consumer sees.
 *
 * One implementation serves all four protocols. They differ only in where a
 * system prompt sits in the wire request, and pi-ai's Context carries it in a
 * dedicated field, so on this path the difference does not exist. The protocol
 * name is still a parameter because a per-api quirk would branch on it.
 */

import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  MutableModels,
  Message as PiMessage,
  Provider as PiProvider,
  Tool as PiTool,
  Usage as PiUsage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createPiAuthResolver, toPiCredentialStore } from "../auth/pi-auth.ts";
import type { AuthResolver } from "../auth/resolver.ts";
import { assertOverrideModelProvider } from "../providers/override-model.ts";
import type { Pricing, ProviderOverride, ResolvedModel } from "../providers/types.ts";
import type { CredentialStore, StopReason } from "../types.ts";
import { toTokenUsage, totalTokens } from "../usage.ts";
import { vendorAppHeaders } from "./client-app.ts";
import { classifyProviderError, classifyThrown, parseRetryAfter } from "./errors.ts";
import type { PiProtocolOptions } from "./pi-protocols.ts";
import { assertValidHeaders, assertValidSessionId, mergeRequestHeaders, withoutEmpty } from "./request-headers.ts";
import { vendorSessionHeaders } from "./session-id.ts";
import { createToolArgAccumulator, parseToolArgs } from "./tool-args.ts";
import type {
  ConversationMessage,
  Protocol,
  ProtocolEvent,
  ProtocolRequest,
  ThinkingBlock,
  Transport,
} from "./types.ts";

export interface PiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export type PiStreamFn = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  /**
   * Called once, before the body is consumed. pi-ai's error event carries no
   * status and no retry-after, so without this the classifier would return
   * "unknown" for every failure and the consumer's retry policy — which M1
   * section 10.1 deliberately assigns to the consumer — would be blind.
   */
  onResponse: (response: PiResponse) => void,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiDeps {
  readonly resolveModel: (modelId: string, provider?: string) => Promise<Model<Api>>;
  readonly stream: PiStreamFn;
}

/**
 * pi-ai's Message requires a timestamp, but no wire module under its api/
 * directory reads one. A constant keeps translation deterministic; Date.now()
 * would make tests flap over a field that is never sent.
 */
const NO_TIMESTAMP = 0;

/** Placeholder accounting for a replayed assistant turn. Never sent upstream. */
const NO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function toPiTool(tool: ProtocolRequest["tools"] extends readonly (infer T)[] | undefined ? T : never): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // pi-ai types this as a TypeBox TSchema, which is a JSON Schema object at
    // runtime. nax-ai does not validate schemas; it forwards what it was given.
    parameters: tool.inputSchema as PiTool["parameters"],
    ...(tool.constrainedSampling !== undefined ? { constrainedSampling: tool.constrainedSampling } : {}),
  };
}

/**
 * pi's ThinkingContent, from our ThinkingBlock. `thinkingSignature` is left
 * unset rather than "" when absent, because pi's own request-side handling
 * (dist/api/anthropic-messages.js:923-957) treats "no signature" and "empty
 * signature" differently — a synthesised "" would pick the wrong branch.
 */
function toPiThinking(block: ThinkingBlock): {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
} {
  return {
    type: "thinking",
    thinking: block.text,
    ...(block.signature !== undefined ? { thinkingSignature: block.signature } : {}),
    ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
  };
}

function toPiMessages(messages: readonly ConversationMessage[], model: Model<Api>): PiMessage[] {
  const toolNames = new Map<string, string>();
  const out: PiMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content, timestamp: NO_TIMESTAMP });
      continue;
    }

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      out.push({
        role: "assistant",
        content: [
          // Anthropic requires thinking blocks to lead the assistant
          // message when present — this is a wire ordering requirement, not
          // a style choice, so it goes first unconditionally.
          ...(message.thinking ?? []).map(toPiThinking),
          ...(message.content === "" ? [] : [{ type: "text" as const, text: message.content }]),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: (call.input ?? {}) as Record<string, unknown>,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: NO_USAGE,
        stopReason: "stop",
        timestamp: NO_TIMESTAMP,
      });
      continue;
    }

    // toolName is not on our ConversationMessage but is read on the wire by
    // several providers, so it is recovered from the call that produced this
    // result. No match means the caller assembled an impossible conversation.
    const toolName = toolNames.get(message.toolCallId);
    if (toolName === undefined) {
      throw new Error(
        `Tool result references tool call "${message.toolCallId}", which no earlier assistant message made.`,
      );
    }

    out.push({
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName,
      content: [{ type: "text", text: message.content }],
      isError: message.isError ?? false,
      timestamp: NO_TIMESTAMP,
    });
  }

  return out;
}

export function toPiContext(req: ProtocolRequest, model: Model<Api>): Context {
  return {
    ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
    messages: toPiMessages(req.messages, model),
    ...(req.tools !== undefined ? { tools: req.tools.map(toPiTool) } : {}),
  };
}

export function toPiOptions(req: ProtocolRequest): SimpleStreamOptions {
  return {
    ...(req.toolChoice !== undefined ? { toolChoice: req.toolChoice } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.cacheRetention !== undefined ? { cacheRetention: req.cacheRetention } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
    ...(req.headers !== undefined ? { headers: { ...req.headers } } : {}),
    // Empty is treated as absent, matching vendorSessionHeaders: an id that
    // cannot identify anything should not reach pi as though it could.
    ...(req.sessionId !== undefined && req.sessionId !== "" ? { sessionId: req.sessionId } : {}),
    // pi-ai's scale has no "off": the absence of the field is how thinking is
    // disabled, so mapping "off" to a value would silently enable it.
    ...(req.thinking !== undefined && req.thinking !== "off" ? { reasoning: req.thinking } : {}),
  };
}

/**
 * pi-ai's terminal reasons, narrowed to ours.
 *
 * "deferred" is absent by design: we never request a deferred response, so
 * receiving one means an assumption broke and it must surface rather than be
 * folded into "stop". "content_filter" has no pi-ai equivalent and is
 * unreachable here; it exists for a hand-written backend.
 */
const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_use",
};

/** The in-progress tool call at a content index, when there is one. */
function toolCallAt(partial: { content: readonly unknown[] }, index: number): { id: string; name: string } | undefined {
  const block = partial.content[index];
  if (typeof block !== "object" || block === null) return undefined;
  const candidate = block as { type?: unknown; id?: unknown; name?: unknown };
  if (candidate.type !== "toolCall" || typeof candidate.id !== "string" || typeof candidate.name !== "string") {
    return undefined;
  }
  return { id: candidate.id, name: candidate.name };
}

/**
 * The signature and redacted flag for the thinking block at a content index,
 * when the block at that index has that shape. `thinking_end`'s own event
 * carries no signature — pi accumulates it onto the block in `partial`
 * during the stream (signature_delta, dist/api/anthropic-messages.js:501-502)
 * so by the time the block ends it is complete there. Same trap as
 * `toolCallAt` above: the terminal event is missing fields only the partial
 * carries.
 */
function thinkingBlockAt(
  partial: { content: readonly unknown[] },
  index: number,
): { signature?: string; redacted?: boolean } {
  const block = partial.content[index];
  if (typeof block !== "object" || block === null) return {};
  const candidate = block as { type?: unknown; thinkingSignature?: unknown; redacted?: unknown };
  if (candidate.type !== "thinking") return {};
  return {
    ...(typeof candidate.thinkingSignature === "string" ? { signature: candidate.thinkingSignature } : {}),
    ...(typeof candidate.redacted === "boolean" ? { redacted: candidate.redacted } : {}),
  };
}

export function createPiProtocol(name: string, deps: PiDeps): Protocol {
  return {
    name,

    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      const model = await deps.resolveModel(req.model, req.provider);
      let observed: PiResponse | undefined;
      const events = deps.stream(model, toPiContext(req, model), toPiOptions(req), (response) => {
        observed = response;
      });
      const toolArgs = createToolArgAccumulator();

      try {
        for await (const event of events) {
          switch (event.type) {
            case "text_delta":
              yield { type: "text-delta", text: event.delta };
              break;

            case "thinking_delta":
              yield { type: "thinking-delta", text: event.delta };
              break;

            case "thinking_end": {
              // Losing thinking text is worse than losing a signature: even
              // when the block at this content index is not the shape we
              // expect, still emit the text `thinking_end` itself carries.
              const { signature, redacted } = thinkingBlockAt(event.partial, event.contentIndex);
              yield {
                type: "thinking",
                block: {
                  text: event.content,
                  ...(signature !== undefined ? { signature } : {}),
                  ...(redacted !== undefined ? { redacted } : {}),
                },
              };
              break;
            }

            case "toolcall_delta": {
              // The delta carries neither id nor name; both are only on the
              // in-progress call block that partial.content holds at this index.
              const call = toolCallAt(event.partial, event.contentIndex);
              if (call === undefined) break;
              const rawInput = toolArgs.append(call.id, call.name, event.delta);
              yield { type: "tool-call-partial", id: call.id, name: call.name, rawInput };
              break;
            }

            case "toolcall_end": {
              const pending = toolArgs.take(event.toolCall.id);
              let input: unknown;
              try {
                input = parseToolArgs(pending?.raw ?? "");
              } catch (cause) {
                // An error event, not a throw: text and usage already yielded
                // must survive.
                yield {
                  type: "error",
                  error: {
                    kind: "bad-request",
                    message: `Tool "${event.toolCall.name}" returned unparseable arguments.`,
                    cause,
                  },
                };
                return;
              }
              yield { type: "tool-call", call: { id: event.toolCall.id, name: event.toolCall.name, input } };
              break;
            }

            case "done": {
              const stopReason = STOP_REASONS[event.reason];
              yield { type: "usage", usage: toTokenUsage(event.message.usage) };
              if (stopReason === undefined) {
                yield {
                  type: "error",
                  error: {
                    kind: "unknown",
                    message: `Upstream reported stop reason "${event.reason}", which nax-ai never requests.`,
                  },
                };
                return;
              }
              yield { type: "done", stopReason };
              return;
            }

            case "error": {
              const status = observed?.status;
              const retryAfter = parseRetryAfter(observed?.headers);
              const usage = toTokenUsage(event.error.usage);
              // A failed request that consumed tokens still bills for them.
              if (totalTokens(usage) > 0) yield { type: "usage", usage };
              const upstreamMessage = event.error.errorMessage;
              yield {
                type: "error",
                error: {
                  // The status alone cannot separate an overflow from a
                  // malformed request; the upstream message can, and it is
                  // already here.
                  kind: classifyProviderError(status, upstreamMessage),
                  message: upstreamMessage ?? `Upstream stream ended: ${event.reason}.`,
                  ...(status !== undefined ? { status } : {}),
                  ...(retryAfter !== undefined ? { retryAfter } : {}),
                },
              };
              return;
            }

            default:
              // start, text_start, text_end, thinking_start and toolcall_start
              // carry nothing our vocabulary expresses: content is already
              // delivered by the deltas (and, for thinking, by "thinking_end"
              // above).
              break;
          }
        }
      } catch (cause) {
        // A stream failure with no HTTP response (connection reset, DNS
        // failure, an immediate socket error) propagates as a raw throw
        // rather than pi-ai's own "error" event — there was never a response
        // to build one from, which is why classifyHttpError(undefined) would
        // otherwise return "unknown" here. The caller's own abort must not be
        // relabelled as a transport fault: retryTransportFaults, and any
        // consumer-level abort handling, both need to see abort as abort.
        if (req.signal?.aborted) throw cause;
        yield { type: "error", error: classifyThrown(cause) };
      }
    },
  };
}

let shared: MutableModels | undefined;

/**
 * The credential-backed twin of `shared`, keyed by the store itself. Each of
 * the four protocol entries resolves lazily through `createPiDeps`, so without
 * this memo a consumer with credentials would construct one Models per entry
 * instead of the single instance pi-protocols.ts promises.
 */
const credentialed = new WeakMap<CredentialStore, MutableModels>();

/** Stands in for "no credential store" as the outer key of `overridden`. */
const AMBIENT_CREDENTIALS: object = {};

/**
 * Catalogs carrying provider overrides, keyed by credential store (or the
 * ambient sentinel) and then by the IDENTITY of the overrides array.
 *
 * Neither `shared` nor `credentialed` may ever be patched: both are process
 * globals, so one client's override would make a phantom model visible to
 * every other client in the process — a subtler bug than the one being fixed.
 * An override therefore always gets its own `builtinModels()` instance.
 *
 * Array identity is the key, rather than the array's contents, for two
 * reasons. `defaultProtocols` hands one options object to all four lazy
 * protocol factories, so keying on identity still yields exactly one Models
 * instance for the four — which is what pi-protocols.ts's header comment
 * promises. And a content key means stringifying externally-supplied data on
 * every construction, which is both slower and wrong the moment an override
 * carries a value JSON does not round-trip. Two separately-constructed but
 * equal arrays getting two catalogs costs memory only; cross-client bleed
 * costs correctness.
 */
const overridden = new WeakMap<object, WeakMap<readonly ProviderOverride[], MutableModels>>();

function toPiCost(pricing: Pricing): Model<Api>["cost"] {
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite,
    ...(pricing.tiers !== undefined
      ? {
          tiers: pricing.tiers.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: tier.input,
            output: tier.output,
            cacheRead: tier.cacheRead,
            cacheWrite: tier.cacheWrite,
          })),
        }
      : {}),
  };
}

/**
 * A pi `Model` for an override entry, templated off a sibling.
 *
 * `ResolvedModel` is deliberately narrower than pi's `Model`: it carries no
 * `name`, `maxTokens`, `baseUrl`, `input` or `compat`, and those are not
 * optional on the wire side. Inventing values for them would be guessing at
 * provider behaviour, so instead every field the override does not speak about
 * is inherited from a bundled model of the same provider on the same api — the
 * closest thing to "what this provider's models look like" that exists.
 *
 * `thinkingLevelMap` is inherited for the same reason, with a caveat worth
 * knowing: `thinkingLevels` is authoritative client-side — `clampThinkingLevel`
 * runs in the client, before the protocol is reached — while the map only
 * translates an already-chosen level into the provider's own value. An
 * override that supports a level the template's map marks unsupported will
 * therefore reach the wire, and be translated by the template's rules.
 */
function synthesiseModel(base: PiProvider, model: ResolvedModel): Model<Api> {
  const template = base.getModels().find((candidate) => candidate.api === model.protocol);
  if (template === undefined) {
    throw new Error(
      `Provider "${base.id}" has no model on api "${model.protocol}" to template override model "${model.id}" from.`,
    );
  }

  return {
    ...template,
    id: model.id,
    // ResolvedModel has no display name and pi's is required. The id is the
    // only honest value: a template's name would name a different model.
    name: model.id,
    api: model.protocol as Api,
    provider: model.provider,
    contextWindow: model.contextWindow,
    cost: toPiCost(model.pricing),
    // pi's `reasoning` is the boolean form of our level list. "off" alone is
    // no thinking support, which is exactly what `false` means here.
    reasoning: model.thinkingLevels.some((level) => level !== "off"),
  };
}

/**
 * Applies overrides to a catalog by wrapping each affected provider.
 *
 * A pi `Provider` is behaviour-bearing — `getModels()`, `stream()`,
 * `streamSimple()`, `auth` — not a data record with a `.models` array, and
 * `setProvider` upserts by id. So the provider is read, wrapped and written
 * back: rebuilding one from the override alone would leave it with no `stream`
 * implementation at all.
 *
 * Mutates only the dedicated instance its caller just constructed.
 */
function applyOverrides(models: MutableModels, overrides: readonly ProviderOverride[]): void {
  for (const override of overrides) {
    const base = models.getProvider(override.provider);
    if (base === undefined) {
      throw new Error(
        `Cannot apply a provider override for "${override.provider}": the backend catalog does not know that ` +
          `provider, so there is no stream implementation to inherit. Overrides amend a provider; they cannot ` +
          `introduce one.`,
      );
    }

    // Keyed by id, last-wins, because normaliseCatalog stores override models
    // into a Map and so keeps the last of a repeated id. Mapping to an array
    // here instead would keep the first at the wire (resolveModel takes the
    // first match) while the client kept the last — the two catalogs would
    // disagree about which model an id names, which is the whole class of bug
    // this seam exists to close.
    const byId = new Map<string, Model<Api>>();
    for (const model of override.models ?? []) {
      // Rejected before synthesis, so the two catalogs refuse the same config
      // with the same message rather than one of them building a model whose
      // provider field would then pick the wrong credentials at the wire.
      assertOverrideModelProvider(override.provider, model);
      byId.set(model.id, synthesiseModel(base, model));
    }
    const synthesised = [...byId.values()];
    const overriddenIds = new Set(byId.keys());
    // The override wins on an id collision and every other bundled model
    // survives — the same semantics normaliseCatalog applies on the client
    // side, so the two catalogs cannot disagree about which model an id names.
    const merged = [...base.getModels().filter((model) => !overriddenIds.has(model.id)), ...synthesised].map(
      (model) => ({
        ...model,
        // baseUrl and headers are provider-level and replace rather than
        // merge, mirroring catalog.ts. They are applied to every model of the
        // provider, bundled ones included, because pi dispatches against
        // Model.baseUrl / Model.headers, not against the provider's.
        ...(override.baseUrl !== undefined ? { baseUrl: override.baseUrl } : {}),
        ...(override.headers !== undefined ? { headers: { ...override.headers } } : {}),
      }),
    );

    models.setProvider({
      ...base,
      ...(override.baseUrl !== undefined ? { baseUrl: override.baseUrl } : {}),
      ...(override.headers !== undefined ? { headers: { ...override.headers } } : {}),
      getModels: () => merged,
    });
  }
}

/**
 * The pi catalog for these options: the process-wide instance when there is
 * nothing to override, and a dedicated one when there is.
 */
function catalogFor(options: PiProtocolOptions): MutableModels {
  const store = options.credentials;
  const overrides = options.providerOverrides;
  const build = (): MutableModels =>
    store === undefined ? builtinModels() : builtinModels({ credentials: toPiCredentialStore(store) });

  // An empty array is "no overrides": the shared instances stay in play, so
  // this path is byte-for-byte what it was before overrides existed.
  if (overrides === undefined || overrides.length === 0) {
    if (store === undefined) {
      shared ??= builtinModels();
      return shared;
    }
    const existing = credentialed.get(store);
    if (existing !== undefined) return existing;
    const created = build();
    credentialed.set(store, created);
    return created;
  }

  const key = store ?? AMBIENT_CREDENTIALS;
  let byOverrides = overridden.get(key);
  if (byOverrides === undefined) {
    byOverrides = new WeakMap<readonly ProviderOverride[], MutableModels>();
    overridden.set(key, byOverrides);
  }
  const cached = byOverrides.get(overrides);
  if (cached !== undefined) return cached;

  const created = build();
  applyOverrides(created, overrides);
  byOverrides.set(overrides, created);
  return created;
}

/**
 * See PiProtocolOptions.transport for why this is not pi-ai's own "auto".
 */
const DEFAULT_TRANSPORT: Transport = "sse";

/**
 * pi-ai's stream entry point, injectable so tests need no network.
 *
 * Narrowed to what this file uses — an async iterable — rather than reusing
 * MutableModels["streamSimple"], whose return type is a concrete class a test
 * double would have to reimplement to satisfy.
 */
type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export function createPiDeps(
  options: PiProtocolOptions = {},
  streamSimple?: StreamSimple,
  /**
   * Test seam, following `streamSimple`. Without it `auth.headers` is
   * `undefined` for every provider unless a credential store is configured, so
   * a test cannot reach the auth/request header merge at all — which is how the
   * merge shipped with a regression test that passed against the bug.
   */
  authResolver?: AuthResolver,
): PiDeps {
  const models = catalogFor(options);

  const resolver = authResolver ?? createPiAuthResolver(models);

  return {
    resolveModel: async (modelId, provider) => {
      // pi-ai serves one model id from many providers (e.g. gpt-5.4 under
      // azure-openai-responses, openai and openai-codex), so when the client
      // supplies the owning provider the search is scoped to it. Without a
      // provider — protocol-direct callers and existing tests — the global
      // catalog's first match stays as the documented fallback.
      const found =
        provider !== undefined
          ? models.getModels(provider).find((candidate) => candidate.id === modelId)
          : models.getModels().find((candidate) => candidate.id === modelId);
      if (found === undefined) {
        if (provider !== undefined) {
          throw new Error(`Unknown model "${modelId}" for provider "${provider}" in the pi-ai catalog.`);
        }
        throw new Error(`Unknown model "${modelId}" in the pi-ai catalog.`);
      }
      return found;
    },

    stream: async function* (model, context, options_, onResponse) {
      // Resolve through nax-ai's own port, not through Models' internal path,
      // so the seam a native backend will use is exercised in production
      // rather than merely exported.
      const auth = await resolver.resolve({ provider: model.provider, model: model.id });
      // The vendor header goes under the caller's own headers, so an explicit
      // one still wins; auth stays last and wins over both. Left undefined when
      // there is nothing on the request side, so mergeRequestHeaders can return
      // undefined and the option stays absent rather than being set to `{}`.
      const requestHeaders = withoutEmpty({
        // Both vendor maps sit beneath the caller's own headers, so an explicit
        // spelling still wins. They cannot collide with each other: one names a
        // session, the other an application.
        ...vendorAppHeaders(model.provider, options.clientApp),
        ...vendorSessionHeaders(model.provider, options_?.sessionId),
        ...options_?.headers,
      });
      // Validated here rather than only at the client boundary: this is where
      // headers reach the wire, and a protocol-direct caller never passes
      // through the client. The vendor header is included because it is added
      // after that earlier check.
      assertValidHeaders(requestHeaders);
      // Separately, and not covered by the line above: the header check only
      // sees the id once vendorSessionHeaders has embedded it, which happens
      // for opencode alone. Every other provider carries it in options.sessionId
      // and pi-ai turns it into x-session-id / session_id / x-client-request-id
      // / x-session-affinity — so without this the id is unchecked precisely
      // where it does the most work.
      assertValidSessionId(options_?.sessionId);
      const mergedHeaders = mergeRequestHeaders(requestHeaders, auth.headers);
      const stream = streamSimple ?? models.streamSimple.bind(models);
      yield* stream(model, context, {
        // Construction-time first, so a per-request option could still override
        // it later without this line having to move.
        transport: options.transport ?? DEFAULT_TRANSPORT,
        ...options_,
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        // Merged, not overwritten. Spreading auth.headers alone discarded any
        // per-request headers wholesale, so a request header would have been
        // silently dropped for every credentialed provider — which is every
        // provider that actually needs one.
        ...(mergedHeaders !== undefined ? { headers: mergedHeaders } : {}),
        onResponse: (response) => onResponse({ status: response.status, headers: response.headers }),
      });
    },
  };
}
