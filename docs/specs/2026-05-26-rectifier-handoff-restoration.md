# Rectifier Handoff Restoration — Implementer→Test-Writer + Escalation Fixes

**Date:** 2026-05-26
**Trigger:** Run `logs/2026-05-26T05-04-43.jsonl` line 275–278 — screener-ui-web US-001 paused silently after `findings.cycle` exited with `agent-gave-up`. Audit log `logs/prompt-audit/screener-ui-web/1779775142402-…-implementer-rectification-t01.txt` showed the implementer emitted `UNRESOLVED` without trying Exception 4 (mock_structure handoff) despite the case fitting it.

**Scope:** Three independent bugs that compound. Each ships in its own PR.

---

## Background

Before `f38aedf2` ("Unify story execution around builder phases and finding-driven rectification", 2026-05-23), the implementer→test-writer handoff worked as follows:

1. Rectifier prompt advertised four `TEST_EDIT_REASON` escape valves.
2. `implementerRectifyOp.parse()` extracted `TestEditDeclaration[]` from agent output.
3. `extractApplied` on the implementer strategy stashed declarations into `ctx.testEditDeclarations` (and `mock_structure` ones into `ctx.pendingMockStructureHandoffs`).
4. The cycle's `validate` hook (in `src/pipeline/stages/autofix-cycle.ts`) called `applyTestEditDeclarations(findings, declarations, story)` which re-tagged `fixTarget: "source" → "test"` for findings matching a valid `prd_contract` declaration's `FILE`.
5. Next iteration, `runFixCycle` selected `makeAutofixTestWriterStrategy` (appliesTo: `fixTarget === "test"`) — handoff complete.
6. For `mock_structure` declarations, `validateMockStructureFiles` partitioned them, populated `ctx.pendingMockStructureHandoffs`, and the test-writer strategy's `buildInput` consumed them with `mode: "mock-restructure"`.

Commit `f38aedf2` deleted `src/pipeline/stages/autofix-cycle.ts` (602 lines) and replaced it with a generic `runFixCycle` invocation through `src/execution/build-plan-for-strategy.ts:140-162`. Both strategies were kept but no consumer of `TEST_EDIT_REASON` declarations was carried over. The parser, the side-channel fields on `PipelineContext`, the test-writer's `mode: "mock-restructure"` input shape, and the prompt sections — all remain in place as dead plumbing.

Additionally, `findings/cycle.ts` distinguishes `agent-gave-up` from cap-exhausted exits with semantically equivalent findings, but `story-orchestrator.ts` only promotes the cap exits to `rectificationExhausted`. The `agent-gave-up` exit is dropped, leaving the run to pause without escalation.

---

## Bug Summary

| ID | Bug | Site | Severity |
|:---|:---|:---|:---|
| A | `agent-gave-up` cycle exit does not trigger `rectificationExhausted` | `src/execution/story-orchestrator.ts:707-715` | high — silent pause where escalation expected |
| B | Implementer→test-writer handoff broken: declarations parsed, never routed | `src/operations/autofix-{implementer,test-writer}-strategy.ts`, missing `validate` hook | high — escape valves 2 and 4 are unreachable |
| C | Rectifier prompt says "three" exceptions but lists four for TDD; non-TDD strip is also broken | `src/prompts/builders/rectifier-builder-helpers.ts`, 6 call sites in `rectifier-builder.ts` | medium — agent refuses valid Exception 4 cases |

All three reproduced in the screener-ui-web run. Fix C alone restores the prompt; Fix B routes a now-emitted declaration; Fix A escalates if the agent still gives up despite a working handoff.

---

## Fix A — Promote `agent-gave-up` to `rectificationExhausted`

### Change

`src/execution/story-orchestrator.ts:707`

```ts
const exhaustedReasons = new Set<string>([
  "max-attempts-total",
  "max-attempts-per-strategy",
  "bail-when",
  "no-strategy",
  "agent-gave-up",   // NEW
]);
```

### Rationale

`src/findings/cycle.ts:289-295` returns `exitReason: "agent-gave-up"` with `finalFindings: cycle.findings` (populated). This is semantically equivalent to running out of retries — the findings remain unfixed and the agent voluntarily declined to continue. The existing escalate branch at `src/execution/post-run.ts:402` (`return { action: "escalate", reason: "Rectification exhausted with unfixed findings" }`) is the correct response.

### Files

- `src/execution/story-orchestrator.ts` — 1-line addition

### Tests

- `test/unit/execution/story-orchestrator.test.ts` — new case: cycle returns `{exitReason: "agent-gave-up", finalFindings: [synthetic]}` → orchestrator returns `{rectificationExhausted: true, unfixedFindings: [...]}`.
- `test/unit/execution/post-run.test.ts` — verify the existing escalate branch handles the new path (no change needed; covered by existing tests if `rectificationExhausted` already exercises that branch).

### Risk

- Stories that previously paused silently now escalate to the next tier. This is the intended behaviour and matches what the user expected when filing the report. A run that previously stalled at `balanced` will now retry at `powerful`, costing one additional tier attempt. Acceptable.
- Watch for: tests that asserted `action: "pause"` for the `agent-gave-up` path. Grep before merging.

### Acceptance

- [verbatim] Given a rectification cycle that exits with `exitReason: "agent-gave-up"` and non-empty `finalFindings`, the story orchestrator returns `{rectificationExhausted: true, unfixedFindings: cycleResult.finalFindings}`.
- [verbatim] Given `rectificationExhausted: true` from the orchestrator, `decideStageAction` returns `{action: "escalate", reason: "Rectification exhausted with unfixed findings"}`.

### Effort

~30 minutes including test.

---

## Fix B — Restore implementer→test-writer handoff plumbing

### Goal

Re-wire the four-step chain so a `TEST_EDIT_REASON` block in the implementer's output causes the next iteration to run the test-writer strategy on the affected finding.

### Strategy

Port the deleted logic from commits `84d81324`, `367a61bb`, `5f55e27c`, `44731506` into the new `runFixCycle`-driven architecture. Keep the same public shapes (`TestEditDeclaration`, `pendingMockStructureHandoffs`, `mode: "mock-restructure"`) — only the wiring needs work.

### Sub-steps

#### B1 — Port `applyTestEditDeclarations` helper

Recreate from commit `84d81324`. Pure function; no `ctx` dependency.

**New file:** `src/operations/apply-test-edit-declarations.ts`

```ts
export function applyTestEditDeclarations(
  findings: Finding[],
  declarations: TestEditDeclaration[],
  story: UserStory,
  invalidMockStructure?: TestEditDeclaration[],
): Finding[]
```

Behaviour:
- For `prd_contract`: validate `validatePrdQuote(d.prdQuote, story)`. If pass, re-tag any matching `findings[i].file === d.file` from `fixTarget: "source"` to `"test"` and attach `meta.prdContractDeclaration`. If fail, append an advisory finding (`category: "prd_quote_mismatch"`, `severity: "warning"`).
- For invalid `mock_structure` (file doesn't exist or doesn't match test pattern): append an advisory finding (`category: "mock_structure_invalid_files"`, `severity: "warning"`).
- For `lint_only` / `sibling_scope`: passthrough (parsed for telemetry only).
- Pure — does not mutate input arrays.

Export from `src/operations/index.ts`.

#### B2 — Port `validateMockStructureFiles` helper

Recreate from commit `367a61bb`. Pure function; takes resolved test patterns + package dir + a file-existence check.

**New file:** `src/operations/validate-mock-structure-files.ts`

```ts
export function validateMockStructureFiles(
  declarations: TestEditDeclaration[],
  resolvedTestPatterns: ResolvedTestPatterns,
  packageDir: string,
  deps?: { fileExists?: (path: string) => Promise<boolean> },
): Promise<{ valid: TestEditDeclaration[]; invalid: TestEditDeclaration[] }>
```

Behaviour:
- Non-`mock_structure` declarations passthrough to `valid` unchanged.
- For `mock_structure`: each file in `decl.files` must (a) exist on disk and (b) match `resolvedTestPatterns.regex`. If any file fails, the whole declaration goes to `invalid`.
- Inject `deps` for testability (default: `Bun.file(p).exists()`).

Export from `src/operations/index.ts`.

#### B3 — Declaration sink type

Define the shared mutable sink that the implementer strategy writes to and the postValidate hook + test-writer strategy read from. One instance per rectification cycle, created in `build-plan-for-strategy.ts` and captured by closure.

```ts
// New: src/operations/declaration-sink.ts
export interface DeclarationSink {
  testEdits: TestEditDeclaration[];        // all non-mock_structure (prd_contract, lint_only, sibling_scope)
  mockHandoffs: { files: string[]; reasonDetail: string }[];
}

export function makeDeclarationSink(): DeclarationSink {
  return { testEdits: [], mockHandoffs: [] };
}
```

Export from `src/operations/index.ts`.

#### B4 — Wire implementer strategy `extractApplied`

`src/operations/autofix-implementer-strategy.ts`

Add a `sink` parameter to the factory:

```ts
export function makeAutofixImplementerStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
): FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig>
```

Inside `extractApplied`:
- Partition `output.testEditDeclarations` by reason: `mock_structure` → push to `sink.mockHandoffs` (as `{files: d.files!, reasonDetail: d.reasonDetail!}`); others → push to `sink.testEdits`.
- Return `{summary: output.unresolvedReason ?? "", unresolved: output.unresolvedReason}` (unchanged from current shape).

#### B5 — Wire test-writer strategy `buildInput` + `appliesTo`

`src/operations/autofix-test-writer-strategy.ts`

Add a `sink` parameter:

```ts
export function makeAutofixTestWriterStrategy(
  story: UserStory,
  config: NaxConfig,
  sink: DeclarationSink,
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig>
```

- `appliesTo`: existing `(f) => f.fixTarget === "test" || f.source === "adversarial-review"` PLUS `|| sink.mockHandoffs.length > 0`. The handoff length is read synchronously each call — no peek API needed since `sink` is captured by closure.
- `buildInput`:
  - If `sink.mockHandoffs.length > 0`: dedupe files across all entries (Set), join `reasonDetail` with `\n---\n`, set `mode: "mock-restructure"`, `handoffFiles`, `handoffReason`. Then clear: `sink.mockHandoffs.length = 0`.
  - Otherwise default behaviour (current shape).

#### B6 — Add `postValidate` to `RectificationPhaseOptions` and call it

`src/execution/story-orchestrator.ts:50-55` — add the optional field:

```ts
export interface RectificationPhaseOptions {
  readonly maxAttempts: number;
  readonly strategies: FixStrategy<Finding, any, any, any>[];
  readonly abortOnIncreasingFailures: boolean;
  /** Optional: transform findings after validate() returns, before next iteration's strategy selection. */
  readonly postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
}
```

`src/execution/story-orchestrator.ts:664-686` (`runRectification`) — wrap the existing `validate` closure tail:

```ts
validate: async (validateCtx, opts) => {
  // ...existing verifier/gate re-run, populates `findings` array...
  return rectification.postValidate ? await rectification.postValidate(findings, validateCtx) : findings;
}
```

#### B7 — Register the postValidate hook + construct sink

`src/execution/build-plan-for-strategy.ts:140-162` — refactor:

```ts
if (shouldRunRectification(config) && inputs.rectification) {
  const strategies: FixStrategy<Finding, unknown, unknown, unknown>[] = [];
  const sink = makeDeclarationSink();          // NEW

  // mechanical fixes — unchanged
  if (config.quality.commands.lintFix || config.quality.commands.lintFixScoped) { ... }
  if (config.quality.commands.formatFix || config.quality.commands.formatFixScoped) { ... }
  if (isThreeSession && inputs.fullSuiteGate) { ... }

  if (config.quality.autofix?.enabled !== false) {
    strategies.push(makeAutofixImplementerStrategy(story, config, sink) as ...);   // pass sink
    strategies.push(makeAutofixTestWriterStrategy(story, config, sink) as ...);    // pass sink
  }

  // NEW — resolve test patterns ONCE (not per iteration)
  const resolvedTestPatterns = await resolveTestFilePatterns(config, ctx.workdir, story.workdir);
  const packageDir = join(ctx.workdir, story.workdir);

  const postValidate = async (findings: Finding[], _validateCtx: FixCycleContext): Promise<Finding[]> => {
    if (sink.testEdits.length === 0 && sink.mockHandoffs.length === 0) return findings;

    // Partition mock-structure declarations by existence + test-pattern match.
    // Wrap them as TestEditDeclaration shape for validateMockStructureFiles.
    const pendingMock: TestEditDeclaration[] = sink.mockHandoffs.map(h => ({
      reason: "mock_structure",
      file: h.files[0]!,
      files: h.files,
      reasonDetail: h.reasonDetail,
    }));
    const { valid, invalid } = await validateMockStructureFiles(pendingMock, resolvedTestPatterns, packageDir);

    // Replace sink.mockHandoffs with only the validated entries so the next test-writer
    // iteration consumes only valid ones. Invalid ones become advisory findings (below).
    sink.mockHandoffs = valid.map(d => ({ files: d.files!, reasonDetail: d.reasonDetail! }));

    const allDeclarations = [...sink.testEdits, ...valid];
    sink.testEdits = [];  // consumed

    return applyTestEditDeclarations(findings, allDeclarations, story, invalid);
  };

  const rectOpts: RectificationPhaseOptions = {
    ...inputs.rectification,
    strategies: [...strategies, ...inputs.rectification.strategies],
    postValidate,
  };
  builder.addRectification(rectOpts);
}
```

**Performance:** `resolveTestFilePatterns` is called once at plan-build time, captured by the closure. `validateMockStructureFiles` is called only when sink is non-empty (typical: 0–2 declarations per iteration).

#### B8 — Delete dead `PipelineContext` fields

Once B3-B7 are wired through the sink, the unused fields can go:

- Remove `testEditDeclarations?: TestEditDeclaration[]` from `src/pipeline/types.ts:191`
- Remove `pendingMockStructureHandoffs?: { files: string[]; reasonDetail: string }[]` from `src/pipeline/types.ts:198`

Both fields have zero current consumers (verified). The sink supersedes them with proper scoping. Grep `testEditDeclarations` and `pendingMockStructureHandoffs` before deletion to confirm no stragglers were missed during this work.

### Files

- New: `src/operations/apply-test-edit-declarations.ts`
- New: `src/operations/validate-mock-structure-files.ts`
- New: `src/operations/declaration-sink.ts`
- Modified: `src/operations/autofix-implementer-strategy.ts` — add `sink` param
- Modified: `src/operations/autofix-test-writer-strategy.ts` — add `sink` param, expand `appliesTo`, drain in `buildInput`
- Modified: `src/operations/index.ts` — re-export `applyTestEditDeclarations`, `validateMockStructureFiles`, `makeDeclarationSink`, `DeclarationSink`
- Modified: `src/execution/story-orchestrator.ts` — add `postValidate?` to `RectificationPhaseOptions`, call it inside `runRectification`
- Modified: `src/execution/build-plan-for-strategy.ts` — construct sink, resolve test patterns once, register `postValidate`, thread sink through both autofix strategy factories
- Modified: `src/pipeline/types.ts` — remove dead `testEditDeclarations` and `pendingMockStructureHandoffs` fields (B8)

### Tests

- `test/unit/operations/apply-test-edit-declarations.test.ts` — port from `test/unit/pipeline/stages/autofix-cycle.test.ts` in commit `84d81324`. Cases: valid `prd_contract` re-tags; invalid `prd_quote` synthesizes advisory; `mock_structure` invalid synthesizes advisory; `lint_only`/`sibling_scope` passthrough.
- `test/unit/operations/validate-mock-structure-files.test.ts` — file exists + matches pattern → valid; file missing → invalid; file exists but not test pattern → invalid.
- `test/unit/operations/autofix-implementer-strategy.test.ts` — `extractApplied` pushes declarations to sinks.
- `test/unit/operations/autofix-test-writer-strategy.test.ts` — `appliesTo` fires when handoffs pending; `buildInput` returns `mode: "mock-restructure"` with deduped files.
- `test/integration/findings/autofix-handoff.test.ts` — end-to-end: implementer emits `prd_contract` → next iteration re-tags + runs test-writer; implementer emits `mock_structure` → next iteration runs test-writer with `mode: "mock-restructure"` and the file list.

### Risk

- The `DeclarationSink` is mutable shared state. Acceptable because it is scoped to a single rectification cycle's closure (one per story per run) — no cross-story leakage possible. Document the pattern at `src/operations/declaration-sink.ts`.
- `validateMockStructureFiles` does async disk I/O. The plan resolves test patterns ONCE at plan-build time (B7) and stamps them into the closure — `postValidate` calls `validateMockStructureFiles` only when the sink is non-empty.
- The `postValidate` field is added to `RectificationPhaseOptions` (nax-internal), not to `FixCycle<F>` (findings framework). No public-API change to `src/findings/`.
- Other rectification consumers (`run-regression.ts`, `acceptance-loop.ts`) construct their own `FixCycle` directly — they are NOT affected by the `RectificationPhaseOptions` change, which is only consumed by `story-orchestrator.runRectification`. Verify by grepping `RectificationPhaseOptions` before merging.

### Acceptance

- [verbatim] Given an `autofix-implementer` op emits a `TEST_EDIT_REASON: prd_contract` block with a `PRD_QUOTE` that appears in the story's description or acceptance criteria, the matching finding's `fixTarget` is set to `"test"` before the next iteration's strategy selection.
- [verbatim] Given an `autofix-implementer` op emits a `TEST_EDIT_REASON: mock_structure` block with FILES that exist on disk and match the resolved test-file patterns, the next iteration runs `autofix-test-writer` with `mode: "mock-restructure"`, `handoffFiles` equal to the deduped union of declared files, and `handoffReason` equal to the joined `REASON` paragraphs.
- [verbatim] Given an `autofix-implementer` op emits a `TEST_EDIT_REASON: prd_contract` block with a `PRD_QUOTE` that does NOT appear verbatim in the story text, an advisory finding with `category: "prd_quote_mismatch"` and `severity: "warning"` is appended to the next iteration's findings and no re-tag occurs.
- [verbatim] Given an `autofix-implementer` op emits a `TEST_EDIT_REASON: mock_structure` block referencing a FILE that does not exist on disk or does not match the resolved test-file patterns, an advisory finding with `category: "mock_structure_invalid_files"` and `severity: "warning"` is appended to the next iteration's findings and no handoff is staged.

### Effort

~1 day — most of it porting and re-testing. Helpers are mechanical translations of deleted code.

---

## Fix C — Rectifier prompt count + Exception 4 wording + broken non-TDD strip

### Changes

#### C1 — Replace static `CONTRADICTION_ESCAPE_HATCH` with a builder

`src/prompts/builders/rectifier-builder-helpers.ts`

Replace lines 25-126 with:

```ts
interface EscapeHatchOptions {
  includeMockHandoff: boolean;
}

export function buildEscapeHatch(opts: EscapeHatchOptions): string {
  const exceptions: string[] = [
    EXCEPTION_1_LINT_ONLY,
    EXCEPTION_2_PRD_CONTRACT,
    EXCEPTION_3_SIBLING_SCOPE,
  ];
  if (opts.includeMockHandoff) exceptions.push(EXCEPTION_4_MOCK_HANDOFF);

  const count = exceptions.length;
  const countWord = ["zero", "one", "two", "three", "four"][count];

  return `
If two findings in this list contradict each other and you cannot satisfy both, do not guess.
Emit fixes for defects you can resolve, then output a line in this exact format:
UNRESOLVED: <brief explanation of which findings conflicted and why they cannot both be satisfied>

Before emitting UNRESOLVED, confirm none of Exceptions 1–${count} apply.

## Test-file edit exceptions

The "do not modify test files" rule has ${countWord} narrow escape valves. Each requires a
declaration in your output. Outside these ${countWord} cases the rule is absolute.

${exceptions.join("\n\n")}`;
}
```

Each exception becomes its own const (`EXCEPTION_1_LINT_ONLY`, etc.) defined separately. This eliminates the broken `.replace` at line 125 and guarantees the count matches the included exceptions.

`escapeHatchFor(story)` becomes:

```ts
function escapeHatchFor(story: UserStory): string {
  const isTdd = THREE_SESSION_STRATEGIES.has(story.routing?.testStrategy ?? "");
  return buildEscapeHatch({ includeMockHandoff: isTdd });
}
```

#### C2 — Update all "three" hardcoded strings

Six call sites currently say "the three narrow exceptions":
- `src/prompts/builders/rectifier-builder-helpers.ts:203, 285`
- `src/prompts/builders/rectifier-builder.ts:203, 577, 707, 843`

Replace with a helper:

```ts
export function exceptionCountWord(story: UserStory): "three" | "four" {
  return THREE_SESSION_STRATEGIES.has(story.routing?.testStrategy ?? "") ? "four" : "three";
}
```

And inline-interpolate at each site: `… see the ${exceptionCountWord(story)} narrow exceptions appended below.`

The two bullet-list mentions at `rectifier-builder.ts:577` and `rectifier-builder.ts:843` also need to mention Exception 4 conditionally — convert to a builder call.

#### C3 — Broaden Exception 4 wording (language-neutral, see Q2)

`EXCEPTION_4_MOCK_HANDOFF` body becomes (no tool names; generalises across JS/TS, Python, Go, Rust):

```
### Exception 4 — Mock-structure handoff

Use ONLY when the only path to satisfy the ACs requires a structural test rewrite
that does NOT fit Exception 2. Two cases qualify:

  (a) Existing mocks are wrong — mocks reference primitives the new code bypasses,
      or assertion topology must change to match a new dispatch shape.

  (b) Required test-infrastructure does not yet exist and must be introduced —
      e.g. in-process fake servers, network-level request interception, hermetic
      fixture-backed HTTP, or equivalent. Applies whenever the AC describes a
      hermetic/fixture-backed test surface that the current test setup cannot
      satisfy without new infrastructure.

Declare with:
\`\`\`
TEST_EDIT_REASON: mock_structure
FILES: <comma-separated test file paths>
REASON: <one paragraph: which mock is wrong vs which dispatch the new code uses,
         or what infrastructure must be introduced>
\`\`\`

Rules:
- Do NOT make any edits yourself; the test-writer will fulfill.
- Do NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff.
- FILES must list real test files. Each path must exist and be a test file.
```

This is what unblocks the rs-stock E2E case. The current wording reads as case (a) only; case (b) is exactly what the screener-ui-web run needed. The phrase "hermetic/fixture-backed test surface" mirrors verbatim AC wording in such cases ("Given a hermetic Playwright fixture-backed API …") giving the agent a textual anchor.

### Files

- Modified: `src/prompts/builders/rectifier-builder-helpers.ts`
- Modified: `src/prompts/builders/rectifier-builder.ts` — six sites

### Tests

- `test/unit/prompts/rectifier-builder-helpers.test.ts` — snapshot the rectifier prompt for `{testStrategy: "three-session-tdd"}` and `{testStrategy: "no-test"}`. Assert:
  - TDD path includes Exception 4 and says "four narrow escape valves".
  - Non-TDD path excludes Exception 4 and says "three narrow escape valves".
  - `Exceptions 1–N` line interpolates correctly.
  - Case (b) wording appears in Exception 4.
- Update existing snapshot tests that may capture the prompt — re-bake.

### Risk

- Prompt change → agent behaviour change. The `four` count is more permissive than `three` (one more escape valve available). Watch for false-positive Exception 4 usage on the first few runs; the `validateMockStructureFiles` guard from Fix B catches fabricated declarations.
- Snapshot tests in `test/unit/prompts/` will need re-baking.

### Acceptance

- [verbatim] For a story with `routing.testStrategy === "three-session-tdd"`, the rectifier prompt's escape-hatch section includes Exception 4 (Mock-structure handoff) and the intro count reads "four narrow escape valves" / "Outside these four cases the rule is absolute".
- [verbatim] For a story with `routing.testStrategy === "no-test"`, the rectifier prompt's escape-hatch section excludes Exception 4 and the intro count reads "three narrow escape valves" / "Outside these three cases the rule is absolute".
- [verbatim] Exception 4's body contains both case (a) — "mocks reference primitives the new code bypasses" — and case (b) — "required mock infrastructure does not yet exist and must be introduced".
- [verbatim] The escape-hatch section contains the line `Before emitting UNRESOLVED, confirm none of Exceptions 1–N apply` where N is the count of included exceptions.

### Effort

~2-3 hours including snapshot rebake.

---

## Ordering & PR plan

| PR | Bug | Why this order |
|:---|:---|:---|
| 1 | B — handoff plumbing | Largest surface (~1 day). Land first so C and A have somewhere to route declarations. |
| 2 | C — prompt | Cheapest (~2-3h). Activates the now-wired handoff by making the agent actually emit `TEST_EDIT_REASON: mock_structure` in case-(b) situations. |
| 3 | A — escalate on agent-gave-up | One-line + test (~30 min). Safety net for the residual case where the agent still gives up despite the working handoff. |

**Why not C first:** shipping C alone changes the agent's reply from `UNRESOLVED outside the three exceptions` to `TEST_EDIT_REASON: mock_structure …` — but with B unmerged, the declaration goes to /dev/null and the story still pauses. C-first would look like a regression in logs ("agent now claims handoff but nothing happens"). Ship B first so C has somewhere to route to; the order above gives every PR a visible user-facing improvement on merge.

**Alternative:** ship B+C together as one PR. Either is acceptable; the three-PR sequence above keeps reviews small and lets each one ship without holding up the others if the queue stalls.

Each PR is independently shippable — they fix non-overlapping failure modes. B unblocks the routing; C activates the route by fixing the prompt; A handles the residual case where higher capability is needed.

### Not in scope

- Adding a fifth exception or new escape valve.
- Changing the rectification cap config (recently raised 2→12 in `d5a02f41`).
- Reworking `deriveTddFailureCategory` to consider semantic-review / rectification outputs — Fix A handles the symptom via the existing escalate branch; a deeper refactor is overkill for this case.

---

## Resolved questions

### Q1 — `FixCycle` seam — RESOLVED: use existing `validate`, add `postValidate?` to `RectificationPhaseOptions`

`src/findings/cycle-types.ts:184` already defines `FixCycle.validate: (ctx, opts) => Promise<F[]>` as a mandatory hook. `src/execution/story-orchestrator.ts:664-686` (`runRectification`) builds the validate closure that re-runs verifier/gate phases between iterations.

**No change needed to the findings framework.** The cleanest seam is at the nax-layer above:

1. Add an optional field to `RectificationPhaseOptions` in `src/execution/story-orchestrator.ts:50-55`:
   ```ts
   export interface RectificationPhaseOptions {
     readonly maxAttempts: number;
     readonly strategies: FixStrategy<Finding, any, any, any>[];
     readonly abortOnIncreasingFailures: boolean;
     /** Optional: transform findings after validate(), before next iteration's strategy selection. */
     readonly postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
   }
   ```

2. In `runRectification` (`story-orchestrator.ts:664`), wrap the existing validate closure:
   ```ts
   validate: async (validateCtx, opts) => {
     const fresh = /* ...existing verifier re-run, returns Finding[]... */;
     return rectification.postValidate ? await rectification.postValidate(fresh, validateCtx) : fresh;
   }
   ```

3. In `build-plan-for-strategy.ts:140-162`, construct a `declarationSink` closure object shared between the implementer strategy (writer) and the postValidate hook (reader). The test-writer strategy reads the same sink to drain handoffs in `buildInput`.

This keeps the change off the `findings/` framework. The sink object is plain (`{ testEdits: TestEditDeclaration[]; mockHandoffs: { files: string[]; reasonDetail: string }[] }`) and is mutated inside `extractApplied` of the implementer strategy, consumed by `postValidate`, and partially-consumed by the test-writer's `buildInput`.

**Trade-off:** the sink is mutable shared state. Acceptable because (a) it's scoped to one rectification cycle's closure (no cross-story leakage), (b) all mutations happen on a single thread, and (c) the prior architecture used `PipelineContext.testEditDeclarations` for the same purpose — this is a more localised version of that.

### Q2 — Exception 4 case (b) wording — RESOLVED: language-neutral, no tool names

Verified against the pre-implement rs-stock repo at `/home/williamkhoo/Desktop/projects/work/rs-stock/rs-stock/`. Tech: Next.js + Vitest + Playwright + TanStack Query, JS/TS only. The failing ACs read verbatim:

- **AC29:** *"Given `web/tests/e2e/screener.spec.ts`, when inspecting the repository, then the file exists and defines the screener happy-path flow **against fixture-backed API data**."*
- **AC30:** *"Given a **hermetic Playwright fixture-backed API**, when `web/tests/e2e/screener.spec.ts` runs, then it loads `/`, observes at least 12 strategy options, selects `golden-cross`, …"*

The AC itself says "hermetic" and "fixture-backed" — the spec explicitly requires test-infrastructure that does not yet exist (`web/tests/` contains only one vitest smoke test, no Playwright fixtures, no MSW). The implementer's failure mode was exactly: prompt said "fix existing mocks", AC said "introduce a hermetic fixture layer", implementer concluded "no match" → `UNRESOLVED`.

For language-neutrality, the case (b) example list should not pin specific tool names. nax orchestrates Go / Python / Rust / polyglot monorepos per `.claude/rules/monorepo-awareness.md`. Equivalent infrastructure across languages:

| Language | Examples |
|:---|:---|
| JS/TS | MSW, Playwright `page.route()`, nock, vitest fetch mock |
| Python | `responses`, `respx`, `pytest-httpserver`, Django `TestCase` client |
| Go | `httptest.NewServer`, `gock` |
| Rust | `wiremock`, `mockito` |

**Final wording** (replaces lines 105-107 of `rectifier-builder-helpers.ts`):

```
### Exception 4 — Mock-structure handoff

Use ONLY when the only path to satisfy the ACs requires a structural test rewrite
that does NOT fit Exception 2. Two cases qualify:

  (a) Existing mocks are wrong — mocks reference primitives the new code bypasses,
      or assertion topology must change to match a new dispatch shape.

  (b) Required test-infrastructure does not yet exist and must be introduced —
      e.g. in-process fake servers, network-level request interception, hermetic
      fixture-backed HTTP, or equivalent. Applies whenever the AC describes a
      hermetic/fixture-backed test surface that the current test setup cannot
      satisfy without new infrastructure.
```

No tool names. The phrase "hermetic/fixture-backed test surface" mirrors AC wording in the rs-stock case and generalises across languages.

---

## Verification

After all three PRs merge, re-run the screener-ui-web feature against the same PRD (pre-implement repo: `/home/williamkhoo/Desktop/projects/work/rs-stock/rs-stock/`). Expected behaviour:

1. Implementer reaches the AC29/AC30 finding, recognises it fits Exception 4 case (b) (AC text uses "hermetic Playwright fixture-backed API"), emits `TEST_EDIT_REASON: mock_structure` with `FILES=web/tests/e2e/screener.spec.ts,web/playwright.config.ts` and a REASON paragraph naming the missing fixture layer.
2. `runRectification.validate` closure runs the verifier re-run as today, then calls `rectification.postValidate` (B6). `postValidate` calls `validateMockStructureFiles` — both files exist and match resolved test patterns → both go to `valid` → sink's `mockHandoffs` is replaced with just the valid entries.
3. `applyTestEditDeclarations` returns findings unchanged in this case (no `prd_contract` declarations to re-tag).
4. Next iteration: `makeAutofixTestWriterStrategy.appliesTo` returns true because `sink.mockHandoffs.length > 0`. `buildInput` drains the sink, returns `mode: "mock-restructure"`, `handoffFiles: [...]`, `handoffReason: "..."`.
5. Test-writer agent introduces a fixture layer (Playwright `page.route()`, MSW handlers, or equivalent — agent picks) and reconfigures `playwright.config.ts` for hermetic mode.
6. Verifier re-runs E2E → passes → story completes at `balanced` tier with `firstPassSuccess: false` but `success: true`.

If the agent still cannot fulfil the handoff at `balanced` (e.g. the test-writer also gives up), the cycle exits with `agent-gave-up`, Fix A promotes that to `rectificationExhausted`, post-run.ts:402 returns `{action: "escalate"}`, and the run retries at `powerful` tier.

### Regression guard

Add an integration test under `test/integration/findings/autofix-handoff.test.ts` that reproduces the screener-ui-web shape: an implementer that always emits `TEST_EDIT_REASON: mock_structure` for a synthetic finding, and assert the test-writer fires in the next iteration with the declared files in `handoffFiles`. This catches future refactors that disconnect the sink, the same way `f38aedf2` did silently.
