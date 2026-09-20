# Delete the Debate Subsystem and the Pipeline Plan Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the multi-agent debate subsystem and the asymmetric pipeline plan mode from nax, leaving `single` and `refine` as the two plan modes.

**Architecture:** Debate and pipeline are one entangled cluster, not two. The grounder → draft → critic machinery lives under `src/debate/` but is driven by `PipelinePlanStrategy`; the debate runner in turn calls `groundOp` as a pre-phase and `citations`/`facts-manifest` in its selectors and verifiers. Neither mode is the default, neither is enabled in any live config, and each depends on the other's files — so they come out together, in one deletion PR, followed by a config/docs/baselines PR. There is nothing to preserve and no module to relocate.

**Tech Stack:** TypeScript on Bun, Zod config schemas, Biome lint, custom `scripts/check-*.ts` gates with JSON baselines.

**Spec:** None — this is a deletion authorised directly by the repo owner. This plan document is the specification. The investigation findings that justify each deletion are recorded under "Findings" below.

**Branch topology:** Both PRs land on one integration branch, which is then merged to `main` as a single unit.

```
main
 └── feat/delete-debate                      <- integration branch; holds this plan
      ├── chore/delete-debate-source         <- PR 1, targets feat/delete-debate
      └── chore/delete-debate-config-docs    <- PR 2, cut AFTER PR 1 merges, targets feat/delete-debate
```

`feat/delete-debate` already exists in the worktree at `.worktrees/delete-debate`, branched from `origin/main` @ `f4b3bbc7a`, carrying this plan document and nothing else.

The two PRs are **sequential, not concurrent**: PR 2's tasks edit config guards, docs and baselines that only make sense once PR 1's deletions have landed, and cutting PR 2 before PR 1 merges would give it a diff full of PR 1's changes. Merge PR 1 into `feat/delete-debate` first, then cut PR 2 from the updated integration branch.

One worktree is enough for the whole arc — the branches are worked one after another, so `git checkout -b` inside `.worktrees/delete-debate` is all that is needed. Do not create additional worktrees.

**Final merge:** `feat/delete-debate` → `main` as one PR (Task 8), after both sub-PRs have merged and the full gate run is green on the integration branch itself — not merely on each sub-PR in isolation.

---

## Global Constraints

- **Repo test commands only.** `bun run test`, `bun run test:unit`, `bun run test:e2e`, `bun run typecheck`, `bun run check:all`, `bun run test:coverage`. **Never** bare `bun test` on the whole suite and **never** `bun run nax` — both give confident false signals. (`bun test <single-file>` for a focused TDD loop is fine and is used below.)
- **`typecheck` is NOT in `check:all`.** Run `bun run typecheck` explicitly at the end of every task. Only `tsc` catches a declared-but-unwired field.
- **`test:coverage` is NOT in `check:all`.** Run it after any task that adds or removes a `src/` file.
- Prefix every git command with `RTK_DISABLED=1` (the rtk hook rewrite is blocked in worktrees).
- File-size gate: 600 lines hard cap, enforced by `check:file-sizes`. Deletions only shrink files, but stale baseline entries must go in PR 2.
- `.claude/rules/` is a **generated mirror** of `.nax/rules/` (pre-commit enforced via `check:rules-drift`). Edit `.nax/rules/` only; never hand-edit the mirror.
- Conventional commits. No emojis in code, comments or docs.
- Do not push or open a PR without explicit approval at that moment.

---

## Findings this plan rests on

Re-verified on `origin/main` @ `f4b3bbc7a` on 2026-09-20.

### Neither mode is reachable without an explicit opt-in

`resolvePlanMode` (`src/cli/plan-command.ts:41`) returns `config.plan.mode` when set, else `"debate"` when `debate.enabled && debate.stages.plan.enabled`, else `"single"`.

| Mode | What its strategy calls | Enabled where |
|---|---|---|
| `single` (default) | `planInteractiveOp` only | everywhere by default |
| `refine` | `planRefineOp` only | this repo's own `.nax/config.json` sets `plan.mode: "refine"` |
| `pipeline` | `groundOp` + `planDraftOp` + `runPlanCritic` + citations + checks + spec-deltas | **no live config** |
| `debate` | the debate engine, plus `groundOp` as a pre-phase | **no live config** (`debate.enabled` defaults `false`) |

`src/plan/strategies/single.ts` (64 lines) and `refine.ts` (74 lines) import none of the grounding, citation, critic or manifest machinery. Verified by reading their complete import lists.

### The two clusters are mutually entangled — they cannot be split into two PRs

- `src/debate/pre-phase/grounder.ts` calls `groundOp` from `src/operations/ground.ts` (pipeline's op).
- `src/debate/selectors/verifier-pick.ts` calls `citationDistribution` from `src/debate/citations.ts` (pipeline's citation accounting).
- `src/debate/verifiers/plan-checklist.ts` calls `parseFactsManifest` and `formatSpecDeltas` (pipeline's manifest and spec-deltas).
- `src/plan/strategies/pipeline.ts:1-2` imports `renderManifestSection` and `FactsManifest` from `@/debate`.

Deleting either half first leaves the other uncompilable. Hence one deletion PR.

### The review half was already dead before this plan

- Review-stage debate config was retired in #1859 — `src/config/config-guards.ts:218-219`.
- The `review-dialogue` context stage is declared but never assembled — `src/context/engine/stage-config.ts:320-324`, "there is no dispatch seam" (nax#1743, nax#1758).
- `DebatePromptBuilder.buildReviewPrompt` / `buildReReviewPrompt` / `buildResolverPrompt` / `buildReResolverPrompt` / `buildClosePrompt` have **zero production callers** — tests only. The live `buildReviewPrompt` used by `src/operations/finish-review.ts` is a different function in `src/finish/review/prompt.ts`.

### `runPlanPipeline` is already orphaned

`src/cli/plan-command.ts:143-285` duplicates `PipelinePlanStrategy`. `planCommand` reaches the pipeline through `createPlanStrategy(mode)`, never through `runPlanPipeline`. Its only callers are `test/unit/cli/plan.test.ts` and the barrel re-exports in `src/cli/plan.ts` / `src/cli/index.ts`.

### What survives, and why (do not delete these)

| Module | Why it stays |
|---|---|
| `PlanPromptBuilder` (`src/prompts/builders/plan-builder.ts`) | `build`, `jsonRepair`, `schemaRepair`, `buildRefineContinuation`, `buildSpecDriftRepair`, `buildOutOfScopeRepair` are used by `operations/plan.ts` and `operations/plan-refine.ts`. Only `buildDraft`, `citationRepair` and `PlanDraftBuildInput` are pipeline-only — **trim, do not delete the file** |
| The hardening pass (`src/acceptance/hardening.ts`) and `PRD.userStories[].suggestedCriteria` | `suggestedCriteria` is instructed on the **non-debate** plan path too — `src/config/test-strategy.ts:228`. Only the "Debater-suggested" comment wording changes |
| `persist-prd.ts`, `write-prd.ts`, `assert.ts`, `plan-fidelity.ts`, `spec-lint-gate.ts` | Used by the surviving `single` and `refine` strategies |
| `groundOp`'s sibling ops `plan.ts`, `plan-refine.ts`, `plan-fidelity.ts` | The surviving plan paths |

### Scale

- Debate: 44 files / 5,012 LOC under `src/**/*debate*`.
- Pipeline-only cluster: 1,372 LOC across 11 files.
- `runPlanPipeline`: ~140 lines.
- 113 test files reference debate; the dedicated debate test tree alone is 15,338 LOC.

---

## Decisions taken (state these in the PR bodies)

1. **One deletion PR, not two.** The two clusters do not compile apart (see Findings). PR 1 deletes source and tests together; PR 2 handles config guards, docs, rules and baselines.
2. **Retired config keys warn-and-strip, they do not throw.** This follows the #1859 precedent already implemented in `stripRemovedNoOpKeys` (`src/config/config-guards.ts`): a throw would hard-fail every existing config carrying an inert key, with no behaviour change to show for it. Applies to the `debate` block, `plan.citationThreshold` and `plan.criticModel`.
3. **`plan.mode: "debate"` and `plan.mode: "pipeline"` are rejected by a dedicated guard, not just by the Zod enum.** Unlike the inert keys above, these were **not** inert — a user who set either was getting that strategy, and silently downgrading them to `single` would change their plan output without telling them. The repo already distinguishes these two cases and this plan follows it: an *inert* key removal goes through `stripRemovedNoOpKeys` (warn and strip), while a *behaviour-changing* removal gets a `reject*` guard that throws before `safeParse` with a bespoke migration message — see `rejectLegacyAgentKeys`, `rejectLegacyRectificationKeys` and `rejectDeadQualityFlags` in `src/config/config-guards.ts`. A bare Zod enum error would say only `plan.mode: Invalid option: expected one of "single"|"refine"`, which names the survivors but explains neither why the mode vanished nor what to do. Task 5 adds `rejectRemovedPlanModes` alongside the enum narrowing.
4. **Nothing is relocated.** An earlier draft of this plan lifted `facts-manifest`, `citations` and `verifiers/checks` into `src/plan/grounding/`. With pipeline mode also going, those three modules have no surviving consumer and are deleted outright. Do not reintroduce the move.
5. **Grounded planning is retired, by the owner's ruling (2026-09-20): "no more grounding for plan, only single or refine."** After this change nax does not ground a plan against a facts manifest and does not measure citation rate. This is a deliberate scope reduction, not an oversight — do not preserve, stub, or reintroduce any part of the grounder/draft/critic cluster "just in case". Reviving evidence-grounded planning later is a rebuild, not a revert, and this plan's PR bodies must say so plainly.

---

## Task 0: Preflight

Do not skip this. It re-derives every precondition from the real tree rather than trusting this document.

- [ ] **Step 1: Confirm the worktree and base**

```bash
cd .worktrees/delete-debate
RTK_DISABLED=1 git branch --show-current   # expect: feat/delete-debate
RTK_DISABLED=1 git log --oneline origin/main..HEAD   # expect: only the plan-document commits
bun install
```

If the branch is anything other than `feat/delete-debate`, or if there are
non-documentation commits ahead of `origin/main`, **stop and report** — the
integration branch is meant to hold the plan and nothing else until PR 1 merges
into it.

- [ ] **Step 2: Confirm the baseline is green before changing anything**

```bash
bun run typecheck && bun run check:all && bun run test
```

Expected: all pass. If anything is red on clean `origin/main`, **stop and report** — do not delete on top of a red baseline.

- [ ] **Step 3: Re-confirm `single` and `refine` are clean of the cluster**

```bash
grep -n '^import' src/plan/strategies/single.ts src/plan/strategies/refine.ts
```

Expected: no import of `ground`, `plan-draft`, `critic`, `citations`, `facts-manifest`, `spec-deltas` or anything under `@/debate`. If one appears, **stop and report** — the reachability finding this whole plan rests on has changed.

- [ ] **Step 4: Re-confirm `runPlanPipeline` is still orphaned**

```bash
grep -rn 'runPlanPipeline' src bin scripts --include='*.ts'
```

Expected: only its definition in `src/cli/plan-command.ts` and the two barrel re-exports (`src/cli/plan.ts`, `src/cli/index.ts`). A real caller means **stop and report**.

- [ ] **Step 5: Re-confirm the review-dialogue half is still dead**

```bash
for m in buildReviewPrompt buildReReviewPrompt buildResolverPrompt buildReResolverPrompt buildClosePrompt; do
  echo -n "$m: "; grep -rn "\.$m(" src --include='*.ts' | wc -l
done
```

Expected: `0` for every one.

- [ ] **Step 6: Record the pre-deletion measurements** (for the PR body)

```bash
RTK_DISABLED=1 git ls-files src | xargs wc -l | tail -1
RTK_DISABLED=1 git ls-files test | xargs wc -l | tail -1
```

---

# PR 1 — Delete the debate subsystem and the pipeline plan mode

**Branch:** `chore/delete-debate-source`, cut from `feat/delete-debate`. **PR base: `feat/delete-debate`, not `main`.**

Cut it before Task 1:

```bash
RTK_DISABLED=1 git checkout feat/delete-debate
RTK_DISABLED=1 git checkout -b chore/delete-debate-source
```

Four commits. Each task's verification is cumulative; `bun run typecheck` is not expected to pass until Task 3 is complete, so do not treat a red typecheck in Tasks 1-2 as a failure.

### Task 1: Delete the source files

**Files — delete outright (34 + 16 files):**

```
src/debate/                                   (whole directory, 33 files)
src/operations/debate-hybrid.ts
src/operations/debate-judge.ts
src/operations/debate-plan.ts
src/operations/debate-propose.ts
src/operations/debate-rebut.ts
src/operations/debate-stateful.ts
src/operations/debate-synthesis.ts
src/operations/ground.ts
src/operations/plan-draft.ts
src/operations/plan-critic-llm.ts
src/plan/strategies/debate.ts
src/plan/strategies/debate-composition.ts
src/plan/strategies/pipeline.ts
src/plan/critic.ts
src/plan/draft-citations.ts
src/plan/spec-deltas/
src/prompts/builders/debate-builder.ts
src/prompts/builders/critic-builder.ts
src/config/schemas-debate.ts
```

- [ ] **Step 1: Delete**

```bash
RTK_DISABLED=1 git rm -r src/debate src/plan/spec-deltas
RTK_DISABLED=1 git rm src/operations/debate-hybrid.ts src/operations/debate-judge.ts \
  src/operations/debate-plan.ts src/operations/debate-propose.ts \
  src/operations/debate-rebut.ts src/operations/debate-stateful.ts \
  src/operations/debate-synthesis.ts \
  src/operations/ground.ts src/operations/plan-draft.ts src/operations/plan-critic-llm.ts
RTK_DISABLED=1 git rm src/plan/strategies/debate.ts src/plan/strategies/debate-composition.ts \
  src/plan/strategies/pipeline.ts src/plan/critic.ts src/plan/draft-citations.ts
RTK_DISABLED=1 git rm src/prompts/builders/debate-builder.ts src/prompts/builders/critic-builder.ts
RTK_DISABLED=1 git rm src/config/schemas-debate.ts
```

- [ ] **Step 2: Capture the breakage list**

```bash
bun run typecheck 2>&1 | tee /tmp/delete-debate-typecheck.txt
grep -oE '^[^(]+' /tmp/delete-debate-typecheck.txt | sort -u
```

Expected: FAIL, naming the files Task 2 and Task 3 edit. **Use this output as the authoritative worklist** — it beats the tables below, which were written on 2026-09-20 and may have drifted.

- [ ] **Step 3: Do not commit yet.** The tree does not compile. Commit at the end of Task 3.

### Task 2: Repair the plan and CLI call sites

**Files:**
- Modify: `src/cli/plan-command.ts`, `src/cli/plan.ts`, `src/cli/index.ts`, `src/cli/plan-runtime/index.ts`, `src/cli/plan-decompose.ts`, `src/plan/index.ts`, `src/plan/strategies/{index,factory,types}.ts`, `src/operations/index.ts`, `src/prompts/index.ts`, `src/prompts/builders/plan-builder.ts`

**Interfaces:**
- Produces: `resolvePlanMode(config: NaxConfig): "single" | "refine"`, `IPlanStrategy["mode"]: "single" | "refine"`. Every consumer of the four-arm union must narrow to these two.

- [ ] **Step 1: Narrow `resolvePlanMode` and delete `runPlanPipeline`**

In `src/cli/plan-command.ts`, replace the doc comment and function at lines 34-46 with:

```ts
/**
 * Resolution order:
 * 1. config.plan.mode (explicit user override)
 * 2. single (default)
 */
export function resolvePlanMode(config: NaxConfig): "single" | "refine" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  return "single";
}
```

Then delete the `// Pipeline mode — US-005` banner comment at **line 136** through the closing brace of `runPlanPipeline` at **line 281**.

⚠️ **Do not delete to end of file.** `plan-command.ts` is 281 lines of body plus a live re-export at **283-285**:

```ts
// Re-exports for backward compatibility — planDecomposeCommand and runReplanLoop
// were extracted to plan-decompose.ts to keep plan.ts under the 600-line limit.
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
```

That re-export **must survive** — `src/cli/plan.ts` and `src/cli/index.ts` both depend on it. Confirm after the edit:

```bash
grep -n 'planDecomposeCommand' src/cli/plan-command.ts   # expect the re-export, still present
```

Delete the now-unused imports at the top of the file: `renderManifestSection` from `../debate` (line 13), `PlanDraftInput` from `../operations` (line 15), `callOp, groundOp, planDraftOp` from `../operations` (line 16), and the `buildPlanComposition` re-export (line 21). Keep `assertIsValidPrd`.

- [ ] **Step 2: Fix the CLI barrels**

`src/cli/plan.ts` — delete `buildPlanComposition` and `runPlanPipeline` from the export list.

`src/cli/index.ts:52` — becomes:

```ts
export { _planDeps, planCommand, resolvePlanMode } from "./plan";
```

`src/cli/plan-runtime/index.ts` — delete the `DebateRunner` / `DebateRunnerOptions` import (lines 15-16) and the `createDebateRunner` dep (line 106).

`src/cli/plan-decompose.ts` — three separate edits, **not one contiguous range**:

1. Line 16 — delete the `DebateStageConfig` import.
2. Lines **105-106** — delete the two `const` declarations:
   ```ts
   const debateStages = config?.debate?.stages as unknown as Record<string, DebateStageConfig | undefined>;
   const debateDecompEnabled = config?.debate?.enabled && debateStages?.decompose?.enabled;
   ```
3. Lines **113-150** — delete the whole `if (attempt === 0 && debateDecompEnabled) { ... }` block, from the `if` on line 113 through its closing `}` on line 150.

⚠️ Do **not** delete 105-150 as one range: lines 108-112 in between hold `let decompStories`, `let repairHint`, the `try {` and the `for` loop header, all of which the surviving path needs.

After the edit, `if (!decompStories) {` (was line 152) becomes the first statement in the loop body. That is correct — `decompStories` can still be set by a previous attempt, so the guard stays meaningful and the retry accounting is unchanged. Do not "simplify" it away.

Verify the block boundaries yourself before cutting, since line numbers drift:

```bash
grep -n 'debateDecompEnabled\|let decompStories\|if (!decompStories)' src/cli/plan-decompose.ts
```

- [ ] **Step 3: Rewrite `src/plan/index.ts`**

The whole file becomes:

```ts
export { assertSpecLintClean, type SpecLintGateOptions } from "./spec-lint-gate";
export {
  _refinePlanDeps,
  _singlePlanDeps,
  assertIsValidPrd,
  buildPlanModeContext,
  createPlanStrategy,
  finalizePrdRouting,
  RefinePlanStrategy,
  SinglePlanStrategy,
  writeOrRecoverPrd,
} from "./strategies";
```

- [ ] **Step 4: Fix the strategy barrel, factory and types**

`src/plan/strategies/index.ts` — delete the `_debatePlanDeps`, `DebatePlanStrategy`, `buildPlanComposition`, `_pipelinePlanDeps` and `PipelinePlanStrategy` exports.

`src/plan/strategies/factory.ts` becomes:

```ts
import { NaxError } from "@/errors";
import { RefinePlanStrategy } from "./refine";
import { SinglePlanStrategy } from "./single";
import type { IPlanStrategy } from "./types";

export function createPlanStrategy(mode: IPlanStrategy["mode"]): IPlanStrategy {
  switch (mode) {
    case "single":
      return new SinglePlanStrategy();
    case "refine":
      return new RefinePlanStrategy();
    default:
      throw new NaxError(`[plan] Unknown plan mode: ${mode}`, "PLAN_MODE_UNKNOWN", {
        stage: "plan",
        mode,
      });
  }
}
```

`src/plan/strategies/types.ts` — delete the `DebateRunner`/`DebateRunnerOptions` import (line 4), delete `createDebateRunner` from `PlanCommandOptions` (line 30), and narrow line 77:

```ts
  readonly mode: "single" | "refine";
```

- [ ] **Step 5: Fix the operations barrel**

`src/operations/index.ts` — delete the seven `debate-*` export blocks (lines 31-42), the `groundOp` export (line 85), and the `PlanDraftInput` / `PlanDraftOutput` exports (line 116).

- [ ] **Step 6: Trim `PlanPromptBuilder`, do not delete it**

In `src/prompts/builders/plan-builder.ts` (561 lines) delete **exactly these four spans**, verified against the tree on 2026-09-20:

| Span | Symbol |
|---|---|
| 80-86 | doc comment + `export interface PlanDraftVerifierFinding` |
| 88-105 | doc comment + `export interface PlanDraftBuildInput` — it runs to line 105, **not 96**: past `citationThreshold` it also carries `revisionFindings`, `packages`, `packageDetails`, `projectProfile` and `profiles` |
| 170-183 | doc comment + `static citationRepair` |
| 423-530 | doc comment + the whole `buildDraft` method |

⚠️ Three adjacency traps in this file:

1. **Line 531 is the class's closing `}`** — `buildDraft` ends at 530. Take 531 and the class never closes.
2. **`PackageSummary` starts at line 107**, immediately after `PlanDraftBuildInput`. It is exported from `src/prompts/index.ts` and used by `plan-command.ts` and `plan-helpers.ts`. It **stays**.
3. **`buildFileReadInstruction` (line 540) and `buildPackageDetailsSection` (line 552)** are module-level helpers below the class. They look like `buildDraft`'s private helpers but `build()` also calls them, at lines 357 and 320. They **stay**.

`PlanDraftVerifierFinding` is safe to remove: its only reference is `PlanDraftBuildInput:96`, which dies with it.

Keep `build`, `jsonRepair`, `schemaRepair`, `buildRefineContinuation`, `buildSpecDriftRepair`, `buildOutOfScopeRepair` — `operations/plan.ts` and `operations/plan-refine.ts` call them. Verify before deleting each member:

```bash
grep -rn 'citationRepair\|buildDraft\|PlanDraftBuildInput\|PlanDraftVerifierFinding' src --include='*.ts'
```

Expected after the trim: zero hits. Then confirm the survivors are intact:

```bash
grep -n 'PackageSummary\|buildFileReadInstruction\|buildPackageDetailsSection' src/prompts/builders/plan-builder.ts
```

Expected: the `PackageSummary` interface and both helpers still present, with `build()` still calling them.

`src/prompts/index.ts` — delete the `DebatePromptBuilder` export and the `PromptBuilderOptions` / `ReviewStoryContext` / `StageContext` type re-exports (lines 24-26). These three types are declared in the deleted `debate-builder.ts` and have no other consumer; confirm with `grep -rn 'ReviewStoryContext\|PromptBuilderOptions' src --include='*.ts'` (expect zero). Note `StageContext` is **not** the same as `StageContextConfig` in `src/context/engine/stage-config.ts`, which stays.

### Task 3: Repair the config, context, runtime and comment call sites

**Files:**

| File | Change |
|---|---|
| `src/config/schemas.ts:11,363-…` | Delete the `DebateConfigSchema` import and the entire `debate:` field with its default block |
| `src/config/schemas-infra.ts:17` | `mode: z.enum(["single", "refine"]).optional()`. Also delete `citationThreshold` (line 19) and `criticModel` (line 21) from `PlanConfigSchema` |
| `src/config/index.ts:2-9,82,126` | Delete the `debate/types` re-exports, the `DebateConfigSchema` export, `debateConfigSelector` |
| `src/config/types.ts:8-17` | Delete the `debate/types` re-export block |
| `src/config/schema.ts:10-19` | Delete the `debate/types` re-export block |
| `src/config/runtime-types.ts:280,489-498,561-562` | Narrow `mode` to `"single" \| "refine"`; delete the `debate/types` re-export block; delete the `debate?:` field |
| `src/config/selectors.ts:19,26,46,165` | Remove `"debate"` from the key list and from `planConfigSelector`'s picks; delete `debateConfigSelector` and the `DebateConfig` type |
| `src/context/engine/stage-config.ts:312-331` | Delete both stage entries **and their doc comments**: from `// Review dialogue — reviewer role.` (line 312) through the `},` closing the `debate` entry (line 331). Deleting only 318-331 would strand lines 312-317 as an orphaned comment about a stage that no longer exists. Leave the `satisfies` clause and the `StageKey` derivation intact |
| `src/runtime/session-role.ts` | **Larger than it looks — see "Six orphaned session roles" below.** Delete the `` `debate-${string}` `` arm (line 39) and the `startsWith("debate-")` predicate (line 74), **and** six now-dead roles from both `CanonicalSessionRole` and `KNOWN_SESSION_ROLES` |

- [ ] **Step 1: Work the config and context edits until typecheck is clean**

Apply the table. Re-run `bun run typecheck` after every two or three files — do not batch blind.

- [ ] **Step 1b: Remove the six orphaned session roles**

`tsc` will **not** catch these. An unused member of a string-literal union
compiles cleanly, so the only thing standing between this deletion and six
permanently dead roles is this step.

`src/runtime/session-role.ts` declares every role twice — in the
`CanonicalSessionRole` union and again in the `KNOWN_SESSION_ROLES` array. Six of
them have their **only** producers inside files Task 1 deleted:

| Role | Sole producer, now deleted |
|---|---|
| `grounder` | `src/operations/ground.ts:157` (`session: { role: "grounder" }`) |
| `plan-draft` | `src/operations/plan-draft.ts:178` |
| `plan-revise` | `src/plan/critic.ts:109` (`sessionOverride: { role: "plan-revise" }`) |
| `plan-critic` | `src/operations/plan-critic-llm.ts:81` |
| `synthesis` | `src/debate/session-helpers.ts:172`, `selectors/registry.ts:27` |
| `judge` | `src/debate/session-helpers.ts:172`, `selectors/registry.ts:30` |

Delete each from **both** places, plus the `` `debate-${string}` `` arm and the
`startsWith("debate-")` predicate. `SessionRole` then collapses to
`CanonicalSessionRole` — replace the alias rather than leaving a one-arm union:

```ts
export type SessionRole = CanonicalSessionRole;

export function isSessionRole(s: string): s is SessionRole {
  return (KNOWN_SESSION_ROLES as readonly string[]).includes(s);
}
```

Prove each role is orphaned before removing it — do not take the table on trust:

```bash
for r in grounder plan-draft plan-revise plan-critic synthesis judge; do
  echo "== $r"; grep -rn "\"$r\"" src --include='*.ts' | grep -v session-role.ts
done
```

Expected: no hits for any of the six. A hit means a producer survived — **stop
and report** rather than removing a live role.

**Blast radius, checked:** `KNOWN_SESSION_ROLES` feeds `deriveSessionRole` in
`src/runtime/usage-auditor.ts:69-86`, which labels telemetry rows by matching a
*live* session name at write time. It does not parse historical artifacts, so
shrinking the list cannot make old run data unreadable. `isSessionRole` is
re-exported from `src/runtime/index.ts:81` and `src/session/types.ts:14`; both
are pass-throughs and need no edit.

Roles that stay because their producers survive: `plan` (`operations/plan.ts`)
and `plan-refine` (`operations/plan-refine.ts`). Do not remove those.

- [ ] **Step 2: Fix the comments that now point at nothing**

These files mention debate or the pipeline only in prose. A comment naming a subsystem that no longer exists is a trap for the next reader — **rewrite each to describe current behaviour, do not just delete the sentence.**

```bash
grep -rin 'debate\|pipeline mode\|runPlanPipeline' src --include='*.ts'
```

The known ones as of 2026-09-20:

| File:line | What to say instead |
|---|---|
| `src/acceptance/hardening.ts:2` | "Hardening Pass — test plan-suggested criteria after acceptance passes." The mechanism survives; only its provenance changed |
| `src/prd/types.ts:172` | "Criteria the planner suggested beyond the spec — tested in hardening pass, never blocks pipeline." |
| `src/config/test-strategy.ts:219-220` | Drop the "Mirrors the synthesis anchor in src/debate/runner-plan-helpers.ts" cross-reference; this file is now the sole home of that wording. Say so |
| `src/review/acks.ts:22` | Keep the #1859 history but drop the "deleted `semantic-debate.ts`" framing that now needs two deletions of context to parse |
| `src/agents/manager-types.ts:305-321` | Re-describe the two completion entry points without "debate debaters" / "debate resolvers" |
| `src/agents/types.ts:221` | The guarded-path list loses `debate-plan`; check what remains and list it accurately |
| `src/prd/schema-story.ts:229-230` | **Comment only — keep the code.** See "Resolved: the `testStrategy` auto-correct stays" below. Rewrite the comment so it no longer attributes the contradiction to debate synthesis: any LLM-authored PRD can populate `noTestJustification` while leaving `testStrategy` set to something else |
| `src/prd/workdir-canonical.ts:86` | Drop the `src/debate/verifiers/checks.ts` cross-reference |
| `src/cli/confirm.ts:32`, `src/operations/call-resolvers.ts:117`, `src/operations/implement.ts:86`, `src/operations/plan-fidelity.ts:180`, `src/plan/strategies/persist-prd.ts:6`, `src/prompts/builders/plan-builder.ts:8`, `src/prompts/builders/adversarial-review-builder.ts:270`, `src/prompts/builders/rectifier-builder.ts:767`, `src/review/{types.ts:47,62,70, semantic-helpers.ts:63}`, `src/runtime/{dispatch-context.ts:8, usage-auditor.ts:77}`, `src/agents/complete-exception-classifier.ts:20`, `src/config/{schema-types.ts:189, config-profile.ts:31}`, `src/pipeline/stages/acceptance.ts:394` | Drop the debate mention; keep the surrounding point |

Note `src/operations/plan-fidelity.ts:180` says "the four plan strategies (single, refine, pipeline, debate)" — it must now say two.

- [ ] **Step 3: Verify the source tree is clean**

```bash
grep -rin 'debate' src --include='*.ts'
bun run typecheck
```

Expected: zero grep hits, typecheck passes.

- [ ] **Step 4: Commit the source deletion**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "refactor: delete the debate subsystem and the pipeline plan mode

Removes src/debate/, the seven debate operations, the debate and
pipeline plan strategies, the grounder/draft/critic operations, the
citation and spec-deltas modules, DebatePromptBuilder, the critic prompt
builder, the debate config schema, and the orphaned runPlanPipeline.

Both modes were opt-in and enabled in no live config. Only pipeline mode
reached the grounder, draft, critic, citation and spec-deltas cluster:
single and refine call planInteractiveOp and planRefineOp and nothing
else. Debate in turn called groundOp as a pre-phase and the citation and
manifest modules from its selectors and verifiers, so the two clusters
do not compile apart and come out together.

Debate's review half was already dead: review-stage config was retired
in #1859, the review-dialogue context stage was declared but never
assembled (nax#1743), and DebatePromptBuilder's five review-dialogue
methods had zero production callers. runPlanPipeline was a duplicate of
PipelinePlanStrategy that planCommand never reached.

plan.mode narrows to single | refine. PlanPromptBuilder is trimmed of
buildDraft and citationRepair but survives for plan and plan-refine.
The acceptance hardening pass survives: suggestedCriteria is instructed
on the non-debate plan path too (src/config/test-strategy.ts)."
```

### Task 4: Delete and repair the tests

**Files — delete outright:**

```
test/unit/debate/                              (whole tree)
test/unit/operations/debate-*.test.ts          (6 files)
test/unit/operations/stateful-debater-op.test.ts
test/unit/operations/ground.test.ts
test/unit/operations/plan-critic-llm.test.ts
test/unit/plan/debate-strategy.test.ts
test/unit/plan/debate-composition.test.ts
test/unit/plan/pipeline-strategy.test.ts
test/unit/plan/critic.test.ts
test/unit/plan/draft-citations.test.ts
test/unit/plan/spec-deltas.test.ts
test/unit/cli/plan-debate.test.ts
test/unit/cli/plan-decompose-debate.test.ts
test/unit/config/debate-schema.test.ts
test/unit/prompts/builders/debate-builder.test.ts
test/unit/prompts/builders/critic-builder.test.ts
test/unit/runtime/session-role-plan-critic.test.ts
test/helpers/debate-runner.ts
```

`test/unit/runtime/session-role-plan-critic.test.ts` is a **deletion, not a
repair**: it exists solely to assert that `"plan-critic"` is registered in
`KNOWN_SESSION_ROLES`, which Step 1b of Task 3 removes. Five of its seven tests
assert exactly that, and one asserts `debate-*` roles pass `isSessionRole`. There
is nothing left to keep.

- [ ] **Step 1: Delete**

```bash
RTK_DISABLED=1 git rm -r test/unit/debate
RTK_DISABLED=1 git rm test/unit/operations/debate-hybrid.test.ts test/unit/operations/debate-judge.test.ts \
  test/unit/operations/debate-plan.test.ts test/unit/operations/debate-propose.test.ts \
  test/unit/operations/debate-rebut.test.ts test/unit/operations/debate-synthesis.test.ts \
  test/unit/operations/stateful-debater-op.test.ts \
  test/unit/operations/ground.test.ts test/unit/operations/plan-critic-llm.test.ts
RTK_DISABLED=1 git rm test/unit/plan/debate-strategy.test.ts test/unit/plan/debate-composition.test.ts \
  test/unit/plan/pipeline-strategy.test.ts test/unit/plan/critic.test.ts \
  test/unit/plan/draft-citations.test.ts test/unit/plan/spec-deltas.test.ts
RTK_DISABLED=1 git rm test/unit/cli/plan-debate.test.ts test/unit/cli/plan-decompose-debate.test.ts
RTK_DISABLED=1 git rm test/unit/config/debate-schema.test.ts
RTK_DISABLED=1 git rm test/unit/prompts/builders/debate-builder.test.ts \
  test/unit/prompts/builders/critic-builder.test.ts
RTK_DISABLED=1 git rm test/unit/runtime/session-role-plan-critic.test.ts
RTK_DISABLED=1 git rm test/helpers/debate-runner.ts
```

- [ ] **Step 2: Repair the shared helpers**

```bash
grep -rn 'debate\|Debate' test/helpers --include='*.ts'
```

Hits are expected in `test/helpers/{index,mock-nax-config,dispatch-context,context-orchestrator,interaction-chain,merge-engine,optimizer-result,warn-spy,worktree-manager,assert-defined}.ts` and `test/helpers/e2e/scripted-agent.ts`. For each: remove the `debate` key from config fixtures, remove `createDebateRunner` from dep fixtures, remove `debate-*` from session-role fixtures, and remove `plan.mode: "pipeline"` / `"debate"` from any plan fixture.

**Do not stub the removed surface back in.** A helper that fabricates a `debate` config key after the schema drops it produces a green suite over code that cannot run — the exact failure class this repo has been bitten by repeatedly.

- [ ] **Step 3: Repair the remaining referencing tests**

```bash
grep -rln 'debate\|Debate\|runPlanPipeline\|pipeline' test --include='*.ts'
```

The substantive ones:

- `test/unit/cli/plan.test.ts` — delete the whole `describe("runPlanPipeline (US-005)")` block (from ~line 888 to its close) and drop `buildPlanComposition` / `runPlanPipeline` from the import on line 20.
- `test/unit/plan/strategies-factory.test.ts` — drop the `"debate"` and `"pipeline"` cases. The existing test at line 58 asserting `src/cli/plan.ts` no longer defines `runPlanPipeline` now holds trivially; **keep it** and add a sibling asserting the same of `src/cli/plan-command.ts`. Add a case asserting `createPlanStrategy("pipeline" as never)` throws `PLAN_MODE_UNKNOWN`.
- `test/unit/prompts/review-diff-frame-ssot.test.ts:55` — drops `DebatePromptBuilder.buildResolverPrompt` from its comparison set. **Keep the test**; the SSOT property still matters for the surviving semantic and adversarial builders.
- `test/unit/context/engine/stage-config.test.ts`, `test/unit/context/engine/stage-reachability.test.ts` — drop the `debate` and `review-dialogue` stage expectations.
- `test/unit/cli/plan-mode.test.ts`, `test/unit/plan/strategies.test.ts`, `test/unit/config/plan-mode-refine.test.ts` — drop the retired modes.
- `test/unit/config/{schemas,selectors,defaults-ssot,plan-schema}.test.ts` — drop `debate`, `plan.citationThreshold` and `plan.criticModel` expectations.
- `test/unit/runtime/session-role.test.ts`, `test/unit/runtime/session-role-finish.test.ts`, `test/unit/runtime/usage-auditor.test.ts` — drop `debate-*` role cases and any assertion naming one of the six roles removed in Task 3 Step 1b. `session-role-finish.test.ts` covers the four `finish-*` roles, which all survive — check it rather than assuming it is clean.
- `test/unit/operations/{op-tool-declarations,bash-declarations,call-correlation,plan-fileoutput-writable}.test.ts`, `test/unit/scripts/check-op-tool-capability.test.ts` — drop the debate, ground, plan-draft and plan-critic-llm ops from the expected op lists.
- `test/unit/cli/plan-callop*.test.ts`, `test/integration/plan/plan-callop.test.ts`, `test/unit/cli/plan-decompose-*.test.ts` — drop the debate-decompose and pipeline branch coverage.
- `test/unit/plan/fidelity-survives-recovery.test.ts`, `test/unit/prd/schema.test.ts`, `test/unit/prompts/sections/{diff-access-gating,protocol-region}.test.ts`, `test/unit/context/rules/rules-frontmatter.test.ts`, `test/unit/execution/iteration-runner-worktree.test.ts` — mostly incidental mentions; check each and drop only what the deletion invalidated.

- [ ] **Step 4: Verify**

```bash
bun run typecheck && bun run test
```

Expected: all pass, with no `.skip` or `.only` introduced. If a test is now untestable rather than merely obsolete, delete it — do not leave it skipped.

- [ ] **Step 5: Confirm nothing in test/ still names the subsystem**

```bash
grep -rin 'debate' test --include='*.ts'
```

Expected: zero hits.

- [ ] **Step 6: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "test: drop debate and pipeline coverage, repair shared fixtures

Deletes the dedicated debate test tree and the pipeline-cluster tests,
and removes debate config keys, dep stubs, plan-mode fixtures and
session-role fixtures from the shared helpers.

Keeps review-diff-frame-ssot with the surviving builders and adds cases
asserting createPlanStrategy now rejects the retired debate and pipeline
modes."
```

### Task 4b: Verify and open PR 1

- [ ] **Step 1: Full gate run on the branch**

```bash
bun run typecheck
bun run lint
bun run check:all
bun run test
bun run test:e2e
```

All five must pass. **PR 1 has to be green to merge into the integration
branch**, so "leave it for PR 2" is not available here.

`check:all` runs `check:file-sizes` and `check:test-escape-hatches`, and both
read baselines that still name files Task 1 deleted (`file-sizes-baseline.json`
line 11; 20 entries in `test-escape-hatches-baseline.json`). If either gate goes
red purely because of a stale entry for a **deleted** file, remove just those
entries here and note it — Task 7 then finds that work already done and only has
to handle whatever is left.

What must **not** happen here is a blanket `--update-baseline` on any gate. That
would silently absorb drift on files this branch never touched, which Task 7
Step 3 is specifically there to catch. Hand-remove the dead entries; leave every
threshold for a surviving file exactly as it is.

- [ ] **Step 2: Code review before push**

Run the repo's post-implementation review over the full branch diff. Do not take
a subagent's "all green" at face value — re-run the gates yourself.

- [ ] **Step 3: Get approval, then push and open PR 1**

Do not push without explicit approval at that moment. When approved:

```bash
RTK_DISABLED=1 git push -u origin chore/delete-debate-source
RTK_DISABLED=1 gh pr create \
  --base feat/delete-debate \
  --head chore/delete-debate-source \
  --title "refactor: delete the debate subsystem and the pipeline plan mode"
```

**Check the base.** `gh pr create` defaults to the repo's default branch; if
`--base feat/delete-debate` is dropped this opens against `main` and the stack
is broken. Verify after creating:

```bash
RTK_DISABLED=1 gh pr view --json baseRefName,headRefName
```

The PR body should carry: the reachability table from Findings, the note that
the two clusters do not compile apart (so one PR rather than two), Decision 5
(grounded planning is retired deliberately — reviving it is a rebuild, not a
revert), and the `src/prd/schema-story.ts` resolution (comment-only, code stays).

- [ ] **Step 4: Merge PR 1 into `feat/delete-debate`**

Merge only after review. PR 2 cannot start until this lands.

---

# PR 2 — Config guards, docs, rules, baselines

**Branch:** `chore/delete-debate-config-docs`, cut from `feat/delete-debate` **after PR 1 has merged into it**. **PR base: `feat/delete-debate`, not `main`.**

```bash
RTK_DISABLED=1 git checkout feat/delete-debate
RTK_DISABLED=1 git pull --ff-only          # pick up PR 1's merge
RTK_DISABLED=1 git log --oneline -1        # confirm PR 1 is in
RTK_DISABLED=1 git checkout -b chore/delete-debate-config-docs
bun install
```

If `src/debate/` still exists on `feat/delete-debate` at this point, PR 1 has not merged — **stop**. Cutting PR 2 now would put PR 1's entire diff inside it.

### Task 5: Reject the retired plan modes, warn-and-strip the inert keys

Two mechanisms, deliberately different — see "Resolved: retired plan modes get a
`reject*` guard" above. Do not collapse them into one.

**Files:**
- Modify: `src/config/config-guards.ts`, `src/config/loader.ts`, `src/cli/config-descriptions.ts`
- Test: `test/unit/config/strip-removed-noop-keys.test.ts`, `test/unit/config/config-guards.test.ts`

**Interfaces:**
- Produces: `rejectRemovedPlanModes(conf: Record<string, unknown>): void` — throws `NaxError` with code `CONFIG_REMOVED_PLAN_MODE`, same shape as the three existing `reject*` guards.

**File-size note:** `src/config/config-guards.ts` is 510 lines against the 600
cap. The new guard is ~40 lines, landing around 550. If a later edit pushes it
over, extract rather than shrink the message — `check:file-sizes` is a hard gate.

- [ ] **Step 1: Write the failing test for the reject guard**

Add to `test/unit/config/config-guards.test.ts`:

```ts
describe("rejectRemovedPlanModes", () => {
  it.each(["pipeline", "debate"])("throws on plan.mode: %s", (mode) => {
    expect(() => rejectRemovedPlanModes({ plan: { mode } })).toThrow(/plan\.mode/);
  });

  it("names the surviving modes in the message", () => {
    expect(() => rejectRemovedPlanModes({ plan: { mode: "pipeline" } })).toThrow(/single.*refine|refine.*single/s);
  });

  it.each(["single", "refine"])("accepts the surviving mode %s", (mode) => {
    expect(() => rejectRemovedPlanModes({ plan: { mode } })).not.toThrow();
  });

  it("is a no-op when plan or plan.mode is absent", () => {
    expect(() => rejectRemovedPlanModes({})).not.toThrow();
    expect(() => rejectRemovedPlanModes({ plan: {} })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/unit/config/config-guards.test.ts --timeout=60000
```

Expected: FAIL — `rejectRemovedPlanModes is not defined`.

- [ ] **Step 3: Implement the guard**

Add to `src/config/config-guards.ts`, beside the three existing `reject*` guards:

```ts
/**
 * Plan modes removed with the debate subsystem and the asymmetric pipeline.
 *
 * Unlike the inert keys handled by `stripRemovedNoOpKeys`, these were not
 * no-ops: a config that named one was getting that strategy. Silently
 * resolving to `single` would change the user's plan output without telling
 * them, so this guard throws — matching `rejectDeadQualityFlags` rather than
 * the warn-and-strip path. The narrowed Zod enum would reject these too, but
 * only with "Invalid option: expected one of ...", which names the survivors
 * and explains nothing.
 */
const REMOVED_PLAN_MODES: Readonly<Record<string, string>> = {
  pipeline:
    "the asymmetric pipeline plan mode was removed along with its grounder, draft and critic stages; nax no longer grounds plans against a facts manifest",
  debate: "the multi-agent debate subsystem was removed",
};

export function rejectRemovedPlanModes(conf: Record<string, unknown>): void {
  const plan = conf.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;

  const mode = plan.mode;
  if (typeof mode !== "string") return;

  const reason = REMOVED_PLAN_MODES[mode];
  if (!reason) return;

  const message = [
    `Invalid configuration — removed plan mode: plan.mode: "${mode}".`,
    `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
    "",
    "Set `plan.mode` to one of the surviving modes instead:",
    "- `single` — one planning call (the default when `plan.mode` is unset)",
    "- `refine` — a draft call followed by a self-audit call",
  ].join("\n");
  throw new NaxError(message, "CONFIG_REMOVED_PLAN_MODE", { stage: "config", mode });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test test/unit/config/config-guards.test.ts --timeout=60000
```

- [ ] **Step 5: Wire the guard into both parse chains**

`src/config/loader.ts` runs the `reject*` guards at **two** sites — lines
234-241 for the root config and 563-568 for the per-package overlays (BUG-05:
guards must cover every overlay, not just the root). Add
`rejectRemovedPlanModes(...)` beside `rejectDeadQualityFlags(...)` at both,
before the `stripRemovedNoOpKeys` call that follows each. Import it alongside
the other guards at line 19-23.

Note there is a **third** `stripRemovedNoOpKeys` call at line 507, in the merge
chain, which the `reject*` guards deliberately do not cover. Match the existing
pattern — do not add the new guard there.

Confirm the wiring:

```bash
grep -n 'rejectRemovedPlanModes\|rejectDeadQualityFlags' src/config/loader.ts
```

Expected: one import line and two call sites for each, paired.

- [ ] **Step 6: Write the failing test for the inert-key strip**

Add to `test/unit/config/strip-removed-noop-keys.test.ts`:

```ts
it("strips a retired top-level debate block and warns once", () => {
  const warnings: string[] = [];
  const out = stripRemovedNoOpKeys(
    { debate: { enabled: true, agents: 3 }, plan: { outputPath: "prd.json" } },
    (m) => warnings.push(m),
  );
  expect(out).not.toHaveProperty("debate");
  expect(out).toHaveProperty("plan");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("debate");
});

it("strips the retired pipeline-only plan keys", () => {
  const warnings: string[] = [];
  const out = stripRemovedNoOpKeys(
    { plan: { outputPath: "prd.json", citationThreshold: 0.7, criticModel: "fast" } },
    (m) => warnings.push(m),
  ) as { plan: Record<string, unknown> };
  expect(out.plan).not.toHaveProperty("citationThreshold");
  expect(out.plan).not.toHaveProperty("criticModel");
  expect(out.plan).toHaveProperty("outputPath");
  expect(warnings).toHaveLength(2);
});
```

- [ ] **Step 7: Run it and confirm it fails**

```bash
bun test test/unit/config/strip-removed-noop-keys.test.ts --timeout=60000
```

Expected: FAIL — the keys survive.

- [ ] **Step 8: Implement**

In `src/config/config-guards.ts`, in `REMOVED_NO_OP_KEYS`, replace the `"debate.stages.review"` entry (it is subsumed) with:

```ts
  debate: "the multi-agent debate subsystem was removed; plan.mode is now single or refine",
  "plan.citationThreshold": "this key only fed the removed pipeline plan mode",
  "plan.criticModel": "this key only fed the removed pipeline plan mode",
```

Extend the map's doc comment: it now covers whole retired subsystems, not only inert leaf keys. Say explicitly that `plan.mode: "debate"` and `plan.mode: "pipeline"` are deliberately **not** handled here — they were not inert, so `rejectRemovedPlanModes` throws on them instead.

Confirm `stripRemovedNoOpKeys` handles a non-dotted top-level key. If it only walks dotted paths, extend it and call that out in the PR body.

- [ ] **Step 9: Run the test and confirm it passes**

```bash
bun test test/unit/config/strip-removed-noop-keys.test.ts --timeout=60000
```

- [ ] **Step 10: Delete the retired CLI descriptions**

In `src/cli/config-descriptions.ts`, delete the block from the `// Debate (US-001)` comment through the last `debate.*` entry, plus the `plan.citationThreshold` and `plan.criticModel` entries. Update the `plan.mode` description to name only `single` and `refine`.

- [ ] **Step 11: Verify and commit**

```bash
bun run typecheck && bun run test && bun run check:all
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "feat(config): reject the retired plan modes, strip the inert keys

Two mechanisms, matching how this repo already separates the cases.

The debate block, plan.citationThreshold and plan.criticModel were inert
once their readers were deleted, so they follow the #1859 precedent:
stripRemovedNoOpKeys warns rather than throws, and an existing config
carrying one still loads.

plan.mode: 'pipeline' and 'debate' were not inert — a config naming one
was getting that strategy. Silently resolving to single would change a
user's plan output without telling them, so rejectRemovedPlanModes
throws before safeParse with a migration message, matching
rejectDeadQualityFlags. It is wired into both the root and the
per-package parse chains (BUG-05). The narrowed Zod enum stays as a
second line of defence."
```

### Task 6: Docs, rules and profiles

**Files:**
- Delete: `docs/guides/debate.md`, `.nax/profiles/debate.json`, `.nax/profiles/opencode-debate.json`
- Modify: `docs/architecture/{ARCHITECTURE,subsystems,conventions,design-patterns}.md`, `docs/guides/{context-engine,semantic-review,acceptance-review-flow,prompt-customization,retry-strategy}.md`, `.nax/rules/{adapter-wiring,config-patterns,error-handling,forbidden-patterns-source,monorepo-awareness,test-architecture}.md`, `README.md` if it names the plan modes
- **Leave alone:** `docs/specs/*debate*` bodies, `docs/adr/ADR-*`, `docs/plans/archive/**`, `docs/reviews/**`, dated `docs/2026*` review notes. These record what the codebase was; rewriting them would falsify the record.

- [ ] **Step 1: Delete the guide and profiles**

```bash
RTK_DISABLED=1 git rm docs/guides/debate.md .nax/profiles/debate.json .nax/profiles/opencode-debate.json
```

- [ ] **Step 2: Update the living docs**

```bash
grep -rn 'debate\|Debate\|pipeline mode\|plan.mode' docs/architecture docs/guides README.md
```

Rewrite each passage to current behaviour. Anywhere a doc lists plan modes it must now read `single`, `refine`. Anywhere it lists subsystems, drop debate. Then check for dangling links:

```bash
grep -rn 'guides/debate' docs README.md
```

Expected after the edit: zero hits.

- [ ] **Step 3: Update the canonical rules, then regenerate the mirror**

```bash
grep -rn 'debate\|Debate' .nax/rules/
```

Edit `.nax/rules/*.md` **only**. Then:

```bash
bun run check:rules-drift
```

If it reports drift, run the repo's rules generation step and re-check. Do not silence the gate or hand-edit `.claude/rules/`.

- [ ] **Step 4: Banner the retired specs**

Prepend to each of `docs/specs/SPEC-multi-agent-debate.md`, `SPEC-enhanced-debate-phase-1.md`, `SPEC-enhanced-debate-phase-2.md`, `SPEC-debate-resolver-dialogue.md`, `SPEC-debate-session-mode.md`, `SPEC-debate-bounded-concurrency.md`, and `SPEC-plan-asymmetric-pipeline.md` (plus `2026-05-10-plan-asymmetric-pipeline.md` if present):

```markdown
> **Status: RETIRED 2026-09-20.** The subsystem this spec describes was
> deleted. The document is kept as a historical record of what was built;
> nothing in it describes current behaviour.
```

Do not edit their bodies.

- [ ] **Step 5: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "docs: retire the debate guide, profiles and rule references

Deletes docs/guides/debate.md and the two debate profiles, updates the
architecture and guide docs to the two surviving plan modes, and banners
the debate and asymmetric-pipeline specs as retired. Historical records
(ADRs, archived plans, dated review notes) are left as written."
```

### Task 7: Baselines and final verification

**Files:** `scripts/baselines/{file-sizes,test-escape-hatches,coverage-per-file,op-tool-capability,import-cycles}-baseline.json`

- [ ] **Step 1: Remove the stale file-size entry by hand**

`scripts/baselines/file-sizes-baseline.json` line 11 holds `"test/unit/debate/runner-plan.test.ts": 1038`. That file is gone. Delete that one entry rather than regenerating the whole file — a blanket regenerate would silently absorb any *other* file that has drifted toward the cap.

- [ ] **Step 2: Regenerate the ratcheted baselines**

Each is a ratchet: the deletion legitimately lowers the counts, and leaving them high lets future debt back in unnoticed.

```bash
bun run check:file-sizes
bun run test:coverage:update
bun run check:op-tool-capability:update
bun run check:import-cycles:update
bun run check:test-escape-hatches:update
```

Then confirm the escape-hatches baseline is clean of the deleted paths:

```bash
grep -c 'debate' scripts/baselines/test-escape-hatches-baseline.json   # expect 0
```

- [ ] **Step 3: Review every baseline diff before staging**

```bash
RTK_DISABLED=1 git diff scripts/baselines/
```

Every changed line must be attributable to a file this branch deleted. **A loosened threshold on a file that still exists is a regression hiding inside a regenerate** — if you see one, stop and report it rather than committing it.

- [ ] **Step 4: Full verification**

```bash
bun run typecheck
bun run lint
bun run check:all
bun run test
bun run test:e2e
bun run test:coverage
```

All six must pass. Record the actual output. Do not claim a pass you have not seen.

- [ ] **Step 5: Final sweep**

```bash
grep -rin 'debate' src test scripts bin --include='*.ts' --include='*.json'
```

Expected: zero hits.

- [ ] **Step 6: Smoke-test the surviving plan modes**

The gates above prove the tree compiles and the suite is green. They do not prove `nax plan` still runs. Run a real plan in each surviving mode (`single` and `refine`) against a throwaway feature and a small spec, in a scratch copy — **not** in this worktree, since a run auto-commits onto the current branch.

**This may be deferred to Task 8 Step 3 instead**, against the fully merged integration branch, where it is more meaningful. Run it once, in one place or the other — it is a billed LLM call, not a free gate.

This is a billed LLM run. **Get explicit approval at that moment**, and confirm the produced `prd.json` parses rather than trusting the exit code — `nax plan` exits 0 on fatal errors.

- [ ] **Step 7: Measure the cut, for the PR body**

```bash
RTK_DISABLED=1 git diff --stat origin/main...HEAD | tail -1
```

- [ ] **Step 8: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "chore: ratchet baselines after the debate and pipeline deletion"
```

- [ ] **Step 9: Code review before any push**

Run the repo's post-implementation review over this branch's diff **before** pushing or opening a PR, not after. Do not take a subagent's "all green" at face value — re-run the gates yourself.

- [ ] **Step 10: Get approval, then push and open PR 2**

Do not push without explicit approval at that moment. When approved:

```bash
RTK_DISABLED=1 git push -u origin chore/delete-debate-config-docs
RTK_DISABLED=1 gh pr create \
  --base feat/delete-debate \
  --head chore/delete-debate-config-docs \
  --title "chore: retire the debate and pipeline config keys, docs and baselines"
RTK_DISABLED=1 gh pr view --json baseRefName,headRefName
```

Same trap as PR 1: confirm `baseRefName` is `feat/delete-debate`, not `main`.

The PR body should carry the two-mechanism rationale from the Resolved decisions
section — why the inert keys warn-and-strip while `plan.mode` throws — and the
baseline-diff audit result from Step 3.

- [ ] **Step 11: Merge PR 2 into `feat/delete-debate`**

---

### Task 8: Merge the integration branch to `main`

Only after both sub-PRs have merged into `feat/delete-debate`.

- [ ] **Step 1: Refresh the integration branch and re-run every gate on it**

The sub-PRs were each green in isolation, and PR 1 was knowingly allowed to
leave stale baseline entries for PR 2 to fix. Neither proves the merged result
is green. Re-run the full set on the integration branch itself:

```bash
RTK_DISABLED=1 git checkout feat/delete-debate
RTK_DISABLED=1 git pull --ff-only
RTK_DISABLED=1 git fetch origin main
RTK_DISABLED=1 git merge --ff-only origin/main 2>/dev/null || echo "main has moved — rebase or merge, then re-run the gates"
bun install
bun run typecheck && bun run lint && bun run check:all && bun run test && bun run test:e2e && bun run test:coverage
```

All must pass. If `main` moved while the stack was in flight, reconcile first and
re-run — do not open the final PR on a stale base.

- [ ] **Step 2: Final sweep on the merged result**

```bash
grep -rin 'debate' src test scripts bin --include='*.ts' --include='*.json'
RTK_DISABLED=1 git diff --stat origin/main...HEAD | tail -1
```

Expected: zero grep hits. Record the diffstat for the PR body.

- [ ] **Step 3: Smoke-test the surviving plan modes**

Carry out Task 7 Step 6 here if it has not already been done — it is the only
check that proves `nax plan` still runs, and it is most meaningful against the
fully merged tree. Billed LLM run: **get explicit approval at that moment**, run
from a scratch copy rather than this worktree (a run auto-commits onto the
current branch), and confirm the produced `prd.json` parses rather than trusting
the exit code — `nax plan` exits 0 on fatal errors.

- [ ] **Step 4: Get approval, then open the PR to `main`**

```bash
RTK_DISABLED=1 git push -u origin feat/delete-debate
RTK_DISABLED=1 gh pr create \
  --base main \
  --head feat/delete-debate \
  --title "refactor: remove the debate subsystem and the pipeline plan mode"
```

This is the reviewable unit for the whole change. Its body should consolidate:
the reachability table, the scale of the cut, all five Decisions, the three
Resolved decisions, what survives and why (`PlanPromptBuilder` trim, the
hardening pass), and the smoke-test result from Step 3.

---

## Resolved decisions (were open questions)

All three were resolved on 2026-09-20 before execution. They are recorded here so
the PR bodies can cite them; none is still a choice for the implementer to make.

### Resolved: retired plan modes get a `reject*` guard, not a bare enum error

`config-guards.ts` already encodes the distinction this needed. An **inert** key
removal — one where the key never did anything — goes through
`stripRemovedNoOpKeys`, which warns and strips so an existing config keeps
loading. A **behaviour-changing** removal gets a `reject*` guard that throws
before `safeParse` with a tailored migration message: `rejectLegacyAgentKeys`,
`rejectLegacyRectificationKeys`, `rejectDeadQualityFlags`.

`plan.mode: "pipeline"` and `"debate"` are squarely the second class — the user
was getting that strategy. Relying on the narrowed Zod enum alone would surface
only `plan.mode: Invalid option: expected one of "single"|"refine"`, which names
the survivors but explains neither the removal nor the remedy. Task 5 therefore
adds `rejectRemovedPlanModes` following the existing pattern. The enum narrowing
stays as well — belt and braces, and it keeps the type-level union honest.

### Resolved: the `testStrategy` auto-correct stays

`src/prd/schema-story.ts:238-245` downgrades `testStrategy` to `"no-test"` when
`noTestJustification` carries text matching `NO_TEST_JUSTIFICATION_SIGNAL`. Its
comment blames debate synthesis, which is what prompted the question — but the
code is not debate-gated and never was. It fires on any PRD payload where an LLM
populated the justification field while leaving `testStrategy` set to something
else, which the surviving `single` and `refine` paths can produce exactly as
readily. BUG-26 (recorded in the same comment) confirms the broader framing: the
branch was *hardened* precisely because an unconditional version fired on "ANY
stray note in this field", across plan paths.

**Keep the branch. Fix only the comment.** No follow-up issue.

### Resolved: grounded planning is retired deliberately

Owner ruling, 2026-09-20: *"no more grounding for plan, only single or refine."*
`single` and `refine` do not ground against a facts manifest and do not measure
citation rate, and that is the intended end state. Do not preserve or stub any
part of the grounder/draft/critic cluster against a possible revival. State in
the PR 1 body that reviving evidence-grounded planning would be a rebuild rather
than a revert, so the decision stays visible to whoever looks next.
