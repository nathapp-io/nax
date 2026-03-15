# Deep Code Review: @nathapp/nax

**Date:** 2026-03-15
**Reviewer:** Subrina (AI — claude-sonnet-4-6), revised by Nax Dev (claude-opus-4-6)
**Version:** 0.42.6 (commit `deb8333`)
**Stack:** Bun 1.3.7+ / TypeScript strict / Ink (React TUI) / Zod
**Source files:** ~328 `.ts` files across `src/`
**Test files:** ~268 files across `test/`
**Checklists applied:** universal.md, node-general.md, react.md

---

## Overall Grade: B- (72/100)

The codebase demonstrates solid architectural discipline — clean dependency injection patterns, well-designed type hierarchies, and good separation of concerns across pipeline stages. Two confirmed security issues (symlink path traversal in the plugin loader, hardcoded permission escalation on session resume), one correctness bug (signal handler leak), and several code quality issues require attention. Test coverage is strong at 268 test files / 4,087+ tests.

> **Revision note:** Original review contained several false positives and overstated findings. Corrections applied after source verification by Nax Dev. See ~~strikethrough~~ items below.

| Dimension | Score | Notes |
|:---|:---:|:---|
| Security | 13/20 | Path traversal (real), permission escalation on resume (real), model name validation (low risk) |
| Reliability | 14/20 | Signal handler leak (real), unsafe lock cast (real) |
| API Design | 15/20 | Clean interfaces and DI pattern; a few `any` leaks |
| Code Quality | 14/20 | ~66 non-CLI console calls, oversized bin/nax.ts + adapter.ts |
| Best Practices | 16/20 | `setTimeout` usage in adapter.ts is actually correct (cancellable); one immutability violation |
| **Total** | **72/100** | **B-** |

---

## Findings

### CRITICAL

---

#### BUG-1: unhandledRejection handler never removed — accumulates across run() calls

**File:** `src/execution/crash-signals.ts:137,146`
**Severity:** CRITICAL | **Category:** Memory / Correctness

```typescript
// Registration (line 137) — anonymous arrow function, reference NOT stored
process.on("unhandledRejection", (reason) => unhandledRejectionHandler(reason));

// Cleanup (line 146) — NEW anonymous function, different reference identity
// process.removeListener() compares by reference — this call is a silent no-op
process.removeListener("unhandledRejection", (reason) => unhandledRejectionHandler(reason));
```

**Risk:** Every call to `run()` installs an additional `unhandledRejection` handler that is never removed. After N runs, N handlers fire on any unhandled rejection, producing duplicate crash logs and potentially triggering multiple `process.exit()` calls. This is a regression hazard that worsens with each invocation in long-lived sessions.

**Contrast:** Lines 129–136 correctly store named handler references for `SIGTERM`, `SIGINT`, `SIGHUP`, and `uncaughtException` before calling `removeListener`. The `unhandledRejection` case is the only inconsistency.

**Fix:**
```typescript
const rejectionHandler = (reason: unknown) => unhandledRejectionHandler(reason);
process.on("unhandledRejection", rejectionHandler);
// ...
process.removeListener("unhandledRejection", rejectionHandler);
```

---

#### SEC-1: Symlink bypass in plugin module path validation

**File:** `src/utils/path-security.ts:35`
**Severity:** CRITICAL | **Category:** Security

```typescript
// path-security.ts:35 — normalize() is lexical only; does NOT resolve symlinks
const absoluteTarget = normalize(modulePath);
const isWithin = normalizedRoots.some((root) => {
  return absoluteTarget.startsWith(`${root}/`) || absoluteTarget === root;
});
```

**Risk:** A symlink inside an allowed root (e.g., `nax/plugins/evil.ts -> /etc/passwd`) passes the containment check because the symlink path lexically starts with the root. The subsequent `import()` in `src/plugins/loader.ts:301` follows the symlink and loads arbitrary code. This is an exploitable plugin sandbox escape.

**Context:** `src/config/path-security.ts:32` in the same project already demonstrates the correct approach using `realpathSync`.

**Fix:**
```typescript
import { realpathSync } from "node:fs";

// Resolve to real filesystem path (follows symlinks) before containment check
const absoluteTarget = realpathSync(normalize(modulePath));
const isWithin = normalizedRoots.some((root) => {
  const realRoot = realpathSync(root);
  return absoluteTarget.startsWith(`${realRoot}/`) || absoluteTarget === realRoot;
});
```

---

#### ~~SEC-2: Argument injection via model name string interpolation~~ (DOWNGRADED → LOW)

**File:** `src/agents/acp/adapter.ts:443`
**Severity:** ~~CRITICAL~~ LOW | **Category:** Security
**Revision:** Model name originates from local `config.json` — a user who edits this file already has full local access. Not a sandbox escape. Adding validation is still good practice but this is not critical.

```typescript
// adapter.ts:443 — model name from user-editable config.json interpolated unsanitized
const cmdStr = `acpx --model ${options.modelDef.model} ${this.name}`;
// SpawnAcpClient splits on whitespace (line 262: cmdStr.split(/\s+/))
// Model name with embedded spaces injects extra argv elements
```

**Risk:** `options.modelDef.model` originates from `nax/config.json` which is user-editable. A model name containing spaces or argument-like strings (e.g., `"claude --allow-write /etc"`) injects extra arguments into the spawned `acpx` process. This can pass unexpected flags to the agent subprocess.

**Fix:**
```typescript
// Option A: Validate before building the command
const MODEL_NAME_PATTERN = /^[\w./@:-]+$/;
if (!MODEL_NAME_PATTERN.test(options.modelDef.model)) {
  throw new Error(`[acp-adapter] Invalid model name: "${options.modelDef.model}"`);
}

// Option B: Refactor SpawnAcpClient to accept structured args instead of a command string
```

---

#### BUG-2: Unsafe cast in lock.ts masks parse failure branch

**File:** `src/execution/lock.ts:64`
**Severity:** CRITICAL | **Category:** Bug / Type Safety

```typescript
// lock.ts:64 — parse failure sets lockData to undefined via an unsafe double-cast
try {
  lockData = JSON.parse(existingContent) as { pid: number };
} catch {
  lockData = undefined as unknown as { pid: number }; // unsafe: type says non-null, value is undefined
}
// Later: if (lockData) { ... check if pid is alive ... }
```

**Risk:** The `undefined as unknown as { pid: number }` cast lies to the type system. Any future refactoring that accesses `lockData.pid` before the null-guard (e.g., in logging) will throw at runtime. The code works today only because the falsy check on `lockData` catches it. Additionally, a TOCTOU window exists between the stale-lock unlink (line 82) and the `O_EXCL` create (line 92): two concurrent processes can both decide a lock is stale, both delete it, and both attempt creation — the `O_EXCL` handles the create race correctly, but the double-delete is untested.

**Fix:**
```typescript
let lockData: { pid: number } | null = null;
try {
  lockData = JSON.parse(existingContent) as { pid: number };
} catch {
  // Corrupt lock file — fall through to delete and recreate
}
```

---

### HIGH

---

#### SEC-3: Hardcoded `approve-all` permission on session resume

**File:** `src/agents/acp/spawn-client.ts:329`
**Severity:** HIGH | **Category:** Security

```typescript
return new SpawnAcpSession({
  agentName,
  sessionName,
  cwd: this.cwd,
  model: this.model,
  timeoutSeconds: this.timeoutSeconds,
  permissionMode: "approve-all", // hardcoded — ignores caller's configured permission level
  env: this.env,
  pidRegistry: this.pidRegistry,
});
```

**Risk:** A session originally created with restricted permissions (`approve-reads`, `default`) is resumed with `approve-all`, silently elevating the agent's access level. This undermines the user's security configuration for ACP sessions.

**Fix:** Thread the `permissionMode` through to `loadSession()`:
```typescript
async loadSession(
  sessionName: string,
  agentName: string,
  permissionMode: string = "approve-reads",
): Promise<AcpSession | null>
```

---

#### MEM-1: Unbounded `pendingMessages` Map in Telegram plugin (DOWNGRADED → LOW)

**File:** `src/interaction/plugins/telegram.ts:49`
**Severity:** ~~HIGH~~ LOW | **Category:** Memory
**Revision:** `pendingMessages` is bounded by session lifetime (30min max). Entries are cleaned up on receive/cancel/timeout. You'd need thousands of unanswered Telegram interactions in a single session for meaningful memory impact.

```typescript
private pendingMessages = new Map<string, number>(); // requestId -> messageId
// Entries added on every send() call (line 102)
// Entries only removed on: successful receive() match, cancel(), sendTimeoutMessage()
// No TTL, no max-size guard
```

**Risk:** In automated sessions with frequent interaction requests that never receive a Telegram response (user ignores or deletes the message), entries accumulate indefinitely. Over hours of runtime, this leaks memory proportional to the number of unanswered interaction requests.

**Fix:**
```typescript
private static readonly MAX_PENDING = 500;

// After pendingMessages.set() in send():
if (this.pendingMessages.size > TelegramInteractionPlugin.MAX_PENDING) {
  const oldestKey = this.pendingMessages.keys().next().value;
  if (oldestKey !== undefined) this.pendingMessages.delete(oldestKey);
}
```

---

#### BUG-3: Subprocess spawned to delete a single file

**File:** `src/execution/lock.ts:120`
**Severity:** HIGH | **Category:** Bug / Performance

```typescript
// releaseLock: forks a subprocess just to run `rm`
const proc = Bun.spawn(["rm", lockPath], { stdout: "pipe" });
await proc.exited;
await Bun.sleep(10); // "prevents race in tests"
```

**Risk:** Fork+exec for a single `unlink` syscall is ~1000x slower than `fs.unlink()`. The sleep adds arbitrary latency. The same file uses `fs.unlink` directly on line 82 — this inconsistency is confusing and the subprocess approach is strictly worse.

**Fix:**
```typescript
import { unlink } from "node:fs/promises";
await unlink(lockPath).catch(() => {}); // ignore ENOENT if already gone
```

---

#### ~~PERF-1: `setTimeout` used in three locations — forbidden project pattern~~ (FALSE POSITIVE)

**File:** `src/agents/acp/adapter.ts:220, 506, 583`
**Severity:** ~~HIGH~~ N/A | **Category:** Convention / Performance
**Revision:** These `setTimeout` usages are in `Promise.race` patterns where `clearTimeout()` is needed for cleanup. `Bun.sleep()` is **uncancellable** (documented in MEMORY.md lesson). `setTimeout` is the correct choice here — the "forbidden pattern" rule applies to delays/sleeps, not to cancellable race timeouts.

---

#### CONV-1: Node.js `fs` APIs used — forbidden project pattern

**Files:** `src/execution/lock.ts:61,81,91-94` | `src/execution/pid-registry.ts:12-13`
**Severity:** HIGH | **Category:** Convention

```typescript
// lock.ts:91-94 — synchronous Node.js fs (openSync/writeSync/closeSync)
const fs = await import("node:fs");
const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
fs.writeSync(fd, JSON.stringify(lockData));
fs.closeSync(fd);

// pid-registry.ts:12-13 — existsSync, appendFile
```

Per `04-forbidden-patterns.md`, `fs.readFileSync`, `fs.writeFileSync`, and Node.js file APIs are forbidden in favour of `Bun.file()` / `Bun.write()`.

**Exception:** The `O_CREAT | O_EXCL` atomic combination in `lock.ts` has no direct Bun-native equivalent. If Bun does not expose this flag combination, add a `// NOTE: Node.js fs used intentionally — Bun lacks O_EXCL atomic create` comment and document the justification.

---

### MEDIUM

---

#### TYPE-1: `any` in exported interfaces

**Files:** `src/execution/runner.ts:116` | `src/execution/runner-execution.ts:37` | `src/execution/runner-completion.ts:44`
**Severity:** MEDIUM | **Category:** Type Safety

```typescript
// runner-execution.ts:37 and runner-completion.ts:44
statusWriter: any;

// runner.ts:116
const allStoryMetrics: any[] = [];
```

**Fix:** Import and use the proper types:
```typescript
import type { StatusWriter } from "./status-writer";
import type { StoryMetrics } from "../metrics";

statusWriter: StatusWriter;
const allStoryMetrics: StoryMetrics[] = [];
```

---

#### BUG-4: Parameter mutation via `Object.assign`

**File:** `src/execution/runner-completion.ts:91`
**Severity:** MEDIUM | **Category:** Bug / Immutability

```typescript
// Mutates the options object passed by caller — violates project immutability rules
Object.assign(options, {
  prd: acceptanceResult.prd,
  totalCost: acceptanceResult.totalCost,
  iterations: acceptanceResult.iterations,
  storiesCompleted: acceptanceResult.storiesCompleted,
});
```

**Fix:**
```typescript
const updatedOptions = {
  ...options,
  prd: acceptanceResult.prd,
  totalCost: acceptanceResult.totalCost,
  iterations: acceptanceResult.iterations,
  storiesCompleted: acceptanceResult.storiesCompleted,
};
```

---

#### CONV-2: Files exceeding 400-line hard limit

**Files:** `bin/nax.ts` (1133 lines) | `src/agents/acp/adapter.ts` (717 lines) | `src/tdd/orchestrator.ts` (406 lines)
**Severity:** MEDIUM | **Category:** Style / Convention

`bin/nax.ts` is 2.8x over the 400-line hard limit and contains all CLI command registrations inline. `adapter.ts` is 1.8x over and mixes session management, prompt building, interaction bridging, and completion logic.

**Fix:**
- `bin/nax.ts`: Extract each subcommand handler to `src/commands/<subcommand>.ts` (pattern already exists for some commands in `src/commands/`).
- `adapter.ts`: Extract session creation helpers and `complete()` into `src/agents/acp/session-helpers.ts` and `src/agents/acp/complete.ts`.

---

#### CONV-3: `console.error` as default plugin error sink

**File:** `src/plugins/loader.ts:25`
**Severity:** MEDIUM | **Category:** Convention

```typescript
export let _pluginErrorSink: (...args: unknown[]) => void = (...args) => console.error(...args);
```

The default is `console.error`, which is forbidden in `src/`. While the injectable `_pluginErrorSink` pattern is good for testing, the production default should route through the project logger.

**Fix:**
```typescript
export let _pluginErrorSink: (...args: unknown[]) => void = (...args) =>
  getLogger()?.error("plugins", String(args[0]), { detail: args.slice(1) });
```

---

#### ~~SEC-4: Telegram bot token retained in memory after `destroy()`~~ (FALSE POSITIVE)

**File:** `src/interaction/plugins/telegram.ts:66-69`
**Severity:** ~~MEDIUM~~ N/A | **Category:** Security
**Revision:** Nulling `botToken` after `destroy()` is security theater. JS GC handles this — once the object is unreachable after destroy, it's collected. No real attack vector exists here (an attacker with memory read access already has full process access).

---

#### PERF-2: Telegram `receive()` uses short-poll interval (timeout: 1)

**File:** `src/interaction/plugins/telegram.ts:264`
**Severity:** MEDIUM | **Category:** Performance

```typescript
body: JSON.stringify({
  offset: this.lastUpdateId + 1,
  timeout: 1, // 1-second Telegram server-hold — effectively short polling
}),
```

**Fix:** Use Telegram's native long-poll by increasing `timeout` to 30 seconds, reducing unnecessary API calls:
```typescript
timeout: 30, // server-side long polling — holds connection up to 30s
```

---

#### ~~SEC-5: `setTimeout` in signal handler — add justification comment~~ (NIT — NOT A FINDING)

**File:** `src/execution/crash-signals.ts:37`
**Severity:** ~~LOW~~ N/A | **Category:** Convention / Documentation
**Revision:** Requesting a comment is not a security or code quality finding. Removed from findings list.

---

### LOW

---

#### STYLE-1: ~66 non-CLI `console.*` calls in source files (REVISED)

**Severity:** LOW (systemic) | **Category:** Style / Convention
**Revision:** Total 288 `console.*` calls, but **222 are in `src/cli/` and `src/commands/`** — these are intentional CLI-facing output (user-readable TUI). Only ~66 calls in non-CLI source files (`src/agents/`, `src/execution/`, `src/interaction/`, `src/plugins/`) are actual logging violations.

**Fix:** Replace the ~66 non-CLI calls with structured logger. CLI-facing output in `src/cli/` and `src/commands/` is fine as-is.

---

#### ~~STYLE-2: 4.6% test coverage (project requires 80%)~~ (FALSE POSITIVE)

**Severity:** ~~LOW~~ N/A | **Category:** Testing
**Revision:** Original reviewer found only ~15 test files — **actual count is 268 test files** in `test/` with **4,087+ passing tests**. File coverage ratio is ~82% (268/328). The "4.6%" figure was based on an incorrect file count, likely from a bad glob or wrong directory search. This finding is entirely invalid.

---

#### STYLE-3: Unimplemented feature hidden behind TODO

**File:** `src/constitution/generator.ts:60`
**Severity:** LOW | **Category:** Enhancement

```typescript
// TODO: implement section parsing
```

This is a genuine unimplemented feature, not a template placeholder. Track it as a GitHub issue or implement before next release.

---

## Priority Fix Order (Revised)

| Priority | ID | Effort | Description |
|:---|:---|:---:|:---|
| P0 | BUG-1 | S | Fix signal handler leak in crash-signals.ts — store rejectionHandler reference |
| P0 | SEC-1 | S | Use `realpathSync` before containment check in utils/path-security.ts |
| P0 | BUG-2 | S | Replace unsafe cast in lock.ts:64 with `null` sentinel |
| P1 | SEC-3 | S | Thread `permissionMode` into `loadSession()` in spawn-client.ts |
| P1 | BUG-3 | S | Replace Bun.spawn(["rm",...]) with `fs.unlink()` in lock.ts:120 |
| P1 | CONV-1 | M | Add justification comment for Node.js O_EXCL in lock.ts |
| P2 | TYPE-1 | S | Replace `any` in statusWriter and allStoryMetrics with proper types |
| P2 | BUG-4 | S | Replace `Object.assign(options,...)` with spread in runner-completion.ts |
| P2 | CONV-3 | S | Default `_pluginErrorSink` to project logger |
| P3 | PERF-2 | S | Increase Telegram poll timeout from 1 to 30 |
| P3 | STYLE-1 | M | Migrate ~66 non-CLI console.* calls to structured logger |
| — | ~~SEC-2~~ | — | ~~Downgraded to LOW — local config, not a sandbox escape~~ |
| — | ~~PERF-1~~ | — | ~~False positive — setTimeout is correct for cancellable race timeouts~~ |
| — | ~~MEM-1~~ | — | ~~Downgraded to LOW — bounded by session lifetime~~ |
| — | ~~SEC-4~~ | — | ~~False positive — security theater~~ |
| — | ~~SEC-5~~ | — | ~~Not a finding — just a comment request~~ |
| — | ~~STYLE-2~~ | — | ~~False positive — 268 test files, not 15~~ |
| — | ~~CONV-2~~ | — | ~~Deferred — large refactor, tracked separately~~ |

---

## Strengths

- **Dependency injection pattern** (`_deps` / `_runnerDeps`) is consistently applied across all major modules — makes testing straightforward without `mock.module()`.
- **Type hierarchy** (`prd/types.ts`, `agents/types.ts`) is well-designed with discriminated unions and no spurious `any`.
- **Pipeline architecture** is clean — one concern per stage file, thin orchestrator, easily extensible via `IContextProvider` / `IReviewer` / `IReporter`.
- **Error propagation** follows the `[stage] message { cause }` convention across most modules.
- **Barrel imports** are properly enforced — no singleton fragmentation violations found.
- **Immutability** is largely upheld (`BUG-4` is the only observed violation).

---

*Generated by Subrina (AI) — claude-sonnet-4-6 — 2026-03-15*
*Deep review depth applied. Read: crash-signals.ts, lock.ts, pid-registry.ts, spawn-client.ts, adapter.ts, telegram.ts, plugin loader, path-security.ts, runner*.ts, prd/types.ts, agents/types.ts.*
