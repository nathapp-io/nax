# SPEC: chat-publish-held-drafts — rename the chat finish job to publish, refuse a publish with nothing to publish, and never report a held draft PR as done

## Summary

The chat job kind `finish` is renamed `publish` (`nax-jobs__publish`, job ids `publish-<hex>`), because it only reruns the workflow's publish step and never takes a PR to ready. A publish launch is refused when the feature's newest workflow record is already published at the current HEAD, and a chain card warns when a publish step follows a run of the same feature. A run or publish job that leaves a draft PR records that draft and its open items on the job. A chain stops with a reason when any of its steps leaves such a draft, instead of continuing or completing. The completion notice tells the chat agent to draft a ruling for each open item from evidence and ask the user once, instead of asking the user to rule.

Part of #2968 (items 3, 4 and 5). Items 6 and 7 (a PR handoff to koda) are out of scope.

## Motivation

On 2026-11-17 a chat chain `nax run chat-layout-overflow` → `finish` ran on PR #2965. In workflow mode, `nax run` publishes the PR itself, so the `finish` step (`nax run <feature> --publish-only`) did nothing: its log says `Feature workflow already finished at this HEAD — skipped`, it cost $0.00, and it took 2 s. `finishOutcome` in `chat/jobs/job-outcome.ts` reported `succeeded` with the note `publish draft <url>`. `ChainController.reconcile` then marked the chain `completed`, because its last step succeeded.

The PR was still a draft, held by two advisor `finish-approval` holds and a cannot-verify item. The agent reported "finish succeeded; the approved chain is complete, with CI green" and asked the user to "inspect the advisor decisions to identify the exact scope conflict requiring my ruling". Both holds were false positives that could be settled from git evidence: the files they named belonged to #2964, already on main.

Three defects follow from this:

1. The name `finish` reads as "take the PR to ready", the job the nax-finish skill does. The job only publishes.
2. A held draft PR counts as success: the job note does not list its open items, and the chain completes.
3. Nothing tells the agent to settle the items from evidence. Slice-2 design §4.7 already lets the agent draft the rulings nax-finish would post.

The user's standing requirement is minimal human interaction: finish problems go to an agent, and the user is asked once, only for what the evidence cannot settle. Fully automated finishing belongs to koda's flow (user ruling 2026-11-04). This feature makes the chat chain honest about where it stops, and has the agent prepare the finish instead of handing it to the user.

## Design

### Approach

**Rename (US-001).** `ChatJobKind` replaces `"finish"` with `"publish"`. Everything keyed by kind follows: the launch schema in `jobs-provider.ts` (tool `nax-jobs__publish`), `LAUNCH_KINDS`, `parseJobInput` and `buildJobArgv` (`job-argv.ts`), `CHAIN_STEP_FIELDS` and `buildChainStepArgv` (`chain-argv.ts`), `stepDefaults` (`workflow-defaults.ts`), `resolveJobOutcome` (`job-outcome.ts`), `prepareFinish` (renamed `preparePublish`) and `approvePrepared` (`jobs-launch.ts`), `stepLabel` (`chain-tools.ts`), `isFeatureJobKind` / `isRunJobKind` (`job-types.ts`), `FooterJob.kind` and `jobPart` (`tui/chat/job-strip.ts`), and `commandOf` (`tui/chat/layout-job.ts`). `commandOf` returns `nax run <target> --publish-only` for a publish job; today it returns `nax finish <target>`, a command that does not exist. The argv is unchanged: `nax run <feature> --publish-only`. `buildJobsInstructions` names `nax-jobs__publish` on its first and eighth lines, and its sixth line's phrase `nax run (including a publish-only finish)` becomes `nax run (including a publish-only run)`; the line count and order stay the same.

Job records written before the rename stay readable. `JOB_KINDS` in `job-store.ts` lists `"publish"` and keeps `"finish"`, the latter only so a legacy record passes `isJobRecord` before it is mapped. `JOB_ID_PATTERN` accepts the prefix `publish` and the legacy prefix `finish`. `readJobRecords` returns a stored record whose `kind` is `"finish"` with `kind: "publish"` and its `id` unchanged. Chain records are audit data and are never read back (`chain-controller.ts`: "disk records are audit data, never activation input"), so they need no compatibility.

**Publish refusal (US-002).** `isTransientDraft` moves from `workflow/feature.ts` to `workflow/publish-only.ts` and is exported. `feature.ts` imports it, and `runInContext` behaves as before. A new pure function in `publish-only.ts`:

```ts
export interface PublishedAtHead {
  readonly outcome: "ready" | "draft";
  readonly url?: string;
}
/** The prior record's publication when a publish-only run at `head` would do nothing; otherwise undefined. */
export function publishedAtHead(
  prior: WorkflowFeatureRecord | null,
  head: string | undefined,
): PublishedAtHead | undefined;
```

It returns `{ outcome, url }` only when all of these hold: `prior.step === "done"`, `head` is a non-empty string equal to `prior.head`, `prior.outcome` is `"ready"` or `"draft"`, and `isTransientDraft(prior)` is false. That matches `runInContext`'s skip condition for a publish-only run.

`preparePublish` (in `jobs-launch.ts`) runs after its pending-stories check. It reads the newest prior record with `_jobsLaunchDeps.loadPriorFeature(workflowFeatureDir(repoRoot, feature), "")` and HEAD with `_jobsLaunchDeps.headSha(repoRoot)`. Both are added to `_jobsLaunchDeps`. `loadPriorFeature` expects the feature's workflow run directory, `.nax/features/<feature>/workflow`, which `workflowFeatureDir` (`workflow/paths.ts`) returns; `featureDir` from `@/config` is one level too high and would always yield `null`. `loadPriorFeature`, `workflowFeatureDir` and `publishedAtHead` are imported from their workflow leaf files by relative path with a `biome-ignore lint/style/noRestrictedImports` comment, as `chat/workflow/feature-state.ts` does, because the workflow barrel closes a runtime cycle. `headSha` comes from the `@/finish` barrel. When `publishedAtHead` returns a value, it refuses before any card with the error:

`[chat] <feature> is already published at HEAD <first 7 chars of head> as a <outcome> PR <url>; nothing to publish: use nax-jobs__bot_review for its open items`

When the record has no `url`, the error omits the space and URL after `PR`. When `launchJob` returns this refusal and the active chain's next step is a `publish` step whose target is the same feature, `launchJob` calls `options.chains.stop(<the refusal text without its "[chat] " prefix>)`. The next step is the step at index `summary().next - 1` of `options.chains.active()`, and its `target` field holds the feature name. Today a refusal in `prepareTarget` returns before chain admission and leaves the chain active.

The chain card warns at proposal time. `chainReason` adds the line `warning: step <n> publishes <feature> after step <m> runs it; a workflow-mode run publishes its own PR, so step <n> is refused if that run published one` for each publish step that follows a run step of the same feature (`m` is the latest such run step before `n`).

**Held draft (US-003).** A new type in `job-types.ts`:

```ts
export interface HeldDraft {
  readonly url?: string;
  /** The publish-time open items, in verdict order; empty when there are none or they could not be read. */
  readonly items: readonly { readonly id: string; readonly kind: string }[];
  /** Set when the open items could not be read; `items` is then empty. */
  readonly unreadable?: true;
}
```

`ChatJob` and `JobOutcome` gain an optional `held?: HeldDraft`. For a `run` or `publish` job whose outcome state is `succeeded`, and whose pid-matched status record has `workflow.outcome === "draft"`, `resolveJobOutcome` calls `_jobOutcomeDeps.loadRunVerdict(repoRoot, job.target, _jobOutcomeDeps.resolveOutputDir)`. The items are its `openItems` mapped to `{ id, kind }`. `_jobOutcomeDeps.resolveOutputDir` defaults to `targetOutputDir` from `chat/target-repo.ts`, which already resolves a nax project's output directory for chat. `loadRunVerdict` is imported from `workflow/run-verdict.ts` by relative path with a `biome-ignore lint/style/noRestrictedImports` comment, as `chat/workflow/feature-state.ts` does. The outcome carries `held: { url: workflow.url, items }`. When `loadRunVerdict` rejects, it carries `held: { url: workflow.url, items: [], unreadable: true }`.

The note for both kinds becomes `publish <outcome> <url>` (as `finishOutcome` writes today, now also for `run`), followed by `; held by <N> open <item|items>: <list>` when `held.items` is non-empty, or `; open items unreadable: <error message>` when `held.unreadable` is set. Any existing note follows these segments, joined by `; `, in this order: publish segment, held or unreadable segment, existing note (for example `exit code 1 disagrees with the run record`). A run or publish job whose workflow outcome is anything but `draft` gets no `held`.

One exported helper formats every item list, so the job note, the chain stop reason and the notice agree: `heldItemList(items, { withKinds }): string` in `prompts/builders/workflow-builder.ts`, with the constant `HELD_ITEMS_NAMED = 5`; both `heldItemList` and `HELD_ITEMS_NAMED` are exported from the `@/prompts` barrel. It joins the first 5 entries with `, ` (each `<id> <kind>` when `withKinds` is true, else `<id>`) and appends `, and <K> more` when K entries are left out. The noun is `item` when N is 1 and `items` otherwise, everywhere.

`ChainController.reconcile` stops the chain whenever a step's job ends `succeeded` with `held`, whatever step follows. It calls `stop("step <n> left draft PR <url> held by <N> open <item|items>: <heldItemList(items, { withKinds: false })>")`. With `unreadable` set the tail reads `held by open items that could not be read`; with `items` empty and no `unreadable`, it reads `with no open items listed`. `<url>` and its space are omitted when absent. The chain record's state is then `stopped`; no new chain state is added. The chain stops even when a `bot_review` or `bot_fix` step follows: running bot review before the rulings are posted would record none, and the chain allows each step once. The agent proposes the bot steps itself, after the user's yes on the rulings (US-004).

**Notice guidance (US-004).** `JobNoticeInput` gains `held?: { url?: string; items: readonly { id: string; kind: string }[]; unreadable?: true }`, a structural copy of `HeldDraft` so `prompts` does not import from `chat`. `buildJobNotice` keeps its first two lines. When `held` is present, it adds this line third and leaves out the chain line, because a held draft has stopped the chain:

`The PR is a draft held by <N> open <item|items> (<heldItemList(items, { withKinds: false })>). Do not ask the user to rule on them. Read them with nax workflow status -f <target> --json, then settle each one from evidence as the nax-finish skill's Step 3 does (load it with nax-skills__load when it is listed): verify the item's premise against commits, code and tests, and draft one reply per item whose first line is its ruling keyword (verified:, confirm:, override:, waive: or fixed <sha>) followed by the evidence; findings are left to nax bot fix. Then send the user one message with every drafted reply and the plan (post the replies on their item threads, then nax-jobs__bot_review, then nax-jobs__bot_fix); on their yes, post each reply on its item's thread with gh or glab and propose that chain.`

When `unreadable` is set, the opening reads `The PR is a draft whose open items could not be read.`; when `items` is empty without `unreadable`, it reads `The PR is a draft with no open items listed.`. Both then continue from `Read them with`. `JobRunner` already builds notices from the terminal `ChatJob` record (`buildJobNotice(this.records.get(job.id) ?? terminal)`), so `held` reaches the notice through the record without new wiring.

This line implements the user ruling of 2026-11-17: the agent posts ruling replies on the user's one approval. That replaces slice-2 design §4.7's "agent-only rulings stay with `nax bot fix` and the user". The design document is updated by hand on this branch (see Out of Scope).

### Test placement

No story creates a new test file. Each story adds its tests to the existing test file of the module under test: `test/unit/workflow/publish-only.test.ts`, `test/unit/chat/jobs/jobs-launch.test.ts` (or `jobs-launch-chain.test.ts` for the chain-stop ACs), `test/unit/chat/jobs/chain-tool-card.test.ts`, `test/unit/chat/jobs/job-outcome.test.ts`, `test/unit/chat/jobs/chain-controller.test.ts`, `test/unit/chat/jobs/job-store.test.ts`, `test/unit/chat/jobs/job-runner.test.ts`, `test/unit/tui/chat/layout-job.test.ts`, `test/unit/tui/chat/chat-status.test.ts`, `test/unit/prompts/builders/workflow-builder.test.ts` and `notice-summary.test.ts`. A file that would pass 650 lines is split by describe block into `<module>-<concern>.test.ts`.

### Integration

Read-only symbols, verified on `main` `8a088cb8a`:

- `loadRunVerdict(dir, feature, resolveOutputDir): Promise<LoadedRun>` (`packages/nax/src/workflow/run-verdict.ts:84`). `LoadedRun.openItems: OpenItem[]`; it throws `NaxError` `WORKFLOW_RESULT_MISSING` / `WORKFLOW_NOT_STARTED` when there is no record.
- `OpenItem { id; kind: "finding" | "ruling" | "cannot-verify" | "gate" | "advisor" | "story" | "ci" | "reason"; issue; ... }` (`workflow/types.ts:137`).
- `loadPriorFeature(featureDir, currentRunId): Promise<WorkflowFeatureRecord | null>` (`workflow/feature-record.ts:87`).
- `headSha(repoRoot): Promise<string | null>` (`finish/commit.ts:50`, exported from `@/finish`).
- `WorkflowStatusBlock { step; stories; outcome?; url?; passed?; flagged? }` (`execution/status-file.ts:27`).
- `targetOutputDir(root): Promise<string>` (`chat/target-repo.ts`), the output-dir resolution chat already uses.
- `workflowFeatureDir(projectDir, feature): string` (`workflow/paths.ts:10`), which returns `.nax/features/<feature>/workflow`; `runInContext` passes it to `loadPriorFeature` (`workflow/feature-context.ts:106`).
- `launchJob` (`chat/jobs/jobs-launch.ts:339`): `prepareTarget` runs before `options.chains?.admit(...)`, and `startFailed` is called only on an auto-admitted start failure.
- `ChatChains.summary(): ChainSummary | null`, which carries `next` and `steps[].kind/argv` (`chat/jobs/chain-controller.ts`).

Symbols this feature changes. The baseline only locates the code; it is never the interface to implement:

- `ChatJobKind` — Baseline: `"plan" | "run" | "finish" | "bot_review" | "bot_fix"`. Target: `"plan" | "run" | "publish" | "bot_review" | "bot_fix"`.
- `JOB_ID_PATTERN` — Baseline: `/^(plan|run|finish|bot_review|bot_fix)-[0-9a-f]{8}$/`. Target: accepts `plan|run|publish|finish|bot_review|bot_fix` prefixes (`finish` for legacy records only; `newJobId` never produces it).
- `ChatJob` / `JobOutcome` — Target: each gains `readonly held?: HeldDraft`.
- `JobNoticeInput` — Target: gains the structural `held` field described in Notice guidance.
- `buildJobNotice` — Target: adds the held line third and omits the chain line when `held` is present.
- `buildJobsInstructions` — Target: renames the tool on lines 1 and 8 and the line-6 phrase, with the same 12 lines.
- `isTransientDraft` — Baseline: a private function in `workflow/feature.ts:225`. Target: exported from `workflow/publish-only.ts`, same body.
- `ChainController.reconcile` — Target: the held-draft stop described above, ahead of the `completed` branch.
- `chainReason` (`chat/jobs/chain-tools.ts`) — Target: adds the publish-after-run warning lines.
- `_jobsLaunchDeps` — Target: gains `loadPriorFeature` and `headSha`.
- `_jobOutcomeDeps` — Target: gains `loadRunVerdict` and `resolveOutputDir`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `loadRunVerdict` throws for a draft run or publish job | The outcome keeps `state: "succeeded"`, sets `held: { url, items: [], unreadable: true }`, and its note carries `; open items unreadable: <error message>`. |
| `headSha` returns `null` or rejects, or `loadPriorFeature` returns `null` or rejects | `preparePublish` does not refuse; the launch continues to its card and the workflow's own publish-only checks decide. |
| A stored job record with `kind: "finish"` | Read as `kind: "publish"` with its id unchanged. |
| A publish refusal while no chain is active, or the next chain step is not that publish | The refusal is returned and no chain is stopped. |

## Out of Scope

- Reporting `nax bot fix`'s "Kept as draft" ready-pass result as a held draft: bot jobs' outcome stays exit-code based. Tracked as a follow-up.
- Handing an existing PR to koda for its finish (`nax-flow__send` with a PR) and the agent offering it (#2968 items 6 and 7, koda #477).
- A dedicated tool for posting ruling replies: the agent posts with `gh` or `glab` under the session's Bash permission, after the user's yes.
- Reading live PR thread state for `held.items`: they are the publish-time verdict's open items, not the items still open on the PR.
- A `nax-jobs__finish` alias for the old tool name.
- A new chain state such as `held`, or any change to the chain record schema.
- Updating slice-2 design §4.7 (`docs/superpowers/specs/2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`) to record that the agent posts rulings on the user's one approval: done by hand on this branch, not by the run.
- Changing `buildJobsInstructions` beyond renaming `nax-jobs__finish` to `nax-jobs__publish` on lines 1 and 8 and rewording the line-6 phrase `a publish-only finish` to `a publish-only run`.

## Stories

### US-001 — the chat finish job is renamed publish, and old records stay readable

Workdir: packages/nax. No dependencies.

Rename the job kind, tool, ids, argv tables, card label, footer and job panel command from `finish` to `publish`, and read legacy `finish` records as `publish`.

### US-002 — a publish launch is refused when nothing is left to publish, and the chain card warns

Workdir: packages/nax. Depends on US-001.

Export `isTransientDraft` and add `publishedAtHead` in `workflow/publish-only.ts`. Refuse a publish launch at an already-published HEAD, stop a chain whose next step is that publish, and warn on the chain card when a publish step follows a run of the same feature.

### US-003 — a run or publish that leaves a draft PR records it as held, and a chain does not complete on it

Workdir: packages/nax. Depends on US-001.

Add `HeldDraft` to job outcomes and records, add the shared `heldItemList` formatter, name the open items in the note, and stop the chain on any held draft.

### US-004 — the completion notice tells the agent to draft rulings and ask once

Workdir: packages/nax. Depends on US-003.

Add the held-draft guidance line to `buildJobNotice`.

### Context Files

**US-001**
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/tui/chat/layout-job.ts`

**US-002**
- `packages/nax/src/workflow/publish-only.ts`
- `packages/nax/src/workflow/feature.ts`
- `packages/nax/src/chat/jobs/jobs-launch.ts`
- `packages/nax/src/chat/jobs/chain-tools.ts`
- `packages/nax/src/workflow/paths.ts`

**US-003**
- `packages/nax/src/chat/jobs/job-outcome.ts`
- `packages/nax/src/chat/jobs/chain-controller.ts`
- `packages/nax/src/chat/jobs/job-types.ts`
- `packages/nax/src/chat/target-repo.ts`
- `packages/nax/src/prompts/builders/workflow-builder.ts`

**US-004**
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/job-types.ts`

### Creates

**US-001**
None.

**US-002**
None.

**US-003**
None.

**US-004**
None.

### Modifies

**US-001**
- `packages/nax/test/unit/chat/jobs/chain-tools.test.ts` — the AC-20 tool-name list expects `"finish"` third; the kind is renamed, so it expects `"publish"` third and the rest of the list is unchanged.
- `packages/nax/test/unit/chat/jobs/chain-tool-input.test.ts` — the AC-1 and AC-23 tool-name lists expect `"finish"` third; the kind is renamed, so both expect `"publish"` third and the rest of each list is unchanged.
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — the AC-14 tool-name list and the second tool-name list (near line 418) expect `"finish"` third; the kind is renamed, so both expect `"publish"` third and the rest of each list is unchanged.
- `packages/nax/test/unit/chat/jobs/answer-ask-tool.test.ts` — the AC-3 tool-name list expects `"finish"` third; the kind is renamed, so it expects `"publish"` third and the rest of the list is unchanged.
- `packages/nax/test/unit/chat/jobs/jobs-provider.test.ts` — the tool-name list expects `"finish"` third; the kind is renamed, so it expects `"publish"` third and the rest of the list is unchanged.
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — the schema row `["finish", ...]`, the AC-1 launch-tool list and the two #2819 tests launch kind `"finish"`; the kind is renamed, so they use `"publish"`. The pending-stories refusal text and the `nax run f1 --publish-only` card summary are unchanged.
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts` — the `CHAIN_STEP_FIELDS` expectation has a `finish` key and the #2819 test builds a `finish` step; the kind is renamed, so the key and the step kind are `publish` and the expected argv is unchanged.
- `packages/nax/test/unit/chat/jobs/job-argv.test.ts` — the two #2819 tests build and parse kind `"finish"`; the kind is renamed, so they use `"publish"` and the expected argv and parsed input are unchanged apart from the kind.
- `packages/nax/test/unit/chat/jobs/job-outcome.test.ts` — three #2819 tests use the finish kind: the two `resolveJobOutcome` tests on `{ kind: "finish", id: "finish-1a2b3c4d" }` and the `readRunProgress` test on `job({ kind: "finish" })`; the kind is renamed, so they use `{ kind: "publish", id: "publish-1a2b3c4d" }` and `job({ kind: "publish" })` with the same expected state, note and progress.
- `packages/nax/test/unit/chat/jobs/workflow-defaults.test.ts` — the `finish` helper builds kind `"finish"`; the kind is renamed, so it builds `"publish"` and the AC-4 expectation (run profiles, `chat.workflow.run`) is unchanged.
- `packages/nax/test/unit/prompts/builders/workflow-builder.test.ts` — the `test.each` list names `nax-jobs__finish`; the tool is renamed, so it names `nax-jobs__publish`.
- `packages/nax/test/unit/prompts/builders/workflow-builder-chain.test.ts` — the AC-4..AC-8 first line and the #2819 line-8 assertion name `nax-jobs__finish`; the tool is renamed, so they name `nax-jobs__publish`, and the line count of 12 and every other line are unchanged.
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — the `#2819 finish` row uses `kind: "finish"` and expects `finish f1 $0.50`; the kind is renamed, so it uses `kind: "publish"` and expects `publish f1 $0.50`.

**US-002**
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` — the publish launch tests stub only `_jobsLaunchDeps.git`, so the new `loadPriorFeature` and `headSha` deps would read real run records and spawn real git; the file's `beforeEach` stubs `_jobsLaunchDeps.loadPriorFeature` to resolve `null` and `_jobsLaunchDeps.headSha` to resolve `null`, its existing `afterEach` restore covers both, and every existing expectation is unchanged.

**US-003**
- `packages/nax/test/unit/chat/jobs/job-outcome.test.ts` — the #2819 test whose status workflow is a draft with a pull URL expects the exact note "publish draft" plus that URL; a draft outcome now reads its open items, so the test stubs `_jobOutcomeDeps.loadRunVerdict` to resolve a run with no open items, keeps the same exact note, and restores the stub afterwards.

**US-004**
None. `buildJobNotice` output is unchanged when `held` is absent, and no existing notice test passes `held`.

### Seams

- US-002 creates `publishedAtHead`; `preparePublish` consumes it. US-002's `launchJob` ACs, with stubbed `_jobsLaunchDeps.loadPriorFeature` and `_jobsLaunchDeps.headSha`, pin the call site.
- US-003 creates `heldItemList`; the job note, the chain stop reason and US-004's notice consume it. US-003's note and stop-reason ACs pin the first two.
- US-003 adds `held` to `ChatJob`; `ChainController.reconcile` consumes it. US-003's chain ACs drive the controller through the jobs `onChange` notification with a terminal job carrying `held`.
- US-004 reads `held` in `buildJobNotice`; `JobRunner` builds the notice from the terminal record. US-004's runner AC enters at the child-exit path with `_jobOutcomeDeps` stubbed and asserts the queued notice.

## Acceptance Criteria

### US-001

1. [unit] `createJobsProvider(options).tools(root)` returns launch tools whose `localName`s start with `plan`, `run`, `publish`, `bot_review`, `bot_fix`, in that order, and no tool has `localName` `finish`.
2. [unit] `buildJobArgv({ kind: "publish", feature: "f1", profiles: ["a"] }, ctx)` returns the same argv the `finish` kind returned before the rename: the nax entry, then `run`, `f1`, `--publish-only` and the profile arguments.
3. [unit] `parseJobInput("publish", { feature: "f1", profiles: ["a"] })` returns `{ kind: "publish", feature: "f1", profiles: ["a"] }`.
4. [unit] `newJobId("publish")` returns a string matching `/^publish-[0-9a-f]{8}$/`, and `JOB_ID_PATTERN` accepts it.
5. [unit] `JOB_ID_PATTERN` accepts `finish-1a2b3c4d`.
6. [unit] `readJobRecords(outputDir)` over a store holding one valid record with `id: "finish-1a2b3c4d"` and `kind: "finish"` returns one record with `kind: "publish"` and `id: "finish-1a2b3c4d"`.
7. [unit] `writeJobRecord(outputDir, job)` with `id: "publish-1a2b3c4d"` and `kind: "publish"` writes `publish-1a2b3c4d.json`, and `readJobRecords` returns it with `kind: "publish"`.
8. [unit] `isFeatureJobKind("publish")` and `isRunJobKind("publish")` both return true.
9. [unit] `applyWorkflowDefaults` for a `publish` input with empty profiles and `chat.workflow.run.profiles` `["r1"]` returns profiles `["r1"]` and `profilesFrom` `chat.workflow.run`.
10. [unit] `buildChainStepArgv({ kind: "publish", feature: "f1", profiles: ["p"] }, ctx)` returns the argv ending `run`, `f1`, `--publish-only` with the profile arguments, and `CHAIN_STEP_FIELDS.publish` equals `["feature", "profiles", "repo"]`.
11. [unit] The `nax-jobs__chain` approval card for one `publish` step on feature `f1` shows the step line beginning `1. nax run f1 --publish-only`.
12. [unit] `resolveJobOutcome` for `{ kind: "publish", id: "publish-1a2b3c4d" }`, with a pid-matched completed status whose workflow is `{ outcome: "ready", url: "https://x/pull/7" }`, returns `state: "succeeded"` and note `publish ready https://x/pull/7`.
13. [unit] The job panel's command text for a publish job with target `f1` is `nax run f1 --publish-only`.
14. [unit] The footer job strip renders a running publish job with target `f1` and cost `0.5` as `publish f1 $0.50`.
15. [unit] The first line of `buildJobsInstructions()` names `nax-jobs__publish` and not `nax-jobs__finish`.
16. [unit] The eighth line of `buildJobsInstructions()` contains `` `nax-jobs__publish` publishes it ``, and `buildJobsInstructions()` still has 12 lines.
17. [unit] The sixth line of `buildJobsInstructions()` contains `nax run (including a publish-only run)`.

### US-002

1. [unit] `publishedAtHead(prior, "h1")`, with `prior` a `WorkflowFeatureRecord` built by `newFeatureRecord` and overridden to `{ step: "done", head: "h1", outcome: "draft", url: "https://x/pull/7", ci: "green", reasons: [] }`, returns `{ outcome: "draft", url: "https://x/pull/7" }`.
2. [unit] `publishedAtHead(prior, "h1")` with the same `prior` but `outcome: "ready"` returns `{ outcome: "ready", url: "https://x/pull/7" }`.
3. [unit] `publishedAtHead(prior, "h2")` with `prior.head: "h1"` returns `undefined`.
4. [unit] `publishedAtHead(prior, undefined)` and `publishedAtHead(prior, "")` with `prior.head: "h1"` both return `undefined`.
5. [unit] `publishedAtHead(null, "h1")` returns `undefined`.
6. [unit] `publishedAtHead(prior, "h1")` with `prior.step: "publish"` and `prior.head: "h1"` returns `undefined`.
7. [unit] `publishedAtHead(prior, "h1")` with `prior.outcome: "local-only"` and `prior.head: "h1"` returns `undefined`.
8. [unit] `publishedAtHead(prior, "h1")` with `prior.outcome: "draft"`, `prior.ci: "unavailable"` and `prior.head: "h1"` returns `undefined`, because `isTransientDraft` returns true for that record.
9. [unit] `isTransientDraft` imported from `workflow/publish-only.ts` returns true for `{ outcome: "draft", ci: "pending", reasons: ["CI pending"] }` and false for `{ outcome: "draft", ci: "green", reasons: ["open items"] }` (both built by `newFeatureRecord` with those overrides).
10. [integration] `launchJob` for kind `publish`, feature `f1`, over a PRD whose stories have all passed, with `_jobsLaunchDeps.loadPriorFeature` returning a `newFeatureRecord` record overridden to `{ step: "done", head: "abcdef0123", outcome: "draft", url: "https://x/pull/7", ci: "green", reasons: [] }` and `_jobsLaunchDeps.headSha` returning `"abcdef0123"`, returns `isError: true` with content `[chat] f1 is already published at HEAD abcdef0 as a draft PR https://x/pull/7; nothing to publish: use nax-jobs__bot_review for its open items`, and the approve callback is not called.
11. [integration] `launchJob` for kind `publish` with `_jobsLaunchDeps.headSha` returning `abcdef0123` and `_jobsLaunchDeps.loadPriorFeature` returning a done draft record at head `abcdef0123` with no `url`, returns content `[chat] f1 is already published at HEAD abcdef0 as a draft PR; nothing to publish: use nax-jobs__bot_review for its open items`.
12. [integration] `launchJob` for kind `publish` with `_jobsLaunchDeps.headSha` returning `null` calls the approve callback with summary `nax run f1 --publish-only`.
13. [integration] `launchJob` for kind `publish` with `_jobsLaunchDeps.loadPriorFeature` rejecting with an `Error` calls the approve callback with summary `nax run f1 --publish-only`, and so does a launch with `_jobsLaunchDeps.headSha` rejecting with an `Error`.
14. [integration] `launchJob` for kind `publish`, refused with `_jobsLaunchDeps.loadPriorFeature` returning a done draft record at head `abcdef0123` with url `https://x/pull/7` and `_jobsLaunchDeps.headSha` returning `abcdef0123`, while the active chain's next step (index `summary().next - 1` of `chains.active().steps`) is a `publish` step with target `f1`, calls `chains.stop` once with `f1 is already published at HEAD abcdef0 as a draft PR https://x/pull/7; nothing to publish: use nax-jobs__bot_review for its open items`.
15. [integration] `launchJob` for kind `publish`, refused with `_jobsLaunchDeps.loadPriorFeature` returning a done draft record at head `abcdef0123` with url `https://x/pull/7` and `_jobsLaunchDeps.headSha` returning `abcdef0123`, while no chain is active, does not call `chains.stop`.
16. [integration] `launchJob` for kind `publish`, refused with `_jobsLaunchDeps.loadPriorFeature` returning a done draft record at head `abcdef0123` with url `https://x/pull/7` and `_jobsLaunchDeps.headSha` returning `abcdef0123`, while the active chain's next step is a `bot_review` step, does not call `chains.stop`.
17. [integration] `launchJob` for kind `publish`, feature `f1`, with `_jobsLaunchDeps.headSha` returning `abcdef0123` and `_jobsLaunchDeps.loadPriorFeature` left at its default, over a repo whose `.nax/features/f1/workflow/run-1/result.json` holds `schemaVersion: 1`, `stories: {}` and a `featureWorkflow` record built by `newFeatureRecord` and overridden to `{ step: "done", head: "abcdef0123", outcome: "draft", url: "https://x/pull/7", ci: "green", reasons: [] }`, returns `isError: true` with content starting `[chat] f1 is already published at HEAD abcdef0`.
18. [unit] The `nax-jobs__chain` tool, given steps `run f1` then `publish f1`, calls the approve callback with a reason containing `warning: step 2 publishes f1 after step 1 runs it; a workflow-mode run publishes its own PR, so step 2 is refused if that run published one`.
19. [unit] The `nax-jobs__chain` tool, given steps `run f1` then `publish f2`, calls the approve callback with a reason that contains no line starting `warning: step 2 publishes`.

### US-003

1. [unit] `resolveJobOutcome` for a `run` job with a pid-matched completed status whose workflow is `{ outcome: "draft", url: "https://x/pull/7" }`, and `_jobOutcomeDeps.loadRunVerdict` returning open items `D-1` (advisor) and `US-003` (cannot-verify), returns `state: "succeeded"` and `held: { url: "https://x/pull/7", items: [{ id: "D-1", kind: "advisor" }, { id: "US-003", kind: "cannot-verify" }] }`.
2. [unit] The same outcome's note equals `publish draft https://x/pull/7; held by 2 open items: D-1 advisor, US-003 cannot-verify`.
3. [unit] `resolveJobOutcome` for a `publish` job under the same status and stub returns the same `held` and note.
4. [unit] `resolveJobOutcome` with `_jobOutcomeDeps.loadRunVerdict` returning seven open items `I-1`..`I-7` of kind `finding` returns a note ending `held by 7 open items: I-1 finding, I-2 finding, I-3 finding, I-4 finding, I-5 finding, and 2 more`, and `held.items` has seven entries.
5. [unit] `resolveJobOutcome` for a `run` job whose pid-matched completed status has workflow `{ outcome: "ready", url: "https://x/pull/7" }` returns no `held`, the note `publish ready https://x/pull/7`, and does not call `_jobOutcomeDeps.loadRunVerdict`.
6. [unit] `resolveJobOutcome` for a `run` job whose pid-matched status has no workflow block returns no `held` and does not call `_jobOutcomeDeps.loadRunVerdict`.
7. [unit] `resolveJobOutcome` for a `run` job whose run record has status `failed` and workflow `{ outcome: "draft" }` returns `state: "failed"` and no `held`.
8. [unit] `resolveJobOutcome` for a draft `run` job with `_jobOutcomeDeps.loadRunVerdict` rejecting with `Error("no workflow result")` returns `state: "succeeded"`, `held: { url: "https://x/pull/7", items: [], unreadable: true }` and the note `publish draft https://x/pull/7; open items unreadable: no workflow result`.
9. [unit] `resolveJobOutcome` passes `_jobOutcomeDeps.loadRunVerdict` the repo root, the job's target as the feature, and `_jobOutcomeDeps.resolveOutputDir`.
10. [unit] `resolveJobOutcome` for a draft `run` job with zero open items from `loadRunVerdict` returns `held: { url: "https://x/pull/7", items: [] }` with no `unreadable` field, and the note `publish draft https://x/pull/7`.
11. [unit] `resolveJobOutcome` for a draft `run` job with exit code 1, a completed run record and one open item `D-1` (advisor) returns the note `publish draft https://x/pull/7; held by 1 open item: D-1 advisor; exit code 1 disagrees with the run record`.
12. [unit] `heldItemList([{ id: "D-1", kind: "advisor" }, { id: "D-2", kind: "advisor" }], { withKinds: false })` returns `D-1, D-2`, and with `{ withKinds: true }` returns `D-1 advisor, D-2 advisor`.
13. [unit] `heldItemList` over seven items `I-1`..`I-7` of kind `finding` with `{ withKinds: false }` returns `I-1, I-2, I-3, I-4, I-5, and 2 more`, and `HELD_ITEMS_NAMED` equals 5.
14. [integration] A chain controller with an active two-step chain (`run f1`, then `publish f1`), whose step-2 job turns `succeeded` with `held: { url: "https://x/pull/7", items: [{ id: "D-1", kind: "advisor" }] }` and fires the jobs change notification, ends with chain state `stopped` and stop reason `step 2 left draft PR https://x/pull/7 held by 1 open item: D-1`.
15. [integration] The same chain with a step-2 job that turns `succeeded` with no `held` ends with chain state `completed`.
16. [integration] A chain controller with an active chain (`run f1`, then `bot_review`), whose step-1 job turns `succeeded` with `held: { url: "https://x/pull/7", items: [{ id: "D-1", kind: "advisor" }] }`, ends with chain state `stopped` and stop reason `step 1 left draft PR https://x/pull/7 held by 1 open item: D-1`.
17. [integration] A chain whose last-step job turns `succeeded` with `held: { items: [] }`, no url and no `unreadable`, ends `stopped` with stop reason `step 1 left draft PR with no open items listed`.
18. [integration] A chain whose last-step job turns `succeeded` with `held: { items: [], unreadable: true }` and no url ends `stopped` with stop reason `step 1 left draft PR held by open items that could not be read`.
19. [integration] A chain whose last-step job carries `held` with seven items `I-1`..`I-7` ends with a stop reason ending `held by 7 open items: I-1, I-2, I-3, I-4, I-5, and 2 more`.
20. [integration] After a held-draft stop, the chain record written through the chain store has state `stopped` and the same stop reason.

### US-004

1. [unit] `buildJobNotice` with `kind: "run"`, `target: "f1"`, `state: "succeeded"` and `held: { url: "https://x/pull/7", items: [{ id: "D-1", kind: "advisor" }, { id: "D-2", kind: "advisor" }] }` returns three lines, and the third line starts `The PR is a draft held by 2 open items (D-1, D-2). Do not ask the user to rule on them.`
2. [unit] That third line contains `nax workflow status -f f1 --json`.
3. [unit] That third line names the nax-finish skill's Step 3 and `nax-skills__load`.
4. [unit] That third line names the ruling keywords `verified:`, `confirm:`, `override:`, `waive:` and `fixed <sha>`, and says findings are left to `nax bot fix`.
5. [unit] That third line says to send the user one message with every drafted reply and the plan naming `nax-jobs__bot_review` then `nax-jobs__bot_fix`, and, on their yes, to post each reply on its item's thread with `gh` or `glab`.
6. [unit] `buildJobNotice` with `held: { items: [], unreadable: true }` returns a third line starting `The PR is a draft whose open items could not be read. Read them with nax workflow status -f f1 --json`.
7. [unit] `buildJobNotice` with `held: { items: [] }` and no `unreadable` returns a third line starting `The PR is a draft with no open items listed. Read them with nax workflow status -f f1 --json`.
8. [unit] `buildJobNotice` with `held` carrying seven items `I-1`..`I-7` returns a third line containing `held by 7 open items (I-1, I-2, I-3, I-4, I-5, and 2 more)`.
9. [unit] `buildJobNotice` with `held` carrying one item and `chainId: "chain-1a2b3c4d"`, `chainStep: 2` returns exactly three lines, the held line third, and no line containing `call the next step's launch tool`.
10. [unit] `buildJobNotice` without `held` returns exactly the lines it returned before this feature for the same input, with and without a chain id.
11. [integration] A job runner whose `run` child exits 0, with `_jobOutcomeDeps.readStatusFile` returning a pid-matched completed status with workflow `{ outcome: "draft", url: "https://x/pull/7" }` and `_jobOutcomeDeps.loadRunVerdict` returning one open item `D-1` (advisor), queues a notice whose text contains `The PR is a draft held by 1 open item (D-1)`.
