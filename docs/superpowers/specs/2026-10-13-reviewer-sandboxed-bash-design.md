# Reviewer sandboxed Bash, and the sandbox for ACP Claude (nax#2500)

**Date:** 2026-10-13 · **Issue:** nax#2500 · **Status:** design approved in brainstorming, spec awaiting review
**Branch:** `feat/2500-reviewer-sandboxed-bash` (off main `93f8818c7`)

## 1. Problem

Read-only reviewer ops cannot run the commands a review needs.

- **Native:** reviewer ops declare `Read/Glob/Grep/Git`. There is no `Bash`, so a reviewer cannot run a
  formatter in check mode, a linter on one file, or a scoped test.
- **ACP (claude):** a declaration with no write-class tool opens the ACP `read` profile
  (`nax/src/agents/acp/profile-map.ts`). Under `read`, `decidePermission`
  (`nax-agent-acp/src/client/permissions.ts`) denies every permission request, so even `git diff` fails
  ("profile read rejects every permission request"). nax's MCP session tools are offered only to `ask`
  and `full` (`nax-agent-acp/src/server/mcp/session-tools.ts:39`), so the declared `Git` tool is
  dropped too.
- Reviewers then report such checks as `cannot-verify` and base findings on gate output they cannot
  reproduce. Observed: an ACP Claude branch review on rs-stock could not run `uv run ruff format --check .`.

A related gap found while designing: **ACP Claude implementers run unsandboxed.** With the default
`permissionProfile: unrestricted`, `resolvePermissions` gives `approve-all`, `acpProfileFor` gives
`full`, and `decidePermission` allows every request. Claude's own Bash runs with no OS wall, while
native Bash runs inside `srt` (`nax-agent/src/sandbox/`). The #2497 run-state keeper already runs after
every turn on both transports (`nax/src/runtime/index.ts`, `afterTurn`), so nax's run state is covered;
the repo and the machine are not.

## 2. Approach (chosen over alternatives)

Give reviewers real `Bash` inside the same sandbox as implementers, and make the consequences safe
(revert after the turn) instead of filtering commands.

Rejected:
- **Named-check tool** (`RunCheck{name}` over `quality.commands`): safe, but a tight-harness allowlist;
  a reviewer cannot run a one-off check the config does not declare.
- **Free-form Bash screened by a read-only command allowlist:** command parsing whack-a-mole, the same
  class of work the command guard was frozen against on 2026-10-13; `uv run`/`pytest` still write caches.
- **nax pre-runs checks and inlines output:** the reviewer cannot re-run after reading code.

## 3. Rulings (user, 2026-10-13)

- **R1** Approach = sandboxed Bash for reviewers + post-turn revert (approach 4).
- **R2** Scope includes ACP Claude implementers: the same sandbox mapping applies to every ACP Claude
  session that has Bash (`review` and `full`).
- **R3** The command-safety guard (#2292) and the #2490 rules are not involved and not changed. The
  harm guard answers "is this dangerous", not "is this read-only", and it stays opt-in.
- **R4** Under `full`, Claude file-tool edits are path-checked against the same policy (deny targets in
  `denyWrite` or outside `writeRoots`).
- **R5** Other ACP agents (codex, gemini, opencode, pi) are out of scope; `review` fails closed on them
  like `read` does today (#2372).

## 4. Design

### 4.1 Reviewer ops gain `Bash`

| Op | Session role | Tools after |
|---|---|---|
| `semantic-review` | `reviewer-semantic` | Read, Glob, Grep, Git, **Bash** |
| `adversarial-review` | `reviewer-adversarial` | Read, Glob, Grep, Git, **Bash** |
| `finish-spec-review` | `finish-review-spec` | Read, Glob, Grep, Git, **Bash** |
| `finish-branch-review` | `finish-review-quality` | Read, Glob, Grep, Git, **Bash** |
| `workflow-story-review`, `workflow-re-review`, `workflow-branch-review` (`WORKFLOW_REVIEW_TOOLS`) | `wf-story-review`, `wf-rereview`, `wf-branch-review` | Read, Glob, Grep, Git, **Bash** |

Unchanged (they judge findings, they do not verify code): `fix-review`, `nbf-worth-check`,
`advise-batch`. The plan confirms each op's session role against `SessionManager.nameFor` callers.

Prompt: each reviewer builder (in `src/prompts/builders/`) gains one shared paragraph: commands are for
verification (formatters in check mode, linters, scoped tests, git); do not edit files; any change to
the working tree is reverted after the turn.

### 4.2 Profile tier `review`

`AgentSessionProfile` (`nax-agent/src/session/agent-session-types.ts`) becomes
`"none" | "read" | "review" | "ask" | "full"`.

`acpProfileFor(mode, declaredTools)` (`nax/src/agents/acp/profile-map.ts`):

| Declaration | `approve-all` | `approve-reads` / default |
|---|---|---|
| none / empty | mode decides (`full`) | `read` |
| has a file-write tool (`Write`, `Edit`, `Delete`, `GitCommit`) | `full` | `read` |
| has `Bash`/`Exec`/`RunCommand`, no file-write tool | **`review`** | `read` |
| neither | `read` | `read` |

`ACP_WRITE_CLASS_TOOLS` splits into file-write tools and command tools. `review` is never wider than
the resolved mode.

nax-agent-acp, `review` profile (claude only):
- `decidePermission`: a Bash permission request is allowed (it also auto-allows under the sandbox, see
  4.3); every other request is denied, as under `read`.
- Read-only enforcement as `read` (`registry.ts` claude `readOnly`: `disallowedTools` Write, Edit,
  MultiEdit, NotebookEdit, EnterPlanMode; `settingSources: []`), so `readOnlyFor` and `modeFor` treat
  `review` like `read`.
- MCP session tools are offered (`session-tools.ts` `offers`), so nax's `Git` arrives. The
  `claudeCode.allowedTools` pre-approval lists them as today.
- Elicitation stays off (`clientCapabilitiesFor`), as under `read`.
- Agents without the claude read-only enforcement reject `review` with
  `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, the same rule as `read`.

nax-agent facade (`session-tool-support.ts` `declaredToolsFor`): `review` = universal + READ_TOOLS +
`Bash`. The S5 ACP server does not advertise `review` in its user-facing mode list (`nax-config.ts`
`MODES`); it is an embedder profile only.

Native nax runs need no profile change: the op's declared tools decide what the session exposes, and
native `Bash` already runs in the sandbox.

### 4.3 Sandbox for ACP Claude (`review` and `full`)

- **One policy source.** On an ACP open whose profile is `review` or `full`, nax computes the session
  sandbox policy with the same inputs native uses (`resolveSessionSandbox`,
  `nax-agent/src/coding-tools/coding-tool-sandbox.ts`, and `buildSandboxPolicy`): workdir, run temp
  roots, git guard files, `.nax` entries, owned paths, credential files, config
  `execution.sandbox.filesystem.allowWrite/denyRead/allowSharedTmp` and `network.allowedDomains`.
- **Transport.** The policy travels on the open request as a new optional field (plain data:
  `writeRoots`, `denyWrite`, `denyRead`, `network`). nax-agent-acp never computes policy.
- **Mapping (claude registry entry).** Added to `_meta.claudeCode.options` beside the existing
  `allowedTools`/read-only options (`pre-approval.ts` `claudeSessionMeta`):

  ```
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite: writeRoots, denyWrite, denyRead },
    network: { allowedDomains }        // only when configured
  }
  ```

  The keys exist in the Claude Agent SDK 0.3.286 `SandboxSettings` and claude-agent-acp 0.85.1 passes
  `sandbox` through (`OPTION_REBUILDS_SESSION`).
- **Config.** `execution.sandbox.enabled: false` sends no sandbox (same as native). Enabled but the
  policy cannot be built, or the agent cannot sandbox: the open fails (4.5). Never a silent unsandboxed
  session.
- **R4 file-tool path check (`full`).** The sandbox wraps Bash only. Under `full`, `decidePermission`
  receives Claude's Write/Edit permission requests; when the request names a path, deny it if the path
  is under `denyWrite` or outside every `writeRoots` entry (resolved, symlink-aware like the native
  owned-paths check). Requests with no resolvable path keep today's behaviour.
- **Accepted gap.** Claude's `Read` tool is not sandboxed and reads inside the workdir without a
  permission request, so `denyRead` (credentials) is enforced for Bash only. Documented, not chased.

### 4.4 Revert reviewer changes after each turn

- **Where.** The runtime turn hooks that host the #2497 `afterTurn` repair (`nax/src/runtime/index.ts`),
  extended with a before-turn snapshot. Applies only to reviewer session roles (4.1 table). The role
  set is one exported constant.
- **Snapshot (before the turn):** `HEAD`; the tracked working tree and index as a commit object
  (`git stash create`, no ref, nothing written to the stash list) or `HEAD` when clean; the list of
  untracked, non-ignored files (`git ls-files --others --exclude-standard`).
- **After the turn:**
  - `HEAD` moved: `git reset --soft` back to the snapshot `HEAD` (a reviewer has no `GitCommit`, but
    Bash can `git commit`).
  - Tracked files that differ from the snapshot (index or working tree, including those a moved `HEAD`
    left staged): restored path-only, index and working tree, from the snapshot.
  - Untracked, non-ignored files not in the snapshot list: deleted. Pre-existing ones are left alone.
  - Git-ignored paths are never touched (`.venv`, caches, `node_modules`, build output).
  - `.nax` run state is left to the #2497 keeper, which runs in the same hook.
- **Reporting.** One `reviewer-tree-reverted` log line (storyId first, role, paths, headMoved) and a
  ledger entry. The review result is used as returned; a revert never fails a review.
- **Concurrency.** Reviewers may run concurrently with each other in one checkout (A4 finish runs the
  spec and branch reviews in parallel). Each restores to its own snapshot; since neither writes
  legitimately, both snapshots describe the same tree. No writer shares a checkout with a reviewer
  (pipeline `--parallel` stories use separate worktrees; workflow mode is sequential). The plan
  verifies this assumption against the call sites.

### 4.5 Failure handling

| Case | Behaviour |
|---|---|
| ACP Claude, sandbox enabled, unavailable on host | Claude SDK `failIfUnavailable` ends the session with an error; nax surfaces it as a session failure; existing fallback/escalation handles it |
| Policy cannot be built on the nax side (probe fails) | Open fails with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and the reason; never opens unsandboxed |
| `review` on codex/gemini/opencode/pi | `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, as `read` today |
| Revert fails (git error, lock) | `[WARN]` log + ledger entry, review result kept; the #2497 keeper still guards run state |
| Native, sandbox unavailable | Unchanged: raw Bash refuses (existing `rawBashRefusalReason`) |

## 5. Out of scope

- Command-safety guard (#2292) and #2490 rules: unchanged (R3).
- Sandboxing other ACP agents (R5).
- Restricting Claude's `Read` tool (4.3 accepted gap).
- New config keys. Everything rides on `execution.sandbox` and `execution.permissionProfile`.
- `fix-review`, `nbf-worth-check`, `advise-batch` tool lists.

## 6. Testing

Unit:
- `acpProfileFor`: every row of the 4.2 table, both modes.
- Policy to Claude `sandbox` options mapping: enabled, disabled (absent), network configured/absent.
- `claudeSessionMeta`: `review` carries read-only enforcement + tool rules + sandbox; `full` carries
  tool rules + sandbox; `read`/`none` carry no sandbox.
- `decidePermission`: `review` allows Bash, denies others; `full` path check (inside root, `denyWrite`,
  outside roots, symlink escape, no path).
- `session-tools` offers under `review`; `declaredToolsFor("review")`.
- Revert: tracked edit, new untracked file, pre-existing untracked file kept, ignored path kept,
  `HEAD` moved, clean tree, non-reviewer role untouched, git failure logged.
- Reviewer op tool lists include `Bash`; unchanged ops unchanged.

Integration:
- Native reviewer session in a temp git repo runs a check command and a stray write; the write is
  reverted and logged.
- ACP open with a fake agent: the request `_meta` carries the sandbox for `review` and `full`.

Live check (billed, needs approval at launch):
- One ACP Claude branch review on rs-stock runs `uv run ruff format --check .`; the tool audit shows no
  denied Bash.
- One ACP Claude implementer turn that writes outside the workdir is blocked (Bash by the sandbox,
  Write by the R4 path check).

## 7. Rollout

No config change; on by default through `execution.sandbox.enabled` (default true) and the permission
profile. Release note: ACP Claude implementer sessions now run Bash inside the sandbox and file edits
outside the write roots are denied.
