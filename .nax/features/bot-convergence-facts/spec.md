# SPEC: bot-convergence-facts — bot findings carry a trigger class and a lineage, the bot keeps a record of its own pushes, and status and summaries show what really blocks

Closes: #2988, #2979, #2981, #2982

## Summary

`nax bot review` and `nax bot fix` gain the facts they need to stop chasing their own fixes. (1) Every review finding carries a `trigger` class (`normal`, `own-concurrency`, `adversarial`, `manual`) and a one-line `triggerEvidence`. (2) A configured set of blocking triggers (`bot.blockingTriggers`, default `normal` and `own-concurrency`), which one writer comment can override per PR, decides with severity whether a finding holds readiness; one shared predicate answers that for review posting, the fix step, readiness and `nax workflow status`. (3) `nax bot fix` records every push it makes (range, item keys, each item's generation and issue line) in a hidden append-only block of its own `fix-summary` comment. (4) `nax bot review` gives each finding a lineage: from `git blame` of its anchor line against that record, the generation and the items whose fix wrote the line. (5) The reviewer prompt lists the bot pushes inside its range; the fixer prompt gets each finding's trigger and lineage plus the lines earlier bot pushes added outside the feature's declared files. (6) A review whose agreed items include nothing that can hold readiness no longer causes a push. (7) `nax workflow status` lists unsettled blocking bot finding threads, the review summary counts them next to the indexed items, and the fix summary shows the number of bot fix pushes and a "Findings are chasing their own fixes" section once a blocking finding reaches the notice generation.

## Motivation

Design: `docs/superpowers/specs/2026-11-19-bot-convergence-facts-design.md` (approved 2026-11-19). On `openai-codex/gpt-6.2-sol[high]`, PR #2978 took 11 bot review rounds and 21 Important findings; the 22 PRs before it on 6.1-sol took a median of 1 round, at most 3. Each finding was real, but each round's findings sat increasingly on the previous round's fix (a tie check grew a lock, the lock grew claim files, the claim files grew a reclaim path, each drawing an Important finding). Nothing told the reviewer, the fixer or the operator that the work was going round:

- #2988: findings have a severity but no trigger, so a finding that needs a forged mtime blocks exactly like one reachable in normal use. A scope ruling posted as a PR comment worked only as long as the reviewer re-read it.
- #2982 and #2987 (points 1 and 3): no record links a finding to the bot fix that wrote its lines, so no signal says the findings are chasing their own fixes. #2987 point 2 (routing such a chain to an advisor) is part 2 of this work and not in this feature.
- #2979: `nax bot fix` acts on every agreed item, minor ones included, while readiness waits only on critical and important ones; a minor posted only in the summary triggered a push that reversed a human's decision and reset readiness.
- #2981: `nax workflow status` printed `No open items.` for PR #2978 while three Important bot inline findings held readiness, because it counts only the item index.

User rulings (2026-11-19): facts first, a separate later spec for advisor routing; the lineage record lives in the bot's own `fix-summary` comment. Agents receive facts, never orders: no prompt text tells them what to do with a trigger or a lineage.

## Design

### Approach

**Shared vocabulary.** New `packages/nax/src/workflow/blocking-findings/index.ts`, a nested barrel imported as `@/workflow/blocking-findings` (not through the `@/workflow` barrel, which imports `@/operations` and `@/config` and would close an import cycle from `config/schemas-bot.ts` and `operations/bot-pr-review-reply.ts`; `bun run check:import-cycles` must stay at its baseline). It uses only `import type` for `PrComment`, `WorkflowSeverity` and config types. `bot/` already imports `workflow/`; `workflow/` never imports `bot/`. It holds:

```typescript
export const FINDING_TRIGGERS = ["normal", "own-concurrency", "adversarial", "manual"] as const;
export type FindingTrigger = (typeof FINDING_TRIGGERS)[number];
export const DEFAULT_BLOCKING_TRIGGERS: readonly FindingTrigger[] = ["normal", "own-concurrency"];
/** Missing or unknown reads as "normal", so an unclassified finding still blocks. */
export function parseFindingTrigger(value: unknown): FindingTrigger;
/** Critical or important AND trigger in the set; an absent trigger reads "normal". */
export function isBlockingFinding(
  finding: { readonly severity: WorkflowSeverity; readonly trigger?: FindingTrigger },
  blocking: readonly FindingTrigger[],
): boolean;
/** Severity and trigger read back from a bot finding thread body (first comment). */
export function readFindingThreadFacts(body: string): { severity: WorkflowSeverity; trigger: FindingTrigger };
/** The plain first line of a finding issue: no severity label, no Trigger:/Lineage: lines. */
export function firstIssueLine(issue: string): string;
export const DEFAULT_CHAIN_NOTICE_GENERATION = 2;
/** `config.bot` is optional on NaxConfig: absent keys read as the defaults. */
export function configuredBlockingTriggers(config: { readonly bot?: { readonly blockingTriggers?: readonly FindingTrigger[] } }): readonly FindingTrigger[];
export function configuredChainNoticeGeneration(config: { readonly bot?: { readonly chainNoticeGeneration?: number } }): number;
/** The effective set for one PR: the newest writer scope-ruling comment, else the configured set. */
export function effectiveBlockingTriggers(input: {
  readonly comments: readonly PrComment[];
  readonly writers: ReadonlySet<string>;
  readonly configured: readonly FindingTrigger[];
}): { triggers: readonly FindingTrigger[]; source: "config" | { readonly commentId: string; readonly author: string }; invalid: readonly string[] };
```

`readFindingThreadFacts` reads the severity from the leading `**Critical**` / `**Important**` / `**Minor**` label (absent label = `important`, as `mergeEarlier` does today) and the trigger from a line starting `Trigger: <class>` (absent or unknown = `normal`). `firstIssueLine` drops a leading `**<Severity>** (<kind>): ` prefix, drops every line starting `Trigger:` or `Lineage:`, and returns the first remaining non-empty line, trimmed. A scope ruling is a top-level PR comment whose author is in `writers` and whose first non-empty line, trimmed and compared case-insensitively, matches `blocking triggers: <class>[, <class>...]`; a line starting `>`, `-` or `*` is not a match. Every class must be one of the four and the list must be non-empty, otherwise the comment is ignored and its first line is reported in `invalid`. The newest matching comment (by `createdAt`) wins. Any non-empty subset is allowed, narrower or wider than config.

**US-001 — trigger class.** `PrFinding` (`operations/bot-types.ts`) gains optional `trigger?: FindingTrigger` and `triggerEvidence?: string`. `parsePrReviewReply` (`operations/bot-pr-review-reply.ts`) always sets `trigger` with `parseFindingTrigger(entry.trigger)` and keeps `triggerEvidence` when it is a non-empty string, trimmed and capped at 300 characters. `TASK_CONTRACT` (`prompts/builders/bot-pr-review-builder.ts`) adds `"trigger": "normal|own-concurrency|adversarial|manual", "triggerEvidence": "..."` to the finding shape and one definition line per class, worded as what to report:
- `normal`: reachable in ordinary use of the product
- `own-concurrency`: needs two of the tool's own processes or sessions interleaving
- `adversarial`: needs a deliberate actor (forged metadata, input the threat model excludes, shadowed builtins)
- `manual`: needs a human acting on the checkout or state mid-operation
The finding arm of `AgreedItem` (`bot/post.ts`) gains optional `trigger?: FindingTrigger` and `triggerEvidence?: string`; `agreedItems` copies each when present on the verdict finding. `mergeEarlier` sets `trigger` from `readFindingThreadFacts` of the earlier thread's first comment only when that comment has a `Trigger:` line, and removes `Trigger:` lines from the earlier item's `issue`. `renderFindingComment` (`bot/render-comments.ts`) takes `PrFinding`-shaped input and adds, after the issue and a blank line, and before the suggestion paragraph, the line `Trigger: <class>` followed by ` - <evidence>` when evidence is present, only when `trigger` is set; evidence goes through `safeText`. The finding's key (`findingKey`) is unchanged.

**US-002 — blocking vocabulary and config.** `BotConfigSchema` (`config/schemas-bot.ts`) gains flat keys `blockingTriggers: z.array(z.enum(FINDING_TRIGGERS)).min(1).default(["normal", "own-concurrency"])` and `chainNoticeGeneration: z.number().int().min(1).default(2)`, each with a description in `cli/config-descriptions.ts`; the hand-written `BotConfig` interface (`config/runtime-types-bot.ts`) gains optional `blockingTriggers?: readonly FindingTrigger[]` and `chainNoticeGeneration?: number`. `NaxConfig.bot` is optional (`config/runtime-types.ts:383`), so every consumer reads the keys only through `configuredBlockingTriggers(config)` and `configuredChainNoticeGeneration(config)`, which return `DEFAULT_BLOCKING_TRIGGERS` and `DEFAULT_CHAIN_NOTICE_GENERATION` when `bot` or the key is absent. `blocking-findings/index.ts` gains `isBlockingFinding`, `readFindingThreadFacts`, `firstIssueLine`, `effectiveBlockingTriggers`, `configuredBlockingTriggers` and `configuredChainNoticeGeneration`.

**US-003 — the blocking set decides posting and readiness.** `nax bot review` (`bot/review-run.ts`, while building the review env, through a new helper module `bot/review-convergence.ts` so `review-run.ts` (496 lines) grows by no more than the call) computes `effectiveBlockingTriggers` from the PR's top-level comments, the writer set it already reads (`readWriters`, `bot/writers.ts:20`) and `configuredBlockingTriggers(config)`, and passes it on `PostReviewInput` as `blockingTriggers`, `blockingSource` and `ignoredScopeRulings`. Then:
- `postFindings` (`bot/post.ts`) handles a critical or important finding that has a file and line and is not blocking under that set the way it handles a minor today: no new inline thread, an existing own thread for the key is still edited (and that finding is then not listed as residual), and it is returned in a new `residual` list. A non-blocking finding with no file or line stays in `offLine`, as today.
- `ReviewSummaryInput` (`bot/render-comments.ts`) gains `residual?`, `blockingTriggers?`, `blockingSource?` and `ignoredScopeRulings?`. The summary renders `### Residual findings (not blocking)` with `- <Severity> <file>:<line>: <issue> (trigger <class> - <evidence>)` per residual, all author text through `safeText`; a line `Blocking triggers: <a>, <b> (config)` or `Blocking triggers: <a> (PR comment by @<author>)`; and `Ignored scope ruling: <first line>` per ignored comment.
- `BotReviewArtifact` (`bot/post.ts`) gains optional `blockingTriggers?: readonly FindingTrigger[]`, the effective set.
- New `reviewBlockingTriggers(env: BotFixEnv): readonly FindingTrigger[]` (new `bot/review-blocking.ts`) returns `env.review.blockingTriggers ?? env.codeReview?.blockingTriggers ?? configuredBlockingTriggers(env.config)`, so a newer conversation-only review's set wins over the older code review's. `blockingKeys` (`bot/fix-report.ts:343`) becomes `blockingKeys(review: BotReviewArtifact, blocking: readonly FindingTrigger[]): string[]` and keeps a finding when `isBlockingFinding(item, blocking)`; `openFindingHold` passes `reviewBlockingTriggers(env)`.

**US-004 — push ledger.** New `packages/nax/src/bot/push-ledger.ts`:

```typescript
export interface BotPushItem { readonly key: string; readonly generation: number; readonly issue: string }
export interface BotPushEntry { readonly base: string; readonly sha: string; readonly at: string; readonly items: readonly BotPushItem[] }
export interface FindingLineage { readonly generation: number; readonly parents: readonly string[]; readonly pushSha: string }
export const MAX_PUSH_ENTRIES = 64;
/** Encoded block budget, well under the forge's 65,536-character comment limit. */
export const MAX_LEDGER_CHARS = 24_000;
export function readPushLedger(body: string): { entries: readonly BotPushEntry[]; unreadable: boolean };
export function withPushLedger(body: string, entries: readonly BotPushEntry[]): string;
export function appendPushEntry(entries: readonly BotPushEntry[], entry: BotPushEntry): readonly BotPushEntry[];
```

The block is one line `<!-- nax-bot:pushes v1 <base64 of JSON array> -->`, which `markerPattern` does not match. `withPushLedger` replaces an existing block or inserts one immediately before the body's `nax-bot:v1` marker line; an empty list writes no block. `appendPushEntry` keeps the newest `MAX_PUSH_ENTRIES`, then drops the oldest entries until the encoded block is at most `MAX_LEDGER_CHARS` characters (a single entry over the budget keeps only its first items that fit). `readPushLedger` returns `unreadable: true` and no entries for a block whose base64 or JSON does not parse or whose entries lack `base`, `sha` (40 hex) or `items`. An item's `issue` is `firstIssueLine` of the agreed item's issue, capped at 120 characters. The finding arm of `AgreedItem` gains optional `lineage?: FindingLineage` and `lineageUnknown?: true` (US-005 sets them). `reportStep` (`bot/fix-report.ts`) reads the ledger from the own `fix-summary` comment in `env.own`, appends `{ base: env.info.headSha, sha: state.pushedSha, at: <ISO now>, items: <one per env.review.agreed item: key, item.lineage?.generation ?? 0, issue> }` when `state.outcome === "pushed"`, and writes the body through `withPushLedger`; every other outcome carries the read entries forward unchanged. An unreadable block is replaced by the new entries only and logged at warn. The ready-only summary rewrite `nameWaiverInSummary` (`bot/ci-waiver-ready.ts:149`) keeps the block as a non-readiness line.

**Line budget.** `bot/fix-report.ts` is at 596 of the 600-line source limit (`bun run check:file-sizes`, not grandfathered). US-004 first moves the private `outcomeText` function (about 45 lines) unchanged into new `bot/fix-outcome-text.ts`, which `renderFixSummary` imports; the ledger read-append-write lives in `push-ledger.ts` as `ledgerBody(previous: string | undefined, entry: BotPushEntry | undefined, body: string): string`. Every later story keeps `fix-report.ts` at or under 600 lines by putting new logic in the new modules named here.

**US-005 — lineage.** New `packages/nax/src/bot/lineage.ts` with `computeLineage(input: { targets: readonly { readonly key: string; readonly file?: string; readonly line?: number }[]; entries: readonly BotPushEntry[]; worktree: string; head: string }, deps = _lineageDeps): Promise<{ lineage: ReadonlyMap<string, FindingLineage>; unknown: ReadonlySet<string>; unreachable: number }>` keyed by target `key`. Exit codes: `git merge-base --is-ancestor` exit 0 is yes and exit 1 is no; any other exit code or a spawn failure is an error. Procedure: an entry is reachable when `git merge-base --is-ancestor <entry.sha> <head>` exits 0; an entry whose check exits 1, or errors, is skipped and counted in `unreachable` (an error is also logged at warn). For each target with `file` and `line`, `git blame --porcelain -L <line>,<line> <head> -- <file>` names commit `C`; the newest reachable entry for which `C` equals `entry.sha`, or `C` is an ancestor of `entry.sha` and not of `entry.base`, is the match. A match gives `{ generation: 1 + max(entry.items' generation, 0), parents: entry.items' keys, pushSha: entry.sha }`; no match gives no lineage (generation 0). A `git blame` exiting non-zero, or a matching ancestry check that errors (not exit 1), puts the target's key in `unknown`. `_lineageDeps.runGit` is injectable. Wiring: while building the review env (`reviewEnvironment`), `bot/review-convergence.ts` reads the ledger from the bot's own `fix-summary` comment and, for an incremental range, selects the prompt's `botPushes` with `_botReviewDeps.isAncestor`; `PostReviewInput` gains `botPushes?: readonly BotPushEntry[]` and `worktree?`, read only by the review graph's `post` node. That node (`bot/review-run.ts`) runs `computeLineage` with `{ runGit: _botReviewDeps.runGit }` before calling `postPrReview` and passes the result as `PostReviewInput.lineage?: { lineage; unknown; unreachable }`. Its targets are every verdict finding (keyed by `findingKey`) and every open earlier thread that has `path` and `line` (keyed by the same key `mergeEarlier` gives its item), so a finding carried over from an earlier round keeps its lineage. `agreedItems` copies `lineage` / `lineageUnknown` onto the finding items; `BotReviewArtifact` gains optional `unreachablePushes?: number`. `renderFindingComment` adds, on the line directly after the trigger line (or after the issue and a blank line when there is no trigger), `Lineage: generation <n>, on lines added by nax bot fix <sha7> for <parent keys joined ", ">` when lineage is present. For an incremental review, `PrReviewInput` (`bot/review-step.ts`) and `BotPrReviewPromptInput` gain `botPushes?: readonly BotPushEntry[]`, the reachable entries whose `sha` is not an ancestor of the range base; `reviewPrompt` passes them and the prompt renders a section `## Earlier nax bot fix pushes in this range` with one line per item: `- <base7>..<sha7>: nax bot fix for <key> (<issue>), generation <n>`. No sentence in that section says what to do with it. `mergeEarlier` also removes `Lineage:` lines from an earlier item's `issue`.

**US-006 — fixer facts.** `BotPrFixPromptInput` (`prompts/builders/bot-pr-fix-builder.ts`) gains `findingFacts?: readonly { readonly id: string; readonly lines: readonly string[] }[]` and `outsideGrowth?: readonly { readonly path: string; readonly added: number }[]`. `buildBotPrFixPrompt` renders, when either is non-empty, a section `## Facts about these findings`: per finding `- <id>:` then its lines indented; then, when `outsideGrowth` is non-empty, ``Lines added by earlier nax bot fix pushes on this PR in files outside the feature's declared files: `<path>` +<n>, ...`` (largest first, at most 10, then `and <k> more`). Per-finding lines (new `bot/fix-facts.ts`, `findingFactLines(item, ledger, blocking)`): `Trigger: <class>` plus ` - <evidence>` when the item has a trigger; `Lineage: generation <n>, on lines added by nax bot fix <sha7> for <key> (<issue>)` per parent, the issue taken from the ledger item; `Not blocking readiness (minor or trigger outside the blocking set)` when `isBlockingFinding` is false; nothing for thread and comment items. `outsideDeclaredGrowth(input, deps)` in `bot/fix-facts.ts`: the feature's declared files are the union over the PRD's stories (PRD from `featureIntentPaths(env.checkout).prdPath`, loaded with `loadPRD`) of `contextFiles` paths, `expectedFiles` and `modifiedFiles` paths, each also joined with the story's `workdir` when it has one; for each ledger entry, `git diff --numstat <base> <sha>` (through injectable `deps.runGit`, in the checkout worktree) gives added lines per path; paths outside the declared set are summed. No PRD, an unreadable PRD or a failed diff gives `undefined` (logged at debug). `fixStep` (`bot/fix-steps.ts`) passes both to `buildBotPrFixPrompt`; `toFixFindings` and `WorkflowFinding` are unchanged.

**US-007 — no push for non-blocking only.** `BotFixState` (`bot/fix-steps.ts`) gains `followUps?: readonly { readonly key: string; readonly severity: WorkflowSeverity; readonly trigger: FindingTrigger }[]`, and the `fix` node's `produces` in `bot/fix-run.ts` gains `"followUps"` (the step graph rejects an undeclared patch key, `step-graph/run.ts:76`). `fixStep` returns `{ patch: { agreedCount, outcome: "nothing", followUps }, exit: "nothing" }` without starting a fix session when `env.review.agreed` is non-empty and no item is push-worthy; an item is push-worthy when it is a `thread` or `comment` item, or a `finding` for which `isBlockingFinding(item, reviewBlockingTriggers(env))` holds. `followUps` lists each agreed finding's key, severity and trigger (`normal` when absent). The fix summary's `nothing` text (in `bot/fix-outcome-text.ts`) reads `No fix session: no agreed item can hold readiness. Left for follow-up: <key> (<Severity>, <trigger>), ...` (at most 10, then `and <k> more`) when `followUps` is non-empty, and `Nothing to fix: the latest review agreed with no item.` otherwise. When something is push-worthy, every agreed item still goes to the fixer as today. If the later ledger node pushes the advisor ledger, the existing `Pushed <sha>: advisor ledger.` line is listed first and the follow-up line after it.

**US-008 — status and summary.** New `packages/nax/src/bot/blocking-threads.ts` exports `readBlockingFindingThreads(input: { ref; threads; comments; login; configured: readonly FindingTrigger[]; deps; cwd }): Promise<readonly OpenItem[]>`: every review thread whose first comment is by `login`, carries a `nax-bot:v1` marker key starting `f-`, is not resolved, is not settled by `readSettledKeys` (`bot/rulings.ts:454`, the same reader readiness uses; its input type `SettlementReadInput` (`bot/rulings.ts:395`) becomes `Omit<RecordRulingsInput, "readModel" | "callerRulings" | "info">`, since the reader never uses `info` and the status path has only the PR URL), and for which `isBlockingFinding(readFindingThreadFacts(body), effectiveBlockingTriggers({ comments, writers, configured }).triggers)` holds, as `{ id: <key>, kind: "finding", severity, file: thread.path, line: thread.line, issue: "bot review: " + firstIssueLine(<body without marker>) }`; `writers` from `readWriters` with the forge permission check. `WorkflowForgeDeps` (`cli/workflow-forge.ts`) gains `readBlockingTriggers: (dir: string) => Promise<readonly FindingTrigger[]>`, defaulting to `configuredBlockingTriggers(await loadConfig(dir))` and to `DEFAULT_BLOCKING_TRIGGERS` when loading fails. `buildReport` (`cli/workflow.ts`), on the live path only (after `readLiveStatus` returns the live arm), reads the PR threads and comments, calls `readBlockingFindingThreads` and appends its items to `openItems`, so `No open items.` is not printed and the exit code is 2 while one exists; a failure of that read is logged at warn and adds nothing. The review summary's open-items line (`itemStatusLines`, `bot/render-comments.ts`, which gains a `blockingCount` argument from `ReviewSummaryInput.blockingCount?`) becomes `Open items: <open> of <total> indexed; <k> blocking review findings.` when `k` (agreed findings that pass `isBlockingFinding` under the effective set) is above 0, and is unchanged otherwise. New `bot/convergence-summary.ts` exports `convergenceLines(input: { entries: readonly BotPushEntry[]; unreachable: number; agreed: readonly AgreedItem[]; blocking: readonly FindingTrigger[]; noticeGeneration: number }): string[]`, called from `reportStep` with the ledger after the append, `env.review.unreachablePushes ?? 0`, `env.review.agreed`, the effective set and `configuredChainNoticeGeneration(env.config)`. It returns `nax bot fix pushes on this PR: <n>` once the ledger has an entry, with ` (<u> no longer in history)` when `u > 0`, and, when any blocking agreed finding has `lineage.generation >= noticeGeneration`, the heading `### Findings are chasing their own fixes` with one line per such finding: `- <key> (<Severity>, <trigger>), generation <n>: on lines added by nax bot fix <sha7> for <parent key> (<parent issue>)`. The section names the chain only; it carries no advice.

### Test placement

- `test/unit/workflow/blocking-findings.test.ts` (new): US-002.
- `test/unit/operations/bot-pr-review-reply.test.ts`, `test/unit/prompts/bot-pr-review-builder.test.ts`, `test/unit/bot/render-comments.test.ts`, `test/integration/bot/post.test.ts` (existing): US-001.
- `test/unit/config/bot-config.test.ts` (existing): US-002.
- `test/integration/bot/post-threads.test.ts`, `test/integration/bot/fix-ready-holds.test.ts`, `test/unit/bot/review-run.test.ts` (existing): US-003.
- `test/unit/bot/push-ledger.test.ts` (new), `test/unit/bot/fix-report.test.ts`, `test/integration/bot/fix-report.test.ts` (existing): US-004.
- `test/unit/bot/lineage.test.ts` (new), `test/unit/bot/review-run.test.ts` (existing): US-005.
- `test/unit/bot/fix-facts.test.ts` (new), `test/unit/prompts/bot-pr-fix-builder.test.ts`, `test/unit/bot/fix-steps.test.ts` (existing): US-006 and US-007.
- `test/unit/bot/blocking-threads.test.ts`, `test/unit/bot/convergence-summary.test.ts` (new), `test/unit/cli/workflow-status-live.test.ts` (existing): US-008.

### Integration

Read-only symbols (verified):
- `markerPattern`, `parseNaxBotMarker`, `withNaxBotMarker` — `forge/marker-grammar.ts`; `ownComments` — `forge/marker.ts`.
- `FIX_SUMMARY_KEY = "fix-summary"` — `bot/ci-waiver-ready.ts:28`; the `fix-summary` comment is one comment edited in place (`reportStep`, `bot/fix-report.ts:592`); `nameWaiverInSummary` — `bot/ci-waiver-ready.ts:149`, runs on a ready-only pass, which skips `reportStep` (`bot/fix-run.ts:205`).
- `postPrReview(input: PostReviewInput)` — `bot/post.ts:397`; `postFindings` — `bot/post.ts:270`.
- `featureIntentPaths(checkout): { prdPath?; specPath? }` — `bot/intent.ts:6`; `loadPRD(path): Promise<PRD>` — `prd/index.ts:102`; story `contextFiles`, `expectedFiles`, `modifiedFiles`, `workdir` — `prd/types.ts`.
- `readHead` / `state.pushedSha` — set by the push step, `bot/fix-steps.ts:319`.
- `readSettledKeys` — `bot/rulings.ts:454`; `readWriters` — `bot/writers.ts:20`; `loadConfig` — `config/loader.ts:247`.
- `reviewRange` — `bot/review-rulings.ts:203` (unchanged); `assertPatchDeclared` — `step-graph/run.ts:76`.

The baselines below exist only to locate the code; implement the Target.

- `PrFinding` (`operations/bot-types.ts:18`) — Baseline: `WorkflowFindingDraft & { readonly decision?: string }`. Target: adds `readonly trigger?: FindingTrigger; readonly triggerEvidence?: string`.
- `AgreedItem` finding arm (`bot/post.ts:34`) — Target: adds `trigger?: FindingTrigger; triggerEvidence?: string; lineage?: FindingLineage; lineageUnknown?: true`.
- `BotReviewArtifact` (`bot/post.ts:63`) — Target: adds `blockingTriggers?: readonly FindingTrigger[]; unreachablePushes?: number` (absent on artifacts written before this feature; readers fall back to config and 0).
- `PostReviewInput` (`bot/post.ts:82`) — Target: adds `blockingTriggers?`, `blockingSource?`, `ignoredScopeRulings?`, `botPushes?`, `worktree?`, `lineage?`.
- `ReviewSummaryInput` (`bot/render-comments.ts:23`) — Target: adds `residual?`, `blockingTriggers?`, `blockingSource?`, `ignoredScopeRulings?`, `blockingCount?`.
- `PrReviewInput` (`bot/review-step.ts`) and `BotPrReviewPromptInput` — Target: add `botPushes?: readonly BotPushEntry[]`.
- `BotConfigSchema` (`config/schemas-bot.ts:4`) — Baseline: `{ gateRepairRounds, costLimit, models }`. Target: adds `blockingTriggers` and `chainNoticeGeneration`.
- `renderFindingComment(finding: WorkflowFindingDraft): string` — Target: `renderFindingComment(finding: WorkflowFindingDraft & { trigger?: FindingTrigger; triggerEvidence?: string; lineage?: FindingLineage }): string`.
- `BotPrFixPromptInput` — Target: adds `findingFacts?` and `outsideGrowth?` as above.
- `BotFixState` (`bot/fix-steps.ts`) — Target: adds `followUps?`; `fix` node `produces` (`bot/fix-run.ts:126`) gains `"followUps"`.
- `WorkflowForgeDeps` (`cli/workflow-forge.ts:20`) — Target: adds `readBlockingTriggers`.
- `SettlementReadInput` (`bot/rulings.ts:395`) — Baseline: `Omit<RecordRulingsInput, "readModel" | "callerRulings">`. Target: `Omit<RecordRulingsInput, "readModel" | "callerRulings" | "info">`.
- `BotConfig` (`config/runtime-types-bot.ts`) — Target: adds `blockingTriggers?` and `chainNoticeGeneration?`.
- `blockingKeys(review)` (`bot/fix-report.ts:343`) — Target: `blockingKeys(review, blocking)`.
- `cli/workflow.ts` imports `readBlockingFindingThreads` through the `@/bot` barrel (`bot/index.ts` exports it); `check:import-cycles` stays at its baseline.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Reviewer omits `trigger` or gives an unknown value | Finding reads `normal` (blocks as today). |
| Scope-ruling comment with an unknown class or an empty list | Ignored; summary line `Ignored scope ruling: <first line>`; configured set applies. |
| `fix-summary` ledger block unreadable | Treated as empty; warn logged; next push writes a fresh block holding only the new entry. |
| Ledger block would exceed `MAX_LEDGER_CHARS` | Oldest entries dropped until it fits; the comment stays under the forge limit. |
| Own `fix-summary` comment absent | Empty ledger; the first push creates the comment with the block. |
| Ledger entry `sha` not reachable from the head (rebase, force-push) | Entry skipped for lineage; counted in `unreachablePushes` and the fix summary's `(<u> no longer in history)`. |
| `git blame` exits non-zero, or a `merge-base --is-ancestor` check for a finding errors (exit code other than 0 or 1) | Finding gets `lineageUnknown: true`, no lineage line; review continues. Exit 1 is a plain "no", never an error. |
| Finding with no `file` or `line` | No lineage; generation 0. |
| PRD missing or unreadable, or a `git diff --numstat` fails | No `outsideGrowth` fact; fix continues. |
| Config unreadable in `nax workflow status` | `DEFAULT_BLOCKING_TRIGGERS` used. |
| Thread read for blocking findings fails in `nax workflow status` | Warn logged; no blocking items added; the rest of the report stands. |
| Summary edit fails after a successful push | Existing behaviour (the report step error surfaces); that push's ledger entry is not recorded. |

## Out of Scope

- Routing a fix-induced chain to an advisor agent or to the calling chat session (#2987 point 2): a separate later spec.
- Any cap or hard stop on bot review or fix rounds: this feature only reports rounds.
- Posting minor or residual findings as inline threads: they stay summary-only (#2979 option 1 not taken).
- Asking before acting on a minor that asks to revert an earlier bot change: the lineage fact covers it; no ask step is added.
- Changing the incremental review range (`reviewRange`) or forcing full reviews.
- Moving the bot models back to `gpt-6.2-sol`: an operator config change after release.
- Forge permalinks for blocking findings in `nax workflow status`: items show key, severity, path and line.
- Blocking findings in `nax workflow status` when the PR has no item index or the live read fails: only the live path adds them.
- Per-package (`.nax/mono/<pkg>/config.json`) values of `bot.blockingTriggers` and `bot.chainNoticeGeneration`: bot commands are repo-scoped, so the root config applies.
- Lineage for findings raised by the workflow's own branch review (`w-` items): only `nax bot review` findings get lineage.
- Recording a ledger entry when the summary comment write fails, or retrying that write.
- Pipeline mode: frozen; nothing here touches it.

## Stories

### US-001 — review findings carry a trigger class

Workdir: packages/nax. No dependencies.

Add `trigger` and `triggerEvidence` to the review reply contract, parser, `PrFinding`, the finding `AgreedItem`, the earlier-thread merge and the inline finding body; add `FINDING_TRIGGERS`, `FindingTrigger` and `parseFindingTrigger` in `workflow/blocking-findings/index.ts`.

### US-002 — the blocking vocabulary and its config

Workdir: packages/nax. Depends on US-001.

Add `bot.blockingTriggers` and `bot.chainNoticeGeneration` with descriptions; add `isBlockingFinding`, `readFindingThreadFacts`, `firstIssueLine` and `effectiveBlockingTriggers` to `workflow/blocking-findings/index.ts`.

### US-003 — the blocking set decides review posting and readiness

Workdir: packages/nax. Depends on US-002.

Compute the effective set in `nax bot review`; post non-blocking critical/important findings as residuals in the summary with the blocking-trigger lines; store the set on the review artifact; make `blockingKeys` use it.

### US-004 — nax bot fix records its pushes in the fix summary

Workdir: packages/nax. Depends on US-002.

Move `outcomeText` out of `fix-report.ts` into `fix-outcome-text.ts`; add `bot/push-ledger.ts` with the ledger block format, reader, writer and append; add the optional `lineage` / `lineageUnknown` fields to the finding `AgreedItem`; write an entry on every successful push and carry the ledger through every other summary write.

### US-005 — nax bot review gives each finding a lineage

Workdir: packages/nax. Depends on US-001, US-004.

Add `bot/lineage.ts` (`computeLineage`); run it in the review graph's `post` node against the own `fix-summary` ledger; copy lineage onto agreed findings, the artifact and the inline thread body; list the bot pushes inside an incremental range in the review prompt.

### US-006 — the fix prompt carries trigger, lineage and growth facts

Workdir: packages/nax. Depends on US-002, US-005.

Add `bot/fix-facts.ts` (`findingFactLines`, `outsideDeclaredGrowth`); add `findingFacts` and `outsideGrowth` to `BotPrFixPromptInput` and render them; pass them from `fixStep`.

### US-007 — non-blocking findings alone cause no push

Workdir: packages/nax. Depends on US-003, US-006.

Add `followUps` to `BotFixState` and the `fix` node's `produces`; make `fixStep` end with `nothing` and a follow-up list when no agreed item is push-worthy; render the follow-up text in the fix summary.

### US-008 — status and summaries count what blocks and show the chain

Workdir: packages/nax. Depends on US-003, US-005.

Add `bot/blocking-threads.ts` and the `readBlockingTriggers` dep, and append blocking findings in `nax workflow status`; extend the review summary's open-items line; add `bot/convergence-summary.ts` with the push count and the chain notice, called from `reportStep`.

### Context Files

**US-001**
- `packages/nax/src/operations/bot-pr-review-reply.ts`
- `packages/nax/src/operations/bot-types.ts`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts`
- `packages/nax/src/bot/post.ts`
- `packages/nax/src/bot/render-comments.ts`

**US-002**
- `packages/nax/src/config/schemas-bot.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax/src/config/runtime-types-bot.ts`
- `packages/nax/src/forge/pr-types.ts`
- `packages/nax/src/workflow/blocking-findings/index.ts` — created by US-001, extended here

**US-003**
- `packages/nax/src/bot/post.ts`
- `packages/nax/src/bot/render-comments.ts`
- `packages/nax/src/bot/fix-report.ts`
- `packages/nax/src/bot/review-run.ts`
- `packages/nax/src/bot/writers.ts`

**US-004**
- `packages/nax/src/bot/fix-report.ts`
- `packages/nax/src/bot/ci-waiver-ready.ts`
- `packages/nax/src/bot/post.ts`
- `packages/nax/src/forge/marker-grammar.ts`

**US-005**
- `packages/nax/src/bot/review-run.ts`
- `packages/nax/src/bot/review-step.ts`
- `packages/nax/src/bot/post.ts`
- `packages/nax/src/operations/bot-types.ts`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts`

**US-006**
- `packages/nax/src/bot/fix-steps.ts`
- `packages/nax/src/prompts/builders/bot-pr-fix-builder.ts`
- `packages/nax/src/bot/intent.ts`
- `packages/nax/src/prd/types.ts`
- `packages/nax/src/bot/push-ledger.ts` — created by US-004, read here

**US-007**
- `packages/nax/src/bot/fix-steps.ts`
- `packages/nax/src/bot/fix-run.ts`
- `packages/nax/src/bot/fix-outcome-text.ts` — created by US-004, extended here

**US-008**
- `packages/nax/src/cli/workflow.ts`
- `packages/nax/src/cli/workflow-forge.ts`
- `packages/nax/src/bot/rulings.ts`
- `packages/nax/src/bot/render-comments.ts`
- `packages/nax/src/bot/fix-report.ts`

### Creates

**US-001**
- `packages/nax/src/workflow/blocking-findings/index.ts`

**US-002**
- `packages/nax/test/unit/workflow/blocking-findings.test.ts`

**US-003**
- `packages/nax/src/bot/review-convergence.ts`
- `packages/nax/src/bot/review-blocking.ts`

**US-004**
- `packages/nax/src/bot/push-ledger.ts`
- `packages/nax/src/bot/fix-outcome-text.ts`
- `packages/nax/test/unit/bot/push-ledger.test.ts`

**US-005**
- `packages/nax/src/bot/lineage.ts`
- `packages/nax/test/unit/bot/lineage.test.ts`

**US-006**
- `packages/nax/src/bot/fix-facts.ts`
- `packages/nax/test/unit/bot/fix-facts.test.ts`

**US-008**
- `packages/nax/src/bot/blocking-threads.ts`
- `packages/nax/src/bot/convergence-summary.ts`
- `packages/nax/test/unit/bot/blocking-threads.test.ts`
- `packages/nax/test/unit/bot/convergence-summary.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — the expected contract text at line 47 pins the finding shape without `trigger`; it gains `"trigger": "normal|own-concurrency|adversarial|manual", "triggerEvidence": "..."` and the four class definition lines, and the assertions that use it are otherwise unchanged.
- `packages/nax/test/unit/operations/bot-pr-review-reply.test.ts` — the exact expectation at line 79 (`toEqual([draft])`) pins a parsed finding without `trigger`; the expected draft gains `trigger: "normal"` because the parser now always sets it, and nothing else changes.

**US-002**
- `packages/nax/test/unit/config/bot-config.test.ts` — the exact parsed-default objects at lines 9, 10, 63 and 64 pin `{ models, gateRepairRounds, costLimit }`; each gains `blockingTriggers: ["normal", "own-concurrency"]` and `chainNoticeGeneration: 2`, and nothing else changes.

**US-003**
None. Existing post and readiness fixtures carry no `trigger`, which reads `normal` and blocks exactly as before, and artifacts without `blockingTriggers` fall back to the default set, which keeps every existing blocking decision.

**US-004**
None. `outcomeText` moves unchanged, existing fix-report and fix-summary tests assert on summary text with substring checks, and a body with no ledger entries is written exactly as before.

**US-005**
None. Findings in existing review tests have no `fix-summary` ledger, so they get no lineage and their rendered bodies gain no line.

**US-006**
None. `findingFacts` and `outsideGrowth` are optional and render nothing when absent, so existing fix-prompt expectations hold.

**US-007**
- `packages/nax/test/integration/bot/checkout.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-check-steps.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-ready-only.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/cost-guard.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-pinned-session.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-session.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-run.test.ts` — the fixture at line 160 builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/fix-trust.test.ts` — a fixture builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/in-place-fix.test.ts` — the fixture at line 74 builds an agreed list holding only one `minor` finding and expects `fixStep` to start a fix session; that finding's `severity` becomes `"important"` so the case still drives a session, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.
- `packages/nax/test/integration/bot/saved-fix-reuse.test.ts` — the agreed list at line 43 holds only `minor` findings; where the case expects `fixStep` to reuse a saved fix or start a session, those findings' `severity` becomes `"important"`, because under this story a minor-only agreed list ends with `outcome: "nothing"`. Nothing else in the file changes.

**US-008**
None. The `workflow-status-live.test.ts` fixtures spread `_workflowForgeDeps` and include no own unsettled blocking finding thread, so their exact `No open items.` outputs (lines 355 and 393) stay as they are.

### Seams

- US-001 -> US-002, US-003: `isBlockingFinding` reads the `trigger` that US-001 puts on `PrFinding` and `AgreedItem`.
- US-002 -> US-003, US-006, US-007, US-008: posting, the fixer facts, the push decision, the status list and the summary counts all call US-002's `isBlockingFinding`; US-003 and US-008 call `effectiveBlockingTriggers`.
- US-003 -> US-007, US-008: the push decision and the summary count read `BotReviewArtifact.blockingTriggers`.
- US-004 -> US-005: the review graph's `post` node passes `computeLineage` the entries US-004's `readPushLedger` returns from the own `fix-summary` comment.
- US-005 -> US-004: the ledger item `generation` written on a push comes from the `lineage` US-005 sets on agreed findings.
- US-005 -> US-006, US-008: the fixer lineage lines and the chain notice read `AgreedItem.lineage`; the push count reads `BotReviewArtifact.unreachablePushes`.

## Acceptance Criteria

### US-001

1. [unit] `parseFindingTrigger` returns each of `"normal"`, `"own-concurrency"`, `"adversarial"` and `"manual"` unchanged.
2. [unit] `parseFindingTrigger` returns `"normal"` for `undefined`, for `"race"` and for the number `3`.
3. [unit] `parsePrReviewReply` on a reply whose finding has `"trigger": "adversarial"` and `"triggerEvidence": "  forged mtime on the claim file  "` returns a finding with `trigger: "adversarial"` and `triggerEvidence: "forged mtime on the claim file"`.
4. [unit] `parsePrReviewReply` on a reply whose finding has no `trigger` returns that finding with `trigger: "normal"` and no `triggerEvidence` key.
5. [unit] `parsePrReviewReply` on a finding whose `triggerEvidence` is an empty string or whitespace returns no `triggerEvidence` key.
6. [unit] `parsePrReviewReply` caps a 500-character `triggerEvidence` at 300 characters.
7. [unit] `buildBotPrReviewPrompt` output contains the finding shape `"trigger": "normal|own-concurrency|adversarial|manual", "triggerEvidence": "..."` inside the reply contract.
8. [unit] `buildBotPrReviewPrompt` output contains one definition line for each of the four trigger classes, each starting with the class name followed by a colon.
9. [unit] `renderFindingComment` for an important quality finding with `trigger: "adversarial"` and `triggerEvidence: "forged mtime"` returns a body in which the issue line is followed by a blank line and then `Trigger: adversarial - forged mtime`.
10. [unit] `renderFindingComment` for a finding with `trigger: "normal"` and no evidence returns a body with the line `Trigger: normal` and no ` - ` suffix on it.
11. [unit] `renderFindingComment` for a finding with no `trigger` returns a body with no `Trigger:` line.
12. [unit] `renderFindingComment` for a finding with a trigger and a suggestion places the `Trigger:` line before the `Suggestion:` paragraph.
13. [unit] `renderFindingComment` passes `triggerEvidence` through `safeText`, so evidence `[x](http://e.com)` renders without `](`.
14. [unit] `renderFindingComment` for a finding with a trigger returns a body whose marker key equals `findingKey` of the same finding without a trigger.
15. [integration] `postPrReview` with a verdict finding `{ severity: "important", trigger: "own-concurrency", triggerEvidence: "two runs" }` writes an artifact whose finding item has `trigger: "own-concurrency"` and `triggerEvidence: "two runs"`.
16. [integration] `postPrReview` with an open earlier thread whose first comment body is `**Important** (quality): lock leaks\n\nTrigger: manual` writes an artifact whose merged earlier finding item has `trigger: "manual"` and an `issue` with no `Trigger:` line.
17. [integration] `postPrReview` with an open earlier thread whose first comment has no `Trigger:` line writes a merged earlier finding item with no `trigger` key.

### US-002

1. [unit] `BotConfigSchema.parse({})` yields `blockingTriggers` equal to `["normal", "own-concurrency"]` and `chainNoticeGeneration` equal to `2`.
2. [unit] `BotConfigSchema.safeParse({ blockingTriggers: [] })` fails.
3. [unit] `BotConfigSchema.safeParse({ blockingTriggers: ["normal", "race"] })` fails.
4. [unit] `BotConfigSchema.safeParse({ chainNoticeGeneration: 0 })` fails.
5. [unit] Every `bot.<key>` path of `BotConfigSchema`, including the new `bot.blockingTriggers` and `bot.chainNoticeGeneration`, has a non-empty entry in the config descriptions map.
6. [unit] `isBlockingFinding({ severity: "important", trigger: "normal" }, ["normal"])` returns true.
7. [unit] `isBlockingFinding({ severity: "minor", trigger: "normal" }, ["normal"])` returns false.
8. [unit] `isBlockingFinding({ severity: "critical", trigger: "adversarial" }, ["normal", "own-concurrency"])` returns false.
9. [unit] `isBlockingFinding({ severity: "important" }, ["normal"])` (no trigger) returns true.
10. [unit] `readFindingThreadFacts` on `**Critical** (quality): x\n\nTrigger: adversarial - y` returns `{ severity: "critical", trigger: "adversarial" }`.
11. [unit] `readFindingThreadFacts` on a body with no severity label and no `Trigger:` line returns `{ severity: "important", trigger: "normal" }`.
12. [unit] `firstIssueLine("**Important** (quality): lock leaks\nmore\n\nTrigger: normal\nLineage: generation 1, on lines added by nax bot fix abc1234 for f-a")` returns `"lock leaks"`.
13. [unit] `firstIssueLine("plain issue")` returns `"plain issue"`.
14. [unit] `effectiveBlockingTriggers` with no scope comment returns the configured set and `source: "config"`.
15. [unit] `effectiveBlockingTriggers` with a writer comment whose first line is `Blocking Triggers: normal` returns `triggers: ["normal"]` and a `source` naming that comment's id and author.
16. [unit] `effectiveBlockingTriggers` ignores a matching first line from an author not in `writers`.
17. [unit] `effectiveBlockingTriggers` ignores a comment whose first line is `> blocking triggers: normal`.
18. [unit] `effectiveBlockingTriggers` with two writer scope comments returns the set of the one with the later `createdAt`.
19. [unit] `effectiveBlockingTriggers` with a writer comment `blocking triggers: normal, race` returns the configured set and lists that first line in `invalid`.

### US-003

1. [integration] `postPrReview` with `blockingTriggers` `["normal", "own-concurrency"]` and a verdict finding `{ severity: "important", trigger: "adversarial" }` on a changed line posts no inline comment for it and lists it under `### Residual findings (not blocking)` in the summary.
2. [integration] `postPrReview` with the same set and a finding `{ severity: "important", trigger: "normal" }` on a changed line posts it as an inline comment, as today.
3. [integration] `postPrReview` with the same set and an `adversarial` important finding with no `line` lists it under the off-line findings section and not under `### Residual findings (not blocking)`.
4. [integration] `postPrReview` with an existing own thread for an `adversarial` important finding's key edits that thread and does not list the finding as residual.
5. [integration] `postPrReview` renders a residual's `triggerEvidence` through `safeText`, so evidence `@alice [x](http://e.com)` appears without `](` in the summary.
6. [integration] `postPrReview` writes an artifact whose `blockingTriggers` equals the `blockingTriggers` it was given.
7. [integration] The review summary written by `postPrReview` contains `Blocking triggers: normal, own-concurrency (config)` when `blockingSource` is `"config"`.
8. [integration] The review summary contains `Blocking triggers: normal (PR comment by @alice)` when `blockingSource` names author `alice`.
9. [integration] The review summary contains `Ignored scope ruling: blocking triggers: normal, race` when `ignoredScopeRulings` holds that line.
10. [integration] `runBotReview` on a PR with a top-level comment `blocking triggers: normal` by a writer, and a stubbed reviewer returning one `own-concurrency` important finding on a changed line, writes an artifact with `blockingTriggers: ["normal"]` and posts that finding as residual, not inline.
11. [integration] `runBotReview` on a PR whose only `blocking triggers: normal` comment is by a non-writer writes an artifact with `blockingTriggers: ["normal", "own-concurrency"]`.
12. [integration] `readyStep` on a review artifact whose only agreed finding is `{ severity: "important", trigger: "adversarial" }` with `blockingTriggers: ["normal", "own-concurrency"]` does not hold readiness on an open finding.
13. [integration] `readyStep` on a review artifact with no `blockingTriggers` key and an agreed finding `{ severity: "important", trigger: "manual" }` uses `configuredBlockingTriggers(config)` (default) and does not hold on it.
14. [integration] `readyStep` on a review artifact with `blockingTriggers: ["normal", "manual"]` and an open agreed finding `{ severity: "important", trigger: "manual" }` holds readiness with the open critical/important finding reason.
15. [integration] `readyStep` on a review artifact with no `blockingTriggers` key and an open agreed finding with no `trigger` and `severity: "important"` holds readiness, as today.
16. [unit] `reviewBlockingTriggers` with a conversation-only `env.review` carrying `blockingTriggers: ["normal"]` and an older `env.codeReview` carrying `["normal", "own-concurrency"]` returns `["normal"]`.
17. [unit] `configuredBlockingTriggers({})` returns `DEFAULT_BLOCKING_TRIGGERS` and `configuredChainNoticeGeneration({})` returns `2`.

### US-004

1. [unit] `withPushLedger` on a body ending with a `nax-bot:v1 key=fix-summary` marker and one entry returns a body containing exactly one `<!-- nax-bot:pushes v1 ` line, placed immediately before the marker line.
2. [unit] `parseNaxBotMarker` of that returned body still returns `{ key: "fix-summary" }`.
3. [unit] `readPushLedger` of `withPushLedger(body, entries)` returns `entries` deep-equal and `unreadable: false`.
4. [unit] `withPushLedger` on a body that already holds a ledger block replaces it, so the result contains one block holding only the new entries.
5. [unit] `withPushLedger` with an empty entry list returns the body with no ledger block.
6. [unit] `readPushLedger` on a body with no ledger block returns no entries and `unreadable: false`.
7. [unit] `readPushLedger` on a block whose payload is not valid base64 JSON returns no entries and `unreadable: true`.
8. [unit] `readPushLedger` on a block holding an entry whose `sha` is not 40 hex characters returns no entries and `unreadable: true`.
9. [unit] `appendPushEntry` on 64 entries returns 64 entries whose last is the appended one and whose first is the original second entry.
10. [unit] `renderFixSummary` for each of the outcomes `pushed`, `nothing`, `no-change` and `push-rejected` returns the same first line it returned before `outcomeText` moved to `fix-outcome-text.ts`.
11. [unit] `reportStep` with `outcome: "pushed"`, `pushedSha` `S`, `env.info.headSha` `B`, no own `fix-summary` comment and two agreed findings posts a body whose ledger holds one entry with `base: B`, `sha: S` and two items keyed by the agreed items' keys.
12. [unit] In that entry, an agreed finding with `lineage.generation` 2 has item `generation: 2`, and one with no lineage has `generation: 0`.
13. [unit] In that entry, each item's `issue` is `firstIssueLine` of the agreed item's issue, capped at 120 characters.
14. [unit] `reportStep` with `outcome: "pushed"` and an own `fix-summary` comment holding one ledger entry edits that comment to a body whose ledger holds two entries, the old one first.
15. [unit] `reportStep` with `outcome: "gates-failed"` and an own `fix-summary` comment holding one entry edits it to a body whose ledger holds that same single entry.
16. [unit] `reportStep` with `outcome: "nothing"` and an own `fix-summary` holding one entry keeps that entry and adds none.
17. [unit] `reportStep` with `outcome: "pushed"` and an own `fix-summary` whose ledger block is unreadable writes a ledger holding only the new entry and logs a warn.
18. [unit] `appendPushEntry` on entries whose encoded block would exceed `MAX_LEDGER_CHARS` drops the oldest entries until `withPushLedger`'s block is at most `MAX_LEDGER_CHARS` characters and keeps the appended entry.
19. [integration] A ready-only `readyStep` that names a starved-CI waiver in the summary through `nameWaiverInSummary` edits an own `fix-summary` comment holding a ledger block to a body whose `readPushLedger` returns the same entries.

### US-005

1. [unit] `computeLineage` with one reachable entry `{ base: B, sha: S, items: [{ key: "f-a", generation: 0 }] }` and a finding whose blamed commit is `S` returns lineage `{ generation: 1, parents: ["f-a"], pushSha: S }` for that finding's key.
2. [unit] `computeLineage` with a finding whose blamed commit `C` is an ancestor of `S` and not of `B` returns lineage with `pushSha: S`.
3. [unit] `computeLineage` with a finding whose blamed commit is an ancestor of `B` returns no lineage for it.
4. [unit] `computeLineage` with an entry whose items have generations 1 and 2 and a matching finding returns `generation: 3` and both keys as `parents`.
5. [unit] `computeLineage` with two reachable entries that both match a finding returns the lineage of the later entry in the list.
6. [unit] `computeLineage` with an entry whose `sha` is not an ancestor of the head (stubbed `merge-base --is-ancestor` exit 1) skips that entry and returns `unreachable: 1`.
7. [unit] `computeLineage` whose stubbed `git blame` exits non-zero for a finding puts that finding's key in `unknown` and returns no lineage for it.
8. [unit] `computeLineage` for a finding with no `line` runs no `git blame` for it and returns no lineage for it.
9. [unit] `computeLineage` invokes `runGit` with `["blame", "--porcelain", "-L", "12,12", <head>, "--", "src/a.ts"]` for a finding at `src/a.ts:12`.
10. [unit] `renderFindingComment` for a finding with lineage `{ generation: 2, parents: ["f-a", "f-b"], pushSha: "abcdef1..." }` returns a body with the line `Lineage: generation 2, on lines added by nax bot fix abcdef1 for f-a, f-b` after the `Trigger:` line.
11. [unit] `renderFindingComment` for a finding without lineage returns a body with no `Lineage:` line.
12. [unit] `buildBotPrReviewPrompt` with `incrementalSince` set and `botPushes` holding one entry `{ base: B, sha: S, items: [{ key: "f-a", generation: 1, issue: "lock leaks" }] }` contains the heading `## Earlier nax bot fix pushes in this range` and the line `- <B7>..<S7>: nax bot fix for f-a (lock leaks), generation 1`.
13. [unit] `buildBotPrReviewPrompt` with `botPushes` empty or absent contains no `## Earlier nax bot fix pushes in this range` heading.
14. [unit] `buildBotPrReviewPrompt` for a full (not incremental) review contains no `## Earlier nax bot fix pushes in this range` heading even when `botPushes` is given.
15. [integration] `runBotReview` on a PR whose own `fix-summary` comment holds a ledger entry `S`, with stubbed git reporting the finding's line blamed to `S`, and a stubbed reviewer returning that finding, writes an artifact whose agreed finding has `lineage.pushSha` equal to `S`.
16. [integration] In that run, the posted inline comment for that finding contains a `Lineage: generation 1` line.
17. [integration] `runBotReview` with a ledger entry whose stubbed ancestry check fails writes an artifact with `unreachablePushes: 1`.
18. [integration] `runBotReview` on an incremental range with a reachable ledger entry after the range base passes the review op a prompt containing that entry's line under `## Earlier nax bot fix pushes in this range`.
19. [integration] `runBotReview` on a PR with no own `fix-summary` comment writes agreed findings with no `lineage` key and runs no `git blame`.
20. [integration] `postPrReview` with an open earlier thread whose first comment has a `Lineage:` line writes a merged earlier finding item whose `issue` has no `Lineage:` line.
21. [integration] `runBotReview` with an open earlier finding thread at `src/a.ts:12` whose line is blamed (stubbed) to ledger entry `S` writes an artifact whose merged earlier finding item has `lineage.pushSha` equal to `S`.
22. [unit] `computeLineage` whose stubbed reachability check exits 128 for an entry skips that entry, counts it in `unreachable` and puts no target in `unknown` for it.

### US-006

1. [unit] `findingFactLines` for an agreed finding `{ trigger: "adversarial", triggerEvidence: "forged mtime" }` returns a list whose first line is `Trigger: adversarial - forged mtime`.
2. [unit] `findingFactLines` for an agreed finding with no `trigger` returns no `Trigger:` line.
3. [unit] `findingFactLines` for an agreed finding with lineage `{ generation: 2, parents: ["f-a"], pushSha: S }` and a ledger item `f-a` with issue `lock leaks` returns the line `Lineage: generation 2, on lines added by nax bot fix <S7> for f-a (lock leaks)`.
4. [unit] `findingFactLines` for a lineage with two parents returns one `Lineage:` line per parent.
5. [unit] `findingFactLines` for a minor finding returns the line `Not blocking readiness (minor or trigger outside the blocking set)`.
6. [unit] `findingFactLines` for an important `normal` finding under the set `["normal"]` returns no `Not blocking readiness` line.
7. [unit] `findingFactLines` for a `thread` agreed item returns an empty list.
8. [unit] `outsideDeclaredGrowth` with a PRD whose single story declares `contextFiles: ["src/a.ts"]`, `expectedFiles: ["src/b.ts"]` and `modifiedFiles` `[{ path: "test/a.test.ts" }]`, and one entry whose stubbed `git diff --numstat` reports `10 src/a.ts`, `20 src/c.ts` and `5 src/b.ts`, returns `[{ path: "src/c.ts", added: 20 }]`.
9. [unit] `outsideDeclaredGrowth` invokes `runGit` with `["diff", "--numstat", <base>, <sha>]` for each ledger entry.
10. [unit] `outsideDeclaredGrowth` counts a path declared as `src/a.ts` on a story with `workdir: "packages/x"` as declared when the diff names `packages/x/src/a.ts`.
11. [unit] `outsideDeclaredGrowth` sums one path's added lines across two entries.
12. [unit] `outsideDeclaredGrowth` returns undefined when `prdPath` is undefined.
13. [unit] `outsideDeclaredGrowth` returns undefined when the stubbed `loadPRD` rejects.
14. [unit] `outsideDeclaredGrowth` returns undefined when a stubbed `git diff --numstat` exits non-zero.
15. [unit] `buildBotPrFixPrompt` with `findingFacts` `[{ id: "f-1", lines: ["Trigger: normal"] }]` contains the heading `## Facts about these findings` and a `- f-1:` entry followed by `Trigger: normal`.
16. [unit] `buildBotPrFixPrompt` with `outsideGrowth` `[{ path: "src/c.ts", added: 20 }, { path: "src/d.ts", added: 50 }]` contains the line ``Lines added by earlier nax bot fix pushes on this PR in files outside the feature's declared files: `src/d.ts` +50, `src/c.ts` +20``.
17. [unit] `buildBotPrFixPrompt` with 12 `outsideGrowth` entries lists 10 paths followed by `and 2 more`.
18. [unit] `buildBotPrFixPrompt` with neither `findingFacts` nor `outsideGrowth` contains no `## Facts about these findings` heading.
19. [integration] `fixStep` with an agreed finding carrying `trigger: "own-concurrency"` passes `runBranchFix` a prompt containing `Trigger: own-concurrency` under `## Facts about these findings`.
20. [integration] `fixStep` on a PR whose own `fix-summary` ledger has an entry whose stubbed numstat adds 30 lines to an undeclared file passes `runBranchFix` a prompt containing that file with `+30`.

### US-007

1. [unit] `fixStep` with agreed items `[minor finding "f-1" trigger "normal"]` returns `{ patch: { agreedCount: 1, outcome: "nothing", followUps: [{ key: "f-1", severity: "minor", trigger: "normal" }] }, exit: "nothing" }` and does not call `runBranchFix`.
2. [unit] `fixStep` with agreed items `[important finding trigger "adversarial"]` under the review's `blockingTriggers` `["normal", "own-concurrency"]` returns `outcome: "nothing"` and does not call `runBranchFix`.
3. [unit] `fixStep` with agreed items `[minor finding with no trigger]` returns a follow-up whose `trigger` is `"normal"`.
4. [unit] `fixStep` with agreed items `[minor finding, important finding trigger "normal"]` calls `runBranchFix` with both findings.
5. [unit] `fixStep` with agreed items `[minor finding, agreed thread item]` calls `runBranchFix`.
6. [unit] `fixStep` with agreed items `[minor finding, agreed comment item]` calls `runBranchFix`.
7. [unit] `fixStep` with a review artifact lacking `blockingTriggers` and agreed items `[important finding trigger "manual"]` uses the configured default set and returns `outcome: "nothing"`.
8. [unit] `fixStep` with no agreed items returns `outcome: "nothing"` with no `followUps` key, as today.
9. [integration] `runBotFix` on a review whose only agreed item is a minor finding completes without a step-graph `STEP_GRAPH_UNDECLARED_OUTPUT` refusal and reports outcome `nothing`.
10. [unit] The fix summary for `outcome: "nothing"` with `followUps` `[{ key: "f-1", severity: "minor", trigger: "normal" }]` contains `No fix session: no agreed item can hold readiness. Left for follow-up: f-1 (Minor, normal)`.
11. [unit] The fix summary for `outcome: "nothing"` with 12 follow-ups lists 10 and then `and 2 more`.
12. [unit] The fix summary for `outcome: "nothing"` with no `followUps` contains `Nothing to fix: the latest review agreed with no item.`

### US-008

1. [unit] `readBlockingFindingThreads` with one own unresolved thread whose first comment has marker key `f-abc` and body `**Important** (quality): lock leaks\n\nTrigger: normal` returns one item `{ id: "f-abc", kind: "finding", severity: "important", issue: "bot review: lock leaks" }` carrying the thread's path and line.
2. [unit] `readBlockingFindingThreads` leaves out a resolved own finding thread.
3. [unit] `readBlockingFindingThreads` leaves out an own finding thread whose key the stubbed `readSettledKeys` returns as settled.
4. [unit] `readBlockingFindingThreads` leaves out an own finding thread whose body has `Trigger: adversarial` under the default set.
5. [unit] `readBlockingFindingThreads` leaves out an own `**Minor**` finding thread.
6. [unit] `readBlockingFindingThreads` leaves out a thread whose first comment is by another author, and an own thread whose marker key starts with `w-`.
7. [unit] `readBlockingFindingThreads` includes an own `Trigger: adversarial` finding thread when a writer comment `blocking triggers: normal, adversarial` is on the PR.
8. [unit] `_workflowForgeDeps.readBlockingTriggers` returns `DEFAULT_BLOCKING_TRIGGERS` when the stubbed config load rejects.
9. [integration] `nax workflow status -f <feature>` on a live draft whose item index has no open item and whose PR has one own unsettled blocking finding thread prints that item's line and not `No open items.`, and exits 2.
10. [integration] `nax workflow status -f <feature>` on a live draft whose blocking-thread read throws still prints the item-index report and logs a warn.
11. [unit] The review summary's open-items line with item status `{ open: 0, total: 9 }` and `blockingCount` 2 reads `Open items: 0 of 9 indexed; 2 blocking review findings.`
12. [unit] The review summary's open-items line with `blockingCount` 0 or absent reads `Open items: 0 of 9.`, as today.
13. [integration] `postPrReview` with two blocking agreed findings and item status `{ open: 0, total: 9 }` writes a summary containing `Open items: 0 of 9 indexed; 2 blocking review findings.`
14. [unit] `convergenceLines` with three entries and `unreachable: 0` returns a line `nax bot fix pushes on this PR: 3`.
15. [unit] `convergenceLines` with three entries and `unreachable: 1` returns `nax bot fix pushes on this PR: 3 (1 no longer in history)`.
16. [unit] `convergenceLines` with no entries returns no push-count line.
17. [unit] `convergenceLines` with a blocking agreed finding `f-x` (important, `normal`) whose lineage is `{ generation: 2, parents: ["f-a"], pushSha: S }`, an entry item `f-a` with issue `lock leaks` and `noticeGeneration` 2 returns the heading `### Findings are chasing their own fixes` and the line `- f-x (Important, normal), generation 2: on lines added by nax bot fix <S7> for f-a (lock leaks)`.
18. [unit] `convergenceLines` with the same finding at generation 1 and `noticeGeneration` 2 returns no `### Findings are chasing their own fixes` heading.
19. [unit] `convergenceLines` with a generation-3 finding that is not blocking (trigger `adversarial` under the default set) returns no chain heading.
20. [unit] `reportStep` with `outcome: "pushed"` and a review artifact with `unreachablePushes: 1` posts a fix summary containing `nax bot fix pushes on this PR: 1 (1 no longer in history)` for its first push.
