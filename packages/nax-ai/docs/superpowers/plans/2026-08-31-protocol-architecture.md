# nax-ai Protocol Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the protocol layer of `@nathapp/nax-ai` — a provider-agnostic LLM client that wraps `@earendil-works/pi-ai` today behind a seam that lets individual wire protocols be replaced with hand-written implementations later.

**Architecture:** A `Protocol` interface exposes streaming only; `complete` is derived once at the client layer. Protocols are resolved through a runtime registry that can hold multiple backends per protocol (`pi` today, `native` later), so a hand-written implementation can be compared against the pi-backed one on real traffic before becoming the default. Providers are passed through from pi-ai's bundled catalog, normalised into nax-ai's own types so a future native backend never imports pi-ai.

**Tech Stack:** TypeScript 7.0.2 (exact), Node ≥ 22.19 ESM, Vitest 4.1.9, Biome 2.5.10, Bun 1.4 as dev toolchain, `@earendil-works/pi-ai` 0.84.4 (exact).

**Spec:** `docs/superpowers/specs/2026-08-31-nax-ai-protocol-architecture-design.md` — read it before starting. This plan implements that spec and argues from it.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node ≥ 22.19, ESM-only.** No CommonJS build.
- **No `Bun.*` APIs or `bun:` imports in `src/`.** Enforced by `scripts/check-no-bun-apis.ts`, which runs as part of `bun run lint`. Use `node:` builtins and web globals (`fetch`, `AbortSignal`, `URL`).
- **Relative imports use `.ts` extensions.** `tsconfig.json` sets `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`; the compiler rewrites them to `.js` on emit. Writing `.js` in source is wrong here.
- **`moduleResolution: "nodenext"`.** Do not change it to `"bundler"`.
- **No pi-ai types in the public API.** `@earendil-works/pi-ai` may only be imported inside `src/protocols/*/backend-pi.ts` and `src/providers/catalog.ts`. Everything else uses nax-ai's own types. Task 9 adds a gate enforcing this.
- **Anthropic OAuth is prohibited** — never add `"anthropic"` to `PERMITTED_OAUTH_FLOWS`. It is server-blocked and a Consumer ToS violation. Anthropic *API-key* billing is fine and unrelated.
- **nax-ai holds no policy.** No reading `process.env` to decide behaviour, no cost computation, no tool execution, no rate-limit retry.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` are all on. `exactOptionalPropertyTypes` in particular means `{ foo?: string }` will not accept `{ foo: undefined }` — construct objects conditionally rather than assigning `undefined`.
- **No non-null assertions in tests.** `style/noNonNullAssertion` is `error` under `test/**`. Hoist a fixture to a named const rather than writing `FIXTURES[0]!`.
- **Deep relative imports are fine here.** nax bans `../../*` via `noRestrictedImports`; that rule has been removed from this repo's `biome.json` deliberately. nax can ban it because it uses `@/` path aliases and bundles with `bun build`; nax-ai emits *unbundled* ESM, and `tsc` does not rewrite path aliases on emit — an alias would appear literally in `dist/` and fail for consumers. Do not re-add the rule or introduce path aliases.

**Pre-verified:** every code block in Tasks 1–8 has been compiled against this repo's `tsconfig.json` and its tests executed — 35 tests, `tsc --noEmit` exit 0. The code is known to work as written; if something fails, suspect a transcription slip rather than a design error.

**Commands:**

| Purpose | Command |
|---|---|
| Run all tests | `bun x vitest --run` |
| Run one test file | `bun x vitest --run test/path/file.test.ts` |
| Typecheck | `bun x tsc --noEmit` |
| Lint (includes the Bun-API gate) | `bun run lint` |
| Build | `bun run build` |

**Already implemented — do not recreate:**

| File | Contains |
|---|---|
| `src/types.ts` | `ProviderId`, `ModelRef`, `Message`, `MessageRole`, `TokenUsage`, `StopReason`, `CompleteOptions`, `CompleteResult`, `CredentialStore`, `StoredCredential` |
| `src/usage.ts` | `toTokenUsage`, `totalTokens`, `UpstreamUsage` |
| `src/auth/oauth-policy.ts` | `PERMITTED_OAUTH_FLOWS`, `PROHIBITED_OAUTH_FLOWS`, `isOAuthFlowPermitted`, `assertOAuthFlowPermitted`, `OAuthFlowProhibitedError` |
| `src/index.ts` | Public re-exports |
| `test/oauth-policy.test.ts` | 6 passing tests |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/protocols/types.ts` | `Protocol`, `ProtocolRequest`, `ProtocolEvent`, `ProtocolError`, `ToolDefinition`, `ToolCall`, `ConversationMessage`, `ThinkingLevel`, `CacheRetention`, `JsonSchema` |
| `src/protocols/registry.ts` | Backend registration, selection, lazy resolution, `validate()` |
| `src/protocols/collect.ts` | Derives `complete` from a stream — used by the client, shared by all protocols |
| `src/protocols/anthropic-messages/backend-pi.ts` | pi-ai-backed implementation |
| `src/protocols/anthropic-messages/index.ts` | Registers this protocol's backends |
| `src/protocols/openai-completions/…` | Same shape |
| `src/protocols/openai-responses/…` | Same shape |
| `src/protocols/openai-codex-responses/…` | Same shape |
| `src/providers/types.ts` | `ResolvedProvider`, `ResolvedModel`, `Pricing`, `ProviderAuth`, `ProviderOverride` |
| `src/providers/catalog.ts` | Normalises pi-ai's bundled catalog into nax-ai types; calls the OAuth gate |
| `src/client.ts` | `createClient`, `Client` — ties registry to catalog |
| `test/support/conformance.ts` | Shared `Protocol` contract suite, run against every backend |
| `test/support/fixtures/*.json` | Recorded provider responses |
| `scripts/check-pi-ai-imports.ts` | Gate: pi-ai may only be imported in allowed files |

Task order builds bottom-up: types → registry → collect → one real protocol → catalog → client → remaining protocols → gates.

---

### Task 1: Protocol types

**Files:**
- Create: `src/protocols/types.ts`
- Test: `test/protocols/types.test.ts`

**Interfaces:**
- Consumes: `TokenUsage`, `StopReason` from `src/types.ts`
- Produces: `Protocol`, `ProtocolRequest`, `ProtocolEvent`, `ProtocolError`, `ConversationMessage`, `ToolDefinition`, `ToolCall`, `ThinkingLevel`, `CacheRetention`, `JsonSchema`

Types alone are not behaviour, so the test here pins the *discriminants* — the event `type` strings and error `kind` strings that every backend and every consumer switch on. A typo in one of these is a runtime bug that types alone will not catch across a lazy module boundary.

- [ ] **Step 1: Write the failing test**

```ts
// test/protocols/types.test.ts
import { describe, expect, it } from "vitest";
import { PROTOCOL_EVENT_TYPES, PROTOCOL_ERROR_KINDS, THINKING_LEVELS } from "../../src/protocols/types.ts";

describe("protocol discriminants", () => {
  it("declares exactly the seven event types the spec names", () => {
    expect([...PROTOCOL_EVENT_TYPES]).toEqual([
      "text-delta",
      "thinking-delta",
      "tool-call-partial",
      "tool-call",
      "usage",
      "error",
      "done",
    ]);
  });

  it("declares the six error kinds", () => {
    expect([...PROTOCOL_ERROR_KINDS]).toEqual([
      "rate-limit",
      "auth",
      "overloaded",
      "bad-request",
      "transport",
      "unknown",
    ]);
  });

  it("declares thinking levels in ascending order, off first", () => {
    // Order is load-bearing: clamping picks the nearest supported level by index.
    expect([...THINKING_LEVELS]).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/types.test.ts`
Expected: FAIL — cannot resolve `../../src/protocols/types.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/protocols/types.ts
/**
 * Wire-protocol vocabulary.
 *
 * Every concept here appears in more than one provider's wire format, or is a
 * deliberate normalisation. No field is named after one provider's API: the
 * point of this file is that a backend for any provider can be written against
 * it without the interface having already picked a side.
 */

import type { StopReason, TokenUsage } from "../types.ts";

/** JSON Schema draft 2020-12 object. Structural — nax-ai does not validate it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Ascending order is load-bearing: clamping an unsupported level picks the
 * nearest supported one by index, so reordering this array changes behaviour.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];

export const PROTOCOL_EVENT_TYPES = [
  "text-delta",
  "thinking-delta",
  "tool-call-partial",
  "tool-call",
  "usage",
  "error",
  "done",
] as const;
export type ProtocolEventType = (typeof PROTOCOL_EVENT_TYPES)[number];

export const PROTOCOL_ERROR_KINDS = [
  "rate-limit",
  "auth",
  "overloaded",
  "bad-request",
  "transport",
  "unknown",
] as const;
export type ProtocolErrorKind = (typeof PROTOCOL_ERROR_KINDS)[number];

export interface ProtocolError {
  readonly kind: ProtocolErrorKind;
  readonly message: string;
  readonly status?: number;
  /** Seconds, when the provider signals one. The consumer owns the retry loop. */
  readonly retryAfter?: number;
  readonly cause?: unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed. A protocol accumulates streamed JSON fragments and parses before emitting. */
  readonly input: unknown;
}

export type ConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface ProtocolRequest {
  readonly model: string;
  /**
   * Kept out of `messages` deliberately: Anthropic takes a top-level `system`
   * parameter while OpenAI takes a system message in the array. Each backend
   * places it correctly, so callers never encode a provider's shape.
   */
  readonly system?: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: "auto" | "none";
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly thinking?: ThinkingLevel;
  readonly cacheRetention?: CacheRetention;
  readonly signal?: AbortSignal;
}

export type ProtocolEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | {
      readonly type: "tool-call-partial";
      readonly id: string;
      readonly name: string;
      /** Raw accumulated JSON fragment — for progress display only. */
      readonly rawInput: string;
    }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "error"; readonly error: ProtocolError }
  | { readonly type: "done"; readonly stopReason: StopReason };

/**
 * A wire protocol.
 *
 * `complete` is deliberately absent. It is derived once, at the client layer,
 * by collecting a stream — so a backend has no way to implement it as a second
 * request path that drifts from this one.
 */
export interface Protocol {
  readonly name: string;
  stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/protocols/types.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/protocols/types.ts test/protocols/types.test.ts
git commit -m "feat: protocol type vocabulary"
```

---

### Task 2: Thinking-level clamping

**Files:**
- Create: `src/protocols/thinking.ts`
- Test: `test/protocols/thinking.test.ts`

**Interfaces:**
- Consumes: `ThinkingLevel`, `THINKING_LEVELS` from `src/protocols/types.ts`
- Produces: `clampThinkingLevel(requested: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel`

Every backend needs this, so it lives outside them. The spec's rule: a request naming a level a model does not support clamps to the nearest supported level rather than throwing, because a valid-looking profile should not become a hard error just because one model exposes a coarser scale.

- [ ] **Step 1: Write the failing test**

```ts
// test/protocols/thinking.test.ts
import { describe, expect, it } from "vitest";
import { clampThinkingLevel } from "../../src/protocols/thinking.ts";

describe("clampThinkingLevel", () => {
  it("returns the requested level when supported", () => {
    expect(clampThinkingLevel("high", ["off", "low", "high"])).toBe("high");
  });

  it("clamps down to the nearest lower level", () => {
    expect(clampThinkingLevel("max", ["off", "low", "medium"])).toBe("medium");
  });

  it("clamps up when nothing lower exists", () => {
    expect(clampThinkingLevel("minimal", ["medium", "high"])).toBe("medium");
  });

  it("prefers the lower neighbour on a tie", () => {
    // "low"(2) is equidistant from "minimal"(1) and "medium"(3). Prefer lower:
    // spending fewer thinking tokens than asked is the safer surprise.
    expect(clampThinkingLevel("low", ["minimal", "medium"])).toBe("minimal");
  });

  it("returns off when the model supports no thinking", () => {
    expect(clampThinkingLevel("high", [])).toBe("off");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/thinking.test.ts`
Expected: FAIL — cannot resolve `../../src/protocols/thinking.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/protocols/thinking.ts
/**
 * Clamping a requested thinking level onto what a model actually supports.
 *
 * Clamping rather than throwing is deliberate: models expose different
 * granularities, and a profile that says "high" should not fail outright
 * because one model only offers off/low/medium. The caller's intent — think
 * harder than default — is still expressible.
 */

import { THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

const rank = (level: ThinkingLevel): number => THINKING_LEVELS.indexOf(level);

export function clampThinkingLevel(
  requested: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supported.length === 0) return "off";
  if (supported.includes(requested)) return requested;

  // Sorted ascending so that "first seen wins on a tie" means "lower level
  // wins" — callers are not required to pass an ordered list.
  const ordered = [...supported].sort((a, b) => rank(a) - rank(b));
  const target = rank(requested);

  // Safe: `ordered` is non-empty, guarded above. noUncheckedIndexedAccess
  // still widens the type, hence the assertion.
  let best = ordered[0] as ThinkingLevel;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const level of ordered) {
    const distance = Math.abs(rank(level) - target);
    // Strict `<` keeps the first-seen (lower) candidate on a tie: spending
    // fewer thinking tokens than asked is the safer surprise.
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/protocols/thinking.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/protocols/thinking.ts test/protocols/thinking.test.ts
git commit -m "feat: thinking-level clamping"
```

---

### Task 3: Protocol registry

**Files:**
- Create: `src/protocols/registry.ts`
- Test: `test/protocols/registry.test.ts`

**Interfaces:**
- Consumes: `Protocol` from `src/protocols/types.ts`
- Produces: `BackendId`, `ProtocolBackends`, `BackendSelection`, `ProtocolRegistry`, `createRegistry(entries, selection?)`, `UnknownProtocolError`, `UnregisteredBackendError`

Two behaviours here are load-bearing and must be tested, not assumed: backends resolve **lazily** (so pi-ai's SDKs are not imported until used), and requesting a backend that is not registered **throws rather than falling back** — a silent fallback would make an A/B comparison report results for an implementation that never ran.

- [ ] **Step 1: Write the failing test**

```ts
// test/protocols/registry.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRegistry, UnknownProtocolError, UnregisteredBackendError } from "../../src/protocols/registry.ts";
import type { Protocol } from "../../src/protocols/types.ts";

const stubProtocol = (name: string): Protocol => ({
  name,
  // eslint-disable-next-line require-yield
  async *stream() {
    return;
  },
});

describe("createRegistry", () => {
  it("does not invoke a backend factory until resolve is called", () => {
    const factory = vi.fn(async () => stubProtocol("p"));
    createRegistry({ p: { pi: factory } });
    expect(factory).not.toHaveBeenCalled();
  });

  it("resolves the pi backend by default", async () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } });
    await expect(registry.resolve("p")).resolves.toMatchObject({ name: "p" });
  });

  it("caches the resolved protocol so the factory runs once", async () => {
    const factory = vi.fn(async () => stubProtocol("p"));
    const registry = createRegistry({ p: { pi: factory } });
    await registry.resolve("p");
    await registry.resolve("p");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("honours a per-protocol override", async () => {
    const registry = createRegistry(
      {
        p: {
          pi: async () => stubProtocol("pi-impl"),
          native: async () => stubProtocol("native-impl"),
        },
      },
      { byProtocol: { p: "native" } },
    );
    await expect(registry.resolve("p")).resolves.toMatchObject({ name: "native-impl" });
  });

  it("throws rather than falling back when the selected backend is unregistered", async () => {
    // A silent fallback to pi would make an A/B comparison report results for
    // an implementation that never ran. This must fail loudly.
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { p: "native" } });
    await expect(registry.resolve("p")).rejects.toThrow(UnregisteredBackendError);
  });

  it("throws for an unknown protocol name", async () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } });
    await expect(registry.resolve("nope")).rejects.toThrow(UnknownProtocolError);
  });

  it("reports available backends per protocol", () => {
    const registry = createRegistry({
      p: { pi: async () => stubProtocol("p"), native: async () => stubProtocol("p") },
      q: { pi: async () => stubProtocol("q") },
    });
    expect(registry.available().get("p")).toEqual(["pi", "native"]);
    expect(registry.available().get("q")).toEqual(["pi"]);
  });

  it("validate() surfaces a selection naming an unregistered backend", () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { p: "native" } });
    expect(() => registry.validate()).toThrow(UnregisteredBackendError);
  });

  it("validate() surfaces a selection naming an unknown protocol", () => {
    const registry = createRegistry({ p: { pi: async () => stubProtocol("p") } }, { byProtocol: { typo: "pi" } });
    expect(() => registry.validate()).toThrow(UnknownProtocolError);
  });

  it("validate() passes for a satisfiable selection", () => {
    const registry = createRegistry(
      { p: { pi: async () => stubProtocol("p"), native: async () => stubProtocol("p") } },
      { byProtocol: { p: "native" } },
    );
    expect(() => registry.validate()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/registry.test.ts`
Expected: FAIL — cannot resolve `../../src/protocols/registry.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/protocols/registry.ts
/**
 * Protocol backend registration and selection.
 *
 * A protocol may have more than one backend — `pi` today, `native` when a wire
 * format is hand-written later. Both can be registered at once so a native
 * implementation can be run against the pi-backed one on real traffic before
 * becoming the default. That comparison is the reason selection happens at
 * runtime rather than by swapping a module at build time.
 */

import type { Protocol } from "./types.ts";

export type BackendId = "pi" | "native";

/** Lazy factories keyed by backend id. Laziness preserves pi-ai's deferred SDK loading. */
export type ProtocolBackends = Partial<Record<BackendId, () => Promise<Protocol>>>;

export type ProtocolEntries = Readonly<Record<string, ProtocolBackends>>;

export interface BackendSelection {
  /** Applied to protocols not named in `byProtocol`. Defaults to "pi". */
  readonly default?: BackendId;
  readonly byProtocol?: Readonly<Record<string, BackendId>>;
}

export class UnknownProtocolError extends Error {
  constructor(readonly protocolName: string) {
    super(`Unknown protocol "${protocolName}".`);
    this.name = "UnknownProtocolError";
  }
}

export class UnregisteredBackendError extends Error {
  constructor(
    readonly protocolName: string,
    readonly backendId: BackendId,
    available: readonly BackendId[],
  ) {
    super(
      `Backend "${backendId}" is not registered for protocol "${protocolName}". ` +
        `Available: ${available.length > 0 ? available.join(", ") : "none"}. ` +
        `This is not falling back — a silent fallback would misreport which implementation ran.`,
    );
    this.name = "UnregisteredBackendError";
  }
}

export interface ProtocolRegistry {
  available(): ReadonlyMap<string, readonly BackendId[]>;
  resolve(protocolName: string): Promise<Protocol>;
  /** Throws if any configured selection names an unknown protocol or unregistered backend. */
  validate(): void;
}

export function createRegistry(
  entries: ProtocolEntries,
  selection: BackendSelection = {},
): ProtocolRegistry {
  const resolved = new Map<string, Promise<Protocol>>();

  const backendsFor = (protocolName: string): ProtocolBackends => {
    const backends = entries[protocolName];
    if (backends === undefined) throw new UnknownProtocolError(protocolName);
    return backends;
  };

  const idsFor = (backends: ProtocolBackends): readonly BackendId[] =>
    (Object.keys(backends) as BackendId[]).filter((id) => backends[id] !== undefined);

  const selectedFor = (protocolName: string): BackendId =>
    selection.byProtocol?.[protocolName] ?? selection.default ?? "pi";

  return {
    available() {
      const map = new Map<string, readonly BackendId[]>();
      for (const [name, backends] of Object.entries(entries)) {
        map.set(name, idsFor(backends));
      }
      return map;
    },

    async resolve(protocolName) {
      const cached = resolved.get(protocolName);
      if (cached !== undefined) return cached;

      const backends = backendsFor(protocolName);
      const backendId = selectedFor(protocolName);
      const factory = backends[backendId];
      if (factory === undefined) {
        throw new UnregisteredBackendError(protocolName, backendId, idsFor(backends));
      }

      const promise = factory();
      resolved.set(protocolName, promise);
      return promise;
    },

    validate() {
      for (const [protocolName, backendId] of Object.entries(selection.byProtocol ?? {})) {
        const backends = backendsFor(protocolName);
        if (backends[backendId] === undefined) {
          throw new UnregisteredBackendError(protocolName, backendId, idsFor(backends));
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/protocols/registry.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/protocols/registry.ts test/protocols/registry.test.ts
git commit -m "feat: protocol backend registry with lazy resolution"
```

---

### Task 4: Deriving complete from a stream

**Files:**
- Create: `src/protocols/collect.ts`
- Test: `test/protocols/collect.test.ts`

**Interfaces:**
- Consumes: `ProtocolEvent` from `src/protocols/types.ts`, `TokenUsage`, `CompleteResult` from `src/types.ts`
- Produces: `collectStream(events: AsyncIterable<ProtocolEvent>): Promise<CompleteResult>`

This is where the spec's one deliberate inversion lives: everywhere else an error is an *event*, because a mid-stream failure should not discard text and usage already received. But a caller awaiting a single result has nowhere to put a partial one, so here an error event **rejects**.

`CompleteResult` in `src/types.ts` must gain `toolCalls?: readonly ToolCall[]` for the tools surface — do that in Step 3.

- [ ] **Step 1: Write the failing test**

```ts
// test/protocols/collect.test.ts
import { describe, expect, it } from "vitest";
import { collectStream } from "../../src/protocols/collect.ts";
import type { ProtocolEvent } from "../../src/protocols/types.ts";

async function* emit(...events: ProtocolEvent[]): AsyncIterable<ProtocolEvent> {
  for (const event of events) yield event;
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("collectStream", () => {
  it("concatenates text deltas in order", async () => {
    const result = await collectStream(
      emit(
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", usage },
        { type: "done", stopReason: "stop" },
      ),
    );
    expect(result.text).toBe("Hello");
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual(usage);
  });

  it("collects completed tool calls and ignores partials", async () => {
    const call = { id: "t1", name: "read", input: { path: "a.ts" } };
    const result = await collectStream(
      emit(
        { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"pa' },
        { type: "tool-call", call },
        { type: "usage", usage },
        { type: "done", stopReason: "tool_use" },
      ),
    );
    expect(result.toolCalls).toEqual([call]);
  });

  it("rejects on an error event", async () => {
    // The one inversion of the events-not-exceptions rule: a caller awaiting a
    // single result has nowhere to put a partial one.
    await expect(
      collectStream(
        emit(
          { type: "text-delta", text: "partial" },
          { type: "error", error: { kind: "overloaded", message: "busy" } },
        ),
      ),
    ).rejects.toThrow(/busy/);
  });

  it("throws when the stream ends without a done event", async () => {
    // A truncated stream must not look like a clean short answer.
    await expect(collectStream(emit({ type: "text-delta", text: "x" }))).rejects.toThrow(/without a done event/i);
  });

  it("reports zeroed usage when the provider sent none", async () => {
    const result = await collectStream(emit({ type: "done", stopReason: "stop" }));
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("ignores thinking deltas in the collected text", async () => {
    const result = await collectStream(
      emit(
        { type: "thinking-delta", text: "hmm" },
        { type: "text-delta", text: "answer" },
        { type: "done", stopReason: "stop" },
      ),
    );
    expect(result.text).toBe("answer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/collect.test.ts`
Expected: FAIL — cannot resolve `../../src/protocols/collect.ts`

- [ ] **Step 3: Add `toolCalls` to `CompleteResult`, then write the implementation**

In `src/types.ts`, replace the `CompleteResult` interface with:

```ts
export interface CompleteResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
  readonly toolCalls?: readonly import("./protocols/types.ts").ToolCall[];
}
```

This creates a **type-only import cycle**: `src/types.ts` refers to `protocols/types.ts` for `ToolCall`, and `protocols/types.ts` imports `TokenUsage` and `StopReason` from `src/types.ts`. That is legal and safe — both directions are type-only, so nothing survives to runtime and there is no module-initialisation cycle. The inline `import(...)` form is used rather than a top-level `import type` to keep the cycle obvious at the point of use. If `tsc` reports a circularity error rather than a warning, the fallback is to move `ToolCall` into `src/types.ts` and have `protocols/types.ts` re-export it — but try the above first, as it keeps the protocol vocabulary together.

Then create:

```ts
// src/protocols/collect.ts
/**
 * Derives a single result from a protocol stream.
 *
 * Implemented once, here, rather than per protocol — that is why `Protocol`
 * exposes only `stream`. A backend cannot let a request/response path drift
 * from its streaming path if it never writes one.
 */

import type { CompleteResult, TokenUsage } from "../types.ts";
import type { ProtocolError, ProtocolEvent, ToolCall } from "./types.ts";

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export class ProtocolStreamError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
    if (protocolError.cause !== undefined) this.cause = protocolError.cause;
  }
}

export async function collectStream(
  events: AsyncIterable<ProtocolEvent>,
): Promise<CompleteResult> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  let usage: TokenUsage | undefined;
  let stopReason: CompleteResult["stopReason"] | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "text-delta":
        text.push(event.text);
        break;
      case "tool-call":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new ProtocolStreamError(event.error);
      case "done":
        stopReason = event.stopReason;
        break;
      // Thinking text is not part of the answer, and a partial tool call is
      // superseded by the "tool-call" event that follows it.
      case "thinking-delta":
      case "tool-call-partial":
        break;
    }
  }

  if (stopReason === undefined) {
    throw new Error(
      "Protocol stream ended without a done event — the response was truncated.",
    );
  }

  const result: CompleteResult = {
    text: text.join(""),
    usage: usage ?? EMPTY_USAGE,
    stopReason,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return result;
}
```

Note the spread on the last field: `exactOptionalPropertyTypes` is on, so assigning `toolCalls: undefined` would be a type error. Build the object conditionally.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/protocols/collect.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/protocols/collect.ts test/protocols/collect.test.ts
git commit -m "feat: derive complete from a protocol stream"
```

---

### Task 5: The conformance suite

**Files:**
- Create: `test/support/conformance.ts`
- Test: `test/protocols/conformance-selftest.test.ts`

**Interfaces:**
- Consumes: `Protocol`, `ProtocolEvent` from `src/protocols/types.ts`
- Produces: `runProtocolConformance(name: string, makeProtocol: () => Promise<Protocol>)` — a reusable Vitest suite

This is the load-bearing test asset: it is what makes replacing a backend a bounded task. Write it **before** the first real backend, so `backend-pi.ts` is built against the contract rather than the contract being reverse-engineered from it.

The suite asserts *sequence invariants* every protocol must honour, independent of provider. It is exercised here against a scripted fake, proving the suite catches violations before any real backend depends on it.

- [ ] **Step 1: Write the conformance suite and its self-test**

```ts
// test/support/conformance.ts
/**
 * Contract every Protocol backend must satisfy.
 *
 * Run against each registered backend. A hand-written backend inherits these
 * the day it is created, which is what keeps "replace a protocol" a bounded
 * task rather than an open-ended one.
 *
 * Assertions here are sequence invariants, never provider content: model output
 * varies between runs and is not assertable.
 */

import { describe, expect, it } from "vitest";
import type { Protocol, ProtocolEvent } from "../../src/protocols/types.ts";

export interface ConformanceCase {
  readonly name: string;
  readonly request: Parameters<Protocol["stream"]>[0];
}

async function drain(protocol: Protocol, req: ConformanceCase["request"]): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const event of protocol.stream(req)) events.push(event);
  return events;
}

export function runProtocolConformance(
  suiteName: string,
  makeProtocol: () => Promise<Protocol>,
  cases: { readonly text: ConformanceCase; readonly tool?: ConformanceCase },
): void {
  describe(`${suiteName} conformance`, () => {
    it("exposes a non-empty name", async () => {
      const protocol = await makeProtocol();
      expect(protocol.name).toBeTruthy();
    });

    it("ends with exactly one done event, and it is last", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const doneIndexes = events.flatMap((e, i) => (e.type === "done" ? [i] : []));
      expect(doneIndexes).toHaveLength(1);
      expect(doneIndexes[0]).toBe(events.length - 1);
    });

    it("emits usage before done", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const usageIndex = events.findIndex((e) => e.type === "usage");
      const doneIndex = events.findIndex((e) => e.type === "done");
      expect(usageIndex).toBeGreaterThanOrEqual(0);
      expect(usageIndex).toBeLessThan(doneIndex);
    });

    it("emits at least one text delta for a text request", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(events.some((e) => e.type === "text-delta")).toBe(true);
    });

    it("reports non-negative token counts", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      if (usage?.type !== "usage") throw new Error("unreachable");
      expect(usage.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(usage.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it("emits no events after an error", async () => {
      // An error is terminal for the stream even though it is an event.
      const events = await drain(await makeProtocol(), cases.text.request);
      const errorIndex = events.findIndex((e) => e.type === "error");
      if (errorIndex >= 0) expect(errorIndex).toBe(events.length - 1);
    });

    if (cases.tool !== undefined) {
      const toolCase = cases.tool;

      it("emits parsed tool calls, never raw strings", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const calls = events.filter((e) => e.type === "tool-call");
        expect(calls.length).toBeGreaterThan(0);
        for (const event of calls) {
          if (event.type !== "tool-call") throw new Error("unreachable");
          expect(typeof event.call.input).not.toBe("string");
          expect(event.call.id).toBeTruthy();
          expect(event.call.name).toBeTruthy();
        }
      });

      it("emits any tool-call-partial before the matching tool-call", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const firstFinal = events.findIndex((e) => e.type === "tool-call");
        const lastPartial = events.map((e) => e.type).lastIndexOf("tool-call-partial");
        if (lastPartial >= 0) expect(lastPartial).toBeLessThan(firstFinal);
      });

      it("reports stopReason tool_use when tool calls were emitted", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const done = events.at(-1);
        if (done?.type !== "done") throw new Error("stream did not end with done");
        expect(done.stopReason).toBe("tool_use");
      });
    }
  });
}
```

```ts
// test/protocols/conformance-selftest.test.ts
/**
 * Proves the conformance suite actually fails on a violating protocol.
 * A suite nobody has seen fail is not yet a suite.
 */
import { describe, expect, it } from "vitest";
import type { Protocol, ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { runProtocolConformance } from "../support/conformance.ts";

const TEXT_REQUEST: ProtocolRequest = {
  model: "fake-model",
  messages: [{ role: "user", content: "hi" }],
};

const scripted = (name: string, events: ProtocolEvent[]): Protocol => ({
  name,
  async *stream() {
    for (const event of events) yield event;
  },
});

const GOOD: ProtocolEvent[] = [
  { type: "text-delta", text: "hello" },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

runProtocolConformance("compliant fake", async () => scripted("fake", GOOD), {
  text: { name: "text", request: TEXT_REQUEST },
});

describe("conformance suite self-test", () => {
  it("detects usage emitted after done", async () => {
    const bad = scripted("bad", [
      { type: "text-delta", text: "hi" },
      { type: "done", stopReason: "stop" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const events: ProtocolEvent[] = [];
    for await (const event of bad.stream(TEXT_REQUEST)) events.push(event);
    const doneIndex = events.findIndex((e) => e.type === "done");
    expect(doneIndex).not.toBe(events.length - 1);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun x vitest --run test/protocols/conformance-selftest.test.ts`
Expected: PASS — the compliant fake satisfies the suite, and the self-test confirms a violating sequence is detectable.

- [ ] **Step 3: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 4: Commit**

```bash
git add test/support/conformance.ts test/protocols/conformance-selftest.test.ts
git commit -m "test: protocol conformance suite"
```

---

### Task 6: The anthropic-messages pi backend

**Files:**
- Create: `src/protocols/anthropic-messages/backend-pi.ts`
- Create: `src/protocols/anthropic-messages/index.ts`
- Test: `test/protocols/anthropic-messages.test.ts`

**Interfaces:**
- Consumes: `Protocol`, `ProtocolRequest`, `ProtocolEvent` from `src/protocols/types.ts`; `toTokenUsage` from `src/usage.ts`; `clampThinkingLevel` from `src/protocols/thinking.ts`
- Produces: `createAnthropicMessagesPi(deps: PiDeps): Protocol`, and `ANTHROPIC_MESSAGES_BACKENDS: ProtocolBackends`

**This is the first task that touches pi-ai.** Read `src/protocols/types.ts` and the spec's §3 before starting.

Two rules for this file specifically:

1. **pi-ai types must not escape.** They may appear inside this file; nothing it exports may reference them.
2. **The pi-ai call surface must be injected**, not imported at module top level, so tests can drive the mapping with scripted events and no network. `index.ts` supplies the real one via a lazy `import()`.

pi-ai's relevant surface, verified against 0.84.4:

- `Models.stream(model, context, options)` returns an `AssistantMessageEventStream`
- Its `Usage` record is `{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost }` — `toTokenUsage` in `src/usage.ts` already maps the four fields nax-ai keeps
- `AssistantMessage` is `{ role, content: (TextContent | ThinkingContent | ToolCall)[], usage, stopReason, … }`

Because the exact event-stream shape is pi-ai's internal vocabulary, define a **narrow structural port** in this file describing only what is consumed, and adapt pi-ai to it in `index.ts`. That port is also exactly the seam a future `backend-native.ts` implements directly against HTTP.

- [ ] **Step 1: Write the failing test**

```ts
// test/protocols/anthropic-messages.test.ts
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesPi, type PiStreamEvent } from "../../src/protocols/anthropic-messages/backend-pi.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { runProtocolConformance } from "../support/conformance.ts";

const TEXT_REQUEST: ProtocolRequest = {
  model: "claude-x",
  system: "be terse",
  messages: [{ role: "user", content: "hi" }],
};

const TOOL_REQUEST: ProtocolRequest = {
  model: "claude-x",
  messages: [{ role: "user", content: "read a.ts" }],
  tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
};

/** Scripted pi-ai-shaped events; no network. */
function fakePi(events: PiStreamEvent[], capture?: { request?: unknown }) {
  return {
    async *stream(request: unknown): AsyncIterable<PiStreamEvent> {
      if (capture) capture.request = request;
      for (const event of events) yield event;
    },
  };
}

const TEXT_EVENTS: PiStreamEvent[] = [
  { type: "text", text: "he" },
  { type: "text", text: "llo" },
  { type: "usage", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } },
  { type: "done", stopReason: "stop" },
];

const TOOL_EVENTS: PiStreamEvent[] = [
  { type: "tool-partial", id: "t1", name: "read", argsFragment: '{"path"' },
  { type: "tool-partial", id: "t1", name: "read", argsFragment: ':"a.ts"}' },
  { type: "tool-end", id: "t1", name: "read" },
  { type: "usage", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
  { type: "done", stopReason: "tool_use" },
];

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("anthropic-messages pi backend", () => {
  it("maps text events to text deltas", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) });
    const events = await collect(protocol.stream(TEXT_REQUEST));
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
    ]);
  });

  it("maps pi usage onto TokenUsage, keeping cache fields separate", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) });
    const events = await collect(protocol.stream(TEXT_REQUEST));
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
  });

  it("accumulates streamed tool arguments and emits one parsed tool call", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toEqual([
      { type: "tool-call", call: { id: "t1", name: "read", input: { path: "a.ts" } } },
    ]);
  });

  it("emits partials before the parsed call", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const lastPartial = events.map((e) => e.type).lastIndexOf("tool-call-partial");
    const firstFinal = events.findIndex((e) => e.type === "tool-call");
    expect(lastPartial).toBeLessThan(firstFinal);
  });

  it("emits an error event when tool arguments do not parse", async () => {
    // Malformed JSON from a provider must not throw out of the iterator: text
    // and usage already delivered would be lost.
    const protocol = createAnthropicMessagesPi({
      client: fakePi([
        { type: "tool-partial", id: "t1", name: "read", argsFragment: "{not json" },
        { type: "tool-end", id: "t1", name: "read" },
        { type: "done", stopReason: "tool_use" },
      ]),
    });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.error.kind).toBe("bad-request");
  });

  it("passes system prompt as a top-level field, not as a message", async () => {
    const capture: { request?: unknown } = {};
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS, capture) });
    await collect(protocol.stream(TEXT_REQUEST));
    const request = capture.request as { system?: string; messages: unknown[] };
    expect(request.system).toBe("be terse");
    expect(request.messages).toHaveLength(1);
  });
});

runProtocolConformance(
  "anthropic-messages (pi)",
  async () => createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) }),
  { text: { name: "text", request: TEXT_REQUEST } },
);

runProtocolConformance(
  "anthropic-messages (pi, tools)",
  async () => createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) }),
  {
    text: { name: "text", request: TOOL_REQUEST },
    tool: { name: "tool", request: TOOL_REQUEST },
  },
);
```

Note: the second conformance run passes `TOOL_EVENTS` for both cases, so the "at least one text delta" assertion would fail. Add a single text event to the front of `TOOL_EVENTS` so it satisfies both:

```ts
const TOOL_EVENTS: PiStreamEvent[] = [
  { type: "text", text: "reading" },
  { type: "tool-partial", id: "t1", name: "read", argsFragment: '{"path"' },
  // …rest unchanged
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/protocols/anthropic-messages.test.ts`
Expected: FAIL — cannot resolve the backend module

- [ ] **Step 3: Write the implementation**

```ts
// src/protocols/anthropic-messages/backend-pi.ts
/**
 * Anthropic Messages, backed by pi-ai.
 *
 * The pi-ai client is INJECTED rather than imported here, for two reasons:
 * the mapping can then be tested with scripted events and no network, and the
 * narrow `PiClientPort` below is exactly the seam a future hand-written
 * backend implements directly against HTTP.
 *
 * pi-ai types must not escape this file. Nothing exported here may reference
 * them; `scripts/check-pi-ai-imports.ts` enforces where the import may appear.
 */

import { toTokenUsage } from "../../usage.ts";
import type { Protocol, ProtocolEvent, ProtocolRequest, ToolCall } from "../types.ts";

/** Structural description of the pi-ai events this backend consumes. */
export type PiStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-partial"; id: string; name: string; argsFragment: string }
  | { type: "tool-end"; id: string; name: string }
  | { type: "usage"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { type: "done"; stopReason: "stop" | "length" | "tool_use" | "content_filter" }
  | { type: "error"; message: string; status?: number; retryAfter?: number };

export interface PiClientPort {
  stream(request: unknown): AsyncIterable<PiStreamEvent>;
}

export interface PiDeps {
  readonly client: PiClientPort;
}

export function createAnthropicMessagesPi(deps: PiDeps): Protocol {
  return {
    name: "anthropic-messages",

    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      // `system` is a top-level parameter on this wire format, not a message.
      const wireRequest = {
        model: req.model,
        ...(req.system !== undefined ? { system: req.system } : {}),
        messages: req.messages,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      };

      /** id -> accumulated argument fragments. */
      const pending = new Map<string, { name: string; raw: string }>();

      for await (const event of deps.client.stream(wireRequest)) {
        switch (event.type) {
          case "text":
            yield { type: "text-delta", text: event.text };
            break;

          case "thinking":
            yield { type: "thinking-delta", text: event.text };
            break;

          case "tool-partial": {
            const current = pending.get(event.id) ?? { name: event.name, raw: "" };
            current.raw += event.argsFragment;
            pending.set(event.id, current);
            yield {
              type: "tool-call-partial",
              id: event.id,
              name: event.name,
              rawInput: current.raw,
            };
            break;
          }

          case "tool-end": {
            const current = pending.get(event.id);
            pending.delete(event.id);
            const raw = current?.raw ?? "";
            let input: unknown;
            try {
              input = raw === "" ? {} : JSON.parse(raw);
            } catch (cause) {
              // Malformed arguments end the stream as an error EVENT, not a
              // throw: text and usage already yielded must survive.
              yield {
                type: "error",
                error: {
                  kind: "bad-request",
                  message: `Tool "${event.name}" returned unparseable arguments.`,
                  cause,
                },
              };
              return;
            }
            const call: ToolCall = { id: event.id, name: event.name, input };
            yield { type: "tool-call", call };
            break;
          }

          case "usage":
            yield { type: "usage", usage: toTokenUsage(event.usage) };
            break;

          case "error":
            yield {
              type: "error",
              error: {
                kind: classify(event.status),
                message: event.message,
                ...(event.status !== undefined ? { status: event.status } : {}),
                ...(event.retryAfter !== undefined ? { retryAfter: event.retryAfter } : {}),
              },
            };
            return;

          case "done":
            yield { type: "done", stopReason: event.stopReason };
            return;
        }
      }
    },
  };
}

function classify(status: number | undefined): "rate-limit" | "auth" | "overloaded" | "bad-request" | "transport" | "unknown" {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  if (status >= 500) return "transport";
  return "unknown";
}
```

```ts
// src/protocols/anthropic-messages/index.ts
/**
 * Backend registration for the Anthropic Messages protocol.
 *
 * The pi-ai import is lazy so the SDK is not loaded until this protocol is
 * actually used — the property that keeps nax-ai's import cost at tens of
 * milliseconds despite an 85 MB dependency tree.
 */

import type { ProtocolBackends } from "../registry.ts";

export const ANTHROPIC_MESSAGES_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createAnthropicMessagesPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createAnthropicMessagesPi({ client: await createPiClient("anthropic-messages") });
  },
};
```

Create `src/protocols/pi-client.ts` as the single place pi-ai's stream API is adapted to `PiClientPort`. Implementing that adapter requires reading pi-ai's `AssistantMessageEventStream` shape; keep it in one file so the mapping from pi-ai's event vocabulary to `PiStreamEvent` is reviewable in isolation:

```ts
// src/protocols/pi-client.ts
/**
 * The single adapter from pi-ai's event stream to `PiStreamEvent`.
 *
 * This is the only place outside a backend file that imports pi-ai. It exists
 * so every protocol backend consumes one narrow, testable shape rather than
 * pi-ai's full vocabulary.
 *
 * NOTE FOR THE IMPLEMENTER: pi-ai's `Models.stream()` returns an
 * `AssistantMessageEventStream`. Read `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts`
 * and `dist/types.d.ts` for the event union before writing this mapping, and
 * add a test per event kind you map.
 */

import type { PiClientPort } from "./anthropic-messages/backend-pi.ts";

export async function createPiClient(_protocolName: string): Promise<PiClientPort> {
  throw new Error(
    "createPiClient is not implemented yet — see Task 6 notes. Backends are testable via injection in the meantime.",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/protocols/anthropic-messages.test.ts`
Expected: PASS — 6 unit tests plus both conformance runs

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/protocols/anthropic-messages src/protocols/pi-client.ts test/protocols/anthropic-messages.test.ts
git commit -m "feat: anthropic-messages protocol backed by pi-ai"
```

---

### Task 7: Provider types and catalog normalisation

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/catalog.ts`
- Test: `test/providers/catalog.test.ts`

**Interfaces:**
- Consumes: `assertOAuthFlowPermitted` from `src/auth/oauth-policy.ts`; `ThinkingLevel` from `src/protocols/types.ts`
- Produces: `ResolvedProvider`, `ResolvedModel`, `Pricing`, `ProviderAuth`, `ProviderOverride`, `normaliseCatalog(raw, overrides?)`

The OAuth gate is currently **tested but not wired** — six passing tests and no production caller. This task puts it on the real path: a provider declaring an OAuth flow that is not permitted must fail to resolve, not merely fail a unit test that a later refactor could delete.

Protocol is per-model with a provider-level default, because `opencode-go` serves models over three different protocols.

- [ ] **Step 1: Write the failing test**

```ts
// test/providers/catalog.test.ts
import { describe, expect, it } from "vitest";
import { normaliseCatalog, type RawProvider } from "../../src/providers/catalog.ts";
import { OAuthFlowProhibitedError } from "../../src/auth/oauth-policy.ts";

const DEEPSEEK: RawProvider = {
  id: "deepseek",
  baseUrl: "https://api.deepseek.com",
  auth: { kind: "api-key", env: "DEEPSEEK_API_KEY" },
  defaultProtocol: "openai-completions",
  models: [
    {
      id: "deepseek-chat",
      pricing: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
      contextWindow: 64000,
      supportsTools: true,
      thinkingLevels: [],
    },
  ],
};

const RAW: readonly RawProvider[] = [
  DEEPSEEK,
  {
    id: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    auth: { kind: "api-key", env: "OPENCODE_API_KEY" },
    defaultProtocol: "openai-completions",
    models: [
      { id: "a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, supportsTools: false, thinkingLevels: [] },
      { id: "b", protocol: "anthropic-messages", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, supportsTools: false, thinkingLevels: [] },
    ],
  },
];

describe("normaliseCatalog", () => {
  it("gives every model the provider default protocol", () => {
    const catalog = normaliseCatalog(RAW);
    expect(catalog.model("deepseek", "deepseek-chat")?.protocol).toBe("openai-completions");
  });

  it("lets a model override the provider protocol", () => {
    // opencode-go really does serve models over three protocols.
    const catalog = normaliseCatalog(RAW);
    expect(catalog.model("opencode-go", "a")?.protocol).toBe("openai-completions");
    expect(catalog.model("opencode-go", "b")?.protocol).toBe("anthropic-messages");
  });

  it("returns undefined for an unknown model", () => {
    expect(normaliseCatalog(RAW).model("deepseek", "nope")).toBeUndefined();
  });

  it("lists models, optionally filtered by provider", () => {
    const catalog = normaliseCatalog(RAW);
    expect(catalog.listModels()).toHaveLength(3);
    expect(catalog.listModels("opencode-go")).toHaveLength(2);
  });

  it("rejects a provider declaring the prohibited anthropic OAuth flow", () => {
    // The gate on the real path, not just in a unit test of the policy module.
    const withProhibited: RawProvider[] = [
      { ...DEEPSEEK, id: "sneaky", auth: { kind: "oauth", flow: "anthropic" } },
    ];
    expect(() => normaliseCatalog(withProhibited)).toThrow(OAuthFlowProhibitedError);
  });

  it("accepts a provider declaring a permitted OAuth flow", () => {
    const withCodex: RawProvider[] = [
      { ...DEEPSEEK, id: "openai-codex", auth: { kind: "oauth", flow: "openai-codex" } },
    ];
    expect(() => normaliseCatalog(withCodex)).not.toThrow();
  });

  it("applies a baseUrl override", () => {
    const catalog = normaliseCatalog(RAW, [{ provider: "deepseek", baseUrl: "https://proxy.local" }]);
    expect(catalog.provider("deepseek")?.baseUrl).toBe("https://proxy.local");
  });

  it("adds models supplied by an override", () => {
    const catalog = normaliseCatalog(RAW, [
      {
        provider: "deepseek",
        models: [
          {
            id: "deepseek-new",
            provider: "deepseek",
            protocol: "openai-completions",
            pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            supportsTools: true,
            thinkingLevels: [],
          },
        ],
      },
    ]);
    expect(catalog.model("deepseek", "deepseek-new")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/providers/catalog.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/catalog.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/providers/types.ts
/**
 * Provider and model vocabulary.
 *
 * These are nax-ai's own types, deliberately not pi-ai's. A future hand-written
 * protocol backend needs baseUrl, auth and headers, and must be able to obtain
 * them without importing pi-ai — which is only true if the catalog is
 * normalised into this shape at the boundary.
 */

import type { ThinkingLevel } from "../protocols/types.ts";

/** Rates per 1M tokens. nax-ai supplies rates; the consumer computes cost. */
export interface Pricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type ProviderAuth =
  | { readonly kind: "api-key"; readonly env: string }
  | { readonly kind: "oauth"; readonly flow: string };

export interface ResolvedProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultProtocol: string;
}

export interface ResolvedModel {
  readonly id: string;
  readonly provider: string;
  /** May differ from the provider default: one provider can span several. */
  readonly protocol: string;
  readonly pricing: Pricing;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  /** Empty means the model has no thinking support. */
  readonly thinkingLevels: readonly ThinkingLevel[];
}

/**
 * Declaration-data overrides only.
 *
 * Behaviour changes are a wrapping protocol backend, not an override. Keeping
 * that line sharp stops this growing into a second, weaker extension mechanism
 * competing with the registry.
 */
export interface ProviderOverride {
  readonly provider: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly ResolvedModel[];
}
```

```ts
// src/providers/catalog.ts
/**
 * Normalises a raw provider catalog into nax-ai types.
 *
 * STAYS pi-ai-BACKED. Hand-rolling the model catalog is explicitly out of
 * scope: its pricing and model data are maintained upstream, and taking that
 * maintenance back is the burden the dependency was chosen to avoid. Unlike
 * `protocols/`, this layer is not a migration surface.
 *
 * This is also where the OAuth allowlist meets a real code path: a provider
 * declaring a prohibited flow fails to resolve here.
 */

import { assertOAuthFlowPermitted } from "../auth/oauth-policy.ts";
import type { ProviderOverride, ResolvedModel, ResolvedProvider } from "./types.ts";
import type { Pricing, ProviderAuth } from "./types.ts";
import type { ThinkingLevel } from "../protocols/types.ts";

export interface RawModel {
  readonly id: string;
  /** Falls back to the provider's `defaultProtocol` when absent. */
  readonly protocol?: string;
  readonly pricing: Pricing;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export interface RawProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultProtocol: string;
  readonly models: readonly RawModel[];
}

export interface Catalog {
  provider(id: string): ResolvedProvider | undefined;
  model(provider: string, model: string): ResolvedModel | undefined;
  listModels(provider?: string): readonly ResolvedModel[];
}

export function normaliseCatalog(
  raw: readonly RawProvider[],
  overrides: readonly ProviderOverride[] = [],
): Catalog {
  const overrideFor = new Map(overrides.map((o) => [o.provider, o]));
  const providers = new Map<string, ResolvedProvider>();
  const models = new Map<string, ResolvedModel>();

  const key = (provider: string, model: string): string => `${provider} ${model}`;

  for (const rawProvider of raw) {
    // The gate, on the real path. A prohibited flow must stop resolution here,
    // not merely fail a unit test of the policy module.
    if (rawProvider.auth.kind === "oauth") {
      assertOAuthFlowPermitted(rawProvider.auth.flow);
    }

    const override = overrideFor.get(rawProvider.id);
    const headers = override?.headers ?? rawProvider.headers;

    providers.set(rawProvider.id, {
      id: rawProvider.id,
      baseUrl: override?.baseUrl ?? rawProvider.baseUrl,
      auth: rawProvider.auth,
      ...(headers !== undefined ? { headers } : {}),
      defaultProtocol: rawProvider.defaultProtocol,
    });

    for (const rawModel of rawProvider.models) {
      models.set(key(rawProvider.id, rawModel.id), {
        id: rawModel.id,
        provider: rawProvider.id,
        protocol: rawModel.protocol ?? rawProvider.defaultProtocol,
        pricing: rawModel.pricing,
        contextWindow: rawModel.contextWindow,
        supportsTools: rawModel.supportsTools,
        thinkingLevels: rawModel.thinkingLevels,
      });
    }
  }

  // Override-supplied models are applied last so they can replace an entry.
  for (const override of overrides) {
    for (const model of override.models ?? []) {
      models.set(key(override.provider, model.id), model);
    }
  }

  return {
    provider: (id) => providers.get(id),
    model: (provider, model) => models.get(key(provider, model)),
    listModels: (provider) =>
      [...models.values()].filter((m) => provider === undefined || m.provider === provider),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/providers/catalog.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Typecheck and lint**

Run: `bun x tsc --noEmit && bun run lint`
Expected: both exit 0

- [ ] **Step 6: Commit**

```bash
git add src/providers test/providers
git commit -m "feat: provider catalog normalisation, with the OAuth gate on the real path"
```

---

### Task 8: The client

**Files:**
- Create: `src/client.ts`
- Modify: `src/index.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `createRegistry`, `ProtocolEntries`, `BackendSelection` from `src/protocols/registry.ts`; `collectStream` from `src/protocols/collect.ts`; `normaliseCatalog`, `Catalog`, `RawProvider` from `src/providers/catalog.ts`; `clampThinkingLevel` from `src/protocols/thinking.ts`
- Produces: `createClient(options)`, `Client`, `ClientOptions`

The client is the only thing a consumer constructs. It selects the protocol from `ResolvedModel.protocol` so a consumer never names one — which is what keeps protocol-level migration invisible.

- [ ] **Step 1: Write the failing test**

```ts
// test/client.test.ts
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.ts";
import type { RawProvider } from "../src/providers/catalog.ts";
import type { Protocol, ProtocolEvent } from "../src/protocols/types.ts";

const PROVIDERS: readonly RawProvider[] = [
  {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    auth: { kind: "api-key", env: "DEEPSEEK_API_KEY" },
    defaultProtocol: "openai-completions",
    models: [
      {
        id: "deepseek-chat",
        pricing: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
        contextWindow: 64000,
        supportsTools: true,
        thinkingLevels: ["off", "medium"],
      },
    ],
  },
];

const scripted = (events: ProtocolEvent[]): Protocol => ({
  name: "openai-completions",
  async *stream() {
    for (const event of events) yield event;
  },
});

const OK: ProtocolEvent[] = [
  { type: "text-delta", text: "hi" },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

const makeClient = (events = OK) =>
  createClient({
    providers: PROVIDERS,
    protocols: { "openai-completions": { pi: async () => scripted(events) } },
  });

describe("client", () => {
  it("resolves a model from the catalog", async () => {
    const model = await makeClient().model("deepseek", "deepseek-chat");
    expect(model.protocol).toBe("openai-completions");
  });

  it("throws for an unknown model", async () => {
    await expect(makeClient().model("deepseek", "nope")).rejects.toThrow(/unknown model/i);
  });

  it("exposes pricing rates without computing cost", () => {
    const client = makeClient();
    const rates = client.pricing({
      id: "x", provider: "deepseek", protocol: "openai-completions",
      pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1, supportsTools: false, thinkingLevels: [],
    });
    expect(rates).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("completes by collecting the stream", async () => {
    const client = makeClient();
    const model = await client.model("deepseek", "deepseek-chat");
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hi");
    expect(result.usage.inputTokens).toBe(3);
  });

  it("clamps a thinking level the model does not support", async () => {
    let seen: unknown;
    const client = createClient({
      providers: PROVIDERS,
      protocols: {
        "openai-completions": {
          pi: async () => ({
            name: "openai-completions",
            async *stream(req) {
              seen = req.thinking;
              for (const event of OK) yield event;
            },
          }),
        },
      },
    });
    const model = await client.model("deepseek", "deepseek-chat");
    await client.complete(model, { messages: [{ role: "user", content: "hi" }], thinking: "max" });
    expect(seen).toBe("medium"); // nearest supported
  });

  it("validate() rejects a selection naming an unregistered backend", () => {
    const client = createClient({
      providers: PROVIDERS,
      protocols: { "openai-completions": { pi: async () => scripted(OK) } },
      backends: { byProtocol: { "openai-completions": "native" } },
    });
    expect(() => client.validate()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest --run test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.ts`

- [ ] **Step 3: Write the implementation**

```ts
// src/client.ts
/**
 * The client: the only thing a consumer constructs.
 *
 * It selects a protocol from `ResolvedModel.protocol`, so a consumer never
 * names one. That indirection is what makes replacing a protocol's backend
 * invisible to callers.
 */

import { collectStream } from "./protocols/collect.ts";
import { createRegistry, type BackendSelection, type ProtocolEntries } from "./protocols/registry.ts";
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

  async function* streamFrom(
    model: ResolvedModel,
    req: ClientRequest,
  ): AsyncIterable<ProtocolEvent> {
    const protocol = await registry.resolve(model.protocol);
    const thinking =
      req.thinking !== undefined
        ? clampThinkingLevel(req.thinking, model.thinkingLevels)
        : undefined;

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
```

Then extend `src/index.ts` with the new public surface:

```ts
export { createClient, type Client, type ClientOptions, type ClientRequest } from "./client.ts";
export {
  createRegistry,
  UnknownProtocolError,
  UnregisteredBackendError,
  type BackendId,
  type BackendSelection,
  type ProtocolBackends,
  type ProtocolEntries,
} from "./protocols/registry.ts";
export { clampThinkingLevel } from "./protocols/thinking.ts";
export type {
  CacheRetention,
  ConversationMessage,
  JsonSchema,
  Protocol,
  ProtocolError,
  ProtocolEvent,
  ProtocolRequest,
  ThinkingLevel,
  ToolCall,
  ToolDefinition,
} from "./protocols/types.ts";
export { ProtocolStreamError, collectStream } from "./protocols/collect.ts";
export { normaliseCatalog, type Catalog, type RawModel, type RawProvider } from "./providers/catalog.ts";
export type {
  Pricing,
  ProviderAuth,
  ProviderOverride,
  ResolvedModel,
  ResolvedProvider,
} from "./providers/types.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun x vitest --run test/client.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Run the whole suite, typecheck, lint, build**

Run: `bun x vitest --run && bun x tsc --noEmit && bun run lint && bun run build`
Expected: all four exit 0

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "feat: client tying the registry to the catalog"
```

---

### Task 9: The pi-ai import gate

**Files:**
- Create: `scripts/check-pi-ai-imports.ts`
- Modify: `package.json` (add to the `lint` script)
- Test: manual — the gate is verified by planting a violation

**Interfaces:**
- Consumes: nothing
- Produces: a build gate

The whole architecture rests on pi-ai types not escaping. That is currently a convention, and conventions rot. This gate makes it a build failure.

Allowed importers: `src/protocols/*/backend-pi.ts` and `src/protocols/pi-client.ts`. Nothing else in `src/`.

- [ ] **Step 1: Write the gate**

```ts
// scripts/check-pi-ai-imports.ts
/**
 * Gate: pi-ai may only be imported where a backend adapts it.
 *
 * The package's value is that pi-ai can be replaced protocol by protocol. That
 * is only true while its types stay behind the adapter boundary — one import
 * in a shared module and the migration turns from a swap into a rewrite.
 *
 * Allowed: src/protocols/pi-client.ts and any src/protocols/<name>/backend-pi.ts.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(ROOT, "src");

const PI_IMPORT = /from\s+["']@earendil-works\/pi-ai|import\s*\(\s*["']@earendil-works\/pi-ai/;
const ALLOWED = [/^src\/protocols\/pi-client\.ts$/, /^src\/protocols\/[^/]+\/backend-pi\.ts$/];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

const violations: { file: string; line: number; text: string }[] = [];

for await (const file of walk(SCAN_DIR)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.some((pattern) => pattern.test(rel))) continue;

  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (PI_IMPORT.test(text)) violations.push({ file: rel, line: index + 1, text: stripped });
  });
}

if (violations.length > 0) {
  console.error(`pi-ai imported outside an adapter (${violations.length}):\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    "\npi-ai may only be imported in src/protocols/pi-client.ts or a backend-pi.ts.",
  );
  process.exit(1);
}

console.log("check-pi-ai-imports: clean");
```

- [ ] **Step 2: Wire it into lint**

In `package.json`, add the script and extend `lint`:

```json
"check:pi-ai-imports": "bun run scripts/check-pi-ai-imports.ts",
"lint": "bun x biome check --error-on-warnings src/ test/ scripts/ && bun run check:no-bun-apis && bun run check:pi-ai-imports",
```

- [ ] **Step 3: Prove the gate fails on a violation**

A gate nobody has seen fail is not yet a gate.

```bash
printf 'import { Type } from "@earendil-works/pi-ai";\nexport const x = Type;\n' > src/__gatecheck.ts
bun run scripts/check-pi-ai-imports.ts; echo "exit=$?"   # expect: violation listed, exit=1
rm src/__gatecheck.ts
bun run scripts/check-pi-ai-imports.ts; echo "exit=$?"   # expect: clean, exit=0
```

- [ ] **Step 4: Run the full gate chain**

Run: `bun run lint && bun x tsc --noEmit && bun x vitest --run`
Expected: all exit 0

- [ ] **Step 5: Commit**

```bash
git add scripts/check-pi-ai-imports.ts package.json
git commit -m "chore: gate pi-ai imports to adapter files"
```

---

### Task 10: Remaining protocol backends

**Files:**
- Create: `src/protocols/openai-completions/{backend-pi.ts,index.ts}`
- Create: `src/protocols/openai-responses/{backend-pi.ts,index.ts}`
- Create: `src/protocols/openai-codex-responses/{backend-pi.ts,index.ts}`
- Test: `test/protocols/openai-completions.test.ts`, `test/protocols/openai-responses.test.ts`, `test/protocols/openai-codex-responses.test.ts`

**Interfaces:**
- Consumes: the same as Task 6
- Produces: `createOpenAiCompletionsPi`, `createOpenAiResponsesPi`, `createOpenAiCodexResponsesPi`, and their `*_BACKENDS` constants

Each follows Task 6's structure exactly: an injected `PiClientPort`, scripted-event tests, and both conformance runs. Do not import Task 6's code — these are separate wire formats that happen to share a shape today, and coupling them now would make replacing one of them require touching the others.

The differences that matter per protocol:

| Protocol | System prompt | Tool arguments | Notes |
|---|---|---|---|
| `openai-completions` | `system` message prepended to `messages` | `function.arguments` string deltas | Serves openrouter, deepseek, groq |
| `openai-responses` | `instructions` field | same accumulation | Serves openai; largest surface |
| `openai-codex-responses` | `instructions` field | same accumulation | Codex OAuth only; distinct from `openai-responses` |

- [ ] **Step 1: Write `openai-completions` — test first**

Copy the structure of `test/protocols/anthropic-messages.test.ts`, changing the system-prompt assertion, since this wire format carries the system prompt as a message rather than a top-level field:

```ts
  it("prepends the system prompt as a message, not a top-level field", async () => {
    const capture: { request?: unknown } = {};
    const protocol = createOpenAiCompletionsPi({ client: fakePi(TEXT_EVENTS, capture) });
    await collect(protocol.stream(TEXT_REQUEST));
    const request = capture.request as { system?: string; messages: { role: string }[] };
    expect(request.system).toBeUndefined();
    expect(request.messages[0]).toMatchObject({ role: "system", content: "be terse" });
  });
```

- [ ] **Step 2: Run to verify it fails, then implement**

Write the file in full. Do **not** import Task 6's implementation: these are separate wire formats that merely resemble each other today, and sharing code now would make replacing one of them require touching the others.

```ts
// src/protocols/openai-completions/backend-pi.ts
/**
 * OpenAI Completions, backed by pi-ai. Serves openrouter, deepseek and groq.
 *
 * Deliberately duplicates the shape of the anthropic-messages backend rather
 * than sharing it: the two are independent wire formats, and this file must be
 * replaceable on its own by a hand-written implementation.
 *
 * pi-ai types must not escape this file.
 */

import { toTokenUsage } from "../../usage.ts";
import type { Protocol, ProtocolEvent, ProtocolRequest, ToolCall } from "../types.ts";

export type PiStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-partial"; id: string; name: string; argsFragment: string }
  | { type: "tool-end"; id: string; name: string }
  | { type: "usage"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { type: "done"; stopReason: "stop" | "length" | "tool_use" | "content_filter" }
  | { type: "error"; message: string; status?: number; retryAfter?: number };

export interface PiClientPort {
  stream(request: unknown): AsyncIterable<PiStreamEvent>;
}

export interface PiDeps {
  readonly client: PiClientPort;
}

export function createOpenAiCompletionsPi(deps: PiDeps): Protocol {
  return {
    name: "openai-completions",

    async *stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent> {
      // This wire format carries the system prompt as the first message,
      // unlike anthropic-messages which takes a top-level field.
      const messages =
        req.system !== undefined
          ? [{ role: "system" as const, content: req.system }, ...req.messages]
          : req.messages;

      const wireRequest = {
        model: req.model,
        messages,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      };

      const pending = new Map<string, { name: string; raw: string }>();

      for await (const event of deps.client.stream(wireRequest)) {
        switch (event.type) {
          case "text":
            yield { type: "text-delta", text: event.text };
            break;

          case "thinking":
            yield { type: "thinking-delta", text: event.text };
            break;

          case "tool-partial": {
            const current = pending.get(event.id) ?? { name: event.name, raw: "" };
            current.raw += event.argsFragment;
            pending.set(event.id, current);
            yield {
              type: "tool-call-partial",
              id: event.id,
              name: event.name,
              rawInput: current.raw,
            };
            break;
          }

          case "tool-end": {
            const current = pending.get(event.id);
            pending.delete(event.id);
            const raw = current?.raw ?? "";
            let input: unknown;
            try {
              input = raw === "" ? {} : JSON.parse(raw);
            } catch (cause) {
              yield {
                type: "error",
                error: {
                  kind: "bad-request",
                  message: `Tool "${event.name}" returned unparseable arguments.`,
                  cause,
                },
              };
              return;
            }
            const call: ToolCall = { id: event.id, name: event.name, input };
            yield { type: "tool-call", call };
            break;
          }

          case "usage":
            yield { type: "usage", usage: toTokenUsage(event.usage) };
            break;

          case "error":
            yield {
              type: "error",
              error: {
                kind: classify(event.status),
                message: event.message,
                ...(event.status !== undefined ? { status: event.status } : {}),
                ...(event.retryAfter !== undefined ? { retryAfter: event.retryAfter } : {}),
              },
            };
            return;

          case "done":
            yield { type: "done", stopReason: event.stopReason };
            return;
        }
      }
    },
  };
}

function classify(status: number | undefined): "rate-limit" | "auth" | "overloaded" | "bad-request" | "transport" | "unknown" {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad-request";
  if (status >= 500) return "transport";
  return "unknown";
}
```

```ts
// src/protocols/openai-completions/index.ts
import type { ProtocolBackends } from "../registry.ts";

export const OPENAI_COMPLETIONS_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createOpenAiCompletionsPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createOpenAiCompletionsPi({ client: await createPiClient("openai-completions") });
  },
};
```

- [ ] **Step 3: Run tests, typecheck, lint, commit**

```bash
bun x vitest --run test/protocols/openai-completions.test.ts
bun x tsc --noEmit && bun run lint
git add src/protocols/openai-completions test/protocols/openai-completions.test.ts
git commit -m "feat: openai-completions protocol backed by pi-ai"
```

- [ ] **Step 4: Write `openai-responses`**

Create `src/protocols/openai-responses/backend-pi.ts` as a **complete copy** of the `openai-completions` file above, with exactly three changes — everything else, including `classify`, the tool accumulator and the `return` after `done`, is written out again verbatim:

1. Exported factory renamed to `createOpenAiResponsesPi`.
2. `name: "openai-responses"`.
3. The request builder uses an `instructions` field instead of a system message:

```ts
      // This wire format takes the system prompt as `instructions`, not as a
      // message in the array.
      const wireRequest = {
        model: req.model,
        ...(req.system !== undefined ? { instructions: req.system } : {}),
        messages: req.messages,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      };
```

And `index.ts` mirroring the one above with `OPENAI_RESPONSES_BACKENDS` / `createOpenAiResponsesPi` / `"openai-responses"`.

Its test file is the `openai-completions` test with the system-prompt assertion changed:

```ts
  it("passes the system prompt as instructions, not as a message", async () => {
    const capture: { request?: unknown } = {};
    const protocol = createOpenAiResponsesPi({ client: fakePi(TEXT_EVENTS, capture) });
    await collect(protocol.stream(TEXT_REQUEST));
    const request = capture.request as { instructions?: string; messages: unknown[] };
    expect(request.instructions).toBe("be terse");
    expect(request.messages).toHaveLength(1);
  });
```

Run, typecheck, lint, then commit: `feat: openai-responses protocol backed by pi-ai`

- [ ] **Step 5: Write `openai-codex-responses`**

Create `src/protocols/openai-codex-responses/backend-pi.ts` as a complete copy of the `openai-responses` file from Step 4, with two changes: the factory is `createOpenAiCodexResponsesPi` and `name: "openai-codex-responses"`. Its `index.ts` exports `OPENAI_CODEX_RESPONSES_BACKENDS`. Its test file is Step 4's with the factory name changed.

This protocol exists separately because Codex uses a distinct wire format, not merely a different auth method. **Do not alias it to `openai-responses`** — they will diverge, and an alias would make that divergence a breaking refactor rather than an edit to one file.

Run, typecheck, lint, then commit: `feat: openai-codex-responses protocol backed by pi-ai`

- [ ] **Step 6: Run the whole suite**

Run: `bun x vitest --run && bun x tsc --noEmit && bun run lint && bun run build`
Expected: all exit 0

---

### Task 11: CI for the new test layout

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: nothing — infrastructure

The existing workflow already runs `static`, `test-node` (22 and 24), `smoke-bun` and `pack`. The only change needed is that the smoke job should exercise the client, not just the OAuth constants, so the built artifact is proven to work rather than merely to load.

- [ ] **Step 1: Extend the smoke step**

Replace the `import built package` step's script in `smoke-bun` with one that constructs a client and completes against a scripted protocol:

```js
import { createClient, PERMITTED_OAUTH_FLOWS } from "./dist/index.js";

if (PERMITTED_OAUTH_FLOWS.includes("anthropic")) {
  throw new Error("anthropic must never be a permitted OAuth flow");
}

const client = createClient({
  providers: [{
    id: "fake", baseUrl: "https://example.invalid",
    auth: { kind: "api-key", env: "NONE" },
    defaultProtocol: "p",
    models: [{ id: "m", pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
               contextWindow: 1, supportsTools: false, thinkingLevels: [] }],
  }],
  protocols: { p: { pi: async () => ({
    name: "p",
    async *stream() {
      yield { type: "text-delta", text: "ok" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "done", stopReason: "stop" };
    },
  }) } },
});

const model = await client.model("fake", "m");
const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });
if (result.text !== "ok") throw new Error(`unexpected result: ${result.text}`);
console.log("smoke ok");
```

- [ ] **Step 2: Verify locally under both runtimes**

```bash
bun run build
bun --eval '<the script above>'
node --input-type=module -e '<the script above>'
```

Expected: `smoke ok` from both.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: smoke-test the client, not only module loading"
```

---

## Deferred to a later plan

These are in the spec but deliberately out of this plan's scope. Each needs its own plan.

| Item | Spec section | Why deferred |
|---|---|---|
| Real `createPiClient` implementation | §5 | Requires reading pi-ai's `AssistantMessageEventStream` in depth; Task 6 leaves a documented stub and every backend is testable by injection without it. |
| Transport retry (`transportRetries`) | §10.1 | Needs the real pi-client to have a transport layer to retry. The option is accepted and currently unused. |
| Recorded-fixture tests from live captures | §9 | Needs the real pi-client to capture from. |
| Scheduled live-provider canary | §10.3 | Needs repository secrets and a spend cap — an infrastructure decision, not code. |
| `CredentialStore` wiring | §5 | Accepted by `ClientOptions` and currently unused; belongs with the real pi-client. |
| `toolChoice` wire mapping per protocol | §3 | Accepted by `ProtocolRequest` but no backend maps it to its wire format yet (`toolChoice: "none"` would silently not prevent tool calls). Wire mapping needs the real pi-client's request shape (M2) to verify against. |
| `cacheRetention` wire mapping per protocol | §3 | Accepted by `ProtocolRequest` but no backend maps it to its wire format yet (Anthropic `cache_control` is never set). Wire mapping needs the real pi-client's request shape (M2) to verify against. |

## Definition of done

- [ ] `bun x vitest --run` — all tests pass
- [ ] `bun x tsc --noEmit` — exit 0
- [ ] `bun run lint` — biome, the Bun-API gate, and the pi-ai import gate all pass
- [ ] `bun run build` — emits `.d.ts` and `.d.ts.map` for every module
- [ ] `node --input-type=module -e 'import("./dist/index.js")'` — the built package loads under Node
- [ ] Every protocol backend passes the conformance suite
- [ ] A planted pi-ai import outside an adapter fails `bun run lint`
