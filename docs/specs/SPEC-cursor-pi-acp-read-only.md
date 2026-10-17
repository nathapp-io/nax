# SPEC: Cursor and pi over ACP — read-only enforcement, and nax's permission rules for ACP shell commands

Closes: #2372

## Summary

Register Cursor's agent (`cursor-agent acp`) as an ACP agent and give Cursor and pi read-only enforcement for profiles `none`, `read` and `review`. Two parts of nax's existing per-stage permission rules (`execution.permissions.<stage>.allow / deny / ask`, the grammar native sessions use) now reach ACP sessions. **Read-tool deny rules** are translated into each rule-capable agent's own config (opencode, Cursor, pi). **Bash rules** are applied by nax itself: under `review`, an agent's shell command that asks nax runs when every segment matches an operator `Bash` allow rule, none matches a deny or ask rule, and it has no redirect or construct nax cannot read, the same lexer guard native sessions use. Under `none` and `read` no shell command ever runs. pi gains the ask path through a nax-written pi extension that turns each bash call into a permission request. With no rules configured every agent behaves as today.

## Motivation

nax#2372 asks for read-only support on every ACP agent. Claude, codex, opencode and gemini are done; pi is refused `read` and `none`, and Cursor is not registered. The operator asked that read-only enforcement be configurable rather than a fixed harness, and nax already has the configuration surface: `resolvePermissions` turns `execution.permissions.<stage>` into `toolGrants`, `denyRules` and `askRules` on `ResolvedPermissions`, which every `OpenSessionOpts` carries, but the ACP path reads only the resolved mode.

Live probes on 2026-10-17 (cursor-agent 2026.10.16, opencode 2.0.27, pi 0.84.3 through pi-acp 0.0.34) settled the mechanisms:

- **Cursor's modes do not enforce** (mode `ask`: a forced write succeeded; mode `plan`: the model switched itself back to `agent` and wrote). **Its permission config does**: with `CURSOR_CONFIG_DIR` pointing at a fresh directory holding `cli-config.json` that allows `Read(**)` and denies `Write(**)`, `Delete(**)`, `Mcp(*:*)` and `WebFetch(*)`, writes failed with "Blocked by permissions configuration" and login still worked; adding `Shell(*)` to `deny` blocked shell; leaving it out made every shell command ask the client; denying `Read(**)` blocked reads. Cursor's permission requests carry the command only in the title, in backticks (`` `git status --short` ``), after Cursor's own hooks have rewritten it.
- **Cursor's sandbox does not hold over ACP**: with `"sandbox": {"mode": "enabled"}` an approved command wrote inside and outside the working directory and reached the network.
- **Translating Bash allows into an agent's config opens a write path**: Cursor `Shell(echo)` and opencode `"echo *": "allow"` both let `echo hi > shell.txt` write a file, because the agents match the command text and know nothing of redirects. nax's own lexer refuses a redirect, so the decision belongs in nax.
- **opencode** sends the command in `rawInput.command`; a rejected command lets the model continue.
- **pi has no permission system**, but its extension API can block a tool call, and pi-acp turns an extension `confirm` prompt into an ACP permission request (kind `other`, options `yes` allow-once / `no` reject-once, `rawInput` carrying `method`, `title` and `message`). A probe extension doing this for every bash call worked: reject blocked the call and the model continued; allow ran it. pi's tool allowlist (`pi --tools read,grep,find,ls`, or `--no-tools`) held against a project `.pi/settings.json`. pi-acp starts `pi --mode rpc --no-themes` and lets `PI_ACP_PI_COMMAND` replace the executable.
- **Cursor model ids carry settings** (`claude-sonnet-5-5[context=300k,reasoning_effort=high]`; Auto is `default[]`), so a configured bare name never matches exactly today.

## Design

### Integration

Symbols read, unchanged:

- `ResolvedPermissions` (`packages/nax-agent/src/permissions/types.ts`): `mode`, `toolGrants?`, `denyRules?`, `askRules?` (each `readonly ToolGrant[]`, a `ToolGrant` being `{ tool: string; patterns: readonly string[] }`, unconditional when `patterns` is exactly `["*"]`), and the required `bashApproval`.
- `compileArgvPattern(pattern)`, `matchesArgvPattern(compiled, argv)` and `CompiledPattern` (`packages/nax-agent/src/tools/policy-match.ts`): nax's native per-token prefix matching for `Bash(...)`/`Exec(...)` grants; exported from `@nathapp/nax-agent` by US-006.
- `lexBashCommand(command): BashLexResult` (exported from `@nathapp/nax-agent`): `{ kind: "ok"; segments }` or `{ kind: "refused"; ... }`; a `BashSegment` has `tokens: { text; opaque }[]` and `redirects: { operator; target; opaque }[]`.
- `describeToolCall` (`tool-display.ts`), `offeredOptions`, `rejectWith`, `REVIEW_NO_SANDBOX_REASON`, `REVIEW_EXECUTE_REASON` (`permissions.ts`).
- `OPENCODE_NONE_CONFIG`, `OPENCODE_READ_CONFIG`, `OPENCODE_REVIEW_CONFIG` (`registry.ts`): remain exactly what opencode gets with no read-tool deny rule.
- `cleanLabel` (`text.ts`), `globalConfigDir()` (`packages/nax/src/config/paths`).

Symbols changed. The baseline locates the code; the target is the interface to implement.

- `AcpAgentName` — Baseline: `"claude" | "codex" | "gemini" | "opencode" | "pi"`. Target: adds `"cursor"`; `ACP_AGENT_NAMES` lists it after `"codex"`.
- `ReadOnlyEnforcement` (`registry.ts`) — Baseline: `{ mode, disallowedTools, sessionOptions, launchEnv }`. Target: adds `policy: "opencode" | "cursor" | "pi" | undefined`, naming the rule-policy translator that builds the agent's launch env (opencode: `"opencode"`; cursor: `"cursor"`; pi: `"pi"`; others `undefined`).
- `isReadOnlyProfile` (`capabilities.ts`) — Baseline: a module-local `const`. Target: exported, unchanged behaviour.
- `AcpBackendOptions` / `ResolvedAcpOptions` (`options.ts`) — Target: options gain `rules?: { allow?: AcpRule[]; deny?: AcpRule[]; ask?: AcpRule[] }` and `stateDir?: string` (absolute); resolved options gain `rules: AcpPermissionRules` (`NO_RULES` when unset) and `stateDir: string` (default `join(tmpdir(), "nax-agent-acp")`).
- `openAcpSession` (`open.ts`) — Baseline: `const env = { ...options.env, ...launchEnvFor(ctx.profile, options.entry) }`. Target: `const env = { ...options.env, ...(await policyLaunchEnv(ctx.profile, options)) }`, before the launch; a rejection refuses the open without launching.
- `applyModel` (`open.ts`) — Target: resolves the requested model through `resolveModelValue` before the config-option and legacy lookups.
- `PermissionContext` (`permissions.ts`) — Target: gains optional `agentName?: string` and `rules?: AcpPermissionRules` (absent: no Bash rule allows anything, and `shellCommandOf` uses the generic `rawInput.command` source), so existing callers and the permission tests that build context literals compile unchanged; `routerFor(ctx, secrets, entry)` in `backend.ts` gains the resolved options' `agentName` and `rules` (its call site already has `options` in scope) and fills both.
- `decidePermission` (`permissions.ts`), `review` branch — Baseline: kind `execute` with a sandbox policy allows, without one denies with `REVIEW_NO_SANDBOX_REASON`; every other kind denies. Target: unchanged when a sandbox policy is present. Without one: a request whose `shellCommandOf(agentName, toolCall)` is defined and whose `shellRuleVerdict(command, rules)` is `"allow"` is allowed with `SHELL_RULE_REASON` when the agent offered an allow-once option, and otherwise denied as today's missing-allow-once path does (`NO_ALLOW_ONCE_REASON`); a request with a defined command and a `"deny"` verdict, and an `execute` request with no derivable command, are denied with `REVIEW_NO_SANDBOX_REASON`; any other request (an `edit`, or kind `other` that is not the pi gate) is denied with `readOnlyReason("review")`, as today.
- `backendOptions` (`packages/nax/src/agents/acp/open-context.ts`) — Target: adds `rules` from `opts.resolvedPermissions` and `stateDir: join(globalConfigDir(), "acp")`.
- `KNOWN_AGENT_NAMES` (`packages/nax/src/agents/registry.ts`) and the ACP `ENTRIES` table (`packages/nax/src/agents/acp/entries.ts`) — Target: both gain `cursor`.

### Module `packages/nax-agent-acp/src/client/rule-policy.ts` (US-002, extended by US-004)

```ts
export interface AcpRule { readonly tool: string; readonly patterns: readonly string[] }
export interface AcpPermissionRules {
  readonly allow: readonly AcpRule[];
  readonly deny: readonly AcpRule[];
  readonly ask: readonly AcpRule[];
}
export const NO_RULES: AcpPermissionRules;
export function opencodePermissionConfig(profile: "none" | "read" | "review", rules: AcpPermissionRules): string;
export function cursorCliConfig(profile: "none" | "read" | "review", rules: AcpPermissionRules): string; // US-004
export function piToolArgs(profile: "none" | "read" | "review", rules: AcpPermissionRules, gatePath: string): readonly string[]; // US-004
export function policyLaunchEnv(profile: AgentSessionProfile, options: ResolvedAcpOptions): Promise<Readonly<Record<string, string>>>;
```

`policyLaunchEnv` returns `launchEnvFor(profile, entry)` unchanged for profiles `full` and `ask`, for entries whose `readOnly.policy` is `undefined`, and for custom agents. Otherwise it dispatches on `readOnly.policy`.

**Read-tool deny translation** (profiles `read` and `review`; under `none` the rules are ignored). Only an unconditional deny (`patterns: ["*"]`) of `Read`, `Glob` or `Grep` is translated; every other rule is ignored by this translation (Bash rules are applied by nax, below; write-tool rules can never widen a read-only profile).

| nax rule | opencode `permission` | Cursor `cli-config.json` | pi `--tools` |
|:--|:--|:--|:--|
| none of these | `OPENCODE_READ_CONFIG` / `OPENCODE_REVIEW_CONFIG`, byte-identical | allow `Read(**)` | `read,grep,find,ls` |
| `Read` unconditional deny | drops `read` and `list` | `Read(**)` leaves allow and joins deny | drops `read` |
| `Glob` unconditional deny | drops `glob` | no change | drops `find` and `ls` |
| `Grep` unconditional deny | drops `grep` | no change | drops `grep` |

- **opencode** keeps today's `bash`: absent under `read` (no shell tool), `"ask"` under `review` (every command asks nax).
- **Cursor** `{"version":1,"permissions":{"allow":[...],"deny":[...]},"approvalMode":"allowlist"}`. `allow` is `["Read(**)"]`, or `[]` when Read is denied. `deny` is `Write(**)`, `Delete(**)`, `Mcp(*:*)`, `WebFetch(*)`, then `Shell(*)` under `read`, then `Read(**)` when Read is denied. Under `none`: allow `[]`, deny `Write(**)`, `Delete(**)`, `Mcp(*:*)`, `WebFetch(*)`, `Shell(*)`, `Read(**)`. Under `review` shell is unlisted, so every command asks nax.
- **pi** `piToolArgs` returns `["--no-tools"]` under `none`. Otherwise the list is built in the order `read,grep,find,ls` minus the denied tools; under `review`, when `rules.allow` holds any `Bash` rule, `bash` is appended and `["-e", gatePath]` is prepended, so every bash call goes through the nax shell gate. The result is `["--no-tools"]` only when the final list is empty, else `["--tools", "<list>"]`.

### Module `packages/nax-agent-acp/src/client/shell-rules.ts` (US-003)

```ts
export const SHELL_RULE_REASON = "an operator Bash rule allows this command";
export const PI_SHELL_GATE_TITLE = "nax: run shell command";
/** Source of the pi extension that turns each bash call into a confirm prompt (written to disk by US-004). */
export const PI_SHELL_GATE_SOURCE: string;
export function shellCommandOf(agentName: string, toolCall: unknown): string | undefined;
export function shellRuleVerdict(command: string, rules: AcpPermissionRules): "allow" | "deny";
```

- **`shellCommandOf`**: for `pi`, a tool call of kind `other` whose `rawInput.method` is `"confirm"`, `rawInput.title` is `PI_SHELL_GATE_TITLE` and `rawInput.message` is a non-empty string yields that message; for `cursor`, a tool call of kind `execute` whose `title` is a non-empty string yields the title with one enclosing pair of backticks removed; for every other agent, a tool call of kind `execute` whose `rawInput.command` is a non-empty string yields it. Anything else yields `undefined`. The raw value is used (not the secret-masked display text).
- **`shellRuleVerdict`**: `lexBashCommand(command)`; `"deny"` when the lexer refuses, when it yields no segment, when any segment has a redirect, or when any token is opaque. A segment's argv is its token texts. A segment is allowed when the argv matches a pattern of some `Bash` rule in `rules.allow` and matches no pattern of any `Bash` rule in `rules.deny` or `rules.ask` (no person answers an ACP read-only session, so `ask` denies). Matching is nax's native argv matching, reused from nax-agent's public entry (US-006): a pattern matches when `matchesArgvPattern(compileArgvPattern(pattern), argv)` is true (each whitespace-separated pattern token is a glob matched against the argv token at the same position, and the pattern tokens are a prefix of argv), and the pattern `*` alone matches every segment. Native's payload checks (denied flags, path containment) are not applied to ACP commands. The verdict is `"allow"` only when every segment is allowed.
- `PI_SHELL_GATE_SOURCE` is the pi gate extension source: a pi extension that, on `tool_call` for tool `bash`, blocks the call when the session has no UI, else asks `ctx.ui.confirm(PI_SHELL_GATE_TITLE, command)` and blocks the call with reason `"nax: shell command rejected"` unless it returns true.

### Policy files (US-004)

`src/client/policy-files.ts` exports `writeCursorPolicy(stateDir, content): Promise<string>`, `writePiFile(stateDir, name, content, mode): Promise<string>` and `_policyFilesDeps` (`mkdir`, `writeFile`, `rename`, `chmod`, from `node:fs/promises`; no Bun API in this package).

- **Content-addressed.** `<h>` is the first 16 hex characters of the SHA-256 of the file content. Cursor: `<stateDir>/cursor/<h>/cli-config.json`, returning the directory. pi: `<stateDir>/pi/<name>-<h><ext>` for the gate extension (`shell-gate`, `.ts`) and the wrapper (`wrapper`, `.sh`), returning the file path.
- **Atomic, every launch.** Each file is written to a temporary name in its target directory and renamed over the target, on every launch (Cursor rewrites its config itself, and a rewrite replaces a planted or half-written file). Directories are created recursively with mode `0o700`; `chmod` sets `0o600` on Cursor's config and the gate extension and `0o700` on the wrapper, on the temporary file before the rename.
- **Launch env.** Cursor: `{ CURSOR_CONFIG_DIR: <dir> }`. pi: the gate extension is written first (under `review` with a `Bash` allow rule), then the wrapper `#!/bin/sh\nexec <pi> <args> "$@"\n`, `<pi>` being the caller's `PI_ACP_PI_COMMAND` from `options.env` or else `pi`, and `<args>` `piToolArgs(...)`, every word single-quoted for `sh` (a `'` inside becomes `'\''`); env `{ PI_ACP_PI_COMMAND: <wrapper path> }`. opencode: `{ OPENCODE_CONFIG_CONTENT: opencodePermissionConfig(profile, rules) }`, no file.
- The env is spread over the caller's, so a caller cannot weaken it.

### Cursor registration and model ids (US-001)

- Registry entry `cursor`: launch `[local("cursor-agent", "acp")]`, `authEnv: ["CURSOR_API_KEY"]`, `readOnly: { mode: { configId: "mode", value: "ask" }, disallowedTools: [], sessionOptions: {}, launchEnv: {} }` (US-002 adds the `policy` field, US-004 sets it to `"cursor"`), `defaultMode: undefined`, `preApproval: undefined`. Mode `ask` only tells the model it is read-only; mode `plan` is never used.
- `resolveModelValue(agentName, offered, requested, secrets)` (`capabilities.ts`): returns `requested` when it is offered or the agent is not `cursor`; for `cursor`, the single offered value starting with `requested + "["`; several matches throw `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `model`, naming every match passed through `cleanLabel(id, secrets, …)`; no match returns `requested` (the existing refusal follows). `applyModel` calls it with the config-option values of category `model` when any are offered, else with the legacy model ids.

### nax wiring (US-005)

- `backendOptions` passes `rules: { allow: toolGrants ?? [], deny: denyRules ?? [], ask: askRules ?? [] }` from `opts.resolvedPermissions` and `stateDir: join(globalConfigDir(), "acp")`.
- `KNOWN_AGENT_NAMES` and `ENTRIES` gain `cursor` (`binary: "cursor-agent"`, `displayName: "Cursor Agent (ACP)"`, tiers `fast`/`balanced`/`powerful`, `maxContextTokens: 200_000`).
- `docs/guides/permissions.md` gains an "ACP agents" section: read-tool deny translation per agent, the Bash-rule decision under `review` for agents without nax's sandbox (Claude keeps its sandboxed review), that an allowed command runs on the host unsandboxed, that Cursor matches what its own hooks rewrote, and the pi gate. `docs/guides/configuration.md` links it.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| A policy file cannot be written (any `_policyFilesDeps` call rejects) | Open refused with `AGENT_SESSION_BACKEND_UNAVAILABLE`, naming the path; the agent is never launched. |
| `stateDir` is not absolute | `acpBackend()` throws `AGENT_SESSION_INVALID_OPTIONS`, path `stateDir`. |
| A rule's `patterns` is empty or has a non-string element | `acpBackend()` throws `AGENT_SESSION_INVALID_OPTIONS`, path within `rules`. |
| A shell command the lexer refuses, or with a redirect or opaque token | `shellRuleVerdict` returns `"deny"`; the request is denied with `REVIEW_NO_SANDBOX_REASON`. |
| Under `review`, an allow verdict but the agent offered no allow-once option | Denied with `NO_ALLOW_ONCE_REASON` (today's path). |
| Cursor model alias matches several offered ids | Open refused, capability `model`, every match named. |

## Out of Scope

- A live check of the shipped code against real Cursor, pi and opencode processes: a maintainer step after merge.
- An OS sandbox for opencode, Cursor or pi shell commands (pi's sandbox-runtime extension, or sandboxing the agent process): a follow-up issue; until then an allowed `review` command runs unsandboxed.
- A repository's own `.cursor/cli.json` permission rules, which Cursor merges and whose allow rules override the isolated config's denies (probed); nax does not detect or refuse them (accepted 2026-10-17).
- Cursor hooks from the operator's own Cursor configuration, which still run and can rewrite a command before nax sees it (probed: `ls` arrived as `rtk ls -la`).
- Translating any Bash rule into an agent's own config, and `Mcp(...)`, path-scoped `Read(...)`/`Write(...)`, `Git`, `RunCommand` or `Exec` rules for any ACP agent.
- Read-tool rule translation for Claude, codex and gemini; Bash-rule decisions for them apply only where they send an `execute` permission request without nax's sandbox.
- Stopping pi's installed extensions from loading (their tools are filtered by `--tools`; their code still runs).
- Cursor persisting the selected model as its default in the operator's own `~/.cursor` under profiles `full` and `ask`.
- Removing stale content-addressed policy files under the state directory, and protecting a state directory owned by another user: the trust boundary is the state directory's owner.
- Windows: the pi wrapper is a POSIX `sh` script.
- Pricing for Cursor model ids.
- Updating `.nax/mono/packages/nax-agent-acp/context.md` for Cursor and pi: a manual step after merge, since `.nax/` is read-only to the run.

## Stories

Integration ACs open sessions the way the existing backend tests do: `createAgentSession` over `acpBackend({ agent, allowUnsandboxed: true, command: "fake-<agent>", ... })` with the in-memory fake (`_acpBackendDeps.launch`), reading the launch env from `o.fake.requests[0]?.env`.

### US-001: register Cursor and resolve Cursor model aliases

Workdir: `packages/nax-agent-acp`. No dependencies.

Add `"cursor"` to `AcpAgentName`, the options schema's agent enum and the registry (launch `cursor-agent acp`, auth `CURSOR_API_KEY`, read-only mode `ask`, no default mode, no pre-approval). Add `resolveModelValue` to `capabilities.ts` and apply it in `applyModel` for config-option and legacy model offers. Export `CURSOR_CONFIG_OPTIONS` from the fake agent's script module.

### US-002: permission rules option and read-tool translation for opencode

Workdir: `packages/nax-agent-acp`. No dependencies.

Add `rules` and `stateDir` to the backend options with zod validation, add `policy` to `ReadOnlyEnforcement` (opencode `"opencode"`), export `isReadOnlyProfile`, create `src/client/rule-policy.ts` (`AcpRule`, `AcpPermissionRules`, `NO_RULES`, `opencodePermissionConfig`, `policyLaunchEnv`) and make `openAcpSession` launch with `policyLaunchEnv`. With no read-tool deny rule, opencode's launch env is byte-identical to today. Export the new types from `./client` and update the API snapshot.

### US-003: nax decides ACP shell commands under review from the Bash rules

Workdir: `packages/nax-agent-acp`. Depends on US-001, US-002, US-006.

Create `src/client/shell-rules.ts` (`SHELL_RULE_REASON`, `PI_SHELL_GATE_TITLE`, `PI_SHELL_GATE_SOURCE`, `shellCommandOf`, `shellRuleVerdict`). Add `agentName` and `rules` to `PermissionContext`, fill them in `routerFor`, and extend the `review` branch of `decidePermission` as the Design states. Profiles `none`, `read`, `full` and `ask`, and `review` with a sandbox policy, decide exactly as today.

### US-004: Cursor and pi policies

Workdir: `packages/nax-agent-acp`. Depends on US-001, US-002, US-003.

Add `cursorCliConfig` and `piToolArgs` to `rule-policy.ts`, create `src/client/policy-files.ts` (`writeCursorPolicy`, `writePiFile`, `_policyFilesDeps`), and extend `policyLaunchEnv` for `policy: "cursor"` (`CURSOR_CONFIG_DIR`) and `policy: "pi"` (wrapper, plus the gate extension under `review` with a Bash allow rule, via `PI_ACP_PI_COMMAND`). Set the cursor entry's `policy` to `"cursor"` and give pi `readOnly: { mode: undefined, disallowedTools: [], sessionOptions: {}, launchEnv: {}, policy: "pi" }`.

### US-005: nax passes its permission rules to ACP sessions and lists Cursor

Workdir: `packages/nax`. Depends on US-001, US-002, US-003, US-004, US-006.

`backendOptions` passes `rules` from `opts.resolvedPermissions` and `stateDir` under `globalConfigDir()`. Add `cursor` to `KNOWN_AGENT_NAMES`, the ACP entries table and the `agent.acp` config description. Update the `profile-map.ts` header comment (pi is no longer refused `read`). Document ACP agents in `docs/guides/permissions.md` and link it from `docs/guides/configuration.md`.

### US-006: export nax's argv matcher from nax-agent

Workdir: `packages/nax-agent`. No dependencies.

Export `compileArgvPattern`, `matchesArgvPattern` and the `CompiledPattern` type from `src/index.ts` (the `.` entry), unchanged, so nax-agent-acp can match Bash rules exactly as native sessions do, and regenerate `api/nax-agent.api.txt` with `bun run api:update`.

### Context Files

**US-001**

- `packages/nax-agent-acp/src/client/registry.ts` — entry shapes, `entry`, `local`
- `packages/nax-agent-acp/src/client/open.ts` — `applyModel`, `offeredModels`
- `packages/nax-agent-acp/src/client/capabilities.ts` — `modelOptionId`
- `packages/nax-agent-acp/test/unit/client/backend-gemini.test.ts` — fake-agent pattern for legacy models
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — `FakeScript`, option fixtures

**US-002**

- `packages/nax-agent-acp/src/client/options.ts` — schema, `resolved`
- `packages/nax-agent-acp/src/client/open.ts` — `openAcpSession`
- `packages/nax-agent-acp/src/client/capabilities.ts` — `launchEnvFor`, `isReadOnlyProfile`
- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts` — launch-env assertions
- `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts` — the relaunch path

**US-003**

- `packages/nax-agent-acp/src/client/permissions.ts` — `decidePermission`, `PermissionContext`
- `packages/nax-agent-acp/src/client/backend.ts` — `routerFor`
- `packages/nax-agent-acp/src/client/tool-display.ts` — `describeToolCall`, `commandSource`
- `packages/nax-agent/src/permissions/bash-lex.ts` — `lexBashCommand`, `BashSegment`
- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts` — the `RUN` permission step and approval-event assertions

**US-004**

- `packages/nax-agent-acp/src/client/rule-policy.ts` — created by US-002, extended here
- `packages/nax-agent-acp/src/client/shell-rules.ts` — created by US-003; `PI_SHELL_GATE_TITLE`, `PI_SHELL_GATE_SOURCE`
- `packages/nax-agent-acp/src/server/default-model.ts` — temp-file-and-rename precedent
- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts` — open/launch-env pattern
- `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` — the refusal tests that used pi

**US-005**

- `packages/nax/src/agents/acp/open-context.ts` — `backendOptions`
- `packages/nax/src/agents/acp/entries.ts` — `ENTRIES`
- `packages/nax/src/agents/registry.ts` — `KNOWN_AGENT_NAMES`
- `packages/nax/test/unit/agents/acp/open-context.test.ts` — `OPTS` (carries `bashApproval`)
- `docs/guides/permissions.md` — rule grammar and precedence

**US-006**

- `packages/nax-agent/src/tools/policy-match.ts` — `compileArgvPattern`, `matchesArgvPattern`, `CompiledPattern`
- `packages/nax-agent/src/index.ts` — the `.` entry

### Creates

**US-001**

- `packages/nax-agent-acp/test/unit/client/backend-cursor.test.ts`

**US-002**

- `packages/nax-agent-acp/src/client/rule-policy.ts`
- `packages/nax-agent-acp/test/unit/client/rule-policy.test.ts`

**US-003**

- `packages/nax-agent-acp/src/client/shell-rules.ts`
- `packages/nax-agent-acp/test/unit/client/shell-rules.test.ts`
- `packages/nax-agent-acp/test/unit/client/backend-shell-rules.test.ts`

**US-004**

- `packages/nax-agent-acp/src/client/policy-files.ts`
- `packages/nax-agent-acp/test/unit/client/policy-files.test.ts`
- `packages/nax-agent-acp/test/unit/client/backend-policy.test.ts`

### Modifies

**US-001**
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the test asserting ACP_AGENT_NAMES equals the five current names gains cursor after codex; a cursor entry test is added.
- `packages/nax-agent-acp/test/node/registry.test.ts` — the vitest assertion that ACP_AGENT_NAMES has length 5 becomes length 6.
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — exports CURSOR_CONFIG_OPTIONS: a mode option (values agent, plan, ask) and a model option (values default[], claude-sonnet-5-5[context=300k,reasoning_effort=high], claude-sonnet-5-5[context=300k,reasoning_effort=low], gpt-5.5[context=272k,reasoning=medium]); no existing export changes.

**US-002**
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the opencode entry test asserts the exact entry, so its expected readOnly gains policy opencode.
- `packages/nax-agent-acp/api/nax-agent-acp.api.txt` — API snapshot regenerated for the new exports.

**US-003**
None. US-003 adds shell-rules and its tests and changes only source files (permissions.ts, backend.ts); the new PermissionContext fields are optional, so the permission and elicitation tests that build context literals compile unchanged, and absent rules decide exactly as today.

**US-004**
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — three tests change: the cursor entry test (added by US-001) asserts the exact entry, so its expected readOnly gains policy cursor; the pi entry test asserts readOnly undefined and is titled "no read-only enforcement", so it asserts the new readOnly instead; the loop "every entry with read-only enforcement sets a mode or a launch env for none, read and review" fails for pi (no mode, empty launch env), so its invariant becomes "a mode, a launch env for none, read and review, or a policy".
- `packages/nax-agent-acp/test/unit/client/capabilities.test.ts` — the test asserting readOnlyFor none on the pi entry is undefined switches to a custom agent (no registry entry), keeping the invariant that an agent without enforcement yields undefined.
- `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` — the test opening agent pi to show read and none are refused after initialize on an agent without read-only enforcement switches to a custom agent spec, keeping that invariant.

**US-005**
- `packages/nax/test/unit/agents/acp/entries.test.ts` — the test asserting the sorted ACP_AGENT_NAMES equals the five current names gains cursor.
- `packages/nax/test/unit/agents/acp/open-context.test.ts` — US-005's backendOptions acceptance tests are added; the existing tests use partial matching and do not change.

**US-006**
- `packages/nax-agent/api/nax-agent.api.txt` — API snapshot regenerated for the three new `.` exports.

### Seams

- US-001: `resolveModelValue` is consumed by `applyModel`; the seam ACs enter at `createAgentSession` with `acpBackend({ agent: "cursor", model })` and assert the recorded `session/set_config_option` / `session/set_model` value.
- US-002: `policyLaunchEnv` and `opencodePermissionConfig` are consumed by `openAcpSession`; the seam ACs enter at `createAgentSession` with `acpBackend({ agent: "opencode", rules })` and assert the recorded launch env.
- US-003: `shellCommandOf` and `shellRuleVerdict` are consumed by `decidePermission`; the seam ACs enter at `createAgentSession` with `acpBackend({ agent, rules })`, profile `review`, a fake turn that sends a permission request, and assert the recorded answer and the `approval_requested` reason.
- US-004: `cursorCliConfig`, `piToolArgs`, `writeCursorPolicy` and `writePiFile` are consumed by `policyLaunchEnv`; the seam ACs enter at `createAgentSession` with `acpBackend({ agent: "cursor", rules, stateDir })` or `acpBackend({ agent: "pi", rules, stateDir })` and assert the recorded launch env.
- US-006: `compileArgvPattern` and `matchesArgvPattern` (new `.` exports) are consumed by `shellRuleVerdict` in US-003; US-003's verdict ACs exercise them through `shellRuleVerdict`.
- US-005: `backendOptions` passes rules into `acpBackend`; its ACs call `backendOptions` with `OpenSessionOpts` carrying rules and pass the result to `acpBackend` (the open path from `SessionManager.openSession` to `backendOptions` is unchanged).

## Acceptance Criteria

### US-001

1. [unit] `registryEntry("cursor")` equals `{ name: "cursor", launch: [{ command: "cursor-agent", args: ["acp"] }], readOnly: { mode: { configId: "mode", value: "ask" }, disallowedTools: [], sessionOptions: {}, launchEnv: {} }, defaultMode: undefined, preApproval: undefined, authEnv: ["CURSOR_API_KEY"] }`.
2. [unit] `ACP_AGENT_NAMES` equals `["claude", "codex", "cursor", "gemini", "opencode", "pi"]`.
3. [unit] `acpBackend({ agent: "cursor", allowUnsandboxed: true })` does not throw, and its `kind` is `"acp:cursor"`.
4. [unit] `resolveAcpOptions({ agent: "cursor", allowUnsandboxed: true, env: {} }, { CURSOR_API_KEY: "k", OTHER: "x" })` returns an `env` with `CURSOR_API_KEY` `"k"` and no `OTHER` key.
5. [unit] `resolveModelValue("cursor", ["default[]", "gpt-5.5[context=272k]"], "gpt-5.5", [])` returns `"gpt-5.5[context=272k]"`.
6. [unit] `resolveModelValue("cursor", ["default[]", "gpt-5.5"], "gpt-5.5", [])` returns `"gpt-5.5"` (an exact offer wins).
7. [unit] `resolveModelValue("cursor", ["a[x=1]", "a[x=2]"], "a", [])` throws an `AgentSessionError` with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and capability `model` whose message names `a[x=1]` and `a[x=2]`.
8. [unit] `resolveModelValue("cursor", ["default[]"], "gpt-5.5", [])` returns `"gpt-5.5"`.
9. [unit] `resolveModelValue("gemini", ["gpt-5.5[context=272k]"], "gpt-5.5", [])` returns `"gpt-5.5"`.
10. [unit] `resolveModelValue("cursor", ["gpt-5.5-mini[x=1]"], "gpt-5.5", [])` returns `"gpt-5.5"`.
11. [unit] `resolveModelValue("cursor", ["k[s=SECRET1]", "k[s=2]"], "k", ["SECRET1"])` throws with a message that does not include `SECRET1`.
12. [integration] A Cursor open with `model: "gpt-5.5"`, profile `full`, against a fake offering `CURSOR_CONFIG_OPTIONS` records one `session/set_config_option` call with `configId` `"model"` and `value` `"gpt-5.5[context=272k,reasoning=medium]"`.
13. [integration] The same open with `model: "claude-sonnet-5-5"` is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, capability `model`, and the agent process is killed once.
14. [integration] A Cursor open with `model: "gpt-5.5"`, profile `full`, against a fake offering no config options and a legacy `models` block with ids `default[]` and `gpt-5.5[context=272k]` records one `session/set_model` call with `modelId` `"gpt-5.5[context=272k]"`.
15. [integration] A Cursor open with profile `read` against a fake offering `CURSOR_CONFIG_OPTIONS` records a `session/set_config_option` call with `configId` `"mode"` and `value` `"ask"`.
16. [integration] A Cursor open with profile `full` records no `session/set_config_option` call with `configId` `"mode"`.
17. [integration] A Claude open with `model: "sonnet"` against a fake offering `CLAUDE_CONFIG_OPTIONS` records `session/set_config_option` with `value` `"sonnet"`.

### US-002

1. [unit] `resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true })` yields `rules` deep-equal to `NO_RULES` and `stateDir` equal to `join(tmpdir(), "nax-agent-acp")`.
2. [unit] `resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true, rules: { allow: [{ tool: "Bash", patterns: ["git status*"] }] }, stateDir: "/s" })` yields `rules` `{ allow: [{ tool: "Bash", patterns: ["git status*"] }], deny: [], ask: [] }` and `stateDir` `"/s"`.
3. [unit] `resolveAcpOptions` with `stateDir: "relative/dir"` throws `AGENT_SESSION_INVALID_OPTIONS` with path `stateDir`.
4. [unit] `resolveAcpOptions` with `rules: { allow: [{ tool: "Bash", patterns: [] }] }` throws `AGENT_SESSION_INVALID_OPTIONS` whose path starts with `rules.allow.0`.
5. [unit] `resolveAcpOptions` with `rules: { deny: [{ tool: "Read", patterns: [3] }] }` throws `AGENT_SESSION_INVALID_OPTIONS` whose path starts with `rules.deny.0`.
6. [unit] `registryEntry("opencode")?.readOnly?.policy` is `"opencode"`, and `registryEntry("claude")?.readOnly?.policy`, `registryEntry("codex")?.readOnly?.policy` and `registryEntry("gemini")?.readOnly?.policy` are `undefined`.
7. [unit] `opencodePermissionConfig("read", NO_RULES)` equals `OPENCODE_READ_CONFIG`, `opencodePermissionConfig("review", NO_RULES)` equals `OPENCODE_REVIEW_CONFIG`, and `opencodePermissionConfig("none", NO_RULES)` equals `OPENCODE_NONE_CONFIG`.
8. [unit] `opencodePermissionConfig("none", { allow: [{ tool: "Read", patterns: ["*"] }], deny: [{ tool: "Read", patterns: ["*"] }], ask: [] })` equals `OPENCODE_NONE_CONFIG`.
9. [unit] `JSON.parse(opencodePermissionConfig("read", { allow: [], deny: [{ tool: "Read", patterns: ["*"] }, { tool: "Grep", patterns: ["*"] }], ask: [] })).permission` deep-equals `{ "*": "deny", glob: "allow" }`.
10. [unit] `JSON.parse(opencodePermissionConfig("review", { allow: [], deny: [{ tool: "Glob", patterns: ["*"] }], ask: [] })).permission` deep-equals `{ "*": "deny", read: "allow", grep: "allow", list: "allow", bash: "ask" }`.
11. [unit] `opencodePermissionConfig("review", rules)` equals `OPENCODE_REVIEW_CONFIG` for `rules` allowing `Bash` unconditionally, `Bash(git status*)` and `Write` (Bash and write rules are not translated).
12. [unit] `opencodePermissionConfig("read", { allow: [], deny: [{ tool: "Read", patterns: ["src/**"] }], ask: [] })` equals `OPENCODE_READ_CONFIG` (a path-scoped deny is not translated).
13. [unit] `await policyLaunchEnv("full", resolveAcpOptions({ agent: "opencode", allowUnsandboxed: true, rules: { deny: [{ tool: "Read", patterns: ["*"] }] } }))` equals `{}`, and so does the same call with profile `"ask"`.
14. [unit] `await policyLaunchEnv("read", resolveAcpOptions({ agent: "codex", allowUnsandboxed: true }))` equals `launchEnvFor("read", registryEntry("codex"))`, and the same holds for `claude` and `gemini`.
15. [integration] An opencode open with profile `read` and `rules.deny` holding `Read` unconditionally launches with `OPENCODE_CONFIG_CONTENT` equal to `opencodePermissionConfig("read", { allow: [], deny: [{ tool: "Read", patterns: ["*"] }], ask: [] })`.
16. [integration] An opencode open with profile `read` and no rules launches with `OPENCODE_CONFIG_CONTENT` equal to `OPENCODE_READ_CONFIG`.
17. [integration] An opencode open with profile `read`, a `Read` deny rule and the caller's `env.OPENCODE_CONFIG_CONTENT` set to `"{}"` launches with the translated value, not `"{}"`.
18. [integration] The relaunch of an opencode `read` session with a `Read` deny rule, after its agent process exits, carries the same `OPENCODE_CONFIG_CONTENT` as the first launch.

### US-003

1. [unit] `shellCommandOf("opencode", { kind: "execute", title: "x", rawInput: { command: "git status --short" } })` returns `"git status --short"`.
2. [unit] `shellCommandOf("cursor", { kind: "execute", title: "`git status --short`" })` returns `"git status --short"`, and `shellCommandOf("cursor", { kind: "execute", title: "ls -la" })` returns `"ls -la"`.
3. [unit] `shellCommandOf("pi", { kind: "other", title: PI_SHELL_GATE_TITLE, rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "ls -la" } })` returns `"ls -la"`.
4. [unit] `shellCommandOf("pi", { kind: "other", rawInput: { method: "confirm", title: "Delete?", message: "ls" } })`, `shellCommandOf("opencode", { kind: "edit", rawInput: { command: "ls" } })` and `shellCommandOf("opencode", { kind: "execute", rawInput: {} })` each return `undefined`.
5. [unit] `shellRuleVerdict("git status --short", { allow: [{ tool: "Bash", patterns: ["git status*"] }], deny: [], ask: [] })` returns `"allow"`.
6. [unit] `shellRuleVerdict("git status --short", NO_RULES)` returns `"deny"`.
7. [unit] `shellRuleVerdict("echo hi > shell.txt", { allow: [{ tool: "Bash", patterns: ["*"] }], deny: [], ask: [] })` returns `"deny"` (a redirect is never allowed).
8. [unit] `shellRuleVerdict("git status && rm -rf x", { allow: [{ tool: "Bash", patterns: ["git status*"] }], deny: [], ask: [] })` returns `"deny"` (every segment must match).
9. [unit] `shellRuleVerdict("git status && ls -la", { allow: [{ tool: "Bash", patterns: ["git status*", "ls *"] }], deny: [], ask: [] })` returns `"allow"`.
10. [unit] `shellRuleVerdict("git push origin main", { allow: [{ tool: "Bash", patterns: ["*"] }], deny: [{ tool: "Bash", patterns: ["git push*"] }], ask: [] })` returns `"deny"`, and with that pattern in `ask` instead of `deny` it also returns `"deny"`.
11. [unit] `shellRuleVerdict` of the command `echo` followed by a dollar-sign command substitution running `cat secret`, with `rules.allow` holding `Bash` unconditionally, returns `"deny"` (the lexer refuses a command substitution).
12. [unit] `shellRuleVerdict("ls", { allow: [{ tool: "Read", patterns: ["*"] }], deny: [], ask: [] })` returns `"deny"` (only Bash rules allow commands).
13. [unit] `shellRuleVerdict("git status --short", { allow: [{ tool: "Bash", patterns: ["git status"] }], deny: [], ask: [] })` returns `"allow"` (native prefix matching: trailing arguments are unconstrained), and `shellRuleVerdict("git", same rules)` returns `"deny"`.
14. [integration] An opencode open with profile `review`, `rules.allow` holding `Bash(git status*)` and a fake turn sending a permission request `{ kind: "execute", title: "git status", rawInput: { command: "git status --short" } }` with allow-once and reject-once options answers `opt-allow_once`, and the turn's `approval_requested` event has reason `SHELL_RULE_REASON`.
15. [integration] The same opencode open with the request's command `"git status --short > out.txt"` answers `opt-reject_once` with reason `REVIEW_NO_SANDBOX_REASON`.
16. [integration] The same opencode open with no rules answers `opt-reject_once` with reason `REVIEW_NO_SANDBOX_REASON` (unchanged default).
17. [integration] An opencode open with profile `read`, the same allow rule and the same `git status --short` request answers `opt-reject_once` with the read-only reason.
18. [integration] A Cursor open with profile `review`, `rules.allow` holding `Bash(git status*)` and a request `{ kind: "execute", title: "`git status --short`" }` answers `opt-allow_once`.
19. [integration] An opencode open with profile `review`, `rules.allow` holding `Bash` unconditionally and an `edit` permission request answers `opt-reject_once` with reason `readOnlyReason("review")`.
20. [integration] An opencode open with profile `review`, `rules.allow` holding `Bash(git status*)` and the `git status --short` request offering only a reject-once option answers `opt-reject_once` with reason `NO_ALLOW_ONCE_REASON`.
21. [unit] Importing the module written from `PI_SHELL_GATE_SOURCE` to a temp file and calling its default export with a fake `pi` whose `on(event, handler)` records handlers registers a `tool_call` handler that, for `{ toolName: "bash", input: { command: "ls" } }`: returns `undefined` and calls `ctx.ui.confirm` once with `(PI_SHELL_GATE_TITLE, "ls")` when confirm resolves `true`; returns `{ block: true, reason: "nax: shell command rejected" }` when it resolves `false`; and returns an object with `block: true` without calling confirm when `ctx.hasUI` is `false`.
22. [unit] The same handler returns `undefined` for `{ toolName: "read", input: {} }` without calling `ctx.ui.confirm`.
23. [integration] A Claude open with profile `review`, a policy sandbox and no rules still allows an `execute` request with reason `REVIEW_EXECUTE_REASON`.

### US-004

1. [unit] `JSON.parse(cursorCliConfig("read", NO_RULES))` deep-equals `{ version: 1, permissions: { allow: ["Read(**)"], deny: ["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)", "Shell(*)"] }, approvalMode: "allowlist" }`.
2. [unit] `JSON.parse(cursorCliConfig("review", NO_RULES)).permissions` deep-equals `{ allow: ["Read(**)"], deny: ["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)"] }`.
3. [unit] `JSON.parse(cursorCliConfig("none", NO_RULES)).permissions` deep-equals `{ allow: [], deny: ["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)", "Shell(*)", "Read(**)"] }`.
4. [unit] `JSON.parse(cursorCliConfig("review", { allow: [], deny: [{ tool: "Read", patterns: ["*"] }], ask: [] })).permissions` deep-equals `{ allow: [], deny: ["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)", "Read(**)"] }`.
5. [unit] `cursorCliConfig("review", rules)` equals `cursorCliConfig("review", NO_RULES)` for `rules` allowing `Bash` unconditionally and `Write` (neither is translated).
6. [unit] `piToolArgs("read", NO_RULES, "/g.ts")` equals `["--tools", "read,grep,find,ls"]`, and `piToolArgs("none", NO_RULES, "/g.ts")` equals `["--no-tools"]`.
7. [unit] `piToolArgs("review", { allow: [{ tool: "Bash", patterns: ["git *"] }], deny: [{ tool: "Glob", patterns: ["*"] }], ask: [] }, "/g.ts")` equals `["-e", "/g.ts", "--tools", "read,grep,bash"]`.
8. [unit] `piToolArgs("read", { allow: [{ tool: "Bash", patterns: ["*"] }], deny: [], ask: [] }, "/g.ts")` equals `["--tools", "read,grep,find,ls"]` (no shell under read).
9. [unit] `piToolArgs("review", { allow: [], deny: [{ tool: "Read", patterns: ["*"] }, { tool: "Glob", patterns: ["*"] }, { tool: "Grep", patterns: ["*"] }], ask: [] }, "/g.ts")` equals `["--no-tools"]`.
10. [unit] `writeCursorPolicy("/state", content)` with `_policyFilesDeps` stubbed records `mkdir("/state/cursor/<h>", { recursive: true, mode: 0o700 })`, a `writeFile` and a `chmod(…, 0o600)` of one temporary path inside that directory, then `rename` of that path to `/state/cursor/<h>/cli-config.json`, `<h>` being the first 16 hex characters of the SHA-256 of `content`; it returns `/state/cursor/<h>`.
11. [unit] `writePiFile("/state", "wrapper", body, 0o700)` records `mkdir("/state/pi", { recursive: true, mode: 0o700 })`, a `writeFile` of `body` and `chmod(…, 0o700)` on a temporary path in `/state/pi`, and a `rename` to `/state/pi/wrapper-<h>.sh`, which it returns.
12. [unit] `writePiFile` called twice with the same content writes and renames both times (a planted or half-written file is replaced).
13. [unit] `registryEntry("pi")?.readOnly` equals `{ mode: undefined, disallowedTools: [], sessionOptions: {}, launchEnv: {}, policy: "pi" }`, and `registryEntry("cursor")?.readOnly?.policy` is `"cursor"`.
14. [integration] A Cursor open with profile `read`, `stateDir` a temp dir and `rules.deny` holding `Read` unconditionally launches with `CURSOR_CONFIG_DIR` equal to the directory `writeCursorPolicy(<temp dir>, cursorCliConfig("read", { allow: [], deny: [{ tool: "Read", patterns: ["*"] }], ask: [] }))` returns.
15. [integration] A pi open with profile `read` and `stateDir` a temp dir opens (no `profile` refusal) and launches with `PI_ACP_PI_COMMAND` equal to the path `writePiFile(<temp dir>, "wrapper", "#!/bin/sh\nexec 'pi' '--tools' 'read,grep,find,ls' \"$@\"\n", 0o700)` returns.
16. [integration] A pi open with profile `read` and the caller's `env.PI_ACP_PI_COMMAND` set to `/opt/it's/pi` launches with `PI_ACP_PI_COMMAND` equal to the path `writePiFile(<temp dir>, "wrapper", "#!/bin/sh\nexec '/opt/it'\\''s/pi' '--tools' 'read,grep,find,ls' \"$@\"\n", 0o700)` returns.
17. [integration] A pi open with profile `review` and `rules.allow` holding `Bash(ls *)` launches with `PI_ACP_PI_COMMAND` equal to the wrapper path for arguments `["-e", <gate>, "--tools", "read,grep,find,ls,bash"]`, where `<gate>` is the path `writePiFile(<temp dir>, "shell-gate", PI_SHELL_GATE_SOURCE, 0o600)` returns.
18. [integration] A Cursor open and a pi open with profile `full` add neither `CURSOR_CONFIG_DIR` nor `PI_ACP_PI_COMMAND` and record no `_policyFilesDeps` call.
19. [integration] A Cursor open with profile `read` whose `_policyFilesDeps.mkdir` rejects is refused with `AGENT_SESSION_BACKEND_UNAVAILABLE` and the fake records no launch.
20. [integration] A pi open with profile `read` whose `_policyFilesDeps.rename` rejects is refused with `AGENT_SESSION_BACKEND_UNAVAILABLE` and the fake records no launch.
21. [unit] `piToolArgs("review", { allow: [{ tool: "Bash", patterns: ["ls *"] }], deny: [{ tool: "Read", patterns: ["*"] }, { tool: "Glob", patterns: ["*"] }, { tool: "Grep", patterns: ["*"] }], ask: [] }, "/g.ts")` equals `["-e", "/g.ts", "--tools", "bash"]`.
22. [integration] A pi open with profile `review`, `stateDir` a temp dir, `rules.allow` holding `Bash(ls *)` and a fake turn sending a permission request `{ kind: "other", title: PI_SHELL_GATE_TITLE, rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "ls -la" } }` with allow-once and reject-once options answers `opt-allow_once` with reason `SHELL_RULE_REASON`; with `message` `"rm -rf x"` it answers `opt-reject_once` with reason `REVIEW_NO_SANDBOX_REASON`.
23. [integration] Two Cursor opens with profile `read` and the same rules launch with the same `CURSOR_CONFIG_DIR`; one with a `Read` deny rule launches with a different one.

### US-005

1. [unit] `backendOptions("opencode", { ...OPTS, resolvedPermissions: { mode: "approve-reads", bashApproval: "gated", toolGrants: [{ tool: "Read", patterns: ["*"] }], denyRules: [{ tool: "Bash", patterns: ["git push*"] }], askRules: [{ tool: "Bash", patterns: ["npm test*"] }] } })` returns `rules` deep-equal to `{ allow: [{ tool: "Read", patterns: ["*"] }], deny: [{ tool: "Bash", patterns: ["git push*"] }], ask: [{ tool: "Bash", patterns: ["npm test*"] }] }`.
2. [unit] `backendOptions("opencode", { ...OPTS, resolvedPermissions: { mode: "approve-reads", bashApproval: "gated" } })` returns `rules` deep-equal to `{ allow: [], deny: [], ask: [] }`.
3. [unit] `backendOptions("cursor", OPTS)` returns `stateDir` equal to `join(globalConfigDir(), "acp")`.
4. [unit] `acpBackend(backendOptions("cursor", { ...OPTS, resolvedPermissions: resolvePermissions(config, "review") }))` does not throw, for a config whose `execution.permissionProfile` is `"safe"` and whose `execution.permissions.review.allow` is `["Bash(git status*)"]`.
5. [unit] `acpEntry("cursor")` equals `{ agent: "cursor", binary: "cursor-agent", displayName: "Cursor Agent (ACP)", supportedTiers: ["fast", "balanced", "powerful"], maxContextTokens: 200_000 }`.
6. [unit] The sorted `ACP_AGENT_NAMES` from the nax ACP entries equals `["claude", "codex", "cursor", "gemini", "opencode", "pi"]`.
7. [unit] `KNOWN_AGENT_NAMES` contains `"cursor"`, and `acpAdapterFor("cursor").name` equals `"cursor"`.
8. [unit] `backendOptions("opencode", OPTS)` still returns `agent`, `allowUnsandboxed`, `inheritEnv`, `initializeTimeoutMs` and `cancelGraceMs` with the same values as before this story.

### US-006

1. [unit] `compileArgvPattern`, `matchesArgvPattern` imported from the package's `.` entry are the same function objects as those in `src/tools/policy-match.ts`.
2. [unit] `matchesArgvPattern(compileArgvPattern("git status"), ["git", "status", "--short"])` is `true`, and `matchesArgvPattern(compileArgvPattern("git status"), ["git"])` is `false`.
3. [unit] `matchesArgvPattern(compileArgvPattern("bun add*"), ["bun", "add-x", "pkg"])` is `true`, and `matchesArgvPattern(compileArgvPattern("bun add*"), ["bunx", "add"])` is `false`.
4. [unit] `compileArgvPattern("git  status")` returns two compiled tokens whose `source` values are `"git"` and `"status"`.
