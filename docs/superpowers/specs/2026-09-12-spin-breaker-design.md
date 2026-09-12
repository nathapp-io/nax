# Spin breaker, verifier timeout, and a scoped verdict write

Design for GitHub issue [#2013](https://github.com/nathapp-io/nax/issues/2013).
Status: design approved, not yet implemented.

## 1. The incident

Feature `advisory-and-budget-truth`, US-002, run `4549de79`, nax `0.82.0-canary.12` (`25d901d5`).

A TDD verifier session ran 36 minutes 40 seconds re-running the same **passing** scoped
test 622 times, emitted no verdict, and was ended by operator SIGINT. Exit code 0 on
every invocation, result size 112-113 bytes, two distinct argv shapes across 622 calls,
zero file writes.

The same prompt shape had completed correctly 15 minutes earlier on the same story
(attempt 1 returned a well-formed verdict, `approved: true`, `passCount: 29`). Three of
four verifier sessions on that story were healthy, at 2, 12 and 15 scoped test runs. The
spin is a 40x outlier with no band in between.

## 2. Diagnosis

Three facts in the issue body need correcting. All three come from the run artifacts,
not from inference.

### 2.1 This was the native transport, not ACP

`~/.nax/nax/features/advisory-and-budget-truth/runs/2026-09-12T03-18-30.jsonl` records
`session Session created {agent: "native"}`, and the verifier call on
`minimax/MiniMax-M2.7`. The repo config declares `protocol: "acp", default: "claude"`,
so the `native` global profile was active (`~/.nax/profiles/native.json`, verifier tier
`fast` to `minimax/MiniMax-M2.7`). Profiles repoint agent and model per stage and are
otherwise invisible in run artifacts, which is why the issue body did not name the
transport.

This matters because the two transports have structurally different loops:

| | loop | bound |
|:--|:--|:--|
| ACP (`src/agents/acp/adapter.ts:418`) | `while (turnCount < maxInteractions)` | count, default 10 |
| **native** (`src/agents/native/session/turn-loop.ts:194`) | `while (true)` | wall clock + idle watchdog only |

The native loop's own comment states the position: "Deliberately unbounded by count. A
coding agent working a story is bounded by wall clock (`deps.deadline`) and by the idle
watchdog, never by how many times it needed to call a tool." That ruling came from
#1819/#1820. The 622 iterations were iterations of that loop.

A second consequence: nax's own coding tools (`RunCommand`, `Git`, `Read`, `Glob`,
`Grep`) are wired only on the native path. `codingTools` reaches `turn-loop.ts`; the ACP
adapter never references it, and its loop handles only `context-tool` and `question`
interactions. So a tool-level breaker is native-only today regardless of where it is
placed.

### 2.2 The idle watchdog was armed, and is structurally incapable of catching this

The issue states the 2-hour `execution.sessionTimeoutSeconds` is the only backstop. It
is not. The watchdog was running in `warn-then-cancel` with `idleTimeoutMs: 1200000` and
`toolCallOnlyTimeoutMs: 1800000`. Neither timer can expire against a round-tripping spin:

- `idle_timeout` resets on **any** activity kind, `tool_call_update` included. A call
  every 3.5s resets it forever.
- `tool_call_only_idle_timeout` — the timer designed for exactly this shape — compares
  against `lastNonToolCallActivityAt`, which is reset by `message_update`,
  `thinking_update` **and `usage_update`** (`DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG.activityKinds`,
  `schemas-infra.ts:236`). The native loop emits a `usage_update` per round trip
  (`turn-events.ts:47`). Confirmed in the data: `usageUpdates` tracks `toolCallUpdates`
  on every native call in both runs.

So every spin iteration reset both timers. The guard intended for a tool-call-only stall
is blind to a stall that is genuinely round-tripping, which is what a spin is.

### 2.3 The verifier has no `timeoutMs`

`verifierOp` (`src/operations/verify.ts:189`) declares `retry` and `model` but no
`timeoutMs`, so `call.ts:240` falls back to `execution.sessionTimeoutSeconds`. The log
shows `timeoutSeconds: 7200` on both verifier calls against `1800` on review-stage calls,
which do declare `timeoutMs` (`semantic-review.ts:336`, `adversarial-review.ts:293`).

### 2.4 A contributing defect the issue did not find

`src/prompts/sections/verdict.ts:17` tells the verifier it **MUST** "Write the verdict
file at the project root: `.nax-verifier-verdict.json`", and `isolation.ts:107` tells it
"You MAY write only the verdict file". But `verifierOp.tools` is
`["Read", "Glob", "Grep", "Git", "RunCommand"]` — no `Write`, and no `Exec`, so
`RunCommand` is restricted to declared labels with no shell (`run-command.ts:283` sets
`argvField` only when exec is available).

The verifier is handed a mandatory instruction it has no tool to satisfy. Two
consequences:

- `verifierOp.recover`'s disk-file fallback is unreachable. The verdict file can never
  exist, so `readVerdict` always returns null and `recover` always takes the fail-closed
  arm. A documented second channel for the verifier's hardest failure mode is dead code.
- An agent that treats "MUST" literally has nowhere to go. Attempt 1 succeeded only by
  ignoring instruction 1 and emitting the JSON. This is not proven to be the spin's
  cause, but it is a plausible driver of "kept working, never concluded" and it is a
  defect either way.

### 2.5 What is not the cause

- **Not the prompt's termination instruction.** It is explicit and leaves no room, and
  the same prompt shape completed 15 minutes earlier on the same story.
- **Not #1998.** The commands carried fully-substituted absolute paths, not `{{files}}`.
- **Not story shape.** US-001 in the same feature never invoked an LLM verifier at all;
  it took the mechanical `verify-scoped` path.
- **Unresolved.** Attempt 2's prompt would carry a longer `Prior Stage Summary` (two
  rectification rounds) than attempt 1's 46,151 bytes, and was never persisted because
  the session never completed. A context-length contribution cannot be excluded from
  artifacts alone.

Conclusion: model-side non-termination, inside a loop that is bounded by nothing a spin
can trip.

## 3. Rulings

Decisions taken during design, with the rejected alternatives, so a later reader does
not have to re-derive them.

**R1. A spin gets its own failure outcome, `fail-spin`.** Reusing `fail-timeout` would
have cost nothing and the retry behaviour would already be correct, but it would make a
spin indistinguishable from a real wall-clock timeout in every artifact, so recurrence
could never be measured. The whole point of #2013 is that this failure mode is currently
invisible. `fail-stale` was rejected as semantically wrong — a spin is activity, not
staleness — and because it would pollute the stale counters.

**R2. The breaker is native-only, in a transport-neutral module.** Detecting from the
`agent.tool_call_update` stream event would cover ACP too, but that event carries only
`toolName` and no input, so it cannot tell 622 repeats of 2 shapes from 622 varied calls
— which is the signal that discriminates. The module therefore lives at
`src/runtime/spin-breaker.ts` with no native imports, ready for ACP if acpx ever
surfaces client tools, but consulted only from the native loop.

**R3. Progress means a call not recently seen, not a write.** The issue proposed
"identical-call repetition with no intervening write". The verifier has no `Write` tool,
so a write can never reset its counter and the rule would never arm for the role it was
derived from. A not-recently-seen normalised call is the general form and works for
read-only roles.

**R4. One counter, not per-key counters.** The observed spin alternated between two
keys. A per-key counter climbs at half rate; a consecutive-identical counter never climbs
at all and would not have tripped on the actual incident. `repeatsSinceProgress` — calls
since the last new key — catches alternation of any width. Per-key counts are retained
as telemetry only.

**R5. Thresholds 25 / 50 with three nudges.** Healthy sessions on this story peaked at
89 total tool calls and 15 scoped test runs; the spin hit 622. Nudging at 25 sits well
above the busiest healthy run's scoped-test count and roughly an order of magnitude
below the spin. Nudge points are derived from the three knobs rather than configured
separately.

**R6. The watchdog fix is scoped to native at the emitter, not dropped and not global.**
Making `usage_update` stop resetting `lastNonToolCallActivityAt` everywhere would change
a guard that protects every session. ACP does not need it: its loop is already bounded
at `maxInteractions`, so it has no unbounded-loop exposure and should not pay the
false-positive risk. The distinction is made by the emitter marking the fact, not by the
watchdog sniffing `agentName`, so the watchdog stays transport-agnostic.

**R7. The verifier gets a path-scoped `Write`, not a prompt deletion.** Dropping
instruction 1 and the dead `recover` arm was the cheaper fix and loses nothing today,
but it removes a genuine second channel for the phase that is hardest to diagnose
post-hoc. The policy can already express `Write(.nax-verifier-verdict.json)`; what is
missing is op-level narrowing, which is small and reusable.

**R8. Op-level narrowing may only narrow, and is applied after resolution.**
`resolvePermissions` stays the single permission authority. The narrowing runs after
`policy.check` returns `allowed` and can only deny, so it introduces no permission
decision of its own.

## 4. Design

Four independent stories.

### US-001 — Spin breaker

**New module `src/runtime/spin-breaker.ts`.** No native imports (R2).

```ts
export type SpinVerdict =
  | { action: "allow" }
  | { action: "nudge"; nudgeNumber: number; repeats: number; text: string }
  | { action: "stop"; repeats: number };

export function createSpinBreaker(cfg: SpinBreakerConfig, _deps?: SpinBreakerDeps): {
  observe(toolName: string, input: unknown): SpinVerdict;
  summary(): { totalCalls: number; distinctKeys: number; maxRepeatRun: number; nudges: number };
};
```

**Key.** `toolName \0 stableStringify(input)` with object keys sorted so key order in the
model's JSON cannot defeat the match. Over 512 bytes, the tail is hashed, so a large
input cannot grow the key set without bound.

**Algorithm.** One counter (R4):

- key not in the recent-key window: insert it, evicting the oldest past a 64-key cap;
  set `repeatsSinceProgress = 0`; return `allow`.
- key already in the window: `repeatsSinceProgress++`; then
  - at or past `stopAfterRepeats`: `stop`
  - at a nudge point with nudges remaining: `nudge`
  - otherwise `allow`

**Thresholds.** `nudgeAfterRepeats: 25`, `stopAfterRepeats: 50`, `maxNudges: 3` (R5).
Nudge points are derived, not a fourth knob:
`nudgeAfterRepeats + round(i * (stop - nudge) / maxNudges)` for `i` in `0..maxNudges-1`,
giving **25, 33, 41**, stop at **50**. `config-guards.ts` rejects
`stopAfterRepeats <= nudgeAfterRepeats` at config load, so a misconfiguration cannot
produce a silent hard stop with no warning first.

**The progression prompt** is prepended to the real tool result, never replacing it, and
never with `isError: true`. A nudge that reads as a tool failure invites a retry, and
withholding the data the model asked for invites a re-run. Text is role-neutral, since
the breaker does not know it is watching a verifier, and escalates:

1. "You have made N tool calls without issuing a new, distinct call. You are repeating
   work already done and the results are not changing. Stop re-running and produce your
   final answer now, in the exact format your instructions require."
2. Adds: "If you cannot conclude, say so explicitly in your final answer and stop. An
   explicit inability to conclude is a valid answer; repeating is not."
3. Adds: "Final warning: the next repeated call ends this session with no answer
   recorded."

This reuses the shape already present at `turn-loop.ts:400`, where an exhausted
`ask_human` budget is reported to the model as a tool result.

**Hard stop.** `break` out of `while (true)` with `spinStopped = true`, surfaced on the
`TurnResult` alongside the existing `turnIncomplete`. Classification lives with the other
classifiers in `src/operations/turn-failure-classification.ts` rather than inside the
adapter, and `normalizeHopOutput` branches on `spinStopped` **before** its empty-output
check, because a spun turn usually carries non-empty prose.

**`fail-spin`** (R1) joins the `AdapterFailure` outcome union (`context/engine/types.ts`)
with a `failure-policy.ts` row:

```
"fail-spin": { sameAgentRetry: "timeout", swap: "after-retry-lane",
               cooldown: "none", cooldownScope: "model", terminalBackoff: false }
```

`trySameAgentRetry` dispatches on the lane, not the outcome
(`hop-retry-policy.ts:118`), so reusing the `timeout` lane yields a fresh session with a
reduced budget — an unpoisoned transcript and less runway for a spin-prone model — and
then a swap, with no new retry machinery. The synthesised failure must carry
`retriable: true` or the lane skips it. Category `quality`, as `fail-timeout` is.

**Config.** `agent.spinBreaker: { enabled, nudgeAfterRepeats, maxNudges, stopAfterRepeats, recentKeyWindow }`,
alongside `agent.idleWatchdog`, with a `config-descriptions.ts` entry per key.

### US-002 — Verifier timeout

`TddConfigSchema` gains `verifierTimeoutSeconds: z.number().int().min(60).max(7200).default(1800)`.
`verifierOp` gains `timeoutMs: (_input, ctx) => (ctx.config.tdd?.verifierTimeoutSeconds ?? 1800) * 1000`,
mirroring the review ops.

Worst case falls from 7200s to roughly 1800 + 900 (the reduced-budget same-agent retry)
plus a swapped attempt. The native loop's `deps.deadline` already enforces an op timeout
— proved by the `1800` on review-stage calls in this run's log — so no new enforcement
path is needed.

### US-003 — Native round-trip usage flag

`AgentUsageUpdateEvent` gains `perRoundTrip?: true`, set only by the native emitter
(`turn-events.ts:47`). On native a usage update *is* one round trip, mechanically 1:1
with a tool call. The watchdog treats a `perRoundTrip` usage update as tool-tier
activity: it resets `lastActivityAt` but not `lastNonToolCallActivityAt`.

The ACP emitter (`parser.ts:186`) sets nothing, so ACP behaviour is byte-identical to
today (R6). `activityKinds` is untouched and remains the escape hatch.

Effect: on native the existing 30-minute `toolCallOnlyIdleTimeoutSeconds` becomes able to
fire. This change alone would have ended the incident at roughly 30 minutes.

**Risk.** A native session doing legitimate tool-heavy work with no assistant text *and*
no thinking for over 30 minutes would now be cancelled. Observed healthy native sessions
emit 7 to 45 `message_update`s, the mode is `warn-then-cancel` with a grace period, and
`maxRetryAttempts` is 3, so the exposure is judged low — but it is a behaviour change to
a shared guard and gets its own tests.

### US-004 — Op-level tool narrowing and a scoped verdict write

The policy can already express a path-scoped grant: `ToolGrant.patterns` are globs over
the tool's declared path fields, and `parseToolExpression` accepts `Write(src/**)`. What
does not exist is a way for an op to narrow a grant it inherits — `advertised()`
intersects tool *names* only, so declaring `"Write"` under the `unrestricted` profile
hands the verifier `["*"]`.

```ts
// src/operations/types.ts
readonly toolPatterns?: Partial<Record<CodingToolName, readonly string[]>>;

// src/operations/verify.ts
tools: ["Read", "Glob", "Grep", "Git", "RunCommand", "Write"],
toolPatterns: { Write: [VERDICT_FILE] },
```

A typed map, not an expression string: the `Tool(glob,glob)` grammar exists for
user-authored `scoped` config where strings are unavoidable, and a second parser on an
internal hot path earns nothing.

**Enforcement (R8).** `createCodingToolRuntime` holds the op patterns and applies them
after `policy.check` returns `allowed`, so it can only deny. Glob-set intersection is
undecidable in general, so the rule is operational: a path must satisfy **both** the
profile grant and the op patterns. Under `safe`, `Write` is not granted and the narrowing
never resurrects it. Under a `scoped` profile whose `Write` glob excludes the verdict
file, `Write` is not advertised at all and that is logged — telling a verifier it may
write a file it cannot is worse than withholding the tool.

**The hazard this introduces, and its guard.** With the write live, the verdict file can
finally exist. `cleanupVerdict` runs only in `recover`'s `finally` and once at
`post-run.ts:323`, so story A's verdict file would survive into story B's verifier, where
`recover` would read a stale verdict and rule on the wrong story. Two guards:

1. Cleanup on every verifier path, success included, not only `recover`'s `finally`.
2. `recover` ignores a verdict file whose `lastModified` precedes the turn's dispatch.
   The op knows when it dispatched, so this needs no schema change and no prompt change,
   and it keeps one missed `finally` from silently producing a wrong ruling.

## 5. Sequence

US-003, then US-002, then US-004, then US-001. Cheapest containment first; US-001 is the
largest and depends on none of the others.

## 6. Out of scope

- **Reinstating a turn or round-trip cap.** Removed deliberately twice
  (#1823/#1827/#1830, then #1819/#1820). The breaker is a repetition detector, not a
  count ceiling: a session making 600 varied calls is untouched.
- **A token or spend guard.** Named in #2013 as the already-identified shape. Still
  wanted, and orthogonal to this: it bounds cost, the breaker bounds futility.
- **ACP coverage.** Blocked on tool inputs being observable there (R2).
- **Narrowing the other unscoped writes.** The new `toolPatterns` seam would let `plan`,
  `plan-refine`, `debate-plan` and `acceptance-generate` narrow their currently
  unrestricted `Write` to the one file each produces. Follow-up.
- **The lost cost ledger.** SIGINT discarded the ledger before `drain()`, so this run's
  spend is unrecoverable. Filed separately.
