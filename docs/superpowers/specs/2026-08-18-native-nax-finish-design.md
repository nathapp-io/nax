# Native `nax finish` — replacing the acpx flow with an in-process post-run phase

Date: 2026-08-18
Status: Approved design, not yet implemented
Branch: `feat/native-nax-finish`
Baseline: `main` at `f243926d` (v0.80.1 + 1)

---

## 1. Summary

`nax-finish` today is an [acpx](https://www.npmjs.com/package/acpx) flow
(`flows/nax-finish/`, ~4,540 lines) executed by `acpx flow run` as a subprocess,
launched by a built-in post-run plugin (`src/plugins/builtin/nax-finish/`, 751
lines).

This design replaces it with `src/finish/` — an internal post-run **phase**
running in nax's own process, with every LLM step expressed as a
`RunOperation` driven by `callOp`. The acpx *flow engine* dependency is removed.
The acpx *CLI* dependency stays, because it is nax's agent transport everywhere.

This is a **strict port**: same graph shape, same caps, same escalation rules,
same PR body. Three known defects in code that moves anyway are fixed as part of
it, and are individually called out in section 8.

---

## 2. Why — the evidence

Everything in this section is independently re-verifiable from the commands
shown. It is recorded here so a reader with no prior context does not have to
re-derive it.

### 2.1 The observed failure is inside runs, not at their end

Three finish runs exist on disk, all on `etf-scraper`:

```
$ ls ~/.nax/etf-scraper/finish-audit/*/
crawl-status/run-2026-08-16T15-00-21-901Z.{jsonl,result.json}
alphavantage-jets/run-2026-08-17T05-59-29-470Z.{jsonl,result.json}
tier2-invesco/run-2026-08-17T02-27-25-518Z.{jsonl,result.json,decisions-*.json}
```

| feature | status | notes |
| --- | --- | --- |
| `crawl-status` | `opened` | PR #4 |
| `alphavantage-jets` | `opened` | PR #6 |
| `tier2-invesco` | `escalated` | 2 MEDIUM spec conflicts; correctly escalated, later resolved 1 fixed / 1 waived, PR #5 |

Terminal outcomes are therefore fine. The defect is one level down: **both runs
that reached the quality phase recorded `outcome: "unparseable"` on the quality
reviewer's first attempt — 2 of 2.**

```
crawl-status:       15:30:58 quality attempt 1 unparseable -> 15:32:40 attempt 2 passed   (102s lost)
alphavantage-jets:  07:45:44 quality attempt 1 unparseable -> 07:47:11 fixed              (87s lost)
```

`flows/nax-finish/verdict.ts:33` puts one review at "128s and ~4.2M tokens", and
`MAX_REPROMPT_ATTEMPTS = 1` means the *next* unparseable reply escalates the whole
run. Every finish is therefore one bad reply away from a false escalation.

Two independent causes were found.

### 2.2 Cause A — the flow parses rendered terminal output, not the agent's reply

In `node_modules/acpx/dist/flows-Cym6H3vg.js`:

```js
:453  function createQuietCaptureOutput() {
        const chunks = [];
        return { formatter: createOutputFormatter("quiet", { stdout: { write(chunk){ chunks.push(chunk) } } }),
                 read: () => chunks.join("").trim() };    // no separator
      }
:1633   rawText: capture.read(),          // <- what parse() receives
:1510   return node.parse ? await node.parse(rawText, context) : rawText;
```

Twelve lines above `:1633` the same function resolves `afterRecord.messages` and
computes `messageStart` / `messageEnd` from it. **The structured conversation
exists one variable away, and `parse()` is handed the stdout chunk stream
instead.**

`flows/nax-finish/findings-parse.ts:20` documents the consequence from the other
side: *"The reply the parser sees is the agent's whole message stream joined with
no separator, so the first heading of the final report lands mid-line whenever
the preceding narration message did not end in a newline."* The 55-line
`GLUED_HEADING` regex with three "load-bearing" guards — merged as #1624, the
newest commit on `main` — is a workaround for that lost boundary.

nax's own path does not lose it. `src/agents/acp/adapter-output.ts:19`:

```ts
export function extractOutput(response: { messages: Array<{role: string; content: string}> } | null): string {
  return response.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n").trim();
}
```

The same limitation forces the "**no parser here ever throws**" invariant
(`verdict.ts:10`), because `parseAcpOutput` (`:1508`) rethrows and acpx has no
error edge: a throw fails the node, which means exit 1, no result file, and no
notification.

### 2.3 Cause B — the reviewer prompt contradicts itself, negative instruction first

`flows/nax-finish/review-prompts.ts:386-393` assembles the prompt as
`WORKER_PROTOCOL` -> dimensions -> `CLASSIFIER` -> `outputContract(phase)`.

`WORKER_PROTOCOL` (`:280`):

> ## Output format — return ONLY this
> Return **only your findings**, nothing else: no `Spec:`/`Base:` header, **no
> `FINDINGS` divider**, no `VERDICT` line...

`outputContract` (`:319`), roughly 40 lines later:

> your reply must be these three sections, in this order
> `## TOUCHPOINTS` ... `## WALK` ... `## FINDINGS`

The code comment at `:308` acknowledges it: *"This supersedes the 'Output format
— return ONLY this' section of `WORKER_PROTOCOL` above, which is kept verbatim so
it stays diffable against the skill's `references/worker-protocol.md`."*

A model obeying the first, emphatic instruction emits no headings, so
`parseReviewReport` finds nothing, the JSON fallback tier fails, and the verdict
routes `reprompt`. That is the observed signature exactly.

### 2.4 The subsystem depends on an unreleased personal fork of acpx

```
$ which acpx      -> ~/.nvm/versions/node/v22.22.2/bin/acpx
$ npm ls -g acpx  -> acpx@0.13.1-next.1 -> ./../../workspace/sandbox/acpx
$ grep acpx package.json -> "acpx": "^0.12.1"        (node_modules holds 0.12.1)
```

The `acpx` on PATH is a local fork whose top commit is *"chore: bump version to
0.13.1-next.1 to mark fork builds"*, sitting on unreleased commits including
`feat(config): allow a model on agent entries`, `feat(flows): accept a model on
acp nodes`, and `feat(flows): apply node and agent model with global fallback`.

`~/.acpx/config.json` defines all six `nax-*-reviewer` agents with `{"argv": [...]}`.
The fork accepts `{command} | {argv}` (`src/cli/config.ts:23`); the pinned 0.12.1
does not:

```
$ node node_modules/acpx/dist/cli.js flow --help
Error: Invalid config agents.nax-spec-reviewer.command in ~/.acpx/config.json:
       expected non-empty string
```

That is a **config-load failure before any command runs** — exit 1, no result
file. The plugin's fail-open path then logs a warning and the run reports
success. On any machine without the fork, nax-finish silently does nothing.

The fork requirement is **entirely a flow-layer artifact**. nax's own transport
spawns acpx's *built-in* agent subcommands with top-level `--model`
(`src/agents/acp/spawn-client-session.ts:114-125`), both released features. Going
native therefore removes the fork dependency outright.

There is also a version skew: the flow's `import { defineFlow, extractJsonObject }
from "acpx/flows"` resolves to `<nax>/node_modules/acpx` (0.12.1) while the engine
executing it is the 0.13.1-next fork.

### 2.5 Config layering is bypassed

`flows/nax-finish/steps/quality.ts:84-102` reads `<repoRoot>/.nax/config.json`
raw and takes `cfg.quality?.commands`. It never sees `~/.nax/config.json`, the
active profile, `.nax/mono/<pkg>/config.json` overlays, or the compat-shim chain.
`steps/gates.ts:157-168` escalates with *"No quality.commands configured"* when
the result is empty.

The plugin already holds the fully resolved config (`index.ts` reads `ctx.config`
via `getFinishAutoFlowConfig`) and passes `workdir` instead. Note the
self-inconsistency: the profile mechanism supplies the *reviewers* and is ignored
for the *gates*.

Related and now fixed upstream: `src/config/loader.ts:456` — *"#1620: every
overlay layer runs the SAME compat-shim chain as the root layers."* Shims added
for removed finish keys will therefore apply at root, profile, and per-package
overlay alike.

### 2.6 The audit's `attempt` field mixes two counters

Review rounds are numbered by `reviewAttemptCount` (count of `review_<phase>`
steps) at `flows/nax-finish/steps/review-round.ts:44`; commit rounds are numbered
by `fixAttemptCount` (count of `fix_<phase>` steps) in `commitFixNode`. Same
phase, same trail. Real output from `alphavantage-jets`:

```
quality attempt 1  unparseable
quality attempt 1  fixed          <- actually review #2
quality attempt 3  passed
quality attempt 4  passed
```

A duplicated 1 and a missing 2, in the artifact a human reads to triage an
escalation.

### 2.7 Duplication that exists only because of the process boundary

`flows/nax-finish/pr-template.ts` states the cause in its own header:

> *"Ported rather than imported: `flows/` is loaded by acpx in its own Node
> process, where nax's `src/` and its `@/*` alias do not exist. This matches the
> convention already in this directory — `errors.ts`, `exec.ts`, `types.ts` and
> the PR body builder are all flow-local re-implementations."*

| concern | auto-pr | finish |
| --- | --- | --- |
| forge detect / open | `src/plugins/builtin/auto-pr/forge.ts` (78) | `flows/nax-finish/steps/forge.ts` (93) |
| repo PR template | `auto-pr/template.ts` (60) | `flows/nax-finish/pr-template.ts` (56) |
| PR body | `auto-pr/pr-body.ts` (134) | `steps/pr-body.ts` (462) + `pr-template-merge.ts` (253) |
| types | `auto-pr/types.ts` (41) | `flows/nax-finish/types.ts` (260) |

Removing the boundary removes the reason for the duplication.

### 2.8 Also true, and not addressed here

- `acpx flow run` has **no resume**, verified against `acpx flow run --help`
  (only `--input-json`, `--input-file`, `--default-agent`), even though the
  engine persists a full `FlowRunState` with steps, outputs, results and session
  bindings. Resume is explicitly deferred (section 7).
- `docs/guides/nax-finish-autoflow.md:65` still documents *"Known gap —
  test-only gate fixes are not re-reviewed"*, which #1510/#1542 closed. The doc
  must be updated or deleted at cutover.
- There is no `nax finish` CLI command. Deferred (section 7).

---

## 3. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Strict port**, but every LLM step goes through `callOp` | Keeps the 3,812 lines of existing tests meaningful and makes any regression attributable to the migration. `callOp` brings parse-retry, `ConfiguredModel` resolution, cost, prompt-audit. |
| D2 | Reviewers configured natively as `{agent, model, reasoningEffort?}` resolved by `resolveConfiguredModel` | Kills the `~/.acpx/config.json` custom agents and with them the fork dependency (2.4). |
| D3 | In scope: cost aggregation, reviewer-prose convergence. Deferred: `nax finish` CLI, resume | See section 7. |
| D4 | Reviewer prose canonical as `.md` **in nax**; `.ts` generated and committed; skills repo syncs with a CI drift check | nax's build is `bun build bin/nax.ts --outdir dist` with no asset-copy step and `files: ["dist/", "flows/"]`, so committed generated `.ts` avoids build changes while prose stays prose. |
| D5 | Finish is an internal **post-run phase**, not a plugin | `PostRunPhase` already exists (`src/pipeline/event-bus.ts:174`) and the phases have `ctx.runtime` in scope. Keeps `NaxRuntime` off the public plugin API. |
| D6 | `src/forge/` shared by auto-pr and finish; **auto-pr keeps working standalone** | Dedups ~1,100 lines (2.7) without making auto-pr depend on finish being enabled. |
| D7 | Finish opens its own **draft** early and promotes at the end | Preserves the `"promoted"` status and early forge visibility despite the ordering change in 4.1. |

---

## 4. Design

### 4.1 Placement and lifecycle

`src/finish/index.ts` exposes one entry point, `runFinishPhase(ctx)`, called from
the post-run sequence in `src/execution/runner-completion.ts` alongside the
regression, acceptance and review phases. It takes the live
`SequentialExecutionContext` (which `extends DispatchContext` and carries
`runtime`, `sessionManager`, `agentManager`, `abortSignal`, `config`, `feature`,
`featureDir`, `prdPath`), emits `postrun:phase:{started,completed}` with
`phase: "finish"`, and honours `ctx.abortSignal`.

Precedent: `runDeferredReview` is invoked exactly this way at
`src/execution/unified-executor.ts:173`. `RunnerCompletionOptions extends
DispatchContext` and `options.runtime` is already used throughout that file
(`:214`, `:334`, `:369`, `:380`, `:423`, `:427`), so no new plumbing is needed.

This also makes D5 stronger than "avoids extra plumbing". The rejected
alternative — sequencing finish after the plugin actions inside `cleanupRun` —
is not merely inconvenient, it is **unavailable**: `runner-completion.ts:427`
calls `await options.runtime?.close()` at the end of the completion phase, and
`cleanupRun` runs after that, from `runner.ts`'s `finally`. By the time auto-pr
executes, the runtime is closed, its auditors flushed, its cost aggregator
drained and its abort signal fired. There is no runtime left to thread.

`PostRunPhase` gains a `"finish"` member:

```ts
// src/pipeline/event-bus.ts:174
export type PostRunPhase = "regression" | "acceptance" | "review" | "acceptance-setup" | "finish";
```

Adding the member is not a single-site change. `src/execution/status-writer.ts:118-120`
narrows `setPostRunPhase` to `"acceptance" | "regression"` in its own overloads, and
`src/tui/hooks/usePipelineBusEvents.ts:243` maps phases to TUI rows. Both need the
new member, and an implementation plan must enumerate them rather than assume the
union is the only site.

Three things come free from being a phase rather than a plugin:

- `PostRunContext` is untouched; `NaxRuntime` never reaches third-party plugins.
- `postrun:phase:completed` already carries `costUsd`, satisfying D3's cost
  requirement by the same route the other phases use.
- `src/execution/status-writer.ts:118` (`setPostRunPhase`) and
  `src/tui/hooks/usePipelineBusEvents.ts:243` already render post-run phases, so
  finish becomes live in the TUI and `status.json` instead of an opaque
  subprocess.

`src/plugins/builtin/nax-finish/` is deleted entirely: `resolveFlowPath`,
`buildFlowArgv`, `buildFlowEnv`, `defaultRun`, `missingResultOutcome` and the
`NAX_FINISH_*` env-var channel exist only to marshal across a process boundary
that no longer exists. Telegram escalation moves to `src/finish/escalate.ts` and
keeps reading `interaction.*` config unchanged.

**Ordering consequence.** Post-run phases run before `cleanupRun`, where post-run
plugin actions execute — so finish now runs **before** auto-pr, inverting today's
order. This is safe: `src/plugins/builtin/auto-pr/index.ts:179-190` skips when an
open PR already exists for the branch, and re-checks after its push (the BUG-8
guard). Under D7 finish opens its own draft, so auto-pr almost always stands
down and in practice fires only for runs where finish is disabled.

### 4.2 Module decomposition

Every file stays under the 600-line `SRC_LIMIT` enforced by
`scripts/check-file-sizes.ts`.

```
src/finish/
  index.ts                 runFinishPhase(ctx); emits postrun:phase:*; owns the single
                           try/catch that routes any escape to escalate
  machine.ts               the 22-node graph as an explicit async state machine (~250 lines)
  state.ts                 FinishState, serializable from day one so resume is a later
                           drop-in rather than a rewrite
  gates/acceptance.ts      resolves groups via src/cli/features-acceptance.ts in-process
                           (replaces shelling `nax features resolve --json`)
  gates/quality.ts         src/quality/runner.ts + layered config (fixes 2.5)
  review/references/*.md   the 3 canonical prose files (~288 lines)
  review/prompts.gen.ts    generated from those .md, committed
  review/prompt.ts         assembly (fixes 2.3)
  review/parse.ts          findings parse; GLUED_HEADING deleted
  review/audit-gaps.ts     touchpoint / walk verification
  ops/review-op.ts         one RunOperation, parameterised by phase
  ops/fix-op.ts            one RunOperation, parameterised by phase
  ops/narrative-op.ts
  commit.ts                commit rounds, disposition validation
  audit.ts                 round trail (fixes 2.6)
  escalate.ts              telegram + forge comment
  pr.ts                    finish-specific PR body content (rounds, findings, gates ran)
                           and the draft/promote calls into src/forge/

src/forge/                 shared with auto-pr (D6): forge detection, hasOpenPr, repo
                           template discovery and merge, push, openDraft, promote.
                           Body *content* stays with each caller; only assembly and
                           template merging are shared.
```

### 4.3 Control flow

The graph becomes a state machine. acpx's `switch`/`cases` only ever encoded what
a `while` loop and a `switch` express directly; `finish_done` exists purely
because "acpx switch cases must name a real node". Each phase is a
`fix -> commit -> reverify` loop with its own cap. The `route_*` compute nodes
collapse into the loop condition, which is where they always belonged — their
entire purpose was making the cap deterministic instead of trusting the model's
self-reported route.

The review and fix ops are **one op each parameterised by phase**, not four. The
flow needed four nodes only because acpx routes on node id.

Per D7 the PR is opened as a **draft immediately after the acceptance gate first
passes** — the earliest point at which the branch is known to satisfy its own
contract — and promoted to ready after `quality_gates` goes green. A run that
escalates therefore still leaves a draft PR a human can open, which is when one
is most wanted. `src/forge/`'s `hasOpenPr` guard makes both calls idempotent, so
a re-run against a branch that already has a PR promotes rather than duplicates.

### 4.4 Invariants that must survive, as tested assertions

These are what 15 of the 22 commits across `flows/nax-finish/` and
`src/plugins/builtin/nax-finish/` bought — all 15 of them `fix:`. They exist
today as prose comments; in the port they become named, executable assertions.

| # | Invariant | Origin |
| --- | --- | --- |
| I1 | Nothing ran is not a pass — empty acceptance groups and empty `quality.commands` both escalate | #1398 |
| I2 | Every fix commits before anything re-reads the diff | #1397 |
| I3 | Caps are enforced by the loop, never by the model's self-reported route | — |
| I4 | A gate fix that committed re-enters the quality review | #1510 |
| I5 | Acceptance re-runs as gate zero before the repo's own commands | #1398 |
| I6 | Rounds are appended live, so a killed run still has its trail | — |
| I7 | Escalate is reachable from every failure path | #1399 |
| I8 | A spec fix re-runs acceptance before its re-review | — |

I7 changes character and improves. Today it is the fragile "no parser here ever
throws" rule, hand-maintained across every node because a throw under acpx means
exit 1 and no result file. In-process it becomes one `try/catch` at the phase
boundary that routes to escalate: the language enforces it, and a new node
cannot silently forget to opt in.

Two deletions follow directly from going native:

- `GLUED_HEADING` and its three guards, because `extractOutput` gives us
  `response.messages` (2.2).
- `MAX_REPROMPT_ATTEMPTS` and the reprompt counter, because
  `makeParseRetryStrategy` in `src/agents/retry` already does tiered parse-retry
  — the same one `src/operations/semantic-review.ts` uses.

### 4.5 Operations

The three ops map onto `RunOperation` without adaptation
(`src/operations/types.ts:193`):

- `session: { role, lifetime: "fresh" | "warm" }` — `lifetime: "fresh"` **is** the
  flow's `session: { isolated: true }`.
- `model?: OperationModel` accepts a `ConfiguredModel` literal or a resolver and
  is resolved by `resolveConfiguredModel` — exactly D2.

Four new entries in `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts:36`; the
list is closed and unknown roles are a spec-review failure):
`finish-review-spec`, `finish-review-quality`, `finish-fix`, `finish-narrative`.

### 4.6 Config

`finish.autoFlow.*` is flattened to `finish.*` — the segment is named after a flow
that will no longer exist — with a compat shim for the old path.

| key | fate |
| --- | --- |
| `flowPath` | **removed** — no flow file to point at |
| `defaultAgent`, `model` | **removed** — superseded by per-op `{agent, model}`. `model`'s "floor not override" semantics were the fork-only behaviour (2.4) |
| `reviewers.{spec,quality,narrative}` | **reshaped** — acpx profile name -> `{agent, model, reasoningEffort?}` |
| `timeouts.stepMs` | **reshaped** — was acpx `--timeout`; becomes the per-op timeout via `callOp`'s `resolveTimeoutMs` |
| `timeouts.flowMs` | **reshaped** — becomes the phase's `AbortSignal` deadline |
| `enabled`, `narrative`, `prBody`, `escalate`, `notify`, `timeouts.{acceptanceMs,gateMs}` | unchanged |

All nine `nax-finish-*.json` profiles (in `~/.nax/profiles/` and the `nax-global`
repo) need rewriting. The five that set only `{defaultAgent, model}` with no
`reviewers` are the ones that today depend on the fork's agent-entry `model`
support, and are the exact configs that would silently misbehave on stock acpx.

### 4.7 Budgets

No subprocess means no `proc.kill()`. `flowMs` becomes an `AbortSignal` deadline
on the phase, threaded into `callOp` (which already accepts one) and into the
gate runners. This is strictly better than today: killing the acpx process left
the working tree wherever the fix agent had reached, with no round recorded.

### 4.8 Cost

`callOp` books spend through `src/agents/cost` automatically, so finish's spend
lands in the run's `CostAggregator` with no extra work. Surfacing it per-phase is
**not** free, and an earlier draft of this design was wrong about that:

- `PostRunPhaseCompletedEvent.costUsd` exists (`src/pipeline/event-bus.ts:188`)
  and `src/pipeline/subscribers/reporters.ts:90,112` forwards it, but **no emitter
  in the codebase populates it today** — the acceptance phase at
  `runner-completion.ts:248-258` emits `durationMs` and `details` only. It is a
  declared channel, not an automatic mechanism.
- Finish must therefore take a `CostAggregator.snapshot()`
  (`src/runtime/cost-aggregator.ts:263`) before and after the phase and pass the
  delta as `costUsd` explicitly.
- **Ordering constraint:** `runner-completion.ts:427` closes the runtime with the
  comment *"flushes auditors, drains cost aggregator, aborts signal"*. Finish must
  run before that call, or its spend never reaches `totalCost` and its
  `AbortSignal` is already aborted.

Today `FinishResult` carries no cost at all, so this is still a net gain — it just
costs one snapshot pair rather than nothing.

### 4.9 Reviewer prose convergence

`flows/nax-finish/review-prompts.ts` is a character-for-character copy of the
`nax-toolkit-skills` repo's `skills/post-impl-review/references/*.md`, differing
only in template-literal escaping:

```
$ diff <(sed -n '228,300p' flows/nax-finish/review-prompts.ts) \
       ../nax-toolkit-skills/skills/post-impl-review/references/worker-protocol.md
<   Read this plus your dimension reference (\`spec-review.md\`...
>   Read this plus your dimension reference (`spec-review.md`...
```

468 lines of `.ts` against 288 lines of `.md` in a **separate GitHub repo**
(`git@github.com:nathapp-io/nax-toolkit-skills.git`).

Under D4: the `.md` files move into `src/finish/review/references/` as canonical,
a committed codegen step emits `prompts.gen.ts`, and
`scripts/check-review-prompts-generated.ts` fails the build on drift (fitting the
existing `scripts/check-*.ts` convention). The skills repo pulls the `.md` via a
sync script plus its own CI drift check.

**Not in scope:** `src/operations/semantic-review.ts` is a different reviewer —
per-story, during a run, `mode: "embedded" | "ref"`, fix-target lanes,
AC-grounding, recurrence-demotion. It shares machinery with the finish reviewers
(which the port supplies via `callOp`) but no content. There is nothing to
converge there.

---

## 5. Tests

`test/unit/flows/nax-finish/` is 3,812 lines across 17 files. `TEST_LIMIT` is 800.

**Ported unchanged (~2,400 lines).** The pure modules — `verdict`,
`findings-parse`, `commit-message`, `pr-title`, `pr-body`, `pr-template-merge`,
`narrative` — move to `test/unit/finish/` with imports rewritten and assertions
untouched. These keep guarding the same behaviour through the engine swap and are
the strongest evidence the port changed nothing.

**Replaced by coverage that has never existed.** `flow-graph.test.ts` (31KB) pokes
`flow.nodes.*` with hand-stubbed contexts; nothing has ever executed acpx's
engine, so the `edges` / `switch` / `cases` wiring — precisely where the five
silent-green bugs lived — is untested today. A state machine with injected op
stubs is directly drivable, so each invariant in 4.4 becomes an executable test:
I1 escalates on empty groups *and* empty `quality.commands`; I4 proves a
committed gate fix re-enters quality review; I7 proves every throw site lands on
escalate.

**Regression tests for the three fixes in section 8 must be proven to fail
against the old behaviour**, not merely pass against the new — otherwise a fix is
indistinguishable from a coincidence.

---

## 6. Cutover

Each step is independently revertable.

1. Extract `src/forge/`; switch auto-pr onto it. Existing auto-pr tests guard
   this. No behaviour change, finish not involved.
2. Build `src/finish/` alongside the flow. `flows/` still present and still
   wired; nothing switched.
3. Wire the phase into `src/execution/runner-completion.ts` behind
   `finish.enabled`. Both paths exist; the config key selects one.
4. Delete `flows/`, `src/plugins/builtin/nax-finish/`,
   `scripts/check-flows-no-bun.ts`, and `"flows/"` from `package.json` `files`.
   Update or delete `docs/guides/nax-finish-autoflow.md` (2.8). **The `acpx`
   dependency stays** — it is the agent transport for every op in nax; only the
   `acpx/flows` import goes.
5. `nax-toolkit-skills` PR: `references/*.md` become synced copies of nax's
   canonical files.

---

## 7. Out of scope

Deliberately deferred to later arcs, each recorded here so a future reader does
not mistake omission for oversight:

- **`nax finish [feature]` CLI.** Today the only entry points are a successful
  run or a hand-built `acpx flow run --input-json`, so a failed finish cannot be
  re-run without reconstructing the JSON. `FinishState` is designed serializable
  (4.2) so this stays cheap to add.
- **Resume from checkpoint.** Same reason; `state.ts` is shaped for it.
- **Converging `src/operations/semantic-review.ts`.** Different reviewer, no
  shared content (4.9).
- **Reconsidering the review loop itself** — the reprompt/incomplete counters,
  `MAX_FIX_ATTEMPTS = 3`, and whether escalation should remain
  model-discretionary. `tier2-invesco` escalated at spec attempt 1 with two
  MEDIUM findings it never attempted to fix; whether that is right is a design
  question, not a port question.

---

## 8. Defects fixed as part of the port

These are in code that moves regardless, and shipping the port with them intact
would be worse than fixing them. Each is a departure from a literal strict port
and is listed so the diff is not surprising.

| # | Defect | Location | Evidence |
| --- | --- | --- | --- |
| F1 | `WORKER_PROTOCOL` / `outputContract` contradiction | `review-prompts.ts:280` vs `:319`, comment at `:308` | 2.3 — leading candidate for the 2/2 unparseable rate |
| F2 | Raw single-file config read for quality commands | `steps/quality.ts:84`, used at `steps/gates.ts:157` | 2.5 — ignores global layer, active profile, and per-package overlays |
| F3 | Audit `attempt` field mixes two counters | `steps/review-round.ts:44` vs `commitFixNode` | 2.6 — real trail shows 1, 1, 3, 4 |

---

## 9. Verification

**Config-level.** A repo with `finish.enabled` and no root `quality.commands` but
per-package ones must now run its gates instead of escalating "nax-finish
verified nothing".

**Behaviour-level.** Run finish on `etf-scraper` — the only repo with recorded
finishes — and compare the new audit trail against the three in
`~/.nax/etf-scraper/finish-audit/`: same phases, same round shape, monotonic
`attempt` numbering, and **no `outcome: "unparseable"` on the quality reviewer's
first attempt**. That last one is the measurable target this work exists for.

**Environment-level.** The port is verified for reproducibility when a finish
completes with `~/workspace/sandbox/acpx` off `PATH` and only the published acpx
available.
