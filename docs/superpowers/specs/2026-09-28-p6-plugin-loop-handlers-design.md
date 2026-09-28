# Plugin loop handlers — design

**Date:** 2026-09-28 · **Status:** designed, awaiting spec review
**Baseline:** `main` @ `870a9f72d`. Every citation below was read against it.
**Implements:** the first code-shipping slice of phase 6 of the native-coding-agent arc
(`nax-coding` boundary, direction ruling "C + some B, A-ready", 2026-09-24)
**Master plan:** `nax-native-coding-agent-master-plan.md` (workspace, not this repo) — answers
P6 open question 1 ("which B consumers / which subset") in part
**Builds on:** `docs/superpowers/specs/2026-09-22-p3-loop-events-design.md` (the eight-event
registry and its dispatcher rules)
**Branch:** `feat/p6-plugin-loop-handlers` (off `main`)

---

## 1. Problem

P3 shipped an in-process loop-event registry with eight events — `before_tool`, `after_tool`,
`before_turn`, `transform_context`, `before_request`, `after_response`, `before_compaction`,
`before_turn_end` (`src/agents/native/session/loop-events/types.ts:20-28`). Nothing outside
nax can register on it:

- The only registration call site is `registerBuiltinLoopHandlers`
  (`src/agents/native/session/loop-handlers.ts:58`).
- `SendTurnOpts.loopEvents` (`src/agents/session-types.ts:135`) is forwarded by the adapter
  (`src/agents/native/adapter.ts:354`) but supplied by no caller.
- `src/hooks/` is not a substitute: its events fire around a story, shell out with a 5s
  timeout and cannot return a patch (pi harness gap analysis §9.1).

So any steering or policy that wants to run inside the agent loop — a seed note at turn start,
a reshaped tool result, a follow-up at turn end, a project-specific tool guard — has to be
merged into nax as a built-in. The R18 spike (2026-09-26) hit exactly this.

**There is also a latent ordering trap.** `turn-loop.ts:94` does
`deps.loopEvents ?? createLoopEventRegistry()` and then registers the built-ins onto it. A
caller that pre-populated a registry would put its handlers BEFORE the built-ins — ahead of
invalid-call repair on `before_tool`, and ahead of truncation on `after_tool`, so a handler's
output would escape the tool-result size budget. External handlers must therefore arrive as a
list of registrations whose install position the loop controls, never as a pre-built registry.

## 2. Goal and non-goals

**Goal.** A third party can ship a nax plugin whose handlers run on all eight loop events of
every native session in a `nax run`, with the same dispatcher guarantees the built-ins have,
fail-safe on `before_tool`, and without native code ever importing `src/plugins/` or
`NaxConfig`.

**Non-goals.**
- **Project trust.** `<project>/.nax/plugins/` is loaded without a trust prompt today, for every
  plugin type. This slice does not widen who can load code; a trust gate for ALL plugin types is
  a separate issue (§9).
- **`nax plan`.** Plan builds its own runtime (`src/runtime/index.ts:388`) and never calls
  `loadPlugins`. Plan sessions receive no plugin handlers.
- **ACP agents.** Loop events are native-only; ACP ignores the new fields (§5.3).
- **Declarative scoping** (`stages: [...]` on a registration), unsubscribe, per-turn
  registration, and any `ctx` capability beyond read-only facts (no abort, no UI). Handlers scope
  themselves at runtime from `ctx` — the pi model (§3).
- **A standalone package.** Types are cut so the later move is mechanical (P6 "A-ready"); the
  move itself is out of scope.

## 3. Prior art: pi extensions

pi (`packages/coding-agent/docs/extensions.md`) is the reference:

| pi | this design |
|---|---|
| `export default (pi) => pi.on(event, handler)` | `extensions.loopHandlers.register(on)` → `on(event, handler)` |
| handler `(event, ctx)` | handler `(payload, ctx)` |
| scoping by reading `ctx` at runtime, no declarative filter | same |
| order: extension load order, then registration order | same (plugin load order: global, project, config) |
| errors logged, agent continues; **`tool_call` throw blocks the tool** | same; `before_tool` throw/timeout/malformed → block |
| project-local extensions load only after project trust | **not adopted here** — separate issue |
| discovery `~/.pi/agent/extensions`, `.pi/extensions`, `settings.extensions[]` | nax's existing plugin loader: `~/.nax/plugins`, `<project>/.nax/plugins`, `config.plugins[]` |

## 4. Public types and API

### 4.1 Plugin extension

`src/plugins/types.ts:38` — `PluginType` gains `"loop-handlers"`.
`PluginExtensions` gains `loopHandlers?: ILoopHandlerProvider`.

```ts
// src/plugins/extensions.ts
export interface ILoopHandlerProvider {
  /** Called once per run, after setup(). Registrations are frozen afterwards. */
  register(on: LoopHandlerRegistrar): void;
}

export type LoopHandlerRegistrar =
  <E extends LoopEvent>(event: E, handler: ExternalHandlerOf<E>) => void;
```

`src/plugins/validator.ts` validates `loop-handlers` like the other types: when `provides`
includes it, `extensions.loopHandlers` must be an object with a `register` function.

### 4.2 Handler and context types (package-owned)

In `src/agents/native/session/loop-events/types.ts`, exported from `loop-events/index.ts`:

```ts
export type ExternalHandlerOf<E extends LoopEvent> = (
  payload: PayloadOf<E>,
  ctx: LoopHandlerContext,
) => PatchOf<E> | undefined | Promise<PatchOf<E> | undefined>;

export interface LoopHandlerContext {
  readonly sessionName: string;   // handle.id
  readonly role?: string;         // SessionRole; opaque to native
  readonly storyId?: string;
  readonly feature?: string;
  readonly workdir?: string;
  readonly model?: string;        // modelDef.model
  readonly provider?: string;     // modelDef.provider
}

export interface LoopHandlerEntry {
  readonly plugin: string;
  readonly event: LoopEvent;
  readonly handler: ExternalHandlerOf<LoopEvent>;
}

export type LoopHandlerSet = readonly LoopHandlerEntry[];
```

- `undefined` means "no change" (§6.2).
- Optional `ctx` fields are absent when the session has no descriptor (§5.2); a handler must not
  assume them.
- The built-in `HandlerOf<E>` (`types.ts:210`) is unchanged.
- **Ownership (P6).** These types live on the coding-agent side of the boundary.
  `src/plugins/` imports them; native never imports `src/plugins/` (§8.1). Moving
  `loop-events/` into a `nax-coding` package later is a file move.

### 4.3 Example

```ts
import type { NaxPlugin } from "@nathapp/nax";

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
        on("before_tool", ({ call }) =>
          call.name === "Bash" && String(call.input.command).includes("rm -rf /")
            ? { kind: "block", content: "Refused by project policy.", isError: true }
            : undefined);
      },
    },
  },
};
export default plugin;
```

`seed` is `readonly NativeTranscriptMessage[]` — the messages appended now (`BeforeTurnPatch`,
`types.ts:101-106`); `history` on the same patch is honoured only at a boundary.

## 5. Run-time wiring

### 5.1 Build the set once per run

`PluginRegistry.getLoopHandlers(): LoopHandlerSet` (new, `src/plugins/registry.ts`, beside
`getReporters()` at `:166`):

- iterates `loop-handlers` plugins in load order (global → project → config);
- calls each plugin's `register(on)` with a registrar that appends
  `{ plugin: plugin.name, event, handler }` to that plugin's staging list;
- an `event` outside `LoopEvent` → that plugin's loop handlers are dropped, `plugins` warn;
- `register()` throwing → that plugin's loop handlers are dropped, `plugins` warn, the run
  continues (mirrors how a failing `setup` is treated);
- returns `Object.freeze([...all staged entries])`. The result is memoised: `register()` runs
  once per plugin per run.

### 5.2 Inject into the SessionManager

The `SessionManager` is constructed at `src/execution/lifecycle/run-setup.ts:227`, before
plugins load (`run-setup-init.ts:161`). After init returns, run setup calls
`sessionManager.configureRuntime({ loopHandlers: pluginRegistry.getLoopHandlers() })`.
`configureRuntime` (`src/session/manager.ts:90`) gains the optional field, stored as
`_loopHandlers` (default: empty).

### 5.3 One chokepoint

`SessionManager.sendPrompt` (`manager.ts:562`) already fronts every `adapter.sendTurn` call
(`manager.ts:600`). When `_loopHandlers` is non-empty it adds two optional `SendTurnOpts` fields:

```ts
loopHandlers: this._loopHandlers,
loopHandlerContext: Object.freeze({
  sessionName: handle.id,
  role: desc?.role ?? handle.role,
  storyId: desc?.storyId,
  feature: desc?.featureName,
  workdir: desc?.workdir,
  model: handle.modelDef?.model,
  provider: handle.modelDef?.provider,
}),
```

where `desc` is the descriptor `sendPrompt` already looks up (`_findByName(handle.id)`,
`manager.ts:579`). Undefined fields are omitted, not set to `undefined`. When the set is empty,
neither field is added — the no-plugin path is byte-identical to today.

`SendTurnOpts` (`src/agents/session-types.ts:131`) gains `loopHandlers?: LoopHandlerSet` and
`loopHandlerContext?: LoopHandlerContext`.

**ACP.** The ACP adapter ignores both fields. When the set is non-empty and an ACP session
receives it, the SessionManager logs one `plugins` info line per run: "loop handlers apply to
the native agent only".

### 5.4 Adapter → loop

`adapter.ts:354` forwards both fields into the `runNativeTurn` deps beside `loopEvents`.
`turn-types.ts:130` gains the two optional fields.

### 5.5 Install order

`registerBuiltinLoopHandlers(registry, deps)` (`loop-handlers.ts:58`) takes the set and context
through `deps` and installs, in one place:

1. built-in `before_tool`: invalid-call repair, then the spin breaker (today's order);
2. each plugin entry, wrapped (§6), in set order;
3. built-in `after_tool`: truncation — **last**, as today.

Consequences:
- a plugin `before_tool` judges the call AFTER null-optional repair;
- a plugin `after_tool` result is still truncated to the size budget;
- among plugins, load order then registration order.

The WeakMap repoint rule (`loop-handlers.ts:51-65`) still holds: a second call for the same
registry repoints the per-turn state and registers nothing — plugin handlers included. Plugin
entries read `ctx` through the same per-turn state, so a repoint also repoints `ctx`.
`deps.loopEvents` stays test-only.

## 6. The external-handler wrapper

`src/agents/native/session/loop-events/external-handler.ts` (new):

```ts
export function wrapExternalHandler<E extends LoopEvent>(
  entry: LoopHandlerEntry,
  getCtx: () => LoopHandlerContext,
  signal: AbortSignal | undefined,
): HandlerOf<E>;
```

### 6.1 What the dispatcher already guarantees (unchanged, applies as-is)

| guarantee | where |
|---|---|
| only declared patch fields are read | `pickPatchFields` / `PATCHABLE_FIELDS`, `registry.ts:63-110` |
| array mutation of the payload is snapshotted and restored | `payload-guard.ts`, called per handler in `registry.ts` |
| off-boundary history rewrite rejected; the patch stops, never the turn | `applyHistoryPatch`, `cache-boundary.ts` |
| `before_turn_end` follow-up ignored after a stop and capped at `MAX_FOLLOW_UPS_PER_TURN` (3) | `turn-loop-round-trip.ts:57,358-370` |
| `block` / `terminate` short-circuit; a later handler cannot veto | `dispatchBeforeTool`, `registry.ts:125-157` |
| a throwing field-patch handler is logged and skipped | `dispatchChain`, `registry.ts:185-200` |

Nested objects in a payload are readonly-typed, not frozen — the same as for built-ins.

### 6.2 What the wrapper adds

1. **Context.** Calls `entry.handler(payload, getCtx())`.
2. **`undefined` → empty patch.** Field-patch events: `{}`. `before_tool`: `{ kind: "allow" }`.
   Required: `dispatchBeforeTool` reads `outcome.kind` outside its try (`registry.ts:150`), so
   an `undefined` outcome would throw out of the dispatcher and fail the turn.
3. **Timeout.** The handler is raced against `LOOP_HANDLER_TIMEOUT_MS` (exported constant,
   10_000) and `signal`. Losing the race is treated as a throw. The timer is cleared on settle.
   Built-in handlers stay un-timed. Tests inject the timeout through
   `_externalHandlerDeps` (nax `_deps` convention).
4. **Failure, attributed.**
   - `before_tool` — a throw, rejection, timeout, a non-object outcome, or an unknown `kind`
     returns
     `{ kind: "block", isError: true, content: "Blocked: loop handler from plugin '<plugin>' failed (<reason>)." }`
     and warns `native-loop-events` with `{ plugin, event, tool, error }`. **Fail-safe.**
   - the other seven events — warns `native-loop-events` with `{ plugin, event, error }` and
     returns `{}`. Same log-and-skip as today, now with the plugin named.
   The wrapper never rethrows, so the registry's own catch never double-logs a plugin failure.
5. **History attribution.** When a plugin returns any of `history`, `messages`, `seed` or
   `summary`, the wrapper logs at debug `{ plugin, event, fields }`, so a later
   `applyHistoryPatch` rejection (which only knows the event) can be traced to a plugin.

### 6.3 Dispatcher change

One defensive line in `dispatchBeforeTool`: an outcome that is not an object with a `kind` is
treated as `{ kind: "allow" }` with a warn. This protects the turn from a built-in returning
`undefined`; plugin outcomes never reach it malformed because the wrapper normalises them first.
No other registry change.

### 6.4 Comment corrections

- `turn-end-event.ts:1-5` — "Handlers are awaited without a timeout; only built-ins register
  today" becomes: plugin handlers are timed by the wrapper; built-ins are not.
- `src/plugins/loader.ts:6` — `<project>/nax/plugins/` becomes `<project>/.nax/plugins/` (the
  real path, `run-setup-init.ts:155`).

## 7. Error and edge cases

| case | behaviour |
|---|---|
| no `loop-handlers` plugin | set empty; no new `SendTurnOpts` fields; turn path identical to today |
| `register()` throws / unknown event | that plugin's handlers dropped, `plugins` warn, run continues |
| `before_tool` handler throws / times out / malformed | call blocked, agent sees the error result naming the plugin |
| other-event handler throws / times out | warn with plugin, handler skipped |
| handler hangs past turn abort | race settles on `signal`; treated as a throw |
| plugin rewrites cached prefix off-boundary | patch rejected by `applyHistoryPatch`, turn continues; debug line names the plugin |
| plugin `before_turn_end` keeps returning `followUp` | honoured up to 3 per turn, ignored after a stop |
| plugin returns `terminate` on `before_tool` | honoured (all eight events are exposed by ruling) |
| ACP session | fields ignored, one info line per run |
| session with no descriptor | `ctx` carries `sessionName`, `role` from the handle, model/provider; other fields absent |

## 8. Gates, tests, docs

### 8.1 Boundary gate

`scripts/check-adapter-no-config-import.sh` (already in `check:all`) additionally fails when any
file under `src/agents/native/` imports from `src/plugins/` (relative or `@/plugins` alias).
Direction is one-way: `src/plugins/` → `loop-events` public types → native.

### 8.2 Unit tests (written first)

- `test/unit/agents/native/session/loop-events/external-handler.test.ts` — `ctx` passed and
  frozen; `undefined` → `allow` / `{}`; on `before_tool` each of throw, rejection, timeout,
  non-object, unknown `kind` → `block` naming the plugin; on each of the other seven events a
  throw → `{}` plus a warn carrying `plugin`; abort `signal` settles a hung handler; timer
  cleared on settle; debug line on history-bearing fields.
- `test/unit/agents/native/session/loop-events.test.ts` — `dispatchBeforeTool` survives a
  handler returning `undefined`.
- loop-handlers install order — a plugin `before_tool` sees the repaired input; an oversized
  plugin `after_tool` result is still truncated; two plugins chain in set order; a second
  install on the same registry repoints and registers nothing new.
- `test/unit/plugins/` — validator accepts `loop-handlers` with `register`, rejects it without;
  `getLoopHandlers()` order global → project → config and memoised; throwing `register()` and
  unknown event drop only that plugin.
- `session/manager` — `sendPrompt` forwards the set and a frozen `ctx` from the descriptor;
  omits both when the set is empty; ACP info line logged once per run.

### 8.3 Integration

`test/integration/plugins/loop-handlers.test.ts` — a fixture plugin in a temp `.nax/plugins/`,
driven through a full native turn on the scripted fake provider the seam tests use:
- a `before_turn` seed reaches the transcript;
- a `before_tool` block becomes the tool result;
- `before_turn_end` injects exactly one follow-up;
- an off-boundary `transform_context` rewrite is rejected and the turn completes;
- a throwing `before_tool` handler blocks the call.

Run through the repo's own test scripts, never bare `bun test`.

### 8.4 Not in the merge gate

A live, billed smoke run with a real plugin on a fixture copy. Offered separately; needs
approval at launch.

### 8.5 Docs

- `docs/guides/loop-handlers.md` (new): the eight events, the patch each may return, ordering,
  failure semantics, the timeout, native-only, `nax plan` excluded, plugin code runs in the nax
  process outside the srt sandbox, and the §4.3 example.
- The comment corrections in §6.4.

## 9. Follow-ups

- **Issue: project-trust gate for all plugin types.** `<project>/.nax/plugins/` is imported
  without consent; loop handlers give that code reach into every native session. pi gates
  project-local extensions behind trust.
- **Master plan.** Record under P6 that open question 1 is answered in part by this slice and
  that P6 now ships this one slice of code.

## 10. File budget

New: `external-handler.ts` (~120 lines), `docs/guides/loop-handlers.md`, two test files.
Touched, all well under the 600-line gate: `loop-events/types.ts`, `loop-events/index.ts`,
`loop-events/registry.ts` (one guard), `loop-handlers.ts`, `turn-types.ts`, `adapter.ts`,
`session-types.ts`, `session/manager.ts`, `run-setup.ts`, `plugins/{types,extensions,
validator,registry,loader}.ts`, `check-adapter-no-config-import.sh`, `turn-end-event.ts`.
**File-size ratchet.** `src/session/manager.ts` is 678 lines — over the 600 limit and
grandfathered in `scripts/baselines/file-sizes-baseline.json`, so ANY net growth fails
`check:file-sizes`. The ctx build and the ACP info line therefore live in a new
`src/session/loop-handler-forwarding.ts` (`buildLoopHandlerTurnOpts(handle, desc, set)`), and
manager.ts takes only the field, the `configureRuntime` option and one spread — offset by
extracting an equal-or-larger block in the same PR (the plan names it). `adapter.ts` is 547
lines; the forward adds ~2.
