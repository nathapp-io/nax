# SPEC: Bot rerun state (GitLab replies, re-raised items, settled visibility, ready path)

Closes: #2694

## Summary

Bundle 3 of the 2026-10-22 bot review gap analysis, plus the two security-list leftovers (C3, C7). Five fixes to how
`nax bot review`, `nax bot fix` and the workflow publish read and write PR state across reruns:

1. **GitLab replied notes (C1).** A reply turns a GitLab standalone note into a discussion, so nax's own top-level
   comments (`summary`, `w-index`, `w-evidence`, `fix-summary`) drop out of `listPrComments`. nax then posts a
   duplicate summary on every review, and a reply to the item index hides it ("no nax item index").
2. **Re-raised items (C2, C4).** A workflow item that a later run raises again keeps its old `fixed`/`verified`
   ruling, so readiness passes on a stale claim. A bot finding re-raised inside a thread that was resolved is edited
   in place, invisible under the resolved thread.
3. **Settled items invisible (#2694).** After `nax bot review` records rulings, the item index still reads
   `open items: N` and the review summary never names the settled items.
4. **Ready path (C3, C5, C7).** `nax bot fix` marks a PR ready by bare number (`gh pr ready 42`), so a
   `gh repo set-default` pointing elsewhere can hit the wrong PR; the non-workflow ready path never re-reads the head
   after CI; a failed ready write throws and skips the fix summary; the push has no lease; `hasOpenPr` reads
   unparseable output as "no PR", which risks a duplicate PR.
5. **Stale body line (C8).** A draft workflow PR tells the reader to "run `gh pr ready`" while items are open, also
   on GitLab.

## Motivation

The 2026-10-22 report (`projects/nax/nax-bot-review-gap-analysis-2026-10-22.md`, section C) found these on main
`6bbc33906`. Each was re-checked on main `58e3a7928` before this spec:

- C1: `listPrComments` (`src/forge/threads.ts`) keeps only GitLab discussions with `individual_note === true`.
  `listReviewThreads` keeps the rest, so a replied nax note becomes a thread. `postSummary` (`src/bot/post.ts`) looks
  for `key === "summary" && threadId === undefined` and posts a second summary. `readItemThreads`
  (`src/workflow/item-thread-state.ts`) reads `w-index` from top-level comments only, so the index disappears and
  `workflowPrReadiness` holds with "no nax item index on this PR". `writeEvidence` reads `w-evidence` from comments
  only. On GitLab a human's reply under nax's summary is also invisible to the review, because `triage` drops
  threads opened by nax.
- C2: `postItemThreads` (`src/workflow/item-threads-post.ts`) skips an already-owned item key, and
  `readThread` takes the last own `wr-` echo as the ruling, so `settleItemThreads` settles a re-raised item from the
  old ruling.
- C4: `writeFinding` (`src/bot/post.ts`) edits an own finding comment in place whatever its thread's state. When a
  finding thread was resolved without a settling ruling (the bot judged the earlier finding fixed, or a confirmed
  finding's fix closed it) and the review raises it again, the edit lands inside the hidden thread.
- #2694: `maintainItemIndex` is called only at publish; `renderReviewSummary` counts `threadsAnswered` only.
- C3: `readyStep` (`src/bot/fix-report.ts`) runs `markReadyArgv(forge, String(env.ref.number))`;
  `nax workflow promote` already passes the PR URL.
- C5: on the non-workflow path `readyStep` marks ready right after `waitForCi`, with no head re-read. A green poll
  whose head read failed has no sha (`bindToHead` lets it through by design), so nothing binds the readiness to the
  pushed head.
- C7: `pushStep` (`src/bot/fix-steps.ts`) pushes without a lease, so an author's force-push that dropped commits
  is undone when nax's fix fast-forwards over the older ref. `hasOpenPr` (`src/forge/pr.ts`) returns `false` on
  unparseable output. `readyStep` throws `BOT_FIX_READY_FAILED`, which skips `reportStep`.
- C8: `beforeReady` (`src/workflow/pr-body.ts`) ends with "Then: rerun the repo gates, push, and run
  `gh pr ready`."

C6 ("readiness may ignore gates-red or conflict holds") was checked and needs no change: a red gate exits `gates` to
`report` and never reaches `ready`, and `ciAllowsReady` admits only `green`, so a conflicting PR never passes.

User rulings (2026-10-28): one spec for bundle 3 plus C3/C7; a re-raise cancels `fixed` and `verified` rulings only
(`waived`, `confirmed`, `overridden` carry over); the index line changes to `nax workflow items: N (S settled)`, and
an older nax reading the new line holds readiness until upgraded.

## Design

### Approach

**C1: flatten replied nax top-level notes on GitLab.** GitHub has no replies to top-level comments: a response is a
new top-level comment. GitLab's reply converts the note into a discussion. The GitLab readers restore GitHub's
shape: a discussion with `individual_note === false` whose first non-system note has no `position` and carries a
nax-bot marker whose key is one of `TOP_LEVEL_MARKER_KEYS` (`summary`, `w-index`, `w-evidence`, `fix-summary`) is
returned by `listPrComments` as top-level comments (every non-system note, in order, `kind: "comment"`) and is left
out of `listReviewThreads`. Every consumer then works unchanged: own-comment lookups find the note, and a human's
reply reaches the review as a top-level comment behind the existing writer gate. The marker alone does not establish
ownership: flattening changes only how a discussion is classified, and `ownComments` still requires the
authenticated login. Item threads (`w-<id>.<hash>`) and finding threads (`f-…`) are never flattened.

`src/forge/marker.ts` imports `listPrComments` from `src/forge/threads.ts`, so `threads.ts` cannot import the marker
parser from `marker.ts` without a runtime cycle (`check:import-cycles`). The marker grammar moves to a new leaf,
`src/forge/marker-grammar.ts`; `marker.ts` imports from it and re-exports `isNaxBotMarkerKey` and
`parseNaxBotMarker`, so `@/forge` exports are unchanged.

**C2: a re-raise by a newly reviewed head reopens fixed/verified items.** At publish, `postItemThreads` already
computes the index's reviewed head through `reviewedIndex(input, read.index)`. When that returns a `reviewedHead`
that differs from the previous index's `reviewedHead`, the run reviewed new code; a previous index with no reviewed
head (`Reviewed head: none`, written by an incomplete review) counts as different, so the first fully reviewed run
after it can reopen. For each owned item thread whose key is among this publish's item keys, whose current ruling is
`fixed` or `verified`, and which has no reply from a writer after that ruling (a writer's pending reply already
keeps the item open and must not be hidden behind the notice; a reply from someone without write access is dropped
by `settleItemThreads`, so it must not block the reopen), nax replies on the thread with a reopen notice (marker key
`reopenKey(key)` = `wo-<key>`) and unresolves the thread. `readThread` takes the last own comment as the ruling only
when it is a `wr-` echo, so after the notice the item has no ruling and stays open until someone rules again. A
publish whose reviewed head did not change (a CI-repair republish, a resume, an incomplete review) never reopens a
ruled item.

A **closed item raised again** is reopened the same way, at any publish: an owned item thread whose last own comment
is its closure notice (`closedKey(key)`, written when the item dropped out of a run) and whose key is among this
publish's keys gets the reopen notice and is unresolved. Without this the item is open for readiness but its thread
stays resolved and reads "No longer open".

A reopen write that fails is retried at the next publish. When `reopenReraisedItems` reports `failed > 0`, the
index keeps the previous index's reviewed head and base instead of the new ones, so the next fully reviewed publish
still sees a changed head and retries a failed reply. A notice that was posted but whose unresolve failed leaves the
thread with the notice as its last own comment and still resolved; at any publish where its key is among the keys,
`reopenReraisedItems` unresolves such a thread again without posting a second notice. Readiness is unaffected; only
the next review's incremental range starts earlier.

The writer check reuses `writerCheck` and `hasWriteAccess` from `@/forge`, with the same cache and fail-closed rule
the recorder uses: a login whose check rejects counts as having no write access, so the reopen goes ahead.

**C4: unresolve a resolved finding thread when the finding is raised again.** `postPrReview` gains
`resolvedThreadIds`, the ids of the bot's own finding threads that are resolved. `writeFinding` edits the own
comment as today and then, when its thread is in `resolvedThreadIds`, unresolves the thread. `writeFinding` catches
an unresolve failure itself, logs it and returns a flag; `postFindings` then lists the finding off-line in the summary
instead of counting it inline, so it stays visible. The existing rethrow of a failed edit of an owned comment is
unchanged.

**#2694: show settlement.** The index's first line becomes `nax workflow items: <N> (<S> settled)`. The listed keys,
their count and the reviewed head/base lines are unchanged, so readiness is unchanged; `S` is presentation only and
`parseItemIndex` does not return it. The parser still accepts the legacy `nax workflow open items: <N>` line. The
publish writes `S` as the number of this publish's keys whose thread carries a ruling with no later reply and was not
just reopened. `recordPrRulings` rewrites the index comment after settlement when its `S` changes. The review summary
gains two lines from a new `itemStatus` field, present only when the PR has a readable index: the item rulings this
review recorded (at most 20 listed, then `and <n> more`; each id passed through `safeText`; `by` is a forge login
emitted verbatim after `@`, or `nax bot` when it is `null`), and
`Open items: <O> of <N>`.

**C3/C5/C7: ready and push.** `readyStep` marks ready with `markReadyArgv(env.ref.forge, env.info.url)` on both
paths. On the non-workflow path, after the green CI wait and after the existing `throwIfAborted()`, it re-reads the
PR and holds when the head is not the expected sha, `state.pushedSha ?? env.info.headSha` (the value `waitForCi`
already binds CI to). A non-zero ready exit becomes a hold
(`readyHeld: "could not mark ready: …"`) so `reportStep` still runs. `pushStep` adds
`--force-with-lease=refs/heads/<headRef>:<info.headSha>`. `hasOpenPr` throws on unparseable or non-array output;
its three callers (`auto-pr` `shouldRun` and `execute`, `openDraftFinishPr`) already treat a throw as "unknown, do
not open".

**C8.** The last line of "Before marking ready" becomes: `Then: rule on each item by replying on its thread, and run`
`` `nax workflow promote -f <feature> --yes` `` `to mark the PR ready once every item is settled and CI is green.`
(one line; `<feature>` is the PR's feature name).

### Integration

Read or called, unchanged:

- `ownComments(comments, login, threadId?)` (`src/forge/marker.ts`): own = `author === login` and a valid marker.
- `withNaxBotMarker(body, key)` (`src/forge/marker.ts`): `**nax bot**\n\n<body>\n\n<!-- nax-bot:v1 key=<key> -->`.
- `replyToThread(ref, thread, body, deps, cwd)`, `resolveThread(ref, thread, deps, cwd)`,
  `editComment(ref, comment, body, deps, cwd)`, `runForgeWrite(ref, argv, deps, cwd)` (`src/forge/comments.ts`);
  `runForgeWrite` throws `NaxError` `FORGE_COMMENT_WRITE_FAILED` on a non-zero exit.
- `settleItemThreads(read, canRule)` (`src/workflow/item-thread-state.ts`).
- `workflowPrReadiness({ outcome, ci })` (`src/bot/workflow-ready.ts`).
- `waitForPrHead`, `waitForCi`, `workflowReadyHold` (`src/bot/fix-report.ts`); `_fixReportDeps.readPrInfo`.
- `openDraftFinishPr(args, deps)` (`src/finish/pr/open.ts`) returns `null` when `hasOpenPr` throws.
- `PrInfo.url` (`src/forge/pr-types.ts`), the PR's web URL.
- `findingKey(finding)` (`src/bot/render.ts`).

Changed. The baseline only locates the code; the target is the interface to implement.

- Marker grammar. Baseline: `MARKER_KEY_PATTERN`, `markerPattern`, `isNaxBotMarkerKey`, `parseNaxBotMarker` in
  `src/forge/marker.ts`. Target: in new `src/forge/marker-grammar.ts`, plus
  `export const TOP_LEVEL_MARKER_KEYS = ["summary", "w-index", "w-evidence", "fix-summary"] as const`; `marker.ts`
  imports and re-exports `isNaxBotMarkerKey` and `parseNaxBotMarker`; `src/forge/index.ts` also exports
  `TOP_LEVEL_MARKER_KEYS`.
- `listPrComments(ref, deps, cwd)`. Baseline: GitLab keeps `individual_note === true` discussions only. Target: also
  returns every non-system note of a flattened discussion (Approach, C1), as `kind: "comment"`, in discussion order.
- `listReviewThreads(ref, deps, cwd)`. Baseline: GitLab keeps every `individual_note === false` discussion. Target:
  leaves flattened discussions out.
- `hasOpenPr(forge, branch, deps, cwd)`. Baseline: unparseable or non-array JSON returns `false`. Target: throws
  `NaxError` `FORGE_PR_LIST_UNPARSEABLE` (stage `forge`, context `{ forge, branch }`).
- New `unresolveThread(ref, thread: Pick<PrThread, "id">, deps, cwd): Promise<void>` in `src/forge/comments.ts`,
  exported from `@/forge`. GitHub: GraphQL
  `mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }` with the id as
  a raw `-f id=` variable, as `resolveThread` does. GitLab: `PUT` on the discussion endpoint with `resolved=false`;
  the discussion id is validated like `resolveThread`'s.
- `PostReviewInput` (`src/bot/post.ts`). Target: gains `readonly resolvedThreadIds?: ReadonlySet<string>` and
  `readonly itemStatus?: ItemStatus`.
- `reviewEnvironment` (`src/bot/review-run.ts`). Target: sets `resolvedThreadIds` to the ids of `ownFindingThreads`
  whose `resolved` is `true`.
- `ItemStatus` (new, exported from `src/bot/review-rulings.ts`):
  `{ readonly recorded: readonly { readonly id: string; readonly disposition: Disposition; readonly by: string | null }[]; readonly open: number; readonly total: number }`.
- `readReviewRulings(input, record)`. Target: on success, and only when `outcome.index` is present, also returns
  `itemStatus`: `recorded` from `outcome.recorded` (`itemId`, `disposition`, `by`), `total` =
  `outcome.index.keys.length`, `open` = `total` minus the settled items whose key is in the index. With no index it
  returns no `itemStatus`. Static mode and recorder failure still return `{}`.
- `ReviewSummaryInput` (`src/bot/render-comments.ts`). Target: gains `readonly itemStatus?: ItemStatus`;
  `postSummary` passes `input.itemStatus`.
- `reviewedIndex(input, previous)` (`src/workflow/item-threads-index.ts`). Baseline: module-private. Target: exported,
  behaviour unchanged.
- `maintainItemIndex(input, keys, context)`. Target after US-005:
  `maintainItemIndex(input, keys, context, options: { keepReviewed?: boolean } = {})`, where `reviewed` is the previous
  index's `reviewedHead`/`reviewedBase` when `keepReviewed` is true, else `reviewedIndex(input, read.index)`. Target
  after US-006: the options gain `settled?: number` (default 0) and the index body is
  `renderItemIndex({ keys, ...reviewed }, options.settled ?? 0)`.
- `renderItemIndex(index)`. Target: `renderItemIndex(index: ItemIndex, settled = 0): string`, first line
  `nax workflow items: <keys.length> (<settled> settled)`.
- `parseItemIndex(body)`. Target: accepts either first line `nax workflow open items: <N>` or
  `nax workflow items: <N> (<S> settled)`; returns `null` when `S > N`; returns the same `ItemIndex` shape as today
  (no settled field).
- New in `src/workflow/item-threads.ts`: `reopenKey(key) => "wo-" + key`;
  `renderItemReopened(sha)` => `Raised again by the run at <first 7 of sha>. Reply on this thread to rule on it.`;
  `REOPENED_BY_RERAISE: ReadonlySet<Disposition>` = `fixed`, `verified`.
- New `src/workflow/item-threads-reopen.ts`: `reopenReraisedItems(input: ItemThreadsInput, keys: readonly string[], context: ReopenContext): Promise<{ reopened: ReadonlySet<string>; failed: number }>`,
  with `ReopenContext = { ref, read, login, deps, cwd, info }` (the fields `maintainItemIndex`'s context already has). It
  handles the cases in Approach (C2): a ruled `fixed`/`verified` item with no later writer reply when the reviewed
  head changed (US-004); a closed item (last own comment `closedKey(key)`) at any publish, and an already-posted
  notice whose thread is still resolved, unresolved without a second notice (US-005). `reopened` holds every key a
  reopen was attempted for, whether or not the write succeeded; those keys never count as settled. The notice's sha is
  `input.head`, falling back to `info.headSha`.
- `postItemThreads`. Target: after posting new items, calls `reopenReraisedItems`, adds its `failed` to the outcome,
  then calls `maintainItemIndex` with the settled count and, when that `failed` is above 0, with the previous index's
  reviewed head and base kept. `ItemThreadsOutcome` is unchanged.
- `recordPrRulings` (`src/bot/rulings.ts`). Target: after settlement, when `read.indexComment` and `read.index` exist
  and the settled count (settled items whose key is in `read.index.keys`) gives a body different from the current
  one, edits the index comment through `_rulingsDeps.editComment` (new dep, default `editComment`) with
  `withNaxBotMarker(renderItemIndex(read.index, settled), "w-index")`.
- `readyStep(env, state)`. Target: see Approach (C3/C5/C7).
- `pushStep(env, state)`. Baseline argv `["push", "--no-verify", "origin", "HEAD:refs/heads/<headRef>"]`. Target:
  `["push", "--no-verify", "--force-with-lease=refs/heads/<headRef>:<env.info.headSha>", "origin", "HEAD:refs/heads/<headRef>"]`.
- `beforeReady(input)` (`src/workflow/pr-body.ts`). Target: last line as in Approach (C8).

### Failure Handling

| Failure | Behaviour |
|---|---|
| `hasOpenPr` gets unparseable or non-array JSON | throws `FORGE_PR_LIST_UNPARSEABLE`; `openDraftFinishPr` returns `null` without opening a PR |
| `unresolveThread` forge write fails | rejects with the `runForgeWrite` error (`FORGE_COMMENT_WRITE_FAILED`) |
| C4 unresolve fails | `warn("bot-post", "Could not reopen a re-raised finding thread", { key, threadId, error })`; the finding goes to the off-line list, not counted inline |
| C2 reopen reply fails | `warn("item-threads", "[item-threads] Reopen write failed", { itemId, error })`; no unresolve; outcome `failed` + 1; the index keeps the previous reviewed head, so the next fully reviewed publish retries |
| C2 unresolve fails after the reply | same warning; outcome `failed` + 1; the index keeps the previous reviewed head; the item is open (its last own comment is the notice), and a later publish unresolves the thread without a second notice |
| Writer check for a reply rejects | that reply's author counts as having no write access; the reopen goes ahead |
| Index refresh edit in `recordPrRulings` fails | `warn("bot-rulings", "[bot-rulings] Could not refresh the item index", { error })`; the outcome is returned unchanged |
| PR re-read after green CI rejects (non-workflow ready path) | `readyHeld: "PR head could not be re-read"`, not marked ready |
| PR re-read shows another head | `readyHeld: "PR head changed since this execution"`, not marked ready |
| Ready command exits non-zero | `readyHeld: "could not mark ready: <trimmed stderr>"`, or `"could not mark ready: exit code <n>"` when stderr is empty; exit `report` |
| Push rejected by the lease | existing `push-rejected` outcome |

## Out of Scope

- A bot finding (`f-` key) settled by a writer ruling and raised again by a later review stays settled and skipped; only workflow items are reopened on a re-raise.
- Workflow item rulings `waived`, `confirmed` and `overridden` carry over when the same item is raised again; only `fixed` and `verified` are cancelled.
- A publish whose reviewed head is unset or unchanged (CI-repair republish, resume, incomplete review) never reopens a ruled item, even when the ruling predates the run.
- A reopened item that later drops out of a run again is not re-closed: `maintainItemIndex` skips any thread that already has an own closure notice, so the thread stays open with its reopen notice. Readiness is unaffected.
- The index rewrite in `recordPrRulings` edits from the comment snapshot it read; it does not re-read the index first, so a publish that rewrote the index in between can be overwritten until the next publish.
- US-008 only: a ready write rejected for reasons other than a non-zero exit (spawn failure, abort) still rejects as today.
- The review summary does not link each recorded item to its thread; it names id, disposition and who ruled.
- The `nax bot fix` "Nothing to fix" comment does not list recorded rulings.
- Finding rulings echoed by `recordFindingRulings` are not listed in the new item-rulings summary line; they stay in the existing counts.
- The publish's settled count does not run the writer permission check; a thread with any reply after its ruling counts as not settled.
- An older nax install that reads the new index line treats the PR as having no item index and holds readiness until upgraded.
- A GitLab discussion opened by someone else with a forged top-level marker is flattened into top-level comments; it gains no ownership and stays behind the writer gate.
- The `--dry-run` push access probe keeps its argv; only the real push gains the lease.
- `bindToHead` keeps letting a green poll with no sha through; the non-workflow ready path closes the gap with its own head re-read instead.
- S11 (`--trust` with sandboxed gates for untrusted PRs) stays deferred.
- User documentation of the index line and the reopen notice is a manual follow-up after merge.

## Stories

There are eight stories, all in `packages/nax`, and they share one theme: the PR state nax reads back on a rerun
must match what actually happened. The user confirmed this is one spec (2026-10-28). It has 8 stories only because
two pieces outgrew the per-story cap:
- The re-raise work is three stories: wire format and state, ruled items at publish, then closed items and retry.
- Settlement visibility is two stories: the index, then the summary.

### US-001: GitLab replied nax notes stay top-level; `hasOpenPr` fails closed
No dependencies. Workdir: packages/nax.

- Moves the marker grammar to `src/forge/marker-grammar.ts` and adds `TOP_LEVEL_MARKER_KEYS` there.
- Flattens replied nax top-level notes in the GitLab readers.
- Makes `hasOpenPr` throw on unparseable output.

### US-002: `unresolveThread` and re-raised findings in resolved threads
No dependencies. Workdir: packages/nax.

- Adds `unresolveThread` to the forge.
- Adds `resolvedThreadIds` to `PostReviewInput` and sets it in `reviewEnvironment`.
- Unresolves the thread of an own finding that is raised again.
- `writeFinding` catches an unresolve failure itself.

### US-003: Reopen notice wire format and its effect on item state
No dependencies. Workdir: packages/nax.

- Adds `reopenKey`, `renderItemReopened` and `REOPENED_BY_RERAISE` to `src/workflow/item-threads.ts`.
- Pins that when a reopen notice is the last own comment, the item has no ruling.

### US-004: Publish reopens re-raised fixed/verified items
Depends on US-002, US-003. Workdir: packages/nax.

- Adds `src/workflow/item-threads-reopen.ts` with `reopenReraisedItems`. This story covers the ruled-item case only, including the writer-reply check.
- Exports `reviewedIndex`.
- Calls the reopen from `postItemThreads`.

### US-005: Publish reopens re-raised closed items and retries a failed reopen
Depends on US-004. Workdir: packages/nax.

- Extends `reopenReraisedItems` with the closed-item case and the unresolve-only retry.
- Adds `keepReviewed` to `maintainItemIndex`, which `postItemThreads` sets when the reopen reports failures.

### US-006: The item index shows how many items are settled
Depends on US-005. Workdir: packages/nax.

- Changes the index line to `nax workflow items: N (S settled)`; the parser accepts both the old and new line.
- Writes the settled count at publish by adding `settled` to `maintainItemIndex`.
- Writes it again after `recordPrRulings`.

### US-007: The review summary names recorded item rulings; the draft body names the real next step
No dependencies. Workdir: packages/nax.

- Adds `ItemStatus`, and adds `itemStatus` to `readReviewRulings`, `PostReviewInput` and `ReviewSummaryInput`.
- Adds the two summary lines `itemStatus` drives.
- Rewrites the closing line of "Before marking ready".

### US-008: `nax bot fix` marks ready by URL, re-reads the head, holds on a failed ready write, pushes with a lease
No dependencies. Workdir: packages/nax.

- Changes `readyStep` in `src/bot/fix-report.ts`.
- Changes `pushStep` in `src/bot/fix-steps.ts`.

### Context Files

**US-001**
- `packages/nax/src/forge/threads.ts` — `listPrComments`, `listReviewThreads`, `gitlabThread`, `GitlabDiscussion`
- `packages/nax/src/forge/marker.ts` — the marker grammar to move, `ownComments`, `findOwnComments`
- `packages/nax/src/forge/pr.ts` — `hasOpenPr`
- `packages/nax/test/unit/forge/threads-comments.test.ts` — GitLab discussion fixtures and harness
- `packages/nax/test/unit/workflow/item-threads-index.test.ts` — the GitHub forge harness for `postItemThreads`. The GitLab AC needs a GitLab variant of it (discussions endpoint, `PUT notes/<id>`).

**US-002**
- `packages/nax/src/forge/comments.ts` — `resolveThread`, `RESOLVE_REVIEW_THREAD`, `endpointId`, `runForgeWrite`
- `packages/nax/src/bot/post.ts` — `PostReviewInput`, `writeFinding`, `postFindings` and its rethrow of a failed owned edit
- `packages/nax/src/bot/review-run.ts` — `reviewEnvironment`, `ownFindingThreads`, the `post` object
- `packages/nax/test/integration/bot/post-threads.test.ts` — the `postPrReview` harness with a captured forge
- `packages/nax/test/integration/bot/review-run-finding-rulings.test.ts` — the `runBotReview` harness with own finding threads

**US-003**
- `packages/nax/src/workflow/item-threads.ts` — `closedKey`, `renderItemClosed`, `parseRulingEcho`
- `packages/nax/src/workflow/item-thread-state.ts` — `readThread`, `readItemThreads`, `settleItemThreads`
- `packages/nax/test/unit/workflow/item-thread-state.test.ts` — item thread fixtures

**US-004**
- `packages/nax/src/workflow/item-threads-post.ts` — `postItemThreads`, `readContext`
- `packages/nax/src/workflow/item-threads-index.ts` — `reviewedIndex`, `maintainItemIndex`, `IndexContext`
- `packages/nax/src/workflow/item-thread-state.ts` — `ItemThread.replies`, `readItemThreads`
- `packages/nax/src/forge/access.ts` — `writerCheck`, `hasWriteAccess`
- `packages/nax/test/unit/workflow/item-threads-index.test.ts` — the GitHub forge harness for publish

**US-005**
- `packages/nax/src/workflow/item-threads-reopen.ts` — `reopenReraisedItems`, created by US-004, extended here
- `packages/nax/src/workflow/item-threads-index.ts` — `maintainItemIndex`, `closedKey` closures
- `packages/nax/src/workflow/item-threads-post.ts` — `postItemThreads`
- `packages/nax/test/unit/workflow/item-threads-reopen.test.ts` — created by US-004, extended here

**US-006**
- `packages/nax/src/workflow/item-threads.ts` — `renderItemIndex`, `parseItemIndex`, `ItemIndex`
- `packages/nax/src/workflow/item-threads-index.ts` — `maintainItemIndex`
- `packages/nax/src/workflow/item-threads-reopen.ts` — `reopenReraisedItems` and its `reopened` set, created by US-004
- `packages/nax/src/bot/rulings.ts` — `recordPrRulings`, `_rulingsDeps`
- `packages/nax/test/unit/bot/rulings.test.ts` — the recorder harness

**US-007**
- `packages/nax/src/bot/review-rulings.ts` — `readReviewRulings`
- `packages/nax/src/bot/render-comments.ts` — `renderReviewSummary`, `readinessLines`, `boundedSummary`, `ReviewSummaryInput`
- `packages/nax/src/bot/post.ts` — `PostReviewInput`, `postSummary`
- `packages/nax/src/workflow/pr-body.ts` — `beforeReady`
- `packages/nax/test/integration/bot/review-run-finding-rulings.test.ts` — a `runBotReview` harness with real `postPrReview` and forge capture

**US-008**
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, `workflowReadyHold`, `_fixReportDeps`
- `packages/nax/src/bot/fix-steps.ts` — `pushStep`
- `packages/nax/src/workflow/promote.ts` — `markReadyArgv`
- `packages/nax/test/integration/bot/fix-report.test.ts` — the non-workflow ready harness
- `packages/nax/test/integration/bot/fix-graph.test.ts` — the step-graph harness. Its `beforeEach` stubs `_botFixDeps.readyStep` and `reportStep`. The seam test restores both real steps, stubs `_fixReportDeps.waitForPrHead`, `waitForChecks`, `readPrInfo` (head equal to the stub `pushedSha`) and `postPrComment`, and uses `makeBotFixDraftEnv`.

### Creates

**US-001**
- `packages/nax/src/forge/marker-grammar.ts`

**US-004**
- `packages/nax/src/workflow/item-threads-reopen.ts`
- `packages/nax/test/unit/workflow/item-threads-reopen.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/forge/pr.test.ts` — the test "false when the forge returns unparseable output" (about line 78) expects `hasOpenPr` to resolve `false` for stdout `not json`. It becomes a rejection with code `FORGE_PR_LIST_UNPARSEABLE`. A parseable empty list still resolves `false`.

**US-006**
- `packages/nax/test/unit/workflow/item-threads.test.ts` — "AC-15 renders ordered index" and "retains unpostable keys and omits base without head" (about lines 137 and 143) expect the first rendered line `nax workflow open items: <N>`. It becomes `nax workflow items: <N> (0 settled)`. The reviewed head and base lines and the key lines are unchanged. The parser cases that use the legacy line stay as they are.
- `packages/nax/test/unit/bot/rulings.test.ts` — the `beforeEach` assigns mocks onto `_rulingsDeps`. It also assigns `editComment` to a mock, so the AC-10 and AC-12 cases that count `run` calls (about lines 194, 221 and 234) still count only the PR body edit. Their expected counts are unchanged.
- `packages/nax/test/unit/bot/rulings-model.test.ts` — the `beforeEach` that assigns `_rulingsDeps` mocks also assigns `editComment` to a mock, so the new index refresh never reaches the shared forge `run` mock. No assertion changes.
- `packages/nax/test/integration/bot/review-run-rulings.test.ts` — the tests that run the real `recordPrRulings` (about lines 157-195) assign `_rulingsDeps` mocks without `editComment`. With the index refresh they would spawn a real `gh api` PATCH through the default forge deps. The `Object.assign` onto `_rulingsDeps` also sets `editComment` to a mock. No assertion changes.
- `packages/nax/test/integration/bot/review-run-finding-rulings.test.ts` — the test with a workflow index (about line 228) runs the real `recordPrRulings`. The `_rulingsDeps` assignment also sets `editComment` to a mock, so the refresh is hermetic. No assertion changes.

**US-007**
- `packages/nax/test/unit/workflow/pr-body.test.ts` — the draft "Before marking ready" test (about line 190) expects the line "Then: rerun the repo gates, push, and run `gh pr ready`." It becomes the new closing line, which names `nax workflow promote -f <feature> --yes` with the fixture's feature name.

**US-008**
- `packages/nax/test/integration/bot/fix-report.test.ts` — three changes, all with a `_fixReportDeps.readPrInfo` stub that resolves `env.info` with `headSha` set to `state.pushedSha ?? env.info.headSha`, so the new head re-read passes. (1) "AC-14/15: marks a green %s draft ready in repo root" (about line 349) expects `markReadyArgv(forge, "42")`; it becomes `markReadyArgv(forge, env.info.url)`. (2) "AC-16: rejects failed readiness writes without claiming success" (about line 397) expects a `BOT_FIX_READY_FAILED` rejection; it becomes a resolved `{ patch: { markedReady: false, readyHeld: "could not mark ready: denied" }, exit: "report" }`. (3) The non-workflow AC-7 to AC-10 tests (about lines 301-327) get the stub too, so they never reach a real `readPrInfo` through the spied `run`; their assertions are unchanged.
- `packages/nax/test/integration/bot/fix-report-workflow.test.ts` — "AC-10 settled items wait, post exact evidence then ready" (about line 175) expects `markReadyArgv(s.env.ref.forge, String(s.env.ref.number))`. It becomes `markReadyArgv(s.env.ref.forge, s.env.info.url)`. The order assertion is unchanged.
- `packages/nax/test/unit/bot/fix-steps.test.ts` — the in-place push case (about line 54) expects the push argv push, --no-verify, origin, HEAD:refs/heads/feat/x. It becomes push, --no-verify, --force-with-lease=refs/heads/feat/x:(env.info.headSha), origin, HEAD:refs/heads/feat/x.
- `packages/nax/test/integration/bot/gates-push-steps.test.ts` — the push case titled "pushes the explicit PR ref without force" (about line 164) expects the same old argv. It becomes the leased argv with `env.info.headSha`, and the title becomes "pushes the explicit PR ref with a lease on the reviewed head". The timeout and worktree arguments are unchanged.

### Seams

- US-001 has no cross-story seam. `TOP_LEVEL_MARKER_KEYS` and the moved `parseNaxBotMarker` are used inside the same story by the GitLab readers. Its seam AC enters at `postItemThreads` on a GitLab fixture.
- US-002 → US-004, US-005: `reopenReraisedItems` (US-004, US-005) calls `unresolveThread` (US-002). Within US-002, `reviewEnvironment` sets `resolvedThreadIds`, and the seam AC enters at `runBotReview`.
- US-003 → US-004: `reopenReraisedItems` (US-004) uses `reopenKey`, `renderItemReopened` and `REOPENED_BY_RERAISE` (US-003). The seam ACs for US-004 and US-005 enter at `postItemThreads`.
- US-004 → US-005: US-005 extends `reopenReraisedItems`, which US-004 created.
- US-004 → US-006: `reopenReraisedItems` (US-004) returns a `reopened` set. `postItemThreads` leaves those keys out of the settled count it passes to `maintainItemIndex` (US-006).
- US-007: `readReviewRulings` produces `itemStatus` and `renderReviewSummary` renders it. Its seam AC enters at `runBotReview`.
- US-008 adds no exported symbol. Its seam AC enters at the fix step graph.

## Acceptance Criteria

### US-001

- [unit] `TOP_LEVEL_MARKER_KEYS` imported from `@/forge` equals `["summary", "w-index", "w-evidence", "fix-summary"]`.
- [unit] `parseNaxBotMarker` imported from `@/forge` returns `{ key: "summary" }` for `withNaxBotMarker("body", "summary")`.
- [unit] On GitLab, `listPrComments` reads a discussion with `individual_note: false`. Its first note (author `bot`, no `position`) has body `withNaxBotMarker("s", "summary")`, and its second note is a reply by `carol`. `listPrComments` returns two comments with `kind: "comment"`: the bot's note, then carol's.
- [unit] On GitLab, `listPrComments` also flattens that discussion when the first-note marker key is `w-index`, `w-evidence` or `fix-summary`.
- [unit] On GitLab, `listPrComments` drops a system note inside a flattened discussion.
- [unit] On GitLab, `listPrComments` returns no comment for a replied discussion whose marked first note has a `position`.
- [unit] On GitLab, `listPrComments` returns no comment for a replied discussion whose first note carries the marker key `f-abc123`.
- [unit] On GitLab, `listPrComments` returns no comment for a replied discussion whose marker appears only on its second note.
- [unit] On GitLab, `listReviewThreads` leaves out the flattened `summary` discussion.
- [unit] On GitLab, `listReviewThreads` still returns a position-less discussion whose first note carries the item key `w-B1.12345678`.
- [integration] On GitLab, `postItemThreads` reads a `w-index` note owned by the bot that has a reply from `carol`. It edits that note (a `PUT` to `notes/<its id>`) and posts no new top-level note.
- [unit] `hasOpenPr` rejects with `NaxError` code `FORGE_PR_LIST_UNPARSEABLE` when the forge prints `not json`.
- [unit] `hasOpenPr` rejects with code `FORGE_PR_LIST_UNPARSEABLE` when the forge prints the JSON object `{"message":"x"}`.
- [unit] `hasOpenPr` resolves `false` when the forge prints `[]`.
- [unit] `openDraftFinishPr` returns `null` and never runs the forge's create command when the open-PR list prints `not json`.

### US-002

- [unit] `unresolveThread` (imported from `@/forge`) on a GitHub ref with thread id `T1` runs one forge API call. Its argv contains `graphql`, a `query=` argument naming `unresolveReviewThread`, and `id=T1` as a separate `-f` argument.
- [unit] `unresolveThread` on a GitLab ref with thread id `D1` runs a `PUT` to `projects/<encoded repo>/merge_requests/<n>/discussions/D1` with the argument `resolved=false`.
- [unit] `unresolveThread` on a GitLab ref with thread id `bad/id` rejects with code `FORGE_ID_INVALID` and makes no forge call.
- [unit] `unresolveThread` rejects with code `FORGE_COMMENT_WRITE_FAILED` when the forge write exits non-zero.
- [integration] `postPrReview` receives a verdict finding whose key matches an own comment in thread `T1`, with `resolvedThreadIds` containing `T1` and `settledKeys` not containing the key. It edits that comment, then unresolves thread `T1`.
- [integration] In that case `postPrReview` returns `inlineFindings: 1`.
- [integration] When the own comment's thread is not in `resolvedThreadIds`, `postPrReview` edits the comment and makes no unresolve call.
- [integration] When `resolvedThreadIds` is not given, `postPrReview` edits the comment and makes no unresolve call.
- [integration] When the key is in `settledKeys`, `postPrReview` neither edits the comment nor unresolves the thread.
- [integration] When the unresolve rejects, `postPrReview` logs `warn("bot-post", "Could not reopen a re-raised finding thread", …)` with the key and thread id.
- [integration] When the unresolve rejects, `postPrReview` returns `inlineFindings: 0`.
- [integration] When the unresolve rejects, `postPrReview` returns `offLine: 1`.
- [integration] When the edit of the owned comment rejects, `postPrReview` still rejects with that error and makes no unresolve call.
- [integration] `runBotReview` on a PR with a resolved own finding thread that has no writer ruling, and whose finding the review raises again, unresolves that thread.
- [integration] `runBotReview` makes no unresolve call when the own finding thread it raises again is unresolved.

### US-003

- [unit] `reopenKey("w-B1.12345678")` returns `"wo-w-B1.12345678"`.
- [unit] `renderItemReopened("a".repeat(40))` returns `"Raised again by the run at aaaaaaa. Reply on this thread to rule on it."`.
- [unit] `REOPENED_BY_RERAISE` has exactly two members, `fixed` and `verified`.
- [unit] `readItemThreads` reads an item thread made of the opener, a `wr-fixed-<key>` echo, and then an own comment marked `reopenKey(<key>)`. It returns that item with no `ruling`.
- [unit] In that case the item's `replies` contain only the comments after the reopen notice.
- [unit] `settleItemThreads` puts that item in `open`.

### US-004

- [integration] `postItemThreads` publishes a record with `reviewRan: true` and head `HEAD`, with a previous index whose reviewed head is `OLD`. An owned thread for a still-raised item has a `wr-fixed-<key>` echo and no later reply. It replies on that thread with a body that carries marker key `wo-<key>`.
- [integration] In that case the reply's text contains `Raised again by the run at aaaaaaa`.
- [integration] In that case `postItemThreads` unresolves that item's thread after the reply.
- [integration] `postItemThreads` reopens the same way when the echo is `wr-verified-<key>`.
- [integration] `postItemThreads` makes no reopen reply when the echo is `wr-waived-<key>`, `wr-confirmed-<key>` or `wr-overridden-<key>`.
- [integration] `postItemThreads` makes no reopen reply when the previous index's reviewed head equals the new reviewed head `HEAD`.
- [integration] `postItemThreads` reopens a `wr-fixed-<key>` item when the previous index reads `Reviewed head: none` and the record has `reviewRan: true`.
- [integration] `postItemThreads` makes no reopen reply when the record has `reviewRan: false`.
- [integration] `postItemThreads` makes no reopen reply when the record has `ciRepairRounds: 1`, because the reviewed head is carried over.
- [integration] `postItemThreads` makes no reopen reply for an owned item with a `fixed` echo whose key is not among this publish's items.
- [integration] `postItemThreads` makes no reopen reply for an item whose last own comment is already a reopen notice on an unresolved thread, even when the reviewed head changed again.
- [integration] `postItemThreads` makes no reopen reply for a `wr-fixed-<key>` item when `carol`, whom the forge reports as having write access, replied after the echo.
- [integration] `postItemThreads` reopens a `wr-fixed-<key>` item when `dave`, whom the forge reports as having no write access, replied after the echo.
- [integration] `postItemThreads` reopens a `wr-fixed-<key>` item when the write-access check for its only later reply rejects.
- [integration] When the reopen reply rejects, `postItemThreads` logs `warn("item-threads", "[item-threads] Reopen write failed", …)` with the item id.
- [integration] When the reopen reply rejects, `postItemThreads` makes no unresolve call.
- [integration] When the reopen reply rejects, `postItemThreads` returns `failed` one higher than without the reopen.
- [integration] When the unresolve rejects after a successful reply, `postItemThreads` logs the same warning.
- [integration] When the unresolve rejects after a successful reply, `postItemThreads` returns `failed` one higher.

### US-005

- [integration] When an owned thread's last own comment is its `closedKey(<key>)` notice and the key is among this publish's items, `postItemThreads` replies on it with a `wo-<key>` notice, even if the reviewed head is unchanged.
- [integration] In that closed-item case `postItemThreads` unresolves the thread after the reply.
- [integration] When the last own comment is a `wo-<key>` notice, the thread is resolved, and the key is among this publish's items, `postItemThreads` unresolves the thread and posts no second notice.
- [integration] When the reply in that closed-item case rejects, `postItemThreads` returns `failed` one higher.
- [integration] When a reopen write fails, the index that `postItemThreads` writes keeps the previous index's reviewed head `OLD` instead of `HEAD`.
- [integration] When every reopen write succeeds, the index that `postItemThreads` writes carries the new reviewed head `HEAD`.

### US-006

- [unit] `renderItemIndex({ reviewedHead: H, reviewedBase: B, keys: [k1, k2] })` returns `nax workflow items: 2 (0 settled)` followed by the reviewed head, reviewed base and key lines.
- [unit] `renderItemIndex({ keys: [k1, k2] }, 1)` returns a first line of `nax workflow items: 2 (1 settled)`.
- [unit] `parseItemIndex` of `renderItemIndex({ reviewedHead: H, reviewedBase: B, keys: [k1] }, 1)` returns `{ reviewedHead: H, reviewedBase: B, keys: [k1] }`.
- [unit] `parseItemIndex("nax workflow open items: 1\nReviewed head: none\n- w-B3.12345678")` returns `{ keys: ["w-B3.12345678"] }`.
- [unit] `parseItemIndex("nax workflow items: 1 (2 settled)\nReviewed head: none\n- w-B3.12345678")` returns `null`.
- [unit] `parseItemIndex("nax workflow items: 2 (0 settled)\nReviewed head: none\n- w-B3.12345678")` returns `null`.
- [integration] `postItemThreads` publishes two item keys. One has an owned thread with a `wr-waived-<key>` echo and no later reply. The index it writes has the first line `nax workflow items: 2 (1 settled)`.
- [integration] `postItemThreads` counts an item it reopened in the same publish as not settled.
- [integration] `postItemThreads` counts an item as not settled when a reopen of it was attempted in the same publish and the reply rejected.
- [integration] `postItemThreads` counts an item whose `wr-waived-<key>` echo has a later reply from `carol` as not settled.
- [unit] `recordPrRulings` records one ruling for a one-key index whose body reads `(0 settled)`. It calls `_rulingsDeps.editComment` on the index comment with `withNaxBotMarker(renderItemIndex(<that index>, 1), "w-index")`.
- [unit] `recordPrRulings` makes no `editComment` call when the settled count matches the index body.
- [unit] `recordPrRulings` makes no `editComment` call when there is no own `w-index` comment.
- [unit] `recordPrRulings` counts only settled items whose key is listed in the index.
- [unit] When `editComment` rejects, `recordPrRulings` logs `warn("bot-rulings", "[bot-rulings] Could not refresh the item index", …)`.
- [unit] When `editComment` rejects, `recordPrRulings` still returns its settled items.

### US-007

- [unit] For an outcome with one recorded `verified` ruling on `_run:cv1` by `alice`, one settled item and a one-key index, `readReviewRulings` returns `itemStatus` `{ recorded: [{ id: "_run:cv1", disposition: "verified", by: "alice" }], open: 0, total: 1 }`.
- [unit] `readReviewRulings` returns no `itemStatus` when the recorder outcome has no `index`.
- [unit] `renderReviewSummary` with `itemStatus.recorded` of `_run:cv1` verified by `alice` and `_run:cv2` waived by `bob` contains the line `Item rulings recorded: 2 (_run:cv1 verified by @alice, _run:cv2 waived by @bob).`.
- [unit] `renderReviewSummary` renders a recorded ruling with `by: null` as `<id> <disposition> by nax bot`.
- [unit] `renderReviewSummary` with 23 recorded rulings lists the first 20 and ends that line with `and 3 more).`.
- [unit] `renderReviewSummary` with `itemStatus` `{ recorded: [], open: 1, total: 2 }` contains the line `Open items: 1 of 2.`.
- [unit] In that case `renderReviewSummary` has no line starting with `Item rulings recorded`.
- [unit] `renderReviewSummary` without `itemStatus` contains neither line.
- [integration] `runBotReview` on a workflow PR, where the recorder outcome has one recorded `verified` ruling by `alice` for a one-key index, posts a summary containing `Item rulings recorded: 1 (`.
- [integration] In that case the posted summary contains `Open items: 0 of 1.`.
- [unit] `buildWorkflowPrBody` for a draft with one open item and feature `demo` ends its "Before marking ready" section with the line ``Then: rule on each item by replying on its thread, and run `nax workflow promote -f demo --yes` to mark the PR ready once every item is settled and CI is green.``

### US-008

- [integration] On the non-workflow path, with green CI and a re-read head equal to `state.pushedSha`, `readyStep` runs `markReadyArgv(env.ref.forge, env.info.url)`.
- [integration] On the workflow path, when every hold passes, `readyStep` runs `markReadyArgv(env.ref.forge, env.info.url)`.
- [integration] On the non-workflow path with green CI, `readyStep` re-reads the PR through `_fixReportDeps.readPrInfo` after the CI wait.
- [integration] On the non-workflow path, when an abort fires as CI turns green, `readyStep` rejects with `AbortError` without calling `_fixReportDeps.readPrInfo`.
- [integration] On the non-workflow path, when the re-read returns another head sha, `readyStep` returns `{ patch: { markedReady: false, readyHeld: "PR head changed since this execution" }, exit: "report" }`.
- [integration] In that case `readyStep` runs no ready command.
- [integration] On the non-workflow path, when the re-read rejects, `readyStep` returns `readyHeld: "PR head could not be re-read"`.
- [integration] In that case `readyStep` runs no ready command.
- [integration] When the ready command exits 1 with stderr `denied\n`, `readyStep` returns `{ patch: { markedReady: false, readyHeld: "could not mark ready: denied" }, exit: "report" }`.
- [integration] When the ready command exits 2 with empty stderr, `readyStep` returns `readyHeld: "could not mark ready: exit code 2"`.
- [integration] When the fix step graph reaches a ready command that exits 1, it still runs `reportStep`, and the posted fix summary contains `Kept as draft: could not mark ready`.
- [unit] For head ref `feat/x`, `pushStep` pushes with argv `["push", "--no-verify", "--force-with-lease=refs/heads/feat/x:<env.info.headSha>", "origin", "HEAD:refs/heads/feat/x"]`.
- [unit] On an in-place checkout, `pushStep` pushes with the same leased argv.
- [unit] When the leased push exits 1 with stderr `stale info`, `pushStep` returns outcome `push-rejected`.
