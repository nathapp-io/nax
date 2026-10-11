# A4 — Finish rebuild: branch review, no escalation, always a PR

Date: 2026-10-11 · Status: DESIGN APPROVED IN CHAT; spec revised after one read-only review (rev 2)
Arc: autonomy A4 (workspace SSOT `nax-autonomy-master-plan.md` §A4) · Depends on: A1 advisor (#2436), A3 worth-check (#2448)

All paths below are relative to `packages/nax/` unless stated.

## 1. Problem

The finish phase (`src/finish/`) escalated in 13 of the 15 runs recorded since 2026-08-19 (workspace
baseline E1-E3) and was then left unused. Causes:

- **The evidence contract gates the review.** `## WALK` / `## TOUCHPOINTS` are parsed from a markdown
  reply and audited for coverage (`finish/review/audit-gaps.ts`). A gap routes `incomplete` once, then
  escalates, and the review's real findings are discarded with it. Example (nbf-worth-check,
  2026-10-11): the quality reviewer reported a MEDIUM test-leak risk and a LOW duplicate test; finish
  escalated because `## WALK` did not name 16 changed files. 4 of the 15 baseline escalations are this
  class.
- **A bespoke markdown reply format** with its own parser (`finish/review/parse.ts`) and defect history
  (#1636), separate from the JSON stack every per-story review uses.
- **Two review phases** (spec, quality) with separate fix loops, caps and incomplete state.
- **Many exits that stop the run**: no output, evidence gaps, judgment, fix caps, red acceptance, red
  gates, any thrown op error (the machine's outer `catch` escalates).
- **One judgment finding blocks the rest** (`route.ts` routes judgment before fix).
- **A whole agent session** (`operations/finish-narrative.ts`) re-reads the diff only to write the PR's
  "What changed" section and title.

Goal of the autonomy arc: `nax run` finishes by itself and leaves a PR plus a report.

## 2. Rulings (maintainer, 2026-10-11)

| # | Ruling |
|---|---|
| R1 | Design and code-quality review live at **branch level only** (finish). Per-story design review may come later; not A4. |
| R2 | The A3 worth-check's **skipped findings go to the branch reviewer as hints** (context, never findings by themselves). |
| R3 | **With the advisor on, finish never escalates.** Every unresolved end state goes to the advisor; the run ends with a PR (ready, or draft with a report). With the advisor off, unresolved → draft PR + notification. |
| R4 | **Rebuild finish on the per-story JSON review stack** (not a restructure in place, not the A5 workflow engine). This **lifts** master plan §6's settled items "no JSON reply format for reviewers" and "no change to the `parseReviewReport` shape" for finish. Route-threshold tweaks and diff-size guards stay non-goals. |
| R5 | **Keep a spec review at finish, at branch scope**: whole spec vs whole branch, no per-AC re-walk. |
| R6 | **No separate narrative session.** The branch reviewer returns the PR title and summary; the rest of the body is deterministic. |
| R7 | Spec and branch reviews run in parallel, feed **one** shared fix loop, and **both** re-run after every fix round. |

## 3. Flow

```
open draft PR ─► acceptance ─► review loop ────────────► acceptance ─► repo gates ─► resolution ─► finalize PR
 (as today,       gate          spec ∥ branch review      re-check      (+ gate fix)   (advisor or   ready: promote
  after first     (+ fix)       one shared fix loop       (if review                   default)      draft: keep draft,
  acceptance)                                              fixed code)                                update body
```

1. **Acceptance gate.** Unchanged runner (`finish/gates/acceptance.ts`) and acceptance fix, cap
   `MAX_FIX_ATTEMPTS` (3). `routeAcceptance`'s current escalations become facts: still red after the
   cap → `acceptance: "red"`; `ran === 0` or missing generated groups → `acceptance: "unverified"`;
   `context.acceptanceStatus === "disabled"` or no PRD groups → `"not-configured"`.
2. **Early draft PR.** Unchanged: `ops.openDraftPr` after the first acceptance pass (`machine.ts`),
   so a PR exists early.
3. **Review loop** (§5): both lenses in parallel over the full branch diff, cap 3 review rounds per finish.
4. **Acceptance re-check.** If the review loop committed any fix, the acceptance gate runs once more
   (today's I8 behaviour), using whatever remains of the acceptance fix cap.
5. **Repo gates.** Unchanged runner (`finish/gates/quality.ts`) and gate fix, cap 3. If a gate fix
   commits code and review rounds remain, one more review round runs (then gates again); if no rounds
   remain, the gate-fix commits are listed under "Unreviewed fix commits" in the Unresolved report.
6. **Resolution** (§6).
7. **Finalize PR** (§7.1).

Caps are per loop: acceptance fix 3, review rounds 3 (shared by both lenses), gate fix 3. `MAX_ADVISE_ROUNDS`
and the advisor's `maxRulingsPerStory` are unchanged.

### 3.1 Aborts, deadlines and thrown errors

Nothing in steps 1-6 stops the run. The outer `catch` in `runFinishMachine` no longer escalates.

| Event | Behaviour |
|---|---|
| Run aborted (the run's own signal: SIGINT, run cancel) | `failed`, reason `aborted`; no PR call is attempted. |
| `finish.timeouts.flowMs` deadline (phase signal only) | Stop the current step; go straight to resolution with the facts so far (unfinished steps count as unresolved: `reviewsMissing`, `acceptance: "unverified"`, gate `red` with reason `not run`), then finalize as **draft** using a fresh 60 s signal for the forge calls. Reason `deadline`. |
| A review op throws or returns nothing parseable after its JSON retry | That lens is `missing` for that round; continue. |
| Acceptance fix, review fix or gate fix session throws | That fix attempt counts as used and changed nothing; continue the loop. |
| Acceptance or gate **runner** throws | Recorded as `red` with the error as output; continue. |
| Advisor throws or replies malformed | Fail-closed → draft (§6). |
| Push or forge call throws / fails during finalize | `failed`, reason = the error; the notify hook fires. |
| Branch has no commits ahead of base | `nothing-to-finish` (unchanged). |

## 4. The two review ops

Both are `RunOperation`s built like `operations/adversarial-review.ts`: prompt builders in
`src/prompts/builders/` (exported through `src/prompts/index.ts`), parsing with `tryParseLLMJson`
(`src/utils/llm-json.ts`; it repairs literal newlines inside strings, #2124), and the existing parse-retry
helpers (`makeParseRetryStrategy`, `ParseValidationError` in `src/agents/retry`). Both sessions are
read-only; only fix sessions write. Both reuse today's session roles, **`finish-review-spec`** and
**`finish-review-quality`** (no rename), so `KNOWN_SESSION_ROLES` and `check-op-tool-capability` keep
their role entries; the `narrative` role is removed.

### 4.1 Finding shape

The persisted and advisor-facing shape stays today's `Finding` (`finish/types.ts`), extended by three
fields (today's `Finding` has no location):

```ts
interface Finding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";   // unchanged
  title: string;
  problem: string;                                      // unchanged name (dedupeKeyFor reads it)
  fix: string;                                          // unchanged; "" when the model gives none
  judgment?: boolean;
  judgmentReason?: string;
  file?: string;                                        // NEW: repo-relative path, when the finding has one
  line?: number;                                        // NEW
  source?: "spec" | "quality";                          // NEW: set by finish from the producing op, never by the model;
                                                        // optional only so pre-A4 result.json still type-checks on import
}
```

Duplicate collapse and contradiction flagging (§5) treat an absent `file` as "file-level, unknown file":
such findings collapse only on identical `title`, and are never flagged as contradictions.

The reviewer's JSON reply uses these field names. The op maps case-insensitive severities to the upper-case
enum and drops `info`/unknown severities to `LOW`. `dedupeKeyFor(phase, finding)` is called with
`phase = finding.source`, so A1 ledger keys are unchanged.

Op output:

```ts
interface FinishReviewOutput {
  findings: Finding[];
  covered: string[];      // repo-relative paths the reviewer read — telemetry only, never routed on
  title?: string;         // branch review only
  summary?: string;       // branch review only
}
```

### 4.2 `finishSpecReview` (role `finish-review-spec`)

- **Inputs:** the spec, the PRD (stories + ACs), this feature's trusted advisor decisions
  (`readTrustedDecisions`, so ruled contradictions are not re-raised), the diff stat and changed-file list
  (the reviewer reads files with tools).
- **Remit:** spec requirements no story covers; constraints spanning stories (non-functional limits,
  ordering, atomicity); a later story contradicting an earlier one; spec-vs-code conflicts marked
  `judgment: true`.
- **Out of remit:** re-checking individual ACs one by one; code style.

### 4.3 `finishBranchReview` (role `finish-review-quality`)

- **Inputs:** the diff stat and changed-file list, the story list (id + title only), and the A3 hints (§4.4).
- **Remit:** new code unreachable from production entry points (wiring); duplication across stories;
  inconsistent patterns between stories; the clean-code checklist from today's
  `finish/review/references/code-quality.md` (moved into the builder) **without** the `## WALK` enumeration.
- **Also returns** `title` (conventional commit, ≤ 72 chars, through `pr-title.ts`'s sanitiser) and
  `summary` (PR "What changed" prose, capped at `NARRATIVE_MAX_CHARS` = 4000, which moves from
  `operations/finish-narrative.ts` to `finish/pr/body.ts`).

### 4.4 A3 hints (`finish/a3-hints.ts`)

Reads `<outputDir>/nbf-worth-check/<feature>/*.json` (`NbfWorthCheckAuditFile`,
`operations/nbf-worth-check-audit.ts`). Uses only records with `mode === "on"` and `parsed === true`
(shadow records skipped nothing). For each `verdicts[i]` with `verdict === "skip"`, joins
`findings[verdicts[i].index]` and emits `{ file, line, severity, message, reason }`. The prompt shows them
under "Previously skipped as not worth fixing — re-raise only if the whole branch makes it matter."
Absent directory → no hints; unreadable or malformed file → skipped with a debug log.

### 4.5 Parallelism

The two ops run concurrently with `Promise.allSettled`; one lens timing out or throwing never cancels the
other. Each gets its own signal derived from the phase signal with `finish.timeouts.stepMs`. `callOp` has
no cross-call lock and the two roles open separate sessions; the plan must include a test that runs both
ops concurrently against the fake agent and checks cost and usage attribution per role.

**Diff window:** every round reviews the full branch (`base...HEAD`), not just the commits since the last
verdict (today's `reviewSince`), because cross-story issues are the remit. This costs more per re-round;
accepted.

## 5. Review loop

Per round (`finish/review-loop.ts`):

1. **Review:** both ops (§4.5). A lens with no verdict is `missing` for the round.
2. **Merge** (`finish/merge-findings.ts`): one list; exact duplicates (same `file`, same `line` or both
   absent, same case-folded `title`) collapse, keeping the higher severity.
3. **Contradictions:** a non-judgment spec finding and a non-judgment quality finding on the same `file`
   with the same `line` (or both without a line) are flagged as a possible contradiction: neither goes to
   the fixer; together they become one judgment question (`kind: "finish-judgment"`, evidence = both
   findings with their sources; dedupe key from the spec finding with `phase: "spec"`). Over-flagging costs
   one advisor question, never a wrong fix.
4. **Judgment:** judgment findings plus flagged contradictions go to advisor caller 1. `advise.ts`'s judged
   path is re-shaped (it currently takes a per-phase `RoutedReview`, a `FinishPhaseState` and an
   `escalate` callback): new signature
   `judged(findings: Finding[], state: FinishState): Promise<{ toFix: Finding[]; advice: AdviceRef[]; unresolved: Finding[] }>`.
   `waive` / `supersede` drop the finding (recorded); `fix` adds it to `toFix`; `hold`, advisor fallback,
   or advisor off put it in `unresolved` (carried to resolution, not fixed). Exception with the advisor off:
   for a flagged contradiction the spec finding goes to `toFix` and the quality finding to `unresolved`.
5. **Fix:** if `toFix` plus the remaining non-judgment findings is non-empty, one fix session
   (`operations/finish-fix.ts`, prompt updated to group by source: spec findings, then quality findings);
   commits as today (`commit.ts`). If the list is empty, the loop ends.
6. **Stop** when both lenses returned a verdict with zero findings, when a round had nothing to fix, or
   after 3 rounds. Open findings, `unresolved` findings and missing lenses from the **last** round go to
   resolution.

**State** (`finish/state.ts`): `phases.spec` and `phases.quality` are replaced by one `review` record
`{ rounds, lastFindings, missingLenses, unresolved, adviseRounds, reReviewUsed, committedFixes }`.
`phases.acceptance` and `phases.gate` keep today's fix-attempt counters. `incompleteAttempts` and
`reviewGaps` are removed.

## 6. Resolution (`finish/resolve.ts`)

Facts, computed in code:

| Fact | Values |
|---|---|
| `findingsOpen` | last-round findings + `unresolved`, minus waived / superseded |
| `acceptance` | `green` \| `red` \| `unverified` \| `not-configured` |
| `gates` | per command `green` \| `red` (with output excerpt or `not run`) |
| `reviewsMissing` | lenses without a verdict in the last round |
| `unreviewedFixCommits` | gate/acceptance fix commits made after the last review round |
| `coverage` | per lens, `covered ∩ changed` ÷ changed files (reported only) |
| `fixRounds` | review rounds used |

- **Clean** = no open findings, acceptance `green` or `not-configured`, all gates green, no missing lens, no
  unreviewed fix commits → **ready**, without calling the advisor.
- **Advisor on, not clean:** caller 4. `runApproval` is rewritten (its `reviewAgain` / `gatesAgain`
  callbacks drive the old per-phase loops): it builds the question from the facts. Evidence layout: open
  findings (severity, source, title, file), red or unverified gates and acceptance (name + 20-line
  excerpt), missing lenses, unreviewed fix commits, coverage percentages. Menu (`advisor/menus.ts`
  `finish-approval`, unchanged): `approve` offered only when `allPhasesComplete` (= no missing lens) and
  `gatesGreen` (= acceptance `green`/`not-configured` and all gates green); `re-review` once per finish
  (its `phase` parameter is ignored: one more full review round, then acceptance re-check, gates and
  resolution again); `hold`. The action type stays `hold` so the ledger and replay schemas are unchanged;
  finish maps `hold` → **draft**. `forcedConfirm` behaviour in `menus.ts` is unchanged (a forced-confirm
  decision is flagged in the PR as today). Malformed or failed reply → draft.
  `approve` with open findings → ready; those findings are recorded in `result.json` as `acceptedResidue`
  and rendered in the PR's Unresolved section under "Accepted by the advisor".
- **Advisor off, not clean:** draft + notification.

## 7. PR, status, audit, report

### 7.1 PR lifecycle

- The early draft (`ops.openDraftPr`, §3 step 2) stays.
- **Ready:** `ops.promotePr` → `openOrPromotePr` as today (promote the draft, or open ready if none).
- **Draft:** new `ops.finalizeDraftPr` → `openOrPromotePr(..., { keepDraft: true })`: push; if a PR exists,
  update title + body and do **not** mark it ready; if none exists, create it with `--draft`. Works for
  both GitHub and GitLab through `src/forge/` (the forge layer already creates drafts for
  `openDraftPr`; the plan verifies the GitLab update-without-ready path).
- **No forge** (`forgeKind === null`): push only; status `local-only` with the report in `result.json` and
  the run summary.
- The old escalation PR path (`escalate.ts`: comment on the PR or open a `nax-finish: <branch>` draft) is
  deleted; `escalate.ts` keeps only the notify-on-`failed` delivery.
- The `autoPR` plugin and its config are unrelated to finish and are not read.

### 7.2 Status

`FinishResult.status` (`finish/types.ts`) becomes
`"opened" | "promoted" | "already-ready" | "draft" | "local-only" | "failed" | "nothing-to-finish"`
(`escalated` removed). `result.json` adds `outcome: "ready" | "draft" | "local-only" | "failed"`,
`reason?`, the resolution facts and `acceptedResidue`.

- `phase.ts`: `passed = status ∈ {opened, promoted, already-ready, nothing-to-finish}`; `draft`,
  `local-only` with open issues, and `failed` report `passed: false` in `status.json`
  (`postRun.finish.status` gains `"draft"`).
- `audit.ts` `LEDGER_TERMINAL_STATUSES`: `opened`, `promoted`, `already-ready`, `nothing-to-finish`,
  `draft`, `local-only`. With `finish.rerun: "on-change"` a draft at the same HEAD is not re-run; new
  commits on the branch re-run finish. `failed` stays non-terminal.
- `notify()`: fires on `draft` and `failed` under `notify.mode: "draft"`; always under `"always"`.

### 7.3 PR body and title

`finish/pr/body.ts`, section keys (for `finish.prBody.template` / `sectionMap`):

| Key | Heading | Content |
|---|---|---|
| `unresolved` (NEW, first) | Unresolved | draft or accepted residue only: why; open findings by severity; red/unverified acceptance and gates with excerpts; missing reviews; unreviewed fix commits; "Accepted by the advisor" list |
| `narrative` | What changed | branch reviewer `summary`; fallback = spec summary (today's fallback) |
| `stories` | Stories | unchanged |
| `advisor` | Advisor decisions | unchanged (A1) |
| `rounds` | Review | findings fixed per lens, rounds used, coverage % (heading renamed from "Review rounds", key kept) |
| `verification` | Verification | unchanged |
| `outOfScope`, `footer` | unchanged | unchanged |

Title: branch reviewer `title` → `pr-title.ts` sanitiser → fallback `feat: <feature>`. The `<title>`
sentinel parsing is removed; the sanitiser and fallback chain stay.

### 7.4 Audit and report

`finish-audit/<feature>/<runId>.{jsonl,result.json}` stays, one round record per step.
`FinishRoundOutcome` loses `incomplete` and `escalated`; it gains `missing` (lens without verdict).
The run summary's last line: `PR #<n> opened (ready|draft): <reason>` (or `local-only` / `failed`).

### 7.5 `nax advisor import-finish`

`cli/advisor-import.ts` locates the escalated phase from `rounds[].outcome === "escalated"` and parses
`RecordedFinding { problem, … }`. It must keep importing **pre-A4** `result.json` files (the go-live
replay in §11 uses them) and ignore post-A4 files (no escalations to import). The plan adds a test pinning
both.

## 8. Config

Backward compatible; every existing `nax-finish-*` profile shape must still parse. Changes land in
`config/schemas.ts` (finish block), `config/runtime-types-finish.ts` and `finish/config.ts`.

| Key | After A4 |
|---|---|
| `finish.reviewers.spec` | model for `finishSpecReview` |
| `finish.reviewers.quality` | model for `finishBranchReview` (key kept; it now drives the branch review) |
| `finish.reviewers.fix` | unchanged |
| `finish.reviewers.narrative`, `finish.narrative` | accepted, ignored; one deprecation `warn` logged from `phase.ts` when present (`readFinishConfig` stays pure and only reports the flag) |
| `finish.notify.mode` | enum gains `draft` (notify on draft or failed) and becomes the default; `escalation` accepted as an alias of `draft`; `always`, `off` unchanged |
| `finish.escalate.telegram` | applies to draft and failed notifications |
| `finish.prBody.sectionMap` | known keys per §7.3 (`unresolved` added; schema doc comment updated) |
| `finish.rerun`, `finish.timeouts`, `finish.enabled` | unchanged |

`scripts/check-config-profile-threading.ts` is updated if it enumerates finish keys.

## 9. Code changes

**Add:** `operations/finish-spec-review.ts`, `operations/finish-branch-review.ts`, their builders in
`src/prompts/builders/` (+ `prompts/index.ts` exports), `finish/a3-hints.ts`, `finish/merge-findings.ts`,
`finish/review-loop.ts`, `finish/resolve.ts`.

**Change:** `finish/machine.ts` (rewritten to §3), `finish/advise.ts` (judged signature §5.4, `runApproval`
§6), `finish/state.ts` (§5), `finish/types.ts` (`Finding.source`, status, round outcomes),
`finish/ops.ts` + `ops-impl.ts` (`review` → two ops; `narrate` removed; `finalizeDraftPr` added),
`finish/pr/open.ts` (`keepDraft`), `finish/pr/body.ts` (§7.3, `NARRATIVE_MAX_CHARS`), `finish/pr-title.ts`
(sentinel removed), `finish/phase.ts` (status mapping, deprecation warn), `finish/audit.ts` (terminal set),
`finish/escalate.ts` (failed-only notify), `finish/notify.ts`, `finish/commit-message.ts` (if it reads
removed fields), `finish/route.ts` (keeps `routeAcceptance` / gate routing reshaped to facts; `routeReview`
removed), `finish/index.ts` exports, `operations/finish-fix.ts` (grouped prompt), `operations/index.ts`
exports, `runtime/session-role.ts` (`narrative` role removed), `cli/advisor-import.ts` (§7.5), config files
(§8).

**Delete:** `finish/review/` (`parse.ts`, `audit-gaps.ts`, `prompt.ts`, `prompts.gen.ts`, `index.ts`,
`references/*.md`), `operations/finish-review.ts`, `operations/finish-narrative.ts`,
`scripts/generate-review-prompts.ts`, `scripts/check-review-prompts-generated.ts` and their
`gen:review-prompts` / `check:review-prompts` `package.json` entries; the `prompts.gen.ts` reference in
`scripts/check-worktree-id-ssot.ts`; entries for deleted files in
`scripts/baselines/complexity-baseline.json` and `test-escape-hatches-baseline.json`.

**Tests rewritten or deleted:** `route.test.ts`, `route-advise.test.ts`, `machine-*.test.ts`,
`ops-impl.test.ts`, `review-audit-gaps.test.ts`, `finish-narrative.test.ts`, `finish-review.test.ts`,
`generate-review-prompts.test.ts`, `call-root-collapse.test.ts`, session-role and usage-auditor tests that
list the narrative role.

**Docs:** `docs/architecture/subsystems.md` and any finish docs naming the WALK contract, escalation or the
narrative node.

## 10. Delivery

One branch stack, **two** PRs, each leaving `check:all` green (pkg + root) and code-reviewed before push:

1. **Review ops (inert):** `Finding.source`, both ops + builders, `a3-hints`, `merge-findings`, unit tests.
   Nothing wired; old finish untouched.
2. **Finish rebuild:** machine rewrite, review loop, resolution, PR lifecycle, status/ledger/notify,
   advisor reshaping, `advisor-import` guard, config, **and** every deletion in §9 with its baseline and
   script edits, plus docs. Old and new review paths never coexist, so no dead shims.

## 11. Testing

**Unit (TDD):**
- each op: prompt contents (spec op: spec + PRD + trusted decisions; branch op: A3 hints, no touched-files
  input), JSON parse incl. a multi-line `summary`, severity normalisation, retry → missing, title sanitise +
  fallback;
- concurrency: both ops against the fake agent at once; one throwing does not cancel the other; cost/usage
  attributed per role;
- `a3-hints`: `on` + `parsed` skip verdicts joined by index; shadow records ignored; absent dir; malformed
  file;
- `merge-findings`: source labels, duplicate collapse, contradiction flagging;
- `review-loop`: stop conditions, 3-round cap, judged signature (fix / waive / supersede / hold / advisor
  off / contradiction with advisor off);
- `resolve`: one case per end state — clean; open findings; red acceptance; unverified acceptance; red
  gates; missing lens; unreviewed fix commits; advisor approve (with residue) / re-review / hold /
  malformed; advisor off; `flowMs` deadline; run abort; forge failure; no forge — each maps to the §7.2
  status, and only abort / forge failure skip the PR;
- §3.1 throw table, one test per row;
- PR body snapshots for ready, draft and accepted-residue; `keepDraft` for GitHub and GitLab;
- status, ledger terminal set, `passed`, notify conditions;
- `advisor import-finish`: pre-A4 result.json still imports; post-A4 result.json is ignored;
- config: `escalation` alias, narrative keys ignored with a warning, `nax-finish-*` profile shapes parse
  (fixtures in the test tree, no private project names).

**Integration:** a finish run over a fixture repo with a fake agent, from acceptance to the forge call, for
one ready and one draft path.

**Go-live (billed, each needs maintainer approval at launch):**
1. **Catch-rate replay, review ops only:** run both ops at the recorded SHAs of the 10 baseline cases with a
   real signal (4 spec-vs-code, 6 design calls), using the A1 replay's SHA mapping (pre-A4 result.json
   via `advisor import-finish`). Bar: ≥ 8/10 raise the recorded concern in some form. Est. $1-3.
2. **One live finish** on the local build with `nax-finish-native,advisor` on a real feature: a PR opens
   (ready or draft), nothing escalates, the audit carries coverage telemetry.

## 12. Out of scope (follow-ups)

- The `nax-finish` skill (nax-toolkit-skills): "resume from escalation" becomes "take over a draft PR".
- A full old-vs-new finish replay harness.
- Per-story design / clean-code review (R1).
- Route-threshold tweaks and diff-size guards (still non-goals).

## 13. Done when

Both PRs merged; catch-rate replay ≥ 8/10; one live finish opened a PR; workspace master plan §7 has an A4
row with the outcome.
