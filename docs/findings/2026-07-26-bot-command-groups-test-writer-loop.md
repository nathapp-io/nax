# Test-writer runaway tool-call loop — three safety nets missed it

**Date:** 2026-07-26
**Reporter:** diagnosis via `/nax-diagnose`
**Downstream project:** rs-stock (`bot-command-groups`, US-001)
**Status:** rs-stock unblocked (stub fix applied); nax-side gaps open — see §6

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

> The exact layer that re-opened the call after each timeout was not pinned
> down in this pass (`agent.acp.promptRetries` is complete-kind only, so it
> is not the mechanism here). Worth confirming before implementing Fix C.

---

## 6. Proposed nax fixes

### Fix A — repetition circuit breaker (primary)

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

### Fix B — count tool calls against a per-turn budget

Independently of repetition, a single turn making thousands of tool calls is
pathological regardless of whether they repeat. A simple
`maxToolCallsPerTurn` ceiling (config-driven, generous default — 300? 500?)
would bound the blast radius of *any* in-turn runaway, including ones whose
signatures vary enough to evade Fix A. Cheap to implement: `WatchdogState`
already increments `toolCallUpdates` per call.

### Fix C — escalate repeated wall-clock timeouts

A wall-clock timeout on the *same session* recurring back-to-back is strong
evidence the work is not progressing. Today each timeout restarts the turn
with no memory of the previous one. Track consecutive timeouts per session
name and fail the story after the second or third rather than restarting
indefinitely. This alone would have capped run 1 at ~2 h instead of requiring
a human.

### Fix D — tighten the test-writer contract (prompt-level)

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

### Priority

| Fix | Value | Cost | Order |
|:---|:---|:---|:---|
| D — prompt contract | Prevents the behaviour | Very low | 1st |
| B — per-turn tool-call ceiling | Bounds all in-turn runaways | Low | 2nd |
| C — timeout escalation | Stops infinite restart | Low | 3rd |
| A — repetition breaker | Catches this class precisely | Medium (needs `title` threading) | 4th |

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

`rtk pytest`'s compact mode hides collection-time tracebacks. Neither a human
nor an agent can diagnose an `ImportError` through it. Use:

```bash
rtk err   uv run pytest <path> -q    # errors/warnings only, traceback preserved
rtk proxy uv run pytest <path> -q    # full raw passthrough, no filtering
```

A "plain" `uv run pytest …` typed into the Bash tool is **not** plain — the
PreToolUse hook rewrites it to `rtk pytest` before execution regardless of
how it was typed, so it always hits the same gap. (Verified directly:
`rtk rewrite "uv run pytest …"` returns the rewritten `rtk pytest` form.)

Worth reporting upstream to rtk: `rtk pytest` should preserve the traceback on
a genuine collection `ERROR`, the way `rtk err` already does, instead of
bucketing every zero-test outcome into `No tests collected`.
