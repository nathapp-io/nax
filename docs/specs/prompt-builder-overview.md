# Prompt Builder Re-architecture — Overview

**Status:** Draft
**Date:** 2026-04-11
**Owner:** TBD

## Problem

Prompt construction is scattered across the codebase in 8+ locations with inconsistent patterns:

- Inline template literals (`src/review/dialogue.ts`, `src/acceptance/*`, `src/interaction/plugins/auto.ts`)
- Standalone helper functions (`src/tdd/prompts.ts`, `src/routing/strategies/llm-prompts.ts`, `src/agents/shared/decompose.ts`)
- A parallel builder class (`src/debate/prompt-builder.ts`)
- A TDD-coupled builder (`src/prompts/builder.ts`)

Consequences:

1. **No single home** — adding/finding a prompt requires knowing which subsystem owns it.
2. **Inconsistent constitution + context injection** — some callsites forget to inject project constitution.
3. **Duplicated boilerplate** — wrapping, separators, JSON-mode directives drift across files.
4. **Hard to reason about reuse** — common sections (story, constitution, conventions) are re-implemented inline rather than reused.
5. **`PromptBuilder` is hardcoded to TDD** — closed `PromptRole` union, `if (role === "verifier")` branches in `build()`. Other subsystems built parallel solutions because the builder couldn't accommodate them.

## Goals

1. **One folder** — all prompt construction lives under `src/prompts/`. A grep for prompt-defining string literals outside this folder returns zero results.
2. **One mental model per domain** — each subsystem has a dedicated builder (TDD, debate, review, acceptance, rectifier, one-shot) with only the methods relevant to it.
3. **Type safety per domain** — `DebatePromptBuilder` does not expose `.verdict()`; `TddPromptBuilder` does not expose `.persona()`. The compiler prevents cross-domain method misuse.
4. **Shared engine, not shared inheritance** — composition via a single `SectionAccumulator` handles joining, wrapping, disk overrides, and consistency. Builders are thin domain facades over it.
5. **Call-order = section order** — the order of fluent method calls determines the section order in the output. Recipes read top-to-bottom in each role file. No global ordering constant.
6. **Reuse at the section layer** — universal sections (`constitution`, `story`, `context`) are pure functions in `core/sections/`. Builders import and call them; they never re-implement section content.
7. **Behaviour-preserving migration** — every PR is independently shippable, snapshot-guarded, and produces byte-identical output for existing callsites until a deliberate behaviour change is requested.

## Non-goals

- **Not** building a runtime role registry, template definitions, or per-role generic types. Plain classes per domain.
- **Not** introducing inheritance. No `BasePromptBuilder` parent class. Composition only.
- **Not** unifying one-shot prompts (router, decomposer, auto-approver) into the same shape as structured prompts. They get a thin `OneShotPromptBuilder` of their own.
- **Not** changing what prompts say. This is structural refactoring; LLM-visible content stays identical until phase 7+ (out of scope for this spec).
- **Not** changing the prompt audit / dump tooling. That already exists and works.
- **Not** extending disk-based prompt overrides to all roles. Stays scoped to TDD roles unless explicitly requested.

## Architecture summary

```
src/prompts/
├── core/
│   ├── section-accumulator.ts       # shared engine
│   ├── sections/                    # pure section functions
│   ├── universal-sections.ts        # null-guards + wrapping
│   ├── wrappers.ts                  # wrapUserSupplied, separators
│   └── types.ts
├── builders/
│   ├── tdd-builder.ts               # TddPromptBuilder
│   ├── debate-builder.ts            # DebatePromptBuilder
│   ├── review-builder.ts            # ReviewPromptBuilder
│   ├── acceptance-builder.ts        # AcceptancePromptBuilder
│   ├── rectifier-builder.ts         # RectifierPromptBuilder
│   └── one-shot-builder.ts          # OneShotPromptBuilder
├── loader.ts                        # disk override loader
└── index.ts                         # public barrel
```

**Key design decisions:**

- **Composition over inheritance.** Each builder owns a `SectionAccumulator` instance. The accumulator handles `add(section)`, `join()`, disk override loading, and constitution wrapping. Builders are domain facades that call `acc.add(...)` from typed methods.
- **Call-order semantics.** `acc.add()` appends; `acc.join()` outputs in insertion order. No global section-order constant. Each role file *is* the recipe.
- **Section reuse via pure functions.** `constitutionSection(c)`, `storySection(s)`, etc. live in `core/sections/` and return `PromptSection` objects. Multiple builders import the same function, guaranteeing no drift in wrapping or content.
- **Universal section helpers** (`core/universal-sections.ts`) centralize null-guard logic so each builder's `constitution()` method is a one-line delegation. Bug fixes propagate without per-builder edits.
- **No cross-builder imports.** Builders import only from `core/`. They never import from each other. Keeps domain boundaries enforceable by code review.
- **Public barrel only.** Other subsystems import from `src/prompts` (the barrel). Reaching into `src/prompts/core/` or `src/prompts/builders/*` from outside is forbidden — same singleton-fragmentation rule from `project-conventions.md`.

## Builder inventory

| Builder | Replaces | Domains |
|---|---|---|
| `TddPromptBuilder` | `src/prompts/builder.ts` (current `PromptBuilder`) | implementer, test-writer, verifier, no-test, single-session, tdd-simple, batch |
| `DebatePromptBuilder` | `src/debate/prompt-builder.ts` | propose, critique, rebut, synthesize |
| `ReviewPromptBuilder` | inline in `src/review/dialogue.ts`, `src/review/semantic.ts` | dialogue turns, semantic review |
| `AcceptancePromptBuilder` | inline in `src/acceptance/generator.ts`, `fix-diagnosis.ts`, `fix-executor.ts` | generation, diagnosis, fix execution |
| `RectifierPromptBuilder` | `src/tdd/prompts.ts` | tdd rectification, post-verify rectification |
| `OneShotPromptBuilder` | `src/routing/strategies/llm-prompts.ts`, `src/agents/shared/decompose.ts`, inline in `src/interaction/plugins/auto.ts` | router, decomposer, auto-approver |

## Section inventory

| Section | New / Existing | Used by |
|---|---|---|
| `constitutionSection` | existing (extract) | all builders |
| `storySection` / `batchStorySection` | existing | tdd, debate, review, acceptance, rectifier |
| `contextSection` | existing (extract) | tdd, debate, review |
| `roleTaskSection` | existing | tdd |
| `verdictSection` | existing | tdd (verifier) |
| `isolationSection` | existing | tdd |
| `hermeticSection` | existing | tdd |
| `tddLanguageSection` | existing | tdd |
| `acceptanceSection` | existing | tdd, acceptance |
| `conventionsSection` | existing | tdd |
| `personaSection` | NEW | debate |
| `proposalsSection` | NEW | debate |
| `historySection` | NEW | debate |
| `findingsSection` | NEW | review, rectifier, debate |
| `priorFailuresSection` | NEW | rectifier, acceptance (diagnosis) |
| `jsonSchemaSection` | NEW | review (semantic), one-shot, debate |
| `instructionsSection` | NEW | one-shot |
| `routingCandidatesSection` | NEW | one-shot (router) |

## Phase plan

Each phase is one PR (or a small group), independently shippable, snapshot-guarded.

| Phase | Scope | Risk | Doc |
|---|---|---|---|
| **Phase 1** | Create `core/section-accumulator.ts` + `core/universal-sections.ts`. Refactor existing `PromptBuilder` → `TddPromptBuilder` wrapping the accumulator. Behaviour-identical for TDD callsites. | Low | [prompt-builder-phase1.md](./prompt-builder-phase1.md) |
| **Phase 2** | Move `src/debate/prompt-builder.ts` → `src/prompts/builders/debate-builder.ts`. Refactor to wrap accumulator. Add `personaSection`, `proposalsSection`, `historySection`. Update debate callsites. Delete original. | Low–Medium | [prompt-builder-phase2.md](./prompt-builder-phase2.md) |
| **Phase 3** | Extract review prompts from `src/review/dialogue.ts` + `semantic.ts` into `ReviewPromptBuilder`. Add `findingsSection`. Update callsites. | Medium (persistent session) | [prompt-builder-phase3.md](./prompt-builder-phase3.md) |
| **Phase 4** | Extract acceptance prompts from `src/acceptance/*` into `AcceptancePromptBuilder`. | Medium | [prompt-builder-phase4.md](./prompt-builder-phase4.md) |
| **Phase 5** | Extract rectifier prompts from `src/tdd/prompts.ts` into `RectifierPromptBuilder`. Add `priorFailuresSection`. Delete `src/tdd/prompts.ts`. | Medium | [prompt-builder-phase5.md](./prompt-builder-phase5.md) |
| **Phase 6** | Move router, decomposer, auto-approver into `OneShotPromptBuilder`. Add `instructionsSection`, `routingCandidatesSection`, `jsonSchemaSection`. Delete originals. Add `src/prompts/README.md` invariants doc. | Low–Medium | [prompt-builder-phase6.md](./prompt-builder-phase6.md) |

After Phase 6: every prompt in the system lives under `src/prompts/`. Single grep, single mental model, one folder to onboard new contributors.

## Invariants (post-migration)

These become enforceable by code review and (optionally) lint:

1. All prompt-producing code lives in `src/prompts/`.
2. All builders wrap `SectionAccumulator` via composition. **No inheritance** between builders.
3. All section content comes from `core/sections/*.ts`. Builders contain no inline string literals beyond glue/punctuation.
4. Builders import only from `src/prompts/core/`. They never import from each other.
5. Other subsystems import builders only from the `src/prompts` barrel — never from internal paths.
6. Each builder method that adds a section is a one-line delegation to `this.acc.add(xSection(arg))`. Logic lives in section functions, not builders.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Behavioural drift during migration (extra `\n`, reordered sections) silently changes LLM output | Snapshot tests on `compiled.text` for every existing callsite. Each phase ships with its own snapshot suite. |
| Persistent sessions (review dialogue, stateful debate) don't fit "compose one full prompt" model | Phase 3 splits into a system-prompt builder (one-time) + a turn-prompt builder (per turn). Same builder, two `build()` paths. |
| Cross-domain prompts (rectifier needs TDD context + review findings) | Rectifier gets its own dedicated builder in Phase 5 with methods from both domains. Not forced into TDD or review builder. |
| Builders drift apart on shared method behaviour (constitution wrapping, separators) | Universal sections + `SectionAccumulator.join()` centralize all wrapping/separator logic. Builder methods are pure delegation. |
| New `RectifierPromptBuilder` becomes a mini god-class | Limit to ~120 lines. If it grows, split by trigger (`tdd-rectifier` vs `verify-rectifier`). |
| 60 lines of "duplicated" one-line delegation methods across builders | Accepted cost. Trade for clean per-builder type signatures and no inheritance footguns. |

## Out of scope

- Changing prompt content (LLM-visible text)
- Adding new prompt audit/dump features
- Extending disk overrides to non-TDD roles
- Lint rule banning raw `adapter.run("...")` outside `src/prompts`
- Caching compiled prompts by hash
- Token budget management or section truncation

These may become follow-up specs but are deliberately excluded from this refactor to keep scope tight.

## Success criteria

1. `grep -r '"You are' src/ --include='*.ts' | grep -v src/prompts` returns zero matches.
2. `src/debate/prompt-builder.ts`, `src/tdd/prompts.ts`, `src/routing/strategies/llm-prompts.ts`, `src/agents/shared/decompose.ts` no longer exist.
3. No file in `src/review/`, `src/acceptance/`, `src/interaction/plugins/` contains template literals longer than 5 lines.
4. All existing tests pass without modification (snapshot tests confirm byte-identical output).
5. Every builder file is under 200 lines.
6. `SectionAccumulator` is under 120 lines.
7. New contributors can answer "where is the prompt for X?" with `ls src/prompts/builders/`.
