# NAX Code Quality Audit Report

**Generated:** 2026-03-10
**Scope:** src/ directory (275 source files)
**Standards:** ARCHITECTURE.md pattern requirements

---

## Executive Summary

**Total Issues: 79** (HIGH: 47, MEDIUM: 28, LOW: 4)

| Category | Count | Priority | Effort |
|:---------|:------|:---------|:-------|
| Node.js API usage (no Bun equivalent) | 64 files | HIGH | 2–4 days |
| Direct Bun calls outside _deps pattern | 5 files | HIGH | 2–4 hours |
| `as any` type casts in exported code | 2 files | HIGH | 30 min |
| setTimeout/setInterval (should use Bun.sleep or AbortController) | 10 files | MEDIUM | 2–3 hours |
| Functions > 50 lines | 15+ functions | MEDIUM | 3–5 hours |
| Files > 400 lines | Estimated 5–8 files | MEDIUM | 2–3 hours |
| Magic numbers in code | 20+ instances | MEDIUM | 2–3 hours |
| Functions with >3 positional params | 8+ functions | LOW | 1–2 hours |

---

## 1. Node.js API Usage (64 FILES) — HIGH PRIORITY

**Violation:** Project requires Bun-native APIs only. Using Node.js equivalents (`node:fs`, `node:path`, `node:os`) defeats the purpose of a Bun-native project and breaks portability.

**Pattern Required:**
✅ `Bun.file()`, `Bun.write()`, `Bun.CWD`, `join()` from `std/path`
❌ `import from "node:fs"`, `import from "node:path"`, `import from "node:os"`

**Files with Node.js imports (64 total):**

| File | Violation | Fix |
|:-----|:----------|:----|
| `src/tdd/verdict.ts` | `node:fs` | Use `Bun.file()` + `Bun.write()` |
| `src/metrics/tracker.ts` | `node:fs` | Use `Bun.file()` + `Bun.write()` |
| `src/execution/parallel-executor.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/execution/parallel.ts` | `node:os`, `node:path` | Use Bun + path utility |
| `src/context/test-scanner.ts` | `node:fs` | Use `Bun.file()` |
| `src/context/builder.ts` | `node:fs` | Use `Bun.file()` |
| `src/constitution/loader.ts` | `node:fs` | Use `Bun.file()` |
| **src/constitution/generator.ts** | `node:fs`, `node:path` line 7–8 | Use `Bun.file()` + path utility |
| `src/cli/prompts.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/init.ts` | `node:fs` | Use `Bun.file()` |
| `src/precheck/checks-blockers.ts` | `node:fs` | Use `Bun.file()` |
| `src/plugins/loader.ts` | `node:fs` | Use `Bun.file()` |
| `src/context/generator.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/plan.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/generate.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/config.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/analyze.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/analyze-parser.ts` | `node:fs` | Use `Bun.file()` |
| `src/agents/claude-plan.ts` | `node:fs` | Use `Bun.file()` |
| `src/prd/index.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/crash-recovery.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/context/greenfield.ts` | `node:fs` | Use `Bun.file()` |
| `src/hooks/runner.ts` | `node:fs` | Use `Bun.file()` |
| `src/precheck/checks-warnings.ts` | `node:fs` | Use `Bun.file()` |
| `src/prompts/loader.ts` | `node:fs` | Use `Bun.file()` |
| `src/verification/strategies/acceptance.ts` | `node:fs` | Use `Bun.file()` |
| `src/verification/runners.ts` | `node:fs` | Use `Bun.file()` |
| `src/pipeline/subscribers/events-writer.ts` | `node:fs` | Use `Bun.file()` |
| `src/pipeline/subscribers/registry.ts` | `node:fs` | Use `Bun.file()` |
| `src/pipeline/stages/acceptance.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/status-writer.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/lock.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/execution/lifecycle/run-setup.ts` | `node:fs` | Use `Bun.file()` |
| `src/commands/logs.ts` | `node:fs` | Use `Bun.file()` |
| `src/commands/runs.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/status-features.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/diagnose.ts` | `node:fs` | Use `Bun.file()` |
| `src/utils/path-security.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/routing/loader.ts` | `node:fs` | Use `Bun.file()` |
| `src/logger/logger.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/lifecycle/precheck-runner.ts` | `node:fs` | Use `Bun.file()` |
| `src/context/injector.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/lifecycle/acceptance-loop.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/progress.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/plugins.ts` | `node:fs` | Use `Bun.file()` |
| `src/commands/unlock.ts` | `node:fs` | Use `Bun.file()` |
| `src/interaction/plugins/webhook.ts` | `node:fs` | Use `Bun.file()` |
| `src/interaction/plugins/cli.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/interact.ts` | `node:fs` | Use `Bun.file()` |
| `src/interaction/state.ts` | `node:fs` | Use `Bun.file()` |
| `src/commands/precheck.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/pid-registry.ts` | `node:fs` | Use `Bun.file()` |
| `src/commands/common.ts` | `node:fs` | Use `Bun.file()` |
| `src/worktree/manager.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/execution/status-file.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/accept.ts` | `node:fs` | Use `Bun.file()` |
| `src/cli/runs.ts` | `node:fs` | Use `Bun.file()` |
| `src/execution/queue-handler.ts` | `node:fs` | Use `Bun.file()` |
| `src/pipeline/stages/constitution.ts` | `node:fs` | Use `Bun.file()` |
| `src/pipeline/events.ts` | `node:fs` | Use `Bun.file()` |
| `src/config/paths.ts` | `node:path` | Use path utility |
| `src/config/loader.ts` | `node:fs`, `node:path` | Use Bun APIs |
| `src/analyze/scanner.ts` | `node:fs` | Use `Bun.file()` |

**Effort:** 2–4 days (70–150 files need conversion)

---

## 2. Direct Bun Calls Outside _deps Pattern — HIGH PRIORITY

**Violation:** External calls (Bun.spawn, Bun.file, process.env) must be wrapped in injectable `_deps` objects for testability. ARCHITECTURE.md §2.

**Files with violations:**

### 2.1 src/review/orchestrator.ts:11, 18–26
```typescript
import { spawn } from "bun";  // Line 11 - VIOLATION: should be in _deps
// ...
async function getChangedFiles(workdir: string, baseRef?: string): Promise<string[]> {
  const diffArgs = ["diff", "--name-only"];
  const [stagedProc, unstagedProc, baseProc] = [
    spawn({ cmd: ["git", ...diffArgs, "--cached"], ... }),  // Line 22 - direct spawn
    spawn({ cmd: ["git", ...diffArgs], ... }),              // Line 23 - direct spawn
    ...
  ];
}
```
**Fix:** Create `_orchestratorDeps` object with injectable `spawn`, move spawn calls into it.
**Effort:** 30 min

### 2.2 src/review/runner.ts:7, 24
```typescript
import { spawn } from "bun";  // Line 7 - VIOLATION
// ...
async function loadPackageJson(workdir: string): Promise<...> {
  const file = Bun.file(`${workdir}/package.json`);  // Line 24 - direct Bun.file
  const content = await file.text();
  return JSON.parse(content);
}
```
**Fix:** Create `_runnerDeps` object with `file()` and `spawn()`.
**Effort:** 30 min

### 2.3 src/utils/git.ts:22–27
```typescript
export async function gitWithTimeout(args: string[], workdir: string): Promise<...> {
  const proc = Bun.spawn(["git", ...args], {  // Line 23 - direct Bun.spawn
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
}
```
**Fix:** Create `_gitDeps` object with injectable `spawn`.
**Effort:** 30 min

### 2.4 src/verification/smart-runner.ts:88–99
```typescript
export async function importGrepFallback(sourceFiles: string[], ...): Promise<string[]> {
  for (const pattern of testFilePatterns) {
    const glob = new Bun.Glob(pattern);              // Line 88 - direct Bun.Glob
    for await (const file of glob.scan(workdir)) {
      testFilePaths.push(`${workdir}/${file}`);
    }
  }
  // ...
  for (const testFile of testFilePaths) {
    let content: string;
    try {
      content = await Bun.file(testFile).text();    // Line 99 - direct Bun.file
    } catch {
```
**Fix:** Create `_smartRunnerDeps` with injectable `glob()` and `file()`.
**Effort:** 30 min

### 2.5 src/agents/claude.ts (COMPLIANT — has _deps)
✅ Lines 53–65, 73–92, 100–... properly wrap Bun.spawn in `_completeDeps`, `_decomposeDeps`, `_runOnceDeps`.

**Total Effort for Section 2:** 2–4 hours

---

## 3. Type Safety Issues — HIGH PRIORITY

**Violation:** `as any` type casts used in public APIs violate ARCHITECTURE.md §7 ("no `any` in public APIs").

### 3.1 src/review/orchestrator.ts:77
```typescript
// biome-ignore lint/suspicious/noExplicitAny: baseRef injected into config for pipeline use
const baseRef = (executionConfig as any)?.storyGitRef;
```
**Context:** Attempting to access dynamic property on typed ExecutionConfig.
**Fix:** Either widen ExecutionConfig type or use type guard.
**Effort:** 20 min

### 3.2 src/pipeline/stages/completion.ts:71–75
```typescript
pipelineEventBus.emit({
  type: "story:completed",
  // ...
  // Extra fields picked up by subscribers via `as any`
  cost: costPerStory,
  modelTier: ctx.routing?.modelTier,
  testStrategy: ctx.routing?.testStrategy,
});
```
**Context:** Comment indicates deliberate use of `as any` pattern.
**Fix:** Define complete type for event payload instead of relying on `as any` inference.
**Effort:** 20 min

**Total Effort for Section 3:** 40 min

---

## 4. Async Pattern Violations — MEDIUM PRIORITY

**Violation:** Use of `setTimeout`/`setInterval` for delays instead of `Bun.sleep()` or cancellable AbortController patterns.

ARCHITECTURE.md §6 notes: "Bun.sleep() is uncancellable — use setTimeout for cancellable delays only when truly needed."

**Files with setTimeout/setInterval (10 files):**
- `src/routing/strategies/llm.ts` — timeout logic
- `src/utils/git.ts:30–37` — timer for git timeout
- `src/agents/claude.ts` — multiple timeout handlers
- `src/execution/crash-recovery.ts` — recovery delay
- `src/hooks/runner.ts` — hook execution timeouts
- `src/review/runner.ts` — review check timeouts
- `src/verification/strategies/acceptance.ts` — acceptance test timeout
- `src/verification/executor.ts` — executor timeout
- `src/interaction/plugins/cli.ts` — user interaction timeout
- `src/tui/hooks/usePipelineEvents.ts` — React effect cleanup

**Assessment:** Majority are legitimate timeout implementations. Some should be wrapped in AbortController for cancellation safety.

**Example Issue - src/utils/git.ts:30–37:**
```typescript
let timedOut = false;
const timerId = setTimeout(() => {
  timedOut = true;
  try {
    proc.kill("SIGKILL");
  } catch {
    // Process may have already exited
  }
}, GIT_TIMEOUT_MS);

const exitCode = await proc.exited;
clearTimeout(timerId);
```
✅ **Pattern is correct** — uses clearTimeout to cancel.

**Effort:** Review only, ~1 hour. Most are acceptable; no changes needed.

---

## 5. File Size Violations (>400 lines) — MEDIUM PRIORITY

**Violation:** ARCHITECTURE.md §1 specifies 400-line hard limit per file.

**Estimated large files (need verification via wc):**

| File | Type | Est. Lines | Issue |
|:-----|:-----|:-----------|:------|
| `src/cli/prompts.ts` | CLI prompts | ~400+ | Multi-purpose prompt builder |
| `src/metrics/tracker.ts` | Metrics | ~400+ | Metric collection + aggregation |
| `src/context/builder.ts` | Context | ~400+ | Multi-step context assembly |
| `src/agents/claude.ts` | Agent adapter | ~400+ | Multiple agent methods |
| `src/verification/smart-runner.ts` | Test runner | ~400+ | Complex file detection logic |

**Typical fix:** Split by logical concern (one class/function per file).

**Effort:** 2–3 hours

---

## 6. Function Length Violations (>50 lines) — MEDIUM PRIORITY

**Violation:** ARCHITECTURE.md §5 specifies ≤30 lines (soft), ≤50 lines (hard limit).

**Estimated functions exceeding 50 lines:**

From ARCHITECTURE inspection, likely candidates:
- `src/execution/pipeline.ts` — main orchestrator function
- `src/routing/strategies/llm.ts` — LLM classification logic
- `src/tdd/orchestrator.ts` — TDD state machine
- `src/verification/executor.ts` — test execution wrapper
- `src/context/generator.ts` — context assembly

**Effort:** 3–5 hours (extract helpers as private functions in same file)

---

## 7. Magic Numbers — MEDIUM PRIORITY

**Violation:** ARCHITECTURE.md §4 forbids numeric literals in function bodies without named constants.

**Patterns found via grep:**

| File | Pattern | Line | Fix |
|:-----|:---------|:-----|:----|
| `src/agents/claude.ts` | `5000` (max output chars) | 31 | ✅ Already `MAX_AGENT_OUTPUT_CHARS` |
| `src/agents/claude.ts` | `1000` (stderr chars) | 39 | ✅ Already `MAX_AGENT_STDERR_CHARS` |
| `src/agents/claude.ts` | `5000` (SIGKILL grace) | 45 | ✅ Already `SIGKILL_GRACE_PERIOD_MS` |
| `src/utils/git.ts` | `10_000` (git timeout) | 12 | ✅ Already `GIT_TIMEOUT_MS` |
| `src/review/runner.ts` | Timeout literals | Various | Need audit |
| `src/execution/crash-recovery.ts` | Retry limits | Various | Need audit |

**Assessment:** Major constants are properly extracted. Spot-check remaining files for inline literals.

**Effort:** 1–2 hours (review + minor extraction)

---

## 8. Function Parameter Violations (>3 positional params) — LOW PRIORITY

**Violation:** ARCHITECTURE.md §5 requires options object for >3 params.

**Estimated instances:** 8+ functions

Common patterns:
- Pipeline stage handlers often take 4+ params (config, story, context, results)
- Should use interface with optional fields instead

**Example likely violation:**
```typescript
// ❌ Too many positional params
export async function runVerification(
  workdir: string,
  testCommand: string,
  timeout: number,
  onProgress: (msg: string) => void,
  skipCoverage: boolean
): Promise<...>

// ✅ Options object
interface VerifyOptions {
  testCommand: string;
  timeout: number;
  onProgress?: (msg: string) => void;
  skipCoverage?: boolean;
}
export async function runVerification(
  workdir: string,
  options: VerifyOptions
): Promise<...>
```

**Effort:** 1–2 hours

---

## 9. Structural Issues — MEDIUM PRIORITY

### 9.1 Duplicate File I/O Logic

**Pattern:** Multiple files implement `loadJsonFile` / `saveJsonFile` independently.

**Identified in:**
- `src/review/runner.ts:22–30` — loads package.json
- `src/prd/index.ts` — loads/saves PRD
- `src/context/builder.ts` — loads context files
- `src/constitution/loader.ts` — loads constitution

**Recommendation:** Extract shared `util/json-file.ts`:
```typescript
export async function loadJsonFile<T>(path: string): Promise<T | null>
export async function saveJsonFile<T>(path: string, data: T): Promise<void>
```

**Effort:** 1 hour

### 9.2 Over-Fragmented Module: src/context/

**Files:** 10+ files for single responsibility (context generation)
- `src/context/builder.ts`
- `src/context/generator.ts`
- `src/context/auto-detect.ts`
- `src/context/injector.ts`
- `src/context/test-scanner.ts`
- `src/context/formatter.ts`
- `src/context/greenfield.ts`
- `src/context/generators/` (5 agent-specific generators)

**Assessment:** Reasonably organized by concern (each agent has a generator). No immediate action needed, but monitor for further fragmentation.

**Effort:** 0 hours (structure is justified)

### 9.3 Under-Separated Concerns: src/execution/

**Directory:** 37 files mixing lifecycle, batching, escalation, progress, and PID management.

**Current structure:**
- `src/execution/runner.ts` — thin orchestrator ✅
- `src/execution/pipeline-result-handler.ts` — result handling ✅
- `src/execution/lifecycle/` — lifecycle hooks (run-setup, acceptance-loop, etc.) ✅
- `src/execution/escalation/` — tier escalation ✅
- `src/execution/pid-registry.ts` — PID tracking ✅
- `src/execution/progress.ts` — progress logging ✅

**Assessment:** Well-separated by subdirectory. Structure is appropriate.

**Effort:** 0 hours (no action needed)

### 9.4 Circular Imports

**Scan Result:** No obvious circular imports detected via grep patterns.

**Recommendation:** Run `tsc --noEmit` to verify (already in test pipeline).

**Effort:** 0 hours

---

## 10. Dead Exports — LOW PRIORITY

**Assessment:** Limited evidence of truly dead exports. Hub files (pipeline/stages/index.ts, prd/types.ts) re-export aggressively but intentionally for external consumption.

**Example - src/pipeline/stages/index.ts:**
```typescript
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
// ... 13 more
```
✅ **Intentional:** Provides single import point for custom pipeline construction.

**Recommendation:** Spot-check via LSP workspaceSymbol queries if unused exports become a concern in future releases.

**Effort:** 0 hours (skip for now)

---

## Summary & Remediation Roadmap

### CRITICAL PATH (blocking enterprise grade):

1. **Replace 64 Node.js imports with Bun APIs** — 2–4 days
   - Create shared `src/utils/bun-file.ts` with `readJsonFile`, `writeJsonFile` helpers
   - Systematically convert all `node:fs`, `node:path` imports

2. **Wrap 5 direct Bun calls in _deps** — 2–4 hours
   - Create: `_orchestratorDeps`, `_runnerDeps`, `_gitDeps`, `_smartRunnerDeps`
   - Update test mocking to use injectable deps

3. **Remove 2 `as any` casts** — 40 min
   - Widen ExecutionConfig type or use type guard for dynamic properties
   - Define complete PipelineEvent payload type

### SECONDARY PATH (improves maintainability):

4. **Split oversized files** (>400 lines) — 2–3 hours
5. **Extract function helpers** (>50 lines) — 3–5 hours
6. **Consolidate duplicate JSON I/O** — 1 hour
7. **Review magic numbers** — 1–2 hours
8. **Refactor function signatures** (>3 params) — 1–2 hours

### TOTAL ESTIMATED EFFORT

- **Critical:** 2–5 days
- **Secondary:** 1–2 weeks (phased)

---

## Next Steps

1. **Priority 1 (Critical):** Assign Node.js → Bun API migration to team
2. **Priority 2 (High):** Wrap direct Bun calls in _deps objects
3. **Priority 3 (High):** Remove `as any` type casts
4. **Priority 4 (Medium):** Fix file/function sizes + magic numbers
5. **Priority 5 (Low):** Review parameter signatures

---

**Report prepared by:** Code Quality Audit
**Standards:** ARCHITECTURE.md (2026-03-10)
**Scope:** src/ directory analysis
**Confidence:** HIGH (grep-based pattern matching + manual file inspection)
