# SPEC: Lazy rules delivery for workflow mode, with run-level rules and context overrides

Closes: #2377

## Summary

In workflow mode, stop pushing every canonical rule body into each story brief through context engine v2. Instead:

1. Each brief carries a short **rules index** built from rule frontmatter, with one line per rule: id, file, `appliesTo` scope and description.
2. A run-scoped **native rule-delivery loop handler** puts the body of a governing rule into the session when it is needed:
   - When a workflow session reads a governed file, the rule text is prefixed to the read's result.
   - When a writing session (`wf-implementer`, `wf-branch-fix`) writes or edits a governed file whose rule it has not yet seen, the call is refused once, with the rule text, and can then be retried.
3. Story and branch **review packages** list, per rule, the changed files it governs. They carry names only, never bodies.
4. The workflow pipeline's context stage stops calling the v2 orchestrator. The brief keeps only the feature context: the feature `context.md` plus dependency fragments.

The same feature delivers #2377:
- a **rules override directory** (`nax run --rules-dir`, `context.rules.overrideDir`, `merge` or `replace`) that feeds one shared rule-set resolver, and so every delivery path;
- a **project-context override file** (`nax run --context-file`, `context.projectContext`) that is appended to briefs and branch review packages. In `replace` mode, native sessions also stop auto-loading the repo-root instruction file.

Context engine v2 keeps serving pipeline mode, which is frozen, and the `push` fallback.

## Motivation

Measured on main `535080033` (2026-10-18):

- **Workflow mode uses v2 for one thing.** `contextStage`'s `runV2Path` (`packages/nax/src/pipeline/stages/context.ts:74`) assembles one bundle (`:270`). It copies `bundle.pushMarkdown` into `ctx.featureContextMarkdown` (`:296`), and `writeBrief` renders that under "## Feature context" (`packages/nax/src/workflow/brief.ts:88`).
  - The bundle also reaches `CallContext.contextBundle` (`packages/nax/src/workflow/call-context.ts:46`), where it serves only the pull tools and agent-swap rebuild.
  - Per-stage assemblies, the rectify providers, effectiveness scoring and provider weights serve only frozen pipeline mode.
- **That bundle is mostly rules, and it is carried on every turn.**
  - Across 379 workflow briefs since 2026-10-01, the average brief is 43.7 KB, and 61% of it is the v2 block.
  - The brief for nax US-002 of `advisor-read-evidence-and-state-loss` was 78.7 KB, of which 65 KB was 57 rule sections from 10 files.
  - The agent loads the brief with a Read call, so the whole block is re-sent on every later turn.
  - Across 2,006 context manifests since 2026-09-20, `static-rules` is 84% of engine tokens, `feature-context` 10%, `git-history` 3% and `code-neighbor` 1.7%.
- **The pull tools are dead.** `query_neighbor`, `query_scratch` and `query_feature_context` were called 0 times in 6,394 recorded tool-audit sessions, ever.
- **Rule value was not measurable as pushed.** In #2042's 2026-09-25 A/B (two runs per arm), turning rules off removed about 95% of each stage's bundle with no quality change. In one rules-off run, the agent saw only the 153-token notice naming the dropped rules and read `test-ratchets.md` by itself. That is this feature's on-demand model, happening by accident. #2042 stays open for its convention-heavy A/B.
- **Overflow risk rules out pushing bodies to reviewers.** A large branch diff can match most of a repo's rules (nax has 13 rule files, 83 KB). Review packages carry rule names only. A native reviewer receives a rule body only for a file it actually reads, once per session, under a per-call cap.
- **#2377:** an orchestrator that runs `nax run` across many repos cannot supply organisation-wide or per-job rules or project context without committing them into each target repo.

## Design

### Approach

There is one implementation per concern, and none of them uses an LLM:

| Concern | Mechanism |
|:--|:--|
| Which rules exist for a package | `resolveRuleSet`. Layers are applied in order: repo `.nax/rules/`, then package `<pkg>/.nax/rules/`, then the override directory. A later layer replaces an earlier rule with the same rule id. In `replace` mode, only the override layer is used. Override rules are treated like repo-level rules: filtered by `paths:` through `ruleMatchesPackage`, and their literal `appliesTo` entries framed through `frameAppliesTo`. |
| Which rules govern one file | `rulesForFile`. It finds the file's package (`findPackageDir`), resolves that package's rule set, and keeps the rules whose `appliesTo` matches the file. A rule with no `appliesTo` governs every file. |
| What a session is told up front | The rules index section in the brief (`buildRulesIndexSection`). |
| When a native session sees a rule body | `before_tool` and `before_compaction` loop handlers (`createRuleDeliveryHandlers`), registered after plugin handlers at run setup and scoped by session role. |
| What reviewers are told | A "Rules for the changed files" section appended to each review package (`buildChangedFileRulesSection`). |

`stages:` frontmatter is not applied anywhere in workflow mode, so the index and the hook ignore it. It stays a pipeline-only key.

**Role scope of the rule-delivery handler**, read from `LoopHandlerContext.role`:
- Read nudges apply to `wf-implementer`, `wf-branch-fix`, `wf-story-review`, `wf-rereview` and `wf-branch-review`.
- Write/Edit blocks apply only to `wf-implementer` and `wf-branch-fix`.
- Every other role (for example `advisor`), and a context with no role, gets `allow`.

The handler follows the pattern native already uses for directory-scoped instructions. `createInstructionInteraction` (`packages/nax-agent/src/native/session/instruction-interaction.ts`) refuses a mutation once, with "No files were changed", after new guidance is found, and the agent retries. This feature does the same through the public `before_tool` loop event, so it needs no change to `packages/nax-agent`.

### Integration

Mutated symbols are listed as **Baseline → Target**. The baseline only locates the code and is never the interface to implement.

| Symbol | Location | Baseline → Target |
|:--|:--|:--|
| `loadCanonicalRules(workdir, options)` | `packages/nax/src/context/rules/canonical-loader/index.ts:432` | Baseline: joins `CANONICAL_RULES_DIR` onto `workdir` and loads. → Target: same signature, delegating to a new exported `loadCanonicalRulesFromDir(rulesDir: string, options?: LoadCanonicalRulesOptions): Promise<CanonicalRule[]>`. That function holds today's body, so the depth cap, frontmatter policy and `lintForNeutrality` apply unchanged to any directory. |
| `StaticRulesProvider.fetch` | `packages/nax/src/context/engine/providers/static-rules.ts:184` | Baseline: the repo/package load-merge-frame block inline at `:189-260`. It loads both the repo layer (`loadCanonicalRules(request.repoRoot)`) and the package layer (`loadCanonicalRules(request.packageDir)`) through `_staticRulesDeps.loadCanonicalRules` (`:51`). → Target: that block becomes one `resolveRuleSet(input, { loadRepoRules: _staticRulesDeps.loadCanonicalRules })` call. Its result carries `rules` plus the pre-filter counts `repoRulesTotal`, `repoRulesMatchedPaths` and `packageRulesCount`, which the `#558` "none apply" branch (`:263-270`) keeps reading unchanged. Under `overrideMode: "replace"` the repo and package layers are not loaded, so all three counts are 0 and that branch cannot fire. `loadRepoRules` serves BOTH the repo and the package layer, so the existing stubs in six test files keep driving `fetch`. The file-private `canonicalRuleId`, `canonicalRulePath` and `canonicalRulePriority` (`:106-116`) move to the rule-set module and are imported back. The stage, `appliesTo` and budget logic after the block is unchanged. The file is at 591/600 lines, and the extraction must leave it smaller. |
| `StaticRulesProvider` constructor options | `static-rules.ts` options object | Target: gains optional `overrideDir?: string` and `overrideMode?: "merge" \| "replace"`, forwarded to `resolveRuleSet`. |
| `createDefaultOrchestrator(story, config, ...)` | `packages/nax/src/context/engine/orchestrator-factory.ts:42` | Target: passes `config.context?.rules?.overrideDir` and `config.context?.rules?.overrideMode` into the `StaticRulesProvider` options. |
| `ContextConfigSchema` | `packages/nax/src/config/schemas-context.ts:298` | Target: gains `rules` and `projectContext`. Each is declared as `XBase.default(() => XBase.parse({}))`, like `TestCoverageConfigSchema` (`:23`), because `NaxConfigSchema` re-parses `ContextConfigSchema.parse({})` for its default (`packages/nax/src/config/schemas.ts:349`). |
| `pinRootOnlyKeys(merged, root)` | `packages/nax/src/config/root-only-keys.ts:13` | Target: returns `context: { ...merged.context, rules: root.context.rules, projectContext: root.context.projectContext }`, leaving every other `context.*` key as merged. |
| `pinRootOnlyKeysRaw(raw, root, packageDir, onIgnored)` | `root-only-keys.ts` | Target: when `raw.context.rules` or `raw.context.projectContext` differs from the root value (`Bun.deepEquals`), calls `onIgnored` once naming the key and replaces only that sub-key, spreading the rest of `raw.context` unchanged. |
| `RunActionOptions` | `packages/nax/bin/run-action.ts:47` | Target: gains `rulesDir?: string` and `contextFile?: string`. |
| `resolveRunProjectContext(workdir, options)` | `packages/nax/bin/run-action.ts:263` | Target: maps `options.rulesDir` to `cliOverrides.context.rules.overrideDir`, and `options.contextFile` to `cliOverrides.context.projectContext.file`. An absolute or `~/` value passes through unchanged; anything else becomes `join(workdir, value)`. |
| `run` command options | `packages/nax/bin/nax.ts:214-243` | Target: adds `--rules-dir <path>` and `--context-file <path>`. The project-context flag is NOT `--context`, because `--no-context` (`:220`) already defines `options.context` as a boolean. |
| `initializeAfterLock` | `packages/nax/src/execution/lifecycle/run-setup-init.ts:180` | Baseline: `runtime.sessionManager.configureLoopHandlers(pluginRegistry.getLoopHandlers())`. → Target: `runtime.sessionManager.configureLoopHandlers(await configureRunRules({ config, workdir, pluginHandlers: pluginRegistry.getLoopHandlers() }))`. All new branching lives in `configureRunRules`, because `initializeAfterLock` is baselined at complexity 21 (`scripts/baselines/complexity-baseline.json:73`) and `bun run check:complexity` allows no growth. `InitializeAfterLockDeps` is unchanged. |
| `buildWorkflowPipeline()` | `packages/nax/src/pipeline/stages/index.ts:68` | Baseline: `[queueCheckStage, routingStage, constitutionStage, contextStage, lazyWorkflowStage, completionStage]`. → Target: `contextStage` is replaced by `workflowContextStage`, whose `name` is `"context"`. `buildDefaultPipeline` (pipeline mode) is unchanged. |
| `runV2Path` session allocation | `packages/nax/src/pipeline/stages/context.ts:76-104` | Target: the block that sets `ctx.sessionId`, `ctx.sessionScratchDir` and `ctx.contextToolRunCounter` moves into an exported `allocateStorySession(ctx)` in a new `context-session.ts`. `runV2Path` and `workflowContextStage` both call it, so workflow gates keep their `sessionScratchDir` (`packages/nax/src/workflow/gates.ts:112`) and `metrics/tracker.ts:311` keeps its run counter. |
| `WorkflowBriefInput` / `buildWorkflowBrief` | `packages/nax/src/prompts/builders/workflow-implementer-builder.ts:15` | Target: gains optional `rulesIndex?: { entries: readonly RulesIndexEntry[]; shownAutomatically: boolean }` and `projectContextOverride?: string`. They render as "## Rules index" (before "## Feature context") and "## Project context (run override)" (after "## Feature context"). The existing "## Project rules" section (the constitution) is unchanged. |
| `_workflowDeps` | `packages/nax/src/workflow/step-context.ts:47` | Target: gains `resolveRuleSet`, `appendChangedFileRules` and `loadProjectContextOverride`, each added by the story that first calls it. |
| `writeBrief(sc)` | `packages/nax/src/workflow/brief.ts:77` | Target: when `sc.config.context?.rules?.delivery` is `"index"` (the default), it calls `_workflowDeps.resolveRuleSet({ repoRoot: sc.projectDir, packageDir: sc.workdir, storyWorkdir: storyWorkdir(sc.story), overrideDir, overrideMode })` (`storyWorkdir` from `@/utils/path-frame`) and passes `rulesIndex`, with `shownAutomatically = sc.callCtx.agentName === "native"`. When a file is configured, it passes `projectContextOverride` from `_workflowDeps.loadProjectContextOverride`. |
| `writeReviewPackage(projectDir, from, path)` | `packages/nax/src/workflow/git.ts:195` | Baseline: returns `Promise<void>`. → Target: returns `Promise<string[]>`. Its existing `--name-only -z` query stays as is, because `omittedFilesSection` (`git.ts:103-114`) reads it. A fifth query, `--name-status -z`, uses the same range and pathspec, so `ALWAYS_EXCLUDED` applies, and the function returns `parseNameStatus(...).flatMap(survivingPaths)`, exactly as `writeBranchReviewPackage` does (`git.ts:166`). Existing callers only `await` it. |
| `runStoryReview` package step | `packages/nax/src/workflow/story-review.ts:78` | Target: inside the same `underReviewLimit` first callback that calls `writeReviewPackage`, and in `delivery: "index"` only, calls `_workflowDeps.appendChangedFileRules(packagePath, paths, input)` with the paths `writeReviewPackage` returned. |
| `runBranchReview` package step | `packages/nax/src/workflow/branch-review.ts:59` | Target: inside the same callback, after `writeBranchReviewPackage` returns `paths`, calls `_workflowDeps.appendChangedFileRules` (index mode). When a file is configured, it also appends the project-context override section. |
| `instructionOptionsForSession(agentName, options)` | `packages/nax/src/session/instruction-options.ts:13` | Target: when `options.config.context?.projectContext?.mode === "replace"` and a file is set, appends `rootInstructionDenyPaths(fileName)` to `instructionDenyPaths`. `fileName` is the configured `instructionFileName`; the default gives `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md`. `matchesDenyPaths` anchors on the whole repo-relative path (`packages/nax-agent/src/tools/deny-paths.ts`), and `RepositoryInstructions.load` applies it to every discovered instruction file (`packages/nax-agent/src/native/session/repository-instructions.ts:133`). So a bare `AGENTS.md` denies only the root file, and package-level instruction files still load. |

`workflowContextStage.execute(ctx)`, in the new `packages/nax/src/pipeline/stages/workflow-context.ts`:
1. If `ctx.config.context.v2.enabled` is false, or `context.rules.delivery` is `"push"`, it returns `contextStage.execute(ctx)`, which is today's behaviour, v1 path included.
2. Otherwise it calls `allocateStorySession(ctx)`. It builds a `ContextRequest` with `storyId`, `featureId`, `repoRoot: ctx.projectDir`, `packageDir: ctx.workdir`, `storyWorkdir`, `stage: "context"`, `role: "implementer"` and `budgetTokens`, each derived as `runV2Path` derives it (`context.ts:176-205`). It calls `_workflowContextStageDeps.featureContextProvider(ctx.story, ctx.config).fetch(request)`.
3. It joins the returned chunks' `content` with a blank line, in returned order, and sets `ctx.featureContextMarkdown` to the result. The field is left undefined when no chunk returns.
4. The result is unpacked, as it is today: `feature` is a floor kind (`FLOOR_KINDS`, `packing.ts:54`), so the orchestrator never budgeted it either.
5. In index mode it does not set `ctx.contextBundle`, `ctx.scopeFiles` or `ctx.resolvedTestPatterns`, and writes no manifest or digest:
   - `scopeFiles` and `resolvedTestPatterns` are read only by pipeline-mode stages (`prompt.ts:57`, `execution.ts:105`, `stage-assembler.ts:279`).
   - Without `contextBundle`, workflow `CallContext`s carry none, so `runWithFallback` receives no bundle and an agent swap has no bundle to rebuild. `swap-decision.ts:48-54` already tolerates that case.
   - `ctx.contextMarkdown` (story context) is set only by `runV1Path` today, so workflow v2 runs lose nothing.

Read-only symbols reused as-is:
- `ruleMatchesPackage`, `frameAppliesTo`, `globToRegex` and `normalizePath` (`packages/nax/src/context/engine/scope-path-match.ts`)
- `ruleMatchesScopeFiles` (`static-rules.ts:133`), called with a one-element scope
- `findPackageDir(filePath, workdir): Promise<string | undefined>` (`packages/nax/src/test-runners/resolver.ts:269`)
- `FeatureContextProviderV2` (`packages/nax/src/context/engine/providers/feature-context.ts:199`)
- `isWorkflowMode(config)` (`packages/nax/src/config/schemas-workflow.ts:42`)
- `BeforeToolOutcome` and `BeforeCompactionPayload` (`packages/nax-agent/src/native/session/loop-events/types.ts`)
- `LoopHandlerContext` `sessionName`, `role` and `storyId`

Workflow mode forces `execution.storyIsolation: "shared"` (`packages/nax/src/config/workflow-mode.ts:22`), so tool paths in a workflow session are repo-rooted. Native `Read`, `Write` and `Edit` take `input.path`, "Path relative to the repository root" (`packages/nax-agent/src/tools/edit.ts:51`, `write.ts:19`).

Prompt text lives in a new builder module, `packages/nax/src/prompts/builders/rules-index-builder.ts`, exported from `src/prompts`. That covers the rules index, the delivered rule text and the changed-file rules section, per the Prompt Builder Convention.

Consumers read the new keys defensively (`config.context?.rules?.delivery ?? "index"`), matching the existing `context?.v2?.` reads, so sparse test configs do not throw.

New modules are nested barrels reached by exact alias, the sanctioned pattern for avoiding parent-barrel cycles: `@/context/rules/rule-set`, `@/context/rules/rule-delivery` and `@/context/project-context-override`. Production code never imports them by internal path. New config keys get entries in `packages/nax/src/cli/config-descriptions.ts`. New tests go in new test files, because `static-rules.test.ts` is at its file-size baseline (837 lines) and may not grow.

### Interfaces

Worked skeletons for the shapes that cross story boundaries. The names are normative.

```typescript
// packages/nax/src/context/rules/rule-set/index.ts  (US-001)
export type RuleSource = "repo" | "package" | "override";
export interface ResolvedRule extends CanonicalRule {
  readonly ruleId: string;       // canonicalRuleId(rule)
  readonly source: RuleSource;
  readonly displayPath: string;  // ".nax/rules/<rel>", "<storyWorkdir>/.nax/rules/<rel>", or the absolute override path
}
export interface ResolveRuleSetInput {
  readonly repoRoot: string;
  readonly packageDir: string;    // absolute; equals repoRoot for the root package
  readonly storyWorkdir?: string; // repo-relative package frame
  readonly overrideDir?: string;  // absolute
  readonly overrideMode?: "merge" | "replace"; // default "merge"
}
export interface RuleLoaders {
  /** Loads `<workdir>/.nax/rules`, for the repo layer AND the package layer. Default: memoized `loadCanonicalRules` (key: workdir). */
  readonly loadRepoRules?: (workdir: string) => Promise<CanonicalRule[]>;
  /** Loads an override directory. Default: memoized `loadCanonicalRulesFromDir` (key: absolute dir). */
  readonly loadDirRules?: (dir: string) => Promise<CanonicalRule[]>;
}
export interface ResolvedRuleSet {
  readonly rules: readonly ResolvedRule[];
  readonly repoRulesTotal: number;        // repo rules before the paths: filter
  readonly repoRulesMatchedPaths: number; // repo rules after the paths: filter
  readonly packageRulesCount: number;     // package-layer rules loaded (0 at the root)
}
export function resolveRuleSet(input: ResolveRuleSetInput, loaders?: RuleLoaders): Promise<ResolvedRuleSet>;
export interface RulesForFileInput {
  readonly repoRoot: string;
  readonly path: string;          // repo-relative, normalized
  readonly overrideDir?: string;
  readonly overrideMode?: "merge" | "replace";
}
export function rulesForFile(input: RulesForFileInput, loaders?: RuleLoaders): Promise<ResolvedRule[]>;
export function canonicalRuleId(rule: CanonicalRule): string;
export function canonicalRulePath(rule: CanonicalRule): string;
export function canonicalRulePriority(rule: CanonicalRule): number;

// packages/nax/src/context/project-context-override/index.ts  (US-007)
export const MAX_PROJECT_CONTEXT_BYTES = 32_768;
export function loadProjectContextOverride(config: NaxConfig): Promise<string | undefined>;
export function rootInstructionDenyPaths(instructionFileName: string): string[];

// packages/nax/src/execution/lifecycle/run-rules-setup.ts  (US-002; US-005 adds the handler set; US-007 the context-file check)
export const _runRulesSetupDeps: {
  dirExists: (path: string) => Promise<boolean>;
  loadProjectContextOverride: typeof loadProjectContextOverride; // US-007
  createRuleDeliveryHandlers: typeof createRuleDeliveryHandlers; // US-005
};
/** Validates both overrides (throws before returning); returns the set for configureLoopHandlers. */
export function configureRunRules(input: { config: NaxConfig; workdir: string; pluginHandlers: LoopHandlerSet }): Promise<LoopHandlerSet>;

// packages/nax/src/prompts/builders/rules-index-builder.ts  (US-003; US-005 and US-006 add functions)
export interface RulesIndexEntry {
  readonly ruleId: string;
  readonly displayPath: string;
  readonly source: RuleSource;
  readonly description: string;          // description:, else first heading, else ruleId
  readonly appliesTo: readonly string[]; // empty = all files
  readonly priority: number;
}
export function toRulesIndexEntry(rule: ResolvedRule): RulesIndexEntry;
export function buildRulesIndexSection(input: { entries: readonly RulesIndexEntry[]; shownAutomatically: boolean }): string;
export function buildRuleDeliveryText(input: { path: string; delivered: readonly ResolvedRule[]; listedOnly: readonly ResolvedRule[]; mode: "read" | "write" }): string; // US-005
export interface ChangedFileRuleGroup { readonly rule: RulesIndexEntry; readonly paths: readonly string[] } // paths in diff order
export function buildChangedFileRulesSection(groups: readonly ChangedFileRuleGroup[]): string; // US-006

// packages/nax/src/context/rules/rule-delivery/index.ts  (US-005)
export const MAX_RULE_INJECTION_BYTES = 16_384;
export const RULE_READ_ROLES: readonly string[];  // wf-implementer, wf-branch-fix, wf-story-review, wf-rereview, wf-branch-review
export const RULE_WRITE_ROLES: readonly string[]; // wf-implementer, wf-branch-fix
export interface RuleDeliveryInput { readonly repoRoot: string; readonly overrideDir?: string; readonly overrideMode: "merge" | "replace" }
export const _ruleDeliveryDeps: { rulesForFile: typeof rulesForFile; resolveRuleSet: typeof resolveRuleSet };
/** One before_tool entry and one before_compaction entry, both with plugin "nax-rules". */
export function createRuleDeliveryHandlers(input: RuleDeliveryInput): LoopHandlerSet;

// packages/nax/src/workflow/review-rules-map.ts  (US-006)
export const _reviewRulesMapDeps: { rulesForFile: typeof rulesForFile };
export function appendChangedFileRules(
  packagePath: string,
  changedPaths: readonly string[],
  input: { repoRoot: string; overrideDir?: string; overrideMode: "merge" | "replace" },
): Promise<void>;
```

**Rule-delivery handler mechanics:**
- **Path normalization.** The handler normalizes `input.path` before matching. A missing or non-string path gives `allow`. An absolute path inside `repoRoot` is relativized, and the result passes through `posix.normalize` and `normalizePath`, so `./x` and `a/../x` match as `x`. A path that normalizes outside `repoRoot` is outside.
- **Caching.** It caches `findPackageDir` results by directory and each package's rule set by package, both for the life of the run. After the first call for a given directory, matching does no file I/O.
- **Rule-file reads.** Before any outside-root or `.nax/` check, the handler compares the normalized path (or the absolute path, for override rules) with the `displayPath`s of the rules it knows. These are every rule `rulesForFile` has returned so far, plus the root package's set from `_ruleDeliveryDeps.resolveRuleSet`, loaded on the handler's first call. A match marks that rule delivered and returns `allow`.
- **Errors.** It catches every error and returns `allow`, so the native loop wrapper's error path is never taken.
- **Session state.** Per-session delivered state is a map keyed by `sessionName`. `before_compaction` drops a session's state, and it is not otherwise cleaned during a run.
- **Batched calls.** Two calls in one batch that both deliver the same rule may each carry it; that is a benign duplicate.

### File Format

New config keys, with all fields shown at their defaults except the two paths:

```json
{
  "context": {
    "rules": {
      "delivery": "index",
      "overrideDir": "/abs/path/to/org-rules",
      "overrideMode": "merge"
    },
    "projectContext": {
      "file": "~/fleet/contexts/strict-unattended.md",
      "mode": "append"
    }
  }
}
```

- `context.rules.delivery`: `"index"` (default) or `"push"`. `"push"` restores today's workflow behaviour. `contextStage` runs the v2 orchestrator, the brief carries the rule bodies, and no rule-delivery handlers or review-package rules sections are produced.
- `context.rules.overrideDir`: optional.
  - Must be absolute or start with `~/`; `~/` expands to the home directory.
  - A relative value fails config validation. On the CLI, see `resolveRunProjectContext` above.
  - The directory has the layout and frontmatter of `.nax/rules/`.
- `context.rules.overrideMode`: `"merge"` (default) or `"replace"`.
- `context.projectContext.file`: optional, with the same path rules as `overrideDir`. A Markdown file of at most 32,768 bytes.
- `context.projectContext.mode`: `"append"` (default) or `"replace"`.
- Who can set them:
  - All these keys are settable in global config, project config, a profile and on the CLI. The repo is inside nax's trust boundary (`docs/architecture/agent-adapters.md` §17, D-1), so no layer is rejected.
  - A per-package `.nax/mono/<pkg>/config.json` cannot change them (root-only pinning).

Rules index section (brief) for a native implementer (`shownAutomatically: true`):

```markdown
## Rules index

This repository's rules. Each rule's full text is shown to you the first time you read, write or edit a file it applies to. Open a rule's file to read it sooner.

- `forbidden-patterns-source` (.nax/rules/forbidden-patterns-source.md): Forbidden Patterns. Applies to: packages/nax/src/**/*.ts, packages/nax/bin/*.ts, packages/nax-agent/src/**/*.ts
- `org-logging` (/abs/path/to/org-rules/org-logging.md, override): Logging policy for unattended runs. Applies to: all files
```

With `shownAutomatically: false`, the second sentence is replaced by: "Before you write or edit a file a rule applies to, read that rule's file."

- **Line content.** Each line holds the rule id, the display path, `, override` for override-sourced rules, the description and the scope.
- **Scope.** The `appliesTo` globs joined with `, `, or `all files` when there is no `appliesTo`. Literal entries are shown after `frameAppliesTo`.
- **Order.** Priority ascending, then rule id.
- **Empty set.** The section is omitted when the rule set is empty.

Delivered rule text (the nudge prefix on Read; the block content on Write/Edit):

```markdown
Rules that apply to packages/nax/src/foo.ts:

### forbidden-patterns-source (.nax/rules/forbidden-patterns-source.md)
<rule body, frontmatter stripped>
```

Rules past the byte cap follow as `Also applies (not shown, open the file): <ruleId> (<displayPath>)` lines. On Write/Edit, the text ends with: "No files were changed. Review these rules and retry the tool call."

Changed-file rules section (review packages):

```markdown
## Rules for the changed files

Read a rule's file before you judge the changed code against it.

- `forbidden-patterns-source` (.nax/rules/forbidden-patterns-source.md): 14 changed files, e.g. packages/nax/src/a.ts, packages/nax/src/b.ts, packages/nax/src/c.ts
```

- **Lines.** One line per rule that governs at least one changed file, with at most three example paths in diff order.
- **Excluded paths.** Paths under a `.nax/` directory are skipped.
- **Empty section.** It is omitted when no rule governs any changed file.

Project-context override section (brief and branch review package):

```markdown
## Project context (run override)

<file content, verbatim>
```

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `overrideDir` configured but missing or not a directory at run start | `configureRunRules` throws `NaxError` code `RULES_OVERRIDE_DIR_NOT_FOUND` (context `stage: "run-setup"`, `overrideDir`) before any story runs. Fail-closed: the operator asked for those rules. |
| An override rule file fails the neutrality lint | Same as a repo rule: `NeutralityLintError` from `loadCanonicalRulesFromDir`. |
| An override rule file has invalid frontmatter | Same as a repo rule: warned and skipped. |
| `projectContext.file` missing at run start | `NaxError` code `PROJECT_CONTEXT_FILE_NOT_FOUND` before any story runs. |
| `projectContext.file` larger than 32,768 bytes | `NaxError` code `PROJECT_CONTEXT_FILE_TOO_LARGE` before any story runs. It is never truncated. |
| `projectContext.mode: "replace"` while the run's default agent is not `native` | One `logger.warn("run-setup", ...)` at run start saying replace applies to native sessions only and that other agents still load the repository's own instruction files. The run continues. |
| Rule resolution throws inside a rule-delivery handler | The handler catches it, returns `{ kind: "allow" }` (fail-open), logs `logger.warn("rules", ...)` with `storyId` first, and marks nothing delivered. |
| One call's matching undelivered rules exceed `MAX_RULE_INJECTION_BYTES` (16,384) | Bodies are included in priority order up to the cap. Later rules are listed by id and path only and stay undelivered, so a later call delivers them. The cap is below half of native's 40,000-byte tool-result limit (`MODEL_MAX_BYTES`, `truncate.ts:28`), which a nudge shares with the file content. |
| The feature-context provider's `fetch` throws in `workflowContextStage` | Warn and continue with no feature context, as `runV2Path` does today. |

## Out of Scope

- Pipeline mode (`execution.mode: "pipeline"`, frozen since 2026-10-16) is unchanged. It keeps `contextStage`, the v2 orchestrator and rule pushing; only the rules override directory reaches it, through `StaticRulesProvider`.
- Deleting context engine v2 is deferred until pipeline mode is removed. This feature only stops the workflow pipeline from calling it under `delivery: "index"`.
- Rule `stages:` frontmatter is not applied in workflow mode, by either the rules index or the rule-delivery handlers.
- ACP agents get no rule-delivery hook; they receive the rules index and the changed-file rules sections only. Claude in write mode also loads `.claude/rules` natively when the repo exported them; nax does not check that export for drift.
- Override-sourced rules are referenced by absolute path. This feature does not guarantee that an ACP agent's permission policy allows reading a path outside the workdir.
- Only `Read`, `Write` and `Edit` trigger rule delivery. `Delete`, `Bash`, `RunCommand`, `Git` and other tools neither nudge nor block.
- Adding `description:` frontmatter to existing repositories' `.nax/rules/*.md` files is a manual follow-up outside the run.
- The #2042 convention-heavy A/B (`index` vs `push`) is not run by this feature. #2042 stays open for it.
- The project-context override reaches the story brief and the branch review package only. The prompts of `wf-rereview` and `wf-branch-fix` sessions do not change.
- `projectContext.mode: "replace"` stops native sessions from loading the repo-root instruction file only. Package-level instruction files and every ACP agent's native instruction loading are unchanged.
- No per-rule delivery telemetry beyond the `rules.delivered` log line. Context manifests are not written for `delivery: "index"` workflow assemblies.
- When a plugin `before_tool` handler and the rule-delivery handler both nudge one call, the native loop keeps only the last nudge (`registry.ts:232`), which is the rule-delivery handler's. Concatenating nudges in the shared chain is not part of this feature.
- A rule-delivery handler that exceeds the native loop's 10 s plugin deadline is handled by the existing wrapper, which blocks the call once; this feature does not change or re-test that behaviour.
- In `delivery: "index"`, workflow calls carry no `contextBundle`, so an agent swap has no context bundle to rebuild. The pull tools are not offered.

## Stories

All stories are in the `packages/nax` workspace package.

1. **US-001: Rule-set resolver with override layer**, `Workdir: packages/nax`, depends on US-002. Extract the repo/package rule merge from `StaticRulesProvider.fetch` into `resolveRuleSet` and `rulesForFile`, add `loadCanonicalRulesFromDir` and the override layer (`merge`/`replace`), and wire `overrideDir` through `createDefaultOrchestrator`.
2. **US-002: Override config, CLI flags and run-start validation**, `Workdir: packages/nax`, no dependencies. Add the `context.rules` and `context.projectContext` config blocks with root-only pinning, `--rules-dir` and `--context-file`, and `configureRunRules` with the override-directory existence check, called from `initializeAfterLock`.
3. **US-003: Rules index in the brief**, `Workdir: packages/nax`, depends on US-001, US-002. Add `toRulesIndexEntry` and `buildRulesIndexSection`, and the "## Rules index" section that `writeBrief` emits under `delivery: "index"`.
4. **US-004: Workflow context stage without the v2 orchestrator**, `Workdir: packages/nax`, depends on US-002. Add `allocateStorySession` and `workflowContextStage`, and swap it into `buildWorkflowPipeline`.
5. **US-005: Native rule-delivery loop handlers**, `Workdir: packages/nax`, depends on US-001, US-002, US-003. Add `createRuleDeliveryHandlers` (role-scoped nudge on Read, block once on Write/Edit, rule-file reads, compaction reset, byte cap, caches, fail-open) and register them through `configureRunRules`.
6. **US-006: Changed-file rules sections in review packages**, `Workdir: packages/nax`, depends on US-001, US-002, US-003, US-005. Add `buildChangedFileRulesSection` and `appendChangedFileRules`, make `writeReviewPackage` return its paths, and call the append from `runStoryReview` and `runBranchReview`.
7. **US-007: Project-context override delivery**, `Workdir: packages/nax`, depends on US-002, US-003, US-005, US-006. Add `loadProjectContextOverride` with its run-start existence and size checks in `configureRunRules`, the brief and branch-package sections, native root-instruction denial in `replace` mode, and the run-start warning for non-native default agents.

### Context Files

**US-001**

- `packages/nax/src/context/engine/providers/static-rules.ts` — the `:189-260` merge block to extract; constructor options
- `packages/nax/src/context/rules/canonical-loader/index.ts` — `loadCanonicalRules`, to split into `loadCanonicalRulesFromDir`
- `packages/nax/src/context/engine/scope-path-match.ts` — `ruleMatchesPackage`, `frameAppliesTo`
- `packages/nax/src/context/engine/orchestrator-factory.ts` — `createDefaultOrchestrator`
- `packages/nax/src/test-runners/resolver.ts` — `findPackageDir`

**US-002**

- `packages/nax/src/config/schemas-context.ts` — `ContextConfigSchema`
- `packages/nax/src/config/root-only-keys.ts` — `pinRootOnlyKeys`, `pinRootOnlyKeysRaw`
- `packages/nax/bin/run-action.ts` — `RunActionOptions`, `resolveRunProjectContext`
- `packages/nax/bin/nax.ts` — `run` command options
- `packages/nax/src/execution/lifecycle/run-setup-init.ts` — `initializeAfterLock` at `:180`

**US-003**

- `packages/nax/src/workflow/brief.ts` — `writeBrief`
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `WorkflowBriefInput`, `buildWorkflowBrief`
- `packages/nax/src/workflow/step-context.ts` — `_workflowDeps`
- `packages/nax/src/context/rules/rule-set/index.ts` — created by US-001, consumed here

**US-004**

- `packages/nax/src/pipeline/stages/index.ts` — `buildWorkflowPipeline`
- `packages/nax/src/pipeline/stages/context.ts` — `runV2Path`, its session allocation and request construction
- `packages/nax/src/context/engine/providers/feature-context.ts` — `FeatureContextProviderV2`
- `packages/nax/test/unit/pipeline/workflow-pipeline.test.ts` — the stage-name assertion to keep green

**US-005**

- `packages/nax/src/execution/lifecycle/run-rules-setup.ts` — created by US-002; `configureRunRules` gains the handler set here
- `packages/nax/src/session/loop-handler-forwarding.ts` — how a set reaches native turns; `LoopHandlerContext`
- `packages/nax-agent/src/native/session/loop-events/types.ts` — `BeforeToolOutcome`, `BeforeCompactionPayload`, `LoopHandlerEntry`
- `packages/nax-agent/src/native/session/instruction-interaction.ts` — the refuse-once-then-retry precedent
- `packages/nax/src/prompts/builders/rules-index-builder.ts` — created by US-003, extended here

**US-006**

- `packages/nax/src/workflow/story-review.ts` — `runStoryReview`; `_workflowDeps` (`step-context.ts`) gains `appendChangedFileRules`
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview`
- `packages/nax/src/workflow/git.ts` — `writeReviewPackage`, `writeBranchReviewPackage`
- `packages/nax/src/prompts/builders/rules-index-builder.ts` — created by US-003, extended here
- `packages/nax/src/context/rules/rule-set/index.ts` — created by US-001, consumed here

**US-007**

- `packages/nax/src/session/instruction-options.ts` — `instructionOptionsForSession`
- `packages/nax/src/workflow/brief.ts` — `writeBrief`; `_workflowDeps` (`step-context.ts`) gains `loadProjectContextOverride`
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview`
- `packages/nax/src/execution/lifecycle/run-rules-setup.ts` — created by US-002; gains the context-file check and the replace-mode warning

### Creates

**US-001**

- `packages/nax/src/context/rules/rule-set/index.ts` — `RuleSource`, `ResolvedRule`, `resolveRuleSet`, `rulesForFile`, the moved `canonicalRule*` helpers

**US-002**

- `packages/nax/src/execution/lifecycle/run-rules-setup.ts` — `configureRunRules`, `_runRulesSetupDeps`

**US-003**

- `packages/nax/src/prompts/builders/rules-index-builder.ts` — `RulesIndexEntry`, `toRulesIndexEntry`, `buildRulesIndexSection`

**US-004**

- `packages/nax/src/pipeline/stages/workflow-context.ts` — `workflowContextStage`, `_workflowContextStageDeps`
- `packages/nax/src/pipeline/stages/context-session.ts` — `allocateStorySession`

**US-005**

- `packages/nax/src/context/rules/rule-delivery/index.ts` — `createRuleDeliveryHandlers`, `MAX_RULE_INJECTION_BYTES`, `RULE_READ_ROLES`, `RULE_WRITE_ROLES`, `_ruleDeliveryDeps`

**US-006**

- `packages/nax/src/workflow/review-rules-map.ts` — `appendChangedFileRules`, `_reviewRulesMapDeps`

**US-007**

- `packages/nax/src/context/project-context-override/index.ts` — `MAX_PROJECT_CONTEXT_BYTES`, `loadProjectContextOverride`, `rootInstructionDenyPaths`

### Modifies

**US-001**

None. `StaticRulesProvider.fetch` keeps loading both the repo and the package layer through `_staticRulesDeps.loadCanonicalRules`, passed into `resolveRuleSet` as `loadRepoRules`. So the existing stubs in `static-rules.test.ts`, `static-rules-us002`, `-sections`, `-scoping`, `-budget-derivation` and `scope-path-reconciliation` still drive it, and its output is identical when no override is configured.

**US-002**

None. `configureRunRules` returns the plugin registry's own set (same identity) under `delivery: "push"`, and until US-005 adds rule handlers, and `InitializeAfterLockDeps` is unchanged. The root-only pin adds two `context` sub-keys and leaves every pinned key `root-only-keys.test.ts` asserts unchanged.

**US-003**

None. The brief's new section is emitted only when the rule set is non-empty, and existing brief fixtures carry no `.nax/rules/`.

**US-004**

None. `contextStage` keeps its behaviour, and its unit tests call it directly. `workflow-pipeline.test.ts` compares stage names, and the new stage keeps the name `"context"`.

**US-005**
- `packages/nax/test/unit/execution/lifecycle/run-setup-init.test.ts` — two tests break under its `makeNaxConfig()` default (workflow mode, `delivery: "index"`), because US-005 makes the delivered set the plugin entries followed by the `nax-rules` entries. (1) "AC10: calls configureLoopHandlers once with the loaded plugin's entry" asserts `expect(set).toBe(result.pluginRegistry.getLoopHandlers())` and `expect(set).toHaveLength(1)` (`:154-155`). (2) "AC10 (boundary): a plugin providing something else contributes no entry" asserts `expect(set.map((entry) => entry.plugin)).toEqual([LOOP_HANDLER_PLUGIN])` (`:173`). US-005 owns replacing them with these invariants: the delivered set starts with exactly the registry's entries, in order, and every later entry has `plugin === "nax-rules"`; and the delivered entries whose `plugin !== "nax-rules"` are exactly `[LOOP_HANDLER_PLUGIN]`.

**US-006**

None. `writeReviewPackage`'s existing callers and tests only `await` it, so a `string[]` return breaks nothing. The section is appended only when a rule governs a changed file, and the `git.test.ts`, story-review and branch-review fixtures carry no `.nax/rules/`.

**US-007**

None. The new sections, deny paths and warning apply only when `context.projectContext.file` is set, and no existing test sets it.

### Seams

- `resolveRuleSet` and `rulesForFile` (US-001):
  - consumed by `StaticRulesProvider.fetch` (US-001 AC 13);
  - consumed by `writeBrief` (US-003 AC 9);
  - consumed by the rule-delivery handler (US-005 AC 15);
  - consumed by `appendChangedFileRules` (US-006 AC 6).
  - Each AC stubs the producer at the consumer's entry point.
- `configureRunRules` (US-002) is consumed by `initializeAfterLock` (US-002 AC 10).
- `buildRulesIndexSection` (US-003) is consumed by `buildWorkflowBrief` (US-003 AC 7).
- `createRuleDeliveryHandlers` (US-005) is consumed by `configureRunRules`, entered through `initializeAfterLock` (US-005 AC 19).
- `appendChangedFileRules` (US-006) is consumed by `runStoryReview` and `runBranchReview` (US-006 AC 7, 8).
- `loadProjectContextOverride` (US-007) is consumed by `configureRunRules` (US-007 AC 4), `writeBrief` (US-007 AC 6) and `runBranchReview` (US-007 AC 7).

## Acceptance Criteria

### US-001: Rule-set resolver with override layer (`Workdir: packages/nax`)

1. [unit] `resolveRuleSet({ repoRoot, packageDir: repoRoot })` on a repo whose `.nax/rules/` holds `a.md` returns `rules` holding one `ResolvedRule` with `ruleId: "a"`, `source: "repo"` and `displayPath: ".nax/rules/a.md"`.
2. [unit] With repo `.nax/rules/x.md` and `packages/api/.nax/rules/x.md` both present, `resolveRuleSet({ repoRoot, packageDir: <repoRoot>/packages/api, storyWorkdir: "packages/api" })` returns one rule `x` whose `source` is `"package"`.
3. [unit] A repo rule whose `paths:` is `["packages/web/*"]` is absent from `resolveRuleSet(...).rules` for `storyWorkdir: "packages/api"`, while `repoRulesTotal` counts it and `repoRulesMatchedPaths` does not.
4. [unit] With `overrideDir` holding `org.md` and `overrideMode: "merge"`, `resolveRuleSet` output includes rule `org` with `source: "override"` and `displayPath` equal to the absolute path of `org.md`.
5. [unit] With `overrideMode: "merge"` and an override `a.md` alongside repo `a.md`, `resolveRuleSet` returns exactly one rule `a`, carrying the override file's content.
6. [unit] With `overrideMode: "replace"`, `resolveRuleSet` returns only the override directory's rules while the repo rule directory is non-empty.
7. [unit] An override rule whose `paths:` is `["packages/web/*"]` is absent from `resolveRuleSet` output for `storyWorkdir: "packages/api"`.
8. [unit] Two `resolveRuleSet` calls with two different `overrideDir` values each return their own directory's override rules.
9. [unit] `loadCanonicalRulesFromDir(dir)` on a directory containing a file with a banned neutrality marker rejects with `NeutralityLintError`.
10. [unit] An override file with invalid frontmatter is absent from `resolveRuleSet` output, while the override directory's valid rule is present.
11. [unit] `rulesForFile({ repoRoot, path: "packages/api/src/x.ts" })` includes a rule with no `appliesTo` and excludes a rule whose `appliesTo` is `["packages/web/**/*.ts"]`.
12. [unit] Given `packages/api/.nax/rules/p.md`, `rulesForFile` returns `p` for `packages/api/src/x.ts` and not for `packages/web/src/x.ts`.
13. [unit] **(seam)** With `_staticRulesDeps.loadCanonicalRules` stubbed to return one rule whose body is `STUB-BODY`, `StaticRulesProvider.fetch(request)` for a package request returns a chunk containing `STUB-BODY`, and the stub received both `request.repoRoot` and `request.packageDir`.
14. [unit] **(seam)** `createDefaultOrchestrator(story, config)` with `context.rules.overrideDir` set to a directory holding `org.md` assembles a bundle with a `static-rules` chunk containing `org.md`'s body.

### US-002: Override config, CLI flags and run-start validation (`Workdir: packages/nax`)

1. [unit] `NaxConfigSchema.parse({})` yields `context.rules.delivery === "index"`.
2. [unit] `NaxConfigSchema.parse({})` yields `context.rules.overrideMode === "merge"`.
3. [unit] `NaxConfigSchema.parse({})` yields `context.projectContext.mode === "append"`.
4. [unit] `NaxConfigSchema.safeParse` with `context.rules.overrideDir: "relative/dir"` returns `success: false` with an issue at path `context.rules.overrideDir`.
5. [unit] `NaxConfigSchema.safeParse` with `context.rules.overrideDir: "~/org-rules"` parses `overrideDir` to `join(homedir(), "org-rules")`.
6. [unit] `NaxConfigSchema.safeParse` with `context.projectContext.file: "ctx.md"` returns `success: false` with an issue at path `context.projectContext.file`.
7. [unit] `resolveRunProjectContext(workdir, { feature, rulesDir: "org-rules" })` returns `cliOverrides.context.rules.overrideDir` equal to `join(workdir, "org-rules")`.
8. [unit] `resolveRunProjectContext(workdir, { feature, rulesDir: "~/r" })` returns `cliOverrides.context.rules.overrideDir` equal to `"~/r"`.
9. [unit] `resolveRunProjectContext(workdir, { feature, contextFile: "/abs/c.md" })` returns `cliOverrides.context.projectContext.file` equal to `"/abs/c.md"`.
10. [integration] **(seam)** `initializeAfterLock` with `context.rules.delivery: "push"` and no overrides passes `configureLoopHandlers` the plugin registry's own set (same identity) returned through `configureRunRules`.
11. [integration] `initializeAfterLock` with `context.rules.overrideDir` pointing at a non-existent directory rejects with a `NaxError` whose `code` is `RULES_OVERRIDE_DIR_NOT_FOUND`.
12. [integration] In that missing-directory case, `configureLoopHandlers` is called zero times.
13. [cli] `nax run --help` lists `--rules-dir <path>` and `--context-file <path>`.
14. [unit] `pinRootOnlyKeys(merged, root)` with `merged.context.rules.delivery` `"push"` and root's `"index"` returns `context.rules.delivery === "index"`.
15. [unit] `pinRootOnlyKeys(merged, root)` keeps `merged.context.v2.minScore` when it differs from root.
16. [unit] `pinRootOnlyKeysRaw` given a package raw config with `context.rules.delivery: "push"` (root `"index"`) calls `onIgnored` once naming `context.rules`.
17. [unit] `pinRootOnlyKeysRaw` given that raw config with a `context.v2` block returns the raw `context.v2` block unchanged.
18. [integration] `configJsonCommand` for a project whose `.nax/config.json` sets `context.rules.overrideDir` to an absolute path reports that path at `context.rules.overrideDir` in its JSON output.

### US-003: Rules index in the brief (`Workdir: packages/nax`)

1. [unit] `buildRulesIndexSection({ entries, shownAutomatically: true })` returns a string starting with `## Rules index`, with one line per entry in the File Format layout.
2. [unit] An entry with empty `appliesTo` renders its scope as `Applies to: all files`.
3. [unit] An entry with `source: "override"` renders `, override` after its display path; an entry with `source: "repo"` renders none.
4. [unit] `toRulesIndexEntry(rule)` sets `description` to the frontmatter `description:` when present, otherwise to the first Markdown heading's text, otherwise to the rule id.
5. [unit] Index lines are ordered by `priority` ascending, then by rule id ascending.
6. [unit] `buildRulesIndexSection` with `shownAutomatically: false` returns the sentence "Before you write or edit a file a rule applies to, read that rule's file." in place of the sentence beginning "Each rule's full text is shown to you".
7. [unit] **(seam)** `buildWorkflowBrief` with a `rulesIndex` of one entry places a "## Rules index" section before "## Feature context"; with zero entries it emits no "## Rules index" heading.
8. [integration] `writeBrief(sc)` with `delivery: "push"` writes no "## Rules index" section.
9. [integration] **(seam)** With `_workflowDeps.resolveRuleSet` stubbed to return two rules and `delivery: "index"`, `writeBrief(sc)` writes a `brief.md` whose "## Rules index" lists both rule ids, and the stub received `packageDir: sc.workdir` and `storyWorkdir: storyWorkdir(sc.story)`.
10. [integration] `writeBrief(sc)` with `sc.callCtx.agentName === "claude"` writes the "read that rule's file" variant; with `"native"`, the "shown to you the first time" variant.

### US-004: Workflow context stage without the v2 orchestrator (`Workdir: packages/nax`)

1. [unit] `getWorkflowPipeline()` stage names equal `["queue-check", "routing", "constitution", "context", "workflow", "completion"]`, and the `"context"` stage is `workflowContextStage`.
2. [integration] **(seam)** `workflowContextStage.execute(ctx)` with `delivery: "index"` calls `_contextStageDeps.createOrchestrator` zero times and leaves `ctx.contextBundle` undefined.
3. [integration] With `delivery: "index"` and `_workflowContextStageDeps.featureContextProvider` stubbed to return chunks `A` and `B`, `ctx.featureContextMarkdown` equals `A`'s content, a blank line, then `B`'s content.
4. [integration] In the same setup, the stub's `fetch` received a request with `stage: "context"` and `repoRoot: ctx.projectDir`.
5. [integration] With `delivery: "index"` and no prior `sessionScratchDir`, `workflowContextStage.execute(ctx)` sets `ctx.sessionId`, `ctx.sessionScratchDir` and `ctx.contextToolRunCounter`.
6. [integration] With `delivery: "push"`, `workflowContextStage.execute(ctx)` calls `_contextStageDeps.createOrchestrator` once.
7. [integration] With `context.v2.enabled: false`, `workflowContextStage.execute(ctx)` calls `_contextStageDeps.v1FeatureProvider` once.
8. [integration] When the stubbed provider's `fetch` throws, `workflowContextStage.execute(ctx)` returns `{ action: "continue" }` with `ctx.featureContextMarkdown` undefined.
9. [integration] In that throwing case, exactly one `warn` is logged, and its data's first key is `storyId`.
10. [unit] `allocateStorySession(ctx)` on a context that already has `sessionScratchDir` leaves `ctx.sessionScratchDir` and `ctx.sessionId` unchanged.

### US-005: Native rule-delivery loop handlers (`Workdir: packages/nax`)

1. [unit] For role `wf-implementer`, the `before_tool` handler returns `{ kind: "nudge", text }` for a `Read` of `packages/nax/src/a.ts` governed by rule `r`, with `text` containing `r`'s body under a `### r (` heading.
2. [unit] A second `Read` of a path governed only by `r` in the same `sessionName` returns `{ kind: "allow" }`.
3. [unit] A `Read` of a governed path in a different `sessionName` returns a `nudge` carrying `r`'s body.
4. [unit] For role `wf-implementer`, a `Write` to a path governed by undelivered `r` returns `{ kind: "block", isError: true }` whose `content` holds `r`'s body and ends with "No files were changed. Review these rules and retry the tool call."
5. [unit] Retrying that `Write` in the same session returns `{ kind: "allow" }`.
6. [unit] For role `wf-branch-fix`, an `Edit` to a path governed by an undelivered rule returns `{ kind: "block" }`.
7. [unit] For role `wf-story-review`, a `Write` to a governed path returns `{ kind: "allow" }`.
8. [unit] For a context whose `role` is `advisor` or absent, a `Read` of a governed path returns `{ kind: "allow" }`.
9. [unit] A `Read` of `.nax/features/f/brief.md` returns `{ kind: "allow" }` while a rule with no `appliesTo` exists.
10. [unit] **(seam)** With `_ruleDeliveryDeps.resolveRuleSet` stubbed to return rule `r` at `displayPath` `/abs/org/r.md` (outside `repoRoot`), a `Read` of `/abs/org/r.md` returns `{ kind: "allow" }` and a following `Write` to a path governed only by `r` returns `{ kind: "allow" }`.
11. [unit] A `Read` of `./packages/nax/src/a.ts` nudges with the rules governing `packages/nax/src/a.ts`.
12. [unit] A `Read` of an absolute path outside `repoRoot` that is no rule's `displayPath` returns `{ kind: "allow" }`.
13. [unit] After the `before_compaction` handler runs for a session, a `Read` there of a path governed by previously delivered `r` returns a `nudge` carrying `r`'s body.
14. [unit] When undelivered governing bodies exceed `MAX_RULE_INJECTION_BYTES` (16,384), the nudge holds bodies in priority order up to the cap and lists the rest as `Also applies (not shown, open the file)` lines.
15. [unit] **(seam)** With `_ruleDeliveryDeps.rulesForFile` stubbed to return rule `r`, a `Read` of `packages/nax/src/a.ts` calls the stub once with `path: "packages/nax/src/a.ts"` and the configured `repoRoot`.
16. [unit] Two `Read` calls of different files in one directory call `_ruleDeliveryDeps.rulesForFile`'s underlying package lookup once in total (the directory and package caches).
17. [unit] When `_ruleDeliveryDeps.rulesForFile` rejects, the handler resolves to `{ kind: "allow" }`, logs one `warn` on `"rules"`, and a following `Read` of the same path (with the stub now resolving rule `r`) nudges with `r`'s body.
18. [unit] Each `nudge` or `block` logs one `info` event `rules.delivered` whose data's first key is `storyId`.
19. [integration] **(seam)** With `_runRulesSetupDeps.createRuleDeliveryHandlers` stubbed to return one entry, `initializeAfterLock` in workflow mode with `delivery: "index"` calls `configureLoopHandlers` with a set whose last element is that entry and whose leading elements are exactly the plugin registry's entries.
20. [integration] `initializeAfterLock` with `delivery: "push"` calls `configureLoopHandlers` with no entry whose `plugin` is `"nax-rules"`.

### US-006: Changed-file rules sections in review packages (`Workdir: packages/nax`)

1. [unit] `buildChangedFileRulesSection(groups)` returns a string starting with `## Rules for the changed files`, with one line per group in the File Format layout.
2. [unit] A group with five paths renders `5 changed files, e.g. ` followed by exactly the first three paths in input order.
3. [unit] The rendered lines hold rule ids, display paths, counts and example paths, and none of a rule's body text.
4. [unit] `appendChangedFileRules(packagePath, changedPaths, input)` leaves the package file's prior content byte-identical as a prefix of the new content.
5. [unit] `appendChangedFileRules` with changed paths that no rule governs leaves the package file byte-identical.
6. [unit] **(seam)** With `_reviewRulesMapDeps.rulesForFile` stubbed, `appendChangedFileRules` calls it once per changed path not under a `.nax/` directory, with that path and `input.repoRoot`.
7. [integration] **(seam)** With `_workflowDeps.appendChangedFileRules` stubbed and `delivery: "index"`, `runStoryReview(sc)` calls it once with `<storyDir>/package-0.diff` and the paths `writeReviewPackage` returned.
8. [integration] **(seam)** With `_workflowDeps.appendChangedFileRules` stubbed and `delivery: "index"`, `runBranchReview(fc, input)` calls it once with the `paths` `writeBranchReviewPackage` returned.
9. [integration] With `delivery: "push"`, neither `runStoryReview` nor `runBranchReview` calls `_workflowDeps.appendChangedFileRules`.
10. [integration] `writeReviewPackage(dir, base, path)` on a range that adds `a.ts` and deletes `b.ts` resolves to `["a.ts"]`.

### US-007: Project-context override delivery (`Workdir: packages/nax`)

1. [unit] `loadProjectContextOverride(config)` returns the file's content for an existing file of 32,768 bytes.
2. [unit] `loadProjectContextOverride(config)` returns `undefined` when no file is configured.
3. [unit] `loadProjectContextOverride(config)` rejects with code `PROJECT_CONTEXT_FILE_NOT_FOUND` for a missing file, and with `PROJECT_CONTEXT_FILE_TOO_LARGE` for a 32,769-byte file.
4. [integration] **(seam)** With `_runRulesSetupDeps.loadProjectContextOverride` stubbed to reject with code `PROJECT_CONTEXT_FILE_NOT_FOUND`, `initializeAfterLock` with `context.projectContext.file` set rejects with that code and calls `configureLoopHandlers` zero times.
5. [unit] `buildWorkflowBrief` with `projectContextOverride: "X-OVERRIDE"` places a `## Project context (run override)` section with body `X-OVERRIDE` after "## Feature context".
6. [integration] **(seam)** With `_workflowDeps.loadProjectContextOverride` stubbed to return `"X-OVERRIDE"`, `writeBrief(sc)` writes a `brief.md` with `X-OVERRIDE` under `## Project context (run override)`.
7. [integration] **(seam)** With `_workflowDeps.loadProjectContextOverride` stubbed to return `"X-OVERRIDE"`, `runBranchReview(fc, input)` leaves a package file with `## Project context (run override)` followed by `X-OVERRIDE`.
8. [unit] `rootInstructionDenyPaths("AGENTS.md")` returns `["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]`, and `rootInstructionDenyPaths("GUIDE.md")` returns `["GUIDE.md"]`.
9. [unit] `instructionOptionsForSession("native", options)` with `projectContext.mode: "replace"`, a configured file and `execution.denyPaths: ["secret/**"]` returns `instructionDenyPaths` `["secret/**", "AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]`.
10. [unit] `instructionOptionsForSession("native", options)` with `mode: "append"` and `execution.denyPaths: ["secret/**"]` returns `instructionDenyPaths` `["secret/**"]`.
11. [unit] `instructionOptionsForSession("claude", options)` with `mode: "replace"` returns `{}`.
12. [integration] `initializeAfterLock` with `mode: "replace"`, a configured file and default agent `claude` logs exactly one `warn` saying replace applies to native sessions only, and resolves.
13. [integration] `initializeAfterLock` with `mode: "replace"`, a configured file and default agent `native` logs no such `warn`.
