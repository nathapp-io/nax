# #1861 — bless `Finding` as the persisted review-audit shape

Branch: `chore/1861-bless-finding-audit-shape` (cut from main `b99b4e2a0`).
Ruling: https://github.com/nathapp-io/nax/issues/1861#issuecomment-5550392979
Follow-up (do NOT scope in): https://github.com/nathapp-io/nax/issues/1863

## Ruling in one line

The review audit persists `Finding`. #942's canonical-`ReviewFinding` clause is obsolete for LLM findings. No on-disk migration, no artifact churn.

## Why (do not re-litigate)

Measured over 5,346 real `review-audit/*.json`:

- `advisoryFindings`: 2,141 records, 1,990 with `message`, 938 with `ruleId`.
- `result.findings`: 9,845 records, 1,149 with `message`, 8,789 with raw `issue`.
- `collectFromReviewAudit` reads `result.findings`, NOT `advisoryFindings`.
- `deriveRuleId` = `<category>:<slug of the LLM's prose>` gives 1,116 distinct ids over 1,994 findings; only 3 (0.3%) span more than one story. `category` gives 26 buckets, 14 spanning more than one story.

H1's predicate is "same ruleId across stories", so the #942 scheme makes H1 fire essentially never.

## Tasks

### 1. Op-path audit-shape test FIRST (TDD, characterization)

Write the replacement for the deleted `test/unit/review/semantic-audit-shape.test.ts`. It MUST drive the real op path, `src/operations/adversarial-review.ts` and `src/operations/semantic-review.ts`, and assert the shape those ops actually emit for `advisoryFindings` and `result.findings`.

Do NOT hand-author a fixture finding and assert against it. That is exactly how the deleted gate came to be green while production wrote another shape. Drive the op, capture what it returns.

If the test disagrees with the numbers above, STOP and report. That is a finding, not something to adjust the test around.

### 2. Delete the dead projection

- Delete `src/review/finding-projection.ts` (178 lines). Verify zero `src/` callers first: `llmFindingToReviewFinding`, `findingToReviewFinding`, `findingsToReviewFindings`, `ProjectionOptions`.
- Remove `export * from "./finding-projection";` at `src/review/index.ts:21`.
- `package.json` has no `exports` map and ships `dist/`, so this is not a public break.
- Keep `src/review/category-fix-target.ts` and everything else in `src/review/` — they are live.

### 3. Collapse the union

`src/review/review-audit.ts:42`: `export type AdvisoryFinding = Finding | ReviewFinding;` becomes `Finding`. Update the comment above it, which currently defers this decision to #1859; it should record the ruling instead. Follow the type through `src/runtime/dispatch-events.ts:141` and `src/review/review-audit.ts:83`.

### 4. Collateral tests — trim, do not mass-delete

- `test/unit/review/finding-projection.test.ts` — delete outright.
- `test/unit/review/adversarial-fixtarget.test.ts` — TRIM ONLY. AC3, AC4, AC5 are parity checks against the deleted `llmFindingToReviewFinding` and go. AC1, AC2, and the `#1368` test-path-override cases exercise the LIVE `toAdversarialReviewFindings` and MUST survive.
- `test/unit/review/semantic-categories.test.ts:188-189` — re-point the case-normalisation assertion at the live converter (`llmFindingToFinding` / `toReviewFindings`) instead of the deleted helper.

### 5. Correct the two comments that will otherwise rot

- `src/plugins/builtin/curator/collect.ts` `findingMessage` (~line 163) documents the `issue`/`suggestion` fallback as "legacy on-disk audits ... AC-4 transition compatibility". Under this ruling it is the PRIMARY path for roughly 8,800 records. KEEP the fallback. Fix the comment so a future cleanup does not remove it. `findingRuleId`'s `category` fallback is likewise intended behaviour now, not a degradation.
- `src/plugins/builtin/curator/heuristics.ts:169` calls a bare category collapse "the #942 defect this must not reintroduce". The ruling knowingly accepts category-level grouping as the ceiling for prose findings. Update the comment, and note the mitigation already in the code: the proposal line carries category, file list and gist samples. Reference #1863.

### 6. The second phantom gate

`test/unit/plugins/builtin/curator-heuristics-h1.test.ts` contains `describe("H1 — issue #942 AC-5: ruleId buckets are not single-word collapses")`, built on hand-authored observations with ruleIds no live LLM producer emits. It is green against a shape production never writes. Re-point it at what production emits, or retire it with a comment pointing at #1863. Do not leave it asserting the old contract.

## Out of scope

- Any change to on-disk artifacts or a migration.
- Anything about whether H1 can be made to work. That is #1863.
- Re-opening the #1859 deletion.

## Conventions

- Full suite is `bun run test`. NEVER bare `bun test`.
- `bun run lint` and `bun run typecheck` must pass. Lint includes `check:file-sizes` (600 warn / 800 max), so keep the new test file focused.
- No emojis in code, comments, or docs.
- Conventional commits, e.g. `chore(review): persist Finding as the canonical audit shape (#1861)`.
- Do NOT commit anything under `docs/superpowers/` — it is in `.git/info/exclude`.
- Do not push or open a PR. Stop when the branch is green and report.
