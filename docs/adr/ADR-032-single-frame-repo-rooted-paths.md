# ADR-032: Single Frame — Repo-Rooted Agent and PRD

**Status:** Accepted, 2026-09-18 (implemented: PR #2135, main `89338db37`, closes #2125)
**Builds on:** ADR-018 (`PackageView` / `PackageRegistry`), ADR-029 (native tool containment)
**Amends:** ADR-029's Exec containment carve-out (see Consequences)
**Supersedes:** Ruling 8 ("`workdirSource` is provenance, not a frame proof") and the
package-frame convention of `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`
**Related:** `docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` — the design
and delivery record (phases, blast radius, live verification)

---

## Context

In a monorepo, three path frames coexisted:

1. **repo frame** — nax internals, git output, `.nax/rules` globs;
2. **package frame** — the agent's tool root (the story's package dir), and therefore every
   prompt, context chunk heading and `modifiedFiles` authorization that crossed into a session;
3. **spec-author frame** — whatever a spec's `### Modifies` / `### Context Files` prose used.

Every boundary between (1) and (2) needed a translation (`toPackageFrame`,
`partitionPackageFrame`, `UNREADABLE_MARKER`, the `canonical` flag, runtime existence
re-probes, prompt-embedded `git --relative`). The 09-16 path-frame convention tried to police
those boundaries. Enforcing it took three fix waves (#2076–#2082, #2097–#2102,
#2109/#2110); the forbidden `relative(repoRoot, packageDir)` idiom recurred twice inside its
own fix branches, and the PRD still ended up in an unrecoverable mixed frame (#2125):
`contextFiles` repo-framed only for paths that existed at plan time, `expectedFiles` always
workdir-framed, `modifiedFiles` never canonicalized.

The recurrence was structural. `ctx.root` did four jobs at once — containment boundary,
relative-path frame for tool args, execution cwd, and the frame permission globs match
against — so no single-site fix could move one job without silently moving the other three.

The ACP arm was never repo-rooted either: acpx has been spawned at the package dir since
`UserStory.workdir` landed (MW-001, 2026-03-17), and it had its own frame bug (#2090,
prompt-embedded git without `--relative`). ACP mostly hid the problem by delegating path
resolution to the external agent's OS cwd. The native adapter made every latent mismatch
visible because nax resolves, contains and authorizes every path itself. The only genuinely
single-frame era was pre-monorepo (cwd == repo root).

## Decision

**One frame everywhere: repo-rooted.** Agents on both protocols are rooted at the story's
execution root, the PRD is unconditionally repo-framed, and the package-relative translation
layer is deleted.

`story.workdir` keeps exactly two jobs:

1. **Selector** — which package's rules, context scoping, per-package config and test-file
   patterns apply (unchanged).
2. **Command cwd for agent sessions** — declared `quality.commands` / `acceptance.command`
   run inside an agent session (`RunCommand`) execute in the package dir, from a command map
   resolved per package (`.nax/mono/<pkg>/config.json` overrides apply).

It is no longer a frame, a containment boundary, or the agent's cwd.

The pipeline's per-story quality gates (`lint-check`, `typecheck-check`, `verify-scoped`,
`full-suite-gate`) choose their cwd by command provenance instead (`src/operations/gate-cwd.ts`,
#2223): a command the package overlay declares, or one auto-detected from the package
manifest, runs in the package dir; a command inherited from the root config runs at the root.

### Rulings

- **R1 — Both protocols.** The reframe layer lived in protocol-agnostic context builders;
  keeping it for ACP alone would have meant threading `protocol` through ~8 sites and keeping
  everything this ADR deletes. ACP spawn cwd is the story execution root.
- **R2 — The agent root is `storyExecRoot`, never `packageView.repoRoot`.**
  `PackageView.repoRoot` is the main checkout; under `storyIsolation: "worktree"` it escapes
  the worktree silently (#2093). `storyExecRoot` (`src/runtime/packages.ts`) returns the
  worktree root `<repoRoot>/.nax-wt/<storyId>` when isolated, the repo root otherwise.
- **R3 — Canonicalize at the producer.** The planner emits repo-rooted declared paths, so
  `canonicalizeDeclaredPath` (`src/prd/workdir-canonical.ts`) is an unconditional pure-string
  normalization (a defensive `toRepoFrame` for a stray package-relative spelling) with no
  existence probe. `modifiedFiles` goes through the same write seam. Ruling 8 of the 09-16
  spec, which made the mixed frame deliberate, is retired.
- **R4 — Per-package command and config resolution for a dispatch goes through
  `loadConfigForPackage`.** It carries the `--profile` chain (#2126/#2127). Do not use
  `packageView.config` to resolve a package's commands (`packages.resolve()` misses under
  worktree and parallel isolation, #2069).
- **R5 — Cross-package writes are not physically blocked.** Authorization falls to
  `modifiedFiles` plus the review layer, the same trust model ACP always had and consistent
  with the D-1 trust ruling (the repo is trusted). What remains of nax's self-protection does
  not depend on where the containment root sits (see Consequences).

## Consequences

| Concern | Before | After |
|:---|:---|:---|
| Tool containment root (native) | package dir | `storyExecRoot` |
| ACP spawn cwd | package dir | `storyExecRoot` |
| Tool-arg path frame | package-relative | repo-rooted |
| Permission and `denyPaths` glob frame | package-relative | repo-rooted |
| Default cwd for Bash/Git/Glob/Grep | package dir | `storyExecRoot` |
| Declared commands in an agent session | cwd = tool root, map from ROOT config | package dir, map resolved per package |
| PRD declared paths | mixed frame (#2125) | repo-rooted, frame declared in `schema-story.ts` |
| Prompt path spelling | package-relative via `toPackageFrame` | repo-rooted as stored |
| Git output in prompts and diff collectors | `--relative` injected | repo-rooted (git default) |

- **Deleted:** `toPackageFrame`, `toPackageFrameFiles`, `partitionPackageFrame` (its
  membership test survives as `isWithinPackage`), `UNREADABLE_MARKER` /
  `stripUnreadableMarker`, `context/fragments/reframe.ts`, `codingToolRepoRoot`,
  `reclassifyPlanTimeAbsentEntries`, and the `--relative` injections.
  `src/utils/path-frame.ts` shrinks to `toRepoFrame`, the workdir accessors and
  `isWithinPackage`.
- **ADR-029's Exec carve-out loses its containment half.** Everything a workspace package
  manager touches is now inside the root, so the `execTouchedPaths` containment carve-out is
  retired. Exec's `target: "package" | "repoRoot"` remains a cwd choice.
- **Package identity reaches the agent separately from its root.** `codingToolRoot` is
  `storyExecRoot`; `codingToolPackageDir` + `projectDir` resolve per-package config and command
  cwd; `codingToolWorkdirLabel` names the package in the agent-scope prompt section
  (`src/agents/types.ts`, producer `src/operations/call-run-options.ts`).
- **nax's own files.** `src/tools/nax-owned-writes.ts` is the remaining guard, now that
  package containment no longer shields anything by accident:
  - `.nax/config.json` and `.nax/mono/<pkg>/config.json` are refused to every tool, reads
    included, inside `resolveWithin`.
  - Every `.nax/features/*/prd.json` and the run-control files are refused to `Write`,
    `Edit`, `Delete` and `GitCommit`, with one path-exact exemption for the plan op writing
    its own PRD (#2115). `raw` bash mode has a best-effort screen; gated Bash and Exec are not
    covered by this file.
- **Migration: path globs re-scope.** Every path glob in
  `execution.permissions.<stage>.{allow,deny,ask}` and `execution.denyPaths`, whether in the
  root config or a `.nax/mono/<pkg>` config, now matches repo-rooted paths. A package config
  rule like `deny: ["Write(src/**)"]` now matches the repo's `src/`, not the package's. Under
  the default `unrestricted` profile only the grant check is skipped; stage deny/ask rules and
  `denyPaths` still match and re-scope too.
- **Spec authoring flips.** In a monorepo spec, `### Context Files` and `### Modifies` are
  written repo-relative.
- **Legacy PRDs stay loadable, not correct.** The tolerant read branch keyed off
  `workdirSource` is kept indefinitely; only write-side machinery was removed. Legacy PRDs do
  not self-heal (`canonicalizePrdWorkdirs` runs at plan-write time only), and the
  `code-neighbor` context provider assumes the repo frame unconditionally, so a legacy
  workdir-framed story can render neighbour paths that do not resolve. This is advisory
  context only.
- **One MCP connection per worktree**, not per package — matching the pool's documented cost
  model (`src/mcp/pool.ts`).
- **Exception:** `src/review/scoped-lint.ts` keeps `--relative`, because its consumer joins the
  package-relative result onto the workdir.

## Rules for new code

- Every nax-internal path set is repo-rooted. Do not introduce a package-relative spelling;
  if a package-scoped producer (a rule's `appliesTo:` literal, keyword auto-detect output)
  yields one, normalize it with `toRepoFrame` at the producer.
- Anything that roots, contains or spawns an agent, or runs a command inside the story's
  tree, uses `storyExecRoot`, never `packageView.repoRoot`.
- Read `story.workdir` only through the accessors (`storyWorkdir`, `storyPackageDir`,
  `storyAbsWorkdir`, `isWithinPackage`), and only as a selector or command cwd.
- Scope a story's diff by the story's workdir pathspec. With a repo cwd, the default pathspec
  `"."` is the whole repo; do not reach for `git --relative`.

**Enforcement.** Three rules are gated in `lint:checks`: accessor use
(`check:story-workdir-access`), the `relative(repoRoot, packageDir)` derivation shape
(`check:package-frame-derivation`), and profile threading into per-package config
(`check:config-profile-threading`). The rest — repo-rooted spelling, `storyExecRoot` over
`packageView.repoRoot`, and no `--relative` — are enforced by review only.

## Alternatives rejected

- **Keep the package frame and police the boundaries (the 09-16 convention).** Tried for three
  fix waves; the defect class kept recurring because every new producer or consumer is a new
  boundary.
- **Single frame for native only.** See R1.
- **Keep existence-gated canonicalization.** It is the mechanism that produced #2125; the
  ambiguity it resolved only exists because the planner emitted workdir-relative paths.
- **Keep package containment for write safety.** It was an accident of the frame, not a
  designed guard. The real guard for nax's own files is `nax-owned-writes.ts`; cross-package
  edits are governed by `modifiedFiles` and review (R5).

## See also

- ADR-018: `PackageView` and the per-package selector axis. (ADR-016, which first proposed
  `PackageView`, is rejected in favour of ADR-018.)
- ADR-029: native tool containment and the Exec carve-out this ADR amends. ADR-030: bash
  approval modes, including `raw`.
- `docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` §6: live verification
  (2026-09-18, six monorepo runs across native/ACP/worktree arms, PASS). The zero-failed-Read
  metric is vacuous on the ACP arm, where nax does not see the external agent's reads.
- #2125 (mixed-frame PRD), #2093 (worktree escape), #2069 (`packages.resolve()` under
  isolation), #2134 (code-neighbor under worktree isolation, closed by #2149).
