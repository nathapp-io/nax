# A4 — Finish rebuild: branch review, no escalation, always a PR

Date: 2026-10-11 · Status: DESIGN APPROVED IN CHAT, spec awaiting maintainer review
Arc: autonomy A4 (workspace SSOT `nax-autonomy-master-plan.md` §A4) · Depends on: A1 advisor (#2436), A3 worth-check (#2448)

## 1. Problem

The finish phase (`packages/nax/src/finish/`) escalated in 13 of the 15 runs recorded since 2026-08-19,
and was then left unused. The measured causes (workspace baseline, E1-E3):

- **The evidence contract gates the review.** `## WALK` / `## TOUCHPOINTS` are parsed from a markdown
  reply and audited for coverage (`review/audit-gaps.ts`). A gap routes `incomplete` once, then escalates,
  and the review's real findings are discarded with it. Example (nbf-worth-check, 2026-10-11): the
  quality reviewer reported a MEDIUM test-leak risk and a LOW duplicate test; finish escalated because
  `## WALK` did not name 16 changed files. 4 of the 15 seed escalations are this class.
- **A bespoke markdown reply format** with its own parser (`review/parse.ts`) and its own defect history
  (glued heading, #1636), separate from the JSON stack every per-story review already uses.
- **Two review phases** (spec, quality), each with its own fix loop, caps and incomplete state.
- **Six exits that stop the run**: no output, evidence gaps, judgment, fix cap, red acceptance, red gates.
- **One judgment finding blocks the rest** (E3, `route.ts`).
- **A whole agent session** (`finish-narrative`) re-reads the diff only to write the PR's "What changed"
  section and title.

Goal of the autonomy arc: `nax run` finishes by itself and leaves a PR plus a report.

## 2. Rulings (maintainer, 2026-10-11)

| # | Ruling |
|---|---|
| R1 | Design and code-quality review live at **branch level only** (finish). Per-story design review is a possible later addition, not part of A4. |
| R2 | The A3 worth-check's **skipped findings are passed to the branch reviewer as hints** (context, never findings by themselves). |
| R3 | **With the advisor on, finish never escalates.** Every unresolved end state goes to the advisor; the run always ends with a PR (ready, or draft with a report). With the advisor off, unresolved → draft PR + notification. |
| R4 | **Rebuild finish** (approach A: on the per-story JSON review stack), not a restructure in place and not the A5 workflow engine. This **lifts** the master plan §6 settled items "no JSON reply format for reviewers" and "no change to the `parseReviewReport` shape" for finish. Route-threshold tweaks and diff-size guards remain non-goals. |
| R5 | **Keep a spec review at finish, at branch scope** — whole spec vs whole branch; it does not re-walk individual ACs (semantic review already did). |
| R6 | **No separate narrative session.** The branch reviewer returns the PR title and summary; the rest of the PR body is deterministic. |
| R7 | The spec and branch reviews run in parallel; their findings feed **one** shared fix loop; **both** re-run after every fix round. |

## 3. Flow

```
acceptance gate ─► review round ─────────► fix loop ─► repo gates ─► resolution ─► PR
  (unchanged)      finishSpecReview  ┐     (one,       (unchanged    (advisor or   ready | draft
                   finishBranchReview┘      shared)     commands)     default)      + Unresolved report
                   parallel, JSON
```

1. **Acceptance gate.** Unchanged deterministic group runs (`gates/acceptance.ts`) and the existing
   acceptance fix on red. Red after the cap is recorded as unresolved and finish continues; it does not
   stop. `ran === 0` / missing groups are recorded the same way (they are unresolved, not a stop).
2. **Review round.** `finishSpecReview` and `finishBranchReview` run in parallel over the same diff
   (`base...HEAD` of the feature branch, as today's context builder computes it).
3. **Fix loop** (§5). At most `MAX_FIX_ATTEMPTS = 3` rounds per finish, shared by both lenses.
4. **Repo gates.** Unchanged commands (`gates/quality.ts`) and the existing gate fix on red. Red after the
   cap is recorded as unresolved; it does not stop.
5. **Resolution** (§6). Replaces every escalation exit.
6. **PR.** Push, then open or promote under the existing `autoPR` / forge settings (`pr/open.ts`).

**Nothing in steps 1-5 stops the run.** The only `failed` outcomes are those where no PR is possible:
push failure, forge call failure, run abort (`FINISH_ABORTED` / run signal), or a branch with no commits.
These are reported and notified as today.

## 4. The two review ops

Both are `RunOperation`s built like `operations/adversarial-review.ts`: a prompt builder under
`src/prompts/builders/`, `tryParseLLMJson` parsing (which already repairs literal newlines inside
strings, #2124), and the existing JSON retry / condensed-retry reprompts. Both sessions are read-only
(profile `read`); only the fix session writes.

### 4.1 Output schema

```ts
interface FinishReviewOutput {
  findings: FinishFinding[];
  /** Repo-relative paths the reviewer read. Telemetry only — never gates. */
  covered: string[];
  /** finishBranchReview only. */
  title?: string;
  summary?: string;
}

interface FinishFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  file: string;
  line?: number;
  title: string;
  detail: string;
  fix?: string;
  /** True when resolving it needs a decision, not a code change (spec vs code, design trade-off). */
  judgment?: boolean;
  judgmentReason?: string;
  /** Set by finish from the op that produced it, never by the model. */
  source: "spec" | "quality";
}
```

`FinishFinding` replaces the current `Finding` in `finish/types.ts`; fields shared with the advisor's
finding input keep their names so `dedupeKeyFor` and the ledger keep working.

### 4.2 `finishSpecReview`

- **Inputs:** the spec, the PRD (stories + ACs), the feature's trusted advisor decisions
  (`readTrustedDecisions`, so ruled contradictions are not raised again), the diff stat and changed-file
  list (the reviewer reads files with tools).
- **Remit:** spec requirements no story covers (PRD dropped or split them); constraints that span stories
  (non-functional limits, ordering, atomicity); a later story contradicting an earlier one; spec-vs-code
  conflicts, marked `judgment: true`.
- **Explicitly out of remit:** re-checking individual ACs one by one; code style.

### 4.3 `finishBranchReview`

- **Inputs:** the diff stat and changed-file list, the story list (id, title, touched files — not full
  ACs), and the A3 hints (§4.4).
- **Remit:** new code unreachable from production entry points (wiring); duplication across stories;
  inconsistent patterns between stories; the clean-code checklist from today's
  `review/references/code-quality.md` (test isolation, dead code, leaks, error handling, concurrency,
  performance, a11y, security, type safety) — **without** the forced `## WALK` enumeration.
- **Also returns** `title` (conventional-commit form, ≤ 72 chars, run through the existing
  `pr-title.ts` sanitiser) and `summary` (the PR's "What changed" prose, capped at the existing
  `NARRATIVE_MAX_CHARS`).

### 4.4 A3 hints

Finish reads this feature's worth-check audit records (`<outputDir>/nbf-worth-check/<feature>/*.json`,
written by `operations/nbf-worth-check-audit.ts`) and passes every `skip` verdict (finding title, file,
skip reason) to `finishBranchReview` under a heading of the form "Previously skipped as not worth fixing
— re-raise only if the whole branch makes it matter." Unreadable or absent records mean no hints (the
worth-check is `off`/`shadow`, or the audit write failed); this is logged at debug, never an error.

### 4.5 Missing output

An op that returns nothing parseable after its JSON retry counts as **review missing** for that lens in
that round. It is recorded in the audit and reported in the PR (§7). It does not stop the run. A lens
missing in the final round counts as unresolved for resolution.

### 4.6 Roles and models

Two session roles, `finish-spec-review` and `finish-branch-review`, replacing the current finish review
roles and the `narrative` role. Models resolve through `finish.reviewers.spec` and
`finish.reviewers.quality` (§8) with today's tier defaults. Per-op timeout = `finish.timeouts.stepMs`.

## 5. Fix loop

Each round:

1. **Merge.** Findings from both lenses form one list. Each keeps its `source`. Exact duplicates (same
   `file`, same `line` or both absent, same normalised `title`) collapse to one, keeping the higher
   severity.
2. **Contradictions.** A spec-source and a quality-source finding on the same `file` with overlapping
   line ranges (or both file-level) are treated as a possible contradiction: they are not sent to the
   fixer and become one judgment question. Detection is deterministic and reads no fix text; it may
   over-flag, which costs one advisor question, never a wrong fix. Anything not flagged reaches the fixer
   grouped by source.
3. **Judgment first.** Judgment findings (from either lens, plus detected contradictions) go to advisor
   caller 1 (`advise.ts` `applyJudgedAdvice`, unchanged: waive / supersede / fix, with ledger reuse).
   Waived and superseded findings are dropped and recorded; `fix` rulings join the fix list. With the
   advisor off, the spec-source finding wins a contradiction, the quality one is carried to the PR as
   unresolved, and other judgment findings are carried to the PR as unresolved (they are not fixed).
4. **One fix session** receives the remaining list grouped by source (spec findings, then quality
   findings), reusing the current `finish-fix` op with an updated prompt. Fixes are committed as today
   (`commit.ts`).
5. **Re-review.** Both ops run again on the new HEAD, even when only one lens had findings.
6. **Stop** when both lenses return zero findings, or after `MAX_FIX_ATTEMPTS` rounds. Remaining
   findings go to resolution.

Advisor judgment rounds stay bounded by the existing `MAX_ADVISE_ROUNDS` and `maxRulingsPerStory`.

## 6. Resolution

Resolution facts are computed in code:

| Fact | Meaning |
|---|---|
| `findingsOpen` | findings after the last round, minus waived / superseded |
| `acceptance` | `green` \| `red` \| `not-configured` |
| `gates` | per command `green` \| `red` |
| `reviewsMissing` | lenses with no verdict in the final round |
| `coverage` | per lens, `covered ∩ changed` ÷ changed files |
| `fixRounds` | rounds used |

- **Clean** = no open findings, acceptance green or not configured, all gates green, no missing review.
  Clean → **ready PR**, without calling the advisor.
- **Advisor on, not clean:** caller 4 (`runApproval`) receives the facts and the open findings. Menu:
  `approve` (offered only when acceptance and gates are green; open findings are listed in the PR as
  accepted residue) → ready PR; `re-review` (once per finish) → one more fix-and-review round, then
  resolution again; `hold` → **draft PR**. The advisor's action type stays `hold` so the ledger and
  replay schema are unchanged; finish maps it to draft. A malformed or failed advisor reply → draft
  (fail-closed). The menu's existing facts map as `allPhasesComplete` = no missing review and
  `gatesGreen` = acceptance green or not configured and all gates green; `re-review`'s `phase` parameter
  is ignored (both lenses always re-run).
- **Advisor off, not clean:** draft PR + notification.

Coverage is reported, never routed on.

## 7. PR body, title, audit, report

**Body** (deterministic, built by `pr/body.ts`, sections in this order):

1. **Unresolved** (draft only): why it is a draft; open findings by severity; red gates and acceptance
   with output excerpts (existing excerpt caps); missing reviews.
2. **What changed:** the branch reviewer's `summary`; fallback = the spec summary (today's fallback).
3. **Stories:** id, title, status, commits.
4. **Advisor decisions:** flagged first (A1's existing section).
5. **Review:** findings fixed per lens, rounds used, coverage percentages.
6. **Verification:** acceptance and gate results.

`finish.prBody.template` / `sectionMap` keep working over the new section keys.

**Title:** the branch reviewer's `title` → `pr-title.ts` sanitiser; fallback `feat: <feature>`. The
`<title>` sentinel is removed.

**Audit:** `finish-audit/<feature>/<runId>.{jsonl,result.json}` stays, one round record per step.
`result.json` gains `outcome: "ready" | "draft" | "failed"`, `draftReason?`, and the resolution facts.
The cross-run idempotency ledger (`finish.rerun`) treats `ready` and `draft` as terminal.

**Report:** the run summary's last line is `PR #<n> opened (ready|draft): <reason>`. The notify hook
fires on `draft` and `failed` with the same reason.

## 8. Config

Backward compatible; every existing `nax-finish-*` profile must still parse.

| Key | After A4 |
|---|---|
| `finish.reviewers.spec` | model for `finishSpecReview` |
| `finish.reviewers.quality` | model for `finishBranchReview` |
| `finish.reviewers.fix` | unchanged |
| `finish.reviewers.narrative`, `finish.narrative` | accepted, ignored, one deprecation warning per run |
| `finish.notify.mode` | new value `draft` (notify on draft or failed); `escalation` is an alias of `draft`; `always`, `off` unchanged |
| `finish.escalate.telegram` | applies to draft and failed notifications |
| `finish.rerun`, `finish.timeouts`, `finish.prBody`, `finish.enabled` | unchanged |

## 9. Code changes

**Delete:** `src/finish/review/` (markdown contract, `parse.ts`, `audit-gaps.ts`, `prompt.ts`,
`prompts.gen.ts`, `references/*.md` — the clean-code checklist content moves into the branch-review
prompt builder), `operations/finish-review.ts`, `operations/finish-narrative.ts`, `routeReview` /
`incomplete` route / `MAX_INCOMPLETE_ATTEMPTS` in `route.ts`, the narrative session role, the escalation
terminal in `escalate.ts` (it keeps `failed` reporting only). Any generator script that produced
`prompts.gen.ts` goes with it.

**Add:** `operations/finish-spec-review.ts`, `operations/finish-branch-review.ts`, their prompt builders,
`finish/merge-findings.ts` (merge, dedupe, contradiction detection), `finish/resolve.ts` (facts +
resolution), `finish/a3-hints.ts`.

**Change:** `machine.ts` (rewritten to §3), `advise.ts` (approval facts + `hold` → draft mapping),
`pr/body.ts` (new sections), `pr-title.ts` (drops sentinel parsing, keeps sanitiser + fallback),
`phase.ts` / `types.ts` / `state.ts` (new outcome, single fix-loop state), `config.ts` + config schema
(aliases, deprecations), `operations/finish-fix.ts` prompt (grouped by source).

## 10. Delivery

One branch stack, three PRs:

1. **Review ops** — schema, both ops, prompt builders, A3 hints reader, roles, tests. Unwired, inert.
2. **Machine rewrite** — merge/dedupe, fix loop, resolution, PR body and title, config aliases, advisor
   mapping; wired behind the existing `finish.enabled`.
3. **Deletions + docs** — old review stack, narrative op, `incomplete` route; README / config docs.

Each PR passes the full `check:all` before push and gets a code review before push.

## 11. Testing

**Unit (TDD):**
- each op: prompt contents (spec op gets spec + PRD + trusted decisions; branch op gets A3 hints), JSON
  parse including a multi-line `summary`, retry → review missing, title sanitise + fallback;
- `merge-findings`: source labels, duplicate collapse, contradiction → judgment;
- `resolve`: one case per end state — clean; open findings at cap; red acceptance; red gates; missing
  review; advisor approve / re-review / hold / malformed; advisor off — each maps to ready / draft /
  failed as specified, and none stops before the PR step;
- `a3-hints`: skip verdicts read, absent dir = no hints, unreadable file = skipped with debug log;
- PR body snapshots for ready and draft;
- config: `escalation` alias, narrative keys ignored with warning, every `nax-finish-*` profile shape
  parses (fixtures copied into the test tree, no private project names).

**Integration:** a finish run over a fixture repo with a fake agent, acceptance through the PR call, one
ready path and one draft path.

**Go-live (billed, each needs maintainer approval at launch):**
1. **Catch-rate replay, review ops only.** Run both new ops at the recorded SHAs of the 10 seed cases
   with a real signal (4 spec-vs-code, 6 design calls), reusing the A1 replay's SHA mapping. Bar:
   ≥ 8 / 10 raise the recorded concern in some form. Estimated $1-3.
2. **One live finish** on the local build with `nax-finish-native,advisor` on a real feature. Expected:
   a PR opens (ready or draft), no escalation, coverage telemetry in the audit.

## 12. Out of scope (follow-ups)

- The `nax-finish` skill (nax-toolkit-skills) describes "resume from escalation"; it needs a
  "take over a draft PR" mode.
- A full finish replay harness (old vs new finish end to end on the seed).
- Per-story design / clean-code review (R1).
- Route-threshold tweaks and diff-size guards (still non-goals).

## 13. Done when

All three PRs merged; catch-rate replay ≥ 8 / 10; one live finish opened a PR; workspace master plan §7
has an A4 row with the outcome.
