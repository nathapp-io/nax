# SPEC: ACP shell sandbox for opencode, Cursor and pi under `review`

Closes: #2589

## Summary

Under profile `review`, nax lets an ACP reviewer run a shell command only inside a sandbox. Claude and codex have one; opencode, Cursor and pi do not, so today every shell command they ask to run is denied, or, when an operator `Bash(...)` allow rule matches, runs on the host unsandboxed. This feature gives those three agents nax's own OS sandbox, per command: a nax-owned hook in each agent rewrites every shell command into `nax sandbox exec <policy-file> <command>`, which runs the command under the session's `SandboxPolicy` through nax-agent's srt backend (the same translation native sessions and Claude use). nax then allows the command with `REVIEW_EXECUTE_REASON`, as it does for Claude. The behaviour is on by default and configurable under `agent.acp.shellSandbox`; an unavailable sandbox keeps today's behaviour.

## Motivation

- `review` cannot run tests or any other command on opencode, Cursor or pi without an operator rule, and an allowed command then runs unsandboxed on the host (`REVIEW_NO_SANDBOX_REASON`, nax#2372 follow-up).
- Research and live probes (2026-10-18, `projects/nax/nax-2589-acp-shell-sandbox-research-2026-10-18.md` in the operator workspace) showed every one of the three agents can rewrite a shell command before it runs, so a per-command wrap is possible without sandboxing the whole agent process:
  - Cursor (cursor-agent 2026.10.16): a `preToolUse` hook returning `updated_input`; the rewritten command reaches nax's ACP permission request whole, in the backticked title. Cursor reads hooks only from fixed paths under `HOME`, so nax runs Cursor with a nax-owned `HOME`; a symlink to the real `~/Library/Keychains` keeps its login.
  - opencode 2.0.27: a V2 plugin (`export default { id, setup(ctx) }` with `ctx.tool.hook("execute.before", …)`; the shell tool is named `shell`). The hook runs before the permission ask, but the ask carries the original command. A repo `.opencode/plugins` V2 plugin runs after nax's and can undo the wrap, so nax sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which drops the repo's plugins and also its `AGENTS.md`; nax restores the instructions through `<config dir>/AGENTS.md`.
  - pi 0.84.3 (pi-acp 0.0.34): an extension that overrides `bash` with `createBashTool(cwd, { spawnHook })`. The first registration of a tool name wins and `-e` extensions load first, so nax's `bash` always runs; the gate confirm shows the original command.
- The `srt` CLI cannot express nax's default open network (its settings schema requires `allowedDomains`), so the runner is a nax subcommand on nax-agent's `createSrtBackend`, which can.

## Design

### Integration

Symbols this feature only reads:

- `createSrtBackend(network: SandboxConfig["network"]): SandboxBackend` and `SandboxBackend { name, isSupportedPlatform(), wrap(req: SandboxWrapRequest), annotate(commandId, stderr), commandFinished(), reset() }` (`@nathapp/nax-agent`, `packages/nax-agent/src/sandbox/srt-backend.ts`, `types.ts`); `SandboxWrapRequest { command, shell, policy, cwd, commandId }`.
- `SandboxPolicy { writeRoots, denyWrite, denyRead, network: { allowedDomains?, allowLocalBinding? } }` and `SessionSandbox = { kind: "policy"; policy } | { kind: "unavailable"; reason }` (`@nathapp/nax-agent`).
- `BackendOpenContext.sandbox?: SessionSandbox`, `.profile`, `.workdir` (`@nathapp/nax-agent`).
- `PI_SHELL_GATE_TITLE`, `shellCommandOf(agentName, toolCall)`, `shellRuleVerdict(command, rules)`, `SHELL_RULE_REASON` (`packages/nax-agent-acp/src/client/shell-rules.ts`).
- `writeCursorPolicy(stateDir, content)`, `writePiFile(stateDir, name, content, mode)` (`packages/nax-agent-acp/src/client/policy-files.ts`).
- `opencodePermissionConfig(profile, rules)`, `cursorCliConfig(profile, rules)` (`rule-policy.ts`), `reviewDecidesShell(profile, rules)` (`capabilities.ts`).
- `REVIEW_EXECUTE_REASON`, `REVIEW_NO_SANDBOX_REASON`, `NO_ALLOW_ONCE_REASON`, `readOnlyReason(profile)` (`permissions.ts`).
- `sandboxProbeCommand` and `_sandboxProbeCmdDeps` (`packages/nax/src/cli/sandbox-probe.ts`) — the pattern `sandbox exec` mirrors.
- Pattern to copy (not importable: it is module-private in another package): `linkOrAcceptConcurrentLink` in `packages/nax/src/agents/shared/gemini-acp-env.ts`, which accepts an existing link with the expected target.
- `withCodexAcpEnv`, `withOpencodeAcpEnv`, `withGeminiAcpEnv` and their settings readers (`packages/nax/src/agents/shared/*-acp-env.ts`) — the pattern the new env module mirrors; `AgentGeminiAcpConfigSchema` / `DEFAULT_AGENT_GEMINI_ACP_CONFIG` (`packages/nax/src/config/schemas-acp-agents.ts`) — the schema-module pattern.

Symbols this feature changes (the baseline only locates the code; the target is the interface to implement):

- `AcpBackendOptions` (`options.ts`). Baseline: no `shellSandbox`. Target: optional `shellSandbox?: { runtime: string; runner: readonly string[]; pi?: { extensions?: "user" | "none" }; opencode?: { projectConfig?: "disable" | "keep" }; cursor?: { onUnwrapped?: "rules" | "deny" } }` (an inline type; no new exported type name, so `api/nax-agent-acp.api.txt` is unchanged).
- `ResolvedAcpOptions` (`options.ts`). Target adds `shellSandbox: { runtime; runner; piExtensions: "user" | "none"; opencodeProjectConfig: "disable" | "keep"; cursorOnUnwrapped: "rules" | "deny" } | undefined` (defaults `"user"`, `"disable"`, `"rules"`) and `shellSandboxPlan?: ShellSandboxPlan`, which `resolveAcpOptions` never sets (see Wiring).
- `PermissionContext` (`permissions.ts`). Target adds `shellSandbox?: { prefix: string; verify: boolean; onUnwrapped: "rules" | "deny" }`.
- `policyLaunchEnv(profile, options)` (`rule-policy.ts`). Target signature unchanged; it reads `options.shellSandboxPlan`.
- `piToolArgs(profile, rules, gatePath)` (`rule-policy.ts`). Target: `piToolArgs(profile, rules, gatePath, sandbox?: { extensions: "user" | "none" })`; with `sandbox` set and `profile === "review"` it returns `[...(extensions === "none" ? ["--no-extensions"] : []), "-e", gatePath, "--tools", <read tools>,bash]`; without it the output is today's.
- `modeFor(profile, entry, rules)` (`capabilities.ts`). Target: `modeFor(profile, entry, rules, shellSandboxed?: boolean)`; under `review`, `shellSandboxed === true` selects `entry.readOnly.reviewShellMode` exactly as a Bash allow rule does today.
- `PiPolicyFile` (`policy-files.ts`). Target: `"shell-gate" | "wrapper" | "sandbox-gate"` (`.ts` for `sandbox-gate`).
- `digest` and `writeAtomic` (`policy-files.ts`). Baseline: module-private. Target (US-002): `digest` exported unchanged, plus a new exported `writeStateFile(stateDir, relPath, content, mode): Promise<string>` that writes `<stateDir>/<relPath>` through `writeAtomic` and returns the absolute path. Every new file this feature writes (policy file, pi extension, opencode plugin and AGENTS.md, Cursor hook and `hooks.json`) goes through `writeStateFile`; US-003..US-005 add no writer of their own.
- `PI_SHELL_GATE_REJECTED` (`shell-rules.ts`). Baseline: a module-private `const`. Target (US-003): exported, value unchanged.
- `AcpEnvSettings` and `withAcpEnv` (`packages/nax/src/agents/shared/acp-env.ts`). Target adds `shellSandbox: AcpShellSandboxSettings`, applied last in `withAcpEnv`.
- `backendOptions(agent, opts, onProcess)` (`packages/nax/src/agents/acp/open-context.ts`). Target lifts `NAX_ACP_SHELL_SANDBOX` out of the env into `shellSandbox` (see nax wiring).
- `AgentAcpConfigSchema` (`packages/nax/src/config/schemas-infra.ts`) and the literal `agent.acp` defaults in `schemas-infra.ts` and `schemas.ts`. Target adds `shellSandbox`.
- `AgentAcpConfig` (`packages/nax/src/config/runtime-types-agent.ts`, the hand-written runtime type). Target adds `shellSandbox?: { mode?: "auto" | "off"; pi?: { extensions?: "user" | "none" }; opencode?: { projectConfig?: "disable" | "keep" }; cursor?: { onUnwrapped?: "rules" | "deny" } }`.
- `packages/nax/src/config/index.ts`. Target also re-exports `DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG` from `./schemas-acp-agents`, beside `DEFAULT_AGENT_GEMINI_ACP_CONFIG`.

### Module `packages/nax-agent-acp/src/client/shell-sandbox.ts` (US-001, US-002)

- `type ShellSandboxPlan = { agent: "opencode" | "cursor" | "pi"; policy: SandboxPolicy; policyContent: string; policyFile: string; prefix: string; home: string; runtime: string; workdir: string; verify: boolean; onUnwrapped: "rules" | "deny"; piExtensions: "user" | "none"; stripEnv: readonly string[] }` (package-internal, not exported from `./client`).
- `shellSandboxPlan(profile, options, sandbox, workdir): Promise<ShellSandboxPlan | undefined>` returns a plan exactly when all hold: `profile === "review"`, `options.shellSandbox !== undefined`, `sandbox?.kind === "policy"`, `options.agentName` is `opencode`, `cursor` or `pi`, and not (`opencode` with `opencodeProjectConfig === "keep"`). Otherwise `undefined`: an unavailable sandbox keeps today's path for these agents. A filesystem failure while creating or resolving `stateDir` rejects with `AGENT_SESSION_BACKEND_UNAVAILABLE` naming the path.
- The plan's policy is the session policy plus two floors, in this order:
  - `denyWrite`: the input `denyWrite`, then `realpath(stateDir)` (the state dir is created 0700 first). Commands can never rewrite nax's policy file, wrappers or hooks.
  - `denyRead`: the input `denyRead`, then each of `<home>/.local/share/opencode/auth.json` and `<home>/.pi/agent/auth.json` that exists (realpath-resolved). Cursor keeps its token in the keychain, which srt's deny-default profile does not expose to commands.
- `home` is `_shellSandboxDeps.homedir()` (the nax process's home), so the runner can restore it for a command Cursor spawns under its nax-owned `HOME`.
- `stripEnv` is the sorted, de-duplicated union of `options.entry.authEnv` and every `options.env` name whose value is one of `options.secrets`: the agent's credentials, which the runner removes from a command's environment (native sessions strip the same way, `LaunchRequest.stripEnvVars`).
- `policyContent = JSON.stringify({ version: 1, home, stripEnv, policy })`; `policyFile = <stateDir>/sandbox/policy-<h>.json`, `<h>` the first 16 hex characters of the SHA-256 of `policyContent` (the existing `digest`).
- `prefix = [runtime, ...runner, policyFile].map(shellQuote).join(" ") + " "`, `shellQuote` being POSIX single-quoting (`'` becomes `'\''`). US-001 moves the private `shQuote` from `rule-policy.ts` into this module as the exported `shellQuote`, and `rule-policy.ts` imports it.
- `verify` is `true` for `cursor` only: Cursor is the one agent whose permission request carries the rewritten command.
- US-002 adds:
  - `wrapForSandbox(prefix, command) = prefix + shellQuote(command)`, always, with no idempotence shortcut: a command crafted to start with the prefix is wrapped again, not passed through.
  - `isSandboxWrapped(prefix, command)`: `command` starts with `prefix` and the remainder is exactly one single-quoted word (`/^'(?:[^']|'\\'')*'$/`).
  - `sandboxWrapSnippet(prefix): string`: JavaScript source declaring `const NAX_SANDBOX_PREFIX = <JSON string>;` and `function naxSandboxWrap(command)` with the same result as `wrapForSandbox`. The pi extension, the opencode plugin and the Cursor hook are all built from it, so the TypeScript and generated JavaScript wraps cannot drift.
- `_shellSandboxDeps = { homedir, realpath, mkdir, platform, symlink, readlink }` for tests (`readlink` checks an existing `Library/Keychains` link's target).

Worked skeleton (US-001):

```ts
export async function shellSandboxPlan(
  profile: AgentSessionProfile,
  options: ResolvedAcpOptions,
  sandbox: SessionSandbox | undefined,
  workdir: string,
): Promise<ShellSandboxPlan | undefined> {
  const settings = options.shellSandbox;
  const agent = sandboxedAgent(options.agentName); // "opencode" | "cursor" | "pi" | undefined
  if (profile !== "review" || settings === undefined || sandbox?.kind !== "policy" || agent === undefined) return undefined;
  if (agent === "opencode" && settings.opencodeProjectConfig === "keep") return undefined;
  const home = _shellSandboxDeps.homedir();
  const policy = await withFloors(sandbox.policy, options.stateDir, home);
  const stripEnv = credentialEnvNames(options); // sorted union of entry.authEnv and secret-valued env names
  const policyContent = JSON.stringify({ version: 1, home, stripEnv, policy });
  const policyFile = join(options.stateDir, "sandbox", `policy-${digest(policyContent)}.json`);
  const prefix = `${[settings.runtime, ...settings.runner, policyFile].map(shellQuote).join(" ")} `;
  return { agent, policy, policyContent, policyFile, prefix, home, runtime: settings.runtime, workdir,
    verify: agent === "cursor", onUnwrapped: settings.cursorOnUnwrapped, piExtensions: settings.piExtensions, stripEnv };
}
```

### Wiring and the permission decision (US-002)

- Module layering: the new agent modules (`pi-sandbox.ts`, `opencode-sandbox.ts`, `cursor-sandbox.ts`) import `shell-sandbox.ts`, `policy-files.ts` and `shell-rules.ts` only, never `rule-policy.ts`. `rule-policy.ts` imports them and passes in what they need (the opencode permission config content, the Cursor `CURSOR_CONFIG_DIR` value, the pi tool arguments), so `check-import-cycles` sees no cycle.
- `connect` (`backend.ts`) computes `shellSandboxPlan(ctx.profile, options, ctx.sandbox, ctx.workdir)` once per process launch (new session, resume and reconnect alike) and sets it as `shellSandboxPlan` on the options object it already threads into `routerFor` and `openAcpSession`. `routerFor` puts `{ prefix, verify, onUnwrapped }` into the `PermissionContext` when a plan exists. `open.ts` passes `options.shellSandboxPlan !== undefined` to `modeFor`.
- `policyLaunchEnv`, with a plan, first writes `policyContent` to `policyFile` atomically (0600, through `writeAtomic`), then builds the agent's env (US-003..US-005). A failed write refuses the open before anything is launched.
- `decideReview` with `ctx.shellSandbox` set (Target) delegates, before today's sandbox and rule branches, to a separate function `decideSandboxedShell(request, display, offered, auto, ctx)` (kept out of `decideReview` for the cognitive-complexity gate):
  1. `command = shellCommandOf(agentName, toolCall)`. No command: deny as today (`REVIEW_NO_SANDBOX_REASON` for `execute`, else the review read-only reason).
  2. No allow-once option: `NO_ALLOW_ONCE_REASON` (today's helper).
  2a. Operator rules still bind: when `shellRuleBlocks(command, rules)` is `true` (some segment of the command, lexed with `lexBashCommand`, matches a `Bash` deny or ask rule), reject with `SHELL_RULE_BLOCKED_REASON = 'a "Bash" deny or ask rule matches the command'`. A command the lexer refuses is not blocked by this step (the sandbox still holds it). `shellRuleBlocks` is a new export of `shell-rules.ts` built on its existing argv matcher; for Cursor it is checked against the unwrapped command (the wrapper's inner word), so a wrapped `rm x` matches `Bash(rm *)` exactly as `rm x` would.
  3. `verify === false` (opencode, pi): allow with `REVIEW_EXECUTE_REASON`. The guarantee is structural (nax's hook or tool wraps every spawn).
  4. `verify === true` (Cursor) and `isSandboxWrapped(prefix, command)`: allow with `REVIEW_EXECUTE_REASON`.
  5. Cursor, not wrapped: `onUnwrapped === "deny"` rejects with `REVIEW_UNWRAPPED_REASON = "the command did not arrive in nax's sandbox wrapper"`; `"rules"` falls through to today's `shellRuleVerdict` path (`SHELL_RULE_REASON` or `REVIEW_NO_SANDBOX_REASON`).
- Without `ctx.shellSandbox`, `decideReview` is unchanged.
- `connect` builds the plan before `routerFor` and `toolHostFor`, so a plan that rejects starts no tool host, and passes a frozen copy `{ ...options, shellSandboxPlan }` onward (`ResolvedAcpOptions` is frozen).

### pi (US-003)

- With a plan for `pi`, `piLaunchEnv` writes `sandbox-gate` (`<stateDir>/pi/sandbox-gate-<h>.ts`, mode 0600) with `piSandboxGateSource(prefix, piModule = "@earendil-works/pi-coding-agent")`, and the wrapper runs pi with `piToolArgs("review", rules, <sandbox-gate path>, { extensions: plan.piExtensions })`. This holds whether or not a Bash allow rule exists.
- `piSandboxGateSource` (`pi-sandbox.ts`) is `sandboxWrapSnippet(prefix)` plus an extension that:
  - registers today's gate (`pi.on("tool_call")`, `ctx.ui.confirm(PI_SHELL_GATE_TITLE, command)`, block with `PI_SHELL_GATE_REJECTED` on a refusal or with no UI). The gate keeps nax's per-command decision and approval events.
  - imports `createBashTool` from `piModule` and registers a `bash` tool built as `createBashTool(process.cwd(), { spawnHook: ({ command, cwd, env }) => ({ command: naxSandboxWrap(command), cwd, env }) })`, whose `execute(id, params, signal, onUpdate)` forwards to the created tool.
  - Tests pass a fixture module as `piModule`.

### opencode (US-004)

- With a plan for `opencode`, `policyLaunchEnv` returns `opencodeSandboxEnv(plan, permissionConfig, callerEnv)` (`opencode-sandbox.ts`), whose value is:
  - `OPENCODE_CONFIG_CONTENT`: `opencodePermissionConfig("review", rules)` (unchanged).
  - `OPENCODE_DISABLE_PROJECT_CONFIG`: `"1"`.
  - `OPENCODE_CONFIG_DIR`: `<stateDir>/opencode/<h>`, `<h>` the digest of the plugin source and the AGENTS.md text joined. The dir holds `plugins/nax-shell-sandbox.js` (mode 0600) and, when any instruction text exists, `AGENTS.md`.
  - `OPENCODE_CONFIG`: the first of `<userConfigDir>/opencode.json` and `<userConfigDir>/opencode.jsonc` that exists, only when the caller's `options.env` has no `OPENCODE_CONFIG`. This keeps the operator's providers and MCP servers.
- `userConfigDir` is the caller's `options.env.OPENCODE_CONFIG_DIR` when set (nax's `agent.acp.opencode.isolateConfig` sets it to an empty dir, so isolation is preserved), else `<XDG_CONFIG_HOME>/opencode` when `options.env.XDG_CONFIG_HOME` is set, else `<home>/.config/opencode`.
- `AGENTS.md` is the concatenation, joined by `"\n\n"`, of: `<userConfigDir>/AGENTS.md` when it exists, then every `AGENTS.md` from `plan.workdir` upward, nearest first, stopping after the first directory that contains `.git` (or at the filesystem root). This mirrors opencode's own instruction walk, which `OPENCODE_DISABLE_PROJECT_CONFIG` turns off.
- Plugin source, `opencodeSandboxPluginSource(prefix)` (`opencode-sandbox.ts`): `sandboxWrapSnippet(prefix)` plus `export default { id: "nax-shell-sandbox", async setup(ctx) { await ctx.tool.hook("execute.before", (event) => { … }) } }`. For `event.tool` (lower-cased) `shell` or `bash` with a string `event.input.command`, it sets `event.input = { ...event.input, command: naxSandboxWrap(event.input.command) }`; every other tool is untouched.

### Cursor (US-005)

- With a plan for `cursor`, `policyLaunchEnv` returns `cursorSandboxEnv(plan, cursorConfigDir)` (`cursor-sandbox.ts`): today's `CURSOR_CONFIG_DIR` plus `HOME: <stateDir>/cursor-home/<h>`, `<h>` the digest of the `hooks.json` content. The directory is reused by every later open and reconnect with the same plan. It holds:
  - `.cursor/hooks.json` (mode 0600): `{"version":1,"hooks":{"preToolUse":[{"command":"<shellQuote(runtime)> <shellQuote(hookFile)>","failClosed":true}]}}`.
  - on `darwin` only, `Library/Keychains`, a symlink to `<home>/Library/Keychains` (Cursor's login lives in the macOS login keychain, found through `HOME`). An existing symlink with that same target is accepted (a reused directory, or a concurrent open), as `linkOrAcceptConcurrentLink` does; any other existing entry or failure refuses the open.
- `hookFile` is `<stateDir>/cursor/sandbox-hook-<h>.mjs` (mode 0600, `<h>` the digest of the hook source), written from `cursorSandboxHookSource(prefix)`: `sandboxWrapSnippet(prefix)` plus a program that reads Cursor's hook event JSON from stdin and:
  - when `tool_input.command` is a string, writes `{"updated_input":{...tool_input,"command":naxSandboxWrap(command)}}` to stdout and exits 0;
  - otherwise writes `{}` and exits 0;
  - on unparsable stdin, exits 1, which `failClosed` turns into a rejected tool call.
- Mode: `modeFor` receives `shellSandboxed: true`, so review runs in `reviewShellMode` (`agent`) without needing a Bash rule (nax#2592 showed `ask` makes the model refuse to try shell).
- The runner restores `HOME` from the policy file, so commands see the real home while the Cursor process sees nax's.

### nax wiring (US-006)

- Config `agent.acp.shellSandbox` (`schemas-acp-agents.ts`, composed into `AgentAcpConfigSchema` and both literal defaults). Default constant `DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG`. `schemas-infra.ts` is at 595 of its 600 lines: its net growth must stay at or under +5 lines after `biome check --write`. If the import of the new names wraps, US-006 moves `DEFAULT_AGENT_OPENCODE_ACP_CONFIG` and its comment into `schemas-acp-agents.ts` beside the gemini constant, imported back and re-exported from `config/index.ts` unchanged.
  - `mode: "auto" | "off"` (default `"auto"`).
  - `pi: { extensions: "user" | "none" }` (default `"user"`).
  - `opencode: { projectConfig: "disable" | "keep" }` (default `"disable"`).
  - `cursor: { onUnwrapped: "rules" | "deny" }` (default `"rules"`).
- `packages/nax/src/agents/shared/acp-shell-sandbox-env.ts`:
  - `AgentAcpShellSandboxConfigSchema` (schema export in `schemas-acp-agents.ts`); `type AcpShellSandboxSettings = { mode; pi; opencode; cursor }` exported from `acp-shell-sandbox-env.ts`; `acpShellSandboxSettings(config): AcpShellSandboxSettings` reads the block with schema defaults. US-006 also edits `schemas.ts` (literal default) and `config/index.ts` (re-export).
  - `withAcpShellSandboxEnv(def, agentName, settings)` checks `agentName` first: for any agent but `opencode`, `cursor` and `pi` it returns `def` itself without reading `settings`. For those three it returns a new def whose env adds `NAX_ACP_SHELL_SANDBOX = JSON.stringify({ pi, opencode, cursor })` when `settings.mode === "auto"`, and `def` itself when `"off"`.
  - `acpEnvSettings` and `withAcpEnv` compose it after gemini.
- `backendOptions`: when `opts.modelDef.env` carries `NAX_ACP_SHELL_SANDBOX`, the forwarded `env` drops that key. When the value is JSON that matches `{ pi: { extensions: "user" | "none" }, opencode: { projectConfig: "disable" | "keep" }, cursor: { onUnwrapped: "rules" | "deny" } }` (validated with zod in `open-context.ts`), the result gains `shellSandbox: { runtime: _openContextDeps.execPath(), runner: [_openContextDeps.entry(), "sandbox", "exec", "--"], ...parsed }`. Any other value (not JSON, or a bad shape) adds no `shellSandbox` (today's behaviour) and logs a warning, so a bad value never reaches `acpBackend()` as an invalid option.
- New export `_openContextDeps: { execPath: () => string; entry: () => string }` in `open-context.ts`, defaulting to `() => process.execPath` and `() => Bun.main`.
### `nax sandbox exec` (US-007)

- `nax sandbox exec [--] <policy-file> <command>` (`packages/nax/src/cli/sandbox-exec.ts`, `sandboxExecCommand(policyFile, command): Promise<number>`, registered beside `sandbox probe` in `bin/nax.ts`, whose action is `process.exit(await sandboxExecCommand(policyFile, command))`). The wrapper always passes `--` before the policy file, so a command beginning with `-` is never read as an option.
- It reads the policy file and validates it with a strict zod schema (`z.strictObject` at every level), so an unknown field fails closed with exit 126: `version: 1`, `home?: string`, `stripEnv: string[]`, and `policy` with string arrays `writeRoots`/`denyWrite`/`denyRead` and `network: { allowedDomains?: string[]; allowLocalBinding?: true }`.
- It builds `_sandboxExecDeps.createBackend(policy.network)` and calls `wrap({ command, shell: "/bin/bash", policy, cwd: _sandboxExecDeps.cwd(), commandId: randomUUID() })`.
- It spawns the returned argv through `_sandboxExecDeps.spawn` with inherited stdio. The child's env is `_sandboxExecDeps.env()` without every `stripEnv` name, and with `HOME` set to the file's `home` when present.
- It forwards SIGINT and SIGTERM (registered through `_sandboxExecDeps.onSignal`) to the child. It returns the child's exit code, or `128 + n` when killed by signal `n`. It calls `commandFinished()` after a spawned command, and `reset()` on every path once a backend exists.
- It writes nothing to stdout itself, loads no config and runs no trust gate.
- New export `_sandboxExecDeps: { readFile(path: string): Promise<string>; createBackend(network): SandboxBackend; cwd(): string; env(): Record<string, string | undefined>; spawn(argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): { exited: Promise<{ exitCode: number | null; signal: string | null }>; kill(signal: string): void }; onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void; stderr(line: string): void }`, defaulting to `Bun.file().text()`, `createSrtBackend`, `process.cwd`, `process.env`, `Bun.spawn`, `process.on` and `process.stderr.write`.
- `docs/guides/permissions.md` "ACP agents" gains a "Shell sandbox under `review`" subsection: what is sandboxed (shell commands only), each agent's injection, the knobs, the open-network semantics, and the Known limitations listed in Out of Scope. `docs/guides/configuration.md` lists `agent.acp.shellSandbox`.

### CLI Behavior (`nax sandbox exec`)

| Case | stdout / stderr | Exit |
|:--|:--|:--|
| Command ran | the command's own streams, inherited | the command's exit code |
| Command killed by signal `n` | as above | `128 + n` |
| Policy file missing, unreadable, not JSON, or failing validation | stderr `nax sandbox exec: <reason>`; the command never runs | 126 |
| Sandbox not supported on this platform (`isSupportedPlatform()` false) | stderr `nax sandbox exec: the OS sandbox is not available on this host`; the command never runs | 126 |
| `wrap()` throws | stderr `nax sandbox exec: <message>`; the command never runs | 126 |

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Under `review` the session sandbox is `unavailable` or absent | `shellSandboxPlan` returns `undefined`; the open proceeds on today's path (deny, or Bash-rule decision); nothing is thrown. |
| The policy file, pi extension, opencode plugin or AGENTS.md, Cursor hook or `hooks.json` cannot be written | Open refused with `AGENT_SESSION_BACKEND_UNAVAILABLE` naming the path (`writeAtomic`); the agent is never launched. |
| The Cursor `Library/Keychains` symlink cannot be created | Open refused with `AGENT_SESSION_BACKEND_UNAVAILABLE` naming the path; the agent is never launched. |
| Cursor's permission request carries a command that is not exactly nax's wrapper | `onUnwrapped: "deny"` rejects with `REVIEW_UNWRAPPED_REASON`; `"rules"` decides it by the Bash rules (today's path). |
| An invalid `shellSandbox` option (relative `runtime`, empty `runner`, an unknown knob value) | `acpBackend()` throws `AGENT_SESSION_INVALID_OPTIONS` with the option path. |
| `NAX_ACP_SHELL_SANDBOX` is not JSON or has a bad shape in `backendOptions` | No `shellSandbox` is forwarded and the key is dropped from the env; a warning is logged. |
| Creating or resolving `stateDir` for the plan fails | Open refused with `AGENT_SESSION_BACKEND_UNAVAILABLE` naming the path; the agent is never launched. |
| The Cursor hook receives unparsable stdin | It exits 1; Cursor's `failClosed` rejects the tool call. |
| The runner's policy file is invalid, the platform unsupported, or `wrap()` throws | Exit 126 with a `nax sandbox exec:` message; the command never runs unsandboxed. |

## Out of Scope

- Known limitation (ruled 2026-10-18): pi extensions loaded after nax's (the operator's own, or a trusted repo's) can rewrite a command in a `tool_call` handler after nax's gate approved it. With the shell sandbox the rewritten command still runs wrapped, because the wrap happens at spawn; on the Bash-rule path (sandbox off or unavailable) nax's verdict binds only the text the gate confirmed. Documented, not fixed.
- Known limitation (ruled 2026-10-18): opencode V2 plugins named in the operator's own `opencode.json` `plugin` list still load and may register `execute.before` after nax's hook; opencode's permission ask carries the original command, so nax cannot detect a plugin that undoes the wrap. Documented, not fixed.
- Known limitation: hooks a trusted Cursor workspace supplies (`.cursor/hooks.json`, `.claude/settings.json`), opencode or pi project code, and each agent's own non-shell tools run outside nax's sandbox; only shell commands are sandboxed. A Cursor hook that changes nax's wrapper is caught by the exact-wrapper check (`onUnwrapped`).
- Sandboxing the whole agent process (Option 1 of nax#2589): a later hardening step, per agent.
- Known limitation: on Linux, a file-based Cursor credential under the real home is not in the `denyRead` floor (no verified path); on macOS Cursor's login is in the keychain, which commands cannot reach.
- Known limitation: an agent or timeout that SIGKILLs `nax sandbox exec` cannot be forwarded, so the sandboxed child keeps running until it exits on its own.
- Known limitation: under the shell sandbox, a command the Bash lexer refuses is not checked against `Bash` deny or ask rules (it still runs inside the sandbox).
- Copying the operator's own Cursor hooks (`~/.cursor/hooks.json`, `~/.claude/settings.json`) or opencode file plugins into nax's `HOME` or config dir: they do not run in a sandboxed `review` session (probed 2026-10-18: with `OPENCODE_CONFIG_DIR` set, a plugin in `~/.config/opencode/plugins` was not imported).
- US-005 only: the `Library/Keychains` symlink is created on macOS only; Cursor login under a nax-owned `HOME` on Linux is not verified.
- Windows: the wrapper, the pi wrapper and the runner assume a POSIX shell and `/bin/bash`.
- US-007 only: hosts without `/bin/bash` (the runner's shell is fixed).
- US-007 only: a nax embedded in another host, or a compiled single binary, where `Bun.main` is not nax's CLI entry; the runner command assumes nax runs as its CLI.
- US-004 only: opencode's `CLAUDE.md` instruction fallback; nax carries `AGENTS.md` files only, so a repo with only a `CLAUDE.md` loses those instructions under a sandboxed opencode review.
- Copying the probe-recorded opencode, Cursor and pi payloads into test fixtures: the payload shapes are pinned by the ACs here and checked live after merge.
- Per-command latency of `nax sandbox exec` (nax CLI start-up per wrapped command): measured in the live check, not budgeted here.
- Removing stale content-addressed files under the state directory.
- A live check against real Cursor, opencode and pi processes: a maintainer step after merge.
- Updating `.nax/mono/packages/nax-agent-acp/context.md` for the shell sandbox: a manual step after merge, since `.nax/` is read-only to the run.

## Stories

Integration ACs open sessions the way the existing backend tests do: `createAgentSession` (or the backend's `open()` with `test/helpers/open-context.ts`) over `acpBackend({ agent, allowUnsandboxed: true, command: "fake-<agent>", stateDir: <temp dir>, shellSandbox: { runtime: "/usr/bin/node", runner: ["/opt/nax/nax.js", "sandbox", "exec", "--"] } })` with the in-memory fake (`_acpBackendDeps.launch`), a context with `profile: "review"` and `sandbox: { kind: "policy", policy: <a policy with temp-dir writeRoots> }`, reading the launch env from `o.fake.requests[0]?.env`. Home-dependent ACs override `_shellSandboxDeps.homedir` with a temp directory. ACs that assert a permission decision's reason pass an `asks` override (via `openContext(workdir, { asks })`) whose `recordAutoDecision` records each `(event.reason, decision)`, and drive the fake agent's permission step within a turn as `backend-shell-rules.test.ts` does.

### US-001: shell sandbox option and per-session plan

Workdir: `packages/nax-agent-acp`. No dependencies.

Add the `shellSandbox` backend option (schema, defaults, resolved shape) and `shell-sandbox.ts` with `shellSandboxPlan`: when a session is sandboxed, the floored policy, the content-addressed policy file path and content, and the wrapper prefix. Move `shQuote` from `rule-policy.ts` into the new module as the exported `shellQuote`.

### US-002: wrap, verify and decide sandboxed shell commands

Workdir: `packages/nax-agent-acp`. Depends on US-001.

Add `wrapForSandbox`, `isSandboxWrapped` and `sandboxWrapSnippet`; compute the plan once per launch in `connect` and thread it through `routerFor`, `policyLaunchEnv` and `modeFor`; write the policy file before launch; and add the sandboxed branch to `decideReview` with `REVIEW_UNWRAPPED_REASON`.

### US-003: pi runs every bash spawn inside the sandbox

Workdir: `packages/nax-agent-acp`. Depends on US-001, US-002.

With a plan for pi, write the `sandbox-gate` extension (gate plus `bash` override with a wrapping `spawnHook`) and launch pi with it and `bash` in `--tools`, honouring `extensions: "none"` with `--no-extensions`.

### US-004: opencode runs every shell call inside the sandbox

Workdir: `packages/nax-agent-acp`. Depends on US-001, US-002.

With a plan for opencode, write nax's config dir (V2 plugin plus the concatenated `AGENTS.md`), and launch opencode with `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG` and today's `OPENCODE_CONFIG_CONTENT`; `projectConfig: "keep"` keeps today's launch.

### US-005: Cursor runs every shell command inside the sandbox

Workdir: `packages/nax-agent-acp`. Depends on US-001, US-002.

With a plan for Cursor, write the hook program and a nax-owned `HOME` (`hooks.json`, macOS keychain link), launch Cursor with that `HOME`, and run review in agent mode; nax's permission check then verifies the exact wrapper.

### US-006: nax config and the env carrier to the ACP backend

Workdir: `packages/nax`. Depends on US-001.

Add `agent.acp.shellSandbox` (schema, defaults, runtime type, barrel export, settings reader) within `schemas-infra.ts`'s line budget, and carry it to the ACP backend through `NAX_ACP_SHELL_SANDBOX` on the model def, lifted into the typed `shellSandbox` option by `backendOptions`.

### US-007: the `nax sandbox exec` runner and docs

Workdir: `packages/nax`. No dependencies.

Add `nax sandbox exec [--] <policy-file> <command>`: validate the policy file strictly, wrap the command with nax-agent's srt backend, strip the credential env names, restore `HOME`, forward signals, propagate the exit code. Document the shell sandbox, its knobs and its known limitations in `docs/guides/permissions.md`, and rewrite its now-false statements there (the line-15 overview sentence, "An allowed command runs on the host, unsandboxed … no OS sandbox wraps opencode, Cursor or pi", and "Under review with no Bash allow rule, no command can ever be allowed") to say they hold only when the shell sandbox is off or unavailable. List `agent.acp.shellSandbox` in `docs/guides/configuration.md` and add `nax sandbox exec` beside `nax sandbox probe` in `docs/guides/cli-reference.md`.

### Context Files

**US-001**

- `packages/nax-agent-acp/src/client/options.ts` — schema, `resolved`, `resolveAcpOptions`
- `packages/nax-agent-acp/src/client/policy-files.ts` — `digest`, `writeAtomic`, 0700 dirs
- `packages/nax-agent-acp/src/client/rule-policy.ts` — `shQuote` (moved), `piWrapper`
- `packages/nax-agent-acp/test/unit/client/options.test.ts` — option error assertions (`AGENT_SESSION_INVALID_OPTIONS`, path)

**US-002**

- `packages/nax-agent-acp/src/client/permissions.ts` — `decideReview`, `PermissionContext`, reason constants
- `packages/nax-agent-acp/src/client/backend.ts` — `connect`, `routerFor`
- `packages/nax-agent-acp/src/client/open.ts` — `openAcpSession`, `applyMode` / `modeFor` call
- `packages/nax-agent-acp/src/client/shell-sandbox.ts` — created by US-001, extended here
- `packages/nax-agent-acp/test/unit/client/backend-shell-rules.test.ts` — permission-step fake-agent pattern

**US-003**

- `packages/nax-agent-acp/src/client/rule-policy.ts` — `piLaunchEnv`, `piToolArgs`, `piWrapper`
- `packages/nax-agent-acp/src/client/shell-rules.ts` — `PI_SHELL_GATE_SOURCE`, `PI_SHELL_GATE_TITLE`
- `packages/nax-agent-acp/src/client/shell-sandbox.ts` — created by US-001, `sandboxWrapSnippet` added by US-002
- `packages/nax-agent-acp/test/unit/client/backend-policy.test.ts` — pi wrapper argv assertions

**US-004**

- `packages/nax-agent-acp/src/client/rule-policy.ts` — `policyLaunchEnv`, `opencodePermissionConfig`
- `packages/nax-agent-acp/src/client/shell-sandbox.ts` — created by US-001, `sandboxWrapSnippet` added by US-002
- `packages/nax-agent-acp/test/unit/client/backend-opencode.test.ts` — opencode launch-env assertions
- `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts` — the relaunch path

**US-005**

- `packages/nax-agent-acp/src/client/rule-policy.ts` — `policyLaunchEnv`, `cursorCliConfig`
- `packages/nax-agent-acp/src/client/capabilities.ts` — `modeFor`, `reviewDecidesShell`
- `packages/nax-agent-acp/src/client/shell-sandbox.ts` — created by US-001, `sandboxWrapSnippet` added by US-002
- `packages/nax-agent-acp/test/unit/client/backend-cursor.test.ts` — Cursor mode and launch-env assertions

**US-006**

- `packages/nax/src/agents/acp/open-context.ts` — `backendOptions`
- `packages/nax/src/agents/shared/acp-env.ts` — `acpEnvSettings`, `withAcpEnv`
- `packages/nax/src/config/schemas-acp-agents.ts` — per-agent ACP schema module (gemini pattern)
- `packages/nax/src/config/schemas-infra.ts` — `AgentAcpConfigSchema`, literal `agent.acp` default, 595-line budget
- `packages/nax/src/config/runtime-types-agent.ts` — `AgentAcpConfig`

**US-007**

- `packages/nax/src/cli/sandbox-probe.ts` — `_sandboxProbeCmdDeps`, backend lifecycle
- `packages/nax/bin/nax.ts` — the `sandbox` command group
- `docs/guides/permissions.md` — "ACP agents" section, its review-shell statements
- `docs/guides/configuration.md` — `agent.acp` keys
- `docs/guides/cli-reference.md` — the `nax sandbox probe` entry

### Creates

**US-001**

- `packages/nax-agent-acp/src/client/shell-sandbox.ts`
- `packages/nax-agent-acp/test/unit/client/shell-sandbox.test.ts`

**US-002**

- `packages/nax-agent-acp/test/unit/client/backend-shell-sandbox.test.ts`

**US-003**

- `packages/nax-agent-acp/src/client/pi-sandbox.ts`
- `packages/nax-agent-acp/test/unit/client/pi-sandbox.test.ts`
- `packages/nax-agent-acp/test/fixtures/pi-module.mjs`

**US-004**

- `packages/nax-agent-acp/src/client/opencode-sandbox.ts`
- `packages/nax-agent-acp/test/unit/client/opencode-sandbox.test.ts`

**US-005**

- `packages/nax-agent-acp/src/client/cursor-sandbox.ts`
- `packages/nax-agent-acp/test/unit/client/cursor-sandbox.test.ts`

**US-006**

- `packages/nax/src/agents/shared/acp-shell-sandbox-env.ts`
- `packages/nax/test/unit/agents/shared/acp-shell-sandbox-env.test.ts`

**US-007**

- `packages/nax/src/cli/sandbox-exec.ts`
- `packages/nax/test/unit/cli/sandbox-exec.test.ts`

### Modifies

**US-001**

None. The new option is optional and every existing test constructs options without it; `resolved` adds `shellSandbox: undefined`, which existing `toEqual` assertions ignore.

**US-002**

None. The new `decideReview` branch runs only when `PermissionContext.shellSandbox` is set, which no existing test sets; `modeFor`'s new parameter is optional.

**US-003**

None. `piToolArgs`'s new parameter is optional and the existing pi tests run without a sandbox plan.

**US-004**

None. Existing opencode tests run without a sandbox plan, so their launch env is unchanged.

**US-005**

None. Existing Cursor tests run without a sandbox plan, so their mode and launch env are unchanged.

**US-006**

- `packages/nax/test/unit/config/agent-schema.test.ts` — the closed-world `expect(result.agent?.acp).toEqual({...})` (around line 162) pins the parsed `agent.acp` default; it gains `shellSandbox: { mode: "auto", pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } }`, and the invariant becomes "the default `agent.acp` equals the full default block, `shellSandbox` included".
- `packages/nax/test/unit/agents/shared/acp-env.test.ts` — the closed-world `acpEnvSettings(...)` `toEqual` assertions (around lines 43 and 51) and the literal `AcpEnvSettings` arguments to `withAcpEnv` gain the `shellSandbox` entry (`mode: "off"` in the literals, so those tests keep asserting codex/opencode/gemini behaviour alone); the invariant becomes "the settings object has one entry per injecting concern, `shellSandbox` included".
- `packages/nax/test/unit/agents/complete-as-with-fallback.test.ts` — "US-002: isolateConfig false forwards the model def untouched" (around line 262) expects an opencode def's env to equal `{}`; with `agent.acp.shellSandbox.mode` defaulting to `"auto"` it now also carries `NAX_ACP_SHELL_SANDBOX`, so the assertion becomes "the env has no `OPENCODE_CONFIG_DIR`" (the isolateConfig invariant it guards).
- `packages/nax/test/unit/session/manager-phase-b-session.test.ts` — "AC-33: isolateConfig false (schema default)…" (around line 398) expects an opencode def's env to equal `{}`; it becomes "the env has no `OPENCODE_CONFIG_DIR`", for the same reason.
- `packages/nax/test/unit/session/model-selection.test.ts` — the literal `AcpEnvSettings` objects passed to `selectModel` (around lines 38-44 and 52-58, agents `codex` and `claude`) gain `shellSandbox: { mode: "off", pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } }` so they typecheck; the invariant they assert (codex gets `INITIAL_AGENT_MODE`, claude's env stays `{}`) is unchanged.

**US-007**

None. `sandbox-exec.ts` and its test are new, the `sandbox exec` registration is additive, and no existing test pins the `sandbox` command group's subcommand list.

### Seams

- US-001 → US-002: `shellSandboxPlan` is consumed by `connect`; US-002's integration ACs enter at the backend's `open()` and observe the plan through the written policy file and the permission decision.
- US-002 → US-003/US-004/US-005: `sandboxWrapSnippet` and `policyLaunchEnv`'s plan branch are consumed by each agent module; each story's integration ACs enter at the backend's `open()` and observe the launch env and written files.
- US-001 → US-006: the `shellSandbox` backend option is produced by `backendOptions`; US-006's ACs assert the produced option object, and US-001's ACs assert the backend accepts that shape.
- US-001 ↔ US-007 (file contract, re-encoded as JSON): nax-agent-acp writes `{ version: 1, home, stripEnv, policy }` and `nax sandbox exec` reads exactly that shape with a strict schema. US-001's `policyContent` AC pins the writer's content; US-007's valid-file and extra-field ACs pin the reader's acceptance and its fail-closed refusal of anything else.

## Acceptance Criteria

### US-001

1. [unit] `resolveAcpOptions({ agent: "pi", allowUnsandboxed: true, shellSandbox: { runtime: "/usr/local/bin/bun", runner: ["/opt/nax/nax.js", "sandbox", "exec"] } })` returns `shellSandbox` equal to `{ runtime: "/usr/local/bin/bun", runner: ["/opt/nax/nax.js", "sandbox", "exec"], piExtensions: "user", opencodeProjectConfig: "disable", cursorOnUnwrapped: "rules" }`.
2. [unit] `resolveAcpOptions` with `shellSandbox` also carrying `pi: { extensions: "none" }`, `opencode: { projectConfig: "keep" }` and `cursor: { onUnwrapped: "deny" }` returns `piExtensions: "none"`, `opencodeProjectConfig: "keep"` and `cursorOnUnwrapped: "deny"`.
3. [unit] `resolveAcpOptions({ agent: "pi", allowUnsandboxed: true })` returns `shellSandbox` `undefined`.
4. [unit] `resolveAcpOptions` with `shellSandbox.runtime` `"bun"` throws an `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS` and path `shellSandbox.runtime`.
5. [unit] `resolveAcpOptions` with `shellSandbox.runner` `[]` throws `AGENT_SESSION_INVALID_OPTIONS` with path `shellSandbox.runner`.
6. [unit] `resolveAcpOptions` with `shellSandbox.cursor.onUnwrapped` `"allow"` throws `AGENT_SESSION_INVALID_OPTIONS` with path `shellSandbox.cursor.onUnwrapped`.
7. [unit] `shellSandboxPlan("review", <opencode options with shellSandbox>, { kind: "policy", policy }, "/w")` resolves to a plan with `agent` `"opencode"` and `verify` `false`.
8. [unit] `shellSandboxPlan("review", <pi options with shellSandbox>, { kind: "policy", policy }, "/w")` resolves to a plan with `agent` `"pi"` and `verify` `false`.
9. [unit] `shellSandboxPlan("review", <cursor options with shellSandbox>, { kind: "policy", policy }, "/w")` resolves to a plan with `agent` `"cursor"`, `verify` `true` and `onUnwrapped` `"rules"`.
10. [unit] `shellSandboxPlan("full", <opencode options with shellSandbox>, { kind: "policy", policy }, "/w")` resolves to `undefined`.
11. [unit] `shellSandboxPlan("review", <opencode options with shellSandbox>, { kind: "unavailable", reason: "no bwrap" }, "/w")` resolves to `undefined` without throwing.
12. [unit] `shellSandboxPlan("review", <opencode options with shellSandbox>, undefined, "/w")` resolves to `undefined`.
13. [unit] `shellSandboxPlan("review", <claude options with shellSandbox>, { kind: "policy", policy }, "/w")` resolves to `undefined`.
14. [unit] `shellSandboxPlan("review", <opencode options without shellSandbox>, { kind: "policy", policy }, "/w")` resolves to `undefined`.
15. [unit] `shellSandboxPlan("review", <opencode options with opencodeProjectConfig "keep">, { kind: "policy", policy }, "/w")` resolves to `undefined`.
16. [unit] A plan's `policy.denyWrite` equals the input policy's `denyWrite` followed by the realpath of `options.stateDir`, and `options.stateDir` exists as a directory afterwards.
17. [unit] With `_shellSandboxDeps.homedir` returning a temp home that contains `.local/share/opencode/auth.json`, a plan's `policy.denyRead` equals the input `denyRead` followed by that file's realpath.
18. [unit] With a temp home that contains neither `.local/share/opencode/auth.json` nor `.pi/agent/auth.json`, a plan's `policy.denyRead` equals the input `denyRead`.
19. [unit] A plan's `policyContent` equals `JSON.stringify({ version: 1, home: <temp home>, stripEnv: plan.stripEnv, policy: plan.policy })`.
20. [unit] A plan's `policyFile` equals `join(stateDir, "sandbox", "policy-" + <first 16 hex characters of the SHA-256 of policyContent> + ".json")`.
21. [unit] A plan's `prefix` equals `[runtime, ...runner, policyFile].map(shellQuote).join(" ") + " "`.
22. [unit] `shellQuote("it's")` returns `'it'\''s'`.
23. [unit] For Cursor options whose `env` is `{ CURSOR_API_KEY: "k-123456789", OPENROUTER_API_KEY: "sk-or-123456789", PATH: "/bin" }` with both key values among `options.secrets`, a plan's `stripEnv` equals `["CURSOR_API_KEY", "OPENROUTER_API_KEY"]`.

### US-002

1. [unit] `wrapForSandbox(prefix, "echo 'a b' > x")` returns `prefix` followed by `'echo '\''a b'\'' > x'`.
2. [unit] `isSandboxWrapped(prefix, wrapForSandbox(prefix, "echo 'a b' > x"))` returns `true`.
3. [unit] `isSandboxWrapped(prefix, wrapForSandbox(prefix, "ls") + "; touch x")` returns `false`.
4. [unit] `isSandboxWrapped(prefix, "rtk " + wrapForSandbox(prefix, "ls"))` returns `false`.
5. [unit] `wrapForSandbox(prefix, wrapForSandbox(prefix, "ls"))` returns `prefix` followed by `shellQuote(wrapForSandbox(prefix, "ls"))` (no pass-through for a command that already starts with the prefix).
6. [unit] Importing a module written to a temp file as `sandboxWrapSnippet(prefix)` followed by `export { naxSandboxWrap };`, `naxSandboxWrap("echo 'a b' > x")` returns `wrapForSandbox(prefix, "echo 'a b' > x")`.
7. [unit] `REVIEW_UNWRAPPED_REASON` equals `"the command did not arrive in nax's sandbox wrapper"`.
8. [unit] `decidePermission` under `review` with `agentName: "opencode"`, `shellSandbox: { prefix, verify: false, onUnwrapped: "rules" }`, no Bash rules, and an `execute` request whose `rawInput.command` is `"bun test"` selects the allow-once option and records an auto decision with reason `REVIEW_EXECUTE_REASON`.
9. [unit] `decidePermission` under `review` with `agentName: "pi"`, `shellSandbox: { prefix, verify: false, onUnwrapped: "rules" }`, and a pi gate request (kind `other`, `rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "ls" }`) selects allow-once with reason `REVIEW_EXECUTE_REASON`.
10. [unit] `decidePermission` under `review` with `agentName: "cursor"`, `shellSandbox: { prefix, verify: true, onUnwrapped: "rules" }`, and an `execute` request titled with backticks around `wrapForSandbox(prefix, "ls")` selects allow-once with reason `REVIEW_EXECUTE_REASON`.
11. [unit] `decidePermission` under `review` with `agentName: "cursor"`, `shellSandbox: { prefix, verify: true, onUnwrapped: "deny" }`, and an `execute` request titled `` `ls` `` rejects with reason `REVIEW_UNWRAPPED_REASON`.
12. [unit] `decidePermission` under `review` with `agentName: "cursor"`, `shellSandbox: { prefix, verify: true, onUnwrapped: "rules" }`, rules allowing `Bash(ls)`, and an `execute` request titled `` `ls` `` selects allow-once with reason `SHELL_RULE_REASON`.
13. [unit] `decidePermission` under `review` with `agentName: "cursor"`, `shellSandbox: { prefix, verify: true, onUnwrapped: "rules" }`, no Bash rules, and an `execute` request titled `` `ls` `` rejects with reason `REVIEW_NO_SANDBOX_REASON`.
14. [unit] `decidePermission` under `review` with `shellSandbox` set and an `edit` request rejects with the review read-only reason, recording no allow.
15. [unit] `decidePermission` under `review` with `agentName: "opencode"`, `shellSandbox` set, and an `execute` request that offers no allow-once option rejects with reason `NO_ALLOW_ONCE_REASON`.
16. [unit] `decidePermission` under `review` with `agentName: "opencode"`, `shellSandbox` set, rules denying `Bash(rm *)`, and an `execute` request whose `rawInput.command` is `"rm x"` rejects with reason `SHELL_RULE_BLOCKED_REASON`.
17. [unit] `decidePermission` under `review` with `agentName: "cursor"`, `shellSandbox: { prefix, verify: true, onUnwrapped: "rules" }`, rules asking for `Bash(git push *)`, and an `execute` request titled with backticks around `wrapForSandbox(prefix, "git push origin")` rejects with reason `SHELL_RULE_BLOCKED_REASON`.
18. [integration] Opening an opencode session under `review` with a `policy` sandbox and `shellSandbox` set writes a file at the plan's `policyFile` whose content equals the plan's `policyContent`, and the file exists when the fake agent's launch request is recorded.
19. [integration] Opening an opencode session under `review` with a `policy` sandbox and `shellSandbox` set, then having the fake agent send an `execute` permission request with `rawInput.command` `"ls"`, approves it with reason `REVIEW_EXECUTE_REASON`.
20. [integration] Opening an opencode session under `review` with a `policy` sandbox but no `shellSandbox` option, the same `execute` request with no Bash rules is rejected with reason `REVIEW_NO_SANDBOX_REASON`.
21. [integration] Opening a pi session under `review` with sandbox `{ kind: "unavailable", reason: "x" }` and `shellSandbox` set succeeds, and no `sandbox` directory is created under `stateDir`.
22. [integration] When `_policyFilesDeps.writeFile` rejects for the policy file's temporary path, opening an opencode session under `review` with a `policy` sandbox and `shellSandbox` set fails with `AGENT_SESSION_BACKEND_UNAVAILABLE` whose message names the policy file path, and the fake agent records no launch request.
23. [unit] `writeStateFile(stateDir, "sandbox/x.json", "{}", 0o600)` resolves to `join(stateDir, "sandbox", "x.json")`, and that file then holds `{}` with mode `0600`.
24. [integration] When `_shellSandboxDeps.mkdir` rejects for `stateDir`, opening an opencode session under `review` with a `policy` sandbox and `shellSandbox` set fails with `AGENT_SESSION_BACKEND_UNAVAILABLE` whose message names `stateDir`, and the fake agent records no launch request.

### US-003

1. [integration] Opening a pi session under `review` with a `policy` sandbox, `shellSandbox` set and no Bash rules launches with `PI_ACP_PI_COMMAND` naming a wrapper that execs pi with `-e`, `<stateDir>/pi/sandbox-gate-<16 hex>.ts`, `--tools`, `read,grep,find,ls,bash`, then `"$@"`.
2. [integration] The same open with `shellSandbox.pi.extensions` `"none"` launches pi with `--no-extensions` as the first argument after the pi command, before `-e`.
3. [integration] The same open with a `Bash(ls)` allow rule loads the `sandbox-gate` extension, not the `shell-gate` one.
4. [integration] Opening a pi session under `review` with sandbox `{ kind: "unavailable", reason: "x" }`, `shellSandbox` set and no Bash rules launches pi with `--tools read,grep,find,ls` and no `-e` argument (today's behaviour).
5. [integration] The `sandbox-gate` file written by such an open has mode `0600`.
6. [unit] `piToolArgs("review", NO_RULES, "/g.ts", { extensions: "user" })` returns `["-e", "/g.ts", "--tools", "read,grep,find,ls,bash"]`.
7. [unit] `piToolArgs("review", NO_RULES, "/g.ts", { extensions: "none" })` returns `["--no-extensions", "-e", "/g.ts", "--tools", "read,grep,find,ls,bash"]`.
8. [unit] Importing a module written from `piSandboxGateSource(prefix, <fixture pi module path>)` and calling its default export with a fake pi API calls `registerTool` exactly once with a tool named `"bash"`.
9. [unit] The fixture `createBashTool` receives a `spawnHook` that, given `{ command: "ls", cwd: "/w", env: { A: "1" } }`, returns `{ command: wrapForSandbox(prefix, "ls"), cwd: "/w", env: { A: "1" } }`.
10. [unit] The registered `bash` tool's `execute("id", { command: "ls" }, signal, onUpdate)` calls the fixture tool's `execute` with the same four arguments.
11. [unit] The extension's `tool_call` handler, for `{ toolName: "bash", input: { command: "ls" } }` with a UI whose `confirm` resolves `true`, returns `undefined` after calling `confirm(PI_SHELL_GATE_TITLE, "ls")`.
12. [unit] The same handler with `confirm` resolving `false` returns `{ block: true, reason: PI_SHELL_GATE_REJECTED }`.
13. [unit] The same handler with no UI (`ctx.hasUI` false) returns `{ block: true, reason: PI_SHELL_GATE_REJECTED }`.
14. [unit] The same handler for `{ toolName: "read", input: {} }` returns `undefined` without calling `confirm`.

### US-004

1. [integration] Opening an opencode session under `review` with a `policy` sandbox and `shellSandbox` set launches with `OPENCODE_DISABLE_PROJECT_CONFIG` equal to `"1"`.
2. [integration] The same open launches with `OPENCODE_CONFIG_CONTENT` equal to `opencodePermissionConfig("review", rules)`.
3. [integration] The same open launches with `OPENCODE_CONFIG_DIR` equal to `<stateDir>/opencode/<16 hex>`, a directory containing `plugins/nax-shell-sandbox.js`.
4. [integration] With a temp home holding `.config/opencode/opencode.json` and a caller env with neither `OPENCODE_CONFIG_DIR` nor `XDG_CONFIG_HOME`, the same open launches with `OPENCODE_CONFIG` equal to that file's path.
5. [integration] With caller env `XDG_CONFIG_HOME` set to a temp dir holding `opencode/opencode.jsonc`, the same open launches with `OPENCODE_CONFIG` equal to `<XDG_CONFIG_HOME>/opencode/opencode.jsonc`.
6. [integration] With caller env `OPENCODE_CONFIG_DIR` set to an empty temp dir, the same open's launch env has no `OPENCODE_CONFIG` key set by nax.
7. [integration] With caller env `OPENCODE_CONFIG` set to `/my/opencode.json`, the launched process receives `OPENCODE_CONFIG` equal to `/my/opencode.json`.
8. [integration] With `<userConfigDir>/AGENTS.md` containing `G`, the workdir's `AGENTS.md` containing `W`, and its parent (holding `.git`) `AGENTS.md` containing `R`, the `AGENTS.md` in the launched `OPENCODE_CONFIG_DIR` equals `"G\n\nW\n\nR"`.
9. [integration] An `AGENTS.md` in the directory above the first ancestor holding `.git` is not part of the written `AGENTS.md`.
10. [integration] With no `AGENTS.md` in the user config dir, the workdir or its ancestors, the launched `OPENCODE_CONFIG_DIR` contains no `AGENTS.md`.
11. [integration] Opening the same session with `shellSandbox.opencode.projectConfig` `"keep"` launches with exactly today's opencode env: `OPENCODE_CONFIG_CONTENT` and none of `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG` set by nax.
12. [integration] After the fake opencode process exits and the session reconnects, the second launch's `OPENCODE_CONFIG_DIR` equals the first launch's.
13. [unit] Importing the plugin written from `opencodeSandboxPluginSource(prefix)`, its default export has `id` `"nax-shell-sandbox"`, and calling `setup` with a fake `ctx` registers exactly one hook named `"execute.before"` through `ctx.tool.hook`.
14. [unit] That hook, called with `{ tool: "shell", input: { command: "ls", description: "d" } }`, sets `event.input` to `{ command: wrapForSandbox(prefix, "ls"), description: "d" }`.
15. [unit] That hook, called with `{ tool: "bash", input: { command: "ls" } }`, sets `event.input.command` to `wrapForSandbox(prefix, "ls")`.
16. [unit] That hook, called with `{ tool: "read", input: { filePath: "a" } }`, leaves `event.input` equal to `{ filePath: "a" }`.
17. [integration] The `plugins/nax-shell-sandbox.js` file written by such an open has mode `0600`.

### US-005

1. [integration] Opening a Cursor session under `review` with a `policy` sandbox and `shellSandbox` set launches with `HOME` equal to `<stateDir>/cursor-home/<16 hex>`.
2. [integration] That `HOME` contains `.cursor/hooks.json` whose parsed content equals `{ version: 1, hooks: { preToolUse: [{ command: shellQuote(runtime) + " " + shellQuote(<hook file>), failClosed: true }] } }`, the hook file being `<stateDir>/cursor/sandbox-hook-<16 hex>.mjs`.
3. [integration] With `_shellSandboxDeps.platform` returning `"darwin"`, that `HOME` contains `Library/Keychains` as a symlink whose target is `<temp home>/Library/Keychains`.
4. [integration] With `_shellSandboxDeps.platform` returning `"linux"`, that `HOME` contains no `Library` entry.
5. [integration] When `_shellSandboxDeps.symlink` rejects on `darwin`, the open fails with `AGENT_SESSION_BACKEND_UNAVAILABLE` naming the `Library/Keychains` path, and the fake agent records no launch request.
6. [integration] The same open launches with `CURSOR_CONFIG_DIR` naming a directory whose `cli-config.json` equals `cursorCliConfig("review", rules)`.
7. [integration] The same open with no Bash rules sets the session config option `mode` to `"agent"`.
8. [integration] Opening a Cursor session under `review` with sandbox `{ kind: "unavailable", reason: "x" }`, `shellSandbox` set and no Bash rules sets `mode` to `"ask"` and launches with no `HOME` override from nax.
9. [unit] `modeFor("review", registryEntry("cursor"), NO_RULES, true)` returns `{ configId: "mode", value: "agent" }`.
10. [integration] Running `<test runtime> <hook file>` with stdin `{"tool_name":"Shell","tool_input":{"command":"ls","cwd":"","timeout":30000}}` exits 0 and prints JSON equal to `{ updated_input: { command: wrapForSandbox(prefix, "ls"), cwd: "", timeout: 30000 } }`.
11. [integration] Running the hook with stdin `{"tool_name":"Read","tool_input":{"path":"a"}}` exits 0 and prints `{}`.
12. [integration] Running the hook with stdin `not json` exits with code 1.
13. [integration] After such an open, a fake-agent `execute` permission request titled with backticks around `wrapForSandbox(<the plan's prefix>, "ls")` is approved with reason `REVIEW_EXECUTE_REASON`.
14. [integration] After an open with `shellSandbox.cursor.onUnwrapped` `"deny"`, a fake-agent `execute` permission request titled `` `ls` `` is rejected with reason `REVIEW_UNWRAPPED_REASON`.
15. [integration] With `_shellSandboxDeps.platform` returning `"darwin"`, a second open with the same plan (the `Library/Keychains` symlink already present with the same target) succeeds and launches with the same `HOME` as the first.
16. [integration] The hook file and `.cursor/hooks.json` written by such an open each have mode `0600`.

### US-006

1. [unit] `NaxConfigSchema.parse({}).agent?.acp?.shellSandbox` equals `{ mode: "auto", pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } }`.
2. [unit] `NaxConfigSchema.safeParse({ agent: { acp: { shellSandbox: { mode: "sometimes" } } } })` fails with an issue path ending in `mode`.
3. [unit] `acpShellSandboxSettings(undefined)` equals `DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG`, imported from `@/config`.
4. [unit] `withAcpShellSandboxEnv({ provider: "p", model: "m", env: { A: "1" } }, "pi", <default settings>)` returns a new def whose `env` equals `{ A: "1", NAX_ACP_SHELL_SANDBOX: JSON.stringify({ pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } }) }`, and the input def's `env` still equals `{ A: "1" }`.
5. [unit] `withAcpShellSandboxEnv(def, "claude", <default settings>)` returns `def` itself.
6. [unit] `withAcpShellSandboxEnv(def, "codex", {} as never)` returns `def` itself without throwing (the agent name is checked before `settings` is read).
7. [unit] `withAcpShellSandboxEnv(def, "cursor", <settings with mode "off">)` returns `def` itself.
8. [unit] `withAcpEnv(def, "opencode", acpEnvSettings(undefined))` returns a def whose `env.NAX_ACP_SHELL_SANDBOX` is set.
9. [integration] `SessionManager.openSession` for agent `opencode` with the default config hands the adapter a `modelDef.env` carrying `NAX_ACP_SHELL_SANDBOX` equal to `JSON.stringify({ pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } })`.
10. [unit] `backendOptions("opencode", <opts whose modelDef.env.NAX_ACP_SHELL_SANDBOX is the default value `JSON.stringify({ pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } })`>)`, with `_openContextDeps.execPath` returning `/bin/bun` and `_openContextDeps.entry` returning `/opt/nax/nax.js`, returns `shellSandbox` equal to `{ runtime: "/bin/bun", runner: ["/opt/nax/nax.js", "sandbox", "exec", "--"], pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } }`.
11. [unit] The same `backendOptions` call returns an `env` with no `NAX_ACP_SHELL_SANDBOX` key.
12. [unit] `backendOptions("opencode", <opts whose modelDef.env has no NAX_ACP_SHELL_SANDBOX>)` returns options with no `shellSandbox` key.
13. [unit] `backendOptions("opencode", <opts whose modelDef.env.NAX_ACP_SHELL_SANDBOX is "{not json">)` returns options with no `shellSandbox` key and an `env` with no `NAX_ACP_SHELL_SANDBOX` key.
14. [unit] `backendOptions("opencode", <opts whose modelDef.env.NAX_ACP_SHELL_SANDBOX is '{"pi":{"extensions":"x"},"opencode":{"projectConfig":"disable"},"cursor":{"onUnwrapped":"rules"}}'>)` returns options with no `shellSandbox` key.
15. [unit] `acpBackend(backendOptions("cursor", <opts whose modelDef.env.NAX_ACP_SHELL_SANDBOX is `JSON.stringify({ pi: { extensions: "user" }, opencode: { projectConfig: "disable" }, cursor: { onUnwrapped: "rules" } })`>))` does not throw (the produced option passes the backend's schema).

### US-007

1. [unit] `sandboxExecCommand(<valid policy file>, "exit 3")`, with `_sandboxExecDeps.createBackend` returning a fake backend whose `wrap` returns `["/bin/sh", "-c", "exit 3"]` and `_sandboxExecDeps.spawn` running that argv, returns `3`.
2. [unit] In that call `_sandboxExecDeps.createBackend` receives the file's `policy.network`, and the fake backend's `wrap` receives `command` `"exit 3"`, `shell` `"/bin/bash"`, the file's `policy`, and `cwd` equal to `_sandboxExecDeps.cwd()`.
3. [unit] With a policy file whose `home` is `/home/real`, `_sandboxExecDeps.spawn` receives an `env` whose `HOME` is `/home/real`.
4. [unit] With a policy file whose `stripEnv` is `["CURSOR_API_KEY"]` and `_sandboxExecDeps.env()` returning `{ CURSOR_API_KEY: "k", PATH: "/bin" }`, `_sandboxExecDeps.spawn` receives an `env` with `PATH` `"/bin"` and no `CURSOR_API_KEY` key.
5. [unit] `sandboxExecCommand(<missing path>, "true")` returns `126`, passes a line starting with `nax sandbox exec:` to `_sandboxExecDeps.stderr`, and never calls `wrap` or `_sandboxExecDeps.spawn`.
6. [unit] `sandboxExecCommand(<file whose policy carries an extra field "extra": 1>, "true")` returns `126` and never calls `_sandboxExecDeps.spawn`.
7. [unit] `sandboxExecCommand(<file with version 2>, "true")` returns `126` and never calls `_sandboxExecDeps.spawn`.
8. [unit] With the fake backend's `isSupportedPlatform` resolving `false`, `sandboxExecCommand` returns `126`, never calls `_sandboxExecDeps.spawn`, and calls the backend's `reset` once.
9. [unit] With the fake backend's `wrap` rejecting, `sandboxExecCommand` returns `126`, never calls `_sandboxExecDeps.spawn`, and calls the backend's `reset` once.
10. [unit] With `_sandboxExecDeps.spawn` reporting `{ exitCode: null, signal: "SIGTERM" }`, `sandboxExecCommand` returns `143`.
11. [unit] After a spawned command exits, the fake backend's `commandFinished` and `reset` have each been called once.
12. [unit] While a command runs, invoking the handler registered through `_sandboxExecDeps.onSignal("SIGTERM", …)` calls the spawned child's `kill("SIGTERM")`.
13. [integration] With the default `_sandboxExecDeps.spawn` and `_sandboxExecDeps.env` and only `createBackend` faked (its `wrap` returns `["/bin/sh", "-c", "printf '%s|%s' \"$HOME\" \"${CURSOR_API_KEY-unset}\" > out.txt; exit 3"]`), a policy file with `home` set to a temp dir and `stripEnv` `["CURSOR_API_KEY"]`, and `CURSOR_API_KEY` set in the test process env, `sandboxExecCommand` returns `3` and `out.txt` in `_sandboxExecDeps.cwd()` holds `<temp dir>|unset`.
14. [unit] A `sandboxExecCommand(<valid policy file>, "exit 0")` call with a fake backend and fake spawn writes nothing through `process.stdout`.
15. [cli] `nax sandbox exec --help` exits 0 and its usage names the `<policy-file>` and `<command>` arguments.
16. [cli] `nax sandbox exec -- <missing path> true` exits 126 and its stderr starts with `nax sandbox exec:`.
17. [cli] `nax sandbox exec -- <missing path> "-la"` exits 126 with stderr starting `nax sandbox exec:` (the `-la` command string is taken as the command argument, not as an option).
