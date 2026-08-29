# SPEC: Review Remediation Sweep 2

## Summary

Close the nine small findings left open after the 2026-08-29 deep code review's first two
tranches shipped (PR #1766, PR #1767). Every one of them is a place where nax already applies a
discipline — surface the error, resolve at call time, read the default from its SSOT, prefer a
Bun-native call over a shell-out — and one site skipped it. Each is individually small; they are
swept together because story count, not finding count, drives run cost.

Findings covered: **MEM-20, BUG-34, BUG-21, MEM-22, ENH-24, BUG-41, BUG-25, ENH-27, BUG-47**.
All nine were re-verified as still present on `main` at `10d95e332` while this spec was written.

## Motivation

The review's `## Deferred` table set these aside to hold the first sweep at six stories, not
because they were doubtful — all nine carry a `CONFIRMED` verdict against re-read source. Left in
place they cost the same way each time:

- **Failures that read as success.** A `catch { }` or a `return []` that swallows a real git
  failure hands the caller a well-formed empty answer. `worktree/manager.ts` conflates "no such
  worktree" with "could not lock ref"; `verification/smart-runner.ts` turns any git error into
  "nothing changed", and `flake-baseline-diff.ts:50-53` already documents having to preflight
  around that blind spot. `tdd/isolation.ts` discards the exit code, so a failed `numstat` yields
  an empty map that the lite-mode `?? POSITIVE_INFINITY` default reads as *hard* isolation
  violations — a git hiccup reported as a test-writer offence.
- **Waits and probes that cost more than they need to.** `tdd/cleanup.ts` sleeps the full 3 s
  grace period even when the process group died in the first 100 ms; `verification/executor.ts`
  fixed exactly this pattern and says why. `context/test-scanner.ts` spawns a PATH-resolved
  `test -d` per candidate directory while `stat` is already imported at the top of the same file,
  and `cli/init-context.ts` shells out to `mkdir` and `find`, ignoring `mkdir`'s exit code and
  silently emitting an empty "Project Structure" section when `find` fails.
- **State captured at the wrong moment.** `interaction/plugins/telegram.ts` caches
  `getSafeLogger()` in a field initializer, so a plugin constructed before `initLogger()` holds a
  permanently-null logger and every warning it would raise is lost. `webhook.ts:161-166` resolves
  the same logger at call time and documents precisely this hazard.
- **Defaults that are not the default.** `agent.idleWatchdog` has a declared SSOT,
  `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG`, and three separate modules re-default its fields inline.
  Two agree with the SSOT; `runtime/middleware/idle-watchdog.ts` does not — it resolves
  `idleTimeoutSeconds ?? 30` against an SSOT value of **900**, `toolCallOnlyIdleTimeoutSeconds ?? 0`
  against **1800**, and `cancelGraceSeconds ?? 5` against **10**. A config that omits those fields
  gets a 30-second idle timeout where the schema promises fifteen minutes. This divergence is
  wider than BUG-47 as filed and was found while grounding this spec.
- **A process-wide patch with no way back.** `installServePortZeroCompat()` replaces
  `Bun.serve` and `globalThis.fetch` behind a one-way flag. Once the webhook plugin has started a
  server, every `fetch` in the process pays the compat check for the process lifetime, including
  in the test suite, and nothing can undo it.

## Design

Five independent stories, no dependency chain. No two stories touch the same file, so parallel
worktree batches cannot merge-conflict with each other.

### Approach

Each story applies the pattern the codebase already uses at a sibling site, rather than inventing
a new one:

| Concern | Existing pattern followed |
|:---|:---|
| Injectable git for a module with no seam | `_isolationDeps` (`src/tdd/isolation.ts:37-45`), `_gitUtilDeps` (`src/verification/smart-runner.ts:41`) |
| Bounded grace wait with early exit | `src/verification/executor.ts:126-140` |
| Call-time logger resolution | `src/interaction/plugins/webhook.ts:161-166` |
| Reading a config default from its SSOT | `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` (`src/config/schemas-infra.ts:213-229`) |
| Structured warn instead of a silent swallow | `logger.warn("<stage>", message, data)` throughout `src/` |

### Integration

Symbols the sweep only **reads** (verified at the cited lines this pass):

| Symbol | Location | Shape |
|:---|:---|:---|
| `gitWithTimeout` | `src/utils/git.ts` | `(args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>` |
| `getSafeLogger` | `src/logger/logger.ts:433` | `() => Logger \| null` — returns `null` before `initLogger()` |
| `NaxError` | `src/errors.ts` | `new NaxError(message, code, context)` |
| `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` | `src/config/schemas-infra.ts:213` | `{ enabled: true, mode: "warn-then-cancel", idleTimeoutSeconds: 900, toolCallOnlyIdleTimeoutSeconds: 1800, activityKinds: [...], cancelGraceSeconds: 10, maxRetryAttempts: 3 }` |
| `hasLiveGroupMembers` | `src/tdd/cleanup.ts` | `(pgid: number) => Promise<boolean>` |
| `withWarnSpy` | `test/helpers/warn-spy.ts` | `<T>(fn: (spy: Mock<Logger["warn"]>) => Promise<T>) => Promise<T>` — resets and re-inits the logger around `fn` |
| `stat` | `node:fs/promises`, already imported at `src/context/test-scanner.ts:9` | `(path) => Promise<Stats>` |

Symbols the sweep **changes**. The baseline below exists only to locate the code — it is never the
interface to implement. Implement the target.

| Symbol | Baseline | Target |
|:---|:---|:---|
| `WorktreeManager.remove` | throws `NaxError(…, "WORKTREE_ERROR")` for both the not-found and the genuine-failure branch | throws `NaxError(…, "WORKTREE_NOT_FOUND")` when git's stderr matches the not-found shapes already listed at `manager.ts:233-238`; `"WORKTREE_ERROR"` otherwise |
| `getAddedLinesPerFile` | `src/tdd/isolation.ts:146` — discards `exitCode`, returns an empty `Map` on failure | rejects with `NaxError(…, "GIT_ERROR")` carrying git's stderr when the numstat exits non-zero |
| `cleanupProcessTree` | `src/tdd/cleanup.ts:121` — one unconditional `sleep(gracePeriodMs)` | polls `hasLiveGroupMembers(pgid)` at `CLEANUP_GRACE_POLL_INTERVAL_MS`, at most `ceil(gracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS)` times, returning as soon as the group is empty |
| `installServePortZeroCompat` | `src/interaction/plugins/webhook-serve-compat.ts:94` — returns `void`, patches behind a one-way flag | returns `() => void`, a restore that reinstates the captured `Bun.serve` / `globalThis.fetch` and clears the flag; a re-entrant call returns a no-op restore |
| `SpawnAcpClient.timeoutSeconds` | `src/agents/acp/spawn-client.ts:51` — `private readonly`, assigned `timeoutSeconds \|\| 1800` | `readonly` (still not writable), assigned `timeoutSeconds ?? DEFAULT_ACP_TIMEOUT_SECONDS` so an explicit `0` survives |

New exported symbols this sweep introduces:

| Symbol | Module | Purpose |
|:---|:---|:---|
| `_worktreeManagerDeps` | `src/worktree/manager.ts` | `{ gitWithTimeout }` — `@internal` test seam; the module has none today |
| `_testScannerDeps` | `src/context/test-scanner.ts` | `{ stat }` — `@internal` test seam |
| `CLEANUP_GRACE_POLL_INTERVAL_MS` | `src/tdd/cleanup.ts` | poll interval constant, well under the 3000 ms default grace |
| `DEFAULT_ACP_TIMEOUT_SECONDS` | `src/agents/acp/spawn-client.ts` | replaces the inline `1800` literal |
| `resolveIdleWatchdogSettings` | `src/runtime/middleware/idle-watchdog.ts` | `(config) => { idleTimeoutMs, toolCallOnlyTimeoutMs, graceMs, maxRetryAttempts, activityKinds }`, every absent field folded from `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG`. The parameter must be typed structurally (an optional `agent.idleWatchdog` block), not as `NaxConfig`: `attachAgentIdleWatchdog` passes a `NaxConfig` but `trySameAgentRetry` holds only the `AgentManagerConfig` selector slice (`src/config/selectors.ts:159`), and both must compile against it |

`gitWithTimeout` is additionally added to the existing `_gitUtilDeps` object in
`src/verification/smart-runner.ts:41`; that object is already exported, so this adds no new symbol.

### Failure Handling

| Condition | Disposition |
|:---|:---|
| `git worktree remove` reports the worktree does not exist | `remove()` throws `WORKTREE_NOT_FOUND`; `create()` swallows it silently, as today — it is the expected clean-slate case |
| `git worktree remove` fails for any other reason | `remove()` throws `WORKTREE_ERROR`; `create()` still continues to the `worktree add` step (which surfaces the real error) but first logs `logger.warn("worktree", …)` carrying the story id and git's stderr |
| `git diff --name-only` exits non-zero, or the spawn throws, in `smart-runner` | fail-open to `[]` as today, but log `logger.warn("verification", …)` carrying the ref and the stderr or error message first |
| `git diff --numstat` exits non-zero in `isolation` | `getAddedLinesPerFile` rejects with `GIT_ERROR`; the lite-mode caller catches, logs `logger.warn("tdd-isolation", …)`, and completes with the strict-mode disposition rather than rejecting the whole check |
| The process group is already gone when the grace poll starts | return without sending `SIGKILL`, as today — the poll only shortens the wait |
| `mkdir` fails in `init-context` | propagate as a `NaxError` with code `"INIT_ERROR"` instead of ignoring the exit code |
| The project scan cannot list a directory | keep the current fail-open to an empty file tree; this sweep changes only which API does the listing |
| `stat` rejects for a candidate test directory | treat as "not a directory", as `test -d`'s non-zero exit does today |
| `installServePortZeroCompat` is called when already installed | return a no-op restore, so a second caller cannot uninstall a patch it did not install |

## Out of Scope

- ENH-45 — whether `resolvePermissions` should keep failing **open** to `approve-all` when
  `permissionProfile` is unset, and whether its sibling `default:` arm should keep failing closed
  to `approve-reads`, is a permission-contract decision reserved for a human ruling. Neither
  disposition changes in this sweep, and no logging is added to either arm.
- SEC-12 — threading resolved permissions into `closePhysicalSession`, or exporting a named
  close-path constant from `permissions.ts`, is architecture rather than remediation and is
  deferred with ENH-45.
- BUG-15 — the stale `MODEL_PRICING` rows are not corrected here; the correct rates are facts
  about the outside world that no test in this repository can establish.
- TYPE-17, TYPE-38 and BUG-36 — type-annotation and cosmetic corrections with no observable
  runtime behaviour. None can be expressed as a runtime acceptance criterion.
- BUG-37 — the uncaughtException/unhandledRejection hard exit deadline is not added; exercising it
  requires driving real process teardown from inside the suite that would host the test.
- PERF-19 and PERF-31 — performance work whose only honest acceptance criterion is a timing
  threshold. Note that `cleanupProcessTree`'s poll is *not* in this class: it is asserted by
  counting injected `sleep` calls, never by wall-clock timing.
- STYLE-42, STYLE-43 and STYLE-44 — the `QueueManager` deletion, the `routeTask`/`keywordRoute`
  consolidation, and the 16 grandfathered oversized files. Each needs a human decision about blast
  radius, and the file-size ratchet is a standing baseline rather than a discrete fix.
- The disposition of an unavailable `git diff --numstat` in lite isolation mode is unchanged: the
  affected source files remain **hard** violations. This sweep makes that outcome loud, not
  different. Choosing a softer disposition needs data on how often numstat actually fails.
- No import-cycle, `check:nax-error` or `check:file-sizes` baseline is lowered by this sweep; the
  existing baselines stand.
- The project scan's fail-open when a directory cannot be listed is preserved, not pinned: it
  still yields an empty file tree rather than raising. Only the API doing the listing changes, and
  no criterion here asserts that disposition.

## Stories

Five stories, no dependency chain — each may run in any order or in parallel.

### US-001 — Surface swallowed git failures in worktree setup and change detection

Covers MEM-20 and BUG-34.

- Introduce `_worktreeManagerDeps = { gitWithTimeout }` in `src/worktree/manager.ts` and route
  **all seven** `gitWithTimeout` calls in that file through it — lines 85, 131, 152, 160, 229, 264
  and 286. Leaving any of them direct breaks this story's own criteria, which stub the seam and
  drive `create()` and `remove()` end to end.
- Give `WorktreeManager.remove` a distinct `WORKTREE_NOT_FOUND` code for the not-found stderr
  shapes it already enumerates, keeping `WORKTREE_ERROR` for genuine failures.
- Make `create()`'s Step-2 catch discriminate: silent for `WORKTREE_NOT_FOUND`, a structured
  `logger.warn("worktree", …)` for anything else. It still proceeds to `worktree add`.
- Add `gitWithTimeout` to the existing `_gitUtilDeps` in `src/verification/smart-runner.ts` and
  route both `getChangedNonTestFiles` and `getChangedTestFiles` through it.
- Log a `logger.warn("verification", …)` in both functions before every `return []` that is caused
  by a non-zero git exit or a thrown spawn, carrying the ref and the stderr or error message.

**Context Files**
- `src/utils/git.ts`
- `test/helpers/warn-spy.ts`
- `test/helpers/spawn.ts`
- `src/errors.ts`

**Creates**
- `test/unit/worktree/manager.test.ts`
- `test/unit/verification/smart-runner-git-failures.test.ts`

### US-002 — Honour git exit codes and stop over-waiting in the TDD subsystem

Covers BUG-21 and MEM-22.

- `getAddedLinesPerFile` rejects with `NaxError(…, "GIT_ERROR")` when `git diff --numstat` exits
  non-zero, instead of discarding the exit code and returning an empty `Map`.
- `verifyTestWriterIsolation` in lite mode catches that rejection, logs
  `logger.warn("tdd-isolation", …)`, and completes with the strict-mode disposition — the check
  never rejects because numstat failed.
- Replace `cleanupProcessTree`'s single `sleep(gracePeriodMs)` with a bounded poll over
  `hasLiveGroupMembers(pgid)`, exported interval `CLEANUP_GRACE_POLL_INTERVAL_MS`, capped at
  `ceil(gracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS)` iterations so it terminates under an
  injected instant `sleep`.
- The SIGTERM-then-SIGKILL contract is unchanged: `SIGKILL` is still sent, and only sent, when the
  group is still populated at the end of the grace window.

**Context Files**
- `src/verification/executor.ts`
- `test/helpers/warn-spy.ts`
- `test/helpers/spawn.ts`

**Creates**
- `test/unit/tdd/cleanup-grace-poll.test.ts`

### US-003 — Replace filesystem shell-outs with Bun-native calls

Covers ENH-24 and BUG-41.

- `src/cli/init-context.ts`: replace the `mkdir -p` spawn with an in-process recursive create
  (`mkdir(path, { recursive: true })` from `node:fs/promises` is what the rest of `src/` uses),
  and surface a failure as a `NaxError` with code `"INIT_ERROR"` instead of ignoring the exit code.
- `src/cli/init-context.ts`: replace the `find` spawn in `findFiles` with an in-process directory
  walk — `Bun.Glob` is the natural fit, but the choice is not normative. What is normative is the
  contract it must preserve: repo-relative paths, `node_modules` / `.git` / `dist` excluded, capped
  at `maxFiles`.
- `src/context/test-scanner.ts`: introduce `_testScannerDeps = { stat }` and replace both
  `Bun.spawn(["test", "-d", …])` probes with it. `stat` is already imported in that file.
- A path that exists but is not a directory must still be treated as "no test directory", exactly
  as `test -d`'s non-zero exit does today.

**Context Files**
- `src/test-runners/conventions.ts`
- `test/helpers/temp.ts`
- `src/errors.ts`

**Creates**
- `test/unit/context/test-scanner-dir-probe.test.ts`

### US-004 — Resolve at call time and make the global patch reversible

Covers BUG-25 and ENH-27.

- `src/interaction/plugins/telegram.ts`: drop the `private readonly logger = getSafeLogger()`
  field initializer and resolve `getSafeLogger()` at each of its eight call sites, mirroring
  `webhook.ts:161-166` and its written rationale.
- `src/interaction/plugins/webhook-serve-compat.ts`: `installServePortZeroCompat()` returns a
  restore function that reinstates the captured `Bun.serve` and `globalThis.fetch` and clears
  `servePortZeroCompatInstalled`.
- A re-entrant `installServePortZeroCompat()` returns a no-op restore, so the second caller cannot
  uninstall the first caller's patch.
- `src/interaction/plugins/webhook.ts`: `startServer()` stores the returned restore and
  `stopServer()` invokes it, so the patch lives exactly as long as the server does.

**Context Files**
- `src/interaction/plugins/webhook.ts`
- `src/interaction/plugins/telegram-config.ts`
- `test/helpers/warn-spy.ts`

**Modifies**
- **US-004** `test/unit/interaction/plugins/webhook-serve-compat.test.ts` — the
  `"installing is idempotent and only patches globals once"` test calls
  `installServePortZeroCompat()` for its side effect and ignores the return value. The invariant
  that replaces it: the second call still leaves `Bun.serve` and `globalThis.fetch` identical to
  the values the first call installed, **and** the restore it returns is a no-op — invoking that
  second restore must leave the globals patched.

### US-005 — One source of truth for the idle-watchdog defaults

Covers BUG-47, widened by a third divergent site found while grounding this spec.

- Add `resolveIdleWatchdogSettings(config)` to `src/runtime/middleware/idle-watchdog.ts`, folding
  every absent field from `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` and converting the seconds-valued
  fields to milliseconds.
- `attachAgentIdleWatchdog` reads its five settings from that resolver instead of the five inline
  `??` defaults at `idle-watchdog.ts:209-216`, three of which contradict the SSOT: `30` against
  `900`, `0` against `1800`, and `5` against `10`.
- `src/agents/manager.ts:462` and `src/agents/retry/hop-retry-policy.ts:85` read
  `maxRetryAttempts` from the resolver instead of re-defaulting `?? 3` inline.
- `src/agents/acp/spawn-client.ts:92`: replace `timeoutSeconds || 1800` with
  `timeoutSeconds ?? DEFAULT_ACP_TIMEOUT_SECONDS` so an explicit `0` is not silently promoted to
  1800, and widen the field from `private readonly` to `readonly` so the resolved value is
  observable without spawning a session.

**Verification note:** the `private readonly` → `readonly` widening on
`SpawnAcpClient.timeoutSeconds` is additionally covered by the build/static gate —
`bun run typecheck` rejects the AC-8 test if the field stays private.

**Context Files**
- `src/config/schemas-infra.ts`
- `test/helpers/mock-nax-config.ts`
- `test/unit/runtime/middleware/_idle-watchdog-harness.ts`

**Creates**
- `test/unit/runtime/middleware/idle-watchdog-defaults.test.ts`

### Seams

- **`_worktreeManagerDeps` and `_testScannerDeps` are the explicit exception to the two-anchor
  rule.** Both are new exported symbols with no production consumer — they are the project's
  established `@internal` test-seam pattern (`_isolationDeps`, `_gitUtilDeps`, `_cleanupDeps`,
  `_smartRunnerDeps`), exported solely so a sibling test file can stub them. Their anchor is that
  every AC in their story stubs them and observes the production path change behaviour
  accordingly; a spawn-based implementation ignores the stub and fails those ACs.
- **`resolveIdleWatchdogSettings` has three production consumers**, and its seam is verified
  behaviourally rather than by stubbing: `mock.module()` is banned by
  `.nax/rules/forbidden-patterns-source.md`, and the three consumers import the resolver directly
  rather than through a dep object. US-005 AC-6 and AC-7 therefore drive `trySameAgentRetry` with
  `agent.idleWatchdog` entirely absent and assert the cap resolves to the SSOT's `3` — an
  assertion no inline re-default can satisfy differently, but which does prove the consumer
  reaches the same number the resolver returns.
- **`installServePortZeroCompat`'s new return value has one production consumer**, the webhook
  plugin. `destroy()` (`webhook.ts:233`) reaches the private `stopServer()` only when `this.server`
  is set (the guard at 239), so US-004 AC-6 first starts the server through the public
  `receive()`, which calls `startServer()` at `webhook.ts:311`, and only then asserts that
  `destroy()` has put `globalThis.fetch` back.
- **`CLEANUP_GRACE_POLL_INTERVAL_MS` and `DEFAULT_ACP_TIMEOUT_SECONDS` are constants**, each
  consumed only inside its declaring module and asserted directly by its story's ACs.

## Acceptance Criteria

### US-001

1. `[unit]` With `_worktreeManagerDeps.gitWithTimeout` stubbed to resolve
   `{ exitCode: 1, stdout: "", stderr: "fatal: 'x' is not a working tree" }`, calling
   `WorktreeManager.remove(projectRoot, "US-001")` rejects with a `NaxError` whose `code` is
   `"WORKTREE_NOT_FOUND"`.
2. `[unit]` With the same dep stubbed to resolve
   `{ exitCode: 1, stdout: "", stderr: "fatal: could not lock ref" }`, calling
   `WorktreeManager.remove(projectRoot, "US-001")` rejects with a `NaxError` whose `code` is
   `"WORKTREE_ERROR"` and whose message contains `could not lock ref`.
3. `[unit]` With `_worktreeManagerDeps.gitWithTimeout` stubbed so that `worktree prune` and
   `worktree add` exit 0 while `worktree remove` exits 1 with stderr `fatal: could not lock ref`,
   calling `WorktreeManager.create(projectRoot, "US-001")` resolves, and under `withWarnSpy` a
   `logger.warn` call is recorded whose first argument is `"worktree"` and whose data carries both
   the story id `"US-001"` and the text `could not lock ref`.
4. `[unit]` With the same stub except that `worktree remove`'s stderr is
   `fatal: 'x' is not a working tree`, calling `WorktreeManager.create(projectRoot, "US-001")`
   resolves and, under `withWarnSpy`, no `logger.warn` call whose first argument is `"worktree"`
   is recorded.
5. `[unit]` With `_gitUtilDeps.gitWithTimeout` stubbed to resolve
   `{ exitCode: 128, stdout: "", stderr: "fatal: bad revision 'HEAD~1'" }`,
   `getChangedNonTestFiles` resolves to an empty array and, under `withWarnSpy`, records a
   `logger.warn` whose first argument is `"verification"` and whose data carries the text
   `bad revision`.
6. `[unit]` With the same stub, `getChangedTestFiles` resolves to an empty array and, under
   `withWarnSpy`, records a `logger.warn` whose first argument is `"verification"`.
7. `[unit]` With `_gitUtilDeps.gitWithTimeout` stubbed to reject with an error whose message is
   `spawn EACCES`, `getChangedNonTestFiles` resolves to an empty array and, under `withWarnSpy`,
   records a `logger.warn` whose first argument is `"verification"` and whose data carries the
   text `spawn EACCES`.
8. `[unit]` With `_gitUtilDeps.gitWithTimeout` stubbed to resolve
   `{ exitCode: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }`, `getChangedNonTestFiles`
   resolves to an array containing `src/a.ts` and `src/b.ts`, and under `withWarnSpy` records no
   `logger.warn` whose first argument is `"verification"`.

### US-002

1. `[unit]` With `_isolationDeps.spawn` stubbed so that a `git diff --numstat` invocation exits 1
   with stderr `fatal: bad revision 'HEAD'`, `getAddedLinesPerFile(workdir, "HEAD")` rejects with a
   `NaxError` whose `code` is `"GIT_ERROR"` and whose message contains `bad revision`.
2. `[unit]` With `_isolationDeps.spawn` stubbed so that `git diff --numstat` exits 0 with stdout
   `"3\t0\tsrc/a.ts\n"`, `getAddedLinesPerFile(workdir, "HEAD")` resolves to a map whose entry for
   `src/a.ts` is `3`.
3. `[unit]` With `_isolationDeps.spawn` stubbed so that `--name-only` exits 0 returning
   `src/a.ts` and `--numstat` exits 1, `verifyTestWriterIsolation(workdir, "HEAD", [], [], "lite")`
   resolves (it does not reject) and its `violations` contain `src/a.ts`.
4. `[unit]` Under the stub of the previous criterion and `withWarnSpy`,
   `verifyTestWriterIsolation(workdir, "HEAD", [], [], "lite")` records a `logger.warn` whose
   first argument is `"tdd-isolation"`.
5. `[unit]` Under the same stub and `withWarnSpy`,
   `verifyTestWriterIsolation(workdir, "HEAD", [], [], "strict")` resolves and records no
   `logger.warn` whose first argument is `"tdd-isolation"`, because strict mode never requests the
   numstat.
6. `[unit]` `CLEANUP_GRACE_POLL_INTERVAL_MS` is importable from the `tdd/cleanup` module, is a
   number greater than zero, and is strictly less than `3000`.
7. `[unit]` With `_cleanupDeps.spawn` stubbed so the first `ps` reports pgid `12345` and every
   later `ps` exits 1 (group empty), `_cleanupDeps.killProcessGroupFn` stubbed to record its calls,
   and `_cleanupDeps.sleep` stubbed to resolve immediately while recording its argument, calling
   `cleanupProcessTree(12345, 3000)` records exactly one kill call, with signal `"SIGTERM"`, and
   the recorded sleep arguments sum to no more than `CLEANUP_GRACE_POLL_INTERVAL_MS`.
8. `[unit]` With `_cleanupDeps.spawn` stubbed so every `ps` reports pgid `12345` (group stays
   populated) and the same recording stubs, calling `cleanupProcessTree(12345, 3000)` records
   exactly two kill calls — `"SIGTERM"` then `"SIGKILL"` — and `_cleanupDeps.sleep` is called no
   more than `Math.ceil(3000 / CLEANUP_GRACE_POLL_INTERVAL_MS)` times.

### US-003

1. `[unit]` For a temporary directory containing `nested/deep/a.ts`, `scanProject(root)` resolves
   to a scan whose `fileTree` contains the exact entry `nested/deep/a.ts` — repo-relative, with no
   leading separator and no copy of the root path. The existing suite only asserts a substring
   match (`init-context.test.ts:30`), which a root-prefixed path also satisfies; the exclusion and
   200-entry contracts are already pinned at `init-context.test.ts:34-56` and must keep passing,
   so no criterion here restates them.
2. `[unit]` For a temporary directory in which a regular file (not a directory) already exists at
   `.nax`, `initContext(root)` rejects with a `NaxError` whose `code` is `"INIT_ERROR"`, rather
   than resolving.
3. `[unit]` With `_testScannerDeps.stat` stubbed to reject for every path, `scanTestFiles` for a
   temporary directory that really does contain `test/foo.test.ts` resolves to an empty array.
4. `[unit]` With `_testScannerDeps.stat` stubbed to record each path it receives and otherwise
   delegate to the real implementation, `scanTestFiles` for a temporary directory containing
   `test/foo.test.ts` resolves to a result that includes that file, and the recorded paths include
   the temporary directory's `test` subdirectory.
5. `[unit]` For a temporary directory in which `test` is a regular file rather than a directory,
   `scanTestFiles` resolves to an empty array.

### US-004

1. `[unit]` After resetting the logger, constructing `TelegramInteractionPlugin`, then
   initialising the logger, then awaiting `init({ botToken: "t", chatId: "@channelname" })`, a
   `logger.warn` is recorded whose first argument is `"interaction"` and whose message reports the
   chat id is not numeric.
2. `[unit]` Under the same ordering, awaiting `init({ botToken: "t", chatId: "12345" })` records no
   `logger.warn` whose first argument is `"interaction"` — the numeric chat id is not warned about.
3. `[unit]` `installServePortZeroCompat()` returns a function; invoking that returned function
   restores `globalThis.fetch` to the exact function object it was before the install call.
4. `[unit]` Invoking the function returned by `installServePortZeroCompat()` restores `Bun.serve`
   to the exact function object it was before the install call.
5. `[unit]` When `installServePortZeroCompat()` is called a second time while already installed,
   invoking the restore it returns leaves `globalThis.fetch` equal to the patched function the
   first call installed — the second restore is a no-op.
6. `[integration]` For a `WebhookInteractionPlugin` initialised with a loopback callback URL,
   awaiting `receive("req-1", 1)` — which starts the callback server at `webhook.ts:311` — and then
   awaiting `destroy()` leaves `globalThis.fetch` equal to the exact function object it was before
   `receive` was called.

### US-005

1. `[unit]` `resolveIdleWatchdogSettings` is importable from the `runtime/middleware/idle-watchdog`
   module and, called with a config whose `agent.idleWatchdog` is `{ enabled: true, mode:
   "warn-then-cancel" }` and every timing field absent, returns an `idleTimeoutMs` of `900000`.
2. `[unit]` Under that same call, `resolveIdleWatchdogSettings` returns a
   `toolCallOnlyTimeoutMs` of `1800000`.
3. `[unit]` Under that same call, `resolveIdleWatchdogSettings` returns a `graceMs` of `10000`.
4. `[unit]` Under that same call, `resolveIdleWatchdogSettings` returns a `maxRetryAttempts` of
   `3`.
5. `[unit]` Called with a config whose `agent.idleWatchdog.cancelGraceSeconds` is `0`,
   `resolveIdleWatchdogSettings` returns a `graceMs` of `0` — an explicitly configured zero is not
   replaced by the default.
6. `[unit]` `trySameAgentRetry`, given a config with no `agent.idleWatchdog` block at all, a
   retriable `fail-stale` adapter failure, and `staleRetryAttempts` of `2`, returns a result whose
   `outcome` is `"stale-retry"`.
7. `[unit]` `trySameAgentRetry`, given the same config and failure but `staleRetryAttempts` of
   `3`, returns `null` — the cap resolved from the shared default is three, and no other retry arm
   in that function matches a `fail-stale` outcome.
8. `[unit]` Constructing a `SpawnAcpClient` with a `timeoutSeconds` argument of `0` yields an
   instance whose `timeoutSeconds` is `0`, and constructing one with `timeoutSeconds` omitted
   yields an instance whose `timeoutSeconds` equals `DEFAULT_ACP_TIMEOUT_SECONDS`.

<!-- spec-writing: completed-through-phase-6 -->
