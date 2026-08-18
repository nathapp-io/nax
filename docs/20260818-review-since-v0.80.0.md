# Code Review: changes since v0.80.0

**Date:** 2026-08-18
**Reviewer:** Claude (AI)
**Range:** `v0.80.0..HEAD` (444434d7)
**Commits:** 8
**Files:** 61 non-test + 23 test (84 total), +4422/-1555

---

## Overall Grade: A (91/100)

Eight tightly-scoped fix/feat commits, each addressing a single named issue (compat-shim chain, worktree inherit-mode removal, context budget accounting, `.naxignore` scaffolding, nax-finish reviewer fidelity, and a P0–P3 batch from the 2026-08-17 review). Test coverage grew alongside every behavioral change. All findings are now fixed on `fix/review-v0.80.0-followups` — see status per finding below.

---

## Findings

### 🟢 LOW (downgraded from MEDIUM after deep verification — see note)

#### BUG-1: `adversarialAcceptAnalysis` pass-through in the passed-review path diverges from documented "unchanged" behavior
**File:** `src/review/adversarial-outcomes.ts:470` (`buildPassedResult`) — **FIXED**
**Severity:** LOW (latent, not currently reachable) | **Category:** Bug (defensive correctness)

Pre-refactor (`v0.80.0:src/review/adversarial.ts`), all three non-blocking outcome branches — "hallucinated AC quote demoted to pass", "ungrounded fail-closed", and the genuine "passed" branch — explicitly hardcoded `adversarialAcceptAnalysis: []` in their `recordAdversarialAudit` call, even with the real computed value in scope. Only the blocking-failure branch recorded the real value. After the split into `adversarial-outcomes.ts`, `buildPassedResult` started passing through `telemetry.adversarialAcceptAnalysis` instead of hardcoding `[]`; the other two outcome builders correctly kept `[]`. This contradicts the file's own header comment ("reproduces, unchanged, one stage of that original function").

**Deep verification:** `adversarialAcceptAnalysis` is computed as `blockingFindings.map(...)` (`adversarial-counterfactual-telemetry.ts:57`), and `buildPassedResult` is only ever invoked via the `else` branch *after* `if (blockingFindings.length > 0)` already returned early. So at the call site, `blockingFindings` — and therefore `telemetry.adversarialAcceptAnalysis` — is always empty by construction today. **The divergence is currently dead code, not a live data-correctness bug.** It's a latent footgun: if `buildPassedResult` is ever reused on a path where blocking findings aren't guaranteed empty, the silent pass-through would start leaking real data into passed-review audit events.

**Fix (applied):** `buildPassedResult` now hardcodes `adversarialAcceptAnalysis: []`, matching pre-refactor behavior and removing the footgun.

---

### 🟢 LOW

#### ENH-1: Budget notice chunk isn't counted against its own budget
**File:** `src/context/engine/providers/static-rules-budget-notice.ts` (`buildBudgetNoticeChunk`) — **FIXED (documented)**
**Severity:** LOW | **Category:** Enhancement

`estimateTokens(content)` for the notice chunk is computed and added *after* `applySectionBudget` has already enforced `budgetTokens`, so the emitted prompt can exceed the configured budget by the notice chunk's own size. Confirmed intentional — the notice's content (which sections were dropped) isn't knowable until after the budget pass runs, and its size is capped by `MAX_LISTED_DROPPED_IDS`. Added a one-line comment recording this as intentional rather than an oversight.

#### ENH-2: `auditGaps` touchpoint check only fires when every touchpoint is fabricated
**File:** `flows/nax-finish/steps/review-audit.ts` — **no code change (already documented as accepted tradeoff)**
**Severity:** LOW | **Category:** Enhancement (informational)

`!found.some(Boolean)` only flags a gap when **none** of up to 20 listed touchpoints exist on disk — a reviewer citing one real file plus many fabricated ones still passes. This is explicitly called out in the file's own doc comment as an accepted, cost-raising-not-eliminating tradeoff, so not a bug, just weaker than "verifies the reviewer's work" might suggest to a reader who hasn't read the comment.

#### STYLE-1: Doc-comment drift in `mergePackageConfig`
**File:** `src/config/merge.ts:34` — **FIXED**
**Severity:** LOW | **Category:** Style

The doc comment listing merged `execution:` fields omitted `worktreeDependencies`, even though it is deep-merged in code (confirmed `merge.ts:87-96`). Added it to the field list.

---

## Areas reviewed clean (no findings)

- **`src/config/*`** (compat-shims.ts, loader.ts, paths.ts, schemas*.ts) — the headline fix (#1620): the full compat-shim chain now runs on every config layer pre-merge (root global/project/profile/CLI *and* per-package overlays/profiles), not just a single patched shim. Verified this doesn't double-apply or break the root-only case. The new `validateFeatureId` in `paths.ts` is a solid defense-in-depth fix for previously-unvalidated `featureId` reaching ~38 path-construction sites.
- **`src/review/severity.ts`, `semantic.ts`/`semantic-outcomes.ts`** — the severity type change and semantic.ts split are behavior-preserving; audit/logging paths match pre-refactor exactly.
- **`src/worktree/dependencies.ts`, `types.ts`** — inherit-mode removal is complete; no dangling references anywhere in `src/` or `flows/`.
- **`src/context/engine/providers/code-neighbor.ts`** — independent forward/reverse budget split (`minReverseSlots = min(reverseNeighbors.size, ceil(MAX/2))` + backfill) is arithmetically correct, no off-by-one.
- **`src/utils/gitignore.ts`** — additive, idempotent patching; re-running produces no duplicate entries; no path-traversal exposure (caller-controlled path, not user input).
- **`flows/nax-finish/steps/review-audit.ts`** (`exists()`) — correct path-containment check (`resolved.startsWith(root + sep)`) before `stat`, guarding against `../` escapes from untrusted LLM-reported paths.
- **`flows/nax-finish/findings-parse.ts`** — pure, non-throwing parser of untrusted LLM text; no ReDoS-prone regex, no eval/dynamic code.
- **`bin/nax.ts`** — 176-line deletion delegating to `src/cli/init.ts`; good dedup, no behavior loss.

---

## Priority Fix Order

| Priority | ID | Effort | Description | Status |
|:---|:---|:---|:---|:---|
| P2 | BUG-1 | S | Restore `adversarialAcceptAnalysis: []` in `buildPassedResult` | Fixed |
| P3 | ENH-1 | S | Comment budget-notice self-accounting as intentional | Fixed |
| P3 | ENH-2 | — | No action needed; already documented as accepted tradeoff | No change needed |
| P3 | STYLE-1 | S | Update `mergePackageConfig` doc comment to include `worktreeDependencies` | Fixed |

All fixes on branch `fix/review-v0.80.0-followups`, verified with `bun run typecheck`, `bun run lint`, and the targeted review/context/config unit-test suites (1509 pass, 0 fail).
