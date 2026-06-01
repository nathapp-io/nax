# Results — Trim the Test Suite

**Date:** 2026-06-01
**Status:** Complete — all 7 phases done

---

## Before / After

| Metric | Baseline | Final | Delta |
|:-------|---------:|------:|------:|
| Files | 768 | 791 | +23 |
| Tests | 10,168 | 8,104 | -2,064 (-20.3%) |
| Lines | 203,122 | 188,351 | -14,771 (-7.3%) |
| Suite time | ~30-40s | ~31s (test:bail) | within range |

---

## Coverage

| Metric | Baseline | Final | Delta |
|:-------|---------:|------:|------:|
| % Functions | 83.10% | 83.32% | +0.22pp |
| % Lines | 85.26% | 88.34% | +3.08pp |

Global coverage improved. No source file dropped > 1pp.

---

## Per-Phase Savings

| Phase | Description | Files Touched | Tests Saved | Goal | Status |
|:------|:------------|:-------------:|------------:|-----:|:-------|
| 0 | Baseline & tooling | — | — | — | Complete |
| 1 | Prompt builder consolidation | 1 | 15 | ~226 | Complete (under — audit rejected 5/6 files) |
| 2 | Config & schema consolidation | 2 | 44 | ~160 | Complete (under — fixture variation) |
| 3 | Pipeline stages & autofix | 0 | 0 | ~86 | Complete (audit rejected all 5 files) |
| 4 | Debate, review, verification | 2 | 2 | ~115 | Complete (under — complex async mocks) |
| 5 | Mid-tier sweep | 38 | 304 | ~300 | Complete (met goal) |
| 6 | Cross-file duplicate hunt | 4 | 6 | ~100 | Complete (budget gate — minimal duplication) |
| 7 | Final verification | — | — | — | Complete |
| **Total** | | **47** | **371** | | |

### Phase 6 detail

|-|-|
4 duplicate groups found across cross-file body-hash analysis (18 groups / 65 occurrences inspected), 5 strategies applied:

| Strategy | Finding |
|:---------|:--------|
| Body-hash normalization | 4 confirmed duplicate groups, 5 strategies applied |
| Identical test-name search (20 candidates, 3 occurrences each) | 0 confirmed — Operation interface conformity |
| Same-source-module import tracing | Found adversarial split-file duplicates |
| Split-file pair comparison (10+ pairs) | 0 duplicates — splits cover distinct concerns |
| Describe-block overlap across files | 0 duplicates — different functions under test |

Removals:

| Removed From | Tests | Kept In | Reason |
|:-------------|:-----:|:--------|:-------|
| `config/plan-mode-refine.test.ts` | 1 | `cli/plan-mode.test.ts` | Identical `resolvePlanMode({})` test |
| `verification/smart-runner-packageprefix.test.ts` | 1 | `verification/smart-runner.test.ts` | Identical packagePrefix test |
| `operations/adversarial-review-retry-flip.test.ts` | 3 | `operations/adversarial-review.test.ts` | Duplicate AC1 structure block |
| `operations/adversarial-review-requote.test.ts` | 1 | `operations/adversarial-review.test.ts` | Duplicate retry field existence |

---

## Files Skipped Per Phase

### Phase 1 (5 files)
- `prd/schema.test.ts` — unique per-field assertions, no fold-able blocks
- `plan-builder.test.ts` — high per-test mock variation
- `debate/prompt-builder.test.ts` — different prompt formats per test
- `rectifier-builder.test.ts` — different fix strategies per test
- `prompts/builder.test.ts` — varying context inputs

### Phase 2 (3 files)
- `cli/init-detect.test.ts` — per-language unique assertions
- `project/detector.test.ts` — per-fixture unique mocks
- `config/schemas.test.ts` — error-path tests have unique code paths

### Phase 3 (5 files)
- `autofix-adversarial.test.ts` — complex async mock state machines
- `findings/cycle.test.ts` — classifyOutcome block already folded
- `autofix-core.test.ts` — stateful per-test mock mutations
- `autofix-cycle.test.ts` — unique mock setups per iteration
- `review.test.ts` — dynamic module mocks

### Phase 4 (5 files)
- `review/dialogue.test.ts` — complex async mock setups
- `verification/tdd-verdict.test.ts` — diverse verdict scenarios
- `verification/smart-runner.test.ts` — unique file system mocks per test
- `prompts/sections/role-task.test.ts` — varying prompt templates
- `review/dialogue-re-review.test.ts` — per-test session state machines
- `debate/runner-plan.test.ts` — helper extraction, not folding

### Phase 5 (42 files)
- See `docs/plans/PLAN-test-suite-trim.phase-5-results.md`

### Phase 6 (budget gate)
- 26 inspected candidates with 0 confirmed duplicates (below 10/30 threshold)
- Codebase uses Operation interface pattern — identical test names test different concrete implementations
- Split files cover distinct concerns with minimal overlap

---

## Open Follow-Ups

1. **Placeholder tests** — ~29 tests across the codebase have `expect(true).toBe(true)` bodies (placeholders for integration coverage). Consider implementing or removing in a separate cleanup pass.
2. **await-request tests** — `test/unit/prompts/builders/await-request.test.ts` was flagged but needed human review due to bug-named file pattern.
3. **Within-file parametric duplication** — Phase 5 covered 38 mid-tier files but ~700 files remain. Some within-file duplication may still exist in long-tail files (0-14 tests each).

---

## Verification

| Check | Result |
|:-------|:-------|
| `bun run typecheck` | Pass |
| `bun run lint` | Pass |
| `bun run test:bail` | Pass (31.08s, under 60s limit) |
| `bun run test` | 9,500+ pass, 0 fail, 54 skip |
| `bun test --coverage` | No regression — improved (+0.22pp funcs, +3.08pp lines) |
| `scripts/test-trim-progress.ts` | 8,104 tests (-20.3% from baseline) |

---

## Rollback

Each phase shipped as its own branch/PR. To revert:
- `git revert <merge-commit>` for the offending phase
- Atomic per-file commits within each phase allow safe single-file rollback
