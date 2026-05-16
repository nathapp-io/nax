# SPEC: Plan Prompt Overrides (Option A — File-Based)

## Summary

Extend the existing `prompts.overrides` config system to support two plan-specific override keys:
`"plan-refine-checks"` and `"plan-quality-rules"`. When configured, the file contents replace
the corresponding hardcoded prompt block in `PlanPromptBuilder` — the check block in
`buildRefineContinuation()` and the shared quality-rules block injected by `build()` /
`buildDraft()`. This enables iterating on planning prompts without rebuilding nax, and allows
per-project prompt customization via `.nax/config.json`.

## Motivation

Plan prompts (`buildRefineContinuation`, `buildSharedQualityRules`) are the highest-leverage
text in the system — they govern how stories, acceptance criteria, routing, and refine audits
are generated. Today, any change requires modifying source code and rebuilding. Two concrete
pain points:

1. **Prompt tuning is slow.** The `backtester-phase-2` audit revealed three gaps in the refine
   checks that required a code change to fix. With file-based overrides, the same iteration
   happens by editing a markdown file and re-running `nax plan`.
2. **No per-project customization.** A Go project's AC patterns differ from a TypeScript one.
   The shared quality rules are generic; per-project override files let teams inject
   project-specific examples without forking nax.

The existing `prompts.overrides` system already handles TDD role overrides (`test-writer`,
`implementer`, etc.) via the same file-path-in-config → `loadOverride()` → builder pattern.
This feature extends that system to two new plan-specific keys using the identical mechanism.

## Design

### Override keys

Two new keys added to `PromptRole` and `PromptsConfig.overrides`:

| Key | Replaces | Builder method |
|:----|:---------|:---------------|
| `"plan-refine-checks"` | The `####`-delimited check block in `buildRefineContinuation()` | `PlanPromptBuilder.buildRefineContinuation()` |
| `"plan-quality-rules"` | Output of `buildSharedQualityRules()` | `build()`, `buildDraft()` |

### File format

Plain markdown. The entire file content replaces the corresponding block verbatim. No special
markers or delimiters required. Example `.nax/prompts/plan-refine-checks.md`:

```markdown
#### ac-testable
For each acceptance criterion, ask whether the assertion is observable through a return
value, exception, log output, file content, or state change. If any AC is not directly
testable, rewrite it so it is observable.

#### codebase-fit
For each story, verify:
1. Proposed files, helpers, tests, and dependencies match the codebase context.
2. Each AC's semantic meaning matches the spec's actual interface and data flow.

#### my-project-specific-check
Project-specific rule injected here.
```

### Config shape (unchanged schema structure)

```json
{
  "prompts": {
    "overrides": {
      "plan-refine-checks": ".nax/prompts/plan-refine-checks.md",
      "plan-quality-rules": ".nax/prompts/plan-quality-rules.md"
    }
  }
}
```

Paths are relative to `workdir` — the project root where `.nax/` lives. Global overrides
(`~/.nax/config.json`) follow the same convention relative to `globalConfigDir()`.

### Builder interface changes

```typescript
// buildRefineContinuation — new optional overrides param
buildRefineContinuation(
  outputFilePath: string,
  overrides?: { checks?: string },
): string

// build — new optional overrides param (appended after proposers)
build(
  specContent: string,
  codebaseContext: string,
  outputFilePath?: string,
  packages?: string[],
  packageDetails?: PackageSummary[],
  projectProfile?: ProjectProfile,
  proposers?: { fileReadAccess?: boolean; fileReadBudget?: number },
  overrides?: { qualityRules?: string },
): PlanningPromptParts

// PlanDraftBuildInput — new optional field
export interface PlanDraftBuildInput {
  // ... existing fields ...
  qualityRulesOverride?: string;
}
```

When `overrides.checks` is provided, `buildRefineContinuation()` replaces the entire
`####`-block section with the override content. When `overrides.qualityRules` is provided,
`buildSharedQualityRules()` returns the override string verbatim instead of the hardcoded
rules. If the override is absent or empty, the hardcoded default is used unchanged.

### Loading flow

Override loading happens in plan strategies, not in the operation's `build()` callback
(which is synchronous). Each strategy reads from `ctx.fullConfig.prompts?.overrides` via
the existing `loadOverride(key, workdir, config)` from `src/prompts/loader.ts`, then passes
the result into the op input struct.

```
PlanModeContext.fullConfig.prompts.overrides["plan-refine-checks"]
  → loadOverride("plan-refine-checks", ctx.workdir, ctx.fullConfig)   [async, in strategy]
  → PlanRefineInput.planRefineChecksOverride                           [threaded through op input]
  → planRefineOp.build() → PlanPromptBuilder.buildRefineContinuation(path, { checks: override })
```

### Operation input struct changes

```typescript
// plan.ts
export interface PlanInteractiveInput {
  // ... existing fields ...
  qualityRulesOverride?: string;
}

// plan-refine.ts
export interface PlanRefineInput {
  // ... existing fields ...
  planRefineChecksOverride?: string;
  qualityRulesOverride?: string;
}

// plan-draft.ts: uses PlanDraftBuildInput directly (already extended above)
```

### Failure handling

| Condition | Behavior |
|:----------|:---------|
| Key not in `prompts.overrides` | Use hardcoded default — no-op |
| Key set, file missing at precheck | Existing precheck emits warning (non-blocking); existing loop covers new keys automatically |
| Key set, file missing at runtime | `loadOverride()` returns `null`; strategy passes `undefined`; builder uses default |
| Key set, file unreadable (permissions) | `loadOverride()` throws; strategy catches, logs WARN at `[plan]` stage with `storyId`, uses default |

Fail-open on all error paths — a bad override path never blocks planning.

### Integration points

- **Type extension:** `src/prompts/core/types.ts` (`PromptRole`), `src/config/runtime-types.ts` (`PromptsConfig`), `src/config/schemas-infra.ts` (schema refine allowed-keys list)
- **Builder:** `src/prompts/builders/plan-builder.ts`
- **Operations:** `src/operations/plan.ts`, `src/operations/plan-refine.ts`, `src/operations/plan-draft.ts`
- **Strategies:** `src/plan/strategies/single.ts`, `src/plan/strategies/refine.ts`, `src/plan/strategies/debate.ts`, `src/plan/strategies/pipeline.ts`
- **Descriptions:** `src/cli/config-descriptions.ts`
- **Precheck:** No changes needed — existing loop in `src/precheck/checks-warnings.ts` already iterates all `prompts.overrides` keys

### Existing pattern to follow

`src/prompts/loader.ts` — `loadOverride(role, workdir, config)` is the SSOT for reading override files. All new loading must go through this function. No direct `Bun.file()` calls in strategies.

## Stories

### US-001: Extend PromptRole and PromptsConfig for plan override keys

Add `"plan-refine-checks"` and `"plan-quality-rules"` to `PromptRole`, `PromptsConfig.overrides`,
the schema allowed-keys refine, and `config-descriptions.ts`. No precheck changes required —
the existing precheck loop covers all `prompts.overrides` keys automatically.

**Size:** Simple (4 ACs, ~30 LOC, 4 files)

**Dependencies:** none

#### Context Files
- `src/prompts/core/types.ts` — `PromptRole` union (line 9) — add new members here
- `src/config/runtime-types.ts` — `PromptsConfig.overrides` type (line 476) — extend union
- `src/config/schemas-infra.ts` — `PromptsConfigSchema` (line 198) — extend refine allowed-keys list
- `src/cli/config-descriptions.ts` — `"prompts.overrides"` block (line 231) — add descriptions for new keys

#### Acceptance Criteria
- `PromptRole` type in `src/prompts/core/types.ts` includes `"plan-refine-checks"` and `"plan-quality-rules"` as valid members.
- `PromptsConfig.overrides` in `src/config/runtime-types.ts` accepts `"plan-refine-checks"` and `"plan-quality-rules"` as keys without TypeScript error.
- `PromptsConfigSchema` in `src/config/schemas-infra.ts` parses `{ overrides: { "plan-refine-checks": ".nax/prompts/plan-refine-checks.md" } }` without a Zod error; it rejects `{ overrides: { "unknown-key": "path" } }` with a Zod error.
- `src/cli/config-descriptions.ts` includes description entries for `"prompts.overrides.plan-refine-checks"` and `"prompts.overrides.plan-quality-rules"` following the same format as the existing `"prompts.overrides.test-writer"` entry.

---

### US-002: PlanPromptBuilder accepts and applies override content

Modify `buildRefineContinuation()`, `build()`, and `buildSharedQualityRules()` to accept
optional override strings and substitute them for the hardcoded blocks when provided.
Extend `PlanDraftBuildInput` with `qualityRulesOverride?`.

**Size:** Simple (6 ACs, ~20 LOC, 1 file)

**Dependencies:** none (builder changes are independent of config wiring)

#### Context Files
- `src/prompts/builders/plan-builder.ts` — `buildRefineContinuation()` (line 162), `build()` (line 195), `buildSharedQualityRules()` (line 36), `PlanDraftBuildInput` (line 60)

#### Acceptance Criteria
- `buildRefineContinuation(outputFilePath, { checks: "## custom checks" })` returns a string containing `"## custom checks"` and does not contain the hardcoded `"#### ac-testable"` text.
- `buildRefineContinuation(outputFilePath)` (no override) returns a string containing the hardcoded `"#### ac-testable"` text.
- `build(spec, ctx, path, undefined, undefined, undefined, undefined, { qualityRules: "## custom rules" })` returns `taskContext` containing `"## custom rules"` and not containing the hardcoded `"## Story Rules"` text.
- `build(spec, ctx, path)` (no override) returns `taskContext` containing the hardcoded `"## Story Rules"` text.
- `new PlanPromptBuilder().buildDraft({ ..., qualityRulesOverride: "## custom rules" })` produces a `task.content` string containing `"## custom rules"` and not containing the hardcoded `"## Story Rules"` text.
- When `overrides.checks` is an empty string, `buildRefineContinuation()` falls back to the hardcoded check block (empty override treated as absent).

---

### US-003: Wire override loading into plan strategies and operations

Add `qualityRulesOverride?` to `PlanInteractiveInput` and both fields to `PlanRefineInput`.
Extend `planInteractiveOp.build()` and `planRefineOp.build()` to pass overrides to the builder.
Each strategy (`single`, `refine`, `debate`, `pipeline`) loads applicable overrides from
`ctx.fullConfig` via `loadOverride()` before invoking `callOp`.

**Size:** Medium (7 ACs, ~60 LOC, 7 files)

**Dependencies:** US-001, US-002

#### Context Files
- `src/prompts/loader.ts` — `loadOverride(role, workdir, config)` — the loading function to call (line 20)
- `src/operations/plan.ts` — `PlanInteractiveInput` and `planInteractiveOp.build()` — add `qualityRulesOverride?` field and pass to builder
- `src/operations/plan-refine.ts` — `PlanRefineInput` and `planRefineOp.build()` — add `planRefineChecksOverride?` + `qualityRulesOverride?` and pass to builder
- `src/operations/plan-draft.ts` — `planDraftOp.build()` — pass `input.qualityRulesOverride` to `buildDraft()`
- `src/plan/strategies/single.ts` — load `plan-quality-rules` override, inject into `PlanInteractiveInput`
- `src/plan/strategies/refine.ts` — load both overrides, inject into `PlanRefineInput`
- `src/plan/strategies/debate.ts` — load `plan-quality-rules` override, inject into `PlanInteractiveInput`
- `src/plan/strategies/pipeline.ts` — load `plan-quality-rules` override, inject into `PlanDraftBuildInput` via the op input

#### Acceptance Criteria
- When `config.prompts.overrides["plan-refine-checks"]` points to a file containing `"#### custom-check"`, `planRefineOp.build()` returns a prompt string containing `"#### custom-check"` and not containing `"#### ac-testable"`.
- When `config.prompts.overrides["plan-quality-rules"]` points to a file containing `"## custom-rules"`, `planInteractiveOp.build()` returns a prompt string containing `"## custom-rules"` and not containing `"## Story Rules"`.
- When `config.prompts.overrides["plan-quality-rules"]` points to a file containing `"## custom-rules"`, `planDraftOp.build()` returns a prompt string containing `"## custom-rules"`.
- When the override file path is set but the file does not exist at runtime, the strategy catches the null return from `loadOverride()`, passes `undefined` to the op input, and the resulting prompt uses the hardcoded default (no error thrown).
- When `config.prompts.overrides` has no plan-specific keys, all four strategies pass `undefined` for override fields and the resulting prompts are identical to their pre-feature output.
- `SinglePlanStrategy`, `RefinePlanStrategy`, `DebatePlanStrategy`, and `PipelinePlanStrategy` each call `loadOverride()` only for the override keys relevant to their mode — `"plan-refine-checks"` is loaded only by `RefinePlanStrategy`; `"plan-quality-rules"` is loaded by all four.
- When the override file is unreadable (permissions error), the strategy logs a WARN via the project logger at stage `"plan"` with `storyId` set to the feature name, then falls back to the hardcoded default without throwing.
