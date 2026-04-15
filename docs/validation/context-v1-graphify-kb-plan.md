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

- nax version: 0.62.0-canary.7
- Git SHA (koda): 05e3178aa98ed1c26fb16889a8d14343293c7180,  dd319ea28be7cd9336f8231b4eebf54a9c738490 acceptance generated
- Git SHA (ngent): 8c4557b4d5ac889746a5709068dfe9042969655d
- Date started: 2026-04-14
- Operator: williamkhoo

---

### US-001 — Schema, DTO & i18n Extensions (BASELINE)

**Role:** Discovery. No injection. Establishes codebase pattern knowledge.
8aca3d194b06eb7292faa61a75dbeb1de0946ea7
Started: 2026-04-15T08:13:23.174Z
Completed: 2026-04-15T08:32:44.766Z

| Metric                     | Value                  |
|:---------------------------|:-----------------------|
| Tier escalations           | 0                      |
| Review findings — semantic | 0                      |
| Review findings — adversar | 0                      |
| Rectification iterations   | 0                      |
| Autofix iterations         | 5                      |
| Wall clock                 | 5.4 min                |
| Final tier                 | fast                   |
| Human interventions        | (enter manually)       |

Notes:
  - Total agent attempts (escalation proxy): 1
  - Rectification/autofix counts are log-derived — 0 means stage never triggered
  - Human interventions require manual entry (PAUSE/edit/abort events)

**Rediscovery incidents (things the agent had to figure out from scratch that future stories will also need):**

1. **`KbResultDto @ApiProperty enum` vs TypeScript type are independent** — Agent updated `source!: string` to the union type in `kb-result.dto.ts`, but left `@ApiProperty({ enum: ['ticket', 'doc', 'manual'] })` unchanged. Adversarial reviewer caught this as a blocking error (round 1). The decorator and the type must both be updated together. Future stories that add DTO fields face the same risk.

2. **`ProjectsService.update()` Prisma data object requires explicit listing of every new field** — Agent added `graphifyEnabled` to `UpdateProjectDto` and to the test, but did not add it to the `db.project.update({ data: { ... } })` object. The field was silently discarded. Adversarial caught this as an abandonment error (round 2). Any story that adds a DTO field must also add it to the `update()` data object.

3. **i18n keys must be added to both `en/` and `zh/`** — Agent added both correctly without prompting. Confirmed as a constraint (not a rediscovery, but worth noting it was handled properly from the spec alone).

4. **Migration is SQLite-style** — Agent used `PRAGMA defer_foreign_keys` + CREATE+INSERT+DROP+RENAME pattern correctly. Future stories doing schema changes must follow the same migration style, not Postgres-style `ALTER TABLE ADD COLUMN`.

---

### `context.md` authored

**Date authored:** 2026-04-15 (after US-002, incorporating both US-001 and US-002 findings)

**Note:** context.md was authored after US-002 completed, not after US-001 as planned. US-002 ran without injection (context.md not ready). US-003 and US-004 are the actual injection group. See US-002 section below.

**Entries:**

| Section | Count |
|:--------|:------|
| Decisions | 3 |
| Constraints | 6 |
| Patterns | 4 |
| Gotchas | 4 |

**Total tokens (estimate):** ~1,400

**Notable entries (2-3 most important):**

1. **`source` union in all 4 locations** — The agent missed the `@ApiProperty enum` decorator in round 1 of US-001. This is the most likely cross-story trap: type annotation and decorator are independent.
2. **`ProjectsService.update()` Prisma data must list new fields explicitly** — Adversarial re-discovers this pattern whenever a DTO gets a new field that update() doesn't forward. Critical for US-004 which touches ProjectsService.
3. **SQL injection in `deleteAllBySourceType` sourceType interpolation** — Discovered in US-002 adversarial review. Added to context.md before US-003/004 run.

**Injection confirmed:** `context.md` added to `contextFiles` for US-003, US-004, US-005 in `prd.json`. [x]

_(US-002 ran before context.md was ready — no injection for that story. Treating US-002 as baseline #2.)_

---

### US-002 — RagService Methods (INJECTION #1)

Started: 2026-04-15T09:19:12.930Z
Completed: 2026-04-15T09:38:02.910Z

| Metric                     | Value                  |
|:---------------------------|:-----------------------|
| Tier escalations           | 0                      |
| Review findings — semantic | 0                      |
| Review findings — adversar | 0                      |
| Rectification iterations   | 0                      |
| Autofix iterations         | 3                      |
| Wall clock                 | 4.2 min                |
| Final tier                 | fast                   |
| Human interventions        | (enter manually)       |

Notes:
  - Total agent attempts (escalation proxy): 1
  - Rectification/autofix counts are log-derived — 0 means stage never triggered
  - Human interventions require manual entry (PAUSE/edit/abort events)

**Rediscovery incidents (things the agent re-derived that were in context.md):**

**Context used (moments the agent made the right call because of context.md):**

**Context ignored (entries in context.md the agent did not follow):**

**`context.md` updated after this story:** [ ] (add new learnings before US-003)

---

### US-003 — Import Endpoint (INJECTION #1 — first real injection story)

**Run date:** 2026-04-15 (Started 10:52:49Z, Completed 11:56:54Z)

**Note:** context.md WAS injected here (verified in prompt audit `1776247833326-nax-...-us-003-test-writer-run-t01.txt` lines 291–373). This is the first story where injection was actually active — US-002 ran without injection (context.md wasn't ready in time).

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | 2 (fast → balanced → powerful) |
| Review findings — semantic (final round) | 0 |
| Review findings — adversarial (final round) | 5 advisory, 0 blocking |
| Review findings — adversarial (aggregate across 4 rounds) | 17 advisory, 3 blocking |
| Rectification iterations | 0 |
| Autofix iterations | 3 blocked rounds on Haiku + 1 passed round on Opus |
| Wall clock | 64.1 min |
| Final tier | powerful (opus) |
| Cost | $5.02 |
| Human interventions | 0 |

**Rediscovery incidents (what context.md did NOT prevent):**

1. **No Prisma transaction around `importGraphify()` + `project.update()`** — error-severity adversarial finding. Controller writes to vector store and relational DB in the same request but doesn't wrap them transactionally. Partial failure = stale `graphifyLastImportedAt`. Context.md had no pattern for multi-write transaction wrapping.

2. **Missing `-2` default validation key in `i18n/en/rag.json` and `i18n/zh/rag.json`** — error-severity convention finding. All other module i18n files (`labels.json`, `projects.json`, `tickets.json`) include `-2` as the fallback validation message. Context.md said "keys must exist in both en/zh" but didn't capture the `-2` convention.

3. **`ValidationAppException` used `'graphifyDisabled' as unknown as number`** — error-severity type safety violation. The exception signature expects a numeric i18n key; the agent cast a string to bypass typechecking. Context.md didn't capture the AppException construction pattern.

**Context used (moments the agent made the right call because of context.md):**

1. Did NOT re-derive the `source` union in `KbResultDto @ApiProperty` — the agent knew from context.md that all 4 locations need `'code'` and left them alone (no DTO changes needed for US-003 anyway, but the constraint was primed).
2. Did NOT re-derive `graphifyLastImportedAt` location — correctly placed in controller, not service. AC9 passed first time.
3. Did NOT re-derive i18n dual-locale rule — `graphifyDisabled` was added to both en and zh in round 1.
4. Did NOT re-attempt SQL-injectable filter strings (relevant only as background, but agent stayed clear of interpolated SQL).

**Context ignored (none detected):**
No direct "agent re-derived something that was in context.md" incidents observed. The agent's mistakes were all in domains NOT covered by context.md (transactions, i18n conventions, AppException patterns).

**Interpretation:** Context.md prevented rediscovery of all 4 constraints it captured, but US-003 introduced 3 new constraints from domains outside its scope. The escalation to powerful was needed to fix the final blocking transaction/i18n/AppException findings — Haiku exhausted autofix without resolving them.

**`context.md` updated after this story:** [x] — added 3 new constraints (transaction wrapping, `-2` i18n key, `ValidationAppException` numeric key) before running US-004.

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

### US-005 — CLI Command (INJECTION #3, bonus, CLI workspace)

**Run date:** 2026-04-15 (Started 13:54:44Z, Completed 14:14:02Z)

**Note:** context.md WAS injected. `workdir: "apps/cli"` (different workspace from US-001–004). The nax git-clean bug that tripped US-004 did NOT fire — reviews reached the LLM checks cleanly.

**Metrics:**

| Metric | Value |
|:-------|:------|
| Tier escalations | 0 (stayed on fast/haiku) |
| Review findings — semantic (final) | 0 |
| Review findings — adversarial (final) | 3 advisory, 0 blocking — passed |
| Review findings — adversarial (aggregate) | 13 advisory + 4 blocking across 3 rounds |
| Rectification iterations | 0 |
| Autofix iterations | 2 (succeeded on attempt 2) |
| Wall clock | 19.3 min |
| Final tier | fast (haiku) |
| Cost | Not captured (metrics.json written after acceptance; run halted mid-acceptance) |
| Human interventions | 1 (run halted by operator during acceptance phase — misconfigured acceptance, unrelated to story) |

**Rediscovery incidents (CLI-specific patterns context.md did NOT prevent — 4):**

1. **`ctx.projectSlug` vs `options.project`** — all other kb sub-commands (search/list/add/delete/optimize) use `ctx.projectSlug`. Agent initially used `options.project`. Blocking finding, round 2.
2. **`if (!ctx.projectSlug)` validation** — all other kb sub-commands have this pre-flight check. Agent omitted it. Blocking, round 2.
3. **Validate both `apiKey` AND `apiUrl`** — error message in the codebase says "API key or URL not configured" but agent only checked `!ctx.apiKey`. Blocking, round 2.
4. **Input validation for parsed JSON** — extracted `nodes`/`links` without checking the JSON actually had those keys. If `graph.json` is valid JSON but shape differs, undefined values propagate. Blocking, round 1.

**Context used (entries the agent demonstrably followed):**

- None directly observable — context.md had zero CLI-specific entries because US-001/002/003 never touched `apps/cli`. The agent relied entirely on the four injected CLI context files (`kb.ts`, `kb.spec.ts`, `auth.ts`, `error.ts`) to infer conventions. Notably, the pre-populated spec hypothesis ("CLI: uses `resolveAuth({})`, `unwrap(response)`, `handleApiError(err)`") never made it into context.md post-US-001 because it wasn't confirmed — and US-005 didn't actually need those specific helpers (it used `ctx` directly per the codebase's current idiom).

**Context ignored:** N/A — context.md had no CLI entries to follow.

**Interpretation:** US-005 is a negative-control-ish data point. context.md brought no CLI-specific value. Yet the story still completed in 19.3 min on Haiku with 2 autofix rounds and zero escalations — indicating that the domain-local context files (`kb.spec.ts` especially) + good adversarial review are sufficient for medium-complexity, well-scoped CLI work even without cross-story feature context. This suggests v1's value concentrates where cross-story constraint leakage is high (same-file refactors, same-module additions like US-001→US-002→US-003 in `apps/api`) and diminishes at workspace boundaries.

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
