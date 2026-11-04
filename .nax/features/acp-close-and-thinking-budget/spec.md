# SPEC: acp-close-and-thinking-budget — bounded ACP probe teardown on chat exit, and per-level thinking budgets for catalog overrides

Closes: #2782, #2770

## Summary

A bundle of two independent fixes, shipped as one run at the user's request.

**A. ACP probe teardown (#2782).** `nax chat` warms every installed ACP agent with no saved offers by opening a short probe session. `AcpCatalog.close()` today only sets a flag: it neither cancels nor awaits the in-flight probes, nor awaits the pending offer save. Since #2781 the chat command exits explicitly after teardown, so quitting while a probe is still initializing exits before the probe's `session.close()` runs and the agent's process group is never signalled. This bundle gives `createAgentSession` (nax-agent) an `openSignal` option that aborts an open in progress, threads one catalog-owned signal through every probe, and makes `AcpCatalog.close()` async: it aborts the probes, then awaits them and the pending save for at most `ACP_CATALOG_CLOSE_BOUND_MS` (2000 ms). The chat host awaits it during teardown.

**B. Per-level thinking budgets (#2770).** A `catalogOverrides` model can declare `thinkingLevels` and `thinkingFormat`, but nothing caps how many tokens a level may spend. On local OpenAI-compatible servers (the reported case: Strata serving Qwen) the effort level is only a hint, so `low`, `medium` and `high` all spend about 9,000 thinking tokens. The server honours a top-level request field (`reasoning_budget_tokens` on Strata). pi-ai 1.4.0 already implements this on `openai-completions`: `compat.thinkingTokenBudgetField` names the request field and `SimpleStreamOptions.thinkingBudgets` supplies the per-level values. This bundle lets an override declare `thinkingBudgetField` and `thinkingBudgets`, and carries them from the nax config through nax-agent and nax-ai into pi-ai.

## Motivation

- #2782: quitting `nax chat` during a probe can orphan whatever an ACP agent spawned; before #2781 the pending probe kept the event loop alive for up to 20 s after the exit summary (a candidate for the Ubuntu "ctrl-c needs a second press" report that #2781 backstops with an explicit exit). An in-progress `saveOffers` write can be cut off, leaving a stray `acp-offers.json.<uuid>.tmp`.
- #2770: lowering `maxTokens` is not a substitute, because it bounds thinking and answer together, and a tight cap truncates the answer or tool call (`max_tokens` 1000 ended `length` with no answer). A per-level budget lets a profile give an implementer `model[low]` a tight budget and planning a larger one, per role, instead of one server-wide cap.

## Design

### Part A — ACP probe teardown

**nax-agent: `CreateAgentSessionOptions.openSignal`.** A new optional `openSignal?: AbortSignal`. It bounds the open only. It is honoured by both `createAgentSession` and `resumeAgentSession`, which share `resolveAgentSessionOptions`, `open` and `assemble`:

- Already aborted when `createAgentSession` or `resumeAgentSession` is called → reject with `AgentSessionError` code `AGENT_SESSION_CLOSED` right after option validation: before the transcript store is read (`transcriptStore.load`), before any session root is created, and before `backend.open` is invoked.
- Aborted while `backend.open` is pending → abort the session's own `closeController` (the signal the backend receives as `BackendOpenContext.openSignal`). The ACP backend already rejects with `AGENT_SESSION_CLOSED` and kills the agent's process group when its open signal aborts (`packages/nax-agent-acp/src/client/open.ts`: `openAcpSession` calls `launched.kill()` on any failure after spawn). A backend that resolves anyway is closed (`opened.close()`), and `createAgentSession` rejects with `AGENT_SESSION_CLOSED`.
- Aborted after the entry check but before `backend.open` is called (while the store read or the `sessionRoot` workdir check is pending) → `assemble` checks `openSignal.aborted` immediately before calling `backend.open`; if it is aborted, it rejects with `AGENT_SESSION_CLOSED` without invoking `backend.open` (the session root is cleaned up as on any failed open). Only then is the abort listener attached, so no abort can fall between the check and the listener.
- Aborted after `createAgentSession` has resolved → no effect. The listener is removed once `backend.open` settles, so a later abort never reaches the backend's `openSignal` (the ACP backend keeps that signal for reconnects).
- Keep `assemble` under the cognitive-complexity ratchet (`packages/repo-tooling/scripts/check-complexity.ts`, strict limit 20) by putting the link in a small helper (for example `linkOpenSignal(signal, controller)` returning an unlink function).
- Validated in `OptionsSchema` (a strict object) as an `AbortSignal` instance; anything else is `AGENT_SESSION_INVALID_OPTIONS` with `path: "openSignal"`.

**nax: probe and catalog.**

- `probeAcpAgent(input)` gains `signal?: AbortSignal` and passes it to `createAgentSession` as `openSignal`, only when given (conditional spread, so a call without a signal produces the same options object as today).
- `createAcpCatalog` owns one `AbortController`. Every `probeAgent` call (from `warm` and from `refresh`) passes its signal to `_acpCatalogDeps.probeAcpAgent`.
- `AcpCatalog.close(): Promise<void>` (was `void`). First call: set `closed`, abort the controller, then await every in-flight probe and the pending `saving` chain (settled, never rejected) raced against a bound. The bound is the new input `closeBoundMs?: number`, default the exported constant `ACP_CATALOG_CLOSE_BOUND_MS = 2000`, which is also re-exported from the `packages/nax/src/chat/acp/index.ts` barrel beside `createAcpCatalog`. When the bound wins, `logger.debug("chat", "ACP catalog closed with probes still pending", { agents })` names the agents whose probes had not settled (an empty array when only the offer save was still pending); close still resolves. Put the race in a small helper (for example `settleWithin(boundMs, work, onTimeout)`) so `createAcpCatalog` stays under the cognitive-complexity ratchet. The bound uses `setTimeout` (permitted by `.nax/rules/forbidden-patterns-source.md` because the handle is cancelled mid-flight; say so in a call-site comment) and is cleared with `clearTimeout` when the wait finishes first, so it never holds the process open. Later calls return the same promise. `close()` never rejects.
- Late outcomes stay dropped exactly as today (`if (!closed)` guards in `probeAgent`).

**nax: chat host.** `NativeChatHost.teardown()` replaces its first statement `this.deps.acp?.close();` with `await this.deps.acp?.close();`, so the bounded catalog close (at most 2 s, normally immediate because aborted probes settle at once) finishes before the rest of teardown, and `host.close()` resolves only after it. `packages/nax/src/chat/chat-host.ts` is at 596 of the 600-line source cap (`packages/repo-tooling/scripts/check-file-sizes.ts`): keep its net growth at 3 lines or fewer (the gate counts `split("\n").length`, 597 today); the one-word change above adds none.

`packages/nax/src/cli/chat.ts` needs no change: it already awaits `host.close()` before its explicit exit.

### Part B — per-level thinking budgets

**Config shape (nax and nax-agent `CatalogModelOverride`):**

```json
{
  "provider": "strata",
  "baseUrl": "http://192.168.1.175:8080/v1",
  "allowInsecureHttp": true,
  "models": [
    {
      "id": "qwen3.8-flash",
      "protocol": "openai-completions",
      "contextWindow": 131072,
      "maxTokens": 32768,
      "supportsTools": true,
      "thinkingFormat": "openrouter",
      "thinkingLevels": ["off", "low", "medium", "high"],
      "thinkingBudgetField": "reasoning_budget_tokens",
      "thinkingBudgets": { "low": 2048, "medium": 6144, "high": 16384 },
      "pricing": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    }
  ]
}
```

- `thinkingBudgetField?: string` — the top-level request field the endpoint reads. Lowercase snake_case: `^[a-z][a-z0-9_]{0,63}$`. Any name is accepted (user ruling 11-04), since servers differ (vLLM `thinking_token_budget`, Qwen/SGLang `thinking_budget`, llama.cpp `thinking_budget_tokens`, Strata `reasoning_budget_tokens`). nax-ai rejects names that collide with fields it already sends (the reserved list below).
- `thinkingBudgets?: { minimal?, low?, medium?, high? }` — positive integer token budgets. Keys are pi-ai's `ThinkingBudgets` levels. A request at `xhigh` or `max` uses the `high` budget (pi-ai `clampReasoning`). A level with no declared budget uses pi-ai's default (`minimal` 1024, `low` 2048, `medium` 8192, `high` 16384). Each declared key must be one of the model's `thinkingLevels`, except that `high` is also accepted when `thinkingLevels` contains `xhigh` or `max` (those levels spend the `high` budget). A non-empty object.
- `thinkingBudgets` requires `thinkingBudgetField`. A field with no budgets is valid and sends pi-ai's default budgets.
- Both are `openai-completions` only, like `thinkingFormat`.
- At `off`, or with no requested thinking level, no budget field is sent (pi-ai sends a budget only when a reasoning level is requested).
- pi-ai clamps the budget so at least 1024 answer tokens remain under the request's ceiling (`max_tokens` ?? `max_completion_tokens` ?? the model's `maxTokens`, where pi-ai fills the request field from the context-clamped `maxTokens`): budget sent = min(declared, ceiling − 1024), and nothing is sent when that is not positive. The order is: resolve the level's budget (declared, else pi-ai default), then clamp to the ceiling.

**nax-ai.**

- `ResolvedModel` (`src/providers/types.ts`) gains `thinkingBudgetField?: string` and `thinkingBudgets?: ThinkingBudgets`, where the new exported type `ThinkingBudgets` is `Readonly<{ minimal?: number; low?: number; medium?: number; high?: number }>`, exported from the package index beside `ThinkingFormat`.
- New `assertOverrideModelThinkingBudget(model: ResolvedModel): void` in `src/providers/override-model.ts`, called beside `assertOverrideModelThinkingFormat` at all three existing sites: `src/providers/catalog.ts` (the client catalog), and `applyOverrides`' template loop and `synthesiseIntroducedModel` in `src/protocols/pi-client.ts`. It throws an `Error` naming the model id at the first failing check, in this order:
  1. either field is declared and `protocol` is not `"openai-completions"`;
  2. `thinkingBudgets` is declared without `thinkingBudgetField`;
  3. `thinkingBudgetField` does not match `^[a-z][a-z0-9_]{0,63}$`, or is one of the reserved names `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `reasoning`, `reasoning_effort`, `provider`, `priority`, `store`, `prompt_cache_key`, `prompt_cache_retention`, `chat_template_kwargs`, `chat_template_args`, `enable_thinking`, `thinking`, `tool_stream` (every lowercase field pi-ai 1.4.0's `openai-completions` payload builder writes; its camelCase `providerOptions` is already excluded by the regex);
  4. `thinkingBudgets` is empty, has a key outside `minimal`/`low`/`medium`/`high`, has a key that is not in the model's `thinkingLevels` (the `xhigh`/`max` → `high` exception above applies), or has a value that is not a positive integer.
- Model synthesis (`synthesiseModel` and `synthesiseIntroducedModel`) sets `compat.thinkingTokenBudgetField` to the declared field, merged onto the template's compat the same way `thinkingFormat` is. In `synthesiseModel` the compat block is built today only when `openRouterRouting` or `thinkingFormat` is declared; that condition must also fire when `thinkingBudgetField` is declared, or a budget-only override of a bundled provider silently loses the field. pi-ai's compat type admits only its three literal names, so both paths set it through one shared helper holding the single cast, with a comment citing this spec: pi-ai's `openai-completions` builder writes the field with `Object.assign(params, { [field]: budget })` and does not check the name at runtime.
- `ProtocolRequest` (`src/protocols/types.ts`) gains `thinkingBudgets?: ThinkingBudgets`. `ClientRequest` becomes `Omit<ProtocolRequest, "model" | "thinkingBudgets">`: budgets are the model's declaration, never the caller's. `createClient`'s `streamFrom` sets the protocol request's `thinkingBudgets` from `model.thinkingBudgets` only: when the model declares none, the protocol request has no `thinkingBudgets` property even if an untyped caller spread one into the request.
- `toPiOptions` forwards `req.thinkingBudgets` as `SimpleStreamOptions.thinkingBudgets` when present (a copied object).
- `packages/nax-ai/README.md` documents the two fields beside `thinkingFormat`.

**nax-agent.** `CatalogModelOverride` (`src/config/catalog-overrides.ts`) gains `thinkingBudgetField?: string` and `thinkingBudgets?: CatalogThinkingBudgets`. The new exported interface `CatalogThinkingBudgets` (`minimal?`, `low?`, `medium?`, `high?`: number) is hand-mirrored from nax-ai's `ThinkingBudgets`, because nax-agent's config types cannot import nax-ai (`packages/repo-tooling/scripts/check-nax-ai-imports.ts`). `toProviderOverrides` (`src/native/models.ts`) forwards both with conditional spreads, copying the budgets object rather than aliasing it (the precedent is `headers`).

**nax.** `CatalogModelOverrideSchema` (`src/config/schemas-model.ts`) gains `thinkingBudgetField` (the regex above) and `thinkingBudgets` (a strict object of optional positive integers over `minimal`/`low`/`medium`/`high`, non-empty). A `superRefine` rejects budgets without a field, and a budget key that is not in `thinkingLevels` (with the same `xhigh`/`max` → `high` exception as nax-ai). The reserved-name and protocol checks are nax-ai's (the same split as `thinkingFormat`: nax-ai owns protocol rejection). `FIELD_DESCRIPTIONS` (`src/cli/config-descriptions.ts`) gains entries for both keys. `docs/guides/configuration.md` documents the fields with the Strata example above, next to the existing `thinkingFormat` section.

### Integration

Symbols this feature **changes**. The baseline exists only to locate the code; implement the target.

- `CreateAgentSessionOptions` (`packages/nax-agent/src/session/agent-session-types.ts`)
  - Baseline: no signal option.
  - Target: adds `readonly openSignal?: AbortSignal`.
- `createAgentSession`, `resumeAgentSession`, `assemble` (`packages/nax-agent/src/session/agent-session.ts`): the target rejects a pre-aborted `openSignal` before the store read and links `raw.openSignal` to `closeController` while `raw.backend.open` is pending, as described above.
- `OptionsSchema` (`packages/nax-agent/src/session/agent-session-options.ts`): the target adds `openSignal`.
- `probeAcpAgent` (`packages/nax/src/chat/acp/acp-probe.ts`)
  - Baseline: `probeAcpAgent(input: { agent; cwd })`.
  - Target: `probeAcpAgent(input: { readonly agent: AcpChatAgent; readonly cwd: string; readonly signal?: AbortSignal })`.
- `AcpCatalog.close` (`packages/nax/src/chat/acp/acp-catalog.ts`)
  - Baseline: `close(): void`.
  - Target: `close(): Promise<void>`.
- `createAcpCatalog` input: the target adds `readonly closeBoundMs?: number`.
- `NativeChatHost.teardown` (`packages/nax/src/chat/chat-host.ts`): the target awaits `acp.close()`.
- `ResolvedModel` (`packages/nax-ai/src/providers/types.ts`): the target adds `thinkingBudgetField?` and `thinkingBudgets?`.
- `ProtocolRequest` (`packages/nax-ai/src/protocols/types.ts`): the target adds `thinkingBudgets?`.
- `ClientRequest` (`packages/nax-ai/src/client.ts`): the target is `Omit<ProtocolRequest, "model" | "thinkingBudgets">`.
- `toPiOptions`, `synthesiseModel`, `synthesiseIntroducedModel` (`packages/nax-ai/src/protocols/pi-client.ts`): the target forwards budgets and sets `compat.thinkingTokenBudgetField`.
- `CatalogModelOverride` (`packages/nax-agent/src/config/catalog-overrides.ts`): the target adds both fields.
- `toProviderOverrides` (`packages/nax-agent/src/native/models.ts`): the target forwards both fields.
- `CatalogModelOverrideSchema` (`packages/nax/src/config/schemas-model.ts`): the target adds both fields and the refinements.

Symbols this feature only **reads**:

- `BackendOpenContext.openSignal` (`packages/nax-agent/src/session/session-backend.ts`) — `readonly openSignal: AbortSignal`.
- `openAcpSession` (`packages/nax-agent-acp/src/client/open.ts`) — rejects `AGENT_SESSION_CLOSED` via `closedDuringOpen` and kills the launched agent when `ctx.openSignal` aborts.
- `assertOverrideModelThinkingFormat` (`packages/nax-ai/src/providers/override-model.ts`) — the pattern the new assert mirrors.
- `buildNativeClient` (`packages/nax-agent/src/native/client.ts`) and its nax#2019 wire test in `packages/nax-agent/test/unit/native/client.test.ts` — the pattern for the nax-agent wire AC.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `openSignal` already aborted at `createAgentSession` | Reject `AGENT_SESSION_CLOSED`; `backend.open` not invoked. |
| `openSignal` aborts during `backend.open` and the backend resolves anyway | Close the opened backend; reject `AGENT_SESSION_CLOSED`. |
| `openSignal` already aborted at `resumeAgentSession` | Reject `AGENT_SESSION_CLOSED`; the transcript store is not read. |
| A probe ignores the abort and never settles | `close()` resolves after `closeBoundMs`, with a debug log naming the agents. |
| The offer save rejects during close | Already logged as a warning by `saveOffers`; `close()` resolves. |
| `thinkingBudgets` without `thinkingBudgetField` | nax schema rejects at config load; nax-ai rejects at catalog construction. |
| Reserved or malformed `thinkingBudgetField` | Malformed: nax schema and nax-ai reject. Reserved: nax-ai rejects at catalog construction. |
| Budgets or field on a protocol other than `openai-completions` | nax-ai rejects at catalog construction. |

## Out of Scope

- No change to how the ACP backend reacts to an aborted open signal: `openAcpSession` already kills the agent's process group, and this bundle relies on that path unchanged.
- The leaking Linux handle behind #2781 is not investigated further; this bundle removes the probe as a candidate only.
- No per-request or per-role budget override: a budget is a model declaration. Per-role budgets come from choosing a level (`model[low]`), which already exists.
- No thinking budgets on `anthropic-messages` or any protocol other than `openai-completions`, even though pi-ai reads `thinkingBudgets` on some token-based protocols.
- No change to pi-ai's default budgets or its answer-room clamp (`MIN_ANSWER_TOKENS` 1024).
- No bump of `@earendil-works/pi-ai` (1.5.0 exists; 1.4.0 already implements the budget field).
- The nax config schema does not duplicate nax-ai's reserved-field list or its protocol check; those errors surface when the native client is built.
- No precheck row for thinking budgets.

## Stories

### US-001 — openSignal option on agent session open

Workdir: packages/nax-agent. No dependencies.

Add `openSignal?: AbortSignal` to `CreateAgentSessionOptions` and `OptionsSchema`. In `createAgentSession` and `resumeAgentSession`, reject a pre-aborted signal with `AGENT_SESSION_CLOSED` right after option validation, before the transcript store is read. While `backend.open` is pending (in `assemble`), an abort aborts the session's `closeController`. If the backend resolves after that abort, close it and reject with `AGENT_SESSION_CLOSED`. Remove the listener once `backend.open` settles. Tests that need an invalid option value use a loosely typed options helper, as `agent-session-options.test.ts` does, never `as unknown as` or `as never` (`.nax/rules/test-ratchets.md`).

### US-002 — bounded, abortable ACP catalog close in nax chat

Workdir: packages/nax. Depends on US-001.

- Add `signal?` to `probeAcpAgent`, forwarded as `openSignal` only when given.
- Give `createAcpCatalog` one `AbortController` whose signal every probe receives, and a `closeBoundMs?` input.
- Export `ACP_CATALOG_CLOSE_BOUND_MS = 2000` from `acp-catalog.ts` and from the `packages/nax/src/chat/acp/index.ts` barrel.
- Make `AcpCatalog.close()` async, idempotent and never-rejecting:
  - abort, then await the in-flight probes and the pending save, raced against the bound;
  - the bound is a `setTimeout`, cleared with `clearTimeout` and documented at the call site;
  - when the bound wins, debug-log the agents still pending.
- Make `NativeChatHost.teardown()` await it as its first statement (`await this.deps.acp?.close();`, no net line growth in `chat-host.ts`, which has 3 lines of headroom).
- Update the `AcpCatalog` interface doc comment for `close`.

### US-003 — declare and validate thinking budgets in nax-ai

Workdir: packages/nax-ai. No dependencies.

- Add the exported type `ThinkingBudgets` and the two `ResolvedModel` fields.
- Add `assertOverrideModelThinkingBudget` (with the reserved-name list and the `xhigh`/`max` → `high` key exception), called beside `assertOverrideModelThinkingFormat` at its three existing sites:
  - `src/providers/catalog.ts`;
  - `synthesiseIntroducedModel`;
  - the template loop in `applyOverrides` (reached from `createPiDeps` through `catalogFor`).
- Set `compat.thinkingTokenBudgetField` in both synthesis paths through one shared helper holding the single documented cast to pi-ai's compat type.
- Extend `synthesiseModel`'s compat condition to fire when `thinkingBudgetField` is declared.
- Document both fields in `packages/nax-ai/README.md`.

### US-004 — send thinking budgets on the wire in nax-ai

Workdir: packages/nax-ai. Depends on US-003.

Add `ProtocolRequest.thinkingBudgets` and omit it from `ClientRequest`. Set it in `createClient`'s `streamFrom` from the resolved model only (never from the caller's request), and forward it in `toPiOptions` as `SimpleStreamOptions.thinkingBudgets`.

### US-005 — forward thinking budgets through nax-agent

Workdir: packages/nax-agent. Depends on US-004.

Add `thinkingBudgetField?` and `thinkingBudgets?: CatalogThinkingBudgets` to `CatalogModelOverride`, and export `CatalogThinkingBudgets` (it reaches the `./internal` entry through `src/internal.ts`). Forward both fields from `toProviderOverrides` with conditional spreads, copying the budgets object. Regenerate the API snapshot with `bun run api:update`.

### US-006 — config schema, descriptions and docs for thinking budgets in nax

Workdir: packages/nax. Depends on US-005.

Add `thinkingBudgetField` and `thinkingBudgets` to `CatalogModelOverrideSchema` with the refinements above, add `FIELD_DESCRIPTIONS` entries for both, and document them in `docs/guides/configuration.md` with the Strata example.

### Context Files

**US-001**
- `packages/nax-agent/src/session/agent-session.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/session/agent-session-options.ts`
- `packages/nax-agent/src/session/session-backend.ts`
- `packages/nax-agent/test/unit/session/agent-session-backend.test.ts`

**US-002**
- `packages/nax/src/chat/acp/acp-catalog.ts`
- `packages/nax/src/chat/acp/acp-probe.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/acp/index.ts`
- `packages/nax/test/helpers/timer-spy.ts`

**US-003**
- `packages/nax-ai/src/providers/override-model.ts`
- `packages/nax-ai/src/providers/types.ts`
- `packages/nax-ai/src/providers/catalog.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/test/protocols/pi-client-overrides.test.ts`

**US-004**
- `packages/nax-ai/src/protocols/types.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/src/client.ts`
- `packages/nax-ai/test/protocols/pi-client-custom-provider.test.ts`
- `packages/nax-ai/test/client.test.ts`

**US-005**
- `packages/nax-agent/src/config/catalog-overrides.ts`
- `packages/nax-agent/src/native/models.ts`
- `packages/nax-agent/src/native/client.ts`
- `packages/nax-agent/test/unit/native/client.test.ts`
- `packages/nax-agent/test/unit/native/provider-overrides.test.ts`

**US-006**
- `packages/nax/src/config/schemas-model.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax/test/unit/config/catalog-overrides-schema.test.ts`
- `docs/guides/configuration.md`

### Creates

**US-001**
- `packages/nax-agent/test/unit/session/agent-session-open-signal.test.ts`

**US-002**
- `packages/nax/test/unit/chat/acp/acp-catalog-close.test.ts`

**US-003**
- `packages/nax-ai/test/protocols/override-thinking-budget.test.ts`

**US-004**
- `packages/nax-ai/test/protocols/pi-client-thinking-budget.test.ts`

**US-005**
- `packages/nax-agent/test/unit/native/thinking-budget-overrides.test.ts`

**US-006**
- `packages/nax/test/unit/config/catalog-overrides-thinking-budget.test.ts`

### Modifies

**US-001**

None. `OptionsSchema` gains an optional key; no existing option test passes an `openSignal`, and `nax-agent.api.txt` lists exported names only, none of which change in this story.

**US-002**
- `packages/nax/test/unit/chat/acp/acp-catalog.test.ts` — test "AC-12/19 close drops late %s without waiting" asserts `close()` returns `undefined`; `close()` now returns a promise, so assert instead that it returns a promise, keeping its other assertions (late outcomes dropped, no save, no failure recorded, no second discovery after a later `warm`). The warm test's exact-argument assertion that f.discover was called with agent codex and cwd /r now also receives the catalog signal: change it to also expect a signal property matching any AbortSignal.
- `packages/nax/test/unit/chat/acp/acp-catalog-refresh.test.ts` — the exact-argument assertion that the probe dep was called with agent and cwd /r now also receives the catalog signal: change it to also expect a signal property matching any AbortSignal. No other assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp.test.ts` — `stubCatalog`'s `close: mock(() => {})` no longer satisfies `close(): Promise<void>`; change it to `mock(async () => {})`. Test "probe AC-15 closes the catalog once across repeated host close" keeps its exactly-once assertion.
- `packages/nax/test/unit/chat/chat-host-acp-switch.test.ts` — the `catalog()` stub's `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-acp-models.test.ts` — `stubCatalog`'s `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/chat/acp/acp-host.test.ts` — `stubCatalog`'s `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/chat/chat-host-memory.test.ts` — `acpCatalog()`'s `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/cli/chat.test.ts` — `stubAcpCatalog()`'s `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — the inline catalog stub's `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources-memory.test.ts` — `emptyAcpCatalog()`'s `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.
- `packages/nax/test/unit/cli/chat-resources-memory-degrade.test.ts` — the catalog stub's `close: () => {}` no longer satisfies `close(): Promise<void>`; change it to `async () => {}`. No assertion changes.

**US-003**

None. The new fields are optional and the compat changes apply only when `thinkingBudgetField` is declared, so no existing synthesis assertion changes; the new tests live in a new file.

**US-004**

None. `thinkingBudgets` is set only for a model that declares it, so no existing client or option assertion changes; `ClientRequest`'s only production user (`packages/nax-agent/src/native/stream-complete.ts`) never passes it.

**US-005**
- `packages/nax-agent/api/nax-agent.api.txt` — the ./internal section gains the new exported name type CatalogThinkingBudgets. Regenerate with bun run api:update; the only diff is that one added line.

**US-006**

None. The schema gains optional keys; no existing case declares them.

### Seams

- US-001 → US-002: `CreateAgentSessionOptions.openSignal` is consumed by `probeAcpAgent`. Pinned by US-002's seam AC, which enters at `AcpCatalog.warm` then `close` with the real `probeAcpAgent` and real `createAgentSession`. Stub `launchCandidateKind` to report `codex` installed and `acpBackend` to return a `SessionBackend` whose `open` records its context and rejects when `ctx.openSignal` aborts. Use a real temporary directory and await notification that `backend.open` has recorded its context before calling `close`.
- US-003 → US-004: the synthesised `compat.thinkingTokenBudgetField` and `ResolvedModel.thinkingBudgets` are what the wire path reads. Pinned by US-004's wire ACs through `createClient`.
- US-004 → US-005: `ResolvedModel.thinkingBudgetField` and `thinkingBudgets` are produced by `toProviderOverrides`. Pinned by US-005's `buildNativeClient` wire AC.
- US-005 → US-006: `CatalogModelOverride`'s new fields are the type nax's parsed config feeds to `toProviderOverrides`. Pinned by US-006's parse-then-forward AC.

## Acceptance Criteria

### US-001 — openSignal option on agent session open

1. [unit] `createAgentSession` with a stub backend and an `openSignal` that is never aborted resolves to a session, and the `BackendOpenContext.openSignal` the stub's `open` received is not aborted.
2. [unit] `createAgentSession` with an `openSignal` already aborted rejects with an `AgentSessionError` whose `code` is `"AGENT_SESSION_CLOSED"`.
3. [unit] `createAgentSession` with an `openSignal` already aborted never invokes the stub backend's `open`.
4. [unit] `createAgentSession` with an `openSignal` already aborted never calls `load` on its transcript store.
5. [unit] `resumeAgentSession` for a stored session with an `openSignal` already aborted rejects with an `AgentSessionError` whose `code` is `"AGENT_SESSION_CLOSED"`.
6. [unit] `resumeAgentSession` with an `openSignal` already aborted never calls `load` on its transcript store.
7. [unit] With `_agentSessionDeps.isDirectory` replaced by a stub that stays pending on a deferred, aborting the caller's `openSignal` while that stub is pending and then resolving it `true` makes `createAgentSession` reject with an `AgentSessionError` whose `code` is `"AGENT_SESSION_CLOSED"`.
8. [unit] In that same isDirectory-pending abort scenario, the stub backend's `open` is never invoked.
9. [unit] With a stub backend whose `open` stays pending until its received `ctx.openSignal` aborts and then rejects with a recorded error, aborting the caller's `openSignal` makes `createAgentSession` reject with that recorded error.
10. [unit] With a stub backend whose `open` stays pending, aborting the caller's `openSignal` while `createAgentSession` is pending leaves the `ctx.openSignal` the stub received aborted.
11. [unit] With a stub backend whose `open` ignores its signal and resolves only after the caller's `openSignal` has been aborted, `createAgentSession` rejects with an `AgentSessionError` whose `code` is `"AGENT_SESSION_CLOSED"`.
12. [unit] With a stub backend whose `open` ignores its signal and resolves only after the caller's `openSignal` has been aborted, the `close` of the opened backend the stub resolved with is invoked exactly once.
13. [unit] Aborting the caller's `openSignal` after `createAgentSession` has resolved leaves the `ctx.openSignal` the stub received not aborted.
14. [unit] A turn sent on a session whose `openSignal` was aborted after `createAgentSession` resolved still completes with a `turn-end` event whose status is `"completed"`.
15. [unit] `createAgentSession` with `openSignal: "stop"` rejects with an `AgentSessionError` whose `code` is `"AGENT_SESSION_INVALID_OPTIONS"` and whose context `path` is `"openSignal"`.

### US-002 — bounded, abortable ACP catalog close in nax chat

1. [unit] `probeAcpAgent({ agent: "codex", cwd: "/r", signal })` calls `_acpProbeDeps.createAgentSession` once with options whose `openSignal` is that same `signal`.
2. [unit] `probeAcpAgent({ agent: "codex", cwd: "/r" })` calls `_acpProbeDeps.createAgentSession` with options that have no `openSignal` property.
3. [unit] `ACP_CATALOG_CLOSE_BOUND_MS` is importable from `@/chat/acp` and equals `2000`.
4. [unit] After `warm("/r")` on a catalog whose `_acpCatalogDeps.probeAcpAgent` stub records its input, the recorded `signal` is not aborted before `close()` is called.
5. [unit] After `warm("/r")` on a catalog whose `_acpCatalogDeps.probeAcpAgent` stub records its input, the recorded `signal` is aborted immediately after `close()` is called, before the returned promise is awaited.
6. [unit] A probe started by `refresh("/r")` also receives a `signal`, and that signal is aborted by `close()`.
7. [unit] Calling `close()` twice returns the same promise object both times.
8. [unit] With a probe stub that rejects with an `AGENT_SESSION_CLOSED` error once its `signal` aborts, and `closeBoundMs: 60_000`, `await close()` resolves; the test would time out if close waited for the bound.
9. [unit] With a probe stub (started by `warm("/r")`) that rejects with an `AGENT_SESSION_CLOSED` error once its `signal` aborts, after `await close()` resolves, `unavailable("acp:codex")` is `undefined` and `logger.debug` was not called with the message `"ACP offer probe failed"`.
10. [unit] With a probe stub that ignores its signal and never settles, and `closeBoundMs: 20`, `await close()` resolves.
11. [unit] With a probe stub (started by `warm("/r")`) that ignores its signal and never settles, and `closeBoundMs: 20`, after `await close()` resolves `logger.debug` was called with `"chat"`, `"ACP catalog closed with probes still pending"` and `{ agents: ["codex"] }`.
12. [unit] Run inside `withTimerSpy`, `close()` on a catalog (`closeBoundMs: 60_000`) whose `warm` probe rejects once its signal aborts leaves no armed timer after it resolves: every timer it armed was cleared.
13. [unit] With a probe that has settled and an offer store whose `save` never settles, and `closeBoundMs: 20`, after `await close()` resolves `logger.debug` was called with `"chat"`, `"ACP catalog closed with probes still pending"` and `{ agents: [] }`.
14. [unit] With a probe that resolves `{ offeredModels: ["m1"] }` before `close()` and an offer store whose `save` stays pending on a deferred, `close()` (with `closeBoundMs: 60_000`) has not resolved while the deferred is pending, and resolves after the deferred resolves.
15. [unit] With an offer store whose `save` rejects, a probe that resolves with offered models, and `closeBoundMs: 60_000`, `await close()` resolves rather than rejecting.
16. [integration] Seam: with `_acpCatalogDeps.probeAcpAgent` left as the real `probeAcpAgent`, `_acpProbeDeps.createAgentSession` left as the real `createAgentSession`, `_acpCatalogDeps.launchCandidateKind` reporting `codex` installed, and `_acpProbeDeps.acpBackend` returning a stub `SessionBackend` whose `open` records its `BackendOpenContext` and stays pending until that context's `openSignal` aborts and then rejects, calling `warm("<a real temp directory>")`, waiting for the stub's `open` to record its context, and then `await close()` leaves the recorded `ctx.openSignal` aborted.
17. [unit] A `NativeChatHost` built with a stub catalog whose `close` returns a pending deferred promise has not resolved `host.close()` while the deferred is pending.
18. [unit] A `NativeChatHost` built with a stub catalog whose `close` returns a deferred promise resolves `host.close()` after that deferred resolves.

### US-003 — declare and validate thinking budgets in nax-ai

1. [unit] `createPiDeps` with a provider override of the bundled provider `together` (`baseUrl: "http://127.0.0.1:18080/v1"`) whose `openai-completions` model `local-qwen` declares `thinkingLevels: ["off", "low", "high"]`, `thinkingBudgetField: "reasoning_budget_tokens"`, `thinkingBudgets: { low: 2048 }` and neither `thinkingFormat` nor `openRouterRouting` resolves `resolveModel("local-qwen", "together")` to a pi model whose `compat.thinkingTokenBudgetField` is `"reasoning_budget_tokens"`.
2. [unit] `createPiDeps` with an override introducing the unknown provider `strata` (`baseUrl: "http://127.0.0.1:18080/v1"`) whose `openai-completions` model `qwen3.8-flash` (with `maxTokens: 32768`) declares `thinkingBudgetField: "reasoning_budget_tokens"` resolves `resolveModel("qwen3.8-flash", "strata")` to a pi model whose `compat.thinkingTokenBudgetField` is `"reasoning_budget_tokens"`.
3. [unit] `assertOverrideModelThinkingBudget` on a model with `protocol: "anthropic-messages"` and `thinkingBudgetField: "thinking_budget"` throws an error whose message contains `"openai-completions"`.
4. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingBudgets: { low: 2048 }` and no `thinkingBudgetField` throws an error whose message contains `"thinkingBudgetField"`.
5. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingBudgetField: "max_tokens"` throws an error whose message contains `"max_tokens"`.
6. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingBudgetField: "priority"` throws an error whose message contains `"priority"`.
7. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingBudgetField: "Reasoning-Budget"` throws an error whose message contains `"Reasoning-Budget"`.
8. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingLevels: ["off", "low"]`, a valid `thinkingBudgetField` and `thinkingBudgets: { medium: 6144 }` throws an error whose message contains `"medium"`.
9. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with `thinkingLevels: ["off", "xhigh"]`, `thinkingBudgetField: "thinking_budget"` and `thinkingBudgets: { high: 12000 }` does not throw.
10. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with a valid field and `thinkingBudgets: { low: 0 }` throws.
11. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with a valid field and `thinkingBudgets: { low: 1.5 }` throws.
12. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model with a valid field and `thinkingBudgets: {}` throws.
13. [unit] `assertOverrideModelThinkingBudget` on an `openai-completions` model declaring a valid field and `thinkingBudgets: { low: 2048 }` with `low` in its `thinkingLevels` does not throw.
14. [unit] `createClient` with a provider override whose model declares `thinkingBudgetField: "max_tokens"` throws an error whose message contains `"max_tokens"`.
15. [unit] Constructing `createPiDeps` with an override of the bundled provider `together` whose model declares `thinkingBudgetField: "max_tokens"` throws an error whose message contains `"max_tokens"`.
16. [unit] Constructing `createPiDeps` with an override introducing the unknown provider `strata` (with `baseUrl` and a model with `maxTokens`) whose model declares `thinkingBudgetField: "max_tokens"` throws an error whose message contains `"max_tokens"`.

### US-004 — send thinking budgets on the wire in nax-ai

Every wire AC builds its client with `createClient` using:
- `providers: await defaultProviders()`;
- `protocols: ({ providerOverrides }) => defaultProtocols({ credentials: createMemoryCredentialStore({ strata: { kind: "api-key", key: "k" } }), providerOverrides })`;
- `transportRetries: 0`;
- a provider override introducing `strata` with `baseUrl: "http://127.0.0.1:18080/v1"` and one model `qwen3.8-flash`, unless the AC says otherwise.

The model is: `protocol: "openai-completions"`, `contextWindow: 131072`, `maxTokens: 32768`, `supportsTools: true`, zero `pricing`, `thinkingLevels: ["off", "low", "medium", "high"]`, `thinkingBudgetField: "reasoning_budget_tokens"`, `thinkingBudgets: { low: 2048, medium: 6144 }`.

`globalThis.fetch` is replaced by an interceptor that records the JSON request body and answers 401, and is restored afterwards.

1. [integration] Streaming with `thinking: "low"` records a body whose `reasoning_budget_tokens` is `2048`.
2. [integration] Streaming with `thinking: "medium"` records a body whose `reasoning_budget_tokens` is `6144`.
3. [integration] Streaming with `thinking: "high"` (no declared `high` budget) records a body whose `reasoning_budget_tokens` is `16384`, pi-ai's default.
4. [integration] Streaming with `thinking: "off"` records a body with no `reasoning_budget_tokens` property.
5. [integration] Streaming with no `thinking` records a body with no `reasoning_budget_tokens` property.
6. [integration] With the model's `maxTokens` set to `4096`, `thinkingBudgets: { high: 16384 }` and `thinking: "high"`, the recorded body's `reasoning_budget_tokens` is `3072`.
7. [integration] With the model's `maxTokens` set to `1024` and `thinking: "low"`, the recorded body has no `reasoning_budget_tokens` property.
8. [integration] With `thinkingLevels` including `"xhigh"`, `thinkingBudgets: { high: 12000 }` and `thinking: "xhigh"`, the recorded body's `reasoning_budget_tokens` is `12000`.
9. [integration] With `thinkingBudgetField` declared and no `thinkingBudgets`, streaming with `thinking: "low"` records a body whose `reasoning_budget_tokens` is `2048`.
10. [integration] With the override instead targeting the bundled provider `together` (same `baseUrl` and model, memory credential `together: { kind: "api-key", key: "k" }`), streaming with `thinking: "low"` records a body whose `reasoning_budget_tokens` is `2048`.
11. [unit] `toPiOptions` on a request with `thinkingBudgets: { low: 2048 }` returns options whose `thinkingBudgets` equals `{ low: 2048 }`.
12. [unit] `toPiOptions` on a request without `thinkingBudgets` returns options with no `thinkingBudgets` property.
13. [unit] A client from `createClient` whose registry holds a spy protocol, streaming a model that declares `thinkingBudgets: { low: 2048 }`, passes the spy a `ProtocolRequest` whose `thinkingBudgets` equals `{ low: 2048 }`.
14. [unit] The same client streaming a model without `thinkingBudgets` passes the spy a `ProtocolRequest` with no `thinkingBudgets` property.
15. [unit] The same client streaming a model without `thinkingBudgets`, given a loosely typed request object that carries a stray `thinkingBudgets: { low: 1 }`, passes the spy a `ProtocolRequest` with no `thinkingBudgets` property.

### US-005 — forward thinking budgets through nax-agent

1. [unit] `toProviderOverrides` on an override whose model declares `thinkingBudgetField: "reasoning_budget_tokens"` returns a model whose `thinkingBudgetField` is `"reasoning_budget_tokens"`.
2. [unit] `toProviderOverrides` on a model declaring `thinkingBudgets: { low: 2048 }` returns a model whose `thinkingBudgets` equals `{ low: 2048 }` and is not the same object reference as the input's.
3. [unit] `toProviderOverrides` on a model declaring neither field returns a model object with no `thinkingBudgetField` property and no `thinkingBudgets` property.
4. [integration] With `globalThis.fetch` replaced by an interceptor that records the JSON request body and answers 401 (restored afterwards), streaming `qwen3.8-flash` of provider `strata` with thinking `"low"` through a client from `buildNativeClient([<strata override: baseUrl "http://127.0.0.1:18080/v1", authEnv "STRATA_KEY", one openai-completions model with maxTokens 32768, thinkingLevels ["off", "low", "high"], thinkingBudgetField "reasoning_budget_tokens", thinkingBudgets { low: 2048 }>], { transportRetries: 0 })`, with `STRATA_KEY` set to `"k-wire"` (restored afterwards), records a body whose `reasoning_budget_tokens` is `2048`, following the existing authEnv and nax#2019 wire tests in `client.test.ts`.

### US-006 — config schema, descriptions and docs for thinking budgets in nax

1. [unit] Parsing `agent.native.catalogOverrides` with a valid `openai-completions` model that adds `thinkingBudgetField: "reasoning_budget_tokens"` and `thinkingBudgets: { low: 2048, high: 16384 }` (with `low` and `high` in `thinkingLevels`) succeeds, and the typed output keeps both values.
2. [unit] A model declaring `thinkingBudgets: { low: 2048 }` without `thinkingBudgetField` fails to parse with an error message containing `"thinkingBudgetField"`.
3. [unit] A model declaring `thinkingBudgetField: "Reasoning-Budget"` fails to parse.
4. [unit] A model with `thinkingLevels: ["off", "low"]` declaring `thinkingBudgets: { medium: 6144 }` and a valid field fails to parse with an error message containing `"medium"`.
5. [unit] A model with `thinkingLevels: ["off", "max"]` declaring `thinkingBudgets: { high: 12000 }` and a valid field parses.
6. [unit] A model declaring `thinkingBudgets: { low: 0 }` with a valid field fails to parse.
7. [unit] A model declaring `thinkingBudgets: { low: 1.5 }` with a valid field fails to parse.
8. [unit] A model declaring `thinkingBudgets: { xhigh: 4096 }` with a valid field fails to parse.
9. [unit] A model declaring `thinkingBudgets: {}` with a valid field fails to parse.
10. [unit] A model declaring only `thinkingBudgetField: "thinking_budget"` parses and keeps the field.
11. [integration] The `catalogOverrides` array produced by parsing a config whose `openai-completions` model declares `thinkingLevels` including `low` and `high`, `thinkingBudgetField: "reasoning_budget_tokens"` and `thinkingBudgets: { low: 2048, high: 16384 }`, passed to nax-agent's `toProviderOverrides`, yields a model whose `thinkingBudgetField` is `"reasoning_budget_tokens"` and whose `thinkingBudgets` equals `{ low: 2048, high: 16384 }`.
12. [unit] `FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingBudgetField"]` is a non-empty string.
13. [unit] `FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingBudgets"]` is a non-empty string that mentions `"xhigh"`.
