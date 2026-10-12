# Finish B: rulings stick

**Issues:** #2464 (incl. its second, cross-lens case), #2468. **Status:** design agreed 2026-10-12, spec for review.
**Part of:** the finish follow-up series A → B → C → D → E. A (honest stop and reporting) merged as #2472.

## 1. Problem

Two live A4 finishes on 2026-10-11 (v0.87.0, advisor on) ended draft because an advisor ruling did not hold:

| Case | What happened |
|---|---|
| #2464, 4-story nax feature | The advisor waived (D-1) a quality finding, backed by the PRD's `outOfScope`. The next round re-raised the same defect under a new title. It missed the waiver, stayed in `facts.findingsOpen` and counted toward the draft outcome. The approval advisor (D-4) then treated it as already adjudicated, so the facts and the advisor disagreed. |
| #2464 second case, 7-story runner feature | The spec lens raised "ThreadJobRun has two lifetimes" (`judgment`). The advisor waived it (D-2): keep the constructor seam, because the generated acceptance file drives runs through it. In the same round the quality lens raised the same seam as a plain finding. It went straight to the fixer. Fix commit `b1f7f4b` removed the seam, about 55 of 97 acceptance tests timed out, and the PR ended draft with "acceptance red". |
| #2468, same 7-story feature | The advisor ruled `fix` on two spec-drift findings (revert a `session_event` envelope, drop a write-only `costSpentUsd` column). The generated acceptance file asserts both behaviours (AC-40, AC-51). Acceptance went red after the fixes. The approval advisor saw the contradiction only at the end. |

Root causes in the code (main `ebff5ecde`):

1. **The reuse key is brittle.** `dedupeKeyFor` (`advisor/dedupe.ts`) is `phase|title|<first path in the problem text, else problem hash>`. Reviewers rarely repeat a title, and the first path in prose moves with the wording. `findReusable` (`advisor/ledger.ts`) needs an exact key.
2. **Only judgment findings meet the rulings.** `mergeFindings` (`finish/merge-findings.ts`) puts every non-`judgment` finding in `toFix`. `judgeRound` (`finish/review-loop.ts`) only sends `judged` and `contradictions` to the advisor, so a plain finding never sees a ruling, in this round or a later one.
3. **Only the spec lens is told what is settled.** `ops.reviewSpec` (`finish/ops-impl.ts`) passes `decisions` (`formatDecisionsForPrompt`). `ops.reviewBranch` passes only the A3 hints.
4. **Fix sessions never see rulings.** `buildFinishFixPrompt` (`prompts/builders/finish-review-builder.ts`) lists findings only. Nothing says "do not undo D-2".
5. **Judgment questions carry no acceptance evidence.** `judgmentQuestion` (`finish/advise.ts`) sends the finding and the reviewer's reason. The advisor cannot know an acceptance test pins the behaviour.
6. **Nothing guards the generated acceptance file in finish.** Any fix session may edit it, and nothing records that it did.

## 2. Goal and scope

**Goal:** a waive or supersede ruling binds for the rest of the finish: across lenses, across rounds, and in the same round. No fix undoes it. A `fix` ruling never breaks an acceptance test by surprise: it either names the acceptance change or does not happen.

**In scope:** ruling matching for every finding (§3), rulings in reviewer and fixer prompts (§4), acceptance evidence and a "fix and update the acceptance tests" option (§5), an acceptance-file guard for review and gate fix sessions plus recording (§6).

**Unchanged:**
- The trust model: only decisions whose audit artifact exists under `outputDir` (`readTrustedDecisions`) are reused or shown.
- A waive of a HIGH or CRITICAL finding is never reused without a new call, and never shown to agents as settled (`isPromptSafe`).
- The ready/draft rules in `resolve`, and series A's stop, set-aside and per-finding states.
- Acceptance rulings A2-R1 and A2-R2: the acceptance-phase fix keeps its freedom to fix the source or the generated test (§6.1).
- AC supersede stays off the menu while acceptance is enabled (A1 spec §12.7).

**Out of scope:** delta re-review and deadline-aware scheduling (C, #2465 #2467), CI watch (D), `nax finish --resume` (E). Rulings outside finish (story-level callers 2 and 3) are not changed.

## 3. Ruling matching for every finding

### 3.1 Anchor and match levels

A finding's **anchor** is its structured `file` field. A finding without `file` has no anchor.

Against a ruling in force (§3.2), a finding is:

- **exact**: same anchor and the same normalised title (lowercase, whitespace collapsed, trailing punctuation dropped), from either lens; or, with no anchor, the same problem hash as today. Also exact: the legacy `dedupeKey` matches.
- **near**: same anchor, not exact.
- **none**: otherwise.

Lens is not part of the anchor + title rule. The legacy-key comparison is lens-specific (the key starts with the phase); cross-lens matching comes from the anchor rule. `dedupeKeyFor` stays as it is for the ledger line, so older readers still work.

### 3.2 Rulings in force

The waive and supersede decisions from `readTrustedDecisions` for this feature, plus the decisions made earlier in the current round. Rulings on HIGH or CRITICAL findings are in force for **near** matching (the advisor sees them as evidence) but never for exact reuse.

`AdviceDecision` gains `anchorFile?: string` (the ruled finding's `file`) and `rulingTitle?: string` (its title), written by `finish/advise.ts` through `QuestionDraft`. For a ledger line without them, both are read from the `dedupeKey` (`phase|title|path`): the third segment counts as the anchor only when it is a path, not a `#hash`.

### 3.3 The ruling check (new, pure: `finish/ruling-check.ts`)

`checkRulings(findings, rulings) → { reuse: {finding, decision}[]; near: {finding, decision}[]; rest: Finding[] }`. When one finding matches several rulings, the newest exact one wins; otherwise the newest near one. If the newest exact match is a blocking ruling, the finding is asked (near), even when an older non-blocking exact match exists: the newest ruling is the one in force.

### 3.4 Order in a round (`runOneRound`, `finish/review-loop.ts`)

1. `mergeFindings` as today.
2. Ruling check over **all** merged findings (`toFix`, `judged`, both sides of every contradiction) against the rulings in force before the round.
   - `reuse`: recorded through `advisor.recordReuse` and dropped, as today's reuse path does. Ledger event `ruled` with the prior decision's ref.
   - `near`: becomes a judgment question (§3.5), whatever its `judgment` flag.
   - A contradiction where either side is `reuse` or `near` is dissolved: each side is handled on its own.
3. `judgeRound` on the remaining judgment findings, contradictions and the near questions.
4. A second ruling check over the plain findings still in `toFix`, against the rulings made in step 3. This is the same-round cross-lens case. Its near matches become questions in one more advisor call within the same round; its exact matches are reused.
5. Fix list = what is left, as today.

### 3.5 The near-match question

Same as `judgmentQuestion`, plus one evidence item `{ source: "decision", ref: "D-n", text: "<action>: <title> (<anchor>) — <reason or newText>" }` per matched ruling, and the summary prefix "Possibly the same issue as D-n". Its `dedupeKey` is the finding's own key, so a later exact re-raise of this finding reuses this decision.

### 3.6 Caps and fallbacks

- Near-match questions have their own cap: at most `MAX_NEAR_MATCH_QUESTIONS = 6` per round. They do not use `MAX_ADVISE_ROUNDS`.
- Advisor off, judged caller disabled, cap spent, advisor error or no decision: a near match is carried **unresolved** (ledger `ruled` → `unresolved`, kept out of the fix list), never fixed. An exact reuse needs no advisor call and always applies when the advisor is on. With the advisor off (no finish advisor at all), no rulings are checked. When only the approval caller is enabled, a finish advisor still exists: the check runs with a near budget of 0, so exact matches are reused and near matches are carried unresolved, with no judgment call.

## 4. Rulings reach every agent

### 4.1 Quality lens

`FinishBranchReviewPromptInput` gains `decisions?: string`. `ops.reviewBranch` loads it with the same `loadDecisionNotes` as the spec lens and renders the same section, "Decisions already made (do not raise these again)".

### 4.2 Fix sessions

`buildFinishFixPrompt` gains `rulings?: string`, rendered for all three phases (acceptance, gate, review) as:

```
## Rulings in force
- D-2 waived: <title> (<anchor>) — <reason>
- D-5 superseded spec § 4.2: <newText>
If a change you are about to make would undo one of these, do not make it.
```

For the review phase it adds: a finding that can only be fixed by undoing a ruling is REJECTED with `evidence: ruling D-n`. `validateDispositions` (`finish/fix/dispositions.ts`) today splits evidence on `:` and checks the path exists, so it would mark `ruling D-n` as `evidenceMissing`. It changes: evidence matching `^ruling D-\d+$` is checked against the ruling ids shown to this session (`FinishFixInput.rulingIds`) instead: valid when the id is in that list, otherwise `evidenceMissing`.

The text comes from a new `formatRulingsForFix` in `advisor/format.ts`, built from the same prompt-safe set as `formatDecisionsForPrompt`. The rulings are loaded inside the fix operation wrapper (`ops-impl.fix`) for every phase, so no `runFixStep` caller changes; `FixRequest` gains only `acceptancePaths` (§6).

## 5. Acceptance evidence on judgment questions (#2468)

### 5.1 Finding the acceptance tests a ruling would touch (new, pure: `finish/acceptance-evidence.ts`)

Input: the acceptance group test paths finish already resolves (`context.groups[].testPath`, existing files only), the finding.

1. Split each file into AC blocks, language-neutrally: an anchor line is the first line that mentions a given AC id (`AC-\d+`, as the generator writes them in test names in every language). A block runs from its anchor line to the next anchor or end of file. No test-framework syntax (`test(`, `it(`, `func Test`, `def test_`) is parsed. A file with no AC ids gives no blocks.
2. Identifiers from the finding: backticked tokens in title and problem, code-style names in the title (camelCase, PascalCase, snake_case, dotted), the anchor's base name without extension.
3. Score = distinct identifiers found in the block. Keep blocks with score ≥ 1, top 5 by score, each excerpt capped at 40 lines.

Unreadable or missing files give no evidence, never a throw. This runs for every judgment question (§3.5 included) when acceptance is enabled.

### 5.2 Evidence and menu

- Each kept block becomes `{ source: "ac", ref: "<testPath>#AC-n", text: excerpt }`.
- When at least one block was kept, `MenuFacts["finish-judgment"]` gains `pinnedAcs: string[]` and `buildMenu` adds an option `{ type: "fix", fixed: { updateAcs: ["AC-40", "AC-51"] } }`, labelled "Fix, and update acceptance tests AC-40, AC-51". The plain `fix` option is relabelled "Fix without changing the acceptance tests".
- `AdviceOptionFixed` gains `updateAcs?: string[]`. `toAction` maps it to `{ type: "fix", instruction, updateAcs }` (`AdviceAction` fix gains `updateAcs?: string[]`). The reply's `instruction` must say what changes in those tests (`REQUIRED_TEXT_FIELD` for fix is already `instruction`).
- The advisor's system prompt gets one line: an acceptance test excerpt that asserts the behaviour the finding wants changed means a plain `fix` will turn acceptance red; choose "fix and update", "waive" (the test pins it on purpose) or "supersede".

### 5.3 What a "fix and update" ruling does

`judgeOne` appends to the finding's `fix`: `Advisor ruling (D-n): <instruction>. You may edit these acceptance tests, and only these: AC-40, AC-51 in <testPath>.` The finding carries `allowedAcceptanceEdits: { testPath, acIds }[]` (new optional `Finding` field, set by finish, never by the model).

## 6. Acceptance-file guard and recording

### 6.1 Which sessions

- **Review and gate fix sessions:** guarded, except a gate fix whose failing gate is the acceptance gate itself (`runGateZero`): repairing a red acceptance test is that session's job (A2-R1).
- **Acceptance-phase fix session:** not guarded (A2-R1: fixing a buggy generated test is its job). It does get the rulings section (§4.2).

### 6.2 The prompt rule

Guarded sessions get: "Do not edit the acceptance test files (<paths>) unless a finding below names the acceptance tests you may change."

### 6.3 The check (`finish/acceptance-guard.ts`, called from `fixRound` and the gate fix before `commitFixes`)

After a guarded session returns `done`:

1. List changed acceptance test paths in the working tree (`git diff --name-only HEAD` + untracked via `git ls-files --others --exclude-standard`), filtered to the group test paths in code, not only by pathspec.
2. A path is **authorised** when some finding in this session's list has `allowedAcceptanceEdits` for it.
3. Unauthorised changed paths are restored to their pre-session content, path only: `git restore --source=HEAD --staged --worktree`. `HEAD` is the pre-session content because fix sessions never commit and the guard runs before `commitFixes`. A path absent at `HEAD` (untracked or staged-new) is never deleted; it is recorded on `state.acceptanceGuard.notRestorable` and shown in the PR body. Recorded on `state.acceptanceGuard.reverted` (so it lands in `result.json`), and a line in the PR body's Unresolved section.
4. For authorised paths, the AC blocks whose text changed are computed (block split from §5.1, before vs after). The changed AC ids are recorded on `state.acceptanceGuard.changed`. Changed AC ids not in `allowedAcceptanceEdits` are **flagged, not reverted**: recorded on `state.acceptanceGuard.beyondRuling` and listed in the PR body as "Acceptance tests changed beyond the ruling".

Accepted limitation: when the guard reverts a file, the session's disposition still reads `fixed` and the finish ledger records `fixed-unreviewed`. The next full review round re-raises the finding if it is still real, and the PR body shows the revert.

A session stopped mid-turn is set aside by series A. The guard runs when its patch is re-applied and committed by a later attempt, through the same path.

### 6.4 Recording

- `AdviceDecision` gains `acceptanceChanges?: string[]` (the menu's `updateAcs` the ruling chose), written at decision time.
- `FinishState` gains `acceptanceGuard?: { reverted: string[]; notRestorable: string[]; changed: string[]; beyondRuling: string[]; failed: boolean }`, accumulated across guarded sessions. `result.json` already serialises the state, so it carries this with no new field.
- PR body: the existing "Advisor decisions" section (`buildAdvisorSection`, `finish/pr/body.ts`) appends "— acceptance tests changed: AC-40, AC-51" to a decision with `acceptanceChanges`. The Unresolved section gains its own "Acceptance-file guard" block (reverted paths, not-restorable paths, changes beyond the ruling, a failed check) from `state.acceptanceGuard`. The guard forces that section onto an otherwise-clean ready PR only when it reverted, could not restore, saw a change beyond the ruling, or failed.
- No new finish-ledger events: the guard acts on files, not findings.

## 7. Error handling

Every new read fails open toward **not fixing against a ruling**:
- Ledger unreadable → no rulings in force, today's behaviour.
- Acceptance file unreadable → no evidence, the plain menu.
- Guard git command fails → the commit goes ahead, and the PR body says "acceptance-file check could not run". The PR stays draft only through the existing facts. The guard is not a new draft reason.

## 8. Testing

Unit tests (TDD, against the pure helpers and the review loop with fake ops and advisor):

1. #2464: a quality finding re-raised with a new title and the same `file` as a trusted waive becomes one near question carrying the waive as evidence (ruling B-R1), and when the advisor waives it again it does not appear in `findingsOpen`. A re-raise with the same title from either lens is reused with no advisor call.
2. Legacy ledger line (no `anchorFile`): anchor recovered from `dedupeKey`; a `#hash` third segment is not an anchor.
3. Koda case, same round: spec `judgment` finding waived in step 3, quality plain finding on the same file → near question in step 4 with D-n as evidence. With the advisor off or the cap spent, it is carried unresolved and is not in the fix list.
4. Cross-round near match → question with the prior ruling as evidence; a HIGH exact match is not reused but asked.
5. A contradiction with a ruled side is dissolved.
6. `acceptance-evidence`: block split, scoring, top 5, 40-line cap, missing file.
7. Menu: `pinnedAcs` adds the fix-and-update option; `toAction` carries `updateAcs`; the decision records `acceptanceChanges`.
8. Guard: unauthorised acceptance edit reverted and recorded; authorised edit kept; a changed AC outside the ruling flagged; acceptance-phase session not guarded.
9. Prompts: quality lens renders decisions; fix prompts render rulings for all three phases; a blocking waive is not rendered.
10. PR body shows acceptance changes per decision and the guard's lines; `result.json` carries `acceptanceGuard`.

**Go-live:** one live finish with the advisor on, on the next feature run that uses finish (billed, approval at launch). No new billed replay.

## 9. Delivery

One PR. If the plan finds it too large, split into PR 1 = §3 + §4 (ruling matching and prompts) and PR 2 = §5 + §6 (acceptance evidence, guard, recording), in that order.
