# Static Rules — `appliesTo:` Pitfall and Stage-Filter Gap

**Date:** 2026-04-30
**Status:** Findings — proposes follow-up work, no code change in nax beyond the [Static Rules Guide](../guides/static-rules.md).
**Related:** [#738](https://github.com/nathapp-io/nax/issues/738), [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md)

---

## Summary

Koda experiment: split `apps/api/.nax/rules/api.md` (88 LOC, 12 mixed concerns) into 5 concern-scoped files using `appliesTo:` to filter by touched files. Manifest inspection revealed **`api-testing.md` silently failed to load on the `tdd-test-writer` stage** — exactly the stage that needs it most.

Root cause: `appliesTo:` filters against `request.touchedFiles`, which is the PRD's `contextFiles` — a list of **input source files**, by convention. Test rules whose `appliesTo:` matches test-file globs (`**/*.spec.ts`, `**/test/**`) have near-zero hit rate because PRDs almost never list the test files an agent will produce.

This is a generalizable structural mismatch: **`appliesTo:` is an input filter; rules about authoring an artifact cannot filter on the artifact being authored.**

---

## Experiment

### Setup

Koda's `apps/api/.nax/rules/api.md` was a monolithic 88-line file mixing 12 concerns (Auth, Data & Domain, Prisma, Responses, Swagger, Testing, i18n, Pagination Anti-Patterns, Testing Anti-Patterns, etc.). Every `apps/api` story carried all 88 lines regardless of what it touched.

### Split design

| New file | `appliesTo:` | Concerns merged |
|:---|:---|:---|
| api-core.md | none (always-on for `apps/api`) | Read-First, Auth, Quality Gates, Implementation Anti-Patterns, Quick Reference |
| api-data.md | `**/*.service.ts`, `**/*.repository.ts`, `**/tickets/**`, `**/projects/**`, `**/prisma/**` | Data & Domain, Prisma, Pagination Anti-Patterns |
| api-controllers.md | `**/*.controller.ts` | Responses & Exceptions, Swagger |
| api-testing.md (initial) | `**/*.spec.ts`, `**/test/**` | Testing, Testing Anti-Patterns |
| api-i18n.md | `**/i18n/**`, `**/*.controller.ts`, `**/*.service.ts` | i18n |

### Validation: real story

Story `memory-phase4-graph-code-intelligence/US-001` ("Incremental Graph Diff — Replace Full Re-Import") with:

```json
"contextFiles": [
  "apps/api/src/rag/rag.service.ts",
  "apps/api/src/rag/rag.controller.ts",
  "apps/api/src/rag/dto/import-graphify.dto.ts",
  "apps/api/prisma/schema.prisma"
]
```

Manifest at `<feature>/stories/US-001/context-manifest-tdd-test-writer.json`:

| Rule | Pattern matched | Loaded |
|:---|:---|:---|
| api-core | always-on | yes |
| api-data | `*.service.ts`, `prisma/**` | yes |
| api-controllers | `*.controller.ts` | yes |
| api-i18n | `*.controller.ts`, `*.service.ts` | yes |
| **api-testing** | none — contextFiles list source files, not specs | **no — bug** |

The `tdd-test-writer` stage — the stage authoring tests — never received the rules about how to write tests.

---

## Root cause

`appliesTo:` matches against `ContextRequest.touchedFiles` ([static-rules.ts:139-146](../../src/context/engine/providers/static-rules.ts#L139-L146)). That field is set in [stage-assembler.ts:193](../../src/context/engine/stage-assembler.ts#L193):

```typescript
touchedFiles: options.touchedFiles ?? getContextFiles(ctx.story)
```

`getContextFiles()` returns `story.contextFiles ?? story.relevantFiles ?? []` from the PRD ([src/prd/types.ts:170](../../src/prd/types.ts#L170)).

By **planner convention**, `contextFiles` is a list of source files the story will modify or use as input — the **system under test**. Tests are produced as a side-effect of TDD, not declared upfront. Sample evidence from US-001 above: 4 source files, 0 spec files.

So `appliesTo: ["**/*.spec.ts"]` matches only when the story is *about an existing test* (Jest→Vitest migration, fix flaky test, refactor a test suite). For the 95% of stories where the test is the artifact being produced, the filter never fires.

---

## Generalizable lesson — input vs output rules

`appliesTo:` is a filter on inputs. Rules about authoring artifacts can't filter on the artifact being authored.

| Rule body | Bad `appliesTo:` (output globs) | Better |
|:---|:---|:---|
| How to write tests | `**/*.spec.ts`, `**/test/**` | none, or globs of source files being tested |
| How to write migrations | `**/migrations/*.sql` | none, or schema files driving the migration |
| How to write generated client | `**/generated/**` | none, or the OpenAPI spec |
| How to write docs | `docs/**/*.md` | none, or the code being documented |

**Rule of thumb:** if the rule body says "When you write X, do Y", don't `appliesTo:` X.

The corollary is that **output-authoring rules are typically always-on** (drop `appliesTo:`, rely on `paths:` for package scope). The token cost is small (~25 LOC × ~5 chars × 6+ stages = ~750 wasted tokens per story across non-authoring stages). Acceptable but not free.

---

## Fix applied

`apps/api/.nax/rules/api-testing.md` `appliesTo:` removed. Now always-on for `apps/api` stories. Re-running US-001 should show api-testing.md in every stage manifest including `tdd-test-writer`.

The [Static Rules Guide](../guides/static-rules.md) was updated with a "Pitfall — rules about producing artifacts" section so this is documented for future authors.

---

## Token economy from the experiment

api-rules volume by story shape, before and after the split:

| Story type | Before (single api.md) | After (split + appliesTo) |
|:---|:---|:---|
| Controller-only (e.g. add endpoint) | 88 LOC | api-core (37) + api-controllers (20) + api-i18n (16) = **73** |
| Repository / service | 88 | api-core (37) + api-data (35) + api-i18n (16) + api-testing (24, now always-on) = **112** |
| Test-only refactor | 88 | api-core (37) + api-testing (24) = **61** |
| Mixed (US-001-style) | 88 | All 5 = **132** |
| Greenfield (`contextFiles=[]`) | 88 | All 5 (empty-list short-circuit fires) = **132** |

Real but modest wins on single-concern stories (controller-only: −17%, test-only: −31%). Mixed and greenfield stories grow ~50% because the split duplicates frontmatter + headings across files and the always-on testing rule is added.

**Headline finding:** file-level filtering via `appliesTo:` is **only worth doing when single-concern stories are common**. For Koda's apps/api work where stories typically span controller + service + repository, the split barely moves volume. The win is structural clarity (one concern per file), not token count.

---

## What this implies for issue #738

#738's hypothesis was that file-level filtering (Framing A) might be enough to fix the rules-bloat problem before considering Framing B (per-section tag filtering). The koda experiment is one data point against that:

- Single-concern stories: file-level filtering helps materially.
- Multi-concern stories: file-level filtering is a wash on tokens; helps only structural clarity.
- Greenfield: no filtering possible (empty-list short-circuit).

For projects whose stories typically span 3+ concerns within one package, **file-level filtering will not move the rules-to-story ratio meaningfully**. Framing B (intra-file section filtering by tag) becomes the next instrument.

But Framing B has the same structural pitfall this experiment exposed — sections about authoring tests cannot section-tag-filter on the artifact being authored. The same input-vs-output care must apply.

---

## Proposed follow-up — `stages:` frontmatter

The engine already routes every provider call through a `request.stage` parameter ([stage-assembler.ts:182-212](../../src/context/engine/stage-assembler.ts#L182-L212)) but `StaticRulesProvider` doesn't read it. Adding a `stages:` filter axis would let always-on rules (like api-testing.md) target the stages that actually need them, recouping the ~750 tokens currently wasted on `plan` / `decompose` / `acceptance`.

Sketch:

```yaml
---
paths: ["apps/api/*"]
stages: ["execution", "tdd-test-writer", "tdd-implementer", "rectify", "review", "single-session"]
priority: 80
---
```

Empty/missing `stages:` = applies to all (back-compat). Cost: ~15 LOC in canonical-loader (parse + validate) + ~3 LOC in static-rules.ts (apply filter). No engine changes needed.

A second knob — `roles:` — already has the plumbing in scoring ([scoring.ts:58-62](../../src/context/engine/scoring.ts#L58-L62)) but the loader hardcodes `role: ["all"]`. Threading frontmatter through is trivial and lets reviewer-only checklists or planner-only style guides exist without touching new infrastructure. Coarser than `stages:` (every implementation-flavored stage shares `role: implementer`) but cheaper.

Both knobs can ship in one small PR (~50 LOC + tests). They are gated only on whether the wasted-token signal proves worth chasing — which the koda manifest doesn't currently make a strong case for.

---

## Recommendations

1. **Keep authoring rules always-on** (no `appliesTo:`) until `stages:` filtering ships. This is the safe default.
2. **Use `appliesTo:` only for consumer rules** — rules that fire when the agent reads (not produces) a matching file. Pagination anti-patterns are a good fit (the agent reads pagination code to extend it). i18n key conventions are borderline (read or write).
3. **Validate every rule split with a real-story manifest** before considering the split done. Check `<feature>/stories/<storyId>/context-manifest-<stage>.json` and confirm rules reach the stages where they apply. Manifest inspection is the only reliable validation — reading the loader code is not enough because the failure mode is at the system-convention level, not the code level.
4. **For the nax migration** of `.claude/rules/` → `.nax/rules/`: apply this experiment's lessons. `test-architecture.md`, `test-helpers.md`, `test-writing.md`, `testing-commands.md` should NOT use `appliesTo: ["test/**"]`. They are authoring rules and need always-on behaviour.
5. **For Framing B (per-section tags) when telemetry justifies it:** apply the same input-vs-output discipline at section granularity. A "## Testing Anti-Patterns" section tagged `<!-- nax-tags: [testing] -->` has the same trap as `appliesTo: ["**/*.spec.ts"]` if the planner emits source-file tags rather than concern tags.

---

## Files modified

In this finding's experiment:

- `koda/.nax/rules/api.md` — deleted (replaced by 5 concern files)
- `koda/.nax/rules/api-core.md`, `api-data.md`, `api-controllers.md`, `api-i18n.md` — created
- `koda/.nax/rules/api-testing.md` — created, then `appliesTo:` removed after manifest validation revealed the bug

In nax (this repo):

- `docs/guides/static-rules.md` — created (operator-facing guide for rule authoring)
- `docs/guides/context-engine.md` — cross-link added pointing to the new guide

No nax source code changed. The follow-up `stages:` / `roles:` PR is a separate, optional improvement.
