# SPEC: bot trigger classes: three more classes a review finding can be sorted into, none blocking by default

## Summary

`nax bot review` asks the reviewer to name the class of condition each finding needs (`trigger`). Today there are four classes, and `normal` is the one a finding lands in when no other fits. This feature adds three classes for conditions that are not ordinary use:

- `off-contract`: needs a caller, subclass or configuration value that breaks a type, schema or documented contract of this repository.
- `version-skew`: needs two versions of the product running together, or data written by an earlier version.
- `backend-fault`: needs a store, network or clock failure between two steps of one operation.

None of the three is in the default blocking set, which stays `["normal", "own-concurrency"]`. A critical or important finding in one of them is posted the way a finding outside the blocking set already is: no inline thread, one line under `### Residual findings (not blocking)` in the review summary. A project that wants one of them to hold readiness adds it to `bot.blockingTriggers`, and a collaborator can do the same for one PR with the existing `blocking triggers: ...` comment.

The prompt also states what the evidence for `normal` is: the document, configuration, example or test in this repository that shows that use.

This is the reviewer side of #2987. #2987 stays open.

## Motivation

After #3008 a gap in the bot's own fix no longer blocks, but reviews on `gpt-6.2-astra[high]` still do not converge. On two library merge requests (an OAuth replay hardening and an idempotency replay hardening), every review of a fix raised a new batch of blocking findings, whichever model wrote the fix: 8 and 9 after two fixes by the same model, 10 on a fix by a second model, and 7 blocking on a fix by a third model that its own review had approved with none.

Reading the 48 unique findings of the six reviews that followed a fix (hand labels, approximate):

| Kind of condition the finding needs | Count |
|---|---|
| Ordinary use of the product | about 8 |
| A test that would still pass without the change | about 10 |
| An input or configuration that breaks the typed or documented contract (a number where the type says string, a `NaN` duration) | about 8 |
| A consumer extension the repository does not show (a subclass that overrides a method as an instance field) | about 7 |
| Mixed versions or records written by an earlier version (rolling deploy) | about 6 |
| Documentation | about 5 |
| A store failure or clock skew between two writes | about 4 |

43 of the 48 were classed `normal`, and 12 were critical. The reviewer used `own-concurrency` and `adversarial` on the 5 findings that fit them, so it sorts correctly into the classes it is given. The other kinds have no class, so they land in `normal`, and `normal` blocks.

The evidence the reviewer gives for `normal` quotes the code that has the defect. It almost never names where the repository documents or configures that use, although the `normal` definition asks for exactly that. For a library, some caller can reach nearly any input, so without a named use every finding reads as reachable.

The findings are real and worth seeing. The first review of the OAuth merge request found a cached token response returned without its sender-binding check, which a second model's full review of the same head did not report. So this feature does not make the reviewer shallower. It gives the reviewer more classes to sort into and leaves the blocking rule as it is.

## Design

### Approach

The trigger vocabulary has one source, `FINDING_TRIGGERS` in `packages/nax/src/workflow/blocking-findings/index.ts`. The config schema (`z.enum(FINDING_TRIGGERS)`), the reply parser (`parseFindingTrigger`), the thread reader (`readFindingThreadFacts`) and the per-PR ruling parser (`effectiveBlockingTriggers`) all read it. Adding three members there makes all four accept the new classes with no further change.

`DEFAULT_BLOCKING_TRIGGERS` is not changed. `isBlockingFinding` is not changed. Every site that asks it (review posting, push-worthiness, readiness, carried findings, the chain notice, the fix facts) therefore treats a finding in a new class as it treats an `adversarial` finding today.

The rest is text:

1. The review contract in `bot-pr-review-builder.ts` gains one definition line per new class, one line that says what the evidence for `normal` is, and the three names in the finding shape.
2. The `bot.blockingTriggers` description in `config-descriptions.ts` names the three new classes.

The prompt text is facts, not orders. It defines the classes and says what the evidence for `normal` names. It says nothing about what a class does to readiness.

**Order.** The seven classes are listed in one order everywhere (the constant, the definition lines and the finding shape): `normal`, `off-contract`, `version-skew`, `backend-fault`, `own-concurrency`, `adversarial`, `manual`. The three new classes sit directly after `normal` because they are the conditions carved out of it. `manual` stays last, so the origin lines of #3008, which follow the `manual:` line, keep their place.

**Composition.** `isBlockingFinding` keeps its three tests in the same order: severity is `critical` or `important`; origin is not `fix-gap`; trigger is in the effective blocking set. A new class changes only which value the third test reads. A `critical` `version-skew` finding under the default set does not block. An `important` `off-contract` finding under a set that names `off-contract` blocks.

### Integration

Symbols this feature only reads:

- `packages/nax/src/workflow/blocking-findings/index.ts`: `DEFAULT_BLOCKING_TRIGGERS: readonly FindingTrigger[]` (`["normal", "own-concurrency"]`), `parseFindingTrigger(value: unknown): FindingTrigger`, `isBlockingFinding(finding, blocking): boolean`, `readFindingThreadFacts(body): { severity; trigger; origin }`, `effectiveBlockingTriggers(input: EffectiveBlockingTriggersInput): EffectiveBlockingTriggers`.
- `packages/nax/src/config/schemas-bot.ts`: `BotConfigSchema`, whose `blockingTriggers` is `z.array(z.enum(FINDING_TRIGGERS)).min(1).default([...DEFAULT_BLOCKING_TRIGGERS])`.
- `packages/nax/src/operations/bot-pr-review-reply.ts`: `parsePrReviewReply`, whose findings carry `trigger: parseFindingTrigger(source.trigger)`.
- `packages/nax/src/bot/post.ts`: `postPrReview(input: PostReviewInput)`, which posts no inline thread for a finding `isBlockingFinding` rejects and lists it under `### Residual findings (not blocking)`.
- `packages/nax/src/bot/review-blocking.ts`: `hasPushWorthyItem(env: BotFixEnv): boolean`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `FINDING_TRIGGERS` (`packages/nax/src/workflow/blocking-findings/index.ts`).
  - Baseline: `["normal", "own-concurrency", "adversarial", "manual"] as const`.
  - Target: `["normal", "off-contract", "version-skew", "backend-fault", "own-concurrency", "adversarial", "manual"] as const`. `FindingTrigger` follows from it.
- `TRIGGER_CLASS_LINES` (`packages/nax/src/prompts/builders/bot-pr-review-builder.ts`).
  - Baseline: the lead-in line, then the `normal:`, `own-concurrency:`, `adversarial:` and `manual:` definition lines.
  - Target: the lines below, in this order. The lead-in, `normal:`, `own-concurrency:`, `adversarial:` and `manual:` lines keep their exact text.

    ```
    Name each finding's class with "trigger" and the one detail that shows it with "triggerEvidence". The classes are:
    normal: reachable in ordinary use of the product, as this repository documents or configures it.
    For normal, "triggerEvidence" names the document, configuration, example or test in this repository that shows that use.
    off-contract: needs a caller, subclass or configuration value that breaks a type, schema or documented contract of this repository.
    version-skew: needs two versions of the product running together, or data written by an earlier version.
    backend-fault: needs a store, network or clock failure between two steps of one operation.
    own-concurrency: needs two of the tool's own processes or sessions interleaving.
    adversarial: needs a deliberate actor (forged metadata, input the threat model excludes, shadowed builtins).
    manual: needs a human acting on the checkout or state mid-operation.
    ```
- `FINDING_SHAPE` (same file).
  - Baseline: `"trigger": "normal|own-concurrency|adversarial|manual"`.
  - Target: `"trigger": "normal|off-contract|version-skew|backend-fault|own-concurrency|adversarial|manual"`. The rest of the shape keeps its exact text.
- `FIELD_DESCRIPTIONS["bot.blockingTriggers"]` (`packages/nax/src/cli/config-descriptions.ts`).
  - Baseline: names `"normal"`, `"own-concurrency"`, `"adversarial"` or `"manual"`.
  - Target: its first sentence reads `Finding trigger classes that can hold readiness: "normal", "off-contract", "version-skew", "backend-fault", "own-concurrency", "adversarial" or "manual" (default ["normal", "own-concurrency"]).` The sentences after it keep their exact text.

### Failure Handling

| Situation | Behaviour |
|---|---|
| A reply names a class outside the seven | `parseFindingTrigger` reads it `normal`, as today: the finding blocks. |
| A reply classes a finding `normal` with evidence that names no document, configuration, example or test | The finding is kept as `normal` and blocks. nax does not check the evidence text. |
| A thread, summary or artifact written before this change | It names one of the four earlier classes, which all remain members: read as before. |
| `bot.blockingTriggers` or a `blocking triggers:` comment names a new class | Accepted. Findings of that class hold readiness for that project or that PR. |
| A `minor` finding in a new class | Goes to `### Minor findings` as every minor does. |

Every row is behaviour the code already has. This feature changes none of it.

### Test placement

Each new test goes beside the existing tests of the entry point it calls:

- `FINDING_TRIGGERS`, `DEFAULT_BLOCKING_TRIGGERS`, `parseFindingTrigger`, `isBlockingFinding`, `readFindingThreadFacts` and `effectiveBlockingTriggers`: `packages/nax/test/unit/workflow/blocking-findings.test.ts`.
- `BotConfigSchema`: `packages/nax/test/unit/config/bot-config.test.ts`.
- `parsePrReviewReply`: `packages/nax/test/unit/operations/bot-pr-review-reply.test.ts`.
- `buildBotPrReviewPrompt`: the new file under Creates. It declares its own minimal `BotPrReviewPromptInput` literal for a full code review; it shares no mock setup with another file.
- `postPrReview`: `packages/nax/test/integration/bot/post-blocking.test.ts`.
- `hasPushWorthyItem`: `packages/nax/test/unit/bot/review-blocking.test.ts`.
- `FIELD_DESCRIPTIONS`: `packages/nax/test/unit/cli/config-descriptions.test.ts`.

Some criteria are guards on the ruling, not new behaviour. The `DEFAULT_BLOCKING_TRIGGERS`, `isBlockingFinding`, `postPrReview` and `hasPushWorthyItem` criteria already hold at runtime on the code before this change, because `isBlockingFinding` only asks whether the class is in the set. Before the change their tests fail the test typecheck instead, since the new class names are not yet members of `FindingTrigger`. The criteria that fail at runtime before the change are the ones on `FINDING_TRIGGERS`, `parseFindingTrigger`, `readFindingThreadFacts`, `BotConfigSchema`, `effectiveBlockingTriggers`, `parsePrReviewReply`, `buildBotPrReviewPrompt` and `FIELD_DESCRIPTIONS`.

## Out of Scope

- Changing `DEFAULT_BLOCKING_TRIGGERS`. It stays `["normal", "own-concurrency"]`; the three new classes do not hold readiness unless a project or a PR ruling names them (user ruling of 2026-11-23).
- A deterministic check of the evidence a reply gives for `normal`. nax keeps the class the reviewer names; the evidence line in the prompt is a definition, not a gate.
- Reclassifying findings already posted. Threads, summaries and artifacts written before this change keep the class they state.
- A class for test-strength findings (a test that would still pass without the change) or for documentation findings. Both stay in whichever class the reviewer names and block as they do today.
- US-001 only: new tests for the Failure Handling rows beyond the listed acceptance criteria. Each row is behaviour the code already has and this feature does not change.
- Changing the severity scale line of the bot PR review contract.
- Changing the bot fix prompt (a definition of a finished fix, the standing of a reviewer suggestion). A separate change.
- Routing a fix-induced chain to the advisor, #2987 lever C.
- Adding the new classes to the trigger vocabulary of the story, branch or acceptance reviewers. Only the bot PR review asks for a trigger.
- Changing the bot review or fix model in any operator config or profile.
- Edits under `.nax/`, including this repository's own `.nax/config.json`. An operator who wants a new class to block adds it to `bot.blockingTriggers` by hand.

## Stories

**US-001: three more trigger classes in the vocabulary, the review contract and the config description.** Workdir: `packages/nax`. No dependencies. `FINDING_TRIGGERS` gains `off-contract`, `version-skew` and `backend-fault`. The bot PR review contract defines them, names them in the finding shape and says what the evidence for `normal` names. The `bot.blockingTriggers` description names them. `DEFAULT_BLOCKING_TRIGGERS` and `isBlockingFinding` are unchanged, so a critical or important finding in a new class is listed as residual and does not hold readiness unless the effective blocking set names its class.

### Context Files

**US-001**
- `packages/nax/src/workflow/blocking-findings/index.ts` — `FINDING_TRIGGERS`, `DEFAULT_BLOCKING_TRIGGERS`, `isBlockingFinding`, `effectiveBlockingTriggers`.
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `TRIGGER_CLASS_LINES`, `FINDING_SHAPE`, `taskContract`.
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — the `taskContract` pin this story updates, and the shape of a minimal `BotPrReviewPromptInput` for a full code review.
- `packages/nax/test/integration/bot/post-blocking.test.ts` — existing `postPrReview` residual tests with the `blocking()`, `callsTo()` and `summaryBody()` helpers; the `postPrReview` criteria go here.
- `packages/nax/test/unit/bot/review-blocking.test.ts` — existing `hasPushWorthyItem` tests and their `findingItem()` helper, which fixes `trigger: "normal"`; the `hasPushWorthyItem` criterion goes here.

### Creates

**US-001**
- `packages/nax/test/unit/prompts/bot-pr-review-builder-trigger-classes.test.ts` — the contract ACs for the new class lines, the evidence line and their order. `bot-pr-review-builder.test.ts` is 614 lines, so these go in their own file by concern.

### Modifies

**US-001**
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — the `taskContract` constant pins the whole contract text verbatim. It gains the `For normal, ...` evidence line directly after the `normal:` line, then the `off-contract:`, `version-skew:` and `backend-fault:` definition lines, and its finding shape line names the seven classes in the order `normal|off-contract|version-skew|backend-fault|own-concurrency|adversarial|manual`. Every other line of the constant keeps its exact text and order.
- `packages/nax/test/unit/prompts/bot-pr-review-builder.test.ts` — test "AC-8 asks for a trigger class and its evidence in the finding shape" asserts the contract contains `"trigger": "normal|own-concurrency|adversarial|manual", "triggerEvidence": "..."`. It asserts the seven-class shape `"trigger": "normal|off-contract|version-skew|backend-fault|own-concurrency|adversarial|manual", "triggerEvidence": "..."` instead.

### Seams

None. The feature adds no exported symbol: it adds members to an existing exported constant, and the consumers that read that constant are exercised through their own entry points: `BotConfigSchema`, `effectiveBlockingTriggers`, `parsePrReviewReply`, `postPrReview` and `hasPushWorthyItem`.

## Acceptance Criteria

### US-001

1. [unit] `FINDING_TRIGGERS` equals `["normal", "off-contract", "version-skew", "backend-fault", "own-concurrency", "adversarial", "manual"]`.
2. [unit] `DEFAULT_BLOCKING_TRIGGERS` equals `["normal", "own-concurrency"]`.
3. [unit] `parseFindingTrigger("off-contract")` returns `"off-contract"`.
4. [unit] `isBlockingFinding` for an `important` finding with trigger `off-contract`, under blocking set `["normal", "own-concurrency"]`, returns `false`.
5. [unit] `isBlockingFinding` for a `critical` finding with trigger `version-skew`, under blocking set `["normal", "own-concurrency"]`, returns `false`.
6. [unit] `isBlockingFinding` for an `important` finding with trigger `off-contract`, under blocking set `["normal", "off-contract"]`, returns `true`.
7. [unit] `readFindingThreadFacts` of the body `**Important** (quality): Marker lost\n\nTrigger: backend-fault - the marker write fails after the body write` returns `trigger` `"backend-fault"`.
8. [unit] `BotConfigSchema.safeParse({ blockingTriggers: ["normal", "version-skew"] })` succeeds with `blockingTriggers` equal to `["normal", "version-skew"]`.
9. [unit] `effectiveBlockingTriggers` given one writer comment whose body is `blocking triggers: normal, backend-fault` and a configured set `["normal"]` returns `triggers` equal to `["normal", "backend-fault"]`.
10. [unit] `parsePrReviewReply` of a reply whose one finding has `"trigger": "version-skew"` returns a finding with `trigger` `"version-skew"`.
11. [unit] The `## Your task` section of `buildBotPrReviewPrompt` for a full code review has exactly one line starting `off-contract:`, and it equals `off-contract: needs a caller, subclass or configuration value that breaks a type, schema or documented contract of this repository.`
12. [unit] The same section has exactly one line starting `version-skew:`, and it equals `version-skew: needs two versions of the product running together, or data written by an earlier version.`
13. [unit] The same section has exactly one line starting `backend-fault:`, and it equals `backend-fault: needs a store, network or clock failure between two steps of one operation.`
14. [unit] In the same section, the line directly after the line starting `normal:` equals `For normal, "triggerEvidence" names the document, configuration, example or test in this repository that shows that use.`
15. [unit] In the same section, the lines starting `normal:`, `off-contract:`, `version-skew:`, `backend-fault:`, `own-concurrency:`, `adversarial:` and `manual:` appear in that order.
16. [unit] The same section contains `"trigger": "normal|off-contract|version-skew|backend-fault|own-concurrency|adversarial|manual", "triggerEvidence": "..."`.
17. [unit] The `## Your task` section of `buildBotPrReviewPrompt` with `conversationOnly: true` contains the line `off-contract: needs a caller, subclass or configuration value that breaks a type, schema or documented contract of this repository.`
18. [integration] `postPrReview` given blocking triggers `["normal", "own-concurrency"]` and a verdict whose one finding is `important`, on `a.ts` line 3, with trigger `off-contract` posts no inline comment.
19. [integration] For the same input, the summary comment `postPrReview` writes contains, under `### Residual findings (not blocking)`, a line that starts `- **Important** \`a.ts\`:3:` and contains `(trigger off-contract`.
20. [integration] `postPrReview` given blocking triggers `["normal", "off-contract"]` and a verdict whose one finding is `important`, on `a.ts` line 3, with trigger `off-contract` posts that finding as an inline comment.
21. [unit] `hasPushWorthyItem` for a fix environment whose blocking set is `["normal", "own-concurrency"]` and whose only agreed item is an `important` finding with trigger `backend-fault` returns `false`.
22. [unit] `FIELD_DESCRIPTIONS["bot.blockingTriggers"]` starts with `Finding trigger classes that can hold readiness: "normal", "off-contract", "version-skew", "backend-fault", "own-concurrency", "adversarial" or "manual" (default ["normal", "own-concurrency"]).`
