# Delete Dead LLM Reviewer Cluster (#1859) + Review-Stage Debate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the unreachable `runReview` LLM reviewer cluster (~1,780 src lines + ~9,200 test lines) and the review-stage debate surface it was the only consumer of.

**Architecture:** Pure deletion with two small behavioral seams: (1) `runReview` no longer dispatches `semantic`/`adversarial` — those check names fall through `resolveCommand` → `null` → skipped, matching today's effective `skipped: no git ref` outcome; (2) `debate.stages.review` is removed from the config schema — Zod's default unknown-key stripping keeps existing user configs parsing. Debate internals (personas, runners, plan/decompose stages) are untouched. `finding-projection.ts` is kept pending the #1861 ruling.

**Tech Stack:** TypeScript, Bun, Zod. Repo: `~/workspace/subrina-coder/projects/nax/repos/nax`.

**Spec:** https://github.com/nathapp-io/nax/issues/1859 (options analysis) + ruling comment https://github.com/nathapp-io/nax/issues/1859#issuecomment-5549769625 (option 1 + riders). Related: https://github.com/nathapp-io/nax/issues/1861 (partially resolved via its option 3).

## Global Constraints

- All work in `~/workspace/subrina-coder/projects/nax/repos/nax`, branched off `main` (`8679d9e81` or later). Branch directly in the tree — **no worktrees** (user ruling).
- Branch name: `chore/1859-delete-dead-llm-reviewer-cluster` — **already created and checked out** (2026-09-05); do not re-branch, just verify with `git branch --show-current` before the first commit.
- **This plan file lives at `docs/superpowers/plans/` INSIDE the public nax repo but must NEVER be committed** — it contains private workspace context. `docs/superpowers/` is already in `.git/info/exclude` (machine-local), so `git add -A` cannot stage it; do not remove that exclude entry, do not `git add -f` this path, and verify in Task 5 Step 3 that no `docs/superpowers/` path appears in `git diff main...HEAD --stat`.
- Full test suite is **`bun run test`** — NEVER bare `bun test` (user ruling; bare bun test misbehaves in this repo).
- Lint: `bun run lint`. Typecheck is part of the repo gate suite run by `bun run test`.
- Conventional commits (`chore:`, `test:`, `fix:`).
- **DO NOT** delete or edit: `src/review/prepare-inputs.ts`, `adversarial-helpers.ts`, `semantic-helpers.ts`, `finding-filters.ts`, `recurrence-demotion.ts`, `requote-response.ts`, `acks.ts`, `ac-quote-validator.ts`, `severity.ts`, `types.ts`, `diff-utils.ts`, `review-audit.ts` — all are live-path (imported by `src/operations/{adversarial,semantic}-review.ts` or prompt builders). Comment-only tidying is allowed where a later task says so.
- **DO NOT** remove `"semantic"` / `"adversarial"` from the `checks` enum in `src/config/schemas-review.ts:205` — the live op path gates on `config.review.checks.includes(...)` (`src/execution/plan-inputs.ts:329,391`).
- **DO NOT** touch the `"plan" | "review"` persona-stage branches inside `src/debate/` (`runner.ts:122`, `runner-hybrid.ts:53`, `runner-stateful.ts:35`, `session-helpers.ts:90`, `personas/index.ts:68`): non-plan debate stages (e.g. decompose) map onto the "review" persona set. `DebateRunner.stage` is typed `string`, so nothing breaks.
- The repo has a file-size gate and test ratchets. This change only shrinks files; if a ratchet or dead-export gate fires, update its baseline in the same commit and say so in the commit body.

---

### Task 1: Remove the LLM dispatch from `runReview`

Cluster files still exist after this task; they just become fully orphaned (only the barrel re-export remains, removed in Task 2).

**Files:**
- Modify: `src/review/runner/index.ts` (currently 544 lines)
- Test: `test/unit/review/runner.test.ts` (currently 592 lines)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `runReview(opts: RunReviewOptions): Promise<ReviewResult>` with `RunReviewOptions` no longer carrying `storyGitRef`, `story`, `agentManager`, `contextBundles`. Task 2 relies on runner/index.ts no longer importing from `../adversarial` / `../semantic`.

- [ ] **Step 1: Write the failing behavior test**

In `test/unit/review/runner.test.ts`, replace the entire `describe("runReview — semantic check integration (AC-9)", ...)` block (lines 363–497 on main; it starts at the comment `// AC-9: runReview() calls runSemanticReview() for the 'semantic' check` and ends just before `describe("getUncommittedFilesImpl — BUG-1 pipe-drain regression"`) with:

```typescript
// #1859: semantic/adversarial are op-path checks (story-orchestrator/run-phase → callOp).
// runReview (reconciliation) must not dispatch them — they fall through resolveCommand
// as command-less checks and are skipped.
describe("runReview — LLM check names are skipped, not dispatched (#1859)", () => {
  let originalGetUncommittedFiles: typeof _deps.getUncommittedFiles;
  let originalSpawn: typeof _runnerDeps.spawn;

  beforeEach(() => {
    originalGetUncommittedFiles = _deps.getUncommittedFiles;
    originalSpawn = _runnerDeps.spawn;
  });

  afterEach(() => {
    mock.restore();
    _deps.getUncommittedFiles = originalGetUncommittedFiles;
    _runnerDeps.spawn = originalSpawn;
  });

  test("semantic and adversarial in config.checks produce no check results and succeed", async () => {
    _deps.getUncommittedFiles = mock(async () => []); // RQ-001 guard must not hit real git
    let spawnCalled = false;
    _runnerDeps.spawn = makeSpawn(() => {
      spawnCalled = true;
      return "";
    }).spawn;

    const config: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: ["semantic", "adversarial"],
      commands: {},
    });

    const result = await runReview({ config, workdir: "/tmp/fake-workdir" });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(spawnCalled).toBe(false);
  });
});
```

(`_deps`, `_runnerDeps`, `makeConfigSlice`, `makeSpawn`, `mock` are already imported at the top of this file — lines 9–20 — for the existing describe blocks; this mirrors the setup of the AC-9 block being replaced.) Also delete the now-unused import of `_reviewSemanticDeps as _semanticDeps` (line 16) and any imports used only by the deleted block.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test test/unit/review/runner.test.ts` (if the repo's test script doesn't accept a path filter, use the repo's documented single-file invocation; check `package.json` scripts — do NOT use bare `bun test` for the full suite, single-file is acceptable if that is the established repo pattern, e.g. `bun test test/unit/review/runner.test.ts` for one file only).

Expected: FAIL — on main, `runReview` dispatches `runSemanticCheck`, which returns a `skipped: no git ref` result that IS pushed into `checks`, so `result.checks` has length 2, not 0.

- [ ] **Step 3: Remove the dispatch and wrappers from `src/review/runner/index.ts`**

Delete, by symbol (line numbers are main anchors, re-locate by name):

1. Imports of `runAdversarialReview as _runAdversarialReviewImpl` (line 18), `SemanticStory` type (line 21), `runSemanticReview as _runSemanticReviewImpl` (line 22), and the `IAgentManager` import if it is now unused.
2. `RunReviewOptions` fields `storyGitRef?` (line 35), `story?` (line 36), `agentManager?` (line 37), and the `contextBundles?` field (lines 44–48). Keep `runtime` (used by `guardUncommittedFiles`), `storyId`, `retrySkipChecks`, `naxIgnoreIndex`.
3. `_reviewSemanticDeps` (line 61) and `_reviewAdversarialDeps` (line 71) injectable-deps objects and their doc comments.
4. `buildReviewStory` (line 322) and its doc comment.
5. `runSemanticCheck` (line 332) and `runAdversarialCheck` (line 374), whole functions including doc comments, plus the `SemanticReviewConfigSchema` / `AdversarialReviewConfigSchema` imports if now unused.
6. The dispatch branch inside `runReview` (lines 494–506):

```typescript
    if (checkName === "semantic" || checkName === "adversarial") {
      const result = checkName === "semantic" ? await runSemanticCheck(opts) : await runAdversarialCheck(opts);
      checks.push(result);
      if (!result.success && !firstFailure) {
        firstFailure = `${checkName} failed`;
      }
      if (!result.success) {
        break;
      }
      continue;
    }
```

KEEP the early return in `resolveCommand` (lines 136–139) — it is what makes `semantic`/`adversarial` fall through as command-less (skipped) checks:

```typescript
  // Semantic and adversarial checks are LLM-based — run by the story orchestrator via
  // callOp (operations/{semantic,adversarial}-review.ts), never by runReview (#1859).
  if (check === "semantic" || check === "adversarial") {
    return null;
  }
```

(Update that comment to the wording above.) Also update the stale comment at line ~511 ("Semantic and adversarial checks log their own outcomes internally") to just describe mechanical-check logging.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/review/runner.test.ts test/unit/review/runner-language-fallback.test.ts`
Expected: PASS (new skip test green, all mechanical-check tests untouched and green).

- [ ] **Step 5: Verify no other compile breakage from the options-shape change**

Run: `grep -rn "storyGitRef\|agentManager\|contextBundles" src/execution/lifecycle/run-initialization.ts test/integration/review/review.test.ts test/integration/review/review-config-commands.test.ts`
Expected: no hits constructing `runReview` options with the removed fields (the only production caller at `run-initialization.ts:37` passes `{ config, workdir, executionConfig }`). If an integration test passes a removed field, delete just that field from the test.

- [ ] **Step 6: Commit**

```bash
git add src/review/runner/index.ts test/unit/review/runner.test.ts
git commit -m "chore(review): stop dispatching semantic/adversarial from runReview (#1859)

Reconciliation's runReview passed no runtime/story/storyGitRef, so both LLM
branches always returned 'skipped: no git ref'. The live reviewers are the
ops (story-orchestrator/run-phase -> callOp). The check names now fall
through resolveCommand as command-less checks and are skipped."
```

---

### Task 2: Delete the five cluster files and their test surface

**Files:**
- Delete: `src/review/adversarial.ts`, `src/review/adversarial-outcomes.ts`, `src/review/semantic.ts`, `src/review/semantic-outcomes.ts`, `src/review/semantic-debate.ts`
- Modify: `src/review/index.ts` (remove one line)
- Delete (tests): the 20 unit files + 1 integration file listed in Step 2
- Test: full unit tree compiles and passes

**Interfaces:**
- Consumes: Task 1 (runner no longer imports the cluster).
- Produces: `src/review/` containing only live-path modules. Task 3 relies on `semantic-debate.ts` being gone (it was the only `debate.stages.review` consumer).

- [ ] **Step 1: Verify the cluster is fully orphaned**

Run: `grep -rn "review/adversarial\"\|review/semantic\"\|review/adversarial-outcomes\|review/semantic-outcomes\|review/semantic-debate\|from \"./adversarial\"\|from \"./semantic\"\|from \"./adversarial-outcomes\"\|from \"./semantic-outcomes\"\|from \"./semantic-debate\"" src/ --include="*.ts"`
Expected: exactly one code hit — `src/review/index.ts:11: export * from "./adversarial";` (plus comment-only hits, which Task 4 tidies). If any other *import* appears, STOP and report — the blast-radius assumption is violated.

- [ ] **Step 2: Delete files**

```bash
git rm src/review/adversarial.ts src/review/adversarial-outcomes.ts \
  src/review/semantic.ts src/review/semantic-outcomes.ts src/review/semantic-debate.ts
git rm test/unit/review/adversarial-audit-shape.test.ts \
  test/unit/review/adversarial-metadata-audit.test.ts \
  test/unit/review/adversarial-pass-fail.test.ts \
  test/unit/review/adversarial-reprompt-telemetry.test.ts \
  test/unit/review/adversarial-retry.test.ts \
  test/unit/review/adversarial-threshold.test.ts \
  test/unit/review/adversarial-verifiedby.test.ts \
  test/unit/review/orchestrator-wrapper-parity.test.ts \
  test/unit/review/semantic-agent-session.test.ts \
  test/unit/review/semantic-audit-shape.test.ts \
  test/unit/review/semantic-debate-audit-shape.test.ts \
  test/unit/review/semantic-debate.test.ts \
  test/unit/review/semantic-findings.test.ts \
  test/unit/review/semantic-parsing.test.ts \
  test/unit/review/semantic-prompt-response.test.ts \
  test/unit/review/semantic-retry-truncation.test.ts \
  test/unit/review/semantic-retry.test.ts \
  test/unit/review/semantic-signature-diff.test.ts \
  test/unit/review/semantic-threshold.test.ts \
  test/unit/review/semantic-unverifiable.test.ts
```

Note: `semantic-audit-shape.test.ts` is #1861's phantom gate — its deletion is deliberate and referenced in the PR body.

- [ ] **Step 3: Inspect and delete the integration test**

Read `test/integration/review/adversarial-reprompt-telemetry.test.ts` (285 lines). It imports `runAdversarialReview` from `@/review/adversarial` (line 12) — the dead entry point. Confirm every test in the file drives `runAdversarialReview` (not `adversarialReviewOp` directly). Expected: yes — then `git rm` it. Live reprompt/requote coverage is `test/unit/operations/adversarial-review-requote.test.ts` and the reprompt-marker tests; name them in the commit body. If any test in the file drives the op directly, extract that test into `test/unit/operations/` instead of deleting it, then delete the file.

- [ ] **Step 4: Remove the barrel line**

In `src/review/index.ts` delete line 11 `export * from "./adversarial";` and the comment block above it that explains the adversarial re-export. Also update the barrel's stale comment about `./runner` pulling in `./semantic` (lines ~25–33): the cycle rationale is gone; shrink the comment to "`./runner` is NOT re-exported here (deliberately). Import `runReview` from `@/review/runner`."

- [ ] **Step 5: Compile-and-fix sweep**

Run: `bun run lint` and the repo typecheck (`bun run test` runs it; a faster `tsc --noEmit` equivalent from package.json scripts is fine here).
Expected failures to fix mechanically:
- Any test helper importing deleted symbols. Known candidates: `test/helpers/debate-runner.ts` (its header names `semantic-debate.test.ts`) and `test/helpers/review-audit.ts` (its header names `semantic-debate-audit-shape` tests). For each: `grep -rln "helpers/debate-runner\|helpers/review-audit" test/ --include="*.test.ts"` — if no surviving importer, `git rm` the helper; if a survivor imports it, keep it and only remove dead exports.
- `MAX_ACKS`, `extractAcks`, `filterByAcGroundingMinimal`, `isBlockingSeverity` etc. must still export from `@/review` (they are live) — if the compiler says otherwise, you deleted too much from the barrel; restore.

- [ ] **Step 6: Run the review test tree**

Run: `bun test test/unit/review/ test/unit/operations/`
Expected: PASS. The surviving `test/unit/review/` files (`ac-quote-validator`, `acks`, `recurrence-demotion`, `requote-response`, `finding-projection`, `runner*`, `adversarial-fixtarget`, `semantic-categories`, plus helpers' tests) and the 13 live op review suites all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(review): delete unreachable runReview LLM reviewer cluster (#1859)

Removes src/review/{adversarial,adversarial-outcomes,semantic,
semantic-outcomes,semantic-debate}.ts (1,781 lines) and the ~21 test files
that exercised the dead entry points, including semantic-audit-shape.test.ts
(#1861's phantom gate). Live reviewer coverage is the operations suites
(test/unit/operations/*review*) and the direct helper tests."
```

---

### Task 3: Remove the review-stage debate surface

`semantic-debate.ts` (deleted in Task 2) was the only consumer of `debate.stages.review` and the `review-grounding-filter` verifier. Remove both from the config/type surface so the knob doesn't dangle.

**Files:**
- Modify: `src/config/schemas-debate.ts` (stages object ~lines 133–176; verifier enum line 117)
- Modify: `src/debate/types.ts` (stages interface ~line 117; verifier kind union line 95)
- Modify: `src/cli/config-descriptions.ts` (remove the `"debate.stages.review"` entry at line 272)
- Delete: `src/debate/verifiers/review-grounding-filter.ts`
- Modify: `src/debate/verifiers/registry.ts` (lines 7, 25), `src/debate/verifiers/index.ts` (line 11), `src/debate/index.ts` (line 72)
- Delete: `test/unit/debate/verifiers/review-grounding-filter.test.ts`
- Modify: `test/unit/debate/runner-plug-point-dispatch.test.ts` (remove one test), `test/unit/config/debate-schema.test.ts`

**Interfaces:**
- Consumes: Task 2 (semantic-debate.ts gone).
- Produces: `DebateConfig["stages"]` = `{ plan, acceptance, rectification, escalation, decompose? }`; `postDebateVerifier.kind` = `"plan-checklist" | "custom"`. Task 5's PR body documents the config back-compat behavior.

- [ ] **Step 1: Write the failing back-compat tests**

The repo's convention for a config key that existed but never did anything is `stripRemovedNoOpKeys` (`src/config/config-guards.ts:185`, `REMOVED_NO_OP_KEYS`): warn once per resolved config, then strip — not silent Zod stripping. `debate.stages.review` fits it exactly (the key was inert: its only consumer was the unreachable path).

In `test/unit/config/debate-schema.test.ts` — note this file drives `NaxConfigSchema.safeParse(baseConfig)`, NOT `DebateConfigSchema` directly; mirror its existing `baseConfig` construction — add:

```typescript
// #1859: review-stage debate removed with the unreachable runReview LLM cluster.
// Legacy configs may still carry debate.stages.review — it must parse (Zod
// strips the unknown key) and must not survive into the resolved config.
test("a config carrying legacy debate.stages.review still parses and the key is stripped", () => {
  const result = NaxConfigSchema.safeParse({
    ...baseConfig,
    debate: {
      enabled: true,
      stages: {
        review: { enabled: true, rounds: 2 },
      },
    },
  });

  expect(result.success).toBe(true);
  expect(result.data?.debate?.stages).not.toHaveProperty("review");
  // untouched stages keep their defaults
  expect(result.data?.debate?.stages.plan).toBeDefined();
});
```

Also update the existing assertion at line ~99 (`result.data.debate?.stages.review`) — repoint it at a surviving stage (`acceptance` has the same `NonPlanStageExtensions` shape) or fold it into the new test.

In `test/unit/config/strip-removed-noop-keys.test.ts`, add a case following the file's existing per-key pattern (it writes a project config via `writeProjectConfig` and asserts one warning + stripped key):

```typescript
test("debate.stages.review is stripped with a warning (#1859)", async () => {
  const warnings: string[] = [];
  const stripped = stripRemovedNoOpKeys(
    { debate: { enabled: true, stages: { review: { enabled: true } } } },
    (msg) => warnings.push(msg),
  );

  expect((stripped.debate as { stages: Record<string, unknown> }).stages).not.toHaveProperty("review");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("debate.stages.review");
});
```

(Adapt the assertion style to the file's existing tests — read them first; if `stripRemovedNoOpKeys` only strips top-level dotted paths that its walker supports, confirm a nested `debate.stages.review` path works; if the walker can't reach three levels deep, extend `REMOVED_NO_OP_KEYS` handling is out — instead keep only the Zod-strip test above and note the deviation in the commit body.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config/debate-schema.test.ts test/unit/config/strip-removed-noop-keys.test.ts`
Expected: FAIL — on the current schema, `stages.review` is a defined key so it survives parsing, and `REMOVED_NO_OP_KEYS` has no `debate.stages.review` entry.

- [ ] **Step 3: Remove the schema and type entries**

1. `src/config/schemas-debate.ts`: delete the `review: makeDebateStageSchema({ enabled: true, resolverType: "majority-fail-closed", sessionMode: "one-shot", rounds: 2 }, NonPlanStageExtensions),` entry (~lines 140–148); change the verifier enum at line 117 from `z.enum(["plan-checklist", "review-grounding-filter", "custom"])` to `z.enum(["plan-checklist", "custom"])`.
2. `src/debate/types.ts`: delete `review: DebateStageConfig;` (with its `/** Review phase debate */` comment) from `DebateConfig["stages"]` (~line 117); change the `postDebateVerifier.kind` union at line 95 to `"plan-checklist" | "custom"`.
3. `src/cli/config-descriptions.ts`: delete the whole `"debate.stages.review": ...` entry (line 272).
4. `src/config/config-guards.ts`: add to `REMOVED_NO_OP_KEYS` (line 185), if the guard's key walker supports the nested path (see Step 1's caveat):

```typescript
  "debate.stages.review":
    "this key had no effect — review-stage debate was only reachable from the deleted runReview LLM path (#1859); the live reviewers are the semantic/adversarial review ops",
```

Known accepted risk (document in the PR body, do not code around it): a config explicitly setting `postDebateVerifier: { kind: "review-grounding-filter" }` on a *surviving* stage would now hard-fail Zod parsing with a clear enum error naming the path. The verifier only ever made sense for review-stage debate, which never ran, so this is theoretical.

- [ ] **Step 4: Delete the verifier and its registrations**

```bash
git rm src/debate/verifiers/review-grounding-filter.ts test/unit/debate/verifiers/review-grounding-filter.test.ts
```

Then remove: the import at `src/debate/verifiers/registry.ts:7` and the `registerPostDebateVerifier("review-grounding-filter", ...)` call at line 25; the export at `src/debate/verifiers/index.ts:11`; the `reviewGroundingFilterVerifier` re-export at `src/debate/index.ts:72`. Tidy the two comments that name it: `src/debate/verifiers/types.ts:16` and `src/debate/selectors/types.ts:30`.

In `test/unit/debate/runner-plug-point-dispatch.test.ts`, delete only the test `"review-grounding-filter does not turn a failed selector with no findings into pass"` (lines ~259–281). Leave the other tests — `DebateRunner.stage` is `string`, so their `stage: "review"` literals still compile; change those literals to `"acceptance"` anyway so the file stops naming a removed stage.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/config/debate-schema.test.ts test/unit/debate/`
Expected: PASS, including the new back-compat test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(debate): remove review-stage debate surface (#1859)

debate.stages.review and the review-grounding-filter verifier were consumed
only by the deleted semantic-debate path and have been inert in production.
Legacy configs carrying debate.stages.review still parse (Zod strips the
key); a back-compat test pins that."
```

---

### Task 4: Orphan sweep and stale-comment tidy

**Files:**
- Modify: `src/review/finding-projection.ts`, `src/review/prepare-inputs.ts`, `src/review/semantic-helpers.ts`, `src/prompts/builders/review-builder.ts`, `src/execution/plan-inputs.ts`, `src/context/engine/stage-config.ts`, `test/helpers/runtime.ts`
- Possibly delete: parts of `test/unit/review/finding-projection.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 complete.
- Produces: no src comment references a deleted module; `findingToReviewFinding` survives with a #1861 pointer.

- [ ] **Step 1: Trim `finding-projection.ts` to the parts #1861 needs**

`llmFindingsToReviewFindings` (line 142) has zero callers after Task 2 (verify: `grep -rn "llmFindingsToReviewFindings" src/`). Delete that function, the `AnyLLMFinding` type alias, and any now-unused imports (`AdversarialLLMFinding`, `LLMFinding`) — it projected the dead path's LLMFinding shape and is NOT #1861 option 1's candidate. KEEP `findingToReviewFinding` and `findingsToReviewFindings` (line 155–176) even though they may be caller-less, with this comment above them:

```typescript
// Kept deliberately while #1861 is open: option 1 of that issue routes the live
// op path's advisoryFindings through this projection before persisting. Do not
// delete without a ruling on #1861.
```

Rewrite the module header (lines 1–14): drop the sentence claiming semantic/adversarial/semantic-debate reviewers call through here (they're deleted); keep the #942 history. In `test/unit/review/finding-projection.test.ts`, delete only the test cases that call `llmFindingsToReviewFindings`; keep every `findingToReviewFinding`/`findingsToReviewFindings` case.

- [ ] **Step 1b: Handle the `parseLLMResponse` orphan**

`parseLLMResponse` (`src/review/semantic-helpers.ts`) had exactly two consumers: the deleted `semantic-debate.ts:144` and the barrel export at `src/review/index.ts:38`. The live op uses `validateLLMShape` + `tryParseLLMJson` instead. Check test usage first: `grep -rn "parseLLMResponse" test/ --include="*.ts"` — `acks.test.ts` and `semantic-categories.test.ts` matched a symbol search earlier, but that may have been `validateLLMShape`. If no surviving test or src caller uses `parseLLMResponse`, delete the function from `semantic-helpers.ts` and change the barrel line to `export { validateLLMShape } from "./semantic-helpers";`. If a surviving test builds fixtures through it, keep the function and leave the barrel line intact.

- [ ] **Step 2: Fix stale comments that name deleted modules**

Each is a one-line comment edit; new wording must point at the live path:
- `src/prompts/builders/review-builder.ts:4` — "Owns the prompt for `src/review/semantic.ts:runSemanticReview()`" → "Owns the semantic reviewer prompt, consumed by `src/operations/semantic-review.ts` via `callOp`."
- `src/review/prepare-inputs.ts:7` (and line 49) — drop "legacy runSemanticCheck / runAdversarialReview paths" wording; the consumers are `plan-inputs.ts` and `run-phase.ts`.
- `src/review/semantic-helpers.ts:60` — remove the reference to `llmFindingsToReviewFindings`.
- `src/execution/plan-inputs.ts:322` — rewrite the historical note so it doesn't cite `runSemanticCheck / runAdversarialReview` as if they exist ("the deleted runReview LLM wrappers (#1859) collected these before callOp" is fine).
- `src/context/engine/stage-config.ts:292` — remove/reword the `src/review/semantic-debate.ts` reference.
- `src/review/ac-quote-validator.ts:14` — "Used by src/review/semantic.ts and semantic-debate.ts" → name the live consumers (`operations/semantic-review.ts` / `finding-filters.ts`; check with grep and write what's true).
- `src/review/acks.ts:22` — reword the `semantic-debate.ts` N-debaters rationale as historical.
- `test/helpers/runtime.ts:67` — replace the `runSemanticReview` usage example with an op-path example or delete the example block.

- [ ] **Step 3: Whole-repo reference check**

Run: `grep -rn "runSemanticReview\|runAdversarialReview\|runSemanticDebate\|semantic-debate\|adversarial-outcomes\|semantic-outcomes\|review-grounding-filter\|stages\.review" src/ test/ --include="*.ts" | grep -v "context/engine"` 
Expected: zero hits (the `context/engine` exclusion covers the unrelated context-engine `stages.review` naming — verify any hit there is context-engine config, e.g. `test/unit/context/engine/stage-assembler-extra-provider-ids.test.ts:109`, not debate). Fix any stragglers.

- [ ] **Step 4: Run the affected trees and commit**

Run: `bun test test/unit/review/ test/unit/debate/ test/unit/config/ test/unit/operations/`
Expected: PASS.

```bash
git add -A
git commit -m "chore(review): drop llmFindingsToReviewFindings, tidy stale dead-path references (#1859)

findingToReviewFinding is kept pending the #1861 shape ruling."
```

---

### Task 5: Full gate run and PR

**Files:**
- None new; possibly gate-baseline files if a ratchet fires.

**Interfaces:**
- Consumes: Tasks 1–4 committed on `chore/1859-delete-dead-llm-reviewer-cluster`.
- Produces: an open PR closing #1859.

- [ ] **Step 1: Full suite**

Run: `bun run lint` then `bun run test` (the FULL script — never bare `bun test` for the suite).
Expected: green. If a file-size ratchet, test-count ratchet, or dead-export gate fires on the shrinkage, update its baseline file in-repo and include the gate name in the commit message. If anything else fails, fix the implementation, not the gate.

- [ ] **Step 2: Commit any gate-baseline updates**

```bash
git add -A
git commit -m "chore: refresh gate baselines after reviewer-cluster deletion (#1859)"
```

(Skip if the working tree is clean.)

- [ ] **Step 3: Review the full branch diff before pushing**

Run: `git diff main...HEAD --stat` and skim `git diff main...HEAD -- src/`
Verify: only deletions/comment edits in `src/` outside the three seams (runner dispatch, debate schema/types/descriptions, finding-projection trim). Net src delta ≈ −1,900 lines; test delta ≈ −9,400. **Also verify no `docs/superpowers/` path appears in the stat output** — this plan file must not be in the PR (see Global Constraints).

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin chore/1859-delete-dead-llm-reviewer-cluster
gh pr create --title "chore: delete unreachable runReview LLM reviewer cluster and review-stage debate (#1859)" --body "$(cat <<'EOF'
Closes #1859 (ruling: option 1 — https://github.com/nathapp-io/nax/issues/1859#issuecomment-5549769625).

## What
- Deletes `src/review/{adversarial,adversarial-outcomes,semantic,semantic-outcomes,semantic-debate}.ts` (~1,780 lines) and the ~21 test files that exercised the unreachable entry points.
- `runReview` no longer dispatches `semantic`/`adversarial`; the names remain valid in `review.checks` (the live op path gates on them) and are skipped in reconciliation — same effective outcome as the old unconditional `skipped: no git ref`.
- Removes the review-stage debate surface: `debate.stages.review` (schema, type, config description, `REMOVED_NO_OP_KEYS` warn-and-strip entry) and the `review-grounding-filter` verifier — both consumed only by the deleted path. Legacy configs carrying `debate.stages.review` still parse (warned once, then stripped); back-compat tests pin this. Accepted edge: a config setting `postDebateVerifier.kind: "review-grounding-filter"` on a surviving stage now fails parsing with a clear enum error — the verifier was only meaningful for review-stage debate, which never ran.

## Follow-up candidates (not this PR)
- `debate.stages.{acceptance,rectification,escalation}` have zero `DebateRunner` call sites (config-only, never wired).
- `review.gateLLMChecksOnMechanicalPass` has zero readers (pre-existing inert knob).
- Trims `finding-projection.ts` to `findingToReviewFinding` (kept for #1861 option 1); deletes `llmFindingsToReviewFindings`.

## #1861
Deleting `semantic-audit-shape.test.ts` removes the phantom gate that certified an audit shape production never writes. #1861 stays open: the advisory-shape decision (project live findings vs amend #942) and an audit-shape test that drives the op path are follow-up work.

## Live coverage unaffected
The op reviewers keep their own suites (`test/unit/operations/*review*`, 13 files); every shared helper (`prepare-inputs`, `finding-filters`, `recurrence-demotion`, `requote-response`, `acks`, `ac-quote-validator`, `adversarial-helpers`, `semantic-helpers`) has direct tests that survive.
EOF
)"
```

- [ ] **Step 5: Post a link-back comment on #1861**

```bash
gh issue comment 1861 --body "The #1859 deletion PR removes the phantom gate (semantic-audit-shape.test.ts) and llmFindingsToReviewFindings, and keeps findingToReviewFinding as the option-1 candidate. Remaining decisions here: pick the canonical advisoryFindings shape (option 1 vs 2) and add an audit-shape test that drives the op path with a real producer."
```

---

## Self-Review Notes

- Spec coverage: #1859 option 1 → Tasks 1–2; ruling rider 1 (debate knob) → Task 3; rider 3 (keep finding-projection) → Task 4 Step 1; #1861 option-3 partial → Task 2 Step 2 note + Task 5 Steps 4–5. Rider 2 (foreclosing option 2) needs no code.
- Deliberately out of scope: `acceptance`/`rectification`/`escalation` debate stages also have zero `DebateRunner` call sites (config-only, never wired) — a separate issue, not this PR; do not expand into it. Likewise `review.gateLLMChecksOnMechanicalPass` (`schemas-review.ts:204`) has zero readers anywhere in src — a pre-existing inert knob, candidate for `REMOVED_NO_OP_KEYS` in the same follow-up issue; mention both in the PR body as follow-ups but change neither here. Also out of scope: #1861's shape decision, and collapsing #1860's `AdvisoryFinding = Finding | ReviewFinding` union (blocked on #1861).
- Reviewed 2026-09-05 (post-write verification pass against the repo): fixed the Task 1 test to mock the RQ-001 `getUncommittedFiles` guard and use `makeConfigSlice`; repointed the Task 3 back-compat test at `NaxConfigSchema` (what `debate-schema.test.ts` actually drives); routed `debate.stages.review` through the repo's `stripRemovedNoOpKeys` convention instead of silent-only stripping; added the `parseLLMResponse` orphan (Task 4 Step 1b); documented the `review-grounding-filter` enum hard-fail as an accepted risk. Verified: `SemanticStory` is imported everywhere from `review/types` (not the deleted files); all 17 test files importing `@/review/semantic` or `@/review/adversarial` are on the Task 2 delete list; `config-descriptions.test.ts` gates routing keys only, so removing the debate description entry is safe.
- Type consistency: `ReviewConfig` (Task 1 test) comes from the same import runner.test.ts already uses; `DebateConfigSchema` (Task 3 test) is exported from `src/config/index.ts:76`.
