# PR 4: Deletion Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Retire the package-relative translation layer that PRs 1-3 made unused. The
agent is repo-rooted (PR 2), the PRD is unconditionally repo-framed (PR 3);
this PR removes the now-dead frame-translation helpers, the redundant
`codingToolRepoRoot` field, the provider re-spelling that duplicated
`scopePaths` bookkeeping, and updates the two SSOT documents (`path-frame.ts`
header, the 09-16 spec's status block) to describe the smaller surface that
remains. It is subtractive: no new behavior, only deletion and the minimal
rewiring deletion requires. It is the last phase on the integration branch
`feat/single-frame-redesign`; the live monorepo verification of spec §6 runs
after this PR, on the completed branch, gated on explicit approval per run
launch (never spawn `nax run` from inside this plan's execution).

This plan was written by reading the **current tree** (pre-PR1-3; only the two
spec-authoring doc commits exist on `feat/single-frame-redesign` today) and
grep-enumerating every current call site of every symbol in scope. PRs 1-3
have **not** been implemented yet at the time of writing. Every deletion task
below therefore opens with a **Task 0 preflight grep** that the PR-4 executor
must re-run for real once PRs 1-3 have actually landed — the current-tree
counts recorded here are the baseline to diff against, not a promise about
what PR 4 will find. Where a site's fate depends on exactly how PR 2/PR 3 flip
their call sites (not fully pinned down by the design spec's prose), this plan
says so explicitly and gives the decision procedure rather than guessing.

## Architecture

Before (current tree): three coexisting path frames (repo / package /
spec-author) require translation at every agent-prompt boundary
(`toPackageFrame` / `partitionPackageFrame` / `UNREADABLE_MARKER`) and at every
provider chunk render (`code-neighbor-chunk.ts`, `git-history.ts`). After PR 4:
one frame (repo-rooted) everywhere except two narrow, still-legitimate
survivors — `toRepoFrame` (defensive re-spelling of a stray package-relative
input) and the `story.workdir` **selector** contract (which package's rules /
config / command-cwd apply, `storyWorkdir` / `storyPackageDir` /
`storyAbsWorkdir`). The workdir-access gate
(`scripts/check-story-workdir-access.ts`) turns out, on reading it, to already
be pure selector-accessor enforcement with no separate "frame" mechanism
inside it — see Task 6's decision record.

## Tech Stack

Bun 1.4, TypeScript strict, `bun:test`, Biome. No new dependencies.

## Spec:

`docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` §4 "PR 4 —
deletion pass".

## Global Constraints

- **Never** `bun test` bare for the suite — use `bun run test` /
  `bun run test:coverage` (nax project convention; bare `bun test` and
  `bun run nax` both give confident false signals per
  `.claude/rules/*` and team memory).
- src files: 600-line hard cap. Test files: 800-line hard cap
  (`.claude/rules/forbidden-patterns-source.md`,
  `.claude/rules/forbidden-patterns-tests.md`).
- Prefix every git/gh command with `RTK_DISABLED=1` (rtk's hook rewrite is
  refused inside a worktree/branch context per team memory
  `rtk-hook-rewrite-blocked-in-worktrees`; disabling it avoids the silent
  rewrite failure).
- Every deletion task follows TDD shape where it changes behavior (not pure
  dead-code removal): adjust/add the pinning test for the **new** state
  first, watch it fail for the right reason against the old code, then
  delete, then watch it pass. Pure dead-code removal (an unused export with
  no behavior change) skips straight to delete + run, since there is no new
  behavior to pin — but the existing test suite for that file must still be
  read and its now-impossible branches removed, not left dangling.
- One logical concern per commit, conventional commit prefixes
  (`refactor:`/`test:`/`docs:`/`chore:`), per `.claude/rules/project-conventions.md`.
- Barrel imports only in `src/`/`bin/`/`scripts/` (tests may reach internals).
- **Legacy ruling (binding, do not violate):** the tolerant read branch keyed
  off `story.workdirSource` in `src/context/builder.ts` is **kept** — only
  write-side and prompt-side machinery is deleted. If a task below appears to
  require deleting `workdirSource`-branching read logic, stop and re-read
  the Legacy ruling before proceeding; the intended deletion is the
  **package-reframe half** of that logic (the `partitionPackageFrame` call
  and its `unreachable` bookkeeping), not the `canonical` flag's existence
  or the tolerant-read branch itself.
- **Workdir gate ruling (binding, do not violate):** any change to
  `scripts/check-story-workdir-access.ts` must keep
  `test/unit/scripts/check-story-workdir-access.test.ts`'s frozen-v1-regex
  superset differential green. A rewrite that cannot show it dominates v1 is
  a regression regardless of mechanism, per standing ruling
  `nax-workdir-gate-rewritten-three-times`.

---

## Task 0: Preflight — verify PR 1-3 landed the preconditions this plan assumes

**Files:** none modified. Read-only verification.

**Purpose:** PR 4 is a subtractive pass that only makes sense once PR 2's root
move and prompt-boundary flip, and PR 3's PRD single-frame write seam, are
actually on the integration branch. Running any deletion task below against a
tree where these preconditions do not hold would silently do PR 2/PR 3's job
inside "the deletion pass," which the spec's PR ordering explicitly forbids
("PR 2 switches both to repo-rooted rendering... PR 4 only deletes the
then-unused helpers").

- [ ] Confirm `codingToolRoot` and `codingToolRepoRoot` are both produced from
      `storyExecRoot(ctx.packageView)` in `src/operations/call.ts` (today,
      pre-PR2, line ~256 reads `codingToolRoot: packageWorkdir(ctx.packageView)`
      and line ~258 reads `codingToolRepoRoot: storyExecRoot(ctx.packageView)`
      — these must become IDENTICAL expressions post-PR2):
      ```
      grep -n "codingToolRoot:\|codingToolRepoRoot:" src/operations/call.ts
      ```
      Expect both lines to call `storyExecRoot(ctx.packageView)`. If
      `codingToolRoot` still calls `packageWorkdir(...)`, STOP — PR 2 has not
      landed; do not proceed with Task 2.
- [ ] Confirm `src/prompts/sections/story.ts`'s `modifiedFilesLines` no longer
      imports or calls `toPackageFrame` (PR 2's explicit, named flip):
      ```
      grep -n "toPackageFrame" src/prompts/sections/story.ts
      ```
      Expect zero matches. If any remain, STOP — PR 2's story.ts flip is
      incomplete; fix it there, not in this plan's Task 1.
- [ ] Confirm `src/context/builder.ts`'s `addFileElements` no longer calls
      `partitionPackageFrame` for `contextFiles`/`expectedFiles` reachability
      (PR 2's other explicit, named flip):
      ```
      grep -n "partitionPackageFrame\|toPackageFrame" src/context/builder.ts
      ```
      Expect zero matches. If any remain, STOP — same as above.
- [ ] Confirm the PRD write seam is unconditional (PR 3, R3): read
      `src/prd/workdir-canonical.ts`'s `canonicalizeDeclaredPath` and confirm
      it no longer probes the filesystem / no longer takes an "exists at plan
      time" branch — it should be pure-string `toRepoFrame` now, with
      `modifiedFiles` folded into `canonicalizePrdWorkdirs` via
      `finalizeAndWritePrd`.
      ```
      grep -n "canonicalizeDeclaredPath\|existsSync\|fileExists" src/prd/workdir-canonical.ts
      ```
      If a filesystem probe remains inside `canonicalizeDeclaredPath` itself,
      STOP — PR 3 is incomplete.
- [ ] Confirm PR 2's Task 3b flipped `feature-context.ts`: grep must find
      ZERO production callers of `reframeFilesTouched` (on the pre-arc tree
      it was called at `feature-context.ts:389`; PR 2 Task 3b owns removing
      that call). If a caller remains, this is a gap in PR 2 — re-open that
      phase's review rather than silently absorbing the flip into "the
      deletion pass." Record the actual outcome before starting Task 1.
      ```
      grep -rn "reframeFilesTouched" src/
      ```

**If any preflight check fails, do not proceed past Task 0.** Escalate to the
integration-branch owner; PR 4 cannot safely delete a helper whose only
remaining caller hasn't been flipped yet.

---

## Task 1: Delete the frame-translation helpers and their now-dead consumers

**Files (grep-verified on the CURRENT tree, 2026-09-18; re-grep at PR-4 start
per Task 0):**

Current call sites of the four symbols to delete
(`toPackageFrame`, `partitionPackageFrame`, `UNREADABLE_MARKER`,
`stripUnreadableMarker`), from
`grep -rln "toPackageFrame\|partitionPackageFrame\|UNREADABLE_MARKER\|stripUnreadableMarker" src/ --include="*.ts"`:

| File | Symbols used | Expected fate by PR-4 start |
|:---|:---|:---|
| `src/utils/path-frame.ts` | declares all four (+`toRepoFrame`, kept) | **delete the four declarations in this task** (Task 5 does the header/docblock rewrite) |
| `src/context/fragments/reframe.ts` | `normalizeWorkdir` (kept), `UNREADABLE_MARKER` | **delete whole file** (see below) |
| `src/context/builder.ts` | `partitionPackageFrame`, `toPackageFrame`, `toRepoFrame` (kept) | PR 2 already flipped this (Task 0 gate) — **zero remaining hits on `partitionPackageFrame`/`toPackageFrame` expected**; if `reclassifyPlanTimeAbsentEntries` (current ~228-306) is still present but now unreachable dead code, delete it here (see below) |
| `src/prompts/sections/story.ts` | `toPackageFrame` | PR 2 already flipped this (Task 0 gate) — **zero remaining hits expected** |
| `src/context/engine/providers/code-neighbor-chunk.ts` | `stripUnreadableMarker`, `toRepoFrame` (kept), `UNREADABLE_MARKER` | **PR 4's own job** — see Task 3 |
| `src/context/engine/providers/code-neighbor.ts` | `partitionPackageFrame`, `UNREADABLE_MARKER` | **PR 4's own job** — see Task 3 |
| `src/context/engine/providers/git-history.ts` | `toPackageFrame`, `UNREADABLE_MARKER` | **PR 4's own job** — see Task 3 (render site) **and** a preserved-but-rewired selector site (see Task 3's `historyScope`/`repoScopeFiles` note) |
| `src/context/engine/types.ts` | doc comment only (`partitionPackageFrame`'s `canonical: true`) | comment-only; update prose, no code change |

Note on naming: the spec's PR-4 bullet also names `toPackageFrameFiles`. That
symbol **does not exist anywhere in `src/` or `test/` on the current tree**
(`grep -rln "toPackageFrameFiles" src/ test/` returns nothing) — it only
appears in the archived `docs/superpowers/plans/2026-09-16-path-frame-seam-closure/`
and `2026-09-17-path-frame-p2-p3/` planning docs, which named an earlier
design for the same job that shipped under the name `partitionPackageFrame`
instead. Treat the two names as the same symbol; there is nothing separate to
delete.

**Test files currently exercising these symbols** (from
`grep -rln "toPackageFrame\|partitionPackageFrame\|UNREADABLE_MARKER\|stripUnreadableMarker" test/`):
`test/unit/pipeline/scope-files.test.ts` (355 lines — uses `toRepoFrame` only,
confirm with a narrower grep before touching it, see below),
`test/unit/context/engine/providers/code-neighbor-chunk.test.ts` (433 lines),
`test/unit/context/engine/providers/git-history-scope.test.ts` (288 lines),
`test/unit/context/engine/providers/code-neighbor-frame.test.ts` (334 lines),
`test/unit/context/builder-parent-frame.test.ts` (388 lines),
`test/unit/utils/path-frame.test.ts` (198 lines),
`test/unit/prompts/sections/story.test.ts` (305 lines).

`test/unit/pipeline/scope-files.test.ts` and `src/pipeline/scope-files.ts`,
`src/context/engine/scope-path-match.ts`, `src/context/engine/providers/static-rules.ts`,
and `src/prd/workdir-canonical.ts` import **only** `toRepoFrame` /
`normalizeWorkdir` from `path-frame.ts` — confirmed by:
```
grep -n "toPackageFrame\|partitionPackageFrame\|UNREADABLE_MARKER\|stripUnreadableMarker\|toRepoFrame" \
  src/context/engine/providers/static-rules.ts src/context/engine/scope-path-match.ts \
  src/pipeline/scope-files.ts src/prd/workdir-canonical.ts
```
These four files and their tests are **out of scope for deletion** — `toRepoFrame`
is kept. Do not touch them beyond the mechanical import-line survival check in
Task 7.

### Steps

- [ ] Re-run the grep table above against the actual post-PR1-3 tree. Confirm
      `src/context/builder.ts` and `src/prompts/sections/story.ts` show zero
      hits (Task 0 already gated this; this is the belt-and-suspenders
      re-check immediately before editing).
- [ ] Read `src/context/builder.ts`'s current `addFileElements` and
      `reclassifyPlanTimeAbsentEntries` (post-PR2 versions) in full. If
      `reclassifyPlanTimeAbsentEntries` (the H4 disambiguation helper, current
      lines ~271-306, whose entire purpose was disambiguating a
      `partitionPackageFrame` miss) is still defined but has no live caller
      once `addFileElements` no longer calls `partitionPackageFrame`, delete
      it along with its docblock (current lines ~227-270) and its dedicated
      test file `test/unit/context/builder-parent-frame.test.ts` **only for
      the sub-cases that assert the deleted disambiguation behavior** — do
      **not** delete cases in that file that pin `getParentOutputFiles`
      merge behavior itself (unrelated to frame reclassification). Read the
      whole file before cutting; it is 388 lines and mixes both concerns.
      If a caller does remain (contrary to expectation), stop and re-check
      Task 0's builder.ts gate — this would mean PR 2's flip was partial.
- [ ] Delete `src/context/fragments/reframe.ts` in full, **only after**
      confirming Task 0's `reframeFilesTouched` check found zero remaining
      callers. Delete the re-export line in `src/context/fragments/index.ts`
      (`export { reframeFilesTouched } from "./reframe";`) and confirm that
      barrel has no other exports left needing it (`cat src/context/fragments/index.ts`
      — currently 11 lines, single export). If the barrel becomes empty,
      confirm nothing imports `@/context/fragments` for side effects before
      leaving an empty barrel (barrels with zero exports are legal but check
      `grep -rn "from \"@/context/fragments\"" src/ test/` for consumers).
      Delete `test/unit/context/fragments/reframe.test.ts` in full.
- [ ] Delete `toPackageFrame`, `partitionPackageFrame`, `UNREADABLE_MARKER`,
      `stripUnreadableMarker` from `src/utils/path-frame.ts` (current lines
      33-45 for the marker pair, 102-160 for the two frame functions). Leave
      `toPosix`, `normalizeWorkdir`, `isRootWorkdir`, `toRepoFrame`,
      `StoryWorkdirLike`, `storyWorkdir`, `storyPackageDir`, `storyAbsWorkdir`
      untouched — Task 5 rewrites only the file's header docblock (lines
      1-23), not these bodies.
- [ ] In `test/unit/utils/path-frame.test.ts`, delete the `describe("toPackageFrame", ...)`
      block (current lines 70-90), `describe("UNREADABLE_MARKER", ...)` (92-102),
      and `describe("stripUnreadableMarker", ...)` (104-121), and the now-dead
      imports (`partitionPackageFrame`, `stripUnreadableMarker`, `toPackageFrame`,
      `UNREADABLE_MARKER` from the top-of-file import list). Keep every other
      `describe` block (`normalizeWorkdir`, `isRootWorkdir`, `toRepoFrame`,
      `storyWorkdir`, `storyPackageDir`, `storyAbsWorkdir`) verbatim. Also add,
      in this same file, a new pinning case under `describe("toRepoFrame", ...)`
      asserting `toRepoFrame` is now the **only** re-framing primitive exported
      from the module — `expect(Object.keys(await import("@/utils/path-frame")))`
      not including `toPackageFrame`/`partitionPackageFrame`/`UNREADABLE_MARKER`/
      `stripUnreadableMarker`. This is the RED step: write it, run it against
      the pre-deletion file (it will fail, proving the exports are still
      present), then delete the exports above, then it passes.
- [ ] Any `partitionPackageFrame`-shaped test cases inside
      `test/unit/pipeline/scope-files.test.ts` — re-grep first
      (`grep -n "partitionPackageFrame\|toPackageFrame\|UNREADABLE_MARKER" test/unit/pipeline/scope-files.test.ts`);
      current tree shows none, so expect no edits there. If any turn up,
      they are a scope leak from a different consumer and must be traced to
      its real producer before editing this file.
- [ ] Run `bun run typecheck` — expect new errors only at the three provider
      files handled in Task 3 (they still import the deleted symbols); if
      Task 1 is landed as its own commit before Task 3, expect it to fail
      typecheck until Task 3 lands. Either land Tasks 1 and 3 as one commit,
      or land Task 1 with the provider files' imports already stubbed to the
      Task-3 target shape in the same commit. Prefer one commit spanning
      Tasks 1 and 3 to avoid a red intermediate state on a shared integration
      branch.
- [ ] Run `bun run lint` and `bun run test` once Task 3 is also complete (see
      combined verification at the end of Task 3).
- [ ] Commit: `refactor(path-frame): delete toPackageFrame/partitionPackageFrame/UNREADABLE_MARKER and the reframe fragment (PR4 single-frame deletion pass)`

---

## Task 2: Delete `codingToolRepoRoot` and agent-scope's package-label logic

**Files (grep-verified on current tree):**

`codingToolRepoRoot` call sites, from
`grep -rn "codingToolRepoRoot" src/ test/ --include="*.ts"`:

| File:line | Current code | PR-4 action |
|:---|:---|:---|
| `src/agents/types.ts:196` (field), `:183-195` (docblock) | `codingToolRepoRoot?: string;` on `AgentRunOptions` | delete field + docblock |
| `src/operations/call.ts:258` | `codingToolRepoRoot: storyExecRoot(ctx.packageView),` | delete line |
| `src/agents/coding-tool-support.ts:261` | `"codingToolRepoRoot"` in the `Pick<AgentRunOptions, ...>` union for `resolveCodingToolSupport`'s param type | remove from the `Pick` union |
| `src/agents/coding-tool-support.ts:402` | `...(options.codingToolRepoRoot !== undefined ? { repoRoot: options.codingToolRepoRoot } : {}),` inside the `buildCodingToolSupport({...})` call | **decision needed — see below** |
| `src/agents/tool-preamble.ts:35` | `buildAgentScopeSection(options.codingToolRoot, options.codingToolRepoRoot)` | update call once `agent-scope.ts`'s signature is confirmed (see Task 2b) |
| `test/unit/operations/call-coding-tool-repo-root-producer.test.ts` (whole file, currently pins `codingToolRepoRoot` as its own producer contract) | tests `AgentRunOptions.codingToolRepoRoot`'s production | delete whole file — see below |

**Decision for `coding-tool-support.ts:402`:** on the current (pre-PR2) tree,
`buildCodingToolSupport` receives `root: options.codingToolRoot` unconditionally
and `repoRoot: options.codingToolRepoRoot` only when defined — two potentially
different values, because pre-PR2 `codingToolRoot` is the package dir and
`codingToolRepoRoot` is the worktree/repo root. Post-PR2 (Task 0 gate), both
producer expressions in `call.ts` are `storyExecRoot(ctx.packageView)` —
identical. Read `src/tools/policy.ts` (`buildCodingToolSupport`'s consumer,
via `compileToolPolicy`) to find every place `repoRoot` (as distinct from
`root`) is read inside that module, in particular around the Exec
`target: "repoRoot"` resolution the spec names ("Exec's `target: 'repoRoot'`
keeps working off the unified root"):
```
grep -n "repoRoot" src/tools/policy.ts src/tools/run-command-exec.ts src/agents/coding-tool-support.ts
```
Two possible outcomes, and the concrete action for each:
1. **`buildCodingToolSupport` still declares a distinct `repoRoot` parameter**
   (used internally for something the unified `root` value can't already
   answer, e.g. distinguishing a genuinely absent value from "same as root").
   Then rewire line 402 to `repoRoot: options.codingToolRoot` unconditionally
   (never omitted — `codingToolRoot` is always defined by this point in the
   call chain, confirm via its type in `AgentRunOptions`), and delete the
   `codingToolRepoRoot` field/threading everywhere else per the table above.
2. **`buildCodingToolSupport`'s `repoRoot` parameter itself becomes provably
   redundant** once every caller would pass the same value as `root` — in
   that case delete the `repoRoot` parameter from `buildCodingToolSupport`'s
   signature too, and every downstream read of it in `src/tools/policy.ts` /
   `run-command-exec.ts`, replacing with `root`. This is a larger, riskier
   change than outcome 1 — only take it if grep shows `repoRoot` has no use
   inside `policy.ts` that isn't trivially satisfiable by `root` post-PR2.
   Prefer outcome 1 unless outcome 2 is unambiguous from reading the code;
   do not guess.

- [ ] Read `src/tools/policy.ts` and `src/agents/coding-tool-support.ts` in
      full around every `repoRoot` occurrence, decide between outcome 1 and 2
      above, and write down the decision (as a one-line comment at the
      `buildCodingToolSupport` call site, e.g. `// repoRoot === root post
      single-frame redesign (PR2); kept as a named param for clarity` for
      outcome 1) so a future reader does not re-litigate it.
- [ ] Add or adjust a pinning test in `test/unit/agents/coding-tool-support.test.ts`
      (confirm exact filename via
      `find test/unit/agents -iname "*coding-tool-support*"`) asserting the
      chosen outcome: e.g. "resolveCodingToolSupport's repoRoot equals its
      root when codingToolRepoRoot is not on the input" (outcome 1) or "no
      repoRoot field survives on the built CodingToolSupport" (outcome 2).
      Write it, confirm RED against the current code, then apply the
      deletion, confirm GREEN.
- [ ] Delete `codingToolRepoRoot` from `src/agents/types.ts` (field +
      docblock, current lines 183-196) and from `src/operations/call.ts`
      (current line 258) and from the `Pick` union in
      `src/agents/coding-tool-support.ts:261`.
- [ ] Delete `test/unit/operations/call-coding-tool-repo-root-producer.test.ts`
      in full — its entire purpose (per its own docblock, "The PRODUCER for
      `AgentRunOptions.codingToolRepoRoot`") no longer has a subject. Before
      deleting, confirm its worktree-escape assertion
      (`expect(seen[0]?.codingToolRepoRoot).toBe(join(mainCheckout, ".nax-wt", storyId))`
      / `.not.toBe(mainCheckout)`) has an equivalent surviving pin elsewhere
      for `codingToolRoot` itself (the R2 worktree-escape guarantee must not
      lose its test coverage just because the field it was pinned on merged
      into `codingToolRoot`). If no equivalent test exists for
      `codingToolRoot`'s worktree-awareness post-PR2, port this test's
      assertion onto `codingToolRoot` instead of deleting it outright — file
      name becomes `test/unit/operations/call-coding-tool-root-producer.test.ts`
      or similar, at the implementer's discretion, and note in the commit
      message that this is a rename-and-repoint, not a net test-count
      reduction.

### Task 2b — `agent-scope.ts`'s `packageLabel`/prefix-strip logic

**Files:** `src/prompts/sections/agent-scope.ts` (current: 77 lines).

- [ ] Grep the **post-PR2** version of this file before touching it:
      ```
      grep -n "packageLabel\|function buildAgentScopeSection" src/prompts/sections/agent-scope.ts
      ```
      The spec's PR 2 section says PR 2 already "Rewrite[s]
      `src/prompts/sections/agent-scope.ts`: tools rooted at the repo root;
      the story's package is `<workdir>`; spell paths repo-rooted." Two
      possible states at PR-4 start:
      (a) PR 2's rewrite deleted `packageLabel` entirely as part of the
          rewrite (grep returns zero hits) — Task 2b is then a **no-op**;
          record that in the commit and move on, do not invent work.
      (b) PR 2's rewrite kept `packageLabel` (or an equivalent
          worktree-prefix-stripping helper) defined but no longer called from
          the new `buildAgentScopeSection` body (dead code left behind by the
          rewrite) — delete it here, along with its own doc comments
          (current lines 18-38 on the pre-PR2 file) and the
          `WORKTREE_DIR` constant if nothing else in the file uses it.
      Do not assume (a) or (b) — grep and read the real file before deciding
      which branch of this task applies.
- [ ] If (b): update `test/unit/prompts/sections/agent-scope.test.ts` (confirm
      path via `find test -iname "*agent-scope*"`) to drop any case asserting
      the deleted worktree-strip defence-in-depth behavior, keeping every
      case asserting the current (post-PR2) repo-rooted scope-block text.
- [ ] Run `bun run typecheck` — `tool-preamble.ts:35`'s call to
      `buildAgentScopeSection(options.codingToolRoot, options.codingToolRepoRoot)`
      must be updated in the same commit once `codingToolRepoRoot` is deleted
      (Task 2 above); if `agent-scope.ts`'s post-PR2 signature already takes
      only one root parameter, drop the second argument here too.
- [ ] Commit: `refactor(agents): delete codingToolRepoRoot and agent-scope's dead package-label helper (PR4)`

---

## Task 3: Provider chunk headings render repo-rooted; scopePaths converge with rendered text

**Files:**

- `src/context/engine/providers/code-neighbor-chunk.ts` (208 lines) — `assembleCodeNeighborChunk`
- `src/context/engine/providers/code-neighbor.ts` (489 lines) — `spellForConsumer`, `collectNeighbors`, `fetch()`
- `src/context/engine/providers/git-history.ts` (373 lines) — `renderHeading`, `repoScopeFiles`, `collidesWithPackageFile`, `fetch()`
- Tests: `test/unit/context/engine/providers/code-neighbor-chunk.test.ts` (433 lines),
  `test/unit/context/engine/providers/code-neighbor-frame.test.ts` (334 lines),
  `test/unit/context/engine/providers/git-history-scope.test.ts` (288 lines)

**Interfaces — consumes:** the post-PR2 repo-rooted agent scope (from PR 2's
plan, "the highest-leverage prompt change," and R2's `storyExecRoot`
containment) — the agent's file tools can now open any repo path, so a chunk
heading spelled package-relative is not merely inconsistent, it is a path the
agent may fail to resolve exactly as `modifiedFilesLines` would have been
wrong pre-PR2's flip. Also consumes `toRepoFrame` (kept, from Task 1) and
`ContextRequest.storyWorkdir` (selector, unchanged — `src/context/engine/types.ts`).

**Read this whole section before editing** — this task has three genuinely
different sub-concerns living in the same three files, and conflating them is
the mistake to avoid:

1. **Pure render sites** (heading text / scopePaths bookkeeping) — these are
   what the spec's PR-4 bullet literally names ("chunk identity keys and
   scopePaths no longer differ from rendered text"). Delete the re-spell.
2. **Reachability filtering** (code-neighbor.ts `fetch()`'s
   `partitionPackageFrame(touchedFiles, pkgDir, {canonical})` call, whose
   entire purpose was "can the package-contained agent's tools open this
   path") — this concern **disappears**, not just its implementation. Once
   the agent's tools are repo-rooted, every entry in `touchedFiles` (already
   repo-rooted per `types.ts`) is reachable. Delete the partition call and
   the `unreachable`-logging branch outright; do not replace it with a
   membership test.
3. **`historyScope`/`neighborScope: "package"` scope-selection filtering**
   (git-history.ts's `repoScopeFiles`/`collidesWithPackageFile`, gated by
   `this.historyScope === "package"`) — this is a genuine, still-meaningful
   **selector** feature ("only show history for files inside my own
   package"), not a frame-reachability check, and per spec §2 the selector
   axis is explicitly out of scope for deletion. But its current
   implementation happens to reuse `toPackageFrame` purely as a boolean
   "is this path under `packageWorkdir`" test (the re-spelled string it
   returns is discarded — only the null-check is read). This needs a
   **replacement** boolean helper, not a deletion, once `toPackageFrame` is
   gone.

### Steps

- [ ] **Sub-concern 1 — code-neighbor-chunk.ts render site.** Read
      `assembleCodeNeighborChunk` in full (current lines 111-190). The `body`
      text (the `### <file>` heading and each `- <neighbor>` line) is built
      directly from `section.file` / `section.neighbors` with **no**
      reframing today — those are already whatever `code-neighbor.ts`
      produced upstream (package-relative pre-PR2). Only `renderedPaths`
      (the `scopePaths` bookkeeping, used for diff-scope attribution, never
      shown to the agent) is separately reframed via
      `toRepoFrame(section.file, packageWorkdir)` /
      `stripUnreadableMarker(neighbor)` / `toRepoFrame(neighbor, packageWorkdir)`.
      Once sub-concern 2 makes `section.file`/`section.neighbors` themselves
      always repo-rooted (produced that way by `code-neighbor.ts`, see
      below), this separate reframing of `renderedPaths` becomes a no-op
      applied to already-repo-rooted strings, i.e. provably redundant.
      Simplify `renderedPaths.push(...)` to record `path: section.file` /
      `path: neighbor` directly (drop the `toRepoFrame`/`stripUnreadableMarker`/
      `UNREADABLE_MARKER` calls and the now-unused import). Drop the
      `AssembleCodeNeighborChunkInput.packageWorkdir` field entirely if
      nothing else in the function still needs it after this — re-check with
      `grep -n "packageWorkdir" src/context/engine/providers/code-neighbor-chunk.ts`
      once the edit is in place; if a caller still constructs
      `{ ..., packageWorkdir }`, update that call site
      (`code-neighbor.ts`'s `fetch()`) in the same commit.
- [ ] **Sub-concern 2 — code-neighbor.ts producer.** Read `spellForConsumer`
      (current lines ~216-229) and `collectNeighbors`'s two-roots comment
      (current lines ~230-245): `consumerRoot` is documented as "ALWAYS
      `request.packageDir`". Post-PR2, with the agent repo-rooted,
      `consumerRoot` for THIS purpose (what the agent can address) should
      become `request.repoRoot` uniformly — confirm by reading
      `ContextRequest` (`src/context/engine/types.ts`) for whether
      `packageDir` and `repoRoot` remain distinct fields post-PR2 (they
      should: `story.workdir`'s selector job still needs `packageDir` for
      the `neighborScope: "package"` **scan root**, per
      `fetch()`'s `scanRoot = neighborScope === "package" ? packageDir : repoRoot`
      — that line is UNCHANGED, it picks where the reverse-dep glob runs,
      which is a selector concern PR 4 does not touch). What changes is only
      `spellForConsumer`'s OUTPUT frame: once every consumer (the agent) is
      repo-rooted, `spellForConsumer` collapses to "always spell repo-rooted,
      never mark unreadable" — i.e. delete the function and its
      `UNREADABLE_MARKER` marking, and have `collectNeighbors` return
      `relative(repoRoot, absPath)` (or reuse `toRepoFrame` if the input is
      already relative-to-something) directly, unconditionally.
      Read `collectNeighbors`'s body in full (not shown by earlier greps) to
      find every call site of `spellForConsumer` before deleting it — do not
      assume there is exactly one.
- [ ] **Sub-concern 2 continued — `fetch()`'s reachability partition.** Read
      `fetch()` (current lines ~380-425). Delete the
      `partitionPackageFrame(touchedFiles, pkgDir, { canonical })` call, the
      `request.contextFilesCanonical` read that feeds `canonical`, and the
      `unreachable.length > 0` warn-log branch. Replace
      `const filesToProcess = readable.filter(isRelativeAndSafe).slice(0, MAX_FILES);`
      with `const filesToProcess = touchedFiles.filter(isRelativeAndSafe).slice(0, MAX_FILES);`.
      Confirm `request.storyWorkdir`/`pkgDir` still has a live use elsewhere
      in `fetch()` (it should — it is still threaded into `collectNeighbors`
      as part of the selector/scan-root logic) before deleting the `pkgDir`
      local entirely; if `pkgDir` becomes unused after this edit, delete it
      too, but check first.
- [ ] **Sub-concern 3 — git-history.ts render site (`renderHeading`).** Read
      the function (current lines ~89-103) and its docblock. Replace its
      body with a straight pass-through: `return filePath;` (the function
      itself can be deleted and its one call site inlined, or kept as a
      one-line pass-through with an updated docblock explaining why it no
      longer reframes — prefer deleting it and inlining, since a one-line
      identity wrapper adds indirection the forbidden-patterns "wrapper
      functions are banned" convention discourages). Delete the
      `UNREADABLE_MARKER` import from this file once no other function in it
      still uses it (check `collidesWithPackageFile`/`repoScopeFiles` — they
      use `toPackageFrame`, not the marker, so the marker import should be
      fully removable here).
- [ ] **Sub-concern 3 continued — `repoScopeFiles`/`collidesWithPackageFile`
      selector filtering.** These implement `historyScope: "package"` (drop
      files outside the package) and, for `historyScope: "repo"`, a
      collision-avoidance heuristic for pre-single-frame ambiguous inputs.
      Read both functions in full (current lines ~108-160). Add a small,
      local, pure boolean helper to replace `toPackageFrame(file, workdir) !== null`'s
      use as a membership test — do **not** reintroduce `toPackageFrame`
      itself. Recommended shape, colocated in `src/utils/path-frame.ts` next
      to `toRepoFrame` (this is what spec item 5's "and the selector
      contract" phrase in the `path-frame.ts` header rewrite refers to — the
      header explicitly says the file "shrinks to `toRepoFrame`, the workdir
      accessors... and the selector contract," and this membership
      predicate is exactly a selector-contract primitive, not a frame
      primitive):
      ```typescript
      /**
       * True when a repo-rooted `path` lies within the package rooted at
       * `workdir` (segment-boundary match, same boundary rule as toRepoFrame).
       * Selector-contract primitive: answers "is this file inside my
       * package", never re-spells. workdir "." (repo root) always matches.
       */
      export function isWithinPackage(path: string, workdir: string | null | undefined): boolean {
        const prefix = normalizeWorkdir(workdir);
        if (prefix === ".") return true;
        const normalized = toPosix(path); // toPosix is currently unexported; export it or inline the two-line normalization here
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      }
      ```
      `toPosix` is currently a private (unexported) helper in `path-frame.ts`
      — either export it for reuse here, or inline its two-line body into
      `isWithinPackage` to avoid a new export whose only purpose is this one
      caller; prefer inlining unless a second caller appears during this
      task. Use `isWithinPackage` in `repoScopeFiles`'s
      `files.filter((file) => toPackageFrame(file, packageWorkdir) === null)`
      → `files.filter((file) => !isWithinPackage(file, packageWorkdir))`, and
      in `fetch()`'s `historyScope === "package"` branch
      (`inHistoryScope = safeFiles.filter((file) => toPackageFrame(file, packageWorkdir) !== null)`
      → `.filter((file) => isWithinPackage(file, packageWorkdir))`, and the
      paired `droppedByScope` line the same way).
      **Do not delete `collidesWithPackageFile`'s collision-avoidance
      machinery for `historyScope: "repo"` + non-canonical input** — this is
      the git-history analogue of the builder.ts Legacy ruling (tolerant
      read of a still-possibly-ambiguous legacy `touchedFiles` list); it is
      gated on `canonical` which traces back to `request.contextFilesCanonical`
      / `story.workdirSource !== undefined`, exactly the flag the Legacy
      ruling protects. Only its `toPackageFrame` calls get swapped for
      `isWithinPackage`; its existence and branching stay.
- [ ] Add pinning tests in `code-neighbor-chunk.test.ts` and
      `git-history-scope.test.ts` (and `code-neighbor-frame.test.ts` if it
      separately exercises `spellForConsumer`) asserting the new invariant
      literally: for a fixture with a cross-package neighbor/history entry,
      `chunk.content` contains the exact string that also appears in
      `chunk.scopePaths` — i.e. "heading == scopePath," not merely "both are
      repo-rooted." Write these as the RED step before the corresponding
      deletion in each file; confirm they fail against the pre-deletion
      code (which currently produces a package-relative heading and a
      repo-rooted scopePath — provably different strings for any
      multi-package fixture) before applying the edit.
- [ ] Delete or rewrite every existing test case in the three test files that
      specifically asserted the OLD reframe/marker behavior (e.g. "renders
      package-relative heading for the consumer" style assertions,
      `UNREADABLE_MARKER`-suffix assertions) — read each file in full first;
      these files are large (433 / 334 / 288 lines) and mix cases that will
      survive (selector semantics: `neighborScope`/`historyScope: "package"`
      dropping out-of-package files) with cases that must be deleted or
      rewritten (frame-marking behavior).
- [ ] Run `bun run typecheck && bun run lint && bun run test test/unit/context/engine/providers/code-neighbor-chunk.test.ts test/unit/context/engine/providers/code-neighbor-frame.test.ts test/unit/context/engine/providers/git-history-scope.test.ts --timeout=30000` and confirm green before the full-suite run at the end of this plan.
- [ ] Commit: `refactor(context): render provider chunk headings repo-rooted; converge scopePaths with rendered text (PR4)`

---

## Task 4: `reclassifyPlanTimeAbsentEntries` and `builder-parent-frame.test.ts` — confirm covered by Task 1

This is a cross-reference, not new work: Task 1's steps already cover deleting
`reclassifyPlanTimeAbsentEntries` from `builder.ts` if it is dead post-PR2/PR3.
Restated here only so the task list is traceable against the spec's own PR-4
bullet, which does not name this helper explicitly (it is a discovered
consequence of reading `builder.ts` on the current tree, not a literal spec
line item). No separate steps.

---

## Task 5: `path-frame.ts` header + 09-16 spec status block

**Files:** `src/utils/path-frame.ts` (header docblock, current lines 1-23),
`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (status
line, current line 3).

- [ ] Rewrite `path-frame.ts`'s header docblock (lines 1-23). It currently
      describes three coexisting frames ("nax holds relative file paths in
      two frames... Package-relative spelling appears only where a path
      crosses into a package-contained agent's prompt"). Replace with a
      description matching the post-PR4 surface: one canonical frame
      (repo-rooted) for every nax-internal path set; `toRepoFrame` is a
      defensive re-spell for a stray non-conforming input, never a
      steady-state translation step; `story.workdir` is a **selector**
      (which package's rules/config/command-cwd apply — `storyWorkdir` /
      `storyPackageDir` / `storyAbsWorkdir` / `isWithinPackage`), not a frame
      boundary. Cite this design's spec
      (`docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md`)
      as current SSOT, alongside the existing citation of the 09-16 doc
      (kept as historical background, not current behavior — see next
      step).
- [ ] Update the `UNREADABLE_MARKER` doc-comment cross-reference at
      `code-neighbor.ts`'s old citation ("carries the same UNREADABLE_MARKER
      nax#2072 already ships") — this becomes stale prose once the marker is
      deleted in Task 3; confirm Task 3 already removed or rewrote every such
      comment (grep `grep -rn "UNREADABLE_MARKER" src/` post-Task-3 should
      return zero hits; if any remain in comments only, delete them here).
- [ ] Edit the 09-16 spec's status line (current line 3: `**Status:**
      Implemented and merged in three waves; a fourth is in flight...`).
      Append a supersession note, e.g.: `**Superseded (2026-09-18):** the
      package-relative agent-containment model this spec worked around is
      retired by
      docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md;
      the package-frame translation layer this spec introduced
      (toPackageFrame/partitionPackageFrame/UNREADABLE_MARKER) was deleted in
      that design's PR 4. This document's problem statement and Wave 1-3
      history remain accurate background; its "package frame" as a live
      convention does not.` Do not delete or rewrite the rest of the 09-16
      doc — it is historical record of real merged PRs (#2076-#2110), and
      the task's own scope is "status block" only.
- [ ] Commit: `docs(path-frame): update SSOT header and mark the 09-16 convention spec superseded (PR4)`

---

## Task 6: `scripts/check-story-workdir-access.ts` — gate decision record

**Files:** `scripts/check-story-workdir-access.ts` (516 lines),
`test/unit/scripts/check-story-workdir-access.test.ts` (773 lines),
`test/fixtures/story-workdir-access/v1-regex-reference.ts` (43 lines).

**Decision (made from reading the actual gate code on the current tree, not
guessed):** this gate has **no separate "frame half" to retire.** Its entire
purpose, per its own header docblock (lines 1-97) and the `ALLOWED`/exemption
tables that follow, is enforcing that `story.workdir` is read only through the
`src/utils/path-frame.ts` accessors (`storyWorkdir`/`storyPackageDir`/
`storyAbsWorkdir`/`StoryWorkdirLike`) rather than as a raw field access —
three prior spellings of "absent" (`?? ""`, `|| undefined`, truthiness) is the
defect class it exists to prevent (nax#2067/#2084). Confirmed by grep: zero
occurrences of `toPackageFrame`/`partitionPackageFrame`/`Frame` (as a
frame-mechanism identifier) inside the script itself —
`grep -n "toPackageFrame\|partitionPackageFrame\|packageRelative" scripts/check-story-workdir-access.ts`
returns nothing; every "path-frame.ts" mention in the file is a citation of
where the accessor functions themselves live, which is precisely the
**selector** contract this design's §2 explicitly keeps ("`story.workdir`
keeps exactly two jobs... Selector... This axis is untouched; the
`storyWorkdir`/accessor discipline and its gate remain for it").

**Therefore: no code change to `scripts/check-story-workdir-access.ts` or its
walker logic in this task.** The frozen-v1-regex superset differential test
(`test/unit/scripts/check-story-workdir-access.test.ts` against
`test/fixtures/story-workdir-access/v1-regex-reference.ts`) needs no new
fixture and no gate rewrite, because nothing about the gate's enforced
contract changes — `story.workdir` is still read exclusively through
`storyWorkdir`/`storyPackageDir`/`storyAbsWorkdir`, and `isWithinPackage`
(Task 3, if added to `path-frame.ts`) is a new accessor-adjacent export in
the same file the gate already treats as a declaration site
(`ALLOWED`/`EXEMPT` tables list `src/utils/path-frame.ts` as one of the two
files permitted to touch the raw field — confirm `isWithinPackage` does not
itself need an entry there, since it takes a plain `path: string` parameter,
not a story, and therefore never triggers the gate's `isStoryReceiver`
check).

- [ ] Run the differential test as-is to confirm it is currently green on the
      current tree (baseline, before any PR4 change lands):
      `bun run test test/unit/scripts/check-story-workdir-access.test.ts --timeout=30000`.
- [ ] If Task 3 adds `isWithinPackage` to `path-frame.ts`, re-run the same
      test after that addition lands and confirm it is still green (the new
      export takes a bare string, not a story-shaped receiver, so the gate's
      `isStoryReceiver`/property-declaration walk should not flag it —
      confirm empirically rather than by inspection alone, since the gate's
      own docblock warns it is easy to reason incorrectly about which shapes
      it catches).
- [ ] Update only the gate's header **documentation** (lines 1-9, the "Read
      it through src/utils/path-frame.ts instead" list) if `isWithinPackage`
      is added — extend the bullet list to mention it as a legal accessor
      alongside `storyWorkdir`/`storyPackageDir`/`storyAbsWorkdir`, purely
      for a future reader's benefit; this is prose, not gate logic, and
      changing it does not touch `findViolations` or any walker function.
- [ ] Commit (only if the doc-comment edit above applies; otherwise this task
      produces no commit — record in the plan's execution log that the gate
      was verified unchanged): `docs(scripts): note isWithinPackage as a legal path-frame accessor (PR4)` — combine with Task 3's commit if both land together, to avoid a docs-only commit with zero substantive diff.

---

## Task 7: File-size baseline check

**Files:** `scripts/baselines/file-sizes-baseline.json` (14 grandfathered
files today, none of which are files this plan touches).

Current 14-entry baseline (`cat scripts/baselines/file-sizes-baseline.json`):
`src/execution/unified-executor.ts` (704), `src/interaction/plugins/telegram.ts`
(602), `src/prompts/builders/rectifier-builder.ts` (903), `src/session/manager.ts`
(679), `test/unit/agents/acp/spawn-client.test.ts` (810),
`test/unit/cli/plan.test.ts` (1201), `test/unit/context/engine/providers/static-rules.test.ts`
(803), `test/unit/debate/runner-plan.test.ts` (1038),
`test/unit/execution/escalation/tier-escalation.test.ts` (1025),
`test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` (849),
`test/unit/execution/story-orchestrator.test.ts` (1998),
`test/unit/findings/cycle.test.ts` (933), `test/unit/interaction/plugins/telegram.test.ts`
(869), `test/unit/operations/call.test.ts` (967).

None of these 14 files appear among the files this plan edits or deletes
(`path-frame.ts` 199, `builder.ts` 521, `code-neighbor-chunk.ts` 208,
`code-neighbor.ts` 489, `git-history.ts` 373, `story.ts` 143, `agent-scope.ts`
77, `coding-tool-support.ts` 421, `types.ts` 572, `call.ts` 600,
`check-story-workdir-access.ts` 516, `reframe.ts` 96 — deleted whole). On the
**current tree**, therefore, no baseline entry is expected to shrink from this
plan's edits alone.

- [ ] Re-verify this list against the actual post-PR1-3 tree before assuming
      it still holds — PRs 1-3 touch several of the same files this plan
      edits (`call.ts`, `coding-tool-support.ts`, `agent-scope.ts`,
      `story.ts`, `builder.ts` all appear in PR 2/PR 3's own scope) and may
      have pushed one of them over 600 lines, adding a new grandfathered
      entry PR 4's deletions would then shrink back down:
      `wc -l src/context/builder.ts src/agents/coding-tool-support.ts src/agents/types.ts src/operations/call.ts src/prompts/sections/story.ts src/prompts/sections/agent-scope.ts`
      and cross-check each against `scripts/baselines/file-sizes-baseline.json`.
- [ ] If any file this plan touches now appears in the baseline (added by
      PR 1-3) and this plan's deletions bring it back under 600 lines, run
      `bun run check:file-sizes:update` **once, after all other tasks in
      this plan are complete and `bun run check:all` is green** — never
      before, per the test-ratchets convention ("Always run `bun run
      check:all` and see it green before any `--update-baseline`").
- [ ] If no touched file appears in the baseline, do nothing — do not run
      `check:file-sizes:update` speculatively; an unwarranted baseline write
      is itself a regression risk per the same convention.
- [ ] Commit only if the baseline file changed: `chore: lower file-size baseline after PR4 deletions`.

---

## Task 8: Final integration-branch verification

**Files:** none (verification only).

- [ ] `RTK_DISABLED=1 bun run typecheck`
- [ ] `RTK_DISABLED=1 bun run lint`
- [ ] `RTK_DISABLED=1 bun run test` (never bare `bun test` for the suite)
- [ ] `RTK_DISABLED=1 bun run test:coverage`
- [ ] `RTK_DISABLED=1 bun run check:file-sizes` (separately from the baseline
      update in Task 7 — confirms no file exceeds its allowed cap post-edit)
- [ ] Re-run the full grep sweep from Task 1's table
      (`grep -rln "toPackageFrame\|partitionPackageFrame\|UNREADABLE_MARKER\|stripUnreadableMarker" src/ test/ --include="*.ts"`)
      and confirm it returns **zero results anywhere in the repo** — this is
      the plan's own completion criterion, not a proxy for it.
- [ ] Confirm `codingToolRepoRoot` is fully gone:
      `grep -rn "codingToolRepoRoot" src/ test/ --include="*.ts"` returns
      zero results.
- [ ] Confirm the frozen-v1-regex superset differential
      (`test/unit/scripts/check-story-workdir-access.test.ts`) is still
      green, unchanged.
- [ ] Do **not** run `nax run` or any live monorepo verification from inside
      this task. Spec §6's live verification ("one monorepo `nax run` per
      protocol arm on a fixture copy... on the **completed** integration
      branch") happens after this PR merges into the integration branch, as
      its own explicitly-approved step — per standing team ruling, `nax run`
      is a real, billed LLM run and requires explicit approval at the launch
      moment, and per the spec's own delivery strategy this verification
      runs against the whole four-PR integration branch, not PR 4 in
      isolation. Note this explicitly in the PR description so the next
      actor does not skip straight to merging into `main` without it.
- [ ] Once all of the above is green, this PR is ready for its
      phase-reviewed sub-PR into `feat/single-frame-redesign`, per the
      spec's delivery strategy (§4): reviewed on its own, then merged into
      the integration branch, and only the whole-arc review pass (after
      spec §6's live verification) merges the integration branch to `main`.
