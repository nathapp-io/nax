# SPEC: chat-flow-handoff — a chat chain hands a run feature to koda before publishing, so koda publishes and finishes it

Closes: #2968

## Summary

A `nax chat` chain can end in a new step, `handoff`, instead of `publish`. The chain's `run` step runs with a new `nax run --publish none` override, so the feature ends `local-only` and nothing is published. The `handoff` step then calls `nax-flow__send` in a new handoff form. The tool collects the feature's git-excluded workflow run record, checks locally every precondition koda will check, pushes the branch, and creates a koda flow whose body carries the branch, the head commit and the record. koda then publishes the PR under its own identity (`nax run --publish-only` on its runner) and finishes it through its REVIEW, RULE and FIX steps. A successful handoff writes a `handoff.json` mark beside the newest run's `result.json`; `nax run --publish-only` and the chat `publish` launch refuse a feature whose newest run carries that mark, so a handed-off feature never gets a second publisher.

This is the nax half of koda #477 (items 6 and 7 of #2968). The koda half, which accepts the handoff body, merged as koda PR #478.

## Motivation

The 2026-11-04 ruling splits the work: koda owns the always-on flow, including the finish (rulings, then ready); a chat chain is the tool for one feature watched in one sitting. A feature planned and run in a chat chain ends as a draft PR held by open items, and the only ways to finish it are by hand or by re-running the whole flow from its spec in koda.

koda cannot adopt that draft, because nax trusts only its own login: `readItemThreads` reads the item index through `ownComments(comments, login)` (`packages/nax/src/forge/marker.ts`), and a koda bot's `nax bot fix` reports `no nax item index on this PR` (`packages/nax/src/bot/workflow-ready.ts`) for a PR the owner's account published. The owner therefore ruled (koda design `docs/superpowers/specs/2026-11-17-flow-handoff-design.md`, APPROVED 2026-11-17): **hand over before publishing**, and **upload the run record with the handoff request**, because `.nax/features/<feature>/workflow/` is git-excluded and exists only on the machine that ran the chain.

nax already has the two halves of the mechanism: `workflow.publish` (`pr | push | none`) lets a run end without a PR, and `nax run --publish-only` (#2819) publishes such a run later from its record. What is missing is a per-run way to say "do not publish", a chain step that sends the record, and a guard against publishing locally after the handoff.

## Design

### Owner rulings (2026-11-18)

1. The chain's run step is told not to publish by a new `nax run --publish <pr|push|none>` flag that overrides `workflow.publish` for that run. Before a handoff the run passes `none`: it ends `local-only` at once, the handoff pushes the branch, and koda's publish-only run does the CI wait.
2. Inside an approved chain the handoff step runs without a second card, like every other chain step. A direct `nax-flow__send` handoff call outside a chain keeps its card. koda's own approval still gates anything billed.
3. The handed-off mark is a sidecar file, `workflow/<runId>/handoff.json`, beside the newest run's `result.json`. It is never uploaded (koda accepts only `result.json` and `ledger.md`) and it leaves `result.json` and its mtime unchanged.

### Approach

**`--publish` (US-001).** `nax run` gains `--publish <mode>`. A new module `packages/nax/src/cli/run-publish-override.ts` maps the flag to a CLI override, mirroring `run-context-overrides.ts`:

```ts
/** The `workflow` block of `cliOverrides`, `undefined` when the flag was not passed, or the refusal text. */
export function resolvePublishCliOverride(
  value: string | undefined,
): { readonly workflow: { readonly publish: WorkflowPublishMode } } | { readonly error: string } | undefined;
```

`bin/nax.ts` declares `.option("--publish <mode>", "Override workflow.publish for this run: pr, push or none")` on `nax run`, and `RunActionOptions` (`bin/run-action.ts`) gains `publish?: string`. The `nax run` action in `bin/nax.ts` calls `resolvePublishCliOverride(options.publish)` before `resolveRunProjectContext`: an `{ error }` result is printed with `console.error` and the process exits with code 1, so nothing loads or starts. `resolveRunProjectContext` sets `cliOverrides.workflow` from a non-error result. The CLI layer deep-merges last, so every other `workflow` key keeps its configured value. `--publish` combines with `--publish-only`, where it selects the publish depth of the rerun; `publishOnlyRefusal` does not refuse the combination.

The chat `run` job gains an optional `publish` field (`"pr" | "push" | "none"`), accepted by `nax-jobs__run` and by a chain `run` step (`CHAIN_STEP_FIELDS.run`). `buildJobArgv` appends `--publish <mode>` after the `--max-cost` arguments when it is set, and omits it otherwise.

**The handoff record (US-002).** A new module `packages/nax/src/workflow/handoff-record.ts` reads and checks what a handoff sends:

```ts
export interface HandoffRecordFile {
  readonly runId: string;
  readonly file: "result.json" | "ledger.md";
  readonly mtimeMs: number;
  readonly content: string;
}
export const HANDOFF_MAX_RUNS = 20;
export const HANDOFF_RECORD_MAX_BYTES = 524288;
export type HandoffRecordRead =
  | { readonly ok: true; readonly record: readonly HandoffRecordFile[]; readonly newestRunId: string }
  | { readonly ok: false; readonly reason: string };
/** True when koda stores the text: no NUL character and no unpaired UTF-16 surrogate. */
export function isStorableRecordText(text: string): boolean;
/** The files of every run that has a result.json, with the shape limits applied (US-002). */
export function readHandoffRecordFiles(featureWorkflowDir: string): Promise<HandoffRecordRead>;
/** readHandoffRecordFiles, then the newest feature record and the PRD at head checked against koda's rules (US-003). */
export function collectHandoffRecord(input: {
  readonly repoRoot: string;
  readonly feature: string;
  readonly head: string;
  readonly branch: string;
}): Promise<HandoffRecordRead>;
```

`readHandoffRecordFiles` lists the run directories under the given workflow dir that hold a `result.json`. For each it adds a `result.json` entry and, when the directory also holds `ledger.md`, a `ledger.md` entry; `content` is the file's UTF-8 text and `mtimeMs` is `Math.trunc` of the file's `stat` mtime. Entries are ordered newest run first (by `result.json` mtime, the order `runDirsNewestFirst` uses), `result.json` before `ledger.md` within a run. The newest run and the tie check use the truncated integer `mtimeMs` that is sent, because koda compares those integers: two runs whose `result.json` mtimes truncate to the same largest value are a tie, even when their float mtimes differ. Every `content` must be text koda stores: a NUL character or an unpaired UTF-16 surrogate is refused. The limits are koda's (`packages/fleet-protocol/src/index.ts` in koda): `HANDOFF_MAX_RUNS` distinct run ids, and `HANDOFF_RECORD_MAX_BYTES` as the sum of the UTF-8 byte lengths of every `content`. `readHandoffRecordFiles` applies the shape rows of the Failure Handling table (no run, run count, tie, content text, byte cap) in that order. `collectHandoffRecord` calls it on `workflowFeatureDir(repoRoot, feature)` and, on success, applies the feature-record and PRD rows in table order. Both stop at the first failing check.

The newest run's `result.json` must parse to an object with `schemaVersion: 1` and a `featureWorkflow` whose `step` is `"done"`, whose `outcome` is `"pushed"` or `"local-only"`, and whose `head` equals `input.head`: these are `publishOnlyStart`'s preconditions and koda's. A done record with no `outcome` is not a finished feature record. The PRD is read at `input.head`, because koda reads it at the pushed head: `_handoffRecordDeps.git(["show", `${head}:${prdPath}`], repoRoot)`, where `prdPath` is `relative(repoRoot, join(featureDir(repoRoot, feature), "prd.json"))` (the `featureDir` SSOT, never a `.nax/features` literal) and `_handoffRecordDeps = { git: gitWithTimeout }` is the module's exported stub seam, the pattern `_configChangeDeps.git` uses in `workflow/config-change.ts:132`. A non-zero exit means the file is not committed at that head. The stdout must parse as a JSON object with a `userStories` array whose entries are all objects, else it is not a PRD (koda's `readHandoffPrd` skips non-object entries; nax refuses them, because `pendingStoryIds` cannot read them). Its `branchName` must equal `input.branch`, and `pendingStoryIds` of it must be empty.

**The mark (US-003).** A new module `packages/nax/src/workflow/handoff-mark.ts`:

```ts
export const HANDOFF_MARK_FILE = "handoff.json";
export interface HandoffMark {
  readonly schemaVersion: 1;
  readonly at: string;
  /** Set when koda created the flow. */
  readonly flowId?: string;
  readonly url?: string;
  /** Set when koda held the create for approval. */
  readonly requestId?: string;
  /** Set when the branch was pushed but koda's answer never arrived (timeout, unreachable, cancelled during the create). */
  readonly outcomeUnknown?: true;
}
export function writeHandoffMark(runDir: string, mark: HandoffMark): Promise<void>;
/** The mark on the feature's newest run (by result.json mtime), or null when that run has none or it does not parse. */
export function readNewestHandoffMark(featureWorkflowDir: string): Promise<{ readonly mark: HandoffMark; readonly path: string } | null>;
/** One sentence naming the flow or request and the mark's path, used by every refusal. */
export function handoffMarkRefusal(feature: string, found: { readonly mark: HandoffMark; readonly path: string }): string;
```

`handoffMarkRefusal` returns `<feature> was handed off to koda (<what>) at <at>; koda publishes it. Delete <path> to publish it here instead`, where `<what>` is `flow <flowId> <url>` when `flowId` is set, `approval request <requestId>` when `requestId` is set, and `outcome unknown; check koda's flows first` when `outcomeUnknown` is set. The mark lives on the newest run only, so a later `nax run` that writes a newer `result.json` leaves the old mark behind on an older run and the feature is publishable again, as the design states.

Two consumers refuse a marked feature:

- `runInContext` (`packages/nax/src/workflow/feature.ts`): when `input.publishOnly === true` and `readNewestHandoffMark(fc.featureDir)` finds a mark, it throws `NaxError` `WORKFLOW_PUBLISH_ONLY_REFUSED` with message `[workflow] --publish-only: <handoffMarkRefusal text>`, before `publishOnlyStart` is consulted.
- `preparePublish` (`packages/nax/src/chat/jobs/jobs-launch.ts`): after the pending-story guard and before `publishedRefusal`, a found mark returns `{ error: "[chat] " + handoffMarkRefusal(...), publishedAtHead: true }`. The `publishedAtHead: true` flag routes the refusal through `stopRefusedPublishStep`, so a chain whose next step is that publish stops instead of waiting. It reads through a new `_jobsLaunchDeps.readNewestHandoffMark`.

**The handoff form of `nax-flow__send` (US-004).** The tool input takes either `features` (today's spec form, unchanged) or `handoff`, never both:

```json
{ "handoff": { "feature": "chat-layout-overflow" }, "roles": { "reviewer": "acp:claude", "supervisor": "acp:claude" }, "costCapUsd": 5 }
```

`FLOW_SEND_INPUT_SCHEMA` gains a `handoff` property (an object with one required string `feature`) and drops `features` from `required`; the runtime parser enforces exactly one of the two. A new module `packages/nax/src/chat/flow/flow-handoff-input.ts` exports:

```ts
export interface FlowHandoffInput {
  readonly feature: string;
  readonly roles: FlowSendRoles;
  readonly costCapUsd: number;
}
export function parseFlowHandoffInput(raw: Record<string, unknown>): FlowHandoffInput | { readonly errors: string[] };
/** The token list a chain step and the tool call are compared by. */
export function handoffStepArgv(input: FlowHandoffInput): readonly string[];
```

`parseFlowHandoffInput` applies `FLOW_FEATURE_NAME_RE` to `feature` and reuses the role and cost-cap checks `parseFlowSendInput` applies today (moved into shared helpers, not copied); its allowed top-level keys are `handoff`, `roles`, `costCapUsd`, and `handoff` allows only `feature`. `TOP_LEVEL_KEYS` in `flow-input.ts` gains `handoff`, so the key never reads as unknown. `parseFlowSendInput` returns its existing errors for a spec-form body and refuses a body with both keys or neither with the error `exactly one of features or handoff is required`.

The tool's `run` routes before any parse: a body with `handoff` and no `features` (`Object.hasOwn`) goes to the handoff send; every other body goes to `parseFlowSendInput` and today's spec-form send, which refuses both-or-neither. `handoffStepArgv` returns `["nax-flow__send", "--handoff", feature, "--reviewer", reviewer, "--supervisor", supervisor, "--cost-cap", String(costCapUsd)]`.

The handoff send, in a new module `packages/nax/src/chat/flow/flow-handoff.ts`, runs in this order:

1. Parse. Errors return the existing `[chat] the flow request is invalid:` list.
2. `readFlowRepoState(repoRoot, [])` (branch, clean tree with untracked files counted, head sha, normalised remote), then `checkFlowBranch(branch, [])`.
3. `collectHandoffRecord({ repoRoot, feature, head: state.sha, branch: state.branch })`; a refusal returns `[chat] cannot hand off <feature>: <reason>`.
4. `readNewestHandoffMark`; a found mark returns `[chat] ` + `handoffMarkRefusal(...)`.
5. Approval: when `chains.admit({ kind: "handoff", argv: handoffStepArgv(input) })` answers `auto`, no card is shown; otherwise the card is shown, carrying the admission's `note` when there is one. The card's summary is `hand <feature> over to koda`, its command is `git push --set-upstream origin <branch>`, and its reason lists the repository line, `feature <feature>: <N> run(s), <B> bytes of run record` (N is the number of distinct run ids, B the UTF-8 byte total), the roles, the cost cap and the billing note.
6. On allow (or auto admission): the spec form's post-allow sequence, which now returns `PostAllowResult = { readonly result: ToolResult; readonly created?: FlowCreateOutcome; readonly unknown?: true }` (`created` set on a 201 or 202 answer, `unknown` set when the push happened and koda's answer was lost or unusable: error codes `MEMORY_KODA_TIMEOUT`, `MEMORY_KODA_UNREACHABLE`, `MEMORY_KODA_ABORTED`, `FLOW_KODA_UNEXPECTED_RESPONSE`, `MEMORY_KODA_BAD_RESPONSE`); the spec form uses only `result`. It runs (re-check that HEAD and tree are unchanged, push target, push destination, `commitAndPush` with `skipCommit`, create), with an empty spec-path list for the push-target re-read and the handoff body below.
7. On a created or held answer: `writeHandoffMark(<newest run dir>, { schemaVersion: 1, at, flowId, url } | { schemaVersion: 1, at, requestId })`, then the result text. When `unknown` is set (the branch is pushed and koda may have the flow): `writeHandoffMark(<newest run dir>, { schemaVersion: 1, at, outcomeUnknown: true })`, then the existing spec-form message. A mark write failure does not change the result; it appends `; the local handoff mark could not be written (<message>), so nothing stops a local publish of <feature>`.
8. When the send was auto-admitted, `chains.stepEnded(chainId, step, "succeeded" | "failed", note)` reports the outcome: `succeeded` for a created or held answer, `failed` with the result text for every other outcome after admission, the outcome-unknown answers included.

A refusal at steps 1 to 4, while `chains.active()` has a next step of kind `handoff` whose target is this feature, stops that chain with the refusal text without its `[chat] ` prefix, the same rule `stopRefusedPublishStep` applies to a publish. After an auto admission, `stepEnded` is called exactly once in a `finally`, so a thrown error ends the step `failed` with `flow send failed: <message>`.

Every collaborator of the handoff send is behind an exported `_flowHandoffDeps = { collectHandoffRecord, readNewestHandoffMark, writeHandoffMark, now }` in `flow-handoff.ts`, re-exported from `chat/flow/index.ts`; the push, repo reads and koda create stay on `_flowProviderDeps`.

The body sent to koda (the contract in koda `.nax/features/flow-handoff/spec.md` § Wire shape):

```ts
export interface FlowHandoffCreateBody {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly roles: FlowSendRoles;
  readonly costCapUsd: number;
  readonly handoff: { readonly feature: string; readonly headSha: string; readonly record: readonly HandoffRecordFile[] };
}
```

`createKodaFlow`'s `body` parameter widens to `FlowCreateBody | FlowHandoffCreateBody`; its 201/202 handling is unchanged. `flow-provider.ts` is at 540 lines of the 600-line cap, so the handoff path lives in `flow-handoff.ts` and the spec-form helpers it reuses (card text escaping, push destination, the post-allow sequence, koda failure messages) move out of `flow-provider.ts` into a new `flow-send-steps.ts` that both import. To keep one stub target without an import cycle, the `_flowProviderDeps` object moves to a new leaf module `flow-deps.ts` that `flow-provider.ts`, `flow-send-steps.ts` and `flow-handoff.ts` all import; `flow-provider.ts` re-exports that same object, so every existing `_flowProviderDeps` stub in `flow-provider.test.ts`, `flow-provider-cancel.test.ts` and `chat-host-jobs.test.ts` still replaces what the moved helpers call. The moved push-target re-check takes the spec paths as a parameter instead of reading them from a `FlowSendInput`. The constants the moved code uses move with it into `flow-send-steps.ts`: `FLOW_PUSH_COMMIT_MESSAGE`, `BILLING_NOTE`, `TOOL_NAME`, and the declined, cancelled, branch-changed and push-target-moved messages. `flow-provider.ts` imports them from there and re-exports `FLOW_PUSH_COMMIT_MESSAGE`, which `chat/flow/index.ts` and the tests import. No value import runs from `flow-send-steps.ts` or `flow-deps.ts` back to `flow-provider.ts`, so `check:import-cycles` gains no module. `createFlowProvider`'s options gain `chains?: ChatChains`, and `createHostJobs` (`packages/nax/src/chat/jobs/jobs-host.ts`) passes its controller.

`buildFlowInstructions` (`packages/nax/src/prompts/builders/flow-builder.ts`) gains one line: `` For a feature already run in this chat that should be published and finished by koda, call `nax-flow__send` with `handoff: { feature }` instead of `features`; its run must have ended without a PR (`publish: "none"`). ``

**The chain step `handoff` (US-005).** `ChainStep.kind` widens to `ChainStepKind = ChatJobKind | "handoff"`. A handoff step's input is `{ feature, roles, costCapUsd }`. `parseStep` (`chain-tools.ts`) branches on `kind === "handoff"` before `parseChainStepInput`: it parses the input with `parseFlowHandoffInput({ handoff: { feature }, roles, costCapUsd })`, accepts no `repo` and no `checkBefore`, and skips `resolveStepTarget` (a handoff always runs in the chat's repo root); its `argv` is `handoffStepArgv(input)` and its `target` is the feature. The card line reads reviewer, supervisor and cap back from the argv tokens that follow `--reviewer`, `--supervisor` and `--cost-cap`. `resolveChainProposal` refuses a proposal, naming the step, when:

- it has a handoff step and the jobs provider has no koda connection (`JobsProviderOptions.handoffAvailable` is not true): `handoff needs a koda connection (memory.koda in the nax config)`;
- a handoff step is not the last step: `a handoff must be the chain's last step`;
- an earlier `run` step of the same feature does not set `publish: "none"`: `step <M> runs <feature> without publish "none", so it would publish its own PR before the handoff`;
- an earlier `publish` step of the same feature exists: `step <M> publishes <feature>, so there would be nothing to hand off`;
- an earlier `run` step of the same feature resolves to a repo root other than the chat's: `the handoff runs in <chat root>, but step <M> runs <feature> in <other root>`.

The chain card's step line for a handoff is `<n>. hand <feature> to koda (reviewer <r>, supervisor <s>, cost cap $<cap>) — starts after: <condition>`, and the card adds the line `koda asks for its own approval before anything billed starts`.

`ChatChains` gains `stepEnded(chainId: string, step: number, state: "succeeded" | "failed", note: string): void`. `ChainStep` gains `ended?: { state; note; at }`, and `ChainSummary.steps[]` carries it. A `succeeded` end on the last step marks the chain `completed`; a `failed` end stops it with `step <n> handoff failed: <note>`; a call for a chain that is not current or a step that is not the admitted one is ignored. `admit` treats a handoff exactly as a job launch: kind and argv must match the next step, and the previous step's job must have succeeded.

`buildJobsInstructions` keeps its line count. Its eleventh line (index 10, `workflow-builder.ts:249`) becomes exactly: `` While a chain is active, call each step's launch tool with exactly the approved arguments, one step at a time, after the previous step succeeded; a different call stops the chain and shows a normal card. A handoff step's launch tool is `nax-flow__send` with `handoff: { feature }` and exactly the approved roles and cost cap. ``

### Test placement

New modules get new test files mirroring their path: `test/unit/cli/run-publish-override.test.ts`, `test/unit/workflow/handoff-record.test.ts`, `test/unit/workflow/handoff-mark.test.ts`, `test/unit/chat/flow/flow-handoff-input.test.ts`, `test/unit/chat/flow/flow-handoff.test.ts`, `test/unit/chat/jobs/chain-handoff.test.ts`. Changes to existing modules add tests to that module's existing test file. A file that would pass 650 lines is split by describe block into `<module>-<concern>.test.ts`. The `[cli]` AC spawns `bun bin/nax.ts` with `Bun.spawn`, a temporary `NAX_GLOBAL_CONFIG_DIR` and a 30 s test timeout, as `runNax` in `test/unit/cli/trust.test.ts` does.

Chat code imports the new workflow modules by relative path (`../../workflow/handoff-mark`), as `jobs-launch.ts` imports `../../workflow/publish-only`; the `src/workflow` barrel is unchanged.

### Integration

Read-only symbols, verified on `main` `1d1b16fa8`:

- `WorkflowPublishMode = "pr" | "push" | "none"` (`packages/nax/src/config/runtime-types-workflow.ts:37`); `workflow.publish` defaults to `"pr"` (`config/schemas-workflow.ts:57`). With `none`, `finalize` returns `outcome: "local-only"` after its ledger commit (`workflow/finalize.ts:574`).
- `resolveRunProjectContext(workdir, options): Promise<{ naxDir; cliOverrides }>` (`packages/nax/bin/run-action.ts:282`), which builds `cliOverrides` from `resolveContextCliOverrides` (`src/cli/run-context-overrides.ts`).
- `publishOnlyStart(prior, head, moved?)` and `publishedAtHead(prior, head)` (`workflow/publish-only.ts`); `runInContext` calls `publishOnlyStart` when `input.publishOnly === true` and throws `WORKFLOW_PUBLISH_ONLY_REFUSED` on a refusal (`workflow/feature.ts:237`).
- `runDirsNewestFirst(featureDir): Promise<string[]>` and `readResult(runDir)` (`workflow/result.ts:127`, `:39`); `workflowFeatureDir(projectDir, feature)` and `workflowRunDir` (`workflow/paths.ts`).
- `loadPRD`, `pendingStoryIds(prd)` (`prd/index.ts:268`).
- `readFlowRepoState(repoRoot, specPaths)`, `checkFlowBranch(branch, features)`, `isFlowTreeDirty` (`chat/flow/flow-repo.ts`); `readFlowRepoState` with an empty `specPaths` checks no spec.
- `createKodaFlow(connection, body, signal?)` answers `FlowCreated` on 201 and `FlowHeld` on 202 (`chat/flow/flow-koda.ts:125`).
- `ChainController.admit` / `refusal` (`chat/jobs/chain-controller.ts`): off-card kind or argv stops the chain and answers a card with a note; auto admission returns `{ kind: "auto", chainId, step, approvedAt }`.
- `launchJob` admission pattern (`chat/jobs/jobs-launch.ts:442`), which the handoff send mirrors.

Symbols this feature changes. The baseline only locates the code; it is never the interface to implement:

- `JobLaunchBody` run variant (`chat/jobs/job-argv.ts`) — Baseline: `{ kind: "run"; feature; profiles; maxCost? }`. Target: adds `publish?: WorkflowPublishMode`.
- `CHAIN_STEP_FIELDS` (`chat/jobs/chain-argv.ts`) — Baseline: `run: ["feature", "profiles", "maxCost", "repo"]`, keyed by `ChatJobKind`. Target: `run` adds `"publish"`; a `handoff` key lists `["feature", "roles", "costCapUsd"]`.
- `ChainStep.kind` / `ChainLaunch.kind` / `ChainSummary.steps[].kind` (`chat/jobs/chain-types.ts`, `chain-controller.ts`) — Baseline: `ChatJobKind`. Target: `ChainStepKind`.
- `ChatChains` — Target: gains `stepEnded`.
- `FLOW_SEND_INPUT_SCHEMA` — Baseline: `required: ["features", "roles", "costCapUsd"]`. Target: `required: ["roles", "costCapUsd"]`, with `features` and `handoff` both optional properties.
- `parseFlowSendInput` — Target: refuses both-or-neither of `features` and `handoff`; spec-form behaviour otherwise unchanged.
- `createKodaFlow` — Baseline: `body: FlowCreateBody`. Target: `body: FlowCreateBody | FlowHandoffCreateBody`.
- `FlowProviderOptions` — Target: gains `chains?: ChatChains`; `hostProviders` in `jobs-host.ts` takes the controller and passes it.
- `_flowProviderDeps` — Baseline: declared in `flow-provider.ts`. Target: declared in the new leaf `flow-deps.ts` and re-exported unchanged from `flow-provider.ts`.
- `TOP_LEVEL_KEYS` (`flow-input.ts:32`) — Baseline: `["features", "roles", "costCapUsd"]`. Target: adds `"handoff"`.
- `RunActionOptions` (`bin/run-action.ts`) — Target: gains `publish?: string`.
- `preparePublish` — Target: the handoff-mark refusal, with `publishedAtHead: true`.
- The spec form's post-allow sequence (`afterAllow`/`createFlow` in `flow-provider.ts`) — Baseline: returns `ToolResult`. Target: moves to `flow-send-steps.ts` and returns `PostAllowResult`; the spec form returns its `result` unchanged.
- `JobsProviderOptions` — Target: gains `handoffAvailable?: boolean`; `createHostJobs` sets it true exactly when `kodaFlowConnection(config)` is defined.
- `_jobsLaunchDeps` — Target: gains `readNewestHandoffMark`.
- `buildFlowInstructions`, `buildJobsInstructions` — Target: the added text above.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `--publish` value not `pr`, `push` or `none` | Run refused before anything starts: stderr `nax run --publish must be one of pr, push, none (got "<value>")`, exit 1; `resolveRunProjectContext` is never reached with an invalid value |
| No run directory with a `result.json` | `collectHandoffRecord` reason `no finished workflow run for this feature; run nax run first` |
| More than `HANDOFF_MAX_RUNS` run directories | reason `the feature has <n> workflow runs; koda accepts at most 20` |
| Two `result.json` files whose truncated integer mtimes are equal and largest | reason `two workflow runs share the newest result.json time, so the newest run is ambiguous` |
| Newest `result.json` not JSON, or no `schemaVersion: 1`, no `featureWorkflow`, or a done record with no `outcome` | reason `the newest workflow run's result.json is not a finished feature record` |
| Newest `featureWorkflow.step` not `"done"` | reason `the workflow stopped at <step>; run nax run to finish it` |
| Newest `featureWorkflow.outcome` is `"ready"` or `"draft"` | reason `the run already published a <outcome> PR <url>; a handoff needs a run that ended without a PR (publish "none")`, with ` <url>` omitted when the record has no `url` |
| Newest `featureWorkflow.head` differs from HEAD | reason `HEAD moved since the workflow finished; run nax run so the new commits are reviewed` |
| `prd.json` absent at HEAD | reason `prd.json is not committed at HEAD` |
| `prd.json` at HEAD not a JSON object with a `userStories` array of objects | reason `prd.json at HEAD is not a PRD` |
| PRD `branchName` differs from the branch | reason `prd.json names branch <branchName>, not <branch>` |
| A PRD story pending | reason `1 story is still pending: <id>` for one, `<n> stories are still pending: <ids>` for more |
| A `content` holds a NUL character or an unpaired surrogate | reason `<file> of run <runId> holds a NUL or unpaired surrogate character, which koda refuses` |
| Record bytes over `HANDOFF_RECORD_MAX_BYTES` | reason `the run record is <bytes> bytes; koda accepts at most 524288` |
| A `ledger.md` absent from a run directory | That run sends only its `result.json`; not a refusal |
| Newest run carries a handoff mark | `[chat] ` + `handoffMarkRefusal`, nothing pushed |
| `handoff.json` unparseable | Treated as no mark (`readNewestHandoffMark` returns null) |
| koda refuses the create (HTTP status) | The existing `[chat] koda did not create the flow (HTTP <status>): <koda message>; branch <branch> stays pushed`; no mark written; an auto-admitted step ends `failed` |
| koda unreachable, timeout, an unexpected or malformed answer, or the turn cancelled during the create (branch pushed) | The existing spec-form messages; a mark with `outcomeUnknown: true` is written; an auto-admitted step ends `failed` |
| Turn cancelled, or branch moved, before the push | The existing `nothing was pushed` messages; no mark written; an auto-admitted step ends `failed` |
| Mark write fails after a created or held answer | Result stays a success, with the appended mark sentence; the step ends `succeeded` |
| `--publish-only` on a marked feature | `WORKFLOW_PUBLISH_ONLY_REFUSED`, message `[workflow] --publish-only: <handoffMarkRefusal text>` |
| Chat `publish` launch on a marked feature | `{ error: "[chat] <handoffMarkRefusal text>" }`, no card |

## Out of Scope

- Adopting a draft PR already published from chat: the owner chose hand-over-before-publish (koda design approach A).
- GitLab remotes for the handoff form: `readFlowRepoState` accepts GitHub remotes only, as the spec form does today.
- Refusing a plain `nax run` (not `--publish-only`) or a chat `run` launch on a handed-off feature: the design lets a fresh run write a newer record, which leaves the mark on an older run.
- Clearing or listing handoff marks with a command: the refusal names the file to delete.
- Changing koda, its runner, or the wire contract in koda `.nax/features/flow-handoff/spec.md`.
- Counting the koda flow's `costCapUsd` against the chain's own `costCap`.
- A tracked-files-only tree check for the handoff: the handoff reuses `readFlowRepoState`, which also refuses untracked files, as the spec form does.
- Sending `package-branch*.diff`, `branch-review.json` or any workflow file other than `result.json` and `ledger.md`.
- Updating koda's design doc status or nax's slice-2 design doc: done by hand after the run.

## Stories

The feature is one capability (hand a chat-run feature to koda) in 8 stories, split so each story stays within 24 assertions.

### US-001 — `nax run --publish <mode>` overrides workflow.publish for one run, and a chat run passes it

Workdir: packages/nax. No dependencies.

`nax run` gains `--publish <pr|push|none>` through `resolvePublishCliOverride`, `bin/nax.ts` and `resolveRunProjectContext`. The chat `run` job and a chain `run` step accept an optional `publish` field that `buildJobArgv` turns into `--publish <mode>`.

### US-002 — the run record's files are read with koda's shape limits

Workdir: packages/nax. No dependencies.

`readHandoffRecordFiles` and `isStorableRecordText` in `src/workflow/handoff-record.ts`: run listing, entry order, integer mtimes, the run-count limit, the newest-run tie rule, the content text rule and the byte cap.

### US-003 — the newest feature record and the PRD at head are checked before a handoff

Workdir: packages/nax. Depends on US-002.

`collectHandoffRecord` in `src/workflow/handoff-record.ts`: on top of `readHandoffRecordFiles`, the newest feature record rows and the PRD rows of the Failure Handling table, with the PRD read at the head commit through `_handoffRecordDeps.git`.

### US-004 — a handoff mark beside the newest run refuses a second local publisher

Workdir: packages/nax. No dependencies.

`writeHandoffMark`, `readNewestHandoffMark` and `handoffMarkRefusal` in `src/workflow/handoff-mark.ts`; `runInContext` refuses `--publish-only`, and `preparePublish` refuses the chat publish launch, on a marked feature.

### US-005 — `nax-flow__send` accepts a handoff input form

Workdir: packages/nax. No dependencies.

`parseFlowHandoffInput` and `handoffStepArgv` in `src/chat/flow/flow-handoff-input.ts`, the both-or-neither refusal and `TOP_LEVEL_KEYS` in `flow-input.ts`, the schema change, and the flow instructions line.

### US-006 — the handoff send checks locally, pushes, creates the koda flow and writes the mark

Workdir: packages/nax. Depends on US-003, US-004, US-005.

`flow-handoff.ts` (with `_flowHandoffDeps`), `flow-send-steps.ts` and `flow-deps.ts`: routing on `handoff`, the local checks, the card, the shared post-allow sequence returning `PostAllowResult`, the handoff create body, and the mark for each outcome. This story covers the send outside a chain; chain admission is US-008.

### US-007 — a chain proposal accepts a handoff step as its last step

Workdir: packages/nax. Depends on US-001, US-005.

The `handoff` step kind in `resolveChainProposal`: `parseStep`'s handoff branch, the five refusals, `handoffAvailable`, and the card line.

### US-008 — an approved chain runs its handoff step without a card and ends on its outcome

Workdir: packages/nax. Depends on US-006, US-007.

`admit` for a handoff, `ChatChains.stepEnded`, the chain stop on a refusal before admission, the `finally` step end, `chains` wiring through `createHostJobs`, and the jobs instructions line.

### Context Files

**US-001**
- `packages/nax/bin/run-action.ts` — `resolveRunProjectContext` builds `cliOverrides`.
- `packages/nax/bin/nax.ts` — the `nax run` option list and action, where `--publish` is declared and its error printed.
- `packages/nax/src/chat/jobs/job-argv.ts` — `parseRun` and `buildJobArgv`.
- `packages/nax/src/chat/jobs/chain-argv.ts` — `CHAIN_STEP_FIELDS`.
- `packages/nax/src/chat/jobs/jobs-provider.ts` — the `run` tool schema.

**US-002**
- `packages/nax/src/workflow/result.ts` — `runDirsNewestFirst`, `readResult`.
- `packages/nax/src/workflow/paths.ts` — `workflowFeatureDir`.

**US-003**
- `packages/nax/src/workflow/publish-only.ts` — the preconditions to mirror.
- `packages/nax/src/workflow/config-change.ts` — the `_configChangeDeps.git(["show", ...])` pattern.
- `packages/nax/src/prd/index.ts` — `pendingStoryIds`.
- `packages/nax/src/workflow/handoff-record.ts` — created by US-002, extended here.

**US-004**
- `packages/nax/src/workflow/feature.ts` — `runInContext`.
- `packages/nax/src/chat/jobs/jobs-launch.ts` — `preparePublish`, `_jobsLaunchDeps`, `stopRefusedPublishStep`.
- `packages/nax/src/workflow/result.ts` — `runDirsNewestFirst`.

**US-005**
- `packages/nax/src/chat/flow/flow-input.ts` — `parseFlowSendInput`, `TOP_LEVEL_KEYS`, the role and cost checks.
- `packages/nax/src/chat/flow/flow-provider.ts` — `FLOW_SEND_INPUT_SCHEMA`.
- `packages/nax/src/prompts/builders/flow-builder.ts` — `buildFlowInstructions`.

**US-006**
- `packages/nax/src/chat/flow/flow-provider.ts` — the spec-form send whose helpers and constants move.
- `packages/nax/src/chat/flow/flow-koda.ts` — `createKodaFlow`, `FlowCreateBody`.
- `packages/nax/src/chat/flow/flow-repo.ts` — `readFlowRepoState`, `checkFlowBranch`.
- `packages/nax/src/workflow/handoff-record.ts` — created by US-002 and US-003, called here.
- `packages/nax/src/workflow/handoff-mark.ts` — created by US-004, called here.

**US-007**
- `packages/nax/src/chat/jobs/chain-tools.ts` — `resolveChainProposal`, `parseStep`, `stepLabel`, `chainReason`.
- `packages/nax/src/chat/jobs/chain-argv.ts` — `CHAIN_STEP_FIELDS`.
- `packages/nax/src/chat/jobs/chain-types.ts` — `ChainStep`.
- `packages/nax/src/chat/flow/flow-handoff-input.ts` — created by US-005, parses the step input.

**US-008**
- `packages/nax/src/chat/jobs/chain-controller.ts` — `admit`, `refusal`, `reconcile`, `stop`.
- `packages/nax/src/chat/jobs/jobs-host.ts` — `createHostJobs`, `hostProviders`.
- `packages/nax/src/chat/flow/flow-handoff.ts` — created by US-006, wired to the chain here.
- `packages/nax/src/prompts/builders/workflow-builder.ts` — `buildJobsInstructions`.

### Creates

**US-001**
- `packages/nax/src/cli/run-publish-override.ts`
- `packages/nax/test/unit/cli/run-publish-override.test.ts`

**US-002**
- `packages/nax/src/workflow/handoff-record.ts`
- `packages/nax/test/unit/workflow/handoff-record.test.ts`

**US-003**
- `packages/nax/test/unit/workflow/handoff-record-checks.test.ts`

**US-004**
- `packages/nax/src/workflow/handoff-mark.ts`
- `packages/nax/test/unit/workflow/handoff-mark.test.ts`

**US-005**
- `packages/nax/src/chat/flow/flow-handoff-input.ts`
- `packages/nax/test/unit/chat/flow/flow-handoff-input.test.ts`

**US-006**
- `packages/nax/src/chat/flow/flow-handoff.ts`
- `packages/nax/src/chat/flow/flow-send-steps.ts`
- `packages/nax/src/chat/flow/flow-deps.ts`
- `packages/nax/test/unit/chat/flow/flow-handoff.test.ts`

**US-007**
- `packages/nax/test/unit/chat/jobs/chain-handoff.test.ts`

**US-008**
- `packages/nax/test/unit/chat/jobs/chain-handoff-run.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts` — the `CHAIN_STEP_FIELDS` expectation pins `run` to `["feature", "profiles", "maxCost", "repo"]`; the run step gains the `publish` field, so it expects `["feature", "profiles", "maxCost", "repo", "publish"]` and every other key is unchanged.

**US-005**
- `packages/nax/test/unit/chat/flow/flow-input.test.ts` — any case asserting that a body without `features` reports `features` as missing; the body may now carry `handoff` instead, so such a body without either key reports `exactly one of features or handoff is required`, and every spec-form error case is otherwise unchanged.
- `packages/nax/test/unit/chat/flow/flow-provider.test.ts` — the assertion that `FLOW_SEND_INPUT_SCHEMA.required` equals `["features", "roles", "costCapUsd"]`; `features` is no longer required by the schema because the handoff form omits it, so it expects `["roles", "costCapUsd"]`, and spec-form send behaviour is unchanged.

**US-007**
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts` — the `CHAIN_STEP_FIELDS` expectation lists the job kinds only; the chain gains a `handoff` step kind, so it also expects `handoff: ["feature", "roles", "costCapUsd"]`.

**US-008**
- `packages/nax/test/unit/prompts/builders/workflow-builder-chain.test.ts` — the chain-line assertions pin each of the three chain lines verbatim (`CHAIN_INSTRUCTIONS`, `slice(9)`); the eleventh line (index 10) gains the handoff sentence, so its expected text is the new line given in Design and the other two chain lines and the line count are unchanged.
- `packages/nax/test/unit/chat/jobs/jobs-host.test.ts` — the jobs-provider options assertion lists the options `createHostJobs` passes; it now also passes `handoffAvailable`, true exactly when the config has a koda connection.
- `packages/nax/test/unit/chat/jobs/jobs-launch-chain.test.ts` — the hand-built `ChatChains` fake (`let chains: ChatChains`, near line 48) lists every interface member; `ChatChains` gains `stepEnded`, so the fake gains `stepEnded: mock(() => {})` and every existing expectation is unchanged.

### Seams

- US-001 creates `resolvePublishCliOverride`; `resolveRunProjectContext` and the `nax run` action consume it (US-001 ACs 7 and 9 enter there).
- US-002 creates `readHandoffRecordFiles`; `collectHandoffRecord` consumes it (US-003 ACs drive `collectHandoffRecord` over real run dirs).
- US-003 creates `collectHandoffRecord`; the handoff send consumes it (US-006 ACs 1 and 2 stub it through `_flowHandoffDeps` and enter at the tool's `run`).
- US-004 creates `readNewestHandoffMark` and `writeHandoffMark`; `runInContext` and `preparePublish` (US-004 ACs 9 and 10) and the handoff send (US-006 ACs 3, 9 and 11) consume them.
- US-005 creates `parseFlowHandoffInput` and `handoffStepArgv`; the handoff send (US-006) and `resolveChainProposal` (US-007 ACs 1 and 2) consume them.
- US-008 creates `ChatChains.stepEnded`; the handoff send calls it (US-008 ACs 7 and 8 drive the send through `createHostJobs` with an active chain).

## Acceptance Criteria

### US-001

1. [unit] `resolvePublishCliOverride(undefined)` returns `undefined`.
2. [unit] `resolvePublishCliOverride("none")` returns `{ workflow: { publish: "none" } }`.
3. [unit] `resolvePublishCliOverride("push")` returns `{ workflow: { publish: "push" } }`.
4. [unit] `resolvePublishCliOverride("draft")` returns `{ error: 'nax run --publish must be one of pr, push, none (got "draft")' }`.
5. [unit] `resolvePublishCliOverride("")` returns an `error` result naming `(got "")`.
6. [unit] `loadConfig` with a project config whose `workflow` is `{ publish: "pr", maxFixRounds: 3 }` and CLI overrides `{ workflow: { publish: "none" } }` resolves `workflow.publish` to `"none"` and keeps `workflow.maxFixRounds` at `3`.
7. [unit] `resolveRunProjectContext(workdir, { feature: "f1", publish: "none" })` returns `cliOverrides.workflow` equal to `{ publish: "none" }`.
8. [unit] `resolveRunProjectContext(workdir, { feature: "f1" })` returns `cliOverrides` with no `workflow` key.
9. [cli] `nax run -f f1 --publish draft`, spawned in a temporary project directory, exits with code 1 and prints `nax run --publish must be one of pr, push, none (got "draft")` on stderr.
10. [unit] `parseJobInput("run", { feature: "f1", profiles: [], publish: "none" })` returns `{ kind: "run", feature: "f1", profiles: [], publish: "none" }`.
11. [unit] `parseJobInput("run", { feature: "f1", profiles: [], publish: "draft" })` returns `{ error: '[chat] publish must be one of "pr", "push", "none"' }`.
12. [unit] `parseJobInput("run", { feature: "f1", profiles: [] })` returns an input with no `publish` key.
13. [unit] `buildJobArgv({ kind: "run", feature: "f1", profiles: [], maxCost: 5, publish: "none" }, ctx)` returns an argv whose last four tokens are `--max-cost`, `5`, `--publish`, `none`.
14. [unit] `buildJobArgv({ kind: "run", feature: "f1", profiles: [] }, ctx)` returns an argv with no `--publish` token.
15. [unit] `buildChainStepArgv` of `parseChainStepInput("run", { feature: "f1", publish: "none" })` returns an argv whose last two tokens are `--publish`, `none`.
16. [unit] The `nax-jobs__run` tool's input schema declares a `publish` property whose `enum` is `["pr", "push", "none"]`.
17. [unit] `resolveRunProjectContext(workdir, { feature: "f1", publishOnly: true, publish: "push" })` returns `cliOverrides.workflow` equal to `{ publish: "push" }`.

### US-002

1. [unit] `readHandoffRecordFiles(dir)` over one run `r1` holding `result.json` and `ledger.md` returns `ok: true`, `newestRunId: "r1"` and the entries `{ runId: "r1", file: "result.json" }` then `{ runId: "r1", file: "ledger.md" }`.
2. [unit] Each entry's `content` equals the file's UTF-8 text.
3. [unit] Each entry's `mtimeMs` equals `Math.trunc` of the file's stat mtime.
4. [unit] With runs `r1` (older `result.json` mtime) and `r2` (newer), the entries list `r2`'s files before `r1`'s and `newestRunId` is `"r2"`.
5. [unit] A run directory holding `result.json` but no `ledger.md` contributes one `result.json` entry and the result is `ok: true`.
6. [unit] A run directory with no `result.json` contributes no entry and does not count toward the run limit.
7. [unit] An empty workflow dir returns `{ ok: false, reason: "no finished workflow run for this feature; run nax run first" }`.
8. [unit] A workflow dir that does not exist returns the same `no finished workflow run` reason.
9. [unit] 21 run directories that each hold a `result.json` return `ok: false` with reason `the feature has 21 workflow runs; koda accepts at most 20`.
10. [unit] 20 such run directories return `ok: true`.
11. [unit] Two runs whose `result.json` mtimes are equal and largest return `ok: false` with reason `two workflow runs share the newest result.json time, so the newest run is ambiguous`.
12. [unit] Two runs whose newest `result.json` mtimes are `1000.2` and `1000.7` ms return the same `newest run is ambiguous` reason, because both truncate to `1000`.
13. [unit] A record whose contents total 524289 UTF-8 bytes returns `ok: false` with reason `the run record is 524289 bytes; koda accepts at most 524288`.
14. [unit] A record whose contents total exactly 524288 UTF-8 bytes, with a 2-byte character counted as 2, returns `ok: true`.
15. [unit] A run whose `ledger.md` holds a NUL character returns `ok: false` with reason `ledger.md of run <runId> holds a NUL or unpaired surrogate character, which koda refuses`.
16. [unit] `isStorableRecordText("a\u0000b")` returns false.
17. [unit] `isStorableRecordText` of a string holding the lone surrogate `\uD800` returns false; a file cannot produce one through UTF-8 decoding, so this case is pinned on the helper.
18. [unit] `isStorableRecordText` of a string holding a valid surrogate pair (an emoji) returns true.

### US-003

1. [unit] `collectHandoffRecord` over one run whose feature record is `step: "done"`, `outcome: "local-only"`, `head: "<H>"`, with `_handoffRecordDeps.git` answering a `prd.json` whose `branchName` is the branch and every story passed, returns `ok: true` with the entries `readHandoffRecordFiles` returns.
2. [unit] `collectHandoffRecord` calls `_handoffRecordDeps.git` with `["show", "<H>:.nax/features/f1/prd.json"]` and the repo root.
3. [unit] A `readHandoffRecordFiles` refusal (an empty workflow dir) is returned unchanged and `_handoffRecordDeps.git` is not called.
4. [unit] A newest `result.json` that is not JSON returns `ok: false` with reason `the newest workflow run's result.json is not a finished feature record`.
5. [unit] A newest `result.json` with `schemaVersion: 2` returns the same `not a finished feature record` reason.
6. [unit] A newest `result.json` with `schemaVersion: 1` and no `featureWorkflow` returns the same reason.
7. [unit] A newest done feature record with no `outcome` returns the same reason.
8. [unit] A newest feature record with `step: "publish"` returns `ok: false` with reason `the workflow stopped at publish; run nax run to finish it`.
9. [unit] A newest feature record with `outcome: "draft"` and `url: "https://x/pull/7"` returns `ok: false` with reason `the run already published a draft PR https://x/pull/7; a handoff needs a run that ended without a PR (publish "none")`.
10. [unit] A newest feature record with `outcome: "ready"` and no `url` returns `ok: false` with reason `the run already published a ready PR; a handoff needs a run that ended without a PR (publish "none")`.
11. [unit] A newest feature record with `outcome: "pushed"` and `head` equal to `input.head` returns `ok: true`.
12. [unit] A newest feature record whose `head` differs from `input.head` returns `ok: false` with reason `HEAD moved since the workflow finished; run nax run so the new commits are reviewed`.
13. [unit] `_handoffRecordDeps.git` answering a non-zero exit returns `ok: false` with reason `prd.json is not committed at HEAD`.
14. [unit] A `prd.json` at HEAD whose text is the JSON array `[]` returns `ok: false` with reason `prd.json at HEAD is not a PRD`.
15. [unit] A `prd.json` at HEAD whose `userStories` holds a `null` entry returns the same `not a PRD` reason.
16. [unit] A `prd.json` at HEAD whose `branchName` is `feat/other` while `input.branch` is `feat/f1` returns `ok: false` with reason `prd.json names branch feat/other, not feat/f1`.
17. [unit] A `prd.json` at HEAD with stories `US-002` and `US-003` pending returns `ok: false` with reason `2 stories are still pending: US-002, US-003`.
18. [unit] A `prd.json` at HEAD with only `US-002` pending returns `ok: false` with reason `1 story is still pending: US-002`.

### US-004

1. [unit] `writeHandoffMark(runDir, { schemaVersion: 1, at: "2026-11-18T00:00:00.000Z", flowId: "fl1", url: "https://koda/flows/fl1" })` writes `<runDir>/handoff.json`, and parsing it returns the same object.
2. [unit] `writeHandoffMark` leaves the mtime of `<runDir>/result.json` unchanged.
3. [unit] `readNewestHandoffMark(dir)` returns `{ mark, path }` with `path` equal to `<newest run dir>/handoff.json` when the run with the newest `result.json` mtime holds a mark.
4. [unit] `readNewestHandoffMark(dir)` returns `null` when only an older run holds a mark and the newest run has none.
5. [unit] `readNewestHandoffMark(dir)` returns `null` when the newest run's `handoff.json` is not JSON.
6. [unit] `readNewestHandoffMark(dir)` returns `null` for a workflow dir that does not exist.
7. [unit] `handoffMarkRefusal("f1", { mark: { schemaVersion: 1, at: "T", flowId: "fl1", url: "https://koda/flows/fl1" }, path: "/r/handoff.json" })` returns `f1 was handed off to koda (flow fl1 https://koda/flows/fl1) at T; koda publishes it. Delete /r/handoff.json to publish it here instead`.
8. [unit] `handoffMarkRefusal` for a mark with `requestId: "rq1"` and no `flowId` names `(approval request rq1)` in place of the flow.
9. [unit] `runWorkflowFeature` with `publishOnly: true` on a feature whose newest run holds a mark, and whose newest record would otherwise resume publishing, throws `NaxError` code `WORKFLOW_PUBLISH_ONLY_REFUSED` with a message beginning `[workflow] --publish-only: f1 was handed off to koda`, and no publish step runs.
10. [unit] The chat publish launch (`nax-jobs__publish` tool `run`) for a feature with every story passed, with `_jobsLaunchDeps.readNewestHandoffMark` stubbed to return a mark, returns an error result whose content begins `[chat] f1 was handed off to koda`, and requests no approval card.
11. [unit] The same launch with `readNewestHandoffMark` stubbed to return `null` reaches the existing published-at-head check and card, unchanged.
12. [unit] The chat publish launch on a feature with pending stories returns the existing pending-stories refusal and does not call `readNewestHandoffMark`.
13. [unit] `handoffMarkRefusal` for a mark with `outcomeUnknown: true` and neither `flowId` nor `requestId` names `(outcome unknown; check koda's flows first)`.
14. [unit] A chat publish launch refused by a handoff mark, while an active chain's next step is a publish of the same feature in the same repo, stops that chain with the refusal text without its `[chat] ` prefix.

### US-005

1. [unit] `parseFlowHandoffInput({ handoff: { feature: "f1" }, roles: { reviewer: "acp:claude", supervisor: "acp:claude" }, costCapUsd: 5 })` returns `{ feature: "f1", roles: { reviewer: "acp:claude", supervisor: "acp:claude" }, costCapUsd: 5 }`.
2. [unit] `parseFlowHandoffInput` with `feature` `"../x"` returns an `errors` list naming `handoff.feature`.
3. [unit] `parseFlowHandoffInput` with `costCapUsd: 1.23456` returns the cost-cap error `parseFlowSendInput` returns for that value.
4. [unit] `parseFlowHandoffInput` with an extra key `handoff.specPath` returns an `errors` list naming that unknown key.
5. [unit] `parseFlowSendInput` of a body carrying both `features` and `handoff` returns `errors` containing `exactly one of features or handoff is required`.
6. [unit] `parseFlowSendInput` of a body carrying neither returns the same error.
7. [unit] `handoffStepArgv({ feature: "f1", roles: { reviewer: "r", supervisor: "s" }, costCapUsd: 5 })` returns `["nax-flow__send", "--handoff", "f1", "--reviewer", "r", "--supervisor", "s", "--cost-cap", "5"]`.
8. [unit] `FLOW_SEND_INPUT_SCHEMA.required` equals `["roles", "costCapUsd"]` and its `properties.handoff` requires `feature`.
9. [unit] `buildFlowInstructions()` contains a line naming `handoff: { feature }` and `publish: "none"`.

### US-006

1. [unit] The `nax-flow__send` tool's `run` with a handoff body, with `_flowHandoffDeps.collectHandoffRecord` stubbed to return `{ ok: false, reason: "R" }`, returns the error result `[chat] cannot hand off f1: R`, requests no approval, pushes nothing and calls no koda create.
2. [unit] The tool's `run` with a handoff body calls `collectHandoffRecord` with `{ repoRoot, feature: "f1", head, branch }` taken from `readFlowRepoState(repoRoot, [])`.
3. [unit] With the record accepted and `_flowHandoffDeps.readNewestHandoffMark` returning a mark, the tool returns an error result beginning `[chat] f1 was handed off to koda` and requests no approval.
4. [unit] With no active chain the tool requests one approval card whose `summary` is `hand f1 over to koda`.
5. [unit] That card's `command` is `git push --set-upstream origin <branch>` and its `reason` contains `feature f1: 2 run(s)` for a record of two run ids.
6. [unit] On a denied card the tool returns the existing declined result and pushes nothing.
7. [unit] On an allowed card the tool calls `commitAndPush` with `skipCommit: true` and `sourceSha` equal to the carded sha.
8. [unit] On an allowed card `createKodaFlow` receives `{ remoteUrl, branch, roles, costCapUsd, handoff: { feature: "f1", headSha, record } }` with the collected record and no `features` or `specSha` key.
9. [unit] A 201 answer `{ id: "fl1", state: "PENDING", url: "/flows/fl1" }` makes the tool call `writeHandoffMark` on the newest run dir with `flowId: "fl1"` and the joined flow URL, and return a success result whose first line is the JSON `{ flow: "fl1", state: "PENDING", url }`.
10. [unit] A 202 answer with request id `rq1` makes the tool write a mark with `requestId: "rq1"` and return the existing held result text.
11. [unit] A koda HTTP 409 answer returns the existing `[chat] koda did not create the flow (HTTP 409): ...; branch <branch> stays pushed` result and `writeHandoffMark` is not called.
12. [unit] `createKodaFlow` rejecting with `NaxError` code `MEMORY_KODA_TIMEOUT` after the push makes the tool write a mark with `outcomeUnknown: true` and return the existing `koda could not be reached` result.
13. [unit] `createKodaFlow` rejecting with `NaxError` code `FLOW_KODA_UNEXPECTED_RESPONSE` makes the tool write a mark with `outcomeUnknown: true` and return the existing `koda answered unexpectedly` result.
14. [unit] The turn cancelled during the create (`MEMORY_KODA_ABORTED`) makes the tool write a mark with `outcomeUnknown: true`.
15. [unit] The turn cancelled after the card and before the push returns the existing `the turn was cancelled; nothing was pushed` result and `writeHandoffMark` is not called.
16. [unit] The branch moved between the card and the push returns the existing `the branch changed while the card was open; nothing was pushed` result and calls no koda create.
17. [unit] `writeHandoffMark` rejecting with `EACCES` after a 201 answer leaves the result a success whose text ends `; the local handoff mark could not be written (EACCES), so nothing stops a local publish of f1`.
18. [unit] A spec-form body (`features`, no `handoff`) never calls `collectHandoffRecord`, and `createKodaFlow` receives a body with `features` and `specSha`.

### US-007

1. [unit] `resolveChainProposal` for steps `[run f1 with publish "none", handoff f1 with roles and costCapUsd 5]` with `handoffAvailable: true` returns two steps, the second with `kind: "handoff"`, `target: "f1"` and `argv` equal to `handoffStepArgv` of its input.
2. [unit] `resolveChainProposal` with a handoff step whose `feature` is `"../x"` returns an error beginning `[chat] step 2:` that names `handoff.feature`.
3. [unit] `resolveChainProposal` with a handoff step carrying a `repo` field returns an error naming that field as unknown.
4. [unit] `resolveChainProposal` with a handoff step and `handoffAvailable` unset returns `[chat] step 1: handoff needs a koda connection (memory.koda in the nax config)`.
5. [unit] `resolveChainProposal` for `[handoff f1, run f2]` returns `[chat] step 1: a handoff must be the chain's last step`.
6. [unit] `resolveChainProposal` for `[run f1 without publish, handoff f1]` returns `[chat] step 2: step 1 runs f1 without publish "none", so it would publish its own PR before the handoff`.
7. [unit] `resolveChainProposal` for `[run f1 with publish "push", handoff f1]` returns the same `without publish "none"` error for step 2.
8. [unit] `resolveChainProposal` for `[publish f1, handoff f1]` returns `[chat] step 2: step 1 publishes f1, so there would be nothing to hand off`.
9. [unit] `resolveChainProposal` for `[run f1 with publish "none" in a repo resolving to another root, handoff f1]` returns an error for step 2 naming both roots.
10. [unit] `resolveChainProposal` for `[run f2 without publish, handoff f1]` returns two steps: a run of another feature is not checked.
11. [unit] The `nax-jobs__chain` card for `[run f1 with publish "none", handoff f1]` has the step line `2. hand f1 to koda (reviewer r, supervisor s, cost cap $5.00) — starts after: step 1 succeeded`.
12. [unit] The same card has the line `koda asks for its own approval before anything billed starts`.

### US-008

1. [unit] `admit({ kind: "handoff", argv })` on an active chain whose step 1 run job succeeded and whose step 2 is that handoff returns `{ kind: "auto", step: 2 }`.
2. [unit] `admit({ kind: "handoff", argv })` with a different cost cap token stops the chain with `off-card step` and returns a card admission.
3. [unit] `admit({ kind: "handoff", argv })` while step 1's run job is still running stops the chain with `step 1 has not succeeded`.
4. [unit] `stepEnded(chainId, 2, "succeeded", "flow fl1")` on the last step marks the chain `completed`, and `summary().steps[1].ended.state` is `"succeeded"`.
5. [unit] `stepEnded(chainId, 2, "failed", "X")` stops the chain with reason `step 2 handoff failed: X`.
6. [unit] `stepEnded` for a chain id that is not current, or for a step other than the admitted one, leaves the chain state and its steps unchanged.
7. [integration] Through `createHostJobs` with a koda connection and an approved chain `[run f1 with publish "none", handoff f1]` whose run job succeeded, the `nax-flow__send` handoff call with exactly the approved roles and cost cap requests no approval card, creates the flow (stubbed `createKodaFlow` answering 201), and leaves the chain `completed`.
8. [integration] The same path with `createKodaFlow` answering HTTP 409 leaves the chain `stopped` with a reason beginning `step 2 handoff failed: [chat] koda did not create the flow (HTTP 409)`.
9. [integration] The same path with `_flowHandoffDeps.collectHandoffRecord` refusing with reason `R` leaves the chain `stopped` with reason `cannot hand off f1: R`, and requests no card.
10. [unit] After an auto admission, `createKodaFlow` throwing a plain `Error("boom")` that no classifier handles ends the step `failed` with a note containing `flow send failed: boom`.
11. [unit] A `nax-flow__send` handoff call while no chain is active never calls `stepEnded` or `stop`.
12. [unit] `createHostJobs` with a config that has no koda connection passes `handoffAvailable: false` to the jobs provider, and with a koda connection passes `true`.
13. [unit] The eleventh line (index 10) of `buildJobsInstructions()` ends with ``A handoff step's launch tool is `nax-flow__send` with `handoff: { feature }` and exactly the approved roles and cost cap.``, and the instruction line count is unchanged.
