# SPEC: Send a spec set from nax chat to koda as a flow (nax-flow__send)

## Summary

Add a chat tool, `nax-flow__send`, that hands a settled set of feature specs from `nax chat` to koda as a
fleet flow. The tool checks the request and the repository first, then shows one approval card in every
chat mode. On allow it pushes the current spec branch and calls koda's create-flow endpoint
(`POST /fleet/flows`) with the branch, its head sha, the GitHub remote URL, the ordered features, the role
models and a cost cap. koda creates the flow in state `PENDING` and asks its own human for approval before
anything billed starts. The tool is offered only to the chat brain (native or ACP), only when nax has a
koda connection, and never to subagents. This is G5 of
`docs/superpowers/specs/2026-11-04-nax-chat-acp-subagents-design.md` section 4. koda's endpoint is live.

## Motivation

The user wants one brainstorm to turn into ready PRs with as little of their attention as possible. koda
owns the always-on flow (spec review, plan, PRD review, run, finish, waiting on merges), and koda already
accepts a flow from nax through `POST /api/fleet/flows` with an agent key (entry `NAX`). nax has no way to
call it: today a settled spec set in `nax chat` has to be re-entered in koda's web UI by hand, which is the
stitching between tools that the main roadmap removes.

The card is not the billed yes. koda always asks for `fleet.flow.start` approval on a flow sent from nax;
the only pre-approval path is a koda thread's tickbox, which a nax-sent flow does not have.

## Design

### Credential and connection (my call, departs from the source design)

The source design proposed a new `nax auth login koda` credential kind. This spec instead reuses the koda
connection nax already has: `memory.koda.url` (koda's API root including its `/api` prefix) and
`memory.koda.headers` (the literal `Authorization: Bearer <agent key>` header). Reasons, from the code:

- Both keys are already global-only (`KODA_GLOBAL_ONLY_KEYS` in `packages/nax/src/config/global-only-keys.ts`),
  so a repository's `.nax/config.json` cannot point the key at another server.
- Header values are carried literally, with no `${VAR}` expansion (`LITERAL_SUBTREE_PATHS` in
  `packages/nax/src/config/dotenv.ts`), and `koda-http.ts` redacts them from every error.
- The `nax auth` store is built for LLM providers: `StoredCredential` is a closed union of `api-key` and
  `oauth`, `nax auth login` resolves the provider against pi's catalog, and unknown kinds are coerced to
  `api-key`. A non-LLM kind would touch three packages for a key nax already stores once.
- One koda, one agent key: a second home for the same key could drift from the first.

The connection is present when `memory.koda.url` is set and `memory.koda.headers` has an `authorization`
header (matched case-insensitively) with a non-empty value. `memory.enabled`, `memory.provider` and
`memory.koda.project` play no part: koda resolves the repository from the remote URL.

### The request

Tool input (JSON schema, `additionalProperties: false`):

```json
{
  "features": [
    { "feature": "nax-flow-send", "specPath": ".nax/features/nax-flow-send/spec.md" },
    { "feature": "nax-flow-docs", "specPath": ".nax/features/nax-flow-docs/spec.md", "dependsOn": ["nax-flow-send"] }
  ],
  "roles": { "reviewer": "acp:codex", "supervisor": "acp:claude" },
  "costCapUsd": 5
}
```

The body nax sends to `POST <memory.koda.url>/fleet/flows` (the client path argument is `fleet/flows`, with no leading slash, because `createKodaClient` joins the root and the path with `/`):

```json
{
  "remoteUrl": "https://github.com/nathapp-io/nax",
  "branch": "feat/nax-flow-send",
  "specSha": "<40-hex head sha>",
  "features": [
    { "feature": "nax-flow-send", "specPath": ".nax/features/nax-flow-send/spec.md", "dependsOn": [] },
    { "feature": "nax-flow-docs", "specPath": ".nax/features/nax-flow-docs/spec.md", "dependsOn": ["nax-flow-send"] }
  ],
  "roles": { "reviewer": "acp:codex", "supervisor": "acp:claude" },
  "costCapUsd": 5
}
```

nax checks the input before the card, mirroring the koda checks that are cheap to repeat, so a bad request
fails before anything is pushed (koda stays the authority and re-checks everything):

- `features` has 1 to 20 entries; each `feature` matches `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`; names are unique.
- each `specPath` is 1 to 300 characters, ends in `.md`, does not start with `/`, contains no NUL character
  and has no `..` segment.
- each `dependsOn` entry names a feature that appears earlier in the list, never itself, and appears once.
- `roles.reviewer` and `roles.supervisor` each match `^[A-Za-z0-9._:/\[\]=,-]{1,200}$`. They are model
  strings koda passes to its review steps (for example `acp:codex`), not nax alias names; nax does not
  resolve `agent.modelAliases` (my call: koda's runner resolves models on its own machine).
- `costCapUsd` is a JSON number (a numeric string is rejected, my call) greater than 0 and at most 1000 whose
  `String()` form matches `^\d+(\.\d{1,4})?$`, as koda tests it.
- the input has no keys beyond `features`, `roles` and `costCapUsd`, and `features` is an array.

nax checks and sends each `specPath` exactly as given; koda normalises it on its side.

### The repository

All read from the chat's repository root before the card by `readFlowRepoState(repoRoot, specPaths)`,
which returns `{ ok: true, branch, sha, remoteUrl }` or `{ ok: false, message }`. The checks run in the order
below and the first failure is returned:

- the branch, from `git symbolic-ref --short HEAD`; a detached HEAD fails.
- the branch must pass `isPublishableBranch` (`packages/nax/src/utils/git.ts`); `main`, `master` and the
  empty name fail.
- the working tree must be clean (`isDirty` from `@/finish` returns false): nothing new is committed by
  this tool. Untracked files count, so a spec directory must be committed or ignored. When `isDirty` throws,
  the result is `{ ok: false, message: "[chat] could not read the repository state: <error message>" }`.
- the head sha, from `headSha` (`@/finish`); `null` (an unborn branch) fails with
  `[chat] the branch has no commits`.
- the remote URL, from `git remote get-url origin`, normalised to `https://github.com/<owner>/<repo>`
  (lower-cased, no `.git` suffix, no trailing slash). Accepted forms: `https://github.com/o/r(.git)`,
  `git@github.com:o/r(.git)` and `ssh://git@github.com/o/r(.git)`. Any other host fails, because koda's
  `parseGitHubUrl` accepts GitHub HTTPS URLs only.
- every `specPath` must exist at `HEAD` (`git cat-file -e HEAD:<specPath>`); koda reads each spec at the
  sent sha and rejects a missing one only after the push.

A second pure check, `checkFlowBranch(branch, features)`, mirrors koda's branch rules and returns an error
message or `undefined`: the branch must match `^(?![-./])(?!.*\.\.)(?!.*//)(?!.*\.lock$)(?!.*/$)[A-Za-z0-9._/@+-]{1,255}$`,
and no feature at index 1 or later may be named so that `feat/<feature>` equals the branch.

`readFlowRepoState` reaches git only through `_flowRepoDeps = { git, isDirty, headSha }` (in
`flow-repo.ts`), whose defaults are `gitWithTimeout` (`@/utils/git`) and `isDirty`/`headSha` (`@/finish`);
tests replace these members. No raw spawn, so the `check-git-spawn-env` gate holds.

### The card

One `HostApprovalCard` through `ChatAskController.requestHostApproval`, shown in **every** chat mode
including full (my call: `createHostJobs` skips its cards in full mode, so this tool must not reuse that
`approve` wrapper; pushing and creating a record in another system is outward-facing):

- `tool`: `nax-flow__send`
- `signal`: the tool run's `ctx.signal`, so a cancelled turn closes the card as a deny
- `summary`: `send a flow of <N> feature(s) to koda`
- `command`: `git push --set-upstream origin <branch>`
- `reason`, one string whose lines are joined with `\n`, in this order:
  1. `repo <remoteUrl> on branch <branch> at <sha first 8>`
  2. one line per feature: `<i>. <feature> (<specPath>)` followed by ` — after: <a>, <b>` when it has dependencies
  3. `reviewer <reviewer>, supervisor <supervisor>`
  4. `cost cap $<costCapUsd with 2 decimals>`
  5. `koda will ask you to approve this flow before anything billed starts`

A deny returns `[chat] the user declined sending the flow to koda; do not retry with different arguments
unless the user asks`, matching the jobs tools' wording.

### After allow

1. If `ctx.signal` is aborted, stop with nothing pushed. Then re-read the head sha and the working-tree state. If the sha differs from the carded one or the tree is
   dirty, fail with nothing pushed: the card described a different commit.
2. Push with `commitAndPush(repoRoot, branch, FLOW_PUSH_COMMIT_MESSAGE, { skipCommit: true })` (`@/finish`),
   which runs `git push --set-upstream origin <branch>`. `FLOW_PUSH_COMMIT_MESSAGE` (value `"chore: send flow to koda"`,
   exported from `flow-provider.ts` and the flow barrel) satisfies the required parameter; with `skipCommit` no
   commit is made.
3. POST the body above through `createKodaClient` (`@/memory`) built from the connection, with the new
   constant `FLOW_KODA_REQUEST_TIMEOUT_MS = 30_000` (my call: koda's create calls GitHub for the branch
   head and every spec file, so the memory client's 4 s deadline is too short).
4. Report the outcome (see Failure Handling for the error rows):
   - 201: koda created the flow. The result's first line is the JSON
     `{"flow":"<data.id>","state":"<data.state>","url":"<link>"}`, where `<link>` is the origin of
     `memory.koda.url` joined with koda's relative `data.url` (`/<project>/flows/<id>`); the second line is
     `koda will ask you to approve this flow before anything billed starts.`
   - 202: koda's approval policy is holding the create itself (`data` is koda's approval request summary).
     The result is
     `koda is holding the flow create for approval (request <data.id>); no flow exists until it is approved, and pushing new commits to the branch before then makes koda refuse it.`
   - any other 2xx status, or a 201 whose `data` lacks a string `id`, `state` or `url`, or a 202 whose `data`
     lacks a string `id`: `createKodaFlow` throws `NaxError` code `FLOW_KODA_UNEXPECTED_RESPONSE`.

The link assumes koda's web UI is served from the same origin as its API (true for a koda deployment behind
one proxy); a koda under a path prefix would need the web root configured, which is out of scope.

The tool's seams live in `_flowProviderDeps = { readFlowRepoState, headSha, isDirty, commitAndPush,
createKodaFlow }` (in `flow-provider.ts`). `createFlowProvider(options: FlowProviderOptions)` takes
`{ repoRoot, connection, approve: (card: HostApprovalCard) => Promise<"allow" | "deny"> }`.

A spec review done in the chat is not sent as a claim: koda runs its own spec review.

### Instructions

The provider's instructions come from a new builder, `buildFlowInstructions()` in
`packages/nax/src/prompts/builders/flow-builder.ts`, exported through `@/prompts` (the prompt-builder rule).
They tell the brain: use the tool only when the user asks to hand specs to koda; the branch must be clean
and committed first, untracked files included; list features in dependency order; the user approves a card and then approves again in
koda.

### Delivery

- A new static provider, id `nax-flow`, `stages: ["*"]`, one tool with local name `send` (qualified name
  `nax-flow__send`).
- Composed only for the parent chat, in `createHostJobs`, and only when the connection is present. Its
  `approve` is `(card) => options.asks.requestHostApproval(card)`: a bound call (the method reads `this`) and
  not the jobs wrapper that auto-allows in full mode. `createHostJobs` gains a `providers` field, `[nax-jobs
  provider, nax-flow provider when present]`, and keeps `provider`. Because `createHostJobs` runs only when
  the chat has both `resources` and a nax entry, the flow tool needs both too. It is never added to
  `resources.toolProviders`, which is what subagents receive.
- `ACP_CHAT_PROVIDER_IDS` (`packages/nax/src/chat/acp/acp-tools.ts`) gains `nax-flow`, so the ACP brain
  receives it. `ACP_SUBAGENT_PROVIDER_IDS` (`acp-subagent-session.ts`) does not.
- `packages/nax/src/chat/chat-host.ts` is at 599 lines against the 600-line limit. Its parent provider
  list (line 212) changes from `...(hostJobs ? [hostJobs.provider] : [])` to `...(hostJobs?.providers ?? [])`,
  a same-length edit, so the file stays at 599 lines.

### Integration

Read only (verified on `a23f3e11f`):

- `createKodaClient(input: CreateKodaClientInput): KodaClient` and `kodaStatusOf(error): number | undefined`
  — `packages/nax/src/memory/koda-http.ts`; `KodaResponse` is `{ status, data }`, where `data` is the
  envelope's `data`. A non-2xx status throws `NaxError` code `MEMORY_KODA_HTTP` whose message carries koda's
  `message`; transport failures throw `MEMORY_KODA_UNREACHABLE` or `MEMORY_KODA_TIMEOUT`.
- `HostApprovalCard { tool, summary, command?, reason, signal? }` and
  `ChatAskController.requestHostApproval(card): Promise<"allow" | "deny">` —
  `packages/nax/src/chat/ask-controller.ts`.
- `isDirty(repoRoot)`, `headSha(repoRoot)`, `commitAndPush(repoRoot, branch, message, { skipCommit })` —
  `packages/nax/src/finish/commit.ts`, exported from `@/finish`.
- `isPublishableBranch(branch)` and `gitWithTimeout` — `packages/nax/src/utils/git.ts`.
- `ProviderTool` / `ToolProvider` / `ToolResult` — `@nathapp/nax-agent`; precedent provider
  `createJobsProvider` in `packages/nax/src/chat/jobs/jobs-provider.ts`.
- `MemoryKodaConfigSchema` (`url`, `project`, `headers`) — `packages/nax/src/config/schemas-memory.ts`.

Changed:

- `ACP_CHAT_PROVIDER_IDS`. Baseline (to locate the code only): `["nax-workflow", "nax-jobs", "nax-memory"]`.
  Target: `["nax-workflow", "nax-jobs", "nax-flow", "nax-memory"]`.
- `createHostJobs` (`packages/nax/src/chat/jobs/jobs-host.ts`). Target: its result adds
  `providers: readonly ToolProvider[]` (the jobs provider, then the flow provider when the connection is
  present) beside the unchanged `provider`; the chat host spreads `providers` where it spread `[provider]`.

### Failure Handling

Every failure is a tool result with `isError: true` and content starting `[chat] `; no failure throws out
of the tool.

| Condition | Behaviour |
|:--|:--|
| no koda connection (`memory.koda.url` unset or no non-empty `authorization` header) | the `nax-flow` provider is not offered |
| input fails a check in "The request" | error naming the field and the rule; no card, nothing pushed |
| detached HEAD | error `[chat] nax-flow__send needs a checked-out branch`; no card |
| branch is `main`, `master` or empty | error naming the branch; no card |
| working tree is dirty | error `[chat] commit or stash your changes before sending a flow`; no card |
| `git status` fails (`isDirty` throws) | error `[chat] could not read the repository state: <message>`; no card |
| unborn branch (`headSha` returns `null`) | error `[chat] the branch has no commits`; no card |
| branch fails koda's ref rule, or equals `feat/<feature>` for a feature at index 1 or later | error from `checkFlowBranch` naming the branch; no card |
| origin is missing (`git remote get-url origin` fails) | error `[chat] the repository has no origin remote`; no card |
| origin is not a GitHub remote | error naming the remote URL; no card |
| a `specPath` is absent at HEAD | error naming the path; no card |
| the user denies the card | the declined result in "The card"; nothing pushed |
| head sha changed or tree became dirty while the card was open | error `[chat] the branch changed while the card was open; nothing was pushed` |
| the turn is cancelled after allow (`ctx.signal` aborted) | error `[chat] the turn was cancelled; nothing was pushed` |
| `git push` fails | error with the push failure; koda is not called |
| koda answers non-2xx | error `[chat] koda did not create the flow (HTTP <status>): <koda message>; branch <branch> stays pushed`, where `<koda message>` is the client error's text after `answered <status>: ` |
| koda answers an unexpected 2xx or a body missing fields (`FLOW_KODA_UNEXPECTED_RESPONSE`, or the client's `MEMORY_KODA_BAD_RESPONSE`) | error `[chat] koda answered unexpectedly: <message>; branch <branch> stays pushed` |
| any other error thrown inside the tool (a git rejection, a rejecting `approve`, an unclassified koda error) | error `[chat] flow send failed: <message>` |
| koda unreachable or timed out | error `[chat] koda could not be reached: <message>; branch <branch> stays pushed and no flow was created` |

## Out of Scope

- A new `koda` credential kind in the `nax auth` store, and `nax auth login koda`, are not part of this
  feature; the connection is `memory.koda.url` plus `memory.koda.headers`.
- Resolving `agent.modelAliases` for the role models is not part of this feature; `roles` are sent as given.
- Committing the spec files is not part of this tool; it requires a clean tree and never runs `git commit`.
- Supporting non-GitHub remotes (GitLab, self-hosted) is not part of this feature; koda accepts GitHub only.
- Polling or watching the flow after creation is not part of this feature; the result carries the flow's
  link and the flow lives in koda.
- A config key for the koda request timeout is not part of this feature; it is the named constant
  `FLOW_KODA_REQUEST_TIMEOUT_MS`.
- Offering `nax-flow__send` to native or ACP subagents, or to `nax agents run`, is not part of this feature.
- US-001 only: a `costCapUsd` written in exponent notation (for example `1e-7`) fails the `String()` rule like any other bad value and needs no separate check.
- Configuring a koda web root separate from the API origin is not part of this feature; the flow link uses
  the origin of `memory.koda.url`.
- Granting the koda agent `fleet.flow.create` is a koda-side setup step, not part of this feature; a 403
  is reported as a koda error.

## Stories

### US-001 — The koda connection and the flow input

Workdir: packages/nax. No dependencies.

Create `packages/nax/src/chat/flow/` with a barrel. Add `kodaFlowConnection(config)` (the connection in
"Credential and connection", or `undefined`) and `parseFlowSendInput(raw)` (the checks in "The request",
returning the parsed input with every `dependsOn` defaulted to `[]`, or `{ errors: string[] }`).

### US-002 — Repository state and the koda call

Workdir: packages/nax. Depends on US-001.

Add `normalizeGitHubRemote(url)` (the HTTPS form or `null`), `readFlowRepoState(repoRoot, specPaths)`
(the `{ ok }` union in "The repository"), `checkFlowBranch(branch, features)` and
`createKodaFlow(connection, body)` (the POST through `createKodaClient` with `FLOW_KODA_REQUEST_TIMEOUT_MS`,
returning the 201 or 202 outcome, throwing `FLOW_KODA_UNEXPECTED_RESPONSE` for any other answer, and
rethrowing the client's `NaxError` unchanged). Git calls go through `_flowRepoDeps`. Export all of them from
the flow barrel.

### US-003 — The nax-flow__send tool and its card

Workdir: packages/nax. Depends on US-002.

Create `createFlowProvider(options: FlowProviderOptions)` returning the static provider `nax-flow` with the
one tool `send`, its collaborators behind `_flowProviderDeps`. Its run checks the input, the branch rules and
the repository through US-001 and US-002, builds the card in "The card", asks through the
`approve` function it is given, and on allow re-checks the head, pushes with `commitAndPush` (skipCommit) and
calls `createKodaFlow`, turning every outcome into the results in "After allow" and Failure Handling. Add
`buildFlowInstructions()` in `packages/nax/src/prompts/builders/flow-builder.ts`, exported from `@/prompts`,
as the provider's instructions. Export `createFlowProvider` from the flow barrel.

### US-004 — Offer the tool to the chat brain only

Workdir: packages/nax. Depends on US-003.

In `createHostJobs`, compose `createFlowProvider` when `kodaFlowConnection(config)` returns a connection,
with `approve: (card) => options.asks.requestHostApproval(card)` (never the full-mode-skipping wrapper), and
return it in the new `providers` field after the jobs provider. Change the chat host's parent list to spread
`hostJobs?.providers`. Add `nax-flow` to `ACP_CHAT_PROVIDER_IDS`. Keep it out of `resources.toolProviders`
and `ACP_SUBAGENT_PROVIDER_IDS`. `chat-host.ts` stays at 599 lines.

### Context Files

**US-001**

- `packages/nax/src/config/schemas-memory.ts` — the `memory.koda` block the connection reads
- `packages/nax/src/memory/koda-http.ts` — `CreateKodaClientInput`, the shape the connection feeds

**US-002**

- `packages/nax/src/memory/koda-http.ts` — the koda client, its error codes and `kodaStatusOf`
- `packages/nax/src/finish/commit.ts` — `isDirty`, `headSha` and the `_finishGitDeps` seam
- `packages/nax/src/utils/git.ts` — `isPublishableBranch` and `gitWithTimeout`
- `packages/nax/src/forge/detect.ts` — the existing `git remote get-url origin` call to follow
- `packages/nax/src/chat/flow/index.ts` — created by US-001, extended here

**US-003**

- `packages/nax/src/chat/jobs/jobs-provider.ts` — the static provider and tool shape to mirror
- `packages/nax/src/chat/jobs/chain-tools.ts` — card `reason` line conventions and the declined wording
- `packages/nax/src/chat/ask-controller.ts` — `HostApprovalCard` and `requestHostApproval`
- `packages/nax/src/prompts/builders/workflow-builder.ts` — `buildJobsInstructions`, the builder precedent
- `packages/nax/src/chat/flow/index.ts` — created by US-001, consumed here

**US-004**

- `packages/nax/src/chat/jobs/jobs-host.ts` — where the parent chat's jobs provider is composed
- `packages/nax/src/chat/chat-host.ts` — the parent provider list and the subagent `toolProviders`
- `packages/nax/src/chat/acp/acp-tools.ts` — `ACP_CHAT_PROVIDER_IDS`
- `packages/nax/src/chat/acp/acp-subagent-session.ts` — `ACP_SUBAGENT_PROVIDER_IDS`, which must not change
- `packages/nax/src/chat/flow/index.ts` — created by US-001, consumed here

### Creates

**US-001**

- `packages/nax/src/chat/flow/index.ts` — barrel for the flow module
- `packages/nax/src/chat/flow/flow-input.ts` — `parseFlowSendInput` and the input types
- `packages/nax/src/chat/flow/flow-connection.ts` — `kodaFlowConnection`

**US-002**

- `packages/nax/src/chat/flow/flow-repo.ts` — `normalizeGitHubRemote`, `readFlowRepoState`, `checkFlowBranch` and `_flowRepoDeps`
- `packages/nax/src/chat/flow/flow-koda.ts` — `createKodaFlow` and `FLOW_KODA_REQUEST_TIMEOUT_MS`

**US-003**

- `packages/nax/src/chat/flow/flow-provider.ts` — `createFlowProvider`, `FlowProviderOptions`, `_flowProviderDeps`, `FLOW_PUSH_COMMIT_MESSAGE` and the `send` tool
- `packages/nax/src/prompts/builders/flow-builder.ts` — `buildFlowInstructions`

### Modifies

**US-001**

None. The story only adds new files under `packages/nax/src/chat/flow/`.

**US-002**

None. The story adds new files and extends the flow barrel US-001 created; no existing assertion breaks.

**US-003**

- `packages/nax/src/prompts/index.ts` — must export `buildFlowInstructions` so the provider imports it through the prompts barrel.

**US-004**

- `packages/nax/src/chat/acp/acp-tools.ts` — `ACP_CHAT_PROVIDER_IDS` gains `nax-flow` between `nax-jobs` and `nax-memory`.
- `packages/nax/test/unit/chat/acp/acp-tools.test.ts` — pins `ACP_CHAT_PROVIDER_IDS` to the three-id list; it must expect `["nax-workflow", "nax-jobs", "nax-flow", "nax-memory"]`.
- `packages/nax/src/chat/jobs/jobs-host.ts` — composes the flow provider for the parent chat when the connection is present.
- `packages/nax/src/chat/chat-host.ts` — line 212 spreads `hostJobs?.providers ?? []` instead of `[hostJobs.provider]`, keeping the file at 599 lines.
- `packages/nax/test/helpers/chat-subagents.ts` — `SubagentHostOptions` gains optional `kodaConnection` (written into the config's `memory.koda` url and headers) and `naxEntry` (passed to `createChatHost`), so a subagent turn can run with the flow provider composed; existing callers pass neither and are unchanged. The new test lives in the host-subagents unit test file.

### Seams

- `[unit]` give `createChatHost` resources, a nax entry and a config whose `memory.koda.url` is set with an `authorization` header; start a native session; assert the open request's `toolProviders` contain `nax-flow` directly after `nax-jobs`.
- `[unit]` in `host-subagents.test.ts`, with the `chat-subagents.ts` harness given `kodaConnection` and `naxEntry`, start the host, send a turn that runs a subagent, and assert `nestedBackends[0].toolProviders` ids do not include `nax-flow`.
- `[unit]` with a koda connection, `_flowProviderDeps.readFlowRepoState` stubbed to `{ ok: true, branch: "feat/x", sha, remoteUrl }` and `_flowProviderDeps.headSha`/`isDirty` stubbed to the same sha and a clean tree, start the host in full mode and run its `nax-flow__send` tool with a valid input; assert the chat's `ChatAskController` has one pending host card whose `tool` is `nax-flow__send`.

## Acceptance Criteria

### US-001 — The koda connection and the flow input

- `[unit]` `kodaFlowConnection` returns the url and headers when `memory.koda.url` is `https://koda.example/api` and `memory.koda.headers` holds `Authorization: Bearer k`.
- `[unit]` `kodaFlowConnection` returns `undefined` when `memory.koda.url` is unset.
- `[unit]` `kodaFlowConnection` returns `undefined` when `memory.koda.headers` has no `authorization` header in any letter case.
- `[unit]` `kodaFlowConnection` returns `undefined` when the `authorization` header value is empty or whitespace.
- `[unit]` `kodaFlowConnection` returns the connection when the header name is spelled `AUTHORIZATION`.
- `[unit]` `parseFlowSendInput` returns the parsed input, with each missing `dependsOn` set to an empty array, for two valid features, two role strings and `costCapUsd` 5.
- `[unit]` `parseFlowSendInput` returns `errors` naming `features` when the list is empty.
- `[unit]` `parseFlowSendInput` returns `errors` naming `features` when it is not an array.
- `[unit]` `parseFlowSendInput` returns `errors` naming the extra key when the input has a key other than `features`, `roles` and `costCapUsd`.
- `[unit]` `parseFlowSendInput` returns `errors` naming `roles.supervisor` when `roles` has no `supervisor`.
- `[unit]` `parseFlowSendInput` returns `errors` naming `features` when the list has 21 entries.
- `[unit]` `parseFlowSendInput` returns `errors` naming the feature when a `feature` starts with `-`.
- `[unit]` `parseFlowSendInput` returns `errors` naming the duplicate when two features share a name.
- `[unit]` `parseFlowSendInput` returns `errors` naming the `specPath` when it contains a `..` segment.
- `[unit]` `parseFlowSendInput` returns `errors` naming the `specPath` when it does not end in `.md`.
- `[unit]` `parseFlowSendInput` returns `errors` naming the `specPath` when it starts with `/`.
- `[unit]` `parseFlowSendInput` returns `errors` naming the `specPath` when it contains a NUL character.
- `[unit]` `parseFlowSendInput` returns `errors` naming the dependency when `dependsOn` names a feature listed later.
- `[unit]` `parseFlowSendInput` returns `errors` naming `dependsOn` when it lists the same feature twice.
- `[unit]` `parseFlowSendInput` returns `errors` naming the role when `roles.reviewer` contains a space.
- `[unit]` `parseFlowSendInput` returns `errors` naming `costCapUsd` when it is 0.
- `[unit]` `parseFlowSendInput` returns `errors` naming `costCapUsd` when it is 1000.01.
- `[unit]` `parseFlowSendInput` returns `errors` naming `costCapUsd` when it is 1.23456.
- `[unit]` `parseFlowSendInput` returns `errors` naming `costCapUsd` when it is the string `"5"`.

### US-002 — Repository state and the koda call

- `[unit]` `normalizeGitHubRemote` returns `https://github.com/o/r` for `git@github.com:O/R.git`.
- `[unit]` `normalizeGitHubRemote` returns `https://github.com/o/r` for `ssh://git@github.com/o/r.git`.
- `[unit]` `normalizeGitHubRemote` returns `https://github.com/o/r` for `https://github.com/o/r/`.
- `[unit]` `normalizeGitHubRemote` returns `null` for `https://gitlab.com/o/r.git`.
- `[unit]` with `_flowRepoDeps.git` answering branch `feat/x`, origin `git@github.com:o/r.git` and every `cat-file` successfully, `_flowRepoDeps.isDirty` false and `_flowRepoDeps.headSha` a 40-hex sha, `readFlowRepoState` returns `{ ok: true, branch: "feat/x", sha, remoteUrl: "https://github.com/o/r" }`.
- `[unit]` `readFlowRepoState` returns `{ ok: false, message: "[chat] nax-flow__send needs a checked-out branch" }` when `_flowRepoDeps.git` fails `symbolic-ref`.
- `[unit]` `readFlowRepoState` returns `ok: false` with a message naming `main` when the branch is `main`.
- `[unit]` `readFlowRepoState` returns `{ ok: false, message: "[chat] commit or stash your changes before sending a flow" }` when `_flowRepoDeps.isDirty` returns true.
- `[unit]` `readFlowRepoState` returns `ok: false` with a message starting `[chat] could not read the repository state: ` when `_flowRepoDeps.isDirty` throws.
- `[unit]` `readFlowRepoState` returns `{ ok: false, message: "[chat] the branch has no commits" }` when `_flowRepoDeps.headSha` returns null.
- `[unit]` `readFlowRepoState` returns `{ ok: false, message: "[chat] the repository has no origin remote" }` when `_flowRepoDeps.git` fails `remote get-url origin`.
- `[unit]` `readFlowRepoState` returns `ok: false` with a message naming `https://gitlab.com/o/r.git` when that is the origin.
- `[unit]` `readFlowRepoState` returns `ok: false` with a message naming the path when `_flowRepoDeps.git` fails `cat-file -e HEAD:<specPath>` for one spec path.
- `[unit]` `readFlowRepoState` returns the branch message, not the dirty-tree message, when the branch is `main` and the tree is dirty.
- `[unit]` `checkFlowBranch("feat/x", features)` returns `undefined` for features `x` then `y`.
- `[unit]` `checkFlowBranch` returns a message naming the branch for `feat//x`.
- `[unit]` `checkFlowBranch("feat/y", features)` returns a message naming feature `y` when `y` is at index 1.
- `[unit]` `createKodaFlow` with connection url `https://koda.example/api` posts the body to `https://koda.example/api/fleet/flows` through `createKodaClient` with timeout `FLOW_KODA_REQUEST_TIMEOUT_MS`, which equals 30000, and returns `{ kind: "created", id, state, url }` for a 201 envelope.
- `[unit]` `createKodaFlow` returns `{ kind: "held", requestId }` for a 202 envelope whose `data.id` is the request id.
- `[unit]` `createKodaFlow` rethrows the client's `NaxError` with code `MEMORY_KODA_HTTP` unchanged when koda answers 404.
- `[unit]` `createKodaFlow` throws `NaxError` code `FLOW_KODA_UNEXPECTED_RESPONSE` for a 200 answer.
- `[unit]` `createKodaFlow` throws `NaxError` code `FLOW_KODA_UNEXPECTED_RESPONSE` for a 201 answer whose `data` has no `url`.

### US-003 — The nax-flow__send tool and its card

- `[unit]` `createFlowProvider` returns a provider with id `nax-flow` whose `tools()` yields exactly one tool, local name `send`.
- `[unit]` the provider's `instructions()` returns the output of `buildFlowInstructions()`.
- `[unit]` `buildFlowInstructions()` returns text that names `nax-flow__send` and states that koda asks for its own approval before anything billed starts.
- `[unit]` running `send` with an input that fails `parseFlowSendInput` returns an `isError` result listing the errors and never calls `approve`.
- `[unit]` running `send` when `_flowProviderDeps.readFlowRepoState` returns `{ ok: false, message }` returns an `isError` result with that message and never calls `approve`.
- `[unit]` running `send` on branch `feat/y` with feature `y` at index 1 returns the `checkFlowBranch` message as an `isError` result and never calls `approve`.
- `[unit]` running `send` with a valid input calls `approve` once with a card whose `tool` is `nax-flow__send`, `summary` is `send a flow of 2 feature(s) to koda` and `command` is `git push --set-upstream origin feat/x`.
- `[unit]` for features `a` then `b` (b after a) at `.nax/features/<name>/spec.md`, reviewer `acp:codex`, supervisor `acp:claude`, cost cap 5 and sha `0123456789abcdef...`, the card's `reason` equals the five lines `repo https://github.com/o/r on branch feat/x at 01234567`, `1. a (.nax/features/a/spec.md)`, `2. b (.nax/features/b/spec.md) — after: a`, `reviewer acp:codex, supervisor acp:claude` and `cost cap $5.00`, then `koda will ask you to approve this flow before anything billed starts`, joined with `\n`.
- `[unit]` the card passed to `approve` carries the tool run's `ctx.signal`.
- `[unit]` when `ctx.signal` is aborted after `approve` returns `allow`, `send` returns `[chat] the turn was cancelled; nothing was pushed` and does not call `commitAndPush`.
- `[unit]` when `approve` rejects, `send` returns an `isError` result starting `[chat] flow send failed: ` and does not push.
- `[unit]` when `approve` returns `deny`, `send` returns `[chat] the user declined sending the flow to koda; do not retry with different arguments unless the user asks` and calls neither push nor koda.
- `[unit]` when `_flowProviderDeps.headSha` read after allow returns a sha different from the carded one, `send` returns `[chat] the branch changed while the card was open; nothing was pushed` and does not push.
- `[unit]` when `_flowProviderDeps.isDirty` returns true after allow, `send` returns the same branch-changed result and does not push.
- `[unit]` on allow `send` calls `_flowProviderDeps.commitAndPush` with the repo root, the branch, `FLOW_PUSH_COMMIT_MESSAGE` and `skipCommit: true` before calling `_flowProviderDeps.createKodaFlow`.
- `[unit]` when `_flowProviderDeps.commitAndPush` throws, `send` returns an `isError` result carrying the push message and does not call `createKodaFlow`.
- `[unit]` `send` passes `_flowProviderDeps.createKodaFlow` a body with `remoteUrl`, `branch`, `specSha` equal to the carded sha, the features with `dependsOn` arrays, `roles` and `costCapUsd`.
- `[unit]` for a created outcome with `url` `/sandbox/flows/f1` and connection url `https://koda.example/api`, the result's first line is `{"flow":"f1","state":"PENDING","url":"https://koda.example/sandbox/flows/f1"}`.
- `[unit]` for a created outcome, the result's second line is `koda will ask you to approve this flow before anything billed starts.`
- `[unit]` for a held outcome with request id `r1`, the result is `koda is holding the flow create for approval (request r1); no flow exists until it is approved, and pushing new commits to the branch before then makes koda refuse it.`
- `[unit]` when `createKodaFlow` throws `MEMORY_KODA_HTTP` status 404 with message `[memory] koda POST /fleet/flows answered 404: repo not found`, `send` returns `[chat] koda did not create the flow (HTTP 404): repo not found; branch feat/x stays pushed`.
- `[unit]` when `createKodaFlow` throws `FLOW_KODA_UNEXPECTED_RESPONSE`, `send` returns an `isError` result starting `[chat] koda answered unexpectedly: ` and ending `; branch feat/x stays pushed`.
- `[unit]` when `createKodaFlow` throws `MEMORY_KODA_TIMEOUT`, `send` returns an `isError` result starting `[chat] koda could not be reached: ` and ending `branch feat/x stays pushed and no flow was created`.

### US-004 — Offer the tool to the chat brain only

- `[unit]` `createChatHost` with resources, a nax entry and a koda connection passes an open request whose `toolProviders` contain `nax-flow` directly after `nax-jobs`.
- `[unit]` `createChatHost` with resources and a nax entry but no `memory.koda` block passes `toolProviders` without `nax-flow`.
- `[unit]` in `host-subagents.test.ts`, with the `chat-subagents.ts` harness given `kodaConnection` and `naxEntry`, a subagent turn's `nestedBackends[0].toolProviders` ids do not include `nax-flow`.
- `[unit]` with a koda connection, the repository deps stubbed to a clean `feat/x` and the session in full mode, running the host's `nax-flow__send` with a valid input leaves one pending host card with `tool` `nax-flow__send` on the chat's `ChatAskController`.
- `[unit]` `createHostJobs` with a koda connection returns `providers` whose ids are `["nax-jobs", "nax-flow"]`, and `["nax-jobs"]` without one.
- `[unit]` `ACP_CHAT_PROVIDER_IDS` equals `["nax-workflow", "nax-jobs", "nax-flow", "nax-memory"]`.
- `[unit]` `chatAcpTools` given the `nax-flow` provider with default options returns a tool named `nax-flow__send`.
