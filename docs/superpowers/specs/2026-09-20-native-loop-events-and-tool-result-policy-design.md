# Native loop events and tool-result policy — design

Date: 2026-09-20
Issue: nax#2151
Base: `origin/main` @ `d0af01c39`
Branch: `feat/native-loop-events`

Every file and line reference in this document was verified against `d0af01c39`.

---

## 1. Problem

Tool output reaches the model through a byte ceiling and nothing else.

There is no line cap, no per-line cap, and no way for the agent to recover what was
cut. The truncation policy is reimplemented in **five** files that have already
drifted apart, and the result is appended to the message array at **seven**
separate sites in the turn loop, so there is no single point at which a policy
could be applied even if one existed.

Two in-loop policies that *should* be the vehicle for this — the spin breaker and
the invalid-call repair — already exist, but as inline branches in
`turn-loop.ts`, which is at 527 of its 600-line hard limit.

### 1.1 The five truncators

| site | implementation | semantics | marker |
|---|---|---|---|
| `src/tools/read.ts:22-32` | own `truncate()` | bytes (Buffer) | yes, budgeted for the suffix |
| `src/tools/grep.ts:63-65` | own `truncate()` | bytes (Buffer) | yes |
| `src/tools/git.ts:327-329` | own `truncate()` | bytes (Buffer) | yes |
| `src/tools/scratchpad.ts:36-45` | own byte-boundary slice | bytes, codepoint-safe | yes |
| `src/tools/bash.ts:113` | inline `body.slice(0, ctx.maxBytes)` | **UTF-16 code units** | **none** |

`bash.ts` is wrong twice over. `String.prototype.slice` counts UTF-16 code units,
not bytes, so a multi-byte result is cut to a different length than every other
tool produces for the same ceiling. And it head-truncates:

```ts
const body = result.timedOut
  ? `timed out after ${timeoutMs}ms`
  : `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
return {
  content: body.slice(0, ctx.maxBytes),
```

`stderr` is concatenated **last**. For a failing command with verbose stdout — a
test run, a build, exactly the commands that matter — truncation discards
precisely the stderr the agent needs, with no marker saying anything was dropped.
`resultBytesPreTruncation` is recorded for the audit sink; the model is told
nothing.

Of the five, only `scratchpad.ts:36-45` handles a slice landing mid-codepoint
correctly. A byte-aligned slice that ends inside a multi-byte codepoint decodes
with a U+FFFD replacement character (3 bytes), which can push the resulting string
*past* the byte budget it was sliced to.

### 1.2 The seven push sites are not homogeneous

`src/agents/native/session/turn-loop.ts` pushes a `tool-result` at `:366`, `:380`,
`:388`, `:407`, `:427`, `:437`, `:446`. They divide into two kinds:

**Genuine tool executions** — a tool ran and produced this:
- `:427` — a policy denial (carries `denied`, deliberately **not** `isError`)
- `:437` — the normal answer
- `:446` — the catch-all for a tool that threw

**Synthetic answers** — no tool ran:
- `:366` — the human Q&A budget is spent
- `:380` — no operator is reachable
- `:388` — the human's own answer to `AskHuman`
- `:407` — the spin-stop notice, broadcast to *every outstanding call in the
  batch* so the next request carries no unanswered `tool_call`

This distinction is load-bearing. Truncation, and any future `after_tool`
handler, must fire only for the first kind. Treating "everything that pushes a
tool-result" as the event would run handlers over synthetic notices that never
had a tool behind them.

### 1.3 Measured impact

One implementer story, two sessions, from the local tool-audit ledger:

```
session A: 206 calls  Read 81 / Grep 54 / RunCommand 36 / Edit 26 / Git 8   total 222,355 B
session B: 198 calls  Read 75 / Edit 40 / RunCommand 39 / Grep 36 / Git 5   total 502,827 B
largest results: Grep 40,019 B  Grep 39,985 B  Grep 24,989 B  Read 32,940 B  Read 25,740 B
```

Two grep results land exactly on the 40 KB cap — roughly 10k tokens each — cut,
unrecoverable, then carried on every remaining round trip of the session
(nax#2056). At a measured median of 45 round trips per session, one such result
is paid for dozens of times.

---

## 2. Scope

**In scope:**
- A typed, in-process `before_tool` / `after_tool` event seam in the native session.
- One truncation policy, implemented once, applied through `after_tool`.
- Spill-to-scratchpad so truncation stops being lossy, with `offset`/`limit` on
  `ScratchpadRead` so a spilled file can actually be paged back.
- An end-of-run scratchpad wipe, and correction of the shipped prompt text that
  already promises one.

**Out of scope, deliberately:**
- **The other nine events in pi's `HookMap`.** Two events are built because two
  have real consumers today. `transform_context` in particular is excluded by
  design, not omission — see §3.4.
- **Any extension of `src/hooks/`.** That subsystem is orchestration-only
  (`src/hooks/types.ts:8-21` — every event fires around a *story*), shell-out
  based with a 5s default timeout (`types.ts:28-32`), and its return channel
  cannot carry a rewritten result. At a median 45 round trips per session (max
  418) a shell-out per tool call is a non-starter. This is a distinct,
  in-process seam. `hooks.json` keeps orchestration events, where 5s is fine.
- **Trimming the advertised tool set** and bounding `advertisedSchemaBytes`
  (`src/tools/provider-advertise.ts:79-85`). Belongs at advertise time, not per
  call.
- **`Read` never setting `resultBytesPreTruncation`.** A real telemetry hole on
  the most-called tool, but independent of this work. To be filed separately.
- **nax#2150** (a fallback model swap replays the previous model's thinking
  blocks). Shares no code with this seam.

---

## 3. Design — the event seam

### 3.1 The contract already exists, hardcoded

This is not an invented abstraction. Two in-loop policies already have exactly
this shape:

```ts
// turn-loop.ts:391 — before the tool runs
const invalid = invalidCallBudget.observe(call, tools, messages);
// turn-loop.ts:399 — before the tool runs
const verdict = spinBreaker?.observe(call.name, call.input) ?? { action: "allow" };
// turn-loop.ts:432, :441 — after it ran
spinBreaker?.noteResult(call.name, call.input, answerText);
```

The spin breaker's `nudge` even rewrites result content inline —
`` `[nax] ${verdict.text}\n\n---\n\n${answer}` `` — duplicated at `:427` and
`:437`. That is an `after_tool` content rewrite, written twice, in a file with
73 lines of headroom.

The seam generalises what is already there rather than adding a new concept.

### 3.2 The event map

```ts
// src/agents/native/session/loop-events.ts
interface NativeLoopEvents {
  before_tool: {
    payload: { call: ToolCall; tools: readonly CodingTool[]; roundTrip: number };
    result: BeforeToolResult;
  };
  after_tool: {
    payload: { call: ToolCall; content: string; isError?: boolean; denied?: DenialInfo };
    result: AfterToolResult;
  };
}

type BeforeToolResult =
  | { action: "allow"; input?: unknown }            // optionally rewrite args
  | { action: "nudge"; text: string }               // prefix the eventual result
  | { action: "block"; content: string; isError?: boolean }
  | { action: "terminate"; content: string };       // answers the whole batch

type AfterToolResult = Partial<{ content: string; isError: boolean }>;
```

`terminate` exists because the spin breaker's stop is a **batch-level** outcome,
not a per-call one: every outstanding call in the current batch must be answered
or the next request carries an unanswered `tool_call`, which strict providers
reject (`turn-loop.ts:405-411`).

`denied` is passed to handlers but is **not patchable**. A refused Write is not a
crashed Write (ADR-029 §5); letting a handler flip that erases a distinction the
model is meant to act on.

### 3.3 Dispatcher rules

Four rules, all enforced by the dispatcher rather than left to handler authors.
These are what let a future event drop in without redesign.

1. **Results are partial patches, never mutations.** A handler returns only what
   it wants changed and the dispatcher merges. No handler ever receives
   `messages`.
2. **Handlers chain**, each seeing the previous handler's output, in registration
   order. This mirrors pi's `transform_context` chaining
   (`packages/agent/src/harness/hooks.ts:188-215`).
3. **A throwing handler is logged and skipped**, never failing the turn — also
   pi's behaviour.
4. **No handler may rewrite history.** The load-bearing rule. See §3.4.

Adding a future event means adding one entry to `NativeLoopEvents` and one
dispatch call site. The dispatcher itself does not change.

### 3.4 Why rule 4 exists, and why `transform_context` is excluded

Measured cache-hit rate on the native path is **96.7%**, with uncached input
typically 100–500 tokens per round trip against a 200k+ prefix. Anthropic-style
caching is *prefix-matched*: rewriting anything early in the message array
re-bills every downstream turn at `input` rather than `cacheRead`. On MiniMax-M3
those rates are 0.3/1M against 0.06/1M — a naive "trim old messages each turn"
handler would make the workload roughly **5x more expensive**, not cheaper.

This is precisely why pi's compaction *resets a boundary* rather than editing
history in place: `readBoundedEntries` scans back and stops at the last
`compaction` entry (`packages/agent/src/harness/runtime/transcript.ts:47-56`).

`after_tool` is safe by construction — it shapes a result *before* it enters the
array, leaving the prefix untouched. Rule 4 is what keeps that property true of
every future event too, instead of relying on each author to know the above.

### 3.5 The chokepoint is separate from the event

A `buildToolResult()` helper in `src/agents/native/session/tool-result.ts`
constructs the message shape for **all seven** sites, so invariants like
"`toolCallId` is always set" live in one place.

The four synthetic sites (§1.2) use the chokepoint and **do not fire the event**.
The three genuine sites use both.

### 3.6 File placement

Two new files keep `turn-loop.ts` under its ceiling:

- `src/agents/native/session/loop-events.ts` — map, dispatcher, registration
- `src/agents/native/session/tool-result.ts` — `buildToolResult()`

Collapsing the inline spin/nudge/denial branches onto the seam should leave
`turn-loop.ts` net smaller than its current 527 lines.

---

## 4. Design — truncation policy

### 4.1 Two tiers

Truncation cannot simply move to `after_tool`. Tools bound their reads
deliberately today — `readPrefix(target, ctx.maxBytes)` in `read.ts:89`,
`drainBounded(proc.stdout, ctx.maxBytes)` in `grep.ts:129`. If the model-facing
cap left the tools entirely they would have to return unbounded content, trading
a token problem for a memory one.

- **I/O ceiling (tool layer, a safety bound):** tools bound reads to a new
  `SPILL_CEILING = 1_000_000` rather than `40_000`. Nothing unbounded enters
  memory.
- **Model-facing policy (`after_tool`, one implementation):**
  `MAX_BYTES = 40_000` (unchanged), `MAX_LINES = 2_000`,
  `MAX_LINE_CHARS = 500`.

The line and per-line values match pi's
(`packages/coding-agent/src/core/tools/truncate.ts:11-13`).

### 4.2 One implementation

`src/tools/truncate.ts` becomes the only truncator. The five listed in §1.1 are
deleted. The codepoint-boundary backup logic from `scratchpad.ts:36-45` is the
base, since it is the only correct one.

### 4.3 Head versus tail

| tool | direction |
|---|---|
| `Read`, `Grep`, `Git`, `ScratchpadRead`, unknown / MCP tools | head |
| `Bash` / `RunCommand` / `Exec` | **first line, then tail** |

Command output tails because the failure is at the end. But not a naive tail:
`bash.ts:110` builds `exit ${code}\nstdout\nstderr`, so a pure tail drops the
exit line. The policy preserves the first line, then tails. This is the concrete
fix for §1.1's silently-discarded stderr.

Tool kind is resolved from `call.name`, with head as the default for any tool not
named — an unknown or MCP tool gets the conservative behaviour.

### 4.4 Spill

On truncation only, the full body (up to `SPILL_CEILING`) is written to
`.nax/scratchpad/spill/<tool>-<callId>.txt`, and the marker names both the path
and what was cut:

```
... [truncated: showing 40,000 of 512,433 bytes; full output at spill/Grep-a1b2.txt]
```

Past `SPILL_CEILING` the spill file is itself marked truncated. That is an honest
bound, stated in the marker rather than implied away.

No policy or gitignore change is required: `spill/` sits under `SCRATCHPAD_DIR`,
which is already covered by the tools' `confineTo` and by the existing
`**/`-prefixed gitignore entry (`src/utils/gitignore.ts:93`).

### 4.5 `ScratchpadRead` gains `offset` / `limit`

Without this, spill is decorative. `ScratchpadRead` (`scratchpad.ts:119-124`) has
only a `path` field and always returns the head prefix up to `ctx.maxBytes` — so
reading a spilled 500 KB grep back would return *the same first 40 KB*.

`Read` already has `offset`/`limit` with 1-based line semantics
(`read.ts:59-60`), but it is the unconfined repo-root tool; routing spill
recovery through it when a confined tool for that exact directory exists would be
incoherent.

### 4.6 Shared read core — extract, do not extend

`CodingTool` is a plain object literal with a `run` function. There is no class to
extend, so "extending" `Read` would mean object-spreading it. That silently
inherits Read's **description** — contract text re-sent to the model every round
trip — along with its error shape and its `[N lines]` header, breaking two pinned
scratchpad ACs:

| | `Read` | `ScratchpadRead` |
|---|---|---|
| `[N lines]` header | always | none |
| `resultBytesPreTruncation` | never set | full byte size (AC13) |
| error content | raw message | `cannot read "<path>": …` (AC7) |
| `offset`/`limit`, alias rejection | yes | no |

Instead, extract the shared core to `src/tools/read-file.ts`:

```ts
readFileSlice(target, { maxBytes, maxFileBytes, offset, limit })
```

covering the `readPrefix` call, `parsePositiveInt`, `countLines`, the line
slicing, and the bounded/`+` floor logic — currently ~60 lines living only in
`read.ts`. Both tools call it and each keeps its own name, description, scope,
error shape and result fields. Both files shrink; neither tool's model-facing
contract is coupled to the other's.

**One deliberate model-visible change:** `ScratchpadRead` gains the `[N lines]`
header. No AC pins its absence, and a spilled file is exactly the case where the
agent needs to know how many lines it is paging through.

---

## 5. Design — scratchpad lifecycle

### 5.1 This fixes a false promise, it does not change the contract

`src/prompts/sections/scratchpad.ts:27` already tells every agent:

> Its contents are wiped at the start of each run and are never committed.
> **Nothing there survives the run**, reaches the repository, or is read by
> another step.

The emphasised clause is false today. `wipeScratchpad` is called only at run
start (`run-setup-init.ts:120`); files survive until the *next* run's wipe. The
end-of-run wipe makes shipped prompt text true.

It also becomes materially more important under §4.4: the scratchpad goes from
holding small agent notes to holding megabytes of spilled tool output.

### 5.2 Both wipes, different failure modes

- **Start wipe stays unconditional.** `cleanupRun` runs in a `finally` block,
  which does not run on SIGKILL, a hard crash, or power loss. The start wipe is
  the crash backstop that guarantees a clean slate however the previous run died.
- **End wipe added to `cleanupRun`** (`run-cleanup.ts:206`), gated on
  `runCompleted === true` (`RunCleanupOptions.runCompleted`, already present and
  already documented as the success signal), and skipped under `dryRun` like its
  sibling.

A failed run **retains** its scratchpad for inspection. Today a failed run's
scratchpad survives, and an unconditional end wipe would remove that exactly when
it is most useful. Retention stays bounded because the next run's start wipe
clears it.

The end wipe inherits the existing tolerate-and-log failure contract: a scratch
directory must never wedge a run, least of all one that already succeeded.

### 5.3 Text that must change in the same commit

The agent reads this text, so a stale promise is a defect, not a docs nit:

- `src/tools/scratchpad.ts:77` — `ScratchpadWrite`'s description
- `src/prompts/sections/scratchpad.ts:27` — the prompt section
- `src/execution/lifecycle/scratchpad-wipe.ts:5` — module docstring
- `src/execution/lifecycle/run-setup-init.ts:111` — call-site comment

New wording must carry all three facts: wiped when a run finishes, **kept after a
failed run for inspection**, cleared at the next run's start either way.

### 5.4 Worktree interaction

`cleanupRun`'s `workdir` is the run-level checkout, so the end wipe covers shared
mode. Under `storyIsolation: worktree` a story's scratchpad lives inside its
worktree and follows that worktree's own removal lifecycle
(`removeWorktreeDirectory`, `pipeline-result-handler.ts`). That is consistent
with retain-on-failure — a retained worktree keeps its scratchpad — but the
implementation must assert it rather than assume it.

---

## 6. Testing

- **Dispatcher:** chaining order; a throwing handler is skipped and logged, not
  fatal; a partial patch merges without clobbering unset fields; `denied`
  survives an `after_tool` handler that returns `{ content }`.
- **Event vs chokepoint:** all four synthetic sites build a result and fire **no**
  `after_tool` event; all three genuine sites fire exactly one.
- **`terminate`:** every outstanding call in the batch is answered, so no
  unanswered `tool_call` reaches the next request.
- **Truncation:** byte, line and per-line caps each fire independently; a
  multi-byte codepoint at the boundary never pushes output past the byte budget;
  `Bash` preserves the `exit N` line and keeps the tail, and stderr survives a
  verbose failing command.
- **Spill:** written only when truncation occurred; marker names the real path and
  real byte counts; content past `SPILL_CEILING` is itself marked; the spilled
  file is readable back through `ScratchpadRead` with `offset`/`limit`.
- **Read core:** `Read` and `ScratchpadRead` keep their distinct headers, error
  shapes and `resultBytesPreTruncation` behaviour after extraction (AC7, AC13).
- **Lifecycle:** end wipe fires on `runCompleted`, is skipped on failure, is
  skipped under `dryRun`; a wipe failure logs and does not fail the run.

---

## 7. Sequencing

1. `truncate.ts` + `read-file.ts` extraction, deleting the five truncators. No
   behaviour change beyond `bash.ts` becoming byte-correct.
2. `loop-events.ts` + `tool-result.ts`; migrate the seven push sites; move the
   spin breaker and invalid-call repair onto the seam.
3. Truncation policy as the first `after_tool` handler; head/tail by tool kind.
4. Spill + `ScratchpadRead` `offset`/`limit`.
5. Scratchpad end-of-run wipe + contract text.

1 and 5 are independent of the rest and of each other.

---

## Appendix — verification

All citations verified at `d0af01c39`. Measurements come from the local run
ledgers under `~/.nax/<project>/cost/*.jsonl` (one row per session),
`~/.nax/<project>/usage/*.jsonl` (one row per round trip; per-round-trip context
is `input + cacheRead`), and `~/.nax/<project>/tool-audit/<feature>/<session>.json`
(`tool`, `outcome`, `input`, `resultBytes`).

Background analysis: `projects/nax/nax-pi-harness-gap-analysis-2026-09-19.md`
§3, §4 and §9.
