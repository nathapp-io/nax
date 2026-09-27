# SPEC: Plan PRD fidelity — repo-rooted paths stay as written, and a pre-decomposed spec's story structure is binding

## Summary

`nax plan` turns a spec that `nax spec lint` passes into a PRD that cannot run, and says `[OK] PRD generated`. Two defects cause this. First, the PRD write step adds the story's package prefix to every declared path, which corrupts correct repo-rooted paths outside the package (#2270). Second, the planner may fold a spec-declared story into a story in another package and drop its dependencies. The spec's `### Modifies` entries for the folded story then become orphans, and the only signal is a warning (#2271). This feature makes the write step keep repo-rooted paths as written, and amends ADR-032 R3 to match. It also makes a spec's declared story ids, per-story `Workdir` and `Depends on` binding on the PRD: the plan prompt states them, one self-heal repair turn fixes a divergence, and a divergence that survives the repair fails the plan. The failed draft is moved aside so `nax run` cannot pick it up.

## Motivation

- **#2270.** `canonicalizeDeclaredPath` (`src/prd/workdir-canonical.ts`) delegates to `toRepoFrame`, which prefixes `workdir/` onto any path not already under it. A `packages/lib` story that creates the repo-root file `docs/pipelines/report.pipeline.json` gets `expectedFiles: ["packages/lib/docs/pipelines/report.pipeline.json"]`. An `apps/api` story reading `packages/db/...` gets `apps/api/packages/db/...`, and at run time that surfaces as "Relevant file not found". ADR-032 R5 makes cross-package `modifiedFiles` a designed case, and R3's "defensive re-spell" corrupts exactly that case. The single-frame live verification recorded "zero cross-package leakage", so no run ever exercised it. `src/pipeline/scope-files.ts:42` applies the same prefix again at run time to PRD paths that are already repo-rooted.
- **#2271.** A spec with 5 stories, each carrying a single `Workdir` and `Depends on`, planned to 4 stories. US-004 (`apps/api`, three integration ACs, no production change) was folded into US-003 (`packages/lib`). The `### Modifies` entry authorising the api count test was dropped as an orphan with a warn log, so the one existing test the feature legitimately breaks had no authorisation anywhere. The plan prompt caused the fold: `GROUPING_RULES` says "NEVER create stories whose primary purpose is writing tests… No exceptions" and "Combine small, related tasks into a single story". Nothing in either plan prompt says a spec's own story ids, workdirs or dependencies are binding. The refine continuation's `dependency-minimization` item tells the planner to remove dependencies. The spec-writing guide promises "`nax plan` maps each story's `Workdir` to the `workdir` field", and nothing deterministic enforces it.

## Design

### Integration

Symbols this feature only reads:

- `toRepoFrame(path, workdir)`, `isWithinPackage(path, workdir)`, `normalizeWorkdir(workdir)`, `storyWorkdir(story)` — `src/utils/path-frame.ts`. `toRepoFrame` is **unchanged**: its package-scoped callers (`src/context/builder.ts:289` auto-detect output, `src/context/engine/scope-path-match.ts:150` rule `appliesTo`) really do receive package-relative input.
- `extractSpecModifiedFiles(specContent): SpecModifiedFile[]` — `src/prd/modifies-extract.ts`.
- `validatePlanOutput(content, featureName, branchName): PRD` — `src/prd/schema.ts`.
- `makeSelfHealStep<I, D>(spec: SelfHealSpec<I, D>): SelfHealStep<I>`, `runSelfHealChain<I>(ctx, seed, steps): Promise<TurnResult>` — `src/operations/self-heal.ts`.
- `writeOrRecoverPrd(ctx, prd, err?)` — `src/plan/strategies/write-prd.ts`; `SinglePlanStrategy.execute` — `src/plan/strategies/single.ts`. Both re-throw the original error when the draft at `ctx.outputPath` cannot be read back. This feature relies on that and does not change either file.
- `contextFilesCanonical: ctx.story.workdirSource !== undefined` — `src/pipeline/stages/context.ts:188`. This is the legacy gate US-001 mirrors in `scope-files.ts`.

Symbols this feature changes. Each `Baseline:` exists only to locate the code and is never the interface to implement; implement the `Target:`.

- `canonicalizeDeclaredPath` — `src/prd/workdir-canonical.ts`
  - Baseline: `canonicalizeDeclaredPath(path: string, workdir: string): string` (returns `toRepoFrame(path, workdir)`)
  - Target: `canonicalizeDeclaredPath(path: string, workdir: string, repoRoot: string, exists: ExistsProbe): { path: string; respelled: boolean }`
- `canonicalizePrdWorkdirs` — `src/prd/workdir-canonical.ts`
  - Baseline: returns `{ prd: PRD; defaulted: string[] }`
  - Target: returns `{ prd: PRD; defaulted: string[]; respelled: RespelledDeclaredPath[] }`, where `RespelledDeclaredPath = { storyId: string; field: "contextFiles" | "expectedFiles" | "modifiedFiles"; from: string; to: string }` is exported from the same module
- `findNonCanonicalDeclaredPaths(prd: PRD): NonCanonicalDeclaredPath[]` — same signature; the Target rule is in the Approach section. It no longer calls `canonicalizeDeclaredPath` (whose Target needs `repoRoot` and `exists`); it calls the new disk-independent helper below
- New export from `src/prd/workdir-canonical.ts`: `normalizeDeclaredPathSpelling(path: string): string` — step 1 of the canonicalization rule, shared by `canonicalizeDeclaredPath` and `findNonCanonicalDeclaredPaths`
- `resolveScopeFiles(ctx: PipelineContext): Promise<string[]>` — `src/pipeline/scope-files.ts`; same signature; declared paths are re-framed only for a legacy story
- `finalizeAndWritePrd(args: PersistPrdArgs): Promise<string>` — `src/plan/strategies/persist-prd.ts`; same signature; gains the structure check and the rejected-draft rename. `_persistPrdDeps` gains `renameSync: (from: string, to: string) => void`
- `declaredStoryIds(lines)` — baseline: private in `src/prd/spec-lint.ts`. Target: exported from the new `src/prd/spec-structure.ts`, and `spec-lint.ts` imports it. Behaviour is unchanged.
- `PlanPromptBuilder.buildRefineContinuation`
  - Baseline: `buildRefineContinuation(outputFilePath: string, specGuard = false): string`
  - Target: `buildRefineContinuation(outputFilePath: string, specGuard = false, bindingStructure = false): string`
- `PlanPromptBuilder.build(...)` — same signature; it derives the binding structure from its own `specContent` argument
- `planInteractiveOp` — `src/operations/plan.ts`
  - Baseline: `RunOperation<PlanInteractiveInput, PRD, PlanConfig>` with no `hopBody`
  - Target: `RunOperationWithHooks<PlanInteractiveInput, PRD, PlanConfig, "hopBody">`
- `planRefineOp.hopBody` — `src/operations/plan-refine.ts`; its self-heal chain gains the structure step, placed first

### Approach

**Path canonicalization rule (US-001).** `canonicalizeDeclaredPath(path, workdir, repoRoot, exists)`:

1. `p = normalizeDeclaredPathSpelling(path)`: posix separators, strip leading `./` runs, strip trailing `/`, trim.
2. If `normalizeWorkdir(workdir) === "."` or `isWithinPackage(p, workdir)`, return `{ path: p, respelled: false }`.
3. If `exists(join(repoRoot, p))` is false **and** `exists(join(repoRoot, workdir, p))` is true, return `{ path: workdir + "/" + p, respelled: true }`.
4. Otherwise return `{ path: p, respelled: false }`. This covers existing repo-root files, other packages' files, and paths that exist nowhere (files a story will create). When a path exists both at the root and under the package, the repo-rooted reading wins.

`canonicalizePrdWorkdirs` applies this to `contextFiles` (string and object entries), `expectedFiles` and `modifiedFiles`. It collects each `respelled: true` result into `respelled`. `finalizeAndWritePrd` logs one warn per canonicalization pass when `respelled` is non-empty: message `"declared paths spelled package-relative were re-spelled into the repo frame"`, data `{ respelled }`.

`findNonCanonicalDeclaredPaths` target rule: a path on a stamped story (`workdirSource` defined) is non-canonical exactly when `normalizeDeclaredPathSpelling(path) !== path`. It no longer flags a correct repo-rooted path outside the story's package. **Accepted tradeoff:** the check now catches spelling artifacts only (`./`, backslashes, a trailing `/`). A bare package-relative path such as `src/a.ts` on a `packages/lib` stamped story is indistinguishable from a repo-rooted `src/a.ts` without the filesystem, so it is no longer flagged. The existence-aware re-spell in `canonicalizePrdWorkdirs` is now the only place that catches a stray package-relative spelling.

**ADR-032 amendment (US-001).** Replace R3's rationale in `docs/adr/ADR-032-single-frame-repo-rooted-paths.md` with: *"Declared paths are repo-rooted as written, including paths outside the story's package (R5 makes cross-package `modifiedFiles` a designed case). The write step normalises spelling only. It re-spells a path into the package only when the path is absent at the repo root and present under the package, and it reports every such re-spell."* Add an `Amended:` line to the header citing #2270. Append a dated note to `docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md` recording that the verification never exercised an out-of-package declared path. Fix the stale header comments in `src/utils/path-frame.ts` (the paragraph on `toRepoFrame`'s callers), `src/prd/workdir-canonical.ts` (`canonicalizeDeclaredPath`) and `src/pipeline/scope-files.ts` (which says declared sources arrive package-relative).

**Spec structure extraction (US-002).** New pure module `src/prd/spec-structure.ts`:

```typescript
export interface SpecStoryStructure {
  readonly id: string;              // "US-004", uppercase
  readonly workdir?: string;        // undefined = the spec states none
  readonly dependsOn?: readonly string[]; // undefined = the spec states nothing; [] = "no dependencies"
}
export interface SpecStructureWarning {
  readonly storyId: string;
  readonly field: "workdir" | "dependsOn";
  readonly message: string;
}
export interface SpecStructure {
  readonly stories: readonly SpecStoryStructure[]; // spec document order
  readonly warnings: readonly SpecStructureWarning[];
}
export type SpecStructureViolation =
  | { readonly kind: "missing-story"; readonly storyId: string }
  | { readonly kind: "extra-story"; readonly storyId: string }
  | { readonly kind: "workdir-mismatch"; readonly storyId: string; readonly expected: string; readonly actual: string }
  | { readonly kind: "dependencies-mismatch"; readonly storyId: string; readonly expected: readonly string[]; readonly actual: readonly string[] }
  | { readonly kind: "orphan-modifies"; readonly storyId: string | null; readonly path: string };

export function declaredStoryIds(lines: readonly string[]): string[];
export function extractSpecStructure(specContent: string): SpecStructure;
export function backfillSpecWorkdirs(prd: PRD, structure: SpecStructure): { prd: PRD; backfilled: string[] };
export function findSpecStructureViolations(prd: PRD, specContent: string): SpecStructureViolation[];
export function formatSpecStructureViolation(violation: SpecStructureViolation): string;
```

Extraction grammar. Everything is scoped to the `## Stories` section and skips fenced lines.

- **Story ids:** `declaredStoryIds`, moved unchanged from `spec-lint.ts`.
- **Attribution:** a `Workdir` or `Depends on` statement belongs to the story id declared on the same line. If none is declared there, it belongs to the nearest preceding line in `## Stories` that declares one. A declaring line is a heading `^#{1,6}\s+US-\d+`, a bold lead-in `^\s*\*\*\s*US-\d+`, or a bullet/numbered item whose first bold token is a story id (`^\s*(?:\d+\.|[-*])\s+\*\*\s*US-\d+`).
- **Workdir** is read from story-declaring lines, their prose, and the `### Context Files` / `### Creates` subsections. Two forms: `Workdir:` followed by a path, or `Workdir` followed by a backticked path. The path is the first run of characters that are not whitespace or backticks, with trailing `.` `,` `;` `)` `_` stripped. Two different values for one story give a `SpecStructureWarning`, and the story's `workdir` stays `undefined`.
- **Depends on** is read from story-declaring lines and their prose, but **not** from the `### Modifies`, `### Seams`, `### Context Files` or `### Creates` subsections, whose free-text reasons may mention another story. Matching is case-insensitive.
  - `no dependencies`, or `depends on` followed (after optional `:`, `*`, `_`, `(` and whitespace) by `none`, gives `[]`.
  - `depends on` followed the same way by one or more `US-\d+` ids, separated by `,`, `and`, `&` or whitespace, gives those ids. The list ends at the first token that is neither an id nor a separator.
  - Several id lists for one story are unioned. A `none` together with an id list for the same story gives a warning, and `dependsOn` stays `undefined`.

This grammar covers every phrasing in the repo's own specs: `— depends on US-001`, `- **Depends on:** US-001 (reason)`, `*(depends on US-001, US-002)*`, `- Depends on: none`, `— no dependencies`.

`findSpecStructureViolations(prd, specContent)` returns `[]` when the spec declares no story ids. Otherwise it returns, in this order:

1. `missing-story` for each spec id absent from the PRD, in spec order.
2. `extra-story` for each PRD id absent from the spec, in PRD order.
3. `workdir-mismatch` for each spec story with a stated `workdir` whose PRD story has a stated workdir that differs from it. Both sides are compared after `normalizeWorkdir`. A PRD story with **no** workdir is not a violation, because the backfill handles it.
4. `dependencies-mismatch` for each spec story with a defined `dependsOn` whose PRD story's `dependencies` is not the same set.
5. `orphan-modifies` for each `extractSpecModifiedFiles` entry whose `storyId` is `null` or names no PRD story.

`backfillSpecWorkdirs(prd, structure)` sets `workdir` on each PRD story that has none, when its spec story states a `workdir`, including `"."` for the repo root. It returns the backfilled ids. Canonicalization keeps an explicit root as root, with `workdirSource: "stated"`, even after omitting the root-valued `workdir` from the written PRD.

**Write step (US-002).** `finalizeAndWritePrd`, **unscoped writes only** (`args.scope === undefined`), after `applyPlanFidelity` and before `canonicalizePrdWorkdirs`:

1. `extractSpecStructure(args.specContent)`. Log each warning once at warn level: `"spec story structure could not be read — field not enforced"`, data `{ storyId, field, message }`.
2. `backfillSpecWorkdirs`. When `backfilled` is non-empty, log a warn `"PRD stories had no workdir — filled from the spec's Workdir"`, data `{ storyIds }`.
3. `findSpecStructureViolations(backfilledPrd, args.specContent)`. When non-empty:
   - if `_persistPrdDeps.existsSync(args.outputPath)`, call `_persistPrdDeps.renameSync(args.outputPath, join(dirname(args.outputPath), "prd.rejected.json"))`;
   - throw `new NaxError(message, "PLAN_SPEC_STRUCTURE_VIOLATION", { stage: "plan", violations })`. `message` starts with `[plan] PRD does not match the spec's declared story structure`, names the rejected-draft path, and lists `formatSpecStructureViolation` for every violation, one per line.
4. Otherwise continue with the backfilled PRD.

`formatSpecStructureViolation` output, one line per kind:
- `US-004: missing — the spec declares it; never merge or rename a spec story`
- `US-006: not in the spec — remove it or move its ACs back to their spec story`
- `US-003: workdir is "packages/lib"; the spec says "apps/api"`
- `US-005: dependencies are [US-001]; the spec says [US-001, US-003]`
- `Modifies "apps/api/tests/test_x.py" (US-004): no PRD story owns it`

**Repair turn and prompts (US-003).**

- New module `src/operations/plan-structure-heal.ts` exports `specStructureSelfHealStep<I extends { specContent: string; featureName: string; branchName: string; outputPath: string }>(builder: PlanPromptBuilder, readFile: (path: string) => Promise<string | null>): SelfHealStep<I>`, built with `makeSelfHealStep`. It declares no deps object of its own: each op passes its own injectable `readFile`, so the existing hopBody tests that stub `_planRefineDeps.readFile` stay hermetic, and importing the step from `plan-refine.ts` creates no cycle. `planRefineOp` passes `_planRefineDeps.readFile`; `src/operations/plan.ts` gains `export const _planInteractiveDeps = { readFile }` with the same shape and error handling as `_planRefineDeps.readFile`, and `planInteractiveOp` passes `_planInteractiveDeps.readFile`.
  - `detect` reads `outputPath` through the passed `readFile` and returns `[]` when the file is absent or fails `validatePlanOutput`. Otherwise it returns `findSpecStructureViolations(backfillSpecWorkdirs(prd, extractSpecStructure(specContent)).prd, specContent)`.
  - `buildRepair` returns `builder.buildSpecStructureRepair(violations, outputPath)`.
  - `log`: kind `"plan"`, message `"PRD diverged from the spec's declared story structure — issuing one repair turn"`, meta `{ featureName, violationCount }`.
- `planInteractiveOp.hopBody(initialPrompt, ctx)`: `seed = await ctx.sendWithParseRetry(initialPrompt)`, then return `runSelfHealChain(ctx, seed, [specStructureSelfHealStep(new PlanPromptBuilder(), _planInteractiveDeps.readFile)])`.
- `planRefineOp.hopBody`: the step list becomes `[specStructureSelfHealStep(builder, _planRefineDeps.readFile), outOfScopeSelfHealStep(builder), ...(specGuard ? [specDriftSelfHealStep(builder)] : [])]`, and `buildRefineContinuation` receives `bindingStructure = extractSpecStructure(ctx.input.specContent).stories.length > 0`.
- `PlanPromptBuilder.buildSpecStructureRepair(violations: readonly SpecStructureViolation[], outputFilePath: string): string`. It opens with `Your PRD does not match the story structure the spec declares. The spec's stories are binding.`, then the formatted violation lines, then:
  - restore every missing spec story under its own id, and move each acceptance criterion back to the story the spec states it under;
  - remove any story the spec does not declare;
  - set `workdir` and `dependencies` exactly as the Binding Story Structure lists;
  - never merge, split or rename a spec story;
  - the standard closing: write the corrected PRD to the file path, then reply with a brief confirmation.
- `PlanPromptBuilder.build`: when `extractSpecStructure(specContent).stories.length > 0`, `taskContext` gains a `## Binding Story Structure` section right after `## Spec`. The section's text:

  > The spec pre-decomposes this feature into the stories below. This structure is binding: the PRD must contain exactly these story ids — never merge, split, rename or add a story. Set each story's "workdir" and "dependencies" exactly as listed. Every acceptance criterion stays in the story the spec states it under. A spec story whose acceptance criteria are all integration or test criteria stays its own story: the Story Rules about combining small tasks and about test-only stories do not apply to a story the spec declares.

  It is followed by a table with columns `Story | Workdir | Depends on`: the workdir or `(not stated)`, and the ids comma-separated, `none`, or `(not stated)`. In a monorepo with a binding structure, the `## Monorepo Context` sentence `For each user story, set the "workdir" field to the relevant package path…` is replaced by `Set each story's "workdir" to the Workdir the Binding Story Structure lists; for a story whose Workdir is not stated, set it to the relevant package path.`
- `buildRefineContinuation(..., bindingStructure = true)` appends to `#### dependency-minimization`: `Never add or remove a dependency of a story the Binding Story Structure lists, and never merge, split or rename one of its stories.`
- `GROUPING_RULES` (`src/config/test-strategy.ts`) is **not** edited. It is shared, and it is correct for specs that declare no stories.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Spec declares no `US-00N` ids | The structure check, repair step and binding section are all off; behaviour is unchanged |
| Scoped write (`nax plan --decompose`, `args.scope` set) | The structure check is skipped |
| A spec field cannot be read (conflicting `Workdir`, `none` plus ids) | That field is not enforced for that story, and a warn is logged |
| Spec states no dependencies for a story | That story's dependency check is skipped |
| PRD story has no workdir, spec states one | Backfilled from the spec, with a warn; not a violation |
| Draft still violates after the repair turn | Draft renamed to `prd.rejected.json`, `NaxError` `PLAN_SPEC_STRUCTURE_VIOLATION` thrown; the strategies' recovery finds no draft and re-throws; the CLI exits 1 |
| Repair-step `detect` finds the draft absent or unparseable | No repair turn; the write-step check still runs on whatever PRD reaches it |
| Rejected-draft rename when no draft exists at `outputPath` | No rename; the throw still happens |

## Out of Scope

- `nax spec lint` checking `Workdir` / `Depends on` statements itself — the lint gains nothing in this feature beyond importing the moved `declaredStoryIds`.
- Updating the nax-spec-kit-skills spec-writing guide; that change lives in a different repository.
- Backfilling or enforcing a spec's `### Context Files` entries on the PRD (#1466's ruling that `contextFiles` is planner-chosen and capped at 5 stands).
- The exit-0 behaviour of `nax plan` on usage errors and config-validation errors.
- Changing `toRepoFrame` or any of its package-scoped callers (`src/context/builder.ts`, `src/context/engine/scope-path-match.ts`).
- Making legacy PRDs (no `workdirSource`) self-heal; they keep today's runtime re-frame in `scope-files.ts`.
- Editing the `GROUPING_RULES` constant; the binding section overrides it only for spec-declared stories.
- A CLI flag to bypass the structure check.

## Stories

1. **US-001: Repo-rooted declared paths stay as written** — no dependencies
2. **US-002: Spec story structure is enforced at the PRD write step** — depends on US-001
3. **US-003: Binding structure in the plan prompts and one repair turn** — depends on US-002

US-002 depends on US-001 because both edit `finalizeAndWritePrd` in `src/plan/strategies/persist-prd.ts`. US-003 depends on US-002 because it calls `extractSpecStructure` and `findSpecStructureViolations`.

US-001 verification note: the ADR-032 amendment, the design-doc note and the header-comment fixes are documentation. They are checked in review, not by an AC.

### Context Files

**US-001**
- `src/prd/workdir-canonical.ts` — `canonicalizeDeclaredPath`, `canonicalizePrdWorkdirs`, `findNonCanonicalDeclaredPaths`, `ExistsProbe`
- `src/plan/strategies/persist-prd.ts` — `finalizeAndWritePrd`, `_persistPrdDeps`, the canonicalization and non-canonical warn blocks
- `src/pipeline/scope-files.ts` — `resolveScopeFiles`
- `src/utils/path-frame.ts` — `toRepoFrame`, `isWithinPackage`, `normalizeWorkdir`
- `docs/adr/ADR-032-single-frame-repo-rooted-paths.md` — R3, R5, the Rules for new code

**US-002**
- `src/plan/strategies/persist-prd.ts` — `finalizeAndWritePrd`, `_persistPrdDeps`
- `src/prd/spec-lint.ts` — `declaredStoryIds`, `GROUPED_PATH_SUBSECTION`
- `src/prd/modifies-extract.ts` — `extractSpecModifiedFiles`, `SpecModifiedFile`
- `src/plan/strategies/write-prd.ts` — `writeOrRecoverPrd` recovery path
- `src/plan/strategies/single.ts` — `SinglePlanStrategy.execute` recovery path

**US-003**
- `src/prompts/builders/plan-builder.ts` — `PlanPromptBuilder.build`, `buildRefineContinuation`, `buildOutOfScopeRepair`
- `src/operations/plan.ts` — `planInteractiveOp`
- `src/operations/plan-refine.ts` — `planRefineOp.hopBody`, `outOfScopeSelfHealStep`, `_planRefineDeps`
- `src/operations/self-heal.ts` — `makeSelfHealStep`, `runSelfHealChain`
- `src/prd/spec-structure.ts` — created by US-002, used here

### Creates

**US-002**
- `src/prd/spec-structure.ts` — `declaredStoryIds`, `extractSpecStructure`, `backfillSpecWorkdirs`, `findSpecStructureViolations`, `formatSpecStructureViolation`

**US-003**
- `src/operations/plan-structure-heal.ts` — `specStructureSelfHealStep`

### Modifies

**US-001**
- `test/unit/prd/workdir-canonical.test.ts` — five groups of tests pin the old always-prefix rule; update each and keep every other test in the file as it is. (1) The canonicalizeDeclaredPath describe block calls the two-argument signature and expects "src/new.ts" and "packages/application/x.ts" to gain the "packages/app/" prefix: rewrite it for the four-argument signature, where "src/new.ts" (absent everywhere) stays "src/new.ts", "packages/application/x.ts" stays as written, and "src/a.ts" present only under the package becomes "packages/app/src/a.ts" with respelled true. (2) In the canonicalizePrdWorkdirs block, "derives a workdir and re-spells the story's declared paths" expects expectedFiles "packages/app/src/b.ts" and "reframes modifiedFiles the same way as contextFiles" expects "packages/app/src/existing.ts"; both paths exist nowhere in their probes, so change those two expectations to the unprefixed paths, while contextFiles entries that exist only under the package keep the prefixed expectation. (3) "the result carries exactly { prd, defaulted }" expects the keys ["defaulted", "prd"]; the new invariant is ["defaulted", "prd", "respelled"]. (4) The first test of the describe block "frame is independent of disk state (single-frame redesign, design §6)" feeds package-relative paths across two fake-fs states; change its story paths to the repo-rooted spellings "packages/app/src/a.ts", "packages/app/src/new.ts" and "packages/app/src/b.ts" so the byte-identical assertion holds as the new invariant for repo-rooted input, and keep the second test unchanged. (5) The findNonCanonicalDeclaredPaths tests "flags a contextFiles entry that is not repo-rooted…", "flags an expectedFiles entry…", "flags a modifiedFiles entry…" and "flags a non-string contextFiles entry…" use a bare "src/a.ts"-style example, which the new rule does not flag; change each example to a spelling-non-canonical path such as "./packages/app/src/a.ts", keeping the invariant that a spelling the normaliser would change is still flagged on a stamped story.
- `test/unit/plan/strategies/persist-prd-workdir.test.ts` — "warns and still writes when packaging discovery throws and a pre-stamped story stays package-relative" expects a non-canonical warning for the path "src/a.ts", which the new rule does not flag. Change the stamped story's contextFiles path and the expected nonCanonical entry's path to "./src/a.ts". The invariant is that the warning still fires, and the PRD is still written, when discovery throws and a stamped story carries a non-canonical spelling.

**US-002**
- `test/unit/plan/fidelity-survives-recovery.test.ts` — the `SPEC` fixture declares only `**US-001**` under `## Stories`, while `DISK_PRD` has US-001 and US-002, so the new structure check would throw `extra-story`. Add a line `**US-002**: do another thing` under `## Stories`, after the US-001 line. The invariant is unchanged: all three tests still assert that the spec's Modifies authority reaches both stories on the refine, single and happy paths.

**US-003**
- `test/unit/operations/plan-refine.test.ts` — the hopBody test asserts that the buildRefineContinuation spy was called with exactly ("/tmp/plan-refine-prd.json", false). planRefineOp.hopBody now passes a third bindingStructure argument, which is false for that test's spec because it declares no stories. Change the expectation to ("/tmp/plan-refine-prd.json", false, false); every other assertion in the test, including the send and sendWithParseRetry call counts, keeps its value.
- `test/unit/operations/plan-interactive.test.ts` — "fileOutput is defined and returns outputPath; hopBody is undefined" asserts `planInteractiveOp.hopBody` is undefined. Rename the test to "fileOutput is defined and returns outputPath; hopBody is defined" and assert `hopBody` is a function. The `fileOutput` assertions stay as they are.

### Seams

- US-001 AC18 and AC19: `resolveScopeFiles` is reached from the context stage (`src/pipeline/stages/context.ts:135`); the AC exercises `resolveScopeFiles` with a stamped story and a legacy story.
- US-002 AC19 and AC20: `SinglePlanStrategy.execute` and `RefinePlanStrategy.execute` → `persistPrd` → `finalizeAndWritePrd` → `findSpecStructureViolations`. Observed through the rejected error, `prd.rejected.json`, and the absence of `prd.json`, with `_singlePlanDeps.callOp` / `_refinePlanDeps.callOp` stubbed to return a folded PRD.
- US-003 AC10 and AC12: `planInteractiveOp.hopBody` and `planRefineOp.hopBody` → `specStructureSelfHealStep` → `PlanPromptBuilder.buildSpecStructureRepair`, observed through `ctx.send` calls.

## Acceptance Criteria

### US-001

1. `[unit]` When `canonicalizeDeclaredPath("docs/pipelines/report.pipeline.json", "packages/lib", "/repo", exists)` is called and `exists` reports `/repo/docs/pipelines/report.pipeline.json` present, the result is `{ path: "docs/pipelines/report.pipeline.json", respelled: false }`.
2. `[unit]` When `canonicalizeDeclaredPath("docs/pipelines/report.pipeline.json", "packages/lib", "/repo", exists)` is called and `exists` reports every path absent, the result is `{ path: "docs/pipelines/report.pipeline.json", respelled: false }` (a file the story will create stays repo-rooted).
3. `[unit]` When `canonicalizeDeclaredPath("packages/db/src/schema.ts", "apps/api", "/repo", exists)` is called with `/repo/packages/db/src/schema.ts` present, the result path is `packages/db/src/schema.ts` and `respelled` is false.
4. `[unit]` When `canonicalizeDeclaredPath("src/a.ts", "packages/lib", "/repo", exists)` is called with `/repo/packages/lib/src/a.ts` present and `/repo/src/a.ts` absent, the result is `{ path: "packages/lib/src/a.ts", respelled: true }`.
5. `[unit]` When `canonicalizeDeclaredPath("src/a.ts", "packages/lib", "/repo", exists)` is called with both `/repo/src/a.ts` and `/repo/packages/lib/src/a.ts` present, the result is `{ path: "src/a.ts", respelled: false }`.
6. `[unit]` When `canonicalizeDeclaredPath("./packages/lib/src/a.ts/", "packages/lib", "/repo", exists)` is called, the result path is `packages/lib/src/a.ts` and `respelled` is false, whatever `exists` reports.
7. `[unit]` When `canonicalizeDeclaredPath("src/a.ts", ".", "/repo", exists)` is called at the repo root, the result is `{ path: "src/a.ts", respelled: false }` and `exists` is never invoked.
8. `[unit]` When `canonicalizePrdWorkdirs` runs over a story with `workdir: "packages/lib"`, `expectedFiles: ["docs/pipelines/report.pipeline.json"]` and a probe reporting nothing present, the written story's `expectedFiles` equals `["docs/pipelines/report.pipeline.json"]`.
9. `[unit]` When `canonicalizePrdWorkdirs` runs over a story with `workdir: "apps/api"` and `contextFiles: ["packages/db/src/schema.ts", { path: "docs/design.md", factId: "F-1" }]`, both existing at the repo root, the story's `contextFiles` equals the input unchanged, including the `factId` object.
10. `[unit]` When `canonicalizePrdWorkdirs` runs over a story with `workdir: "packages/lib"` and `modifiedFiles: [{ path: "apps/api/tests/test_count.py", reason: "r" }]`, existing at the repo root, the story's `modifiedFiles` equals `[{ path: "apps/api/tests/test_count.py", reason: "r" }]`.
11. `[unit]` When `canonicalizePrdWorkdirs` re-spells `src/a.ts` into `packages/lib/src/a.ts` on story `US-002`'s `contextFiles`, the returned `respelled` equals `[{ storyId: "US-002", field: "contextFiles", from: "src/a.ts", to: "packages/lib/src/a.ts" }]`.
12. `[unit]` When `canonicalizePrdWorkdirs` runs twice over its own output, the second result's stories equal the first's and the second `respelled` is empty (the rule is a fixed point).
13. `[unit]` When `normalizeDeclaredPathSpelling` receives the Windows-style spelling `.\packages\lib\src\a.ts\` (leading `.\`, backslash separators, trailing backslash), it returns `packages/lib/src/a.ts`, and it returns an already-normalised `packages/lib/src/a.ts` unchanged.
14. `[unit]` When `findNonCanonicalDeclaredPaths` inspects a stamped story (`workdirSource: "stated"`, `workdir: "packages/lib"`) whose `contextFiles` is `["docs/x.md"]` and whose `modifiedFiles` path is `apps/api/tests/t.py`, it returns an empty array.
15. `[unit]` When `findNonCanonicalDeclaredPaths` inspects a stamped story whose `expectedFiles` is `["./packages/lib/src/new.ts"]`, it returns `[{ storyId, field: "expectedFiles", path: "./packages/lib/src/new.ts" }]`.
16. `[integration]` When `finalizeAndWritePrd` writes a PRD whose `packages/lib` story declares `src/a.ts` (present only under `/repo/packages/lib`) with `_persistPrdDeps.discoverWorkspacePackages` returning `["packages/lib"]`, the plan logger records one warn whose message is `declared paths spelled package-relative were re-spelled into the repo frame` and whose data `respelled` names that entry, and the written PRD carries `packages/lib/src/a.ts`.
17. `[integration]` When `finalizeAndWritePrd` writes a PRD whose `packages/lib` story declares `expectedFiles: ["docs/pipelines/report.pipeline.json"]` (absent everywhere), the written PRD keeps that path unchanged and no `outside the repo frame` warning is logged.
18. `[unit]` When `resolveScopeFiles` runs for a story with `workdirSource: "stated"`, `workdir: "packages/lib"` and `contextFiles: ["docs/x.md"]`, with the diff collector returning no files, the result is `["docs/x.md"]`.
19. `[unit]` When `resolveScopeFiles` runs for a legacy story (no `workdirSource`) with `workdir: "packages/app"` and `contextFiles: ["src/declared.ts"]`, with the diff collector returning no files, the result is `["packages/app/src/declared.ts"]` (legacy re-frame preserved).
20. `[unit]` When `canonicalizePrdWorkdirs` runs with `opts.only` set to one story id, a story outside the set is returned by identity, and its package-relative paths are neither re-spelled nor reported in `respelled`.

### US-002

1. `[unit]` When `extractSpecStructure` reads a spec whose `## Stories` lists `1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies` and `2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001`, it returns stories `[{ id: "US-001", workdir: "packages/core", dependsOn: [] }, { id: "US-002", workdir: "apps/api", dependsOn: ["US-001"] }]` and no warnings.
2. `[unit]` When `extractSpecStructure` reads a spec whose `### Context Files` subsection has a `**US-003**` lead-in followed by the line `_Workdir \`apps/web\`._`, story US-003's `workdir` is `apps/web`.
3. `[unit]` When `extractSpecStructure` reads story bullets `- **Depends on:** US-001 (shared type)`, `*(depends on US-001, US-002 and US-003)*` and `- Depends on: none` under three different story headings, the stories' `dependsOn` are `["US-001"]`, `["US-001", "US-002", "US-003"]` and `[]` respectively.
4. `[unit]` When a story declared in `## Stories` carries no dependency statement, `extractSpecStructure` returns that story with `dependsOn` undefined.
5. `[unit]` When a `### Modifies` reason under a `**US-002**` lead-in reads `the count test depends on US-003's registration`, `extractSpecStructure` does not add US-003 to US-002's `dependsOn`.
6. `[unit]` When one story states `Workdir: packages/lib` and later `Workdir: apps/api`, `extractSpecStructure` returns that story with `workdir` undefined and a warning whose `field` is `workdir`.
7. `[unit]` When a spec declares no `US-00N` ids in `## Stories` or `## Acceptance Criteria`, `findSpecStructureViolations` returns an empty array for any PRD.
8. `[unit]` When the spec declares US-001 to US-005 and the PRD has US-001, US-002, US-003 and US-005, `findSpecStructureViolations` returns `[{ kind: "missing-story", storyId: "US-004" }]` plus any other violations.
9. `[unit]` When the PRD contains a story `US-006` the spec does not declare, `findSpecStructureViolations` includes `{ kind: "extra-story", storyId: "US-006" }`.
10. `[unit]` When the spec states `Workdir: apps/api` for US-004 and the PRD story US-004 has `workdir: "packages/lib"`, `findSpecStructureViolations` includes `{ kind: "workdir-mismatch", storyId: "US-004", expected: "apps/api", actual: "packages/lib" }`.
11. `[unit]` When the spec states `Workdir: apps/api` for US-004 and the PRD story US-004 has no `workdir`, `findSpecStructureViolations` reports no `workdir-mismatch` for US-004.
12. `[unit]` When the spec states `depends on US-001, US-003` for US-005 and the PRD story US-005 has `dependencies: ["US-001"]`, `findSpecStructureViolations` includes a `dependencies-mismatch` for US-005 with `expected` `["US-001", "US-003"]` and `actual` `["US-001"]`.
13. `[unit]` When the spec states `no dependencies` for US-002 and the PRD story US-002 has `dependencies: ["US-001"]`, `findSpecStructureViolations` includes a `dependencies-mismatch` for US-002 (an added dependency is a violation).
14. `[unit]` When the spec's `### Modifies` groups `apps/api/tests/test_count.py` under `**US-004**` and the PRD has no US-004, `findSpecStructureViolations` includes `{ kind: "orphan-modifies", storyId: "US-004", path: "apps/api/tests/test_count.py" }`.
15. `[unit]` When `backfillSpecWorkdirs` runs over a PRD whose US-004 has no workdir and whose spec states `Workdir: apps/api` for US-004, the returned PRD's US-004 has `workdir: "apps/api"`, `backfilled` equals `["US-004"]`, and the input PRD object is not mutated.
16. `[unit]` When `formatSpecStructureViolation` receives `{ kind: "dependencies-mismatch", storyId: "US-005", expected: ["US-001", "US-003"], actual: ["US-001"] }`, it returns `US-005: dependencies are [US-001]; the spec says [US-001, US-003]`.
17. `[integration]` When `finalizeAndWritePrd` (unscoped) receives a PRD that omits spec story US-004, and `_persistPrdDeps.existsSync` reports the draft at `outputPath` present, it calls `_persistPrdDeps.renameSync(outputPath, <dir>/prd.rejected.json)`, never calls `writeFile`, and rejects with a `NaxError` whose `code` is `PLAN_SPEC_STRUCTURE_VIOLATION` and whose message contains `US-004: missing`.
18. `[integration]` When `finalizeAndWritePrd` receives a PRD whose only divergence is a missing workdir the spec states, it writes the PRD with that workdir filled in and logs a warn whose message is `PRD stories had no workdir — filled from the spec's Workdir` with data `storyIds` `["US-004"]`.
19. `[integration]` When `SinglePlanStrategy.execute` runs with `_singlePlanDeps.callOp` returning a PRD that folds spec story US-004 into US-003, and the deps' file system holds the draft at `outputPath`, the call rejects with code `PLAN_SPEC_STRUCTURE_VIOLATION`, the draft is renamed to `prd.rejected.json`, and no `prd.json` is written or recovered as a degraded result.
20. `[integration]` When `RefinePlanStrategy.execute` runs with `_refinePlanDeps.callOp` returning the same folded PRD, the call rejects with code `PLAN_SPEC_STRUCTURE_VIOLATION` rather than returning a `PlanResult` with `degraded` set.
21. `[integration]` When `finalizeAndWritePrd` runs with `scope` set (the `--decompose` write) over a PRD whose sub-story ids the spec does not declare, it writes the PRD and throws no `PLAN_SPEC_STRUCTURE_VIOLATION`.
22. `[unit]` When `lintSpecContent` runs over a spec whose `### Modifies` groups a path under `**US-009**` that `## Stories` does not declare, it still reports the unknown-story finding it reported before `declaredStoryIds` moved (spec-lint behaviour unchanged).

### US-003

1. `[unit]` When `PlanPromptBuilder.build` receives a spec declaring US-001 (`Workdir: packages/core`, no dependencies) and US-002 (`Workdir: apps/api`, depends on US-001), the returned `taskContext` contains a `## Binding Story Structure` section, placed after the `## Spec` section, with one table row per story naming `packages/core` / `none` and `apps/api` / `US-001`.
2. `[unit]` When `PlanPromptBuilder.build` receives a spec that declares no `US-00N` ids, the returned `taskContext` has no `## Binding Story Structure` section.
3. `[unit]` When `PlanPromptBuilder.build` receives a spec story whose dependencies and Workdir are not stated, its table row shows `(not stated)` in both columns.
4. `[unit]` When `PlanPromptBuilder.build` receives a spec with declared stories and a non-empty `packages` list, the monorepo section tells the planner to set each story's `workdir` to the Workdir the Binding Story Structure lists, and no longer says `set the "workdir" field to the relevant package path` for every story.
5. `[unit]` When `PlanPromptBuilder.build` receives a spec with declared stories, the binding section states that a spec story whose acceptance criteria are all integration or test criteria stays its own story, and that the Story Rules about combining tasks and test-only stories do not apply to a spec-declared story.
6. `[unit]` When `buildRefineContinuation(path, false, true)` is called, its `#### dependency-minimization` item includes `Never add or remove a dependency of a story the Binding Story Structure lists`; when called with `bindingStructure` false, that sentence is absent.
7. `[unit]` When `buildSpecStructureRepair` receives a `missing-story` violation for US-004 and an `orphan-modifies` violation, the returned prompt contains `US-004: missing` and the orphan's formatted line, instructs the planner to move each acceptance criterion back to the story the spec states it under, and names the output file path.
8. `[unit]` When `specStructureSelfHealStep` is built with a `readFile` returning a draft that omits spec story US-004, the step sends exactly one corrective turn whose prompt is the `buildSpecStructureRepair` output.
9. `[unit]` When the passed `readFile` returns null, or returns content that fails `validatePlanOutput`, `specStructureSelfHealStep` sends no corrective turn.
10. `[integration]` When `planInteractiveOp.hopBody` runs with a spec declaring US-001 to US-005 and `_planInteractiveDeps.readFile` returning a draft that omits US-004, `ctx.sendWithParseRetry` is called once with the initial prompt, and `ctx.send` is called exactly once with the structure repair prompt.
11. `[integration]` When `planInteractiveOp.hopBody` runs with a spec that declares no story ids, `ctx.send` is never called, and the result is the `sendWithParseRetry` turn.
12. `[integration]` When `planRefineOp.hopBody` runs with `_planRefineDeps.readFile` returning a draft that omits a spec story and also drops a feature-level out-of-scope item, the structure repair is sent before the out-of-scope repair (`ctx.send` call order: refine continuation, structure repair, out-of-scope repair).
13. `[integration]` When `planRefineOp.hopBody` runs with a spec declaring stories, the refine continuation it sends contains the binding dependency-minimization sentence.
14. `[integration]` When the draft still omits US-004 after the repair turn, `planInteractiveOp.hopBody` sends no second structure repair (at most one repair turn per plan).
15. `[unit]` When `planInteractiveOp.hopBody` accumulates a seed turn costing 0.2 USD and a repair turn costing 0.1 USD, the returned turn's `estimatedCostUsd` is 0.3.
