# Codex effort-suffix decomposition for acpx 0.13.x

**Status:** Design. Not implemented.
**Blocks:** upgrading the linked `acpx` from the 0.10.x fork to 0.13.x.
**Companion:** the acpx-side per-agent/per-node model feature is designed separately in
the acpx worktree (`~/workspace/sandbox/acpx-13/docs/2026-07-29-agent-and-node-model-design.md`,
deliberately uncommitted). That feature is independent of this one; neither blocks the other.

## 1. Problem

nax profiles name codex models with an effort suffix:

```json
// ~/.nax/profiles/codex-luna-review.json
{ "review": {
  "adversarial": { "model": { "agent": "codex", "model": "gpt-5.6-luna[high]" } },
  "semantic":    { "model": { "agent": "codex", "model": "gpt-5.6-luna[medium]" } } } }
```

`spawn-client.ts:205` passes that string to acpx verbatim as `--model`. On the 0.10.x fork
it works. On acpx 0.13.x it is a hard failure:

```
Cannot apply --model "gpt-5.6-luna[high]": the ACP agent did not advertise that model.
Available models: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini.
```

Eight profiles use the bracket form: `codex-luna-review`, `codex-mini-review`,
`cross-agent`, `cross-agent-cc`, `cross-agent-cd`, `cross-agent-ds`, `cross-agent-mm`,
`full-agents`.

## 2. Root cause

This is not an acpx regression, and not a change in what the adapter supports. codex-acp
advertises its models through two channels that disagree:

| Channel | Model ids | Effort |
|---|---|---|
| legacy `models.availableModels` | `gpt-5.6-luna[medium]`, `[high]`, `[max]` | inside the id |
| `configOptions` option `model` | `gpt-5.6-luna` (bare) | separate `reasoning_effort` option |

The bracket form is the identifier format of the legacy `session/set_model` API. Passing a
bare id to that API is rejected *by the adapter*:

```
acpx codex set model gpt-5.6-luna
-> Unsupported format of modelId: gpt-5.6-luna. Expected: modelId[effort].
```

acpx 0.10.x validates against the legacy list and calls `session/set_model`, so brackets
work. acpx 0.13.x prefers the config-option channel
(`modelStateFromConfigOptions(...) ?? modelStateFromLegacyResponse(...)`) and calls
`session/set_config_option`, so bare ids work and brackets do not.

Both are internally consistent. 0.13.x moved to the modern API, where model and effort are
two separate options. The bracket string is a nax-level convention that no longer maps onto
a single acpx concept, so nax should decompose it.

## 3. Why this is fixed in nax, not acpx

1. `model[effort]` is a nax profile convention. nax authored it; nax should own decomposing it.
2. It needs no acpx patch. `acpx <agent> set reasoning_effort <value> -s <session>` is
   public CLI, session-scoped, and persisted.
3. A translation shim in acpx would live in `src/acp/model-support.ts`, the file upstream
   rewrote between 0.10 and 0.13 and is still actively changing. Worst place to hold a fork.
4. Upstream precedent is against it: `examples/flows/pr-triage/TUNING.md` cites PR #128
   being pushed back on for adding "model-alias rewriting that was not needed."

## 4. Design

### 4.1 Parse

Add a small pure helper (own module, unit-testable in isolation):

```
parseModelSpec("gpt-5.6-luna[high]")  -> { model: "gpt-5.6-luna", effort: "high" }
parseModelSpec("gpt-5.6-luna")        -> { model: "gpt-5.6-luna", effort: undefined }
parseModelSpec("opus")                -> { model: "opus",         effort: undefined }
```

Only a well-formed trailing `[...]` is treated as an effort suffix. Anything else
(`luna[`, `luna]`, `lu[x]na`) is passed through untouched as a model id, so a malformed
value produces acpx's existing unadvertised-model error rather than a silent rewrite.

The helper is adapter-agnostic. It does not special-case codex; it decomposes the syntax
and lets the adapter reject values it does not advertise.

### 4.2 Apply

In `src/agents/acp/spawn-client.ts`:

- Pass `--model <model>` (the bare part) on every prompt, as today.
- When `effort` is present, issue `acpx <agent> set reasoning_effort <effort> -s <session>`
  **once, at session creation** — not per prompt.

Per-prompt for the model, once-per-session for the effort. That asymmetry is deliberate
and is explained by the verified behavior below.

### 4.3 Preserving the effort in headless and TUI output

`SpawnAcpSession` uses one field, `this.model`, for two jobs: the `--model` argv value **and** the
`model:` field on the `agent.call_started` stream event. That event is the only source of the
concrete model id in both user-facing surfaces:

| Surface | Render site | Fed by |
|---|---|---|
| headless | `src/log-format/formatter.ts:336-337` (`agent·model` badge) | `src/runtime/middleware/agent-stream-logging.ts:42` |
| TUI | `src/tui/components/LiveActivityPanel.tsx:154` (`model:<id>`) | `src/tui/hooks/useAgentStreamEvents.ts:68` |

Both currently show `gpt-5.6-luna[high]`. Making `this.model` bare without further change would
silently drop the effort from both — a display regression introduced by a correctness fix.

The field is therefore split: `model` (bare) for argv, `modelLabel` (the original profile string)
for the event. No event type, formatter, or TUI component changes; the rendered text stays
byte-identical to today. `modelLabel` is optional and defaults to `model`, so existing construction
sites are untouched.

Other model displays read `modelDef.model` (the raw profile string) directly and are unaffected:
the cost log (`src/agents/acp/adapter.ts:249-252`), metrics `modelUsed`
(`src/metrics/tracker.ts:117-127`), and `nax status --cost`. The TUI status bar and stories panel
show the model *tier*, not the id, and are likewise unaffected.

### 4.4 Why once per session, and why the model still goes per prompt

Both settings persist in the acpx session record, in different fields:

```
session_options:        { model: "gpt-5.6-luna" }
desired_config_options: { reasoning_effort: "high" }
```

Observed on 0.13.0: immediately after a `set` call the record briefly showed the adapter
default model, and the next prompt's `--model` restored the requested one. Since nax
already re-sends `--model` on every prompt, the model self-corrects and needs no extra care.

Effort has no such per-prompt carrier, so it must be established when the session is
created. It must also not be assumed to survive into a session nax did not create: if the
session-creation path is bypassed or a session is reused from elsewhere, the effort is
whatever that session already had.

## 5. Testing

- Unit on `parseModelSpec`: bracket form, bare form, each malformed shape passed through
  unchanged, and an unknown effort value passed through (the adapter, not nax, rejects it).
- Unit on the spawn path: with an effort suffix, exactly one `set reasoning_effort` call is
  issued per session and `--model` carries the bare id; without a suffix, no `set` call at all.
- Regression guard: assert the `set` call is not issued per prompt. A per-prompt `set` would
  be functionally invisible but would add a process spawn to every turn.
- Display guard: assert the `agent.call_started` event still carries the full `gpt-5.6-luna[high]`
  string while the argv carries the bare id, so headless and TUI keep showing the effort.
- The eight profiles stay unchanged. That is the acceptance criterion: they keep their
  bracket syntax and start working against 0.13.x.

## 6. Out of scope

- Changing profile syntax. The bracket form stays; it is readable and now has one clear
  owner.
- Any acpx patch for bracket compatibility.
- The acpx per-agent/per-node model feature, designed separately.

## 7. Cutover

The global `acpx` is npm-linked to `~/workspace/sandbox/acpx` (checked out on
`fix/opencode-model-config-option`). Upgrading is a separate, sequenced step:

1. Land this change and confirm green against a source build of 0.13.x.
2. Wait for any in-flight `nax run` to finish. Do not relink while a run is live.
3. Record the current link target, then relink.
4. Smoke-test one `nax run` review stage on a throwaway branch, exercising a
   bracket-suffixed profile end to end.
5. Keep the 0.10.x checkout in place as rollback until the smoke test passes.

## 8. Verification log

Against a source build of acpx `upstream/main` (reports 0.13.0) with the real codex adapter:

| Check | Result |
|---|---|
| `--model gpt-5.6-luna` (bare) | applied via `session/set_config_option`, no error |
| persisted | `session_options: {model: gpt-5.6-luna}`, `current_model_id: gpt-5.6-luna` |
| `--model 'gpt-5.6-luna[high]'` | rejected: "did not advertise that model" |
| `codex set reasoning_effort high -s <session>` | `config set: reasoning_effort=high (5 options)` |
| persisted | `desired_config_options: {reasoning_effort: high}` |
| model + effort together | both live on one session |
| bare id via legacy `set_model` (0.10.x) | rejected by adapter: "Expected: modelId[effort]" |
