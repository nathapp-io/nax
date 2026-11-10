# SPEC: Review LOW fixes (2026-11-09 review, F5)

## Summary

Fix the LOW findings of the 2026-11-09 whole-repo review (`docs/reviews/20261109-review-nax.md`) that the user kept
after triage: 22 defects across `packages/nax-agent`, `packages/nax-ai` and `packages/nax`, in 11 independent stories.
The rest of the LOW table is dropped by ruling and listed under Out of Scope with the reason for each.

## Motivation

Every finding below was re-verified open at `5cc26cfbb` (2026-11-09); line numbers are current.

Agent packages:

- **L14 (grep half).** `buildGrepArgv` (`packages/nax-agent/src/tools/grep.ts:93-117`) returns
  `["grep", "-r", "-n", modeFlag, "--", pattern, target]` for the no-ripgrep fallback. It searches `.git/`; the
  review's agent repro returned a token-bearing remote URL from `.git/config`. ripgrep already skips `.git`.
- **L37a.** `readPrefix` (`packages/nax-agent/src/internal/bounded-io.ts:18-27`) opens with `"r"` and no file-type
  check. Opening a FIFO blocks until a writer appears, so `Read` (`tools/read.ts:125`, `:152`) hangs and ignores abort.
- **L21.** `SECRET_VALUE_PATTERNS` (`packages/nax-agent/src/internal/redact.ts:43-122`) has no GitLab (`glpat-`),
  Google (`AIza`) or Stripe live (`sk_live_`, `rk_live_`) pattern; all pass `redactSecrets` unmasked.
- **L37c.** `writeTranscriptDoc` (`native/session/transcript-store.ts:71-77`), the transcript image publish
  (`transcript-images.ts:57`), `archiveTranscript` (`transcript-archive.ts:46-49`) and `writeMeta`
  (`session-store/storage.ts:167-178`) write with the default create mode, so conversation content lands 0644.
- **L28.** In `createPiProtocol` (`packages/nax-ai/src/protocols/pi-client.ts:349-368`) a `toolcall_end` whose
  arguments fail to parse yields a `bad-request` error and returns before the terminal event's usage, so the hop's
  tokens are lost.

`packages/nax`:

- **L1.** The fatal handlers in `execution/crash-signals.ts` (signal `:191-221`, uncaught exception, unhandled
  rejection) never release `nax.lock` or the feature lock. A holder with the same PID counts as alive, so a restart
  that reuses the PID (a container's PID 1) is refused.
- **L2.** `WorktreeManager.create` (`worktree/manager.ts:378-395`) symlinks `<root>/.env` into the new worktree. When
  `.env` is tracked, `git worktree add` has already checked it out, `symlinkSync` throws EEXIST, and the worktree is
  removed: every worktree creation fails.
- **L4.** `SessionManager.openSessionImpl` (`session/manager.ts:427-429`) drops a cached live handle whose descriptor is
  terminal without closing it. A `keepOpen` turn aborted mid-flight leaves the descriptor `FAILED` (`:598-602`) with
  the adapter session still open, so the old agent process runs until the end-of-run sweep.
- **L5.** `runLoop` (`agents/acp/turn-loop.ts:252-271`) asks the human (`nextPrompt`, up to the interaction timeout)
  after the last allowed turn, then discards the answer because the loop bound is spent.
- **L6.** `waitForChecks` (`workflow/ci-wait.ts:383-445`) checks the abort signal once per poll; the sleep between
  polls (`waitWithHeartbeat`, `:284-296`, default `Bun.sleep`) ignores it, so an abort waits up to a full poll
  interval (default 30s).
- **L10.** `adjudicateResidual` (`workflow/adjudicate.ts:8-36`) catches every advisor error, including an abort, writes
  default-hold rulings to the ledger and returns, so an aborted story is closed as if adjudicated.
- **L12.** `openOrPromotePr` (`finish/pr/open.ts:126-168`) views the branch's PR with fields `isDraft,url` only. `gh pr
  view <branch>` also returns a CLOSED or MERGED PR, which is then reported `already-ready` with a dead URL; the
  function's own doc says a closed PR should lead to a new one.
- **L29.** `spawnGitWithDeadline` (`execution/deferred-review.ts:40-63`) returns stdout without checking the exit code,
  so a failed `git diff` gives plugin reviewers `[]`, the same as "no changes".
- **L17.** `contentRecord` (`chat/mentions/mention-expand.ts:215-223`) reads any non-directory with
  `Bun.file().arrayBuffer()`; an `@` mention of a FIFO hangs the chat send.
- **L18.** `BackgroundTaskRegistry.output` (`chat/background/task-registry.ts:254-267`) reads the whole log (up to
  `TASK_LOG_MAX_BYTES`, 50 MiB) through `_backgroundTaskDeps.readLog` to return at most 500 lines.
- **L16.** `runSingleCommand` (`quality/runner.ts:236-251`) drains stdout and stderr with no deadline on the
  non-timeout path. A background child that keeps the pipe open (`sleep 20 & echo lint-clean`) holds the drain until
  the kill timer fires, turning a passing command into `timedOut: true`.
- **L34.** `capText` (`prompts/builders/rectifier-builder-helpers.ts:253-256`) and the two inline cuts in
  `rectifier-builder.ts` (`:135-138`, `:433-436`) keep the head of gate output, dropping the failure summary most
  tools print last.
- **L20.** `handleRequest` (`interaction/plugins/webhook.ts:492-570`) delivers a signed body to the `requestId` taken
  from the URL without comparing it to `body.requestId`, so a valid body can be delivered to another pending request.
- **L22.** `loadPRD` (`prd/index.ts:116-134`) guards the top-level shape but not each story; `"userStories":[null]`
  throws a native TypeError (`story.attempts`) instead of `PRD_INVALID`.
- **L24.** `nax run --no-context` is declared (`bin/nax.ts:235`) and documented, but nothing on the run path reads it.
- **L25.** `nax config -d <dir>` resolves the config from `<dir>` (`bin/nax.ts:861-871`), but `configCommand`'s
  `--diff` and source listing read the project of the current directory (`cli/config-display.ts:52`, `:56`;
  `cli/config-get.ts:49-55`).
- **L27.** `resolveString` (`config/dotenv.ts:193-213`) substitutes `${X}` and then scans the result for `$NAME`, so a
  substituted value is expanded a second time (`X='$Y'`, `Y=zzz` resolves `"${X}"` to `zzz`).

## Design

### Integration

The baseline signatures below exist only to locate the code; the **Target** text is the interface to implement.

Symbols read, not changed:

- `resolveWithin`, `getAgentRuntime().globSync` — nax-agent tools (context for US-001 only).
- `redactSecrets<T>(input: T): T` — `packages/nax-agent/src/internal/redact.ts:150`.
- `saveTranscript(dir, sessionName, messages, identity?)`, `transcriptPath(dir, sessionName)`,
  `transcriptImagesPath(path)`, `archiveTranscript(...)` (`native/session/transcript-archive.ts:36`),
  `createSessionStorage(deps).writeMeta(meta)` — nax-agent session files.
- `writeFileAtomic(path, content, { mode? })` — `packages/nax-agent/src/internal/atomic-write.ts:124`.
- `toTokenUsage`, `totalTokens` — `packages/nax-ai/src/usage.ts`.
- `releaseLock(workdir)` (`execution/lock.ts:405`, unconditional unlink), `releaseFeatureLock({ outputDir, feature,
  runId })` (`execution/feature-lock.ts:367`, leaves a lock whose runId differs).
- `cancellableDelay(ms, signal?)` — `packages/nax/src/utils/bun-deps.ts:72` (rejects on abort).
- `viewArgv(forge, branch, githubFields)` — `packages/nax/src/forge/pr.ts:23`.
- `findProjectDir(startDir)`, `determineConfigSources(startDir?)` — `cli/config-display.ts:129`.

Symbols changed:

- **US-001** `buildGrepArgv(binary, pattern, path, patternType?)` — Target: the `"grep"` branch returns
  `["grep", "-r", "-n", "--exclude-dir=.git", modeFlag, "--", pattern, target]`; the `"rg"` branch is unchanged.
- **US-001** `readPrefix(path: string, maxBytes: number): Promise<string>` — Target: same signature; opens with
  `constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)` from `node:fs`, checks the opened handle's `stat().isFile()`, and
  when false closes the handle and throws `NaxError` code `READ_NOT_REGULAR_FILE`, message `"<path>" is not a regular
  file`, context `{ stage: "read", path }`. A regular file reads as today. nax-agent ships Node-compatible source, so
  this stays on `node:fs/promises`.
- **US-002** `SECRET_VALUE_PATTERNS` — Target: three more entries after `aws`:
  `{ kind: "gitlab", re: /glpat-[A-Za-z0-9_-]{20,}/g }`, `{ kind: "google", re: /AIza[0-9A-Za-z_-]{35}/g }`,
  `{ kind: "stripe", re: /\b[sr]k_live_[0-9A-Za-z]{16,}/g }`.
- **US-002** session file writers — Target: `writeTranscriptDoc`, `publishImageOnce` (through
  `_transcriptImagesDeps.writeFileAtomic`) and `archiveTranscript` pass `{ mode: 0o600 }` to `writeFileAtomic`;
  `writeMeta` passes `{ mode: 0o600 }` to `writeFile`. Directory modes are unchanged.
- **US-003** `createPiProtocol(...).stream`, `toolcall_end` case — Target: when `parseToolArgs` throws, remember the
  `bad-request` error (same message and cause as today) instead of yielding it and enter a draining state. While
  draining, every event other than `done` and `error` is ignored. On `done`: yield `{ type: "usage", usage:
  toTokenUsage(event.message.usage) }`, then the remembered error, then return (no `done`). On upstream `error`: as
  today, yield the upstream usage when `totalTokens(usage) > 0`, then run the existing abort check (an aborted request
  signal still throws its abort), then yield the remembered error instead of the upstream one, then return. If the
  upstream iterator ends while draining, yield the remembered error after the loop. If the upstream iterator throws
  while draining, the existing catch rethrows an abort as today; otherwise it yields the remembered error instead of
  the classified throw. A stream never yields more than one `error` event. The drain is bounded by the request's own timeout and abort signal, as the rest of the stream already is.
- **US-004** `CrashRecoveryContext` / `SignalHandlerContext` — Target: new optional field
  `releaseLocks?: () => Promise<void>`. Each of the three fatal handlers (signal, uncaught exception, unhandled
  rejection) awaits `ctx.releaseLocks?.()` after `clearHiddenNaxIndexFlags(ctx)` and before `cancelDeadline()` and
  `_crashSignalsDeps.exit(...)`, so the teardown deadline still bounds it; a rejection is caught and logged at warn, and the exit code is unchanged.
- **US-004** `setupRun` (`execution/lifecycle/run-setup.ts`) — Target: passes `releaseLocks: async () => { await
  releaseRunLocks?.(); }` to `installCrashHandlers`, a forwarder over a local `releaseRunLocks` that stays `undefined`
  until BOTH the checkout lock and the feature lock are acquired, and is then set to release the feature lock
  (`releaseFeatureLock({ outputDir: runtime.outputDir, feature, runId })`) and then `releaseLock(workdir)`. The same
  pattern as the existing `sealApprovals` forwarder. `run-setup.ts` is 582 lines against the 600-line limit; if the
  change would cross it, move the lock-acquisition block into a helper module.
- **US-004** `WorktreeManager.create(projectRoot, worktreeId)` — Target: when `<worktreePath>/.env` already exists
  (checked with `lstat`), skip the symlink and log at debug
  `".env is tracked; the worktree keeps the checked-out copy"`; otherwise symlink as today.
- **US-005** `SessionManager.openSessionImpl` — Target: when a live handle exists and its name is in
  `_cancelledSessions` (the turn was aborted), the reopen closes it with `this.closeSession(liveHandle, true)` instead
  of only dropping it. A terminal descriptor that was not cancelled keeps today's drop (its adapter session is already
  closed). `session/manager.ts` is grandfathered at 650 lines and may not grow: fold the condition into the existing
  `close-then-reopen` branch.
- **US-005** `runLoop` — Target: after `state.output = outcome.output`, `if (used(state) >= loop.max) break;` before
  `nextPrompt`, so no human question or context-tool request is issued after the last allowed turn.
- **US-006** `_ciWaitDeps.sleep` — Baseline: `(ms: number) => Promise<void>` over `Bun.sleep`. Target:
  `(ms: number, signal?: AbortSignal) => Promise<void>` that resolves when `ms` elapses or as soon as `signal` aborts
  (built on `cancellableDelay`, with the abort rejection turned into a resolve). `waitWithHeartbeat` takes
  `opts.signal`, passes it to every `_ciWaitDeps.sleep` call and stops slicing once it is aborted; the loop's existing
  top-of-loop check then returns `end("pending", "aborted")`.
- **US-006** `adjudicateResidual(advisor, req, ledger, aborted?: () => boolean)` — Target: in the catch, when
  `aborted?.()` is true, rethrow the advisor's error before any default hold or ledger write. `StoryLoopEnv` gains
  `readonly aborted?: () => boolean`; `buildStoryEnv` (`workflow/stage-env.ts:49`) sets it to
  `() => ctx.abortSignal?.aborted === true`; `residualStep` passes `env.aborted`; `buildFeatureEnv`'s `adjudicate`
  passes `() => fc.runSignal?.aborted === true`.
- **US-007** `parseView(stdout, forge)` — Baseline: returns `{ isDraft: boolean; url?: string }`. Target: returns
  `{ isDraft: boolean; url?: string; closed: boolean }`, `closed` true when GitHub's `state` is `"CLOSED"` or
  `"MERGED"`, or GitLab's `state` is `"closed"` or `"merged"`; false when `state` is absent or anything else.
  `openOrPromotePr` (both view calls) requests GitHub fields `"isDraft,url,state"`. A view that succeeds with
  `closed: true` is handled exactly like a failed view: the non-`keepDraft` path creates the PR (`opened`), the
  `keepDraft` path creates a draft (`draft`).
- **US-007** `spawnGitWithDeadline` — Target: returns `{ stdout: string; exitCode: number; timedOut: boolean }`.
  `captureRunStartRef` returns `""` unless `exitCode === 0` and not timed out. `getChangedFilesForDeferred` returns
  `{ ok: true; files: string[] } | { ok: false; error: string }`, the error naming `git diff` and the exit code (or
  `timed out`). On `ok: false`, `runDeferredReview` calls no reviewer and returns `changedFiles: []`, `anyFailed: true`
  and one `reviewerResults` entry per reviewer with `passed: false`, `output: ""` and `error` set to that message.
- **US-008** `_mentionExpandDeps.stat` — Baseline: returns `{ isDirectory: boolean; size: number }`. Target: returns
  `{ isDirectory: boolean; size: number; special?: true }`; the default sets `special: true` only when the path is
  neither a regular file nor a directory (FIFO, socket, device) and omits the key otherwise, so existing test stubs
  that return `{ isDirectory, size }` keep modelling regular files. `contentRecord` returns
  `pathOnly(located.path, "path only: not a regular file")` for a special path, before any read.
- **US-008** `_backgroundTaskDeps.readLog` — Target: same signature `(path: string) => Promise<string>`; the default
  reads at most the last `TASK_LOG_TAIL_BYTES` (new exported constant, 2 MiB) through `Bun.file(path).slice(start)`,
  and when it started mid-file and the byte before the slice is not a newline, drops everything up to and including
  the first newline of the slice, so the result starts on a line boundary; a slice with no newline is returned as is. A file at or under the cap is read whole. `output()` is unchanged.
- **US-009** `runSingleCommand` stream collection — Target: `STREAM_DRAIN_TIMEOUT_MS` (2 000) is exported, and the
  drain deadlines are armed and cleared through `_qualityRunnerDeps.setTimeout` / `_qualityRunnerDeps.clearTimeout`
  so tests can fire them. On the non-timeout path the kill timer is cleared as soon as the leader exits, before the
  drain, so it cannot fire during the drain window. stdout and stderr are collected chunk by chunk, so the text
  read so far is available at any moment. After the leader exits, on both the timeout and the non-timeout path, each
  stream gets `STREAM_DRAIN_TIMEOUT_MS` to finish; at the deadline the text read so far is used. On the non-timeout
  path, when a stream missed the deadline, the process group is sent `SIGTERM` through
  `_qualityRunnerDeps.killProcessGroup(proc.pid, "SIGTERM", { singleProcessFallback: false })` so the pipe-holding
  child does not outlive the call. `success`, `exitCode` and `timedOut: false` come from the leader's exit as today.
- **US-009** `capText` — Target: replaced by exported `capTail(value: string, maxChars: number): string` in
  `rectifier-builder-helpers.ts`. At or under `maxChars` it returns `value`. Over it, it keeps the last `maxChars`
  characters, drops a leading partial line when the kept text has a newline before its last character, and prefixes
  `... (truncated — ${value.length} chars total; showing the last ${kept.length})\n`. `formatCheckError`,
  `renderCheckBlock` and the `noOpReprompt` loop use `capTail` with their existing limits (1 000 / 4 000).
  `rectifier-builder.ts` is grandfathered at 751 lines and may not grow; the two inline cuts collapse to calls.
- **US-010** `handleRequest` — Target: after `InteractionResponseSchema.parse`, when `response.requestId !== requestId`
  return `new Response("Bad Request: requestId mismatch", { status: 400 })` without delivering. `webhook.ts` is 597
  lines; keep it at or under 600.
- **US-010** `loadPRD` — Target: after the top-level guard, the first `userStories[i]` that is `null`, an array or not
  an object throws `NaxError` `PRD_INVALID`, message `PRD file has a non-object story at userStories[${i}]: ${path}`,
  context `{ stage: "prd", path, index: i }`.
- **US-011** `parseRunPreconditionFlags(options)` (`bin/run-action.ts:131`) — Target: `RunActionOptions` gains
  `context?: boolean`; after the `--no-batch` check, `options.context === false` prints
  `nax run --no-context was removed: workflow mode builds each prompt's context itself` and exits 1. The
  `--no-context` help text in `bin/nax.ts` becomes `Removed: workflow mode builds its own prompt context`, and the row
  in `docs/guides/cli-reference.md:169` says the flag was removed.
- **US-011** `loadProjectConfig(startDir?: string)` — Target: resolves `findProjectDir(startDir ?? process.cwd())`.
  `ConfigCommandOptions` gains `dir?: string`; `configCommand` passes it to `determineConfigSources` and
  `loadProjectConfig`. The non-JSON `config` action body in `bin/nax.ts` (after `validateDirectory`) moves into a new
  exported `configDisplayAction(options: { dir: string; explain?: boolean; diff?: boolean; profile?: string[] }):
  Promise<void>` in `src/cli/config-display-action.ts`, which resolves `findProjectDir(dir)`, loads the config with the
  profile, and calls `configCommand(config, { explain, diff, profile, dir })`; the bin action calls it with
  `dir: workdir`.
- **US-011** `resolveString` — Target: one combined pass
  `/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g` replaces both forms, so a substituted value is never
  rescanned. The `$$` protect and restore steps are unchanged.

### Failure Handling

| Story | Situation | Behaviour |
|:---|:---|:---|
| US-001 | `readPrefix` on a FIFO, socket, directory or device | Rejects `READ_NOT_REGULAR_FILE` without blocking; `Read` returns `isError: true` with that message (its existing catch). |
| US-003 | pi stream: arguments unparseable, then `done` | That message's usage, then the `bad-request` error; no `tool-call`, no `done`. |
| US-003 | pi stream: arguments unparseable, then upstream `error` | Upstream usage when non-zero; an aborted signal throws its abort; else the `bad-request` error only. |
| US-003 | pi stream: arguments unparseable, then the iterator ends or throws | The `bad-request` error only (an abort still rethrows). |
| US-004 | `releaseLocks` rejects in a fatal handler | Logged at warn; the handler still exits with its code. |
| US-004 | A fatal signal before both locks are held | `releaseLocks` is a no-op; no lock file is removed. |
| US-006 | Advisor call rejects while the run is aborted | The error is rethrown; no ruling is written. |
| US-007 | `git diff` exits non-zero or times out | No reviewer runs; every reviewer is reported failed with the diff error. |
| US-008 | Mention of a special file | Path-only record `path only: not a regular file`; no read. |
| US-009 | A child holds the output pipe after the leader exits | Output read so far is used; the group gets `SIGTERM`; the result follows the leader's exit code. |
| US-010 | Webhook body `requestId` differs from the URL | 400, nothing delivered. |
| US-010 | `userStories` holds a non-object | `PRD_INVALID` naming the index. |

## Out of Scope

- US-001 only: review L37b (`ScratchpadList` checks a glob hit against the repo root instead of the scratchpad) is dropped by evidence: both runtimes' `globSync` never return a symlink for a `**/*` pattern (Bun scans with `onlyFiles` and `followSymlinks: false`; `node-glob.ts` keeps a symlink only for a literal pattern), so no symlinked entry reaches the check.
- US-001 only: Bash writes to `.claude/settings.local.json` outside the OS sandbox (review L14's second half): the sandboxed path is already denied by `policy-builder.ts:212`.
- US-002 only: existing transcript, image, archive and session metadata files already on disk keep their mode until next written; directory modes are unchanged.
- US-002 only: Stripe test keys (`sk_test_`, `rk_test_`) and vendor key formats beyond `glpat-`, `AIza`, `sk_live_` and `rk_live_` are not added to the redactor.
- US-001 only: `readPrefix` on Windows: `O_NONBLOCK` is absent there and treated as `0`; FIFO behaviour on Windows is not tested.
- US-004 only: a run killed by `SIGKILL` or the OOM killer still leaves its locks; only the catchable fatal paths release them.
- US-007 only: the `git diff` timeout branch shares the non-zero-exit handling but has no AC of its own (it needs the 30s `GIT_TIMEOUT_MS` to elapse).
- US-011 only: the `nax config --json` path is unchanged; it already takes `dir`.
- US-011 only: the `--no-context` help text in `bin/nax.ts` and the row in `docs/guides/cli-reference.md` are prose updates with no AC of their own.
- US-001 only: `readFileSlice` (`tools/read-file.ts:70`, behind `ScratchpadRead`) has the same open-without-type-check shape, but it only reads inside the agent's own scratchpad, so a FIFO there is one the agent made itself.
- US-004 only: a fatal signal that arrives after normal cleanup released the locks but before the crash handlers are removed may release again; `releaseFeatureLock` checks the runId and the checkout-lock unlink tolerates a missing file.
- US-010 only: the webhook callback gains no nonce or timestamp and its HMAC still covers only the body; replay of a delivered reply is already refused because delivery clears the pending request id, and the URL/body `requestId` check closes the cross-request case.
- Review L7 (`workflow promote` binds the CI wait to local HEAD) is dropped by ruling: it fails closed as `unavailable`.
- Review L8 (`listUncommitted` hides every `.nax/` path) is dropped by ruling: it is a policy choice about which `.nax/` files nax owns.
- Review L9 (the approval advisor has no cost check when `plan.base` is empty) is dropped by ruling: one extra advisor call at most.
- Review L11 (an unreviewed story does not block PR readiness) is dropped by ruling: it is a policy call and today's behaviour stays.
- Review L13 (a failed CI poll from an older head SHA is terminal) is dropped by ruling: a GitLab timing edge, rated plausible.
- Review L15 (scoped lint's degraded branch fails open on absolute paths) is dropped by ruling: it is unreachable today.
- Review L3 (feature-lock reclaim has no `.reclaim` mutex) and L19 (a queued TUI mode or model switch is lost while the close confirmation is open) are dropped by ruling: L3 needs three nax runs racing for one feature lock, and L19 is a narrow UI edge rated plausible.
- Review L23 (`release tag` does not compare local HEAD with `origin/main`) is dropped by ruling: it needs a maintainer to tag the wrong commit.
- Review L26 (the nax-ai credential lock wait is about 3.6s against a 10s stale window) is dropped by ruling: it bites only while another holder keeps the lock past 3.6s.
- Review L30 (a stalled loop is reported as `max-iterations`) is dropped by ruling: message only.
- Review L31 (koda approvals read-modify-write is per-process only) stays out of scope per the F3 ruling.
- Review L32 and L33 (backtracking regexes in lint/typecheck text parsing and scope globs) are dropped by ruling: the inputs are tool output or repo-authored patterns and need extreme depth.
- Review L35, L36 and L37d are dropped by ruling: L35 (nax-agent-acp tool events capped silently at 512 per turn) needs more than 512 tool calls in one turn; L36 (`retryAfter` above about 24.8 days overflows `setTimeout`) needs a value no real server sends; L37d (session-lock same-PID takeover and the ACP registry `session/load` race) needs a reused PID or two concurrent loads of one session.

## Stories

Eleven independent stories, none depending on another. The repo is a Bun-workspace monorepo; each story has one
`Workdir`. The user bundled the whole LOW sweep into one feature; it is a bundle of independent fixes, so each story
stands alone.

### US-001: Read-side tools never search `.git` or hang on special files

Workdir: packages/nax-agent. No dependencies.

Fix review L14 (grep half) and L37a. `buildGrepArgv`'s grep fallback excludes `.git`; `readPrefix` refuses non-regular
files without blocking, so `Read` on a FIFO returns an error at once.

### US-002: Secrets are masked in logs and session files are owner-only

Workdir: packages/nax-agent. No dependencies.

Fix review L21 and L37c: three redactor patterns, and mode 0600 on transcript, image, archive and session metadata
writes.

### US-003: The pi stream keeps a turn's usage when tool arguments fail to parse

Workdir: packages/nax-ai. No dependencies.

Fix review L28: after unparseable tool arguments the stream drains to the terminal event, yields its usage, then one
`bad-request` error.

### US-004: A crashed run frees its locks, and a tracked `.env` no longer breaks worktrees

Workdir: packages/nax. No dependencies.

Fix review L1 and L2: the fatal handlers release the run's locks through a `releaseLocks` forwarder wired by
`setupRun` once both locks are held; `WorktreeManager.create` keeps a checked-out `.env` instead of failing.

### US-005: Aborted sessions are closed on reopen, and the turn loop never asks after its last turn

Workdir: packages/nax. No dependencies.

Fix review L4 and L5.

### US-006: Workflow waits and adjudication honour abort

Workdir: packages/nax. No dependencies.

Fix review L6 and L10: the CI wait's sleep wakes on abort; an advisor failure during an abort propagates instead of
closing the story with default holds.

### US-007: A closed PR is not reused, and a failed diff is not "no changes"

Workdir: packages/nax. No dependencies.

Fix review L12 and L29.

### US-008: Chat mentions refuse special files, and task output reads only the log tail

Workdir: packages/nax. No dependencies.

Fix review L17 and L18.

### US-009: Quality commands survive a pipe-holding child, and rectifier prompts keep the output tail

Workdir: packages/nax. No dependencies.

Fix review L16 and L34.

### US-010: Webhook replies must name their request, and a null story is `PRD_INVALID`

Workdir: packages/nax. No dependencies.

Fix review L20 and L22.

### US-011: `--no-context` is reported removed, `config -d` diffs the named project, and `.env` values expand once

Workdir: packages/nax. No dependencies.

Fix review L24, L25 and L27.

### Context Files

**US-001**

- `packages/nax-agent/src/tools/grep.ts`
- `packages/nax-agent/src/internal/bounded-io.ts`
- `packages/nax-agent/src/tools/read.ts`
- `packages/nax-agent/test/unit/tools/grep.test.ts` — the `buildGrepArgv` cases and the `_grepDeps` stubs; US-001 grep cases go here
- `packages/nax-agent/test/unit/tools/buffering-ceilings.test.ts` — the `readPrefix` cases; US-001 FIFO, directory and symlink cases go here

**US-002**

- `packages/nax-agent/src/internal/redact.ts`
- `packages/nax-agent/src/native/session/transcript-store.ts`
- `packages/nax-agent/src/native/session/transcript-images.ts`
- `packages/nax-agent/src/native/session/transcript-archive.ts`
- `packages/nax-agent/src/session-store/storage.ts`

**US-003**

- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/test/protocols/pi-client.test.ts` — the `drain` and `message` helpers and the unparseable-arguments case at `:618`

**US-004**

- `packages/nax/src/execution/crash-signals.ts`
- `packages/nax/src/execution/crash-recovery.ts`
- `packages/nax/src/execution/lifecycle/run-setup.ts`
- `packages/nax/test/unit/execution/lifecycle/run-setup-approvals-seal.test.ts` — the forwarder test pattern to mirror for `releaseLocks`
- `packages/nax/src/worktree/manager.ts`

**US-005**

- `packages/nax/src/session/manager.ts`
- `packages/nax/src/session/endpoint-identity.ts`
- `packages/nax/src/agents/acp/turn-loop.ts`
- `packages/nax/test/unit/agents/acp/turn-loop.test.ts` — `scriptedOpened`, `replyTurn` and `answering` helpers

**US-006**

- `packages/nax/src/workflow/ci-wait.ts`
- `packages/nax/src/workflow/adjudicate.ts`
- `packages/nax/src/workflow/story-steps.ts` — `residualStep`
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`'s `adjudicate`

**US-007**

- `packages/nax/src/finish/pr/open.ts`
- `packages/nax/src/forge/pr.ts` — `viewArgv`
- `packages/nax/src/execution/deferred-review.ts`
- `packages/nax/test/unit/finish/pr-open.test.ts`
- `packages/nax/test/unit/execution/deferred-review.test.ts` — `makeSpawnForDiff`

**US-008**

- `packages/nax/src/chat/mentions/mention-expand.ts`
- `packages/nax/test/unit/chat/mentions/mention-expand.test.ts`
- `packages/nax/src/chat/background/task-registry.ts`
- `packages/nax/test/unit/chat/background/task-registry.test.ts`

**US-009**

- `packages/nax/src/quality/runner.ts`
- `packages/nax/test/unit/quality/runner.test.ts`
- `packages/nax/src/prompts/builders/rectifier-builder-helpers.ts`
- `packages/nax/src/prompts/builders/rectifier-builder.ts`
- `packages/nax/test/unit/prompts/builders/rectifier-builder.test.ts`

**US-010**

- `packages/nax/src/interaction/plugins/webhook.ts`
- `packages/nax/test/unit/interaction/interaction-plugins.test.ts` — the signed-callback cases (`X-Nax-Signature`)
- `packages/nax/src/prd/index.ts`
- `packages/nax/test/unit/prd/load-errors.test.ts`

**US-011**

- `packages/nax/bin/run-action.ts`
- `packages/nax/test/unit/cli/run-action.test.ts` — the removed-flag cases
- `packages/nax/src/cli/config-display.ts`
- `packages/nax/src/cli/config-get.ts`
- `packages/nax/src/config/dotenv.ts`
- `packages/nax/bin/nax.ts` — the `config` action and the `--no-context` option

### Creates

**US-002**

- `packages/nax-agent/test/unit/native/transcript-store-modes.test.ts` — the 0600 cases for transcript, image and archive writes; the session metadata case goes in `test/unit/session-store/storage-hardening.test.ts`.

**US-003**

- `packages/nax-ai/test/protocols/pi-client-tool-args.test.ts` — the US-003 cases; `pi-client.test.ts` is already 984 lines. Copy its `drain`, `message`, `fakePi`, `BASE` and `MODEL` helpers.

**US-004**

- `packages/nax/test/unit/execution/lifecycle/run-setup-crash-locks.test.ts` — the `setupRun` `releaseLocks` forwarder cases.

**US-009**

- `packages/nax/test/unit/quality/runner-drain.test.ts` — the US-009 runner cases; `runner.test.ts` is 695 lines.

**US-011**

- `packages/nax/src/cli/config-display-action.ts` — `configDisplayAction`, the `config` action body moved out of `bin/nax.ts`.

### Modifies

**US-007**

- `packages/nax/test/unit/finish/pr-open.test.ts` — the two `parseView` cases in `describe("parseView")` (`:48-52` and `:55-57`) assert `toEqual({ isDraft, url })`; `parseView` now also returns `closed`. Add `closed: false` to both expected objects (neither reply carries a closed state); no other assertion changes.

No other story changes an existing test. The `buildGrepArgv` tests assert `slice(0, 2)` and membership, which the
inserted flag keeps; the `readPrefix` tests read regular files; no transcript or storage test asserts a 0644 mode; the
pi-client unparseable-arguments case asserts the first event is the text delta and the last is the `bad-request`
error, which the drain keeps. The new context, env and option fields (`releaseLocks`, `StoryLoopEnv.aborted`, the
`aborted` argument of `adjudicateResidual`, `ConfigCommandOptions.dir`, `RunActionOptions.context`) are optional, so
existing builders still typecheck; the CI-wait sleep stubs take `(ms)`, which still fits `(ms, signal?)`; the mention
stat stubs return `{ isDirectory, size }`, which the optional `special` key keeps valid, and the default-stat test
compares regular entries that carry no `special` key; the task-registry tests stub `readLog`; the other pr-open mocks
carry no `state`, which reads as open; the rectifier tests assert `truncated`, `10000 chars total` and a capped
character count, all kept by `capTail`; and the turn-loop budget test asserts prompt and round-trip counts, which stay 2.

### Seams

- US-004: `releaseLocks` is a new context field; its producer is `setupRun` (wired into `_runSetupDeps.installCrashHandlers`) and its consumers are the three fatal handlers installed by `installSignalHandlers`. US-004 AC1-AC3 drive the handlers; AC7-AC9 drive `setupRun` and call the captured forwarder.
- US-006: `StoryLoopEnv.aborted` is new; producer `buildStoryEnv`, consumer `residualStep` reached through `runStoryLoop` (AC10). `adjudicateResidual`'s `aborted` is reached from `residualStep` and `buildFeatureEnv`'s `adjudicate` (AC11).
- US-008: `TASK_LOG_TAIL_BYTES` is new and exported; its consumer is the default `readLog`, reached through `createBackgroundTasks(options).output` (AC9).
- US-011: `configDisplayAction` is new and exported; its consumer is the `config` command action in `bin/nax.ts`. AC4 and AC5 drive it.
- US-009: `capTail` is new and exported from `rectifier-builder-helpers.ts`; its consumers are `RectifierPromptBuilder.firstAttemptDelta`, `noOpReprompt` and `reviewRectification` (AC10-AC12).
- Regression guards that already pass before the fix: US-001 AC3, AC7, AC9; US-002 AC6; US-003 AC2, AC3, AC5, AC6, AC8; US-004 AC4, AC5, AC11, AC12; US-005 AC2, AC3, AC4; US-006 AC2, AC4, AC7, AC8; US-007 AC11, AC12; US-008 AC4, AC6, AC7, AC9, AC10; US-009 AC3, AC4, AC6, AC8; US-010 AC3, AC6; US-011 AC2, AC7, AC8, AC9. Every story keeps at least one fail-first AC.

## Acceptance Criteria

### US-001

1. [unit] `buildGrepArgv("grep", "needle", undefined, "literal")` returns an argv in which `"--exclude-dir=.git"` appears at an index lower than the index of `"--"`.
2. [unit] `buildGrepArgv("grep", "fo+|bar", undefined, "regex")` returns an argv in which `"--exclude-dir=.git"` appears at an index lower than the index of `"--"`.
3. [unit] `buildGrepArgv("rg", "needle", undefined, "literal")` returns an argv that omits `"--exclude-dir=.git"`.
4. [unit] With `_grepDeps.which` returning `null` for `"rg"` (the grep fallback), `grepTool.run` with pattern `"secret-marker-123"` and no path, in a temp git repo whose `.git/config` and `src/a.txt` both hold `"secret-marker-123"`, returns content with a row for `src/a.txt` and no row whose path includes the segment `.git/`.
5. [unit] `readPrefix` on a named pipe (FIFO) with no writer rejects within 2 seconds with a `NaxError` whose `code` is `"READ_NOT_REGULAR_FILE"` and whose message names the pipe's path; the test skips when the `mkfifo` utility is unavailable.
6. [unit] `readPrefix` on a directory rejects with a `NaxError` whose `code` is `"READ_NOT_REGULAR_FILE"`.
7. [unit] `readPrefix(path, 100)` on a regular 500-byte file returns its first 101 bytes as UTF-8.
8. [unit] `readTool.run({ path: "pipe" }, ctx)`, where `pipe` is a FIFO inside the tool root with no writer, resolves within 2 seconds to a result with `isError: true` whose content includes `"is not a regular file"`.
9. [unit] `readPrefix` on a symlink whose target is a regular file returns the target file's content.

### US-002

1. [unit] `redactSecrets("push failed: glpat-ABCDEFGHIJKLMNOPqrst12")` returns `"push failed: [REDACTED]"`.
2. [unit] `redactSecrets("key=AIzaSyA1234567890abcdefghijklmnopqrstuv")` returns a string that includes `"[REDACTED]"` and omits `"AIzaSyA1234567890abcdefghijklmnopqrstuv"`.
3. [unit] `redactSecrets("charge with sk_live_51ABCDEFGHijklmnopQRSTuv")` returns `"charge with [REDACTED]"`.
4. [unit] `redactSecrets("restricted rk_live_51ABCDEFGHijklmnopQRSTuv")` returns `"restricted [REDACTED]"`.
5. [unit] `SECRET_VALUE_PATTERNS` holds entries whose `kind` values include `"gitlab"`, `"google"` and `"stripe"`.
6. [unit] `redactSecrets("see glpat-short and AIzaShort and ask_live_x")` returns the input unchanged.
7. [unit] After `saveTranscript(dir, "s1", messages)` with a text-only message list, the file at `transcriptPath(dir, "s1")` has permission bits `0o600`.
8. [unit] After `saveTranscript(dir, "s2", messages)` where one message carries a base64 image part, every file under `transcriptImagesPath(transcriptPath(dir, "s2"))` has permission bits `0o600`.
9. [unit] After `archiveTranscript` archives a stored transcript, the archived `<sessionId>.transcript.<stamp>.json` file has permission bits `0o600`.
10. [unit] After `createSessionStorage(deps).writeMeta(meta)`, the session metadata file it writes has permission bits `0o600`.
11. [unit] When a file already exists at `transcriptPath(dir, "s3")` with mode `0o644`, a later `saveTranscript(dir, "s3", messages)` leaves the file at that path with permission bits `0o600`.

### US-003

1. [unit] A pi stream of `text_delta`, `toolcall_delta` with delta `'{"path"'`, `toolcall_end`, then `done` whose message usage reports 100 input and 20 output tokens yields a `usage` event with `inputTokens: 100` and `outputTokens: 20`, and its final event is an `error` with `kind: "bad-request"` that comes after that `usage` event.
2. [unit] The stream in AC1 yields no `tool-call` event and no `done` event.
3. [unit] A pi stream of `toolcall_delta` with delta `'{"path"'`, `toolcall_end`, a second `text_delta`, then `done` yields no `text-delta` event for the second delta.
4. [unit] A pi stream of `toolcall_delta` with delta `'{"path"'`, `toolcall_end`, then an upstream `error` event whose usage reports 50 input tokens yields a `usage` event with `inputTokens: 50`, then exactly one `error` event, with `kind: "bad-request"` and the message `Tool "read" returned unparseable arguments.`
5. [unit] A pi stream of `toolcall_delta` with delta `'{"path"'` and `toolcall_end`, after which the upstream iterator ends with no `done` or `error` event, yields as its final event an `error` with `kind: "bad-request"` and yields no `usage` event.
6. [unit] A pi stream whose tool arguments parse yields the `tool-call` event, then `usage`, then `done`.
7. [unit] A pi stream of `toolcall_delta` with delta `'{"path"'`, `toolcall_end`, then an upstream `error` event, read with a request `signal` that is already aborted, rejects with the signal's abort reason.
8. [unit] A pi stream of `toolcall_delta` with delta `'{"path"'` and `toolcall_end`, after which the upstream iterator throws a non-abort `Error("socket reset")`, yields exactly one `error` event, with `kind: "bad-request"`.

### US-004

1. [unit] The `SIGTERM` handler installed by `installSignalHandlers(ctx)` calls `ctx.releaseLocks` exactly once, and before `_crashSignalsDeps.exit` is called with `143`.
2. [unit] The uncaught-exception handler installed by `installSignalHandlers(ctx)` calls `ctx.releaseLocks` exactly once, before `_crashSignalsDeps.exit(1)`.
3. [unit] The unhandled-rejection handler installed by `installSignalHandlers(ctx)` calls `ctx.releaseLocks` exactly once, before `_crashSignalsDeps.exit(1)`.
4. [unit] When `ctx.releaseLocks` rejects, the `SIGTERM` handler still calls `_crashSignalsDeps.exit(143)`.
5. [unit] With no `ctx.releaseLocks`, the `SIGTERM` handler calls `_crashSignalsDeps.exit(143)`.
6. [unit] The `SIGTERM` handler calls `ctx.releaseLocks` after `ctx.statusWriter` has recorded the crashed status.
7. [integration] `setupRun` in a temp workdir with real checkout and feature locks, where `_runSetupDeps.installCrashHandlers` is stubbed to capture its context and the run setup completes, then calling the captured `releaseLocks()` removes `nax.lock` from the workdir, and a following `acquireFeatureLock` for the same feature with a different runId returns `acquired: true`.
8. [integration] `setupRun` where `_runSetupDeps.acquireLock` returns `{ acquired: false, holder }` (setup throws `LockAcquisitionError`), then a `nax.lock` written by another holder, then calling the captured `releaseLocks()`, leaves that `nax.lock` in place.
9. [integration] `setupRun` where `_runSetupDeps.acquireFeatureLock` returns `{ acquired: false, holder }` (setup throws), then a `nax.lock` written by another holder, then calling the captured `releaseLocks()`, leaves that `nax.lock` in place.
10. [integration] `WorktreeManager.create(projectRoot, id)` in a temp git repo whose committed, tracked `.env` holds `A=1` succeeds, and `<worktree>/.env` is a regular file (not a symlink) holding `A=1`.
11. [integration] `WorktreeManager.create(projectRoot, id)` in a temp git repo with an untracked, git-ignored `.env` makes `<worktree>/.env` a symlink to `<projectRoot>/.env`.
12. [integration] `WorktreeManager.create(projectRoot, id)` in a temp git repo with no `.env` creates no `<worktree>/.env`.

### US-005

1. [unit] `SessionManager.openSession(name, opts)`, then `sendPrompt` whose adapter `sendTurn` rejects with an `AbortError` while the signal is aborted, then `openSession(name, opts)` again, calls the adapter's `closeSession` exactly once with the first handle, before the adapter's second `openSession` call.
2. [unit] `SessionManager.openSession(name, opts)`, a successful `sendPrompt`, `closeSession(handle, true)`, then `openSession(name, opts)` again calls the adapter's `closeSession` exactly once in total.
3. [unit] After the abort-then-reopen sequence of AC1, `sendPrompt` on the new handle resolves with the adapter's turn result instead of throwing `SESSION_CANCELLED`.
4. [unit] After the abort-then-reopen sequence of AC1 with an adapter whose `closeSession` rejects, the second `openSession` still resolves to a new handle.
5. [unit] `runTurnLoop(session, "go", { interactionHandler, maxInteractions: 1 })` where the agent's reply is the question `"Should I proceed?"` calls `interactionHandler.onInteraction` zero times and returns `output` equal to `"Should I proceed?"`.
6. [unit] `runTurnLoop` with `maxInteractions: 2`, a handler answering `"a"` and `"b"`, and an agent whose every reply is a question calls `onInteraction` exactly once and sends exactly two prompts.
7. [unit] `runTurnLoop` with `maxInteractions: 3`, a handler answering `"a"`, `"b"` and `"c"`, and an agent whose every reply is a question calls `onInteraction` exactly twice.
8. [unit] `runTurnLoop` with `maxInteractions: 1` where the agent's reply is a context-tool call calls `onInteraction` zero times.

### US-006

1. [unit] The default `_ciWaitDeps.sleep(60_000, signal)` resolves (does not reject) within 200 ms after `signal`'s controller aborts.
2. [unit] The default `_ciWaitDeps.sleep(20)` with no signal resolves after at least 15 ms.
3. [unit] `waitForChecks(forge, pr, { cwd, timeoutMs, pollMs, signal })` with a pending first poll passes `signal` as the second argument of every `_ciWaitDeps.sleep` call.
4. [unit] `waitForChecks` with a pending first poll and a `_ciWaitDeps.sleep` stub that aborts the signal's controller and resolves returns `{ outcome: "pending", detail: "aborted" }` and runs no second poll command.
5. [unit] `waitForChecks` with `pollMs` three times `CI_WAIT_HEARTBEAT_MS` and a `_ciWaitDeps.sleep` stub that aborts on its first call calls `_ciWaitDeps.sleep` exactly once.
6. [unit] `adjudicateResidual(advisor, req, ledger, () => true)` where `advisor.ruleResidual` rejects with error `E` and `req` has two items rejects with `E` and calls `ledger` zero times.
7. [unit] `adjudicateResidual(advisor, req, ledger, () => false)` with the same rejecting advisor resolves to two default-hold rulings and calls `ledger` with two ruling lines.
8. [unit] `adjudicateResidual(advisor, req, ledger)` with no `aborted` argument and the same rejecting advisor resolves to two default-hold rulings.
9. [unit] `residualStep(env, state)` with `env.aborted` returning `true`, one open finding, and an advisor whose `ruleResidual` rejects rejects, and `env.sink.ledger` receives no ruling line.
10. [integration] `runStoryLoop(env)` with `env.aborted` returning `true`, steps that leave a finding open past `maxFixRounds`, and an advisor whose `ruleResidual` rejects rejects, and `env.sink.update` never receives `phase: "closed"`.
11. [unit] The `adjudicate` function of `buildFeatureEnv(fc, input, ctx)` with `fc.runSignal` aborted and an advisor whose `ruleResidual` rejects rejects with that error.
12. [unit] `buildStoryEnv` with a context whose `abortSignal` is aborted returns an env whose `aborted()` returns `true`, and with a non-aborted signal returns `false`.

### US-007

1. [unit] `parseView('{"isDraft":false,"url":"u1","state":"CLOSED"}', "github")` returns `closed: true`.
2. [unit] `parseView('{"isDraft":false,"url":"u1","state":"MERGED"}', "github")` returns `closed: true`, and `parseView('{"state":"merged"}', "gitlab")` returns `closed: true`.
3. [unit] `parseView('{"isDraft":false,"url":"u1","state":"OPEN"}', "github")` returns `closed: false`.
4. [unit] `parseView('{"isDraft":false,"url":"u1"}', "github")` returns `closed: false`.
5. [unit] `openOrPromotePr` on GitHub requests the PR view with the JSON field list `"isDraft,url,state"`.
6. [unit] `openOrPromotePr` on GitHub whose view returns `{"isDraft":false,"url":"u1","state":"CLOSED"}` runs `gh pr create` and returns `status: "opened"` with the created PR's URL.
7. [unit] `openOrPromotePr` on GitLab whose view returns `{"state":"closed","web_url":"u1"}` runs `glab mr create` and returns `status: "opened"`.
8. [unit] `openOrPromotePr` with `keepDraft: true` on GitHub whose view returns `{"isDraft":false,"url":"u1","state":"MERGED"}` creates a draft PR and returns `status: "draft"`.
9. [unit] `runDeferredReview(workdir, reviewConfig, plugins, "abc123")` with a `_deferredReviewDeps.spawn` stub whose `git diff` exits `128` calls no reviewer's `check`, returns `anyFailed: true`, `changedFiles: []`, and one `reviewerResults` entry per reviewer with `passed: false` and an `error` that includes `git diff` and `128`.
10. [unit] `captureRunStartRef(workdir)` with a `git rev-parse` stub that exits `128` with stdout `"HEAD\n"` returns `""`.
11. [unit] `runDeferredReview` with a `git diff` stub that exits `0` with empty stdout calls each reviewer's `check` with `[]`.
12. [unit] `runDeferredReview` with a `git diff` stub that exits `0` with stdout `"src/a.ts\nsrc/b.ts\n"` calls each reviewer's `check` with `["src/a.ts", "src/b.ts"]`.

### US-008

1. [unit] `expandChatMentions("see @pipe", { cwd: root, repoRoot: root })`, where `root` is a temp git work tree and `pipe` is a FIFO with no writer that git does not ignore, resolves within 2 seconds with a record for `pipe` whose `status` is `"path-only"`, `note` is `"path only: not a regular file"` and `body` is `""`; the test skips when `mkfifo` is unavailable.
2. [unit] The default `_mentionExpandDeps.stat` on a FIFO returns an object with `special: true`.
3. [unit] `expandChatMentions` with a `_mentionExpandDeps.stat` stub returning `{ isDirectory: false, size: 4, special: true }` for the mentioned path calls `_mentionExpandDeps.readBytes` zero times.
4. [unit] The default `_mentionExpandDeps.stat` on a one-byte regular file returns an object equal to `{ isDirectory: false, size: 1 }`.
5. [unit] The default `_backgroundTaskDeps.readLog` on a 10 MiB log file returns a string of at most `TASK_LOG_TAIL_BYTES` bytes that ends with the file's last line.
6. [unit] The default `_backgroundTaskDeps.readLog` on a log file larger than `TASK_LOG_TAIL_BYTES` returns a string whose first line is a complete line of the file.
7. [unit] The default `_backgroundTaskDeps.readLog` on a 1 KiB log file returns the whole file.
8. [unit] `TASK_LOG_TAIL_BYTES` equals `2 * 1024 * 1024`.
9. [integration] `createBackgroundTasks(options).output(id, 40)` for a task whose real log is 10 MiB of numbered lines returns exactly the file's last 40 lines.
10. [unit] `createBackgroundTasks(options).output(id, 500)` for a task whose real log has 600 lines returns lines 101 to 600.
11. [unit] The default `_backgroundTaskDeps.readLog` on a log file larger than `TASK_LOG_TAIL_BYTES` whose last `TASK_LOG_TAIL_BYTES + 10` bytes hold no newline returns exactly its last `TASK_LOG_TAIL_BYTES` bytes.

### US-009

1. [integration] `runQualityCommand` with command `sleep 20 & echo lint-clean`, a trusted workdir and `timeoutMs: 60_000` resolves within 10 seconds with `success: true`, `exitCode: 0`, `timedOut: false` and `output` including `"lint-clean"`.
2. [unit] `runQualityCommand` with a `_qualityRunnerDeps.spawn` stub whose leader exits `0` while its stdout stays open, and a `_qualityRunnerDeps.setTimeout` stub that fires timers armed with `STREAM_DRAIN_TIMEOUT_MS` at once, calls `_qualityRunnerDeps.killProcessGroup` with the process pid, `"SIGTERM"` and `{ singleProcessFallback: false }`, and resolves with `timedOut: false`.
3. [integration] `runQualityCommand` with command `echo ok` resolves with `output` equal to `"ok\n"` and calls `_qualityRunnerDeps.killProcessGroup` zero times.
4. [integration] `runQualityCommand` with a command that prints 200 000 bytes and exits `0` resolves with `output` of 200 000 bytes plus at most a trailing newline.
5. [unit] `runQualityCommand` with the AC2 stubs where the leader exits `3`, after writing `"partial\n"` to stdout, while its stdout stays open, resolves with `output` including `"partial"`, with `success: false`, `exitCode: 3` and `timedOut: false`.
6. [integration] `runQualityCommand` with command `sleep 30` and `timeoutMs: 200` resolves with `timedOut: true`.
7. [unit] `capTail("A".repeat(3000) + "\nSUMMARY: 2 errors", 1000)` returns a string that ends with `"SUMMARY: 2 errors"` and includes `"truncated"` and `"3018 chars total"`.
8. [unit] `capTail("short", 1000)` returns `"short"`.
9. [unit] `capTail("aaaa\nbbbb\ncccc", 7)` returns a string whose text after the truncation line is `"cccc"`.
10. [unit] `RectifierPromptBuilder.firstAttemptDelta` with one check whose output is 10 000 `Q` characters followed by `"\nFAIL tail-marker"` returns a prompt that includes `"FAIL tail-marker"` and holds at most 4 010 `Q` characters.
11. [unit] `RectifierPromptBuilder.noOpReprompt` with one failed check whose output is 10 000 `Q` characters followed by `"\nFAIL tail-marker"` returns a prompt that includes `"FAIL tail-marker"`.
12. [unit] `RectifierPromptBuilder.reviewRectification` with a check that has one blocking finding and an output of 10 000 `x` characters followed by `"\nTAIL-LINE"` returns a prompt that includes `"TAIL-LINE"`.
13. [unit] `capTail("Q".repeat(5000) + "\n", 1000)` returns a string whose text after the truncation line is 999 `Q` characters followed by a newline.

### US-010

1. [integration] A webhook plugin with a secret, receiving a correctly signed `POST /nax/interact/req-1` whose body's `requestId` is `"req-2"`, responds `400`.
2. [integration] In AC1's setup, with both `req-1` and `req-2` pending through `receive`, neither pending `receive` resolves after the mismatched request.
3. [integration] A webhook plugin with a secret, receiving a correctly signed `POST /nax/interact/req-1` whose body's `requestId` is `"req-1"`, responds `200` and resolves the pending `receive` for `req-1` with that response.
4. [unit] `loadPRD` on a PRD file whose `userStories` is `[null]` rejects with a `NaxError` whose `code` is `"PRD_INVALID"` and whose `context.index` is `0`.
5. [unit] `loadPRD` on a PRD file whose `userStories` is `[<valid story>, 42]` rejects with `code` `"PRD_INVALID"` and `context.index` `1`.
6. [unit] `loadPRD` on a PRD file whose `userStories` is `[<valid story>]` resolves with that story and `attempts` defaulted to `0`.
7. [unit] `loadPRD` on a PRD file whose `userStories` is `[[]]` rejects with `code` `"PRD_INVALID"`.
8. [integration] A webhook plugin with no secret configured, receiving `POST /nax/interact/req-1` whose body's `requestId` is `"req-2"`, responds `400`.

### US-011

1. [unit] `parseRunPreconditionFlags({ context: false })` prints `nax run --no-context was removed: workflow mode builds each prompt's context itself` to stderr and exits with code `1`.
2. [unit] `parseRunPreconditionFlags({ context: true })` returns without exiting.
3. [unit] `loadProjectConfig(dir)` where `dir` holds `.nax/config.json` `{"name":"proj-a"}` returns an object whose `name` is `"proj-a"`, while the process's current directory belongs to a different project.
4. [integration] `configDisplayAction({ dir, diff: true })` where `dir`'s `.nax/config.json` overrides a global field prints that field in its diff output, while the process's current directory belongs to a different project.
5. [integration] `configDisplayAction({ dir })` with neither `diff` nor `explain` prints `dir`'s `.nax/config.json` path as the project config source, while the process's current directory belongs to a different project.
6. [unit] `resolveEnvVars({ a: "${X}" }, { X: "$Y", Y: "zzz" })` returns `{ a: "$Y" }`.
7. [unit] `resolveEnvVars({ a: "$X-${Y}" }, { X: "1", Y: "2" })` returns `{ a: "1-2" }`.
8. [unit] `resolveEnvVars({ a: "$X" }, { X: "${Y}", Y: "zzz" })` returns `{ a: "${Y}" }`.
9. [unit] `resolveEnvVars({ a: "$${X}" }, { X: "1" })` returns `{ a: "${X}" }`.
