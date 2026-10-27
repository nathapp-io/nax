# SPEC: tui-guarded-posture — guarded chat follows the configured permission posture

Closes: #2712

## Summary

`nax chat`'s guarded mode (the default) stops asking before every shell command and every
file edit. It opens the native session under the same posture `nax run` applies, resolved
from a new `execution.permissions.tui` block that falls back to `execution.permissions.default`
and then to the top-level `execution.bashApproval`. Guarded mode asks only when a command
asks to run outside the sandbox, when the sandbox is unavailable, when a configured `ask`
rule matches, when the opt-in `execution.commandSafety` guard flags a command, or when a
discovered MCP tool is not read-only (kept from the F5a ruling). The chat sandbox is built
from `execution.sandbox` instead of the built-in default. Full mode stays never-ask.

## Motivation

Testing v0.91.7-canary.3 showed that in guarded mode every command (the repo's own
typecheck included) and every edit waited for approval. Root cause:

- `chatSessionSettings("guarded")` (`packages/nax/src/chat/chat-mode.ts`) hard-codes the
  nax-agent `ask` profile with `bashApproval: "gated"`.
- `askRulesFor` (`packages/nax-agent/src/session/session-tool-support.ts`) then adds a
  `Bash(*)` ask under `gated`, plus asks for every `Write`/`Edit`/`Delete`/`GitCommit` under
  the `ask` profile.
- `nativeProfileRules` (`packages/nax-agent/src/session/native-backend-options.ts`) refuses
  the `ask` profile with any `bashApproval` other than `gated`, so the session cannot take the
  configured mode at all.
- The chat session never reads `execution.bashApproval`, `execution.permissions` or
  `execution.commandSafety`, and `resolveSessionLauncher` always uses `DEFAULT_SANDBOX_CONFIG`,
  so `execution.sandbox` (for example `network.allowedDomains` for package registries) never
  reaches chat either.

The slice-1 design intended "guarded = the existing guard decides". The user's global config
runs `nax run` with `bashApproval: "raw"` inside the sandbox, without asking.

## Design

### Approach

User rulings (2026-10-27):

1. Guarded mode follows the `nax run` posture through `execution.permissions.tui` (the role
   name is `tui`, matching `loopHandlerRole: "tui"`), falling back to the `default` block and
   then to top-level `execution.bashApproval`.
2. Guarded asks only on: an unsandboxed escape request, an unavailable sandbox, a configured
   `ask` rule, or a commandSafety guard flag. File edits do NOT ask by default; an `ask`
   rule (for example `Write(src/**)` or `Delete`) restores a prompt for that tool.
3. nax-agent shape: guarded opens the existing `full` profile with the resolved
   `bashApproval` plus new opt-in `NativeBackendOptions`. The `ask` profile,
   `nativeProfileRules` and its return shape are unchanged, so no other embedder breaks.
4. The chat sandbox (both modes) is built from `execution.sandbox`.
5. The commandSafety shadow and guard (`execution.commandSafety`) are wired into the guarded
   main session through the existing `buildCommandShadow`.

Kept from the F5a ruling (2026-10-25, "guarded asks for non-readOnly MCP tools"): today that
ask is produced only under the `ask` profile (`buildSessionToolSupport` adds
`providerTools.askTools` when `profile === "ask"`). Moving guarded to `full` would drop it, so a
new `askDiscoveredTools` option carries it.

Layering, outermost first:

```
nax chat (ChatHost) -> openChatSession / runSubagent            [packages/nax/src/chat]
  resolveTuiPermissions(config)  -> { bashApproval, askRules, denyRules }   [packages/nax/src/config/permissions.ts]
  chatSessionSettings(mode, posture) -> { profile: "full", bashApproval, metaMode }
  chatBackendPosture(mode, config, posture) -> extra nativeBackend options
  nativeBackend({ ..., askRules, denyRules, sandbox, askOnUnsandboxed, askWhenSandboxDown,
                  askDiscoveredTools, hostPorts: { commandShadow } })   [packages/nax-agent/src/session]
    nativePostureRules(profile, raw) -> validated posture knobs (new; beside nativeProfileRules)
    openNative -> resolveSessionLauncher({ ..., config: parsed sandbox })
               -> effectiveBashApproval(...)  (gated when the sandbox is down and askWhenSandboxDown)
               -> buildSessionToolSupport({ ..., askRules, denyRules, askOnUnsandboxed,
                                            askDiscoveredTools, commandShadow })
                 -> buildCodingToolSupport({ askRules, denyRules, commandShadow,
                                            unsandboxed: { enabled, bashApproval, alwaysAsk } })
```

How each ask trigger is produced:

| Trigger | Mechanism |
|:---|:---|
| Unsandboxed escape (`unsandboxed: true` on Bash) | `askOnUnsandboxed: true` sets `alwaysAsk` on the runtime's `unsandboxed` option; `resolveUnsandboxedCall` returns `asksOnAllow: true` even under `raw`, and `convertUnsandboxedAllow` turns the allowed verdict into an ask whose `reason` carries the escape reason. |
| Sandbox unavailable or disabled | `askWhenSandboxDown: true`: when `resolveSessionLauncher` reports a sandbox state whose `kind` is not `"available"`, `openNative` builds the tool support, and the adapter's `resolvedPermissions`, with `bashApproval: "gated"`, so `askRulesFor` adds the `Bash(*)` ask. |
| Configured ask rule | `askRules` (rule expressions) are parsed with `parseRuleList` and appended after the profile's ask rules and the provider ask tools; `denyRules` likewise become `denyRules`. |
| commandSafety guard | `hostPorts.commandShadow` reaches `buildCodingToolSupport`'s `commandShadow`; the runtime's existing guard (`resolveGuardDenial`) turns a flagged allowed `Bash`/`Exec` call into an ask. |
| Non-read-only discovered MCP tool | `askDiscoveredTools: true` makes `buildSessionToolSupport` add `providerTools.askTools` under profile `full`, as it already does under `ask`. |

Resolved `bashApproval` semantics for guarded, matching `nax run` (ADR-030):

- `raw`: commands inside the sandbox run without asking. Under `raw` the Bash branch does not
  consult pattern-scoped `Bash(...)` ask or deny rules (`commandBranch` in
  `packages/nax-agent/src/tools/policy-command-branch.ts` returns before `askBy`/`denyBy`); an
  unconditional `Bash` / `Bash(*)` deny is still honoured, because `compileToolPolicy` checks it
  before the command branch. This is existing `nax run` behaviour and is kept. Ask and deny
  rules for every other tool (`Write`, `Edit`, `Delete`, `Git`) apply under every mode.
- `gated`: every Bash command asks (the existing `askRulesFor` `Bash(*)` ask).
- `escalate`: has no meaning in chat (chat grants `Bash(*)`, so no grant miss exists to
  escalate, and `nativeProfileRules` refuses `escalate` with `allowUnsandboxed`). It resolves
  to `gated` and `resolveTuiPermissions` logs one warning.

Session metadata: a guarded session keeps `SessionMeta.mode: "ask"` (so `chatModeOfMeta`
still identifies it as guarded) and records the resolved `bashApproval`. Resume and mode
switches recompute the posture from the current config; the stored `bashApproval` is never
read back as policy.

Permission resolution site: `adapter-wiring.md` rule 5 says permissions resolve at the
resource opener. `openChatSession` and `runSubagent` ARE chat's resource openers (each opens
exactly one native session), so `resolveTuiPermissions` is called there once per open, never
deeper.

Complexity (the nax-agent complexity gate is 20 per function and `buildCodingToolSupport` is
baselined and may not grow): the new option checks live in a new `nativePostureRules`
function in a new file `packages/nax-agent/src/session/native-posture-rules.ts`, written as a
loop over a table of tool-only option names rather than one `if` per option; `openNative`
takes the effective mode from `effectiveBashApproval(profileMode, askWhenSandboxDown, sandboxKind)`
in the same file; `askOnUnsandboxed` reaches `unsandboxedRuntimeOption` as a plain property, with no
new ternary inside `buildCodingToolSupport`. `openNative` already scores 19 against the limit of
20, so it passes every new value to `buildSessionToolSupport` as a plain property (the way it
passes `interceptor: raw.hostPorts?.commandInterceptor`), never as a new conditional spread;
`buildSessionToolSupport` forwards its new fields through one helper rather than one spread
each. `packages/nax-agent/src/tools/runtime.ts` is exactly at its 600-line limit: the widened
`unsandboxed` option type stays on its existing single line, with no new line, comment or import.

Command-safety rows from chat land under the chat sessions directory
(`<sessionsDir>/command-safety/<sessionId>.jsonl`), not a project output directory; the
session store lists only `*.session.json`, so the rows never collide with session files.

The guarded permission paragraph shared by the chat and subagent instructions changes to say
what now asks (exact text in US-005).

### Integration (extends existing code)

Read-only symbols (verified):

- `resolveBashApproval(global, perStage): BashApprovalMode` — `packages/nax-agent/src/config/bash-approval.ts`, re-exported from `@nathapp/nax-agent/internal`.
- `parseRuleList(expressions: readonly string[]): ToolGrant[]` — `packages/nax-agent/src/permissions/grammar.ts`, exported from `@nathapp/nax-agent` (never throws).
- `SandboxConfigSchema`, `SandboxConfig`, `DEFAULT_SANDBOX_CONFIG` — `packages/nax-agent/src/config/schemas-sandbox.ts`; nax's `execution.sandbox` is this schema (`schemas-execution.ts:305`).
- `resolveSessionSandbox(args)` and its seam `_sessionSandboxDeps` (`probe`, `backendFor`, ...) — `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts`; test helper `stubSessionSandboxDeps` in `packages/nax-agent/test/helpers/session-sandbox-deps.ts`.
- `parseNativeBackendOptions(input: unknown)` — `packages/nax-agent/src/session/native-backend-options.ts`; the idiom for invalid-shape tests (it takes `unknown`, so no cast is needed).
- `nativeProfileRules(profile, raw)` — same file; unchanged, including its return shape.
- `buildCodingToolSupport(args)` already takes `askRules?`, `denyRules?`, `commandShadow?` — `packages/nax-agent/src/coding-tools/coding-tool-support.ts`.
- `buildCommandShadow({ config, outputDir, runId, storyId?, env }): CommandShadow | undefined` — `packages/nax-agent/src/command-safety/build.ts`, exported from `@nathapp/nax-agent`; returns `undefined` when `config?.shadow` is absent.
- `CommandShadow { observe, settle, drain, guard? }` — `packages/nax-agent/src/command-safety/types.ts`.
- `validatePermissionsBlock` (`packages/nax/src/config/config-guards.ts`) already accepts any block key, and `PermissionsBlockSchema` is `z.record(z.string(), ...)`, so `execution.permissions.tui` loads without a schema change.
- `chatModeOfMeta`, `nextChatMode` — `packages/nax/src/chat/chat-mode.ts`, unchanged.

Mutated symbols. The baseline exists only to locate the code; implement the target.

- `NativeBackendOptions` / `OptionsSchema` — `packages/nax-agent/src/session/native-backend-options.ts`
  - Baseline: no rule lists, no sandbox config, no ask overlays; `hostPorts` has `protectedPaths?`, `commandInterceptor?`.
  - Target: adds `askRules?: readonly string[]`, `denyRules?: readonly string[]` (each entry a non-empty string), `sandbox?: z.input<typeof SandboxConfigSchema>` (the schema's INPUT type, so a partial object is accepted; validated by `SandboxConfigSchema` inside `OptionsSchema`), `askOnUnsandboxed?: boolean`, `askWhenSandboxDown?: boolean`, `askDiscoveredTools?: boolean`; `hostPorts` adds `commandShadow?: CommandShadow` (validated as an object with `observe`, `settle` and `drain` methods).
- New `nativePostureRules(profile: AgentSessionProfile, raw: NativeBackendOptions): ResolvedPostureRules` and `effectiveBashApproval(...)` — new file `packages/nax-agent/src/session/native-posture-rules.ts`
  - Target: `interface ResolvedPostureRules { readonly askRules: readonly ToolGrant[]; readonly denyRules: readonly ToolGrant[]; readonly sandbox: SandboxConfig; readonly askOnUnsandboxed: boolean; readonly askWhenSandboxDown: boolean; readonly askDiscoveredTools: boolean }`. US-001 creates the function with `askRules`, `denyRules` and `sandbox` (and the `askRules`/`denyRules`/`sandbox` option fields); US-002 adds `askOnUnsandboxed`, `askWhenSandboxDown`, `askDiscoveredTools`, `effectiveBashApproval` and the matching option fields. Each of the five options is refused on profiles `none` and `read` with `AGENT_SESSION_INVALID_OPTIONS` naming the option's path (`backend.<name>`); `askOnUnsandboxed: true` without `allowUnsandboxedCommands: true` is refused; `sandbox` is the parsed `SandboxConfigSchema` value, `DEFAULT_SANDBOX_CONFIG` when absent. `effectiveBashApproval(profileMode, askWhenSandboxDown, sandboxKind)` returns `"gated"` when `askWhenSandboxDown` is true and `sandboxKind` is not `"available"`, else `profileMode`.
- `AgentSessionHostPorts` — `packages/nax-agent/src/session/agent-session-types.ts`
  - Target: adds `readonly commandShadow?: CommandShadow`.
- `SessionLauncherArgs` / `resolveSessionLauncher(args)` — `packages/nax-agent/src/session/session-tool-support.ts`
  - Baseline: always resolves with `DEFAULT_SANDBOX_CONFIG`.
  - Target: `SessionLauncherArgs` adds `readonly config?: SandboxConfig`; the launcher resolves with `args.config ?? DEFAULT_SANDBOX_CONFIG`.
- `SessionToolSupportArgs` / `buildSessionToolSupport(args)` — same file
  - Baseline: provider ask tools only when `profile === "ask"`.
  - Target: adds `askRules?: readonly ToolGrant[]`, `denyRules?: readonly ToolGrant[]` (US-001) and `askOnUnsandboxed?: boolean`, `askDiscoveredTools?: boolean`, `commandShadow?: CommandShadow` (US-002); the ask rules passed down are `askRulesFor(...)`, then the provider ask tools (when `profile === "ask"` or `askDiscoveredTools`), then `args.askRules`; `denyRules`, `askOnUnsandboxed` and `commandShadow` are forwarded when present.
- `unsandboxedRuntimeOption(args)` — `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`
  - Baseline: `{ unsandboxed: { enabled: true, bashApproval } }` when `unsandboxedCommands` is true.
  - Target: takes `askOnUnsandboxed?: boolean`; returns `{ unsandboxed: { enabled: true, bashApproval, alwaysAsk: true } }` when both are true, and the baseline shape (no `alwaysAsk` key) otherwise.
- The runtime's `unsandboxed` option type (`packages/nax-agent/src/tools/runtime.ts:233`) and `resolveUnsandboxedCall`'s `option` (`packages/nax-agent/src/tools/runtime-calltool.ts`)
  - Target: `{ readonly enabled: boolean; readonly bashApproval: BashApprovalMode; readonly alwaysAsk?: boolean }`; `asksOnAllow` is `option.alwaysAsk === true || option.bashApproval !== "raw"`.
- `buildCodingToolSupport` args — adds `askOnUnsandboxed?: boolean`, forwarded as a plain property into `unsandboxedRuntimeOption`.
- `openNative(resolved, ctx)` — `packages/nax-agent/src/session/native-backend.ts`
  - Target: calls `nativePostureRules`; passes its `sandbox` to `resolveSessionLauncher`; takes the effective mode from `effectiveBashApproval`; passes the effective mode, rule lists, `askOnUnsandboxed`, `askDiscoveredTools` and `raw.hostPorts?.commandShadow` to `buildSessionToolSupport`, and the effective mode to `openSession`'s `resolvedPermissions`.
- `lookupStageBlock` and `stageRules` — `packages/nax/src/config/permissions.ts`
  - Baseline: both take `stage: PipelineStage`.
  - Target: `lookupStageBlock` takes `stage: string` (file-local); new export `resolveTuiPermissions(config: AgentManagerConfig | undefined): TuiPermissions` with `interface TuiPermissions { readonly bashApproval: "raw" | "gated"; readonly askRules: readonly string[]; readonly denyRules: readonly string[] }`, both exported from `@/config`. `stageRules` and `resolvePermissions` are unchanged; `resolveTuiPermissions` reads the looked-up block's `ask`, `deny` and `bashApproval` directly.
- `ChatSessionSettings` / `chatSessionSettings` — `packages/nax/src/chat/chat-mode.ts`
  - Baseline: `chatSessionSettings(mode)`; guarded -> `{ profile: "ask", bashApproval: "gated", metaMode: "ask" }`.
  - Target: `chatSessionSettings(mode: ChatMode, posture: TuiPermissions | undefined): ChatSessionSettings` with `profile: "full"` in both modes; guarded -> `{ profile: "full", bashApproval: posture.bashApproval, metaMode: "ask" }`; full -> `{ profile: "full", bashApproval: "raw", metaMode: "full" }` (posture ignored); guarded with an undefined posture throws `NaxError` code `CHAT_POSTURE_REQUIRED` (a wiring error, never a user path). The posture is resolved ONLY for guarded opens, so a full open never logs a posture warning. New export `chatBackendPosture(mode: ChatMode, config: NaxConfig, posture: TuiPermissions | undefined)` (also exported from `packages/nax/src/chat/index.ts`) returning the extra `nativeBackend` options: in both modes `sandbox: config.execution.sandbox`; in guarded additionally `askRules: posture.askRules`, `denyRules: posture.denyRules`, `askOnUnsandboxed: true`, `askWhenSandboxDown: true`, `askDiscoveredTools: true`.
- `_openChatSessionDeps`, `sessionMeta`, `sessionOptions`, `openChatSession` — `packages/nax/src/chat/open-chat-session.ts`
  - Target (US-004): deps gain `resolveTuiPermissions`; for a guarded open the posture is resolved once from `request.config`, and that single value is passed to both `sessionMeta` and `sessionOptions` (and so to `chatSessionSettings` and `chatBackendPosture`); a full open resolves none. Target (US-005): deps gain `buildCommandShadow`; guarded builds the shadow (`outputDir: request.storage.dir`, `runId: meta.sessionId`, `env: deps.env`) and passes it as `hostPorts.commandShadow`; the returned `release` drains the shadow, then releases the lock.
- `_subagentSessionDeps`, `subagentSessionOptions` — `packages/nax/src/chat/subagent-session.ts`
  - Target (US-004): deps gain `resolveTuiPermissions` (called only in guarded mode); the subagent's options use `chatSessionSettings(input.mode, posture)` and spread `chatBackendPosture(input.mode, input.config, posture)` into `nativeBackend`.
- `chatPermissionParagraph(mode)` — `packages/nax/src/prompts/builders/chat-builder.ts`
  - Target (US-005): the guarded sentence is the exact text given in US-005.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `askRules` or `denyRules` is not an array of non-empty strings | `parseNativeBackendOptions` (and so `nativeBackend()`) throws `AgentSessionError` code `AGENT_SESSION_INVALID_OPTIONS` whose message names the path (`backend.askRules...` / `backend.denyRules...`). |
| `askRules`, `denyRules`, `askOnUnsandboxed`, `askWhenSandboxDown` or `askDiscoveredTools` set on profile `none` or `read` | `nativePostureRules` throws `AGENT_SESSION_INVALID_OPTIONS` naming the option. |
| `askOnUnsandboxed: true` without `allowUnsandboxedCommands: true` | `nativePostureRules` throws `AGENT_SESSION_INVALID_OPTIONS` with path `backend.askOnUnsandboxed`. |
| `sandbox` fails `SandboxConfigSchema` | `parseNativeBackendOptions` throws `AGENT_SESSION_INVALID_OPTIONS` with a path starting `backend.sandbox`. |
| `hostPorts.commandShadow` lacks `observe`, `settle` or `drain` | `parseNativeBackendOptions` throws `AGENT_SESSION_INVALID_OPTIONS` with path `backend.hostPorts.commandShadow`. |
| Sandbox probe reports unavailable, or `execution.sandbox.enabled` is false, in guarded | Fail-safe: the session still opens (chat passes `allowUnsandboxed: true`), and every Bash command asks. |
| Resolved `bashApproval` is `raw` and the resolved `ask` or `deny` list holds a pattern-scoped `Bash(...)` rule | Kept as configured (raw does not consult it); `resolveTuiPermissions` logs one `warn` on stage `"permissions"` with the message `[tui] Bash(...) ask/deny patterns are not consulted under bashApproval "raw"`. |
| Resolved `bashApproval` is `escalate` for `tui` | Resolves to `gated`; `resolveTuiPermissions` logs one `warn` on stage `"permissions"` with the message `[tui] bashApproval "escalate" has no meaning in chat; using "gated"`. |
| `execution.commandSafety` absent, or present without `shadow` | `buildCommandShadow` returns `undefined`; the backend gets no `hostPorts` key and nothing is drained. |
| The session open fails after the shadow was built (`nativeBackend` throws, `createAgentSession`/`resumeAgentSession` rejects) | The shadow is drained and the lock released before the error propagates. |
| The shadow's classifier is unreachable | Existing `buildCommandShadow` behaviour (bounded by its own timeout; the guard never rejects); nothing new. |

## Out of Scope

- Full mode does not read `execution.permissions.tui` or `execution.commandSafety` and never asks; its only change is that its sandbox is built from `execution.sandbox`.
- `allow` and legacy `allowedTools` lists in `execution.permissions.tui` are not read: chat's `full` profile already grants every tool, so an allow list cannot widen anything.
- A `tui` block replaces the `default` block as a whole (existing block-lookup semantics): a `tui` block that sets only `bashApproval` does not inherit `default`'s `ask` or `deny` lists unless it names `inherit: "default"`.
- Under a resolved `bashApproval` of `raw`, pattern-scoped `Bash(...)` ask and deny rules are not consulted (ADR-030 raw pass-through, as in `nax run`); this feature does not change the raw Bash screen.
- `GitCommit` is not offered in chat sessions (it is declared only when the protected-paths policy carries git ignore patterns, which chat does not set), so a `GitCommit` ask rule matches nothing in chat; commits made through `Bash` follow the Bash posture.
- `Mcp(...)` rules in `execution.permissions.tui` are not expanded into concrete MCP tool rules for chat; the MCP asks in guarded chat are the non-read-only discovered-tool asks carried by `askDiscoveredTools`.
- `execution.permissionProfile` is not read by chat.
- The sandbox state is decided once when a session opens; a sandbox that becomes unavailable mid-session does not switch that session to asking until it is reopened (resume, `/mode` or `/model` switch).
- Subagent sessions do not receive a command shadow or the commandSafety guard; the subagent's own posture (bash mode, ask/deny rules, escape, sandbox-down and discovered-tool asks, sandbox config) is wired.
- The nax-agent `ask` profile, `askRulesFor`, `nativeProfileRules` and its return shape keep their behaviour; no embedder's options change meaning.
- The ACP server (`packages/nax-agent-acp`) session options are not changed.
- No TUI wording changes besides the instruction paragraph: the footer label, the `/mode` picker text (`asks before risky actions`) and `/mode` behaviour are unchanged.
- No migration of stored session metadata: a stored `bashApproval` is overwritten in memory at open and written only where it is written today.

## Stories

### US-001 — nax-agent: backend ask/deny rules and sandbox config

Workdir: packages/nax-agent. No dependencies.

`NativeBackendOptions` gains `askRules`, `denyRules` and `sandbox`. A new
`nativePostureRules` (new file `native-posture-rules.ts`) refuses them on tool-less profiles,
parses the rule lists with `parseRuleList` and parses `sandbox`; `openNative` adds the rules
after the profile's own and hands the parsed sandbox config to `resolveSessionLauncher`,
which falls back to `DEFAULT_SANDBOX_CONFIG` when absent. Test placement: session-level
integration ACs in a new `packages/nax-agent/test/unit/session/native-backend-posture.test.ts`;
`nativePostureRules` ACs in a new `packages/nax-agent/test/unit/session/native-posture-rules.test.ts`;
`parseNativeBackendOptions` ACs in the existing `native-backend-options.test.ts`;
`buildSessionToolSupport` and `resolveSessionLauncher` ACs in the existing `session-tool-support.test.ts`.

### US-002 — nax-agent: escape, sandbox-down and discovered-tool asks, command shadow port

Workdir: packages/nax-agent. Depends on US-001.

`NativeBackendOptions` gains `askOnUnsandboxed`, `askWhenSandboxDown`, `askDiscoveredTools`
and `hostPorts.commandShadow`, validated by `nativePostureRules`. An escape request asks even
under `raw` when `askOnUnsandboxed` is set; a sandbox that did not resolve `available` makes
every Bash ask when `askWhenSandboxDown` is set; `askDiscoveredTools` keeps the non-read-only
MCP asks under profile `full`; the command shadow reaches the tool runtime so its guard can
flag commands. Test placement: session-level integration ACs in a new
`packages/nax-agent/test/unit/session/native-backend-asks.test.ts`; `nativePostureRules` and
`effectiveBashApproval` ACs in `native-posture-rules.test.ts` (created by US-001);
`unsandboxedRuntimeOption` ACs in the existing `test/unit/coding-tools/coding-tool-extras.test.ts`;
`resolveUnsandboxedCall` ACs in the existing `test/unit/tools/runtime-unsandboxed.test.ts`;
`buildSessionToolSupport` and `parseNativeBackendOptions` ACs in their existing test files.

### US-003 — nax: resolve the `tui` permission posture

Workdir: packages/nax. No dependencies.

`resolveTuiPermissions(config)` in `src/config/permissions.ts` walks `execution.permissions.tui`
-> its `inherit` chain -> `default`, resolves `bashApproval` against the top-level value,
maps `escalate` to `gated` with one warning, and returns the block's `ask` and `deny` lists
verbatim. Exported from `@/config`.

### US-004 — nax: guarded chat and subagent sessions open with the resolved posture

Workdir: packages/nax. Depends on US-001, US-002, US-003.

`chatSessionSettings` takes the posture and opens the `full` profile in both modes;
`chatBackendPosture` builds the extra backend options; `openChatSession` and `runSubagent`
each resolve the posture once per open and pass it to `nativeBackend`; `openChatSession`
records the resolved `bashApproval` in the metadata.

### US-005 — nax: command shadow in guarded chat and the guarded instruction text

Workdir: packages/nax. Depends on US-004.

`openChatSession` builds the command shadow for guarded sessions, hands it to the backend,
and drains it on release and on a failed open. The guarded permission paragraph shared by the
chat and subagent instructions describes the new asks.

### Context Files

**US-001**
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/test/helpers/session-sandbox-deps.ts`
- `packages/nax-agent/test/helpers/agent-session.ts`

**US-002**
- `packages/nax-agent/src/session/native-posture-rules.ts` — created by US-001, extended here
- `packages/nax-agent/src/tools/runtime-calltool.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/test/helpers/session-sandbox-deps.ts`

**US-003**
- `packages/nax/src/config/permissions.ts`
- `packages/nax/src/config/index.ts`
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/test/unit/config/permissions.test.ts`

**US-004**
- `packages/nax/src/chat/chat-mode.ts`
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/chat/subagent-session.ts`
- `packages/nax/src/chat/index.ts`
- `packages/nax/test/unit/chat/open-chat-session.test.ts`

**US-005**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/interaction/dispatch-ask.ts`
- `packages/nax/src/prompts/builders/chat-builder.ts`
- `packages/nax/src/prompts/builders/agents-builder.ts`

### Creates

**US-001**
- `packages/nax-agent/src/session/native-posture-rules.ts`
- `packages/nax-agent/test/unit/session/native-backend-posture.test.ts`
- `packages/nax-agent/test/unit/session/native-posture-rules.test.ts`

**US-002**
- `packages/nax-agent/test/unit/session/native-backend-asks.test.ts`

### Modifies

**US-001**
None. Every new option is optional and absent keeps today's behaviour; `nativeProfileRules` and its return shape are unchanged, so its `toEqual` assertions in `native-backend-options.test.ts` keep passing.

**US-002**
None. `alwaysAsk` is added only when `askOnUnsandboxed` is true, and provider ask tools under profile `full` are added only when `askDiscoveredTools` is true, so every existing `unsandboxedRuntimeOption`, `resolveUnsandboxedCall` and `buildSessionToolSupport` expectation keeps its shape.

**US-003**
None. `resolvePermissions` and `stageRules` are unchanged and `lookupStageBlock` is file-local.

**US-004**
- `packages/nax/test/unit/chat/chat-mode.test.ts` — the `chatSessionSettings` cases call `chatSessionSettings(mode, posture)` with a posture `{ bashApproval: "raw", askRules: [], denyRules: [] }`; AC-2's expected guarded settings change from `{ profile: "ask", bashApproval: "gated", metaMode: "ask" }` to `{ profile: "full", bashApproval: "raw", metaMode: "ask" }`; AC-1's full expectation is unchanged; the `nextChatMode` and `chatModeOfMeta` cases are unchanged.
- `packages/nax/test/unit/chat/open-chat-session.test.ts` — the AC-1 guarded case expects `bashApproval` `"raw"` (the `makeNaxConfig` default `execution.bashApproval`) instead of `"gated"`; the AC-11 "persists injected id, ISO timestamp and ask metadata" case expects `bashApproval: "raw"` instead of `"gated"`, its other fields unchanged; the "explicit switches override mode and model" case expects `handle.meta.bashApproval` and the backend's `bashApproval` to be `"raw"` instead of `"gated"`, its `mode: "ask"` and stored-metadata assertions unchanged; the AC-2, AC-3 and AC-4 guarded cases are unchanged.
- `packages/nax/test/unit/chat/chat-host-resume.test.ts` — the recorded open order uses each open's `profile`, which is now `"full"` for guarded sessions: `["open:ask", "close", "open:full"]` becomes `["open:full", "close", "open:full"]`, `["open:ask", "close", "open:full", "open:ask"]` becomes `["open:full", "close", "open:full", "open:full"]`, and AC-13's `optionsSeen[2]` expects `profile: "full"`; the stored-metadata, `host.current().mode` and lock assertions are unchanged.
- `packages/nax/test/unit/chat/subagent-session.test.ts` — the `deps` literal assigned in the setup (typed `typeof _subagentSessionDeps`) gains `resolveTuiPermissions: mock(() => ({ bashApproval: "raw", askRules: [], denyRules: [] }))`, because every `runSubagent` case reads it in guarded mode and the literal must satisfy the widened deps type; AC-1 expects a guarded subagent to open profile `"full"` instead of `"ask"`; AC-3 expects a guarded subagent's `bashApproval` to be `"raw"` (the `makeNaxConfig` default) instead of `"gated"`; AC-2 and AC-4 (full mode) are unchanged.
- `packages/nax/test/unit/chat/host-subagents.test.ts` — AC-8 "a guarded host opens the nested session with profile ask" expects the nested session profiles to equal `["full"]` instead of `["ask"]` (and its title says profile full); the rest of the file is unchanged.

**US-005**
- `packages/nax/test/unit/prompts/builders/chat-builder.test.ts` — AC-3's expected guarded text changes from `edits, deletes, commits and every shell command are put to the person before they run` to the new guarded sentence in US-005; AC-4's full-mode assertions are unchanged.
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` — the full-string expectation at the `## Permission mode` section replaces the old guarded sentence with the new guarded sentence in US-005; the "contains the guarded permission paragraph" case's literal `In guarded mode, edits, deletes, commits` becomes `In guarded mode, commands run inside the sandbox` (its `chatPermissionParagraph("guarded")` assertion is unchanged).

### Seams

- US-001 -> US-002: `nativePostureRules` is created by US-001 and extended by US-002; US-002's ACs call it directly and through an opened session.
- US-001/US-002 -> US-004: the new `nativeBackend` options are consumed by `openChatSession` and `runSubagent`; their ACs inject `nativeBackend` and assert the options it receives.
- US-003 -> US-004: `resolveTuiPermissions` is consumed through `_openChatSessionDeps.resolveTuiPermissions` and `_subagentSessionDeps.resolveTuiPermissions`; the seam ACs stub it and call `openChatSession` / `runSubagent`.
- US-002 -> US-005: `hostPorts.commandShadow` is consumed by `openChatSession`; `buildCommandShadow` is consumed through `_openChatSessionDeps.buildCommandShadow`; the seam ACs stub it, call `openChatSession`, and assert its arguments and that its result reaches `nativeBackend`.

## Acceptance Criteria

### US-001 — nax-agent: backend ask/deny rules and sandbox config

- [integration] A session opened with profile `full`, `bashApproval: "raw"` and `askRules: ["Write(notes/**)"]` puts a `Write` call to `notes/a.md` to the session's ask port before the file is written.
- [integration] In that session, a `Write` call to `src/a.ts` (no ask rule matches) writes the file without reaching the ask port.
- [integration] A session opened with profile `full` and `denyRules: ["Delete(keep/**)"]` answers a `Delete` call on `keep/a.txt` with a denial, and `keep/a.txt` still exists afterwards.
- [integration] A session opened with profile `full`, `bashApproval: "raw"` and `denyRules: ["Bash"]` answers a `Bash` call with a denial and never reaches the ask port (an unconditional Bash deny holds under raw).
- [integration] A session opened with profile `full`, `askRules: ["Write(keep/**)"]` and `denyRules: ["Write(keep/**)"]` answers a `Write` to `keep/a.txt` with a denial and never reaches the ask port (deny wins over ask).
- [integration] A session opened with profile `full`, `bashApproval: "gated"` and `askRules: ["Write(notes/**)"]` still puts a `Bash` call to the ask port (the profile's `Bash(*)` ask is kept beside the configured rules).
- [unit] `parseNativeBackendOptions({ model: "openai/x", askRules: [""] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askRules`.
- [unit] `parseNativeBackendOptions({ model: "openai/x", denyRules: "Write" })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.denyRules`.
- [unit] `nativePostureRules("read", { model: "openai/x", askRules: ["Write"] })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askRules`.
- [unit] `nativePostureRules("none", { model: "openai/x", denyRules: ["Write"] })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.denyRules`.
- [unit] `nativePostureRules("review", { model: "openai/x", askRules: ["Bash(git push*)"] })` returns `askRules` equal to `[{ tool: "Bash", patterns: ["git push*"] }]`.
- [unit] `nativePostureRules("full", { model: "openai/x" })` returns `askRules` equal to `[]`.
- [unit] `nativePostureRules("full", { model: "openai/x" })` returns `denyRules` equal to `[]`.
- [unit] `buildSessionToolSupport` called with profile `full`, `bashApproval: "gated"` and `askRules: [{ tool: "GitCommit", patterns: ["*"] }]` hands `buildCodingToolSupport` ask rules whose last entry is that `GitCommit` rule and which also contain the `Bash` rule from `askRulesFor`.
- [unit] `resolveSessionLauncher` called with profile `full`, `allowUnsandboxed: true` and `config: { ...DEFAULT_SANDBOX_CONFIG, enabled: false }` returns `sandbox.kind` equal to `"disabled"` and an undefined `launcher`.
- [unit] `resolveSessionLauncher` called with profile `full` and no `config` hands `_sessionSandboxDeps.backendFor` a config equal to `DEFAULT_SANDBOX_CONFIG`.
- [unit] `resolveSessionLauncher` called with a `config` whose `network.allowedDomains` is `["registry.npmjs.org"]` hands `_sessionSandboxDeps.backendFor` a config whose `network.allowedDomains` equals `["registry.npmjs.org"]`.
- [unit] `parseNativeBackendOptions({ model: "openai/x", sandbox: { enabled: "yes" } })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.sandbox`.
- [integration] Opening a profile-`full` session through `nativeBackend({ model, sandbox: { network: { allowedDomains: ["registry.npmjs.org"] } }, allowUnsandboxed: true })` hands `_sessionSandboxDeps.backendFor` a config whose `enabled` equals `DEFAULT_SANDBOX_CONFIG.enabled` and whose `network.allowedDomains` equals `["registry.npmjs.org"]`.

### US-002 — nax-agent: escape, sandbox-down and discovered-tool asks, command shadow port

- [unit] `resolveUnsandboxedCall` for a `Bash` call with `unsandboxed: true` and option `{ enabled: true, bashApproval: "raw", alwaysAsk: true }` returns `kind: "unsandboxed"` with `asksOnAllow: true`.
- [unit] `resolveUnsandboxedCall` for the same call with option `{ enabled: true, bashApproval: "raw" }` returns `asksOnAllow: false`.
- [unit] `unsandboxedRuntimeOption({ unsandboxedCommands: true, bashApproval: "raw", askOnUnsandboxed: true })` returns `{ unsandboxed: { enabled: true, bashApproval: "raw", alwaysAsk: true } }`.
- [unit] `unsandboxedRuntimeOption({ unsandboxedCommands: true, bashApproval: "raw" })` returns `{ unsandboxed: { enabled: true, bashApproval: "raw" } }` with no `alwaysAsk` key.
- [integration] A session opened with profile `full`, `bashApproval: "raw"`, `allowUnsandboxedCommands: true` and `askOnUnsandboxed: true`, over a sandbox the stubbed `_sessionSandboxDeps.probe` reports available, puts a `Bash` call with `unsandboxed: true` and `unsandboxedReason: "needs network"` to the ask port, and the ask's `reason` contains `needs network`.
- [integration] In that session a `Bash` call without `unsandboxed` runs without reaching the ask port.
- [integration] The same session opened without `askOnUnsandboxed` runs the `unsandboxed: true` call without reaching the ask port.
- [unit] `nativePostureRules("full", { model: "openai/x", askOnUnsandboxed: true })` (no `allowUnsandboxedCommands`) throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askOnUnsandboxed`.
- [unit] `nativePostureRules("read", { model: "openai/x", askOnUnsandboxed: true })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askOnUnsandboxed`.
- [unit] `nativePostureRules("read", { model: "openai/x", askWhenSandboxDown: true })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askWhenSandboxDown`.
- [unit] `nativePostureRules("none", { model: "openai/x", askDiscoveredTools: true })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.askDiscoveredTools`.
- [unit] `effectiveBashApproval("raw", true, "unavailable")` returns `"gated"`.
- [unit] `effectiveBashApproval("raw", true, "available")` returns `"raw"`.
- [unit] `effectiveBashApproval("raw", false, "unavailable")` returns `"raw"`.
- [integration] A session opened with profile `full`, `bashApproval: "raw"`, `allowUnsandboxed: true` and `askWhenSandboxDown: true`, whose stubbed `_sessionSandboxDeps.probe` reports the sandbox unavailable, puts a plain `Bash` call to the ask port.
- [integration] A session opened with `askWhenSandboxDown: true`, `allowUnsandboxed: true` and `sandbox: { enabled: false }` puts a plain `Bash` call to the ask port.
- [integration] When `askWhenSandboxDown` turns the mode to gated, the native adapter's `openSession` receives `resolvedPermissions.bashApproval` equal to `"gated"`.
- [unit] `buildSessionToolSupport` called with profile `full`, `askDiscoveredTools: true` and provider tools whose `askTools` is `["docs__write"]` hands `buildCodingToolSupport` ask rules containing `{ tool: "docs__write", patterns: ["*"] }`.
- [unit] `buildSessionToolSupport` called with profile `full`, no `askDiscoveredTools`, and the same provider tools hands `buildCodingToolSupport` no ask rule for `docs__write`.
- [integration] A session opened with profile `full`, `bashApproval: "raw"` and `hostPorts.commandShadow` set to a fake shadow whose `guard.assess` flags every command puts a `Bash` call to the ask port.
- [integration] A session opened with `hostPorts.commandShadow` set to a fake shadow records one `observe` call on that shadow for a `Bash` call.
- [unit] `parseNativeBackendOptions({ model: "openai/x", hostPorts: { commandShadow: { observe() {}, settle() {} } } })` (no `drain`) throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `backend.hostPorts.commandShadow`.

### US-003 — nax: resolve the `tui` permission posture

- [unit] `resolveTuiPermissions(config)` with no `execution.permissions` and `execution.bashApproval: "raw"` returns exactly `{ bashApproval: "raw", askRules: [], denyRules: [] }`.
- [unit] With no `execution.permissions` and `execution.bashApproval: "gated"` it returns `bashApproval: "gated"`.
- [unit] With `execution.bashApproval: "raw"` and `execution.permissions.tui.bashApproval: "gated"` it returns `bashApproval: "gated"`.
- [unit] With no `tui` block and `execution.permissions.default.bashApproval: "gated"` it returns `bashApproval: "gated"`.
- [unit] With `execution.permissions.tui.ask: ["Write"]` and `execution.permissions.default.ask: ["Delete"]` it returns `askRules` equal to `["Write"]` (the `tui` block wins over `default`).
- [unit] With `execution.permissions.tui: { inherit: "run" }` and `execution.permissions.run.deny: ["Delete(src/**)"]` it returns `denyRules` equal to `["Delete(src/**)"]`.
- [unit] With `execution.permissions.tui.ask: ["Bash(git push*)", "Write(docs/**)"]` it returns `askRules` equal to `["Bash(git push*)", "Write(docs/**)"]`, in order.
- [unit] With `execution.permissions.tui.bashApproval: "escalate"` it returns `bashApproval: "gated"`.
- [unit] With top-level `execution.bashApproval: "escalate"` and no `execution.permissions` it returns `bashApproval: "gated"`.
- [unit] With `execution.bashApproval: "raw"` and `execution.permissions.tui.ask: ["Bash(git push*)"]` it logs exactly one `warn` on stage `"permissions"` whose message contains `not consulted`.
- [unit] With `execution.bashApproval: "raw"` and `execution.permissions.tui.ask: ["Write"]` it logs no `warn`.
- [unit] Resolving the `tui`-block `escalate` config logs exactly one `warn` on stage `"permissions"` whose message contains `escalate` and `tui`.
- [unit] With `execution.permissions.tui.allow: ["Bash(ls*)"]` the result's keys are exactly `bashApproval`, `askRules` and `denyRules`.
- [unit] `resolveTuiPermissions(undefined)` returns `{ bashApproval: "raw", askRules: [], denyRules: [] }`.
- [unit] `resolveTuiPermissions` is importable from `@/config` and is a function.
- [unit] With an `execution.permissions.tui` block carrying `bashApproval: "gated"` and `ask: ["Write"]`, `resolvePermissions(config, "run")` returns `bashApproval` equal to the top-level value and no `askRules` (the `tui` block never leaks into a pipeline stage).
- [integration] Loading a project config whose `execution.permissions.tui` is `{ "bashApproval": "gated", "ask": ["Write"], "deny": ["Delete(src/**)"] }` through the config loader succeeds, and `resolveTuiPermissions` on the loaded config returns that `bashApproval`, `askRules` and `denyRules`.

### US-004 — nax: guarded chat and subagent sessions open with the resolved posture

- [unit] `chatSessionSettings("guarded", { bashApproval: "raw", askRules: [], denyRules: [] })` returns `{ profile: "full", bashApproval: "raw", metaMode: "ask" }`.
- [unit] `chatSessionSettings("guarded", { bashApproval: "gated", askRules: [], denyRules: [] })` returns `{ profile: "full", bashApproval: "gated", metaMode: "ask" }`.
- [unit] `chatSessionSettings("full", { bashApproval: "gated", askRules: ["Write"], denyRules: [] })` returns `{ profile: "full", bashApproval: "raw", metaMode: "full" }`.
- [unit] `chatSessionSettings("guarded", undefined)` throws `NaxError` with code `CHAT_POSTURE_REQUIRED`.
- [unit] `chatBackendPosture("full", config, undefined)`, imported from `@/chat`, returns exactly `{ sandbox: config.execution.sandbox }`.
- [unit] `chatBackendPosture("guarded", config, { bashApproval: "raw", askRules: ["Write"], denyRules: ["Delete(src/**)"] })` returns exactly `{ sandbox: config.execution.sandbox, askRules: ["Write"], denyRules: ["Delete(src/**)"], askOnUnsandboxed: true, askWhenSandboxDown: true, askDiscoveredTools: true }`.
- [unit] `openChatSession` for a new guarded session calls the stubbed `_openChatSessionDeps.resolveTuiPermissions` exactly once, with `request.config`.
- [unit] When that stub returns `{ bashApproval: "gated", askRules: ["Write"], denyRules: [] }`, `openChatSession` calls the injected `nativeBackend` with options that include every key of `chatBackendPosture("guarded", request.config, stubResult)` with the same values.
- [unit] When that stub returns `bashApproval: "gated"`, `openChatSession` calls the injected `nativeBackend` with `bashApproval: "gated"`.
- [unit] `openChatSession` for a new guarded session calls the injected `createAgentSession` with `profile: "full"`.
- [unit] `openChatSession` for a new full session never calls the stubbed `resolveTuiPermissions`.
- [unit] `openChatSession` for a new full session calls the injected `nativeBackend` with options that carry none of the guarded-only posture keys (`askRules`, `denyRules`, `askOnUnsandboxed`, `askWhenSandboxDown`, `askDiscoveredTools`).
- [unit] `openChatSession` in both modes calls the injected `nativeBackend` with `sandbox` equal to `request.config.execution.sandbox`.
- [unit] A new guarded session opened with `execution.bashApproval: "raw"` writes metadata with `mode: "ask"` and `bashApproval: "raw"`.
- [unit] Resuming a stored guarded session whose metadata says `bashApproval: "gated"`, under a config whose posture resolves to `"raw"`, returns `handle.meta.bashApproval` equal to `"raw"`.
- [unit] `runSubagent` in guarded mode calls the stubbed `_subagentSessionDeps.resolveTuiPermissions` exactly once, with `input.config`.
- [unit] When that stub returns `{ bashApproval: "raw", askRules: ["Write"], denyRules: ["Delete(src/**)"] }`, `runSubagent` in guarded mode calls the injected `nativeBackend` with options that include every key of `chatBackendPosture("guarded", input.config, stubResult)` with the same values, and with `bashApproval: "raw"`.
- [unit] `runSubagent` in guarded mode calls the injected `createAgentSession` with `profile: "full"`.
- [unit] `runSubagent` in full mode calls the injected `nativeBackend` with options that carry none of the guarded-only posture keys (`askRules`, `denyRules`, `askOnUnsandboxed`, `askWhenSandboxDown`, `askDiscoveredTools`).
- [unit] `runSubagent` in full mode calls the injected `nativeBackend` with `sandbox` equal to `input.config.execution.sandbox`.
- [unit] `runSubagent` in guarded mode calls the injected `nativeBackend` with options that have no `hostPorts` key.

### US-005 — nax: command shadow in guarded chat and the guarded instruction text

- [unit] `openChatSession` for a guarded session calls the stubbed `_openChatSessionDeps.buildCommandShadow` once with `config` equal to `request.config.execution.commandSafety`, `outputDir` equal to `request.storage.dir` and `runId` equal to the session id.
- [unit] `openChatSession` for a guarded session calls `nativeBackend` with `hostPorts.commandShadow` equal to the shadow the `buildCommandShadow` stub returned.
- [unit] When the stubbed `buildCommandShadow` returns `undefined`, `openChatSession` calls `nativeBackend` with options that have no `hostPorts` key.
- [unit] `openChatSession` for a full session never calls `buildCommandShadow`.
- [unit] Calling the returned `handle.release()` for a guarded session with a fake shadow calls the shadow's `drain` before the storage lock is released (recorded call order: `drain`, then the lock release).
- [unit] When the injected `createAgentSession` rejects after the shadow was built, `openChatSession` rejects with that same error, after calling the shadow's `drain` exactly once and releasing the storage lock.
- [unit] When the injected `nativeBackend` throws after the shadow was built, `openChatSession` rejects with that same error, after calling the shadow's `drain` exactly once and releasing the storage lock.
- [unit] `chatPermissionParagraph("guarded")` returns exactly `In guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.`
- [unit] `buildChatInstructions({ mode: "guarded", rulesIndex: [] })` places that sentence in the `## Permission mode` section.
- [unit] `buildChatInstructions({ mode: "full", rulesIndex: [] })` returns text that includes `tools run without asking` and omits `put to the person before they run`.
