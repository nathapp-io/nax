# SPEC: bot chain advisor: a finding that sits on the bot's own fixes goes to the advisor before the fixer

Closes: #2987

## Summary

`nax bot fix` asks the advisor about a blocking finding before it hands that finding to the fix session, when the finding sits on lines an earlier nax bot fix push wrote and its lineage generation has reached `bot.chainNoticeGeneration` (default 2). Such a finding is a **chain finding**.

The advisor reads the finding, the push it sits on, what that push was for, and the file's diff against the merge base. It picks one option:

- `fix`: the finding is real. The fix session receives the advisor's instruction for that item in place of the reviewer's suggestion. Restoring the lines to their state before the chain's fix pushes is a legal instruction.
- `waive`: the finding is against behaviour the base branch already has or the spec excludes. The bot records the ruling on the finding's thread and resolves it. No fix session sees the item.
- `hold`: a human must decide. The bot says so on the thread and leaves it open. No fix session sees the item.

A ruling the advisor service marks `needsHumanConfirm` is treated as `hold`, with the advisor's proposal quoted on the thread. The service sets that flag for a low-confidence reply, a reply it calls not reversible, and a waive of a `critical` finding. A confident, reversible waive of an `important` finding is applied without a human; a repository writer can overturn it by replying on the thread.

The advisor rules once per finding. A later chain finding whose lineage parent was ruled by the advisor is held for a human without a second advisor call, and so is a finding raised again after an advisor-ruled fix.

The feature is off by default, behind `advisor.callers.botFixChain`, like every other advisor caller. This is #2987 lever C, the last open part of that issue. It is one capability in nine stories: the stories are steps of one routing, not independent fixes.

## Motivation

Parts 1 and 2 of #2987 (#2992, #3008) gave the reviewer and the fixer the facts about a fix-induced chain: each finding's lineage, its origin, and a notice in the fix summary once a blocking finding reaches the notice generation. The notice states a fact and tells no one what to do. #3045 added the definition of done to the two prompts.

On a downstream pull request (nax 0.93.0, evidence comment on #2987 of 2026-11-26) the chain ran to 14 fix pushes. 12 of 32 findings were `fix-regression`, 4 of them at generation 2. Rounds 1 and 4 raised the same finding. Rounds 2, 3 and 5 each correctly reported damage done by the previous fix. The loop ended only when a human read the base branch, the spec's Out of Scope and the README, restored the lines to the base behaviour, and waived the root finding.

Every step of that human ruling used inputs the bot already has at fix time: the finding, its lineage, the push ledger, and the checkout. What is missing is a decision point between the review and the fixer. The advisor service already exists for that purpose in workflow runs (`createAdvisor`, `advise`), with a menu, a decision ledger, a model ladder and a forced-confirm rule. `nax bot fix` already carries the advisor ledger into the PR checkout (`ledger-carry.ts`). It does not call the advisor.

A prompt-only rule cannot close this gap. Nothing under `src/bot` reads the fixer reply's `concerns` or status, so a fixer told to leave an item alone has no way to say so that the bot acts on.

## Design

### Approach

The routing is a transform of the fix environment, run before the fix graph, in the same place and shape as `withCarriedFixFindings`:

1. `chainRoutingContext` decides whether the routing applies to this pull request at all, and `selectChainFindings` picks the chain findings out of `env.review.agreed` (US-004).
2. `buildChainQuestion` builds the advisor question for one chain finding (US-005).
3. `withChainRulings` asks the advisor one question per chain finding, maps each decision to an outcome (`fix`, `waived`, `held` or `unruled`), posts the outcome on the finding's thread, and returns the environment the fix graph runs on (US-006).
4. Before asking, `withChainRulings` applies the rules for a finding that already has a ruling (US-007).
5. The fix prompt states the instruction as one fact line on that item, and the fix summary says how many chain findings the advisor ruled on (US-008).
6. A finding the advisor held keeps holding readiness in the same run, although it is no longer in `review.agreed` (US-009).

The fix graph (`BOT_FIX_GRAPH`) does not change. No node, exit or state field is added.

A chain ruling is durable because it is a comment on the pull request, read back through the existing own-comment reader (US-002). The advisor service also appends its decision to the feature's decision ledger as it does for every caller; this feature does not read that ledger. Because the ledger in the main checkout grows, the existing `ledgerStep` carries it into the PR checkout and pushes it, exactly as it does for any other advisor decision made since the last carry.

**The returned environment.** Waived and held items are removed from `review.agreed`. A `fix` item and an `unruled` item stay, unchanged and in place. `env.chainRulings` lists one `ChainRuling` per finding that has a `fix` or `held` outcome in this run, and per finding the advisor waived in this run, in `review.agreed` order. That includes an outcome replayed from an existing comment (composition test 4) and a hold made without asking (tests 4 and 5). An `unruled` finding has no entry, and neither has a finding removed because its thread already carries a `waived` chain ruling. `AgreedItem` is not changed: the instruction travels in `chainRulings`, and `chainInstructions(env)` gives the fix step a map from finding key to instruction.

**An advisor waive settles the finding the way a writer's waive does (US-003).** `latestFindingRuling` is the one place that decides which reply rules a finding thread. It gains one case: an own comment whose marker key starts with `cr-` and whose body `parseChainRuling` reads as outcome `waived` is a ruling with disposition `waived`. Scanning stays newest-first, so a writer's later reply (`confirm`, `waive:`, `override:`) outranks the advisor, and the advisor's comment outranks any older writer reply. Every reader that goes through `latestFindingRuling` follows with no further change: `recordFindingRulings`, `readSettledKeys`, `readConfirmedKeys`.

**A held finding stays open until a writer rules.** The thread is not resolved. Readiness reads its open blocking keys from `review.agreed`, which no longer holds the item, so `openFindingHold` in `fix-report.ts` also takes the keys of `env.chainRulings` entries with outcome `held` (US-009). They go through the same `openKeys` reconciliation as every other key, so a writer's `waive:` on the thread lifts the hold. A ready-only pass does not run the routing and reads the unfiltered artifact, where the held finding is still an open blocking finding. A writer's `confirm` on the thread makes the next `nax bot fix` hand the item to the fixer without asking the advisor; a writer's `waive:` settles it through the existing path.

**When the routing does not apply.** `chainRoutingContext(env)` returns `null`, and `withChainRulings` then returns the `env` object it was given without reading any ruling and without creating an advisor, when any of these holds: `resolveAdvisorConfig(env.config).enabled` is false; `resolveAdvisorConfig(env.config).callers.botFixChain` is false; `ledgerFeature(env)` is undefined (the pull request does not change exactly one feature's `prd.json`); or `featureIntentPaths(env.checkout)` yields no `specPath`. `withChainRulings` also returns `env` itself when `selectChainFindings(env)` is empty. A ready-only pass never reaches `withChainRulings`: `fixCheckout` skips it there, as it skips `withCarriedFixFindings`.

**Composition.** For each agreed item, in `review.agreed` order, these tests apply in this order. The first that matches decides, and later tests are not evaluated for that item:

1. Not a finding, or `isBlockingFinding(item, blocking)` is false, or `item.lineage` is absent, or `item.lineage.generation` is below the configured notice generation: not a chain finding. The item stays unchanged. (US-004)
2. The item's key is in the confirmed keys (`readConfirmedKeys`): a writer has ruled that the work stands. The item stays unchanged and the advisor is not asked. (US-007)
3. The item has no own thread: outcome `unruled`. The advisor is not asked. (US-006)
4. The item's own thread already carries a chain ruling comment (US-007). The newest one decides, and the advisor is not asked:
   - outcome `held`: the item is removed, the hold is recorded in `chainRulings` with the comment's text, and nothing is posted;
   - outcome `waived`: the item is removed and nothing is posted;
   - outcome `fix`, and no own comment with marker key `fix-<item key>` comes after it on the thread: the item stays, with the recorded text as its instruction, and nothing is posted;
   - outcome `fix`, and an own `fix-<item key>` comment comes after it: outcome `held` with the text `raised again after an advisor-ruled fix`, posted as a new chain ruling comment.
5. One of `item.lineage.parents` has a chain ruling: an own comment anywhere on the pull request whose marker key is `chainRulingKey(parent)`, or a ruling this same call already made for that parent key. Outcome `held` with the text `a second finding on this chain`; the advisor is not asked. (US-007)
6. `env.cost.spentUsd() >= env.cost.limitUsd`: outcome `unruled` for this item and for every later item that reaches this test. (US-007)
7. Otherwise the advisor is asked. (US-006)

Test 2 precedes test 4 so that a writer's `confirm` on a held thread releases the item. Test 4 precedes test 5 so that a finding ruled once is not re-held by its own ancestry. Tests 2, 4, 5 and 6 are US-007's code: US-006 delivers tests 3 and 7 and asks the advisor about every chain finding that has an own thread.

**The finding's own thread** is the thread in `env.threads` whose first comment is by `env.user.login` and carries the marker key equal to the item's key. This is the rule `resolveOwnFindings` uses.

**Outcome `unruled` is today's behaviour.** The item stays in `review.agreed` unchanged, no `ChainRuling` is recorded for it, and no comment is kept as its ruling. It is the result when the item has no own thread, when the cost limit is reached, when the advisor returns no decision or `advise` rejects, and when posting the ruling comment fails, whatever the outcome would have been.

**The advisor session is base-pinned like the fix session.** When `env.ctx.sessionScope` is present, each `advise` call runs inside it, so the advisor session does not load agent configuration files from the pull request's head. `branch-fix.ts` applies the same scope to the fix session.

**Files.** The question builder lives in its own file, `chain-question.ts`, so that `chain-advise.ts` stays well under the 600-line source limit. `chain-advise.ts` gets three test files, one per story that adds to it (`chain-advise.test.ts`, `chain-advise-outcomes.test.ts`, `chain-advise-ruled.test.ts`), because the three stories' tests together would pass the 800-line test file limit.

**Sanitised text is not code-exact.** `safeText` turns backticks into apostrophes, escapes angle brackets, and breaks `@name`, `#<digit>` and `://` with a zero-width space. The instruction the fixer reads is the posted, sanitised one, so an instruction that quotes code reaches the fixer altered in those characters. The advisor's instruction names what to change in words; the fixer reads the code itself.

### Integration

Symbols this feature only reads:

- `packages/nax/src/advisor/service.ts`: `createAdvisor(actx: AdvisorCallContext): Advisor`, and `Advisor.advise(question: QuestionDraft, opts?: { findingSeverity?: string }): Promise<AdviceResult>`. `AdviceResult` is `{ decision: AdviceDecision | null; fallbackReason?: string }`. The forced-confirm rule reads the severity from `opts.findingSeverity` only; the `findingSeverity` field of the draft is stored on the decision and does not reach the rule. The service checks neither `advisor.enabled` nor any caller flag, so the gating is this feature's work.
- `packages/nax/src/advisor/menus.ts`: `forcedConfirm(action, reply, findingSeverity?)`. It forces confirmation for `hold`, for a low-confidence or not-reversible reply, and for a `waive` whose severity is one of `HIGH`, `CRITICAL`, `error`, `critical`. The bot's `important` is not in that set.
- `packages/nax/src/advisor/service-helpers.ts`: `AdvisorCallContext { callCtx; repoRoot; outputDir; feature; runId; specPath; workdir }`. `repoRoot` is the main checkout.
- `packages/nax/src/config/schemas-advisor.ts`: `resolveAdvisorConfig(config): AdvisorConfig`. `NaxConfig.advisor` is optional, so the flags are read through it.
- `packages/nax/src/bot/intent.ts`: `featureIntentPaths(checkout): { prdPath?: string; specPath?: string }`, both absolute paths in the PR checkout.
- `packages/nax/src/workflow/blocking-findings/index.ts`: `isBlockingFinding(item, blocking)`, `configuredChainNoticeGeneration(config): number`.
- `packages/nax/src/bot/review-blocking.ts`: `reviewBlockingTriggers(env)`.
- `packages/nax/src/bot/push-record.ts`: `ownLedgerEntries(own)`. A ledger entry is read only when its `sha` is 40 lowercase hex characters (`FULL_SHA` in `push-ledger.ts`).
- `packages/nax/src/bot/push-ledger.ts`: `parentIssue(pushSha, parent, entries)`, `FindingLineage { generation; parents; pushSha }`.
- `packages/nax/src/bot/rulings.ts`: `readConfirmedKeys(input: SettlementReadInput): Promise<ReadonlySet<string>>`, `readSettledKeys`.
- `packages/nax/src/bot/render.ts`: `safeText(text, max): string` — redacts secrets, breaks links, neutralises mentions, caps the length.
- `packages/nax/src/forge`: `withNaxBotMarker(body, key)`, `parseNaxBotMarker(body)`, `ownComments(comments, login, threadId?)`, `replyToThread(ref, thread, body, deps, cwd)`, `resolveThread(ref, thread, deps, cwd)`, `isNaxBotMarkerKey(key)`. `withNaxBotMarker` wraps a body as the `**nax bot**` header, a blank line, the body, a blank line, and the marker comment.
- `packages/nax/src/bot/fix-carried.ts`: `withCarriedFixFindings(env): Promise<BotFixEnv>` and `_fixCarriedDeps` — the pattern `withChainRulings` follows (injectable deps, returns a new env, never mutates).
- `packages/nax/src/bot/fix-steps.ts`: `BotFixEnv` has `repoRoot`, `ref`, `user`, `threads`, `own`, `forge`, `cost`, `ctx`, `config`, `checkout`, `review`. `env.ctx.sessionScope` is the base pin; `env.ctx.runId` and `env.ctx.outputDir` are absent for a pull request, so both are read from `env.ctx.callCtx.runtime`.
- `packages/nax/src/bot/checkout.ts`: `PrCheckout { worktree; mergeBase; changedFiles; ... }`.

Symbols this feature changes. Each baseline is given only to locate the code; the target is the interface to implement.

- `packages/nax/src/config/schemas-advisor.ts`, `callers`.
  Baseline: `{ finishJudgment, fixCycleGiveUp, uncategorisedFailure, finishApproval }`, each `z.boolean().default(false)`.
  Target: the same four plus `botFixChain: z.boolean().default(false)`. `AdvisorCallersConfig` in `runtime-types-advisor.ts` gains `botFixChain: boolean`.
- `packages/nax/src/advisor/types.ts`, `AdviceQuestionKind` and `MenuFacts`.
  Baseline: seven kinds, ending in `"residual"`.
  Target: the same plus `"bot-fix-chain"`, and `MenuFacts` gains the member `{ kind: "bot-fix-chain" }`.
- `packages/nax/src/advisor/menus.ts`, `buildMenu(facts: MenuFacts): AdviceOption[]`.
  Target: for `{ kind: "bot-fix-chain" }` it returns exactly three options, in this order: type `fix`, type `waive`, type `hold`, with ids assigned by the existing `withIds`.
- `packages/nax/src/bot/finding-rulings.ts`, `latestFindingRuling(input, thread): Promise<FindingRulingCandidate | null>`.
  Baseline: skips every own comment; returns the newest non-own reply that parses as a ruling keyword and whose author may rule.
  Target: same signature. Scanning newest-first, an own comment whose marker key starts with `cr-` and for which `parseChainRuling` returns outcome `waived` is returned as a candidate with `keyword: { disposition: "waived", reason: <the ruling text> }`, that comment as `reply`, and its index. Every other own comment is still skipped. `isWriter` is not called for it.
- `packages/nax/src/bot/finding-rulings.ts`, the private `recordThread`.
  Target: when the candidate's reply is an own chain ruling comment, no echo is posted for it (the comment is the record); the thread is still resolved when it is not already.
- `packages/nax/src/bot/ledger-carry.ts`, the private `ledgerFeature(env: BotFixEnv): string | undefined`.
  Target: exported, unchanged otherwise, so the routing and the ledger carry name the same feature.
- `packages/nax/src/bot/fix-steps.ts`, `BotFixEnv`.
  Target: gains `readonly chainRulings?: readonly ChainRuling[]`.
- `packages/nax/src/bot/fix-facts.ts`, `findingFactLines`.
  Baseline: `findingFactLines(item, entries, blocking): readonly string[]`.
  Target: `findingFactLines(item, entries, blocking, advisorInstruction?: string): readonly string[]`. When `advisorInstruction` is given for a finding, the returned lines end with `Advisor ruling: <advisorInstruction>`, after the trigger, lineage and not-blocking lines. The file's header comment, which says no line tells the fixer what to do, is updated to name this line as the one exception; the doc comment above `factsSection` in `bot-pr-fix-builder.ts` likewise. No prompt text changes.
- `packages/nax/src/bot/fix-input.ts`, `toFixFindings`.
  Baseline: `toFixFindings(items): WorkflowFinding[]`.
  Target: `toFixFindings(items, advised?: ReadonlyMap<string, string>): WorkflowFinding[]`. An item whose key is in `advised` yields a `WorkflowFinding` with no `suggestion`.
- `packages/nax/src/bot/fix-steps.ts`, `fixStep` and the private `fixPromptFacts`.
  Target: both read `chainInstructions(env)`. `fixStep` passes it to `toFixFindings`; `fixPromptFacts` passes each item's instruction to `findingFactLines`.
- `packages/nax/src/bot/fix-summary-body.ts`, the private `summaryDetails(env, state): string[]`.
  Target: when `env.chainRulings` is non-empty, the returned details include the count line below. It goes through `fitDetails` with the other detail lines, so it cannot push the comment past the forge limit.
- `packages/nax/src/bot/fix-run.ts`, the private `fixCheckout`.
  Baseline: `const fixEnv = input.readyOnly ? env : await withCarriedFixFindings(env);`
  Target: `const fixEnv = input.readyOnly ? env : await deps.withChainRulings(await withCarriedFixFindings(env));` with `withChainRulings` added to `_botFixDeps`. The file is at 545 of 600 lines; the wiring adds no other logic to it.

- `packages/nax/src/bot/fix-report.ts`, the private `openFindingHold(env)`.
  Baseline: the candidate keys are `blockingKeys(readinessReview(env), blocking)` plus the carried keys.
  Target: the candidate keys also include the key of every `env.chainRulings` entry with outcome `held` that is not already among them. All candidates still pass through `openKeys`.

`packages/nax/src/bot/post.ts` is at the 600-line limit and is not changed by any story.

New symbols, in `packages/nax/src/bot/chain-rulings.ts` (US-002; `chainInstructions` is US-008's):

```ts
export type ChainOutcome = "fix" | "waived" | "held";

export interface ChainRuling {
  /** The finding's own key, `f-…`. */
  readonly key: string;
  readonly outcome: ChainOutcome;
  /** fix: the instruction. waived: the reason. held: why a human must decide. */
  readonly text: string;
  /** held only: what the advisor proposed before the forced-confirm rule held it. */
  readonly proposed?: { readonly outcome: "fix" | "waived"; readonly text: string };
}

/** The cap on `text` and on `proposed.text` in a rendered comment. */
export const CHAIN_RULING_TEXT_CHARS = 1200;

/** `cr-` plus the finding key without its `f-` prefix. */
export function chainRulingKey(findingKey: string): string;
/** The comment body, without the nax bot header and marker. */
export function renderChainRuling(ruling: ChainRuling): string;
/** Reads a body back, wrapped by `withNaxBotMarker` or bare; `null` for any other text. */
export function parseChainRuling(body: string): Omit<ChainRuling, "key"> | null;
/** Finding key to instruction, for the `fix` entries of `env.chainRulings`; empty when there are none. */
export function chainInstructions(env: { readonly chainRulings?: readonly ChainRuling[] }): ReadonlyMap<string, string>;
```

Rendered body, one form per outcome. Every `<…>` is `safeText(<source text with each run of whitespace around a newline replaced by one space>, CHAIN_RULING_TEXT_CHARS)`:

```
Advisor ruling — fix: <instruction>
```

```
Advisor ruling — waived: <reason>
To change it, reply on this thread.
```

```
Advisor ruling — held: <reason>
Advisor proposed — waived: <proposed reason>
Reply `confirm` to have nax fix it as reported, or `waive: <reason>` to close it.
```

The `Advisor proposed` line is present only when `proposed` is set, and names `fix` or `waived`.

Grammar `parseChainRuling` reads: split the body on `\r?\n`, drop empty lines, the line `**nax bot**` and any line that is a nax bot marker comment. The first remaining line must start with `Advisor ruling — fix: `, `Advisor ruling — waived: ` or `Advisor ruling — held: `; the rest of that line is `text`. For `held`, a second remaining line starting with `Advisor proposed — fix: ` or `Advisor proposed — waived: ` gives `proposed`. Anything else is `null`. The match is a prefix match on a whole line, never a search inside a line. The text read back is the sanitised text that was posted, so an instruction replayed from a comment (composition test 4) is the sanitised one.

A comment counts as a chain ruling only when all three hold: it is an own comment (`ownComments`), its marker key starts with `cr-`, and `parseChainRuling` reads its body.

New symbols, in `packages/nax/src/bot/chain-advise.ts` (US-004, US-006) and `packages/nax/src/bot/chain-question.ts` (US-005):

```ts
// chain-advise.ts
export const _chainAdviseDeps = { createAdvisor, buildChainQuestion, readConfirmedKeys, replyToThread, resolveThread, getLogger };

export interface ChainFinding {
  readonly item: Extract<AgreedItem, { kind: "finding" }>;
  /** The finding's own thread, when the bot posted one. */
  readonly thread?: PrThread;
}

export interface ChainRoutingContext {
  readonly feature: string;
  readonly specPath: string;
}

export function chainRoutingContext(env: BotFixEnv): ChainRoutingContext | null;
export function selectChainFindings(env: BotFixEnv): readonly ChainFinding[];
export function withChainRulings(env: BotFixEnv): Promise<BotFixEnv>;

// chain-question.ts
export const _chainQuestionDeps = { runGit: botGit };
export const CHAIN_DIFF_CHARS = 12_000;
export function buildChainQuestion(env: BotFixEnv, finding: ChainFinding, feature: string): Promise<QuestionDraft>;
```

**The question** (`buildChainQuestion`):

- `kind: "bot-fix-chain"`, `feature`: the given feature, `options: buildMenu({ kind: "bot-fix-chain" })`, `findingSeverity`: the finding's severity, `anchorFile`: the finding's file when it has one, `rulingTitle`: the first line of the finding's issue, `dedupeKey`: the chain ruling key.
- `summary`: exactly ``Finding <key> (<severity>) sits at generation <n> on lines nax bot fix <first seven characters of the push sha> added.``
- `evidence`, in this order:
  1. `source: "finding"`: the issue, `file:line`, severity, trigger and trigger evidence, origin and origin evidence, and the reviewer's suggestion.
  2. `source: "review-round"`: one entry for the lineage push, listing each parent key with the issue the ledger recorded for it (`parentIssue` over `ownLedgerEntries(env.own)`), or the key alone when the ledger no longer holds it.
  3. `source: "diff"`, `ref: <file>`: the standard output of `git diff <env.checkout.mergeBase>..HEAD -- <file>` run in `env.checkout.worktree`, when the finding has a file.
  4. `source: "diff"`, `ref: <pushSha>`: the standard output of `git show <pushSha> -- <file>`, when the finding has a file.
- A diff text longer than `CHAIN_DIFF_CHARS` is cut to its first `CHAIN_DIFF_CHARS` characters and followed by a newline and the line `(diff cut at 12000 characters)`.
- A git command that exits non-zero, times out or rejects leaves its evidence entry out; the draft is still returned.

**The advisor call** (`withChainRulings`): one advisor is created per call, with `callCtx: env.ctx.callCtx`, `repoRoot: env.repoRoot`, `outputDir` and `runId` from `env.ctx.callCtx.runtime`, `feature` and `specPath` from `chainRoutingContext`, `workdir: env.checkout.worktree`. Each finding is asked with `advise(draft, { findingSeverity: item.severity })`, inside `env.ctx.sessionScope` when it is present.

The advisor prompt carries the feature's PRD text as read from the main checkout; for a feature that exists only on the pull request's branch that text is `{}`. The question's own evidence is what the ruling rests on.

**Decision to outcome.**

| Decision | Outcome | `text` | `proposed` |
|---|---|---|---|
| `null` | `unruled` | | |
| action `fix`, `needsHumanConfirm` false | `fix` | `action.instruction` | |
| action `waive`, `needsHumanConfirm` false | `waived` | `action.reason` | |
| action `hold` | `held` | `action.reason` | |
| action `fix`, `needsHumanConfirm` true | `held` | `decision.rationale` | `{ outcome: "fix", text: action.instruction }` |
| action `waive`, `needsHumanConfirm` true | `held` | `decision.rationale` | `{ outcome: "waived", text: action.reason }` |
| any other action type | `unruled` | | |

**Posting.** For `fix`, `waived` and `held` the routing replies on the finding's own thread with `withNaxBotMarker(renderChainRuling(ruling), chainRulingKey(item.key))`, then resolves the thread for `waived`. The `ChainRuling` recorded in `env.chainRulings` carries the text as posted, that is, the text `parseChainRuling` would read back.

**The fix summary.** When `env.chainRulings` is non-empty, the summary details include one line:

```
Advisor ruled on 3 findings that sit on earlier nax bot fixes: 1 to fix, 1 waived, 1 held for a human.
```

Counts of zero are left out (`2 findings ...: 2 held for a human.`), and one finding reads `1 finding that sits on earlier nax bot fixes`.

### Failure Handling

| Condition | Behaviour | Owner |
|---|---|---|
| `advisor.enabled` or `advisor.callers.botFixChain` is false | `chainRoutingContext` returns `null`; `withChainRulings` returns the `env` object it was given | US-004 |
| The pull request changes no single feature's `prd.json`, or its changed files hold no `spec.md` for it | `chainRoutingContext` returns `null` | US-004 |
| A git evidence command exits non-zero, times out or rejects | That evidence entry is left out; the draft is still returned | US-005 |
| A chain finding has no own thread | `unruled`; the advisor is not asked | US-006 |
| `env.cost.spentUsd() >= env.cost.limitUsd` before a call | That item and every later item that reaches the cost test are `unruled`; no further advisor call is made | US-007 |
| The advisor returns `decision: null` | `unruled`; a warning is logged with the item key and `fallbackReason` | US-006 |
| `advise` rejects | `unruled` for that item; the remaining items are still asked | US-006 |
| The decision's action type is none of `fix`, `waive`, `hold` | `unruled` | US-006 |
| Posting the ruling comment fails | `unruled`, whatever the decision was: the item stays, no `ChainRuling` is recorded, the thread is not resolved; a warning is logged | US-006 |
| Resolving a waived thread fails | The ruling stands: the item is removed and the `ChainRuling` is recorded; a warning is logged | US-006 |
| A held finding is absent from `review.agreed` when readiness is decided | Its key is still a candidate open key, from `env.chainRulings` | US-009 |
| `readConfirmedKeys` rejects | `withChainRulings` rejects with the same error; no item is sent to a fixer on a ruling that could not be read (same rule as `withCarriedFixFindings`) | US-007 |
| A comment with a `cr-` marker key does not parse | It is not a chain ruling: composition tests 4 and 5 do not match on it | US-007 |
| A writer replies after an advisor `waived` comment | The writer's reply rules: `latestFindingRuling` returns it | US-003 |

## Out of Scope

- A pull request that does not change exactly one feature's `prd.json` together with that feature's `spec.md`: its chain findings go to the fixer as they do today. The advisor's call context needs a feature and a spec path.
- Calling the advisor from `nax bot review`: the routing runs only in `nax bot fix`, before the fix session.
- Batching several chain findings into one advisor call (`adviseBatch`): one question per finding.
- Any change to `BOT_FIX_GRAPH`: no node, exit, transition or `BotFixState` field is added.
- Any change to `packages/nax/src/bot/post.ts` or to the `AgreedItem` type: the instruction travels in `BotFixEnv.chainRulings`.
- Any change to the text of the bot review or bot fix prompts: the instruction reaches the fixer through the existing per-finding fact lines, and the review prompt's settled-rulings section keeps its wording for an advisor waive.
- The warnings the routing logs (no decision, a rejected `advise`, a failed post, a failed resolve): they are written with the item key but no acceptance criterion pins their text.
- The order of `chainRulings` when several findings are ruled in one run beyond what the listed criteria assert.
- Reading the advisor's decision ledger to find earlier chain rulings: a chain ruling is read only from the pull request's own comments.
- A second advisor ruling on a ruled chain: a later finding whose lineage parent has a chain ruling is held for a human.
- Two sibling findings raised in one review round on the same push: each is asked separately, since neither is the other's lineage parent.
- Detecting that two findings in different rounds are the same finding by their wording: the routing uses the finding key and lineage only.
- A new config key for the generation threshold: the routing reuses `bot.chainNoticeGeneration`.
- A dedicated model key for this caller: the advisor's own `advisor.model` and `advisor.fallbackModels` apply. Choosing a model different from the reviewer's and fixer's is the operator's config, not enforced.
- Holding a confident, reversible waive of an `important` finding for a human: only the advisor service's existing forced-confirm rule decides, and it holds a waive of a `critical` finding.
- Changing what `needsHumanConfirm` means, when the advisor service sets it, or the severity set `forcedConfirm` reads.
- Non-blocking chain findings (a `fix-gap`, a minor, a trigger outside the blocking set): they are follow-ups today and stay so.
- Thread and comment items in `review.agreed`: only findings are routed.
- Surfacing a held finding as a workflow open item: it stays a blocking finding thread.
- The sentence the fix summary prints for a `nothing` outcome: it is unchanged when the advisor removed every item; the count line says what the advisor did.
- Supplying the PRD text to the advisor when the feature directory is absent from the main checkout: the advisor prompt carries `{}` there.
- Turning the caller on by default: `advisor.callers.botFixChain` defaults to `false`.
- Documentation outside the config description table: the bot guide is updated by hand after the feature lands.
- US-006 only: composition tests 2, 4, 5 and 6 (a writer's `confirm`, an existing chain ruling on the thread, a ruled lineage parent, the cost limit) and the `readConfirmedKeys` read are US-007's code. US-006 asks the advisor about every chain finding that has an own thread.

## Stories

**US-001: the advisor learns the bot-fix-chain question and its caller switch.** Workdir: `packages/nax`. No dependencies. Adds `advisor.callers.botFixChain` (default `false`) to the schema, the runtime type and the config description table. Adds the question kind `"bot-fix-chain"`, its `MenuFacts` member and its three-option menu.

**US-002: a chain ruling is a comment body the bot can render and read back.** Workdir: `packages/nax`. No dependencies. Adds `src/bot/chain-rulings.ts` with `ChainRuling`, `CHAIN_RULING_TEXT_CHARS`, `chainRulingKey`, `renderChainRuling` and `parseChainRuling`.

**US-003: an advisor waive settles the finding unless a writer replied after it.** Workdir: `packages/nax`. Depends on US-002. `latestFindingRuling` accepts an own `waived` chain ruling as the thread's ruling, and `recordFindingRulings` records it without posting an echo.

**US-004: which pull requests and which findings the routing applies to.** Workdir: `packages/nax`. Depends on US-001. Adds `src/bot/chain-advise.ts` with `_chainAdviseDeps`, `ChainFinding`, `ChainRoutingContext`, `chainRoutingContext` and `selectChainFindings`. Exports `ledgerFeature` from `ledger-carry.ts`.

**US-005: the question the advisor is asked about one chain finding.** Workdir: `packages/nax`. Depends on US-001, US-002, US-004. Adds `src/bot/chain-question.ts` with `_chainQuestionDeps`, `CHAIN_DIFF_CHARS` and `buildChainQuestion`.

**US-006: `withChainRulings` asks the advisor, posts the outcome and returns the environment the fixer runs on.** Workdir: `packages/nax`. Depends on US-002, US-005. Adds `withChainRulings` to `chain-advise.ts` and `chainRulings` to `BotFixEnv`. Delivers composition tests 3 and 7, the decision-to-outcome table, posting, and the failure rows it owns.

**US-007: a finding that already has a ruling is not asked again.** Workdir: `packages/nax`. Depends on US-003, US-006. Adds composition tests 2, 4, 5 and 6 to `withChainRulings`: a writer's `confirm`, an existing chain ruling on the thread, a ruled lineage parent, and the cost limit.

**US-008: the fix session and the fix summary carry the ruling.** Workdir: `packages/nax`. Depends on US-006, US-007. `fixCheckout` runs `withChainRulings` after `withCarriedFixFindings` on every pass that is not ready-only. Adds `chainInstructions` to `chain-rulings.ts`. `findingFactLines` states the advisor's instruction, `toFixFindings` drops the reviewer's suggestion for that item, and the fix summary adds the count line.

**US-009: a finding the advisor held keeps holding readiness.** Workdir: `packages/nax`. Depends on US-007. `openFindingHold` in `fix-report.ts` adds the keys of `env.chainRulings` entries with outcome `held` to its candidate open keys.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-advisor.ts` — `AdvisorConfigObjectSchema`, `ADVISOR_DEFAULTS`.
- `packages/nax/src/config/runtime-types-advisor.ts` — `AdvisorCallersConfig`.
- `packages/nax/src/advisor/types.ts` — `AdviceQuestionKind`, `MenuFacts`.
- `packages/nax/src/advisor/menus.ts` — `buildMenu`, `withIds`, `residualDrafts` as the pattern for labelled drafts.
- `packages/nax/test/unit/advisor/menus.test.ts` — existing per-kind `buildMenu` tests (239 lines); the new menu tests go here.

**US-002**
- `packages/nax/src/bot/render.ts` — `safeText`.
- `packages/nax/src/forge/marker.ts` — `withNaxBotMarker`, the wrapped body's shape.
- `packages/nax/src/forge/marker-grammar.ts` — `isNaxBotMarkerKey`, `parseNaxBotMarker`.
- `packages/nax/src/workflow/item-threads.ts` — `renderRulingEcho`, the existing ruling comment this one sits beside.

**US-003**
- `packages/nax/src/bot/finding-rulings.ts` — `latestFindingRuling`, `recordThread`, `recordFindingRulings`, `findingRulingKey`.
- `packages/nax/src/bot/chain-rulings.ts` — created by US-002; `parseChainRuling`.
- `packages/nax/src/bot/rulings.ts` — `readSettledKeys`, `readConfirmedKeys`, the readers that go through `latestFindingRuling`.
- `packages/nax/test/unit/bot/finding-rulings.test.ts` — existing `latestFindingRuling` and `recordFindingRulings` tests (267 lines); new ones go here.
- `packages/nax/test/unit/bot/rulings.test.ts` — existing reader tests; the three `[integration]` reader ACs go here.

**US-004**
- `packages/nax/src/bot/fix-carried.ts` — `withCarriedFixFindings` and `_fixCarriedDeps`, the pattern to follow.
- `packages/nax/src/bot/fix-steps.ts` — `BotFixEnv`.
- `packages/nax/src/bot/ledger-carry.ts` — `ledgerFeature`.
- `packages/nax/src/bot/intent.ts` — `featureIntentPaths`.
- `packages/nax/test/helpers/bot-fix.ts` — `makeBotFixEnv`.

**US-005**
- `packages/nax/src/bot/chain-advise.ts` — created by US-004; `ChainFinding`.
- `packages/nax/src/bot/chain-rulings.ts` — created by US-002; `chainRulingKey`.
- `packages/nax/src/advisor/types.ts` — `AdviceQuestion`, `AdviceEvidence`.
- `packages/nax/src/bot/push-record.ts` — `ownLedgerEntries`.
- `packages/nax/src/bot/push-ledger.ts` — `parentIssue`, `FindingLineage`, `encode` of a ledger entry for the test fixture.

**US-006**
- `packages/nax/src/bot/chain-advise.ts` — created by US-004, extended here.
- `packages/nax/src/bot/chain-question.ts` — created by US-005; `buildChainQuestion`.
- `packages/nax/src/bot/chain-rulings.ts` — created by US-002; `renderChainRuling`, `parseChainRuling`, `chainRulingKey`.
- `packages/nax/src/workflow/branch-fix.ts` — how `sessionScope` wraps a session.
- `packages/nax/src/advisor/service.ts` — `createAdvisor`, `Advisor.advise`.

**US-007**
- `packages/nax/src/bot/chain-advise.ts` — created by US-004, extended here.
- `packages/nax/src/bot/chain-rulings.ts` — created by US-002.
- `packages/nax/src/bot/rulings.ts` — `readConfirmedKeys`, `SettlementReadInput`.
- `packages/nax/src/bot/fix-carried.ts` — how `withCarriedFixFindings` builds the `readConfirmedKeys` input.
- `packages/nax/test/unit/bot/chain-advise-outcomes.test.ts` — created by US-006; the setup the US-007 tests mirror.

**US-008**
- `packages/nax/src/bot/fix-run.ts` — `fixCheckout`, `_botFixDeps`.
- `packages/nax/src/bot/fix-steps.ts` — `fixStep`, `fixPromptFacts`. `chainInstructions` is added to `src/bot/chain-rulings.ts` (created by US-002), with its tests in `test/unit/bot/chain-rulings.test.ts`.
- `packages/nax/src/bot/fix-facts.ts` — `findingFactLines`; its tests are in `test/unit/bot/fix-facts.test.ts`.
- `packages/nax/src/bot/fix-input.ts` — `toFixFindings`; its tests are in `test/unit/bot/fix-input.test.ts`.
- `packages/nax/src/bot/fix-summary-body.ts` — `summaryDetails`, `summaryBody`; its tests are in `test/unit/bot/fix-summary.test.ts`. The `runBotFix` ACs go in `test/integration/bot/fix-session.test.ts`.

**US-009**
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, and the private `openFindingHold`, `blockingKeys`, `openKeys` it reaches.
- `packages/nax/src/bot/fix-steps.ts` — `BotFixEnv.chainRulings`, added by US-006.
- `packages/nax/src/bot/chain-rulings.ts` — created by US-002; `ChainRuling`.
- `packages/nax/test/unit/bot/fix-report.test.ts` — existing `readyStep` tests (482 lines); the US-009 ACs go here.

### Creates

**US-002**
- `packages/nax/src/bot/chain-rulings.ts`
- `packages/nax/test/unit/bot/chain-rulings.test.ts`

**US-004**
- `packages/nax/src/bot/chain-advise.ts`
- `packages/nax/test/unit/bot/chain-advise.test.ts`

**US-005**
- `packages/nax/src/bot/chain-question.ts`
- `packages/nax/test/unit/bot/chain-question.test.ts`

**US-006**
- `packages/nax/test/unit/bot/chain-advise-outcomes.test.ts`

**US-007**
- `packages/nax/test/unit/bot/chain-advise-ruled.test.ts`

**US-008**
- `packages/nax/test/integration/bot/chain-advise-service.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/config/advisor-config.test.ts` — two assertions pin `advisor.callers` with `toEqual` on exactly four keys (the defaults test and "a partial block keeps the other defaults"). Both gain `botFixChain: false`; the invariant that replaces them is that every caller, `botFixChain` included, defaults to `false` and an unnamed caller keeps its default.

### Seams

- US-001 produces the question kind `"bot-fix-chain"` and its menu; US-005 consumes them: `buildChainQuestion` returns a draft with `kind: "bot-fix-chain"` and `options` equal to `buildMenu({ kind: "bot-fix-chain" })`.
- US-002 produces `chainRulingKey`, `renderChainRuling` and `parseChainRuling`; US-003 consumes `parseChainRuling` in `latestFindingRuling`; US-006 consumes all three: the comment `withChainRulings` posts is `withNaxBotMarker(renderChainRuling(ruling), chainRulingKey(key))`.
- US-004 produces `chainRoutingContext` and `selectChainFindings`; US-006 consumes them at the top of `withChainRulings`.
- US-005 produces `buildChainQuestion`; US-006 consumes it through `_chainAdviseDeps.buildChainQuestion`: the draft passed to `advise` is the one it returns.
- US-006 and US-007 produce the `held` entries of `BotFixEnv.chainRulings`; US-009 consumes them in `openFindingHold`, reached through `readyStep`.
- US-006 produces `withChainRulings` and `BotFixEnv.chainRulings`; US-008 consumes them: `runBotFix` calls `withChainRulings` once per pass that is not ready-only, and `chainInstructions(env)` feeds `toFixFindings` and `findingFactLines`.

## Acceptance Criteria

### US-001

- [unit] `NaxConfigSchema.parse({}).advisor.callers.botFixChain` is `false`.
- [unit] `NaxConfigSchema.parse({ advisor: { callers: { botFixChain: true } } }).advisor.callers` equals `{ finishJudgment: false, fixCycleGiveUp: false, uncategorisedFailure: false, finishApproval: false, botFixChain: true }`.
- [unit] `NaxConfigSchema.parse({ advisor: { callers: { botFixChain: "yes" } } })` throws a Zod error whose issue path is `["advisor", "callers", "botFixChain"]`.
- [unit] `ADVISOR_DEFAULTS.callers.botFixChain` is `false`.
- [unit] `FIELD_DESCRIPTIONS`, exported from `cli/config-descriptions.ts`, has an entry for the key `advisor.callers.botFixChain` whose text is a non-empty string.
- [unit] `buildMenu({ kind: "bot-fix-chain" })` returns three options whose `type` values are, in order, `fix`, `waive`, `hold`.
- [unit] The three options returned by `buildMenu({ kind: "bot-fix-chain" })` have three distinct non-empty `id` values.
- [unit] Each option returned by `buildMenu({ kind: "bot-fix-chain" })` has a non-empty `label`.
- [unit] No option returned by `buildMenu({ kind: "bot-fix-chain" })` carries a `fixed` field.
- [unit] `validateAdvisorReply` given the `fix` option's id from that menu, a rationale, `confidence: "high"`, `reversible: true`, `needsHumanConfirm: false` and no `instruction` returns `{ ok: false }` with an error naming `instruction`.
- [unit] `validateAdvisorReply` given the `waive` option's id from that menu and a non-empty `reason` returns `{ ok: true }` with `reply.reason` equal to that reason.

### US-002

- [unit] `chainRulingKey("f-ab12cd34")` returns `"cr-ab12cd34"`.
- [unit] `isNaxBotMarkerKey(chainRulingKey("f-ab12cd34"))` is `true`.
- [unit] `renderChainRuling({ key: "f-1", outcome: "fix", text: "restore the guard" })` returns the single line `Advisor ruling — fix: restore the guard`.
- [unit] `renderChainRuling` for outcome `waived` with text `base behaviour` returns two lines: `Advisor ruling — waived: base behaviour` then `To change it, reply on this thread.`
- [unit] `renderChainRuling` for outcome `held` with text `low confidence` and no `proposed` returns exactly the two lines `Advisor ruling — held: low confidence` and ``Reply `confirm` to have nax fix it as reported, or `waive: <reason>` to close it.``
- [unit] `renderChainRuling` for outcome `held` with `proposed: { outcome: "waived", text: "spec excludes it" }` returns three lines whose second is `Advisor proposed — waived: spec excludes it`.
- [unit] `renderChainRuling` for outcome `held` with `proposed: { outcome: "fix", text: "restore it" }` returns three lines whose second is `Advisor proposed — fix: restore it`.
- [unit] `renderChainRuling` given a `text` of `first` and `second` separated by a newline renders them on one line as `first second`.
- [unit] For a `text` of 3,000 plain letters, the text after `Advisor ruling — fix: ` in the rendered line equals `safeText(text, CHAIN_RULING_TEXT_CHARS)`.
- [unit] For a `text` of `see https://example.com and @octocat`, the text after `Advisor ruling — fix: ` in the rendered line equals `safeText` of that text with the cap `CHAIN_RULING_TEXT_CHARS`.
- [unit] `CHAIN_RULING_TEXT_CHARS` is `1200`.
- [unit] `parseChainRuling(renderChainRuling({ key: "f-1", outcome: "fix", text: "restore the guard" }))` deep-equals `{ outcome: "fix", text: "restore the guard" }`.
- [unit] `parseChainRuling(renderChainRuling({ key: "f-1", outcome: "waived", text: "base behaviour" }))` deep-equals `{ outcome: "waived", text: "base behaviour" }`.
- [unit] `parseChainRuling(renderChainRuling({ key: "f-1", outcome: "held", text: "low confidence" }))` deep-equals `{ outcome: "held", text: "low confidence" }`.
- [unit] `parseChainRuling` of a rendered `held` ruling with text `low confidence` and `proposed: { outcome: "waived", text: "spec excludes it" }` deep-equals `{ outcome: "held", text: "low confidence", proposed: { outcome: "waived", text: "spec excludes it" } }`.
- [unit] `parseChainRuling(withNaxBotMarker(renderChainRuling(ruling), chainRulingKey("f-1")))` deep-equals `parseChainRuling(renderChainRuling(ruling))`.
- [unit] `parseChainRuling("Recorded: waived — reason")` returns `null`.
- [unit] `parseChainRuling("Advisor ruling — settled: reason")` returns `null`.
- [unit] `parseChainRuling("Fixed in abc1234: Advisor ruling — waived: reason")` returns `null`.
- [unit] `parseChainRuling` of a body whose first line is `Fixed in abc1234` and whose second line is `Advisor ruling — waived: reason` returns `null`.

**Out of scope:**
- US-002 only: redaction, link breaking and mention neutralising themselves are `safeText`'s behaviour and are not re-tested here; the ACs assert that the rendered text is what `safeText` returns.

### US-003

Each AC builds the thread with a first comment by the bot carrying the finding marker key `f-1`. "An own chain ruling" is a comment by the bot wrapped with `withNaxBotMarker(renderChainRuling(ruling), chainRulingKey("f-1"))`.

- [unit] `latestFindingRuling` on a thread whose last comment is an own chain ruling with outcome `waived` returns a candidate whose `keyword.disposition` is `waived`.
- [unit] For that thread, the candidate's `keyword.reason` is the ruling text and its `index` is that comment's index.
- [unit] `latestFindingRuling` does not call `isWriter` for an own chain ruling comment.
- [unit] `latestFindingRuling` on a thread with an own `waived` chain ruling followed by a writer's reply `confirm` returns the candidate for the writer's reply, with disposition `confirmed`.
- [unit] `latestFindingRuling` on a thread with a writer's reply `confirm` followed by an own `waived` chain ruling returns the candidate for the chain ruling, with disposition `waived`.
- [unit] `latestFindingRuling` on a thread whose only reply is an own chain ruling with outcome `held` returns `null`.
- [unit] `latestFindingRuling` on a thread whose only reply is an own chain ruling with outcome `fix` returns `null`.
- [unit] `latestFindingRuling` on a thread with an own `waived` chain ruling followed by a reply `confirm` from an author for whom `isWriter` resolves `false` returns the candidate for the chain ruling.
- [unit] `latestFindingRuling` on a thread whose only reply is an own comment with the body `Advisor ruling — waived: reason` and the marker key `fix-f-1` returns `null`.
- [unit] `latestFindingRuling` on a thread whose only reply is a comment by another author with the body of a rendered `waived` chain ruling returns `null`.
- [unit] `recordFindingRulings` on an unresolved finding thread whose ruling is an own `waived` chain ruling returns that thread in `settled`.
- [unit] For that unresolved thread, `recordFindingRulings` calls `resolveThread` once and does not call `replyToThread`.
- [unit] `recordFindingRulings` on an already resolved finding thread whose ruling is an own `waived` chain ruling returns that thread in `settled` and calls neither `replyToThread` nor `resolveThread`.
- [integration] `readSettledKeys` given a thread opened by the bot for finding key `f-1` whose last comment is an own `waived` chain ruling returns a set that has `f-1`.
- [integration] `readSettledKeys` given the same thread with a writer's later reply `confirm` returns a set without `f-1`.
- [integration] `readConfirmedKeys` given the same thread with a writer's later reply `confirm` returns a set that has `f-1`.

**Out of scope:**
- US-003 only: writer authorization of the advisor's comment. An own comment is trusted because the bot wrote it; `ownComments` already matches the authenticated login and a valid marker.
- US-003 only: a chain ruling on a pull-request-level comment rather than a review thread. Chain rulings are posted only on finding threads.

### US-004

Every AC builds its environment with `makeBotFixEnv`. "A routed env" sets `advisor.enabled` and `advisor.callers.botFixChain` to `true` and makes the checkout's `changedFiles` name one feature's `prd.json` and `spec.md` under the features directory. "A chain finding" is an agreed finding with severity `important`, trigger `normal`, and `lineage.generation` 2.

- [unit] `chainRoutingContext` on a routed env returns an object whose `feature` is the changed feature's directory name.
- [unit] `chainRoutingContext` on a routed env returns a `specPath` equal to the `specPath` `featureIntentPaths(env.checkout)` returns.
- [unit] `chainRoutingContext` returns `null` when `advisor.callers.botFixChain` is `false`.
- [unit] `chainRoutingContext` returns `null` when `advisor.enabled` is `false` and `advisor.callers.botFixChain` is `true`.
- [unit] `chainRoutingContext` returns `null` for an env whose config has no `advisor` block.
- [unit] `chainRoutingContext` returns `null` when `changedFiles` names no `prd.json`.
- [unit] `chainRoutingContext` returns `null` when `changedFiles` names the `prd.json` of two features.
- [unit] `chainRoutingContext` returns `null` when `changedFiles` names one feature's `prd.json` and no `spec.md`.
- [unit] `ledgerFeature`, imported from `bot/ledger-carry`, returns the changed feature's directory name for a routed env.
- [unit] `selectChainFindings` returns a chain finding when `bot.chainNoticeGeneration` is 2.
- [unit] `selectChainFindings` does not return an agreed finding with `lineage.generation` 1 when `bot.chainNoticeGeneration` is 2.
- [unit] `selectChainFindings` returns an agreed finding with `lineage.generation` 3 when `bot.chainNoticeGeneration` is 3.
- [unit] `selectChainFindings` does not return an agreed finding with `lineage.generation` 2 when `bot.chainNoticeGeneration` is 3.
- [unit] `selectChainFindings` does not return a generation-2 finding whose severity is `minor`.
- [unit] `selectChainFindings` does not return a generation-2 finding whose origin is `fix-gap`.
- [unit] `selectChainFindings` does not return a generation-2 finding whose trigger is outside the review's blocking trigger set.
- [unit] `selectChainFindings` does not return a finding with no `lineage`.
- [unit] `selectChainFindings` does not return an agreed item of kind `thread` or of kind `comment`.
- [unit] `selectChainFindings` returns its findings in `review.agreed` order.
- [unit] For a chain finding with key `f-1`, when `env.threads` has a thread whose first comment is by `env.user.login` with marker key `f-1`, the returned `ChainFinding.thread` is that thread.
- [unit] For a chain finding with key `f-1`, when the only thread with marker key `f-1` on its first comment is authored by another login, the returned `ChainFinding.thread` is `undefined`.

### US-005

Every AC uses a routed env and a chain finding as defined in US-004, with key `f-1`, severity `important`, `file` `src/a.ts`, `line` 12, a `suggestion`, and `lineage` `{ generation: 2, pushSha: "abcdef1000000000000000000000000000000000", parents: ["f-p1", "f-p2"] }`. "The push sha" below is that 40-character value. `env.own` holds one own comment carrying a push ledger whose entry for the push sha lists `f-p1` with the issue `first parent issue` and does not list `f-p2`. `_chainQuestionDeps.runGit` is stubbed in every AC.

- [unit] `buildChainQuestion(env, finding, "my-feature")` returns a draft matching `{ kind: "bot-fix-chain", feature: "my-feature", dedupeKey: chainRulingKey("f-1"), findingSeverity: "important", anchorFile: "src/a.ts" }`.
- [unit] The draft's `options` deep-equal `buildMenu({ kind: "bot-fix-chain" })`.
- [unit] The draft's `rulingTitle` is the first line of the finding's issue.
- [unit] The draft's `summary` is `Finding f-1 (important) sits at generation 2 on lines nax bot fix abcdef1 added.`
- [unit] The draft's first `evidence` entry has `source` `finding`.
- [unit] That `finding` evidence text includes the finding's issue.
- [unit] That `finding` evidence text includes `src/a.ts:12`.
- [unit] That `finding` evidence text includes the finding's suggestion.
- [unit] The draft's second `evidence` entry has `source` `review-round`.
- [unit] That `review-round` evidence text includes `first parent issue`.
- [unit] That `review-round` evidence text includes `f-p2`.
- [unit] `_chainQuestionDeps.runGit` is called with the argument list `["diff", "<mergeBase>..HEAD", "--", "src/a.ts"]` (with the env's merge base) and the cwd `env.checkout.worktree`.
- [unit] `_chainQuestionDeps.runGit` is called with the argument list `["show", <the push sha>, "--", "src/a.ts"]` and the cwd `env.checkout.worktree`.
- [unit] The draft's `diff` evidence entry with `ref` `src/a.ts` has a text equal to the standard output of the stubbed `git diff`.
- [unit] The draft's `diff` evidence entry with `ref` equal to the push sha has a text equal to the standard output of the stubbed `git show`.
- [unit] With the stubbed `git diff` returning 20,000 characters, that entry's text is the first 12,000 of them followed by a newline and `(diff cut at 12000 characters)`.
- [unit] With the stubbed `git diff` returning exactly 12,000 characters, that entry's text is those characters with nothing appended.
- [unit] With `runGit` resolving a non-zero exit code for both commands, the draft's `evidence` sources are exactly `finding` then `review-round`.
- [unit] With `runGit` rejecting for `git diff` and resolving output for `git show`, the `ref` values of the draft's `diff` entries are exactly the push sha.
- [unit] For a chain finding with no `file`, `runGit` is not called.
- [unit] `CHAIN_DIFF_CHARS` is `12000`.

### US-006

Every AC uses a routed env as defined in US-004, with one chain finding that has key `f-1`, an own thread, a `suggestion` and severity `important`, unless it says otherwise. `_chainAdviseDeps.createAdvisor` is stubbed to return an object whose `advise` is a stub that, unless the AC says otherwise, resolves a decision with action `fix`, instruction `restore the guard` and `needsHumanConfirm` false; `buildChainQuestion`, `replyToThread` and `resolveThread` in `_chainAdviseDeps` are stubs, with `buildChainQuestion` resolving a fixed draft; `readConfirmedKeys` is stubbed to resolve an empty set. "The posted body" is the body argument of the one `replyToThread` call.

- [unit] With `advisor.callers.botFixChain` false, `withChainRulings` resolves to the same `env` object it was given.
- [unit] With no chain finding in `review.agreed`, `withChainRulings` resolves to the same `env` object it was given.
- [unit] `withChainRulings` calls `createAdvisor` with an object matching `{ callCtx: env.ctx.callCtx, repoRoot: env.repoRoot, workdir: env.checkout.worktree, outputDir: env.ctx.callCtx.runtime.outputDir, runId: env.ctx.callCtx.runtime.runId, feature, specPath }` where `feature` and `specPath` are the values `chainRoutingContext(env)` returns.
- [unit] `advise` is called with the draft the stubbed `buildChainQuestion` resolves and `{ findingSeverity: "important" }`.
- [unit] With `env.ctx.sessionScope` set to a wrapper that records whether it is running, `advise` is called while the wrapper is running.
- [unit] When `advise` resolves a decision with action `fix`, instruction `restore the guard` and `needsHumanConfirm` false, the returned env's `review.agreed` deep-equals the input's.
- [unit] For that `fix` decision, the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "fix", text: "restore the guard" }]`.
- [unit] For that `fix` decision, `replyToThread` is called with the finding's own thread and the body `withNaxBotMarker(renderChainRuling({ key: "f-1", outcome: "fix", text: "restore the guard" }), chainRulingKey("f-1"))`.
- [unit] For that `fix` decision, `resolveThread` is not called.
- [unit] When `advise` resolves a decision with action `waive`, reason `base behaviour` and `needsHumanConfirm` false, the returned env's `review.agreed` has no item with key `f-1`.
- [unit] For that `waive` decision, `parseChainRuling` of the posted body deep-equals `{ outcome: "waived", text: "base behaviour" }`.
- [unit] For that `waive` decision, `resolveThread` is called with the finding's own thread.
- [unit] When `advise` resolves a decision with action `hold` and reason `needs a product call`, `parseChainRuling` of the posted body deep-equals `{ outcome: "held", text: "needs a product call" }`.
- [unit] For that `hold` decision, the returned env's `review.agreed` has no item with key `f-1`.
- [unit] When `advise` resolves a decision with action `waive`, reason `r`, rationale `not sure` and `needsHumanConfirm` true, `parseChainRuling` of the posted body deep-equals `{ outcome: "held", text: "not sure", proposed: { outcome: "waived", text: "r" } }`.
- [unit] When `advise` resolves a decision with action `fix`, instruction `i`, rationale `not sure` and `needsHumanConfirm` true, `parseChainRuling` of the posted body deep-equals `{ outcome: "held", text: "not sure", proposed: { outcome: "fix", text: "i" } }`.
- [unit] When `advise` resolves `{ decision: null, fallbackReason: "no-output" }`, the returned env's `review.agreed` deep-equals the input's.
- [unit] For that `null` decision, `replyToThread` is not called.
- [unit] When `advise` resolves a decision with action `defer`, `replyToThread` is not called.
- [unit] With two chain findings `f-1` and `f-2`, when `advise` rejects for `f-1` and resolves a `waive` decision for `f-2`, `withChainRulings` resolves an env whose agreed finding keys are exactly `f-1`.
- [unit] When `replyToThread` rejects for a `waive` decision, the returned env's `review.agreed` deep-equals the input's.
- [unit] When `resolveThread` rejects for a `waive` decision, `withChainRulings` resolves an env whose `chainRulings` deep-equals `[{ key: "f-1", outcome: "waived", text: "base behaviour" }]`.
- [unit] For a chain finding with no own thread, `advise` is not called.

**Out of scope:**
- US-006 only: composition tests 2, 4, 5 and 6 and the `readConfirmedKeys` read are US-007's code; here `readConfirmedKeys` is stubbed and not asserted on, and `env.cost` is never at its limit.
- US-006 only: the forced-confirm rule for a `critical` waive is the advisor service's; it is exercised through the real service in US-008's integration ACs, not here.

### US-007

Every AC uses the setup stated at the top of US-006, with `env.cost.spentUsd()` returning 0 and `env.cost.limitUsd` 5 unless it says otherwise. "An existing chain ruling" is an own comment on the finding's own thread, wrapped with `withNaxBotMarker(renderChainRuling(ruling), chainRulingKey("f-1"))`.

- [unit] `withChainRulings` calls `readConfirmedKeys` once, with an input matching `{ threads: env.threads, login: env.user.login }`.
- [unit] When `readConfirmedKeys` rejects, `withChainRulings` rejects with the same error.
- [unit] Regression guard (already green after US-006): with no chain finding in `review.agreed`, `readConfirmedKeys` is not called.
- [unit] When `readConfirmedKeys` returns a set with `f-1`, the returned env's `review.agreed` deep-equals the input's.
- [unit] When `readConfirmedKeys` returns a set with `f-1`, `advise` is not called.
- [unit] With an existing chain ruling of outcome `fix` and text `restore the guard`, the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "fix", text: "restore the guard" }]`.
- [unit] With that existing `fix` ruling, `advise` is not called.
- [unit] With that existing `fix` ruling, `replyToThread` is not called.
- [unit] With an existing chain ruling of outcome `held` and text `needs a product call`, the returned env's `review.agreed` has no item with key `f-1`.
- [unit] With that existing `held` ruling, the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "held", text: "needs a product call" }]`.
- [unit] With that existing `held` ruling, `advise` is not called.
- [unit] With an existing chain ruling of outcome `waived`, the returned env's `review.agreed` has no item with key `f-1`.
- [unit] With an existing chain ruling of outcome `held` and `readConfirmedKeys` returning a set with `f-1`, the returned env's `review.agreed` deep-equals the input's.
- [unit] With two existing chain rulings on the own thread, `held` then `fix` with text `restore the guard`, the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "fix", text: "restore the guard" }]`.
- [unit] With an existing `fix` chain ruling followed on the thread by an own comment with marker key `fix-f-1`, `parseChainRuling` of the posted body deep-equals `{ outcome: "held", text: "raised again after an advisor-ruled fix" }`.
- [unit] In that case the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "held", text: "raised again after an advisor-ruled fix" }]`.
- [unit] With an own comment with marker key `fix-f-1` followed on the thread by an existing `fix` chain ruling with text `restore the guard`, the returned env's `chainRulings` deep-equals `[{ key: "f-1", outcome: "fix", text: "restore the guard" }]`.
- [unit] For a chain finding with no existing chain ruling whose `lineage.parents` is `["f-p1"]`, when another thread of the pull request has an own chain ruling comment with marker key `chainRulingKey("f-p1")`, `parseChainRuling` of the posted body deep-equals `{ outcome: "held", text: "a second finding on this chain" }`.
- [unit] In that case `advise` is not called.
- [unit] With two chain findings `f-1` and `f-2` where `f-2`'s `lineage.parents` is `["f-1"]`, and `advise` resolving a `waive` decision, `advise` is called once.
- [unit] Regression guard (already green after US-006): an own comment on another thread with marker key `chainRulingKey("f-p1")` and the body `not a ruling` does not hold a finding whose `lineage.parents` is `["f-p1"]`; `advise` is called.
- [unit] Regression guard (already green after US-006): an own comment on the finding's own thread with marker key `chainRulingKey("f-1")` and the body `not a ruling` is not an existing chain ruling; `advise` is called.
- [unit] With `env.cost.spentUsd()` returning 5 and two chain findings, `advise` is not called.
- [unit] With `env.cost.spentUsd()` returning 0 before the first call and 5 before the second, and two chain findings, `advise` is called once.

### US-008

- [unit] `chainInstructions({ chainRulings: [{ key: "f-1", outcome: "fix", text: "a" }, { key: "f-2", outcome: "held", text: "b" }] })` returns a map whose entries are exactly `["f-1", "a"]`.
- [unit] `chainInstructions({})` returns an empty map.
- [unit] `findingFactLines(item, entries, blocking, "restore the guard")` for a finding returns lines whose last is `Advisor ruling: restore the guard`.
- [unit] `findingFactLines(item, entries, blocking)` for a finding returns no line starting with `Advisor ruling:`.
- [unit] `findingFactLines` given an instruction for an agreed item of kind `thread` returns an empty list.
- [unit] `toFixFindings(items, new Map([["f-1", "restore the guard"]]))` returns, for the finding with key `f-1` that has a `suggestion`, a finding with no `suggestion` field.
- [unit] `toFixFindings(items, new Map([["f-1", "x"]]))` returns the `suggestion` unchanged for a finding with key `f-2`.
- [unit] `toFixFindings(items)` returns the `suggestion` unchanged for every finding that has one.
- [unit] `summaryBody` for an env whose `chainRulings` has one `fix`, one `waived` and one `held` entry includes the line `Advisor ruled on 3 findings that sit on earlier nax bot fixes: 1 to fix, 1 waived, 1 held for a human.`
- [unit] `summaryBody` for an env whose `chainRulings` has one `held` entry includes the line `Advisor ruled on 1 finding that sits on earlier nax bot fixes: 1 held for a human.`
- [unit] `summaryBody` for an env whose `chainRulings` has two `fix` entries includes the line `Advisor ruled on 2 findings that sit on earlier nax bot fixes: 2 to fix.`
- [unit] `summaryBody` for an env with no `chainRulings` includes no line starting with `Advisor ruled on`.
- [unit] `summaryBody` for an env whose `chainRulings` is an empty list includes no line starting with `Advisor ruled on`.
- [integration] `runBotFix` with `_botFixDeps.withChainRulings` stubbed to return the env with `chainRulings` `[{ key: <item key>, outcome: "fix", text: "restore the guard" }]`: the prompt passed to the stubbed fix session includes `Advisor ruling: restore the guard`.
- [integration] In that run, the findings passed to the stubbed fix session hold that item with no `suggestion`.
- [integration] `runBotFix` with `_botFixDeps.withChainRulings` stubbed to return the env with its only agreed item removed does not start the fix session.
- [integration] `runBotFix` with `readyOnly: true` does not call `_botFixDeps.withChainRulings`.
- [integration] `runBotFix` calls `_botFixDeps.withChainRulings` once, with an env whose `review.agreed` includes the items `withCarriedFixFindings` merged.
- [integration] `runBotFix` on a routed pull request with one chain finding, with the real `withChainRulings` and `_chainAdviseDeps.createAdvisor` stubbed to return an advisor whose `advise` resolves a `fix` decision with instruction `restore the guard`: the prompt passed to the stubbed fix session includes `Advisor ruling: restore the guard`.
- [integration] In that run, the forge receives one thread reply whose body `parseChainRuling` reads as outcome `fix`.
- [integration] In `test/integration/bot/chain-advise-service.test.ts`, with `env.repoRoot` and the runtime's `outputDir` set to temporary directories and `_advisorServiceDeps.captureWorktreePatch` and `_advisorServiceDeps.readPrdText` (both in `src/advisor/service-helpers.ts`) stubbed: `withChainRulings` on a routed env with one chain finding of severity `critical`, with the real `createAdvisor` and `_advisorServiceDeps.callOp` stubbed to return a valid reply that picks the `waive` option with `confidence: "high"`, `reversible: true` and `needsHumanConfirm: false`: `parseChainRuling` of the posted body returns outcome `held` with `proposed.outcome` `waived`.
- [integration] The same call, with the same temporary directories and stubs, for a chain finding of severity `important` posts a body that parses as outcome `waived`.

**Out of scope:**
- US-008 only: an end-to-end run with a real advisor model session. The advisor's model call is stubbed at `_advisorServiceDeps.callOp` or at `createAdvisor`.

### US-009

Each AC calls `readyStep` with an env built by `makeBotFixEnv` for a draft pull request whose CI is green, with `_fixReportDeps` stubbed so that no key is settled or confirmed unless the AC says otherwise.

- [unit] With `review.agreed` empty and `chainRulings` `[{ key: "f-1", outcome: "held", text: "needs a product call" }]`, `readyStep` returns a patch with no `markedReady: true`.
- [unit] In that case the patch's `readyHeld` includes `f-1`.
- [unit] With `review.agreed` empty and `chainRulings` `[{ key: "f-1", outcome: "fix", text: "restore the guard" }]`, the patch's `readyHeld` does not include `f-1`.
- [unit] With `review.agreed` empty and `chainRulings` `[{ key: "f-1", outcome: "waived", text: "base behaviour" }]`, the patch's `readyHeld` does not include `f-1`.
- [unit] With `review.agreed` holding a blocking finding `f-1` and `chainRulings` holding a `held` entry for `f-1`, the patch's `readyHeld` names `f-1` once.
- [unit] With `review.agreed` empty, a `held` entry for `f-1` in `chainRulings`, and the settled keys read from the pull request including `f-1`, the patch's `readyHeld` does not include `f-1`.

**Out of scope:**
- US-009 only: a ready-only pass. It does not run the routing, has no `chainRulings`, and reads the unfiltered review artifact, where a held finding is still an open blocking finding.
