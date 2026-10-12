# Finish A: honest stop and reporting

**Issues:** #2461, #2462, #2463, #2469. **Status:** design agreed 2026-10-12, spec for review.
**Part of:** the finish follow-up series A → B → C → D → E (see §10).

## 1. Problem

Three live A4 finishes ran on 2026-10-11 with the advisor and `nax-finish-native`:

| Run | Finish time | Outcome | What went wrong |
|---|---|---|---|
| 9-story monorepo feature | 115 min | draft, `deadline` | A fix session started 3 min before the 90-min deadline. It ran 25 min past it, and its edits were committed by finalize. 11 of the 12 "open" findings were in fact fixed in that commit. Coverage was `null`. Reason text: "gates red: gates", for gates that never ran. |
| 7-story runner feature | 98 min | draft, `deadline` | The last review lens returned 7.5 min after the deadline and only then reported "aborted". Coverage was `null` after three completed review rounds. |
| 4-story nax feature | 62 min | draft, advisor hold | Correct. Used as the A4 go-live pass. |

The time went to fix sessions, not reviews. Reviews took 2–9 min per lens. Fix sessions took 2–38 min: one handled 13 findings in 232 model calls. Measured from the cost ledger's per-session `ts` and `durationMs`.

Root causes in the code (main `5170a8150`):

1. **The deadline does not stop running sessions.** `phaseSignal` (`finish/phase.ts`) reaches `callCtx.signal` and each agent hop's `request.signal`. In-flight calls still only end when they return on their own. The native adapter merges `opts.signal` into a per-turn `turnController` (`nax-agent/src/native/session-adapter.ts`), so the signal is lost somewhere between finish and that `opts.signal`.
2. **A fix that returns after the deadline is still committed.** `fixRound` (`finish/review-loop.ts`) calls `commitFixes` with no abort check after `ops.fix` returns.
3. **Finalize commits a stopped session's half-edited tree on purpose.** `finalizeDraftPr` (`finish/ops-impl.ts`): "a deadline can leave a killed fix session's half-edited tree here". That commit is the store-erp `68e7c21`.
4. **The same situation is reported two ways.** A fix committed in the last allowed round clears `lastFindings` and records the commit as unreviewed. A fix followed by a deadline throw leaves `lastFindings` listed as open.
5. **The deadline path loses coverage.** `recoverAfterThrow` calls `currentFacts(state, [])`, and `coverageOf` returns `null` for an empty changed-file list (#2461).
6. **Gates that never ran are rendered as a gate named "gates".** `NOT_RUN_GATE` has `{ name: "gates", status: "red" }`, and `draftReason` lists red gate names (#2463).
7. **Per-step limits are effectively off.** `finish.timeouts.stepMs` defaults to `null`, so review and fix sessions fall back to the agent's 3600 s per-call limit. Only the 90-min `flowMs` bounds them.

## 2. Goal and scope

**Goal:** finish stops when a time limit says so. Nothing half-done reaches the PR. The draft PR states exactly what is left, why, and where set-aside work is kept.

**In scope:** time limits that really stop work (§3), setting a stopped fix session's edits aside with a handoff (§4), one state per finding (§5), facts and reasons (§6), PR body and `result.json` (§7).

**Unchanged:** the ready/draft decision. `isClean`, `approvalFacts` and `resolve` keep their rules: unreviewed fix commits, open findings, missing lenses and non-green gates or acceptance all keep a PR a draft. Advisor callers, menus and ledger schemas are untouched.

**Out of scope:** finding identity across lenses and rulings (B), delta re-review and deadline-aware scheduling (C), CI watch (D), the `--resume` command (E).

## 3. Time limits that stop work

### 3.1 Config (`finish.timeouts`, `config/schemas.ts`)

| Key | Default | Covers |
|---|---|---|
| `acceptanceMs` | 600 000 (10 min), unchanged | each acceptance test run |
| `gateMs` | 900 000 (15 min), unchanged | each gate command |
| `reviewMs` **new** | 900 000 (15 min) | each review op call (one lens) |
| `fixMs` **new** | 1 200 000 (20 min) | each fix session (acceptance, review or gate fix) |
| `flowMs` | **10 800 000 (3 h)**, was 5 400 000 | the whole finish phase; a backstop |
| `stepMs` | removed | migrated by a shim (below) |

`stepMs` is a benign rename (config-patterns.md, "Migrating Deprecated Keys"). A migration shim in the compat-shim chain (it runs on every config layer before parsing) copies a numeric `stepMs` into `reviewMs` and `fixMs` where those are unset, logs a deprecation warning, and removes the key. The schema no longer declares `stepMs`. The shim runs before Zod parses, so Zod's silent stripping never sees the key.

The advisor's own call budget is unchanged; it is not a finish step.

### 3.2 Two kinds of stop

nax already has two ways to end a running agent turn:

- **Hard abort**: the turn's `opts.signal` aborts. `SessionManager.sendPrompt` marks the session cancelled, and every later send throws `SESSION_CANCELLED` (`session/manager.ts`). For ACP, the session itself is closed through `linkRunSignal`.
- **Soft cancel**: the idle watchdog invokes the cancel the adapter registered through `onActiveCall`. `sendPrompt` classifies that as a retriable `fail-stale` and does **not** mark the session cancelled, so the session stays warm and accepts the next turn with its conversation intact. This is what the stale-retry hop relies on (nax#2218). Both transports support it: ACP surfaces `SessionTurnError(cancelled)`, native a plain `AbortError`.

A turn ends under either kind once the signal is honoured. Today neither reaches the turn, because of the root cause below.

**Root cause (fixed first).** `buildRunDispatchOptions` (`operations/call-run-options.ts`) never sets `abortSignal` on the run options, and every hop sends its turn with `signal: resolvedRunOptions.abortSignal`, which is therefore `undefined`. The call's signal is only checked after the hop returns (`call-dispatch-run.ts`). Threading it through fixes hard aborts for every run-kind op. It also reaches `openSession`, so an ACP session opened under a call signal is closed when that signal aborts. That is the intended behaviour for review lenses, and the reason the fix session must not be opened under its step signal (below).

**Which stop each step uses:**

| Step | Op-level signal (hard) | Interrupt (soft) |
|---|---|---|
| Review lens | phase signal + `reviewMs` | — |
| Fix session | the run's own signal only (Ctrl-C) | phase signal + `fixMs` |

**Soft interrupt API.** `SessionManager.interruptTurn(sessionName)` invokes the registered cancel of every active call of that session, through the same `WatchdogCancelTracker` bookkeeping the watchdog uses. The turn ends as `fail-stale` with reason `interrupted`, and the session stays usable. A hop body's `send(prompt, { interrupt })` calls `interruptTurn` when `interrupt` aborts during that turn. The soft cancel needs the runtime's watchdog controller registry (always present in a real run). Without it, `interruptTurn` returns `false` and the fix session simply runs until its turn ends; the op's own `timeoutMs` (below) still bounds it.

**Agent timeouts must not race the step limits.** The op's `timeoutMs` becomes the agent session's `timeoutSeconds`, and a `fail-timeout` is retried without checking the abort signal. So review ops get `timeoutMs = reviewMs + STEP_TIMEOUT_MARGIN_MS`, and fix ops get `timeoutMs = fixMs + HANDOFF_TURN_MS + STEP_TIMEOUT_MARGIN_MS` (`STEP_TIMEOUT_MARGIN_MS = 60_000`). The step limit always fires first.

**An aborted hop never swaps agents.** `runWithFallback` returns the result as-is, without marking the agent unavailable or swapping, when `request.signal` is aborted. Today an aborted turn reads as `fail-adapter-error`, which can swap when `fallback.onQualityFailure` is on.

**Pass mark:** a running review or fix turn ends within 30 s of its limit or of `flowMs`. The 2-minute handoff turn (§4.2) is a separate, bounded step after that.

**Commit guard.** `runFixStep` (§4) checks the interrupt and the phase signal after `ops.fix` returns and before any commit. A stopped step never commits.

### 3.3 What each limit does

| Limit | Behaviour |
|---|---|
| `reviewMs` | That lens is `missing` for the round, whether it was cut off or returned late (existing A4 rule). The loop continues. |
| `fixMs` | The fix turn is soft-interrupted, the same session writes a handoff note (§4.2), and the edits are set aside (§4). The attempt counts as used, its findings become `set-aside`, and the loop continues. The next fix attempt continues from the handoff (§4.3). |
| `flowMs` | A review lens is hard-aborted. A fix session is soft-interrupted, writes its handoff note, and is set aside. Then finish goes to resolution with the facts so far and finalizes a draft. |
| Run aborted (SIGINT, cancel) | Unchanged: `failed`, reason `aborted`, no PR call. A fix in flight is hard-aborted (no note) and still set aside, so the worktree is left clean. Recorded as a `run` stop, never as `flow`. |

Every stop appends to `state.stops`: `{ kind: "review" | "fix" | "flow" | "run", step, lens?, phase?, round?, at, limitMs, handoff?, findings? }`. A `flowMs` deadline that lands outside a fix session (during a review lens, acceptance or gates) is recorded by the machine's recovery path, with the step and review round it interrupted.

## 4. Setting a stopped fix session's edits aside

A stopped (or crashed) fix session's edits are never committed to the branch. A stopped session's edits are kept for the next attempt in the same run, or for `--resume` (E).

### 4.1 At fix-session start

Record the base: `baseSha = git stash create || HEAD`, a commit object of the current worktree state that neither moves the branch nor touches the stash list, so pre-existing tracked edits (a gate's auto-fix, a user's edit) are part of the base and are never overwritten. Also record `untrackedBefore` (`git status --porcelain=v1 -uall`, untracked entries only, so gitignored files are never included) and `headSha`. Snapshot those pre-existing untracked files into `<outputDir>/finish-audit/<feature>/<runId>.fix-base/`, up to 1 MB per file and 20 MB in total. Every file's size and mtime are recorded, so a change is detectable even when it was too big to copy. The base is kept on the state (`state.lastFixBase`) until the step settles. If the base cannot be read (git fails), the step fails without running the fixer.

### 4.2 When a fix session is stopped

1. **Interrupt the running turn, keep the session.** `fixMs` or `flowMs` aborts the step's interrupt signal. The send closure calls `SessionManager.interruptTurn`, the turn ends as `fail-stale` (`interrupted`), and the session stays warm.
2. **Ask for a handoff note in the same session.** The fix op's `hopBody` catches that `fail-stale` (only when its own interrupt fired; a real watchdog stall is rethrown and retried as today) and sends one more turn, capped at `HANDOFF_TURN_MS = 120_000`, with a prompt built by `buildFinishHandoffPrompt` (`src/prompts/builders/`): for each finding it was given, report `done | partial | not-started`, the files touched, and what remains, and do not edit. The reply is the hop's normal output, marked as a handoff. `parse` reads it with `tryParseLLMJson` into `FixOutcome.handoffNote` and sets `FixOutcome.interrupted`. If the handoff turn fails or is malformed, the outcome is still `interrupted`, with no note. The op never rethrows the interrupt, so the stale-retry never re-runs a stopped fix.
3. **Close the session** (the fix op's lifetime is `fresh`).
4. **Save the handoff** to `<outputDir>/finish-audit/<feature>/<runId>.handoff-<n>/`:
   - `changes.patch`: `git diff --binary <baseSha>` for tracked files, plus the untracked files created since `untrackedBefore` (added with `git add -N` for the diff, then reset);
   - `note.json`: the parsed note, when there is one;
   - `meta.json`: `{ baseSha, headSha, phase, findingIds, limit: "fix" | "flow" | "run" | "error", stoppedAt, newUntracked, restored }`.
5. **Restore only what the session changed.**
   - `git restore --source=<baseSha> --staged --worktree -- <paths>` for the tracked files in the patch that the base knows; files the session `git add`ed are unstaged and removed.
   - Delete the untracked files in `newUntracked`.
   - A pre-existing untracked file the session changed keeps its edit in `untracked-modified/` in the handoff and is put back from the snapshot. One with no snapshot (over the cap) is moved into the handoff instead. Either way, `git add -A` can never commit the half-edit; the PR lists any moved file.
   - Never `git clean`, never `reset --hard`. Untouched untracked files (`.env`, local notes) and pre-existing tracked edits survive.
6. **Write a checkpoint** (§4.4).

A fixer that **crashes** (an error that is not a stop) is set aside the same way with `limit: "error"` and no note, but is not offered to the next attempt. This keeps the A4 rule that a failed fix "changed nothing", and keeps the tree at the base for the next step.

Failures in steps 4–5 are logged with `storyId: "_run"` and never stop finish. `meta.json` records `restored: false` when the restore failed. If the patch cannot be written, the worktree is still restored, and the stop's reason says the work was lost.

### 4.3 Next attempt in the same run

When a later fix attempt in the same phase starts while a stopped (`fix` or `flow`) handoff from this run is pending:

1. `git apply --check` the latest `changes.patch` against the current tree. If it applies, `git apply` it (all-or-nothing, no `--3way`). If the check fails, nothing is touched: the attempt starts from scratch, and the PR lists the handoff as "set aside, not re-applied".
2. The fix prompt gains a "continuing earlier work" section: the note's per-finding status (or "no note"), and the files already changed.
3. If this attempt commits, the commit includes the re-applied edits, those findings move through the normal ledger states (§5), and the handoff is marked `consumed` in `meta.json`.

The base for this attempt is captured **before** the re-apply, so stopping it again sets aside the re-applied edits too.

### 4.4 Checkpoints

After every completed step (acceptance run or fix, review round, gate run or fix, resolution), `serializeFinishState(state)` is written atomically (temp file + rename) to `<outputDir>/finish-audit/<feature>/<runId>.checkpoint.json`. `FinishState.version` goes from 2 to 3. `deserializeFinishState` accepts only 3. Nothing reads checkpoints in A: they exist for E.

### 4.5 Finalize

`finalizeDraftPr` keeps committing a tree that is dirty for other reasons (for example a gate's auto-fix), with hooks off, recorded as unreviewed. The one exception: when a set-aside's restore failed (`restored: false`) and the tree is still dirty, finalize sets that dirt aside as one more handoff, using the base and `untrackedBefore` recorded at that fix session's start, instead of committing it.

## 5. One state per finding

`state.review` gains a ledger, `findings: LedgerEntry[]`, with `{ id, finding, state, ref? }`. In A, `id` is `source|title|file` case-folded. B replaces this matching.

| State | Entered when | `ref` | Counts as |
|---|---|---|---|
| `open` | A review round raised it, or raised it again after it was fixed. | — | open |
| `fixed-unreviewed` | A committed fix attempt's disposition for it is `fixed`. | commit sha | not open; the sha is in `unreviewedFixCommits` |
| `fixed-reviewed` | A later round with **both** lenses present did not raise it again. | commit sha | resolved |
| `rejected` | The fixer's disposition is `rejected` with evidence. | evidence `file:line` | open, with the evidence shown |
| `set-aside` | Its fix attempt was stopped or crashed (§4). | `handoff-n` | open |
| `waived` / `superseded` | An advisor ruling. | `D-n` | resolved |
| `unresolved` | Advisor `hold` or fallback, or advisor off (existing A4 route). | `D-n` when a decision exists (hold); none on fallback or advisor off | open |
| `accepted` | An advisor `approve` that took it as residue. | `advisor approval` (the approval path returns no decision id in A) | `acceptedResidue` on a ready PR |

Rules:

- One function, `applyLedgerEvent(ledger, event)`, makes every transition. The round-cap path and the deadline path both go through it, so they can no longer disagree.
- A finding with no disposition from a committed fix stays `open`. Fail-closed: a missing disposition is not a fix.
- `findingsOpen` (§6) = entries whose state counts as open.
- `lastFindings` and `unresolved` stay on `state.review` for the loop's own control flow. Reporting reads only the ledger.

## 6. Facts and reasons

- **Coverage (#2461):** `recoverAfterThrow` uses the review inputs' `changed` list when the inputs were already loaded (the value `resolveAndFinalize` passes). When the stop happened before `loadReviewInputs`, it calls `changedFiles(workdir, base)` (`finish/changed-files.ts`) itself. `changedFiles` already returns `[]` when git fails; that case logs a warning, and coverage is then `null` by definition (no review read anything).
- **Gates (#2463):** `GateFact.status` becomes `"green" | "red" | "not-run"`. `NOT_RUN_GATE` uses `"not-run"`. `gatesGreen` treats `not-run` as not green, so outcomes are unchanged. `draftReason` renders `gates not run` instead of listing a gate named `gates`.
- **Findings in the reason:** `draftReason` counts by state: `N open`, `M fixed in unreviewed commit <short sha>`, `K set aside (handoff-n)`. The 9-story run would read "1 open; 11 fixed in unreviewed commit 68e7c21" instead of "12 open finding(s)".
- **Stop reasons:** the bare `deadline` prefix is replaced by the first stop's text, plus `+N more stops` when there are more:
  - `fix session stopped at the 20 min limit (13 findings, handoff-1)`
  - `review (quality) stopped at the 15 min limit`
  - `finish time limit (3 h) reached during review round 2`
  - `run cancelled during gate`
- `ResolutionFacts` gains `findings: LedgerEntry[]` and `stops: Stop[]`. `findingsOpen` stays, derived from the ledger, for compatibility with the advisor approval question and existing readers.

## 7. PR body and `result.json` (#2469)

**PR body** (`finish/pr/body.ts`): in the Unresolved section, the open-findings list is replaced by one findings table. Columns: severity, title, file, state, ref. Rows are sorted by state (`open`, `rejected`, `set-aside`, `unresolved`, `fixed-unreviewed`), then by severity. Resolved entries (`fixed-reviewed`, `waived`, `superseded`) go in a collapsed `<details>` block after the table. Table cells use the existing `escapeTableCell`.

New sections:

- **Set aside:** one line per handoff: directory path, the limit that fired, finding count, `re-applied` or `not re-applied`, and "resume with `nax finish -f <feature> --resume`" once E ships. Until then the line points to the patch file.
- **Stops:** one line per stop.

**`result.json`:** `facts.findings` and `facts.stops` (from §6), plus `handoffs: { dir, limit, findingIds, consumed, reapplied? }[]`. Existing fields keep their meaning.

## 8. Code changes

| Area | File(s) | Change |
|---|---|---|
| Signal propagation | `operations/call-run-options.ts`, `operations/call-dispatch-run.ts` | thread the call's `abortSignal` onto the run options |
| No swap after abort | `agents/manager-run-fallback.ts` | return before `decideSwap` when `request.signal` is aborted |
| Soft interrupt | `session/watchdog-cancel-tracker.ts`, `session/watchdog-turn-classification.ts`, `session/manager.ts` (no net growth: frozen at its size baseline), `session/types.ts`, `test/helpers/mock-session-manager.ts` | `interruptTurn(sessionName)`; `fail-stale` reason `interrupted` |
| Send with interrupt | `operations/types.ts`, `operations/build-hop-callback.ts`, `operations/build-hop-callback-dispatch.ts`, `operations/call-dispatch-run.ts`, new `operations/send-interrupt.ts` | `send(prompt, { interrupt })` |
| Config | `config/finish-timeouts-shim.ts` (new), `config/compat-shims.ts`, `config/schemas.ts`, `config/runtime-types-finish.ts`, `config/selectors.ts`, `finish/config.ts`, `docs/guides/configuration.md` | §3.1 |
| Step signals | new `finish/step-signal.ts`, `finish/ops-impl.ts`, `finish/phase.ts` | review hard limit; fix interrupt; `timeoutMs` margins |
| Handoff turn | `operations/finish-fix.ts` (`hopBody`, `parse`), `prompts/builders/finish-review-builder.ts` | §4.2 step 2 |
| Set-aside | new `finish/set-aside.ts` | §4.1, §4.2, §4.3 |
| Fix step | new `finish/fix-step.ts`; `finish/acceptance-loop.ts`, `finish/gates-loop.ts`, `finish/review-loop.ts` | one wrapper for every fix session |
| Ledger | new `finish/ledger.ts`, `finish/advise.ts` (`dropped`), `finish/state.ts` (version 3) | §5 |
| Checkpoints | new `finish/checkpoint.ts`, `finish/machine.ts` | §4.4 |
| Facts and reasons | `finish/resolve.ts`, `finish/machine.ts`, `finish/gates-loop.ts` | §6 |
| PR body | `finish/pr/body.ts`, `finish/pr/context.ts`, `finish/ops-impl.ts` (`fallbackBody`) | §7 |
| Finalize | `finish/ops-impl.ts` `finalizeDraftPr`, `finish/commit.ts` (export `isDirty`) | §4.5 |

Files at or near their size limit are split rather than grown (`check:file-sizes` ratchet). New functions stay under the cognitive-complexity limit (`check:complexity`).

## 9. Testing

Unit tests use the shared `test/helpers/` factories and `_deps` injection; real git only in `test/integration/`.

1. **Signal propagation:** the call's signal reaches the run options; an aborted hop does not swap agents.
2. **Soft interrupt:** through the real `SessionManager` with a fake adapter: `interruptTurn` ends the turn as `fail-stale` (`interrupted`), the session is not cancelled, and a second `sendPrompt` on the same handle succeeds. Without a registry, `interruptTurn` returns `false`.
3. **Send with interrupt:** the interrupt calls `interruptTurn` once while the turn runs, and the listener is removed after.
4. **Step limits:** `reviewMs` marks the lens missing, whether cut off or late; `fixMs` interrupts and sets aside; the agent `timeoutMs` is the limit plus the margin.
5. **Handoff turn:** an interrupted fix sends the handoff prompt on the same session and returns `interrupted` with the parsed note; a failed or malformed handoff still returns `interrupted` without a note; a real watchdog stall (interrupt not fired) is rethrown.
6. **Commit guard:** a fix that returns after a stop is set aside, not committed.
7. **Set-aside** (real git, audit dir outside the repo):
   - the patch holds tracked changes and new untracked files;
   - restore touches only the session's paths;
   - a pre-existing tracked edit and a pre-existing untracked `.env` survive;
   - a pre-existing untracked file the session edited is put back from the snapshot, with its edit kept in the handoff; over the cap, it is moved into the handoff;
   - `git clean` and `reset --hard` are never invoked.
8. **Next attempt:** a clean re-apply carries the note; a patch that fails `--check` leaves the tree untouched and the handoff kept; after a commit the handoff is consumed.
9. **Crash:** a fixer error is set aside with `limit: "error"` and not re-applied; the gate loop counts it as an attempt.
10. **Ledger:** every transition in the §5 table; the round-cap path and the deadline path give identical states; a missing disposition stays open.
11. **Facts:** coverage not null on the deadline path; a flow stop outside a fix session is recorded with its step and round; the `not-run` gate wording; the state-count reason; the stop reasons; a run cancel records a `run` stop.
12. **PR body:** table sort order and the collapsed resolved block; Set aside and Stops sections; cell escaping.
13. **Finalize:** a restore-failed tree is set aside with the recorded `untrackedBefore`, and `.env` survives; otherwise dirt is committed as before.
14. **Config:** the `stepMs` shim fills both keys and warns; new defaults.
15. **Checkpoint:** written after each step; version 3 round-trips; version 2 rejected.
16. **Unchanged outcomes:** the A4 resolution table holds on ledger-derived facts.

## 10. The follow-up series

| | Sub-project | Issues |
|---|---|---|
| **A** | Honest stop and reporting (this spec) | #2461, #2462, #2463, #2469 |
| B | Rulings that stick | #2464 (both cases), #2468 |
| C | A finish that settles | #2465, #2467; fix-session size and acceptance-fix budget; failing primary model in finish config; parallel advisor questions |
| D | CI-aware finish | #2466 |
| E | `nax finish -f <feature> --resume` | new: load checkpoint, check HEAD, apply latest handoff, run the remaining loop |

## 11. Done when

- All §9 tests pass, and `check:all`, `typecheck` and the coverage gate are green.
- On a live finish (approval needed at launch) that hits a limit:
  - it stops within 30 s;
  - no unreviewed half-edit reaches the branch;
  - the handoff and the checkpoint are on disk;
  - the draft PR's reason and findings table match the ledger.
