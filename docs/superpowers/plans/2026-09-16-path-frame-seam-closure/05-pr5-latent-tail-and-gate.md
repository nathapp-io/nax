# PR 5 — The latent tail and the gate (#2083, #2087, #2084)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the three contract defects that cost nothing today and everything on the next change — a frame-unsafe signature with three swallowing catches, a function whose two lines demand contradictory frames, and the gate that is supposed to prevent both.

**Architecture:** Fix the acceptance-regeneration frame at its local seam; delete the dead scoped-lint surface rather than reframing unreachable code; replace the gate's regex with a type-aware AST walk.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (seams 5 and 7, plus the arc's own follow-up). **Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Independent** — no dependency on other PRs in this bundle.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here:

- `typescript ^7.0.2` **is** a devDependency (`package.json:91`), so a real AST walk in Part C is available without adding a dep.
- `bun run typecheck && bun run lint && bun run test` green before every commit, plus `bun run test:coverage` (separate per-file floor; this PR adds tests).
- Never read `story.workdir` raw. Part C changes the gate that enforces this — expect it to flag sites the regex missed.

**Nothing in this PR is live.** All three are contract defects. Do not write a PR body claiming a user-visible fix.

---

## Part A — #2083: acceptance-test regeneration

### The defect

`spawnGitDiff` (`src/execution/lifecycle/acceptance-helpers.ts:225-233`) runs `git diff --name-only <ref>` with **no `--relative` and no pathspec**, so its output is framed at the repository top level regardless of cwd. `:302` then joins it onto `acceptanceContext.workdir`:

```ts
225   spawnGitDiff: async (workdir, gitRef) => {
226     const proc = Bun.spawn(["git", "diff", "--name-only", gitRef], { cwd: workdir, ... });
...
278   const workdir = acceptanceContext.workdir;
282   const diffOutput = await _regenerateDeps.spawnGitDiff(workdir, storyGitRef);
...
302     const filePath = path.join(workdir, file);
```

### Today the join is frame-correct — do NOT file this as a live bug

The only production call path is `acceptance-loop.ts:477` ← `buildAcceptanceContext` (defined `:198`), which sets `projectDir: ctx.workdir` **and** `workdir: ctx.workdir` (`:212-213`) from `runner-completion.ts:219` `workdir: options.workdir` — the run root. So `workdir === projectDir === repo root` and every join resolves correctly.

**Correction to the issue body:** #2083(e) claims the per-package acceptance fan-out builds a `PipelineContext` with `workdir: pkg.packageDir`. It does not. `acceptance-loop.ts:543` is a `diagnosisOpts` bag; the fan-out otherwise names that value `packageDir` (`:509`, `:521`, `:292`). Fix the issue text.

### Why it is still worth fixing

1. **The signature promises the opposite of what it needs.** `regenerateAcceptanceTest(testPath, acceptanceContext: PipelineContext)` accepts any `PipelineContext`, and `src/pipeline/types.ts:83-93` documents that type's `workdir` as `join(projectDir, story.workdir)` in monorepo mode. Every *other* story-pipeline context is package-framed; this one happens not to be. The day one reaches this function, every join produces `/repo/packages/api/packages/api/src/x.ts` → 100% ENOENT.
2. **The failure is designed to be silent.** Three swallowing catches: `:270-272`, `:309-311` (`// skip unreadable files`), `:317-319` (`// git diff failed`). The result is `implementationContext === undefined`, so the stub-regeneration prompt runs with **no implementation context at all** — and regeneration is itself the last-resort recovery from a stub acceptance test (`MAX_STUB_REGENS`, `acceptance-loop.ts:456-477`). The visible symptom would be "the generator keeps emitting stubs", with no log line naming a path.
3. **Two frame assumptions on one list.** `:287-293` builds `.naxignore` matchers via `getMatchers(packageDir)` / `resolveNaxIgnorePatterns(repoRoot, packageDir)`, which judge **repo-framed** strings — which is what they correctly receive. `:302` then joins those same strings onto `workdir`. Only the current root-workdir coincidence keeps both readings true.
4. **A user's `diff.relative=true` flips the producer's frame** and breaks the join with zero diagnostics.
5. **No pathspec.** In a monorepo the 50 KB budget (`:296`) is filled by whatever diffed repo-wide, ignoring the story's package — unlike `captureOutputFiles`, which does scope.

### The fix is local

`:287` already computes `const repoRoot = acceptanceContext.projectDir ?? workdir`. The correct frame is sitting three lines above the join.

- [ ] **A1: Write the failing test**

The gap is real: `test/unit/execution/lifecycle/acceptance-loop.test.ts:582-730` is the only regeneration suite, and every case sets `workdir: tmpDir` with no `projectDir`/package split (e.g. `:614-617` asserts `expect(calledWorkdir).toBe(tmpDir)`).

Add a case where `projectDir` is the repo root and `workdir` is a package dir beneath it, and assert the implementation file is read from **the repo root**, not from `<packageDir>/<repoFramedPath>`.

- [ ] **A2: Run, confirm failure**

Run: `bun test test/unit/execution/lifecycle/acceptance-loop.test.ts`

- [ ] **A3: Implement**

Three changes in `regenerateAcceptanceTest`:
1. Resolve against `acceptanceContext.projectDir ?? workdir` (the `repoRoot` already computed at `:287`), not `workdir`.
2. Add the story's package pathspec to the diff — `captureOutputFiles` (`src/utils/git.ts:484-501`) already does this; mirror its shape.
3. **Count and log the skips instead of swallowing them.** Keep the catches, but increment a counter and emit one `warn` with the count and the first few paths. The silence is what makes this class expensive to diagnose.

- [ ] **A4: Run, confirm pass**

---

## Part B — #2087: delete the dead scoped-lint surface

**Ruling: narrow the surface, do not reframe unreachable code.**

### The contradiction (stays, documented)

`src/review/scoped-lint.ts:120` requires `relPath` **package-relative**:

```ts
120   const absPath = join(workdir, relPath);   // workdir = the PACKAGE dir
121   const exists = await _scopedLintDeps.fileExists(absPath);
```

`:124` hands the same variable to `findPackageDir(relPath, projectDir)`, which does `resolve(workdir, dirname(filePath))` and walks up (`src/test-runners/resolver.ts:262-264`) — unambiguously **repo-framed**. **No spelling of `relPath` satisfies both lines.**

It is fed a union of two differently-framed producers at `:173` — `listChangedFiles` (`--relative`, cwd = package dir → package-relative) and `getContextFiles(args.story)` (repo-rooted since #2067; nothing on the review chain calls `toPackageFrameFiles`).

### Why it cannot fire

`runScopedLintCheck`'s sole caller is `runReview` (`src/review/runner/index.ts:327`), whose only production call site is `src/execution/lifecycle/run-initialization.ts:95`:

```ts
runReview({ config: reviewConfig, workdir, executionConfig })
```

`RunReviewOptions` declares `story`, `storyGitRef`, `projectDir` as optional and **none is passed**. So the `:123` guard is false *and* the missing `storyGitRef` routes `resolveLintScope` to `degradedReason: "missing_story_git_ref"` (`:153-160`) → the degraded branch at `:250-266` runs the **full** lint. The false-green return at `:268-280` (`success: true, exitCode: 0, "lint skipped: no in-scope files"`) is unreachable.

The live per-story lint is a different operation entirely: `src/operations/lint-check.ts`, fed from `src/execution/plan-inputs.ts:304-310`. It has no scoping or frame logic.

### `runAutofixLint` is dead

Verified: the only references in the tree are its own definition at `src/review/scoped-lint.ts:374-389` and three lines in its own test — `test/unit/review/scoped-lint.test.ts:3` (import), `:144`, `:226`. Zero `src/` callers.

- [ ] **B1: Delete `runAutofixLint`**

Remove `src/review/scoped-lint.ts:374-389`, the two test cases at `test/unit/review/scoped-lint.test.ts:143-...` and `:226-...`, and the now-unused name from the import at `:3`.

- [ ] **B2: Pin the production contract**

Add a test asserting that `runReview` called the way `run-initialization.ts:95` calls it — no `story`, no `projectDir`, no `storyGitRef` — returns `degradedReason: "missing_story_git_ref"` and runs the **full** lint, never the empty-scope success.

This is the guard that makes a future re-wiring fail loudly instead of returning a false green. It is the deliverable of Part B; the deletion is the easy half.

- [ ] **B3: Leave a pointer comment**

At `scoped-lint.ts:120-125`, name #2087 and state that the two lines demand different frames and both must be re-derived before `projectDir` / `story` / `storyGitRef` are ever threaded into `runReview`. The contradiction survives; what changes is that the next person meets a warning instead of discovering it.

- [ ] **B4: Run, confirm pass**

Run: `bun test test/unit/review/`

- [ ] **B5: Comment on #2087** recording that the surface was narrowed rather than reframed, so the issue closes with an accurate record rather than looking like an unfixed frame bug.

---

## Part C — #2084: the gate

### The defect

```ts
// scripts/check-story-workdir-access.ts:48
const READ = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.workdir\b/g;
```

Requires `.workdir` immediately after a dotted-identifier receiver. Four bypasses:

1. **Optional chaining** — `story?.workdir`. Acknowledged in the file's own header at `:18-20`.
2. **Destructuring** — `const { workdir } = story` is not matched at all.
3. **Bracket access** — `story["workdir"]`.
4. **Receiver heuristic** — `isStoryReceiver` (`:51-54`) admits only receivers whose last segment ends in `story` (case-insensitive) or is exactly `s`. `const target = prd.userStories[i]; target.workdir` passes silently.

Plus **scope**: only `src/` is walked (`:29-30`, `:107`); `scripts/` is ungated.

`EXEMPT` is empty (`:46`) and `ALLOWED` has exactly four files (`:33-39`) — `src/prd/types.ts`, `src/utils/path-frame.ts`, `src/prd/schema-story.ts`, `src/prd/workdir-canonical.ts`. The gate is otherwise absolute, which is what makes the holes matter.

### No live violation exists

**Correction to the issue body:** #2084(e) overstates this. Verified — zero `["workdir"]` hits in `src/`; the single `?.workdir` hit (`src/review/review-audit.ts:326`) is on audit entries, not a story. The nearest real bypass is `src/context/builder.ts:282` `const { workdir } = storyContext` — invisible to the gate, but reading the *context* workdir, not the raw story field, so not a violation.

The exposure is forward-looking. `story.workdir` is always a string where `"."` means the repo root; `"."` is truthy and is not `""`. A fresh raw read written with a fourth "absent" idiom lands differently on the root and reintroduces a silent mis-scope. The gate exists because patching known sites leaves a tail — and a gate with four documented bypasses leaves the same tail.

- [ ] **C1: Write failing fixture-based tests**

In **`test/unit/scripts/`** (the dir exists; follow a sibling script suite's style). One fixture per bypass, asserting the gate reports a violation for each:
- `story?.workdir`
- `const { workdir } = story`
- `story["workdir"]`
- a read through a non-`*story` binding of story type

Plus a negative control: `storyWorkdir(story)` and `const { workdir } = someNonStoryOptions` must **not** be flagged. A gate that flags everything is as useless as one that flags nothing.

- [ ] **C2: Run, confirm all four currently pass the gate (i.e. the tests fail)**

- [ ] **C3: Implement the AST walk**

`typescript ^7.0.2` is already a devDependency (`package.json:91`) — use the compiler API's parser. Walk for property access (`.workdir`), element access (`["workdir"]`), optional chaining, and object binding patterns.

Key on the **declared type** rather than the receiver's name. `src/prd/types.ts:245` is the single `workdir?: string` field declaration on the story type — that is the anchor. Drop `isStoryReceiver`.

Extend the scan to `scripts/`.

Keep the script under 600 lines. If the AST logic pushes it over, split the walker into a sibling module — `scripts/` follows the same ratchet.

- [ ] **C4: Run the gate against the real tree**

Run: `bun run check:story-workdir-access`

Expect it to flag sites the regex missed. **Each one is a decision:** convert it to the accessor, or add it to `ALLOWED` with a written reason. **Do not blanket-exempt to get green** — `EXEMPT` is empty today and that is the gate's whole value.

Report what it found in the PR body, including anything you added to `ALLOWED` and why.

- [ ] **C5: Full gate, then commit all three parts**

```bash
bun run typecheck && bun run lint && bun run test
git commit -m "fix(execution,review,scripts): close the latent path-frame tail and harden the workdir gate (#2083, #2087, #2084)"
```

---

## PR body

Include these lines so all three issues close on merge:

```
Closes #2083
Closes #2087
Closes #2084
```

Also record in the body:

- **Nothing in this PR is a user-visible fix.** All three are contract defects — #2083's join is frame-correct on today's only call path, #2087's false-green is doubly unreachable, and #2084 has zero live violations. Do not write a body implying a behavioural bug was fixed; the value is that the next change cannot reintroduce the class silently.
- **#2087 was narrowed, not reframed.** `runAutofixLint` had zero production callers and was deleted; the frame contradiction at `scoped-lint.ts:120-125` survives behind a pointer comment and a test pinning the `runReview` degraded-path contract. Comment on the issue to the same effect so it closes with an accurate record.
- **What the hardened gate found.** List every site the AST walk flagged that the regex missed, and for each: converted, or added to `ALLOWED` with a reason. `EXEMPT` must still be empty — if it is not, say why.
- **The two issue-body corrections** (#2083(e), #2084(e)) are already applied upstream as appended correction blocks.

---

## Done when

- Acceptance regeneration resolves against the repo root, scopes its diff, and logs skips with a count.
- `runAutofixLint` is gone and the `runReview` degraded-path contract is pinned by a test.
- The gate catches all four bypass idioms, keys on type rather than name, covers `scripts/`, and `EXEMPT` is still empty.
- The two issue-body corrections (#2083(e), #2084(e)) are applied upstream.
