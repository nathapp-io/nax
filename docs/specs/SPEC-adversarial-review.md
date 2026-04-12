# SPEC: Adversarial Review Check (REVIEW-003)

## Summary

Add an LLM-based `adversarial` review check that runs alongside the existing `semantic` check as a second, independently-prompted review lens. Where semantic review asks *"does this satisfy the acceptance criteria?"*, adversarial review asks *"where does this break, and what did the implementer stop short of finishing?"* The two checks are complementary — semantic is constructive and intent-based; adversarial is destructive and risk-based. Both emit findings into the same `reviewFindings[]` pipeline context; the existing autofix/rectification loop consumes the union.

## Motivation

`logs/code-quality-gap.md` documented four blind spots that landed in PR 384/385 despite passing all existing checks (typecheck, lint, test, build, semantic):

1. A `_role` constructor parameter silently discarded — "fixed" by renaming to `_role` rather than using it
2. A missing `one-shot-builder.test.ts` sibling file — audit gap, not a visible failure
3. Dual import styles (barrel vs deep path) mixed in the same module
4. `_`-prefixed parameters used as a "done" signal rather than a correctness fix

None of these are caught by the existing stack:

- **Lint/typecheck/build** — all pass. These are not syntactic defects.
- **Semantic review** — its prompt (`src/prompts/builders/review-builder.ts:17-36`) explicitly scopes itself to AC verification and excludes anything "lint handles," which a reviewing LLM interprets as *"only flag AC violations."* An AC like *"builder produces a valid prompt"* is satisfied even when half the constructor arguments are discarded.
- **Debate (`debate.stages.review`)** — has adversarial personas (`src/debate/personas.ts:13-49`: `challenger`, `completionist`, `testability`) but is a heavier mechanism (multi-debater + synthesizer, 4–6 sessions per review) that runs only when explicitly enabled, not the default review path.

The common thread across the four gaps is **signals of incomplete implementation**: work that was started, got to compile, and was abandoned before being carried through. An AC-verifier cannot catch this because an AC can be satisfied by half-abandoned code. A reviewer with an explicit mandate to look for weakness catches all four as a single category.

### Why not just improve the semantic prompt

Explored and rejected. Folding adversarial responsibilities into the semantic prompt asks one LLM call to hold two conflicting cognitive stances simultaneously: confirmation ("does it work?") and skepticism ("where does it break?"). In practice, LLMs default to one stance and pay lip service to the other, diluting both. The two lenses are genuinely distinct and deserve distinct prompts.

### Why not a checklist of custom rules via `semantic.rules`

Explored and rejected. A custom rule list encodes today's known gaps and misses tomorrow's novel abandonment patterns. A separate reviewer with a mandate to *probe for weakness as a category* generalizes. Heuristics inside the adversarial prompt serve as illustrative anchors, not pattern matches.

## Non-Goals

- **No new human-gate primitive.** Nax is autonomous-first. Unresolved reviewer disagreements flow through the existing tier-escalation ladder (fast → balanced → powerful), not a new "pause for human review" state.
- **No replacement of semantic review.** Semantic review stays as-is. Adversarial is additive.
- **No merging with debate.** Debate remains a separate, heavier mechanism controlled via the top-level `debate` config. Adversarial is a lightweight single-call review, not a multi-agent proposal/synthesis flow.
- **No pre-detection of reviewer conflicts.** Regex-matching "add X" vs "remove X" in finding suggestions is too fragile. The rectifier's own LLM reasoning handles contradictions at fix time.
- **No default-on rollout.** Ships off by default; opt-in via `review.checks` array membership.

## Design

### Where It Fits

Adversarial review is a new **review check** — same level as `typecheck`, `lint`, `test`, `build`, `semantic`. It runs inside the existing review stage via `runReview()` (`src/review/runner.ts`), alongside semantic review.

```
Pipeline: execute → verify → rectify → review → autofix
                                          ↓
                              typecheck → lint → build → semantic → adversarial
                                                            ↓           ↓
                                                         findings[]  findings[]
                                                            ↓           ↓
                                                      ctx.reviewFindings (union)
```

### Config

Mirrors the existing `SemanticReviewConfigSchema` shape. Enablement is via membership in `review.checks`, not a separate `enabled` flag.

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic", "adversarial"],
    "semantic": {
      "modelTier": "balanced",
      "diffMode": "embedded",
      "rules": []
    },
    "adversarial": {
      "modelTier": "balanced",
      "diffMode": "ref",
      "rules": [],
      "timeoutMs": 180000,
      "excludePatterns": [],
      "parallel": false,
      "maxConcurrentSessions": 2
    }
  }
}
```

Schema additions in `src/config/schemas.ts`:

```typescript
// 1. Extend ReviewCheckName union
checks: z.array(z.enum([
  "typecheck", "lint", "test", "build",
  "semantic",
  "adversarial",   // new
]))

// 2. Add AdversarialReviewConfigSchema (mirrors SemanticReviewConfigSchema)
const AdversarialReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  /**
   * Diff mode — inherited from REVIEW-002 (PR 388).
   * "embedded": diff embedded in prompt, truncated at DIFF_CAP_BYTES.
   * "ref": stat summary + storyGitRef passed; reviewer self-serves full diff via tools.
   * Default: "ref" — adversarial benefits from seeing the full diff (including tests)
   * without hitting the 50KB embedded cap.
   */
  diffMode: z.enum(["embedded", "ref"]).default("ref"),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(10_000).default(180_000),
  excludePatterns: z.array(z.string()).default([]),

  // New fields specific to adversarial
  parallel: z.boolean().default(false),
  maxConcurrentSessions: z.number().int().min(1).default(2),
  // NOTE: No maxRetries here — see "Retry Bounding" section below.
});

// 3. Attach as optional sub-config on ReviewConfigSchema
adversarial: AdversarialReviewConfigSchema.optional(),
```

**Defaults justification:**
- `diffMode: "ref"` — adversarial review needs to see the full diff including test files. In embedded mode, the 50KB `DIFF_CAP_BYTES` cap (`src/review/semantic.ts:46`) truncates large diffs — adversarial hits this sooner because it doesn't exclude test files. In ref mode, the reviewer self-serves the full diff without a cap, and can run both `git diff ... -- .` (full) and `git diff ... -- . :!test/` (prod-only) to compare production vs test coverage independently. This also eliminates the need for pre-computed `ReviewDiffArtifacts` — the reviewer decides what to inspect at runtime.
- `parallel: false` — conservative rollout. Users opt into parallelism once they have hardware headroom.
- `maxConcurrentSessions: 2` — caps effective concurrency when semantic+debate is combined with adversarial. See **Concurrency Guardrail** below.
- `modelTier: "balanced"` — matches semantic default; adversarial quality is sensitive to model strength, don't default to cheap.
- No `maxRetries` — retry bounding is handled by existing infrastructure. See **Retry Bounding** section below.

**Debate stays out of this config block.** If users want debate on adversarial review, they configure it under the top-level `debate.stages` namespace, same as today for semantic. No nesting.

### Execution Modes

Three modes driven by `review.adversarial.parallel` and `maxConcurrentSessions`:

| Mode | Trigger | Behavior | Peak sessions | Wall-clock |
|:---|:---|:---|:---|:---|
| **Disabled** | `"adversarial"` not in `checks` | No change from today | 1 (semantic) | 1x baseline |
| **Sequential** | `checks` includes both, `parallel: false` | `await semantic(); await adversarial();` | 1 at a time | ~2x |
| **Parallel** | `checks` includes both, `parallel: true`, effective concurrency ≤ cap | `Promise.all([semantic, adversarial])` | 2 | ~1x |
| **Forced sequential** | `parallel: true` but cap exceeded (e.g. semantic+debate) | Falls back to sequential | ≤ cap | ~2x |

**Concurrency guardrail.** Before scheduling, compute effective session count:

```typescript
const semSessions = isDebateEnabledFor("review") ? debateConfig.debaters.length + 1 : 1
const advSessions = 1   // adversarial itself; debate-on-adversarial is out of scope
const canParallelize =
  advConfig.parallel && (semSessions + advSessions) <= advConfig.maxConcurrentSessions
```

This prevents the blow-up case where semantic has 4 debaters + synthesizer running in parallel with adversarial, producing 5+ concurrent `agent.run()` sessions contending for memory, rate limits, and the logger JSONL file.

### LLM Prompt — Adversarial Role

New builder at `src/prompts/builders/adversarial-review-builder.ts`, parallel to `ReviewPromptBuilder`. Types imported from `src/review/types.ts` to avoid the same circular-dependency trap documented in `review-builder.ts:7-9`.

#### Builder API — Mirrors REVIEW-002 Options Pattern

PR 388 (REVIEW-002) introduced `SemanticReviewPromptOptions` — a structured options object for `ReviewPromptBuilder.buildSemanticReviewPrompt()` (`src/prompts/builders/review-builder.ts:63-76`). The adversarial builder mirrors this API shape:

```typescript
/** Options for buildAdversarialReviewPrompt */
export interface AdversarialReviewPromptOptions {
  /** Diff mode: embedded includes diff in prompt, ref includes git ref + stat */
  mode: "embedded" | "ref";
  /** Pre-collected diff — all files including tests (used when mode = "embedded") */
  diff?: string;
  /** Git baseline ref (used when mode = "ref") */
  storyGitRef?: string;
  /** Git diff --stat output (used in both modes for file overview) */
  stat?: string;
  /** Prior failure context for attempt awareness — reuses semantic's PriorFailure type */
  priorFailures?: PriorFailure[];
  /** Exclude patterns — intentionally empty by default (adversarial sees tests) */
  excludePatterns?: string[];
  /** Pre-computed test inventory (used in embedded mode; in ref mode the reviewer self-serves) */
  testInventory?: TestInventory;
}

export interface TestInventory {
  addedTestFiles: string[];
  modifiedTestFiles: string[];
  newSourceFilesWithoutTests: string[];
}
```

The `PriorFailure` type is imported from `src/prompts/builders/review-builder.ts` (already exported by PR 388). The `buildAttemptContextBlock()` helper from the same file is reused directly — no duplication.

#### Prompt Constants

```typescript
const ADVERSARIAL_ROLE =
  "You are an adversarial code reviewer with access to the repository files. " +
  "Your job is NOT to confirm correctness — semantic review handles that. " +
  "Your job is to find what is wrong, what is missing, and what the implementer " +
  "stopped short of finishing.";

const ADVERSARIAL_INSTRUCTIONS = `## Instructions

Assume the implementer was optimistic and stopped as soon as the happy path
worked. Your mandate is to break that optimism by looking for signals of
incomplete implementation, fragile assumptions, and unhandled weakness.

**Before reporting any finding as "error", you MUST verify it using your tools:**
- READ the relevant file to confirm the code actually looks the way you think.
- GREP for wiring/callers before claiming something is unused or unreferenced.
- Do NOT flag something based solely on its absence from the diff — it may
  already exist in the codebase. Check the actual file first.
- If you cannot verify a claim even after checking, use "unverifiable" severity.

The questions you are answering:

1. **Input handling.** What inputs will this mishandle? (empty, null, unicode,
   very large, concurrent, malformed)
2. **Error paths.** What failure modes exist but are not exercised, propagated,
   or surfaced to the caller?
3. **Abandonment signals.** What did the implementer accept but not actually
   use — parameters silently discarded, arguments renamed with a \`_\` prefix
   to suppress linter warnings, options passed through and ignored, TODO/FIXME
   left on the hot path?
4. **Test audit gap.** What new exported unit (class, builder, handler, function)
   was added without a corresponding test file? Use the test-file inventory
   provided below (in embedded mode) or the git commands (in ref mode) to check.
5. **Convention breaks.** What pattern exists elsewhere in this module that
   this code doesn't follow? (import style, error wrapping, logger usage,
   naming)
6. **Load-bearing assumptions.** What assumption is critical but unchecked?
   (type narrowing, non-null, ordering, uniqueness)

These are **heuristics, not an exhaustive checklist** — apply judgment. The
underlying question you are answering is: "does this look like someone finished
the job, or like someone got it to compile and moved on?"

Severity:
- "error" — you are confident this will cause a real failure or regression
- "warn" — the code is fragile or incomplete but may ship
- "info" — a note worth considering but not actionable
- "unverifiable" — you suspect a problem but could not confirm it`;

const ADVERSARIAL_OUTPUT_SCHEMA = `Respond with JSON only:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warn" | "info" | "unverifiable",
      "category": "input" | "error-path" | "abandonment" | "test-gap" | "convention" | "assumption",
      "file": "path/to/file",
      "line": 42,
      "issue": "description of the weakness",
      "suggestion": "how to strengthen it"
    }
  ]
}

If the implementation looks complete and robust, respond with
{ "passed": true, "findings": [] }.`;
```

#### Prompt Assembly — Mode Branching

The builder branches on `mode`, mirroring `ReviewPromptBuilder.buildSemanticReviewPrompt()` (`review-builder.ts:102-107`):

```typescript
export class AdversarialReviewPromptBuilder {
  buildAdversarialReviewPrompt(
    story: SemanticStory,
    adversarialConfig: AdversarialReviewConfig,
    options: AdversarialReviewPromptOptions,
  ): string {
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const customRulesBlock = adversarialConfig.rules.length > 0
      ? `\n## Additional Adversarial Rules\n${adversarialConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
      : "";
    // Reuse semantic's attempt-context helper — no duplication
    const attemptContextBlock = buildAttemptContextBlock(options.priorFailures);

    let diffSection: string;
    if (options.mode === "ref") {
      diffSection = buildAdversarialRefDiffSection(
        options.storyGitRef ?? "",
        options.stat ?? "",
      );
    } else {
      diffSection = buildAdversarialEmbeddedDiffSection(
        options.diff ?? "",
        options.testInventory,
      );
    }

    const core = `${ADVERSARIAL_ROLE}

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}
${customRulesBlock}${attemptContextBlock}${diffSection}
${ADVERSARIAL_INSTRUCTIONS}
${ADVERSARIAL_OUTPUT_SCHEMA}`;

    return wrapJsonPrompt(core);
  }
}
```

#### Diff Section — Embedded vs Ref Mode

**Embedded mode** (`diffMode: "embedded"`):

The diff includes all files (production + test). Unlike semantic, adversarial does **not** apply `excludePatterns` to strip test files — tests are within scope. The pre-computed `TestInventory` is injected directly:

```typescript
function buildAdversarialEmbeddedDiffSection(diff: string, inventory?: TestInventory): string {
  let inventoryBlock = "";
  if (inventory) {
    const added = inventory.addedTestFiles.map((f) => `- ${f} (added)`).join("\n");
    const modified = inventory.modifiedTestFiles.map((f) => `- ${f} (modified)`).join("\n");
    const missing = inventory.newSourceFilesWithoutTests.map((f) => `- ${f}`).join("\n");
    inventoryBlock = `## Test File Inventory
${added}${modified ? "\n" + modified : ""}

## New Source Files Without a Matching Test File
${missing || "(none)"}

`;
  }
  return `${inventoryBlock}## Git Diff (all files — production and tests)

\`\`\`diff
${diff}\`\`\`

`;
}
```

**Ref mode** (`diffMode: "ref"`, **recommended default**):

No diff embedded. The reviewer self-serves via git commands. Crucially, the adversarial ref section provides **different commands** from semantic's — no `excludePatterns`, because test files are in scope:

```typescript
function buildAdversarialRefDiffSection(storyGitRef: string, stat: string): string {
  const fullDiffCmd = `git diff --unified=3 ${storyGitRef}..HEAD`;
  const prodDiffCmd = `git diff --unified=3 ${storyGitRef}..HEAD -- . ':!test/' ':!*.test.ts' ':!.nax/' ':!.nax-pids'`;
  const newFilesCmd = `git diff --name-only --diff-filter=A ${storyGitRef}..HEAD`;
  const logCmd = `git log --oneline ${storyGitRef}..HEAD`;

  return `## Changed Files
\`\`\`
${stat}
\`\`\`

## Git Baseline: \`${storyGitRef}\`

To inspect the implementation:
- Full diff (production + tests): \`${fullDiffCmd}\`
- Production-only diff: \`${prodDiffCmd}\`
- New files added: \`${newFilesCmd}\`
- Commit history: \`${logCmd}\`

For test audit (question 4): compare new source files from \`${newFilesCmd}\` against test files.
If a new \`src/foo/bar.ts\` has no matching \`test/**/bar.test.ts\`, flag it.

Use these commands to inspect the code. Do NOT rely solely on the file list above — read the actual diff and files to verify each finding.

`;
}
```

In ref mode, the reviewer computes the test inventory itself via `git diff --name-only --diff-filter=A`. This eliminates the need for pre-computed `ReviewDiffArtifacts` — the reviewer decides what to inspect at runtime.

#### Prompt Structure — Differences from Semantic

1. **Diff scope.** Semantic excludes test files (via `excludePatterns`); adversarial includes them. In ref mode, the adversarial prompt provides both `fullDiffCmd` (with tests) and `prodDiffCmd` (without) so the reviewer can compare production coverage against test coverage.

2. **Attempt context.** Both reviewers include the `## Attempt Context` block from PR 388 when `priorFailures` is non-empty. The adversarial reviewer reuses `buildAttemptContextBlock()` from `src/prompts/builders/review-builder.ts` — no duplication.

3. **Test inventory.** In embedded mode, the pre-computed `TestInventory` is injected as a structured block. In ref mode, the reviewer self-serves via `git diff --name-only --diff-filter=A` and a prompt instruction to compare against `test/` directory. Ref mode is preferred because it avoids the 50KB diff cap and doesn't require pre-computation.

4. **`category` field.** Adversarial findings include a `category` field (`"input" | "error-path" | "abandonment" | "test-gap" | "convention" | "assumption"`) in the output schema, absent in semantic's schema. Used for metrics attribution and log filtering, not for rectifier priority. Semantic's schema stays backward-compatible; adversarial's is a superset.

### Diff Handling — DiffMode Awareness (Updated for PR 388)

PR 388 (REVIEW-002) introduced `diffMode: "embedded" | "ref"` for semantic review. Both modes are supported by adversarial review, using the same `DiffContext` discriminated union from `src/review/types.ts:15-17`:

```typescript
export type DiffContext =
  | { mode: "embedded"; diff: string; storyGitRef?: never; stat?: never }
  | { mode: "ref"; storyGitRef: string; stat?: string; diff?: never };
```

The `never` fields prevent accidentally mixing modes.

#### How each mode works for adversarial review

**Ref mode (default for adversarial, recommended).**

No diff pre-computation. The orchestrator passes `storyGitRef` + stat to the adversarial prompt builder, which generates self-serve git commands. The reviewer decides what to inspect at runtime — full diff, prod-only diff, new-files-only, commit log. The test-file inventory is also self-served via `git diff --name-only --diff-filter=A`.

- **No `ReviewDiffArtifacts` needed.** Pre-computation is unnecessary because the reviewer self-serves.
- **No PipelineContext additions.** No `reviewDiffFull` / `reviewDiffProdOnly` fields needed.
- **No 50KB cap risk.** The reviewer reads the full diff incrementally via tools.
- **Simplifies the orchestrator** — it only needs to ensure `storyGitRef` and `stat` are available on `ctx`, which semantic review already computes (`semantic.ts:259`).

**Embedded mode (opt-in, for environments where agent tool use is restricted).**

The orchestrator pre-collects the full diff (including tests) and passes it to the builder. Unlike semantic, adversarial does **not** apply `excludePatterns` to strip test files. The `TestInventory` is also pre-computed and passed to the builder.

In embedded mode, the orchestrator computes:

```typescript
interface ReviewDiffArtifacts {
  /** Full diff including tests — used by adversarial in embedded mode */
  full: string
  /** Prod-only diff — used by semantic in embedded mode */
  prodOnly: string
  /** Test inventory — used by adversarial in embedded mode */
  testInventory: TestInventory
}
```

The `TestInventory.newSourceFilesWithoutTests` computation is a sibling-path check: for each `src/foo/bar.ts` added in the diff, check whether `test/**/bar.test.ts` exists or was added. Pure file-system logic, no LLM involvement.

**Pre-computation is shared when both reviewers use embedded mode.** The orchestrator runs `collectDiff()` and `collectDiffStat()` once (reusing the existing functions from `semantic.ts:57-78,85-100`) and caches the results for both reviewers. Semantic receives `prodOnly`; adversarial receives `full`.

**Mixed-mode is the common case.** Semantic defaults to `"embedded"` (per existing config), adversarial defaults to `"ref"`. In this configuration:

- Semantic's diff is collected and embedded as today — no change.
- Adversarial receives only `storyGitRef` + stat — no pre-computation.
- The test inventory is not pre-computed (adversarial self-serves it in ref mode).
- No new `PipelineContext` fields are needed.

This is the simplest path and the recommended default.

#### Worktree Awareness (PR 390/392)

PR 390 (EXEC-002) introduced `storyIsolation: "worktree"` where each story runs in `.nax-wt/<storyId>/`. The iteration runner resolves `effectiveWorkdir` to the worktree path and propagates it to `PipelineContext.workdir` (`src/execution/iteration-runner.ts:70-82`). `storyGitRef` is captured inside the worktree (`iteration-runner.ts:89-98`).

The adversarial reviewer inherits the correct workdir automatically via `ctx.workdir` — no special worktree logic in the review stage. All diff commands and tool access operate inside the worktree. The reviewer runs pre-merge (the `MergeEngine` merges to main after the full pipeline passes, per `pipeline-result-handler.ts:159-185`).

**Important:** the test-inventory computation (in embedded mode) and all git commands (in ref mode) must use `ctx.workdir`, not `ctx.projectDir`, to operate in the correct worktree. PR 392 further fixed monorepo subpackage resolution (`iteration-runner.ts:118-125`), which propagates correctly to `ctx.workdir`.

### Session Role

Nax already has a `sessionRole: string` field on `AgentRunOptions` and `CompleteOptions` (`src/agents/types.ts:84,158`), used by the ACP adapter to build sidecar keys (`src/agents/acp/adapter.ts:350,736`). This is the correct primitive.

New session role values:

- `"reviewer-semantic"` — semantic review session (migration of existing `"reviewer"` value used today, or a new value — see **Migration** below)
- `"reviewer-adversarial"` — adversarial review session

Passed at call sites using the full `agent.run()` options template (per `.claude/rules/adapter-wiring.md`):

```typescript
// Agent resolution — use agentGetFn from pipeline context, never bare getAgent()
const agent = (ctx.agentGetFn ?? _deps.getAgent)(ctx.config.autoMode.defaultAgent);

// Adversarial: OWN session, NOT the implementer session.
const adversarialSessionName = buildSessionName(
  ctx.workdir, featureName, ctx.story.id, "reviewer-adversarial"
);

const runResult = await agent.run({
  prompt: adversarialPrompt,
  workdir: ctx.workdir,                    // worktree-aware via iteration-runner
  acpSessionName: adversarialSessionName,  // own session — see Session Strategy below
  keepSessionOpen: false,                  // one-shot review, no continuity needed
  modelTier: adversarialConfig.modelTier,
  modelDef: resolveModelForAgent(config.models, agentName, tier, defaultAgent),
  timeoutSeconds: Math.ceil(adversarialConfig.timeoutMs / 1000),
  pipelineStage: "review",                 // CRITICAL — resolves reviewer-tier permissions
  config: ctx.config,
  featureName,
  storyId: ctx.story.id,
  sessionRole: "reviewer-adversarial",
});
```

**Key call-site requirements from PR 388 learnings:**

- `pipelineStage: "review"` is mandatory — PR 388 fixed a bug where omitting this caused `resolvePermissions()` to apply implementer-tier permissions instead of reviewer-tier.
- `agent.run()` is the sole method — PR 388 removed the deprecated `agent.complete()` fallback from semantic review. Adversarial review uses `agent.run()` exclusively from day one.
- Agent resolution must go through `ctx.agentGetFn` (threaded from `runner.ts` via `createAgentRegistry(config)`) to respect `config.agent.protocol`, not bare `getAgent()`.

This gives sidecar-level session isolation for free: distinct ACP session names, independent sidecar directories, correct scoping in logs and metrics.

### Session Strategy — Own Session, Not Shared

Semantic review targets the **implementer's ACP session** (`acpSessionName: implementerSessionName`, [semantic.ts:462-471,487](src/review/semantic.ts#L462-L471)), giving it access to the implementer's conversation context and file reads. This serves semantic review's confirmatory mandate — it can trace the implementer's intent.

Adversarial review takes the **opposite approach**: it gets its own fresh session via `buildSessionName(..., "reviewer-adversarial")`. Three reasons:

1. **Independence preserves adversarial value.** The implementer session contains the implementer's reasoning and justifications. An adversarial reviewer that reads "I renamed `_role` because it's unused" in the conversation history is biased toward agreement. A fresh session forces conclusions from artifacts (diff, code, tests), not narratives. The whole point of the adversarial lens is to see what the implementer's optimism missed.

2. **Parallel mode requires session isolation.** ACP sessions are stateful conversations, not read-only resources. Two agents targeting the same session concurrently (semantic + adversarial in parallel mode) is undefined behavior. Own sessions make parallel mode correct by construction.

3. **Sequential mode doesn't benefit from sharing either.** If adversarial runs after semantic (in sequential mode), the implementer session already contains semantic's reads and greps. Inheriting that state biases adversarial toward the same files and away from the blind spots semantic missed — exactly the places adversarial should look.

**`keepSessionOpen: false`** because adversarial is a one-shot review with no multi-turn interaction in v1. No subsequent session needs to resume where adversarial left off. This contrasts with semantic, which may keep the session open for dialogue/debate continuity.

**Tool access is sufficient.** The adversarial reviewer has READ and GREP tool access plus the git ref and diff commands in its prompt. It can inspect any file in the codebase independently. The implementer session's value is *conversation* context (what was tried, what was discussed), not *file* context. Adversarial doesn't want the former and can get the latter on its own.

### Runner Function — `runAdversarialReview()`

The runner at `src/review/adversarial.ts` mirrors `runSemanticReview()` in structure. Key design decisions:

**Signature:**

```typescript
export async function runAdversarialReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  adversarialConfig: AdversarialReviewConfig,
  modelResolver: ModelResolver,
  naxConfig?: NaxConfig,
  featureName?: string,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
): Promise<ReviewCheckResult>
```

Same signature pattern as `runSemanticReview()` minus `resolverSession` (no dialogue in v1). Uses the same `ModelResolver` type and returns the same `ReviewCheckResult`.

**Git ref resolution — reuse BUG-114 fallback chain.** Same logic as `semantic.ts:222-236`:

1. Try `storyGitRef` if valid → use it
2. Fall back to merge-base with default remote branch
3. Skip review if neither resolves

This is shared infrastructure — extract into `src/review/diff-utils.ts` alongside `collectDiff`/`collectDiffStat` in Phase 1. Both runners call `resolveEffectiveRef(workdir, storyGitRef)` instead of duplicating the fallback chain.

**Fail-open/fail-closed policy — same as semantic.** Adversarial uses the same nuanced policy from `semantic.ts:514-548`:

- **Fail-open** when LLM response is truly unparseable (JSON parse failure, no signal) — the feature is best-effort, don't block the story for a reviewer malfunction.
- **Fail-closed** when truncated JSON contains `"passed": false` — the LLM clearly intended to fail, so treat it as a failure even if findings are incomplete.
- **Fail-open** when the LLM call itself fails (timeout, network error) — same as semantic.

Both reviewers share the same `parseLLMResponse()` and `validateLLMShape()` utilities.

**No debate path in v1.** Unlike `runSemanticReview()` which has a ~100-line debate code path, `runAdversarialReview()` is strictly single-call. No debate slot, no `resolverSession`, no proposal synthesis. If `debate.stages.adversarial` is added in a future spec, it would be wired here — but v1 is deliberately simple.

**`_deps` pattern for testability.** Following the project convention:

```typescript
export const _adversarialDeps = {
  spawn: spawn as typeof spawn,
  isGitRefValid,
  getMergeBase,
  readAcpSession,
};
```

Mirrors `_semanticDeps` in `semantic.ts:33-39`. Tests mock via `_deps` injection, never `mock.module()`.

### Logger — Promote `sessionRole` to First-Class Field

**Problem.** Under parallel execution, semantic and adversarial review sessions emit log entries concurrently to the same JSONL file. The existing `storyId`-first-key convention (CLAUDE.md project rule) correlates entries to a story but cannot distinguish semantic's log line from adversarial's. The adapter passes `sessionRole` into the agent session but the logger does not capture it in `LogEntry` (`src/logger/logger.ts:85-92`).

**Solution.** Promote `sessionRole` to a first-class `LogEntry` field, mirroring the prior elevation of `storyId`.

```typescript
interface LogEntry {
  timestamp: string
  level: LogLevel
  stage: string
  message: string
  storyId?: string
  sessionRole?: string   // NEW — first-class
  data?: Record<string, unknown>
}
```

Logger write path accepts `sessionRole` as a structured argument alongside `storyId`:

```typescript
logger.info("review", "Starting adversarial pass", {
  storyId: ctx.story.id,
  sessionRole: "reviewer-adversarial",
})
```

**Migration strategy.** Non-breaking.

1. Add the field as optional on `LogEntry`.
2. Update review-stage log call sites first (smallest surface, highest payoff — parallel correlation is the whole point).
3. Allow other stages to migrate from `data.sessionRole` to the first-class field opportunistically. No forced big-bang rename.
4. Update CLAUDE.md rules: *"Review-stage log calls must include `sessionRole` in addition to `storyId`. Other stages may include it."*

**Why not thread `sessionRole` automatically from `agent.run()` into log entries?** The two systems are loosely coupled. The adapter that spawns a session is not the same object that emits pipeline-stage logs. Threading would require either a global AsyncLocalStorage-style context (heavy, new infrastructure) or passing `sessionRole` through every function on the call path (intrusive). Making the field explicit at log sites is the pragmatic compromise.

### Orchestration Flow

Change in `src/review/orchestrator.ts`:

```typescript
async function runReviewChecks(ctx: PipelineContext, config: ReviewConfig) {
  const checks = config.checks
  const hasSemantic    = checks.includes("semantic")
  const hasAdversarial = checks.includes("adversarial")

  // Run non-LLM checks (typecheck, lint, build, test) as today — unchanged
  const staticResults = await runStaticChecks(ctx, checks)

  // Collect shared diff prerequisites.
  // stat is used by both modes; storyGitRef is already on ctx.
  // In embedded mode, diffs are pre-collected; in ref mode, only stat is needed.
  const semConfig = config.semantic
  const advConfig = config.adversarial
  const semDiffMode = semConfig?.diffMode ?? "embedded"
  const advDiffMode = advConfig?.diffMode ?? "ref"

  // Collect stat once — needed by both reviewers in both modes.
  const stat = ctx.storyGitRef
    ? await collectDiffStat(ctx.workdir, ctx.storyGitRef)
    : ""

  // Pre-collect diffs only for reviewers using embedded mode.
  let semDiff: string | undefined
  let advDiff: string | undefined
  let testInventory: TestInventory | undefined

  if (hasSemantic && semDiffMode === "embedded" && ctx.storyGitRef) {
    const rawDiff = await collectDiff(ctx.workdir, ctx.storyGitRef, semConfig?.excludePatterns ?? [])
    semDiff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined)
  }

  if (hasAdversarial && advDiffMode === "embedded" && ctx.storyGitRef) {
    // Adversarial: full diff (no exclude patterns — tests are in scope)
    const rawDiff = await collectDiff(ctx.workdir, ctx.storyGitRef, [])
    advDiff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined)
    testInventory = await computeTestInventory(ctx.workdir, ctx.storyGitRef)
  }

  // Dispatch semantic + adversarial
  const llmResults = await runLlmReviewers(ctx, config, {
    hasSemantic, hasAdversarial,
    stat, semDiff, advDiff, testInventory,
  })

  return mergeFindings(staticResults, llmResults)
}

async function runLlmReviewers(ctx, config, flags) {
  const advConfig = config.adversarial
  const canParallelize = flags.hasSemantic && flags.hasAdversarial
    && advConfig?.parallel === true
    && effectiveConcurrency(config) <= (advConfig?.maxConcurrentSessions ?? 2)

  if (canParallelize) {
    const [sem, adv] = await Promise.all([
      flags.hasSemantic    ? runSemanticReview(ctx, config, flags)    : Promise.resolve(null),
      flags.hasAdversarial ? runAdversarialReview(ctx, config, flags) : Promise.resolve(null),
    ])
    return combineFindings(sem, adv)
  }

  // Sequential fallback — also covers cap-exceeded case
  const sem = flags.hasSemantic    ? await runSemanticReview(ctx, config, flags)    : null
  const adv = flags.hasAdversarial ? await runAdversarialReview(ctx, config, flags) : null
  return combineFindings(sem, adv)
}
```

Note: `runSemanticReview` and `runAdversarialReview` each build their own prompt from their respective builder, passing the appropriate `DiffContext` (embedded or ref) based on their own `diffMode` config. The orchestrator collects shared prerequisites (stat, pre-collected diffs when embedded) but does not dictate the mode — each reviewer reads its own config.

### Findings Handling

Both reviewers emit into `ctx.reviewFindings[]`. Findings are **not deduped** at the orchestrator level — two reviewers flagging overlapping concerns is valuable corroboration, and automated deduplication by `(file, line±N)` is fragile because LLMs report approximate line numbers and can wrongly merge unrelated findings.

#### Alignment with existing `ReviewFinding` type

The existing `ReviewFinding` interface (`src/plugins/extensions.ts:20-43`) already has optional `source` and `category` fields:

```typescript
// Existing type — no changes needed to the interface itself
export interface ReviewFinding {
  ruleId: string;                                              // e.g., "semantic", "adversarial"
  severity: "critical" | "error" | "warning" | "info" | "low";
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;                                             // mapped from LLM's "issue" field
  url?: string;
  source?: string;                                             // e.g., "semantic-review", "adversarial-review"
  category?: string;                                           // e.g., "abandonment", "test-gap"
}
```

**No interface change is needed.** The existing `source` and `category` fields are already optional strings. Adversarial review populates them; semantic review already populates `source`.

**Key field mappings:** The LLM output schema uses `issue`/`suggestion`/`severity` with different names and values from the stored `ReviewFinding` type. A mapping function bridges them, mirroring the existing `toReviewFindings()` in `semantic.ts:183-191`:

```typescript
/** Convert adversarial LLM findings to ReviewFinding[] with adversarial metadata. */
function toAdversarialReviewFindings(findings: AdversarialLLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "adversarial",
    severity: normalizeSeverity(f.severity),   // "warn" → "warning", "unverifiable" → "info"
    file: f.file,
    line: f.line,
    message: f.issue,                          // LLM "issue" → stored "message"
    source: "adversarial-review",              // matches convention: "semantic-review"
    category: f.category,                      // "input" | "error-path" | "abandonment" | etc.
  }));
}
```

**`source` naming convention:** The existing semantic review uses `source: "semantic-review"` ([semantic.ts:191](src/review/semantic.ts#L191)). Adversarial follows the same convention: `source: "adversarial-review"`. No rename of the existing value — both are free-form strings, and consistency within the convention is more important than brevity.

**`ruleId`:** Semantic uses `ruleId: "semantic"`. Adversarial uses `ruleId: "adversarial"`. These appear in autofix prompts and log output. The rectifier uses `ruleId` to identify which check produced the finding, not for priority.

**`source` is metadata only.** The rectifier MUST NOT treat one source as higher-priority than the other. If there's a genuine conflict, the rectifier reasons from finding content, not origin. No "semantic always wins" rules anywhere in the fix path.

### Conflict Handling

Most apparent "conflicts" between semantic and adversarial are one of:

1. **Overlap** (same defect, two framings) — ~80%. Not a conflict. Let both flow through; the rectifier treats them as corroborating signal.
2. **Scope disagreement** (adversarial flags a test gap that semantic didn't touch) — ~15%. Not a conflict. Adversarial's mandate extends beyond AC; silence from semantic is not disagreement.
3. **True contradiction** (fix for one breaks the other) — ~5%. The only case requiring resolution logic.

**Resolution strategy for true contradictions: rectifier arbitration with escalation fallback.**

No pre-detection at the orchestrator. The rectifier prompt (`src/pipeline/stages/autofix.ts` fix-generation call) is augmented:

```
If two findings in this list contradict each other and you cannot satisfy
both, do not guess. Emit a fix for the defects you can resolve, and set
"unresolved": true with a short explanation of which findings conflicted
and why. A reviewer or a stronger model will decide.
```

On `unresolved: true`:

1. The story fails the review stage.
2. Existing tier escalation (`src/execution/escalation/`) moves the story to the next tier (e.g. `balanced → powerful`).
3. At the stronger tier, the adversarial + semantic reviewers re-run and the rectifier retries with fresher reasoning. Powerful models resolve ambiguity that `balanced` could not.
4. If escalation exhausts and the conflict persists, the story enters the normal failure-surfacing path — same as any other unresolvable review failure today. No new human-gate primitive.

**Why not a third "arbiter" LLM call.** Adds cost, adds a third fallible voice, and arbiters tend to be confidently wrong about trade-offs they can't test. The rectifier is already the entity that writes the fix — giving it the contradiction context is more honest than asking a bystander to rule on it.

### Rectifier Integration — No Schema Change

`autofixStage` (`src/pipeline/stages/autofix.ts:42-43`) already consumes `ctx.reviewFindings` without caring how many reviewers produced them. Adding `source` and `category` as optional fields is backward-compatible. The only fix-path change is the rectifier prompt augmentation for the `unresolved: true` escape hatch.

### Retry Bounding — Inherited from Existing Infrastructure

The adversarial review spec does **not** introduce its own `maxRetries` config. The review → autofix → re-review loop is already bounded by three existing mechanisms that work together:

**1. `quality.autofix.maxAttempts` (default 3) — per-cycle agent rectification cap.**
When review fails, `autofixStage` (`src/pipeline/stages/autofix.ts:227-423`) spawns an agent to fix the failed checks. Within one autofix cycle, the agent gets at most `maxAttempts` tries. Each attempt calls `recheckReview(ctx)` ([autofix.ts:354](src/pipeline/stages/autofix.ts#L354)) which re-runs `reviewStage.execute(ctx)` — including adversarial if it was in the failed set.

**2. `quality.autofix.maxTotalAttempts` (default 12) — global budget across all cycles.**
Accumulated via `ctx.autofixAttempt` across every review → autofix cycle for the story's lifetime ([autofix.ts:235-236](src/pipeline/stages/autofix.ts#L235-L236)). When exhausted, autofix returns `action: "escalate"`.

**3. `execution.rectification.maxRetries` (default 2) — tier escalation.**
After autofix escalates, the story moves to the next model tier via the escalation ladder (`src/execution/escalation/`). After all tiers exhaust, the story fails.

**Combined effect:** a story gets at most 3 fix attempts per cycle × up to 12 total attempts across cycles, bounded by 2 tier escalations before final failure. This is the same mechanism that bounds semantic review retries today.

**`retrySkipChecks` prevents unnecessary re-runs.** When autofix succeeds, it sets `ctx.retrySkipChecks` to include all checks that **already passed** ([autofix.ts:123-129, 152-159](src/pipeline/stages/autofix.ts#L123-L159)). On retry, the orchestrator skips these checks ([orchestrator.ts:188-190](src/review/orchestrator.ts#L188-L190)). This means:

- If adversarial passed but semantic failed → autofix fixes code → on retry, adversarial is **skipped** (already passed), only semantic re-runs.
- If semantic passed but adversarial failed → only adversarial re-runs.
- If both failed → both re-run.

This naturally prevents the oscillation scenario (adversarial and semantic each demand conflicting fixes) from becoming a runaway cost loop — the autofix attempt budget is consumed regardless of which reviewer triggered the retry, and the skip mechanism avoids redundant LLM calls.

**Why not add a separate adversarial maxRetries?** It would create a fourth cap competing with the existing three for overlapping loop control. Confusing to configure ("which cap fires first?"), no incremental benefit since the existing bounds already prevent the pathological case, and no precedent — semantic review uses the same shared autofix budget without its own retry cap.

### Metrics

Split `StoryMetrics.review` into per-lens sub-buckets for cost attribution and effectiveness measurement:

```typescript
interface ReviewMetrics {
  // Existing top-level — sum of children
  totalCost: number
  totalTokens: number
  wallClockMs: number

  semantic: {
    cost: number
    tokens: number
    wallClockMs: number
    findingsCount: number
    findingsBySeverity: Record<Severity, number>
  }

  adversarial: {
    cost: number
    tokens: number
    wallClockMs: number
    findingsCount: number
    findingsBySeverity: Record<Severity, number>
    findingsByCategory: Record<AdversarialCategory, number>   // adversarial-only
  }
}
```

This is the evidence base for tuning the rollout: if `adversarial.findingsCount` trends to zero or adversarial never catches anything semantic missed, the feature isn't pulling its weight. If `findingsByCategory` concentrates in one category, that's a signal to specialize further or refine the prompt.

## File Surface

### New files

- `src/prompts/builders/adversarial-review-builder.ts` — prompt builder with `AdversarialReviewPromptOptions`, `TestInventory` types, and mode-branching diff sections
- `src/review/adversarial.ts` — `runAdversarialReview()` entry point with `_adversarialDeps`, BUG-114 ref fallback, fail-open/fail-closed policy, `toAdversarialReviewFindings()` mapping function
- `src/review/diff-utils.ts` — shared utilities extracted from `semantic.ts`: `collectDiff()`, `collectDiffStat()`, `truncateDiff()`, `resolveEffectiveRef()`, `computeTestInventory()`
- `test/unit/prompts/adversarial-review-builder.test.ts` — builder unit tests (snapshot tests for both embedded and ref modes)
- `test/unit/review/adversarial.test.ts` — runner unit tests (with `_adversarialDeps` mocking): fail-open, fail-closed, ref resolution, finding mapping
- `test/integration/review/adversarial-parallel.test.ts` — parallel vs sequential mode behavior, session isolation verification
- `test/integration/review/adversarial-conflict.test.ts` — unresolved contradiction → escalation flow via existing autofix budget

### Modified files

- `src/config/schemas.ts` — extend `ReviewCheckName`, add `AdversarialReviewConfigSchema` (with `diffMode` field)
- `src/config/types.ts` — re-export new types (`AdversarialReviewConfig`)
- `src/plugins/extensions.ts` — no change needed: `ReviewFinding` already has optional `source` and `category` fields
- `src/review/types.ts` — add `AdversarialReviewConfig` interface (mirrors `SemanticReviewConfig` with `diffMode`, `parallel`, `maxConcurrentSessions`)
- `src/review/orchestrator.ts` — dispatch logic for semantic + adversarial with diffMode-aware prerequisite collection; concurrency cap logic
- `src/review/runner.ts` — wire `"adversarial"` check into the runner
- `src/review/semantic.ts` — extract `collectDiff`, `collectDiffStat`, `truncateDiff`, `resolveEffectiveRef` into `src/review/diff-utils.ts`; import from there; add `sessionRole: "reviewer-semantic"` to `agent.run()` call
- `src/pipeline/stages/autofix.ts` — augment rectifier prompt with contradiction/unresolved instructions
- `src/logger/logger.ts` — promote `sessionRole` to first-class `LogEntry` field
- `src/logger/types.ts` — type update
- `src/metrics/story-metrics.ts` — split `review` bucket into `semantic` and `adversarial` sub-buckets
- `src/metrics/aggregator.ts` — aggregation for new sub-buckets
- `CLAUDE.md` project rules — note that review-stage log calls must include `sessionRole`
- `.claude/rules/project-conventions.md` — same rule
- `.claude/rules/adapter-wiring.md` — add `"reviewer-adversarial"` and `"reviewer-semantic"` to the Session Role Registry table

### Unchanged

- `src/prompts/builders/review-builder.ts` — semantic prompt stays as-is. The `buildAttemptContextBlock()` and `PriorFailure` type are imported by the adversarial builder but the file itself is not modified.
- `src/debate/` — debate is orthogonal and not touched
- `src/agents/types.ts` — `sessionRole` already exists on `AgentRunOptions`
- `src/execution/iteration-runner.ts` — worktree resolution already propagates correctly to `ctx.workdir`; no changes needed
- `src/execution/pipeline-result-handler.ts` — post-review merge logic is unaffected by the new check

## Migration

### `sessionRole` value for semantic

The existing `agent.run()` call in `semantic.ts:484-496` does **not** currently pass a `sessionRole` — the field is absent, not set to a default. Before adversarial ships, add `sessionRole: "reviewer-semantic"` to the semantic review call site for symmetry with `sessionRole: "reviewer-adversarial"`. This is a one-line addition.

No existing sidecar files or ACP session names reference a semantic session role, so there is no orphaning concern. The ACP adapter already handles absent `sessionRole` gracefully — adding it is purely additive.

### Logger `sessionRole` field

Non-breaking addition. Existing callers that stuff `sessionRole` into `data` continue to work; the first-class field is preferred for new code. Migrate opportunistically.

## Rollout Plan

1. **Phase 1 — Infrastructure (behind no flag).**
   - Add `ReviewFinding.source` and `ReviewFinding.category` fields (backward-compatible)
   - Promote `LogEntry.sessionRole` to first-class field
   - Extract `collectDiff`, `collectDiffStat`, `truncateDiff`, and the BUG-114 ref fallback chain into a shared `src/review/diff-utils.ts` (`resolveEffectiveRef()`) so both runners reuse the same logic
   - Add `TestInventory` computation helper `computeTestInventory()` in `diff-utils.ts` (for embedded-mode adversarial)
   - Add `sessionRole: "reviewer-semantic"` to the existing `agent.run()` call in `semantic.ts`
   - Split metrics buckets (write-only; no reader depends on the split yet)
   - Add `"reviewer-adversarial"` and `"reviewer-semantic"` to the Session Role Registry in `adapter-wiring.md`

2. **Phase 2 — Adversarial reviewer (default off).**
   - Add `"adversarial"` to `ReviewCheckName` enum
   - Add `AdversarialReviewConfigSchema`
   - Ship `AdversarialReviewPromptBuilder` + `runAdversarialReview()`
   - Wire into `ReviewOrchestrator` in sequential-only mode (`parallel: false`)
   - Default `review.checks` unchanged — adversarial is opt-in

3. **Phase 3 — Rectifier arbitration + retry integration.**
   - Augment autofix prompt with the `unresolved: true` escape hatch
   - Verify that `retrySkipChecks` correctly includes adversarial when it passes (skip on retry) and excludes it when it fails (re-run on retry)
   - Verify escalation path handles unresolved contradictions correctly via existing `quality.autofix.maxAttempts` + `maxTotalAttempts` + tier escalation — no new retry config

4. **Phase 4 — Parallel mode.**
   - Enable `parallel: true` as a config option
   - Implement concurrency cap logic
   - Gate with integration tests that simulate semantic+debate vs adversarial contention

5. **Phase 5 — Measurement.**
   - Run adversarial opted-in on a representative set of stories for N weeks
   - Review `metrics.review.adversarial.findingsCount`, `findingsByCategory`, and overlap rate vs semantic
   - Decide whether to flip the default

6. **Phase 6 — Default-on (conditional on Phase 5 data).**
   - Only if adversarial catches real issues semantic misses at a meaningful rate
   - Default `review.checks` gets `"adversarial"` appended
   - `parallel` stays `false` by default regardless; users opt into speed

### Rollback

- Remove `"adversarial"` from `review.checks` — fully disables the feature, zero code surface executes.
- All infra changes in Phase 1 are backward-compatible and safe to leave in place even if Phases 2+ are reverted.

## Risks

### Cost blow-up with debate

If a user enables both semantic debate (`debate.stages.review: true`) and adversarial parallel, effective concurrency climbs to 5+ sessions per story. The `maxConcurrentSessions` cap catches this but only if users leave the default. **Mitigation:** emit a warning log at config load time when the combined configuration would exceed the cap, noting that adversarial will run sequentially. Document the interaction in `docs/guides/review-configuration.md`.

### Context window pressure

In embedded mode, adversarial sees the full diff (including tests), which can push close to the 50KB `DIFF_CAP_BYTES` cap faster than semantic (which strips test files). **Mitigation:** default adversarial to `diffMode: "ref"` where the reviewer self-serves the diff via tools with no cap. In embedded mode, `truncateDiff` still applies as a safety net. Ref mode avoids the problem entirely and is the recommended default.

### Rectifier loop oscillation

The rectifier may produce a fix that satisfies one reviewer but triggers a new finding from the other on the next pass, leading to a cycle. **Mitigation:** the existing autofix budget (`quality.autofix.maxAttempts` per cycle, `quality.autofix.maxTotalAttempts` globally) bounds the loop. `retrySkipChecks` ensures only the failing reviewer re-runs, so each attempt targets the actual failure rather than re-running both reviewers blindly. When the budget exhausts, tier escalation kicks in; if all tiers exhaust, the story fails. See **Retry Bounding** section for details.

### LLM "mode confusion" in the adversarial prompt

If the prompt is not sufficiently distinct from semantic's, the adversarial reviewer may drift toward AC-verification behavior and fail to add value. **Mitigation:** the prompt is explicit about *not* confirming correctness ("Your job is NOT to confirm correctness — semantic review handles that"). Monitor overlap rate in Phase 5 metrics; if adversarial findings are just restatements of semantic findings, the prompt needs sharpening.

### Reviewer false positives

An adversarial reviewer instructed to "find what's wrong" will produce more `warn` and `info` findings than semantic. High false-positive rates train the rectifier to ignore findings. **Mitigation:** the prompt requires READ/GREP verification before flagging as `error`, and reserves `unverifiable` for unconfirmed suspicions. Severity discipline is enforced at the prompt level.

### Log volume increase

Two review sessions per story double review-stage log output. **Mitigation:** log levels are unchanged; structured `sessionRole` field lets consumers filter by lens. JSONL file rotation policies (if any) may need revisiting, but this is out of scope for this SPEC.

## Compatibility with Recent PRs

This section documents how the SPEC integrates with PRs merged after the initial draft.

### PR 388 — Configurable semantic review diff mode (REVIEW-002)

**Impact: High.** PR 388 introduced `diffMode: "embedded" | "ref"` for semantic review. The original SPEC assumed embedded-only and proposed adding `reviewDiffFull`/`reviewDiffProdOnly` to `PipelineContext`. This has been redesigned:

- Adversarial review supports both `diffMode` values via the same `DiffContext` discriminated union (`src/review/types.ts:15-17`).
- Default `diffMode` for adversarial is `"ref"` (not `"embedded"`). Rationale: adversarial benefits from seeing the full diff including tests without the 50KB cap, and ref mode eliminates pre-computation entirely.
- The `AdversarialReviewPromptBuilder` takes `AdversarialReviewPromptOptions` (structured options object mirroring `SemanticReviewPromptOptions` from PR 388), not the 3-arg shape from the original draft.
- The `buildAttemptContextBlock()` helper from PR 388 is reused — no duplication.
- `agent.run()` is the sole call method, with `pipelineStage: "review"` mandatory (PR 388 fixed a permission resolution bug when this was missing).

### PR 390 — Sequential worktree isolation (EXEC-002)

**Impact: Low.** PR 390 introduced `storyIsolation: "worktree"` where each story runs in `.nax-wt/<storyId>/`. The adversarial reviewer inherits the correct workdir via `ctx.workdir` (resolved by `iteration-runner.ts`). All diff commands and tool access operate inside the worktree automatically. The reviewer runs pre-merge — worktree branch merges to main after the full pipeline passes.

### PR 392 — Bug fixes for EXEC-002

**Impact: None.** Fixes monorepo subpackage resolution and git branch cleanup. Both propagate correctly through `ctx.workdir` and are transparent to the review stage.

## Open Questions

1. **Should adversarial's `source` field eventually influence rectifier priority?** Current SPEC says no — the rectifier reasons from content, not origin. If Phase 5 data shows that one lens is systematically more actionable than the other, revisit.

2. **Test-inventory computation scope.** Current design flags *new source files without matching tests*. Should it also flag *modified source files* where the change is substantive but the test file was not updated? Probably yes, but "substantive" is hard to define mechanically. Ship the simpler version first; extend in a follow-up.

3. **Should `debate.stages.adversarial` exist?** Not in this SPEC. Debate on adversarial would require wiring debate personas into a second review lens and is premature until we know whether single-call adversarial pays its way.

4. **Should `maxConcurrentSessions` be a top-level config rather than nested under `review.adversarial`?** Arguable — other parts of nax (debate, parallel story execution) also spawn concurrent sessions and could benefit from a global cap. Out of scope here; revisit during Phase 4.

## Acceptance Criteria

1. `"adversarial"` is a valid value in `review.checks`; configs without it continue to work unchanged.
2. `AdversarialReviewConfigSchema` validates the documented shape — including `diffMode: "embedded" | "ref"` defaulting to `"ref"` — and all defaults match this SPEC.
3. `AdversarialReviewPromptBuilder` accepts `AdversarialReviewPromptOptions` (structured options object mirroring `SemanticReviewPromptOptions`) and produces mode-appropriate prompts:
   - In embedded mode: story, ACs, full diff (with tests), test inventory, attempt context (if any), adversarial role, instructions, and JSON schema.
   - In ref mode: story, ACs, stat summary, storyGitRef, self-serve git commands (full diff, prod-only diff, new files, log), attempt context (if any), adversarial role, instructions, and JSON schema.
   - Verified by snapshot tests for both modes.
4. `runAdversarialReview()` calls the LLM via `agent.run()` using the full options template from `adapter-wiring.md`: `prompt`, `workdir`, `modelTier`, `modelDef`, `timeoutSeconds`, `pipelineStage: "review"`, `config`, `featureName`, `storyId`, `sessionRole: "reviewer-adversarial"`. Agent resolution goes through `ctx.agentGetFn`, not bare `getAgent()`.
5. Findings from adversarial review are mapped via `toAdversarialReviewFindings()` to the existing `ReviewFinding` type with `ruleId: "adversarial"`, `source: "adversarial-review"`, and an appropriate `category`. Semantic findings continue to use `ruleId: "semantic"` and `source: "semantic-review"`. No changes to the `ReviewFinding` interface in `src/plugins/extensions.ts`.
6. Adversarial review runs in its **own ACP session** (`buildSessionName(..., "reviewer-adversarial")`) with `keepSessionOpen: false`. It does NOT target the implementer session. In parallel mode, semantic and adversarial sessions are fully isolated with no shared state.
7. When both `"semantic"` and `"adversarial"` are in `checks` and `parallel: false`, semantic runs before adversarial; their combined findings appear in `ctx.reviewFindings`.
8. When `parallel: true` and concurrency cap is not exceeded, both reviewers run concurrently via `Promise.all`; combined findings appear in `ctx.reviewFindings`.
9. When `parallel: true` but effective concurrency exceeds `maxConcurrentSessions`, the orchestrator falls back to sequential execution and logs a warning.
10. Metrics under `StoryMetrics.review.adversarial` are populated with cost, tokens, wallClockMs, findingsCount, and findingsByCategory after a run that included adversarial review.
11. `LogEntry.sessionRole` is a first-class field; review-stage log entries include it alongside `storyId`.
12. In embedded mode: `stat` and diffs are collected once per review stage; semantic receives prod-only diff, adversarial receives full diff and `TestInventory`. In ref mode: only `stat` and `storyGitRef` are shared; no diff pre-computation occurs.
13. Adversarial review operates correctly in worktree mode (`storyIsolation: "worktree"`): diff commands and tool access use `ctx.workdir` (which is the worktree path), not `ctx.projectDir`.
14. `buildAttemptContextBlock()` from `src/prompts/builders/review-builder.ts` is reused by the adversarial builder — no duplication. The attempt context block appears in the adversarial prompt when `priorFailures` is non-empty.
15. Git ref resolution reuses the BUG-114 fallback chain (try `storyGitRef` → merge-base → skip). Shared utility `resolveEffectiveRef()` in `src/review/diff-utils.ts` used by both semantic and adversarial runners.
16. Fail-open/fail-closed policy matches semantic: fail-open on unparseable JSON or LLM call failure, fail-closed when truncated JSON contains `"passed": false`.
17. `_adversarialDeps` injectable dependency object follows the same pattern as `_semanticDeps` for testability without `mock.module()`.
18. Rectifier prompt includes the `unresolved: true` escape hatch; setting it in the rectifier output causes the story to fail the review stage and trigger tier escalation.
19. The review → autofix loop is bounded by the existing `quality.autofix.maxAttempts` (per cycle) and `quality.autofix.maxTotalAttempts` (global budget); no new `maxRetries` config is introduced. When adversarial passes but another check fails, `retrySkipChecks` excludes adversarial from the retry.
20. All new source files introduced by this feature have corresponding `*.test.ts` files — the feature eats its own dog food on the test-audit heuristic.
