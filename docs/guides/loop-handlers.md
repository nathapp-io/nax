---
title: Loop Handlers
description: Plugin-contributed handlers on the native agent's turn loop — events, patches, ordering, failure semantics and timeout
---

# Loop Handlers

A plugin can steer the **native** agent from inside its turn loop. Where
[nax hooks](hooks.md) fire around a story, shell out, and cannot return a value, a
loop handler is an in-process function that sees a loop event as it happens and
returns a **patch**: a seed note at turn start, a reshaped tool result, a guarded
tool call, a follow-up at turn end.

Loop handlers are a plugin extension type. This guide is for plugin authors; the
matching design record is `docs/specs/SPEC-plugin-loop-handlers.md`.

## Writing a handler

A plugin declares `loop-handlers` in `provides` and registers handlers in
`extensions.loopHandlers.register`:

```ts
export default {
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

The plugin is the module's default export (nax falls back to the module's own
exports when there is none). When authoring inside the nax source tree, the types
are `NaxPlugin` / `ILoopHandlerProvider` from `src/plugins` and
`LoopHandlerContext` / `PayloadOf<E>` / `PatchOf<E>` from
`src/agents/native/session/loop-events`.

Save it in one of the directories nax loads plugins from:

| Source | Location |
|:---|:---|
| Global | `~/.nax/plugins/` |
| Project | `<project>/.nax/plugins/` |
| Config | `config.plugins[]` entries |

A source file is `*.ts`, `*.js` or `*.mjs`, or a directory holding
`index.ts` / `index.js` / `index.mjs`. Load order — global directory, project
directory, `config.plugins[]` — is the order handlers run in (see
[Ordering](#ordering)).

`register` must be **synchronous**. A plugin that returns a promise is treated as
a contract violation: its handlers are dropped and a `plugins` warning names it.
The same applies to a registration for an event name outside the eight below, or
to a `<handler>` that is not a function — the plugin's whole registration set is
dropped rather than half-installed, because a registration set nax cannot honour
in full is one the plugin never asked for.

`register` runs once per `nax run`, at run setup: the set is built lazily, frozen
and memoised, and is handed to the run's session manager.

### The context

Every handler is called with `(payload, ctx)`. `ctx` is a frozen, read-only
description of the session the handler is running in:

| Field | Source |
|:---|:---|
| `sessionName` | the session handle's name |
| `role` | the session descriptor's role (the handle's, when no descriptor was found) |
| `storyId` | the session descriptor's story |
| `feature` | the session descriptor's feature |
| `workdir` | the session descriptor's working directory |
| `model` | the model the session was opened with |
| `provider` | that model's provider |

A field nax has no value for is **absent**, not `undefined` — `"storyId" in ctx`
is the test. There is deliberately nothing else: no abort, no UI, no config
access, and no way to unsubscribe. A handler scopes itself by reading `ctx` at
dispatch time; nax has no per-role or per-stage filters.

Returning `undefined` means "no patch" and is always valid — it becomes
`{ kind: "allow" }` on `before_tool` and `{}` on every other event.

## Events

| Event | Fires | What a handler may patch |
|:---|:---|:---|
| `before_tool` | once per tool call, before the tool runs | an **outcome**: `allow` (optionally rewrites `input`), `nudge`, `block`, `terminate` |
| `after_tool` | on the tool's result, before the result is built | `content`, `isError` |
| `before_turn` | once as a turn starts, after the transcript loads | `seed` messages; `history` only when `payload.boundary` is true |
| `transform_context` | before every provider request attempt | `messages` |
| `before_request` | per request **attempt**, transport retries included | `options` (`thinking`, `temperature`) |
| `after_response` | on a settled assistant message | `text`, `toolCalls`, `thinking` |
| `before_compaction` | in both the proactive and overflow branches | `decline` (proactive only), `summary` |
| `before_turn_end` | before the final transcript save | `followUp` — re-enters the loop with another user turn |

Patches are **partial**: return only the fields you want changed, or `undefined`.

Some payload fields are readable but never patchable, by ruling: `after_tool`'s
`denied` (a refused Write is not a crashed Write), `after_response`'s `usage` and
`costUsd` (billing truth), and `before_turn`'s `boundary` (the dispatcher decides
the cache boundary, not a handler).

`before_tool` is the only event whose answer is a decision rather than a field
patch, so it is validated rather than field-picked: a value that is neither
`undefined` nor an object with a `kind` of `allow`, `nudge`, `block` or
`terminate` is a failure (see below). `block` answers the call without invoking
the tool; `terminate` answers every outstanding call in the current batch.

A `before_turn_end` `followUp` is capped at three per turn, and is ignored when
the turn ended by a stop, an abort or an error. An overflow `before_compaction`
`decline` is ignored (and logged).

## Ordering

Handlers are installed between the native loop's built-ins, never ahead of them:

```
before_tool   invalid-call repair  →  spin breaker  →  plugin entries (in set order)
after_tool    plugin entries (in set order)  →  truncation
```

Set order is the plugin load order above, and within one plugin the order its
`on(...)` calls were made.

The built-ins come first on purpose. `dispatchBeforeTool` returns on the first
`block`/`terminate`, so a call the invalid-call repair already refused or the
spin breaker already stopped is **never offered to a plugin handler**. A plugin
`before_tool` handler therefore judges the call the tool would actually receive,
after null-optional repair. On `after_tool`, truncation runs last, exactly where
the loop's hardcoded truncation call sat: it shapes whatever the plugin entries
produced. Two entries on the same event chain: the second sees the content the
first returned.

## Failure semantics

A handler has a bounded lifetime and a failure that is attributed, never
rethrown. A plugin's defect must not fail the turn.

| Failure | Result |
|:---|:---|
| `register()` throws | that plugin's entries are dropped; `plugins` warning naming the plugin; the run continues |
| a handler throws, rejects, times out or is aborted — on `before_tool` | the call is **blocked** with `Blocked: loop handler from plugin '<name>' failed (<reason>).` — fail-closed |
| a handler throws, rejects, times out or is aborted — on any other event | the handler is skipped: `{}` — fail-open |
| a `before_tool` handler returns a value that is not a valid outcome | same as a failure on `before_tool` |
| a built-in `before_tool` handler returns `undefined` | treated as `allow`, with a warning |

Every failure logs one `native-loop-events` warning carrying `plugin`, `event`
and `error` (`tool` too, on `before_tool`), so a misbehaving plugin is named in
the run's log.

## Timeout

Each plugin handler is raced against a **10 second** deadline
(`LOOP_HANDLER_TIMEOUT_MS`) and the turn's abort signal. Whichever settles first
wins, a later settlement is discarded, and the timer is cleared as soon as the
handler answers — an instant handler does not hold the event loop open.

The deadline is a constant, not a `NaxConfig` key: it bounds the turn's liveness
rather than expressing a per-project policy. Only plugin handlers are timed; the
built-ins are nax's own code and are not.

An aborted turn aborts a pending plugin handler, which then fails like any other
failure — `block` on `before_tool`, `{}` elsewhere. A handler gets no way to
abort the turn itself.

## Scope: native agent only

Loop events belong to the **native** agent, the in-process loop. A session on
any other agent (an ACP agent, for example) receives no handlers: `sendPrompt`
attaches no loop-handler options, and a non-empty set reaching such a session is
reported once per session manager with a `plugins` info line —
`loop handlers apply to the native agent only`. There is no ACP equivalent.

`nax plan` is excluded for a different reason: a plan session builds its own
runtime (`src/runtime/index.ts`) and never calls `loadPlugins`, so plan sessions
receive no plugin loop handlers at all. Plugin handlers reach the native turns of
a `nax run`.

Plugin handlers are also native-only in a second sense: `src/agents/native/`
never imports `src/plugins`. A plugin handler is handed nax-owned payload and
context **types** from
`src/agents/native/session/loop-events/`, and the boundary gate
(`scripts/check-adapter-no-config-import.sh`) fails the build if anything under
`src/agents/native/` reaches into the plugin system. That keeps the coding agent
extractable as a standalone package.

## Plugin code runs in the nax process, outside the sandbox

This is the part to weigh before shipping a plugin.

A handler is **not** sandboxed and **is not run in an agent's sandbox**. It is a
plain function called from inside `runNativeTurn`, in the nax process itself,
with nax's own privileges, filesystem access and environment. It can read your
repository, your `~/.nax/`, your environment variables and your process — and it
runs on every native turn, in the middle of a turn, synchronously on the loop's
hot path until it settles (or the deadline fires).

The loop's own guarantees still hold around it: a handler cannot hang the turn
(the deadline), cannot fail the turn (its failure is attributed and answered),
and the payload it is handed is read-only typed. None of that is containment.
Install a loop-handlers plugin only if you would run its code directly.

Related: `<project>/.nax/plugins/` is loaded **without a consent prompt** for
every plugin type, including `loop-handlers`. A project-trust gate for plugins
is separate work.
