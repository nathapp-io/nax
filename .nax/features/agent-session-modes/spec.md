# SPEC: agent-session-modes — unsandboxed fallback and per-command sandbox escape for native sessions

## Summary

`@nathapp/nax-agent` native sessions gain three things an interactive host needs
and today cannot get: (1) a `full` or `review` profile with `bashApproval: "raw"`
may opt into running unwrapped when the OS sandbox is unavailable, instead of
failing at creation, and every session reports its sandbox state on
`session.backend.sandbox`; (2) the command launcher honours a per-request
`unwrapped: true`, running one command outside the sandbox while the sandbox stays
on for the session; (3) the `Bash` tool and `RunCommand`'s `argv` branch accept an
`unsandboxed: true` argument with a stated reason, enabled only by a new session
option `allowUnsandboxedCommands`, so a model can ask for one command to reach the
network, the Docker socket or a local database port the sandbox cuts off. The
policy's deny, containment and lexer checks are unchanged. In every Bash approval
mode except `raw` the request becomes an approval the human answers, and the
approval says the command will run outside the sandbox. Under `raw` it runs
without asking.

This is feature F1 of the nax interactive coding agent, slice 1
(`docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md`, §5 and
§5.1). It changes only `packages/nax-agent`.

## Motivation

- **Full mode cannot run without a sandbox.** `nativeProfileRules`
  (`packages/nax-agent/src/session/native-backend-options.ts`) throws
  `allowUnsandboxed requires bashApproval "gated"`, and `resolveSessionLauncher`
  (`packages/nax-agent/src/session/session-tool-support.ts`) throws
  `AGENT_SESSION_SANDBOX_UNAVAILABLE` for a `raw` session when the probe fails. The
  interactive host's "full" mode is `profile: "full"` with `bashApproval: "raw"` and
  must keep working on a machine without `srt`, by the user's ruling of 2026-10-24.
- **The host cannot see the sandbox state.** `BackendInfo` carries `kind` and
  `capabilities: {}`; whether commands run wrapped is known only inside the Bash
  tool description. A host that must say "sandbox unavailable" in its status line
  has nothing to read.
- **There is no per-command escape.** `escalate` mode only turns a grant miss into
  an ask; nothing lets one command run unwrapped. The only unsandboxed option is
  the session-wide `allowUnsandboxed`, which is exactly the "turn the sandbox off
  for the session because one command needed Docker" outcome the user forbade.
  The user's rule: "unreachable" (network, Docker socket, local DB port, device)
  is handled per command, and the sandbox is never turned off for the session.

## Design

### Approach

Three small additive changes along the existing seams, no new subsystem:

1. **Sandbox floor (US-001).** `nativeProfileRules` accepts `allowUnsandboxed: true`
   with `bashApproval: "raw"` as well as `"gated"` (still refused with `"escalate"`,
   and the `ask` profile still forces `gated`). `resolveSessionLauncher` returns no
   launcher for an unavailable sandbox whenever `allowUnsandboxed` is true,
   regardless of `raw` vs `gated`, and returns the resolved `SandboxState` beside
   the launcher. With no launcher the Bash tool already takes its direct-spawn
   branch (`src/tools/bash.ts`, `opts.launcher` absent) and `rawRefusalFor(undefined)`
   is `undefined`, so `raw` runs unwrapped with no further change. `openNative`
   records the state on `BackendInfo.sandbox`, and the facade's `backend` getter in
   `agent-session.ts`, which today rebuilds the info from `kind` and `capabilities`
   only, copies `sandbox` through (shallow-frozen).
2. **Launcher (US-002).** `LaunchRequest` gains `unwrapped?: true`. `CommandLauncher.run`
   routes such a request to `runUnwrapped` even when `state.kind === "available"`,
   with `SandboxRecord { backend: "none", wrapped: false, reason: "requested" }`;
   `policyFor` and `afterWrapped` are not called for it. The session temp-directory
   overlay (`TMPDIR`/`TMP`/`TEMP`) still applies, as for every unwrapped run.
3. **Tools and runtime (US-003 to US-008).** A new coding-tool support option
   `unsandboxedCommands: boolean` (default false) flows from
   `NativeBackendOptions.allowUnsandboxedCommands` through `buildSessionToolSupport`,
   `buildCodingToolSupport` and `buildDeclaredCommandTools` to `createBashTool` and
   `createRunCommandTool`, and to `createCodingToolRuntime`. Each tool's `scope`
   always declares `unsandboxedField: "unsandboxed"` (so the runtime can see the
   field whether or not the option is on); only when the option is on does its
   `inputSchema` gain `unsandboxed` (boolean) and `unsandboxedReason` (string) and
   its description gain one sentence. The runtime's `callTool` reads the field
   first, but only for calls whose policy identity is `Bash` or `Exec` (a RunCommand
   declared-command call is left to the tool, which rejects the flag itself):
   - option off and `input.unsandboxed === true` -> outcome `{ kind: "error",
     content: "unsandboxed commands are not enabled for this session
     (allowUnsandboxedCommands)" }`, recorded through `logCall` like the unknown-tool
     refusal, before any policy evaluation or ask, nothing spawned;
   - otherwise the policy verdict is computed exactly as without the flag;
   - a deny stays a deny (same `reason`, same `breach`);
   - an `ask` verdict proceeds as an ask whose `AskRequest` carries
     `unsandboxed: true` and a reason suffix;
   - an allow verdict under any Bash approval mode other than `raw` is converted to
     an ask whose `rule` is `Unsandboxed(<identity>)` and whose `matchedRule` stays
     unset (no ask rule matched, so remembered approvals derive no origin from it),
     so `gated`, `escalate`, and `Exec` calls that have no ask rule all reach the human;
   - an allow verdict under `raw` runs.
   On allow the tool passes `unwrapped: true` to the launcher. A session whose
   launcher was dropped by `allowUnsandboxed` has nothing to unwrap: the tool
   direct-spawns as it does for every call, and the ask still says the command
   runs outside the sandbox, which is true.

Where the code goes, because three enforced gates would otherwise go red on a
correct build (`check-file-sizes`: 600 source lines, 800 test lines, empty
baseline; `complexity-baseline.json`: limit 20, `buildDeclaredCommandTools`
baselined at 24 and `buildCodingToolSupport` at 35, baselines only shrink):

- The unsandboxed routing is one exported helper in
  `src/tools/runtime-calltool.ts` (330 lines today), `resolveUnsandboxedCall`,
  which `callTool` in `src/tools/runtime.ts` (569 lines today) calls in one line.
- The reason renderer is `unsandboxedReasonSuffix(input)` in
  `src/tools/ask-request.ts`, exported from that module (tests import
  `#src/tools/ask-request`; it is not added to the package's `.` entry).
- `resolveAskOutcome` takes an optional `unsandboxed?: { readonly suffix: string }`
  argument; when present it sets `unsandboxed: true` on the `AskRequest` and
  appends the suffix to `reason`.
- `buildDeclaredCommandTools` and `buildCodingToolSupport` receive the flag through
  one small extracted helper each (for example `unsandboxedToolOptions(args)`), so
  their complexity does not rise; `callTool`'s single call keeps it under 20.
- The runtime routing tests go in a new file
  `packages/nax-agent/test/unit/tools/runtime-unsandboxed.test.ts` (listed under
  Creates), because `runtime.test.ts` is at 755 lines.

Why the approval carries the flag rather than a new ask kind: the session ask path
is `approval_requested` -> `session.answer()`
(`src/session/session-ask-link.ts`, `src/session/session-ask-port.ts`). One
optional field on `AskRequest`, `ApprovalRequest` (which `createSessionAskLink`
builds), `ApprovalAsk` (which `createSessionAskPort` derives from it) and the
`approval_requested` body reuses that path unchanged for hosts that ignore it.

Why no approval event under `raw`: `raw` never asks, by definition (ADR-030), and
the user's "full" mode never asks. A session today records tool calls through a
non-recording sink (`buildSessionToolSupport` passes no `auditDir`, so
`supportSink` returns `createNoOpToolAuditSink()`), so there is no durable session
ledger to assert on; the sandbox record with `reason: "requested"` reaches the
audit row wherever a caller does configure `auditDir`, and the host observes the
unwrapped run through the launcher. Plumbing an audit directory into sessions is
out of scope here.

### Integration (extends existing code)

Read-only symbols, verified 2026-10-24 on `main` (symbols this feature changes are
listed only in the mutated block below, with their target shape):

- `packages/nax-agent/src/config/bash-approval.ts` — `BashApprovalModeSchema =
  z.enum(["raw", "gated", "escalate"])`, `DEFAULT_BASH_APPROVAL_MODE = "raw"`.
- `packages/nax-agent/src/session/agent-session-types.ts:17` — `AgentSessionProfile =
  "none" | "read" | "review" | "ask" | "full"`.
- `packages/nax-agent/src/session/session-tool-support.ts` — `askRulesFor(declared,
  bashApproval, profile)` adds a `Bash(*)` ask rule under `gated` only (under
  `escalate` it adds none, and it never adds one for `Exec`); `declaredToolsFor`;
  `SESSION_STAGE = "session"`.
- `packages/nax-agent/src/session/session-ask-link.ts` — `askPerson(deps, ask,
  signal)` emits `approval_requested` from an `ApprovalAsk`; `createSessionAskLink`
  builds an `ApprovalRequest` from the `AskRequest` and hands it to
  `port.requestApproval`.
- `packages/nax-agent/src/session/session-ask-port.ts` — `createSessionAskPort`;
  `requestApproval` strips `signal` and forwards the rest as the `ApprovalAsk`.
- `packages/nax-agent/src/sandbox/types.ts:70` — `SandboxState` (`disabled` |
  `available { backend, network, sharedTmp? }` | `unavailable { backend, reason }`);
  `SandboxRecord` at line 85.
- `packages/nax-agent/src/sandbox/launcher.ts` — `createCommandLauncher(options)`;
  private `runUnwrapped` and `runWrapped`; `_launcherDeps.runArgv` is the spawn
  seam tests stub.
- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts` —
  `resolveSessionSandbox(args)`; `rawRefusalFor(launcher)` is `undefined` for an
  absent launcher.
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts` —
  `buildCodingToolSupport(args)` (args include `auditDir?`, `launcher?`, and an
  optional `bashApproval` resolved locally to `"gated"` when absent); it delegates
  tool construction to `buildDeclaredCommandTools` and builds the runtime with
  `createCodingToolRuntime`; `supportSink` returns a no-op sink when `auditDir` is
  absent.
- `packages/nax-agent/src/coding-tools/coding-tool-extras.ts:43` —
  `buildDeclaredCommandTools(args)` is the only caller of `createBashTool` (line 83)
  and `createRunCommandTool` (line 47), and owns the `launcher` and `exec` plumbing.
- `packages/nax-agent/src/tools/bash.ts` — `createBashTool`; `BashToolOptions.launcher?`
  (line 79); `inputSchema` at 321-332 (`command`, `timeoutMs`, `description`);
  `launchIntercepted` calls `opts.launcher.run({ spec: { kind: "shell", ... }, root,
  ...common })` at 290-294 or `_bashToolDeps.runArgv` at 295.
- `packages/nax-agent/src/tools/run-command.ts` — `createRunCommandTool(declared,
  opts)`; `RunCommandExecOptions.launcher?`; argv schema and `scope.argvField` only
  with `opts.exec`.
- `packages/nax-agent/src/tools/run-command-exec.ts` — `runExecBranch(input, ctx,
  opts)` normalizes the argv through the package-manager table (an install such as
  `["bun","add","x"]` becomes `["bun","add","x","--ignore-scripts"]` when
  `allowScripts` is false; `["bun","--version"]` is left alone) and forwards
  `normalized.argv` to the private `launchExec`, which calls
  `req.launcher.run({ spec: { kind: "argv", argv }, ... })` at 84-92.
- `packages/nax-agent/src/tools/ask-request.ts` — `askSummary(tool, scope, input)`;
  `maskForPrompt` from `#src/permissions/index`; `MAX_ASK_SUMMARY_CHARS = 200`.
- `packages/nax-agent/src/tools/runtime.ts` — `createCodingToolRuntime(opts)` at
  153; `callTool` resolves `tool = lookup(name)` and has `input` before
  `opts.policy.check` (359-369), calls `resolveAskOutcome` for an `ask` verdict
  (502-518) and for a guard denial (550), and ends the allow path in `runTool(tool,
  input, verdict.resolvedPaths)`. `CodingToolOutcome` (61-70) is `{ kind: "ok" |
  "error"; content; finalizeAudit? } | { kind: "denied"; reason; breach }`.
- `packages/nax-agent/src/tools/runtime-calltool.ts:212-281` — `resolveAskOutcome`
  builds the `AskRequest` (`reason: verdict.reason` at 248; `matchedRule` set when
  `verdict.rule` is defined).
- `packages/nax-agent/src/native/session/tool-input-validation.ts` — in a live session a
  non-boolean `unsandboxed` is rejected at the transport boundary when the schema
  declares it (option on); with the option off the extra property passes through.
- `packages/nax-agent/api/nax-agent.api.txt` — one line per exported NAME. This
  feature adds no export name to `.` or `./internal`, so `bun run check:api` stays
  green without an `api:update`.

Mutated symbols. The baseline exists only to locate the code; the target is the
interface to implement.

- `nativeProfileRules(profile, raw)` in
  `packages/nax-agent/src/session/native-backend-options.ts`
  - Baseline: throws `allowUnsandboxed requires bashApproval "gated"` whenever
    `raw.allowUnsandboxed === true && bashApproval !== "gated"`; returns
    `{ bashApproval, allowUnsandboxed }`.
  - Target: throws `allowUnsandboxed requires bashApproval "gated" or "raw"` only
    when `bashApproval === "escalate"`; accepts `allowUnsandboxed: true` with `"raw"`
    for profiles `full` and `review` (the `ask` profile still throws `profile "ask"
    requires bashApproval "gated"` first); returns `{ bashApproval, allowUnsandboxed,
    allowUnsandboxedCommands }` where `allowUnsandboxedCommands` is
    `raw.allowUnsandboxedCommands === true`; throws `allowUnsandboxedCommands applies
    to profiles "ask", "full" and "review" only` for `none`/`read` when the field is
    set.
- `NativeBackendOptions` and `OptionsSchema` in the same file
  - Target: `readonly allowUnsandboxedCommands?: boolean`, validated as optional boolean.
- `resolveSessionLauncher(args)` in
  `packages/nax-agent/src/session/session-tool-support.ts`
  - Baseline: `Promise<CommandLauncher | undefined>`; returns `undefined` for a
    non-available launcher only when `args.bashApproval === "gated" &&
    args.allowUnsandboxed`; error text names `gated`.
  - Target: `Promise<{ launcher: CommandLauncher | undefined; sandbox: SandboxState }>`.
    Returns `launcher: undefined` for a non-available launcher whenever
    `args.allowUnsandboxed` is true; `sandbox` is the launcher's `state` when
    available, the launcher's `unavailable` state when it was dropped, and
    `{ kind: "disabled" }` for the `none`/`read` profiles. The error message ends
    `Pass allowUnsandboxed: true to run without one.`
- `SessionToolSupportArgs` / `buildSessionToolSupport` in the same file
  - Target: `readonly unsandboxedCommands?: boolean` (optional, default false),
    forwarded to `buildCodingToolSupport` as `unsandboxedCommands`.
- `BackendInfo` in `packages/nax-agent/src/session/session-backend.ts:12`
  - Baseline: `{ kind; capabilities }`.
  - Target: `{ kind; capabilities; sandbox?: SandboxState }`; `openNative` sets it
    for the native backend; the ACP backend leaves it absent.
- `get backend()` in `packages/nax-agent/src/session/agent-session.ts:73-76`
  - Baseline: returns a frozen `{ kind, capabilities }` only.
  - Target: additionally copies `sandbox` (shallow-frozen) when present on `opened.info`.
- `ApprovalRequest` (`session-backend.ts:19`) and `ApprovalAsk` (`session-ask-link.ts`)
  - Target: `readonly unsandboxed?: true`; `createSessionAskLink` copies it from
    `AskRequest.unsandboxed` onto the `ApprovalRequest`, `createSessionAskPort`'s
    rest-spread carries it into the `ApprovalAsk`, and `askPerson` emits it on
    `approval_requested`.
- `approval_requested` body in `packages/nax-agent/src/session/agent-session-types.ts:105-116`
  - Target: `readonly unsandboxed?: true` added to the union member.
- `AskRequest` in `packages/nax-agent/src/permissions/types.ts:13`
  - Target: `readonly unsandboxed?: true`.
- `LaunchRequest` in `packages/nax-agent/src/sandbox/types.ts:102`
  - Target: `readonly unwrapped?: true`.
- `CommandLauncher.run` in `packages/nax-agent/src/sandbox/launcher.ts`
  - Baseline: wraps whenever `state.kind === "available"`.
  - Target: when `req.unwrapped === true`, runs through `runUnwrapped` with
    `SandboxRecord { backend: "none", wrapped: false, reason: "requested" }`,
    skipping `policyFor` and `afterWrapped`; every other request is unchanged.
- `ToolScope` in `packages/nax-agent/src/tools/types.ts:76`
  - Target: `readonly unsandboxedField?: string` added beside the existing fields.
- `BashToolOptions` / `createBashTool` in `packages/nax-agent/src/tools/bash.ts`
  - Target: `readonly unsandboxedCommands?: boolean`. `scope` always has
    `unsandboxedField: "unsandboxed"`. When the option is true: `inputSchema` gains
    `unsandboxed: { type: "boolean" }` and `unsandboxedReason: { type: "string" }`,
    and the description gains, appended after today's last sentence, `Set
    "unsandboxed": true with an "unsandboxedReason" only when the command needs the
    network, a local socket or a device the sandbox blocks.` When false or absent,
    `inputSchema` and `description` are byte-identical to today's. `run` passes
    `unwrapped: true` on the launcher request when `input.unsandboxed === true`; with
    no launcher it direct-spawns as today. The tool itself never checks the option.
- `RunCommandExecOptions` / `createRunCommandTool` / `runExecBranch` in
  `packages/nax-agent/src/tools/run-command.ts` and `run-command-exec.ts`
  - Target: `RunCommandExecOptions.unsandboxedCommands?: boolean`. `scope` has
    `unsandboxedField: "unsandboxed"` whenever `opts.exec` is set. When the option is
    true and `exec` is set: the same two schema properties and, appended, the
    sentence `Set "unsandboxed": true with an "unsandboxedReason" only when the argv
    needs the network, a local socket or a device the sandbox blocks.`
    `runExecBranch` passes `unwrapped: true` to `launchExec`, which sets it on the
    `LaunchRequest`. The declared-command (`command`) branch returns `{ content:
    '"unsandboxed" applies only to "argv" calls', isError: true }` when
    `input.unsandboxed === true`.
- `unsandboxedReasonSuffix(input)` in `packages/nax-agent/src/tools/ask-request.ts` (new export of that module)
  - Target: returns ` -- runs OUTSIDE the sandbox: ` + rendered reason, where the
    rendered reason is `input.unsandboxedReason` passed through `maskForPrompt` and
    cut to `MAX_ASK_SUMMARY_CHARS` when it is a string; `reason withheld` when
    masking reports unshowable; `no reason given` when absent or not a string.
- `resolveAskOutcome(args)` in `packages/nax-agent/src/tools/runtime-calltool.ts:212-281`
  - Target: new optional `unsandboxed?: { readonly suffix: string }`; when present
    the built `AskRequest` has `unsandboxed: true` and `reason` = the verdict reason
    + `suffix`; `matchedRule` is set only when `verdict.rule` came from a real ask
    rule (the converted-allow verdict passes `rule: "Unsandboxed(<identity>)"` and
    `matchedRule` stays unset).
- `resolveUnsandboxedCall(args)` in `packages/nax-agent/src/tools/runtime-calltool.ts` (new export of that module)
  - Target: called by `callTool` once per call, before `opts.policy.check`, with the
    tool, input, policy identity and the runtime's `unsandboxed` option. Returns
    `undefined` when the identity is not `Bash` or `Exec`, the scope has no
    `unsandboxedField`, or `input[field] !== true`. Returns `{ kind: "error",
    content: "unsandboxed commands are not enabled for this session
    (allowUnsandboxedCommands)" }` when the option is not enabled. Otherwise returns
    a marker that makes `callTool` (a) evaluate the policy with the field ignored,
    (b) convert an allow verdict into an ask with `rule: "Unsandboxed(<identity>)"`
    and reason `unsandboxed run requested` when `bashApproval !== "raw"`, and (c)
    pass `{ suffix: unsandboxedReasonSuffix(input) }` into `resolveAskOutcome` for
    any ask it raises.
- `createCodingToolRuntime(opts)` / `callTool` in `packages/nax-agent/src/tools/runtime.ts`
  - Target: new option `unsandboxed?: { enabled: boolean; bashApproval:
    BashApprovalMode }` (absent means `enabled: false`); `callTool` applies
    `resolveUnsandboxedCall` as described and records the refusal through `logCall`
    as an error outcome.
- `buildCodingToolSupport` args in
  `packages/nax-agent/src/coding-tools/coding-tool-support.ts`
  - Target: `readonly unsandboxedCommands?: boolean`, forwarded through a small
    helper to `buildDeclaredCommandTools` and to `createCodingToolRuntime` as
    `unsandboxed: { enabled, bashApproval: <the locally resolved bashApproval> }`.
- `buildDeclaredCommandTools` args in
  `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`
  - Target: `readonly unsandboxedCommands?: boolean`, passed through a small helper
    to `createBashTool` and into `RunCommandExecOptions`.
- `openNative` in `packages/nax-agent/src/session/native-backend.ts`
  - Target: destructures `allowUnsandboxedCommands` from `nativeProfileRules`, passes
    `unsandboxedCommands` to `buildSessionToolSupport`, and sets `info.sandbox` from
    `resolveSessionLauncher`'s result.

Pattern to mirror: the existing `allowUnsandboxed` option, declared on
`NativeBackendOptions`, validated in `OptionsSchema`, resolved in
`nativeProfileRules`, consumed in `resolveSessionLauncher`, and tested in
`test/unit/session/native-backend-options.test.ts` and
`test/unit/session/session-tool-support.test.ts`. For "option off is byte-identical",
mirror `test/unit/tools/bash-sandbox.test.ts` ("disabled launcher: raw description
is byte-identical to no launcher"). For session-level tests that drive a scripted
model and answer asks, mirror `test/unit/session/agent-session-asks.test.ts`
(helpers in `test/helpers/agent-session.ts` and `stubSessionSandboxDeps`).

### Failure Handling

| Situation | Behaviour |
|---|---|
| `allowUnsandboxed: true` with `bashApproval: "escalate"` | `nativeProfileRules` throws `AGENT_SESSION_INVALID_OPTIONS` (`allowUnsandboxed requires bashApproval "gated" or "raw"`). |
| `allowUnsandboxedCommands` set on profile `none` or `read` | `AGENT_SESSION_INVALID_OPTIONS`, message `allowUnsandboxedCommands applies to profiles "ask", "full" and "review" only`. |
| Profile `full`, `raw`, sandbox unavailable, `allowUnsandboxed` absent | `resolveSessionLauncher` rejects with `AGENT_SESSION_SANDBOX_UNAVAILABLE` (unchanged behaviour, new message text). |
| Profile `full`, `raw`, sandbox unavailable, `allowUnsandboxed: true` | Session opens with no launcher; `session.backend.sandbox` is the `unavailable` state; Bash direct-spawns. |
| Model sets `unsandboxed: true` with `allowUnsandboxedCommands` off | `callTool` returns `{ kind: "error", content: "unsandboxed commands are not enabled for this session (allowUnsandboxedCommands)" }` before any policy evaluation or ask; nothing spawned. |
| Model sets `unsandboxed: true` and the policy denies the command | Denied exactly as without the flag (same `reason`, same `breach`); nothing spawned. |
| Model sets `unsandboxed: true`, verdict allow, mode `gated` or `escalate` (Bash) or any ask-less grant (`Exec`) | Converted to an ask with rule `Unsandboxed(<identity>)`, `matchedRule` unset; the human decides. |
| Human answers deny on an unsandboxed ask | `denied:ask` as today; nothing spawned, sandboxed or not. |
| Human answers allow on an unsandboxed ask | The command runs through the launcher with `unwrapped: true`; `SandboxRecord.reason === "requested"`. |
| Model sets `unsandboxed: true` under `raw` | No ask; runs unwrapped. |
| `unsandboxed: true` in a session whose launcher was dropped by `allowUnsandboxed` | Same ask routing; on allow the tool direct-spawns (there is no launcher to unwrap). |
| `unwrapped: true` on a launcher whose state is `disabled` or `unavailable` | Runs unwrapped as every request on that launcher does; record `reason` is `"requested"`. |
| `unsandboxed: true` on RunCommand's declared-command (`command`) branch | The runtime does not route it (identity `RunCommand`); the tool returns `"unsandboxed" applies only to "argv" calls`, nothing run. |
| `unsandboxed` given a non-boolean value | Treated as not set by the runtime and the tools (`=== true`); with the option on, the transport schema check rejects it earlier. |
| `unsandboxedReason` is not a string, or masking finds an unshowable secret | Rendered as `no reason given` / `reason withheld`; the ask still proceeds. |

## Out of Scope

- RunCommand and Exec are not declared for any session profile in this feature; `declaredToolsFor` is unchanged, so an interactive session does not see RunCommand until a later feature declares it. The RunCommand `unsandboxed` argument is exercised at the tool and support level here.
- No tool-audit directory is plumbed into sessions; `buildSessionToolSupport` keeps the non-recording sink, so an unsandboxed run under `raw` leaves no durable session ledger row. Callers that pass `auditDir` to `buildCodingToolSupport` get the `reason: "requested"` record.
- No approvals-cache link is added to the session ask chain; a `gated` session asks the human for every Bash command, as today.
- No mutable profile or `bashApproval` on an open session; switching mode is the host's job (close and reopen on the same transcript).
- `mcpServers` on `createAgentSession` stays rejected as reserved.
- The ACP server (`packages/nax-agent-acp`) does not expose `allowUnsandboxedCommands`, `allowUnsandboxed` with `raw`, `BackendInfo.sandbox` or the `unsandboxed` approval field; its config and translate layers are unchanged.
- `packages/nax` is unchanged: no nax config key, no `nax run` wiring, no CLI flag for the new options, and the Telegram and other interaction channels do not render `unsandboxed`.
- `AskDecidedBy` gains no new value, and no approval event is emitted under `raw`.
- The guard-denial ask path (`commandShadow.guard` in `callTool`) does not carry the `unsandboxed` flag; sessions configure no command shadow, so it is inert here.
- `escalate` mode semantics are unchanged; `allowUnsandboxed` with `escalate` stays invalid.
- The `.nax` protected-path refusals, the Claude settings file refusals and the raw-mode lexical screen (`screenRawBashCommand`) are unchanged.
- `unsandboxed: true` does not bypass policy evaluation: deny rules, payload checks, containment, the lexer and grant evaluation run exactly as without the flag.
- Launcher-level relaxations that read the session's sandbox state (`rawScreenOptionsFor`, `isTempConfined`) are not re-decided per call; they are inert in sessions and unchanged for nax run callers.
- Remembered-approval keys in `packages/nax` do not include the `unsandboxed` flag; whether a remembered plain approval should cover an unsandboxed variant is a later decision.
- `SandboxState` is reported once at open; a sandbox that becomes unavailable mid-session is not re-probed.
- Sessions always use `DEFAULT_SANDBOX_CONFIG` (enabled), so the `disabled` sandbox state arises only for the `none` and `read` profiles; a config-disabled sandbox combined with `allowUnsandboxed` is not a session case.
- No per-command unsandboxed path for `Write`, `Edit`, `Delete`, `Git` or `GitCommit`; those tools do not run through the launcher.
- Session storage sharing with the ACP server (feature F2), the terminal UI (F3), the skills and plugin loader (F4) and MCP servers and subagents (F5) are separate features.
- No dependency bumps; `@anthropic-ai/sandbox-runtime` stays at its current version.

## Stories

All stories run in `Workdir: packages/nax-agent`. Paths below are repo-relative.
Eight stories, one capability: the per-command sandbox escape and the fallback it
needs; the split follows the package's layers so no story plans past the 24-AC gate.

### US-001 — Sandbox floor accepts `raw` + `allowUnsandboxed`, and sessions report their sandbox state

Workdir: packages/nax-agent. No dependencies.

- Relax `nativeProfileRules` so `allowUnsandboxed: true` is valid with `bashApproval: "raw"` (profiles `full`, `review`); keep it invalid with `"escalate"`; add `allowUnsandboxedCommands` to `NativeBackendOptions`, its schema and the rules result.
- Make `resolveSessionLauncher` return `{ launcher, sandbox }`, dropping the launcher for any unavailable sandbox when `allowUnsandboxed` is true.
- Add `sandbox?: SandboxState` to `BackendInfo`; `openNative` fills it; the `backend` getter in `agent-session.ts` copies it through.

### US-002 — The launcher runs one request unwrapped on demand

Workdir: packages/nax-agent. No dependencies.

- Add `unwrapped?: true` to `LaunchRequest`.
- In `createCommandLauncher().run`, route an `unwrapped` request to `runUnwrapped` even when the state is `available`, with `SandboxRecord { backend: "none", wrapped: false, reason: "requested" }`, no `policyFor` call and no `afterWrapped` call.
- Keep the session temp-directory overlay for unwrapped runs as it is today.

### US-003 — Bash tool `unsandboxed` argument and the option plumbing

Workdir: packages/nax-agent. Depends on US-001, US-002.

- Thread `unsandboxedCommands` from `nativeProfileRules` through `openNative`, `buildSessionToolSupport`, `buildCodingToolSupport` and `buildDeclaredCommandTools` to `createBashTool`, via small extracted helpers so the two baselined functions do not grow in complexity.
- Bash `scope` always declares `unsandboxedField: "unsandboxed"`; when the option is on, `inputSchema` gains `unsandboxed` and `unsandboxedReason` and the description gains one appended sentence; when off, schema and description are byte-identical to today.
- Bash `run` passes `unwrapped: true` on the launcher request when `input.unsandboxed === true`; with no launcher it direct-spawns.

### US-004 — Approval metadata: the `unsandboxed` flag and reason suffix reach the approval event

Workdir: packages/nax-agent. Depends on US-003.

- Add `unsandboxed?: true` to `AskRequest`, `ApprovalRequest`, `ApprovalAsk` and the `approval_requested` event body; `createSessionAskLink` and `askPerson` forward it.
- New `unsandboxedReasonSuffix(input)` in `ask-request.ts` (masked, capped, with the `no reason given` and `reason withheld` fallbacks).
- `resolveAskOutcome` gains the optional `unsandboxed?: { suffix }` argument that sets the flag and appends the suffix to `reason`, leaving `matchedRule` unset when the verdict's `rule` is the synthetic `Unsandboxed(<identity>)`.

### US-005 — Runtime routing, part 1: refuse when off, preserve denials, leave ordinary and RunCommand calls alone

Workdir: packages/nax-agent. Depends on US-004.

- `createCodingToolRuntime` gains `unsandboxed: { enabled, bashApproval }`, set by `buildCodingToolSupport` from `unsandboxedCommands` and the resolved `bashApproval`.
- New `resolveUnsandboxedCall` in `runtime-calltool.ts`, called once from `callTool` before `policy.check`, only for identities `Bash` and `Exec`: when not enabled it returns the `{ kind: "error", ... }` refusal (logged through `logCall`); a deny verdict is unchanged; a call without the flag is unchanged; a `RunCommand`-identity call is untouched.
- A human deny on an unsandboxed ask returns the `denied` outcome without running the tool.

### US-006 — Runtime routing, part 2: convert an allow into an ask in every mode but `raw`

Workdir: packages/nax-agent. Depends on US-005.

- With the option enabled and the flag set, an `ask` verdict proceeds with `unsandboxed: true` and the suffix; an allow verdict under `gated` or `escalate` (Bash) or an ask-less `Exec` grant becomes an ask with rule `Unsandboxed(<identity>)`; an allow under `raw` runs without asking.
- With no launcher (dropped by `allowUnsandboxed`) the routing is the same and the tool direct-spawns on allow.

### US-007 — Session-level behaviour of unsandboxed Bash calls

Workdir: packages/nax-agent. Depends on US-006.

- No new production code: this story proves the wiring end to end through `createAgentSession` with a scripted model, for `gated` (ask, allow, deny, sandbox stays on), `raw` (no ask), and option off (refusal).

### US-008 — RunCommand `argv` branch gets the same `unsandboxed` argument

Workdir: packages/nax-agent. Depends on US-006.

- `RunCommandExecOptions.unsandboxedCommands?: boolean`, forwarded by `buildDeclaredCommandTools` from the same `unsandboxedCommands` arg.
- With `exec` set: `scope.unsandboxedField` always; the two schema properties and the argv-worded sentence only when the option is on.
- `runExecBranch` passes `unwrapped: true` to `launchExec` and on to the launcher; the declared-command branch rejects the flag with the named error.

### Context Files

**US-001**
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/session-backend.ts`
- `packages/nax-agent/src/session/agent-session.ts`

**US-002**
- `packages/nax-agent/src/sandbox/launcher.ts`
- `packages/nax-agent/src/sandbox/types.ts`
- `packages/nax-agent/test/unit/sandbox/launcher.test.ts`

**US-003**
- `packages/nax-agent/src/tools/bash.ts`
- `packages/nax-agent/src/tools/types.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`

**US-004**
- `packages/nax-agent/src/tools/ask-request.ts`
- `packages/nax-agent/src/tools/runtime-calltool.ts`
- `packages/nax-agent/src/permissions/types.ts`
- `packages/nax-agent/src/session/session-ask-link.ts`
- `packages/nax-agent/src/session/session-backend.ts`

**US-005**
- `packages/nax-agent/src/tools/runtime.ts`
- `packages/nax-agent/src/tools/runtime-calltool.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts`
- `packages/nax-agent/test/unit/tools/runtime.test.ts`

**US-006**
- `packages/nax-agent/src/tools/runtime.ts`
- `packages/nax-agent/src/tools/runtime-calltool.ts`
- `packages/nax-agent/test/unit/tools/runtime-unsandboxed.test.ts` — created by US-005, extended here

**US-007**
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/test/unit/session/agent-session-asks.test.ts`
- `packages/nax-agent/test/helpers/agent-session.ts`
- `packages/nax-agent/test/helpers/session-sandbox-deps.ts`

**US-008**
- `packages/nax-agent/src/tools/run-command.ts`
- `packages/nax-agent/src/tools/run-command-exec.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`
- `packages/nax-agent/test/unit/tools/run-command-exec-sandbox.test.ts`

### Creates

**US-005**
- `packages/nax-agent/test/unit/tools/runtime-unsandboxed.test.ts` — the `callTool` routing tests, in their own file because `runtime.test.ts` is at 755 of the 800-line test limit.

### Modifies

**US-001**
- `packages/nax-agent/test/unit/session/native-backend-options.test.ts` — five `toEqual({ bashApproval, allowUnsandboxed })` assertions ("full defaults to gated", the `ask` default, "read and none accept neither knob", "full accepts…", the review test) pin the two-field result; the invariant is the three-field result with `allowUnsandboxedCommands: false` by default. The assertion that `raw` + `allowUnsandboxed: true` throws `allowUnsandboxed requires bashApproval "gated"` pins the old rule; the invariant is that it resolves and only `escalate` + `allowUnsandboxed` throws.
- `packages/nax-agent/test/unit/session/session-tool-support.test.ts` — `toBeUndefined()` on `resolveSessionLauncher`'s result and `launcher?.state.kind` reads pin the bare-launcher return; the invariant is the `{ launcher, sandbox }` result. Hosts the new `resolveSessionLauncher` ACs.
- `packages/nax-agent/test/unit/session/native-backend.test.ts` — line 79 `expect(opened.info).toEqual({ kind: "native", capabilities: {} })` pins the two-field info and fails once a `read` session reports `sandbox: { kind: "disabled" }`; the invariant is `kind` and `capabilities` unchanged plus the `sandbox` field. Hosts the US-001 session-level ACs.

**US-002**
- `packages/nax-agent/test/unit/sandbox/launcher.test.ts` — hosts the new `unwrapped` ACs; any assertion that an `available` launcher calls `backend.wrap` for every request becomes "for every request without `unwrapped`".

**US-003**
- `packages/nax-agent/test/unit/tools/bash-sandbox.test.ts` — hosts the "option off is byte-identical" and "option on adds two properties" ACs; the description snapshots and the `toEndWith` pins for the default case stay unchanged because the new sentence appears only with the option on.
- `packages/nax-agent/test/unit/tools/bash.test.ts` — the `scope.commandField` check at line 180 stays; hosts the `scope.unsandboxedField` AC and the launcher-request `unwrapped` ACs.
- `packages/nax-agent/test/unit/coding-tools/coding-tool-support.test.ts` — hosts the `buildCodingToolSupport` and `buildDeclaredCommandTools` forwarding ACs.
- `packages/nax-agent/test/unit/session/session-tool-support.test.ts` — the `args()` helper builds `SessionToolSupportArgs`; `unsandboxedCommands` is optional so the helper compiles unchanged; hosts the `buildSessionToolSupport` forwarding AC.
- `packages/nax-agent/test/unit/session/native-backend.test.ts` — hosts the US-003 session-level advertisement AC.

**US-004**
- `packages/nax-agent/test/unit/tools/ask-request.test.ts` — hosts the `unsandboxedReasonSuffix` ACs; existing imports (`askDenyReason`, `askSummary`, `MAX_ASK_SUMMARY_CHARS`) are unchanged.
- `packages/nax-agent/test/unit/session/session-ask-link.test.ts` — hosts the forwarding ACs; any deep-equal on the emitted `approval_requested` body must allow `unsandboxed`.

**US-005**
- `packages/nax-agent/test/unit/tools/runtime.test.ts` — no existing assertion changes; the file stays under 800 lines because the new routing tests go into the created file. US-006 later extends that created file; it needs no Modifies entry because no existing assertion in it is pinned.

**US-007**
- `packages/nax-agent/test/unit/session/native-backend.test.ts` — hosts the end-to-end session ACs for US-007, using the scripted-model helpers and the session sandbox stub the way the existing asks test file does (see the US-007 Context Files).

**US-008**
- `packages/nax-agent/test/unit/tools/run-command-exec-sandbox.test.ts` — hosts the argv `unwrapped` ACs and the RunCommand schema and scope ACs; the existing `["bun","--version"]` fixture at line 45 is reused.
- `packages/nax-agent/test/unit/coding-tools/coding-tool-support.test.ts` — hosts the `buildDeclaredCommandTools` RunCommand forwarding AC.

### Seams

- US-001 -> US-003: `nativeProfileRules` returns `allowUnsandboxedCommands`; US-003 asserts a session created with `allowUnsandboxedCommands: true` advertises a Bash tool whose `inputSchema.properties` has `unsandboxed`.
- US-002 -> US-003: `LaunchRequest.unwrapped`; US-003 asserts the Bash launcher request carries `unwrapped: true`.
- US-003 -> US-005: `ToolScope.unsandboxedField`; US-005 asserts `callTool` reads it to refuse when the option is off.
- US-004 -> US-006: `resolveAskOutcome`'s `unsandboxed` argument and `unsandboxedReasonSuffix`; US-006 asserts the converted ask's `AskRequest` carries `unsandboxed: true` and the suffixed reason.
- US-006 -> US-007: US-007 asserts a `createAgentSession` whose model requests an unsandboxed Bash call under `gated` yields an `approval_requested` with `unsandboxed: true`, and on allow the stubbed `runArgv` runs the logical argv without `backend.wrap`.
- US-002 -> US-008 and US-006 -> US-008: US-008 asserts `runExecBranch` forwards `unwrapped: true`; the `Exec` allow-to-ask conversion its argv calls rely on is pinned in US-006.

## Acceptance Criteria

### US-001 — Sandbox floor and sandbox state

- [unit] `nativeProfileRules("full", { model, bashApproval: "raw", allowUnsandboxed: true })` returns `{ bashApproval: "raw", allowUnsandboxed: true, allowUnsandboxedCommands: false }`.
- [unit] `nativeProfileRules("review", { model, bashApproval: "raw", allowUnsandboxed: true })` returns `allowUnsandboxed: true`.
- [unit] `nativeProfileRules("full", { model, bashApproval: "escalate", allowUnsandboxed: true })` throws an `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS` whose message contains `allowUnsandboxed requires bashApproval "gated" or "raw"`.
- [unit] `nativeProfileRules("ask", { model, bashApproval: "raw", allowUnsandboxed: true })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `profile "ask" requires bashApproval "gated"`.
- [unit] `nativeProfileRules("full", { model, allowUnsandboxedCommands: true })` returns `allowUnsandboxedCommands: true`.
- [unit] `nativeProfileRules("read", { model, allowUnsandboxedCommands: true })` throws `AGENT_SESSION_INVALID_OPTIONS` whose message contains `allowUnsandboxedCommands applies to profiles "ask", "full" and "review" only`.
- [unit] `parseNativeBackendOptions({ model: "p/m", allowUnsandboxedCommands: "yes" })` throws `AGENT_SESSION_INVALID_OPTIONS` with `path` context `backend.allowUnsandboxedCommands`.
- [unit] With `_sessionSandboxDeps` stubbed so the probe reports unavailable with reason `"srt missing"`, `resolveSessionLauncher({ profile: "full", bashApproval: "raw", allowUnsandboxed: true, root, protectedPaths })` resolves to `launcher: undefined` and `sandbox: { kind: "unavailable", backend: "srt", reason: "srt missing" }`.
- [unit] Under the same unavailable stub, `resolveSessionLauncher({ profile: "full", bashApproval: "raw", allowUnsandboxed: false, root, protectedPaths })` rejects with an `AgentSessionError` of code `AGENT_SESSION_SANDBOX_UNAVAILABLE` whose message ends with `Pass allowUnsandboxed: true to run without one.`
- [unit] With the probe stubbed available, `resolveSessionLauncher({ profile: "full", bashApproval: "raw", allowUnsandboxed: true, root, protectedPaths })` resolves to a defined `launcher` and a `sandbox` whose `kind` is `"available"`.
- [unit] `resolveSessionLauncher({ profile: "read", bashApproval: "gated", allowUnsandboxed: false, root, protectedPaths })` resolves to `launcher: undefined` and `sandbox: { kind: "disabled" }` without calling the probe.
- [integration] A session created through `createAgentSession` with `nativeBackend({ model, bashApproval: "raw", allowUnsandboxed: true })`, `profile: "full"` and the probe stubbed unavailable with reason `"srt missing"` opens, and `session.backend.sandbox` deep-equals `{ kind: "unavailable", backend: "srt", reason: "srt missing" }`.
- [integration] A session created with `profile: "read"` has `session.backend.sandbox` deep-equal to `{ kind: "disabled" }`, `session.backend.kind` equal to `"native"` and `session.backend.capabilities` deep-equal to `{}`.

### US-002 — Launcher honours `unwrapped`

- [unit] `createCommandLauncher({ state: available, backend })` given `run({ spec: { kind: "shell", shell, command }, ..., unwrapped: true })` calls `_launcherDeps.runArgv` with argv `[shell, "-c", command]`.
- [unit] That run never calls `backend.wrap`.
- [unit] That result's `sandbox` deep-equals `{ backend: "none", wrapped: false, reason: "requested" }` and `executed` equals `[shell, "-c", command]`.
- [unit] With `afterWrapped` and `policyFor` supplied, an `unwrapped: true` run invokes neither.
- [unit] With `afterWrapped` and `policyFor` supplied, the same request without `unwrapped` invokes both.
- [unit] With `tmpDir` supplied, an `unwrapped: true` run passes an `env` to `runArgv` whose `TMPDIR`, `TMP` and `TEMP` all equal that directory.
- [unit] On a launcher whose state is `unavailable`, `run({ ..., unwrapped: true })` returns a `sandbox` with `wrapped: false` and `reason: "requested"`.
- [unit] On a launcher whose state is `disabled`, `run({ ..., unwrapped: true })` returns a `sandbox` with `wrapped: false` and `reason: "requested"`.
- [unit] On an `available` launcher, a request without `unwrapped` calls `backend.wrap` and returns `wrapped: true`.

### US-003 — Bash tool `unsandboxed` argument and plumbing

- [unit] `createBashTool(opts)` with `unsandboxedCommands` absent produces an `inputSchema` whose property keys are exactly `command`, `timeoutMs`, `description`, and a `description` string equal to the one produced with `unsandboxedCommands: false`.
- [unit] `createBashTool(opts).scope` has `unsandboxedField` equal to `"unsandboxed"` whether or not `unsandboxedCommands` is set, and `commandField` still equal to `"command"`.
- [unit] `createBashTool({ ...opts, unsandboxedCommands: true }).inputSchema.properties.unsandboxed.type` equals `"boolean"` and `.unsandboxedReason.type` equals `"string"`, and `required` deep-equals `["command"]`.
- [unit] `createBashTool({ ...opts, unsandboxedCommands: true }).description` ends with `Set "unsandboxed": true with an "unsandboxedReason" only when the command needs the network, a local socket or a device the sandbox blocks.`
- [unit] `createBashTool({ launcher, unsandboxedCommands: true }).run({ command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" }, ctx)` calls `launcher.run` with a request whose `unwrapped` is `true` and whose `spec` deep-equals `{ kind: "shell", shell, command: "curl x" }`.
- [unit] `createBashTool({ launcher, unsandboxedCommands: true }).run({ command: "ls" }, ctx)` calls `launcher.run` with a request that has no `unwrapped` key.
- [unit] `createBashTool({ launcher, unsandboxedCommands: true }).run({ command: "ls", unsandboxed: "true" }, ctx)` (a string) calls `launcher.run` with a request that has no `unwrapped` key.
- [unit] `createBashTool({ unsandboxedCommands: true }).run({ command: "ls", unsandboxed: true }, ctx)` with no launcher calls `_bashToolDeps.runArgv` with argv `[shell, "-c", "ls"]` and returns a result whose `isError` is not `true`.
- [unit] `buildCodingToolSupport({ ...args, declared: [..., "Bash"], unsandboxedCommands: true })` yields a Bash tool whose `inputSchema.properties` has `unsandboxed`; with `unsandboxedCommands` absent the Bash tool's `inputSchema.properties` has no `unsandboxed` key.
- [unit] `buildDeclaredCommandTools({ ...args, unsandboxedCommands: true })` yields a Bash tool whose `inputSchema.properties` has `unsandboxed`.
- [unit] `buildSessionToolSupport({ ...args, unsandboxedCommands: true })` returns a `support.tools` entry named `Bash` whose `inputSchema.properties` has `unsandboxed`; `buildSessionToolSupport(args)` without the field returns one that does not.
- [integration] A session created with `nativeBackend({ model, bashApproval: "gated", allowUnsandboxedCommands: true })` and `profile: "full"` advertises a `Bash` tool whose `inputSchema.properties` has `unsandboxed`; the same session without `allowUnsandboxedCommands` advertises one that does not.

### US-004 — Approval metadata

- [unit] `unsandboxedReasonSuffix({ unsandboxedReason: "needs network" })` returns ` -- runs OUTSIDE the sandbox: needs network`.
- [unit] `unsandboxedReasonSuffix({ unsandboxedReason: 42 })` and `unsandboxedReasonSuffix({})` both return ` -- runs OUTSIDE the sandbox: no reason given`.
- [unit] `unsandboxedReasonSuffix({ unsandboxedReason: <a 300-character string> })` returns a suffix whose rendered reason is exactly 200 characters long.
- [unit] `unsandboxedReasonSuffix({ unsandboxedReason: <a string maskForPrompt reports unshowable> })` returns ` -- runs OUTSIDE the sandbox: reason withheld`.
- [unit] `resolveAskOutcome({ ...args, verdict: <an ask verdict with rule "Bash(*)">, unsandboxed: { suffix: " -- S" } })` hands `askResolver.resolve` an `AskRequest` with `unsandboxed: true`, `matchedRule` equal to `"Bash(*)"` and `reason` equal to the verdict reason followed by ` -- S`.
- [unit] `resolveAskOutcome({ ...args, verdict: <a verdict with rule "Unsandboxed(Bash)" and reason "unsandboxed run requested">, unsandboxed: { suffix: " -- S" } })` hands `askResolver.resolve` an `AskRequest` with `rule` `"Unsandboxed(Bash)"`, no `matchedRule` key, and `reason` equal to `unsandboxed run requested -- S`.
- [unit] `resolveAskOutcome({ ...args, verdict: <an ask verdict> })` without `unsandboxed` hands `askResolver.resolve` an `AskRequest` with no `unsandboxed` key and `reason` equal to the verdict reason.
- [unit] `createSessionAskLink(deps).resolve(req)` for an `AskRequest` with `unsandboxed: true` calls `deps.port.requestApproval` with `unsandboxed: true`; for a request without it the forwarded object has no `unsandboxed` key.
- [unit] `askPerson(deps, { tool: "Bash", summary, reason, unsandboxed: true }, signal)` emits an `approval_requested` event with `unsandboxed: true`; without the field the emitted event has no `unsandboxed` key.

### US-005 — Runtime routing, part 1

- [unit] `createCodingToolRuntime({ policy, ... })` without `unsandboxed`, given `callTool("Bash", { command: "ls", unsandboxed: true })` under an allow grant, returns `{ kind: "error", content: "unsandboxed commands are not enabled for this session (allowUnsandboxedCommands)" }` and the tool's `run` is not invoked.
- [unit] In that refused call, `askResolver.resolve` is not invoked even when a `Bash(*)` ask rule is configured.
- [unit] In that refused call, the audit sink receives a record with `outcome: "error"` for the Bash call.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }`, `callTool("Bash", { command: "cat /etc/passwd", unsandboxed: true })` whose verdict is a deny returns an outcome with `kind: "denied"` whose `reason` and `breach` equal those returned for `callTool("Bash", { command: "cat /etc/passwd" })`, and `askResolver.resolve` is not invoked.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }` and a `Bash(*)` ask rule, `callTool("Bash", { command: "curl x" })` hands `askResolver.resolve` an `AskRequest` with no `unsandboxed` key and a `reason` equal to the verdict reason.
- [unit] When `askResolver.resolve` answers deny on an unsandboxed ask, `callTool` returns an outcome with `kind: "denied"` and the tool's `run` is not invoked.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }`, a `callTool` whose policy identity resolves to `RunCommand` (a declared-command call `{ command: "test", unsandboxed: true }`) does not invoke `askResolver.resolve` and invokes the registered tool's `run` with the original input.
- [unit] `buildCodingToolSupport({ ...args, bashApproval: "gated", unsandboxedCommands: true })` constructs its runtime with `unsandboxed: { enabled: true, bashApproval: "gated" }`; with `unsandboxedCommands` absent the runtime's option is absent or `enabled: false`.

### US-006 — Runtime routing, part 2

- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }` and a `Bash(*)` ask rule, `callTool("Bash", { command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" })` hands `askResolver.resolve` an `AskRequest` with `unsandboxed: true`, `matchedRule` equal to the matched ask rule, and `reason` ending in ` -- runs OUTSIDE the sandbox: needs network`.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "escalate" }` and no ask rule, `callTool("Bash", { command: "curl x", unsandboxed: true })` whose verdict is allow hands `askResolver.resolve` an `AskRequest` with `unsandboxed: true`, `rule` equal to `"Unsandboxed(Bash)"`, no `matchedRule` key, and `reason` equal to `unsandboxed run requested -- runs OUTSIDE the sandbox: no reason given`.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }`, a tool registered with `scope.argvField: "argv"` and `scope.unsandboxedField: "unsandboxed"` under an `Exec` allow grant with no ask rule, `callTool` on `{ argv: ["bun", "--version"], unsandboxed: true, unsandboxedReason: "registry" }` hands `askResolver.resolve` an `AskRequest` with `unsandboxed: true`, `rule` equal to `"Unsandboxed(Exec)"` and `reason` ending in ` -- runs OUTSIDE the sandbox: registry`.
- [unit] With `unsandboxed: { enabled: true, bashApproval: "raw" }`, `callTool("Bash", { command: "curl x", unsandboxed: true })` whose verdict is allow invokes the tool's `run` and never invokes `askResolver.resolve`.
- [unit] When `askResolver.resolve` answers allow on a converted unsandboxed ask, `callTool` invokes the tool's `run` with the original input (including `unsandboxed: true`).
- [unit] With `unsandboxed: { enabled: true, bashApproval: "gated" }` and a Bash tool built with no launcher, an allowed unsandboxed call runs through `_bashToolDeps.runArgv` with argv `[shell, "-c", "curl x"]`.

### US-007 — Session-level behaviour

- [integration] A session created with `nativeBackend({ model, bashApproval: "gated", allowUnsandboxedCommands: true })`, `profile: "full"`, probe available, whose scripted model emits a Bash call `{ command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" }`, yields an `approval_requested` event with `tool: "Bash"`, `unsandboxed: true` and a `reason` containing `runs OUTSIDE the sandbox: needs network`.
- [integration] After `session.answer(requestId, { decision: "allow" })` on that event, the stubbed `_launcherDeps.runArgv` is called with argv `[shell, "-c", "curl x"]` and `backend.wrap` is not called.
- [integration] After `session.answer(requestId, { decision: "deny" })` on such an event, neither `_launcherDeps.runArgv` nor `backend.wrap` is called and the scripted model receives a tool error result.
- [integration] A later Bash call `{ command: "ls" }` in the same session, after its own approval is answered allow, calls `backend.wrap`.
- [integration] A session created with `nativeBackend({ model, bashApproval: "raw", allowUnsandboxedCommands: true })`, `profile: "full"`, probe available, whose scripted model emits `{ command: "curl x", unsandboxed: true }`, emits no `approval_requested` event, and the stubbed `_launcherDeps.runArgv` is called with argv `[shell, "-c", "curl x"]` while `backend.wrap` is not called.
- [integration] A session created with `nativeBackend({ model, bashApproval: "gated" })`, `profile: "full"`, whose scripted model emits `{ command: "curl x", unsandboxed: true }`, emits no `approval_requested` event, the model receives a tool error result whose text names `allowUnsandboxedCommands`, and `_launcherDeps.runArgv` is not called.

### US-008 — RunCommand `argv` `unsandboxed`

- [unit] `createRunCommandTool(declared, { exec })` with `unsandboxedCommands` absent produces an `inputSchema` whose property keys are exactly `command`, `values`, `argv`, `target`, and a `description` equal to the one produced with `unsandboxedCommands: false`.
- [unit] `createRunCommandTool(declared, { exec }).scope.unsandboxedField` equals `"unsandboxed"`, and `createRunCommandTool(declared, {}).scope` has no `unsandboxedField` key.
- [unit] `createRunCommandTool(declared, { exec: { ...exec, unsandboxedCommands: true } }).inputSchema.properties.unsandboxed.type` equals `"boolean"` and `.unsandboxedReason.type` equals `"string"`.
- [unit] `createRunCommandTool(declared, { exec: { ...exec, unsandboxedCommands: true } }).description` ends with `only when the argv needs the network, a local socket or a device the sandbox blocks.`
- [unit] `runExecBranch({ argv: ["bun", "--version"], unsandboxed: true, unsandboxedReason: "registry" }, ctx, { exec: { ...exec, launcher, unsandboxedCommands: true } })` calls `launcher.run` with `unwrapped: true` and `spec` deep-equal to `{ kind: "argv", argv: ["bun", "--version"] }`.
- [unit] `runExecBranch({ argv: ["bun", "--version"] }, ctx, { exec: { ...exec, launcher, unsandboxedCommands: true } })` calls `launcher.run` with a request that has no `unwrapped` key.
- [unit] `createRunCommandTool(declared, { exec: { ...exec, unsandboxedCommands: true } }).run({ command: "test", unsandboxed: true }, ctx)` returns `{ content: '"unsandboxed" applies only to "argv" calls', isError: true }` and the declared-command runner is not invoked.
- [unit] `buildDeclaredCommandTools({ ...args, allowExec: true, execGrant, unsandboxedCommands: true })` produces a RunCommand tool whose `inputSchema.properties` has `unsandboxed`; with `unsandboxedCommands` absent it does not.
