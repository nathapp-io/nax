# SPEC: NBF worth-check — judge which advisory findings are worth fixing before the non-blocking fix

## Summary

Add a read-only LLM verifier, `nbfWorthCheckOp`, that runs once per story just before the non-blocking fix (NBF) pass. It reads the story, its acceptance criteria, the story diff, the PRD's pending stories and the seeded advisory findings, and returns one verdict per finding: `fix` or `skip`, each with a reason. A new config block `review.nonBlockingFix.worthCheck` selects the mode: `off` (default, today's behaviour), `shadow` (judge and log, still fix everything) or `on` (only `fix` findings seed NBF; when none remain, NBF does not run). Any failure falls back to fixing every finding. Each judgment is logged and written to an audit file.

## Motivation

NBF fixes every actionable advisory finding a passing story's reviewers leave behind. It takes about a quarter of story wall time, and some of what it fixes is not worth fixing: stale comments, speculative hardening for states the code cannot reach, or work a later story already does. Nothing decides worth today: `deriveNbfSeed` drops only `actionRequired: false`, `acDropped` and retired findings, and every remaining finding seeds the pass.

The reviewer's severity is not a usable worth signal. In a sample of advisory findings from passing adversarial reviews, about a quarter of `info` findings were real defects or rule violations, while some `warning` findings were nits. Judging worth needs a reader that sees the finding next to the code and the rest of the feature. A batched call per story keeps that judgment to one session per story.

## Design

### Approach

One run-kind op per story, batched over all of that story's seeded findings. The verdict is per finding. The op is read-only (`Read`, `Glob`, `Grep`), so it can open code to check whether a path is reachable. It does not use the advisor (`src/advisor/`), its ledger, or its menus.

Composition at the call site, in this order:

1. The existing NBF gate runs first, unchanged. The worth-check runs only when NBF would run today: the story is green, a review ran, and `deriveNbfSeed` returned `shouldRun: true`. A red story or an empty seed never pays for a worth-check.
2. When `worthCheck` is absent or its `mode` is `"off"`, the seed is used unchanged and the op is not called.
3. Otherwise the op is called. When the call throws or the reply is unparseable, the seed is used unchanged (fail-open).
4. `mode: "shadow"`: the verdicts are logged and audited, and the seed is used unchanged.
5. `mode: "on"`: only findings with verdict `fix` seed NBF. When no `fix` finding remains, NBF does not run for this story.

The filtered list replaces `seed.findings` at all three places `maybeRunNonBlockingFix` uses it today: `advisoryFindings`, `runRectify`'s `initialFindings`, and `buildNbfDeps({ findings })`.

### Reply contract

The model replies with one JSON object:

```json
{"verdicts":[{"index":1,"verdict":"fix","reason":"reachable: empty items still fires MARK_DELIVERING"},{"index":2,"verdict":"skip","reason":"stale comment only"}]}
```

`index` is the 1-based position of the finding in the prompt's numbered list. The parser normalises the reply into exactly one verdict per input finding, in input order:

- An entry whose `index` is not an integer in `1..findings.length` is ignored.
- Entries that are not JSON objects are ignored.
- When two entries share an `index`, the first one is chosen before any other rule applies; later entries for that `index` are ignored even when the first is invalid.
- An entry whose `verdict` is neither `"fix"` nor `"skip"` counts as `fix`, with reason `"(invalid verdict)"`.
- A `skip` entry whose `reason` is missing or blank counts as `fix`, with reason `"(skip without reason)"`.
- A finding with no entry counts as `fix`, with reason `"(no verdict returned)"`.
- A reply with no JSON value, a JSON value that is not an object (an array or a primitive), or an object with no `verdicts` array, yields `{ parsed: false, unparsedPreview }`. The preview comes from `previewOutput(output, UNPARSED_PREVIEW_BYTES)` and is `"(empty response)"` when blank, as in `fixReviewOp`.

There is no parse retry.

### Prompt text (normative, rendered by `buildNbfWorthCheckPrompt`)

The builder renders these sections in this order. Text in quotes is rendered verbatim.

1. `"You are checking which code-review findings are worth fixing before this story merges. You do not fix anything. Read code with the tools if you need to check whether a path is reachable."`
2. `"## Story"`, then `<story.id>: <story.title>`, the story description, and each acceptance criterion as `- <text>`.
3. `"## Pending stories in this feature"`, then one block per pending story: `<id>: <title>` followed by its criteria as `- <text>`. When there are no pending stories, this whole section, heading included, is omitted.
4. `"## Story diff"`, then the diff in a fenced block. When the diff is empty, the line `"(diff unavailable — judge from the code)"` replaces the fenced block.
5. `"## Findings"`, then one line per finding: `<n>. [<severity>/<category>] <file>:<line> — <message>`. `<file>:<line>` becomes `<file>` when `line` is absent, and `(no file)` when `file` is absent. When a finding has a `suggestion`, the next line is `   Suggested fix: <suggestion>`.
6. The rubric, verbatim:

```
## How to judge
Answer "fix" when the finding describes, for the code as it is now:
- wrong behaviour, a crash, data loss or a security problem that can actually happen; or
- a test that cannot catch the bug it claims to cover; or
- a break of a written project rule you can point to in the repo's rules or context files.
Answer "skip" when the finding:
- only matters if the code changes later or is used in a way it is not used now; or
- is only about comments, documentation, naming, log wording, exports or style, and no written rule requires it; or
- is already covered by a pending story listed above (name the story in the reason).
When you are unsure, answer "fix".
```

7. The output contract, verbatim:

```
## Reply
Reply with only this JSON object, one entry per finding:
{"verdicts":[{"index":1,"verdict":"fix","reason":"<one line>"}]}
```

### Config

```typescript
// src/config/schemas-review.ts
export const NbfWorthCheckConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).default("off"),
  model: ConfiguredModelSchema.optional(),
  timeoutMs: z.number().int().positive().default(300_000),
});
// inside NonBlockingFixConfigSchema:
worthCheck: NbfWorthCheckConfigSchema.optional(),
```

`worthCheck` is optional so existing object literals typed as `NonBlockingFixConfig` stay valid. An absent `worthCheck` behaves as `mode: "off"`. The op's model resolves as `worthCheck.model ?? "balanced"` and its timeout as `worthCheck.timeoutMs ?? 300_000` (the fallback only matters when the op is called without `worthCheck` set, which the runner never does). The name `worthCheck` is deliberately distinct from the existing `scope: "triage"` value, which routes findings by `fixTarget` and is unrelated.

### Log and audit

- Every log below puts `storyId` first and `packageDir` (`ctx.packageDir`) second in its data.
- One `info` log per judged story, stage `"nbf-worth-check"`, message `"worth-check verdicts"`, data `{ storyId, packageDir, mode, fix, skip, skipped }`. `fix` and `skip` are counts. `skipped` is an array of `{ file, line, reason }` for each `skip` verdict.
- When the op throws or the reply is unparseable: one `warn` log, stage `"nbf-worth-check"`, message `"worth-check failed — fixing all findings"`, data `{ storyId, packageDir, error }`. For an unparseable reply, `error` is the unparsed preview.
- When `mode` is `"on"` and every verdict is `skip`: one `info` log, stage `"nbf-worth-check"`, message `"all advisory findings skipped — NBF not run"`, data `{ storyId, packageDir, skip }`.
- Audit file, one per judged story: `<runtime.outputDir>/nbf-worth-check/<featureName or "_unknown">/<storyId>-<epochMs>.json`. Fields: `storyId`, `featureName`, `mode`, `parsed`, `unparsedPreview` (only when `parsed` is false; when `callOp` threw it is the error message), `findings` (`[{ index, severity, category, file, line, message }]`), `verdicts` (`[]` when `callOp` threw or the reply was unparseable), `durationMs`, `costUsd`. `costUsd` is the change in `totalSpendUsd(runtime.costAggregator.snapshot())` across the call, the same measure `src/advisor/service.ts` uses. A failed write logs a `warn` (stage `"nbf-worth-check"`, message `"worth-check audit write failed"`) and never changes the returned findings.

### Integration

Read-only symbols, verified on `main` @ `46fc2889b` (paths relative to `packages/nax`):

- `fixReviewOp` (`src/operations/fix-review.ts:53`) — the op shape to mirror: `kind: "run"`, `session: { role, lifetime: "fresh" }`, `tools: ["Read","Glob","Grep"]`, `config: reviewConfigSelector`, `model` and `timeoutMs` resolvers, `build` returning `{ role, task }`, `parse` through `tryParseLLMJson`.
- `previewOutput`, `UNPARSED_PREVIEW_BYTES` (`src/agents/retry/parse-retry`).
- `deriveNbfSeed(input): NbfSeed` (`src/execution/story-orchestrator/nbf-seed.ts:142`) — unchanged; its `findings` is the worth-check's input.
- `Finding` (`src/findings/types.ts`) — `severity`, `category`, `file?`, `line?`, `message`, `suggestion?`.
- `UserStory` (`src/prd/types.ts`) — `id`, `title`, `description`, `acceptanceCriteria: string[]`, `status`, `storyGitRef?`.
- `loadPRD(path): Promise<PRD>` (`src/prd/index.ts:83`) — throws `PRD_NOT_FOUND` when the file is absent.
- `CallContext.featureDir?` (`src/operations/types.ts:65`) — the feature directory; the PRD lives at `join(ctx.featureDir, "prd.json")`. Production sets it, together with `story` and `featureName`, in `src/pipeline/stages/execution.ts:184`.
- `StoryStatus` (`src/prd/types.ts:27`) — `pending`, `in-progress`, `passed`, `failed`, `skipped`, `blocked`, `paused`, `regression-failed`, `decomposed`.
- `resolveEffectiveRef(workdir, storyGitRef, storyId)`, `collectDiff(workdir, ref, excludePatterns)`, `collectDiffStat(workdir, ref)`, `truncateDiff(diff, stat)` (`src/review/diff-utils.ts`).
- `callOp(ctx, op, input)` (`@/operations`).
- `totalSpendUsd` and `runtime.costAggregator.snapshot()` — as used by `_advisorServiceDeps.costTotal` (`src/advisor/service.ts:62`).

Mutated symbols. The baseline only locates the code; the target is the interface to implement.

- `maybeRunNonBlockingFix` (`src/execution/story-orchestrator/execution-plan-phases.ts:509`).
  - Baseline: passes `seed.findings` to `runNonBlockingFix({ advisoryFindings })`, to `runRectification`'s `initialFindings`, and to `buildNbfDeps({ findings })`.
  - Target: after the existing `shouldRunNbf` check passes, `const findings = await runNbfWorthCheck({ ctx, findings: seed.findings, cfg: nbfCfg.worthCheck })`. When `findings` is empty, return without calling `runNonBlockingFix`. Otherwise pass `findings` at all three places. This file is at 576 of 600 lines, so the logic lives in the new runner and the call-site change is one awaited expression and one early-return `if`. `check:file-sizes` and `check:complexity` must stay green.
- `NonBlockingFixConfigSchema` (`src/config/schemas-review.ts:186`).
  - Baseline: fields `enabled`, `sources`, `scope`, `regressionAttempts`, `verifierGuard`, `sourceDiffCap`.
  - Target: those fields plus `worthCheck: NbfWorthCheckConfigSchema.optional()`.
- `NonBlockingFixConfig` (`src/config/selectors.ts:180`).
  - Baseline: `export type NonBlockingFixConfig = z.infer<typeof NonBlockingFixConfigSchema>`.
  - Target: unchanged, plus `export type NbfWorthCheckConfig = z.infer<typeof NbfWorthCheckConfigSchema>` beside it.
- `CanonicalSessionRole` and `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts:14,44`).
  - Baseline: the union and list end with `"advisor"`.
  - Target: both also contain `"nbf-worth-check"`. A read-only role needs no `REQUIRED_TOOLS_BY_ROLE` entry (`scripts/check-op-tool-capability.ts:47`).

### New modules (US-001 builder, US-002 op): `src/operations/nbf-worth-check.ts`

`NbfWorthCheckConfigSchema`, the `worthCheck` field and the `NbfWorthCheckConfig` type are added in US-001, because the op's `model` and `timeoutMs` resolvers (US-002) read them. Both resolvers use optional chaining, since `review.nonBlockingFix` is itself optional: `ctx.config.review.nonBlockingFix?.worthCheck?.model ?? "balanced"`.

```typescript
export interface NbfWorthCheckPendingStory {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
}
export interface NbfWorthCheckOpInput {
  readonly story: UserStory;
  /** Story diff, already truncated by the runner; "" when unavailable. */
  readonly diff: string;
  readonly findings: readonly Finding[];
  readonly pendingStories: readonly NbfWorthCheckPendingStory[];
}
export interface NbfWorthVerdict {
  readonly index: number; // 1-based, matches the prompt's numbered list
  readonly verdict: "fix" | "skip";
  readonly reason: string;
}
export type NbfWorthCheckOpOutput =
  | { readonly parsed: true; readonly verdicts: readonly NbfWorthVerdict[] }
  | { readonly parsed: false; readonly unparsedPreview: string };

export function parseNbfWorthReply(output: string, findingCount: number): NbfWorthCheckOpOutput;
export const nbfWorthCheckOp: RunOperation<NbfWorthCheckOpInput, NbfWorthCheckOpOutput, ReviewConfig>;
```

`nbfWorthCheckOp` declares `name: "nbf-worth-check"`, `stage: "review"`, `session: { role: "nbf-worth-check", lifetime: "fresh" }`, `tools: ["Read", "Glob", "Grep"]`. Its `parse` delegates to `parseNbfWorthReply(output, input.findings.length)`. The prompt builder is `buildNbfWorthCheckPrompt(input: NbfWorthCheckOpInput): string` in `src/prompts/builders/nbf-worth-check-builder.ts`, exported from `src/prompts`.

### New modules (US-003 runner, US-004 record): `src/execution/story-orchestrator/nbf-worth-check.ts` and `nbf-worth-check-audit.ts`

US-003 creates the runner without logging or audit. US-004 creates `nbf-worth-check-audit.ts`, exporting `recordNbfWorthCheck(record: NbfWorthCheckRecord): Promise<void>` (it emits the log lines of "Log and audit" and writes the audit file; it never throws), and adds one call to it in `runNbfWorthCheck` after every judged story (including failures).

```typescript
export interface NbfWorthCheckRequest {
  readonly ctx: CallContext;
  readonly findings: readonly Finding[];
  readonly cfg: NbfWorthCheckConfig | undefined;
}
/** Returns the findings that seed NBF. Never throws. */
export async function runNbfWorthCheck(req: NbfWorthCheckRequest): Promise<Finding[]>;
export const _nbfWorthCheckDeps: {
  callOp; resolveEffectiveRef; collectDiff; collectDiffStat; loadPRD; writeAudit; now; costTotal;
};
```

The runner gathers the op input:
- `story` is `ctx.story`.
- `diff` is `truncateDiff(collectDiff(ctx.packageDir, ref, []), collectDiffStat(ctx.packageDir, ref))`, where `ref = resolveEffectiveRef(ctx.packageDir, ctx.story.storyGitRef, storyId)`. It is `""` when `ref` is undefined or `collectDiff` returns `null`.
- `pendingStories` is every PRD story whose `status` is `"pending"`, `"in-progress"` or `"paused"`, excluding the current story. Stories that are `failed`, `blocked`, `regression-failed` or `decomposed` will not deliver as written, so they are not offered as covering a finding. It is `[]` when `ctx.featureDir` is undefined or the PRD cannot be loaded.

When `ctx.story` is undefined the runner returns the findings unchanged and does not call the op.

If any of `resolveEffectiveRef`, `collectDiff` or `collectDiffStat` rejects, `diff` is `""` and the call proceeds. It then calls `_nbfWorthCheckDeps.callOp(ctx, nbfWorthCheckOp, input)` and applies the mode as described in Approach.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `worthCheck` absent, or `mode` is `"off"` | Findings returned unchanged; the op is not called; no log, no audit |
| `callOp` throws | `warn` log "worth-check failed — fixing all findings"; findings returned unchanged; audit written with `parsed: false`, `verdicts: []` and the error message as `unparsedPreview` |
| Reply unparseable (`parsed: false`) | Same `warn` log with the preview as `error`; findings returned unchanged; audit written |
| Reply parsed, some findings have no or invalid entries | Those findings count as `fix` (reply contract rules) |
| `mode` is `"on"` and every verdict is `skip` | Empty list returned; `maybeRunNonBlockingFix` returns without running NBF; `info` log "all advisory findings skipped — NBF not run" |
| `ctx.story` is undefined | Findings returned unchanged; the op is not called |
| `ctx.featureDir` is undefined, or the PRD cannot be loaded | `pendingStories` is `[]`; the call proceeds |
| `ctx.featureName` is undefined | Audit directory segment is `_unknown`; the call proceeds |
| No effective git ref, `collectDiff` returns `null`, or a diff helper rejects | `diff` is `""`; the call proceeds |
| Audit write fails | `warn` log "worth-check audit write failed"; returned findings unchanged |

## Out of Scope

- Laya, Jev or any decision-proxy classifier as the judge or as a shadow judge; a probe found them not ready.
- Routing the judgment through the advisor (`src/advisor/`), its `decisions.jsonl` ledger, its option menus or its heads-up notifications.
- A deterministic severity or category pre-filter on the NBF seed.
- A "defer-to-finish" verdict, carrying skipped findings into `nax finish`, the PR body, or the end-of-run advisory summary.
- Any change to `actionableAdvisoryFindings` or to how `acDropped` findings are treated (the #1801 hold); the worth-check only sees findings that already survived `deriveNbfSeed`.
- Any change to the NBF fix pass itself: its strategies, gates, `sourceDiffCap`, fix review, snapshot and restore.
- A parse retry for the worth-check reply; an unparseable reply falls back to fixing every finding.
- Exact per-story cost attribution when stories run in parallel; `costUsd` is the run-total delta across the call, as in the advisor, and can include other stories' spend.
- Updating the session-role table in `.nax/rules/adapter-wiring.md` for the new role.
- A test that observes `runRectify`'s `initialFindings` or `buildNbfDeps`' `findings` directly; both receive the same local `findings` value whose use as `advisoryFindings` US-005 pins.

## Stories

1. **US-001: worth-check prompt builder, session role and config** — `Workdir: packages/nax` — no dependencies. Adds `buildNbfWorthCheckPrompt`, registers the `nbf-worth-check` session role, and adds `NbfWorthCheckConfigSchema` under `review.nonBlockingFix.worthCheck` with the `NbfWorthCheckConfig` type.
2. **US-002: worth-check op and reply parser** — `Workdir: packages/nax` — depends on US-001. Adds `nbfWorthCheckOp` and `parseNbfWorthReply`, and exports both from the operations barrel.
3. **US-003: worth-check runner** — `Workdir: packages/nax` — depends on US-002. Adds `runNbfWorthCheck`: it gathers the op input, calls the op, applies the mode and falls back to fixing every finding on failure. No logging or audit yet.
4. **US-004: worth-check log and audit** — `Workdir: packages/nax` — depends on US-003. Adds `recordNbfWorthCheck` in `nbf-worth-check-audit.ts` (the log lines and the audit file) and calls it from `runNbfWorthCheck`.
5. **US-005: NBF wiring** — `Workdir: packages/nax` — depends on US-004. Calls `runNbfWorthCheck` from `maybeRunNonBlockingFix` and seeds NBF with its result.

Paths are repo-rooted. Every story is `Workdir: packages/nax`.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/fix-review-builder.ts` — a builder that renders a story and findings
- `packages/nax/src/runtime/session-role.ts` — `CanonicalSessionRole`, `KNOWN_SESSION_ROLES`, `isSessionRole`
- `packages/nax/src/config/schemas-review.ts` — `NonBlockingFixConfigSchema`, `FixReviewConfigSchema`
- `packages/nax/src/findings/types.ts` — `Finding`

**US-002**
- `packages/nax/src/operations/fix-review.ts` — the run-op shape, parse and preview pattern to mirror
- `packages/nax/test/unit/operations/fix-review.test.ts` — op test harness to mirror
- `packages/nax/src/prompts/builders/nbf-worth-check-builder.ts` — created by US-001, consumed here

**US-003**
- `packages/nax/src/advisor/service.ts` — the PRD read to mirror
- `packages/nax/src/review/diff-utils.ts` — diff helpers
- `packages/nax/test/helpers/call-context.ts` — `makeMockCallContext`
- `packages/nax/src/operations/nbf-worth-check.ts` — created by US-002, consumed here

**US-004**
- `packages/nax/src/advisor/audit.ts` — the per-record audit writer to mirror
- `packages/nax/src/advisor/service.ts` — `costTotal`
- `packages/nax/src/execution/story-orchestrator/nbf-worth-check.ts` — created by US-003; US-004 adds the `recordNbfWorthCheck` call

**US-005**
- `packages/nax/src/execution/story-orchestrator/execution-plan-phases.ts` — `maybeRunNonBlockingFix`
- `packages/nax/test/unit/execution/non-blocking-fix-wiring.test.ts` — the `buildPlanForStrategy` harness to mirror
- `packages/nax/src/execution/story-orchestrator/nbf-worth-check.ts` — created by US-003, consumed here

### Creates

**US-001**
- `packages/nax/src/prompts/builders/nbf-worth-check-builder.ts`
- `packages/nax/test/unit/prompts/nbf-worth-check-builder.test.ts`

**US-002**
- `packages/nax/src/operations/nbf-worth-check.ts`
- `packages/nax/test/unit/operations/nbf-worth-check.test.ts`

**US-003**
- `packages/nax/src/execution/story-orchestrator/nbf-worth-check.ts`
- `packages/nax/test/unit/execution/nbf-worth-check-runner.test.ts`

**US-004**
- `packages/nax/src/execution/story-orchestrator/nbf-worth-check-audit.ts`
- `packages/nax/test/unit/execution/nbf-worth-check-audit.test.ts`

**US-005**
- `packages/nax/test/unit/execution/nbf-worth-check-wiring.test.ts`

### Modifies

No existing assertion breaks: `worthCheck` is optional, so existing `NonBlockingFixConfig` literals and the `non-blocking-fix-config` tests stay valid, and with `worthCheck` absent the call site behaves exactly as today. These existing files are edited:

**US-001**
- `packages/nax/src/runtime/session-role.ts` — add `"nbf-worth-check"` to `CanonicalSessionRole` and `KNOWN_SESSION_ROLES`.
- `packages/nax/src/prompts/index.ts` — export `buildNbfWorthCheckPrompt` from the barrel, beside `buildFixReviewPrompt`.
- `packages/nax/src/config/schemas-review.ts` — add `NbfWorthCheckConfigSchema` and the optional `worthCheck` field on `NonBlockingFixConfigSchema`.
- `packages/nax/src/config/selectors.ts` — add `export type NbfWorthCheckConfig` beside `NonBlockingFixConfig`.
- `packages/nax/test/unit/config/non-blocking-fix-config.test.ts` — append the `worthCheck` schema cases (the module's existing schema test file); no existing case changes.

**US-002**
- `packages/nax/src/operations/index.ts` — export `nbfWorthCheckOp`, `parseNbfWorthReply` and the op's types from the barrel, beside `fixReviewOp`.

**US-005**
- `packages/nax/src/execution/story-orchestrator/execution-plan-phases.ts` — call `runNbfWorthCheck` in `maybeRunNonBlockingFix` and pass its result at the three `seed.findings` uses.

### Seams

- US-001 → US-002: `buildNbfWorthCheckPrompt` is consumed by `nbfWorthCheckOp.build`. Seam AC in US-002 asserts the op's task content equals the builder's output for the same input.
- US-002 → US-003: `nbfWorthCheckOp` is consumed by `runNbfWorthCheck`. Seam AC in US-003 asserts `_nbfWorthCheckDeps.callOp` is called with `nbfWorthCheckOp`.
- US-004 → US-003's runner: `recordNbfWorthCheck` is called by `runNbfWorthCheck`. Seam ACs in US-004 enter at `runNbfWorthCheck` and assert on the captured logs and on `_nbfWorthCheckAuditDeps.write`.
- US-003 → US-005: `runNbfWorthCheck` is consumed by `maybeRunNonBlockingFix`, which is internal (not exported). Seam ACs in US-005 enter where `test/unit/execution/non-blocking-fix-wiring.test.ts` already enters: `buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs)` from `@/execution`, then `plan.run()`.

## Acceptance Criteria

Fixtures used below:
- Finding A is `{ source: "adversarial-review", severity: "warning", category: "input", file: "src/a.ts", line: 12, message: "empty items still fires MARK_DELIVERING" }`.
- Finding B is `{ source: "adversarial-review", severity: "info", category: "convention", file: "src/b.ts", line: 3, message: "stale header comment" }`.
- Story S is `makeStory({ id: "US-002", title: "Deliver orders", description: "d", acceptanceCriteria: ["AC one"], status: "in-progress", attempts: 1 })` (`makeStory` from `@test/helpers` fills the remaining required `UserStory` fields).
- "The base input" is `{ story: S, diff: "+x", findings: [A, B], pendingStories: [] }`.
- Logs are captured with `resetLogger(); initLogger({ level: "info", headless: true, useChalk: false }); addSink(entry => ...)`.
- "Verdicts A-fix, B-skip" means an op output `{ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "r1" }, { index: 2, verdict: "skip", reason: "nit" }] }`. "All-skip" means both entries are `skip` with reason `"nit"`.

Runner context (US-003, US-004): `ctx = makeMockCallContext({ runtime, story: S, storyId: "US-002", featureName: "f", featureDir: "/repo/.nax/features/f" })`, whose `packageDir` is `"/tmp/test"`. `_nbfWorthCheckDeps` is stubbed:
- `resolveEffectiveRef` resolves `"ref1"`, `collectDiff` resolves `"+x"`, `collectDiffStat` resolves `""`;
- `loadPRD` resolves a PRD whose stories are S, `{ id: "US-001", status: "passed" }`, `{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"], status: "pending" }`, `{ id: "US-004", title: "Old", acceptanceCriteria: ["x"], status: "failed" }` and `{ id: "US-005", title: "Parent", acceptanceCriteria: ["y"], status: "decomposed" }`;
- `callOp` resolves verdicts A-fix, B-skip unless the AC says otherwise.
In US-004, `_nbfWorthCheckAuditDeps` is also stubbed: `write` resolves, `now` returns `1000`, `costTotal` returns `0`.

### US-001: worth-check prompt builder, session role and config

1. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `1. [warning/input] src/a.ts:12 — empty items still fires MARK_DELIVERING`.
2. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `2. [info/convention] src/b.ts:3 — stale header comment`.
3. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `US-002: Deliver orders`.
4. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `- AC one`.
5. [unit] `buildNbfWorthCheckPrompt` given the base input returns text in which `"+x"` appears after the line `## Story diff`.
6. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that does not include `## Pending stories in this feature`.
7. [unit] `buildNbfWorthCheckPrompt` given the base input with `pendingStories` `[{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] }]` returns text that includes the line `US-003: Retry delivery`.
8. [unit] `buildNbfWorthCheckPrompt` given the same pending story returns text in which the line `- retries twice` appears after the line `## Pending stories in this feature`.
9. [unit] `buildNbfWorthCheckPrompt` given the base input with `diff` `""` returns text that includes the line `(diff unavailable — judge from the code)`.
10. [unit] `buildNbfWorthCheckPrompt` given findings `[{ ...A, line: undefined }]` returns text that includes the line `1. [warning/input] src/a.ts — empty items still fires MARK_DELIVERING`.
11. [unit] `buildNbfWorthCheckPrompt` given findings `[{ ...A, file: undefined, line: undefined }]` returns text that includes the line `1. [warning/input] (no file) — empty items still fires MARK_DELIVERING`.
12. [unit] `buildNbfWorthCheckPrompt` given findings `[{ ...A, suggestion: "use parser.error" }]` returns text that includes the line `   Suggested fix: use parser.error`.
13. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `When you are unsure, answer "fix".`.
14. [unit] `buildNbfWorthCheckPrompt` given the base input returns text that includes the line `{"verdicts":[{"index":1,"verdict":"fix","reason":"<one line>"}]}`.
15. [unit] `buildNbfWorthCheckPrompt` given the base input returns text in which `## Story`, `## Story diff`, `## Findings`, `## How to judge` and `## Reply` appear in that order.
16. [unit] `isSessionRole("nbf-worth-check")` returns `true`.
17. [unit] `NonBlockingFixConfigSchema.parse({})` yields an object whose `worthCheck` is `undefined`.
18. [unit] `NonBlockingFixConfigSchema.parse({ worthCheck: {} }).worthCheck` equals `{ mode: "off", timeoutMs: 300000 }`.
19. [unit] `NonBlockingFixConfigSchema.safeParse({ worthCheck: { mode: "maybe" } })` returns `success: false`.

### US-002: worth-check op and reply parser

Op resolver ACs build `ctx.config` with `makeNaxConfig({ review: { nonBlockingFix: <as stated> } })`.

1. [unit] `parseNbfWorthReply('{"verdicts":[{"index":2,"verdict":"skip","reason":"stale comment"},{"index":1,"verdict":"fix","reason":"reachable"}]}', 2)` returns `{ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "reachable" }, { index: 2, verdict: "skip", reason: "stale comment" }] }`.
2. [unit] `parseNbfWorthReply('{"verdicts":[{"index":5,"verdict":"skip","reason":"r"}]}', 2)` returns verdicts `[{ index: 1, verdict: "fix", reason: "(no verdict returned)" }, { index: 2, verdict: "fix", reason: "(no verdict returned)" }]`.
3. [unit] `parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"skip","reason":"nit"},{"index":1,"verdict":"fix","reason":"r"}]}', 1)` returns verdicts `[{ index: 1, verdict: "skip", reason: "nit" }]`.
4. [unit] `parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"},{"index":1,"verdict":"skip","reason":"nit"}]}', 1)` returns verdicts `[{ index: 1, verdict: "fix", reason: "(invalid verdict)" }]` (the first entry is chosen before validation).
5. [unit] `parseNbfWorthReply('{"verdicts":["skip",{"index":1,"verdict":"skip","reason":"nit"}]}', 1)` returns verdicts `[{ index: 1, verdict: "skip", reason: "nit" }]` (a non-object entry is ignored).
6. [unit] `parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"skip","reason":"  "}]}', 1)` returns verdicts `[{ index: 1, verdict: "fix", reason: "(skip without reason)" }]`.
7. [unit] `parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"}]}', 1)` returns verdicts `[{ index: 1, verdict: "fix", reason: "(invalid verdict)" }]`.
8. [unit] `parseNbfWorthReply("no json here", 1)` returns an output whose `parsed` is `false` and whose `unparsedPreview` is a non-empty string.
9. [unit] `parseNbfWorthReply("", 1)` returns `{ parsed: false, unparsedPreview: "(empty response)" }`.
10. [unit] `parseNbfWorthReply('{"result":"ok"}', 1)` returns an output whose `parsed` is `false`.
11. [unit] `parseNbfWorthReply('[{"index":1,"verdict":"skip","reason":"r"}]', 1)` (a JSON array, not an object) returns an output whose `parsed` is `false`.
12. [unit] `nbfWorthCheckOp.session` equals `{ role: "nbf-worth-check", lifetime: "fresh" }`.
13. [unit] `nbfWorthCheckOp.tools` equals `["Read", "Glob", "Grep"]`.
14. [unit] `nbfWorthCheckOp.model` for `nonBlockingFix` `{ worthCheck: { mode: "on" } }` returns `"balanced"`.
15. [unit] `nbfWorthCheckOp.model` for `nonBlockingFix` `{ worthCheck: { mode: "on", model: "powerful" } }` returns `"powerful"`.
16. [unit] `nbfWorthCheckOp.timeoutMs` for `nonBlockingFix` `{ worthCheck: { mode: "on", timeoutMs: 120000 } }` returns `120000`.
17. [unit] `nbfWorthCheckOp.timeoutMs` for a config with no `review.nonBlockingFix` returns `300000`.
18. [unit] `nbfWorthCheckOp.parse('{"verdicts":[{"index":1,"verdict":"fix","reason":"reachable"}]}', baseInput, ctx)` returns verdicts `[{ index: 1, verdict: "fix", reason: "reachable" }, { index: 2, verdict: "fix", reason: "(no verdict returned)" }]`, the count of 2 coming from the base input's findings.
19. [unit] `nbfWorthCheckOp.build(baseInput, ctx).task.content` equals `buildNbfWorthCheckPrompt(baseInput)`.

### US-003: worth-check runner

1. [unit] `runNbfWorthCheck` with `cfg` `undefined` and findings `[A, B]` resolves `[A, B]` without calling `_nbfWorthCheckDeps.callOp`.
2. [unit] `runNbfWorthCheck` with `cfg` `{ mode: "off", timeoutMs: 300000 }` and findings `[A, B]` resolves `[A, B]` without calling `_nbfWorthCheckDeps.callOp`.
3. [unit] `runNbfWorthCheck` with `cfg.mode` `"on"` and findings `[A, B]` calls `_nbfWorthCheckDeps.callOp` with `nbfWorthCheckOp` as its op.
4. [unit] `runNbfWorthCheck` with `cfg.mode` `"on"` and findings `[A, B]` resolves `[A]`.
5. [unit] `runNbfWorthCheck` with `cfg.mode` `"on"`, findings `[A, B]` and `callOp` resolving all-skip resolves `[]`.
6. [unit] `runNbfWorthCheck` with `cfg.mode` `"shadow"` and findings `[A, B]` resolves `[A, B]`.
7. [unit] `runNbfWorthCheck` with `cfg.mode` `"on"` and `callOp` rejecting with an error resolves `[A, B]`.
8. [unit] `runNbfWorthCheck` with `cfg.mode` `"on"` and `callOp` resolving `{ parsed: false, unparsedPreview: "junk" }` resolves `[A, B]`.
9. [unit] With `cfg.mode` `"on"`, `callOp` receives an input whose `pendingStories` is `[{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] }]` (the current story and the `passed`, `failed` and `decomposed` stories are excluded).
10. [unit] With `cfg.mode` `"on"` and `loadPRD` rejecting, `callOp` receives an input whose `pendingStories` is `[]`.
11. [unit] With `cfg.mode` `"on"` and `featureDir` absent from `ctx`, `runNbfWorthCheck` never calls `loadPRD`.
12. [unit] With `cfg.mode` `"on"`, `callOp` receives an input whose `diff` is `"+x"`.
13. [unit] With `cfg.mode` `"on"` and `resolveEffectiveRef` resolving `undefined`, `callOp` receives an input whose `diff` is `""`.
14. [unit] With `cfg.mode` `"on"` and `collectDiff` rejecting with an error, `callOp` receives an input whose `diff` is `""`.
15. [unit] With `cfg.mode` `"on"` and `story` absent from `ctx`, `runNbfWorthCheck` resolves `[A, B]` without calling `_nbfWorthCheckDeps.callOp`.

### US-004: worth-check log and audit

Each AC calls `runNbfWorthCheck` with the runner context and findings `[A, B]`.

1. [integration] With `cfg.mode` `"on"`, the captured `info` entry with stage `"nbf-worth-check"` and message `"worth-check verdicts"` has data whose first two keys are `storyId` (`"US-002"`) and `packageDir` (`"/tmp/test"`).
2. [integration] With `cfg.mode` `"on"`, that entry's data has `fix` `1` and `skip` `1`.
3. [integration] With `cfg.mode` `"on"`, that entry's data has `skipped` `[{ file: "src/b.ts", line: 3, reason: "nit" }]`.
4. [integration] With `cfg.mode` `"on"` and `callOp` resolving all-skip, an `info` entry with message `"all advisory findings skipped — NBF not run"` and data `skip` `2` is captured.
5. [integration] With `cfg.mode` `"on"` and `callOp` rejecting with an error whose message is `"boom"`, a `warn` entry with message `"worth-check failed — fixing all findings"` and data `error` `"boom"` is captured.
6. [integration] With `cfg.mode` `"on"` and `callOp` resolving `{ parsed: false, unparsedPreview: "junk" }`, a `warn` entry with message `"worth-check failed — fixing all findings"` and data `error` `"junk"` is captured.
7. [integration] With `cfg.mode` `"on"`, `_nbfWorthCheckAuditDeps.write` is called once with the path `<runtime.outputDir>/nbf-worth-check/f/US-002-1000.json`.
8. [integration] With `cfg.mode` `"on"` and `costTotal` returning `0` then `0.02`, the record passed to `_nbfWorthCheckAuditDeps.write` has `costUsd` `0.02`.
9. [integration] With `cfg.mode` `"on"` and `callOp` rejecting with an error whose message is `"boom"`, the record passed to `_nbfWorthCheckAuditDeps.write` has `parsed` `false`, `verdicts` `[]` and `unparsedPreview` `"boom"`.
10. [integration] With `cfg.mode` `"shadow"`, the record passed to `_nbfWorthCheckAuditDeps.write` has `mode` `"shadow"` and two `verdicts`.
11. [integration] With `cfg.mode` `"off"`, `_nbfWorthCheckAuditDeps.write` is never called.
12. [integration] With `cfg.mode` `"on"` and `_nbfWorthCheckAuditDeps.write` rejecting, `runNbfWorthCheck` resolves `[A]`.
13. [integration] With `cfg.mode` `"on"` and `_nbfWorthCheckAuditDeps.write` rejecting, a `warn` entry with message `"worth-check audit write failed"` is captured.

### US-005: NBF wiring

Each AC drives the internal `maybeRunNonBlockingFix` the way `test/unit/execution/non-blocking-fix-wiring.test.ts` does: `buildPlanForStrategy(ctx, S, config, "three-session-tdd", inputs)` from `@/execution`, then `plan.run()`, with the `_storyOrchestratorDeps` stubs that file uses to make the story green, the adversarial review stub overridden to return advisory findings `[A, B]`. `ctx` and the `_nbfWorthCheckDeps` / `_nbfWorthCheckAuditDeps` stubs are those of the runner context, so no git command runs and no audit file is written. `_storyOrchestratorDeps.runNonBlockingFix` is spied. `nonBlockingFix` is the literal that file uses plus `worthCheck: <as stated>`.

1. [integration] With `worthCheck` `{ mode: "on" }` and `callOp` resolving verdicts A-fix, B-skip, `plan.run()` calls `_storyOrchestratorDeps.runNonBlockingFix` once with `advisoryFindings` `[A]`.
2. [integration] With `worthCheck` `{ mode: "on" }` and `callOp` resolving all-skip, `plan.run()` never calls `_storyOrchestratorDeps.runNonBlockingFix`.
3. [integration] With `worthCheck` `{ mode: "on" }` and `callOp` resolving all-skip, an `info` entry with message `"all advisory findings skipped — NBF not run"` is captured during `plan.run()`.
4. [integration] With `worthCheck` `{ mode: "shadow" }` and `callOp` resolving all-skip, `plan.run()` calls `_storyOrchestratorDeps.runNonBlockingFix` with `advisoryFindings` `[A, B]`.
5. [integration] With no `worthCheck` key, `plan.run()` calls `_storyOrchestratorDeps.runNonBlockingFix` with `advisoryFindings` `[A, B]`.
6. [integration] With no `worthCheck` key, `plan.run()` never calls `_nbfWorthCheckDeps.callOp`.
7. [integration] With `worthCheck` `{ mode: "on" }` and rectification exhausted (the story is not green, as in that file's "not green" case), `plan.run()` never calls `_nbfWorthCheckDeps.callOp`.
