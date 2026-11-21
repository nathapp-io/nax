# SPEC: bot finding origin: gaps in the bot's own fixes stop holding readiness, and the PR reviewer gets a severity scale

## Summary

`nax bot review` asks the reviewer one more fact per finding when its range holds the bot's own fix pushes: the finding's **origin**.

- `pr`: the problem is in the pull request's own change.
- `fix-regression`: a nax bot fix push broke behaviour that worked before that push.
- `fix-gap`: a further gap in code a nax bot fix push added to close an earlier item, where the behaviour before that push was the same or worse.

A `fix-gap` finding does not hold readiness. It is posted the way a finding outside the blocking trigger set already is: no inline thread, one line under `### Residual findings (not blocking)` in the review summary. `pr` and `fix-regression` findings block exactly as they do today.

nax checks the claim against a fact it already has. Part 1 (#2992) blames every finding's anchor line against the bot's push ledger (`computeLineage`). A `fix-gap` claim stands only when that lineage names a bot push for the finding's line; any other `fix-gap` claim reads as `pr`.

The bot PR review prompt also gets a severity scale, as the story reviewer has one. Each severity is defined by what the code does, not by what the label does to readiness. The `normal` trigger class is grounded in the repository: reachable in ordinary use of the product, as this repository documents or configures it.

This is #2987 part 2, levers A and B. #2987 stays open for the advisor routing of chains (lever C).

## Motivation

Part 1 (#2992, v0.92.8) gave the agents the facts: the reviewer sees which commits in its range came from which bot fix push, and every finding carries its lineage. On the next real workflow PR on `gpt-6.2-sol[high]`, the chain ran anyway (#2987 comment of 2026-11-20). Nothing in the blocking decision used the facts, so a finding in code a fix had just added blocked like a finding in the original change.

| Bot review of | Latest push alone | Blocking |
|---|---|---|
| push 0 | +10 / -3 | main batch |
| fix push 1 | +356 / -130 | 2 Important |
| push 2 | +22 / -13 | 3 Important |
| fix push 3 | +247 / -65 | 3 blocking |
| push 4 | +165 / -24 | 2 blocking |

One deploy script grew from 236 to 337 lines as fixes added an env-file parser, staged validation, a per-volume lock and a writer check. Each review found an edge case in the layer the previous fix had added. All of them were classed `trigger: normal`, so all of them blocked. Bot sessions take 10 to 25 minutes each whatever the range size, so wall clock is about rounds x 20 minutes. The PR took about 4.5 hours from spec to ready for a 70-minute run.

Under the origin rule, the lock, writer-check and staged-validation findings read `fix-gap`: the script before fix push 1 had none of that machinery, so its behaviour before the push was the same or worse. The PR would have reached readiness after one or two fix rounds. Each round can then only remove blockers it agreed to, so the loop ends when the agreed work runs out, with no round cap and no human step.

The bot PR review prompt has no severity scale. It offers `"severity": "critical|important|minor"` with no definition, while the story reviewer has one (`workflow-story-review-builder.ts`). The model change from 6.1-sol to 6.2-sol moved the PR reviewer's own calibration: Important findings per long PR went from 0-2 to 8-22 (#2987 comment of 2026-11-20). A scale and a repository-grounded `normal` give the reviewer facts to calibrate against. They apply to every bot review, not just fix rounds.

## Design

### Approach

The origin is a reviewer judgement backed by one deterministic fact, the lineage. It is carried exactly the way the trigger class is (US-001 of #2992):

1. The reply schema gains `origin` and `originEvidence` per finding, asked only when the prompt lists in-range bot pushes (US-002).
2. `settleFindingOrigins` checks each `fix-gap` claim against the lineage, and against the bot's own inline threads, before anything is posted or recorded (US-003).
3. The shared predicate `isBlockingFinding` returns `false` for `fix-gap` (US-001). Every site that already asks it agrees with no further change: review posting (`collectSummaryOnly`, `blockingFindingCount`), push-worthiness (`hasPushWorthyItem`), readiness (`blockingKeys` in `fix-report.ts`), carried findings (`carried-findings.ts`, `post-carried.ts`, `carried-hold.ts`), the chain notice (`convergence-summary.ts`) and `nax workflow status` (`readBlockingFindingThreads`).
4. A non-`pr` origin is one fact line on an inline thread and one clause on a residual summary line, so a later run reading only the PR sees it (US-001).

The rule is fixed: `fix-gap` never blocks. There is no config key and no per-PR ruling for it (see Out of Scope).

The prompt text is facts, not orders. It defines the classes and asks for them, as the trigger classes already are. It says nothing about what a class or a severity does to readiness, and nothing about how to fix.

A reply may state an origin on a review that was not asked for one: a full review, or one whose prompt lists no bot push. The parser keeps it, and `settleFindingOrigins` checks it exactly as it checks an asked one. A `fix-gap` claim then stands only on a line lineage attributes to a bot push, which is the same fact an asked claim needs.

A `fix-gap` claim also never stands on a finding the bot already posted as an inline thread. A `fix-gap` finding gets no thread, so an own thread for the key means the finding was posted while it blocked. Re-raising it, even with unchanged wording on a line a later fix touched, keeps it blocking until it is fixed or ruled on. Without this, an unfixed original blocker could pass the lineage check on its own re-raise.

Two more readers follow with no change because they ask `isBlockingFinding`: `fix-carried.ts` and `fix-facts.ts`. A `fix-gap` item that reaches a fix session alongside push-worthy work gets the existing not-blocking fact line. `bot-review.json` is read back without a field whitelist (`fix-input.ts`), so `origin` survives into `hasPushWorthyItem` and readiness.

**Composition.** `isBlockingFinding` applies three tests in this order, and a finding blocks only when it passes all three:

1. severity is `critical` or `important`;
2. origin is not `fix-gap` (an absent origin reads `pr`);
3. trigger is in the effective blocking trigger set (an absent trigger reads `normal`).

The order is observable only in that every combination needs all three. A `minor` `fix-regression` does not block. An `important` `pr` `adversarial` finding under the default set does not block. An `important` `fix-gap` `normal` finding does not block.

### Integration

Symbols this feature only reads:

- `packages/nax/src/bot/lineage.ts`: `computeLineage(input, deps): Promise<LineageResult>`, `LineageResult { lineage: ReadonlyMap<string, FindingLineage>; unknown: ReadonlySet<string>; unreachable: number }`. A key is in `lineage` only when a reachable recorded push wrote that finding's anchor line, so every entry has `generation >= 1`. A key whose blame or ancestry read failed is in `unknown` instead. A finding with no `file` or `line` is in neither.
- `packages/nax/src/bot/push-ledger.ts`: `FindingLineage { generation; parents; pushSha }`, `BotPushEntry`.
- `packages/nax/src/bot/render.ts`: `findingKey({ file, issue })`, the key both the lineage map and `agreedItems` use.
- `packages/nax/src/bot/review-run.ts`: the `post` node of `BOT_REVIEW_GRAPH` computes `lineage = await reviewLineage(env.post, state.verdict)` and then calls `_botReviewDeps.postPrReview({ ...env.post, verdict, ...(lineage === undefined ? {} : { lineage }) })`. Unchanged.
- `packages/nax/src/bot/review-blocking.ts`: `hasPushWorthyItem(env: BotFixEnv): boolean`, which asks `isBlockingFinding` of each agreed `finding` item. Unchanged.
- `packages/nax/src/bot/blocking-threads.ts`: `readBlockingFindingThreads(input)`, which filters own threads with `isBlockingFinding(readFindingThreadFacts(text), effective.triggers)`. Unchanged.
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts`: `pushSection(input)` renders `## Earlier nax bot fix pushes in this range` only when `input.incrementalSince !== undefined`, `input.conversationOnly` is not true, and `input.botPushes` yields at least one line. Unchanged.
- `packages/nax/src/operations/bot-pr-review-reply.ts`: `MAX_TRIGGER_EVIDENCE_CHARS = 300` and `triggerEvidence(value)` (a non-empty trimmed string capped at 300, else `undefined`).

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `packages/nax/src/workflow/blocking-findings/index.ts` (new exports).
  - Target: `export const FINDING_ORIGINS = ["pr", "fix-regression", "fix-gap"] as const;`, `export type FindingOrigin = (typeof FINDING_ORIGINS)[number];`, and `export function parseFindingOrigin(value: unknown): FindingOrigin | undefined`, which returns the matching member or `undefined` for anything else.
- `isBlockingFinding` (same file).
  - Baseline: `isBlockingFinding(finding: { severity; trigger? }, blocking): boolean`, true when severity is critical or important and `finding.trigger ?? "normal"` is in `blocking`.
  - Target: `isBlockingFinding(finding: { severity; trigger?; origin?: FindingOrigin }, blocking): boolean`, applying the three tests in the Composition order above. The parameter list is unchanged.
- `readFindingThreadFacts` (same file).
  - Baseline: returns `{ severity, trigger }`.
  - Target: returns `{ severity: WorkflowSeverity; trigger: FindingTrigger; origin: FindingOrigin }`. `origin` is read from the first line that starts `Origin:`: the text after the prefix and before the first ` - `, trimmed, passed to `parseFindingOrigin`. No such line, or an unknown value, reads `"pr"`.
- `firstIssueLine` (same file).
  - Baseline: drops lines starting `Trigger:` or `Lineage:`.
  - Target: also drops lines starting `Origin:`.
- `PrFinding` (`packages/nax/src/operations/bot-types.ts`).
  - Target: gains `readonly origin?: FindingOrigin;` and `readonly originEvidence?: string;`. Absent origin means `pr`.
- `findings()` (`packages/nax/src/operations/bot-pr-review-reply.ts`).
  - Baseline: sets `trigger: parseFindingTrigger(source.trigger)` and optional `triggerEvidence`.
  - Target: also sets `origin` to `parseFindingOrigin(source.origin)` only when that returns a value, and `originEvidence` to the same trimmed, 300-character-capped form `triggerEvidence` uses, only when non-empty. A finding with no known origin carries neither field.
- `TASK_CONTRACT` and `replyTask` (`packages/nax/src/prompts/builders/bot-pr-review-builder.ts`).
  - Baseline: one constant string; `replyTask(conversationOnly)`.
  - Target: the contract is composed per prompt. These lines are added or changed. Every other line of the contract keeps its exact text and order.
    - After the line `Set "decision" on a finding only when it breaks a listed project decision. The "decision" field is optional.` comes the new line `Severity: "critical" = unsafe behaviour or lost data a user or caller can reach; "important" = other wrong behaviour a user or caller can reach, a changed behaviour no test would catch, or a break of a listed project rule; "minor" = worth noting.` It is in every contract, conversation-only included.
    - The `normal` definition line becomes `normal: reachable in ordinary use of the product, as this repository documents or configures it.`
    - The doc comment on `replyTask`, which says a conversation-only task is byte-for-byte the text from before the approval line existed, is reworded: that task now also carries the `Severity:` line and the new `normal` definition.
    - When `pushSection(input)` renders, the four lines below follow the `manual:` definition line, and the finding shape in the JSON example gains `, "origin": "pr|fix-regression|fix-gap", "originEvidence": "..."` directly after `"triggerEvidence": "..."`. When it does not render, neither appears.

      ```
      Name each finding's origin with "origin" and the one detail that shows it with "originEvidence". The origins are:
      pr: the problem is in the pull request's own change.
      fix-regression: a push listed under "Earlier nax bot fix pushes in this range" broke behaviour that worked before that push.
      fix-gap: a further gap in code a push listed under "Earlier nax bot fix pushes in this range" added to close an earlier item, where the behaviour before that push was the same or worse.
      ```
- `FindingWithTrigger` and `CarriedSummary` (`packages/nax/src/bot/render-comments.ts`).
  - Target: both gain `readonly origin?: FindingOrigin;` and `readonly originEvidence?: string;`. `residualItem` takes `CarriedSummary`, so the residual list reads the fields from there. A carried finding (`offLineFinding` in `post-carried.ts`) is built with no origin, so `### Still open from an earlier review` lines never show one.
- `factLines` / `renderFindingComment` (same file).
  - Baseline: a `Trigger:` line, then a `Lineage:` line.
  - Target: when `origin` is set and is not `"pr"`, an `Origin: <origin>` line (plus ` - <originEvidence>` through `safeText(..., EVIDENCE_LIMIT)` when evidence is present) comes directly after the `Trigger:` line and before any `Lineage:` line. With no origin, or origin `"pr"`, the body is byte-identical to today's.
- `residualItem` (same file, used for `### Residual findings (not blocking)` and `### Still open from an earlier review` in `renderReviewSummary`).
  - Baseline: `- **Important** \`a.ts\`:3: <issue> (trigger <trigger>[ - <evidence>])`.
  - Target: when `origin` is set and is not `"pr"`, the parenthesis gains `; origin <origin>[ - <originEvidence>]` before its closing `)`, with the evidence through `safeText(..., EVIDENCE_LIMIT)`. Otherwise the line is unchanged.
- `AgreedItem` finding variant and `agreedItems` (`packages/nax/src/bot/post.ts`).
  - Target: the variant gains `readonly origin?: FindingOrigin;` and `readonly originEvidence?: string;`. `agreedItems` copies both from the verdict finding when present, like `trigger` and `triggerEvidence`.
- `mergeEarlier` and `withoutFactLines` (same file).
  - Baseline: an earlier own thread re-carried as an agreed finding keeps `trigger` (via `earlierTrigger`) and drops `Trigger:` / `Lineage:` lines from its issue.
  - Target: it also keeps `origin` when the thread body has a line starting `Origin:`, read with `readFindingThreadFacts(body).origin`, and `withoutFactLines` also drops lines starting `Origin:`. A body with no `Origin:` line carries no `origin` field.
- `postPrReview` (same file).
  - Baseline: `persistArtifact(input, ...)` is its first call.
  - Target: its first statement replaces the input's verdict with `settleFindingOrigins(input.verdict, { lineage: input.lineage, ownThreadKeys })`, and every later call in the function reads the settled input.
- `settleFindingOrigins` (new, `packages/nax/src/bot/finding-origin.ts`).
  - Target: `export function settleFindingOrigins(verdict: PrReviewVerdict, facts: { readonly lineage: PostReviewInput["lineage"]; readonly ownThreadKeys: ReadonlySet<string> }): PrReviewVerdict`. It returns a new verdict and never mutates its input. For each finding whose `origin` is `"fix-gap"`, with `key = findingKey(finding)`: when `facts.lineage?.lineage.has(key)` and `!facts.ownThreadKeys.has(key)`, the finding is unchanged. Otherwise the finding's `origin` becomes `"pr"`, its `originEvidence` is dropped, and one `debug` log line names the key. Findings with any other origin, or none, are unchanged.
  - `postPrReview` builds `ownThreadKeys` from `input.own`: the `key` of every entry whose `threadId` is defined. A top-level own comment (summary, carried record, signals) has no `threadId` and is not counted.

`post.ts` is 563 lines against the 600-line source limit, so `settleFindingOrigins` lives in its own file and `post.ts` gains only the calls and the copied fields.

### Failure Handling

| Situation | Behaviour |
|---|---|
| The reply has no `origin`, or an unknown value | The finding carries no `origin` and reads `pr`: it blocks as it does today. |
| A `fix-gap` claim on a finding with no `file` or `line` | `settleFindingOrigins` reads it `pr`. |
| A `fix-gap` claim whose lineage read failed (key in `unknown`) | `settleFindingOrigins` reads it `pr`. |
| A `fix-gap` claim on a line no reachable bot push wrote | `settleFindingOrigins` reads it `pr`. |
| The PR has no push ledger, so `lineage` is `undefined` | Every `fix-gap` claim reads `pr`. |
| A `fix-regression` claim with no lineage (a fix that deleted a guard leaves no blamed line) | Kept as `fix-regression`. It blocks either way. |
| A thread, summary or artifact written before this change | No `Origin:` line and no `origin` field: reads `pr`. |
| An `Origin:` line with an unknown value | Reads `pr`. |
| A reply states an origin on a review that did not ask for one | Kept by the parser (US-002 AC-11 parses with no prompt context) and settled like an asked claim (US-003 AC-1, AC-2). |
| A `fix-gap` claim on a finding whose key already has an own inline thread (posted earlier while it blocked, now re-raised) | `settleFindingOrigins` reads it `pr`, so it still blocks. Its thread is edited in place as any blocking re-raise is, with no `Origin:` line, and it is not listed as residual. |
| A `minor` `fix-gap` finding | Goes to `### Minor findings` as every minor does. That list renders no origin clause. |

## Out of Scope

- Routing a fix-induced chain to the advisor for a design-level ruling (simplify, revert, fail closed, use a library), #2987 lever C. A later spec.
- A config key (`bot.blockingOrigins`) or a per-PR writer ruling (`blocking origins: ...`) that changes which origins block. Build it only if real PRs show `fix-gap` findings that should have blocked.
- Filing a follow-up issue that collects a PR's `fix-gap` residuals. The review summary's residual section is their only home.
- Asking for an origin on a review whose prompt lists no in-range bot push: a full review, a first review, a conversation-only review, or an incremental review with no bot push in range. Such a review is not asked, so its findings normally carry no origin and read `pr`. An origin a reply states anyway is still checked against lineage.
- A deterministic check of `fix-regression` or `pr` claims. Both block, so a wrong claim between them changes no readiness decision.
- Showing a finding's origin to the bot fixer. The fixer already gets each finding's lineage (#2992 US-006), and a `fix-gap` finding alone causes no fix session (`hasPushWorthyItem`).
- Changing the chain notice (`Findings are chasing their own fixes`). It lists blocking findings only, so a `fix-gap` finding leaves it, as a non-blocking trigger class already does.
- Adding an origin field to the carried record (`<!-- nax-bot:carried v1 ... -->`) or to `offLineFinding`. The record holds only blocking findings. A `fix-gap` finding never blocks, and a carried `fix-regression` that reads `pr` still blocks, so no readiness decision changes.
- The sentence `A state loss a caller can reach is a critical or important finding, never minor` in `workflow-quality-checklist.ts`. That checklist is shared with the workflow reviewers. The bot PR reviewer gets both texts: the checklist sets `important` as the floor for a reachable state loss, and the new scale names `critical` for lost data. The two agree that it is never `minor`, and both severities block, so the overlap changes no readiness decision.
- The severity text of the story, branch and acceptance reviewers.
- Moving the bot review or fix model back to `gpt-6.2-sol`. The operator does that after watching real PRs.
- Migrating threads, summaries or artifacts already posted.

## Stories

**US-001: origin vocabulary, blocking predicate and the PR's fact lines.** Workdir: `packages/nax`. No dependencies. Adds `FINDING_ORIGINS`, `FindingOrigin` and `parseFindingOrigin`. `isBlockingFinding` returns `false` for origin `fix-gap`. `readFindingThreadFacts` returns the origin from an `Origin:` line, and `firstIssueLine` drops that line. `renderFindingComment` writes the `Origin:` line and `residualItem` the `origin` clause, both only for a non-`pr` origin.

**US-002: the PR reviewer is asked for an origin and gets a severity scale.** Workdir: `packages/nax`. Depends on US-001. `buildBotPrReviewPrompt` adds the severity line and the grounded `normal` definition to every contract, plus the origin definitions and fields when the prompt lists in-range bot pushes. `PrFinding` gains `origin` and `originEvidence`, and the reply parser fills them.

**US-003: nax checks each fix-gap claim against lineage and own threads before posting.** Workdir: `packages/nax`. Depends on US-001, US-002. Adds `settleFindingOrigins` in `src/bot/finding-origin.ts`. `postPrReview` builds the own thread keys and settles the verdict first. `agreedItems` carries the origin into the review artifact.

**US-004: re-raised and earlier findings, minors, and readiness.** Workdir: `packages/nax`. Depends on US-003. `mergeEarlier` carries an `Origin:` line from an earlier own thread into the agreed item, and `withoutFactLines` drops it from the issue. Pins the posting edge rows of Failure Handling and readiness at `readyStep`.

### Context Files

**US-001**
- `packages/nax/src/workflow/blocking-findings/index.ts` — the vocabulary, predicate and thread reader this story extends.
- `packages/nax/src/bot/render-comments.ts` — `factLines`, `renderFindingComment`, `residualItem`, `renderReviewSummary`.
- `packages/nax/src/bot/blocking-threads.ts` — `readBlockingFindingThreads`, the `nax workflow status` reader AC-20 and AC-21 enter through.
- `packages/nax/test/unit/workflow/blocking-findings.test.ts` — existing predicate and thread-reader tests; new ones go here.
- `packages/nax/test/unit/bot/render-comments.test.ts` — existing renderer tests; new ones go here.

**US-002**
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `TASK_CONTRACT`, `replyTask`, `pushSection`, `buildBotPrReviewPrompt`.
- `packages/nax/src/operations/bot-pr-review-reply.ts` — the `findings()` parser.
- `packages/nax/src/operations/bot-types.ts` — `PrFinding`.
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — existing contract tests; new ones go here.
- `packages/nax/test/unit/operations/bot-pr-review-reply.test.ts` — existing parser tests; new ones go here.

**US-003**
- `packages/nax/src/bot/post.ts` — `postPrReview`, `agreedItems`, `mergeEarlier`, `withoutFactLines`.
- `packages/nax/src/bot/review-run.ts` — the `post` node that computes lineage and calls `postPrReview`.
- `packages/nax/src/bot/review-blocking.ts` — `hasPushWorthyItem`.
- `packages/nax/test/integration/bot/review-run-lineage.test.ts` — drives `runBotReview` with a recorded push and a stubbed blame. The US-003 integration ACs are added here so they reuse its `stubGit` and `summaryComment` scaffolding. AC-15 adds one ancestry answer to its `stubGit` call (the blamed commit is not reachable from the push). No existing assertion in the file changes.
- `packages/nax/test/unit/bot/review-blocking.test.ts` — existing `hasPushWorthyItem` tests; AC-17 and AC-18 go here, built with `makeBotFixEnv`.
- `packages/nax/test/helpers/bot-fix.ts` — `makeBotFixEnv`.

**US-004**
- `packages/nax/src/bot/post.ts` — `mergeEarlier`, `withoutFactLines`, `collectSummaryOnly`.
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, and the private `openFindingHold` / `blockingKeys` it reaches.
- `packages/nax/test/integration/bot/review-run-lineage.test.ts` — the US-004 `runBotReview` ACs are added here, reusing `stubGit`, `summaryComment` and `earlierThread`.
- `packages/nax/test/unit/bot/fix-report.test.ts` — existing `readyStep` tests (425 lines); the US-004 `readyStep` ACs go here.

### Creates

**US-002**
- `packages/nax/test/unit/prompts/bot-pr-review-builder-origin.test.ts` — US-002 AC-5 to AC-10, the origin lines. `bot-pr-review-builder.test.ts` is 578 lines, so these go in their own file by concern.

**US-003**
- `packages/nax/src/bot/finding-origin.ts` — `settleFindingOrigins`.
- `packages/nax/test/unit/bot/finding-origin.test.ts` — `settleFindingOrigins` unit tests.

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/blocking-findings.test.ts` — tests "US-002 AC-10 reads the severity label and the trigger line" and "US-002 AC-11 reads an unlabelled body as important with a normal trigger" assert `readFindingThreadFacts(...)` `toEqual` `{ severity, trigger }` exactly. The reader now also returns `origin`, which is `"pr"` for both bodies (neither has an `Origin:` line). Each expected object gains `origin: "pr"`; severity and trigger expectations stay.

**US-002**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — the `taskContract` constant pins the whole contract text verbatim, and `preChangeTask` and `taskWithApprovalLine` are built from it (used by the tests at lines 218, 488 and 494). It gains the `Severity:` line after the `Set "decision"` line, and its `normal:` line becomes `normal: reachable in ordinary use of the product, as this repository documents or configures it.` Those prompts list no bot push, so no origin line is added. The AC-9 `test.each` row for `normal` changes to the same new definition. Every other row and assertion stays.

**US-003**

None. `postPrReview`'s existing callers pass verdicts with no `origin`, which `settleFindingOrigins` returns unchanged. `agreedItems` adds fields only when an origin is present, so every existing artifact and summary assertion stays.

**US-004**
- `packages/nax/test/integration/bot/review-run-lineage.test.ts` — the `earlierThread(key, line, id)` helper hard-codes its opener body `**Important** (quality): Lock leaks`. It gains an optional fourth `body` parameter defaulting to that text, so the earlier-thread ACs can pass a body with fact lines. Every existing call and assertion stays as it is.

### Seams

- US-001 -> US-003: `isBlockingFinding` reads `origin` from the agreed items US-003 records. US-003 AC-12, AC-13 and AC-15 enter at `runBotReview` and assert the posting outcome, and AC-14 the recorded artifact. AC-17 enters at `hasPushWorthyItem`, the production predicate `fixStep` asks. US-004's `readyStep` ACs enter at the readiness pass, the readiness pass.
- US-002 -> US-003: `PrFinding.origin` from the reply parser is what `settleFindingOrigins` reads. US-003's integration ACs feed it through the stubbed review verdict, exactly as `runPrReview` returns it.

## Acceptance Criteria

### US-001

1. [unit] `FINDING_ORIGINS` equals `["pr", "fix-regression", "fix-gap"]`.
2. [unit] `parseFindingOrigin("fix-gap")` returns `"fix-gap"`.
3. [unit] `parseFindingOrigin(undefined)` returns `undefined`.
4. [unit] `parseFindingOrigin("regression")` returns `undefined`.
5. [unit] `isBlockingFinding` for an `important` finding with trigger `normal` and origin `fix-gap`, under blocking set `["normal", "own-concurrency"]`, returns `false`.
6. [unit] `isBlockingFinding` for an `important` finding with trigger `normal` and origin `fix-regression`, under the same set, returns `true`.
7. [unit] `isBlockingFinding` for an `important` finding with trigger `normal` and no origin, under the same set, returns `true`.
8. [unit] `isBlockingFinding` for a `minor` finding with trigger `normal` and origin `fix-regression`, under the same set, returns `false`.
9. [unit] `isBlockingFinding` for an `important` finding with trigger `adversarial` and origin `pr`, under the same set, returns `false`.
10. [unit] `readFindingThreadFacts` of the body `**Important** (quality): Lock leaks\n\nTrigger: normal - two writers\nOrigin: fix-gap - added by push 1` returns `{ severity: "important", trigger: "normal", origin: "fix-gap" }`.
11. [unit] `readFindingThreadFacts` of a body with no line starting `Origin:` returns `origin` `"pr"`.
12. [unit] `readFindingThreadFacts` of a body whose `Origin:` line reads `Origin: later - x` returns `origin` `"pr"`.
13. [unit] `firstIssueLine` of `Origin: fix-gap - x\nLock leaks` returns `Lock leaks`.
14. [unit] `renderFindingComment` for a finding with trigger `normal` and origin `fix-gap` with evidence `added by push 1` returns a body whose line after the `Trigger: normal` line is `Origin: fix-gap - added by push 1`.
15. [unit] `renderFindingComment` for a finding with origin `fix-gap`, no evidence and a lineage places the `Origin: fix-gap` line before the `Lineage:` line.
16. [unit] `renderFindingComment` for a finding with origin `pr` returns the same body as for the same finding with no origin.
17. [unit] `renderFindingComment` for a finding with origin `fix-gap` and 400 characters of evidence writes an `Origin:` line whose evidence is cut to 300 characters, as the `Trigger:` line's evidence is.
18. [unit] `renderReviewSummary` with one residual finding (important, `a.ts` line 3, issue `Lock leaks`, trigger `normal`, origin `fix-gap`, origin evidence `added by push 1`) lists it as `- **Important** \`a.ts\`:3: Lock leaks (trigger normal; origin fix-gap - added by push 1)`.
19. [unit] `renderReviewSummary` with the same residual finding but origin `pr` lists it as `- **Important** \`a.ts\`:3: Lock leaks (trigger normal)`.
20. [integration] `readBlockingFindingThreads` for one own unresolved, unsettled finding thread whose first comment states `**Important**`, `Trigger: normal` and `Origin: fix-gap`, with `configured` `["normal", "own-concurrency"]`, returns an empty list.
21. [integration] `readBlockingFindingThreads` for the same thread with `Origin: fix-regression` returns one open item with that thread's key.

### US-002

1. [unit] `buildBotPrReviewPrompt` with no `incrementalSince` renders a `## Your task` section with exactly one line starting `Severity:`, equal to `Severity: "critical" = unsafe behaviour or lost data a user or caller can reach; "important" = other wrong behaviour a user or caller can reach, a changed behaviour no test would catch, or a break of a listed project rule; "minor" = worth noting.`
2. [unit] In that prompt the `Severity:` line directly follows the line starting `Set "decision" on a finding only`.
3. [unit] `buildBotPrReviewPrompt` with `conversationOnly: true` also renders that `Severity:` line in its `## Your task` section.
4. [unit] `buildBotPrReviewPrompt` renders the `normal` definition as exactly `normal: reachable in ordinary use of the product, as this repository documents or configures it.`
5. [unit] `buildBotPrReviewPrompt` with `incrementalSince` set and one `botPushes` entry renders, after the `manual:` definition line, the line `Name each finding's origin with "origin" and the one detail that shows it with "originEvidence". The origins are:`.
6. [unit] In that prompt the three lines after it are the `pr:`, `fix-regression:` and `fix-gap:` definitions exactly as Design states them, in that order.
7. [unit] In that prompt the JSON finding shape contains `"triggerEvidence": "...", "origin": "pr|fix-regression|fix-gap", "originEvidence": "..."`.
8. [unit] `buildBotPrReviewPrompt` with `incrementalSince` set and an empty `botPushes` renders no line starting `Name each finding's origin` and no `"origin":` field.
9. [unit] `buildBotPrReviewPrompt` with one `botPushes` entry but no `incrementalSince` renders no line starting `Name each finding's origin`.
10. [unit] `buildBotPrReviewPrompt` with `incrementalSince`, one `botPushes` entry and `conversationOnly: true` renders no line starting `Name each finding's origin`.
11. [unit] Parsing a review reply whose finding has `"origin": "fix-gap"` and `"originEvidence": "  added by push 1  "` yields a finding with `origin` `"fix-gap"` and `originEvidence` `"added by push 1"`.
12. [unit] Parsing a review reply whose finding has `"origin": "pr"` yields a finding with `origin` `"pr"`.
13. [unit] Parsing a review reply whose finding has no `origin` yields a finding with no `origin` field.
14. [unit] Parsing a review reply whose finding has `"origin": "regression"` yields a finding with no `origin` field.
15. [unit] Parsing a review reply whose finding has an `originEvidence` of 400 characters yields an `originEvidence` of 300 characters.
16. [unit] Parsing a review reply whose finding has `"originEvidence": "   "` yields a finding with no `originEvidence` field.

### US-003

1. [unit] `settleFindingOrigins` for a verdict whose finding has origin `fix-gap`, whose key is in `lineage.lineage` and not in `ownThreadKeys`, returns that finding with origin `fix-gap` and its evidence unchanged.
2. [unit] `settleFindingOrigins` for a `fix-gap` finding whose key is not in `lineage.lineage` returns it with origin `pr`.
3. [unit] In that case the returned finding has no `originEvidence` field.
4. [unit] `settleFindingOrigins` for a `fix-gap` finding whose key is in `lineage.lineage` and in `ownThreadKeys` returns it with origin `pr`.
5. [unit] `settleFindingOrigins` for a `fix-gap` finding whose key is in `lineage.unknown` returns it with origin `pr`.
6. [unit] `settleFindingOrigins` for a `fix-gap` finding with no `file` returns it with origin `pr`.
7. [unit] `settleFindingOrigins` with `lineage` `undefined` returns every `fix-gap` finding with origin `pr`.
8. [unit] `settleFindingOrigins` for a `fix-regression` finding whose key is not in `lineage.lineage` returns it with origin `fix-regression`.
9. [unit] `settleFindingOrigins` for a finding with no origin returns it with no `origin` field.
10. [unit] `settleFindingOrigins` leaves the verdict it was given unchanged: after the call, the input's `fix-gap` finding still has origin `fix-gap`.
11. [unit] `settleFindingOrigins` logs one `debug` line naming the finding key when it reads a `fix-gap` claim as `pr`.
12. [integration] `runBotReview` on an incremental review whose range holds one recorded bot push P, with the stubbed review returning one `important` `normal` finding on `src/a.ts` line 12 with origin `fix-gap`, blame naming P for that line, and no own thread for its key, posts no inline comment for that finding.
13. [integration] In that case the posted review summary lists the finding under `### Residual findings (not blocking)` with `origin fix-gap` in its parenthesis.
14. [integration] In that case the recorded `bot-review.json` agreed item for that finding has origin `fix-gap`.
15. [integration] `runBotReview` with the same finding and origin `fix-gap`, but blame naming a commit that is not P's, posts one inline comment for the finding.
16. [integration] In that case the recorded agreed item for that finding has origin `pr`.
17. [unit] `hasPushWorthyItem` for an env whose review's only agreed item is an `important` `normal` finding with origin `fix-gap` returns `false`.
18. [unit] `hasPushWorthyItem` for an env whose review's only agreed item is an `important` `normal` finding with origin `fix-regression` returns `true`.

### US-004

1. [integration] `runBotReview` on an incremental review whose range holds one recorded bot push P, the stubbed review returning one `important` `normal` finding on `src/a.ts` line 12 with origin `fix-gap`, and blame naming P for that line, where the bot already has an own inline thread for the finding's key, edits that thread's comment and posts no new inline comment for the finding.
2. [integration] In that case the edited comment body has no line starting `Origin:`.
3. [integration] In that case the recorded agreed item for the finding has origin `pr`.
4. [integration] `runBotReview` on the same setup with no own thread for the key and the finding's severity `minor` lists it under `### Minor findings` on a line that does not include `origin`.
5. [integration] `runBotReview` on a review whose earlier own finding thread has a body with `Trigger: normal` and `Origin: fix-regression`, re-carried as an agreed finding, records that item with origin `fix-regression`.
6. [integration] In that case the recorded item's `issue` has no line starting `Origin:`.
7. [integration] `runBotReview` on a review whose earlier own finding thread has a body with `Trigger: normal` and no `Origin:` line, re-carried as an agreed finding, records that item with no `origin` field.
8. [unit] `readyStep` for an env whose readiness review's only agreed item is an `important` `normal` finding with origin `fix-gap`, with no carried record and every other readiness input passing, reports no open-finding hold for that key.
9. [unit] `readyStep` for the same env with the item's origin `fix-regression` reports a hold that names the item's key.
