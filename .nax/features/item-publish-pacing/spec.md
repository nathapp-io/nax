# SPEC: item-publish-pacing — paced, retried item-thread publishing, a reported missing index, and a status that reads recorded rulings

Closes: #2886

## Summary

After a workflow run publishes its PR, nax posts one review thread per open item and then writes the `w-index` comment that `nax bot review` and `nax bot fix` need. Today every write goes out back to back with no pacing and no retry. On PR #2884, 12 of 52 thread posts and the index write were rejected by GitHub's content-creation limit, the run reported nothing beyond `warn` log lines, and every bot command then refused the PR (`no nax item index on this PR`).

This feature paces the item-thread writes, retries writes GitHub rejected after a back-off, always tries the index write even when the waiting budget is spent, records a missing index on the feature record and shows it in the end-of-run summary and in `nax workflow status`, and makes `nax workflow status` read the rulings recorded with `nax workflow record` when the live PR read fails.

## Motivation

#2886 reports three defects. Rulings on 2026-11-13 settled the scope:

1. **No pacing or retry (in scope).** In run `2026-11-12T06-12-29`, stage `item-threads`, posts went out about every 0.5 s. Items `_run:cv41` to `_run:cv52` each failed once with `[forge] Cannot write nathapp-io/nax#2884: gh: Validation Failed (HTTP 422)`, right after 40 identical posts to the same anchor had succeeded, and the `w-index` write then failed with `You have exceeded a secondary rate limit and have been temporarily blocked from content creation`. `gh api` hides GitHub's 422 detail, so the 422s are treated as throttling: a 4xx means GitHub rejected the write, so retrying cannot duplicate a comment.
2. **Duplicate cannot-verify items (not in this feature).** Credited to #2891 (branch review reads the whole diff), which removed the repeated review passes that restated the same facts. No wording-level dedupe is built here.
3. **Status ignores recorded rulings (in scope).** After `nax workflow record` wrote 65 decisions, `nax workflow status --json` still reported all 52 items open with `settledItems: []`, because a failed live read returns the run record alone.

## Design

### Approach

One pacer per publish. `postItemThreads` creates it from the new `workflow.itemPublish` config block and routes every forge write of the publish through it: the thread posts in `postItem`, the reopen writes in `reopenReraisedItems`, the index write in `writeItemIndex`, and the closing reply and resolve writes in `maintainItemIndex`. Reads (`resolvePrRef`, `readPrInfo`, `listReviewThreads`, `listPrComments`, `readCurrentUser`) are not content creation and are not paced.

The pacer has two entry points, each taking an optional `itemId` that labels its log lines:

- `write(action, options?)` — for thread posts, reopen writes and closing writes. `options` is `{ itemId?: string; retries?: number }`; `retries` overrides `maxRetries` for that one write. It is refused once the budget is spent.
- `writeReserved(action, options?)` — for every index write: the final one in `maintainItemIndex` and the pre-notice one `reopenReraisedItems` makes through `writeItemIndex`. It ignores the budget, so the index is always tried, and is still bounded by `maxRetries`. Its gap and back-off waits still add to the total, but it never refuses and never sets `spent`, so a publish with reopen notices can wait past `maxWaitMs` by those index writes.

`postItem` keeps its inline-then-file fallback. The inline attempt goes through `write` with `retries: 0`: GitHub answers a line outside the diff with HTTP 422, which is permanent, so the inline attempt never waits on a back-off and the fallback runs at once. The file-level attempts (the fallback and an item with no line) use the configured `maxRetries`.

A file-level post that GitHub rejects with a permanent 422 still costs up to `maxRetries` back-offs: 422 is retried because `gh` hides whether it was throttling, so two such items can spend the default budget and skip the threads after them.

The pacer is a forge-write pacer inside the workflow publish step, not an agent dispatch retry; the `RetryStrategy` rule (`.nax/rules/retry-strategy.md`) governs dispatch tiers and does not apply to it.

`postItemThreads` stops posting threads when the pacer's `spent` is true after a thread's post failed: the item whose gap was refused, and every later postable item it does not own yet, count as failed and are not sent to the forge. `attempt` keeps catching every error, so the stop is decided by reading `spent`, not by the error code.

Composition of the four settings, in the order they apply to one write:

1. **Gap.** Before every write except the first of the publish, the pacer waits `writeGapMs`.
2. **Attempt.** The action runs once.
3. **Retry.** If the action threw a retryable rejection (below) and fewer than `maxRetries` retries were made for this write, the pacer waits `retryBackoffMs` and goes back to step 2. Otherwise the error propagates.
4. **Budget.** The budget is `maxWaitMs` of total waiting per publish; every gap and back-off wait counts against it. For `write`, a wait that would take the total past `maxWaitMs` is not taken: before an attempt (a gap), `write` throws `NaxError` `ITEM_PUBLISH_BUDGET_SPENT` without running the action; before a retry (a back-off), `write` rethrows the last rejection. Either case sets `spent` to true. A write that needs no wait always runs. `writeReserved` never refuses for the budget and never sets `spent`.

A **retryable rejection** is a `NaxError` with code `FORGE_COMMENT_WRITE_FAILED` whose `context.stderr` contains, case-insensitively, `rate limit`, `HTTP 429` or `HTTP 422`. Every other error is not retried: a `FORGE_RESPONSE_UNPARSEABLE` reply, a timeout, an HTTP 5xx or an auth failure may mean the write landed, and `runForgeWrite` must never repeat a write that may have completed.

`gh api` without `--include` shows no response headers, so a `retry-after` value is never available. The back-off is always `retryBackoffMs`.

The pacer's waits go through an injectable `sleep` on its deps object, so tests drive it without real time.

### Integration (extends existing code)

Read-only symbols (verified 2026-11-13 on `main` `ddc252f28`):

- `packages/nax/src/forge/comments.ts` — `runForgeWrite(ref, argv, deps, cwd)` throws `NaxError` code `FORGE_COMMENT_WRITE_FAILED` with `context.stderr` on a non-zero exit, and `FORGE_RESPONSE_UNPARSEABLE` on an unparseable reply. All seven write helpers used here (`postInlineComment`, `postItemComment`, `postPrComment`, `editComment`, `replyToThread`, `resolveThread`, `unresolveThread`) go through it.
- `packages/nax/src/workflow/decisions-sidecar.ts` — `newestSidecar(runDir): Promise<{ path; sidecar } | null>` (throws when the newest file does not parse), `DecisionsSidecar { decisions: readonly DecisionEntry[]; outcome: SidecarOutcome; ... }`, `DecisionEntry { id; kind; disposition; reason; sha? }`, `SidecarOutcome = "pending" | "promoted" | "verified-ready" | "abandoned"`.
- `packages/nax/src/workflow/live-status.ts` — `readLiveStatus(...)` returns `{ source: "run-record"; error }` when the live read fails.
- `packages/nax/src/utils/bun-deps.ts` — `cancellableDelay(ms, signal?)`, the delay `ci-wait.ts` uses for its `sleep` seam.
- `packages/nax/src/workflow/feature-graph.ts` — the `publish` node's list of record fields its patch may write (`"ciRemaining"`, `"endedAt"`, ...).

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `WorkflowConfigObjectSchema` (`packages/nax/src/config/schemas-workflow.ts`) and `WorkflowConfig` (`packages/nax/src/config/runtime-types-workflow.ts`).
  - Baseline: no `itemPublish` key.
  - Target: an `itemPublish` object with `.prefault({})` and integer fields `writeGapMs` (min 0, default `1000`), `retryBackoffMs` (min 0, default `60000`), `maxRetries` (min 0, default `2`), `maxWaitMs` (min 0, default `300000`). `WorkflowConfig.itemPublish` is optional, like `review`, and `WORKFLOW_ITEM_PUBLISH_DEFAULTS` is exported as the parsed defaults, like `WORKFLOW_REVIEW_DEFAULTS`.
- `ItemThreadsInput` (`packages/nax/src/workflow/item-threads-post.ts`).
  - Baseline: `{ record, url, head?, projectDir, feature, changedFiles }`.
  - Target: adds optional `pacing?: ItemPublishConfig`; absent reads as `WORKFLOW_ITEM_PUBLISH_DEFAULTS`.
- `ItemThreadsOutcome` (same file).
  - Baseline: `{ posted; closed; skipped; failed }`.
  - Target: `{ posted; closed; skipped; failed; indexWritten: boolean; indexMissing: boolean }`. `indexWritten` is true when this publish's final index write succeeded. `indexMissing` is true only when the PR has no `w-index` comment after the publish: the snapshot read no index comment, no index was posted during this publish (the reopen pre-notice write included), and the final write failed. A failed edit of an existing index sets `indexWritten: false` but `indexMissing: false`: the old index is stale, and bot commands still accept the PR.
- `postItemThreadsAfterPublish(env, rec, out, head)` (`packages/nax/src/workflow/publish-item-threads.ts`).
  - Baseline: returns `Promise<void>`.
  - Target: returns `Promise<ItemThreadsOutcome | undefined>` — `undefined` when it posted nothing (no post step, no URL, an outcome other than draft or ready, no identity, or the step threw).
- `PostingContext` (`item-threads-post.ts`), `IndexContext` (`item-threads-index.ts`) and `ReopenContext` (`item-threads-reopen.ts`).
  - Baseline: `{ ref, read/info, deps, cwd, ... }` with no pacer.
  - Target: each gains `readonly pacer: ItemPublishPacer`; every forge write in those modules runs through it.
- `maintainItemIndex(input, keys, context, options)` (`item-threads-index.ts`).
  - Baseline: returns `{ closed: number; failed: number }`.
  - Target: returns `{ closed: number; failed: number; indexed: boolean }`; `postItemThreads` reports `indexWritten` from `indexed`.
- `WorkflowFeatureRecord` (`packages/nax/src/workflow/types.ts`).
  - Baseline: no index field.
  - Target: adds optional `itemIndexMissing?: boolean`. Every `publishStep` whose thread step returned an outcome writes it from the outcome's `indexMissing`, so a later publish that writes the index clears an earlier `true`. A publish whose thread step returned nothing does not put the key in its patch (built with a conditional spread: the step-graph runner rejects a declared key whose value is `undefined`), and the record keeps its earlier value.
- `WorkflowSummaryView` (`packages/nax/src/log-format/types.ts`).
  - Baseline: no index field.
  - Target: adds optional `itemIndexMissing?: { hint: string } | undefined`.
- `WorkflowStatusReport` (`packages/nax/src/cli/workflow.ts`).
  - Baseline: `settledItems` filled only from a live read.
  - Target: adds optional `itemIndexMissing?: true` (present only when the record's field is `true`) and optional `decisions?: string` (the sidecar path relative to the project directory); `settledItems` is also filled from the sidecar on a run-record fallback.

Sidecar settling on a run-record fallback: an entry settles an open or supplementary item when its `id` matches and `sidecarKindFor(item)` equals the entry's `kind`; any other entry is ignored. Each settled item is listed in `settledItems` with the entry's `disposition` and removed from `openItems` or `supplementaryItems`, whichever held it. A `confirmed` advisor entry settles its item: offline there is no thread to show a fix reply, so the recorded ruling stands. When the sidecar's `outcome` is `promoted` or `verified-ready`, the report's outcome is `ready` and the `CI_ITEM_ID` item is removed from `openItems`, as the live read does for a ready PR.

New module: `packages/nax/src/workflow/item-publish-pacer.ts`, a worked skeleton (no precedent: nothing in `src/workflow/` paces forge writes today):

```typescript
export interface ItemPublishConfig {
  readonly writeGapMs: number;
  readonly retryBackoffMs: number;
  readonly maxRetries: number;
  readonly maxWaitMs: number;
}

export const _itemPublishPacerDeps = {
  sleep: (ms: number): Promise<void> => cancellableDelay(ms),
};

export interface ItemPublishPacer {
  write<T>(action: () => Promise<T>, options?: { itemId?: string; retries?: number }): Promise<T>;
  writeReserved<T>(action: () => Promise<T>, options?: { itemId?: string }): Promise<T>;
  /** True once a write was refused, or had a retry cut short, for the budget. */
  readonly spent: boolean;
}

export function isRetryableRejection(error: unknown): boolean;
export function createItemPublishPacer(config: ItemPublishConfig): ItemPublishPacer;
```

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A write is rejected with a retryable rejection and retries remain | Wait `retryBackoffMs`, retry; a `warn` line `[item-threads] Write rejected; retrying after back-off` with the write's `itemId` (when given) and `attempt`. |
| An inline thread post is rejected with HTTP 422 | No retry (`retries: 0`); the file-level fallback runs at once. |
| A write is still rejected after `maxRetries` retries | The rejection propagates to the caller, which handles it as today (the thread post counts as failed; the index write returns false). |
| A write fails with a non-retryable error | No retry; the error propagates at once. |
| A thread post's gap would exceed the budget | `write` throws `ITEM_PUBLISH_BUDGET_SPENT` and `spent` becomes true; `postItemThreads` stops posting threads, counts that item and every later postable unowned item as failed, and logs one `warn` line `[item-threads] Pacing budget spent; skipping remaining threads` with the skipped count. |
| The budget is spent before the index write | The index write still runs through `writeReserved`. |
| The index write fails after its retries and the PR has no index | `indexWritten: false`, `indexMissing: true`; the record gets `itemIndexMissing: true`; the run summary and `nax workflow status` show the missing index. |
| The edit of an existing index fails after its retries | `indexWritten: false`, `indexMissing: false`; nothing is reported beyond today's `warn` line. |
| The live read fails and the newest sidecar does not parse | `nax workflow status` reports the run record alone, with `liveError` and no `decisions` key, as today. |
| The live read fails and a sidecar entry names an id that is not an open or supplementary item, or whose `kind` does not match the item | That entry is ignored; the other entries still settle their items. |

## Out of Scope

- Wording-level dedupe of cannot-verify items (#2886 item 2): #2891's whole-diff branch review removed the repeated review passes that restated them.
- Editing the PR body to report a missing index: the body is written before the threads, and a further write would go into the same rate limit.
- Pacing or retrying forge writes outside the post-publish item-thread step, for example `nax bot fix` replies, `nax workflow promote` writes and the PR open/edit at publish.
- Reading a `retry-after` header: `gh api` is called without `--include`, so no header is available.
- A command that re-posts a missing item index on an existing PR.
- Aborting the run during a pacing wait: the pacer's sleep takes no abort signal, so a run aborted during the post-publish thread step finishes its waits first.
- Showing a CI waiver on a run-record fallback in `nax workflow status`: only the live read shows a waiver, as today.
- Changing `source` in `nax workflow status --json`: a run-record fallback still reports `source: "run-record"` when sidecar decisions are applied.
- Updating the nax-finish skill (repository `nax-toolkit-skills`) to mention the missing-index line is a manual follow-up outside this run.

## Stories

### US-001 — the item-publish pacer and its config

Workdir: packages/nax. No dependencies.

Adds the `workflow.itemPublish` config block and the pacer module: gap, retry on a retryable rejection, the per-publish budget, and the reserved write that ignores the budget. Documents the four keys in the configuration guide.

### US-002 — item-thread publishing goes through the pacer

Workdir: packages/nax. Depends on US-001.

`postItemThreads` creates one pacer per publish from `input.pacing` and routes thread posts, reopen writes and closing writes through `write`, and the index write through `writeReserved`. It stops posting threads once the budget is spent, and reports `indexWritten`. The feature environment passes `fc.workflow.itemPublish` as `pacing`.

### US-003 — a missing index is recorded and shown at run end

Workdir: packages/nax. Depends on US-002.

`postItemThreadsAfterPublish` returns the outcome, `publishStep` writes `itemIndexMissing: true` when the index was not written, and the end-of-run summary shows a line saying so, with the command that settles the PR's items without an index.

### US-004 — `nax workflow status` shows a missing index and reads recorded rulings

Workdir: packages/nax. Depends on US-003.

When the live read fails, `nax workflow status` settles open items from the newest decisions sidecar, reports a promoted sidecar as ready, names the sidecar in `decisions`, and shows the record's missing index.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-workflow.ts` — `WorkflowReviewConfigSchema`, `WORKFLOW_REVIEW_DEFAULTS`, the pattern to mirror.
- `packages/nax/src/config/runtime-types-workflow.ts` — `WorkflowConfig`.
- `packages/nax/src/forge/comments.ts` — `runForgeWrite` and the `FORGE_COMMENT_WRITE_FAILED` error context.
- `packages/nax/src/utils/bun-deps.ts` — `cancellableDelay`.
- `docs/guides/configuration.md` — the `workflow` key table.
- `packages/nax/src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS`, the `workflow.*` rows.

**US-002**
- `packages/nax/src/workflow/item-threads-post.ts` — `postItemThreads`, `postItem`, `attempt`.
- `packages/nax/src/workflow/item-threads-index.ts` — `writeItemIndex`, `maintainItemIndex`, `write`.
- `packages/nax/src/workflow/item-threads-reopen.ts` — `reopenReraisedItems`, `ReopenContext`.
- `packages/nax/src/workflow/feature-env.ts` — the `postItemThreads` step wiring.
- `packages/nax/src/workflow/item-publish-pacer.ts` — created by US-001, consumed here.

**US-003**
- `packages/nax/src/workflow/publish-item-threads.ts` — `postItemThreadsAfterPublish`.
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`.
- `packages/nax/src/workflow/feature-graph.ts` — the `publish` node's patch field list.
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`, `ciRemainingOf`.
- `packages/nax/src/execution/workflow-end-report.ts` — the `Workflow summary:` line.

**US-004**
- `packages/nax/src/cli/workflow.ts` — `buildReport`, `reportFor`, `printPlain`, `WorkflowStatusReport`.
- `packages/nax/src/workflow/decisions-sidecar.ts` — `newestSidecar`, `DecisionEntry`, `SidecarOutcome`, `sidecarKindFor`.
- `packages/nax/src/workflow/open-items.ts` — `CI_ITEM_ID`.
- `packages/nax/src/workflow/live-status.ts` — `readLiveStatus`.
- `packages/nax/src/workflow/run-verdict.ts` — `loadRunVerdict`, `LoadedRun`.

### Creates

**US-001**
- `packages/nax/src/workflow/item-publish-pacer.ts`
- `packages/nax/test/unit/workflow/item-publish-pacer.test.ts`

**US-004**
- `packages/nax/test/unit/cli/workflow-status-sidecar.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/config/workflow-config.test.ts` — the assertion at line 11 pins the parsed `workflow` defaults with `toEqual`; US-001 adds the `itemPublish` block, so the pinned object gains `itemPublish: { writeGapMs: 1000, retryBackoffMs: 60000, maxRetries: 2, maxWaitMs: 300000 }` and is otherwise unchanged.
- `packages/nax/src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS` gains rows for `workflow.itemPublish`, `workflow.itemPublish.writeGapMs`, `workflow.itemPublish.retryBackoffMs`, `workflow.itemPublish.maxRetries` and `workflow.itemPublish.maxWaitMs`, each one line on what it bounds, matching the existing `workflow.review.coverageRetries` rows.
- `docs/guides/configuration.md` — the `workflow` config table gains four rows, `itemPublish.writeGapMs`, `itemPublish.retryBackoffMs`, `itemPublish.maxRetries` and `itemPublish.maxWaitMs`, each with its default and one line on what it bounds.

**US-002**
- `packages/nax/test/unit/workflow/publish-item-threads.test.ts` — the stub outcomes at line 16 (an untyped `result` the typed step returns at line 36) and line 213 must satisfy `ItemThreadsOutcome`, which gains the required `indexWritten` field; each gains `indexWritten: true, indexMissing: false` and is otherwise unchanged.
- `packages/nax/test/integration/workflow/publish-item-threads.test.ts` — the assertion at line 65 pins the step's result for a failed initial read as `{ posted: 0, closed: 0, skipped: 0, failed: 1 }`; it gains `indexWritten: false, indexMissing: true` and is otherwise unchanged. The file also hosts the new test that the feature environment passes `workflow.itemPublish` as `pacing`.
- `packages/nax/test/unit/workflow/item-threads-post.test.ts` — the `outcome` helper at line 96 builds the expected `postItemThreads` result for 15 `toEqual` assertions; it gains `indexWritten: true, indexMissing: false` (parameters, defaulting to those values, where a case expects the index unwritten). The file also gains a `beforeEach` that stubs `_itemPublishPacerDeps.sleep` to resolve at once and an `afterEach` that restores it, because `postItemThreads` without `pacing` now waits the default 1000 ms gap between writes. Every other assertion is unchanged.
- `packages/nax/test/unit/workflow/item-threads-index.test.ts` — gains a `beforeEach` that stubs `_itemPublishPacerDeps.sleep` to resolve at once and an `afterEach` that restores it, because `postItemThreads` without `pacing` now waits the default gap between writes. No assertion changes.
- `packages/nax/test/unit/workflow/item-threads-reopen.test.ts` — gains a `beforeEach` that stubs `_itemPublishPacerDeps.sleep` to resolve at once and an `afterEach` that restores it, because `postItemThreads` without `pacing` now waits the default gap between writes. No assertion changes.
- `packages/nax/test/unit/workflow/finalize-approval-failures.test.ts` — the stub outcome at line 350 is typed `ItemThreadsOutcome`, which gains the required `indexWritten` field; the stub gains `indexWritten: true, indexMissing: false` and is otherwise unchanged.

**US-003**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — `expectedProduces.publish` (lines 57-86) pins the `publish` node's produced fields and line 109 compares them with `toEqual`; US-003 adds `itemIndexMissing` to the node, so the pinned list gains `"itemIndexMissing"` and is otherwise unchanged.

**US-004**
None. A live read that succeeds, or a run with no sidecar, yields today's report with no `decisions` or `itemIndexMissing` key; the existing status tests pin that.

### Seams

- US-002 consumes US-001's `createItemPublishPacer`; the trigger is `postItemThreads` with forge deps whose comment writes fail with a retryable rejection (US-002 AC 1-3).
- US-002 consumes `fc.workflow.itemPublish` through the feature environment's `postItemThreads` step (US-002 AC 10).
- US-003 consumes US-002's `indexMissing`; the trigger is `publishStep` with `env.steps.postItemThreads` stubbed (US-003 AC 2-3).
- US-004 consumes US-003's `itemIndexMissing` record field; the trigger is `workflowStatusCommand` (US-004 AC 8-9).

## Acceptance Criteria

### US-001

1. [unit] Parsing a config with no `workflow.itemPublish` block yields `workflow.itemPublish` equal to `{ writeGapMs: 1000, retryBackoffMs: 60000, maxRetries: 2, maxWaitMs: 300000 }`, and `WORKFLOW_ITEM_PUBLISH_DEFAULTS` equals the same object.
2. [unit] Parsing `workflow.itemPublish: { maxRetries: 5 }` yields `maxRetries: 5` with the other three keys at their defaults.
3. [unit] Parsing `workflow.itemPublish.writeGapMs: -1` fails schema validation.
4. [unit] `isRetryableRejection` returns true for a `NaxError` with code `FORGE_COMMENT_WRITE_FAILED` and `context.stderr` `gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.`
5. [unit] `isRetryableRejection` returns true for a `FORGE_COMMENT_WRITE_FAILED` error whose stderr is `gh: Validation Failed (HTTP 422)`.
6. [unit] `isRetryableRejection` returns true for a `FORGE_COMMENT_WRITE_FAILED` error whose stderr is `gh: HTTP 429`.
7. [unit] `isRetryableRejection` returns false for a `FORGE_COMMENT_WRITE_FAILED` error whose stderr is `gh: HTTP 502: Bad Gateway`.
8. [unit] `isRetryableRejection` returns false for a `NaxError` with code `FORGE_RESPONSE_UNPARSEABLE`, and for a plain `Error`.
9. [unit] With `_itemPublishPacerDeps.sleep` stubbed, a pacer created with `writeGapMs: 1000` runs its first `write` with no sleep and sleeps 1000 ms before its second `write`.
10. [unit] A `write` whose action throws a retryable rejection once and then resolves `"ok"` resolves `"ok"`, after one sleep of `retryBackoffMs`, with the action called twice.
11. [unit] A `write` whose action always throws a retryable rejection, with `maxRetries: 2`, rejects with that rejection after the action was called 3 times.
12. [unit] A `write` whose action throws a `FORGE_RESPONSE_UNPARSEABLE` error rejects with that error after one call and no back-off sleep.
13. [unit] With `writeGapMs: 10`, `retryBackoffMs: 100`, `maxWaitMs: 100`, `maxRetries: 2` and an action that always throws a retryable rejection, the first `write` rejects with that rejection after 2 calls (one 100 ms back-off; a second back-off would exceed the budget), and `spent` is then true.
14. [unit] Continuing the pacer of the previous criterion, a second `write` (whose 10 ms gap would exceed the budget) rejects with `NaxError` code `ITEM_PUBLISH_BUDGET_SPENT` without calling its action.
15. [unit] A pacer created with `maxWaitMs: 0` runs its first `write` (no wait needed) and resolves its result.
16. [unit] After the budget is spent (`spent` true), `writeReserved` still runs its action, and when that action throws a retryable rejection once and then resolves, `writeReserved` resolves after one back-off sleep and `spent` stays true.
17. [unit] A retried `write` called with `{ itemId: "_run:cv1" }` logs a `warn` line `[item-threads] Write rejected; retrying after back-off` with `itemId: "_run:cv1"` and an `attempt` field equal to the retry number.
18. [unit] A `write` called with `{ retries: 0 }` whose action throws a retryable rejection rejects after one call with no back-off sleep, even though the pacer's `maxRetries` is 2.

### US-002

1. [integration] `postItemThreads` with forge deps whose first thread post fails with stderr `gh: Validation Failed (HTTP 422)` and then succeeds, and `_itemPublishPacerDeps.sleep` stubbed, posts that thread (outcome `posted` includes it) after one back-off sleep of `pacing.retryBackoffMs`.
2. [integration] `postItemThreads` with forge deps whose `w-index` write fails once with a secondary-rate-limit stderr and then succeeds returns `indexWritten: true` and `failed: 0`.
3. [integration] `postItemThreads` sleeps `pacing.writeGapMs` between consecutive thread posts: with three postable items and `writeGapMs: 1000`, the stubbed sleep sees at least two calls of 1000 ms before the index write.
4. [integration] `postItemThreads` with `maxWaitMs: 0`, `writeGapMs: 1` and three postable file-level items posts the first thread, counts the second (whose gap was refused) and the third as failed, does not call the forge for either, and logs one `warn` line `[item-threads] Pacing budget spent; skipping remaining threads` with `skipped: 2`.
5. [integration] `postItemThreads` with `maxWaitMs: 0`, `writeGapMs: 1` and three postable items still attempts the `w-index` write after skipping the threads, and returns `indexWritten: true` when that write succeeds.
6. [integration] `postItemThreads` on a PR with no index comment, whose `w-index` post always fails with a retryable rejection, returns `indexWritten: false` and `indexMissing: true` after `maxRetries + 1` index write calls.
7. [integration] `postItemThreads` on a PR that already has an own `w-index` comment, whose edit of it always fails, returns `indexWritten: false` and `indexMissing: false`.
8. [integration] `postItemThreads` whose `w-index` write fails with a non-retryable `FORGE_RESPONSE_UNPARSEABLE` error returns `indexWritten: false` after exactly one index write call.
9. [integration] `postItemThreads` whose initial PR read fails returns `{ posted: 0, closed: 0, skipped: 0, failed: 1, indexWritten: false, indexMissing: true }`.
10. [integration] The feature environment's `postItemThreads` step, built from a config with `workflow.itemPublish.writeGapMs: 7`, passes `pacing.writeGapMs: 7` to `postItemThreads` (stub the forge deps and observe the stubbed sleep receive 7 between two thread posts).
11. [integration] `postItemThreads` with no `pacing` in its input uses `WORKFLOW_ITEM_PUBLISH_DEFAULTS` (the stubbed sleep sees 1000 ms between two thread posts).
12. [integration] A closing reply in `maintainItemIndex` that fails once with a retryable rejection and then succeeds is counted in `closed`, not in `failed`.
13. [integration] A reopen reply in `reopenReraisedItems` that fails once with a retryable rejection and then succeeds reopens the item (it is not counted in `failed`).
14. [integration] `postItemThreads` for an item with `file` and `line` whose inline post fails with stderr `gh: Validation Failed (HTTP 422)` calls the file-level `postItemComment` next with no back-off sleep between the two, and counts the item as posted when that succeeds.

### US-003

1. [unit] `postItemThreadsAfterPublish` returns the outcome its `postItemThreads` step resolved, and returns `undefined` when the publish outcome is `local-only`.
2. [unit] `publishStep` whose `env.steps.postItemThreads` stub resolves `indexMissing: true` returns a patch with `itemIndexMissing: true`.
3. [unit] `publishStep` whose `env.steps.postItemThreads` stub resolves `indexMissing: false` returns a patch with `itemIndexMissing: false`, so a record that held `true` from an earlier publish reads `false` after it.
4. [unit] `publishStep` whose `env.steps.postItemThreads` stub throws returns a patch with no `itemIndexMissing` key.
5. [unit] The `publish` node of the feature graph accepts `itemIndexMissing` in its patch: running the graph's publish node with a stub that resolves `indexMissing: true` leaves `itemIndexMissing: true` on the record.
6. [unit] `buildWorkflowRunSummary` for a record with `itemIndexMissing: true` and feature `demo` returns `itemIndexMissing: { hint: "nax workflow record -f demo" }`.
7. [unit] `buildWorkflowRunSummary` with no feature name, for a record with `itemIndexMissing: true`, returns `itemIndexMissing: { hint: "nax workflow record" }`.
8. [unit] `buildWorkflowRunSummary` for a record with no `itemIndexMissing`, or with `itemIndexMissing: false`, returns a view with no `itemIndexMissing` key.
9. [unit] The end-report `Workflow summary:` line for a view with `itemIndexMissing: { hint: "nax workflow record -f demo" }` contains `item index not written; bot commands will refuse this PR (nax workflow record -f demo)`.

### US-004

1. [integration] `workflowStatusCommand --json` for a draft run whose live read fails, with a newest sidecar holding a `waived` decision for open item `_run:cv1`, reports `settledItems` containing `{ id: "_run:cv1", disposition: "waived" }` and an `openItems` list without `_run:cv1`.
2. [integration] `workflowStatusCommand --json` for a draft run whose live read fails, with a newest sidecar present, keeps `source: "run-record"` and `liveError`, and has `decisions` equal to the sidecar path relative to the project directory.
3. [integration] `workflowStatusCommand --json` for a draft run whose live read fails, with a sidecar whose `outcome` is `promoted`, reports `outcome: "ready"`.
4. [integration] The same with a sidecar `outcome` of `verified-ready` reports `outcome: "ready"`; with `pending` or `abandoned` it keeps the record's `outcome: "draft"`.
5. [integration] A sidecar entry that settles a supplementary item removes it from `supplementaryItems` and lists it in `settledItems`.
6. [integration] A sidecar decision whose id is neither an open nor a supplementary item is ignored: the report still settles the other entries and the command exits as it would without that entry.
7. [integration] A live read that fails and a newest sidecar that does not parse yield the run-record report with `liveError` and no `decisions` key.
8. [integration] `workflowStatusCommand --json` for a run whose record has `itemIndexMissing: true` reports `itemIndexMissing: true`.
9. [integration] The plain output for a run whose record has `itemIndexMissing: true` includes the line `item index not written; settle items with nax workflow record -f <feature>` with the feature name filled in.
10. [integration] A run whose live read succeeds ignores any sidecar: `settledItems` comes from the live read alone and the report has no `decisions` key.
11. [integration] For a draft run whose live read fails, whose open items are a `cannot-verify` item and the CI item, and whose `promoted` sidecar settles the `cannot-verify` item, `workflowStatusCommand` reports no open items (the CI item is removed because the outcome is ready) and exits 0.
12. [integration] A sidecar entry whose `kind` is `finding` for an open item of kind `cannot-verify` does not settle that item.
13. [integration] A `confirmed` sidecar entry of kind `advisor` for an open advisor item settles it: the item is listed in `settledItems` with disposition `confirmed` and removed from `openItems`.
14. [integration] A run whose record has `itemIndexMissing: false` reports no `itemIndexMissing` key.
