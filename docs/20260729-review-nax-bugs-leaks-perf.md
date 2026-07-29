# Deep Code Review: @nathapp/nax

**Date:** 2026-07-29
**Reviewer:** Subrina (AI)
**Version:** 0.74.0
**Commit:** `4a0653a4` (main, clean tree)
**Files:** 761 source files (~112,096 LOC), 956 test files
**Scope:** Bugs, memory/resource leaks, performance — targeted deep review, not an exhaustive line-by-line audit
**Checklists applied:** `universal.md`, `node-general.md`, `react.md`
**Status:** All findings empirically verified — see [Verification](#verification) below

---

## Overall Grade: B+ (84/100)

nax is a well-engineered codebase with unusually disciplined resource hygiene for its size. Subprocess handling, signal teardown, and timer cancellation are handled correctly in the large majority of call sites, and the project enforces its own conventions through ten custom CI gates plus ADRs and rule files. Every `JSON.parse` call site inspected was guarded.

After verification, the findings resolve into **two confirmed defects with real user impact** — a log-redaction gap that writes credentials in cleartext, and two instances of an uncleared timer that blocks process exit for a full grace period — plus one confirmed throughput issue in the logger. Four findings I initially graded MEDIUM turned out to be **structurally correct but practically negligible**, and have been downgraded with the measurements that justify it. No CRITICAL findings.

### Score Breakdown

| Dimension | Score | Notes |
|:---|---:|:---|
| Security | 15/20 | No hardcoded secrets; documented shell trust boundary; redaction has a proven gap (SEC-1) |
| Reliability | 17/20 | Excellent signal/subprocess hygiene; two proven timer leaks that block exit (MEM-1, MEM-3) |
| API Design | 18/20 | Barrels, config selectors, Operations, discriminated unions; only 17 `any` across 112k LOC |
| Code Quality | 16/20 | 956 test files, `_deps` DI throughout; 56 files over the 400-line guideline, 27 untracked TODOs |
| Best Practices | 18/20 | Bun-native enforced, 10 CI gates, ADR-backed architecture decisions |

---

## Verification

Every finding was tested rather than asserted from code reading. Scripts are reproducible against this commit.

| ID | Initial | **Verified** | Evidence |
|:---|:---|:---|:---|
| SEC-1 | HIGH | **HIGH — confirmed** | Secret in `message` written cleartext to JSONL; same secret in `data` correctly redacted |
| MEM-1 | HIGH | **HIGH — confirmed** | Process lingered 4999 ms after return; linger tracks `gracePeriodMs` exactly (500/2000/8000 → 500/1999/7998 ms) |
| MEM-3 | MEDIUM | **MEDIUM — confirmed** | Process lingered 5001 ms with all disposes instant |
| PERF-2 | MEDIUM | **MEDIUM — confirmed** | 24 µs/line vs 0.1 µs/line — 256× slower than a persistent writer |
| PERF-1 | MEDIUM | **LOW — overstated** | O(n) scaling confirmed, but only 0.6 ms/call at 50k events; sub-ms at realistic scale |
| PERF-3 | MEDIUM | **LOW — overstated** | 19 ms total across 200,000 events with 12 active calls |
| BUG-1 | MEDIUM | **LOW — unreachable** | `executeStoryInWorktree` swallows even a hard `TypeError` and resolves `{success:false}`; cannot reject |
| MEM-2 | MEDIUM | **LOW — unreachable** | `call_started`/`call_ended` pairing in `spawn-client.ts` is airtight (AC8/AC9 guards) |

### Corrections to the initial assessment

Four findings were graded too severely on first pass:

- **PERF-1 and PERF-3** — I reasoned from algorithmic complexity without measuring magnitude. Both are genuinely O(n) as described, but the constants are small enough that neither is worth prioritising. Downgraded to LOW.
- **BUG-1 and MEM-2** — I flagged missing defensive handling without first testing whether the failure path is reachable. It is not: both subsystems have guards that make the bad state unreachable through any production path. Downgraded to LOW and reframed as defence-in-depth.

The two HIGH findings held up and MEM-1 proved *worse* than described — the linger is the full grace period, not a partial delay.

---

## Findings

### 🔴 HIGH

#### SEC-1: Log redaction covers `data` but not `message` or console output — VERIFIED

**Severity:** HIGH | **Category:** Security
**Files:** `src/logger/logger.ts:164`, `src/logger/logger.ts:110-131`, `src/logger/redact.ts`

```typescript
// logger.ts:164 — file write path
const safeEntry = entry.data ? { ...entry, data: redactSecrets(entry.data) as Record<string, unknown> } : entry;
const line = `${formatJsonl(safeEntry)}\n`;
```

`redactSecrets()` is applied to `entry.data` only. `entry.message` is serialized verbatim. The console path (`logger.ts:110-131`) applies no redaction at all.

**Proof.** Four entries logged through the real `Logger`, then read back from the JSONL file:

```
[A] message="command failed: NPM_TOKEN=npm_ABCDEFGH12345678 bun publish"     <- LEAKED
[B] message="auth failed with ghp_ABCDEFGHIJKLMNOP1234567890"                <- LEAKED
[C] message="env dump"  data={"NPM_TOKEN":"[REDACTED]"}                      <- correctly redacted
[D] message="cmd"       data={"cmd":"publish [REDACTED]"}                    <- correctly redacted
```

Cases C and D prove the redaction engine works: the `KEY=value` pattern and the `ghp_` pattern both fire when reached. Cases A and B carry byte-identical secrets and pass through untouched — the engine is simply never pointed at `message`.

**Risk:** Any log call interpolating a secret into the message string — a failing shell command containing `NPM_TOKEN=...`, an error echoing an auth header, an agent stderr excerpt — writes the credential in cleartext to `.nax` run logs and to the terminal. Run logs are routinely attached to bug reports.

**Fix:**

```typescript
// logger.ts writeToFile
const safeEntry = {
  ...entry,
  message: redactSecrets(entry.message) as string,
  ...(entry.data ? { data: redactSecrets(entry.data) as Record<string, unknown> } : {}),
};
```

Apply the same before console formatting. Add a regression test asserting a `ghp_`-shaped token in `message` is redacted in both sinks — cases A and B above are ready-made.

---

#### MEM-1: Uncleared grace-period timer blocks process exit for the full grace period — VERIFIED

**Severity:** HIGH | **Category:** Memory / Resource leak
**File:** `src/verification/executor.ts:127-129`

```typescript
await Promise.race([
  proc.exited.then(() => { exitedDuringGrace = true; }),
  new Promise<void>((resolve) => {
    setTimeout(resolve, gracePeriodMs);   // handle never captured, never cleared
  }),
]);
```

The same file gets this right 100 lines earlier — `raceWithDeadline()` at `executor.ts:23-29` captures the handle and clears it in `.finally()`, with a comment citing "prevents timer leaks per rule 07". The grace-period race does not follow it.

**Proof.** `executeWithTimeout("sleep 60", 1)` — the child dies promptly on SIGTERM, so the race settles immediately:

```
executeWithTimeout returned after 1012ms (timeout=true, killed=true)
--- function has returned; nothing left to do. Bun should exit NOW. ---
process actually exited at 6011ms  (lingered 4999ms after return)
```

Causality confirmed by varying the parameter — linger equals `gracePeriodMs` exactly:

```
gracePeriodMs=  500  returned@1005ms  exited@1505ms  LINGER=500ms
gracePeriodMs= 2000  returned@1007ms  exited@3006ms  LINGER=1999ms
gracePeriodMs= 8000  returned@1006ms  exited@9004ms  LINGER=7998ms
```

**Risk:** Every timed-out verification run pins the event loop for the full 5-second default *after* all work has completed. This is worse than a memory leak — it is a hard 5-second delay on CLI exit, on the exact path (test timeout) where the user is already waiting. Under parallel execution the timers overlap rather than sum, so the ceiling is 5 s, but it is paid on every run that hits a test timeout.

**Fix:**

```typescript
let graceTimer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    proc.exited.then(() => { exitedDuringGrace = true; }),
    new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, gracePeriodMs); }),
  ]);
} finally {
  clearTimeout(graceTimer);
}
```

Or reuse the existing `raceWithDeadline(proc.exited, gracePeriodMs)` and test the `DRAIN_TIMEOUT` sentinel. A regression test can assert on the linger directly using the harness above.

---

### 🟡 MEDIUM

#### MEM-3: Uncancellable `Bun.sleep` in provider teardown blocks exit — VERIFIED

**Severity:** MEDIUM | **Category:** Memory / Resource leak
**File:** `src/context/engine/providers/plugin-cache.ts:110-125`

```typescript
for (const providers of this.cache.values()) {
  for (const provider of providers) {
    // ...
    await Promise.race([initialisable.dispose(), Bun.sleep(DISPOSE_TIMEOUT_MS)]);
  }
}
```

`Bun.sleep()` cannot be cancelled — the same defect class as MEM-1, in a different subsystem. `src/verification/executor.ts:120-122` documents this exact hazard and works around it; `spawn-client.ts:334-341` provides a ready-made cancellable `makeDrain()` helper.

**Proof.** Three providers, all disposing instantly:

```
disposeAll-equivalent returned after 0ms (all 3 disposes were instant)
process exited at 5001ms -> LINGER=5001ms from uncancelled Bun.sleep timers
```

**Correction to the initial write-up:** I claimed teardown is `O(providers × DISPOSE_TIMEOUT_MS)`. The measurement shows that is wrong for the common case — the timers are armed at effectively the same instant and expire together, so fast disposes cost one timeout total (5001 ms above, not 15000 ms). The multiplication only applies when disposes actually *hang*, since each race then waits its full timeout before the next begins.

**Risk:** A flat 5-second delay on context-engine teardown at the end of every run that used plugin providers, regardless of how fast the providers actually dispose.

**Fix:** Replace `Bun.sleep` with a cancellable `setTimeout` deadline (copy `makeDrain` from `spawn-client.ts:334`), and dispose concurrently via `Promise.allSettled` so a hanging provider cannot serialize the rest.

---

#### PERF-2: One `open`/`write`/`close` syscall per log line — VERIFIED

**Severity:** MEDIUM | **Category:** Performance
**File:** `src/logger/logger.ts:167-171`

```typescript
this.writeQueueTail = this.writeQueueTail.then(() =>
  appendFile(filePath, line).catch((error) => { /* ... */ }),
);
```

`node:fs/promises.appendFile` opens, writes, and closes the file for every entry, and the chain serializes them so there is no batching. The chaining itself is correct for ordering and `flush()` semantics — the cost is the per-entry file handle.

**Proof.** 5,000 representative JSONL lines, current strategy vs. a persistent `Bun.file().writer()`:

```
5000 lines  appendFile-chain=121ms  Bun.writer=0ms  speedup=256x
per-line: appendFile=24us  writer=0.1us
```

**Risk:** 24 µs of serialized syscall time per line. At debug level under parallel execution a run producing 50,000 log lines spends ~1.2 s in the logger, and `flush()` at shutdown must walk whatever remains one syscall triple at a time. Real, but modest in absolute terms — this is a throughput and shutdown-tail issue, not a hang.

**Fix:**

```typescript
this._writer ??= Bun.file(filePath).writer();
this._writer.write(line);
// flush on an interval or every N lines; await this._writer.flush() in flush(); end() in close()
```

`logger.ts:238` currently notes "no manual cleanup needed" — that comment needs updating alongside a `close()` that ends the writer.

---

### 🟢 LOW

#### PERF-1: Cost aggregation re-reduces the entire run history on every read — DOWNGRADED

**Severity:** LOW *(initially MEDIUM)* | **Category:** Performance
**File:** `src/runtime/cost-aggregator.ts:171-234`

`_events` grows for the whole run and is never trimmed; `snapshot()`, `byStory()`, `byCall()` and `byScope()` each spread and re-reduce the full history on every call. `byCall()`/`byScope()` spread the arrays twice. These run per story completion, per escalation tier transition, and per batch (`unified-executor.ts:393,416,512,576`; `tier-outcome.ts:51,76,115,141`; `metrics/tracker.ts:154,202`; `completion.ts:33`; `run-phase.ts:257`).

**Measurement.** 40 reads (one per story in a 40-story run), varying total event count:

```
events= 2000  40x byStory=2.0ms   40x snapshot=1.3ms   40x byCall=5.5ms
events=20000  40x byStory=9.8ms   40x snapshot=7.6ms   40x byCall=46.2ms
events=50000  40x byStory=24.0ms  40x snapshot=17.6ms  40x byCall=124.8ms
```

**Why this was downgraded.** The O(n) scaling is real and confirmed — 25× the events produces 23× the time. But the constants are tiny: even at 50,000 cost events (i.e. 50,000 agent calls, far beyond a realistic run) `byStory()` costs 0.6 ms per call. At a realistic few thousand events it is well under 0.1 ms. This is a latent scaling concern worth fixing opportunistically, not a bottleneck.

**Fix (when convenient):** accumulate incrementally in `record()` — maintain a running `CostSnapshot` plus `Map`s keyed by agent/stage/story/call/scope. Reads become O(1). Keep `_events` for `drain()`'s sorted JSONL write.

---

#### PERF-3: Full `Map` copy on every stream event in the TUI hook — DOWNGRADED

**Severity:** LOW *(initially MEDIUM)* | **Category:** Performance
**File:** `src/tui/hooks/useAgentStreamEvents.ts:48`

```typescript
const next = new Map(activeCallsRef.current);   // copy on every event
```

The hook's own design comment (lines 30-31, 38) states refs are updated synchronously and never trigger re-renders, with state drained at 150 ms. Given that, the defensive copy buys nothing — line 145 already takes the snapshot React consumes. `agent.message_update` fires per streamed text chunk (`parser.ts:87-90`).

**Measurement.** 200,000 events — roughly a very long streaming run:

```
activeCalls= 1  200000 events:  copy=12ms  mutate=1.9ms  ratio=6x
activeCalls= 4  200000 events:  copy=10ms  mutate=1.4ms  ratio=7x
activeCalls=12  200000 events:  copy=19ms  mutate=1.4ms  ratio=13x
```

**Why this was downgraded.** 19 ms spread across 200,000 events is not perceptible. The copy is redundant and worth removing for clarity, but it is not a performance problem.

**Fix:** mutate `activeCallsRef.current` in place and let line 145 remain the single snapshot boundary — exactly what `agent-stream-logging.ts:47-78` already does.

---

#### BUG-1: Parallel scheduler has no `.catch()` — DOWNGRADED (unreachable)

**Severity:** LOW *(initially MEDIUM)* | **Category:** Bug / defence-in-depth
**File:** `src/execution/parallel-worker.ts:175-218`

```typescript
const executePromise = _parallelWorkerDeps.executeStoryInWorktree(...)
  .then((result) => { /* record success/failure */ })
  .finally(() => { executing.delete(executePromise); });   // no .catch()
```

**Why this was downgraded.** I tested whether `executeStoryInWorktree` can actually reject by passing `dependencyContext: null` to force an internal `TypeError`:

```
PART1: resolved (did NOT reject) -> {"success":false,"cost":0,"error":"null is not an object (evaluating 'dependencyContext.cwd')"}
```

Its `try` wraps the entire body (`parallel-worker.ts:50-91`) and the catch returns a well-formed failure result. The promise provably cannot reject through any production path. `routeTask` sits outside the try but is synchronous, so a throw there propagates directly out of the loop — a `.catch()` would not intercept it anyway.

**Why it is still worth fixing.** The consequence, if the invariant is ever broken (the dep is injectable via `_parallelWorkerDeps`), is disproportionate. Simulating the scheduler's exact promise shape with one rejecting member:

```
PART2: scheduler ABORTED -> Error: boom; siblings still in flight = 2
PART2: after siblings finished, recorded=["B","C"] (B,C completed but scheduler had already thrown)
```

Two sibling stories ran to completion in their worktrees and their results were silently discarded, because the scheduler had already unwound. The equivalent scheduler in `acceptance-setup.ts:283` does attach a `.catch()` — this is the outlier of the two.

**Fix:** add a `.catch()` recording the story as failed, and switch the tail to `Promise.allSettled(executing)`.

---

#### MEM-2: Per-call tracking maps have no TTL sweep — DOWNGRADED (unreachable)

**Severity:** LOW *(initially MEDIUM)* | **Category:** Memory / defence-in-depth
**Files:** `src/tui/hooks/useAgentStreamEvents.ts:32,35`; `src/runtime/middleware/agent-stream-logging.ts:18`

Both keep state keyed by `callId`, removed only on `agent.call_ended`, with no TTL sweep and no clear on unsubscribe.

**Why this was downgraded.** I traced every emit site. The pairing is airtight:

- `agent.call_started` is emitted from exactly one place — `spawn-client.ts:249-256` — and only *after* spawn succeeds and a PID is obtained.
- If spawn throws, `spawn-client.ts:234-237` emits `call_ended` **without** a prior `call_started` (documented as AC9), so no entry is ever created.
- Between `call_started` (line 256) and the guarded `try` (line 281) there is only closure and variable declaration — nothing that can throw.
- Inside, the `callEndedEmitted` flag (lines 278, 366, 381, 397-399) guarantees `call_ended` on every terminal path including the catch-all.

`idle-watchdog.ts:321-330` additionally clears its map on teardown; the other two rely on closure release, which is sufficient since the subscriber is the only referent.

**Fix (optional hardening):** clear both refs in the subscribe effect's cleanup, and add a TTL sweep in the existing 150 ms drain interval. Cheap insurance if a non-spawn-client emit path is ever added.

---

#### BUG-2: Floating `proc.exited.then()` with no rejection handler

**Severity:** LOW | **Category:** Bug
**Files:** `src/quality/runner.ts:127-129`, `src/verification/executor.ts:124-126`

No `.catch()`. If `proc.exited` ever rejects, this surfaces as an unhandled rejection, which `crash-signals.ts:244` escalates to full crash teardown — disproportionate to the cause. Add `.catch(() => {})`; the flag's default already encodes the safe fallback.

#### MEM-4: Deliberately non-settling promise retains the provider rejection closure

**Severity:** LOW | **Category:** Memory
**File:** `src/context/engine/orchestrator.ts:105-110`

Intentional and documented, and the graph does become unreachable once the race result is released — not a true leak. Flagged only because "return a permanently pending promise" breaks if anyone later stores the race result. Add a `@design` remark if the shape is kept.

#### STYLE-1: 56 source files exceed the 400-line guideline

**Severity:** LOW | **Category:** Style
Top offenders: `prompts/builders/rectifier-builder.ts` (902), `agents/manager.ts` (817), `agents/acp/spawn-client.ts` (737), `session/manager.ts` (707), `execution/unified-executor.ts` (689). `bun run check:file-sizes` ratchets these so they cannot grow — the right control — but `rectifier-builder.ts` at 902 is 50% over the stated 600-line hard limit and splits naturally by prompt family.

#### TYPE-1: 17 `any` / `as any` occurrences

**Severity:** LOW | **Category:** Type safety
Low for 112k LOC and within the project's "no `any` without explicit justification" rule. Worth confirming each has a justifying comment.

#### ENH-1: 27 untracked TODO/FIXME markers

**Severity:** LOW | **Category:** Enhancement
The codebase already tracks issues inline well in places (`#253`, `BUG-114`, `#93`); the remaining bare markers should follow.

---

## What This Codebase Gets Right

Recording these so future reviews do not re-flag them — several were candidate findings that verification cleared:

- **`src/agents/acp/spawn-client.ts`** — `call_started`/`call_ended` pairing is airtight across every terminal path, including spawn failure (AC9) and the catch-all (AC8). Verified by tracing all emit sites; this is what made MEM-2 unreachable.
- **`src/execution/parallel-worker.ts:50-91`** — `executeStoryInWorktree` swallows even a hard `TypeError` and returns a well-formed failure result. Verified by forcing an internal throw; this is what made BUG-1 unreachable.
- **`src/execution/crash-signals.ts:226-262`** — every `process.on` has a matching `removeListener` in the returned cleanup, all fatal handlers share one `shuttingDown` flag to prevent cascade double-teardown, and SIGPIPE is explicitly handled (Bun, unlike Node, does not `SIG_IGN` it).
- **`src/runtime/middleware/idle-watchdog.ts:318-330`** — complete teardown: unsubscribe, clear every per-call grace timer, clear the map, clear the tick handle. The tick self-cancels when `activeStates` empties rather than polling forever.
- **`src/agents/acp/spawn-client.ts:334-347` and `src/quality/runner.ts:149-161`** — cancellable drain deadlines, stdout and stderr drained *concurrently with* `proc.exited` to avoid the 64 KB pipe-buffer deadlock, with the reasoning documented at the call site.
- **`src/logger/redact.ts`** — two-layer redaction with a correct `TOKEN(?!s\b)` lookahead avoiding false hits on `inputTokens`. Verified working; SEC-1 is purely about which fields it is applied to.
- **Error handling discipline** — every `JSON.parse` call site inspected is inside a `try` with an explanatory catch comment.
- **Testability** — `_deps` injection applied consistently, 956 test files, `mock.module()` banned for the documented Bun-1.x leak reason.
- **Convention enforcement in CI** — ten custom gates turn written rules into build failures rather than review burden.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | SEC-1 | S | Redact `entry.message` on both the file and console log paths |
| P0 | MEM-1 | S | Clear the grace-period timer in `executor.ts` (or reuse `raceWithDeadline`) |
| P1 | MEM-3 | S | Replace `Bun.sleep` with a cancellable deadline; dispose providers concurrently |
| P2 | PERF-2 | M | Switch the logger to a persistent `Bun.file().writer()` with periodic flush |
| P3 | BUG-1 | S | Add `.catch()` to the parallel scheduler; use `allSettled` for the tail |
| P3 | BUG-2 | XS | Add `.catch(() => {})` to floating `proc.exited.then()` calls |
| P3 | PERF-3 | XS | Stop copying the `Map` per stream event (clarity, not speed) |
| P4 | PERF-1 | M | Accumulate cost snapshots incrementally — latent scaling, not current pain |
| P4 | MEM-2 | S | Optional: TTL sweep + clear refs on unsubscribe as insurance |
| P4 | STYLE-1 | M | Split `rectifier-builder.ts` (902 lines) by prompt family |
| P4 | TYPE-1 | S | Audit the 17 `any` sites for justifying comments |
| P4 | ENH-1 | S | Convert 27 bare TODO/FIXME markers to issues or `@design` remarks |

---

## Review Scope & Limits

Targeted deep review driven by the requested categories (bugs, memory leaks, performance), not a full line-by-line audit of all 761 files. Coverage concentrated on:

- All timer, signal, subprocess, and event-listener registration sites (grep-complete across `src/`)
- Long-lived state containers (aggregators, registries, caches, per-call maps)
- Concurrency schedulers and `Promise.race` / `Promise.all` boundaries
- The TUI React hooks (memory and re-render behaviour)
- The logging and redaction path

**Verification method:** each finding was exercised with a runnable script against this commit — real `Logger` and `executeWithTimeout` invocations for SEC-1/MEM-1, parameter-sweep causality tests for MEM-1, benchmarks for PERF-1/2/3, and fault injection for BUG-1. Emit-site tracing was used for MEM-2 where no runtime harness was practical.

**Not covered:** the prompt builders, routing strategies, debate subsystem, plan/PRD state machines, and the TUI's presentational components were not read in depth. Dependency vulnerability scanning (`bun audit`) was not run. The project's own test suite was not executed as part of this review — the verification scripts above are independent harnesses, not additions to `test/`.
