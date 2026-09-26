# SPEC: Scoped fix review — judge what a fix pass changed

## Summary

Add a scoped fix review (ADR-033) that runs after a fix pass and judges only what that pass
changed. It has two ordered parts: a deterministic scope check (did the fix touch a non-test file
the story neither changed, declared, nor was told about by a finding?) and a verdict-only LLM check
(does the fix diff contradict any acceptance criterion, the story's design description, or an
`outOfScope` rule?). It is wired into the non-blocking fix (NBF) keep path, where anything but a pass
restores the adversarial-passed snapshot, and after each `autofix-test-writer` dispatch in the
blocking fix cycle, where only a contradiction of a named acceptance criterion becomes a finding for
the next test-writer iteration; every other non-pass there is a warning. Closes #2229.

## Motivation

Verified on `main` @ `db5bc9ae0`:

- NBF strips both LLM reviews from its re-validation: `REVIEW_PHASE_KINDS` and
  `nonBlockingExcludePhases()` in `src/execution/non-blocking-fix.ts`. A kept pass is guarded only
  by lint, typecheck, the full-suite gate, the verifier (when tests were edited) and `sourceDiffCap`.
- `autofix-test-writer` re-validates with `["lint-check","typecheck-check","full-suite-gate","adversarial-review"]`
  (`STRATEGY_TO_REVALIDATION_PHASES`, `src/execution/story-orchestrator/types.ts`), with no
  AC-compliance check.
- #2229 evidence (canary.19, `approvals-cli`): NBF kept a pass that added
  `mkdir(dirname(path), { recursive: true })` to `removeApprovals`, contradicting the spec's removal
  rule 4, and changed the shared `withPathFileLock` primitive in `src/utils/path-file-lock.ts`,
  outside the feature's scope. Every gate stayed green.
- Rule 4 ("neither the data file nor its parent directory is created") lives only in that spec's
  Design "Removal rules"; its US-002 AC 2 pins only that no file exists at the path, which the
  `mkdir` change still satisfies. So a check that reads only the ACs would miss the #2229 case; the
  fix review must also read `story.description`, where the planner carries design prose.
- nax#1359 (closed 2026-09-26) ruled out a blocking gate on out-of-scope findings: scope creep is a
  non-defect signal, a scope exclusion can forbid the only fixing edit, and invariants belong in ACs,
  where the existing blocking path already covers them. So on the blocking path only an
  AC-anchored contradiction may block; scope violations and description-only contradictions warn.
- Simply re-running `semantic-review` does not fit: at dispatch, `refreshReviewInputForDispatch`
  (`src/execution/story-orchestrator/run-phase.ts`) re-points every revalidation review at the story
  start ref, so it would re-review the whole story and emit open-ended findings (ADR-033 Context).
- The diff helpers in `src/review/diff-utils.ts` are hard-wired to `<ref>..HEAD`, and
  `captureWorkingTreeChanges` (`src/utils/git.ts`) returns `[]` on any git failure and lists every
  untracked file, pre-existing or not. Neither can say what a fix changed in the working tree.

## Design

### Approach

The scope check is deterministic path arithmetic. The contradiction check is one LLM call on a fresh
session that returns a single JSON verdict; it never returns a finding list.

`runFixReview` evaluates in this fixed order and stops at the first stage that decides:

1. `review.fixReview.enabled === false` → pass, not reviewed.
2. Snapshot the working tree after the fix; list the paths changed between the pre-fix tree and it.
   No changed path → pass, not reviewed.
3. Scope check over the changed paths → on violation, fail with cause `scope`. No LLM call.
4. LLM verdict over the fix diff → pass, or fail with cause `contradiction`.

Any git failure in stage 2 or 3, an LLM dispatch error, or an unparseable response in stage 4 ends
evaluation with kind `error`.

### Types (new module `src/review/fix-review/types.ts`)

```ts
import type { Finding } from "../../findings/types";
import type { UserStory } from "../../prd/types";
import type { ReviewConfig } from "../types";

/** Outcome of one scoped fix review. */
export type FixReviewVerdict =
  | { readonly kind: "pass"; readonly reviewed: boolean; readonly reason: string }
  | { readonly kind: "fail"; readonly cause: "scope"; readonly files: readonly string[]; readonly reason: string }
  | {
      readonly kind: "fail";
      readonly cause: "contradiction";
      readonly reason: string;
      /** 1-based index into story.acceptanceCriteria, when the reviewer named one. */
      readonly acIndex?: number;
      readonly file?: string;
    }
  | { readonly kind: "error"; readonly reason: string };

/** What `fixReviewOp.parse` returns. */
export type FixReviewOpOutput =
  | { readonly parsed: true; readonly passed: boolean; readonly reason: string; readonly acIndex?: number; readonly file?: string }
  | { readonly parsed: false; readonly unparsedPreview: string };

export interface FixReviewRequest {
  /** The story's package dir (`ctx.packageDir`); git runs here, and git output is repo-root-relative. */
  readonly workdir: string;
  readonly story: UserStory;
  /** Tree-ish of the working tree before the fix (a commit sha or a tree id). */
  readonly preFixTree: string;
  /** The findings that seeded this fix. */
  readonly findings: readonly Finding[];
  readonly config: ReviewConfig;
}
```

### Config (US-001)

`ReviewConfigSchema` (`src/config/schemas-review.ts`) gains `fixReview`, next to `nonBlockingFix`:

```ts
export const FixReviewConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Optional; unset falls back to review.semantic.model, then "balanced". */
  model: ConfiguredModelSchema.optional(),
  timeoutMs: z.number().int().positive().default(600_000),
});
// in ReviewConfigSchema:
fixReview: FixReviewConfigSchema.default({}),
```

- The review default literal in `src/config/schemas.ts` gains `fixReview: FixReviewConfigSchema.parse({})`.
- The hand-written `ReviewConfig` in `src/review/types.ts` gains `fixReview` (its key-drift guard
  fails typecheck otherwise). `FixReviewConfig = z.infer<typeof FixReviewConfigSchema>` is exported
  from `src/config/selectors.ts` beside `NonBlockingFixConfig`.
- New `resolveFixReviewModel(review: ReviewConfig): ConfiguredModel` in `src/review/fix-review/config.ts`:
  `review.fixReview.model ?? review.semantic?.model ?? "balanced"`.
- `src/precheck/checks-model-resolution-walk.ts` lists `review.fixReview.model` as a model site when set.

### Session role and audit (US-001)

- `CanonicalSessionRole` and `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts`) gain `"reviewer-fix"`.
- The reviewer union `"semantic" | "adversarial"` gains `"fix"` wherever it is spelled out:
  `ReviewDecisionPayload` (`src/execution/story-orchestrator/types.ts`), `ReviewAuditEntry`,
  `ReviewAuditDispatch`, `AdvisoryFindingSummaryEntry` and `auditKey` (`src/review/review-audit.ts`),
  `ReviewDecisionEvent` and `ReviewRepromptEvent` (`src/runtime/dispatch-events.ts`), and
  `reviewerFromRole` (`src/runtime/middleware/review-audit.ts`, mapping `"reviewer-fix"` → `"fix"`).
- `toReviewDecisionPayload` (`src/execution/story-orchestrator/review-decision.ts`) gains a
  dedicated `"fix-review"` branch, taken before its reviewer-name check and before any of the
  existing branches that read `record.findings`, `acDropped`, `acks` or `advisoryFindings`
  (`FixReviewOpOutput` has none of them). The branch maps the op to reviewer `"fix"`. A parsed
  `FixReviewOpOutput` becomes `parsed: true` with `result: { passed, findings }`, where `findings` is
  synthesized: `[]` on a pass and one `{ message: reason, acIndex, file }` entry on a fail. An
  unparsed output becomes `parsed: false`, `result: null`, with `unparsedPreview`. The semantic and
  adversarial branches are unchanged.

### Tree snapshot helpers (US-002, new module `src/review/fix-review/tree-snapshot.ts`)

```ts
/** Tree id of the current working tree (tracked + untracked, .gitignore honoured). Mutates nothing. */
export async function snapshotWorkingTree(workdir: string): Promise<string>;
/** Repo-root-relative paths that differ between two tree-ishes (no rename detection). */
export async function changedPathsBetween(workdir: string, from: string, to: string): Promise<string[]>;
/** Unified diff between two tree-ishes, excluding paths under `.nax/`. */
export async function diffBetween(workdir: string, from: string, to: string): Promise<string>;
```

- All three throw `NaxError` with code `FIX_REVIEW_GIT_FAILED` on a non-zero git exit. They never
  return an empty result to mean failure.
- One way to meet `snapshotWorkingTree`'s contract (non-normative): seed a temporary index file from
  `HEAD`, add every path to it, and write a tree from it, passing the temporary index through the
  `gitSpawnEnv` overlay (`src/utils/git-env.ts` documents `GIT_INDEX_FILE` as the intended use),
  then delete the temporary file. The repository's own index and working tree are never touched.
- Git spawns go through `hardenedGitArgv` / `gitSpawnEnv` (enforced by `check:git-spawn-env`),
  mirroring `createMeasureSourceDiff` in `src/execution/non-blocking-fix.ts`.

### Scope check (US-002, new module `src/review/fix-review/scope.ts`)

```ts
export interface FixScopeInput {
  /** Repo-root-relative paths the fix changed. */
  readonly changedFiles: readonly string[];
  /** Repo-root-relative paths the story had changed before the fix; undefined when unknown. */
  readonly storyFiles: readonly string[] | undefined;
  readonly story: Pick<UserStory, "contextFiles" | "relevantFiles" | "expectedFiles" | "modifiedFiles">;
  /** Seeding findings; `file` is workdir-relative (src/findings/types.ts). */
  readonly findings: readonly Pick<Finding, "file">[];
  /** The story package dir relative to the repo root; "" at the root. */
  readonly packageDirRel: string;
  readonly isTestFile: (repoRelPath: string) => boolean;
}

export interface FixScopeResult {
  readonly inScope: boolean;
  readonly outOfScopeFiles: readonly string[];
  /** True when storyFiles was undefined and the check did not run. */
  readonly skipped: boolean;
}

export function checkFixScope(input: FixScopeInput): FixScopeResult;
```

The allowed set is the union of `storyFiles`, `getContextFiles(story)`, `getExpectedFiles(story)`,
`story.modifiedFiles[].path` (all repo-root-relative, ADR-032), and each finding's `file` joined onto
`packageDirRel`. A changed path is exempt when `isTestFile` matches it or it lies under `.nax/`.

### The op and runner (US-003)

- `fixReviewOp: RunOperation<FixReviewOpInput, FixReviewOpOutput, ReviewConfig>` in new
  `src/operations/fix-review.ts`, exported from the ops barrel. Its `ReviewConfig` generic is the
  selector slice type from `src/config/selectors.ts` (as `semanticReviewOp` uses), not the
  `ReviewConfig` interface in `src/review/types.ts`; `FixReviewRequest.config` and
  `resolveFixReviewModel` take the latter. Fields: `name: "fix-review"`,
  `stage: "review"`, `session: { role: "reviewer-fix", lifetime: "fresh" }`,
  `tools: ["Read", "Glob", "Grep"]` (the diff is embedded; the tools let it read surrounding code),
  `config: reviewConfigSelector`, `model: (_input, ctx) => resolveFixReviewModel(ctx.config.review)`,
  `timeoutMs: (_input, ctx) => ctx.config.review.fixReview.timeoutMs`. There is no parse-retry.
  `FixReviewOpInput` is `{ story: UserStory; diff: string; findings: readonly Finding[] }`.
- The prompt comes from `buildFixReviewPrompt(input)` in new
  `src/prompts/builders/fix-review-builder.ts`, exported through the `@/prompts` barrel. It
  contains the story's acceptance criteria numbered from 1, the story's `description`, the
  `outOfScope` block from `buildReviewOutOfScopeBlock`, the seeding findings' messages, the embedded
  fix diff, and an instruction to answer with exactly this JSON object, setting `acIndex` only when
  the contradicted rule is an acceptance criterion:

  ```json
  { "passed": false, "reason": "adds mkdir to removeApprovals; AC 4 forbids creating directories", "acIndex": 4, "file": "src/approvals/remove.ts" }
  ```

  `acIndex` and `file` are optional. A pass is `{ "passed": true, "reason": "..." }`.
- `runFixReview(ctx: CallContext, req: FixReviewRequest, deps?: Partial<FixReviewDeps>): Promise<FixReviewVerdict>`
  in new `src/review/fix-review/run.ts` follows the Approach order. Story files are
  `changedPathsBetween(workdir, story.storyGitRef, preFixTree)` when `storyGitRef` is set, else
  `undefined`. The diff is `truncateDiff(diffBetween(workdir, preFixTree, postTree))`
  (`src/review/diff-utils.ts`). After the LLM stage, parsed or not, it calls
  `emitReviewDecision(ctx, "fix-review", output)` once. `FixReviewDeps` injects `callOp`,
  `snapshotWorkingTree`, `changedPathsBetween`, `diffBetween`, `emitReviewDecision` and
  `resolveTestFilePatterns`, the same `_deps` seam pattern as `_nonBlockingFixDeps`.
- The test-file classifier is `createTestFileClassifier(await resolveTestFilePatterns(config, projectDir, packageDirRel))`,
  as in `createMeasureSourceDiff`.

### NBF wiring (US-004)

- `NonBlockingFixDeps` (`src/execution/non-blocking-fix.ts`) gains the optional field
  `reviewFix?: (preFixRef: string) => Promise<FixReviewVerdict>`.
- In `runNonBlockingFix`, after the `sourceDiffCap` block and before `flakeTriage.commit()`: when
  `_deps.reviewFix` is set, call it with `restoreRef.sha`. On `kind: "pass"` keep as today. On any
  other kind, log `logger?.info("non-blocking-fix", "fix review rejected the pass — restoring", { storyId, kind, cause, reason, files })`
  and return `restoreToSnapshot(...)`.
- New `buildNbfDeps(args: { ctx: CallContext; findings: readonly Finding[] }): Partial<NonBlockingFixDeps>`
  in new `src/execution/story-orchestrator/nbf-deps.ts` returns `measureSourceDiff`, built exactly as
  the inline `createMeasureSourceDiff(...)` call does today, plus `reviewFix` when `ctx.story` is
  defined:
  `(ref) => runFixReview(ctx, { workdir: ctx.packageDir, story: ctx.story, preFixTree: ref, findings, config: ctx.config.review })`.
- `ctx.story` is populated on this path: the execution stage (`src/pipeline/stages/execution.ts`)
  builds the `CallContext` it hands to `buildPlanForStrategy` with `story: ctx.story`, and
  `buildPlanForStrategy` passes that same `ctx` to `ExecutionPlan`. The `reviewFix`-absent branch
  exists only for callers that construct a `CallContext` without a story.
- `ExecutionPlan.run` (`src/execution/story-orchestrator/execution-plan.ts`) passes
  `buildNbfDeps({ ctx: this.ctx, findings: seed.findings })` as the second argument of
  `runNonBlockingFix` in place of the inline overrides object. The file is at 598 of 600 lines, so
  this change must not add net lines.

### Blocking-cycle wiring for `autofix-test-writer` (US-005)

- `FixStrategy` (`src/findings/cycle-types.ts`) gains the optional field
  `beforeDispatch?: (ctx: FixCycleContext) => Promise<void>`. `dispatchStrategy`
  (`src/findings/cycle-dispatch.ts`) awaits it after `buildInput` and before `callOp`. A strategy
  without it dispatches exactly as today.
- New `src/execution/story-orchestrator/fix-review-strategy.ts`:

  ```ts
  export interface FixReviewWrapper {
    /** Returns a copy of `strategy` that runs the scoped fix review after each dispatch. */
    wrap<F extends Finding, I, O, C>(strategy: FixStrategy<F, I, O, C>): FixStrategy<F, I, O, C>;
    /** Findings produced by fix reviews since the last call, then cleared. */
    drainFindings(): Finding[];
  }
  export function createFixReviewWrapper(args: { ctx: CallContext; story: UserStory; config: ReviewConfig }): FixReviewWrapper;
  /** An AC-anchored contradiction: the only verdict that may block (nax#1359 ruling). */
  export type AnchoredContradiction = Extract<FixReviewVerdict, { cause: "contradiction" }> & { readonly acIndex: number };
  export function toFixReviewFinding(verdict: AnchoredContradiction): Finding;
  ```

  The wrapped strategy records the findings passed to `buildInput`. Its `beforeDispatch` stores
  `snapshotWorkingTree(ctx.packageDir)`; if that throws, it logs a warning and the review is skipped
  for this dispatch. Its `extractApplied` awaits the original `extractApplied`, then, when a pre-fix
  tree was stored, calls `runFixReview` with that tree and the recorded findings. Only a
  `contradiction` verdict that carries an `acIndex` queues `toFixReviewFinding(verdict)`. A `scope`
  fail, a `contradiction` without an `acIndex`, and an `error` each log
  `logger?.warn("fix-review", "fix review non-pass not fed back", { storyId, kind, cause, reason })`
  and queue nothing.
- `toFixReviewFinding` returns `source: "semantic-review"`, `severity: "error"`,
  `category: "fix-review"`, `fixTarget: "test"`, `message: reason`,
  `rule: "fix-review:AC-<acIndex>"`, and the verdict's `file` when present.
- In `src/execution/build-plan-for-strategy.ts`, only the blocking-cycle `autofix-test-writer`
  strategy is wrapped. The NBF strategy lists are not wrapped, because NBF reviews once at its keep
  gate. The blocking cycle's `postValidate` becomes the existing one followed by appending
  `wrapper.drainFindings()`.

### Failure Handling

| Condition | NBF keep gate | Blocking cycle (`autofix-test-writer`) |
|---|---|---|
| `review.fixReview.enabled` is `false` | pass: kept as today | no finding |
| Fix changed no paths | pass: kept, no LLM call | no finding, no LLM call |
| Scope violation | restore, no LLM call | warn, no finding, no LLM call |
| LLM verdict fail naming an AC (`acIndex` set) | restore | one `fix-review:AC-<n>` finding |
| LLM verdict fail naming no AC (description or `outOfScope` rule) | restore | warn, no finding |
| Git failure while snapshotting or diffing | restore (`kind: "error"`) | warn, no finding |
| LLM dispatch throws | restore (`kind: "error"`) | warn, no finding |
| LLM output not parseable | restore (`kind: "error"`) | warn, no finding |
| `story.storyGitRef` absent | scope check skipped, LLM check still runs | same |
| Fix diff above `truncateDiff`'s cap | diff passed truncated | same |

## Out of Scope

- Replacing the full `semantic-review` + `adversarial-review` re-run on `autofix-implementer`, `full-suite-rectify` or `repo-scoped-test-fix` with the scoped fix review; those paths are unchanged.
- Any scope review of a story's own implementation diff, blocking or telemetry-only; nax#1359 ruled on 2026-09-26 that out-of-scope findings get no blocking gate.
- A blocking finding on the `autofix-test-writer` path for a scope violation or for a contradiction that names no acceptance criterion; per nax#1359 those warn only.
- Re-running `adversarial-review` on NBF passes; ADR-024 §3's re-seeding argument still holds for it.
- Changing any entry of `STRATEGY_TO_REVALIDATION_PHASES` or `REVIEW_PHASE_KINDS`.
- Changing whether fix strategies reuse the implementer or test-writer session (warm) or open a fresh one.
- A parse-retry for an unparseable fix-review response; it is treated as `kind: "error"`.
- A new `FindingSource` value for fix-review findings; they use `source: "semantic-review"` with `category: "fix-review"`.
- Changing NBF's own defaults (`review.nonBlockingFix.enabled` stays `false`) or the `sourceDiffCap` values.
- Changing `captureWorkingTreeChanges` in `src/utils/git.ts` or any helper in `src/review/diff-utils.ts`.
- Changes inside git submodules; `snapshotWorkingTree` records submodule entries as git does and does not descend into them.
- A CLI or viewer for fix-review audit records.

## Stories

1. **US-001: Fix-review config, model resolution, session role and audit kind** — no dependencies
2. **US-002: Working-tree snapshot helpers and the scope check** — no dependencies
3. **US-003: `fixReviewOp`, its prompt, and `runFixReview`** — depends on US-001, US-002
4. **US-004: Scoped fix review at the NBF keep gate** — depends on US-003
5. **US-005: Scoped fix review after `autofix-test-writer` in the blocking cycle** — depends on US-003

### Context Files

**US-001**
- `src/config/schemas-review.ts` — `NonBlockingFixConfigSchema` is the sibling to mirror
- `src/runtime/middleware/review-audit.ts` — `reviewerFromRole`, which gains the `"reviewer-fix"` case
- `src/review/types.ts` — hand-written `ReviewConfig` and its key-drift guard
- `src/runtime/session-role.ts` — `CanonicalSessionRole` and `KNOWN_SESSION_ROLES`
- `src/execution/story-orchestrator/review-decision.ts` — `toReviewDecisionPayload` / `emitReviewDecision`

**US-002**
- `src/utils/git-env.ts` — `gitSpawnEnv` overlay and `hardenedGitArgv`
- `src/execution/non-blocking-fix.ts` — `createMeasureSourceDiff`, the git spawn and classifier pattern
- `src/tdd/isolation.ts` — `getChangedFiles`, a working-tree diff precedent
- `src/prd/types.ts` — `getContextFiles`, `getExpectedFiles`, `ModifiedFileEntry`
- `src/findings/types.ts` — `Finding.file` frame

**US-003**
- `src/operations/semantic-review.ts` — review op shape, `reviewConfigSelector`, JSON parsing
- `src/operations/finish-narrative.ts` — minimal fresh run op
- `src/prompts/builders/review-builder.ts` — review prompt builder conventions
- `src/prompts/sections/out-of-scope.ts` — `buildReviewOutOfScopeBlock`
- `src/review/diff-utils.ts` — `truncateDiff`

**US-004**
- `src/execution/non-blocking-fix.ts` — `runNonBlockingFix`, `NonBlockingFixDeps`, `restoreToSnapshot`
- `src/execution/story-orchestrator/execution-plan.ts` — the `runNonBlockingFix` call site
- `src/tdd/rollback.ts` — `captureSnapshotRef` / `SnapshotRef`
- `test/unit/execution/non-blocking-fix.test.ts` — keep/restore test patterns

**US-005**
- `src/findings/cycle-types.ts` — `FixStrategy`, `FixCycleContext`
- `src/findings/cycle-dispatch.ts` — `dispatchStrategy`
- `src/execution/build-plan-for-strategy.ts` — blocking-cycle strategies and `postValidate`
- `src/execution/story-orchestrator/no-progress-bail.ts` — `withNoProgressBail`, the strategy-wrapper precedent
- `src/operations/_finding-to-check.ts` — `findingsToFailedChecks` source mapping

### Creates

**US-001**
- `src/review/fix-review/types.ts` — `FixReviewVerdict`, `FixReviewOpOutput`, `FixReviewRequest`
- `src/review/fix-review/config.ts` — `resolveFixReviewModel`

**US-002**
- `src/review/fix-review/tree-snapshot.ts` — `snapshotWorkingTree`, `changedPathsBetween`, `diffBetween`
- `src/review/fix-review/scope.ts` — `checkFixScope`

**US-003**
- `src/operations/fix-review.ts` — `fixReviewOp`
- `src/prompts/builders/fix-review-builder.ts` — `buildFixReviewPrompt`
- `src/review/fix-review/run.ts` — `runFixReview`, `FixReviewDeps`

**US-004**
- `src/execution/story-orchestrator/nbf-deps.ts` — `buildNbfDeps`

**US-005**
- `src/execution/story-orchestrator/fix-review-strategy.ts` — `createFixReviewWrapper`, `toFixReviewFinding`

### Modifies

None. No existing test pins a closed-world shape this feature changes. The session-role tests
assert membership with `toContain` and a known-role `test.each`, never the exact list, so a new role
breaks none of them. The NBF wiring test asserts only that the overrides carry a `measureSourceDiff`
function, so an added `reviewFix` field breaks nothing. Every new config key is defaulted, and the
review config tests compare against `DEFAULT_CONFIG`, which updates itself. The e2e orchestrator
harness records only op names in its fixed `PHASE_NAMES` set into `phaseLog` and routes any other op,
including `fix-review`, into `strategiesFired`, which the e2e tests check only with `toContain`, so
their exact `phaseLog` counts and lists are unaffected.

### Seams

- US-004 AC11: `ExecutionPlan.run` → `runFixReview` through `buildNbfDeps`, on a green story with NBF enabled.
- US-005 AC15: `ExecutionPlan.run` → `runFixReview` through the wrapped blocking-cycle `autofix-test-writer`.

## Acceptance Criteria

### US-001

1. [unit] Parsing `{}` with `NaxConfigSchema` yields `review.fixReview.enabled === true`.
2. [unit] Parsing `{}` with `NaxConfigSchema` yields `review.fixReview.timeoutMs === 600000`.
3. [unit] Parsing `{}` with `NaxConfigSchema` yields `review.fixReview.model === undefined`.
4. [unit] `NaxConfigSchema` rejects `{ review: { fixReview: { timeoutMs: 0 } } }` with a validation error on the path `review.fixReview.timeoutMs`.
5. [unit] `resolveFixReviewModel(review)` returns `review.fixReview.model` when it is set, even when `review.semantic.model` is set to a different value.
6. [unit] `resolveFixReviewModel(review)` returns `review.semantic.model` when `review.fixReview.model` is unset and `review.semantic.model` is set.
7. [unit] `resolveFixReviewModel(review)` returns `"balanced"` when neither `review.fixReview.model` nor `review.semantic` is set.
8. [unit] The precheck model-resolution walk in `src/precheck/checks-model-resolution-walk.ts` includes a `review.fixReview.model` site when `review.fixReview.model` is set.
9. [unit] The precheck model-resolution walk includes no `review.fixReview.model` site when `review.fixReview.model` is unset.
10. [unit] `KNOWN_SESSION_ROLES` contains `"reviewer-fix"`.
11. [unit] `emitReviewDecision(ctx, "fix-review", { parsed: true, passed: true, reason: "ok" })` emits one review-decision event whose `reviewer` is `"fix"` and whose `result` is `{ passed: true, findings: [] }`.
12. [unit] `emitReviewDecision(ctx, "fix-review", { parsed: true, passed: false, reason: "adds mkdir", acIndex: 4, file: "src/a.ts" })` emits a review-decision event whose `result.findings` has exactly one entry with `message` `"adds mkdir"`, `acIndex` `4` and `file` `"src/a.ts"`.
13. [unit] `emitReviewDecision(ctx, "fix-review", { parsed: false, unparsedPreview: "garbage" })` emits a review-decision event with `parsed: false`, `result: null` and `unparsedPreview` `"garbage"`.
14. [integration] Given a review-decision event with `reviewer: "fix"`, the review-audit subscriber writes one JSON record under `review-audit/<feature>/` whose `reviewer` field is `"fix"`.
15. [unit] The review-audit middleware's `reviewerFromRole` returns `"fix"` for session role `"reviewer-fix"`.

### US-002

1. [integration] In a clean temporary git repo, `snapshotWorkingTree(workdir)` returns the same tree id as the tree of `HEAD`.
2. [integration] After an uncommitted edit to tracked file `src/a.ts`, `changedPathsBetween(workdir, "HEAD", await snapshotWorkingTree(workdir))` returns `["src/a.ts"]`.
3. [integration] After creating the untracked, non-ignored file `src/new.ts`, `changedPathsBetween(workdir, "HEAD", await snapshotWorkingTree(workdir))` includes `"src/new.ts"`.
4. [integration] A new file matched by `.gitignore` is absent from `changedPathsBetween(workdir, "HEAD", await snapshotWorkingTree(workdir))`.
5. [integration] An untracked file that existed before both snapshots is absent from `changedPathsBetween(workdir, before, after)` when only a tracked file changed between the two `snapshotWorkingTree` calls.
6. [integration] `snapshotWorkingTree(workdir)` leaves the repository's staged paths and the working-tree status identical before and after the call, including when tracked and untracked changes are present.
7. [integration] When `workdir` is the package subdirectory `packages/a` of the repo, `changedPathsBetween` returns `"packages/a/src/x.ts"` for a change to `packages/a/src/x.ts`.
8. [integration] `changedPathsBetween(workdir, "no-such-ref", "HEAD")` rejects with a `NaxError` whose code is `FIX_REVIEW_GIT_FAILED`.
9. [integration] `snapshotWorkingTree` on a directory that is not inside a git repository rejects with a `NaxError` whose code is `FIX_REVIEW_GIT_FAILED`.
10. [integration] `diffBetween(workdir, from, to)` returns unified diff text containing the changed line of `src/a.ts` and no hunk for a file changed under `.nax/`.
11. [unit] `checkFixScope` returns `inScope: true` with empty `outOfScopeFiles` when every changed non-test file is in `storyFiles`.
12. [unit] `checkFixScope` treats a changed file listed only in `story.contextFiles` as in scope.
13. [unit] `checkFixScope` treats a changed file listed only in `story.expectedFiles` as in scope.
14. [unit] `checkFixScope` treats a changed file listed only as a `story.modifiedFiles` entry's `path` as in scope.
15. [unit] With `packageDirRel` `"packages/a"`, `checkFixScope` treats changed file `"packages/a/src/lock.ts"` as in scope when a seeding finding has `file` `"src/lock.ts"`.
16. [unit] `checkFixScope` treats a changed file for which `isTestFile` returns `true` as in scope even when it is in no allowed set.
17. [unit] `checkFixScope` ignores a changed path under `.nax/`.
18. [unit] `checkFixScope` returns `inScope: false` with `outOfScopeFiles` `["src/utils/path-file-lock.ts"]` when that non-test file changed and is in no allowed set.
19. [unit] `checkFixScope` returns `inScope: true` and `skipped: true` when `storyFiles` is `undefined`.

### US-003

1. [unit] `buildFixReviewPrompt` output contains each of the story's acceptance criteria prefixed with its 1-based index.
2. [unit] `buildFixReviewPrompt` output contains each `story.outOfScope` entry when `outOfScope` is non-empty.
3. [unit] `buildFixReviewPrompt` output contains the story's `description` text.
4. [unit] `buildFixReviewPrompt` output contains the `diff` text of its input.
5. [unit] `buildFixReviewPrompt` output contains the `message` of every seeding finding.
6. [unit] `fixReviewOp.parse` on `{"passed":false,"reason":"r","acIndex":4,"file":"src/a.ts"}` returns `{ parsed: true, passed: false, reason: "r", acIndex: 4, file: "src/a.ts" }`.
7. [unit] `fixReviewOp.parse` on a response containing no JSON object returns `parsed: false` with a non-empty `unparsedPreview`.
8. [unit] `fixReviewOp.session` is `{ role: "reviewer-fix", lifetime: "fresh" }`.
9. [unit] `fixReviewOp.model(input, ctx)` returns `resolveFixReviewModel(ctx.config.review)`.
10. [unit] `runFixReview` with `config.fixReview.enabled` `false` returns `{ kind: "pass", reviewed: false }` without calling `snapshotWorkingTree` or `callOp`.
11. [unit] `runFixReview` returns `{ kind: "pass", reviewed: false }` without calling `callOp` when `changedPathsBetween(workdir, preFixTree, postTree)` returns `[]`.
12. [unit] `runFixReview` returns `{ kind: "fail", cause: "scope" }` whose `files` lists the out-of-scope file, without calling `callOp`, when `checkFixScope` reports a violation.
13. [unit] `runFixReview` calls `callOp` once with `fixReviewOp` and returns `{ kind: "pass", reviewed: true }` when the op output is `{ parsed: true, passed: true }`.
14. [unit] `runFixReview` returns `{ kind: "fail", cause: "contradiction", acIndex: 4, file: "src/a.ts" }` with the op's `reason` when the op output is `{ parsed: true, passed: false, acIndex: 4, file: "src/a.ts" }`.
15. [unit] `runFixReview` returns `kind: "error"` when `callOp` throws.
16. [unit] `runFixReview` returns `kind: "error"` when the op output is `{ parsed: false }`.
17. [unit] `runFixReview` returns `kind: "error"` without calling `callOp` when `snapshotWorkingTree` rejects with `FIX_REVIEW_GIT_FAILED`.
18. [unit] `runFixReview` calls `emitReviewDecision` exactly once with op name `"fix-review"` when `callOp` returns an output, whether or not it parsed.
19. [unit] `runFixReview` passes the story-files argument `undefined` to `checkFixScope`, and still calls `callOp`, when `story.storyGitRef` is absent.
20. [unit] `runFixReview` passes `fixReviewOp` a `diff` equal to `truncateDiff` of the `diffBetween(workdir, preFixTree, postTree)` result.

### US-004

1. [unit] `runNonBlockingFix` with a `reviewFix` dep resolving `{ kind: "pass" }` returns `{ ran: true, kept: true, restored: false }` and never calls `rollbackToRef`.
2. [unit] `runNonBlockingFix` with a `reviewFix` dep resolving `{ kind: "fail", cause: "scope" }` returns `{ kept: false, restored: true }`.
3. [unit] `runNonBlockingFix` calls `rollbackToRef` with the snapshot's `sha` when `reviewFix` resolves `{ kind: "fail", cause: "contradiction" }`.
4. [unit] `runNonBlockingFix` returns `restored: true` when `reviewFix` resolves `{ kind: "error" }`.
5. [unit] `runNonBlockingFix` calls `reviewFix` exactly once, with the `sha` returned by `captureSnapshotRef`, on a pass that clears `sourceDiffCap`.
6. [unit] `runNonBlockingFix` does not call `reviewFix` when the `sourceDiffCap` check already restored the pass.
7. [unit] `runNonBlockingFix` does not call `reviewFix` when `runRectify` reports `rectificationExhausted: true`.
8. [unit] `runNonBlockingFix` with no `reviewFix` dep keeps a pass that clears `sourceDiffCap`, returning `kept: true`.
9. [unit] When `reviewFix` resolves a non-pass verdict, `runNonBlockingFix` logs `"fix review rejected the pass — restoring"` at info level with the verdict's `kind` in the log data.
10. [unit] `buildNbfDeps({ ctx, findings })` returns no `reviewFix` when `ctx.story` is undefined.
11. [integration] With `runFixReview` stubbed and `review.nonBlockingFix.enabled` `true`, running `ExecutionPlan.run` on a story that is green with adversarial advisory findings invokes `runFixReview` once, with `preFixTree` equal to the NBF snapshot `sha` and `findings` equal to the NBF seed findings.
12. [integration] With the agent stubbed to answer the fix review with `{"passed":true,"reason":"ok"}`, an `ExecutionPlan.run` whose NBF pass is kept emits exactly one review-decision event with `reviewer: "fix"`.

### US-005

1. [unit] `dispatchStrategy` awaits the strategy's `beforeDispatch` before it calls `callOp`.
2. [unit] `dispatchStrategy` calls `callOp` once, exactly as before, for a strategy without `beforeDispatch`.
3. [unit] `toFixReviewFinding` of a `contradiction` fail with `acIndex: 3` returns a finding with `rule` `"fix-review:AC-3"`.
4. [unit] `toFixReviewFinding` of a `contradiction` fail with `file: "test/a.test.ts"` returns a finding with `file` `"test/a.test.ts"`.
5. [unit] `toFixReviewFinding` returns a finding with `source` `"semantic-review"`.
6. [unit] `toFixReviewFinding` returns a finding with `fixTarget` `"test"`.
7. [unit] `findingsToFailedChecks` of one `toFixReviewFinding` result returns one check whose `check` is `"semantic"`.
8. [unit] After the wrapped strategy's dispatch gets a `contradiction` verdict with `acIndex: 2` from `runFixReview`, `drainFindings()` returns exactly one finding, and a second `drainFindings()` call returns `[]`.
9. [unit] After the wrapped strategy's dispatch gets a `scope` fail verdict, `drainFindings()` returns `[]` and the warning `"fix review non-pass not fed back"` is logged.
10. [unit] After the wrapped strategy's dispatch gets a `contradiction` verdict with no `acIndex`, `drainFindings()` returns `[]` and the warning `"fix review non-pass not fed back"` is logged.
11. [unit] After the wrapped strategy's dispatch gets a `pass` verdict, `drainFindings()` returns `[]`.
12. [unit] After the wrapped strategy's dispatch gets an `error` verdict, `drainFindings()` returns `[]` and a warning is logged.
13. [unit] When `snapshotWorkingTree` rejects inside the wrapped strategy's `beforeDispatch`, the wrapped `extractApplied` does not call `runFixReview`.
14. [unit] The wrapped strategy calls `runFixReview` with the same findings its `buildInput` received.
15. [integration] With `runFixReview` stubbed to return `{ kind: "fail", cause: "contradiction", acIndex: 2, reason: "drops the AC-2 assertion" }`, running `ExecutionPlan.run` on a story whose adversarial review yields a finding with `fixTarget: "test"` dispatches `autofix-test-writer` a second time with `"drops the AC-2 assertion"` among its input findings.
16. [integration] With `review.nonBlockingFix.enabled` `true` and `scope` `"both"`, a green story's NBF pass that dispatches `autofix-test-writer` calls `runFixReview` exactly once: at the NBF keep gate, not after the dispatch.
