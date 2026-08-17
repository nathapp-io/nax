# Code Review: fix/review-p0-p1-nax-quality (branch diff vs main)

**Date:** 2026-08-18
**Reviewer:** Claude (AI), 4 independent sub-agents + synthesis
**Scope:** `git diff main...fix/review-p0-p1-nax-quality` — 8 commits implementing P0–P3 of `docs/20260817-review-nax.md`
**Baseline:** 14,929 tests (unit + integration + ui), full pre-commit gate per commit

---

## Overall Grade: A- (88/100)

This branch is a self-review of refactors and security fixes made in response to a prior full-repo review, not a new feature. Four independent review agents each took one risk area (the `adversarial.ts` split, the `semantic.ts` split, the `config/loader.ts` split, and the bundled security fixes + `runner.ts` split) and were asked to adversarially verify the claim, made in every commit message, that each refactor preserves behavior exactly. Three of the four areas checked out completely. One area — the two review-runner decompositions — had a real, if narrow, regression that two independent agents caught by the same method (diffing old vs. new argument values at each `record*Audit()` call site): `blockingThreshold` was eagerly defaulted to `"error"` in a shared context object, changing what three early-exit audit events recorded from `undefined` to `"error"` when the caller omitted the option. That regression, plus a legitimate SEC-3 follow-on risk (an unguarded `featureDir()` throw reaching a function documented as "best-effort"), a type-safety fix that hadn't actually taken effect, and a couple of low-severity nits, are all fixed in this pass.

| Dimension | Score | Notes |
|:---|:---:|:---|
| Security | 19/20 | SEC-1/2/3 fixes verified correct; SEC-3's blast radius into a best-effort path was found and closed |
| Reliability | 18/20 | The blockingThreshold regression was real; caught and fixed before merge |
| API Design | 17/20 | Extracted helpers are cohesive; some exceed the 3-positional-param guideline (non-blocking) |
| Code Quality | 18/20 | `Severity` type alias didn't achieve its stated goal until this pass; now fixed |
| Best Practices | 16/20 | `loader.ts` grew to 544 lines (still under the 600 hard limit, but past the 400 "typical") |
| **Total** | **88/100** | |

---

## Findings — fixed in this pass

### 🟠 HIGH

#### BUG-2: `blockingThreshold` eagerly defaulted, changing audit telemetry on 3 early-exit paths (adversarial.ts + semantic.ts)
**Severity:** HIGH | **Category:** Bug (regression from claimed pure refactor)
**Files:** `src/review/adversarial.ts`, `src/review/adversarial-outcomes.ts`, `src/review/semantic.ts`, `src/review/semantic-outcomes.ts`

Two independent review agents (one per file) found the identical defect by the identical method. Both `AdversarialOutcomeCtx.blockingThreshold` and `SemanticOutcomeCtx.blockingThreshold` were typed as the non-optional `"error" | "warning" | "info"`, forcing the orchestrator to write `blockingThreshold: blockingThreshold ?? "error"` at context-construction time. Three pre-classification outcome helpers per file (`catchDispatchFailure`, `handleRetryExhaustedFailOpen`, `handleTruncatedLooksLikeFail`) read this defaulted field and forward it into `recordAdversarialAudit()` / `recordSemanticAudit()`, which is forwarded verbatim into the emitted `review-decision` event. Pre-refactor, these three call sites passed the **raw, possibly-`undefined`** option. Post-refactor (pre-fix), they always recorded `"error"`.

The four post-classification outcome builders in each file were unaffected — they always read `classification.threshold` (which already applies the same `?? "error"` default, matching pre-refactor behavior exactly), never `ctx.blockingThreshold`.

**Fix applied:** widened `blockingThreshold` on both `*OutcomeCtx` types to `"error" | "warning" | "info" | undefined`, and removed the `?? "error"` at both context-construction sites. Verified via `grep` that `ctx.blockingThreshold` is read only by the three pre-classification helpers in each file — the classification/outcome-builder path is untouched.

### 🟡 MEDIUM

#### SEC-3-follow: `featureDir()`'s new validation could throw out of a documented best-effort path
**Severity:** MEDIUM | **Category:** Reliability (SEC-3 follow-on risk)
**File:** `src/context/engine/stage-assembler.ts`

`discoverSessionScratchDirsOnDisk` — whose own docstring says "Best-effort: any I/O or parse failure... never propagated" — called `featureDir(projectDir, featureName)` *before* its `try/catch`, so SEC-3's new traversal/charset validation could throw an uncaught `NaxError` out of a function every caller treats as safe to call unconditionally. No CLI-level slugification exists for feature names (`grep` for `slugify`/`sanitizeFeature` in `src/cli/` returned nothing), so a free-text `--feature` value or a pre-existing legacy feature directory could trigger this.

**Fix applied:** moved the `featureDir()` call inside its own `try/catch`, logging at debug and returning `[]` (matching the existing "sessions directory does not exist yet" degradation one line below) instead of propagating.

**Deferred (documented, not fixed):** the reviewing agent additionally flagged that `--feature` accepts free text with no boundary validation, so a `nax plan --feature "my feature"` now fails deep in `featureDir()` (a NaxError from a path helper) instead of at CLI arg-parse time with an actionable message. Fixing this properly means adding validation at the CLI/PRD-load boundary (`src/prd/schema.ts` / `src/cli/plan*.ts`), which is out of scope for a security-hardening pass on an existing SSOT helper. Tracked as a follow-up; not a regression introduced by this branch (the CLI never validated feature names before either — SEC-3 just moved the failure point earlier and gave it a name).

#### TYPE-4-follow: `Severity` type alias was vacuous as originally written
**Severity:** MEDIUM | **Category:** Type Safety
**File:** `src/review/severity.ts`, `src/log-format/formatter.ts`

`SEVERITY_RANK` was annotated `: Record<string, number>`, so `keyof typeof SEVERITY_RANK` evaluated to `string`, collapsing `Severity = keyof typeof SEVERITY_RANK | (string & {})` to plain `string`. The 6 call-site edits from the original TYPE-4 fix compiled and ran correctly but added zero type information — no autocomplete, no self-documentation, exactly the outcome the finding was written to avoid.

**Fix applied:** changed `SEVERITY_RANK` to `as const satisfies Record<string, number>`, which makes `keyof typeof SEVERITY_RANK` the literal 6-key union and `Severity` genuinely informative. This required two follow-on changes to keep runtime lookups compiling: `isBlockingSeverity` now indexes via `(SEVERITY_RANK as Record<string, number>)[sev]` (its `sev` parameter stays `string` — LLM output is never trusted as one of the six literals), and one other production call site (`src/log-format/formatter.ts:456`, sorting `AdvisoryFindingSummaryEntry[]` by `.severity`, a field this branch's TYPE-4 pass had already retyped to `Severity`) needed the same cast to keep indexing a `Severity`-typed value against the now-literal `SEVERITY_RANK`.

### 🟢 LOW

#### BUG-1-follow: malformed-JSON diagnostic silently dropped
**Severity:** LOW | **Category:** Reliability
**File:** `src/plugins/builtin/nax-finish/index.ts`

The original BUG-1 fix correctly stopped `defaultReadResult` from throwing on malformed JSON, but the `catch {}` swallowed the parse error entirely — an operator debugging a "no result file" message would see the same message whether the flow never ran or the result file exists and is corrupt, with no way to tell which.

**Fix applied:** log the caught error via `getSafeLogger()?.warn(...)` before returning `null`, so the two cases stay distinguishable in logs even though both resolve to the same caller-facing outcome.

#### STYLE: `NAX_RUNTIME_PATTERNS` rebuilt on every `guardUncommittedFiles` call
**Severity:** LOW | **Category:** Performance
**File:** `src/review/runner.ts`

19 `RegExp` literals were constructed inside the function body on every review run; the array is static. Hoisted to module scope — zero behavior change (no `g` flag, so no cross-call `lastIndex` state to worry about).

#### PERF: prompt-audit content redacted twice per call
**Severity:** LOW | **Category:** Performance
**File:** `src/runtime/prompt-auditor.ts`

The original SEC-1 fix called `redactSecrets()` independently on the JSONL entry and again on the rendered txt content — since the txt content re-embeds the same `prompt`/`response` strings (which can run hundreds of KB), this scanned the same text through all ~14 secret patterns twice per audited call. Fixed to redact the entry once and derive both artifacts from the redacted copy; the `.txt` filename still derives from the *original* (unredacted) entry so filename generation stays provably unaffected by redaction.

---

## Findings — verified clean (no action taken)

- **`config/loader.ts` split (TYPE-3):** independently verified behavior-preserving across all 6 extracted layer functions — merge order, all three `warnSecuritySensitiveOverrides()` call sites' `sourceLayerConf` arguments (the specific way this refactor could have silently broken the SEC-2 warning), `hasMergedConfigs`, and the finalize/validate sequence all match `main` exactly. One cosmetic note: `loader.ts` grew from 477 to 544 lines (still under the 600 hard limit).
- **`runner.ts` split (TYPE-2):** `guardUncommittedFiles`/`runSemanticCheck`/`runAdversarialCheck`/`runMechanicalCheck` extraction and the new `buildReviewStory()` dedup helper are byte-identical to the pre-refactor inline logic.
- **`plugins/loader.ts` (SEC-2):** all three production call sites pass non-empty `allowedRoots`; the fail-closed branch cannot fire in production today, confirmed by reading both call chains that could theoretically produce an empty array.
- **`config/paths.ts` (SEC-3) regex/error-type:** charset correct, `NaxError` used per convention, no import cycle.
- **`prompt-auditor.ts` redaction correctness:** `redactSecrets()` on a string input returns a string before any other branch (verified by reading `redactValue` in `src/logger/redact.ts`), so the removed `as string` cast was already safe — now it's gone entirely.
- **Adversarial/semantic control flow, logging, and all `record*Audit()` argument sets** (apart from the blockingThreshold finding above): verified field-for-field identical across every branch, in the same order, with the same conditions.

---

## Priority Fix Order (all items in this table are already applied)

| Priority | ID | Effort | Description | Status |
|:---|:---|:---|:---|:---|
| P0 | BUG-2 | S | Stop eagerly defaulting `blockingThreshold` in adversarial/semantic outcome contexts | ✅ Fixed |
| P1 | SEC-3-follow | S | Guard `featureDir()` call in `discoverSessionScratchDirsOnDisk` | ✅ Fixed |
| P1 | TYPE-4-follow | S | Make `Severity` a real literal union via `as const satisfies` | ✅ Fixed |
| P2 | BUG-1-follow | S | Log the swallowed JSON parse error in nax-finish | ✅ Fixed |
| P3 | STYLE | S | Hoist `NAX_RUNTIME_PATTERNS` to module scope | ✅ Fixed |
| P3 | PERF | S | Redact prompt-audit content once instead of twice | ✅ Fixed |

**Deferred (tracked, not blocking):** CLI-boundary validation for `--feature` free text (would give an actionable error at arg-parse time instead of a `NaxError` from deep in `featureDir()`) — out of scope for this security-hardening pass; not a regression introduced by this branch.

**Effort key:** S = <1hr
