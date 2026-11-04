# SPEC: ACP chat subagents with a configured read-only profile

## Summary

Let a `nax chat` subagent run on an ACP agent (Claude Code, Codex, Cursor) instead of a native nax
session. An agent file's `model:` may name an `acp:` model directly, or a role alias such as
`reviewer` that `agent.modelAliases` maps to an `acp:` model, so a profile decides which agent plays
the role. The ACP subagent's permission profile comes from its agent file: an agent that declares
`tools:` with no write tool opens on the read-only profile `review`, and a read-only subagent on an
agent that cannot enforce read-only itself refuses to start. A config key,
`agent.acpSubagents.profile`, replaces the derived profile for every ACP subagent. Native subagents
are unchanged.

This is part (a) of the design `docs/superpowers/specs/2026-11-04-nax-chat-acp-subagents-design.md`
(sections 1 and 2). `nax agents run` (section 3) and the koda flow tool (section 4) are later features.

## Motivation

`runSubagent` (`packages/nax/src/chat/subagent-session.ts`) always builds a native session with
`nativeBackend(...)`. Reviewing a spec on a second model, for example Codex reviewing a spec Claude
wrote, today means switching the whole chat's brain with `/model` by hand. The ACP brain already
exists (`acpSessionOptions`, `packages/nax/src/chat/acp/acp-session-options.ts`) and
`@nathapp/nax-agent-acp/client` already enforces read-only profiles per agent, so a subagent can reuse
both. `agent.modelAliases` (`packages/nax/src/config/schemas-model-alias.ts`) only accepts
`provider/model[effort]`, so a role cannot point at an ACP agent yet.

## Design

### Model strings

- `agent.modelAliases` values accept either the existing `provider/model[effort]` shape, or an ACP
  model `acp:<agent>[/<model>][[<effort>]]` whose agent is one of `claude`, `codex`, `cursor` (the
  shape `parseChatAcpModel` in `packages/nax/src/chat/acp/acp-model.ts` accepts). A value that starts
  with `acp:` is validated only against the ACP shape, so `acp:bogus/x`, which the current regex would
  accept as provider `acp:bogus`, is rejected. The single error message is
  `agent.modelAliases values must be "provider/model" or "acp:<agent>[/<model>]" (agent: claude, codex, cursor), each with an optional [effort] suffix and no whitespace`.
- The schema checks the ACP shape with its own regular expression in `schemas-model-alias.ts`, not by
  importing from `src/chat` (config must not depend on chat):
  `const ACP_ALIAS_TARGET = /^acp:(claude|codex|cursor)(\/[^\s[\]]+)?(\[[^\s[\]]+\])?$/;`
  For every value without whitespace, the schema accepts an `acp:` value exactly when
  `parseChatAcpModel` does not throw on it (pinned by a parity AC).
- `resolveSubagentModel` (`packages/nax/src/chat/subagent-model.ts`) keeps its order: inherit, alias,
  tier, model, fallback. A requested value that starts with `acp:` and is not an alias key returns
  `{ model: requested, source: "model" }`; today `acp:codex` (no slash) falls through to `fallback`.

### Config

```jsonc
// any config layer, typically a profile
"agent": {
  "modelAliases": { "reviewer": "acp:codex/gpt-6.1-terra" },
  "acpSubagents": { "profile": "review" }   // optional; absent = derived per agent file
}
```

`AcpSubagentsConfigSchema` (new, in `schemas-model-alias.ts`) is `z.object({ profile: z.enum(["review", "read", "ask", "full"]).optional() }).strict()`.
`AgentConfigSchema` (`packages/nax/src/config/schemas-infra.ts`) gains `acpSubagents: AcpSubagentsConfigSchema.optional()`;
it has no default, so `NaxConfigSchema.parse({}).agent.acpSubagents` is `undefined`.
`schemas-infra.ts` is at its 600-line cap: the new key replaces the one-line comment above `modelAliases`
(that comment moves into `schemas-model-alias.ts`), so the file stays at 600 lines.
`AgentConfig` in `packages/nax/src/config/runtime-types-agent.ts` gains
`acpSubagents?: { profile?: "review" | "read" | "ask" | "full" }`.
`FIELD_DESCRIPTIONS` (`packages/nax/src/cli/config-descriptions.ts`) gains `agent.acpSubagents` and
`agent.acpSubagents.profile`, and the `agent.modelAliases` description names the `acp:` shape.

### Profile derivation (`packages/nax/src/chat/acp/acp-subagent-profile.ts`, new)

```ts
export type AcpSubagentProfile = "review" | "read" | "ask" | "full";
export const ACP_SUBAGENT_WRITE_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Delete", "GitCommit"];
export function acpSubagentProfile(input: {
  readonly tools: readonly string[] | undefined;   // the agent file's tools:, as AgentResource.tools
  readonly mode: ChatMode;                         // "guarded" | "full"
  readonly override?: AcpSubagentProfile;          // config agent.acpSubagents.profile
}): AcpSubagentProfile;
export function isReadOnlyAcpProfile(profile: AcpSubagentProfile): boolean;   // review, read
export function acpReadOnlyEnforced(agent: AcpChatAgent): boolean;
```

The order is an ordered pipeline; the first step that answers wins:

1. `override` present: return it.
2. `tools` is `undefined` (no `tools:` line): the chat's own profile, `ask` in guarded mode and `full`
   in full mode.
3. `tools` names a write tool: the chat's own profile, as in step 2. A tool entry is compared by its
   bare name (`Write(src/**)` counts as `Write`), as `mapSubagentTools` reads names.
4. Otherwise (including `tools: []`): `review`.

Bare names are computed inside `acp-subagent-profile.ts` with the same rule `mapSubagentTools` uses (text
before a trailing `(...)`); `bareName` in `subagent-tools.ts` stays private and unchanged.

A reviewer whose `tools:` lists only built-ins (`Read`, `Grep`) gets no nax provider at all, because the
provider filter keeps a provider only when `allowedTools` names it; the read-only memory-write removal
matters only for an agent that lists `mcp__nax-memory__*` or has no `tools:` line.

An override applies in every chat mode, so `agent.acpSubagents.profile: "full"` in a guarded chat opens
every ACP subagent with profile `full` (no asks). This is intended: the key is an explicit operator choice.

`Bash` is not a write tool for this rule: under a read-only profile the agent's own read-only
enforcement governs its shell.

`acpReadOnlyEnforced(agent)` is true when `registryEntry(agent)` (exported by
`@nathapp/nax-agent-acp/client`) has a `readOnly` entry whose `policy` is `undefined`, meaning the agent
enforces read-only through its own permission mode rather than through nax's rule translation. Today
that is `claude` and `codex`; `cursor`'s entry has `policy: "cursor"`, so it is false.

### The ACP subagent session (`packages/nax/src/chat/acp/acp-subagent-session.ts`, new)

```ts
export const _acpSubagentDeps = { acpBackend, chatAcpTools };
export const ACP_SUBAGENT_PROVIDER_IDS: readonly string[] = ["nax-workflow", "nax-memory"];
export async function acpSubagentSessionOptions(input: RunSubagentInput & { readonly acp: ChatAcpModel; readonly profile: AcpSubagentProfile },
  createTranscriptStore: () => TranscriptStore): Promise<CreateAgentSessionOptions>;
```

`runSubagent` (`subagent-session.ts`) branches before it builds options:

- `parseChatAcpModel(input.model)` returns `undefined`: the native path, unchanged.
- It throws (a malformed `acp:` value from an agent file's own `model:` line, which config validation
  never sees): the result is `{ isError: true, content: "[chat] subagent <name> failed: <message>" }`
  and no session is created.
- It returns an ACP model: compute the profile with `acpSubagentProfile({ tools: input.agent.tools, mode: input.mode, override: input.config.agent?.acpSubagents?.profile })`.
  When the profile is read-only and `acpReadOnlyEnforced(acp.agent)` is false, the result is
  `{ isError: true, content: "[chat] subagent <name> could not start read-only: <label> has no read-only enforcement of its own" }`
  (`<label>` from `acpAgentLabel`) and no session is created. Otherwise build the options and run the
  turn through the same `runOnSession` the native path uses (cancel on abort, one turn, close always).

`acpSubagentSessionOptions` builds:

- `backend`: `_acpSubagentDeps.acpBackend({ agent, allowUnsandboxed: true, inheritEnv: true, model?, effort? })`
  with `model` and `effort` only when the ACP model names them.
- `profile`: the derived profile.
- `tools` and tool instructions: `_acpSubagentDeps.chatAcpTools(providers, cwd)`, where `providers` is
  `input.toolProviders` filtered to ids in `ACP_SUBAGENT_PROVIDER_IDS` (never `nax-jobs`: billed
  launches stay with the chat brain), and, when `input.allowedTools` is defined, further filtered to the
  providers for which some `allowedTools` entry starts with `<id>__`.
- When the profile is read-only (`review` or `read`), the tools named `nax-memory__save` and
  `nax-memory__forget` are removed from the list `chatAcpTools` returned, so a read-only subagent can read
  memory (`nax-memory__get`, `nax-memory__search`) but not write it. Embedder tools carry
  `approval: "never"` and the ACP client allows tool-host calls under every profile, so without this a
  read-only reviewer could save or forget notes unasked.
- `transcriptStore`: a fresh memory-only store from `createTranscriptStore`; no `sessionId`, so the
  session never resumes and writes no ACP transcript under the chat sessions dir.
- `workdir`: `input.cwd`; `metadata`: `{ parentSessionId, subagent: agent.qualifiedName }`;
  `approvalTimeoutMs`: `input.config.execution.approvalTimeout`.
- `instructions`: `buildAcpSubagentInstructions` (new, `packages/nax/src/prompts/builders/agents-builder.ts`,
  exported from `@/prompts`):

```ts
export interface AcpSubagentInstructionsInput {
  readonly agentLabel: string;                       // "Codex"
  readonly agent: Pick<AgentResource, "qualifiedName" | "prompt">;
  readonly toolInstructions?: string;
  readonly memoryIndex?: string;
}
// Sections joined by a blank line: an opening line naming the label and the subagent,
// then toolInstructions when non-empty, then the memory section when present, then agent.prompt last.
```

The opening line is `You are <label>, running as the nax chat subagent <qualifiedName>. Use your own tools for the work. Answer with your final result as text; the chat that called you reads only that.`
It carries no nax rules index (the agent's own settings apply, as for the ACP brain).

`acp-subagent-session.ts` imports `RunSubagentInput` with `import type` only, so it adds no runtime
cycle with `subagent-session.ts` (the `check:import-cycles` ratchet).

A throw while building the ACP options (`acpBackend` or `chatAcpTools`) is caught in the ACP branch and
returned as `[chat] subagent <name> failed: <message>`, like a `createAgentSession` throw; the parent
turn continues.

Asks, usage, spend and tool activity from the nested ACP session reach the parent through the existing
`createSubagentRuns` routing, unchanged. ACP usage rows carry `costSource: "unpriced"`, which the chat
ledger already records with confidence `estimated`, so an ACP subagent's cost is recorded as unknown,
not as an exact 0.

### Integration

Read-only (verified on `main` `98046a3c6`):

- `parseChatAcpModel(model: string): ChatAcpModel | undefined`, `acpAgentLabel(agent: AcpChatAgent): string`,
  `ACP_CHAT_AGENTS`, type `AcpChatAgent`, interface `ChatAcpModel { agent; model?; effort? }` in
  `packages/nax/src/chat/acp/acp-model.ts`.
- `chatAcpTools(providers: readonly ToolProvider[], workdir: string): Promise<ChatAcpTools>` in
  `packages/nax/src/chat/acp/acp-tools.ts`.
- `acpBackend` and `registryEntry(name: string): AgentRegistryEntry | undefined` from
  `@nathapp/nax-agent-acp/client`; `AgentRegistryEntry.readOnly?.policy: "opencode" | "cursor" | "pi" | undefined`.
- `createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns` in `packages/nax/src/chat/subagent-runs.ts`
  (resolves the model, maps tools, calls `runSubagent`, routes asks/usage/spend).
- `ChatMode` in `packages/nax/src/chat/chat-mode.ts`; `AgentResource` (`name`, `qualifiedName`, `model?`,
  `tools?`, `prompt`) from `@/resources`.

Changed (the baseline exists only to locate the code; implement the target):

- `ModelAliasesSchema` in `schemas-model-alias.ts`. Baseline: values must match `provider/model[effort]`.
  Target: values match that shape or the ACP shape above, with the combined message.
- `AgentConfigSchema` in `schemas-infra.ts`. Target: gains `acpSubagents` (optional).
- `resolveSubagentModel` in `subagent-model.ts`. Target: an unaliased `acp:` request resolves with source `model`.
- `runSubagent(input, deps)` in `subagent-session.ts`. Baseline: always native. Target: branches as above.
  `_subagentSessionDeps` keeps its current keys; the ACP seams live in `_acpSubagentDeps`.

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| `agent.modelAliases` value `acp:<unknown agent>...` | config validation error with the combined message, path under `agent.modelAliases` |
| agent file `model:` is a malformed `acp:` string | subagent error result `[chat] subagent <name> failed: ...`; no session created; the parent turn continues |
| read-only profile on `cursor` (no enforcement of its own) | error result `... could not start read-only: Cursor has no read-only enforcement of its own`; no session created |
| `acpBackend` or `chatAcpTools` throws while building options | error result `[chat] subagent <name> failed: <message>`; no session created |
| ACP agent binary missing or `createAgentSession` throws | error result `[chat] subagent <name> failed: ...` (existing `failedResult`); the parent turn continues |
| ACP session reports no cost | usage recorded with confidence `estimated` (existing ledger rule) |

## Out of Scope

- `nax agents run` (design section 3), including the rule that an unattended run with no `tools:` line uses the `review` profile; it lands with that command.
- The koda flow tool `nax-flow__send` (design section 4).
- Any change to native subagents, to the chat ACP brain, or to `nax-jobs__chain`.
- Translating an agent file's `tools:` list into per-tool ACP restrictions; `tools:` only selects the profile and which nax providers are delivered, whole providers at a time.
- Letting an ACP chat brain call subagents; the ACP brain is not given the `nax-agents` provider today and still is not.
- Read-only ACP subagents on `cursor`; they refuse to start until cursor enforces read-only through its own mode.
- Giving an ACP subagent the `nax-jobs` provider or any billed launch tool.
- A user guide page for ACP subagents.
- Ledger attribution for ACP subagent rows: they keep `agentName: "native"` and the `acp:` model string, and an unpriced ACP turn adds 0 to the chat session's `meta.costUsd`; the row's `estimated` confidence is the only unknown-cost signal.
- The `/agents` listing's tools column for an ACP-aliased agent; it still shows the mapped nax tool list.
- Per-tool narrowing of the `nax-workflow` provider; it delivers only the read-only `state` tool today.

## Stories

### US-001: ACP model strings in agent.modelAliases

No dependencies. Workdir: `packages/nax`

Accept `acp:` values in `agent.modelAliases` with the `ACP_ALIAS_TARGET` regex and the combined message,
and name the `acp:` shape in the `agent.modelAliases` field description.

### US-002: The acpSubagents config key and ACP model resolution

Depends on US-001. Workdir: `packages/nax`

Add `agent.acpSubagents.profile` (schema, runtime type, field descriptions), and resolve an unaliased
`acp:` request as an explicit model in `resolveSubagentModel`.

### US-003: ACP subagent profile derivation

Depends on US-002. Workdir: `packages/nax`

Create `packages/nax/src/chat/acp/acp-subagent-profile.ts` with `acpSubagentProfile`, `isReadOnlyAcpProfile`,
`acpReadOnlyEnforced` and `ACP_SUBAGENT_WRITE_TOOLS`.

### US-004: ACP subagent session options and instructions

Depends on US-003. Workdir: `packages/nax`

Add `buildAcpSubagentInstructions` and create `packages/nax/src/chat/acp/acp-subagent-session.ts` with
`_acpSubagentDeps`, `ACP_SUBAGENT_PROVIDER_IDS` and `acpSubagentSessionOptions` (backend, profile,
provider filtering, read-only memory-write removal, memory-only transcript, instructions).

### US-005: Branch runSubagent onto ACP, with refusal and error paths

Depends on US-004. Workdir: `packages/nax`

Make `runSubagent` parse the resolved model, refuse an unenforceable read-only profile, return error
results for a malformed model or an options/session failure, and run the ACP session through
`runOnSession`.

### US-006: Chat host seams for ACP subagents

Depends on US-005. Workdir: `packages/nax`

Extend the chat-subagent test harness so it can set `agent.acpSubagents` and stub and restore
`_acpSubagentDeps`, and pin the whole path from the chat host's `nax-agents__run` tool.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-model-alias.ts` - the alias schema to extend
- `packages/nax/src/config/schemas-infra.ts` - `AgentConfigSchema`, at its 600-line cap
- `packages/nax/src/config/runtime-types-agent.ts` - `AgentConfig`
- `packages/nax/src/cli/config-descriptions.ts` - `FIELD_DESCRIPTIONS`
- `packages/nax/src/chat/acp/acp-model.ts` - `parseChatAcpModel`, for the parity AC

**US-002**
- `packages/nax/src/config/schemas-model-alias.ts` - where `AcpSubagentsConfigSchema` goes
- `packages/nax/src/config/schemas-infra.ts` - `AgentConfigSchema`, at its 600-line cap
- `packages/nax/src/config/runtime-types-agent.ts` - `AgentConfig`
- `packages/nax/src/cli/config-descriptions.ts` - `FIELD_DESCRIPTIONS`
- `packages/nax/src/chat/subagent-model.ts` - `resolveSubagentModel`

**US-003**
- `packages/nax/src/chat/acp/acp-model.ts` - `AcpChatAgent`, `ACP_CHAT_AGENTS`
- `packages/nax/src/chat/subagent-tools.ts` - how tool entries are reduced to bare names
- `packages/nax/src/chat/chat-mode.ts` - `ChatMode`
- `packages/nax-agent-acp/src/client/registry.ts` - per-agent `readOnly` entries and `policy`

**US-004**
- `packages/nax/src/chat/acp/acp-session-options.ts` - how the ACP brain builds its backend and tools
- `packages/nax/src/chat/acp/acp-tools.ts` - `chatAcpTools`
- `packages/nax/src/prompts/builders/agents-builder.ts` - where the new builder goes
- `packages/nax/src/memory/tool-provider.ts` - the `nax-memory` tool names
- `packages/nax/src/chat/subagent-session.ts` - `RunSubagentInput`
- `packages/nax/src/chat/acp/acp-subagent-profile.ts` - `AcpSubagentProfile`, `isReadOnlyAcpProfile` (created by US-003)

**US-005**
- `packages/nax/src/chat/subagent-session.ts` - `runSubagent`, `runOnSession`, result helpers
- `packages/nax/test/unit/chat/subagent-session.test.ts` - existing deps stubs to mirror
- `packages/nax/src/chat/acp/acp-subagent-session.ts` - `acpSubagentSessionOptions`, `_acpSubagentDeps` (created by US-004)
- `packages/nax/src/chat/acp/acp-subagent-profile.ts` - `acpSubagentProfile`, `acpReadOnlyEnforced` (created by US-003)
- `packages/nax/src/chat/acp/acp-model.ts` - `parseChatAcpModel`, `acpAgentLabel`

**US-006**
- `packages/nax/test/helpers/chat-subagents.ts` - the chat-host harness
- `packages/nax/test/unit/chat/host-subagents.test.ts` - host-level subagent tests
- `packages/nax/src/chat/chat-ledger.ts` - the `unpriced` -> `estimated` rule

### Creates

**US-003**
- `packages/nax/src/chat/acp/acp-subagent-profile.ts`
- `packages/nax/test/unit/chat/acp/acp-subagent-profile.test.ts`

**US-004**
- `packages/nax/src/chat/acp/acp-subagent-session.ts`
- `packages/nax/test/unit/chat/acp/acp-subagent-session.test.ts`

**US-005**
- `packages/nax/test/unit/chat/subagent-session-acp.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/config/agent-schema.test.ts` - add the `acp:` acceptance, rejection and parity cases beside the existing `modelAliases` block; existing cases keep passing unchanged.
- `packages/nax/test/unit/cli/config-descriptions.test.ts` - add the check that `agent.modelAliases` mentions `acp:`; existing checks unchanged.

**US-002**
- `packages/nax/test/unit/config/agent-schema.test.ts` - add the `agent.acpSubagents` cases; existing cases keep passing unchanged.
- `packages/nax/test/unit/cli/config-descriptions.test.ts` - add the `agent.acpSubagents.profile` description check; existing checks unchanged.
- `packages/nax/test/unit/chat/subagent-model.test.ts` - add the three `acp:` resolution cases; existing cases unchanged (none uses an `acp:` value).

**US-004**
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` - add the two `buildAcpSubagentInstructions` cases; existing cases unchanged.

**US-006**
- `packages/nax/test/helpers/chat-subagents.ts` - add an optional `toolProviders` option that replaces the default `[base]` resources provider list, a `costSource` parameter on `usageEvent` (default `"computed"`), an optional `acpSubagents` option to `SubagentHostOptions` merged into the host config's `agent` block beside `modelAliases`, stub `_acpSubagentDeps.acpBackend` (recording calls, returning a dummy backend object of the `acpBackend` return type) and `_acpSubagentDeps.chatAcpTools` (recording the `providers` argument it receives), and restore both in `dispose()` beside `_subagentSessionDeps`; existing options and behaviour unchanged.
- `packages/nax/test/unit/chat/host-subagents.test.ts` - add the ACP host-level cases; existing cases unchanged.

### Seams

- US-005 consumes US-003's `acpSubagentProfile` and `acpReadOnlyEnforced` and US-004's
  `acpSubagentSessionOptions`: covered at the outermost entry, the chat host's `nax-agents__run` tool, by
  US-006 AC 1, AC 2 and AC 3.
- US-005 consumes US-002's `agent.acpSubagents.profile` and `acp:` alias resolution: covered by
  US-006 AC 1 and AC 2.

## Acceptance Criteria

### US-001

1. [unit] `NaxConfigSchema.safeParse` with `agent.modelAliases` `{ reviewer: "acp:codex/gpt-6.1-terra" }` succeeds and keeps the value unchanged.
2. [unit] `NaxConfigSchema.safeParse` accepts each `modelAliases` value in the table `acp:claude`, `acp:cursor/composer-2`, `acp:codex/gpt-6.1-terra[high]`.
3. [unit] `NaxConfigSchema.safeParse` with `agent.modelAliases` `{ reviewer: "acp:bogus/x" }` fails with an issue whose path includes `modelAliases` and whose message contains `acp:<agent>[/<model>]`.
4. [unit] `NaxConfigSchema.safeParse` rejects each `modelAliases` value in the table `acp:`, `acp:codex/`, `acp:codex/a b`, each with an issue whose path includes `modelAliases`.
5. [unit] for each value in the table `acp:codex[high]`, `acp:codex/a/b`, `acp:claude[]`, `acp:codex/x[`, `acp:cursor/a[b]c`, `acp:bogus`, `NaxConfigSchema.safeParse` with that `modelAliases` value succeeds exactly when `parseChatAcpModel` does not throw on it.
6. [unit] `NaxConfigSchema.safeParse` with `agent.modelAliases` `{ sonnet: "claude-sonnet" }` fails with a message containing `"provider/model"`.
7. [unit] `FIELD_DESCRIPTIONS["agent.modelAliases"]` contains `acp:`.

### US-002

1. [unit] `NaxConfigSchema.parse({})` yields `agent.acpSubagents` equal to `undefined`.
2. [unit] `NaxConfigSchema.parse` with `agent.acpSubagents` `{ profile: "read" }` yields `agent.acpSubagents.profile` equal to `"read"`.
3. [unit] `NaxConfigSchema.safeParse` with `agent.acpSubagents` `{ profile: "write" }` fails with an issue whose path is under `agent.acpSubagents.profile`.
4. [unit] `NaxConfigSchema.safeParse` with `agent.acpSubagents` `{ profile: "review", extra: 1 }` fails, because the object is strict.
5. [unit] `FIELD_DESCRIPTIONS["agent.acpSubagents.profile"]` is a non-empty string.
6. [unit] `resolveSubagentModel` with `requested: "acp:codex"`, no aliases and no tiers returns `{ model: "acp:codex", source: "model" }`.
7. [unit] `resolveSubagentModel` with `requested: "reviewer"` and aliases `{ reviewer: "acp:codex/gpt-6.1-terra" }` returns `{ model: "acp:codex/gpt-6.1-terra", source: "alias" }`.
8. [unit] `resolveSubagentModel` with `requested: "acp:codex"` and aliases `{ "acp:codex": "openai/gpt-x" }` returns `{ model: "openai/gpt-x", source: "alias" }`.

### US-003

1. [unit] `acpSubagentProfile({ tools: ["Read", "Grep", "Bash"], mode: "guarded" })` returns `"review"`.
2. [unit] `acpSubagentProfile({ tools: [], mode: "full" })` returns `"review"`.
3. [unit] `acpSubagentProfile({ tools: ["Read", "Edit"], mode: "guarded" })` returns `"ask"`.
4. [unit] `acpSubagentProfile({ tools: ["Read", "Write(src/**)"], mode: "full" })` returns `"full"`.
5. [unit] `acpSubagentProfile({ tools: undefined, mode: "guarded" })` returns `"ask"`.
6. [unit] `acpSubagentProfile({ tools: undefined, mode: "full" })` returns `"full"`.
7. [unit] `acpSubagentProfile({ tools: ["Read"], mode: "guarded", override: "full" })` returns `"full"`.
8. [unit] `acpSubagentProfile({ tools: ["Write"], mode: "full", override: "read" })` returns `"read"`.
9. [unit] for each name in `ACP_SUBAGENT_WRITE_TOOLS` (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Delete`, `GitCommit`), `acpSubagentProfile({ tools: [name], mode: "guarded" })` returns `"ask"`.
10. [unit] `isReadOnlyAcpProfile` returns true exactly for `"review"` and `"read"` among the four profiles.
11. [unit] `acpReadOnlyEnforced` returns true for `"claude"` and `"codex"` and false for `"cursor"`.

### US-004

1. [unit] `buildAcpSubagentInstructions({ agentLabel: "Codex", agent: { qualifiedName: "spec-reviewer", prompt: "Review it." } })` returns text whose first section is `You are Codex, running as the nax chat subagent spec-reviewer. Use your own tools for the work. Answer with your final result as text; the chat that called you reads only that.` and whose last section is `Review it.`.
2. [unit] `buildAcpSubagentInstructions` with `toolInstructions: "TOOLS"` and a non-empty `memoryIndex` returns `TOOLS`, then the memory section, then the agent prompt, in that order.
3. [unit] `acpSubagentSessionOptions` for ACP model `{ agent: "codex", model: "gpt-6.1-terra", effort: "high" }` with `_acpSubagentDeps.acpBackend` stubbed calls `acpBackend` once with `{ agent: "codex", model: "gpt-6.1-terra", effort: "high", allowUnsandboxed: true, inheritEnv: true }`.
4. [unit] `acpSubagentSessionOptions` with profile `"review"` returns options with `profile` `"review"`, no `sessionId`, and `workdir` equal to the input `cwd`.
5. [unit] `acpSubagentSessionOptions` returns `metadata` equal to `{ parentSessionId: <input parentSessionId>, subagent: <agent qualifiedName> }`.
6. [unit] `acpSubagentSessionOptions` passes `chatAcpTools` only the providers with ids `nax-workflow` and `nax-memory` out of input providers with ids `nax-workflow`, `nax-jobs`, `nax-memory` and `custom`.
7. [unit] `acpSubagentSessionOptions` with `allowedTools: ["Read", "nax-memory__*"]` passes `chatAcpTools` only the `nax-memory` provider.
8. [unit] `acpSubagentSessionOptions` with profile `"review"`, where `chatAcpTools` returns tools named `nax-memory__get`, `nax-memory__search`, `nax-memory__save` and `nax-memory__forget`, returns `tools` named only `nax-memory__get` and `nax-memory__search`.
9. [unit] `acpSubagentSessionOptions` with profile `"ask"` and the same four tools returns all four.
10. [unit] `acpSubagentSessionOptions` returns a `transcriptStore` produced by the `createTranscriptStore` argument and `instructions` equal to `buildAcpSubagentInstructions` with label `Codex`, the agent, `chatAcpTools`' instructions and the input `memoryIndex`.

### US-005

1. [unit] `runSubagent` with `model: "acp:codex/gpt-6.1-terra"`, an agent with `tools: ["Read"]`, mode `guarded` and `_acpSubagentDeps` stubbed creates the session through `_subagentSessionDeps.createAgentSession` with profile `"review"` and never calls `_subagentSessionDeps.nativeBackend`.
2. [unit] `runSubagent` with `model: "acp:cursor"` and an agent with `tools: ["Read"]` returns `{ isError: true }` with content `[chat] subagent <qualifiedName> could not start read-only: Cursor has no read-only enforcement of its own`.
3. [unit] in that cursor refusal, `createAgentSession` and `_acpSubagentDeps.acpBackend` are never called.
4. [unit] `runSubagent` with `model: "acp:cursor"`, an agent with `tools: ["Read", "Edit"]` and mode `guarded` creates the session with profile `"ask"`.
5. [unit] `runSubagent` with `model: "acp:bogus"` returns `{ isError: true }` with content starting `[chat] subagent <qualifiedName> failed:` and containing `invalid ACP model`, and `createAgentSession` is never called.
6. [unit] `runSubagent` on an ACP model whose `_acpSubagentDeps.chatAcpTools` rejects with `boom` returns `{ isError: true }` with content `[chat] subagent <qualifiedName> failed: boom`, and `createAgentSession` is never called.
7. [unit] `runSubagent` on an ACP model whose `createAgentSession` throws `spawn codex-acp ENOENT` returns `{ isError: true }` with content `[chat] subagent <qualifiedName> failed: spawn codex-acp ENOENT`.
8. [unit] `runSubagent` on an ACP model whose nested turn ends `completed` with output `LGTM` returns `{ content: "LGTM" }`.
9. [unit] `runSubagent` on an ACP model closes the nested session exactly once after the turn.
10. [unit] `runSubagent` on an ACP model whose input signal aborts during the turn calls `cancel()` on the nested session.

### US-006

1. [integration] through the chat host's `nax-agents__run` tool, with `agent.modelAliases` `{ reviewer: "acp:codex/gpt-6.1-terra" }` and an agent file with `model: reviewer` and `tools: ["Read", "Grep"]`, a guarded chat turn that runs the agent calls the stubbed `_acpSubagentDeps.acpBackend` once with agent `codex` and model `gpt-6.1-terra`, and the nested session opens with profile `"review"`.
2. [integration] through the same `nax-agents__run` path with `agent.acpSubagents` `{ profile: "ask" }` and the same read-only agent file, the nested ACP session opens with profile `"ask"`.
3. [integration] through the same `nax-agents__run` path with alias `reviewer` mapped to `acp:cursor` and an agent with `tools: ["Read"]`, the tool result is an error containing `could not start read-only: Cursor has no read-only enforcement of its own`, and no nested session is created.
4. [integration] (defensive pin: production never puts `nax-jobs` in the resources' providers today) through the same `nax-agents__run` path, with providers `nax-workflow`, `nax-jobs` and `nax-memory` injected through the harness `toolProviders` option, the stubbed `_acpSubagentDeps.chatAcpTools` receives no `nax-jobs` provider.
5. [integration] (regression pin of existing ledger behaviour) through the same `nax-agents__run` path, a nested ACP usage event with `costSource: "unpriced"` and `costUsd: 0` is written to the chat ledger as a `subagent` row with confidence `estimated`.
6. [integration] (regression pin of the native path) through the same `nax-agents__run` path, an agent whose model resolves to a native `provider/model` opens a native nested backend and never calls `_acpSubagentDeps.acpBackend`.
