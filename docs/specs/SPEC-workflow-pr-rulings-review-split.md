<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Workflow PR rulings and the review split

Closes: #2629

## Summary

A nax workflow draft PR lists what is still open (flagged rulings, advisor holds, cannot-verify items, red
gates, unfinished stories) in its body, and only a local `nax workflow record` + `nax workflow promote` can
settle them. This spec moves those rulings onto the PR. Publish opens one nax bot thread per open item; a
collaborator rules by replying on that thread (a keyword such as `waive: <reason>` is read directly, any other
reply is read by one fast-tier model call); `nax bot review` and `nax bot fix` record each ruling with a reply
in the same thread; and `nax bot fix` marks a workflow draft ready once every item is ruled and CI is green on
the head. `nax workflow promote` counts the same PR rulings. Alongside it, the two review engines share one
checklist module: `nax bot review` gains the nine code-quality classes, the walk-every-function instruction and
the read-every-changed-file retry the branch review has, and the branch review gains the design-decisions item
the bot review has. On a nax workflow PR, `nax bot review` reviews only the commits pushed after publish. The
post-approval ledger push (nax#2629) is dropped, so an approved workflow PR runs CI once and is never promoted
while its head's CI is pending.

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
  `nax run` already reviewed every commit up to publish.
- nax#2629: `prMode` (`src/workflow/finalize.ts`) commits and pushes the advisor's `finish-approval` ledger line
  after the CI wait (`pushLedger`), which starts a second full CI run and leaves the promoted PR's head pending.

User rulings 2026-10-21 (workspace master plan `nax-step-graph-and-bot-master-plan.md` §B4 "Part 3 rulings"):
collaborators with write access may settle any item; nax bot may settle an item only as `fixed` with a sha;
everyone else is conversation, never a ruling. Reply format is hybrid: keyword fast path, model read otherwise,
fail closed, the bot echoes what it recorded. Both engines stay separate (no merged engine).

## Design

### Approach

One capability, three layers:

1. **Item threads (workflow side).** After every `pr`-mode publish that leaves a draft with a URL, the feature
   graph's `publish` step calls a new optional step `steps.postItemThreads`. It opens one nax bot thread per open
   item (`buildOpenItems` of the record, minus the `ci` item), keyed `w-<itemId>`, and replies `fixed` on any
   earlier `w-` thread whose item is no longer open. The step is optional on `FeatureSteps` (like
   `readCiFailures`), so the G0 equivalence goldens, which do not supply it, are unchanged. The PR body gains a
   head marker line naming the head publish pushed.
2. **Rulings (bot side).** A new `recordPrRulings` reads every own `w-` thread, decides which are settled, reads
   collaborator replies (keyword parser first, then one batched model call), checks the replier's write access,
   and records each ruling as an echo reply (`wr-` key) plus a body checklist tick. `nax bot review` and
   `nax bot fix` both call it first. `nax bot fix`'s ready step then applies the workflow rule: CI green on the
   head, and every item settled.
3. **Review split.** The bot prompt embeds the shared quality checklist and enumeration instruction; the shared
   module gains the design-decisions item, which both prompts embed. The bot review op gains the coverage
   retry. On a marked, trusted PR whose head marker sha is an ancestor of the head, the bot review range starts
   at that sha; when the head equals it, the review covers the conversation only.

### Formats

All new marker keys go through `withNaxBotMarker` / `parseNaxBotMarker` (`src/forge/marker.ts`), whose key grammar
is `[A-Za-z0-9._:-]{1,128}`. An item whose id does not fit is not posted (logged), which keeps the PR a draft
(fail closed, see Failure Handling).

- **Item thread key:** `w-<itemId>`, for example `w-_run:cv1`, `w-B3`, `w-lint`.
- **Item thread opener** (body passed to `withNaxBotMarker`): first line
  `Open item **<itemId>** (<kind>): <issue>`, where `<kind>` is the `OpenItem.kind` and `<issue>` is the item's
  issue text through `safeInline`; then the suggestion and advisor-ruling lines `openItemLine` would print; then
  the line `Rule on it by replying: fixed <sha>, waive: <reason>, confirm, override: <reason>, or verified. Any other reply from a collaborator is read as a ruling only when its meaning is clear.`
- **Ruling echo key:** `wr-<disposition>-<itemId>`, where `<disposition>` is one of the sidecar `DISPOSITIONS`
  (`fixed`, `waived`, `confirmed`, `overridden`, `verified`), none of which contains `-`.
- **Ruling echo body:** first line `Recorded: <disposition> — <reason>` (the reason through `safeInline`), second
  line `By @<login>` (or `By nax bot` for a bot ruling), third line
  `To change it, reply on this thread.`; a `fixed` ruling's first line is
  `Recorded: fixed in <sha7> — <reason>`.
- **Ask key:** `wq-<itemId>-<commentId>`; body
  `I could not read a ruling from that reply. Start a reply with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified.`
- **Head marker line** in the workflow PR body, directly after `NAX_WORKFLOW_PR_MARKER`:
  `<!-- nax-workflow-head:<sha> -->` with a 40-hex sha.

Keyword grammar (`parseRulingKeyword`), applied to the reply's first non-empty line after trimming, case-
insensitive on the keyword:

| First line | Ruling |
|---|---|
| `fixed <sha>` (`<sha>` 7-40 hex), optional ` — <reason>` or ` - <reason>` or `: <reason>` | `fixed`, sha, reason (default `fixed`) |
| `waive: <reason>` / `waived: <reason>` | `waived`, reason (non-empty required) |
| `confirm` / `confirmed`, optional `: <reason>` | `confirmed`, reason (default `confirmed`) |
| `override: <reason>` / `overridden: <reason>` | `overridden`, reason (non-empty required) |
| `verified` / `verify`, optional `: <reason>` | `verified`, reason (default `verified`) |
| anything else, or `waive`/`override` with an empty reason | not a keyword ruling (`null`) |

### Integration

Read-only symbols (verified on `a0751f2f2`):

- `buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[]` — `src/workflow/open-items.ts`.
- `OpenItem` (`id`, `kind`, `severity?`, `file?`, `line?`, `issue`, `suggestion?`, `ruling?`) — `src/workflow/types.ts`.
- `DISPOSITIONS`, `Disposition`, `DecisionEntry`, `sidecarKindFor(item)` — `src/workflow/decisions-sidecar.ts`.
- `openItemLine(item, chars?)` — `src/workflow/pr-body.ts`; `safeInline` — `src/workflow/pr-body-safe.ts`.
- `tickChecklist(body, entries)`, `evidenceComment(entries)`, `editBodyArgv`, `commentArgv`, `markReadyArgv` — `src/workflow/promote.ts`.
- `withNaxBotMarker`, `parseNaxBotMarker`, `ownComments`, `hasNaxWorkflowMarker`, `NAX_WORKFLOW_PR_MARKER` — `src/forge/marker.ts`.
- `postInlineComment`, `replyToThread`, `resolveThread`, `postPrComment` — `src/forge/comments.ts`.
- `listReviewThreads`, `listPrComments` — `src/forge/threads.ts`; `readCurrentUser`, `classifyPrTrust` — `src/forge/trust.ts`.
- `prNumberFromUrl`, `resolvePrRef`, `readPrInfo` — `@/forge`.
- `ciAllowsReady`, `waitForChecks` — `src/workflow/ci-wait.ts`.
- `unreadFiles` — `src/operations/workflow-review-coverage.ts`; `buildWorkflowBranchCoverageRetry(range, missing)` — `src/prompts/builders/workflow-branch-builder.ts`.
- `reviewRequiredFiles(paths, fc)` — `src/workflow/review-coverage.ts` (takes `config`, `projectDir`, `packageDirs`, which `PrStepContext` has).
- `writeBranchReviewPackage(projectDir, base, packagePath, opts?)` returns the changed paths — `src/workflow/git.ts`.
- `botChecksExtractOp` — the precedent for a fast-tier complete op whose model is `config.bot?.models.checks` (`src/operations`).
- `parseLLMJson` — `src/utils/llm-json`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `PrComment` (`src/forge/pr-types.ts`). Baseline: `{ id, kind, author, body, createdAt }`. Target: adds
  `readonly authorId?: number`, set from the GitLab note's `author.id` (`GitlabDiscussion.notes[].author` gains
  `id: number`) and left unset on GitHub.
- `hasWriteAccess` (`src/forge/trust.ts`, private). Baseline: `(ref, info: PrInfo, deps, cwd)`. Target: moved to a
  new exported `hasWriteAccess(ref, who: { login: string; id?: number }, deps, cwd): Promise<boolean>` in
  `src/forge/access.ts`, exported from `@/forge`; `classifyPrTrust` calls it with `info.author`, behaviour
  unchanged.
- `FeatureSteps` (`src/workflow/feature-machine.ts`). Target: adds optional
  `postItemThreads?: (input: ItemThreadsInput) => Promise<ItemThreadsOutcome>`.
- `publishStep` (`src/workflow/feature-steps.ts`). Target: after `env.steps.publish(rec)`, when
  `out.outcome` is `"draft"` or `"ready"`, `out.url` is set and `env.steps.postItemThreads` is defined, calls it
  with the record patched by this publish (outcome, ci, ciDetail, reasons, approval, storyStates) and `head`;
  a throw is logged and the step continues.
- `buildWorkflowPrBody` (`src/workflow/pr-body.ts`). Target: takes optional `head?: string` and writes the head
  marker line after the workflow marker when it is a 40-hex sha.
- `prMode` (`src/workflow/finalize.ts`). Baseline: calls `pushLedger(fc)` after an approval. Target: no
  post-approval ledger commit or push; `pushLedger` is deleted.
- `readyStep` (`src/bot/fix-report.ts`). Baseline: returns `readyHeld: WORKFLOW_PR_HOLD` for a marked PR.
  Target: a marked PR goes through `workflowPrReadiness` (below); `WORKFLOW_PR_HOLD` is deleted.
- `buildBotPrReviewPrompt` (`src/prompts/builders/bot-pr-review-builder.ts`). Target: `CHECKLIST` item 6 text
  is replaced by `WORKFLOW_DESIGN_DECISIONS_ITEM`, and the checklist section is followed by
  `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION`; `BotPrReviewPromptInput` gains optional
  `conversationOnly?: boolean`.
- `buildWorkflowBranchReviewPrompt`. Target: its remit list gains `WORKFLOW_DESIGN_DECISIONS_ITEM` as a bullet.
- `BotPrReviewInput` (`src/operations/bot-pr-review.ts`). Target: adds optional `requiredFiles?: readonly string[]`,
  `repoRoot?: string`, `range?: string`; when `requiredFiles` is non-empty, the retry `validate` also requires
  `unreadFiles(requiredFiles, verdict.inspectedFiles, repoRoot)` to be empty, and `invalid` returns
  `buildWorkflowBranchCoverageRetry(range, missing)` when triage is complete but files are missing.
- `PrReviewInput` (`src/bot/review-step.ts`). Target: adds optional `rangeBase?: string` (defaults to
  `mergeBase`) and `conversationOnly?: boolean`.
- `BotConfig.models` (`src/config/schemas-bot.ts`). Target: adds `rulings: ConfiguredModelSchema.optional()`;
  `botModel` role union gains `"rulings"`, which falls back to `"fast"` (no workflow or finish fallback).
- `runWorkflowPromote` checks (`src/cli/workflow-promote.ts`). Target: the `items-ruled` check counts an item as
  ruled when the sidecar has an entry for it or a settled own `w-` thread on the PR rules it; a sidecar entry wins
  over a PR ruling for the same id; the tick and comment actions use the merged entries.

New modules:

- `src/forge/access.ts` — `hasWriteAccess` (above).
- `src/workflow/item-threads.ts` (pure) — `ITEM_THREAD_PREFIX = "w-"`, `RULING_ECHO_PREFIX = "wr-"`,
  `itemThreadKey(id)`, `renderItemOpener(item)`, `parseItemOpener(body)`, `parseRulingKeyword(text)`,
  `renderRulingEcho(ruling)`, `parseRulingEcho(key, body)`, `renderRulingAsk()`, `askKey(itemId, commentId)`,
  `headMarkerLine(sha)`, `parseHeadMarker(body)`, `classifyItemThreads(threads, login)`.
- `src/workflow/item-threads-post.ts` — `postItemThreads(input)`.
- `src/prompts/builders/bot-ruling-builder.ts` — `buildBotRulingReadPrompt(input)`.
- `src/operations/bot-ruling-read.ts` — `botRulingReadOp`.
- `src/bot/rulings.ts` — `recordPrRulings(input)`.
- `src/bot/workflow-ready.ts` — `workflowPrReadiness(input)`.

Worked skeletons for the novel pure shapes:

```typescript
// src/workflow/item-threads.ts
export interface PrRuling {
  readonly itemId: string;
  readonly disposition: Disposition;
  readonly reason: string;            // one line, non-empty
  readonly sha?: string;              // required when disposition is "fixed"
  readonly by: string | null;         // login; null = nax bot
}
export type ItemThreadState =
  | { readonly state: "settled"; readonly itemId: string; readonly kind: string; readonly thread: PrThread; readonly ruling: PrRuling }
  | { readonly state: "open"; readonly itemId: string; readonly kind: string; readonly thread: PrThread; readonly replies: readonly PrComment[] };
/** Own `w-` threads only (opener author === login and a `w-` marker). `replies` = non-own comments after the last own comment. */
export function classifyItemThreads(threads: readonly PrThread[], login: string): ItemThreadState[];
```

```typescript
// src/bot/rulings.ts
export interface RecordRulingsInput {
  readonly ref: PrRef; readonly info: PrInfo; readonly threads: readonly PrThread[]; readonly login: string;
  readonly deps: ForgeDeps; readonly cwd: string;
  readonly readModel: (input: BotRulingReadInput) => Promise<BotRulingReadVerdict | null>;
}
export interface RecordRulingsOutcome {
  readonly recorded: readonly PrRuling[];   // echoed this call
  readonly settled: readonly ItemThreadState[]; // after this call
  readonly open: readonly ItemThreadState[];
  readonly asked: number;
  readonly failed: number;
}
export async function recordPrRulings(input: RecordRulingsInput): Promise<RecordRulingsOutcome>;
```

### Item threads at publish

`postItemThreads(input: ItemThreadsInput)` where `ItemThreadsInput` is
`{ record: WorkflowFeatureRecord; url: string; head?: string; projectDir: string }`. Order:

1. `prNumberFromUrl(url)`, `resolvePrRef`, `readCurrentUser`, `listReviewThreads`.
2. `items = buildOpenItems(record)` minus kind `ci`.
3. For each item with no own `w-<id>` thread: post it. An item with `file` and `line` goes inline at that
   location via `postInlineComment`; any other item goes inline at line 1 of `.nax/features/<feature>/prd.json`
   (the file every workflow branch changes; the path is built with `featureDir`). When the inline post fails
   (the location is not in the diff), the item is posted as a top-level comment with `postPrComment` carrying the
   same key. Items are posted in `buildOpenItems` order.
4. For each own `w-` thread classified `open` whose item is not in `items`: reply with a bot ruling echo
   `fixed` at `head` with reason `no longer open at <sha7>` and resolve the thread.
5. Return `{ posted, cleared, skipped, failed }`. Every forge call is wrapped: a failure is logged with the item
   id, counted in `failed`, and the loop continues.

`publish` passes `head` to `buildWorkflowPrBody` for both the draft and the final body, so the head marker names
the head CI was waited on. `postItemThreads` is wired in `buildFeatureEnv` (`src/workflow/feature-env.ts`).

### Recording rulings

`recordPrRulings` order:

1. `states = classifyItemThreads(threads, login)`. A `settled` state is kept as is.
2. For each `open` state, keep only replies whose author has write access: `hasWriteAccess(ref, { login: author,
   id: authorId }, deps, cwd)`, memoised per login for the call. A read failure counts as no access and is logged.
3. For each open state, walk the kept replies newest first; the first whose `parseRulingKeyword` returns a
   ruling is that item's candidate ruling (`by` = its author).
4. Open states with kept replies but no keyword ruling go to one `readModel` call, batched over all of them (at
   most `MAX_RULING_ITEMS = 20` per call, in item order; the rest stay open this call). A model ruling is accepted
   only when: its `quote` occurs verbatim (after collapsing whitespace) in one of that item's kept replies; its
   disposition is one of `DISPOSITIONS`; its reason is one non-empty line; and a `fixed` ruling carries a sha
   that occurs in the quoted reply. Otherwise the item gets no ruling, and an ask comment is posted in the thread
   once per reply (keyed `askKey(itemId, replyId)`; an existing ask with that key is not re-posted).
5. Each accepted ruling: reply with the echo (key `wr-<disposition>-<itemId>`) via `replyToThread`, then
   `resolveThread`. A settled thread that is unresolved is resolved again (no new echo).
6. Tick the PR body: `tickChecklist(info.body, entries)` with one `DecisionEntry` per settled item (kind from
   `sidecarKindFor` of the opener's kind, `sha` for `fixed`), written with `editBodyArgv` only when the body
   changed.

A bot ruling (`by: null`) is only ever `fixed`; `recordPrRulings` never creates one, it only reads them.

### Bot review and bot fix

- `runBotReview` and `runBotFix` call `recordPrRulings` after the checkout and before the review/fix agent step,
  when the PR body has the workflow marker and the PR is trusted. The outcome is logged and saved in the
  artifact (`bot-review.json` gains `rulings: { recorded, open, asked }` counts; version stays 2).
- The bot review's `triage` adds own `w-` threads whose opener kind is `finding` or `ruling` and whose state is
  `open` to `earlier`. In `postEarlier`, an earlier verdict `fixed` on a `w-` thread posts a bot ruling echo
  `fixed` at the reviewed head sha (reason = the verdict reason) and resolves the thread; `withdrawn` on a `w-`
  thread posts the plain earlier reply and leaves the item open (a bot never waives).
- `workflowPrReadiness({ states, body, ci })` returns `{ ready: true }` or `{ ready: false, reason }`. Not ready,
  in this order: CI not `ciAllowsReady` (`CI <outcome>: <detail>`); any `open` state (`<n> open item(s): <ids>`);
  any unticked `- [ ] **<id>**` checklist line other than `_run:ci` with no settled state for `<id>`
  (`<n> item(s) without a thread: <ids>`).
- `readyStep` on a marked PR re-reads threads, runs `recordPrRulings`, waits for CI as today, and calls
  `workflowPrReadiness`. Ready: post `evidenceComment(entries)` as one comment, then `markReadyArgv`.

### Incremental bot review

In `runBotReview`, when the PR is trusted, its body has the workflow marker and `parseHeadMarker(body)` returns a
sha that `git merge-base --is-ancestor <sha> <head>` accepts in the checkout:

- head equal to the sha: `conversationOnly: true`; the prompt says the code at this head was reviewed by the
  workflow's branch review, that findings may come only from what a thread, comment or earlier finding points at,
  and lists no range or package; `requiredFiles` is empty.
- otherwise: `rangeBase = sha`; the package and range are `<sha>..HEAD`; `requiredFiles` comes from
  `reviewRequiredFiles` over the package's changed paths.

Any other case keeps today's full review from `mergeBase`, with `requiredFiles` from `reviewRequiredFiles`
over the package's changed paths (static mode included).

### Failure Handling

| Failure | Behaviour |
|---|---|
| `postItemThreads` cannot resolve the PR ref, the user or the threads | logs a warning naming the step, posts nothing, publish outcome unchanged (fail open: the body checklist still lists every item, and readiness fails closed on an item without a thread) |
| An item id does not fit the marker key grammar | logged, counted in `skipped`, not posted |
| Inline post fails | falls back to a top-level comment with the same key; a second failure is counted in `failed` |
| `hasWriteAccess` throws for a replier | treated as no write access, logged; that reply is not a ruling |
| `readModel` returns null or throws | no model rulings this call; keyword rulings still count; no ask is posted |
| Model ruling fails validation | no ruling; ask posted once per reply |
| Echo reply fails | the ruling is not recorded (the item stays open), counted in `failed` |
| `resolveThread` fails after an echo | logged; the thread is settled (the echo is the record) and is resolved again next call |
| Body edit fails | logged; readiness does not depend on ticks |
| Evidence comment fails in `readyStep` | the PR is not marked ready; `readyHeld` = `evidence comment failed: <detail>` |
| Head marker sha is not an ancestor of the head, or is malformed | full review from `mergeBase` |
| Coverage retry still misses files | the verdict is kept; the summary comment lists the unread files |

## Out of Scope

- `nax bot fix` does not repair CI and does not run the advisor; an advisor hold is cleared only by a collaborator reply.
- `nax bot fix` does not rule `fixed` on gate items when its gates pass; a red-gate item is settled by a collaborator reply or by the next workflow publish.
- A nax bot ruling other than `fixed` is never created by any path.
- Comments from authors without write access (including the PR author when they lack it and other bots) are never rulings; the bot review still answers them as threads or comments.
- Untrusted PRs (fork, author without write access) get no ruling reading and no incremental review; they keep today's static full review.
- Workflow PRs published before this change carry no item threads and no head marker; `nax bot fix` holds such a draft until every checklist id has a settled thread, which it never has, so it stays `nax workflow promote`'s job.
- `nax workflow record` stays local; it does not post to the PR.
- The `finish-approval` ledger line is no longer pushed after approval; it stays in the working tree until a later run's ledger commit.
- A collaborator who resolves an item thread without replying does not rule; the bot re-opens nothing and records nothing.
- More than 20 model-read items in one call: the rest stay open until the next bot run.
- The `.nax/rules/retry-strategy.md` ruled exception must be extended to say the bot review ops' `validate` also requires coverage of the required files; this is a manual edit in the same commit as US-011 (`.nax/` is read-only to the run).
- Documentation (`docs/guides/workflow-mode.md`, `docs/guides/bot.md`) is a manual follow-up after merge.
- Merging the branch review and the PR review into one engine is not done (user ruling 2026-10-21).
- The nax-finish skill is changed in B4 part 4, not here.

## Stories

Twelve stories, one capability: a workflow draft whose open items are ruled on the PR and promoted by `nax bot
fix`, and a bot review that applies the branch review's checks and skips what the branch review already did.
It is past the 8-story size check and was confirmed as one capability by the user 2026-10-21 (one spec, one
PR); the split keeps Context Files at 5 or fewer and ACs under the 24 cap. Every story runs in `packages/nax`.

### US-001: Commenter write access
No dependencies. Workdir: packages/nax.

Adds `src/forge/access.ts` with the exported `hasWriteAccess(ref, who, deps, cwd)`, moves the logic out of
`trust.ts` (whose `classifyPrTrust` now calls it with `info.author`), exports it from `@/forge`, and adds
`authorId` to `PrComment` from GitLab note authors.

### US-002: Item thread formats
No dependencies. Workdir: packages/nax.

Adds the pure module `src/workflow/item-threads.ts` with every symbol listed under New modules, implementing the
formats and the keyword grammar in Design "Formats", and `classifyItemThreads`.

### US-003: Item threads at publish
Depends on US-002. Workdir: packages/nax.

Adds `src/workflow/item-threads-post.ts` (`postItemThreads`), the optional `FeatureSteps.postItemThreads`, its
call from `publishStep`, its wiring in `buildFeatureEnv`, and the head marker in `buildWorkflowPrBody` fed by
`publish`.

### US-004: One CI run for an approved workflow PR
No dependencies. Workdir: packages/nax.

Deletes `pushLedger` and its call in `prMode` (nax#2629).

### US-005: Model ruling read
No dependencies. Workdir: packages/nax.

Adds `bot.models.rulings`, the `"rulings"` role in `botModel`, `buildBotRulingReadPrompt`, and `botRulingReadOp`
with its reply parser.

### US-006: Record PR rulings
Depends on US-001, US-002, US-005. Workdir: packages/nax.

Adds `src/bot/rulings.ts` (`recordPrRulings`) as described in Design "Recording rulings".

### US-007: Bot review records rulings and re-checks item findings
Depends on US-006. Workdir: packages/nax.

`runBotReview` calls `recordPrRulings` on a marked, trusted PR; `triage` adds open `w-` finding/ruling threads to
`earlier`; `postEarlier` echoes a bot `fixed` ruling on them; the artifact gains the `rulings` counts.

### US-008: Bot fix readies a workflow draft
Depends on US-006. Workdir: packages/nax.

Adds `src/bot/workflow-ready.ts` (`workflowPrReadiness`); `runBotFix` calls `recordPrRulings`; `readyStep` uses
the workflow rule on a marked PR and posts the evidence comment; `WORKFLOW_PR_HOLD` is deleted.

### US-009: Incremental bot review on a workflow PR
Depends on US-002, US-007. Workdir: packages/nax.

`runBotReview` picks the range from the head marker as described in Design "Incremental bot review";
`PrReviewInput` gains `rangeBase` and `conversationOnly`; `buildBotPrReviewPrompt` gains the conversation-only
variant.

### US-010: Shared review checklist
No dependencies. Workdir: packages/nax.

Adds `WORKFLOW_DESIGN_DECISIONS_ITEM` to `workflow-quality-checklist.ts`; the bot prompt replaces its item 6 with
it and embeds `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION`; the branch prompt's remit gains
it.

### US-011: Bot review coverage retry
Depends on US-009, US-010. Workdir: packages/nax.

`BotPrReviewInput` gains `requiredFiles`, `repoRoot` and `range`; the op's retry validates coverage;
`runPrReview` passes `reviewRequiredFiles` of the package's changed paths; the summary lists unread files.

### US-012: Promote counts PR rulings
Depends on US-001, US-002. Workdir: packages/nax.

`nax workflow promote` reads the PR's settled own `w-` threads (through `classifyItemThreads`) and merges them with
the sidecar entries as described in Integration.

### Context Files

**US-001**
- `packages/nax/src/forge/trust.ts` — `hasWriteAccess` and `classifyPrTrust` today
- `packages/nax/src/forge/threads.ts` — GitLab note mapping
- `packages/nax/src/forge/pr-types.ts` — `PrComment`
- `packages/nax/src/forge/index.ts` — barrel

**US-002**
- `packages/nax/src/forge/marker.ts` — key grammar, `withNaxBotMarker`, `parseNaxBotMarker`, `ownComments`
- `packages/nax/src/workflow/pr-body.ts` — `openItemLine`
- `packages/nax/src/workflow/decisions-sidecar.ts` — `DISPOSITIONS`, `DecisionEntry`
- `packages/nax/src/workflow/pr-body-safe.ts` — `safeInline`

**US-003**
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv` steps
- `packages/nax/src/workflow/feature-machine.ts` — `FeatureSteps`
- `packages/nax/src/workflow/finalize.ts` — `publish`, `prMode`, `finishPr`
- `packages/nax/src/workflow/open-items.ts` — `buildOpenItems`

**US-004**
- `packages/nax/src/workflow/finalize.ts` — `prMode`, `pushLedger`

**US-005**
- `packages/nax/src/operations/bot-checks-extract.ts` — fast-tier complete op precedent
- `packages/nax/src/config/schemas-bot.ts` — `bot.models`
- `packages/nax/src/bot/models.ts` — `botModel`
- `packages/nax/src/operations/index.ts` — barrel
- `packages/nax/src/prompts/index.ts` — barrel

**US-006**
- `packages/nax/src/workflow/item-threads.ts` — created by US-002, used here
- `packages/nax/src/forge/access.ts` — created by US-001, used here
- `packages/nax/src/operations/bot-ruling-read.ts` — created by US-005, used here
- `packages/nax/src/workflow/promote.ts` — `tickChecklist`, `editBodyArgv`
- `packages/nax/src/forge/comments.ts` — `replyToThread`, `resolveThread`, `postPrComment`

**US-007**
- `packages/nax/src/bot/review-run.ts` — `runBotReview`, `triage`
- `packages/nax/src/bot/post.ts` — `postEarlier`, `effectiveEarlier`, artifact
- `packages/nax/src/bot/rulings.ts` — created by US-006, used here
- `packages/nax/src/bot/render-comments.ts` — earlier replies

**US-008**
- `packages/nax/src/bot/fix-report.ts` — `readyStep`
- `packages/nax/src/bot/fix-run.ts` — `runBotFix`, `triage`
- `packages/nax/src/bot/rulings.ts` — created by US-006, used here
- `packages/nax/src/workflow/promote.ts` — `evidenceComment`, `markReadyArgv`

**US-009**
- `packages/nax/src/bot/review-run.ts` — `reviewEnvironment`
- `packages/nax/src/bot/review-step.ts` — `runPrReview`, `PrReviewInput`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — prompt
- `packages/nax/src/bot/checkout.ts` — `PrCheckout`

**US-010**
- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — shared module
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `CHECKLIST`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — remit

**US-011**
- `packages/nax/src/operations/bot-pr-review.ts` — op and retry
- `packages/nax/src/operations/workflow-branch-review.ts` — coverage retry precedent
- `packages/nax/src/bot/review-step.ts` — `runPrReview`
- `packages/nax/src/workflow/review-coverage.ts` — `reviewRequiredFiles`
- `packages/nax/src/bot/render-comments.ts` — summary

**US-012**
- `packages/nax/src/cli/workflow-promote.ts` — checks and actions
- `packages/nax/src/workflow/item-threads.ts` — created by US-002, used here
- `packages/nax/src/workflow/decisions-sidecar.ts` — `mergeDecisions`, `DecisionEntry`

### Creates

**US-001**
- `packages/nax/src/forge/access.ts`
- `packages/nax/test/unit/forge/access.test.ts`

**US-002**
- `packages/nax/src/workflow/item-threads.ts`
- `packages/nax/test/unit/workflow/item-threads.test.ts`

**US-003**
- `packages/nax/src/workflow/item-threads-post.ts`
- `packages/nax/test/unit/workflow/item-threads-post.test.ts`

**US-005**
- `packages/nax/src/prompts/builders/bot-ruling-builder.ts`
- `packages/nax/src/operations/bot-ruling-read.ts`
- `packages/nax/test/unit/operations/bot-ruling-read.test.ts`

**US-006**
- `packages/nax/src/bot/rulings.ts`
- `packages/nax/test/unit/bot/rulings.test.ts`

**US-008**
- `packages/nax/src/bot/workflow-ready.ts`
- `packages/nax/test/unit/bot/workflow-ready.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/forge/threads.test.ts` — GitLab thread comments are compared with deep equality on `{ id, kind, author, body, createdAt }`; they now also carry `authorId` from the note author's `id`. The invariant: every other field is unchanged and GitHub comments carry no `authorId`.
- `packages/nax/test/unit/forge/threads-comments.test.ts` — GitLab note fixtures and expectations gain the author `id` and `authorId`; the invariant: ordering and every other field are unchanged.

**US-003**
- `packages/nax/test/unit/workflow/finalize.test.ts` — body assertions that compare the whole draft or final PR body now see the head marker line after the workflow marker. The invariant: the rest of the body is unchanged.

**US-004**
- `packages/nax/test/unit/workflow/finalize.test.ts` — the test asserting a second `commitAndPush` after the approval ("Ledger push failed" warning) and the call-order expectations that include a post-approval `ledger`/`push` pair are replaced: after an approval there is no further `commitLedger` or `commitAndPush` call. The invariant: the pre-CI ledger commit and push are unchanged.

**US-007**
- `packages/nax/test/integration/bot/review-run.test.ts` — triage expectations that `earlier` holds only own `f-` threads now also accept own open `w-` threads of kind finding or ruling on marked PRs. The invariant: unmarked PRs see exactly today's `earlier`.

**US-008**
- `packages/nax/test/integration/bot/fix-report.test.ts` — the case expecting `readyHeld: "nax workflow PR: promote it with nax workflow promote"` now expects the workflow readiness result for that fixture (no item threads and an unticked checklist line: not ready, reason names the item without a thread). The invariant: an unmarked PR behaves as today.
- `packages/nax/test/integration/bot/fix-graph.test.ts` — same: the marked-PR expectation of the `WORKFLOW_PR_HOLD` text becomes the workflow readiness reason. The invariant: the graph's step order is unchanged.
- `packages/nax/test/unit/bot/fix-summary.test.ts` — the fixture's `readyHeld` string is an example value; it is changed to a workflow readiness reason. The invariant: `Kept as draft: <readyHeld>` is still rendered verbatim.

**US-010**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — assertions on the checklist section's exact text now see item 6 as `WORKFLOW_DESIGN_DECISIONS_ITEM` followed by the quality checklist and enumeration instruction. The invariant: items 1-5, the task and the JSON contract are unchanged.

### Seams

- US-006 → US-007, US-008: `recordPrRulings` is called from `runBotReview` and `readyStep`/`runBotFix` (seam ACs in US-007 and US-008).
- US-002 → US-003, US-006, US-012: `classifyItemThreads`, `renderItemOpener`, `headMarkerLine`, `parseHeadMarker` are called from `postItemThreads`, `recordPrRulings`, `buildWorkflowPrBody` and promote.
- US-003: `postItemThreads` is called from `publishStep` through `buildFeatureEnv` (seam AC in US-003).
- US-005 → US-006: `botRulingReadOp` is the `readModel` the bot entry points pass (seam AC in US-007).
- US-001 → US-006: `hasWriteAccess` is called by `recordPrRulings` per replier.

## Acceptance Criteria

### US-001

- [unit] `hasWriteAccess` is importable from `@/forge` and, on GitHub, returns true when `gh api repos/<repo>/collaborators/<login>/permission` answers `permission` `admin` or `write`.
- [unit] On GitHub, `hasWriteAccess` returns false when the permission is `read`.
- [unit] On GitLab, `hasWriteAccess(ref, { login, id: 7 })` calls `projects/<encoded>/members/all/7` and returns true for `access_level` 30.
- [unit] On GitLab, `hasWriteAccess` returns false when the members call fails with stderr containing `404`.
- [unit] On GitLab, `hasWriteAccess` with no `id` throws a `NaxError` with code `FORGE_RESPONSE_UNPARSEABLE`.
- [unit] `hasWriteAccess` throws a `NaxError` when the GitHub reply has no `permission` string.
- [unit] `classifyPrTrust` still returns `trusted: true` with reason `author has write access` for an author with write access who is not the current user.
- [unit] `classifyPrTrust` still returns `trusted: false` with a reason starting `could not read author permissions:` when the permission call fails.
- [unit] `listReviewThreads` on GitLab returns comments whose `authorId` equals each note's `author.id`.
- [unit] `listPrComments` on GitLab returns comments whose `authorId` equals each note's `author.id`.
- [unit] `listReviewThreads` on GitHub returns comments with `authorId` undefined.

### US-002

- [unit] `itemThreadKey("_run:cv1")` returns `w-_run:cv1`.
- [unit] `renderItemOpener` for an item `{ id: "B3", kind: "finding", severity: "important", issue: "x" }` returns a body whose first line is `Open item **B3** (finding): x` and whose last line is the reply instruction from Design.
- [unit] `parseItemOpener` of a `renderItemOpener` body returns `{ itemId, kind }` equal to the item's id and kind.
- [unit] `parseRulingKeyword("waive: flaky upstream")` returns `{ disposition: "waived", reason: "flaky upstream" }`.
- [unit] `parseRulingKeyword("WAIVE:   ")` returns null.
- [unit] `parseRulingKeyword("fixed abc1234 — moved the guard")` returns `{ disposition: "fixed", sha: "abc1234", reason: "moved the guard" }`.
- [unit] `parseRulingKeyword("fixed")` returns null (no sha).
- [unit] `parseRulingKeyword("Confirm")` returns `{ disposition: "confirmed", reason: "confirmed" }`.
- [unit] `parseRulingKeyword("override: product decided")` returns `{ disposition: "overridden", reason: "product decided" }`.
- [unit] `parseRulingKeyword("verified: ran the smoke suite")` returns `{ disposition: "verified", reason: "ran the smoke suite" }`.
- [unit] `parseRulingKeyword("\n\n  confirm\nmore text")` reads only the first non-empty line and returns a `confirmed` ruling.
- [unit] `parseRulingKeyword("I think this is fine")` returns null.
- [unit] `renderRulingEcho({ itemId: "B3", disposition: "waived", reason: "ok", by: "alice" })` returns a body whose lines are `Recorded: waived — ok`, `By @alice`, `To change it, reply on this thread.`
- [unit] `parseRulingEcho("wr-waived-B3", body)` of that echo returns the same ruling with `by: "alice"`.
- [unit] `parseRulingEcho` of a `fixed` echo with first line `Recorded: fixed in abc1234 — gone` returns `sha: "abc1234"`.
- [unit] `headMarkerLine(sha)` with a 40-hex sha returns `<!-- nax-workflow-head:<sha> -->`, and `parseHeadMarker` of a body containing it returns that sha.
- [unit] `parseHeadMarker` returns undefined when the line's sha is not 40 hex characters.
- [unit] `classifyItemThreads` ignores a thread whose opener has a `w-` marker but is authored by someone other than `login`.
- [unit] `classifyItemThreads` returns `settled` for an own `w-B3` thread whose last own comment is a `wr-waived-B3` echo and which has no later comments.
- [unit] `classifyItemThreads` returns `open` with `replies` holding only the non-own comments after the last own comment.
- [unit] `classifyItemThreads` returns `open` for an own `w-` thread whose last own comment is an echo followed by a reply from another author (the reply is in `replies`).

### US-003

- [unit] `postItemThreads` posts one inline comment per open item that has `file` and `line`, at that file and line, with body `withNaxBotMarker(renderItemOpener(item), "w-<id>")`.
- [unit] `postItemThreads` posts an item without a location inline at line 1 of `.nax/features/<feature>/prd.json`.
- [unit] When the inline post throws, `postItemThreads` posts the same body as a top-level comment through `postPrComment`.
- [unit] `postItemThreads` posts no thread for the `_run:ci` item.
- [unit] `postItemThreads` posts nothing for an item that already has an own `w-<id>` thread.
- [unit] `postItemThreads` skips an item whose id does not fit the marker key grammar, logs a warning and returns it counted in `skipped`.
- [unit] For an own open `w-` thread whose item is no longer in `buildOpenItems`, `postItemThreads` replies with a `fixed` echo naming `head` and reason `no longer open at <sha7>`, then resolves the thread.
- [unit] When `listReviewThreads` throws, `postItemThreads` posts nothing, logs a warning and returns `failed: 1`.
- [unit] A failed post of one item is counted in `failed` and the next item is still posted.
- [unit] `publishStep` calls `env.steps.postItemThreads` once with the publish URL and the head when publish returns `draft` with a URL.
- [unit] `publishStep` does not call `env.steps.postItemThreads` when publish returns `local-only`.
- [unit] `publishStep` returns the same patch when `env.steps.postItemThreads` throws (logged) as when it succeeds.
- [unit] `publishStep` with `env.steps.postItemThreads` undefined behaves exactly as today.
- [integration] `buildFeatureEnv` returns steps whose `postItemThreads` calls `postItemThreads` with the feature context's project dir (stub the forge deps; trigger `env.steps.postItemThreads`; assert the stub's `listReviewThreads` ran in `fc.projectDir`).
- [unit] `buildWorkflowPrBody` with `head` set to a 40-hex sha writes `headMarkerLine(head)` on the line after `NAX_WORKFLOW_PR_MARKER`.
- [unit] `buildWorkflowPrBody` without `head` writes no head marker line.
- [unit] `publish` in `pr` mode passes the pushed head to both the draft body and the final body.

### US-004

- [unit] `publish` in `pr` mode with an approving advisor calls `commitAndPush` exactly once (the pre-CI push).
- [unit] `publish` in `pr` mode with an approving advisor calls `commitLedger` exactly once, before the push.
- [unit] `publish` in `pr` mode with an approving advisor returns outcome `ready` with the CI outcome observed on the pushed head.
- [unit] `publish` in `pr` mode with a held advisor still calls `commitAndPush` exactly once and returns `draft`.

### US-005

- [unit] Constructing the config with `bot.models.rulings` unset yields `botModel(config, "rulings")` equal to `"fast"`.
- [unit] With `bot.models.rulings` set to `"balanced"`, `botModel(config, "rulings")` returns `"balanced"`.
- [unit] `buildBotRulingReadPrompt` puts each item's id, kind, issue and each reply's id, author and body inside fences that the reply text cannot terminate, under a heading saying the content is untrusted data.
- [unit] `buildBotRulingReadPrompt` asks for one JSON object `{"rulings":[{"id","disposition","reason","quote","sha"}]}` where `disposition` is one of `fixed`, `waived`, `confirmed`, `overridden`, `verified` or `none`.
- [unit] `buildBotRulingReadPrompt` tells the model to answer `none` when the reply's meaning is not clear.
- [unit] `botRulingReadOp` is importable from `@/operations`, has `kind` `complete`, and takes its model from `input.model`.
- [unit] `botRulingReadOp.parse` of a fenced JSON reply returns the rulings array (parsed with `parseLLMJson`).
- [unit] `botRulingReadOp.parse` drops an entry whose id is not one of the input item ids.
- [unit] `botRulingReadOp.parse` returns null for a reply with no JSON object.

### US-006

- [unit] A keyword reply `waive: ok` from a writer on an open item thread yields one `wr-waived-<id>` echo reply and one `resolveThread` call.
- [unit] A keyword reply from an author for whom `hasWriteAccess` returns false yields no echo and no model call.
- [unit] When `hasWriteAccess` throws for an author, that author's reply is not a ruling and a warning is logged.
- [unit] `hasWriteAccess` is called once per login per `recordPrRulings` call, however many replies that login wrote.
- [unit] With two writer replies on one item, the newer keyword reply's ruling is recorded.
- [unit] A writer reply with no keyword goes to one `readModel` call that holds every such item.
- [unit] A model ruling whose `quote` occurs in the reply (whitespace collapsed) is recorded with `by` set to the reply's author.
- [unit] A model ruling whose `quote` occurs in no reply of that item is not recorded, and an ask comment keyed `wq-<id>-<replyId>` is posted in the thread.
- [unit] A model `fixed` ruling whose sha does not occur in the quoted reply is not recorded.
- [unit] A model ruling `none` is not recorded and an ask is posted.
- [unit] An ask with an existing own `wq-<id>-<replyId>` comment in the thread is not posted again.
- [unit] When `readModel` returns null, keyword rulings in the same call are still recorded and no ask is posted.
- [unit] More than 20 model-read items: `readModel` receives the first 20 in item order and the rest stay `open`.
- [unit] When the echo reply throws, the item stays in `open`, no `resolveThread` call is made for it, and `failed` is 1.
- [unit] When `resolveThread` throws after an echo, the item is in `settled` and a warning is logged.
- [unit] A settled thread that is unresolved gets one `resolveThread` call and no new echo.
- [unit] After recording, the PR body is edited once with `tickChecklist` of one entry per settled item (kind from `sidecarKindFor`, `sha` set for `fixed`).
- [unit] When the ticked body equals the current body, no body edit is made.
- [unit] When the body edit throws, the outcome is still returned and a warning is logged.

### US-007

- [integration] `runBotReview` on a trusted PR whose body has `NAX_WORKFLOW_PR_MARKER` calls `recordPrRulings` once, before `runPrReview` (stub both; assert the order of calls).
- [integration] `runBotReview` on a PR without the workflow marker does not call `recordPrRulings`.
- [integration] `runBotReview` on an untrusted marked PR does not call `recordPrRulings`.
- [integration] `runBotReview` passes `recordPrRulings` a `readModel` that calls `botRulingReadOp` with `botModel(config, "rulings")`.
- [unit] `triage` on a marked PR adds an own open `w-` thread whose opener kind is `finding` to `earlier`.
- [unit] `triage` does not add an own `w-` thread whose opener kind is `advisor` or `cannot-verify` to `earlier`.
- [unit] An earlier verdict `fixed` on a `w-B3` thread posts a `wr-fixed-B3` echo naming the reviewed head sha and resolves the thread.
- [unit] An earlier verdict `withdrawn` on a `w-B3` thread posts the plain earlier reply and does not resolve the thread.
- [unit] An earlier verdict `open` on a `w-` thread leaves it in the agreed items for `nax bot fix`, as for an `f-` thread.
- [unit] `bot-review.json` written by a marked-PR review carries `rulings` with the `recorded`, `open` and `asked` counts from `recordPrRulings`.

### US-008

- [unit] `workflowPrReadiness` returns `{ ready: false, reason: "CI failed: <detail>" }` when CI is `failed`, whatever the items.
- [unit] `workflowPrReadiness` returns not ready with reason `1 open item(s): B3` when one state is `open`.
- [unit] `workflowPrReadiness` returns not ready with reason `1 item(s) without a thread: _run:cv2` when the body has an unticked `- [ ] **_run:cv2**` line and no settled state for it.
- [unit] `workflowPrReadiness` ignores an unticked `_run:ci` line.
- [unit] `workflowPrReadiness` returns `{ ready: true }` when CI is green, every state is settled and every unticked line id has a settled state.
- [integration] `readyStep` on a marked draft calls `recordPrRulings`, then `waitForChecks`, then `workflowPrReadiness` (stub all three; assert order).
- [integration] `readyStep` on a marked draft that is ready posts `evidenceComment` of the settled entries as one comment, then runs `markReadyArgv`, and returns `markedReady: true`.
- [integration] `readyStep` on a marked draft that is not ready returns `markedReady: false` with `readyHeld` equal to the readiness reason, and makes no forge write.
- [integration] When the evidence comment fails, `readyStep` does not mark the PR ready and returns `readyHeld` starting `evidence comment failed:`.
- [integration] `readyStep` on an unmarked draft behaves as today (CI green only).
- [integration] `runBotFix` on a trusted marked PR calls `recordPrRulings` before the fix step.

### US-009

- [integration] `runBotReview` on a trusted marked PR whose head equals the head marker sha calls `runPrReview` with `conversationOnly: true`.
- [integration] `runBotReview` on a trusted marked PR whose head marker sha is an ancestor of a later head calls `runPrReview` with `rangeBase` equal to that sha.
- [integration] `runBotReview` on a trusted marked PR whose head marker sha is not an ancestor of the head calls `runPrReview` with `rangeBase` equal to the merge base.
- [integration] `runBotReview` on an untrusted marked PR ignores the head marker and reviews from the merge base.
- [unit] `runPrReview` with `rangeBase` writes the package from `rangeBase` and puts `<rangeBase>..HEAD` in the prompt.
- [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` says the code at this head was reviewed by the workflow's branch review and that findings may come only from what a thread, comment or earlier finding points at.
- [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` names no range and no package path.
- [unit] `runPrReview` with `conversationOnly: true` writes no review package.

### US-010

- [unit] `WORKFLOW_DESIGN_DECISIONS_ITEM` is importable from `@/prompts` and names ADRs or architecture docs and the rule for a PR that edits a design doc.
- [unit] `buildBotPrReviewPrompt` output contains `WORKFLOW_DESIGN_DECISIONS_ITEM` as checklist item 6.
- [unit] `buildBotPrReviewPrompt` output contains `WORKFLOW_QUALITY_CHECKLIST` and `WORKFLOW_ENUMERATION_INSTRUCTION` after the checklist and before the untrusted content section.
- [unit] `buildBotPrReviewPrompt` in static mode still contains `WORKFLOW_QUALITY_CHECKLIST`.
- [unit] `buildWorkflowBranchReviewPrompt` output lists `WORKFLOW_DESIGN_DECISIONS_ITEM` as a bullet under "Your remit".

### US-011

- [unit] `botPrReviewOp`'s retry asks again with `buildWorkflowBranchCoverageRetry(range, missing)` when the reply answers every thread, comment and earlier id but `inspectedFiles` misses a required file.
- [unit] `botPrReviewOp`'s retry asks with the triage retry, not the coverage retry, when ids are missing.
- [unit] `botPrReviewOp`'s retry does not ask again for coverage when `requiredFiles` is empty or absent.
- [unit] After the retry budget, a verdict that still misses files is returned, findings included.
- [unit] `runPrReview` passes `requiredFiles` equal to `reviewRequiredFiles` of the package's changed paths, with `repoRoot` the checkout and `range` the prompt's range.
- [unit] `runPrReview` with `conversationOnly: true` passes empty `requiredFiles`.
- [unit] `botPrStaticReviewOp` validates coverage the same way as `botPrReviewOp`.
- [unit] The review summary lists each required file the final verdict did not inspect under a line starting `Not read by the review:`.

### US-012

- [unit] `nax workflow promote` passes the `items-ruled` check when every open item has either a sidecar entry or a settled own `w-` thread on the PR.
- [unit] `nax workflow promote` fails the `items-ruled` check naming the item ids with neither.
- [unit] When the sidecar and a settled thread both rule one id, the tick and the evidence comment use the sidecar entry.
- [unit] A settled thread ruling becomes a `DecisionEntry` with kind `sidecarKindFor` of the opener's kind, the echo's disposition and reason, and its sha for `fixed`.
- [unit] When reading the PR threads fails, `items-ruled` counts sidecar entries only and the report names the failure.
- [unit] Threads authored by a login other than the current user are not counted as rulings.
