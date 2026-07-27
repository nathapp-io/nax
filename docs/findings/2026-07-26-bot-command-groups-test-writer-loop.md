# Test-writer runaway tool-call loop — three safety nets missed it

**Date:** 2026-07-26 (revised 2026-07-27)
**Reporter:** diagnosis via `/nax-diagnose`
**Downstream project:** rs-stock (`bot-command-groups`, US-001)
**Status:** Root cause fixed upstream in rtk 0.44.0. **One nax-side fix
recommended — Fix C (§6).** All other proposed fixes retired; see §6 for the
reasoning before re-proposing any of them.

> **Root cause (short version).** rtk **0.43.0**'s rewrite hook stripped the
> `uv run` prefix, so pytest was spawned outside the project environment and
> genuinely collected nothing (exit 5). rtk honestly reported `No tests
> collected`; the `ImportError` never occurred because the module was never
> imported. The agent then searched pytest's *configuration* space for a fault
> that lived in the *process-spawn* layer — a space its hypotheses could not
> reach. Fixed in rtk **0.44.0**; verified in §3.2. The nax-side gaps (§6)
> remain open and are the actionable part.
>
> **2026-07-27 revision.** Follow-up investigation changed four things:
> §5 Net 3's open question is answered (the fail-stale ladder — §5.4); pytest
> and xdist were experimentally cleared as contributing causes (§3.1); the root
> cause was pinned to rtk 0.43.0 stripping `uv run`, fixed in 0.44.0 and
> verified against the live repo (§3.2–3.3); and the fix set was cut from six
> items to one after review (§6). The profile mismatch noted in §2 was a
> deliberate manual override by the operator and is not a finding — disregard
> it.

---

## 1. Summary

A test-writer session burned **~7,900 tool calls inside a single agent turn**,
re-running the same `pytest` command with cosmetic flag variations for over
3.5 hours. It was stopped only by a human Ctrl-C — twice.

The trigger was a benign, *expected* RED-phase `ImportError` that the agent
could not see, because `rtk pytest`'s output filter collapses collection
errors into a generic `No tests collected` line with no traceback.

The reason it ran for hours rather than seconds is the interesting part:
**nax has three independent safety nets against runaway agents, and this
failure mode slipped past all three.** One of them (the wall-clock timeout)
actively made things worse by restarting the loop every hour instead of
failing the story.

---

## 2. Run facts

| Field | Value |
|:---|:---|
| Runs | `run-2026-07-26T11-17-52-280Z`, `run-2026-07-26T15-08-15-837Z` |
| Story | US-001 "Qualified command registry and routing" |
| Strategy / complexity | `three-session-tdd-lite` / `complex`, tier `powerful` |
| Session | `nax-70d60539-bot-command-groups-us-001-test-writer` |
| acpx session | `ses_061ce722fffeCs0okQ37HdA046` |
| Agent / model | `opencode` / `minimax/MiniMax-M3` |
| Per-turn wall clock | `--timeout 3600` (1 h) |
| Both runs ended by | manual SIGINT (`exitReason: "sigint"`, exit 130) |

Profile mismatch worth noting (logged as a warn, not causal here):

```
PRD was planned with config profile "codex-plan" but this run resolved profile
"opencode-mm+codex-luna-review" — the escalation ladder and agent profiles may
differ from what plan assumed.
```

---

## 3. Root cause of the loop trigger

The test-writer wrote `apps/api/tests/test_qualified_command_registry.py`
**once, correctly**, importing symbols the implementer had not written yet:

```python
from stock_api._bot_commands import COMMANDS, GROUPS, _LEGACY_HINTS, route_command
```

`GROUPS` and `_LEGACY_HINTS` did not exist in `stock_api/_bot_commands.py`.
That is a pytest **collection-time** failure, not an assertion failure:

```
ImportError: cannot import name 'GROUPS' from 'stock_api._bot_commands'
```

The agent ran pytest through `rtk pytest` — which the `rtk-rewrite.sh`
PreToolUse hook (`~/.claude/hooks/rtk-rewrite.sh`) substitutes for **any**
`pytest` / `uv run pytest` invocation, even a "plain" one typed by a human.
`rtk pytest` renders both "0 tests matched the selector" and "0 tests ran
because the module failed to import" as the same string:

```
Pytest: No tests collected
```

with the traceback discarded. So the agent saw an outcome consistent with a
pytest *configuration* problem, and behaved accordingly — cycling through
plain, `-q`, `-q -n 0`, `--override-ini addopts=`, and
`--override-ini testpaths=tests` in an attempt to make collection work.

### 3.1 pytest is not a contributing cause — `rtk` is the sole blindfold

The original pass left open whether pytest would have hidden the error anyway.
It would not. rs-stock's `apps/api/pyproject.toml:59` bakes xdist into every
invocation:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers -n auto --dist worksteal"
timeout = 300
```

An isolated reproduction of that exact config (pytest 9.1.1 + pytest-xdist,
a test module importing a name that does not exist) gives:

| Invocation | Traceback shown? | Exit |
|:---|:---|---:|
| `-n auto` (as configured) | **yes** — full `ImportError: cannot import name …` | **1** |
| `-n 0` | yes — `Interrupted: 1 error during collection` | **2** |
| genuinely zero tests | n/a | **5** |

Two conclusions:

1. **xdist does not suppress collection tracebacks.** It renders them through
   the worker protocol, but the `ImportError` and its traceback appear in full.
   An earlier hypothesis that xdist was a second, independent blindfold is
   **refuted** — plain `uv run pytest`, with or without `-n auto`, would have
   shown the agent exactly what was wrong.
2. **The exit code discriminates the two cases in every configuration.** A
   collection error exits 1 (under xdist) or 2 (single-process); "no tests
   collected" exits 5. These never collide.

The original diagnosis attributed the blindness to `rtk pytest` collapsing
exit-1, exit-2, and exit-5 into a single `Pytest: No tests collected` string.
**That is not reproducible on the current rtk** — see §3.2, which tests it
directly against the real repository.

This also means **the agent's diagnostic reasoning was correct.** It deduced
that `addopts` was hiding something and systematically tried to disable xdist
— `-n 0`, then `--override-ini addopts=` outright. That is the right move, and
run raw it would have worked on the first attempt. Because the rewrite hook
applied to the workaround too, the correct hypothesis returned the same
`No tests collected` and was discarded as disproven. Then it was retried 4,897
times.

The incident is therefore better characterised as **instrument failure** than
as a runaway agent. The agent behaved reasonably given a feedback channel that
reported "your fix didn't work" when the fix had in fact worked.

### 3.2 The blindfold is NOT reproducible on rtk 0.44.0

Tested directly against rs-stock `main` (`06d7c15c`) in an isolated worktree,
using a probe module that imports a name which does not exist in
`stock_api._bot_commands` — the exact failure shape from the incident:

| Command | Output | Exit |
|:---|:---|---:|
| `uv run pytest …probe.py -q` | full `ImportError: cannot import name …` + traceback | 1 |
| `uv run rtk pytest …probe.py -q` | **traceback preserved** — identical to raw pytest | 1 |
| `uv run rtk pytest …probe.py -q -n 0` | `Interrupted: 1 error during collection` | 2 |
| `uv run rtk pytest …test_health.py -k no_match` | `Pytest: No tests collected` | 5 |

Grepped assertions on the `rtk pytest` run: `cannot import name` present
(1 hit), `no tests collected` absent (0 hits).

**rtk 0.44.0 already draws the distinction correctly.** `Pytest: No tests
collected` is emitted *only* for the genuine exit-5 case; a collection error
passes the traceback through untouched. The §8 upstream request is therefore
already satisfied on this version — do not file it.

### 3.3 Attribution: rtk 0.43.0 lacked `uv run` support

The incident ran on **rtk 0.43.0**. `uv run` support landed in **0.44.0**.
That closes the gap, and this document's own §8 already recorded the smoking
gun without recognising it:

> Verified directly: `rtk rewrite "uv run pytest …"` returns the rewritten
> `rtk pytest` form.

The `uv run` prefix was **stripped**. So the chain was:

1. Agent runs `uv run pytest tests/…_registry.py -q`.
2. Hook rewrites it to `rtk pytest tests/…_registry.py -q` — losing `uv run`.
3. rtk 0.43.0 spawns `pytest` outside the project's uv environment.
4. That pytest resolves no project packages and no configured `testpaths`, so
   it genuinely collects nothing — **exit 5**.
5. rtk reports `Pytest: No tests collected`.

Corroborating evidence from the 0.44.0 probe: invoking `rtk pytest` *without*
`uv run` still fails at the spawn boundary today —
`rtk: Failed to run pytest: Failed to spawn process: No such file or directory`.
The stripped form has never been runnable; 0.44.0 fixed the stripping, not the
reporting.

**rtk was not lying.** It faithfully reported a genuine exit 5. The
`ImportError` never occurred in those invocations because the test module was
never imported — pytest never got that far.

That is what made the loop unwinnable, and it is the sharpest lesson in this
document:

> The agent searched pytest's **configuration space** — `-q`, `-n 0`,
> `--override-ini addopts=`, `--override-ini testpaths=tests` — because the
> signal it received (`No tests collected`) is a configuration symptom. But the
> fault lay **outside** that space, in the process spawn one layer up. No
> combination of pytest flags could ever have fixed it.

The agent was not looping because it was stupid or under-instructed. It was
looping because it had been handed a true statement about a broken invocation,
with no way to observe the invocation itself. Every hypothesis it could form
was confined to a space that did not contain the answer.

This is the failure mode Fix E addresses most directly: when the verification
channel is structurally incapable of confirming success, stop asking it and
check the artifact instead.

> **Method note.** The probe initially produced a *transitive* failure
> (`ModuleNotFoundError: No module named 'stock_notify'`) because the worktree
> venv was synced with `uv sync` scoped to `apps/api`. `uv sync --all-packages`
> at the workspace root was required before the intended
> `ImportError: cannot import name …` surfaced. Worth knowing for any future
> repro in a fresh rs-stock worktree.

Per nax's own design, none of this was the test-writer's job.
`src/operations/write-test.ts` states the contract explicitly:

> "the test-writer does not reliably emit the JSON envelope... downstream
> greenfieldGate / fullSuiteGate / verifier catch the real failure modes
> (no tests written, tests don't fail in RED, etc.)"

The test-writer writes the test and stops. RED validation is deferred to
later deterministic stages. A collection error **is** a valid terminal RED
signal.

---

## 4. Anatomy of the loop

### 4.1 Stream composition

From the acpx stream (`ses_061ce722fffeCs0okQ37HdA046.stream.ndjson`, 5,962 lines):

| `sessionUpdate` kind | Count |
|:---|---:|
| `tool_call_update` | 4,777 |
| `tool_call` | 1,208 |
| `agent_message_chunk` | **75** |
| `available_commands_update` | 3 |
| `usage_update` | **1** |

Tool events outnumber message events roughly **80 : 1**. The agent was almost
purely executing, barely narrating.

### 4.2 Command distribution

| Command variant | Invocations |
|:---|---:|
| `uv run rtk pytest …_registry.py -q -n 0` | 4,897 |
| `uv run rtk pytest …_registry.py -q` | 2,211 |
| `uv run rtk pytest --collect-only -q -n 0 …` | 610 |
| `… -q -n 0 --override-ini addopts= --override-ini testpaths=tests` | 7 |
| `… -q -n 0 --override-ini addopts=` | 5 |
| `uv run rtk pytest …_registry.py` (bare) | 12 |

`No tests collected` was returned **2,358 times**. The test file was written
via `write` exactly **once** — there was no thrashing on the artifact, only
on its verification.

### 4.3 Timeline — run 1

```
11:31:21  story:started US-001 · test-writer call opens
12:31:21  [WARN] wall-clock timeout exceeded — session terminated (3600 s)
          → exit 143 (SIGTERM) → NEW call opens, "Session turn 1/10"
13:31:21  [WARN] wall-clock timeout exceeded — session terminated
          → NEW call opens, "Session turn 1/10"
14:31:21  [WARN] wall-clock timeout exceeded — session terminated
          → NEW call opens, "Session turn 1/10"
15:08:01  human SIGINT → "Phase threw unexpected error: callOp[test-writer]: aborted"
```

`"Session turn 1/10"` appears **6 times** in run 1's log and never advances
past 1. The wall-clock timer fired at exactly 60-minute intervals, three
times, each restarting the loop with a fresh hour of budget.

---

## 5. Why all three safety nets missed

### Net 1 — `MAX_TURNS` (10): never advanced past turn 1

`src/agents/acp/adapter.ts:440`:

```ts
const MAX_TURNS = opts.maxTurns ?? 10;
...
while (turnCount < MAX_TURNS) {
  turnCount++;
  const turnResult = await runSessionPrompt(impl._session, currentPrompt, timeoutSeconds * 1000, signal);
```

`turnCount` increments per **agent turn completion** (a `sendTurn` round-trip
that reaches `end_turn`). All ~7,900 tool calls happened *inside one*
`runSessionPrompt` await. The agent never ended its turn, so the counter
never moved. **A turn budget cannot bound work that occurs within a turn.**

### Net 2 — idle watchdog: never fired

Resolved runtime config for these runs (from the log's `Watchdog tracking call`
entries): `mode: warn-then-cancel`, `idleTimeoutMs: 1_800_000` (30 min),
`toolCallOnlyTimeoutMs: 3_600_000` (60 min).

`src/runtime/middleware/idle-watchdog.ts` tracks two clocks:

```ts
function getTimeoutReason(state, now, idleTimeoutMs, toolCallOnlyTimeoutMs) {
  if (now - state.lastActivityAt >= idleTimeoutMs) return "idle_timeout_exceeded";
  if (toolCallOnlyTimeoutMs > idleTimeoutMs && now - state.lastNonToolCallActivityAt >= toolCallOnlyTimeoutMs) {
    return "tool_call_only_idle_timeout_exceeded";
  }
  return undefined;
}
```

Both clocks were continuously reset:

- `lastActivityAt` — reset by every one of the ~5,985 `tool_call*` events.
  The agent was never idle for 30 seconds, let alone 30 minutes.
- `lastNonToolCallActivityAt` — reset by each of the 75 `agent_message_chunk`
  events. Averaged across ~3.5 h that is roughly one every 3 minutes, far
  inside the 60-minute tool-call-only threshold.

The `tool_call_only_idle_timeout_exceeded` reason was designed for almost
exactly this shape of failure — but it measures *elapsed time since non-tool
activity*, not *repetition*. An agent that loops while occasionally narrating
("let me try with `-n 0`…") looks perfectly healthy to it.

Only `Watchdog tracking call` debug lines appear in either run's log — zero
warn/cancel entries. Confirmed non-firing.

### Net 3 — wall-clock timeout: fired, and made it worse

`timeoutSeconds` (3600) *did* trip, three times. But the handler breaks the
turn loop and terminates the session, after which the call was re-opened with
the same prompt and the same blind state:

```ts
if (turnResult.timedOut) {
  timedOut = true;
  getSafeLogger()?.warn("acp-adapter", "wall-clock timeout exceeded — session terminated", { ... });
  break;
}
```

Net effect: the only net that fired converted an unbounded loop into an
unbounded loop **punctuated by hourly restarts**, each one resetting
`turnCount` to 1 and handing the agent a fresh 60-minute budget. Nothing
escalated the repeated timeout into a story failure.

### 5.4 What re-opened the call: the fail-stale ladder

The original pass could not pin down which layer re-opened the call after each
timeout. It is the **fail-stale same-agent retry**, and the chain is four hops:

1. `src/agents/acp/adapter.ts:468` — on timeout, `break` out of the turn loop
   with `lastResponse` still `null`. The `timedOut` flag is **local to `run()`**
   and is never returned; nothing outside `adapter.ts` reads it.
2. `extractOutput(null)` → `""`. The fact that this was a *timeout* is now
   unrecoverable — it is indistinguishable from an agent that said nothing.
3. `src/operations/call.ts:316` — "Synthesize fail-stale for empty or
   whitespace-only output", producing `{ outcome: "fail-stale", category:
   "availability", retriable: true }`.
4. `src/agents/manager.ts:294` — `maxStaleRetries =
   config.agent?.idleWatchdog?.maxRetryAttempts ?? 3`; a retriable fail-stale
   triggers a same-agent retry in a fresh session.

The default is 3, and run 1 shows exactly three restarts (12:31, 13:31, 14:31)
before the human interrupted partway through the fourth hour. Exact match.

**The defect is a lost distinction, not a missing counter.** A wall-clock
timeout is the semantic opposite of stale: the agent was maximally busy, not
absent. The adapter discards that fact by returning `""`, and the empty-output
heuristic then re-infers the wrong cause — "agent went quiet, availability
problem, retriable" — and grants three more hours.

Two consequences worth separating:

- **Blast radius is wider than this incident.** *Every* wall-clock timeout
  anywhere in nax currently earns three free restarts under an availability
  label. This story only made it visible because each restart was an hour long.
- **The restarts carried no new information.** Same prompt, fresh session, no
  memory of the previous attempt. It was not three attempts; it was one attempt
  executed four times. This is the key constraint on any retry policy — see
  Fix C.

Additionally: because `lastResponse` is `null` on timeout, `extractOutput`
discards **all 75 accumulated `agent_message_chunk` events**. The agent's own
narration — the one place it said what it was stuck on — is thrown away.
Partial output should survive a timeout regardless of which fix is chosen.

---

## 6. Proposed nax fixes

> **Conclusion of this section (2026-07-27).** After review, **exactly one fix
> is warranted: Fix C.** It is the only item that describes a defect firing
> today rather than insurance against a trigger that has since been fixed
> upstream (§3.3). Fixes A, B, D, E and F are recorded below with the reasoning
> that retired them — read those before re-proposing any of them.

### Fix C — classify wall-clock timeouts honestly (the only recommended fix)

**This is a live defect, independent of this incident.** Per §5.4, a wall-clock
timeout returns `""`, which `src/operations/call.ts:316` synthesizes into
`{ outcome: "fail-stale", category: "availability", retriable: true }`, which
`src/agents/manager.ts:294` then retries on the same agent up to
`maxRetryAttempts ?? 3` times.

So nax currently labels a **maximally busy** agent as **idle**, and pays ~4× the
configured timeout budget for every timeout that occurs — on every op, in every
run, with or without rtk. This story only made it visible because each restart
happened to be an hour long.

**The fix:** propagate `timedOut` out of `run()` as a distinct `AdapterFailure`
— `outcome: "fail-timeout"` — so it never reaches the empty-output synthesis.
The `timedOut` flag already exists at `src/agents/acp/adapter.ts:468`; it is
simply local to `run()` and never returned.

**Scope: this is not test-writer-specific.** `fail-timeout` originates at the
adapter/manager layer, so it applies to every run-kind op — implementer,
verifier, both reviewers, plan, acceptance. The test-writer is only where it
surfaced. Any prompt-side remedy must therefore be op-agnostic.

#### Verified: a timeout does NOT escalate — it fails the story

An earlier draft of this section asserted that `fail-timeout` should be
non-retriable while remaining "escalation-eligible", on the assumption that a
terminal op failure routes into the tier ladder. **Traced and refuted:**

```ts
// src/pipeline/runner.ts:87
} catch (error) {
  const failResult: StageResult = { action: "fail", ... };
  return { success: false, finalAction: "fail", ... };
}
```

A thrown stage error becomes `finalAction: "fail"` →
`pipeline-result-handler.ts:250` `case "fail"` → `markStoryFailed`. The
`"escalate"` case is separate and a throw never reaches it.

Full chain: `CALL_OP_NO_OUTPUT` → `executionStage` rethrows (tagged
`runtime-crash`, `execution.ts:36`) → `execution-plan.ts:113` rethrows →
`runner.ts:87` → **terminal story failure.** Tier escalation is not involved.

Note this is also what happens **today**: timeout → 3 fail-stale restarts →
still empty → the same `CALL_OP_NO_OUTPUT` → the same terminal failure. The
classification fix does not change the outcome; it removes ~3 hours of restarts
before reaching an identical end state.

#### Retry IS warranted — because progress is cumulative on disk

The `.claude`-level instinct is to treat a timeout as non-retriable. That is
wrong here, for a reason specific to this system:

> **The session dies; the agent's file edits do not.** Attempt 2 does not redo
> attempt 1 — it *continues* it, starting from whatever landed on disk.

That is exactly what the identical same-agent restarts of §5.4 lacked. It also
dictates the correct budget shape:

- Agent was **slow but progressing** → attempt 2 starts further along, so it
  needs *less* time.
- Agent was **stuck in a loop** → more time never helps, so cap the waste.

Decaying budget is right in both branches; constant budget is wrong in both.

#### Recommended policy

**One retry, budget × 0.5, fresh session, informed prompt.**

| | Today | Proposed |
|:---|---:|---:|
| Worst case | 4 × 3600s = **4h** | 3600 + 1800 = **1.5h** |
| Attempts | 4 identical | 2, the second one informed |

The retry prompt is composed, not hardcoded:

1. **Generic timeout preamble** (all ops) — elapsed, files already changed,
   "continue from that state, do not start over".
2. **Progress-conditional guidance**, from a `git diff` against the pre-attempt
   ref:
   - *tree changed* → "continue from what is on disk"
   - *tree unchanged* → "your previous attempt produced no file changes in N
     minutes; the approach is not working — change it"
3. **Optional op-supplied contract reminder** (e.g. test-writer: "your
   deliverable is the test file, not a green run; a collection error is an
   expected RED outcome").

> **Do not gate the retry on the progress signal.** An earlier draft proposed
> folding immediately when the tree was unchanged. That produces a false
> positive on any agent that spends its first attempt reading and analysing
> before writing — legitimate progress with zero file changes. Use the signal
> for *messaging* only.

> **Do not emit "try a different approach" unconditionally.** In the
> tree-changed branch it instructs the agent to abandon working progress — the
> opposite of the intent.

After the single retry, fold to terminal story failure (unchanged from today).

### Retired: Fix E — recover the deliverable from disk

**Dropped.** The original argument was that the test file sat on disk unused for
3.5 hours while nax restarted to re-obtain it, and that `testWriterOp` should
therefore accept an existing artifact instead of retrying.

The premise is true but the conclusion does not follow. A timeout does not roll
back the filesystem — **nothing is ever lost, so there is nothing to recover.**
The name itself was wrong.

The reframed version ("treat artifact presence as the completion check") is
worse than redundant — it is a regression risk:

> **Artifact presence ≠ artifact completeness.** "File exists ⇒ done" cannot
> distinguish *finished writing, then looped on verification* (what happened
> here) from *timed out halfway through the second of three test files*. It
> would accept partial work as complete and hand a truncated deliverable to
> `greenfieldGate`.

The existing escalation path already handles both cases correctly: the next
agent reads what is on disk and continues — partial work resumes, complete work
passes through. Fix E would replace correct behaviour with a guess.

Fix C is what unblocks that path; E is not needed once C lands.

### Retired: Fix F — preserve partial output across a timeout

**Dropped.** `extractOutput(null)` does discard the accumulated
`agent_message_chunk` events on the timeout path (§5.4), and the original
justification was diagnosability.

That justification does not survive scrutiny: the acpx stream NDJSON already
persists every one of those events — it is how this entire diagnosis was
performed. F would save reaching for a file that already exists, and the
narration it preserves is thin (*"let me try `-n 0`…"*). The deliverable is the
file the agent wrote, not its commentary. Convenience, not capability.

### Retired: Fix A — repetition circuit breaker

**Deferred.** Medium cost — it requires threading `title` / `rawInput.command`
through `AcpLineActivity` (see the caveat at the end of this section), and the
specific trigger it detects is gone (§3.3). Revisit only if a second in-turn
runaway occurs with a *different* trigger; the design below is sound and should
be reused as-is if so.

Original proposal follows.


**The plumbing already exists.** `src/agents/acp/parser.ts:134` parses tool
calls and `src/agents/acp/spawn-client.ts:314` already emits them onto the
agent stream bus with a tool name:

```ts
} else if (activity.kind === "tool_call_update") {
  emit({ ...baseEvent, kind: "agent.tool_call_update", toolName: activity.toolName, timestamp: now() });
}
```

What is missing is a consumer that counts *repeats* rather than measuring
*gaps*. Extend `WatchdogState` (which already carries `toolCallUpdates`) with
a small rolling signature window:

- Hash each tool call's identity (tool name + normalised command/title).
- Track consecutive-identical and window-frequency counts.
- On breaching a threshold (e.g. same signature ≥ N times, or > M% of the
  last K calls), emit a new reason `repeated_tool_call_loop` and route it
  through the **existing** `observe` / `warn-then-cancel` / `cancel` modes and
  `controllerRegistry` cancellation path.

This reuses the whole watchdog apparatus — modes, grace period,
`maxRetryAttempts`, structured logging — and adds only the detector. Ship it
in `observe` mode first to calibrate thresholds against real runs before
letting it cancel.

**Caveat to design around:** `parser.ts` currently returns only `toolName` for
tool-call updates. In this incident every call was `bash`/`execute`, so the
tool name alone would not have discriminated. The detector needs the
`title` / `rawInput.command` field (present in the raw ACP payload, which is
how this diagnosis counted variants) to be threaded through `AcpLineActivity`.
Without that, the signature is too coarse to be useful.

### Retired: Fix B — count tool calls against a per-turn budget

**Optional, not recommended now.** Cheap insurance against any in-turn runaway,
but with the trigger fixed upstream there is no live defect it addresses.
Worth reconsidering alongside Fix A if a second incident occurs.

Original proposal follows.


Independently of repetition, a single turn making thousands of tool calls is
pathological regardless of whether they repeat. A simple
`maxToolCallsPerTurn` ceiling (config-driven, generous default — 300? 500?)
would bound the blast radius of *any* in-turn runaway, including ones whose
signatures vary enough to evade Fix A. Cheap to implement: `WatchdogState`
already increments `toolCallUpdates` per call.

### Retired: Fix D — tighten the test-writer contract (prompt-level)

**Dropped.** It is the only fix whose effectiveness depends on agent
compliance, it cannot be verified (the incident is unreproducible), and it is
the least portable — the incident agent was `minimax/MiniMax-M3`, and prompt
adherence varies across the agents nax orchestrates. A permanent prompt
addition also pays tokens on every test-writer run. With the trigger fixed
upstream, there is nothing left for it to prevent.

Original proposal follows.


The op contract in `write-test.ts` is correct, but nothing in the
test-writer's *prompt* appears to tell the agent to stop after writing.
Consider stating explicitly in `TddPromptBuilder` that:

- the test-writer's deliverable is the test file, not a green/red verdict;
- it may run the suite **once** to observe, and must not iterate on
  infrastructure/config to make collection succeed;
- a collection error or import error is an acceptable, expected RED outcome
  to hand off.

This is defence-in-depth — Fixes A–C should not depend on agent compliance —
but it addresses the behaviour at its source and is by far the cheapest.

**Superseded in placement, not in content.** Fix C folds this text into the
timeout reprompt, which delivers the same instruction at the moment it is
needed instead of on every run. Ship the wording here; ship it via C's
injection point rather than as a permanent prompt addition.

### Priority — final

| Fix | Disposition | Why |
|:---|:---|:---|
| **C — `fail-timeout` classification** | **DO** | Live defect: every timeout in nax costs ~4× its budget under an "idle" label. Independent of this incident. |
| ~~rtk upstream (§8)~~ | Dropped | Already correct on rtk 0.44.0 (§3.2–3.3) |
| ~~E — recover from disk~~ | Dropped | Nothing is lost on timeout; presence ≠ completeness. Regression risk. |
| ~~F — preserve partial output~~ | Dropped | The acpx NDJSON already persists it. Convenience, not capability. |
| ~~D — prompt contract~~ | Dropped | Depends on agent compliance; unverifiable; least portable. |
| ~~B — per-turn ceiling~~ | Deferred | Cheap insurance, but no live defect once the trigger is fixed. |
| ~~A — repetition breaker~~ | Deferred | Medium cost (`title` threading); its trigger is gone. |

**One fix, small, and a bug rather than insurance.** The temptation with an
incident this dramatic is to build all six. Five of them protect against a
trigger that no longer exists; the sixth is broken right now and would be worth
fixing had this incident never happened.

### 6.1 Verifying Fix C

The loop itself cannot be reproduced — the rs-stock stub fix (§7) was applied by
hand and the trigger is fixed upstream. This does not block Fix C, which never
needed the loop: it is a classification defect testable at the seam.

| Behaviour | Test |
|:---|:---|
| Timeout is not laundered into `fail-stale` | Fake adapter returns `timedOut`; assert `outcome === "fail-timeout"` and the `fail-stale` ladder is not entered |
| Exactly one retry, at half budget | Assert hop 2 receives `timeoutSeconds × 0.5`, and that no hop 3 occurs |
| Retry opens a **fresh** session | Assert `timeout-retry` does not reuse the live handle (`stale-retry` does; the timed-out session is dead) |
| Prompt varies by progress signal | Tree-changed fixture → "continue" wording; tree-unchanged fixture → "change approach" wording |
| **`fail-stale` is byte-identical** | Fake adapter returns `""` *without* `timedOut`; assert the existing path, retry count and outcome are unchanged |

The last row is the contract with the operator: this change fixes
`fail-timeout` and must not perturb `fail-stale` in any way.

Also assert the watchdog interaction: the wall-clock path calls
`cancelActivePrompt`, the same mechanism the idle watchdog uses. They are kept
distinct by `_watchdogCancelledCalls` (`session/manager.ts:128`), populated only
by the watchdog — a seam where a regression would hide silently.

> **If the deferred fixes are ever revived:** Fix A's test depends on
> `ses_061ce722fffeCs0okQ37HdA046.stream.ndjson` (5,962 lines), the only frozen
> reproduction of the loop. Copy it into `test/fixtures/` before it is garbage
> collected — it is the sole artifact here that can be lost.

---

## 7. rs-stock side: fix applied

Minimal placeholder stubs added to `apps/api/src/stock_api/_bot_commands.py`
to unblock collection (scope deliberately limited — the real implementation
belongs to the implementer phase):

```python
# ── Qualified command groups (US-001 placeholder — RED phase) ────────
#
# Minimal stubs so `tests/test_qualified_command_registry.py` can be
# collected. Values are placeholders, not the real group/legacy-hint
# implementation — that lands in the implementer phase for US-001.
GROUPS: dict[str, str] = {}
_LEGACY_HINTS: dict[str, str] = {}
```

Verified with `rtk err uv run pytest tests/test_qualified_command_registry.py -q`:

```
17 failed, 4 passed in 3.56s
```

Collection succeeds; the suite is in a proper RED state (17 genuine
assertion / `KeyError` failures, 4 incidental passes from pre-existing flat
commands). `nax run -f bot-command-groups --resume` can now proceed to the
implementer phase.

---

## 8. Operator note: seeing real pytest errors under rtk

> **Resolved on rtk 0.44.0.** The advice below applied to **0.43.0**, where the
> rewrite stripped `uv run` and pytest was spawned outside the project
> environment (§3.3). On 0.44.0 `uv run rtk pytest` preserves collection
> tracebacks in full — verified in §3.2 — so no workaround is needed. Kept for
> the historical record and for anyone pinned to an older rtk.

On 0.43.0, a "plain" `uv run pytest …` typed into the Bash tool was **not**
plain — the PreToolUse hook rewrote it to `rtk pytest`, dropping the `uv run`
prefix. (Verified directly: `rtk rewrite "uv run pytest …"` returned the
`rtk pytest` form.) Escapes:

```bash
rtk err   uv run pytest <path> -q    # errors/warnings only, traceback preserved
rtk proxy uv run pytest <path> -q    # full raw passthrough, no filtering
uv run python -c "import <module>"   # bypasses pytest entirely; always a real traceback
```

**Minimum rtk version for Python work under the rewrite hook: 0.44.0.**

### 8.1 The exit code is the cheap discriminator

Per §3.1, pytest already distinguishes these cases in every configuration
tested, and the exit code carries the distinction even when the text is
compacted away:

| Outcome | Exit code |
|:---|---:|
| Collection error, xdist (`-n auto`) | 1 |
| Collection error, single-process (`-n 0`) | 2 |
| Genuinely no tests collected | 5 |

So the upstream `rtk` request has two parts, and the second is nearly free:

1. **Preserve the traceback** on a genuine collection `ERROR`, the way
   `rtk err` already does, instead of bucketing every zero-test outcome into
   `No tests collected`.
2. **Surface the exit code** — or at minimum stop mapping exit 1/2 and exit 5
   to the same string. Even in fully compact mode, `Pytest: collection error
   (exit 2)` versus `Pytest: no tests collected (exit 5)` is the difference
   between a three-hour loop and a ten-second fix. This requires no traceback
   plumbing at all.

Note the exit code also varies by xdist mode (1 vs 2) for the *same* failure,
which is worth knowing for any tooling that keys on exit status: check for
`!= 0 && != 5` rather than `== 2`.
