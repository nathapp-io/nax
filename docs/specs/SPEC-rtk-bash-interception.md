# SPEC: rtk rewrite for the native Bash tool, and `AGENT=1` for agent-issued commands

## Summary

Two changes to how the native coding agent's commands run. First, an opt-in second
interception site: when `execution.commandInterceptor.bash.enabled` is on, the native `Bash`
tool asks `rtk rewrite` for a token-saving form of the model's command and runs that form,
but only after nax has validated that the rewrite does nothing except insert `rtk ` in front
of the command word of one or more segments. The permission policy and the command-safety
guard still judge the model's ORIGINAL command, because the rewrite happens inside the tool,
after `callTool` has allowed the call. Second, the `Bash` tool and `RunCommand` (Exec branch)
now opt their child processes into agent-friendly test output with `AGENT=1`, under the same
rule the quality and verification runners already apply.

## Motivation

Claude Code and OpenCode users already get rtk's output compaction on every shell command
through a pre-tool hook (`~/.claude/hooks/rtk-rewrite.sh`, `~/.config/opencode/plugins/rtk.ts`),
both of which delegate to `rtk rewrite`. nax's native agent gets it only on the `Git` tool's
`log`/`diff` (spec R10, `src/tools/git.ts:380`). A native agent that runs `bun test`,
`grep -rn`, `find` or `git status` through `Bash` pays full output size for every call.

R10 dropped the two shell-string sites (quality, verification) because they carry
**user-authored** config strings: a user who wants rtk can write it into the line they own,
and dropping the shell sites deleted R9 so no provider stdout ever reaches `/bin/sh -c`. The
`Bash` tool's command is **model-authored** — no human owns that line — so the "write it
yourself" argument does not apply. This spec reopens a shell site for `Bash` only, and
replaces R9's deleted trust boundary with a narrow validator: rtk decides *which* segments
to wrap, nax decides that the executed string is the original plus `rtk ` insertions and
nothing else.

Separately, the model's own `bun test` today prints a pass line for every test. The
verification executor already fixed that for nax's own test runs by adding `AGENT=1`
(`src/verification/executor.ts:40-84`: a single-file run was 12x larger without it, a
directory 241x). The agent-facing spawn sites never received the same treatment.

Probe results that shaped the design (rtk 0.49.0, macOS, 2026-09-29):

| Command | `rtk rewrite` exit | stdout | Validator verdict |
|:---|:---|:---|:---|
| `bun test test/unit/foo.test.ts` | 3 | `rtk bun test test/unit/foo.test.ts` | accept |
| `FOO=1 bun test` | 3 | `FOO=1 rtk bun test` | accept |
| `bun test; git status` | 3 | `rtk bun test; rtk git status` | accept |
| `find . -name "*.ts"  -type f` | 3 | `rtk find . -name "*.ts"  -type f` | accept |
| `cat src/a.ts` | 3 | `rtk read src/a.ts` | decline (not an insertion) |
| `npx tsc --noEmit` | 3 | `rtk tsc --noEmit` | decline (not an insertion) |
| `cd pkg&&bun test` | 3 | `cd pkg && rtk bun test` | decline (whitespace changed) |
| `uv run pytest -q` | 3 | `uv run rtk pytest -q` | decline (not at the command word) |
| `git log --oneline \| head -5` | 3 | `rtk git log --oneline \| head -5` | decline (segment feeds a pipe) |
| `bun test \| head`, `rm -rf x`, `echo hi` | 1 | empty | unchanged |

Exit 3 is rtk's "ask" code: it reads Claude Code's permission rules. nax has already made its
own permission decision by the time the tool runs, so exit 0 and exit 3 are both "here is a
rewrite". `rtk rewrite` takes about 20 ms.

Sandbox probe: `createCommandLauncher` with the real `createSrtBackend` (state `available`),
request `env: { AGENT: "1", PROBE_X: "overlay" }`, command
`echo AGENT=${AGENT:-unset} PROBE=${PROBE_X:-unset}` — the wrapped child printed
`AGENT=1 PROBE=overlay`, so a launch-request `env` overlay DOES reach a wrapped command on
macOS. This contradicts two comments in the repo — `src/sandbox/launcher.ts:116` ("srt replaces
the child environment, so the TMPDIR override cannot ride an `env` overlay") and the header of
`test/unit/sandbox/launcher-session-tmp.test.ts` ("an argv-only `env` overlay would be lost").
The observed behaviour is consistent with srt setting `TMPDIR` itself (overriding that one
key) while passing the rest of the environment through. Because the unit ACs only see what
the launcher receives, US-004 adds one real-sandbox criterion so a srt version that does drop
the overlay fails a test instead of silently losing `AGENT=1`. `rtk git log -1` and
`rtk bun test` also ran correctly inside the wrapper.

## Design

### Integration

Mutated symbols are listed as **Baseline / Target** pairs. The baseline exists only to
locate the code; it is never the interface to implement.

- `Site` — `src/execution/command-interceptor/index.ts:11`. Baseline: `"git"`. Target: `"git" | "bash"`. Its doc comment ("One member deliberately") and the file header ("Argv-only by construction: R10 drops both shell-string sites") are rewritten to say the Bash site is the one validated shell site and why.
- `CommandInterceptor` — `src/execution/command-interceptor/index.ts:25`. Baseline: `{ provider; intercept(req: InterceptRequest); postProcess?(output, req: InterceptRequest) }`. Target: the same members, plus optional `interceptShell?(req: ShellInterceptRequest): Promise<ShellInterceptResult>`, and `postProcess`'s `req` parameter widened to `InterceptRequest | ShellInterceptRequest`.
- `createRtkInterceptor(opts)` — `src/execution/interceptors/rtk/index.ts:71`. Baseline: `RtkInterceptorOptions = { enabled; verbs; _deps? }`. Target: `RtkInterceptorOptions` gains OPTIONAL `bash?: boolean` (absent reads as `false`, so existing callers in `git-interception.test.ts` and `run-setup-command-interceptor.test.ts` compile unchanged); `RtkDeps` gains `rewrite(command: string, cwd: string): Promise<RtkRewriteResult>` where `RtkRewriteResult = { exitCode: number; stdout: string; timedOut: boolean }`; the returned interceptor implements `interceptShell`.
- `InterceptorState` — `src/execution/interceptors/rtk/index.ts:4`. Baseline: `{ enabled; version; verbs }`. Target: `{ enabled; version; verbs; bash }`, with `bash` always present (`false` when the option was absent). `defaultRecord` (`:43`) logs `bash` alongside the other three fields, so a run log distinguishes an arm with the Bash site on.
- `CommandInterceptorConfigSchema` — `src/config/schemas-execution.ts:221`. Baseline: `{ provider; enabled; git: { verbs } }`, `.strict()`. Target: adds `bash: { enabled: boolean }` defaulting to `{ enabled: false }`, still `.strict()`, with a refinement that rejects `bash.enabled: true` while `enabled` is `false` with the message `execution.commandInterceptor.bash.enabled requires execution.commandInterceptor.enabled`.
- `ExecutionConfigSchema.commandInterceptor` default literal — `src/config/schemas-execution.ts:320`. Target: the literal also carries `bash: { enabled: false }`.
- `CommandInterceptorConfig` — `src/config/runtime-types-execution.ts:70`. Target: adds `bash: { enabled: boolean }`.
- `FIELD_DESCRIPTIONS` — `src/cli/config-descriptions.ts:110-116`. Target: adds an `execution.commandInterceptor.bash.enabled` entry beside the existing `commandInterceptor` entries.
- `setupRun` — `src/execution/lifecycle/run-setup.ts:207`. Baseline: assigns `_gitToolDeps.interceptor = createRtkInterceptor({ enabled, verbs })`. Target: builds ONE interceptor with `{ enabled, verbs, bash: ci.bash.enabled }` and assigns it to both `_gitToolDeps.interceptor` and `_bashToolDeps.interceptor`.
- `_bashToolDeps` — `src/tools/bash.ts:76`. Baseline: `{ runArgv }`. Target: `{ runArgv, interceptor: undefined as CommandInterceptor | undefined }`.
- `createBashTool(opts).run(input, ctx)` — `src/tools/bash.ts:238`. Target: after validating `command` and before launching, calls `interceptShell(command, ctx.root, _bashToolDeps.interceptor)` and launches the returned `command`; passes the `AGENT=1` overlay as `env` on both the launcher and the `runArgv` path; when the command was rewritten, runs `_bashToolDeps.interceptor.postProcess(stdout, { kind: "shell", command: <the model's ORIGINAL command>, cwd: ctx.root, site: "bash" })` over stdout — the same request shape `interceptShell` sent, mirroring the Git site (`git.ts:412`), which passes the original argv. `run` is already about 75 lines, so the interception, overlay and post-processing live in one helper in `src/tools/bash.ts` that `run` calls, keeping `run` within its complexity budget.
- `runExecBranch` — `src/tools/run-command-exec.ts:45`. Target: merges the `AGENT=1` overlay into the `env` it passes on both the launcher and the `runArgv` path; a key the Exec normaliser sets (`YARN_ENABLE_SCRIPTS`) is kept.
- `withAgentOutputEnv` and `AGENT_OUTPUT_MARKERS` — `src/verification/executor.ts:40,77`. Target: moved to the new `src/utils/agent-output-env.ts`; `src/verification/executor.ts` re-exports both so `src/quality/runner.ts:16` keeps importing them unchanged.
- The comment at `src/sandbox/launcher.ts:116`. Target: says srt overrides `TMPDIR` itself (so that key rides a command prefix) while other `env` overlay keys reach the wrapped child, citing the US-004 real-sandbox test.

Read-only symbols (verified, unchanged):

- `interceptArgv(argv, cwd, interceptor)` — `src/execution/command-interceptor/index.ts:72`, and `validateRewrite` (`:51`). The fail-open shape to mirror: rewrite-time failure runs the original, a rewritten command that ran and failed keeps its exit code.
- `lexBashCommand(command): BashLexResult` — `src/permissions/bash-lex.ts:104`, exported from `@/permissions`. `{ kind: "ok", segments }` where each `BashSegment` carries `tokens: BashToken[]` (`{ text, opaque }`), `redirects` and an optional `separator` (`";" | "&&" | "||" | "|" | "&"`); or `{ kind: "refused", construct, prefix }`.
- `LaunchRequest.env` — `src/sandbox/types.ts:87`. The caller's overlay; `runUnwrapped` and `runWrapped` both forward it to `runArgv` (`src/sandbox/launcher.ts:103,140`).
- `runArgv({ ..., env })` — `src/utils/argv-exec.ts:149`; `buildEnv` overlays `env` on `process.env` after stripping `stripEnvVars` (`:87-96`).
- `createCodingToolRuntime(opts).callTool(name, input)` — `src/tools/runtime.ts:122,310`. Runs `policy.check` (and, once the command-safety guard lands, the guard) BEFORE `runTool`, so any work inside `Bash.run` happens after the permission decision. `test/unit/tools/runtime-sandbox-audit.test.ts:97-108` drives `Bash` through it with `compileToolPolicy` and `_bashToolDeps`.
- `createRtkInterceptor`'s `postProcess` and `RTK_HINT_LINE` — `src/execution/interceptors/rtk/index.ts:110,64`. Reused unchanged for `Bash` output.

### New module: `src/execution/command-interceptor/shell.ts`

Exported from the `@/execution/command-interceptor` barrel. Because the barrel re-exports
`shell.ts`, `shell.ts` imports `CommandInterceptor` with `import type` only (keeps
`check:import-cycles` at its current baseline) and value-imports `lexBashCommand` from
`@/permissions`.

```typescript
export interface ShellInterceptRequest {
  readonly kind: "shell";
  readonly command: string;
  readonly cwd: string;
  readonly site: "bash";
}

export type ShellInterceptResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly command: string; readonly provider: string }
  | { readonly kind: "declined"; readonly reason: string };

export interface ShellInterceptOutcome {
  /** What to execute: the original, or the validated rewrite. */
  readonly command: string;
  readonly provider?: string;
  readonly rewritten: boolean;
}

/** Accepts a rewrite only if it is the original plus `rtk ` insertions at command words. */
export function validateShellRewrite(req: ShellInterceptRequest, result: ShellInterceptResult): ShellInterceptResult;

/** The seam, one line at the call site. Fails open at rewrite time only (R3). */
export async function interceptShell(
  command: string,
  cwd: string,
  interceptor: CommandInterceptor | undefined,
): Promise<ShellInterceptOutcome>;
```

### Approach — the shell rewrite validator

A candidate `C` for original `O` is accepted only when ALL of these hold; otherwise
`validateShellRewrite` returns `{ kind: "declined", reason }` naming the first failed rule:

1. **Byte-exact insertion.** Walking `O` and `C` together, every difference is `C` holding the
   four characters `rtk ` where `O` continues with its next character. Removing those
   insertions from `C` yields exactly `O`. Quoting, spacing and operators are therefore
   untouched — a candidate that re-spaces `&&` or re-quotes an argument is declined.
2. **At least one insertion.** `C === O` is `unchanged`, not `rewritten`.
3. **Both lex.** `lexBashCommand(O)` and `lexBashCommand(C)` both return `kind: "ok"` with the
   same number of segments. Given rule 1, this fires in practice when the ORIGINAL does not
   lex — a command substitution, `2>&1`, a subshell — which the gated policy already refuses
   but the `raw` approval mode can let through; such a command is never rewritten.
4. **Each insertion is at a command word.** For every segment, the candidate's tokens either
   equal the original's, or equal the original's with one token `{ text: "rtk", opaque: false }`
   inserted at index `k`, where `k` is the count of leading `NAME=value` assignment tokens
   (`/^[A-Za-z_][A-Za-z0-9_]*=/`). The number of segments with an insertion equals the number
   of insertions found by rule 1.
5. **Not already rtk.** A segment whose original token at `k` is already `rtk` gets no insertion.
6. **Never inside a pipeline.** A segment whose own `separator` is `|` gets no insertion (its
   stdout feeds another program, not the model), and neither does a segment whose PREVIOUS
   segment's `separator` is `|` (it reads another program's output on stdin). In both cases
   compaction would change what a program reads.

Rules 1 and 4 together are the argv seam's "exactly one leading token" rule
(`validateRewrite`, `index.ts:52`) applied per shell segment.

### Approach — the rtk provider's shell method

`interceptShell(req)` on the interceptor returned by `createRtkInterceptor`:

- mode `disabled` (`enabled: false`), or `bash: false` → `{ kind: "unchanged" }`;
- mode `declined` (binary missing / probe threw) → `{ kind: "declined", reason }` — the same reason the Git site reports (`rtk binary not found on PATH`, or `rtk probe failed: <message>`);
- otherwise calls `deps.rewrite(req.command, req.cwd)`. The default implementation spawns
  `["rtk", "rewrite", command]` with `Bun.spawn` in `cwd`; if it has not exited after
  `RTK_REWRITE_TIMEOUT_MS` (`2000`, exported) it kills the child and resolves
  `{ exitCode: -1, stdout: "", timedOut: true }` (a `setTimeout` cancelled by `clearTimeout`
  on exit — the documented exception in `forbidden-patterns-source.md`). The answer, in order:
  1. `timedOut: true` → `{ kind: "declined", reason: "rtk rewrite timed out" }`;
  2. exit `0` or `3` with a trimmed, non-empty stdout that differs from `command` →
     `{ kind: "rewritten", command: <trimmed stdout>, provider: "rtk" }`;
  3. exit `0` or `3` with an empty or identical stdout, or exit `1` → `{ kind: "unchanged" }`;
  4. any other exit code, including `2` (a Claude deny rule) →
     `{ kind: "declined", reason: "rtk rewrite exited <code>" }`.
  If `deps.rewrite` rejects (e.g. the spawn itself fails), the answer is
  `{ kind: "declined", reason: "rtk rewrite failed: <message>" }`.

The rewrite runs in the nax process on the host, never inside the sandbox.

### Approach — `AGENT=1` for agent-issued commands

New `src/utils/agent-output-env.ts` holds `AGENT_OUTPUT_MARKERS`, `withAgentOutputEnv`
(both moved verbatim from `src/verification/executor.ts`), and:

```typescript
/** Where marker presence is read from; tests replace it. */
export const _agentOutputEnvDeps = { processEnv: (): Record<string, string | undefined> => process.env };

/** `{ AGENT: "1" }`, or undefined when a marker is already inherited or AGENT is stripped. */
export function agentOutputOverlay(strippedVars: readonly string[]): Readonly<Record<string, string>> | undefined;
```

`Bash` passes `agentOutputOverlay(opts.stripEnvVars ?? [])` as `env`. `runExecBranch` passes
`{ ...(normalized.env ?? {}), ...(overlay ?? {}) }` when either is defined, and no `env` at
all when both are undefined. The rule is the one quality and verification already follow:
an inherited `CLAUDECODE`/`REPL_ID`/`AGENT` speaks for itself, and stripping `AGENT` keeps
it stripped.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `bash.enabled: false` (default) or master `enabled: false` | `interceptShell` returns `unchanged`; the original command runs; `rtk rewrite` is never spawned. |
| `rtk` not on PATH at run setup | `declined` with `rtk binary not found on PATH`; the original runs. |
| The rtk probe throws at run setup | `declined` with `rtk probe failed: <message>`; the original runs. |
| `rtk rewrite` exits 1, or exits 0/3 with empty stdout | `unchanged`; the original runs. |
| `rtk rewrite` exits 2 or any other code | `declined` with `rtk rewrite exited <code>`; the original runs. |
| `rtk rewrite` exceeds `RTK_REWRITE_TIMEOUT_MS` | the child is killed; `declined` with `rtk rewrite timed out`; the original runs. |
| `rtk rewrite` cannot be spawned | `declined` with `rtk rewrite failed: <message>`; the original runs. |
| `interceptShell` on the interceptor throws | caught in `interceptShell` (the seam); the original runs. |
| Candidate fails any validator rule | `declined` with the rule's reason; the original runs. |
| A rewritten command runs and exits non-zero | its exit code and output are returned as-is; nax never re-runs the original (R3). |
| `postProcess` throws on a rewritten command's stdout | the raw stdout is used. |
| No interceptor installed (`_bashToolDeps.interceptor` undefined — entry points that skip `setupRun`) | the original runs. |
| `bash.enabled: true` with master `enabled: false` | config validation fails with `execution.commandInterceptor.bash.enabled requires execution.commandInterceptor.enabled`. |

## Out of Scope

- Rewriting user-authored command strings: `quality.commands`, `acceptance.command` and every other config-supplied command stay unintercepted (R10 stands for them).
- ACP agents (Claude Code, Codex, OpenCode): their own shell tools are theirs to hook; nax does not add `AGENT` to `buildAllowedEnv` and does not rewrite their commands.
- A Codex-style prompt instruction telling the model to prefix `rtk` itself.
- Accepting rtk rewrites that change the command word (`cat` -> `rtk read`, `npx tsc` -> `rtk tsc`), insert after a wrapper (`uv run rtk pytest`), or normalise whitespace; all are declined, and widening the validator is a separate change.
- Rewriting a segment that writes into or reads from a pipe.
- Adding `AGENT=1` when a marker was inherited but is removed by `quality.stripEnvVars` (e.g. `CLAUDECODE` stripped); marker presence is read from the nax process environment, the same rule `withAgentOutputEnv` applies today.
- A config switch for the `AGENT=1` overlay on `Bash` and `RunCommand`; it is on for every run, like the quality and verification runners.
- Stripping rtk's `[see remaining: tail ... rtk/tee/...]` hint; only the hints `RTK_HINT_LINE` already matches are stripped.
- Configuring `RTK_REWRITE_TIMEOUT_MS` through `NaxConfig`; it is an exported constant.
- A per-call cache of `rtk rewrite` results.
- Interception of `RunCommand` (Exec): it is argv-shaped and receives only the `AGENT=1` overlay in this spec.
- Changing the existing Git site's verbs, validation or hint stripping.
- Verifying the env-overlay behaviour of the srt sandbox on Linux; the probe covered macOS only.
- Rewriting a command the lexer refuses (command substitution, `2>&1`, subshells) under the `raw` approval mode; it runs unrewritten.

## Stories

**US-001 — A validated shell interception seam** (no dependencies)
Add `src/execution/command-interceptor/shell.ts` with `ShellInterceptRequest`,
`ShellInterceptResult`, `ShellInterceptOutcome`, `validateShellRewrite` and `interceptShell`;
widen `Site` and `CommandInterceptor`; export from the barrel; rewrite the barrel's header
comment and the `Site` doc comment, and rename the `command-interceptor.test.ts` test titled
"the Git tool is the only interception site" to describe what it still asserts.

**US-002 — rtk answers shell rewrites; config gains `bash.enabled`** (depends on US-001)
Add `bash` to `CommandInterceptorConfigSchema`, its default literal, `CommandInterceptorConfig`
and `FIELD_DESCRIPTIONS`; add `bash`, `rewrite` and `interceptShell` to the rtk interceptor,
`RTK_REWRITE_TIMEOUT_MS`, and `bash` in the state record.

**US-003 — The Bash tool runs the validated rewrite after the permission decision** (depends on US-002)
Add `_bashToolDeps.interceptor`, call `interceptShell` inside `Bash.run`, run `postProcess` on
rewritten output, install the interceptor from `setupRun`, and document the Bash site in
`docs/guides/mcp-and-interception.md` (Part 2: configuration row, a "Scope" rewrite naming
both sites and why Bash is not R10's case, the validator rules, and the decline table above).
**Verification note:** `bun run check:complexity` must pass; the interception, overlay and
post-processing live in one helper in `src/tools/bash.ts` that `run` calls.

**US-004 — Agent-issued commands run with `AGENT=1`** (no dependencies)
Add `src/utils/agent-output-env.ts`, re-export from `src/verification/executor.ts`, and apply
`agentOutputOverlay` in `Bash.run` and `runExecBranch` on both spawn paths.

### Context Files

**US-001**
- `src/execution/command-interceptor/index.ts` — `Site`, `CommandInterceptor`, `validateRewrite`, `interceptArgv` to mirror
- `src/permissions/bash-lex.ts` — `lexBashCommand`, `BashSegment`, `BashToken`
- `test/unit/execution/command-interceptor.test.ts` — seam test patterns

**US-002**
- `src/execution/interceptors/rtk/index.ts` — `createRtkInterceptor`, `RtkDeps`, modes
- `src/config/schemas-execution.ts` — `CommandInterceptorConfigSchema` and the `ExecutionConfigSchema` default literal
- `src/config/runtime-types-execution.ts` — `CommandInterceptorConfig`
- `src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS`
- `test/unit/execution/interceptors/rtk.test.ts` — provider test patterns

**US-003**
- `src/tools/bash.ts` — `createBashTool`, `_bashToolDeps`
- `src/tools/git.ts` — the Git site's `interceptArgv` + `postProcess` usage to mirror
- `src/execution/lifecycle/run-setup.ts` — the interceptor install
- `test/unit/tools/runtime-sandbox-audit.test.ts` — drives `Bash` through `createCodingToolRuntime` with `compileToolPolicy`
- `test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts` — `setupRun` install tests

**US-004**
- `src/verification/executor.ts` — `AGENT_OUTPUT_MARKERS`, `withAgentOutputEnv`
- `src/tools/bash.ts` — both spawn paths in `createBashTool`
- `src/tools/run-command-exec.ts` — both spawn paths in `runExecBranch`
- `src/quality/runner.ts` — existing consumer of `withAgentOutputEnv`
- `test/unit/tools/run-command-exec-sandbox.test.ts` — launcher env overlay test patterns

### Creates

**US-001**
- `src/execution/command-interceptor/shell.ts` — shell seam and validator
- `test/unit/execution/command-interceptor/shell.test.ts` — validator and seam tests

**US-002**
- `test/unit/execution/interceptors/rtk-shell.test.ts` — `interceptShell` answer tests with a stubbed `rewrite`
- `test/integration/execution/interceptors/rtk-rewrite.test.ts` — default `rewrite` against a fake `rtk` executable on `PATH`

**US-003**
- `test/unit/tools/bash-intercept.test.ts` — Bash rewrite, policy ordering, postProcess and audit tests

**US-004**
- `src/utils/agent-output-env.ts` — `AGENT_OUTPUT_MARKERS`, `withAgentOutputEnv`, `agentOutputOverlay`, `_agentOutputEnvDeps`
- `test/unit/utils/agent-output-env.test.ts` — overlay rule tests
- `test/integration/sandbox/bash-agent-env.test.ts` — real srt-launcher check that the `AGENT=1` overlay reaches a wrapped command

### Modifies

**US-001**
- `test/unit/execution/command-interceptor.test.ts` — the test titled "the Git tool is the only interception site" (line 109) keeps its assertions but its title becomes false once `Site` has two members; US-001 renames it to describe what it asserts. The replacing invariant: no test title claims Git is the only site.

**US-002**
- `test/unit/execution/interceptors/rtk.test.ts` — three closed-world expectations pin the recorded state to `{ enabled, version, verbs }`: the two state-record tests (lines 53 and 59) and the `defaultRecord` log-line test (line 160, `entries[0].data`). US-002 adds `bash` to `InterceptorState` and to the logged fields, always present and `false` when the option is absent, so each expectation gains `bash: false`. The replacing invariant: the record and the log line carry exactly `enabled`, `version`, `verbs`, `bash`.

**US-003**
- `test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts` — its `withDepsRestore` calls (line 34) restore only `_gitToolDeps.interceptor`; once `setupRun` also assigns `_bashToolDeps.interceptor`, that module-level value leaks into later test files. US-003 adds `withDepsRestore(_bashToolDeps, ["interceptor"])` and the new `setupRun` criteria to this file. The replacing invariant: every interceptor `setupRun` installs is restored after each test.

**US-004**
- `test/unit/tools/run-command-exec-sandbox.test.ts` — the "Yarn no-scripts env overlay survives wrapping" test (line 99) asserts the launcher's `env` equals exactly `{ YARN_ENABLE_SCRIPTS: "false" }`, and its result depends on whether the test process inherits `CLAUDECODE`/`AGENT`. US-004 merges the `AGENT=1` overlay into that env, so the test stubs `_agentOutputEnvDeps.processEnv` to an environment with no marker and asserts `{ YARN_ENABLE_SCRIPTS: "false", AGENT: "1" }`. The replacing invariant: the Yarn key survives wrapping alongside the agent-output key.

### Seams

- **US-001 -> US-003: `interceptShell` -> `createBashTool().run`.** US-003's criteria drive `createCodingToolRuntime(...).callTool("Bash", ...)` with `_bashToolDeps.interceptor` set to a stub whose `interceptShell` records its request, and assert what `_bashToolDeps.runArgv` received.
- **US-002 -> US-003: `createRtkInterceptor({ bash })` -> `setupRun`.** US-003's criteria drive a real `setupRun` and assert `_bashToolDeps.interceptor` is the same instance as `_gitToolDeps.interceptor` and that its recorded state carries the configured `bash` value.
- **US-004: `agentOutputOverlay` -> `createBashTool().run` and `runExecBranch`.** US-004's criteria drive `callTool("Bash", ...)` and the Exec branch with `_agentOutputEnvDeps.processEnv` stubbed, and assert the `env` the spawn received.

## Acceptance Criteria

### US-001 — A validated shell interception seam

- [unit] `validateShellRewrite` returns `{ kind: "rewritten", command: "rtk bun test a.test.ts", provider: "rtk" }` for original `bun test a.test.ts` and that candidate.
- [unit] `validateShellRewrite` accepts candidate `FOO=1 rtk bun test` for original `FOO=1 bun test`, where the insertion follows the assignment token.
- [unit] `validateShellRewrite` accepts candidate `rtk bun test; rtk git status` for original `bun test; git status`, an insertion in each of two segments.
- [unit] `validateShellRewrite` accepts candidate `cd pkg && rtk bun test` for original `cd pkg && bun test`, where only the second segment is rewritten.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `cat src/a.ts` and candidate `rtk read src/a.ts`.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `cd pkg&&bun test` and candidate `cd pkg && rtk bun test`, because spacing changed.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `uv run pytest -q` and candidate `uv run rtk pytest -q`, because the insertion is not at the command word.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `git log --oneline | head -5` and candidate `rtk git log --oneline | head -5`, because the rewritten segment feeds a pipe.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `bun test 'a b.ts'` and candidate `rtk bun test "a b.ts"`, because quoting changed.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `rtk bun test` and candidate `rtk rtk bun test`.
- [unit] `validateShellRewrite` returns `kind: "declined"` when the candidate appends a segment, for original `bun test` and candidate `rtk bun test; rm -rf .`.
- [unit] `validateShellRewrite` returns `kind: "declined"` for original `cat x | grep y` and candidate `cat x | rtk grep y`, because the rewritten segment reads a pipe.
- [unit] `validateShellRewrite` returns `kind: "declined"` when the original does not lex, for original `bun test $(id)` and candidate `rtk bun test $(id)`.
- [unit] `validateShellRewrite` returns `{ kind: "unchanged" }` when the candidate equals the original.
- [unit] `validateShellRewrite` returns an `unchanged` or `declined` result it is given without modification.
- [unit] `interceptShell("bun test", root, undefined)` returns `{ command: "bun test", rewritten: false }`.
- [unit] `interceptShell` with an interceptor that has no `interceptShell` method returns the original command with `rewritten: false`.
- [unit] `interceptShell` calls the interceptor's `interceptShell` once with `{ kind: "shell", command, cwd, site: "bash" }`.
- [unit] `interceptShell` returns `{ command: "rtk bun test", provider: "rtk", rewritten: true }` when the interceptor answers `rewritten` with a candidate that passes validation.
- [unit] `interceptShell` returns the original command with `rewritten: false` when the interceptor answers a candidate that fails validation.
- [unit] `interceptShell` returns the original command with `rewritten: false` when the interceptor's `interceptShell` throws.
- [unit] `interceptShell` and `validateShellRewrite` are importable from `@/execution/command-interceptor`.

### US-002 — rtk answers shell rewrites; config gains `bash.enabled`

- [unit] `ExecutionConfigSchema` parsed with no `commandInterceptor` yields `commandInterceptor.bash.enabled === false`.
- [unit] `DEFAULT_CONFIG.execution.commandInterceptor.bash.enabled` is `false`.
- [unit] `ExecutionConfigSchema` parses `commandInterceptor: { enabled: true, bash: { enabled: true } }` and yields `bash.enabled === true`.
- [unit] `ExecutionConfigSchema` rejects `commandInterceptor: { enabled: false, bash: { enabled: true } }` with an issue whose message is `execution.commandInterceptor.bash.enabled requires execution.commandInterceptor.enabled`.
- [unit] `ExecutionConfigSchema` rejects an unknown key inside `commandInterceptor.bash`.
- [unit] `FIELD_DESCRIPTIONS` has a non-empty entry for `execution.commandInterceptor.bash.enabled`.
- [unit] The interceptor from `createRtkInterceptor({ enabled: true, verbs: [], bash: true, _deps })` with `rewrite` stubbed to `{ exitCode: 3, stdout: "rtk bun test\n", timedOut: false }` answers `interceptShell` for `bun test` with `{ kind: "rewritten", command: "rtk bun test", provider: "rtk" }`.
- [unit] The same interceptor answers `rewritten` when the stubbed `rewrite` returns `{ exitCode: 0, stdout: "rtk bun test", timedOut: false }`.
- [unit] The interceptor answers `{ kind: "unchanged" }` when the stubbed `rewrite` returns `{ exitCode: 1, stdout: "", timedOut: false }`.
- [unit] The interceptor answers `{ kind: "unchanged" }` when the stubbed `rewrite` returns `{ exitCode: 3, stdout: <the command>, timedOut: false }`.
- [unit] The interceptor answers `{ kind: "unchanged" }` when the stubbed `rewrite` returns `{ exitCode: 3, stdout: "", timedOut: false }`.
- [unit] The interceptor answers `{ kind: "declined", reason: "rtk rewrite exited 2" }` when the stubbed `rewrite` returns `{ exitCode: 2, stdout: "", timedOut: false }`.
- [unit] The interceptor answers `{ kind: "declined", reason: "rtk rewrite exited 127" }` when the stubbed `rewrite` returns `{ exitCode: 127, stdout: "", timedOut: false }`.
- [unit] The interceptor answers `{ kind: "declined", reason: "rtk rewrite timed out" }` when the stubbed `rewrite` returns `{ exitCode: -1, stdout: "", timedOut: true }`.
- [unit] The interceptor answers `{ kind: "declined", reason: "rtk rewrite failed: spawn ENOENT" }` when the stubbed `rewrite` rejects with an error whose message is `spawn ENOENT`.
- [unit] With `bash: false`, `interceptShell` answers `{ kind: "unchanged" }` and the stubbed `rewrite` is never called.
- [unit] With `enabled: false`, `interceptShell` answers `{ kind: "unchanged" }` and the stubbed `rewrite` is never called.
- [unit] With `enabled: true`, `bash: true` and `which` returning `null`, `interceptShell` answers `{ kind: "declined", reason: "rtk binary not found on PATH" }` and `rewrite` is never called.
- [unit] With `enabled: true`, `bash: true` and `which` throwing `boom`, `interceptShell` answers `{ kind: "declined", reason: "rtk probe failed: boom" }`.
- [unit] The recorded `InterceptorState` carries `bash: true` when the interceptor is created with `bash: true`, and `bash: false` when the option is absent.
- [unit] `RTK_REWRITE_TIMEOUT_MS` imported from `@/execution/interceptors/rtk` equals `2000`.
- [integration] The default `rewrite`, given a fake `rtk` executable on `PATH` that records its pid to a file and then sleeps, resolves with `timedOut: true` within `RTK_REWRITE_TIMEOUT_MS` plus one second, and the recorded pid is no longer a running process afterwards.
- [integration] The default `rewrite`, given a fake `rtk` executable on `PATH` that prints `rtk bun test` and exits 3 when called as `rtk rewrite "bun test"`, resolves `{ exitCode: 3, stdout: "rtk bun test\n", timedOut: false }`.

### US-003 — The Bash tool runs the validated rewrite after the permission decision

- [unit] Through `createCodingToolRuntime(...).callTool("Bash", { command: "bun test a.test.ts" })` under a gated policy granting `bun test*`, with `_bashToolDeps.interceptor` answering the candidate `rtk bun test a.test.ts`, `_bashToolDeps.runArgv` receives argv `["/bin/sh", "-c", "rtk bun test a.test.ts"]`.
- [unit] In that same call the interceptor's `interceptShell` receives command `bun test a.test.ts`, the model's original.
- [unit] Through `callTool("Bash", { command: "rm -rf src" })` under a gated policy that does not grant `rm`, the call is denied and the interceptor's `interceptShell` is never called.
- [unit] When the call is rewritten, the tool result's `audit.executed` equals `["/bin/sh", "-c", "rtk bun test a.test.ts"]`.
- [unit] When the interceptor answers a candidate that fails validation (`rtk read src/a.ts` for `cat src/a.ts`), `runArgv` receives `["/bin/sh", "-c", "cat src/a.ts"]`.
- [unit] When `_bashToolDeps.interceptor` is undefined, `runArgv` receives the original command and `audit.executed` is `["/bin/sh", "-c", <original>]`.
- [unit] With a launcher supplied to `createBashTool`, the launcher's request carries `spec: { kind: "shell", shell: "/bin/sh", command: "rtk bun test a.test.ts" }` for a rewritten call.
- [unit] For a rewritten call whose stdout ends with `\n[full output: rtk recall 12]`, the tool result's content equals the framed output built from that stdout with the hint line removed.
- [unit] For a call that was NOT rewritten, stdout ending with `\n[full output: rtk recall 12]` is returned with that line intact.
- [unit] For a rewritten call, the interceptor's `postProcess` receives the request `{ kind: "shell", command: <the model's original command>, cwd: <ctx.root>, site: "bash" }`.
- [unit] For a rewritten call whose interceptor `postProcess` throws, the tool result's content carries the raw stdout.
- [unit] A rewritten call that exits `1` returns `isError: true` with `audit.exitCode === 1`, and `runArgv` is called exactly once.
- [unit] After a real `setupRun` with `commandInterceptor: { enabled: true, bash: { enabled: true } }`, `_bashToolDeps.interceptor` is the same object as `_gitToolDeps.interceptor`.
- [unit] After a real `setupRun` with `commandInterceptor: { enabled: true, bash: { enabled: true } }` and a log sink attached, the `rtk interceptor state` log entry's data carries `bash: true`.
- [unit] After a real `setupRun` with the default config, `_bashToolDeps.interceptor.interceptShell` answers `{ kind: "unchanged" }` for `bun test`.

### US-004 — Agent-issued commands run with `AGENT=1`

- [unit] `agentOutputOverlay([])` returns `{ AGENT: "1" }` when `_agentOutputEnvDeps.processEnv` returns an environment with none of `CLAUDECODE`, `REPL_ID`, `AGENT`.
- [unit] `agentOutputOverlay([])` returns `undefined` when `_agentOutputEnvDeps.processEnv` returns an environment carrying `CLAUDECODE`.
- [unit] `agentOutputOverlay([])` returns `undefined` when `_agentOutputEnvDeps.processEnv` returns an environment carrying `AGENT: "0"`.
- [unit] `agentOutputOverlay(["AGENT"])` returns `undefined` when no marker is inherited.
- [unit] `withAgentOutputEnv` and `AGENT_OUTPUT_MARKERS` imported from `@/verification` are the same values as those imported from `src/utils/agent-output-env.ts`.
- [unit] `createBashTool().run({ command: "bun test" }, ctx)` with no launcher and no inherited marker calls `_bashToolDeps.runArgv` with `env: { AGENT: "1" }`.
- [unit] The same call with an inherited `CLAUDECODE` calls `runArgv` with no `env` key.
- [unit] `createBashTool({ stripEnvVars: ["AGENT"] })` calls `runArgv` with no `env` key when no marker is inherited.
- [unit] `createBashTool({ launcher })` with no inherited marker passes the launcher a request whose `env` is `{ AGENT: "1" }`.
- [unit] `runExecBranch` with no launcher, no Exec env and no inherited marker calls `runArgv` with `env: { AGENT: "1" }`.
- [unit] `runExecBranch` with a launcher, the Yarn no-scripts env and no inherited marker passes the launcher `env: { YARN_ENABLE_SCRIPTS: "false", AGENT: "1" }`.
- [unit] `runExecBranch` with an inherited `CLAUDECODE` and no Exec env passes no `env` key.
- [integration] With a real srt-backed launcher (`createCommandLauncher` + `createSrtBackend`, state `available`; the test is skipped when `probeSandbox` reports srt unavailable), `createBashTool({ launcher }).run({ command: "echo AGENT=$AGENT" }, ctx)` with no inherited marker returns output carrying `AGENT=1`.
- [unit] The quality runner still spawns a configured command with `AGENT: "1"` in its env when no marker is inherited (the moved helper keeps its behaviour).
