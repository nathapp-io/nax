# Deep Code Review: @nathapp/nax

**Date:** 2026-04-28
**Reviewer:** Subrina (AI)
**Version:** 0.64.0-canary.2
**Files Reviewed:** 486 TypeScript source files (~77,848 LOC src / ~158,803 LOC test)
**Baseline:** 594 test files, Bun + TypeScript strict

---

## Overall Grade: B+ (81/100)

This is a well-engineered, security-conscious codebase with deliberate safeguards throughout.
Signal handling, subprocess spawning, event listener cleanup, AbortController discipline, and
timer management are all near-exemplary. The primary concerns are a systemic file-size
convention violation (15+ files exceed the 400-line project limit), one mutation that breaks
the immutability contract in the config merger, a usePty leak window, and a misleading
security warning that could mask real risks. No hardcoded secrets, no eval usage, no prototype
pollution, and no unbounded async operations were found.

---

## Scoring

| Dimension | Score | Notes |
|:---|:---|:---|
| **Security** | 17/20 | Strong argv-mode spawning, validated env escaping, good path security. Shell-op pass-through in hooks and shell-exec in verifier are the notable gaps. |
| **Reliability** | 17/20 | Excellent signal handling and abort discipline. Merger mutation and PTY leak window are the weak spots. |
| **API Design** | 16/20 | Clean injectable deps pattern, well-typed surfaces. Two `any` fields in runner.ts and one const assertion cast in merger need attention. |
| **Code Quality** | 14/20 | 15+ files exceed the 400-line project-mandated limit (largest: 1,176 lines). Otherwise naming, DRY, and structure are good. |
| **Best Practices** | 17/20 | Excellent Bun-native discipline, strong DI patterns, good AbortSignal coverage. A few Node.js sync APIs slip in on cold paths. |

---

## Findings

### 🔴 HIGH

#### PERF-1: 15+ source files exceed the 400-line project limit

**Severity:** HIGH | **Category:** Code Quality / Performance

The project CLAUDE.md and `project-conventions.md` set a **400-line hard limit** for all
source files. At least 15 files violate this, with several approaching 3× the limit:

| File | Lines |
|:---|:---|
| `src/config/schemas.ts` | 1,176 |
| `src/agents/acp/adapter.ts` | 1,017 |
| `src/review/semantic.ts` | 848 |
| `src/pipeline/stages/autofix.ts` | 821 |
| `src/cli/plan.ts` | 807 |
| `src/session/manager.ts` | 728 |
| `src/config/runtime-types.ts` | 715 |
| `src/acceptance/generator.ts` | 704 |
| `src/prompts/builders/rectifier-builder.ts` | 681 |
| `src/review/adversarial.ts` | 623 |
| `src/execution/unified-executor.ts` | 595 |
| `src/review/orchestrator.ts` | 574 |
| `src/context/engine/orchestrator.ts` | 573 |
| `src/verification/rectification-loop.ts` | 555 |
| `src/context/engine/types.ts` | 536 |

**Risk:** Large files increase cognitive load, make testing harder, and create merge conflicts.
`adapter.ts` at 1,017 lines is particularly dangerous — it mixes session lifecycle, fallback
logic, tool-call parsing, and interaction bridging.

**Fix:** Split by logical concern. For `adapter.ts`: extract `interaction-bridge.ts` (tool-call
parsing + interaction handling), `session-lifecycle.ts` (open/close/cancel), and `fallback.ts`
(retry loop). For `schemas.ts`: split into `schema-execution.ts`, `schema-routing.ts`,
`schema-quality.ts`, etc.

---

### 🟠 MEDIUM

#### SEC-1: Shell-operator pass-through gives false security confidence

**Severity:** MEDIUM | **Category:** Security

`src/hooks/runner.ts:102-106` detects shell operators (`|`, `&`, `;`, `$`, etc.) and warns,
but **does not block** execution:

```typescript
// hooks/runner.ts:102-106
export function hasShellOperators(command: string): boolean {
  const shellOperators = /[|&;$`<>(){}]/;
  return shellOperators.test(command);  // returns true — execution continues
}

// hooks/runner.ts:172-177
if (hasShellOperators(hookDef.command)) {
  logger.warn("hooks", "[SECURITY] Hook command contains shell operators", { ... });
  // No early return — hook still executes
}
```

Because hooks are spawned via `Bun.spawn(argv, ...)` (argv mode, no shell), the operators
are treated as literal arguments rather than shell metacharacters, so there is **no actual
injection today**. However:

1. The warning message says "may enable injection attacks", creating a false impression that
   this is a real current risk rather than a potential future one.
2. If a future refactor accidentally switches to shell mode (e.g., `shell: true`), the
   guard becomes a single point of failure.
3. Users who write `nax-notify | slack-send` in hooks.json expect pipe behavior; they get
   silent literal-arg behavior instead, masking misconfiguration.

**Fix:** Either:
- Block shell operators outright and require users to wrap complex hooks in a shell script, or
- Add a `@design` doc comment at `executeHook` explicitly stating argv-mode prevents injection,
  and change the warning to clarify that the operators are treated as literals, not metacharacters.

---

#### SEC-2: Shell execution in verifier uses config-sourced command string verbatim

**Severity:** MEDIUM | **Category:** Security

`src/verification/executor.ts:74` passes the test command from config directly to `/bin/sh -c`:

```typescript
// verification/executor.ts:74
const proc = _executorDeps.spawn([shell, "-c", command], {
  stdout: "pipe",
  stderr: "pipe",
  env: env || normalizeEnvironment(process.env as Record<string, string | undefined>),
  cwd: options?.cwd,
});
```

`command` originates from `config.quality.commands.test` (a user-controlled file:
`.nax/config.json`). This is intentional — test commands legitimately need shell features like
pipes and redirects. However, there is **no input validation or sanitization** on the command
before shell execution. If `.nax/config.json` is compromised (malicious PR, symlink attack, or
path traversal), arbitrary shell commands execute with the user's privileges.

**Risk:** Any attacker who can write `.nax/config.json` can achieve RCE. This is a trust
boundary that is currently undocumented.

**Fix:** Add a `@design` annotation and a comment in the security docs stating that
`.nax/config.json` is a **trusted** file equivalent to a Makefile or script — users are
responsible for its contents. Consider adding a warning during `nax init` about its
security implications.

---

#### MEM-1: usePty stdout streaming IIFE is untracked — setState-after-unmount window

**Severity:** MEDIUM | **Category:** Memory / React

`src/tui/hooks/usePty.ts:110-132` launches an async IIFE to stream stdout without storing
or awaiting the promise in the cleanup function:

```typescript
// usePty.ts:110-132
(async () => {
  let currentLine = "";
  for await (const chunk of proc.stdout) {  // Can still be running after unmount
    ...
    setState((prev) => {  // setState on unmounted component
      ...
    });
  }
})();  // Promise is fire-and-forget — not awaited in cleanup

// Cleanup only kills the process, does not await the IIFE
return () => {
  proc.kill();  // SIGKILL
};
```

When the component unmounts, `proc.kill()` is called. Killing the process closes `proc.stdout`,
which terminates the `for await` loop — but not synchronously. There is a race window between
the kill and the loop exit where `setState` can be called on an already-unmounted component.

React 18 does not crash on this (it silently ignores updates to unmounted components), and
`BUG-22` mitigates the `.catch()` path. But the IIFE's promise is permanently lost; if Bun's
stream close is delayed (as with the acknowledged Bun stream drain bug), the loop hangs with
no timeout.

**Fix:**

```typescript
// Store the streaming promise
let streamDone: Promise<void> | null = null;
streamDone = (async () => {
  for await (const chunk of proc.stdout) { ... }
})().catch(() => {});

return () => {
  proc.kill();
  // Optionally: race streamDone against a short timeout for clean teardown
};
```

---

#### TYPE-1: deepMergeConfig mutates its own return value for constitution content

**Severity:** MEDIUM | **Category:** Type Safety / Immutability

`src/config/merger.ts:105-117` calls `deepMergeConfig` (which is documented as
"immutable — does not mutate inputs") and then immediately mutates the returned object:

```typescript
// merger.ts:105-117
const mergedConstitution = deepMergeConfig(baseConst, overrideConst);

if (baseContent && overrideContent) {
  // Mutation of deepMergeConfig's return value — violates own immutability contract
  (mergedConstitution as unknown as Record<string, unknown>).content =
    `${baseContent}\n\n${overrideContent}`;
}

result[key] = mergedConstitution;
```

The double-cast `as unknown as Record<string, unknown>` is a smell that the type system is
being defeated to permit an operation the types would otherwise reject. The `content`
concatenation logic should be applied **before** calling `deepMergeConfig`, not after.

**Fix:** Pre-process the constitution content before merging:

```typescript
const mergedBase = baseContent && overrideContent
  ? { ...baseConst, content: `${baseContent}\n\n${overrideContent}` }
  : baseConst;
const mergedConstitution = deepMergeConfig(mergedBase, overrideConst);
result[key] = mergedConstitution;
```

---

### 🟡 LOW

#### MEM-2: Module-level config cache has no TTL, max-size, or eviction

**Severity:** LOW | **Category:** Memory

`src/config/loader.ts:254` declares a module-level Map that persists across calls:

```typescript
const _rootConfigCache = new Map<string, Promise<NaxConfig>>();
```

Cache keys are built from `resolvedRootConfigPath + profileKey`. In a single nax run this is
bounded. In a long-running process (test suite with 594 tests, or a future server mode),
every unique `(path, profile)` pair adds a permanent entry. The only cleanup is the
`_clearRootConfigCache()` export intended for tests.

**Fix:** Add a lightweight max-size cap (e.g., 20 entries, LRU evict oldest):

```typescript
const MAX_CACHE_SIZE = 20;
if (_rootConfigCache.size >= MAX_CACHE_SIZE) {
  const firstKey = _rootConfigCache.keys().next().value;
  _rootConfigCache.delete(firstKey);
}
_rootConfigCache.set(cacheKey, rootConfigPromise);
```

---

#### SEC-3: isRelativeAndSafe uses literal includes("..") without normalization

**Severity:** LOW | **Category:** Security

`src/utils/path-security.ts:52` checks for traversal via:

```typescript
if (filePath.includes("..")) return false;
```

This is overly broad: it rejects legitimate filenames like `parse..result.ts` or
`v2..3-migration/` while technically safe paths like `foo/%2e%2e/bar` (URL-encoded) or
paths using Unicode equivalents would pass. For a CLI tool accepting file paths from
agent output, the legitimate-false-positive direction is safer than the miss direction,
so the current behavior is acceptable. However, `path.normalize()` before the check would
make the intent explicit:

**Fix:**

```typescript
export function isRelativeAndSafe(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) return false;
  if (normalized.includes("..")) return false;
  return true;
}
```

---

#### PERF-2: usePty creates new arrays via spread on every stdout chunk

**Severity:** LOW | **Category:** Performance

`src/tui/hooks/usePty.ts:125-128` allocates two new arrays on every chunk:

```typescript
const newLines = [...prev.outputLines, ...truncatedLines];  // New array
const trimmed = newLines.length > MAX_PTY_BUFFER_LINES
  ? newLines.slice(-MAX_PTY_BUFFER_LINES)  // Second new array
  : newLines;
```

For an agent producing rapid output, this triggers GC on every React state update cycle.
With `MAX_PTY_BUFFER_LINES = 500`, this is capped, but spread + slice on every chunk is
still O(500) per update.

**Fix:** Accumulate in a buffer and flush in batches, or use a circular buffer. A simple
batch approach with `setInterval` flushes every ~100ms instead of per-chunk.

---

#### PERF-3: Synchronous existsSync used in hot-path context injection

**Severity:** LOW | **Category:** Performance

`src/context/injector.ts` uses `existsSync` (sync I/O) multiple times per language
detection call:

```typescript
// injector.ts:126
if (!existsSync(pyproject) && !existsSync(requirements)) return null;
if (existsSync(pyproject)) { ... }
// injector.ts:191
if (!existsSync(pom) && !existsSync(gradle) && !existsSync(gradleKts)) return null;
```

These calls block the event loop. In sequential single-story runs this is negligible. In
parallel mode (`parallel > 1`) with many stories running concurrently, multiple goroutines
block simultaneously on filesystem stat calls.

**Fix:** Use `Bun.file(path).exists()` (returns a Promise) and await concurrently:

```typescript
const [hasPyproject, hasRequirements] = await Promise.all([
  Bun.file(pyproject).exists(),
  Bun.file(requirements).exists(),
]);
if (!hasPyproject && !hasRequirements) return null;
```

---

#### BUG-1: Uncaught exception handler logs full stack trace with internal paths

**Severity:** LOW | **Category:** Security / Information Disclosure

`src/execution/crash-signals.ts:123-133` writes the full stack trace to both stderr and
the logger:

```typescript
process.stderr.write(`\n[nax crash] Uncaught exception: ${error.message}\n${error.stack ?? ""}\n`);
...
logger?.error("crash-recovery", "Uncaught exception", {
  error: error.message,
  stack: error.stack,  // Full stack with absolute file paths
});
```

For a CLI tool used locally this is fine. If nax is ever used in a multi-tenant or shared
environment where JSONL logs are accessible to other users, internal file paths leaked via
stack traces could aid an attacker in mapping the filesystem layout.

**Fix:** For the logger call (which writes to JSONL), truncate the stack or strip
absolute paths using `path.relative(process.cwd(), ...)`. The stderr write for crash
reporting can stay verbose.

---

#### ENH-1: BUG-* inline comments reference unresolvable issue IDs

**Severity:** LOW | **Category:** Documentation

Many source files contain `// BUG-N:` annotations (e.g., `BUG-022`, `BUG-054`, `BUG-097`
in `usePty.ts`, `pipeline/types.ts`, `adapter.ts`) without links to the tracking system.
Future contributors cannot determine whether the bug was fixed, is still tracked, or was
abandoned.

**Fix:** Convert to `// @design` annotations with inline rationale, or add GitHub issue
links: `// BUG-022 (github.com/nathapp-io/nax/issues/522)`.

---

#### TYPE-2: runner.ts uses any for metrics and PRD before type is resolved

**Severity:** LOW | **Category:** Type Safety

`src/execution/runner.ts:113-120`:

```typescript
// biome-ignore lint/suspicious/noExplicitAny: Metrics array type varies
const allStoryMetrics: any[] = [];
// biome-ignore lint/suspicious/noExplicitAny: PRD type initialized during setup
let prd: any | undefined;
```

`PRD` is a concrete exported type from `src/prd/types`. The `any` here exists because
`prd` is declared before `runSetupPhase` returns it to avoid TDZ issues. A `let prd: PRD |
undefined` would type-check correctly after setup.

**Fix:**

```typescript
import type { PRD } from "../prd";
let prd: PRD | undefined;
const allStoryMetrics: StoryMetrics[] = [];  // Import StoryMetrics from metrics module
```

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | PERF-1 | L | Split 15+ oversized files; start with `adapter.ts` (1,017 lines) and `schemas.ts` (1,176 lines) |
| P1 | TYPE-1 | S | Remove post-merge mutation in `merger.ts:109` — pre-process content before `deepMergeConfig` |
| P1 | MEM-1 | S | Track and gate the IIFE promise in `usePty.ts` cleanup |
| P2 | SEC-1 | S | Clarify/fix shell-operator handling in `hooks/runner.ts` — block or document argv-mode |
| P2 | SEC-2 | S | Add `@design` annotation to `executor.ts` documenting the trust boundary |
| P3 | MEM-2 | S | Add max-size eviction to `_rootConfigCache` in `config/loader.ts` |
| P3 | PERF-2 | M | Batch PTY output updates; use a circular buffer in `usePty.ts` |
| P4 | PERF-3 | M | Replace synchronous `existsSync` with `Bun.file().exists()` in `injector.ts` |
| P4 | SEC-3 | S | Normalize path before `includes("..")` in `isRelativeAndSafe` |
| P5 | TYPE-2 | S | Type `prd` and `allStoryMetrics` properly in `runner.ts` |
| P5 | BUG-1 | S | Strip absolute paths from logger stack traces in `crash-signals.ts` |
| P5 | ENH-1 | M | Replace `BUG-N` comments with `@design` annotations or GitHub issue links |

---

## Positive Observations

These patterns are worth calling out as exemplary:

- **Argv-mode subprocess spawning** — All production spawns (`hooks/runner.ts`, `spawn-client.ts`,
  `verification/executor.ts`) use argv arrays via `Bun.spawn`. Shell interpretation is
  deliberately avoided everywhere except the explicitly shell-needed verifier path.

- **Timer discipline** — Every `setTimeout`/`setInterval` is paired with `clearTimeout`/
  `clearInterval` in `finally` blocks or cancellable wrapper objects. No leaking timers found.

- **AbortController coverage** — 38+ usages of `AbortSignal`/`AbortController` across the
  codebase. Long-running operations can all be cancelled. The `raceWithAbort` utility in
  `adapter.ts` and the `raceWithDeadline` pattern in `executor.ts` are both well-engineered.

- **Event listener cleanup** — Every `process.on` / `events.on` in React hooks and signal
  handlers has a corresponding `removeListener` / `off` call in cleanup paths.

- **Prototype pollution prevention** — `deepMergeConfig` iterates only `Object.keys()`,
  checks `constructor === Object`, and never touches `__proto__` or inherited properties.

- **Stream drain concurrency** — `Promise.all([proc.exited, stdout, stderr])` is used
  consistently to prevent pipe-buffer deadlock. The acknowledged Bun stream-drain bug is
  mitigated via cancellable timeout races.

- **ReDoS-safe regexes** — All security-sensitive regexes use bounded character classes
  (`[^)]*`, `[^`]*`) with explicit comments noting their ReDoS-safety.

- **No hardcoded secrets** — Grep across all 77,848 LOC found zero API keys, passwords,
  tokens, or connection strings.

- **Dependency injection throughout** — `_runnerDeps`, `_executorDeps`, `_spawnClientDeps`,
  `_acpAdapterDeps`, etc. make every module testable without `mock.module()`.

---

## By-Design Decisions

The following patterns appear concerning but are intentional:

| Pattern | Location | Rationale |
|:---|:---|:---|
| Shell execution for test commands | `verification/executor.ts:74` | Test commands legitimately need pipes, redirects, env substitution |
| `stderr: "inherit"` in PTY | `usePty.ts:104` | Prevents pipe-buffer deadlock when agent writes large stderr (`MEM-1` in file) |
| `realpathSync` in path validation | `utils/path-security.ts:35` | Sync required for symlink traversal security; only on cold validation path |
| 5-second stream drain timeout | `spawn-client.ts:27` | Mitigates Bun bug where piped streams don't close after SIGKILL |
| `hardDeadline` 10s force-exit | `crash-signals.ts:77-80` | Prevents hung shutdown; unref'd so it doesn't keep the process alive normally |
