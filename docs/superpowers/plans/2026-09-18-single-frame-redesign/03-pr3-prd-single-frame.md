# PR 3: PRD Single Frame — Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Close #2125 (the mixed-frame PRD) by making `nax plan`'s output unconditionally
repo-rooted: the planner prompts stop asking for workdir-relative paths, the
write-time canonicalizer stops gating on filesystem existence (Ruling R3 of the
design), `modifiedFiles` joins the same reframe seam it was excluded from, the
schema documents the frame as a plan-WRITE-time contract (not a `PRD.parse()`
contract — legacy and hand-edited PRDs keep loading), and the spec-authoring /
spec-lint guidance that still assumes workdir-relative `### Context Files` /
`### Modifies` declarations is corrected. `src/context/builder.ts`'s `canonical`
branch and `reclassifyPlanTimeAbsentEntries` (the H4 residual) become
unreachable in their disambiguating case for freshly-canonicalized PRDs, but the
code is **not deleted or restructured** here — deletion is PR 4's job, and the
tolerant legacy-read branch (keyed off `workdirSource`) must keep working for
PRDs canonicalized before this PR shipped.

This PR does **not** touch `codingToolRoot`, ACP spawn cwd, `agent-scope.ts`,
`--relative` injections, or any other PR 2 concern. PR 1 and PR 2 have not
landed on this integration branch yet (verified: `git log main..HEAD` shows
only the two design-spec doc commits `1989f87a0` and `940be7f0d`), so this plan
is written against **today's pre-PR-1/PR-2 source** and calls out every place
it depends on a PR 2 behavior that does not exist yet.

## Architecture

Write path (today, and after this PR — shape unchanged, behavior changed):

```
nax plan
  → planOp / planRefineOp / pipeline / debate strategies produce a draft PRD
  → finalizeAndWritePrd()                     [src/plan/strategies/persist-prd.ts]
      1. applyPlanFidelity()                  [src/operations/plan-fidelity.ts]
           - backfillOutOfScope
           - backfillModifiedFiles            <- attaches spec `### Modifies` (still spec-frame at this point)
           - warnOnDroppedContextFiles        <- compares spec `### Context Files` vs story.contextFiles
      2. canonicalizePrdWorkdirs()            [src/prd/workdir-canonical.ts]  <- THIS PR's core change
           - deriveWorkdir / resolvePathOwners (unchanged: still existence-probed selector logic)
           - canonicalizeDeclaredPath (UNCONDITIONAL pure-string normalize — no probe)
           - NEW: reframes story.modifiedFiles the same way as contextFiles/expectedFiles
      3. NEW: findNonCanonicalDeclaredPaths() <- plan-WRITE-time validation, warns only
      4. finalizePrdRouting()
      5. writeFile(outputPath, ...)
```

Read path (`src/context/builder.ts`) is untouched by this PR — see Task 5.

## Tech Stack

Bun + TypeScript strict, `bun:test`, Biome. DI via `_deps` objects (no
`mock.module`). Prompt text only in `src/prompts/builders/`.

## Spec:

`docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` §4 "PR 3 —
PRD single frame (closes #2125)".

## Global Constraints

- Source files stay ≤600 lines, tests ≤800 lines (`bun run check:file-sizes`).
  Current sizes verified by `wc -l` before this plan was written:
  `src/prd/schema-story.ts` 511, `src/prd/workdir-canonical.ts` 215,
  `src/prompts/builders/plan-builder.ts` 561, `src/prompts/builders/decompose-builder.ts` 210,
  `src/plan/strategies/persist-prd.ts` 167, `src/prd/spec-lint.ts` 454,
  `src/operations/plan-fidelity.ts` 194, `src/utils/path-frame.ts` 199,
  `src/context/builder.ts` 521, `test/unit/prd/workdir-canonical.test.ts` 323,
  `test/unit/context/builder-parent-frame.test.ts` 388. `plan-builder.ts` is
  closest to its cap (561/600, only 39 lines of headroom) — Task 1 edits strings
  in place and must not add new top-level constants; if it grows past 600, split
  `buildSharedQualityRules`/`buildFileReadInstruction`/`buildPackageDetailsSection`
  into a new `src/prompts/builders/plan-builder-helpers.ts` leaf module.
- DI `_deps` pattern for every external call (fs, logger). No `mock.module()`.
- `bun run typecheck && bun run lint && bun run test` must pass before any
  commit that isn't itself a RED-test commit. Never bare `bun test` for the
  suite. `bun run test:coverage` is run once at the end (not part of `check:all`
  — [[feedback-nax-test-coverage-is-not-in-check-all]]).
- Every test written FIRST must be run and shown to FAIL for the stated reason
  (not a syntax error, not a vacuous pass) before the implementation step.
- `modifiedFiles` is an authorization list: a reframe must never drop an entry
  silently. `applyPlanFidelity` already logs `orphans`/`invalidPaths` before
  canonicalization runs — canonicalization itself must not introduce a second,
  silent drop path. If a `modifiedFiles.path` cannot be reframed (should not
  happen with a pure string function, but assert it), log and keep the
  original path rather than dropping the entry.
- No hardcoded `.claude/rules/` edits — `.claude/rules/*.md` is a generated
  mirror of `.nax/rules/*.md` (`nax generate`, `check:rules-drift`). This plan
  never needs a rules change, so this is a boundary note only.

---

## Task 1 — Planner prompts emit repo-rooted paths

**Files:**
- `src/prompts/builders/plan-builder.ts` (verified 561 lines) — `CONTEXT_VS_EXPECTED_FILES_RULE` (:56-58), `workdirField` in `build()` (:325-326) and `buildDraft()` (:460-461), the `contextFiles`/`expectedFiles` schema lines in `build()`'s output schema (:399-400, `EXPECTED_FILES_SCHEMA_FIELD` at :61) and `buildDraft()`'s output schema (:511-512).
- `src/prompts/builders/decompose-builder.ts` (verified 210 lines) — `contextFiles` example at :30 (`DECOMPOSE_SPEC_SCHEMA`) and :50 (`DECOMPOSE_PLAN_SCHEMA`), and item 8 of `SPEC_DECOMPOSE_INSTRUCTIONS` (:74).
- `test/unit/prompts/builders/plan-builder.test.ts`, `test/unit/prompts/builders/decompose-builder.test.ts` (existence verified below in step 1.1).

**Interfaces:**
- Consumes: nothing new — pure string-template edits to existing exported classes (`PlanPromptBuilder`, `buildDecomposePromptSync`/`buildDecomposePromptAsync`). No signature changes.
- Produces: no new exports. `PlanPromptBuilder.build()` / `.buildDraft()` and `buildDecomposePromptSync`/`buildDecomposePromptAsync` return the same `PlanningPromptParts` / `string` shapes with different prompt text.

### Steps

- [ ] 1.1 Confirm the existing prompt-text test coverage and its current assertions.
  ```bash
  RTK_DISABLED=1 git status --short  # confirm clean before starting
  ls test/unit/prompts/builders/plan-builder.test.ts test/unit/prompts/builders/decompose-builder.test.ts
  grep -n "relative to\|workdir\|CONTEXT_VS_EXPECTED" test/unit/prompts/builders/plan-builder.test.ts
  ```
  If `plan-builder.test.ts` does not exist, create it (it is the natural home
  for this assertion — do not add a new file for one string check).

- [ ] 1.2 RED — add a failing test asserting the new repo-rooted wording is
  present and the old workdir-relative wording is gone, in
  `test/unit/prompts/builders/plan-builder.test.ts`:
  ```typescript
  import { describe, expect, test } from "bun:test";
  import { PlanPromptBuilder } from "@/prompts/builders/plan-builder";

  describe("PlanPromptBuilder — repo-rooted path frame (single-frame redesign)", () => {
    test("build() states contextFiles/expectedFiles are repo-rooted, not workdir-relative", () => {
      const builder = new PlanPromptBuilder();
      const { taskContext } = builder.build("spec content", "codebase context", "/tmp/out.json", [
        "packages/api",
      ]);
      expect(taskContext).toContain("relative to the REPO ROOT");
      expect(taskContext).not.toContain("relative to this story's `workdir` when it has one");
    });

    test("build() workdirField no longer tells the planner paths are workdir-relative", () => {
      const builder = new PlanPromptBuilder();
      const { outputFormat } = builder.build("spec", "ctx", "/tmp/out.json", ["packages/api"]);
      expect(outputFormat).not.toContain("Paths in contextFiles and expectedFiles are relative to THIS workdir");
      expect(outputFormat).toContain("Paths in contextFiles and expectedFiles are relative to the REPO ROOT");
    });

    test("buildDraft() carries the same repo-rooted wording as build()", () => {
      const builder = new PlanPromptBuilder();
      const { task } = builder.buildDraft({
        manifestSection: "m",
        specContent: "s",
        codebaseContext: "c",
        feature: "f",
        branchName: "b",
        citationThreshold: 0.8,
        packages: ["packages/api"],
      });
      expect(task.content).toContain("relative to the REPO ROOT");
      expect(task.content).not.toContain("Paths in contextFiles and expectedFiles are relative to THIS workdir");
    });
  });
  ```
  Run: `bun test test/unit/prompts/builders/plan-builder.test.ts --timeout=30000`.
  FAIL reason expected: `expect(taskContext).toContain("relative to the REPO ROOT")` fails
  because the current text reads "relative to this story's `workdir` when it
  has one, and to the repo root otherwise" and the workdirField sentence still
  says "relative to THIS workdir".

- [ ] 1.3 IMPL — edit `CONTEXT_VS_EXPECTED_FILES_RULE` (plan-builder.ts :56-58).
  Replace the final sentence of the rule (currently: `"A single path may appear
  in \`contextFiles\` ... Every path in both fields is relative to this story's
  \`workdir\` when it has one, and to the repo root otherwise."`) with:
  ```typescript
  const CONTEXT_VS_EXPECTED_FILES_RULE = `**\`contextFiles\` rule — files readable when this story runs.** List paths that already exist in the repo today, PLUS any file an UPSTREAM dependency story creates (it does not exist now but will exist by the time this story runs, because dependencies execute first). The pipeline verifies every \`contextFiles\` entry against the filesystem; a path that exists neither on disk nor in an upstream dependency's outputs is treated as a missing-context warning.

  **\`expectedFiles\` rule — files THIS story CREATES.** List every NEW file this story authors. A file this story creates belongs here, NEVER in \`contextFiles\` — these are the story's outputs, not files to read first. A file created by an upstream dependency and only read/modified here belongs in \`contextFiles\`, NOT here (this story does not author it). A single path may appear in \`contextFiles\` (an existing sibling to mirror) AND \`expectedFiles\` (the new file itself), but the same path must never be in both. Every path in both fields is relative to the REPO ROOT — including a file this story creates inside its own \`workdir\` package (e.g. a story scoped to \`packages/api\` that creates \`src/routes/users.ts\` writes \`packages/api/src/routes/users.ts\`, never the bare \`src/routes/users.ts\`).`;
  ```

- [ ] 1.4 IMPL — edit `workdirField` (plan-builder.ts :325-326, and the
  identical string in `buildDraft()` :460-461). Replace the trailing sentence
  `"Paths in contextFiles and expectedFiles are relative to THIS workdir."`
  with `"Paths in contextFiles and expectedFiles are relative to the REPO
  ROOT, not to this workdir."` in both occurrences.

- [ ] 1.5 IMPL — edit the output-schema field descriptions to state the frame
  explicitly:
  - `EXPECTED_FILES_SCHEMA_FIELD` (:61): `"expectedFiles": ["string — NEW files this story creates (repo-rooted relative paths, omit if none)"],`
  - `build()`'s contextFiles schema line (:399): `"contextFiles": ["string — EXISTING source files the agent should read (max 5, repo-rooted relative paths)"],`
  - `buildDraft()`'s contextFiles schema line (:511): `"contextFiles": ["string — EXISTING repo-rooted relative paths the implementer should read (max 5)"],`

- [ ] 1.6 RUN — `bun test test/unit/prompts/builders/plan-builder.test.ts --timeout=30000`.
  PASS expected: all three new tests green, and every pre-existing test in the
  file still green (grep the file first for any test asserting the OLD wording
  literally — e.g. a test that does `toContain("relative to this story's
  \`workdir\`")` — and update it to the new wording; do not leave a test
  pinning removed prompt text).

- [ ] 1.7 RED — `decompose-builder.ts` example/rule text, in
  `test/unit/prompts/builders/decompose-builder.test.ts`:
  ```typescript
  test("spec-mode instructions state contextFiles is repo-rooted", () => {
    const prompt = buildDecomposePromptSync({ specContent: "spec", codebaseContext: "ctx" });
    expect(prompt).toContain("repo-rooted");
  });
  ```
  Add alongside existing tests in that file (create it if absent, mirroring
  the pattern in plan-builder.test.ts). FAIL reason: current
  `SPEC_DECOMPOSE_INSTRUCTIONS` item 8 reads `"contextFiles: Array of file
  paths to inject into agent prompt before execution"` with no frame
  statement.

- [ ] 1.8 IMPL — edit `SPEC_DECOMPOSE_INSTRUCTIONS` item 8 (decompose-builder.ts :74):
  ```typescript
  8. contextFiles: Array of REPO-ROOTED relative file paths to inject into agent prompt before execution
  ```
  Leave the two `DECOMPOSE_SPEC_SCHEMA`/`DECOMPOSE_PLAN_SCHEMA` example arrays
  (`contextFiles: ["src/path/to/file.ts"]`, lines 30 and 50) as-is — a single
  bare example path is frame-ambiguous either way and the instructional text
  now carries the frame statement; do not over-specify the example into
  `["packages/api/src/path/to/file.ts"]`, which would misleadingly imply every
  decompose target is monorepo-scoped.

- [ ] 1.9 RUN — `bun test test/unit/prompts/builders/decompose-builder.test.ts --timeout=30000`.
  PASS expected.

- [ ] 1.10 COMMIT — `git add src/prompts/builders/plan-builder.ts src/prompts/builders/decompose-builder.ts test/unit/prompts/builders/plan-builder.test.ts test/unit/prompts/builders/decompose-builder.test.ts && RTK_DISABLED=1 git commit -m "feat(prompts): planner emits repo-rooted contextFiles/expectedFiles paths"`.

---

## Task 2 — Unconditional canonicalization; `modifiedFiles` joins the seam

**Files:**
- `src/prd/workdir-canonical.ts` (verified 215 lines) — `canonicalizeDeclaredPath` (:95-107), `canonicalizePrdWorkdirs` (:154-215).
- `src/plan/strategies/persist-prd.ts` (verified 167 lines) — collision/rootOnly logging (:108-124).
- `src/debate/verifiers/checks.ts` — `checkFilesExist` call site (:39), only production consumer of `canonicalizeDeclaredPath` besides `workdir-canonical.ts` itself (verified via `grep -rn canonicalizeDeclaredPath src/`).
- `src/utils/path-frame.ts` (verified 199 lines) — `toRepoFrame` (:85-91), reused as the pure re-spell.
- `test/unit/prd/workdir-canonical.test.ts` (verified 323 lines) — `canonicalizeDeclaredPath` describe block (:88-141) and every `canonicalizePrdWorkdirs` test that reads `collided`/`rootOnly` (:210-249).
- `test/unit/debate/verifiers/checks.test.ts` (verified 327 lines exists) — call-site signature update.
- Doc-comment corrections in files this task FALSIFIES (one sentence each; if
  PR 2 has already rewritten/removed the passage, skip that item):
  `src/prompts/sections/story.ts:27-31` ("the write seam never touches
  `modifiedFiles`" — false after this task; correct to "the write seam
  reframes `modifiedFiles` to the repo frame since the single-frame
  redesign"), `src/utils/path-frame.ts` `partitionPackageFrame` docblock
  (~:110-135, "Never use it on create-intent `expectedFiles`, whose
  package-relative spelling is legal" — false once `expectedFiles` are
  unconditionally repo-rooted; qualify it as describing pre-redesign PRDs
  only), and `src/context/builder.ts:401-403` (the adjacent paragraph making
  the same claim). These files are otherwise untouched by this task — edit
  ONLY the falsified sentences, since leaving them contradicting the code
  this PR ships would mislead the next reader.

**Interfaces:**
- Produces (breaking change, both call sites in this repo updated in this task):
  ```typescript
  // BEFORE
  export function canonicalizeDeclaredPath(
    path: string, workdir: string, repoRoot: string, exists: ExistsProbe,
  ): { path: string; collided: boolean; rootOnly: boolean };

  // AFTER
  export function canonicalizeDeclaredPath(path: string, workdir: string): string;
  ```
  ```typescript
  // canonicalizePrdWorkdirs signature is UNCHANGED (repoRoot/packages/exists
  // still required — see rationale in step 2.1) but its return type drops the
  // two fields that only existed to report the now-impossible collided/rootOnly
  // outcomes:
  export function canonicalizePrdWorkdirs(
    prd: PRD, repoRoot: string, packages: readonly string[], exists: ExistsProbe,
    opts?: CanonicalizeOptions,
  ): { prd: PRD; defaulted: string[] };
  ```
- Consumes: `toRepoFrame` from `@/utils/path-frame` (unchanged signature,
  `(path: string, workdir: string | null | undefined) => string`).

### Rationale for deleting `collided`/`rootOnly` rather than keeping them

Both fields exist today because `canonicalizeDeclaredPath` probes the
filesystem: `collided` fires when a path resolves at BOTH the package dir and
the repo root; `rootOnly` fires when a path resolves ONLY at the repo root.
Both are properties of comparing two `exists()` calls. Once the function is a
pure string re-spell (R3: "no existence probe"), there is nothing left to
compare — the function cannot observe two different resolutions, so it cannot
distinguish "collided" from "not collided" or "rootOnly" from "not rootOnly".
Keeping the fields and hardcoding them to `false` would be worse than deleting
them: a dead field that always reads `false` looks like a real signal to the
next reader and one of them (`rootOnly`) currently drives a real warning in
`persist-prd.ts` that would silently go permanently dark instead of being
visibly removed.

### Steps

- [ ] 2.1 RED — pure re-spell behavior for `canonicalizeDeclaredPath`, replacing
  the `describe("canonicalizeDeclaredPath", ...)` block in
  `test/unit/prd/workdir-canonical.test.ts` (:88-141):
  ```typescript
  describe("canonicalizeDeclaredPath — unconditional pure-string normalization (single-frame redesign)", () => {
    test("re-spells a package-relative path without touching disk", () => {
      expect(canonicalizeDeclaredPath("src/a.ts", "packages/app")).toBe("packages/app/src/a.ts");
    });

    test("leaves an already repo-rooted path alone", () => {
      expect(canonicalizeDeclaredPath("packages/app/src/a.ts", "packages/app")).toBe("packages/app/src/a.ts");
    });

    test("re-spells a path that will not exist until this story creates it", () => {
      // No exists() probe is passed at all — the old signature required one.
      expect(canonicalizeDeclaredPath("src/new.ts", "packages/app")).toBe("packages/app/src/new.ts");
    });

    test("is a no-op at the repo root", () => {
      expect(canonicalizeDeclaredPath("src/a.ts", ".")).toBe("src/a.ts");
    });

    test("does not slice a package whose name extends another", () => {
      // "packages/app" must not treat "packages/application/x.ts" as already-framed.
      expect(canonicalizeDeclaredPath("packages/application/x.ts", "packages/app")).toBe(
        "packages/app/packages/application/x.ts",
      );
    });
  });
  ```
  Delete the two tests that asserted `collided: true` ("story-local wins when
  both spellings exist...") and `rootOnly: true` ("flags a path that exists
  only at the repo root...") — those outcomes are no longer producible; keeping
  them as skipped/xfail tests would misrepresent the function's contract.
  Run: `bun test test/unit/prd/workdir-canonical.test.ts --timeout=30000`.
  FAIL reason expected: TypeScript type error / runtime mismatch — current
  `canonicalizeDeclaredPath` requires 4 args and returns an object, not a
  string; `.toBe(...)` against an object fails, and the 2-arg call fails typecheck.

- [ ] 2.2 IMPL — rewrite `canonicalizeDeclaredPath` in `workdir-canonical.ts`:
  ```typescript
  /**
   * Re-spell a declared path into the repo frame (R3, single-frame redesign).
   *
   * Unconditional pure-string normalization — no existence probe. Before this
   * change the function probed the filesystem to decide whether a workdir-
   * relative-looking path should be re-spelled, which is exactly the mechanism
   * that produced #2125's mixed-frame PRD: a path absent at plan time (because
   * the story creates it) was left workdir-relative rather than repo-rooted.
   * The planner now emits repo-rooted paths directly (src/prompts/builders/
   * plan-builder.ts, decompose-builder.ts), so this is a defensive re-spell for
   * a stray package-relative spelling, not a disambiguation — there is nothing
   * left to disambiguate. Delegates to toRepoFrame, which already implements
   * the identical segment-boundary-safe re-spell; kept as a distinct named
   * export because src/debate/verifiers/checks.ts and this module's own
   * canonicalizePrdWorkdirs both call it as "the PRD write-time re-spell",
   * a narrower and more discoverable name than the general-purpose toRepoFrame.
   */
  export function canonicalizeDeclaredPath(path: string, workdir: string): string {
    return toRepoFrame(path, workdir);
  }
  ```
  Remove the now-unused `join` import if `ExistsProbe`/`resolvePathOwners`/
  `deriveWorkdir` no longer need it — they still do (see step 2.3), so `join`
  stays imported for those.

- [ ] 2.3 IMPL — update `canonicalizePrdWorkdirs` (:154-215):
  - `deriveWorkdir`/`resolvePathOwners` and the `exists`/`repoRoot`/`packages`
    parameters are UNCHANGED — they are selector logic (workdir derivation for
    a story that stated none), ruled explicitly out of scope for this PR
    (design §2 Decision, "R3... `modifiedFiles` joins the same seam" is about
    the reframe, not derivation; design §4 PR3 bullet 1 only names the
    planner/canonicalizeDeclaredPath/modifiedFiles/schema/spec-lint/builder.ts
    surfaces). Task 3.7 below covers verifying this explicitly.
  - Update the `reframe` closure to call the new 2-arg signature:
    ```typescript
    const reframe = (path: string): string => canonicalizeDeclaredPath(path, workdir);
    ```
  - Delete the `collisions`/`rootOnly` local arrays, the `if (result.collided)`
    / `if (result.rootOnly)` pushes inside `reframe`, and the corresponding
    keys on the returned object. Update the JSDoc above the function (:109-127)
    to remove the two paragraphs that describe `collided`/`rootOnly` — replace
    with one sentence: "Re-spelling is now a pure function of `path` and
    `workdir`; there is no longer a filesystem-dependent ambiguity to report."
  - Add `modifiedFiles` reframing, alongside the existing `contextFiles`/`expectedFiles` mapping:
    ```typescript
    const modifiedFiles = story.modifiedFiles?.map((entry) => ({ ...entry, path: reframe(entry.path) }));
    ```
    and add `...(modifiedFiles !== undefined ? { modifiedFiles } : {})` to the
    returned story object, mirroring the existing `contextFiles`/`expectedFiles`
    spread pattern exactly.
  - New signature: `{ prd: PRD; defaulted: string[] }`.

- [ ] 2.4 IMPL — update `persist-prd.ts` (:96-137):
  Remove the `if (result.collisions.length > 0)` and `if (result.rootOnly.length > 0)`
  warning blocks entirely (the underlying conditions can no longer fire).
  Keep the `defaulted` warning block unchanged. Update the destructure:
  `const result = canonicalizePrdWorkdirs(...)` still returns `{ prd, defaulted }`
  — update `canonical = result.prd;` unchanged, drop dead references.

- [ ] 2.5 IMPL — update `checks.ts` (:39):
  ```typescript
  const canonical = canonicalizeDeclaredPath(filePath, storyDir);
  ```
  Update the function-level docblock (:20-27) — the phrase "the planner emits
  package-relative paths for monorepo stories before the write seam has
  canonicalized them" is now only true for a spec authored under the OLD
  convention; add: "Post-single-frame-redesign the planner emits repo-rooted
  paths directly, so this re-spell is a defensive no-op for a well-formed
  draft — kept because `checkFilesExist` runs on the PRE-write-seam draft
  during debate verification, before `canonicalizePrdWorkdirs` has run."
  `deps?: CheckDeps` and the `existsSync` usage on the following line are
  UNCHANGED — that probe is `checkFilesExist`'s own existence check, unrelated
  to the deleted probe inside `canonicalizeDeclaredPath`.

- [ ] 2.6 IMPL — update every remaining `canonicalizePrdWorkdirs` test in
  `workdir-canonical.test.ts` (:169-249) that destructures `collisions` or
  `rootOnly`:
  - Delete `test("reports a collision without failing", ...)` and
    `test("reports a root-only declared path so the plan can warn", ...)` —
    both assert an outcome that can no longer occur.
  - In `test("derives a workdir and re-spells the story's declared paths", ...)`,
    change the assertion for `expectedFiles` from `toEqual(["src/b.ts"])`
    (unchanged — "does not exist yet, so it stays as authored", now WRONG)
    to `toEqual(["packages/app/src/b.ts"])`, and update the trailing comment
    to: "// unconditional re-spell now covers create-intent paths too".
  - Add a new test proving `modifiedFiles` reframes identically to
    `contextFiles`:
    ```typescript
    test("reframes modifiedFiles the same way as contextFiles", () => {
      const { prd } = canonicalizePrdWorkdirs(
        prdOf([
          makeStory({
            workdir: "packages/app",
            modifiedFiles: [{ path: "src/existing.ts", reason: "fix off-by-one" }],
          }),
        ]),
        REPO,
        PACKAGES,
        probeOf(),
      );
      expect(prd.userStories[0]?.modifiedFiles).toEqual([
        { path: "packages/app/src/existing.ts", reason: "fix off-by-one" },
      ]);
    });
    ```
  - Add a return-SHAPE assertion so the deleted fields cannot survive as
    stubbed empties (the exact anti-pattern the Rationale above bans —
    `collisions: []`/`rootOnly: []` would otherwise pass every test and grep
    in this plan):
    ```typescript
    test("the result carries exactly { prd, defaulted } — collisions/rootOnly are gone, not stubbed", () => {
      const result = canonicalizePrdWorkdirs(prdOf([makeStory({ workdir: "packages/app" })]), REPO, PACKAGES, probeOf());
      expect(Object.keys(result).sort()).toEqual(["defaulted", "prd"]);
    });
    ```

- [ ] 2.7 RED — cross-fs-state idempotency test (design §6, "the key spec test").
  Add to `workdir-canonical.test.ts`:
  ```typescript
  describe("canonicalizePrdWorkdirs — frame is independent of disk state (single-frame redesign, design §6)", () => {
    test("the same PRD canonicalized against two different fake-fs states yields byte-identical declared-path frames", () => {
      const story = makeStory({
        workdir: "packages/app",
        contextFiles: ["src/a.ts"],
        expectedFiles: ["src/new.ts"],
        modifiedFiles: [{ path: "src/b.ts", reason: "r" }],
      });
      const prd = prdOf([story]);

      // Tree state A: everything declared already exists.
      const treeA = probeOf("packages/app/src/a.ts", "packages/app/src/new.ts", "packages/app/src/b.ts");
      // Tree state B: NOTHING exists yet (a freshly-checked-out branch before the story ran).
      const treeB = probeOf();

      const resultA = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, treeA, { derive: false });
      const resultB = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, treeB, { derive: false });

      expect(JSON.stringify(resultA.prd)).toBe(JSON.stringify(resultB.prd));
    });
  });
  ```
  Note on `derive: false`: for THIS test it is inert — the story STATES
  `workdir: "packages/app"`, and `decideWorkdir` (workdir-canonical.ts:168-173)
  only calls `deriveWorkdir` (the disk-probing selector) when the workdir is
  unstated. The flag documents intent, nothing more. To actually cover the
  ruled exception (workdir SELECTION may read disk; the REFRAME may not —
  design §2 "Selector"), add a second variant with an UNSTATED workdir:
  ```typescript
  test("with an unstated workdir and derive disabled, output is still disk-state-independent", () => {
    const story = makeStory({ contextFiles: ["packages/app/src/a.ts"] }); // no workdir stated
    const prd = prdOf([story]);
    const resultA = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf("packages/app/src/a.ts"), { derive: false });
    const resultB = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf(), { derive: false });
    expect(JSON.stringify(resultA.prd)).toBe(JSON.stringify(resultB.prd));
  });
  ```
  (With `derive: true` and an unstated workdir, output MAY legitimately differ
  across disk states — that is the selector's documented, ruled exception,
  not a defect this PR fixes.)
  Run: `bun test test/unit/prd/workdir-canonical.test.ts --timeout=30000`.
  FAIL reason expected (before step 2.2/2.3 land): the old existence-gated
  `canonicalizeDeclaredPath` produces DIFFERENT output for treeA (paths exist →
  re-spelled) vs treeB (paths absent → left unchanged), so
  `JSON.stringify(resultA.prd) !== JSON.stringify(resultB.prd)`. If this test
  is run AFTER 2.2/2.3 land, temporarily verify it fails first by reverting
  2.2/2.3 locally (or trust the ordering below — this step is listed before
  2.2/2.3's RED requirement is satisfied only in the sense that 2.1's RED
  already exercises the same underlying function; run this specific test
  standalone before touching the implementation to confirm the fail mode
  described above).

- [ ] 2.8 IMPL — this test passes as a consequence of steps 2.2–2.3; no
  additional implementation.

- [ ] 2.9 RUN — `bun test test/unit/prd/workdir-canonical.test.ts test/unit/debate/verifiers/checks.test.ts --timeout=30000`.
  PASS expected for all tests in both files, including every pre-existing test
  not touched above (re-verify none of them asserted the deleted
  `collided`/`rootOnly` shape — grep the checks.test.ts file for
  `canonicalizeDeclaredPath` usages beyond the production call site to confirm).

- [ ] 2.10 COMMIT — `git add src/prd/workdir-canonical.ts src/plan/strategies/persist-prd.ts src/debate/verifiers/checks.ts test/unit/prd/workdir-canonical.test.ts && RTK_DISABLED=1 git commit -m "refactor(prd): canonicalizeDeclaredPath becomes unconditional; modifiedFiles joins the reframe seam"`.

---

## Task 3 — Declare the frame in the schema; plan-write-time validation

**Files:**
- `src/prd/schema-story.ts` (verified 511 lines) — `workdir` field docs/validation (:301-326), `contextFiles` (:342-390), `expectedFiles` (:392-418).
- `src/prd/workdir-canonical.ts` — new `findNonCanonicalDeclaredPaths` export.
- `src/plan/strategies/persist-prd.ts` — wire the new validation into `finalizeAndWritePrd`.
- `src/prd/index.ts` — barrel export for the new function.
- `test/unit/prd/schema-story.test.ts` (locate via `find test -iname 'schema-story*'`; if absent, the story-validation tests live in `test/unit/prd/schema.test.ts` — confirm the real path before writing).
- `test/unit/prd/workdir-canonical.test.ts`, `test/unit/plan/strategies/persist-prd.test.ts` (locate before writing — confirm exact path).

**Interfaces:**
- Produces:
  ```typescript
  // src/prd/workdir-canonical.ts
  export interface NonCanonicalDeclaredPath {
    readonly storyId: string;
    readonly field: "contextFiles" | "expectedFiles" | "modifiedFiles";
    readonly path: string;
  }
  /**
   * Plan-WRITE-time validation, NOT a PRD.parse()-time schema rule (design §4
   * PR3 bullet 3): a story with workdirSource stamped (this PRD passed through
   * canonicalizePrdWorkdirs) should have every declared path already in the
   * repo frame. Returns violations rather than throwing — nax plan is
   * recovery-tolerant by design (src/operations/plan-fidelity.ts header) and a
   * hand-edited or legacy prd.json (workdirSource undefined) is explicitly out
   * of scope: this only inspects stamped stories.
   */
  export function findNonCanonicalDeclaredPaths(prd: PRD): NonCanonicalDeclaredPath[];
  ```
- Consumes: `toRepoFrame` from `@/utils/path-frame` (idempotency check: a path
  is canonical iff `toRepoFrame(path, workdir) === path`).

### Steps

- [ ] 3.1 Locate the real test file paths before writing anything:
  ```bash
  find test -iname "*schema-story*" -o -iname "*persist-prd*"
  ```
  Use whatever this returns as the target path in the steps below; if
  `schema-story` has no dedicated test file, add the new assertions to
  `test/unit/prd/schema.test.ts`'s existing `describe("validateStory", ...)`
  block instead of creating a new file.

- [ ] 3.2 IMPL (docs only, no behavior change) — update the three field
  comments in `schema-story.ts`:
  - `:245-256` (`workdirSource` docblock) — no change needed, already accurate.
  - `:301` (workdir comment) — append: `// Sibling contextFiles/expectedFiles/
    modifiedFiles entries on this story are REPO-ROOTED, not relative to this
    workdir (single-frame redesign, nax#2125). This is a plan-WRITE-time
    contract enforced by findNonCanonicalDeclaredPaths at the write seam
    (src/plan/strategies/persist-prd.ts), not here: PRD.parse() must keep
    accepting a legacy or hand-edited PRD whose paths predate this convention.`
  - `:342` (contextFiles comment) — append one sentence: `// Repo-rooted for
    any story canonicalized by nax plan (nax#2125); accepted here regardless of
    frame — this validator only rejects malformed paths (absolute, '..'), never
    an un-canonicalized one.`
  - `:392` (expectedFiles comment) — same one-sentence addition.
  - No change to any `throw` in this file: absolute-path and `..`-traversal
    rejection stay exactly as they are. This step adds comments only —
    confirmed by re-reading the diff before commit that no `if` condition
    changed.

- [ ] 3.3 RED — `findNonCanonicalDeclaredPaths`, in `test/unit/prd/workdir-canonical.test.ts`:
  ```typescript
  import { findNonCanonicalDeclaredPaths } from "@/prd/workdir-canonical";

  describe("findNonCanonicalDeclaredPaths — plan-write-time validation (single-frame redesign)", () => {
    test("flags a contextFiles entry that is not repo-rooted on a canonicalized story", () => {
      const story = makeStory({
        workdir: "packages/app",
        workdirSource: "stated",
        contextFiles: ["src/a.ts"], // should have been "packages/app/src/a.ts"
      });
      const violations = findNonCanonicalDeclaredPaths(prdOf([story]));
      expect(violations).toEqual([{ storyId: story.id, field: "contextFiles", path: "src/a.ts" }]);
    });

    test("is silent for a properly repo-rooted story", () => {
      const story = makeStory({
        workdir: "packages/app",
        workdirSource: "stated",
        contextFiles: ["packages/app/src/a.ts"],
        expectedFiles: ["packages/app/src/new.ts"],
        modifiedFiles: [{ path: "packages/app/src/b.ts", reason: "r" }],
      });
      expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
    });

    test("skips a legacy story with no workdirSource stamped", () => {
      const story = makeStory({ workdir: "packages/app", contextFiles: ["src/a.ts"] });
      expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
    });

    test("is silent at the repo root — every path is trivially canonical", () => {
      const story = makeStory({ workdirSource: "defaulted", contextFiles: ["src/a.ts"] });
      expect(findNonCanonicalDeclaredPaths(prdOf([story]))).toEqual([]);
    });
  });
  ```
  (`prdOf`/`makeStory` per the file's existing helpers, per step 2.1's pattern.)
  Run: `bun test test/unit/prd/workdir-canonical.test.ts --timeout=30000`.
  FAIL reason expected: `findNonCanonicalDeclaredPaths` does not exist —
  import error / `TypeError: findNonCanonicalDeclaredPaths is not a function`.

- [ ] 3.4 IMPL — add to `workdir-canonical.ts`:
  ```typescript
  import { normalizeWorkdir } from "@/utils/path-frame";

  /** One declared path on a canonicalized story that is not in the repo frame. */
  export interface NonCanonicalDeclaredPath {
    readonly storyId: string;
    readonly field: "contextFiles" | "expectedFiles" | "modifiedFiles";
    readonly path: string;
  }

  /**
   * Plan-WRITE-time invariant check (design §4 PR3 bullet 3): every declared
   * path on a story that canonicalizePrdWorkdirs has stamped (workdirSource
   * defined) should already be in the repo frame -- a path is canonical iff
   * re-applying canonicalizeDeclaredPath to it is a no-op. This is NOT a
   * PRD.parse()-time schema rule: a legacy PRD (workdirSource undefined) is
   * skipped entirely, so hand-edited and pre-#2125 PRDs keep loading.
   *
   * Returns violations rather than throwing -- the caller (finalizeAndWritePrd)
   * logs and continues, matching nax plan's recovery-tolerant contract
   * (src/operations/plan-fidelity.ts header comment).
   */
  export function findNonCanonicalDeclaredPaths(prd: PRD): NonCanonicalDeclaredPath[] {
    const violations: NonCanonicalDeclaredPath[] = [];
    for (const story of prd.userStories) {
      if (story.workdirSource === undefined) continue;
      const workdir = normalizeWorkdir(story.workdir);
      const check = (field: NonCanonicalDeclaredPath["field"], path: string): void => {
        if (canonicalizeDeclaredPath(path, workdir) !== path) {
          violations.push({ storyId: story.id, field, path });
        }
      };
      for (const entry of story.contextFiles ?? []) check("contextFiles", typeof entry === "string" ? entry : entry.path);
      for (const path of story.expectedFiles ?? []) check("expectedFiles", path);
      for (const entry of story.modifiedFiles ?? []) check("modifiedFiles", entry.path);
    }
    return violations;
  }
  ```

- [ ] 3.5 IMPL — export from the barrel, `src/prd/index.ts`:
  ```typescript
  export type { CanonicalizeOptions, ExistsProbe, NonCanonicalDeclaredPath } from "./workdir-canonical";
  export { canonicalizeDeclaredPath, canonicalizePrdWorkdirs, findNonCanonicalDeclaredPaths } from "./workdir-canonical";
  ```

- [ ] 3.6 RUN — `bun test test/unit/prd/workdir-canonical.test.ts --timeout=30000`. PASS expected.

- [ ] 3.7 RED — wire the validation into `finalizeAndWritePrd`, in the
  persist-prd test file located in step 3.1:
  ```typescript
  test("logs a warning when canonicalization leaves a non-repo-rooted declared path", async () => {
    const warnings: unknown[] = [];
    const fakeLogger = { warn: (...args: unknown[]) => warnings.push(args), info: () => {}, debug: () => {}, error: () => {} };
    // ... construct a minimal PersistPrdArgs whose prd, once canonicalized by
    // the real canonicalizePrdWorkdirs, still has workdirSource stamped (it
    // always will, post-Task-2) -- so this test proves the wiring calls
    // findNonCanonicalDeclaredPaths at all, using a story crafted so a
    // modifiedFiles entry bypasses reframing via a monkeypatched deps escape
    // hatch is NOT available (module is pure) -- instead assert the ZERO-
    // violation path logs nothing, and cover the violation path directly via
    // 3.3's unit tests on findNonCanonicalDeclaredPaths itself (integration
    // coverage here is for "is it called", not "is the check correct").
  });
  ```
  Given `canonicalizePrdWorkdirs` always produces canonical output after Task
  2, there is no way to construct a genuine violation through the public
  `finalizeAndWritePrd` entry point (by design — that is the whole point of
  Task 2). Write the integration test as: inject `_persistPrdDeps` such that
  `discoverWorkspacePackages` throws (the existing `catch` path at
  persist-prd.ts :135-137 already covers "canonicalization skipped" — a story
  in that branch keeps `workdirSource: undefined` from the PRD as authored, so
  `findNonCanonicalDeclaredPaths` correctly reports NOTHING for it, which is
  the desired "skip legacy/unstamped" behavior). Assert: `finalizeAndWritePrd`
  still writes a file and does not throw, and (with a `workdirSource`-stamped
  story that could not be re-canonicalized because the catch path fired,
  constructed by pre-stamping the PRD passed into `finalizeAndWritePrd`) a
  warning is logged citing `nonCanonical`. This exercises the wiring without
  needing to fight Task 2's own invariant. FAIL reason expected: no such
  logging call exists yet.

- [ ] 3.8 IMPL — in `persist-prd.ts`, after the `canonical = result.prd;` line
  inside the `try` block (and also reachable from the pre-stamped-input case
  the `catch` path leaves untouched), add:
  ```typescript
  const nonCanonical = findNonCanonicalDeclaredPaths(canonical);
  if (nonCanonical.length > 0) {
    getLogger().warn(
      "plan",
      "declared paths remain outside the repo frame on a canonicalized story -- a caller bypassed canonicalizePrdWorkdirs or reframing missed a field",
      { nonCanonical },
    );
  }
  ```
  Placed OUTSIDE the `try`/`catch` (after it), so it runs whether or not
  canonicalization succeeded — it must see the final `canonical` PRD either
  way, and it is itself non-throwing (returns an array, never throws), so it
  needs no additional error handling. Import `findNonCanonicalDeclaredPaths`
  from `@/prd`.

- [ ] 3.9 RUN — the persist-prd test file. PASS expected. Then re-run the
  full Task 2 + Task 3 test files together:
  `bun test test/unit/prd/workdir-canonical.test.ts <persist-prd-test-path> --timeout=30000`.

- [ ] 3.10 COMMIT — `git add src/prd/schema-story.ts src/prd/workdir-canonical.ts src/prd/index.ts src/plan/strategies/persist-prd.ts <test files> && RTK_DISABLED=1 git commit -m "feat(prd): declare the repo-rooted frame in schema docs; add plan-write-time validation"`.

---

## Task 4 — Spec-authoring guidance: `### Context Files` / `### Modifies` flip to repo-relative

**Files:**
- `src/operations/plan-fidelity.ts` (verified 194 lines) — `warnOnDroppedContextFiles` (:96-162), `backfillModifiedFiles` (:71-88).
- `src/prd/context-files-extract.ts`, `src/prd/modifies-extract.ts` — docblock updates only (verified: both are pure markdown extractors, frame-agnostic; no functional change needed).
- `src/prd/spec-lint.ts` (verified 454 lines) — verified via full-file grep that it contains NO existing frame-specific wording (`workdir-relative`/`repo-relative`) to flip; this task's spec-lint touch is limited to step 4.4.
- `test/unit/operations/plan-fidelity.test.ts` (locate via `find`).

**Interfaces:**
- Consumes: `canonicalizePrdWorkdirs` output shape (unchanged from Task 2's
  perspective — this task does not call it directly, it documents/tests the
  DOWNSTREAM effect of Task 1+2 on `warnOnDroppedContextFiles`'s comparison).
- Produces: no new exports. Doc-only changes plus one behavioral confirmation
  test (no source line changes in `warnOnDroppedContextFiles` itself — see
  finding below).

### Finding this task must record, not fix twice

`warnOnDroppedContextFiles` (plan-fidelity.ts :113-162) compares the spec's
raw declared paths (`extractSpecContextFiles`, frame = however the spec author
wrote them) against `getContextFiles(story)` (frame = whatever
`canonicalizePrdWorkdirs` produced) via `normalizeContextPath`, which only
strips a leading `./` — it performs NO frame translation. Today this is a real
bug (design §4 PR3 bullet 4, "#1473 drop-warning text... reads workdir-relative
declarations as the norm"): a monorepo spec author writes `### Context Files`
paths workdir-relative (matching the OLD `CONTEXT_VS_EXPECTED_FILES_RULE`
wording the planner itself used to emit), but the PRD's `story.contextFiles`
is repo-rooted after canonicalization — so every entry false-positives as
"dropped". Task 1 + Task 2 fix this **without touching
`warnOnDroppedContextFiles`'s comparison logic at all**: once (a) the spec-
authoring convention is documented as repo-relative (this task, doc-only) and
(b) the PRD is unconditionally repo-rooted (Task 2), both sides of the
`normalizeContextPath` comparison are in the same frame, and the literal-string
comparison starts working correctly as-is. The fix is real; it is just not a
code change in `plan-fidelity.ts` — it is the consequence of Tasks 1+2. This
task's job is to (1) document that convention flip and (2) add a regression
test proving the false-positive is gone, so the fix is verified rather than
assumed.

The same reasoning applies to `backfillModifiedFiles`/`applyModifiedFiles`
(src/prd/modifies.ts): it runs BEFORE canonicalization
(`finalizeAndWritePrd`'s ordering, persist-prd.ts :76-89), so a spec's
`### Modifies` entries are attached to `story.modifiedFiles` in whatever frame
the spec used, and Task 2 now reframes them afterward via
`canonicalizePrdWorkdirs`. No code change needed there either — Task 2 already
covers it.

### Steps

- [ ] 4.1 IMPL (docs) — `src/operations/plan-fidelity.ts`, update the docblock
  above `warnOnDroppedContextFiles` (:96-112) to add, after the existing
  paragraph about `FILE_INJECTION_MAX_FILES`:
  ```
   * Frame (single-frame redesign, nax#2125): both sides of this comparison are
   * REPO-ROOTED as of this PRD's generation — `extractSpecContextFiles` reads
   * whatever the spec's `### Context Files` section says verbatim (spec-writing
   * now authors those repo-relative, matching plan-builder.ts's
   * CONTEXT_VS_EXPECTED_FILES_RULE), and `getContextFiles(story)` is
   * unconditionally repo-rooted post-canonicalizePrdWorkdirs. Before this
   * redesign a monorepo spec's workdir-relative declarations never matched the
   * (sometimes-repo-rooted, sometimes-not) PRD entries, so this comparison
   * false-positived on nearly every monorepo story (#1473). normalizeContextPath
   * intentionally does NO frame translation -- it does not need to anymore.
  ```

- [ ] 4.2 IMPL (docs) — `src/prd/context-files-extract.ts` and
  `src/prd/modifies-extract.ts` top-of-file docblocks: add one sentence to
  each noting the extracted paths are read verbatim and are expected to be
  repo-relative as of the single-frame redesign (spec-writing's authoring
  convention, not enforced by these pure extractors, which remain frame-
  agnostic by design).

- [ ] 4.3 RED — regression test proving the false-positive is gone, in the
  plan-fidelity test file (locate exact path first: `find test -iname
  "*plan-fidelity*"`):
  ```typescript
  test("a repo-rooted spec Context Files declaration matches a canonicalized monorepo story (nax#2125 / #1473)", () => {
    const specContent = `
  ## Stories

  ### US-001: add a route

  ### Context Files

  **US-001**
  - \`packages/api/src/routes/index.ts\`
  `;
    const story = makeStory({
      id: "US-001",
      workdir: "packages/api",
      workdirSource: "stated",
      contextFiles: ["packages/api/src/routes/index.ts"], // already canonicalized, matching frame
    });
    const prd = makePRD({ userStories: [story] });

    const warnings: unknown[] = [];
    // Inject the safe logger per this file's existing DI pattern for
    // getSafeLogger -- match whatever mechanism the surrounding tests in this
    // file already use (grep the file for `getSafeLogger` mocking before
    // writing this line; do not introduce a new mocking approach).
    warnOnDroppedContextFiles(prd, specContent, "test-feature");
    expect(warnings.filter((w) => String(w).includes("Context Files entries absent"))).toEqual([]);
  });
  ```
  FAIL reason expected: **this specific test will already pass today** if
  written in isolation, because `normalizeContextPath` never did frame
  translation and both sides in this test are ALREADY hand-constructed to
  match. To make this test meaningfully RED first, write the COMPANION test
  that captures the historical bug and prove it stays fixed:
  ```typescript
  test("a workdir-relative spec declaration on a canonicalized monorepo story is correctly reported as NOT matching (post-redesign, spec must be repo-relative)", () => {
    const specContent = `
  ## Stories

  ### US-001: add a route

  ### Context Files

  **US-001**
  - \`src/routes/index.ts\`
  `;
    const story = makeStory({
      id: "US-001",
      workdir: "packages/api",
      workdirSource: "stated",
      contextFiles: ["packages/api/src/routes/index.ts"],
    });
    const prd = makePRD({ userStories: [story] });
    // A spec still written the OLD (workdir-relative) way genuinely will not
    // match a repo-rooted PRD -- this is the expected, correct behavior under
    // the new convention (the fix is "author specs repo-relative", not "make
    // the comparison frame-aware"). This test pins that the warning path is
    // intact, not broken by Task 1/2/4, so a genuine spec/PRD mismatch is
    // still caught.
    warnOnDroppedContextFiles(prd, specContent, "test-feature");
    expect(warnings.some((w) => String(w).includes("Context Files entries absent"))).toBe(true);
  });
  ```
  Run both. FAIL reason for THIS commit's purposes: neither test exists yet —
  run them first to confirm both assertions hold against current (pre-doc-only-
  change) code, proving the finding above (no source change needed) rather
  than a broken implementation.

- [ ] 4.4 IMPL — no source change in `plan-fidelity.ts` beyond the docblock
  from 4.1 (confirmed by 4.3's tests passing unmodified). Add one sentence to
  `spec-lint.ts`'s top-of-file docblock (:1-25) noting the frame convention:
  after the existing paragraph ending "...a linter that disagrees with the
  tool it guards is worse than no linter.", add:
  ```
   * Frame: as of the single-frame redesign (nax#2125), `### Modifies` and
   * `### Context Files` entries are authored REPO-RELATIVE in a monorepo spec
   * -- matching the planner's own contextFiles/expectedFiles convention
   * (src/prompts/builders/plan-builder.ts). This linter's own checks
   * (checkModifies, the Context Files mention check) validate EXTRACTION
   * (did the grammar parse?), not frame -- a workdir-relative path extracts
   * and lints clean, then silently mismatches downstream (see
   * src/operations/plan-fidelity.ts warnOnDroppedContextFiles). There is no
   * lint code for a frame mismatch; authoring convention is documentation,
   * not a gate.
  ```

- [ ] 4.5 RUN — the plan-fidelity test file in full. PASS expected.

- [ ] 4.6 COMMIT — `git add src/operations/plan-fidelity.ts src/prd/context-files-extract.ts src/prd/modifies-extract.ts src/prd/spec-lint.ts <plan-fidelity test file> && RTK_DISABLED=1 git commit -m "docs(prd): document the repo-relative spec-authoring convention; pin the #1473 fix"`.

---

## Task 5 — `context/builder.ts`: confirm the H4 residual is inert for new PRDs (no deletion)

**SEQUENCING NOTE (integration branch runs PR 1 → 2 → 3 → 4):** this plan was
written against the pre-PR-2 tree, but PR 2's Task 3 flips `builder.ts`'s
rendering AND deletes the local `reclassifyPlanTimeAbsentEntries` function
before this task runs. First re-grep:
`grep -n "reclassifyPlanTimeAbsentEntries\|partitionPackageFrame" src/context/builder.ts`.
If PR 2 already removed them (expected), this task collapses to: verify the
tolerant legacy branch (`workdirSource === undefined` pass-through) still
exists in whatever shape PR 2 left, and skip the inertness test below — the
mechanism it would prove inert no longer exists. Only execute the steps below
verbatim if PR 2 has NOT landed (out-of-order execution, which Task 0 of PR 2
forbids anyway).

**Files:**
- `src/context/builder.ts` (verified 521 lines) — `canonical` flag (:404), `reclassifyPlanTimeAbsentEntries` (:271-306), its call site (:421-431).
- `test/unit/context/builder-parent-frame.test.ts` (verified 388 lines).

**Interfaces:**
- Consumes: `story.workdirSource`, `story.contextFiles`/`expectedFiles` — SAME
  shape as today; this task makes NO signature change anywhere in
  `builder.ts`.
- Produces: nothing new. This task is doc-only plus one confirmation test.

**Ruled explicitly out of scope for this PR (design §4 PR3 bullet 5 + §2
"Legacy ruling"):** deleting `reclassifyPlanTimeAbsentEntries`, the `canonical`
flag, or restructuring `addFileElements` is PR 4's job. The tolerant legacy
read branch (paths pass through unchanged when `workdirSource === undefined`)
must keep working for every PRD written before this PR ships, indefinitely.

### Why this is a no-op change, verified rather than assumed

`reclassifyPlanTimeAbsentEntries` exists to correct the "H4 residual": before
this PR, `canonicalizeDeclaredPath` left a path workdir-relative when it did
not resolve on disk at plan time (a story creating a file, or referencing an
upstream dependency's not-yet-written output). After Task 2,
`canonicalizeDeclaredPath` is unconditional — every declared path on a
`workdirSource`-stamped story is repo-rooted at write time regardless of disk
state, so the H4 residual cannot occur **for a story canonicalized after this
PR ships**. `reclassifyPlanTimeAbsentEntries`'s probing loop (:289-304) will
therefore find nothing to reclassify for such a story: every entry either
already starts with `${workdir}/` (so `toPackageFrame(entry, workdirRel) !==
null` at :290, and the loop `continue`s before ever probing disk) or is a
genuinely different package's path (correctly left for `partitionPackageFrame`
to drop as unreachable). The function remains CORRECT and load-bearing for any
PRD canonicalized before this PR (`workdirSource` stamped by the OLD
existence-gated `canonicalizeDeclaredPath`), which is exactly why it is kept.

### Steps

- [ ] 5.1 IMPL (docs only) — in `context/builder.ts`, extend the H4 comment at
  :406-420 with one paragraph:
  ```
   // Post-single-frame-redesign (nax#2125): for a story canonicalized by the
   // CURRENT nax plan, this H4 residual cannot occur -- canonicalizeDeclaredPath
   // is now unconditional (src/prd/workdir-canonical.ts), so every declared
   // path is already repo-rooted at write time regardless of disk state. This
   // probe-and-reclassify loop is therefore a no-op for such a story (every
   // entry already passes toPackageFrame at :290's first check) and stays
   // load-bearing ONLY for a PRD canonicalized before this PR shipped, whose
   // workdirSource was stamped by the old existence-gated function. Deleting
   // it is PR 4's job, gated on the legacy-PRD support window closing.
  ```

- [ ] 5.2 RED — confirmation test in `builder-parent-frame.test.ts` (append a
  new `describe` block after the existing one, following the file's own
  `writeFiles`/`makeStoryContext` helper pattern already read above):
  ```typescript
  describe("H4 residual is inert for a freshly-canonicalized story (single-frame redesign)", () => {
    test("a repo-rooted contextFiles entry that does not exist on disk yet still injects correctly, without a reclassify probe finding anything to change", async () => {
      const tempDir = makeTempDir("nax-builder-h4-");
      try {
        // Only the EXISTING file is on disk; the "not yet created" one is
        // deliberately absent -- this is exactly the H4 trigger condition,
        // except the path is ALREADY repo-rooted (workdirSource: "stated",
        // as canonicalizePrdWorkdirs now unconditionally produces).
        await writeFiles(tempDir, {
          "packages/api/src/existing.ts": "export const existing = true;",
        });

        const story = makeStory({
          id: "US-001",
          workdir: API_WORKDIR,
          workdirSource: "stated",
          contextFiles: ["packages/api/src/existing.ts", "packages/api/src/not-yet-created.ts"],
        });
        const prd = makePRD({ userStories: [story] });

        const built = await buildContext(makeStoryContext(prd, path.join(tempDir, API_WORKDIR)), BUDGET);
        const fileElements = built.elements.filter((e) => e.type === "file");

        // The existing file injects normally.
        expect(fileElements.map((e) => e.filePath)).toContain("src/existing.ts");
        // The not-yet-created file is correctly treated as unreachable-for-now
        // (it is not on disk), not incorrectly reclassified into some other path.
        expect(fileElements.map((e) => e.filePath)).not.toContain("src/not-yet-created.ts");
      } finally {
        await cleanupTempDir(tempDir);
      }
    });
  });
  ```
  Run: `bun test test/unit/context/builder-parent-frame.test.ts --timeout=30000`.
  This test is expected to ALREADY PASS against current `builder.ts` (this
  task changes no runtime behavior) — run it FIRST against the pre-Task-5
  code to confirm the "already inert" claim empirically (not just by
  reasoning), which is this task's actual deliverable. If it fails, that is a
  genuine finding requiring an actual code change here (contrary to the
  Task 5 header's assumption) — stop and re-scope this task rather than
  forcing the test to pass.

- [ ] 5.3 RUN — confirm PASS, and re-run the full `builder-parent-frame.test.ts`
  file to confirm no regression in the existing #2089 tests.

- [ ] 5.4 COMMIT — `git add src/context/builder.ts test/unit/context/builder-parent-frame.test.ts && RTK_DISABLED=1 git commit -m "docs(context): confirm the H4 reclassify residual is inert for single-frame-canonicalized PRDs"`.

---

## Task 6 — Selector logic verification (item 7): `deriveWorkdir`/`resolvePathOwners` under repo-rooted inputs

**Files:**
- `src/prd/workdir-canonical.ts` — `resolvePathOwners` (:32-48), `deriveWorkdir` (:57-71). NO code change — this task is verification-only, per the design's explicit ruling that this selector logic "stays."
- `test/unit/prd/workdir-canonical.test.ts`.

**Interfaces:** none changed.

### Steps

- [ ] 6.1 Re-read `resolvePathOwners` (already quoted in full above): for a
  repo-rooted input path, the SECOND branch (`namesPackage = path === pkg ||
  path.startsWith(pkg/); if (namesPackage && exists(join(repoRoot, path)))`)
  is the one that fires — this is already covered by the existing test "finds
  the package a repo-rooted path already names" (test/unit/prd/workdir-canonical.test.ts,
  currently in the `resolvePathOwners` describe block). Confirm this test
  still exists and still passes after Tasks 1-5 (it is untouched by them).

- [ ] 6.2 RED — add one new test making the repo-rooted-input case explicit
  for a MULTI-package repo (the existing test only has 2 packages and doesn't
  test the segment-boundary case for a repo-rooted input specifically):
  ```typescript
  test("a repo-rooted input path is correctly attributed even when another package's name is a prefix", () => {
    // "packages/app" must not falsely claim "packages/application/x.ts" when
    // both packages are declared workspace packages.
    const exists = probeOf("packages/application/src/c.ts");
    expect(
      resolvePathOwners("packages/application/src/c.ts", REPO, ["packages/app", "packages/application"], exists),
    ).toEqual(["packages/application"]);
  });
  ```
  This exercises `resolvePathOwners` with a fully repo-rooted declared path —
  the shape every contextFiles/expectedFiles/modifiedFiles entry now has after
  Task 1's prompt flip and Task 2's unconditional canonicalization — against
  two packages where a naive prefix match would misattribute it.
  Run: `bun test test/unit/prd/workdir-canonical.test.ts --timeout=30000`.
  FAIL reason expected: with only `"packages/app"` as a candidate this
  scenario cannot even be constructed to fail meaningfully — write it with
  BOTH packages present so the segment-boundary guard (`path === pkg ||
  path.startsWith(\`${pkg}/\`)`) is actually exercised against a real
  ambiguity; verify it currently fails only if the guard is broken (it is not
  — this is a confirming regression test, matching Task 5's pattern). Run it
  against the pre-existing (unmodified) `resolvePathOwners` first to confirm
  it already passes, documenting that item 7's "verify" requirement is
  satisfied by an explicit test rather than by inspection alone.

- [ ] 6.3 RUN — full file. PASS expected (no implementation step — this task
  is coverage-only, consistent with the design's ruling that this selector
  logic is unchanged).

- [ ] 6.4 COMMIT — `git add test/unit/prd/workdir-canonical.test.ts && RTK_DISABLED=1 git commit -m "test(prd): cover resolvePathOwners segment-boundary attribution for repo-rooted inputs"`.

---

## Task 7 — Full verification

- [ ] 7.1 `RTK_DISABLED=1 git status --short` — confirm only the files touched
  by Tasks 1-6 are modified, nothing stray.
- [ ] 7.2 `bun run typecheck && bun run lint && bun run test && bun run test:coverage`
  Run sequentially (not `&&`-chained silently past a failure — stop and fix at
  the first red step). `test:coverage` is not part of `check:all`/the nax
  pipeline; run it explicitly here because Tasks 1-6 added new `src/` exports
  (`findNonCanonicalDeclaredPaths`) and new test files/blocks
  ([[feedback-nax-test-coverage-is-not-in-check-all]]).
- [ ] 7.3 `bun run check:file-sizes` — confirm no file crossed its cap; if
  `plan-builder.ts` grew past 600 lines (see Global Constraints), extract per
  that constraint's fallback plan before proceeding.
- [ ] 7.4 Re-grep for the deleted shape to catch any missed call site — and
  for the fields surviving as stubbed object-literal KEYS (property-access
  greps alone cannot see `collisions: []`):
  ```bash
  grep -rn "\.collided\b\|\.rootOnly\b" src/ test/ | grep -v node_modules
  grep -rEn "collisions:\s*\[\]|rootOnly:\s*\[\]|collided:\s*(true|false)" src/prd/ src/plan/
  grep -rn "canonicalizeDeclaredPath(" src/ test/ | grep -v node_modules
  ```
  Every `canonicalizeDeclaredPath(...)` call site must now pass exactly 2
  arguments; every `.collided`/`.rootOnly` reference must be gone.
- [ ] 7.5 Report a summary of what changed and why to the requester, per
  superpowers:verification-before-completion — do not claim "done" without
  having run 7.2 and pasted/confirmed its actual output.
