# Plan — Issue #577: Convert review functions to options-bag params

**Origin:** [Issue #577](https://github.com/nathapp-io/nax/issues/577) — `runReview` / `runSemanticReview` / `runAdversarialReview` carry 13–21 positional params; positional-tail conflict magnet (PR #576, fix `3b3f7bff`).

**Type:** Pure mechanical refactor — **zero behaviour change**.
**Risk:** Low. Bounded, repeatable, testable per phase. Each phase is independently shippable.
**Out-of-scope:** Removing the legacy `agentManager` parameter (see "Phase 5 — optional follow-up" at the bottom). Touching the debate/dialogue runners (`runSemanticDebate`, `ReviewerSession`). Anything in `src/operations/{semantic,adversarial}-review.ts` (already correct).

---

## Pre-flight Context

Status of the surrounding system as of `db797580` (main):

- `src/operations/semantic-review.ts` and `src/operations/adversarial-review.ts` are the canonical `RunOperation` ops. They already take a single `Input` interface — **do not touch them**. They are the desired "after" pattern.
- `src/review/semantic.ts` (`runSemanticReview`) and `src/review/adversarial.ts` (`runAdversarialReview`) are the higher-level wrappers that build the diff, gate on debate/audit/fail-open, and finally `callOp(...semanticReviewOp/adversarialReviewOp...)`. Migration to `callOp` is **already done** (commit `5de40c56`). What remains is the signature cleanup.
- `runtime` is now **required** (semantic.ts:209-215, adversarial.ts:166-172 throw `DISPATCH_NO_RUNTIME` otherwise). The `agentManager` parameter is kept as a backward-compat fallback but is functionally dead when callers thread `runtime`. We **keep** it during this refactor; removal is a separate concern (Phase 5).
- Mocks at the test boundary (`_orchestratorDeps.runSemanticReview`, `_reviewSemanticDeps.runSemanticReview`, mirror for adversarial) use `mock(async () => ...)` and ignore arg shape — they only assert call counts and return values. So the mock declarations themselves don't need touching, only the **direct test invocations** do.
- `reviewOrchestrator.review` is also monkey-patched in `test/unit/pipeline/stages/review*.test.ts` (`review.test.ts`, `review-fail-open.test.ts`, `review-dialogue.test.ts`, `review-debate-dialogue.test.ts`, `autofix-fail-open.test.ts`) using `mock(async () => ...) as typeof reviewOrchestrator.review`. These files do **not** invoke `.review(...)` directly — they replace it. The casts continue to type-check post-refactor; no changes needed in Phase 4 for these files.
- `src/pipeline/stages/review.ts` calls only `reviewOrchestrator.reviewFromContext(ctx)` (line 137), never `.review()` directly. No production caller of `.review()` exists outside `reviewFromContext` itself. Phase 4 has exactly one production call-site to update.

### File map

| File | Function being refactored | Callers updated in this plan |
|:---|:---|:---|
| `src/review/semantic.ts` | `runSemanticReview` | runner.ts, orchestrator.ts, all `test/unit/review/semantic-*.test.ts`, `test/unit/review/orchestrator.test.ts` |
| `src/review/adversarial.ts` | `runAdversarialReview` | runner.ts, orchestrator.ts, all `test/unit/review/adversarial-*.test.ts` |
| `src/review/runner.ts` | `runReview` | orchestrator.ts (3 call sites), `src/execution/lifecycle/run-initialization.ts` (`_reconcileDeps.runReview`), `test/unit/review/runner.test.ts`, `test/integration/review/*.test.ts` |
| `src/review/orchestrator.ts` | `ReviewOrchestrator.review()` | `ReviewOrchestrator.reviewFromContext` (same file) |

No other production callers exist (verified by `grep -rn "runSemanticReview\|runAdversarialReview\|runReview\b" src/`).

---

## Working rules — read before each phase

1. **One phase = one commit** — `refactor(review): <verb> <function> to options bag (#577)`.
2. **Field names = current parameter names**, no renames. (e.g. `semanticConfig` stays `semanticConfig`, not `config`.) Renames invite review-time bikeshedding and behaviour-divergence bugs; keep them out of this PR.
3. **Required vs optional** matches the current `?` markers. Don't promote optional fields to required even if they're "always passed" today.
4. **Default values** stay at the call-site, not in the interface. (e.g. `blockingThreshold ?? "error"` stays where it is.)
5. **Don't reorder fields semantically** — group them as: required core → context → audit/runtime → optional cache. Match Issue #577's example shape.
6. **No prose changes to comments**. Existing block comments stay verbatim. Only the param list moves.
7. **Validation at end of every phase**:
   ```bash
   bun run typecheck
   bun run lint
   timeout 60 bun test test/unit/review/ --timeout=10000
   timeout 60 bun test test/integration/review/ --timeout=15000
   ```
   All four must pass before opening the next phase. **Do not** run the full suite per phase — it's wall-clock waste; the final validation gate covers it.
8. **Commit message body** must reference issue #577 and call out "no behaviour change — pure signature refactor". This is load-bearing for the PR description.
9. **Do not touch** `src/operations/semantic-review.ts`, `src/operations/adversarial-review.ts`, `src/review/semantic-debate.ts` (already uses options object), `src/review/dialogue.ts`, `src/prompts/builders/review-builder.ts`. They are already in the right shape or out of scope.
10. **If a test breaks in a way that suggests behaviour drift** (a passing assertion now fails because of the refactor), STOP and reread the function — you've moved a default or dropped a field. Do not "fix" the assertion.

---

## Phase 1 — `runSemanticReview` → options bag

### 1.1 New interface (in `src/review/semantic.ts`, above the function)

Add **above** `export async function runSemanticReview(...)`:

```typescript
export interface RunSemanticReviewOptions {
  workdir: string;
  storyGitRef: string | undefined;
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  agentManager: IAgentManager | undefined;
  naxConfig?: NaxConfig;
  featureName?: string;
  resolverSession?: import("./dialogue").ReviewerSession;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  blockingThreshold?: "error" | "warning" | "info";
  featureContextMarkdown?: string;
  contextBundle?: import("../context/engine").ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
}
```

**Field-by-field source mapping** (so a reviewer can verify nothing dropped):

| Field | Was positional # | Currently used at lines |
|:---|:---:|:---|
| `workdir` | 1 | 77, 101–103, 107, 112, 187, 226, 263 |
| `storyGitRef` | 2 | 77 |
| `story` | 3 | 71, 153, 171, 190, 213, 235, 264, 286 |
| `semanticConfig` | 4 | 90, 93, 107, 145, 171, 177, 195, 234, 236 |
| `agentManager` | 5 | 141 (fallback only) |
| `naxConfig` | 6 | 95, 107, 182, 260, 286 |
| `featureName` | 7 | 70 (debug log), 191, 230, 266, 292 |
| `resolverSession` | 8 | 191 (debate) |
| `priorFailures` | 9 | 176, 241 |
| `blockingThreshold` | 10 | 199, 244, 318 |
| `featureContextMarkdown` | 11 | 165 |
| `contextBundle` | 12 | 162, 230 |
| `projectDir` | 13 | 101 (compute repoRoot/packageDir) |
| `naxIgnoreIndex` | 14 | 103, 112 |
| `runtime` | 15 | 141, 209–215, 224 |

### 1.2 Function body change

```typescript
export async function runSemanticReview(opts: RunSemanticReviewOptions): Promise<ReviewCheckResult> {
  const {
    workdir, storyGitRef, story, semanticConfig, agentManager,
    naxConfig, featureName, resolverSession, priorFailures, blockingThreshold,
    featureContextMarkdown, contextBundle, projectDir, naxIgnoreIndex, runtime,
  } = opts;
  // ... rest of function body unchanged
}
```

Use a single destructure at the top of the body. **Do not** rewrite any `opts.x` accesses — destructure once, then leave the body byte-identical.

### 1.3 Update direct callers

#### `src/review/runner.ts` (one call site, lines 308–324)

Replace:
```typescript
const result = await runSemantic(
  workdir, storyGitRef, semanticStory, semanticCfg, agentManager,
  naxConfig, featureName, resolverSession, priorFailures, config.blockingThreshold,
  featureContextMarkdown, contextBundles?.semantic, projectDir, naxIgnoreIndex, runtime,
);
```
with:
```typescript
const result = await runSemantic({
  workdir,
  storyGitRef,
  story: semanticStory,
  semanticConfig: semanticCfg,
  agentManager,
  naxConfig,
  featureName,
  resolverSession,
  priorFailures,
  blockingThreshold: config.blockingThreshold,
  featureContextMarkdown,
  contextBundle: contextBundles?.semantic,
  projectDir,
  naxIgnoreIndex,
  runtime,
});
```

#### `src/review/orchestrator.ts` (one parallel-path call site, lines 303–319)

Same structural edit as runner.ts — wrap the args of `_orchestratorDeps.runSemanticReview(...)` in an object literal with the field names above.

### 1.4 Update tests

Files (all under `test/unit/review/`):
- `semantic-retry.test.ts` (~10 invocations)
- `semantic-retry-truncation.test.ts`
- `semantic-parsing.test.ts`
- `semantic-findings.test.ts`
- `semantic-threshold.test.ts`
- `semantic-unverifiable.test.ts`
- `semantic-prompt-response.test.ts`
- `semantic-signature-diff.test.ts`
- `semantic-agent-session.test.ts`
- `semantic-debate.test.ts` — only if it calls `runSemanticReview` directly

Also update `test/helpers/runtime.ts` line 33 — the docstring example currently shows the positional call shape (`runSemanticReview(workdir, ref, story, cfg, agentManager, ..., runtime)`). Replace with the options-bag form so the helper docs don't drift from reality.

For each `await runSemanticReview(...)` invocation in tests, convert positional args to the named bag. The recurring pattern:
```typescript
await runSemanticReview(
  "/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager,
  undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined,
  undefined, runtime,
);
```
becomes:
```typescript
await runSemanticReview({
  workdir: "/tmp/wd",
  storyGitRef: "abc123",
  story: STORY,
  semanticConfig: DEFAULT_SEMANTIC_CONFIG,
  agentManager,
  runtime,
});
```
Drop fields that were `undefined` — TypeScript `?` makes them optional. **This is the main readability win** at the test layer.

### 1.5 `_orchestratorDeps.runSemanticReview` mock signature

The test file `test/unit/review/orchestrator.test.ts` reassigns `_orchestratorDeps.runSemanticReview = mock(async () => makePassedCheck(...))`. The TS signature of `_orchestratorDeps.runSemanticReview` is inferred from the imported `runSemanticReview`, so once the function is converted, the mock continues to type-check (mocks accept any args). Don't touch the mock declarations.

### 1.6 Validation
```bash
bun run typecheck
bun run lint
timeout 60 bun test test/unit/review/semantic --timeout=10000
timeout 60 bun test test/unit/review/orchestrator.test.ts --timeout=10000
timeout 60 bun test test/unit/review/runner.test.ts --timeout=10000
```

### 1.7 Commit

```
refactor(review): runSemanticReview → options bag (#577)

Convert 15 positional params to a single RunSemanticReviewOptions object.
No behaviour change — pure signature refactor. Field names match the
prior parameter names so every call-site update is mechanical.

Closes part of #577.
```

---

## Phase 2 — `runAdversarialReview` → options bag

Mirror of Phase 1. Differences:

### 2.1 Interface

```typescript
export interface RunAdversarialReviewOptions {
  workdir: string;
  storyGitRef: string | undefined;
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  agentManager: IAgentManager | undefined;
  naxConfig?: NaxConfig;
  featureName?: string;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  blockingThreshold?: "error" | "warning" | "info";
  featureContextMarkdown?: string;
  contextBundle?: import("../context/engine").ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  priorAdversarialFindings?: AdversarialFindingsCache;
}
```

(No `resolverSession` — adversarial has no debate path. `priorAdversarialFindings` is the extra trailing field unique to adversarial.)

### 2.2 Caller updates

- `src/review/runner.ts` lines 353–369 — wrap into object literal.
- `src/review/orchestrator.ts` lines 320–336 — wrap into object literal.

### 2.3 Tests to update

- `adversarial-retry.test.ts`
- `adversarial-pass-fail.test.ts`
- `adversarial-threshold.test.ts`
- `adversarial-metadata-audit.test.ts`

Same `undefined`-elision strategy as Phase 1.

### 2.4 Validation
```bash
bun run typecheck
bun run lint
timeout 60 bun test test/unit/review/adversarial --timeout=10000
timeout 60 bun test test/unit/review/orchestrator.test.ts --timeout=10000
timeout 60 bun test test/unit/review/runner.test.ts --timeout=10000
```

### 2.5 Commit

```
refactor(review): runAdversarialReview → options bag (#577)

Convert 16 positional params to a single RunAdversarialReviewOptions
object. No behaviour change. Mirror of Phase 1 (#577).

Closes part of #577.
```

---

## Phase 3 — `runReview` → options bag

This one has the most callers but the simplest body change (it doesn't itself dispatch — it threads args to runSemantic/runAdversarial which were already updated in Phases 1–2).

### 3.1 Interface (in `src/review/runner.ts`, above the function)

```typescript
export interface RunReviewOptions {
  config: ReviewConfig;
  workdir: string;
  executionConfig?: ExecutionConfig;
  qualityCommands?: QualityConfig["commands"];
  storyId?: string;
  storyGitRef?: string;
  story?: SemanticStory;
  agentManager?: IAgentManager;
  naxConfig?: NaxConfig;
  retrySkipChecks?: Set<string>;
  featureName?: string;
  resolverSession?: import("./dialogue").ReviewerSession;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  featureContextMarkdown?: string;
  contextBundles?: {
    semantic?: import("../context/engine").ContextBundle;
    adversarial?: import("../context/engine").ContextBundle;
  };
  projectDir?: string;
  env?: Record<string, string | undefined>;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  priorAdversarialFindings?: AdversarialFindingsCache;
}
```

### 3.2 Function body

```typescript
export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const {
    config, workdir, executionConfig, qualityCommands, storyId, storyGitRef,
    story, agentManager, naxConfig, retrySkipChecks, featureName,
    resolverSession, priorFailures, featureContextMarkdown, contextBundles,
    projectDir, env, naxIgnoreIndex, runtime, priorAdversarialFindings,
  } = opts;
  // ... rest of body unchanged
}
```

### 3.3 Caller updates

#### `src/review/orchestrator.ts` — three sites

- Lines 199–219 (the `!hasLLMChecks` flat path)
- Lines 230–250 (mechanical-only path)
- Lines 343–364 (sequential LLM path)

Each becomes `await runReview({ config: ..., workdir, ... })`. The `mechanicalConfig` and `llmConfig` literals stay; just the wrapping changes from positional → object.

#### `src/execution/lifecycle/run-initialization.ts` — `_reconcileDeps.runReview`

Lines 32–33 currently:
```typescript
runReview: (reviewConfig: ReviewConfig, workdir: string, executionConfig: NaxConfig["execution"]) =>
  runReview(reviewConfig, workdir, executionConfig),
```

Becomes:
```typescript
runReview: (reviewConfig: ReviewConfig, workdir: string, executionConfig: NaxConfig["execution"]) =>
  runReview({ config: reviewConfig, workdir, executionConfig }),
```

The `_reconcileDeps.runReview` **public signature stays the same** (3 positional args) so the test mock surface doesn't change. Only the body wraps into an object literal. This is intentional — `_reconcileDeps` is the abstraction boundary for tests; we don't disrupt it.

Line 91 (`_reconcileDeps.runReview(config.review, effectiveWorkdir, config.execution)`) does **not** change — that's calling through the deps interface, not `runReview` directly.

### 3.4 Tests to update

- `test/unit/review/runner.test.ts` — 27 invocations. Most are `await runReview(typecheckConfig, "/tmp/fake-workdir")` → `await runReview({ config: typecheckConfig, workdir: "/tmp/fake-workdir" })`. Two have a 3rd `executionConfig` arg (line 91 with object, lines 299/327 with `undefined` placeholder for `executionConfig` followed by a 4th `qualityCommands` arg) — for the `undefined` placeholders, **drop the field entirely** in the options bag rather than passing `undefined` explicitly.
- `test/integration/review/review.test.ts` — all calls are 2-arg, mechanical.
- `test/integration/review/review-config-commands.test.ts` — mix of 2-arg and 3-arg (with `executionConfig as ExecutionConfig`); convert to `{ config, workdir, executionConfig }`.

### 3.5 Validation

```bash
bun run typecheck
bun run lint
timeout 60 bun test test/unit/review/ --timeout=10000
timeout 90 bun test test/integration/review/ --timeout=20000
timeout 30 bun test test/unit/execution/lifecycle/run-initialization --timeout=10000
```

### 3.6 Commit

```
refactor(review): runReview → options bag (#577)

Convert 21 positional params to a single RunReviewOptions object.
_reconcileDeps.runReview keeps its 3-arg surface (test boundary).
No behaviour change.

Closes part of #577.
```

---

## Phase 4 — `ReviewOrchestrator.review()` → options bag

### 4.1 Interface (in `src/review/orchestrator.ts`, above the class)

```typescript
export interface OrchestratorReviewOptions {
  reviewConfig: ReviewConfig;
  workdir: string;
  executionConfig: NaxConfig["execution"];
  plugins?: PluginRegistry;
  storyGitRef?: string;
  scopePrefix?: string;
  qualityCommands?: NaxConfig["quality"]["commands"];
  storyId?: string;
  story?: SemanticStory;
  agentManager?: IAgentManager;
  naxConfig?: NaxConfig;
  retrySkipChecks?: Set<string>;
  featureName?: string;
  resolverSession?: import("./dialogue").ReviewerSession;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  featureContextMarkdown?: string;
  contextBundles?: { semantic?: ContextBundle; adversarial?: ContextBundle };
  projectDir?: string;
  env?: Record<string, string | undefined>;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  priorAdversarialFindings?: AdversarialFindingsCache;
}
```

### 4.2 Method body

```typescript
async review(opts: OrchestratorReviewOptions): Promise<OrchestratorReviewResult> {
  const {
    reviewConfig, workdir, executionConfig, plugins, storyGitRef, scopePrefix,
    qualityCommands, storyId, story, agentManager, naxConfig, retrySkipChecks,
    featureName, resolverSession, priorFailures, featureContextMarkdown,
    contextBundles, projectDir, env, naxIgnoreIndex, runtime, priorAdversarialFindings,
  } = opts;
  // ... rest of body unchanged
}
```

### 4.3 `reviewFromContext` (same file, line 505+)

Update the `this.review(...)` call (lines 529–557) from positional to options bag. No other changes.

### 4.4 Tests to update

- `test/unit/review/orchestrator.test.ts` — every `orchestrator.review(...)` call. Most use 4 positional args; conversion is `{ reviewConfig: ..., workdir: ..., executionConfig: ..., plugins: ... }`.

### 4.5 Validation

```bash
bun run typecheck
bun run lint
timeout 60 bun test test/unit/review/ --timeout=10000
timeout 90 bun test test/integration/review/ --timeout=20000
timeout 60 bun test test/unit/pipeline/stages/review-dialogue.test.ts --timeout=10000
```

### 4.6 Commit

```
refactor(review): ReviewOrchestrator.review → options bag (#577)

Convert 22 positional params on ReviewOrchestrator.review() to a
single OrchestratorReviewOptions object. reviewFromContext updated
to pass an options literal.

Closes #577.
```

---

## Final gate (after all four phases)

```bash
bun run typecheck
bun run lint
bun run test:bail   # full suite, bail-on-first-failure
```

Open the PR with title `refactor(review): convert review-path functions to options bags (#577)` and the four commits in order.

---

## Risk Ledger — what to NOT do

| Anti-pattern | Why it's banned here |
|:---|:---|
| Renaming fields (`semanticConfig` → `config`) | Reviewer-time bikeshed; expands diff; risks shadowing the outer `config` in nearby blocks. Keep names byte-identical. |
| Promoting optional fields to required | "Always passed today" is a runtime accident, not a contract. Keep `?` markers as-is. |
| Inlining `agentManager` removal | Separate concern. Leaving the parameter dead-but-named is one-liner cheap; removing it touches every test and risks behaviour drift in the "no runtime" branch. |
| Touching `src/operations/{semantic,adversarial}-review.ts` | Already correct. Drift here = breaking the dispatch contract. |
| Fixing nearby code "while we're in there" | Out of scope. If you spot a bug, file a follow-up issue and link it; do not bundle. |
| Splitting interfaces across files | Keep `RunSemanticReviewOptions` / `RunReviewOptions` / `OrchestratorReviewOptions` co-located with their function (same file). One option type per file = easy to find. |
| Defaulting fields inside the destructure (`{ blockingThreshold = "error" } = opts`) | The current code defaults at the use-site (`blockingThreshold ?? "error"`). Don't move it — would be a behaviour change in tests that assert against fall-through. |
| Forwarding `opts` wholesale (`runSemanticReview(opts)` from runner.ts) | Field shapes differ. Always destructure on the boundary and re-construct the inner options literal. Wholesale forwarding hides field-name mismatches. |

---

## Phase 5 — Optional follow-up (DO NOT DO IN THIS PR)

After Phase 4 lands, the `agentManager` parameter on `runSemanticReview`, `runAdversarialReview`, and `runReview` is functionally dead because:

- `runtime` is now required at the dispatch site (semantic.ts:209-215, adversarial.ts:166-172).
- `effectiveAgentManager = runtime?.agentManager ?? agentManager` always resolves to `runtime.agentManager` in production paths.
- The "no agent" early-return (`agentManager` exists but `runtime` does not) is unreachable — the `DISPATCH_NO_RUNTIME` throw fires later in the same function.

A follow-up PR can drop `agentManager` from all three options interfaces and update callers + tests. Estimated diff: ~120 lines, mechanical. **File this as a separate issue** referencing #577 once Phase 4 is merged. Do not bundle it here — it changes behaviour in the legacy "no runtime" code path, even if no production caller exercises it.

---

## What "done" looks like

- [ ] `runSemanticReview`, `runAdversarialReview`, `runReview`, `ReviewOrchestrator.review` each take exactly **one positional parameter** (`opts: …Options`).
- [ ] Each `…Options` interface is **exported** from the same file as its consumer.
- [ ] `_reconcileDeps.runReview` keeps its 3-arg public surface (test boundary).
- [ ] `bun run typecheck` clean.
- [ ] `bun run lint` clean.
- [ ] `bun run test:bail` passes.
- [ ] Four atomic commits, in phase order, all referencing #577.
- [ ] PR description notes "no behaviour change — pure signature refactor".
