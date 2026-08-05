# SPEC: Bounded rules floor via section-level chunking

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Canonical rules are budgeted and emitted at file granularity: one `.nax/rules/*.md`
file becomes exactly one context chunk, admitted or dropped whole. The repo's
largest rule file is also its highest-priority one (3,485 tokens, 87% of a
4,000-token stage budget), so no per-stage cap placed at file granularity can
behave sensibly — any share low enough to protect non-floor chunks is smaller
than the single largest rule.

This spec introduces sub-file granularity: rule files are split at `## ` (H2)
headings into sections that inherit the file's frontmatter, a section-aware
budget truncates at a section edge instead of dropping a file whole, and the
static-rules provider derives its budget from the per-stage budget already
present on `ContextRequest`. Enforcement, currently opt-in, becomes the default.

## Motivation

The context engine declares per-stage token budgets (`stage-config.ts`: 4,000 to
12,000, default 8,000) and does not honour them for canonical rules. Two throttles
sit between the corpus and the prompt and both are open:

1. `StaticRulesProvider` receives `enforceBudget` defaulting to `false`
   (`schemas-context.ts:76`), so `applyCanonicalRulesBudget` reports
   `overageTokens` and truncates nothing.
2. `packChunks` pass 1 (`packing.ts:97-105`) admits every floor-kind chunk
   unconditionally, recording `floorOverageIds` but never stopping.

The measured corpus is roughly 17,200 tokens across 11 files, so a 4,000-token
stage ships around 4x its declared budget and non-floor chunks (code neighbours,
git history, session scratch) are starved of the remainder.

The soft default was deliberate. `applyCanonicalRulesBudget`'s docstring records
why: "nothing downstream currently enforces a ceiling on these chunks either, so
the overage is reported, not capped." Capping rules while packing stays unbounded
only moves the cliff. Section granularity is what makes a cap survivable, because
truncation lands mid-file instead of destroying the highest-priority rule.

The eviction policy itself is already correct and is not changed by this spec:
`priority: <n>` means lower number = more important
(`SPEC-context-engine-canonical-rules.md:121`), the sort at
`canonical-loader.ts:450` is ascending, and enforced mode keeps the longest
leading run that fits.

## Design

### Integration

Verified symbols and signatures this spec builds on:

| Symbol | Location | Shape |
|:---|:---|:---|
| `CanonicalRule` | `src/context/rules/canonical-loader.ts` | `{ id?, fileName, path?, content, tokens?, priority?, paths?, appliesTo?, stages?, warnings? }` |
| `applyCanonicalRulesBudget` | `canonical-loader.ts:308` | `(rules, budgetTokens, options?) => CanonicalRulesBudgetResult` |
| `CanonicalRulesBudgetResult` | `canonical-loader.ts` | `{ rules, totalTokens, usedTokens, droppedCount, overageTokens }` |
| `StaticRulesProvider` | `src/context/engine/providers/static-rules.ts:230` | class, `fetch(request: ContextRequest)` |
| `StaticRulesProviderOptions` | `static-rules.ts` | `{ allowLegacyClaudeMd?, budgetTokens?, enforceBudget? }` |
| `_staticRulesDeps` | `static-rules.ts` | injectable deps object, already carries `loadCanonicalRules` |
| `ProviderBudgetPressure` | `src/context/engine/manifest-types.ts` | `{ overageTokens, droppedCount, droppedTokens, droppedIds }` |
| `ProviderScopingReport` | `manifest-types.ts` | `{ stageFilteredIds, appliesToFilteredIds, appliesToInertCount, scopeFileCount }` |
| `ContextRequest.budgetTokens` | `src/context/engine/types.ts` | the per-stage budget, already on the request |
| `ContextRequest.stage` | `types.ts` | stage name, already on the request |
| `estimateTokens` | `src/optimizer/types.ts:51` | `(text: string) => number` |
| `DEFAULT_CANONICAL_RULES_BUDGET_TOKENS` | `canonical-loader.ts:176` | `8_192` |
| `rulesLintCommand` | `src/cli/rules-lint.ts:115` | backs `nax rules lint` |

Patterns to mirror: `_deps` injection for stubbing (`mock.module()` is forbidden
by `.nax/rules/forbidden-patterns.md`), `Bun.file()` over `fs.readFileSync`, and
tests mirroring `src/` under `test/unit/`.

Import convention for the two new modules: use the `@/` alias —
`@/context/rules/rule-sections` and `@/context/rules/rule-budget`. Two lint
ratchets bear on this and the alias satisfies both:

- `check:alias-internals` rejects `@/<dir>/<internal>` **only when
  `src/<dir>/index.ts` exists**. `src/context/rules/` has no barrel, so the
  alias form is not a violation.
- `check:deep-relatives` is a baseline ratchet on 2-or-more-level relative
  imports that must not increase. A relative `../../rules/rule-sections` from
  `static-rules.ts` would raise it, so relative imports are the wrong choice
  here even though existing consumers use them.

Adding a barrel at `src/context/rules/index.ts` would align the directory with
the "2+ exports gets a barrel" convention in
`.claude/rules/project-conventions.md`, which it currently violates. That is
deliberately **not** done here: it would require rewriting six existing import
sites across `src/` and `test/` for no behavioural gain, and it is listed under
Out of Scope.

Sizing constraint: `canonical-loader.ts` is 487 lines and `static-rules.ts` is
521, against a 600-line limit enforced by `check:file-sizes` in `bun run lint`.
Both new capabilities therefore land in new modules rather than growing either
file. `canonicalRuleId` and `canonicalRulePath` are file-local to
`static-rules.ts:94-98` and are not importable, so the section module derives its
own identifiers.

### Approach

Sections split at `## ` (H2) only. Content preceding the first H2 becomes an
ordinal-0 preamble section. H3 and deeper headings stay inside their parent
section. A file with no H2 yields exactly one section, preserving today's
behaviour for simple rule files.

Truncation retains the contiguous-tail contract — longest leading run that fits,
everything after dropped — with one refinement sections make possible: the
boundary file contributes its leading sections instead of being dropped whole.

The provider's budget becomes
`min(rulesShare * request.budgetTokens, rules.budgetTokens)`, where
`request.budgetTokens` is the stage budget. The existing global
`rules.budgetTokens` becomes an absolute upper bound so current configuration
keeps its meaning.

`rawScore` stays flat at `1.0` for every emitted rule chunk. Differential scoring
depends on the effectiveness classifier, which is out of scope.

**Schema default and constructor default are separate, and only the schema
flips.** `ContextV2RulesConfigSchema.enforceBudget` changes from `false` to
`true`, so every production assembly enforces the cap — the orchestrator reads
the resolved config at `orchestrator-factory.ts:45` and passes it in. The
provider's own constructor fallback at `static-rules.ts:241`
(`options.enforceBudget ?? false`) is deliberately left at `false`, so a
directly-constructed `StaticRulesProvider` that names no option keeps today's
soft behaviour. This keeps the three soft-mode tests at
`test/unit/context/engine/providers/static-rules.test.ts:629-660` valid, since
they construct the provider without the option and assert that no rule is
dropped.

Note for implementers: `.nax/features/rules-budget-truncation/acceptance-refined.json`
records "the resolved `enforceBudget` equals false" as the acceptance contract of
the already-merged rules-budget-truncation arc. That file lives outside the
project's `testpaths` and so is not executed by `bun run test`, but it is now a
stale contract. Do not re-sign it as evidence that the default must stay `false`.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Rule content has no `## ` heading | Yields exactly one section containing the whole content. No error. |
| `.nax/rules/` directory absent | Existing behaviour preserved: no canonical chunks emitted, no throw. |
| `rulesShare` outside the range 0 to 1 | Rejected at config load by the schema. |
| A single section alone exceeds the budget | Admitted whole and reported as overage. Fail-open: a rule is never gutted mid-sentence. |
| `budgetTokens` zero, negative, or non-finite | Empty section list returned, `overageTokens` mirrors `totalTokens`, matching the existing `applyCanonicalRulesBudget` contract. |

## Out of Scope

- Implementing `roles:` frontmatter filtering (the remaining half of issue #822) is not part of this spec; only `appliesTo:`, `stages:`, and `paths:` scoping are used.
- Bounding the `feature` and `test-coverage` floor kinds inside `packChunks` is not part of this spec; only the `static` kind is bounded, and it is bounded at the provider rather than in packing.
- Differential scoring of rule chunks is not part of this spec; every emitted rule chunk keeps `rawScore: 1.0`.
- Modifying the context-engine effectiveness classifier or its `pollutionRatio` computation is not part of this spec.
- Implementing the context-engine v2 write path (capture, extract, summarize, promote) or the `query_scratch` pull tool is not part of this spec.
- Updating the `rules-setup` skill in the `nax-toolkit-skills` repository is not part of this spec; it is a follow-on change in a separate repository.
- Splitting rule files below the H2 heading level is not part of this spec; a single H2 section is the smallest indivisible unit.
- Changing the meaning of the `priority:` frontmatter field or the ascending sort order is not part of this spec.
- Adding a barrel `index.ts` to `src/context/rules/` and migrating its six existing import sites is not part of this spec, even though the directory violates the project's "2+ exports gets a barrel" convention.

## Stories

### US-001 — Section-level rule chunking

Introduces a module that splits a `CanonicalRule` into ordered sections
inheriting the rule's frontmatter.

- Depends on: nothing
- Context Files:
  - `src/context/rules/canonical-loader.ts` — `CanonicalRule` shape and loader conventions
  - `src/context/rules/rules-frontmatter.ts` — frontmatter field defaults
  - `src/context/engine/providers/static-rules.ts` — existing chunk id construction to mirror
  - `src/optimizer/types.ts` — `estimateTokens`
  - `test/unit/context/rules/canonical-loader.test.ts` — existing rule-test patterns to mirror
- Creates:
  - `src/context/rules/rule-sections.ts`
  - `test/unit/context/rules/rule-sections.test.ts`

### US-002 — Section-aware budget with boundary truncation

Introduces a budget function over sections that preserves the contiguous-tail
contract while allowing the boundary file to contribute its leading sections.

- Depends on: US-001
- Context Files:
  - `src/context/rules/canonical-loader.ts` — `applyCanonicalRulesBudget` contract being mirrored
  - `src/context/rules/rule-sections.ts` — created by US-001, consumed here
  - `test/unit/context/rules/rule-sections.test.ts` — created by US-001, patterns to mirror
- Creates:
  - `src/context/rules/rule-budget.ts`
  - `test/unit/context/rules/rule-budget.test.ts`

### US-003 — Per-stage budget derivation and enforced default

Adds the `rulesShare` config key, flips `enforceBudget` to default true, and
derives the provider's effective budget from the per-stage budget already on the
request.

- Depends on: US-002
- Context Files:
  - `src/config/schemas-context.ts` — rules config block and its default literals
  - `src/config/schemas.ts` — third nested rules default literal at line 321
  - `src/config/runtime-types-context.ts` — resolved config types
  - `src/context/engine/orchestrator-factory.ts` — provider construction
  - `src/context/engine/providers/static-rules.ts` — provider being modified
- Creates:
  - `test/unit/context/engine/providers/static-rules-budget-derivation.test.ts`

### Modifies

- `src/config/schemas-context.ts` — add `rulesShare` to `ContextV2RulesConfigSchema`; flip the `enforceBudget` default to `true`; update both nested default literals at lines 78 and 236.
- `src/config/schemas.ts` — update the nested rules default literal at line 321 to carry `rulesShare` and the new `enforceBudget` default.
- `src/config/runtime-types-context.ts` — add `rulesShare` to the resolved rules config type.
- `src/context/engine/providers/static-rules.ts` — derive the effective budget from `request.budgetTokens` and the configured `rulesShare`.
- `test/unit/config/schemas.test.ts` — the two tests at lines 531 and 539 assert `enforceBudget` resolves to `false` when unset. Both must be updated to assert `true`. This story owns that edit; without it the story cannot pass with a correct implementation.

### US-004 — Section wiring and telemetry

Wires sections and the section budget through `StaticRulesProvider`'s chunk
emission, and extends the manifest telemetry to section granularity.

- Depends on: US-003
- Context Files:
  - `src/context/engine/providers/static-rules.ts` — provider being modified
  - `src/context/engine/manifest-types.ts` — telemetry report shapes
  - `src/context/rules/rule-sections.ts` — created by US-001, consumed here
  - `src/context/rules/rule-budget.ts` — created by US-002, consumed here
  - `src/context/engine/manifest-builder.ts` — how reports reach the manifest
- Creates:
  - `test/unit/context/engine/providers/static-rules-sections.test.ts`

### US-005 — Corpus hygiene (terminal cleanup)

Splits the mixed-concern rule file, adds scoping frontmatter to the files that
declare none, and rebalances priorities so that lowest numbers are small files.
Deletion and rename only; no new code.

- Depends on: US-004
- Context Files:
  - `.nax/rules/forbidden-patterns.md` — file being split
  - `.nax/rules/monorepo-awareness.md` — gains `paths:`
  - `.nax/rules/project-conventions.md` — gains scoping
  - `.nax/rules/config-patterns.md` — gains scoping
  - `.nax/rules/error-handling.md` — gains scoping
- Creates:
  - `.nax/rules/forbidden-patterns-source.md`
  - `.nax/rules/forbidden-patterns-tests.md`

**Verification note.** This story is deletion and rename only. Its removals are
verified by the build and static gate, not by runtime acceptance criteria:
`bun run dev rules lint` must report zero errors, and `bun run lint` (which
includes `check:file-sizes`) must pass. `.nax/rules/forbidden-patterns.md` is
deleted as part of the split.

### Seams

- US-001 exports `splitRuleIntoSections`; US-004 is its production consumer. Seam
  invariant declared in US-004 AC-1.
- US-002 exports `applySectionBudget`; US-004 is its production consumer. Seam
  invariant declared in US-004 AC-2.

Both seam ACs enter at `StaticRulesProvider.fetch(request)` — the provider's
outermost production entry point, the method the orchestrator calls generically
for every registered provider. Neither stubs an intermediate helper this spec
introduces. Both symbols are new (created by US-001 and US-002), so the call path
is one this spec creates rather than one that must already reach them.

## Acceptance Criteria

### US-001 — Section-level rule chunking

1. `[unit]` `splitRuleIntoSections` is importable from `src/context/rules/rule-sections.ts` and, called with a `CanonicalRule` whose content holds three `## ` headings, returns three sections.
2. `[unit]` Calling `splitRuleIntoSections` with content holding three `## ` headings returns sections whose `ordinal` values are `0`, `1`, `2` in document order.
3. `[unit]` Calling `splitRuleIntoSections` with content that begins with text before the first `## ` heading returns a first section whose `ordinal` is `0` and whose `heading` is undefined.
4. `[unit]` Calling `splitRuleIntoSections` with content containing no `## ` heading returns exactly one section whose `content` equals the rule's content.
5. `[unit]` Calling `splitRuleIntoSections` with a rule declaring `priority: 45` returns sections each of whose `priority` equals `45`.
6. `[unit]` Calling `splitRuleIntoSections` with a rule declaring `appliesTo: ["src/**"]` and `stages: ["execution"]` returns sections each carrying those same `appliesTo` and `stages` values.
7. `[unit]` Calling `splitRuleIntoSections` with a heading `## Prompt Builder Convention` returns a section whose `slug` is `prompt-builder-convention`.
8. `[unit]` Calling `splitRuleIntoSections` with content containing the same `## ` heading text twice returns two sections with different `slug` values.
9. `[unit]` Calling `splitRuleIntoSections` with a section body containing a `### ` heading returns a section whose `content` includes that `### ` heading, and does not start a new section for it.
10. `[unit]` Calling `splitRuleIntoSections` returns sections whose `tokens` value equals the token estimate of that section's own `content`.

### US-002 — Section-aware budget with boundary truncation

1. `[unit]` `applySectionBudget` is importable from `src/context/rules/rule-budget.ts` and, called with sections whose total tokens are below the budget, returns every supplied section.
2. `[unit]` Called with sections from two rules whose combined tokens fit the budget, `applySectionBudget` returns them ordered by ascending `priority`, then ascending `ordinal`.
3. `[unit]` Called with a budget that accommodates only the first two of a rule's four sections, `applySectionBudget` returns those two sections and omits the rule's remaining two.
4. `[unit]` Called with a budget exhausted partway through the first rule, `applySectionBudget` omits every section belonging to any lower-priority rule, even when one of those sections would fit in the remaining space.
5. `[unit]` Called with a single section whose tokens exceed the budget on its own, `applySectionBudget` returns that section and reports `overageTokens` greater than zero.
6. `[unit]` Called with sections that do not all fit, `applySectionBudget` returns a `droppedIds` array containing the identifier of every omitted section.
7. `[unit]` Called with an empty section array, `applySectionBudget` returns an empty section list and `overageTokens` of zero.
8. `[unit]` Called with a `budgetTokens` of zero, `applySectionBudget` returns an empty section list and an `overageTokens` equal to the total tokens of the supplied sections.
9. `[unit]` Called with a non-finite `budgetTokens`, `applySectionBudget` returns an empty section list rather than throwing.

### US-003 — Per-stage budget derivation and enforced default

1. `[unit]` Constructing the nax config with `context.v2.rules.rulesShare` unset yields a resolved `rulesShare` of `0.4`.
2. `[unit]` Constructing the nax config with `context.v2.rules.enforceBudget` unset yields a resolved `enforceBudget` of `true`.
3. `[unit]` Constructing the nax config with `context.v2.rules.rulesShare` set to `1.5` is rejected with a validation error.
4. `[unit]` Constructing the nax config with `context.v2.rules.rulesShare` set to `-0.1` is rejected with a validation error.
5. `[unit]` Calling `StaticRulesProvider.fetch` with a request whose `budgetTokens` is `4000`, a configured `rulesShare` of `0.4`, and a global `budgetTokens` of `8192` applies an effective rules budget of `1600`.
6. `[unit]` Calling `StaticRulesProvider.fetch` with a request whose `budgetTokens` is `12000` and a configured `rulesShare` of `0.9` applies an effective rules budget of `8192` rather than `10800`.
7. `[unit]` Calling `StaticRulesProvider.fetch` against a repository root having no `.nax/rules/` directory returns an empty chunk list without throwing.
8. `[unit]` Constructing `StaticRulesProvider` with no `enforceBudget` option and a `budgetTokens` smaller than the supplied corpus returns one chunk per canonical rule, preserving the constructor's soft fallback.

### US-004 — Section wiring and telemetry

1. `[unit]` With `_staticRulesDeps.splitRuleIntoSections` replaced by a stub, calling `StaticRulesProvider.fetch` invokes that stub once for each canonical rule loaded.
2. `[unit]` With `_staticRulesDeps.applySectionBudget` replaced by a stub, calling `StaticRulesProvider.fetch` with a request whose `budgetTokens` is `4000` invokes that stub with a budget argument of `1600`.
3. `[unit]` Calling `StaticRulesProvider.fetch` against a corpus holding one rule file with two `## ` sections returns two chunks with different `id` values.
4. `[unit]` Calling `StaticRulesProvider.fetch` returns chunks whose `id` values each incorporate the owning section's slug.
5. `[unit]` Calling `StaticRulesProvider.fetch` returns chunks each having a `kind` of `static`.
6. `[unit]` Calling `StaticRulesProvider.fetch` returns chunks each having a `rawScore` of `1.0`.
7. `[unit]` Calling `StaticRulesProvider.fetch` with a corpus exceeding the effective budget returns a `budgetPressure` whose `droppedCount` equals the number of omitted sections.
8. `[unit]` Calling `StaticRulesProvider.fetch` with a corpus exceeding the effective budget returns a `budgetPressure` whose `droppedTokens` equals the summed tokens of the omitted sections.
9. `[unit]` Calling `StaticRulesProvider.fetch` returns a `scopingReport` whose `sectionCount` equals the number of sections remaining after stage and `appliesTo` filtering.
10. `[unit]` Calling `StaticRulesProvider.fetch` with a request whose `stage` is excluded by a rule's `stages:` list returns no chunk originating from that rule.
11. `[unit]` With `_staticRulesDeps.applySectionBudget` replaced by a stub, calling `StaticRulesProvider.fetch` with a request whose `stage` is excluded by a rule's `stages:` list invokes that stub with a section list holding no section from that rule.

### US-005 — Corpus hygiene (terminal cleanup)

No runtime acceptance criteria. This story deletes and renames rule files; its
verification is the build and static gate recorded in the story's verification
note above (`bun run dev rules lint` reporting zero errors, and `bun run lint`
passing).
