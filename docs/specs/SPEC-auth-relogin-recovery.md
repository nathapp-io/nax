# SPEC: Auth Re-Login Recovery

Closes: #2528, #2529

## Summary

When a provider rejects the native agent's credential (`fail-auth`), nax today retires the whole native agent for the rest of the run. It logs only the provider's own error text, never says a re-login is needed, and never notices when the user does re-login. This feature makes four changes:

- **Provider scope.** A native `fail-auth` parks only the failing provider, not every native tier. ACP agents and every other failure keep today's cooldown keys.
- **Recovery.** The cooldown records which credential failed. At the start of every agent call, nax re-reads the credential, and if it has changed (a re-login, a new key) the provider is available again. This is logged.
- **Re-login hint.** At the failure, one `warn` names the provider and the command that fixes it (`nax auth login <provider>`). It says when an OAuth login was rejected before its recorded expiry, and it is also given when no fallback is configured. Any hint still relevant at run end is repeated in the end-of-run summary.
- **Honest start lines.** A workflow step's `… start` line names the fallback agent and model when the primary is already unavailable, instead of the primary.

## Motivation

On 2026-10-14 (0.88.0-canary.1, native agent, `openai-codex` OAuth) the provider answered `Your authentication token has expired`. The cause was a ChatGPT plan change that invalidated the login server-side. `nax auth list` still showed an expiry a week away.

- **#2528:** nothing in the run log or summary pointed at `nax auth login openai-codex`, which was the fix.
- **#2529:** `fail-auth` has `cooldown: "run"` (`agents/retry/failure-policy.ts`), and `CooldownStore.sweepTransient` keeps run-long entries at story boundaries. So every later step logged `Primary agent already unavailable — starting on fallback` and skipped native without trying it, even though nax re-reads `~/.nax/credentials` on every request (#2256). A re-login mid-run could never bring native back.
- **Scope:** `fail-auth` has `cooldownScope: "agent"`, so one provider's bad login also blocks native tiers that run on other providers with valid credentials.
- **Start lines:** in the same log, `branch-review start`, `branch-fix start` and `branch-rereview start` named `openai-codex/...` models while each step ran on `claude`.

## Design

### Size and complexity budget

These ratchets constrain the shape of the change, and `check:all` enforces them:

- `packages/nax/src/agents/manager.ts` is at exactly 600 lines, which is the source limit, and it has no `file-sizes-baseline.json` entry. Any net growth fails `check:file-sizes`.
- `complexity-baseline.json` pins three of the functions this feature touches: `runWithFallback` at 52, `completeWithFallback` at 40 and `runCompletionPhase` at 34. A higher score fails `check:complexity`.
- So the logic lives in new modules, and `AgentManager`'s new members are one-line delegations to an `AuthCoordinator` in `auth-cooldown.ts`. The three pinned functions gain only plain calls, with no new `if`, ternary, or `&&` / `||` / `??`. Biome's cognitive complexity does not count `?.` or `await`.
- US-001 first moves `AgentManager.completeAsWithFallback` out of `manager.ts`. That frees the lines the later stories add.

### Integration

Symbols this feature **only reads** (verified on `main` `33be27040`):

- `providerOf(modelId?: string): string | undefined` (`packages/nax/src/agents/cooldown-provider.ts`). It returns the first non-`unknown` path segment that is followed by a model segment, so `openai-codex/gpt-6.1-sol` gives `openai-codex` and `unknown/sonnet` gives `undefined`.
- `servedAuth(providerId): AuthStamp | undefined` and `naxCredentialStore()` (`@nathapp/nax-agent`, exported from its index). `AuthStamp` is `{ fingerprint, source, account? }`.
  - The native client reads `naxCredentialStore()` before each request, so after a `fail-auth` `servedAuth(P)` is the identity that failed. It is `undefined` only when the read itself failed.
  - An OAuth fingerprint is computed from the refresh token, so a re-login changes it.
  - Under `auth.onChange: "refuse"`, a read of a changed credential throws.
- `listStoredProviders(): Promise<StoredEntry[]>` (`@nathapp/nax-agent`). `StoredEntry` is `{ providerId, kind: "api-key" | "oauth", expires?: number }`.
- `DEFAULT_AGENT_NAME = "native"` (`packages/nax/src/config/agent-defaults.ts`).
- `resolveModelForAgent(models, agent, tier, defaultAgent)` (`packages/nax/src/config/schema-types.ts`). It returns a model def with `.model`, and throws when nothing resolves.
- `resolveOpEndpoint(...)` (`packages/nax/src/operations/call-dispatch-prologue.ts`). It returns `{ defaultAgent, effectiveModels, resolved, effectiveTier, sessionRole, target }`.
- `startStep(storyId, label, { model })` (`packages/nax/src/workflow/run-log.ts`). It logs `<label> start` with the `agentName` and `model` the step model function returned.

Symbols this feature **changes**. The baseline only locates the code; it is never the interface to implement.

- `AgentManager.completeAsWithFallback(agentName, prompt, options)` (`packages/nax/src/agents/manager.ts`, about lines 512-566)
  - Baseline: a method body that builds the complete-call preamble, awaits `this.completeWithFallback`, and emits the dispatch event or the dispatch-error event.
  - Target: the body moves unchanged into `completeAsWithFallback(input, agentName, prompt, options)` in a new module, `packages/nax/src/agents/manager-complete-as.ts`. `input` is `{ config, dispatchEvents, completeWithFallback }`. The method stays on `AgentManager` as a one-line delegation with the same signature. This mirrors how `runWithFallback` lives in `manager-run-fallback.ts`.
- `CooldownStore` (`packages/nax/src/agents/cooldown-store.ts`)
  - Baseline: `mark(agent, failure, tier?, modelId?)`. `CooldownEntry` is `{ failure, expiresAt }`.
  - Target: `mark(agent, failure, tier?, modelId?, auth?: AuthCooldownStamp)`, where `AuthCooldownStamp = { providerId: string; fingerprint?: string }` (imported with `import type`). `CooldownEntry` gains `auth?: AuthCooldownStamp`.
    - With `auth`, the entry is keyed `<agent>::provider::<auth.providerId>`. Without it, keying is exactly today's, so the `fail-auth` policy row stays `cooldownScope: "agent"` and ACP agents and every other outcome keep their current keys.
    - `_live`: when the probe names no tier and no model (the narrow key equals the agent), it also returns any live auth-stamped entry of that agent. This keeps today's agent-wide answer for identity-less probes, such as a flat `["native"]` fallback target. A probe that names a tier or model on another provider does not match the stamped entry.
    - Two new methods:
    - `authCooldowns(): readonly { key: string; agent: string; auth: AuthCooldownStamp }[]` lists live entries that carry `auth`.
    - `release(key: string): boolean` deletes one entry and returns whether it existed.
- `AgentManager` (`packages/nax/src/agents/manager.ts`) and `IAgentManager` (`packages/nax/src/agents/manager-types.ts`). Each change is a delegation into the new module `packages/nax/src/agents/auth-cooldown.ts`:
  - **`markUnavailable(agent, reason, tier?, model?, authModel?)`** gains an optional `authModel`, used only to resolve the stamp's provider and never as the cooldown key. It passes `authStampFor(agent, reason, authModel ?? modelId, deps)` as `mark`'s new `auth` argument; the `??` sits in `markUnavailable`, which is not ratcheted. `authStampFor` returns `{ providerId: P, fingerprint: deps.servedAuth(P)?.fingerprint }` for a `fail-auth` on agent `native` whose model id names provider P (by `providerOf`), and `undefined` otherwise.
  - **`refreshAuthCooldowns(): Promise<void>` (new).** It delegates to `refreshAuthCooldowns(store, tracker, deps, logger)`:
    - It checks each `authCooldowns()` entry, and each provider that has a notice but no cooldown (a declined-swap failure). For each, it awaits `deps.readCredential(providerId)` and then reads `deps.servedAuth(providerId)?.fingerprint`.
    - When that is defined and differs from the recorded fingerprint (including when none was recorded), it calls `release(key)`. Only when `release` returns `true` does it log `info` on scope `agent-manager`: `Credential changed for <providerId> — <agent> available again`, with data `{ storyId: "_agent", agent, providerId, previousFingerprint, fingerprint }`. It also drops that provider's notice. A notice with no cooldown is dropped, without that log line, when its recorded fingerprint differs from the current one.
    - A read that throws (logged at `debug`) or an unchanged fingerprint keeps the entry.
  - **`reportAuthFailure(agent, failure: AdapterFailure | undefined, tier?, model?): Promise<void>` (new).** It delegates to `AuthReloginTracker.report(...)`:
    - It returns at once unless `failure?.outcome` is `fail-auth`, the agent is `native`, and the model id (resolved as `markUnavailable` resolves it, through the fallback identity) names provider P.
    - Synchronously, before any `await`, it claims the key `P` plus `deps.servedAuth(P)?.fingerprint`. A key already claimed returns without logging, so concurrent callers log once.
    - It then awaits `deps.listStoredProviders()`, builds the text with `authReloginHint`, and logs it once as a `warn` on scope `agent-manager`, with data `{ storyId: "_agent", agent, providerId, kind?, expires? }`.
    - It stores the notice, with its fingerprint, under P, replacing any earlier notice for P.
  - **`authRelogins(): readonly AuthReloginNotice[]` (new).** It returns the stored notices, one per provider, in first-report order. A provider's notice is removed when `refreshAuthCooldowns` releases that provider.
  - **`reset()`** also clears the tracker's notices and claimed keys.
  - **`_agentManagerDeps`** gains `servedAuth`, `readCredential(providerId): Promise<void>` (defaulting to `naxCredentialStore().read(providerId)`) and `listStoredProviders`. The auth module reaches the credential store only through these, so tests never touch the real `~/.nax`.
  - The three new members are added to `IAgentManager`.
- `runWithFallback(input: RunFallbackInput)` (`packages/nax/src/agents/manager-run-fallback.ts`)
  - Baseline: calls `resolveStartAgent` first. It calls `input.markUnavailable(...)` only on the swap path. `request.noFallback` returns before `decideSwap`, and the `!swap.swap` block (fallback disabled, the hop cap) has its own exits, all before `markUnavailable`.
  - Target: `RunFallbackInput` gains `refreshAuthCooldowns: () => Promise<void>` and `reportAuthFailure: (agent, failure, tier?, model?) => Promise<void>`.
    - `runWithFallback` awaits `input.refreshAuthCooldowns()` before `resolveStartAgent`.
    - It makes one plain call, `await input.reportAuthFailure(currentAgent, result.adapterFailure, currentHopKind.tier, dispatchedModel)`, between the same-agent retry block and the `request.noFallback` check. That single call covers the `noFallback` return, every exit of the `!swap.swap` block, and the swap path. The claimed key dedupes a repeat.
    - Both are plain calls; the `fail-auth` test lives inside `reportAuthFailure`.
    - `AgentManager.runWithFallback` wires both.
- `AgentManager.completeWithFallback`
  - Baseline: starts on `primaryAgent` without an availability probe. Cooldowns only affect it through `nextCandidate` after a failure. On an availability failure it calls `this.markUnavailable(currentAgent, result.adapterFailure, currentTier, undefined)`.
  - Target:
    - It awaits `this.refreshAuthCooldowns()` before its loop, so `nextCandidate` sees released providers.
    - Its `markUnavailable` call keeps `undefined` as the model, so cooldown keys on the complete path are unchanged, and passes `authModelOf(hopOptions.modelDef)` as the new `authModel`. `authModelOf` (in `auth-cooldown.ts`) returns `<provider>/<model>` for a model def, or `undefined`.
    - It makes one plain call, `await this.reportAuthFailure(currentAgent, result.adapterFailure, currentTier, authModelOf(hopOptions.modelDef))`, immediately before its `decideSwap` call. That covers both the declined branch and the swap path.
- `previewOpModel(ctx, op, input)` (`packages/nax/src/operations/op-model-preview.ts`)
  - Baseline: returns `{ agentName: target.agent, model: target.modelDef.model }` from `resolveOpEndpoint`.
  - Target: it destructures `target`, `effectiveTier`, `effectiveModels` and `defaultAgent` from `resolveOpEndpoint`. When `op.kind === "run"` (the only kind whose dispatch probes the start agent), `config.agent.fallback.enabled` is true, and `ctx.runtime.agentManager.isUnavailable(target.agent, effectiveTier, target.modelDef.model)` is true, it takes `candidate = ctx.runtime.agentManager.nextCandidate(target.agent, 0)`:
    - If there is a candidate, the preview is `{ agentName: candidate.agent, model }`. `model` is `candidate.model` when the candidate has a literal pin. Otherwise it is `resolveModelForAgent(effectiveModels, candidate.agent, candidate.tier ?? effectiveTier, defaultAgent).model`.
    - A model that throws while resolving gives `undefined`, through the existing catch.
    - With no candidate, the primary preview is unchanged.
- `RunSummary` (`packages/nax/src/log-format/types.ts`), `RunFooterOptions` (`packages/nax/src/execution/lifecycle/headless-formatter.ts`) and `formatRunSummary` (`packages/nax/src/log-format/summary.ts`)
  - Baseline: no auth field.
  - Target: both gain `authRelogins?: readonly string[]`. `outputRunFooter` copies it into the `RunSummary`. In non-json modes, `formatRunSummary` prints a `Re-login needed:` line after the counts block, followed by one indented line per hint, when the array is non-empty.
- `runCompletionPhase(options)` (`packages/nax/src/execution/runner-completion.ts`)
  - Baseline: calls `outputRunFooter` without auth data.
  - Target: after `finishRun` returns (`finishRun` dispatches agents, so notices can still arrive during it), it calls `reportAuthRelogins(options.agentManager, logger)` from a new module, `packages/nax/src/execution/auth-relogin-report.ts`.
    - That helper reads `agentManager?.authRelogins()` once. It logs each message as a `warn` on scope `execution`, with data `{ storyId: "_run", providerId }`, whatever the formatter mode. It returns the messages.
    - `runCompletionPhase` passes the returned array as `authRelogins` to its existing `outputRunFooter` call.

### New modules

`packages/nax/src/agents/auth-relogin.ts` holds the pure hint text and the notice type:

```ts
export interface AuthReloginNotice {
  readonly providerId: string;
  readonly agent: string;
  readonly message: string;
}

/** `credential` is the stored entry for `providerId`, or undefined when none is stored (env var, exec helper). */
export function authReloginHint(providerId: string, credential: StoredEntry | undefined, now: number): string {
  if (credential?.kind === "oauth" && credential.expires !== undefined && credential.expires > now)
    return `Login for ${providerId} was rejected before its recorded expiry (expires ${new Date(credential.expires).toISOString()}). Run: nax auth login ${providerId}`;
  if (credential?.kind === "oauth") return `Login for ${providerId} was rejected. Run: nax auth login ${providerId}`;
  if (credential?.kind === "api-key")
    return `API key for ${providerId} was rejected. Check or replace it: nax auth login ${providerId} (or nax auth import)`;
  return `Credentials for ${providerId} were rejected. Check where they come from with: nax auth list`;
}
```

`packages/nax/src/agents/auth-cooldown.ts` holds `authStampFor`, `authModelOf`, `refreshAuthCooldowns`, the `AuthReloginTracker` class (claimed keys, notices by provider with their fingerprints, `report`, `notices`, `drop(providerId)`, `clear`), and an `AuthCoordinator` that owns the tracker and binds the store and deps. `AgentManager` holds one `AuthCoordinator`, and its `refreshAuthCooldowns`, `reportAuthFailure` and `authRelogins` are one-line delegations to it. It never imports `manager.ts`; deps are passed in.

### Order of the checks

At the start of every agent call (`runWithFallback` or `completeWithFallback`):

1. `refreshAuthCooldowns` releases any `fail-auth` provider whose credential changed.
2. Start selection (`resolveStartAgent`) and `nextCandidate` then see the updated store.
3. After a hop fails with `fail-auth`, `markUnavailable` records the cooldown with its fingerprint (swap path only).
4. `reportAuthFailure` builds the hint from one call placed before the swap decision, so it runs whether or not the swap happens.

### Failure Handling

| Condition | Behaviour |
|---|---|
| Credential read throws during `refreshAuthCooldowns` (exec helper failure, or a refused change under `onChange: "refuse"`) | Entry kept; one `debug` line; no throw |
| Current fingerprint equals the recorded one | Entry kept; nothing logged |
| No fingerprint was recorded, and a credential now resolves | Entry released, and the `available again` line is logged |
| Two `refreshAuthCooldowns` calls release the same entry concurrently | Only the call whose `release` returned `true` logs |
| Two `reportAuthFailure` calls for the same provider and fingerprint run concurrently | One `warn` |
| `listStoredProviders` throws in `reportAuthFailure` | The hint is built with no stored entry (the `nax auth list` wording); still one `warn` |
| `fail-auth` on a non-native agent, or with no provider in the model id | Today's cooldown and key; no fingerprint, no hint; never released by refresh |
| `fail-auth` whose swap is declined (no fallback, hop cap) | Hint logged and kept as a notice; no cooldown, as today. A later credential change drops the notice. |
| Released provider fails again | A new cooldown with the new fingerprint; the claimed key differs, so the hint is logged again and replaces the notice |

Known trade-offs, accepted:

- An OAuth refresh-token rotation (`renewed` in the change guard) changes the fingerprint without a re-login. Refresh then releases the provider, which costs one more failing call, after which the cooldown and hint return.
- Under `onChange: "refuse"`, a replaced credential is refused on read, so recovery never happens in that run. The hint still names `nax auth login`.

## Out of Scope

- Recovering an ACP agent (`claude`, `codex`, ...) after `fail-auth`; nax does not manage those credentials.
- Retrying a `fail-auth` within the same agent call; the swap still happens immediately.
- Refreshing an OAuth token earlier than its stored expiry.
- Re-checking credentials on a timer; the check runs only at the start of an agent call.
- Changing `nax auth list` output.
- A `fail-auth` hint in the TUI, other than through the log; the footer is printed in headless mode.
- Recording a cooldown when a `fail-auth` swap is declined; only the hint is new on that path.
- US-004 only: a credential that changes between a step's start line and its dispatch; the start line may name the fallback, and the `available again` line follows.
- US-004 only: start lines of pipeline-mode stages; pipeline mode is frozen.
- US-004 only: complete-kind ops, whose dispatch never skips an unavailable primary at start.

## Stories

### US-001 — Move `completeAsWithFallback` out of the agent manager

Workdir: `packages/nax`

No dependencies.

Refactor only, no behaviour change. Move the body of `AgentManager.completeAsWithFallback` into `completeAsWithFallback(input, agentName, prompt, options)` in `manager-complete-as.ts`, leaving a one-line delegation. This frees the line budget in `manager.ts` (at its 600-line limit) for US-002 and US-003.

Verification note: `bun run typecheck` and `bun run check:all` in `packages/nax` pass. `check:file-sizes` reports `manager.ts` below 600 lines, and the existing `completeAs` tests (for example `manager-complete.test.ts`) pass unchanged.

### US-002 — Provider-scoped fail-auth that recovers when the credential changes

Workdir: `packages/nax`

Depends on US-001.

Add the `auth` stamp (provider-keyed only when stamped), the identity-less probe rule, `authCooldowns` and `release` to `CooldownStore`. Create `auth-cooldown.ts` with `authStampFor` and `refreshAuthCooldowns` (the tracker's `drop` can be a stub until US-003). Add the three `_agentManagerDeps` members, the `markUnavailable` stamp, and `refreshAuthCooldowns` on `AgentManager` and `IAgentManager`. Call it at the start of `runWithFallback` and `completeWithFallback`, and pass `authModelOf(hopOptions.modelDef)` as the complete path's `authModel`.

Verification note: `check:file-sizes` keeps `src/agents/manager.ts` at or below 600 lines, and `check:complexity` passes with the `runWithFallback` and `completeWithFallback` baselines unchanged.

### US-003 — Re-login hints at the failure and at run end

Workdir: `packages/nax`

Depends on US-002.

Create `auth-relogin.ts` with `authReloginHint` and `AuthReloginNotice`. Add `AuthReloginTracker` to `auth-cooldown.ts`, and add `reportAuthFailure` and `authRelogins` to `AgentManager` and `IAgentManager`, with `reset()` clearing the tracker. Make the one `reportAuthFailure` call in `runWithFallback` (before the `noFallback` check) and in `completeWithFallback` (before `decideSwap`). Create `auth-relogin-report.ts`, call it in `runCompletionPhase` after `finishRun`, and print the footer block.

Verification note: `check:file-sizes` keeps `src/agents/manager.ts` at or below 600 lines and `src/execution/runner-completion.ts` at or below 600, and `check:complexity` passes with all three pinned baselines unchanged.

### US-004 — Workflow start lines name the fallback when the primary is unavailable

Workdir: `packages/nax`

No dependencies.

`previewOpModel` names the first fallback candidate and its model, for a run-kind op whose primary endpoint is already unavailable when fallback is enabled.

Story split rationale: US-001 is the refactor that frees the size budget, and the must-split rule keeps it apart from the features. US-002 is the cooldown mechanism. US-003 is the operator-facing hints, which need US-002's provider stamp. US-004 is an independent log-label fix. Every story is in `packages/nax` and under the 24-assertion `maxAcCount`.

### Context Files

**US-001**
- `packages/nax/src/agents/manager.ts`
- `packages/nax/src/agents/manager-run-fallback.ts` — precedent for a manager loop in its own module
- `packages/nax/test/unit/agents/manager-complete.test.ts`

**US-002**
- `packages/nax/src/agents/retry/failure-policy.ts`
- `packages/nax/src/agents/cooldown-store.ts`
- `packages/nax/src/agents/manager.ts`
- `packages/nax/src/agents/manager-run-fallback.ts`
- `packages/nax/test/unit/agents/fallback-model-targets.test.ts`

**US-003**
- `packages/nax/src/agents/auth-cooldown.ts` — created by US-002, extended here
- `packages/nax/src/agents/manager-run-fallback.ts`
- `packages/nax/src/execution/runner-completion.ts`
- `packages/nax/src/log-format/summary.ts`
- `packages/nax/src/cli/auth-list.ts`

**US-004**
- `packages/nax/src/operations/op-model-preview.ts`
- `packages/nax/src/operations/call-dispatch-prologue.ts`
- `packages/nax/test/unit/operations/op-model-preview.test.ts`
- `packages/nax/test/helpers/mock-agent-manager.ts` — hard-codes `isUnavailable: () => false` and `nextCandidate: () => null`; the new tests override both

### Creates

**US-001**
- `packages/nax/src/agents/manager-complete-as.ts` — `completeAsWithFallback(input, agentName, prompt, options)`

**US-002**
- `packages/nax/src/agents/auth-cooldown.ts` — `authStampFor`, `refreshAuthCooldowns`, `AuthCooldownStamp`
- `packages/nax/test/unit/agents/auth-cooldown-refresh.test.ts`

**US-003**
- `packages/nax/src/agents/auth-relogin.ts` — `authReloginHint` and `AuthReloginNotice`
- `packages/nax/src/execution/auth-relogin-report.ts` — `reportAuthRelogins`
- `packages/nax/test/unit/agents/auth-relogin.test.ts`
- `packages/nax/test/unit/execution/runner-completion-auth-relogin.test.ts`

**US-004**
- `packages/nax/test/unit/operations/op-model-preview-fallback.test.ts`

### Modifies

**US-001**
None. The move keeps `completeAsWithFallback`'s signature on `AgentManager`, so no test changes.

**US-002**
- `packages/nax/test/helpers/mock-agent-manager.ts` — the mock implements `IAgentManager`, which gains `refreshAuthCooldowns`. The replacing invariant is a mock whose `refreshAuthCooldowns` resolves without doing anything.
- `packages/nax/test/helpers/fake-agent-manager.ts` — the fake implements `IAgentManager`, which gains `refreshAuthCooldowns`. The replacing invariant is a fake whose `refreshAuthCooldowns` resolves without doing anything.

**US-003**
- `packages/nax/test/helpers/mock-agent-manager.ts` — `IAgentManager` gains `reportAuthFailure` and `authRelogins`. The replacing invariant is a mock whose `reportAuthFailure` resolves without doing anything and whose `authRelogins` returns an empty array.
- `packages/nax/test/helpers/fake-agent-manager.ts` — `IAgentManager` gains `reportAuthFailure` and `authRelogins`. The replacing invariant is a fake whose `reportAuthFailure` resolves without doing anything and whose `authRelogins` returns an empty array.

**US-004**
None. `previewOpModel`'s existing cases run with every agent available, so their expected previews are unchanged.

### Seams

- US-001 to US-003: `completeAsWithFallback` keeps its `AgentManager` signature, so callers are unchanged.
- US-002: `AgentManager.refreshAuthCooldowns` is consumed by `runWithFallback` and `completeWithFallback`, both in US-002. Its seam ACs trigger `AgentManager.runWithFallback` and `AgentManager.completeWithFallback`, the agents subsystem's public entry points.
- US-003: `reportAuthFailure` is consumed by both fallback loops, and `authRelogins` by `runCompletionPhase` through `reportAuthRelogins`. The seam ACs trigger `AgentManager.runWithFallback` with a hop that fails `fail-auth` (swap allowed, and swap declined), and `runCompletionPhase` with an agent manager whose `authRelogins` returns a notice.

## Acceptance Criteria

### US-001

1. [unit] `completeAsWithFallback` imported from `@/agents/manager-complete-as`, called with an input whose `completeWithFallback` stub resolves an outcome with output `ok`, returns that outcome.
2. [unit] That call invokes the input's `dispatchEvents.emitDispatch` exactly once.
3. [unit] When the input's `completeWithFallback` stub rejects with a `NaxError`, `completeAsWithFallback` rejects with that same error and invokes `dispatchEvents.emitDispatchError` exactly once.

Verification note: `bun run typecheck` and `bun run check:all` in `packages/nax` pass. `check:file-sizes` reports `src/agents/manager.ts` at or below 565 lines, and the existing `completeAs` and `completeAsWithFallback` tests pass unchanged.

### US-002

1. [unit] `failurePolicyFor("fail-auth").cooldownScope` is still `"agent"`.
2. [unit] On an `AgentManager` whose `native` tiers `balanced` and `fast` resolve to `openai-codex/...` and `minimax/...` models, `markUnavailable("native", <fail-auth>, "balanced")` makes `isUnavailable("native", "balanced")` true.
3. [unit] After that call, `isUnavailable("native", "fast")` is false.
4. [unit] `markUnavailable("claude", <fail-auth>, "fast", "claude-sonnet-4-6")` on a manager with no `claude` models config still makes `isUnavailable("claude", "balanced")` true.
5. [unit] A `fail-auth` cooldown marked for `native` on `openai-codex` survives `resetTransientUnavailable()`.
6. [unit] After that `fail-auth` on `native`, `isUnavailable("native")`, a probe with no tier and no model, is true.
7. [unit] After that `fail-auth`, on a manager whose fallback map for `claude` is the flat list `["native"]`, `nextCandidate("claude", 0, "claude")` returns `null`.
8. [unit] With `_agentManagerDeps.servedAuth` stubbed to return fingerprint `aaa` for `openai-codex`, `markUnavailable("native", <fail-auth>, "balanced")` leaves an `authCooldowns()` entry whose `auth` is `{ providerId: "openai-codex", fingerprint: "aaa" }`.
9. [unit] `markUnavailable("native", <fail-rate-limit>, "balanced")` leaves no `authCooldowns()` entry.
10. [unit] `markUnavailable("claude", <fail-auth>)` leaves no `authCooldowns()` entry.
11. [unit] `refreshAuthCooldowns()`, after `_agentManagerDeps.readCredential` resolves and `servedAuth` now returns fingerprint `bbb`, makes `isUnavailable("native", "balanced")` false.
12. [unit] That refresh logs one `info` entry on scope `agent-manager` with message `Credential changed for openai-codex — native available again` and data `previousFingerprint` `aaa` and `fingerprint` `bbb`.
13. [unit] Two `refreshAuthCooldowns()` calls started together, in that changed-fingerprint state, log the `available again` line once in total.
14. [unit] `refreshAuthCooldowns()` while `servedAuth` still returns `aaa` keeps `isUnavailable("native", "balanced")` true and logs no `info` entry.
15. [unit] `refreshAuthCooldowns()` when `_agentManagerDeps.readCredential` rejects keeps `isUnavailable("native", "balanced")` true and resolves without throwing.
16. [unit] A `fail-auth` marked while `servedAuth` returned `undefined` for `openai-codex` is released by `refreshAuthCooldowns()` once `servedAuth` returns any fingerprint.
17. [unit] `refreshAuthCooldowns()` never calls `_agentManagerDeps.readCredential` for an agent-wide `claude` `fail-auth` entry.
18. [integration] `AgentManager.runWithFallback`, on a request for agent `native` at tier `balanced` (fallback enabled, `claude` in the fallback map), after a `fail-auth` on `native` and a fingerprint change from `aaa` to `bbb`, dispatches its first hop to `native`.
19. [integration] `AgentManager.runWithFallback` under the same setup, with the fingerprint unchanged, dispatches its first hop to `claude` and logs `Primary agent already unavailable — starting on fallback`.
20. [integration] `AgentManager.completeWithFallback`, with primary `claude` and `{ agent: "native", tier: "balanced" }` in its fallback map, after `native` was cooled by a `fail-auth` with fingerprint `aaa` that has since changed to `bbb`, swaps to `native` when `claude` fails with `fail-rate-limit`.
21. [integration] `AgentManager.completeWithFallback`, when its first hop on `native` with model def `{ provider: "openai-codex", model: "gpt-6.1-sol" }` returns `fail-auth`, leaves an `authCooldowns()` entry with `providerId` `openai-codex`.
22. [integration] `AgentManager.completeWithFallback`, when a `claude` hop with model def `{ provider: "anthropic", model: "claude-sonnet-4-6" }` throws an auth error, makes `isUnavailable("claude")` true.

### US-003

1. [unit] `authReloginHint("openai-codex", { providerId: "openai-codex", kind: "oauth", expires: <now + 1 day> }, <now>)` returns `Login for openai-codex was rejected before its recorded expiry (expires <that ISO time>). Run: nax auth login openai-codex`.
2. [unit] `authReloginHint` with an `oauth` entry whose `expires` is at or before `now` returns `Login for openai-codex was rejected. Run: nax auth login openai-codex`.
3. [unit] `authReloginHint` with an `oauth` entry that has no `expires` returns the same `Login for openai-codex was rejected. Run: nax auth login openai-codex` text.
4. [unit] `authReloginHint` with an `api-key` entry returns `API key for openai-codex was rejected. Check or replace it: nax auth login openai-codex (or nax auth import)`.
5. [unit] `authReloginHint` with no entry returns `Credentials for openai-codex were rejected. Check where they come from with: nax auth list`.
6. [unit] `reportAuthFailure("native", <fail-auth>, "balanced")` for an `openai-codex` tier, with `_agentManagerDeps.listStoredProviders` stubbed to return a future-dated `oauth` entry for `openai-codex`, logs one `warn` on scope `agent-manager` whose message is the `before its recorded expiry` hint.
7. [unit] Two `reportAuthFailure` calls for the same provider and fingerprint, started together, log one `warn` in total.
8. [unit] `reportAuthFailure` when the `listStoredProviders` stub rejects logs one `warn` with the `Check where they come from with: nax auth list` hint.
9. [unit] `reportAuthFailure("native", <fail-rate-limit>, "balanced")` logs nothing and records no notice.
10. [unit] `reportAuthFailure("claude", <fail-auth>, "fast")` logs nothing and records no notice.
11. [unit] `authRelogins()` after one reported `openai-codex` failure returns one notice with `providerId` `openai-codex`, `agent` `native` and the hint as `message`.
12. [unit] After a second report for `openai-codex` with a different fingerprint, `authRelogins()` returns one notice for `openai-codex`, whose `message` is the second report's hint.
13. [unit] `authRelogins()` after `refreshAuthCooldowns()` releases `openai-codex` returns an empty array.
14. [unit] `authRelogins()` after `reset()` returns an empty array.
15. [integration] `AgentManager.runWithFallback`, on a `native` request whose first hop returns a `fail-auth` adapter failure for an `openai-codex` model, logs the re-login `warn` before the swap to the fallback agent dispatches.
16. [integration] `AgentManager.runWithFallback`, on the same request with `agent.fallback.enabled` false, logs the re-login `warn`.
17. [integration] `AgentManager.runWithFallback`, on the same request with `noFallback: true`, logs the re-login `warn`.
18. [integration] `AgentManager.completeWithFallback`, on a `native` first hop returning `fail-auth` for an `openai-codex` model def with fallback disabled, logs the re-login `warn`.
19. [unit] A notice recorded on a declined swap, with no cooldown, is gone from `authRelogins()` after `refreshAuthCooldowns()` sees a changed fingerprint for that provider.
20. [integration] `runCompletionPhase`, in headless `normal` mode with an agent manager whose `authRelogins()` returns one notice, prints run-footer output containing `Re-login needed:` followed by that notice's message.
21. [integration] That `runCompletionPhase` call logs one `warn` on scope `execution` whose message is the notice's message and whose data carries `providerId`.
22. [integration] `runCompletionPhase`, with an agent manager whose `authRelogins()` returns an empty array, prints no `Re-login needed:` line.
23. [unit] `formatRunSummary` in `normal` mode with `authRelogins: ["Login for openai-codex was rejected. Run: nax auth login openai-codex"]` returns text in which a `Re-login needed:` line is followed by a line containing that hint.

### US-004

1. [unit] `previewOpModel` for a run-kind op whose endpoint is `native` at tier `balanced`, with fallback enabled, `agentManager.isUnavailable` returning true for that endpoint, and `nextCandidate` returning `{ agent: "claude", tier: "balanced" }`, returns `agentName` `claude` and the model that `models.claude.balanced` resolves to.
2. [unit] The same preview with `nextCandidate` returning `{ agent: "claude", model: "opus" }` (a literal pin) returns `agentName` `claude` and model `opus`.
3. [unit] The same preview with `agent.fallback.enabled` false returns the primary endpoint's `agentName` and model.
4. [unit] The same preview with `nextCandidate` returning `null` returns the primary endpoint's `agentName` and model.
5. [unit] The same preview, when the candidate's tier resolves no model for that agent and the candidate has no pin, returns `undefined`.
6. [unit] When `isUnavailable` returns false, `previewOpModel` never calls `nextCandidate`.
7. [unit] For a complete-kind op with an unavailable primary and fallback enabled, `previewOpModel` returns the primary endpoint's `agentName` and model and never calls `nextCandidate`.
