# nax interactive coding agent, slice 2: workflow dispatch from the chat session

Status: DESIGN DRAFT, 2026-10-27. User answered Q1-Q4 the same day (section 6). Drafted from the slice 1 design, the
workflow-mode and step-graph designs, and the session memory. The user asked
for a draft without a question round. **Not yet approved by the user, not yet
specced.** When approved, the next step is spec-writing (nax-spec-kit), then
`nax plan` / `nax run` under the standing approval rule.

## 0. How to read this document

This document is meant to stand alone. A fresh session with no memory should
be able to spec from it. It carries:

- intent and the user's own words (sections 1 and 2);
- what exists on `main` at `2415c3af4` (v0.91.7-canary.5), verified
  2026-10-27 (section 3). The builder re-verifies it and never rebuilds it;
- the design (section 4). Every decision is tagged **user** (said by the user,
  do not re-litigate), **Claude** (a default proposed in this draft that the
  user may change) or **builder** (open);
- the open questions for the user (section 6), a decision log (section 8), a
  glossary (section 9) and pointers (section 10).

Process rules that bind anyone working this document (standing user rulings):

- Nothing gets built, scaffolded or installed until the user approves this
  document.
- `nax plan` and `nax run` are billed. Never launch either without explicit
  approval at the launch moment. That includes a re-plan or a re-run, and it
  applies to this feature's own spec as well.
- Before any push, run the full `bun run check:all` from the repo root. Never
  run a bare `bun test` or `bun run nax`.
- nax never merges a PR and never releases. The user merges, and the user
  starts releases. Releases are lockstep across the four packages.
- Pipeline mode is FROZEN. Nothing here touches it.

## 1. Intent

Slice 1 made `nax chat` a coding agent that can brainstorm, write specs and
review them, with skills, MCP servers and subagents loaded. Slice 2 lets that
same session drive the nax workflows itself: `nax plan`, `nax run`,
`nax bot review` and `nax bot fix`. It can also read where a feature stands.

The driver is the user's pain (user, 2026-10-24): stitching by hand between
`nax plan`, `nax run`, `nax bot fix` and koda. The anti-goal they named is a
different agent for each step: "maybe use claude code for brainstorm and
creating plan, or dispatch the nax run". Today the loop crosses at least
three tools and the user carries the state between them in their head. The
state is which feature, which branch, whether the spec was reviewed, whether
the PRD passed its fidelity check, and which PR is open.

New evidence (user, 2026-10-27): the slice 1 acceptance test failed. The
brainstorm inside the TUI could not work out what slice 2 even was, because
the session "had no memory". A dispatching session that cannot find the
feature, the spec or the last run is useless. **Workflow state the session
can read is therefore part of this slice, not a nice-to-have** (4.2).
Cross-session memory in general is a separate question (Q2 in section 6).

The user also reports that the TUI is still buggy (2026-10-27, bugs not yet
itemized). Those bugs are filed and fixed separately. Slice 2 must not wait
on them, and it must not add a screen that depends on a broken one.

Success: the user stays in one `nax chat` session from a brainstorm to an
open PR. The session takes them through spec, spec review, plan, PRD check,
run, and bot review and fix. The user's only stops are the approvals they
already give today, plus the merge.

## 2. Goals, non-goals, anti-goals

Goals
- The session can start `nax plan`, `nax run`, `nax bot review` and
  `nax bot fix` as tools. Each billed start needs an explicit approval in
  both chat modes.
- Started work runs in the background. The session stays usable while a
  one-hour `nax run` is going, shows its progress, and is told when it ends.
- The session can answer, from the repo and the nax output dir, where a
  feature stands: spec, review state, PRD, last run, PR, and open bot items.
- At each handoff the agent reports the outcome and proposes the next step.
  It takes the next billed step on its own only inside a chain the human
  explicitly approved as a full run (4.7).

Non-goals
- koda as a front door for dispatch. koda keeps talking to the ACP server.
  The tool module is host-agnostic, so the ACP server can register it later
  (Claude).
- Routing a running `nax run`'s own asks (story-level approvals) into the
  chat. The run keeps its own interaction chain, which today is CLI or
  Telegram (Claude; see 4.6).
- A plan → run → review → fix step graph inside nax. Each command keeps its
  own entry point; the chat session is the controller (A5 §13 option B).
- Merge, release, `nax workflow promote`. These stay with the user. No tool
  is added for them.
- Cross-session memory (Q2).
- Fixing the current TUI bugs.

Anti-goals (a shipping slice 2 that still has these is a failure)
- A billed run that starts without the user saying yes to that run, or to
  the full-run card that lists it. That holds in any mode, including full
  mode, a resumed session and a Telegram fallback.
- The chat agent editing or committing in a checkout while a `nax run` it
  started is auto-committing there.
- A tool that says a run passed when the run's own records say otherwise.
  For example, trusting an exit code: nax's exit codes are not reliable
  outcome signals (see 3.1).
- The session running a different nax version than the one the user is
  chatting with (the version trap: the local build and the global install
  print the same `--version`).
- A second, chat-only workflow format. The session drives the same commands,
  config, profiles and artifacts as the CLI.

## 3. What exists (verified 2026-10-27 on `main` `2415c3af4`)

All paths are under `packages/nax/` unless they name another package.

### 3.1 The commands

- `nax run`: the action is inline in `bin/nax.ts:215-410`. It calls
  `bin/run-action.ts` and `bin/run-action-execute.ts:128`
  (`executeSingleAgentRun`). **There is no exported in-process API.**
  Options: `-f` (required), `-m/--max-iterations`, `--max-cost`, `--profile`
  (repeatable), `--headless`, `--json`, `-d`, `--fresh`/`--no-resume`,
  `--dry-run` and others. There is no `--model`. On this path it exits 1
  when `result.success` is false (`bin/nax.ts:409`). Usage and
  config-validation errors are known to exit 0 elsewhere. Exit codes are not
  an outcome signal.
- `nax plan`: `bin/nax.ts:676-775` calls `planCommand`
  (`src/cli/plan-command.ts:112`), which is importable in-process. It needs
  `-f`, and `--from` for a spec path. It also takes `--profile`. It writes a
  plan log to `features/<f>/plan/<ts>.jsonl`.
- `nax bot review|fix <pr>`: `src/cli/bot.ts:182-200`. It wraps
  `runBotReview` (`src/bot/review-run.ts:456`) and `runBotFix` /
  `runBotFixCycle` (`src/bot/fix-run.ts:436`, `src/bot/fix-cycle.ts:30`).
  Both are in-process callable with injected deps (`_botCliDeps`).
  Options: `--profile`, `--model`, `--in-place`, `-d`; review also takes
  `--decisions` and `--full`; fix also takes `--trust`, `--no-rereview` and
  `--fresh`. Fix runs in a worktree at `<repo>/.nax-wt/...` unless
  `--in-place`. It pushes, and it re-reviews its own push.
- `nax workflow status|record|promote`: `src/cli/workflow.ts:149-200`.
  `workflowStatusCommand` (`:116`) is read-only and in-process callable.
- `nax gates run`: `src/cli/gates.ts:336-347`. Exit 0 means green, 2 means
  red, 1 means the gates could not run.
- Known trap (#2706, open): a workflow run stops silently at
  `execution.maxIterations` (default 20) when the feature has more stories
  than that, then publishes a partial branch.

### 3.2 Progress and records a second process can read

- `~/.nax/events/<project>/events.jsonl` (`src/pipeline/subscribers/events-writer.ts`).
- `<outputDir>/features/<f>/status.json` (`src/pipeline/subscribers/registry.ts:65`).
- `<outputDir>/features/<f>/runs/<runId>.jsonl` plus `latest.jsonl`.
  `run.start` carries `naxCommit`.
- `workflow/<runId>/result.json` under the feature dir (`src/workflow/paths.ts:14`).
- `outputDir` = `~/.nax/<projectKey>/` (`src/runtime/paths.ts:19`).
- Locks: a checkout lock `nax.lock` in the workdir (`src/execution/lock.ts:313`)
  and a feature lock `<outputDir>/features/<f>/nax.lock`. A second run
  refuses with `LockAcquisitionError` and the holder's pid.
- A run auto-commits onto the current branch (`runner-completion.ts:554`) and
  by default publishes a PR (`workflow.publish = "pr"`). nax never merges.
- There is no IPC or socket progress stream. Progress is the in-process event
  bus plus the files above.

### 3.3 Asks inside a run

- Run asks use `buildRunDispatchAskWiring` (`src/interaction/dispatch-ask.ts:321`)
  over an `AskChannel` (`src/interaction/ask-link.ts:58`). The chain is built
  inside run setup (`initInteractionChain`, `src/interaction/init.ts:50`).
  Its plugins are cli, telegram and webhook. A headless run with only the cli
  plugin has no chain.
- A host cannot inject a channel into `nax run` today.

### 3.4 The chat session (slice 1, merged)

- `nax chat` (`src/cli/chat.ts:278-329`) takes `--mode full|guarded`,
  `--model`, `--profile`, `--resume` and `-d`.
- Host tools reach the native session as `ToolProvider`s
  (`packages/nax-agent/src/tools/provider-types.ts`), passed through
  `nativeBackend` (`src/chat/open-chat-session.ts:172`). The current
  providers are skills (`nax-skills__load`), MCP, and the subagent `run`
  tool (`src/chat/agents-provider.ts`). A `static` provider tool does not ask
  in full mode. In guarded mode the posture from `resolveTuiPermissions`
  (`src/config/permissions.ts:205`) decides.
- Approval card: `src/tui/chat/ask-card.ts:171` (allow once or deny), driven
  by `ChatAskController` (`src/chat/ask-controller.ts:106`). It falls back
  to the interaction chain, usually Telegram, after a delay
  (`src/chat/ask-fallback.ts`).
- There is no background-job concept. Subagents are awaited tool calls,
  aborted through the parent signal (`src/chat/subagent-runs.ts:141`).
- `EmbedderTool` (approval `never|always`) exists in nax-agent but nax chat
  does not use it. Only the ACP server passes `tools`.
- The ACP server (`packages/nax-agent-acp/src/server/`) exposes chat sessions
  only, no workflows.

## 4. Design

### 4.1 The tools (Claude)

One static `ToolProvider`, id `workflow`, registered by the chat host. It
lives in its own module (suggested `src/chat/workflow/`) and depends only on
a small host port (approve, notify, workdir, nax invocation), so the ACP
server can reuse it later.

| Tool | Billed | Ask | What it does |
|---|---|---|---|
| `workflow__state` | no | never | Where a feature (or all features) stands; see 4.2 |
| `workflow__plan` | yes | always | Start `nax plan -f <f> [--from <spec>] [--profile ...]` as a job |
| `workflow__run` | yes | always | Start `nax run -f <f> [--profile ...] [-m N] [--max-cost N]` as a job |
| `workflow__bot_review` | yes | always | Start `nax bot review <pr> [--profile] [--model] [--decisions]` as a job |
| `workflow__bot_fix` | yes | always | Start `nax bot fix <pr> [--profile] [--model] [--trust] [--no-rereview]` as a job |
| `workflow__jobs` | no | never | List this repo's jobs, or one job's progress and log tail |
| `workflow__chain` | yes | always | Propose a full run (ordered steps, each with its gate, and an optional cost cap) on one card; on yes, the approved chain is active for this session (4.7) |
| `workflow__cancel` | no | always | Stop a running job or chain (SIGINT, then SIGTERM after a grace period) |

- `nax gates run` and `nax workflow status` need no tool. The agent already
  runs them through Bash under the session's posture. `workflow__state`
  reads the same records in-process. (Claude)
- The input schema exposes only the flags above. `--dry-run`, `--parallel`,
  `--schedule`, `--compare` and `--plan` are not offered. `--in-place` for
  bot fix is not offered either, because fix always uses its worktree, which
  keeps the chat checkout safe (4.5). (Claude)
- The tool descriptions say each billed tool needs the user's yes, that a
  denial is final for that call, and that the agent must not retry with
  different arguments to get round a denial. (Claude)

### 4.2 Workflow state: what the session can know (Claude; answers the "no memory" failure)

`workflow__state({ feature? })` returns a compact, structured summary built
only from files and the forge. It does no model call. It covers:

- every feature dir under `.nax/features/` (or the one asked for): spec path,
  spec present, `prd.json` present, story count, stories passed, and
  `status.json` state;
- the last run: runId, start and end, outcome from `result.json` or
  `status.json` (never the exit code), cost from the ledger, and
  `naxCommit`;
- the branch the feature lives on (local branch name match, plus the PR
  head), whether it is pushed, and the PR number, state and draft flag;
- open bot items (the `nax workflow status` view) when a PR exists;
- jobs this chat started for the feature (4.3);
- a warning when the PRD has more stories than the resolved
  `execution.maxIterations` (#2706 guard). The agent then proposes `-m`.

The system prompt for chat gains a short "nax loop" section: brainstorm →
spec-writing → spec-review (at most 2 fix rounds) → `nax plan` → PRD
fidelity check (spec-review `--prd`) → commit spec and PRD → `nax run` →
bot review and fix → the user merges → the user releases. It tells the agent
to call `workflow__state` before proposing any workflow step, and to call it
again after any job ends. (Claude; exact wording left to the builder)

### 4.3 Jobs: running in the background (Claude)

- **Out of process.** Each billed tool spawns the nax CLI as a child
  process, never in-process. Reasons: `nax run` has no in-process API; a run
  takes process-level locks, installs signal handlers and auto-commits; and a
  crash in a run must not take the chat session down.
- **Same nax.** The child is started with the same runtime and entry script
  as the chat process (`process.execPath` plus the chat's own entry, for
  example `bun <repo>/bin/nax.ts`, or the global bundle). It never resolves
  `nax` from `PATH`. This closes the version trap. The job record stores the
  child's `naxCommit` once `run.start` appears.
- **Headless.** The argv is per command. Only `nax run` has `--headless`
  (`bin/nax.ts:236`). `nax plan` is already headless in its logger, and
  `nax plan`/`nax bot` do not accept the flag. The child gets a non-TTY
  stdin and stdout. Its stdout and stderr go to a job log file. The run TUI is
  never mounted inside the chat TUI.
- **Job record.** Each job is written to the shared session storage area,
  under a `jobs/` dir next to the chat sessions (exact place: builder). A
  job record holds the job id, kind, argv, cwd, feature or PR, pid, start
  time, state (`running | succeeded | failed | cancelled | lost`), log
  path, the chat session id that started it, and the approval record (who
  said yes, when, and through which channel).
- **Outcome.** A job's outcome comes from the command's own records:
  `result.json`/`status.json` for run, the plan log plus a PRD present for
  plan, the bot artifact path and summary for bot. The exit code is only a
  fallback when no record exists. When the records and the exit code
  disagree, the records win and the job notes the mismatch.
- **Progress.** While a job runs, the host tails its run log or
  `events.jsonl` (story started/passed/failed, cost) and its job log. The
  TUI footer shows one compact job strip (`run tui-fixes 3/7 $1.20`). A
  `/jobs` slash command lists jobs and opens a log tail. The model gets
  progress only when it asks (`workflow__jobs`), never as a stream of
  injected messages.
- **Completion notice.** When a job ends, the host queues one notice for the
  model: kind, feature or PR, outcome, cost, PR link, and the log path. If
  the session is idle, the host starts a turn with that notice, the same way
  Claude Code wakes on a background task. The agent then reads
  `workflow__state`, reports, and proposes the next step. If a turn is
  running, the notice is delivered at the next turn boundary.
- **Session close (user, 2026-10-27).** Closing the chat with a running job
  asks once: cancel it, or keep it running. If kept, it keeps running in the
  background as a detached child. A chain (4.7) that was left running stops
  at the end of its current step, because no session is there to start the
  next one. On resume the agent reports that, and the rest of the chain
  needs a fresh card. On `--resume`, or in a new chat in the same repo, `workflow__jobs`
  re-attaches by job record and pid. A pid that is gone without a final
  record becomes `lost`, with the last known log lines.
- **Cost.** Job cost comes from the child's own ledger. It is shown on the
  job and in the completion notice. It is NOT added to the chat session's
  `costUsd`, so the ledger kinds stay separate. The footer can show both.

### 4.4 Approval: the billed-run rule carries over unchanged (user rule; mechanism Claude)

- The standing rule (user): a billed launch needs explicit approval at the
  launch moment. Slice 1 recorded that it "carries over unchanged" to this
  slice. Therefore **every billed launch asks, in full mode too**, unless the
  user approved it as part of a chain (4.7). Ruling (user, 2026-10-27): full
  and guarded are the Bash and coding-tool permission posture from slice 1.
  Full means `raw` Bash and never asking for coding tools; guarded follows
  `execution.permissions.tui`. They do not govern workflow launch approval.
- The ask is raised host-side, inside the tool's `run()`, before anything
  spawns. A `static` provider never gets a framework ask
  (`nax-agent/src/tools/provider-advertise.ts:100`). Today's
  `ChatAskController.handle()` auto-allows every session approval in full
  mode (`src/chat/ask-controller.ts:49-50`), and it only answers session
  request ids. The workflow ask therefore needs **a separate host entry
  point** on the controller, for example `requestLaunch(card): Promise<"allow" | "deny">`.
  That entry point always shows the card whatever the mode, and it is never
  remembered. It reuses the same card component and the same Telegram
  fallback. This is a nax-only change (Claude, after the builder check).
  The subagent tool is NOT a precedent: it asks nothing before it spawns
  (`src/chat/agents-provider.ts:47`). The card shows the exact argv, the
  workdir and
  branch, the feature or PR, the resolved profile(s), the nax being used
  (entry path and commit), and for run the story count and `-m`.
- Options: allow once, or deny. The card hides "allow for session" for
  launches. There is no "always allow" and no session grant. Session grants
  for ordinary coding-tool approvals are unchanged. The approvals store is not consulted and not written. A denial goes
  back to the model as a tool result that says the user declined.
- The Telegram fallback (`ask-fallback.ts`) stays allowed. A yes there is an
  explicit yes from the user. A timeout or an unavailable channel is a deny,
  never a default allow.
- Every decision is recorded on the job record and in the chat ledger
  (`decidedBy`, channel, time).
- `workflow__cancel` asks in both modes too. Cancelling a run wastes paid
  work, so the user confirms it.

### 4.5 One checkout, two writers (Claude)

The chat agent and a job can both write to the same checkout. Today's rules
already say never to bot-fix in a checkout with an active nax run, because
concurrent agents share one worktree.

- While a `run` or `plan` job started from this chat holds the checkout
  (nax.lock held by the job's pid), the chat session's write tools (Write,
  Edit, Delete, GitCommit and similar) refuse for paths inside that checkout,
  with a message naming the job. Read tools and Bash keep working under the
  normal posture. Bash is not blocked: blocking a shell by intent is not
  reliable, and slice 1's sandbox and posture still apply. The system prompt
  tells the agent not to edit or commit in the checkout while a run is
  going.
- The tools refuse a second run or plan in a checkout that already has one,
  before asking the user, by reading the lock. A lock held by a process this
  chat did not start is reported with its pid.
- Bot review is read-only and bot fix uses its own worktree, so both may run
  alongside chat work. If bot fix targets the branch the chat checkout has
  checked out, the agent is told the push will move that branch under it.
- The agent may branch, write a spec and commit before a run. That is its
  normal coding work under the session's posture, not a workflow tool.

### 4.6 Asks raised inside a run (Claude)

A run's own human asks keep going through the run's own interaction chain.
In practice that is Telegram, or the advisor deciding without a human. The
child runs headless, so the cli plugin is unavailable. If the project config
has no non-cli channel, the approval card warns before the user says yes:
"this run has no channel for its own asks; they will time out". Routing
those asks into the chat card is a follow-up. It needs an injectable
`AskChannel` seam in run setup plus an IPC channel, and is not in this
slice.

### 4.7 Between handoffs: what the agent may do on its own (user ruling 2026-10-27; details Claude)

This is the question slice 1 deferred to this slice. Ruling (user,
2026-10-27): by default the agent proposes each billed step and waits for its
card. **It may carry on through the steps without asking again only when the
human has explicitly approved the full run.**

Default, one step at a time:

- Between billed steps, the agent may do any non-billed work under the
  session's posture without asking anew. That covers reading
  `workflow__state`, the PRD, the run report and PR threads; running a
  spec-review subagent; drafting fixes to a spec; preparing the ruling
  replies that nax-finish drafts today.
- It always ends a handoff by saying what happened and naming the single
  next step it recommends, with the exact command. Then it calls the tool,
  so the approval card is the question. The user answering the card is the
  handoff.
- It never starts a second billed step because the first succeeded, and
  never re-launches after a failure or a denial without a fresh card.
- Agent-only rulings (posting bot rulings, marking a PR ready) stay with
  `nax bot fix` and the user, as today.

Approving the full run (a chain):

- The agent can offer a chain, for example plan → PRD fidelity check → run →
  bot review → bot fix. It does so through one approval card that lists
  every step. For each step the card shows the exact argv and profile, and
  the condition it must meet before the next step starts. The card also shows
  the chain's cost cap, if the user set one. The user saying yes on that
  card is the explicit approval of the full run. A plain chat message such as
  "go ahead" is not; the card is the only way a chain gets approved.
  (Claude)
- The approval covers only the listed steps, in order, each started once.
  The chain record stores the approval and is linked from every job it
  starts.
- Mechanism (Claude): the agent still drives the chain. When a job ends, the
  completion notice wakes it. It checks the gate, runs the in-session steps
  itself (the PRD fidelity check is a skill, not a job), and then calls the
  next billed tool. The host skips the card only when three things hold:
  the call matches the next listed step exactly (tool and argv); the
  previous billed step's outcome, read from its records, is success; and
  the agent reported the in-session gate as passed. For the PRD check, the
  agent records its verdict on the chain record before calling `run`. Any
  mismatch shows a normal per-step card and ends the chain.
- **The chain stops**, and the agent reports and goes back to per-step cards,
  when any of these happens:
  - a step's outcome, read from its records, is anything but success;
  - the PRD fidelity check is not READY;
  - the agent would need a step that is not on the card, such as a re-plan,
    a re-run, a second bot fix round or a changed argv;
  - the user cancels;
  - the cost cap is reached;
  - the session closes (4.3).
- Non-billed work between chain steps (reading state, the PRD check itself,
  drafting rulings) goes ahead under the session's posture as usual.
- The chain ends at a PR that is ready or draft. It never merges and never
  releases.

### 4.8 What the user sees (Claude; layout left to the builder)

- The transcript shows a job card when a job starts: kind, target, nax
  version and commit, and live state. On completion it shows outcome, cost
  and PR link.
- The footer shows a job strip with at most two running jobs, then `+N`.
- `/jobs` opens a picker of jobs. Each opens a log tail view. Cancel from
  there goes through the same approval card.
- No new full-screen view. The run TUI is not embedded.

## 5. Changes outside the chat module (Claude; the builder verifies)

- **None in `@nathapp/nax-agent`.** The launch ask is a new host entry point
  on `ChatAskController` (4.4), in nax only.
- `nax run` / `nax plan` / `nax bot`: no new flags (Claude). The builder
  confirms that each command, given a non-TTY stdin and stdout (plus
  `--headless` for run), gives a clean child: no TUI, no prompts. A command
  that still prompts or mounts a TUI without a TTY is a bug to fix in this
  slice. The fix goes in the command, not in a new flag.
- A shared reader for feature state (4.2). It reuses what
  `nax status`/`nax workflow status` already read (`src/cli/status-features.ts`,
  `workflowStatusCommand`) and adds no second parser.

## 6. Questions answered by the user (2026-10-27)

- **Q1. Autonomy between handoffs.** Per-step cards by default. The agent
  may proceed through the steps only when the human explicitly approves the
  full run (4.7).
- **Q2. Memory.** Real memory has not been discussed yet and gets its own
  slice. Slice 2 goes ahead with workflow state (4.2) only.
- **Q3. Full mode.** Full and guarded are the Bash permission posture from
  slice 1. Billed launches ask in both (4.4).
- **Q4. Closing with a running job.** Ask whether to cancel. If the user
  keeps it, it keeps running in the background (4.3).

## 7. Left to the builder

- Module names, the job storage location, the log-tail mechanism (polling or
  watch), and the notice format.
- How the chat finds its own entry for the child (`process.argv`, an env
  var, or the resolved bin) and how this is tested for both the local build
  and the global bundle.
- Feature split and order. Sensible: (1) `workflow__state` plus the system
  prompt section, which on its own fixes the "no memory" failure; (2) the job
  runner, job records, completion notice and `/jobs`; (3) the billed tools
  with the approval card; (4) the two-writers guard and cancel.
- Test strategy: a fake nax child script that writes run records, a fixture
  `.nax/features/` tree, ask-controller tests for the card and timeout paths,
  and a scripted session that runs plan → run end-to-end against the fake
  child.

## 8. Decision log

| Decision | By | When |
|---|---|---|
| nax becomes a full coding agent dispatching the workflows; this is the main roadmap | user | 2026-10-24 |
| Slice 2 = workflow dispatch (`plan`, `run`, `bot review`, `bot fix`) from the session; approval rule unchanged | user | 2026-10-24 |
| Two front doors (terminal, koda), independent | user | 2026-10-24 |
| Billed `nax plan`/`nax run` need explicit approval at launch, re-runs included | user (standing) | before 2026-10-24 |
| nax never merges, never releases unprompted | user (standing) | before 2026-10-24 |
| TUI acceptance test dropped as the gate for now; slice 2 brainstorm held in Claude Code | user | 2026-10-27 |
| Draft the design from memory and docs without a question round | user | 2026-10-27 |
| Workflow state readable by the session is in scope (no-memory failure) | Claude | 2026-10-27 |
| One `workflow` static provider, host-agnostic module | Claude | 2026-10-27 |
| Jobs out of process, same nax entry as the chat, headless, outcome from records | Claude | 2026-10-27 |
| Every billed launch and every cancel asks, in full mode too; no session grant; timeout = deny | Claude (from the user rule) | 2026-10-27 |
| Write tools refuse in a checkout a chat-started run holds | Claude | 2026-10-27 |
| Run's own asks stay on its interaction chain; routing them into chat is a follow-up | Claude | 2026-10-27 |
| Autonomy: per-step cards by default; proceed through steps only when the human explicitly approves the full run | user (Q1) | 2026-10-27 |
| Full-run approval = one chain card listing every step and its gate; stops on non-success, PRD not READY, an off-card step, cancel, cost cap, session close | Claude (from Q1) | 2026-10-27 |
| Real memory = its own slice, not yet discussed; slice 2 = workflow state only | user (Q2) | 2026-10-27 |
| Full/guarded = the Bash permission posture; launches ask in both | user (Q3) | 2026-10-27 |
| On close: ask whether to cancel; kept jobs run in the background | user (Q4) | 2026-10-27 |
| koda dispatch, merge/release tools, cross-session memory out of scope | Claude | 2026-10-27 |
| Builder check: launch ask = new host entry point on `ChatAskController` (bypasses the full-mode auto-allow, never remembered); no nax-agent change; per-command child argv, no new flags | Claude (after builder check) | 2026-10-27 |

## 9. Glossary

- **Billed**: starts paid model calls outside the chat turn (`nax plan`,
  `nax run`, `nax bot review`, `nax bot fix`).
- **Job**: one billed command started from the chat, running as a
  background child process, with a job record.
- **Handoff**: the moment one workflow step ends and the next could start.
- **Workflow state**: the summary 4.2 builds from the repo, the nax output
  dir and the forge.
- **Full / guarded**: the chat's two permission modes from slice 1. Full
  never asks for coding tools. Guarded follows the `execution.permissions.tui`
  posture.
- **Version trap**: the local build and the global install print the same
  `--version`, so only the commit (`naxCommit`) tells which one ran.
- **PRD fidelity check**: spec-review `--prd`, phase 9, run after
  `nax plan`.

## 10. Related documents

In this repo (`docs/`):
- `superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md`: slice 1,
  its non-goals that this slice picks up, and its decision log.
- `superpowers/specs/2026-10-26-nax-chat-tui-ux-design.md`: the chat look
  (cards, footer, pickers) the job card and strip follow.
- `superpowers/specs/2026-10-12-a5-workflow-mode-design.md`: workflow mode.
  Its §13 option B, an LLM controller session calling the steps as tools,
  is what this slice is.
- `specs/SPEC-bot-review-fix.md`: `nax bot review|fix`.
- `adr/ADR-030-bash-approval-modes.md`: the Bash approval axis the posture
  uses.

Outside this repo (`projects/nax/`, the user's workspace):
- `nax-step-graph-and-bot-master-plan.md`: the graph and bot arc. Its
  non-goal "an LLM controller ... the graph should not block it" is this
  slice.
- `nax-autonomy-master-plan.md`: goal 5, of which this is option B.
- `nax-agent-master-plan.md`: §5a deferred items (facade `mcpServers`, stage
  publish).
