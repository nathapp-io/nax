# Single-Frame Redesign — Repo-Rooted Agent and PRD

**Date:** 2026-09-18
**Status:** Approved design, implementation not started
**Supersedes (in direction):** the package-contained agent model that
`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` works around
**Closes when complete:** #2125 (by construction)
**Related history:** #2066 #2067 #2069 #2085 #2089 #2090 #2093 #2095 #2104–#2111 #2115 #2117 #2126

---

## 1. Problem

The 2026-09-16 path-frame convention declared every nax-internal path set
repo-rooted, with package-relative spelling permitted only at the agent prompt
boundary. Enforcing that convention took three fix waves (PRs #2076–#2082,
#2097–#2103, #2109/#2110), during which the forbidden
`relative(repoRoot, packageDir)` idiom recurred twice inside its own fix
branches, the enforcement gate was rewritten four times, and the PRD ended up
carrying an unrecoverable mixed frame (#2125): `contextFiles` repo-framed only
for paths that existed at plan time, `expectedFiles` always workdir-framed,
`modifiedFiles` never canonicalized.

The recurrence is structural, not accidental. Three frames coexist:

1. **repo frame** — nax internals, git output, `.nax/rules` globs;
2. **package frame** — the agent's tool root (`codingToolRoot` = the story's
   package dir) and therefore every prompt, chunk heading, and `modifiedFiles`
   authorization crossing into a session;
3. **spec-author frame** — whatever the spec's `### Modifies` / `### Context
   Files` prose used.

Every boundary between (1) and (2) needs a translation
(`toPackageFrame`/`partitionPackageFrame`/`UNREADABLE_MARKER`, the `canonical`
flag, runtime existence re-probes, prompt-embedded `--relative`), and every new
producer or consumer is a fresh opportunity for the same defect class.

### Root cause chain

- The agent is contained at the **package dir**, not the repo root — both
  transports: native via `codingToolRoot = packageWorkdir(...)`
  (`src/operations/call.ts`, enforced by `resolveWithin` in
  `src/tools/policy.ts`), ACP via `acpx --cwd <packageDir>`
  (`src/agents/acp/spawn-client.ts`, threaded from `ctx.packageDir`).
- The planner is instructed to emit **workdir-relative** declared paths
  (`CONTEXT_VS_EXPECTED_FILES_RULE`, `src/prompts/builders/plan-builder.ts`).
  The write seam (`src/prd/workdir-canonical.ts`) then repairs to the repo frame
  only for paths that **exist on disk at plan time**, because a pure string
  function cannot disambiguate a not-yet-created workdir-relative path. That
  existence gate is the direct mechanism of #2125's mixed-frame artifact;
  Ruling 8 of the 09-16 spec made the mixed frame deliberate, but it is a
  consequence of the planner's emission frame, not a law.
- `ctx.root` does **four jobs at once**: containment boundary, relative-path
  frame for tool args, execution cwd, and the frame grant/deny/ask globs match
  against. No single-site fix could move one job without silently moving the
  other three.

### The ACP-era comparison (verified, corrects the folk memory)

acpx was **never** `--cwd <repoRoot>` in monorepo mode. `UserStory.workdir`
landed 2026-03-17 (MW-001), ~5.5 months before the native adapter (2026-09-01),
and ACP agents have been spawned at the package dir since. The ACP arm even had
its own frame bug fixed *after* native's (#2090: prompt-embedded git without
`--relative`, fixed 2026-09-17; native's Git tool had been correct since
2026-09-03).

What *is* true: ACP delegated all path resolution to the OS. The external
agent's tools resolved against its cwd invisibly to nax — no nax-side tool
policy inspected paths, no declared-path lists had to stay frame-consistent,
permissions were approve-all. The native adapter did not introduce
workdir-framing; it made every latent frame mismatch **visible and
enforceable**, because nax now resolves, contains, and authorizes every path
itself. The genuinely single-frame world was the pre-monorepo era (cwd ==
repoRoot: one frame, zero seams). This redesign restores that invariant while
keeping monorepo support.

## 2. Decision

**One frame everywhere: repo-rooted.** The agent (both protocols) is rooted at
the story's execution root; the PRD is unconditionally repo-framed; the
package-relative translation layer is deleted. `story.workdir` keeps exactly
two jobs:

1. **Selector** — which package's rules, context scoping, per-package config,
   and test-file patterns apply. (This axis is untouched; the
   `storyWorkdir`/accessor discipline and its gate remain for it.)
2. **Command cwd** — `quality.commands` and `acceptance.command` execute in the
   package dir, with per-package override via `.nax/mono/<pkg>/config.json`.

Explicit rulings baked into this design:

- **R1 — both protocols, not native-only.** The reframe layer lives in
  protocol-agnostic context builders; keeping it for ACP means threading
  `protocol` through ~8 sites and retaining everything this design deletes.
  ACP spawn cwd becomes the story execution root.
- **R2 — the agent root is `storyExecRoot`, never `packageView.repoRoot`.**
  `packageView.repoRoot` is the MAIN CHECKOUT; under `storyIsolation:
  "worktree"` it escapes the worktree silently (the #2093 class).
  `storyExecRoot` is worktree-aware and already shipped.
- **R3 — Ruling 8 of the 09-16 spec is retired, at the producer.** The
  plan-time ambiguity ("no proof ⇒ do not guess") only exists because the
  planner emits workdir-relative paths. Once the planner emits repo-rooted
  paths, canonicalization becomes an unconditional pure-string normalization
  (defensive `toRepoFrame` for a stray package-relative spelling), with no
  existence probe and no mixed output. `modifiedFiles` joins the same seam.
- **R4 — per-package config resolution goes through `loadConfigForPackage`
  only** (required `from` parameter carries the `--profile` chain, #2126/#2127;
  the static gate added there covers new sites). Never `loadConfigForWorkdir`
  directly, never `packageView.config` for this purpose (`packages.resolve()`
  misses under worktree and parallel isolation, #2069).
- **R5 — cross-package writes are no longer physically blocked.** Authorization
  falls to `modifiedFiles` + the review layer. Acceptable under the D-1 trust
  ruling (the repo is trusted); it is the same trust model ACP always had. The
  `.nax` protections (#2095/#2117: `nax-owned-writes.ts` refusing
  `.nax/config.json`, `.nax/mono/**/config.json`,
  `.nax/features/<feature>/prd.json`, run-control files, with the path-exact
  plan-op exemption) are containment-independent and remain the guard.

## 3. Architecture after the change

| Concern | Before | After |
|:---|:---|:---|
| Tool containment root (native) | `codingToolRoot` = package dir | `storyExecRoot` (worktree-aware repo root) |
| ACP spawn cwd | package dir | `storyExecRoot` |
| Tool-arg path frame | package-relative | repo-rooted |
| Grant/deny/ask glob frame | package-relative | repo-rooted (migration note; default `unrestricted` skips glob matching) |
| Default execution cwd (Bash/Git/Glob/Grep) | package dir | `storyExecRoot` |
| `quality.commands` / `acceptance.command` cwd | `ctx.root` (package dir, but map from ROOT config — #2066 residual) | package dir, command map resolved per-package via `loadConfigForPackage` |
| PRD declared paths | mixed frame (#2125) | unconditionally repo-rooted; frame declared in schema |
| Prompt path spelling | package-relative via `toPackageFrame` | repo-rooted as stored |
| Prompt-embedded / tool git output | `--relative` injected | repo-rooted (git default at repo cwd); `--relative` removed |
| `.nax` protection | `nax-owned-writes.ts` + containment accident | `nax-owned-writes.ts` alone (unchanged, now load-bearing) |
| `story.workdir` | selector + frame + cwd + containment | selector + command cwd only |

## 4. Delivery: four PRs

### PR 1 — command-cwd split + per-package declared commands

Independent and valuable alone; lands first so PR 2 changes one variable at a
time.

- Thread the execution cwd for declared commands separately from `ctx.root`:
  `RunCommand`'s declared branch and the quality runner receive the story's
  package dir explicitly, not "whatever the tool root is".
- Fix the #2066 residual: the declared-command map in
  `src/agents/coding-tool-support.ts` (~:299-312) is built from the ROOT config
  even for a package story. Resolve it per-package via `loadConfigForPackage`
  (R4), mirroring the pattern `acceptance-setup.ts` already uses for its groups
  (`loadGroupConfig` + per-group `commandOverride`/`testFramework`).
- Per-package `quality.commands` / `acceptance.command` overrides in
  `.nax/mono/<pkg>/config.json` therefore take effect inside agent sessions,
  not only in pipeline stages.
- `acceptance-setup.ts` is the reference implementation and should need no
  behavioral change here; add a test pinning that `RunCommand` and
  acceptance-setup resolve the same command for the same package.

### PR 2 — the root move

- `codingToolRoot = storyExecRoot(ctx.packageView)` (R2) in
  `src/operations/call.ts`; ACP spawn cwd likewise (`ctx.packageDir` producer
  in `src/pipeline/stages/execution.ts` / `call.ts`).
- Rewrite `src/prompts/sections/agent-scope.ts`: tools rooted at the repo
  root; the story's package is `<workdir>`; spell paths repo-rooted; declared
  commands run in the package. This is the highest-leverage prompt change.
- Reword the acceptance path-anchor paragraph
  (`src/prompts/builders/acceptance-builder.ts` ~:195) out of
  package-containment terms so a repo-rooted agent does not "correct" the path.
- Mechanical follow-ons, each silent if missed — this list is the review
  checklist:
  - MCP pool key `(serverId, workdir)` must not collide across packages once
    workdir is uniform (`src/mcp/pool.ts`) — key on the selector workdir, not
    the spawn cwd.
  - Exec `packageRelPath` derivation: both targets must not collapse to
    repoRoot without the workspace flag (`src/quality/package-managers.ts`).
  - Verifier verdict handshake: write and read must use the same root
    (`src/operations/verify.ts`).
  - Git tool default pathspec `"."` now means the whole repo — scope
    story-diff call sites by the story's workdir pathspec explicitly.
  - Remove the native Git tool's auto-`--relative` (`src/tools/git.ts`) and
    the prompt-embedded `--relative` from #2090
    (`review-builder.ts` ~:332-347, `adversarial-review-builder.ts`,
    `debate-builder.ts`) — with a repo cwd they invert into bugs.
  - `execTouchedPaths` carve-out in `policy.ts` becomes redundant (everything
    is in-root): retire it, with a test that GitCommit can stage a root
    manifest without it.
  - acceptance-gen/refine sessions: `packages.resolve(packageDir)` in
    `acceptance-setup.ts`'s `callOp` must keep receiving main-checkout paths
    (pre-run stage), and the absolute `targetTestFilePath` anchors must be
    verified in-root.
- Grant-glob migration note in the changelog: `Write(src/**)` under a custom
  profile re-scopes from package to repo (R5 context). Default `unrestricted`
  profile is unaffected (glob matching skipped).
- Audit-only prompt builders (`hermetic.ts`, `setup-builder.ts`,
  `tdd-builder.ts`, `rectifier-builder.ts`, `grounder-builder.ts`,
  `prior-iterations-builder.ts`): render every touched branch and read the
  output — template review alone is insufficient (standing working agreement;
  reframing bugs pass unit gates).

### PR 3 — PRD single frame (closes #2125)

- Planner prompts emit repo-rooted paths: `CONTEXT_VS_EXPECTED_FILES_RULE`
  and the `workdirField` text in `src/prompts/builders/plan-builder.ts`
  (draft + refine/pipeline variants), and the `decompose-builder.ts` example.
- `canonicalizeDeclaredPath` becomes unconditional pure-string normalization
  (R3): no existence probe; defensive `toRepoFrame` for stray
  package-relative spellings; `modifiedFiles` brought into
  `canonicalizePrdWorkdirs` (via the single write seam `finalizeAndWritePrd`,
  which #2116 already made the only PRD-writing path).
- Declare the frame in `src/prd/schema-story.ts` field docs; add a
  plan-write-time validation, not a `PRD.parse()`-time one (hand-edited and
  legacy PRDs must still load — consumers treat a legacy PRD as
  `workdirSource: undefined` exactly as today).
- Spec-authoring convention flips: `### Context Files` / `### Modifies` in a
  monorepo spec are written repo-relative. Update the spec-lint guidance and
  the #1473 drop-warning text, which today reads workdir-relative declarations
  as the norm.
- `expectedFiles` consumers move onto the repo-framed path (`builder.ts`
  ~:396-432): with a uniformly repo-rooted PRD, the `canonical` branching and
  `reclassifyPlanTimeAbsentEntries` (H4 residual) are no longer needed for
  newly-planned PRDs. Keep the legacy branch keyed off `workdirSource` for old
  artifacts; PR 4 decides its retirement window.

### PR 4 — deletion pass

Subtractive; lands after PR 2 + PR 3 have each been live-verified on a real
monorepo run.

- Delete `toPackageFrame` / `toPackageFrameFiles` / `partitionPackageFrame`'s
  package-reframe half, `UNREADABLE_MARKER` + `stripUnreadableMarker`,
  `context/fragments/reframe.ts`, and the prompt-boundary re-spells in
  `src/context/builder.ts` and `src/prompts/sections/story.ts`
  (`modifiedFilesLines` renders repo-rooted as stored, which also retires the
  batch `rootWorkdir` hazard, #2085 H6).
- Provider chunk headings (`code-neighbor`, `git-history`) render repo-rooted;
  chunk identity keys and `scopePaths` no longer differ from rendered text.
- Retire the frame half of `scripts/check-story-workdir-access.ts`; the
  selector half stays. Any gate change must keep the frozen-v1-regex superset
  test green — a rewrite that cannot show it dominates v1 is a regression
  regardless of mechanism.
- Update `src/utils/path-frame.ts` header and the 09-16 design spec status
  block; `path-frame.ts` shrinks to `toRepoFrame`, the workdir accessors, and
  the selector contract.

## 5. Blast radius and risks

| Risk | Exposure | Mitigation |
|:---|:---|:---|
| Agent writes outside its package | By design (R5) | `modifiedFiles` authorization + review layer + `.nax` write guard; same trust model as ACP era |
| Worktree escape via wrong "repo root" | Silent (worktree is a subdir of main, `isInside` approves) | R2: `storyExecRoot` only; add a test that a worktree story's root IS the worktree |
| Custom-profile grant globs silently re-scope | Non-default profiles only | Changelog migration note; default `unrestricted` unaffected |
| Prompt regressions (agent misplaces files) | Every session type | agent-scope rewrite first-class in PR 2; render-and-read rule for every touched prompt branch |
| `--relative` inversions missed at one site | Empty or repo-noise diffs in reviews | PR 2 checklist enumerates all sites; live-verify a monorepo review session |
| Legacy / hand-edited PRDs | Old artifacts still workdir-framed | Legacy branch keyed off `workdirSource` retained until PR 4's retirement window |
| Per-package config resolution dropping the profile chain (#2126 class) | PR 1 makes it more load-bearing | R4: `loadConfigForPackage` only; #2127's static gate covers new sites |
| MCP cwd / Exec / verifier / git-pathspec follow-ons | Each silent | Named per-site in PR 2's checklist; each gets its own test |
| Fix waves shipping the defect they close (happened twice) | Process risk | Post-merge review pass after PR 2 and PR 3, as the seam-closure arc required |

**What this dissolves:** the mixed-frame PRD (#2125), the `canonical` flag and
its H4 runtime re-probe, the `relative(repoRoot, packageDir)` recurring defect
class, `UNREADABLE_MARKER` machinery, prompt-boundary reframes, `--relative`
injections, and the frame half of the workdir gate. The diff is net-subtractive
outside PR 1.

**Out of scope:** `story.workdir` as selector (rules/context/config scoping) —
unchanged; the #2083/#2084-class selector defects are a different axis.
Permission-profile redesign beyond the migration note. ACP protocol features
(MCP, interception) remain native-only. #2124 (plan retry-exhaustion writes an
unparseable PRD) — separate defect in the same write path; fix independently.

## 6. Verification

- Unit: root-parameterized containment suite in `test/unit/tools/` survives
  verbatim (root value changes); new tests per PR 2 checklist item; PR 3 pins
  "same spec planned against trees at two different points yields byte-identical
  declared-path frames".
- Live (required before PR 4): one monorepo `nax run` per protocol arm on a
  fixture copy — assert zero failed Reads from frame misses, review diffs
  scoped to the story package, declared commands running the package's own
  toolchain, and a worktree-isolated story writing only inside its worktree.
- The end-to-end metric the 09-16 arc deferred ("zero failed Read on monorepo
  stories") becomes this design's acceptance metric.
