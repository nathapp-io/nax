# Whole-Repo Code Review: nax monorepo

**Date:** 2026-10-24
**Version:** 0.91.6 (HEAD `6cf9150`)
**Scope:** every package (`nax`, `nax-agent`, `nax-agent-acp`, `nax-ai`, `repo-tooling`). The review targets correctness and security. It does not cover style.
**Priority rule:** workflow mode (ADR-034, the default) comes first. Findings reachable only through `execution.mode: "pipeline"` (deprecated and frozen) are tagged **[pipeline-only]** and listed last.

## Baseline

After `bun install` and `bun run build`, every check passes:

| Gate | Result |
|:---|:---|
| `bun run typecheck` | exit 0 |
| `bun run check:all` | exit 0 |
| Import cycles (nax, nax-agent, nax-agent-acp) | 0 / 0 / 0 (baseline 0) |
| `check:nax-error` | 0 violations |
| `check:file-sizes` (nax) | 11 grandfathered (baseline 11) |

## How the review was done

- Eight independent reviewers each took one area: the workflow story loop, the workflow feature machine, execution/runtime, agents/ACP, nax-agent, nax-ai/config/cli, context/prompts/review/operations, and the remaining modules.
- Each finding had to come with a traced failure path.
- The HIGH and most MEDIUM findings were then checked again against the source for this report.
- **Confidence:**
  - **confirmed** means the code path was traced or reproduced.
  - **plausible** means the code path is real, but the impact depends on outside behaviour such as the platform, the `gh` CLI or timing.

---

## Summary

| Severity | Workflow / shared | [pipeline-only] |
|:---|---:|---:|
| HIGH | 2 | 0 |
| MEDIUM | 16 | 2 |
| LOW | 20 | 3 |

Recommended first sweep: H1, H2, M1, M2, M3, M4, M5, M6. Each is small and local, and all of them are confirmed.

---

## HIGH

### H1. `--rules-dir` / `--context-file` are silently dropped for every story with a package workdir — confirmed

**Where:**
- `packages/nax/src/config/loader.ts:404-434`
- `packages/nax/src/execution/iteration-runner.ts:141-148`
- `packages/nax/src/config/root-only-keys.ts:86-96`

**What happens:**
1. `bin/run-action.ts:288-291` puts the two flags into `cliOverrides.context`.
2. For a story with `workdir: "packages/api"`, `iteration-runner` calls `loadConfigForWorkdir(root, pkg, profileOverrideFromConfig(ctx.config))`.
3. That call reloads the root config from disk with only `{ profile }`.
4. `pinRootOnlyKeysRaw` then pins `context.rules` and `context.projectContext` to this flag-less reload. When the package has no `.nax/mono/<pkg>/config.json`, the reload is returned as is (`loader.ts:451-457`).
5. The result becomes `sc.config` (`workflow/stage-env.ts:64`). From there `workflow/brief.ts:86-113` and `branch-review.ts:91` build the brief and the branch review without the rules override or the context-file override.

**Effect:** stories without a package workdir honour the flags and package stories do not, within the same run.

**Fix:** pass the run's full CLI overrides (or the in-memory run config) into `loadConfigForWorkdir`, and add them to the root-cache key. Alternatively, pin the root-only context keys from `ctx.config` instead of from a disk reload.

### H2. The `.git/` and `.claude/settings.json` write bans compare case-sensitively — confirmed at the policy level; platform-dependent

**Where:**
- `packages/nax-agent/src/tools/policy-paths-branch.ts:69-73` (`entersGitMetadata`: `rel.split(sep).includes(".git")`)
- `packages/nax-agent/src/sandbox/claude-settings.ts:63`
- the stage deny/ask globs in `tools/policy-match.ts:25-50`

**Bypass:** with `Bash(cat *)` granted, `cat a >> .GIT/config` is allowed, and so are `Write .GIT/hooks/pre-commit` and `Write .Claude/settings.json`.

**Effect:** on case-insensitive filesystems (macOS and Windows defaults), those spellings are the real `.git/config` and `.git/hooks`. An agent can add `core.hooksPath`, `diff.external` or a filter driver there. nax's next git command, which runs outside the sandbox, then executes that code. `.git/config` can also be read, and it may hold token-bearing remote URLs.

**Precedent:** `deny-paths.ts:45-50` already made `denyPaths` case-insensitive for this exact reason (nax#1972), and `credential-read-deny.ts` uses `realpathSync.native`. The `.git` check got neither fix. nax's own config refusal (`.NAX/config.json`) is built the same way and should be audited alongside.

**Fix:** compare path segments case-insensitively (`seg.toLowerCase() === ".git"`) in `entersGitMetadata`, `claudeSettingsWriteRefusal` and the deny/ask globs.

---

## MEDIUM: workflow mode and shared code

### M1. Story review: `quality: "changes"` with no blocking finding closes the story clean — confirmed

**Where:** `packages/nax/src/operations/workflow-replies.ts:127-145`, consumed at `workflow/story-steps.ts:227`.

**What happens:** `parseStoryReviewReply` adds a synthetic finding when `spec: "fail"` has no blocking finding, but does nothing equivalent for `quality: "changes"`. All of these replies give `reviewOpen = []`, so no fix round runs:
- `{"spec":"pass","quality":"changes","findings":[]}`
- a reply with only minor findings
- a reply whose blocking findings are dropped because they have no `issue` key

**Precedent:** the branch review already fixed this case (nax#2550, `withQualityFloor` in `feature-steps.ts:115-125`), and its comment says it "mirrors parseStoryReviewReply". The story path never got the floor.

**Fix:** add an `important` finding of kind `quality` in `parseStoryReviewReply` when `quality === "changes"` and no finding is blocking. Then the branch-level copy can reuse it.

### M2. A full suite that times out counts as a green gate in workflow mode — confirmed (found by two reviewers)

**Where:** `packages/nax/src/operations/full-suite-gate.ts:345-360` and `workflow/gates.ts:26` (`SUITE_RED`). The default is set at `config/schemas-execution.ts:110`.

**What happens:**
- `execution.regressionGate.acceptOnTimeout` defaults to `true`, which produces status `passed-on-timeout` with `success: true`.
- `SUITE_RED` contains `failed`, `execution-failed`, `timeout` and `inconclusive`, but not `passed-on-timeout`, and the status is not marked skipped either.
- So a story that makes the test suite hang gets a green `full-suite` gate in the PR readiness check.

**Fix:** in workflow mode, map `passed-on-timeout` to red, or to skipped plus a readiness reason. Alternatively, default `acceptOnTimeout` to `false` when the mode is workflow.

### M3. A skipped re-review discards `fixBase`, so the fixes from that round are never re-reviewed — confirmed

**Where:** `packages/nax/src/workflow/story-steps.ts:242-243`.

**What happens:**
1. `s.fixBase = undefined` runs before the `!out.ran` check.
2. If the re-review of round k is skipped (timeout, unparseable reply), round k+1 takes a new base at the current HEAD (`story-steps.ts:412`).
3. The next re-review package therefore covers only round k+1's diff.
4. Findings that round k actually fixed come back NOT_ADDRESSED, which burns extra rounds or goes to adjudication, and round k's diff is never checked for regressions.

**Fix:** move the reset below the `!out.ran` return. Add a test for the skipped-re-review path; `story-loop.test.ts:352` only covers re-reviews that ran.

### M4. A crash or Ctrl-C during publish restarts the whole feature workflow — confirmed

**Where:** `packages/nax/src/workflow/finalize.ts:472` (`ledgerCommit`) and `:495` (`waitForCi`), with `workflow/feature.ts:124-145` (`resumeOrRestart`).

**What happens:**
1. `prMode` commits the advisor ledger, which moves HEAD, and then pushes and waits for CI, often for minutes.
2. The record is persisted only after the node returns, so `lastHead` still points at the pre-ledger commit.
3. If the run is interrupted during the wait, the next run sees "HEAD moved" and calls `freshRecord`.

**Effect:** the branch review, fix, re-review and adjudication all run again, which contradicts ADR-034 §1. `fixRounds`, `gateRepairRounds` and `ciRepairRounds` also reset, so every interruption grants a new set of rounds.

**Fix:** persist `lastHead` immediately after `ledgerCommit`, or treat commits since `lastHead` that touch only the ledger path as "not moved".

### M5. A hook that leaves a background child running hangs nax — confirmed (reproduced)

**Where:** `packages/nax/src/hooks/runner.ts:255-271`.

**What happens:**
1. The kill timer is cleared once `proc.exited` resolves.
2. On the non-timeout path, the output drain is an unbounded `Promise.all([stdoutPromise, stderrPromise])`.
3. A hook that runs `cmd &` and exits 0 leaves the pipe held open by the child, so the drain lasts as long as the child does. It took 5 s for `sleep 5 &` in the reproduction, and it never ends for a daemon.

**Reach:** hooks fire from the event-bus subscriber, which workflow publishes to, and from `run-completion.ts` / `run-cleanup.ts`.

**Fix:** bound the drain on both paths with `createDrainDeadline(STREAM_DRAIN_TIMEOUT_MS)`. `quality/runner.ts:231-249` has the same shape (see L15).

### M6. nax-agent buffers process output without limit — confirmed (reproduced)

**Where:** `packages/nax-agent/src/internal/argv-exec.ts:117-150` (`drainToEof`).

**What happens:** Bash, Exec and the sandbox launcher all append stdout and stderr to an unbounded string for up to 300 s. `cutToByteCap` trims only afterwards. In the reproduction, 100 MB of output produced a 100 MB string. A `yes`, or a test runner stuck in a loop, can produce gigabytes and crash the orchestrator.

**Fix:** drain with the existing `drainBounded`, or cap the accumulator and set a `truncated` flag while still reading to EOF. Keep the tail of stderr.

### M7. GitCommit runs repository hooks outside the sandbox — plausible

**Where:** `packages/nax-agent/src/tools/git-commit.ts:229` (`["commit","-m",message]`) and `internal/git-env.ts:50`.

**What happens:**
- With an in-tree hooks path (husky's `core.hooksPath=.husky`), the hook file is inside the agent's write root.
- The sandbox only protects `<gitdir>/hooks` (`sandbox/policy-builder.ts:97-103`).
- The implementer can therefore edit `.husky/pre-commit` and call GitCommit, which makes nax run that code unsandboxed.
- This breaks the #2198 rule that nax's unsandboxed git must not run agent code. `bot/git.ts:3` already names this vector.
- The real impact is lower if verification already runs agent-written tests unsandboxed.

**Fix:** pass `-c core.hooksPath=/dev/null` (or `--no-verify`) in GitCommit and `gitlinkSafeAdd`, and make running hooks an explicit opt-in.

### M8. ACP server "Always allow" approves every command sharing the first two words, including package runners — confirmed

**Where:** `packages/nax-agent-acp/src/server/permissions.ts:115-139` (`memoryKey` / `memoryApplies`; `WRAPPERS` at :69).

**What happens:**
- "Always allow `npm exec prettier`" stores the key `Bash:npm exec`. After that, `npm exec <any-pkg>` is auto-approved, and so are `pnpm dlx` and `yarn dlx`.
- `npx`, `bunx` and `pnpx` are already treated as wrappers, so these runner forms are an inconsistency rather than a choice.
- Similarly, `npm run test` remembers `npm run`, which then approves `npm run deploy`.

**Fix:**
- At minimum, treat `npm exec`, `npm x`, `pnpm exec`, `pnpm dlx` and `yarn dlx` as wrappers.
- Better, key remembered approvals on the full plain-word argv.

### M9. A failed `complete()` hop loses its token cost and counts as "no dispatch" — confirmed

**Where:** `packages/nax/src/agents/manager-dispatch.ts:586-595` and `agents/acp/complete.ts:104-115`.

**What happens:**
- When a hop fails after the model ran (max tokens, refusal, rate limit after retries), it throws a `SessionTurnError` that carries the spend.
- `dispatchCompleteHop` replaces that with `tokenUsage {0,0}`, `estimatedCostUsd: 0` and `dispatched: false`.
- The timeout path throws a plain `AGENT_TIMEOUT`, which drops `state.spend` entirely.

**Effect:** cost totals under-report, and this weakens `costLimit` enforcement. An all-failed complete can also wrongly trip `CALL_OP_NO_DISPATCH`.

**Fix:** copy the spend from `SessionTurnError` in `dispatchCompleteHop`, and have the timeout path throw a `SessionTurnError` (fail-timeout) that carries the spend.

### M10. Implementer questions are answered past `execution.costLimit` — confirmed

**Where:** `packages/nax/src/workflow/story-steps.ts:187-203`.

**What happens:**
- `absorbTurn` runs an advisor call plus a full `answer` implementer turn without checking `env.steps.costExceeded()`.
- This can happen up to `MAX_IMPLEMENTER_QUESTIONS` (2) times per story.
- Every other extra turn checks the limit first: `no-work.ts:221`, `interrupt-continue.ts:166` and `report-check.ts:87`.
- ADR-034 §3 says no further agent step runs past the limit.

**Fix:** add `&& !env.steps.costExceeded()` to the `needsAnswer` condition, and write a skip note to the ledger.

The same class of bug exists at the feature level; see L4 (the approval advisor runs past the limit).

### M11. A "failed" CI poll is not bound to the pushed HEAD — plausible

**Where:** `packages/nax/src/workflow/ci-wait.ts:297-312`.

**What happens:**
1. `bindToHead` holds back only green polls.
2. After a CI-repair push, `gh pr checks` can still report the previous head's failures before GitHub moves the PR head.
3. The wait therefore returns `failed` at once.
4. `ciRepairPlan` then finds no failed check for the new head, so no repair runs.
5. The record settles as `draft` / `ci: failed` and is skipped as "already-finished" on later runs at the same HEAD.

**Fix:** apply the same sha mismatch → `waiting` rule to failed polls. `readChecksOnce`'s `verdictForHead` already does this.

### M12. The registry hydrate path skips the shims, env resolution, guards and validation — confirmed

**Where:** `packages/nax/src/config/loader.ts:342-388` (`loadPackageOverrideData` / `loadPackageOverrideWithConfig`), used by `runtime/packages.ts:136-137,220-228`.

**What happens:**
- `packageView.config` receives raw package JSON after only `rejectGlobalOnlyKeys`.
- It skips `applyConfigCompatShims`, `$VAR` resolution, the `reject*` and `validatePermissionsBlock` guards, and `NaxConfigSchema.safeParse`.
- So two configs for the same package can disagree. For example, a legacy `context.testCoverage.testPattern` is migrated on one path but not the other, and `operations/verify.ts:177-181` reads the unmigrated one.

**Fix:** move the shim → env → guard → safeParse chain into one helper and use it from both paths.

### M13. Reserved project names miss real `~/.nax` subdirectories — confirmed

**Where:** `packages/nax/src/cli/init.ts:50` and `config/schemas.ts:105` reserve only `global` and `_archive`. The destructive action is in `commands/migrate.ts:57-67`.

**What happens:**
- `nax migrate --reclaim profiles`, `--reclaim acp` and `--reclaim runs` archive global state without a prompt. That breaks profiles, logs out the isolated agent homes, and breaks `nax logs -r`.
- A project named `runs` or `profiles` writes its output into those shared directories.

**Fix:** keep one exported constant listing every name `globalConfigDir()` uses (`runs`, `events`, `profiles`, `plugins`, `acp`, `global`, `_archive`), and check it in the schema, in init and in migrate.

### M14. The fatal-signal path never releases the checkout or feature lock, and acquiring a lock ignores its own PID — confirmed path; trigger needs PID reuse

**Where:** `packages/nax/src/execution/crash-signals.ts:121-148`, `lock.ts:348` and `feature-lock.ts:149-150`.

**What happens:**
1. `performTeardown` calls `process.exit` before `cleanupRun` runs, so both locks stay on disk with the dead PID.
2. Reclaiming them relies only on `isProcessAlive(pid)`.
3. In a container restarted with the same PID (PID 1 entrypoint), the new process probes itself, gets true, and is locked out permanently.

**Fix:**
- Release both locks inside the signal-teardown deadline.
- Treat `holder.pid === process.pid` as stale, or record and compare the holder's process start time.

### M15. The SIGKILL pass skips descendants that were reparented when their parent exited on SIGTERM — plausible

**Where:** `packages/nax/src/execution/pid-registry.ts:337` (`signalIfUnchanged`).

**What happens:**
- When the agent's shell exits on TERM, its children are reparented, so their `parentPid` changes.
- The KILL pass skips them as "identity changed".
- A test watcher or server that ignores SIGTERM therefore outlives the run, which is the orphan class #792 targets.

**Fix:** match on `pid` plus `startedAt` only during the KILL pass.

### M16. Bot checkout pins config for only some of the agents nax drives — plausible

**Where:** `packages/nax/src/bot/checkout.ts:14-21` (`BASE_PINNED_PATHS` / `BASE_PINNED_NAMES`).

**What happens:**
- The list covers `.claude`, `.cursor`, `.mcp.json`, `.nax/rules` and the instruction files.
- It does not cover `.gemini/` (`settings.json` can declare `mcpServers` and hooks), `.codex/`, `opencode.json` / `.opencode/`, or `AGENT.md`.
- So an untrusted PR head could get an MCP command executed when the bot reviews or fixes it with gemini, codex or opencode.

**Fix:** derive the pinned set from the supported-agent registry.

---

## LOW: workflow mode and shared code

| # | Where | Issue | Confidence |
|:--|:--|:--|:--|
| L1 | `nax/src/agents/acp/turn-loop.ts:254-271` | On the last allowed turn, the loop still asks a human (with up to a 5-minute wait), records the answer in `interactions`, then throws it away. Check `used(state) >= loop.max` before calling `nextPrompt`. | confirmed |
| L2 | `nax-agent-acp/src/client/permissions.ts:228-233` | For agents with `verify: false` (opencode, pi), Bash deny/ask rules are matched against the sandbox-wrapped command, so `Bash(git push *)` never matches. Decode the inner command whenever `wrapped` is true. | plausible |
| L3 | `nax/src/workflow/git.ts:96` | `listUncommitted` drops all of `.nax/`, so a fix session's edit to tracked `.nax/config.json` or `prd.json` is neither committed nor reported dirty. Final gates still read it from disk. Exclude only git-ignored nax-owned paths. | plausible |
| L4 | `nax/src/workflow/finalize.ts:464` | The approval advisor runs past `costLimit` when the limit is crossed on the last re-review, because no agent node with remaining work records the cost stop. `publish` should check `env.costExceeded()` and add `COST_LIMITED`. | confirmed |
| L5 | `nax/src/workflow/story-loop.ts:161`, `adjudicate.ts:152`, `advisor-live.ts:135` | An abort during residual adjudication is swallowed. Default holds are written and the record is closed, so the next run restarts the story from implement. Wire `aborted` through to the engine and rethrow on abort. | confirmed |
| L6 | `nax/src/workflow/story-steps.ts:224-229`, `approval.ts:109-122` | A story whose review never ran still closes `complete`, and no readiness reason names unreviewed stories (unlike `reReviewSkipped` at branch level). Add an "unreviewed stories" reason. | confirmed (policy call) |
| L7 | `nax/src/workflow/story-steps.ts:286` | A story whose gates stay red never gets reviewed, but it reports `unreviewed: false`. Set `unreviewed` from `!reviewed` in `closeStep`. | confirmed |
| L8 | `nax/src/execution/end-phase.ts:154` | `result?.passed ?? true` counts a `null` returned on abort as passed (narrow race window). | plausible |
| L9 | `nax/src/runtime/cost-aggregator.ts:549-592`, `runtime/index.ts:519` | `snapshot()` under-reports while a drain is running, and a second `close()` does not wait for the first, so SIGINT during the completion drain can cut off the cost jsonl write. | plausible |
| L10 | `nax/src/execution/feature-lock.ts:224-231` | A corrupt feature lock is reclaimed with a plain `unlink`, which allows two winners. Reuse the tombstone/rename path that `lock.ts` uses. | confirmed |
| L11 | `nax/src/execution/lock.ts:348` | The checkout lock ignores the `host` it records, so a lock held from another machine on a shared filesystem is stolen. `feature-lock.ts` already handles host. | plausible |
| L12 | `nax/src/execution/lifecycle/run-setup.ts:511-526` | A setup failure does not tear down the interaction chain or loaded plugins. Only affects embedded and test callers. | confirmed |
| L13 | `nax/src/cli/config-display.ts:52,56`, `config-get.ts:50` | `nax config -d <dir> --diff` and its header read from `process.cwd()` instead of `-d`. | confirmed |
| L14 | `nax/src/config/loader.ts:320-322` | The `loadConfig` fast path returns `DEFAULT_CONFIG` without `applyWorkflowMode`, so it shows acceptance on and advisor off. `nax run` does not take this path. | confirmed |
| L15 | `nax/src/quality/runner.ts:231-249` | A lint or typecheck command that leaves a child holding the pipe is reported as timed out after `timeoutMs`. Same mechanism as M5. | confirmed |
| L16 | `nax-ai/src/credentials/file-store.ts:128-132` | `lockTimeoutMs` is passed as the per-retry `maxTimeout`, so the total wait is capped at about 3.6 s, below `STALE_MS` (10 s). | confirmed |
| L17 | `nax/src/interaction/plugins/webhook.ts:496-563` | The callback HMAC covers only the body: the URL `requestId` is not checked against `body.requestId`, and there is no timestamp or nonce. | plausible |
| L18 | `nax/src/prd/index.ts:128-145` | `loadPRD` does not check each story's shape. `userStories: [null]` or a string `dependencies` crashes later with a TypeError instead of `PRD_INVALID`. | confirmed |
| L19 | `nax-agent/src/tools/policy-bash.ts:226-247`; `tools/grep.ts:153-156` | Gated Bash redirects can write `.claude/settings.json` when the sandbox is off. The grep fallback (no ripgrep installed) searches `.git/`. Add `claudeSettingsWriteRefusal` to redirect targets and `--exclude-dir=.git` to grep. | confirmed |
| L20 | `nax/src/finish/pr/open.ts:135-176` | `gh pr view <branch>` can return a closed or merged PR. nax then edits and reports that dead PR instead of opening a new one. Request `state` and treat anything other than `OPEN` as "no PR". | plausible |

---

## [pipeline-only]: low priority

| # | Where | Issue | Confidence |
|:--|:--|:--|:--|
| P1 (MED) | `nax/src/operations/call-dispatch-run.ts:470-531` + `execution/story-orchestrator/phase-eval.ts:45-56` | An exception in `op.verify()` takes the parse-failure path and returns a raw `TurnResult`. `phasePassed` treats that as a PASS for semantic and adversarial review, and no audit record is written. | confirmed flow |
| P2 (MED) | `nax/src/verification/runners.ts:113-121` | SUCCESS results never set `passCount` / `failCount`, so `classifyMutant` never returns `survived` and the mutation spot-check always reports no survivors. | confirmed |
| P3 | `nax/src/review/severity.ts:41` | `normalizeSeverity(undefined)` throws, so one finding with no severity is treated as an adapter failure (swaps agents, records 0 cost). | reproduced |
| P4 | `nax/src/findings/fingerprint/index.ts:85-87` | The AC-anchored fingerprint is `file|acN` only, so a new defect under the same AC is demoted as a recurrence. | confirmed |
| P5 | `nax/src/execution/pipeline-result-handler.ts:287-307` | `outputFiles` and `diffSummary` are set after the PRD save and then discarded by `loadPRD`, so context chaining never sees them. | confirmed |

---

## Checked, nothing found (abridged)

- **Workflow engine:**
  - fix-round counting and the warm/fresh escalation ladder
  - step-graph patch, exit and transition semantics
  - re-review absorption fails closed
  - residual rulings cannot turn a red gate green
  - readiness requires the advisor's approval plus zero deterministic reasons
  - nax never merges
- **PR body and comment safety:** `neutralise`, `redactSecrets` and fences sized past the longest backtick run. Every git and gh call uses an argv array. `result.json` and the sidecar are written atomically.
- **Config:** `deepMergeConfig` blocks prototype pollution. Root-only pinning holds. `applyWorkflowMode` runs on root and package results. The ADR-034 defaults match the schema.
- **nax-ai:** retries happen only before the first event, aborts are honoured, no API keys appear in errors, and stream tool-argument accumulation is correct.
- **nax-agent Bash lexer and gating:** metacharacters, substitutions, redirects, env prefixes and wrapper canonicalisation. Symlink and `..` containment. Exec argv validation.
- **ACP:** permission profiles fail closed on invalid input, process-group kill on terminate, env allowlist, loopback MCP host auth, and every retry and swap loop is bounded.
- **Execution:** the StatusWriter mutex plus atomic writes, the crash-handler deadline and exit codes, the heartbeat generation guard, and lock unwinding in setup.
- **Test runners and verification:** a non-zero exit never maps to pass, and process-group kill on timeout.
- **Plugins, trust and hooks:** trust is checked before import or spawn, and containment checks are separator-aware.
