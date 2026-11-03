# SPEC: nax memory in workflow runs

## Summary

Feature 4 of the nax memory slice (design `docs/superpowers/specs/2026-11-02-nax-memory-design.md`,
section 8). Feature 1 (`memory-store`, #2769) built the mirror store and the `local` provider in
`@nathapp/nax-agent`; feature 2 (`memory-chat`, #2771) built the memory host, the `nax-memory` tool
provider, the `## Memory` prompt section and the chat and CLI surfaces in `packages/nax`. This
feature brings that memory to `nax run` in workflow mode:

- a `memory.inRun` switch (default `true`);
- a run memory object composed once per run in the host process: sync at run start, a fresh index
  for every prompt, the `nax-memory` tools for run-stage sessions, a save counter, and one sync plus
  one summary line at run end;
- the run memory carried by `NaxRuntime`, its tools appended to the runtime's tool providers and its
  close called by `runtime.close()`;
- the memory index in the implementer brief, the branch fix prompt, the CI repair prompt, and (as a
  read-only reference section) the whole-branch review prompt.

## Motivation

A `nax run` starts every story blank. What an earlier chat or run worked out (a test command that
needs a container, a review ruling, a reason a fix was reverted) is in the memory mirror, but no
run session sees it, and a run session cannot save what the next one would need. Feature 2 made
memory real for `nax chat`; this feature makes the same notes visible, and writable, in the
sessions that do a run's work.

## Design

### Translation from the design document

The design document (section 6.6 and 6.8) was written in pipeline-mode vocabulary: a
`ContextElement` emitted by `buildContext()` for the stages listed in `memory.stages`. Pipeline mode
is frozen, and workflow mode, the `nax run` default, does not use `buildContext()`: each workflow
agent session gets a prompt from its own builder, and the implementer reads a brief file written by
`writeBrief` (`src/workflow/brief.ts`). So this feature delivers memory through those builders and
replaces the per-stage list with one switch:

| Workflow session | Op stage | Memory it gets |
|---|---|---|
| Implementer (`wf-implementer`), including its fix / continue turns | `run` | index in the brief + the four `nax-memory` tools |
| Story review (`wf-story-review`) | `review` | the brief it already reads (no tools) |
| Branch fix (`wf-branch-fix`) and final-gate repair (`wf-repair`) | `run` | index in the prompt + tools |
| CI repair (`wf-repair` with `ciRepair`) | `run` | index in the prompt + tools |
| Whole-branch review (`wf-branch-review`) | `review` | read-only reference section (no tools) |
| Re-reviews, advisor | `review` | nothing |

The tools attach by provider stage: the run memory's provider declares `stages: ["run"]`, and the
existing stage filter (`providerAttachesTo`, `packages/nax-agent/src/tools/provider-types.ts:71`,
reached through `resolveProviderContribution` with the op's `pipelineStage`) keeps it off every
`review`-stage session. No session-role list is added.

Stories run one at a time in workflow mode (`effectiveParallelCount` returns 0,
`src/execution/workflow-parallel.ts`), and a static provider's tools run in the nax host process,
not in the sandbox (`packages/nax-agent/src/tools/provider-adapt.ts:34`). So a run-stage save
writes the mirror directly, exactly like a chat save; the design's "stages only append outbox
files" rule has nothing to guard here.

### Approach

New module file `packages/nax/src/memory/run-memory.ts`, exported from the `@/memory` barrel:

```ts
/** The origin a note saved by a run session records. */
export const RUN_MEMORY_SOURCE = "nax-run";
/** The pipeline stage the run memory's tools attach to. */
export const RUN_MEMORY_TOOL_STAGES: readonly string[] = ["run"];

export interface RunMemorySummary {
  readonly saved: number;   // saves that returned a result during this run
  readonly pending: number; // of those, saves whose result status was "pending"
}

export interface RunMemory {
  readonly host: MemoryHost;
  /** The four nax-memory tools over a counting view of `host`, stages ["run"]. */
  readonly provider: ToolProvider;
  /** The rendered index, read fresh on every call; undefined when empty or unavailable. Never throws. */
  index(): Promise<string | undefined>;
  /** The counts `close()` logs; read by tests, no other production reader. */
  summary(): RunMemorySummary;
  /** First call: one sync, then one summary log line. Later calls do nothing. Never throws. */
  close(): Promise<void>;
}

export interface CreateRunMemoryInput {
  readonly config: NaxConfig;
  /** Absolute repository root (the run's workdir); the mirror identity. */
  readonly repoRoot: string;
  readonly logger: MemoryLogger;
}

export async function createRunMemory(input: CreateRunMemoryInput): Promise<RunMemory | undefined>;
export const _runMemoryDeps: { createMemoryHost: typeof createMemoryHost };
```

`createRunMemory`, in order:

1. `memoryConfigOf(input.config).inRun === false` → returns `undefined` without calling
   `createMemoryHost`.
2. `_runMemoryDeps.createMemoryHost({ config, repoRoot, source: RUN_MEMORY_SOURCE, logger })`.
   `null` (memory disabled) → `undefined`. A throw → `logger.warn("run", "memory unavailable",
   { storyId: "_run", error })` and `undefined`.
3. `await host.sync()` once. A throw → `logger.warn("run", "memory sync failed", { storyId: "_run",
   error })`; the run memory is still returned. A returned `locked`, `unreachable` or `failed`
   result is not a throw and logs nothing.
4. Returns the run memory.

`provider` is `createMemoryToolProvider(counting)` with its `stages` replaced by
`RUN_MEMORY_TOOL_STAGES` (a new object: `{ ...provider, stages: RUN_MEMORY_TOOL_STAGES }`).
`counting` is `host` with `save` wrapped: after `host.save(write)` resolves, `saved` grows by one,
and `pending` by one when the result's `status` is `"pending"`; a rejected save changes neither.
Every other `MemoryHost` member is the host's own.

`index()` returns `(await host.renderIndex()).text`, or `undefined` when that text is `""`; a throw
→ `logger.warn("run", "memory index unavailable", { storyId: "_run", error })` and `undefined`.

`close()` on its first call awaits `host.sync()` (a throw → the same `memory sync failed` warn), then
logs `logger.info("run", "Memory: <saved> saved (<pending> pending)", { storyId: "_run", saved,
pending })`. A second call returns without syncing or logging.

`errorMessage` (`@nathapp/nax-agent/internal`) renders every `error` field.

#### Config (`memory.inRun`)

```jsonc
"memory": {
  "enabled": true,
  "provider": "local",
  "writeMode": "direct",
  "indexBytes": 24576,
  "askOnSave": true,
  "inRun": true            // false: nax run gets no memory sync, index or tools; chat is unaffected
}
```

`MemoryConfigSchema` gains `inRun: z.boolean().default(true)`; it stays `.strict()`, so `stages`
and `koda` remain unknown keys. `MemoryConfig` (`src/config/runtime-types-memory.ts`) gains
`inRun: boolean`. `FIELD_DESCRIPTIONS` gains `memory.inRun`. `memory.enabled: false` still turns
everything off (step 2 above).

#### Runtime

`NaxRuntime` (`src/runtime/index.ts`) gains `readonly memory?: RunMemory` and
`CreateRuntimeOptions` gains `memory?: RunMemory` (`import type { RunMemory } from "../memory"`, matching the file's
relative imports, so the runtime adds no runtime import edge). `createRuntime`:

- appends `opts.memory.provider` after the existing providers (MCP, then skills) when
  `opts.memory` is set; the list is unchanged otherwise;
- returns `memory: opts.memory` only when it is set (no `memory` key otherwise);
- in `close()`, awaits `opts.memory.close()` once (the existing `closed` guard already makes
  `close()` idempotent), in a `finally` around the rest of the close body, so a rejection from
  `mcpPool.close()` or a flush cannot skip the run-end sync; `memory.close()` never throws.

`src/runtime/index.ts` is at 597 of 600 lines. To make room, `CreateRuntimeOptions` moves verbatim
(with its doc comments) into a new `src/runtime/runtime-options.ts`, and `index.ts` re-exports it
(`export type { CreateRuntimeOptions } from "./runtime-options"`), so every importer is unchanged.
The move is a precondition of the line cap, not a behaviour change, and is checked by
`bun run typecheck` and `bun run check:file-sizes`.

#### Run setup

`setupRun` (`src/execution/lifecycle/run-setup.ts`, 557 lines) first resolves the runtime config
into a local (today `runtimeConfigFor(config, workdir)` is evaluated inline as the first argument of
`createRuntime`, `run-setup.ts:263`), then creates the run memory, then calls `createRuntime` with
that local, so a throwing `runtimeConfigFor` never leaves a created run memory unclosed (a synchronous throw from `createRuntime` itself still would, the same gap the runtime's own resources have; the mirror holds nothing that needs closing). The run
memory is created when, and only when, `isWorkflowMode(config)` is true and `options.dryRun` is
false:

```ts
const runtimeConfig = await runtimeConfigFor(config, workdir);
const memory =
  !options.dryRun && isWorkflowMode(config)
    ? await _runSetupDeps.createRunMemory({ config, repoRoot: workdir, logger: getLogger() })
    : undefined;
```

and passes `...(memory ? { memory } : {})` in the `createRuntime(runtimeConfig, workdir, …)` options. `_runSetupDeps` gains
`createRunMemory`; `run-setup.ts` gains imports of `getLogger` (`@/logger`) and `isWorkflowMode`
(`@/config`). The CLI initialises the run logger (`bin/nax.ts`) before `setupRun`, so the logger
captured here is the run's. `createRunMemory` never throws, so this adds no failure path to setup. The run
end is `runtime.close()`, which `runner.ts` awaits in the innermost `finally` on every exit path,
and which `setupRun`'s own failure cleanup (`run-setup.ts:548`) also calls.

Test impact: the default `execution.mode` is workflow, so every test that drives the real `setupRun`
with `dryRun: false` would now run the real `createRunMemory`. `test/preload.ts` points
`NAX_GLOBAL_CONFIG_DIR` at an isolated directory, so no test touches the real `~/.nax`, but the
lifecycle unit tests that replace `_runSetupDeps.createRuntime` are authorised (US-006 Modifies) to
replace `_runSetupDeps.createRunMemory` with one resolving `undefined` in the same fixture. The
runner-level integration and e2e tests keep the real run memory: it runs against the isolated
directory exactly as a real run would, and adds one `Memory: 0 saved (0 pending)` info line.

#### Prompt builders

`src/prompts/builders/memory-builder.ts` gains:

```ts
/** The read-only memory section: the index as background, for a session without the memory tools. */
export function buildMemoryReferenceSection(memoryIndex: string): string;
export function memoryReferenceSectionOf(memoryIndex: string | undefined): string | undefined;
```

`buildMemoryReferenceSection(index)` returns `"## Memory\n\n" + MEMORY_REFERENCE_NOTE + "\n\n" +
index`, where `MEMORY_REFERENCE_NOTE` is `"Notes earlier sessions saved for this project, one line
each. Use them as background; you cannot read or change them in this session."`.
`memoryReferenceSectionOf` returns `undefined` for an `undefined` or `""` index, like the existing
`memorySectionOf`. Both are exported from `src/prompts/index.ts`.

Each builder below gains an optional `memoryIndex?: string` input. Absent or `""`, its output is
byte-identical to today's.

| Builder | File | Section | Placement |
|---|---|---|---|
| `buildWorkflowBrief` | `workflow-implementer-builder.ts` | `memorySectionOf` (tool section) | after the `## Rules index` section (when present) and before `## Feature context` |
| `buildWorkflowBranchFixPrompt` | `workflow-branch-builder.ts` | `memorySectionOf` | after the `## How to work` list, before `WORKFLOW_REPLY_CONTRACT` |
| `buildWorkflowCiRepairPrompt` | `workflow-ci-repair-builder.ts` | `memorySectionOf` | after `REPAIR_VERIFICATION_RULE`, before `WORKFLOW_REPLY_CONTRACT` |
| `buildWorkflowBranchReviewPrompt` | `workflow-branch-builder.ts` (`BranchReviewPromptInput`) | `memoryReferenceSectionOf` | before the `## Your remit` heading |

#### Callers

Each caller reads `runtime.memory` from the call context it already holds and awaits `index()` once
per prompt it builds:

- `writeBrief(sc)` (`src/workflow/brief.ts`): `memoryIndex` = `await sc.callCtx.runtime.memory?.index()`.
- `runBranchFix(fc, input)` (`src/workflow/branch-fix.ts`): awaits
  `fc.callCtx.runtime.memory?.index()` before building the prompt and passes it to `promptFor`,
  which hands it to `buildWorkflowCiRepairPrompt` or `buildWorkflowBranchFixPrompt`. An explicit
  `input.prompt` (the bot fix path) is used as given and `index()` is not called.
- `runBranchReview(fc, input)` (`src/workflow/branch-review.ts:102`): passes `memoryIndex` the same way.

Bot review and bot fix create their runtime without a run memory, so `runtime.memory` is absent
there and their prompts are unchanged.

### Integration

Read only (verified):

- `createMemoryHost(input: CreateMemoryHostInput): Promise<MemoryHost | null>` and `MemoryHost`
  (`src/memory/host.ts`); `CreateMemoryHostInput { config: NaxConfig; repoRoot: string; source:
  string; logger: MemoryLogger }`.
- `createMemoryToolProvider(host: MemoryHost): ToolProvider` (`src/memory/tool-provider.ts:354`),
  `kind: "static"`, `stages: ["*"]`, id `MEMORY_TOOL_PROVIDER_ID` (`"nax-memory"`).
- `MemorySaveResult { slug: string; status: MemoryNoteStatus; delivered: boolean }`
  (`packages/nax-agent/src/memory/operations.ts:126`).
- `memorySectionOf(memoryIndex: string | undefined): string | undefined`
  (`src/prompts/builders/memory-builder.ts:39`).
- `isWorkflowMode` (`@/config`), `getLogger` (`@/logger`), `errorMessage`
  (`@nathapp/nax-agent/internal`).
- `CallContext.runtime: NaxRuntime` (`src/operations/types.ts`); `StepContext.callCtx`
  (`src/workflow/step-context.ts`); `BranchStepContext.callCtx` (`src/workflow/branch-step-context.ts:8`).
- Op stages: `workflowImplementOp` and `workflowBranchFixOp` are `stage: "run"`
  (`src/operations/workflow-implement.ts:51`, `workflow-branch-fix.ts:33`); `workflowRepairOp`
  spreads `workflowBranchFixOp` (`workflow-repair.ts:26`).

Changed (the baseline exists only to locate the code; the target is the interface to implement):

- `MemoryConfigSchema` / `MemoryConfig`. Baseline: `{ enabled, provider, writeMode, indexBytes,
  askOnSave }`. Target: the same plus `inRun: boolean`, default `true`.
- `CreateRuntimeOptions`. Baseline: declared in `src/runtime/index.ts:294`. Target: declared in
  `src/runtime/runtime-options.ts`, re-exported from `src/runtime/index.ts`, with one more optional
  field `memory?: RunMemory`.
- `NaxRuntime`. Target: gains `readonly memory?: RunMemory`.
- `buildWorkflowBrief(input: WorkflowBriefInput)`. Target: `WorkflowBriefInput` gains
  `memoryIndex?: string`.
- `buildWorkflowBranchFixPrompt(input: { specPath?; prdPath?; reportPath; findings })`. Target: the
  input gains `memoryIndex?: string`.
- `buildWorkflowCiRepairPrompt(input: { round; prUrl?; specPath?; prdPath?; reportPath; findings })`.
  Target: the input gains `readonly memoryIndex?: string`.
- `BranchReviewPromptInput`. Target: gains `readonly memoryIndex?: string`.
- `promptFor(fc, input)` (`src/workflow/branch-fix.ts`, file-local). Target: `promptFor(fc, input,
  memoryIndex?: string)`.
- `_runSetupDeps` (`run-setup.ts:70`). Target: gains `createRunMemory`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `memory.inRun` false | no run memory; `createMemoryHost` not called; prompts unchanged |
| `memory.enabled` false | `createMemoryHost` returns `null`; no run memory |
| `createMemoryHost` throws (e.g. `MEMORY_REPO_ROOT_UNRESOLVED`) | warn `memory unavailable`; the run proceeds without memory |
| run-start `host.sync()` throws | warn `memory sync failed`; the run memory is still used |
| `host.renderIndex()` throws | warn `memory index unavailable`; that prompt has no memory section |
| a save is rejected by the store (secret, invalid note) | the tool answers `isError` (feature 2); the counter does not change |
| run-end `host.sync()` throws | warn `memory sync failed`; the summary line is still logged; `runtime.close()` continues |
| `nax run --dry-run` or pipeline mode | no run memory is created |

## Out of Scope

- Pipeline mode (`execution.mode: "pipeline"`, frozen) gets no memory: no `ContextElement` of type `memory`, no tools, no index; `buildContext()` is unchanged.
- The design's `memory.stages` list is not built; `memory.inRun` is the only run switch and the tools always attach to `run`-stage sessions only.
- Bot review and bot fix (`nax bot review`, `nax bot fix`) get no memory index or tools; their runtime is created without a run memory.
- `nax plan` gets no memory index or tools.
- Story re-reviews, branch re-reviews and the advisor get no memory section.
- Review-stage sessions get no read-only memory tools (`get` / `search` without `save` / `forget`); the whole-branch reviewer sees only the index lines.
- The story reviewer reads the implementer's brief, whose memory section names `nax-memory__get` and `nax-memory__search`; the reviewer has no memory tools and nothing is changed for it.
- The memory section is injected whenever a run memory exists, even into a session the memory tools did not attach to (the `safe` profile, a `scoped` profile without `Mcp(nax-memory__*)` grants, an agent that cannot take provider tools); the section's tool line is not adapted per session.
- No sync runs between stories or mid-session; the index is re-rendered from the mirror for each prompt, and saves reach the mirror immediately through the `local` provider.
- No new permission handling: memory tools follow the existing provider scope, so under the `safe` permission profile they are not attached, and under `scoped` they need `Mcp(nax-memory__*)` grants; memory tools never ask inside a run.
- A run launched from a separate git worktree uses that worktree's own mirror (the mirror is keyed by the realpath of the repo root, feature 2); sharing one mirror across worktrees of one repository is not built.
- The memory summary is a log line at runtime close; it is not added to the `Workflow summary` line, the headless footer, `status.json` or the PR body.
- The koda provider and the generic MCP provider are features 3 and 5; `memory.provider` still accepts only `local`.
- No change to `packages/nax-agent`.

## Stories

Feature size: 7 stories, one capability (memory delivery into workflow runs). Every story runs in
`packages/nax`.

**US-001: Run memory switch.** No dependencies. Workdir: `packages/nax`. Adds `memory.inRun` to `MemoryConfigSchema`, `MemoryConfig` and `FIELD_DESCRIPTIONS`.

**US-002: Memory sections in workflow prompts.** No dependencies. Workdir: `packages/nax`. Adds `buildMemoryReferenceSection` and `memoryReferenceSectionOf` to `src/prompts/builders/memory-builder.ts`, exports them from `src/prompts/index.ts`, and adds `memoryIndex` to `buildWorkflowBrief`, `buildWorkflowBranchFixPrompt`, `buildWorkflowCiRepairPrompt` and `buildWorkflowBranchReviewPrompt`.

**US-003: Run memory: composition, start sync and index.** Depends on US-001. Workdir: `packages/nax`. Creates `src/memory/run-memory.ts` with `createRunMemory`, `RunMemory`, `RunMemorySummary`, `CreateRunMemoryInput`, `RUN_MEMORY_SOURCE`, `RUN_MEMORY_TOOL_STAGES`, `_runMemoryDeps` and `index()`; `provider`, `summary()` and `close()` are present with their final types and are completed by US-004 (until then `summary()` returns `{ saved: 0, pending: 0 }`, `close()` resolves without doing anything, and `provider` is the uncounted host's provider with `RUN_MEMORY_TOOL_STAGES`); exports from the `@/memory` barrel.

**US-004: Run memory: tools, counter and close.** Depends on US-003. Workdir: `packages/nax`. Completes `provider` (counting view), `summary()` and `close()` in `src/memory/run-memory.ts`.

**US-005: Runtime carries the run memory.** Depends on US-004. Workdir: `packages/nax`. Moves `CreateRuntimeOptions` to `src/runtime/runtime-options.ts`, adds `memory` to it and to `NaxRuntime`, appends the provider in `createRuntime` and calls `memory.close()` from `runtime.close()`.

**US-006: Run setup creates the run memory.** Depends on US-005. Workdir: `packages/nax`. Adds `createRunMemory` to `_runSetupDeps` and the guarded creation before `createRuntime` in `setupRun`.

**US-007: Workflow steps put the index in their prompts.** Depends on US-002, US-005. Workdir: `packages/nax`. Wires `runtime.memory.index()` into `writeBrief`, `runBranchFix` (through `promptFor`) and `runBranchReview`.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-memory.ts` — `MemoryConfigSchema`, `memoryConfigOf`
- `packages/nax/src/config/runtime-types-memory.ts` — `MemoryConfig`
- `packages/nax/src/cli/config-descriptions.ts` — the `memory.*` entries

**US-002**
- `packages/nax/src/prompts/builders/memory-builder.ts` — `buildMemorySection`, `memorySectionOf`
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `buildWorkflowBrief`, `WorkflowBriefInput`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchFixPrompt`, `buildWorkflowBranchReviewPrompt`, `BranchReviewPromptInput`
- `packages/nax/src/prompts/builders/workflow-ci-repair-builder.ts` — `buildWorkflowCiRepairPrompt`
- `packages/nax/test/unit/workflow/brief-rules-index.test.ts` — brief section-order assertions

**US-003**
- `packages/nax/src/memory/host.ts` — `createMemoryHost`, `MemoryHost`, `CreateMemoryHostInput`
- `packages/nax/src/memory/tool-provider.ts` — `createMemoryToolProvider`
- `packages/nax/src/chat/host-memory.ts` — guarded sync and render precedent
- `packages/nax/src/memory/index.ts` — the barrel

**US-004**
- `packages/nax/src/memory/run-memory.ts` — created by US-003, completed here
- `packages/nax-agent/src/memory/operations.ts` — `MemorySaveResult`

**US-005**
- `packages/nax/src/runtime/index.ts` — `NaxRuntime`, `CreateRuntimeOptions`, `createRuntime`, `close()`; 597 of 600 lines
- `packages/nax/src/runtime/run-tool-providers.ts` — `withRunSkills`
- `packages/nax/test/unit/runtime/runtime-skills-provider.test.ts` — provider-list assertions on `createRuntime`
- `packages/nax/src/memory/run-memory.ts` — created by US-003, `RunMemory`

**US-006**
- `packages/nax/src/execution/lifecycle/run-setup.ts` — `setupRun`, `_runSetupDeps`, the `createRuntime` call
- `packages/nax/test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts` — capturing the `createRuntime` options from `setupRun`

**US-007**
- `packages/nax/src/workflow/brief.ts` — `writeBrief`
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix`, `promptFor`
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview`
- `packages/nax/test/unit/workflow/branch-fix.test.ts` — `runBranchFix` fixtures

### Creates

**US-003**
- `packages/nax/src/memory/run-memory.ts`
- `packages/nax/test/unit/memory/run-memory.test.ts`

**US-005**
- `packages/nax/src/runtime/runtime-options.ts`
- `packages/nax/test/unit/runtime/runtime-memory.test.ts`

**US-006**
- `packages/nax/test/unit/execution/lifecycle/run-setup-memory.test.ts`

**US-007**
- `packages/nax/test/unit/workflow/workflow-memory-prompts.test.ts`

### Modifies

`src/memory/run-memory.ts` is created by US-003 and completed by US-004 without an entry here.

**US-001**
- `packages/nax/src/config/schemas-memory.ts` — add `inRun: z.boolean().default(true)` to `MemoryConfigSchema`; the schema stays `.strict()`.
- `packages/nax/src/config/runtime-types-memory.ts` — add `inRun: boolean` to `MemoryConfig`.
- `packages/nax/src/cli/config-descriptions.ts` — add the `memory.inRun` entry to `FIELD_DESCRIPTIONS`.
- `packages/nax/test/unit/config/schemas-memory.test.ts` — `DEFAULT_MEMORY` and the AC-9 `configured` literal are closed `toEqual` objects of the memory block; both gain `inRun` (`true` in the default, `false` in the configured literal), and the invariant stays "the parsed default and a configured block round-trip exactly".

**US-002**
- `packages/nax/src/prompts/builders/memory-builder.ts` — add `buildMemoryReferenceSection` and `memoryReferenceSectionOf`.
- `packages/nax/src/prompts/index.ts` — export `buildMemoryReferenceSection`, `memoryReferenceSectionOf` and `memorySectionOf`.
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `WorkflowBriefInput` gains `memoryIndex?: string`; `buildWorkflowBrief` renders it after the rules index and before the feature context.
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `BranchReviewPromptInput` and the `buildWorkflowBranchFixPrompt` input gain `memoryIndex`; each builder renders its section where the Design table places it.
- `packages/nax/src/prompts/builders/workflow-ci-repair-builder.ts` — the `buildWorkflowCiRepairPrompt` input gains `memoryIndex`; the section renders before the reply contract.

**US-003**
- `packages/nax/src/memory/index.ts` — export `createRunMemory`, `_runMemoryDeps`, `RUN_MEMORY_SOURCE`, `RUN_MEMORY_TOOL_STAGES` and the types `RunMemory`, `RunMemorySummary`, `CreateRunMemoryInput`.

**US-005**
- `packages/nax/src/runtime/index.ts` — move the `CreateRuntimeOptions` interface into the new runtime options module (US-005 Creates) and re-export it; add `readonly memory?: RunMemory` to `NaxRuntime`; append `opts.memory.provider` to `toolProviders`; return `memory` only when set; await `opts.memory.close()` in a `finally` around the rest of the `close()` body; the file must end at no more than 600 lines.

**US-006**
- `packages/nax/src/execution/lifecycle/run-setup.ts` — add `createRunMemory` to `_runSetupDeps`; import `getLogger` from the logger barrel and `isWorkflowMode` from the config barrel; resolve `runtimeConfigFor(config, workdir)` into a local first, then create the run memory, then call `createRuntime` with that local config; the run memory is created only when the config is in workflow mode and the run is not a dry run, and is passed as the `memory` option only when it is defined.
- `packages/nax/test/unit/execution/lifecycle/gitignore-reconcile.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-approvals-seal.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-chat-asks.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-locks.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-mcp-in-run.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-no-migration.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-warnings-native-defaults.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup-warnings.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/run-setup.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).
- `packages/nax/test/unit/execution/lifecycle/scratchpad-wipe.test.ts` — its fixture replaces `_runSetupDeps.createRuntime` and drives the real `setupRun` in workflow mode, which now also calls the real `createRunMemory`; the fixture may replace `_runSetupDeps.createRunMemory` with one resolving `undefined` and restore it with the other deps it restores (the invariant is that this test's assertions describe setup without a run memory).

**US-007**
- `packages/nax/src/workflow/brief.ts` — `writeBrief` awaits `sc.callCtx.runtime.memory?.index()` and passes `memoryIndex` to `buildWorkflowBrief` when defined.
- `packages/nax/src/workflow/branch-fix.ts` — `runBranchFix` awaits `fc.callCtx.runtime.memory?.index()` when `input.prompt` is undefined and passes it to `promptFor`, which forwards it to the CI repair or branch fix builder.
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReview` awaits `fc.callCtx.runtime.memory?.index()` and passes `memoryIndex` to `buildWorkflowBranchReviewPrompt`.

### Seams

- US-001 `memory.inRun` → US-003 `createRunMemory`: US-003 asserts `inRun: false` returns `undefined` without calling `_runMemoryDeps.createMemoryHost`.
- US-003/US-004 `createRunMemory` → US-006 `setupRun`: entry point `setupRun` with a stubbed `_runSetupDeps.createRunMemory`; asserted through the options the stubbed `_runSetupDeps.createRuntime` receives.
- US-004 `RunMemory.provider` / `close` → US-005 `createRuntime`: entry point `createRuntime(config, workdir, { memory })`, observed through `runtime.toolProviders` and `runtime.close()`.
- US-002 builder `memoryIndex` inputs + US-005 `NaxRuntime.memory` → US-007: entry points `writeBrief`, `runBranchFix` and `runBranchReview`, with a call context whose `runtime.memory` is a fake `RunMemory`; asserted through the brief file and the prompt the stubbed `_workflowDeps.callOp` receives.

## Acceptance Criteria

### US-001

- [unit] `NaxConfigSchema.parse({}).memory.inRun` is `true`.
- [unit] `NaxConfigSchema.parse({ memory: { inRun: false } }).memory.inRun` is `false`.
- [unit] `NaxConfigSchema.safeParse({ memory: { inRun: "yes" } })` fails with an issue whose path is `["memory", "inRun"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { stages: ["run"] } })` still fails because `memory` accepts no unknown key.
- [unit] `memoryConfigOf({}).inRun` is `true`.
- [unit] `FIELD_DESCRIPTIONS["memory.inRun"]` is a non-empty string.

Verification note: `bun run typecheck` passes with `MemoryConfig.inRun` declared.

### US-002

- [unit] `buildMemoryReferenceSection("- [project] a — b")` returns `"## Memory\n\nNotes earlier sessions saved for this project, one line each. Use them as background; you cannot read or change them in this session.\n\n- [project] a — b"`.
- [unit] `memoryReferenceSectionOf(undefined)` returns `undefined`.
- [unit] `memoryReferenceSectionOf("")` returns `undefined`.
- [unit] Importing `buildMemoryReferenceSection`, `memoryReferenceSectionOf` and `memorySectionOf` from `@/prompts` succeeds and each is a function.
- [unit] `buildWorkflowBrief` given `memoryIndex: "INDEX-LINE"` returns text containing `memorySectionOf("INDEX-LINE")`.
- [unit] `buildWorkflowBrief` given `memoryIndex` and a non-empty `rulesIndex` places `## Memory` after `## Rules index`.
- [unit] `buildWorkflowBrief` given `memoryIndex` and `featureContext: "FEATURE"` places `## Memory` before `## Feature context`.
- [unit] `buildWorkflowBrief` given `memoryIndex: ""` returns the same text as with `memoryIndex` absent.
- [unit] `buildWorkflowBranchFixPrompt` given `memoryIndex: "INDEX-LINE"` returns text containing `memorySectionOf("INDEX-LINE")`.
- [unit] `buildWorkflowBranchFixPrompt` given `memoryIndex` places `## Memory` after `## How to work` and before the text of `WORKFLOW_REPLY_CONTRACT`.
- [unit] `buildWorkflowBranchFixPrompt` with `memoryIndex` absent returns text with no `## Memory` heading.
- [unit] `buildWorkflowCiRepairPrompt` given `memoryIndex: "INDEX-LINE"` returns text containing `memorySectionOf("INDEX-LINE")`.
- [unit] `buildWorkflowCiRepairPrompt` given `memoryIndex` places `## Memory` after the text of `REPAIR_VERIFICATION_RULE` and before the text of `WORKFLOW_REPLY_CONTRACT`.
- [unit] `buildWorkflowCiRepairPrompt` with `memoryIndex` absent returns text with no `## Memory` heading.
- [unit] `buildWorkflowBranchReviewPrompt` given `memoryIndex: "INDEX-LINE"` returns text containing `buildMemoryReferenceSection("INDEX-LINE")`.
- [unit] `buildWorkflowBranchReviewPrompt` given `memoryIndex` places `## Memory` before `## Your remit`.
- [unit] `buildWorkflowBranchReviewPrompt` given `memoryIndex` returns text that does not name `nax-memory__get`.
- [unit] `buildWorkflowBranchReviewPrompt` with `memoryIndex` absent returns text with no `## Memory` heading.

### US-003

- [unit] `createRunMemory` with `memory: { inRun: false }` in the config returns `undefined` and `_runMemoryDeps.createMemoryHost` is not called.
- [unit] `createRunMemory` calls `_runMemoryDeps.createMemoryHost` once with `{ config, repoRoot, source: "nax-run", logger }` from its input.
- [unit] `RUN_MEMORY_SOURCE` equals `"nax-run"`.
- [unit] `createRunMemory` returns `undefined` when `_runMemoryDeps.createMemoryHost` resolves `null`.
- [unit] When `_runMemoryDeps.createMemoryHost` rejects with `new Error("boom")`, `createRunMemory` resolves `undefined`.
- [unit] When `_runMemoryDeps.createMemoryHost` rejects with `new Error("boom")`, the logger receives `warn("run", "memory unavailable", { storyId: "_run", error: "boom" })`.
- [unit] `createRunMemory` calls the host's `sync` exactly once before it resolves.
- [unit] When the host's `sync` rejects with `new Error("down")`, `createRunMemory` still resolves a run memory whose `host` is that host.
- [unit] When the host's `sync` rejects with `new Error("down")`, the logger receives `warn("run", "memory sync failed", { storyId: "_run", error: "down" })`.
- [unit] When the host's `sync` resolves a `locked` result, `createRunMemory` logs no warn.
- [unit] `runMemory.index()` resolves the `text` the host's `renderIndex` resolves.
- [unit] `runMemory.index()` calls the host's `renderIndex` on every call (two calls, two renders).
- [unit] `runMemory.index()` resolves `undefined` when the host's `renderIndex` resolves `text: ""`.
- [unit] When the host's `renderIndex` rejects with `new Error("bad")`, `runMemory.index()` resolves `undefined`.
- [unit] When the host's `renderIndex` rejects with `new Error("bad")`, the logger receives `warn("run", "memory index unavailable", { storyId: "_run", error: "bad" })`.
- [unit] `runMemory.provider.id` is `"nax-memory"`.
- [unit] `runMemory.provider.stages` equals `["run"]`.
- [unit] With a real memory host over temp directories, `await runMemory.provider.tools(workdir)` returns tools whose `localName` values are `get`, `search`, `save` and `forget`, in that order.
- [unit] Importing `createRunMemory` and `RUN_MEMORY_TOOL_STAGES` from `@/memory` succeeds.

### US-004

- [unit] After the provider's `save` tool runs once and the host's `save` resolves `{ status: "active" }`, `runMemory.summary()` returns `{ saved: 1, pending: 0 }`.
- [unit] After the provider's `save` tool runs once and the host's `save` resolves `{ status: "pending" }`, `runMemory.summary()` returns `{ saved: 1, pending: 1 }`.
- [unit] After the provider's `save` tool runs and the host's `save` rejects, `runMemory.summary()` returns `{ saved: 0, pending: 0 }`.
- [unit] After the provider's `forget` tool runs, `runMemory.summary()` is unchanged.
- [unit] The provider's `save` tool passes the model's note to the host's `save` (same slug, type, description and body).
- [unit] `runMemory.close()` calls the host's `sync` once more (twice in total including the start sync).
- [unit] `runMemory.close()` after one active and one pending save logs `info("run", "Memory: 2 saved (1 pending)", { storyId: "_run", saved: 2, pending: 1 })`.
- [unit] `runMemory.close()` with no saves logs `info("run", "Memory: 0 saved (0 pending)", { storyId: "_run", saved: 0, pending: 0 })`.
- [unit] When the host's `sync` rejects during `close()`, `close()` resolves.
- [unit] When the host's `sync` rejects with `new Error("down")` during `close()`, the logger receives `warn("run", "memory sync failed", { storyId: "_run", error: "down" })`.
- [unit] When the host's `sync` rejects during `close()`, the summary info line is still logged.
- [unit] A second `runMemory.close()` call does not call the host's `sync` again.
- [unit] A second `runMemory.close()` call logs no second summary line.

### US-005

- [unit] `createRuntime(config, workdir, { memory })` returns a runtime whose `memory` is that run memory.
- [unit] `createRuntime(config, workdir)` with no `memory` option returns a runtime with no `memory` key.
- [unit] `createRuntime(config, workdir, { memory })` returns `toolProviders` whose last entry is `memory.provider`.
- [unit] `createRuntime(config, workdir, { memory })` with `resources.skillsInRun: true` returns `toolProviders` whose ids end with `"nax-skills"` then `"nax-memory"`.
- [unit] `createRuntime(config, workdir)` with no `memory` option returns the same `toolProviders` ids as before this feature (no `"nax-memory"`).
- [unit] `runtime.close()` calls `memory.close()` exactly once.
- [unit] A second `runtime.close()` does not call `memory.close()` again.
- [unit] When `memory.close()` is pending, `runtime.close()` does not resolve before it resolves.
- [unit] When the runtime's MCP pool `close()` rejects, `runtime.close()` still calls `memory.close()` once.
- [unit] Importing the type `CreateRuntimeOptions` from `@/runtime` and passing `{ memory }` to `createRuntime` compiles and runs.

Verification note: `bun run typecheck` and `bun run check:file-sizes` pass with `src/runtime/index.ts` at or under 600 lines; `bun run check:import-cycles` passes (the runtime imports `RunMemory` as a type only).

### US-006

- [unit] `setupRun` in workflow mode with `dryRun: false` calls `_runSetupDeps.createRunMemory` once with `{ config, repoRoot: workdir }` from the run and a logger.
- [unit] `setupRun` passes the run memory `_runSetupDeps.createRunMemory` resolves as the `memory` option of `_runSetupDeps.createRuntime`.
- [unit] `setupRun` passes no `memory` key to `_runSetupDeps.createRuntime` when `_runSetupDeps.createRunMemory` resolves `undefined`.
- [unit] `setupRun` with `dryRun: true` does not call `_runSetupDeps.createRunMemory`.
- [unit] `setupRun` with `execution.mode: "pipeline"` does not call `_runSetupDeps.createRunMemory`.
- [unit] `setupRun` with `execution.mode: "pipeline"` passes no `memory` key to `_runSetupDeps.createRuntime`.
- [unit] `setupRun` calls `_runSetupDeps.createRunMemory` before `_runSetupDeps.createRuntime`.

### US-007

- [unit] `writeBrief(sc)` with `sc.callCtx.runtime.memory` a fake run memory whose `index()` resolves `"INDEX-LINE"` writes a brief file containing `memorySectionOf("INDEX-LINE")`.
- [unit] `writeBrief(sc)` with no `sc.callCtx.runtime.memory` writes a brief with no `## Memory` heading.
- [unit] `writeBrief(sc)` with a fake run memory whose `index()` resolves `undefined` writes a brief with no `## Memory` heading.
- [unit] `runBranchFix(fc, { findings })` with `fc.callCtx.runtime.memory` a fake run memory whose `index()` resolves `"INDEX-LINE"` sends `_workflowDeps.callOp` a prompt containing `memorySectionOf("INDEX-LINE")`.
- [unit] `runBranchFix(fc, { findings, kind: "repair", ciRepair: { round: 1 } })` with the same fake run memory sends `_workflowDeps.callOp` a prompt that starts with `You are repairing the CI of` and contains `memorySectionOf("INDEX-LINE")`.
- [unit] `runBranchFix(fc, { findings, prompt: "OWN PROMPT" })` with the same fake run memory sends `_workflowDeps.callOp` the prompt `"OWN PROMPT"` unchanged.
- [unit] `runBranchFix(fc, { findings, prompt: "OWN PROMPT" })` does not call the fake run memory's `index()`.
- [unit] `runBranchFix(fc, { findings })` with no `fc.callCtx.runtime.memory` sends `_workflowDeps.callOp` a prompt with no `## Memory` heading.
- [unit] `runBranchReview(fc, input)` with `fc.callCtx.runtime.memory` a fake run memory whose `index()` resolves `"INDEX-LINE"` sends `_workflowDeps.callOp` a prompt containing `buildMemoryReferenceSection("INDEX-LINE")`.
- [unit] `runBranchReview(fc, input)` with no `fc.callCtx.runtime.memory` sends `_workflowDeps.callOp` a prompt with no `## Memory` heading.
