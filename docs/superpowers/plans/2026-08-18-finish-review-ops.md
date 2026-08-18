# Finish Review Layer and LLM Ops (`src/finish/review/`, `src/finish/ops/`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `src/finish/` everything that talks to a reviewer or a fixer: the canonical reviewer prose and its codegen, prompt assembly, the reply parser, the audit-gap gate, and the three `RunOperation`s (review, fix, narrative) that `callOp` dispatches. The `FinishOps` interface plan 2 defined stays unimplemented at the end of this plan — assembling the concrete object needs the PR and escalation halves, which are plan 4. Nothing is wired into the runner and `flows/nax-finish/` keeps running untouched.

**Architecture:** The three reviewer prose files become `.md` under `src/finish/review/references/`, canonical, with a committed `prompts.gen.ts` and a drift check in `bun run lint`. Prompt assembly, parsing and the obligation gate are pure modules over that prose. Each LLM step is one `RunOperation` parameterised by phase — `op.build` assembles the prompt, `op.parse` returns a structured value, and `op.retry` uses `makeParseRetryStrategy` instead of the flow's graph-level reprompt route (D2.2, already locked). Two seams the state machine is missing — the incremental re-review window and the gap notice for a re-review — are added to `FinishState` first, because without them the ported prompts have no way to receive their most important inputs.

**Tech Stack:** TypeScript, Bun (test runner and toolchain), Biome (format/lint).

**Spec:** `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` — this plan implements the review/ops half of **cutover step 2** (design section 6 step 2 is split across plans 2-4). Read sections 4.2 (module decomposition), 4.5 (operations), 4.9 (reviewer prose convergence) and 2.2 (why `GLUED_HEADING` dies) before starting.

**Predecessors:**
- `docs/superpowers/plans/2026-08-18-forge-shared-module.md` — shipped in PR #1626. `src/forge/` exists.
- `docs/superpowers/plans/2026-08-18-finish-core.md` — shipped in PR #1627. `src/finish/` exists: `types|state|route|audit|commit(-message)|context|ops|machine|index` plus `gates/{acceptance,quality}`, driven by `test/unit/finish/*.test.ts`. **Read `src/finish/ops.ts` first — it is the contract this plan fills in, and `src/finish/machine.ts` is the only consumer.**

## Global Constraints

Unchanged from the finish-core plan; repeated because they are the ones a worker trips over.

- Runtime is **Bun**. `src/` is Bun-native. **This plan does not touch `flows/`** — it is still the live implementation until the final cutover step.
- **Duplication with `flows/nax-finish/` is expected for the whole of this plan.** Both trees exist; only one is wired. Do not delete, edit or deduplicate anything under `flows/`, and do not import from it in either direction: `flows/` is loaded by a separate acpx process where the `@/*` alias does not exist.
- **File size caps:** 600 lines for `src/`, 800 for `test/` (`scripts/check-file-sizes.ts`). `src/finish/review/prompt.ts` and the generated `prompts.gen.ts` are the two at risk — the prose is 288 lines of `.md` today.
- **No emojis** in code, comments, or documentation. The three reference files are emoji-free today (they use `≥`, `≠`, `→`, all BMP); keep them that way.
- **Imports:** `@/` alias for other modules, **relative inside `src/finish/`** (`./types`, `../route`), because `src/finish/index.ts` exists and `scripts/check-alias-internals.ts` flags any value import reaching past a barrel. `@/cli`, `@/config`, `@/operations`, `@/agents` — never their subpaths. `src/utils/` has no barrel, so `@/utils/git` is correct.
- `scripts/check-deep-relatives.ts` has a frozen baseline — **new tests import `@/finish`**, not `../../../src/finish/...`. Existing `test/unit/operations/*.test.ts` files use deep relatives; do not copy that habit into new files. If the baseline must move, use `bun run check:deep-relatives:update` and say so in the commit.
- **Temp directories in tests:** `makeTempDir` / `cleanupTempDir` / `withTempDir` from `test/helpers/temp.ts`. `.nax/rules/forbidden-patterns-tests.md` forbids hand-rolled `rm -rf` cleanup.
- **Errors:** `NaxError` from `src/errors.ts` with a `FINISH_*` code. `scripts/check-nax-error.ts` has a baseline — do not add violations.
- **Commits:** conventional commits. Attribution is disabled globally; no co-author trailers.
- **Branch:** `feat/finish-review-ops`, created from `main` (already created alongside this plan).
- **Gates before every commit:** `bun x tsc --noEmit`, `bun run lint`, and the task's own tests. A pre-commit hook runs the full static-check suite and will reject the commit if anything fails.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/finish/review/references/spec-review.md` | Spec-relative review dimensions. Canonical prose. |
| `src/finish/review/references/code-quality.md` | Code quality and test-integrity dimensions. Canonical prose. |
| `src/finish/review/references/worker-protocol.md` | Shared worker protocol, mechanics plus output format. Canonical prose. |
| `src/finish/review/prompts.gen.ts` | Generated from the three `.md`. Committed. Never hand-edited. |
| `scripts/generate-review-prompts.ts` | The generator. |
| `scripts/check-review-prompts-generated.ts` | Drift check, wired into `bun run lint`. |
| `src/finish/review/prompt.ts` | `buildReviewPrompt`, `buildFixPrompt`, `outputContract`, `CLASSIFIER`. |
| `src/finish/review/parse.ts` | `parseReviewReport`, `parseDispositions`. Pure, non-throwing. |
| `src/finish/review/audit-gaps.ts` | `auditGaps`, `validateDispositions`. |
| `src/finish/review/index.ts` | Barrel for the review subtree. |
| `src/finish/ops/review-op.ts` | `finishReviewOp` — one `RunOperation`, parameterised by phase. |
| `src/finish/ops/fix-op.ts` | `finishFixOp` — one `RunOperation`, parameterised by phase. |
| `src/finish/ops/narrative-op.ts` | `finishNarrativeOp` plus the narrative prose helpers. |
| `src/finish/ops/index.ts` | Barrel for the ops subtree. |
| `test/unit/finish/review-parse.test.ts` | Ported from `test/unit/flows/nax-finish/findings-parse.test.ts`. |
| `test/unit/finish/review-audit-gaps.test.ts` | Gate behaviour and path confinement. |
| `test/unit/finish/review-prompt.test.ts` | Ported from `test/unit/flows/nax-finish/review-prompts.test.ts`. |
| `test/unit/finish/ops-review.test.ts` | Op shape, build, parse, retry policy. |
| `test/unit/finish/ops-fix.test.ts` | Op shape, build per phase, disposition parse and validation. |
| `test/unit/finish/ops-narrative.test.ts` | Ported from `test/unit/flows/nax-finish/narrative.test.ts`. |
| `test/unit/finish/review-window.test.ts` | The two new state seams (Task 1). |

**Modified:**

| File | Change |
| --- | --- |
| `src/finish/state.ts` | Two fields on `FinishPhaseState` — `reviewSince`, `reviewGaps` (Task 1). |
| `src/finish/machine.ts` | Populate and clear them (Task 1). |
| `src/finish/index.ts` | Re-export the review and ops subtrees. |
| `src/runtime/session-role.ts` | Four new canonical roles (Task 6). |
| `package.json` | `check:review-prompts` script, appended to `lint`. |

**Deleted:** none.

---

## Out of scope for this plan

- **The concrete `FinishOps` object.** `openDraftPr`, `promotePr` and `escalate` need the PR body, the forge calls and the notification channel; those are plan 4, which also assembles the `FinishOps` implementation that hands these ops their `CallContext`. This plan ships the ops themselves and their pure layers.
- **The PR body, title and template merge.** `flows/nax-finish/steps/pr-body.ts`, `pr-title.ts` and `pr-template-merge.ts` move in plan 4. The narrative op ships here, but nothing consumes its prose until plan 4 amends the body with it.
- **Config.** `finish.autoFlow.*` -> `finish.*`, the reviewer `{agent, model}` reshape and the compat shim are the wiring plan's. This plan takes the reviewer model selection as **op input**, so no schema change is needed to build or test it (D3.6).
- **Wiring.** `PostRunPhase`, `runFinishPhase`, `status-writer.ts`, `usePipelineBusEvents.ts`, cost snapshots and deleting `flows/` all belong to the wiring plan.
- **The `nax-toolkit-skills` sync.** Cutover step 5. This plan makes nax's copies canonical and proves them byte-identical to what ships today; the skills repo's own sync script and drift check are a separate PR in that repo.

---

## Decisions this plan locks

Read these before writing code. Each departs from a line-by-line port and each has a reason.

**D3.1 — The re-review window and the gap notice become state, because today they are nowhere.** `buildReviewPrompt` takes `since`, `priorFindings` and `gaps`. In the flow, `since` came from `incrementalSince` (the `shaBefore` of the first commit recorded after this phase's last review) and `gaps` from `route_<phase>`'s output. Plan 2 kept neither: `FinishRound` records `sha` (the sha *after* the commit) but not `shaBefore`, and `machine.ts`'s `incomplete` branch drops `routed.gaps` on the floor. Left as-is, every re-review re-reads the whole branch diff (the 58% wall-clock regression the incremental window was built to fix) and every retry after an `incomplete` verdict is sent back with no statement of what it skipped — which, with `MAX_INCOMPLETE_ATTEMPTS = 1`, means the retry has one chance and no instructions. Both become fields on `FinishPhaseState`, set by the machine, read by the review op. They are plain strings/arrays, so the state stays serializable.

**D3.2 — The `since` window spans commits from any phase, not just this one.** `incrementalSince` searched for the first `commit_*` step after the last `review_<phase>` step — any commit, including the acceptance-loop commits a spec fix triggers through I8. Reproduce that semantics: the machine sets `reviewSince` on **every review phase whose `reviewSince` is currently unset and whose `reviewAttempts > 0`** after any commit lands, so the window provably spans every change since that phase's last verdict. Setting it only for the phase that owns the commit reintroduces the exact hole the flow's comment names.

**D3.3 — `GLUED_HEADING` is deleted, and this is now verified rather than asserted.** `src/agents/acp/adapter-output.ts:19` joins assistant messages with `"\n"`; the acpx flow layer joined stdout chunks with no separator, which is what glued `…confidence bar.## TOUCHPOINTS` into one line. A heading can no longer land mid-line, so the regex, its three guards and its tests do not move. The regression tests that pinned it (`findings-parse.test.ts`, the glued-heading cases) are **not** ported — port the rest of that file unchanged.

**D3.4 — The reviewer's reply stays free text, and `parse` never throws.** The block contract exists because a JSON object has nowhere to put the per-AC and per-function walks, and because a malformed line should cost one line rather than the whole review (#1614). `op.parse` returns a `ReviewReport` with `saw*Section` flags; an unreadable reply returns an empty report, not an exception. The retry policy (`makeParseRetryStrategy`) fires on the validation probe, and exhaustion returns the empty report — which `routeReview` already treats as "no verdict" and escalates (`src/finish/route.ts`, first branch). Nothing about that path may throw, because the machine's catch would report it as an infra failure rather than an unread review.

**D3.5 — The legacy JSON parse tier does not move.** `parseReviewVerdict`'s second tier existed so a flow resumed from a pre-#1614 acpx journal could still be read. There are no nax finish journals to resume — resume is deferred by design (spec section 7) and `FinishState` is version 1 — so the tier has no input. Its absence is why `parse` returns `ReviewReport` directly instead of `ReviewVerdict`; `ReviewVerdict` itself is legacy shape and is not used by the ops.

**D3.6 — Reviewer model selection arrives as op input, not from config.** `RunOperation.model` accepts a resolver `(input, ctx) => ConfiguredModel | undefined` (`src/operations/types.ts`), which is how `semanticReviewOp` carries its tier on `input.semanticConfig.model`. Do the same: `FinishReviewInput.model?: ConfiguredModel`, resolver returns it, `callOp` falls back to `"balanced"` when absent. That keeps the config reshape entirely in the wiring plan and keeps these ops testable with no config fixture.

**D3.7 — The generator is the only writer of `prompts.gen.ts`, and the `.md` is the only source.** `worker-protocol.md` inlines the finding block that the flow's `.ts` interpolates as `${FINDING_BLOCK_SHAPE}` — that one interpolation is the *entire* difference between the two representations (verified by diff; the two dimension files are byte-identical). So the generator splits `worker-protocol.md` on its `## Output format` heading into `WORKER_PROTOCOL_MECHANICS` and the remainder, extracts `FINDING_BLOCK_SHAPE` from the fenced block inside that section, and emits `WORKER_PROTOCOL` as the whole file. The #1625 split (mechanics used alone by `buildReviewPrompt`, the full protocol exported only for byte-diffing) is preserved by construction — **do not re-derive that fix, and do not let the assembled prompt carry two output contracts again.**

**D3.8 — Dispositions are validated inside the fix op (closing D2.7).** `commit.ts` records dispositions as given; the fix op's `verify` hook resolves each rejection's cited path against the workdir and marks `evidenceMissing`. `verify` is the sanctioned hook for a post-parse pass that consults disk (`src/operations/types.ts`), and it is the only place with both the parsed value and a filesystem. Do not add a second validation pass in `commit.ts`.

---

### Task 1: The re-review window and the gap notice

**Files:** `src/finish/state.ts`, `src/finish/machine.ts`, `test/unit/finish/review-window.test.ts`

Nothing downstream of this plan works without it: the ported prompts take `since` and `gaps`, and plan 2 kept neither (D3.1).

**Steps:**

- [ ] Write `test/unit/finish/review-window.test.ts` first, driving `runFinishMachine` with stub `FinishOps` exactly the way `test/unit/finish/machine-loops.test.ts` already does. Watch it fail.
- [ ] Add to `FinishPhaseState` in `src/finish/state.ts`:

```ts
  /**
   * The commit this phase's next review diffs from — the `shaBefore` of the
   * first commit that landed after its last verdict, not the latest one.
   *
   * The acceptance loop can commit between a spec fix and its re-review (I8),
   * so a window anchored on the most recent commit would silently exclude the
   * fix that triggered it. Unset means "no commit since the last verdict", and
   * the reviewer reads the full branch diff.
   */
  reviewSince?: string;
  /**
   * Why this phase's last review was sent back, so the retry is told what it
   * skipped. Cleared when a review runs, because it describes the previous
   * attempt only.
   */
  reviewGaps?: string[];
```

- [ ] `createFinishState` leaves both absent (do not initialise to `null`/`[]` — absent is the "no window" signal and the serializer must not persist empties).
- [ ] In `machine.ts`, add one private helper and call it after **every** `commitFixes` call site (the acceptance loop, the review loop, the gate loop):

```ts
/**
 * Record the window a later re-review will diff from (D3.2).
 *
 * Applies to every reviewed phase that has already produced a verdict and has
 * no window yet — a commit made by the acceptance loop during a spec fix must
 * widen the spec reviewer's next window, which is why this is not scoped to the
 * phase that owns the commit.
 */
function noteCommitWindow(state: FinishState, shaBefore: string | null): void {
  if (!shaBefore) return;
  for (const phase of ["spec", "quality"] as const) {
    const st = state.phases[phase];
    if (st.reviewAttempts > 0 && !st.reviewSince) st.reviewSince = shaBefore;
  }
}
```

- [ ] In `runReviewLoop`, immediately after `const outcome = await ops.review(...)` and the `reviewAttempts += 1` line, clear both fields for that phase: the window and the gap notice describe the attempt just consumed.
- [ ] In `runReviewLoop`'s `incomplete` branch, set `phaseState.reviewGaps = routed.gaps ?? []` **before** `continue`. Order matters: the clear above runs at the top of the next iteration after `ops.review` has already been handed the state, so a gap set here survives exactly one review call.
- [ ] Leave `commitFixes`'s return shape alone — it already returns `shaBefore`; the machine simply stopped reading it.

**Verification:**

- [ ] `bun test test/unit/finish/review-window.test.ts` — asserts: (1) a commit made by the acceptance loop during a spec-fix round sets `phases.spec.reviewSince` to that commit's `shaBefore` (D3.2); (2) `reviewSince` is not overwritten by a second commit in the same round — it pins the first; (3) `ops.review` for a phase observes the `reviewSince`/`reviewGaps` set since its last call, and observes them cleared on the call after; (4) an `incomplete` verdict puts its gaps on the state and the next review call sees them; (5) a fresh state serializes with neither key present.
- [ ] `bun test test/unit/finish/machine-loops.test.ts test/unit/finish/machine-invariants.test.ts` — I1-I8 still hold.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `fix(finish): carry the re-review window and gap notice on finish state`.

---

### Task 2: Canonical reviewer prose, generator, drift check

**Files:** `src/finish/review/references/*.md`, `src/finish/review/prompts.gen.ts`, `scripts/generate-review-prompts.ts`, `scripts/check-review-prompts-generated.ts`, `package.json`

**Steps:**

- [ ] Produce the three `.md` files **from the flow's constants**, not by hand and not by copying the skills repo (which may not be checked out): unescape `\``, `\$` and `\\` from the template literals in `flows/nax-finish/review-prompts.ts` and write the result. `SPEC_REVIEW_DIMENSIONS` -> `spec-review.md`, `QUALITY_REVIEW_DIMENSIONS` -> `code-quality.md`, `WORKER_PROTOCOL_MECHANICS + WORKER_PROTOCOL_OUTPUT_FORMAT` -> `worker-protocol.md` with `${FINDING_BLOCK_SHAPE}` replaced by the literal fenced block it interpolates (D3.7). Each file ends with a single trailing newline.
- [ ] Write `scripts/generate-review-prompts.ts`. It reads the three `.md`, and emits `src/finish/review/prompts.gen.ts` exporting:
  - `SPEC_REVIEW_DIMENSIONS`, `QUALITY_REVIEW_DIMENSIONS` — whole files.
  - `WORKER_PROTOCOL` — the whole of `worker-protocol.md`.
  - `WORKER_PROTOCOL_MECHANICS` — everything before the `## Output format` heading.
  - `FINDING_BLOCK_SHAPE` — the contents of the first fenced block inside the `## Output format` section.
  - A header comment stating the file is generated by this script from `references/*.md` and must not be edited, and naming the check script.
  - Escaping: backtick and `${` must be escaped in the emitted template literals. A file that round-trips unequal is a generator bug, not an input problem.
- [ ] Write `scripts/check-review-prompts-generated.ts`: regenerate in memory, compare to the committed file, exit 1 with the first differing line on drift. Follow the shape of an existing `scripts/check-*.ts` (`check-file-sizes.ts` is the closest for output style).
- [ ] `package.json`: add `"check:review-prompts": "bun run scripts/check-review-prompts-generated.ts"` and `"gen:review-prompts": "bun run scripts/generate-review-prompts.ts"`, and append `&& bun run check:review-prompts` to the `lint` chain.
- [ ] Run `bun run gen:review-prompts` and commit the generated file.

**Verification:**

- [ ] Prove the port changed no prose: a scratch script (not committed) that unescapes the four flow constants and compares them to the generated exports must report equality on all four, with `WORKER_PROTOCOL` compared against mechanics + output format. Paste the result into the commit body.
- [ ] `bun run check:review-prompts` passes; then edit one character of a `.md`, re-run, confirm it fails, and revert.
- [ ] `bun run check:file-sizes` — `prompts.gen.ts` must be under 600 lines. If the emitted file exceeds it, split the generator's output per source file (`spec-review.gen.ts` etc.) rather than adding a baseline entry.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): make the reviewer prose canonical in-repo with a drift check`.

---

### Task 3: The reply parser

**Files:** `src/finish/review/parse.ts`, `test/unit/finish/review-parse.test.ts`

**Steps:**

- [ ] Port `test/unit/flows/nax-finish/findings-parse.test.ts` to `test/unit/finish/review-parse.test.ts`, importing from `@/finish`. **Drop only the glued-heading cases** (D3.3); everything else moves with its assertions untouched — it is the strongest evidence the port changed nothing.
- [ ] Port `flows/nax-finish/findings-parse.ts` to `src/finish/review/parse.ts`: `parseReviewReport` and `parseDispositions`, with `HEADING`, `BLOCK`, `FIELD`, `NO_FINDINGS`, `BULLET`, `DISPOSITION`, `EVIDENCE`, `parseTouchpoint` and `parseJudgment`. Keep every doc comment except `GLUED_HEADING`'s.
- [ ] Delete the `GLUED_HEADING` constant and the `text.replace(GLUED_HEADING, "$1\n$2")` normalisation. Replace the removed block comment with a short one naming `src/agents/acp/adapter-output.ts`'s newline join as the reason it is unnecessary in-process, so a future reader does not "restore" it.
- [ ] Keep the "section state starts at `findings`" behaviour and the `saw*Section` flags exactly as they are — the audit gate keys off them and `routeReview` keys off the gate.
- [ ] Types come from `../types` (`Finding`, `FindingDisposition`, `ReviewReport`, `Severity`, `Touchpoint`) — all already present from plan 2.

**Verification:**

- [ ] `bun test test/unit/finish/review-parse.test.ts` — the ported suite passes unmodified.
- [ ] Add one new test: a reply whose narration ends without a newline followed by `## TOUCHPOINTS` on its own line parses the section normally (the case the deleted regex existed for, now handled upstream), and a reply with a literally glued `bar.## TOUCHPOINTS` reads as a missing section — which is correct, because in-process that input cannot arise from message joining.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): port the reviewer reply parser without the glued-heading workaround`.

---

### Task 4: The obligation gate

**Files:** `src/finish/review/audit-gaps.ts`, `test/unit/finish/review-audit-gaps.test.ts`

**Steps:**

- [ ] Write the test first, covering the five behaviours listed under Verification.
- [ ] Port `flows/nax-finish/steps/review-audit.ts` to `src/finish/review/audit-gaps.ts`: `auditGaps(report, workdir)` and `validateDispositions(workdir, dispositions)`, plus the private `exists` helper and `MAX_CHECKED = 20`.
- [ ] Two changes from the source, both required here:
  - Take a `ReviewReport` (Task 3's output), not a `ReviewVerdict`. The fields are the same four (`touchpoints`, `walk`, `sawTouchpointsSection`, `sawWalkSection`) but `ReviewVerdict` is legacy shape (D3.5).
  - Use `Bun.file(...).exists()` instead of `node:fs/promises` `stat` — the `node:fs` comment in the source exists only because `flows/` runs in acpx's Node process. **Keep the path confinement exactly as it is**: resolve under `workdir` and treat an escaping path as non-existent. Both `touchpoint.path` and a disposition's `evidence` are untrusted parsed model output.
- [ ] Keep the gap message strings verbatim — they are shown to the reviewer as the retry's instructions (Task 5's `gapNotice`), and a reworded string is a silently changed prompt.

**Verification:**

- [ ] `bun test test/unit/finish/review-audit-gaps.test.ts` — asserts: (1) an absent TOUCHPOINTS section and an empty one both report the touchpoints gap; (2) `- none — <justification>` discharges it without any stat; (3) a touchpoint list where **no** path exists reports the gap, while one real path among fakes discharges it (the source's `some` semantics — do not tighten this to `every` while porting); (4) a path escaping `workdir` via `../` reads as non-existent and never stats outside the root; (5) `validateDispositions` marks `evidenceMissing` only on a `rejected` disposition whose cited file is absent, and leaves `fixed` ones untouched.
- [ ] Use `withTempDir` from `test/helpers/temp.ts` for the real-path cases.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): port the review obligation gate onto Bun file APIs`.

---

### Task 5: Prompt assembly

**Files:** `src/finish/review/prompt.ts`, `src/finish/review/index.ts`, `test/unit/finish/review-prompt.test.ts`

**Steps:**

- [ ] Port `test/unit/flows/nax-finish/review-prompts.test.ts` to `test/unit/finish/review-prompt.test.ts`, importing from `@/finish`. Its `fixPrompt` cases need adapting to `buildFixPrompt`'s explicit arguments (below) — that is a call-shape change, not an assertion change: every expected string stays as it is.
- [ ] Port the assembly half of `flows/nax-finish/review-prompts.ts` — `CLASSIFIER`, `outputContract(phase)`, `buildReviewPrompt(phase, args)`, `fixPrompt` — into `src/finish/review/prompt.ts`, taking the prose from `./prompts.gen`. The prose constants themselves do **not** move here.
- [ ] `buildReviewPrompt`'s signature stays `(phase, { base, specPath, since?, priorFindings?, gaps? })`. Keep both branches (full-diff and incremental) and the `gapNotice` prefix verbatim, doc comments included.
- [ ] Rename and reshape `fixPrompt` to `buildFixPrompt(phase, args)`, taking explicit arguments instead of an acpx `ctx.outputs` bag:

```ts
export function buildFixPrompt(
  phase: FinishPhase,
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string },
): string
```

  The `gate`/`acceptance` branch reads `gateOutput`/`acceptanceOutput`; the `spec`/`quality` branch numbers `findings` 1-based, exactly as today — the numbering is the contract the DISPOSITIONS reply indexes into, so an off-by-one here silently misattributes every rejection.
- [ ] Keep the fix prompt's two standing instructions unchanged: "Do not commit, push, or open PRs" (the machine commits) and the evidence requirement on a rejection.
- [ ] Add `src/finish/review/index.ts` exporting the prose constants, `buildReviewPrompt`, `buildFixPrompt`, `parseReviewReport`, `parseDispositions`, `auditGaps`, `validateDispositions`.

**Verification:**

- [ ] `bun test test/unit/finish/review-prompt.test.ts` — the ported suite passes.
- [ ] Add three tests the flow's suite does not have: (1) the assembled review prompt contains the `## FINDINGS` contract **once** — the #1625 regression, asserted on the assembled string rather than on the constants; (2) with `gaps` set, the prompt opens with the gap notice and names each gap; (3) with `since` set, the prompt references `git diff <since>..HEAD` and includes the prior findings JSON, and with it unset references `git diff <base>...HEAD` (three dots — the two forms are different diffs and the tests must pin which is which).
- [ ] `bun x tsc --noEmit && bun run lint && bun run check:file-sizes`.
- [ ] Commit: `feat(finish): port review and fix prompt assembly onto the generated prose`.

---

### Task 6: The review op

**Files:** `src/runtime/session-role.ts`, `src/finish/ops/review-op.ts`, `src/finish/ops/index.ts`, `test/unit/finish/ops-review.test.ts`

**Steps:**

- [ ] Add `"finish-review-spec"`, `"finish-review-quality"`, `"finish-fix"` and `"finish-narrative"` to **both** `CanonicalSessionRole` and `KNOWN_SESSION_ROLES` in `src/runtime/session-role.ts`. The list is closed and an unknown role is a spec-review failure; adding to one and not the other compiles but fails `isSessionRole`.
- [ ] Write `test/unit/finish/ops-review.test.ts` first. Model it on `test/unit/operations/acceptance-fix.test.ts` — assert `kind`, `name`, `session.role`, `session.lifetime`, `stage`, then drive `build` and `parse` directly with a `{ packageView, config }` context built from `makeTestRuntime()`. Import the op from `@/finish`. Close every runtime in `afterEach`.
- [ ] Implement `src/finish/ops/review-op.ts`:

```ts
export interface FinishReviewInput {
  phase: "spec" | "quality";
  base: string;
  specPath: string;
  workdir: string;
  since?: string;
  priorFindings?: Finding[];
  gaps?: string[];
  /** Reviewer selection, resolved by the caller from config (D3.6). */
  model?: ConfiguredModel;
  timeoutMs?: number;
}
```

  - `kind: "run"`, `name: "finish-review"`, `stage: "review"`, `config: finishConfigSelector` (already exists, `src/config/selectors.ts:138`).
  - `session: { role: input.phase === "spec" ? ... }` is **not** expressible — `session.role` is a static field, not a resolver. Declare `session: { role: "finish-review-spec", lifetime: "fresh" }` on the op and pass the per-phase role through `CallContext.sessionOverride.role`, which `callOp` already honours. Assert that in the test so nobody "fixes" it into a non-existent resolver.
  - `model: (input) => input.model`, `timeoutMs: (input) => input.timeoutMs`.
  - `build`: `{ role: {...}, task: { content: buildReviewPrompt(input.phase, input) } }` — same `ComposeInput` shape `semanticReviewOp` uses.
  - `parse`: `parseReviewReport(output)`. Never throws (D3.4).
  - `retry`: `makeParseRetryStrategy({ ... })`. Read `src/agents/retry/parse-retry.ts` before writing it — three of its options are easy to get wrong here:
    - `prompts` requires **both** `invalid` and `truncated` (`ParseRetryOpts` declares neither optional). Give each real text: `invalid` re-states the three-section contract; `truncated` asks for the FINDINGS section alone.
    - `looksTruncated` defaults to `looksLikeTruncatedJson`, which is meaningless against a free-text reply. Pass an explicit text-aware predicate (an unterminated finding block, i.e. a `[SEVERITY]` line with no following `Fix:`), or `() => false` if that proves noisy. Leaving the default in place silently classifies every reply by JSON heuristics.
    - `parse: (t) => parseReviewReport(t)` and `validate` must be the real check — the strategy re-parses `ctx.lastOutput` on every turn, so a constant `validate` over-retries. Validate that the reply produced findings **or** the `No findings.` marker, which is exactly the distinction between a review and a narration.
    - `exhaustedFallback: () => <empty report>` so exhaustion degrades to "no verdict" (which `routeReview` escalates) rather than throwing (D3.4). `reviewerKind: "finish-review"`, `maxAttempts: 2`.
- [ ] Add `verify` that runs `auditGaps(report, input.workdir)` and returns the report with its gaps attached, so the caller gets `{ findings, gaps }` — the `ReviewOutcome` shape `routeReview` consumes (`src/finish/route.ts`). `verify` is the sanctioned disk-consulting hook; `parse` must stay side-effect free.
- [ ] Export the op and a `FinishReviewOutput` type through `src/finish/ops/index.ts` and the module barrel.

**Verification:**

- [ ] `bun test test/unit/finish/ops-review.test.ts` — asserts: (1) op shape, including that `stage` is `"review"` and `session.lifetime` is `"fresh"`; (2) `build` for `spec` contains the spec dimensions and not the quality ones, and vice versa; (3) `build` with `since` produces the incremental prompt; (4) `parse` of a well-formed reply returns the findings and both `saw*Section` flags true; (5) `parse` of an empty string returns an empty report rather than throwing; (6) `verify` attaches the gaps `auditGaps` reports, against a temp workdir.
- [ ] `bun test test/unit/runtime` — the session-role additions break nothing.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add the phase-parameterised review operation`.

---

### Task 7: The fix op

**Files:** `src/finish/ops/fix-op.ts`, `test/unit/finish/ops-fix.test.ts`

**Steps:**

- [ ] Write the test first, same shape as Task 6's.
- [ ] Implement `finishFixOp` with input `{ phase: FinishPhase; workdir: string; findings?: Finding[]; failing?: string[]; gateOutput?: string; acceptanceOutput?: string; model?: ConfiguredModel; timeoutMs?: number }`.
  - `stage: "rectification"`, `session: { role: "finish-fix", lifetime: "fresh" }`, `name: "finish-fix"`, `config: finishConfigSelector`.
  - `build`: `buildFixPrompt(input.phase, input)`.
  - `parse`: `{ dispositions: parseDispositions(output) }` — nothing else in the reply is read. The flow's `parseFixVerdict` comment says why the route is not computed here: a bare `[1]` disposition line parses as a one-element JSON array and would flip the route. There is no route to flip now, but do not reintroduce a JSON tier for the same reason.
  - `verify`: `validateDispositions(input.workdir, parsed.dispositions)` (D3.8), returning the marked list.
  - No `retry`: a fix reply carrying no DISPOSITIONS section is not a parse failure — the fixer's real output is the working tree, which `commitFixes` reads independently. Re-prompting for prose the machine does not depend on spends a turn for nothing. State this in the op's doc comment so it is not "fixed" later.
- [ ] The op's output type is `FixOutcome` from `src/finish/ops.ts` (`{ dispositions?: FindingDisposition[] }`) — reuse it rather than declaring a parallel shape, so plan 4's assembly is a straight pass-through.

**Verification:**

- [ ] `bun test test/unit/finish/ops-fix.test.ts` — asserts: (1) op shape; (2) `build` for `gate` includes the gate output and does not number findings; (3) `build` for `spec` numbers findings 1-based in the order given; (4) `parse` reads `[1] fixed` / `[2] rejected — evidence: path:42` into two dispositions with the right indices; (5) `parse` of a reply with no DISPOSITIONS section returns an empty list without throwing; (6) `verify` marks `evidenceMissing` on a rejection citing a file absent from a temp workdir and leaves a present one unmarked.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add the phase-parameterised fix operation`.

---

### Task 8: The narrative op

**Files:** `src/finish/ops/narrative-op.ts`, `test/unit/finish/ops-narrative.test.ts`

**Steps:**

- [ ] Port `test/unit/flows/nax-finish/narrative.test.ts` to `test/unit/finish/ops-narrative.test.ts`, importing from `@/finish`.
- [ ] Port `flows/nax-finish/narrative.ts`'s pure half into `src/finish/ops/narrative-op.ts`: `NARRATIVE_MAX_CHARS`, `buildNarrativePrompt`, `parseNarrative`, `parseNarrativeNode`, `resolveNarrative`, `readSpecSummary`, `truncate`, `sectionBody` and the tag/heading regexes. Drop `narrativePrompt(ctx)` — it is the acpx `ctx.outputs` adapter and its caller does not exist here.
- [ ] `readSpecSummary` reads the spec from disk; move it onto `Bun.file` and keep its fallback behaviour (a missing or sectionless spec yields `null`, and `resolveNarrative` falls back accordingly).
- [ ] Add `finishNarrativeOp`: `stage: "complete"`, `session: { role: "finish-narrative", lifetime: "fresh" }`, `name: "finish-narrative"`, `config: finishConfigSelector`, `build` from `buildNarrativePrompt`, `parse` via `parseNarrativeNode`, `model: (input) => input.model`. No `retry` — an unusable narrative is dropped, never re-prompted, because the PR body has a deterministic fallback and the prose is cosmetic.
- [ ] The op's input carries the base body text the narrative is written against (`{ base: string; model?: ConfiguredModel; timeoutMs?: number }`). Assembling that base body is plan 4's; this op only needs the string.

**Verification:**

- [ ] `bun test test/unit/finish/ops-narrative.test.ts` — the ported suite passes, including the truncation-at-`NARRATIVE_MAX_CHARS` and tag-extraction cases.
- [ ] Add one test: `parse` of a reply with no `<narrative>` tags and no "What changed" heading yields the empty result the PR body treats as "no narrative", rather than the raw reply.
- [ ] `bun x tsc --noEmit && bun run lint`.
- [ ] Commit: `feat(finish): add the narrative operation and its prose helpers`.

---

## Verification (whole plan)

- [ ] `bun test test/unit/finish` — every finish test, old and new, green.
- [ ] `bun run lint` — including the new `check:review-prompts`.
- [ ] `bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.contracts.json`.
- [ ] `bun run check:file-sizes && bun run check:alias-internals && bun run check:deep-relatives`.
- [ ] `bun run test` — the full suite, once, before opening the PR.
- [ ] Confirm by inspection that `flows/nax-finish/` is byte-identical to `main` (`git diff main -- flows/` is empty) and that nothing under `src/` imports from it.
- [ ] Confirm `src/finish/ops.ts` is unchanged: this plan implements ops, it does not renegotiate their contract. If a task made that impossible, stop and record why rather than editing the interface silently.

## What the next plan inherits

Plan 4 (PR, escalation, and the `FinishOps` assembly) starts from: the three ops, the review layer, the four session roles, and `FinishState` carrying its re-review window. It owes `pr-body.ts` / `pr-title.ts` / `pr-template-merge.ts`, `escalate.ts` and the notification channel, plus the object that hands each op a `CallContext` and satisfies `FinishOps` — at which point `runFinishMachine` is drivable for real and the wiring plan is the only thing left.
