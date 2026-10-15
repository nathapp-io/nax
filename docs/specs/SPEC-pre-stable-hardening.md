# SPEC: Pre-stable Hardening

Closes: #2539, #2540, #2534, #2533, #2517, #2538, #2530

## Summary

Seven fixes that land before the stable 0.88.0 release, where workflow mode becomes the default. The
`.nax` state guard lets an agent restore a stash it was allowed to make, and accepts directory
pathspecs (#2539). The workflow implementer prompt asks for the failing run before the
implementation, and the story review accepts an honest "not captured" note (#2540). The advisor
ledger is committed even when a broad `.gitignore` rule hides it, precheck and `nax init` name the
rule, and a failed ledger commit is reported loudly (#2534). `prd.json` is committed after every
story status write, so the next story starts on a clean tree (#2533). MCP server instructions, plus an
optional per-server config text, reach native and ACP sessions (#2517). A project can let sandboxed
commands reach loopback ports, for native srt and ACP Claude sessions alike (#2538). A project can
declare an `e2e` command, with an optional `e2eSetup`, that nax runs on the host as a repository gate
and that agents can run through `RunCommand` (#2530).

## Motivation

- **#2539:** the guard allows `git stash push -- <files>` but refuses every `pop` / `apply`. Tool
  audit for 2026-10-14..15 shows 79 `git stash` calls in workflow implementer and branch-fix sessions,
  37 of them denied; each round costs 2-4 turns while the agent recovers through
  `git checkout stash@{0} -- <files>`, which is allowed and replays the same content.
- **#2540:** the cause of most of those stashes. The implementer prompt demands a failing run per AC,
  and implementers that wrote test and code together fake it afterwards by stashing their own
  implementation.
- **#2534:** `commitLedger` runs `git add -- <ledger>`. In repos whose `.gitignore` predates the
  ledger (`.nax/**/*.jsonl` in 6 of 9 local repos), the add fails, publishing continues, and the PR
  ships without the advisor rulings its body cites. The only signal is one warn line.
- **#2533:** the completion stage writes `prd.json` but never commits it. The next story's agent sees
  a modified file it did not touch, the next `autoCommitIfDirty` sweeps the status change into the
  wrong story's commit, and a stray `git checkout .` resets finished stories to `pending` (#2490).
- **#2517:** nax forwards each MCP tool's description and schema, but drops the server's
  `initialize` instructions and offers no config field for a repo hint. A branch reviewer called
  codebase-memory with a guessed `project` value, failed, and never recovered.
- **#2538:** on macOS with a restricted network (`execution.sandbox.network.allowedDomains` set), srt
  confines sandboxed commands to its proxy ports, so a DB-backed test run in Bash gets `connection refused` from a test database that is up. srt's `allowLocalBinding` fixes
  it; nax has no way to set it.
- **#2530:** Chromium cannot launch inside srt on macOS: its `bootstrap_check_in` Mach service
  registration is denied. srt 0.0.79 (latest, 2026-10-07) still allows only `mach-lookup` rules,
  so no setting enables it. E2e journeys therefore ship unexecuted. The fix runs them on the host.

## Design

### Approach

1. **Stash restore (#2539).** The new logic lives in a new `src/tools/nax-stash-restore.ts`
   (`nax-state-guard.ts` is 514 of 600 lines); `stashRefusal` stays a thin dispatch into it.
   - A new `_naxStateGuardDeps.git(cwd, args)` runs git synchronously through `spawnSync` from
     `node:child_process` with `env: gitSpawnEnv()` and `timeout: GIT_TIMEOUT_MS`, and `maxBuffer: 16 * 1024 * 1024`, and returns stdout
     on exit 0, `undefined` otherwise (spawn error, timeout, non-zero exit). nax-agent `src/` has no
     `spawnSync` today; `Bun.*` is banned there by `check:no-bun-apis`, and every git argv must use
     `gitSpawnEnv` for `check-git-spawn-env`.
   - `pop` and `apply` are allowed when the stash holds no `.nax` path. Accepted grammar after the
     subcommand: `[--index] [-q|--quiet] [<ref>]`, where `<ref>` matches `^stash@\{\d+\}$` or `^\d+$`;
     default `stash@{0}`. Any other flag or operand refuses without calling git.
   - The listing is `git stash show -z --name-only --no-renames --include-untracked <ref>`, split on
     NUL. `-z` keeps non-ASCII paths unquoted, and `--no-renames` reports a moved `.nax` file as a
     deletion under `.nax`. A path refuses when any `/`-separated segment equals `.nax`.
   - Every working-directory frame (`ctx.frames`, after `-C` / `--work-tree` handling) must list
     successfully and clean; a `git` result of `undefined` from any frame refuses.
   - `push` additionally accepts a directory pathspec after `--`: an existing directory (`lstat`, not a
     symlink), not under `.nax`, for which
     `git ls-files -z --cached --others -- <dir>` (no exclude rules, so ignored files are listed)
     succeeds from every frame and lists no path with a `.nax` segment. This replaces the bounded
     `scanNaxDirs` walk for the allow decision.
   - A shell tokenizer split: `naxStateRefusalInText` ends a segment at `{` and `}`, so an unquoted
     `git stash pop stash@{1}` reaches the guard as ref `stash@`, which fails the grammar and is
     refused. The quoted form `'stash@{1}'` is allowed. `STASH_REFUSAL` says to quote the ref.
   - `STASH_REFUSAL` is rewritten. It keeps the `git diff HEAD -- <file>` / `git show HEAD:<file>`
     sentence, drops "named regular files", and states: "`push` of files or directories outside `.nax`
     is allowed, and so is `pop` or `apply` of a stash that holds no `.nax` path (quote the ref, e.g.
     `'stash@{1}'`)."
2. **RED evidence (#2540).** `buildWorkflowImplementPrompt`'s step 1 becomes: "TDD for every
   acceptance criterion: write the test, run it, and capture the failing run before you write the
   implementation for that criterion; then write the code and capture the passing run. Never stash,
   revert, move or copy aside implementation files to produce a failing run afterwards." Its **TDD
   evidence** report bullet is rewritten to: "for each AC, the failing run and the passing run (command
   and the relevant output lines). If you did not capture the failing run, say so under **Decisions &
   assumptions**; then evidence that the test exercises the new code path is acceptable. Missing evidence
   without that note, or a test that asserts nothing, fails review." `buildWorkflowStoryReviewPrompt`'s
   spec verdict sentence becomes "missing evidence for an AC (other than an honest not-captured note),
   or a test that asserts nothing, is a spec failure", followed by: "A report that says the failing run was not captured is not a spec
   failure when the test exercises the new code path. A failing run produced by reverting or stashing
   the implementation is a finding."
3. **Ledger (#2534).**
   - `commitLedger` (workflow) runs `git add -f -- <exact ledger path>`; so does the ledger `add` in
     `finish/advise.ts`.
   - `findIgnoredNaxTrackedPaths(projectDir)` (new, `src/utils/ignored-nax-paths.ts`) checks the
     ledger, `spec.md` and `prd.json` paths for a probe feature id, built with `ledgerPath` and
     `featureDir` from `@/config` / `@/advisor`, through `git check-ignore -v --no-index -- <paths>` (no `-z`: git refuses `-z` without `--stdin`)
     run by `gitWithTimeout` behind `_ignoredNaxPathsDeps.git`. Each output line is
     `<source>:<line>:<pattern><TAB><path>`; it returns `{ path, rule }` per line whose pattern does not
     start with `!` (a negation means the path is re-included), with `rule` = `<source>:<line>:<pattern>`. A
     non-zero exit other than 1 ("nothing ignored"), or a spawn failure, returns `[]`.
   - `checkGitignoreCoversNax` (precheck) fails with a message naming each path, its rule, and the
     fix: add `!.nax/features/*/<file>`, or replace a wholesale `features/*/` rule, because a negation
     cannot re-include under an ignored directory. `nax init` logs the same text as one `warn` per path
     after patching `.gitignore`.
   - `ledgerCommit` in `workflow/finalize.ts` returns a result
     `{ committed: boolean; missingRulings: number }`; `pushLedger` reads `.committed`. When `commitLedger` throws and the ledger has
     N > 0 non-empty lines, it logs one `warn` "Advisor ledger commit failed — the branch is missing N
     advisor rulings" and returns `missingRulings: N`. The first ledger commit of each publishing mode
     (`none`, local-only, `push`, `pr`) appends the readiness reason
     `advisor ledger not committed: the branch is missing N advisor rulings` to that mode's reasons, so
     the PR stays a draft and the advisor is not asked. `pushLedger`'s second commit only logs.
     `finish/advise.ts` ignores git exit codes today; only the workflow path gets the loud signal.
4. **PRD commit (#2533).**
   - `commitPrdProgress({ prdPath, feature, storyId, label })` (new, `src/prd/progress-commit.ts`,
     exported from `@/prd`) runs git through `_prdCommitDeps.git` (`gitWithTimeout`) with
     `cwd = dirname(prdPath)` and pathspec `basename(prdPath)`: `git add -- <prd>`; when
     `git diff --cached --quiet -- <prd>` exits 0 it returns `false`; else
     `git commit --no-verify -m "chore(<feature>): progress <storyId> <label>" -- <prd>`. No
     `[skip ci]`, for the reason `commitLedger` gives. A failed `add` because the PRD is ignored
     returns `false` silently (checked first with `git check-ignore -q -- <prd>`, exit 0 = ignored);
     any other git failure logs one `warn` with the story id and returns `false`. It never throws.
   - `savePrdProgress(prd, prdPath, storyId, label)` (new, `src/prd/progress-commit.ts`) calls
     `savePRD` and then `commitPrdProgress` with `feature: prd.feature`; call sites replace their
     `savePRD` line with it, one line for one line, because `execution/pipeline-result-handler.ts` is
     598 of the 600-line source limit and must not grow.
   - Call sites and labels: the completion stage keeps its `_completionDeps.savePRD` call and, right
     after it and only when `persistPrd`, calls a new `_completionDeps.commitPrdProgress` (`passed`); `handlePipelineFailure` `pause` (`paused`) and `fail`
     (`failed`); `failStoryAfterMerge` (`failed`); `queueCheckStage` ABORT (`aborted`, story id
     `_run`), RETRY (`retry`), PRIORITY (`priority`), INJECT (`inject`) and SKIP (`skipped`), through
     a new `_queueCheckDeps.savePrdProgress`. `pipeline-result-handler.ts` reaches it through a new
     `_resultHandlerDeps.savePrdProgress`.
5. **MCP instructions (#2517).**
   - nax-agent: `connectMcp` reads `client.getInstructions()` after the tool listing and sets
     `McpConnection.instructions` only for a non-empty string. `ToolProvider` gains an optional
     `instructions(workdir)`. `resolveProviderTools` calls it only for an attached provider that
     contributed at least one tool after `admits`, with the same `workdir` it passed to `tools`, and
     returns the non-empty results as `ResolvedProviderTools.instructions` (absent when none). A
     throwing `instructions()` logs `warn` and the provider's tools stay advertised.
   - nax-agent: `renderProviderInstructions(entries)` builds the section. Each text first has control
     characters U+0000-U+001F (except `\n` and `\t`) and U+007F stripped, close to `sanitizeProviderTools`' treatment of a
     discovered description, but keeping line breaks and tabs. Then each server's text is capped at
     `MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER = 2000` characters (a cut text ends with `…(truncated)`),
     then servers are appended in order while the running total of rendered server blocks stays within
     `MCP_INSTRUCTIONS_MAX_CHARS_TOTAL = 6000`; servers that do not fit are omitted and the section ends
     with `(instructions omitted for N more MCP server(s))`. Per-server <= total, so the first server
     always fits. Output: `## MCP servers` then, per server, a blank line, `### <providerId>`, and the text.
   - nax-agent: `OpenSessionOpts.providerInstructions?: string`. The native session folds it into the session's
     existing `systemPrompts` entry at open (`recordSystemPrompt` records `[systemPrompt,
     providerInstructions]` joined by a blank line, or the instructions alone), so no new state map is
     added (`session-adapter.test.ts` asserts every state collection holds the session).
     `buildCodingToolSupport` accepts `providerInstructions` and returns it on `CodingToolSupport`.
     `BackendOpenContext` gains `providerInstructions?: string`.
   - nax: `mcp.servers.<id>.instructions` (non-empty string, `.strict()` kept). nax's own
     `McpConnection` gains `instructions?: string`, forwarded by `connectMcpServer` from the nax-agent
     connection; `McpPool.instructions(serverId, workdir)` reads it from the same pooled entry
     `listTools` uses. The provider's `instructions(workdir)` returns the pool text, then the config text
     after a blank line, with every `{workdir}` in the config text replaced by `workdir`. On the first
     `tools(workdir)` listing per server id, when that combined text names (as a whole word) a tool the
     server lists but `allowedTools` withholds, it logs one `warn` naming the tool.
   - nax: `resolveCodingToolSupport` renders `providerResult.instructions` with
     `renderProviderInstructions`, passes the text to `buildCodingToolSupport`, and logs one `info` on
     the `mcp` channel with the provider ids and the rendered length. `OpenSessionRequest` gains
     `providerInstructions`; `build-hop-callback-hop.ts` copies it from the coding-tool support;
     `openSessionExtras` forwards it to `OpenSessionOpts`.
   - ACP: nax's `openContext` sets `BackendOpenContext.providerInstructions` from
     `opts.providerInstructions` only when `finalizeAcpSurface` delivered at least one tool. The
     nax-agent-acp backend's `toolHostFor` passes `ctx.providerInstructions` to
     `createToolHost(calls, token, { instructions })`, and `serveMcp` constructs its `Server` with
     `instructions` when set, so the ACP agent's MCP client receives it in `initialize`.
6. **Loopback (#2538).** `execution.sandbox.network.allowLocalBinding` (optional boolean; absent means
   off). It only changes anything with an `allowedDomains` list: with an open network srt's macOS
   profile already allows all network traffic, loopback included. srt reads `allowLocalBinding` only from the process-wide `SandboxManager.initialize` config
   (sandbox-runtime 0.0.77 `sandbox-manager.js` `getAllowLocalBinding`), never from a per-command
   `customConfig`. So `createSrtBackend(network)` passes it to `initialize` through
   `srtNetwork(allowedDomains, allowLocalBinding)`, and `customConfig` is unchanged.
   `srtNetwork(undefined, true)` returns the open-network object plus `allowLocalBinding: true`.
   `buildSandboxPolicy` sets `network.allowLocalBinding: true` on the policy when the config is
   `true`, for the ACP Claude sandbox, whose `claudeSandboxOptions` sends
   `network.allowLocalBinding: true` (with `allowedDomains` when the policy has them).
7. **E2e gate (#2530).**
   - `quality.commands.e2e` and `quality.commands.e2eSetup` (both `QualityCommandSpecSchema`,
     optional, layerable per package like the other keys).
   - `GATE_ORDER` becomes `build, typecheck, lint, test, e2e`. `GateCommand` gains an optional
     `setup`; `resolveGateCommands` attaches the same layer's `e2eSetup` to that layer's `e2e` gate and
     includes `setup` in its dedupe key. `e2eSetup` without `e2e` produces no gate.
   - `runQualityGates` runs a gate's `setup` first, through `_qualityGateDeps.run` with the gate's
     `cwd`, the same timeout and `commandName` `<name>:setup`. A non-zero setup exit marks the gate
     failing without running its command; the chunk is `[<name>] exit=<setup exit>` then
     `setup failed:` and the setup output.
   - Workflow repo gates (`runRepoGates`, used for repo-gates and final gates) and pipeline finish
     (`finish/gates-loop.ts`) reach e2e through these two functions, on the host.
   - Agents: `extractDispatchConfigFields` drops `e2eSetup` from `commands`, so `RunCommand` never
     offers it; `e2e` stays declared and joins `SUITE_COMMAND_NAMES` for the full-suite timeout.
   - Prompts: `buildWorkflowImplementPrompt` and `buildWorkflowStoryReviewPrompt` accept
     `e2eGate?: boolean`. Implementer text when true: "Browser e2e tests cannot launch inside the Bash
     sandbox. Run the e2e suite only with `RunCommand {"command":"e2e"}`; nax also runs it as a
     repository gate once every story is done." Story review text when true: "nax runs the e2e suite
     as a repository gate on the host; do not list e2e journeys in cannotVerify." Callers pass
     `e2eGate: sc.config.quality?.commands?.e2e !== undefined`: `promptFor`'s `implement` arm and its
     fresh `restart` arm, and `runStoryReview`.

### Integration

Symbols the feature only reads:

- `naxStateRefusalInText(command, ctx)` and `screenRawBashCommand` (nax-agent tools); `NaxGuardContext`.
- `gitSpawnEnv()` (`packages/nax-agent/src/internal/git-env.ts`); `GIT_TIMEOUT_MS`
  (`packages/nax-agent/src/internal/git-exec.ts`).
- `ledgerPath(projectDir, feature)` from `@/advisor`; `featureDir` from `@/config`;
  `ledgerCommitMessage(feature)` and `gitWithTimeout` (nax).
- `savePRD(prd, path)` from `@/prd`.
- `providerAttachesTo`, `sanitizeProviderTools`, `adaptProviderTool` (nax-agent tool provider modules).
- `finalizeAcpSurface` (`packages/nax/src/agents/acp/provider-embedder.ts`).
- `runQualityCommand` from `@/quality`; `QualityCommandSpecSchema`.
- `NAX_GITIGNORE_ENTRIES` and `patchIgnoreFile` (`packages/nax/src/utils/gitignore.ts`).

Symbols the feature changes. The baseline only locates the code; implement the target.

- `stashRefusal(args, ctx)` (`packages/nax-agent/src/tools/nax-state-guard.ts`). Baseline: refuses all
  but `STASH_SAFE_SUBCOMMANDS` and an exempt `push`. Target: Approach 1.
- `isPlainFileOutsideNax(spec, ctx)`. Target: also accepts a directory per Approach 1 (may be renamed).
- `STASH_REFUSAL`. Target text: Approach 1.
- `commitLedger(projectDir, feature)` (`packages/nax/src/workflow/git.ts`). Target: `add -f`.
- `ledgerCommit(fc)` (`packages/nax/src/workflow/finalize.ts`). Baseline returns `boolean`. Target
  returns `{ committed, missingRulings }`.
- `checkGitignoreCoversNax(workdir)` (`packages/nax/src/precheck/checks-warnings.ts`).
- `_completionDeps` (`packages/nax/src/pipeline/stages/completion.ts`). Target adds `commitPrdProgress`.
- `_resultHandlerDeps` (`packages/nax/src/execution/pipeline-result-handler.ts`). Target adds `savePrdProgress`.
- `queueCheckStage` (`packages/nax/src/pipeline/stages/queue-check.ts`). Target: a new exported
  `_queueCheckDeps = { savePrdProgress }`.
- `McpConnection` (`packages/nax-agent/src/mcp/types.ts`) and nax's `McpConnection`
  (`packages/nax/src/mcp/types.ts`). Target adds `readonly instructions?: string` to each.
- `connectMcpServer` (`packages/nax/src/mcp/client.ts`). Target forwards `instructions`.
- `McpPool` (`packages/nax/src/mcp/pool.ts`). Target adds an optional `instructions?(serverId, workdir)`
  (optional so hand-built `McpPool` fixtures still typecheck; the provider treats it as absent text).
- `ToolProvider` (`packages/nax-agent/src/tools/provider-types.ts`). Target adds
  `instructions?(workdir: string): Promise<string | undefined>`.
- `ResolvedProviderTools` (`packages/nax-agent/src/tools/provider-advertise.ts`). Target adds
  `readonly instructions?: readonly { providerId: string; text: string }[]`.
- `OpenSessionOpts` (`packages/nax-agent/src/session/session-types.ts`), `BackendOpenContext`
  (`packages/nax-agent/src/session/session-backend.ts`), `CodingToolSupport` and
  `buildCodingToolSupport` args (`packages/nax-agent/src/coding-tools/coding-tool-support.ts`). Target
  adds `providerInstructions?: string` to each.
- `openNativeSession` / `recordSystemPrompt` (`packages/nax-agent/src/native/session/session.ts`).
  Target: Approach 5 (no new `NativeSessionState` field).
- `OpenSessionRequest` (`packages/nax/src/session/types.ts`) and `openSessionExtras`
  (`packages/nax/src/session/open-session-extras.ts`). Target adds and forwards `providerInstructions`.
- `openContext` (`packages/nax/src/agents/acp/open-context.ts`). Baseline sets no provider
  instructions. Target: Approach 5.
- `resolveCodingToolSupport` (`packages/nax/src/agents/coding-tool-support-resolve.ts`).
- `toolHostFor` (`packages/nax-agent-acp/src/client/backend.ts`), `createToolHost(calls, token)` and
  `serveMcp` (`packages/nax-agent-acp/src/client/tool-host.ts`). Target:
  `createToolHost(calls, token, opts?: { instructions?: string })`.
- `claudeSandboxOptions(policy)` (`packages/nax-agent-acp/src/client/claude-sandbox.ts`).
- `SandboxConfigSchema.network` (`packages/nax-agent/src/config/schemas-sandbox.ts`) and
  `SandboxNetworkPolicy` (`packages/nax-agent/src/sandbox/types.ts`). Target adds `allowLocalBinding`
  (schema: optional boolean; policy: `allowLocalBinding?: true`).
- `srtNetwork(allowedDomains)` (`packages/nax-agent/src/sandbox/srt-backend.ts`). Target:
  `srtNetwork(allowedDomains, allowLocalBinding)`.
- `McpServerSchema` (`packages/nax/src/config/schemas-mcp.ts`) and the hand-written `McpServerConfig`
  interface (`packages/nax/src/config/runtime-types-mcp.ts`). Target adds `instructions` (schema:
  `z.string().min(1).optional()`; interface: `instructions?: string`).
- `QualityConfigSchema.commands` (`packages/nax/src/config/schemas-execution.ts`) and the hand-written
  `QualityConfig.commands` (`packages/nax/src/config/runtime-types.ts`). Target adds `e2e?`, `e2eSetup?` to both.
- `GATE_ORDER`, `GateCommand`, `resolveGateCommands`, `runQualityGates`
  (`packages/nax/src/finish/gates/quality.ts`).
- `extractDispatchConfigFields`, `SUITE_COMMAND_NAMES` (`packages/nax/src/agents/dispatch-config-fields.ts`).
- `buildWorkflowImplementPrompt`, `buildWorkflowStoryReviewPrompt`; `promptFor`
  (`packages/nax/src/workflow/implement.ts`); `runStoryReview` (`packages/nax/src/workflow/story-review.ts`).

New skeleton (no precedent: nax-agent `src/` has no synchronous git spawn today):

```ts
import { spawnSync } from "node:child_process";
import { gitSpawnEnv } from "#src/internal/git-env";
import { GIT_TIMEOUT_MS } from "#src/internal/git-exec";

// packages/nax-agent/src/tools/nax-stash-restore.ts
export const _naxStateGuardDeps = {
  /** stdout of `git <args>` run in `cwd`, or undefined on a spawn error, timeout or non-zero exit. */
  git(cwd: string, args: readonly string[]): string | undefined {
    const out = spawnSync("git", [...args], { cwd, env: gitSpawnEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
    return out.status === 0 && out.error === undefined ? out.stdout : undefined;
  },
};
```

### Failure Handling

| Failure | Behaviour |
|---|---|
| The guard's git listing fails for a `pop`/`apply` ref or a `push` directory, from any frame | Refused with `STASH_REFUSAL`. |
| `commitLedger` throws in a workflow publishing mode | Publishing continues; the warn and the readiness reason name the missing ruling count (Approach 3). |
| `git check-ignore` fails (not a repo, git missing) | `findIgnoredNaxTrackedPaths` returns `[]`; no warning. |
| A `commitPrdProgress` git step fails | One `warn` with the story id; returns `false`; the story outcome is unchanged. |
| A provider's `instructions()` throws | One `warn`; the provider's tools stay advertised; no instructions entry for it. |
| `client.getInstructions()` returns `undefined`, a non-string or `""` | `McpConnection.instructions` is absent. |
| `e2eSetup` exits non-zero | The `e2e` gate fails without running `e2e` (Approach 7). |

## Out of Scope

- Bumping `@anthropic-ai/sandbox-runtime` past 0.0.77. srt 0.0.79 still has no Mach service registration rule, so a bump would not let Chromium launch inside the sandbox.
- Running e2e inside an agent's Bash sandbox, or an unsandboxed Bash allowlist for `playwright test`.
- A blocking host-side pre-run setup step for the whole run (#2521); `e2eSetup` runs only before the `e2e` gate.
- A per-port loopback grant; srt grants every loopback port when `allowLocalBinding` is on.
- A per-package `allowLocalBinding`: srt reads it once per process, so the first backend's value applies to the whole run.
- Linux behaviour of `allowLocalBinding` (bwrap uses its own network namespace); the flag is passed through unverified there.
- US-004 only: verifying against the Claude Agent SDK that `SandboxSettings.network.allowLocalBinding` is honoured; US-004 pins only the options nax sends.
- US-001 only: allowing `pop`/`apply` of a stash that touches `.nax`, `git stash branch`, `stash save`, or an unquoted `stash@{N}` ref; they stay refused.
- Pinning MCP server instructions in `.nax/mcp-lock.json`; the text is sanitised for control characters and capped, not locked.
- Filtering MCP instructions per tool after deny or ask rules; a provider with at least one advertised tool gets its instructions delivered.
- Substituting `{workdir}` in the server's own instructions; only the config text is substituted.
- Recording MCP instructions in prompt-audit; the `info` attach log line is the visibility signal.
- MCP instructions on nax-agent's own `createAgentSession` path (the nax-agent ACP server); only nax's sessions get them.
- Removing broad `.gitignore` rules automatically; precheck and `nax init` only report them.
- A loud failed-ledger signal in pipeline-mode finish (`finish/advise.ts`), which ignores git exit codes today.
- A dry-run-specific branch in `commitPrdProgress`.
- Committing `prd.json` from the parallel worktree executor; its unified executor stays the single writer.
- E2e result parsing into per-test findings; a red e2e gate carries the output tail like every repo gate.
- MCP instructions for sessions opened by `runtime/session-run-hop.ts` outside the op hop path; only `build-hop-callback-hop.ts` hops carry them.
- Rewording the guard's backstop refusal: a stash command whose git invocation the guard cannot classify (`time git stash pop`) is still refused with `STASH_REFUSAL`.
- Changing the workflow fix prompt's TDD wording; only the implement and fresh restart prompts change.

## Stories

### US-001 — Stash restore in the .nax guard

Workdir: `packages/nax-agent`

No dependencies.

`pop`/`apply` of a stash with no `.nax` path, `push` of a directory with no `.nax` path, the git dep,
and the new `STASH_REFUSAL` (#2539).

### US-002 — Loopback opt-in for the sandbox

Workdir: `packages/nax-agent`

No dependencies.

`execution.sandbox.network.allowLocalBinding` through `buildSandboxPolicy` and srt's
`initialize` network (#2538).

### US-003 — MCP server instructions in nax-agent

Workdir: `packages/nax-agent`

No dependencies.

`McpConnection.instructions`, `ToolProvider.instructions`, `ResolvedProviderTools.instructions`,
`renderProviderInstructions`, `OpenSessionOpts` / `BackendOpenContext` / `CodingToolSupport`
`providerInstructions`, and the native system field (#2517).

### US-004 — ACP bridge instructions and Claude loopback

Workdir: `packages/nax-agent-acp`

Depends on US-002, US-003.

`createToolHost` instructions, `toolHostFor` passing them, `claudeSandboxOptions` loopback.

### US-005 — MCP instructions config and delivery in nax

Workdir: `packages/nax`

Depends on US-003.

`mcp.servers.<id>.instructions`, nax's `McpConnection` and `McpPool.instructions`, the provider's
`instructions(workdir)`, the withheld-tool warning, `resolveCodingToolSupport` rendering, and
`providerInstructions` through the open request, `openSessionExtras` and `openContext`.

### US-006 — Commit prd.json after each status write

Workdir: `packages/nax`

No dependencies.

`commitPrdProgress`, `savePrdProgress`, and the completion, result-handler and queue-check call sites (#2533).

### US-007 — Commit the ledger and report hidden nax files

Workdir: `packages/nax`

No dependencies.

`add -f` in both ledger commits, `findIgnoredNaxTrackedPaths` in precheck and `nax init`, and the
missing-rulings warn and readiness reason (#2534).

### US-008 — Host-side e2e gate

Workdir: `packages/nax`

No dependencies.

`quality.commands.e2e` / `e2eSetup`, `GATE_ORDER` and `GateCommand.setup`, setup-then-command in
`runQualityGates`, `e2eSetup` hidden from `RunCommand`, `e2e` given the suite timeout (#2530).

### US-009 — Workflow prompts: failing-run rule and e2e awareness

Workdir: `packages/nax`

Depends on US-008.

The implementer and story review prompts gain the failing-run rule (#2540) and the e2e lines; the
workflow callers pass `e2eGate`.

Story split rationale: `maxAcCount` is 24 atomic assertions; one package per story. Nine stories is
over the usual seven: the user asked for all seven issues in one bundle, and the review split the
stash/loopback and PRD/ledger pairs to keep each story within the AC cap.

### Context Files

**US-001**
- `packages/nax-agent/src/tools/nax-state-guard.ts`
- `packages/nax-agent/src/tools/nax-dirs.ts`
- `packages/nax-agent/src/internal/git-env.ts`
- `packages/nax-agent/test/unit/tools/nax-state-guard.test.ts`

**US-002**
- `packages/nax-agent/src/config/schemas-sandbox.ts`
- `packages/nax-agent/src/sandbox/policy-builder.ts`
- `packages/nax-agent/src/sandbox/srt-backend.ts`
- `packages/nax-agent/src/sandbox/types.ts`

**US-003**
- `packages/nax-agent/src/mcp/connect.ts`
- `packages/nax-agent/src/tools/provider-advertise.ts`
- `packages/nax-agent/src/tools/provider-sanitize.ts`
- `packages/nax-agent/src/native/session/session.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts`

**US-004**
- `packages/nax-agent-acp/src/client/tool-host.ts`
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/claude-sandbox.ts`

**US-005**
- `packages/nax/src/mcp/provider.ts`
- `packages/nax/src/mcp/pool.ts`
- `packages/nax/src/mcp/client.ts`
- `packages/nax/src/agents/coding-tool-support-resolve.ts`
- `packages/nax/src/agents/acp/open-context.ts`
- `packages/nax/src/config/runtime-types-mcp.ts`

**US-006**
- `packages/nax/src/pipeline/stages/completion.ts`
- `packages/nax/src/execution/pipeline-result-handler.ts`
- `packages/nax/src/pipeline/stages/queue-check.ts`
- `packages/nax/src/workflow/git.ts`

**US-007**
- `packages/nax/src/workflow/git.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/finish/advise.ts`
- `packages/nax/src/precheck/checks-warnings.ts`
- `packages/nax/src/cli/init.ts`

**US-008**
- `packages/nax/src/finish/gates/quality.ts`
- `packages/nax/src/workflow/repo-gates.ts`
- `packages/nax/src/agents/dispatch-config-fields.ts`
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/runtime-types.ts`

**US-009**
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts`
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts`
- `packages/nax/src/workflow/implement.ts`
- `packages/nax/src/workflow/story-review.ts`

### Creates

**US-001**
- `packages/nax-agent/src/tools/nax-stash-restore.ts` — the stash grammar, `_naxStateGuardDeps`, the listing and directory checks
- `packages/nax-agent/test/unit/tools/nax-state-guard-stash-restore.test.ts`
- `packages/nax-agent/test/integration/tools/nax-state-guard-stash-git.test.ts`

**US-002**
- `packages/nax-agent/test/unit/sandbox/allow-local-binding.test.ts`

**US-003**
- `packages/nax-agent/src/tools/provider-instructions.ts` — `renderProviderInstructions`, `MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER`, `MCP_INSTRUCTIONS_MAX_CHARS_TOTAL`, exported from the package entry
- `packages/nax-agent/test/unit/tools/provider-instructions.test.ts`

**US-004**
- `packages/nax-agent-acp/test/unit/client/tool-host-instructions.test.ts`

**US-005**
- `packages/nax/test/unit/mcp/provider-instructions.test.ts`

**US-006**
- `packages/nax/src/prd/progress-commit.ts` — `commitPrdProgress`, `savePrdProgress`, `_prdCommitDeps`, exported from `@/prd`
- `packages/nax/test/unit/prd/progress-commit.test.ts`
- `packages/nax/test/integration/prd/progress-commit-git.test.ts`

**US-007**
- `packages/nax/src/utils/ignored-nax-paths.ts` — `findIgnoredNaxTrackedPaths`, `_ignoredNaxPathsDeps`
- `packages/nax/test/unit/utils/ignored-nax-paths.test.ts`
- `packages/nax/test/integration/workflow/ledger-ignored.test.ts`

**US-008**
- `packages/nax/test/unit/finish/gates-quality-e2e.test.ts`

**US-009**
- `packages/nax/test/unit/prompts/workflow-red-evidence.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/test/unit/tools/nax-state-guard.test.ts` — the `stash` "denies %s when a .nax exists" table lists `"git stash push -- src"`, and `src` is a fixture directory with no `.nax` inside it, which US-001 allows. US-001 owns removing that one row (the allowance is pinned by US-001's own ACs) and stubbing `_naxStateGuardDeps.git` to return `undefined` in that file's `beforeEach`, restoring it in `afterEach`, so the `pop`, `apply` and `-c core.pager=x stash pop` rows stay refused without spawning git; every other row keeps its assertion that the refusal mentions `git diff HEAD` and `git show HEAD:`.

**US-003**
- `packages/nax-agent/api/nax-agent.api.txt` — the names-only public API snapshot compared by `check:api`. US-003 owns adding `renderProviderInstructions`, `MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER` and `MCP_INSTRUCTIONS_MAX_CHARS_TOTAL` to it (regenerated with the package's `api:update` script).

Otherwise none. `allowLocalBinding` is optional in the schema, so typed `SandboxConfig` fixtures still
typecheck; every new interface field and prompt input is optional; `finish/advise.test.ts` asserts
only the git verbs (`add`, `diff`, `commit`), which `-f` does not change; no gate fixture configures
`e2e`, so expected gate lists are unchanged.

### Seams

- `_naxStateGuardDeps.git` (US-001, new) is invoked by `naxStateRefusalInText` for a stash `pop` / `push` segment; US-001's ACs stub it and drive `naxStateRefusalInText` with raw command text.
- `SandboxPolicy.network.allowLocalBinding` (US-002) is consumed by `claudeSandboxOptions` (US-004); US-004's AC passes a policy built by `buildSandboxPolicy` with the config flag on.
- `ToolProvider.instructions` and `ResolvedProviderTools.instructions` (US-003) are produced by nax's MCP provider (US-005); US-005's AC drives `resolveCodingToolSupport` with a stub provider.
- `renderProviderInstructions` (US-003) is invoked by `resolveCodingToolSupport` (US-005).
- `OpenSessionOpts.providerInstructions` (US-003) is filled by `openSessionExtras` (US-005) and read by the native session (US-003); `BackendOpenContext.providerInstructions` (US-003) is filled by `openContext` (US-005) and read by `toolHostFor` (US-004).
- `commitPrdProgress` (US-006, new) is invoked through `_completionDeps`; `savePrdProgress` (US-006, new) through `_resultHandlerDeps` and `_queueCheckDeps`; US-006's ACs drive `completionStage.execute`, `handlePipelineFailure` and `queueCheckStage.execute`.
- `findIgnoredNaxTrackedPaths` (US-007, new) is invoked by `checkGitignoreCoversNax` and by `nax init`.
- `GateCommand.setup` (US-008) is produced by `resolveGateCommands` and consumed by `runQualityGates`; US-008's seam AC drives `runRepoGates`.
- `e2eGate` (US-009) is passed by `promptFor` (reached through the exported `runImplementerTurn`) and `runStoryReview`; US-009's ACs drive those two entry points.

## Acceptance Criteria

### US-001

- [unit] With a `.nax` directory in the fixture root and `_naxStateGuardDeps.git` stubbed to return `"src/a.ts\0"` for `stash show`, `naxStateRefusalInText("git stash pop", ctx)` returns `undefined`.
- [unit] With the same stub, `naxStateRefusalInText("git stash apply", ctx)` returns `undefined`.
- [unit] With the same stub, `naxStateRefusalInText("git stash pop", ctx)` calls the stub with args `["stash", "show", "-z", "--name-only", "--no-renames", "--include-untracked", "stash@{0}"]`.
- [unit] With the same stub, `naxStateRefusalInText("git stash pop --index 'stash@{1}'", ctx)` returns `undefined`.
- [unit] With the same stub, `naxStateRefusalInText("git stash pop --index 'stash@{1}'", ctx)` calls the stub with ref `stash@{1}`.
- [unit] With the same stub, `naxStateRefusalInText("git stash apply 2", ctx)` calls the stub with ref `2`.
- [unit] `naxStateRefusalInText("git stash pop stash@{1}", ctx)` (unquoted ref) returns a defined refusal.
- [unit] With the stub returning `"src/a.ts\0.nax/features/f/prd.json\0"`, `naxStateRefusalInText("git stash pop", ctx)` returns a defined refusal.
- [unit] With the stub returning `"pkg/.nax/status.json\0"`, `naxStateRefusalInText("git stash apply", ctx)` returns a defined refusal.
- [unit] With the stub returning `undefined`, `naxStateRefusalInText("git stash pop", ctx)` returns a defined refusal.
- [unit] With two frames where the stub returns `"src/a.ts\0"` for the first and `undefined` for the second, `naxStateRefusal` for `git stash pop` returns a defined refusal.
- [unit] `naxStateRefusalInText("git stash pop --hard-flag", ctx)` returns a defined refusal and does not call the stub.
- [unit] `naxStateRefusalInText("git stash pop 'stash@{0}' extra", ctx)` returns a defined refusal.
- [unit] `naxStateRefusalInText("git --future-flag x stash pop", ctx)` returns a defined refusal.
- [unit] With the stub returning `"src/a.ts\0"` for `ls-files`, `naxStateRefusalInText("git stash push -- src", ctx)` returns `undefined`.
- [unit] With the stub returning `"src/deep/a/b/c/.nax/prd.json\0"` for `ls-files`, `naxStateRefusalInText("git stash push -- src", ctx)` returns a defined refusal.
- [unit] `naxStateRefusalInText("git stash push -- .", ctx)` returns a defined refusal.
- [unit] `STASH_REFUSAL` does not include "named regular files".
- [unit] `STASH_REFUSAL` includes "`pop` or `apply` of a stash that holds no `.nax` path".
- [integration] In a real git repository with a committed `.nax/` directory, after `git stash push -- a.ts` of a modified `a.ts`, `naxStateRefusalInText("git stash pop", ctx)` with the default `_naxStateGuardDeps.git` returns `undefined`.
- [integration] In the same kind of repository, after stashing a modification to `.nax/features/f/é.json`, `naxStateRefusalInText("git stash pop", ctx)` returns a defined refusal.
- [integration] In the same kind of repository, after `git mv .nax/features/f/prd.json moved.json` and `git stash push`, `naxStateRefusalInText("git stash pop", ctx)` returns a defined refusal.

### US-002

- [unit] `SandboxConfigSchema.parse({})` yields a `network` with no `allowLocalBinding` value.
- [unit] `SandboxConfigSchema.parse({ network: { allowLocalBinding: true } })` yields `network.allowLocalBinding === true`.
- [unit] `buildSandboxPolicy` with `network: { allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true }` returns a policy whose `network` equals `{ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true }`.
- [unit] `buildSandboxPolicy` with `network: { allowLocalBinding: true }` returns a policy whose `network` equals `{ allowLocalBinding: true }`.
- [unit] `buildSandboxPolicy` with the default network returns a policy whose `network` has no `allowLocalBinding` key.
- [unit] An srt backend from `createSrtBackend({ allowedDomains: ["x.test"], allowLocalBinding: true })`, with `_srtBackendDeps.load` stubbed, passes `network.allowLocalBinding: true` to `SandboxManager.initialize` on its first `wrap`.
- [unit] An srt backend from `createSrtBackend({ allowLocalBinding: true })` passes an `initialize` network with no `allowedDomains` key and `allowLocalBinding: true`.
- [unit] An srt backend from `createSrtBackend({ allowedDomains: ["x.test"] })` passes an `initialize` network with no `allowLocalBinding` key.
- [unit] The `customConfig` passed to `wrapWithSandboxArgv` for a policy with `allowLocalBinding: true` has no `allowLocalBinding` key.

### US-003

- [integration] `connectMcp` against an in-process MCP server whose `initialize` result carries `instructions: "Call list_projects first"` returns a connection whose `instructions` is that text.
- [integration] `connectMcp` against a server with no `instructions` returns a connection whose `instructions` is `undefined`.
- [unit] `resolveProviderTools` with one attached provider advertising one tool, whose `instructions("/w")` resolves `"use repo root"`, returns `instructions` equal to `[{ providerId: <id>, text: "use repo root" }]`.
- [unit] `resolveProviderTools` calls the provider's `instructions` with the same `workdir` it passes to `tools`.
- [unit] `resolveProviderTools` for a provider whose stages do not attach never calls its `instructions`.
- [unit] `resolveProviderTools` for a provider left with zero tools by `admits` returns no `instructions` key.
- [unit] `resolveProviderTools` for a provider whose `instructions` resolves `""` returns no `instructions` key.
- [unit] `resolveProviderTools` for a provider whose `instructions` throws still returns that provider's tools.
- [unit] `renderProviderInstructions([{ providerId: "cm", text: "Call list_projects first" }])` returns `"## MCP servers\n\n### cm\nCall list_projects first"`.
- [unit] `renderProviderInstructions([])` returns `undefined`.
- [unit] `renderProviderInstructions` for a text containing `\u0007` and `\n` returns the text without `\u0007` and with the `\n`.
- [unit] `renderProviderInstructions` for one 2500-character text returns its first 2000 characters followed by `…(truncated)`.
- [unit] `renderProviderInstructions` for four servers of 1900 characters each includes the first three server headings.
- [unit] The same call ends with `(instructions omitted for 1 more MCP server(s))`.
- [unit] `MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER` is not greater than `MCP_INSTRUCTIONS_MAX_CHARS_TOTAL`.
- [unit] `systemFieldFor` for a native session opened with `systemPrompt: "BASE"` and `providerInstructions: "## MCP servers"` returns `{ system: "BASE\n\n## MCP servers" }`.
- [unit] `systemFieldFor` for a native session opened with `systemPrompt: "BASE"` and no `providerInstructions` returns `{ system: "BASE" }`.
- [unit] `systemFieldFor` for a native session opened with no `systemPrompt` and `providerInstructions: "## MCP servers"` returns `{ system: "## MCP servers" }`.
- [unit] `buildCodingToolSupport` given `providerInstructions: "X"` returns support whose `providerInstructions` is `"X"`.
- [unit] `buildCodingToolSupport` given no `providerInstructions` returns support with no `providerInstructions` key.

### US-004

- [integration] A tool host from `createToolHost(calls, token, { instructions: "Pass the repo root as project" })`, started and sent an MCP `initialize` request with its token, answers with `result.instructions` equal to that text.
- [integration] A tool host from `createToolHost(calls, token)` answers `initialize` with no `instructions` field.
- [unit] `toolHostFor` for a `BackendOpenContext` with `providerInstructions: "X"` and a token creates the tool host with `instructions: "X"` (stubbed `createToolHost` captures the options).
- [unit] `toolHostFor` for a context with no `providerInstructions` creates the tool host with no `instructions` option.
- [unit] `claudeSandboxOptions` for a policy whose `network` is `{ allowedDomains: ["x.test"], allowLocalBinding: true }` returns `network` equal to `{ allowedDomains: ["x.test"], allowLocalBinding: true }`.
- [unit] `claudeSandboxOptions` for a policy whose `network` is `{ allowLocalBinding: true }` returns `network` equal to `{ allowLocalBinding: true }`.
- [unit] `claudeSandboxOptions` for a policy whose `network` is `{}` returns no `network` key.
- [unit] `claudeSandboxOptions` for a policy from nax-agent's `buildSandboxPolicy` with `network.allowLocalBinding: true` returns `network.allowLocalBinding === true`.

### US-005

- [unit] `McpServerSchema.parse({ command: "x", instructions: "Pass {workdir} as project" })` keeps `instructions`.
- [unit] `McpServerSchema.parse({ command: "x", instruction: "typo" })` throws.
- [unit] `McpServerSchema.parse({ command: "x", instructions: "" })` throws.
- [unit] `connectMcpServer` over a stubbed nax-agent connection with `instructions: "S"` returns a nax `McpConnection` whose `instructions` is `"S"`.
- [unit] `McpPool.instructions(serverId, workdir)` returns the pooled connection's `instructions` and opens no second connection after `listTools` for the same server and workdir.
- [unit] `McpPool.instructions` returns `undefined` for a server whose connection failed.
- [unit] The provider from `createMcpProviders` for pool text `"Server text"` and config `instructions: "Pass {workdir} as project"` resolves `instructions("/repo/wt")` to `"Server text\n\nPass /repo/wt as project"`.
- [unit] The same provider without config `instructions` resolves `instructions("/w")` to `"Server text"`.
- [unit] A provider with no pool text and config `instructions: "Hint"` resolves `instructions("/w")` to `"Hint"`.
- [unit] A provider with neither resolves `instructions("/w")` to `undefined`.
- [unit] A server with pool text `"Call list_projects before initial use"`, `allowedTools: ["search_graph"]`, listing `list_projects` and `search_graph`, logs one `warn` naming `list_projects` on its first `tools()` call.
- [unit] The same server logs no second such `warn` on a later `tools()` call with another workdir.
- [unit] A server whose text names only allowed tools logs no such `warn`.
- [unit] `resolveCodingToolSupport` with an `unrestricted` profile and a stub provider that advertises one tool and returns instructions `"Use the repo root"` returns support whose `providerInstructions` equals `renderProviderInstructions([{ providerId: <id>, text: "Use the repo root" }])`.
- [unit] The same resolution logs one `info` on the `mcp` channel listing the provider id.
- [unit] `resolveCodingToolSupport` with no provider instructions returns support with no `providerInstructions` key.
- [unit] `openSessionExtras` with `providerInstructions: "X"` returns `providerInstructions: "X"`.
- [unit] `openSessionExtras` without `providerInstructions` returns no `providerInstructions` key.
- [unit] The hop open request from `build-hop-callback-hop.ts` carries `providerInstructions` from the coding-tool support (stubbed `sessionManager.openSession` captures the request).
- [unit] `openContext` for `OpenSessionOpts` with `providerInstructions: "X"` and a provider tool for a pre-approval-capable agent returns a context whose `providerInstructions` is `"X"`.
- [unit] `openContext` for the same options and an agent without a pre-approval channel returns a context with no `providerInstructions` key.

### US-006

- [integration] In a real git repository with a tracked `prd.json`, `commitPrdProgress` after a status change creates a commit whose message is `chore(f): progress US-001 passed`.
- [integration] The same commit contains only the PRD.
- [integration] The same call returns `true`.
- [integration] An unrelated staged edit stays staged and is absent from that commit.
- [integration] An unrelated unstaged edit stays unstaged and is absent from that commit.
- [integration] `commitPrdProgress` on an unchanged PRD returns `false` and creates no commit.
- [integration] `commitPrdProgress` on a PRD ignored by `.gitignore` returns `false` and logs no `warn`.
- [unit] `commitPrdProgress` passes `--no-verify` to `git commit` and no message containing `[skip ci]`.
- [unit] `commitPrdProgress` with `_prdCommitDeps.git` failing the commit step logs one `warn` with the story id and returns `false` without throwing.
- [unit] `savePrdProgress` calls `savePRD` before `commitPrdProgress`.
- [unit] `completionStage.execute` with `persistPrd` true calls `_completionDeps.commitPrdProgress` once, after `_completionDeps.savePRD`, with the story id and label `passed`.
- [unit] `completionStage.execute` with `ctx.skipPrdPersistence` true calls neither `_completionDeps.savePRD` nor `_completionDeps.commitPrdProgress`.
- [unit] `handlePipelineFailure` for a `fail` result calls `_resultHandlerDeps.savePrdProgress` with label `failed`.
- [unit] `handlePipelineFailure` for a `pause` result calls `_resultHandlerDeps.savePrdProgress` with label `paused`.
- [unit] `handlePipelineSuccess` with `storyIsolation: "worktree"` and `_resultHandlerDeps.mergeEngine.merge` stubbed to return `{ success: false, failureKind: "error" }` calls `_resultHandlerDeps.savePrdProgress` with label `failed`.
- [unit] `queueCheckStage.execute` handling a `SKIP` command for a story in the PRD calls `_queueCheckDeps.savePrdProgress` with that story id and label `skipped`.
- [unit] `queueCheckStage.execute` handling an `ABORT` command calls `_queueCheckDeps.savePrdProgress` with story id `_run` and label `aborted`.
- [unit] `queueCheckStage.execute` handling a `RETRY` command calls `_queueCheckDeps.savePrdProgress` with label `retry`.

### US-007

- [unit] `commitLedger` calls git with `["add", "-f", "--", <ledger path>]`.
- [integration] In a real git repository whose `.gitignore` contains `.nax/**/*.jsonl`, `commitLedger` commits `.nax/features/f/decisions.jsonl` and returns `true`.
- [integration] In the same repository an unrelated staged file stays staged and out of the ledger commit.
- [unit] The ledger commit in `finish/advise.ts` calls git `add` with `-f` before `--`.
- [integration] `findIgnoredNaxTrackedPaths` in a repository whose `.gitignore` has `**/.nax/features/*/` returns three entries, for the ledger, `spec.md` and `prd.json`.
- [integration] Each of those entries has a `rule` naming `.gitignore` and `**/.nax/features/*/`.
- [integration] `findIgnoredNaxTrackedPaths` in a repository whose `.gitignore` is exactly `NAX_GITIGNORE_ENTRIES` returns `[]`.
- [integration] `findIgnoredNaxTrackedPaths` in a repository whose `.gitignore` has `.nax/**/*.jsonl` and `!.nax/features/*/decisions.jsonl` returns `[]`.
- [unit] `findIgnoredNaxTrackedPaths` returns `[]` when `_ignoredNaxPathsDeps.git` exits 128.
- [unit] `checkGitignoreCoversNax` with one ignored ledger entry reported returns a failing check whose message names the rule.
- [unit] The same check's message includes `!.nax/features/*/decisions.jsonl`.
- [unit] `nax init` on a project where `findIgnoredNaxTrackedPaths` reports one entry logs one `warn` naming the path and rule.
- [unit] `publish` in `none` mode with `_featureDeps.commitLedger` throwing and a 3-line ledger logs a `warn` containing "the branch is missing 3 advisor rulings".
- [unit] The same `publish` returns reasons including `advisor ledger not committed: the branch is missing 3 advisor rulings`.
- [unit] `publish` in `pr` mode with `commitLedger` throwing and a 3-line ledger opens the PR as a draft and never calls the advisor's approval.
- [unit] `publish` in `push` mode with `commitLedger` throwing and a 3-line ledger returns reasons including the ledger reason.
- [unit] `publish` with no forge target, `commitLedger` throwing and a 3-line ledger returns reasons including the ledger reason.
- [unit] `publish` with `commitLedger` throwing and an empty ledger adds no ledger reason.

### US-008

- [unit] `QualityConfigSchema.parse({ commands: { e2e: "bunx playwright test", e2eSetup: "docker compose up -d" } })` keeps both keys.
- [unit] `resolveGateCommands` for root commands `test` and `e2e` returns gate names `["test", "e2e"]`.
- [unit] `resolveGateCommands` for root `e2e` and `e2eSetup` returns an `e2e` gate whose `setup` is the `e2eSetup` command.
- [unit] `resolveGateCommands` for root `e2eSetup` without `e2e` returns no gate named `e2e` or `e2eSetup`.
- [unit] `resolveGateCommands` for a package overlay setting `e2e` and `e2eSetup` returns an `e2e@<pkg>` gate with that overlay's `setup` and the package `cwd`.
- [unit] `resolveGateCommands` for a root and a package overlay with the same `e2e` command and cwd but different `e2eSetup` keeps both gates.
- [unit] `runQualityGates` for an `e2e` gate with a `setup` calls `_qualityGateDeps.run` for `e2e:setup` before `e2e`.
- [unit] Both of those calls use the gate's `cwd`.
- [unit] `runQualityGates` for an `e2e` gate whose setup exits 1 does not run the `e2e` command.
- [unit] The same run lists `e2e` in `failing` and its output chunk starts `[e2e] exit=1\nsetup failed:`.
- [unit] `runQualityGates` for an `e2e` gate whose command exits 1 after a passing setup lists `e2e` in `failing`.
- [unit] `runRepoGates` with stubbed `_qualityGateDeps` and a config declaring a failing `e2e` returns a finding whose issue starts `repo gate e2e failed:`.
- [unit] `extractDispatchConfigFields` for commands `{ test, e2e, e2eSetup }` returns `commands` without `e2eSetup`.
- [unit] The same call returns `commands` with `e2e`.
- [unit] The declared-command runner bound with the dispatch fields applies the full-suite timeout to a request naming `e2e`.

### US-009

- [unit] `buildWorkflowImplementPrompt` includes "capture the failing run before you write the implementation for that criterion".
- [unit] The same prompt includes "Never stash, revert, move or copy aside implementation files to produce a failing run afterwards".
- [unit] The same prompt includes "If you did not capture the failing run, say so under **Decisions & assumptions**".
- [unit] The same prompt includes "evidence that the test exercises the new code path is acceptable".
- [unit] `buildWorkflowStoryReviewPrompt` includes "A report that says the failing run was not captured is not a spec failure when the test exercises the new code path".
- [unit] The same story review prompt includes "A failing run produced by reverting or stashing the implementation is a finding".
- [unit] `buildWorkflowImplementPrompt` with `e2eGate: true` includes `RunCommand {"command":"e2e"}`.
- [unit] The same prompt includes "Browser e2e tests cannot launch inside the Bash sandbox".
- [unit] `buildWorkflowImplementPrompt` without `e2eGate` does not include `RunCommand {"command":"e2e"}`.
- [unit] `buildWorkflowStoryReviewPrompt` with `e2eGate: true` includes "do not list e2e journeys in cannotVerify".
- [unit] `buildWorkflowStoryReviewPrompt` without `e2eGate` does not include "e2e journeys".
- [unit] `runImplementerTurn` for an `implement` turn, with `sc.config.quality.commands.e2e` set, sends a prompt (stubbed `_workflowDeps.callOp` captures it) including `RunCommand {"command":"e2e"}`.
- [unit] `runImplementerTurn` for a fresh `restart` turn with the same config sends a prompt including `RunCommand {"command":"e2e"}`.
- [unit] `runImplementerTurn` for an `implement` turn with no `e2e` command sends a prompt without `RunCommand {"command":"e2e"}`.
- [unit] `runStoryReview` with `sc.config.quality.commands.e2e` set sends a prompt including "do not list e2e journeys in cannotVerify" (stubbed `callOp` captures it).
