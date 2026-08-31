# nax-ai M2 Real Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nax-ai able to talk to a real LLM provider, with nax-ai owning the catalog and auth while pi-ai owns transport.

**Architecture:** One `Protocol` implementation backed by pi-ai's `Models.streamSimple`, registered under four protocol keys. pi-ai's twelve stream events map straight onto our seven `ProtocolEvent` kinds with no intermediate type. The catalog and auth are normalised into nax-ai's own types at the boundary so a future native backend never imports pi-ai.

**Tech Stack:** TypeScript 7, Bun 1.4 (runtime and package manager), Node 22/24 (compatibility target), vitest 4, biome 2.5, `@earendil-works/pi-ai` 0.84.4.

**Spec:** `docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md`

## Global Constraints

- **Node floor is `>=22.19.0`.** pi-ai's per-provider model modules use JSON import attributes, which require it.
- **`Bun.*` APIs are forbidden in `src/`.** `scripts/check-no-bun-apis.ts` fails the build. The consumer runs on Bun and would never notice the breakage.
- **pi-ai may be imported only from files on the ALLOWED list** in `scripts/check-pi-ai-imports.ts`. By the end of this plan that list is exactly: `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts`, `src/auth/pi-auth.ts`. The gate scans `src/` only — test files are never scanned, so no test needs an allowance.
- **No emoji anywhere** in code, comments, docs or commit messages.
- **Never mutate.** Build new objects and arrays; do not write through a reference.
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- **Do not publish to the `latest` dist-tag.** `0.1.0` goes to `next` only, and only in Task 11.
- **Anthropic OAuth is prohibited** and enforced by `assertOAuthFlowPermitted`. Never add `anthropic` to `PERMITTED_OAUTH_FLOWS`.
- Every task ends green: `bun run lint && bun run typecheck && bun run test && bun run build`.

---

### Task 1: Tiered pricing and optional env

**Files:**
- Modify: `src/providers/types.ts:12-22`
- Modify: `src/index.ts` (export the two new types)
- Test: `test/providers/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PricingRates`, `PricingTier`, `Pricing.tiers`, and `ProviderAuth`'s api-key variant with `env` optional. Tasks 7 and 9 depend on these.

- [ ] **Step 1: Write the failing test**

Append to `test/providers/catalog.test.ts`:

```ts
it("preserves tiered pricing through normalisation", () => {
  const catalog = normaliseCatalog([
    {
      id: "openai",
      baseUrl: "https://api.openai.com",
      auth: { kind: "api-key" },
      defaultProtocol: "openai-responses",
      models: [
        {
          id: "gpt-5.4",
          pricing: {
            input: 2.5,
            output: 15,
            cacheRead: 0.25,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
          },
          contextWindow: 400000,
          supportsTools: true,
          thinkingLevels: [],
        },
      ],
    },
  ]);

  const model = catalog.model("openai", "gpt-5.4");
  expect(model?.pricing.tiers).toHaveLength(1);
  expect(model?.pricing.tiers?.[0]).toEqual({
    inputTokensAbove: 272000,
    input: 5,
    output: 22.5,
    cacheRead: 0.5,
    cacheWrite: 0,
  });
});

it("accepts an api-key provider that declares no env var name", () => {
  const catalog = normaliseCatalog([
    {
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      auth: { kind: "api-key" },
      defaultProtocol: "openai-completions",
      models: [],
    },
  ]);

  expect(catalog.provider("deepseek")?.auth).toEqual({ kind: "api-key" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/providers/catalog.test.ts`
Expected: FAIL. Type errors on `tiers` (not a property of `Pricing`) and on `auth: { kind: "api-key" }` (missing required `env`).

- [ ] **Step 3: Write minimal implementation**

Replace `src/providers/types.ts:12-22` with:

```ts
/** Rates per 1M tokens. nax-ai supplies rates; the consumer computes cost. */
export interface PricingRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * A request-wide pricing tier. The highest matching threshold applies to the
 * whole request.
 *
 * Extends the rates rather than `Pricing` so a tier cannot carry its own tiers.
 */
export interface PricingTier extends PricingRates {
  /** Applies when total input usage exceeds this token count. */
  readonly inputTokensAbove: number;
}

export interface Pricing extends PricingRates {
  /**
   * Present for the 22 upstream models that price in tiers. A consumer that
   * ignores this bills the base rates and will under-report a long-context
   * request; one that honours it is correct. nax-ai still computes no cost.
   */
  readonly tiers?: readonly PricingTier[];
}

export type ProviderAuth =
  /**
   * `env` is descriptive only and is often absent: the upstream catalog does
   * not expose variable names in a form that can be read without consulting
   * the ambient environment. Auth resolution never reads this field.
   */
  | { readonly kind: "api-key"; readonly env?: string }
  | { readonly kind: "oauth"; readonly flow: string };
```

Add to `src/index.ts`, in the existing `./providers/types.ts` export block, keeping the list alphabetical:

```ts
export type {
  Pricing,
  PricingRates,
  PricingTier,
  ProviderAuth,
  ProviderOverride,
  ResolvedModel,
  ResolvedProvider,
} from "./providers/types.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/index.ts test/providers/catalog.test.ts
git commit -m "feat: tiered pricing rates and optional api-key env name"
```

---

### Task 2: Shared pure helpers

Extracts the logic four backend copies duplicated, so it survives their deletion in Task 6 and a native backend can import it.

**Files:**
- Create: `src/protocols/tool-args.ts`
- Create: `src/protocols/errors.ts`
- Test: `test/protocols/tool-args.test.ts`
- Test: `test/protocols/errors.test.ts`

**Interfaces:**
- Consumes: `ProtocolErrorKind` from `src/protocols/types.ts`.
- Produces:
  - `createToolArgAccumulator(): ToolArgAccumulator` with `append(id, name, fragment): string` returning the accumulated raw string, and `take(id): { name: string; raw: string } | undefined` which removes the entry.
  - `parseToolArgs(raw: string): unknown` — `""` parses to `{}`; invalid JSON throws.
  - `classifyHttpError(status: number | undefined): ProtocolErrorKind`
  - `parseRetryAfter(headers: Readonly<Record<string, string>> | undefined): number | undefined`

  Tasks 4 and 5 use all five.

- [ ] **Step 1: Write the failing tests**

Create `test/protocols/tool-args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createToolArgAccumulator, parseToolArgs } from "../../src/protocols/tool-args.ts";

describe("createToolArgAccumulator", () => {
  it("returns the running total after each fragment", () => {
    const acc = createToolArgAccumulator();
    expect(acc.append("t1", "read", '{"path"')).toBe('{"path"');
    expect(acc.append("t1", "read", ':"a.ts"}')).toBe('{"path":"a.ts"}');
  });

  it("keeps concurrent tool calls apart", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", '{"a":1');
    acc.append("t2", "write", '{"b":2');
    expect(acc.append("t1", "read", "}")).toBe('{"a":1}');
    expect(acc.append("t2", "write", "}")).toBe('{"b":2}');
  });

  it("take removes the entry so a repeated id starts fresh", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", '{"a":1}');
    expect(acc.take("t1")).toEqual({ name: "read", raw: '{"a":1}' });
    expect(acc.take("t1")).toBeUndefined();
  });

  it("keeps the name from the first fragment", () => {
    const acc = createToolArgAccumulator();
    acc.append("t1", "read", "{");
    acc.append("t1", "", "}");
    expect(acc.take("t1")?.name).toBe("read");
  });
});

describe("parseToolArgs", () => {
  it("treats an empty accumulation as an empty object", () => {
    expect(parseToolArgs("")).toEqual({});
  });

  it("parses accumulated JSON", () => {
    expect(parseToolArgs('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseToolArgs('{"path"')).toThrow();
  });
});
```

Create `test/protocols/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyHttpError, parseRetryAfter } from "../../src/protocols/errors.ts";

describe("classifyHttpError", () => {
  it.each([
    [undefined, "unknown"],
    [401, "auth"],
    [403, "auth"],
    [429, "rate-limit"],
    [503, "overloaded"],
    [529, "overloaded"],
    [400, "bad-request"],
    [404, "bad-request"],
    [500, "transport"],
    [502, "transport"],
    [200, "unknown"],
  ] as const)("classifies %s as %s", (status, kind) => {
    expect(classifyHttpError(status)).toBe(kind);
  });

  it("prefers the specific classification over the range for 429 and 503", () => {
    expect(classifyHttpError(429)).not.toBe("bad-request");
    expect(classifyHttpError(503)).not.toBe("transport");
  });
});

describe("parseRetryAfter", () => {
  it("reads a numeric retry-after in seconds", () => {
    expect(parseRetryAfter({ "retry-after": "30" })).toBe(30);
  });

  it("is case-insensitive on the header name", () => {
    expect(parseRetryAfter({ "Retry-After": "12" })).toBe(12);
  });

  it("returns undefined for an HTTP-date value rather than guessing", () => {
    expect(parseRetryAfter({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeUndefined();
  });

  it("returns undefined when absent or when headers are absent", () => {
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("returns undefined for a negative value", () => {
    expect(parseRetryAfter({ "retry-after": "-5" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun x vitest --run test/protocols/tool-args.test.ts test/protocols/errors.test.ts`
Expected: FAIL, "Cannot find module '../../src/protocols/tool-args.ts'" and the same for `errors.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/protocols/tool-args.ts`:

```ts
/**
 * Streamed tool-call argument accumulation.
 *
 * A pure helper rather than a method on a backend: every protocol receives
 * arguments as JSON fragments and must accumulate before parsing, so a
 * hand-written backend needs this same logic and should not re-derive it.
 */

interface PendingToolArgs {
  readonly name: string;
  readonly raw: string;
}

export interface ToolArgAccumulator {
  /** Appends a fragment and returns everything accumulated for `id` so far. */
  append(id: string, name: string, fragment: string): string;
  /** Removes and returns the accumulation, or undefined if `id` is unknown. */
  take(id: string): PendingToolArgs | undefined;
}

export function createToolArgAccumulator(): ToolArgAccumulator {
  const pending = new Map<string, PendingToolArgs>();

  return {
    append(id, name, fragment) {
      const current = pending.get(id);
      // The name arrives with the first fragment and is authoritative; later
      // fragments may not carry it.
      const next: PendingToolArgs = {
        name: current?.name ?? name,
        raw: (current?.raw ?? "") + fragment,
      };
      pending.set(id, next);
      return next.raw;
    },

    take(id) {
      const current = pending.get(id);
      pending.delete(id);
      return current;
    },
  };
}

/**
 * Parses an accumulated argument string.
 *
 * An empty accumulation means the provider sent a tool call with no arguments,
 * which is an empty object rather than an error.
 */
export function parseToolArgs(raw: string): unknown {
  return raw === "" ? {} : JSON.parse(raw);
}
```

Create `src/protocols/errors.ts`:

```ts
/**
 * HTTP-shaped error classification.
 *
 * Kept as pure functions, separate from any call path, for the same reason
 * `usage.ts` is: a hand-written backend classifies the same statuses from a
 * different source and should not carry a second copy of this table.
 */

import type { ProtocolErrorKind } from "./types.ts";

export function classifyHttpError(status: number | undefined): ProtocolErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  if (status >= 500) return "transport";
  return "unknown";
}

/**
 * Reads `retry-after` as a delay in seconds.
 *
 * The header may also carry an HTTP-date. That form is deliberately not
 * converted: the conversion depends on clock skew between us and the provider,
 * and a wrong number here would be worse than an absent one, because the
 * consumer owns the retry loop and would sleep on it.
 */
export function parseRetryAfter(headers: Readonly<Record<string, string>> | undefined): number | undefined {
  if (headers === undefined) return undefined;

  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  if (entry === undefined) return undefined;

  const seconds = Number(entry[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/tool-args.ts src/protocols/errors.ts test/protocols/tool-args.test.ts test/protocols/errors.test.ts
git commit -m "feat: extract tool-arg accumulation and error classification helpers"
```

---

### Task 3: pi request translation

Builds the pi protocol's skeleton and the `ProtocolRequest` to pi-ai translation. Event mapping arrives in Task 4; until then the stream yields nothing.

**Files:**
- Rewrite: `src/protocols/pi-client.ts` (currently a throwing stub)
- Modify: `scripts/check-pi-ai-imports.ts:24` (ALLOWED list)
- Test: `test/protocols/pi-client.test.ts`

**Interfaces:**
- Consumes: `Protocol`, `ProtocolRequest`, `ConversationMessage` from `src/protocols/types.ts`.
- Produces:
  - `createPiProtocol(name: string, deps: PiDeps): Protocol`
  - `interface PiDeps { readonly resolveModel: (modelId: string) => Promise<Model<Api>>; readonly stream: PiStreamFn }`
  - `type PiStreamFn = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>`
  - `toPiContext(req: ProtocolRequest, model: Model<Api>): Context`
  - `toPiOptions(req: ProtocolRequest): SimpleStreamOptions`

  Tasks 4, 5, 6 and 9 build on these.

**Two rulings this task implements, which the spec's one-line "messages maps to Context.messages" hides:**

1. **`toolResult` needs a `toolName` we do not carry.** Our `ConversationMessage` tool-result has `toolCallId` but no name; pi-ai's `ToolResultMessage` requires `toolName`, and it is read on the wire by `openai-completions` (when `compat.requiresToolResultName`), `mistral-conversations`, `google-shared` and `openai-responses-shared`. It is recovered by scanning earlier assistant messages for a `toolCalls` entry with a matching id. A tool result with no matching call is a malformed request and throws.
2. **Timestamps are `0`.** pi-ai's `Message` requires `timestamp`, but no wire module under `packages/ai/src/api/` reads it (verified against pi at `853a80d`). A fixed `0` keeps translation deterministic and testable; `Date.now()` would make snapshots flap for a field nothing sends.

- [ ] **Step 1: Write the failing test**

Create `test/protocols/pi-client.test.ts`:

```ts
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiProtocol, toPiContext, toPiOptions } from "../../src/protocols/pi-client.ts";
import type { ProtocolRequest } from "../../src/protocols/types.ts";

export const MODEL: Model<Api> = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 8000,
};

/** Records what the protocol handed pi-ai, and replays scripted events. */
export function fakePi(events: AssistantMessageEvent[]) {
  const calls: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
  return {
    calls,
    deps: {
      resolveModel: async () => MODEL,
      stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => {
        calls.push({ model, context, options });
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
}

const BASE: ProtocolRequest = { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] };

describe("toPiContext", () => {
  it("puts system in systemPrompt, never in messages", () => {
    const context = toPiContext({ ...BASE, system: "be terse" }, MODEL);
    expect(context.systemPrompt).toBe("be terse");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
  });

  it("omits systemPrompt when absent rather than sending an empty string", () => {
    expect(toPiContext(BASE, MODEL).systemPrompt).toBeUndefined();
  });

  it("maps an assistant turn with tool calls onto pi content blocks", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "user", content: "read a.ts" },
          { role: "assistant", content: "on it", toolCalls: [{ id: "t1", name: "read", input: { path: "a.ts" } }] },
          { role: "tool-result", toolCallId: "t1", content: "contents" },
        ],
      },
      MODEL,
    );

    const assistant = context.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant).toMatchObject({
      content: [
        { type: "text", text: "on it" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
      ],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("recovers toolName for a tool result from the call that produced it", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] },
          { role: "tool-result", toolCallId: "t1", content: "ok", isError: true },
        ],
      },
      MODEL,
    );

    expect(context.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("throws on a tool result with no matching call, rather than sending an empty name", () => {
    expect(() =>
      toPiContext({ ...BASE, messages: [{ role: "tool-result", toolCallId: "ghost", content: "ok" }] }, MODEL),
    ).toThrow(/ghost/);
  });

  it("omits an empty assistant text block", () => {
    const context = toPiContext(
      { ...BASE, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] }] },
      MODEL,
    );
    expect(context.messages[0]).toMatchObject({ content: [{ type: "toolCall", id: "t1" }] });
  });
});

describe("toPiOptions", () => {
  it("forwards the neutral options under pi's names", () => {
    const options = toPiOptions({
      ...BASE,
      toolChoice: "none",
      maxTokens: 100,
      temperature: 0.5,
      cacheRetention: "long",
    });
    expect(options).toMatchObject({ toolChoice: "none", maxTokens: 100, temperature: 0.5, cacheRetention: "long" });
  });

  it("maps thinking onto reasoning", () => {
    expect(toPiOptions({ ...BASE, thinking: "high" }).reasoning).toBe("high");
  });

  it("omits reasoning entirely when thinking is off, since pi has no off level", () => {
    expect("reasoning" in toPiOptions({ ...BASE, thinking: "off" })).toBe(false);
  });

  it("omits every optional field that was not supplied", () => {
    expect(toPiOptions(BASE)).toEqual({});
  });
});

describe("createPiProtocol", () => {
  it("exposes the protocol name it was registered under", () => {
    expect(createPiProtocol("openai-completions", fakePi([]).deps).name).toBe("openai-completions");
  });

  it("resolves the model and calls pi-ai once with the translated request", async () => {
    const pi = fakePi([]);
    const protocol = createPiProtocol("openai-completions", pi.deps);
    for await (const _ of protocol.stream({ ...BASE, system: "be terse" })) {
      // drain
    }
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0]?.model.id).toBe("deepseek-chat");
    expect(pi.calls[0]?.context.systemPrompt).toBe("be terse");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/pi-client.test.ts`
Expected: FAIL. `createPiProtocol`, `toPiContext` and `toPiOptions` are not exported from `pi-client.ts`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `src/protocols/pi-client.ts`:

```ts
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
  Message as PiMessage,
  Model,
  SimpleStreamOptions,
  Tool as PiTool,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type { ConversationMessage, Protocol, ProtocolEvent, ProtocolRequest } from "./types.ts";

export type PiStreamFn = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiDeps {
  readonly resolveModel: (modelId: string) => Promise<Model<Api>>;
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

function toPiTool(tool: ProtocolRequest["tools"] extends readonly (infer T)[] | undefined ? T : never): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // pi-ai types this as a TypeBox TSchema, which is a JSON Schema object at
    // runtime. nax-ai does not validate schemas; it forwards what it was given.
    parameters: tool.inputSchema as PiTool["parameters"],
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
    // pi-ai's scale has no "off": the absence of the field is how thinking is
    // disabled, so mapping "off" to a value would silently enable it.
    ...(req.thinking !== undefined && req.thinking !== "off" ? { reasoning: req.thinking } : {}),
  };
}

export function createPiProtocol(name: string, deps: PiDeps): Protocol {
  return {
    name,

    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      const model = await deps.resolveModel(req.model);
      const events = deps.stream(model, toPiContext(req, model), toPiOptions(req));

      for await (const _event of events) {
        // Event mapping arrives in Task 4.
      }
    },
  };
}
```

Extend the ALLOWED list at `scripts/check-pi-ai-imports.ts:24`. The `backend-pi.ts` pattern **stays for now** — those four files still exist and still import pi-ai, so removing it here would fail the gate. Task 6 deletes them and removes the pattern in the same commit:

```ts
const ALLOWED = [
  /^src\/protocols\/pi-client\.ts$/,
  /^src\/providers\/pi-catalog\.ts$/,
  /^src\/auth\/pi-auth\.ts$/,
  // Removed in Task 6, together with the four files it covers.
  /^src\/protocols\/[^/]+\/backend-pi\.ts$/,
];
```

Also update the header comment's "Allowed:" line to name the three new files alongside the temporary pattern, and the final `console.error` message to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS, including `check-pi-ai-imports: clean`. The four `<protocol>/backend-pi.ts` files still exist and are still covered by the temporary ALLOWED pattern.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/pi-client.ts scripts/check-pi-ai-imports.ts test/protocols/pi-client.test.ts
git commit -m "feat: translate ProtocolRequest into pi-ai Context and stream options"
```

---

### Task 4: Event mapping

**Files:**
- Modify: `src/protocols/pi-client.ts` (the `stream` body)
- Test: `test/protocols/pi-client.test.ts`

**Interfaces:**
- Consumes: `createToolArgAccumulator`, `parseToolArgs` (Task 2); `toTokenUsage` from `src/usage.ts`; `fakePi` and `MODEL` from Task 3's test file.
- Produces: a `createPiProtocol` whose stream yields the seven `ProtocolEvent` kinds. Task 5 adds the error path; Task 6 runs the conformance suite against it.

- [ ] **Step 1: Write the failing test**

Append to `test/protocols/pi-client.test.ts`:

```ts
/** A minimal AssistantMessage, enough for the terminal events. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-completions" as Api,
    provider: "deepseek",
    model: "deepseek-chat",
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: 0,
    ...overrides,
  };
}

async function drain(events: AssistantMessageEvent[]) {
  const out = [];
  for await (const event of createPiProtocol("openai-completions", fakePi(events).deps).stream(BASE)) out.push(event);
  return out;
}

describe("createPiProtocol event mapping", () => {
  it("drops start, text_start and text_end, and emits only the deltas", async () => {
    const events = await drain([
      { type: "start", partial: message() },
      { type: "text_start", contentIndex: 0, partial: message() },
      { type: "text_delta", contentIndex: 0, delta: "he", partial: message() },
      { type: "text_delta", contentIndex: 0, delta: "llo", partial: message() },
      { type: "text_end", contentIndex: 0, content: "hello", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
    ]);
  });

  it("maps thinking deltas and drops their start and end", async () => {
    const events = await drain([
      { type: "thinking_start", contentIndex: 0, partial: message() },
      { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: message() },
      { type: "thinking_end", contentIndex: 0, content: "hmm", partial: message() },
      { type: "text_delta", contentIndex: 1, delta: "ok", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events).toContainEqual({ type: "thinking-delta", text: "hmm" });
  });

  it("recovers a partial tool call's id and name from partial.content", async () => {
    const withCall = (args: string) =>
      message({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] });

    const events = await drain([
      { type: "toolcall_start", contentIndex: 0, partial: withCall("") },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path"', partial: withCall('{"path"') },
      { type: "toolcall_delta", contentIndex: 0, delta: ':"a.ts"}', partial: withCall('{"path":"a.ts"}') },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
        partial: withCall('{"path":"a.ts"}'),
      },
      { type: "done", reason: "toolUse", message: message({ stopReason: "toolUse" }) },
    ] as AssistantMessageEvent[]);

    expect(events.filter((e) => e.type === "tool-call-partial")).toEqual([
      { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"path"' },
      { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"path":"a.ts"}' },
    ]);
    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: "t1", name: "read", input: { path: "a.ts" } },
    });
  });

  it("emits usage immediately before done, synthesised from the final message", async () => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events.slice(-2)).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["toolUse", "tool_use"],
  ] as const)("maps pi stop reason %s to %s", async (piReason, ours) => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: piReason, message: message({ stopReason: piReason }) },
    ] as AssistantMessageEvent[]);

    expect(events.at(-1)).toEqual({ type: "done", stopReason: ours });
  });

  it("treats a deferred stop reason as a defect rather than mapping it to stop", async () => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: "deferred", message: message({ stopReason: "deferred" }) },
    ] as AssistantMessageEvent[]);

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "unknown" } });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("ends the stream on unparseable tool arguments without losing earlier events", async () => {
    const withCall = message({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] });

    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "reading", partial: withCall },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path"', partial: withCall },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "read", arguments: {} },
        partial: withCall,
      },
      { type: "done", reason: "toolUse", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events[0]).toEqual({ type: "text-delta", text: "reading" });
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/pi-client.test.ts`
Expected: FAIL. Every mapping assertion fails because the stream yields nothing.

- [ ] **Step 3: Write minimal implementation**

Add to the imports in `src/protocols/pi-client.ts`:

```ts
import type { StopReason } from "../types.ts";
import { toTokenUsage } from "../usage.ts";
import { createToolArgAccumulator, parseToolArgs } from "./tool-args.ts";
```

Add above `createPiProtocol`:

```ts
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
```

Replace the `stream` body's `for await` loop:

```ts
    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      const model = await deps.resolveModel(req.model);
      const events = deps.stream(model, toPiContext(req, model), toPiOptions(req));
      const toolArgs = createToolArgAccumulator();

      for await (const event of events) {
        switch (event.type) {
          case "text_delta":
            yield { type: "text-delta", text: event.delta };
            break;

          case "thinking_delta":
            yield { type: "thinking-delta", text: event.delta };
            break;

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

          default:
            // start, text_start, text_end, thinking_start, thinking_end and
            // toolcall_start carry nothing our vocabulary expresses: content
            // is already delivered by the deltas. "error" is handled in the
            // next task.
            break;
        }
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client.test.ts
git commit -m "feat: map pi-ai stream events onto ProtocolEvent"
```

---

### Task 5: Error path and HTTP status recovery

Without this, `classifyHttpError` can only ever return `"unknown"`, because pi-ai's error event carries no status.

**Files:**
- Modify: `src/protocols/pi-client.ts`
- Test: `test/protocols/pi-client.test.ts`

**Interfaces:**
- Consumes: `classifyHttpError`, `parseRetryAfter` (Task 2).
- Produces: `PiDeps.stream` gains a fourth parameter — a response observer. Signature becomes
  `(model, context, options, onResponse: (response: { status: number; headers: Record<string, string> }) => void) => AsyncIterable<AssistantMessageEvent>`.
  Task 6 and Task 9 wire the real implementation to `ProviderRequestOptions.onResponse`.

- [ ] **Step 1: Write the failing test**

Append to `test/protocols/pi-client.test.ts`:

```ts
/** Replays scripted events after reporting an HTTP response, as pi-ai does. */
function fakePiWithResponse(events: AssistantMessageEvent[], response?: { status: number; headers: Record<string, string> }) {
  return {
    resolveModel: async () => MODEL,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options: SimpleStreamOptions,
      onResponse: (r: { status: number; headers: Record<string, string> }) => void,
    ) => {
      if (response) onResponse(response);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

async function drainWith(deps: ReturnType<typeof fakePiWithResponse>) {
  const out = [];
  for await (const event of createPiProtocol("openai-completions", deps).stream(BASE)) out.push(event);
  return out;
}

describe("createPiProtocol error path", () => {
  it("classifies the error from the observed HTTP status, not the event", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [{ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "slow down" }) }] as AssistantMessageEvent[],
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );

    expect(events.at(-1)).toEqual({
      type: "error",
      error: { kind: "rate-limit", message: "slow down", status: 429, retryAfter: 30 },
    });
  });

  it("falls back to unknown when no response was observed", async () => {
    const events = await drainWith(
      fakePiWithResponse([
        { type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "socket hang up" }) },
      ] as AssistantMessageEvent[]),
    );

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "unknown", message: "socket hang up" } });
    expect(events.at(-1)).not.toHaveProperty("error.status");
  });

  it("emits usage before the error, because a failed call still billed", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "text_delta", contentIndex: 0, delta: "part", partial: message() },
          { type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "boom" }) },
        ] as AssistantMessageEvent[],
        { status: 500, headers: {} },
      ),
    );

    expect(events.map((e) => e.type)).toEqual(["text-delta", "usage", "error"]);
  });

  it("omits usage when the failed message reported none", async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const events = await drainWith(
      fakePiWithResponse(
        [{ type: "error", reason: "error", error: message({ usage: zero, errorMessage: "boom" }) }] as AssistantMessageEvent[],
        { status: 400, headers: {} },
      ),
    );

    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("emits nothing after an error", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "error", reason: "error", error: message({ errorMessage: "boom" }) },
          { type: "text_delta", contentIndex: 0, delta: "should not appear", partial: message() },
        ] as AssistantMessageEvent[],
        { status: 500, headers: {} },
      ),
    );

    expect(events.filter((e) => e.type === "text-delta")).toEqual([]);
  });

  it("reports an aborted stream as an error rather than a clean stop", async () => {
    const events = await drainWith(
      fakePiWithResponse([
        { type: "error", reason: "aborted", error: message({ stopReason: "aborted", errorMessage: "aborted" }) },
      ] as AssistantMessageEvent[]),
    );

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});
```

Update `fakePi` in the same file to accept and ignore the new fourth parameter, so Task 3's and Task 4's tests keep compiling:

```ts
      stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions, _onResponse?: unknown) => {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/pi-client.test.ts`
Expected: FAIL. The `error` event is currently swallowed by the `default` branch, so the stream ends with no error event.

- [ ] **Step 3: Write minimal implementation**

Add the import:

```ts
import { classifyHttpError, parseRetryAfter } from "./errors.ts";
```

Change `PiStreamFn` to carry the observer:

```ts
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
```

In `stream`, capture the response and handle the error event:

```ts
      let observed: PiResponse | undefined;
      const events = deps.stream(model, toPiContext(req, model), toPiOptions(req), (response) => {
        observed = response;
      });
```

Add this `case` to the switch, before `default`:

```ts
          case "error": {
            const status = observed?.status;
            const retryAfter = parseRetryAfter(observed?.headers);
            const usage = toTokenUsage(event.error.usage);
            // A failed request that consumed tokens still bills for them.
            if (totalTokens(usage) > 0) yield { type: "usage", usage };
            yield {
              type: "error",
              error: {
                kind: classifyHttpError(status),
                message: event.error.errorMessage ?? `Upstream stream ended: ${event.reason}.`,
                ...(status !== undefined ? { status } : {}),
                ...(retryAfter !== undefined ? { retryAfter } : {}),
              },
            };
            return;
          }
```

Extend the `usage.ts` import to bring in the totals helper:

```ts
import { toTokenUsage, totalTokens } from "../usage.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client.test.ts
git commit -m "feat: classify stream errors from the observed HTTP response"
```

---

### Task 6: Cut over — registration surface, deletions, conformance

Replaces the four backends with the one protocol and proves it satisfies M1's contract suite.

**Files:**
- Create: `src/protocols/pi-protocols.ts`
- Modify: `src/index.ts`
- Modify: `scripts/check-pi-ai-imports.ts` (drop the `backend-pi.ts` pattern if Task 3 kept it)
- Delete: `src/protocols/anthropic-messages/`, `src/protocols/openai-completions/`, `src/protocols/openai-responses/`, `src/protocols/openai-codex-responses/`
- Delete: `test/protocols/anthropic-messages.test.ts`, `test/protocols/openai-completions.test.ts`, `test/protocols/openai-responses.test.ts`, `test/protocols/openai-codex-responses.test.ts`
- Test: `test/protocols/pi-protocols.test.ts`

**Interfaces:**
- Consumes: `createPiProtocol`, `PiDeps` (Task 3); `ProtocolEntries` from `src/protocols/registry.ts`.
- Produces:
  - `PI_PROTOCOL_NAMES: readonly ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"]`
  - `piProtocols(options?: PiProtocolOptions): ProtocolEntries`
  - `interface PiProtocolOptions { readonly credentials?: CredentialStore }` — the field is accepted and forwarded from Task 9 onward.

  Task 9 extends the options; Task 10 uses `piProtocols` in the live test.

- [ ] **Step 1: Write the failing test**

Create `test/protocols/pi-protocols.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRegistry } from "../../src/protocols/registry.ts";
import { PI_PROTOCOL_NAMES, piProtocols } from "../../src/protocols/pi-protocols.ts";

describe("piProtocols", () => {
  it("registers exactly the four pi-backed protocols", () => {
    expect(Object.keys(piProtocols()).sort()).toEqual([...PI_PROTOCOL_NAMES].sort());
  });

  it("registers each protocol under the pi backend only", () => {
    for (const backends of Object.values(piProtocols())) {
      expect(Object.keys(backends)).toEqual(["pi"]);
    }
  });

  it("passes registry validation with the default selection", () => {
    expect(() => createRegistry(piProtocols(), {}).validate()).not.toThrow();
  });

  it("still rejects a native selection, because no native backend exists yet", () => {
    expect(() => createRegistry(piProtocols(), { default: "native" }).validate()).toThrow();
  });

  it("names each resolved protocol after its registry key", async () => {
    const registry = createRegistry(piProtocols(), {});
    for (const name of PI_PROTOCOL_NAMES) {
      expect((await registry.resolve(name)).name).toBe(name);
    }
  });
});
```

Append the conformance run to `test/protocols/pi-client.test.ts`:

```ts
runProtocolConformance(
  "pi",
  async () =>
    createPiProtocol(
      "openai-completions",
      fakePi([
        { type: "text_delta", contentIndex: 0, delta: "hello", partial: message() },
        { type: "done", reason: "stop", message: message() },
      ] as AssistantMessageEvent[]).deps,
    ),
  { text: { name: "text", request: BASE } },
);
```

Add its import at the top of that file:

```ts
import { runProtocolConformance } from "../support/conformance.ts";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun x vitest --run test/protocols/pi-protocols.test.ts`
Expected: FAIL, "Cannot find module '../../src/protocols/pi-protocols.ts'".

- [ ] **Step 3: Write minimal implementation**

Create `src/protocols/pi-protocols.ts`:

```ts
/**
 * The registration surface for the pi-backed protocols.
 *
 * A consumer cannot assemble these entries itself: the four protocols must
 * share one pi-ai Models instance, and therefore one credential store and one
 * catalog, rather than constructing four. That is why this is exported rather
 * than documented.
 *
 * pi-ai is not imported here. The factory is lazy, so the import cost is paid
 * on first resolve of a protocol and not before.
 */

import type { CredentialStore } from "../types.ts";
import type { ProtocolEntries } from "./registry.ts";

export const PI_PROTOCOL_NAMES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
] as const;

export type PiProtocolName = (typeof PI_PROTOCOL_NAMES)[number];

export interface PiProtocolOptions {
  /** Where OAuth and api-key credentials live. Omitted means ambient only. */
  readonly credentials?: CredentialStore;
}

export function piProtocols(options: PiProtocolOptions = {}): ProtocolEntries {
  return Object.fromEntries(
    PI_PROTOCOL_NAMES.map((name) => [
      name,
      {
        pi: async () => {
          const { createPiDeps, createPiProtocol } = await import("./pi-client.ts");
          return createPiProtocol(name, createPiDeps(options));
        },
      },
    ]),
  );
}
```

Add `createPiDeps` to `src/protocols/pi-client.ts`. It builds the shared `Models` once:

```ts
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { PiProtocolOptions } from "./pi-protocols.ts";

let shared: MutableModels | undefined;

/**
 * One Models instance is shared across the four protocols, so they share one
 * credential store and one catalog.
 *
 * Credentials are deliberately NOT forwarded yet. nax-ai's CredentialStore is
 * not pi-ai's shape, and passing it through unadapted would fail at runtime
 * rather than at the type level. Task 9 adds the adapter and the parameter.
 */
export function createPiDeps(_options: PiProtocolOptions = {}): PiDeps {
  const models = (shared ??= builtinModels());

  return {
    resolveModel: async (modelId) => {
      const found = models
        .getModels()
        .find((candidate) => candidate.id === modelId);
      if (found === undefined) throw new Error(`Unknown model "${modelId}" in the pi-ai catalog.`);
      return found;
    },

    stream: (model, context, options_, onResponse) =>
      models.streamSimple(model, context, {
        ...options_,
        onResponse: (response) => onResponse({ status: response.status, headers: response.headers }),
      }),
  };
}
```

Update `src/index.ts`: remove nothing yet, and add

```ts
export {
  PI_PROTOCOL_NAMES,
  type PiProtocolName,
  type PiProtocolOptions,
  piProtocols,
} from "./protocols/pi-protocols.ts";
```

Delete the four protocol directories and their four test files:

```bash
git rm -r src/protocols/anthropic-messages src/protocols/openai-completions src/protocols/openai-responses src/protocols/openai-codex-responses
git rm test/protocols/anthropic-messages.test.ts test/protocols/openai-completions.test.ts test/protocols/openai-responses.test.ts test/protocols/openai-codex-responses.test.ts
```

Remove the temporary `/^src\/protocols\/[^/]+\/backend-pi\.ts$/` pattern from `ALLOWED` in `scripts/check-pi-ai-imports.ts`, and update the header comment and the `console.error` message so neither still mentions `backend-pi.ts`. The list is now exactly the three files named in the Global Constraints.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: PASS. Test count drops as the four duplicate suites go and rises as the conformance run is added. `check-pi-ai-imports: clean`.

- [ ] **Step 5: Commit**

```bash
git add -A src test scripts
git commit -m "refactor: one pi protocol under four registry keys, four backends deleted"
```

---

### Task 7: The catalog

**Files:**
- Create: `src/providers/pi-catalog.ts`
- Modify: `src/index.ts`
- Test: `test/providers/pi-catalog.test.ts`

**Interfaces:**
- Consumes: `RawProvider`, `RawModel` from `src/providers/catalog.ts`; `Pricing`, `PricingTier`, `ProviderAuth` (Task 1).
- Produces: `piProviders(ids?: readonly string[]): Promise<RawProvider[]>`. Task 10 uses it; Task 11 documents it.

- [ ] **Step 1: Write the failing test**

Create `test/providers/pi-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normaliseCatalog } from "../../src/providers/catalog.ts";
import { piProviders } from "../../src/providers/pi-catalog.ts";

describe("piProviders", () => {
  it("returns only the requested providers", async () => {
    const providers = await piProviders(["deepseek", "groq"]);
    expect(providers.map((p) => p.id).sort()).toEqual(["deepseek", "groq"]);
  });

  it("throws on an unknown id rather than silently returning fewer", async () => {
    await expect(piProviders(["deepseek", "nope-xyz"])).rejects.toThrow(/nope-xyz/);
  });

  it("carries model metadata through into our own shape", async () => {
    const [deepseek] = await piProviders(["deepseek"]);
    const model = deepseek?.models.find((m) => m.id.startsWith("deepseek"));
    expect(model).toMatchObject({
      protocol: "openai-completions",
      supportsTools: expect.any(Boolean),
      contextWindow: expect.any(Number),
      pricing: { input: expect.any(Number), output: expect.any(Number) },
    });
    expect(deepseek?.baseUrl).toMatch(/^https:\/\//);
  });

  it("preserves tiered pricing for the models that have it", async () => {
    const [openai] = await piProviders(["openai"]);
    const tiered = openai?.models.filter((m) => m.pricing.tiers !== undefined) ?? [];
    expect(tiered.length).toBeGreaterThan(0);
    for (const model of tiered) {
      for (const tier of model.pricing.tiers ?? []) {
        expect(tier.inputTokensAbove).toBeGreaterThan(0);
      }
    }
  });

  it("selects api-key for a provider that offers both, so the OAuth gate cannot lock it out", async () => {
    const [anthropic] = await piProviders(["anthropic"]);
    expect(anthropic?.auth).toEqual({ kind: "api-key" });
    expect(() => normaliseCatalog(anthropic ? [anthropic] : [])).not.toThrow();
  });

  it("selects oauth for a provider that offers only oauth", async () => {
    const [codex] = await piProviders(["openai-codex"]);
    expect(codex?.auth).toEqual({ kind: "oauth", flow: "openai-codex" });
  });

  it("loads every built-in provider without tripping the OAuth allowlist", async () => {
    const providers = await piProviders();
    expect(providers.length).toBeGreaterThan(30);
    expect(() => normaliseCatalog(providers)).not.toThrow();
  });

  it("still rejects a hand-declared prohibited flow", () => {
    expect(() =>
      normaliseCatalog([
        {
          id: "anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: { kind: "oauth", flow: "anthropic" },
          defaultProtocol: "anthropic-messages",
          models: [],
        },
      ]),
    ).toThrow(/prohibited/);
  });

  it("reports thinking levels for a reasoning model and none for a plain one", async () => {
    const [anthropic] = await piProviders(["anthropic"]);
    const levels = anthropic?.models.flatMap((m) => m.thinkingLevels) ?? [];
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(level);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/providers/pi-catalog.test.ts`
Expected: FAIL, "Cannot find module '../../src/providers/pi-catalog.ts'".

- [ ] **Step 3: Write minimal implementation**

Create `src/providers/pi-catalog.ts`:

```ts
/**
 * pi-ai's bundled catalog, normalised into nax-ai types.
 *
 * pi-ai is the data source, never the runtime shape: no Model<Api> escapes
 * this file. That is what lets a hand-written backend obtain baseUrl, headers
 * and model metadata without importing pi-ai.
 *
 * The import is dynamic because the bundled catalog is roughly 1,290 models
 * across 39 providers and costs about 50 ms to load. A consumer that does not
 * call this pays nothing.
 */

import type { ThinkingLevel } from "../protocols/types.ts";
import type { RawModel, RawProvider } from "./catalog.ts";
import type { PricingTier, ProviderAuth } from "./types.ts";

/**
 * Selects one of our two auth variants from pi-ai's, which may declare both.
 *
 * api-key wins when both are offered. This is not a tie-break for tidiness:
 * anthropic offers both, and mapping it to oauth would make the allowlist in
 * normaliseCatalog throw and render Anthropic unloadable. The prohibition is
 * on Anthropic subscription OAuth, never on its API.
 *
 * `env` is left unset. pi-ai's variable-name table is module-private, and the
 * two public routes to it either depend on the ambient environment or return
 * the secret itself, so there is no honest value to put here.
 */
function toProviderAuth(id: string, auth: { apiKey?: unknown; oauth?: unknown }): ProviderAuth {
  if (auth.apiKey !== undefined) return { kind: "api-key" };
  if (auth.oauth !== undefined) return { kind: "oauth", flow: id };
  throw new Error(`Provider "${id}" declares neither api-key nor oauth auth.`);
}

export async function piProviders(ids?: readonly string[]): Promise<RawProvider[]> {
  const { builtinProviders, getBuiltinModels, getBuiltinProviders } = await import(
    "@earendil-works/pi-ai/providers/all"
  );
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");

  const available = new Set<string>(getBuiltinProviders());
  const wanted = ids ?? [...available];

  const unknown = wanted.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown pi-ai provider(s): ${unknown.join(", ")}.`);
  }

  const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));

  return wanted.map((id) => {
    const provider = providers.get(id);
    if (provider === undefined) throw new Error(`Unknown pi-ai provider: ${id}.`);

    const piModels = getBuiltinModels(id as Parameters<typeof getBuiltinModels>[0]);

    const models: RawModel[] = piModels.map((model) => ({
      id: model.id,
      protocol: model.api,
      pricing: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
        ...(model.cost.tiers !== undefined
          ? {
              tiers: model.cost.tiers.map(
                (tier): PricingTier => ({
                  inputTokensAbove: tier.inputTokensAbove,
                  input: tier.input,
                  output: tier.output,
                  cacheRead: tier.cacheRead,
                  cacheWrite: tier.cacheWrite,
                }),
              ),
            }
          : {}),
      },
      contextWindow: model.contextWindow,
      // pi-ai's catalog does not carry a per-model tool flag; every model it
      // serves through these four protocols accepts tool definitions, and a
      // model that ignores them fails at request time, not at catalog time.
      supportsTools: true,
      thinkingLevels: getSupportedThinkingLevels(model) as readonly ThinkingLevel[],
    }));

    // A provider can span protocols, so the default is the one most of its
    // models use; per-model `protocol` above is what actually selects.
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.protocol ?? "", (counts.get(model.protocol ?? "") ?? 0) + 1);
    const defaultProtocol = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "openai-completions";

    const baseUrl = provider.baseUrl ?? piModels[0]?.baseUrl ?? "";
    const headers = piModels[0]?.headers;

    return {
      id,
      baseUrl,
      auth: toProviderAuth(id, provider.auth),
      ...(headers !== undefined ? { headers } : {}),
      defaultProtocol,
      models,
    };
  });
}
```

Add to `src/index.ts`:

```ts
export { piProviders } from "./providers/pi-catalog.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: PASS. `check-pi-ai-imports: clean` — `pi-catalog.ts` is on the ALLOWED list from Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/providers/pi-catalog.ts src/index.ts test/providers/pi-catalog.test.ts
git commit -m "feat: normalise pi-ai's bundled catalog into nax-ai types"
```

---

### Task 8: Prove apiKey precedence against a live provider

The spec (section 7.2) records this as an assumption, not a finding. Task 9 builds on it, so it is settled first. This task writes no production code.

**Files:**
- Create: `scripts/probe-apikey-precedence.ts`
- Create: `docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md` — append a "verified" note to section 7.2

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded finding that decides Task 9's implementation. No exported code.

**Requires:** a `DEEPSEEK_API_KEY`. Cost is a fraction of a cent.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-apikey-precedence.ts`:

```ts
/**
 * Answers one question: does an explicitly passed apiKey take precedence over
 * pi-ai's own credential resolution, or is it ignored?
 *
 * Run by hand. Not part of any suite.
 *   DEEPSEEK_API_KEY=sk-... bun run scripts/probe-apikey-precedence.ts
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const realKey = process.env.DEEPSEEK_API_KEY;
if (!realKey) {
  console.error("Set DEEPSEEK_API_KEY to run this probe.");
  process.exit(1);
}

const models = builtinModels();
const model = models.getModels("deepseek")[0];
if (!model) {
  console.error("No deepseek model in the catalog.");
  process.exit(1);
}

const context = { messages: [{ role: "user" as const, content: "Reply with the single word: ok", timestamp: 0 }] };

async function attempt(label: string, apiKey: string): Promise<string> {
  try {
    const stream = models.streamSimple(model, context, { apiKey, maxTokens: 16 });
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "error") return `${label}: ERROR ${event.error.errorMessage ?? "unknown"}`;
    }
    return `${label}: OK ${JSON.stringify(text)}`;
  } catch (error) {
    return `${label}: THREW ${String(error)}`;
  }
}

// If the explicit key wins, the deliberately-wrong one must fail even though
// the environment holds a working key.
console.log(await attempt("explicit-wrong-key", "sk-definitely-not-valid"));
console.log(await attempt("explicit-real-key", realKey));
```

- [ ] **Step 2: Run the probe**

Run: `DEEPSEEK_API_KEY=<your key> bun run scripts/probe-apikey-precedence.ts`

Expected, if the explicit key takes precedence:
```
explicit-wrong-key: ERROR ...401... (or THREW)
explicit-real-key: OK "ok"
```

If instead `explicit-wrong-key` succeeds, the explicit key is being ignored and pi-ai resolved the environment key itself.

- [ ] **Step 3: Record the finding and choose Task 9's shape**

Append to section 7.2 of `docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md`, filling in what actually happened:

```markdown
**Verified <the date you ran it>** by `scripts/probe-apikey-precedence.ts` against `deepseek`:
an explicitly passed `apiKey` [does / does not] take precedence over pi-ai's own
resolution. Task 9 therefore [passes resolved auth explicitly / lets `Models`
resolve and calls `AuthResolver` only for the credential-store adapter and for
what a native backend will need].
```

**If the explicit key wins** (expected): Task 9 proceeds as written.

**If it does not**: Task 9 changes in one way only — `createPiDeps` stops passing `apiKey` into `streamSimple` and instead relies on `Models` resolving from the shared credential store, while `AuthResolver` remains exported and is exercised by its own tests plus the live test in Task 10. Do not skip building `AuthResolver`; its purpose is that a native backend has a nax-ai-owned way to get credentials, and that purpose is unaffected by pi-ai's precedence rules.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-apikey-precedence.ts docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md
git commit -m "test: probe and record pi-ai apiKey precedence"
```

---

### Task 9: Auth port, credential adapter, and wiring

**Files:**
- Create: `src/auth/resolver.ts`
- Create: `src/auth/pi-auth.ts`
- Modify: `src/protocols/pi-client.ts` (`createPiDeps`)
- Modify: `src/index.ts`
- Test: `test/auth/pi-auth.test.ts`

**Interfaces:**
- Consumes: `CredentialStore`, `StoredCredential` from `src/types.ts`; `ResolvedModel` from `src/providers/types.ts`; `PiProtocolOptions` (Task 6).
- Produces:
  - `interface ResolvedAuth { readonly apiKey?: string; readonly headers?: Readonly<Record<string, string>> }`
  - `interface AuthResolver { resolve(model: ResolvedModel): Promise<ResolvedAuth> }`
  - `toPiCredentialStore(store: CredentialStore): PiCredentialStore` in `pi-auth.ts`
  - `createPiAuthResolver(models: MutableModels): AuthResolver` in `pi-auth.ts`

  Task 10's live test exercises both.

**One ruling this task implements:** `StoredCredential`'s api-key variant gains `env`. pi's own agent stores `key` as a literal, a `$VAR` template, or a `!command`, and resolves templates using `credential.env` as the substitution scope. An adapter with no slot for `env` would drop it on every `modify`, silently breaking any `$VAR`-style credential. nax-ai never inspects `key`; it round-trips it.

- [ ] **Step 1: Write the failing test**

Create `test/auth/pi-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPiAuthResolver, toPiCredentialStore } from "../../src/auth/pi-auth.ts";
import type { CredentialStore, StoredCredential } from "../../src/types.ts";

function memoryStore(initial: Record<string, StoredCredential> = {}): CredentialStore {
  const data = new Map(Object.entries(initial));
  return {
    read: async (id) => data.get(id),
    modify: async (id, fn) => {
      const next = await fn(data.get(id));
      if (next === undefined) data.delete(id);
      else data.set(id, next);
      return next;
    },
    delete: async (id) => {
      data.delete(id);
    },
  };
}

describe("toPiCredentialStore", () => {
  it("presents an api-key credential in pi's shape", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } }));
    expect(await pi.read("deepseek")).toEqual({ type: "api_key", key: "sk-1" });
  });

  it("presents an oauth credential in pi's shape", async () => {
    const pi = toPiCredentialStore(
      memoryStore({ "openai-codex": { kind: "oauth", access: "a", refresh: "r", expires: 42 } }),
    );
    expect(await pi.read("openai-codex")).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 42 });
  });

  it("round-trips env through modify without dropping it", async () => {
    const store = memoryStore({
      cloudflare: { kind: "api-key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } },
    });
    const pi = toPiCredentialStore(store);

    await pi.modify("cloudflare", async (current) => {
      expect(current).toEqual({ type: "api_key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } });
      return current;
    });

    expect(await store.read("cloudflare")).toEqual({
      kind: "api-key",
      key: "$CF_KEY",
      env: { CF_ACCOUNT: "acct-1" },
    });
  });

  it("treats key as opaque and never rewrites a template", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "!op read op://x/y" } }));
    expect((await pi.read("deepseek"))?.key).toBe("!op read op://x/y");
  });

  it("resolves undefined for a provider with no credential", async () => {
    expect(await toPiCredentialStore(memoryStore()).read("nope")).toBeUndefined();
  });

  it("deletes through to the underlying store", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).delete("deepseek");
    expect(await store.read("deepseek")).toBeUndefined();
  });

  it("supports removing a credential by returning undefined from modify", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).modify("deepseek", async () => undefined);
    expect(await store.read("deepseek")).toBeUndefined();
  });

  it("enumerates nothing, because nax-ai does not own account listing", async () => {
    expect(await toPiCredentialStore(memoryStore({ a: { kind: "api-key", key: "k" } })).list()).toEqual([]);
  });
});

describe("createPiAuthResolver", () => {
  /** Stands in for pi-ai's Models, which is the only part of it we call. */
  function fakeModels(result: unknown) {
    return { getAuth: async () => result } as unknown as Parameters<typeof createPiAuthResolver>[0];
  }

  it("returns the resolved api key for a provider", async () => {
    const resolver = createPiAuthResolver(fakeModels({ auth: { apiKey: "sk-live" } }));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({ apiKey: "sk-live" });
  });

  it("forwards resolved headers and drops the nulls pi uses to suppress defaults", async () => {
    const resolver = createPiAuthResolver(
      fakeModels({ auth: { headers: { authorization: "Bearer t", "x-drop": null } } }),
    );
    expect(await resolver.resolve({ provider: "openai-codex", model: "gpt-5.4" })).toEqual({
      headers: { authorization: "Bearer t" },
    });
  });

  it("resolves empty for an unconfigured provider rather than throwing", async () => {
    const resolver = createPiAuthResolver(fakeModels(undefined));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/auth/pi-auth.test.ts`
Expected: FAIL, "Cannot find module '../../src/auth/pi-auth.ts'".

- [ ] **Step 3: Write minimal implementation**

Add `env` to `src/types.ts`'s `StoredCredential`:

```ts
export type StoredCredential =
  | {
      readonly kind: "api-key";
      /**
       * Opaque. Some stores hold a literal, others a "$VAR" template or a
       * "!command"; resolving those is the store's business, not nax-ai's.
       * Never inspect, compare or log this value.
       */
      readonly key: string;
      /** Provider-scoped values, including the substitution scope for `key`. */
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "oauth";
      readonly access: string;
      readonly refresh: string;
      /** Epoch milliseconds. */
      readonly expires: number;
    };
```

Create `src/auth/resolver.ts`:

```ts
/**
 * The auth port.
 *
 * pi-ai resolves credentials today, but a hand-written backend will need the
 * same thing and must not import pi-ai to get it. Keeping the port here, in
 * nax-ai's own vocabulary, is what stops "delete the pi backend" from also
 * deleting credential handling.
 */

import type { ModelRef } from "../types.ts";

/**
 * Request auth for one call.
 *
 * There is deliberately no `baseUrl`: it belongs to the model, and the
 * upstream request options have no per-request slot for it.
 */
export interface ResolvedAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AuthResolver {
  /**
   * Refreshes an expired OAuth token as a side effect, under the store lock.
   *
   * Takes a `ModelRef` rather than a `ResolvedModel` so the pi protocol, which
   * holds a pi-ai model, can call this without first round-tripping through
   * the catalog.
   */
  resolve(ref: ModelRef): Promise<ResolvedAuth>;
}
```

Create `src/auth/pi-auth.ts`:

```ts
/**
 * pi-ai's side of auth: a credential-store adapter and an AuthResolver.
 *
 * On the ALLOWED list in scripts/check-pi-ai-imports.ts. Nothing here leaks a
 * pi-ai type through an export a consumer sees.
 */

import type { Credential, CredentialStore as PiCredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { CredentialStore, ModelRef, StoredCredential } from "../types.ts";
import type { AuthResolver, ResolvedAuth } from "./resolver.ts";

function toPi(credential: StoredCredential | undefined): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "api-key") {
    return {
      type: "api_key",
      key: credential.key,
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

function fromPi(credential: Credential | undefined): StoredCredential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "api_key") {
    return {
      kind: "api-key",
      key: credential.key ?? "",
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    kind: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

export function toPiCredentialStore(store: CredentialStore): PiCredentialStore {
  return {
    read: async (providerId) => toPi(await store.read(providerId)),

    // modify stays a single read-modify-write so the underlying store can hold
    // a lock across the whole operation. pi-ai runs OAuth refresh inside it.
    modify: async (providerId, fn) =>
      toPi(await store.modify(providerId, async (current) => fromPi(await fn(toPi(current))))),

    delete: async (providerId) => {
      await store.delete(providerId);
    },

    // pi-ai requires `list` for account and status enumeration. nax-ai's
    // CredentialStore has no equivalent and nax-ai never enumerates accounts:
    // that belongs to login and logout, which are out of scope for M2. An
    // empty list is what "this store does not enumerate" looks like, and it is
    // only ever read by UI that nax-ai does not have.
    list: async () => [],
  };
}

export function createPiAuthResolver(models: MutableModels): AuthResolver {
  return {
    async resolve(ref: ModelRef): Promise<ResolvedAuth> {
      const result = await models.getAuth(ref.provider);
      const auth = result?.auth;
      if (auth === undefined) return {};
      return {
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined
          ? { headers: Object.fromEntries(Object.entries(auth.headers).filter(([, v]) => v !== null)) }
          : {}),
      };
    },
  };
}
```

Wire the credential store into `createPiDeps` in `src/protocols/pi-client.ts`, replacing the `_options` stub Task 6 left:

```ts
import { createPiAuthResolver, toPiCredentialStore } from "../auth/pi-auth.ts";
import type { PiProtocolOptions } from "./pi-protocols.ts";

export function createPiDeps(options: PiProtocolOptions = {}): PiDeps {
  const models =
    options.credentials === undefined
      ? (shared ??= builtinModels())
      : builtinModels({ credentials: toPiCredentialStore(options.credentials) });
  const resolver = createPiAuthResolver(models);
  // resolveModel is unchanged; only `stream` gains the resolver call below.
}
```

If Task 8 found that an explicit `apiKey` takes precedence, also resolve and pass it in `stream`:

```ts
    stream: async function* (model, context, options_, onResponse) {
      // Resolve through nax-ai's own port, not through Models' internal path,
      // so the seam a native backend will use is exercised in production
      // rather than merely exported.
      const auth = await resolver.resolve({ provider: model.provider, model: model.id });
      yield* models.streamSimple(model, context, {
        ...options_,
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined ? { headers: { ...auth.headers } } : {}),
        onResponse: (response) => onResponse({ status: response.status, headers: response.headers }),
      });
    },
```

Add to `src/index.ts`:

```ts
export type { AuthResolver, ResolvedAuth } from "./auth/resolver.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth src/types.ts src/protocols/pi-client.ts src/index.ts test/auth/pi-auth.test.ts
git commit -m "feat: auth resolver port and pi-ai credential store adapter"
```

---

### Task 10: Live tests and the fixture recorder

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json` (add `test:live`)
- Create: `test/live/support/record.ts`
- Create: `test/live/complete.live.test.ts`
- Modify: `.gitignore` (ignore recorded fixtures until M3 curates them)

**Interfaces:**
- Consumes: `createClient`, `piProviders` (Task 7), `piProtocols` (Task 6).
- Produces: `test/fixtures/recorded/<provider>-<case>.json` — the raw `ProtocolEvent` sequence per live case. M3 consumes these.

**Requires:** a `DEEPSEEK_API_KEY`. Cost is a fraction of a cent per run.

- [ ] **Step 1: Exclude live tests from the default run, and add the script**

In `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests reach real providers and cost money. They are opt-in through
    // `bun run test:live`; each also skips itself without a key, so a mis-run
    // is free rather than merely unlikely.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
```

In `package.json` scripts:

```json
    "test:live": "vitest --run --exclude '**/node_modules/**' test/live",
```

In `.gitignore`, add:

```
test/fixtures/recorded/
```

- [ ] **Step 2: Write the recorder and the live test**

Create `test/live/support/record.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProtocolEvent } from "../../../src/protocols/types.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "recorded");

/**
 * Writes a live run's event sequence to disk so M3 can build its fixture suite
 * from real provider output rather than from scripted guesses.
 */
export function record(name: string, events: readonly ProtocolEvent[]): void {
  const file = join(DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}
```

Create `test/live/complete.live.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { piProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEvent } from "../../src/protocols/types.ts";
import { piProviders } from "../../src/providers/pi-catalog.ts";
import { record } from "./support/record.ts";

const KEY = process.env.DEEPSEEK_API_KEY;
const PROVIDER = "deepseek";

async function client() {
  return createClient({ providers: await piProviders([PROVIDER]), protocols: piProtocols() });
}

describe.skipIf(!KEY)("live completion against deepseek", () => {
  it("returns text and non-zero usage", async () => {
    const c = await client();
    const models = await c.listModels(PROVIDER);
    const model = models[0];
    if (!model) throw new Error("No deepseek model in the catalog.");

    const events: ProtocolEvent[] = [];
    for await (const event of c.stream(model, {
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 16,
    })) {
      events.push(event);
    }
    record(`${PROVIDER}-text`, events);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done" });

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.usage.inputTokens).toBeGreaterThan(0);
      expect(usage.usage.outputTokens).toBeGreaterThan(0);
    }

    const text = events
      .filter((e): e is Extract<ProtocolEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("round-trips a tool call", async () => {
    const c = await client();
    const models = await c.listModels(PROVIDER);
    const model = models[0];
    if (!model) throw new Error("No deepseek model in the catalog.");

    const events: ProtocolEvent[] = [];
    for await (const event of c.stream(model, {
      messages: [{ role: "user", content: "Read the file a.ts using the read tool." }],
      tools: [
        {
          name: "read",
          description: "Read a file from disk",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      maxTokens: 128,
    })) {
      events.push(event);
    }
    record(`${PROVIDER}-tool`, events);

    const call = events.find((e) => e.type === "tool-call");
    expect(call).toBeDefined();
    if (call?.type === "tool-call") {
      expect(call.call.name).toBe("read");
      expect(call.call.input).toBeTypeOf("object");
    }
  });
});
```

- [ ] **Step 3: Verify CI does not pick the live tests up**

Run: `bun run test`
Expected: PASS, and the live file is absent from the reported file list.

- [ ] **Step 4: Run the live tests**

Run: `DEEPSEEK_API_KEY=<your key> bun run test:live`
Expected: 2 passed. `test/fixtures/recorded/deepseek-text.json` and `deepseek-tool.json` exist and contain the event sequences.

If the tool test fails because the model declined to call the tool, adjust the prompt to be more directive rather than weakening the assertion — the point of the case is that a real tool call round-trips.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json .gitignore test/live
git commit -m "test: opt-in live provider tests that record fixtures for M3"
```

---

### Task 11: Codex OAuth check, publish, and roadmap

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md` (section 11, tick the items)

**Interfaces:**
- Consumes: everything above.
- Produces: `@nathapp/nax-ai@0.1.0` on the `next` dist-tag.

- [ ] **Step 1: Verify a Codex OAuth request end to end**

This needs an existing credential; M2 does not implement login. Obtain one with the `pi` CLI, then point a live run at it.

Run: `bun x vitest --run --exclude '**/node_modules/**' test/live` with a `CredentialStore` reading that credential, by temporarily adding a case to `test/live/complete.live.test.ts` that constructs `piProtocols({ credentials: <store over ~/.pi/agent/auth.json> })` and streams one short completion from `openai-codex`.

Expected: text and non-zero usage, proving OAuth resolution and refresh work through the adapter.

If no Codex credential is available, stop and report that DoD item 4 is unmet rather than marking the milestone done.

- [ ] **Step 2: Update the README**

Replace the "cannot make a network call" note at `README.md:16` with a short usage example:

````markdown
```ts
import { createClient, piProtocols, piProviders } from "@nathapp/nax-ai";

const client = createClient({
  providers: await piProviders(["deepseek", "anthropic"]),
  protocols: piProtocols(),
});

const model = await client.model("deepseek", "deepseek-chat");
const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });
```

Install from the `next` dist-tag while the API is unstable: `npm install @nathapp/nax-ai@next`.
````

- [ ] **Step 3: Update the ROADMAP**

In `ROADMAP.md`: set M2 to done and M3 to next in the position table, change the `### M2 — real transport` heading's marker, and remove the "The package as it stands cannot make a network call" warning section, since it is no longer true.

- [ ] **Step 4: Publish to the `next` dist-tag**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
npm publish --tag next
npm dist-tag ls @nathapp/nax-ai
```

Expected: `next: 0.1.0`, and **no** `latest` entry. If `latest` appears, remove it immediately — the API is unstable and M1's warning stands until it is not.

- [ ] **Step 5: Commit**

```bash
git add README.md ROADMAP.md docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md
git commit -m "docs: M2 complete, published 0.1.0 to the next dist-tag"
```
