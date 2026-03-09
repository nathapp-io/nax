# Code Review — nax — 2026-03-09

## Summary

**Overall Health**: Solid architecture, good test coverage (1402 pass, 6 skip, 0 fail), clean security posture. The codebase follows consistent patterns (PromptBuilder, pipeline stages, event bus). Main improvement areas are file size violations and duplicated timeout patterns.

**Revised Issue Counts** (after manual verification):

| Severity | Count | Notes |
|:---------|:------|:------|
| 🔴 Critical | 0 | Original report overcounted — Node.js fs usage is justified (see below) |
| 🟠 High | 6 | File size violations |
| 🟡 Medium | 8 | Timeout consolidation, barrel export, console.error |
| 🟢 Low | 4 | TODOs, compat wrapper |

---

## Corrected Findings: Node.js fs Usage

### ❌ NOT a violation — Node.js sync fs is required

The original automated review flagged 80+ files using `node:fs` as "CRITICAL". **This is incorrect.** Bun's native file API (`Bun.file()`) is **async-only** — there is no `Bun.existsSync()` or `Bun.appendFileSync()`.

Sync fs is **required** in these contexts:

| Context | Why sync is mandatory | Files |
|:--------|:---------------------|:------|
| **Signal handlers** (SIGTERM/SIGINT) | Cannot `await` in signal handlers — process may exit before async completes | `crash-recovery.ts` |
| **Logger writes** | `appendFileSync` guarantees log line is written before process crash | `logger/logger.ts` |
| **Startup path scanning** | Config loader must resolve paths synchronously before async init | `config/loader.ts` |
| **Precheck validation** | Synchronous file existence checks for gating decisions | `precheck/checks-*.ts` |

**Some `existsSync` calls in async paths** (e.g., `context/injector.ts`, `cli/init.ts`) could theoretically use `await Bun.file().exists()`, but the performance difference is negligible and mixing sync/async file checks within the same function adds complexity for no real gain.

**Verdict**: Keep current approach. Node.js `fs` for sync operations is the correct Bun idiom until Bun ships sync file APIs.

### ❌ NOT a violation — Runtime require() calls

The 3 flagged `require()` / dynamic `import()` calls are **intentional**:

| Location | Reason |
|:---------|:-------|
| `src/agents/claude-plan.ts:38-39` | Lazy import — only loads fs when `inputFile` option is provided (rare path) |
| `src/execution/lifecycle/precheck-runner.ts:65` | Sync log append in lifecycle handler — avoids top-level import in hot module |
| `bin/nax.ts:476` | `await import("node:fs")` — standard ESM dynamic import for conditional CLI path |

**Verdict**: No action needed. These are deliberate lazy-loading patterns.

---

## 🟠 High: File Size Violations (6 files)

These are real violations of the 400-line project convention and should be split:

| File | Lines | Recommended Split |
|:-----|:------|:-----------------|
| `src/cli/config.ts` | 602 | Extract field descriptions + formatting to separate modules |
| `src/cli/prompts.ts` | 494 | Extract story filtering helpers + init sequences |
| `src/config/types.ts` | 471 | Acceptable (type-only file), but consider splitting by domain |
| `src/commands/logs.ts` | 454 | Extract JSONL parser + table formatter + follow mode |
| `src/agents/claude.ts` | 434 | Already partially split (claude-decompose.ts, claude-plan.ts, claude-run.ts). Further split runOnce handler |
| `src/execution/crash-recovery.ts` | 411 | Acceptable — domain complexity justifies single file. Monitor only |

**Priority**: `config.ts` (602 lines) → `prompts.ts` (494) → `logs.ts` (454) → `claude.ts` (434)

---

## ✅ Security — All Clear

| Check | Status | Detail |
|:------|:-------|:-------|
| Hardcoded secrets | ✅ Clean | No API keys/tokens/credentials in source |
| Shell injection | ✅ Safe | All `Bun.spawn()` uses array format (not shell strings) |
| Env var leakage | ✅ Secure | `buildAllowedEnv()` properly whitelists (PATH, HOME, TMPDIR, USER, LOGNAME, API keys, CLAUDE_/NAX_/CLAW_/TURBO_ prefixes) |
| Input validation | ✅ Adequate | PRD fields normalized on load (`loadPRD`), config validated via Zod schemas |

---

## 🟡 Medium: Duplicated Timeout Pattern (5 files, 12 occurrences)

The same `Promise.race` + `setTimeout` pattern is copy-pasted across:

- `src/agents/claude.ts` (5×)
- `src/verification/executor.ts` (4×)
- `src/verification/strategies/acceptance.ts` (2×)
- `src/review/runner.ts` (2×)
- `src/routing/strategies/llm.ts` (1×)

**Recommendation**: Extract to `src/utils/timeout.ts`:

```typescript
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback?: T
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timerId = setTimeout(() => {
      if (fallback !== undefined) resolve(fallback);
      else reject(new Error(`Timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
}
```

**Note on setTimeout vs Bun.sleep()**: `setTimeout` is correct for timeout racing — `Bun.sleep()` is uncancellable (documented in MEMORY.md). The consolidation is about DRY, not API choice. The `setInterval` in crash-recovery heartbeat is also correct — `Bun.sleep()` cannot replace interval timers.

---

## 🟡 Medium: Missing Barrel Export

`src/utils/` has 3 files (`git.ts`, `path-security.ts`, `queue-writer.ts`) with no `index.ts`.

**Fix**: Create `src/utils/index.ts` — 10 minute task.

---

## 🟡 Medium: console.error in Production Code (2 locations)

| File | Line | Context |
|:-----|:-----|:--------|
| `src/plugins/loader.ts` | 23, 32 | `_pluginErrorSink` defaults to `console.error` |
| `src/execution/crash-recovery.ts` | 74 | Fallback when logger itself fails |

**Note**: The crash-recovery `console.error` is a **last-resort fallback** when the structured logger is unavailable — this is acceptable. The plugin loader sink could be changed to use the structured logger.

---

## 🟢 Low: Dead Code

| Item | Location | Verdict |
|:-----|:---------|:--------|
| Compat re-export wrapper | `src/execution/test-output-parser.ts` | Remove after confirming no external consumers |
| TODO: dependency-aware batching | `src/worktree/dispatcher.ts:46` | Placeholder — implement when parallel mode matures |
| TODO: TUI retry button | `src/tui/App.tsx:123` | Non-functional button — implement or remove |
| 41× BUG-fix comments | Throughout | **Keep** — these document architectural decisions and past incidents |

---

## Recommendations (Prioritized for v0.33.0)

### Quick Wins (do before story-decompose)

| # | Task | Effort | Impact |
|:--|:-----|:-------|:-------|
| 1 | Create `src/utils/index.ts` barrel | 10 min | Convention compliance |
| 2 | Create `src/utils/timeout.ts` + migrate 12 call sites | 2-3h | DRY, fewer bugs |
| 3 | Remove `src/execution/test-output-parser.ts` compat wrapper | 5 min | Dead code cleanup |

### Sprint Work (during or after story-decompose)

| # | Task | Effort | Impact |
|:--|:-----|:-------|:-------|
| 4 | Split `src/cli/config.ts` (602 → 3 files) | 3-4h | Convention compliance |
| 5 | Split `src/cli/prompts.ts` (494 → 3 files) | 2-3h | Convention compliance |
| 6 | Split `src/commands/logs.ts` (454 → 4 files) | 2-3h | Convention compliance |
| 7 | Further split `src/agents/claude.ts` (434 → extract runOnce) | 2h | Convention compliance |

### Backlog

| # | Task | Effort |
|:--|:-----|:-------|
| 8 | Implement dependency-aware batching in dispatcher | 1-2 days |
| 9 | Fix or remove non-functional TUI retry button | 1h |
| 10 | Audit import patterns for barrel compliance | 2h |

---

## Compliance Checklist (Revised)

- [x] No hardcoded secrets
- [x] No shell injection vectors
- [x] Env var leakage controlled
- [x] Input validation on PRD/config
- [x] TypeScript strict mode
- [x] No commented-out code blocks
- [ ] All files ≤ 400 lines (6 violations)
- [ ] Timeout pattern consolidated (12 duplicates)
- [ ] `src/utils/index.ts` barrel export
- [ ] Compat wrapper removed

---

## Corrections from Original Automated Review

The original Claude Code review (automated, no human verification) contained these errors:

1. **Node.js fs flagged as "CRITICAL"** → Corrected to "Not a violation". Bun has no sync file API; `node:fs` is the correct choice for signal handlers, logger, crash recovery.
2. **`require()` calls flagged as "CRITICAL"** → Corrected to "Intentional". Lazy loading patterns, not bugs.
3. **`setTimeout` flagged for Bun.sleep() replacement** → Corrected. `Bun.sleep()` is uncancellable — `setTimeout` is correct for timeout racing. Issue is duplication, not API choice.
4. **`appendFileSync` in logger/crash-recovery** → Corrected. Sync writes are mandatory for crash safety — async writes risk data loss on process exit.
5. **145 "sync I/O in hot paths"** → Overcounted. Many are in cold paths (startup, CLI commands) not hot loops.

---

**Date**: 2026-03-09
**Initial Reviewer**: Claude Code (automated)
**Corrections**: Nax Dev (manual verification against codebase context)
**Scope**: `src/` and `bin/` directories
**Version**: v0.32.1
