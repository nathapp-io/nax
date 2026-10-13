# Reviewer sandboxed Bash, and the sandbox for ACP Claude (nax#2500)

**Date:** 2026-10-13 · **Issue:** nax#2500 · **Status:** rev 2 after one read-only review (3 blocker, 8 major folded); awaiting user review
**Branch:** `feat/2500-reviewer-sandboxed-bash` (off main `93f8818c7`)

## 1. Problem

Read-only reviewer ops cannot run the commands a review needs.

- **Native:** reviewer ops declare `Read/Glob/Grep/Git`. There is no `Bash`, so a reviewer cannot run a
  formatter in check mode, a linter on one file, or a scoped test.
- **ACP (claude):** a declaration with no write-class tool opens the ACP `read` profile
  (`nax/src/agents/acp/profile-map.ts`). Under `read`, `decidePermission`
  (`nax-agent-acp/src/client/permissions.ts`) denies every permission request, so even `git diff` fails
  ("profile read rejects every permission request"). nax's built-in `Git` tool is not delivered to ACP
  sessions at all (only provider MCP tools are), so Claude's own Bash is the only way to run git there.
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

Prompt: one shared section in `src/prompts/builders/`, included by every reviewer builder: commands are for
verification (formatters in check mode, linters, scoped tests, git); do not edit files; any change to
the working tree is reverted after the turn.

### 4.2 Profile tier `review`

`AgentSessionProfile` (`nax-agent/src/session/agent-session-types.ts`) becomes
`"none" | "read" | "review" | "ask" | "full"`; `AcpProfile` (`nax/src/agents/acp/profile-map.ts`)
becomes `"full" | "review" | "read"`.

`acpProfileFor(mode, declaredTools)`:

| Declaration | `approve-all` | `approve-reads` / default |
|---|---|---|
| none / empty | `full` (mode decides, unchanged) | `read` |
| any file-write tool (`Write`, `Edit`, `Delete`, `GitCommit`), with or without command tools | `full` | `read` |
| command tool (`Bash`, `Exec`, `RunCommand`), no file-write tool | **`review`** | `read` |
| otherwise (read tools only) | `read` | `read` |

`ACP_WRITE_CLASS_TOOLS` splits into `ACP_FILE_WRITE_TOOLS` and `ACP_COMMAND_TOOLS`; its one caller
(`profile-map.ts`) is the only consumer. `review` is never wider than the resolved mode.

Every consumer of the two unions handles `review` explicitly (no fall-through):

| Consumer | `review` behaviour |
|---|---|
| zod enum `nax-agent/src/session/agent-session-options.ts` | accepts `review` |
| `nax/src/agents/tool-surface.ts` `profile?:` and `ToolSurfaceRecord.profile` (`tool-audit.ts`) | widened type; audit records `review` |
| nax-agent-acp `client/capabilities.ts` `isReadOnlyProfile` | true (so `readOnlyFor`/`modeFor` in `open.ts` apply the claude read-only enforcement: `disallowedTools` Write, Edit, MultiEdit, NotebookEdit, EnterPlanMode; `settingSources: []`; `allowDangerouslySkipPermissions: false`; mode `default`) |
| `client/open.ts` `clientCapabilitiesFor` | no elicitation (as `read`) |
| `client/permissions.ts` `decidePermission` | new `case "review"` (below) |
| `client/elicitation.ts` | declines (as `read`), unchanged |
| nax-agent facade `session-tool-support.ts` `declaredToolsFor` | universal + READ_TOOLS + `Bash` (no write tools) |
| `session-tool-support.ts` `resolveSessionLauncher` | applies the sandbox floor to `review` as to `ask`/`full` |
| `native-backend-options.ts` `nativeProfileRules` | `review` has tools and accepts `bashApproval` |
| S5 server `nax-config.ts` `MODES` + zod enum, `session-config.ts`, `open-session.ts` `TOOL_PROFILES`, `notices.ts` | not advertised to users; `MODES` unchanged; `TOOL_PROFILES` unchanged (S5 sessions never open `review`) |

`decidePermission` under `review` (claude only):
- A request whose ACP `kind` is `execute` is allowed (Claude's Bash; normally pre-allowed by
  `autoAllowBashIfSandboxed`, 4.3, so this is the fallback path).
- A network permission request (Claude's `SandboxNetworkAccess`) follows 4.3 network rules.
- Every other request is denied, as under `read`.

Only provider MCP tools reach ACP sessions (`finalizeAcpSurface`, `nax/src/agents/acp/provider-embedder.ts`);
nax's built-in coding tools, including `Git`, do not. ACP reviewers therefore run git through Claude's own
Bash, which `review` allows. Delivering nax's built-in `Git` over MCP is not needed and is out of scope.
The S5 server's `session-tools.ts` `offers` governs user-configured MCP servers only and is NOT changed.

Agents other than claude reject `review` with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, the same rule as
`read` (#2372).

Native nax runs: the op's declared tools decide what the session exposes, and native `Bash` already
runs in the sandbox through the dispatch launcher. Reviewer `bashApproval` is whatever the permission
profile resolves (`unrestricted` = not gated). Under `gated`/`escalate`, reviewer Bash asks and is
refused when unattended; the reviewer then reports `cannot-verify`, as today.

### 4.3 Sandbox for ACP Claude (`review` and `full`)

**Policy extraction.** `resolveSessionSandbox` (`nax-agent/src/coding-tools/coding-tool-sandbox.ts`)
returns a `CommandLauncher`; the policy is built per command inside its `policyFor` closure. Extract
that body into an exported pure `buildSessionPolicy(inputs)` that both the launcher and the ACP path
call. Inputs are those `resolveDispatchLauncher` (`nax/src/agents/coding-tool-support-resolve.ts`)
already gathers: `outputDir`, `runTmpRoot`, `tmpDir`, protected paths, owned paths, git layout,
`config.execution.sandbox`.

**Plumbing.** nax computes `{ policy, available }` where it resolves the dispatch launcher and carries
it on a new optional `OpenSessionOpts.sandboxPolicy` (`nax-agent/src/session/session-types.ts`),
forwarded by `runtime/session-run-hop.ts` to `openSession`, and onto a new
`BackendOpenContext.sandbox` (`session-backend.ts`) for the ACP backend. The field is plain data
(`writeRoots`, `denyWrite`, `denyRead`, `network`). nax-agent-acp never computes policy.

**Mapping (claude registry entry).** Added to `_meta.claudeCode.options` by `claudeSessionMeta`
(`client/pre-approval.ts`) when the profile is `review` or `full` and a policy is present:

```
sandbox: {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  filesystem: { allowWrite: writeRoots, denyWrite, denyRead },
  network: { allowedDomains }        // only when nax's policy has an allow-list
}
```

Keys verified in Claude Agent SDK 0.3.286 `SandboxSettings`; claude-agent-acp 0.85.1 passes `sandbox`
through and rebuilds the session when it changes (`OPTION_REBUILDS_SESSION`).

**Network semantics.** nax: absent `allowedDomains` = open network. Claude: an unlisted domain raises
a `SandboxNetworkAccess` permission request. So: when nax's network is open, `decidePermission` allows
network requests under `review` and `full`; when nax has an allow-list, it is passed as
`allowedDomains` and network requests are denied.

**Resume and staleness.** The policy is computed at open and again at resume/load (the same `_meta`
path). Paths added mid-session (a worktree created during the session, new `.nax` entries) are not
reflected until the next open; native recomputes per command. Accepted: sessions are per story/role
and short-lived relative to such changes.

**Config.** `execution.sandbox.enabled: false` sends no sandbox (same as native). Under `review`, commands are then denied when no sandbox policy is present, even though sandboxing is disabled (controller ruling R3); native reviewers lose Bash without a usable sandbox (R9).

**R4 file-tool path check (`full`).** The sandbox wraps Bash only. Under `full`, Claude's edit tools
raise permission requests with ACP `kind` `edit` (or `delete`/`move`). `decidePermission` takes the
target paths from `toolCall.locations[*].path` and `rawInput.file_path` / `rawInput.notebook_path`
(this deliberately uses display fields for a decision, overriding the D3-a "display only" note in
`client/tool-display.ts`; the override is commented at the site). Each path is resolved (relative to
the session cwd, `~` expanded, realpath of the deepest existing ancestor). Deny when any path is under
`denyWrite` or outside every `writeRoots` entry. A request with no resolvable path keeps today's
behaviour (allow). nax sets the claude session mode explicitly (`modeFor`), so a settings
`defaultMode` cannot bypass requests; `allowDangerouslySkipPermissions: false` is added for `full`.
**Accepted gap:** under `full`, Claude still loads user/project settings (`settingSources` is blanked
only for read-only profiles, because implementers need the project's CLAUDE.md), so a settings allow
rule for Edit/Write pre-approves edits without a request and bypasses R4.

**Accepted gap.** Claude's `Read` tool is not sandboxed and reads inside the workdir without a
request, so `denyRead` (credentials) is enforced for Bash only.

### 4.4 Revert reviewer changes after each turn

**Hooks.** `TurnHooks` (`nax/src/session/turn-hooks.ts`) gains `beforeTurn` next to `afterTurn`.
`session/manager.ts` is at its grandfathered size baseline and must not grow: the before-turn call
replaces or folds into an existing line in `sendPrompt` (or code moves out of `manager.ts`); the plan
pins the exact edit. The reviewer guard lives in a new module (`nax/src/session/reviewer-tree-guard.ts`
or `runtime/`), not in `runtime/index.ts` (581/600 lines). The role filter checks `desc.role` against
one exported constant `REVIEWER_SESSION_ROLES` (4.1 table); finish reviews carry their role through
`sessionOverride`, which the plan verifies.

**Snapshot (shared per repository).** Reviewers may run concurrently in one checkout (A4 finish runs
the spec and branch reviews with `Promise.allSettled`, `finish/review-round.ts`). A per-repository
guard keyed by the git toplevel (`git -C <desc.workdir> rev-parse --show-toplevel`, so a monorepo
package workdir maps to its repo) holds one snapshot and a count of active reviewer turns:
- First reviewer turn in: take the snapshot. Later reviewers join it (count + 1).
- Last reviewer turn out: compare and restore. Earlier ones only decrement.
- Snapshot content:
  - working-tree tree id via `snapshotWorkingTree` (`review/fix-review/tree-snapshot/index.ts`:
    tracked + untracked, `.gitignore` honoured, mutates nothing);
  - index tree id (`git write-tree`);
  - symbolic `HEAD` and the `HEAD` commit, the current branch ref, and the stash list (`git stash
    list --format=%H`).

**Restore (last out).**
- `changedPathsBetween(snapshotTree, currentTree)` (repo-root-relative), excluding `.nax/**` (the #2497
  keeper owns run state). Each changed path: restored from the snapshot blob when it existed in the
  snapshot (tracked or untracked), deleted when it did not. Only changed paths are touched; nothing is
  re-written wholesale.
- Index: when the index tree differs from the snapshot index tree, `git read-tree <snapshotIndexTree>`
  (restores the staged/unstaged split exactly; the working tree is restored separately above).
- Refs: symbolic `HEAD` re-pointed if it changed (`git symbolic-ref` / detached checkout of the
  recorded commit without touching the tree), the recorded branch ref reset to its recorded commit
  (`git update-ref`), branches created during the turn are left (recorded in the log), stash entries
  added during the turn are dropped by SHA.
- Ignored paths are never touched (`.venv`, caches, `node_modules`, build output).
- All git calls use `git -C <toplevel>` with `:/`-anchored pathspecs.

**Reporting.** One `reviewer-tree-reverted` log line per restore: role(s), changed paths, index
restored, refs restored, stash entries dropped. No ledger entry. A revert never fails a review.

**Who else can write during a reviewer turn.** No nax writer shares a checkout with a reviewer: the
workflow story/branch fix and the finish fix run after the review round; pipeline `--parallel` stories
use separate worktrees; the pipeline autofix runs after review. The plan verifies each call site.
**Accepted risk:** a human editing the same checkout during a review can have edits reverted; the log
line names every path restored.

### 4.5 Failure handling

| Case | Behaviour |
|---|---|
| ACP Claude, nax policy says sandbox unavailable on host | Open fails with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and the probe reason; existing fallback/escalation handles it. **Deliberate difference from native**, where the session opens and raw Bash is refused: ACP Claude's Bash cannot be refused per command by nax. |
| ACP Claude, Claude's own sandbox fails to start | SDK `failIfUnavailable` ends the session with an error; surfaced as a session failure |
| `review` on codex/gemini/opencode/pi | `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, as `read` today |
| S5 server `full` sessions (Zed etc.) | No embedder policy, no sandbox; unchanged. "Never unsandboxed" applies to nax-run opens, which always carry a policy when `execution.sandbox.enabled` |
| Revert fails (git error, lock) | `[WARN]` log, review result kept; the #2497 keeper still guards run state |
| Native, sandbox unavailable | Unchanged: raw Bash refuses (existing `rawBashRefusalReason`) |

## 5. Out of scope

- Command-safety guard (#2292) and #2490 rules: unchanged (R3).
- Sandboxing other ACP agents (R5).
- Restricting Claude's `Read` tool; blanking Claude settings under `full` (4.3 accepted gaps).
- S5 server profile list and `session-tools.ts` `offers`.
- New config keys. Everything rides on `execution.sandbox` and `execution.permissionProfile`.
- `fix-review`, `nbf-worth-check`, `advise-batch` tool lists.

## 6. Testing

Unit:
- `acpProfileFor`: every row of the 4.2 table, both modes.
- `buildSessionPolicy` extraction: launcher output unchanged (existing sandbox tests stay green).
- Policy to Claude `sandbox` options mapping: enabled, disabled (absent), network open/allow-list.
- `claudeSessionMeta`: `review` = read-only enforcement + tool rules + sandbox; `full` = tool rules +
  sandbox + `allowDangerouslySkipPermissions: false`; `read`/`none` = no sandbox.
- `decidePermission`: `review` allows `execute`, denies others; network requests open vs allow-list;
  `full` path check (inside root, `denyWrite`, outside roots, symlink escape, relative, `~`, multiple
  locations one bad, notebook path, no path).
- Every 4.2 consumer row (`declaredToolsFor("review")`, `resolveSessionLauncher` floor,
  `nativeProfileRules`, zod enum, `isReadOnlyProfile`).
- Reviewer guard: tracked edit; staged-vs-unstaged split preserved; new untracked file deleted;
  pre-existing untracked file modified -> restored; ignored path kept; `.nax` path left to keeper;
  `HEAD` moved by commit; `checkout -b`; `stash push` dropped; monorepo package workdir maps to
  toplevel; worktree checkout; clean tree no-op; non-reviewer role untouched; git failure logged;
  two concurrent reviewers with an edit made between their snapshots (restored once, by the last out).
- Reviewer op tool lists include `Bash`; unchanged ops unchanged; `check-bash-dispatch-ask` (#2202)
  passes: every dispatch site of the reviewer ops carries `askResolver` and `commandShadow`, and none
  sits in `ALLOWED_BARE_SITES`.
- Shared reviewer prompt section present in each reviewer builder output.

Integration:
- Native reviewer session in a temp git repo runs a check command and a stray write; the write is
  reverted and logged.
- ACP open with a fake agent: request `_meta` carries the sandbox for `review` and `full`, none for
  `read`; resume carries it again.

Live check (billed, needs approval at launch):
- One ACP Claude branch review on rs-stock runs `uv run ruff format --check .`; the tool audit shows no
  denied Bash.
- One ACP Claude implementer turn that writes outside the workdir is blocked (Bash by the sandbox,
  Write by the R4 path check).
- macOS only is verified live; Linux `failIfUnavailable` behaviour is covered by unit tests only.

## Plan notes (from spec review, 2026-10-13)

- File-size ratchets: `session/manager.ts` (baseline, no growth), `runtime/index.ts` (581/600),
  `operations/adversarial-review.ts` (597/600), `operations/semantic-review.ts` (577/600). The tool
  array edits are in place; the prompt paragraph lives in one shared builder section.
- `check-bash-dispatch-ask` (#2202) applies once the reviewer ops declare `Bash`.

## 7. Rollout

No config change; on by default through `execution.sandbox.enabled` (default true) and the permission
profile. Release note: ACP Claude implementer sessions now run Bash inside the sandbox and file edits
outside the write roots are denied.
