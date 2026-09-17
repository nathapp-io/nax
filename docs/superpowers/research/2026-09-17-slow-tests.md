# Slow-test investigation — research notes

> Branch: `investigate/slow-tests` (2026-09-17).
> Triggered by: GitHub Actions `bun run test` wall-clock drifting upward.
> Reproducer: `bun test --reporter=junit --reporter-outfile=… test/{unit,integration,ui}/`
> + `bun run scripts/slow-tests.ts <xml> --top=N --min=MS`.

## TL;DR

Three established patterns already exist in the repo and account for the bulk of the
fixable slowdown. The "tail" (≥200ms tests) is dominated by **a handful of slow
tests in five areas**, not by general drift — fixing them should recover 10–15s of
wall-clock on `bun run test`.

| Cluster | Tests | Cause | Existing pattern to copy | Wall-clock saving |
|---|---:|---|---|---:|
| Process-group not killed | 1 (5.0s) | `defaultRun` only `proc.kill()`s the shell | `killProcessGroup` + `detached: true` (used in 15 other files) | ~4.5s |
| UI `setTimeout(220)` drain wait | 14 (~3.2s) | hardcoded `DRAIN_WAIT_MS` | `test/helpers/fake-clock.ts` + `jest.useFakeTimers()` (bun 1.4.0) | ~2.5–3.0s |
| CLI precheck tests | 7 (~4.0s) | three git spawns per test (cold-start) | share fixture repo via `beforeAll` | ~2.5–3.0s |
| MCP stdio-server cold spawn | 4 (~0.7s) | one stdio server per test | share via `beforeAll` | ~0.4s |
| Atomic-rename reader loop | 1 (~1.7s) | up to 5000 reads | tighten loop bound | ~0.8s |

Wall-clock baselines (local, single process, parallel):

- `unit`: 45.74s · `integration`: 11.07s · `ui`: 4.67s · **`bun run test` total ≈ 61.5s**

After all fixes: estimated **`bun run test` total ≈ 50–52s** (~15–18% reduction).
CI is currently bumping into the 15-min budget (`timeout-minutes: 15` in
`.github/workflows/ci.yml:38`); see "Bigger wins" below for higher-leverage moves.

## 1. The slow tail

Top offenders collected from `scripts/slow-tests.ts` against a fresh
`bun test --reporter=junit` run. Full data captured under `/tmp/opencode/`.

### 1.1 Unit (95 tests ≥200ms, totalling 128.4s of CPU time)

| ms | File | Test | Category |
|---:|------|------|---|
| 5002 | `test/unit/forge/deps.test.ts:35` | substitutes exit code 124 when killed process reports exit 0 | A — process group not killed |
| 2003 | `test/unit/agents/native/ambient-probe.test.ts:77` | hung probe times out to TRUE | B — intrinsic 2s timeout |
| 1676 | `test/unit/utils/json-file.test.ts:28` | reader in another process never observes torn write | C — up-to-5000-read loop |
| 1622 | `test/unit/scripts/check-story-workdir-access.test.ts:519` | throws naming the file outside Program | D — TypeScript Program build |
| 1215 | `test/unit/scripts/biome-nested-worktree-config.test.ts:43` | nested `.worktrees/` biome.json | E — `bun x biome check` cold-start |
| 1004 | `test/unit/worktree/dependencies.test.ts:83` | provision times out and kills the whole process group | B — intrinsic 1s timeout |
| 787 | `test/unit/agents/native/client.test.ts` | baseUrl override reaches the WIRE (nax#2019) | F — HTTP fixture spin-up |
| 758 | `test/unit/agents/native/client.test.ts` | override survives dispatch (nax#1982) | F |
| 619 | `test/unit/scripts/check-story-workdir-access.test.ts` | flags raw read on UserStory binding | D |
| 580 | `test/unit/tools/run-command.test.ts` | rejected-value key in declared command | — |
| 551 | `test/unit/precheck/precheck-model-resolution-run.test.ts` | AC11 | E |
| 540 | `test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` | Tier 2 warnings | E |
| 537 | `test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` | Tier 1 blockers | E |
| 495 | `test/unit/scripts/check-story-workdir-access.test.ts` | superset property vs regex predecessor | D |

### 1.2 Integration (23 tests ≥100ms, totalling 31.2s)

| ms | File | Test |
|---:|------|------|
| 661 / 637 / 606 | `test/integration/cli/cli-precheck-run.test.ts` | US-002 AC4 / AC6 / AC3 |
| 596 | `test/integration/mcp/stdio-server.test.ts` | hanging call bounded by `timeoutMs` |
| 593 / 584 / 580 / 565 | `test/integration/cli/cli-precheck-command.test.ts` | -d / -f / --json / resolveProject |
| 252 × 2 | `test/integration/agents/fail-stale-watchdog.test.ts` | periodic activity events not cancelled |
| 193 / 186 / 108 | `test/integration/mcp/stdio-server.test.ts` | R7 / upgrade lock / advertised tools |
| 181 | `test/integration/agents/fail-stale-watchdog.test.ts` | tool_call_update secondary cap |
| 118 / 113 | `test/integration/worktree/worktree-merge.test.ts` | merge engine story processing |

### 1.3 UI (23 tests ≥100ms, totalling 15.8s of CPU time)

All 14 tests in `test/ui/useAgentStreamEvents.test.tsx` cluster at ~228ms because
`test/ui/useAgentStreamEvents.test.tsx:17` defines `const DRAIN_WAIT_MS = 220`,
used inside the `drain()` helper at line 99:

```ts
const drain = async () => {
  await Promise.resolve(
    act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));
    }),
  );
};
```

`drain()` waits past the hook's `setInterval(..., RENDER_INTERVAL_MS = 150)` at
`src/tui/hooks/useAgentStreamEvents.ts:151`. Since `RENDER_INTERVAL_MS` and
`DRAIN_WAIT_MS` are co-derived (one drain tick is the unit), the test cannot go
below ~150ms without rewriting the helper.

## 2. Patterns this codebase already has

These are the established "fix-the-slow-test" tools in the repo — every proposal
in §3 is just applying one of them.

### 2.1 `killProcessGroup` + `detached: true` — for `Bun.spawn` with a timeout

**Module:** `src/utils/process-kill.ts` (48 lines).

```ts
// src/utils/process-kill.ts:28
export function killProcessGroup(pid: number, signal: NodeJS.Signals | number): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try { process.kill(pid, signal); return true; }
      catch { return false; }
    }
    return true;
  }
}
```

**Why detached matters:** without `detached: true`, `Bun.spawn` does not
`setpgid` children into their own group, so `kill(-pid)` targets a group the
shell isn't the leader of, and only the `/bin/sh` wrapper dies. The grandchild
(a package manager, a test runner, `sleep 5`, etc.) keeps running and holds the
stdout pipe open — exactly the bug `forge/deps.test.ts:35` exposes.

**Already used in 15 places.** Most relevant reference implementations:

- `src/verification/executor.ts:99` — `executeWithTimeout`, the most battle-tested
  version. Has SIGTERM→grace→SIGKILL, drain-deadline races against `proc.exited`
  (Bun bug workaround at line 178–183), and `.catch(() => "")` on the text reads
  so the timeout path always returns a result.
- `src/utils/argv-exec.ts:57` — `runArgv`, the simpler dep-injectable form that
  `worktree/dependencies.ts` consumes. Good model for a non-shell-command runner.
- `src/quality/runner.ts:99` — `runQualityCommand`, the shell-based runner.
- `src/execution/timeout-handler.ts:40` — `withProcessTimeout` helper.

**What `forge/deps.ts:defaultRun` is missing.** It is a pre-lift duplicate of the
`auto-pr` runner and was never upgraded. The diff to fix it is small (see §3.1).

### 2.2 `makeFakeClock` — for dep-injectable virtual timers

**Module:** `test/helpers/fake-clock.ts` (138 lines).

A drop-in `setTimeout`/`clearTimeout` pair backed by a sorted heap of deadlines.
`await clock.advance(ms)` moves time forward, fires every timer that comes due
in order, and drains microtasks after each callback (so async chains settle
before the next firing). The clock has a `MAX_TIMERS_PER_ADVANCE = 10_000`
ceiling that throws rather than hangs if a callback re-arms itself at 0ms — which
is the failure mode that fake timers usually paper over.

**Already used in:**

- `test/unit/plugins/builtin/otel-heartbeat.test.ts` — heartbeat intervals.
- `test/unit/runtime/middleware/_idle-watchdog-harness.ts` — watchdog escalations.
- `test/unit/helpers/fake-clock.test.ts` — the helper's own tests (15 cases).

**The seam is `_deps.setTimeout`.** Every consumer in the repo follows the same
pattern: clone the function's deps object into the test, replace
`setTimeout`/`clearTimeout` with the clock's, drive time with `clock.advance`.

This is the **right tool** for the heartbeat / batch-queue / watchdog tests
that currently sit at 200–320ms because of real-timer waits, but it is **not**
the right tool for `useAgentStreamEvents` — that hook calls `setInterval`
directly inside a React effect with no `_deps` seam, so a clock has nowhere to
go in. For React hooks, `jest.useFakeTimers()` is the cleaner option (§2.3).

### 2.3 `jest.useFakeTimers()` (bun 1.4.0) — for un-seamed globals

`bun:test` re-exports `jest`, and bun 1.4.0 ships `useFakeTimers` /
`advanceTimersByTime` / `runOnlyPendingTimers`. Probed locally:

```ts
import { jest, test, expect } from "bun:test";

test("fake timers fire on advance", () => {
  jest.useFakeTimers();
  let count = 0;
  const i = setInterval(() => { count++; }, 100);
  jest.advanceTimersByTime(350);
  expect(count).toBe(3);        // 100/200/300 fires; 400 > 350 so it doesn't
  clearInterval(i);
  jest.useRealTimers();
});
```

Passes. Verified bun:test version: `1.4.0 (34cbb9a40)`.

**Confirmed available in 1.4.0:**

- `jest.useFakeTimers()`
- `jest.useRealTimers()`
- `jest.advanceTimersByTime(ms)`
- `jest.runOnlyPendingTimers()`

**Confirmed missing in 1.4.0:**

- `jest.advanceTimersByTimeAsync(ms)` — undefined at runtime.

So a fake-timer-driven async test must do `jest.advanceTimersByTime` + a manual
microtask drain (or just `await Promise.resolve()` a few times), not call the
async variant.

### 2.4 Parallelism + timings — for suite-level speed

Bun has parallel test execution (`--parallel`), shard splitting (`--shard`),
and a `--timings` cache that lets each shard balance by total time instead of
file count. The nax CI does not currently use any of these — three sequential
`bun test` steps run on a single core.

For a project of nax's size (~1,400 unit test files), `--parallel` is the
single biggest suite-level lever: bun's own docs claim 266 React SSR tests
faster than Jest can print its version number. See "Bigger wins" below.

## 3. Proposed fixes (ranked by ROI)

### 3.1 Fix `defaultRun` to kill the process group (P0, ~4.5s saving)

**File:** `src/forge/deps.ts`

`defaultRun` is the only subprocess runner in the repo that still uses
`proc.kill()` instead of `killProcessGroup(-pid, signal)` and is missing
`detached: true`. This is the same defect `MEM-4` / `BUG-13` / `BUG-2` already
fixed in `argv-exec.ts`, `executor.ts`, `quality/runner.ts`, etc.

```ts
// src/forge/deps.ts:27 — replace with the runArgv pattern
import { killProcessGroup } from "../utils/process-kill";
import { spawn as bunSpawn } from "../utils/bun-deps";

export async function defaultRun(
  cmd: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn([...cmd], {
    cwd: opts.cwd, stdout: "pipe", stderr: "pipe", detached: true,
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, "SIGKILL");
  }, timeoutMs);
  try {
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited, stdoutPromise, stderrPromise,
    ]);
    return timedOut
      ? { exitCode: exitCode === 0 ? 124 : exitCode, stdout, stderr: `${stderr}\n[forge] command killed after ${timeoutMs}ms timeout` }
      : { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}
```

And the existing test at `test/unit/forge/deps.test.ts:35` (5s) drops to
~0.1s because `sleep 5` actually dies with the shell — `trap 'exit 0' TERM`
fires, the test asserts exit code 124, and we're done. The assertion semantics
are preserved: the *same* shell exits 0 inside the SIGTERM window.

**Side effect (intentional):** `auto-pr/index.ts:42` carries its own duplicate
of `defaultRun` (acknowledged in `src/forge/deps.ts:23–25`). It should be
replaced with `import { defaultRun } from "@/forge/deps"` as part of the same
change. That's the second half of the "lifted verbatim" comment.

### 3.2 Switch `useAgentStreamEvents` tests to fake timers (P0, ~2.5–3s saving)

**File:** `test/ui/useAgentStreamEvents.test.tsx`

Wrap each test (or use a top-level `beforeEach`/`afterEach`) with
`jest.useFakeTimers()` / `jest.useRealTimers()`, and replace
`drain()`'s `setTimeout(resolve, DRAIN_WAIT_MS)` with
`jest.advanceTimersByTime(DRAIN_WAIT_MS)`.

The catch is the `act()` wrapper around `setTimeout`:
`act` returns React's own `Thenable`, not a `Promise`, which trips biome's
`useAwaitThenable` rule (note at `test/ui/useAgentStreamEvents.test.tsx:91–95`).
Two options:

1. **Cheaper:** keep the wall-clock `setTimeout` but lower `DRAIN_WAIT_MS` to
   `RENDER_INTERVAL_MS + 20` (i.e. 170ms). Tests still wait, but each is ~50ms
   cheaper — ~700ms saving across 14 tests.
2. **Real fix:** advance the fake clock; you'll need a small adapter that
   pushes the `act()` await through `Promise.resolve()` so `advance` can fire
   synchronously inside it. Sketch:

   ```ts
   beforeEach(() => { jest.useFakeTimers(); });
   afterEach(() => { jest.useRealTimers(); });
   const drain = async () => {
     await Promise.resolve(act(() => {
       jest.advanceTimersByTime(DRAIN_WAIT_MS);
     }));
   };
   ```

   Verify with a single test before propagating. The React render itself
   happens synchronously when `setInterval` fires under fake timers, so no
   extra `act` flush is needed.

Estimated post-fix test time: <5ms per test (was ~228ms). Total saving:
~3.1s of CPU time.

### 3.3 Share git repo across CLI precheck tests (P1, ~2.5s saving)

**Files:**

- `test/integration/cli/cli-precheck-command.test.ts` (4 slow tests @ 565–593ms each)
- `test/integration/cli/cli-precheck-run.test.ts` (3 slow tests @ 606–661ms each)

Each test currently does `git init` + `git config` + `git add` + `git commit`
synchronously via `Bun.spawnSync` — three to four cold git spawns per test,
~150ms each. Lift `git init` / `git config` to a `beforeAll`, and have each test
write a unique PRD file then call `git add <prd>; git commit` (one spawn per
test). Alternatively, commit once and skip the per-test commit by writing the
PRD as an unstaged file (precheck reads from disk; it doesn't need a commit).

Sketch:

```ts
let projectDir: string;
beforeAll(() => {
  projectDir = setupTestProject(/* shared */);
  Bun.write(/* shared prd */);
  Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
  Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });
});
```

Each test still creates its own dir under `TEMP_DIR` (where the *assertion* is
on its output), but the git init moves out. Wall-clock per test drops from
~580ms to ~200ms — saving ~2.5s across the seven tests.

### 3.4 Share MCP stdio server across tests (P1, ~0.4s saving)

**File:** `test/integration/mcp/stdio-server.test.ts`

The 193ms / 186ms / 108ms tests each spin up a stdio MCP server via
`Bun.spawn(["nax", "mcp"])` (or equivalent). A `beforeAll` that spawns one
server and lets each test send a `tools/call` against the existing process
keeps the assertion surface identical.

### 3.5 Tighten the atomic-rename reader loop (P2, ~0.8s saving)

**File:** `test/unit/utils/json-file.test.ts:28`

The test loops up to 5000 reads while a writer process re-rewrites the file.
On a fast loop, 1ms/iter → ~5s max; in practice it bounds at ~1.7s. Two
changes:

1. Cap reads at `500` instead of `5000` and require at least one torn-state
   reading of `null` to validate the assertion still exercises the loop body.
   Wait — the *whole point* is that `nullReads === 0`. So the bound is just
   there to give the writer time. `500` × ~0.3ms = 150ms is plenty; the writer
   cycles in ~3ms, so ~150 reads is enough to see every intermediate state.
2. Or: replace the writer fixture with a faster `Bun.write` of a fixed
   payload (no fsync dance), shrinking the per-iteration cost.

Cheapest fix is #1 alone.

### 3.6 Other intrinsic waits (P3, modest saving, needs design call)

These cannot be sped up without changing the production constant:

| Test | Wait | Production constant | To halve |
|------|-----:|---------------------|----------|
| `agents/native/ambient-probe.test.ts:77` | 2003ms | `AMBIENT_PROBE_TIMEOUT_MS = 2_000` (`src/agents/native/auth.ts:270`) | Lower to 500ms — needs product sign-off |
| `agents/fail-stale-watchdog.test.ts` × 4 | 252ms each | watchdog secondary cap | Tune cap |
| `worktree/dependencies.test.ts:83` | 1004ms | test fixture timeout | Reduce |
| `mcp/stdio-server.test.ts` hanging-call | 596ms | `timeoutMs` value in test | Tighten |

Each of these saves <300ms and changes user-visible behaviour. Defer.

## 4. Bigger wins (suite-level, not per-test)

These do not fit under "fix a slow test" but are the right place to look if
the goal is "GitHub Actions time is increasing" rather than "find the slowest
test".

### 4.1 Add `--parallel` to CI

`.github/workflows/ci.yml:75–82` runs three separate `bun test` steps
sequentially with no parallelism. Each test file evaluates `bunfig.toml`'s
preload (`test/preload.ts`) and reimports `src/`. With ~1,400 unit files
and ~120 integration files, `--parallel` (default = one worker per core)
would put the whole suite on every core.

Caveat: bun's docs warn that `--parallel` defaults to `--isolate` (each file
in a fresh global). That is the **safe** default but does defeat the
`--parallel --no-isolate` optimisation where a worker keeps module state
across files. nax's test suite is preload-heavy (`test/preload.ts`) so
isolate should be safe.

Expected impact: `unit` 45.74s → ~15–20s on a 4-core runner, possibly better
with cache warm.

### 4.2 Shard via `--timings`

`bun test --timings=.bun-test-timings.json --update-timings` records per-file
durations; subsequent runs use the cache to balance shards longest-task-first.
This pairs with `bun test --shard=N/M` for splitting a single suite across
multiple CI jobs (each job reads the same timings file, writes its own
`.next/N.json`).

Caveat: requires CI matrix wiring (`strategy.matrix.shard: [1,2,3,4]`) and a
cache step between jobs. The bun docs sketch the workflow at
<https://bun.com/docs/test#large-codebases>.

### 4.3 Merge the three test steps into one `bun test test/`

The wrapper `scripts/run-tests.ts` deliberately splits into unit/integration/ui
phases so each has a separate wall-clock cap (per its file-level comment
recovering from Bun SIGABRTs). It also gives a per-phase exit code. This is
load-bearing for the wrapper's "Bun panic? Reap the group" behaviour, so
collapsing it is a behavioural change, not just a CI tweak.

If the goal is faster CI rather than faster local, the right move is **keep
the wrapper, but add `--parallel` to each phase**, which doesn't change the
Bun-panic recovery story.

### 4.4 Raise `--timeout` to 30000 from the wrapper's 5000

`scripts/run-tests.ts:49–51` caps every phase at 5s per test. Several slow
tests are exactly 5s (e.g. `forge/deps.test.ts:35`). If `--timeout` was 30s,
the suite would fail loudly instead of being killed and reaped, exposing
*which* tests need fixing. Right now the wrapper's silent SIGKILL makes the
slow-test diagnosis harder than it needs to be.

(Not a perf fix. A diagnostic improvement.)

## 5. Verification

Once any of §3.1–§3.5 is applied, re-run:

```bash
bun test test/unit/forge/deps.test.ts --reporter=junit --reporter-outfile=/tmp/opencode/forge.xml
bun test test/unit/ --reporter=junit --reporter-outfile=/tmp/opencode/unit.xml
bun test test/integration/ --reporter=junit --reporter-outfile=/tmp/opencode/integration.xml
bun test test/ui/ --reporter=junit --reporter-outfile=/tmp/opencode/ui.xml
bun run scripts/slow-tests.ts /tmp/opencode/unit.xml --top=20 --min=200
```

Compare top-20 lists before/after; aim for ≥50% reduction in the relevant
cluster.

## 6. References

- `src/utils/process-kill.ts:28` — `killProcessGroup` source
- `src/verification/executor.ts:99` — canonical `executeWithTimeout` with
  SIGTERM→grace→SIGKILL and Bun-pipe-deadline workaround
- `src/utils/argv-exec.ts:57` — `runArgv`, the dep-injectable runner form
- `src/quality/runner.ts:99` — `runQualityCommand`, the shell-based form
- `src/execution/timeout-handler.ts:40` — `withProcessTimeout` helper
- `test/helpers/fake-clock.ts:77` — `makeFakeClock` (and the heap-driven
  `advance` at line 110)
- `bun.com/docs/test` — `--parallel`, `--shard`, `--timings`, `--isolate`
- bun#5480 — original `useFakeTimers` tracking issue; closed 2026-05-20
- bun#16142 — `vi.useFakeTimers` parity; closed 2026-08-07
