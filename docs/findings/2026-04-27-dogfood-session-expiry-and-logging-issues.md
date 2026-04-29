# Dogfood findings — session expiry, logging gaps, and prompt-audit gaps

**Date:** 2026-04-27
**Reporter:** williamkhoo
**Run log:** `/home/williamkhoo/Desktop/projects/nathapp/nax-dogfood/fixtures/hello-lint/.nax/features/hello-lint/runs/2026-04-27T13-29-07.jsonl`
**Prompt-audit dir:** `/home/williamkhoo/Desktop/projects/nathapp/nax-dogfood/fixtures/hello-lint/.nax/prompt-audit/hello-lint/`
**nax version:** v0.64.0-canary.1 (a261e01f)
**Related findings:** `2026-04-27-post-adr-018-019-dogfood-issues.md` (Issues 1–4)

Secondary analysis of the same run log after Issues 1–4 were resolved. Five new issues found; the remaining anomalies in the log are symptoms of the already-fixed issues.

---

## Issue A — Reviewer sessions expire during autofix; retry hits dead session and wastes an attempt

**Severity:** Medium  
**Log lines:** 170–211

### Observed behaviour

After ~3 minutes of autofix (attempts 1 and 2), the acpx reviewer sessions for both
`reviewer-adversarial` and `reviewer-semantic` expired on the server. When the second
post-autofix review ran:

1. Both reviewers went straight to `Session turn 1/1` **without calling `openSession`**
   (no "Permission mode resolved" log appears, unlike round 1 at line 95 and round 3 at
   line 244).
2. Both received exit code 4 (`NO_SESSION`), lines 174, 182, 196, 204.
3. The built-in single retry replayed the same dead session handle — same failure.
4. Both reviewers `fail-open` (lines 187, 209).
5. The `fail-closed-on-ambiguity` guard (line 211) correctly refused to treat fail-open as
   a pass, but had to trigger a 3rd autofix attempt to get a clean review signal.

Round 3 (line 244) correctly called `openSession`, resumed the session, and both reviewers
succeeded. The 3rd attempt was not needed to fix the implementation — it was only needed
because round 2's review was ambiguous.

**Cost:** one wasted autofix attempt (~4 extra minutes, extra LLM spend).

### Root cause

The legacy `agentManager.run` keepOpen path has a state-dependent gap. After round 1's
review closes the sessions to `COMPLETED` (session state machine transitions at lines 185
and 207), round 2's dispatch skips `openSession` — the calling code treats `COMPLETED` as
"still resumable without re-opening." The underlying acpx session has expired. Round 3
triggers `openSession` by some different path (possibly a state reset from the autofix
attempt clearing the session handle), which is why it works.

The immediate failure mode is in the adapter: when `sendTurn` receives exit code 4
(`NO_SESSION`), the existing retry loop retries the same dead handle rather than
re-creating the session first.

### Fix direction

`AcpAgentAdapter.sendTurn` should detect exit code 4 and re-create the session (call
`openSession` again) before the retry, rather than replaying to the same handle. This fix
is independent of ADR-019 and applies to both the legacy and callOp paths.

A secondary hardening: the session state machine should refuse to `sendTurn` on a session
in `COMPLETED` state without an intervening `openSession`, so the bug surfaces as a clear
error rather than a silent dead-session retry.

---

## Issue B — storyId missing from middleware log for second acceptance pre-run LLM call

**Severity:** Low (logging convention gap)  
**Log lines:** 30, 38

### Observed behaviour

The first acceptance-generation LLM call logs `storyId: "US-001"` in its middleware data
(line 23). The second call — the refinement/implementation step that writes the actual
test bodies — is missing `storyId` entirely (lines 30 and 38).

```jsonl
// line 23 — correct
{"stage":"middleware","message":"Agent call start","data":{"storyId":"US-001","runId":"b76b6191...","kind":"complete","stage":"acceptance"}}

// line 30 — missing storyId
{"stage":"middleware","message":"Agent call start","data":{"runId":"b76b6191...","kind":"complete","stage":"acceptance"}}
```

The project convention (enforced by `project-conventions.md` and `docs/architecture/`)
requires `storyId` as the **first key** in every pipeline-stage log call so that parallel
runs can be correlated in JSONL output.

### Root cause

The second acceptance-setup LLM call is dispatched through a different code path than the
first. The `storyId` is not threaded into the callOp / `completeAs` options at that call
site.

### Fix direction

Locate the second LLM call in `src/pipeline/stages/acceptance-setup.ts` (or the helper it
delegates to) and ensure `storyId` is passed in the call options so the middleware
middleware picks it up and includes it in both the start and complete log entries.

---

## Issue C — Prompt audit: txt files not written for entries without a session name

**Severity:** Medium (audit completeness gap)  
**Prompt-audit entries affected:** 1, 2, 4, 7, 8, 9, 10 (7 of 10 entries)

### Observed behaviour

The prompt-audit directory for the run contains only **3 txt files** — one each for the
implementer, reviewer-adversarial, and reviewer-semantic sessions:

```
1777301912062-nax-07a92405-hello-lint-us-001-implementer.txt
1777301982736-nax-07a92405-hello-lint-us-001-reviewer-adversarial.txt
1777302009970-nax-07a92405-hello-lint-us-001-reviewer-semantic.txt
```

The JSONL contains **10 entries**, of which 7 have full `prompt` + `response` content but
no `sessionName` field and therefore never get a txt file:

| Entry | stage | callType | sessionName | prompt | response |
|:------|:------|:---------|:------------|:-------|:---------|
| 1 | acceptance | complete | — | ✓ | ✓ |
| 2 | acceptance | complete | — | ✓ | ✓ |
| 4 | run | run | — | ✓ | ✓ |
| 7 | acceptance | complete | — | ✓ | ✓ |
| 8 | acceptance | complete | — | ✓ | ✓ |
| 9 | acceptance | complete | — | ✓ | ✓ |
| 10 | acceptance | complete | — | ✓ | — |

Entry 10 captured the prompt but no response — this is the crashed regen call from Issue 4
(CALL_OP_NO_RUNTIME was thrown before any LLM response was received). A txt file is still
useful here for debugging what prompt was sent.

### Three call paths that produce sessionName-less entries

**1. Acceptance-setup calls (entries 1, 2, 7, 8, 9, 10)**  
`acceptanceSetupStage` dispatches LLM calls via `completeAs`, which is a one-shot
(no persistent session). No session name is associated with these calls.

**2. Outer hop / callOp record (entry 4)**  
The `auditMiddleware` records at two layers for run-kind calls:
- **Inner (session-level):** carries `sessionName` + `turn` → entry 3 → gets txt ✓
- **Outer (hop/callOp-level):** carries `workdir` + `projectDir` + `featureName` but no
  `sessionName` → entry 4 → no txt ✗

The two entries are complementary (different metadata, slightly different durations). Both
should be human-readable.

### Root cause

`PromptAuditor.flush()` gates txt generation at
`src/runtime/prompt-auditor.ts:145`:

```typescript
if (!auditEntry.sessionName) continue;  // ← only 3 of 10 entries pass this gate
```

### Fix direction

Remove the `sessionName` gate. When `sessionName` is absent, derive a filename from
available metadata:

```
<ts>-<sessionName>.txt                          // existing (has sessionName)
<ts>-<callType>-<stage>[-<storyId>].txt         // fallback (no sessionName)
```

Examples:
- Entry 4 (outer hop): `1777301912262-run-run-US-001.txt`
- Entry 1 (acceptance with storyId): `1777301799524-complete-acceptance-US-001.txt`
- Entry 2 (acceptance, no storyId): `1777301880073-complete-acceptance.txt`
- Entry 10 (empty response): `1777302229409-complete-acceptance.txt` (write anyway — prompt is present)

---

## Issue D — Prompt audit: all entries buffered in memory and written only on flush

**Severity:** Medium (crash safety + memory)

### Observed behaviour

`PromptAuditor.record()` pushes each entry onto `this._entries[]` in memory.
`flush()` is called once from `runtime.close()` at the very end of the run and writes
everything to disk in a single shot.

Two consequences:

1. **Crash safety** — if the process is killed, OOM-killed, or the runner hits an
   unhandled exception before `close()` is reached, all buffered prompt/response data is
   lost. In the dogfood run, the acceptance regen crash (Issue 4) caused the runner's
   `finally` block to fire; `runtime.close()` was never confirmed to complete in that
   path.

2. **Memory growth** — long runs accumulate every prompt and response string in RAM.
   A 4-hour run with 200+ LLM calls (each with a multi-KB prompt and multi-KB response)
   can hold tens of megabytes in this buffer before flush.

### Root cause

The design writes eagerly-accumulated entries at shutdown rather than appending
incrementally. `Bun.write` (used today) is an overwrite API, so the current code cannot
append without buffering everything first.

### Fix direction

Switch to a **sequential write-queue** pattern so each `record()` call persists
immediately:

- `record()` enqueues a write task as fire-and-forget (`void`) — it stays synchronous
  from the caller's perspective.
- Each queued task **appends** one JSON line to the JSONL (via `fs.appendFile` or
  `Bun.file().writer()`) and writes the corresponding txt file.
- Tasks are chained through a `_queue: Promise<void>` field so appends are serialized
  and lines never interleave.
- `flush()` becomes `await this._queue` — it drains pending writes but does no I/O
  itself.
- The `_entries[]` buffer is eliminated entirely.

This makes every entry crash-safe from the moment `record()` returns, and the JSONL can
be `tail -f`-ed live while a run is in progress.

---

## Issue E — storyId missing from middleware log for second acceptance pre-run LLM call

**Severity:** Low (logging convention gap)  
**Log lines:** 30, 38

### Observed behaviour

The first acceptance-generation LLM call logs `storyId: "US-001"` in its middleware data
(line 23). The second call — the refinement/implementation step that writes the actual
test bodies — is missing `storyId` entirely (lines 30 and 38).

```jsonl
// line 23 — correct
{"stage":"middleware","message":"Agent call start","data":{"storyId":"US-001","runId":"b76b6191...","kind":"complete","stage":"acceptance"}}

// line 30 — missing storyId
{"stage":"middleware","message":"Agent call start","data":{"runId":"b76b6191...","kind":"complete","stage":"acceptance"}}
```

This also surfaces in the prompt-audit JSONL: entries 2 and 8 (both the second call in
their respective acceptance-setup invocations) are missing `storyId`, while entries 1, 7,
and 9 have it.

The project convention (enforced by `project-conventions.md`) requires `storyId` as the
**first key** in every pipeline-stage log call so that parallel runs can be correlated in
JSONL output.

### Root cause

The second acceptance-setup LLM call is dispatched through a different code path than the
first. The `storyId` is not threaded into the `completeAs` / callOp options at that call
site.

### Fix direction

Locate the second LLM call in `src/pipeline/stages/acceptance-setup.ts` (or the helper it
delegates to) and ensure `storyId` is passed in the call options so the middleware picks it
up and includes it in both the start and complete log entries.

---

## Anomalies in the log that are already fixed

The following entries appear in the log but are caused by Issues 1–4 (all resolved):

| Log lines | Symptom | Fixed by |
|:---|:---|:---|
| 52, 57 | Doubled detect cache path (`hello-lint/home/.../hello-lint`). `TestCoverageProvider` passed absolute `packageDir` to `resolveTestFilePatterns`; `join(repoRoot, absolutePackageDir)` concatenated the path instead of resolving it. | Issue 2 / PR #763 |
| 104, 125, 176, 198, 255, 268 | `LLM call complete (legacy)` on both reviewers. `runtime` was absent from the execution-layer `PipelineContext`; reviewers fell back to the deprecated `agentManager.run` path. | Issues 3+4 / PR #761 |
| 312–324 | Acceptance regen abandoned in ~2 ms. `acceptanceSetupStage` threw `CALL_OP_NO_RUNTIME` immediately because `runtime` was missing from `acceptanceContext`; the error propagated out of the acceptance loop and triggered the runner's `finally` block before any LLM call was made. Story was already marked `passed` so no user-visible error was surfaced. | Issue 4 / PR #761 |

## Noise / expected behaviour

| Log lines | Entry | Why it is expected |
|:---|:---|:---|
| 298–299 | `closeStory` finds reviewer sessions in `RUNNING` state | After the adapter close fails (exit code 1 — acpx session already gone), `SessionManager` cannot transition to `COMPLETED`. `closeStory` force-closes the in-memory state; acpx side was already clean. No data loss. |
| 305 | `semgrep binary not found in PATH` | The semgrep plugin was loaded from config but the binary is not installed in the dogfood environment. The plugin correctly defers to end-of-run and skips gracefully. |
| 210, 270, 288 | `Plugin reviewers deferred — skipping per-story execution` | Expected for deferred plugins; they run at end-of-run instead. |
