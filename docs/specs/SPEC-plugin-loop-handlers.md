# SPEC: Plugin loop handlers

## Summary

Let a nax plugin register handlers on the native agent's eight in-process loop events
(`before_tool`, `after_tool`, `before_turn`, `transform_context`, `before_request`,
`after_response`, `before_compaction`, `before_turn_end`). A new plugin extension type,
`loop-handlers`, contributes handlers once per `nax run`; nax installs them on every native
session's per-turn loop-event registry between the built-in handlers, wraps each one so it
receives a read-only session context, cannot hang the turn, and fails safe on `before_tool`,
and names the plugin in every failure it logs. This is the first code-shipping slice of the
native-coding-agent P6 boundary work: the handler types are owned by the coding-agent side, and
native code never imports the plugin system.

## Motivation

The P3 loop-event registry (`src/agents/native/session/loop-events/`) has no external
registration surface. Its only registration call site is `registerBuiltinLoopHandlers`
(`src/agents/native/session/loop-handlers.ts:58`); `SendTurnOpts.loopEvents`
(`src/agents/session-types.ts:135`) is forwarded by the adapter (`src/agents/native/adapter.ts:354`)
but supplied by no caller. `src/hooks/` cannot fill the gap: its events fire around a story,
shell out with a 5s timeout, and cannot return a patch.

So every steering or policy idea that belongs inside the agent loop — a seed note at turn start,
a reshaped tool result, a follow-up at turn end, a project-specific tool guard — must be merged
into nax as a built-in. The R18 spike (2026-09-26) hit exactly this.

There is also a latent ordering trap: `turn-loop.ts:94` does
`deps.loopEvents ?? createLoopEventRegistry()` and then registers the built-ins onto that
registry, so a caller that pre-populated a registry would put its handlers ahead of invalid-call
repair on `before_tool` and ahead of truncation on `after_tool`. External handlers must arrive as
a list whose install position the loop owns.

Design record: `docs/superpowers/specs/2026-09-28-p6-plugin-loop-handlers-design.md`.

## Design

### Integration

This feature changes the following symbols. Baselines are stated only to locate the code; they
are never the interface to implement.

**`PluginType`** — `src/plugins/types.ts:38` (US-001)
- Baseline: `"optimizer" | "router" | "agent" | "reviewer" | "context-provider" | "reporter" | "post-run-action"`
- Target: the same union plus `"loop-handlers"`.

**`PluginExtensions`** — `src/plugins/types.ts:114` (US-001)
- Target: gains `loopHandlers?: ILoopHandlerProvider`.

**`VALID_PLUGIN_TYPES` / `validatePlugin`** — `src/plugins/validator.ts:22-30`, `:105-140` (US-001)
- Target: `"loop-handlers"` is a valid type; when `provides` includes it,
  `extensions.loopHandlers` must be an object whose `register` is a function, validated in a new
  `validateLoopHandlers(pluginName, ext)` beside `validatePostRunAction`.

**`PluginRegistry`** — `src/plugins/registry.ts` (US-001)
- Target: gains `getLoopHandlers(): LoopHandlerSet`, beside `getReporters()` (`:166`).

**`BuiltinLoopHandlerDeps` / `registerBuiltinLoopHandlers`** — `src/agents/native/session/loop-handlers.ts:24-44`, `:58` (US-003)
- Baseline deps: `{ sessionName, budget, spinBreaker?, onSpinStop }`.
- Target deps: the same plus `loopHandlers?: LoopHandlerSet`,
  `loopHandlerContext?: LoopHandlerContext`, `signal?: AbortSignal`. The function installs
  built-in `before_tool` handlers, then each wrapped plugin entry, then built-in truncation.

**`TurnDeps`** — `src/agents/native/session/turn-types.ts:130` (US-003)
- Target: gains `loopHandlers?: LoopHandlerSet` and `loopHandlerContext?: LoopHandlerContext`.

**`SendTurnOpts`** — `src/agents/session-types.ts:131` (US-003)
- Target: gains `loopHandlers?: LoopHandlerSet` and `loopHandlerContext?: LoopHandlerContext`.

**`NativeAgentAdapter.sendTurn`** — `src/agents/native/adapter.ts:354` (US-003)
- Target: forwards `opts.loopHandlers` and `opts.loopHandlerContext` into the `runNativeTurn`
  deps, beside the existing `opts.loopEvents` forward.

**`runNativeTurn`** — `src/agents/native/session/turn-loop.ts:94-103` (US-003)
- Target: passes `deps.loopHandlers`, `deps.loopHandlerContext` and `deps.signal` into
  `registerBuiltinLoopHandlers`.

**`dispatchBeforeTool`** — `src/agents/native/session/loop-events/registry.ts:150` (US-002)
- Baseline: reads `outcome.kind` outside its try, so a handler returning `undefined` throws out of
  the dispatcher.
- Target: an outcome that is not an object carrying a `kind` is treated as `{ kind: "allow" }`
  and logged at warn.

**`ISessionManager`** — `src/session/types.ts:244` (US-004)
- Target: gains `configureLoopHandlers(set: LoopHandlerSet): void`. `NaxRuntime.sessionManager` is
  typed `ISessionManager` (`src/runtime/index.ts:159`) and `configureRuntime` exists only on the
  concrete class, so the run-scoped set is delivered through this interface method — never an
  `instanceof SessionManager` narrow, which would silently skip any other implementation.

**`SessionManager`** — `src/session/manager.ts:562`, `:600` (US-004)
- Target: implements `configureLoopHandlers` by storing the set (default: empty); `sendPrompt`
  spreads `buildLoopHandlerTurnOpts(...)` into the `adapter.sendTurn` options.

**`makeSessionManager`** — `test/helpers/mock-session-manager.ts:9` (US-004)
- Target: the mock gains a no-op `configureLoopHandlers`, overridable through `overrides`.

**`initializeAfterLock`** — `src/execution/lifecycle/run-setup-init.ts:161` (US-004)
- Target: right after `loadPlugins` returns, calls
  `runtime.sessionManager.configureLoopHandlers(pluginRegistry.getLoopHandlers())`.

**`check-adapter-no-config-import.sh`** — `scripts/check-adapter-no-config-import.sh` (US-004)
- Target: also fails when any file under `src/agents/native/` imports from `src/plugins`
  (the `@/plugins` alias or a relative path ending in `/plugins`).

Symbols this feature reads but does not change:

- `LoopEvent`, `PayloadOf<E>`, `PatchOf<E>`, `HandlerOf<E>` — `src/agents/native/session/loop-events/types.ts:20-28`, `:210`
- `BeforeToolOutcome` — `loop-events/types.ts:53`
- `BeforeTurnPatch` (`seed?: readonly NativeTranscriptMessage[]`, `history?`) — `loop-events/types.ts:101-106`
- `MAX_FOLLOW_UPS_PER_TURN = 3` — `src/agents/native/session/turn-loop-round-trip.ts:57`
- `applyHistoryPatch` — `loop-events/cache-boundary.ts`
- `SessionDescriptor` (`role`, `storyId?`, `featureName?`, `workdir`) — `src/session/types.ts:66-107`
- `NATIVE_AGENT_NAME` — `src/config/agent-defaults.ts:19`, exported from `@/config`
- `loadPlugins` — `src/plugins/loader.ts:107`

### New public types

In `src/agents/native/session/loop-events/types.ts`, exported from `loop-events/index.ts`
(coding-agent-owned; `src/plugins/` imports them, never the reverse):

```ts
export interface LoopHandlerContext {
  readonly sessionName: string;
  readonly role?: string;
  readonly storyId?: string;
  readonly feature?: string;
  readonly workdir?: string;
  readonly model?: string;
  readonly provider?: string;
}

export type ExternalHandlerOf<E extends LoopEvent> = (
  payload: PayloadOf<E>,
  ctx: LoopHandlerContext,
) => PatchOf<E> | undefined | Promise<PatchOf<E> | undefined>;

export interface LoopHandlerEntry {
  readonly plugin: string;
  readonly event: LoopEvent;
  readonly handler: ExternalHandlerOf<LoopEvent>;
}

export type LoopHandlerSet = readonly LoopHandlerEntry[];
```

In `src/plugins/extensions.ts`:

```ts
export type LoopHandlerRegistrar = <E extends LoopEvent>(event: E, handler: ExternalHandlerOf<E>) => void;

export interface ILoopHandlerProvider {
  register(on: LoopHandlerRegistrar): void;
}
```

Example plugin (documentation only):

```ts
const plugin: NaxPlugin = {
  name: "code-intel-nudge",
  version: "1.0.0",
  provides: ["loop-handlers"],
  extensions: {
    loopHandlers: {
      register(on) {
        on("before_turn", (_payload, ctx) =>
          ctx.role === "implementer"
            ? { seed: [{ role: "user", content: "Use the code-intel tools before grepping." }] }
            : undefined);
      },
    },
  },
};
```

### Approach

Deterministic wiring only — no LLM calls, no new config keys.

1. **Build once per run.** `PluginRegistry.getLoopHandlers()` iterates `registry.plugins` (load
   order: global dir, project dir, `config.plugins[]`), keeps those whose `provides` includes
   `"loop-handlers"`, and calls each `register(on)` with a registrar that stages
   `{ plugin: plugin.name, event, handler }`. The result is `Object.freeze`d and memoised.
2. **Inject.** `initializeAfterLock` hands the set to the run's session manager through
   `ISessionManager.configureLoopHandlers`.
3. **Forward.** `sendPrompt` calls `buildLoopHandlerTurnOpts({ handle, descriptor, set })` from
   the new `src/session/loop-handler-forwarding.ts`, passing the `terminalDesc` it already looks
   up (`manager.ts:579`), and spreads the result into the `adapter.sendTurn` options.
   `buildLoopHandlerTurnOpts` returns `{}` when the set is empty or `handle.agentName` is not
   `NATIVE_AGENT_NAME`; otherwise `{ loopHandlers, loopHandlerContext }` with a frozen context
   whose undefined fields are omitted.
4. **Install per turn.** `registerBuiltinLoopHandlers` registers, in order: invalid-call repair
   (`before_tool`), spin breaker (`before_tool`), each set entry wrapped by
   `wrapExternalHandler`, truncation (`after_tool`). `turn-loop.ts:94` builds a fresh registry
   every turn, so plugin entries register once per real turn; the WeakMap repoint path
   (`loop-handlers.ts:51-65`) runs only when a test supplies `deps.loopEvents`, and on repoint the
   wrapped entries read the new context through the per-turn state.
5. **Wrap.** `wrapExternalHandler(entry, getCtx, signal)` in the new
   `src/agents/native/session/loop-events/external-handler.ts` returns a built-in `HandlerOf<E>`
   that calls `entry.handler(payload, getCtx())` and composes, as an ordered pipeline:
   1. race the handler's settlement against a `LOOP_HANDLER_TIMEOUT_MS` (10_000) timer and the
      `signal`'s abort — the first to settle wins, later settlements are discarded, and the timer
      is cleared once the race settles;
   2. a throw, rejection, timeout or abort is a **failure**;
   3. on `before_tool` only, a settled value that is not an object with a `kind` of `allow`,
      `nudge`, `block` or `terminate` — other than `undefined` — is a **failure**;
   4. a settled `undefined` becomes `{ kind: "allow" }` on `before_tool` and `{}` on every other
      event;
   5. a failure on `before_tool` returns
      `{ kind: "block", isError: true, content: "Blocked: loop handler from plugin '<plugin>' failed (<reason>)." }`
      and logs `native-loop-events` warn with `{ plugin, event, tool, error }`; a failure on any
      other event returns `{}` and logs `native-loop-events` warn with `{ plugin, event, error }`.
      The wrapper never rethrows.
   6. a successful patch carrying any of `seed`, `history`, `messages` or `summary` is logged at
      debug with `{ plugin, event, fields }` so a later `applyHistoryPatch` rejection can be traced.
   The timeout is read through `_externalHandlerDeps.timeoutMs` so tests can shorten it.

Everything else — patch-field picking, payload array restore, off-boundary history rejection,
the follow-up cap, block/terminate short-circuit — is the existing dispatcher's behaviour and
applies to plugin handlers unchanged.

### Failure Handling

| Failure | Behaviour | Owner |
|:---|:---|:---|
| A plugin's `register()` throws | that plugin's entries are dropped; `plugins` warn naming the plugin; run continues | US-001 |
| A plugin registers an event name outside `LoopEvent` | that plugin's entries are all dropped; `plugins` warn naming the plugin and the event | US-001 |
| `before_tool` handler throws, rejects, times out, is aborted, or returns a malformed outcome | the call is blocked with the error result naming the plugin — fail-closed | US-002 |
| any other event's handler throws, rejects, times out or is aborted | `{}` — the handler is skipped with a warn naming the plugin — fail-open | US-002 |
| a built-in `before_tool` handler returns `undefined` | treated as `allow` with a warn; the turn continues | US-002 |
| a built-in `before_tool` handler blocks or terminates the call | plugin `before_tool` handlers are not invoked for that call | US-003 |
| a non-native session receives a non-empty set | no loop-handler options are attached; one `plugins` info line per SessionManager: "loop handlers apply to the native agent only" | US-004 |

## Out of Scope

- A project-trust gate for plugins: `<project>/.nax/plugins/` keeps loading without consent for every plugin type, including `loop-handlers`; this is a separate issue covering all plugin types.
- `nax plan` sessions: plan builds its own runtime (`src/runtime/index.ts:388`) and never calls `loadPlugins`, so plan sessions receive no plugin loop handlers.
- ACP agents: loop events are native-only; no ACP equivalent is added.
- Declarative per-role or per-stage filters on a registration; plugin handlers scope themselves by reading `LoopHandlerContext` at runtime.
- Unsubscribing a handler, registering handlers per turn or per story, and any `LoopHandlerContext` capability beyond read-only facts (no abort, no UI, no config access).
- A plugin `before_tool` handler observing, annotating or re-wording a call that a built-in `before_tool` handler already blocked or terminated.
- A timeout on built-in loop handlers; only plugin handlers are timed.
- Freezing nested payload objects; plugin handlers get the same readonly-typed, array-restored payloads built-ins get.
- Changes to the dispatcher's history cache-boundary rule, the `MAX_FOLLOW_UPS_PER_TURN` cap, or the patchable-field lists.
- Extracting the coding agent into a standalone package; this slice only cuts the types so that move stays mechanical.
- Configuring the plugin handler timeout through `NaxConfig`; it is the constant `LOOP_HANDLER_TIMEOUT_MS`.

## Stories

**US-001 — Plugins can declare loop handlers** (no dependencies)
Add the public loop-handler types, the `loop-handlers` plugin type, its validator, and
`PluginRegistry.getLoopHandlers()`.

**US-002 — Plugin handlers are wrapped: context, timeout, attributed failure** (depends on US-001)
Add `external-handler.ts` with `wrapExternalHandler`, `LOOP_HANDLER_TIMEOUT_MS` and
`_externalHandlerDeps`, and the `dispatchBeforeTool` malformed-outcome guard.

**US-003 — Native turns install plugin handlers between the built-ins** (depends on US-002)
Extend `BuiltinLoopHandlerDeps`, `TurnDeps` and `SendTurnOpts`; install wrapped entries in
`registerBuiltinLoopHandlers`; forward the fields through `NativeAgentAdapter.sendTurn` and
`runNativeTurn`. Correct the `turn-end-event.ts:1-5` comment ("only built-ins register today")
to say plugin handlers are timed by the wrapper and built-ins are not.

**US-004 — A `nax run` delivers plugin handlers to every native session** (depends on US-003)
Add `src/session/loop-handler-forwarding.ts`; add `configureLoopHandlers` to `ISessionManager`,
`SessionManager` and the test mock; wire `sendPrompt`; call `configureLoopHandlers` from
`initializeAfterLock`; extend the adapter boundary gate; write
`docs/guides/loop-handlers.md` (events, patches, ordering, failure semantics, timeout,
native-only, `nax plan` excluded, plugin code runs in the nax process outside the sandbox); fix
the `src/plugins/loader.ts:6` comment to name `<project>/.nax/plugins/`.
**Verification note:** `src/session/manager.ts` is grandfathered at 679 lines in
`scripts/baselines/file-sizes-baseline.json` (678 today); `bun run check:file-sizes` must pass,
so any lines added to `manager.ts` are offset by moving an equal or larger block out of it.

### Context Files

**US-001**
- `src/plugins/validator.ts` — `VALID_PLUGIN_TYPES` and the per-type validators to extend
- `src/plugins/registry.ts` — `getReporters()` getter pattern to replicate
- `src/plugins/extensions.ts` — existing extension interfaces
- `src/agents/native/session/loop-events/types.ts` — `LoopEvent`, `PayloadOf`, `PatchOf`
- `test/unit/plugins/registry.test.ts` — registry test patterns

**US-002**
- `src/agents/native/session/loop-events/registry.ts` — `dispatchBeforeTool`, `dispatchChain`
- `src/agents/native/session/loop-events/types.ts` — types added by US-001
- `src/agents/native/session/loop-events/index.ts` — barrel to export from
- `test/unit/agents/native/session/loop-events.test.ts` — dispatcher test patterns

**US-003**
- `src/agents/native/session/loop-handlers.ts` — built-in install order and WeakMap repoint
- `src/agents/native/session/turn-loop.ts` — the `registerBuiltinLoopHandlers` call site
- `src/agents/native/adapter.ts` — `sendTurn` forwarding of `loopEvents`
- `src/agents/native/session/loop-events/external-handler.ts` — created by US-002, used here
- `test/unit/agents/native/adapter-turn-signal.test.ts` — drives `NativeAgentAdapter.sendTurn` with a fake model

**US-004**
- `src/session/manager.ts` — `sendPrompt` and the stored runtime fields
- `src/execution/lifecycle/run-setup-init.ts` — `initializeAfterLock` and its `loadPlugins` call
- `scripts/check-adapter-no-config-import.sh` — boundary gate to extend
- `test/unit/session/manager-phase-b-prompt.test.ts` — `sendPrompt` forwarding test patterns
- `test/unit/execution/lifecycle/run-setup-approvals-seal.test.ts` — drives `initializeAfterLock` through `setupRun` with `makeMockRuntime`

### Creates

**US-001**
- `test/unit/plugins/registry-loop-handlers.test.ts` — `getLoopHandlers()` and validator tests

**US-002**
- `src/agents/native/session/loop-events/external-handler.ts` — `wrapExternalHandler`, `LOOP_HANDLER_TIMEOUT_MS`, `_externalHandlerDeps`
- `test/unit/agents/native/session/loop-events/external-handler.test.ts` — wrapper tests

**US-003**
- `test/unit/agents/native/session/loop-handlers-plugins.test.ts` — install-order tests
- `test/unit/agents/native/adapter-loop-handlers.test.ts` — `sendTurn` seam tests

**US-004**
- `src/session/loop-handler-forwarding.ts` — `buildLoopHandlerTurnOpts`
- `test/unit/session/loop-handler-forwarding.test.ts` — forwarding tests
- `test/integration/plugins/loop-handlers.test.ts` — end-to-end plugin fixture test
- `docs/guides/loop-handlers.md` — plugin author guide

### Modifies

**US-004**
- `test/helpers/mock-session-manager.ts` — `makeSessionManager` returns an object literal typed `ISessionManager`; once US-004 adds the required `configureLoopHandlers` member to the interface, the literal no longer satisfies it and every test using the helper fails to compile. US-004 owns adding a no-op `configureLoopHandlers` default that `overrides` can replace.
- `scripts/baselines/file-sizes-baseline.json` — its entry for src/session/manager.ts pins the grandfathered size at 679 lines. If US-004's offsetting extraction leaves the session manager shorter, lower that entry with the check:file-sizes:update script; the replacing invariant is that the entry equals the file's new line count.

### Seams

- **US-001 → US-004: `PluginRegistry.getLoopHandlers` → `initializeAfterLock`.** US-004's run-setup criterion drives `initializeAfterLock` with a workdir whose `.nax/plugins/` holds a `loop-handlers` plugin and a mock runtime whose `sessionManager.configureLoopHandlers` is a spy (`makeSessionManager({ configureLoopHandlers: spy })`).
- **US-002 → US-003: `wrapExternalHandler` → `registerBuiltinLoopHandlers`.** US-003's criteria drive `registerBuiltinLoopHandlers` and `NativeAgentAdapter.sendTurn` with a throwing plugin `before_tool` handler and observe the plugin-named block.
- **US-003 → US-004: `SendTurnOpts.loopHandlers` → `SessionManager.sendPrompt`.** US-004's criteria drive `sendPrompt` with a recording adapter and assert the options it receives.

## Acceptance Criteria

### US-001 — Plugins can declare loop handlers

- [unit] `validatePlugin()` returns the plugin when `provides` is `["loop-handlers"]` and `extensions.loopHandlers.register` is a function.
- [unit] `validatePlugin()` returns `null` and logs a `plugins` warning when `provides` includes `"loop-handlers"` and `extensions.loopHandlers` is absent.
- [unit] `validatePlugin()` returns `null` and logs a `plugins` warning when `provides` includes `"loop-handlers"` and `extensions.loopHandlers.register` is not a function.
- [unit] `PluginRegistry.getLoopHandlers()` returns an empty array when no loaded plugin provides `"loop-handlers"`.
- [unit] `PluginRegistry.getLoopHandlers()` returns a `LoopHandlerEntry` `{ plugin, event, handler }` for each `on(event, handler)` call a plugin's `register` makes, with `plugin` equal to the plugin's `name`.
- [unit] `PluginRegistry.getLoopHandlers()` orders entries by the order of `registry.plugins`, then by `on(...)` call order within one plugin.
- [unit] `PluginRegistry.getLoopHandlers()` returns an array for which `Object.isFrozen` is true.
- [unit] Calling `PluginRegistry.getLoopHandlers()` twice invokes each plugin's `register` exactly once and returns the same array instance both times.
- [unit] When one plugin's `register` throws, `PluginRegistry.getLoopHandlers()` returns no entries for that plugin, still returns the other plugins' entries, and logs a `plugins` warning carrying that plugin's name.
- [unit] When a plugin's `register` calls `on("before_everything", handler)`, `PluginRegistry.getLoopHandlers()` returns no entries for that plugin, including entries it registered before the unknown event, and logs a `plugins` warning naming the plugin and `before_everything`.
- [unit] `LoopHandlerContext`, `ExternalHandlerOf`, `LoopHandlerEntry` and `LoopHandlerSet` are importable from `@/agents/native/session/loop-events`, and a `LoopHandlerEntry` built from an `ExternalHandlerOf<"after_tool">` is accepted by `PluginRegistry.getLoopHandlers()`'s return type.

### US-002 — Plugin handlers are wrapped: context, timeout, attributed failure

- [unit] `LOOP_HANDLER_TIMEOUT_MS` imported from `external-handler.ts` equals `10000`.
- [unit] The handler returned by `wrapExternalHandler(entry, getCtx, signal)` calls `entry.handler` with the dispatched payload and the value `getCtx()` returns at dispatch time.
- [unit] For an `after_tool` entry whose handler returns `undefined`, the wrapped handler resolves to `{}`.
- [unit] For a `before_tool` entry whose handler returns `undefined`, the wrapped handler resolves to `{ kind: "allow" }`.
- [unit] For a `before_tool` entry whose handler returns `{ kind: "block", content: "no", isError: true }`, the wrapped handler resolves to that same outcome.
- [unit] For a `before_tool` entry from plugin `p` whose handler throws, the wrapped handler resolves to `{ kind: "block", isError: true }` with `content` starting `Blocked: loop handler from plugin 'p' failed`.
- [unit] For a `before_tool` entry whose handler returns a rejected promise, the wrapped handler resolves to a `block` outcome whose `content` names the plugin.
- [unit] For a `before_tool` entry whose handler never settles, with `_externalHandlerDeps.timeoutMs` set to 20, the wrapped handler resolves to a `block` outcome whose `content` names the plugin.
- [unit] For a `before_tool` entry whose handler returns the string `"allow"`, the wrapped handler resolves to a `block` outcome whose `content` names the plugin.
- [unit] For a `before_tool` entry whose handler returns `{ kind: "maybe" }`, the wrapped handler resolves to a `block` outcome whose `content` names the plugin.
- [unit] When a `before_tool` wrapped handler blocks on a failure, one `native-loop-events` warning is logged with `plugin`, `event` equal to `before_tool`, `tool` equal to the call's name, and `error`.
- [unit] For an `after_tool` entry from plugin `p` whose handler throws, the wrapped handler resolves to `{}` and one `native-loop-events` warning is logged with `plugin` equal to `p` and `event` equal to `after_tool`.
- [unit] For a `before_turn_end` entry whose handler never settles, with `_externalHandlerDeps.timeoutMs` set to 20, the wrapped handler resolves to `{}` and logs a `native-loop-events` warning naming the plugin.
- [unit] For a `before_tool` entry whose handler never settles, aborting the `signal` passed to `wrapExternalHandler` makes the wrapped handler resolve to a `block` outcome before `_externalHandlerDeps.timeoutMs` elapses.
- [unit] For a `before_tool` entry whose handler resolves `{ kind: "allow" }` only after the timeout fired, the wrapped handler's result is the timeout `block`, not the late `allow`.
- [unit] After a wrapped handler whose handler resolves immediately settles, the timeout timer it armed has been cleared (no timer callback runs afterwards).
- [unit] When a `before_turn` entry from plugin `p` returns `{ seed: [message] }`, the wrapped handler resolves to that patch and logs at debug with `plugin` equal to `p`, `event` equal to `before_turn` and `fields` equal to `["seed"]`.
- [unit] A registry built with `createLoopEventRegistry()` whose only `before_tool` handler is a wrapped throwing plugin handler logs exactly one warning for one `dispatch("before_tool", …)` call.
- [unit] `dispatch("before_tool", …)` on a registry whose only `before_tool` handler returns `undefined` resolves to `{ kind: "allow" }` and logs a `native-loop-events` warning instead of throwing.

### US-003 — Native turns install plugin handlers between the built-ins

- [unit] With a `loopHandlers` entry on `before_tool`, dispatching a call whose optional property is `null` through a registry installed by `registerBuiltinLoopHandlers` hands the plugin handler a call whose `input` no longer has that property.
- [unit] With a `loopHandlers` entry on `after_tool` that returns content larger than the truncation budget, the `after_tool` dispatch result through a registry installed by `registerBuiltinLoopHandlers` is the truncated content.
- [unit] With two `loopHandlers` entries on `after_tool`, the second handler receives the `content` the first returned.
- [unit] When invalid-call repair blocks a call that fails schema validation, a `loopHandlers` entry on `before_tool` is not invoked for that call.
- [unit] When the spin breaker returns `terminate`, a `loopHandlers` entry on `before_tool` is not invoked for that call.
- [unit] Calling `registerBuiltinLoopHandlers` twice on the same registry with the same `loopHandlers` invokes a `before_tool` plugin handler once per `dispatch`.
- [unit] Calling `registerBuiltinLoopHandlers` a second time on the same registry with a different `loopHandlerContext` makes the next dispatch hand the plugin handler the second context.
- [unit] Aborting the `signal` passed to `registerBuiltinLoopHandlers` while a plugin `before_tool` handler is pending makes the `before_tool` dispatch resolve to a `block` outcome naming the plugin.
- [integration] `NativeAgentAdapter.sendTurn` with `opts.loopHandlers` holding a `before_turn` entry that returns a `seed` message makes that message part of the first model request's messages.
- [integration] `NativeAgentAdapter.sendTurn` with `opts.loopHandlers` holding a `before_tool` entry that returns `{ kind: "block", content: "refused", isError: true }` for a `Bash` call leaves the command unexecuted and records `refused` as that call's tool result.
- [integration] `NativeAgentAdapter.sendTurn` with `opts.loopHandlers` holding a throwing `before_tool` entry from plugin `p` records a tool result whose content starts `Blocked: loop handler from plugin 'p' failed`.
- [integration] `NativeAgentAdapter.sendTurn` with `opts.loopHandlers` holding a `before_turn_end` entry that returns `followUp` only on its first call sends exactly one extra user message and one extra model request.
- [integration] `NativeAgentAdapter.sendTurn` hands every plugin handler the object passed as `opts.loopHandlerContext`.

### US-004 — A `nax run` delivers plugin handlers to every native session

- [unit] `buildLoopHandlerTurnOpts()` returns `{}` when the set is empty.
- [unit] `buildLoopHandlerTurnOpts()` returns `{}` when `handle.agentName` is not `NATIVE_AGENT_NAME`, even with a non-empty set.
- [unit] `buildLoopHandlerTurnOpts()` for a native handle, a descriptor and a non-empty set returns `loopHandlers` equal to the set.
- [unit] `buildLoopHandlerTurnOpts()` for a native handle and a descriptor returns a `loopHandlerContext` with `sessionName` equal to `handle.id`, `role`, `storyId`, `feature` and `workdir` taken from the descriptor's `role`, `storyId`, `featureName` and `workdir`, and `model` and `provider` from `handle.modelDef`.
- [unit] `buildLoopHandlerTurnOpts()` returns a `loopHandlerContext` for which `Object.isFrozen` is true.
- [unit] `buildLoopHandlerTurnOpts()` with no descriptor returns a `loopHandlerContext` whose `role` is `handle.role` and which has no `storyId`, `feature` or `workdir` key.
- [unit] `SessionManager.sendPrompt()` after `configureLoopHandlers(set)` calls `adapter.sendTurn` with `opts.loopHandlers` equal to `set` and `opts.loopHandlerContext.storyId` equal to the session descriptor's `storyId`.
- [unit] `SessionManager.sendPrompt()` without a configured `loopHandlers` calls `adapter.sendTurn` with options that have no `loopHandlers` key.
- [unit] `SessionManager.sendPrompt()` for two non-native sessions after `configureLoopHandlers` with a non-empty set logs the `plugins` info line "loop handlers apply to the native agent only" exactly once.
- [integration] `initializeAfterLock()` with a workdir whose `.nax/plugins/` contains a plugin providing `"loop-handlers"` calls `runtime.sessionManager.configureLoopHandlers` once with an array holding that plugin's entry.
- [integration] A plugin file in a temp workdir's `.nax/plugins/` whose `before_turn` handler returns a `seed` message, loaded by `loadPlugins`, handed to a `SessionManager` through `configureLoopHandlers(registry.getLoopHandlers())`, and driven through `SessionManager.sendPrompt()` on a native session with a fake model, makes that message part of the first model request.
- [cli] `bash scripts/check-adapter-no-config-import.sh` run from a directory whose `src/agents/native/x.ts` imports from `@/plugins` exits 1 and prints `x.ts`.
- [cli] `bash scripts/check-adapter-no-config-import.sh` run from a directory whose `src/agents/native/x.ts` imports only from `@/agents/native/session/loop-events` exits 0.
