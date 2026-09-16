# Path-Frame Convention Design

**Date:** 2026-09-16
**Status:** Approved, not implemented
**Base:** `main` @ `d78730b6d`
**Closes:** [#2067](https://github.com/nathapp-io/nax/issues/2067), [#2071](https://github.com/nathapp-io/nax/issues/2071), [#2074](https://github.com/nathapp-io/nax/issues/2074), plus the `checkFilesExist` contradiction found during this design.
**Builds on:** [#2072](https://github.com/nathapp-io/nax/issues/2072) (shipped as `src/context/fragments/reframe.ts`, commit `d78730b6d`).

---

## Problem

nax supports monorepos. A story has a `workdir` (repo-relative package path). At runtime
`ctx.workdir = join(projectDir, story.workdir)` is the **package** dir, while `ctx.projectDir` /
`request.repoRoot` is the **repo root**. Relative file paths flow through many subsystems, and each
one implicitly assumes one of two frames:

- **REPO-ROOTED** — `packages/app/src/index.ts`
- **PACKAGE-RELATIVE** — `src/index.ts`

No layer declares which frame it speaks, so every seam guesses. A path produced in one frame and
consumed in the other either fails loudly (ENOENT, a wasted agent round trip) or silently (a real
but wrong file is read; a rule is not selected; a history lookup returns empty).

A code sweep of `src/` found **ten confirmed producer/consumer disagreements**. The three filed
issues are instances, not the whole class.

### The ten seams

| # | Seam | Disagreement | Status here |
|---|---|---|---|
| 1 | `pipeline/scope-files.ts:34,50,61` | declared (package) unioned with diff (repo) in one list | **fixed** (#2071) |
| 2 | `context/engine/providers/code-neighbor.ts:257,262` | sibling-rooted `srcFile` compared and emitted against consumer-rooted `filePath` | **fixed** (#2074) |
| 3 | `debate/verifiers/checks.ts:26` | `contextFiles` resolved repo-rooted at plan time, package-relative at runtime (`context/builder.ts:299`) | **fixed** (#2067 PR) |
| 4 | `prd` / `story.workdir` null | no frame at all; rules fall back to the whole corpus and `quality.commands` to the root config | **fixed** (#2067) |
| 5 | `execution/lifecycle/acceptance-helpers.ts:225` → `:302` | repo-framed diff output fed to `join(workdir, file)`; failure swallowed by `catch {}` at `:307` | filed |
| 6 | `utils/git.ts:491` → `context/builder.ts:299` | `captureOutputFiles` emits repo-framed parent outputs, resolved against the package dir | filed |
| 7 | `review/scoped-lint.ts:124` | package-framed path handed to `findPackageDir(relPath, projectDir)`, which resolves repo-framed | filed |
| 8 | `context/engine/providers/git-history.ts:104` | `historyScope: "repo"` runs package-framed `touchedFiles` against repoRoot, yielding empty history | filed |
| 9 | `prompts/builders/adversarial-review-builder.ts:288,295` | prompt-embedded `git diff --name-only -- .` lacks the `--relative` that `tools/git.ts:200` auto-injects for the same verbs | filed |
| 10 | `context/engine/effectiveness.ts:370` | persisted `scopePaths` inherit the producing provider's frame, so attribution is frame-dependent | filed |

### Root cause

`prompts/builders/plan-builder.ts` instructs the planner to emit "relative paths" at `:56`, `:399`
and `:511` and **never states relative to what**, while `workdir` is separately defined as
repo-relative at `:326`. The frame is never declared at the point paths enter the system, so every
consumer downstream is free to invent one.

---

## The convention

**Every path held in a nax-internal path set is repo-rooted.**

Package-relative spelling is legal in exactly two places, both boundaries, both converting *out of*
the canonical frame:

| Boundary | Direction | Reason |
|---|---|---|
| Agent prompt / chunk content | repo to package | agent file tools are contained at `codingToolRoot` = the package dir (`agents/types.ts:182-197`, set at `operations/call.ts:254`) |
| PRD at write time | package to repo | planners emit either spelling; normalize once, never again |

Everything between those boundaries — `scopeFiles`, diff collector output, neighbours, fragment
bodies, `scopePaths`, effectiveness attribution — is repo-rooted with no exceptions and no probing.

**`story.workdir` is always a string. `"."` means repo root.** `null`, `undefined` and `""` cease to
exist downstream.

### Why repo-rooted, and not package-relative

Three independent verified facts:

1. **Rule matching only loses in one direction.** `.nax/rules` `appliesTo` patterns are authored
   repo-framed. `globToRegex` anchors as `(?:^|/)` (`context/engine/providers/static-rules.ts:158`),
   so a repo-rooted scope entry matches *both* pattern styles, while a package-relative entry can
   never match `packages/app/src/**/*.ts`. Canonical-repo is the frame that never loses a match.
   It also requires **zero edits** to `static-rules.ts`, which is at exactly 600/600 lines and
   cannot grow.
2. **Only repo-rooted identifies a cross-package file unambiguously.** This is the argument the
   #2072 ruling already made and shipped.
3. **The large git collectors are already repo-rooted and correct.** `collectDiffFileList`
   (`review/diff-utils.ts:314`) passes `-- .`, so its output is already restricted to the cwd
   subtree. Canonical-repo makes it a non-change rather than a fix.

### Why `"."` rather than nullable

`"."` is **already the codebase's spelling for root**; the PRD was the only layer not using it.
Twelve sites collapse it today:

```
utils/paths.ts:25              rel && rel !== "." ? rel : undefined   (packageDirRelative)
runtime/packages.ts:79         p === "." ? "" : p
context/fragments/reframe.ts:51 prefix === "." ? undefined
review/scoped-lint.ts:104      !rel || rel === "." -> undefined
review/prepare-inputs.ts:94    rel && rel !== "." ? rel : undefined
test-runners/resolver.ts:277   rel2 && rel2 !== "."
analyze/scanner.ts:92          pkgPath === "." ? workdir : join(workdir, pkgPath)
pipeline/stages/acceptance-setup.ts:260, execution/runner-completion.ts:186,
execution/build-plan-for-strategy.ts:95, plan/strategies/context-builder.ts:65,
cli/plan-command.ts:176
```

`reframe.ts:41-52` is the strongest precedent: its doc comment already names the exact three cases
("a single-package repo, a root-package story, and a story whose PRD left `workdir` null
(nax#2067)") and collapses all three to a byte-identical body. `"."` is handled correctly there on
day one.

---

## Architecture

### New module: `src/utils/path-frame.ts`

The single source of truth for frame arithmetic and workdir interpretation. Pure, no I/O.

```
normalizeWorkdir(w)             null | undefined | "" | "./x" | "x/" -> "." | "x"
isRootWorkdir(w)                the collapse rule, stated once
toRepoFrame(path, workdir)      package-relative -> repo-rooted ("." is identity)
toPackageFrame(path, workdir)   repo-rooted -> package-relative, or null when outside

storyWorkdir(story)             -> string            always "." or a package path
storyPackageDir(story)          -> string|undefined  undefined when root
storyAbsWorkdir(root, story)    -> string            join(root, workdir), "." collapses to root
```

`UNREADABLE_MARKER` moves here from `context/fragments/reframe.ts:34` and becomes exported, so
#2074 renders cross-package neighbours with the byte-identical marker #2072 already ships.
`reframe.ts` keeps its public `reframeFilesTouched` signature and delegates the frame arithmetic.

Every accessor calls `normalizeWorkdir` internally, so it returns the right value even for a PRD
that reached memory without passing through `loadPRD`. The guarantee does not depend on the load
path being the only one.

**`toRepoFrame` disambiguation rule:** a path already prefixed by `${workdir}/` (on a segment
boundary) is treated as repo-rooted and returned unchanged; otherwise it is joined onto the workdir.
The one ambiguous input is a package-relative path that itself begins with the package's own name
(`packages/app/...` located *inside* `packages/app`). This is pathological, and does not arise at
all for PRDs written after this change, because they are canonicalized at plan time. Document it in
a comment; do not build a mechanism for it.

### New gate: `scripts/check-story-workdir-access.ts`

Fails on any direct `.workdir` read against a story type outside an allowlist (`src/prd/types.ts`,
`src/utils/path-frame.ts`). Wired as a `check:story-workdir-access` script in `package.json`,
following the 25 bespoke gates already in `scripts/` (`check-dispatch-context`,
`check-gate-reachability`, `check-file-sizes`, ...).

**The gate has no baseline.** Every site converts in PR 1; there is nowhere for a straggler to hide.

### Why the gate, rather than fixing the known call sites

There are ~20 real reads of a story's workdir across 11 files, using **three different idioms for
"absent"**, each of which lands differently on `"."`:

```
?? ""          pipeline/stages/acceptance.ts:157, acceptance/test-path.ts:142,
               acceptance/hardening.ts:299
               -> "." and "" become DIFFERENT grouping keys
|| undefined   context/engine/tool-runtime.ts:99
               -> "." is truthy, passes "." as a package path
? : truthy     pipeline/stages/acceptance-setup.ts:333, execution/iteration-runner.ts:124,167,
               operations/full-suite-gate.ts:148
               -> "." is truthy, takes the monorepo branch
raw pass       operations/full-suite-gate.ts:135,155,255,317,324,
               execution/build-plan-for-strategy.ts:228,229,
               pipeline/stages/execution-helpers.ts:40-50, utils/git.ts:481,
               context/engine/providers/feature-context.ts:388
```

Converting three known sites would leave the next author free to repeat the bug. The gate converts
the whole class into a compile-time error.

**One site changes behaviour, not just spelling.** `quality/command-resolver.ts:76,86` branches on
`storyWorkdir` truthiness and its own doc at `:60` says "undefined for single-package". Fed `"."` it
would newly resolve `{{package}}` and apply the turbo/nx orchestrator promotion for a **root**
story, swapping the plain root test command for `turbo run test --filter=<pkg>`. It must take
`storyPackageDir`. After conversion its documented contract is true by construction rather than by
convention.

**Two sites need judgement, not sweeping:**

- `execution/iteration-runner.ts:124-139` branches on `story.workdir` to decide whether to load a
  per-package config at all. That is the seam #2066/#2069 fixed in `46310bdbe`, three commits before
  this design. The conversion is behaviour-preserving but must be reviewed individually.
- `utils/git.ts:481` uses the workdir as a git pathspec prefix (`` `${scopePrefix}/` ``). With `"."`
  that yields `-- ./`, which git accepts but which reads as an accident. It takes `storyPackageDir`
  and omits the pathspec entirely at root.

---

## Per-issue changes

### #2067 — `workdir` null

**Canonicalize at write, defend at read.** Not at `loadPRD`: it is called from a dozen CLI paths
(`cli/status-features.ts`, `cli/prompts-main.ts`, `cli/accept.ts`, `cli/features-acceptance.ts`,
`cli/context-fragments.ts`, `context/engine/providers/feature-context.ts:340`, ...) and filesystem
probing only has ground truth at plan time, when the repo is in the state the planner described.

`nax plan` canonicalizes once before `savePRD`. The `path-frame.ts` accessors normalize
defensively, so PRDs written before this change keep working.

Per story with no stated workdir:

```
declared paths all resolve under exactly one workspace package -> that package  [derived]
they span packages, resolve nowhere, or there are none         -> "."           [defaulted]
planner stated one                                             -> unchanged     [stated]
```

Declared paths are canonicalized to repo frame in the same pass, using the probing resolver:

```
exists(repoRoot/P)     -> P              (already repo-rooted)
exists(repoRoot/W/P)   -> W + "/" + P    (re-spell)
neither                -> P unchanged    (a file the story creates)
both                   -> W + "/" + P    (story-local wins) and log the collision
```

This also fixes seam 3: `checkFilesExist` (`debate/verifiers/checks.ts:26`) joins `contextFiles`
against the repo root and today emits a spurious `major` finding for every monorepo story. Verified
against a real PRD (`monorepo-tiny`), whose stories carry `workdir: "packages/lib"` with
`contextFiles: ["src/util.ts", "src/util.test.ts"]` — package-relative, so every entry currently
fails the plan-time existence check.

**Provenance** is a new optional story field `workdirSource?: "stated" | "derived" | "defaulted"`.
A new check in `checks.ts` (142 lines, ample room) warns when a `defaulted` story lands in a repo
with `.nax/mono/` overlays, naming both consequences the issue documents: whole-corpus rule
selection and root `quality.commands`.

**The planner prompt is fixed in the same PR.** `plan-builder.ts:56,399,511` must state the frame
explicitly. Canonicalizing at write without fixing the instruction means every future PRD arrives
wrong and is silently repaired — the fix would work while concealing that it was needed.

**Ordering constraint:** `workdirSource` cannot be added until `src/prd/schema.ts` is under the size
limit. See *Size ratchet* below.

### #2071 — mixed-frame `scopeFiles`

At `pipeline/scope-files.ts:61`, map the declared side into the canonical frame and union with diff
output that is already repo-rooted:

```ts
const declared = [...getContextFiles(ctx.story), ...getExpectedFiles(ctx.story)]
  .map((p) => toRepoFrame(p, storyWorkdir(ctx.story)));
```

**Do not add `--relative`.** The issue proposes it as Option 1, but under canonical-repo it is the
wrong direction, and its stated blocker was false regardless. The issue argues `--relative`
"restricts output to the cwd, not just re-spells it" — but `collectDiffFileList` already passes
`-- .`, which applies that restriction today. Verified on a throwaway repo:

```
cwd=packages/app, current form (-- .):      packages/app/src/index.ts
cwd=packages/app, with --relative added:    src/index.ts
```

Identical file set, different spelling. There are no cross-package entries to lose.

`collectDiffFileList` needs **no code change**, but it does need a comment recording that it is
deliberately the one collector in `diff-utils.ts` without `--relative` — its three siblings at
`:130`, `:156` and `:262` all have it (added by PR #2070 because they feed the *agent*), and the
next reader will otherwise "fix" the inconsistency straight back into a bug.

**Correct the issue's severity on the way past.** It claims a repo-rooted entry can "fail to match a
package-relative `appliesTo` glob". `globToRegex`'s `(?:^|/)` anchor means that cannot occur in the
direction filed: `src/**/*.ts` compiles to `(?:^|/)src\/(?:.*\/)?[^/]*\.ts$`, which matches
`packages/app/src/index.ts`. The real residual is duplicate near-identical union entries and
spurious matches for globs authored with a root anchor.

### #2074 — sibling-frame neighbours

**Stop doing frame arithmetic in the comparison.** Both sides become absolute before `===`:
`join(scanWorkdir, resolved)` against `join(consumerWorkdir, filePath)`. That removes the false
reverse-deps and the bad self-skip at `code-neighbor.ts:257,262` without needing either path
re-spelled.

**Rendering** goes through `toPackageFrame` plus the exported `UNREADABLE_MARKER`, byte-identical to
#2072. Still required after the sibling scan is removed, because `neighborScope: "repo"` sets
`workdir = request.repoRoot` (`code-neighbor.ts:381`) and therefore still produces genuine
cross-package neighbours for a package-contained consumer.

**Remove the sibling reverse-scan.** `parseImportSpecifiers` (`code-neighbor.ts:158-169`) keeps only
`.`-prefixed specifiers, so a real cross-package import (`import { x } from "@scope/lib"`) is never
collected. The cross-package reverse scan therefore **cannot find true dependents at all** — the
only cross-package matches it can produce are the false ones this issue describes. Meanwhile it
globs and reads every sibling package on every fetch. The feature's stated purpose and its only
reachable behaviour disagree.

Delete `resolveExtraGlobWorkdirs` (`:335-351`) and restrict `scannedDirs` (`:418-421`) to the
story's own package. Forward resolution is unaffected: it reads the touched file's own content and
never consults `scannedDirs`.

**Retire `crossPackageDepth`.** `resolveExtraGlobWorkdirs` is its only consumer, so removing the
sibling scan would leave it controlling nothing — the declared-but-unreachable-mechanism class this
design exists to close. Remove the option:

- delete `crossPackageDepth` from `CodeNeighborProviderOptions` (`code-neighbor.ts:41`),
  `orchestrator-factory.ts:95`, `config/runtime-types-context.ts:156` and
  `config/schemas-context.ts:244,259`
- an existing config that still sets the key must keep loading — emit a deprecation warning on the
  unknown key rather than failing the parse
- amend `docs/adr/ADR-010-context-engine.md:190` and `docs/guides/context-engine.md:416,427`, which
  currently document it as *"How many package boundaries the neighbor provider may cross. 0 disables
  cross-package scans."* State that cross-package reverse-deps are unsupported, and why (bare
  specifiers are never parsed)
- `docs/specs/SPEC-context-engine-v2-compilation.md:306`,
  `docs/specs/SPEC-context-engine-v2-amendments.md:470,492` (AC-62) and
  `docs/specs/SPEC-effectiveness-scoring-loop.md:242` reference it and need the same amendment

---

## Sequencing

| PR | Contents | Shape |
|---|---|---|
| 1 | `path-frame.ts`, accessors, `check-story-workdir-access.ts`, ~20 site conversions, `schema-story.ts` extraction | large, mechanical, no intended behaviour change |
| 2 | #2071 — `scope-files.ts` mapping, anti-reversal comment on `collectDiffFileList` | ~3 lines; first consumer of the helper, proves it |
| 3 | #2067 — plan-time canonicalization, `workdirSource`, critic warning, `plan-builder.ts` frame instruction | medium |
| 4 | #2074 — absolute comparison, sibling-scan removal, `crossPackageDepth` retirement, ADR + docs | medium |

---

## Size ratchet

`scripts/check-file-sizes.ts:30` enforces **600 lines for `src/`, 800 for `test/`**, with a baseline
that recorded files may not exceed.

| File | Lines | Consequence |
|---|---|---|
| `src/context/engine/providers/static-rules.ts` | **600** | at the cap; this design touches it nowhere, deliberately |
| `src/prd/schema.ts` | **629** | baselined breach, may not grow |
| `src/context/engine/providers/code-neighbor.ts` | 462 | has headroom; the sibling-scan removal frees lines |
| `src/debate/verifiers/checks.ts` | 142 | ample |
| `src/pipeline/scope-files.ts` | 62 | ample |
| `src/context/fragments/reframe.ts` | 101 | ample |

**`schema.ts` must be split before `workdirSource` is added.** `validateStory` occupies
`schema.ts:69-499` — 430 of its 629 lines — and extracting it to `src/prd/schema-story.ts` takes the
file to roughly 200, clearing the baselined breach. This is a prerequisite of PR 3, scheduled in
PR 1.

---

## Testing

- **Unit tests** for every `path-frame.ts` helper. Pure functions, exhaustive on `"."`, `""`,
  `"./x"`, trailing slashes, segment-boundary prefixes (`packages/app` against
  `packages/application/...` must not slice into `lication/...` — the bug `reframe.ts:58-60` already
  guards).
- **The gate replaces assertions for the ~20 conversions.** A missed site is a CI failure, not a
  silent pass.
- **#2074 regression test, from the issue's worked example:** story in `packages/app`, touched file
  `src/index.ts`, with `packages/lib/src/helper.ts` containing `import "./index"`. Assert
  `packages/lib/src/helper.ts` is **not** recorded as a reverse dependency, and that a sibling's
  `src/index.ts` no longer triggers the self-skip.
- **#2067 canonicalization tests** over a fixture monorepo covering all four probe outcomes,
  including the both-exist collision.
- **End-to-end:** a `monorepo-tiny` run asserting zero failed `Read` calls. #2072 measured 6 in a
  two-story run; that number is the regression metric.

### Commands

- `bun run test` for the full suite. For a single file, `bun test ./path/to/file.test.ts --timeout=60000`.
- **Never bare `bun test`, never `bun run nax`** — both give confident false signals.
- `bun run test:coverage` is **not** part of `check:all`. PR 1 adds files under `src/`, so it must
  run before that commit.

---

## Risks

1. **PR 1 concentrates the risk.** `execution/iteration-runner.ts:124-139` is the seam #2066/#2069
   fixed in `46310bdbe`. Review it individually rather than sweeping it.
2. **Ordering is load-bearing.** `schema-story.ts` before `workdirSource`, or the ratchet rejects the
   field.
3. **`nax plan` gains a filesystem probe it did not have.** Bounded to plan time and to declared
   paths, but planning now depends on repo state in a way it previously did not.
4. **`"."` is truthy.** The gate is what makes this safe; without it the change is a latent
   behaviour flip at every un-converted truthiness site.
5. **Scope.** This design grew from three issues into a convention plus an 11-file mechanical
   conversion. That is a direct consequence of the "no ambiguous tail" ruling and was accepted
   knowingly.

---

## Out of scope

Seams 5 through 10 in the table above. Each gets its own issue citing this convention, so the rule
exists before the fixes do. They are not fixed here because each carries its own blast radius and
none blocks the three filed issues.

Also out of scope: teaching `parseImportSpecifiers` to resolve workspace package names so that
cross-package reverse-deps could work. That is a feature, not a fix, and the `crossPackageDepth`
retirement above is the honest interim state.

---

## Rulings

Decisions made during design, recorded because a fresh session cannot reconstruct them:

1. **Convention first, then the three issues.** Rejected: three independent bounded fixes.
2. **Canonical frame is repo-rooted**, re-spelled at the agent boundary. Rejected:
   package-relative-internal; a branded-path type system (largest diff, and the files it would touch
   are at the size cap); documentation alone.
3. **Tolerant resolve, canonicalized once at write.** Rejected: a hard switch breaking existing
   PRDs; reframing at each consumer.
4. **Derive, then default to `"."`, and record which.** Rejected: defaulting without deriving (it
   blesses the ~1.3 Mtok root-scoping #2067 measured, converting an accident into an assertion);
   deriving without provenance (the warning cannot then avoid false positives on genuinely
   root-spanning stories).
5. **Fix #2074's frame AND stop the sibling reverse-scan.** Rejected: frame-only (keeps paying for a
   scan that can only return nothing); adding bare-specifier resolution (a feature).
6. **Solve the `"."`-truthiness sites in one change, enforced by a gate.** Rejected: patching the
   three known call sites, which leaves a tail.
7. **Remove `crossPackageDepth` and amend ADR-010 plus the guides.** Rejected: keeping an honest but
   near-inert knob; keeping it gated pending a follow-up.
