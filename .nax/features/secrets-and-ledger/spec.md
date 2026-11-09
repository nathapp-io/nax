# SPEC: Secret exposure and cost-ledger integrity (2026-11-09 review, F2)

## Summary

Close six findings from the 2026-11-09 whole-repo review (`docs/reviews/20261109-review-nax.md`): M7, M8, M9, M10,
M11 and M18. Two leak secrets to an agent or a model: ACP agent processes receive every `NAX_*` variable (including
the Telegram bot token) and other providers' API keys (M7), and an `@` mention through a symlink attaches a
git-ignored file such as `.env` (M8). Two lose cost records: a failed cost-ledger drain drops the events it was
writing, from memory and from disk (M9), and a failed or timed-out `complete()` hop records zero spend (M10). Two
silently change user data: the PRD escape sanitizer rewrites valid JSON (M11), and `nax setup --fill-scripts`
replaces an unparseable `package.json` or `turbo.json` with a stub (M18).

This is feature F2 of five cut from that review (user ruling 2026-11-09). F1 (agent sandbox and permission
hardening) is merged. F3 (memory forget integrity), F4 (gates and config) and F5 (LOW sweep) follow as separate specs.

## Motivation

The review reproduced every finding against HEAD `475562fda`; the code below is unchanged at `fc9dea80b`.

- **M7, run sessions.** `backendEnv` (`packages/nax/src/agents/acp/open-context.ts:37`) passes the whole
  `buildAllowedEnv` result (`packages/nax/src/agents/shared/env.ts:57`) to the ACP backend as `env`. The backend
  merges `env` after its own `authEnv` allowlist (`packages/nax-agent-acp/src/client/env.ts:26`), so the allowlist is
  bypassed. `buildAllowedEnv` admits every variable with the prefix `NAX_`, `CLAW_` or `TURBO_` and every provider's
  API key, so a codex agent gets `ANTHROPIC_API_KEY` and every agent gets `NAX_TELEGRAM_TOKEN`
  (`packages/nax/src/interaction/plugins/telegram.ts:81`). A prompt-injected agent with shell access reads them with
  `env`.
- **M7, chat sessions.** The review did not list these. `acpSessionOptions`
  (`packages/nax/src/chat/acp/acp-session-options.ts:65`), `probeAcpAgent` (`packages/nax/src/chat/acp/acp-probe.ts:18`)
  and `acpSubagentSessionOptions` (`packages/nax/src/chat/acp/acp-subagent-session.ts:107`) open the backend with
  `inheritEnv: true`, which hands the whole `process.env`, Telegram token and all, to the chat brain.
- **M8.** `expandToken` (`packages/nax/src/chat/mentions/mention-expand.ts:153`) checks the repo boundary on the real
  path (`:158`) but asks `git check-ignore` about the typed path (`:160`, `ignoredRefusal` at `:190`). With `.env`
  ignored and a committed symlink `docs/notes.txt -> ../.env`, `@docs/notes.txt` attaches the secret.
- **M9.** `CostAggregator.drain` (`packages/nax/src/runtime/cost-aggregator.ts:542`) splices `_events` and `_errors`
  out (`:556`) before the write (`:581`). When the write throws, nothing restores them, and the next successful drain
  rewrites `<runId>.jsonl` with the later events only. Grounding also found that two overlapping drains interleave:
  the first one's `finally` clears `_draining` while the second is still writing, events recorded after that go to
  `_events`, and the second drain's restore (`:591-594`) clears them. `Bun.write` also overwrites the file in place,
  so a crash mid-write can truncate the whole ledger.
- **M10.** `dispatchCompleteHop` (`packages/nax/src/agents/manager-dispatch.ts:580`) turns any throw into a result
  with zero `tokenUsage` and `estimatedCostUsd: 0`. `runComplete` (`packages/nax/src/agents/acp/complete.ts:86`)
  rethrows a `SessionTurnError` that carries the spent tokens and cost, and on a turn timeout throws a plain
  `NaxError` (`:105-107`) that discards a result whose `tokenUsage` and `estimatedCostUsd` are known.
- **M11.** `parseRawString` (`packages/nax/src/prd/schema.ts:64`) runs `sanitizeInvalidEscapes` (`:37`) before every
  `JSON.parse`, including on valid JSON, and its `\x` and `\u` rules match the second backslash of an escaped `\\`.
  A valid JSON description `Path C:\\users and \\xampp` comes out of `validatePlanOutput` as `Path C:\sers and \u000ampp`.
- **M18.** `_fillScriptsDeps.readJson` (`packages/nax/src/cli/setup-fill.ts:9`) returns `null` both for a missing file
  and for a parse error, and `addScriptToPackageJson` (`:23`) and `addTurboTask` (`:31`) treat `null` as `{}` and
  write the result. A `package.json` with a trailing comma loses its name, version, dependencies and workspaces.

## Design

Every fix stays in `packages/nax`, at the function that already owns the check or the write.

### Integration

The baseline listings below exist only to locate the code; the target is the interface to implement.

**Read only (unchanged).**

- `buildAllowedEnv(options?: BuildAllowedEnvOptions): Record<string, string | undefined>` at
  `packages/nax/src/agents/shared/env.ts:57`. Its callers outside ACP (`hooks/runner.ts:271`,
  `hooks/agent/run-hook.ts:298`, `utils/command-argv.ts:4`, `agents/acp/adapter.ts:84`) keep today's behaviour.
- `buildAgentEnv(input: AgentEnvInput)` at `packages/nax-agent-acp/src/client/env.ts:22`. With `inheritEnv: false` it
  picks `PATH HOME USER SHELL TMPDIR LANG TERM`, `LC_*` and the registry entry's `authEnv` from `process.env`, then
  applies `extra` (nax's `env` option) on top. Registry `authEnv` (`packages/nax-agent-acp/src/client/registry.ts`):
  claude `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`; codex `OPENAI_API_KEY`; cursor `CURSOR_API_KEY`; gemini
  `GEMINI_API_KEY`; opencode and pi none.
- The backend option schema (`packages/nax-agent-acp/src/client/options.ts:140`) rejects an `env` name that does not
  match `^[A-Za-z_][A-Za-z0-9_]*$` and a value that contains NUL.
- `readTurnSpend(err: unknown): FailedTurnSpend | undefined` and
  `attachTurnSpend(err: object, spend: FailedTurnSpend): void`, both exported from `@nathapp/nax-agent`
  (`packages/nax-agent/src/index.ts:455`). `FailedTurnSpend` is
  `{ tokenUsage: TokenUsage; costUsd: number; costSource?: CostSource }` and `CostSource` is
  `"computed" | "reported" | "unpriced"`.
- `buildDispatchErrorEvent` (`packages/nax/src/agents/manager-dispatch.ts:318-327`) is the precedent for M10: it lifts
  `tokenUsage`, `estimatedCostUsd` and `exactCostUsd` off a `SessionTurnError`.
- `spendOfError` (`packages/nax/src/agents/acp/pricing.ts:31`) is the precedent for reading a `FailedTurnSpend`: a
  `costSource` of `"reported"` makes `costUsd` an exact cost.

**Changed.**

- New: `acpProviderEnvFamily(agent: string): { readonly keys: readonly string[]; readonly prefixes: readonly string[] }`
  in `packages/nax/src/agents/shared/env.ts` (US-001). The provider variables an ACP agent may see:

  | agent | keys | prefixes |
  |:---|:---|:---|
  | `claude` | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` | `CLAUDE_`, `ANTHROPIC_` |
  | `codex` | `OPENAI_API_KEY` | `CODEX_` |
  | `gemini` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `GEMINI_` |
  | `cursor` | none | `CURSOR_` |
  | `opencode`, `pi`, any other name | every entry of `API_KEY_VARS` | `CLAUDE_`, `ANTHROPIC_`, `CODEX_`, `GEMINI_`, `OPENCODE_`, `MINIMAX_`, `CURSOR_` |

  opencode, pi and custom agents are multi-provider, so they keep every provider key (user ruling 2026-11-09).
- New: `buildAcpRunEnv(agent: string, modelEnv?: Readonly<Record<string, string>>): Record<string, string>` in
  `packages/nax/src/agents/shared/env.ts` (US-001). It returns the `ESSENTIAL_VARS` present in `process.env`, the
  sanitised `HOME` (same rule as `buildAllowedEnv`), every `process.env` variable whose name is in the agent's family
  `keys` or starts with one of its `prefixes`, then `modelEnv` on top. Nothing else: no `NAX_`, `CLAW_` or `TURBO_`
  variable unless `modelEnv` names it.
- `backendEnv` at `packages/nax/src/agents/acp/open-context.ts:37` (US-001).
  - Baseline: `backendEnv(modelEnv?: Readonly<Record<string, string>>): Record<string, string>` over `buildAllowedEnv`.
  - Target: `backendEnv(agent: AcpAgentName, modelEnv?: Readonly<Record<string, string>>): Record<string, string>`
    over `buildAcpRunEnv(agent, modelEnv)`, with the existing name and NUL filter. `launchOptions` passes the agent
    through from `backendOptions(agent, ...)`. The `NAX_ACP_SHELL_SANDBOX` carrier is still deleted from the result.
- New: `buildAcpChatEnv(agent: string): Record<string, string>` in `packages/nax/src/agents/shared/env.ts` (US-002).
  It returns every `process.env` variable with a string value, a name matching `^[A-Za-z_][A-Za-z0-9_]*$` and no NUL
  in the value, except:
  - names starting with `NAX_`, `CLAW_` or `TURBO_`, and `TELEGRAM_BOT_TOKEN` (the bot token's fallback name,
    `packages/nax/src/interaction/plugins/telegram.ts:81`);
  - provider variables outside the agent's own family: a name in `API_KEY_VARS`, or starting with `CLAUDE_`,
    `ANTHROPIC_`, `CODEX_`, `GEMINI_`, `OPENCODE_`, `MINIMAX_` or `CURSOR_`, that is not in
    `acpProviderEnvFamily(agent).keys` and does not start with one of its `prefixes`.

  Everything else stays: `SSH_AUTH_SOCK`, `GH_TOKEN`, `HTTPS_PROXY`, `EDITOR`, toolchain paths. The chat brain is an
  interactive coding agent and must keep `gh`, `git push` over ssh-agent and proxies working (user ruling
  2026-11-09). Chat does not sanitise `HOME`, as today.
- `acpSessionOptions`, `probeAcpAgent` and `acpSubagentSessionOptions` (US-002).
  - Baseline: each calls `acpBackend({ agent, allowUnsandboxed: true, inheritEnv: true, ... })`.
  - Target: each calls `acpBackend({ agent, allowUnsandboxed: true, inheritEnv: false, env: buildAcpChatEnv(agent), ... })`,
    other keys unchanged. The header comment of `acp-session-options.ts` ("The agent gets the whole environment")
    is corrected to say which variables are withheld.
- `expandToken` at `packages/nax/src/chat/mentions/mention-expand.ts:153` (US-003).
  - Baseline: after the boundary check, `ignoredRefusal(located.path, ctx.cwd)`.
  - Target: the typed-path check runs first, unchanged. When it does not refuse and `relative(ctx.realRoot,
    located.realPath)` is not empty, `ignoredRefusal(<that relative path>, ctx.realRoot)` runs as a second check and
    its refusal is returned: ignored refuses with `not attached: ignored by git`, a timeout or an exit code other
    than 0 and 1 refuses with the existing notes. The second check runs for every mention, symlinked or not; one
    extra git call per mention is accepted.
- `CostAggregator.drain` at `packages/nax/src/runtime/cost-aggregator.ts:542` (US-004).
  - Baseline: splice, write, restore on success only; concurrent drains interleave.
  - Target: `drain(): Promise<void>` keeps its signature. Drains run one at a time: a drain called while another is
    running starts after it settles (fulfilled or rejected), through a private promise chain. A drain called while
    no drain is pending starts its first write pass synchronously, before `drain()` returns, so an event recorded
    right after the call lands in the in-flight arrays as today. A drain copies
    `_events` and `_errors` instead of splicing them. After the write loop, whether the last write resolved or
    threw, `_events` and `_errors` hold every event recorded before the drain ended, split by `kind` as today, so a
    later drain writes them, including late events a later write pass had already taken from the in-flight arrays.
    A write error still rejects the drain with that error. `_openScopes.clear()` still runs in `finally`. While a
    drain is pending, `snapshot()` counts the events being written as well as those recorded since, because they
    stay in `_events`.
  - `cost-aggregator.ts` is at its 600-line limit (`packages/repo-tooling/scripts/check-file-sizes.ts:31`), so the
    drain's write-pass loop moves into the new `packages/nax/src/runtime/cost-aggregator-drain.ts` and the file
    does not grow. That module takes the `write` function and the logger as parameters; it does not import
    `_costAggDeps` from `cost-aggregator.ts`, which would add an import cycle (`check:import-cycles`).
- `_costAggDeps.write` default at `packages/nax/src/runtime/cost-aggregator.ts:356` (US-004).
  - Baseline: `Bun.write(path, data)`.
  - Target: same signature. Writes `data` to a sibling temp file in the same directory, then renames it over `path`;
    on a failure it removes the temp file (best effort) and rethrows. Tests that override `write` are unaffected. The
    writer lives in the new `packages/nax/src/runtime/cost-ledger-write.ts` as `writeLedgerAtomic(path: string,
    data: string): Promise<number>`, resolving to the byte count written, and the default `write` (type
    `(path: string, data: string) => Promise<number>`, unchanged) delegates to it. The temp file is named
    `<path>.tmp-<pid>-<counter>`, so it never matches the `cost/*.jsonl` glob `cost-ledger-query.ts` reads.
- `runComplete` at `packages/nax/src/agents/acp/complete.ts:86` (US-005).
  - Baseline: on `result.timedOut === true`, throws `NaxError("complete() timed out", "AGENT_TIMEOUT", ...)`.
  - Target: the same `NaxError`, code and context, with `attachTurnSpend(err, { tokenUsage: result.tokenUsage,
    costUsd: result.exactCostUsd ?? result.estimatedCostUsd, costSource: result.exactCostUsd === undefined ?
    "computed" : "reported" })` called on it before the throw.
- `dispatchCompleteHop` at `packages/nax/src/agents/manager-dispatch.ts:580` (US-005).
  - Baseline: the catch returns zero `tokenUsage` and `estimatedCostUsd: 0`.
  - Target: signature unchanged; `dispatched` stays `false`. The catch fills the result's spend from the error: a
    `SessionTurnError` whose `tokenUsage` is defined gives `tokenUsage`, `estimatedCostUsd` (0 when undefined) and
    `exactCostUsd` (when defined); otherwise `readTurnSpend(err)`, when defined, gives `tokenUsage`,
    `estimatedCostUsd = costUsd`, and `exactCostUsd = costUsd` when `costSource` is `"reported"`; otherwise zero, as
    today. `manager-dispatch.ts` has 3 lines of headroom under the 600-line limit, so the lift is a new function
    `completeHopSpend(err: unknown): Pick<CompleteResult, "tokenUsage" | "estimatedCostUsd" | "exactCostUsd">` in the
    new `packages/nax/src/agents/complete-hop-spend.ts`, and the catch spreads its result. On the timeout path the
    attached `costUsd` is the exact cost when one was reported, so that hop's estimate equals its exact cost.
- `parseRawString` at `packages/nax/src/prd/schema.ts:64` (US-006).
  - Baseline: `JSON.parse(sanitizeInvalidEscapes(cleaned))`, then the control-character repair.
  - Target: `JSON.parse(cleaned)` first; its result is returned when it succeeds. Only when it throws does the
    existing chain run unchanged: sanitize, parse, control-character repair, then `SCHEMA_VALIDATION_FAILED` carrying
    the sanitized-parse error.
- `_fillScriptsDeps` and `fillScripts` at `packages/nax/src/cli/setup-fill.ts` (US-007).
  - Baseline: `readJson` returns `null` for absent and for unparseable; both become `{}` and are written.
    `fillScripts(workdir: string, analysis: RepoAnalysis): Promise<void>`.
  - Target: `readJson` is unchanged. New dep `exists: (path: string) => Promise<boolean>` (default
    `Bun.file(path).exists()`). When `readJson` returns `null` and `exists` returns `true`, `addScriptToPackageJson`
    and `addTurboTask` do not write and report the path through the new optional third parameter of
    `fillScripts(workdir: string, analysis: RepoAnalysis, warn?: (message: string) => void): Promise<void>`, with
    the message `[setup] <path> could not be read as JSON; left unchanged`. When `turbo.json` is skipped, the root
    `package.json` does not get the `turbo run type-check` passthrough either. `setupCommand`
    (`packages/nax/src/cli/setup.ts:98`) passes `_setupDeps.stderr` as `warn`, and the `_setupDeps.fillScripts` type
    at `setup.ts:24` gains the optional parameter. An absent file is still created as today.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A `process.env` value contains NUL or its name fails the backend's name pattern | Dropped from both the run env and the chat env, as `backendEnv` does today. |
| `modelEnv` names a variable the family would withhold (for example `NAX_FOO`) | Kept: per-model env is operator configuration and wins. |
| `git check-ignore` on the real path times out or exits with a code other than 0 or 1 | Refused, with the same notes the existing typed-path check gives (fail closed). |
| The cost-ledger write throws (ENOSPC, EACCES) | The drain rejects with that error; every event stays in memory and the next drain writes it. |
| The process dies during a ledger write | The previous `<runId>.jsonl` is intact; at most a temp sibling is left behind. |
| A `complete()` hop throws an error that carries no spend | Zero spend, as today. |
| PRD text is invalid JSON | The existing sanitize and repair chain runs, unchanged. |
| `package.json` or `turbo.json` exists but does not parse | Not written; one warning line on stderr per path; setup still exits 0. |

## Out of Scope

- The `nax-agent-acp` backend's own env merge (`buildAgentEnv` applies `extra` after the `authEnv` allowlist). nax stops passing secrets through `extra`; changing the backend's contract for other embedders is a separate decision.
- Secrets a chat brain can still read from the inherited environment that are not `NAX_*`, `CLAW_*`, `TURBO_*`, `TELEGRAM_BOT_TOKEN` or another provider's key (for example an `AWS_SECRET_ACCESS_KEY` the user exported). Chat keeps the user's environment on purpose (user ruling 2026-11-09); only the listed classes are withheld.
- `NAX_*` configuration variables a user may want a chat brain to see when it runs `nax` itself (for example `NAX_GLOBAL_CONFIG_DIR`). They are withheld with the rest of `NAX_*`; an opt-in passthrough is a new config surface.
- `buildAllowedEnv`'s other callers (hooks, `command-argv`, the ACP adapter's `buildAllowedEnv` method). They keep today's prefix allowlist.
- Callers that do not catch a drain rejection (`chat/chat-ledger.ts:60`, `chat/turn-runner.ts:93`, `chat/host-steer-compact.ts:132`). A ledger write failure still fails the chat turn as today.
- Removing stale temp files a crashed ledger write left behind.
- The spend of a failed `complete()` hop that a later fallback hop replaces. US-005 makes the failed hop's result carry its spend; how the fallback records and the final outcome report it is unchanged.
- Recovering a model's raw invalid backslash in PRD text (for example a single-backslash `C:\users`, which the fallback still turns into `C:sers`). US-006 only stops rewriting valid JSON (user ruling 2026-11-09).
- `setup-analyze.ts`'s identical `readJson`, which reads an unparseable `package.json` as having no scripts. With US-007 nothing is written for that file, so the misreading only adds gap lines.
- The other review findings (M1-M6, M12-M23, L1-L37). M1-M6 shipped in F1; the rest belong to F3-F5.
- US-004 only: a fault-injection test that the temp-and-rename write leaves the old ledger intact on a crash; the Failure Handling row is covered by the write's design, not by an AC.

## Stories

Seven stories, every one in `packages/nax`. Only US-002 depends on another story (US-001, for the provider family
table). Seven stories is a hardening bundle, which is where branch residuals appear; the user chose this cut on
2026-11-09.

### US-001: ACP run sessions get only their own provider's variables

Workdir: packages/nax. No dependencies.

Fix review M7 for run sessions. Add `acpProviderEnvFamily` and `buildAcpRunEnv` to `agents/shared/env.ts`, and make
`backendEnv` in `agents/acp/open-context.ts` take the agent and build its env with `buildAcpRunEnv`, so the `NAX_*`,
`CLAW_*` and `TURBO_*` variables and other providers' keys no longer reach the agent through the backend's `env`.

### US-002: Chat ACP sessions withhold nax secrets and other providers' keys

Workdir: packages/nax. Depends on US-001.

Fix review M7 for chat sessions. Add `buildAcpChatEnv` to `agents/shared/env.ts`, and make `acpSessionOptions`,
`probeAcpAgent` and `acpSubagentSessionOptions` open the backend with `inheritEnv: false` and that env, which keeps
the user's environment minus the withheld classes.

### US-003: An `@` mention through a symlink is refused when its target is git-ignored

Workdir: packages/nax. No dependencies.

Fix review M8 in `expandToken`: also ask `git check-ignore` about the real path, relative to the real repo root.

### US-004: A failed or overlapping cost-ledger drain loses no events

Workdir: packages/nax. No dependencies.

Fix review M9 in `CostAggregator.drain`: copy instead of splice, keep every event in memory whatever the write does,
run drains one at a time, and write the ledger through a temp file and rename.

### US-005: A failed or timed-out `complete()` hop keeps its spend

Workdir: packages/nax. No dependencies.

Fix review M10: `runComplete` attaches the timed-out turn's spend to its `AGENT_TIMEOUT` error, and
`dispatchCompleteHop` copies an error's spend into the failure result.

### US-006: Valid PRD JSON is parsed without escape rewriting

Workdir: packages/nax. No dependencies.

Fix review M11 in `parseRawString`: parse the cleaned text first and run `sanitizeInvalidEscapes` only when that fails.

### US-007: `nax setup --fill-scripts` leaves an unparseable manifest unchanged

Workdir: packages/nax. No dependencies.

Fix review M18 in `setup-fill.ts`: tell an absent file from an unparseable one, skip the write for an unparseable
`package.json` or `turbo.json`, and warn on stderr.

### Context Files

**US-001**

- `packages/nax/src/agents/shared/env.ts`
- `packages/nax/src/agents/acp/open-context.ts`
- `packages/nax-agent-acp/src/client/env.ts`
- `packages/nax/test/unit/agents/shared/env.test.ts`
- `packages/nax/test/unit/agents/acp/open-context.test.ts`

**US-002**

- `packages/nax/src/agents/shared/env.ts`
- `packages/nax/src/chat/acp/acp-session-options.ts`
- `packages/nax/src/chat/acp/acp-probe.ts`
- `packages/nax/src/chat/acp/acp-subagent-session.ts`
- `packages/nax/test/unit/chat/acp/acp-session-options.test.ts`

**US-003**

- `packages/nax/src/chat/mentions/mention-expand.ts`
- `packages/nax/test/unit/chat/mentions/mention-expand.test.ts`

**US-004**

- `packages/nax/src/runtime/cost-aggregator.ts`
- `packages/nax/test/unit/runtime/cost-aggregator.test.ts`

**US-005**

- `packages/nax/src/agents/manager-dispatch.ts`
- `packages/nax/src/agents/acp/complete.ts`
- `packages/nax-agent/src/session/turn-spend.ts`
- `packages/nax/test/unit/agents/acp/complete.test.ts`
- `packages/nax/test/unit/agents/manager-complete.test.ts`

**US-006**

- `packages/nax/src/prd/schema.ts`
- `packages/nax/test/unit/prd/schema.test.ts`

**US-007**

- `packages/nax/src/cli/setup-fill.ts`
- `packages/nax/src/cli/setup.ts`
- `packages/nax/test/unit/cli/setup-fill.test.ts`

### Creates

**US-004**

- `packages/nax/src/runtime/cost-aggregator-drain.ts` — the drain's write-pass loop, moved out of `cost-aggregator.ts` (600-line limit).
- `packages/nax/src/runtime/cost-ledger-write.ts` — `writeLedgerAtomic`, the temp-file-and-rename writer the default `_costAggDeps.write` delegates to.
- `packages/nax/test/unit/runtime/cost-aggregator-drain-failure.test.ts` — the drain failure, overlap and default-write cases; `cost-aggregator.test.ts` is at 613 lines.

**US-005**

- `packages/nax/src/agents/complete-hop-spend.ts` — `completeHopSpend`, the error-to-spend lift `dispatchCompleteHop` spreads (`manager-dispatch.ts` is at 597 of 600 lines).
- `packages/nax/test/unit/agents/manager-dispatch-complete-hop.test.ts` — `dispatchCompleteHop` has no direct test file.

**US-006**

- `packages/nax/test/unit/prd/schema-valid-escapes.test.ts` — the valid-JSON escape cases; `schema.test.ts` is at 791 lines, near the 800-line limit.

### Modifies

**US-001**

- `packages/nax/test/unit/agents/acp/open-context.test.ts` — the cases "is nax's allowlist plus the model env, all strings" (line 54) and "drops a variable whose name the backend's option schema rejects" (line 64) call backendEnv with no agent argument, and the first asserts that CLAUDE_TEST_ALLOWED passes through for an unnamed agent. backendEnv now takes the agent first. Replacement invariant: both cases pass "claude" as the agent; CLAUDE_TEST_ALLOWED still passes through for claude, ANTHROPIC_BASE_URL from the model env still arrives, UNRELATED_SECRET is still absent, every value is a string, and the invalid-name variable CLAUDE_X-Y is still dropped.

**US-002**

- `packages/nax/test/unit/chat/acp/acp-session-options.test.ts` — "AC-2: opens the backend with model and effort" (line 75) and "AC-3: omits model and effort keys when absent" (line 87) assert the exact acpBackend argument with inheritEnv true, and AC-3 asserts its sorted key list is agent, allowUnsandboxed, inheritEnv. The argument now has inheritEnv false and an env record. Replacement invariant: agent, allowUnsandboxed, model and effort are asserted exactly as before, inheritEnv is false, env is a record of string values, and the sorted key list is agent, allowUnsandboxed, env, inheritEnv when model and effort are absent.
- `packages/nax/test/unit/chat/acp/acp-probe.test.ts` — the probe case (line 49) asserts acpBackend was called with exactly agent codex, allowUnsandboxed true, inheritEnv true and initializeTimeoutMs. Replacement invariant: the same agent, allowUnsandboxed and initializeTimeoutMs, inheritEnv false, and an env record of string values.
- `packages/nax/test/unit/chat/acp/acp-subagent-session.test.ts` — the model-and-effort case (line 122) and "omits model and effort when the ACP model names neither" (line 134) assert the exact acpBackend argument with inheritEnv true and the sorted key list agent, allowUnsandboxed, inheritEnv. Replacement invariant: agent, model, effort and allowUnsandboxed asserted exactly as before, inheritEnv false, env a record of string values, and the sorted key list agent, allowUnsandboxed, env, inheritEnv when model and effort are absent.
- `packages/nax/test/unit/chat/subagent-session-acp.test.ts` — the cases at lines 141 and 162 assert the exact acpBackend argument with inheritEnv true (agent codex with model gpt-6.1-terra; agent cursor). Replacement invariant: the same agent, model and allowUnsandboxed values, inheritEnv false, and an env record of string values.

**US-004**

- `packages/nax/test/unit/runtime/cost-aggregator.test.ts` — "snapshot() includes in-flight events during drain" (line 217) records an event at cost 0.01, starts a drain whose write is pending, records a second event at 0.02, and asserts the snapshot's callCount is 1 and totalCostUsd 0.02. That held only because the drain spliced the first event out of memory. The drain now copies, so the event being written stays counted. Replacement invariant: the snapshot taken while the write is pending has callCount 2 and totalCostUsd 0.03.

**US-007**

- `packages/nax/src/cli/setup.ts` — `setupCommand` passes `_setupDeps.stderr` as the third argument of `_setupDeps.fillScripts`, and the `_setupDeps.fillScripts` type gains the optional warn parameter. Existing setup tests that mock fillScripts with fewer parameters keep passing.

### Seams

- `acpProviderEnvFamily` (created by US-001, exported from `agents/shared/env.ts`) is called by `buildAcpChatEnv` (US-002). US-002's codex and claude chat-env ACs prove the family decides which provider variables a chat brain keeps.
- `buildAcpRunEnv` (US-001) is reached from `backendOptions`, which `agents/acp/session.ts:140` calls to open every ACP run session; US-001's `backendOptions` ACs enter there.
- `buildAcpChatEnv` (US-002) is reached from `acpSessionOptions`, `probeAcpAgent` and `acpSubagentSessionOptions`; US-002's ACs enter at each of the three with the `acpBackend` factory stubbed.

## Acceptance Criteria

### US-001

- [unit] `acpProviderEnvFamily("codex")` returns keys `["OPENAI_API_KEY"]` and prefixes `["CODEX_"]`.
- [unit] `acpProviderEnvFamily("pi")` returns every entry of `API_KEY_VARS` as keys and `CLAUDE_`, `ANTHROPIC_`, `CODEX_`, `GEMINI_`, `OPENCODE_`, `MINIMAX_`, `CURSOR_` as prefixes.
- [unit] `acpProviderEnvFamily("my-custom-agent")` returns the same keys and prefixes as `acpProviderEnvFamily("pi")`.
- [unit] With `process.env` holding `NAX_TELEGRAM_TOKEN`, `CLAW_TOKEN`, `TURBO_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_HOME`, `buildAcpRunEnv("codex")` contains `OPENAI_API_KEY` and `CODEX_HOME` and none of `NAX_TELEGRAM_TOKEN`, `CLAW_TOKEN`, `TURBO_TOKEN` or `ANTHROPIC_API_KEY`.
- [unit] With `process.env` holding `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `NAX_TELEGRAM_TOKEN`, `buildAcpRunEnv("opencode")` contains `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and not `NAX_TELEGRAM_TOKEN`.
- [unit] `buildAcpRunEnv("claude", { NAX_FOO: "1" })` contains `NAX_FOO` equal to `"1"`.
- [unit] With `process.env.HOME` set to `/abs/home`, `buildAcpRunEnv("claude").HOME` equals `/abs/home`.
- [unit] With `process.env.HOME` deleted, `buildAcpRunEnv("claude").HOME` is a defined absolute path.
- [unit] With `process.env` holding `PATH` and `UNRELATED_VAR`, `buildAcpRunEnv("claude")` contains `PATH` and not `UNRELATED_VAR`.
- [unit] With `process.env` holding `NAX_TELEGRAM_TOKEN` and `ANTHROPIC_API_KEY`, `backendOptions("codex", opts).env` contains neither, where `opts` is an `OpenSessionOpts` whose `modelDef.env` is empty.
- [unit] With `process.env` holding `OPENAI_API_KEY`, `backendOptions("codex", opts).env` contains `OPENAI_API_KEY` and `backendOptions("codex", opts).inheritEnv` is `false`.
- [unit] `backendOptions("claude", opts)` where `opts.modelDef.env` holds `NAX_ACP_SHELL_SANDBOX` set to a valid carrier returns an `env` without `NAX_ACP_SHELL_SANDBOX` and a defined `shellSandbox`.
- [unit] With `process.env` holding `CLAUDE_BAD` set to a value containing NUL, `backendEnv("claude")` has no `CLAUDE_BAD` key.
- [integration] With `_acpDeps.acpBackend` stubbed to capture its options (as `test/unit/agents/acp/complete.test.ts` does) and `process.env` holding `NAX_TELEGRAM_TOKEN`, a `complete()` call on the ACP adapter for agent `codex` passes the stub options whose `env` has no `NAX_TELEGRAM_TOKEN`.

### US-002

- [unit] With `process.env` holding `NAX_TELEGRAM_TOKEN`, `TELEGRAM_BOT_TOKEN`, `CLAW_TOKEN` and `TURBO_TOKEN`, `buildAcpChatEnv("claude")` contains none of them.
- [unit] With `process.env` holding `SSH_AUTH_SOCK`, `GH_TOKEN`, `HTTPS_PROXY` and `EDITOR`, `buildAcpChatEnv("codex")` contains all four with their `process.env` values.
- [unit] With `process.env` holding `OPENAI_API_KEY`, `CODEX_HOME`, `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR`, `buildAcpChatEnv("codex")` contains `OPENAI_API_KEY` and `CODEX_HOME` and neither `ANTHROPIC_API_KEY` nor `CLAUDE_CONFIG_DIR`.
- [unit] With `process.env` holding `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `OPENAI_API_KEY`, `buildAcpChatEnv("claude")` contains `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR` and not `OPENAI_API_KEY`.
- [unit] With `process.env` holding `CURSOR_API_KEY` and `GEMINI_API_KEY`, `buildAcpChatEnv("cursor")` contains `CURSOR_API_KEY` and not `GEMINI_API_KEY`.
- [unit] With `process.env` holding a variable named `BAD-NAME` and a variable `GOOD` whose value contains NUL, `buildAcpChatEnv("claude")` contains neither.
- [unit] With the `acpBackend` factory stubbed and `process.env` holding `NAX_TELEGRAM_TOKEN` and `GH_TOKEN`, `acpSessionOptions` for agent `codex` calls the factory once with `inheritEnv: false` and an `env` that contains `GH_TOKEN` and not `NAX_TELEGRAM_TOKEN`.
- [unit] With the `acpBackend` factory stubbed and `process.env` holding `NAX_TELEGRAM_TOKEN`, `probeAcpAgent({ agent: "codex", cwd })` calls the factory with `inheritEnv: false` and an `env` without `NAX_TELEGRAM_TOKEN`.
- [unit] With the `acpBackend` factory stubbed and `process.env` holding `NAX_TELEGRAM_TOKEN` and `ANTHROPIC_API_KEY`, `acpSubagentSessionOptions` for agent `cursor` calls the factory with `inheritEnv: false` and an `env` containing neither.

### US-003

- [unit] With `.env` git-ignored, `/repo/docs/notes.txt` resolving to the real path `/repo/.env`, and the git fake reporting ignored only for the argument `.env`, `expandChatMentions("@docs/notes.txt", ...)` returns one record with path `docs/notes.txt`, status `refused` and note `not attached: ignored by git`, and no body.
- [unit] For that refused mention, the second git call is `check-ignore -q -- .env` with `cwd` equal to the real repo root.
- [unit] When the typed path is itself reported ignored, `expandChatMentions` refuses it and makes exactly one git call.
- [unit] For a non-symlinked tracked file `src/a.ts` that git does not ignore, `expandChatMentions("@src/a.ts", ...)` returns status `attached`.
- [unit] When the git fake reports not ignored for the typed path and exit code 128 for the real-path check, `expandChatMentions("@docs/notes.txt", ...)` returns status `refused` with note `not attached: git check-ignore failed (exit 128)`.
- [integration] In a real temp git repo with `.gitignore` containing `.env`, a file `.env` holding `SECRET_TOKEN=test`, and a committed symlink `docs/notes.txt` pointing to `../.env`, `expandChatMentions("@docs/notes.txt", ...)` returns status `refused` and no record carries the text `SECRET_TOKEN`.

### US-004

- [unit] With `_costAggDeps.write` overridden to throw on its second call only: record event `turn1`, drain; record `turn2`, drain (it rejects with the write's error); record `turn3`, drain. The text of the last write contains the rows `turn1`, `turn2` and `turn3`.
- [unit] After a drain whose write throws, `snapshot()` still counts every event recorded before that drain.
- [unit] An event recorded while a drain's write is pending, where that write then throws, is contained in the text the next successful drain writes.
- [unit] An error event recorded with `recordError` before a drain whose write throws is contained, as a row with `kind` `"error"`, in the text the next successful drain writes.
- [unit] With `_costAggDeps.write` overridden to wait on a gate: calling `drain()` twice without awaiting makes the second drain's first write start only after the first drain's write has resolved, and both calls resolve.
- [unit] Two overlapping drains, with an event recorded between the two calls, end with the last write's text containing every recorded event.
- [unit] After the first of two overlapping drains rejects, the second still runs its write and resolves.
- [unit] With one event recorded and `_costAggDeps.write` waiting on a gate, calling `drain()` and then recording a second event before releasing the gate makes the drain perform two writes, the first containing only the first event and the second containing both.
- [unit] With an event at cost 0.01 recorded, a drain whose write is pending, and a second event at cost 0.02 recorded, `snapshot()` reports `callCount` 2 and `totalCostUsd` 0.03.
- [unit] With `_costAggDeps.write` overridden so the first pass's write waits on a gate and the second pass's write throws: an event recorded while the first write is pending is contained in the text the next successful drain writes.
- [integration] The default `_costAggDeps.write(path, data)` into a temp directory where `path` already holds old text leaves `path` holding exactly `data` and no other file in that directory.

### US-005

- [unit] `dispatchCompleteHop` with a call that throws a `SessionTurnError` carrying `tokenUsage` `{ inputTokens: 100, outputTokens: 20 }` and `estimatedCostUsd` 0.05 returns `dispatched: false` and a result with that `tokenUsage` and `estimatedCostUsd` 0.05.
- [unit] `dispatchCompleteHop` with a call that throws a `SessionTurnError` carrying `tokenUsage` `{ inputTokens: 10, outputTokens: 1 }` and `exactCostUsd` 0.07 returns a result whose `exactCostUsd` is 0.07.
- [unit] `dispatchCompleteHop` with a call that throws a `NaxError` to which `attachTurnSpend` attached `{ tokenUsage: { inputTokens: 50, outputTokens: 5 }, costUsd: 0.02, costSource: "computed" }` returns a result with that `tokenUsage`, `estimatedCostUsd` 0.02 and no `exactCostUsd`.
- [unit] The same with `costSource: "reported"` returns `exactCostUsd` 0.02.
- [unit] `dispatchCompleteHop` with a call that throws a plain `Error` returns zero `tokenUsage`, `estimatedCostUsd` 0 and an `adapterFailure` from the injected classifier.
- [unit] `runComplete` over a fake backend whose turn times out after reporting `tokenUsage` `{ inputTokens: 30, outputTokens: 0 }` throws a `NaxError` with code `AGENT_TIMEOUT`, and `readTurnSpend` of that error returns that `tokenUsage`.
- [unit] `AgentManager.completeAs("claude", prompt, options)` with a single registered adapter whose `complete()` throws a `SessionTurnError` carrying `tokenUsage` `{ inputTokens: 100, outputTokens: 20 }`, `estimatedCostUsd` 0.05 and a non-retriable `adapterFailure`, and no fallback configured, emits one dispatch event (through `emitDispatch`) whose `tokenUsage` is `{ inputTokens: 100, outputTokens: 20 }` and `estimatedCostUsd` is 0.05.

### US-006

- [unit] `validatePlanOutput` on valid JSON PRD text whose first story description is the JSON string `"Path C:\\users and \\xampp"` returns that description as `Path C:\users and \xampp`.
- [unit] `validatePlanOutput` on valid JSON PRD text whose description is the JSON string `"\\x41 and \\u0041"` returns `\x41 and \u0041`.
- [unit] `validatePlanOutput` on PRD text whose description contains the invalid JSON escape `\x41` returns `A` in its place.
- [unit] `validatePlanOutput` on PRD text that is valid apart from a literal newline inside a string still parses, with the newline kept in that string.
- [unit] `validatePlanOutput` on text that is not JSON throws `NaxError` with code `SCHEMA_VALIDATION_FAILED`.

### US-007

- [unit] `fillScripts` for a single-package analysis missing `type-check`, where `readJson` returns `null` and `exists` returns `true` for the root `package.json`, never calls `writeFile`.
- [unit] In that case `fillScripts` calls `warn` once with `[setup] <workdir>/package.json could not be read as JSON; left unchanged`.
- [unit] `fillScripts` for a turbo monorepo analysis where `turbo.json` exists but `readJson` returns `null` for it does not write `turbo.json`, does not write the root `package.json` passthrough script `turbo run type-check`, and still writes each member `package.json` that parsed.
- [unit] `fillScripts` where `readJson` returns `null` and `exists` returns `false` for the root `package.json` writes a `package.json` whose `scripts.type-check` is `tsc --noEmit -p tsconfig.json`.
- [integration] `fillScripts` on a temp directory whose `package.json` holds `{ "name": "my-app", "version": "1.2.3", }` (a trailing comma) leaves that file byte-for-byte unchanged.
- [unit] `setupCommand` with `fillScripts: true`, `_setupDeps.stderr` captured and `_setupDeps.fillScripts` stubbed to call its third argument with `"x"`, writes `x` to the captured stderr and returns exit code 0.
