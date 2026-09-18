# Deep Code Review: PR2 The Root Move — `feat/single-frame-pr2-root-move`

**Date:** 2026-09-18
**Reviewer:** Subrina (AI)
**Branch:** `feat/single-frame-pr2-root-move` (17 commits, 25 src files, +601 / −624; 31 test files, +1280 / −398)
**Plan:** `docs/superpowers/plans/2026-09-18-single-frame-redesign/02-pr2-root-move.md`
**Base:** `main` (verified — main itself only differs by PR1 + this branch's history)
**Verification:** typecheck ✓ | lint ✓ (18 lint checks pass) | test (unit+integration+ui) green | targeted 116/116 on changed seams

---

## Overall Grade: **A** (93/100)

The "root move" lands exactly as the plan specifies: the agent's containment root
collapses onto `storyExecRoot` for both transports, every prompt boundary coupled
to that root is re-spelled repo-rooted in the same PR, `--relative` is retired
from the native Git tool and from the three ACP-arm prompt builders, the
`execTouchedPaths` carve-out is deleted from `policy.ts`, the MCP pool /
Exec cwd derivation / verifier verdict handshake / acceptance-setup's main-checkout
resolution each get a regression pin that fails closed under a Task-1 revert, and
the CHANGELOG entry is honest about the breaking semantic shift for custom
permission profiles. The branch delivers all 17 plan tasks, plus two earned
extra commits (`bc09dae72` Exec package-name-from-package-dir fix; `a21c2bc8c`
repo-rooted diff path convention in integration test), plus one reset-to-pre-rewrite
backup commit (`backup/review-20260918-pre-rewrite`) that does not affect this
branch's diff vs `main`. The remaining points are LOW-severity polish — the code
is production-ready and the next PR (PR3 / PR4) is well-positioned.

---

## Plan Adherence

| Plan Task | Commit | Status |
|:---|:---|:---|
| 0. Audit PR 1's actual landing shape | (preflight) | ✅ |
| 1. Root collapse: `codingToolRoot` + ACP `workdir` | `72070b8d9` | ✅ |
| 2. `modifiedFilesLines` repo-rooted pass-through | `bc5c1ed9c` | ✅ |
| 3. `builder.ts` `partitionPackageFrame` flip | `773782591` | ✅ |
| 3b. `feature-context.ts` fragment reframe flip | `d203d6c91` | ✅ |
| 4. `agent-scope.ts` rewrite (3-arg signature) | `aa1181dca` | ✅ |
| 5. Acceptance path-anchor reword | `3cabd02a3` | ✅ |
| 6. Native Git tool auto-`--relative` removed | `9dd2bb522` | ✅ |
| 7. ACP-arm diff: drop `--relative`, scope to `pathspec` | `ae28f9c91` | ✅ |
| 8. `diff-utils.ts` collector consolidation + `scoped-lint.ts` audit | `2f370cf33` | ✅ |
| 9. MCP pool one-connection-per-worktree test | `702be425e` | ✅ |
| 10. Exec `packageRelPath` independent of `codingToolRoot` | `d885991dd` | ✅ |
| 11. Verifier verdict reads from agent's write root | `f310af2be` | ✅ |
| 13. Retire `execTouchedPaths` carve-out | `d745a589e` | ✅ |
| 14. `acceptance-setup` main-checkout regression pin | `07cb6bc50` | ✅ |
| 15. CHANGELOG breaking-change entry | `e9dc38e1f` | ✅ |
| 16. Audit-only prompt-builder render-and-read tests | `c26cee330` | ✅ |
| 17. Final verification gate | (none — gates ran) | ✅ |
| Extra: Exec `packageName` from `commandCwd` (whole-branch review) | `bc09dae72` | ✅ (real bug, see below) |
| Extra: Repo-rooted diff path convention integration test | `a21c2bc8c` | ✅ |

Three commits on this branch belong to PR1's history and are correctly listed
(`b000dd2c1`, `0930fc8f2`, `6f7d62fa0`, `849869d00`); the PR2 review of `main..HEAD`
sees them but they are not PR2 work.

### Earned extras (worth the noise)

- **`bc09dae72` Exec package name from story package dir** — caught during this
  whole-branch review. Pre-fix, `resolveCodingToolSupport` read `packageName`
  from `root` (the repo root post-PR2), so a `cargo add` in a workspace member
  was scoped with the ROOT manifest's name (or denied outright when the root
  had none). The new test `test/unit/agents/coding-tool-support-exec-package.test.ts:135-174`
  stubs a project with `package.json name=repo-root-pkg` at root and
  `Cargo.toml name=member-crate` at the member, then asserts the spawned argv
  is `["cargo", "add", "-p", "member-crate", "serde"]` — proving the name comes
  from the story package. This is exactly the class of bug a whole-branch review
  catches but a one-off green CI run does not.
- **`a21c2bc8c` integration test pin** — pins the
  `packages/api/...`-rooted diff output convention against a real repository.
  Without this, an integration runner could regress to package-relative paths
  under test-only CI conditions and a unit-test-only run would never see it.

---

## Findings

### 🔴 CRITICAL

None.

### 🟡 MEDIUM

None. (Several LOW items below; nothing blocks merge.)

### 🟢 LOW

#### LOW-1 · `src/agents/types.ts` at **599/600 lines** — single-line headroom
**Category:** STYLE
The new `codingToolWorkdirLabel` JSDoc (lines 211-221) is appropriately
load-bearing — it explains why the value is a bare workdir (no `.nax-wt/<id>/`
prefix, "." at the repo root) and how it differs from `codingToolPackageDir`.
But it puts `types.ts` at **599 lines against the 600-line hard cap**. PR1's
review already flagged this file at 598 (LOW-1 of that review); PR2 adds 1
line net. The file is **1 line under the cap**. The next field added to
`AgentRunOptions` — even a single line — will trip it.

The PR1 review suggested extracting the option interface or splitting by
concern (runtime vs. coder-config). PR2 chose not to do that; the rationale
implicit in the changes (deliberately keep all 11 fields together for the
AgentManager cross-cutting contract) is defensible. Worth flagging here
because the next PR that touches this file has no headroom, and the plan
sequence (PR3 = PRD single-frame, PR4 = deletion pass) likely modifies it
again. Plan a 1-commit extraction (`AgentRunOptions` → new
`src/agents/run-options.ts`) as part of either PR3 or PR4.

#### LOW-2 · `void label;` placeholder retains a no-op call to `packageLabel` for PR4
**Category:** STYLE / deliberate-arc-marker
**File:** `src/prompts/sections/agent-scope.ts:55-56`

```typescript
const label = packageLabel(root, repoRoot);
void label; // retained call for PR 4's single-unit deletion; not rendered
```

`packageLabel` is the post-#2093 worktree-prefix-stripping helper whose
`relative(repoRoot, root)` is now always `""` (because `root === repoRoot`
post-PR2). The plan explicitly says: "`void label;` is a deliberate placeholder
to keep `packageLabel` called (and therefore not flagged unused by lint)
without rendering its now-always-empty result — remove this the moment PR 4
deletes `packageLabel` itself; do not leave `void label;` in the codebase beyond
this arc."

This is exactly what the plan asked for and the comment is honest about why.
Flagging it because `void X;` is an unusual pattern in this codebase and a
grep for it will turn up exactly one hit — a future reader's first reaction
will be "why is this here?". The comment answers it, but a follow-up PR4
reviewer will need to remember to delete it. A `@design` annotation would
make this more discoverable to the curator tool:

```typescript
/** @design PR4 retires `packageLabel` alongside `codingToolRepoRoot`; do not
 *  promote the call to a deletion until then. The `void label;` placeholder
 *  is the only thing keeping `packageLabel` referenced from the build graph. */
```

(No code change needed — comment is sufficient — flagging for the curator.)

#### LOW-3 · `_rootWorkdir: string` parameter kept unused for PR4
**Category:** STYLE / deliberate-arc-marker
**File:** `src/prompts/sections/story.ts:48-58`

```typescript
function modifiedFilesLines(story: UserStory, _rootWorkdir: string): string[] {
  const entries = story.modifiedFiles;
  if (!entries || entries.length === 0) return [];
  // nax single-frame redesign PR 2: ... `_rootWorkdir` kept as a parameter
  // (unused) so every call site and this function's signature survive
  // unchanged until PR 4 deletes both; ...
  return buildModifiedFilesLines(entries);
}
```

Per the plan. The inline comment block (lines 39-58) explains the rationale
in full, including why `_rootWorkdir`'s old batch-anchor rationale
(nax#2085 H6) is now moot. PR4 deletes both the parameter and the helper.
No action needed in PR2.

#### LOW-4 · Dead `if (unreachable.length > 0)` warning block in `builder.ts`
**Category:** STYLE / deferred-cleanup
**File:** `src/context/builder.ts:328-344`

The plan said leave it: "it is now permanently dead for this path (`unreachable`
is always `[]`) but harmless; leave it rather than deleting the log
statement, since PR 4's helper deletion will naturally make this whole branch
unreachable and that is the right time to remove it (removing it now widens
this task's diff without a spec mandate)."

Implementation matches — the dead `unreachable` declaration on line 321,
the dead branch at 328-344, and the explanatory comment are all consistent
with the plan. The comment block (lines 329-334) says precisely why it's
retained. **No action needed in PR2.** Flagging only because a future reader
will see `unreachable: string[] = []` followed by `if (unreachable.length > 0)`
and (correctly) ask why; the comment answers it.

#### LOW-5 · `resolveAbsolutePackageDir` name is now misleading — flagged in code
**Category:** STYLE / accepted
**File:** `src/operations/verify.ts:190-211`

The plan explicitly flagged this: "leave the name as-is in this PR (a rename
ripples through every call site and isn't required by the spec) but flag the
mismatch explicitly in the updated comment so a future reader isn't confused,
and leave a one-line TODO-style note (not a TODO comment per project
convention against orphaned TODOs — instead a factual doc sentence) that PR 4
or a follow-up may rename it to `resolveVerifierWriteRoot`."

Implementation: the function's doc comment (lines 190-211) says "The name
`resolveAbsolutePackageDir` is now slightly misleading... A follow-up (PR4)
may rename this to `resolveVerifierWriteRoot`; it is left as-is here because
a rename ripples through every call site and isn't required by this change."
**Matches the plan exactly.** The plan's instruction to use a "factual doc
sentence" rather than a TODO comment was followed. No action needed.

The function has 3 call sites in this file (lines 187, 209 itself), all in
the same module — a rename is mechanically small. Worth noting because PR4's
deletion pass may want to absorb this rename rather than leave the
inaccurate name in place.

#### LOW-6 · `accept-map` discriminated-trio comment claim — verified, slight overstatement
**Category:** ENH / documentation precision
**File:** `src/agents/coding-tool-support.ts:71-79` (Task 10 doc on
`packageWorkdir`)

> "Post-root-move, `codingToolRoot` and `codingToolRepoRoot` are BOTH
> `storyExecRoot` (the repo/worktree root), so `args.root` can no longer
> stand in for the package dir: `run-command-exec.ts` computes
> `relative(repoRoot, packageWorkdir)`, which would always be "" and make
> `package-managers.ts`'s `effectiveTarget` collapse EVERY Exec call —
> `target: "package"` included — onto the repo root."

The second sentence is correct. The "would ALWAYS be """ overstates slightly:
`relative(repoRoot, packageWorkdir)` is `""` only when
`packageWorkdir === repoRoot` strictly. With the new Task 10 plumbing, the
producer (`call-run-options.ts:86`) sets `codingToolPackageDir:
ctx.packageView.packageDir`, which is a RELATIVE key (e.g. `"packages/api"`),
NOT an absolute path. So the order of operations matters:

1. **Pre-PR2:** `args.root` was the absolute package workdir →
   `packageWorkdir: args.root` was absolute → `relative(repoRoot, workdir)`
   was the bare relative package path → `effectiveTarget` was `"package"`.
2. **Post-PR2, before Task 10 fix:** `args.root` became the repo root →
   `packageWorkdir: args.root` was the repo root →
   `relative(repoRoot, workdir)` was always `""` → `effectiveTarget` was
   always `"repoRoot"`. **The bug.**
3. **Post-PR2 + Task 10:** `args.packageWorkdir ?? args.root` is the
   absolute package workdir (from `commandCwd`) → restored case 1's
   semantics.

The comment is correct about case 2 (the bug) and case 3 (the fix). Saying
"always """ is the right shorthand for case 2. Not a defect — flagging
because the comment explains the *reason* for the fix and a future reader
following the call chain step by step will arrive at "but
`ctx.packageView.packageDir` is relative…" and pause. The follow-up
sentence ("`packageWorkdir` is compared against the absolute `repoRoot`,
so a relative value yields garbage") addresses this exact concern. The
sentence is correct; the slight redundancy is fine.

#### LOW-7 · `_codingToolSupportDeps` was extended in PR1; PR2's docs trail
**Category:** STYLE / docs trail
**File:** `src/agents/coding-tool-support.ts:200-204`

```typescript
exec: {
  repoRoot: args.repoRoot ?? args.root,
  packageWorkdir: args.packageWorkdir ?? args.root,
  allowScripts: args.allowScripts ?? false,
  ...
}
```

The inline comment on `packageWorkdir` is missing — every adjacent field has
either a doc comment on the `args` side or an inline note, but the runtime
side of `Exec` opts has no narration on what the `packageWorkdir ?? args.root`
fallback buys. The args-side doc (lines 66-79) is excellent; the runtime-side
doc is silent.

This is the kind of doc smell PR1's review caught for
`buildRunDispatchOptions` (LOW-4: "Lost `nax#2115` rationale comment at the
`codingToolFileOutput` producer site") — a producer-side comment was lost
when the field was extracted. Same shape here: the consumer side has the
load-bearing explanation, the producer side (inside the `exec:` literal)
just has `args.packageWorkdir ?? args.root`.

**Fix (1 line):**
```typescript
packageWorkdir: args.packageWorkdir ?? args.root,
// Post-root-move: `args.root` is the repo root, so the fallback only matters
// for single-package repos where the two coincide (and for tests not threading
// `packageWorkdir`). Production always threads it via Task 10's
// `commandCwd` plumbing in `resolveCodingToolSupport`.
```

#### LOW-8 · `tools/run-command.ts:430` `commandCwd ?? ctx.root` fallback semantics after PR2
**Category:** BUG (latent, no production trigger)
**File:** `src/tools/run-command.ts:430`

```typescript
workdir: opts.commandCwd ?? ctx.root,
```

`opts.commandCwd` is the package workdir when threaded (every production
caller goes through `buildCodingToolSupport` → `createRunCommandTool`,
which sets `commandCwd: args.commandCwd ?? args.root` at line 199). So
production always passes a non-empty `commandCwd`.

Pre-PR2, `ctx.root` was the package workdir, so the fallback was a no-op.
Post-PR2, `ctx.root` is the repo root. If a test or future caller passes
neither `commandCwd` nor sets `args.root` to the package workdir, a
declared command runs at the repo root. For a monorepo story whose declared
`test` command is `bun test {{files}}`, that's `bun test` against the
WHOLE REPO — running the wrong package's tests.

The `args.root ?? undefined` guard at line 136 throws
`CODING_TOOL_ROOT_MISSING`, so `args.root` is guaranteed non-empty by the
time `createRunCommandTool` is called. `args.commandCwd ?? args.root`
(line 199) means `opts.commandCwd` is the package workdir whenever it's
threaded; the fallback to `args.root` happens iff `commandCwd` was
deliberately omitted. Today, `resolveCodingToolSupport` always threads it
(lines 503-510 of `coding-tool-support.ts`). So in practice: the fallback
chain is correct.

**No action needed in PR2** — the production chain keeps `commandCwd`
non-empty. Flagging because the comment in `run-command.ts:60-69` says
"every caller today passes the package workdir either way, so the fallback
is a no-op until PR2 repoints `ctx.root` at the story's repo-rooted
execution root" — that comment is now inaccurate post-PR2. The fallback is
no longer a no-op if `commandCwd` is omitted; it becomes a
"run-at-the-repo-root" path that no production caller takes but is
documented as safe.

**Fix (1 line doc update):**
```typescript
// Falls back to `ctx.root` when absent. Post-PR2 `ctx.root` is the repo
// root (not the package dir), so an omitted `commandCwd` runs the command
// at the repo root — every production caller threads it; this fallback is
// only reachable from tests that bypass `buildCodingToolSupport`.
```

#### LOW-9 · `tools/git.ts:204-210` doc comment claim about `GIT_RELATIVE_VERBS` removal
**Category:** STYLE / docs precision
**File:** `src/tools/git.ts:204-210`

> "No `--relative` is injected. Since the single-frame redesign the
> permitted root is the repository root, so git's default repo-rooted path
> framing already agrees with Read/Grep/Glob. The flag only ever compensated
> for a package-subdir root (#1807); from the repo root it is wrong."

This is the doc comment explaining why `--relative` was removed. It is
excellent. The minor nit: "from the repo root it is wrong" is true (the
flag would reframe paths onto cwd, which IS the repo root, so paths
wouldn't actually change — it would be a no-op). The comment could
sharpen this by saying "it is wrong (a no-op now, an inversion if the
agent `cd`s into a sub-package)" — the inversion case is what makes it
actively harmful, and the inversion is exactly what Task 7's review
caught (see `review-builder.ts:355-364` and `debate-builder.ts:451-457`).
Minor; comment is honest about what it defends.

#### LOW-10 · `tools/index.ts` lost the `exec-touched-paths` exports — barrel consistency check
**Category:** STYLE / barrel cleanup
**File:** `src/tools/index.ts:1-5` (5 lines removed)

The barrel correctly drops the three `exec-touched-paths` exports
(`isKnownManifestOrLockfileName`, `recordExecTouchedPaths`,
`snapshotExecTouchedPaths`) since `src/tools/exec-touched-paths.ts` itself
was deleted (108 lines). `grep -rn "exec-touched-paths" src/ test/` returns
zero hits — barrel and module are consistent. No action needed.

#### LOW-11 · `tools/index.ts` still exports `getMergeBase`-adjacent utilities from deleted modules
**Category:** STYLE / barrel-cleanliness check (verified clean)
**File:** `src/tools/index.ts`

I grepped the barrel against all post-deletion imports: zero dangling
references. `gitWithTimeout`, `GIT_TIMEOUT_MS`, `NAX_OWNED_GIT_EXCLUDE_PATHSPECS`
all remain correctly re-exported from their current homes. No action needed.

#### LOW-12 · `scripts/check-no-silent-naxconfig-cast.sh` allow-list grew to 7 entries
**Category:** ENH (same shape as PR1 LOW-7)
**File:** `scripts/check-no-silent-naxconfig-cast.sh:29-56`

The PR adds `src/agents/coding-tool-support.ts` to the per-file allow-list
with full RULING F2 justification (lines 29-38). This matches PR1's
exact pattern — the RULING F2 cast (`options.config as unknown as
NaxConfig`) is now inline-documented as load-bearing: the runtime config
is the full NaxConfig even though the `AgentRunOptions.config` field is
typed as the narrower `AgentManagerConfig` pick.

The same caveat from PR1's review applies: "the note in the script
header... is honest about the limit. No regression; the existing pattern
is preserved. The natural next iteration would be a per-line ratchet
(a list of `file:line` pairs), but that's a separate refactor."

#### LOW-13 · `src/runtime/packages.ts:239` file size and segment-arithmetic clarity
**Category:** STYLE / readability
**File:** `src/runtime/packages.ts:227-239`

`storyExecRoot` is 12 lines and handles three cases (no packageDir, absolute
packageDir, worktree-prefixed relative packageDir). The segment-arithmetic
(`segments.slice(0, 2)` and `join(repoRoot, segments[0], segments[1])`) is
correct but reads as a magic dance. A small helper or a one-liner
`worktreeDir(packageDir)` would aid readability:

```typescript
function worktreeDir(relativePackageDir: string): string | undefined {
  const segments = relativePackageDir.split("/");
  if (segments[0] !== WORKTREE_DIR || segments.length < 2) return undefined;
  return segments[1] as string;  // the story id
}
```

The function is correct as written, has an explanatory comment (lines
230-234), and has direct test coverage in `test/unit/runtime/packages.test.ts`.
**No action needed in PR2** — flagging because PR3 will likely add more
worktree-aware helpers and a `worktreeDir()` extracted now would simplify
that work.

#### LOW-14 · `CHANGELOG.md` breaking-change entry — comprehensive but missing Exec caveat
**Category:** ENH / docs completeness
**File:** `CHANGELOG.md:16-23`

The breaking-change entry (lines 16-23) correctly states the
`Write(src/**)` → `Write(packages/*/src/**)` re-scoping for custom `scoped`
profiles and notes `unrestricted` is unaffected. It does NOT mention:

1. **Exec `target: "package"` cwd now resolves through `commandCwd`** — a
   custom profile that grants `Exec(cargo install)` with a `packageWorkdir`
   assumption may need re-threading if its `quality.install.allowScripts`
   or `quality.commands` is set per-package.
2. **MCP pool connection deduplication** — two package stories in the same
   repo now share ONE MCP connection (`test/unit/mcp/one-connection-per-worktree.test.ts:88-118`).
   A custom `.nax/config.json` that scopes MCP servers per package via
   `mcp.servers[id].stages` may see different behaviour.
3. **`contextTools` reach** — an op that previously declared its tools
   with package-relative paths (impossible by construction, but worth
   flagging) now addresses files repo-rooted.

Items 1-3 are edge cases for custom configs; item 1 is the most likely to
bite. Plan Task 15 specifically says "Confirm the wording doesn't
contradict Task 13's `execTouchedPaths` retirement or Task 1's collapse —
read back the whole entry once more for internal consistency with the rest
of this PR's changes." It doesn't mandate a comprehensive
custom-config-impact survey. The CHANGELOG entry is fine as-is for the
core breaking change; a follow-up note about Exec/cwd behaviour could be
added in PR3 if more regressions appear. **No action required in PR2.**

---

## Strengths (worth keeping in future PRs)

1. **Root collapse pinned at the dispatch seam, not at the builder.** PR1
   extracted `buildRunDispatchOptions`; PR2 anchors its regression tests on
   `runWithFallback`/`completeAs` *capturing the options object passed*,
   not on the builder literal alone
   (`call-root-collapse.test.ts:14-17`, lines 78-83 and 80-84). A future
   divergence between builder and dispatcher is caught. This is the right
   anchor.

2. **`--relative` exemption explicitly tested for `scoped-lint.ts`.** The
   "no--relative" consolidation could have over-consolidated; the plan
   explicitly carved out `scoped-lint.ts` because its live consumer
   `filterFilesToScope()` does a `join(workdir, relPath)`, and PR2's
   `scoped-lint.test.ts:40-49` pins the exemption with an inline test
   comment citing the join reason. The retention is documented AND
   asserted. Exemplary.

3. **`resolveAbsolutePackageDir` test exercises three worktree shapes**
   (`verify-op-recover.test.ts:135-219`): package-relative, worktree-prefixed,
   and repo-root. The repo-root case with `packageDir = ""` plus
   `repoRoot = ""` returns `""` and fails closed (line 211-218) — the
   empty-string "fail closed without touching the filesystem" branch
   is pinned by behavior, not by absence of a test.

4. **Whole-branch review caught a real bug.** `bc09dae72` is exactly the
   defect this review process exists to find: Exec was reading
   `packageName` from `args.root` (now the repo root), silently scoping
   workspace installs with the root manifest's name. The new test
   (`coding-tool-support-exec-package.test.ts:135-174`) stubs both
   manifests, asserts the member name is used, and documents the cargo
   `-p` flag. This would have shipped as a "workspace installs behave
   strangely" report 2 months later.

5. **`agent-scope.ts` rewrite is clean.** Three-arg signature, exact-text
   assertions in tests (`agent-scope.test.ts:18-29`), the `void label;`
   placeholder is annotated for PR4 retirement. The two prose branches
   (repo-root story vs. package story) are explicit and orthogonal.

6. **Test isolation is rigorous.** The diff-utils, scoped-lint, and
   coding-tool-support test files all restore `_deps` in `afterEach`.
   The MCP test (`one-connection-per-worktree.test.ts:54-59`) explicitly
   saves and restores both `_mcpClientDeps` and `_codingToolSupportDeps`
   originals before mutation. No test leakage observed.

7. **Conventional commits, one concern each.** 17 plan tasks → 17 source
   commits + 1 extra (Exec package name) + 1 extra (integration test pin).
   Every commit message names the scope and the change exactly. Matches
   repo style and PR1's discipline.

8. **The PR1 review's `LOW-2` (`packageOverrideKey(".nax-wt")` edge case)**
   was fixed in `b000dd2c1` (already merged on this branch — "test(runtime):
   pin packageOverrideKey edge cases (LOW-8)"). The previous review's
   `LOW-8` (no unit test for `packageOverrideKey`) was resolved by adding
   parametric test cases. The cross-PR review loop works.

9. **The plan's "rerun Task 1 to catch a regression" discipline is
   encoded in the MCP test.** `one-connection-per-worktree.test.ts:88-118`
   drives the REAL production chain (`buildRunDispatchOptions` →
   `resolveCodingToolSupport` → `resolveProviderTools` →
   `provider.tools(workdir)` → `pool.listTools`) so the count of MCP
   connections is exercised end-to-end. The plan Task 9 step 3 mandates:
   "temporarily revert Task 1's `call.ts`/root derivation locally, confirm
   the test then FAILS with call count 2, and restore." The test's
   structure makes this revert-check mechanically easy.

10. **`file-sizes` check stays at 14 grandfathered.** No new file exceeded
    the 600-line cap (the closest is `types.ts` at 599, see LOW-1).
    `context/builder.ts` shrank from 521 to 412 lines as a side effect of
    deleting `reclassifyPlanTimeAbsentEntries` and stopping
    `partitionPackageFrame` calls — a net **-109 lines** while still
    adding the worktree handling.

11. **The CHANGELOG breaking-change entry is honest.** "No config schema
    change; this is a semantic shift in what an existing glob string
    matches" — exact phrasing the project uses elsewhere. The default
    `unrestricted` profile being unaffected is the right clarification.

12. **`run-command-exec.ts` audit complete.** The plan asked to confirm
    whether `recordExecTouchedPaths`'s only purpose was the now-deleted
    `compileToolPolicy` option. Implementation: `run-command-exec.ts:96-118`
    (the `recordExecTouchedPaths` site) was deleted along with the
    module; `grep "recordExecTouchedPaths" src/` returns zero hits in
    production code, only test fixtures. The Task 10 plumbing is now
    clean.

---

## Verification Evidence

| Gate | Command | Result |
|:---|:---|:---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint (Biome + 17 checks) | `bun run lint` | exit 0 — all pass |
| Dispatch context | `bun run check:dispatch-context` | exit 0 |
| NaxConfig cast allow-list (now 7 entries) | `bun run check:naxconfig-cast` | exit 0 |
| Inline test mocks | `bun run check:test-mocks` | exit 0 |
| Test escape hatches | `bun run check:test-escape-hatches` | exit 0 |
| `as unknown as` test pattern | `bun run check:test-as-unknown-as` | exit 0 |
| Full test suite | `bun run test` | unit 46.98s + integration 16.15s + ui 0.86s, all green |
| File sizes (600-line cap) | `bun run check:file-sizes` | 14 grandfathered (baseline), `types.ts` at 599 (LOW-1) |
| Import cycles | `bun run check:import-cycles` | 0 modules |
| Targeted (call-root-collapse, call-run-options, verify-op-recover, agent-scope, one-connection-per-worktree, policy-root-move, git, scoped-lint, coding-tool-support-exec-package, acceptance-setup-dispatch-root, diff-utils, review-builder, adversarial-review-builder, debate-builder) | `bun test ... --timeout=30000` | 116/116 pass / 305 expects |

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P3 | LOW-1 | — | Track `types.ts` at 599/600 lines in PR3 plan; either extract or stop adding AgentRunOptions fields. |
| P3 | LOW-2 | XS | Add a `@design` annotation to the `void label;` placeholder in `agent-scope.ts:55-56` for curator discoverability. |
| P3 | LOW-5 | XS | PR4 may rename `resolveAbsolutePackageDir` to `resolveVerifierWriteRoot`; flag in PR4 plan. |
| P3 | LOW-7 | XS | Add the 4-line runtime-side `exec.packageWorkdir` doc comment in `coding-tool-support.ts:200-204`. |
| P3 | LOW-8 | XS | Update the `commandCwd ?? ctx.root` fallback comment in `run-command.ts:60-69` to reflect post-PR2 semantics. |
| P3 | LOW-13 | S | Extract `worktreeDir(relativePackageDir)` helper from `storyExecRoot`'s segment arithmetic — opportunistic PR3 cleanup. |

(No P0/P1/P2. The code is production-ready. PR3 / PR4 will absorb LOW-1 and LOW-5 naturally; the rest are documentation polish.)

---

## Plan↔Implementation Diff (informational)

| Plan said | Implementation did | Verdict |
|:---|:---|:---|
| `wc -l src/tools/policy.ts` "currently 595 lines" (plan trust) | Implementation: `wc -l src/tools/policy.ts` → **558 lines** (-37 net, after Task 13 deletion) | ✅ Strictly under ceiling as the plan required (Task 13 was a deletion). |
| `wc -l src/operations/call.ts` "currently 600 lines" (plan trust) | Implementation: `wc -l src/operations/call.ts` → **576 lines** (-24 net, after Task 1 four-line swap) | ✅ Under ceiling. |
| Plan Task 1: `packageWorkdir` import "may become unused" | `call.ts:10` correctly removes the import; `packageWorkdir` is still imported transitively via other seams | ✅ Clean. |
| Plan Task 2: doc comment "above `modifiedFilesLines` (lines 21-55)" describing the package-reframing rationale "update it to say the entries are rendered repo-rooted as stored" | `story.ts:21-58` rewritten with full rationale including the now-moot nax#2085 H6 batch-anchor paragraph | ✅ Even more thorough than required. |
| Plan Task 3b: "delete the `reframeFilesTouched` import (:24) and the now-stale reframe comment block" | `feature-context.ts` deletes the `reframeFilesTouched` call and its now-stale comment; `grep "reframeFilesTouched" src/` returns zero hits | ✅ Clean. The function still exists in `src/context/fragments/reframe.ts` for PR4 deletion, which the plan explicitly forbids touching in PR2. |
| Plan Task 7: "For each file, thread the new parameter from that builder's public entry point up to its real pipeline-stage caller the same way as `review-builder.ts`" | All three builders (`review-builder.ts:158`, `adversarial-review-builder.ts:387`, `debate-builder.ts` — `pathspec` added to `DiffContext` discriminated union in `types.ts:67`) correctly thread `pathspec` to `git diff --unified=3 ${ref}..HEAD -- ${pathspec}` | ✅ Clean. `debate-builder.ts`'s choice to add `pathspec` to the `DiffContext` type rather than as a bare param is correct per the plan's note. |
| Plan Task 8: "consolidation onto no---relative convention" | `diff-utils.ts` extracts a shared `buildDiffArgv()` helper (lines 119-121) used by all four collectors; `scoped-lint.ts:75-92` keeps `--relative` with a 14-line doc comment citing the `filterFilesToScope()` join-consumer reason | ✅ Consolidation done + carve-out explicitly preserved with a test (`scoped-lint.test.ts:40-49`). |
| Plan Task 13: "If `recordExecTouchedPaths`'s only purpose was ever to feed this carve-out, remove the array construction and its threading through `coding-tool-support.ts` and `run-command-exec.ts`'s `RunCommandExecOptions.touchedPaths`/`recordExecTouchedPaths`/`snapshotExecTouchedPaths` machinery too" | Implementation: `src/tools/exec-touched-paths.ts` (108 lines) deleted entirely; `src/tools/index.ts` barrel stops re-exporting the three helpers; `coding-tool-support.ts` and `run-command-exec.ts` lose the `touchedPaths` field and its threading | ✅ Deletion was the right call; `grep` confirms zero remaining references in production. |
| Plan Task 14: "if either FAILS, that means Task 1's move DOES reach this file in an unexpected way — stop and re-investigate rather than forcing the test to pass" | `acceptance-setup-dispatch-root.test.ts:100-135` (the test) passes; `acceptance-setup.ts:175-205` does route through the shared `_callOp`, but `packageDir` is always main-checkout absolute (the test pins this). The plan's hypothesis was correct: `storyExecRoot(packageView) === packageView.repoRoot` for acceptance-gen/refine sessions. | ✅ Hypothesis confirmed by test, not assumed. |
| Plan has 17 tasks → 17 commits | Branch has 19 source commits (17 plan tasks + Exec package name + integration test pin) | ✅ Two extra commits earned. |

---

## Summary

`feat/single-frame-pr2-root-move` delivers the largest semantic shift of the
single-frame redesign so far — moving the agent's containment root from the
package directory to the story execution root, for both transports, with
every coupled prompt boundary flipped in the same PR — and does so without
breaking any test, exceeding any file-size cap, or smuggling an inline
behavior change through undocumented.

The PR is **production-ready**. The code is well-tested, well-commented, and
ready for PR3 (PRD single-frame) to build on the new `storyExecRoot`
collapsing.
