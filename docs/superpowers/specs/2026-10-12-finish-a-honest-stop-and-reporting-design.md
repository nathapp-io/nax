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
| `stepMs` | deprecated | see below |

`stepMs` is a benign rename (config-patterns.md, "Migrating Deprecated Keys"). A migration shim in the config loader copies a non-null `stepMs` into `reviewMs` and `fixMs` (only where those are unset) and logs a deprecation warning. The schema keeps `stepMs` accepted until the shim is removed. `phase.ts` passes `reviewMs` to the review ops and `fixMs` to the fix op, replacing today's `stepMs ?? undefined`.

The advisor's own call budget is unchanged; it is not a finish step.

### 3.2 Making the stop real

**Step 1 (first task, test first): find where the signal is dropped.** Write a failing test that aborts the finish phase signal during a running native session turn, and assert the turn ends. Trace `callOp` → agent manager → `manager-run-fallback.ts` hop → nax `NativeAgentAdapter` → nax-agent `sendTurn(opts.signal)`. Fix the link that drops it. Check the fallback hop too: on the 10-11 runs every review and fix call first failed on its primary model and swapped agents.

**Pass mark:** a running review or fix session ends within 30 s of its step limit or of `flowMs`. Measured in an integration test with a fake model client that streams slowly.

**Step limits use the same mechanism.** A step limit is an `AbortSignal.timeout(reviewMs | fixMs)` combined with the phase signal through `AbortSignal.any`. It is not the op's `timeoutMs` alone, which today maps to the agent's call timeout and has the same in-flight problem.

**Commit guard.** `fixRound`, and the acceptance and gate fix equivalents, check the step signal and the phase signal after `ops.fix` returns and before `commitFixes`. An aborted step goes to §4 and never commits.

### 3.3 What each limit does

| Limit | Behaviour |
|---|---|
| `reviewMs` | That lens is `missing` for the round (existing A4 rule). The loop continues. |
| `fixMs` | The fix attempt counts as used. Its edits are set aside with a handoff (§4), and its findings become `set-aside`. The loop continues: the next fix attempt, if the caps allow one, continues from the handoff (§4.3). |
| `flowMs` | The current step is stopped. A fix in flight is set aside (§4). Finish goes to resolution with the facts so far and finalizes a draft with a fresh 60 s signal for forge calls (existing A4 rule, §3.1 of the A4 spec). |
| Run aborted (SIGINT, cancel) | Unchanged: `failed`, reason `aborted`, no PR call. A fix in flight is still set aside, so the worktree is left clean. |

Every stop appends to `state.stops`: `{ kind: "review" | "fix" | "flow", step, lens?, phase?, at, limitMs, handoff? }`.

## 4. Setting a stopped fix session's edits aside

A stopped fix session's edits are never committed to the branch. They are kept for the next attempt in the same run, or for `--resume` (E).

### 4.1 At fix-session start

Record `{ baseSha: HEAD, untrackedBefore: string[] }` on the fix attempt (`git status --porcelain=v1 -uall`, untracked entries only).

### 4.2 When a fix session is stopped

1. **Cut the running turn and keep the session open.** The step or phase signal aborts the turn. The session is not closed yet.
2. **Ask for a handoff note.** Send one more turn with a 2-minute cap (`HANDOFF_TURN_MS = 120_000`, a named constant). The prompt is built by a new method on the finish prompt builder (`src/prompts/builders/`, Prompt Builder Convention): for each finding it was given, report `done | partial | not-started`, the files touched, and what remains. The reply is parsed with `parseLLMJson`. Expected shape: `{ findings: [{ index, status, files, remaining }] }`. A timeout, an error or a malformed reply skips the note; the stop continues. The turn runs under the same permissions as the fix session but is told not to edit. Any edit it makes anyway is included in the patch.
3. **Close the session.**
4. **Save the handoff** to `<outputDir>/finish-audit/<feature>/<runId>.handoff-<n>/`, where `n` counts handoffs in this run:
   - `changes.patch`: `git diff --binary <baseSha>` for tracked files, plus untracked files created since `untrackedBefore`. Built with `git add -N` on only those new paths, then `git diff`, then `git reset` on those paths.
   - `note.json`: the parsed handoff note, when there is one.
   - `meta.json`: `{ baseSha, phase, findingIds, limit: "fix" | "flow", stoppedAt, newUntracked }`.
5. **Restore the worktree.** `git restore --source=<baseSha> --staged --worktree -- .` for tracked files. Delete only the paths in `newUntracked`. Never run `git clean`: a user's untracked files (`.env`, local notes) must survive.
6. **Write a checkpoint** (§4.4).

Failures in steps 2–5 are logged with `storyId: "_run"` and never stop finish. If the patch cannot be written, the worktree is still restored, and the stop's reason says the work was lost.

### 4.3 Next attempt in the same run

When a later fix attempt in the same phase starts while a handoff from this run is pending:

1. `git apply --3way` the latest `changes.patch`. If it does not apply cleanly, restore the worktree, start the attempt from scratch, and keep the handoff on disk. The PR lists it as "set aside, not re-applied".
2. The fix prompt gains a "continuing earlier work" section: the note's per-finding status, or "no note" when it was skipped, and the list of files already changed.
3. If this attempt commits, the commit includes the re-applied edits. Those findings move through the normal ledger states (§5), and the handoff is marked `consumed` in its `meta.json`.

### 4.4 Checkpoints

After every completed step (acceptance run or fix, review round, gate run or fix, resolution), `serializeFinishState(state)` is written atomically to `<outputDir>/finish-audit/<feature>/<runId>.checkpoint.json` (temp file + rename). `FinishState.version` goes from 2 to 3 because the new fields (`stops`, the ledger, handoffs) change the shape. `deserializeFinishState` rejects version 2 as it does today for unknown versions. Nothing reads checkpoints in A: they exist for E.

### 4.5 Finalize

`finalizeDraftPr` no longer commits a tree left dirty by a stopped session: §4.2 has already restored it. If the tree is still dirty at finalize (for example a gate's auto-fix), behaviour is unchanged: commit with hooks off and record the commit as unreviewed. If a stop's restore failed and left the tree dirty, finalize sets that dirt aside as one more handoff (§4.2 steps 4–5, no note) instead of committing it.

## 5. One state per finding

`state.review` gains a ledger, `findings: LedgerEntry[]`, with `{ id, finding, state, ref? }`. In A, `id` is `source|title|file` case-folded. B replaces this matching.

| State | Entered when | `ref` | Counts as |
|---|---|---|---|
| `open` | A review round raised it, or raised it again after it was fixed. | — | open |
| `fixed-unreviewed` | A committed fix attempt's disposition for it is `fixed`. | commit sha | not open; the sha is in `unreviewedFixCommits` |
| `fixed-reviewed` | A later round with **both** lenses present did not raise it again. | commit sha | resolved |
| `rejected` | The fixer's disposition is `rejected` with evidence. | evidence `file:line` | open, with the evidence shown |
| `set-aside` | Its fix attempt was stopped (§4). | handoff dir | open |
| `waived` / `superseded` | An advisor ruling. | `D-n` | resolved |
| `unresolved` | Advisor `hold` or fallback, or advisor off (existing A4 route). | `D-n` when ruled | open |
| `accepted` | An advisor `approve` that took it as residue. | `D-n` | `acceptedResidue` on a ready PR |

Rules:

- One function, `applyRound(ledger, roundEvent)`, makes every transition. The round-cap path and the deadline path both go through it, so they can no longer disagree.
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
- `ResolutionFacts` gains `findings: LedgerEntry[]` and `stops: Stop[]`. `findingsOpen` stays, derived from the ledger, for compatibility with the advisor approval question and existing readers.

## 7. PR body and `result.json` (#2469)

**PR body** (`finish/pr/body.ts`): in the Unresolved section, the open-findings list is replaced by one findings table. Columns: severity, title, file, state, ref. Rows are sorted by state (`open`, `rejected`, `set-aside`, `unresolved`, `fixed-unreviewed`), then by severity. Resolved entries (`fixed-reviewed`, `waived`, `superseded`) go in a collapsed `<details>` block after the table. Table cells use the existing `escapeTableCell`.

New sections:

- **Set aside:** one line per handoff: directory path, the limit that fired, finding count, `re-applied` or `not re-applied`, and "resume with `nax finish -f <feature> --resume`" once E ships. Until then the line points to the patch file.
- **Stops:** one line per stop.

**`result.json`:** `facts.findings` and `facts.stops` (from §6), plus `handoffs: { dir, limit, findingIds, consumed }[]`. Existing fields keep their meaning.

## 8. Code changes

| Area | File(s) | Change |
|---|---|---|
| Signal propagation | to be found in §3.2 step 1 (likely the nax native adapter shell or the fallback hop) | pass the step and phase signal through to `sendTurn(opts.signal)` |
| Config | `config/schemas.ts`, config loader shim, `config/runtime-types-finish.ts`, `config/selectors.ts` (the `stepMs` comment at ~L148), `finish/config.ts` (`DEFAULTS` and the settings mapping) | `reviewMs`, `fixMs`, new `flowMs` default, `stepMs` shim; `operations/finish-fix.ts`'s `stepMs` comment updated |
| Step signals | `finish/phase.ts`, `finish/ops-impl.ts` | per-call `AbortSignal.any([phase, timeout])` for review and fix ops |
| Commit guard and set-aside | `finish/review-loop.ts`, `finish/acceptance-loop.ts`, `finish/gates-loop.ts`, new `finish/set-aside.ts` | abort check before commit; §4 flow |
| Handoff turn | new op or extension of `operations/finish-fix.ts`; new prompt builder method | §4.2 step 2 |
| Ledger | new `finish/ledger.ts`, `finish/state.ts` (version 3), `finish/types.ts` | §5 |
| Checkpoints | `finish/state.ts`, `finish/audit.ts` | §4.4 |
| Facts and reasons | `finish/resolve.ts`, `finish/machine.ts` | §6 |
| PR body | `finish/pr/body.ts`, `finish/pr/context.ts` | §7 |
| Finalize | `finish/ops-impl.ts` `finalizeDraftPr` | §4.5 |

Files near the 600-line limit are split rather than grown (`check:file-sizes` ratchet).

## 9. Testing

Unit tests use the shared `test/helpers/finish-machine.ts` and `_deps` injection.

1. **Signal propagation:** aborting the phase signal ends a running native turn within the pass mark, including after an agent swap. Written first and failing on main.
2. **Step limits:** `reviewMs` marks the lens missing; `fixMs` triggers set-aside; both ride on the phase signal.
3. **Commit guard:** a fix that returns after an abort is never committed.
4. **Set-aside:**
   - the patch contains tracked changes and new untracked files;
   - restore leaves the tree at `baseSha`;
   - an untracked file that existed before the session survives;
   - `git clean` is never invoked.
5. **Handoff turn:** a parsed note is saved; a timeout or malformed reply skips the note and the stop still completes.
6. **Next attempt:**
   - the patch re-applies cleanly and the prompt carries the note;
   - a conflicting patch falls back to a fresh start and the handoff is kept;
   - after a commit the handoff is marked consumed.
7. **Ledger:**
   - every transition in the §5 table;
   - the round-cap path and the deadline path give identical states for the same events;
   - a missing disposition stays open.
8. **Facts:** coverage is not null after a completed round on the deadline path; the `not-run` gate wording; the state-count reason; the stop reasons.
9. **PR body:** table sort order and the collapsed resolved block; Set aside and Stops sections; cell escaping.
10. **Config:** the `stepMs` shim fills both keys and warns; new defaults.
11. **Checkpoint:** written after each step; round-trips through version 3; version 2 rejected.
12. **Unchanged outcomes:** a regression test re-runs the A4 resolution table (clean → ready; open, unreviewed or not-green → draft or advisor) against ledger-derived facts.

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
