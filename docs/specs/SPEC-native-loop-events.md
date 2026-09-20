# SPEC: Native loop events and tool-result policy

## Summary

Add a typed, in-process `before_tool` / `after_tool` event seam to the native session
turn loop, and use it to apply one tool-result truncation policy where five hand-rolled
truncators exist today. Truncation gains line and per-line caps, correct head-versus-tail
direction per tool, and a spill-to-scratchpad recovery path so a cut result is no longer
lost. The scratchpad gains the end-of-run wipe its shipped prompt text already promises.

## Motivation

Tool output reaches the model through a byte ceiling and nothing else. There is no line
cap, no per-line cap, and no way for the agent to recover what was cut.

The truncation policy is reimplemented in five files that have already drifted:
`read.ts:22-32`, `grep.ts:63-65`, `git.ts:327-329` and `scratchpad.ts:36-45` each carry
their own `truncate()`, while `bash.ts:113` truncates inline with
`body.slice(0, ctx.maxBytes)`. That last one is wrong twice over. `String.prototype.slice`
counts UTF-16 code units rather than bytes, so a multi-byte result is cut to a different
length than every other tool produces for the same ceiling. And it head-truncates a body
built as `exit ${code}\nstdout\nstderr`, so for a failing command with verbose stdout the
truncation discards precisely the `stderr` the agent needs — with no marker saying
anything was dropped.

Only `scratchpad.ts:36-45` handles a cut landing mid-codepoint correctly. A byte-aligned
slice ending inside a multi-byte codepoint decodes with a U+FFFD replacement character of
3 bytes, which can push the result past the budget it was sliced to.

The result is appended at seven separate sites in `turn-loop.ts`, so there is no single
point at which a policy could be applied even if one existed. Meanwhile two in-loop
policies that should be the vehicle for this — the spin breaker and the invalid-call
repair — already exist as inline branches in that same file, which sits at 527 of its
600-line hard limit.

Measured on one implementer story, two sessions: 206 and 198 tool calls totalling 222,355
and 502,827 bytes, with two Grep results landing exactly on the 40,000-byte cap. Roughly
10k tokens each, cut, unrecoverable, then carried on every remaining round trip of the
session. At a median of 45 round trips per session, one such result is paid for dozens of
times.

## Design

### Approach

The seam is built as **typed in-process function registrations**, not as an extension of
`src/hooks/`, and not as a general eleven-event map. Two events are built because two have
real consumers today: the spin breaker and invalid-call repair for `before_tool`, and the
truncation policy for `after_tool`.

Truncation is applied through `after_tool` rather than inside each tool, but the tools keep
a bound on their own I/O. A two-tier split is required: if the model-facing cap left the
tools entirely they would have to return unbounded content, trading a token problem for a
memory one.

- **I/O ceiling (tool layer, a safety bound):** tools bound their reads to `READ_CEILING`.
- **Model-facing policy (`after_tool`, one implementation):** `MODEL_MAX_BYTES`,
  `MODEL_MAX_LINES`, `MODEL_MAX_LINE_CHARS`.

The four constants take these values:

| constant | value | bounds |
|:---|---:|:---|
| `READ_CEILING` | 2_000_000 | bytes a tool may read before bounding its own work |
| `MODEL_MAX_BYTES` | 40_000 | UTF-8 bytes of model-facing content |
| `MODEL_MAX_LINES` | 1_000 | lines of model-facing content |
| `MODEL_MAX_LINE_CHARS` | 2_000 | UTF-16 code units per retained line |

The three model-facing caps must stay **independently reachable**, which constrains their
values: `MODEL_MAX_LINES * (MODEL_MAX_LINE_CHARS + 1)` must exceed `MODEL_MAX_BYTES`, so
that a body can sit at the byte ceiling while still satisfying the line and per-line caps.
Choosing values that violate this collapses the policy: if the largest body satisfying the
line caps is *smaller* than `MODEL_MAX_BYTES`, then the byte ceiling is unreachable by any
otherwise-compliant body, every boundary case trips two caps at once, and no test can
isolate one cap's behaviour from another's. At the values above the product is 2,001,000
against a 40,000-byte ceiling, so each cap is reachable on its own.

The event fires only for genuine tool executions. The turn loop's seven `tool-result` push
sites divide into two kinds, and the distinction is load-bearing:

**Genuine tool executions** — `:427` (a policy denial, carrying `denied` and deliberately
not `isError`), `:437` (the normal answer), `:446` (the catch-all for a tool that threw).

**Synthetic answers, where no tool ran** — `:366` (human Q&A budget spent), `:380` (no
operator reachable), `:388` (the human's own answer to `AskHuman`), `:407` (the spin-stop
notice, broadcast to every outstanding call in the batch so the next request carries no
unanswered `tool_call`).

All seven build their message through a shared chokepoint; only the first three fire the
event.

### Integration

This feature changes three declared shapes. Baselines are stated only to locate the code;
they are never the interface to implement.

**`ToolRunContext`** — `src/tools/registry.ts:47` (US-001, consumed US-003)
- Baseline: `{ root, resolvedPaths, maxBytes, maxFileBytes, denyPaths? }`, where `maxBytes`
  is documented as "Output ceiling in bytes; the tool truncates rather than the caller."
- Target: the same, plus an **optional** `readCeiling?: number` — the tool's I/O bound,
  resolving to `READ_CEILING` when absent. Optional is load-bearing, not a style choice:
  21 test files construct a `ToolRunContext` literal, and a required field would fail
  typecheck in all of them while test-authorship isolation bars US-001's implementer from
  editing 20 of them. It mirrors the existing optional `denyPaths?`. `maxBytes` is retained
  and keeps its value, but is no longer consumed by any tool for truncation; the session's
  `after_tool` policy owns the model-facing ceiling. `maxFileBytes` is unchanged and remains
  the whole-file bound for `Edit`/`Write`.

**`scratchpadReadTool.inputSchema`** — `src/tools/scratchpad.ts:119` (US-003)
- Baseline: `{ type: "object", properties: { path }, required: ["path"] }`.
- Target: the same, plus optional `offset` (1-based line number, integer minimum 1) and
  `limit` (maximum line count, integer minimum 1), matching `readTool`'s spelling at
  `src/tools/read.ts:59-60`.

**`RunCleanupOptions`** — `src/execution/lifecycle/run-cleanup.ts:51` (US-004)
- Baseline: carries `workdir: string` and `runCompleted?: boolean`, and has **no** `dryRun`
  field.
- Target: the same, plus `dryRun: boolean`. The caller at `src/execution/runner.ts:395` has
  `dryRun` in scope (declared at `:92`) and passes it through.

Symbols this feature reads but does **not** change:

- `wipeScratchpad(workdir, opts?: { dryRun?: boolean }): Promise<void>` —
  `src/execution/lifecycle/scratchpad-wipe.ts:44`. Already tolerates absence and swallows
  failure at warn level.
- `cleanupRun(options: RunCleanupOptions): Promise<void>` —
  `src/execution/lifecycle/run-cleanup.ts:206`, invoked from the runner's `finally` block.
  It does **not** invoke any scratchpad removal today — `wipeScratchpad` has exactly one
  call site, `run-setup-init.ts:120`, at run start. US-004's seam AC therefore describes
  wiring the story creates, not a path that already exists.
- `SCRATCHPAD_DIR = ".nax/scratchpad"` — `src/tools/scratchpad.ts:24`.
- `readPrefix` / `drainBounded` — `src/utils/bounded-io.ts`, the existing bounded-read
  helpers.
- `spinBreaker.observe(name, input)` / `.noteResult(name, input, answerText)` and
  `invalidCallBudget.observe(call, tools, messages)` — `turn-loop.ts:391`, `:399`, `:432`,
  `:441`. Their call shapes are the precedent the event contract generalises.

**Patterns to follow:** `src/tools/scratchpad.ts:36-45` is the only correct codepoint-
boundary slice in the codebase and is the base for the shared truncator. `src/tools/read.ts:78-137`
is the precedent for `offset`/`limit` line semantics and the `[N lines]` header.

### Event contract

The dispatcher enforces four rules, rather than leaving them to handler authors. These are
what let a future event be added without redesigning the seam.

1. **Results are partial patches, never mutations.** A handler returns only what it wants
   changed and the dispatcher merges. No handler receives the message array.
2. **Handlers chain**, each seeing the previous handler's output, in registration order.
3. **A throwing handler is logged at warn and skipped**, never failing the turn.
4. **No handler may rewrite history.** Measured prompt-cache hit rate on the native path is
   96.7%. Anthropic-style caching is prefix-matched, so rewriting anything early in the
   message array re-bills every downstream turn at input rather than cacheRead — roughly 5x
   more expensive, not cheaper. `after_tool` is safe by construction because it shapes a
   result before it enters the array.

`before_tool` outcomes are `allow` (optionally rewriting the tool's input), `nudge`
(prefixing the eventual result), `block` (answering without invoking the tool), and
`terminate` (answering every outstanding call in the current batch). `terminate` exists
because the spin breaker's stop is a batch-level outcome, not a per-call one.

`after_tool` may patch `content` and `isError`. It may **not** patch `denied`: a refused
Write is not a crashed Write, and letting a handler flip that erases a distinction the
model is meant to act on.

### Truncation policy

The three caps are independent triggers, and a body may break more than one at once. They
compose as an **ordered pipeline**, not as a set of alternatives — each stage runs on the
previous stage's output, and a body that trips several caps is subject to every stage that
applies to it. Being over one cap never buys a pass on another.

1. **Per-line cap.** Every line longer than `MODEL_MAX_LINE_CHARS` is shortened to that
   length. Runs first, so later stages count and measure already-shortened lines.
2. **Line-count cap.** If the body still has more than `MODEL_MAX_LINES` lines, the
   direction selects which to keep (see the table below). Runs before the byte cut, so the
   direction's choice of lines is made on the whole body rather than on a byte window of
   it.
3. **Byte cap.** If the result still exceeds `MODEL_MAX_BYTES`, it is cut on a codepoint
   boundary. Runs last, which is what makes the byte ceiling unconditional: because no
   stage follows, nothing can be appended or prepended after the cut, and the returned
   content is at most `MODEL_MAX_BYTES` for every input and either direction. Under
   `tail-with-first-line` the first line is retained inside this budget rather than in
   addition to it — the trailing slice is taken against the budget that remains after the
   first line and its newline, and if the first line alone does not fit, it is itself cut.

`truncated` is true when any stage changed the content, and `originalBytes` always reports
the input's full UTF-8 byte length regardless of which stages ran.

Lines are counted the way the rest of the tool layer counts them — `readFileSlice`'s
`totalLines` and `readTool`'s `[N lines]` header: a trailing newline **terminates** the
last line rather than opening an empty one, and an empty body has no lines. So `"a\nb\n"`
is two lines, not three. A raw `split("\n")` breaks this in two places: it truncates a body
that is within `MODEL_MAX_LINES`, and the phantom empty element becomes the line
`tail-with-first-line` keeps in place of the body's last real line.

### Truncation direction

| tool name | direction |
|:---|:---|
| `Read`, `Grep`, `Git`, `ScratchpadRead`, and any name not listed | `head` |
| `Bash`, `RunCommand`, `Exec` | `tail-with-first-line` |

Command output tails because the failure is at the end, but not naively: the body's first
line carries the exit code, so the policy preserves that line and then tails.

The tail is assembled line-wise, walking upwards from the body's last line, and each
candidate is charged the byte length it ARRIVES with. A line whose own size exceeds what is
left of the budget is SKIPPED WHOLE rather than shortened into the tail slot. This is the
rule, not an accident of the implementation: one runaway 160 KB stdout blob must not spend
the entire tail budget on a 2,000-character slice of itself and evict the short trailing
lines that actually carry the failure text. The consequence is deliberate and is what the
criteria below mean by "the body's final lines" — the trailing RUN of lines that fit, which
is not always the single last line.

### Spill file format

On truncation only, the full body — up to `READ_CEILING` — is written under the scratchpad
at `spill/<toolName>-<callId>.txt`, and the marker added to the model-facing content names
the path and both byte counts:

```
... [truncated: showing 40,000 of 512,433 bytes; full output at spill/Grep-a1b2c3d4.txt]
```

The marker's POSITION follows the direction, because the two cannot both be last. Under
`head` it is appended, so the content ends with it. Under `tail-with-first-line` the whole
point of the direction is that the body's final lines survive, so the marker sits between
the retained first line and the retained tail instead — the exit line, then the marker, then
the tail. When the budget leaves no room for a tail at all, the marker is simply last. Either
way it is inside the `MODEL_MAX_BYTES` budget, never added after the cut.

Anything the turn loop adds to a result AFTER the policy has run is charged against the
same ceiling, never added on top of it. Today that is the spin-breaker nudge, which
`withNudge` prepends: the loop reserves the nudge's bytes plus its separator from the
budget it hands the policy, so the content that reaches the model is at most
`MODEL_MAX_BYTES` WITH the nudge included. Enforcing the ceiling and then prepending
would break the guarantee by exactly the bytes the prefix adds, and the nudge fires
precisely when a session is already burning context.

The path in the marker is relative to the scratchpad directory, because `ScratchpadRead`
resolves paths relative to it. A body larger than `READ_CEILING` produces a spill file
whose own trailing line records that the spill is itself incomplete.

No policy or gitignore change is required: `spill/` sits under `SCRATCHPAD_DIR`, already
covered by the scratchpad tools' `confineTo` and by the existing gitignore entry at
`src/utils/gitignore.ts:93`.

The spill writer exposes its filesystem calls through an injectable `_spillDeps` object,
following `_scratchpadWipeDeps` in `src/execution/lifecycle/scratchpad-wipe.ts:28`. This is
required rather than stylistic: the spill-failure behaviour below has to be driven by a
rejecting dependency, and `mock.module()` is a forbidden pattern in this project. File
writes use Bun-native APIs, not the Node synchronous file APIs.

### Scratchpad lifecycle

`src/prompts/sections/scratchpad.ts:27` already tells every agent that "Nothing there
survives the run". That is false today: `wipeScratchpad` is called only at run start
(`run-setup-init.ts:120`), so files survive until the next run's wipe. The end-of-run wipe
makes shipped prompt text true, and matters more once the directory holds spilled output
rather than small notes.

Both wipes are kept, because they cover different failure modes. `cleanupRun` runs in a
`finally` block, which does not run on SIGKILL, a hard crash, or power loss — so the start
wipe remains the backstop that guarantees a clean slate however the previous run died. The
end wipe is gated on `runCompleted === true`: a failed run retains its scratchpad for
inspection, bounded because the next run's start wipe clears it.

Under `storyIsolation: worktree` a story's scratchpad lives inside its worktree and follows
that worktree's own removal lifecycle; `cleanupRun`'s `workdir` is the run-level checkout,
so the end wipe covers shared mode.

### Failure Handling

- A `before_tool` or `after_tool` handler that throws → fail-open: logged at warn, that
  handler skipped, remaining handlers still run, turn continues.
- A spill write that fails → fail-open: the result is still delivered truncated, and the
  marker omits the spill path rather than naming a file that does not exist.
- A body exceeding `READ_CEILING` → the spill file is written up to the ceiling and records
  that it is itself incomplete.
- An end-of-run scratchpad removal that fails → fail-open: logged at warn, `cleanupRun`
  still resolves, and the run's success is unaffected.
- `ScratchpadRead` with an `offset` past the end of the file → returns a message naming the
  file's total line count, mirroring `readTool`'s behaviour.
- `readFileSlice` with a non-positive `offset` or `limit` → rejects the request rather than
  computing a negative start index. `offset` is 1-based, so `offset` 0 would index one
  before the first line and silently return the file's tail. The tool-level schemas declare
  `minimum: 1`, but `readFileSlice` is called directly by other code and validates for
  itself rather than trusting its callers.

## Out of Scope

- The nine remaining in-loop events in pi's `HookMap` — `transform_context`,
  `before_request`, `before_payload`, `after_response`, `before_compaction`,
  `before_navigation`, `before_run`, `before_drive` and `before_run_end` — are not built.
- `transform_context` specifically is excluded by design rather than omission: at a 96.7%
  prefix-matched cache-hit rate, a history-rewriting handler makes the workload roughly 5x
  more expensive.
- Extending the orchestration hook subsystem under `src/hooks/` is not part of this work;
  those events fire around a story, shell out with a 5s timeout, and cannot carry a
  rewritten tool result.
- Trimming the advertised tool set, and bounding `advertisedSchemaBytes` in
  `src/tools/provider-advertise.ts`, are deferred; they belong at advertise time rather
  than per call.
- Making `readTool` populate `resultBytesPreTruncation`, which it never sets today, is
  deferred to a separate issue.
- Cross-model thinking-block replay on a fallback model swap (nax#2150) is deferred; it
  shares no code with this seam.
- Changing the compaction threshold or any model's configured `contextWindow` is not part
  of this work.
- Two concurrent nax runs sharing one workdir's scratchpad directory is not handled; the
  run lock is assumed to prevent it.
- US-003 only: rejecting invented range-argument aliases on `ScratchpadRead`, which
  `readTool` does at `src/tools/read.ts:70-76`, is deferred.
- Measuring a tail candidate line in its per-line-capped form, so that a body whose final
  line is one runaway blob still ends with the first `MODEL_MAX_LINE_CHARS` of that blob, is
  deliberately NOT implemented. It is incompatible with the skip rule under "Truncation
  direction" and with the AC3 and AC7 criteria as written, and implementing it regresses
  both. Revisit only by changing those criteria first.

## Stories

1. **US-001: Shared truncation policy and read core** — no dependencies
2. **US-002: Loop event seam and tool-result chokepoint** — no dependencies
3. **US-003: Truncation through `after_tool`, spill, and scratchpad paging** — depends on US-001, US-002
4. **US-004: End-of-run scratchpad wipe and contract text** — no dependencies
5. **US-005: Remove the superseded truncators** — depends on US-003

### Context Files

**US-001**

- `src/tools/scratchpad.ts` — its codepoint-boundary slice is the only correct one; base the shared truncator on it
- `src/tools/read.ts` — `offset`/`limit` line semantics, the `[N lines]` header, and the bounded/`+` floor logic to extract
- `src/tools/bash.ts` — the incorrect inline slice and the `exit N` body shape that drives tail direction
- `src/utils/bounded-io.ts` — `readPrefix` / `drainBounded`, the bounded-read helpers

**US-002**

- `src/agents/native/session/turn-loop.ts` — the seven push sites and the inline spin/invalid-call branches
- `src/agents/native/session/handle-invalid-tool-call.ts` — the invalid-call budget's observe shape
- `src/tools/registry.ts` — `ToolResult` and `CodingTool` shapes the event payload carries

**US-003**

- `src/tools/truncate.ts` — created by US-001, applied here
- `src/tools/read-file.ts` — created by US-001, backs the new `ScratchpadRead` range
- `src/agents/native/session/loop-events.ts` — created by US-002, the registration seam
- `src/tools/scratchpad.ts` — the tool gaining `offset`/`limit`, and `SCRATCHPAD_DIR`
- `src/tools/grep.ts` — its `drainBounded` bound moves to `readCeiling`

**US-004**

- `src/execution/lifecycle/run-cleanup.ts` — the `finally`-block cleanup and `RunCleanupOptions`
- `src/execution/lifecycle/scratchpad-wipe.ts` — the existing wipe and its tolerate-and-log contract
- `src/execution/runner.ts` — the `cleanupRun` call site that must pass `dryRun`
- `src/prompts/sections/scratchpad.ts` — the prompt text asserting what survives a run

**US-005**

- `src/tools/truncate.ts` — created by US-001; the replacement every deleted helper defers to

### Creates

**US-001**

- `src/tools/truncate.ts` — the single truncation policy and its constants
- `src/tools/read-file.ts` — `readFileSlice`, the shared ranged-read core

**US-002**

- `src/agents/native/session/loop-events.ts` — the typed event map and dispatcher
- `src/agents/native/session/tool-result.ts` — `buildToolResult`, the message chokepoint

**US-003**

- `src/tools/spill.ts` — writes an over-cap body under the scratchpad and returns its relative path
- `src/agents/native/session/truncation-handler.ts` — the `after_tool` handler that applies the policy

### Modifies

**US-001**

- `test/unit/tools/buffering-ceilings.test.ts` — asserts each tool bounds its work at `ctx.maxBytes`. US-001 introduces `READ_CEILING` as the tool-layer bound, so the ceiling these assertions name is no longer the one tools read. Replacing invariant: tools bound work at `ctx.readCeiling`, and `maxFileBytes` still bounds whole-file reads.

**US-002**

- `test/unit/agents/native/session/turn-loop-invalid-input.test.ts` — pins invalid-call repair as an inline branch of the turn loop. US-002 moves it onto `before_tool`. Replacing invariant: the same repair and stop behaviour, observed through a registered `before_tool` handler.
- `test/unit/agents/native/session/turn-loop-invalid-input-budget.test.ts` — pins the budget's stop behaviour against the inline branch. Replacing invariant: identical stop behaviour dispatched through the seam.
- `test/unit/agents/native/session/session-lifetime-spin.test.ts` — pins the spin breaker's nudge and terminal-notice behaviour against inline branches. Replacing invariant: the nudge is applied by an `after_tool` patch and the stop by a `before_tool` `terminate`, with the same observable messages.

**US-003**

- `test/unit/tools/grep.test.ts` — asserts Grep truncates its own output at `ctx.maxBytes` with its own marker. Under US-003 the tool returns up to `readCeiling` and the session truncates. Replacing invariant: the model-facing message is capped by the `after_tool` policy, and the tool's own return is bounded only by `readCeiling`.
- `test/unit/tools/bash.test.ts` — asserts Bash head-truncates at `ctx.maxBytes`. Replacing invariant: Bash returns up to `readCeiling`, and the policy preserves the `exit N` first line while tailing the remainder.
- `test/unit/tools/git.test.ts` — asserts Git truncates its own output with its own marker. Replacing invariant: as for Grep, the cap and marker come from the shared policy.
- `test/unit/tools/git-output-bounds.test.ts` — asserts the `truncated at N bytes` marker text Git emits. Replacing invariant: the marker is the shared policy's, naming both byte counts and the spill path.
- `test/unit/tools/scratchpad.test.ts` — its AC12/AC13 assertions pin `ScratchpadRead` truncating to `ctx.maxBytes` and returning a full-size `resultBytesPreTruncation`, and pin a two-field input schema. Replacing invariant: the schema gains `offset`/`limit`, the tool returns a `[N lines]` header, and the model-facing cap comes from the policy while `resultBytesPreTruncation` still reports the full size.
- `test/unit/tools/result-bytes-pre-truncation.test.ts` — pins `resultBytesPreTruncation` against tool-side truncation. Replacing invariant: the field still reports the full pre-truncation byte length, now measured before the session's policy runs.
- `test/unit/tools/read-line-total.test.ts` — pins `readTool`'s line-total and bounded/`+` behaviour against its inline implementation. Replacing invariant: identical behaviour, produced by `readFileSlice`.
- `test/unit/tools/scratchpad-read-paging.test.ts` — its "no synthesised terminator" case asserts `result.content` equals `"L3\nL4"` exactly, which the `[N lines]` header on a paged read necessarily breaks. Replacing invariant: the same no-synthesised-terminator guarantee, asserted against the header-led content.

**US-004**

- `test/unit/execution/lifecycle/scratchpad-wipe.test.ts` — pins the wipe as a run-start-only operation. Replacing invariant: the start wipe is unchanged and an end-of-run wipe additionally fires from `cleanupRun` when `runCompleted` is true and `dryRun` is false.
- `test/unit/prompts/sections/scratchpad.test.ts` — asserts the section's promise that nothing survives the run. Replacing invariant: the section states the scratchpad is wiped when a run finishes, retained after a failed run, and cleared at the next run's start.
- `test/unit/prompts/builders/tdd-builder.test.ts` — asserts the built TDD prompt contains "wiped at the start of each run", the exact sentence US-004 rewrites. Replacing invariant: the prompt contains the new end-of-run wording instead.
- `test/unit/prompts/adversarial-review-builder.test.ts` — same literal assertion on the adversarial-review prompt. Replacing invariant: as above.
- `test/unit/prompts/review-builder.test.ts` — same literal assertion on the semantic-review prompt. Replacing invariant: as above.
- `test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — 8 inline snapshots embed the old scratchpad sentence verbatim. Replacing invariant: the same snapshots carrying the new wording.
- `test/unit/prompts/__snapshots__/review-builder.test.ts.snap` — 2 snapshots embed the same sentence. Replacing invariant: as above.
- `test/unit/prompts/builders/__snapshots__/rectifier-builder-helpers.test.ts.snap` — 2 snapshots embed the same sentence. Replacing invariant: as above.

**US-005**

- `test/unit/tools/read-line-total.test.ts` — its AC6 case asserts an oversize unranged read
  contains `truncated`, i.e. that the floor header and `readTool`'s OWN marker coexist.
  Deleting that marker removes the string it looks for. Replacing invariant: the floor
  header is unchanged and the marker the model sees is the shared policy's, applied by the
  session rather than by the tool.
- `test/unit/tools/read-glob.test.ts` — "truncates beyond maxBytes and says so" and
  "truncation at maxBytes still applies to a ranged read" both pin `readTool` capping at
  `ctx.maxBytes` with its own marker. Replacing invariant: the tool returns up to
  `readCeiling` and the model-facing cap and marker come from the `after_tool` policy, the
  same move US-003 made for Grep, Git, Bash and ScratchpadRead.

### Seams

- `[integration]` US-003: register the truncation handler on a native session; drive a turn
  in which the provider returns a `Grep` tool call whose result exceeds `MODEL_MAX_BYTES`;
  assert `truncateForModel` (US-001) was invoked once with that body and the tool's `head`
  direction.
- `[integration]` US-003: drive a turn whose provider returns a `ScratchpadRead` call
  carrying `offset` and `limit`; assert `readFileSlice` (US-001) was invoked once with that
  offset and limit.
- `[integration]` US-003: drive a turn whose tool result is within every cap; assert the
  spill writer was not invoked.
- `[integration]` US-004: invoke `cleanupRun` with `runCompleted: true` and `dryRun: false`;
  assert the scratchpad removal dependency was invoked once with the path
  `<workdir>/.nax/scratchpad`.

## Acceptance Criteria

### US-001: Shared truncation policy and read core

- `[unit]` `truncateForModel` returns the body unchanged and `truncated` false when the body
  is within `MODEL_MAX_BYTES`, `MODEL_MAX_LINES` and `MODEL_MAX_LINE_CHARS`.
- `[unit]` `truncateForModel` returns `truncated` true and content whose UTF-8 byte length
  is at most `MODEL_MAX_BYTES` when given a body exceeding that ceiling.
- `[unit]` `truncateForModel` returns content whose UTF-8 byte length is at most
  `MODEL_MAX_BYTES` when the cut lands inside a multi-byte codepoint, rather than exceeding
  it by emitting a replacement character.
- `[unit]` `truncateForModel` returns content with at most `MODEL_MAX_LINES` lines when the
  body has more lines than that while within the byte and per-line ceilings.
- `[unit]` `truncateForModel` shortens any single line longer than `MODEL_MAX_LINE_CHARS` to
  that length in the returned content, for a body within the byte and line-count ceilings.
- `[unit]` `truncateForModel` applies both caps to a body that is within the byte ceiling
  but has both more than `MODEL_MAX_LINES` lines and a line longer than
  `MODEL_MAX_LINE_CHARS`: the returned content has at most `MODEL_MAX_LINES` lines and no
  line longer than `MODEL_MAX_LINE_CHARS`.
- `[unit]` `truncateForModel` returns content with no line longer than
  `MODEL_MAX_LINE_CHARS` for a body that both exceeds `MODEL_MAX_BYTES` and carries an
  over-long line, in addition to the byte ceiling being honored.
- `[unit]` `truncateForModel` with direction `tail-with-first-line` returns content whose
  UTF-8 byte length is at most `MODEL_MAX_BYTES` and whose first line is the body's first
  line, for a body exceeding that ceiling — the retained first line counts against the
  byte budget rather than being added on top of it.
- `[unit]` `truncateForModel` returns a body ending in a trailing newline unchanged and
  `truncated` false when it is within every cap counting that newline as terminating its
  last line rather than opening an empty one.
- `[unit]` `truncateForModel` with direction `tail-with-first-line` on a body that ends in a
  trailing newline and exceeds `MODEL_MAX_LINES` returns the body's last non-empty line as
  the last retained line.
- `[unit]` `truncateForModel` with direction `head` returns the body's first lines and omits
  its last line.
- `[unit]` `truncateForModel` with direction `tail-with-first-line` returns the body's first
  line followed by its last lines, and omits lines from the middle.
- `[unit]` `truncateForModel` returns `originalBytes` equal to the body's full UTF-8 byte
  length both when it truncated and when it did not.
- `[unit]` `truncationDirectionFor` returns `tail-with-first-line` for `Bash`, `RunCommand`
  and `Exec`.
- `[unit]` `truncationDirectionFor` returns `head` for `Read`, `Grep`, `Git`,
  `ScratchpadRead`, and for a tool name it does not recognise.
- `[unit]` `readFileSlice` with neither `offset` nor `limit` returns the file's whole
  contents and `bounded` false when the file is smaller than the supplied `readCeiling`.
- `[unit]` `readFileSlice` returns `bounded` true when the file is larger than the supplied
  `readCeiling`.
- `[unit]` `readFileSlice` with `offset` 3 and `limit` 2 returns the file's third and fourth
  lines.
- `[unit]` `readFileSlice` returns `totalLines` equal to the file's line count when the file
  is within `readCeiling`.
- `[unit]` `readFileSlice` with an `offset` greater than the file's line count returns empty
  content and that line count as `totalLines`.
- `[unit]` `readFileSlice` rejects an `offset` of 0 rather than returning the file's last
  line, and rejects a `limit` of 0.

### US-002: Loop event seam and tool-result chokepoint

- `[unit]` dispatching `after_tool` with no registered handler returns the payload's
  `content` and `isError` unchanged.
- `[unit]` dispatching `after_tool` with two registered handlers passes the first handler's
  returned `content` to the second handler as its payload `content`.
- `[unit]` dispatching `after_tool` with a handler that throws logs at warn level, skips
  that handler, and still applies a second registered handler's patch.
- `[unit]` an `after_tool` handler returning only `content` leaves the built message's
  `denied` value unchanged.
- `[unit]` a `before_tool` handler returning `allow` with an `input` value causes the tool to
  be invoked with that value rather than the model's original arguments.
- `[unit]` a `before_tool` handler returning `block` produces a tool-result carrying the
  handler's content and the tool is not invoked.
- `[unit]` a `before_tool` handler returning `terminate` produces one tool-result for every
  outstanding call in the current batch, each carrying the handler's content.
- `[unit]` a `before_tool` handler returning `nudge` causes the eventual tool-result content
  to begin with the handler's text.
- `[unit]` `buildToolResult` sets `toolCallId` on every message it returns.
- `[integration]` a turn in which the human Q&A budget is exhausted pushes a tool-result and
  invokes no registered `after_tool` handler.
- `[integration]` a turn in which no operator is reachable pushes a tool-result and invokes
  no registered `after_tool` handler.
- `[integration]` a turn answering an `AskHuman` call pushes the human's answer and invokes
  no registered `after_tool` handler.
- `[integration]` a turn in which the spin breaker stops the batch pushes its notice and
  invokes no registered `after_tool` handler.
- `[integration]` a turn in which the policy denies a tool call invokes a registered
  `after_tool` handler exactly once.
- `[integration]` a turn in which a tool returns normally invokes a registered `after_tool`
  handler exactly once.
- `[integration]` a turn in which a tool throws invokes a registered `after_tool` handler
  exactly once with `isError` true.
- `[integration]` a turn repeating an identical tool call past the spin threshold answers
  every outstanding call in the batch and ends the loop, as it does today.
- `[integration]` a turn exhausting the invalid-call budget ends the loop, as it does today.

### US-003: Truncation through `after_tool`, spill, and scratchpad paging

**Out of scope:** rejecting invented range-argument aliases on `ScratchpadRead` — `readTool`
does this at `src/tools/read.ts:70-76`, but adding it here is not required by this feature.
Also out of scope: measuring a tail candidate line in its per-line-capped form so a runaway
final line survives as a shortened slice — the skip rule under "Truncation direction" is the
intended behaviour and the criteria below pin it.

- `[integration]` a `Grep` tool result larger than `MODEL_MAX_BYTES` enters the message array
  with content whose UTF-8 byte length is at most `MODEL_MAX_BYTES` — including when a
  spin-breaker nudge is prepended to it, whose bytes are reserved from the same budget
  rather than added after the ceiling is enforced.
- `[integration]` a `Bash` tool result for a failing command with stdout larger than
  `MODEL_MAX_BYTES` enters the message array with content whose first line is the body's
  `exit N` line.
- `[integration]` that same `Bash` result enters the message array with content that ends
  with the body's final `stderr` lines — meaning the trailing run of body lines that fit the
  remaining byte budget, measured as each line arrives. A final line whose own size exceeds
  that budget is skipped, so the content ends with the last SHORT trailing line rather than
  with a shortened slice of the runaway one.
- `[unit]` a `Grep` invocation whose output exceeds `MODEL_MAX_BYTES` but is smaller than
  `READ_CEILING` returns that whole output from the tool, before any session policy runs.
- `[integration]` a truncated tool result writes a file under the scratchpad at
  `spill/<toolName>-<callId>.txt` whose contents are the untruncated body.
- `[integration]` the content of a truncated `head`-directed tool result ends with a marker
  naming the spill path, the delivered byte count, and the original byte count.
- `[integration]` the content of a truncated `tail-with-first-line` tool result carries that
  same marker immediately after the retained first line, with any retained tail following it
  — so the content ends with the body's final lines whenever the byte budget leaves room for
  a tail, and ends with the marker when it does not. "Room for a tail" is judged per line as
  it arrives: when every remaining candidate line is individually larger than the leftover
  budget, no tail is retained and the marker's delivered count is the retained first line
  alone.
- `[integration]` a tool result within every cap leaves the scratchpad's `spill` directory
  empty.
- `[integration]` when the spill write fails, the tool result still enters the message array
  truncated, and its marker names no spill path.
- `[unit]` a body larger than `READ_CEILING` produces a spill file whose final line records
  that the spill is itself incomplete.
- `[unit]` a tool invoked with a `ToolRunContext` whose `readCeiling` is absent bounds its
  read at `READ_CEILING` rather than at `maxBytes`.
- `[unit]` `ScratchpadRead` invoked with `offset` 3 and `limit` 2 returns the third and
  fourth lines of the named scratchpad file and no other file lines.
- `[unit]` `ScratchpadRead` returns content beginning with a `[N lines]` header reporting the
  file's line count, including when `offset` or `limit` is supplied. The header is not a file
  line, so it satisfies the preceding criterion rather than contradicting it.
- `[unit]` `ScratchpadRead` invoked with an `offset` past the file's last line returns a
  message naming the file's total line count.
- `[integration]` a spilled body larger than `MODEL_MAX_BYTES` is fully recoverable by
  invoking `ScratchpadRead` on the spill path with successive `offset` values.

### US-004: End-of-run scratchpad wipe and contract text

**Out of scope:** two concurrent runs sharing one workdir's scratchpad directory — the run
lock is assumed to prevent it, so no cross-run coordination is added.

- `[integration]` `cleanupRun` invoked with `runCompleted` true and `dryRun` false invokes the
  scratchpad removal dependency once with the path `<workdir>/.nax/scratchpad`.
- `[integration]` `cleanupRun` invoked with `runCompleted` false does not invoke the
  scratchpad removal dependency.
- `[integration]` `cleanupRun` invoked with `runCompleted` absent does not invoke the
  scratchpad removal dependency.
- `[integration]` `cleanupRun` invoked with `dryRun` true does not invoke the scratchpad
  removal dependency, even when `runCompleted` is true.
- `[integration]` `cleanupRun` resolves and logs at warn level when the scratchpad removal
  dependency rejects.
- `[unit]` `wipeScratchpad` still removes the scratchpad directory when invoked at run start,
  regardless of any previous run's outcome.
- `[unit]` `buildScratchpadSection` returns text stating that the scratchpad is wiped when a
  run finishes and that a failed run's scratchpad is retained.
- `[unit]` the `ScratchpadWrite` tool's advertised description states that the scratchpad is
  wiped when a run finishes rather than only at the start of each run.

### US-005: Remove the superseded truncators

**Scope — what is deleted.** Only the MODEL-FACING cap: the private `truncate()` in
`src/tools/read.ts` (called at `ctx.maxBytes`) and in `src/tools/scratchpad.ts` (likewise).
`src/tools/bash.ts` is already done — US-003 replaced its inline slice with
`cutToByteCap(body, ctx.readCeiling ?? READ_CEILING)`, so there is nothing left to remove
there and no edit to that file is expected.

**Scope — what STAYS.** The `truncate()` calls in `src/tools/grep.ts` and `src/tools/git.ts`
bound at `ioCeiling` (`ctx.readCeiling ?? READ_CEILING`), NOT at `ctx.maxBytes`. That is the
tool-layer I/O ceiling US-001 introduced, not the superseded model-facing cap, and it is not
part of this deletion. Removing it would drop a real bound silently — no current test fails
when it goes — so the criterion below pins it instead.

**Verification note:** removal is verified by `bun run typecheck && bun run lint` — the
compiler and linter reject any surviving reference to, or unused definition of, the deleted
helpers.

- `[integration]` after the deletions, a `Grep` result larger than `MODEL_MAX_BYTES` still
  enters the message array with content whose UTF-8 byte length is at most
  `MODEL_MAX_BYTES`.
- `[integration]` after the deletions, a `Git` result larger than `MODEL_MAX_BYTES` still
  enters the message array with a marker naming its original byte count.
- `[unit]` after the deletions, `Grep` and `Git` invoked with a `ToolRunContext` whose
  `readCeiling` is set still return at most that many bytes from the tool itself, before any
  session policy runs.

<!-- spec-writing: completed-through-phase-6 -->
