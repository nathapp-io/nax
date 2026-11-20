# SPEC: bot fix follow-ups: lineage facts, advisor item text, --model failures, incomplete-review signals

Closes: #2998, #2999, #3000

## Summary

Four independent fixes to `nax bot`, each found while running the bot on PRs on 2026-11-20:

1. **Lineage fact (#2998, parts 1 and 3).** The fix prompt states one `Lineage:` line per finding instead of one per parent item. When a push fixed two or more items, the items it was for are listed once per push in the facts section, not once per finding.
2. **Advisor item text (#2998, part 2).** An advisor open item's issue text names the decision itself (its ruling title or action) instead of the placeholder `see nax advisor list`. The push ledger and the lineage fact then say what the push was for.
3. **`--model` failures (#2999).** A `--model` value that cannot resolve is refused before the bot creates a runtime, opens the run log or runs any pre-run step (US-003). A fix session that failed and changed nothing ends `fix-failed` instead of `no-change`, and the failure is printed and logged (US-005).
4. **Incomplete-review signals (#3000).** Each incomplete review posts its own signal, keyed by head and review id. A complete review's clear can then only retire signals it read before it started.

## Motivation

- **#2998.** On v0.92.9, a fix push that closed 8 advisor items (D-1..D-8) gave the next fix prompt 32 `Lineage:` lines for 4 findings. Each finding had 8 lines that differed only in the parent id, and each line said the push was "for" the placeholder `advisor decision D-n needs a human: see nax advisor list`. The fixer could not tell what any of its earlier changes was for, which is the fact #2987 relies on to stop fix-induced chains.
- **#2999.** `nax bot fix 2997 --model "openai-codex/gpt-6.1-sol[high]"` printed `no-change` and exited 2. The fix session had never run: `"No model entry found for agent \"native\" ... at tier \"openai-codex/gpt-6.1-sol[high]\""` was recorded only as `fixFailure` in `bot-state.json`. `bot.jsonl` had no warning, and install and build had already run. `no-change` normally means "the fixer looked and had nothing to do", so a script or agent cannot tell the two cases apart.
- **#3000.** Incomplete-review signals are one comment per head (`w-carry-incomplete:<sha>`). Two overlapping reviews on one PR can lose a blocker. Run X (incomplete) sees the signal already pending and skips its write. Run Y (complete) then clears that signal from its startup snapshot, and the next worker trusts a carry record that never held X's blocker.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax/src/bot/push-ledger.ts`: `BotPushEntry { base; sha; at; items: BotPushItem[] }`, `BotPushItem { key; generation; issue; raisedBy? }`, `FindingLineage { generation; parents: readonly string[]; pushSha }`, and `parentIssue(pushSha, parent, entries): string | undefined`.
- `packages/nax/src/bot/render-comments.ts`: `lineageLine(lineage)`, the inline-comment form (one line, parents joined with `, `). Unchanged.
- `packages/nax/src/advisor/types.ts`: `AdviceDecision` (`id`, `rulingTitle?`, `action`, `rationale`, `needsHumanConfirm`).
- `packages/nax/src/advisor/ledger.ts`: `readTrustedDecisions(repoRoot, feature, outputDir): Promise<AdviceDecision[]>`.
- `packages/nax/src/config/schema-types.ts`: `resolveConfiguredModel(models, preferredAgent, selection, defaultAgent)`. It throws `NaxError` code `MODEL_NOT_FOUND` for a string selection that is no tier of the agent or the default agent. For an `{ agent, model }` selection that is not a tier, it only warns and dispatches the model as a literal.
- `packages/nax/src/agents`: `resolveDefaultAgent(config)`.
- `packages/nax/src/forge/marker-grammar.ts`: marker keys match `[A-Za-z0-9._:-]{1,128}`. `w-carry-incomplete:` (19) + a 40-character SHA + `:` + a 36-character UUID is 96 characters.
- `packages/nax/src/bot/post.ts`: `reviewId = crypto.randomUUID()`, passed to `postCarriedRecord` as `review.id`.
- `packages/nax/src/bot/review-run.ts`: `advance()` calls `clearCarryWidens(env.post)`. `env.post.own` is the bot's own comments as read when the review started.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `findingFactLines` (`packages/nax/src/bot/fix-facts.ts`).
  - Baseline: one `Lineage:` line per entry of `lineage.parents`, each `Lineage: generation N, on lines added by nax bot fix <sha7> for <parent>` plus ` (<issue>)` when `parentIssue` finds one.
  - Target: exactly one `Lineage:` line per finding, `Lineage: generation N, on lines added by nax bot fix <sha7> for <p1>, <p2>, ...` (parents in `lineage.parents` order, joined by `, `). The ` (<issue>)` suffix is appended only when `lineage.parents` has exactly one entry and `parentIssue` finds its issue.
- New export `lineagePushFacts(agreed, entries)` in `packages/nax/src/bot/fix-facts.ts`. It returns `readonly LineagePushFact[]`, where `LineagePushFact = { readonly sha: string; readonly items: readonly { readonly key: string; readonly issue?: string }[] }` and `sha` is the 7-character short SHA. Rules:
  - There is one entry per distinct `pushSha` named by the lineage of an agreed `finding` item whose `lineage.parents` has two or more entries, in the order the agreed items first name it.
  - Its `items` are the union of the parents of the multi-parent lineages that name that push, deduplicated, in first-seen order. A single-parent lineage naming the same push adds nothing, because its parent's issue is already on its own `Lineage:` line. Each item carries `issue` when `parentIssue(pushSha, key, entries)` returns one.
  - A push the ledger no longer holds still gets its entry, with keys only and no `issue`.
  - A push named only by single-parent lineages gets no entry, because its issue is already on the `Lineage:` line.
- `fixPromptFacts` (`packages/nax/src/bot/fix-steps.ts`).
  - Baseline: returns `{ findingFacts, outsideGrowth? }`.
  - Target: also returns `lineagePushes`, the result of `lineagePushFacts(env.review.agreed, entries)` over the same `entries` (`ownLedgerEntries(env.own)`), when non-empty.
- `BotPrFixPromptInput` (`packages/nax/src/prompts/builders/bot-pr-fix-builder.ts`). It gains an optional `lineagePushes?: readonly { readonly sha: string; readonly items: readonly { readonly key: string; readonly issue?: string }[] }[]`. `factsSection` renders each entry after the per-finding blocks and before the growth line:
  - the line `Earlier nax bot fix push <sha> was for:`;
  - then one line per item, `<FACT_INDENT>- <key>: <issue>`, or `<FACT_INDENT>- <key>` when there is no issue.
  The section is rendered when any of the three parts is present.
- New export `advisorDecisionSummary(d: AdviceDecision): string` in `packages/nax/src/finish/pr/body.ts`. It returns `flat(d.rulingTitle)` when that result is a non-empty string after trimming. Otherwise (no `rulingTitle`, or one that is empty after `flat`) it returns the same text `buildAdvisorSection` already uses for the decision's detail (`carry → <stories> — <instruction>`, `answer — <text>`, or `<action type> — <rationale>`), extracted into one function both callers use. Both forms are one line. `buildAdvisorSection`'s output is unchanged. `advisorDecisionSummary` is re-exported from `src/finish/pr/index.ts` and `src/finish/index.ts`, and `feature-env.ts` imports it from `@/finish`.
- `FeatureSteps.flaggedDecisions` (`packages/nax/src/workflow/feature-machine.ts`).
  - Baseline: `flaggedDecisions?(): Promise<readonly string[]>`.
  - Target: `flaggedDecisions?(): Promise<readonly FlaggedDecision[]>`, with `FlaggedDecision = { readonly id: string; readonly summary: string }` exported from `packages/nax/src/workflow/types.ts`. `buildFeatureEnv` (`feature-env.ts`) maps each trusted decision with `needsHumanConfirm === true` to `{ id: d.id, summary: advisorDecisionSummary(d) }`.
- `WorkflowFeatureRecord` (`packages/nax/src/workflow/types.ts`).
  - Baseline: `flaggedDecisions?: readonly string[]`.
  - Target: `flaggedDecisions` is unchanged (ids, ledger order). The record gains `flaggedDecisionSummaries?: Readonly<Record<string, string>>` (decision id to summary).
  - `collectFlaggedDecisions` (`feature-steps.ts`) returns `readonly FlaggedDecision[]` (empty on a missing step or a thrown read, as today). `publishStep` splits that one list in one place into `ids` and `summaries` (`Object.fromEntries` of id to summary). It uses both in the two places that carry the record today: the record passed to `postItemThreadsAfterPublish` (`{ ...rec, flaggedDecisions: ids, flaggedDecisionSummaries: summaries }`), and the publish patch. The patch writes `flaggedDecisionSummaries` only when `ids` is non-empty, and `flaggedDecisions` under its existing rule.
  - The `publish` node in `FEATURE_GRAPH` (`packages/nax/src/workflow/feature-graph.ts`) adds `"flaggedDecisionSummaries"` to its `produces`. `runStepGraph` refuses a patch key the node does not declare (`STEP_GRAPH_UNDECLARED_OUTPUT`, `src/step-graph/run.ts`).
  - `feature-steps.ts` is at 572 of its 600-line limit. If the split pushes it over, move `collectFlaggedDecisions` and the split into a new `packages/nax/src/workflow/flagged-decisions.ts`.
- `advisorItems` (`packages/nax/src/workflow/open-items.ts`).
  - Baseline: a flagged id's issue is `advisor decision ${id} needs a human: see nax advisor list`.
  - Target: when `rec.flaggedDecisionSummaries?.[id]` is a non-empty string, the issue is `advisor decision ${id} needs a human: ${summary}`. Otherwise it keeps the baseline text, so records written before this feature are unchanged. The held finish-approval item is unchanged.
- New export `checkBotModelOverride(config: NaxConfig, model: ConfiguredModel | undefined): string | undefined` in `packages/nax/src/bot/models.ts`. It is exported from `src/bot/index.ts`. It returns `undefined` when `model` is `undefined` or `resolveConfiguredModel(config.models ?? DEFAULT_CONFIG.models, resolveDefaultAgent(config), model, resolveDefaultAgent(config))` returns (the same models fallback the op dispatch prologue uses, `src/operations/call-dispatch-prologue.ts`). When that call throws, it returns a refusal reason, built in this order:
  1. `invalid --model "<value>": <error message>`, where `<value>` is a string model as given, or `agent:model` for an object;
  2. `; accepted forms: <tier> or <agent>:<model>`;
  3. `; configured tiers: <comma-separated keys of the effective models[defaultAgent]>`, or `; configured tiers: none` when that agent has no entry;
  4. only when the value is a string containing `/` and no `:`, `; a provider/model id needs its agent prefix, for example <defaultAgent>:<value>`.
- `runBotFix` / `fixCheckout` (`packages/nax/src/bot/fix-run.ts`) and `runBotReview` / `reviewCheckout` (`packages/nax/src/bot/review-run.ts`). Right after `deps.loadBotConfig(...)` resolves, and before `deps.createRuntime`, each calls `checkBotModelOverride(config, input.model)`. A defined reason returns `{ outcome: "refused", reason }` at once. Review checks the loaded config before `reviewConfig` rewrites it. The check runs for `nax bot fix --ready-only` too: a `--model` that cannot resolve is a usage error whether or not a session would use it.
- `BotFixState.outcome` (`packages/nax/src/bot/fix-steps.ts`). It gains `"fix-failed"`. `checkStep`:
  - Target: when `changed.length === 0` and `state.fixFailure` is a non-empty string, it returns `{ patch: { changed, outcome: "fix-failed" }, exit: "fix-failed" }` and logs `getLogger()?.warn("bot-fix", "Fix session failed", { storyId: "_bot", pr: env.info.number, failure: state.fixFailure })`. With `changed.length === 0` and no `fixFailure`, it still returns `no-change`. With changes, `fixFailure` does not alter the path.
  - `check` reads the failure of the latest session only. `repairStep` (`packages/nax/src/bot/repair-step.ts`) states `fixFailure: undefined` in its patch when its session reports no failure (the `repair` node already declares `fixFailure` in `produces`), so a first session's failure does not survive a repair session that ran cleanly.
  - The `check` node in `BOT_FIX_GRAPH` (`fix-run.ts`) lists `"fix-failed"` in `exits`. The node's default transition already routes it to `report`.
- `outcomeText` (`packages/nax/src/bot/fix-outcome-text.ts`) gains `case "fix-failed": return "The fix session failed before changing anything; nothing pushed."`. The summary's existing `Fix session: <failure>` line (`fix-summary.ts`) carries the cause.
- `botFixCommand` (`packages/nax/src/cli/bot.ts`). For a non-success outcome it still returns exit code 2. For `outcome === "fix-failed"` with a `fixFailure`, `deps.logErr` receives `fix-failed: <first line of fixFailure>` instead of the bare outcome, the first line truncated to `MAX_FIX_FAILURE_STDERR_CHARS` (300) characters. The `bot.jsonl` warn carries the full text as a JSON field.
- `carried-record.ts` (`packages/nax/src/bot/carried-record.ts`).
  - Baseline: `carryWidenKey(headSha)` returns `w-carry-incomplete:<headSha>`, and `carryWidenComment(own, headSha)` finds the one signal per head.
  - Target:
    - New export `carryWidenReviewKey(headSha: string, reviewId: string): string` returns `w-carry-incomplete:<headSha>:<reviewId>`.
    - `carryWidenKey` stays, and is still recognised as a legacy key.
    - `pendingCarryWidenComments` keeps its `startsWith("w-carry-incomplete:")` rule, so legacy and per-review signals both count as pending.
    - `carryWidenComment` is deleted once nothing calls it (build gate).
- `CARRIED_RECORD_KEY` (`packages/nax/src/forge/marker-grammar.ts`).
  - Baseline: `/^w-carry(?:-incomplete)?:[0-9a-f]{40}$/`. `isTopLevelMarkerKey` uses it, and `isRepliedTopLevelNote` (`src/forge/threads.ts`) uses that to keep a replied GitLab note top-level. A per-review key would fail it, so a replied per-review signal would gain a `threadId`, and `pendingCarryWidenComments` (which requires `threadId === undefined`) would not see it.
  - Target: `/^w-carry(?:-incomplete:[0-9a-f]{40}(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?|:[0-9a-f]{40})$/` (the review id is a lowercase `crypto.randomUUID()`). The carried record key (`w-carry:<sha>`) and the legacy signal key stay valid, and the per-review signal key becomes valid. A review-id suffix on `w-carry:<sha>` stays invalid.
- `writeCarryWiden` (`packages/nax/src/bot/post-carried.ts`).
  - Baseline: one signal per head. It skips the write when that head's signal is already pending, otherwise edits or posts it.
  - Target: a pending write always posts a new comment keyed `carryWidenReviewKey(input.info.headSha, review.id)`, whatever signals already exist. `postCarriedRecord` passes `review.id` through. `clearCarryWidens` is unchanged: it edits only the pending comments in `input.own`, the snapshot read when the review started.

### Approach

This bundle has one implementation per item. There are no alternatives to choose between.

### CLI Behavior

`nax bot fix <pr> --model <bad>` and `nax bot review <pr> --model <bad>`:

- **stderr:** the refusal reason, for example `invalid --model "openai-codex/gpt-6.1-sol[high]": No model entry found for agent "native" or default agent "native" at tier "openai-codex/gpt-6.1-sol[high]"; accepted forms: <tier> or <agent>:<model>; configured tiers: fast, balanced, powerful; a provider/model id needs its agent prefix, for example native:openai-codex/gpt-6.1-sol[high]`.
- **Exit code:** 2 for `bot fix`. For `bot review`, the code its existing refused path already returns.
- **Side effects:** no install or build, and no run log. The checkout is still created and disposed, because the model can only be checked against the config read from the checkout's base snapshot.

`nax bot fix` whose fix session fails and changes nothing:

- **stderr:** `fix-failed: <first line of the failure, at most 300 characters>`.
- **stdout:** `nax bot fix: log <path>`.
- **Exit code:** 2.
- **Side effects:** `bot.jsonl` holds a `warn` line `Fix session failed`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `--model` names no tier and is not `agent:model` | refused before runtime creation; reason as in CLI Behavior |
| `--model` is `agent:model` naming an unknown model id | accepted: `resolveConfiguredModel` only warns for a literal, so it dispatches as today |
| fix session fails after editing files | unchanged path: `check` sees changes and the gates decide; `fixFailure` stays in the state and the summary |
| a flagged decision id has no summary in the record (older record) | the advisor item keeps the `see nax advisor list` text |
| a PR first published before this change is re-published after it | each flagged advisor item's issue text changes, so `itemKey` (which hashes kind and issue) changes once. The thread step posts a new thread under the new key and the index lists only new keys, as it already does for any item whose text changed. The old thread stays on the PR outside the index, and a ruling on it does not carry to the new thread. A decision's ledger entry is immutable, so later re-publishes keep the same key |
| the incomplete-review signal post fails | logged at warn and `postCarriedRecord` returns `false`, as today; the head is held |
| a legacy `w-carry-incomplete:<sha>` signal is pending | still read as pending, and still cleared by a complete full review that read it |

## Out of Scope

- Narrowing a lineage to the one parent item whose lines a finding sits on. The push ledger records no per-item file list, and blame gives the push, not the item (#2998, part 3).
- The inline-comment `Lineage:` line in `packages/nax/src/bot/render-comments.ts`. It is already one line with the parents joined, and its text is unchanged.
- Migrating advisor item threads or push ledgers already posted on open PRs. A PR re-published after this change gets new advisor threads once (Failure Handling); carrying a ruling from the old thread to the new one is not done.
- The `## Advisor decisions` section of the workflow PR body (`buildAdvisorSection`). Its output is unchanged.
- Validating `--model` at command-line parse time, before the PR checkout. The tiers come from the config read from the checkout's base snapshot, so the check runs right after that config loads.
- A `fix-failed` outcome when the failed fix session left edits behind. Gates still decide that case.
- Migrating or deleting legacy `w-carry-incomplete:<sha>` comments. They stay readable and clearable.
- Capping or deleting per-review signal comments. Each incomplete review posts one comment; a complete full review that read them edits each to the cleared text, and none is deleted.
- Coordinating two overlapping complete reviews on one PR. Each clears only the signals it read at start.
- Finding provenance for bot fix agents and routing fix-induced chains to the advisor (#2987).
- US-005 only: the `nax chat` bot tools' display of the new `fix-failed` outcome. They report the outcome string they receive.

## Stories

**US-001: one `Lineage:` line per finding, and push items listed once (#2998).** Workdir: `packages/nax`. No dependencies. `findingFactLines` writes one `Lineage:` line per finding. The new `lineagePushFacts` lists the items of each push that a multi-parent lineage names. `fixPromptFacts` passes them to the fix prompt, and `bot-pr-fix-builder.ts` renders them once in the facts section.

**US-002: advisor open items name the decision (#2998).** Workdir: `packages/nax`. No dependencies. Adds `advisorDecisionSummary`. `flaggedDecisions` returns `{ id, summary }` pairs. `publishStep` records `flaggedDecisionSummaries`, and `advisorItems` uses the summary in the item's issue.

**US-003: refuse an unresolvable `--model` (#2999).** Workdir: `packages/nax`. No dependencies. Adds `checkBotModelOverride`, exported from `src/bot/index.ts`, and calls it from `runBotFix` and `runBotReview` right after the bot config loads, before the runtime is created.

**US-004: one incomplete-review signal per review (#3000).** Workdir: `packages/nax`. No dependencies. Adds `carryWidenReviewKey`. `writeCarryWiden` always posts a new signal keyed by head and review id, and `carryWidenComment` is deleted. `CARRIED_RECORD_KEY` accepts the per-review key so a replied GitLab signal stays top-level.

**US-005: a failed fix session that changed nothing ends `fix-failed` (#2999).** Workdir: `packages/nax`. No dependencies. Adds the `fix-failed` outcome to `BotFixState`, `checkStep` and the `check` node's exits, `outcomeText`, and `botFixCommand`'s stderr line.

### Context Files

**US-001**
- `packages/nax/src/bot/fix-facts.ts` — `findingFactLines`, `lineageLine`, `lineageLines`
- `packages/nax/src/bot/push-ledger.ts` — `BotPushEntry`, `FindingLineage`, `parentIssue`
- `packages/nax/src/bot/fix-steps.ts` — `fixPromptFacts`, `ownLedgerEntries` use
- `packages/nax/src/prompts/builders/bot-pr-fix-builder.ts` — `BotPrFixPromptInput`, `factBlocks`, `factsSection`, `FACT_INDENT`
- `packages/nax/test/unit/bot/fix-facts.test.ts` — the `finding` and `entry` fixtures

**US-002**
- `packages/nax/src/finish/pr/body.ts` — `buildAdvisorSection`, `flat`
- `packages/nax/src/workflow/feature-graph.ts` — the `publish` node's `produces`
- `packages/nax/src/workflow/feature-env.ts` — the `flaggedDecisions` step
- `packages/nax/src/workflow/feature-steps.ts` — `collectFlaggedDecisions`, `publishStep`
- `packages/nax/src/workflow/open-items.ts` — `advisorItems`
- `packages/nax/test/unit/workflow/feature-flagged-decisions.test.ts` — the step and publish fixtures

**US-003**
- `packages/nax/src/bot/models.ts` — `botModel`, `parseModelOption`
- `packages/nax/src/bot/fix-run.ts` — `fixCheckout`
- `packages/nax/src/bot/review-run.ts` — `reviewCheckout`
- `packages/nax/src/config/schema-types.ts` — `resolveConfiguredModel`, `resolveModelForAgent`
- `packages/nax/test/helpers/bot-fix.ts` — `_botFixDeps` stubs (`loadBotConfig`, `createRuntime`)

**US-005**
- `packages/nax/src/bot/fix-steps.ts` — `checkStep`, `BotFixState`
- `packages/nax/src/bot/repair-step.ts` — `repairStep` patch
- `packages/nax/src/bot/fix-run.ts` — `BOT_FIX_GRAPH` `check` node
- `packages/nax/src/bot/fix-outcome-text.ts` — `outcomeText`
- `packages/nax/src/cli/bot.ts` — `botFixCommand`

**US-004**
- `packages/nax/src/bot/carried-record.ts` — `carryWidenKey`, `carryWidenComment`, `carryWidenPending`, `pendingCarryWidenComments`
- `packages/nax/src/bot/post-carried.ts` — `postCarriedRecord`, `writeCarryWiden`, `clearCarryWidens`
- `packages/nax/src/bot/carried-hold.ts` — the readiness hold that reads pending signals
- `packages/nax/src/forge/marker-grammar.ts` — `CARRIED_RECORD_KEY`, `isTopLevelMarkerKey`
- `packages/nax/test/integration/bot/carried-finding-holds.test.ts` — the forge-state harness (`forgeState`, `install`, `reviewHead`)

### Creates

**US-001**

None. New tests go into the existing `packages/nax/test/unit/bot/fix-facts.test.ts`, `packages/nax/test/unit/prompts/bot-pr-fix-builder.test.ts` and, for the two `fixStep` prompt ACs, `packages/nax/test/integration/bot/fix-check-steps.test.ts` (its `factsSection` and `fakePromptFix` helpers).

**US-002**

None. New tests go into the existing `packages/nax/test/unit/workflow/open-items-kinds.test.ts`, `packages/nax/test/unit/workflow/feature-flagged-decisions.test.ts` and `packages/nax/test/unit/finish/pr-body.test.ts` (the existing `buildAdvisorSection` tests).

**US-003**

- `packages/nax/test/integration/bot/model-override.test.ts` — the `runBotFix` and `runBotReview` refusal tests (`review-run.test.ts` is at 731 lines and `fix-run.test.ts` at 632). Unit tests go into the existing `packages/nax/test/unit/bot/models.test.ts`.

**US-004**
- `packages/nax/test/integration/bot/carry-widen-signals.test.ts` — the per-review signal and race tests (`carried-finding-holds.test.ts` is at 787 of its 800-line limit). Unit tests go into the existing `packages/nax/test/unit/bot/carried-record.test.ts` and `packages/nax/test/unit/forge/threads-comments.test.ts`.

**US-005**
- `packages/nax/test/unit/bot/repair-step.test.ts` — the `repairStep` patch test (no unit test file exists for `repair-step.ts`). Other new tests go into the existing `packages/nax/test/unit/bot/fix-steps.test.ts`, `packages/nax/test/integration/bot/fix-check-steps.test.ts`, `packages/nax/test/unit/bot/fix-summary.test.ts` and `packages/nax/test/unit/cli/bot-fix.test.ts`.

### Modifies

**US-001**
- `packages/nax/test/unit/bot/fix-facts.test.ts` — test "AC-4: two parents yield one Lineage line each" asserts two `Lineage:` lines, one per parent, each with its issue. Under the new rule a two-parent lineage yields exactly one line, `Lineage: generation 3, on lines added by nax bot fix <sha7> for f-a, f-b`, with no issue suffix. The issues move to `lineagePushFacts`. Rewrite that test's expectation to the single line.

**US-002**
- `packages/nax/test/unit/workflow/feature-flagged-decisions.test.ts` — every `flaggedDecisions` step stub and helper type in the file (the `flagged` option type, `flaggedStepOf`, and the stubs returning `readonly string[]`) returns ids. The step now returns `readonly FlaggedDecision[]`, so they return `{ id, summary }` objects, and the assertion that `buildFeatureEnv`'s step yields `[trusted.id]` becomes `[{ id: trusted.id, summary: <its summary> }]`. Assertions on `final.flaggedDecisions` (ids) stay as they are.
- `packages/nax/test/unit/workflow/publish-item-threads.test.ts` — `h.env.steps.flaggedDecisions = async () => ["D1"]` stubs the old return type. It becomes `async () => [{ id: "D1", summary: "a summary" }]`. The assertion that the posted record's `flaggedDecisions` equals `["D1"]` stays.
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — the test pinning the `publish` node's `produces` list exactly gains `"flaggedDecisionSummaries"` in its expected list; no other node's list changes.
- `packages/nax/test/helpers/workflow-trace.ts` — the trace wrapper forwards `steps.flaggedDecisions` with the old `readonly string[]` type. Its signature follows the new `readonly FlaggedDecision[]` return type; no recorded trace changes.

**US-003**

None. The refusal is a new branch before `createRuntime`, and no existing test passes a `--model` that cannot resolve.

**US-005**

None. The `fix-failed` branch is new, and `no-change` keeps every existing assertion. `fix-summary.test.ts` builds `no-change` states with a `fixFailure` directly through `renderFixSummary`, which this story does not change.

**US-004**
- `packages/nax/test/integration/bot/carried-finding-holds.test.ts` — two tests assert that the posted signal's marker key equals `carryWidenKey(head)` exactly ("a partial full review ... still widens the next worker's review" for `headB`, and the published-head case for `published`). An incomplete review now posts `carryWidenReviewKey(head, <reviewId>)`, with a random review id. Those two assertions change to "some posted marker key starts with `carryWidenKey(head) + ":"`". Every assertion that a pending signal widens the next review stays.
- `packages/nax/src/forge/marker-grammar.ts` — production change named here because `CARRIED_RECORD_KEY` is a shared forge grammar: it widens to accept `w-carry-incomplete:<sha>:<lowercase UUID>` as in Design. Existing keys keep their classification.

### Seams

None between stories: the four stories are independent. Each story's new export is called by production code in the same story, and its ACs enter at the production entry point: `buildBotPrFixPrompt` input via `fixPromptFacts` (US-001), `publishStep` (US-002), `runBotFix` and `runBotReview` (US-003), `postPrReview` / `runBotReview` (US-004), and `runBotFix` / `botFixCommand` (US-005).

## Acceptance Criteria

### US-001

1. [unit] `findingFactLines` for a finding whose lineage is `{ generation: 3, parents: ["f-a", "f-b"], pushSha }` returns exactly one line starting `Lineage:`, equal to `Lineage: generation 3, on lines added by nax bot fix <sha7> for f-a, f-b`.
2. [unit] `findingFactLines` for a finding whose lineage has the single parent `f-a`, whose push the ledger holds with issue `lock leaks`, returns the line `Lineage: generation 2, on lines added by nax bot fix <sha7> for f-a (lock leaks)`.
3. [unit] `findingFactLines` for a single-parent lineage whose push the ledger no longer holds returns `Lineage: generation 2, on lines added by nax bot fix <sha7> for f-a` with no issue suffix.
4. [unit] `lineagePushFacts` for two agreed findings whose lineages both name push P with parents `["f-a", "f-b"]` and `["f-b", "f-c"]` returns one entry with `sha` equal to P's first 7 characters and item keys `["f-a", "f-b", "f-c"]` in that order.
5. [unit] In that case each returned item carries the `issue` the ledger recorded for that key in push P.
6. [unit] `lineagePushFacts` gives an item whose key push P's ledger entry does not hold no `issue` field.
7. [unit] `lineagePushFacts` returns an empty list when every agreed finding's lineage has exactly one parent.
8. [unit] `lineagePushFacts` returns one entry per distinct push, in the order the agreed items first name them, when two multi-parent lineages name different pushes.
9. [unit] `lineagePushFacts` ignores agreed items whose `kind` is not `finding`.
10. [unit] `lineagePushFacts` for push P named by a two-parent lineage `["f-a", "f-b"]` and by a single-parent lineage `["f-c"]` returns one entry for P whose item keys are `["f-a", "f-b"]`.
11. [unit] `lineagePushFacts` for a two-parent lineage whose push the ledger no longer holds returns one entry for that push whose items carry the two keys and no `issue`.
12. [unit] `buildBotPrFixPrompt` with `lineagePushes` `[{ sha: "9a87207", items: [{ key: "w-D-1", issue: "add a lock" }, { key: "w-D-2" }] }]` and no finding facts renders a `## Facts about these findings` section containing the line `Earlier nax bot fix push 9a87207 was for:`.
13. [unit] In that case the section has the line `- w-D-1: add a lock` and the line `- w-D-2`, each indented by the builder's fact indent and following the push line.
14. [unit] `buildBotPrFixPrompt` with both finding facts and `lineagePushes` renders the push lines after every finding block and before the outside-growth line.
15. [unit] `buildBotPrFixPrompt` with an empty `lineagePushes`, no finding facts and no outside growth renders no `## Facts about these findings` section.
16. [integration] With a review artifact whose two agreed findings each carry a two-parent lineage on one recorded push, and the push ledger holding that push's item issues, the prompt `runBranchFix` receives from `fixStep` contains `Earlier nax bot fix push <sha7> was for:` exactly once.
17. [integration] In that case the prompt has exactly two lines starting `Lineage:` (after the fact indent), one per finding.

### US-002

1. [unit] `advisorDecisionSummary` for a decision with `rulingTitle` `Keep the lock in deploy.sh` returns `Keep the lock in deploy.sh`.
2. [unit] `advisorDecisionSummary` for a decision with no `rulingTitle` and action `{ type: "answer", text: "use the queue" }` returns `answer — use the queue`.
3. [unit] `advisorDecisionSummary` for a decision with no `rulingTitle`, action type `carry` to stories `US-002` with instruction `add the check` returns `carry → US-002 — add the check`.
4. [unit] `advisorDecisionSummary` for a decision whose `rulingTitle` has a newline returns a single line with no newline.
5. [unit] `advisorDecisionSummary` for a decision whose `rulingTitle` is only whitespace and whose action is `{ type: "answer", text: "use the queue" }` returns `answer — use the queue`.
6. [unit] `buildAdvisorSection` for a list of decisions returns the same text it returned before this story (one fixture with an answer, a carry and a supersede decision, compared to a fixed expected string).
7. [unit] The `flaggedDecisions` step from `buildFeatureEnv`, with a ledger holding a trusted decision `D-1` with `needsHumanConfirm: true` and `rulingTitle` `Keep the lock`, returns `[{ id: "D-1", summary: "Keep the lock" }]`.
8. [unit] That step omits a trusted decision whose `needsHumanConfirm` is `false`.
9. [unit] After `publishStep` with the step returning `[{ id: "D-1", summary: "Keep the lock" }]`, the feature record has `flaggedDecisions` `["D-1"]`.
10. [unit] In that case the record has `flaggedDecisionSummaries` `{ "D-1": "Keep the lock" }`.
11. [unit] After `publishStep` with the step returning an empty list, the record has no `flaggedDecisionSummaries` key.
12. [unit] `buildOpenItems` for a record with `flaggedDecisions` `["D-3"]` and `flaggedDecisionSummaries` `{ "D-3": "Keep the lock" }` returns an advisor item `D-3` whose issue is `advisor decision D-3 needs a human: Keep the lock`.
13. [unit] `buildOpenItems` for a record with `flaggedDecisions` `["D-3"]` and no `flaggedDecisionSummaries` returns an advisor item whose issue is `advisor decision D-3 needs a human: see nax advisor list`.
14. [unit] `buildOpenItems` for a record whose `flaggedDecisionSummaries` maps `D-3` to an empty string returns the `see nax advisor list` issue for `D-3`.
15. [unit] Running the feature graph's `publish` node with a step returning `[{ id: "D-1", summary: "Keep the lock" }]` completes without a `STEP_GRAPH_UNDECLARED_OUTPUT` refusal.
16. [unit] In the `publishStep` item-thread path, the record passed to `postItemThreads` carries `flaggedDecisionSummaries` `{ "D-1": "Keep the lock" }` when the step returns that decision.

### US-003

1. [unit] `checkBotModelOverride(config, undefined)` returns `undefined`.
2. [unit] `checkBotModelOverride` with a `config.models.native` that has tier `balanced` and the model `"balanced"` returns `undefined`.
3. [unit] `checkBotModelOverride` with the model `{ agent: "native", model: "openai-codex/gpt-6.1-sol[high]" }` returns `undefined`.
4. [unit] `checkBotModelOverride` with the string model `"nope"`, under a default agent `native` with tiers `fast` and `balanced`, returns a reason starting `invalid --model "nope": No model entry found`.
5. [unit] In that case the reason contains `accepted forms: <tier> or <agent>:<model>`.
6. [unit] In that case the reason contains `configured tiers: fast, balanced`.
7. [unit] In that case the reason ends with `configured tiers: fast, balanced`, with no agent-prefix hint after it.
8. [unit] `checkBotModelOverride` with the string model `"openai-codex/gpt-6.1-sol[high]"` and default agent `native` returns a reason containing `a provider/model id needs its agent prefix, for example native:openai-codex/gpt-6.1-sol[high]`.
9. [integration] `runBotFix` with `model: "nope"` and a loaded config with no tier `nope` returns `{ outcome: "refused" }` whose `reason` starts `invalid --model "nope"`.
10. [integration] In that case `_botFixDeps.createRuntime` is not called.
11. [integration] In that case `_botFixDeps.runPreRunSteps` is not called.
12. [integration] `runBotReview` with `model: "nope"` and a loaded config with no tier `nope` returns `{ outcome: "refused" }` whose `reason` starts `invalid --model "nope"`.
13. [integration] In that case `_botReviewDeps.createRuntime` is not called.
14. [unit] `checkBotModelOverride` with the string model `"nope"` and a config whose `models` has no entry for the default agent returns a reason containing `configured tiers: none`.
15. [integration] `runBotFix` with `readyOnly: true` and `model: "nope"` returns `{ outcome: "refused" }` whose `reason` starts `invalid --model "nope"`.
### US-004

1. [unit] `carryWidenReviewKey(<40-hex sha>, <uuid>)` returns `w-carry-incomplete:<sha>:<uuid>`.
2. [unit] `isNaxBotMarkerKey(carryWidenReviewKey(<40-hex sha>, crypto.randomUUID()))` returns `true`.
3. [unit] `isTopLevelMarkerKey(carryWidenReviewKey(<40-hex sha>, <uuid>))` returns `true`.
4. [unit] `isTopLevelMarkerKey` returns `false` for `w-carry:<40-hex sha>:<uuid>`.
5. [unit] Listing PR comments from a GitLab discussion whose first note carries a per-review signal marker and has one reply returns that signal as an own comment with no `threadId`.
6. [unit] `pendingCarryWidenComments` returns an own comment keyed `carryWidenReviewKey(sha, id)` whose body is not the cleared text.
7. [unit] `pendingCarryWidenComments` still returns an own comment keyed with the legacy `carryWidenKey(sha)` whose body is not the cleared text.
8. [unit] `pendingCarryWidenComments` omits a per-review signal whose body contains `CARRY_WIDEN_CLEARED`.
9. [integration] `postPrReview` for an incomplete review at head H with a new blocking off-line finding, whose `own` already holds a pending signal keyed `carryWidenKey(H)`, posts a new comment whose marker key is `carryWidenReviewKey(H, <that review's id>)`.
10. [integration] In that case the existing `carryWidenKey(H)` comment is not edited.
11. [integration] `postPrReview` for an incomplete review whose own already holds a pending per-review signal from another review id at the same head posts one more signal comment; afterwards two pending signals exist for H.
12. [integration] `postPrReview` for an incomplete review with no new blocking finding posts no signal comment.
13. [integration] `postPrReview` for a complete review whose carried-record write fails, with a new blocking finding, posts a signal keyed `carryWidenReviewKey(H, <review id>)`.
14. [integration] Race: review Y starts with `own` holding pending signal S1. Incomplete review X then posts signal S2 for a new blocker, and Y completes a full review whose index advance succeeds. After Y, S1's body is the cleared text and S2 is still pending.
15. [integration] In that race, the next `runBotReview` reads S2 as pending and runs a full-scope review.
16. [integration] In that race, `nax bot fix`'s readiness hold (`carried-hold.ts`) reports the incomplete-carry hold while S2 is pending.
17. [integration] When posting the per-review signal throws, `postCarriedRecord` returns `false` and the logger receives a `warn` on stage `bot-post`.

Verification note for US-004: deleting `carryWidenComment` is checked by `bun run typecheck` in `packages/nax`, not by an AC.

### US-005

1. [unit] `checkStep` with `state.fixFailure` `"boom"` and `changedPaths` returning `[]` returns exit `fix-failed` and a patch with `outcome: "fix-failed"`.
2. [unit] In that case the logger receives a `warn` on stage `bot-fix` with message `Fix session failed` and data containing `failure: "boom"`.
3. [unit] `checkStep` with no `fixFailure` and `changedPaths` returning `[]` returns exit `no-change` and `outcome: "no-change"`.
4. [unit] `checkStep` with `state.fixFailure` `"boom"` and `changedPaths` returning `["src/a.ts"]` returns exit `changed`.
5. [integration] `runBotFix` whose fix session returns `failure: "boom"` and changes nothing returns `outcome: "fix-failed"` with `fixFailure: "boom"`, and the gates step does not run.
6. [unit] `repairStep` whose session reports no failure returns a patch that states `fixFailure` as `undefined`.
7. [unit] `outcomeText` for a state with `outcome: "fix-failed"` returns `The fix session failed before changing anything; nothing pushed.`.
8. [unit] `botFixCommand` whose `runBotFixCycle` returns a fix result `{ outcome: "fix-failed", fixFailure: "boom" }` calls `deps.logErr` with `fix-failed: boom` and returns 2.
9. [unit] `botFixCommand` whose fix result is `{ outcome: "fix-failed", fixFailure: "line one\nline two" }` calls `deps.logErr` with `fix-failed: line one`.
10. [unit] `botFixCommand` whose fix result is `{ outcome: "no-change" }` calls `deps.logErr` with `no-change` and returns 2.
