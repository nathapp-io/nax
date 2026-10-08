# Whole-Repo Code Review — nax monorepo

- **Date:** 2026-10-08
- **HEAD:** `7137e4013` (branch `main`, clean tree)
- **Scope:** all TypeScript sources under `packages/` (~208k LOC: nax, nax-agent, nax-ai, nax-agent-acp, repo-tooling, test-kit), plus root configs, `packages/nax/scripts`, and `.github/workflows/`
- **Method:** 11 subsystem-slice review passes; every finding below was re-verified against the source (verbatim excerpts + line numbers + cross-file emitter/consumer checks). Every finding has proof. No style nits.
- **Totals:** 33 findings — 2 × P1, 10 × P2, 21 × P3

Severity key: **P1** = high-impact bug users will hit routinely · **P2** = real bug, reachable scenario · **P3** = real but minor / edge-case / latent.

---

## P1

### 1. Plan digest rendered twice and double-counted in the token budget

- **File:** `packages/nax/src/context/engine/orchestrator.ts:357-360, 448` (with `context/engine/render.ts:91-93`, `context/engine/agent-renderer.ts:54, 68, 83`, `context/engine/stage-config.ts:274, 288`)
- **Proof:**
  ```ts
  // orchestrator.ts:357-360
  // Amendment B AC-51: inject plan digest as a boosted RawChunk when planDigestBoost > 1.
  // This replaces raw "## Prior Stage Summary" markdown rendering for single-session modes,
  // making the digest compete in scoring/packing and appear in manifest.includedChunks.
  if (request.priorStageDigest && (request.planDigestBoost ?? 1.0) > 1.0) {
  ```
  ```ts
  // orchestrator.ts:447-452 — renderOptions still carries the digest unconditionally
  const renderOptions = { priorStageDigest: request.priorStageDigest };
  ```
  ```ts
  // render.ts:91-93 (agent-renderer.ts:54/:68/:83 do the same in all three styles)
  if (options.priorStageDigest?.trim()) {
    sections.push(`## Prior Stage Summary\n\n${options.priorStageDigest.trim()}`);
  }
  ```
- **Why:** The AC-51 branch injects the digest as a scored/budgeted chunk and its comment says this *replaces* the raw preamble rendering — but nothing suppresses the preamble. Every renderer prepends `## Prior Stage Summary` whenever `priorStageDigest` is set, which is exactly the boost condition. Result: the same digest bytes appear twice in the prompt and are accounted twice (`packChunks` counts the injected chunk's tokens; `manifest-builder.ts:156-164` adds `priorStageDigestTokens` a second time).
- **Trigger:** Any story routed to `tdd-simple` or `no-test` — the default for simple/medium complexity — since `stage-config.ts:274, 288` set `planDigestBoost: 1.5` and `pipeline/stages/context.ts:216` forwards it. Every execution/rectify-stage assembly duplicates the digest. Existing tests only assert `toContain(digest)`, which passes with one or two occurrences.

### 2. Cargo.toml detection classifies all Rust source as test files, blinding review

- **File:** `packages/nax/src/test-runners/detect/framework-defaults.ts:135-139` (with `test-runners/conventions.ts:152-160`)
- **Proof:**
  ```ts
  async function detectFromCargoToml(workdir: string): Promise<DetectionSource | null> {
    const path = `${workdir}/Cargo.toml`;
    if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
    return { type: "manifest", framework: "rust", path, patterns: ["tests/**/*.rs", "src/**/*.rs"] };
  }
  ```
  ```ts
  // conventions.ts:160 — how patterns become review-exclude pathspecs
  const pathspec = `:!*${suffix}`;   // "src/**/*.rs" → suffix ".rs" → ":!*.rs"
  ```
- **Why:** These become resolved Tier-2 "manifest" patterns (medium confidence) for any Cargo.toml project without explicit `testFilePatterns`. `globsToPathspec` maps each to `:!*.rs`, which `resolveReviewExcludePatterns` (consumed by `review/prepare-inputs.ts:134/208`) feeds to review diff collection — **every `.rs` file is excluded from semantic/adversarial review diffs**. `extractTestDirs` additionally yields `["tests", "src"]`, so smart-runner Pass 0 treats changed implementation files as "changed test files". Contrast the Go entry in the same file, which correctly uses only `**/*_test.go`. No test pins this line.
- **Trigger:** Run nax against any repo containing `Cargo.toml` with default config.

---

## P2

### 3. Non-atomic transcript write can permanently destroy a session's history

- **File:** `packages/nax-agent/src/native/session/transcript-store.ts:65-68` (read side: `:51-56`; load site: `native/session/turn-loop.ts:91-93`)
- **Proof:**
  ```ts
  async function writeTranscriptDoc(dir: string, sessionName: string, doc: TranscriptDoc): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath(dir, sessionName), JSON.stringify(doc, null, 2), "utf8");
  }
  ```
  ```ts
  // readTranscriptDoc:54-56
  } catch (err) {
    // Deliberately not null: silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw corruptTranscript(sessionName, ...);
  ```
- **Why:** `writeFile` opens with truncate-in-place; a process killed mid-write leaves a truncated/partial JSON file, destroying the only copy of the conversation. Every later load then throws `TRANSCRIPT_CORRUPT` (never `null`), so the next turn, resume, or retry of that session fails forever. The repo applies the safe staging pattern one directory over (`native/credentials/fingerprint.ts:75-95` stages bytes and hard-links), so the omission is demonstrable, not a style choice.
- **Trigger:** Crash/SIGKILL/OOM during any turn-end or error-path transcript save; the session's whole history is unrecoverable.

### 4. Interceptor-rewritten git argv silently loses the `--ignore-submodules=dirty` hardening

- **File:** `packages/nax-agent/src/tools/git.ts:379-389` (with `internal/git-env.ts:90-99`, `internal/git-exec.ts:84`)
- **Proof:**
  ```ts
  // git.ts:379-389
  const intercepted = await interceptArgv(["git", ...built], ctx.root, interceptor);
  const ioCeiling = ctx.readCeiling ?? READ_CEILING;
  const { stdout, stderr, exitCode } = await gitWithTimeout(
    built, ctx.root, undefined, ioCeiling,
    intercepted.argv,        // ← argvOverride becomes ["<provider>", "git", "diff", ...]
  );
  ```
  ```ts
  // git-env.ts:92-97 — walker reads index 1 as the verb
  let i = 1;
  while (i < out.length && (out[i] as string).startsWith("-")) { ... }
  const verb = out[i];
  if (verb !== undefined && SUBMODULE_DIRTY_CHECK_VERBS.has(verb)) out.splice(i + 1, 0, IGNORE_DIRTY_SUBMODULES_FLAG);
  ```
  ```ts
  // git-exec.ts:84 — hardening is applied to the override
  const proc = _gitDeps.spawn(hardenedGitArgv(argvOverride ?? ["git", ...args]), {
  ```
- **Why:** With an interceptor configured, the override is `["<provider>", "git", "diff", ...]`; the walker stops at index 1 (`"git"` is not a flag), reads `"git"` as the verb, and never inserts the flag. Per `git-env.ts:84-89`'s own header, the command-line flag is "the one form that beats `.gitmodules`" — so on any rewritten git call, the #2210 defense (a malicious nested repo naming a `filter.<x>.clean` driver via `submodule.<name>.ignore = dirty`) is silently re-enabled. No test composes interception with submodules.
- **Trigger:** A run with a command interceptor (the `rtk` seam) plus a repo containing a nested gitlink whose `.gitmodules` sets `submodule.<name>.ignore = dirty`; the agent runs `Git {subcommand: "status"}` and the interceptor rewrites the argv.

### 5. Caller abort mid-stream is classified `kind: "transport"`, violating the module's own invariant

- **File:** `packages/nax-ai/src/protocols/pi-client.ts:359-378` (invariant: `:390-397`)
- **Proof:**
  ```ts
  // :359-377 — the error-EVENT path never checks the signal
  case "error": {
    const status = observed?.status;
    ...
    yield { type: "error", error: { kind: classifyProviderError(status, upstreamMessage), ... } };
  ```
  ```ts
  // :394-397 — the catch path, 20 lines below, preserves abort on purpose
  // The caller's own abort must not be relabelled as a transport fault: retryTransportFaults, and any
  // consumer-level abort handling, both need to see abort as abort.
  if (req.signal?.aborted) throw cause;
  ```
- **Why:** All four pi-ai adapters nax-ai uses deliver a caller abort as an error *event*, not a throw (verified in pi-ai dist: `openai-completions.js:501-511`, `openai-responses.js:153-155`, `openai-codex-responses.js:346-348`, `anthropic-messages.js:633-636` — `stopReason = signal?.aborted ? "aborted" : "error"` with `errorMessage: "Request was aborted"`). `classifyBrokenStream("Request was aborted")` returns `"transport"`, so a user abort surfaces as a provider transport fault — exactly what the comment says must not happen. `packages/nax-agent/src/native/session/turn-retry.ts:66` includes `"transport"` in `RETRYABLE_KINDS`; it rethrows today only because it separately checks `deps.signal?.aborted` — any consumer dispatching on `kind` alone re-issues or mis-telemetries an aborted request. The existing test (`test/protocols/pi-client.test.ts:722`) pins only `type: "error"`, not the kind.
- **Trigger:** `client.complete(model, req)` with `req.signal`; user cancels after the first streamed event → `ProtocolStreamError { kind: "transport", message: "Request was aborted" }`.

### 6. `tdd.strategy: "simple"` is rejected by the schema although the runtime type and router consume it

- **File:** `packages/nax/src/config/schemas-execution.ts:491-493` (vs `config/schema-types.ts:13`; consumer `routing/classify.ts:135-138`)
- **Proof:**
  ```ts
  // schemas-execution.ts:491-493
  export const TddConfigSchema = z.object({
    maxRetries: z.number().int().nonnegative(),
    strategy: z.enum(["auto", "strict", "lite", "off"]).default("auto"),
  ```
  ```ts
  // schema-types.ts:13
  export type TddStrategy = "auto" | "strict" | "lite" | "simple" | "off";
  ```
  ```ts
  // routing/classify.ts:137
  if (tddStrategy === "simple") return "tdd-simple";
  ```
- **Why:** The Zod enum is narrower than the documented union, and the router has a live branch for `"simple"`. No compat shim remaps the value (grep of `config/compat-shims.ts` for tdd: no entry), so the branch is reachable only through a config the loader refuses.
- **Trigger:** A project config containing `tdd: { strategy: "simple" }` fails `NaxConfigSchema.safeParse` in `finalizeAndValidateRootConfig` (`config/loader.ts:267-277`) with `Invalid option`, while `"lite"`/`"strict"` load and route.

### 7. acpx transport turns a mid-turn abort into a success-shaped empty result → fail-stale retry during teardown

- **File:** `packages/nax/src/agents/acp/adapter-send-turn.ts:145-148, 317-327` (with `operations/turn-failure-classification.ts:15-18`, `agents/acp/adapter-output.ts:30-31`, `agents/acp-sdk/turn-loop.ts:182`)
- **Proof:**
  ```ts
  // adapter-send-turn.ts:145-148
  if (turnResult.aborted) {
    state.aborted = true;
    return { kind: "break" };
  }
  ```
  ```ts
  // adapter-send-turn.ts:317-327 — no abort fact reaches the result
  maybeWarnBudgetSpent(frame, state);
  throwIfTurnFailed(frame, state);
  return buildTurnResult({
    lastResponse: state.lastResponse,   // null when aborted (adapter-output.ts:31 doc)
    totalTokenUsage: state.totalTokenUsage,
    totalExactCostUsd: state.totalExactCostUsd,
    turnCount: state.turnCount,
    interactions: state.interactions,
    timedOut: state.timedOut,           // false here
    rateCard: frame.rateCard,
  });
  ```
  ```ts
  // operations/turn-failure-classification.ts:15-17
  // When output is empty (or whitespace-only) and timedOut is false or
  // absent, synthesise a retriable `availability / fail-stale` failure
  ```
- **Why:** `state.aborted` is consumed only by `maybeWarnBudgetSpent`; `BuildTurnResultInput` has no `aborted` field. The result is empty-output, `timedOut` absent — exactly the shape classified as a *retriable* `fail-stale`. The stale lane in `agents/retry/hop-retry-policy.ts:97` has no `signal?.aborted` check, so teardown aborts degenerate into a success-shaped dispatch row, a bogus fail-stale record, and a same-agent re-dispatch during teardown. The sibling SDK transport throws fail-aborted instead (`acp-sdk/turn-loop.ts:182`), and `agents/types.ts:269` documents that aborts must "return a clean failure result so the caller can unwind".
- **Trigger:** `agent.acp.transport: "acpx"`; the run aborts (Ctrl+C, SIGINT crash-recovery) while an ACP session turn is in flight.

### 8. `openSession`'s close-then-reopen drops the RACE-37 single-flight guard across an await

- **File:** `packages/nax/src/session/manager.ts:424-429, 462, 532`
- **Proof:**
  ```ts
  // :424-429
  if (liveHandle && reuse === "close-then-reopen") {
    // closeSession clears _busySessions for this name; openSession set that marker
    // as its single-flight guard and still needs it for the rest of this open.
    await this.closeSession(liveHandle);
    this._busySessions.add(name);
  } else if (liveHandle) this._liveHandles.delete(name);
  ```
  ```ts
  // :532 — inside closeSession, after awaiting adapter.closeSession
  this._busySessions.delete(handle.id);
  ```
- **Why:** `closeSession` deletes the busy marker only after its internal awaits resolve; `openSessionImpl` re-adds it in the *next* microtask after the `await this.closeSession(...)` continuation. A second `openSession(name)` whose continuation is queued in that window observes `_busySessions` without the name, passes the guard at `:404`, and runs `adapter.openSession` concurrently — both then execute `this._liveHandles.set(name, handle)` (`:462`), last writer wins, and the loser's physical session is orphaned until TTL/forceStop. That is precisely the loss the RACE-37 comment (`:398-403`) says the guard exists to prevent; restore-after-await is not atomic.
- **Trigger:** Two operations targeting the same session name (parallel story execution / a swap re-open racing another stage's open) where the cached handle's agent or endpoint differs.

### 9. Curator's H3 rectify-cycle collector matches a log line nothing in the codebase emits

- **File:** `packages/nax/src/plugins/builtin/curator/collect.ts:567-576`
- **Proof:**
  ```ts
  if (stage === "pull-tool" && message === "invoked") {
    observations.push(collectPullCall(context, entry, data));
  } else if (stage === "acceptance" && message === "verdict") {
    observations.push(collectAcceptanceVerdict(context, entry, data));
  } else if (stage === "rectify" && message === "Starting rectification loop") {
    observations.push(collectRectify(context, entry, data));
  ```
- **Why:** Repo-wide grep: `"Starting rectification loop"` appears only in collect.ts itself, and no logger call anywhere uses stage `"rectify"` (the `"rectify"` strings elsewhere are context-engine stage keys in `phase-stage-map.ts`, a different namespace). The rectification loop logs under `"story-orchestrator"` (`execution/story-orchestrator-logging.ts:91`). So `collectRectify` is unreachable and `RectifyCycleObservation` is never produced, starving `h3RepeatedRectification` (`curator/heuristics.ts:243-245` filters `kind === "rectify-cycle"`) — the "repeated rectification cycle" proposal can never fire from real runs. The collector test fixture omits this branch.
- **Trigger:** Any run where a story needs 2+ rectification attempts; the curator silently emits no H3 proposal.

### 10. Acceptance overrides are keyed by bare AC id although AC ids are package-local

- **File:** `packages/nax/src/pipeline/stages/acceptance.ts:348-351` (vs BUG-12 at `:254-256`, dedup at `:440-444`)
- **Proof:**
  ```ts
  // :254-256
  // BUG-12: each package numbers its acceptance criteria AC-1..N independently, so
  // package A's AC-2 and package B's different AC-2 are distinct failures. Dedup by
  // packageDir+acId (not the bare acId) so the aggregate never under-reports.
  ```
  ```ts
  // :348-351 — the override filter ignores the package
  const overrides = ctx.prd.acceptanceOverrides ?? {};
  const actualFailures = failedACs.filter((acId) => !overrides[acId]);
  const overriddenFailures = failedACs.filter((acId) => overrides[acId]);
  ```
  ```ts
  // :440-441 — the dedup keys packageDir::acId
  const acKey = `${packageDir}::${acId}`;
  ```
- **Why:** `failedACs` are per-package parsed bare ids; `acceptanceOverrides["AC-2"]` written to waive package A's AC-2 also suppresses the same-numbered, different criterion in every other package. There is no way to express a package-scoped override key because the parser emits bare ids — a false pass verdict on a genuinely failed criterion.
- **Trigger:** Monorepo PRD (per-package acceptance groups) with `acceptanceOverrides: { "AC-2": "waived" }`; package B's independent AC-2 failure is filtered out of `actualFailures` and the stage can return `{ action: "continue" }`.

### 11. Hook timeout kill is not a process-group kill — timed-out hooks leak their children

- **File:** `packages/nax/src/hooks/runner.ts:226-244`
- **Proof:**
  ```ts
  const proc = Bun.spawn(argv, {
    cwd: workdir,
    stdin: new Response(contextJson),
    stdout: "pipe",
    stderr: "pipe",
    env: buildAllowedEnv({ env }),
  });                                    // ← no detached: true
  ...
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, "SIGTERM");
    killTimeoutId = setTimeout(() => killProcessGroup(proc.pid, "SIGKILL"), HOOK_KILL_GRACE_MS);
  }, timeout);
  ```
- **Why:** Bun.spawn does not put children in their own process group unless `detached: true` is passed — the invariant documented at every sibling kill site (`quality/runner.ts:166-169`, `acceptance/hardening.ts:181-190`, `utils/bun-deps.ts:29`: "Without this, killProcessGroup(-pid) targets a…"). Without it, the hook shares nax's own pgid, `process.kill(-proc.pid, sig)` fails with ESRCH, and the fallback kills only the direct child. Any process the hook spawned (dev server, watcher) survives both SIGTERM and SIGKILL escalation. `fireHook` is on the production path for every lifecycle event (`pipeline/subscribers/hooks.ts`).
- **Trigger:** A project hook (default 5 s timeout) launches a long-lived child and exceeds `timeout` — the wrapper is killed, the child runs on for the rest of the run.

### 12. Story-size gate counts any line containing a digit+dot as a bullet — can block runs

- **File:** `packages/nax/src/precheck/story-size-gate.ts:33-39`
- **Proof:**
  ```ts
  /**
   * Count bullet points in text (lines starting with -, *, •, or digit.)
   */
  function countBulletPoints(text: string): number {
    const lines = text.split("\n");
    const bulletPattern = /^\s*[-*•]|\d+\./;
    return lines.filter((line) => bulletPattern.test(line)).length;
  }
  ```
- **Why:** Alternation splits at top level, so the pattern is `^\s*[-*•]` OR `\d+\.` *anywhere in the line*. The documented intent requires anchoring both branches. "Estimates 2.5 hours", "see section 2.3", "v1.2", "HTTP/1.1" in a description each count as a bullet. The count feeds `bulletsFlagged = bulletPoints > thresholds.maxBulletPoints` (default 8) — a warning by default, but a run-blocking Tier-1 `blocker` when `precheck.storySizeGate.action === "block"`. No test pins the digit behavior.
- **Trigger:** A PRD story description with ≥9 incidental digit-dot occurrences (version numbers, decimals, dates) is flagged oversized — and blocks the run under `action: "block"`.

---

## P3

### 13. `TurnResult.output` drops an `after_response` text patch, diverging from the transcript

- **File:** `packages/nax-agent/src/native/session/turn-loop-round-trip.ts:213, 247-269` (contract: `session/turn-event.ts:6-7`)
- **Proof:**
  ```ts
  state.output = res.text;                    // :213 — assigned before the dispatch, never updated
  ...
  const afterResponse = await loopEvents.dispatch("after_response", { text: res.text, ... });  // :247
  const assistantText = afterResponse.text ?? res.text;   // :258 — only the transcript gets the patch
  ```
  ```ts
  // session/turn-event.ts:6-7 — the seam's own contract
  // - Deltas are provisional. `after_response` handlers may patch the recorded
  //   text, so the transcript and `TurnResult.output` are authoritative.
  ```
- **Why:** `state.output` is never updated with `afterResponse.text`, while the pushed assistant message carries the patched text — the two records the contract names as authoritative diverge. The final round trip's unpatched text is what `TurnResult.output`, the facade's `turn_end.output`, and the op's recorded answer carry.
- **Trigger:** A plugin registers an `after_response` handler returning `{ text: patched }` on the turn's final round trip; the transcript shows `patched`, the user-visible output is the raw model text.

### 14. Coding-tool dispatch has no abort race, unlike the embedder path beside it

- **File:** `packages/nax-agent/src/session/session-interaction.ts:102-118 vs 157-172`
- **Proof:**
  ```ts
  // :113-117 — embedder tools
  try {
    return await Promise.race([runSafely(tool, input, ctx), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
  ```
  ```ts
  // :161-163 — coding tools, no race
  deps.setCurrentCallId(request.toolCallId);
  try {
    const outcome = await deps.runtime.callTool(request.name, request.input ?? {}, toolCallContext(request));
  ```
- **Why:** `invoke()` races embedder tools against the turn signal precisely because, per its own comment, "the batch awaits this handler with no abort race of its own, so a run that ignores its signal would otherwise hang the turn" — but `runCodingTool` awaits `runtime.callTool` bare with the same no-race batch. After the deadline fires, nothing bounds the await, and the facade's `shutdown()` awaits the active turn, so `session.close()` hangs too.
- **Trigger:** A registered coding tool (`registerCodingTool`) that ignores `ToolCallContext.signal`; the turn is cancelled/timed out → `send()`'s iterator never reaches `turn_end` and `close()` never resolves.

### 15. `importPiCredentials` crashes with a raw TypeError on a top-level `null` auth file

- **File:** `packages/nax-agent/src/native/auth.ts:194-207`
- **Proof:**
  ```ts
  let parsed: Record<string, PiEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, PiEntry>;
  } catch (error) {
    throw new NaxError(`The file at ${path} is not valid JSON.`, "AUTH_IMPORT_SOURCE_UNREADABLE", { ... });
  }
  ...
  for (const providerId of Object.keys(parsed).sort()) {
  ```
- **Why:** `JSON.parse("null")` returns `null`, which is not a `JSON.parse` throw, so the guarded path is skipped and `Object.keys(null)` throws a bare `TypeError` instead of the module's own typed error. The sibling reader (`native/credentials/index.ts:194-206`) explicitly re-checks the parsed shape, marking the missing check as a defect rather than intent.
- **Trigger:** `~/.pi/agent/auth.json` contains the literal text `null`; `nax auth`'s pi-import surfaces `TypeError: Cannot convert undefined or null to object`.

### 16. `appendApproval` rewrites (and can destroy) approvals.json on any read failure or unparseable JSON

- **File:** `packages/nax-agent/src/permissions/approvals-store.ts:188-194, 200-205, 217-223`
- **Proof:**
  ```ts
  export async function readApprovalsFile(path: string): Promise<ApprovalsFile> {
    try {
      return (await readApprovalsFileDetailed(path)).file;
    } catch {
      return EMPTY_FILE;                    // every read error → empty store
    }
  }
  ```
  ```ts
  export async function appendApproval(path: string, entry: ApprovalEntry): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await withPathFileLock(path, async () => {
      const existing = await readApprovalsFile(path);   // EMPTY_FILE on any failure
      await writeApprovalsFile(path, { taint: existing.taint, entries: [...existing.entries, entry] });
    });
  }
  ```
- **Why:** A transient read failure (EACCES/EIO) or a truncated store (possible — `writeApprovalsFile:204` writes in place, not temp+rename; a SIGKILL/ENOSPC mid-write leaves unparseable JSON) makes the next "Allow + remember" replace the whole file with `{entries: [entry]}`, dropping every existing remembered approval and the taint marker. The removal path (`removeApprovals`/`applyRemoval`) explicitly refuses to rewrite an unparseable store; the append path has no equivalent guard.
- **Trigger:** approvals.json truncated by a prior crash (or transient read failure); a later "allow and remember" destroys the store.

### 17. `/tmp/nax` shared-temp-parent trust is decided by writability, not ownership

- **File:** `packages/nax-agent/src/sandbox/session-tmp.ts:50-66`
- **Proof:**
  ```ts
  function isUsableSharedParent(): boolean {
    try {
      const stats = _sessionTmpDeps.lstat(SHARED_TMP_PARENT);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    } catch (err) { ... }
    try {
      _sessionTmpDeps.access(SHARED_TMP_PARENT, constants.W_OK | constants.X_OK);
      return true;                          // ← no uid check
    } catch { return false; }
  }
  ```
- **Why:** A world-writable (`0777`) `/tmp/nax` owned by a different user passes the probe, so all session temp dirs (`/tmp/nax/<runId>/<session>`) are created under an attacker-owned directory — a hostile local user can pre-create subdirectories/symlinks there and read everything sandboxed commands write via `$TMPDIR`. The uid dep exists (`:41` `process.getuid?.()`) but is not used for this check; the per-user fallback `/tmp/nax-<uid>` exists for exactly this threat.
- **Trigger:** Another local user pre-creates `/tmp/nax` mode 0777 before nax runs.

### 18. Post-exit drain grace is shared, so stderr gets whatever budget stdout did not consume

- **File:** `packages/nax-agent/src/internal/argv-exec.ts:222-238`
- **Proof:**
  ```ts
  let graceTimerId: unknown;
  const gracePromise = new Promise<"expired">((resolve) => {
    graceTimerId = _argvExecDeps.setTimeout(() => resolve("expired"), graceMs);   // ONE timer
  });
  const stdoutSettled = await Promise.race([stdoutPromise, gracePromise.then(() => "expired")]);
  const stderrSettled = await Promise.race([stderrPromise, gracePromise.then(() => "expired")]);  // starts after stdout settles
  ```
- **Why:** One 500 ms timer is started once and the two races are awaited sequentially: the stderr race does not begin until the stdout race settles. If stdout closes at ~499 ms after exit, the stderr race starts against an already-(nearly-)expired promise — a stderr stream held by a background process is declared an orphan early, and `killGroup()` + `stderrController.abort()` (`:244-253`) force-cancel the reader, truncating captured output before the promised grace elapsed for that stream.
- **Trigger:** A model-authored command like `sh -c 'long writer > pipe1 & err-writer 2> pipe2 &'` where the stdout holder releases at ~the grace deadline.

### 19. Elicitation: a required field with a `<key>_custom` companion declines the custom answer its own contract accepts

- **File:** `packages/nax-agent-acp/src/client/elicitation.ts:176-196` (doc: `:11-16`)
- **Proof:**
  ```ts
  // doc :15-16: "a reply naming no choice without a companion, or an empty reply to a
  // required field, declines after asking"
  function singleReply(field: Field, reply: string): Reply {
    const choice = matchChoice(field.choices, reply);
    if (choice !== undefined) return accepted({ [field.key]: choice.value });
    return field.companion === undefined || field.required ? NO_MATCH : accepted({ [field.companion]: reply });
  }
  ```
  ```ts
  // :190-191 (multiReply) — same outcome via a different condition
  if (others.length > 0 && field.companion === undefined) return NO_MATCH;
  if (values.length === 0 && field.required) return NO_MATCH;
  ```
- **Why:** For a required field *with* a companion and a non-empty reply matching no choice, neither documented decline trigger holds, yet both paths decline. The two paths also diverge: a required multi accepts `"redis, custom-thing"` (choice matched → companion used), while a required single can never use its companion at all. Doc and code cannot all be right.
- **Trigger:** An elicitation form with `required: ["auth"]`, `auth` a oneOf select and `auth_custom` a text field (the AskUserQuestion "Other" shape); a free-text answer declines the whole form instead of filling the companion.

### 20. Deterministic setup failures ("Unknown model", invalid headers) are retried as transport faults

- **File:** `packages/nax-ai/src/protocols/retry.ts:100-110` (with `protocols/pi-client.ts:266, 844-849`, `protocols/errors.ts:249-252`)
- **Proof:**
  ```ts
  // retry.ts:105-109
  if (emitted || retryIndex >= retries) throw cause;
  if (classifyThrown(cause).kind !== "transport") throw cause;
  await abortableSleep(backoffMs(retryIndex), sleep, signal);
  retryIndex += 1;
  continue;
  ```
  ```ts
  // pi-client.ts:266 — resolveModel runs at the top of the generator, outside the try
  const model = await deps.resolveModel(req.model, req.provider);
  ```
  ```ts
  // pi-client.ts:846-848 — a status-less, deterministic throw
  throw new Error(`Unknown model "${modelId}" for provider "${provider}" in the pi-ai catalog.`);
  ```
- **Why:** `classifyThrown` files every status-less throw as `"transport"`, and the request is re-issued `transportRetries` times (default 2) with backoff before the config error finally surfaces — against retry.ts's own header policy ("nax-ai retries transport faults only"; a config error cannot change on retry). Invalid-header/invalid-sessionId errors take the twin path via transport-kind error events, which `isRetryableErrorEvent` also retries.
- **Trigger:** `client.complete(await client.model("deepseek", "deepseek-chat-typo"), ...)` → two pointless re-attempts and ~750 ms added latency; grows linearly with `transportRetries`.

### 21. Rule-section budget walk sorts with `localeCompare`, contradicting the CTX-5 code-point invariant

- **File:** `packages/nax/src/context/rules/rule-budget/index.ts:134-139` (vs `context/engine/providers/static-rules.ts:253-260`; docstring claim `:77-81`)
- **Proof:**
  ```ts
  // rule-budget/index.ts:134-139 — decides WHICH sections survive truncation
  const sorted = [...sections].sort(
    (a, b) =>
      (a.priority ?? FRONTMATTER_PRIORITY_DEFAULT) - (b.priority ?? FRONTMATTER_PRIORITY_DEFAULT) ||
      ownerIdentifier(a).localeCompare(ownerIdentifier(b)) ||
      a.ordinal - b.ordinal,
  );
  ```
  ```ts
  // static-rules.ts:256-259 — the order it is claimed to match
  // CTX-5: code-point comparison, not localeCompare — see digest.ts.
  const idA = canonicalRuleId(a);
  const idB = canonicalRuleId(b);
  return idA < idB ? -1 : idA > idB ? 1 : 0;
  ```
- **Why:** The repo invariant (CTX-5/AC-24 "byte-identical across machines") exists precisely because `localeCompare` ordering varies with ICU/locale. `applySectionBudget` still uses `localeCompare` on the owner key (canonical-loader's load sort at `index.ts:463` does too), so equal-priority rules whose ids order differently under collation are truncated in a machine/locale-dependent order, and the module's docstring claim of agreement with the provider sort is false.
- **Trigger:** Rules store with equal-priority files whose ids collate differently than code-point order (e.g. `Auth-Rules.md` vs `api.md`) plus an over-budget ruleset under `context.v2.rules.enforceBudget: true`.

### 22. `fetchWithTimeout` leaks an armed timer and creates an unhandled rejection when `provider.fetch` throws synchronously

- **File:** `packages/nax/src/context/engine/orchestrator.ts:110-144`
- **Proof:**
  ```ts
  const timeout = new Promise<ContextProviderResult>((_, reject) => {
    handle = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error(...)); }, timeoutMs);
  });

  const fetchPromise = provider.fetch(request, controller.signal).then(   // ← BEFORE the try
    (result) => result,
    (err) => { ... },
  );

  try {
    return await Promise.race([fetchPromise, timeout]);
  } finally {
    clearTimeout(handle);
  }
  ```
- **Why:** `provider.fetch(...)` is invoked *before* the `try` block, so a synchronous throw escapes `fetchWithTimeout` without running `finally { clearTimeout(handle) }`. The 5 s timer stays armed; when it fires, the `timeout` promise rejects with no consumer attached (the `Promise.race` was never constructed) — an unhandled rejection, which terminates a Node/Bun process on default settings, and the leaked handle keeps the event loop alive.
- **Trigger:** A plugin context provider (`plugin-loader.ts` duck-types only `typeof p.fetch === "function"`) whose `fetch` throws synchronously — the first assemble after the throw crashes the run ~5 s later with an unrelated unhandled rejection instead of the documented soft-skip at `:318-349`.

### 23. `resolveFinalDispatch` drops a literal `{agent, model}` pin — cost rows attribute the wrong model after a swap

- **File:** `packages/nax/src/agents/manager-dispatch.ts:425-434, 454-463`
- **Proof:**
  ```ts
  // :431-433 — the actual hop honours a literal pin...
  if (currentAgent === primaryAgent) return options;
  if (model !== undefined) return { ...options, modelDef: resolveModel(model) };
  return { ...options, modelDef: options.modelDefFor?.(currentAgent, tier) ?? options.modelDef };
  ```
  ```ts
  // :454-462 — ...but resolveFinalDispatch has no model parameter at all
  export function resolveFinalDispatch(
    options: ResolvedCompleteOptions,
    primaryAgent: string,
    fallbacks: readonly AgentFallbackRecord[],
    finalTier?: string,
  ): { agentName: string; options: ResolvedCompleteOptions } {
    const agentName = fallbacks.at(-1)?.newAgent ?? primaryAgent;
    const hopOptions = resolveHopCompleteOptions(options, agentName, primaryAgent, finalTier);
  ```
- **Why:** The dispatch uses the pin (`resolveHopCompleteOptions`'s fifth parameter) and `completeWithFallback` tracks it in `currentModel`, but `buildCompleteOutcome` returns only `finalTier`/`finalTarget`. For a swap onto a fallback-map target spelled `{ agent, model: "<literal-id>" }`, `completeAsWithFallback`'s emitted `complete` event re-derives `modelDef` through tier-map/primary — naming a model that never ran on the cost row. Attribution-only, but it is exactly the divergence nax#1739 fixed for tiers ("`model` and `modelTier` must not disagree", `:451`).
- **Trigger:** `agent.fallback.map` entry `{ claude: [{ agent: "codex", model: "some-literal-model" }] }`; a `complete()`-kind op fails over to codex — the dispatch uses the pin, the cost row records the tier-map/primary model.

### 24. `closeStory` deletes descriptors without clearing `_cancelledSessions`/`_busySessions`/watchdog bookkeeping

- **File:** `packages/nax/src/session/manager.ts:342-346` (vs `:466-483`, `:532-534`)
- **Proof:**
  ```ts
  // :342-345 — closeStory clears none of the maps
  const updated: SessionDescriptor = { ...session, state: "COMPLETED", lastActivityAt: now };
  persistDescriptor(updated);
  this._sessions.delete(id);
  if (updated.handle) this._liveHandles.delete(updated.handle);
  ```
  ```ts
  // :481-483 — the reopen branch knows the invariant exists...
  // Also clear the cancelled flag in case this session was previously cancelled
  // before reaching terminal state, so sendPrompt does not immediately throw.
  this._cancelledSessions.delete(name);
  ```
- **Why:** `closeSession` always clears the maps (`:532-534`) and the terminal→RUNNING reopen branch clears `_cancelledSessions` (`:483`) — but `closeStory` clears none of them while deleting the descriptor. If teardown deletes a still-RUNNING descriptor while its in-flight turn then fails abort-shaped, `sendPrompt`'s catch adds the name to `_cancelledSessions` with no descriptor to transition. A later `openSession` of the same name takes the `!existingDescriptor` create branch (`:466-475`), which never clears the flag — the brand-new session's first `sendPrompt` throws `SESSION_CANCELLED` with no close/reopen path that can clear it.
- **Trigger:** Run teardown closes a story while an op's turn is still in flight and that turn ends abort-shaped; deferred rectification in the same process reopens the session name and fails immediately.

### 25. AC-reground reprompt drops the second turn's cost on the "parse-failed" and "still-dropped" outcomes

- **File:** `packages/nax/src/operations/adversarial-review.ts:190-198, 236-239` and `operations/semantic-review.ts:277-282, 316-321`
- **Proof:**
  ```ts
  // adversarial-review.ts:190 — costUsd includes the second turn...
  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  ```
  ```ts
  // :193-198 — ...but these branches never set estimatedCostUsd
  if (!secondParsed) {
    return { ...turn, output: withRepromptMarker(turn.output, { dropCount, outcome: "parse-failed", costUsd }) };
  }
  ```
  ```ts
  // :214 — sibling branch in the same function DOES set it
  estimatedCostUsd: costUsd,
  ```
- **Why:** The parse-failed and still-dropped branches spread `...turn` without `estimatedCostUsd: costUsd`, so the returned `TurnResult` reports only the first turn's cost; the sibling branches in the same functions (`:214, :231`; semantic `:296, :312`) and `maybeRepromptForInspection` (both files) do set it — an internal inconsistency showing the omission is not convention. Downstream, `operations/build-hop-callback-hop.ts:112-126` copies `estimatedCostUsd` into the `AgentResult` and `operations/call-dispatch-run.ts:195-196` reads it as the dispatch `totalCost` — the op/story-level cost silently under-counts the reprompt spend while the ledger rows carry it (the two sinks disagree). No test pins the value on these branches.
- **Trigger:** Semantic or adversarial review in `ref` mode where the reground turn returns unparseable JSON or again only AC-dropped blocking findings — the reprompt tokens are billed and recorded in `_repromptInfo.costUsd` but never reach the reported cost.

### 26. `declaredStoryIds`' skip of grouped subsections resets on any deeper heading, making the unknown-story lint self-satisfying

- **File:** `packages/nax/src/prd/spec-structure.ts:79-103`
- **Proof:**
  ```ts
  // :74-77 — the stated purpose of the skip
  // The `### Modifies` / `### Context Files` / `### Creates` / `### Seams`
  // subsections are skipped deliberately: their own `**US-00N**` group lead-ins
  // are the thing being validated, so counting them as declarations would make
  // the unknown-story check self-satisfying.
  ```
  ```ts
  // :91-100 — but ANY `#{3,6}` heading resets the flag
  if (/^#{3,6}\s/.test(line)) inSkippedSubsection = GROUPED_PATH_SUBSECTION.test(line);
  if (inSkippedSubsection) continue;

  const heading = /^#{1,6}\s+(US-\d+)\b/i.exec(line);
  if (heading?.[1]) { ids.add(heading[1].toUpperCase()); continue; }
  const bold = /^\s*\*\*\s*(US-\d+)\b/i.exec(line);
  if (bold?.[1]) ids.add(bold[1].toUpperCase());
  ```
- **Why:** A `#### US-009` heading inside `### Modifies` (a supported group form — `markdown-scan.ts:76-77` documents the heading form) sets `inSkippedSubsection = false`, so US-009 is added as a "declaration" and every later `**US-00N**` lead-in in the same section too. `checkModifies`'s `modifies-unknown-story` error then compares those entries against ids that came from Modifies itself — exactly the self-satisfying check the skip exists to prevent; a spec declaring stories only inside Modifies passes the lint. The existing test covers only bold lead-ins directly under `### Modifies`.
- **Trigger:** A spec with `### Modifies` whose groups are `#### US-00N` headings (or any deeper heading, e.g. `#### Notes`, followed by `**US-00N**` bullets) — phantom ids become "declared" and the lint is silenced against them.

### 27. `{{files}}` template substitution uses string-replace with the file path as the replacement value

- **File:** `packages/nax/src/prompts/builders/rectifier-builder.ts:521-529` (same at `rectifier-builder-helpers.ts:579-580`)
- **Proof:**
  ```ts
  const testCommands = failingFiles
    .map((file) => {
      const scopedCmd = testScopedTemplate
        ? testScopedTemplate.replace("{{files}}", file)   // ← string replacement
        : cmd
          ? `${cmd} ${file}`
          : file;
  ```
- **Why:** `String.prototype.replace` with a string replacement interprets `$&`, `` $` ``, `$'` and `$$` in the replacement, so a failing test-file path containing them (legal on POSIX; paths come from parsed test-runner output/finding records) renders a corrupted scoped command into the rectifier prompt (`a$$b.test.ts` → `a$b.test.ts`). Additionally `replace` substitutes only the first `{{files}}`. The codebase's own env interpolator (`plugins/builtin/reporter-shared/interpolate.ts:23-29`) avoids exactly this by using a function replacement.
- **Trigger:** `quality.commands.testScoped` configured (e.g. `bun test {{files}}`) + a failing file whose path contains `$$`/`$&` (or a template with two placeholders) — the agent is presented a command that does not reference the real file.

### 28. Tier-3 file scan can never detect pytest's dominant `test_*.py` convention

- **File:** `packages/nax/src/test-runners/detect/file-scan.ts:76-99, 206-212`
- **Proof:**
  ```ts
  const CANDIDATE_SUFFIXES = [ ..., "_test.go", "_test.py", "test_.py" ] as const;
  ...
  "test_.py": "**/test_*.py",      // SUFFIX_TO_GLOB — unreachable mapping
  ...
  for (const file of filtered) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      if (file.endsWith(suffix)) {          // ← "test_foo.py" ends with ".py", never "test_.py"
  ```
- **Why:** Every entry is matched with `file.endsWith(suffix)`, but `test_foo.py` ends with `.py`, not `test_.py` — the entry can only match a file literally named `test_.py`, so the suffix-frequency scan never counts pytest's primary naming convention and the `**/test_*.py` glob mapping is unreachable. Python projects that don't use a `tests/` directory and aren't Tier-2-detectable get no detection at all.
- **Trigger:** `detectFromFileScan` on a flat pytest project (100 `test_*.py` files co-located with sources, no `tests/` dir) returns null; smart-runner scoping and review exclusions fall back to TS-oriented defaults.

### 29. Hardening pass drains the killed acceptance runner's pipes with no deadline

- **File:** `packages/nax/src/acceptance/hardening.ts:193-218`
- **Proof:**
  ```ts
  // LLM-generated acceptance tests can hang (open server, watch mode) — enforce
  // a hard wall-clock deadline with SIGTERM -> SIGKILL escalation so the run's
  // completion phase never wedges indefinitely.
  ...
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ""),   // ← unbounded drain
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  ```
- **Why:** The SIGTERM→SIGKILL escalation bounds `proc.exited`, but `proc.exited` resolving does not close pipes held by a descendant that escaped the process group. Every sibling call site caps the post-kill drain (`quality/runner.ts:204-209` races both drains against `STREAM_DRAIN_TIMEOUT_MS`; `tdd/rollback.ts` documents the hazard as BUG-2) — here the two `.text()` drains are awaited unbounded, so the stated guarantee ("never wedges indefinitely") does not hold; `runHardeningPass` awaits `processPackageGroup` and the completion phase blocks behind it.
- **Trigger:** The LLM acceptance command spawns a server/watcher that daemonizes (setsid/double-fork) and holds stdout; the SIGKILL fires, the runner dies, the orphan keeps the pipe open, and the hardening await hangs forever.

### 30. Unified-diff parser: `+++ b/<path>` content lines are misparsed as file headers

- **File:** `packages/nax/src/utils/diff-files.ts:27-38, 80-86`
- **Proof:**
  ```ts
  // :27-32 — the docstring identifies the indistinguishability... but only fixes one form
  // Inside a hunk, an ADDED line whose content begins with `++ ` is rendered as `+++ ...` and is
  // indistinguishable from an unprefixed header on its own. ... The `b/` form needs no such gate
  function parseHeaderPath(rawLine: string, precededByMinusHeader: boolean): string | null {
    if (rawLine.startsWith(HEADER_PREFIX)) {
      return rawLine.slice(HEADER_PREFIX.length).trim() || null;    // ← b/ form: no wasMinusHeader gate
    }
    if (!precededByMinusHeader) return null;
  ```
- **Why:** An added content line whose text is `++ b/<path>` renders as `+++ b/<path>` in the diff body — identical to a real prefixed header. The `b/` branch returns a path with no `wasMinusHeader` gate, so `extractDiffFiles` records a phantom file and `extractDiffLineRanges` re-targets `currentPath` to it, attributing all subsequent hunks to the wrong file. This parser feeds adversarial-review `fileInDiff` telemetry and the mutation spot-check's changed-line bounds (module docstring `:5-7`).
- **Trigger:** A story adds a line containing `++ b/foo.ts` (diff docs, test fixtures); the mutation spot-check then validates mutations against the wrong file's lines.

### 31. Release Telegram step cats a release-notes file the workflow may never create

- **File:** `.github/workflows/release.yml:227, 255-258`
- **Proof:**
  ```yaml
  # :226-228 — the only writer, gated on non-empty notes
  if [ -n "$NOTES" ]; then
    echo "$NOTES" > /tmp/release-notes.md
  ```
  ```yaml
  # :255-258 — the notify step's if never checks has_notes
  - name: Notify Telegram
    if: steps.info.outputs.notify == 'true' && steps.pkg.outputs.name == '@nathapp/nax' && vars.TELEGRAM_CHAT_ID != ''
    run: |
      NOTES=$(cat /tmp/release-notes.md | head -20)     # ← no `|| true` guard (the curl below has one)
  ```
- **Why:** `/tmp/release-notes.md` exists only when `has_notes == 'true'`, but the notify step's condition omits that output. GitHub runs `run:` blocks with `bash --noprofile --norc -eo pipefail`, so `cat` on the missing file fails the pipeline and `-e` aborts the step — after npm publish already succeeded. The adjacent `curl` has `|| true`; the `cat` does not.
- **Trigger:** Push a stable `vX.Y.Z` tag whose CHANGELOG.md has no `## [X.Y.Z]` heading (nax's own `packages/nax/scripts/release.ts` bump flow writes only `package.json`, never the changelog) — the release run goes red and no notification is sent.

### 32. `check-import-cycles` misses side-effect static imports

- **File:** `packages/repo-tooling/scripts/check-import-cycles.ts:76, 226-232`
- **Proof:**
  ```ts
  // :76 — the regex requires `from`
  const STATIC_IMPORT_RE = /^[ \t]*((?:import|export)\s+(?:type\s+)?[A-Za-z0-9_$*,{}\s]*?)from\s+["']([^"']+)["']/gm;
  ```
  ```ts
  // :226-232 — the only edge-extraction path
  for (const match of content.matchAll(STATIC_IMPORT_RE)) {
    if (isTypeOnlyImport(match[1] ?? "")) continue;
    const spec = match[2];
    if (!spec) continue;
    const target = resolveSpecifier(rootDir, file, spec);
    if (target) deps.push(target);
  }
  ```
- **Why:** A bare `import "./x";` — a value import that executes at module init and fully participates in ESM initialisation order — produces no graph edge. A cycle `a.ts: import "./b"` / `b.ts: import "./a"` yields an empty SCC, and the gate prints `[OK] 0 modules in runtime import cycles`, contradicting the header's stated "complete answer" guarantee. Dynamic `import()` exclusion is defensible (lazy); side-effect static imports are not. Latent today (the only side-effect-shaped hit in `src/` is template text in `acceptance/generator-helpers.ts:40`), but the next runtime cycle written this way ships green and reproduces the crash class this gate exists to stop.
- **Trigger:** A future runtime cycle written with side-effect imports passes the gate.

### 33. `test:e2e` script requires GNU coreutils `timeout`, absent on stock macOS

- **File:** `packages/nax/package.json:61`
- **Proof:**
  ```json
  "test:e2e": "timeout -k 5s 180s bun test test/e2e/ --timeout=60000",
  ```
- **Why:** `timeout` is a GNU coreutils binary macOS does not ship (brew installs it as `gtimeout`). Every other runner script in this package (`run-tests.ts`, `check-coverage.ts`, `test-fast.ts`) implements its wall-clock cap in-process precisely so it is portable, but `test:e2e` shells out to `timeout`. CI only exercises it on ubuntu, so the breakage is invisible until a macOS contributor hits it.
- **Trigger:** `bun run test:e2e` on macOS (the documented dev OS here — darwin) fails with `command not found: timeout` before any test executes.

---

## Verified-intentional (checked, not findings)

These candidate issues were chased and confirmed as documented, tested intent — listed so future reviews don't re-derive them:

- Spin-stop terminal round trip leaving one call unanswered (`turn-tool-batch.ts:130-136`, nax#2120)
- Invalid-call budget halt leaving no tool-result (`turn-tool-batch.ts:165-170`, nax#2047)
- `before_turn` seed replacing the prompt (`turn-loop.ts:54-66`)
- Tool events omitted for cancelled/spin-stopped calls (`turn-event.ts:19-22`)
- US-004 guard fail-open (documented contract); raw-mode screen fail-open on unmodelled `cd` (documented asymmetry)
- `readApprovalsFile` read-as-empty semantics for *lookups* (documented; only the append path misuses it — see #16)
- `handlePipelineFailure`'s skip arm not persisting the PRD (only producer saves it itself)
- Shallow `{ ...ctx.prd }` copies in `tier-outcome.ts` (benign — shared-mutation agreement with caller)
- `runAcceptanceLoop` not re-running the diagnose/fix fan-out after a failed final check (retry budget delegated, tested)
- Webhook (127.0.0.1 bind, HMAC `timingSafeEqual`, bounded body, replay-proof IDs), Telegram (chat-id gating, exact callback-id match), MCP (fail-closed lock, memoized connects), trust store (fail-closed, atomic 0600 writes, separator-safe `covers()`)
- `npm view --json` E404-on-stdout behavior in release.yml bootstrap detection (reproduced correct); tag/version regex neutralizes `workflow_dispatch` tag injection
- Dead `RectifierPromptBuilder` statics (documented deprecated-in-progress, no production callers)
