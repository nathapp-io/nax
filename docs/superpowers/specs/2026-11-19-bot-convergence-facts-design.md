# Bot convergence, part 1: facts (design)

Date: 2026-11-19. Issues: #2988, #2979, #2981, #2982, #2987 (points 1 and 3 only).
Part 2 (a separate spec, later): route fix-induced chains to an advisor (#2987 point 2).

## 1. Intent

`nax bot review` / `nax bot fix` do not converge on subtle code. Each fix adds machinery (a lock,
a claim file, a parser), the incremental re-review of that fix finds a real defect inside it, the
next fix adds more. On `openai-codex/gpt-6.2-sol[high]` PR #2978 took 11 review rounds and 21
Important findings; on 6.1-sol the 22 prior PRs had median 1, max 3. The bot is pinned back to
6.1-sol until this lands (`~/.nax/config.json`, `~/.nax/profiles/bot-sol.json`).

Nothing today tells the reviewer, the fixer or the operator that the findings are chasing the
bot's own fixes, every finding blocks the same way whether it is reachable in normal use or needs
a forged mtime, and a minor finding can force a push that resets readiness.

This part gives the agents and the operator **facts**: how each finding is triggered, whether it
sits on lines a previous bot fix wrote (and for which item, at which generation), how much the bot
has grown code outside the feature's Modifies list, and what currently blocks readiness. Blocking
is decided by code from those facts, not by the reviewer re-reading a comment.

Success: after release, one A/B on a #2978-like head with the bot on 6.2-sol shows the chain in
the summary and fewer blocking rounds than 11. Part 2 is built only if chains still form.

## 2. Goals

- G1 (#2988) Every bot review finding carries a `trigger` class and a one-line `triggerEvidence`.
- G2 (#2988, #2982) A configured blocking-trigger set decides which findings block readiness; a
  PR-level scope ruling overrides it for one PR, applied by code.
- G3 (#2982, #2987.1) A per-PR push ledger records every `bot fix` push: range, item keys answered,
  each item's generation.
- G4 (#2987.1) Each new finding gets lineage: generation and parent item ids, from blame of its
  anchor line against the ledger.
- G5 (#2987.1, .3) The reviewer sees which commits in its range came from which bot push and for
  which item; the fixer sees each finding's lineage and the bot's cumulative growth outside Modifies.
- G6 (#2982) The fix summary shows the round count and, once any open blocking finding reaches the
  notice generation, a "findings are chasing their own fixes" section listing the chain.
- G7 (#2979) A finding that cannot hold readiness never causes a push on its own.
- G8 (#2981) `nax workflow status` and the summary's open-item line count every finding that blocks
  readiness, including unindexed bot inline threads, with links.

## 3. Non-goals

- Advisor routing of chains (part 2).
- Changing the incremental review range (`reviewRange`, `bot/review-rulings.ts:203`).
- A round cap or any hard stop on fix rounds. Only a signal.
- Posting minor findings as threads (#2979 option 1 rejected; option 2 chosen).
- Moving the bot model back to 6.2-sol (operator does that after the A/B).

## 4. Anti-goals (would be a failure even if it works)

- Prompt orders such as "do not add machinery" or "prefer reverting". Agents get facts only.
- Any new human step. A scope ruling is optional; with none, defaults apply.
- A `normal`-trigger critical/important finding that stops blocking.
- Losing the push ledger history when the single `fix-summary` comment is rewritten.

## 5. Approaches considered for lineage (G3/G4)

1. **Push ledger in the bot's own `fix-summary` comment (CHOSEN).** Lives on the PR, so it works
   whichever host ran the round (koda runner or local), and rewrites no commits.
2. Lineage in the item-index (`w-index`) comment. One place, but more writes to a comment that
   already carries reopen-race handling (`pendingReopens`).
3. Commit trailers added after the fix session. Readable from git alone, but rewrites the agent's
   commits before push and breaks on squash or rebase.

Correction found while designing: the `fix-summary` comment (`FIX_SUMMARY_KEY`,
`bot/ci-waiver-ready.ts:28`) is ONE comment upserted in place (`bot/fix-report.ts:592`), not one per
push. So the ledger is an append-only list carried inside that comment: each write reads the
existing list from the bot's own comment and appends.

## 6. Design

### 6.1 Trigger class (G1)

- Review reply schema (`prompts/builders/bot-pr-review-builder.ts`, `TASK_CONTRACT`) gains, per
  finding, `"trigger": "normal|own-concurrency|adversarial|manual"` and `"triggerEvidence": "..."`.
  The prompt defines each class in one line (from #2988) as a fact to report:
  - `normal`: reachable in ordinary use of the product
  - `own-concurrency`: needs two of the tool's own processes or sessions interleaving
  - `adversarial`: needs a deliberate actor (forged metadata, input the threat model excludes,
    shadowed builtins)
  - `manual`: needs a human acting on the checkout or state mid-operation
- Parsing: a missing or unknown `trigger` reads as `normal` (fails closed: it still blocks), with a
  debug log. `triggerEvidence` is optional in the parser, capped like other finding text.
- The trigger is carried through `AgreedItem` (`bot/post.ts:34`), the review artifact, the inline
  thread body (one line, e.g. `Trigger: adversarial - forged mtime on the claim file`) and the fix
  input, so a later run reading only the PR sees it. Parsing an existing thread with no trigger
  line reads `normal`.

### 6.2 Blocking set and scope ruling (G2)

- Config: flat key `bot.blockingTriggers` (beside `gateRepairRounds`, `costLimit`, `models` in
  `config/schemas-bot.ts`, which has no nested `review`/`fix` objects), an array of the four
  classes, default `["normal", "own-concurrency"]`. Empty array is rejected by the
  schema (would make nothing block).
- A finding blocks readiness when severity is critical or important AND trigger is in the effective
  set. `blockingKeys` (`bot/fix-report.ts:343`) gains the trigger test. One shared predicate is used
  by readiness, the fix step (6.6), the summary and `workflow status` (6.7), so they cannot disagree.
  It lives under `workflow/` (or a neutral module): `bot/` already imports `workflow/` (about 50
  imports) and `workflow/` never imports `bot/`; keep that direction.
- Non-blocking critical/important findings are posted the way minors are today: not as inline
  threads (`postFindings`, `bot/post.ts:286`), listed in the review summary under a "Residual
  (not blocking)" heading with severity, trigger and evidence.
- Scope ruling: a top-level PR comment by a writer (same check as `bot/writers.ts`, both forges)
  whose first non-empty line, trimmed and case-insensitive, matches
  `blocking triggers: <class>[, <class>...]` sets the effective set for that PR. Quoted (`>`) or
  bulleted lines do not match. The current comment body is read each run, so an edit or delete
  takes effect on the next run. Newest matching comment wins. Any non-empty subset of the four
  classes is allowed, narrower or wider than config. Because the fix step uses the same predicate,
  the ruling also changes push-worthiness (6.6). An invalid line is ignored with a warning in the
  summary. The summary names the effective
  set and where it came from (config or comment link).

### 6.3 Push ledger (G3)

- After a successful `bot fix` push (the push step sets `pushedSha` from `readHead`,
  `bot/fix-steps.ts:319`; `base` = `env.info.headSha`, the head the session started from), the fix
  report writes into the `fix-summary` body a hidden
  block, e.g. `<!-- nax-bot:pushes v1 <base64 JSON> -->`, holding an append-only list of
  `{ base, sha, at, items: [{ key, generation }] }`. `base` is the PR head the fix session started
  from; `sha` is the pushed head; `items` are the agreed item keys that push answered, with the
  generation each had (6.4).
- Every writer of the `fix-summary` body preserves the block: the fix report and the CI-waiver
  rewrite (`bot/ci-waiver-ready.ts:152-155`, which keeps some lines today and would drop it).
- Read: parse from the bot's own `fix-summary` comment only (ownership as `ownComments`). Missing
  or unparsable block = empty ledger plus a warning; never fails the run.
- If the push succeeds but the summary edit fails, that entry is lost: log a warning and name it in
  the run output. No retry (my call; the facts degrade to generation 0, nothing blocks wrongly).
- Cap: keep the newest 64 entries (my call; a PR with more is already far outside the problem).
- Advisor-ledger pushes (`fix-report.ts:585`) and ready-only passes add no entry.

### 6.4 Lineage (G4)

- In `bot review`, after the verdict is parsed, for each finding with `file` and `line`: blame that
  line at the reviewed head. If the blamed commit is reachable from an entry's `sha` and not from
  its `base`, that entry's items are the finding's parents. Generation = 1 + max parent generation.
  A line outside every entry (human or workflow code) is generation 0. Off-line findings get
  generation 0 with `lineage: unknown`.
- A pushed item's generation for the ledger is the generation of the finding it came from; findings
  and items without one (human thread asks, advisor items) are 0.
- Lineage is stored on the finding in the review artifact and as one line on the inline thread
  (`Lineage: generation 2, on lines added by bot fix abc1234 for item <key>`).
- Blame or ancestry errors leave the finding at generation 0, `lineage: unknown`, logged.
- After a rebase or force-push an entry's `sha` may no longer be reachable from the head. Such
  entries are skipped, and the summary shows `<n> bot fix pushes no longer in history (rewritten)`
  so a silent drop to generation 0 is visible (my call).

### 6.5 Facts to the agents (G5)

- Reviewer prompt, incremental reviews only: a section listing each ledger entry inside the review
  range as `commits <base7>..<sha7> were pushed by nax bot fix for item <key> (<issue first line>),
  generation <n>`. Plain facts, no instruction about what to do with them.
- Fixer prompt (`buildBotPrFixPrompt`, built in `prompts/builders/bot-pr-fix-builder.ts:55`, called
  at `bot/fix-steps.ts:139`): per finding, its trigger, its
  lineage line, and the parent item's issue first line. Plus one line: lines added by earlier bot
  fix pushes on this PR in files outside the feature's Modifies list, per file. Modifies = the union
  of every story's `modifies` in the feature's `prd.json` (reuse `prd/modifies-extract.ts`; the PRD
  path comes from `featureIntentPaths`, `bot/intent.ts:6`, which returns document paths only).
  Growth = added lines from `git diff --numstat <base>..<sha>` per reachable ledger entry (a
  ledger range holds only bot commits), new files and test files included, renames counted at the
  new path (my call). Omitted when the PR has no feature PRD.
- The trigger and lineage reach the fixer through `toFixFindings` (`bot/fix-steps.ts:140`) and
  `BotPrFixPromptInput` (`prompts/builders/bot-pr-fix-builder.ts:55`) as optional fields; other
  callers of those types are unaffected.
- A minor that asks to undo a change made by an earlier bot push shows up through the same lineage
  line; no extra rule.

### 6.6 Non-blocking findings cause no push (G7)

- `fixStep` (`bot/fix-steps.ts:135`) decides push-worthiness from the agreed list: a blocking
  finding (6.2 predicate), an agreed human thread or comment, or confirmed advisor work. If none,
  the outcome is `nothing` and the non-blocking findings are listed in the summary as follow-ups.
- When something push-worthy exists, non-blocking findings are still passed to the fixer, marked
  not blocking, so it may fix them alongside (current behaviour otherwise).

### 6.7 Status and summary (G6, G8)

- `nax workflow status` (`cli/workflow.ts`, live read in `workflow/live-status.ts`) adds unresolved
  bot-own inline finding threads that block (6.2 predicate, same thread parsing as readiness's
  `openKeys`) to its open items, with thread links, and no longer prints `No open items.` while one
  exists.
- The fix summary's open-item line becomes `Open items: <n> of <m> indexed; <k> blocking review
  findings` when k > 0.
- The fix summary adds `Bot fix rounds on this PR: <ledger length>`.
- Chain notice: when any open blocking finding has generation >= `bot.chainNoticeGeneration`
  (flat key, default 2), the summary adds a section "Findings are chasing their own fixes" listing each such
  chain: original item, each push sha, each finding with severity, trigger, generation and link.
  Facts only, no recommendation text beyond naming the chain.

## 7. Constraints

- No new human step; the scope ruling is optional.
- Backward compatible reads (new fields optional; bump the artifact `version` only if a reader parses
  strictly): artifacts, threads and summaries written before this change parse as
  trigger `normal`, generation 0, empty ledger.
- The `fix-summary` body has a forge size limit; the ledger cap (6.3) keeps it bounded.
- Works on GitHub and GitLab (both forges already carry the marker grammar).
- Public repo: no private project names in issue text, examples or fixtures.

## 8. Left to the builder

- Exact encoding of the ledger block (base64 JSON or fenced JSON in an HTML comment), as long as
  `markerPattern` (`forge/marker-grammar.ts`) does not match it as a second key.
- How blame is invoked (one `git blame --porcelain -L` per finding is fine at review sizes).
- Wording of the trigger definitions and summary headings, within the facts-only rule.
- Story split for the spec. Rough shape: (1) trigger schema and parsing, (2) blocking set, config
  and scope ruling, (3) push ledger, (4) lineage and reviewer facts, (5) fixer facts, (6) no push on
  non-blocking only, (7) status and summary counts, chain notice.

## 9. Calls made after the builder check

Settled by me (check while reading): flat config keys `bot.blockingTriggers` and
`bot.chainNoticeGeneration`; shared blocking predicate lives under `workflow/`; scope-ruling grammar
(first non-empty line, case-insensitive, any non-empty subset, also drives push-worthiness);
Modifies = union of PRD story `modifies`; growth counted by `--numstat` over ledger ranges; a lost
ledger write is logged, not retried; rewritten-history entries are skipped and counted in the
summary; trigger and lineage carried as optional fields through `toFixFindings` and
`BotPrFixPromptInput`.
