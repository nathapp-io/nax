# Bounded rules floor via section-level chunking

Date: 2026-08-05
Status: Design approved, not yet planned
Repo state at design time: `main` @ `8527a2c1`, zero open PRs

## Problem

The context engine declares per-stage token budgets (`stage-config.ts`: 4,000 to
12,000, default 8,000) and then does not honour them for canonical rules. Two
throttles sit between the rule corpus and the prompt, and both are open:

1. `StaticRulesProvider` receives `enforceBudget` defaulting to `false`
   (`schemas-context.ts:76`), so `applyCanonicalRulesBudget` reports
   `overageTokens` and truncates nothing.
2. `packChunks` pass 1 (`packing.ts:97-105`) admits every floor-kind chunk
   unconditionally — `FLOOR_KINDS = ["static", "feature", "test-coverage"]` —
   recording `floorOverageIds` but never stopping.

The measured corpus in this repo is roughly 17,200 tokens across 11 files (byte
count divided by four; the engine's own `estimateTokens` gives a slightly lower
figure, around 16,400). A 4,000-token stage therefore ships around 4x its
declared budget, and non-floor chunks (code neighbours, git history, session
scratch) are starved of the remainder.

The soft default in throttle 1 was deliberate. `applyCanonicalRulesBudget`'s own
docstring explains why:

> Soft-by-default removes the legacy silent truncation cliff for floor-kind
> rules — nothing downstream currently enforces a ceiling on these chunks
> either, so the overage is reported, not capped.

That is, #1462 fixed under-delivery and left over-delivery open on purpose,
because capping rules while packing stays unbounded only moves the cliff. The
two throttles are coupled, and that coupling is what this design addresses.

## What is already correct, and must not be rebuilt

The eviction *policy* is already right and already shipped. It was re-verified
during this design rather than taken from the backlog notes:

- `priority: <n>` means lower number = more important. This is stated at
  `SPEC-context-engine-canonical-rules.md:121` ("Lower = earlier = less likely
  truncated") and is authoritative. Lines 117 and 351 of the same spec say "keep
  files with higher priority", using "higher priority" in the English sense of
  more important; they do not contradict line 121.
- The sort at `canonical-loader.ts:450` is ascending by priority, then
  alphabetical. Correct.
- Enforced mode keeps the longest leading run that fits, via `break` on first
  non-fit (`canonical-loader.ts:339-343`). The best-fit `continue` bug described
  in `SPEC-context-budget-truth.md:15` has already been fixed.

No part of this design changes priority semantics or the sort.

## The blocker: file granularity

Rules are budgeted and emitted at file granularity. `static-rules.ts:362` maps
one `CanonicalRule` to exactly one `RawChunk` with a flat `rawScore: 1.0`, and
`applyCanonicalRulesBudget` iterates whole files. A rule is admitted or dropped
whole.

The corpus is shaped pathologically against that:

| rule | priority | approx tokens |
|:-----|---------:|--------------:|
| forbidden-patterns | 30 | 3,485 |
| project-conventions | 35 | 1,533 |
| error-handling | 40 | 711 |
| testing-commands | 45 | 865 |
| test-architecture | 50 | 956 |
| config-patterns | 55 | 842 |
| adapter-wiring | 60 | 1,536 |
| test-helpers | 70 | 1,111 |
| monorepo-awareness | 80 | 2,645 |
| retry-strategy | 90 | 3,027 |
| test-writing | 100 | 459 |

The highest-priority rule is also the largest file. `forbidden-patterns.md` is
3,485 tokens — 87% of an entire 4,000-token stage budget on its own.

Applying a per-stage fraction to this, with the existing `break` semantics:

| stage budget | rules share at 0.4 | rules surviving |
|-------------:|-------------------:|----------------:|
| 4,000 | 1,600 | 0 |
| 8,000 | 3,200 | 0 |
| 12,000 | 4,800 | 1 |

Zero to one rule at every stage, because the first rule alone never fits and
`break` fires immediately. This is documented intended behaviour —
`SPEC-context-budget-truth.md:166` asserts that an oversized first rule yields an
empty array. Any fraction low enough to protect non-floor chunks is lower than
the single largest rule.

No cap placed at file granularity can behave sensibly against a 3,485-token
atom. Sub-file granularity is a prerequisite, not an enhancement.

## Design

### 1. Section-level rule chunking

Split each rule file at `## ` (H2) boundaries. Content preceding the first H2
becomes an ordinal-0 preamble chunk. Each section inherits the file's `priority`,
`appliesTo`, `stages`, and `paths` unchanged, plus an ordinal preserving document
order for deterministic tie-breaking.

Chunk ids become `static-rules:<ruleId>#<section-slug>:<hash>`, remaining stable
across runs and collision-free by content hash. The slug is derived
deterministically from the heading text (lowercased, non-alphanumerics collapsed
to hyphens); duplicate headings within one file are disambiguated by their
ordinal, so id stability does not depend on heading uniqueness.

`forbidden-patterns.md` has 5 H2 sections (`Source Code`, `Prompt Builder
Convention`, `Test Files`, `Test-File Classification Convention`, `Test-Only
Helpers`) of roughly 160 to 1,100 tokens each — exactly the granularity a cap
needs.

Deliberate limits:

- **No splitting below H2.** If a single section exceeds the budget it is
  admitted whole with recorded overage. A rule is never gutted mid-sentence.
- **A file with no H2 yields exactly one chunk.** This is today's behaviour, so
  simple rule files see no change.
- **`rawScore` stays flat at 1.0.** Differential scoring of rule chunks depends
  on the effectiveness classifier, which is separately known to be biased rather
  than noisy (it saturates past roughly 250 diff lines). That is out of scope
  here; ordering is by priority, not score.

Because `canonical-loader.ts` (487 lines) and `static-rules.ts` (521 lines) both
have limited headroom under the 600-line `SRC_LIMIT`, the chunking logic lands in
a new module rather than growing either file.

### 2. Truncation policy

Contiguous-tail `break` is retained: longest leading run that fits, everything
after dropped. The refinement sections make possible is that the *boundary* file
contributes its leading sections instead of being dropped whole. Files before the
boundary are fully kept, files after are dropped, and the boundary file is
truncated at a section edge.

This preserves the documented contract exactly while removing the all-or-nothing
edge that makes the current cap unusable.

### 3. Per-stage enforced rules budget

`StaticRulesProvider.fetch` computes its budget from the request rather than the
constructor:

```
effective = min(rulesShare * request.budgetTokens, rules.budgetTokens)
```

`request.budgetTokens` is the stage budget and `request.stage` is the stage name;
both already arrive on `ContextRequest`, so this needs no new plumbing. The
existing global `rules.budgetTokens` (default 8,192) becomes an absolute upper
bound, keeping current configuration meaningful.

`rulesShare` is a new config key at `context.v2.rules.rulesShare`, with a
starting default of 0.4. `enforceBudget`, at the existing
`context.v2.rules.enforceBudget`, flips to `true` by default.

Bounding rules at the provider is sufficient for this arc even though
`packChunks` pass 1 stays unbounded: the floor pass can only admit chunks a
provider emitted, so once `StaticRulesProvider` caps its own output, the static
contribution to the floor is bounded regardless. The unbounded floor pass remains
a live issue for the `feature` and `test-coverage` kinds, which is why it is
listed as out of scope rather than as fixed.

**Honest sizing note.** At `rulesShare: 0.4` a 4,000-token stage gets 1,600
tokens of rules, which even with section chunking holds `forbidden-patterns`'
first section and little else. A 4,000-token stage genuinely cannot carry this
corpus. That is the finding, not a flaw in the design — the cap makes an existing
lie visible. What makes the corpus fit is section 4 below plus `appliesTo:` and
`stages:` scoping removing irrelevant rules *before* the cap is applied
(`static-rules.ts` filters, then budgets). The `budgetPressure` telemetry already
in place is how `rulesShare` gets tuned against real runs rather than guesswork.

### 4. Corpus hygiene

With section chunking, splitting files is no longer about size. It is about
scoping granularity: `appliesTo` and `stages` are per-file, so a file mixing
concerns can never be scoped to either.

- Split `forbidden-patterns.md` into `forbidden-patterns-source.md`
  (`appliesTo: src/**`) and `forbidden-patterns-tests.md` (`appliesTo: test/**`,
  plus the TDD and verify `stages:`).
- Add scoping frontmatter to the files that currently declare none:
  `config-patterns`, `error-handling`, `monorepo-awareness`,
  `project-conventions`, and the split halves. `monorepo-awareness` (2,645
  tokens) is the clearest win — it is dead weight in a single-package story and
  should carry `paths:`.
- Rebalance priorities so that lowest numbers are small files. Today the lowest
  number is the largest file, which is backwards under tail truncation.

Note that `resolveScopeFiles` (`src/pipeline/scope-files.ts`) unions PRD
`contextFiles` and `expectedFiles` with the git diff, so `appliesTo` is not inert
on a story's first assembly. It goes inert only when a story declares no files at
all.

### 5. `rules-setup` skill update

In the sibling repo `nax-toolkit-skills` (`main` @ `dbf9ef4`). Edit
`skills/rules-setup/SKILL.md`, then run `npm run sync:codex-skills` to mirror
into `plugins/nax-toolkit/skills/`. The two copies are currently byte-identical
and must stay so.

Four defects to correct:

1. **Size guidance measures the wrong unit.** Lines 34-37 and the checklist at
   line 262 specify 40-100 lines focused, 300 hard limit.
   `forbidden-patterns.md` is 172 lines and passes that check while consuming 87%
   of a stage budget. Replace with a token budget.
2. **The `priority` row omits the size invariant.** It says to use 30-50 for
   must-have rules without warning that a large must-have rule starves every rule
   after it under tail truncation. Must-have means small.
3. **The `appliesTo` row is stale.** It describes matching "files the story has
   actually changed (git diff at the time of context generation)". The real input
   is `scopeFiles`, the union of PRD `contextFiles`, `expectedFiles`, and the
   diff.
4. **`stages:` is entirely undocumented** despite shipping in #1463. Add it,
   along with guidance that each `## ` section is a packing unit.

## Testing

Behavioural tests only — real runtime cases, never grep or file-content
assertions.

Chunking: H2 splitting, ordinal-0 preamble, no-H2 files yielding exactly one
chunk, frontmatter inheritance onto every section, id stability across repeated
runs.

Budget: the `min(rulesShare * stage, global)` formula across the real stage
budget range; the boundary file contributing leading sections while later files
drop entirely; an oversized single section admitted whole with recorded overage.

The `enforceBudget: false -> true` flip is a behaviour change. Existing tests
asserting soft-mode passthrough must be updated deliberately, and the plan should
name them so the change is not mistaken for breakage.

Telemetry: extend `ProviderBudgetPressure` and `ProviderScopingReport` with
section-level counts, which is also the mechanism for tuning `rulesShare`.

## Out of scope

- `roles:` filtering, the remaining half of #822. Follow-on arc.
- Bounding the `feature` and `test-coverage` floor kinds in `packing.ts`. This
  design bounds rules at the provider; the packing-level floor for other kinds
  stays open and is tracked separately.
- Differential scoring of rule chunks, and the effectiveness classifier redesign
  it depends on.
- The v2 write path (capture, extract, summarize, promote) and `query_scratch`.

## Known adjacent defects, not fixed here

- `packing.ts`'s module docstring says the floor is "static + feature", omitting
  `test-coverage` which is in `FLOOR_KINDS`. Stale comment.
- `FRONTMATTER_PRIORITY_DEFAULT` is 100, the most-evictable value, so any rule
  authored without an explicit `priority:` is first out. Worth surfacing in the
  skill update rather than changing the default.
