# nax chat: route a launched run's own asks into the chat session

Status: DESIGN DRAFT, 2026-10-29. Brainstormed with the user the same day;
builder check done and folded, user answered Q1-Q2 (section 6).
**Not yet approved by the user, not yet specced.** When approved, the next
step is spec-writing (nax-spec-kit), then `nax plan` / `nax run` under the
standing approval rule.

## 0. How to read this document

This document is meant to stand alone. A fresh session with no memory should
be able to spec from it. Every decision is tagged **user** (said by the user,
do not re-litigate), **Claude** (a default proposed in this draft that the
user may change) or **builder** (open).

Process rules that bind anyone working this document (standing user rulings):

- Nothing gets built, scaffolded or installed until the user approves this
  document.
- `nax plan` and `nax run` are billed. Never launch either without explicit
  approval at the launch moment. That includes a re-plan or a re-run, and it
  applies to this feature's own spec as well.
- Before any push, run the full `bun run check:all` from the repo root. Never
  run a bare `bun test` or `bun run nax`.
- nax never merges a PR and never releases. The user merges, and the user
  starts releases.
- Pipeline mode is FROZEN. Nothing here touches it.

## 1. Intent

Slice 2 (`2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`) lets
`nax chat` launch `nax plan`, `nax run`, `nax bot review` and `nax bot fix`
as detached jobs, and chain them under one approval. It left one gap on
purpose (its 4.6): a run's **own** asks never reach the chat. The child runs
`--headless`, so with the default `cli` interaction plugin it has no channel
at all and every ask is denied or falls to its default. With Telegram
configured the ask goes to Telegram only. The launch card today warns "this
run has no channel for its own asks; they will time out".

This feature closes that gap. The user's words (2026-10-29): the run's
question shows as a card in chat, approve or deny there, "but it should auto
handle by agent".

Success: a run launched from chat never silently denies an ask because
nobody could see it. The chat agent answers what it is trusted to answer,
the user answers the rest from the chat, and Telegram plus the run's existing
timeout defaults still cover the user being away.

## 2. Goals, non-goals, anti-goals

Goals
- Every human ask a chat-launched `nax run`, `nax bot review` or
  `nax bot fix` raises reaches the chat session that launched it, as a card
  (user; bot jobs added 2026-10-29, Q1).
- Under an approved full chain, the chat agent answers the asks itself and
  the answer shows as a read-only card with the question, the decision and
  the reason (user). Without full approval, every ask waits in a card for the
  user (user).
- Red-tier triggers (security-review, cost-exceeded, merge-conflict) and the
  yellow human gates `pre-merge` and `human-review` always go to the user,
  even under full approval (user, Q2).
- Unanswered in chat: fall back to Telegram, then the run's own timeout
  default (user).
- The in-run advisor keeps its current job unchanged. Its flagged rulings
  (`needsHumanConfirm` heads-ups) show in chat as read-only notices (user,
  option (a), 2026-10-29).

Non-goals
- Teaching the advisor to answer tool approvals or triggers (option (b),
  rejected by the user 2026-10-29).
- Runs not launched from `nax chat` (terminal `nax run`, koda). Their
  interaction chain is unchanged.
- koda / the ACP server. The chat TUI is the only host in this feature
  (Claude; the auto-turn mechanism is TUI-only today).
- Making chain approval survive a chat restart (Claude; see 4.5).
- Pipeline mode.
- `nax plan` jobs (Claude: the user named only bot review and fix; plan's
  asks are clarifying questions to the person writing the spec, which the
  chat session already is).
- Changing bot review / bot fix asks when run from a terminal: they keep no
  interaction chain unless `--chat-asks` is passed (Claude).

Anti-goals (a shipping feature that still has these is a failure)
- An ask that is silently denied because the chat channel broke, instead of
  falling back to Telegram or the run's timeout default.
- The chat agent answering a red-tier trigger, or persisting an "always
  allow" approval on the user's behalf.
- A run that hangs because the chat closed with an ask on screen.
- A second ask path that some ask sources bypass (one channel for all).

## 3. What exists (verified 2026-10-29 on `main` `a3d045cea`, v0.91.7-canary.8)

Paths are under `packages/nax/src/`. The builder re-verifies, never rebuilds.

### 3.1 Ask sources in a workflow-mode run

All of these go through the run's `InteractionChain` (or its primary plugin),
so one replacement channel covers them all:

| Source | Where | Type | Delivered by | Timeout / fallback |
|---|---|---|---|---|
| Triggers (security-review, cost-exceeded, merge-conflict = red; cost-warning, pre-merge, human-review, max-retries, story-oversized = yellow; review-gate = green) | `interaction/triggers.ts`, call sites `execution/cost-guard.ts`, `execution/cost-warning.ts`, `execution/unified-executor.ts`, `pipeline/stages/completion.ts` | `confirm` | `chain.prompt` | `interaction.defaults.timeout`; `TRIGGER_METADATA` fallback. All off unless configured |
| Tool approvals (`bashApproval: gated / escalate`) | `interaction/dispatch-ask.ts` human link (`ask-link.ts`), wired in `workflow/call-context.ts` | approval | `chain.prompt` | `execution.approvalTimeout` (600 s), deny |
| Agent clarifying questions | `interaction/bridge-builder.ts` | `input` | `chain.getPrimary()` send/receive directly | 120 s, "continue" |
| Precheck story-size prompt | `execution/lifecycle/story-size-prompts.ts` (via `precheck-runner.ts`) | `choose` (approve / skip / abort) | chain | 600 s, escalate |
| Paused-story prompt | `execution/lifecycle/paused-story-prompts.ts` | `choose` | chain | 300 s, continue |
| Advisor heads-ups (incl. `needsHumanConfirm`) | `execution/post-run-notifications.ts`, `advisor/service-helpers.ts` | `notify` | `chain.send`, no wait | none |

The advisor (`advisor/`) answers implementer NEEDS_CONTEXT / BLOCKED itself
(`workflow/story-steps.ts`) and never blocks on a human. It does not see tool
approvals or triggers.

### 3.2 The chain

- `interaction/init.ts` registers exactly one plugin (`cli`, `telegram` or
  `webhook`). Headless + `cli` returns a null chain, so every ask is
  deny/unavailable.
- `InteractionChain.receive` only cascades on a thrown error; Telegram
  resolves `timeout` rather than throwing, so "chat first, Telegram on
  timeout" cannot be built by registering two plugins.
- Precedent: `chat/ask-fallback.ts` offers a pending chat ask to the chain
  after `chatAskFallbackMs` (default 60 s, `chat-host.ts`), first answer wins.

### 3.3 Chat jobs

- `chat/jobs/job-runner.ts` spawns `nax run -f <feature> -d <repo>
  --headless [...]` detached, stdin ignored, stdout/stderr to an append log,
  env inherited. Records live at `<outputDir>/chat-jobs/<id>.json`.
- Child to parent today: `status.json` (pid-matched), exit code, log. Parent
  to child: signals only. No ask channel exists.
- A chat restart re-attaches live jobs (pid polled every 2 s). Chain state
  (`chat/jobs/chain-controller.ts`, `kind: "auto"` on `admit`) is in memory
  only and does not survive restart.
- Job notices auto-take an agent turn when idle (`tui/chat/use-jobs.ts`,
  TUI-only, no cap). Background-task notices share the hook and are capped
  at 3 consecutive turns (`MAX_CONSECUTIVE_TASK_NOTICE_TURNS`).
- On timeout `applyFallback` (`interaction/chain.ts`) maps `continue` and
  `escalate` to approve, `skip` to skip, `abort` to abort.
- Host approval cards: `chat/ask-controller.ts` `requestHostApproval`.

## 4. Design

### 4.1 One channel: a `chat` interaction plugin in the child (Claude)

The launched run gets a chat-backed plugin as the single plugin of its chain.
It owns the fallback order itself, wrapping the plugin the project config
names (Telegram, webhook, or none) as its fallback. Because every source in
3.1 already goes through the chain or its primary plugin, nothing upstream
changes.

- **Selection.** job-argv adds a hidden flag to the run argv naming the ask
  directory (proposal: `--chat-asks <dir>`, dir =
  `<outputDir>/chat-jobs/<jobId>/asks/`). `initInteractionChain` builds the
  chat plugin when the flag is present, including in headless + `cli` (Claude).
  Not an environment variable: an env var would be inherited by any nested
  `nax` the run's own agents start (Claude).
- **Files.** One request file per ask, written atomically (tmp + rename):
  the `InteractionRequest`, the trigger safety tier when it is a trigger, the
  job id. The parent answers with an answer file. Whichever side settles the
  ask writes a settled marker so the other side closes its view. File format
  and polling vs `fs.watch` are builder.
- **Liveness.** The chat host writes a heartbeat file in the ask directory
  while it is open: before it spawns the job, and on re-attach after a
  restart. Stale heartbeat (builder: ~3 missed beats) or no heartbeat = chat
  closed (Claude).

Ask flow in the child (user order; timings Claude):

1. Write the request. If the heartbeat is stale, go straight to step 3.
2. Wait for a chat answer up to `chatAskFallbackMs` (reuse, default 60 s).
3. Also send it to the fallback plugin (Telegram / webhook) if one is
   configured. From here the first answer from either side wins; the loser is
   cancelled (`plugin.cancel`, settled marker).
4. At the ask's own timeout, resolve `respondedBy: "timeout"` and let the
   existing fallback apply unchanged (3.3: `escalate` and `continue` proceed,
   `skip` skips, `abort` aborts; tool approvals deny) (Claude).

`notify` requests (heads-ups) are written as notices and return at once.
When chat is closed they go to the fallback plugin as today.

### 4.2 Who answers (user rule; mechanism Claude)

The chat host watches the ask directory of every running job it owns or
re-attached. For each new ask:

- **Human card** when any of: the job is not under an approved full chain
  (`admit` would not return `auto`); the ask is a red-tier trigger or a
  `pre-merge` / `human-review` trigger; the job
  was re-attached after a chat restart (chain state is gone, 4.5); the agent
  has already answered 3 asks in a row with no user turn in between (a new
  cap for ask notices, separate from the task-notice cap; Claude); the agent
  escalated it. Card actions
  match the request type: approve / deny for `confirm` and approvals, the
  listed options for `choose`, free text for `input`.
- **Agent answers** otherwise. The ask is queued as a notice for the agent
  (ahead of plain job notices, Claude) and takes an agent turn when idle. The
  agent answers with a new no-card tool (proposal: `nax-jobs__answer_ask`
  with ask id, action or value, reason) or hands it to the user (an
  `escalate` action, which turns it into a human card). The answer shows as
  a read-only card: question, decision, reason, "answered by agent".
- Time spent waiting for the agent's turn counts toward the 60 s fallback
  window, including time the chat is busy with a user turn. A busy or slow
  chat therefore also offers the ask on Telegram; the chat card or agent
  can still answer, and the first answer wins (Claude).
- Ask notices are a new notice source in `use-jobs.ts`, taken before job and
  task notices (Claude).

Guards (Claude):
- An agent answer applies once. Only the user can choose a "remember / always
  allow" option on a tool approval; the agent's tool does not offer it.
- `respondedBy` records who answered: `chat-user`, `chat-agent`, or the
  fallback plugin's name. The approvals audit (`approvedBy`) and approval
  audit rows carry it.

### 4.3 Advisor notices (user, option (a))

Advisor heads-ups arrive as `notify` requests (4.1) and show in the
transcript as read-only notices naming the job, story and ruling. They do not
take an agent turn and need no answer. The run is unchanged: a flagged ruling
still keeps the PR a draft.

### 4.4 Launch card and notices (Claude)

- The "no channel for its own asks" warning in `jobs-launch.ts` and
  `chain-tools.ts` goes away for runs. When no fallback plugin is configured
  the card says instead: "asks you do not answer in chat fall to the run's
  timeout defaults".
- When an ask is settled elsewhere (Telegram, timeout) the card closes with
  how it ended ("answered on Telegram: approve", "timed out: skipped").

### 4.5 Chat restart (Claude)

Re-attached jobs keep their ask directory, so asks still reach the reopened
chat, but always as human cards: chain approval does not survive a restart
and this feature does not change that.

## 5. Changes outside the chat module (Claude; the builder verifies)

- `interaction/`: the chat plugin, and `initInteractionChain` accepting it.
- CLI: the hidden `--chat-asks` flag on `nax run`, `nax bot review` and
  `nax bot fix`.
- `bot/review-run.ts` and `bot/fix-run.ts`: today they call
  `buildPrStepContext` without an `interactionChain` (every ask
  deny/unavailable). With `--chat-asks` they build the chat-plugin chain
  (fallback = the configured plugin) and pass it; without the flag nothing
  changes. Which asks they actually raise (tool approvals in the fix agent,
  triggers) is for the builder to enumerate.
- `chat/jobs/job-argv.ts`: pass the flag; chain argv matching must ignore it
  or include it consistently.
- Audit: `respondedBy` / `approvedBy` values in 4.2.

## 6. Questions answered by the user (2026-10-29, after the builder check)

- **Q1.** Bot review / bot fix / plan have no interaction chain today. Give
  chat-launched bot jobs the same channel? **Yes, include bot review and
  fix** (user). Plan stays out (Claude).
- **Q2.** Under full approval, may the agent answer the yellow human gates
  `pre-merge` and `human-review`? **No: they always go to the user, like the
  red tier.** The agent answers everything else: cost-warning,
  story-oversized, review-gate, max-retries, tool approvals, clarifying
  questions, story-size and paused-story prompts (user agreed to Claude's
  proposal).

## 7. Left to the builder

- Ask-file schema, polling vs `fs.watch`, heartbeat period.
- Card layout for each request type.
- Story split and AC sizing (24-AC cap per story).

## 8. Decision log

| Decision | By | Date |
|---|---|---|
| Run asks show as a chat card, approve / deny in chat | user | 2026-10-29 |
| Agent answers on its own only under the approved full chain (same switch as slice 2 4.7) | user | 2026-10-29 |
| Red-tier triggers always go to the user | user | 2026-10-29 |
| `pre-merge` and `human-review` also always go to the user | user | 2026-10-29 |
| Bot review / bot fix jobs get the same channel; plan does not | user (plan: Claude) | 2026-10-29 |
| Timeout fallbacks unchanged (escalate/continue proceed) | Claude | 2026-10-29 |
| Absent heartbeat = chat closed; host writes it before spawn and on re-attach | Claude | 2026-10-29 |
| Ask notices: own source, before job/task notices, own cap of 3 agent answers in a row | Claude | 2026-10-29 |
| Busy chat counts toward the 60 s window; first answer wins | Claude | 2026-10-29 |
| Unanswered: Telegram, then the run's timeout default | user | 2026-10-29 |
| Advisor unchanged; its flagged rulings show as read-only notices (option (a)) | user | 2026-10-29 |
| One chat plugin in the child wraps the configured plugin as fallback | Claude | 2026-10-29 |
| Hidden argv flag, not env var | Claude | 2026-10-29 |
| Reuse `chatAskFallbackMs` (60 s) as the chat window | Claude | 2026-10-29 |
| Agent answers apply once, never "always allow" | Claude | 2026-10-29 |
| Re-attached jobs: human cards only | Claude | 2026-10-29 |
| TUI host only, no ACP / koda | Claude | 2026-10-29 |

## 9. Related documents

- `2026-10-27-nax-chat-workflow-dispatch-slice2-design.md` (4.6 names this
  follow-up; 4.7 the full-chain approval rule).
- `2026-10-24-nax-interactive-tui-slice1-design.md`.
