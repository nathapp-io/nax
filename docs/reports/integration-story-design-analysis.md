# Integration Story Design — Analysis & Open Questions

**Status:** Draft / pending more data
**Date:** 2026-05-11
**Context:** Follow-up to [enhanced-debate-phase-2-gap-analysis.md](./enhanced-debate-phase-2-gap-analysis.md)

This document captures analysis only — no design decision yet. We need more
data (additional gap analyses across features) before committing to a
direction.

---

## Background

The Phase 2 gap analysis identified five real implementation gaps. Two of
them (#1 `specContent`-not-reaching-grounder, #5 `runner.ts`-unguarded-one-shot)
share the same root cause: **no single story owned the cross-story / shared-
infrastructure data flow**. Files extracted mid-feature (e.g.
`runner-plan-helpers.ts` created during US-003) were invisible to later
stories (US-005) whose context lists were authored before that extraction.

This document explores a proposed remedy — a **terminal integration story**
authored as the last US of every multi-US feature, owning end-to-end wiring
verification.

---

## What's Already Shipped (Independent of This Design)

Two lint ratchets were added during this analysis. They reduce the surface
area of gaps #3 (plain `Error`) and #4 (logger missing `storyId`):

| Script | Baseline | Wired into |
|:---|:---|:---|
| [scripts/check-nax-error.ts](../../scripts/check-nax-error.ts) | 163 | `lint`, `lint:json` |
| [scripts/check-logger-storyid.ts](../../scripts/check-logger-storyid.ts) | 25 | `lint`, `lint:json` |

Both follow the `check-deep-relatives.ts` ratchet pattern. Baselines stored
under [scripts/baselines/](../../scripts/baselines/). New violations are
blocked; existing violations migrate incrementally via `:update` commands.

These are decided and shipped. The rest of this document is analysis only.

---

## How Implementer Prompts Actually Work

Audited a real run via prompt-audit transcript
(`nax-global/nax/prompt-audit/enhanced-debate-phase-2/...-us-001-implementer-run-t01.txt`).

### What the implementer sees

| Section | Source | Notes |
|:---|:---|:---|
| Constitution | `.nax/constitution.md` | Project rules verbatim |
| Role definition | [src/prompts/sections/role-task.ts](../../src/prompts/sections/role-task.ts) | Varies by session role |
| Story | [src/prompts/sections/story.ts:61-81](../../src/prompts/sections/story.ts#L61-L81) | Title + description + numbered ACs (verbatim) |
| Isolation rules | [src/prompts/sections/isolation.ts](../../src/prompts/sections/isolation.ts) | Varies by session role |
| Existing test coverage | Test-scanner output | Counts + describe blocks per file |
| Relevant source files | contextFiles (path hints, up to 5) | `_Path: \`<file>\` — read this file before implementing._` |
| Self-verification gate | [src/prompts/sections/self-verification.ts](../../src/prompts/sections/self-verification.ts) | `bun run lint:json` + typecheck |
| Story reminder | story.ts:36-59 | Title + ACs again as recency anchor |

### Key observations

1. **contextFiles paths ARE rendered in the prompt** — not just inlined content.
2. **`MAX_FILES = 5` cap** ([src/context/builder.ts:210](../../src/context/builder.ts#L210)) limits how many file *contents* get injected, but the agent has free `Read` tool access — listing more files in `contextFiles` still surfaces them as path hints.
3. **Auto-detect** ([src/context/builder.ts:228-229](../../src/context/builder.ts#L228-L229)) only fires when `contextFiles` is empty AND `fileInjection === "keyword"`. With contextFiles set, no rediscovery.
4. **Test-coverage summary is dynamic** — scanned at execution time, not plan time. So newly added test files DO surface, but only if prior stories wrote tests for the extracted module.
5. **Story description propagates to every session** — test-writer, implementer, verifier all see the same description string.
6. **Self-verification fires `lint:json`** — the two new ratchet scripts will execute here.

---

## Three Test Strategies × Session Roles

| Strategy | Sessions | Notes |
|:---|:---|:---|
| **tdd-simple** | 1 × `tdd-simple` role | src/+test/ both writable, exploratory ("Write failing tests FIRST, then implement") |
| **three-session-tdd** (strict) | 3 | (1) `test-writer` strict — test/ only, NO src/ writes. (2) `implementer` standard — src/ only, "Do NOT modify test files". (3) `verifier` — read-only |
| **three-session-tdd-lite** | 3 | (1) `test-writer` lite — test/ + minimal src/ stubs. (2) `implementer` lite — src/ + MAY add tests. (3) `verifier` — read-only |

### Implications for an integration story

| Strategy | Where the leverage point is | Risk for cross-cutting wiring |
|:---|:---|:---|
| **tdd-simple** | Single exploratory session can discover + assert + fix in one pass | Low — easiest case |
| **strict 3-session** | test-writer MUST discover the gap; if it doesn't, the implementer is rigidly scoped and cannot add coverage | **High — strict isolation is hostile to cross-cutting work** |
| **lite 3-session** | test-writer or implementer can both add tests; gaps can be patched mid-flight | Medium |

**Conclusion:** if integration stories exist as a story type, they almost
certainly should NOT use strict 3-session-tdd. The test-writer's discovery
becomes a single point of failure, and the strict implementer cannot recover.

---

## Constraints Found in the Codebase

1. **`contextFiles` accepts plain relative paths only** ([src/prd/schema.ts:200-230](../../src/prd/schema.ts#L200-L230)). No glob support today.
2. **Plan generation is one-shot at the start of the feature** ([src/cli/plan.ts](../../src/cli/plan.ts)). No re-scan / re-plan between stories.
3. **`GROUPING_RULES`** ([src/config/test-strategy.ts:225-236](../../src/config/test-strategy.ts#L225-L236)) currently bans stories whose primary purpose is "running validation/regression suites" with explicit "No exceptions." An integration story has to draw a sharp line versus that ban — it must produce wiring *code changes*, not just assertions.
4. **Story role prompts are static templates** ([src/prompts/sections/role-task.ts](../../src/prompts/sections/role-task.ts)) — keyed by role name only, no story-tag awareness. Adding conditional behavior per-story-type requires either a new role variant or a content trigger.
5. **AC consolidation has no formal flow** — done ad-hoc by asking an agent. Story-size gate caps AC count, forcing consolidation. No "preserve failure-mode ACs" rule today.

---

## Candidate Designs (Not Decided)

### Path A — Prompt-only, lightest
- Add `GROUPING_RULES` rule: terminal integration story authored as last US when feature has ≥3 stories on one subsystem.
- Description must include glob-scan hint: "Before reading contextFiles, list `src/<subsystem>/**/*.ts` and read files added by prior stories."
- Force `routing.testStrategy = "tdd-simple"` for the integration story.
- **No schema changes. No execution changes.**
- **Risk:** relies on planner agent compliance to emit the hint; relies on implementer agent compliance to follow it.

### Path B — Add role-prompt defense-in-depth
- All of Path A, PLUS
- One-line addition to `tdd-simple` and `test-writer (lite)` roles: "If the story description identifies this as an integration/wiring story, list the named subsystem dir before reading contextFiles."
- Defense-in-depth — even vague planner output still triggers the right behavior.
- **Risk:** trigger detection (string match vs marker vs tag) is fragile.

### Path C — Add a `rediscoverContext: true` story flag
- New optional boolean in the PRD schema. When set, skip the "contextFiles non-empty" guard and run auto-detect against the post-implementation tree at execution time.
- Directly addresses the root cause (planning happens before extracts).
- **Cost:** schema + [src/context/builder.ts:228](../../src/context/builder.ts#L228) change.
- Combine with Path A/B for full coverage.

### Path D — Glob support in `contextFiles`
- Allow `"src/debate/**/*.ts"` entries in PRD's `contextFiles`.
- Resolved at execution time against the current tree.
- **Cost:** schema + path-security validation + execution change.
- Largest blast radius.

---

## Open Questions (For Later Discussion)

1. **Threshold for emitting an integration story.** Always (every multi-US feature) or conditional (≥3 stories on one subsystem)?
2. **Forced test strategy.** `tdd-simple` only, or also allow `three-session-tdd-lite` for complex integration?
3. **Should `three-session-tdd` strict be forbidden for integration stories?** (analysis says yes; need data to confirm)
4. **Trigger mechanism for role-prompt branching.** English phrase ("integration story"), HTML marker (`<!-- nax:integration -->`), or PRD `tags` field check?
5. **Should "integration" be a real PRD tag with downstream meaning** (e.g. routes to higher tier, grants `fileReadAccess` by default), or just a label?
6. **AC consolidation interaction.** The terminal story's ACs are end-to-end and likely fewer than the size gate allows. Does it need its own consolidation rule, or is preservation easy here?
7. **Cost of always-on integration stories.** Every multi-US feature gets one more session. Acceptable? Or only above a story-count threshold?

---

## Data We Want Before Deciding

- 3–5 more feature post-mortems with gap analyses (to confirm the pattern is recurring, not Phase 2-specific).
- Distribution of test strategies actually used across recent features (is strict 3-session common? if so, the "forbid for integration" rule is more impactful).
- Frequency of mid-feature file extractions (the trigger condition for the gap to occur). If extractions are rare, Path A is sufficient. If common, Path C/D pay for themselves.
- Planner agent compliance rate on prompt-only directives (anecdotally weak; needs measurement).

---

## Related Documents

- [enhanced-debate-phase-2-gap-analysis.md](./enhanced-debate-phase-2-gap-analysis.md) — the gap analysis that motivated this
- [src/config/test-strategy.ts:225-236](../../src/config/test-strategy.ts#L225-L236) — `GROUPING_RULES` (planner rules)
- [src/prompts/sections/role-task.ts](../../src/prompts/sections/role-task.ts) — role prompt templates
- [src/prompts/sections/isolation.ts](../../src/prompts/sections/isolation.ts) — isolation rules per role
- [src/context/builder.ts](../../src/context/builder.ts) — contextFiles resolution + auto-detect
- [src/prd/schema.ts](../../src/prd/schema.ts) — PRD validation (where contextFiles + tags live)
