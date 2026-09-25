# Memory Leak Investigation Strategy

> Use this guide when `bun test test/unit/` (or any large test subset) hangs and consumes excessive memory (multi-GB RSS). Symptom on record: `bun test test/unit/ --timeout=5000` stuck for >5 min, ~20 GB RAM.

## Background

The unit suite has roughly 1,300 test files that run in a single Bun process. Three known classes of leak make this hang/RAM-bloat possible:

1. **Unclosed `NaxRuntime` instances** — each runtime registers an idle-watchdog `setTimeout` that keeps the event loop alive. `test/helpers/runtime.ts` auto-tracks runtimes created via `makeTestRuntime` / `makeMockRuntime` and closes them in an `afterEach`. Runtimes built any other way (a direct `createRuntime` call) are not tracked and must be closed by the test itself.
2. **Naked `setTimeout` in tests** — `await new Promise(r => setTimeout(r, N))` with no `AbortController` keeps timers pending if the surrounding test throws or aborts.
3. **`attachAgentIdleWatchdog` / `setInterval`-like APIs** — these return an `unsubscribe` callback. If a test creates one and the test then throws before `unsubscribe()` is reached, the internal tick timer keeps firing.

The wrapper `scripts/run-tests.ts` time-boxes phases and kills the process group on hang, abnormal exit (Bun panic / SIGSEGV / SIGABRT), and forwarded SIGINT/SIGTERM. Bare `bun test <dir>` invocations bypass it — a Bun panic there leaves the test-spawned descendants (acpx, agent procs) orphaned.

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

# Custom output path / memory threshold (MB)
bun run scripts/find-memory-leak.ts --out /tmp/leak.csv --mem-threshold 250

# Default output: /tmp/find-memory-leak.csv  (file,exit_code,duration_ms,peak_rss_mb,verdict)
```

**Triage rules:**

| Verdict | Meaning | Action |
|:---|:---|:---|
| `HANG` (exit 124) | Timer/handle kept the event loop alive past `--timeout` | Go to Phase B |
| `MEM_HIGH` (peak_rss > `--mem-threshold`, default 500 MB) | Allocates too much; possibly leaks per-test | Go to Phase B |
| `CRASH` (exit 134/132/139) | Bun runtime crash (SIGABRT/SIGILL/SIGSEGV) | Split the file; file a Bun upstream issue if reproducible |
| `FAIL` (any other non-zero exit) | Ordinary test failure | Fix the test; not a leak signal on its own |
| `OK` | Healthy | Skip |

Expected total run time scales with file count — budget roughly 15–30 min for the full unit tree at 4-way parallel.

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
grep -rn "createRuntime(" test/ \
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

### Phase D — Extend the regression gate

`scripts/check-runtime-cleanup.sh` (`bun run check:runtime-cleanup`) already guards the most common leak. It fails when:

1. `test/helpers/runtime.ts` no longer provides the centralized `afterEach` teardown (`runtime.close()` / `Promise.allSettled`).
2. A `*.test.ts` file calls `createRuntime(` without any `.close(` call.

It runs in `check:all-without-biome`, so the pre-commit hook (`.githooks/pre-commit` → `check:all`) and CI enforce it. The rule itself lives in `.nax/rules/forbidden-patterns-source.md`.

Once Phase B identifies a new failure mode, extend the script (or add a sibling `check:*` gate wired into `check:all-without-biome`) so the same leak cannot regress. Candidates the script does not yet enforce:

- Per-file `setTimeout` count ≤ `clearTimeout` + `AbortController` count + N (N tuned to whitelist legitimate polling helpers).
- `beforeAll` count == `afterAll` count per file.

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
        Phase D: extend check-runtime-cleanup.sh
```

## Related

- [.nax/rules/testing-commands.md](../../.nax/rules/testing-commands.md) — Why bare `bun test` is banned
- [.nax/rules/forbidden-patterns-source.md](../../.nax/rules/forbidden-patterns-source.md) — Runtime cleanup rule
- [scripts/check-runtime-cleanup.sh](../../scripts/check-runtime-cleanup.sh) — Runtime cleanup gate
- [test/helpers/runtime.ts](../../test/helpers/runtime.ts) — Auto-tracking afterEach
- [scripts/run-tests.ts](../../scripts/run-tests.ts) — Phase-capped wrapper for full suite
