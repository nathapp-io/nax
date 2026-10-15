<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Stable Hardening

Closes: #2550, #2551, #2552, #2553, #2554, #2555

## Summary

The last fixes before stable 0.88.0, where workflow mode becomes the default. They finish the 10-15
whole-repo review issues that #2556 and #2557 left partly open, and fix config warnings that never
reach the user.

- **Workflow publish (#2550):**
  - A green CI result counts only when it is for the pushed commit.
  - GitLab manual, scheduled and skipped pipelines stop waiting.
  - A resumed run does not reuse stale preflight or story-review state.
  - A draft caused only by unreadable CI or a failed PR update is re-published on the next run.
  - The repository's default branch is protected as a publish base.
  - Review coverage matches exact paths.
  - A base dependency's gate-open state is read across runs.
  - The missing tests are added.
- **Bash policy (#2551):** deny and ask rules match the canonical command, after assignments,
  wrappers, git global options and `sh -c` are unwrapped. The `.nax` run-state guard closes its
  remaining gaps.
- **Reviewer restore (#2552):** a failed working-tree snapshot falls back to restoring the
  snapshot's files, a held `index.lock` is waited for, and only paths a live keeper holds are exempt.
- **ACP server (#2553):** session locks become safe against pid reuse and racing takeovers. A
  session whose switch failed is retired. Reported cost stays cumulative across load, resume and
  restart. Session ids are validated. A write with no extractable target is treated as outside the
  write roots.
- **Gate resolution (#2554):** an empty command is no gate, and a package's `e2e` inherits the root
  `e2eSetup`.
- **Runtime (#2555):** MCP connects are cancelled by `pool.close()`. The ACP client kills the agent's
  whole process group even after the leader exited. The turn-retry backoff timer is cleared on
  abort.
- **Config warnings:** a warning raised while loading config before the logger starts, such as the
  `execution.mode "pipeline"` deprecation, is buffered and shown, never dropped.

## Motivation

- Every item was found in the 10-15 whole-repo review at `697cca226`. #2556 and #2557 fixed the
  urgent and pre-release items. Their PR bodies list what remains per issue, and this spec covers
  all of it, so the six issues close.
- **#2550:** each item lets the workflow mark a PR ready, or report success, on evidence it never
  saw:
  - a green from a previous push;
  - preflight answers for a different story set;
  - a re-review skipped on resume;
  - an unprotected default branch.
  A draft caused by a transient failure also stays a draft forever at the same HEAD.
- **#2551:** the sandbox is the real boundary, but in `gated` and `escalate` modes the policy
  approves commands it means to refuse (`env rm -rf x` passes a `rm *` deny). The `.nax` guard
  allows `git rm -rf .nax`, `git reset -- .nax`, `--autostash` and `git sparse-checkout set src`.
  The last of these deletes tracked `.nax/**` files, and the next auto-commit commits the deletions.
- **#2552:**
  - A reviewer that leaves huge or numerous untracked files makes the 30s `git add -A` snapshot
    time out, and the restore then reverts nothing.
  - The restore exempts every nested `.nax/features/` path, whether or not a keeper repairs it.
- **#2553:**
  - A reused pid holds a session lock forever.
  - Two servers can both win a takeover.
  - A release deletes another owner's lock.
  - A session whose switch failed is served as healthy.
  - Cost restarts at 0.
  - `session/delete` accepts `../x`.
- **#2554, #2555:**
  - `""` becomes a gate command.
  - Ctrl-C can block teardown about 51s per MCP server.
  - A crashed ACP agent's children survive a reconnect.
  - A retry backoff timer outlives an abort.
- **Config warnings:** `defaultConfigWarn` writes through `getLogger()`, which returns a no-op logger
  before `initLogger`. `nax run` loads its config at `bin/nax.ts:264` and starts its logger only at
  `bin/nax.ts:311`. On 0.88.0-canary.2 the `pipeline` deprecation from #2558 was verified never to
  appear. The removed-key and `&&`-chained quality command warnings use the same sink.

## Design

### Approach

1. **CI bound to the pushed commit (#2550 item 3).**
   - `waitForChecks` gains `opts.expectedSha?: string`. `waitForCi` (`workflow/finalize.ts`) reads
     it with `readHead(fc.projectDir)` after the push. When `readHead` throws, it logs one `warn` and
     calls `waitForChecks` without `expectedSha`, so no comparison is made. An empty `readHead`
     result is treated the same as no `expectedSha`.
   - **GitHub:** the existing `gh pr view <ref> --json ...` mergeability call in `githubWaiting`
     also requests `headRefOid`.
   - **GitLab:** `classifyGlab` reads `head_pipeline.sha`, else `pipeline.sha`.
   - A poll that would be `green` while the reported SHA differs from `expectedSha` is `waiting`,
     with detail `checks report <first 8 of reported> but HEAD is <first 8 of expected>`.
   - When the deadline passes while the latest poll was such a mismatch, the outcome is
     `unavailable` with that detail. `unavailable` is already a readiness reason.
   - A poll that reports no SHA, including a failed mergeability read, is compared to nothing.
2. **GitLab statuses (#2550 item 4).** In `classifyGlab`:
   - `skipped` is `green`, matching GitHub's `skipping`.
   - `manual` and `scheduled` end the wait at once as `unavailable`, with detail
     `pipeline is waiting on a <status> job`. `unavailable` is a readiness reason, so the PR stays
     a draft until a human runs the job.
   - Every other status keeps today's mapping.
3. **Preflight reuse (#2550 item 9a).** `PreflightFile` (`workflow/preflight.ts`) gains
   `storyIds: readonly string[]`, the stories the pre-flight covered. `runPreflight` writes it, and
   `isReusable` requires it, so a legacy file without it is never adopted.
   `adoptPriorPreflight(featureDir, runDir, storyIds)` copies the prior `preflight.json` only when
   its `storyIds` equal `storyIds` as a set.
   `runWorkflowPreflight` passes `pendingStoryIds(input.prd)`, so a prior pre-flight is reused,
   and its "Reusing the pre-flight of an earlier run" info line logged, only for the same story set.
4. **Story-loop `fixBase` on resume (#2550 item 9b).** `WorkflowStoryRecord` gains
   `fixBase?: string`. The loop persists it in the `update({ phase: "fix", round })` call made just
   before a fix turn (`story-loop.ts`), clears it in the record once the re-review ran, and restores
   it into `LoopState` on resume. A resumed story with open findings and a restored `fixBase` therefore
   re-reviews before any new fix turn.
5. **Transient drafts re-publish (#2550 item 9c).** In `runWorkflowFeature` (`workflow/feature.ts`),
   a prior `draft` at the current HEAD whose `ci` is `"unavailable"`, or whose `reasons` include one
   starting with `PR update failed:`, is not `already-finished`. The run resumes that record at the
   `publish` step, reusing its recorded repo gates and branch review, which still describe this
   HEAD. No review or fix agent step runs again. Any other `draft` at the same HEAD stays
   `already-finished`. `runFeatureMachine` already starts at `rec.step`; the change is in
   `startRecord`, which returns `{ ...prior, step: "publish" }` for such a prior instead of a fresh
   record. The prior's `startedAt`, `timings` and a `url` that publish does not replace carry over
   unchanged.
6. **Protected default branch (#2550 item 10).**
   - `readDefaultBranch(projectDir): Promise<string | undefined>` (new, `workflow/git.ts`) runs
     `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` and strips the leading `origin/`.
     It returns `undefined` on any failure.
   - `isPublishableBranch(branch, defaultBranch?)` also refuses `defaultBranch`. `publishTarget`
     reads it once per call.
7. **Review coverage (#2550 item 10).** `unreadFiles(required, inspected, repoRoot)`
   (`operations/workflow-review-coverage.ts`) gains the repo root. An absolute entry is made
   relative to `repoRoot` first, and an entry outside `repoRoot` covers nothing. `covers` then
   requires an exact match. Neither `packages/x/package.json` nor `/repo/packages/x/package.json`
   covers the root `package.json`. `isCompleteBranchVerdict(verdict, required, repoRoot)` threads
   it too. The branch-review op input (`operations/workflow-types.ts`) gains `repoRoot`, which
   `workflow/branch-review.ts` fills from `fc.projectDir` and also passes to its own
   `unreadFiles` call; the op's retry check passes `input.repoRoot`.
8. **Base dependencies across runs (#2550 item 10).** `redBaseDependencies` (`workflow/brief.ts`)
   reads each dependency's newest story record from `collectStoryRecords(dirname(sc.runDir))`. Run
   dirs sit side by side under that directory, so the read spans every run, instead of only the
   current run's `result.json`.
9. **Bash canonical matching (#2551 item 2).**
   - `canonicalSegments(segment: BashSegment): CanonicalResult` (new,
     `nax-agent/src/tools/bash-canonical.ts`) returns either `{ kind: "ok", segments }` or
     `{ kind: "refused", reason }`.
   - It applies these steps in order, repeating 1-3 until none applies:
     1. Drop a leading compound keyword: `if`, `then`, `else`, `elif`, `do`, `while`, `until`, `{`.
     2. Drop leading `NAME=value` assignment tokens.
     3. Drop a leading wrapper with its own options. The option table lives in
        `bash-canonical.ts`; the shared `commandHeadIndex` (`git-flags/locate.ts`, also used by the
        command-safety scorer and the state guard) is left unchanged. A dash option the table does
        not know, on a recognised wrapper, makes the result `refused`. The wrappers:
        - `env`: `-i`, `-u NAME`, `--`, and `NAME=value` operands.
        - `command`: `-p`.
        - `exec`: `-a NAME`, `-c`, `-l`.
        - `time`: `-p`.
        - `nohup`.
        - `nice`: `-n N`.
        - `timeout`: its options, then the duration.
        - `stdbuf`: `-i`/`-o`/`-e` with a mode.
        - `xargs`: dash options; `-I`, `-n`, `-P`, `-d`, `-E`, `-L`, `-s` take a value.
        - `busybox`.
        - `sudo` and `doas`, with their dash options.
     4. For a `git` head, drop global options before the subcommand: `-C <x>`, `-c <x>`,
        `--git-dir[=<x>]`, `--work-tree[=<x>]`, `--namespace[=<x>]`, `--no-pager`, `-p`,
        `--paginate`, `--bare`, `--literal-pathspecs`, `--no-replace-objects`.
     5. For a `sh`, `bash`, `dash`, `zsh` or `ksh` head, scan its options for a cluster matching
        `^-[A-Za-z]*c[A-Za-z]*$` (`-c`, `-lc`, `-ec`), skipping known option values (`-o <opt>`,
        `--rcfile <f>`) and long options such as `--norc`, as the state guard's `shellCommandString`
        does. Lex the token after that cluster's
        text with `lexBashCommand` and canonicalise each resulting segment, at most 3 levels deep.
        An opaque payload, a refused lex, or a fourth level is `refused`.
   - A canonical segment that is left empty (a bare `fi`, `done` or `}`) is dropped.
   - In `checkBashCommand` (`policy-bash.ts`), a deny or ask entry matches a segment when it matches
     the raw segment or any canonical segment.
   - When `args.denyEntry` exists, a `refused` canonical result denies the command with the reason,
     and so does a canonical segment whose head is `eval`.
   - Grant matching is unchanged and uses the raw segment.
10. **Run-state guard gaps (#2551 item 3).** New logic lives in a new
    `nax-agent/src/tools/nax-verb-gaps.ts`, because `nax-state-guard.ts` is 491 of 600 lines.
    `verbRefusal` dispatches into it. Like every existing refusal, each new one applies only when a
    `.nax` directory is near the command's frames (`hasNaxDirNear` / `findNaxDirs`). An operand
    "touches `.nax`" by the existing `operandTouchesNax` (`nax-revert.ts`), which resolves it
    against the frames and, through `coversNax`, counts a directory that contains a `.nax`
    directory. The guard refuses:
    - a `git checkout`, `git restore`, `git rm` or `git reset` pathspec operand containing `*`, `?`
      or `[`, because a glob such as `'*.json'` can match files under `.nax`. An exclusion pathspec
      (`isExclusionSpec`, e.g. `':(exclude,glob)**/.nax/**'`, which the guard's own refusal text
      recommends) is exempt;
    - `git rebase`, `git pull` or `git merge` with `--autostash`;
    - `git rm` with any operand that touches `.nax`, whatever its flags (so `git rm -r .` and
      `git rm -r packages` refuse when they contain a `.nax` directory);
    - `git reset` with a path operand that touches `.nax`, whether before or after `--`;
    - `git sparse-checkout` with any subcommand other than `list`.

    `git stash push` without `--` is allowed when every path operand passes the same check as the
    `--` form (`pathIsClean`). Path operands are the tokens after `push` that do not start with `-`,
    skipping the value of `-m` / `--message`. `--pathspec-from-file` refuses, because its paths
    cannot be checked.
11. **Turn-retry abort (#2555 item 5).** `TurnRetryDeps.sleep` becomes
    `(ms: number, signal?: AbortSignal) => Promise<void>`. `realSleep(ms, signal)` clears its
    timer and rejects when `signal` aborts. `abortableSleep` passes the signal through.
12. **ACP session lock (#2553 item 2).** In `nax-agent-acp/src/server/storage.ts`:
    - The lock body becomes `{ pid, startedAt, nonce, heartbeatAt }`. `nonce` is a `randomUUID()`
      per acquire. `LockSchema` still parses a legacy `{ pid, startedAt }` body.
    - The holder refreshes `heartbeatAt` every `LOCK_HEARTBEAT_MS = 30_000` by writing the new body
      to `<lock>.<nonce>.tmp` and renaming it over the lock, so a reader never sees a truncated
      file. It does so only while the file's `nonce` is still its own. When the lock is missing or
      holds another `nonce`, it stops the timer and never recreates the file. The timer is
      `unref`'d and stops on release.
    - A lock is stale when it is unreadable or malformed, its pid is dead, or its `heartbeatAt` is
      older than `LOCK_STALE_MS = 120_000`, even with a live pid. A legacy body is stale only when
      its pid is dead.
    - **Creation never exposes an empty lock:** the body is written to `<lock>.<nonce>.tmp`, then
      `link`ed to the lock path, which fails if it exists, and the temp file is removed.
    - **Takeover:** rename the stale file to `<lock>.<nonce>.stale`, then re-read the renamed file.
      If its `nonce` (or, for a legacy body, its `pid` and `startedAt`) is not the body judged
      stale, another server took over in between. It is restored with `link` to the lock path then
      `unlink` of the renamed file. If that `link` fails because a newer lock already exists,
      nothing is removed. Either way the session is refused. Otherwise create the
      lock as above and remove the renamed file. A racer whose rename fails re-reads the lock and
      refuses when it is held and fresh.
    - A lock held by this process's own pid keeps today's meaning: it is taken over.
    - **Release** removes the file only when its `nonce` equals the releaser's.
    - `LOCK_HEARTBEAT_MS` and `LOCK_STALE_MS` are exported. `StorageDeps` gains injectable
      `now` and `setInterval` so tests drive the heartbeat without real time.
13. **Dead session (#2553 item 3).**
    - `switchTo` catches an `agent.close()` error, logs it, and continues to `open()` (today a close
      throw skips `open()` and `restore()` entirely).
    - `ServerSession` gains `isClosed(): boolean`. It is true after `switchTo` closed (or tried to
      close) the old agent and both `open()` and `restore()` failed. `switchTo` still rejects with
      the `open()` error.
    - The registry's switch path, on a `switchTo` throw with `isClosed()` true, runs `closeEntry`,
      which releases the lock and MCP connections, and deletes the entry. An error from that
      `closeEntry` is logged and swallowed, and the original `open()` error is rethrown.
    - `session/load` of that id then reopens it from storage.
14. **Cumulative cost (#2553 item 4).**
    - `SessionMeta` gains optional `costUsd`.
    - `ServerSessionDeps.onTurnEnd` becomes `(message: string, costUsd: number) => Promise<void>`,
      called with the session's cumulative cost after the turn. The registry's `recordTurn` writes it
      to `SessionMeta.costUsd` through `writeMeta`.
    - `ServerSessionDeps` gains `priorCostUsd?: number`, which seeds the session's cumulative cost
      (today a closure variable initialised to 0). `createEntryServer` passes `meta.costUsd ?? 0`, so
      `usage_update` cost continues across `session/load`, `session/resume` and a server restart.
15. **Session id validation (#2553 item 5).** `SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/`
    (storage.ts). `session/load`, `session/resume` and `session/delete` reject a non-matching id
    with JSON-RPC error `-32602` before any file access.
16. **Zero write targets (#2553 item 6).**
    - For a tool call of kind `edit`, `delete` or `move` (the write kinds), `editTargets` also reads
      the `rawInput` keys `path`, `filePath`, `old_path` and `new_path`. Other kinds read only the
      keys they read today, so an MCP tool (kind `other`) with a `path` argument is unaffected.
    - In `decideFull`, with a sandbox, a write-kind call with zero targets gets the same decision as
      a target outside the write roots. Every other kind with zero targets keeps today's decision.
17. **Agent process group (#2555 item 4).** `launch.ts` `kill()` and `terminate()` signal the
    process group even after the leader exited, using `killProcessGroup(pid, signal,
    { singleProcessFallback: false })` once `gone` is set. `terminate(graceMs)` sends SIGTERM to the
    group. SIGKILL then reaches the group at whichever comes first: the leader exiting (sent at
    once, with `singleProcessFallback: false`) or `graceMs` elapsing (the timer). So a
    SIGTERM-trapping member does not survive, and a clean shutdown does not wait the full grace
    period. The timer is cleared before `terminate` returns.
18. **Reviewer restore fallback (#2552 item 2).** In `review/reviewer-guard/snapshot.ts`:
    - Before the tree phase, `restoreRepoSnapshot` waits while the file named by
      `git rev-parse --git-path index.lock` exists, with that output resolved against the toplevel.
      It polls every 100ms for up to `INDEX_LOCK_WAIT_MS = 5_000`, through new `_snapshotDeps.sleep`
      and `_snapshotDeps.now` seams. It then records the failure `index.lock held` and proceeds.
    - When `snapshotWorkingTree` or `changedPathsBetween` throws, the tree phase falls back to
      `git checkout <snap.tree> -- <paths>`. That covers every path of `snapshotEntries(snap)`
      except gitlinks (mode `160000`, excluded as on the primary path) and keeper-held paths, in the
      existing 500-path chunks.
    - The report keeps the snapshot failure and adds `fallback: "tracked-only"`. Its `paths` are the
      paths checked out, and `restored` comes from the fallback's success.
19. **Keeper exemption (#2552 item 3).** `isKeeperOwnedPath(toplevel, rel)` is true only when
    `activeKeepers().some(k => k.get(join(toplevel, rel)) !== undefined)`.
20. **Gate resolution (#2554 item 4).** In `resolveGateCommands`'s `add`:
    - A command that is `""`, whitespace only, or an array with no non-blank element produces no
      gate.
    - A package overlay that sets `e2e` but no `e2eSetup` key takes the root's `e2eSetup`.
21. **MCP connect cancellation (#2555 item 2).**
    - `createMcpPool` owns an `AbortController`. `close()` aborts it before awaiting pending opens.
    - `connectMcpServer` gains `signal?: AbortSignal` and passes it to `connectMcp` instead of a
      never-aborted signal.
    - The retry loop starts no attempt once the signal is aborted.
    - Its backoff waits through `cancellableDelay(ms, signal)` (already imported in `pool.ts`),
      replacing `Bun.sleep`.
    - An open cut short by `close()` follows the pool's error-as-data design. The entry resolves to
      `undefined`, records a `connect-failed` failure naming the server id, and never throws into
      `listTools`, `instructions` or `call`.
    - nax-agent's `ConnectMcpOptions` gains `onSpawn?: (pid: number) => void`. For a stdio
      transport, `connectMcp` wraps `handle.transport.start`. Once the original `start()` resolves,
      it reads `handle.pid()` and, when that is not `null`, calls `onSpawn` once. That is before the
      `initialize` request is sent.
    - `connectMcpServer`'s args gain `onSpawn` and pass it through to `connectMcp`
      (`_mcpClientDeps.connect`). The pool passes an `onSpawn` that registers the pid with
      `opts.pidRegistry` synchronously, replacing the registration after connect. When that open
      fails or is aborted, the pid is unregistered after the connect has rejected. A hard exit
      during the handshake therefore leaves no untracked server.
22. **Config warnings before the logger (new).** In `logger/logger.ts`:
    - `warnOrDefer(stage, message)` calls the logger's `warn` when one is initialised. Otherwise it
      appends `{ stage, message }` to a pending list, deduplicated by stage plus message.
    - On the first append it registers an exit handler through `_loggerDeps.onExit` (production:
      `process.once("exit", ...)`). The handler writes each item still pending through
      `_loggerDeps.writeStderr` (production: `process.stderr.write`) as
      `nax warning (<stage>): <message>\n`.
    - `warnOrDefer` is exported from the `@/logger` barrel.
    - `initLogger` drains the pending list into the new logger's `warn`, in order, and empties it.
    - The pending list is process-scoped: `resetLogger` does NOT empty it, because `nax run` calls
      `resetLogger()` (`bin/nax.ts:308`) between its config load and `initRunLogging`. Tests empty
      it with a separate `_resetDeferredWarnings()` export.
    - "A logger is initialised" means the module's own `instance !== null`; `getSafeLogger()` never
      returns null and cannot be the test.
    - `defaultConfigWarn` (`config/compat-shims.ts`) calls `warnOrDefer("config", msg)`. Its body
      changes only, since the file is 585 lines.
23. **Tests (#2550).**
    - `test/e2e/workflow-mode.e2e.test.ts` (new) drives the runner's `run` entry
      (`src/execution/runner.ts`) on a one-story PRD with `execution.mode` unset, in a temp project
      that is a git repository with one commit. It uses `workflow.publish: "none"`.
    - Agent calls are scripted through the workflow's own seam, `_workflowDeps.callOp`, as
      `test/integration/workflow/feature-e2e.test.ts` does. The pipeline-mode orchestrator harness
      is not used.
    - A unit test covers `workflow.timeouts.ciWaitMs` and `ciPollMs` reaching `waitForChecks`.
    - Failed `git status` and `rev-parse` are already covered (`test/unit/workflow/git.test.ts`).

### Integration

Symbols the feature only reads:

- `readHead(projectDir)` (`packages/nax/src/workflow/git.ts`).
- `collectStoryRecords(featureDir)` and `newestPreflight` (`packages/nax/src/workflow/feature-record.ts`).
- `pendingStoryIds` (`packages/nax/src/workflow/preflight-run.ts`).
- `lexBashCommand`, `BashSegment`, `BashToken` (`packages/nax-agent/src/permissions/bash-lex.ts`).
- `matchesSegment`, `matchesTokens` (`packages/nax-agent/src/tools/policy-bash.ts`).
- `locateGit` (`packages/nax-agent/src/tools/git-flags/locate.ts`).
- `operandTouchesNax`, `isExclusionSpec` (`packages/nax-agent/src/tools/nax-revert.ts`); `hasNaxDirNear`, `findNaxDirs`.
- `cancellableDelay` (`packages/nax/src/utils/bun-deps.ts`).
- `stashIsExempt` (`packages/nax-agent/src/tools/nax-stash-restore.ts`).
- `killProcessGroup` (`packages/nax-agent/src/internal/process-kill.ts`).
- `activeKeepers()` (`packages/nax/src/runstate/store/registry.ts`); `RunStateKeeper.get`.
- `snapshotWorkingTree`, `changedPathsBetween` (`packages/nax/src/review/fix-review/tree-snapshot/index.ts`).

Symbols the feature changes. The baseline only locates the code; implement the target.

- `waitForChecks(forge, prRef, opts)` (`packages/nax/src/workflow/ci-wait.ts`). Target adds `opts.expectedSha?: string` (Approach 1).
- `classifyGh`, `classifyGlab`, `githubWaiting` (`ci-wait.ts`). Target: Approaches 1 and 2.
- `waitForCi(fc, forge)` (`packages/nax/src/workflow/finalize.ts`). Target passes `expectedSha`.
- `isPublishableBranch(branch)` (`finalize.ts`). Baseline refuses `""`, `main` and `master`. Target: `isPublishableBranch(branch, defaultBranch?)`.
- `adoptPriorPreflight(featureDir, runDir)`. Target: `adoptPriorPreflight(featureDir, runDir, storyIds)`.
- `WorkflowStoryRecord` (`packages/nax/src/workflow/types.ts`). Target adds `fixBase?: string`.
- `isFinishedAtHead(prior, head)` and the resume start step in `runWorkflowFeature` (`packages/nax/src/workflow/feature.ts`). Target: Approach 5.
- `unreadFiles(required, inspected)`, `isCompleteBranchVerdict(verdict, required)` and `covers(entry, path)` (`packages/nax/src/operations/workflow-review-coverage.ts`). Target: both public functions take a trailing `repoRoot` (Approach 7).
- The branch-review op input (`packages/nax/src/operations/workflow-types.ts`) and `workflowBranchReviewOp` (`operations/workflow-branch-review.ts`). Target adds `repoRoot` to the input.
- `redBaseDependencies(sc)` (`packages/nax/src/workflow/brief.ts`). Target: Approach 8.
- `checkBashCommand(args)` (`policy-bash.ts`). Target: Approach 9.
- `verbRefusal` (`packages/nax-agent/src/tools/nax-state-guard.ts`). Target: dispatches Approach 10.
- `coversNax(spec, ctx, nax)` and `splitOperands(verb, args)` (`nax-revert.ts`) and `pathIsClean(spec, ctx)` (`nax-stash-restore.ts`). Baseline: module-private. Target: exported unchanged, for `nax-verb-gaps.ts`; `coversNax`'s third argument is `findNaxDirs(ctx)`.
- `TurnRetryDeps.sleep`, `realSleep(ms)`, `abortableSleep` (`packages/nax-agent/src/native/session/turn-retry.ts`). Target: Approach 11.
- `acquireLock(sessionId)`, `LockSchema`, `MetaSchema` (`packages/nax-agent-acp/src/server/storage.ts`). Target: Approaches 12, 14 and 15.
- `ServerSession.switchTo` and `ServerSessionDeps` (`packages/nax-agent-acp/src/server/server-session.ts`). Target adds `isClosed()`, `priorCostUsd`, and `onTurnEnd(message, costUsd)` (Approaches 13-14).
- `createEntryServer` and the switch path (`packages/nax-agent-acp/src/server/registry.ts`). Target: Approaches 13 and 14.
- `session/load`, `session/resume`, `session/delete` handlers (`packages/nax-agent-acp/src/server/connection.ts`). Target: Approach 15.
- `editTargets` (`packages/nax-agent-acp/src/client/edit-targets.ts`) and `decideFull` (`packages/nax-agent-acp/src/client/permissions.ts`). Target: Approach 16.
- `kill()` and `terminate()` of the launched agent (`packages/nax-agent-acp/src/client/launch.ts`). Target: Approach 17.
- `restoreRepoSnapshot(snap)`, `RestoreReport`, `isKeeperOwnedPath` (`packages/nax/src/review/reviewer-guard/snapshot.ts`). Target: Approaches 18 and 19. `RestoreReport` adds `fallback?: "tracked-only"`.
- `resolveGateCommands(repoRoot, packageDirs)` (`packages/nax/src/finish/gates/quality.ts`). Target: Approach 20.
- `connectMcpServer(args)` (`packages/nax/src/mcp/client.ts`) and `createMcpPool(opts)` (`packages/nax/src/mcp/pool.ts`). Target: Approach 21.
- `ConnectMcpOptions` and `connectMcp(config, opts)` (`packages/nax-agent/src/mcp/types.ts`, `packages/nax-agent/src/mcp/connect.ts`). Target adds `onSpawn` (Approach 21).
- `initLogger`, `resetLogger` (`packages/nax/src/logger/logger.ts`). Target: Approach 22, plus new exports `warnOrDefer` and `_loggerDeps`.
- `defaultConfigWarn(msg)` (`packages/nax/src/config/compat-shims.ts`). Target calls `warnOrDefer("config", msg)`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `readHead` throws in `waitForCi` | One `warn`; the wait runs without `expectedSha`. |
| The deadline passes on a SHA mismatch | Outcome `unavailable`, which keeps the PR a draft. |
| `readDefaultBranch`'s git call fails | Only `""`, `main` and `master` are protected. |
| A `sh -c` payload cannot be lexed, or nests deeper than 3 | With a deny rule present, the command is denied. |
| A lock rename loses a takeover race | The lock is re-read; a fresh live holder refuses the session. |
| A renamed lock turns out to be a newer body | It is renamed back and the session is refused. |
| `switchTo`'s open and restore both fail | The entry is closed and removed; the open error is still returned. |
| `writeMeta` of `costUsd` fails | One `warn`; the turn's result is unchanged. |
| The working-tree snapshot throws | Tracked-only fallback restore (Approach 18). |
| `index.lock` still exists after 5s | Failure `index.lock held` recorded; the restore proceeds. |
| `pool.close()` runs during an MCP connect | The connect is aborted; no further attempt; the entry resolves to `undefined` with a `connect-failed` failure naming the server. |
| The process exits with config warnings pending | They are written to stderr. |

## Out of Scope

- Deny or ask rules under `bashApproval: "raw"`, the default mode: ADR-030 makes raw a pass-through screen that "must never grow into a general gate".
- Canonical matching for grant rules; a grant still matches only the raw segment.
- The pipeline-mode `isFeatureBranch` protected list in `finish/phase.ts`; pipeline mode is deprecated.
- The backoff timer in `nax-ai`'s `protocols/retry.ts`.
- US-002 only: a story record written before `fixBase` existed, with open findings, keeps today's resume behaviour.
- US-001 only: a slow check that registers after faster checks already went green on the same commit; #2550 item 3's stated fix is the SHA comparison, which catches checks for another commit.
- US-001 only: CI on the advisor-ledger commit `pushLedger` pushes after the CI wait; that commit holds only the ledger file.
- Restoring `.nax` files that `git sparse-checkout` already deleted; the guard now refuses the command.
- Session lock heartbeats across hosts or on network filesystems.
- Showing pre-logger config warnings on the TUI console; they go to the run's log file.
- US-007 only: a restore that bypasses `.git/index.lock` without waiting.
- Applying `--autostash` refusal to `git -c rebase.autoStash=true` config overrides.
- US-002 only: a repository with no CI at all re-waits `workflow.timeouts.ciWaitMs` on each rerun of a draft whose CI was `unavailable`; accepted.

## Stories

### US-001 — CI bound to the pushed commit, GitLab statuses, and workflow tests

Workdir: `packages/nax`

No dependencies.

The head-SHA comparison for GitHub and GitLab, the GitLab `skipped`, `manual` and `scheduled`
mapping, the `ciWaitMs` and `ciPollMs` wiring test, and the workflow-mode e2e test (#2550 items 3,
4 and the test gaps).

### US-002 — Workflow resume and publish state

Workdir: `packages/nax`

No dependencies.

Preflight story-set check, persisted `fixBase`, transient-draft re-publish, protected default
branch, exact review coverage, and cross-run base dependencies (#2550 items 9 and 10). The other
files it changes, named in Approaches 4-8, are `workflow/brief.ts`, `workflow/git.ts`,
`workflow/types.ts`, `workflow/branch-review.ts`, `operations/workflow-review-coverage.ts`,
`operations/workflow-branch-review.ts` and `operations/workflow-types.ts`.

### US-003 — Canonical Bash deny and ask matching

Workdir: `packages/nax-agent`

No dependencies.

`canonicalSegments` with its own wrapper option table, and its use for deny and ask rules, plus
the `eval`, unknown-wrapper-option and unreadable `sh -c` refusals (#2551 item 2).

### US-004 — Run-state guard gaps

Workdir: `packages/nax-agent`

No dependencies.

The `.nax` guard refusals for glob pathspecs, `--autostash`, `git rm`, `git reset` paths and
`sparse-checkout`, and `git stash push` without `--` (#2551 item 3).

### US-005 — ACP server sessions: lock, dead session, cost

Workdir: `packages/nax-agent-acp`

No dependencies.

The nonce and heartbeat lock with link creation, verified rename takeover and owned release, the
dead-session retirement, and cumulative cost through `SessionMeta.costUsd` (#2553 items 2-4).

### US-006 — ACP id validation, write targets and process-group kill

Workdir: `packages/nax-agent-acp`

No dependencies.

`SESSION_ID_PATTERN` on the client-supplied ids, write-kind targets and the zero-target decision
under `full` with a sandbox, and the process-group kill and terminate after the leader exited
(#2553 items 5-6, #2555 item 4).

### US-007 — nax runtime: reviewer restore, gates, MCP cancel

Workdir: `packages/nax`

Depends on US-009.

The restore fallback and `index.lock` wait, the keeper exemption, gate resolution, and MCP connect
cancellation with pid registration at spawn (#2552 items 2-3, #2554 item 4, #2555 item 2).

### US-008 — Config warnings raised before the logger starts

Workdir: `packages/nax`

No dependencies.

`warnOrDefer`, the drain in `initLogger`, the stderr flush at exit, and `defaultConfigWarn` routed
through it.

### US-009 — nax-agent retry backoff and MCP spawn hook

Workdir: `packages/nax-agent`

No dependencies.

The abortable turn-retry backoff and `ConnectMcpOptions.onSpawn` (#2555 items 2 and 5).

Story split rationale: `maxAcCount` is 24 assertions, and each story has one package. The
nax-agent work splits by subsystem (policy, guard, runtime). The nax-agent-acp work splits into
server state and client and id checks, and the nax work into workflow, runtime and logging. Nine
stories is two over the usual seven: the user asked for all six issues plus the config-warning bug
in one bundle, and the spec-review's additions pushed three stories past the AC cap.

### Context Files

**US-001**
- `packages/nax/src/workflow/ci-wait.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/execution/runner.ts`
- `packages/nax/test/integration/workflow/feature-e2e.test.ts`
- `packages/nax/test/unit/workflow/ci-wait.test.ts`

**US-002**
- `packages/nax/src/workflow/preflight-run.ts`
- `packages/nax/src/workflow/preflight.ts`
- `packages/nax/src/workflow/story-loop.ts`
- `packages/nax/src/workflow/feature.ts`
- `packages/nax/src/workflow/finalize.ts`

**US-003**
- `packages/nax-agent/src/permissions/bash-lex.ts`
- `packages/nax-agent/src/tools/policy-bash.ts`
- `packages/nax-agent/src/tools/git-flags/locate.ts`
- `packages/nax-agent/src/tools/nax-state-guard.ts`
- `packages/nax-agent/test/unit/tools/policy-bash.test.ts`

**US-004**
- `packages/nax-agent/src/tools/nax-state-guard.ts`
- `packages/nax-agent/src/tools/nax-revert.ts`
- `packages/nax-agent/src/tools/nax-stash-restore.ts`
- `packages/nax-agent/src/tools/nax-dirs.ts`

**US-005**
- `packages/nax-agent-acp/src/server/storage.ts`
- `packages/nax-agent-acp/src/server/server-session.ts`
- `packages/nax-agent-acp/src/server/registry.ts`
- `packages/nax-agent-acp/src/server/registry-open.ts`

**US-006**
- `packages/nax-agent-acp/src/server/connection.ts`
- `packages/nax-agent-acp/src/client/edit-targets.ts`
- `packages/nax-agent-acp/src/client/permissions.ts`
- `packages/nax-agent-acp/src/client/launch.ts`
- `packages/nax-agent/src/internal/process-kill.ts`

**US-007**
- `packages/nax/src/review/reviewer-guard/snapshot.ts`
- `packages/nax/src/finish/gates/quality.ts`
- `packages/nax/src/mcp/pool.ts`
- `packages/nax/src/mcp/client.ts`

**US-008**
- `packages/nax/src/logger/logger.ts`
- `packages/nax/src/logger/index.ts`
- `packages/nax/src/config/compat-shims.ts`
- `packages/nax/src/config/loader.ts`

**US-009**
- `packages/nax-agent/src/native/session/turn-retry.ts`
- `packages/nax-agent/src/mcp/connect.ts`
- `packages/nax-agent/src/mcp/types.ts`

### Creates

**US-001**
- `packages/nax/test/e2e/workflow-mode.e2e.test.ts`
- `packages/nax/test/unit/workflow/ci-wait-sha.test.ts`

**US-003**
- `packages/nax-agent/src/tools/bash-canonical.ts` — `canonicalSegments` and `CanonicalResult`
- `packages/nax-agent/test/unit/tools/bash-canonical.test.ts`

**US-004**
- `packages/nax-agent/src/tools/nax-verb-gaps.ts` — the Approach 10 refusals, dispatched from `verbRefusal`
- `packages/nax-agent/test/unit/tools/nax-verb-gaps.test.ts`

**US-008**
- `packages/nax/test/unit/logger/warn-or-defer.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — its argv assertions pin the `gh pr view` JSON field list, which now also requests `headRefOid`. The replacing invariant is that the list includes `mergeable`, `mergeStateStatus`, `baseRefName` and `headRefOid`.

**US-002**
- `packages/nax/test/unit/workflow/preflight-run.test.ts` — its reuse test adopts a prior preflight file without regard to story ids. The replacing invariant is that reuse happens only when the prior `storyIds` equal the pending story ids as a set.
- `packages/nax/test/unit/operations/workflow-review-coverage.test.ts` — its cases call `unreadFiles` and `isCompleteBranchVerdict` without a repo root. The replacing invariant is the call with a trailing repo root, where only a path equal to the required path, after making absolute entries relative to the repo root, covers it.
- `packages/nax/test/unit/workflow/preflight.test.ts` — its saved `PreflightFile` fixtures have no `storyIds`. The replacing invariant is that a written file carries the pre-flighted `storyIds` and a file without them is not reusable.
- `packages/nax/test/unit/workflow/branch-review.test.ts` — its op input fixtures have no `repoRoot`. The replacing invariant is that the input carries the project root.

**US-003**
- `packages/nax-agent/test/unit/tools/policy-bash.test.ts` — any case asserting that a wrapper-prefixed or `sh -c` command passes a deny rule. The replacing invariant is that deny and ask rules match the canonical segment.

**US-005**
- `packages/nax-agent-acp/test/unit/server/storage.test.ts` — its lock-body assertions pin `{ pid, startedAt }`. The replacing invariant is a body with `pid`, `startedAt`, `nonce` and `heartbeatAt`.
- `packages/nax-agent-acp/test/unit/server/server-session-switch.test.ts` — its failed-restore case leaves the session usable. The replacing invariant is that the session reports `isClosed()` true.
- `packages/nax-agent-acp/test/unit/server/server-session.test.ts` — any `onTurnEnd` stub that takes one argument. The replacing invariant is that `onTurnEnd` receives the message and the cumulative cost.

**US-006**
- `packages/nax-agent-acp/test/unit/client/permissions.test.ts` — any `full` case with a sandbox and a write-kind call that has no target and is allowed. The replacing invariant is the outside-write-roots decision.
- `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts` — its comments and assertions describe `kill()` as a no-op after the leader exited. The replacing invariant is that the group is signalled.
- `packages/nax-agent-acp/test/unit/client/launch.test.ts` — any case asserting that `terminate` sends no SIGKILL once the leader exited within the grace period. The replacing invariant is that SIGKILL reaches the group when the grace period ends.

**US-007**
- `packages/nax/test/unit/review/reviewer-guard/snapshot.test.ts` — any case asserting that a failed working-tree snapshot restores no paths. The replacing invariant is the tracked-only fallback.
- `packages/nax/test/unit/mcp/pool.test.ts` — any case asserting that `close()` waits for an in-flight open to finish its attempts. The replacing invariant is that `close()` aborts it.
- `packages/nax/test/unit/mcp/pool.test.ts` — any case asserting that the pid is registered after the connect resolves. The replacing invariant is that it is registered through `onSpawn` and unregistered when the open fails.

**US-008**

None. `warnOrDefer` is new and `defaultConfigWarn`'s callers keep their signatures; no existing test pins a dropped pre-logger warning.

**US-009**
- `packages/nax-agent/test/unit/native/session/turn-retry.test.ts` — its `sleep` stubs take one argument. The replacing invariant is that `sleep` receives the abort signal as its second argument.

### Seams

- US-009 adds `ConnectMcpOptions.onSpawn`, and US-007's pool passes it. US-007 AC 17 stubs
  `_mcpClientDeps.connect`, triggers an open through `createMcpPool`'s `listTools`, and asserts that
  the stub received an `onSpawn`.

## Acceptance Criteria

### US-001

1. [unit] `waitForChecks` with `expectedSha: "aaa"` on GitHub, where `gh pr checks` reports every check passing and `gh pr view` reports `headRefOid` `"bbb"`, does not return `green` from that poll.
2. [unit] `waitForChecks` with `expectedSha: "aaa"` on GitHub returns `green` once `gh pr view` reports `headRefOid` `"aaa"` and every check is passing.
3. [unit] When the deadline passes while the latest GitHub poll had passing checks and `headRefOid` `"bbb"` against `expectedSha` `"aaa"`, `waitForChecks` returns outcome `unavailable`.
4. [unit] That `unavailable` result's `detail` names the first 8 characters of both the reported SHA and the expected SHA.
5. [unit] `waitForChecks` with `expectedSha: "aaa"` on GitLab, where `glab mr view` reports `head_pipeline.status` `"success"` and `head_pipeline.sha` `"bbb"`, does not return `green` from that poll.
6. [unit] On GitLab, with `head_pipeline` absent, `pipeline.status` `"success"` and `pipeline.sha` equal to `expectedSha` returns `green`.
7. [unit] `waitForChecks` without `expectedSha` returns `green` for passing GitHub checks whatever `headRefOid` reports.
8. [unit] A GitLab poll reporting `success` with no `sha` on either pipeline object returns `green` when `expectedSha` is set.
9. [unit] `waitForCi` passes the value returned by `readHead(fc.projectDir)` to `waitForChecks` as `expectedSha`.
10. [unit] When `readHead` throws inside `waitForCi`, `waitForChecks` is called without `expectedSha`, and one `warn` is logged.
11. [unit] When `readHead` returns `""` inside `waitForCi`, `waitForChecks` is called without `expectedSha`.
12. [unit] A GitLab poll reporting pipeline status `skipped` returns outcome `green`.
13. [unit] A GitLab poll reporting pipeline status `manual` returns outcome `unavailable` on the first poll, with `detail` `pipeline is waiting on a manual job`.
14. [unit] A GitLab poll reporting pipeline status `scheduled` returns outcome `unavailable` on the first poll.
15. [unit] `waitForCi` passes `workflow.timeouts.ciWaitMs` from the feature config as `timeoutMs` to `waitForChecks`.
16. [unit] `waitForCi` passes `workflow.timeouts.ciPollMs` from the feature config as `pollMs` to `waitForChecks`.
17. [integration] In the e2e test, the runner's `run` entry, on a one-story PRD with `execution.mode` unset and `workflow.publish: "none"`, sends at least one scripted call through `_workflowDeps.callOp`.
18. [integration] After that run, `readResult` on the run's workflow run dir reports `stories["US-001"].state` equal to `complete`.
19. [integration] That run's end phase reports `workflowPassed: true`.

### US-002

1. [unit] `adoptPriorPreflight(featureDir, runDir, ["US-001", "US-002"])` copies a prior `preflight.json` whose `storyIds` are `["US-002", "US-001"]`, and returns `true`.
2. [unit] `adoptPriorPreflight(featureDir, runDir, ["US-001"])` does not copy a prior `preflight.json` whose `storyIds` are `["US-001", "US-002"]`, and returns `false`.
3. [unit] `runWorkflowPreflight` on a PRD whose pending stories are `US-001` alone does not log "Reusing the pre-flight of an earlier run" when the only prior pre-flight covered `US-001` and `US-002`.
4. [unit] A story loop that reaches a fix turn with `fixBase` `"abc"` persists `fixBase: "abc"` on the `WorkflowStoryRecord` before that turn starts.
5. [unit] A story loop resumed from a record with one open finding and `fixBase: "abc"` calls the re-review step with `fixBase` `"abc"` before any fix turn.
6. [unit] `runWorkflowFeature` on a prior record with `outcome: "draft"`, `ci: "unavailable"` and a `head` equal to the current HEAD calls the publish step.
7. [unit] In that run, the branch review step is not called.
8. [unit] `runWorkflowFeature` on a prior `draft` at the current HEAD whose `reasons` include `PR update failed: timeout` calls the publish step.
9. [unit] `runWorkflowFeature` on a prior `draft` at the current HEAD with `ci: "green"` and the reason `review unread: src/a.ts` returns outcome `already-finished`.
10. [unit] `readDefaultBranch` returns `"develop"` when `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` prints `origin/develop`.
11. [unit] `readDefaultBranch` returns `undefined` when that git call exits non-zero.
12. [unit] `isPublishableBranch("develop", "develop")` returns `false`.
13. [unit] `isPublishableBranch("feat/x", "develop")` returns `true`.
14. [unit] `isPublishableBranch("main", undefined)` returns `false`.
15. [unit] `publish` on a feature branch equal to the branch `readDefaultBranch` returns opens no PR and records a draft-or-local reason naming the protected branch.
16. [unit] `unreadFiles(["package.json"], ["packages/x/package.json"], "/repo")` returns `["package.json"]`.
17. [unit] `unreadFiles(["package.json"], ["/repo/packages/x/package.json"], "/repo")` returns `["package.json"]`.
18. [unit] `unreadFiles(["package.json"], ["/repo/package.json"], "/repo")` returns `[]`.
19. [unit] `writeBrief` for a story whose dependency's newest story record, written in an earlier run dir beside the current one, has state `complete-gate-open` writes a brief containing the red-base warning naming that dependency.
20. [unit] `writeBrief` for a story whose dependency's newest record, written in an earlier run, has state `complete` writes a brief with no red-base warning.

### US-003

1. [unit] `canonicalSegments` on the segment `env FOO=1 rm -rf x` returns one segment whose tokens are `rm -rf x`.
2. [unit] `canonicalSegments` on `FOO=1 BAR=2 rm x` returns a segment whose tokens are `rm x`.
3. [unit] `canonicalSegments` on `time nohup nice -n 5 rm x` returns a segment whose tokens are `rm x`.
4. [unit] `canonicalSegments` on `xargs -n 1 rm` returns a segment whose tokens are `rm`.
5. [unit] `canonicalSegments` on `busybox rm x` returns a segment whose tokens are `rm x`.
6. [unit] `canonicalSegments` on `env --frobnicate rm x` returns `kind: "refused"`.
7. [unit] `canonicalSegments` on `git -C . -c a=b --no-pager push origin` returns a segment whose tokens are `git push origin`.
8. [unit] `canonicalSegments` on `sh -c 'rm -rf x'` returns a segment whose tokens are `rm -rf x`.
9. [unit] `canonicalSegments` on `bash -lc 'rm x'` returns a segment whose tokens are `rm x`.
10. [unit] `canonicalSegments` on `bash -c 'echo a; rm x'` returns two segments, the second with tokens `rm x`.
11. [unit] `canonicalSegments` on a `sh -c` payload nested four levels deep returns `kind: "refused"`.
12. [unit] `canonicalSegments` on the segment `then rm x` (from `if true; then rm x; fi`) returns a segment whose tokens are `rm x`.
13. [unit] `canonicalSegments` on the segment `fi` returns no segments.
14. [unit] `canonicalSegments` on `bash -o pipefail -c 'rm x'` returns a segment whose tokens are `rm x`.
15. [unit] `canonicalSegments` on `bash --norc -c 'rm x'` returns a segment whose tokens are `rm x`.
16. [unit] `checkBashCommand` with deny rule `rm *` denies `env rm -rf x`.
17. [unit] `checkBashCommand` with deny rule `rm *` denies `sh -c 'rm -rf x'`.
18. [unit] `checkBashCommand` with deny rule `rm *` denies `if true; then rm x; fi`.
19. [unit] `checkBashCommand` with deny rule `git push *` denies `git -C . push origin`.
20. [unit] `checkBashCommand` with any deny rule denies `eval ls`.
21. [unit] `checkBashCommand` with no deny rule does not deny `eval ls` on account of `eval`.
22. [unit] `checkBashCommand` with deny rule `rm *` denies `sh -c "$CMD"`, whose payload token the lexer marks opaque.
23. [unit] `checkBashCommand` with ask rule `curl *` asks for `env curl -s host`.
24. [unit] `checkBashCommand` with grant `rm *` and no deny rule does not grant `env rm x` through that grant.

### US-004

1. [unit] With a `.nax` directory in the project, the `.nax` guard refuses `git checkout HEAD -- '*.json'`.
2. [unit] With no `.nax` directory near the frames, the guard allows `git checkout HEAD -- '*.json'`.
3. [unit] With a `.nax` directory in the project, the guard refuses `git restore --source HEAD -- '.na?'`.
4. [unit] The guard refuses `git rebase --autostash main`.
5. [unit] The guard refuses `git pull --autostash`.
6. [unit] The guard refuses `git merge --autostash feat`.
7. [unit] The guard allows `git rebase main` without `--autostash`.
8. [unit] The guard refuses `git rm --cached .nax/features/f/prd.json`.
9. [unit] The guard refuses `git rm -rf .nax`.
10. [unit] The guard refuses `git rm -r .` when the project holds a `.nax` directory.
11. [unit] The guard refuses `git rm -r packages` when `packages/a/.nax` exists.
12. [unit] The guard allows `git rm src/a.ts`.
13. [unit] The guard refuses `git reset -- .nax`.
14. [unit] The guard refuses `git reset HEAD .nax/features/f/prd.json`.
15. [unit] The guard allows `git reset -- src/a.ts`.
16. [unit] The guard refuses `git sparse-checkout set src` when the project holds a `.nax` directory.
17. [unit] The guard allows `git sparse-checkout list`.
18. [unit] The guard allows `git stash push src/a.ts`.
19. [unit] The guard allows `git stash push -m wip src/a.ts`.
20. [unit] The guard refuses `git stash push .nax/features/f/prd.json`.
21. [unit] The guard refuses `git stash push --pathspec-from-file=list.txt`.
22. [unit] The guard allows `git checkout -- . ':(exclude,glob)**/.nax/**'`.

### US-005

1. [unit] `acquireLock` writes a lock body with `pid`, `startedAt`, `nonce` and `heartbeatAt`.
2. [unit] Two `acquireLock` calls for different sessions write different `nonce` values.
3. [unit] A held lock's `heartbeatAt` is rewritten when the injected interval fires after `LOCK_HEARTBEAT_MS`.
4. [unit] `acquireLock` takes over a lock whose pid is alive but whose `heartbeatAt` is older than `LOCK_STALE_MS`.
5. [unit] `acquireLock` refuses a lock whose pid is alive and whose `heartbeatAt` is recent.
6. [unit] `acquireLock` takes over a legacy `{ pid, startedAt }` lock whose pid is dead.
7. [unit] `acquireLock` refuses a legacy `{ pid, startedAt }` lock whose pid is alive.
8. [unit] `acquireLock` takes over a lock held by its own process's pid.
9. [integration] When two storages race to take over the same stale lock, exactly one `acquireLock` resolves.
10. [integration] In that race, the other `acquireLock` rejects.
11. [unit] A takeover whose renamed file holds a `nonce` other than the stale one it judged restores that file to the lock path and rejects.
12. [unit] The release function returned by `acquireLock` leaves the lock file in place when it now holds another `nonce`.
13. [unit] The release function removes the lock file when it holds the releaser's `nonce`.
14. [unit] After `switchTo` closed the agent and both `open()` and `restore()` failed, `isClosed()` returns `true`.
15. [unit] In that case, `switchTo` rejects with the error thrown by `open()`.
16. [unit] When `agent.close()` throws and then `open()` and `restore()` both fail, `isClosed()` returns `true`.
17. [unit] After a failed `switchTo` with `isClosed()` true, the registry no longer holds the entry, and its lock release has run.
18. [unit] A `session/load` for that session id after the failed switch opens a new entry from storage.
19. [unit] After a turn priced at 0.5, `onTurnEnd` receives a cumulative cost of 0.5, and the stored `SessionMeta.costUsd` is 0.5.
20. [unit] A session created with `priorCostUsd` 0.5 reports a `usage_update` cost of 0.75 after a turn priced at 0.25.
21. [unit] A session loaded from storage whose `SessionMeta.costUsd` is 0.5 is created with `priorCostUsd` 0.5.
22. [unit] When `writeMeta` of `costUsd` fails, the turn still returns its result, and one `warn` is logged.

### US-006

1. [unit] `session/delete` with session id `../x` returns JSON-RPC error `-32602`, and no file is read or removed.
2. [unit] `session/load` with session id `a/b` returns JSON-RPC error `-32602`.
3. [unit] `session/resume` with a 129-character session id returns JSON-RPC error `-32602`.
4. [unit] A `randomUUID()` value, which production wires as the registry's `newId`, matches `SESSION_ID_PATTERN`.
5. [unit] `editTargets` on an `edit` tool call returns the `rawInput.path` value as a target.
6. [unit] `editTargets` on an `edit` tool call returns the `rawInput.filePath` value as a target.
7. [unit] `editTargets` on a `move` tool call returns both the `rawInput.old_path` and `rawInput.new_path` values as targets.
8. [unit] `editTargets` on an `other` tool call ignores `rawInput.path`.
9. [unit] Under the `full` profile with a sandbox, an `edit` tool call with no extractable target receives the same decision as a write to a path outside the write roots.
10. [unit] Under the `full` profile with a sandbox, an `other` tool call with no extractable target is allowed, as today.
11. [unit] Under the `full` profile without a sandbox, an `edit` tool call with no extractable target is allowed.
12. [unit] The launched agent's `kill()` called after the leader exited calls `killProcessGroup` with `SIGKILL` and `singleProcessFallback: false`.
13. [unit] `terminate(graceMs)` sends `SIGKILL` to the process group as soon as the leader exits, before `graceMs` elapses.
14. [integration] A spawned agent whose leader exits while a grandchild in its group keeps running has that grandchild killed by `kill()`.

### US-007

1. [unit] `restoreRepoSnapshot`, when `snapshotWorkingTree` throws, restores a tracked file the reviewer modified to its snapshot content.
2. [unit] In that case, the report has `fallback: "tracked-only"`, and its `paths` list the checked-out paths.
3. [unit] In that case, the report's failures still include the snapshot failure.
4. [unit] In that fallback, a keeper-held path is not checked out.
5. [unit] In that fallback, a gitlink entry is not checked out.
6. [unit] `restoreRepoSnapshot` waits, through `_snapshotDeps.sleep`, for an `index.lock` file that disappears within `INDEX_LOCK_WAIT_MS`, then restores with no `index.lock held` failure.
7. [unit] `restoreRepoSnapshot` records the failure `index.lock held` when the lock file still exists after `INDEX_LOCK_WAIT_MS` of injected time.
8. [unit] `isKeeperOwnedPath` returns `false` for `packages/x/.nax/features/f/prd.json` when no active keeper holds that absolute path.
9. [unit] `isKeeperOwnedPath` returns `true` for a path an active keeper's `get` returns an entry for.
10. [unit] `resolveGateCommands` produces no gate for a root `quality.commands.lint` of `""`.
11. [unit] `resolveGateCommands` produces no gate for a command of `["  "]`.
12. [unit] `resolveGateCommands` gives a package overlay's `e2e` gate the root's `e2eSetup` when the overlay sets no `e2eSetup`.
13. [unit] `resolveGateCommands` gives a package overlay's `e2e` gate the overlay's own `e2eSetup` when both layers set one.
14. [unit] `pool.close()` during an in-flight connect aborts the signal passed to `connectMcpServer`.
15. [unit] After that `close()`, no further connect attempt starts for the server.
16. [unit] That `close()` resolves without waiting for `MCP_CONNECT_TIMEOUT_MS`.
17. [unit] `listTools` on a stdio server through `createMcpPool` passes an `onSpawn` to the stubbed `_mcpClientDeps.connect`, and calling it registers the pid with `opts.pidRegistry`.
18. [unit] When that connect rejects after `onSpawn` ran, the pid is unregistered from `opts.pidRegistry`.
19. [unit] A `listTools` call whose open was cut short by `close()` resolves to `[]` and records a `connect-failed` failure naming the server id.

### US-008

1. [unit] `warnOrDefer("config", "m")` before `initLogger` makes no logger call.
2. [unit] A message deferred before `initLogger` is delivered to the new logger's `warn` with stage `config` when `initLogger` runs.
3. [unit] The same stage and message deferred twice is delivered once.
4. [unit] `warnOrDefer` after `initLogger` calls the logger's `warn` immediately.
5. [unit] When the exit handler registered through `_loggerDeps.onExit` runs with deferred messages and no logger, each is written through `_loggerDeps.writeStderr` as `nax warning (config): <message>`.
6. [unit] A message deferred before `resetLogger` runs is still delivered when `initLogger` runs after it.
7. [unit] `_resetDeferredWarnings` empties the deferred messages, so a later `initLogger` delivers none.
8. [integration] `loadConfig` on a project whose `.nax/config.json` sets `execution.mode: "pipeline"`, followed by `initLogger`, delivers a `warn` containing `execution.mode "pipeline" is deprecated`.

### US-009

1. [unit] `retryTransportFault` passes the abort signal as the second argument of `deps.sleep`.
2. [unit] `realSleep(10_000, signal)` rejects promptly when `signal` aborts.
3. [unit] `realSleep(10_000, signal)` clears its timer when `signal` aborts.
4. [integration] `connectMcp` on a stdio server calls `opts.onSpawn` once with the child's pid before the `initialize` handshake completes.
5. [unit] `connectMcp` on a non-stdio transport does not call `opts.onSpawn`.
