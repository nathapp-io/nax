# OpenRouter routing and response identity (issue #43) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consumer can learn which response a provider actually served (P1), and can pin an OpenRouter-compatible model to specific upstream endpoints and quantizations as declaration data (P2), without a proxy sidecar and without a per-request escape hatch.

**Architecture:** One documentation task and three independent code halves. (Docs) The `ProviderOverride` mechanism P2 extends has no consumer documentation at all, so Task 0 writes it before anything is added to it. (P1) The `done` protocol event and `CompleteResult` gain optional `responseId` / `responseModel`, read off the pi `AssistantMessage` the `done` case already holds and discards — provider-agnostic, no OpenRouter knowledge anywhere. (P2) `ResolvedModel` gains an optional, narrowly typed `openRouterRouting` — declaration data, the same category as `maxTokens` and `thinkingLevelMap` — which both catalogs carry and `synthesiseModel` maps into pi's `compat.openRouterRouting`, guarded by a construction-time assert so a declaration that cannot reach the wire fails loudly instead of sitting inert. (Hardening) `synthesiseModel` prefers the model's own bundled entry as its template when the base catalog carries that id on the same api, so amending a bundled model stops inheriting a size-picked stranger's `maxTokens` and `input`.

**Tech Stack:** TypeScript 7 (exact pin, `strict`, `exactOptionalPropertyTypes`, `nodenext`), Vitest, Biome. Bun runs scripts; it is never assumed at runtime.

**Spec:** GitHub issue #43 — https://github.com/nathapp-io/nax-ai/issues/43, **as re-scoped by the verification comment of 2026-09-18** on that issue. Read the comment, not just the issue body: two of the body's premises are dead (the `CompleteOptions` anchor is a vestigial type referenced nowhere but `src/index.ts:108`, and pi-ai `0.85.1` already models routing first-class), so the body's "Known workaround" proxy section and its options 1-3 argue from a wire that no longer exists. This plan implements the comment's **P1** and **P2**, and deliberately does **not** implement its **P3** — see "P3: analysed, not folded" at the end.

**Base commit:** every line number below is anchored against `main` @ `11c9d34a01893319a7d5fa88e3dca40ae577c789` (v0.1.14), which is where branch `feat/openrouter-routing-and-response-identity` starts. Line numbers are hints, not addresses: if the file has moved under you, find the symbol by name.

## Verification status — this plan was executed once and reverted

Before handover, every source edit and every test in Tasks 1-5 was applied to a scratch working tree at the base commit, typechecked, run, and then reverted (`git checkout -- .`; the tree is clean and only this document plus a formatting commit exist on the branch). So the literal code below is known to compile and the stated failures are the ones actually observed, not predictions:

| Task | Result when applied |
|:--|:--|
| 1 + 2 | `tsc --noEmit` clean; suite **499 passed** (487 baseline + 12 new) |
| 3 + 4 | `tsc --noEmit` clean; the compat spread typechecks as `Model<Api>`, and a deliberately typo'd key is rejected by `tsc` — so the check is real |
| 4 | the wire test's `provider` block **did land in the request body**, and the unrouted control sent none |
| 5 | its two tests failed first with exactly `expected 1800000 to be 16384` and `expected [ 'text', 'image' ] to deeply equal [ 'text' ]`, then passed after the change |
| all | full suite **506 passed**, `bun run lint` clean. Nothing outside the touched files moved — notably the `#47` thinkingLevelMap suite and the `gpt-4` collision test survive Task 5 unchanged |

Two things that verification changed in this document, worth knowing because they are the kind of thing that looks like a typo: the `responseModel` test snippet in Task 1 Step 6 is written pre-wrapped because Biome reformats the single-line form (120-column rule), and Task 0's README anchor ordering is fixed so three tasks inserting into one section cannot collide.

What was **not** verified, and cannot be here: that any provider actually honours the `provider` block. Task 4 proves the field reaches the request body through pi's real builder; it does not prove OpenRouter routes accordingly. The evidence for that is external — a 2026-09-13 probe measured `quantizations` + `sort` steering real traffic, and found the quantization filter refuses (`"No endpoints found for the request with quantization: fp4"`) rather than silently downgrading.

## Global Constraints

- Node >= 22.19, ESM-only. No `Bun.*` and no `bun:` imports in `src/` (`bun run check:no-bun-apis`).
- Only `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts` and `src/auth/pi-auth.ts` may import `@earendil-works/pi-ai` (`bun run check:pi-ai-imports`). Test files may import pi-ai, including past its top-level export.
- `@earendil-works/pi-ai` stays pinned at `0.85.1`. Do not bump it in this plan.
- `exactOptionalPropertyTypes` is on: build optional properties conditionally (`...(x !== undefined ? { x } : {})`); never assign `undefined`, and never fabricate a value the provider did not send.
- Imports carry explicit `.ts` extensions (`nodenext`, not bundler).
- Every new field on a published type is **optional**. `ResolvedModel`, `CompleteResult` and `ProtocolEvent` are all exported from `src/index.ts`; a required field would be a breaking change.
- Tests live under `test/`, mirror `src/`, and are named `*.test.ts`. `test/live/*.live.test.ts` are excluded from `bun run test`; they need real keys and spend money. **Do not run them in this plan.**
- A regression test must be run and seen to fail against the pre-change code before it counts (repo rule; every task below builds that in).
- Formatting: Biome, 2-space indent, 120 columns. `noNonNullAssertion` is an error in tests — do not use `!`. Export lists in `src/index.ts` are sorted; keep them sorted.
- Commands: `bun run test`, `bun run test <path>` (Vitest file filter), `bun run typecheck`, `bun run lint`.
- Scripted-event tests prove the mapping is self-consistent, not that a provider behaves that way. Where this plan has real recorded evidence it says so; where it does not, the test comment must say so too.

## Background a fresh reader needs

Five facts, all verified against the base commit and the pinned pi-ai:

1. **pi already models OpenRouter routing.** `Model.compat.openRouterRouting: OpenRouterRouting` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:496`, shape at `:629-654`) is applied at `dist/api/openai-completions.js:745-747` as `params.provider = model.compat.openRouterRouting`. **Only** `openai-completions` does this — `grep -l openRouterRouting dist/api/*.js` returns that one file. `anthropic-messages` has zero occurrences, and OpenRouter serves models on **both** apis in pi's bundled catalog, so a routing declaration on an `anthropic-messages` model is silently inert. That is what Task 3's assert exists for.
2. **Nothing is pinned by default.** Of the 366 models pi bundles under provider `openrouter`, **zero** carry `compat.openRouterRouting`. The routing lottery the issue describes is real.
3. **pi already captures the response identity and nax-ai throws it away.** `AssistantMessage.responseId` / `.responseModel` (`types.d.ts:313-314`) are set by `anthropic-messages`, `openai-completions`, `openai-responses-shared` and `openai-codex-responses` — all four protocols nax-ai registers. `pi-client.ts:326-340`'s `done` case holds that message and yields only `usage` and `stopReason`. `responseModel` is set **only when it differs from `model.id`** (`openai-completions.js:375-377`), which is exactly the aggregator-remap case worth surfacing.
4. **The recorded fixtures already carry it.** Every non-example fixture's `done` event has a real `responseId` (`openai-codex-responses` `resp_028d…`, `anthropic-messages` `06e4e4c6…`, `openai-completions` `router-2b30…`, `openai-responses` `resp_0d92…`). None carries `responseModel`. So P1 gets real-provider evidence for `responseId` and scripted-only evidence for `responseModel`.
5. **OpenRouter's served endpoint is in the chunk body as a top-level `provider` field, and pi discards it** (no `chunk.provider` / `provider_name` read anywhere in `dist/api/`). Surfacing *that* needs an upstream change. `responseId` needs none — OpenRouter's `/generation?id=` resolves it to `provider_name` on the consumer's side. This plan does the part that needs no upstream change.

## File Structure

| File | Change | Why here |
|:--|:--|:--|
| `src/protocols/types.ts` | `done` event gains `responseId?` / `responseModel?` | The wire vocabulary; both names appear in more than one provider's format |
| `src/protocols/collect.ts` | carries them onto `CompleteResult` | The single derivation point for `complete()` |
| `src/types.ts` | `CompleteResult` gains the two fields | Public vocabulary |
| `src/providers/types.ts` | new `OpenRouterRouting`; `ResolvedModel.openRouterRouting?` | Declaration data, beside `pricing` / `maxTokens` / `thinkingLevelMap` |
| `src/providers/override-model.ts` | new `assertOverrideModelRouting` | The one module both catalogs share, and it imports no pi-ai |
| `src/providers/catalog.ts` | calls the new assert | Client-side catalog |
| `src/protocols/pi-client.ts` | `done` mapping; `toPiOpenRouterRouting`; `synthesiseModel` template + compat | The only file allowed to touch pi's `Model` |
| `src/index.ts` | exports `OpenRouterRouting` | New published type |
| `README.md` | three subsections: provider overrides (Task 0), response identity (Task 2), routing (Task 4) | The repo documents caller-visible capability there (`### Constrained sampling` is the precedent), and the override mechanism is currently undocumented |

No new source file is created: every change lands in a module that already owns that responsibility, and the largest of them (`pi-client.ts`) grows by roughly 40 lines.

---

### Task 0: Document `ProviderOverride` in the README

Documentation only, no source change, independent of everything below. It comes first because Tasks 2 and 4 hang their own subsections off the section it creates.

**Why it is in this plan:** `grep -i override README.md ROADMAP.md` at the base commit returns **nothing**. The whole override mechanism — three shipped issues' worth of behaviour (#36's two-catalog rule, #39's `maxTokens`, #47's `thinkingLevelMap`) — is documented only in source docstrings, and Task 4 is about to add a fourth field to it. A reader who wants to pin routing has no entry point.

**Files:**
- Modify: `README.md` (new `### Provider overrides` subsection under `## Usage`)

**Interfaces:**
- Consumes: nothing.
- Produces: a `### Provider overrides` heading under `## Usage`, which Tasks 2 and 4 anchor against.

- [ ] **Step 1: Write the section**

In `README.md`, immediately after the paragraph beginning "While the API is unstable…" (which closes the `## Usage` section's example), add:

````markdown
### Provider overrides

The bundled catalog comes from pi-ai and is a snapshot: it can carry stale pricing, and it will not know a model your provider added last week. `providerOverrides` amends it — per provider, and only with declaration data.

```ts
import { createClient, defaultProtocols, piProviders, type ProviderOverride } from "@nathapp/nax-ai";

const providerOverrides: readonly ProviderOverride[] = [
  {
    provider: "openrouter",
    models: [
      {
        id: "z-ai/glm-5.3-flash",
        provider: "openrouter",
        protocol: "openai-completions",
        pricing: { input: 0.15, output: 0.5, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_768,
        supportsTools: true,
        thinkingLevels: ["off", "high"],
      },
    ],
  },
];

const client = createClient({
  providers: await piProviders(["openrouter"]),
  // The factory form hands the client's own overrides to the protocol side, so
  // the array is written once. Prefer it whenever overrides are in play — and
  // add `credentials` here too if you use a credential store (see below).
  protocols: (o) => defaultProtocols({ ...o }),
  providerOverrides,
});
```

**An override must reach both catalogs.** The client prices and resolves against one; the wire resolves against another. Declaring the array on `createClient` alone is a real bug with no symptom until the first request, so `createClient` rejects it at construction. The factory form above is how you avoid writing the array twice; passing the same array to both `createClient` and `defaultProtocols({ providerOverrides })` works too.

**What an override can say.** A `ProviderOverride` carries `baseUrl`, `headers` and `models`. `baseUrl` and `headers` replace rather than merge, and apply to every model of that provider, bundled ones included — that is how a proxy or a tenant header is wired. Each entry in `models` is a full `ResolvedModel`: `pricing`, `contextWindow`, `maxTokens`, `supportsTools`, `thinkingLevels`, `thinkingLevelMap` and `supportsStrictToolSampling`.

**What it cannot say.** Declaration data only: behaviour belongs in a protocol backend, not here. An override also amends a provider — it cannot introduce one, since there would be no `stream` implementation to inherit.

**Two rules that throw rather than warn.** A model's own `provider` field must equal the override's `provider` (otherwise the request would be signed against a provider you never named), and a model the base catalog does not carry must be declared on both sides.

**Fields you do not state are inherited from a sibling.** `ResolvedModel` is narrower than the wire's model, so `name`, `baseUrl`, `input` and the provider compatibility settings come from another model of the same provider on the same protocol — preferring one that supports your declared thinking levels. State `maxTokens` and `thinkingLevelMap` explicitly when they matter: an inherited ceiling is a silent truncation, and an inherited thinking map can mark a level you declared unsupported.
````

- [ ] **Step 2: Verify the example actually compiles**

A README example that does not typecheck is worse than none. Prove this one does, in a throwaway file you delete immediately:

```bash
cat > test/__doc-probe.test.ts <<'PROBE'
import { describe, it } from "vitest";
import { createClient } from "../src/client.ts";
import { defaultProtocols } from "../src/protocols/pi-protocols.ts";
import { piProviders } from "../src/providers/pi-catalog.ts";
import type { ProviderOverride } from "../src/providers/types.ts";

const providerOverrides: readonly ProviderOverride[] = [
  {
    provider: "openrouter",
    models: [
      {
        id: "z-ai/glm-5.3-flash",
        provider: "openrouter",
        protocol: "openai-completions",
        pricing: { input: 0.15, output: 0.5, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_768,
        supportsTools: true,
        thinkingLevels: ["off", "high"],
      },
    ],
  },
];

describe("doc probe", () => {
  it("constructs the client the README describes", async () => {
    const client = createClient({
      providers: await piProviders(["openrouter"]),
      protocols: (o) => defaultProtocols({ ...o }),
      providerOverrides,
    });
    void client;
  });
});
PROBE
bun run typecheck && bun run test test/__doc-probe.test.ts
rm test/__doc-probe.test.ts
```

Expected: typecheck clean and the probe PASSES. It passing is not incidental — it proves the declaration-parity check accepts the factory wiring the README recommends. The probe is the README example verbatim, which is the point: if you edit one, edit both. Delete the file before committing; do not leave it in the suite.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: PASS. (Biome does not check Markdown, but the gate scripts scan `test/` — run this *after* deleting the probe, and it will catch it if you forgot.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document providerOverrides and the two-catalog rule"
```

---

### Task 1: Surface the provider's response identity on the `done` event

**Files:**
- Modify: `src/protocols/types.ts` (the `done` member of `ProtocolEvent`, line 212)
- Modify: `src/protocols/pi-client.ts` (the `case "done"` block, lines 326-340)
- Test: `test/protocols/replay.test.ts` (append a test inside the per-fixture `describe`, after the "carries a note…" test at lines 41-43)
- Test: `test/protocols/pi-client.test.ts` (append to `describe("createPiProtocol event mapping", …)`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProtocolEvent` of type `"done"` may now carry `responseId?: string` and `responseModel?: string`. Both are absent when the provider sent nothing — never `undefined`-valued, never `""`.

- [ ] **Step 1: Write the failing replay test**

This is the one that has real provider evidence behind it. Append inside the `describe(name, …)` block in `test/protocols/replay.test.ts`, after the existing `it("carries a note saying what it is evidence of", …)`:

```ts
      /**
       * Real evidence, not a script: every non-example fixture in this
       * directory was recorded off a live provider and its `done` event
       * carries the provider's own response id (a `resp_…` for the OpenAI
       * shapes, a bare hex id for anthropic-messages, a `router-…` for the
       * opencode-go aggregator). Asserting equality with what the fixture
       * recorded — including the absent case — is what proves the mapper
       * forwards the value rather than inventing one.
       */
      it("forwards the provider's own response id from the recorded done event", async () => {
        const fixture = loadFixture(name);
        if (fixture.response.status >= 400) return;

        const recorded = fixture.events.find((e) => e.type === "done");
        const expected = recorded?.type === "done" ? recorded.message.responseId : undefined;

        const events = await drainFixture(fixture);
        const done = events.find((e) => e.type === "done");
        expect(done?.type).toBe("done");
        if (expected === undefined) {
          expect(done === undefined || "responseId" in done).toBe(false);
          return;
        }
        expect(done).toMatchObject({ responseId: expected });
      });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run test test/protocols/replay.test.ts`
Expected: **6 failures** — measured, not predicted: `openai-codex-responses-text`, all three `opencode-go-anthropic-messages-*`, `opencode-go-openai-completions-text` and `opencode-go-openai-responses-text`, each with `AssertionError: expected { type: 'done', stopReason: 'stop' } to match object { Object (responseId) }`. `example-text`, `example-bad-header` and `error-rate-limit` pass already, because they record no `responseId` — which is the absent branch of the same test doing its job.

- [ ] **Step 3: Widen the `done` event**

In `src/protocols/types.ts`, replace the last member of the `ProtocolEvent` union (line 212):

```ts
  | { readonly type: "done"; readonly stopReason: StopReason };
```

with:

```ts
  | {
      readonly type: "done";
      readonly stopReason: StopReason;
      /**
       * The provider's own identifier for this response, when it sent one.
       *
       * Opaque and provider-shaped — never parsed, compared or synthesised
       * here. It exists because an aggregator's model id does not say which
       * upstream endpoint answered: two calls to one id can be served at
       * different prices and different quantizations, and this is the only
       * handle a consumer has for asking the aggregator afterwards (OpenRouter
       * resolves it through `/generation?id=`). Absent means the provider sent
       * no id, which is different from an empty one.
       */
      readonly responseId?: string;
      /**
       * The model the provider says actually answered, when it names one that
       * differs from the id that was requested. Present only on a remap, so
       * absence means "not remapped, or not reported" — never assume it equals
       * the requested id.
       */
      readonly responseModel?: string;
    };
```

- [ ] **Step 4: Forward them in the pi mapper**

In `src/protocols/pi-client.ts`, in `case "done":` (lines 326-340), replace the final `yield`:

```ts
              yield { type: "done", stopReason };
```

with:

```ts
              // pi holds both on the terminal message and nax-ai used to drop
              // them. Conditional spreads because `exactOptionalPropertyTypes`
              // is on and "the provider reported nothing" must stay
              // distinguishable from "reported an empty string".
              const { responseId, responseModel } = event.message;
              yield {
                type: "done",
                stopReason,
                ...(responseId !== undefined ? { responseId } : {}),
                ...(responseModel !== undefined ? { responseModel } : {}),
              };
```

- [ ] **Step 5: Run the replay test to verify it passes**

Run: `bun run test test/protocols/replay.test.ts`
Expected: PASS, all fixtures.

- [ ] **Step 6: Add the scripted `responseModel` test**

`responseModel` has no recorded evidence (no fixture carries one), so it needs a scripted test and the comment must say so. Append to `describe("createPiProtocol event mapping", …)` in `test/protocols/pi-client.test.ts`:

```ts
  /**
   * Scripted, not recorded: no fixture in test/fixtures/recorded carries a
   * `responseModel`, because pi sets it only when the provider names a model
   * different from the one requested (openai-completions.js:375-377) and no
   * recording captured a remap. This proves the mapping, not that any
   * particular provider remaps.
   */
  it("forwards responseModel when the provider remapped the model", async () => {
    const events = await drain([
      {
        type: "done",
        reason: "stop",
        message: message({ responseId: "r-1", responseModel: "deepseek-v4-flash-0711" }),
      },
    ] as AssistantMessageEvent[]);

    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      responseId: "r-1",
      responseModel: "deepseek-v4-flash-0711",
    });
  });

  it("omits both when the provider reported neither, rather than sending undefined", async () => {
    const events = await drain([{ type: "done", reason: "stop", message: message() }] as AssistantMessageEvent[]);

    const done = events.at(-1);
    expect(done).toEqual({ type: "done", stopReason: "stop" });
    expect(done !== undefined && "responseId" in done).toBe(false);
  });
```

- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all PASS. (`test/protocols/types.test.ts` asserts the eight event *type names*, not their shapes, so it is unaffected.)

- [ ] **Step 8: Commit**

```bash
git add src/protocols/types.ts src/protocols/pi-client.ts test/protocols/replay.test.ts test/protocols/pi-client.test.ts
git commit -m "feat: surface the provider's response id and remapped model on the done event (#43)"
```

---

### Task 2: Carry the response identity into `CompleteResult`

**Files:**
- Modify: `src/types.ts` (`CompleteResult`, lines 53-65)
- Modify: `src/protocols/collect.ts` (`collectStream`, lines 22-69)
- Test: `test/protocols/collect.test.ts` (append to `describe("collectStream", …)`)
- Modify: `README.md` (one paragraph under `## Usage`, after the code block that ends the section's example)

**Interfaces:**
- Consumes: Task 1's `done` event fields.
- Produces: `CompleteResult.responseId?: string` and `CompleteResult.responseModel?: string`, populated from the `done` event and absent when it carried neither.

- [ ] **Step 1: Write the failing test**

Append to `describe("collectStream", …)` in `test/protocols/collect.test.ts`:

```ts
  it("carries the response identity off the done event", async () => {
    const result = await collectStream(
      emit(
        { type: "text-delta", text: "hi" },
        { type: "usage", usage },
        { type: "done", stopReason: "stop", responseId: "r-1", responseModel: "gpt-5.4-mini-0711" },
      ),
    );

    expect(result.responseId).toBe("r-1");
    expect(result.responseModel).toBe("gpt-5.4-mini-0711");
  });

  it("omits the response identity entirely when the provider reported none", async () => {
    // Absent must stay absent: a consumer reconciling a cost ledger has to be
    // able to tell "this provider names no response" from "this one named an
    // empty string", and an `undefined`-valued key blurs that in JSON.
    const result = await collectStream(emit({ type: "done", stopReason: "stop" }));

    expect("responseId" in result).toBe(false);
    expect("responseModel" in result).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run test test/protocols/collect.test.ts`
Expected: FAIL with exactly `AssertionError: expected undefined to be 'r-1' // Object.is equality` on the first test (measured). The second passes vacuously before the change; it is the guard that keeps the first one's fix honest.

- [ ] **Step 3: Widen `CompleteResult`**

In `src/types.ts`, inside `CompleteResult` (lines 53-65), add after the `thinking` field and before the closing brace:

```ts
  /**
   * The provider's own identifier for this response, when it sent one, and the
   * model it says actually answered, when that differs from the one requested.
   * Both come straight off the `done` event — see `ProtocolEvent` for why they
   * are opaque and why absence is meaningful.
   */
  readonly responseId?: string;
  readonly responseModel?: string;
```

- [ ] **Step 4: Carry them through `collectStream`**

In `src/protocols/collect.ts`, add a holder beside `stopReason` (after line 27):

```ts
  let identity: { responseId?: string; responseModel?: string } = {};
```

replace the `done` case (lines 47-49):

```ts
      case "done":
        stopReason = event.stopReason;
        break;
```

with:

```ts
      case "done":
        stopReason = event.stopReason;
        identity = {
          ...(event.responseId !== undefined ? { responseId: event.responseId } : {}),
          ...(event.responseModel !== undefined ? { responseModel: event.responseModel } : {}),
        };
        break;
```

and add the spread to the result literal (lines 62-68), after the `thinking` spread:

```ts
    ...identity,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test test/protocols/collect.test.ts`
Expected: PASS.

- [ ] **Step 6: Document it**

In `README.md`, directly **before** the existing `### Constrained sampling` heading, add:

```markdown
### Knowing which response you got

`CompleteResult` and the `done` protocol event carry `responseId` and `responseModel` when the provider reports them. Against an aggregator these are the only handle on what actually served a request: one model id can resolve to different upstream endpoints at different prices and quantizations per call, so a cost ledger that multiplies tokens by the catalog rate is approximate, and `responseId` is what lets you reconcile it afterwards (OpenRouter resolves it through `/generation?id=`). `responseModel` appears only when the provider names a model different from the one requested, so its absence is not a statement that no remap happened.
```

- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/protocols/collect.ts test/protocols/collect.test.ts README.md
git commit -m "feat: carry responseId and responseModel onto CompleteResult (#43)"
```

---

### Task 3: Declare `openRouterRouting` as model declaration data, and refuse a declaration that cannot reach the wire

This task adds the type and the guard. Nothing reaches the wire until Task 4 — which is deliberate: the guard has to exist before the mapping, or the first consumer to declare routing on an `anthropic-messages` model gets silence instead of an error.

**Files:**
- Modify: `src/providers/types.ts` (new `OpenRouterRouting` interface; `ResolvedModel` gains the field, after `thinkingLevelMap` at lines 93-104)
- Modify: `src/providers/override-model.ts` (new exported `assertOverrideModelRouting`)
- Modify: `src/providers/catalog.ts` (call it in the override loop, lines 107-112)
- Modify: `src/index.ts` (export the type from the `./providers/types.ts` block at lines 98-106)
- Test: `test/providers/catalog.test.ts` (append to `describe("normaliseCatalog", …)`, before the final `});`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface OpenRouterRouting` with all-optional readonly fields `allow_fallbacks?: boolean`, `require_parameters?: boolean`, `data_collection?: "deny" | "allow"`, `zdr?: boolean`, `order?: readonly string[]`, `only?: readonly string[]`, `ignore?: readonly string[]`, `quantizations?: readonly string[]`, `sort?: "price" | "throughput" | "latency"`.
  - `ResolvedModel.openRouterRouting?: OpenRouterRouting`.
  - `assertOverrideModelRouting(model: ResolvedModel): void` — throws when routing is declared on a model whose `protocol` is not `"openai-completions"`, and when it is declared with no keys.
  - Both exported from `src/index.ts` (`OpenRouterRouting` only; the assert stays internal).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("normaliseCatalog", …)` in `test/providers/catalog.test.ts`, before its closing `});`:

```ts
  it("carries an override model's openRouterRouting into the resolved catalog", () => {
    const catalog = normaliseCatalog(
      [
        {
          id: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          auth: { kind: "api-key" },
          defaultProtocol: "openai-completions",
          models: [],
        },
      ],
      [
        {
          provider: "openrouter",
          models: [
            {
              id: "deepseek/deepseek-v4-flash",
              provider: "openrouter",
              protocol: "openai-completions",
              pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 163840,
              supportsTools: true,
              thinkingLevels: [],
              openRouterRouting: { allow_fallbacks: false, only: ["deepinfra"], quantizations: ["fp8"] },
            },
          ],
        },
      ],
    );

    expect(catalog.model("openrouter", "deepseek/deepseek-v4-flash")?.openRouterRouting).toEqual({
      allow_fallbacks: false,
      only: ["deepinfra"],
      quantizations: ["fp8"],
    });
  });

  /**
   * pi applies `compat.openRouterRouting` in dist/api/openai-completions.js
   * only — anthropic-messages has zero occurrences of it, and OpenRouter
   * serves models on BOTH apis. So a routing declaration on any other
   * protocol is a declared-but-unreachable field, and this repo rejects that
   * at construction rather than at the wire (the precedent
   * `assertOverrideModelProvider` already sets).
   */
  it("rejects routing declared on a protocol that cannot send it", () => {
    expect(() =>
      normaliseCatalog(
        [
          {
            id: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            auth: { kind: "api-key" },
            defaultProtocol: "openai-completions",
            models: [],
          },
        ],
        [
          {
            provider: "openrouter",
            models: [
              {
                id: "anthropic/claude-on-openrouter",
                provider: "openrouter",
                protocol: "anthropic-messages",
                pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                supportsTools: true,
                thinkingLevels: [],
                openRouterRouting: { only: ["deepinfra"] },
              },
            ],
          },
        ],
      ),
    ).toThrow(/openai-completions/);
  });

  it("rejects an empty routing declaration rather than sending an empty provider block", () => {
    expect(() =>
      normaliseCatalog(
        [
          {
            id: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            auth: { kind: "api-key" },
            defaultProtocol: "openai-completions",
            models: [],
          },
        ],
        [
          {
            provider: "openrouter",
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                provider: "openrouter",
                protocol: "openai-completions",
                pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 163840,
                supportsTools: true,
                thinkingLevels: [],
                openRouterRouting: {},
              },
            ],
          },
        ],
      ),
    ).toThrow(/states no preference/);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run typecheck` **first**, then `bun run test test/providers/catalog.test.ts`.

Expected, and this one is not symmetric — it was measured, so do not go hunting for a runtime failure that will not come:

- `bun run typecheck` FAILS on the first test: `openRouterRouting` does not exist on `ResolvedModel`. **That is this test's regression demonstration.**
- `bun run test` shows the first test **PASSING**. That is not a broken test. Vitest strips types, and `normaliseCatalog` stores an override's `ResolvedModel` by reference (`catalog.ts:110`), so an undeclared property survives into the catalog at run time with no source change at all. The type is the whole contract here; `tsc` is the gate that enforces it.
- The two rejection tests FAIL at run time with "expected function to throw".

Do not proceed until you have seen the typecheck error and both throw failures.

- [ ] **Step 3: Declare the type and the field**

In `src/providers/types.ts`, add above `ResolvedModel` (i.e. after the `ProviderAuth` block ending line 46):

```ts
/**
 * OpenRouter-compatible provider routing preferences, sent verbatim as the
 * request's `provider` field.
 *
 * Named after the vendor on purpose. Unlike `protocols/types.ts`, which keeps
 * one provider's shape out of the wire vocabulary, this is catalog declaration
 * data about a specific aggregator's behaviour, and a neutral name
 * (`routing`) would imply a portability that does not exist: pi sends this
 * field from `openai-completions` only, and only an OpenRouter-compatible
 * endpoint reads it.
 *
 * Keys stay snake_case because they are the wire field names and pass through
 * unmapped — a camelCase mirror would be a translation layer with nothing to
 * gain and a rename to get wrong.
 *
 * Why this is declaration data rather than a behaviour override: it lives on
 * pi's `Model`, beside `cost` and `contextWindow`, exactly as `maxTokens` and
 * `thinkingLevelMap` do. So carrying it on `ProviderOverride.models` does not
 * cross the "declaration only" line in `ProviderOverride`'s docstring below.
 *
 * Narrower than pi's own type: `max_price`, `preferred_min_throughput`,
 * `preferred_max_latency` and `enforce_distillable_text` are omitted because
 * nothing needs them yet and every field here is tested. Widening later is
 * source-compatible; narrowing is not.
 */
export interface OpenRouterRouting {
  /** Whether backup providers may serve the request. Upstream default: true. */
  readonly allow_fallbacks?: boolean;
  /** Restrict to providers supporting every parameter in the request. */
  readonly require_parameters?: boolean;
  /** `"deny"` keeps the request off endpoints that may store or train on it. */
  readonly data_collection?: "deny" | "allow";
  /** Restrict to Zero Data Retention endpoints. */
  readonly zdr?: boolean;
  /** Ordered provider slugs to try in sequence. */
  readonly order?: readonly string[];
  /** The only provider slugs allowed to serve this request. */
  readonly only?: readonly string[];
  /** Provider slugs to skip. */
  readonly ignore?: readonly string[];
  /**
   * Quantization levels to filter endpoints by, e.g. `["fp8"]`. This is the
   * reproducibility lever: one model id can otherwise be served fp4 on one
   * call and fp8 on the next, which confounds any A/B across models.
   */
  readonly quantizations?: readonly string[];
  /** Routing strategy. Omitted means OpenRouter's own default ordering. */
  readonly sort?: "price" | "throughput" | "latency";
}
```

and add to `ResolvedModel`, after `thinkingLevelMap` (line 104):

```ts
  /**
   * Endpoint routing for an OpenRouter-compatible aggregator, when this model
   * pins one. Reaches the wire only through `ProviderOverride.models` and only
   * on `protocol: "openai-completions"`; declaring it elsewhere is rejected at
   * construction rather than silently ignored (issue #43).
   */
  readonly openRouterRouting?: OpenRouterRouting;
```

- [ ] **Step 4: Write the guard**

In `src/providers/override-model.ts`, append after `assertOverrideModelProvider`:

```ts
/**
 * The second consistency rule: a routing declaration that cannot reach the
 * wire is rejected rather than ignored.
 *
 * pi sends `compat.openRouterRouting` from its `openai-completions` adapter
 * and from no other (`dist/api/openai-completions.js:745-747`; zero
 * occurrences in `anthropic-messages.js`). OpenRouter itself serves models on
 * both apis, so "declared routing on an OpenRouter model" is not enough for it
 * to be sent — and a consumer who pinned `quantizations: ["fp8"]` and silently
 * got the routing lottery anyway has no way to notice. Same reasoning as
 * `assertOverrideModelProvider`: there is no configuration this shape
 * expresses correctly.
 *
 * An empty object is rejected for a different reason: pi's check is
 * truthiness, not emptiness, so `{}` would reach the wire as `provider: {}` —
 * a request field that says nothing, sent because a caller declared something
 * that says nothing. Rejecting it turns a no-op into a question.
 */
export function assertOverrideModelRouting(model: ResolvedModel): void {
  const routing = model.openRouterRouting;
  if (routing === undefined) return;

  if (model.protocol !== "openai-completions") {
    throw new Error(
      `Model "${model.id}" declares openRouterRouting but its protocol is "${model.protocol}". Only ` +
        `"openai-completions" sends the OpenRouter "provider" request field, so this declaration could never ` +
        `reach the wire: either declare the model on "openai-completions" or drop the routing.`,
    );
  }

  if (Object.keys(routing).length === 0) {
    throw new Error(
      `Model "${model.id}" declares openRouterRouting that states no preference. An empty declaration would be ` +
        `sent as an empty "provider" block and change nothing: state at least one preference, or omit the field.`,
    );
  }
}
```

- [ ] **Step 5: Call it from the client-side catalog**

In `src/providers/catalog.ts`, update the import on line 15:

```ts
import { assertOverrideModelProvider, assertOverrideModelRouting } from "./override-model.ts";
```

and in the override loop (lines 107-112), add the call after the existing assert:

```ts
      assertOverrideModelProvider(override.provider, model);
      assertOverrideModelRouting(model);
      setModel(override.provider, model);
```

- [ ] **Step 6: Export the type**

In `src/index.ts`, add `OpenRouterRouting` as the first entry of the `./providers/types.ts` export block (lines 98-106), keeping the list sorted:

```ts
export type {
  OpenRouterRouting,
  Pricing,
  PricingRates,
  PricingTier,
  ProviderAuth,
  ProviderOverride,
  ResolvedModel,
  ResolvedProvider,
} from "./providers/types.ts";
```

- [ ] **Step 7: Run the tests, typecheck and lint**

Run: `bun run test test/providers/catalog.test.ts && bun run typecheck && bun run lint`
Expected: PASS. Then run the full suite: `bun run test` — expected PASS (`test/protocols/pi-client-overrides.test.ts` declares no routing, so nothing there changes).

- [ ] **Step 8: Commit**

```bash
git add src/providers/types.ts src/providers/override-model.ts src/providers/catalog.ts src/index.ts test/providers/catalog.test.ts
git commit -m "feat: declare openRouterRouting on ResolvedModel and reject unreachable declarations (#43)"
```

---

### Task 4: Send the routing to the wire

**Files:**
- Modify: `src/protocols/pi-client.ts` (import `assertOverrideModelRouting`; new `toPiOpenRouterRouting`; `synthesiseModel` return literal at lines 560-581; `applyOverrides` model loop at lines 670-676)
- Modify: `README.md` (new subsection after `### Constrained sampling`)
- Test: `test/protocols/pi-client-overrides.test.ts` (hoist the existing `wirePayload` helper; add a `describe("openRouterRouting (issue #43)", …)`)

**Interfaces:**
- Consumes: `OpenRouterRouting` and `assertOverrideModelRouting` from Task 3.
- Produces: a synthesised override model whose pi `compat.openRouterRouting` carries the declaration, so `openai-completions` emits it as the request body's `provider` field. No new exported symbol.

- [ ] **Step 1: Hoist the wire-payload helper**

`wirePayload` currently lives inside `describe("thinkingLevelMap synthesis (issue #47)", …)` in `test/protocols/pi-client-overrides.test.ts`: its docstring opens at line 297, `async function wirePayload(` is at **line 305**, and its closing brace is at **line 330** (`return captured;` on 329). Move the whole run of lines 297-330 — docstring included, body unchanged — to module scope, directly after the `stubStream` helper near the top of the file. Leave every existing call site as it is; they resolve to the hoisted function. Its `reasoning` parameter type (`"off" | "low" | "high" | "max" | "xhigh"`) already covers the `"off"` the new tests pass, so the signature needs no change.

Run: `bun run test test/protocols/pi-client-overrides.test.ts`
Expected: PASS, unchanged — this step is a pure move and must not alter a single assertion.

- [ ] **Step 2: Write the failing wire test**

Append a new top-level `describe` to `test/protocols/pi-client-overrides.test.ts`:

```ts
/**
 * OpenRouter endpoint pinning (issue #43).
 *
 * Asserted at the wire body through pi-ai's real openai-completions builder,
 * not at the synthesised `Model`: `compat.openRouterRouting` sitting on a model
 * object proves nothing about what pi sends, and this whole field exists to
 * change a request body. The ids are real entries in pi-ai's bundled
 * `openrouter` catalog, matching this file's house style.
 */
describe("openRouterRouting (issue #43)", () => {
  const PINNED: ResolvedModel = {
    id: "deepseek/deepseek-chat",
    provider: "openrouter",
    protocol: "openai-completions",
    pricing: { input: 0.25, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 163840,
    supportsTools: true,
    thinkingLevels: [],
    openRouterRouting: { allow_fallbacks: false, only: ["deepinfra"], quantizations: ["fp8"], sort: "price" },
  };

  it("sends the declaration as the request body's provider field", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [PINNED] }] });
    const model = await deps.resolveModel(PINNED.id, "openrouter");

    await expect(wirePayload(model, "off")).resolves.toMatchObject({
      provider: { allow_fallbacks: false, only: ["deepinfra"], quantizations: ["fp8"], sort: "price" },
    });
  });

  it("sends no provider field for a model that declares no routing", async () => {
    // The control. Without it, a change that unconditionally set `provider`
    // would pass the test above while pinning every model in the catalog.
    const deps = createPiDeps({});
    const model = await deps.resolveModel("deepseek/deepseek-chat", "openrouter");

    const payload = await wirePayload(model, "off");
    expect(payload).not.toHaveProperty("provider");
  });

  it("keeps the template's other compat settings rather than replacing the object", async () => {
    // `thinkingFormat: "openrouter"` is detected for this provider and is what
    // translates a thinking level on the wire; a compat object rebuilt from
    // routing alone would silently drop it.
    const deps = createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [PINNED] }] });
    const model = await deps.resolveModel(PINNED.id, "openrouter");

    expect(model.compat).toMatchObject({ thinkingFormat: "openrouter" });
  });

  it("refuses a routing declaration the wire could never send", async () => {
    // Same rule as the client-side catalog, raised from the same module, so
    // the two catalogs cannot disagree about which configs are legal.
    const unreachable: ResolvedModel = {
      ...PINNED,
      id: "anthropic/claude-on-openrouter",
      protocol: "anthropic-messages",
    };

    expect(() => createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [unreachable] }] })).toThrow(
      /openai-completions/,
    );
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`
Expected: test 1 FAILS (`provider` absent from the payload) and test 4 FAILS ("expected function to throw"). Tests 2 and 3 pass already — they are the controls.

- [ ] **Step 4: Map the declaration onto pi's compat**

In `src/protocols/pi-client.ts`, extend the import on line 30:

```ts
import { assertOverrideModelProvider, assertOverrideModelRouting } from "../providers/override-model.ts";
```

and line 31:

```ts
import type { OpenRouterRouting, Pricing, ProviderOverride, ResolvedModel } from "../providers/types.ts";
```

Add this function directly above `synthesiseModel` (i.e. before line 547's docstring):

```ts
/**
 * Our routing declaration, in the shape pi's `compat` wants.
 *
 * A copy rather than a pass-through for one reason: our arrays are `readonly`
 * and pi's are not, so spreading each present one is what makes the object
 * assignable without a cast. Conditional spreads keep an undeclared preference
 * out of the request entirely — `exactOptionalPropertyTypes`, and an
 * `undefined`-valued key would be serialised as a stated non-preference.
 */
function toPiOpenRouterRouting(routing: OpenRouterRouting) {
  return {
    ...(routing.allow_fallbacks !== undefined ? { allow_fallbacks: routing.allow_fallbacks } : {}),
    ...(routing.require_parameters !== undefined ? { require_parameters: routing.require_parameters } : {}),
    ...(routing.data_collection !== undefined ? { data_collection: routing.data_collection } : {}),
    ...(routing.zdr !== undefined ? { zdr: routing.zdr } : {}),
    ...(routing.order !== undefined ? { order: [...routing.order] } : {}),
    ...(routing.only !== undefined ? { only: [...routing.only] } : {}),
    ...(routing.ignore !== undefined ? { ignore: [...routing.ignore] } : {}),
    ...(routing.quantizations !== undefined ? { quantizations: [...routing.quantizations] } : {}),
    ...(routing.sort !== undefined ? { sort: routing.sort } : {}),
  };
}
```

In `synthesiseModel`'s return literal, add one member immediately before the closing `...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),` line:

```ts
    // Merged onto the template's compat, never replacing it: `thinkingFormat`
    // and the rest of the provider's detected settings live in the same object
    // and are what translate a thinking level on the wire.
    ...(model.openRouterRouting !== undefined
      ? { compat: { ...template.compat, openRouterRouting: toPiOpenRouterRouting(model.openRouterRouting) } }
      : {}),
```

(Type-probed against this repo's own tsconfig at the base commit: the literal typechecks as `Model<Api>`, and renaming the key to a typo makes `tsc` reject it — so the check is real, not structural slack.)

- [ ] **Step 5: Raise the same guard at the wire catalog**

In `applyOverrides`, add the call next to the existing assert (the loop at lines 670-676):

```ts
      assertOverrideModelProvider(override.provider, model);
      assertOverrideModelRouting(model);
      byId.set(model.id, synthesiseModel(base, model));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`
Expected: PASS, all four.

- [ ] **Step 7: Document it**

In `README.md`, directly **after** the `### Provider overrides` subsection Task 0 added (so it sits above `### Knowing which response you got`), add:

````markdown
### Pinning an OpenRouter endpoint

Against an aggregator, one model id is many endpoints: different machines, different prices, different quantizations, chosen per request. A `ResolvedModel` carried on a `ProviderOverride` can pin that choice with `openRouterRouting`, which is sent verbatim as the request's `provider` field:

```ts
const overrides = [
  {
    provider: "openrouter",
    models: [
      {
        id: "deepseek/deepseek-v4-flash",
        provider: "openrouter",
        protocol: "openai-completions",
        pricing: { input: 0.25, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 163840,
        supportsTools: true,
        thinkingLevels: [],
        openRouterRouting: { allow_fallbacks: false, only: ["deepinfra"], quantizations: ["fp8"] },
      },
    ],
  },
];
```

Pass the same array to both `createClient` and `defaultProtocols` — declaring it on the client alone fails at construction with a message explaining why.

This is declaration data on a model, not a per-request option: pinning belongs to the model entry so that two runs of one configuration are served the same way. Only `protocol: "openai-completions"` can send it, and declaring it on any other protocol throws rather than being ignored.
````

- [ ] **Step 8: Run the whole suite, typecheck and lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client-overrides.test.ts README.md
git commit -m "feat: send an override model's openRouterRouting as the request provider field (#43)"
```

---

### Task 5: Template an amended model off itself, not off a size-picked stranger

Independent hardening, reviewable on its own. It is in this plan because P2's headline use — pinning routing on a model the bundled catalog already carries — is exactly the shape that trips the existing behaviour.

**The defect, measured against the bundled catalog at the base commit:** an override declaring `deepseek/deepseek-chat` (a real `openrouter` entry, `contextWindow` 163,840, `maxTokens` 16,384, `input: ["text"]`) is templated by `pickTemplate` off `x-ai/grok-4.20`, the largest `openai-completions` sibling — `maxTokens` 1,800,000 and `input: ["text","image"]`. Since `synthesiseModel` uses `model.maxTokens ?? template.maxTokens`, an override that states no ceiling gets 1.8M sent for a 16k-output model, and the model advertises vision it does not have. Nothing declares that; it is inherited from a stranger picked by size.

**Files:**
- Modify: `src/protocols/pi-client.ts` (`synthesiseModel`, lines 547-581, plus its docstring)
- Test: `test/protocols/pi-client-overrides.test.ts` (append to the `describe("openRouterRouting (issue #43)", …)` file, as its own `describe`)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of Tasks 1-4; ordered last only because Task 4's tests make its effect visible).
- Produces: no API change. `synthesiseModel` now uses `base.getModels().find((m) => m.id === model.id && m.api === model.protocol)` as the template when such an entry exists, and `pickTemplate(...)` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `test/protocols/pi-client-overrides.test.ts`:

```ts
/**
 * Amending a model the base catalog already carries (issue #43, hardening).
 *
 * `pickTemplate` answers "what does a model of this provider on this api look
 * like", which is the right question for a phantom id and the wrong one for an
 * id the catalog already has: the honest template for `deepseek/deepseek-chat`
 * is `deepseek/deepseek-chat`. Real bundled ids, because a synthetic fixture
 * would not reproduce the size ordering that causes this.
 */
describe("amending a bundled model (issue #43)", () => {
  const AMENDED: ResolvedModel = {
    id: "deepseek/deepseek-chat",
    provider: "openrouter",
    protocol: "openai-completions",
    // Corrected pricing is the usual reason to amend a bundled entry; no
    // maxTokens is declared, which is what exposes the inherited one.
    pricing: { input: 0.25, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 163840,
    supportsTools: true,
    thinkingLevels: [],
  };

  it("inherits the model's own output ceiling, not the largest sibling's", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [AMENDED] }] });
    const [bundled] = (await defaultProviders(["openrouter"]))
      .flatMap((p) => p.models)
      .filter((m) => m.id === AMENDED.id);
    const amended = await deps.resolveModel(AMENDED.id, "openrouter");

    expect(bundled?.maxTokens).toBeDefined();
    expect(amended.maxTokens).toBe(bundled?.maxTokens);
  });

  it("does not inherit image support the model does not have", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [AMENDED] }] });
    const amended = await deps.resolveModel(AMENDED.id, "openrouter");

    expect(amended.input).toEqual(["text"]);
  });

  it("still templates a phantom id off a sibling, since it has no entry of its own", async () => {
    // The rule only fires on an id the base catalog carries; everything the
    // #39 and #47 template rules do for a phantom must be unchanged.
    const phantom: ResolvedModel = { ...AMENDED, id: "deepseek/deepseek-v9-not-in-snapshot" };
    const deps = createPiDeps({ providerOverrides: [{ provider: "openrouter", models: [phantom] }] });

    await expect(deps.resolveModel(phantom.id, "openrouter")).resolves.toMatchObject({ id: phantom.id });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`
Expected: the first two FAIL — `expected 1800000 to be 16384` and `expected ["text","image"] to equal ["text"]`. The third passes already.

- [ ] **Step 3: Prefer the model's own entry**

In `src/protocols/pi-client.ts`, replace the first statement of `synthesiseModel` (line 548):

```ts
  const template = pickTemplate(base.getModels(), model.protocol, model.thinkingLevels);
```

with:

```ts
  // An override may amend a model the base catalog already carries — correcting
  // stale pricing is the usual reason, pinning routing (issue #43) the new one.
  // For that id the honest template is that model itself: `pickTemplate` answers
  // "what does a model of this provider on this api look like", which for an id
  // the catalog already has would hand it a size-picked stranger's `maxTokens`
  // and `input`. The api must match too, since `compat` is api-typed and an
  // override is free to re-declare the protocol.
  const own = base.getModels().find((candidate) => candidate.id === model.id && candidate.api === model.protocol);
  const template = own ?? pickTemplate(base.getModels(), model.protocol, model.thinkingLevels);
```

Then update `synthesiseModel`'s docstring (lines 519-546) by inserting, after the paragraph that begins "`ResolvedModel` is deliberately narrower than pi's `Model`":

```ts
 * When the base catalog already carries this id on this api, that entry is the
 * template and none of the selection rules below apply: an amendment inherits
 * from the model it amends.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`
Expected: PASS, including the whole pre-existing `thinkingLevelMap synthesis (issue #47)` and collision suites — those use phantom ids (or a `gpt-4` collision declared on `openai-responses`, which does match `gpt-4`'s real api and whose assertions are all on declared fields), so none of their expectations move.

- [ ] **Step 5: Run the whole suite, typecheck and lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all PASS. If any test outside this file moved, stop and report which one — that would mean a consumer-visible behaviour change this task did not intend.

- [ ] **Step 6: Update the one README sentence this changes**

Task 0's `### Provider overrides` section ends with a sentence about which sibling supplies the fields an override does not state. It is now one clause out of date. In `README.md`, replace:

```markdown
— preferring one that supports your declared thinking levels. State
```

with:

```markdown
— preferring one that supports your declared thinking levels, and preferring this model's own bundled entry when the catalog already carries that id. State
```

- [ ] **Step 7: Commit**

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client-overrides.test.ts README.md
git commit -m "fix: template an amended override model off its own bundled entry (#43)"
```

---

## P3: analysed, not folded

**P3 is the per-request passthrough** — adding `samplingParams?: Readonly<Record<string, unknown>>` to `ProtocolRequest` and forwarding it in `toPiOptions`, so routing and other body fields could vary per call rather than per model entry. Two lines of source. The recommendation is **do not fold it into this plan**, on four findings, all verified at the base commit against the pinned pi-ai:

1. **It can overwrite the request, not just extend it.** `dist/api/openai-completions.js:761-762` applies it as `Object.assign(params, options.samplingParams)`, *last*, over a `params` object whose keys include `model`, `messages`, `stream`, `stream_options`, `tools` and `max_tokens` (`:584-596`). A caller — or a config file feeding one — could silently replace the resolved model id after nax-ai's catalog picked it, after pricing was attached to it, and after auth was resolved from it. Usage and cost would then be attributed to a model that never ran. Every other escape hatch in this package is narrower than that: `ProtocolRequest.headers` is explicitly documented as trusted input, but a header cannot change which model answers.
2. **It is silently inert on half the protocols.** pi applies `samplingParams` in `openai-completions`, `openai-responses` and `azure-openai-responses` only; `anthropic-messages` ignores it. This repo's rule for that shape is to assert, not ignore (Task 3's guard, `assertOverrideModelProvider`, `createClient`'s negative-`transportRetries` precedent) — but a per-request field can only be checked at stream time, once per call, which is a worse failure point than construction for a value that is usually static.
3. **It is the "second, weaker extension mechanism"** `ProviderOverride`'s own docstring warns about, by name: an untyped `Record<string, unknown>` that reaches the wire body is a general-purpose bypass of the registry, and once published every future request-body need has a lazier place to go than a protocol backend.
4. **P2 already covers the motivating case.** The six-arm model-comparison harness that produced issue #43 declares each arm as its own model entry; pinning routing on the entry is what makes an arm reproducible, and a call-site knob would actively undermine that — an arm whose routing can vary per call is not an arm.

**What would flip this.** Fold P3 when something needs a body field to vary *within* one model entry — a local llama.cpp/vLLM/SGLang endpoint where `top_p`, `min_p` or `repetition_penalty` is genuinely per-call is the realistic trigger. When that arrives, **prefer the model-level form first**: pi's `Model.samplingParams` (`types.d.ts:732-733`) is merged with the per-request one at `dist/api/simple-options.js:11-12`, so a `ResolvedModel.samplingParams` follows P2's own pattern exactly — declaration data, checked at construction, no per-call surface. Only if that proves insufficient should `ProtocolRequest` gain the field, and then with (a) a rejected-key list covering `model`, `messages`, `stream` and `tools` so it can extend but not overwrite, and (b) a stream-time throw on a protocol that cannot apply it. Both belong in their own issue with their own evidence, not in this plan.

## Out of scope

- **Surfacing the served endpoint itself.** OpenRouter returns it as a top-level `provider` field on the streamed chunk, and pi discards it — no `dist/api/` file reads it. Closing that gap needs an upstream pi-ai change. `responseId` (Task 1) is the part that needs none, and it resolves to the same answer through OpenRouter's `/generation?id=`.
- **Response identity on the error path.** `ProtocolEvent`'s `error` member carries a `ProtocolError`, not a message identity, and widening it is a separate question from the success path. A billed-but-failed call is a real reconciliation case; file it separately if it bites.
- **Routing on bundled models without an override.** A `ProviderOverride` entry is the only declaration surface. `RawModel` deliberately does **not** gain the field: a hand-built catalog's routing would never reach pi's own catalog, and this repo's rule is not to publish a field that cannot execute.
- **`CompleteOptions`.** It is referenced nowhere in `src/` or `test/` but the re-export at `src/index.ts:108`. The issue body's evidence anchor is a vestigial type; do not add anything to it, and do not delete it in this plan either.
- **Bumping `@earendil-works/pi-ai`.** Pinned at `0.85.1`.

## Self-review

- **Spec coverage.** P1's two halves → Tasks 1 and 2. P2's typed inlet, its construction-time assert and its wire test → Tasks 3 and 4. P3 → the analysis section above, with an explicit recommendation and a named trigger. The comment's "P1 first, ~20 LOC, provider-agnostic" ordering is preserved: Tasks 1-2 touch nothing OpenRouter-specific. Task 0 is outside the issue's scope and is here because the mechanism P2 extends has no consumer documentation at all.
- **Documentation ordering.** Three tasks write into `## Usage`, each at an anchor that does not depend on the others having run: Task 0 after the "While the API is unstable…" paragraph, Task 4 after the section Task 0 adds, Task 2 before `### Constrained sampling`. Task 0 deliberately does not describe Task 5's template rule; Task 5 amends that one sentence itself (its Step 6), so no task documents behaviour that does not yet exist.
- **Placeholders.** None: every step carries the literal code or the literal command, and every test body is written out rather than described.
- **Type consistency.** `OpenRouterRouting` (Task 3) is consumed by name in Task 4's import and by `toPiOpenRouterRouting`. `assertOverrideModelRouting(model: ResolvedModel)` takes one argument at both call sites (`catalog.ts`, `applyOverrides`). `responseId` / `responseModel` are spelled identically in `ProtocolEvent`, `collectStream`, `CompleteResult` and all four tests — they are also pi's own spellings, which is why the mapper can destructure them directly.
- **Anchors.** Verified at `11c9d34`: `test/protocols/pi-client-overrides.test.ts:297-330` (the `wirePayload` helper Task 4 hoists); `src/providers/catalog.ts:110` (the by-reference store that makes Task 3's carry test a type-level regression); `src/types.ts:45-51,53-65`; `src/protocols/types.ts:212`; `src/protocols/collect.ts:22-69`; `src/protocols/pi-client.ts:326-340,547-581,652-701`; `src/providers/types.ts:56-119`; `src/providers/catalog.ts:107-112`; `src/providers/override-model.ts:26-33`; `src/index.ts:98-106`. pi-ai `0.85.1`: `dist/types.d.ts:313-314,496,629-654,716-737`; `dist/api/openai-completions.js:374-377,584-596,745-747,761-762`; `dist/api/simple-options.js:11-12`.
