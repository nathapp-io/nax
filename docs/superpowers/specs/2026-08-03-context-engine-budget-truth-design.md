# Context Engine v2 — Budget Truth and Rules Scoping (design)

**Date:** 2026-08-03 · **Repo state:** `main` @ `5cb48bd4` · **Origin:** finding 3 (+ residual of finding 4) of `nax-context-engine-v2-gap-analysis-2026-08-02.md`, execution-order item 3.

## Problem

Context v2 reports a token budget it does not enforce. Four independent defects compound:

1. **Rules bypass the budget.** `static` is a floor kind (`packing.ts:36`), and the floor pass adds `chunk.tokens` to `usedTokens` even when the chunk overflows (`packing.ts:98-108`). This repo's `.nax/rules/` store is 66 277 bytes ≈ 16.6k tokens against stage budgets of 8k–12k and claude's 16k `preferredPromptTokens`, so floor overage is the steady state, not an edge case. Every non-floor chunk — code neighbours, git history, session scratch — is then excluded with no log and no metric; the only trace is `reason: "budget-exceeded-by-floor"` inside the manifest.
2. **The rules trim is best-fit, not tail-biased.** `applyCanonicalRulesBudget` (`canonical-loader.ts:367-394`) `continue`s past any rule that does not fit and keeps scanning. Rules are sorted ascending by priority (`canonical-loader.ts:480-483`), so a large `priority: 10` rule is dropped while small `priority: 900` rules survive — the inverse of the docstring's stated "tail-biased truncation".
3. **Digest tokens are never reserved.** `digest.ts:12-14` states the orchestrator reserves them before packing; `orchestrator.ts:436` packs first and builds the digest at `:448`. `manifest-builder.ts:69` then reports `usedTokens + digestTokens`, so every bundle may exceed its budget by up to 250 tokens.
4. **`available-budget.ts` has an inverted guard and no tests.** `estimateAvailableBudgetTokens` (`:18`) returns `undefined` when the computed remainder is non-positive. `undefined` is the caller's signal for "no ceiling" (`packing.ts:83-84`), so the ceiling is removed at exactly the moment the prompt is largest.

### Root cause of the size, found during design

The engine already ships per-story rule scoping — `static-rules.ts:234` filters every rule through `ruleMatchesTouchedFiles(rule.appliesTo, request.touchedFiles)`, and `touchedFiles` is populated by both request builders (`stages/context.ts:104`, `stage-assembler.ts:193`). It is inert because **no rule in `.nax/rules/` declares `appliesTo:` or `paths:`** — all 11 files carry `priority:` alone, and both matcher functions early-return `true` for an unscoped rule.

Three of them had file scoping in `.claude/rules/` and lost it in migration:

| File | `.claude/rules/` | `.nax/rules/` |
|:--|:--|:--|
| `test-writing.md` | `paths: ["test/**/*.test.ts"]` | `priority: 100` |
| `test-architecture.md` | `paths: ["test/**/*.test.ts"]` | `priority: 50` |
| `adapter-wiring.md` | `paths: ["src/agents/**/*.ts", "src/operations/**/*.ts"]` | `priority: 60` |

The migrator bug that caused it is **already fixed**. `withReviewNotice` (`cli/rules.ts:216-231`) documents it precisely: the review notice is an HTML comment, frontmatter is recognised only at byte 0, so emitting the notice first pushed the frontmatter out of position and it was parsed as body text — losing the scope key on every file that both needed neutralizing and carried one. `translateLegacyFrontmatter` (`:202-214`) correctly rewrites legacy file-glob `paths:` to nax's `appliesTo:`. The store on disk was produced by the pre-fix migrator and never regenerated.

Consequence: a TDD-implementer story touching `src/config/loader.ts` is currently handed all four testing rules plus `adapter-wiring.md` — roughly 17k bytes ≈ 4.3k tokens of provably inapplicable text, on every stage of every story.

## Approach

Two parts, in order. Part A makes the accounting true; Part B removes tokens that were never relevant, using machinery that already exists.

Restoring scope is preferred over trimming because trimming drops rules that **do** apply, while scoping drops rules that **do not**. Trimming remains available as a later safety net once the post-scoping payload can be measured.

### Part A — engine truth

Scope boundary worth stating plainly: after Part A the budget is **truthfully accounted and visibly exceeded**, not enforced against the floor. Floor chunks are still always included (spec AC-6). Enforcement against the floor is the deferred floor-share work; Part B is the attempt to make it unnecessary.

**A1. Fix and test `estimateAvailableBudgetTokens`.**
Return `0` (a real ceiling of zero) rather than `undefined` when the remainder is non-positive, and let callers treat a zero ceiling as "floor only". `undefined` remains reserved for "caller supplied no prompt to measure against". This file computes the ceiling every other budget fix depends on and currently has no test file at all.

**A2. Make `applyCanonicalRulesBudget` tail-biased.**
Replace the `continue` at `canonical-loader.ts:383` with a `break`. Because the input is already sorted ascending by priority, stopping at the first non-fitting rule preserves the highest-priority prefix and drops a contiguous tail, matching the docstring. `droppedCount` semantics are unchanged.

**A3. Reserve digest tokens before packing.**
Subtract a `DIGEST_RESERVE_TOKENS` constant (derived from `MAX_DIGEST_CHARS`, not a second magic number) from `effectiveBudgetTokens` at `orchestrator.ts:269`, before the fetch loop and before `packChunks`. Additionally correct the accounting: the tokens actually carried in the emitted prompt are `packed + priorStageDigest` (`render.ts:50-51`), whereas `manifest-builder.ts:69` adds the digest this stage *produces*. Account the digest that is spent.

**A4. Surface floor overage.**
When `floorOverageIds` is non-empty, emit a WARN with `storyId` first (per the structured-logging rule) carrying stage, budget, floor tokens, overage, and the count of chunks excluded as a result, and record the overage on `StoryMetrics.context`. Part B is expected to make this rare; the metric is how we find out whether it did. `packing.ts` behaviour is unchanged — floor chunks are still always included, so spec AC-6 stands.

### Part B — restore rule scoping

**B1. Declare `appliesTo:` across `.nax/rules/`.**
Restore scope on the three files that lost it, preserving their current `priority:` values (a bulk `nax rules migrate --force` would emit `appliesTo:` correctly but wipe the hand-added priorities, since the `.claude/rules/` sources carry none — this is a hand-merge, three files). Then audit the remaining eight and declare scope only where it is genuinely narrow; a rule that really is global stays unscoped rather than acquiring a fictional glob.

**B2. Make `nax rules lint` validate scope keys.**
Reject unknown frontmatter keys, malformed globs, and globs that match nothing in the repo, and add the migrate→lint round-trip test that does not currently exist. This is the guard that stops a future lossy migration from passing silently — the failure mode that produced the current state.

**B3. Document rule authoring and migration.**
Extend `docs/guides/static-rules.md`: what `priority`, `paths`, and `appliesTo` each mean; the package-scope-versus-file-glob trap that `translateLegacyFrontmatter` documents; and how to verify after a migration that scope survived.

## Verification

Behavioural, executable anchors only — no grep or file-content assertions.

| Change | Anchor |
|:--|:--|
| A1 | Call `estimateAvailableBudgetTokens` with a prompt large enough to exhaust the profile window; assert the returned ceiling constrains a subsequent `packChunks` call instead of removing the ceiling. |
| A2 | Build a rule set whose first rule exceeds the budget and whose later, lower-priority rules would fit; assert the result keeps the priority-ordered prefix and that the previously-surviving low-priority rule is absent. Mutation check: reverting `break` to `continue` must fail it. |
| A3 | Assemble with a known `priorStageDigest`; assert the rendered bundle's token count does not exceed the requested budget, and that the manifest's `usedTokens` matches what the prompt actually carries. |
| A4 | Assemble with an oversized floor; assert the metric records the overage and a WARN is emitted. Assert packed chunks are unchanged versus today (AC-6 regression guard). |
| B1 | Through `StaticRulesProvider.fetch` against a fixture store: a request whose `touchedFiles` are all source files receives no test-scoped rule; a request touching a test file does. |
| B2 | Run the lint command against a fixture root containing an unknown key and a dead glob; assert non-zero exit and that both are reported. Separately, migrate a legacy rule that both needs neutralizing and carries `paths:`, then lint the output and assert the scope survived. |

## Out of scope

Stated explicitly so the boundary is not re-litigated mid-implementation:

- **Floor-share trimming** (capping the rules floor at a configured fraction of the stage budget, e.g. `floorShareRatio: 0.7`). Designed and deliberately deferred until Part B's effect can be measured. It is lossy by construction and may prove unnecessary.
- **Budgeting the legacy fallback path** (`static-rules.ts:329-414`), which loads CLAUDE.md, `.cursorrules`, AGENTS.md and every `.claude/rules/**` file unbudgeted while logging that it prefers the first. Left as-is by decision. **Known risk:** the unbudgeted path remains live for exactly those repos that have not migrated to `.nax/rules/`.
- **AC-7's 5%-of-optimal packing bound** (knapsack repair or the property test the spec calls for) — residual of gap-report finding 4.
- **Pull-based rules.** Rejected as a primary mechanism: rules are largely prohibitions, and an agent cannot know to ask whether something is forbidden before doing it, so a missed pull is a silently violated convention. A push-an-index / pull-the-body hybrid remains plausible for reference-grade rules only, and needs its own design.
- **The general per-provider soft budget** (`fetch(req, softBudgetTokens)`, gap-report finding 10) and its proportional-allocation policy (AC-15/AC-33).
- Scoring-axis drift from finding 4 (role weights, the absent `freshness` axis, per-stage kind weights, the semantic kind taxonomy).

## Risks

- **B1 changes what agents see.** A rule that is scoped too narrowly stops reaching a story that needed it, and the failure is silent — it surfaces as a convention violation and a rectify cycle, not an error. Mitigation: scope conservatively, leave genuinely global rules unscoped, and rely on A4's metric plus the effectiveness signal to catch over-scoping.
- **A3 reduces the effective budget by ~250 tokens** for every assembly. That is the correct number, but it marginally increases non-floor exclusions until Part B lands.
- **A2 changes which rules survive truncation** on any repo whose store exceeds the rules budget. The new behaviour matches the documented intent; the old behaviour did not.

## Open items carried forward

- Re-verify gap-report findings 5, 6 and 7 at HEAD before building on them (findings 5 and 6 were re-confirmed on 2026-08-03; finding 7's `pullCalls` absence was re-confirmed by grep).
- The gap report's Tier-1 claims were hand-verified at `e64355f1`, two merges before this design. Anything not re-checked here should be re-probed before it becomes a story.
