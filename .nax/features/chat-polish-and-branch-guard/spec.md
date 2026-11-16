# SPEC: chat-polish-and-branch-guard — root baseline per command, feature-branch launch guard, nax agent sources, chat footer and key polish

Closes: #2950, #2951, #2952, #2953, #2954, #2955

## Summary

Six fixes from tracking issue #2956. The root run-start baseline degrades per command, so a command that names its failures no longer hides a failing sibling that names none (#2950). `nax-jobs__plan` and `nax-jobs__run` (and a `nax-jobs__chain` proposal holding either) refuse while the checkout is on `main`, `master` or an unnamed branch, and the workflow instructions tell the agent to plan and run a feature on its feature branch (#2955). The chat agent catalog stops loading `~/.claude/agents/`, loads `~/.nax/agents/` instead, and gains a built-in read-only `explore` agent next to `general`; the `nax-agents__run` tool is offered even when the catalog has no agents (#2954). The transcript's bottom marker is centred (#2951). Background shells show in the footer as one `N shell(s)` part, and a click on the footer strip with exactly one shell and no job opens that shell's output (#2952). With a queued message and an empty prompt, ctrl+s sends the oldest queued message into the running turn, and the footer says so (#2953). Finally, a running turn stops only on a second Esc within two seconds, and a mouse report split after its first bytes no longer reaches Ink as a lone Escape — the probable cause of the abandoned subagent in #2930.

## Motivation

- #2950: `captureRunBaselineInner` (`test-baseline-capture.ts`) decides `unparseable` through `aggregateUnparseableFailure`, which degrades only when no command in the list named a failure. With `quality.commands.test: ["cmd-a", "cmd-b"]`, where `cmd-a` names one failure and `cmd-b` fails naming none, the baseline is `captured` with only `cmd-a`'s entry; every pre-existing `cmd-b` failure is later labelled `introduced`. The per-package path (`runGroup`) already uses the per-command `unparseableFailure`.
- #2955: a chat agent launched `nax-jobs__run` with the checkout on `main`, and the run committed onto `main`. `launchReason` (`chat/jobs/jobs-launch.ts`) only prints `on branch <name>` on the card; `nax run` does not check out `prd.branchName`; the only branch refusal is `auto-pr`'s `isPublishableBranch` at publish time, after the story commits have landed. The workflow instructions say nothing about branches.
- #2954: `discoverClaudeCodePackages` scans `~/.claude/agents/` (the `claude-user` package). Those agents are written for Claude Code, and they land in every nax chat's `nax-agents__run` listing. nax has no user-level agent directory of its own, and only one built-in agent (`general`). `createAgentsProvider` offers its tool only when the catalog has agents, so a chat with no agent files cannot reach `general` at all.
- #2951: the bottom marker row (`↓ Scroll to bottom (End)` / `↓ <n> new lines (End)`) is drawn flush left.
- #2952: each running background command is its own `bash <command>` footer part (`formatJobStrip`), so a few shells crowd the strip.
- #2953: a line typed during a turn is queued (`queued · <text>` rows), but nothing can send a queued line now: ctrl+s steers only the typed draft, and no hint names it.
- #2930: the abandoned `nax-agents__run` happened while the footer read `esc to close and stop`. A single Esc stops the turn (`ChatApp.tsx` `host.cancel()`, and `dismissQuestion` for a session question). Chat enables any-motion mouse tracking (`ENABLE_MOUSE` = `\u001b[?1003h\u001b[?1006h`), so moving the pointer over the window streams SGR reports; `filterReports` (`tui/chat/mouse-input.ts`) holds back a split report only once its `\u001b[<` prefix is complete, so a read that ends after `\u001b` or `\u001b[` hands Ink a lone Escape, which Ink reports as `key.escape`.

## Design

### Approach

**US-001 — root baseline per command.** `captureRunBaselineInner` replaces `aggregateUnparseableFailure(outcome)` with `unparseableFailure(outcome)`: the first command, in run order, that failed and whose own parse named no failure makes the baseline `unparseable` with that command's evidence. `aggregateUnparseableFailure` is deleted. Everything else on the root path is unchanged.

**US-002 — feature-branch launch guard.** A new exported function in `chat/jobs/jobs-launch.ts`:

```ts
// packages/nax/src/chat/jobs/jobs-launch.ts
export async function featureBranchRefusal(input: {
  readonly kind: "plan" | "run";
  readonly feature: string;
  readonly repoRoot: string;
}): Promise<string | undefined>;
```

It reads the checked-out branch with `_jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], repoRoot)` (the call `launchReason` already makes). When that call exits non-zero (detached HEAD, not a repository), it returns `undefined`: the branch is unknown and the launch is not refused. When the trimmed branch fails `isPublishableBranch(branch)` (`utils/git.ts`: `""`, `main`, `master`), it returns the refusal text:

```
[chat] nax <kind> for <feature> refused: the checkout is on <branch>; plan and run a feature on its feature branch <target>. Create or check out <target>, then launch again.
```

`<branch>` is the branch name, or `an unnamed branch` for `""`. `<target>` is the feature PRD's `branchName` when `<featureDir>/prd.json` exists and loads (through `_jobsLaunchDeps.exists` and `_jobsLaunchDeps.loadPRD`), otherwise `feat/<feature>` (the planner's default, `plan/strategies/context-builder.ts`). No default-branch lookup is made.

Call sites:
- `launchJob`: after `prepareTarget` and `unknownWorkflowProfile` succeed and before the busy check, a `plan` or `run` input whose `featureBranchRefusal` returns text ends the call with `{ isError: true, content: <text> }`; no approval is requested and no job starts. This covers chain auto-admission too, since it runs inside `launchJob`.
- `chain-tools.ts` `resolveStepTarget`: a `plan` or `run` step whose `featureBranchRefusal` returns text yields that step's error through `stepError(step, text)`, so no chain card is shown.

`buildWorkflowInstructions` (`prompts/builders/workflow-builder.ts`) gains one fixed line, placed after `pathsLine()` and before the optional lines:

```
A feature's `nax plan` and `nax run` happen on its feature branch (the PRD's branchName, by default feat/<feature>), never on main or master: create or check out that branch before the launch; `nax-jobs__plan` and `nax-jobs__run` refuse on main, master or an unnamed branch.
```

**US-003 — nax agent sources.** `discoverClaudeCodePackages` keeps scanning `~/.claude` for skills, commands, settings, hooks and MCP, but the `claude-user` package no longer scans `<claudeDir>/agents`: its `agents` is `[]`. The repo's `.claude/agents/` (`claude-project`) and enabled Claude plugins' agents are unchanged.

A new `ResourceOrigin` kind `{ kind: "nax-user" }` labels agents from `naxAgentsDir(env)/*.md`. `naxAgentsDir(env)` is a new export of `resources/claude-paths.ts`: `join(env.NAX_GLOBAL_CONFIG_DIR ?? join(_claudePathsDeps.homedir(), ".nax"), "agents")` — the same override and default as `globalConfigDir()`, read from the `env` that `loadResourceCatalog` is given rather than from `process.env`. The directory is scanned with `scanAgentsDir` into a package with id `nax-user`; the package is left out of the catalog when it holds no agents and no diagnostics (an absent directory yields neither). `loadResourceCatalog` loads it whether or not `resources.claudeCode` is enabled, and orders packages `[claude-project, nax-user, claude-user, …claude plugins, …nax plugins]`, so on a name clash a repo agent wins over a `~/.nax` agent, which wins over a plugin agent. `originLabel` returns `nax-user` for it.

`chat/builtin-agent.ts` gains `explore`:

```ts
export const EXPLORE_AGENT_NAME = "explore";
export function exploreAgent(): AgentResource; // tools ["Read", "Glob", "Grep", "Git"], origin nax-builtin, no model
```

`agentNamed(catalog, name)` resolves a catalog agent first, then the `general` and `explore` built-ins. `explore`'s prompt comes from a new `buildExploreAgentPrompt()` in `prompts/builders/agents-builder.ts` (read-only search: find and read code, report file paths and line numbers, change nothing), and its description is a new `EXPLORE_AGENT_DESCRIPTION` in `builtin-agent.ts`: `Searches and reads the codebase without changing it`.

The agent-facing text names `explore` in the sentence that already names `general`, so neither the instruction line count nor the overflow line moves: the sentence `For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.` is appended to `buildAgentsInstructions`'s third line and to the end of `RUN_DESCRIPTION` (`agents-provider.ts`). `createAgentsProvider` always offers the `run` tool and always returns instructions (the three fixed lines, then any catalog entries). The host attaches `nax-agents` whether or not the catalog has agents (`chat-host.ts`). `/agents` (`chat-agents-listing.ts`) stays a listing of catalog agents only.

**US-004 — transcript marker and footer shells.** The marker row in `TranscriptViewport.tsx` is centred in the viewport width (`justifyContent="center"` on the row), still truncated when wider than the window; `markerRowAt` keeps hit-testing the whole row. `formatJobStrip`, `FooterJob` and `FooterTask` stay in `chat-status.ts`; the per-task `taskPart` is removed. `chat-status.ts` is at 600 lines and `check:file-sizes` rejects a 601-line source file, so the rewritten strip must leave the file at or under 600 lines, with room for US-005's one new hint entry. The strip is: up to `JOB_STRIP_LIMIT` (2) job parts, then ` +<k>` for hidden jobs, then — when tasks run — the separator ` · ` and one part `1 shell` or `<n> shells` (for example `run a · run b +1 · 1 shell`). `use-jobs-opener.ts`: a left press and release on the footer strip reads, at click time, the running tasks from `host.tasks?.list()` and the running jobs from `host.jobs?.list()`. With exactly one running task and no running job it calls the new input `showOutput(taskEntry(task, now))` — the same listing Enter on that task's jobs-picker row produces, titled `bash <command> · running` — and opens no picker; otherwise it opens the jobs picker as today. ctrl+g always opens the jobs picker, so a lone shell can still be stopped there with ctrl+x. `useChatPicker` returns its existing `showOutput`, and `picker-model.ts` exports its existing `taskEntry`. The fitted footer's `N active (ctrl+g)` fallback (`status-layout.ts`) keeps counting each task.

**US-005 — send a queued message now.** `steerRunningTurn` in `ChatApp.tsx`: when a turn is sending, the draft is empty (its text trims to `""`), no interrupt send is pending (`interruptSend.current === undefined`), and the queue is non-empty, the oldest queued line is taken off the queue (`takeQueued`) and handed to the running turn exactly as a typed line would be (steer when the brain accepts, else interrupt and send next). With an interrupt send already pending, ctrl+s on an empty draft does nothing: the queue drains behind that send. A slash-line draft is not empty and keeps today's behaviour (ctrl+s does nothing). `footerHint` (`use-clipboard-feedback.ts`) takes a new optional `queued?: boolean` input (absent means `false`, so existing callers and fixtures that omit it keep today's result); when the turn is busy, no layer owns esc, and `queued` is true, it returns the new `FixedHint` `"queued"` (gesture `esc to interrupt`, extra `ctrl+s to send queued now`), ahead of `background`. `queued` is true when the queue is non-empty, the draft trims to `""`, and no interrupt send is pending.

**US-006 — Esc confirm and split mouse prefix.** A new `tui/chat/esc-confirm.ts` exports `ESC_CONFIRM_MS = 2_000` and a hook `useEscConfirm()` returning `{ armed: boolean; press(): boolean }`: `press()` returns `true` when it follows an armed press by less than `ESC_CONFIRM_MS` (read through `_chatKeyDeps.now`, exclusive like ctrl+c's `DOUBLE_INTERRUPT_MS`), and otherwise arms and returns `false`; a timer armed through a new `_escConfirmDeps = { setTimeout, clearTimeout }` clears `armed` (and so the hint) when the window passes. `press()` decides from the arm time held in a ref it writes synchronously, never from the rendered `armed`, so two Escapes delivered in one input batch with no render between them still confirm. The arm is also cleared when the turn ends and when the top Esc layer changes (for example a question card replacing the bare turn), so a new turn or a different layer never inherits it. Esc on the `turn` layer, and Esc on a `question` layer with `stops: true`, call `host.cancel()` / `dismissQuestion` only when `press()` returns `true`. `escHintText(layer, armed)` returns `esc again to interrupt` for an armed `turn` layer and `esc again to close and stop` for an armed stopping question; unarmed hints are unchanged. Every other Esc layer (approval, choice, non-stopping question, picker, menu, idle clear) keeps its single Esc. ctrl+c is unchanged.

`mouse-input.ts` holds a trailing `\u001b` or `\u001b[` at the end of a chunk as pending. When the next chunk continues it into `\u001b[<…`, the report is parsed as today; when it continues with anything else, the held bytes are forwarded ahead of it; when no data arrives within `ESC_FLUSH_MS = 50`, the held bytes are forwarded alone, so a real Esc press reaches Ink 50 ms later. The flush timer runs through a new exported `_mouseInputDeps = { setTimeout, clearTimeout }`; new data, the flush itself and `dispose()` each clear a pending timer.

### Integration (extends existing code)

The baseline below exists only to locate the code; it is never the interface to implement.

Changed symbols:
- `captureRunBaselineInner` (`packages/nax/src/execution/lifecycle/test-baseline-capture.ts:264`). Baseline: degrades through `aggregateUnparseableFailure(outcome)`. Target: degrades through `unparseableFailure(outcome)`.
- `aggregateUnparseableFailure` (`test-baseline-units.ts:190`). Target: deleted.
- `launchJob` (`chat/jobs/jobs-launch.ts`). Target: calls `featureBranchRefusal` for `plan` and `run` after `unknownWorkflowProfile` and before `busyJob`.
- `resolveStepTarget` (`chat/jobs/chain-tools.ts:53`). Target: calls `featureBranchRefusal` for `plan` and `run` steps.
- `buildWorkflowInstructions` (`prompts/builders/workflow-builder.ts:92`). Target: one more fixed line after `pathsLine()`.
- `discoverClaudeCodePackages` (`resources/claude-sources.ts:218`). Target: the `claude-user` package carries `agents: []`.
- `loadResourceCatalog` (`resources/catalog.ts:61`). Target: also loads the `nax-user` agents package, in the order above, independent of `resources.claudeCode`.
- `ResourceOrigin` (`resources/types.ts`). Target: adds `{ readonly kind: "nax-user" }`; `originLabel` (`resources/listing.ts`) handles it.
- `agentNamed` (`chat/builtin-agent.ts:24`). Target: also resolves `explore`.
- `createAgentsProvider` (`chat/agents-provider.ts`). Baseline: `tools` and `instructions` empty with no catalog agents. Target: always the `run` tool and instructions.
- `ChatHost` provider assembly (`chat/chat-host.ts:213`). Target: always appends `createAgentsProvider(...)`.
- `formatJobStrip(jobs, tasks)` (`tui/chat/chat-status.ts:313`). Target: same module and signature, tasks drawn as one `N shell(s)` part; `taskPart` removed.
- `useJobsOpener` (`tui/chat/use-jobs-opener.ts:61`). Target: input gains `showOutput(entry: PickerEntry): void`; the strip click branches on running tasks and jobs as above.
- `useChatPicker` (`tui/chat/useChatPicker.ts:126`). Target: return value gains its existing `showOutput(entry: PickerEntry): Promise<void>`.
- `taskEntry(task, nowMs)` (`tui/chat/picker-model.ts:231`). Target: exported, unchanged.
- `footerHint` (`tui/chat/use-clipboard-feedback.ts:14`). Target: input gains optional `queued?: boolean` (absent = `false`); may return `"queued"`.
- `FooterHint` / `HINT_PARTS` (`tui/chat/chat-status.ts:171`). Target: `"queued"` with gesture `esc to interrupt` and extra `ctrl+s to send queued now`.
- `escHintText(layer)` (`tui/chat/esc-layer.ts:95`). Target: `escHintText(layer, armed = false)`.
- `filterReports` / `createMouseInput` (`tui/chat/mouse-input.ts`). Target: hold and flush a trailing ESC prefix as described; new exports `ESC_FLUSH_MS = 50` and `_mouseInputDeps = { setTimeout, clearTimeout }`.
- `claude-paths.ts`. Target: new export `naxAgentsDir(env)`.
- `RUN_DESCRIPTION` (`chat/agents-provider.ts:9`) and `buildAgentsInstructions`'s third line (`prompts/builders/agents-builder.ts:43`). Target: the explore sentence appended.

Read-only symbols:
- `unparseableFailure(outcome)` (`test-baseline-units.ts:177`), `evidenceFor(run)`, `writeNoBaseline`.
- `isPublishableBranch(branch, defaultBranch?)` (`utils/git.ts:33`), `PROTECTED_BRANCHES` = `["", "main", "master"]`.
- `_jobsLaunchDeps` (`jobs-launch.ts:15`): `git`, `exists`, `loadPRD`; `featureDir(repoRoot, feature)` (`@/config`); `stepError` (`chain-tools.ts`).
- `scanAgentsDir(dir, origin)` (`resources/scan-dirs.ts:11`); `globalConfigDir()` (`config/paths/index.ts:63`).
- `generalAgent()`, `GENERAL_AGENT_NAME` (`chat/builtin-agent.ts`); `buildGeneralAgentPrompt` (`prompts/builders/agents-builder.ts:119`).
- `_chatKeyDeps.now` (`tui/chat/useChatKeys.ts:16`); `topEscLayer` (`tui/chat/esc-layer.ts:82`).
- `takeQueued(queue)` (`tui/chat/message-queue.ts:98`).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Root command list: one command names failures, a failing sibling names none | `no-baseline: unparseable`, evidence = the first such sibling. |
| `symbolic-ref --short HEAD` exits non-zero | Branch unknown; the launch is not refused (the card omits the branch, as today). |
| Checkout on `main`, `master` or `""` | `plan`/`run` launch and chain proposal refused with the refusal text; no card. |
| `prd.json` missing or unloadable when the refusal names its target | `<target>` is `feat/<feature>`. |
| `~/.nax/agents/` absent | No `nax-user` agents and no diagnostic. |
| Malformed agent file under `~/.nax/agents/` | The `scanAgentsDir` diagnostic, as for any agent directory. |
| ctrl+s, empty draft, empty queue | Nothing happens (as today). |
| Esc once during a running turn | Armed; hint `esc again to interrupt`; nothing cancelled. |
| Second Esc after `ESC_CONFIRM_MS` | Arms again instead of cancelling. |
| Trailing `\u001b` with no further data | Forwarded to Ink after `ESC_FLUSH_MS`. |

## Out of Scope

- The `nax run` CLI does not check or switch branches; only the chat launch tools refuse.
- The default branch read from `origin/HEAD` is not consulted by the launch guard; only `""`, `main` and `master` are refused.
- A launch on a detached HEAD is not refused.
- `nax-jobs__finish`, `nax-jobs__bot_review` and `nax-jobs__bot_fix` are not guarded by branch; publish keeps `auto-pr`'s own guard.
- Skills, commands, settings, hooks and MCP from `~/.claude` are still loaded; only `~/.claude/agents/` stops.
- The repo's `.claude/agents/` and Claude plugin agents are still loaded.
- `/agents` does not list the built-in `general` and `explore` agents.
- A long subagent run is not kept alive past its parent turn's end, nor moved to a background task (#2930 second half stays open).
- The native adapter's whole-turn deadline and idle watchdog aborts (`native/session-adapter.ts`) keep aborting with no reason; the ACP twin of the abandoned message is unchanged.
- ctrl+c still cancels a running turn on its first press.
- Approval, choice, non-stopping question, picker and menu layers keep a single Esc.
- Part-level hit-testing inside the footer strip is not added: a click anywhere on the strip acts on the whole strip.
- ctrl+g keeps opening the jobs picker in every case; only a strip click opens a lone shell directly.
- The fitted footer's `N active (ctrl+g)` fallback keeps counting each task and each job.
- `.nax/` files are not edited by this feature's stories; `.nax/features/run-start-baseline-fixes/spec.md` US-004 ("runs exactly as today") was updated by hand on this branch before the run.

## Stories

### US-001 — the root run-start baseline degrades per command

Workdir: packages/nax. No dependencies.

`captureRunBaselineInner` uses `unparseableFailure`, so a failing command that names nothing degrades the root baseline even when a sibling named failures; `aggregateUnparseableFailure` is deleted. Removal verified by the build/static gate: `bun run typecheck`.

### US-002 — chat plan and run launches refuse on main and master

Workdir: packages/nax. No dependencies.

`featureBranchRefusal` in `jobs-launch.ts`, wired into `launchJob` and `resolveStepTarget` for `plan` and `run`, plus one fixed workflow-instructions line.

### US-003 — nax agent sources and the built-in explore agent

Workdir: packages/nax. No dependencies.

The `claude-user` package stops scanning agents, a `nax-user` package loads `~/.nax/agents/`, `explore` joins `general` as a built-in, and the agents provider is always attached.

### US-004 — centred transcript marker and one footer part for shells

Workdir: packages/nax. No dependencies.

The marker row is centred; `formatJobStrip` draws tasks as one `N shell(s)` part; a strip click with one shell and no job shows that shell's output.

### US-005 — ctrl+s sends the oldest queued message now

Workdir: packages/nax. Depends on US-004.

`steerRunningTurn` takes the oldest queued line when the draft is empty; the footer offers `ctrl+s to send queued now`. Depends on US-004 because the new `"queued"` hint entry in `chat-status.ts` (at the 600-line limit) needs the lines US-004's strip rewrite frees by removing `taskPart`.

### US-006 — a running turn stops on a second Esc

Workdir: packages/nax. Depends on US-005.

`useEscConfirm` gates the turn and stopping-question Esc. Depends on US-005 because both edit the footer hint composition in `ChatApp.tsx`.

### US-007 — a split mouse-report prefix is not an Esc

Workdir: packages/nax. No dependencies.

`mouse-input.ts` holds a trailing ESC prefix for `ESC_FLUSH_MS`, through `_mouseInputDeps`.

### Context Files

**US-001**
- `packages/nax/src/execution/lifecycle/test-baseline-capture.ts` — `captureRunBaselineInner`
- `packages/nax/src/execution/lifecycle/test-baseline-units.ts` — `unparseableFailure`, `aggregateUnparseableFailure`
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture-evidence.test.ts` — root-path evidence fixtures

**US-002**
- `packages/nax/src/chat/jobs/jobs-launch.ts` — `launchJob`, `prepareRun`, `_jobsLaunchDeps`
- `packages/nax/src/chat/jobs/chain-tools.ts` — `resolveStepTarget`
- `packages/nax/src/utils/git.ts` — `isPublishableBranch`
- `packages/nax/src/prompts/builders/workflow-builder.ts` — `buildWorkflowInstructions`
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — launch fixtures

**US-003**
- `packages/nax/src/resources/claude-sources.ts` — `discoverClaudeCodePackages`, `basePackage`, `scanPackage`
- `packages/nax/src/resources/catalog.ts` — `loadResourceCatalog`, `indexResources`
- `packages/nax/src/chat/builtin-agent.ts` — `generalAgent`, `agentNamed`
- `packages/nax/src/chat/agents-provider.ts` — `createAgentsProvider`
- `packages/nax/src/chat/chat-host.ts` — provider assembly at line 213

**US-004**
- `packages/nax/src/tui/chat/TranscriptViewport.tsx` — `ViewportRows`, marker row
- `packages/nax/src/tui/chat/chat-status.ts` — `formatJobStrip`, `FooterJob`, `FooterTask`, `footerModel`
- `packages/nax/src/tui/chat/footer-segments.ts` — `rightSegments`
- `packages/nax/src/tui/chat/use-jobs-opener.ts` — `useJobsOpener`
- `packages/nax/src/tui/chat/useChatPicker.ts` — `showOutput`
- `packages/nax/src/tui/chat/picker-model.ts` — `taskEntry`

**US-005**
- `packages/nax/src/tui/chat/ChatApp.tsx` — `steerRunningTurn`, `steerText`, footer hint call site
- `packages/nax/src/tui/chat/message-queue.ts` — `takeQueued`
- `packages/nax/src/tui/chat/use-clipboard-feedback.ts` — `footerHint`
- `packages/nax/src/tui/chat/chat-status.ts` — `HINT_PARTS`, `FooterHint`
- `packages/nax/test/ui/chat/chat-steering.test.tsx` — steering fixtures

**US-006**
- `packages/nax/src/tui/chat/ChatApp.tsx` — turn Esc handler, `dismissQuestion`, `escLayer`
- `packages/nax/src/tui/chat/esc-layer.ts` — `topEscLayer`, `escHintText`
- `packages/nax/src/tui/chat/useChatKeys.ts` — `_chatKeyDeps`, `DOUBLE_INTERRUPT_MS` pattern
- `packages/nax/test/ui/chat/chat-app-esc-layers.test.tsx` — esc-layer fixtures

**US-007**
- `packages/nax/src/tui/chat/mouse-input.ts` — `filterReports`, `createMouseInput`
- `packages/nax/test/unit/tui/chat/mouse-input.test.ts` — existing stream fixtures

### Creates

**US-002**
- `packages/nax/test/unit/chat/jobs/jobs-launch-branch.test.ts` — launch and chain branch-guard tests

**US-003**
- `packages/nax/test/unit/resources/nax-user-agents.test.ts` — `~/.nax/agents` and `~/.claude/agents` discovery tests
- `packages/nax/test/unit/chat/builtin-explore-agent.test.ts` — `explore` resolution and provider tests

**US-004**
- `packages/nax/test/ui/chat/footer-shells.test.tsx` — marker centring and shell click tests

**US-005**
- `packages/nax/test/ui/chat/chat-steer-queued.test.tsx` — ctrl+s on a queued message and the queued hint

**US-006**
- `packages/nax/src/tui/chat/esc-confirm.ts` — `ESC_CONFIRM_MS`, `useEscConfirm`
- `packages/nax/test/ui/chat/chat-esc-confirm.test.tsx` — double-Esc tests

**US-007**
- `packages/nax/test/unit/tui/chat/mouse-input-esc-prefix.test.ts` — split ESC prefix tests

### Modifies

**US-001**
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture-evidence.test.ts` — the test "AC4: a named failure anywhere in the root command list keeps the baseline captured" pins the aggregate rule this story removes (`cmd-a` names one failure, `cmd-b` fails naming none, expected one `captured` write with no evidence); it becomes a test that the same fixture writes one `no-baseline` marker with reason `unparseable` and `evidence.command` equal to `cmd-b`, and its preceding comment about the aggregate rule is removed.

**US-002**
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts` — "US-007 appends the paths line then the choices line after the last original line" expects the lines after `ORIGINAL_LINES` to equal `[PATHS_LINE, CHOICES_LINE]`; the new branch line sits between them, so the expectation becomes `[PATHS_LINE, BRANCH_LINE, CHOICES_LINE]` with a `BRANCH_LINE` constant holding the new line's exact text, and the `slice(0, ORIGINAL_LINES.length)` and approval-wording tests stay.
- `packages/nax/test/unit/chat/jobs/jobs-launch-chain.test.ts` — the `_jobsLaunchDeps.git` stub at line 82 answers main, which the new guard refuses for plan and run launches; the stub answers feat/f1 instead, and every other assertion stays.
- `packages/nax/test/unit/chat/jobs/jobs-launch-nested.test.ts` — the `_jobsLaunchDeps.git` stub at line 70 answers main, which the new guard refuses for plan and run launches; the stub answers feat/f1 instead, and every other assertion stays.
- `packages/nax/test/unit/chat/jobs/jobs-launch-busy.test.ts` — the `_jobsLaunchDeps.git` stub at line 62 answers main, which the new guard refuses for plan and run launches; the stub answers feat/f1 instead, and every other assertion stays.
- `packages/nax/test/unit/chat/jobs/chain-tools-repo.test.ts` — the `_jobsLaunchDeps.git` stub at line 69 answers main, which the new guard refuses for plan and run steps; the stub answers feat/f1 instead, and every other assertion stays.

**US-003**
- `packages/nax/test/unit/chat/agents-provider.test.ts` — "AC-4 no agents yields no tools", "AC-9 instructions are undefined with no agents" and "AC-18 a catalog with no agents still advertises no tools" pin the empty-catalog gating this story removes; with no catalog agents the provider now yields exactly one tool named `run`, and its instructions' third line ends with `For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.`; `RUN_DESCRIPTION` (about line 251) and the general-agent sentence constant after it pin the tool description, and both gain that appended sentence.
- `packages/nax/test/unit/chat/chat-host-tasks.test.ts` — "AC-20 resources precede tasks without a nax entry" expects provider ids `["first", "second", "nax-tasks"]` for a catalog with no agents; the agents provider is now always attached, so the expected ids are `["first", "second", "nax-tasks", "nax-agents"]`.
- `packages/nax/test/unit/chat/host-subagents.test.ts` — "AC-2 start passes the resources' own providers when the catalog has no agents" asserts the providers minus the last equal the resources' providers and the last is `nax-tasks`; the agents provider is now always attached last, so the providers minus the last two equal the resources' providers, the second-to-last is `nax-tasks` and the last is `nax-agents`.
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts` — "resources-only host has confirmation and preserves provider/handler ordering" asserts the providers minus the last equal the resources' providers and the last is `nax-tasks`; the agents provider is now always attached last, so the providers minus the last two equal the resources' providers, the second-to-last is `nax-tasks` and the last is `nax-agents`.
- `packages/nax/test/unit/chat/chat-host-resources.test.ts` — the resume loop (about line 131) asserts the providers minus the last equal the resources' providers and the last is `nax-tasks`, and the `withResources` start (about line 250) expects `toolProviders` equal to the resources' providers then `nax-tasks`; the agents provider is now always attached last, so both expect the resources' providers, then `nax-tasks`, then `nax-agents`.
- `packages/nax/test/unit/prompts/builders/agents-builder.test.ts` — "AC-9 US-002: the third line names the general-agent fallback" expects the third line exactly; the line now ends with the appended sentence `For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.`, and the expectation gains it.
- `packages/nax/test/unit/resources/catalog.test.ts` — the `load` helper (about line 195) passes `env: { CLAUDE_CONFIG_DIR: claudeDir }`, which would now also read the developer's real home nax agents folder; the helper also passes NAX_GLOBAL_CONFIG_DIR pointing at a temp dir with no agents folder, and every assertion stays.

**US-004**
- `packages/nax/test/unit/tui/chat/chat-status-tasks.test.ts` — the strip cases expect one `bash <command>` part per task (for example `bash bun run test`, `plan f1 · bash ls`, `plan f1 · bash a +2`, and the elision and newline cases); tasks are now one `1 shell` / `<n> shells` part after the jobs, so each expectation becomes the shell count form (for example `1 shell`, `plan f1 · 1 shell`, `plan f1 · 3 shells`), the per-command elision and newline cases are removed, and the width assertions measure the new strip text.
- `packages/nax/test/ui/chat/footer-tasks.test.tsx` — "AC-14 draws the running task on the footer row" asserts the footer row contains `bash sleep 60`; it now asserts the footer row contains `1 shell` while the task runs and not after it ends.
- `packages/nax/test/ui/chat/jobs-opener.test.tsx` — `STRIP` is `bash <COMMAND>`, and "AC-11 opens the jobs picker at the strip's first column on the footer row" and "the strip's last column opens it too" click a strip holding one running task and no job and expect the jobs picker title; `STRIP` becomes `1 shell`, those two tests expect the transcript to list `bash <COMMAND> · running` and no picker title, and the no-action tests (AC-12 to AC-17) and the ctrl+g tests (AC-6, AC-18, AC-19, AC-20) keep their assertions.

**US-005**
None. The existing steering tests type a non-empty draft before ctrl+s, the existing footer tests run with an empty queue, and `queued` is optional, so the `FOOTER_HINT_INPUT` fixture in `chat-status.test.ts` that omits it still compiles and keeps its results.

**US-006**
- `packages/nax/test/ui/chat/chat-app-keys.test.tsx` — "AC-1 escape while a scripted turn runs calls host.cancel once" presses Escape once and expects one `host.cancel`; one Escape now only arms, so the test presses Escape twice and still expects exactly one `host.cancel`.
- `packages/nax/test/ui/chat/chat-app-esc-layers.test.tsx` — "AC-1 declines a session question and stops the turn it was asked during", "AC-15 a bare running turn keeps esc to interrupt and is cancelled once" and "AC-4 a no-git mention line does not keep esc from the turn" press Escape once and expect `["decline:q1", "cancel"]` / `["cancel"]`; a stopping question and a bare turn now need a second Escape, so each presses Escape twice and keeps its expected order.
- `packages/nax/test/ui/chat/chat-steering-host.test.tsx` — "B2 escape in that batch cancels the claim it started" batches `["hi", RETURN, ESCAPE]` and expects the turn's cancel to reach the live claim; one Escape now only arms, so the batch becomes `["hi", RETURN, ESCAPE, ESCAPE]` and the assertion stays.

**US-007**
- `packages/nax/test/unit/tui/chat/mouse-input.test.ts` — the `test.each` "AC-13 / AC-22 forwards Escape immediately" expects a lone `\u001b` and a lone `\u001b[` to be readable at once; they are now held for `ESC_FLUSH_MS`, so the test drives `_mouseInputDeps.setTimeout` (or advances its timer) and expects the same bytes after the flush and nothing before it.

### Seams

- US-002 creates `featureBranchRefusal`; the `launchJob` ACs and the `nax-jobs__chain` AC pin both call sites through `_jobsLaunchDeps.git`.
- US-003 creates `exploreAgent` and `EXPLORE_AGENT_NAME`; the `nax-agents__run` AC with `agent: "explore"` pins `agentNamed`'s use through the provider's `run` callback.
- US-004 adds `showOutput` to `useChatPicker`'s return and `taskEntry` to `picker-model.ts`'s exports; the rendered `ChatApp` strip-click AC pins `useJobsOpener`'s use of both.
- US-006 creates `useEscConfirm`; the rendered `ChatApp` double-Esc ACs pin its use on the turn and the stopping question.

## Acceptance Criteria

### US-001

1. [unit] `captureRunBaseline` with `_captureDeps.resolveTestCommands` returning `["cmd-a", "cmd-b"]`, both commands failing, `cmd-a` parsing to one named failure and `cmd-b` parsing to `failed: 4` with no named failure, writes exactly one baseline: `kind: "no-baseline"`, `reason: "unparseable"`, `evidence.command` equal to `cmd-b`.
2. [unit] `captureRunBaseline` with commands `["cmd-a", "cmd-b", "cmd-c"]`, all failing, `cmd-a` and `cmd-b` each naming one failure and `cmd-c` naming none, writes a `no-baseline` marker whose `evidence.command` is `cmd-c`.
3. [unit] `captureRunBaseline` with commands `["cmd-a", "cmd-b"]`, `cmd-a` failing with one named failure `{ file: "a.test.ts", testName: "fails" }` and `cmd-b` succeeding with no failures, writes one `captured` baseline whose `entries` equal `[{ file: "a.test.ts", testName: "fails" }]`.
4. [unit] `captureRunBaseline` with one command that fails and names no failure writes a `no-baseline` marker with `reason: "unparseable"` and `evidence.command` equal to that command.
5. [unit] `captureRunBaseline` with commands `["cmd-a", "cmd-b"]`, both failing, `cmd-a` naming one failure and `cmd-b` naming none, logs one info entry at stage `execution` whose data has `reason: "unparseable"` and `command: "cmd-b"`.

### US-002

1. [unit] `featureBranchRefusal({ kind: "run", feature: "f1", repoRoot })` with `_jobsLaunchDeps.git` answering `["symbolic-ref", "--short", "HEAD"]` with exit 0 and stdout `main\n`, and a loadable `prd.json` whose `branchName` is `feat/f1-x`, returns `[chat] nax run for f1 refused: the checkout is on main; plan and run a feature on its feature branch feat/f1-x. Create or check out feat/f1-x, then launch again.`
2. [unit] `featureBranchRefusal({ kind: "plan", feature: "f1", repoRoot })` with the branch `master` and no `prd.json` returns text that names `master` and the target `feat/f1`.
3. [unit] `featureBranchRefusal` with `_jobsLaunchDeps.git` answering exit 0 and stdout `\n` returns text that names `an unnamed branch`.
4. [unit] `featureBranchRefusal` with the branch `feat/f1` returns `undefined`.
5. [unit] `featureBranchRefusal` with `_jobsLaunchDeps.git` answering exit 1 (detached HEAD) returns `undefined`.
6. [unit] `featureBranchRefusal` with the branch `main` and `_jobsLaunchDeps.loadPRD` throwing for an existing `prd.json` returns text whose target is `feat/f1`.
7. [unit] `launchJob` for kind `run`, feature `f1`, a pending-story `prd.json`, and the branch `main` returns `isError: true` with the refusal text, makes no `options.approve` call and no `options.jobs.start` call.
8. [unit] `launchJob` for kind `plan`, feature `f1`, an existing `spec.md`, and the branch `main` returns `isError: true` with content starting `[chat] nax plan for f1 refused: the checkout is on main`, and makes no `options.approve` call.
9. [unit] `launchJob` for kind `run` on the branch `feat/f1` calls `options.approve` once.
10. [unit] `launchJob` for kind `bot_review` with the branch `main` calls `options.approve` once (bot launches are not guarded).
11. [unit] `launchJob` for kind `run` with no `prd.json` and the branch `main` returns `[chat] no prd.json for f1; run nax plan first` (the missing-PRD error is reported before the branch refusal).
12. [unit] `nax-jobs__chain` with steps `plan f1` then `run f1` and the branch `main` returns `isError: true` with content containing `nax plan for f1 refused`, and makes no `options.approve` call.
13. [unit] `nax-jobs__chain` with steps `bot_review` then `bot_fix` and the branch `main` calls `options.approve` once.
14. [unit] `buildWorkflowInstructions()` contains a line that includes `nax-jobs__plan`, `nax-jobs__run`, `main`, `master` and `feat/<feature>`.
15. [unit] `buildWorkflowInstructions()`'s new branch line sits directly after the line naming `prd-fidelity-report.md` and before any optional `chat.workflow` line.

### US-003

1. [unit] `discoverClaudeCodePackages` with `<claudeDir>/agents/reviewer.md` present returns a `claude-user` package whose `agents` is `[]`.
2. [unit] `discoverClaudeCodePackages` with `<claudeDir>/skills/<name>/SKILL.md` present still returns that skill on the `claude-user` package.
3. [unit] `discoverClaudeCodePackages` with `<repoRoot>/.claude/agents/reviewer.md` present returns a `claude-project` package with an agent named `reviewer`.
4. [unit] `loadResourceCatalog` with `env.NAX_GLOBAL_CONFIG_DIR` set to a temp dir holding `agents/helper.md` (frontmatter `name: helper`, `description: helps`) returns a catalog whose `findAgent("helper")` has `origin.kind === "nax-user"`.
5. [unit] `loadResourceCatalog` with `config.resources.claudeCode` set to `false` and `agents/helper.md` under `env.NAX_GLOBAL_CONFIG_DIR` still returns `findAgent("helper")`.
6. [unit] `loadResourceCatalog` with no `agents/` dir under `env.NAX_GLOBAL_CONFIG_DIR` returns a catalog whose `packages` hold no package with id `nax-user`.
7. [unit] `loadResourceCatalog` with an agent named `helper` both in `<repoRoot>/.claude/agents/` and in `<env.NAX_GLOBAL_CONFIG_DIR>/agents/` returns `findAgent("helper")` with `origin.kind === "claude-project"`.
8. [unit] `originLabel({ kind: "nax-user" })` returns `nax-user`, and `naxAgentsDir({ NAX_GLOBAL_CONFIG_DIR: "/g" })` returns `/g/agents`.
9. [unit] `agentNamed(catalog, EXPLORE_AGENT_NAME)` on a catalog with no `explore` agent returns an agent with `name: "explore"`, `description` equal to `EXPLORE_AGENT_DESCRIPTION`, `origin.kind === "nax-builtin"`, `tools` equal to `["Read", "Glob", "Grep", "Git"]` and no `model`.
10. [unit] `agentNamed(catalog, "explore")` on a catalog holding a discovered `explore` agent returns the discovered agent.
11. [unit] `exploreAgent().prompt` equals `buildExploreAgentPrompt()`, and `buildExploreAgentPrompt()` returns a non-empty string different from `buildGeneralAgentPrompt()`.
12. [unit] `createAgentsProvider` over `buildResourceCatalog([])` yields exactly one tool, whose `localName` is `run`.
13. [unit] `createAgentsProvider` over `buildResourceCatalog([])` returns instructions whose third line ends with `For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.`.
14. [unit] The `run` tool of `createAgentsProvider` called with `{ agent: "explore", task: "find X" }` over an empty catalog calls the `run` callback once with an agent named `explore` and task `find X`.
15. [unit] `ChatHost.start` with a catalog that has no agents passes a provider list to the session that ends with `nax-agents`.

### US-004

1. [unit] `formatJobStrip([], [{ command: "bun run test" }])` returns `1 shell`.
2. [unit] `formatJobStrip` over one `plan` job with target `f1` and three tasks returns `plan f1 · 3 shells`.
3. [unit] `formatJobStrip` over three `run` jobs with targets `a`, `b`, `c` and one task returns `run a · run b +1 · 1 shell`.
4. [unit] `formatJobStrip` over one `plan` job with target `f1` and no task returns `plan f1`.
5. [unit] `footerModel` (from `chat-status.ts`) with one task returns `stripWidth` equal to the display width of `1 shell`.
6. [integration] A rendered `ChatApp` with one running host task shows `1 shell` on the footer row and no `bash ` text there.
7. [integration] A rendered `TranscriptViewport` 60 columns wide, scrolled up, draws its marker row `↓ Scroll to bottom (End)` with a leading-space count of `floor((60 - 24) / 2)` or `ceil((60 - 24) / 2)`.
8. [integration] A rendered `TranscriptViewport` 60 columns wide with unseen lines draws its `↓ <n> new lines (End)` marker centred by the same rule.
9. [integration] A rendered `TranscriptViewport` 10 columns wide, scrolled up, draws a marker row no wider than 10 columns.
10. [integration] A rendered `ChatApp` with exactly one running task `sleep 60` and no job: a left press and release on the footer strip appends a transcript listing titled `bash sleep 60 · running`, and no picker opens.
11. [integration] A rendered `ChatApp` with two running tasks: a left press and release on the footer strip opens the jobs picker.
12. [integration] A rendered `ChatApp` with one running task and one running job: a left press and release on the footer strip opens the jobs picker.
13. [integration] A rendered `ChatApp` with exactly one running task and no job: ctrl+g opens the jobs picker.

### US-005

1. [integration] A rendered `ChatApp` whose brain steers, during a running turn, with one queued line `next please` and an empty prompt: ctrl+s calls `host.steer` once with `next please`.
2. [integration] A rendered `ChatApp` whose brain steers and accepts the steer, during a running turn, with one queued line `next please` and an empty prompt: after ctrl+s, no `queued · next please` row is drawn and a `steering · next please` row is.
3. [integration] A rendered `ChatApp` with queued lines `one` then `two` and an empty prompt: ctrl+s calls `host.steer` with `one`, and the queue rows show only `queued · two`.
4. [integration] A rendered `ChatApp` whose brain answers `host.steer` with `unsupported`, with one queued line `next please` and an empty prompt: ctrl+s calls `host.cancel` once, and the next turn sent after the cancelled turn settles carries `next please`.
5. [integration] A rendered `ChatApp` during a running turn with a queued line and the prompt holding `draft`: ctrl+s calls `host.steer` with `draft`, and the queued line stays queued.
6. [integration] A rendered `ChatApp` during a running turn with an empty queue and an empty prompt: ctrl+s calls neither `host.steer` nor `host.cancel`.
7. [unit] `footerHint({ busy: true, queued: true, layer: false, quitArmed: false, clearArmed: false, expanded: false, backgroundable: true, tmux: false })` returns `"queued"`.
8. [unit] `footerHint({ busy: true, queued: false, layer: false, quitArmed: false, clearArmed: false, expanded: false, backgroundable: true, tmux: false })` returns `"background"`.
9. [unit] `footerHint` with `busy: true`, `queued: true` and `layer: true` returns `"layer"`.
10. [unit] `hintSpans("queued")` returns gesture `esc to interrupt` and extra `ctrl+s to send queued now`.
11. [integration] A rendered `ChatApp` during a running turn with one queued line and an empty prompt shows `ctrl+s to send queued now` on the footer row.
12. [integration] A rendered `ChatApp` during a running turn with one queued line and the prompt holding `draft` does not show `ctrl+s to send queued now` on the footer row.
13. [integration] A rendered `ChatApp` whose brain answers `host.steer` with `unsupported`, after ctrl+s on a typed `first` left an interrupt send pending, with queued lines `a` then `b` and an empty prompt: a second ctrl+s makes no further `host.steer` or `host.cancel` call, and the queue rows still read `queued · a` then `queued · b`.
14. [integration] A rendered `ChatApp` during a running turn with one queued line and the prompt holding only spaces: ctrl+s calls `host.steer` with the queued line.

### US-006

1. [unit] `useEscConfirm().press()` once returns `false` and leaves `armed` true.
2. [unit] `useEscConfirm().press()` twice with `_chatKeyDeps.now` advanced by 1,999 ms between them returns `true` on the second press.
3. [unit] `useEscConfirm().press()` twice with `_chatKeyDeps.now` advanced by 2,000 ms between them returns `false` on the second press and leaves `armed` true.
4. [unit] `escHintText({ kind: "turn" }, true)` returns `esc again to interrupt`.
5. [unit] `escHintText({ kind: "question", stops: true }, true)` returns `esc again to close and stop`.
6. [unit] `escHintText({ kind: "question", stops: true }, false)` returns `esc to close and stop`, and `escHintText({ kind: "turn" }, false)` returns `undefined`.
7. [integration] A rendered `ChatApp` during a running turn: one Escape makes no `host.cancel` call and the footer row shows `esc again to interrupt`.
8. [integration] A rendered `ChatApp` during a running turn: two Escapes within `ESC_CONFIRM_MS` make exactly one `host.cancel` call.
9. [integration] A rendered `ChatApp` during a running turn: two Escapes with `_chatKeyDeps.now` 2,000 ms apart make no `host.cancel` call.
10. [integration] A rendered `ChatApp` with a session question raised during a running turn: one Escape neither declines the question nor cancels, and the footer shows `esc again to close and stop`; a second Escape within the window declines it and then cancels, in that order.
11. [integration] A rendered `ChatApp` with an approval card shown: one Escape denies it.
12. [integration] A rendered `ChatApp` with a question card asked by the host (not the session) during a running turn: one Escape declines it and makes no `host.cancel` call.
13. [integration] A rendered `ChatApp` during a running turn: one ctrl+c makes exactly one `host.cancel` call.
14. [integration] A rendered `ChatApp` during a running turn: after one Escape, running the `_escConfirmDeps.setTimeout` callback returns the footer row to `esc to interrupt`.
15. [integration] A rendered `ChatApp`: one Escape during a running turn, then the turn ends and a new turn starts within `ESC_CONFIRM_MS`; one Escape on the new turn makes no `host.cancel` call.

### US-007

1. [unit] `createMouseInput` given the chunk `\u001b` then, before `ESC_FLUSH_MS`, the chunk `[<0;10;5M` emits one left `press` event at x 10, y 5 and forwards no text to Ink.
2. [unit] `createMouseInput` given the chunk `\u001b[` then the chunk `<35;3;4M` emits one `move` event and forwards no text to Ink.
3. [unit] `createMouseInput` given the chunk `\u001b` and no further data forwards nothing before `ESC_FLUSH_MS` and forwards `\u001b` once the `_mouseInputDeps.setTimeout` callback runs.
4. [unit] `createMouseInput` given the chunk `\u001b` then the chunk `x` forwards `\u001bx` and leaves no flush pending.
5. [unit] `createMouseInput` given one chunk `a\u001b[<0;1;1Mb` forwards `ab` and emits one event, as today.
6. [unit] `createMouseInput` after `dispose()` with a held `\u001b` forwards nothing when the flush timer would have run.
