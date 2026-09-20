# Delete the Debate Subsystem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the multi-agent debate subsystem from nax — the plan-stage debate engine and the already-dead review-dialogue half — while preserving the grounding/citation/verification machinery that the live (non-debate) plan paths depend on.

**Architecture:** `src/debate/` is not one thing. It holds (a) a debate engine — runners, debaters, rounds, resolvers, selectors, personas, pre-phase — that is opt-in and off by default, and (b) grounding infrastructure — the facts manifest, citation extraction, and plan checks — that the *pipeline* and *single* plan strategies call directly with no debate involved. The deletion therefore runs in four sequential PRs: **first lift the survivors out** (PR 1), **then relocate the one config key the survivors read** (PR 2), **then delete the engine** (PR 3), **then clean up config guards, docs, rules and baselines** (PR 4). Reversing that order breaks `nax plan` in pipeline mode.

**Tech Stack:** TypeScript on Bun, Zod config schemas, Biome lint, custom `scripts/check-*.ts` gates with JSON baselines.

**Spec:** None — this is a deletion authorised directly by the repo owner. This plan document is the specification. The investigation findings that justify each deletion are recorded inline under "Evidence" in each task.

**Branch / worktree:** `chore/delete-debate`, worktree at `.worktrees/delete-debate`, branched from `origin/main` @ `f4b3bbc7a`.

---

## Global Constraints

- **Repo test commands only.** `bun run test`, `bun run test:unit`, `bun run test:e2e`, `bun run typecheck`, `bun run check:all`, `bun run test:coverage`. **Never** bare `bun test` and **never** `bun run nax` — both give confident false signals.
- **`typecheck` is NOT in `check:all`.** Run `bun run typecheck` explicitly at the end of every task. Only `tsc` catches a declared-but-unwired field.
- **`test:coverage` is NOT in `check:all`.** Run it after any task that adds or removes a `src/` file.
- Prefix every git command with `RTK_DISABLED=1` (the rtk hook rewrite is blocked in worktrees).
- File-size gate: 600 lines hard cap per file, enforced by `check:file-sizes` against `scripts/baselines/file-sizes-baseline.json`. Deletions only shrink files here, but the baseline must have its debate entry removed in PR 4.
- `.claude/rules/` is a **generated mirror** of `.nax/rules/` (pre-commit enforced via `check:rules-drift`). Edit `.nax/rules/` only; never hand-edit `.claude/rules/`.
- Conventional commits. No emojis in code, comments or docs.
- Do not open PRs or push without explicit approval at that moment.

---

## Findings this plan rests on

Re-verified on `origin/main` @ `f4b3bbc7a` on 2026-09-20.

| Fact | Evidence |
|---|---|
| Debate is **off by default** | `src/config/schemas.ts:363` — `debate: DebateConfigSchema.optional().default(() => ({ enabled: false, ... }))` |
| Debate is **not enabled in any live config** | `.nax/config.json` in this repo has no `debate` key; `~/.nax/config.json` sets only `debate.timeoutSeconds`, which is not a valid top-level key and is stripped |
| **Review-stage debate was already removed** in #1859 | `src/config/config-guards.ts:218-219` — `"debate.stages.review": "... review-stage debate was removed with the unreachable runReview LLM path (#1859)"` |
| The **review-dialogue prompt half is already dead** | `DebatePromptBuilder.buildReviewPrompt` / `buildReReviewPrompt` / `buildResolverPrompt` / `buildReResolverPrompt` / `buildClosePrompt` have **0 production call sites** — only tests. (The live `buildReviewPrompt` used by `src/operations/finish-review.ts` is a *different* function in `src/finish/review/prompt.ts`.) |
| The **`review-dialogue` context stage is declared but unreachable** | `src/context/engine/stage-config.ts:312-324` — "Declared but not assembled by any site today — see nax#1743 ... there is no dispatch seam" |
| Grounding/citations/checks are **live and non-debate** | `groundOp` (`src/operations/ground.ts`) is called from `src/plan/strategies/pipeline.ts:41` and `src/cli/plan-command.ts:212`, neither on a debate path |
| Size of the cut | 44 source files / 5,012 LOC under `src/**/*debate*`; 113 test files reference debate; the dedicated debate test tree is 15,338 LOC |

### Survivors (must NOT be deleted)

| File | Consumed by (non-debate) |
|---|---|
| `src/debate/facts-manifest.ts` | `operations/ground.ts`, `operations/plan-draft.ts`, `operations/plan-critic-llm.ts`, `plan/spec-deltas/index.ts`, `plan/draft-citations.ts`, `plan/strategies/pipeline.ts`, `prompts/builders/critic-builder.ts`, `cli/plan-command.ts` |
| `src/debate/citations.ts` | `operations/plan-draft.ts`, `plan/draft-citations.ts` |
| `src/debate/verifiers/checks.ts` | `plan/critic.ts` (all five `check*` functions) |
| `src/operations/ground.ts` | `plan/strategies/pipeline.ts`, `cli/plan-command.ts` |

Everything else under `src/debate/`, plus all `src/operations/debate-*.ts`, `src/plan/strategies/debate*.ts`, `src/prompts/builders/debate-builder.ts` and `src/config/schemas-debate.ts`, is debate-only and goes.

---

## Decisions taken (state these in the PR bodies)

1. **Survivors move to `src/plan/grounding/`.** They are plan-pipeline infrastructure; `src/plan/` is where their only remaining consumers live.
2. **`debate.grounder` becomes `plan.grounder`.** It is the only debate config key read by surviving code.
3. **Removed config keys warn-and-strip, they do not throw.** This follows the #1859 precedent already implemented in `stripRemovedNoOpKeys` (`src/config/config-guards.ts`): a throw would hard-fail every existing config that carries an inert key, with no behaviour change to show for it.
4. **`plan.mode: "debate"` becomes a rejected value at the schema level.** Unlike the inert keys above, this one is *not* inert — a user who set it was getting the debate strategy, and silently downgrading them to `single` would change their output without telling them. The Zod enum drops `"debate"`, so the config fails to parse with a clear message.

---

## Task 0: Preflight

Do not skip this. It re-derives every precondition from the real tree rather than trusting this document.

- [ ] **Step 1: Confirm the worktree and base**

```bash
cd .worktrees/delete-debate
RTK_DISABLED=1 git branch --show-current   # expect: chore/delete-debate
RTK_DISABLED=1 git log --oneline -1        # expect: f4b3bbc7a or a later origin/main
RTK_DISABLED=1 git status --short          # expect: only this plan file, if not yet committed
bun install
```

- [ ] **Step 2: Confirm the baseline is green before you change anything**

```bash
bun run typecheck && bun run check:all && bun run test
```

Expected: all pass. If anything is red on a clean `origin/main`, **stop** and report — do not start deleting on top of a red baseline.

- [ ] **Step 3: Re-derive the survivor set**

```bash
grep -rn "from \"@/debate\|from \"\.\./debate\|from \"\.\./\.\./debate" src --include='*.ts' | grep -v '^src/debate/'
```

Expected: every hit is either (a) an import of `facts-manifest`, `citations`, or `verifiers` checks — these are survivors; or (b) an import of `DebateRunner`/`DebateStageConfig`/`debate/types` from a file this plan deletes or edits in PR 3. If a **new** consumer of a debate-only symbol has appeared since 2026-09-20, stop and report it rather than absorbing it silently.

- [ ] **Step 4: Re-confirm the review-dialogue half is still dead**

```bash
for m in buildReviewPrompt buildReReviewPrompt buildResolverPrompt buildReResolverPrompt buildClosePrompt; do
  echo -n "$m: "; grep -rn "\.$m(" src --include='*.ts' | wc -l
done
```

Expected: `0` for every one. A non-zero count means a production caller appeared — stop and report.

- [ ] **Step 5: Record the pre-deletion measurements** (for the final PR body)

```bash
find src -ipath '*debate*' -name '*.ts' | xargs wc -l | tail -1
find test -ipath '*debate*' -type f | xargs wc -l | tail -1
grep -ril 'debate' test --include='*.ts' | wc -l
```

---

# PR 1 — Lift the survivors out of `src/debate/`

**Intent:** A pure move. Zero behaviour change, zero logic edits. After this PR, nothing outside `src/debate/` imports from `src/debate/` except the debate-only call sites that PR 3 deletes.

### Task 1: Move `facts-manifest.ts` and `citations.ts` to `src/plan/grounding/`

**Files:**
- Create: `src/plan/grounding/facts-manifest.ts` (moved from `src/debate/facts-manifest.ts`, 79 lines)
- Create: `src/plan/grounding/citations.ts` (moved from `src/debate/citations.ts`, 106 lines)
- Create: `src/plan/grounding/index.ts`
- Delete: `src/debate/facts-manifest.ts`, `src/debate/citations.ts`
- Modify: `src/debate/index.ts` (re-point its re-exports at the new path), `src/debate/verifiers/checks.ts`, `src/debate/verifiers/plan-checklist.ts`, `src/debate/selectors/verifier-pick.ts`, `src/debate/pre-phase/grounder.ts`, `src/operations/ground.ts:4-5`, `src/operations/plan-draft.ts:6-7`, `src/operations/plan-critic-llm.ts:4`, `src/plan/draft-citations.ts:8-9`, `src/plan/spec-deltas/index.ts:11`, `src/plan/strategies/pipeline.ts:1-2`, `src/prompts/builders/critic-builder.ts:1`, `src/cli/plan-command.ts:13`
- Test: `test/unit/debate/facts-manifest.test.ts` → `test/unit/plan/grounding/facts-manifest.test.ts`; `test/unit/debate/citations.test.ts` → `test/unit/plan/grounding/citations.test.ts`

**Interfaces:**
- Produces: `src/plan/grounding/index.ts` exporting `FactsManifestSchema`, `type FactsManifest`, `parseFactsManifest`, `renderManifestSection`, `type ParsedClaim`, `extractClaims`, `citationRate`, `citationDistribution` — the same names and signatures they have today. Nothing is renamed.

- [ ] **Step 1: Move the two files with git, preserving history**

```bash
mkdir -p src/plan/grounding
RTK_DISABLED=1 git mv src/debate/facts-manifest.ts src/plan/grounding/facts-manifest.ts
RTK_DISABLED=1 git mv src/debate/citations.ts src/plan/grounding/citations.ts
mkdir -p test/unit/plan/grounding
RTK_DISABLED=1 git mv test/unit/debate/facts-manifest.test.ts test/unit/plan/grounding/facts-manifest.test.ts
RTK_DISABLED=1 git mv test/unit/debate/citations.test.ts test/unit/plan/grounding/citations.test.ts
```

- [ ] **Step 2: Fix the intra-file import in `citations.ts`**

`src/plan/grounding/citations.ts:13-14` currently reads:

```ts
import { tryParseLLMJson } from "../utils/llm-json";
import type { FactsManifest } from "./facts-manifest";
```

The relative depth changed. Replace line 13 with:

```ts
import { tryParseLLMJson } from "@/utils/llm-json";
```

Line 14 stays as-is — `facts-manifest` is now a sibling again.

- [ ] **Step 3: Write the barrel**

Create `src/plan/grounding/index.ts`:

```ts
/**
 * Grounding infrastructure for the plan pipeline — the facts manifest a
 * grounder emits and the citation accounting the drafter gate measures
 * against it. Lifted out of the debate subsystem when that was deleted;
 * none of this is debate-specific and all of it is on the live pipeline
 * and single plan paths.
 */

export type { ParsedClaim } from "./citations";
export { citationDistribution, citationRate, extractClaims } from "./citations";
export type { FactsManifest } from "./facts-manifest";
export { FactsManifestSchema, parseFactsManifest, renderManifestSection } from "./facts-manifest";
```

- [ ] **Step 4: Re-point every importer**

Find them:

```bash
grep -rn "debate/facts-manifest\|debate/citations" src test --include='*.ts'
```

Rewrite each to `@/plan/grounding` (or `@/plan/grounding/facts-manifest` where the file imports the module directly). Concretely:

| File | Old | New |
|---|---|---|
| `src/operations/ground.ts:4-5` | `"../debate/facts-manifest"` | `"@/plan/grounding"` |
| `src/operations/plan-draft.ts:6-7` | `"../debate/citations"`, `"../debate/facts-manifest"` | `"@/plan/grounding"` |
| `src/operations/plan-critic-llm.ts:4` | `"@/debate/facts-manifest"` | `"@/plan/grounding"` |
| `src/plan/draft-citations.ts:8-9` | `"../debate/citations"`, `"../debate/facts-manifest"` | `"./grounding"` |
| `src/plan/spec-deltas/index.ts:11` | `"@/debate/facts-manifest"` | `"../grounding"` |
| `src/plan/strategies/pipeline.ts:1-2` | `"@/debate"`, `"@/debate/facts-manifest"` | `"@/plan/grounding"` |
| `src/prompts/builders/critic-builder.ts:1` | `"@/debate/facts-manifest"` | `"@/plan/grounding"` |
| `src/cli/plan-command.ts:13` | `"../debate"` (`renderManifestSection`) | `"@/plan/grounding"` |
| `src/debate/verifiers/checks.ts:14` | `"../facts-manifest"` | `"@/plan/grounding"` |
| `src/debate/verifiers/plan-checklist.ts:20-21` | `"../facts-manifest"` | `"@/plan/grounding"` |
| `src/debate/selectors/verifier-pick.ts` | `"../citations"` | `"@/plan/grounding"` |
| `src/debate/pre-phase/grounder.ts` | `"../facts-manifest"` | `"@/plan/grounding"` |

- [ ] **Step 5: Re-point `src/debate/index.ts`**

Replace lines 8-11 of `src/debate/index.ts`:

```ts
export type { ParsedClaim } from "./citations";
export { citationDistribution, citationRate, extractClaims } from "./citations";
export type { FactsManifest } from "./facts-manifest";
export { parseFactsManifest, renderManifestSection } from "./facts-manifest";
```

with:

```ts
export type { FactsManifest, ParsedClaim } from "@/plan/grounding";
export { citationDistribution, citationRate, extractClaims, parseFactsManifest, renderManifestSection } from "@/plan/grounding";
```

This keeps the barrel compiling for the debate-only files that still import from it; PR 3 deletes the whole barrel.

- [ ] **Step 6: Fix the moved tests' import paths**

```bash
grep -n 'debate' test/unit/plan/grounding/facts-manifest.test.ts test/unit/plan/grounding/citations.test.ts
```

Rewrite each import to `@/plan/grounding`. Change no assertion — this is a move, and a changed assertion here would mask a real regression.

- [ ] **Step 7: Verify**

```bash
bun run typecheck
bun run test:unit
bun run check:import-cycles
```

Expected: all pass. `check:import-cycles` matters here — `src/plan/grounding/` now sits alongside `src/plan/spec-deltas/`, which `verifiers/checks.ts` imports from. (Note: that gate sees **static** imports only; a dynamic `import()` would hide a cycle behind a green result. There are none in the moved files — confirm with `grep -n 'import(' src/plan/grounding/*.ts`, expect no hits.)

- [ ] **Step 8: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "refactor(plan): lift facts-manifest and citations out of src/debate

Both modules are consumed by the pipeline and single plan strategies with
no debate involved. Moving them to src/plan/grounding/ so the debate
subsystem can be deleted without taking live plan infrastructure with it.

Pure move: no logic, signature or assertion changes."
```

### Task 2: Move `verifiers/checks.ts` to `src/plan/grounding/checks.ts`

**Files:**
- Create: `src/plan/grounding/checks.ts` (moved from `src/debate/verifiers/checks.ts`, 158 lines)
- Modify: `src/plan/grounding/index.ts`, `src/plan/critic.ts:13-14`, `src/debate/verifiers/index.ts:1-8`, `src/debate/verifiers/plan-checklist.ts:22`, `src/debate/index.ts`
- Test: `test/unit/debate/verifiers/checks.test.ts` → `test/unit/plan/grounding/checks.test.ts`

**Interfaces:**
- Consumes: `FactsManifest` from Task 1's `src/plan/grounding/facts-manifest.ts`.
- Produces: `src/plan/grounding/index.ts` additionally exports `type CheckDeps`, `checkFilesExist(prd: PRD, workdir: string, deps?: CheckDeps): VerifierFinding[]`, `checkAcAnchored(prd: PRD): VerifierFinding[]`, `checkClaimsCited(manifest: FactsManifest | null, threshold: number): VerifierFinding[]`, `checkNoContradictions(prd: PRD, manifest: FactsManifest | null): VerifierFinding[]`, `checkSpecCoverage(manifest: FactsManifest | null): VerifierFinding[]`.

- [ ] **Step 1: Move the file and its test**

```bash
RTK_DISABLED=1 git mv src/debate/verifiers/checks.ts src/plan/grounding/checks.ts
RTK_DISABLED=1 git mv test/unit/debate/verifiers/checks.test.ts test/unit/plan/grounding/checks.test.ts
```

- [ ] **Step 2: Fix the moved file's relative import**

`src/plan/grounding/checks.ts:14` reads `import type { FactsManifest } from "../facts-manifest";`. Replace with:

```ts
import type { FactsManifest } from "./facts-manifest";
```

The other five imports (`node:fs`, `node:path`, `@/plan/spec-deltas`, `@/prd`, `@/prd/types`, `@/utils/path-frame`) are alias or node imports and need no change.

- [ ] **Step 3: Extend the grounding barrel**

Append to `src/plan/grounding/index.ts`:

```ts
export type { CheckDeps } from "./checks";
export {
  checkAcAnchored,
  checkClaimsCited,
  checkFilesExist,
  checkNoContradictions,
  checkSpecCoverage,
} from "./checks";
```

- [ ] **Step 4: Re-point the consumers**

`src/plan/critic.ts:13-14` currently reads:

```ts
import type { FactsManifest } from "@/debate";
import { checkAcAnchored, checkClaimsCited, checkFilesExist, checkNoContradictions, checkSpecCoverage } from "@/debate";
```

Replace with:

```ts
import type { FactsManifest } from "./grounding";
import { checkAcAnchored, checkClaimsCited, checkFilesExist, checkNoContradictions, checkSpecCoverage } from "./grounding";
```

In `src/debate/verifiers/index.ts`, replace the `./checks` re-exports (lines 1-8) with a re-export from the new home, so the debate-internal `plan-checklist.ts` keeps compiling until PR 3 removes it:

```ts
export type { CheckDeps } from "@/plan/grounding";
export {
  checkAcAnchored,
  checkClaimsCited,
  checkFilesExist,
  checkNoContradictions,
  checkSpecCoverage,
} from "@/plan/grounding";
```

In `src/debate/verifiers/plan-checklist.ts:22`, change `from "./checks"` to `from "@/plan/grounding"`.

- [ ] **Step 5: Fix the moved test's imports**

```bash
grep -n 'debate' test/unit/plan/grounding/checks.test.ts
```

Rewrite to `@/plan/grounding`. No assertion changes.

- [ ] **Step 6: Verify**

```bash
bun run typecheck && bun run test:unit && bun run check:import-cycles && bun run check:all
```

- [ ] **Step 7: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "refactor(plan): move plan checks out of src/debate/verifiers

checkFilesExist/checkAcAnchored/checkClaimsCited/checkNoContradictions/
checkSpecCoverage are called by src/plan/critic.ts on the non-debate plan
path. Moving them beside the facts manifest they read.

Pure move: no logic, signature or assertion changes."
```

- [ ] **Step 8: Prove the survivors are fully detached**

```bash
grep -rn "from \"@/debate\|from \"\.\./debate\|from \"\.\./\.\./debate" src --include='*.ts' | grep -v '^src/debate/'
```

Expected remaining hits — and **only** these:

```
src/config/schema.ts             (debate/types re-export)
src/config/index.ts              (debate/types re-export)
src/config/types.ts              (debate/types re-export)
src/config/runtime-types.ts      (debate/types re-export)
src/plan/strategies/types.ts     (DebateRunner, DebateRunnerOptions)
src/plan/strategies/debate-composition.ts
src/cli/plan-runtime/index.ts    (DebateRunner)
src/cli/plan-decompose.ts        (DebateStageConfig)
src/operations/debate-*.ts       (7 files)
src/prompts/builders/debate-builder.ts
```

Every one of those is deleted or edited in PR 3. If anything else appears, stop and report.

---

# PR 2 — Relocate `debate.grounder` to `plan.grounder`

**Intent:** `groundOp` runs on the live pipeline plan path but reads its model and timeout from `config.debate.grounder`. Move that key so PR 3 can delete `DebateConfigSchema` outright.

### Task 3: Add `plan.grounder` and re-point `groundOp`

**Files:**
- Modify: `src/config/schemas-infra.ts` (the `PlanConfigSchema` object — add `grounder`), `src/config/selectors.ts:26` (`planConfigSelector`), `src/operations/ground.ts:2-4,153-161`, `src/cli/config-descriptions.ts`
- Test: `test/unit/operations/ground.test.ts`, `test/unit/config/plan-schema.test.ts`, `test/unit/config/selectors.test.ts`

**Interfaces:**
- Produces: `config.plan.grounder: { model: ConfiguredModel; timeoutSeconds: number }`, defaulting to `{ model: "fast", timeoutSeconds: 1800 }` — byte-identical defaults to today's `debate.grounder`, so no live run changes behaviour.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config/plan-schema.test.ts`:

```ts
describe("plan.grounder", () => {
  it("defaults to the fast tier with a 1800s timeout", () => {
    const parsed = PlanConfigSchema.parse({ outputPath: "prd.json" });
    expect(parsed.grounder).toEqual({ model: "fast", timeoutSeconds: 1800 });
  });

  it("accepts an explicit override", () => {
    const parsed = PlanConfigSchema.parse({
      outputPath: "prd.json",
      grounder: { model: "balanced", timeoutSeconds: 600 },
    });
    expect(parsed.grounder).toEqual({ model: "balanced", timeoutSeconds: 600 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/unit/config/plan-schema.test.ts --timeout=60000
```

Expected: FAIL — `parsed.grounder` is `undefined`.

- [ ] **Step 3: Add the schema**

In `src/config/schemas-infra.ts`, above `PlanConfigSchema`, add:

```ts
const GrounderConfigSchema = z.object({
  model: ConfiguredModelSchema.default("fast"),
  timeoutSeconds: z.number().int().positive().default(1800),
});
```

and inside the `PlanConfigSchema` object, next to `criticModel`:

```ts
  /** Grounder pass — emits the facts manifest the drafter cites against. */
  grounder: GrounderConfigSchema.default(() => ({ model: "fast" as const, timeoutSeconds: 1800 })),
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test test/unit/config/plan-schema.test.ts --timeout=60000
```

Expected: PASS.

- [ ] **Step 5: Re-point `groundOp`**

In `src/operations/ground.ts`, replace lines 2-3:

```ts
import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
```

with:

```ts
import { planConfigSelector } from "../config";
import type { PlanConfig } from "../config/selectors";
```

Then, in the same file, change every `DebateConfig` type parameter to `PlanConfig` (lines 106 and 153 as of `f4b3bbc7a`), and replace lines 159-161:

```ts
  config: debateConfigSelector,
  model: (_input, ctx) => ctx.config.debate?.grounder.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.debate?.grounder.timeoutSeconds ?? 1800) * 1000,
```

with:

```ts
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan?.grounder.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.grounder.timeoutSeconds ?? 1800) * 1000,
```

- [ ] **Step 6: Update the ground op test**

In `test/unit/operations/ground.test.ts`, replace every fixture that sets `debate: { grounder: ... }` with `plan: { grounder: ... }`. Keep the asserted model and timeout values unchanged — the point of the test is that the resolved tier and timeout are the same as before the move.

- [ ] **Step 7: Update the CLI config description**

In `src/cli/config-descriptions.ts`, add next to the other `plan.*` entries:

```ts
  "plan.grounder": "Grounder pass that emits the facts manifest the plan drafter cites against",
  "plan.grounder.model": "Model tier for the grounder pass (default: fast)",
  "plan.grounder.timeoutSeconds": "Grounder timeout in seconds (default: 1800)",
```

Leave the `debate.*` descriptions alone — PR 4 removes them as a block.

- [ ] **Step 8: Verify**

```bash
bun run typecheck && bun run test && bun run check:all && bun run test:coverage
```

- [ ] **Step 9: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "feat(config): move grounder settings from debate.grounder to plan.grounder

groundOp runs on the pipeline and single plan paths, with no debate
involved, but read its model tier and timeout out of the debate config
block. Defaults are unchanged (fast / 1800s), so no live run changes
behaviour. The debate.grounder key is retired in the deletion pass."
```

---

# PR 3 — Delete the debate engine

**Intent:** The actual removal. After this PR, `src/debate/` does not exist.

### Task 4: Delete the debate source tree and its operations

**Files:**
- Delete (whole directory): `src/debate/` — after PR 1 this is 31 files: `index.ts`, `concurrency.ts`, `resolvers.ts`, `runner.ts`, `runner-hybrid.ts`, `runner-plan.ts`, `runner-plan-deps.ts`, `runner-plan-helpers.ts`, `runner-stateful.ts`, `runner-stateful-helpers.ts`, `session-helpers.ts`, `types.ts`, `utils.ts`, `personas/index.ts`, `pre-phase/{grounder,index,registry,types}.ts`, `selectors/{index,judge,majority,pick,registry,synthesis,types,verifier-pick}.ts`, `verifiers/{index,plan-checklist,registry,types}.ts`
- Delete: `src/operations/debate-{hybrid,judge,plan,propose,rebut,stateful,synthesis}.ts`
- Delete: `src/plan/strategies/debate.ts`, `src/plan/strategies/debate-composition.ts`
- Delete: `src/prompts/builders/debate-builder.ts`
- Delete: `src/config/schemas-debate.ts`
- Modify: the barrels and call sites listed in Task 5

- [ ] **Step 1: Delete**

```bash
RTK_DISABLED=1 git rm -r src/debate
RTK_DISABLED=1 git rm src/operations/debate-hybrid.ts src/operations/debate-judge.ts \
  src/operations/debate-plan.ts src/operations/debate-propose.ts \
  src/operations/debate-rebut.ts src/operations/debate-stateful.ts \
  src/operations/debate-synthesis.ts
RTK_DISABLED=1 git rm src/plan/strategies/debate.ts src/plan/strategies/debate-composition.ts
RTK_DISABLED=1 git rm src/prompts/builders/debate-builder.ts
RTK_DISABLED=1 git rm src/config/schemas-debate.ts
```

- [ ] **Step 2: Run typecheck to enumerate the breakage**

```bash
bun run typecheck 2>&1 | tee /tmp/debate-typecheck.txt
```

Expected: FAIL, with errors pointing at exactly the files Task 5 edits. Use this output as the worklist — it is more authoritative than this document.

### Task 5: Repair every call site

**Files:** (each one, with what to do)

| File | Change |
|---|---|
| `src/operations/index.ts:31-42` | Delete the seven `debate-*` export blocks |
| `src/plan/strategies/factory.ts:2,14-15` | Delete the `DebatePlanStrategy` import and the `case "debate":` arm. The existing `default:` arm already throws `NaxError("[plan] Unknown plan mode: ...", "PLAN_MODE_UNKNOWN")` |
| `src/plan/strategies/index.ts:3-4` | Delete the `_debatePlanDeps` / `DebatePlanStrategy` / `buildPlanComposition` exports |
| `src/plan/strategies/types.ts:4,30,77` | Delete the `DebateRunner`/`DebateRunnerOptions` import, delete `createDebateRunner` from `PlanCommandOptions`, and narrow `IPlanStrategy["mode"]` to `"single" \| "pipeline" \| "refine"` |
| `src/plan/index.ts:6,14` | Delete the `_debatePlanDeps` and `DebatePlanStrategy` re-exports |
| `src/cli/plan-runtime/index.ts:15-16,106` | Delete the `DebateRunner` import and the `createDebateRunner` dep |
| `src/cli/plan-command.ts:21,38,41,44,148-153,210` | Delete the `buildPlanComposition` re-export; narrow `resolvePlanMode` to `"single" \| "pipeline" \| "refine"` and drop the `debate` branch (see Step 2 below); delete the `debateEnabled` warn block at 148-153 |
| `src/cli/plan.ts:4` | Delete the `buildPlanComposition` re-export |
| `src/cli/index.ts:52` | Delete `buildPlanComposition` from the export list |
| `src/cli/plan-decompose.ts:16,105-148` | Delete the `DebateStageConfig` import and the whole `debateDecompEnabled` branch, leaving the non-debate decompose path |
| `src/config/index.ts:2-9,82,126` | Delete the `debate/types` re-exports, the `DebateConfigSchema` export, and `debateConfigSelector` |
| `src/config/types.ts:8-17` | Delete the `debate/types` re-export block |
| `src/config/schema.ts:10-19` | Delete the `debate/types` re-export block |
| `src/config/runtime-types.ts:280,489-498,561-562` | Narrow `mode` to `"single" \| "pipeline" \| "refine"`; delete the `debate/types` re-export block; delete the `debate?:` field on the config interface |
| `src/config/schemas.ts:11,363-…` | Delete the `DebateConfigSchema` import and the whole `debate:` field with its default block |
| `src/config/schemas-infra.ts:17` | Narrow the enum to `z.enum(["single", "pipeline", "refine"])` |
| `src/config/selectors.ts:19,26,46,165` | Remove `"debate"` from the selector key list and from `planConfigSelector`'s pick list; delete `debateConfigSelector` and the `DebateConfig` type |
| `src/prompts/index.ts:24-26` | Delete the `DebatePromptBuilder` and `PromptBuilderOptions`/`ReviewStoryContext`/`StageContext` re-exports. **Check first** whether `StageContext` has non-debate consumers: `grep -rn "StageContext" src --include='*.ts' \| grep -v debate` — if it does, move the type into `src/prompts/types.ts` rather than deleting it |
| `src/context/engine/stage-config.ts:312-330` | Delete both the `"review-dialogue"` and the `debate` stage entries. Both are unreachable (see Findings) |
| `src/runtime/session-role.ts:39,74` | Delete the `` `debate-${string}` `` arm of `SessionRole` and the `startsWith("debate-")` predicate |
| `src/runtime/usage-auditor.ts:77` | Update the comment that names `debate-*` |

- [ ] **Step 1: Work the typecheck list until `bun run typecheck` is clean**

Apply the table above. Re-run `bun run typecheck` after every few edits — do not batch all of them blind.

- [ ] **Step 2: Narrow `resolvePlanMode`**

`src/cli/plan-command.ts:34-46` becomes:

```ts
/**
 * Resolution order:
 * 1. config.plan.mode (explicit user override)
 * 2. single (default)
 */
export function resolvePlanMode(config: NaxConfig): "single" | "pipeline" | "refine" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  return "single";
}
```

- [ ] **Step 3: Verify the source tree is clean**

```bash
grep -rin 'debate' src --include='*.ts'
```

Expected: **zero hits.** Prose comments that merely mention the word (for example `src/review/acks.ts:22`, `src/agents/manager-types.ts:305`) must be rewritten in this pass too — a comment that points at a subsystem that no longer exists is a trap for the next reader. Rewrite them to describe the current behaviour, do not just delete the sentence.

- [ ] **Step 4: Commit the source deletion**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "refactor: delete the multi-agent debate subsystem

Removes src/debate/, the seven debate operations, the debate plan
strategy and composition helper, DebatePromptBuilder and the debate
config schema.

The engine was opt-in and off by default (debate.enabled: false) and was
enabled in no live config. Its review half was already dead: the
review-stage config was retired in #1859, the review-dialogue context
stage was declared but never assembled (nax#1743), and
DebatePromptBuilder's five review-dialogue methods had zero production
callers.

The grounding, citation and plan-check machinery that lived under
src/debate/ was lifted to src/plan/grounding/ first and is untouched."
```

### Task 6: Delete and repair the tests

**Files:**
- Delete (whole directories): `test/unit/debate/`, `test/unit/operations/debate-*.test.ts`, `test/unit/operations/stateful-debater-op.test.ts`, `test/unit/plan/debate-strategy.test.ts`, `test/unit/plan/debate-composition.test.ts`, `test/unit/cli/plan-debate.test.ts`, `test/unit/cli/plan-decompose-debate.test.ts`, `test/unit/config/debate-schema.test.ts`, `test/unit/prompts/builders/debate-builder.test.ts`, `test/helpers/debate-runner.ts`
- Modify: the shared helpers and the ~20 tests that merely *reference* debate

- [ ] **Step 1: Delete the dedicated debate tests**

```bash
RTK_DISABLED=1 git rm -r test/unit/debate
RTK_DISABLED=1 git rm test/unit/operations/debate-hybrid.test.ts test/unit/operations/debate-judge.test.ts \
  test/unit/operations/debate-plan.test.ts test/unit/operations/debate-propose.test.ts \
  test/unit/operations/debate-rebut.test.ts test/unit/operations/debate-synthesis.test.ts \
  test/unit/operations/stateful-debater-op.test.ts
RTK_DISABLED=1 git rm test/unit/plan/debate-strategy.test.ts test/unit/plan/debate-composition.test.ts
RTK_DISABLED=1 git rm test/unit/cli/plan-debate.test.ts test/unit/cli/plan-decompose-debate.test.ts
RTK_DISABLED=1 git rm test/unit/config/debate-schema.test.ts
RTK_DISABLED=1 git rm test/unit/prompts/builders/debate-builder.test.ts
RTK_DISABLED=1 git rm test/helpers/debate-runner.ts
```

**Note:** `test/unit/debate/verifiers/checks.test.ts`, `test/unit/debate/facts-manifest.test.ts` and `test/unit/debate/citations.test.ts` were already moved to `test/unit/plan/grounding/` in PR 1. If any of them is still under `test/unit/debate/` at this point, **stop** — PR 1 did not complete and this `git rm -r` would delete live coverage.

- [ ] **Step 2: Repair the shared helpers**

```bash
grep -rn 'debate\|Debate' test/helpers --include='*.ts'
```

For each hit in `test/helpers/{index,mock-nax-config,dispatch-context,context-orchestrator,interaction-chain,merge-engine,optimizer-result,warn-spy,worktree-manager,assert-defined}.ts` and `test/helpers/e2e/scripted-agent.ts`: remove the `debate` key from config fixtures, remove `createDebateRunner` from dep fixtures, and remove `debate-*` from any session-role fixture. Do **not** stub the removed surface back in — a helper that fabricates a `debate` config key after the schema drops it is exactly the kind of green-but-wrong signal this repo has been bitten by before.

- [ ] **Step 3: Repair the remaining referencing tests**

```bash
grep -rln 'debate\|Debate' test --include='*.ts'
```

Work the list. The substantive ones:

- `test/unit/prompts/review-diff-frame-ssot.test.ts:55` — asserts the diff frame is identical across review prompt builders and uses `DebatePromptBuilder.buildResolverPrompt` as one of the compared builders. **Drop that builder from the comparison set; keep the test.** The SSOT property it guards still matters for the surviving semantic and adversarial builders.
- `test/unit/context/engine/stage-config.test.ts` and `test/unit/context/engine/stage-reachability.test.ts` — drop the `debate` and `review-dialogue` stage expectations.
- `test/unit/cli/plan-mode.test.ts`, `test/unit/plan/strategies-factory.test.ts`, `test/unit/plan/strategies.test.ts` — drop the `"debate"` mode cases; **add** a case asserting `createPlanStrategy("debate" as never)` now throws `PLAN_MODE_UNKNOWN`.
- `test/unit/config/{schemas,selectors,defaults-ssot,plan-schema,plan-mode-refine}.test.ts` — drop `debate` expectations.
- `test/unit/runtime/session-role.test.ts`, `test/unit/runtime/usage-auditor.test.ts` — drop `debate-*` role cases.
- `test/unit/operations/{op-tool-declarations,bash-declarations,call-correlation}.test.ts`, `test/unit/scripts/check-op-tool-capability.test.ts` — drop debate ops from the expected op lists.
- `test/unit/cli/plan-decompose-*.test.ts`, `test/unit/cli/plan-callop*.test.ts`, `test/integration/plan/plan-callop.test.ts` — drop the debate-decompose branch coverage.

- [ ] **Step 4: Verify**

```bash
bun run typecheck && bun run test
```

Expected: all pass, with no skipped or `.only` tests introduced.

- [ ] **Step 5: Confirm nothing in test/ still names the subsystem**

```bash
grep -rin 'debate' test --include='*.ts'
```

Expected: zero hits.

- [ ] **Step 6: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "test: drop debate coverage and repair shared fixtures

Deletes the dedicated debate test tree and removes debate config keys,
dep stubs and session-role fixtures from the shared helpers. Keeps
review-diff-frame-ssot with the surviving builders and adds a case
asserting createPlanStrategy rejects the retired 'debate' mode."
```

---

# PR 4 — Config guards, docs, rules, baselines

### Task 7: Warn-and-strip the retired config keys

**Files:**
- Modify: `src/config/config-guards.ts` (`REMOVED_NO_OP_KEYS` and its doc comment), `src/cli/config-descriptions.ts` (delete the whole `// Debate (US-001)` block)
- Test: `test/unit/config/strip-removed-noop-keys.test.ts`

- [ ] **Step 1: Write the failing test**

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

it("points a retired debate.grounder at plan.grounder", () => {
  const warnings: string[] = [];
  stripRemovedNoOpKeys({ debate: { grounder: { model: "fast" } } }, (m) => warnings.push(m));
  expect(warnings.join("\n")).toContain("plan.grounder");
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/unit/config/strip-removed-noop-keys.test.ts --timeout=60000
```

Expected: FAIL — the `debate` key survives.

- [ ] **Step 3: Implement**

In `src/config/config-guards.ts`, replace the existing `"debate.stages.review"` entry with a top-level one and extend the doc comment to say that the map now also covers whole retired subsystems, not just inert leaf keys:

```ts
  debate: "the multi-agent debate subsystem was removed; use `plan.mode` (single, pipeline or refine) instead, and `plan.grounder` for the grounder settings that were under `debate.grounder`",
```

Remove `"debate.stages.review"` — it is subsumed.

Confirm `stripRemovedNoOpKeys` already handles a non-dotted (top-level) key. If it only walks dotted paths, extend it — and say so in the PR body.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test test/unit/config/strip-removed-noop-keys.test.ts --timeout=60000
```

- [ ] **Step 5: Delete the debate CLI descriptions**

In `src/cli/config-descriptions.ts`, delete the block starting at the `// Debate (US-001)` comment through the last `debate.*` entry.

- [ ] **Step 6: Verify and commit**

```bash
bun run typecheck && bun run test && bun run check:all
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "feat(config): warn and strip the retired debate config block

Follows the #1859 precedent: warn rather than throw, so an existing
config carrying an inert debate block still loads, with a message
pointing at plan.mode and plan.grounder. Note that plan.mode: 'debate'
is a different case and now fails schema validation outright, because
silently downgrading it to 'single' would change a user's plan output
without telling them."
```

### Task 8: Docs, rules and profiles

**Files:**
- Delete: `docs/guides/debate.md`, `.nax/profiles/debate.json`, `.nax/profiles/opencode-debate.json`
- Modify: `docs/architecture/{ARCHITECTURE,subsystems,conventions,design-patterns}.md`, `docs/guides/{context-engine,semantic-review,acceptance-review-flow,prompt-customization,retry-strategy}.md`, `.nax/rules/{adapter-wiring,config-patterns,error-handling,forbidden-patterns-source,monorepo-awareness,test-architecture}.md`
- Leave alone: `docs/specs/*debate*`, `docs/adr/ADR-*`, `docs/plans/archive/**`, `docs/reviews/**`, dated `docs/2026*` review notes — these are historical records of what the codebase was, and rewriting them would falsify the record.

- [ ] **Step 1: Delete the guide and profiles**

```bash
RTK_DISABLED=1 git rm docs/guides/debate.md .nax/profiles/debate.json .nax/profiles/opencode-debate.json
```

- [ ] **Step 2: Update the living docs**

```bash
grep -rn 'debate\|Debate' docs/architecture docs/guides README.md
```

For each hit, rewrite the passage to describe the current architecture. Where a doc lists the plan modes, it must now read `single`, `pipeline`, `refine`. Where a doc lists subsystems, drop debate. Do not leave a dangling link to the deleted `docs/guides/debate.md`:

```bash
grep -rn 'guides/debate' docs README.md
```

Expected after the edit: zero hits.

- [ ] **Step 3: Update the canonical rules (not the mirror)**

```bash
grep -rn 'debate\|Debate' .nax/rules/
```

Edit `.nax/rules/*.md` only. Then regenerate the `.claude/rules/` mirror — **never hand-edit it**:

```bash
bun run check:rules-drift
```

If it reports drift, run the repo's rules generation step and re-check. Do not silence the gate.

- [ ] **Step 4: Add a note to the specs index**

Prepend a one-line status banner to `docs/specs/SPEC-multi-agent-debate.md`:

```markdown
> **Status: RETIRED 2026-09-20.** The debate subsystem was deleted. This
> spec is kept as a historical record of what was built; nothing in it
> describes current behaviour.
```

Do the same for `docs/specs/SPEC-enhanced-debate-phase-1.md`, `SPEC-enhanced-debate-phase-2.md`, `SPEC-debate-resolver-dialogue.md`, `SPEC-debate-session-mode.md` and `SPEC-debate-bounded-concurrency.md`. Do not edit their bodies.

- [ ] **Step 5: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "docs: retire the debate guide, profiles and rule references

Deletes docs/guides/debate.md and the two debate profiles, updates the
architecture and guide docs to the surviving plan modes, and banners the
debate specs as retired. Historical records (ADRs, archived plans, dated
review notes) are left as written."
```

### Task 9: Baselines and final verification

**Files:**
- Modify: `scripts/baselines/file-sizes-baseline.json`, `scripts/baselines/test-escape-hatches-baseline.json`, `scripts/baselines/coverage-per-file-baseline.json`, `scripts/baselines/op-tool-capability-baseline.json`, `scripts/baselines/import-cycles-baseline.json`

- [ ] **Step 1: Remove the stale file-size entry**

`scripts/baselines/file-sizes-baseline.json` line 11 holds `"test/unit/debate/runner-plan.test.ts": 1038`. That file is gone. Delete the entry by hand rather than regenerating the whole baseline — a blanket regenerate would silently absorb any *other* file that has drifted over the cap.

- [ ] **Step 2: Regenerate the ratcheted baselines**

Each of these is a ratchet: the deletion legitimately lowers the counts, and leaving them high would let future debt back in unnoticed.

```bash
bun run check:file-sizes
bun run test:coverage:update
bun run check:op-tool-capability:update
bun run check:import-cycles:update
```

For `test-escape-hatches-baseline.json` (20 debate entries):

```bash
bun run check:test-escape-hatches:update
```

Then confirm:

```bash
grep -c 'debate' scripts/baselines/test-escape-hatches-baseline.json   # expect 0 when done
```

- [ ] **Step 3: Review every baseline diff before staging**

```bash
RTK_DISABLED=1 git diff scripts/baselines/
```

Every changed line must be attributable to a file this branch deleted. A loosened threshold on a file that still exists is a regression hiding in a regenerate — if you see one, stop and report it.

- [ ] **Step 4: Full verification**

```bash
bun run typecheck
bun run lint
bun run check:all
bun run test
bun run test:e2e
bun run test:coverage
```

All six must pass. Record the actual output; do not claim a pass you have not seen.

- [ ] **Step 5: Final sweep**

```bash
grep -rin 'debate' src test scripts bin --include='*.ts' --include='*.json'
```

Expected: zero hits.

- [ ] **Step 6: Measure the cut, for the PR body**

```bash
RTK_DISABLED=1 git diff --stat origin/main...HEAD | tail -1
```

- [ ] **Step 7: Commit**

```bash
RTK_DISABLED=1 git add -A
RTK_DISABLED=1 git commit -m "chore: ratchet baselines after the debate deletion"
```

- [ ] **Step 8: Code review before any push**

Run the repo's post-implementation review on the full branch diff **before** pushing or opening a PR — not after. Do not take a subagent's "all green" at face value; re-run the gates yourself.

- [ ] **Step 9: Stop and get approval**

Do **not** push or open a PR without explicit approval at that moment.

---

## Open questions for the reviewer

These do not block execution — each has a stated default — but flag them in the PR 3 description so the owner can overrule:

1. **`plan.mode: "debate"` now hard-fails config parsing** (Decision 4). If the owner prefers a silent downgrade to `single`, that is a one-line change in `resolvePlanMode` plus a `REMOVED_NO_OP_KEYS` entry instead of an enum narrowing.
2. **`src/plan/grounding/` as the survivors' home** (Decision 1). The alternative is `src/plan/` flat. The subdirectory keeps the three files together and leaves room for the grounder pre-phase if it is ever revived outside a debate.
3. **`StageContext`, `PromptBuilderOptions` and `ReviewStoryContext`** are currently exported from `src/prompts/index.ts` via the debate builder. Task 5 says to check for non-debate consumers and relocate rather than delete if any exist. If that check finds consumers, the relocation is worth calling out separately in the PR body.
