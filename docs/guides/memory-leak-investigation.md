# Memory Leak Investigation Strategy

> Use this guide when `bun test test/unit/` (or any large test subset) hangs and consumes excessive memory (multi-GB RSS). Symptom on record: `bun test test/unit/ --timeout=5000` stuck for >5 min, ~20 GB RAM.

## Background

The unit suite has 627 test files that run in a single Bun process. Three known classes of leak make this hang/RAM-bloat possible:

1. **Unclosed `NaxRuntime` instances** — each runtime registers an idle-watchdog `setTimeout` that keeps the event loop alive. `test/helpers/runtime.ts` auto-tracks runtimes created via `makeTestRuntime` / `makeMockRuntime` and closes them in an `afterEach`. Runtimes built any other way (direct `createRuntime`, `new NaxRuntime`) are not tracked.
2. **Naked `setTimeout` in tests** — `await new Promise(r => setTimeout(r, N))` with no `AbortController` keeps timers pending if the surrounding test throws or aborts.
3. **`attachAgentIdleWatchdog` / `setInterval`-like APIs** — these return an `unsubscribe` callback. If a test creates one and the test then throws before `unsubscribe()` is reached, the internal tick timer keeps firing.

The wrapper `scripts/run-tests.ts` time-boxes phases and kills the process group on hang, but bare `bun test <dir>` invocations bypass it.

## Investigation Phases

Run phases A and C in parallel. B and D follow once suspects are identified.

---

### Phase A — Isolate the hanging file(s)

Run every test file in its own short-lived child process; record exit code, duration, and peak RSS. Hangs become `exit 124`; runaway memory shows as a high `peak_rss_mb`.

**Tool:** [`scripts/find-memory-leak.ts`](../../scripts/find-memory-leak.ts)

**Usage:**

```bash
# Scan all unit tests (default: 4-way parallel, 30s per file)
bun run scripts/find-memory-leak.ts

# Custom dir / concurrency / timeout
bun run scripts/find-memory-leak.ts --dir test/unit/runtime --parallel 2 --timeout 60

# Output: /tmp/find-memory-leak.csv  (file,exit_code,duration_ms,peak_rss_mb,verdict)
```

**Triage rules:**

| Verdict | Meaning | Action |
|:---|:---|:---|
| `HANG` (exit 124) | Timer/handle kept the event loop alive past `--timeout` | Go to Phase B |
| `MEM_HIGH` (peak_rss > 500 MB) | Allocates too much; possibly leaks per-test | Go to Phase B |
| `CRASH` (exit 134/132/139) | Bun runtime crash (SIGABRT/SIGILL/SIGSEGV) | Split the file; file a Bun upstream issue if reproducible |
| `OK` | Healthy | Skip |

Expected total run time: ~8–15 min for 627 files at 4-way parallel.

---

### Phase B — Confirm the leak vector inside each suspect

For each file flagged by Phase A:

1. **Reproduce in isolation:**
   ```bash
   timeout -k 5s 30s bun test <file> --timeout=5000
   ```
   Note: a file that runs fine alone but fails in a batch indicates cross-file contamination — check globals, module-level `afterEach`, and singleton runtimes.

2. **Sample RSS while running:**
   ```bash
   bun test <file> --timeout=5000 &
   PID=$!
   while kill -0 $PID 2>/dev/null; do
     grep -E "VmRSS|VmPeak" /proc/$PID/status
     sleep 0.5
   done
   ```
   A monotonically rising `VmRSS` across tests means per-test leak. A flat RSS that never exits means a hung timer.

3. **Binary-search inside the file:**
   - Comment out half the `test()` blocks (use `test.skip()` or `test.only()` on the other half).
   - Re-run; whichever half hangs/leaks contains the bad test.
   - Narrow until a single test is identified.

4. **Inspect the bad test for:**
   - `attachAgentIdleWatchdog(...)` / `setInterval` / `setTimeout` without paired cleanup
   - Direct `createRuntime(...)` calls (bypasses auto-cleanup)
   - `beforeAll` that creates timers/runtimes with no matching `afterAll`
   - Real `Bun.spawn` of subprocesses without `proc.kill()`
   - `mock.module()` (banned — should already be 0)

---

### Phase C — Static audit (runs in parallel with Phase A)

These greps surface the same patterns Phase A finds dynamically. Run them up-front to seed Phase B with priors.

```bash
# 1. NaxRuntime constructed outside the helper (bypasses auto-cleanup)
grep -rn "createRuntime\|new NaxRuntime" test/ \
  | grep -v "test/helpers/runtime.ts"

# 2. setTimeout without matching clearTimeout (per-file count)
for f in $(grep -rln "setTimeout" test/unit/); do
  s=$(grep -c "setTimeout" "$f")
  c=$(grep -c "clearTimeout" "$f")
  [ "$s" -gt "$c" ] && echo "RISK $f setTimeout=$s clearTimeout=$c"
done

# 3. attachAgentIdleWatchdog called outside try/finally
grep -rn "attachAgentIdleWatchdog\|setInterval" test/unit/

# 4. Real subprocess spawning (skipped if mocked via _deps)
grep -rn "Bun.spawn\|spawnSync" test/unit/ \
  | grep -v "_deps\|mock\|helpers\|spawn-client"

# 5. beforeAll without matching afterAll (cleanup mismatch)
for f in $(grep -rln "beforeAll" test/unit/); do
  ba=$(grep -c "beforeAll" "$f"); aa=$(grep -c "afterAll" "$f")
  [ "$ba" -gt "$aa" ] && echo "MISMATCH $f beforeAll=$ba afterAll=$aa"
done

# 6. Describe-scope runtimes (created at module eval, not per-test)
grep -rln "^const runtime = make\|^let runtime = make\|  const runtime = make" test/unit/
```

Cross-reference grep hits with Phase A's CSV — overlaps are highest-priority targets.

---

### Phase D — Add the regression gate

`.claude/rules/forbidden-patterns.md` references `scripts/check-runtime-cleanup.sh` but no such script exists. Once Phase B identifies the failure mode, create the gate so the same leak cannot regress:

`scripts/check-runtime-cleanup.sh` must enforce, with non-zero exit on violation:

1. Any file importing `makeTestRuntime` / `makeMockRuntime` must also import from `@test/helpers` (so the global `afterEach` from `test/helpers/runtime.ts` is registered).
2. No test file imports `createRuntime` or `NaxRuntime` directly from `@/runtime`.
3. Per-file `setTimeout` count ≤ `clearTimeout` + `AbortController` count + N (N tuned to whitelist legitimate `await sleep` polling helpers).
4. `beforeAll` count == `afterAll` count per file.

Wire it into:
- `package.json` `lint` script (alongside `check:alias-internals`, `check:deep-relatives`)
- pre-commit hook
- CI

---

## Decision tree

```
bun test test/unit/ hangs / OOMs
        │
        ├─► Run Phase A (find-memory-leak.ts) ──► CSV of suspects
        │       │
        │       └─► For each suspect: Phase B ──► single offending test()
        │                                              │
        │                                              ▼
        │                                       Fix root cause
        │                                       (close runtime, clear timer,
        │                                        scope to AbortController, etc.)
        │
        └─► Phase C grep audit ──► seed Phase B with priors
                │
                ▼
        Phase D: codify the rule in check-runtime-cleanup.sh
```

## Related

- [.claude/rules/testing-commands.md](../../.claude/rules/testing-commands.md) — Why bare `bun test` is banned
- [.claude/rules/forbidden-patterns.md](../../.claude/rules/forbidden-patterns.md) — Runtime cleanup rule
- [test/helpers/runtime.ts](../../test/helpers/runtime.ts) — Auto-tracking afterEach
- [scripts/run-tests.ts](../../scripts/run-tests.ts) — Phase-capped wrapper for full suite
