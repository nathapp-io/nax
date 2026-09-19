# Native-agent scratchpad tools

**Date:** 2026-09-19
**Status:** Design approved, not yet planned
**Branch:** `feat/native-agent-scratchpad`

## Problem

A nax agent has nowhere to put throwaway work.

Every path-bearing coding tool is contained to the permitted root, so there is no
writing to `/tmp`. The only writable surface is the repository itself, so an agent
that wants to keep a note, park a list of files to revisit, or stash a chunk of
command output writes it into the working tree — where it lands in the diff, the
commit, and the review.

Two groups feel this most sharply:

- **Long implementation turns**, where the agent re-derives the same facts because
  it has nowhere to record them and re-reading is cheaper than remembering.
- **The read-only review ops** (`adversarial-review.ts:290`,
  `semantic-review.ts:333`), which declare `tools: ["Read", "Glob", "Grep", "Git"]`
  and so have *no* write surface at all. These are the longest analytical turns in
  the pipeline and the ones that would benefit most from note-taking, but the fix
  cannot be "grant them `Write`" — that hands a reviewer the ability to edit the
  code it is judging.

This design gives the agent a `/tmp` substitute: a directory it may write freely,
that never enters git, and that cannot reach the repository.

### What this is not

nax already has a subsystem with "scratch" in the name, and this is not it.
`src/session/scratch-writer.ts` appends **structured, nax-authored** entries
(`verify-result`, `tdd-session`) to a per-session `scratch.jsonl`, which the agent
reads back only through the `query_scratch` pull tool. That path is nax writing
*to* the agent. This design is the agent writing *for itself*, in free-form files,
with no schema and no promise that anything reads it.

The two stay lexically distinct: `scratch` is the existing session log, `scratchpad`
is the new area. A grep for `scratchpad` returns only this feature.

## Design

### 1. Location and lifetime

```
<root>/.nax/scratchpad/
```

A fixed literal path. No run, story, session, or role segment.

One directory per `nax run`, shared by every op and role in that run, **wiped at run
start** in `setupRun()` (`src/execution/lifecycle/run-setup.ts:190`).

Three consequences worth stating explicitly:

- **Wiping at start, not at end**, means a failed run leaves its scratchpad on disk
  for post-mortem, while the next run still begins clean. Nothing has to be cleaned
  up on the crash path.
- **A fixed path is the main simplicity win.** The prompt states `.nax/scratchpad/`
  verbatim rather than interpolating an id the agent must then carry. There is one
  place to look, for the agent and for a human debugging a run.
- **Sharing across ops is deliberate.** An implementer can read what the test-writer
  left. The accepted cost is that a stale note can mislead a later op; the run-start
  wipe bounds how stale anything can get.

**Ignoring it: one entry, three consumers.** The entry goes in
`NAX_GITIGNORE_ENTRIES` (`src/utils/gitignore.ts:51`), which is the SSOT read by
`nax init` (project `.gitignore`), `WorktreeManager.ensureGitExcludes()`
(`.git/info/exclude`, applying to every worktree without a commit), and the
`scripts/check-nax-artifacts-untracked.ts` CI gate. Adding it there covers all three;
adding it to `.gitignore` by hand covers none of them properly.

The entry must be spelled **`**/.nax/scratchpad/`**, with the `**/` prefix. This is
not cosmetic — it follows the precedent of `**/.nax/cache/`, added days ago by
nax#2136/#2137, whose comment records the failure mode a bare `.nax/scratchpad/`
would reproduce:

> generated untracked in the main checkout and committed inside the story worktree,
> so the merge back aborts on an untracked overwrite and strands the story branch.

The prefix is what covers a monorepo package's own `.nax/`, which is where nax writes
when a story carries a `workdir`. The compounding risk is that nax's own flows run
`git add -A` (see the `finish-audit` and `mutation-journal` comments in the same
file), so an un-ignored scratchpad file does not merely sit there — it gets swept into
the feature branch's history.

`.naxignore` needs no change — it already excludes `.nax/` wholesale from context
indexing, so scratchpad files can never be pulled back into a prompt as context.

**Worktrees.** Parallel execution checks out to `<projectRoot>/.nax-wt/<storyId>/`
(`src/worktree/manager.ts:122`) and force-removes it at teardown. Each worktree
therefore has its own `.nax/scratchpad/`; they cannot collide, and each dies with its
worktree. Acceptable — a `/tmp` substitute is not a durable store.

### 2. Tool surface

Three dedicated tools in a new `src/tools/scratchpad.ts`:

| Tool | Input | Behaviour |
|:-----|:------|:----------|
| `ScratchpadWrite` | `path`, `content` | Create or overwrite. Bounded by `ctx.maxFileBytes`. |
| `ScratchpadRead` | `path` | Bounded by `ctx.maxBytes`, truncating like `Read`. |
| `ScratchpadList` | — | Lists what the run has accumulated so far. |

The defining property: **`path` is resolved relative to `.nax/scratchpad/` and an
escape is refused by construction, not by policy.** These tools never accept a
repository path, so there is no grant, profile, or rule under which one of them
modifies tracked code. That is what makes the rest of the design safe.

Because containment is structural, these tools are not subject to — and do not need —
the `nax-owned-writes.ts` guard, which exists to stop `Write`/`Edit`/`Delete` from
reaching `.nax/config.json`, `.nax/features/*/prd.json` and the queue files. A
scratchpad tool cannot address any of those paths in the first place.

**No `ScratchpadDelete`.** Overwrite covers replacement and the run-start wipe covers
cleanup. It can be added if it is genuinely missed; shipping it speculatively costs
prompt bytes on every hop for a capability nothing has asked for.

**`Bash` and `RunCommand` are unchanged.** They carry no path fields, so a shell
redirect into `.nax/scratchpad/` is gated by the human-authored `Bash(...)` rules and
the lexer — a different seam from this one. The dedicated tools are the sanctioned
route; this design does not widen the shell gate to match.

### 3. Availability: every op

Ops declare their tools inline (16 `tools: [...]` arrays across `src/operations/`),
but they are unioned at a single chokepoint: `declaredWithProviders` in
`src/agents/coding-tool-support.ts:478`. The scratchpad tools are appended **there**,
not to each op.

This is both cheaper and more correct. The scratchpad is ambient — it is not part of
what an op does, the way `Git` or `RunCommand` are — so an op's `tools` array should
keep describing only what that op needs *from the repository*. Adding the tools per-op
would also guarantee that whichever op is added next forgets them.

**The `safe` profile gets them too.** `DEFAULT_CODING_TOOLS = ["Read","Glob","Grep"]`
(`src/config/permissions.ts:117`) is what `safe` grants, and the scratchpad tools join
that list. This does not weaken the profile: `safe` promises the agent cannot modify
the repository, and a tool that is structurally incapable of resolving a repository
path does not modify the repository. The same argument is what lets the read-only
review ops hold a write tool without being able to edit the code under review.

**The `scoped` profile is a deliberate exception.** `scoped` resolves to
`toolGrants: []` plus whatever the stage's rules name (`permissions.ts:287`), so it
will *not* grant the scratchpad tools by default. That is correct and should be left
alone: the whole point of `scoped` is that a human enumerates what each stage may do,
and silently injecting a grant would break that contract for a convenience. A project
on `scoped` opts in by writing `ScratchpadWrite(*)` in its `execution.permissions`
block.

This does mean `scoped` advertises the tools (the union in §3 is unconditional) while
denying them. The implementation must confirm that combination produces an ordinary
policy denial with a legible reason, not a crash or a silent no-op — an advertised
tool that is never granted is a shape the codebase already has in `Exec`, but it is
worth a test rather than an assumption.

**The cost, stated plainly.** `advertisedSchemaBytes`
(`src/tools/provider-advertise.ts`) shows every advertised tool costs description +
schema bytes on *every hop*, whether called or not. Three tools on every op is a
permanent per-hop tax. It is accepted deliberately: the ops that benefit most are the
long ones, and those are exactly the ones a narrow opt-in list would fail to cover.
Keeping the surface at three tools, with terse descriptions, is how the tax is kept
small.

### 4. Making the agent aware

Two prompt changes, both required. The second is not optional polish — without the
first, the two instructions contradict each other.

**Carve out the `.nax/` prohibition.** `src/prompts/sections/nax-artifacts.ts` is an
always-on section that currently tells every code-touching agent:

> Files under `.nax/` are nax's own artifacts ... They must NEVER be moved, renamed,
> or deleted — `.nax/` is a tool-managed directory and modifying it breaks the
> orchestrator.

Shipping an agent-writable directory under `.nax/` without amending this leaves the
model holding two opposite instructions, and the likeliest resolution is that it obeys
the standing prohibition and never touches the scratchpad. The section must state the
exception: `.nax/` is immutable **except** `.nax/scratchpad/`, which is the agent's own
and disposable.

**Introduce the scratchpad.** A short new section under `src/prompts/sections/`
stating the path, that it is wiped between runs, that nothing in it is committed, and
what it is for — parking command output, notes to self, intermediate lists — so the
model reaches for it instead of writing `notes.md` into the repository root. The tool
`description` strings carry the same facts, since the description is what the model
sees on every hop even when the section is far up the prompt.

### 5. File surface

**New**

- `src/tools/scratchpad.ts` — the three tools and their containment.
- `src/prompts/sections/scratchpad.ts` — the introduction section.
- `test/unit/tools/scratchpad.test.ts`
- `test/unit/prompts/sections/scratchpad.test.ts`

**Modified**

- `src/tools/runtime.ts` — register as built-ins in `registerBuiltinCodingTools`.
- `src/tools/registry.ts` — add the three names to `RESERVED_TOOL_NAMES`.
- `src/tools/types.ts` — add them to the `CodingToolName` union.
- `src/tools/index.ts` — barrel exports.
- `src/agents/coding-tool-support.ts` — append at the `declaredWithProviders` union.
- `src/config/permissions.ts` — add to `DEFAULT_CODING_TOOLS`.
- `src/execution/lifecycle/run-setup.ts` — wipe at run start.
- `src/prompts/sections/nax-artifacts.ts` — the carve-out.
- `src/prompts/sections/index.ts` — export the new section.
- `src/utils/gitignore.ts` — add `**/.nax/scratchpad/` to `NAX_GITIGNORE_ENTRIES`.
  This is the only ignore change: `nax init`, `ensureGitExcludes()` and the CI gate
  all read it.
- `.gitignore` — the same entry, since this repo's own checkout predates it.

### 6. Testing

Per the repo's `_deps` convention, filesystem access in the new tools goes through an
injected dep so the unit tests need no real I/O.

- **Containment is structural.** A `path` of `../../src/index.ts`, an absolute path, a
  symlink out, and `a/../../..` must all be refused *by the tool*, with no policy
  configured at all. This is the load-bearing test: the profile and review-op
  decisions in §3 rest on it, so it must fail if the escape check is ever weakened.
- **Bounds.** `ScratchpadWrite` respects `maxFileBytes`; `ScratchpadRead` truncates at
  `maxBytes` and reports `resultBytesPreTruncation`.
- **Run-start wipe.** `setupRun` clears a populated `.nax/scratchpad/`, and tolerates
  its absence.
- **Prompt.** The carve-out names `.nax/scratchpad/` as an exception, and the
  always-on prohibition still covers the rest of `.nax/`.
- **Availability.** An op declaring `tools: ["Read"]` still resolves the scratchpad
  tools through the `coding-tool-support.ts` union, and the `safe` profile grants
  them.
- **Ignore coverage.** `scripts/check-nax-artifacts-untracked.ts` already fails on a
  tracked file matching `NAX_GITIGNORE_ENTRIES`, so it covers the new entry for free
  once it is added. Worth an explicit case that a file written to
  `.nax/scratchpad/` inside a worktree is excluded by `ensureGitExcludes()` — that is
  the nax#2137 failure mode, and it is not exercised by the tracked-file check.

Coverage is checked with `bun run test:coverage` after the tests land, since a green
suite can still fail the per-file gate.

## Decisions taken, and what they cost

| Decision | Chosen | Rejected alternative and why |
|:---------|:-------|:-----------------------------|
| Location | `.nax/scratchpad/`, in-repo | Out-of-repo `~/.nax/<project>/scratch/` would need a second containment domain in the policy — the largest possible change to the seam, for a `/tmp` substitute that does not need to survive the repo. |
| Name | `scratchpad` | `scratch` is taken by the session log; `tmp` and `sandbox` already appear in `src/` (and "sandbox" would falsely imply isolation). |
| Granularity | Per `nax run`, one flat dir | Per-session `(feature, story, role)` isolates ops from each other but requires threading `sessionId` into the tool runtime and makes the path un-stateable in a prompt. Simplicity won. |
| Tool shape | Three dedicated tools | Granting `Write(.nax/scratchpad/**)` needs no new code, but forces a real `Write` on read-only review ops and leaves scratch writes indistinguishable from repo writes in the tool-audit ledger. |
| Wipe point | Run start | Wiping at run end loses the post-mortem and adds a crash-path obligation. |
| Availability | Every op, at the union | Per-op opt-in is a list that will silently go stale. |
| `scoped` profile | Not granted by default | Injecting a grant would break the profile's contract that a human enumerates every stage capability. |

## Open questions

None blocking. Two to revisit once it is in use:

- Whether `ScratchpadList` earns its per-hop bytes, or whether agents only ever read
  back paths they themselves wrote.
- Whether sharing one directory across ops in a run causes real stale-note confusion,
  which would argue for the per-session partition rejected above.
