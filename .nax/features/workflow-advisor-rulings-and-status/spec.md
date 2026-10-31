# SPEC: confirmed advisor rulings queue fix work, and workflow status reads the PR

Closes: #2751, #2752

## Summary

On a workflow PR, a collaborator reply of `confirm` on an advisor item (`w-*` thread, item kind `advisor`) now means "agreed, the named change is required". The ruling is recorded, but the item is not closed: it stays open work until a `nax bot fix` push answers it. `nax bot review` hands it to `nax bot fix` as an agreed item, `nax bot fix` fixes it, replies `Fixed in <sha>` and resolves the thread, and only then does readiness let the PR be marked ready. A PR with a confirmed advisor item that no fix has answered is held, with a reason that names the item. Separately, `nax workflow status` reads the live PR when the run record is a draft that names a PR: items whose threads carry a ruling are no longer listed as open, and `outcome` is `ready` once the PR is no longer a draft. When the PR cannot be read, the command reports the run record exactly as it does today and says so.

## Motivation

- #2751 (canary.9): on PR #2750 the advisor held `D-1` with a concrete required change. A `confirm: <evidence>` reply settled the item and `nax bot fix` reported `nothing to fix`, so the PR was marked ready with the defect still present. Cause: `rulingEarlier` (`packages/nax/src/bot/review-rulings.ts`) exposes only item kinds `finding` and `ruling` to the review; a ruled item is in `RecordRulingsOutcome.settled` and its thread is resolved by `recordPrRulings` (`packages/nax/src/bot/rulings.ts`); `agreedItems` (`packages/nax/src/bot/post.ts`) therefore never sees it; and `workflowPrReadiness` (`packages/nax/src/bot/workflow-ready.ts`) readies on `outcome.open` being empty whatever the disposition. The finding path already does the right thing (`recordFindingRulings` keeps a `confirmed` finding thread unresolved and the review restores it as agreed work).
- #2752 (canary.9): after `nax bot review 2750` and `nax bot fix 2750` ruled both items and marked the PR ready, `nax workflow status -f chat-acp-model-catalog --json` still reported `outcome: "draft"` with both items open, and exited 2. Cause: `workflowStatusCommand` (`packages/nax/src/cli/workflow.ts`) reads only the run's `result.json`, written at publish time; rulings live on the PR.

## Design

### Terms

- **Confirmed advisor item**: an indexed item thread whose item kind is `advisor` and whose current ruling echo has disposition `confirmed`.
- **Fix-closed**: a confirmed advisor item is fix-closed when the bot's own comment with marker key `fix-<itemKey>` follows the ruling echo in its thread. `<itemKey>` is the thread's `w-<id>.<hash>` key. `nax bot fix` already uses `fix-<key>` for the reply it posts on an agreed finding thread.
- **Outstanding confirmed work**: a confirmed advisor item that is not fix-closed. A later writer reply (for example `fixed <sha>`) reopens the item through the existing reply rules and supersedes the confirmation.

### Integration

Read-only symbols, verified:

- `readItemThreads(threads, comments, login)` and `settleItemThreads(read, canRule)` in `packages/nax/src/workflow/item-thread-state.ts`; `ItemThread` has `key`, `itemId`, `kind`, `thread`, optional `ruling`, `replies`. An item with a ruling and no kept reply is settled; any kept writer reply puts it in `open`.
- `parseItemOpener(body)` and `itemKey(item)` in `packages/nax/src/workflow/item-threads.ts`; `parseItemOpener` returns `{ id, kind, issue }` for an owned item opener.
- `readPrState(forge, prRef, deps, cwd)` in `packages/nax/src/workflow/pr-state.ts` returns `{ isDraft, body, url? }` and throws `WORKFLOW_PR_READ_FAILED`.
- `readPromoteRulings` in `packages/nax/src/workflow/promote-rulings.ts` already performs the read-only PR read this feature needs for status: `prNumberFromUrl`, `resolvePrRef`, `readCurrentUser`, `listReviewThreads`, `listPrComments`, then `readItemThreads` and `settleItemThreads` with a `hasWriteAccess`-backed `canRule`.
- `effectiveEarlier` and `combinedEarlier` in `packages/nax/src/bot/post-earlier.ts` already accept `w-` thread keys; an earlier thread with no review verdict is treated as open and `mergeEarlier` in `post.ts` turns it into an agreed `finding` item.
- `resolveOwnFindings` in `packages/nax/src/bot/fix-report.ts` replies `Fixed in <sha>: <summary>` with marker `fix-<key>` and resolves the thread, but skips every agreed key that starts with `w-`.

Mutated symbols (the baseline only locates the code; implement the target):

`ItemThread` in `item-thread-state.ts`
- Baseline: `{ key, itemId, kind, thread, ruling?, replies }`; `ruling` is parsed only when the thread's last own comment is a `wr-` ruling echo.
- Target: adds `fixClosed?: true`, present only when the item has a parsed `ruling` and an own `fix-<key>` comment follows the ruling echo. The ruling echo is the last own comment whose marker key does not start with `fix-`, so a `fix-` reply never hides a ruling; the `pendingReopens` check compares against that echo comment's id. `replies` is unchanged: the non-own comments after the last own comment of any kind, so a `fix-` reply answers every writer reply before it. `fixClosed` is set for any parsed ruling followed by an own `fix-<key>` comment; the consumers filter on kind `advisor` and disposition `confirmed`. The reopen reader in `item-threads-reopen.ts` still compares against the last own comment of any kind; that mismatch is unreachable because `confirmed` is not a re-raise reopen disposition.

`RecordRulingsOutcome` in `bot/rulings.ts`
- Baseline: `{ index?, unindexed?, recorded, settled, open, asked, failed }`.
- Target: adds optional `confirmedWork?: readonly (ItemThread & { readonly ruling: PrRuling })[]`, absent when empty. Outstanding confirmed work is in `confirmedWork` and in `recorded` when its echo was posted by this call; it is in neither `settled` nor `open`. A fix-closed confirmed item is in `settled`.

`readReviewRulings` in `bot/review-rulings.ts`
- Baseline: returns `{ itemEarlier?, rulings?, itemStatus?, reviewedIndex?, settled? }`.
- Target: also returns optional `itemConfirmed?: readonly ConfirmedItem[]` where `ConfirmedItem = { readonly thread: PrThread; readonly reason: string }`. Each `thread` keeps its first comment and the bot's own comments only. `settled` also lists each outstanding confirmed item with its disposition `confirmed`, so the review does not raise the advisor issue again. `itemStatus.open` and `rulings.open` count an outstanding confirmed item as open.

`PostReviewInput` in `bot/post.ts`
- Baseline: has `earlier?` and `itemEarlier?`.
- Target: adds optional `itemConfirmed?: readonly ConfirmedItem[]`. `combinedEarlier` also includes these threads, and `effectiveEarlier` ignores any review verdict for them (they are always open), so the post step never replies to or resolves them. For each, `effectiveEarlier` marks entries that came from `itemConfirmed` with `confirmed: true` (and the reason), and `mergeEarlier` emits for them an agreed `finding` item with the thread's key, `earlierIssue(thread)` as `issue`, severity `important`, no `file` or `line` (an advisor item's thread anchor is not where the change belongs), and `suggestion` set to the confirmation reason unless it is the default `confirmed`.

`WorkflowStatusReport` in `cli/workflow.ts`
- Baseline: `{ feature, runId, runDir, step, outcome?, ci?, url?, workflowPassed?, reasons, openItems, supplementaryItems }`.
- Target: adds `source: "live" | "run-record"`, `liveError?: string` (only when `source` is `run-record` because a live read was tried and failed) and `settledItems: readonly { id: string; disposition: string }[]` (empty unless `source` is `live`).

### New module

`packages/nax/src/workflow/live-status.ts` exports:

```ts
export type LiveStatus =
  | {
      readonly source: "live";
      readonly isDraft: boolean;
      /** Item ids whose thread carries a ruling that closes the item. */
      readonly settled: readonly { readonly id: string; readonly disposition: string }[];
      /** Item ids that are confirmed advisor items with no fix-closing reply. */
      readonly awaitingFix: readonly string[];
    }
  | { readonly source: "run-record"; readonly error: string };

export function readLiveStatus(input: {
  readonly url: string;
  readonly cwd: string;
  readonly deps: ForgeDeps;
  readonly items: readonly OpenItem[];
}): Promise<LiveStatus>;
```

An item is matched to its thread by `ItemThread.itemId` (the id parsed from the thread opener) for threads in the PR's `w-index`; no `itemKey` hash comparison is done, so a run-record item whose `kind` or `issue` differs from the published opener still matches by id. The `items` input limits the returned ids to those present in the run record. A PR with no `w-index` comment returns `{ source: "run-record", error: "no nax item index on this PR" }`. It never throws and never writes to the forge. `canRule` in `promote-rulings.ts` is exported so both readers share one writer check.

### Failure Handling

- The recorder echoing a `confirm` ruling fails (`replyToThread` throws): the item stays in `open`, `failed` is incremented, as today.
- `resolveThread` fails for an item that is closed: logged, as today. An outstanding confirmed item is never resolved by the recorder.
- A confirmed advisor item whose thread was already resolved by an older nax stays outstanding confirmed work; `nax bot fix` posts its reply and does not try to resolve it again.
- `nax bot fix` runs right after a `confirm` with no `nax bot review` in between: it echoes the ruling but reads the saved `bot-review.json`, so it reports `Nothing to fix`; the PR stays held and the readiness reason says to run `nax bot review` first.
- `nax bot fix` pushes nothing for an agreed confirmed item: no `fix-` reply is posted, the item stays outstanding, and readiness holds with its reason.
- The run record's url carries no PR number (`prNumberFromUrl` returns null): no live read is attempted and no forge command runs; `nax workflow status` reports the run record with `source` `run-record` and no `liveError`. `readLiveStatus` cannot detect a forge, or any forge read throws: it returns `{ source: "run-record", error }`, and `nax workflow status` reports the run record and `liveError`.

## Out of Scope

- The `nax-finish` skill wording (Step 3, advisor row) lives in the separate `nax-toolkit-skills` repository and is not edited here; aligning it with "confirm queues the change for `nax bot fix`" is a manual follow-up after this lands.
- `nax workflow promote` and `nax workflow record` still treat a `confirmed` advisor ruling as a closed item; holding promotion on outstanding confirmed advisor work in the local flow is deferred to a follow-up.
- A `confirm` reply on a non-advisor item kind (`finding`, `ruling`, `cannot-verify`, `gate`, `story`, `ci`, `reason`) is handled exactly as today; only the `advisor` kind gains the queued-work meaning.
- `docs/specs/SPEC-workflow-pr-rulings-review-split.md` is not edited; its "an advisor hold is cleared only by a collaborator reply" note is left as the historical record.
- US-005 only: when `nax bot fix` agrees to a confirmed item but its fix session makes no change, there is no automatic retry or escalation; the PR stays draft with the readiness reason.
- US-007 only: the `ci` field, `reasons` and `supplementaryItems` in `nax workflow status` stay the publish-time snapshot; only the draft state and the item rulings behind `openItems` are read live, and the `_run:ci` item is dropped once the PR is no longer a draft because readiness only marks a PR ready when CI allows it.

## Stories

**US-001: Item threads record when a confirmed ruling has been answered by a fix.** No dependencies. Workdir: `packages/nax`. In `readThread` (`item-thread-state.ts`), take the ruling echo (and the `pendingReopens` comparison) from the last own comment whose marker key does not start with `fix-`, leave `replies` as the non-own comments after the last own comment of any kind, and set `fixClosed: true` on the `ItemThread` when an own `fix-<itemKey>` comment follows the echo.

**US-002: The recorder keeps confirmed advisor items open as outstanding work.** Depends on US-001. Workdir: `packages/nax`. Change `recordPrRulings` (`bot/rulings.ts`) so an advisor item with a `confirmed` ruling that is not fix-closed is returned in `outcome.confirmedWork` instead of `settled`, is never resolved by the recorder, is left out of the PR body checklist ticks, and is left out of the settled count written to the `w-index` comment.

**US-003: Readiness holds on outstanding confirmed advisor work.** Depends on US-002. Workdir: `packages/nax`. In `workflowPrReadiness` (`bot/workflow-ready.ts`) treat `confirmedWork` keys as having a thread, and return `{ ready: false, reason }` naming each outstanding confirmed item and the next step when `confirmedWork` is non-empty and no item is open.

**US-004: The review queues outstanding confirmed advisor work as agreed work.** Depends on US-002. Workdir: `packages/nax`. Return `itemConfirmed` from `readReviewRulings`, list the items in its `settled` and count them in `itemStatus.open`, pass `itemConfirmed` to `post` but not to the review model's `earlier` in `review-run.ts`, and emit them as agreed `finding` items in `bot-review.json` through `combinedEarlier` and `mergeEarlier`.

**US-005: `nax bot fix` answers a confirmed advisor item after its fix push.** Depends on US-004. Workdir: `packages/nax`. In `resolveOwnFindings` (`bot/fix-report.ts`) stop skipping an agreed `w-` key whose thread opener parses as an `advisor` item, so the bot posts the `Fixed in <sha>` reply with marker `fix-<key>` and resolves the thread; for these advisor items only, skip the reply when an own `fix-<key>` comment already follows the thread's latest own `wr-` echo.

**US-006: A read-only reader returns the live ruling state of a draft workflow PR.** Depends on US-001. Workdir: `packages/nax`. Add `workflow/live-status.ts` with `readLiveStatus`, export `canRule` from `workflow/promote-rulings.ts`, and reuse `readPrState`, `readItemThreads` and `settleItemThreads`.

**US-007: `nax workflow status` reports the live PR when the run is a draft.** Depends on US-006. Workdir: `packages/nax`. In `buildReport` (`cli/workflow.ts`) call `readLiveStatus` when the run record's `outcome` is `draft` and its `url` names a PR number (`prNumberFromUrl`), then overlay `outcome` and `openItems`, and add `source`, `liveError` and `settledItems` to the report.

### Context Files

**US-001**
- `packages/nax/src/workflow/item-thread-state.ts` — `readThread`, the function this story changes.
- `packages/nax/src/workflow/item-threads.ts` — `parseRulingEcho` and the `wr-` marker key format.
- `packages/nax/src/bot/fix-report.ts` — where the `fix-<key>` reply is posted today.
- `packages/nax/test/unit/workflow/item-thread-state.test.ts` — existing thread fixtures and style.

**US-002**
- `packages/nax/src/bot/rulings.ts` — `recordPrRulings`, `tickBody`, `refreshIndex`.
- `packages/nax/src/workflow/item-thread-state.ts` — `ItemThread` with `fixClosed` (created by US-001).
- `packages/nax/src/bot/finding-rulings.ts` — the finding path that keeps a confirmed thread unresolved.
- `packages/nax/test/unit/bot/rulings.test.ts` — existing recorder fixtures and `_rulingsDeps` use.

**US-003**
- `packages/nax/src/bot/workflow-ready.ts` — `workflowPrReadiness`.
- `packages/nax/src/bot/rulings.ts` — `confirmedWork` on `RecordRulingsOutcome` (created by US-002).
- `packages/nax/test/unit/bot/workflow-ready.test.ts` — existing readiness fixtures.

**US-004**
- `packages/nax/src/bot/review-rulings.ts` — `readReviewRulings`, `rulingEarlier`, `itemStatus`.
- `packages/nax/src/bot/review-run.ts` — where `review.earlier` and `post.earlier` are assembled.
- `packages/nax/src/bot/post.ts` — `PostReviewInput`, `agreedItems`, `mergeEarlier`.
- `packages/nax/src/bot/post-earlier.ts` — `combinedEarlier`, `effectiveEarlier`.
- `packages/nax/test/unit/bot/review-rulings.test.ts` — existing `readReviewRulings` fixtures.

**US-005**
- `packages/nax/src/bot/fix-report.ts` — `resolveOwnFindings` and `replyStep`.
- `packages/nax/src/workflow/item-threads.ts` — `parseItemOpener`.
- `packages/nax/test/integration/bot/fix-report.test.ts` — existing agreed-thread reply fixtures and `_fixReportDeps` use.

**US-006**
- `packages/nax/src/workflow/promote-rulings.ts` — the read-only PR reader to share `canRule` with.
- `packages/nax/src/workflow/pr-state.ts` — `readPrState`.
- `packages/nax/src/workflow/item-thread-state.ts` — `readItemThreads`, `settleItemThreads`.
- `packages/nax/test/unit/cli/workflow-promote-rulings.test.ts` — existing fake `ForgeDeps` for PR thread reads.

**US-007**
- `packages/nax/src/cli/workflow.ts` — `buildReport`, `exitCodeFor`, `printPlain`.
- `packages/nax/src/workflow/live-status.ts` — `readLiveStatus` (created by US-006).
- `packages/nax/src/workflow/open-items.ts` — `OpenItem` and how items are built.
- `packages/nax/test/unit/cli/workflow-status.test.ts` — existing status fixtures and `WorkflowForgeDeps` use.

### Creates

**US-001**
- `packages/nax/test/unit/workflow/item-thread-state-fix-closed.test.ts`

**US-002**
- `packages/nax/test/unit/bot/rulings-confirmed-work.test.ts`

**US-003**
- None.

**US-004**
- `packages/nax/test/unit/bot/review-rulings-confirmed.test.ts`
- `packages/nax/test/unit/bot/post-confirmed-work.test.ts`

**US-005**
- `packages/nax/test/unit/bot/fix-report-advisor.test.ts`

**US-006**
- `packages/nax/src/workflow/live-status.ts`
- `packages/nax/test/unit/workflow/live-status.test.ts`

**US-007**
- `packages/nax/test/unit/cli/workflow-status-live.test.ts`

### Modifies

None. Every new field is optional and appears only when it has a value (`fixClosed`, `confirmedWork`, `itemConfirmed`), so no existing closed-world shape assertion changes. The `w-` skip in `resolveOwnFindings` is narrowed, not removed: a `w-` key whose opener is not an `advisor` item is still skipped, so the existing skip assertions hold. The `DRAFT` fixture in `workflow-status.test.ts` has `outcome` `draft` and `url` `https://gh/pr/7`, which carries no PR number, so it never triggers a live read and its plain-output assertions hold; the new tests in `workflow-status-live.test.ts` use `.../pull/<n>` urls and a fake `ForgeDeps`, and no test may reach the real `gh` or `git`.

### Seams

- US-001 produces `ItemThread.fixClosed`; US-002 consumes it. The US-002 tests drive `recordPrRulings` over thread fixtures that carry a real `fix-<key>` own comment, so a missing read of `fixClosed` fails.
- US-002 produces `outcome.confirmedWork`; US-003 consumes it in `workflowPrReadiness` and US-004 in `readReviewRulings`. The US-004 tests stub `recordPrRulings` to return a `confirmedWork` entry and call `readReviewRulings`, the entry point `review-run.ts` uses.
- US-004 produces `itemConfirmed`; the US-004 post test calls `postPrReview`, the post step that writes `bot-review.json`, with `itemConfirmed` set and reads the written artifact.
- US-004 produces the agreed `w-` item; US-005 consumes it. The US-005 tests call `replyStep` with `env.review.agreed` holding that item.
- US-006 produces `readLiveStatus`; US-007 consumes it. The US-007 tests call `workflowStatusCommand`, the function the `nax workflow status` command runs, with a fake `ForgeDeps` and assert on the printed report.
- Re-trigger guard: the recorder and `nax bot fix` run on every `nax bot review` / `nax bot fix` call, so US-002 and US-005 each assert that a second run posts no second echo and no second `fix-` reply.

## Acceptance Criteria

### US-001

- [unit] `readItemThreads` over a thread of the opener for advisor item `D-1`, then an own `wr-confirmed-<key>` echo, returns an item with `ruling.disposition` `confirmed` and no `fixClosed` property.
- [unit] `readItemThreads` over the same thread plus an own comment with marker key `fix-<key>` after the echo returns an item with `ruling.disposition` `confirmed` and `fixClosed` `true`.
- [unit] An own `fix-<key>` comment placed before the echo does not set `fixClosed`.
- [unit] An own `fix-<key2>` comment for a different item key after the echo does not set `fixClosed`.
- [unit] A `fix-<key>` comment authored by a login other than the bot login does not set `fixClosed`.
- [unit] A thread with an own `fix-<key>` comment and no ruling echo returns an item with no `ruling` and no `fixClosed`.
- [unit] After the `fix-<key>` comment, a non-own reply from a writer appears in the item's `replies`, and `settleItemThreads` returns that item in `open` with the reply in `kept`.
- [unit] With a non-own reply between the echo and the `fix-<key>` comment, `replies` is empty because the bot comment came after it, and `settleItemThreads` returns the item as settled.
- [unit] The existing thread of an opener and one echo only returns `ruling` and `replies` exactly as before this change.

### US-002

- [unit] `recordPrRulings` over an indexed advisor item `D-1` whose newest writer reply is `confirm: change X` posts one `wr-confirmed-<key>` echo and does not call `resolveThread`.
- [unit] For that call, `outcome.confirmedWork` holds one entry whose `itemId` is `D-1` and whose `ruling.reason` is `change X`.
- [unit] For that call, `outcome.settled` and `outcome.open` do not contain `D-1`, and `outcome.recorded` contains one entry for `D-1`.
- [unit] A second `recordPrRulings` call over the same threads, now carrying the echo, returns `D-1` in `confirmedWork`, posts no echo, and does not call `resolveThread`.
- [unit] With an own `fix-<key>` comment after the echo and the thread unresolved, `recordPrRulings` returns `D-1` in `outcome.settled` with no `confirmedWork` property, and calls `resolveThread` once.
- [unit] An advisor item ruled `fixed <sha>`, `waive: <reason>`, `override: <reason>` or `verified` is returned in `settled` and its thread is resolved, as before this change.
- [unit] A `cannot-verify` item and a `finding` item ruled `confirm` are returned in `settled` and their threads are resolved, as before this change.
- [unit] A confirmed advisor item whose thread is already resolved is returned in `confirmedWork`, and `resolveThread` is not called.
- [unit] When `replyToThread` throws while echoing the `confirm`, `D-1` is returned in `outcome.open`, `failed` is 1, and `confirmedWork` is absent.
- [unit] When the only settled-or-confirmed item is outstanding confirmed work, the PR body checklist edit is not issued, so the checklist line for `D-1` stays unticked.
- [unit] The `w-index` comment is edited with the settled count excluding `D-1` while it is outstanding, and with the count including it once it is fix-closed.
- [unit] A writer reply `fixed <sha>` after a fix-closed confirmation reopens the item and the next call returns it in `settled` with disposition `fixed` and no `confirmedWork` property.

### US-003

- [unit] `workflowPrReadiness` with `confirmedWork` holding `D-1`, empty `open`, a complete index and CI success returns `{ ready: false, reason: "1 confirmed advisor item(s) awaiting a fix: D-1; run nax bot review, then nax bot fix" }`.
- [unit] With `confirmedWork` holding `D-1` and `D-2`, the reason is `2 confirmed advisor item(s) awaiting a fix: D-1, D-2; run nax bot review, then nax bot fix`, in `confirmedWork` order.
- [unit] With a non-empty `open` list and a non-empty `confirmedWork`, the returned reason is the existing `open item(s)` reason.
- [unit] With `confirmedWork` holding `D-1` and CI failing, the returned reason is the confirmed-work reason, not the CI reason.
- [unit] An index key that appears only in `confirmedWork` is not reported as an item without a thread.
- [unit] With `confirmedWork` absent, empty `open` and CI success, the result is `{ ready: true }`.

### US-004

- [unit] `readReviewRulings` over a workflow PR whose recorded outcome has `confirmedWork` holding `D-1` returns `itemConfirmed` with one entry whose `reason` is the ruling reason.
- [unit] The `thread` of that entry holds the opener and the bot's own comments, and no comment from another author.
- [unit] `itemConfirmed` is absent from the result when `confirmedWork` is absent, and `{}` is still returned for `staticMode`.
- [unit] The returned `settled` list contains `D-1` with kind `advisor` and disposition `confirmed`.
- [unit] `itemStatus.open` counts `D-1` as open: with two indexed items, one fix-closed and `D-1` outstanding, `itemStatus` is `{ open: 1, total: 2 }`.
- [unit] `rulings.open` equals the count of `outcome.open` plus `confirmedWork`.
- [unit] `rulingEarlier` still returns no thread for an open item of kind `advisor`.
- [unit] `postPrReview` with `itemConfirmed` holding a thread whose opener key is `w-D-1.<hash>` and reason `change X`, and a verdict with no earlier verdict for it, writes `bot-review.json` whose `agreed` holds an item with kind `finding`, that key, severity `important`, and `suggestion` `change X`.
- [unit] With reason `confirmed` the agreed item has no `suggestion` property.
- [unit] The agreed item has no `file` and no `line` property even when the thread carries a `path` and `line`.
- [unit] The agreed item's `issue` is the first line of the opener, which begins `Open item **D-1** (advisor):`.
- [unit] `postPrReview` posts no earlier-thread reply and does not resolve the thread for an `itemConfirmed` thread, even when `verdict.earlier` holds a `fixed` or `withdrawn` entry with that thread's id; the agreed item is still emitted.
- [unit] `earlierCounts` counts an `itemConfirmed` thread as open.
- [integration] `runBotReview` with `_botReviewDeps.recordPrRulings` stubbed to return `D-1` in `confirmedWork` writes `bot-review.json` whose `agreed` holds the `w-D-1` item, and the review model's input `earlier` list contains no thread for `D-1`.

### US-005

- [unit] `replyStep` with `env.review.agreed` holding a `finding` item keyed `w-D-1.<hash>`, an own thread whose opener parses as an `advisor` item, and `state.pushedSha` set, calls `replyToThread` once with a body starting `Fixed in <first 7 characters of the sha>:` and marker key `fix-w-D-1.<hash>`.
- [unit] In that call `resolveThread` is called once for the thread.
- [unit] For an agreed `w-` key whose opener parses as a `finding` item, neither `replyToThread` nor `resolveThread` is called.
- [unit] For a thread that is already resolved, the reply is posted and `resolveThread` is not called.
- [unit] When `replyToThread` throws, the thread is not resolved and a warning naming the thread id is logged.
- [unit] Running `replyStep` over an advisor thread that already has an own `fix-<key>` comment after its latest `wr-confirmed` echo posts no reply.
- [unit] A second `wr-confirmed` echo after an earlier `fix-<key>` comment (a reopened and re-confirmed item) gets a new `Fixed in` reply.
- [unit] When `resolveThread` throws for a fix-closed thread, a warning naming the thread id is logged and `replyStep` still returns.

### US-006

- [unit] `readLiveStatus` for a PR url, with a fake `ForgeDeps` reporting a non-draft PR and an item thread for `D-1` carrying a `fixed` echo, returns `source` `live`, `isDraft` `false`, and `settled` holding `{ id: "D-1", disposition: "fixed" }`.
- [unit] An item thread with no ruling echo is absent from `settled` and `awaitingFix`.
- [unit] A confirmed advisor item with no `fix-` comment is in `awaitingFix` and absent from `settled`.
- [unit] The same item with a `fix-` comment after the echo is in `settled` with disposition `confirmed` and absent from `awaitingFix`.
- [unit] An echo followed by a reply from an author for whom `hasWriteAccess` is false leaves the item in `settled`; the same reply from a writer removes it from `settled`.
- [unit] An item thread whose key is not in the PR's `w-index` is ignored.
- [unit] A run-record item whose `kind` and `issue` differ from the published opener (so `itemKey` differs) but whose id matches a ruled indexed thread is returned in `settled`.
- [unit] A PR with item threads but no `w-index` comment returns `{ source: "run-record", error }` with the error `no nax item index on this PR`.
- [unit] A `_run:cv1` item with a ruling thread is returned in `settled`, and an item id with no thread is returned in neither list.
- [unit] With a `ForgeDeps` whose `run` throws on any argv that posts, edits or resolves a comment or thread, or marks a PR ready, the call completes.
- [unit] `readLiveStatus` for a url without a PR number returns `{ source: "run-record", error }` with a non-empty `error`, runs no forge command, and does not throw.
- [unit] When `readPrState` fails, or a thread read throws, the result is `{ source: "run-record", error }` carrying the failure message.

### US-007

- [unit] `workflowStatusCommand` over a run record with `outcome` `draft`, a PR `url`, and open items `_run:cv1` and `D-1`, with a fake forge reporting a non-draft PR and both items carrying rulings, returns exit code 0 and prints a report with `outcome` `ready`, empty `openItems`, `source` `live`, and `settledItems` holding both ids.
- [unit] With the PR still a draft and `D-1` ruled while `_run:cv1` has no ruling, the report's `openItems` holds only `_run:cv1`, `outcome` is `draft`, and the exit code is 2.
- [unit] With the PR still a draft and every item ruled, `outcome` stays `draft` and the exit code is 2.
- [unit] A confirmed advisor item with no `fix-` comment stays in `openItems`, and a non-draft PR with such an item reports `outcome` `ready` with `D-1` still open and exit code 2.
- [unit] When the live read fails, the report equals the run-record report, has `source` `run-record` and a `liveError` equal to the failure message, and the exit code is the run-record exit code.
- [unit] With a run record whose `outcome` is `ready`, a draft record with no `url`, or a draft record whose `url` carries no PR number (for example `https://gh/pr/7`), the fake forge's `run` is never called, `source` is `run-record`, there is no `liveError`, and the plain output has no `(run record only:` line.
- [unit] `supplementaryItems` in the report equal the run record's supplementary items on a live read.
- [unit] `workflowPassed`, `reasons`, `ci` and `step` in the report are the run record's values after the overlay.
- [unit] With a non-draft PR and a run record that lists `_run:ci` as an open item, the report's `openItems` has no `_run:ci`; with a draft PR it stays listed.
- [unit] `--json` output contains `source`, and contains `liveError` only on a failed live read.
- [unit] Plain output after a failed live read prints a line `(run record only: <error>)` after the first line, and prints no such line on a live read.
- [unit] Running `workflowStatusCommand` twice over the same fakes prints the same report and calls no forge command that writes.
