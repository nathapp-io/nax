# SPEC: chat-workflow-state — the chat session can read where a nax feature stands

## Summary

`nax chat` gains a read-only tool, `nax-workflow__state`, from a new static tool provider
`nax-workflow`. Given a feature name, the tool returns one structured summary built only from
files and git, with no model call and no network:

- the spec path;
- the PRD's branch and story counts;
- the last run from `status.json` (state, liveness, cost, progress);
- the newest workflow run's verdict (step, outcome, PR url, CI state, open items);
- the feature branch (exists locally, checked out, upstream);
- warnings.

With no feature name it returns the ten most recently touched features.

The same provider contributes a short "nax loop" instruction section, which tells the agent:

- the order of the nax workflow, from brainstorm through spec, review, plan, PRD check, run,
  bot review and fix, to the user's merge;
- to call `nax-workflow__state` before proposing any workflow step.

A small refactor moves the `status.json` reader out of `nax status` so both use one parser.

This is feature 1 of 3 of slice 2 (design
`docs/superpowers/specs/2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`, section 4.2).
Feature 2, `chat-workflow-dispatch`, adds the billed tools and background jobs. Feature 3,
`chat-workflow-chain`, adds full-run approval.

## Motivation

The slice 1 acceptance test (2026-10-27) failed. A brainstorm inside `nax chat` could not find out
what slice 2 was, because the session "had no memory" (user). Today a chat session has no tool or
instruction that points it at `.nax/features/<name>/`, the PRD, the last run or the published PR,
so it cannot answer "where does feature X stand" without the user walking it through the files.
The user carries that state in their head between `nax plan`, `nax run` and `nax bot fix`, which
is the fragmentation the main roadmap exists to remove.

A dispatching session (features 2 and 3) is useless if it cannot find the feature it would
dispatch, so this read path ships first. Cross-session memory (rulings, preferences) is a separate
slice by user ruling (2026-10-27, Q2) and is not part of this feature.

## Design

### Approach

- A new static `ToolProvider` with id `nax-workflow`, in `packages/nax/src/chat/workflow/`. Its
  one tool has local name `state`, so the model sees `nax-workflow__state`. This mirrors
  `createAgentsProvider` (`src/chat/agents-provider.ts`), which ships `nax-agents__run`. The
  design doc calls the tool `workflow__state`; the `nax-` prefix matches the other chat
  providers (`nax-skills`, `nax-agents`).
- The reader `readFeatureState` / `readWorkflowStateList` lives in
  `src/chat/workflow/feature-state.ts`. It reaches workflow modules only by relative leaf paths
  (`../../workflow/run-verdict`), never through the `@/workflow` barrel, because that barrel
  loads `step-context` → `@/cli` and would close an import cycle (see `src/cli/workflow.ts`
  header). Running `bun run check:import-cycles` from `packages/nax` is the gate.
- The `status.json` parse and shape guard (`loadStatusFile` + `isUsableStatusFile`, file-local in
  `src/cli/status-features.ts`) move to a new leaf `src/execution/status-file-read.ts` as
  `readStatusFile(featureDir)`. `status-features.ts` calls it, so `nax status` and the chat tool
  share one parser. `loadProjectStatusFile` stays in `status-features.ts` and reads its file
  through the same helper, given a path.
- The provider's `instructions()` returns a fixed "nax loop" section from a new prompt builder
  `buildWorkflowInstructions()` in `src/prompts/builders/workflow-builder.ts`, exported from the
  `@/prompts` barrel like `buildAgentsInstructions`.
- `chatResources` in `src/cli/chat.ts` builds the provider and places it second:
  `[skills, nax-workflow, ...mcp]`. It imports `createWorkflowProvider` from the `@/chat` barrel
  (`src/chat/index.ts`), as it does `createAgentsProvider`, because `check:alias-internals`
  rejects a deep `@/chat/workflow/...` import.
- `nax-workflow` joins `RESERVED_SERVER_IDS` in `src/chat/chat-mcp.ts`. Providers resolve
  last-wins, so without this an MCP server named `nax-workflow` would silently replace the state
  tool.
- Paths under `.nax/features` are built only with `featureDir` / `featuresDir`, because
  `check:feature-dir-ssot` bans open-coded `.nax/features` paths. `spec` is
  `relative(repoRoot, join(featureDir(repoRoot, name), "spec.md"))`.
- `status-file-read.ts` is imported by relative leaf path only: `../execution/status-file-read`
  from `status-features.ts` and `../../execution/status-file-read` from `feature-state.ts`. It is
  never imported through `@/execution`. `check:alias-internals` rejects a deep
  `@/execution/...` import, and the `@/execution` barrel is not loaded from `chat/`, to avoid
  new cycles.
- `loadRunVerdict` is called as `loadRunVerdict(options.repoRoot, name, async () => options.outputDir)`.
- The tool result is returned as built. The native runtime's existing `ctx.maxBytes` bound on
  every tool result truncates it. The list limit (10) and `FIRST_OPEN_ITEMS_LIMIT` (5) keep a
  normal result well under that bound.

### Integration (extends existing code)

Read only (verified on `main` `2415c3af4`):

- `loadRunVerdict(dir: string, feature: string, resolveOutputDir: (dir: string) => Promise<string>): Promise<LoadedRun>`
  in `src/workflow/run-verdict.ts`. It throws `NaxError` with code `WORKFLOW_RESULT_MISSING`
  (no run directory holds a readable `result.json`) or `WORKFLOW_NOT_STARTED` (the newest result
  has no `featureWorkflow`). `LoadedRun` carries `runId`, `record` (`step`, `url?`, `ci?`),
  `openItems: readonly OpenItem[]` (`kind`, `id`, `issue`) and `result`.
- `buildVerdict(record)` in `src/workflow/open-items.ts` and `fillStoryStates(record, result)` in
  `run-verdict.ts`. `nax workflow status` derives `outcome` from
  `buildVerdict(fillStoryStates(record, result))?.outcome` (`src/cli/workflow.ts` `reportFor`).
- `loadPRD(path): Promise<PRD>` and `countStories(prd)` (`total`, `passed`, `failed`, `pending`)
  in `src/prd/index.ts`. `PRD.branchName: string` (`src/prd/types.ts:445`).
- `featuresDir(root)` / `featureDir(root, id)` in `src/config/paths/index.ts`. `featureDir`
  throws on an invalid id, which `nax status` uses to drop stray directory entries.
- `validateFeatureName(name)` in `src/utils/feature-name.ts`. It throws on a name that could
  escape the tree.
- `projectOutputDir(projectKey, outputDirOverride)` in `src/runtime/paths.ts`, with the key from
  `getProjectKey(config, projectDir)` (`src/config/project-key.ts:24`), as `chat-host.ts` uses it.
- `RESERVED_SERVER_IDS` in `src/chat/chat-mcp.ts:27`, today `{"nax-skills", "nax-agents"}`.
- `gitWithTimeout(args, workdir, timeoutMs?)` re-exported from `src/utils/git.ts`. It returns
  `{ stdout, stderr, exitCode, timedOut? }`.
- `isProcessAlive` from `@nathapp/nax-agent/internal`, as `status-features.ts` imports it.
- `ToolProvider` / `ProviderTool` / `ToolResult` from `@nathapp/nax-agent`. A `static` provider
  tool runs without a framework ask.
- `NaxStatusFile` in `src/execution/status-file.ts`.

Changed (the baseline only locates the code; implement the target):

- `src/cli/status-features.ts` `loadStatusFile`.
  - Baseline: file-local `async function loadStatusFile(featureDir: string): Promise<NaxStatusFile | null>`
    plus file-local `isUsableStatusFile`.
  - Target: both removed from this file. Callers use
    `readStatusFile(featureDir: string): Promise<NaxStatusFile | null>` and
    `readStatusFileAt(path: string): Promise<NaxStatusFile | null>`, both exported from
    `src/execution/status-file-read.ts`.
- `src/cli/chat.ts` `chatResources`.
  - Baseline: `toolProviders: [createSkillsProvider(async () => catalog), ...mcp.providers]`.
  - Target:
    `toolProviders: [createSkillsProvider(async () => catalog), createWorkflowProvider({ repoRoot, outputDir, maxIterations: config.execution.maxIterations }), ...mcp.providers]`,
    with `outputDir = projectOutputDir(getProjectKey(config, repoRoot), config.outputDir)`. A
    relative `config.outputDir` makes `projectOutputDir` throw `CONFIG_INVALID` here, before
    `createChatHost`. `chat-host.ts` already throws the same error, so only the point of failure
    moves, and `chatResources`' existing `catch` still tears the plugin registry down.
- `src/chat/chat-mcp.ts` `RESERVED_SERVER_IDS`.
  - Baseline: `new Set(["nax-skills", "nax-agents"])`.
  - Target: `new Set(["nax-skills", "nax-agents", "nax-workflow"])`.

### Data shapes

```ts
// src/chat/workflow/feature-state.ts
export interface FeatureStateOptions {
  readonly repoRoot: string;
  /** `~/.nax/<projectKey>` (or the configured outputDir). */
  readonly outputDir: string;
  /** Resolved `config.execution.maxIterations`. */
  readonly maxIterations: number;
}

export interface FeatureState {
  readonly name: string;
  /** Repo-relative path of `.nax/features/<name>/spec.md` or `.nax/specs/<name>.md`; null when neither exists. */
  readonly spec: string | null;
  readonly prd: { readonly branchName: string; readonly total: number; readonly passed: number;
                  readonly failed: number; readonly pending: number } | null;
  /** From `.nax/features/<name>/status.json`. */
  readonly run: { readonly id: string; readonly status: string; readonly startedAt: string;
                  readonly alive: boolean; readonly spent: number;
                  readonly passed: number; readonly total: number } | null;
  /** From the newest readable `workflow/<runId>/result.json`. */
  readonly workflow: { readonly runId: string; readonly step: string; readonly outcome?: string;
                       readonly url?: string; readonly ci?: string;
                       readonly openItems: number; readonly firstOpenItems: readonly string[] } | null;
  /** Present only when `prd` is present (the branch name comes from it). */
  readonly branch: { readonly name: string; readonly exists: boolean; readonly current: boolean;
                     readonly upstream: string | null } | null;
  /** Newest `<outputDir>/features/<name>/runs/*.jsonl` file name without extension, excluding `latest.jsonl`. */
  readonly lastRunLog: string | null;
  readonly warnings: readonly string[];
}

export interface WorkflowStateList {
  readonly features: readonly FeatureState[];
  /** Feature directories beyond the list limit. */
  readonly omitted: number;
}

export const WORKFLOW_STATE_LIST_LIMIT = 10;
export const FIRST_OPEN_ITEMS_LIMIT = 5;

export function readFeatureState(name: string, options: FeatureStateOptions): Promise<FeatureState>;
export function readWorkflowStateList(options: FeatureStateOptions): Promise<WorkflowStateList>;
```

- `firstOpenItems` entries are formatted `[<kind>] <id> — <issue>`, matching `nax workflow status`'s
  plain line. `openItems` is the full count.
- `outcome` is `buildVerdict(fillStoryStates(record, result))?.outcome`. It is absent when the
  record has no outcome yet. `ci` and `url` pass through from `record` when present.
- List mode covers feature directories only. A spec-only feature (`.nax/specs/<name>.md` with no
  directory) is accepted by name but not listed. Directory entries whose name `featureDir`
  rejects are skipped.
- List order: newest first by the latest modification time among the feature directory's
  `spec.md`, `prd.json` and `status.json` (missing files ignored). Ties are ordered by name
  ascending.
- Git probes, run in `repoRoot` through an injectable `_featureStateDeps.git`
  (default `gitWithTimeout`). A `branchName` that is empty or starts with `-` is never passed to
  git. Its branch fields take their negative values, because a leading `-` would be read as an
  option:
  - `exists`: `rev-parse --verify --quiet refs/heads/<branch>` exits 0;
  - `current`: `symbolic-ref --short HEAD` stdout trimmed equals the branch;
  - `upstream`: `rev-parse --abbrev-ref <branch>@{upstream}` stdout trimmed when it exits 0,
    else null.
- Warnings, in this order when several apply:
  1. `prd.json unreadable: <message>` when `prd.json` exists but `loadPRD` throws;
  2. `prd has <R> stories left but execution.maxIterations is <M>; pass -m <R> to nax run (nax#2706)`
     when `R = prd.pending` is greater than `maxIterations`. Only pending stories are eligible:
     `getNextStory` skips `passed`, `failed`, `regression-failed` and the other terminal states
     (`src/prd/index.ts:203-210`), and the run loop stops at `maxIterations` iterations
     (`unified-executor.ts:177`). Retries only add iterations, so `-m <R>` is a floor;
  3. `run <id> is marked running but its process is gone` when `status.json` says `running` and
     the pid is not alive;
  4. `workflow record unreadable: <message>` when `loadRunVerdict` throws with any code other
     than `WORKFLOW_RESULT_MISSING` / `WORKFLOW_NOT_STARTED`.

### Tool behaviour (`nax-workflow__state`)

- Input schema: `{ type: "object", properties: { feature: { type: "string" } }, additionalProperties: false }`.
- `feature` absent, `null`, or a string that is empty or whitespace-only → `readWorkflowStateList`
  (models often send `""` or `null` for an optional string). `content` is `JSON.stringify(list, null, 2)`.
- `feature` present → `readFeatureState`. `content` is `JSON.stringify(state, null, 2)`.
- A known feature is one whose directory `.nax/features/<name>/` exists or whose spec
  `.nax/specs/<name>.md` exists.
- Description: "Read where a nax feature stands (spec, PRD, last run, workflow verdict, branch). Omit feature to list recently active features. Read-only; call it before proposing any nax plan/run/bot step."

### Instructions text (`buildWorkflowInstructions()`)

A fixed section. Its required content:

1. a line naming `nax-workflow__state` and saying to call it before proposing any workflow step
   and again after any workflow step ends;
2. the loop in this order: brainstorm → spec-writing → spec-review (at most two fix rounds) →
   `nax plan` → PRD fidelity check (spec-review `--prd`) → commit the spec and PRD → `nax run` →
   `nax bot review` / `nax bot fix` → the user merges → the user releases;
3. a line saying `nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed and start
   only after the user explicitly approves that launch;
4. a line saying nax never merges a PR and never releases.

Exact wording is the builder's.

### Failure Handling

| Input / condition | Behaviour |
|:---|:---|
| `feature` is neither a string nor `null` | `ToolResult` `isError: true`, content `[chat] nax-workflow__state feature must be a string` |
| `feature` fails `validateFeatureName` | `isError: true`, content is the thrown message; nothing is read |
| `feature` is valid but unknown | `isError: true`, content `unknown feature <name>; known: <names>`, where names are the valid feature directory names sorted ascending, at most 20, comma-and-space separated, followed by `, +<N> more` when more exist; `known: (none)` when there are none |
| `.nax/features/` does not exist (list mode) | `{ "features": [], "omitted": 0 }`, not an error |
| `status.json` missing, not JSON, or failing the shape guard | `run: null`, no warning (fail-soft, as `nax status`) |
| `prd.json` missing | `prd: null`, `branch: null`, no warning |
| `prd.json` present but `loadPRD` throws | `prd: null`, `branch: null`, warning 1 |
| `loadRunVerdict` throws `WORKFLOW_RESULT_MISSING` or `WORKFLOW_NOT_STARTED` | `workflow: null`, no warning |
| `loadRunVerdict` throws any other error | `workflow: null`, warning 4 |
| a git probe exits non-zero, times out or throws | that field takes its negative value (`exists: false`, `current: false`, `upstream: null`); no warning |
| `<outputDir>/features/<name>/runs/` missing, or holding only `latest.jsonl` | `lastRunLog: null` |
| `prd.branchName` empty or starting with `-` | no git call; `exists: false`, `current: false`, `upstream: null` |

## Out of Scope

- Live forge lookups (`gh` / `glab`) for PR state such as merged or closed, or for a PR that exists without a published workflow record; the state tool reads only files and git, and the PR url and outcome come from the workflow record.
- The billed workflow tools (`plan`, `run`, `bot review`, `bot fix`), background jobs, job records, cancel and the launch approval card; these are feature `chat-workflow-dispatch`.
- Full-run (chain) approval; this is feature `chat-workflow-chain`.
- Cross-session memory of rulings, preferences or past sessions; this is its own slice, not yet designed (user ruling 2026-10-27).
- Registering the `nax-workflow` provider in the ACP server (koda); only `nax chat` gets it.
- Reading `naxCommit` from run logs, and spec layouts other than `.nax/features/<name>/spec.md` and `.nax/specs/<name>.md`.
- Any change to `nax status` or `nax workflow status` output; US-001 is a behaviour-preserving move of the status.json reader.
- Fixing nax#2706 (silent stop at `maxIterations`); this feature only warns about it.
- Editing files under `.nax/` (rules, context) or the slice 2 design document.
- Listing spec-only features (a `.nax/specs/<name>.md` with no feature directory) in list mode; they are readable by name only.
- Truncating the tool result inside the provider; the native runtime's existing `ctx.maxBytes` bound applies.

## Stories

### US-001 — move the status.json reader into a shared leaf

Workdir: packages/nax. No dependencies.

Refactor only. `loadStatusFile` and `isUsableStatusFile` leave `src/cli/status-features.ts` for a
new `src/execution/status-file-read.ts`. It exports `readStatusFileAt(path)` (parse plus shape
guard) and `readStatusFile(featureDir)` (`readStatusFileAt(join(featureDir, "status.json"))`).
`status-features.ts` calls `readStatusFile` for the feature file and `readStatusFileAt` for the
project file, and its output is unchanged. The existing
`test/unit/cli/cli-status-project-level.test.ts` and `status-features*.test.ts` stay green as the
regression guard for both paths. The new tests go in a new
`test/unit/execution/status-file-read.test.ts`. A "valid version-1 status file" fixture there
means `version: 1`, a `run` with string `id`, string `status` and number `pid`, a `cost` with a
number `spent` and a `limit` that is a number or `null`, and a `progress` with number `passed`
and `total`.

### US-002 — feature state reader: spec, PRD, run, branch, warnings

Workdir: packages/nax. Depends on US-001.

New `src/chat/workflow/feature-state.ts` with the `FeatureStateOptions`, `FeatureState` and
`WorkflowStateList` types, the two limits, `_featureStateDeps` (`git`, `isProcessAlive`), and `readFeatureState` filling `name`, `spec`, `prd`, `run`, `branch` and
warnings 1-3 as described in Design. In this story `workflow` is always `null` and `lastRunLog`
is always `null`; US-003 fills them. `status.json` is read through `readStatusFile`. Tests go in a
new `test/unit/chat/workflow/feature-state.test.ts`, using a temp-dir fixture repo with real
files and stubbed `git` and `isProcessAlive`.

### US-003 — feature state reader: workflow verdict, run log, list mode

Workdir: packages/nax. Depends on US-002.

`readFeatureState` fills `workflow` from `loadRunVerdict` (called as
`loadRunVerdict(repoRoot, name, async () => outputDir)`, through `_featureStateDeps`), with
`outcome` from `buildVerdict(fillStoryStates(record, result))`, plus warning 4. `_featureStateDeps`
gains `loadRunVerdict`. It fills
`lastRunLog` from `<outputDir>/features/<name>/runs/`. `readWorkflowStateList` lists feature
directories newest first, capped at `WORKFLOW_STATE_LIST_LIMIT`. Workflow modules are imported by
relative leaf path, never through `@/workflow`. Tests go in a new
`test/unit/chat/workflow/feature-state-workflow.test.ts`.

### US-004 — the nax loop instructions builder

Workdir: packages/nax. No dependencies.

New `src/prompts/builders/workflow-builder.ts` exporting `buildWorkflowInstructions(): string`
with the required content listed in Design, re-exported from `src/prompts/index.ts`. Tests go in
a new `test/unit/prompts/builders/workflow-builder.test.ts`.

### US-005 — the `nax-workflow` provider and its `state` tool

Workdir: packages/nax. Depends on US-003, US-004.

New `src/chat/workflow/workflow-provider.ts` with
`createWorkflowProvider(options: FeatureStateOptions): ToolProvider`: id `nax-workflow`, kind
`static`, stages `["*"]`, one tool `state` behaving as in Design § Tool behaviour, and
`instructions` returning `buildWorkflowInstructions()`. `createWorkflowProvider` and the
`FeatureStateOptions` type are exported from `src/chat/index.ts`. Tests go in a new
`test/unit/chat/workflow/workflow-provider.test.ts`.

### US-006 — wire the provider into `nax chat`

Workdir: packages/nax. Depends on US-005.

`chatResources` in `src/cli/chat.ts` resolves
`outputDir = projectOutputDir(getProjectKey(config, repoRoot), config.outputDir)` and inserts
`createWorkflowProvider({ repoRoot, outputDir, maxIterations: config.execution.maxIterations })`
after the skills provider. `nax-workflow` is added to `RESERVED_SERVER_IDS` in
`src/chat/chat-mcp.ts`. The wiring tests go in the existing
`test/unit/cli/chat-resources.test.ts`, and the reserved-id test in the existing
`test/unit/chat/chat-mcp.test.ts`.

### Context Files

**US-001**
- `packages/nax/src/cli/status-features.ts`
- `packages/nax/src/execution/status-file.ts`

**US-002**
- `packages/nax/src/execution/status-file-read.ts` — created by US-001, read here
- `packages/nax/src/prd/index.ts`
- `packages/nax/src/config/paths/index.ts`
- `packages/nax/src/utils/git.ts`

**US-003**
- `packages/nax/src/chat/workflow/feature-state.ts` — created by US-002, extended here
- `packages/nax/src/workflow/run-verdict.ts`
- `packages/nax/src/workflow/open-items.ts`
- `packages/nax/src/cli/workflow.ts`

**US-004**
- `packages/nax/src/prompts/builders/agents-builder.ts`
- `packages/nax/src/prompts/index.ts`

**US-005**
- `packages/nax/src/chat/agents-provider.ts`
- `packages/nax/src/chat/index.ts`
- `packages/nax/src/chat/workflow/feature-state.ts` — created by US-002, read here

**US-006**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/chat/chat-mcp.ts`
- `packages/nax/src/config/project-key.ts`
- `packages/nax/test/unit/cli/chat-resources.test.ts`
- `packages/nax/test/unit/chat/chat-mcp.test.ts`

### Creates

**US-001**
- `packages/nax/src/execution/status-file-read.ts`
- `packages/nax/test/unit/execution/status-file-read.test.ts`

**US-002**
- `packages/nax/src/chat/workflow/feature-state.ts`
- `packages/nax/test/unit/chat/workflow/feature-state.test.ts`

**US-003**
- `packages/nax/test/unit/chat/workflow/feature-state-workflow.test.ts`

**US-004**
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts`

**US-005**
- `packages/nax/src/chat/workflow/workflow-provider.ts`
- `packages/nax/test/unit/chat/workflow/workflow-provider.test.ts`

### Modifies

**US-001**
None. `loadStatusFile` and `isUsableStatusFile` are file-local, so no test imports them, and `nax status` output is unchanged, so the existing status-features tests keep passing.

**US-002**
None. The story only adds new files.

**US-003**
None. The story extends a file US-002 created and adds a new test file.

**US-004**
None. The `@/prompts` barrel gains one export, and no test pins the barrel's export list.

**US-005**
None. The `@/chat` barrel gains exports, and no test pins its export list.

**US-006**
- `packages/nax/test/unit/cli/chat-resources.test.ts` — test "AC-15 appends MCP providers after the skills provider" asserts `toolProviders.map((p) => p.id)` `toEqual(["nax-skills", "docs"])`; the workflow provider now sits second, so the expected list becomes `["nax-skills", "nax-workflow", "docs"]` (skills first, MCP providers last and in order is the invariant kept).

### Seams

- US-002 → US-001: `readFeatureState` reads `status.json` only through `readStatusFile`. A US-002 AC proves it with a fixture `status.json` that fails the shape guard and yields `run: null`.
- US-005 → US-003: the `state` tool calls `readFeatureState` / `readWorkflowStateList`. US-005's integration ACs run the tool over a real fixture repo.
- US-005 → US-004: the provider's `instructions` returns `buildWorkflowInstructions()`.
- US-006 → US-005: the wiring is proven from `chatCommand`, the outermost entry point, with a real fixture repo.

## Acceptance Criteria

### US-001 — move the status.json reader into a shared leaf

- [unit] `readStatusFile(dir)` for a directory whose `status.json` is a valid version-1 status file returns an object deep-equal to the file's parsed JSON.
- [unit] `readStatusFile(dir)` for a directory with no `status.json` returns `null`.
- [unit] `readStatusFile(dir)` for a `status.json` holding `not json` returns `null` without throwing.
- [unit] `readStatusFile(dir)` for an otherwise valid `status.json` whose `version` is `2` returns `null`.
- [unit] `readStatusFile(dir)` for an otherwise valid `status.json` with no `run.pid` returns `null`.
- [unit] `readStatusFile(dir)` for an otherwise valid `status.json` whose `cost.limit` is the string `"5"` returns `null`.
- [unit] `readStatusFile(dir)` for an otherwise valid `status.json` that has a `postRun` object with no `acceptance.status` returns `null`.
- [unit] `readStatusFileAt(path)` for a valid status file at an arbitrary path returns an object deep-equal to that file's parsed JSON.
- [integration] `displayFeatureStatus({ dir, feature: "f1" })` on a fixture repo whose `f1` has a `prd.json` and an otherwise valid `status.json` with run id `r-drift` and `version` 2 resolves, and nothing it writes to the console includes `r-drift`.
- [integration] `displayFeatureStatus({ dir, feature: "f1" })` on the same fixture with a valid version-1 `status.json` whose run id is `r-ok` writes console output that includes `r-ok`.

### US-002 — feature state reader: spec, PRD, run, branch, warnings

- [unit] `readFeatureState("f1", options)` for a fixture with `.nax/features/f1/spec.md` returns `spec` equal to `.nax/features/f1/spec.md`.
- [unit] `readFeatureState("f1", options)` for a fixture with no feature spec but a `.nax/specs/f1.md` returns `spec` equal to `.nax/specs/f1.md`.
- [unit] `readFeatureState("f1", options)` for a fixture with neither spec file returns `spec: null`.
- [unit] `readFeatureState("f1", options)` for a fixture whose `prd.json` has branch `feat/f1` and 3 stories (2 passed, 1 pending) returns `prd` deep-equal to `{ branchName: "feat/f1", total: 3, passed: 2, failed: 0, pending: 1 }`.
- [unit] `readFeatureState("f1", options)` for a fixture with no `prd.json` returns `prd: null`.
- [unit] In that case it returns `branch: null`.
- [unit] `readFeatureState("f1", options)` for a fixture whose `prd.json` holds `{` returns a `warnings` entry starting `prd.json unreadable:`.
- [unit] `readFeatureState("f1", { ...options, maxIterations: 2 })` for a PRD with 3 pending stories returns a `warnings` entry equal to `prd has 3 stories left but execution.maxIterations is 2; pass -m 3 to nax run (nax#2706)`.
- [unit] `readFeatureState("f1", { ...options, maxIterations: 2 })` for a 25-story PRD with 24 passed and 1 pending returns no warning containing `maxIterations`.
- [unit] For a valid `status.json` with run id `r1`, status `running`, pid 4242, `cost.spent` 1.5 and progress 1 of 3, with `_featureStateDeps.isProcessAlive` returning true, `readFeatureState` returns `run` deep-equal to `{ id: "r1", status: "running", startedAt: <the file's startedAt>, alive: true, spent: 1.5, passed: 1, total: 3 }`.
- [unit] With that `status.json` and `_featureStateDeps.isProcessAlive` returning false, `readFeatureState` returns a `warnings` entry equal to `run r1 is marked running but its process is gone`.
- [unit] For an otherwise valid `status.json` whose `version` is 2, `readFeatureState` returns `run: null`.
- [unit] With a `prd.json` that holds `{` and a running `status.json` whose pid is not alive, `readFeatureState` returns the `prd.json unreadable:` warning before the `run r1 is marked running` warning.
- [unit] With `_featureStateDeps.git` answering `rev-parse --verify --quiet refs/heads/feat/f1` with exit 0, `symbolic-ref --short HEAD` with stdout `feat/f1\n`, and `rev-parse --abbrev-ref feat/f1@{upstream}` with stdout `origin/feat/f1\n`, `readFeatureState` returns `branch` deep-equal to `{ name: "feat/f1", exists: true, current: true, upstream: "origin/feat/f1" }`.
- [unit] With `_featureStateDeps.git` exiting 1 for every call, `readFeatureState` returns `branch` deep-equal to `{ name: "feat/f1", exists: false, current: false, upstream: null }`.
- [unit] With `_featureStateDeps.git` rejecting for every call, `readFeatureState` resolves with `branch.exists` equal to `false`.
- [unit] For a `prd.json` whose `branchName` is `--upload-pack=x`, `readFeatureState` never calls `_featureStateDeps.git`.
- [unit] For that `branchName`, `readFeatureState` returns `branch` deep-equal to `{ name: "--upload-pack=x", exists: false, current: false, upstream: null }`.
- [unit] For a `prd.json` whose `branchName` is `""`, `readFeatureState` never calls `_featureStateDeps.git` and returns `branch` deep-equal to `{ name: "", exists: false, current: false, upstream: null }`.
- [unit] `readFeatureState("f1", options)` for a fixture with no `workflow/` directory returns `workflow: null`.

### US-003 — feature state reader: workflow verdict, run log, list mode

- [unit] `readFeatureState("f1", options)` calls `_featureStateDeps.loadRunVerdict` with `options.repoRoot`, `"f1"` and a function that resolves to `options.outputDir`.
- [unit] With `_featureStateDeps.loadRunVerdict` resolving a run `w1` whose record has step `done`, url `https://example.test/pr/7` and two open items, `readFeatureState` returns `workflow` whose `runId`, `step`, `url` and `openItems` deep-equal `{ runId: "w1", step: "done", url: "https://example.test/pr/7", openItems: 2 }`.
- [unit] In that case `workflow.firstOpenItems[0]` equals `[<kind>] <id> — <issue>` built from the first open item's `kind`, `id` and `issue`.
- [unit] With `_featureStateDeps.loadRunVerdict` resolving seven open items, `workflow.firstOpenItems` has length 5.
- [unit] In that case `workflow.openItems` equals 7.
- [unit] With a resolved record whose `outcome` is `draft`, `readFeatureState` returns `workflow.outcome` equal to `draft`.
- [unit] With a resolved record that has no `outcome`, `readFeatureState` returns a `workflow` with no `outcome` key.
- [unit] With a resolved record whose `ci` is `pending`, `readFeatureState` returns `workflow.ci` equal to `pending`.
- [unit] With `_featureStateDeps.loadRunVerdict` rejecting a `NaxError` whose code is `WORKFLOW_RESULT_MISSING`, `readFeatureState` returns `workflow: null` and no warning starting `workflow record unreadable`.
- [unit] With `_featureStateDeps.loadRunVerdict` rejecting a `NaxError` whose code is `WORKFLOW_NOT_STARTED`, `readFeatureState` returns `workflow: null` and no warning starting `workflow record unreadable`.
- [unit] With `_featureStateDeps.loadRunVerdict` rejecting `new Error("bad json")`, `readFeatureState` returns a `warnings` entry equal to `workflow record unreadable: bad json`.
- [unit] For an `outputDir` whose `features/f1/runs/` holds `2026-10-01T10-00-00.jsonl`, `2026-10-02T10-00-00.jsonl` and `latest.jsonl`, `readFeatureState` returns `lastRunLog` equal to `2026-10-02T10-00-00`.
- [unit] For an `outputDir` with no `features/f1/runs/` directory, `readFeatureState` returns `lastRunLog: null`.
- [unit] For an `outputDir` whose `features/f1/runs/` holds only `latest.jsonl`, `readFeatureState` returns `lastRunLog: null`.
- [unit] `readWorkflowStateList(options)` for a fixture with twelve valid feature directories returns 10 `features`.
- [unit] In that case it returns `omitted: 2`.
- [unit] In that case the first entry is the feature whose `prd.json` was modified most recently.
- [unit] `readWorkflowStateList(options)` for two feature directories `b` and `a` whose files share one modification time returns `a` before `b`.
- [unit] `readWorkflowStateList(options)` for a fixture whose `.nax/features/` holds a valid feature directory `f1` and a directory named `bad name` returns `features` with one entry, named `f1`.
- [unit] `readWorkflowStateList(options)` for a repo with no `.nax/features/` directory returns `{ features: [], omitted: 0 }`.

### US-004 — the nax loop instructions builder

- [unit] `buildWorkflowInstructions()` returns text that includes `nax-workflow__state`.
- [unit] In `buildWorkflowInstructions()`'s text, `spec-review`, `nax plan`, `nax run` and `nax bot fix` first appear in that order.
- [unit] `buildWorkflowInstructions()` returns text that includes `--prd`.
- [unit] `buildWorkflowInstructions()` returns text that includes `at most two`.
- [unit] `buildWorkflowInstructions()` returns text that includes `explicit` (the billed-launch approval line).
- [unit] `buildWorkflowInstructions()` returns text that includes `never merges`.
- [unit] `buildWorkflowInstructions` imported from `@/prompts` returns the same text as the export of `src/prompts/builders/workflow-builder.ts`.

### US-005 — the `nax-workflow` provider and its `state` tool

- [unit] `createWorkflowProvider(options)` returns a provider with `id` `nax-workflow`.
- [unit] It has `kind` `static`.
- [unit] It has `stages` deep-equal to `["*"]`.
- [unit] The provider's `tools(repoRoot)` resolves to exactly one tool, whose `localName` is `state`.
- [unit] That tool's `inputSchema` deep-equals `{ type: "object", properties: { feature: { type: "string" } }, additionalProperties: false }`.
- [unit] The `state` tool's `description` includes `Read-only`.
- [integration] Running the `state` tool with `{ feature: "f1" }` on a fixture repo with feature `f1` returns a non-error result whose content parses as JSON with `name` equal to `f1`.
- [integration] Running the `state` tool with `{}` on a fixture repo with features `f1` and `f2` returns a non-error result whose content parses as JSON with a `features` array of length 2.
- [integration] Running the `state` tool with `{ feature: "  " }` on that fixture returns a non-error result whose JSON has a `features` array of length 2.
- [integration] Running the `state` tool with `{ feature: null }` on that fixture returns a non-error result whose JSON has a `features` array of length 2.
- [integration] Running the `state` tool with `{ feature: "nope" }` on a fixture repo with no `.nax/features/` directory returns `isError: true` with content `unknown feature nope; known: (none)`.
- [unit] Running the `state` tool with `{ feature: 7 }` returns `isError: true` with content `[chat] nax-workflow__state feature must be a string`.
- [unit] Running the `state` tool with `{ feature: "../etc" }` returns `isError: true`.
- [unit] Running the `state` tool with `{ feature: "../etc" }` never calls `_featureStateDeps.git`.
- [integration] Running the `state` tool with `{ feature: "nope" }` on a fixture repo with features `f2` and `f1` returns `isError: true` with content `unknown feature nope; known: f1, f2`.
- [integration] Running the `state` tool with `{ feature: "f3" }` on a fixture repo with no `.nax/features/f3/` directory but a `.nax/specs/f3.md` file returns a non-error result whose JSON `spec` equals `.nax/specs/f3.md`.
- [unit] The provider's `instructions(repoRoot)` resolves to the string `buildWorkflowInstructions()` returns.
- [unit] `createWorkflowProvider` imported from `@/chat` builds a provider whose `id` is `nax-workflow`.

### US-006 — wire the provider into `nax chat`

- [integration] `chatCommand({}, deps)` with an MCP provider `docs` hands `createChatHost` resources whose `toolProviders` ids equal `["nax-skills", "nax-workflow", "docs"]`.
- [integration] `chatCommand({ dir }, deps)` on a temp fixture repo whose `.nax/features/f1/` holds a 3-story `prd.json` hands `createChatHost` a `nax-workflow` provider whose `state` tool, run with `{ feature: "f1" }`, returns JSON with `prd.total` equal to 3.
- [integration] `chatCommand({ dir }, deps)` with a loaded config whose `execution.maxIterations` is 2, on a fixture whose `f1` PRD has 3 pending stories, yields a `nax-workflow` `state` result for `f1` whose `warnings` include an entry containing `execution.maxIterations is 2`.
- [integration] `chatCommand({ dir }, deps)` hands `createChatHost` a `nax-workflow` provider whose `instructions(dir)` resolves to a non-empty string that includes `nax-workflow__state`.
- [integration] With `NAX_GLOBAL_CONFIG_DIR` set to a temp directory (never the real `~/.nax`), `chatCommand({ dir }, deps)` with a loaded config whose `name` is `proj-x` and no `outputDir` yields a `nax-workflow` `state` result for `f1` whose `lastRunLog` comes from `<globalConfigDir>/proj-x/features/f1/runs/` (fixture run log `2026-10-03T00-00-00.jsonl` reported as `2026-10-03T00-00-00`).
- [unit] `createChatMcp` for MCP servers `{ "nax-workflow": <stdio server> }` returns `providers` whose ids do not include `nax-workflow`.
- [unit] In that case `state.servers` deep-equals `[]`.
- [unit] In that case `state.diagnostics` has an entry with severity `error` and message `[resources] mcp server id nax-workflow is reserved`.
