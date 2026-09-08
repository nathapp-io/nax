# Delete tool, Git for implementers, and denials that name a real alternative

Date: 2026-09-08
Issues: #1925 (no delete capability), #1937 (second half — denial names the wrong alternative)

## Summary

Three changes to the coding-tool surface, driven by one measurement: across three
consecutive runs (3,925 recorded tool calls), the model made 32 `argv` calls and was
denied all 32.

1. Add a `Delete` tool, restricted to git-tracked files.
2. Declare the existing read-only `Git` tool on the eight ops that declare `Exec`.
3. When a denied `argv` call names an intent a tool in this session already serves,
   say which tool.

They ship together because they are one story about the same 32 calls, and because
change 3 is only correct once changes 1 and 2 exist: a redirect table written today
would name `Git` to sessions that do not have it, recreating the defect it exists to
fix.

## The measurement

Source: `~/.nax/nax/tool-audit/{acp-catalog-pricing,ledger-and-audit-field-truth,
dispatch-accounting-integrity}` — the same three runs cited in #1925 and #1937,
re-read directly rather than taken from the issue text.

32 denied `argv` calls. Cross-referencing each denying session against the tools it
actually used:

| bucket | n | status |
|---|---:|---|
| `git status`, `git status --porcelain`, `git diff --stat` | 5 | capability absent — `Git` is not declared by any op that declares `Exec` |
| `rm`, `git rm`, `mv` | 4 | capability absent (`mv` is rename; out of scope, see below) |
| `ls`, `find`, `bun test <files>` | 8 | genuinely redundant — `Glob` and `testScoped` were both advertised |
| scoped `biome check`, individual `check:*` ratchets | 7 | absent: only the whole 13-gate `lint` chain is declared |
| `bun --version`, `bun pm ls`, `bun -e ...` | 8 | environment probing and workarounds |

### Correction to #1937's premise

#1937 states that 15 of 32 (47%) were "requests for capabilities the session already
had as a first-class tool", listing `git status` under "already served by `Git`".

That is wrong for the git bucket. **No op that declares `Exec` declares `Git`** —
all eight of `implement`, `autofix-implementer`, `autofix-test-writer`, `write-test`,
`acceptance-fix` (x2), `rectify`, `finish-fix` and `full-suite-rectify` omit it, and
`Git` appears in zero of the denying sessions' recorded calls. The true redundant
figure is 8 of 32 (25%), not 47%.

### The model is not unaware

`codingToolsToDefinitions` (`src/agents/native/session/tool-mapping.ts`) sends
`name`, `description` and `inputSchema` for every advertised tool, and `Git`'s
description names its verbs explicitly ("diff, log, show, status, blame"). A model
holding `Git` can see what it does.

This matters for scoping change 3: for the 8 genuinely-redundant calls the model
reached for a shell route *while holding* the tool that served the intent. That is
prompt-driven, not an awareness gap — it is #1800/#1906 territory (role prompts
instruct shell commands the native protocol cannot run). A denial-time redirect is a
recovery nudge for those calls, not a fix for their cause, and this spec claims no
more than that.

## Change 1: the `Delete` tool

```
Delete { path: string }        scope: { pathFields: ["path"] }
```

Single path, matching `Write` and `Edit` rather than `GitCommit`'s array: the policy
resolves one path field per call through the seam that already exists, and each
deletion gets its own audit row.

`run` sequence:

1. Take `ctx.resolvedPaths[0]` (the policy has already resolved and confined it).
2. Refuse if git does not track the path.
3. Refuse if the path is a directory.
4. `unlink`.
5. Return a result naming the next step: the deletion still has to be staged.

### Tracked check

`git ls-files --error-unmatch -- <path>` through `gitWithTimeout` (the helper
`gitCommitTool` already uses), run against `ctx.root`. Exit 0 means tracked; any
non-zero means not, and the refusal message is the same either way — the tool does
not distinguish "untracked" from "git failed", because both mean "cannot prove this
is recoverable".

One subprocess per call. `Delete` is a rare operation, so this is not on a hot path.

### Registration and declaration

`Delete` is registered in `registerBuiltinCodingTools` (`src/tools/runtime.ts`)
alongside `Write` and `Edit`, and declared by the same set of ops that receive `Git`
in change 2.

That set is identical by measurement, not by coincidence of drafting: the ops
declaring `Write`+`Edit` and the ops declaring `Exec` are the **same eight files**
(nine op objects, since `acceptance-fix.ts` defines two) —
`implement`, `autofix-implementer`, `autofix-test-writer`, `write-test`,
`acceptance-fix` (x2), `rectify`, `finish-fix`, `full-suite-rectify`. So both changes
edit one list, and the rule is statable in one line: **an op that can rewrite a file
can also remove one and read git.**

`verify`, `adversarial-review`, `semantic-review`, `plan`, `plan-refine`,
`debate-plan` and `acceptance-generate` are unaffected.

### Why not `git rm`

`gitTool` documents a deliberate read/write split (`GIT_READ_VERBS`, enforced at
`git.ts:115` and `:220`), and `git rm` both deletes and stages, folding two
capabilities into one call. Plain `unlink` plus the existing `GitCommit` keeps each
seam doing one thing.

### Why tracked-only

The risk being managed is unrecoverable loss. A tracked file's content is in git
history, so deleting it is an undo away. An untracked file exists only on disk.

This also closes a hole that is open today, and does so by construction rather than
by a new guard: there is **no `.git` path guard anywhere in `policy.ts`**, and
non-Exec grants are unconditional (`patterns: ["*"]`), so the glob check at
`policy.ts:300` is skipped entirely. `Write` can therefore write `.git/index` right
now. A delete tool would inherit that exposure and could destroy the repository in a
way git cannot undo, because it *is* git. Nothing under `.git/` is tracked, so
tracked-only excludes all of it.

A test must pin that specific case, so the protection is deliberate rather than
incidental.

### Two properties verified, not assumed

**`GitCommit` needs no change.** `git add -- <deleted path>` stages a deletion
(`D  a.txt`) and commits normally — verified against git 2.50.1 with the exact argv
`buildCommitArgvs` produces.

**A deleted path still passes the policy.** `realOrRaw` (`src/utils/realpath.ts`)
walks up to the nearest surviving ancestor and re-attaches the missing segments; its
doc comment names "a changed file that has since been deleted" as the case it exists
for. So `Delete` followed by `GitCommit` works end to end with no edits to existing
tools.

### Refusal messages

Every refusal names the alternative, which is this repo's established norm
(`policy.ts:253`, `git.ts:94`, and #1924/#1937's first half as of today):

- untracked: `"scratch/x.md" is not tracked by git, so deleting it would be unrecoverable. Delete removes tracked files only.`
- directory: names that only files are removable.
- missing: says so, rather than succeeding silently.

## Change 2: declare `Git` on the eight `Exec`-bearing ops

`Git` is read-only, already built, already policy-gated, and already declared by the
reviewer ops (`adversarial-review`, `semantic-review`, `verify`). Declaring it on the
implementer family removes 5 of the 32 denials at the cost of one array entry per op.

This is a capability **addition**, not the repair of an inconsistency, and the spec
should not pretend otherwise. The diff-access prompt regions that instruct native
agents to use `Git` live only in the reviewer and debate builders
(`adversarial-review-builder`, `review-builder`, `debate-builder`), and every op those
serve already declares `Git`. There is no prompt telling an implementer to use a tool
it lacks; implementers simply had no read-git route at all.

`REQUIRED_TOOLS_BY_ROLE` in `scripts/check-op-tool-capability.ts` is a **minimum**,
not an exact set, so the ratchet does not need changing. The floor stays as it is
rather than forcing every future implementer-role op to declare `Git` and `Delete`.

## Change 3: denials that name a tool the session has

### Layer

The redirect belongs in `createCodingToolRuntime` (`src/tools/runtime.ts`), not in
`policy.ts`.

`policy.check` is called from `runtime.ts:187` and its verdict is returned as
`{ kind: "denied", reason }`. The runtime is also what owns `advertised(declared)` —
so it is the only layer that knows **both** the verdict and which tools this session
actually received. `policy.ts` knows the grants and nothing about advertisement, so a
table written there would name tools the session was never given.

`policy.ts:253`'s existing message is not modified. The runtime appends to it.

### Table

Denied `argv` shape to the tool that serves the intent:

| argv shape | tool |
|---|---|
| `ls`, `find` | `Glob` |
| `bun test <files>`, `timeout N bun test <files>` | `RunCommand {command: "testScoped"}` |
| `git <read verb>` | `Git` |
| `rm`, `git rm` | `Delete` |

**A tool is named only if it was advertised to this session.** Without that guard the
redirect reproduces the original defect: pointing the model at something it cannot
call. The `testScoped` entry additionally depends on the project having declared that
command, so it is conditioned on the declared-command map, not hardcoded.

The `git` and `rm` rows are only correct because of changes 1 and 2. They are listed
here rather than in a follow-up because after this spec they are true.

## Out of scope

- **`mv` (rename).** One denied call. `Delete` does not cover it and neither does
  `Write` alone without content round-tripping. Left unaddressed; file separately if
  it recurs.
- **`wc -l`.** One call, wanting a line count for the 600-line gate. No tool serves
  it. Not worth a tool.
- **The scoped-lint bucket (7 calls).** This repo declares only the whole 13-gate
  `lint` chain, so an agent that wants one ratchet has no route. That is a gap in
  this repo's own `.nax/config.json`, not a nax defect. Worth raising separately.
- **`Write` being able to reach `.git/`.** Real, predates this work, and fixing it
  properly means a path guard in the policy rather than a per-tool check. `Delete`
  sidesteps it via tracked-only; the underlying exposure gets its own issue.
- **Prompt-driven shell reaching.** The 8 redundant calls have their cause in
  #1800/#1906. Change 3 mitigates the symptom at denial time only.

## Testing

Behavioural tests, following the repo's existing tool-test conventions.

`Delete`:
- deletes a tracked file; the file is gone and the result names the staging step
- refuses an untracked file, and the message names the tracked-only rule
- refuses a directory
- refuses a missing path rather than reporting success
- refuses a path outside the permitted root (policy-level, mirroring `Write`'s case)
- **refuses `.git/index`** — the property that makes tracked-only a safety boundary
- end-to-end: `Delete` then `GitCommit` with the deleted path produces a commit
  containing the deletion

Change 2:
- each of the nine op objects declares both `Git` and `Delete` (a table-driven
  assertion over the operations barrel, matching how `check-op-tool-capability.ts`
  reads ops rather than parsing source — ops are exported under aliases and one
  module can define several)
- the ops that withhold `Write`/`Edit` still declare neither

Change 3:
- a denied `ls` argv names `Glob` when `Glob` is advertised
- the same denial does **not** name `Glob` when it is not advertised
- a denied `bun test` names `testScoped` only when the project declares it
- the underlying `policy.ts` message is unchanged (guards against the redirect being
  implemented in the wrong layer)

## Risks

- **A delete tool is a destructive capability.** Mitigated by tracked-only
  (recoverable), policy containment (unchanged seam), and an audit row per call. The
  blast radius is strictly smaller than `Write`'s, which can already destroy any
  file's contents including inside `.git/`.
- **Declaring `Git` widens what eight ops can do.** It is read-only and the reviewer
  ops have carried it without incident.
- **The redirect table is static and will drift** as tools are added. The
  advertised-only guard means drift degrades to silence (no redirect) rather than to
  a wrong answer.
