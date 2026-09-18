# PR 2: The Root Move — Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Move the agent's containment root — both transports — from the story's package
dir to the story's execution root (`storyExecRoot`), and flip every prompt
boundary and mechanical follow-on that is *coupled* to that root in the same
PR, per the spec's blocker ruling. After this PR: `codingToolRoot` (native) and
the ACP spawn cwd both equal `storyExecRoot(ctx.packageView)`; prompts spell
paths repo-rooted; `--relative` is gone from the native Git tool and from
every prompt-embedded / subprocess-collector git invocation; the MCP pool,
Exec cwd derivation, verifier verdict handshake, execTouchedPaths carve-out,
and acceptance-setup's `packages.resolve()` call all keep working under the
new root (each with its own test). `story.workdir` keeps exactly two jobs
(selector, command cwd) after this PR — the frame job is retired here; the
containment job was already retired by the root move itself.

## Architecture

Before this PR (current `master`, confirmed by reading the source):

| Concern | Producer | Value |
|:---|:---|:---|
| Native containment root | `src/operations/call.ts:254` `codingToolRoot` | `packageWorkdir(ctx.packageView)` — package dir |
| Exec's repo-root target | `src/operations/call.ts:258` `codingToolRepoRoot` | `storyExecRoot(ctx.packageView)` — already worktree-aware |
| ACP spawn cwd | `src/operations/call.ts:126,234,280` (`workdir` field on `completeOptions`/`runOptions`/`hopCtx`) | `ctx.packageDir`, itself produced at `src/pipeline/stages/execution.ts:107` (`packageDir: ctx.workdir`) |
| Prompt path spelling | `src/prompts/sections/story.ts:56-61` `modifiedFilesLines`, `src/context/builder.ts:404-432` | package-relative (`toPackageFrame`/`partitionPackageFrame`) |
| Agent-scope prompt | `src/prompts/sections/agent-scope.ts` | "tools rooted at `<package>`, spell relative to it" |

After this PR:

| Concern | Value |
|:---|:---|
| Native containment root | `storyExecRoot(ctx.packageView)` |
| Exec's repo-root target | unchanged value, now equal to the containment root (collapse, not redirect) |
| ACP spawn cwd | `storyExecRoot(ctx.packageView)` |
| Prompt path spelling | repo-rooted, as stored (pass-through) |
| Agent-scope prompt | "tools rooted at the repo root; your package is `<workdir>`; commands run there" |

**Correction to two spec file citations**, verified by reading the source
(the spec's paths do not exist under those names — cite the real ones instead):
- Spec cites `src/quality/package-managers.ts` for the Exec `packageRelPath`
  derivation. The real split is `src/tools/run-command-exec.ts:65-66`
  (computes `packageRelPath`) → `src/tools/package-managers.ts:360-366`
  (`normalizeExec`, the `effectiveTarget` collapse). There is no
  `src/quality/package-managers.ts`.
- `src/agents/coding-tool-support.ts` is the wiring layer between
  `AgentRunOptions` and both of the above; it is where the actual fix for the
  Exec follow-on lands (Task 10).

## Tech Stack

Bun 1.4, TypeScript strict, `bun:test`, Biome. No new dependencies. DI via
`_deps` objects; no `mock.module()`. All new prompt-building logic stays inside
existing files under `src/prompts/builders/` and `src/prompts/sections/` — no
new orphan prompt functions.

## Spec

`docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` §"PR 2 —
the root move" (lines 176-245), read in full before this plan was written.

## Global Constraints

- `src/tools/policy.ts` is currently **595 lines**, `src/operations/call.ts`
  is currently **600 lines** (verified by `wc -l`, not the spec's stated
  597/599 — the plan trusts the verified counts). Neither file may grow.
  `call.ts`'s two-line diff (Task 1) stays inside its existing 600 by editing
  in place with no net new lines (swap two RHS expressions and one property
  name reference — see Task 1). `policy.ts`'s Task 13 change is a **deletion**
  (removes the `execTouchedPaths` parameter and its call sites), so it can
  only shrink.
- Any new logic that does not fit in an at-cap file goes into a **new leaf
  module** under the same directory, exported through that directory's barrel
  per `project-conventions.md`.
- `test/unit/tools/` containment suite is root-parameterized (root passed as a
  parameter, not hardcoded to "package dir") and must keep passing verbatim —
  confirm this explicitly in Task 17, do not just assume it from the name.
- `bun run check:story-workdir-access` and `bun run check-package-frame-derivation`
  (or whatever the currently-named script is — resolve the exact `package.json`
  script name in Task 0) must stay green throughout. This PR does **not**
  retire the frame half of the workdir-access gate — that is PR 4.
- Every touched prompt branch is rendered and its output read in a test
  (snapshot or explicit-string assertions), never template-reviewed alone —
  standing working agreement, restated in the spec as binding for this PR.
- Conventional commits; one logical concern per commit; run
  `bun run typecheck && bun run lint && bun run test` after every task, not
  only at the end — catch drift early given the number of coupled sites.
- Never bare `bun test`; use `bun run test` (or a targeted
  `bun test test/unit/<path> --timeout=30000` while iterating).

## Interfaces

### Consumes (from PR 1 plan `01-pr1-command-cwd-split.md` — reconciled
against that plan's Produces section; Task 0 still re-verifies against the
tree PR 1 actually landed)

- `AgentRunOptions.codingToolPackageDir?: string` (`src/agents/types.ts`,
  added by PR 1) — the story's package dir, threaded independently of
  `codingToolRoot`. PRODUCER: `buildRunDispatchOptions` in the new
  `src/operations/call-run-options.ts` (PR 1 Task 1's extraction of
  `call.ts`'s runOptions literal).
- `RunCommandToolOptions.commandCwd?: string` (`src/tools/run-command.ts`,
  added by PR 1) — the declared branch's execution cwd, consumed at
  `run-command.ts:428` in place of `ctx.root` for
  `runQualityCommand({ workdir: ... })`. Without this, Task 1's root collapse
  would make every declared quality command run at the repo root.
- `buildCodingToolSupport`'s `args.commandCwd?: string` and
  `_codingToolSupportDeps = { loadConfigForPackage }`
  (`src/agents/coding-tool-support.ts`, PR 1 Tasks 4-5) — the per-package
  declared-command map (#2066 residual) is already resolved via
  `loadConfigForPackage` there. PR 2 does not touch that resolution path; it
  only depends on PR 1 having made declared-command cwd independent of
  `codingToolRoot` so Task 1's collapse is safe.

If Task 0's audit finds the landed PR 1 diverges from these names, update
every reference in this plan to the real names before proceeding — do not
silently code against a stale name.

### Produces (this PR's own outputs, exact signatures)

- `codingToolRoot` value at `src/operations/call.ts:254` changes from
  `packageWorkdir(ctx.packageView)` to `storyExecRoot(ctx.packageView)`. No
  signature change — same field, new value.
- `workdir` field on `completeOptions` (`call.ts:126`), `runOptions`
  (`call.ts:234`), `hopCtx` (`call.ts:280`) changes from `ctx.packageDir` to
  `storyExecRoot(ctx.packageView)`.
- `buildAgentScopeSection(root: string | undefined, repoRoot: string | undefined, workdirLabel: string | undefined): string | undefined`
  — new third parameter, `src/prompts/sections/agent-scope.ts`. `root` and
  `repoRoot` are now always equal post-move (kept as a pair per the spec's
  "don't delete packageLabel logic yet" instruction, PR 4 collapses them);
  `workdirLabel` is the story's package-relative workdir (`storyWorkdir(story)`,
  `"."` for a repo-root story) and is the new source of "which package are you
  in" now that `root`/`repoRoot` no longer differ.
- `modifiedFilesLines(story: UserStory, rootWorkdir: string): string[]` — same
  signature, `src/prompts/sections/story.ts`; body no longer calls
  `toPackageFrame`.
- `packageDirRelative` threading into three new prompt-builder parameters
  (Task 7): `ReviewPromptBuilder`'s diff-section helper, `AdversarialReview`'s
  diff-section helper, `DebatePromptBuilder`'s diff-section helper each gain a
  `pathspec: string` parameter (the story's repo-relative package dir, or
  `"."`).
- `buildCodingToolSupport`'s `args.packageWorkdir?: string` (Task 10) — the
  story's actual package dir for Exec's `target: "package"` cwd, fed from PR
  1's existing `AgentRunOptions.codingToolPackageDir` (NO new AgentRunOptions
  field; PR 1's `buildRunDispatchOptions` already populates it).
- `resolveAbsolutePackageDir` in `src/operations/verify.ts` renamed in place
  to return `storyExecRoot(ctx.packageView)` (Task 11) — same call sites,
  changed value.

---

## Task 0 — Audit PR 1's actual landing shape

- [ ] Read `git log --oneline main..feat/single-frame-redesign` (prefix
      `RTK_DISABLED=1`) and `git log --oneline` on whatever branch PR 1 landed
      on, to confirm whether PR 1 has been implemented yet.
- [ ] If PR 1 is unimplemented: stop and flag this to the operator before
      starting Task 1 — Task 1's collapse is unsafe without PR 1's cwd split
      (declared commands would silently start running at the repo root).
- [ ] If PR 1 is implemented under different names than the "Consumes"
      section above assumes, update every reference in this plan file to the
      real names (grep `RunCommandToolOptions`, `commandCwd`,
      `codingToolPackageDir`,
      `resolveCodingToolSupport` in the post-PR-1 tree) before proceeding.
- [ ] Resolve the exact `package.json` script names for
      `check:story-workdir-access` and the "check-package-frame-derivation"
      gate referenced in the task prompt (grep `package.json` scripts for
      `story-workdir` and `package-frame`); record the real names here so
      later tasks invoke the right command.
- [ ] Confirm current line counts with `wc -l src/operations/call.ts
      src/tools/policy.ts` and record them (used as the Task 1 / Task 13
      ceiling — do not trust the spec's stated numbers, they were off by a few
      lines against the checked-out tree).

## Task 1 — The root collapse: `codingToolRoot` and ACP spawn cwd

**Files:**
- `src/operations/call.ts:254,258,126,234,280` (verified)
- `src/pipeline/stages/execution.ts:107` (verified — `packageDir: ctx.workdir`, read-only reference, no change needed here; `ctx.packageDir` stays as-is, only its *consumers* in `call.ts` change)

**Interfaces:**
- Consumes: `storyExecRoot(view)` (already exported, `src/runtime/packages.ts:219`), PR 1's decoupled declared-command cwd (see "Consumes" above).
- Produces: `codingToolRoot` and ACP `workdir` both equal `storyExecRoot(ctx.packageView)`.

**Steps:**

- [ ] Write a failing test in `test/unit/operations/call.test.ts` asserting
      that for a package story (`packageView.packageDir = "packages/api"`,
      `packageView.repoRoot = "/repo"`), the `codingToolRoot` passed into the
      dispatched `runOptions`/`completeOptions` equals
      `storyExecRoot(packageView)` (`/repo` for a non-worktree story), **not**
      `packageWorkdir(packageView)` (`/repo/packages/api`). Use the existing
      mock-runtime/mock-agent-manager pattern already in that test file to
      capture the options object passed to `runWithFallback`/`completeAsWithFallback`.
      Run it — it must FAIL against current `call.ts` (current value is the
      package dir).
- [ ] Write a second failing assertion in the same test: for a
      **worktree-isolated** story (`packageView.packageDir = ".nax-wt/<storyId>/packages/api"`),
      `codingToolRoot` equals `storyExecRoot(packageView)` =
      `/repo/.nax-wt/<storyId>` — the worktree root, not the main checkout and
      not the package dir. This pins the spec's Risk-table item "Worktree
      escape via wrong repo root" (R2).
- [ ] Write a third failing assertion: the `workdir` field on the dispatched
      `runOptions` (the ACP-arm cwd) also equals `storyExecRoot(packageView)`,
      not `ctx.packageDir`.
- [ ] Run `bun test test/unit/operations/call.test.ts --timeout=30000`; confirm
      all three new assertions FAIL with the current package-dir values (not
      an unrelated error) — this is the "run FAIL with reason" checkpoint.
- [ ] Implement: in `src/operations/call.ts`, change line 254 from
      `codingToolRoot: packageWorkdir(ctx.packageView),` to
      `codingToolRoot: storyExecRoot(ctx.packageView),`. Line 258
      (`codingToolRepoRoot: storyExecRoot(ctx.packageView),`) is unchanged —
      it is now numerically identical to `codingToolRoot`, which is the
      collapse the spec describes; do not delete the field or the line here
      (PR 4's job).
- [ ] Change line 126 (`workdir: ctx.packageDir,` inside `completeOptions`)
      and line 234 (`workdir: ctx.packageDir,` inside `runOptions`) and line
      280 (`workdir: ctx.packageDir,` inside `hopCtx`) to
      `workdir: storyExecRoot(ctx.packageView),`. `packageWorkdir` import may
      become unused in this file if nothing else references it — check before
      removing the import (grep the file); if unused, remove it from the
      import list at line 10.
- [ ] Run the three tests again; confirm PASS.
- [ ] Run `bun run typecheck` — `ctx.packageDir` is still a valid
      `CallContext` field (used elsewhere, e.g. `computeAcpHandle(ctx.packageDir, ...)`
      at line 109, session naming) and must not be removed from the type;
      only its use as the dispatch `workdir` is replaced.
- [ ] `git add src/operations/call.ts test/unit/operations/call.test.ts && git commit`
      with `refactor(operations): root the agent (native + ACP) at storyExecRoot`.

## Task 2 — Flip `modifiedFilesLines` to repo-rooted pass-through

**Files:** `src/prompts/sections/story.ts:22-62` (verified)

**Interfaces:**
- Consumes: Task 1's root move (this flip is coupled to it — see spec's
  "BLOCKER ruling").
- Produces: `modifiedFilesLines(story, rootWorkdir)` unchanged signature;
  body no longer reframes.

**Steps:**

- [ ] Write a failing test in `test/unit/prompts/sections/story.test.ts` (or
      the existing story-section test file — locate it first with
      `find test -iname "*story*section*"` or grep for `buildStorySection`):
      a story with `modifiedFiles: [{ path: "packages/api/src/foo.ts", reason: "..." }]`
      and `story.workdir = "packages/api"` must render the path as
      `packages/api/src/foo.ts` (repo-rooted, as stored) in the rendered
      `buildStorySection` output, **not** `src/foo.ts` (the current
      package-relative `toPackageFrame` output). Render the full section and
      assert on the substring — per the render-and-read working agreement.
      Run it; confirm FAIL against current code (currently emits `src/foo.ts`).
- [ ] Implement: in `src/prompts/sections/story.ts`, change
      `modifiedFilesLines` from:
      ```ts
      function modifiedFilesLines(story: UserStory, rootWorkdir: string): string[] {
        const entries = story.modifiedFiles;
        if (!entries || entries.length === 0) return [];
        return buildModifiedFilesLines(
          entries.map((entry) => ({ ...entry, path: toPackageFrame(entry.path, rootWorkdir) ?? entry.path })),
        );
      }
      ```
      to:
      ```ts
      function modifiedFilesLines(story: UserStory, _rootWorkdir: string): string[] {
        const entries = story.modifiedFiles;
        if (!entries || entries.length === 0) return [];
        // nax single-frame redesign PR 2: the agent's tools are now rooted at
        // the repo root, so a repo-rooted modifiedFiles entry is passed through
        // as stored — no package reframing. `_rootWorkdir` kept as a parameter
        // (unused) so every call site and this function's signature survive
        // unchanged until PR 4 deletes both; a bare rename would touch three
        // call sites for a helper being deleted in the very next phase anyway.
        return buildModifiedFilesLines(entries);
      }
      ```
      Remove the now-unused `toPackageFrame` import from the top of the file
      (`storyWorkdir, toPackageFrame` → `storyWorkdir`) — keep `storyWorkdir`,
      it is still used by `buildStorySection`/`buildStoryReminderSection`.
- [ ] Run the test; confirm PASS.
- [ ] Grep the whole file for any other reference to the now-stale doc comment
      above `modifiedFilesLines` (lines 21-55) that describes the
      package-reframing rationale — update it to say the entries are rendered
      repo-rooted as stored post-single-frame-redesign, so the comment does
      not mislead the next reader (do not delete the doc — the `rootWorkdir`
      batch-anchor rationale in the comment, re: nax#2085 H6, is now moot too;
      note that plainly).
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(prompts): render modifiedFiles repo-rooted, no package reframe`.

## Task 3 — Flip `builder.ts`'s `partitionPackageFrame` consumption

**Files:** `src/context/builder.ts:380-455` (verified, read in full)

**Interfaces:**
- Consumes: Task 1.
- Produces: `declaredContextFiles`/`expectedFiles` now render as `framedContextFiles`/`framedExpectedFiles` pass-through (no partitioning), `unreachable` always empty in the new branch.

**Steps:**

- [ ] Read the full function this snippet lives in (the ~50 lines above line
      380 for its signature and the ~30 lines after line 455 for how
      `framedContextFiles`/`framedExpectedFiles`/`unreachable` are consumed)
      before editing — confirm no other consumer of `unreachable` needs special
      handling.
- [ ] Write a failing test (locate the existing context-builder test file,
      likely `test/unit/context/builder.test.ts`): a story with
      `contextFiles: ["packages/api/src/bar.ts"]`, `story.workdirSource` set
      (so `canonical` would have been `true` under the OLD code path), and
      `story.workdir = "packages/api"` must, post-flip, load/emit
      `packages/api/src/bar.ts` (repo-rooted, unchanged) rather than the
      package-relative `src/bar.ts` the current `partitionPackageFrame` call
      would produce. Also assert a cross-package `contextFiles` entry (e.g.
      `"packages/other/src/baz.ts"`) is **no longer dropped into `unreachable`**
      — it is repo-rooted and the repo-rooted agent CAN reach it now (this is
      R5's "cross-package writes/reads are no longer physically blocked" made
      concrete for reads). Run; confirm FAIL against current code (current
      code drops the cross-package entry).
- [ ] Implement: replace the block from
      ```ts
      const canonical = !usedAutoDetect && story.workdirSource !== undefined;
      const declaredContextFiles = canonical
        ? await reclassifyPlanTimeAbsentEntries(contextFiles, storyWorkdir(story), workdir, parentFileSet)
        : contextFiles;
      const { readable: framedContextFiles, unreachable } = partitionPackageFrame(
        declaredContextFiles,
        storyWorkdir(story),
        { canonical },
      );
      const { readable: framedExpectedFiles } = partitionPackageFrame(expectedFiles, storyWorkdir(story));
      ```
      with:
      ```ts
      // nax single-frame redesign PR 2: the agent's tools are rooted at the
      // repo root post-move, so every repo-rooted declared path is reachable
      // by construction — package reframing and the plan-time-absent
      // reclassification it depended on are retired for RENDERING purposes
      // here. `reclassifyPlanTimeAbsentEntries` and `partitionPackageFrame`
      // stay defined (PR 4 deletes them once nothing calls them at all) but
      // this call site stops invoking them. `contextFiles`/`expectedFiles`
      // pass straight through; nothing is dropped as unreachable.
      const framedContextFiles = contextFiles;
      const framedExpectedFiles = expectedFiles;
      const unreachable: string[] = [];
      ```
      Check whether `usedAutoDetect`, `reclassifyPlanTimeAbsentEntries`,
      `partitionPackageFrame`, `parentFileSet` become unused in this file after
      the change — if `reclassifyPlanTimeAbsentEntries` and
      `partitionPackageFrame` are imported ONLY for this call site, remove the
      now-dead imports (do not delete the functions themselves from their
      source modules — PR 4's job, and other files may still import them);
      run `bun run lint` to catch any biome unused-import warning if you miss
      one.
- [ ] The `if (unreachable.length > 0)` warning block immediately below stays
      — it is now permanently dead for this path (`unreachable` is always
      `[]`) but harmless; leave it rather than deleting the log statement,
      since PR 4's helper deletion will naturally make this whole branch
      unreachable and that is the right time to remove it (removing it now
      widens this task's diff without a spec mandate).
- [ ] Run the test; confirm PASS.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(context): stop package-reframing declared context files`.

## Task 3b — Flip `feature-context.ts`'s fragment reframe

The third coupled prompt-boundary reframe (found in PR 4's deletion
inventory, not in the spec's original checklist): fragment bodies' "Files
touched" lists are re-spelled package-relative for the prompt.

**Files:** `src/context/engine/providers/feature-context.ts:24,380-390`
(verified: `reframeFilesTouched(rawBody, storyWorkdir(this.story))` at :389,
with a doc comment explaining the #2069 worktree trap that stays true for the
selector but no longer justifies reframing).

**Interfaces:**
- Consumes: Task 1 (agent root now repo-rooted, so repo-rooted fragment
  bodies are addressable as-is).
- Produces: fragment bodies pass through unreframed; `reframeFilesTouched`
  loses its last production caller (PR 4 deletes it with `reframe.ts`).

**Steps:**

- [ ] Locate the existing test coverage:
      `grep -rn "reframeFilesTouched" test/` — extend the feature-context
      provider test file that exercises fragment rendering (find it via
      `grep -rln "feature-context" test/unit/context/`).
- [ ] Write a failing test: a fragment whose body contains a repo-rooted
      `packages/api/src/x.ts` entry, story `workdir: "packages/api"` — assert
      the rendered body keeps the repo-rooted spelling (currently FAILS: the
      reframe strips the prefix to `src/x.ts`).
- [ ] Run it; confirm FAIL with the package-relative spelling in the diff.
- [ ] Implement: at `feature-context.ts:389`, use `rawBody` directly
      (`const body = rawBody;` folded into the later uses), delete the
      `reframeFilesTouched` import (:24) and the now-stale reframe comment
      block above the call — keep budget measurement on the same string it
      renders. Do NOT delete `reframe.ts` itself (PR 4).
- [ ] Run the test; confirm PASS. `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(context): stop package-reframing fragment files-touched lists`.

## Task 4 — Rewrite `agent-scope.ts`

**Files:** `src/prompts/sections/agent-scope.ts` (77 lines, verified, read in full)

**Interfaces:**
- Consumes: Task 1 (root===repoRoot post-move).
- Produces: `buildAgentScopeSection(root, repoRoot, workdirLabel)` — new
  3rd parameter.

**Steps:**

- [ ] Find every call site of `buildAgentScopeSection` (`grep -rn buildAgentScopeSection src/`)
      — expect `src/agents/tool-preamble.ts` per the existing doc comment at
      line 22-25 of the current file. Read that call site in full before
      editing.
- [ ] Write a failing test in `test/unit/prompts/agent-scope.test.ts`
      (existing file, confirmed present): for a package story
      (`root = "/repo"`, `repoRoot = "/repo"`, `workdirLabel = "packages/api"`),
      the rendered section must say tools are rooted at the **repository
      root**, name `packages/api` as "your package" (not "your tool root"),
      instruct repo-rooted spelling (`packages/api/src/index.ts`, not
      `src/index.ts`), and say declared commands run inside the package. For a
      repo-root story (`workdirLabel = "."` or `undefined`), it must say tools
      are rooted at the repo root with no package distinction. Render and
      assert on exact substrings — per the render-and-read rule. Run; confirm
      FAIL (current function doesn't accept a third param and says the
      opposite: "tools rooted at `<package>`, spell relative to it").
- [ ] Implement: rewrite the exported function. Keep `packageLabel` and the
      `WORKTREE_DIR` stripping logic AS-IS (spec: "don't delete packageLabel
      logic yet") — it is now inert in production (post-move `root === repoRoot`,
      so `packageLabel` always returns `""`), but it stays wired so PR 4 can
      delete it as one unit rather than half-deleting it here. New body:
      ```ts
      export function buildAgentScopeSection(
        root: string | undefined,
        repoRoot: string | undefined,
        workdirLabel: string | undefined,
      ): string | undefined {
        if (root === undefined || root.trim() === "") return undefined;
        // Post-single-frame-redesign, root and repoRoot are always equal —
        // packageLabel(root, repoRoot) always returns "". workdirLabel (the
        // story's package-relative workdir, "." at the repo root) is the new
        // source of "which package is this story in", threaded from the
        // caller rather than derived from a root/repoRoot difference that no
        // longer exists. See packageLabel's docblock for why it stays wired
        // rather than deleted (PR 4 retires it alongside codingToolRepoRoot).
        const label = packageLabel(root, repoRoot);
        void label; // retained call for PR 4's single-unit deletion; not rendered

        const isRepoRootStory = workdirLabel === undefined || workdirLabel === "." || workdirLabel.trim() === "";

        if (isRepoRootStory) {
          return [
            "## Your file scope",
            "",
            "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root.",
            "Every path you pass them is resolved from there.",
          ].join("\n");
        }

        return [
          "## Your file scope",
          "",
          "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root, NOT at your package.",
          `Your story's package is \`${workdirLabel}\`. Spell every path repo-rooted from the repository root: write`,
          `\`${workdirLabel}/src/index.ts\`, never \`src/index.ts\`.`,
          "",
          `Declared commands (via RunCommand) still run inside \`${workdirLabel}\` — only the file tools' path frame changed.`,
          "You can read and, per your write authorization, edit files outside your package if a task genuinely requires it — say so rather than guessing at another package's contents from its name alone.",
        ].join("\n");
      }
      ```
      `void label;` is a deliberate placeholder to keep `packageLabel` called
      (and therefore not flagged unused by lint) without rendering its
      now-always-empty result — remove this the moment PR 4 deletes
      `packageLabel` itself; do not leave `void label;` in the codebase beyond
      this arc.
- [ ] Update the call site in `src/agents/tool-preamble.ts` to pass the third
      argument. Determine what value it should thread — the story's
      `storyWorkdir(story)` if the story is in scope at that call site, else
      trace up the caller chain until you find where the story is available
      and thread `storyWorkdir(story)` down. Read the call site's existing
      signature and its own tests before changing it; if `tool-preamble.ts` is
      itself protocol-agnostic and pure (no story object today), add the new
      parameter to ITS signature too and update ITS callers, recursively,
      until you reach a call site that has the `UserStory` — do not invent a
      workdir value from `root`/`repoRoot` since those are now identical and
      carry no package information.
- [ ] Run the agent-scope test; confirm PASS. Run the full test suite for
      `tool-preamble` and any file changed in the threading chain.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(prompts): rewrite agent-scope for repo-rooted containment`.

## Task 5 — Reword the acceptance path-anchor paragraph

**Files:** `src/prompts/builders/acceptance-builder.ts:195` (verified)

**Interfaces:** none (prose-only change; no signature change).

**Steps:**

- [ ] Write a failing test (locate/extend
      `test/unit/prompts/builders/acceptance-builder.test.ts` or equivalent):
      call `buildGeneratorFromPRDPrompt` with a package-story
      `targetTestFilePath` and assert the rendered prompt does **not** contain
      the phrase `"3 levels above"` (or `"../../../"` as package-containment
      framing) — assert instead that it does not instruct the agent to derive
      the package root by walking up from the test file. Run; confirm FAIL
      (current text contains exactly that phrase).
- [ ] Implement: in `buildGeneratorFromPRDPrompt`, replace the sentence:
      > `The package root is 3 levels above the test file (`../../../` relative to the test file).`
      and the "Process cwd" sentence that computes
      `join(import.meta.dir, "../../..")`, with repo-rooted framing. Since the
      agent's tools are now rooted at the repo root (Task 1), the agent does
      not need to walk UP from the test file to find the package root at all
      — it can address the package directly by its repo-rooted path. New text
      (edit the template literal at lines ~194-196):
      ```
      - **Path anchor (CRITICAL — do NOT deviate)**: Write the test file to this exact path: `${p.targetTestFilePath}`. This path is repo-rooted and computed by the orchestrator — do not change it based on what you observe in the project. When a story belongs to a specific package (e.g. `packages/core`), its acceptance test lives inside that package's own `.nax/features/` directory so the test runner can resolve the package's imports correctly.
      - **Process cwd**: When spawning child processes to invoke a CLI or binary, set the working directory to the package's own root — the directory containing that package's manifest (e.g. `package.json`, `go.mod`) — as your default, unless your Step 2 exploration reveals the CLI uses a different working directory convention (e.g. reads config from `~/.config/`, or resolves paths relative to a flag value). Always check how the CLI resolves file paths before assuming.${implSection}
      ```
      Keep the rest of the template (STEP1/STEP2/STEP3 constants, the
      `frameworkLine`/`implSection` interpolation) untouched.
- [ ] Run the test; confirm PASS.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(prompts): reword acceptance path-anchor out of package-containment terms`.

## Task 6 — Remove native Git tool's auto-`--relative`

**Files:** `src/tools/git.ts:41-57,226` (verified, read in full)

**Interfaces:** `buildGitArgv(input)` unchanged signature; no longer pushes `--relative`.

**Steps:**

- [ ] Write a failing test in `test/unit/tools/git.test.ts` (locate/confirm
      existing tests for `buildGitArgv`): `buildGitArgv({ subcommand: "diff" })`
      must NOT contain `"--relative"` in the returned argv. Run; confirm FAIL.
- [ ] Implement: delete the line `if (GIT_RELATIVE_VERBS.includes(subcommand)) argv.push("--relative");`
      at line 226, and delete the now-unused `GIT_RELATIVE_VERBS` constant
      (lines 41-57) — but first grep the whole file and `test/unit/tools/git*.ts`
      for any other reference to `GIT_RELATIVE_VERBS`; if none, delete cleanly,
      else keep it and only remove the `argv.push` call site.
- [ ] Run the test; confirm PASS.
- [ ] Search `test/unit/tools/git*.ts` for any existing assertion that
      expects `--relative` in a diff/log/show argv (there will be some, since
      this was the tool's documented behavior) — update those to assert its
      ABSENCE instead, with a comment citing this PR. Do not leave a stale
      assertion asserting the old behavior; that would be a vacuous pass on a
      different code path if the test also happens to check something else.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `fix(tools): stop injecting --relative into native Git tool argv (repo-rooted cwd)`.

## Task 7 — Remove prompt-embedded `--relative`, scope story-diff pathspecs

**Files:** `src/prompts/builders/review-builder.ts:332-349` (verified),
`src/prompts/builders/adversarial-review-builder.ts:260-306` (verified),
`src/prompts/builders/debate-builder.ts:420-459` (verified)

**Interfaces:**
- Produces: `buildRefDiffSection(storyGitRef, stat, excludePatterns, pathspec)` (new 4th param, review-builder.ts's private helper), the equivalent private helper in adversarial-review-builder.ts gains `pathspec`, `buildDebateDiffSection(ctx)` — add `pathspec` to its `DiffContext` type instead of a bare param (keeps the existing single-object-arg shape).
- Consumes: caller-supplied `pathspec: string` — the story's repo-relative package dir (e.g. `"packages/api"`) or `"."` for a repo-root story. Compute via `storyWorkdir(story)` (already imported in `src/utils/path-frame.ts`) at each public builder method's call site and thread it down to the private helper.

**Rationale (confirm before editing):** these three files' diff-section
strings are the **ACP-arm** rendering — the model runs the shell command
itself, in its ACP session cwd. Post Task 1, that cwd is the repo root, so (a)
`--relative` must go (git already prints repo-rooted paths from a repo-root
cwd — keeping it would now invert into printing paths relative to the WRONG
directory if the reviewer `cd`s, though from the initial cwd it would be a
no-op; removing it matches the native tool's Task 6 change and the
spec's explicit instruction) and (b) the bare `-- .` pathspec, which used to
mean "this package" when cwd was the package dir, now means "the whole repo"
— the review would see cross-package noise. Replace `-- .` with
`-- ${pathspec}` so the diff command stays scoped to the story's package even
though the agent's cwd is now the repo root.

**Steps:**

- [ ] Write a failing test for each of the three builders (locate/extend
      `test/unit/prompts/builders/review-builder.test.ts`,
      `adversarial-review-builder.test.ts`, `debate-builder.test.ts`): render
      the "ref" / self-serve diff section for a package story
      (`storyGitRef = "abc123"`, package `"packages/api"`) and assert the
      rendered text (a) contains no `--relative` and (b) contains
      `-- packages/api` (not `-- .`) in every `git diff`/`git log --name-only`
      command line. Also render for a repo-root story and assert it still
      produces `-- .` there (no regression for the single-package case). Run
      all three; confirm FAIL (current code always emits `--relative` and
      always `-- .`).
- [ ] Implement in `review-builder.ts`: change `buildRefDiffSection`'s
      signature to accept a `pathspec: string` parameter; replace
      `` `git diff --relative --unified=3 ${storyGitRef}..HEAD -- . ${excludeArgs}` ``
      with
      `` `git diff --unified=3 ${storyGitRef}..HEAD -- ${pathspec} ${excludeArgs}` ``
      (and the same for `fullDiffCmd`). `logCmd` (`git log --oneline ...`)
      needs no pathspec — `log` with no pathspec already only follows `HEAD`'s
      history, and the file already notes `--relative` was inert there. Update
      the doc comment above (lines 341-347) to describe the new repo-rooted,
      pathspec-scoped rendering instead of the old package-cwd rationale.
      Update the (presumably one) public call site inside the class that
      calls this private helper, threading `pathspec` from its own caller.
- [ ] Trace `ReviewPromptBuilder`'s public method up to its pipeline-stage
      caller (grep `new ReviewPromptBuilder()` / the barrel export usage) and
      thread `storyWorkdir(story)` (or `"."` fallback) as the new `pathspec`
      argument at that call site — the story object is in scope there.
- [ ] Repeat the same shape of change in `adversarial-review-builder.ts`
      (three `-- .` occurrences at what are currently lines 289, 295, 302, 306
      after the `--relative` removal shifts nothing on those specific lines
      since removal is same-line) and in `debate-builder.ts`'s
      `buildDebateDiffSection` (add `pathspec` to its `DiffContext` type,
      thread through the two `-- .` occurrences at current lines 458-459).
- [ ] For each file, thread the new parameter from that builder's public
      entry point up to its real pipeline-stage caller the same way as
      review-builder.ts.
- [ ] Run all three new/updated tests; confirm PASS.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `fix(prompts): scope ACP-arm diff commands to the story package, drop --relative`.

## Task 8 — Consolidate diff-utils.ts subprocess collectors; audit scoped-lint.ts

**Files:** `src/review/diff-utils.ts:112-140` (`collectDiff`), `:147-166`
(`collectDiffStat`), `:255-268` (`computeTestInventory` git call), `:314-325`
(`collectDiffFileList`, the no-`--relative` reference shape) — all verified,
read in full. `src/review/scoped-lint.ts:75-92` (verified, read in full).

**Interfaces:** `collectDiff`, `collectDiffStat`, `computeTestInventory` keep
their existing signatures (`workdir` stays the package-dir cwd these
subprocess collectors already ran at — this task does NOT touch that cwd,
only the `--relative` flag, because with `--relative` removed a bare `-- .`
pathspec still correctly scopes to `workdir`'s cwd; verified by reading
`prepare-inputs.ts`'s callers, which pass `ctx.workdir`, a value untouched by
Task 1's agent-root move).

**Steps:**

- [ ] Write failing tests in `test/unit/review/diff-utils.test.ts` (existing
      file — extend it): for `collectDiff`, `collectDiffStat`, and
      `computeTestInventory`, assert the constructed git argv (spy/capture via
      the existing `_diffUtilsDeps`/`runGitWithTimeout` injection seam, or by
      asserting on the actual subprocess call if the test already runs real
      git against a fixture repo) does **not** include `"--relative"`. Mirror
      whatever pattern the file's existing tests already use for asserting
      argv shape (check `git diff --name-only` tests for `collectDiffFileList`
      as the reference — it already has no `--relative` and presumably already
      has a passing assertion of this shape you can copy). Run; confirm FAIL
      for the three functions that still push `--relative`.
- [ ] Implement: remove `"--relative"` from the three `runGitWithTimeout`
      argv arrays in `collectDiff` (line ~127), `collectDiffStat` (line
      ~154), and `computeTestInventory` (line ~262). Update the doc comments
      above each (lines 121-127, 150-153, and the inline comment near
      `computeTestInventory`'s git call) that currently justify `--relative`
      via "the reviewer's file tools are rooted at the package dir" — replace
      with a note that these three now share `collectDiffFileList`'s
      no-`--relative` convention because the agent's tools are repo-rooted
      post-single-frame-redesign, and the collector's own cwd (`workdir`,
      still the package dir) is what scopes the bare `-- .` pathspec, exactly
      as `collectDiffFileList` already relied on before this change.
- [ ] Consider extracting the shared argv-building shape (`["git", "diff", ...flags, `${ref}..HEAD`, "--", ".", ...merged]`)
      into one private helper function in the same file if doing so does not
      push `diff-utils.ts` over its size — check `wc -l src/review/diff-utils.ts`
      before and after; the spec explicitly asks for consolidation ("rather
      than re-reason four functions") but the file is currently 332 lines with
      headroom to 600, so a small shared builder is safe. Do NOT extract into
      a new file just for this — it is a same-file simplification, not a new
      module.
- [ ] Audit `src/review/scoped-lint.ts:75-92`'s `listChangedFiles`: it also
      passes `"--relative"` in its `gitWithTimeout` argv (confirmed at read
      time — comment at lines 76-84 explains the SAME rationale, package cwd
      double-prefixing via `filterFilesToScope`'s `join(workdir, relPath)`).
      Determine whether `workdir` here is the package dir (pipeline
      `ctx.workdir`, unaffected by Task 1) — if so, the SAME reasoning as
      diff-utils.ts applies: removing `--relative` and keeping the bare
      pathspec default (no explicit `"--"`/pathspec argument is passed here
      today, confirm by reading the full argv construction) still scopes
      correctly because `workdir` (the cwd) hasn't changed. Write a failing
      test in `test/unit/review/scoped-lint.test.ts` (locate it) asserting no
      `--relative` in the constructed argv; implement the removal; update the
      doc comment at lines 76-84 to state the corrected rationale (git already
      emits repo-root-relative paths, and `filterFilesToScope`'s
      `join(workdir, relPath)` needs `relPath` to be relative to `workdir`,
      not the repo root — re-derive `relPath` via `relative(workdir, ...)`
      composition if removing `--relative` changes what git actually prints;
      **verify this carefully by tracing `filterFilesToScope`'s full body**
      before touching this file, since scoped-lint.ts's correctness depends
      on the SHAPE of the path git emits, not just whether the flag existed —
      if `workdir` here is ever the repo root for a repo-root story, git's
      default (repo-root-relative, no `--relative` needed) already matches
      what `filterFilesToScope` expects, but for a PACKAGE story reading
      `join(workdir, relPath)` with a repo-root-relative `relPath` would
      double-scope incorrectly — resolve this by threading the SAME
      `--relative`-equivalent behavior git already provides for a
      package-cwd subprocess call: since `--relative` alone (with no arg)
      means "relative to cwd", and cwd here is still `workdir` — REMOVING it
      makes git print repo-root-relative paths while `workdir` is still the
      package dir, breaking `filterFilesToScope`'s `join`. **This is the one
      site in this task where removing `--relative` is NOT a safe mechanical
      consolidation** — `scoped-lint.ts`'s cwd (`workdir`) and its consumer's
      expected path frame (package-relative, for the `join`) are still
      coupled the OLD way, unlike diff-utils.ts's collectors which only ever
      compare/report the pathspec, never re-join it onto `workdir`. KEEP
      `--relative` in `scoped-lint.ts` and instead correct only the doc
      comment to state explicitly why this ONE site is exempt from the
      consolidation (its consumer does a path join that requires the
      package-relative frame `--relative` produces) — write this as the
      test's actual assertion (assert `--relative` IS still present, with a
      comment citing the join-consumer reason) rather than removing it.
- [ ] Run all tests; confirm PASS (including the scoped-lint.ts test that now
      pins `--relative` is intentionally RETAINED there).
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `refactor(review): consolidate diff-utils collectors onto no---relative convention`.

## Task 9 — MCP pool: one connection per worktree (test only, verify the collapse)

**Files:** `src/mcp/pool.ts` (217 lines, verified, read in full — no source
change expected, this task is a regression test pinning the FIX Task 1
produces as a side effect).

**Interfaces:** `createMcpPool(opts).call/listTools(serverId, workdir, ...)` unchanged.

**Steps:**

- [ ] Confirm the caller of `entry(serverId, workdir)` / `pool.call(serverId, workdir, ...)`
      (grep `mcpPool.call\|createMcpPool` in `src/` outside `mcp/`) passes
      `workdir` sourced from the same value Task 1 changed
      (`codingToolRoot`/`ctx.packageDir`-derived) — read that call site before
      writing the test, to confirm the collapse actually reaches the pool.
- [ ] Write a failing (well — this test should ALREADY pass numerically once
      Task 1 lands, since the pool code itself needs no change; write it as a
      regression pin, and if it unexpectedly still fails after Task 1, that
      means the pool's `workdir` caller was NOT updated by Task 1 and needs a
      follow-up fix here) test in `test/unit/mcp/pool.test.ts` (existing file
      — extend): construct a pool with a fake `connectMcpServer` that counts
      invocations. Call `pool.listTools("codebase-memory-mcp", workdirA)` and
      `pool.listTools("codebase-memory-mcp", workdirB)` where `workdirA` and
      `workdirB` are two DIFFERENT package dirs (`/repo/packages/api`,
      `/repo/packages/web`) that share the SAME `storyExecRoot`
      (`/repo`, i.e. simulate two stories/packages in the same worktree).
      Prior to Task 1, this created TWO connections (package-dir-keyed).
      Post-Task-1, the caller passes `storyExecRoot` as `workdir`
      (confirmed by the trace above) so both calls use the SAME key and the
      fake connector must be invoked exactly ONCE. Assert
      `connectMcpServer` call count === 1.
- [ ] Run it. If it fails (Task 1's collapse did not actually reach this
      call site — e.g. the MCP pool caller reads `ctx.packageDir` directly
      rather than `codingToolRoot`), trace the real call site and either (a)
      confirm it already reads a value Task 1 changed and the test has a bug,
      or (b) fix the call site to read the post-move root value, whichever is
      true. Do not mark this task done on a passing test that isn't actually
      exercising the collapse — cross-check by temporarily reverting Task 1's
      `call.ts` change locally and confirming this new test FAILS, then
      restore Task 1's change.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `test(mcp): pin one-connection-per-worktree collapse post-root-move`.

## Task 10 — Exec `packageRelPath` must not collapse without an explicit package workdir

**Files:** `src/agents/coding-tool-support.ts:170-194` (verified, read in
full), `src/tools/run-command-exec.ts:45-76` (verified, read in full),
`src/tools/package-managers.ts:339-401` (verified — `normalizeExec`,
`effectiveTarget` collapse at line 366), `src/agents/types.ts:175-224`
(verified, read in full).

**Interfaces:**
- Consumes: Task 1 (root/repoRoot now equal);
  `AgentRunOptions.codingToolPackageDir?: string` from PR 1 (already
  populated by `buildRunDispatchOptions` in
  `src/operations/call-run-options.ts` — NO new AgentRunOptions field and NO
  call.ts change is needed in this task).
- Produces: `buildCodingToolSupport(args)` gains `packageWorkdir?: string`
  (falls back to `args.root` when absent, for callers/tests that don't pass
  it — but production call sites always will after this task).

**Bug being fixed:** `resolveCodingToolSupport` currently calls
`buildCodingToolSupport({ root: options.codingToolRoot, repoRoot: options.codingToolRepoRoot, ... })`,
and inside `buildCodingToolSupport`, the Exec options are built as
`{ repoRoot: args.repoRoot ?? args.root, packageWorkdir: args.root, ... }`
(line 179-180). Pre-Task-1, `args.root` was the package dir, so
`packageWorkdir: args.root` was correct. Post-Task-1, `args.root` is the repo
root, so `packageWorkdir` would ALSO become the repo root — and
`run-command-exec.ts:66`'s `packageRelPath = relative(opts.exec.repoRoot, opts.exec.packageWorkdir)`
would always compute `""`, which `package-managers.ts:366`'s
`effectiveTarget: ExecTarget = packageRelPath === "" ? "repoRoot" : target;`
treats as "this story IS the repo root" — collapsing EVERY Exec call
(`target: "package"` requests included) onto the repo root, silently, for
every monorepo package story. This is exactly the spec's named risk.

**Steps:**

- [ ] Write a failing test in `test/unit/tools/run-command-exec.test.ts`
      (existing file — extend) or `test/unit/agents/coding-tool-support.test.ts`
      (whichever already exercises `buildCodingToolSupport`'s Exec wiring —
      locate first): construct `buildCodingToolSupport` args simulating
      POST-Task-1 production values (`root: "/repo"`, `repoRoot: "/repo"`,
      i.e. already collapsed) for a package story, WITHOUT the new
      `packageWorkdir` field, and confirm the current code's `Exec`
      options resolve `packageRelPath` to `""` and `target: "package"`
      collapses to `cwd: "/repo"` (the bug, reproduced). Then add the new
      `packageWorkdir: "/repo/packages/api"` field and assert
      `target: "package"` now resolves `cwd: "/repo/packages/api"` while
      `target: "repoRoot"` still resolves `cwd: "/repo"` — i.e. the two
      targets stay distinguishable. Run; confirm the first assertion PASSES
      today (pinning the live bug) and the second FAILS (field doesn't exist
      yet) — this satisfies "tests must fail before implementation" for the
      fix half while also documenting the bug being fixed.
- [ ] Implement, `src/agents/coding-tool-support.ts`: add a `packageWorkdir?: string`
      field to `buildCodingToolSupport`'s `args` object type (near `repoRoot`,
      line ~61) with a doc comment stating the invariant: post-root-move
      `codingToolRoot`/`codingToolRepoRoot` are equal (both `storyExecRoot`),
      so Exec's `packageWorkdir` can no longer be derived from `args.root` —
      doing so collapses every Exec target to the repo root (`packageRelPath`
      always `""`). Change line 180 from `packageWorkdir: args.root,` to
      `packageWorkdir: args.packageWorkdir ?? args.root,` — the fallback keeps
      existing callers/tests that only pass `root` working (single-package
      repos where root === package dir anyway, and any test fixture that
      hasn't been updated).
- [ ] In `resolveCodingToolSupport` (same file, the `buildCodingToolSupport({...})`
      call at the end of the function), add
      `...(options.codingToolPackageDir !== undefined ? { packageWorkdir: options.codingToolPackageDir } : {}),`
      to the passed object. `codingToolPackageDir` already exists on
      `AgentRunOptions` (PR 1) and is already populated by
      `buildRunDispatchOptions` (`src/operations/call-run-options.ts`) — no
      `src/agents/types.ts` or `src/operations/call.ts` change in this task.
      If the `Pick<AgentRunOptions, ...>` type at the top of
      `resolveCodingToolSupport`'s signature does not already include
      `"codingToolPackageDir"` after PR 1, add it there.
- [ ] Run the failing test from step 1; confirm the second assertion now
      PASSES.
- [ ] `bun run typecheck` — check `wc -l src/agents/coding-tool-support.ts`
      stays under 600 (currently 421, ample headroom) and
      `src/operations/call.ts` stays at or under its Task-0-recorded ceiling
      (one new line: check whether this pushes it over 600 — if so, this is
      the file the "extract new logic into new leaf modules" constraint
      applies to; extract the `runOptions` object assembly's Exec-specific
      fields into a small helper in `src/operations/call-resolvers.ts`
      (already imported, already the home for extracted call.ts logic) rather
      than adding an inline line to the 600-line file).
- [ ] `bun run lint`.
- [ ] `git commit` — `fix(tools): thread package workdir independently of the collapsed containment root for Exec`.

## Task 11 — Verifier verdict handshake: write and read the same root

**Files:** `src/operations/verify.ts:8,195-196,220,276,284` (verified, read in full).

**Interfaces:** `resolveAbsolutePackageDir(ctx)` — same name, body changes
from `packageWorkdir(ctx.packageView)` to `storyExecRoot(ctx.packageView)`.

**Bug being fixed:** `verifierOp`'s `toolPatterns: { Write: [VERDICT_FILE] }`
(line 220) scopes the agent's Write grant to the relative filename
`.nax-verifier-verdict.json`, resolved against the agent's ACTUAL tool root —
which post-Task-1 is `storyExecRoot`. `recover()`'s disk-recovery read (line
284, via `resolveAbsolutePackageDir`) currently reads from
`packageWorkdir(ctx.packageView)` — the OLD root. Post-Task-1 these two values
diverge for any package story, so the verdict file the agent actually wrote
(at the repo/worktree root) is never found by the recovery read (still
looking in the package dir) — every unparseable-stdout recovery for a
monorepo verifier silently fails closed instead of finding the real verdict.

**Steps:**

- [ ] Write a failing test in `test/unit/operations/verify.test.ts` (existing
      file — extend): construct a `VerifyContext` with a package
      `packageView` (`packageDir: "packages/api"`, `repoRoot: "/repo"`), write
      a fake verdict file via `Bun.write` at
      `storyExecRoot(packageView) + "/.nax-verifier-verdict.json"` (i.e.
      `/repo/.nax-verifier-verdict.json`, NOT `/repo/packages/api/...`), then
      invoke `verifierOp.recover(input, verifyCtx)` and assert it returns the
      verdict from that file (not the fail-closed path). Run; confirm FAIL
      against current code (which looks in `/repo/packages/api/`).
- [ ] Implement: in `src/operations/verify.ts`, change the import at line 8
      from `packageWorkdir` to `storyExecRoot` (`import { storyExecRoot } from "../runtime/packages";`),
      and change `resolveAbsolutePackageDir`'s body (around line 195) from
      `return packageWorkdir(ctx.packageView);` to
      `return storyExecRoot(ctx.packageView);`. Update the function's doc
      comment (the paragraph immediately above it, describing why it joins
      onto the package view) to explain it now returns the agent's ACTUAL
      Write root post-single-frame-redesign, not the package dir — the
      function's NAME (`resolveAbsolutePackageDir`) is now slightly
      misleading; leave the name as-is in this PR (a rename ripples through
      every call site and isn't required by the spec) but flag the mismatch
      explicitly in the updated comment so a future reader isn't confused, and
      leave a one-line TODO-style note (not a TODO comment per project
      convention against orphaned TODOs — instead a factual doc sentence)
      that PR 4 or a follow-up may rename it to `resolveVerifierWriteRoot`.
- [ ] Check every OTHER call site of `resolveAbsolutePackageDir` in this file
      (grep it — the isolation check near the top of the file, confirmed
      referenced at line ~183) — confirm `verifyImplementerIsolation` also
      wants the write-root value now (it almost certainly does: isolation
      checks what the agent actually touched, and the agent's tools are
      rooted at `storyExecRoot` too) rather than needing a SEPARATE
      package-dir-scoped value. If isolation genuinely needs the narrower
      package dir for some other reason (re-read its own logic before
      assuming), do not silently share this rename — split into two
      differently-named helpers instead.
- [ ] Run the test; confirm PASS.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `fix(operations): read the verifier verdict from the same root the agent writes it to`.

## Task 12 — Story-diff pathspec scoping (covered by Task 7)

This checklist item ("Git tool default pathspec `.` now means the whole
repo — scope story-diff sites by the story's workdir pathspec explicitly")
is satisfied by Task 7's pathspec threading into the three ACP-arm prompt
builders — those are the only "story-diff" sites that rely on an implicit
`.` default reaching the Git tool or a shell `git diff` at the agent's cwd
(confirmed by Task 0-time grep: no internal, non-agent-authored call site
builds `Git`-tool argv for a story diff — `buildGitArgv`'s only production
callers are the tool registration itself and `git-commit.ts`, neither of
which is a story-diff site). No separate task; this line exists so the
checklist is traceable 1:1 against the spec text.

- [ ] Confirm during Task 7's implementation that no additional call site
      was missed: re-run `grep -rn "git diff\|git log" src/prompts/ src/review/ src/pipeline/`
      after Task 7 lands and confirm every match either (a) has an explicit
      pathspec now, (b) is a subprocess collector already cwd-scoped
      correctly (Task 8), or (c) is `git log --oneline` / `blame`, which take
      no pathspec by design.

## Task 13 — Retire `execTouchedPaths` carve-out in `policy.ts`

**Files:** `src/tools/policy.ts` (full file read for the containment/carve-out
sections: header doc comment, `resolveWithin` at lines ~60-105, the
`execTouchedPaths` option threading at lines 118-120, 158, 386, 472, 498, 519,
545 — verified via grep), `src/agents/coding-tool-support.ts:149-164`
(verified — where `execTouchedPaths` array is constructed and passed into
`compileToolPolicy`), `src/tools/run-command-exec.ts:96-118` (verified — the
carve-out's WRITE side, `recordExecTouchedPaths`).

**Interfaces:** `resolveWithin(root, candidate)` — drops its third
`execTouchedPaths` parameter. `compileToolPolicy`'s options type drops
`execTouchedPaths`. `buildCodingToolSupport`/`resolveCodingToolSupport` stop
threading an `execTouchedPaths` array into `compileToolPolicy` (the array
construction and its pass-through to `RunCommandExecOptions.touchedPaths` for
`recordExecTouchedPaths`'s bookkeeping MAY stay if GitCommit no longer needs
it read back — confirm by tracing whether anything OTHER than
`resolveWithin`'s carve-out consumes the array before deciding whether to
delete the whole `execTouchedPaths` plumbing or just its `resolveWithin`
consumption).

**Rationale:** the carve-out exists because a workspace package manager's
install writes the repo-ROOT manifest/lockfile even when the Exec call's own
target/cwd was the PACKAGE dir — outside the (pre-move) containment root, so
`resolveWithin` needed an explicit, narrowly-scoped exception to let a
following `GitCommit` stage that root manifest. Post-Task-1, the containment
root IS the repo root — the root manifest is now INSIDE the root by
construction, and `resolveWithin`'s ordinary `isInside` check admits it
without any carve-out.

**Steps:**

- [ ] Read `resolveWithin`'s full doc comment (lines ~1-33 of the section
      above it) again in this task's context — it explicitly says "The one
      exception... is not a profile widening" and documents exactly why it
      exists; confirm the reasoning above by re-deriving it from that comment
      rather than only from the spec's one-line summary.
- [ ] Write a failing test in `test/unit/tools/policy.test.ts` (existing
      file, confirmed present) or a new one specifically for this behavior:
      construct a `compileToolPolicy` WITHOUT passing `execTouchedPaths` at
      all (post-fix shape), with `root` set to a repo root, and confirm a
      `GitCommit`-shaped call staging the repo-root manifest path (e.g.
      `package.json` at `root` itself) is ADMITTED by `resolveWithin`'s
      ordinary `isInside` check alone — no carve-out array needed. This test
      should PASS today too (root-relative `isInside` already admits a path
      directly inside `root`), which is expected — it pins the POST-DELETION
      invariant, not a currently-failing behavior. Write a SECOND assertion
      that specifically exercises what the carve-out used to be needed for:
      call `resolveWithin(root, candidate)` (the 2-arg post-deletion
      signature) with a `candidate` that is genuinely OUTSIDE `root` (e.g. a
      sibling directory) and confirm it is REFUSED (`null`) — i.e. the
      carve-out's removal did not silently widen containment for a path that
      is actually outside the (now repo-root) root. This second assertion is
      the one that must FAIL if you (incorrectly) left the carve-out logic in
      place while only changing its signature — run both before implementing,
      confirm the second one currently requires 3 args to even compile
      (TypeScript error), which counts as the required FAIL checkpoint for a
      signature change.
- [ ] Implement: in `src/tools/policy.ts`, change `resolveWithin`'s signature
      from `(root: string, candidate: string, execTouchedPaths?: readonly string[])`
      to `(root: string, candidate: string)`, delete the
      `if (execTouchedPaths?.some(...)) return resolved;` fallback branch
      (keep the `return null;` that follows it as the function's final
      return). Delete the `readonly execTouchedPaths?: readonly string[];`
      option field near line 120 and its resolution at line 158
      (`const execTouchedPaths = options?.execTouchedPaths;`). Update every
      one of the 5 call sites (lines ~386, 472, 498, 519, 545 per the earlier
      grep) to drop the trailing `execTouchedPaths` argument. Update the
      function's doc comment to remove the "one exception" paragraph (lines
      ~17-31) — replace with a short note that this carve-out existed pre
      single-frame-redesign and was retired once the containment root became
      the repo root, making the manifest write ordinarily in-root.
- [ ] Trace whether `execTouchedPaths` (the array itself, built in
      `coding-tool-support.ts:157` and passed to
      `RunCommandExecOptions.touchedPaths` in `run-command-exec.ts`) has any
      OTHER consumer besides feeding `compileToolPolicy`'s now-deleted option.
      If `recordExecTouchedPaths`'s only purpose was ever to feed this
      carve-out, remove the array construction and its threading through
      `coding-tool-support.ts` and `run-command-exec.ts`'s
      `RunCommandExecOptions.touchedPaths`/`recordExecTouchedPaths`/
      `snapshotExecTouchedPaths` machinery too — but ONLY if you have
      confirmed via grep that nothing else reads it; if something else does
      (e.g. a future audit/ledger use), leave the array plumbing intact and
      only remove `compileToolPolicy`'s consumption of it. Document which
      case applies in the commit message.
- [ ] Run both tests from step 2; confirm the second now PASSES (with the
      correct 2-arg signature, containment still refuses genuinely
      out-of-root paths).
- [ ] Run the FULL `test/unit/tools/policy.test.ts` and
      `test/unit/tools/policy-bash.test.ts` suites — this is the
      root-parameterized containment suite the Global Constraints call out;
      confirm it survives verbatim (no test file edits required there unless
      a test explicitly asserted the carve-out's old behavior, in which case
      update ONLY that specific assertion with a comment citing this PR).
- [ ] `bun run typecheck && bun run lint` — confirm `wc -l src/tools/policy.ts`
      DECREASED from its Task-0-recorded baseline (this task is a deletion).
- [ ] `git commit` — `refactor(tools): retire the execTouchedPaths containment carve-out (root move makes it redundant)`.

## Task 14 — acceptance-setup.ts: pin main-checkout `packages.resolve` and in-root `targetTestFilePath`

**Files:** `src/pipeline/stages/acceptance-setup.ts:175-205` (verified, read
in full — the `callOp` closure), `:390-420` (verified — `targetTestFilePath`
construction and the generator dispatch).

**Interfaces:** none changed — this task is a regression test confirming Task
1 did NOT reach this file's `packages.resolve(packageDir)` call (it must keep
receiving the pre-run stage's own `packageDir`, sourced from the main
checkout, never a worktree path — acceptance-setup runs after all stories'
worktrees have already been merged/cleaned up).

**Steps:**

- [ ] Trace `runAcceptanceSetup`'s call chain to confirm `packageDir` passed
      into the local `callOp` closure (line 177) is always a main-checkout
      absolute path (read the code between `runAcceptanceSetup`'s start and
      wherever it calls `_acceptanceSetupDeps.callOp` — likely via
      `group.packageDir` sourced from `discoverWorkspacePackages`/config, not
      from any worktree-scoped runtime state). Confirm nothing this PR
      touched (Task 1's `call.ts` changes) affects this file — `callOp` here
      is `acceptanceSetupStage`'s OWN local closure (`_callOp` imported from
      `@/operations`, i.e. the SAME `callOp` Task 1 modified), so its
      `codingToolRoot`/ACP-cwd derivation DOES go through Task 1's new
      `storyExecRoot(ctx.packageView)` logic — but `packageView` here is
      built via `pipelineCtx.runtime.packages.resolve(packageDir)` at line
      191, and post-run acceptance sessions are NOT worktree-isolated (worktrees
      are per-story, cleaned up before the post-run acceptance phase runs),
      so `storyExecRoot(packageView)` should equal `packageView.repoRoot`
      (main checkout) for these sessions regardless of Task 1 — confirm this
      by reading `storyExecRoot`'s body again: it only diverges from
      `repoRoot` when `packageDir` starts with `.nax-wt/`, and this
      `packageDir` (line 177, `group.packageDir`) never does for a post-run
      acceptance-gen/refine session.
- [ ] Write a regression test in `test/unit/pipeline/stages/acceptance-setup.test.ts`
      (existing file — extend): call the exported `callOp` (or the module's
      test seam for it) with a package `packageDir` that is an absolute
      main-checkout path, and assert the `CallContext` it builds/dispatches
      resolves `codingToolRoot`/ACP `workdir` to that SAME main-checkout path
      (not a worktree path, not accidentally the repo root when the story is
      package-scoped, matching the package dir since acceptance sessions ARE
      single-package-contained by design — re-confirm this against the spec:
      acceptance-gen/refine agent sessions are NOT covered by the "agent
      rooted at repo root" change in a way that breaks them, since
      `packages.resolve(packageDir)` for a non-worktree run makes
      `storyExecRoot(packageView) === packageView.repoRoot`, and this repoRoot
      is scoped per test-package-group already — verify this claim against
      actual behavior in the test rather than asserting it from this
      plan's reasoning alone).
- [ ] Separately, assert the absolute `targetTestFilePath` (constructed
      around line 417, `testPath` from `group`) remains reachable/writable
      under the post-move root for a package acceptance session — i.e. that
      the acceptance test file's absolute path is inside
      `storyExecRoot(packageView)`==`packageView.repoRoot` (always true for an
      absolute path already inside the repo, but assert it explicitly rather
      than assuming, since this is exactly the class of "declared-but-inert
      containment" bug this whole arc exists to catch).
- [ ] Run the tests; if either FAILS, that means Task 1's move DOES reach
      this file in an unexpected way (e.g. some acceptance session IS
      worktree-scoped) — stop and re-investigate rather than forcing the test
      to pass; report the actual finding rather than assuming the plan's
      prediction was correct.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `test(pipeline): pin acceptance-setup's main-checkout root survives the containment-root move`.

## Task 15 — Changelog / migration note: custom-profile grant globs re-scope

**Files:** repo's `CHANGELOG.md` (locate it — `find . -maxdepth 1 -iname "CHANGELOG*"`).

**Steps:**

- [ ] Locate the changelog file and its existing entry format/section for
      unreleased changes (read the top ~40 lines to match style).
- [ ] Add an entry under the appropriate "Unreleased"/next-version heading:
      > **BREAKING (custom permission profiles only):** the agent's file-tool
      > containment root moved from the story's package directory to the repo
      > root (single-frame redesign). A custom `scoped` permission profile's
      > grant globs (e.g. `Write(src/**)`) now match against REPO-ROOTED
      > paths instead of package-relative paths — `Write(src/**)` that used to
      > scope a grant to the package's own `src/` now matches `src/**` at the
      > repo root only; a monorepo profile author who wants the old scoping
      > must rewrite the glob as `Write(packages/*/src/**)` or the specific
      > package path. The default `unrestricted` profile is unaffected (it
      > skips glob matching entirely). No config schema change; this is a
      > semantic shift in what an existing glob string matches.
- [ ] Confirm the wording doesn't contradict Task 13's `execTouchedPaths`
      retirement or Task 1's collapse — read back the whole entry once more
      for internal consistency with the rest of this PR's changes.
- [ ] `git commit` — `docs: changelog entry for custom-profile grant glob re-scoping`.

## Task 16 — Audit-only prompt builders: render-and-read tests

**Files:** `src/prompts/sections/hermetic.ts` (58 lines), `src/prompts/builders/setup-builder.ts`
(55 lines), `src/prompts/builders/tdd-builder.ts` (413 lines),
`src/prompts/builders/rectifier-builder.ts` (903 lines — already over the
600-line cap; grandfathered in `scripts/baselines/file-sizes-baseline.json`,
confirm this at Task-start with
`grep -A2 '"src/prompts/builders/rectifier-builder.ts"' scripts/baselines/file-sizes-baseline.json`
— this task must NOT grow it further), `src/prompts/builders/grounder-builder.ts`
(98 lines), `src/prompts/builders/prior-iterations-builder.ts` (262 lines) —
all six verified present and their line counts confirmed by `wc -l`.

**Interfaces:** none — this task adds tests only, per the spec: "render every
touched branch and read the output — template review alone is insufficient."
No production code in these six files is expected to change UNLESS the audit
in the first step below finds a path/root reference this PR's other tasks
missed.

**Steps:**

- [ ] For each of the six files, grep it for any reference to `root`,
      `packageDir`, `workdir`, `toPackageFrame`, `partitionPackageFrame`,
      `--relative`, or a hardcoded path-framing assumption (`../../../`-style
      relative navigation, a "3 levels above" style sentence, a "rooted at
      your package" sentence). Record which of the six actually reference
      path-framing at all — several (e.g. `setup-builder.ts` at 55 lines) may
      not touch this concern and need only a render-smoke-test, not a
      frame-correctness test.
- [ ] For any file found to reference path framing that was NOT already
      covered by Tasks 2-8, treat it as a NEWLY DISCOVERED coupled site: write
      a failing test first (same render-and-assert-substring pattern as Task
      2/4/5/7), then fix it following the same repo-rooted convention
      established in those tasks, in THIS task rather than retroactively
      editing an earlier task — keep the commit history honest about when the
      site was found.
- [ ] For every file (regardless of whether it references path framing),
      write or extend a test that renders its exported prompt-building
      function(s) with representative inputs (a package story AND a
      repo-root story, where the function takes a story/workdir at all) and
      asserts on the full rendered string (or well-chosen substrings) — not
      merely that it "does not throw." Locate existing test files first
      (`test/unit/prompts/sections/hermetic.test.ts`,
      `test/unit/prompts/builders/{setup,tdd,rectifier,grounder,prior-iterations}-builder.test.ts`)
      and extend rather than duplicate coverage; if a given file already has
      thorough render-and-read coverage of every branch, note that in the
      commit message rather than padding it with redundant assertions.
- [ ] Run the full set of new/extended tests; for any genuinely NEW test
      written for a newly-discovered coupled site, confirm it FAILS before
      the accompanying fix and PASSES after.
- [ ] `bun run typecheck && bun run lint`.
- [ ] `git commit` — `test(prompts): render-and-read coverage for audit-only builders post-root-move`.

## Task 17 — Final verification

**Files:** none (verification only).

- [ ] `bun run typecheck` — zero errors.
- [ ] `bun run lint` — zero errors (includes `check:file-sizes`,
      `check:alias-internals`, `check:import-cycles`, and whatever
      `check:story-workdir-access`/`check-package-frame-derivation` script
      names Task 0 resolved — confirm each of those specifically, not just
      the aggregate `lint` exit code, since a script silently not wired into
      `lint` would pass green while actually broken).
- [ ] `bun run test` — full suite green. Specifically re-run
      `test/unit/tools/` (the root-parameterized containment suite) and
      confirm every file in it passes with NO test-file edits beyond what
      Task 13 explicitly made (per the Global Constraints — "survives
      verbatim" means don't quietly patch a test to match new behavior
      without that being a deliberate, documented step).
- [ ] `bun run test:coverage` — confirm no new per-file coverage regression
      against the baseline for any file touched in this PR.
- [ ] Re-read the spec's PR 2 section (lines 176-245) one more time against
      the actual diff (`git diff main...HEAD` or `git diff feat/single-frame-redesign...HEAD`,
      prefixed `RTK_DISABLED=1`) and confirm every bullet has a
      corresponding task above with a real commit — there is no bullet left
      un-actioned. List explicitly, in the final commit message or a summary
      comment for the reviewer, which of the "mechanical follow-ons" bullets
      map to which task numbers in this plan, so the phase review (per the
      spec's delivery strategy) can check them off 1:1.
- [ ] Do NOT open a PR or merge — this PR lands on its own child branch and
      merges into the `feat/single-frame-redesign` integration branch via a
      phase-reviewed sub-PR per the spec's delivery strategy (§4); stop here
      and hand off for that review.
