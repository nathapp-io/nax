# SPEC: Chat workflow flow

Closes: #2927, #2928, #2931, #2945

## Summary

Fix the `nax chat` job-flow defects and add the workflow defaults the chat needs to drive a feature with few human steps. `nax-workflow__state` reports a not-started feature as a normal result instead of an error. The built-in general agent is reachable without a model string. A subagent is told which tools it has, and that a step it cannot do belongs in its final answer, not in a question to the person. An abandoned tool call records why its turn ended. A new `chat.workflow` config block sets the profiles for plan, run and bot launches, the bot model, the spec writer and spec reviewer, and the spec fix-round budget. The workflow instructions carry those values and name the feature-folder paths the spec steps write. Part of tracking issue #2946; #2930 is partly addressed (the turn-end reason is recorded; keeping a long subagent alive is deferred).

## Motivation

Driving a feature through `nax chat` hit these defects (v0.92.3):

- #2927: `nax-workflow__state` for a feature that has no spec yet returns `unknown feature <name>; known: <20 names>, +N more` as an error, so every new-feature conversation starts with a failed tool call and a list of unrelated names.
- #2928: `nax-agents__run` with no `agent` and no `model` fails with `[chat] run requires agent, or model to run the built-in general agent`, and `agent: "general"` fails with `unknown agent general`. The chat then picked the read-only `planner`, which could not write the spec and asked the human, twice, to enable write tools, although the parent chat had them.
- #2930: a long `code-reviewer` subagent run ended with `Tool "nax-agents__run" was abandoned: the turn ended.` and nothing says why the turn ended (user stop, turn deadline, session close).
- #2931: the chat never asks which profile `nax plan` / `nax run` use, or which agent and model write and review the spec, and there is no config to set them. The user sees the choice only on the approval card.
- #2945: the workflow instructions name no paths, so specs land in `docs/specs/`, and review reports, fix-round reports and hand-off notes pile up as extra files.

## Design

### Scope, approach and conventions

- All prompt text lives in `packages/nax/src/prompts/builders/` (project rule). New instruction text states facts the agent can use; it adds no new prohibitions.
- Config defaults live in the Zod schema. The new `chat` root key is optional with no root default, so `NaxConfigSchema.parse({})` and `DEFAULT_CONFIG` are unchanged.
- Instruction text builds the feature folder from `PROJECT_FEATURES_DIR` (exported from `@/config`) rather than a literal, so the path has one source (`check-feature-dir-ssot` exempts `src/prompts/`, so this is a choice, not a gate).
- Unknown-profile validation for `chat.workflow` profile names happens at launch, not at config load: profile discovery is repo-scoped and async, while config parsing is not. This replaces item 5 of the #2931 design sketch.

### Integration

Read-only (verified):

- `packages/nax/src/chat/workflow/feature-state.ts` — `FeatureStateOptions { repoRoot; outputDir }`, `FeatureState { name; spec; prd; run; workflow; branch; lastRunLog; warnings }`, `readFeatureState(feature, options)`.
- `packages/nax/src/chat/subagent-model.ts` — `resolveSubagentModel({ requested, parentModel, aliases, tiers })`: `requested === undefined` resolves `{ model: parentModel, source: "inherit" }`.
- `packages/nax/src/chat/subagent-tools.ts` — `mapSubagentTools(tools)` returns `{ allowedTools?: string[]; dropped }`; `allowedTools` is undefined when the agent declares no `tools`.
- `packages/nax-agent/src/session/agent-session-turn.ts` — the turn controller aborts with `abortReason(code, message)`, a `NaxError` whose `code` is `AGENT_SESSION_CANCELLED` (message: the cancel reason, default `cancelled`; `iterator closed`; `session closed`), `AGENT_SESSION_TURN_TIMEOUT` (`turn deadline`) or `AGENT_SESSION_CONSUMER_STALLED` (`consumer stalled`).
- `packages/nax/src/chat/jobs/job-argv.ts` — `parseJobInput(kind, raw)`, `buildJobArgv(input, ctx)`, `JobLaunchInput` (every kind carries `profiles: readonly string[]`; bot kinds carry optional `model`).
- `packages/nax/src/config/profile.ts` — `listProfiles(repoRoot)` (via `@/config`).

The baseline signatures below only locate the code; implement the target.

- `readState` in `packages/nax/src/chat/workflow/workflow-provider.ts`
  - Baseline: when neither the feature directory nor `.nax/specs/<feature>.md` exists, returns `failure(\`unknown feature ${feature}; known: ${available}${suffix}\`)`.
  - Target: returns a non-error `NotStartedFeature` JSON result (see below).
- `createWorkflowProvider`
  - Baseline: `createWorkflowProvider(options: FeatureStateOptions): ToolProvider`, `instructions: async () => buildWorkflowInstructions()`.
  - Target: `createWorkflowProvider(options: WorkflowProviderOptions): ToolProvider` where `interface WorkflowProviderOptions extends FeatureStateOptions { readonly workflow?: ChatWorkflowConfig }`, and `instructions: async () => buildWorkflowInstructions({ workflow: options.workflow })`.
- `buildWorkflowInstructions` in `packages/nax/src/prompts/builders/workflow-builder.ts`
  - Baseline: `buildWorkflowInstructions(): string`, fixed text.
  - Target: `buildWorkflowInstructions(input?: { readonly workflow?: ChatWorkflowConfig }): string`. With no input, or no `workflow`, the output is today's text unchanged, followed by the paths line and the choices line (Design, Workflow instructions, items 3 and 6).
- `targetOf` / `RunTarget` in `packages/nax/src/chat/agents-provider.ts`
  - Baseline: `{ kind: "general"; task; model: string }`; no agent and no model is the `NO_TARGET` failure.
  - Target: `{ kind: "general"; task; model?: string }`; `targetOf` returns the general target when `agent` is absent (with or without `model`); `NO_TARGET` is deleted. The provider's `run` resolves `agent: "general"`: `catalog.findAgent("general")` first, and the built-in general agent when that finds nothing.
- `SubagentRuns.modelFor(agentName, override)` in `packages/nax/src/chat/subagent-runs.ts`
  - Baseline: an absent `agentName` is the general agent; any other name is a catalog lookup.
  - Target: `"general"` with no catalog agent of that name is also the general agent.
- `agentRunCall` in `packages/nax/src/chat/agent-call-model.ts`
  - Baseline: a `nax-agents__run` call with no `agent` and no `model` returns undefined, so its tool card carries no model.
  - Target: with no `agent` and no `model` key it returns `{ agent: undefined, override: undefined }`, so the card shows the general agent's inherited model. A present but non-string `model` (or `agent`) still returns undefined: a malformed call is not annotated.
- `buildAgentsInstructions` in `packages/nax/src/prompts/builders/agents-builder.ts`
  - Baseline: `buildAgentsInstructions(entries: readonly { qualifiedName: string; description: string }[]): string`; third line `To run a task on a model when no agent fits, omit agent and pass model; the task runs on the built-in general agent.`; entry lines `- <name>: <description>`.
  - Target: `buildAgentsInstructions(entries: readonly { qualifiedName: string; description: string; tools?: readonly string[] }[]): string`; third line `When no agent fits, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model.`; an entry with `tools` renders `- <name>: <description> (tools: <tools joined by ", ">)`, the agent file's `tools` as written; an entry with `tools: []` renders `(tools: none)`.
- `buildSubagentInstructions` in the same file
  - Baseline: `SubagentInstructionsInput { agent; mode; rulesIndex; memoryIndex? }`; sections: permission paragraph, rules index, memory, agent prompt.
  - Target: `SubagentInstructionsInput` gains `readonly allowedTools?: readonly string[]`; when defined, a tools section is placed directly before the agent prompt. Its first sentence is `Your tools in this run: <allowedTools joined by ", ">, plus the always-on scratchpad tools.` (entries, including patterns such as `nax-skills__*`, rendered as given), or `Your tools in this run: only the always-on scratchpad tools.` for `[]`. Its second sentence is `The agent that called you has its own tools; a step your tools cannot do goes in your final answer, with what is left and the path of any draft, rather than in a question to the person.`
- `RUN_DESCRIPTION` in `packages/nax/src/chat/agents-provider.ts`
  - Baseline last sentence: `To run a task on a model with no catalog agent, omit agent and pass model: the task runs on the built-in general agent with your tools.`
  - Target last sentence: `To run a task with no catalog agent, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model.`
- `invoke` / `runCodingTool` abandoned results in `packages/nax-agent/src/session/session-interaction.ts`
  - Baseline: `Tool "${name}" was abandoned: the turn ended.`
  - Target: `abandonedToolMessage(name, signal)`; see US-004.
- `JobsProviderOptions` in `packages/nax/src/chat/jobs/jobs-provider.ts`
  - Target: gains `readonly workflow?: ChatWorkflowConfig`; `createHostJobs` passes `options.config.chat?.workflow`.
- `buildJobsInstructions` line 7 in `packages/nax/src/prompts/builders/workflow-builder.ts`
  - Baseline: `Leave profiles empty to use the profile the PRD was planned with; the approval card names it. Pass profiles only to override, with names from \`nax-jobs__list\`.`
  - Target: `Leave profiles empty to use the profile the PRD was planned with, unless chat.workflow sets profiles for that step, which then apply; the approval card names them. Pass profiles only to override, with names from \`nax-jobs__list\`.` The prefix is kept, so the existing `toContain` assertion still holds.
- `PROFILES_SCHEMA.description`
  - Target: `Config profiles for this job, applied in order. Omit it to use chat.workflow's profiles for this step when configured, else the profile the PRD was planned with (run) or the default config; pass it only to override. nax-jobs__list returns the available names.`
- `NaxConfig` in `packages/nax/src/config/runtime-types.ts`
  - Target: gains `chat?: import("./runtime-types-chat").ChatConfig`.

### New identifiers

```typescript
// packages/nax/src/chat/workflow/similar-features.ts
export const MAX_SIMILAR_FEATURES = 3;
/** Known names within Levenshtein distance max(2, floor(name.length / 4)) of `name` (case-sensitive, over the names as given), closest first, ties by name; at most MAX_SIMILAR_FEATURES. */
export function similarFeatureNames(name: string, known: readonly string[]): string[];

// packages/nax/src/chat/workflow/workflow-provider.ts — the not-started result body
interface NotStartedFeature {
  readonly name: string;
  readonly stage: "not-started";
  readonly spec: null;
  readonly prd: null;
  readonly similar: readonly string[];
}

// packages/nax-agent/src/session/session-interaction.ts (module export, used by both abandoned paths)
export function abandonedToolMessage(name: string, signal: AbortSignal): string;

// packages/nax/src/config/schemas-chat.ts
export const DEFAULT_SPEC_FIX_ROUNDS = 2;
export const ChatConfigSchema: z.ZodType; // { workflow?: ChatWorkflowConfig }

// packages/nax/src/config/runtime-types-chat.ts
export interface ChatStepConfig { readonly profiles?: readonly string[] }
export interface ChatBotStepConfig extends ChatStepConfig { readonly model?: string }
export interface ChatAgentChoice { readonly agent?: string; readonly model?: string }
export interface ChatWorkflowConfig {
  readonly plan?: ChatStepConfig;
  readonly run?: ChatStepConfig;
  readonly botReview?: ChatBotStepConfig;
  readonly botFix?: ChatBotStepConfig;
  readonly specWriter?: ChatAgentChoice;
  readonly specReviewer?: ChatAgentChoice;
  readonly specFixRounds: number;
}
export interface ChatConfig { readonly workflow?: ChatWorkflowConfig }

// packages/nax/src/chat/jobs/workflow-defaults.ts
export interface WorkflowDefaultsApplied<T> {
  readonly input: T;
  /** e.g. "chat.workflow.plan"; present only when profiles came from config. */
  readonly profilesFrom?: string;
  /** e.g. "chat.workflow.botReview"; present only when the model came from config. */
  readonly modelFrom?: string;
}
export function applyWorkflowDefaults<T extends { readonly kind: ChatJobKind; readonly profiles: readonly string[]; readonly model?: string }>(
  input: T,
  workflow: ChatWorkflowConfig | undefined,
): WorkflowDefaultsApplied<T>;
/** Separate from `_jobsProviderDeps.listProfileNames` (which stays for `nax-jobs__list`); same body. */
export const _workflowDefaultsDeps: { listProfileNames: (repoRoot: string) => Promise<readonly string[]> };
export function unknownWorkflowProfile(applied: WorkflowDefaultsApplied<{ readonly profiles: readonly string[] }>, repoRoot: string): Promise<string | undefined>;
```

### `chat.workflow` config

```json
{
  "chat": {
    "workflow": {
      "plan": { "profiles": ["codex-plan", "cc-acceptance"] },
      "run": { "profiles": ["codex-review"] },
      "botReview": { "profiles": [], "model": "openai-codex/gpt-6.1-sol" },
      "botFix": { "model": "openai-codex/gpt-6.1-sol" },
      "specWriter": { "agent": "general", "model": "openai-codex/gpt-6.1-sol" },
      "specReviewer": { "agent": "code-reviewer" },
      "specFixRounds": 2
    }
  }
}
```

- Every field is optional; `specFixRounds` defaults to `DEFAULT_SPEC_FIX_ROUNDS` (2) once `workflow` is present, and is an integer from 1 to 10.
- A profile name must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; a model must match `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` (the patterns `job-argv.ts` already applies to launch input). `agent` is a non-empty string.
- The block can be set in global, project or profile config; `nax chat --profile <name>` already overlays a profile, so a profile that sets `chat.workflow` selects these values for the session. Arrays are replaced by a later layer, as `deepMergeConfig` already does.
- An empty `profiles` array means not set.

Step key per launch kind: `plan` -> `plan`; `run` and `finish` -> `run`; `bot_review` -> `botReview`; `bot_fix` -> `botFix`.

### Launch defaults and the approval card

`applyWorkflowDefaults(input, workflow)`, a pure function, in this order:

1. When `input.profiles` is non-empty, profiles are left as passed (the chat request wins).
2. Otherwise, when the step's `profiles` is non-empty, `input.profiles` becomes that list and `profilesFrom` is `chat.workflow.<stepKey>`.
3. For bot kinds only: when `input.model` is undefined and the step's `model` is set, `input.model` becomes it and `modelFrom` is `chat.workflow.<stepKey>`. Rules 1-2 and rule 3 are independent: a launch can take profiles from the request and the model from config.
4. For `run` and `finish`, the existing rule "no profiles -> the PRD's planned profile" applies only when steps 1-2 leave `profiles` empty.

`launchJob` (`jobs-launch.ts`) applies it after `parseJobInput` and before `prepareTarget`. `resolveStepTarget` (`chain-tools.ts`) applies it to each chain step before `buildChainStepArgv`, so a chain card's argv and the step's later launch argv agree.

`workflow-defaults.ts` also exports `unknownWorkflowProfile(applied, repoRoot): Promise<string | undefined>`. When `applied.profilesFrom` is set it lists the known names through its own `_workflowDefaultsDeps.listProfileNames` (global and project names from `listProfiles`, deduplicated and sorted; a leaf dep, so `jobs-launch.ts` takes no value import from `jobs-provider.ts` and no import cycle forms) and returns `[chat] <profilesFrom>.profiles names unknown profile <name>; known: <names joined by ", ">` for the first unknown name, else undefined. `launchJob` runs it after `prepareTarget` (so a missing spec or PRD is reported first) and returns its message as an error before any card. `resolveStepTarget` returns it as `stepError(step, message)` before the chain card. Explicitly passed names keep today's behaviour.

A `run` whose profiles come from `chat.workflow.run` and differ from the PRD's planned profile shows the existing warning `the PRD was planned with profile <planned>, not <profiles>`, as an explicit request does today.

Card lines: when `profilesFrom` is set, the profiles line reads `profiles <names joined by ", "> (<profilesFrom>)`; when `modelFrom` is set, a detail line `model <model> (<modelFrom>)` is added. Unset config leaves today's lines byte-for-byte.

### Workflow instructions

`buildWorkflowInstructions({ workflow })` keeps every existing line and its order, edits lines 1 and 2 in place, and appends the new lines after the existing last line, in the order 3, 4, 5, 6. `N` is `workflow?.specFixRounds ?? DEFAULT_SPEC_FIX_ROUNDS`, written as an English word for 1-10 (`one` ... `ten`), capitalised at the start of a sentence.

1. Loop line: `spec-review (usually two fix rounds)` becomes `spec-review (usually <N> fix rounds)`.
2. Budget line: `Two spec-review fix rounds are the default budget, not a limit: past two, ...` becomes `<N> spec-review fix rounds are the default budget, not a limit: past <N>, ...`; the rest of the line is unchanged.
3. New paths line, always present: ``The spec for a feature is `<PROJECT_FEATURES_DIR>/<feature>/spec.md`, which is where the plan launch reads it. Spec-review findings and fixes stay in this chat and in the spec itself, so a spec round writes no report file; the PRD fidelity check (spec-review --prd) writes `<PROJECT_FEATURES_DIR>/<feature>/prd-fidelity-report.md`.``
4. New spec-agents line, only when `specWriter` or `specReviewer` is set (a choice with neither `agent` nor `model`, such as `{}`, counts as unset): `Spec-writing runs through nax-agents__run with <choice of specWriter>; spec-review runs with <choice of specReviewer> (chat.workflow).` A choice renders as `agent <agent>` and/or `model <model>` joined by ` and `; an unset choice renders `the agent you choose`; a choice with only `model` names `agent general`.
5. New profiles line, only when `plan.profiles` or `run.profiles` is non-empty: `chat.workflow sets the profiles for nax plan (<names>) and nax run (<names>); leave profiles empty on those launches and the card names them.` A step without profiles is omitted from the sentence. This line never names `nax bot review` or `nax bot fix`, so the one line that names all four billed commands stays unique.
6. New choices line, only when at least one of `plan.profiles`, `run.profiles`, `specWriter`, `specReviewer` is unset: `In this chat, where chat.workflow does not set them, the plan and run profiles and the spec writer and reviewer are the user's choice: nax-jobs__list returns the profile names; ask for the spec writer and reviewer when you propose spec-writing, and for the profiles in the same message that asks for plan approval.`

`cli/chat.ts` passes `workflow: config.chat?.workflow` to `createWorkflowProvider`.

### Not-started result

The not-started result is a different shape from `FeatureState` on purpose: `stage: "not-started"` is the field that tells the agent the feature has no artifacts yet, and `spec`/`prd` are null as in `FeatureState`.

### Abandoned tool message

`abandonedToolMessage(name, signal)`:

- `signal.reason` is a `NaxError`: `Tool "<name>" was abandoned: the turn ended (<code>: <message>).`
- otherwise (a bare `abort()`, a non-`NaxError` reason): `Tool "<name>" was abandoned: the turn ended.` (today's text).

`invoke` and `runCodingTool` build their abandoned result from it, using the signal the call raced (`request.signal ?? deps.turnSignal()` / `ctx.signal`).

Which aborts carry a reason: the session turn controller (`agent-session-turn.ts`) aborts with a `NaxError` for a cancel (`AgentSession.cancel`, default reason `cancelled`; the chat's Esc goes through it), the session turn deadline, a stalled consumer and an iterator close; `AbortSignal.any` keeps the reason of the source that aborted first. The native adapter's own idle watchdog and whole-turn deadline (`native/session-adapter.ts`) abort with no reason and keep today's text; this is why #2930 is only partly addressed.

### Failure handling

| Case | Behaviour |
|:--|:--|
| `nax-workflow__state` on a valid but absent feature | Non-error `NotStartedFeature` result |
| `nax-workflow__state` with an invalid feature name | Unchanged: validation error result |
| `nax-agents__run` with `agent: "general"` and a catalog agent named `general` | Runs the catalog agent (a discovered agent wins) |
| `chat.workflow` with an invalid profile name, model, agent or `specFixRounds` | Config parse fails with a Zod issue at that path |
| A config-supplied profile name not in `listProfileNames` | Launch error naming it and the known names; no card |
| Abort reason not a `NaxError` | Today's abandoned text |

## Out of Scope

- Keeping a long subagent run alive after its parent turn ends, or moving it to a background task (#2930 second half); this feature only records why the turn ended.
- The ACP twin of the abandoned message (`packages/nax-agent-acp/src/client/tool-calls.ts`) keeps today's text.
- Loading a flow profile mid-session from a chat message ("use flow profile X"); a profile is selected with `nax chat --profile`.
- Validating `chat.workflow` profile names at config load.
- Running the general agent when the catalog has no agents (the agents provider advertises no tool then).
- Moving or renaming existing specs under `docs/specs/` or existing `prd-fidelity-review.md` files.
- Changing the spec-writing or spec-review skills themselves.
- Classifying a subagent's question as a tooling blocker and rerouting it; the subagent is told its tools instead.
- `finish` has no `chat.workflow` key of its own; it uses `run`.
- `nax agents run` (`cli/agents-run-compose.ts`) creates its workflow provider without `chat.workflow`; it gets the default instructions only.
- Attaching an abort reason to the native adapter's own idle watchdog and whole-turn deadline in `native/session-adapter.ts`.

## Stories

### US-001 — Not-started feature state

Workdir: packages/nax

No dependencies.

`nax-workflow__state` for a valid feature name with no feature directory and no legacy spec returns a non-error JSON result `{ name, stage: "not-started", spec: null, prd: null, similar }`, where `similar` holds at most three close matches from the known feature directories. The long known-feature list is no longer returned.

### US-002 — General agent reachable on the chat model, agent tools in the index

Workdir: packages/nax

No dependencies.

`nax-agents__run` with no `agent` and no `model` runs the built-in general agent on the chat's current model. `agent: "general"` is the built-in general agent unless the catalog has an agent of that name. `modelFor("general")` follows the same rule. The tool description and the agents index say so, and each index entry for an agent that declares `tools` lists them. Doc comments that say the general agent needs a model (`subagent-runs.ts` `modelFor`, `agent-call-model.ts`, `builtin-agent.ts`, the `RunTarget` comment) and `GENERAL_AGENT_DESCRIPTION` are updated to say it runs on the caller's model unless one is passed.

### US-003 — Subagent told its tools

Workdir: packages/nax

Depends on US-002.

A nested native subagent whose agent declares `tools` receives a tools section in its instructions: the tools it has in this run (plus the always-on scratchpad tools), and the fact that a step those tools cannot do goes in its final answer (what is left and where its draft is) for the calling agent, rather than in a question to the person.

### US-004 — Abandoned tool result names the turn-end reason

Workdir: packages/nax-agent

No dependencies.

`abandonedToolMessage` appends the abort reason's code and message when the signal's reason is a `NaxError`, and both abandoned paths in `session-interaction.ts` use it.

### US-005 — `chat.workflow` config block

Workdir: packages/nax

No dependencies.

Add `schemas-chat.ts` with `ChatConfigSchema` and `DEFAULT_SPEC_FIX_ROUNDS`, the optional root `chat` key on `NaxConfigSchema`, `runtime-types-chat.ts`, and `chat?` on `NaxConfig`. Export `DEFAULT_SPEC_FIX_ROUNDS` from `src/config/index.ts` and the chat types from `src/config/types.ts` (and the barrel), as `bot` is. `NaxConfigSchema.parse({})` stays unchanged.

### US-006 — Launch defaults from `chat.workflow`

Workdir: packages/nax

Depends on US-005.

Add `applyWorkflowDefaults` and `unknownWorkflowProfile`, apply them in `launchJob` and in chain step resolution, and show the config source on the approval card. `createHostJobs` passes `config.chat?.workflow`; `PROFILES_SCHEMA` and `buildJobsInstructions` line 7 describe the default.

### US-007 — Workflow instructions carry `chat.workflow` and the feature-folder paths

Workdir: packages/nax

Depends on US-005.

`buildWorkflowInstructions` takes `{ workflow }` and renders the fix-round budget, the spec agents, the configured profiles, the user-choice line and the paths line. `createWorkflowProvider` takes `workflow` and `cli/chat.ts` passes `config.chat?.workflow`.

### Context Files

**US-001**
- `packages/nax/src/chat/workflow/workflow-provider.ts` — the provider to change
- `packages/nax/src/chat/workflow/feature-state.ts` — `FeatureState` shape the result mirrors
- `packages/nax/test/unit/chat/workflow/workflow-provider.test.ts` — existing tests

**US-002**
- `packages/nax/src/chat/agents-provider.ts` — `targetOf`, `RUN_DESCRIPTION`
- `packages/nax/src/chat/subagent-runs.ts` — `modelFor`, `resolveFor`
- `packages/nax/src/chat/builtin-agent.ts` — `generalAgent`, `GENERAL_AGENT_NAME`
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildAgentsInstructions`
- `packages/nax/test/unit/chat/agents-provider.test.ts` — existing dispatch tests

**US-003**
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildSubagentInstructions`
- `packages/nax/src/chat/subagent-session.ts` — where nested instructions are built
- `packages/nax/src/chat/subagent-runs.ts` — where `allowedTools` is mapped
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` — existing builder tests
- `packages/nax/test/unit/chat/subagent-session.test.ts` — nested session option tests

**US-004**
- `packages/nax-agent/src/session/session-interaction.ts` — both abandoned paths
- `packages/nax-agent/src/session/agent-session-turn.ts` — abort reasons
- `packages/nax-agent/test/unit/session/session-interaction-cancel-grace.test.ts` — abandoned-result tests

**US-005**
- `packages/nax/src/config/schemas.ts` — root schema
- `packages/nax/src/config/schemas-bot.ts` — small sub-schema pattern to mirror
- `packages/nax/src/config/runtime-types.ts` — `NaxConfig`
- `packages/nax/src/config/runtime-types-bot.ts` — runtime type pattern

**US-006**
- `packages/nax/src/chat/jobs/jobs-launch.ts` — `launchJob`, `launchReason`, `prepareRun`
- `packages/nax/src/chat/jobs/chain-tools.ts` — `resolveStepTarget`
- `packages/nax/src/chat/jobs/jobs-provider.ts` — `JobsProviderOptions`, `PROFILES_SCHEMA`, `listProfileNames`
- `packages/nax/src/chat/jobs/jobs-host.ts` — `createHostJobs`
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — card tests

**US-007**
- `packages/nax/src/prompts/builders/workflow-builder.ts` — `buildWorkflowInstructions`
- `packages/nax/src/chat/workflow/workflow-provider.ts` — `createWorkflowProvider`
- `packages/nax/src/cli/chat.ts` — provider composition
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts` — existing instruction tests

### Creates

**US-001**
- `packages/nax/src/chat/workflow/similar-features.ts` — `similarFeatureNames`

**US-005**
- `packages/nax/src/config/schemas-chat.ts` — `ChatConfigSchema`, `DEFAULT_SPEC_FIX_ROUNDS`
- `packages/nax/src/config/runtime-types-chat.ts` — chat config runtime types

**US-006**
- `packages/nax/src/chat/jobs/workflow-defaults.ts` — `applyWorkflowDefaults`, `unknownWorkflowProfile`, `_workflowDefaultsDeps`, `WorkflowDefaultsApplied`

### Modifies

**US-001**
- `packages/nax/test/unit/chat/workflow/workflow-provider.test.ts` — the tests "AC-11 unknown feature without feature tree" (`:136-138`), "does not suggest directories rejected by the feature path validator" (`:204-208`), "AC-15 sorts known directory names" (`:216-219`) and "AC-23 bounds valid known directories to 20" (`:240-249`) assert the `unknown feature <name>; known: ...` error. Under US-001 a valid absent feature is a non-error `NotStartedFeature` result, so these assertions fail against a correct implementation. Replace them with the new invariants: the result is not an error, `stage` is `not-started`, and `similar` lists only valid close matches (never a directory the feature-name validator rejects).

**US-002**
- `packages/nax/test/unit/chat/agents-provider.test.ts` — the `RUN_DESCRIPTION` constant (`:251-252`) pins the old last sentence, and "AC-6 a missing agent and a missing model names both requirements" (`:281-284`) and "AC-7 ... does not call the injected run" (`:286-290`) assert the deleted `NO_TARGET` error through the `NEEDS_AGENT_OR_MODEL` constant (`:253`). Under US-002 the description has the new last sentence and a call with no agent and no model runs the general agent. Update `RUN_DESCRIPTION` to the target text, replace AC-6/AC-7 with: the injected run is called once with the general agent and no model, and delete the now-unused `NEEDS_AGENT_OR_MODEL`.
- `packages/nax/test/unit/chat/agent-call-model.test.ts` — "AC-17 an absent agent and model forwards the event unchanged" (`:85-89`) and "AC-18 an absent agent and model does not call modelFor" (`:91-95`) assert a bare `{ task }` call is not annotated. Under US-002 that call runs the general agent on the parent model, so it is annotated. Replace them with: the call is annotated with `modelFor(undefined, undefined)`'s model and label.
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` — "AC-3 US-002: the third line names the general-agent fallback" (`:78-83`) pins the old third line. Update it to the target third line from Design; the other line assertions in that file are unchanged.

**US-003**

None. `buildSubagentInstructions` output is unchanged when `allowedTools` is undefined, which is every existing test's input.

**US-004**

None. Existing tests abort with a bare `controller.abort()`, whose reason is not a `NaxError`, so they keep today's text.

**US-005**

None. The `chat` key has no root default, so `DEFAULT_CONFIG` and `NaxConfigSchema.parse({})` keep their key sets.

**US-006**

None. With no `workflow` option every existing launch, chain and card test sees today's behaviour, and the edited `buildJobsInstructions` line 7 keeps the prefix `workflow-builder-chain.test.ts` asserts with `toContain`.

**US-007**
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts` — the test "US-004 AC-11 retains the original lines, the fix-budget line (#2929), then the repo line" (`:219-232`) asserts `buildWorkflowInstructions()` is exactly the six current lines. Under US-007 the no-input output is those six lines followed by the paths line and the choices line, so the exact-text assertion fails against a correct implementation. US-007 owns rewriting it to the new invariant: the first six lines are unchanged and in order, followed by the paths line, then the choices line. The other tests in that file keep passing: with no input the existing lines keep their order; the paths and choices lines are appended after the last one, so the loop-order test still finds `spec-review`, `nax plan`, `nax run` and `nax bot fix` first in the loop line, and neither added line names all four billed commands or a cap word.

### Seams

- US-006 consumes `ChatWorkflowConfig` (US-005) through `JobsProviderOptions.workflow`; its seam ACs enter at the `nax-jobs__plan` tool run and the `nax-jobs__chain` tool run.
- US-007 consumes `ChatWorkflowConfig` (US-005); its seam AC enters at the workflow provider's `instructions()`.
- US-003: `runNested` already passes `allowedTools` to `runSubagent`; US-003 threads it from `subagentSessionOptions` into `buildSubagentInstructions`; its seam AC enters at `runSubagent` and observes `_subagentSessionDeps.createAgentSession`.

## Acceptance Criteria

### US-001

- [unit] `similarFeatureNames("chat-job-flow", ["chat-job-flows", "review-and-gate-guards"])` returns `["chat-job-flows"]`.
- [unit] `similarFeatureNames` returns names closest first, ordering equal distances by name.
- [unit] `similarFeatureNames` returns at most `MAX_SIMILAR_FEATURES` (3) names when more are within the distance bound.
- [unit] `similarFeatureNames("abc", ["xyz-long-name"])` returns `[]` when no name is within edit distance `max(2, floor(name.length / 4))`.
- [unit] The `nax-workflow__state` tool run with `feature: "nope"` and no feature tree returns a result whose `isError` is not `true`.
- [unit] The `nax-workflow__state` tool run with `feature: "nope"` and no feature tree returns JSON `{ "name": "nope", "stage": "not-started", "spec": null, "prd": null, "similar": [] }`.
- [unit] The `nax-workflow__state` tool run for an absent feature `f11` with feature directories `f1`, `f2` and `review-and-gate-guards` returns `similar` equal to `["f1", "f2"]`.
- [unit] The `nax-workflow__state` tool run for an absent feature never includes a feature directory rejected by `validateFeatureName` in `similar`.
- [unit] The `nax-workflow__state` tool run with an invalid feature name `../etc` still returns an error result.

### US-002

- [unit] The `nax-agents__run` tool run with `{ task: "t" }` calls the injected run once with an agent whose `name` is `general` and `origin` is `{ kind: "nax-builtin" }`.
- [unit] The `nax-agents__run` tool run with `{ task: "t" }` calls the injected run with an undefined model argument.
- [unit] The `nax-agents__run` tool run with `{ agent: "general", task: "t" }` and no catalog agent named `general` calls the injected run with the built-in general agent.
- [unit] The `nax-agents__run` tool run with `{ agent: "general", task: "t", model: "openai-codex/gpt-6-luna" }` and no catalog agent named `general` calls the injected run with model `openai-codex/gpt-6-luna`.
- [unit] The `nax-agents__run` tool run with `{ agent: "general", task: "t" }` and a catalog agent named `general` calls the injected run with that catalog agent.
- [unit] The `nax-agents__run` tool description equals the target `RUN_DESCRIPTION` whose last sentence is `To run a task with no catalog agent, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model.`
- [unit] `createSubagentRuns(...).modelFor("general")` with no catalog agent named `general` returns the parent model with label `inherited`.
- [unit] `createSubagentRuns(...).run(generalAgent(), "t")` with no model passes `_subagentRunsDeps.runSubagent` a `model` equal to `current().model`.
- [unit] `buildAgentsInstructions` returns as its third line `When no agent fits, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model.`
- [unit] `buildAgentsInstructions([{ qualifiedName: "planner", description: "Plans", tools: ["Read", "Grep", "Glob"] }])` renders the entry line `- planner: Plans (tools: Read, Grep, Glob)`.
- [unit] `buildAgentsInstructions([{ qualifiedName: "reviewer", description: "Reviews diffs" }])` renders the entry line `- reviewer: Reviews diffs` for an entry with no `tools`.
- [unit] The agents provider `instructions()` for a catalog agent with `tools: ["Read"]` contains the entry line ending `(tools: Read)`.
- [unit] `buildAgentsInstructions([{ qualifiedName: "bare", description: "No tools", tools: [] }])` renders the entry line `- bare: No tools (tools: none)`.
- [unit] `withAgentCallModel` for a `nax-agents__run` call with input `{ task: "t" }` calls `modelFor(undefined, undefined)` and annotates the forwarded event with its model.
- [unit] `withAgentCallModel` for a `nax-agents__run` call with input `{ task: "t", model: 7 }` forwards the event unchanged without calling `modelFor`.

### US-003

- [unit] `buildSubagentInstructions({ agent, mode: "guarded", rulesIndex: [], allowedTools: ["Read", "Grep"] })` contains `Your tools in this run: Read, Grep, plus the always-on scratchpad tools.`
- [unit] `buildSubagentInstructions` with `allowedTools: []` contains `Your tools in this run: only the always-on scratchpad tools.`
- [unit] `buildSubagentInstructions` with `allowedTools: ["nax-skills__*"]` renders the pattern `nax-skills__*` as given in the tools sentence.
- [unit] `buildSubagentInstructions` with `allowedTools` places the tools section directly before the agent prompt.
- [unit] `buildSubagentInstructions` with `allowedTools` contains `The agent that called you has its own tools; a step your tools cannot do goes in your final answer, with what is left and the path of any draft, rather than in a question to the person.`
- [unit] `buildSubagentInstructions` with `allowedTools` undefined returns the same text as before this feature (permission paragraph, rules index, memory, agent prompt).
- [unit] `runSubagent` with `allowedTools: ["Read", "Grep", "Glob"]` calls `_subagentSessionDeps.createAgentSession` with options whose `instructions` contain the tools section naming `Read, Grep, Glob`.
- [unit] `runSubagent` with `allowedTools` undefined calls `_subagentSessionDeps.createAgentSession` with options whose `instructions` contain no tools section.

### US-004

- [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with `new NaxError("turn deadline", "AGENT_SESSION_TURN_TIMEOUT")` returns `Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_TURN_TIMEOUT: turn deadline).`
- [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with `new NaxError("cancelled", "AGENT_SESSION_CANCELLED")` returns `Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).`
- [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with no reason returns `Tool "acme__put" was abandoned: the turn ended.`
- [unit] `abandonedToolMessage("acme__put", signal)` for a signal aborted with a plain `Error` reason returns `Tool "acme__put" was abandoned: the turn ended.`
- [unit] An embedder tool still running when its turn signal aborts with `AGENT_SESSION_TURN_TIMEOUT` yields the error result `Tool "<name>" was abandoned: the turn ended (AGENT_SESSION_TURN_TIMEOUT: turn deadline).` through `createSessionInteractionHandler`.
- [unit] A coding tool still running when its turn signal aborts with `AGENT_SESSION_CANCELLED` yields the error message `Tool "<name>" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).` through `createSessionInteractionHandler`.
- [integration] An `AgentSession` from `createAgentSession` whose turn is running an embedder tool that never settles, when `session.cancel()` is called, ends the turn with that tool's result `Tool "<name>" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).`

### US-005

- [unit] `NaxConfigSchema.parse({})` returns a config with no `chat` key.
- [unit] `NaxConfigSchema.parse({ chat: { workflow: {} } })` resolves `chat.workflow.specFixRounds` to `DEFAULT_SPEC_FIX_ROUNDS` (2).
- [unit] `NaxConfigSchema.parse` keeps `chat.workflow.plan.profiles` equal to `["codex-plan", "cc-acceptance"]` when given that list.
- [unit] `NaxConfigSchema.parse` keeps `chat.workflow.botReview.model` equal to `openai-codex/gpt-6.1-sol` when given it.
- [unit] `NaxConfigSchema.parse` keeps `chat.workflow.specWriter` equal to `{ agent: "general", model: "openai-codex/gpt-6.1-sol" }` when given it.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.plan.profiles.0` for the profile name `-bad`.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.botFix.model` for the model `bad model`.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.specFixRounds` for `0`.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.specFixRounds` for `11`.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.specFixRounds` for `2.5`.
- [unit] `NaxConfigSchema.safeParse` fails with an issue at path `chat.workflow.specReviewer.agent` for an empty string.
- [unit] Merging a profile layer `{ chat: { workflow: { plan: { profiles: ["b"] } } } }` over a project layer with `plan.profiles` `["a", "c"]` through `deepMergeConfig` yields `["b"]`.

### US-006

- [unit] `applyWorkflowDefaults` for a `plan` input with empty `profiles` and `workflow.plan.profiles` `["p1", "p2"]` returns `input.profiles` `["p1", "p2"]`.
- [unit] `applyWorkflowDefaults` for a `plan` input with empty `profiles` and `workflow.plan.profiles` `["p1"]` returns `profilesFrom` `chat.workflow.plan`.
- [unit] `applyWorkflowDefaults` for a `plan` input with `profiles` `["x"]` returns `input.profiles` `["x"]` and no `profilesFrom`.
- [unit] `applyWorkflowDefaults` for a `finish` input with empty `profiles` takes `workflow.run.profiles` and returns `profilesFrom` `chat.workflow.run`.
- [unit] `applyWorkflowDefaults` for a `bot_fix` input with no `model` and `workflow.botFix.model` `openai-codex/gpt-6.1-sol` returns that `input.model` and `modelFrom` `chat.workflow.botFix`.
- [unit] `applyWorkflowDefaults` for a `bot_review` input with `model` `m/explicit` returns `input.model` `m/explicit` and no `modelFrom`.
- [unit] `applyWorkflowDefaults` for a `bot_review` input with `profiles` `["x"]`, no `model`, and `workflow.botReview` `{ profiles: ["y"], model: "m/conf" }` returns profiles `["x"]` and model `m/conf`.
- [unit] `applyWorkflowDefaults` with `workflow` undefined returns the input unchanged with neither `profilesFrom` nor `modelFrom`.
- [unit] `applyWorkflowDefaults` for a `plan` input with empty `profiles` and `workflow.plan.profiles` `[]` returns empty profiles and no `profilesFrom`.
- [integration] The `nax-jobs__plan` tool run with no `profiles`, `JobsProviderOptions.workflow.plan.profiles` `["p1", "p2"]` and both names returned by `_workflowDefaultsDeps.listProfileNames` calls `approve` with a `command` containing `--profile p1 --profile p2`.
- [integration] The same `nax-jobs__plan` tool run calls `approve` with a `reason` whose profiles line is `profiles p1, p2 (chat.workflow.plan)`.
- [integration] The `nax-jobs__plan` tool run with `profiles: ["x"]` and `workflow.plan.profiles` `["p1"]` calls `approve` with a `command` containing `--profile x` and not `--profile p1`.
- [integration] The `nax-jobs__bot_fix` tool run with no `model` and `workflow.botFix.model` `openai-codex/gpt-6.1-sol` calls `approve` with a `reason` containing the line `model openai-codex/gpt-6.1-sol (chat.workflow.botFix)`.
- [unit] `unknownWorkflowProfile` for an applied result with `profilesFrom` `chat.workflow.plan` and profiles `["p1", "ghost"]`, with `_workflowDefaultsDeps.listProfileNames` returning `["p1"]`, returns `[chat] chat.workflow.plan.profiles names unknown profile ghost; known: p1`.
- [unit] `unknownWorkflowProfile` for an applied result with no `profilesFrom` returns undefined without calling `_workflowDefaultsDeps.listProfileNames`.
- [integration] The `nax-jobs__plan` tool run with no `profiles` and `workflow.plan.profiles` `["ghost"]` not among the names `_workflowDefaultsDeps.listProfileNames` returns gives the error `[chat] chat.workflow.plan.profiles names unknown profile ghost; known: <known names joined by ", ">`.
- [integration] The same `nax-jobs__plan` tool run with the unknown config profile `ghost` does not call `approve`.
- [integration] The `nax-jobs__run` tool run with no `profiles`, no `workflow`, and a PRD planned with `a+b` keeps the profiles line `profiles (none); the run uses the PRD's planned profile a+b`.
- [integration] The `nax-jobs__chain` tool run with a plan step that has no `profiles` and `workflow.plan.profiles` `["p1"]` builds a chain card whose step argv contains `--profile p1`.
- [integration] The `nax-jobs__chain` tool run with a plan step that has no `profiles` and `workflow.plan.profiles` `["ghost"]` unknown returns the error `[chat] step 1: chat.workflow.plan.profiles names unknown profile ghost; known: <known names>` and does not call `approve`.
- [unit] `buildJobsInstructions()` line 7 contains `unless chat.workflow sets profiles for that step`.
- [unit] `createHostJobs` with `config.chat.workflow.plan.profiles` `["p1"]` constructs the jobs provider with `workflow.plan.profiles` `["p1"]`, observed through `_jobsHostDeps.createJobsProvider`.
- [unit] `PROFILES_SCHEMA.description` contains `chat.workflow`.

### US-007

- [unit] `buildWorkflowInstructions()` contains `spec-review (usually two fix rounds)`.
- [unit] `buildWorkflowInstructions({ workflow: { specFixRounds: 3 } })` contains `spec-review (usually three fix rounds)`.
- [unit] `buildWorkflowInstructions({ workflow: { specFixRounds: 3 } })` contains a line starting `Three spec-review fix rounds are the default budget, not a limit: past three,`.
- [unit] `buildWorkflowInstructions()` contains the paths line naming `.nax/features/<feature>/spec.md` as where the plan launch reads the spec.
- [unit] `buildWorkflowInstructions()` paths line says a spec round writes no report file.
- [unit] `buildWorkflowInstructions()` paths line names `.nax/features/<feature>/prd-fidelity-report.md` as what spec-review --prd writes.
- [unit] `buildWorkflowInstructions({ workflow: { specFixRounds: 2, specWriter: { agent: "general", model: "m/w" }, specReviewer: { agent: "code-reviewer" } } })` contains `Spec-writing runs through nax-agents__run with agent general and model m/w; spec-review runs with agent code-reviewer (chat.workflow).`
- [unit] `buildWorkflowInstructions` with `specWriter` `{ model: "m/w" }` renders the spec writer as `agent general and model m/w`.
- [unit] `buildWorkflowInstructions` with `specWriter` set and `specReviewer` unset renders the spec reviewer as `the agent you choose`.
- [unit] `buildWorkflowInstructions` with neither `specWriter` nor `specReviewer` set has no line containing `Spec-writing runs through`.
- [unit] `buildWorkflowInstructions` with `specWriter: {}` and `specReviewer: {}` has no line containing `Spec-writing runs through`.
- [unit] `buildWorkflowInstructions({ workflow: { specFixRounds: 2, plan: { profiles: ["p1", "p2"] }, run: { profiles: ["r1"] } } })` contains `chat.workflow sets the profiles for nax plan (p1, p2) and nax run (r1); leave profiles empty on those launches and the card names them.`
- [unit] `buildWorkflowInstructions` with only `run.profiles` set renders the profiles line naming `nax run (r1)` and not `nax plan`.
- [unit] `buildWorkflowInstructions()` contains the choices line starting `In this chat, where chat.workflow does not set them,` and stating that the plan and run profiles and the spec writer and reviewer are the user's choice and that `nax-jobs__list` returns the profile names.
- [unit] `buildWorkflowInstructions` with `plan.profiles`, `run.profiles`, `specWriter` and `specReviewer` all set has no line containing `are the user's choice`.
- [unit] `buildWorkflowInstructions` with every `chat.workflow` field set still has exactly one line naming all four of `nax plan`, `nax run`, `nax bot review` and `nax bot fix` with the explicit-approval wording.
- [unit] The workflow provider created with `workflow: { specFixRounds: 3 }` returns from `instructions()` text containing `spec-review (usually three fix rounds)`.
- [unit] The chat composition in `cli/chat.ts`, given a loaded config with `chat.workflow.specFixRounds` 3, calls the injected `createWorkflowProvider` with `workflow.specFixRounds` 3.
