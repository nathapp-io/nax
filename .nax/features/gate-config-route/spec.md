# SPEC: gate-config-route — a run fixes its own command config when a gate fails on it

Closes: #2897, #2898, #2899

## Summary

When a story's gate fails because nax's own command config is wrong, the run today cannot fix it: no session may write nax config, the advisor does not know that and rules "edit the config" anyway, and the fix loop spends its remaining rounds re-running the same gate with the same command. This feature gives the advisor the facts (which paths no session can write, the story's current commands, the package's declared scripts), lets it pick a config change from options nax builds itself, has nax apply an allowed change (write, commit, reload) so the next gate uses it, and stops the fix loop early when the implementer is `BLOCKED` and the same gates stay red with no change applied.

## Motivation

In the store-erp `warehouse-work-orders` run (nax 0.92.0), story US-007's scoped gate timed out at 10 minutes every round. `.nax/mono/apps/admin/config.json` had `quality.commands.testScoped: "bun test {{files}}"`; the package's own `test` script is `bun test --isolate`. The implementer proved the fix (272 pass / 0 fail in 4.9 s with `--isolate`) and replied `BLOCKED`, because nax config writes are denied to every session by design. Then:

1. **#2897.** The advisor answered (decision D-1, confidence high): "set quality.commands.testScoped in .nax/mono/apps/admin/config.json to `bun test --isolate {{files}}`". The implementer cannot write that file; one fix turn was spent on the denied write and a second ruling had to reverse D-1. The advisor's question carries only the implementer's concern text; nothing tells it which paths are protected.
2. **#2898.** Nothing in a run can change nax config. `RequestCapability` records the need and grants nothing. Per-package config is resolved once per run, so even the hand edit (store-erp `d55cafb9`) only reached the next run.
3. **#2899.** After `BLOCKED`, the loop went on to the next fix round. Each round re-ran the same scoped gate with the same config and timed out again; nothing a fix round can change affects that outcome.

The owner's goal for nax is minimal human interaction: a run's problems go to an agent, not to a new human step. The owner ruled (2026-11-13) that no model decides whether a command is safe: `quality.commands` run through a shell outside the permission gate, so the allowed changes are fixed by a rule nax evaluates, and the advisor only chooses among them. The design doc is `docs/superpowers/specs/2026-11-13-gate-config-route-design.md`.

## Design

### Approach

The change is proposed and applied inside the round in which the implementer replies `BLOCKED` or `NEEDS_CONTEXT`. That is the only place where an applied change is followed by another gate run without changing the loop's state machine: `absorbTurn` (`packages/nax/src/workflow/story-steps.ts`) already continues the round after the advisor answers, and the next `evaluateStep` re-runs the gates. The residual path is not used: `residualStep` filters out gate items (`f.kind !== "gate"`) and is followed by `closeStep`, so a change ruled there would never be re-checked.

**Advisor menu, not free text.** The advisor's menus already carry parameters the advisor never chooses (`AdviceOptionFixed`). nax builds one `config-change` option per allowed change and the advisor picks one by id and states a `reason`. The advisor cannot name a file, a key or a command that is not on the menu.

**The rule.** For a story whose package dir `<pkg>` (its `workdir` relative to the repo root) is not the repo root, with story base commit `<base>` (`sc.base`):

- The gate-to-key map is `GATE_COMMAND_KEY`: `lint` → `lint`, `typecheck` → `typecheck`, `scoped` → `testScoped`, `full-suite` → `test`.
- The red gates are the gates whose state is `"red"` in the story loop's last gate run (`gates.states` only; the full-suite result `suite.states` is not read). With no red gate there are no candidates.
- The candidate values come from the `scripts` object of `<pkg>/package.json` **as committed at `<base>`** (read with `git show <base>:<pkg>/package.json`), in the object's key order. For every script value `v`: the candidate `v`, and for the key `testScoped` only, also `v + " {{files}}"`. A candidate equal to the key's current command is dropped. A quality command is a string or a non-empty string array (`QualityCommandSpecSchema`); an array command is never equal to a candidate, and wherever a command is shown or stored as `from` it is rendered by `renderCommandSpec`: a string as is, an array as its elements joined with ` && `. Duplicates (same key and value) are kept once, the first script in key order wins.
- The base commit is used so a session cannot add a script during this story and then have it offered.
- A story whose package is the repo root gets no candidates: root config is cached for the whole run outside the package registry (`_rootConfigCache` in `config/loader.ts`, and `PackageRegistry.resolve("")` returns `loader.current()`), so a change there could not reach the run's later gates.

**The config file** is `.nax/mono/<pkg>/config.json`. The advisor never chooses it.

**Who applies, with which signals.** A `config-change` decision whose `needsHumanConfirm` is true is not applied (refusal `needs-confirm`). That flag is set by the advisor or forced by `forcedConfirm` (`advisor/menus.ts`) when the reply's `confidence` is `"low"` or `reversible` is false; `forcedConfirm` is not changed, so a low-confidence or non-reversible pick is refused too. Any other `config-change` decision is applied.

**Applying** (`applyConfigChange`, run by nax, never by a session), in order:

1. Refuse `needs-confirm` when the decision needs confirmation; refuse `root-package` when `<pkg>` is the repo root.
2. Recompute the candidates (same rule, same inputs) and refuse `not-offered` unless the change's key and value match one exactly.
3. Refuse `untracked` unless the config file is tracked in git (`git ls-files --error-unmatch -- <file>` exits 0).
4. Read the file, set `quality.commands.<key>` to the value without changing other keys (an absent `quality` or `commands` object is created), and write it back as 2-space-indented JSON with a trailing newline. A write that throws is refused `write-failed`.
5. Clear the per-package config cache (`packageConfigCache.clear()`), resolve the story's config again with `loadConfigForPackage(projectDir, pkg, currentConfig)` (which keeps the run's `--profile` chain and root-only keys), and refresh the registry entry with `registry.refresh(pkg)`. If either throws, restore the file's original bytes, clear the cache and refresh again, and refuse `invalid-config`.
6. Commit only that path: `git commit --no-verify -m "chore(nax): set quality.commands.<key> for <pkg> (advisor <decisionId>)" -- <file>`, mirroring `commitLedger`. If the commit fails, restore the original bytes, clear the cache and refresh again, and refuse `commit-failed`.
7. Return the new resolved config and the refreshed package view.

**Making the story use it.** Gate ops read their command through `callCtx.packageView.select(...)` (`operations/verify-scoped.ts`, `operations/lint-check.ts`), so the refreshed package view is what changes the gate command. `buildStoryEnv` passes `packageDirRelative(projectDir, workdir) ?? ""` as `packageDir` and `callCtx.runtime.packages` as `registry`. It holds the story's step context in a mutable holder (`let current: StepContext`), and every step closure reads `current`. After an applied change it replaces `current` with `{ ...current, config: newConfig, callCtx: { ...current.callCtx, config: newConfig, packageView: newView } }`. Later stories in the run resolve their config through the cleared cache and the refreshed registry. Only the gate path must observe the new command within the story (an AC pins it); whether other step closures (story review, the model lookup) read `current` is left to the builder.

**After an applied change, in the loop.** The turn ends without another implementer turn (the answer was the config change). `lastTurn` records the `BLOCKED` (or `NEEDS_CONTEXT`) reply with `configApplied: true`; the report check reads it as for any such turn. The round stays spent: a config-only round counts against `maxFixRounds`. The config commit moves HEAD, so `fixDiffEmpty` reads the round as not empty and a re-review runs when review findings are open.

**Early stop (#2899).** `evaluateStep` reads the previous pass's red gates from `state.gates` (before the new gate run overwrites it). When `lastTurn.status` is `BLOCKED`, `lastTurn.configApplied` is not true, the previous pass had red gates, and the new pass's red gates are the same set, it sets `advisorRoute`, so `passExit` returns `"capped"` and the story goes to `residualStep` now. The carrier is the existing `lastTurn` key; no new graph state key is added.

### Integration (extends existing code)

Read-only symbols (verified 2026-11-13 on `main` `ddc252f28`):

- `packages/nax/src/workflow/story-steps.ts` — `absorbTurn(env, s, outcome, origin)` asks `env.advisor.answerQuestion` when a reply is `NEEDS_CONTEXT` or `BLOCKED` and `s.questions < MAX_IMPLEMENTER_QUESTIONS`; `passExit(open, s, maxFixRounds)` returns `"capped"` when `s.advisorRoute`; `residualStep` filters gate items out; `recordLastTurn`.
- `packages/nax/src/workflow/types.ts` — `GateState = "green" | "red" | "skipped"`, `GateRunResult { red; states; findings }`.
- `packages/nax/src/operations/workflow-types.ts` — `GateName = "lint" | "typecheck" | "scoped" | "full-suite"`.
- `packages/nax/src/agents/nax-protected-paths.ts` — `naxProtectedPaths(): ProtectedPathsPolicy` with `projectStateDir`, `credentialDir`, `trustStoreFile`.
- `packages/nax/src/config/package-config-cache.ts` — `packageConfigCache.clear()`.
- `packages/nax/src/config/package-config.ts` — `loadConfigForPackage(projectDir, packageDir, from): Promise<NaxConfig>`.
- `packages/nax/src/workflow/git.ts` — `commitLedger` (the single-path `add` / `diff --cached` / `commit --no-verify -- <path>` pattern to mirror).
- `packages/nax/src/operations/verify-scoped.ts` — reads `ctx.packageView.select(qualityConfigSelector)`.
- `packages/nax/src/workflow/story-graph.ts` — `STORY_GRAPH` node `produces` lists (unchanged by this feature).

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- New types in `packages/nax/src/advisor/types.ts`: `QualityCommandKey = "lint" | "typecheck" | "testScoped" | "test"`; `ConfigChangeCandidate { key: QualityCommandKey; to: string; script: string }` (`script` is the `package.json` script name the value came from).
- `AdviceAction` (`packages/nax/src/advisor/types.ts`). Baseline: no config action. Target: gains `{ type: "config-change"; key: QualityCommandKey; to: string; script: string; reason: string }`.
- `AdviceOptionFixed`. Target: gains `configChange?: ConfigChangeCandidate`.
- `AdviceEvidence.source`. Target: the union gains `"config"`.
- `MenuFacts` implementer-question variant. Baseline: `{ kind: "implementer-question" }`. Target: `{ kind: "implementer-question"; configChanges?: readonly ConfigChangeCandidate[] }`.
- `packages/nax/src/advisor/menus.ts`: `LABELS` gains `"config-change": "Change a nax command to a script the package declares"`; `REQUIRED_TEXT_FIELD["config-change"]` is `"reason"`; `buildMenu` builds the implementer-question menu as `answer`, `hold`, then one `config-change` option per candidate, in candidate order, with `fixed.configChange` set and label `Change quality.commands.<key> to "<to>" (package.json script "<script>")`; `toAction` maps a `config-change` option to `{ type: "config-change", ...option.fixed.configChange, reason: reply.reason }`.
- `packages/nax/src/operations/advise.ts`: the `REQUIRED` mirror gains `"config-change": "reason"`.
- `packages/nax/src/advisor/decision-log.ts`: `actionText` gains a `config-change` case returning `config-change quality.commands.<key> -> "<to>"`.
- `WorkflowAdvisor.answerQuestion` (`packages/nax/src/workflow/advisor.ts`). Baseline: `answerQuestion(q: { storyId; status; concerns }): Promise<string | null>`. Target: `answerQuestion(q: { storyId; status; concerns; facts?: ImplementerQuestionFacts }): Promise<string | ConfigChangeAnswer | null>`. A string is still an answer. `ImplementerQuestionFacts { protectedPaths: readonly string[]; commands: Readonly<Partial<Record<QualityCommandKey, string | readonly string[]>>>; candidates: readonly ConfigChangeCandidate[] }`. Render string command facts unchanged and array command facts as their elements joined with ` && `. `ConfigChangeAnswer { kind: "config-change"; key: QualityCommandKey; to: string; script: string; reason: string; decisionId: string; needsHumanConfirm: boolean }`.
- `createLiveWorkflowAdvisor(...).answerQuestion` (`packages/nax/src/workflow/advisor-live.ts`). Target: when `q.facts` is given, the question's evidence gains, after the concern entry, one `source: "config"` entry with one line per protected path (`Protected (no session can write): <path>`) and one `source: "config"` entry with one line per key in `lint`, `typecheck`, `testScoped`, `test` order (`quality.commands.<key>: <command>`, or `quality.commands.<key>: (unset: nax detects a default)`); the menu is built with `configChanges: q.facts.candidates`. When `q.facts` is absent no `facts`-derived evidence or option is added. A `config-change` decision returns a `ConfigChangeAnswer` from the action's fields plus the decision's `id` and `needsHumanConfirm`.
- New module `packages/nax/src/workflow/config-change.ts`:
  - `GATE_COMMAND_KEY: Readonly<Record<GateName, QualityCommandKey>>`.
  - `configChangeCandidates(input: { redGates: readonly GateName[]; commands: Readonly<Partial<Record<QualityCommandKey, string | readonly string[]>>>; scripts: Readonly<Record<string, string>> }): ConfigChangeCandidate[]`.
  - `readBaseScripts(projectDir: string, base: string, packageDir: string): Promise<Record<string, string>>`.
  - `renderCommandSpec(spec: string | readonly string[] | undefined): string | undefined` — a string as is, an array joined with ` && `, `undefined` as `undefined`.
  - `protectedPathList(policy: ProtectedPathsPolicy): string[]` — `[policy.projectStateDir + "/", policy.credentialDir + "/", policy.trustStoreFile]`.
  - `applyConfigChange(input: ApplyConfigChangeInput): Promise<ApplyConfigChangeResult>` with `ApplyConfigChangeInput { projectDir: string; packageDir: string /* "" for the repo root */; base: string; change: ConfigChangeAnswer; currentConfig: NaxConfig; registry: PackageRegistry }` and `ApplyConfigChangeResult = { outcome: ConfigChangeOutcome; config?: NaxConfig; packageView?: PackageView }` (`config` and `packageView` present only when applied).
  - `ConfigChangeOutcome = { applied: true; key: QualityCommandKey; from: string | undefined; to: string; commit: string } | { applied: false; key: QualityCommandKey; to: string; reason: ConfigChangeRefusal }`; `ConfigChangeRefusal = "needs-confirm" | "root-package" | "not-offered" | "untracked" | "invalid-config" | "write-failed" | "commit-failed"`.
  - `_configChangeDeps = { git, loadConfigForPackage, readFile, writeFile }` for tests.
- `PackageRegistry` (`packages/nax/src/runtime/packages.ts`). Baseline: `hydrate` skips a package already in `mergedConfigs`. Target: gains `refresh(packageDir: string, loadOverride?: PackageOverrideLoader): Promise<PackageView>`, which re-runs the package's hydration unconditionally (re-reading its override), drops its cached views, and returns `resolve(packageDir)`.
- `StoryLoopSteps` (`packages/nax/src/workflow/story-loop.ts`). Target: gains optional `configFacts?(redGates: readonly GateName[]): Promise<ImplementerQuestionFacts>` and `applyConfigChange?(change: ConfigChangeAnswer): Promise<ConfigChangeOutcome>`.
- `StoryLoopSink` (`packages/nax/src/workflow/story-loop.ts`). Target: gains optional `recordConfigChange?(entry: ConfigChangeRecord): Promise<void>`; `buildStoryEnv`'s sink appends the entry to the story record's `configChanges` (keeping earlier entries, including ones from a resumed prior record) and persists the record. The shallow `update` patch is not used for this field, so a second change never replaces the first.
- `StoryLoopState.lastTurn` (`packages/nax/src/workflow/story-loop.ts`). Baseline: `{ status; fallback; stepUps }`. Target: gains optional `configApplied?: boolean`.
- `WorkflowStoryRecord` (`packages/nax/src/workflow/types.ts`). Target: gains optional `configChanges?: readonly ConfigChangeRecord[]` with `ConfigChangeRecord { round: number; key: QualityCommandKey; from?: string; to: string; applied: boolean; reason?: ConfigChangeRefusal; decisionId: string }`.
- `nax workflow status` (`packages/nax/src/cli/workflow.ts`). Target: `WorkflowStatusReport` gains optional `configChanges?: readonly ({ storyId: string } & ConfigChangeRecord)[]`, present only when a story recorded one; `printPlain` prints one line per change after the open-item lines.

### Failure Handling

| Failure | Behaviour |
|:---|:---|
| Base manifest missing, unreadable or not JSON, or no `scripts` object | `readBaseScripts` returns `{}`; no candidates; the question is asked with `answer` and `hold` only. |
| Decision needs human confirmation | Refused `needs-confirm`; file untouched. |
| Story package is the repo root | Refused `root-package`; file untouched. |
| Change not among the recomputed candidates | Refused `not-offered`; file untouched. |
| Config file not tracked in git | Refused `untracked`; file untouched. |
| File write throws | Refused `write-failed`; original bytes restored if the file changed. |
| Resolving the new config or refreshing the registry throws | Original bytes restored, cache cleared, registry refreshed again; refused `invalid-config`. |
| Commit fails | Original bytes restored, cache cleared, registry refreshed again; refused `commit-failed`. |
| `configFacts` step throws | Logged `warn`; the question is asked without facts. |
| `applyConfigChange` step throws | Treated as refused `write-failed`; the loop continues as for a refusal. |

## Out of Scope

- A model (approver agent) judging whether a config change is safe: the allowed changes are fixed by the rule and the advisor only picks one.
- Config keys other than `quality.commands.lint`, `quality.commands.typecheck`, `quality.commands.testScoped` and `quality.commands.test`.
- Candidate forms other than a base-commit script value and, for `testScoped`, that value plus ` {{files}}`: no `<runner> run <script>` forms and no edited flags.
- Config changes for a story whose package is the repo root (including every story of a single-package repo): the root config is cached for the whole run, so such a change could only reach the next run.
- Offering or applying a config change at residual time, or adding gate items to the residual menu.
- Offering config changes before the story's first gate run (the first implement turn has no red gates, so no candidates).
- Validating or rewriting advisor answer text that tells the implementer to edit a protected path (#2897's alternative fix): the advisor gets the facts, not a new restriction.
- Changing `RequestCapability` or the session write block on nax config.
- The early stop for the first fix round after a resume: a resumed story has no previous pass in memory, so its first pass is compared against nothing.
- A run-summary line for config changes: they appear in the ledger and in `nax workflow status` only.
- Pipeline mode (frozen).

## Stories

### US-001 — the advisor gets config facts and can pick a config change

Workdir: packages/nax. No dependencies.

Adds the `config-change` action, option, label, required-text entries (menus and the `advise.ts` mirror) and evidence source, the `QualityCommandKey` / `ConfigChangeCandidate` types, the implementer-question menu's candidate options, and the live advisor's `facts` handling and `ConfigChangeAnswer` result.

### US-002 — the candidate rule

Workdir: packages/nax. Depends on US-001.

Creates `packages/nax/src/workflow/config-change.ts` with `GATE_COMMAND_KEY`, `configChangeCandidates`, `readBaseScripts` and `protectedPathList`: the pure rule that lists the allowed changes for a story's red gates from its base-commit scripts.

### US-003 — applying a change

Workdir: packages/nax. Depends on US-002.

Adds `applyConfigChange` and `PackageRegistry.refresh`: the rule check, refusals, the file write, the reload through `loadConfigForPackage` and the registry, the single-path commit, and the restore on failure.

### US-004 — the story env steps

Workdir: packages/nax. Depends on US-003.

Adds the `configFacts` and `applyConfigChange` steps and the `recordConfigChange` sink method in `buildStoryEnv`, which holds the step context in a mutable holder so an applied change reaches the story's later gates.

### US-005 — the story loop applies a picked change

Workdir: packages/nax. Depends on US-004.

`absorbTurn` (reached through `implementStep` and `fixStep`) passes facts to the advisor when gates are red, applies a picked config change through `env.steps.applyConfigChange` and ends the turn without another implementer turn, and records each change through `env.sink.recordConfigChange`, the ledger and `lastTurn.configApplied`.

### US-006 — early stop on an unliftable block, and status output

Workdir: packages/nax. Depends on US-005.

`evaluateStep` sets `advisorRoute` when a `BLOCKED` turn with no change applied left the same gates red, and `nax workflow status` shows the recorded config changes.

### Context Files

**US-001**
- `packages/nax/src/advisor/types.ts` — `AdviceAction`, `AdviceOptionFixed`, `AdviceEvidence`, `MenuFacts`.
- `packages/nax/src/advisor/menus.ts` — `LABELS`, `buildMenu`, `toAction`, `REQUIRED_TEXT_FIELD`, `withIds`.
- `packages/nax/src/operations/advise.ts` — `REQUIRED`, `validateAdvisorReply`.
- `packages/nax/src/workflow/advisor.ts` — `WorkflowAdvisor`.
- `packages/nax/src/workflow/advisor-live.ts` — `createLiveWorkflowAdvisor`.

**US-002**
- `packages/nax/src/agents/nax-protected-paths.ts` — `naxProtectedPaths`, `ProtectedPathsPolicy`.
- `packages/nax/src/workflow/git.ts` — `_workflowDeps.git`.
- `packages/nax/src/operations/workflow-types.ts` — `GateName`.

**US-003**
- `packages/nax/src/workflow/config-change.ts` — created by US-002, extended here.
- `packages/nax/src/runtime/packages.ts` — `createPackageRegistry`, `hydratePackage`, `hydrate`.
- `packages/nax/src/config/package-config.ts` — `loadConfigForPackage`.
- `packages/nax/src/workflow/git.ts` — `commitLedger`.

**US-004**
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`, the sink.
- `packages/nax/src/workflow/call-context.ts` — `buildWorkflowCallContext`.
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps`, `StoryLoopSink`.
- `packages/nax/src/workflow/config-change.ts` — created by US-002, consumed here.

**US-005**
- `packages/nax/src/workflow/story-steps.ts` — `absorbTurn`, `LoopState`, `recordLastTurn`, `recordConcern`.
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps`, `StoryLoopState`.
- `packages/nax/src/workflow/types.ts` — `WorkflowStoryRecord`, `GateRunResult`.
- `packages/nax/src/workflow/config-change.ts` — created by US-002, consumed here.

**US-006**
- `packages/nax/src/workflow/story-steps.ts` — `evaluateStep`, `passExit`, `LoopState`.
- `packages/nax/src/cli/workflow.ts` — `buildReport`, `printPlain`, `WorkflowStatusReport`.
- `packages/nax/src/workflow/types.ts` — `WorkflowStoryRecord`.

### Creates

**US-002**
- `packages/nax/src/workflow/config-change.ts`
- `packages/nax/test/unit/workflow/config-change.test.ts`

**US-003**
- `packages/nax/test/integration/workflow/config-change-apply.test.ts`

**US-004**
- `packages/nax/test/integration/workflow/stage-env-config-change.test.ts`

**US-005**
- `packages/nax/test/unit/workflow/story-loop-config-change.test.ts`

**US-006**
- `packages/nax/test/unit/workflow/story-loop-blocked-stop.test.ts`

### Modifies

None. `answerQuestion` keeps accepting a string answer; the implementer-question menu is unchanged when no candidates are given; the new evidence entries come after the concern entry and only when `facts` is given; `lastTurn.configApplied` is an optional field on an existing graph key, so `STORY_GRAPH`'s `produces` lists (pinned by `test/unit/workflow/story-graph.test.ts`) do not change; every new record and report field is optional and absent when empty.

### Seams

- US-001 → US-005: `answerQuestion`'s `facts` input and `ConfigChangeAnswer` result are consumed by `absorbTurn`.
- US-003 → US-004: `applyConfigChange` and `PackageRegistry.refresh` are called by `buildStoryEnv`'s `applyConfigChange` step.
- US-004 → US-005: `StoryLoopSteps.configFacts`, `StoryLoopSteps.applyConfigChange` and `StoryLoopSink.recordConfigChange`, provided by `buildStoryEnv`, are called by `absorbTurn`.
- US-005 → US-006: `lastTurn.configApplied` and `WorkflowStoryRecord.configChanges` are read by `evaluateStep` and `nax workflow status`.

## Acceptance Criteria

### US-001

1. [unit] `buildMenu({ kind: "implementer-question", configChanges: [{ key: "testScoped", to: "bun test --isolate {{files}}", script: "test" }] })` returns three options whose types are `answer`, `hold`, `config-change`, in that order.
2. [unit] The `config-change` option from criterion 1 has `fixed.configChange` equal to `{ key: "testScoped", to: "bun test --isolate {{files}}", script: "test" }`.
3. [unit] The `config-change` option from criterion 1 has label `Change quality.commands.testScoped to "bun test --isolate {{files}}" (package.json script "test")`.
4. [unit] `buildMenu({ kind: "implementer-question", configChanges: [] })` returns only the `answer` and `hold` options.
5. [unit] With two candidates, `buildMenu` returns the two `config-change` options after `hold`, in candidate order.
6. [unit] `REQUIRED_TEXT_FIELD["config-change"]` is `"reason"`.
7. [unit] `validateAdvisorReply` rejects a reply that picks a `config-change` option with no `reason`.
8. [unit] `toAction` on the `config-change` option from criterion 1 with a reply whose `reason` is `"package script has --isolate"` returns `{ type: "config-change", key: "testScoped", to: "bun test --isolate {{files}}", script: "test", reason: "package script has --isolate" }`.
9. [unit] `createLiveWorkflowAdvisor(...).answerQuestion` called with `facts` whose `candidates` hold one candidate asks a question whose options include one `config-change` option carrying that candidate.
10. [unit] Called with `facts` whose `protectedPaths` is `[".nax/", "/home/u/.nax/"]`, the asked question's evidence has the concern entry first, followed by a `source: "config"` entry whose text has the line `Protected (no session can write): .nax/`.
11. [unit] Called with `facts` whose `commands` is `{ testScoped: "bun test {{files}}" }`, the asked question has a `source: "config"` evidence entry with the line `quality.commands.testScoped: bun test {{files}}`.
12. [unit] In the entry from criterion 11, the `lint` line reads `quality.commands.lint: (unset: nax detects a default)`.
13. [unit] When the advisor's decision is a `config-change` action with `reason` `"matches the package test script"`, `id` `"D-3"` and `needsHumanConfirm: false`, `answerQuestion` returns `{ kind: "config-change", key: "testScoped", to: "bun test --isolate {{files}}", script: "test", reason: "matches the package test script", decisionId: "D-3", needsHumanConfirm: false }`.
14. [unit] Called without `facts`, `answerQuestion` asks a question whose options are exactly `answer` and `hold`.
15. [unit] Called without `facts`, the asked question has no `source: "config"` evidence entry.
16. [unit] An `answer` decision still makes `answerQuestion` return the answer text as a plain string.
17. [unit] Called with `facts` whose `commands` is `{ lint: ["biome check .", "tsc --noEmit"] }`, the config evidence has the line `quality.commands.lint: biome check . && tsc --noEmit`.
18. [unit] The run-log text for a `config-change` decision (`actionText`) is `config-change quality.commands.testScoped -> "bun test --isolate {{files}}"`.

### US-002

1. [unit] `GATE_COMMAND_KEY` maps `lint` to `lint`, `typecheck` to `typecheck`, `scoped` to `testScoped` and `full-suite` to `test`.
2. [unit] `configChangeCandidates({ redGates: ["scoped"], commands: { testScoped: "bun test {{files}}" }, scripts: { test: "bun test --isolate" } })` returns `[{ key: "testScoped", to: "bun test --isolate", script: "test" }, { key: "testScoped", to: "bun test --isolate {{files}}", script: "test" }]`.
3. [unit] `configChangeCandidates` with `redGates: ["lint"]` and `scripts: { lint: "biome check ." }` returns `[{ key: "lint", to: "biome check .", script: "lint" }]`.
4. [unit] `configChangeCandidates` drops a candidate equal to the key's current command: with `commands: { lint: "biome check ." }`, `redGates: ["lint"]` and `scripts: { lint: "biome check ." }` it returns `[]`.
5. [unit] `configChangeCandidates` with `redGates: []` returns `[]` for `scripts: { test: "bun test" }`.
6. [unit] `configChangeCandidates` with `redGates: ["lint"]` and `scripts: { a: "biome check .", b: "biome check ." }` returns one candidate, naming script `a`.
7. [unit] `configChangeCandidates` with `redGates: ["lint", "scoped"]` returns the `lint` candidates before the `testScoped` candidates.
8. [unit] `readBaseScripts("/repo", "abc123", "apps/admin")` calls `_configChangeDeps.git` with `["show", "abc123:apps/admin/package.json"]` and returns the parsed manifest's `scripts` object.
9. [unit] `readBaseScripts` returns `{}` when the stubbed git call exits non-zero.
10. [unit] `readBaseScripts` returns `{}` when the stubbed git output is not JSON.
11. [unit] `readBaseScripts` returns `{}` when the parsed manifest has no `scripts` object.
12. [unit] `protectedPathList({ projectStateDir: ".nax", credentialDir: "/home/u/.nax", trustStoreFile: "/home/u/.nax/trust.json", ... })` returns `[".nax/", "/home/u/.nax/", "/home/u/.nax/trust.json"]`.
13. [unit] `configChangeCandidates` with `redGates: ["lint"]`, `commands: { lint: ["biome check ."] }` and `scripts: { lint: "biome check ." }` returns `[{ key: "lint", to: "biome check .", script: "lint" }]` (an array command is never equal to a candidate).
14. [unit] `renderCommandSpec(["a", "b"])` returns `a && b`, and `renderCommandSpec("a")` returns `a`.

### US-003

1. [integration] In a temp git repo whose committed `.nax/mono/apps/admin/config.json` sets `quality.commands.testScoped` to `bun test {{files}}` and whose committed `apps/admin/package.json` has script `test: "bun test --isolate"`, `applyConfigChange` for `{ key: "testScoped", to: "bun test --isolate {{files}}", decisionId: "D-3", needsHumanConfirm: false }` returns an outcome with `applied: true` and `from: "bun test {{files}}"`.
2. [integration] After criterion 1, the config file sets `quality.commands.testScoped` to `bun test --isolate {{files}}` and its other keys are unchanged.
3. [integration] After criterion 1, the repo's HEAD commit changes only `.nax/mono/apps/admin/config.json`, with subject `chore(nax): set quality.commands.testScoped for apps/admin (advisor D-3)`.
4. [integration] After criterion 1, an uncommitted edit to another file in the repo is still uncommitted.
5. [integration] After criterion 1, the returned `packageView` selects `quality.commands.testScoped` equal to `bun test --isolate {{files}}`.
6. [integration] `applyConfigChange` with `needsHumanConfirm: true` returns `{ applied: false, reason: "needs-confirm" }` and the config file's bytes are unchanged.
7. [integration] `applyConfigChange` for a story whose package dir is the repo root returns `{ applied: false, reason: "root-package" }` and makes no commit.
8. [integration] `applyConfigChange` for a value that is not a candidate returns `{ applied: false, reason: "not-offered" }` and the config file's bytes are unchanged.
9. [integration] `applyConfigChange` when the config file is not tracked in git returns `{ applied: false, reason: "untracked" }` and the file's bytes are unchanged.
10. [integration] `applyConfigChange` when the stubbed `git commit` exits non-zero returns `{ applied: false, reason: "commit-failed" }` and the config file has its original bytes.
11. [integration] `applyConfigChange` when the stubbed `loadConfigForPackage` throws returns `{ applied: false, reason: "invalid-config" }`, the config file has its original bytes, and HEAD did not move.
12. [integration] `applyConfigChange` when the stubbed `writeFile` throws returns `{ applied: false, reason: "write-failed" }`.

### US-004

1. [unit] `PackageRegistry.refresh("apps/admin")` after the package's override file changed returns a view whose config carries the new `quality.commands.testScoped`, where `resolve("apps/admin")` before the call returned the old value.
2. [integration] With `buildStoryEnv`, after `env.steps.applyConfigChange` returns `applied: true` for `testScoped`, the next `env.steps.gates()` call runs the scoped gate with the new command (the `verifyScopedOp` call stubbed to capture `ctx.packageView.select(...)`'s `quality.commands.testScoped`).
3. [integration] `buildStoryEnv`'s `env.steps.configFacts(["scoped"])` returns `protectedPaths` equal to `protectedPathList(naxProtectedPaths())`.
4. [integration] `buildStoryEnv`'s `env.steps.configFacts(["scoped"])` returns `commands.testScoped` equal to the story's resolved `testScoped` command.
5. [integration] `buildStoryEnv`'s `env.steps.configFacts(["scoped"])` returns the candidates `configChangeCandidates` gives for the story's base-commit scripts.
6. [integration] When the story's base manifest has no `scripts`, `env.steps.configFacts(["scoped"])` returns `candidates: []` together with `protectedPaths` and `commands`.
7. [integration] `buildStoryEnv`'s sink `recordConfigChange` called twice keeps both entries in the story record's `configChanges`, in call order.

### US-005

1. [unit] Through `fixStep`, in a fix round whose last gate run has `scoped` red, an implementer reply `BLOCKED` makes the loop call `env.steps.configFacts` with `["scoped"]`.
2. [unit] In the round from criterion 1, `answerQuestion` receives the `configFacts` result as `facts`.
3. [unit] Through `fixStep`, when the last gate run has every gate green in `gates.states` and only `suite.states` has `full-suite` red, a `BLOCKED` reply calls `answerQuestion` with no `facts` key and does not call `configFacts`.
4. [unit] Through `implementStep` (the first implement turn, no gate run yet), a `BLOCKED` reply calls `answerQuestion` with exactly `{ storyId, status, concerns }` (no `facts` key) and does not call `configFacts`.
5. [unit] Through `fixStep`, when `answerQuestion` returns a `ConfigChangeAnswer` and `applyConfigChange` returns `applied: true`, the implementer is called once in that round (no answer turn follows).
6. [unit] In the case of criterion 5, `fixStep`'s patch has no new concern.
7. [unit] In the case of criterion 5, `fixStep`'s patch has `lastTurn` with `status: "BLOCKED"` and `configApplied: true`.
8. [unit] In the case of criterion 5, the ledger has a line `config change applied: quality.commands.testScoped "bun test {{files}}" -> "bun test --isolate {{files}}" (advisor D-3)`.
9. [unit] In the case of criterion 5, `env.sink.recordConfigChange` is called once with `{ round: 1, key: "testScoped", from: "bun test {{files}}", to: "bun test --isolate {{files}}", applied: true, decisionId: "D-3" }`.
10. [unit] Through `fixStep`, when `applyConfigChange` returns `{ applied: false, reason: "untracked" }`, the ledger has a line `config change refused (untracked): quality.commands.testScoped -> "bun test --isolate {{files}}" (advisor D-3)`.
11. [unit] In the case of criterion 10, the patch's recorded concern text contains `bun test --isolate {{files}}`.
12. [unit] In the case of criterion 10, `env.sink.recordConfigChange` is called with an entry with `applied: false` and `reason: "untracked"`.
13. [unit] Through `fixStep`, when `applyConfigChange` throws, `env.sink.recordConfigChange` is called with `reason: "write-failed"` and `fixStep` resolves.
14. [unit] Through `fixStep`, when `configFacts` throws, `answerQuestion` is still called, with no `facts` key, and a `warn` log line is written.
15. [unit] Through `fixStep`, when `answerQuestion` returns a string, the implementer runs one more turn with that text and `applyConfigChange` is not called.
16. [unit] Through `fixStep`, when the env has no `configFacts` step, a `BLOCKED` reply calls `answerQuestion` with no `facts` key.

### US-006

1. [unit] With `maxFixRounds: 3`, when the pass before fix round 1 had `scoped` red, the round's turn ended `BLOCKED` with no config change applied, and the next pass has `scoped` red again, `evaluateStep` exits `"capped"`.
2. [unit] In the case of criterion 1, the ledger has a line `fix round r1 blocked with scoped unchanged: <open ids> go to the advisor`, naming the open finding ids.
3. [unit] With `lint` and `scoped` both red before and after the round, the ledger line names the gates as `lint, scoped`.
4. [unit] A fix round whose turn ended `BLOCKED` with `lastTurn.configApplied: true`, after which `scoped` stays red, exits `"open"` while rounds remain.
5. [unit] A fix round whose turn ended `BLOCKED` with no change applied, with `scoped` red before and `lint` red after, exits `"open"` while rounds remain.
6. [unit] A fix round whose turn ended `DONE` with `scoped` red before and after exits `"open"` while rounds remain.
7. [unit] A pass with no previous gate run (the first pass of the story) never exits `"capped"` early.
8. [cli] `nax workflow status` (plain), for a story whose record has an applied config change, prints the line `US-007 config change applied: quality.commands.testScoped "bun test {{files}}" -> "bun test --isolate {{files}}" (advisor D-3)` after the open-item lines.
9. [cli] `nax workflow status` (plain), for a refused change, prints the line `US-007 config change refused (untracked): quality.commands.testScoped -> "bun test --isolate {{files}}" (advisor D-3)`.
10. [cli] `nax workflow status --json` includes a `configChanges` array with one `{ storyId: "US-007", round, key, from, to, applied, decisionId }` object per recorded change.
11. [cli] `nax workflow status --json` omits `configChanges` when no story recorded a change.
