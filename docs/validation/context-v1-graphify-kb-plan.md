# Context Engine v1 — Phase 0 Validation: Graphify KB (Koda)

> **Feature:** `graphify-kb` in `/home/williamkhoo/Desktop/projects/nathapp/koda/`
> **Spec:** `koda/docs/specs/SPEC-graphify-kb.md`
> **PRD:** `koda/.nax/features/graphify-kb/prd.json`
> **Validation spec:** `ngent/docs/specs/SPEC-context-v1-phase0-validation.md`
> **Started:** 2026-04-14

---

## Why this feature was chosen

- 5 stories, all pending — natural split between discovery (US-001) and implementation (US-002–005)
- `contextFiles` is already wired in `prd.json` — injection needs only a one-line change per story
- Monorepo already handled via `.nax/mono/apps/{api,cli}/config.json` — not a confounder
- Dependency chain (001 → 002 → 003/004 → 005) creates a natural progressive context window
- Non-trivial scope spanning schema, service, controller, toggle logic, CLI — high surface area for constraint rediscovery

## Experiment design

### Why US-001 is the baseline, not a "no injection" comparison

All 5 stories are pending. There are no completed prior phases to draw `context.md` from. Instead:

- **US-001** runs with no injection — it is the discovery story. Its job is to reveal how Koda's NestJS patterns actually work.
- After US-001 completes, we hand-author `context.md` from its diff + review findings.
- **US-002, US-003, US-004** run with `context.md` injected — these are the injection group.
- **US-005** runs with injection as a bonus data point.

The comparison is US-001's metrics (baseline) vs US-002–004 average (injection group). This is a weaker comparison than a same-complexity matched pair, but sufficient to detect obvious signal.

### Modified injection mechanism

After US-001 completes, add `.nax/features/graphify-kb/context.md` as the **first entry** in `contextFiles` for US-002 through US-005 in `prd.json`:

```json
"contextFiles": [
  "../../.nax/features/graphify-kb/context.md",
  "apps/api/src/rag/rag.service.ts",
  ...
]
```

Path is relative to `workdir: "apps/api"` — adjust if needed. Verify the file is readable by the agent before running US-002.

### Environment

- **Keep CLAUDE.md / AGENTS.md / GEMINI.md / codex.md unchanged.** These are present in both baseline and injection runs — they don't bias the comparison. Cleaning them up is the canonical-rules spec, not this experiment.
- **No branch needed.** Run on the existing feature branch or main.
- **No code changes to nax or koda.** Only `prd.json` and `context.md` change.

---

## Pre-run checklist

Before running US-001:

- [ ] Confirm `koda/.nax/mono/apps/api/config.json` has correct `test`, `testScoped`, `typecheck`, `lint` commands
- [ ] Confirm `koda/.nax/mono/apps/cli/config.json` exists (for US-005)
- [ ] Confirm `koda/.nax/features/graphify-kb/prd.json` has `workdir: "apps/api"` on US-001 through US-004 and `workdir: "apps/cli"` on US-005
- [ ] Confirm nax can reach Claude (check quota)
- [ ] Note the git SHA at run start for reproducibility

---

## Metrics to record per story

For every story, record immediately after it completes:

| Metric | Source |
|:-------|:-------|
| Tier escalations | `story.escalations.length` in metrics |
| Review findings — semantic | `ctx.reviewFindings` count, kind=semantic |
| Review findings — adversarial | `ctx.reviewFindings` count, kind=adversarial |
| Rectification iterations | Rectifier loop count |
| Autofix iterations | Autofix loop count |
| Wall clock (minutes) | Story start → complete |
| Final tier used | fast / balanced / powerful |
| Human interventions | Manual operator actions (pauses, edits, aborts) |

Plus three qualitative answers written in the log below:

1. **Rediscovery incidents** — specific moments where the agent re-derived something that was (or should have been) in `context.md`. Name the file and what was re-derived.
2. **Context used** — for injection stories: specific moments where you can point to a line and say the agent made the right call because `context.md` told it to.
3. **Context ignored** — for injection stories: entries in `context.md` the agent seemed to not follow. Note which entry and what the agent did instead.

---

## What to capture in `context.md` after US-001

Author `.nax/features/graphify-kb/context.md` within an hour of US-001 completing, while the diff is fresh. Target ≤ 1500 tokens total.

Use this structure — only fill sections where you have genuine evidence from the diff or review findings:

```markdown
# Feature Context — graphify-kb

_Hand-authored after US-001. Date: <date>. Source: diff + review findings._

## Decisions

<!-- Chosen approaches with rationale. Only non-obvious ones — not things in the spec. -->

## Constraints

<!-- External rules the code must satisfy that a fresh agent would not know.
     Examples: "Prisma migrations must be run via bun run db:migrate not prisma migrate",
     "RagModule must export RagService for cross-module DI to work",
     "i18n keys must exist in BOTH en/ and zh/ or the app throws at startup" -->

## Patterns Established

<!-- Structural conventions set in US-001 that US-002+ must follow.
     Examples: "ProjectResponseDto.from() maps nullable fields as null not undefined",
     "source union is a TypeScript string literal union, not an enum" -->

## Gotchas

<!-- Traps the agent hit or nearly hit that future stories should avoid.
     Examples: "graphifyEnabled field placement in schema.prisma — must match
     the autoIndexOnClose ordering or the migration diffs confusingly" -->
```

**Content rules:**
- Cite evidence for every entry (file:line, commit, review finding ID).
- Exclude anything already stated explicitly in the spec — agents read the spec too.
- Exclude project-wide rules already in `CLAUDE.md` — agents read those too.
- When in doubt, include. Over-capture here; trim at US-002 if it's clearly noise.

---

## Known spec constraints to watch for (pre-populated)

These are the places the spec is most likely to produce cross-story rediscovery. Record in `context.md` after US-001 confirms them:

| Constraint | Likely story | Source |
|:-----------|:-------------|:-------|
| `source` is a string literal union (`'ticket' \| 'doc' \| 'manual' \| 'code'`), not an enum | US-002, US-003 | Spec: add-document.dto.ts pattern |
| `RagModule` must export `RagService` for `ProjectsModule` DI to see it | US-004 | Spec: projects.module.ts change |
| Toggle-off purge: `deleteAllBySourceType` is called in same request, failure is warn-not-throw | US-004 | Spec: failure handling |
| Node content format: `"{type} {label} in {source_file}"` + neighbor lines | US-002, US-003 | Spec: node→text conversion |
| CLI: uses `resolveAuth({})`, `unwrap(response)`, `handleApiError(err)` — not custom equivalents | US-005 | Spec: CLI context files |
| i18n keys must exist in both `en/` and `zh/` — app throws at startup if either is missing | US-003, US-004 | Spec: i18n constraint |
| `graphifyLastImportedAt` is updated in the controller, not the service | US-003 | Spec: US-003 AC |

These are starting hypotheses. US-001 may reveal different or additional constraints — what it actually discovers takes priority.

---

## Decision gate

After US-002, US-003, US-004 complete:

### Outcome A — Proceed to build v1

At least **two** of:
- ≥ 1 tier escalation prevented (injection story escalates less than US-001)
- ≥ 2 review findings fewer on average vs US-001
- ≥ 2 qualitative rediscovery incidents that `context.md` demonstrably prevented
- "Context used" answer is non-empty for at least 2 of the 3 injection stories

**Action:** Begin `SPEC-feature-context-engine.md` Phase 1 (read-path implementation).

### Outcome B — Stop, do not build v1

None of the above met, or injection-group metrics within noise of US-001.

**Action:** Shelf v1 and context-dependent v2 sections. Document why here. Redirect to the two independent specs (`SPEC-context-engine-agent-fallback.md`, `SPEC-context-engine-canonical-rules.md`).

### Outcome C — Ambiguous

One metric improves, others don't; qualitative review is mixed.

**Action:** Run US-005 as a 4th injection data point. Re-decide. If still ambiguous, treat as Outcome B.

---

## Validation log

### Environment

- nax version: 0.62.0-canary.6
- Git SHA (koda): 05e3178aa98ed1c26fb16889a8d14343293c7180,  4f2eda67a9fc26af62fbe7ca52b37bc56f7c525c acceptance generated
- Git SHA (ngent): 8c4557b4d5ac889746a5709068dfe9042969655d
- Date started: 2026-04-14
- Operator: williamkhoo

---

### US-001 — Schema, DTO & i18n Extensions (BASELINE)

**Role:** Discovery. No injection. Establishes codebase pattern knowledge.

Started: 2026-04-14T10:55:13.744Z
Completed: 2026-04-14T11:04:54.970Z

| Metric                     | Value                  |
|:---------------------------|:-----------------------|
| Tier escalations           | 0                      |
| Review findings — semantic | 0                      |
| Review findings — adversar | 0                      |
| Rectification iterations   | 0                      |
| Autofix iterations         | 0                      |
| Wall clock                 | 5.6 min                |
| Final tier                 | fast                   |
| Human interventions        | (enter manually)       |

Notes:
  - Total agent attempts (escalation proxy): 1
  - Rectification/autofix counts are log-derived — 0 means stage never triggered
  - Human interventions require manual entry (PAUSE/edit/abort events)

**Rediscovery incidents (things the agent had to figure out from scratch that future stories will also need):**

_(write here immediately after the run — this becomes the source material for context.md)_

---

### `context.md` authored

**Date authored:** _______________

**Entries:**

| Section | Count |
|:--------|:------|
| Decisions | |
| Constraints | |
| Patterns | |
| Gotchas | |

**Total tokens (estimate):** _______________

**Notable entries (2-3 most important):**

1.
2.
3.

**Injection confirmed:** `context.md` added to `contextFiles` for US-002, US-003, US-004, US-005 in `prd.json`. [ ]

---

### US-002 — RagService Methods (INJECTION #1)

**Run date:** _______________

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | |
| Review findings — semantic | |
| Review findings — adversarial | |
| Rectification iterations | |
| Autofix iterations | |
| Wall clock | |
| Final tier | |
| Human interventions | |

**Rediscovery incidents (things the agent re-derived that were in context.md):**

**Context used (moments the agent made the right call because of context.md):**

**Context ignored (entries in context.md the agent did not follow):**

**`context.md` updated after this story:** [ ] (add new learnings before US-003)

---

### US-003 — Import Endpoint (INJECTION #2)

**Run date:** _______________

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | |
| Review findings — semantic | |
| Review findings — adversarial | |
| Rectification iterations | |
| Autofix iterations | |
| Wall clock | |
| Final tier | |
| Human interventions | |

**Rediscovery incidents:**

**Context used:**

**Context ignored:**

**`context.md` updated after this story:** [ ]

---

### US-004 — Toggle Enforcement & Cleanup (INJECTION #3)

**Run date:** _______________

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | |
| Review findings — semantic | |
| Review findings — adversarial | |
| Rectification iterations | |
| Autofix iterations | |
| Wall clock | |
| Final tier | |
| Human interventions | |

**Rediscovery incidents:**

**Context used:**

**Context ignored:**

---

### US-005 — CLI Command (INJECTION #4, bonus)

**Run date:** _______________

> Note: US-005 uses `workdir: "apps/cli"` — different workspace from US-001–004. Verify `context.md` path resolves correctly from the CLI workspace root.

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | |
| Review findings — semantic | |
| Review findings — adversarial | |
| Rectification iterations | |
| Autofix iterations | |
| Wall clock | |
| Final tier | |
| Human interventions | |

**Rediscovery incidents:**

**Context used:**

**Context ignored:**

---

## Summary comparison

_(Fill after US-004 or US-005)_

| Metric | US-001 (baseline) | US-002 | US-003 | US-004 | Injection avg |
|:-------|:-----------------:|:------:|:------:|:------:|:-------------:|
| Tier escalations | | | | | |
| Semantic findings | | | | | |
| Adversarial findings | | | | | |
| Rectification iters | | | | | |
| Autofix iters | | | | | |
| Wall clock (min) | | | | | |

**Rediscovery incidents prevented by context.md (total):** ___

**Rediscovery incidents that slipped through despite context.md:** ___

**Context.md entries that were clearly used:** ___  
**Context.md entries that were clearly ignored:** ___

---

## Decision

**Outcome:** A / B / C

**Rationale:**

_(one paragraph — what the data and qualitative review show)_

**Next action:**

- [ ] Outcome A → open implementation issue for `SPEC-feature-context-engine.md` Phase 1
- [ ] Outcome B → write ADR shelving v1; redirect to fallback + canonical-rules specs
- [ ] Outcome C → run US-005 and re-decide

**Decision date:** _______________
