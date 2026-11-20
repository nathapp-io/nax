# SPEC: bot-reviewed-head — advance the w-index Reviewed head after each bot review, so the next incremental review covers only what changed since the last one

Closes: #2996

## Summary

After `nax bot review` posts a review of a workflow PR, the bot writes the head it just reviewed into the PR's `w-index` comment (`Reviewed head:` and `Reviewed base:`), so the next bot review narrows its range to `<that head>..HEAD` instead of `<publish head>..HEAD`. A new function `advanceReviewedHead` (`packages/nax/src/bot/reviewed-head.ts`) re-reads the PR comments just before the write. It edits the bot's own `w-index` comment only when that comment's `Reviewed head` still equals the one this review started from. It changes only the two reviewed lines and keeps the item keys, pending reopens and settled count. The review run calls it after the post step, and only when the post was complete: no thread or earlier-reply write failed (`PostReviewOutcome.failed` is 0), no file went unread, and the scope was not conversation-only. A failed or skipped advance never fails the review, and the next review then falls back to today's wider range.

## Motivation

`nax bot review` narrows a workflow PR's review range with `reviewRange` (`packages/nax/src/bot/review-rulings.ts`). It reads `reviewedHead` / `reviewedBase` from the `w-index` comment and reviews `reviewedHead..HEAD` when both are valid ancestors. Only the workflow publish path writes those lines (`maintainItemIndex` → `reviewedIndex`, `packages/nax/src/workflow/item-threads-index.ts`). The bot's own index write, `refreshIndex` in `packages/nax/src/bot/rulings.ts`, re-renders `read.index` with its existing `reviewedHead` and only updates the settled count.

So every bot re-review after publish covers `publishedHead..HEAD`. Each round re-reads every earlier fix commit, and the range grows by one fix push per round:

- #2978: the index was written at publish with `Reviewed head: 55278b4`. The PR then went through 11 bot review rounds to `6b05e07`, and the index still said `55278b4`.
- #2995 (A/B replay of #2978's head on v0.92.9): round 4 was `incremental` over `55278b4..2b61e69`, which covers all three earlier fix pushes.

Cost: each later round reviews more diff than the change it checks. Convergence: a finding inside an already reviewed fix can surface again in a later round, which is the fix-chain shape #2987 tracks. On #2995 the PR still converged (4 rounds), so this is a contributing factor, not the main cause.

## Design

### Integration

Read-only symbols (verified on `main` `efecda559`):

- `reviewRange(input: { index?: ItemIndex; checkout: PrCheckout; head: string }, isAncestor): Promise<{ rangeBase: string; conversationOnly?: boolean }>` and `reviewScopeOf(...)`: `BotReviewScope` (`"full" | "incremental" | "conversation-only"`) in `packages/nax/src/bot/review-rulings.ts`. `reviewRange` returns `conversationOnly: true` when `reviewedHead === head`.
- `readReviewRulings(...)` returns `reviewedIndex?: ItemIndex`. It is the index parsed from the bot's own `w-index` comment at preparation time. It is `undefined` when the PR body has no `<!-- nax-workflow:v1 -->` marker, when the PR is untrusted (`staticMode`), when there is no parseable index, or when the ruling read throws.
- `ItemIndex { reviewedHead?; reviewedBase?; keys; pendingReopens? }`, `renderItemIndex(index, settled)`, `parseItemIndex(body)` in `packages/nax/src/workflow/item-threads.ts`. The rendered first line is `nax workflow items: <N> (<S> settled)`; `parseItemIndex` also accepts the legacy first line `nax workflow open items: <N>`. `renderItemIndex` prints `Reviewed head: none` and omits `Reviewed base:` when the head is not a 40-character hex SHA.
- `readItemThreads(threads, comments, login)` in `packages/nax/src/workflow/item-thread-state.ts`. It returns `indexComment` (the newest own comment whose nax bot marker key is `w-index`) and the parsed `index`.
- `listPrComments(ref, deps, cwd)`, `editComment(ref, comment, body, deps, cwd)`, `withNaxBotMarker(body, key)` from the `@/forge` barrel.
- `PostReviewOutcome { earlierAnswered; inlineFindings; threadsAnswered; commentsAnswered; offLine; failed }` in `packages/nax/src/bot/post.ts`. `failed` counts forge writes that did not land.
- `PrCheckout.mergeBase`: the merge base the review diffed against.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `_botReviewDeps` (defined in `packages/nax/src/bot/review-deps.ts`, re-exported from `review-run.ts`). Baseline: no index write after the post step. Target: gains `advanceReviewedHead: typeof advanceReviewedHead`, defaulting to the new function (US-002).
- `ReviewEnv` (`review-run.ts`, not exported). Baseline: `{ cost, ctx, review, post }` plus the preparation fields; the `reviewedIndex` that `readReviewRulings` returns stays local to `reviewEnvironment`. Target: gains `reviewedIndex?: ItemIndex` (the index as read at preparation) and `login: string` (the bot login, `items.login`), set by `reviewEnvironment` (US-002).
- `runBotReview` / `executeReview` (`review-run.ts`). Baseline: returns after the step graph posts. Target: when the post step produced a `PostReviewOutcome`, `executeReview` calls `_botReviewDeps.advanceReviewedHead` once under the conditions in Approach, before it returns the result. It reads `state.posted`, `state.unreadFiles`, `env.post.scope`, `env.reviewedIndex`, `env.login`, `env.review.mergeBase`, `env.post.info.headSha`, `env.post.ref` and `env.post.cwd`. The `BotReviewResult` shape is unchanged (US-002).
- `item-threads.ts`. Baseline: `parseItemIndex` reads the settled count from the first line only to validate it and does not return it; `ItemIndex` has no settled field. Target: gains `export function parseItemIndexSettled(body: string): number | null`. It returns the settled count of a body that `parseItemIndex` accepts: `S` from a `nax workflow items: N (S settled)` first line, `0` from the legacy `nax workflow open items: N` first line, and `null` when `parseItemIndex(body)` returns `null`. `ItemIndex` and `parseItemIndex` are unchanged (US-001).

New module `packages/nax/src/bot/reviewed-head.ts` (US-001):

```ts
export interface AdvanceReviewedHeadInput {
  readonly ref: PrRef;
  readonly login: string;
  /** `reviewedHead` of the index this review read at preparation; undefined when that index had none. */
  readonly expectedHead: string | undefined;
  /** The head the review just covered (`info.headSha`). */
  readonly head: string;
  /** The merge base the review diffed against (`checkout.mergeBase`). */
  readonly base: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}

export type AdvanceReviewedHeadOutcome =
  | { readonly kind: "advanced" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skipped"; readonly reason: "invalid-sha" | "no-index" | "unparseable" | "moved" }
  | { readonly kind: "failed" };

export const _reviewedHeadDeps = { listPrComments, editComment };

export async function advanceReviewedHead(input: AdvanceReviewedHeadInput): Promise<AdvanceReviewedHeadOutcome>;
```

### Approach

`advanceReviewedHead`, in order:

1. If `head` or `base` is not a 40-character hex SHA, return `skipped` / `invalid-sha` without reading the forge.
2. Re-read the PR's top-level comments with `_reviewedHeadDeps.listPrComments`. Take the newest comment authored by `login` whose nax bot marker key is `w-index`, as `readItemThreads` does. If there is none, return `skipped` / `no-index`. If its body does not parse as an index, return `skipped` / `unparseable`.
3. If the fresh index's `reviewedHead` is not equal to `expectedHead`, return `skipped` / `moved` without writing. Both `undefined` counts as equal. Another writer, such as a workflow re-publish, changed the index after this review read it, and its value wins.
4. If the fresh index already has `reviewedHead === head` and `reviewedBase === base`, return `unchanged` without writing.
5. Otherwise write `withNaxBotMarker(renderItemIndex({ ...fresh, reviewedHead: head, reviewedBase: base }, settled), "w-index")`, where `fresh` is the re-read index and `settled` is `parseItemIndexSettled(<re-read body>)`. Edit that same comment with `_reviewedHeadDeps.editComment` and return `advanced`. Keys and pending reopens come from `fresh`, so they are kept, and a legacy first line is rewritten in the modern form with `(0 settled)`.
6. A rejected `listPrComments` or `editComment` returns `failed` and never throws. The function logs a warning for `moved` and `failed`. The wording and level of that log are not part of the contract.

`runBotReview` calls `_botReviewDeps.advanceReviewedHead` only when all of these hold. They mirror the publish rule in `reviewedIndex`: the review ran, nothing was left unread, and nothing was cut short.

- the post step produced a `PostReviewOutcome` and its `failed` is `0` (thread and earlier-reply writes; a finding that could not be placed inline goes to the summary as off-line and does not count);
- the review reported no unread files;
- `readReviewRulings` returned a `reviewedIndex` (so the PR is trusted, marked, and has a parseable index);
- the review scope is not `conversation-only`.

`input.full` does not change the rule: a full review covers the whole range, so it advances too. The call passes `expectedHead = env.reviewedIndex.reviewedHead`, `head = info.headSha`, `base = checkout.mergeBase`, `login = env.login`, the PR ref, `_botReviewDeps.forge` and the repository root. `runBotReview` returns the same `BotReviewResult` whatever the advance returns. `executeReview` does not wrap the call in its own guard: `advanceReviewedHead` resolves for every failure and never rejects (US-001).

Why `base = checkout.mergeBase`: `reviewRange` accepts the stored base only when it is an ancestor of the next review's merge base. The current merge base is what this review actually diffed against, so the next review's check is exact.

### Failure Handling

| Case | Behaviour | Story |
|:---|:---|:---|
| `head` or `base` not a 40-character hex SHA | `skipped` / `invalid-sha`, no forge read, no edit | US-001 |
| No own `w-index` comment on re-read | `skipped` / `no-index`, no edit | US-001 |
| Own `w-index` comment does not parse | `skipped` / `unparseable`, no edit | US-001 |
| Fresh `reviewedHead` differs from `expectedHead` | `skipped` / `moved`, no edit | US-001 |
| `listPrComments` rejects | `failed`, no edit, no throw | US-001 |
| `editComment` rejects | `failed`, no throw | US-001 |
| Advance returns `failed` or `skipped` | `runBotReview` still returns `outcome: "posted"` with the same result | US-002 |
| Post outcome has `failed > 0` | no advance | US-002 |
| Review reported unread files | no advance | US-002 |

## Out of Scope

- Making the comment edit conditional at the forge: GitHub and GitLab comment edits have no compare-and-swap. A write that lands between the re-read and the edit can still be overwritten, and the window is one forge round trip.
- Advancing the reviewed head from `nax bot fix`, its readiness pass or `nax workflow record` / `promote`: only a posted bot review advances it.
- Reviewing PRs without the `<!-- nax-workflow:v1 -->` body marker incrementally: they have no index, so every bot review on them stays a full review (#2996 "Not covered").
- Changing the workflow publish rule (`reviewedIndex` / `maintainItemIndex`): a re-publish still writes its own run head.
- Reporting the advance outcome in `BotReviewResult`, the bot review artifact or the summary comment; it is logged only.
- Finding provenance for bot fix agents and routing fix-induced chains to the advisor (#2987).
- Changing `refreshIndex` in `packages/nax/src/bot/rulings.ts`; it keeps re-rendering the index it read.
- Coordinating two overlapping index writers (two concurrent `nax bot review` runs on one PR, or a bot review overlapping a workflow re-publish): the later advance sees a changed `reviewedHead` and returns `moved` without writing, and the next review falls back to the wider range.

## Stories

**US-001 — `advanceReviewedHead` and the index settled-count reader (#2996).** Workdir: `packages/nax`. No dependencies. Adds `packages/nax/src/bot/reviewed-head.ts` (`AdvanceReviewedHeadInput`, `AdvanceReviewedHeadOutcome`, `_reviewedHeadDeps`, `advanceReviewedHead`) with the steps in Design § Approach, and `parseItemIndexSettled` in `packages/nax/src/workflow/item-threads.ts`. Nothing outside this story calls them yet.

**US-002 — call `advanceReviewedHead` after a complete bot review (#2996).** Workdir: `packages/nax`. Depends on US-001 (it calls US-001's function). `_botReviewDeps` gains `advanceReviewedHead`; `ReviewEnv` gains `reviewedIndex` and `login`; `executeReview` calls the dependency after the post step under the conditions in Design § Approach and returns the same result whatever it returns.

### Context Files

**US-001**
- `packages/nax/src/workflow/item-threads.ts` — `ItemIndex`, `renderItemIndex`, `parseItemIndex` (the first-line grammar `parseItemIndexSettled` reads)
- `packages/nax/src/workflow/item-thread-state.ts` — `readItemThreads` (own `w-index` comment selection)
- `packages/nax/src/forge/threads.ts` — `listPrComments`
- `packages/nax/test/unit/bot/rulings.test.ts` — existing `w-index` comment fixtures built with `withNaxBotMarker`

**US-002**
- `packages/nax/src/bot/review-run.ts` — `ReviewEnv`, `reviewEnvironment` (where `reviewedIndex`, `range` and `scope` are computed), `executeReview`
- `packages/nax/src/bot/review-deps.ts` — `_botReviewDeps` definition
- `packages/nax/src/bot/reviewed-head.ts` — created by US-001, called here
- `packages/nax/test/integration/bot/review-run-incremental.test.ts` — the new test copies its `beforeEach`: `makeBotReviewDeps` plus mocks of `isAncestor`, `recordPrRulings`, `runPrReview`, `postPrReview` and `writeJson`, and its `configureFallback` cases `"unmarked"` and `"fork"`
- `packages/nax/test/helpers/bot-review.ts` — `makeBotReviewDeps`

### Creates

**US-001**
- `packages/nax/src/bot/reviewed-head.ts` — `AdvanceReviewedHeadInput`, `AdvanceReviewedHeadOutcome`, `_reviewedHeadDeps`, `advanceReviewedHead`
- `packages/nax/test/unit/bot/reviewed-head.test.ts` — the `advanceReviewedHead` and `parseItemIndexSettled` tests

**US-002**
- `packages/nax/test/integration/bot/review-run-reviewed-head.test.ts` — the `runBotReview` wiring tests

### Modifies

**US-001**

None. The module and the reader are new; no existing assertion covers them.

**US-002**
- `packages/nax/test/helpers/bot-review.ts` — `makeBotReviewDeps` stubs `_botReviewDeps` member by member. Without a stub, the new default `advanceReviewedHead` would call the real forge (`gh`) from every `runBotReview` test whose stubbed ruling outcome carries an index (the incremental, lineage, coverage-record, scope and finding-rulings integration tests). The helper gains `advanceReviewedHead: async () => ({ kind: "unchanged" })`. No assertion changes.

### Seams

- US-002 calls US-001's `advanceReviewedHead` through `_botReviewDeps.advanceReviewedHead` from `runBotReview`, the function both `nax bot review` and the `nax bot fix` re-review call. Its seam ACs trigger `runBotReview` with the dependency stubbed, entering above the call conditions.

## Acceptance Criteria

### US-001

1. [unit] Given `listPrComments` returning the bot's own `w-index` comment whose index has `reviewedHead` equal to `expectedHead`, `advanceReviewedHead` returns `{ kind: "advanced" }`.
2. [unit] In that case, with a re-read index that has two keys and one pending reopen, `_reviewedHeadDeps.editComment` is called once, on that comment, with a body equal to `withNaxBotMarker(renderItemIndex({ ...fresh, reviewedHead: head, reviewedBase: base }, settled), "w-index")`, where `fresh` is the parsed re-read index and `settled` its settled count.
3. [unit] When the re-read index's first line is `nax workflow items: 3 (2 settled)`, the edited body's first line is `nax workflow items: 3 (2 settled)`.
4. [unit] When the re-read index uses the legacy first line `nax workflow open items: 2`, the edited body's first line is `nax workflow items: 2 (0 settled)`.
5. [unit] When the re-read index prints `Reviewed head: none` and `expectedHead` is `undefined`, `advanceReviewedHead` returns `{ kind: "advanced" }`.
6. [unit] When the re-read index's `reviewedHead` differs from `expectedHead`, `advanceReviewedHead` returns `{ kind: "skipped", reason: "moved" }` without calling `editComment`.
7. [unit] When the re-read index already has `reviewedHead` equal to `head` and `reviewedBase` equal to `base`, `advanceReviewedHead` returns `{ kind: "unchanged" }` without calling `editComment`.
8. [unit] When the only `w-index` comment is authored by a login other than `input.login`, `advanceReviewedHead` returns `{ kind: "skipped", reason: "no-index" }` without calling `editComment`.
9. [unit] When the own `w-index` comment's body does not parse as an index, `advanceReviewedHead` returns `{ kind: "skipped", reason: "unparseable" }` without calling `editComment`.
10. [unit] When `head` is not a 40-character hex SHA, `advanceReviewedHead` returns `{ kind: "skipped", reason: "invalid-sha" }` without calling `listPrComments`.
11. [unit] When `base` is not a 40-character hex SHA, `advanceReviewedHead` returns `{ kind: "skipped", reason: "invalid-sha" }` without calling `listPrComments`.
12. [unit] When `listPrComments` rejects, `advanceReviewedHead` resolves to `{ kind: "failed" }` without calling `editComment`.
13. [unit] When `editComment` rejects, `advanceReviewedHead` resolves to `{ kind: "failed" }`.
14. [unit] When `listPrComments` returns two own `w-index` comments, `advanceReviewedHead` edits the newer one.
15. [unit] When the re-read index has `reviewedHead` equal to `head` but a `reviewedBase` different from `base`, `advanceReviewedHead` returns `{ kind: "advanced" }`.
16. [unit] When `expectedHead` is defined and the re-read index prints `Reviewed head: none`, `advanceReviewedHead` returns `{ kind: "skipped", reason: "moved" }`.
17. [unit] `parseItemIndexSettled` returns `2` for a `w-index` comment body built with `withNaxBotMarker` whose first index line is `nax workflow items: 3 (2 settled)`.
18. [unit] `parseItemIndexSettled` returns `0` for a `w-index` comment body built with `withNaxBotMarker` whose first index line is `nax workflow open items: 2`.
19. [unit] `parseItemIndexSettled` returns `null` for a body that `parseItemIndex` rejects.

### US-002

1. [integration] With `_botReviewDeps.advanceReviewedHead` stubbed, a `recordPrRulings` outcome whose index has `reviewedHead` A and a valid `reviewedBase`, `isAncestor` returning true, a PR head C, and a post outcome with `failed: 0`, `runBotReview` calls the stub exactly once.
2. [integration] In that case the stub's input has `expectedHead` A, `head` C, `base` equal to the checkout's `mergeBase`, and `login` equal to the bot login.
3. [integration] In that case the stub's input has `ref` equal to the resolved PR ref, `cwd` equal to the repository root, and `deps` equal to `_botReviewDeps.forge`.
4. [integration] Under the same setup with `input.full` set to `true`, `runBotReview` calls the stubbed `advanceReviewedHead` once with `head` C.
5. [integration] When the post outcome has `failed: 1`, `runBotReview` does not call the stubbed `advanceReviewedHead`.
6. [integration] When `runPrReview` returns `ran: true` with a non-empty `unreadFiles` list, `runBotReview` does not call the stubbed `advanceReviewedHead`.
7. [integration] When the PR head equals the index's `reviewedHead` (a conversation-only review), `runBotReview` does not call the stubbed `advanceReviewedHead`.
8. [integration] When `runPrReview` returns `ran: false`, `runBotReview` does not call the stubbed `advanceReviewedHead`.
9. [integration] When the PR body lacks the `<!-- nax-workflow:v1 -->` marker, `runBotReview` does not call the stubbed `advanceReviewedHead`.
10. [integration] When the PR is classified untrusted (static mode), `runBotReview` does not call the stubbed `advanceReviewedHead`.
11. [integration] When `recordPrRulings` returns an outcome with no `index`, `runBotReview` does not call the stubbed `advanceReviewedHead`.
12. [integration] When the stubbed `advanceReviewedHead` resolves to `{ kind: "failed" }`, `runBotReview` resolves with `outcome: "posted"`.
13. [integration] When the stubbed `advanceReviewedHead` resolves to `{ kind: "skipped", reason: "moved" }`, `runBotReview` resolves with `outcome: "posted"`.
