# SPEC: Workflow PR rulings and the review split

Closes: #2629

## Summary

A nax workflow draft PR lists what is still open (flagged rulings, advisor holds, cannot-verify items, red
gates, unfinished stories) in its body, and only a local `nax workflow record` + `nax workflow promote` can
settle them. This spec moves those rulings onto the PR. Publish opens one nax bot thread per open item and keeps
one nax bot index comment listing the items; a collaborator rules by replying on an item's thread (a keyword such
as `waive: <reason>` is read directly, any other reply is read by one fast-tier model call); `nax bot review` and
`nax bot fix` record each ruling with a reply in the same thread; and `nax bot fix` marks a workflow draft ready
once every item is ruled and CI is green on the head (as today, `nax bot fix` needs a `nax bot review` of the same
head first). `nax workflow promote` counts the same PR rulings. Alongside it, the two review engines share one
checklist module: `nax bot review` gains the nine code-quality classes, the walk-every-function instruction and
the read-every-changed-file retry the branch review has, and both prompts gain one shared design-decisions item.
On a nax workflow PR whose branch review covered the published head, `nax bot review` reviews only the commits
pushed after it. The post-approval ledger push (nax#2629) is dropped, so an approved workflow PR runs CI once and
is never promoted while its head's CI is pending.

## Motivation

Verified on `main` @ `a0751f2f2` (v0.91.1, 2026-10-21):

- Of 90 workflow `result.json` files across real projects, 40 PRs ended draft; 9 for flagged rulings and 7 for
  an advisor hold. Those rulings live in a git-ignored sidecar (`src/workflow/decisions-sidecar.ts`) next to the
  run, so a fresh checkout (a `nax bot` checkout, a koda job) cannot see them, and nobody can rule from the PR.
- `nax bot fix`'s `readyStep` (`src/bot/fix-report.ts`) keeps every nax workflow draft a draft
  (`WORKFLOW_PR_HOLD`), on purpose until this phase (SPEC-workflow-ci-repair-readiness, Out of Scope).
- The two review engines drift: `buildWorkflowBranchReviewPrompt` embeds `WORKFLOW_QUALITY_CHECKLIST` and
  `WORKFLOW_ENUMERATION_INSTRUCTION` (`src/prompts/builders/workflow-quality-checklist.ts`) and its op retries
  when `inspectedFiles` misses a changed file (`workflowBranchReviewOp`); `buildBotPrReviewPrompt` has its own
  six-item `CHECKLIST` with neither, and no coverage retry. The bot checklist's design-decisions item has no
  branch-review equivalent.
- `nax bot review` on a nax workflow PR reviews `mergeBase..HEAD` again, although the branch review inside
  `nax run` already reviewed the branch up to publish.
- nax#2629: `prMode` (`src/workflow/finalize.ts`) commits and pushes the advisor's `finish-approval` ledger line
  after the CI wait (`pushLedger`), which starts a second full CI run and leaves the promoted PR's head pending.

User rulings 2026-10-21 (workspace master plan `nax-step-graph-and-bot-master-plan.md` §B4 "Part 3 rulings"):
collaborators with write access may settle any item; nax bot may settle an item only as `fixed` with a sha;
everyone else is conversation, never a ruling. Reply format is hybrid: keyword fast path, model read otherwise,
fail closed, the bot echoes what it recorded. Both engines stay separate (no merged engine). One spec, one PR.

## Design

### Approach

One capability, three layers:

1. **Item threads (workflow side).** After every `pr`-mode publish that returns a PR URL (draft or ready), the
   feature graph's `publish` step calls a new optional step `steps.postItemThreads` through a small new module,
   so `feature-steps.ts` grows by about two lines. It opens one nax bot thread per open item
   (`buildOpenItems` of the record, minus the `ci` item), writes or edits one nax bot index comment (current item
   keys plus the reviewed head), and closes earlier item threads whose key is no longer in the index. The step is
   optional on `FeatureSteps` (like `readCiFailures`), so the G0 equivalence goldens, which do not supply it, are
   unchanged.
2. **Rulings (bot side).** A new `recordPrRulings` reads the index and the item threads, decides which items are
   settled, reads the newest collaborator reply on each open item (keyword parser first, then one batched model
   call), and records each ruling as an echo reply plus a body checklist tick. `nax bot review` and `nax bot fix`
   both call it before their agent step on a trusted PR that carries the workflow marker. `nax bot fix`'s ready
   step then applies the workflow rule: every indexed item settled, and CI green on the head.
3. **Review split.** The shared checklist module gains the design-decisions item; the bot prompt embeds it plus
   the quality checklist and the enumeration instruction; the branch prompt embeds it. The bot review op gains
   the coverage retry. On a trusted marked PR whose index names a reviewed head that is an ancestor of the PR
   head, the bot review range starts at that head; when the PR head equals it, the review covers the
   conversation only.

"Own" comment everywhere in this spec has `ownComments` semantics (`src/forge/marker.ts`): authored by the
current forge login AND carrying a valid `nax-bot:v1` marker. A human reply posted under the same login as nax
bot (today's default: nax posts as the user's own `gh`/`glab` login) has no marker, so it is not own, and it is a
reply like any other.

### Formats

All keys go through `withNaxBotMarker` / `parseNaxBotMarker` (`src/forge/marker.ts`), key grammar
`[A-Za-z0-9._:-]{1,128}`.

- **Item key:** `w-<itemId>.<h8>`, where `<h8>` is the first 8 hex characters of SHA-256 over
  `<kind>\n<issue>` of the `OpenItem`. Positional ids such as `_run:cv1` therefore get a new key when their
  text changes.
- **Postable item:** its id matches `[A-Za-z0-9._:-]+` and the longest derived key,
  `wq-<itemKey>-` followed by 20 characters, is at most 128 characters. An item that is not postable is skipped
  (logged); its key is still written to the index, so readiness holds the PR (fail closed).
- **Item thread opener** (body passed to `withNaxBotMarker` with the item key): first line
  `Open item **<itemId>** (<kind>): <issue>`, `<issue>` through `safeInline`; then `Suggestion: <suggestion>`
  when the item has one and `Advisor: <action> — <why>` when it has a ruling (both through `safeInline`); then
  the line
  `Rule on it by replying: fixed <sha>, waive: <reason>, confirm, override: <reason>, or verified. Any other reply from a collaborator is read as a ruling only when its meaning is clear.`
- **Ruling echo key:** `wr-<disposition>-<itemKey>`, `<disposition>` one of the sidecar `DISPOSITIONS`
  (`fixed`, `waived`, `confirmed`, `overridden`, `verified`), none of which contains `-`.
- **Ruling echo body:** first line `Recorded: <disposition> — <reason>` (or `Recorded: fixed in <sha7> — <reason>`),
  reason through `safeInline`; second line `By @<login>`, or `By nax bot` for a bot ruling; third line
  `To change it, reply on this thread.`
- **Ask key:** `wq-<itemKey>-<replyId>`; body
  `I could not read a ruling from that reply. Start a reply with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified.`
- **Closed key:** `wc-<itemKey>`; body `No longer open in the run at <sha7>.` (not a ruling).
- **Index comment:** a top-level PR comment with key `w-index`; body lines
  `nax workflow open items: <n>`, `Reviewed head: <40-hex sha>` or `Reviewed head: none`,
  `Reviewed base: <40-hex sha>` (the run's seed; written only with a reviewed head), then one line per item key
  in `buildOpenItems` order, each `- <itemKey>`.
- **Evidence comment:** `evidenceComment(entries)` wrapped with key `w-evidence`; edited in place when it exists.

Keyword grammar (`parseRulingKeyword`), applied to the reply's first non-empty line after trimming, case-
insensitive on the keyword:

| First line | Ruling |
|---|---|
| `fixed <sha>` (`<sha>` 7-40 hex), optional ` — <reason>`, ` - <reason>` or `: <reason>` | `fixed`, sha, reason (default `fixed`) |
| `waive: <reason>` / `waived: <reason>` | `waived`, reason (non-empty required) |
| `confirm` / `confirmed`, optional `: <reason>` | `confirmed`, reason (default `confirmed`) |
| `override: <reason>` / `overridden: <reason>` | `overridden`, reason (non-empty required) |
| `verified` / `verify`, optional `: <reason>` | `verified`, reason (default `verified`) |
| anything else, or `waive`/`override` with an empty reason | not a keyword ruling (`null`) |

### Integration

Read-only symbols (verified on `a0751f2f2`):

- `buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[]` — `src/workflow/open-items.ts`.
- `OpenItem` (`id`, `kind`, `severity?`, `file?`, `line?`, `issue`, `suggestion?`, `ruling?`) — `src/workflow/types.ts`.
- `DISPOSITIONS`, `Disposition`, `DecisionEntry`, `mergeDecisions` — `src/workflow/decisions-sidecar.ts`. The sidecar kind of an item is its `kind`, except `ruling`, which maps to `advisor` (the mapping `sidecarKindFor` applies to an `OpenItem`).
- `openItemLine(item, chars?)` — `src/workflow/pr-body.ts`; `safeInline` — `src/workflow/pr-body-safe.ts`.
- `tickChecklist(body, entries)`, `evidenceComment(entries)`, `editBodyArgv`, `markReadyArgv` — `src/workflow/promote.ts`.
- `withNaxBotMarker`, `parseNaxBotMarker`, `ownComments`, `hasNaxWorkflowMarker` — `src/forge/marker.ts`.
- `postInlineComment(ref, { path, line, body, headSha, diffRefs? }, deps, cwd)`, `replyToThread`, `resolveThread`, `editComment`, `postPrComment` — `src/forge/comments.ts`.
- `listReviewThreads` (GitHub review threads; GitLab discussions with `individual_note === false`), `listPrComments` — `src/forge/threads.ts`; `readCurrentUser` — `src/forge/trust.ts`.
- `prNumberFromUrl`, `resolvePrRef`, `readPrInfo` (gives `headSha`, `diffRefs`) — `@/forge`.
- `ciAllowsReady`, `waitForChecks` — `src/workflow/ci-wait.ts`.
- `unreadFiles` — `src/operations/workflow-review-coverage.ts`; `buildWorkflowBranchCoverageRetry(range, missing)` — `@/prompts`.
- `reviewRequiredFiles(paths, fc)` — `src/workflow/review-coverage.ts` (takes `config`, `projectDir`, `packageDirs`, which `PrStepContext` has).
- `writeBranchReviewPackage(projectDir, base, packagePath, opts?)` returns the changed paths — `src/workflow/git.ts`.
- `botChecksExtractOp` — the precedent for a fast-tier `complete` op that parses with `tryParseLLMJson` (`src/operations/bot-checks-extract.ts`).
- `FeatureSteps.changedFiles(base)` and `readHeadSoft(env)` — `src/workflow/feature-machine.ts`, `src/workflow/feature-steps.ts`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `PrComment` (`src/forge/pr-types.ts`). Baseline: `{ id, kind, author, body, createdAt }`. Target: adds
  `readonly authorId?: number`, set from the GitLab note's `author.id` (`GitlabDiscussion.notes[].author` gains
  `id: number`) and left unset on GitHub.
- `hasWriteAccess` (`src/forge/trust.ts`, private). Baseline: `(ref, info: PrInfo, deps, cwd)`. Target: an
  exported `hasWriteAccess(ref, who: { login: string; id?: number }, deps, cwd): Promise<boolean>` in a new
  `src/forge/access.ts`; the private helpers `readError`, `parseReply` and `api` move to a new leaf
  `src/forge/api-reply.ts` that both `trust.ts` and `access.ts` import (no cycle); `classifyPrTrust` calls
  `hasWriteAccess(ref, info.author, ...)`, behaviour unchanged.
- `src/forge/comments.ts`. Target: adds `postItemComment(ref, { path, body, headSha }, deps, cwd): Promise<PostedComment>`:
  on GitHub a file-level review comment (`subject_type=file`, `path`, `commit_id`, no line); on GitLab a
  discussion with no position (a resolvable general thread). Exported from `@/forge`.
- `FeatureSteps` (`src/workflow/feature-machine.ts`). Target: adds optional
  `postItemThreads?: (input: ItemThreadsInput) => Promise<ItemThreadsOutcome>`.
- `publishStep` (`src/workflow/feature-steps.ts`). Target: after `env.steps.publish(rec)` and `readHeadSoft`, one
  call to `postItemThreadsAfterPublish(env, rec, out, head)` from the new `src/workflow/publish-item-threads.ts`;
  the returned patch is unchanged.
- `prMode` (`src/workflow/finalize.ts`). Baseline: calls `pushLedger(fc)` after an approval. Target: no
  post-approval ledger commit or push; `pushLedger` is deleted.
- `readyStep` (`src/bot/fix-report.ts`). Baseline: returns `readyHeld: WORKFLOW_PR_HOLD` for a marked PR.
  Target: a marked PR is decided by `workflowPrReadiness` (below); `WORKFLOW_PR_HOLD` is deleted.
- `resolveOwnFindings` (`src/bot/fix-report.ts`). Target: skips agreed items whose key starts with `w-` (nax bot
  fix never settles an item; the next review does).
- `effectiveEarlier`, `postEarlier`, `warnSkippedEarlier` (`src/bot/post.ts`). Baseline: only `f-` keys.
  Target: also own threads whose opener key starts with `w-`; for those, verdict `fixed` posts a bot ruling echo
  (`wr-fixed-<itemKey>`, sha = `info.headSha`, the PR head this review read) and resolves the thread, verdict
  `withdrawn` posts the plain earlier reply and does not resolve, verdict `open` is merged into the agreed items
  as today with the opener's first line as the issue (the reply instruction is not passed to the fix agent).
  `withdrawalEvents` stays `f-` only.
- `PostReviewInput` (`src/bot/post.ts`). Target: adds optional `itemEarlier?: readonly PrThread[]` (open item
  threads of kind `finding` or `ruling`), which `postPrReview` treats as part of `earlier` under the rules above;
  `rulings?: { recorded: number; open: number; asked: number }`, written into `bot-review.json`; and
  `unreadFiles?: readonly string[]`, rendered by the summary as `Not read by the review: <paths>`.
- `PrReviewInput.earlier` (`src/bot/review-step.ts`). Target: `runBotReview` passes the own `f-` threads first,
  then `itemEarlier`; `MAX_EARLIER_THREADS` (50) caps the combined list, and the op's `earlierIds` are the ids of
  the capped list. Each item thread in it carries only the opener, own comments and the replies whose author has
  write access (the `kept` replies), so a non-writer cannot steer a bot `fixed` ruling.
- `buildBotPrReviewPrompt` (`src/prompts/builders/bot-pr-review-builder.ts`). Target: `CHECKLIST` item 6 is
  `WORKFLOW_DESIGN_DECISIONS_ITEM` followed by the bot-only sentence `If project decisions are listed below, check the change against them too.`;
  the checklist section is followed by `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION`
  except when `conversationOnly` is true; `BotPrReviewPromptInput` gains optional `conversationOnly?: boolean`.
- `buildWorkflowBranchReviewPrompt`. Target: its remit list gains `WORKFLOW_DESIGN_DECISIONS_ITEM` as a bullet.
- `BotPrReviewInput` (`src/operations/bot-pr-review.ts`). Target: adds optional `requiredFiles?: readonly string[]`,
  `repoRoot?: string`, `range?: string`; when `requiredFiles` is non-empty, the retry `validate` also requires
  `unreadFiles(requiredFiles, verdict.inspectedFiles, repoRoot)` to be empty, and `invalid` returns
  `buildWorkflowBranchCoverageRetry(range, missing)` when triage is complete but files are missing.
- `PrReviewInput` (`src/bot/review-step.ts`). Target: adds optional `rangeBase?: string` (default `mergeBase`) and
  `conversationOnly?: boolean`; `runPrReview` passes `requiredFiles` only when non-empty, and its result carries
  `unreadFiles` = `unreadFiles(requiredFiles, verdict.inspectedFiles, repoRoot)` when non-empty, which
  `runBotReview` passes to `postPrReview`.
- `_botReviewDeps` (`src/bot/review-run.ts`). Target: adds `isAncestor(dir, ancestor, head): Promise<boolean>`
  (`git merge-base --is-ancestor`, true on exit 0, false on exit 1, throws otherwise) and `recordPrRulings`.
- `_fixReportDeps` (`src/bot/fix-report.ts`). Target: adds `readPrInfo`, `readCurrentUser`, `listReviewThreads`,
  `listPrComments` and `recordPrRulings`, which `readyStep` uses to re-read the PR before deciding.
- `BotConfig.models` (`src/config/schemas-bot.ts`). Target: adds `rulings: ConfiguredModelSchema.optional()`;
  `botModel` role union gains `"rulings"`, handled by its own branch that resolves
  `override ?? config.bot?.models.rulings ?? "fast"` (no workflow or finish fallback).
- `items-ruled` check (`src/cli/workflow-promote.ts`). Target: an open item is ruled when the sidecar has an entry
  for it or a settled item thread rules it (matched by item key, so the text hash must match the item now); a
  sidecar entry wins for the same id; the tick and comment actions use the merged entries. `_run:ci` keeps
  today's rule (it needs a sidecar entry; promote's own CI check is separate). A failure to read the PR threads
  is logged as a warning and reported in a new report field `prRulings: { read: false, error }` (`{ read: true,
  count }` otherwise); `checks[].detail` texts are unchanged.

New modules:

- `src/forge/api-reply.ts`, `src/forge/access.ts` — above.
- `src/workflow/item-threads.ts` (pure formats; imports only `node:crypto`, `./pr-body-safe`, `@/forge` and
  types, never `./pr-body`, which reaches `@/finish` and from there `@/cli`) — `itemKey(item)`, `isPostable(item)`, `renderItemOpener(item)`,
  `parseItemOpener(body)`, `parseRulingKeyword(text)`, `renderRulingEcho(ruling)`, `parseRulingEcho(key, body)`,
  `askKey(itemKey, replyId)`, `renderRulingAsk()`, `renderItemIndex(index)`, `parseItemIndex(body)`.
- `src/workflow/ruling-keyword.ts` (pure) — `parseRulingKeyword(text)`.
- `src/workflow/item-thread-state.ts` — `readItemThreads(threads, comments, login)`, `settleItemThreads(read, canRule)`.
- `src/workflow/item-threads-post.ts` — `postItemThreads(input, deps)`.
- `src/workflow/publish-item-threads.ts` — `postItemThreadsAfterPublish(env, rec, out, head)`.
- `src/prompts/builders/bot-ruling-builder.ts` — `buildBotRulingReadPrompt(input)`.
- `src/operations/bot-ruling-read.ts` — `botRulingReadOp`, with its own types (no import from `src/workflow`).
- `src/bot/rulings.ts` — `recordPrRulings(input)`.
- `src/bot/workflow-ready.ts` — `workflowPrReadiness(input)`.

Types (worked skeletons):

```typescript
// src/workflow/item-threads.ts
export interface PrRuling {
  readonly itemKey: string;
  readonly itemId: string;
  readonly disposition: Disposition;
  readonly reason: string;            // one line, non-empty
  readonly sha?: string;              // required when disposition is "fixed"
  readonly by: string | null;         // login; null = nax bot
}
export interface ItemIndex { readonly reviewedHead?: string; readonly reviewedBase?: string; readonly keys: readonly string[] }

// src/workflow/item-thread-state.ts
export interface ItemThread {
  readonly key: string; readonly itemId: string; readonly kind: string; readonly thread: PrThread;
  readonly ruling?: PrRuling;               // from the last own echo, if any
  readonly replies: readonly PrComment[];   // comments after the last own comment that are not own
}
export interface ReadItemThreads {
  readonly index?: ItemIndex;               // from the own `w-index` comment
  readonly indexComment?: PrComment;
  readonly items: readonly ItemThread[];    // own threads whose opener key starts with "w-"
}
export interface SettledItems {
  readonly settled: readonly (ItemThread & { readonly ruling: PrRuling })[];
  readonly open: readonly (ItemThread & { readonly kept: readonly PrComment[] })[];
}
/** canRule = write access of a reply's author. settled = has a ruling and no kept reply after it. */
export function settleItemThreads(read: ReadItemThreads, canRule: (c: PrComment) => Promise<boolean>): Promise<SettledItems>;

// src/workflow/item-threads-post.ts
export interface ItemThreadsInput {
  readonly record: WorkflowFeatureRecord; readonly url: string; readonly head?: string;
  readonly projectDir: string; readonly feature: string;
  readonly changedFiles: readonly string[];  // repo-relative, seed..head
}
export interface ItemThreadsOutcome { readonly posted: number; readonly closed: number; readonly skipped: number; readonly failed: number }

// src/operations/bot-ruling-read.ts
export type RulingDisposition = "fixed" | "waived" | "confirmed" | "overridden" | "verified" | "none";
export interface BotRulingReadInput {
  readonly items: readonly { readonly id: string; readonly kind: string; readonly issue: string;
    readonly reply: { readonly id: string; readonly author: string; readonly body: string } }[];
  readonly model?: ConfiguredModel;
}
export interface BotRulingReadVerdict {
  readonly rulings: readonly { readonly id: string; readonly disposition: RulingDisposition;
    readonly reason: string; readonly quote: string; readonly sha?: string }[];
}

// src/bot/rulings.ts
export interface RecordRulingsInput {
  readonly ref: PrRef; readonly info: PrInfo; readonly login: string;
  readonly threads: readonly PrThread[]; readonly comments: readonly PrComment[];
  readonly deps: ForgeDeps; readonly cwd: string;
  readonly readModel: (input: BotRulingReadInput) => Promise<BotRulingReadVerdict | null>;
}
export interface RecordRulingsOutcome {
  readonly index?: ItemIndex;
  readonly recorded: readonly PrRuling[];
  readonly settled: SettledItems["settled"];
  readonly open: SettledItems["open"];
  readonly asked: number;
  readonly failed: number;
}
```

### Item threads at publish

`postItemThreadsAfterPublish(env, rec, out, head)` calls `env.steps.postItemThreads` when it is defined,
`out.url` is set and `out.outcome` is `draft` or `ready`, with the record patched by this publish (outcome, ci,
ciDetail, reasons, approval, storyStates), `head`, and `changedFiles` from `env.steps.changedFiles(rec.seed)`
(empty when the seed is empty or the call throws). A throw from the step is logged and swallowed.

`postItemThreads(input, deps)` (deps default `_featureDeps.forge`) in order:

1. `prNumberFromUrl(url)`, `resolvePrRef`, `readPrInfo`, `readCurrentUser`, `listReviewThreads`, `listPrComments`,
   then `readItemThreads`.
2. `items = buildOpenItems(record)` minus kind `ci`.
3. Each postable item with no own thread for its key is posted, in item order:
   - with `file` and `line`: `postInlineComment` at that location with `info.headSha` and `info.diffRefs`;
     on failure, `postItemComment` on `file`; on a second failure, `postItemComment` on the anchor path;
   - otherwise: `postItemComment` on the anchor path, which is `.nax/features/<feature>/prd.json` when that
     repo-relative path is in `changedFiles`, else the first entry of `changedFiles`; with no changed files on
     GitHub the item is counted in `failed` (GitLab needs no path).
4. The index comment is written: `renderItemIndex({ keys: every item's key, reviewedHead })`, edited in place
   when an own `w-index` comment exists, posted otherwise. `reviewedHead` is `head` when
   `record.reviewRan === true` and none of `reviewUnread`, `costLimited`, `reReviewSkipped`,
   `gateRepairRounds > 0`, `ciRepairRounds > 0` holds; when only `ciRepairRounds > 0` fails the test, the existing
   index's reviewed head (and base) is kept; otherwise `none`. `Reviewed base` is `record.seed`.
5. Each own item thread whose key is not in the new index and has no own `wc-` reply gets the closed reply and is
   resolved. This is not a ruling.
6. Every forge call is wrapped: a failure is logged with the item id, counted in `failed`, and the loop
   continues. A failure in step 1 posts nothing and returns `failed: 1`.

### Recording rulings

`recordPrRulings(input)` order:

1. `read = readItemThreads(threads, comments, login)`; `canRule(c)` = `hasWriteAccess(ref, { login: c.author,
   id: c.authorId }, deps, cwd)`, memoised per login; a throw counts as no access and is logged.
2. `{ settled, open } = settleItemThreads(read, canRule)`. Only threads whose key is in the index are considered;
   a thread outside the index is ignored.
3. For each open item with kept replies, only the newest kept reply is read: `parseRulingKeyword(body)`; a
   ruling is that item's candidate (`by` = the reply's author).
4. Open items whose newest kept reply has no keyword go to one `readModel` call, at most `MAX_RULING_ITEMS = 20`
   per call in index order (the rest stay open this call). A model ruling is accepted only when its disposition is
   not `none`, its `quote` occurs verbatim (whitespace collapsed) in that reply, its reason is one non-empty line,
   and a `fixed` ruling's sha occurs in that reply. Otherwise the item stays open and an ask is posted in the
   thread, unless an own comment with that ask key exists. When `readModel` returns null or throws, no model
   ruling is accepted and no ask is posted.
5. Each candidate ruling: `replyToThread` with the echo, then `resolveThread`. A settled item whose thread is
   unresolved gets `resolveThread` again (no new echo).
6. The PR body is re-read with `readPrInfo` and ticked with `tickChecklist` of one `DecisionEntry` per settled
   item whose id is on a checklist line (kind mapped as in Integration, `sha` for `fixed`), written with
   `editBodyArgv` only when it changed.

`recordPrRulings` never creates a bot ruling; only `postEarlier` does (verdict `fixed`).

### Bot review and bot fix

- `runBotReview` and `runBotFix`, on a trusted PR whose body has `NAX_WORKFLOW_PR_MARKER`, call `recordPrRulings`
  after the checkout and before the agent step, with `readModel` calling `botRulingReadOp` with
  `botModel(config, "rulings")`. A throw is logged and the command continues; its outcome is then absent.
- `runBotReview` passes the outcome's open items of kind `finding` or `ruling` as `itemEarlier`, resolved or not.
  `bot-review.json` gains `rulings: { recorded, open, asked }` counts (version stays 2).
- `workflowPrReadiness({ outcome, ci })` returns `{ ready: true }` or `{ ready: false, reason }`, in this order:
  no outcome (`rulings could not be read`); no index (`no nax item index on this PR`); an index key with no
  thread (`<n> item(s) without a thread: <ids>`); any open item (`<n> open item(s): <ids>`); CI not
  `ciAllowsReady` (`CI <outcome>: <detail>`).
- `readyStep` on a marked draft: `recordPrRulings` on freshly read threads and comments; the three item checks
  of `workflowPrReadiness` first, and `waitForChecks` only when they pass; ready: the evidence comment for the
  settled entries (skipped when there are none), then `markReadyArgv`.

### Incremental bot review

In `runBotReview`, when the PR is trusted, its body has the workflow marker, the outcome's index names a reviewed
head and base, `isAncestor(checkout, reviewedHead, prHead)` is true, and `isAncestor(checkout, reviewedBase,
mergeBase)` is true (the branch review covered every commit after the merge base):

- PR head equals the reviewed head: `conversationOnly: true`; the prompt says the code at this head was reviewed
  by the workflow's branch review and findings may come only from what a thread, comment or earlier finding points
  at, and names no range or package; no package is written; `requiredFiles` is empty.
- otherwise: `rangeBase = reviewedHead`; package and range are `<reviewedHead>..HEAD`.

Any other case, including `Reviewed head: none` and an `isAncestor` throw, keeps today's full review from
`mergeBase`.
`requiredFiles` for every non-conversation review is `reviewRequiredFiles` over the package's changed paths.

### Failure Handling

| Failure | Behaviour |
|---|---|
| `postItemThreads` step 1 fails | warning logged, nothing posted, publish outcome unchanged; with no index, bot readiness fails closed |
| An item is not postable | logged, counted in `skipped`, its key still in the index |
| Inline post fails | `postItemComment` on the item's file, then on the anchor path; a third failure is counted in `failed` |
| No anchor path on GitHub | counted in `failed`, key still in the index |
| `hasWriteAccess` throws for a replier | treated as no write access, logged |
| `readModel` returns null or throws | no model rulings; keyword rulings still recorded; no ask |
| Model ruling fails validation | no ruling; ask posted once per reply |
| Echo reply fails | ruling not recorded (item open), counted in `failed` |
| `resolveThread` fails after an echo | logged; the item is settled; resolved again next call |
| Body edit fails | logged; readiness does not read ticks |
| `recordPrRulings` throws in review or fix | logged; the command continues; `readyStep` holds with `rulings could not be read` |
| Evidence comment fails | not marked ready; `readyHeld` = `evidence comment failed: <detail>` |
| Reviewed head missing or `none`, not an ancestor, or `isAncestor` throws | full review from `mergeBase` |
| Promote cannot read the PR threads | warning logged, `prRulings.read` false, sidecar entries only |
| Coverage retry still misses files | verdict kept; summary lists the unread files |

## Out of Scope

- `nax bot fix` does not repair CI and does not run the advisor; an advisor hold is cleared only by a collaborator reply.
- `nax bot fix` still requires a `nax bot review` of the same head (its existing precondition); readying a workflow draft is `nax bot review` then `nax bot fix`.
- `nax bot fix` does not rule `fixed` on gate items when its gates pass; a red-gate item is settled by a collaborator reply or by the next workflow publish.
- A nax bot ruling other than `fixed` is never created by any path.
- Replies from authors without write access (including a PR author without it and other bots) are never rulings, never reopen an item, and are not answered on item threads; on other threads and top-level comments the bot review answers them as today.
- Untrusted PRs (fork, author without write access) get no ruling reading and no incremental review; they keep today's static full review.
- Workflow PRs published before this change have no index comment, so `nax bot fix` holds them with `no nax item index on this PR`; they stay `nax workflow promote`'s job.
- `nax workflow record` stays local; it does not post to the PR.
- The `finish-approval` ledger line is no longer pushed after approval; it stays in the working tree until a later run's ledger commit, so the branch of an approved PR lacks that one line.
- Removing the workflow marker from a PR body puts the PR back on the plain "CI green" ready path, as before this change; only collaborators can edit the body of a trusted PR.
- Resolving an item thread without replying does not rule.
- More than 20 model-read items in one call: the rest stay open until the next bot run.
- A retried `readyStep` edits the existing evidence comment; it never posts a second one.
- The `.nax/rules/retry-strategy.md` ruled exception must be extended to say the bot review ops' `validate` also requires coverage of the required files; this is a manual edit in the same commit as US-015 (`.nax/` is read-only to the run).
- Documentation (`docs/guides/workflow-mode.md`, `docs/guides/bot.md`) is a manual follow-up after merge.
- Merging the branch review and the PR review into one engine is not done (user ruling 2026-10-21).
- The nax-finish skill is changed in B4 part 4, not here.


## Stories

Sixteen stories, one capability: a workflow draft whose open items are ruled on the PR and promoted by
`nax bot fix`, and a bot review that applies the branch review's checks and skips what the branch review already
did. It is past the 8-story size check and was confirmed as one capability by the user 2026-10-21 (one spec, one
PR); the split keeps Context Files at 5 or fewer and every story under the 24-AC cap counted by assertion.
Every story runs in `packages/nax`.

### US-001: Forge: commenter access, comment author id, item comments
No dependencies. Workdir: packages/nax.

Adds `src/forge/api-reply.ts` (moved helpers) and `src/forge/access.ts` (`hasWriteAccess`), rewires
`classifyPrTrust`, adds `PrComment.authorId` from GitLab note authors, and adds `postItemComment` to
`src/forge/comments.ts`; exports the new functions from `@/forge`.

### US-002: Item thread formats
No dependencies. Workdir: packages/nax.

Adds the pure module `src/workflow/item-threads.ts`: item keys, postability, opener, echo, ask, closed and index
formats from Design "Formats". It does not import `./pr-body`.

### US-003: Ruling keyword grammar
No dependencies. Workdir: packages/nax.

Adds the pure module `src/workflow/ruling-keyword.ts` with `parseRulingKeyword`, implementing the keyword table.

### US-004: Item thread state
Depends on US-002. Workdir: packages/nax.

Adds `src/workflow/item-thread-state.ts` with `readItemThreads` and `settleItemThreads`.

### US-005: Post item threads
Depends on US-001, US-002, US-004. Workdir: packages/nax.

Adds `src/workflow/item-threads-post.ts` with `postItemThreads` steps 1-3 and 6 of Design "Item threads at
publish": reading the PR, choosing the items, and posting each one with its fallbacks.

### US-006: Item index, closing, and the publish wiring
Depends on US-005. Workdir: packages/nax.

Adds steps 4-5 (index comment and closing) to `postItemThreads`, `src/workflow/publish-item-threads.ts`
(`postItemThreadsAfterPublish`), the optional `FeatureSteps.postItemThreads`, the one call in `publishStep`, and
the wiring in `buildFeatureEnv`.

### US-007: One CI run for an approved workflow PR
No dependencies. Workdir: packages/nax.

Deletes `pushLedger` and its call in `prMode` (nax#2629).

### US-008: Model ruling read
No dependencies. Workdir: packages/nax.

Adds `bot.models.rulings` (with its `src/cli/config-descriptions.ts` entry), the `"rulings"` branch in
`botModel`, `buildBotRulingReadPrompt`, and `botRulingReadOp` with its reply parser and types.

### US-009: Record keyword rulings
Depends on US-001, US-003, US-004. Workdir: packages/nax.

Adds `src/bot/rulings.ts` with `recordPrRulings` steps 1-3, 5 and 6 of Design "Recording rulings": access,
keyword rulings, echo, resolve and body ticks. The `readModel` input is accepted but not yet called.

### US-010: Record model-read rulings
Depends on US-008, US-009. Workdir: packages/nax.

Adds step 4 of Design "Recording rulings" to `recordPrRulings`: the batched `readModel` call, its validation, and
the ask comments.

### US-011: Bot review records rulings and re-checks item findings
Depends on US-010. Workdir: packages/nax.

`runBotReview` calls `recordPrRulings` on a trusted marked PR and builds `earlier` from the `f-` threads and
`itemEarlier`; `post.ts` handles `w-` threads and the `rulings` counts as described in Integration.

### US-012: Bot fix readies a workflow draft
Depends on US-010. Workdir: packages/nax.

Adds `src/bot/workflow-ready.ts` (`workflowPrReadiness`); `runBotFix` calls `recordPrRulings`; `readyStep`
re-reads the PR, uses the workflow rule on a marked draft and writes the evidence comment; `resolveOwnFindings`
skips `w-` keys; `WORKFLOW_PR_HOLD` is deleted.

### US-013: Incremental bot review on a workflow PR
Depends on US-004, US-011. Workdir: packages/nax.

`runBotReview` picks the range from the index's reviewed head and base through `_botReviewDeps.isAncestor`;
`PrReviewInput` gains `rangeBase` and `conversationOnly`; `buildBotPrReviewPrompt` gains the conversation-only
variant.

### US-014: Shared review checklist
No dependencies. Workdir: packages/nax.

Adds `WORKFLOW_DESIGN_DECISIONS_ITEM` to `workflow-quality-checklist.ts` (exported from `@/prompts`); the bot
prompt's item 6 and the branch prompt's remit use it; the bot prompt embeds the quality checklist and enumeration
instruction except in conversation-only mode.

### US-015: Bot review coverage retry
Depends on US-013, US-014. Workdir: packages/nax.

`BotPrReviewInput` gains `requiredFiles`, `repoRoot` and `range`; the op's retry validates coverage;
`runPrReview` passes `reviewRequiredFiles` of the package's changed paths and returns `unreadFiles`;
`runBotReview` passes them to the summary.

### US-016: Promote counts PR rulings
Depends on US-001, US-002, US-004. Workdir: packages/nax.

`nax workflow promote` reads the PR's item threads and merges settled rulings with the sidecar entries as
described in Integration, and reports `prRulings`.

### Context Files

**US-001**
- `packages/nax/src/forge/trust.ts` — `hasWriteAccess`, helpers, `classifyPrTrust`
- `packages/nax/src/forge/threads.ts` — GitLab note mapping
- `packages/nax/src/forge/comments.ts` — `postInlineComment`, `runForgeWrite`
- `packages/nax/src/forge/pr-types.ts` — `PrComment`
- `packages/nax/src/forge/index.ts` — barrel

**US-002**
- `packages/nax/src/forge/marker.ts` — key grammar, `withNaxBotMarker`, `parseNaxBotMarker`
- `packages/nax/src/workflow/pr-body.ts` — `openItemLine` (format reference only; do not import it)
- `packages/nax/src/workflow/decisions-sidecar.ts` — `DISPOSITIONS`
- `packages/nax/src/workflow/pr-body-safe.ts` — `safeInline`

**US-003**
- `packages/nax/src/workflow/decisions-sidecar.ts` — `Disposition`

**US-004**
- `packages/nax/src/workflow/item-threads.ts` — created by US-002, used here
- `packages/nax/src/forge/marker.ts` — `ownComments`
- `packages/nax/src/forge/pr-types.ts` — `PrThread`, `PrComment`

**US-005**
- `packages/nax/src/workflow/open-items.ts` — `buildOpenItems`
- `packages/nax/src/workflow/item-thread-state.ts` — created by US-004, used here
- `packages/nax/src/forge/comments.ts` — `postInlineComment`, `postItemComment` (added by US-001)
- `packages/nax/src/forge/pr-read.ts` — `readPrInfo`, `resolvePrRef`
- `packages/nax/src/workflow/feature-deps.ts` — `_featureDeps.forge`

**US-006**
- `packages/nax/src/workflow/item-threads-post.ts` — created by US-005, extended here
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`, `readHeadSoft`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`
- `packages/nax/src/workflow/feature-machine.ts` — `FeatureSteps`
- `packages/nax/src/forge/comments.ts` — `editComment`, `postPrComment`, `replyToThread`, `resolveThread`

**US-007**
- `packages/nax/src/workflow/finalize.ts` — `prMode`, `pushLedger`

**US-008**
- `packages/nax/src/operations/bot-checks-extract.ts` — fast-tier complete op precedent
- `packages/nax/src/config/schemas-bot.ts` — `bot.models`
- `packages/nax/src/bot/models.ts` — `botModel`
- `packages/nax/src/cli/config-descriptions.ts` — config key descriptions
- `packages/nax/src/prompts/index.ts` — barrel

**US-009**
- `packages/nax/src/workflow/item-thread-state.ts` — created by US-004, used here
- `packages/nax/src/workflow/ruling-keyword.ts` — created by US-003, used here
- `packages/nax/src/forge/access.ts` — created by US-001, used here
- `packages/nax/src/workflow/promote.ts` — `tickChecklist`, `editBodyArgv`
- `packages/nax/src/forge/comments.ts` — `replyToThread`, `resolveThread`

**US-010**
- `packages/nax/src/bot/rulings.ts` — created by US-009, extended here
- `packages/nax/src/operations/bot-ruling-read.ts` — created by US-008, its types used here

**US-011**
- `packages/nax/src/bot/review-run.ts` — `runBotReview`, `triage`, `reviewEnvironment`
- `packages/nax/src/bot/post.ts` — `effectiveEarlier`, `postEarlier`, `mergeEarlier`, artifact
- `packages/nax/src/bot/rulings.ts` — created by US-009, used here
- `packages/nax/src/bot/review-step.ts` — `PrReviewInput.earlier`, `MAX_EARLIER_THREADS`

**US-012**
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, `resolveOwnFindings`, `_fixReportDeps`
- `packages/nax/src/bot/fix-run.ts` — `runBotFix`, `triage`
- `packages/nax/src/bot/rulings.ts` — created by US-009, used here
- `packages/nax/src/workflow/promote.ts` — `evidenceComment`, `markReadyArgv`

**US-013**
- `packages/nax/src/bot/review-run.ts` — `reviewEnvironment`, `_botReviewDeps`
- `packages/nax/src/bot/review-step.ts` — `runPrReview`, `PrReviewInput`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — prompt
- `packages/nax/src/bot/checkout.ts` — `PrCheckout`

**US-014**
- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — shared module
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `CHECKLIST`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — remit
- `packages/nax/src/prompts/index.ts` — barrel

**US-015**
- `packages/nax/src/operations/bot-pr-review.ts` — op and retry
- `packages/nax/src/operations/workflow-branch-review.ts` — coverage retry precedent
- `packages/nax/src/bot/review-step.ts` — `runPrReview`
- `packages/nax/src/workflow/review-coverage.ts` — `reviewRequiredFiles`
- `packages/nax/src/bot/render-comments.ts` — summary

**US-016**
- `packages/nax/src/cli/workflow-promote.ts` — checks, actions, report
- `packages/nax/src/workflow/item-thread-state.ts` — created by US-004, used here
- `packages/nax/src/forge/access.ts` — created by US-001, used here

### Creates

**US-001**
- `packages/nax/src/forge/api-reply.ts`
- `packages/nax/src/forge/access.ts`
- `packages/nax/test/unit/forge/access.test.ts`
- `packages/nax/test/unit/forge/comments-item.test.ts`

**US-002**
- `packages/nax/src/workflow/item-threads.ts`
- `packages/nax/test/unit/workflow/item-threads.test.ts`

**US-003**
- `packages/nax/src/workflow/ruling-keyword.ts`
- `packages/nax/test/unit/workflow/ruling-keyword.test.ts`

**US-004**
- `packages/nax/src/workflow/item-thread-state.ts`
- `packages/nax/test/unit/workflow/item-thread-state.test.ts`

**US-005**
- `packages/nax/src/workflow/item-threads-post.ts`
- `packages/nax/test/unit/workflow/item-threads-post.test.ts`

**US-006**
- `packages/nax/src/workflow/publish-item-threads.ts`
- `packages/nax/test/unit/workflow/item-threads-index.test.ts`
- `packages/nax/test/unit/workflow/publish-item-threads.test.ts`

**US-007**
- `packages/nax/test/unit/workflow/finalize-approval-push.test.ts`

**US-008**
- `packages/nax/src/prompts/builders/bot-ruling-builder.ts`
- `packages/nax/src/operations/bot-ruling-read.ts`
- `packages/nax/test/unit/operations/bot-ruling-read.test.ts`

**US-009**
- `packages/nax/src/bot/rulings.ts`
- `packages/nax/test/unit/bot/rulings.test.ts`

**US-010**
- `packages/nax/test/unit/bot/rulings-model.test.ts`

**US-011**
- `packages/nax/test/integration/bot/review-run-rulings.test.ts`

**US-012**
- `packages/nax/src/bot/workflow-ready.ts`
- `packages/nax/test/unit/bot/workflow-ready.test.ts`
- `packages/nax/test/integration/bot/fix-report-workflow.test.ts`

**US-013**
- `packages/nax/test/integration/bot/review-run-incremental.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/forge/threads.test.ts` — GitLab thread comments are compared with deep equality on `{ id, kind, author, body, createdAt }`; they now also carry `authorId` from the note author's `id`. The invariant: every other field is unchanged and GitHub comments carry no `authorId`.
- `packages/nax/test/unit/forge/threads-comments.test.ts` — GitLab note fixtures and expectations gain the author `id` and `authorId`; the invariant: ordering and every other field are unchanged.

**US-007**
- `packages/nax/test/unit/workflow/finalize.test.ts` — the test asserting a second `commitAndPush` after the approval ("Ledger push failed" warning) and any call-order expectation that includes a post-approval `ledger`/`push` pair are removed or replaced: after an approval there is no further `commitLedger` or `commitAndPush` call. The invariant: the pre-CI ledger commit and push are unchanged. New tests go in the new approval-push test file this story creates; this file must not grow (it is at 797 of 800 lines).

**US-011**
- `packages/nax/test/integration/bot/review-run.test.ts` — stubs of the review deps now also see a `recordPrRulings` dep; tests of unmarked PRs assert nothing new and keep today's `earlier`. New tests go in the new rulings test file this story creates; this file must not grow past 800 lines (it is at 704). The invariant: unmarked PRs see exactly today's `earlier` and posting.
- `packages/nax/test/integration/bot/post-threads.test.ts` — expectations that an own thread with a non-`f-` key is skipped as earlier now hold only for keys that start with neither `f-` nor `w-`. The invariant: `f-` behaviour and `withdrawalEvents` are unchanged.

**US-012**
- `packages/nax/test/integration/bot/fix-report.test.ts` — the case expecting `readyHeld: "nax workflow PR: promote it with nax workflow promote"` (body `marker\n\n## Summary`, no item threads) now expects `readyHeld: "no nax item index on this PR"` and no `waitForChecks` call, with the new `_fixReportDeps` reads stubbed to return no threads and no comments. The invariant: an unmarked PR behaves as today.
- `packages/nax/test/integration/bot/fix-graph.test.ts` — same: the marked-PR expectation of the `WORKFLOW_PR_HOLD` text becomes `no nax item index on this PR`. The invariant: the graph's step order is unchanged.
- `packages/nax/test/unit/bot/fix-summary.test.ts` — the fixture's `readyHeld` string is an example value; it becomes `no nax item index on this PR`. The invariant: `Kept as draft: <readyHeld>` is still rendered verbatim.

**US-014**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — assertions on the checklist section's exact text now see item 6 as `WORKFLOW_DESIGN_DECISIONS_ITEM` plus the bot-only decisions sentence, followed by the quality checklist and enumeration instruction. The invariant: items 1-5, the task and the JSON contract are unchanged.

**US-015**
- `packages/nax/test/integration/bot/review-step.test.ts` — the assertion that the op input has no `requiredFiles` now expects `requiredFiles` equal to the required changed files of the fixture package (and `repoRoot`, `range`). The invariant: the range and package path arguments are unchanged.

**US-016**
- `packages/nax/test/helpers/workflow-promote-fixture.ts` — the fake forge answers `api user` with a login and the review-thread and PR-comment reads with empty pages, so promote's new PR reads succeed with no rulings. The invariant: every existing argv answer is unchanged.
- `packages/nax/test/unit/cli/workflow-promote.test.ts` — expectations on the whole report object gain `prRulings: { read: true, count: 0 }`. The invariant: every `checks[].detail` text and every action is unchanged.

### Seams

- US-004 → US-005, US-009, US-016: `readItemThreads` / `settleItemThreads` are called by `postItemThreads`, `recordPrRulings` and promote.
- US-006: `postItemThreads` is reached from `publishStep` through `postItemThreadsAfterPublish` and `buildFeatureEnv` (seam ACs in US-006).
- US-008 → US-010: `botRulingReadOp` is the `readModel` passed by `runBotReview`, `runBotFix` and `readyStep` (seam ACs in US-011, US-012).
- US-009 → US-011, US-012: `recordPrRulings` is called from `runBotReview`, `runBotFix` and `readyStep`.
- US-001 → US-005, US-009, US-016: `postItemComment` and `hasWriteAccess`.

## Acceptance Criteria

### US-001

- [unit] `hasWriteAccess` is importable from `@/forge` and, on GitHub, returns true when `gh api repos/<repo>/collaborators/<login>/permission` answers `permission` `write`.
- [unit] On GitHub, `hasWriteAccess` returns true for permission `admin`.
- [unit] On GitHub, `hasWriteAccess` returns false for permission `read`.
- [unit] On GitLab, `hasWriteAccess(ref, { login, id: 7 })` calls `projects/<encoded>/members/all/7` and returns true for `access_level` 30.
- [unit] On GitLab, `hasWriteAccess` returns false when the members call fails with stderr containing `404`.
- [unit] On GitLab, `hasWriteAccess` with no `id` throws a `NaxError` with code `FORGE_RESPONSE_UNPARSEABLE`.
- [unit] `hasWriteAccess` throws a `NaxError` when the GitHub reply has no `permission` string.
- [unit] `classifyPrTrust` returns `trusted: true` with reason `author has write access` for an author with write access who is not the current user.
- [unit] `classifyPrTrust` returns `trusted: false` with a reason starting `could not read author permissions:` when the permission call fails.
- [unit] `listReviewThreads` on GitLab returns comments whose `authorId` equals each note's `author.id`.
- [unit] `listPrComments` on GitLab returns comments whose `authorId` equals each note's `author.id`.
- [unit] `listReviewThreads` on GitHub returns comments with `authorId` undefined.
- [unit] `postItemComment` on GitHub calls `gh api -X POST repos/<repo>/pulls/<n>/comments` with `subject_type=file`, `path`, `commit_id` and `body`.
- [unit] `postItemComment` on GitHub sends no `line` field.
- [unit] `postItemComment` on GitLab posts to `projects/<encoded>/merge_requests/<n>/discussions` with `body` and no `position` parameters.
- [unit] `postItemComment` on GitLab returns the discussion id as `threadId`.
- [unit] `postItemComment` rejects a body over `MAX_FORGE_COMMENT_CHARS` with a `NaxError` before any forge call.

### US-002

- [unit] `itemKey({ id: "_run:cv1", kind: "cannot-verify", issue: "x" })` returns `w-_run:cv1.` followed by the first 8 hex characters of SHA-256 over `cannot-verify\nx`.
- [unit] `itemKey` of two items with the same id and different issue text returns different keys.
- [unit] `isPostable` returns false for an id containing a space.
- [unit] `isPostable` returns false for an id whose ask key (`wq-<key>-` plus 20 characters) would exceed 128 characters.
- [unit] `renderItemOpener` for `{ id: "B3", kind: "finding", severity: "important", issue: "x" }` returns a body whose first line is `Open item **B3** (finding): x`.
- [unit] `renderItemOpener` ends the body with the reply instruction line from Design.
- [unit] `renderItemOpener` for an item with a suggestion includes the line `Suggestion: <suggestion>`.
- [unit] `renderItemOpener` for an item with a ruling includes the line `Advisor: <action> — <why>`.
- [unit] `parseItemOpener` of a `renderItemOpener` body returns the item's id and kind.
- [unit] `renderRulingEcho` of a `waived` ruling with reason `ok` by `alice` returns the lines `Recorded: waived — ok`, `By @alice`, `To change it, reply on this thread.`
- [unit] `parseRulingEcho("wr-waived-<itemKey>", body)` of that echo returns the same disposition, reason, item key and `by: "alice"`.
- [unit] `parseRulingEcho` of a `fixed` echo whose first line is `Recorded: fixed in abc1234 — gone` returns `sha: "abc1234"`.
- [unit] `parseRulingEcho` of an echo whose second line is `By nax bot` returns `by: null`.
- [unit] `askKey(key, "99")` returns `wq-<key>-99`.
- [unit] `renderItemIndex({ reviewedHead: <h>, reviewedBase: <b>, keys: [k1, k2] })` returns the lines `nax workflow open items: 2`, `Reviewed head: <h>`, `Reviewed base: <b>`, `- k1`, `- k2`.
- [unit] `parseItemIndex` of a `renderItemIndex` body returns the same reviewed head, reviewed base and keys.
- [unit] `parseItemIndex` returns no reviewed head for `Reviewed head: none`.
- [unit] `parseItemIndex` returns no reviewed head for a sha that is not 40 hex characters.

### US-003

- [unit] `parseRulingKeyword("waive: flaky upstream")` returns `{ disposition: "waived", reason: "flaky upstream" }`.
- [unit] `parseRulingKeyword("WAIVE:   ")` returns null.
- [unit] `parseRulingKeyword("fixed abc1234 — moved the guard")` returns `{ disposition: "fixed", sha: "abc1234", reason: "moved the guard" }`.
- [unit] `parseRulingKeyword("fixed abc1234")` returns a `fixed` ruling with reason `fixed`.
- [unit] `parseRulingKeyword("fixed")` returns null.
- [unit] `parseRulingKeyword("Confirm")` returns `{ disposition: "confirmed", reason: "confirmed" }`.
- [unit] `parseRulingKeyword("override: product decided")` returns `{ disposition: "overridden", reason: "product decided" }`.
- [unit] `parseRulingKeyword("override:")` returns null.
- [unit] `parseRulingKeyword("verified: ran the smoke suite")` returns `{ disposition: "verified", reason: "ran the smoke suite" }`.
- [unit] `parseRulingKeyword("\n\n  confirm\nmore text")` reads only the first non-empty line and returns a `confirmed` ruling.
- [unit] `parseRulingKeyword("I think this is fine")` returns null.

### US-004

- [unit] `readItemThreads` ignores a thread whose opener carries a `w-` marker but is authored by another login.
- [unit] `readItemThreads` returns the index from the own comment keyed `w-index`.
- [unit] `readItemThreads` ignores a `w-index` comment by another login.
- [unit] `readItemThreads` sets `ruling` from the last own comment of a thread when its key starts with `wr-`.
- [unit] `readItemThreads` sets `replies` to the comments after the last own comment that are not own, including a comment by the same login without a marker.
- [unit] `settleItemThreads` returns an item with a ruling and no replies as settled.
- [unit] `settleItemThreads` returns an item with a ruling and only replies whose author `canRule` rejects as settled.
- [unit] `settleItemThreads` returns an item with a ruling and a reply whose author `canRule` accepts as open, with that reply in `kept`.
- [unit] `settleItemThreads` returns an item with no ruling as open, with `kept` holding only replies `canRule` accepts.
- [unit] `settleItemThreads` treats a `canRule` throw as no access for that reply.

### US-005

- [unit] `postItemThreads` posts each open item that has `file` and `line` through `postInlineComment` at that location with the PR's `headSha` and `diffRefs`.
- [unit] The posted body equals `withNaxBotMarker(renderItemOpener(item), itemKey(item))`.
- [unit] When the inline post throws, `postItemThreads` posts the same body through `postItemComment` on the item's file.
- [unit] When the inline post and the post on the item's file both throw, `postItemThreads` posts the same body through `postItemComment` on the anchor path.
- [unit] `postItemThreads` posts an item without a location through `postItemComment` on `.nax/features/<feature>/prd.json` when that repo-relative path is in `changedFiles`.
- [unit] `postItemThreads` posts an item without a location on the first changed file when the PRD path is not in `changedFiles`.
- [unit] `postItemThreads` on GitHub with empty `changedFiles` counts an item without a location in `failed`.
- [unit] `postItemThreads` posts no thread for the `_run:ci` item.
- [unit] `postItemThreads` posts nothing for an item that already has an own thread with its key.
- [unit] `postItemThreads` skips a non-postable item, logs a warning and counts it in `skipped`.
- [unit] When `listReviewThreads` throws, `postItemThreads` posts nothing, logs a warning and returns `failed: 1`.
- [unit] A failed post of one item is counted in `failed` and the next item is still posted.

### US-006

- [unit] `postItemThreads` posts the index comment with `postPrComment` when no own `w-index` comment exists.
- [unit] `postItemThreads` edits an existing own `w-index` comment with `editComment`.
- [unit] The index lists every item key except `_run:ci`, including a non-postable item's key and a key whose post failed.
- [unit] The index's reviewed head is `head` and its reviewed base is `record.seed` when `reviewRan` is true and `reviewUnread`, `costLimited`, `reReviewSkipped`, `gateRepairRounds` and `ciRepairRounds` are unset or zero.
- [unit] The index's reviewed head is `none` when `reReviewSkipped` is true.
- [unit] The index's reviewed head is `none` when `gateRepairRounds` is 1.
- [unit] With `ciRepairRounds` 1 and an existing index naming a reviewed head and base, the new index keeps them.
- [unit] An own item thread whose key is not in the new index gets one reply keyed `wc-<key>` with body `No longer open in the run at <sha7>.` and is resolved.
- [unit] An own item thread that already has a `wc-<key>` reply gets no second reply.
- [unit] `postItemThreadsAfterPublish` calls `env.steps.postItemThreads` once with the publish URL, the head and `changedFiles` from `env.steps.changedFiles(rec.seed)` when publish returns `draft` with a URL.
- [unit] `postItemThreadsAfterPublish` calls it when publish returns `ready` with a URL.
- [unit] `postItemThreadsAfterPublish` does not call it when publish returns `local-only` or `pushed`.
- [unit] `postItemThreadsAfterPublish` passes empty `changedFiles` when `env.steps.changedFiles` throws.
- [unit] `postItemThreadsAfterPublish` logs and returns normally when the step throws.
- [unit] `publishStep`, with `env.steps.publish` stubbed to return `draft` with a URL and `env.steps.postItemThreads` stubbed, calls `postItemThreads` once.
- [unit] `publishStep`, with `env.steps.publish` stubbed to return `local-only`, does not call `env.steps.postItemThreads`.
- [unit] `publishStep` returns the same patch with `env.steps.postItemThreads` defined, undefined, or throwing.
- [integration] `buildFeatureEnv` returns steps whose `postItemThreads` runs the forge reads in `fc.projectDir` (stub `_featureDeps.forge`; trigger `env.steps.postItemThreads`; assert the stub's first call ran with `cwd` equal to `fc.projectDir`).

### US-007

- [unit] `publish` in `pr` mode with an approving advisor calls `commitAndPush` exactly once (the pre-CI push).
- [unit] `publish` in `pr` mode with an approving advisor calls `commitLedger` exactly once, before the push.
- [unit] `publish` in `pr` mode with an approving advisor returns outcome `ready` with the CI outcome observed on the pushed head.
- [unit] `publish` in `pr` mode with a held advisor calls `commitAndPush` exactly once and returns `draft`.

### US-008

- [unit] Constructing the config with `bot.models.rulings` unset yields `botModel(config, "rulings")` equal to `"fast"`, even when `workflow.models.branchFix` is set.
- [unit] With `bot.models.rulings` set to `"balanced"`, `botModel(config, "rulings")` returns `"balanced"`.
- [unit] An override argument to `botModel(config, "rulings", override)` wins over `bot.models.rulings`.
- [unit] `buildBotRulingReadPrompt` is importable from `@/prompts` and puts each item's id, kind, issue and its reply's id, author and body inside fences that the reply text cannot terminate.
- [unit] `buildBotRulingReadPrompt` places that content under a heading saying it is untrusted data.
- [unit] `buildBotRulingReadPrompt` asks for one JSON object `{"rulings":[{"id","disposition","reason","quote","sha"}]}` with `disposition` one of `fixed`, `waived`, `confirmed`, `overridden`, `verified`, `none`.
- [unit] `buildBotRulingReadPrompt` tells the model to answer `none` when the reply's meaning is not clear.
- [unit] `buildBotRulingReadPrompt` tells the model to copy `quote` verbatim from the reply.
- [unit] `botRulingReadOp` is importable from `@/operations`, has `kind` `complete`, and takes its model from `input.model`.
- [unit] `botRulingReadOp.parse` of a fenced JSON reply returns the rulings array.
- [unit] `botRulingReadOp.parse` drops an entry whose id is not one of the input item ids.
- [unit] `botRulingReadOp.parse` drops an entry whose disposition is not in the union.
- [unit] `botRulingReadOp.parse` returns null for a reply with no JSON object.

### US-009

- [unit] A newest kept reply `waive: ok` on an open item yields one `wr-waived-<key>` echo reply.
- [unit] After that echo, `recordPrRulings` calls `resolveThread` once for the thread.
- [unit] A keyword reply from an author for whom `hasWriteAccess` returns false yields no echo.
- [unit] When `hasWriteAccess` throws for an author, that author's reply is not a ruling and a warning is logged.
- [unit] `hasWriteAccess` is called once per login per `recordPrRulings` call.
- [unit] An item thread whose key is not in the index is neither settled nor open in the outcome.
- [unit] When the echo reply throws, the item stays open, no `resolveThread` call is made for it, and `failed` is 1.
- [unit] When `resolveThread` throws after an echo, the item is settled and a warning is logged.
- [unit] A settled item whose thread is unresolved gets one `resolveThread` call and no new echo.
- [unit] After recording, `recordPrRulings` re-reads the PR with `readPrInfo` and edits the body once with `tickChecklist` of one entry per settled item.
- [unit] The tick entry of a settled `ruling` item has kind `advisor`, and a `fixed` entry carries its sha.
- [unit] When the ticked body equals the current body, no body edit is made.
- [unit] When the body edit throws, the outcome is still returned and a warning is logged.
- [unit] The outcome carries the index read from the `w-index` comment.

### US-010

- [unit] With an older writer reply `waive: x` and a newer writer reply without a keyword, the newer reply goes to `readModel` and the waive is not recorded.
- [unit] Every open item whose newest kept reply has no keyword is sent in one `readModel` call.
- [unit] A model ruling whose `quote` occurs in the reply (whitespace collapsed) is recorded with `by` set to the reply's author.
- [unit] A model ruling whose `quote` does not occur in the reply is not recorded.
- [unit] For that rejected ruling, an ask keyed `wq-<key>-<replyId>` is posted in the thread.
- [unit] A model `fixed` ruling whose sha does not occur in the reply is not recorded.
- [unit] A model ruling `none` is not recorded and an ask is posted.
- [unit] An ask whose key already exists as an own comment in the thread is not posted again.
- [unit] When `readModel` returns null, keyword rulings in the same call are recorded and no ask is posted.
- [unit] When `readModel` throws, keyword rulings in the same call are recorded, no ask is posted, and a warning is logged.
- [unit] With 21 model-read items, `readModel` receives the first 20 in index order and the 21st stays open.

### US-011

- [integration] `runBotReview` on a trusted PR whose body has `NAX_WORKFLOW_PR_MARKER` calls `recordPrRulings` once, before `runPrReview` (stub both through `_botReviewDeps`; assert call order).
- [integration] `runBotReview` on a PR without the marker does not call `recordPrRulings`.
- [integration] `runBotReview` on an untrusted marked PR does not call `recordPrRulings`.
- [integration] `runBotReview` passes `recordPrRulings` a `readModel` that calls `botRulingReadOp` with `botModel(config, "rulings")` (stub `callOp`; trigger `readModel`; assert the op and model).
- [integration] When `recordPrRulings` throws, `runBotReview` logs a warning and still calls `runPrReview`.
- [integration] `runBotReview` passes `runPrReview` an `earlier` list of the own `f-` threads followed by the open item threads of kind `finding` or `ruling`, including a resolved one.
- [integration] Item threads of kind `advisor` or `cannot-verify` are not in `earlier`.
- [integration] Each item thread in `earlier` carries the opener, own comments and the kept replies only, not a reply by an author without write access.
- [integration] The op's `earlierIds` include the item thread ids, capped with the `f-` threads at `MAX_EARLIER_THREADS`.
- [unit] An earlier verdict `fixed` on a `w-` thread posts a `wr-fixed-<key>` echo whose sha is `info.headSha` and resolves the thread.
- [unit] An earlier verdict `withdrawn` on a `w-` thread posts the earlier reply and does not resolve the thread.
- [unit] An earlier verdict `open` on a `w-` thread adds an agreed finding keyed with the thread's item key whose issue is the opener's first line.
- [unit] `withdrawalEvents` emits no event for a `w-` thread.
- [unit] `bot-review.json` written with `rulings` in `PostReviewInput` carries the `recorded`, `open` and `asked` counts.

### US-012

- [unit] `workflowPrReadiness` returns not ready with reason `rulings could not be read` when the outcome is absent.
- [unit] `workflowPrReadiness` returns not ready with reason `no nax item index on this PR` when the outcome has no index.
- [unit] `workflowPrReadiness` returns not ready with reason `1 item(s) without a thread: _run:cv2` when an index key has no settled or open item.
- [unit] `workflowPrReadiness` returns not ready with reason `1 open item(s): B3` when one item is open.
- [unit] `workflowPrReadiness` returns not ready with reason `CI failed: <detail>` when every item is settled and CI is `failed`.
- [unit] `workflowPrReadiness` returns `{ ready: true }` when every index key is settled and CI is green.
- [unit] `workflowPrReadiness` returns `{ ready: true }` for an index with no keys and green CI.
- [integration] `readyStep` on a marked draft re-reads the PR through `_fixReportDeps` and calls `recordPrRulings` with the threads and comments it read.
- [integration] `readyStep` on a marked draft with an open item does not call `waitForChecks` and returns `markedReady: false` with the readiness reason.
- [integration] `readyStep` on a marked draft whose items are all settled waits for CI, then posts the `w-evidence` comment of the settled entries, then runs `markReadyArgv`, and returns `markedReady: true`.
- [integration] `readyStep` edits an existing own `w-evidence` comment instead of posting a second one.
- [integration] `readyStep` with an empty index and green CI marks the PR ready without an evidence comment.
- [integration] When the evidence comment fails, `readyStep` does not mark the PR ready and returns `readyHeld` starting `evidence comment failed:`.
- [integration] When `recordPrRulings` throws in `readyStep`, it returns `markedReady: false` with `readyHeld` `rulings could not be read`.
- [integration] `readyStep` passes `recordPrRulings` a `readModel` that calls `botRulingReadOp` with `botModel(config, "rulings")`.
- [integration] `readyStep` on an unmarked draft behaves as today (CI green only).
- [integration] `runBotFix` on a trusted marked PR calls `recordPrRulings` before the fix step.
- [integration] When `recordPrRulings` throws in `runBotFix`, the fix step still runs and a warning is logged.
- [unit] `resolveOwnFindings` makes no reply or resolve call for an agreed item whose key starts with `w-`.

### US-013

- [integration] `runBotReview` on a trusted marked PR whose head equals the index's reviewed head calls `runPrReview` with `conversationOnly: true`.
- [integration] `runBotReview` on a trusted marked PR whose reviewed head is an ancestor of a later head calls `runPrReview` with `rangeBase` equal to the reviewed head.
- [integration] `runBotReview` calls `runPrReview` with `rangeBase` equal to the merge base when `isAncestor(reviewedHead, prHead)` is false.
- [integration] `runBotReview` calls `runPrReview` with `rangeBase` equal to the merge base when `isAncestor(reviewedBase, mergeBase)` is false.
- [integration] `runBotReview` calls `runPrReview` with `rangeBase` equal to the merge base when `isAncestor` throws.
- [integration] `runBotReview` calls `runPrReview` with `rangeBase` equal to the merge base when the index says `Reviewed head: none`.
- [integration] `runBotReview` on an untrusted marked PR ignores the index and reviews from the merge base.
- [unit] `_botReviewDeps.isAncestor` returns true on exit 0, false on exit 1, and throws on any other exit.
- [unit] `runPrReview` with `rangeBase` writes the package from `rangeBase` and puts `<rangeBase>..HEAD` in the prompt.
- [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` says the code at this head was reviewed by the workflow's branch review and that findings may come only from what a thread, comment or earlier finding points at.
- [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` names no range and no package path.
- [unit] `runPrReview` with `conversationOnly: true` writes no review package.

### US-014

- [unit] `WORKFLOW_DESIGN_DECISIONS_ITEM` is importable from `@/prompts` and names ADRs or architecture docs (for example `docs/adr/` or `docs/architecture/`).
- [unit] `WORKFLOW_DESIGN_DECISIONS_ITEM` says a PR that edits a design doc is reviewed as a design change.
- [unit] `buildBotPrReviewPrompt` output has checklist item 6 equal to `WORKFLOW_DESIGN_DECISIONS_ITEM` followed by `If project decisions are listed below, check the change against them too.`
- [unit] `buildBotPrReviewPrompt` output contains `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION` after the checklist and before the untrusted content section.
- [unit] `buildBotPrReviewPrompt` in static mode still contains `WORKFLOW_QUALITY_CHECKLIST`.
- [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` contains neither `WORKFLOW_QUALITY_CHECKLIST` nor `WORKFLOW_ENUMERATION_INSTRUCTION`.
- [unit] `buildWorkflowBranchReviewPrompt` output lists `WORKFLOW_DESIGN_DECISIONS_ITEM` as a bullet under "Your remit".

### US-015

- [unit] `botPrReviewOp`'s retry asks again with `buildWorkflowBranchCoverageRetry(range, missing)` when the reply answers every thread, comment and earlier id but `inspectedFiles` misses a required file.
- [unit] `botPrReviewOp`'s retry asks with the triage retry, not the coverage retry, when ids are missing.
- [unit] `botPrReviewOp`'s retry does not ask again for coverage when `requiredFiles` is absent.
- [unit] After the retry budget, a verdict that still misses files is returned, findings included.
- [unit] `botPrStaticReviewOp` validates coverage the same way as `botPrReviewOp`.
- [unit] `runPrReview` passes `requiredFiles` equal to `reviewRequiredFiles` of the package's changed paths, with `repoRoot` the checkout and `range` the prompt's range.
- [unit] `runPrReview` omits `requiredFiles` when `reviewRequiredFiles` returns an empty list.
- [unit] `runPrReview` omits `requiredFiles` when `conversationOnly` is true.
- [unit] `runPrReview`'s result carries `unreadFiles` naming each required file the verdict did not inspect.
- [integration] `runBotReview` passes those `unreadFiles` to `postPrReview`, and the summary comment has a line starting `Not read by the review:` naming them.

### US-016

- [unit] `nax workflow promote` passes `items-ruled` when every open item has a sidecar entry or a settled item thread whose key equals `itemKey(item)`.
- [unit] `nax workflow promote` fails `items-ruled` naming the item ids that have neither.
- [unit] A settled item thread whose key hash differs from the current item's key does not rule that item.
- [unit] When the sidecar and a settled thread both rule one id, the tick and the evidence comment use the sidecar entry.
- [unit] A settled thread ruling becomes a `DecisionEntry` with the mapped kind, the echo's disposition and reason, and its sha for `fixed`.
- [unit] Replies are checked with `hasWriteAccess`, so a non-writer reply after an echo does not unsettle the item.
- [unit] When reading the PR threads fails, `items-ruled` counts sidecar entries only, a warning is logged, and the report has `prRulings: { read: false, error }`.
- [unit] When the PR threads are read, the report has `prRulings: { read: true, count }` with the number of settled rulings used.
