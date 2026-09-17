# PR 1 — Pin the real `runReview` contract, restore `out_of_scope` coverage

**Follow-up 6 (P2). Findings: H3.**
**Base:** `origin/main` @ `6507cf061`. Independent of `fix/path-frame-p0-p1` — no file overlap.
**Branch:** `fix/review-contract-pin`

## The problem

PR #2102 (`8cae0c3cd`) deleted `runAutofixLint` as dead code. Ruling 2 said the deletion was the easy half; the **deliverable** was a contract pin proving that `runReview`, called as production calls it, routes through the `missing_story_git_ref` arm and runs the full lint rather than the empty-scope false-green at `scoped-lint.ts:268-280`.

What shipped (`test/unit/review/scoped-lint.test.ts:230-252`) does not do that.

```ts
test("runReview call shape: no story/projectDir/storyGitRef/scope degrades to full lint", async () => {
  ...
  const result = await runScopedLintCheck({          // <-- not runReview
    resolvedLintCommand: "eslint --max-warnings=0",
    configCommands: baseReviewConfig.commands,
    qualityCommands: {},
    workdir: "/repo",                                // <-- hardcoded, not the production shape
  });

  expect(result.lintScope?.status).toBe("degraded"); // <-- not degradedReason
```

Two independent defects:

1. **It calls the wrong function.** `runReview` is never invoked, so the test's own comment — *"If a future re-wire threads story/projectDir/storyGitRef into runReview, this test must fail loudly"* — cannot hold. The production call site is `src/execution/lifecycle/run-initialization.ts:36-37`:

   ```ts
   runReview: (reviewConfig: ReviewConfig, workdir: string, executionConfig: NaxConfig["execution"]) =>
     runReview({ config: reviewConfig, workdir, executionConfig }),
   ```

   No `story`, no `projectDir`, no `storyGitRef`, no `scope`. That is the shape to pin.

2. **It asserts the wrong field.** `status: "degraded"` is satisfied by any degraded arm — `failed_to_compute_diff` (`scoped-lint.ts:180`) or `unsupported_scoped_command_shape` (`:329`) pass it just as well. Verified: `grep -rn missing_story_git_ref src/ test/` returns exactly two hits — `src/review/scoped-lint.ts:170` and one **inside a comment** in this test. The string the pin exists to guarantee is asserted nowhere.

Separately, deleting the `runAutofixLint` shim took the only `out_of_scope` coverage with it. The deleted test asserted `lintScope.status === "out_of_scope"`, `packageGroups`, and the output message, reaching them *through* the shim — but the shim was a pure forward (`return runScopedLintCheck(args)`), so retargeting it was a one-line change. Instead it was deleted wholesale. `grep -rln out_of_scope test/` now returns only `ac-quote-validator.test.ts`, an unrelated code. The `out_of_scope` arm at `scoped-lint.ts:363` is untested.

## Relevant code

- `src/review/runner/index.ts:351` — `export async function runReview(opts: RunReviewOptions)`
- `src/review/scoped-lint.ts:170` — the `missing_story_git_ref` arm
- `src/review/scoped-lint.ts:363` — the `out_of_scope` arm
- `src/review/scoped-lint.ts:262-330` — the degraded/in-scope branch structure
- `src/execution/lifecycle/run-initialization.ts:33-39` — `_reconcileDeps`, the production call shape

`src/review/scoped-lint.ts` is 391/600 — headroom is fine.

## Steps

### 1. Reproduce the hole (RED)

Before writing anything, prove the current test cannot detect a re-wire. Temporarily thread `storyGitRef` into the `runReview` call at `run-initialization.ts:37` and run `test/unit/review/scoped-lint.test.ts`. It stays green. Capture that output — it is the justification for this PR. **Revert the probe.**

### 2. Write the real contract pin

Replace the test at `:230-252` with one that calls **`runReview`** with exactly the production argument shape (`{ config, workdir, executionConfig }` and nothing else) and asserts:

- `degradedReason === "missing_story_git_ref"` — the specific string, not the status
- the full lint command actually ran (the existing `runMock` assertion is fine here)

Reach `runReview` the way production does: `import { runReview } from "@/review/runner"` — note the header comment at `run-initialization.ts:19-23` explaining why it is a sub-barrel import and deliberately not on the `@/review` barrel (cycle through `@/prompts` → `review-builder.ts`). Tests are exempt from the barrel rule, but do not "fix" that import.

Mock at the same seam the existing test does (`_scopedLintDeps.runLintCommand`) so you are not spawning a real linter. Save and restore any `_deps` you mutate, per `test-architecture.md`.

Make the intent explicit in the test name and a short comment: **this test must fail if `story`, `projectDir`, `storyGitRef` or `scope` is ever threaded into that call site.**

### 3. Verify the pin actually bites

Re-apply the step-1 probe. The new test must now **fail**. Paste that output. Revert the probe and confirm GREEN.

This is the step that distinguishes this PR from the one it replaces. Do not skip it.

### 4. Restore `out_of_scope` coverage

Recover the deleted test from git — `RTK_DISABLED=1 git show 8cae0c3cd^:test/unit/review/scoped-lint.test.ts` — find the case named roughly *"dogfood replay shape: sibling-package lint debt is reported as out_of_scope"*, and retarget it from the deleted shim onto `runScopedLintCheck` with the same arguments the shim forwarded. Keep its assertions on `lintScope.status === "out_of_scope"`, `packageGroups`, and the output message.

Confirm it fails if you stub the `out_of_scope` arm to return `in_scope`, so you know it is testing the arm and not just the happy path.

### 5. Gates

```
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```

Paste all four outputs. `scoped-lint.ts` gains no production lines here, so the per-file floor should be unaffected — confirm rather than assume.

## Done when

- [ ] A test invokes `runReview` with the production argument shape and asserts `degradedReason === "missing_story_git_ref"`.
- [ ] That test **fails** when `storyGitRef` is threaded into `run-initialization.ts:37`, with the failure output pasted.
- [ ] `out_of_scope` has a test again; `grep -rln out_of_scope test/` returns a scoped-lint test file.
- [ ] The vacuous `status === "degraded"` assertion is gone or upgraded.
- [ ] All four gates pasted and read.

## Do not

- Do not re-add `runAutofixLint`. Ruling 2 stands and the deletion was independently verified correct — zero callers in `src/`, `test/`, `scripts/`, `bin/`, no dynamic dispatch, no orphaned config keys or types (`AutofixLintScope` remains live via `ScopedLintArgs.scope`).
- Do not touch the `FIXME(#2087)` frame-contradiction comment at `scoped-lint.ts:120-131`. Its line references (132 / 136) were re-verified and are **correct**. The contradiction it describes is only reachable once `projectDir`/`story`/`storyGitRef` are threaded into `runReview` — which is exactly what this PR's pin is designed to catch. Leave the comment; it is the hand-off note for that future change.

## PR body

```
fix(review): pin the real runReview contract and restore out_of_scope coverage

#2102 deleted runAutofixLint but shipped the wrong half of Ruling 2. The
"contract pin" it added calls runScopedLintCheck directly with hardcoded
args -- runReview is never invoked -- and asserts lintScope.status rather
than degradedReason, which any degraded arm satisfies. The string it exists
to guarantee, missing_story_git_ref, was asserted nowhere in test/.

The pin now calls runReview with the production argument shape from
run-initialization.ts and asserts degradedReason directly. Verified it
fails when storyGitRef is threaded into that call site, which is the
re-wire the original comment claimed to guard against.

Deleting the shim also took the only out_of_scope coverage with it; that
test is restored against runScopedLintCheck.
```

No `Closes` line unless you file the finding as an issue first. Reference `nax-path-frame-seam-closure-review-2026-09-17.md` finding H3 in the body if you do not.
