# Deep Code Review: @nathapp/nax (Revision 2)

**Date:** 2026-08-16 (rev 2 — every finding re-verified line-by-line against source)
**Reviewer:** Subrina (AI)
**Version:** 0.80.0-canary.4 (`3c02dbe9` — unchanged since rev 1; only `docs/20260816-review-nax.md` was added to the working tree)
**Files:** 844 source files (~138,383 LOC src/bin/scripts) + 1,164 test files (~16,868 test/describe call sites)
**Baseline:** `bun run test` full suite; `bun run lint` (Biome + 20+ custom check scripts) enforced in CI

> **Revision note:** Rev 1's 14 top findings were re-verified directly; all 20+ agent-reported LOW/MEDIUM findings were individually re-read and confirmed against current source. Changes vs rev 1: **OTLP-1 downgraded HIGH→MEDIUM** (the normal run path exits naturally — `process.exit(0)` only occurs on bake-off cancel — so the event loop drains detached sends; data loss requires an explicit `process.exit`/kill mid-export), **CTX-8 downgraded MEDIUM→LOW** (string/number `__proto__` assignment is a silent no-op setter call, not global prototype pollution), **OTLP-2 and SEC-1 file paths corrected**, **VER-2 repro snippet corrected**, **BUG-1 annotated** as an in-code documented tradeoff. All other findings confirmed as originally reported.

---

## Overall Grade: B+ (82/100)

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 17/20 | No command injection, HMAC-hardened webhook, extensive redaction — but 3 verified redaction gaps + global fetch patch |
| Reliability | 14/20 | One command-corruption bug on the retry path, two Telegram timeout/hang bugs, checkpoint killed by a 75ms timer |
| API Design | 17/20 | Consistent adapter pattern, discriminated unions, `_deps` DI everywhere |
| Code Quality | 17/20 | Unusually defensive: BUG-* audit annotations, custom check scripts, 16k tests |
| Best Practices | 17/20 | Config layering, permission resolver, structured JSONL logging all disciplined |

No CRITICAL finding. Every spawn is an argv array (no shell interpolation except one documented `@design` trust boundary), the webhook is loopback-only with HMAC + timing-safe compare + body limits. The genuine problems cluster in three places: the **test-command retry path** (VER-1 corrupts commands), the **Telegram interaction plugin** (TEL-1/TEL-2 break it under realistic inputs), and the **context-engine glob/parse layer** (CTX-1 over-matches rule scopes). All findings carry exact file:line proof; each was verified by reading the file during this revision.

---

## Findings

### 🔴 HIGH

#### VER-1: `appendFlag` splits on `|`/`>` inside redirects and quoted strings — corrupts the command on every timeout-retry path
**Severity:** HIGH | **Category:** Bug | **Verified:** ✅ lead review (rev 1 + rev 2)

`src/verification/executor.ts:212-218`

```typescript
function appendFlag(command: string, flag: string): string {
  const pipeIndex = command.search(/[|>]/);
  if (pipeIndex > 0) {
    return `${command.slice(0, pipeIndex).trimEnd()} ${flag} ${command.slice(pipeIndex)}`;
  }
  return `${command} ${flag}`;
}
```

**What's wrong:** The split point is the *first* `|` or `>` anywhere in the string — no quote awareness, and `>` inside `2>&1` is a redirect target, not a start. Verified traces:

```
"bun test 2>&1 | tee out" + --forceExit  → "bun test 2 --forceExit >&1 | tee out"   ❌ (flag injected into redirect)
"bun test -t 'a|b'"      + --forceExit  → "bun test -t 'a --forceExit |b'"         ❌ (unterminated quote)
```

`buildTestCommand` (`executor.ts:223-249`) runs this on **every timeout retry** (`timeoutRetryCount > 0`) or when `forceExit` is configured — and `2>&1 | tee` / `-t 'pattern'` are extremely common test-command shapes.
**Risk:** The diagnostic retry path — the exact path meant to rescue a hung/failed run — executes a corrupted command: silent wrong behavior or loud shell errors, wasted rectification cycles, misleading findings. First-run commands are unaffected (injection only on retry), which is why this is not CRITICAL.
**Fix:** Find the first `|`/`>` *outside* quotes and outside `2>&1`/`2>file` redirect tails; or append token-aligned (before first pipe token, else before first word-boundary `>`). Add unit tests for `2>&1 | tee`, `> log 2>&1`, `-t 'a|b'`.

---

#### TEL-1: Timeout-path fetch has no timeout — the Telegram `receive()` deadline is defeated by a hung network
**Severity:** HIGH | **Category:** Bug | **Verified:** ✅ lead review

`src/interaction/plugins/telegram.ts:292-295` + `531-556`

```typescript
private async expireReceiver(requestId: string): Promise<void> {
    await this.sendTimeoutMessage(requestId);       // ← awaited before resolving
    this.resolveReceiver(requestId, "skip", "timeout");
}
...
private async sendTimeoutMessage(requestId: string): Promise<void> {
    ...
    await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
      method: "POST", ...                          // ← no AbortController / signal
```

**What's wrong:** Every other Telegram call uses `AbortController` + `CALLBACK_API_TIMEOUT_MS` (e.g. `getUpdates` at `telegram.ts:335-352`). `sendTimeoutMessage` is the only outbound fetch with no timeout — and it runs *on the timeout path itself*: when the 60s `receive()` timer fires, `expireReceiver` awaits the hung fetch before resolving the pending receiver. A stalled connection to `api.telegram.org` delays the interaction resolution — and thus the story's fallback action — far beyond the configured timeout.
**Risk:** The run hangs on the timeout path exactly when the network is unhealthy; `cancel()` has the same structure.
**Fix:** Reuse the AbortController + `CALLBACK_API_TIMEOUT_MS` pattern; resolve the receiver first, then best-effort the edit.

---

#### TEL-2: `buildHeader` bypasses Markdown sanitization — feature names with `_`/`*` break the entire send
**Severity:** HIGH | **Category:** Bug | **Verified:** ✅ lead review (impact confirmed by in-code comment `telegram.ts:157`: send() has no fallback — "throwing here aborts the run")

`src/interaction/plugins/telegram-format.ts:99-108` (vs `116-128`)

```typescript
export function buildHeader(request: InteractionRequest): string {
  const emoji = getStageEmoji(request.stage);
  let text = `${emoji} *${request.stage.toUpperCase()}*\n`;
  text += `*Feature:* ${request.featureName}\n`;      // ← RAW, not sanitized
  if (request.storyId) { text += `*Story:* ${request.storyId}\n`; }
```

**What's wrong:** `buildBody` deliberately runs `sanitizeMarkdown` on every variable field, and `send()` posts with `parse_mode: "Markdown"` (`telegram.ts:189`). The header interpolates `featureName`/`storyId` raw. Legacy Telegram Markdown rejects an unclosed `_` (italic) with a 400 — and feature names like `webhook_hmac` or `US-007_telegram` are routine.
**Risk:** `send()` throws → no fallback on `send()` (in-code comment `telegram.ts:157`) → the story aborts. `plugins/builtin/nax-finish/telegram.ts:74-82` explicitly avoids `parse_mode` for exactly this reason — the two Telegram clients disagree.
**Fix:** Run `featureName`/`storyId` through `sanitizeMarkdown()` in `buildHeader`, or drop `parse_mode` (plain text, as nax-finish does).

---

#### CTX-1: `globToRegex` eats the `/` before `**` — rule scopes over-match outside their declared glob
**Severity:** HIGH | **Category:** Bug | **Verified:** ✅ lead review + executed (rev 1 + rev 2)

`src/context/engine/providers/static-rules.ts:118-128`

```typescript
if (beforeSlash && afterSlash) {
  regex = `${regex.slice(0, -1)}(?:.*\\/)?`;   // ← removes the accumulated "/" from "src/" and makes it optional
  i += 3;
}
```

**Proof (executed):** `globToRegex("src/**/*.ts")` → `(?:^|\/)src(?:.*\/)?[^/]*\.ts$`:

```
src/foo.ts   -> true  (correct)
src/a/b.ts   -> true  (correct)
srcfoo.ts    -> true  (WRONG — should not match)
srcfoo/a.ts  -> true  (WRONG — should not match)
```

**Risk:** This backs the scope filters `ruleMatchesScopeFiles` (`appliesTo:`), `ruleMatchesPackage` (`paths:`), and `pathMatchesScope` (effectiveness annotator). A rule declared `paths: ["packages/api/**"]` silently applies to neighbouring packages; scope attribution mislabels chunk scope paths. `pathMatchesScope` has no `${rel}/` retest, so it disagrees with `ruleMatchesPackage` on the same glob.
**Fix:** Keep the slash: `regex = `${regex}(?:.*\\/)?``. Add unit tests for `src/**/*.ts` vs `srcfoo.ts`.

---

### 🟡 MEDIUM

#### LOG-1: Redaction misses `github_pat_` tokens, Telegram bot tokens, and pure-alphabetic Basic creds
**Severity:** MEDIUM | **Category:** Security | **Verified:** ✅ lead review

`src/logger/redact.ts:21-53`

```typescript
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[opsu]_[A-Za-z0-9]{16,}/g,                       // ← gho_/ghp_/ghs_/ghu_ only — NOT github_pat_
  ...
  /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9\-._~+/]*[0-9+/_-])[A-Za-z0-9\-._~+/]{8,}={0,2}/gi,  // lookahead requires digit/symbol
```

Three verified gaps:
1. GitHub fine-grained PATs (`github_pat_<22>_<59>`): `gh[opsu]_` requires `gh`+`[opsu]`+`_` — `github_pat_` starts `gh`+`i`, never matches.
2. Telegram bot tokens (`123456789:AAH...~35 chars`): no `\d+:[A-Za-z0-9_-]{30,}` pattern; tokens in free text leak.
3. `Basic dXNlcjpwYXNz` (`user:pass` base64, pure alphabetic) fails the `[0-9+/_-]` lookahead and leaks verbatim.

**Risk:** Secrets land in the JSONL file, the terminal, and — since redaction runs before OTLP dispatch — get exported to the telemetry collector.
**Fix:** Add `/github_pat_[A-Za-z0-9_]{20,}/g`, `/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g`, and base64-validate Basic values instead of requiring a digit.

---

#### EXEC-1: Final run status written as `"running"` after the run has stopped
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review

`src/execution/lifecycle/run-completion.ts:544-554`

```typescript
statusWriter.setRunStatus(
  regressionGateFailed
    ? "failed"
    : exitReason === "cost-limit"
      ? "cost-limit"
      : isComplete(prd)
        ? "completed"
        : isStalled(prd, config.execution.rectification?.maxAttemptsTotal)
          ? "stalled"
          : "running",            // ← fallback: run is over, status says it is live
);
```

**What's wrong:** When the run stops with pending stories that are *not* stalled — `exitReason` `"pre-merge-aborted"` (declined pre-merge trigger), `"max-iterations"`, `"no-stories"` — the machine-readable `status.json` says `"running"` with the run's own PID.
**Risk:** The TUI shows the run as live forever; external supervisors keyed on `status.json` wait on a finished run; resume tooling misreads state. Reachable with a single declined pre-merge prompt and any pending story.
**Fix:** Map remaining exit reasons to a terminal status (add `"aborted"` to the `NaxStatusFile` union in `src/execution/status-file.ts:77`); the `"running"` fallback should be unreachable.

---

#### EXEC-3: Queue `.processing` unlink failure swallowed silently — re-apply invariant broken
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review

`src/execution/queue-handler.ts:149-151`

```typescript
const result = await processor(commands);
await unlink(processingPath).catch(() => {});    // ← failure invisible
return result;
```

**What's wrong:** The module's own docstring (BUG-11) states the point of `processQueueFile` is that a crash after processing but before clearing must not re-apply commands. An unlink failure (permission, transient FS error, AV lock) is silently swallowed — no log, no error. The next run's `claimCommandsLocked` finds `.queue.txt.processing` and **re-applies the batch**: `INJECT` stories duplicated, `ABORT`/`SKIP` re-marked.
**Risk:** Exactly the double-apply class BUG-11 was built to eliminate, on a rare-but-real failure mode, with zero trace in logs.
**Fix:** Log a warn (or throw and leave the lock held so a retry is safe) on unlink failure.

---

#### CFG-1: Per-package config guard omits `rejectUnimplementedPermissionsBlock` — `execution.permissions` silently stripped
**Severity:** MEDIUM | **Category:** Config / security-intent | **Verified:** ✅ lead review

`src/config/loader.ts:376-379` (per-package chain) vs `loader.ts:228` (root chain)

```typescript
// loadConfigForWorkdir (per-package) — 4 of 5 guards
rejectLegacyAgentKeys(rawMerged);
rejectLegacyRectificationKeys(rawMerged);
rejectDeadQualityFlags(rawMerged);
rejectUnimplementedScopedProfile(rawMerged);
// root chain (loader.ts:228) additionally calls: rejectUnimplementedPermissionsBlock(rawConfig)
```

**What's wrong:** The root chain rejects `execution.permissions` with `CONFIG_PERMISSIONS_BLOCK_UNIMPLEMENTED` (`config-guards.ts:310-322`) because nothing reads it. The per-package chain skips this guard, and `mergePackageConfig` spreads `...packageOverride.execution` wholesale (`merge.ts:87-89`) — so `.nax/mono/<pkg>/config.json` with `execution.permissions` flows through and is **silently dropped by Zod `.strip()`**.
**Risk:** A user writing a per-stage permission policy for a package gets no error and no enforcement — silent security-intent loss.
**Fix:** Add `rejectUnimplementedPermissionsBlock(rawMerged)` to the per-package guard block.

---

#### CFG-2 / CFG-3: `$VAR` env interpolation applies only to root profiles — project/global config and package profiles keep literal `$VAR`
**Severity:** MEDIUM | **Category:** Config | **Verified:** ✅ lead review

`src/config/loader.ts:145-184` (only `resolveEnvVars` call site in the load path) vs `361-369` (package profile loop)

```typescript
// root profile chain: resolves $VAR against the profile's companion .env, throws UnresolvedEnvVarError
for (const name of overlayChain) { ... resolveEnvVars(profileData, profileEnv) ... }

// per-package profile chain: loadProfile() but NO loadProfileEnv() / resolveEnvVars()
for (const name of packageChain) {
  const profileData = await loadProfile(name, packageRoot);
  rawMerged = deepMergeConfig(rawMerged, profileData);
}
```

**What's wrong:** (CFG-2) Global and project layers (`loader.ts:114-140`) never run through `resolveEnvVars` — a user writing `"test": "$TEST_CMD"` in `.nax/config.json` gets the literal string executed. (CFG-3) The per-package profile chain never resolves env either — same silent no-substitution on the monorepo path, while the same file at root level either resolves or fails loudly.
**Risk:** Silent misconfiguration; `$`-prefixed values land verbatim in shell commands / model strings.
**Fix:** Run `resolveEnvVars` over the merged config (and package-profile overlays) with the same SENSITIVE-filtered env map; warn on any `$VAR` remnant.

---

#### CFG-4: `parseDotenv` violates its own "Strips comments" contract and mis-parses standard forms
**Severity:** MEDIUM | **Category:** Config | **Verified:** ✅ lead review

`src/config/dotenv.ts:16-34`

```typescript
const eqIndex = stripped.indexOf("=");
...
let value = stripped.slice(eqIndex + 1).trim();
if ((value.startsWith('"') && value.endsWith('"')) || ...) {
  value = value.slice(1, -1);
}
```

Empirically verified:
- `FOO=bar # comment` → value `"bar # comment"` (inline comment baked in, despite docstring "Strips comments" at line 9)
- `export "FOO=bar"` → key `"FOO`, value `bar"`
- `FOO="a\"b"` → `a\"b` (escapes never unescaped)
- CFG-5 (LOW): `${VAR}` brace form silently passes through unsubstituted (`resolveString` at dotenv.ts:86-96 only handles bare `$IDENT`)

**Risk:** Profile `.env` values silently differ from what the author wrote — and the comment case can leak a human-readable annotation into substituted secrets/commands.
**Fix:** Implement minimal dotenv semantics: strip `# ...` outside quotes, handle `export "KEY=value"`, unescape `\"`/`\\`/`\n` in quoted values, `KEY=` → `""`, and support `${VAR}`.

---

#### VER-2: `buildSmartTestCommand` splits the base command on whitespace — quoted base commands produce corrupt commands
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review

`src/verification/smart-runner.ts:356-389`

```typescript
const parts = baseCommand.trim().split(/\s+/);
...
// Find the last token that looks like a path (contains '/') ...
let lastPathIndex = -1;
for (let i = parts.length - 1; i >= 0; i--) { ... }
const newParts = [...beforePath, ...quotedTestFiles, ...afterPath];
return newParts.join(" ");
```

Verified trace: base `bun test "test dir/"` → parts `["bun","test","\"test","dir/\""]`; the path-like token `"test` is replaced → `bun test 'a.test.ts' 'b.test.ts' dir/"` — unterminated double-quote. `quality/runner.ts:112-113` even documents that whitespace splitting loses quoted args — yet this function does exactly that when replacing a path argument (append-only cases are fine).
**Risk:** Smart-runner scoping on any repo with spaces in test paths yields a shell syntax error; wasteful full-suite fallback (`verify-scoped.ts:219-231`).
**Fix:** Quote-aware tokenization (small shell-word splitter), or replace only path-like tokens on quote-safe tokens. Add regression tests for `"test dir/"` and `--config "./vitest config.ts"`.

---

#### VER-4: 75 ms git tree-capture deadline SIGKILLs legitimately-slow git; timer never cleared on the happy path
**Severity:** MEDIUM | **Category:** Bug / reliability | **Verified:** ✅ lead review

`src/execution/checkpoint/resume-hydrate.ts:22,39-61`

```typescript
const TREE_CAPTURE_TIMEOUT_MS = 75;                    // line 22

async function spawnWithTimeout(proc: SpawnedProc, timeoutMs: number) {
  const result = await Promise.race([
    (async () => { ... proc.exited ... })(),
    new Promise((resolve) => setTimeout(() => { proc.kill("SIGKILL"); resolve({ stdout: "", exitCode: 1 }); }, timeoutMs)),
  ]);                                                    // ← losing timer never cleared
```

**What's wrong:** (1) The timer is never cleared when git wins the race — it later SIGKILLs an already-exited pid and holds the event loop. (2) 75 ms is the budget for *each* of `git status --porcelain` + `git diff` + `git diff --cached` + `hash-object`; on cold page cache, large monorepos, or network-mounted repos, a slow-but-healthy git gets SIGKILLed and the capture fails → `captureFailureSentinel()` (lines 72-74) makes the tree never equal any checkpoint → **`nax resume` silently re-runs everything**.
**Risk:** The checkpoint/resume feature degrades to a no-op on exactly the large repos it was built for (fail-safe direction — never skips work — which is why this is MEDIUM).
**Fix:** Clear the timer in the race's `.finally()`; raise the budget to ~1-2 s or make it configurable.

---

#### OTLP-1: `flushNow()` is fire-and-forget — final span/log batches can be dropped on hard exit
**Severity:** MEDIUM (rev 2: downgraded from HIGH) | **Category:** Reliability | **Verified:** ✅ lead review

`src/plugins/builtin/otel-reporter/batch-queue.ts:60-70` + `index.ts:475-484`

```typescript
// design comment: flushNow() resolves once the batch is dequeued, not once the network send settles
const doFlush = (): Promise<void> => {
  if (tornDown || queue.length === 0) return Promise.resolve();
  const batch = queue;
  queue = [];
  void sendWithRetry(batch);          // ← detached; never tracked, never awaited
  return Promise.resolve();
};
```
```typescript
// index.ts:475-484 — teardown path treats flushNow() as a real flush
await st.spanQueue.flushNow();
st.spanQueue.teardown();
```

**What's wrong:** `onRunEnd`/`teardown` `await flushNow()` and then proceed, but the in-flight `sendWithRetry` (up to 5s of retries) is detached with `void`. Rev-2 finding: on the **normal** run path the CLI exits naturally (`process.exit(0)` in `bin/nax.ts` is bake-off-cancel only), so the event loop drains in-flight network I/O and data usually ships — but any explicit `process.exit(1)` on an error path, or a process kill mid-export, drops the final batches, and send failures are unobservable.
**Risk:** Silent telemetry loss of run-end spans/logs under hard exit; the "flush on crash/exit" guarantee is illusory.
**Fix:** Track the in-flight send promise and have `flushNow()`/`teardown()` await it within the existing `timeoutMs` cap.

---

#### WEB-1: Compat shim monkey-patches `globalThis.fetch` — shadows every in-process localhost fetch
**Severity:** MEDIUM | **Category:** Security | **Verified:** ✅ lead review

`src/interaction/plugins/webhook-serve-compat.ts:88-102`

```typescript
globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(...);
    const url = new URL(request.url);
    const port = Number.parseInt(url.port, 10);
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && inMemoryServers.has(port)) {
      return await server.fetch(request);    // any code, any URL on that port
    }
    return originalFetch(...);
}) as typeof globalThis.fetch;
```

**What's wrong:** Once installed, *every* `fetch()` in the process — plugins, libraries, the OTLP exporter pointed at `localhost:4318` — is routed through this interceptor, matched on **port only**. The compat port space is 40_000-59_999 — exactly where users run dev servers. A real service on a registered port is silently shadowed; unrelated code fetching nax's own in-memory ports receives arbitrary webhook responses. `@design`: the shim exists for sandboxed environments where `Bun.serve` fails; the hazard is that it is process-global.
**Fix:** Scope interception to the exact advertised `callbackUrl` (match port **and** path prefix `/nax/interact/`), or use a private module-scoped fetch for the webhook plugin's own calls.

---

#### EXEC-2: Crash handlers leak when lock acquisition fails
**Severity:** MEDIUM | **Category:** Resource leak | **Verified:** ✅ lead review (rev 2)

`src/execution/lifecycle/run-setup.ts:262-284, 367-376` + `src/execution/runner.ts:218-223`

```typescript
const cleanupCrashHandlers = installCrashHandlers({ statusWriter, ... });   // line 262
...
// Acquire lock to prevent concurrent execution
const lockAcquired = await acquireLock(workdir);                            // line 367
if (!lockAcquired) {
  ...
  throw new LockAcquisitionError(workdir);                                  // line 371 — BEFORE try at line 376
}
// Everything after lock acquisition is wrapped in try-catch ... (cleanupCrashHandlers in finally at line 485)
```

**What's wrong:** `installCrashHandlers` runs *before* `acquireLock`. The `LockAcquisitionError` is thrown at line 371 — before the try/finally (line 376 → finally at 485) that calls `cleanupCrashHandlers`. The SIGTERM/SIGINT/uncaughtException/unhandledRejection handlers stay installed, bound to a `StatusWriter` for a run that never started.
**Risk:** In in-process consumers (tests, watch mode, embedded TUI), a later signal or uncaught exception writes a bogus "crashed" status and runs `performTeardown` + `pidRegistry.killAll()` for a nonexistent run.
**Fix:** Acquire the lock before installing handlers, or thread cleanup through the error path.

---

#### EXEC-9: Checkpoint `recordGreen` failure fails the story on an infra error
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review (rev 2)

`src/execution/story-orchestrator/execution-plan.ts:130-168` + `src/execution/checkpoint/writer.ts:91-99`

```typescript
try {
  await runPhase(this.ctx, phase.slot, ...);       // ← inside try/catch
} catch (error) { ... throw error; }
if (!phasePassed(...)) { break; }
...
} else {
  const currentTree = await _storyOrchestratorDeps.captureTreeState(this.ctx.packageDir);
  await _storyOrchestratorDeps.recordGreen(this.ctx.storyId, name, currentTree);   // ← line 167: OUTSIDE the try
}
```

**What's wrong:** `recordGreen` sits outside the per-phase try/catch and the writer deliberately rethrows `CHECKPOINT_WRITE_FAILED` (disk full, permission) as a NaxError. The checkpoint-write failure therefore surfaces as a pipeline-stage exception → story marked failed/escalated even though the phase genuinely passed.
**Risk:** Disk-full during a long run escalates stories through paid tiers for an infra error a warn + skip-resume would survive.
**Fix:** Swallow-and-warn at the call site (story verdict is the SSOT), or document the tradeoff.

---

#### CLI-1: `runSetupGate` has no timeout and splits the test command on whitespace
**Severity:** MEDIUM | **Category:** Bug / reliability | **Verified:** ✅ lead review (rev 2)

`src/cli/setup-verify.ts:25-28`

```typescript
const parts = testCmd.trim().split(/\s+/).filter(Boolean) as [string, ...string[]];
const proc = _setupVerifyDeps.spawn(parts, { cwd: workdir });
return await proc.exited;                       // ← no timeout
```

**What's wrong:** (1) `await proc.exited` with no deadline — a hung `quality.commands.test` hangs `nax setup` forever, unlike every other runner in the codebase. (2) Whitespace split without a shell breaks quoted commands (`bun test "test dir/"`) — same anti-pattern as VER-2.
**Fix:** Reuse `runQualityCommand`/`executeWithTimeout` (timeouts, process groups, env stripping).

---

#### CTX-2: Canonical rules + test coverage re-read/re-linted/re-scanned on every stage assembly
**Severity:** MEDIUM | **Category:** Performance | **Verified:** ✅ lead review (rev 2)

`src/context/engine/providers/static-rules.ts:256`, `orchestrator-factory.ts:52-59`, `providers/test-coverage.ts:74-97`

**What's wrong:** `loadCanonicalRules` re-globs `.nax/rules/**/*.md`, re-reads every file, and re-runs the per-line neutrality lint — per `fetch()` (confirmed at static-rules.ts:256 inside `fetch`). `createDefaultOrchestrator` builds a fresh provider per `assemble()`, and assembly happens for the context stage plus execution/rectify/tdd/review stages (~6-8 per story). Rules are immutable within a run; this is pure repeat I/O. `TestCoverageProvider` likewise re-globs+re-scans on every assembly.
**Risk:** Real wall-clock cost on large rules stores and test corpora, multiplied by N stories.
**Fix:** Memoize canonical rules per (repoRoot, packageDir) for the run; cache the test-coverage scan keyed by packageDir + touched files.

---

#### CTX-3: Whole scratch.jsonl read + parse on every fetch; file grows unbounded during a run
**Severity:** MEDIUM | **Category:** Performance | **Verified:** ✅ lead review (rev 2)

`src/context/engine/providers/session-scratch.ts:128-129`, `providers/tool-diagnostics.ts:95-96`, `handlers/query-scratch.ts:162-164`

**What's wrong:** `scratch.jsonl` is append-only and grows with every verify/rectify/TDD/lint result for the whole run. Each `fetch()` reads and JSON-parses the *entire* file (twice per assembly — once per provider). `MAX_ENTRIES_PER_DIR = 20` caps only the render/truncation, not the parse.
**Risk:** Per-assembly cost grows linearly with run progress; on long rectification loops this dominates provider I/O.
**Fix:** Tail-read (last ~64 KB, tolerate a torn first line) and/or cache by path+mtime with incremental parse offset.

---

#### CTX-4: `ToolDiagnosticsProvider` chunk is unbounded — no entry or token cap
**Severity:** MEDIUM | **Category:** Performance | **Verified:** ✅ lead review (rev 2)

`src/context/engine/providers/tool-diagnostics.ts:95-102`

```typescript
const entries = parseToolDiagnosticsJsonl(raw);
if (entries.length === 0) return null;
const content = renderEntries(entries);        // ← ALL entries ever recorded
```

**What's wrong:** The sibling `SessionScratchProvider` caps at 20 entries / 500 tokens; ToolDiagnostics renders *every* `tool-diagnostics` entry ever recorded into one `diagnostics` chunk. A story that fails lint/typecheck repeatedly accumulates dozens of full diagnostic blocks.
**Risk:** One chunk balloons past every per-chunk token ceiling other providers honour, crowding the budget with repeated identical errors.
**Fix:** Mirror session-scratch: most-recent-N entries + char/token cap, ideally deduping identical diagnostics.

---

#### CTX-5: Digest ordering uses `localeCompare` — AC-24 byte-identical determinism broken across locales/ICU versions
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review (rev 2)

`src/context/engine/digest.ts:71-75`

```typescript
const sorted = [...chunks].sort((a, b) => {
  const scopeDiff = (scopeRank[a.scope] ?? 99) - (scopeRank[b.scope] ?? 99);
  return scopeDiff !== 0 ? scopeDiff : a.id.localeCompare(b.id);   // line 74
});
```

**What's wrong:** The digest contract (digest.ts:8-11) and AC-24 demand byte-identical output across runs; `localeCompare` with default locale/ICU is not byte-stable across machines (chunk IDs mix case and `-`/`:` punctuation: `feature-fragment:US-001` vs `feature-context:...`).
**Risk:** Same id set on two machines → different digest bytes → different prompts, breaking the determinism the digest/dedup design rests on.
**Fix:** Code-point comparison: `a.id < b.id ? -1 : a.id > b.id ? 1 : 0`. Same fix for `static-rules.ts:288`.

---

#### CTX-6: No in-flight dedup in per-run caches; stale re-population after `invalidate()`
**Severity:** MEDIUM | **Category:** Race condition | **Verified:** ✅ lead review (rev 2)

`src/context/engine/providers/plugin-cache.ts:97-114`, `provider-weights-cache.ts:28-36`

```typescript
// plugin-cache.ts — no in-flight dedup: both parallel callers miss and both load+init
const hit = this.cache.get(key);
if (hit) return hit;
const providers = await _pluginCacheDeps.loadProviders(enabled, workdir);
this.cache.set(key, providers);
```

**What's wrong:** (1) The plugin cache claims "Concurrency-safe" but nothing guards the first-load race — parallel stories both miss, both `loadProviders` → plugin `init()` runs twice with duplicated side effects, last-writer-wins. (2) The weights cache: `assembleForStage` writes a manifest then `invalidate(featureId)` (`stage-assembler.ts:280-281`); a parallel story's load that started before the invalidate but resolves after re-`set`s the cache — repopulating stale weights (excluding the fresh manifest) for the rest of the run. Both require parallel stories to trigger.
**Fix:** Memoize the in-flight promise (`Map<string, Promise<…>>`); add a generation counter checked before `cache.set` after `invalidate()`.

---

#### CTX-7: Auto-detect hardcodes top-level `src/` pathspec — silently no-ops in `lib/`, `app/`, monorepo layouts
**Severity:** MEDIUM | **Category:** Bug | **Verified:** ✅ lead review (rev 2)

`src/context/auto-detect.ts:134-146`

```typescript
const grepCommand = ["git", "grep", "-i", "-l", "-I", "-E", "-e", grepPattern, "--", "src/"];
```

**What's wrong:** The git pathspec `src/` matches only the **top-level** `src/` directory; monorepos (`packages/*/src/`) and `lib/`/`app/` layouts get zero matches, and `autoDetectContextFiles` returns `[]` with no fallback. `git grep` also cannot see untracked files. Runs only when the PRD omits `contextFiles`, so the failure is silent.
**Fix:** Drop the pathspec and filter results (exclude `node_modules/`, `.git/`, `.nax/`), or pass per-package source-root pathspecs.

---

### 🟢 LOW

#### CTX-8: Prototype-pollution guards applied to one of five manifest maps (rev 2: downgraded, mechanics corrected)
**Severity:** LOW | **Category:** Correctness (defense-in-depth) | **Verified:** ✅ lead review (rev 2)

`src/context/engine/manifest-builder.ts:62-93`

```typescript
const chunkSummaries: Record<string, string> = {};      // plain {}
const chunkScopePaths: Record<string, string[]> = {};   // plain {}
...
const chunkProviders: Record<string, string> = Object.create(null);   // the ONLY guard (line 82)
```

**What's wrong:** Only `chunkProviders` is null-prototyped although the US-003 comment establishes "chunk IDs are not trusted input". Rev-2 correction: for the string/number maps, `chunkSummaries["__proto__"] = "x"` invokes the `Object.prototype.__proto__` setter, which silently **no-ops for string/number values** — the key is lost (silent data drop) but Object.prototype is **not** polluted. The only object-value map (`chunkScopePaths["__proto__"] = [...]`) does swap that object's local `[[Prototype]]` to the array — local corruption, again not global pollution. Realistic trigger: a chunk literally named `__proto__` (derivable from git paths/rule fileNames).
**Risk:** Silent loss of summary/token/score/scope attribution for such chunk IDs + local prototype swap on the scopePaths map.
**Fix:** Use `Object.create(null)` (or `Object.fromEntries`) for all five maps.

#### OTLP-2: Endpoint URL (with creds) logged on failure (rev 2: path corrected)
**Severity:** LOW | **Category:** Security | **Verified:** ✅ lead review

`src/plugins/builtin/reporter-shared/post-json.ts:32,37` (shared by otel-reporter and webhook-reporter; rev 1 reported a non-existent `otel-reporter/post-json.ts`)

```typescript
if (!res.ok) {
  logger?.warn(opts.stage, "Telemetry POST returned non-2xx", { url, status: res.status });   // line 32
  return false;
}
...
logger?.warn(opts.stage, "Telemetry POST failed", { url, error: errorMessage(err) });        // line 37
```

**What's wrong:** An endpoint like `https://user:pass@collector:4318` (or with a token in the path/query) lands verbatim in the JSONL file on failure. `redact.ts` has no URL-userinfo pattern. Headers are never logged (docstring claim holds) — the URL is the leak.
**Fix:** Strip credentials from the logged URL (`new URL(url)` → drop `username`/`password`).

#### SEC-1: Weak request-id entropy in the interaction bridge (rev 2: path corrected)
**Severity:** LOW | **Category:** Security | **Verified:** ✅ lead review

`src/interaction/bridge-builder.ts:55` (rev 1 reported a non-existent `interaction-bridge.ts`)

```typescript
const requestId = `ix-${context.stage}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
```

**What's wrong:** `Math.random()` (not CSPRNG) for request ids while `triggers.ts:93` uses `crypto.randomUUID()`; the registered-ID gate (`webhook.ts:391`) is the last line of defense when `requireSecret: false`. Unify on `crypto.randomUUID()`.

#### OTLP-3: Batch retry with no backoff
**Severity:** LOW | **Category:** Reliability | **Verified:** ✅ lead review — `batch-queue.ts:49-58` retries immediately; a saturated collector (429/5xx) is hit repeatedly back-to-back. Add jittered delay.

#### SINK-1: SinkRegistry "shallow clone" — nested `data` mutation leaks to the JSONL file
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `sink-registry.ts:36-43` `sink({ ...entry })` shares the `data` object, though the comment claims the clone prevents mutation leaks; a mutating sink can rewrite redacted data back into the on-disk log. Clone `data` too.

#### MEM-1: Logger write path grows O(N) promises + buffer per log call in a burst
**Severity:** LOW | **Category:** Memory | **Verified:** ✅ lead review — `logger.ts:208-226` every `writeToFile` pushes to `pendingLines` **and** chains a new `.then` onto `writeQueueTail`; the chain grows by one link per call until microtasks drain. Transient O(burst) memory; single-flight flag fixes it.

#### ACP-1: Unbounded `state.text` accumulation in the parser
**Severity:** LOW | **Category:** Memory | **Verified:** ✅ lead review — `agents/acp/parser.ts:134-135` `state.text += text` per `agent_message_chunk` has no total cap (the 10MB cap in stdout-line-reader bounds one line's remainder, not accumulated output). Cap accumulated text.

#### TEL-3: Callback `action` unvalidated against the enum
**Severity:** LOW | **Category:** Security | **Verified:** ✅ lead review — `telegram.ts:422` `const action = parts[1] as InteractionResponse["action"]`; any string flows into `applyFallback` and compares false — behaves as "continue" in gates like `checkPreMerge`. Use `z.enum([...]).safeParse`.

#### PLG-1: Auto-discovery + dynamic `import()` of every `.ts` in plugin dirs (untrusted code execution)
**Severity:** LOW (rev 2: MEDIUM→LOW — plugin execution is the plugin system's contract, explicitly designed; the gap is absence of user-visible loading notice) | **Category:** Security / supply chain | **Verified:** ✅ lead review

`src/plugins/loader.ts:317-360, 434` + `run-setup.ts:404-406`

```typescript
const imported = await import(modulePath);   // line 434 — full code execution
```

Every run scans `~/.nax/plugins/` **and** `<workdir>/.nax/plugins/` and dynamically imports all `.ts/.js/.mjs` found with full user privileges. A checked-in plugin dir in a cloned repo runs arbitrary code on first `nax run` with zero prompt. `@design`: dynamic plugin import is inherent to the plugin system (plugins are code by contract) — but log a prominent warning with the source path when loading project-dir plugins, and consider `plugins.allowProjectPlugins: false` default.

#### TDDF-1: `coerceVerdict` inverts pass/fail counts for "N/M FAIL" strings
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `tdd/verdict-reader.ts:113-118` `"42/45 FAIL"` parses as passCount=42/failCount=3; the in-code comment only documents the PASS shape, so the FAIL branch is mis-handled. Verdict stays correct (`allPassing` false) — only error messages report wrong counts. Parse `(pass|fail)` and assign accordingly.

#### TDDF-2: `getAddedLinesPerFile` never drains stderr and ignores the exit code
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `tdd/isolation.ts:103-119` reads stdout then awaits exit; stderr never drained (a git failure emitting >64KB deadlocks on the full pipe) and non-zero exits treated as empty map. Fail-safe direction (missing entries → hard-violation), but a hang is possible. Drain stdout+stderr concurrently and check the exit code.

#### WK-1: Rebase target branch name passed unvalidated to `git rebase`
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `worktree/merge.ts:349` `spawn(["git", "rebase", currentBranch])`; no shell (argv array, no injection), but a branch name starting with `-` is parsed as an option. Refname regex guard `/^[A-Za-z0-9/._-]+$/`.

#### TIM-1: `withProcessTimeout` is dead code with an inconsistent hard-deadline kill
**Severity:** LOW | **Category:** Dead code | **Verified:** ✅ lead review — `execution/timeout-handler.ts:40,84-94`; grep confirms **zero call sites** outside the module. Hard-deadline path uses raw `process.kill(-pid, "SIGKILL")` while siblings use `killProcessGroup`. Delete or align.

#### EXEC-4: Documented `--parallel 0` "auto-detect" is dead code that would hang if wired
**Severity:** LOW | **Category:** Latent bug | **Verified:** ✅ lead review — `runner.ts:82`, `unified-executor.ts:253` (`(ctx.parallelCount ?? 0) > 0` gate), `parallel-worker.ts:226-228` (`while (executing.size >= maxConcurrency) await Promise.race(executing)` — hangs forever on an empty set if `maxConcurrency` is 0). Currently unreachable; implement or remove the contract, add `if (maxConcurrency < 1) throw`.

#### EXEC-5: `PidRegistry.killAll()` doesn't await the coalesced follow-up write
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `pid-registry.ts:167-175, 449-470`; `enqueueWrite()` returns the in-flight tail and only schedules the follow-up (which persists the cleared state) without awaiting it. On fast process exit after `killAll()`, `.nax-pids` can still list killed PIDs (mitigated by `cleanupStale()` at next startup).

#### EXEC-6: `spawnWithTimeout` timers never cleared on the fast path
**Severity:** LOW | **Category:** Timer hygiene | **Verified:** ✅ lead review — `checkpoint/resume-hydrate.ts:39-61`; losing `setTimeout` never cleared → orphaned 75-250ms timers per git call (same file as VER-4; both fixed by a race-with-clearTimeout pattern like `verification/executor.ts:23-29`).

#### EXEC-7: `spawnGitWithDeadline` has no deadline on `proc.exited` itself
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `deferred-review.ts:39-58`; timer kills but `await proc.exited` is unbounded — a child that ignores SIGKILL (D-state on hung NFS) stalls the run. Race `proc.exited` against the timer like `boundedProcRead`.

#### EXEC-8: `startHeartbeat()` doesn't abort the previous loop's in-flight sleep
**Severity:** LOW | **Category:** Timer hygiene | **Verified:** ✅ lead review — `crash-heartbeat.ts:90-96`; the old `AbortController` is replaced without aborting — a stale loop keeps its 60s `cancellableDelay` sleeping (generation check only fires when it wakes). Abort the old controller in `startHeartbeat()`.

#### BUG-1: `checkStaleLock` treats a recycled PID as a live holder — run blocked indefinitely
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `precheck/checks-config.ts:43-46`; `holderAlive || ageMs < twoHoursMs` — a crashed holder whose PID was reused blocks `nax run` forever. Note: the in-code comment explicitly documents this tradeoff (PID-live is treated as authoritative to survive NTP/sleep skew) — but the backstop was designed for exactly this case and the live check defeats it. Require PID-live AND recent timestamp, or verify the PID's command line.

#### BUG-2: `nax migrate` partial move on mid-loop conflict — idempotency contract broken
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `commands/migrate.ts:251-289`; the per-candidate conflict check throws after earlier candidates were already renamed; a re-run can neither continue nor report. Two-phase: pre-check all destinations first.

#### SEC-2: Symlink management shells out to `rm`/`ln` instead of native fs
**Severity:** LOW | **Category:** Hygiene | **Verified:** ✅ lead review — `bin/nax.ts:813-818`; PATH-resolved external binaries for trivial fs ops (argv arrays, no user data — but Windows-incompatible and PATH-tamperable). Use `Bun.write`/`unlinkSync`/`Bun.symlink`.

#### CFG-5: `${VAR}` / `$${VAR}` brace forms silently unresolved
**Severity:** LOW | **Category:** Config | **Verified:** ✅ lead review — `dotenv.ts:86-96` `resolveString` only handles bare `$IDENT`; `${FOO}` passes through literally. Support the brace form or throw `UnresolvedEnvVarError`.

#### CTX-9: Read-modify-write manifest updates without locking
**Severity:** LOW | **Category:** Race condition | **Verified:** ✅ lead review — `manifest-store.ts:148-162`, `effectiveness.ts:449-461`, `manifest-purge.ts:136-142`; tmp+rename makes each write atomic, but read-modify-write is not — two writers lose one update. `writeRebuildManifest` should be append-only (JSONL) or single-writer scoped.

#### CTX-10: Handler re-exports contradict the module's own STYLE-6 fix comment
**Severity:** LOW | **Category:** Dead code | **Verified:** ✅ lead review — `pull-tools.ts:308-319`; the comment declares handler re-exports removed, but `handleQueryNeighbor` and `handleQueryFeatureContext` remain exported, keeping the `pull-tools → handlers/query-neighbor → pull-tools` cycle. Finish the job.

#### CTX-11: Reverse-dep scan is O(touchedFiles × globFiles) `content.includes()` scans per fetch
**Severity:** LOW | **Category:** Performance | **Verified:** ✅ lead review — `code-neighbor.ts:391-407`; up to 10 × 500 files × 1MB strings scanned per fetch, bounded by constants but the dominant provider CPU on large repos. Invert the loop (basename index once per fetch).

#### CTX-12: `truncateToTokenBudget` re-formats the whole summary per dropped file — O(n²)
**Severity:** LOW | **Category:** Performance | **Verified:** ✅ lead review — `test-scanner.ts:403-410`; rebuilds the full summary per iteration; incremental drop-and-measure fixes it.

#### CTX-13: `readCached` re-reads the same path from disk after the aggregate budget is hit
**Severity:** LOW | **Category:** Performance | **Verified:** ✅ lead review — `code-neighbor-cache.ts:116-119`; no budget-exhausted negative marker (the `cache.set(path, "")` at 122-124 only covers unreadable files); track a `budgetExhausted` flag.

#### CTX-14: `ProviderWeightsCache` keyed by featureId only; `projectDir` ignored
**Severity:** LOW | **Category:** Bug | **Verified:** ✅ lead review — `provider-weights-cache.ts:25-36`; key on `${projectDir}:${featureId}` to avoid cross-project contamination in shared worktree runs.

---

## Verified-Clean Highlights (checked, no findings)

- **Command injection:** all 61 spawn sites use argv arrays; the only shell execution (`verification/executor.ts:81`) is a documented `@design` config trust boundary. All interpolation sites shell-quote correctly (`flake-probe.ts`, `scoped-lint.ts`, `command-resolver.ts`).
- **Path security:** `isWithinDirectory` (path-security.ts:66-81) trailing-slash check is correct; profile-name traversal rejected; `__proto__`/`constructor` merge keys blocked (`merger.ts:21,46-48`).
- **Webhook hardening:** loopback-only bind, HMAC `timingSafeEqual`, two-bucket rate limiting, body-size enforcement with stream abort, `AbortSignal.timeout` on reporter POSTs (`reporter-shared/post-json.ts:29`).
- **TUI hooks:** all subscriptions/timers cleaned up in effect cleanup; no setState-after-unmount; throttled rendering.
- **Event bus:** every `wire*` returns unsubscribers; errors caught per subscriber; `drain()` has a 5s deadline.
- **Permission resolver:** `resolvePermissions` is the single source of truth; no hardcoded fallbacks found in reviewed paths.
- **Timeout races:** `executeWithTimeout`/`runQualityCommand` timeout paths verified empirically (Bun resolves with 128+signal) — no rejection bug.
- **OTLP payload builders** (`otlp.ts`): pure functions, no network/logging — clean.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | VER-1 | S | Quote/redirect-aware flag insertion in `appendFlag` + unit tests |
| P0 | CTX-1 | S | Keep the slash in `globToRegex`; tests for `src/**/*.ts` vs `srcfoo.ts` |
| P1 | TEL-1 | S | Add AbortController + timeout to `sendTimeoutMessage`/`cancel` |
| P1 | TEL-2 | S | Sanitize `featureName`/`storyId` in `buildHeader` (or drop parse_mode) |
| P1 | LOG-1 | S | Add `github_pat_` / Telegram-token patterns; fix Basic lookahead |
| P1 | EXEC-1 | S | Terminal status for `pre-merge-aborted`/`max-iterations`/`no-stories` |
| P1 | CFG-1 | S | Add `rejectUnimplementedPermissionsBlock` to per-package guards |
| P1 | EXEC-3 | S | Make queue unlink failure observable |
| P2 | OTLP-1 | S | Track + await in-flight send in `flushNow`/`teardown` |
| P2 | WEB-1 | M | Scope fetch interception to the callback path prefix |
| P2 | VER-4 | S | Clear timer in `finally`; raise git-capture budget to ~1s |
| P2 | CFG-2/3/4 | M | `resolveEnvVars` for all layers; dotenv comment/quote/escape fixes |
| P2 | VER-2 | M | Quote-aware tokenization in `buildSmartTestCommand` |
| P2 | CLI-1 | S | Reuse `runQualityCommand` in `runSetupGate` |
| P2 | EXEC-2 | S | Install crash handlers after lock acquisition |
| P2 | EXEC-9 | S | Swallow-and-warn on checkpoint `recordGreen` infra failure |
| P3 | EXEC-4/5/6/7/8 | S/M | Parallel/checkpoint/timer hygiene |
| P3 | CTX-2/3/4/5/6/7/8 | S/M | Context-engine memoization, caps, determinism, null-prototype maps |
| P3 | LOW bucket | S | TUI/parser/telegram validation, migrate two-phase, native fs symlinks, post-json URL scrubbing |
