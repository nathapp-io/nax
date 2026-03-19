# Post-Mortem: koda fix/refactor-standard

**Date:** 2026-03-19
**Feature:** Refactor apps/api to follow nathapp-nestjs-patterns
**Repo:** koda (monorepo: apps/api, apps/cli, apps/web)
**Runs:** 3 sessions on 2026-03-18
**nax version:** v0.49.0
**Logs:** `/home/ubuntu/nax-logs/koda-refactor-standard/`

## Run Summary

| Run | Log file | Stories attempted | Outcome |
|:----|:---------|:-----------------|:--------|
| 1 | `2026-03-18T13-41-36.jsonl` | US-001, US-002-1 | US-001 ✅, US-002-1 ❌ (review loop) |
| 2 | `2026-03-18T14-35-14.jsonl` | US-002-2 | US-002-2 ❌ (review loop) |
| 3 | `2026-03-18T15-17-32.jsonl` | US-002-3 | US-002-2 reconciled ✅, US-002-3 ❌ (SIGINT) |

**Final state:** US-001 ✅, US-002-1 ✅, US-002-2 ✅ (reconciled), US-002-3 pending, rest pending.

## Findings

### F-1: `acceptance.test.ts` generated as LLM prose, not code

The acceptance test file contains a natural language summary instead of executable TypeScript:

```
File written to `nax/features/refactor-standard/acceptance.test.ts`. Here's a summary of the 43 tests...
```

**Root cause:** The acceptance test generator dumped the LLM's conversational response to disk without stripping the preamble or enforcing code-only output.

**Impact:** No automated feature-level acceptance gate.

→ **ENH-003**

### F-2: Review → Autofix infinite loop on typecheck failures

Both US-002-1 and US-002-2 hit the same pattern — 5 wasted review cycles:

```
review failed (typecheck) → lintFix FAILED (exit 1) → formatFix FAILED (exit 1)
→ "Mechanical autofix succeeded" → retry review → REPEAT ×5 → story failed
```

**Root cause:** Autofix reports "succeeded" even when both lintFix and formatFix exit with code 1.

**Status:** Fix at commit `18eea738` — **unverified**.

→ **ENH-004** (verify fix)

### F-3: No context chaining between dependent stories

All sessions logged: `scopeToStory=true but no contextFiles provided — falling back to full scan`

US-001 produced `MIGRATION_PLAN.md` (797 lines). US-002 depends on US-001 but never received this file as context. The dependency only controls execution order.

**Impact:** Planning story output is orphaned. Dependent stories start from scratch.

→ **ENH-005**

### F-4: `nax plan` generated a planning story (US-001) that produces inert artifacts

US-001 created `MIGRATION_PLAN.md` + `migration-analysis.spec.ts` (tests that check the doc exists). These were never consumed by US-002.

**Root cause:** The plan prompt doesn't distinguish between "planning work" (which should inform the PRD/decomposition) and "implementation work" (which produces code). A planning story in the PRD means the agent writes docs during run time, not at plan time.

**Improvement:** `nax plan` should handle analysis/planning itself and embed the findings into the PRD context, rather than creating a story that produces planning artifacts at run time.

→ **ENH-006**

### F-5: Reconciliation auto-passes stories with known review failures

US-002-2 failed at review stage (typecheck) but was reconciled as "passed" in run 3 because it had commits in git.

**Problem:** Commits ≠ quality. The story has known typecheck failures.

**Proposed fix:** A + B approach:
1. **Store failure metadata** in prd.json: `failureStage`, `failureReason`
2. **Re-run review** on reconciliation — before marking a failed story as passed, re-run typecheck/lint on current working tree. If review still fails, don't reconcile.

→ **ENH-007** (verify fix at `2d367925` for re-decomposition; reconciliation improvement is separate)

### F-6: Full repo scan causes out-of-scope changes

With no `contextFiles` and full scan, the agent modified files outside the story scope:
- `apps/cli/src/config.ts` — changed API key validation (unrelated to auth refactor)
- 9 files in `apps/web/` — Vue template formatting, ESLint config, nuxt.config

**Previous decision:** Let the coding agent grep context themselves — they have the capability.

**Assessment:** This works for focused agents, but the issue here is the *rectification* and *autofix* stages. When typecheck fails monorepo-wide, the agent tries to fix everything, not just `apps/api`. The agent capability approach is valid for the coding session, but review/autofix scoping needs workdir enforcement.

**Proposed approach:** Keep agent-driven context for coding sessions. But enforce `story.workdir` scoping for:
- Review stage: run typecheck/lint scoped to `apps/api` only
- Autofix stage: only touch files within `story.workdir`
- Rectification: include workdir constraint in prompt

→ **ENH-008**

### F-7: Re-decomposition on re-run produces 0 substories

Run 2 re-decomposed US-002 and US-004 into 0 substories (they already had substories from run 1).

**Status:** Fix at commit `2d367925` (checks `status === 'decomposed'`) — **unverified**.

### F-8: Agent generates non-code artifacts in src/

US-002-1's test-writer created `apps/api/src/config/TEST_SUMMARY.md` (137 lines) — a markdown doc explaining what the tests do.

**Impact:** Low — clutters the source tree but doesn't break anything.

**Potential fix:** Post-commit hook or prompt guidance: "Do not create markdown files in source directories."

## Enhancement Tracker

| ENH | Title | Priority | Status |
|:----|:------|:---------|:-------|
| ENH-003 | Acceptance test generator: enforce code-only output | High | Open |
| ENH-004 | Autofix: check exit codes before reporting success | High | Verify `18eea738` |
| ENH-005 | Context chaining: feed parent story outputs to dependents | High | Open — design needed |
| ENH-006 | Plan prompt: fold analysis into PRD, don't generate planning stories | Medium | Open — design needed |
| ENH-007 | Reconciliation: re-run review before auto-passing | Medium | Open |
| ENH-008 | Review/autofix: scope to story.workdir in monorepo | Medium | Open — design needed |

## Lessons Learned

1. **Thin specs test `nax plan` capability** — this was intentional. The PRD generation was reasonable; the issues are downstream.
2. **Typecheck ≠ lint** — autofix (lint/format) can't fix typecheck errors. Need separate escalation path.
3. **Monorepo review scoping is critical** — monorepo-wide typecheck catches errors in `apps/web` that have nothing to do with the auth refactor story.
4. **Planning stories are a plan-time concern, not run-time** — the plan command should do the analysis itself.
