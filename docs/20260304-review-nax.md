# Deep Code Review: @nathapp/nax

**Date:** 2026-03-04
**Reviewer:** Subrina (AI)
**Version:** 0.18.5
**Files:** 219 source (lib: ~32K LOC), 135 test (~50K LOC)
**Baseline:** 2069 tests pass, 12 skip, 0 fail

---

## Overall Grade: C+ (72/100)

nax is an ambitious orchestrator with a capable plugin system, well-structured pipeline architecture, and solid test suite (2069 tests, 0 failures). However, the codebase has accumulated significant technical debt: pervasive use of forbidden Node.js APIs (readFileSync, setTimeout, console.log), multiple mutation-of-caller-data bugs, race conditions in the parallel executor, and two unvalidated dynamic import paths that allow arbitrary code execution. The project's own conventions (.claude/rules/) are clear and well-documented, but compliance is inconsistent -- roughly 40% of source files violate at least one convention. The architecture (Runner -> Pipeline -> Stages) is sound, but execution modules have grown complex with duplicated logic and files exceeding the 400-line limit.

| Dimension | Score | Notes |
|:---|:---|:---|
| **Security** | 12/20 | Two unvalidated dynamic imports (SEC-1, SEC-2), shell injection vectors (SEC-3, SEC-4), --dangerously-skip-permissions hardcoded (SEC-5) |
| **Reliability** | 13/20 | Race condition in parallel executor (BUG-1), infinite PTY respawn (BUG-2), story duration miscalculation (BUG-3), unguarded array access (BUG-4), pipe buffer deadlock (MEM-1) |
| **API Design** | 16/20 | Clean plugin interfaces, well-typed pipeline stages. Duplicate RoutingDecision interface (TYPE-1), missing strategy in validator (BUG-12) |
| **Code Quality** | 15/20 | Good test coverage, clear architecture docs. 3 files over 400 lines, dead RunLifecycle class (312 LOC), tryLlmBatchRoute duplicated 3x |
| **Best Practices** | 16/20 | Strong .claude/rules, good test structure. ~30 forbidden-pattern violations (Node.js APIs, console.log, setTimeout, emojis) |

---

## Findings

### CRITICAL

#### SEC-1: Unvalidated dynamic import in plugin loader
**Severity:** CRITICAL | **Category:** Security
**File:** `src/plugins/loader.ts:237`
```typescript
const imported = await import(modulePath);
```
`modulePath` comes from user config (`config.plugins[].module`) and is passed to `import()` with no path validation, allowlisting, or sandboxing. An attacker who can modify the project config can execute arbitrary code.
**Risk:** Remote code execution via malicious plugin config entry.
**Fix:** Validate `modulePath` against an allowlist of directories (global plugins dir, project plugins dir). Reject absolute paths outside these roots and any path containing `..`.

#### SEC-2: Unvalidated dynamic import in routing loader
**Severity:** CRITICAL | **Category:** Security
**File:** `src/routing/loader.ts:27-51`
```typescript
const module = await import(absolutePath);
```
`loadCustomStrategy` imports an arbitrary user-provided path with no validation. Same class of vulnerability as SEC-1.
**Risk:** Remote code execution via malicious routing strategy config.
**Fix:** Restrict to project-local paths, validate no path traversal.

#### BUG-1: Race condition in parallel executor concurrency control
**Severity:** CRITICAL | **Category:** Bug
**File:** `src/execution/parallel.ts:183-223`
The `executeParallelBatch` function uses a mutable array with `Promise.race` to enforce concurrency limits. When a promise resolves, the slot is freed and refilled -- but between the resolution check and the slot assignment, another resolution can also claim a slot, allowing more concurrent executions than the configured limit.
**Risk:** Exceeds configured concurrency, spawning more agent processes than intended. Can overload the system and cause OOM or rate-limit failures.
**Fix:** Replace with a proper semaphore/mutex pattern or use a tested concurrency limiter (e.g., p-limit).

#### BUG-2: Infinite PTY respawn from object reference dependency
**Severity:** CRITICAL | **Category:** Bug
**File:** `src/tui/hooks/usePty.ts:155`
```typescript
}, [options]); // options is an object — new identity every render
```
The `useEffect` dependency is the `options` object, which gets a new identity on every React render. This causes the effect to re-run every render cycle, killing and respawning the PTY process in an infinite loop.
**Risk:** Infinite process spawn/kill cycle consuming all system resources.
**Fix:** Memoize `options` with `useMemo` in the parent, or destructure individual primitive deps (`options.command`, `options.cwd`, etc.).

---

### HIGH

#### SEC-3: Incomplete shell operator regex in hooks runner
**Severity:** HIGH | **Category:** Security
**File:** `src/hooks/runner.ts:111`
The regex checking for dangerous shell operators omits the backtick character, allowing command substitution via `` `cmd` `` syntax to bypass the safety check.
**Risk:** Command injection through backtick substitution in hook commands.
**Fix:** Add backtick to the shell operator regex pattern.

#### SEC-4: Command injection via story content in auto plugin
**Severity:** HIGH | **Category:** Security
**File:** `src/interaction/plugins/auto.ts`
User story content is interpolated into CLI arguments without escaping. A story containing shell metacharacters can inject commands.
**Risk:** Arbitrary command execution if story content is attacker-controlled.
**Fix:** Use array-form `Bun.spawn()` instead of shell string interpolation. Escape or validate story content before passing as arguments.

#### SEC-5: --dangerously-skip-permissions hardcoded
**Severity:** HIGH | **Category:** Security
**File:** `src/acceptance/generator.ts`, `src/acceptance/fix-generator.ts`
The `--dangerously-skip-permissions` flag is hardcoded in acceptance prompt generators, bypassing the config gate that should control this setting.
**Risk:** Agent processes always run with elevated permissions regardless of user config.
**Fix:** Read from config (`quality.dangerouslySkipPermissions`) and only include the flag when explicitly enabled.

#### BUG-3: Story duration uses run startTime, not story startTime
**Severity:** HIGH | **Category:** Bug
**File:** `src/execution/pipeline-result-handler.ts:101,108,176,194,258`
All story durations are calculated as `Date.now() - startTime` where `startTime` is the run start time, not the individual story's start. Stories after the first report inflated durations that include all prior stories' execution time.
**Risk:** Incorrect metrics reporting. Makes performance analysis unreliable.
**Fix:** Track per-story start times and use those for duration calculation.

#### BUG-4: Unguarded prd.userStories[0] access
**Severity:** HIGH | **Category:** Bug
**File:** `src/execution/lifecycle/acceptance-loop.ts:172`
Accesses `prd.userStories[0]` without checking if the array is empty. If no stories remain, this throws a runtime error crashing the acceptance loop.
**Risk:** Runtime crash on empty story array.
**Fix:** Guard with `if (prd.userStories.length === 0) return`.

#### BUG-5: revertStoriesOnFailure mutates caller's data
**Severity:** HIGH | **Category:** Bug
**File:** `src/execution/post-verify-rectification.ts:154-181`
Uses `splice()` on `opts.allStoryMetrics` and directly mutates `opts.prd` — violating the project's immutability principle. Callers that retain references see unexpectedly modified data.
**Risk:** Corrupted state propagating to subsequent pipeline stages.
**Fix:** Return new arrays/objects instead of mutating. Use spread/filter to create copies.

#### BUG-6: Forbidden Node.js APIs in claude-plan.ts
**Severity:** HIGH | **Category:** Bug
**File:** `src/agents/claude-plan.ts`
Uses `require()`, `readFileSync`, `mkdtempSync`, `rmSync` — all explicitly forbidden by project conventions. These are blocking synchronous calls in an async orchestrator.
**Risk:** Blocks the event loop during plan execution. Inconsistent with Bun-native runtime.
**Fix:** Replace with `Bun.file().text()`, `Bun.write()`, `Bun.spawn()`, and async equivalents.

#### MEM-1: Unread stderr pipe blocks child process
**Severity:** HIGH | **Category:** Memory
**File:** `src/tui/hooks/usePty.ts:99`
```typescript
stderr: "pipe",
```
stderr is set to `"pipe"` but never consumed. When the pipe buffer fills (~64KB), the child process blocks on stderr writes, hanging indefinitely.
**Risk:** Agent processes hang silently when producing stderr output.
**Fix:** Either consume stderr (stream it alongside stdout) or use `stderr: "inherit"` to forward to parent.

#### MEM-2: Unbounded pendingResponses Map in webhook plugin
**Severity:** HIGH | **Category:** Memory
**File:** `src/interaction/plugins/webhook.ts`
The `pendingResponses` Map grows without bound. If webhooks fail to respond, entries accumulate forever.
**Risk:** Memory leak proportional to number of unanswered interactions.
**Fix:** Add TTL-based eviction or max-size cap with LRU eviction.

---

### MEDIUM

#### BUG-7: readFileSync throughout context/injector.ts
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/context/injector.ts:76,103,130,142,177,206`
Six uses of `readFileSync` — forbidden Node.js API that blocks the event loop.
**Fix:** Replace with `await Bun.file(path).text()`.

#### BUG-8: setTimeout throughout codebase
**Severity:** MEDIUM | **Category:** Bug
**Files:** `src/verification/executor.ts:21,92,118`, `src/agents/claude.ts:184`, `src/routing/strategies/llm.ts:78-84`, `src/hooks/runner.ts:215`
Multiple uses of `setTimeout` instead of `Bun.sleep()` — forbidden pattern.
**Fix:** Replace with `await Bun.sleep(ms)` where applicable.

#### BUG-9: appendFileSync in logger and crash-recovery
**Severity:** MEDIUM | **Category:** Bug
**Files:** `src/logger/logger.ts:154`, `src/execution/crash-recovery.ts:67-68,110-111,282-283,346-347`
Blocking synchronous file writes in hot paths. Logger calls `appendFileSync` on every log line.
**Fix:** Use `Bun.write()` with append mode, or buffer writes.

#### BUG-10: Unsafe raceResult cast in executor
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/verification/executor.ts:150`
```typescript
const exitCode = raceResult as number;
```
If `processPromise` resolves with `undefined` (Bun behavior on signal kill), this cast silently produces `NaN` comparisons.
**Fix:** Add explicit null/undefined check: `const exitCode = typeof raceResult === "number" ? raceResult : 1`.

#### BUG-11: test -d shell spawning in test-scanner
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/context/test-scanner.ts:171-181`
Spawns a shell process (`test -d`) to check if a directory exists. Unnecessary and slow.
**Fix:** Use `Bun.file(path).exists()` or `fs.stat()`.

#### BUG-12: validateRoutingDecision excludes three-session-tdd-lite
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/routing/strategies/llm-prompts.ts:110-116`
The routing decision validator does not include `"three-session-tdd-lite"` in the valid strategy set, causing this valid strategy to be silently rejected.
**Fix:** Add `"three-session-tdd-lite"` to the valid strategies array.

#### BUG-13: Byte-offset/character-index mismatch in followLogs
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/commands/logs.ts:320-323`
Uses byte offset from `Bun.file().size` but character index for string slicing. Multi-byte UTF-8 content (e.g., emojis, CJK) causes garbled output or missed lines.
**Fix:** Track byte offsets consistently, or read raw buffers and convert.

#### BUG-14: auto interaction plugin receive() always throws
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/interaction/plugins/auto.ts:66-71`
The `receive()` method unconditionally throws, making the auto plugin non-functional through the interaction chain for any inbound messages.
**Fix:** Implement proper receive handling or document the throw as intentional with `@design`.

#### BUG-15: savePRD mutates caller's object
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/prd/index.ts:62`
`savePRD` sets `prd.updatedAt` directly, mutating the caller's reference.
**Fix:** Create a copy before modification: `const updated = { ...prd, updatedAt: new Date().toISOString() }`.

#### BUG-16: checkPRDValid mutates story objects
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/precheck/checks-blockers.ts:136-140`
Mutates story objects in-place while a comment says "don't modify the PRD". Also has a triple null check copy-paste bug (`|| testCommand === null || testCommand === null`).
**Fix:** Use non-mutating approach. Fix duplicate null check.

#### BUG-17: usePipelineEvents startTime causes event listener churn
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/tui/hooks/usePipelineEvents.ts:71,180`
`startTime = Date.now()` is computed every render and included in `useEffect` deps, causing the effect to re-run and re-register event listeners on every render.
**Fix:** Use `useRef` for startTime or compute it once with `useState(() => Date.now())`.

#### BUG-18: dispatcher results in completion order, not input order
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/worktree/dispatcher.ts`
`pLimit` returns results in completion order. If callers expect input-order results, story assignments may be mismatched.
**Fix:** Map results back to input indices, or document completion-order semantics.

#### BUG-19: getTotalStories getter captures prd before declaration
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/execution/runner.ts:141,152`
The `getTotalStories` getter closure captures `prd` at line 141, but `prd` is declared at line 152. Due to `let` temporal dead zone rules, accessing the getter before line 152 throws.
**Fix:** Move the getter definition after `prd` declaration, or restructure.

#### BUG-20: Bun.file() on directory path unreliable
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/interaction/state.ts:148`
`Bun.file()` is called on a directory path. Behavior is undefined/unreliable for directories.
**Fix:** Use `readdir` or check `isDirectory()` first.

#### TYPE-1: Duplicate RoutingDecision interface
**Severity:** MEDIUM | **Category:** Type Safety
**File:** `src/routing/` (multiple files)
`RoutingDecision` is defined in two places with subtly different shapes, causing type confusion.
**Fix:** Consolidate into `src/routing/types.ts` and import from the barrel.

#### PERF-1: existsSync blocking calls
**Severity:** MEDIUM | **Category:** Performance
**Files:** `src/execution/pid-registry.ts:82,163`, `src/pipeline/stages/gate.ts`, `src/routing/path-security.ts`
Synchronous file existence checks block the event loop.
**Fix:** Use async `Bun.file(path).exists()`.

---

### LOW

#### STYLE-1: Files exceeding 400-line limit
**Severity:** LOW | **Category:** Style
**Files:**
- `src/execution/parallel.ts` (401 lines)
- `src/config/types.ts` (443 lines)
- `src/cli/config.ts` (562 lines)
**Fix:** Split by logical concern. `config.ts` is 162 lines over limit.

#### STYLE-2: Dead code — RunLifecycle class (312 LOC)
**Severity:** LOW | **Category:** Style
**File:** `src/execution/lifecycle/run-lifecycle.ts`
The `RunLifecycle` class duplicates logic now handled by other modules. Not referenced by `runner.ts`.
**Fix:** Delete the file after confirming no other references.

#### STYLE-3: tryLlmBatchRoute duplicated in 3 locations
**Severity:** LOW | **Category:** Style
**Files:** `src/execution/runner.ts`, `src/execution/parallel.ts`, `src/execution/sequential-executor.ts`
Same function copy-pasted across three files.
**Fix:** Extract to `src/routing/batch-route.ts` and import from barrel.

#### STYLE-4: console.log/console.error in source files
**Severity:** LOW | **Category:** Style
**Files:** `src/logger/logger.ts:70,116,156`, `src/execution/crash-recovery.ts:70,114,134`, `src/plugins/loader.ts:22`, `src/cli/config.ts` (throughout), `src/precheck/index.ts` (throughout), `src/review/runner.ts`, `src/optimizer/index.ts`, `src/tui/features/status-features.ts`
Forbidden pattern per `.claude/rules/04-forbidden-patterns.md`.
**Fix:** Replace with project logger (`src/logger`).

#### STYLE-5: Emojis in source code
**Severity:** LOW | **Category:** Style
**Files:** `src/logging/types.ts:15-36` (EMOJI constant), `src/tui/components/StoriesPanel.tsx`, `src/interaction/plugins/telegram.ts`, `src/acceptance/generator.ts`
Violates no-emoji convention.
**Fix:** Replace with text markers `[OK]`, `[WARN]`, `[FAIL]`, `->`.

#### STYLE-6: Internal path imports instead of barrels
**Severity:** LOW | **Category:** Style
**Files:** `src/pipeline/stages/verify.ts`, `src/pipeline/stages/routing.ts`, `src/context/test-scanner.ts`, several others
Importing from internal paths (`src/routing/router`) instead of barrels (`src/routing`). Risks singleton fragmentation in Bun's module registry (BUG-035).
**Fix:** Import from barrel `index.ts` files.

#### STYLE-7: .js extension imports
**Severity:** LOW | **Category:** Style
**File:** `src/verification/optimizer.ts`
Uses `.js` file extension in imports, inconsistent with the rest of the codebase which uses extensionless imports.
**Fix:** Remove `.js` extensions.

#### STYLE-8: Mixed Node.js fs APIs in execution/
**Severity:** LOW | **Category:** Style
**Files:** `src/execution/lock.ts` (openSync/writeSync/closeSync), `src/execution/progress.ts` (mkdirSync), `src/execution/queue-handler.ts` (mv/rm subprocess)
Various forbidden Node.js APIs scattered through execution modules.
**Fix:** Replace with Bun-native equivalents.

#### ENH-1: Unbounded testOutput in acceptance prompts
**Severity:** LOW | **Category:** Enhancement
**File:** `src/acceptance/generator.ts`, `src/acceptance/fix-generator.ts`
Full test output is injected into prompts with no truncation. Large test suites produce prompts that exceed model context limits.
**Fix:** Truncate test output to a configurable max (e.g., last 200 lines).

#### ENH-2: costPerMinute returns undefined for non-standard tiers
**Severity:** LOW | **Category:** Enhancement
**File:** `src/routing/strategies/`
The cost calculation function returns `undefined` for tiers not in its lookup table, causing NaN in downstream math.
**Fix:** Default to 0 or throw for unknown tiers.

#### ENH-3: decompose() has no timeout
**Severity:** LOW | **Category:** Enhancement
**File:** `src/agents/claude.ts:241-283`
The `decompose()` method calls the LLM with no timeout. A hung API call blocks the orchestrator indefinitely.
**Fix:** Add configurable timeout wrapping the API call.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | SEC-1 | S | Validate plugin loader import paths against allowlist |
| P0 | SEC-2 | S | Validate routing loader import paths against allowlist |
| P0 | BUG-1 | M | Replace parallel executor concurrency with proper semaphore |
| P0 | BUG-2 | S | Fix usePty useEffect deps — memoize or destructure primitives |
| P1 | SEC-3 | S | Add backtick to shell operator regex |
| P1 | SEC-4 | S | Use array-form Bun.spawn for story content |
| P1 | SEC-5 | S | Read --dangerously-skip-permissions from config, not hardcode |
| P1 | BUG-3 | M | Track per-story start times for duration calculation |
| P1 | BUG-5 | M | Make revertStoriesOnFailure return copies instead of mutating |
| P1 | MEM-1 | S | Consume or inherit stderr in usePty |
| P1 | MEM-2 | S | Add TTL eviction to webhook pendingResponses |
| P2 | BUG-6 | M | Replace Node.js APIs in claude-plan.ts with Bun-native |
| P2 | BUG-7 | M | Replace readFileSync in context/injector.ts |
| P2 | BUG-8 | M | Replace setTimeout with Bun.sleep across codebase |
| P2 | BUG-9 | M | Replace appendFileSync with async Bun.write |
| P2 | BUG-10 | S | Add null check for raceResult cast |
| P2 | BUG-12 | S | Add three-session-tdd-lite to valid strategies |
| P2 | BUG-13 | S | Fix byte-offset/character-index mismatch |
| P2 | BUG-17 | S | Use useRef for startTime in usePipelineEvents |
| P2 | BUG-19 | S | Move getTotalStories after prd declaration |
| P3 | BUG-4 | S | Guard prd.userStories[0] access |
| P3 | BUG-11 | S | Replace test -d spawn with Bun.file().exists() |
| P3 | BUG-14 | S | Fix or document auto plugin receive() throw |
| P3 | BUG-15 | S | Copy PRD before mutating in savePRD |
| P3 | BUG-16 | S | Fix mutation and duplicate null check in checkPRDValid |
| P3 | BUG-18 | S | Document or fix dispatcher result ordering |
| P3 | BUG-20 | S | Fix Bun.file() on directory path |
| P3 | TYPE-1 | S | Consolidate duplicate RoutingDecision interface |
| P3 | PERF-1 | S | Replace existsSync with async equivalents |
| P4 | STYLE-1 | M | Split 3 files exceeding 400-line limit |
| P4 | STYLE-2 | S | Delete dead RunLifecycle class |
| P4 | STYLE-3 | M | Extract tryLlmBatchRoute to shared module |
| P4 | STYLE-4 | M | Replace console.log/error with project logger |
| P4 | STYLE-5 | S | Replace emojis with text markers |
| P4 | STYLE-6 | M | Fix internal path imports to use barrels |
| P4 | STYLE-7 | S | Remove .js extension imports |
| P4 | STYLE-8 | M | Replace Node.js fs APIs in execution/ |
| P5 | ENH-1 | S | Truncate testOutput in acceptance prompts |
| P5 | ENH-2 | S | Default costPerMinute for unknown tiers |
| P5 | ENH-3 | S | Add timeout to decompose() |

---

## Summary Statistics

| Category | Count | CRITICAL | HIGH | MEDIUM | LOW |
|:---|:---|:---|:---|:---|:---|
| Security (SEC) | 5 | 2 | 3 | 0 | 0 |
| Bug (BUG) | 20 | 2 | 2 | 12 | 4 |
| Memory (MEM) | 2 | 0 | 2 | 0 | 0 |
| Type Safety (TYPE) | 1 | 0 | 0 | 1 | 0 |
| Performance (PERF) | 1 | 0 | 0 | 1 | 0 |
| Style (STYLE) | 8 | 0 | 0 | 0 | 8 |
| Enhancement (ENH) | 3 | 0 | 0 | 0 | 3 |
| **Total** | **40** | **4** | **7** | **14** | **15** |

---

## Methodology

- **Review type:** Deep (all source files read systematically)
- **Checklists applied:** universal.md, node-general.md
- **Agents used:** 6 parallel Explore agents covering all `src/` directories
- **Manual passes:** Security (secrets, injection, forbidden patterns), convention compliance
- **Test verification:** Unit (938 pass, 6 skip), Integration (1035 pass, 4 skip), UI (96 pass, 2 skip)

---

## v0.18.5 Addendum — BUN-001 Migration Gaps & _deps Pattern Assessment

*Added: 2026-03-04. Supplements the review above with issues specific to v0.18.5 (node-pty -> Bun.spawn migration) and v0.18.4 (_deps pattern adoption).*

---

### New Findings

#### MEM-3: Unread stderr pipe in runInteractive()
**Severity:** MEDIUM | **Category:** Memory
**File:** `src/agents/claude.ts:298`

Same class as MEM-1 (usePty stderr pipe) but in the `runInteractive()` method. `stderr: "pipe"` is set but never consumed. When the pipe buffer fills (~64 KB), the subprocess blocks on stderr writes, hanging indefinitely.

The code comment notes this method is "TUI-only and currently dormant in headless nax runs", which mitigates immediate risk — but the bug activates when TUI mode is re-enabled.

**Fix:** Consume stderr in a parallel IIFE (mirror the stdout loop) or change to `stderr: "inherit"`.

---

#### BUG-21: Fire-and-forget IIFE in runInteractive() has no error handling
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/agents/claude.ts:305-309`

```typescript
(async () => {
  for await (const chunk of proc.stdout) {
    options.onOutput(Buffer.from(chunk));
  }
})();
```

The detached async IIFE swallows all errors. A stream error or a throw from `options.onOutput()` becomes an unhandled promise rejection — the caller receives no signal and output silently stops.

**Fix:** Append `.catch((err) => getLogger()?.error("agent", "runInteractive stdout error", { err }))` to the IIFE.

---

#### BUG-22: proc.exited.then() missing .catch() in two locations
**Severity:** LOW | **Category:** Bug
**Files:** `src/agents/claude.ts:312`, `src/tui/hooks/usePty.ts:131`

Both call `.then()` on `proc.exited` with no `.catch()`. If `options.onExit()` throws synchronously, or the setState callback in usePty throws (e.g., during unmount), the rejection is unhandled and surfaces as an uncaught promise rejection.

**Fix:** Add `.catch((err) => { /* log */ })` to both `.then()` chains.

---

#### STYLE-9: canSpawnPty = false permanently disables all PTY integration tests
**Severity:** LOW | **Category:** Style
**File:** `test/ui/tui-pty-integration.test.tsx`

```typescript
const canSpawnPty = false; // BUN-001: no PTY — preserved for future re-enablement
```

All PTY lifecycle tests (spawn, write, resize, kill, exit) are permanently skipped via a hardcoded `false`. There is no issue reference, no `test.todo()`, and no environment gate. PTY integration test coverage is zero with no path to re-enabling it.

**Fix:** Replace with `const canSpawnPty = process.env.RUN_PTY_TESTS === "1"` and file a tracking issue for the test gap.

---

#### ENH-5: _deps pattern covers 2 of 50+ modules — adoption plan needed
**Severity:** MEDIUM | **Category:** Enhancement
**Files:** `src/verification/smart-runner.ts`, `src/pipeline/stages/verify.ts`

**Background:** v0.18.4 commit `8d80158` ("refactor: eliminate mock.module() and fix test architecture debt") introduced the `_deps` dependency injection pattern as the correct replacement for `mock.module()` (globally banned in Bun 1.x). The implementation in `smart-runner.ts` and `verify.ts` is clean and correct — originals are captured before each test and restored in `afterEach`.

**Gap:** ~50+ source modules with non-trivial internal dependencies have no `_deps` export. Tests for those modules must choose between: (a) leaving complex code paths untested, (b) relying on slow integration tests that spawn real processes, or (c) using `mock.module()` in violation of the convention (global ESM registry leak).

**Impact:** The convention exists in `.claude/rules/04-forbidden-patterns.md` but cannot be enforced without the infrastructure to comply. Any contributor writing a new unit test for an un-`_deps`-ified module faces this conflict.

**High-priority candidates for _deps rollout:**
- `src/routing/strategies/llm.ts` — LLM retry and fallback logic; currently hard to unit test
- `src/execution/crash-recovery.ts` — crash detection and recovery; complex branching
- `src/plugins/loader.ts` — dynamic import (also SEC-1); needs path validation testable in isolation
- `src/agents/claude.ts` — runOnce/runInteractive; timeout and retry logic

**Fix:** Document adoption steps in `.claude/rules/03-test-writing.md` with a tracking section. Prioritize modules with known test gaps (crash-recovery, routing/llm) in the next minor release.

---

### Updated Priority Matrix (addendum items only)

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | MEM-3 | S | Consume or inherit stderr in runInteractive() |
| P2 | BUG-21 | S | Add .catch() to stdout IIFE in runInteractive() |
| P2 | ENH-5 | L | _deps rollout plan — prioritize crash-recovery, llm strategy, plugin loader |
| P4 | BUG-22 | S | Add .catch() to proc.exited.then() in claude.ts and usePty |
| P4 | STYLE-9 | S | Gate canSpawnPty on env var, file tracking issue |

---

### Updated Summary Statistics

| Category | Count | CRITICAL | HIGH | MEDIUM | LOW |
|:---|:---|:---|:---|:---|:---|
| Security (SEC) | 5 | 2 | 3 | 0 | 0 |
| Bug (BUG) | 22 | 2 | 2 | 13 | 5 |
| Memory (MEM) | 3 | 0 | 2 | 1 | 0 |
| Type Safety (TYPE) | 1 | 0 | 0 | 1 | 0 |
| Performance (PERF) | 1 | 0 | 0 | 1 | 0 |
| Style (STYLE) | 9 | 0 | 0 | 0 | 9 |
| Enhancement (ENH) | 5 | 0 | 0 | 2 | 3 |
| **Total** | **46** | **4** | **7** | **17** | **18** |

**Overall grade unchanged: C+ (72/100).** The BUN-001 migration in v0.18.5 eliminated the node-pty native build dependency (a concrete improvement) but introduced three new error-handling gaps and permanently skipped all PTY integration tests. The _deps pattern from v0.18.4 is a strong foundation — clean where implemented — but requires a structured rollout to the remaining ~50 modules before it meaningfully reduces test architecture risk.
