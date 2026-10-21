# SPEC: Workflow CI repair and one CI readiness rule

## Summary

A workflow-mode feature whose PR CI fails today ends as a draft, and nothing in nax tries to fix it. This spec
adds a bounded CI repair to the feature graph: when the PR head's CI fails, nax reads the failing checks' logs
from the forge, runs one repair session from them (the same branch-fix path the final-gate repair uses), runs
the local gates again, pushes, and waits for CI again. It also makes every path that marks a PR ready use one
CI rule, strict green: the workflow's own publish, `nax workflow promote`, and `nax bot fix`. `nax bot fix`
waits for CI on the head it pushed before marking a draft ready, and never marks a nax-workflow draft ready
(that stays `nax workflow promote`'s job until PR-thread rulings land in a later phase).

## Motivation

Verified on `main` @ `818f0e954` (2026-10-21), across 90 workflow `result.json` files in real projects: 45 PRs
ended ready and 40 draft. The largest draft reason was "CI failed" (18). Sampled failures were real test
failures in suites the local gates do not run (smoke, Postgres e2e, Python tests) and one dependency audit the
branch did not cause. Fixing them is manual today.

Two defects sit next to it:

- `nax bot fix`'s `readyStep` (`src/bot/fix-report.ts`) marks any draft PR ready, also on the `nothing` exit,
  and reads no CI state. Run on a nax-workflow draft, it would promote a PR the workflow held.
- The CI rule differs by path. `nax workflow promote` (`ciGreen`, `src/cli/workflow-promote.ts`) requires
  `green`. The workflow publish (`ciReason`, `src/workflow/approval.ts`) treats `pending` (the CI wait timed
  out) as no reason, so the PR can go ready with CI still running: 8 of the 90 runs did. The user ruled
  2026-10-21: strict green everywhere. This supersedes the earlier workflow ruling W-R9 ("CI pending does not
  block").

Design source: workspace master plan `nax-step-graph-and-bot-master-plan.md` §B4 parts 1 and 2 (rulings
2026-10-21).

## Design

### Approach

- **Graph-native repair loop.** The repair loops through graph transitions (`publish` -> `ci-repair` ->
  `final-gates` -> `publish`), the same shape as `final-gates` -> `gate-repair` -> `final-gates`. There is no
  inline retry loop (`.nax/rules/retry-strategy.md`).
- **`publish` itself does not change.** `finalize.ts` is at 599 of 600 allowed lines. The repair decision is
  made in `publishStep` (`src/workflow/feature-steps.ts`) after `env.steps.publish` returns, through a new
  optional step `env.steps.readCiFailures`. The G0 equivalence harness supplies no such step, so every golden
  trace stays byte-identical.
- **The repair session is `env.steps.branchFix`.** `ciRepairStep` passes the failing checks as findings
  (`kind: "gate"`, severity `important`, ids `C1..Cn`), exactly as `gateRepairStep` passes red-gate excerpts
  (ids `G1..`). `ciRepairDecision` and `ciRepairStep` live in `feature-steps.ts`, next to `gateRepairStep`,
  because they use its module-private `limitsOf`, `costExceeded` and `roundLabel`. The file is 468 lines.
- **Logs come from the forge CLI** through a new `readFailedChecks` in `src/forge/ci-failures.ts`. The argv
  shapes were probed live on GitHub (koda) and GitLab (store-erp) on 2026-10-21.
- **One CI rule.** `ciAllowsReady(outcome)` in `src/workflow/ci-wait.ts` is `outcome === "green"`.
  `ciReason` gives a reason for every `FeatureCiState` except `green` and `skipped`, which adds `pending`. Bot
  fix and promote call `ciAllowsReady`. `src/bot/` and `src/cli/` import it by relative path from the
  `ci-wait.ts` leaf, never through the `@/workflow` barrel: `src/cli/workflow-promote.ts:19-22` explains the
  cycle that barrel would close.
- **nax-workflow PRs are recognised by a hidden marker.** The workflow PR body starts with the line
  `<!-- nax-workflow:v1 -->`. A forged or copied marker can only make `nax bot fix` more careful (it keeps the
  draft), never less.
- **A pending draft is retryable.** Because `pending` now keeps a PR a draft, a re-run at the same HEAD
  publishes again (and waits for CI again) instead of stopping as already-finished, the way an `unavailable`
  draft does today. This applies only when the pending CI is the draft's sole reason (`reasons` has exactly one
  entry), so a draft held for an unrelated reason is not re-published on every run. A repair round already
  spent stays spent (`ciRepairRounds` carries over), which is accepted.

### Integration

Read-only symbols (verified on `main` @ `818f0e954`):

- `waitForChecks(forge, prRef, { cwd, timeoutMs, pollMs, signal?, expectedSha? }): Promise<CiWaitResult>` and
  `CiWaitOutcome = "green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable"` in
  `src/workflow/ci-wait.ts`.
- `resolvePrRef(number, deps, cwd): Promise<PrRef>`, `encodeProjectPath(repo)`, `PrRef { forge, host, repo,
  number }` and `ForgeDeps { run(cmd, { cwd, timeoutMs? }), readText(path) }` from `@/forge`.
- `redactSecrets(text)` from `@/logger`.
- `env.steps.branchFix(findings: readonly WorkflowFinding[]): Promise<BranchFixOutcome>`, with
  `BranchFixOutcome { reply?, failure?, autoCommitted: boolean, dirty: boolean }` (`src/workflow/branch-fix.ts`).
- `WorkflowFindingDraft { kind, severity, issue, file?, line?, acId?, suggestion?, observed?, gate? }` from
  `@/operations`.
- In `src/workflow/feature-steps.ts`: `featureStep`, `ledgerText.note`, `NO_MIRROR` and `readHeadSoft`, plus
  the module-private `limitsOf`, `costExceeded` and `roundLabel`. Pattern to mirror: `gateRepairStep` and
  `gateRepairAllowed`.
- `resolveWorkflowConfig` and `WORKFLOW_DEFAULTS` in `src/config/schemas-workflow.ts`.
- `markReadyArgv(forge, prRef)` in `src/workflow/promote.ts`.
- `buildWorkflowRunSummary` (`src/workflow/run-summary.ts`) and `reportWorkflowRun`
  (`src/execution/workflow-end-report.ts`).

Mutated symbols. The baseline only locates the code; it is never the interface to implement.

- `ciReason` (`src/workflow/approval.ts`).
  - Baseline: `pending` returns `undefined`.
  - Target: `pending` returns `detail ?? "CI still pending after the wait"`. `green` and `skipped` return
    `undefined`. The other states are unchanged.
  - The comments that say pending never blocks are updated: `approval.ts:101-103` (W-R9), `ci-wait.ts:5`,
    `finalize.ts:61-64` (`ciDetailFields`) and `finalize.ts:530`. Comment edits do not grow `finalize.ts`.
  - `DETAILED_CI_STATES` is unchanged, so a pending record keeps no `ciDetail` and its open item uses the
    fallback text, while the publish-time reason carries the wait's own detail. This is intended.
- `isTransientDraft` (`src/workflow/feature.ts`).
  - Target: a `draft` with `ci === "pending"` and exactly one entry in `reasons` is transient, like
    `ci === "unavailable"`.
- `readyStep(env, state)` (`src/bot/fix-report.ts`).
  - Baseline: a draft PR -> `markReadyArgv` runs, giving `{ markedReady: true }`.
  - Target: see "Bot fix ready step" below. Adds the state field `readyHeld?: string`.
- `ciGreen` (`src/cli/workflow-promote.ts`).
  - Baseline: `result.outcome === "green"` inline.
  - Target: `ciAllowsReady(result.outcome)`, with unchanged behaviour.
- `buildWorkflowPrBody(input)` (`src/workflow/pr-body.ts`).
  - Baseline: the body starts with `## Summary`.
  - Target: the body starts with `NAX_WORKFLOW_PR_MARKER` followed by a blank line, on every path including the
    truncated one.
- `FeatureStep` (`src/workflow/types.ts`) and `FEATURE_STEPS` (`src/workflow/feature-record.ts`).
  - Target: both include `"ci-repair"`.
- `WorkflowFeatureRecord` (`src/workflow/types.ts`).
  - Target: adds `ciRepairFindings?: readonly WorkflowFindingDraft[]` and `ciRepairRounds?: number`.
- `FeatureLimits` (`src/workflow/branch-fix-rounds.ts`).
  - Target: adds `ciRepairRounds?: number`. An absent value reads as `0`.
- `FeatureSteps` (`src/workflow/feature-machine.ts`).
  - Target: adds the optional `readCiFailures?(input: { url: string; head: string }): Promise<readonly FailedCheck[]>`.
- `FEATURE_GRAPH` (`src/workflow/feature-graph.ts`).
  - Target: `publish` declares `exits: ["ci-repair"]` with transitions `[{ on: "ci-repair", to: "ci-repair" },
    { to: "done" }]`, and adds `"ciRepairFindings"` to its `produces`.
  - A new node `ci-repair`: `kind: "agent"`, `commits: true`, `produces: ["ciRepairRounds",
    "ciRepairFindings"]`, transitions `[{ to: "final-gates" }]`, `run: ciRepairStep`.
- `finalGatesStep` (`src/workflow/feature-steps.ts`).
  - Baseline: it reuses `repoGates` when `!rec.fixRan`.
  - Target: it reuses them only when `!rec.fixRan && !rec.ciRepairRounds`.
- `approvalEvidence` (`src/workflow/finalize.ts`).
  - Target: its gate-repair lines move to a new `repairEvidence(record)` in `src/workflow/repair-evidence.ts`,
    which also returns the CI-repair line. `finalize.ts` must not grow.
- `WorkflowSummaryView` (`src/log-format/types.ts`).
  - Target: adds `ciRepairRounds?: number`, beside `gateRepairRounds`.

### CI failure reader (`src/forge/ci-failures.ts`, exported from `@/forge`)

```ts
export interface FailedCheck {
  readonly name: string;
  readonly url?: string;
  readonly excerpt: string;
}
export const MAX_FAILED_CHECKS = 5;
export const CI_EXCERPT_LINES = 200;
export const CI_EXCERPT_CHARS = 8_000;
export function prNumberFromUrl(url: string): number | null;
export function ciExcerpt(log: string): string;
export async function readFailedChecks(
  ref: PrRef,
  headSha: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<readonly FailedCheck[]>;
```

- **`prNumberFromUrl`:** the number after `/pull/` (GitHub) or `/merge_requests/` (GitLab), optionally followed
  by `/`, `?` or `#`. It returns `null` for anything else.
- **`ciExcerpt`:** removes ANSI CSI escape sequences (ESC `[` ... final byte), keeps the last `CI_EXCERPT_LINES`
  lines, then the last `CI_EXCERPT_CHARS` characters, then applies `redactSecrets`.
- **GitHub:**
  1. Call `["gh", "api", "--hostname", ref.host, "repos/<repo>/commits/<headSha>/check-runs?per_page=100&filter=latest"]`.
     The reply is `{ check_runs: [{ id, name, conclusion, html_url, app: { slug }, output: { title, summary, text } }] }`.
     Only this first page is read.
  2. A check run failed when its `conclusion` is non-null and not `success`, `skipped` or `neutral`. This covers
     `failure`, `timed_out`, `cancelled`, `startup_failure`, `action_required` and `stale`, so every check the
     CI wait counts as failed is listed. The first `MAX_FAILED_CHECKS` failed runs are kept, in reply order.
  3. For `app.slug` `github-actions`, the log comes from
     `["gh", "run", "view", "--job", "<id>", "--log-failed", "-R", "<host>/<repo>"]`. For a GitHub Actions
     check run, its id is the job id (verified live).
  4. For any other app, the excerpt input is the non-empty values among `output.title`, `output.summary` and
     `output.text`, joined with `\n`, or `(no output)` when all three are empty.
  5. `url` is `html_url`.
- **GitLab** (project segment `encodeProjectPath(ref.repo)`):
  1. Call `["glab", "api", "--hostname", ref.host, "projects/<enc>/merge_requests/<number>/pipelines?per_page=20"]`.
     The first entry whose `sha` equals `headSha` is the pipeline. When there is none, the result is `[]`.
  2. Call `["glab", "api", "--hostname", ref.host, "projects/<enc>/pipelines/<id>/jobs?scope[]=failed&per_page=100"]`.
     Jobs with `allow_failure: true` are dropped, and the first `MAX_FAILED_CHECKS` are kept.
  3. Read each job's log with `["glab", "api", "--hostname", ref.host, "projects/<enc>/jobs/<id>/trace"]`. `url`
     is the job's `web_url`, and `name` is its `name`.
- **Errors:**
  - A per-check log call that exits non-zero gives the excerpt `(log unavailable: <first stderr line>)`. It is
    not an error.
  - A listing call (check-runs, pipelines or jobs) that exits non-zero, or whose reply does not parse, throws
    `NaxError` code `FORGE_CI_READ_FAILED`.

### Workflow CI repair

- **Config:** `workflow.ciRepairRounds`, an integer `>= 0`, default `1`. `buildFeatureEnv`
  (`src/workflow/feature-env.ts`) wires it into `FeatureLimits`, as it does `finalGateRepairRounds`.
  `DEFAULT_LIMITS` (`feature-steps.ts`) reads `WORKFLOW_DEFAULTS.ciRepairRounds`.
- **Decision.** `ciRepairDecision(env, rec, out, head)` in `feature-steps.ts` is called by `publishStep` after
  `env.steps.publish` returns. It is a separate function, to stay under the complexity gate. It returns findings
  (route to `ci-repair`) or nothing.
  - **When it runs:** it calls `env.steps.readCiFailures({ url: out.url, head })` only when all of these hold:
    - `out.outcome === "draft"` and `out.ci === "failed"`;
    - `out.url` is set, and the head was read;
    - `env.steps.readCiFailures` exists;
    - `(rec.ciRepairRounds ?? 0) < (limitsOf(env).ciRepairRounds ?? 0)`;
    - `costExceeded(env)` is false.
  - **On a non-empty list:** it writes the ledger note `CI failed: <names joined ", "> (repairing)`, and
    `publishStep` returns its usual patch plus `ciRepairFindings`, with exit `"ci-repair"`.
    - Each finding is `{ kind: "gate", severity: "important", issue: "CI check <name> failed:\n<excerpt>" }`.
    - It adds `suggestion: "See <url>"` when `url` is set.
  - **On an empty list:** it writes the ledger note `CI failed but no failed check was found for <head>`, and
    `publishStep` returns its usual patch with no exit.
  - **On a throw:** it writes the ledger note `CI logs unavailable: <message>`, and `publishStep` returns its
    usual patch with no exit.
- **`ciRepairStep(env, rec)`** in `feature-steps.ts` mirrors `gateRepairStep`.
  - `round = (rec.ciRepairRounds ?? 0) + 1`.
  - If `round > limit`, it writes the ledger note `CI repair skipped: round <round> is past
    workflow.ciRepairRounds (<limit>)` and returns `{ patch: {} }`.
  - If `rec.ciRepairFindings` is empty or absent (a resume), it returns
    `{ patch: { ciRepairRounds: round } }` and makes no `branchFix` call.
  - Otherwise:
    - The findings get ids `C1..Cn`.
    - It writes the ledger note `CI repair r<round>: <n> item(s): C1, ...`.
    - It logs the step start line `roundLabel("ci-repair", round)` on `env.steps.modelFor?.("branch-fix")`.
    - It calls `env.steps.branchFix(findings)`.
    - It writes the same three conditional notes as gate repair: `CI repair session failed: <failure>`,
      `auto-committed the CI repair's edits`, and `CI repair left uncommitted edits: the auto-commit failed`.
    - Mirroring follows gate repair: the `CI failed ... (repairing)`, `CI failed but no failed check ...`,
      `CI logs unavailable ...`, `CI repair r<n> ...`, `CI repair skipped ...` and `CI repair session failed ...`
      notes are written with `NO_MIRROR`; the two auto-commit notes are mirrored.
    - It returns `{ patch: { ciRepairRounds: round, ciRepairFindings: undefined } }`.
- **After the repair:** `final-gates` re-runs the repo gates (see the reuse rule above), and its existing
  repair and red handling applies. Then `publish` runs again: it pushes the repair commit, finds the open
  draft, waits for CI on the new head, and keeps or promotes the PR by the usual rules.
- **Cost stop:** `hasAgentWork("ci-repair", rec)` is true when `rec.ciRepairFindings` is non-empty, so the
  existing `costStop` (skip to `final-gates`, `costLimited: true`) covers the node. `ciRepairDecision` checks
  `costExceeded` itself, so a cost-limited run does not loop.
- **Reporting:**
  - `repairEvidence(record)` returns the gate-repair line verbatim. When `ciRepairRounds` is set, it then
    returns `CI repair: <n> round(s) after CI failed on the PR; the repair diff was not re-reviewed`.
  - `buildWorkflowRunSummary` records `ciRepairRounds` when it is non-zero, as it does `gateRepairRounds`.
  - `reportWorkflowRun`'s summary line prints `CI repair rounds <n>`.
- **Production wiring:** `buildFeatureEnv` sets `steps.readCiFailures` to
  `(input) => readCiFailuresFor(fc, input)`. `readCiFailuresFor` (`src/workflow/ci-failures.ts`) runs
  `prNumberFromUrl(url)`, then `resolvePrRef(number, forge, fc.projectDir)`, then
  `readFailedChecks(ref, head, forge, fc.projectDir)`, all through
  `_ciFailuresDeps = { resolvePrRef, readFailedChecks, forge: defaultForgeDeps }`. A URL with no number throws
  `NaxError` code `WORKFLOW_CI_PR_URL`.

### Bot fix ready step

`readyStep` runs these checks in order:

1. **The PR is not a draft:** it returns `{ markedReady: false }` with exit `report` (unchanged).
2. **`hasNaxWorkflowMarker(env.info.body)` is true** (the body contains the marker line): it makes no forge
   call and returns `{ markedReady: false, readyHeld: "nax workflow PR: promote it with nax workflow promote" }`.
3. **Otherwise it waits for CI:**
   `_fixReportDeps.waitForChecks(env.ref.forge, env.info.url, { cwd: env.repoRoot, timeoutMs, pollMs, expectedSha: state.pushedSha ?? env.info.headSha })`.
   `timeoutMs` and `pollMs` come from `resolveWorkflowConfig(env.config).timeouts.ciWaitMs` and `.ciPollMs`.
   - If `ciAllowsReady(outcome)` is false, it returns `{ markedReady: false, readyHeld: "CI <outcome>: <detail>" }`.
   - If it is true, `markReadyArgv` runs as today (a non-zero exit still throws `BOT_FIX_READY_FAILED`), and it
     returns `{ markedReady: true }`.

`renderFixSummary` appends `Kept as draft: <readyHeld>` when `readyHeld` is set, and `Marked ready.` when
`markedReady` is true. The `ready` node of `BOT_FIX_GRAPH` adds `"readyHeld"` to `produces`.

### Failure Handling

| Case | Behaviour |
|---|---|
| CI listing call fails (non-zero or unparseable) | `readFailedChecks` throws `FORGE_CI_READ_FAILED`; ledger `CI logs unavailable: <message>`, no repair, the PR stays a draft |
| One check's log call fails | that check's excerpt is `(log unavailable: <first stderr line>)`; the other checks are still read |
| No failed check found (or GitLab: no pipeline for the head) | empty list; ledger `CI failed but no failed check was found for <head>`; no repair |
| Rounds used up, or cost limit reached | no repair; publish outcome as today |
| Repair session fails or changes nothing | ledger note; `final-gates` and `publish` run again; CI stays failed; no further round once the limit is reached |
| PR URL has no number | `readCiFailuresFor` throws `WORKFLOW_CI_PR_URL`; handled as a read failure |
| A re-run finds a `pending` draft at the same HEAD whose only reason is the pending CI | it re-publishes, like an `unavailable` draft; a pending draft with other reasons stays finished |
| Bot fix: CI not green on the head | `readyHeld` reason; the PR stays a draft; the summary says why |
| Bot fix: nax-workflow marker present | no CI wait and no ready |
| Bot fix: the mark-ready command fails | throws `BOT_FIX_READY_FAILED` (unchanged) |

## Out of Scope

- PR-thread rulings (a reply on a nax bot thread counts as the ruling), and posting the workflow's flagged rulings and advisor holds as PR threads, are B4 part 3, a later spec; until then `nax bot fix` never marks a nax-workflow draft ready.
- `nax bot fix` does not repair CI on any PR; CI repair runs only inside `nax run`, after publish, on the PR the workflow published.
- Re-running failed CI jobs (flake retry) and detecting failures the branch did not cause are not handled; such a failure costs one repair round and the PR stays a draft.
- Legacy GitHub commit statuses (the statuses API) are not read, only check runs, and only the first 100 check runs of a commit.
- Workflow PRs opened before this change carry no marker, so `nax bot fix` treats them as ordinary drafts and marks one ready once CI is green.
- The `nax bot fix` CI wait has no early exit for a repository without CI; such a repository waits `workflow.timeouts.ciWaitMs` and keeps the draft.
- Publish modes `push` and `none` have no PR, so they get no CI repair.
- The GitLab "CI status unavailable" case (no open MR found right after creation) was fixed in #2600 and is not addressed here.
- The shared review checklist and the review split between the branch review and `nax bot review` are B4 part 3.
- The nax-finish skill changes are B4 part 4.
- `log-format/workflow-summary.ts` (the other summary renderer) is not changed to show `ciRepairRounds`.
- Documentation updates (`docs/guides/workflow-mode.md`, `docs/guides/configuration.md`) are a manual follow-up after merge.

## Stories

There are eight stories in one capability: a workflow PR that ends ready only on green CI, with one repair
attempt. Eight is past the guide's size check, so the scope was confirmed as one capability: every story serves
the same ready/draft outcome, and the split exists only to keep Context Files at 5 or fewer and ACs under the
24 cap after `nax plan` splits compound ACs. Every story runs in `packages/nax`.

### US-001: CI failure reader: helpers and GitHub
No dependencies. Workdir: packages/nax.

Adds `FailedCheck`, `MAX_FAILED_CHECKS`, `CI_EXCERPT_LINES`, `CI_EXCERPT_CHARS`, `prNumberFromUrl`, `ciExcerpt`
and `readFailedChecks` in `src/forge/ci-failures.ts`, exported from `@/forge`. It covers the helpers and the
GitHub path of "CI failure reader" in Design.

### US-002: CI failure reader: GitLab and error handling
Depends on US-001. Workdir: packages/nax.

Adds the GitLab path of `readFailedChecks`, the per-check `(log unavailable: ...)` excerpt, and the
`FORGE_CI_READ_FAILED` errors for both forges, as described in "CI failure reader" in Design.

### US-003: One CI readiness rule
No dependencies. Workdir: packages/nax.

Adds `ciAllowsReady` to `src/workflow/ci-wait.ts`. Changes `ciReason` so that `pending` gives a reason, and
updates the stale comments named in Design. Changes `ciGreen` in `src/cli/workflow-promote.ts` to call `ciAllowsReady`,
imported by relative path. Makes a `pending` draft transient in `isTransientDraft`.

### US-004: Workflow PR marker
No dependencies. Workdir: packages/nax.

Adds `NAX_WORKFLOW_PR_MARKER` and `hasNaxWorkflowMarker` to `src/forge/marker.ts`, exported from `@/forge`,
and makes `buildWorkflowPrBody` start every body with the marker.

### US-005: Bot fix ready step waits for CI and leaves workflow PRs alone
Depends on US-003, US-004. Workdir: packages/nax.

Rewrites `readyStep` as described in "Bot fix ready step" in Design. Adds `waitForChecks` to `_fixReportDeps`
(imported by relative path from `../workflow/ci-wait`), adds `readyHeld` to `BotFixState` and to the `ready`
node's `produces`, and adds the two summary lines to `renderFixSummary`.

### US-006: CI repair decision after publish
Depends on US-001. Workdir: packages/nax.

Adds `workflow.ciRepairRounds` (schema, runtime type, `FIELD_DESCRIPTIONS`), `FeatureLimits.ciRepairRounds`,
the `DEFAULT_LIMITS` entry, `"ci-repair"` in `FeatureStep` and `FEATURE_STEPS`, the record fields
`ciRepairFindings` and `ciRepairRounds`, and `FeatureSteps.readCiFailures`. Adds `ciRepairDecision` and its
call in `publishStep` (exit `"ci-repair"` with findings). `FailedCheck` from US-001 is used only as a type.
Extends the feature-machine test harness with `ciFailures` and `publishedSeq` options.

### US-007: CI repair node in the feature graph
Depends on US-006. Workdir: packages/nax.

Adds `ciRepairStep` in `feature-steps.ts`, the `final-gates` reuse rule and the `hasAgentWork` case. Adds the
`FEATURE_GRAPH` changes: the `publish` exits and transitions, and the `ci-repair` node.

### US-008: Production CI log wiring and reporting
Depends on US-002, US-007. Workdir: packages/nax.

Adds `readCiFailuresFor` and `_ciFailuresDeps` in `src/workflow/ci-failures.ts`, and wires
`steps.readCiFailures` and `limits.ciRepairRounds` in `buildFeatureEnv`. Adds `repairEvidence` in
`src/workflow/repair-evidence.ts` and uses it in `approvalEvidence`. Adds `ciRepairRounds` to
`WorkflowSummaryView`, `buildWorkflowRunSummary` and `reportWorkflowRun`.

### Context Files

**US-001**
- `packages/nax/src/forge/issues.ts`
- `packages/nax/src/forge/pr-read.ts`
- `packages/nax/src/forge/types.ts`
- `packages/nax/src/forge/index.ts`

**US-002**
- `packages/nax/src/forge/threads.ts`
- `packages/nax/src/forge/pr-read.ts`
- `packages/nax/src/forge/ci-failures.ts` — created by US-001, extended here

**US-003**
- `packages/nax/src/workflow/approval.ts`
- `packages/nax/src/workflow/ci-wait.ts`
- `packages/nax/src/cli/workflow-promote.ts`
- `packages/nax/src/workflow/feature.ts`
- `packages/nax/src/workflow/open-items.ts`

**US-004**
- `packages/nax/src/forge/marker.ts`
- `packages/nax/src/forge/index.ts`
- `packages/nax/src/workflow/pr-body.ts`

**US-005**
- `packages/nax/src/bot/fix-report.ts`
- `packages/nax/src/bot/fix-steps.ts`
- `packages/nax/src/bot/fix-run.ts`
- `packages/nax/src/workflow/ci-wait.ts`
- `packages/nax/src/config/schemas-workflow.ts`

**US-006**
- `packages/nax/src/workflow/feature-steps.ts`
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/workflow/types.ts`
- `packages/nax/src/workflow/feature-record.ts`
- `packages/nax/src/config/schemas-workflow.ts`

**US-007**
- `packages/nax/src/workflow/feature-steps.ts`
- `packages/nax/src/workflow/feature-graph.ts`
- `packages/nax/src/workflow/branch-fix.ts`

**US-008**
- `packages/nax/src/workflow/feature-env.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/workflow/run-summary.ts`
- `packages/nax/src/log-format/types.ts`
- `packages/nax/src/execution/workflow-end-report.ts`

### Creates

**US-001**
- `packages/nax/src/forge/ci-failures.ts`
- `packages/nax/test/unit/forge/ci-failures.test.ts`

**US-002**
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — split by concern from `ci-failures.test.ts` (US-001 creates that file, and a later story cannot list it under Modifies)

**US-006**
- `packages/nax/test/unit/workflow/feature-steps-ci-repair-decision.test.ts`

**US-007**
- `packages/nax/test/unit/workflow/feature-steps-ci-repair.test.ts`

**US-008**
- `packages/nax/src/workflow/ci-failures.ts`
- `packages/nax/src/workflow/repair-evidence.ts`
- `packages/nax/test/unit/workflow/ci-failures.test.ts`
- `packages/nax/test/unit/workflow/repair-evidence.test.ts`

### Modifies

**US-003**
- `packages/nax/test/unit/workflow/approval.test.ts` — the `READY` fixture uses `ci: "pending"`, and the test "all conditions hold -> no reasons; CI pending does not block (W-R9)" pins `[]`. Pending now blocks (user ruling 2026-10-21, strict green), so the fixture uses `ci: "green"`, the test name drops the W-R9 clause, and the `test.each(["green", "pending", "skipped"])` "AC-8 blocks nothing" case drops `"pending"`, keeping the invariant that green and skipped CI add no reason.
- `packages/nax/test/unit/workflow/open-items-kinds.test.ts` — `test.each(["green", "pending", "skipped"])` "AC-8: %s adds no ci item" includes `"pending"`. Pending now yields a `_run:ci` item, so the case drops `"pending"`, keeping the invariant that green and skipped add no ci item.
- `packages/nax/test/unit/workflow/finalize.test.ts` — two tests rely on pending CI adding no reason. "happy path: push, draft PR, CI pending, advisor approves -> promoted, ready" wires `ci: "pending"` and pins `{ outcome: "ready", ci: "pending", ... }`; it now wires `ci: "green"`, is renamed "CI green", and pins `ci: "green"`, keeping the invariant that a clean feature with an approving advisor is promoted. "a deterministic reason keeps the draft and never asks the advisor (P4-R10)" calls bare `wire()` (default CI `pending`) and pins `reasons` `toEqual(["stories gate-open: US-001"])`; it now calls `wire({ ci: "green" })`, keeping the invariant that one deterministic reason keeps the draft and the advisor is never asked.
- `packages/nax/test/unit/workflow/feature.test.ts` — the "US-002 transient drafts" `test.each` gains a row `["pending", "pending", ["no CI result within 1200000ms"]]` asserting the same re-publish (record resumed at `publish`, one publish call), plus a case asserting a pending draft with two reasons is `already-finished`; existing rows are unchanged, keeping the invariant that only transient drafts re-publish at the same HEAD.
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — "slow CI (pending) still asks the advisor (W-R9)" pins that a pending wait asks the advisor. Under strict green a pending wait is a readiness reason, so the test becomes "slow CI (pending) keeps the draft and never asks the advisor", asserting that `asked` is `[]`, that the update kept the draft, and that the reasons contain the wait's detail. This keeps the invariant that the CI wait's outcome decides whether the advisor is asked.
- `packages/nax/test/integration/workflow/feature-e2e.test.ts` — "review -> one fix -> re-review -> gates -> push -> draft PR -> CI timeout (pending) -> approved -> ready" scripts `gh pr checks` as pending and pins `outcome: "ready", ci: "pending"`. The script now reports a passing check (`[{"name":"t","state":"SUCCESS","bucket":"pass"}]`), the title says "CI green", and the record pins `outcome: "ready", ci: "green"`, keeping the invariant that the full review-fix-publish path ends ready.

**US-004**
- `packages/nax/test/unit/workflow/pr-body.test.ts` — the body-order and Closes tests locate sections with `indexOf` and are unaffected; the new marker ACs are added to this file, and no existing assertion changes. Listed so the story may edit it.

**US-005**
- `packages/nax/test/integration/bot/fix-report.test.ts` — the new ready-step and summary ACs are added to this file. The existing `readyStep` tests expect `markReadyArgv` to run for any draft and pin `{ patch: { markedReady: true }, exit: "report" }`. Ready now waits for CI first, so the draft cases stub `_fixReportDeps.waitForChecks` to return `{ outcome: "green", detail: "all checks passed" }`. This keeps the invariants that a green draft is marked ready, a ready PR is left alone, and a failed mark-ready throws `BOT_FIX_READY_FAILED`.

**US-006**
- `packages/nax/test/unit/config/workflow-config.test.ts` — asserts `parsed.workflow` with `toEqual` on the whole defaults object (lines 9-24); the schema gains `ciRepairRounds`, so the expected object gains `ciRepairRounds: 1`, keeping the invariant that the workflow defaults are pinned exactly.
- `packages/nax/test/helpers/workflow-feature-machine.ts` — the harness returns one fixed `published` outcome and has no `readCiFailures`; it gains a `publishedSeq?: PublishOutcome[]` option (successive `publish` calls return successive entries, the last one repeating) and a `ciFailures?: readonly FailedCheck[] | Error` option (when set, `steps.readCiFailures` is defined, records the call, and returns or rejects with it). Callers that pass neither keep today's behaviour, so every G0 golden stays identical.

**US-007**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — the node list, the `publish` transitions (`[{ to: "done" }]`), the expected exits table, the expected `produces` table, the node kinds table, and the list of committing nodes (`["branch-fix", "gate-repair", "publish"]`) all pin the old graph. They gain the `ci-repair` node (kind `agent`, commits, produces `ciRepairRounds` and `ciRepairFindings`); `publish` gains exits `["ci-repair"]`, transitions `[{ on: "ci-repair", to: "ci-repair" }, { to: "done" }]`, and `ciRepairFindings` in its `produces`; and `ci-repair` joins the committing list. This keeps the invariant that the graph's declared shape is pinned exactly.

**US-008**
- `packages/nax/test/unit/workflow/feature-env.test.ts` — asserts `env.limits` `toEqual({ maxBranchFixRounds: 4, finalGateRepairRounds: 0 })`. Limits now carry `ciRepairRounds`, so the expected object gains `ciRepairRounds: 1` (the default), keeping the invariant that limits come from the workflow config.

### Seams

- **US-006 -> US-001:** `ciRepairDecision` and `FeatureSteps.readCiFailures` use `FailedCheck` (type only). The production caller of `readFailedChecks` is US-008's `readCiFailuresFor`.
- **US-008 -> US-001/US-002:** `readCiFailuresFor` calls `readFailedChecks`. The seam AC is in US-008, entered through `buildFeatureEnv(...).steps.readCiFailures`.
- **US-008 -> US-006:** `buildFeatureEnv` supplies `steps.readCiFailures` and `limits.ciRepairRounds`, which `ciRepairDecision` reads.
- **US-007 -> US-006:** the `ci-repair` node consumes the `ciRepairFindings` that `publishStep` produces, exercised through `runFeatureMachine` in US-007.
- **US-005 -> US-003/US-004:** `readyStep` calls `ciAllowsReady` and `hasNaxWorkflowMarker`. The seam ACs are in US-005, entered through `runStepGraph(BOT_FIX_GRAPH, ...)`.

## Acceptance Criteria

Verification note for every story:
- Tests import `@/forge`, `@/bot` and `@/config` symbols through their barrels, so a missing export fails the
  story's own tests.
- Workflow leaves (`ci-wait.ts`, `feature-steps.ts`, `ci-failures.ts`, `repair-evidence.ts`) are imported by
  their module path, because `@/workflow` cannot be loaded from `cli` or `bot`.
- The static gates are `bun run typecheck` and `bun run check:all` (`check:alias-internals`, `check:file-sizes`,
  `check:import-cycles` with baseline 0, and the complexity gate).
- `finalize.ts` must stay at or under 600 lines.
- Forge calls go through injected `ForgeDeps` or `_deps` and are faked in tests. No test touches a real forge
  or model.
- Tests live in the file that mirrors the source file (`.nax/rules/test-architecture.md`). US-003 adds to
  `approval.test.ts`, `ci-wait.test.ts`, `open-items-kinds.test.ts`, `workflow-promote.test.ts` and
  `feature.test.ts`; US-004 to `marker.test.ts` and `pr-body.test.ts`; US-005 to `fix-report.test.ts` (and
  `fix-graph.test.ts` for the graph runs).

### US-001

- [unit] `prNumberFromUrl("https://github.com/o/r/pull/42")` returns `42`.
- [unit] `prNumberFromUrl("https://gitlab.com/g/p/-/merge_requests/7")` returns `7`.
- [unit] `prNumberFromUrl("https://github.com/o/r/pull/42/files")` returns `42`.
- [unit] `prNumberFromUrl("https://github.com/o/r/issues/42")` returns `null`.
- [unit] `ciExcerpt`, given a log containing `"\u001b[31mfail\u001b[0m"`, returns text containing `fail` and no ESC character.
- [unit] `ciExcerpt`, given a 500-line log, returns its last `CI_EXCERPT_LINES` (200) lines.
- [unit] `ciExcerpt`, given a single line of 20,000 characters, returns its last `CI_EXCERPT_CHARS` (8,000) characters.
- [unit] `ciExcerpt`, given a log line `token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, returns text that does not include `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.
- [unit] `readFailedChecks` on a GitHub `PrRef` (host `github.com`, repo `o/r`) with head `abc123` calls `deps.run` first with `["gh", "api", "--hostname", "github.com", "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest"]`.
- [unit] `readFailedChecks` on GitHub returns a `FailedCheck` for each check run whose conclusion is `failure`, `timed_out`, `action_required` or `cancelled`, and none for a conclusion of `success`, `skipped`, `neutral` or `null`.
- [unit] `readFailedChecks` on GitHub with seven failed check runs returns the first five, in reply order.
- [unit] `readFailedChecks` on GitHub, for a failed run with `app.slug` `github-actions` and id `991`, calls `deps.run` with `["gh", "run", "view", "--job", "991", "--log-failed", "-R", "github.com/o/r"]`, and returns its stdout passed through `ciExcerpt` as `excerpt`, with `url` equal to `html_url`.
- [unit] `readFailedChecks` on GitHub, for a failed run from another app, makes no `gh run view` call, and returns an `excerpt` built from its `output.title`, `output.summary` and `output.text` joined by line feeds.
- [unit] `readFailedChecks` on GitHub, for a failed run from another app with empty output, returns the `excerpt` `(no output)`.

### US-002

- [unit] `readFailedChecks` on GitLab (repo `g/p`, number `7`, host `gitlab.com`) calls `deps.run` first with `["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/merge_requests/7/pipelines?per_page=20"]`.
- [unit] `readFailedChecks` on GitLab reads the jobs of the first pipeline whose `sha` equals the head, with `["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/pipelines/<id>/jobs?scope[]=failed&per_page=100"]`.
- [unit] `readFailedChecks` on GitLab returns `[]` and makes no jobs call when no pipeline's `sha` equals the head.
- [unit] `readFailedChecks` on GitLab drops a failed job with `allow_failure: true`.
- [unit] `readFailedChecks` on GitLab reads each kept job's log with `["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/<id>/trace"]`, and returns the job's `name`, its `web_url` as `url`, and the excerpt.
- [unit] `readFailedChecks` returns the excerpt `(log unavailable: boom)` for a check whose log call exits `1` with stderr `"boom\nmore"`, and still returns the other checks.
- [unit] `readFailedChecks` throws a `NaxError` with code `FORGE_CI_READ_FAILED` when the first listing call exits non-zero.
- [unit] `readFailedChecks` throws a `NaxError` with code `FORGE_CI_READ_FAILED` when the first listing call returns stdout that is not JSON.

### US-003

- [unit] `ciAllowsReady("green")` returns `true`.
- [unit] `ciAllowsReady` returns `false` for each of `"failed"`, `"pending"`, `"conflicting"`, `"no-checks"` and `"unavailable"`.
- [unit] `ciReason("pending", "no CI result within 1200000ms")` returns `"no CI result within 1200000ms"`.
- [unit] `ciReason("pending")` returns `"CI still pending after the wait"`.
- [unit] `ciReason("green")` and `ciReason("skipped")` both return `undefined`.
- [unit] `readinessReasons` with otherwise-ready facts and `ci: "pending"` returns a list containing the pending reason.
- [unit] `buildOpenItems` for a record with `ci: "pending"` returns a `_run:ci` item of kind `ci`.
- [unit] The `ci-green` check of `nax workflow promote` passes when the stubbed `waitForChecks` returns `green`, and fails with detail `ci pending: <detail>` when it returns `pending`.
- [unit] `runWorkflowFeature`, given a prior record with `step: "done"`, `outcome: "draft"`, `ci: "pending"` and one reason at the current HEAD, runs the feature machine starting at step `publish` instead of returning `already-finished`.
- [unit] `runWorkflowFeature`, given a prior pending draft at the current HEAD with two reasons, returns `already-finished` and runs no feature machine.

### US-004

- [unit] `hasNaxWorkflowMarker("<!-- nax-workflow:v1 -->\n\n## Summary")` returns `true`.
- [unit] `hasNaxWorkflowMarker("## Summary\n\nno marker")` returns `false`.
- [unit] `buildWorkflowPrBody(input)` returns a string that starts with `NAX_WORKFLOW_PR_MARKER` followed by `"\n\n## Summary"`.
- [unit] `buildWorkflowPrBody`, for an input large enough to be truncated to `PR_BODY_MAX_CHARS`, returns a string that starts with `NAX_WORKFLOW_PR_MARKER` and whose length is at most `PR_BODY_MAX_CHARS`.

### US-005

- [integration] `readyStep` for a PR that is not a draft returns `{ patch: { markedReady: false }, exit: "report" }`, and calls neither `waitForChecks` nor the forge.
- [integration] `readyStep` for a draft whose `info.body` contains `NAX_WORKFLOW_PR_MARKER` returns `markedReady: false` and `readyHeld` `"nax workflow PR: promote it with nax workflow promote"`, and calls neither `waitForChecks` nor the forge.
- [integration] `readyStep` for a draft after a push calls `_fixReportDeps.waitForChecks` with `expectedSha` equal to `state.pushedSha`.
- [integration] `readyStep` for a draft on the `nothing` path (no `pushedSha`) calls `waitForChecks` with `expectedSha` equal to `env.info.headSha`.
- [integration] `readyStep` passes `timeoutMs` and `pollMs` equal to `env.config.workflow.timeouts.ciWaitMs` and `ciPollMs` to `waitForChecks`.
- [integration] `readyStep` for a draft whose CI wait returns `{ outcome: "failed", detail: "a check failed" }` returns `markedReady: false` and `readyHeld` `"CI failed: a check failed"`, and runs no `markReadyArgv` command.
- [integration] `readyStep` for a draft whose CI wait returns `pending` returns `markedReady: false`, with a `readyHeld` starting `"CI pending: "`.
- [integration] `readyStep` for a draft whose CI wait returns `green` runs `markReadyArgv(env.ref.forge, "<number>")` and returns `{ patch: { markedReady: true }, exit: "report" }`.
- [integration] `readyStep` for a draft with green CI whose mark-ready command exits `1` throws a `NaxError` with code `BOT_FIX_READY_FAILED`.
- [unit] `renderFixSummary` for a state with `readyHeld: "CI failed: x"` contains the line `Kept as draft: CI failed: x`.
- [unit] `renderFixSummary` for a state with `markedReady: true` contains the line `Marked ready.`.
- [integration] Running `BOT_FIX_GRAPH` through `runStepGraph`, with a fix step that exits `nothing`, a draft PR without the marker, and a stubbed `waitForChecks` returning `failed`, ends with state `markedReady: false` and a `readyHeld` reason, and the forge never receives `markReadyArgv`.
- [integration] Running `BOT_FIX_GRAPH` through `runStepGraph`, with a fix step that exits `nothing` and a draft PR whose body carries the marker, never calls the stubbed `waitForChecks`.

### US-006

- [unit] `NaxConfigSchema.parse({})` yields `workflow.ciRepairRounds` equal to `1`.
- [unit] `NaxConfigSchema.safeParse({ workflow: { ciRepairRounds: -1 } })` fails.
- [unit] `FIELD_DESCRIPTIONS["workflow.ciRepairRounds"]` is a non-empty string.
- [unit] `FEATURE_STEPS` includes `"ci-repair"`.
- [unit] `publishStep` returns exit `"ci-repair"` and `ciRepairFindings` `[{ kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom", suggestion: "See u" }]` when `publish` returns `{ outcome: "draft", ci: "failed", url }`, a head is read, the limits have `ciRepairRounds: 1`, no rounds are used, and `readCiFailures` returns one check `{ name: "e2e", url: "u", excerpt: "boom" }`.
- [unit] `publishStep` in the repair case calls `readCiFailures` with the `url` from the publish outcome and the head read after publish.
- [unit] `publishStep` in the repair case with two failed checks named `e2e` and `lint` writes the ledger note `CI failed: e2e, lint (repairing)`.
- [unit] `publishStep` returns no exit and does not call `readCiFailures` when the publish outcome is `ready`.
- [unit] `publishStep` returns no exit and does not call `readCiFailures` when CI is `pending`.
- [unit] `publishStep` returns no exit and does not call `readCiFailures` when `rec.ciRepairRounds` equals the limit.
- [unit] `publishStep` returns no exit and does not call `readCiFailures` when the limits have no `ciRepairRounds`.
- [unit] `publishStep` returns no exit and does not call `readCiFailures` when `env.costExceeded` returns `true`.
- [unit] `publishStep` returns no exit and writes the ledger note `CI failed but no failed check was found for <head>` when `readCiFailures` returns `[]`.
- [unit] `publishStep` returns no exit and writes the ledger note `CI logs unavailable: nope` when `readCiFailures` rejects with `Error("nope")`.

### US-007

- [unit] `ciRepairStep` with two `ciRepairFindings` calls `env.steps.branchFix` once, with findings whose ids are `C1` and `C2`, and returns `{ patch: { ciRepairRounds: 1, ciRepairFindings: undefined } }`.
- [unit] `ciRepairStep` writes the ledger note `CI repair r1: 2 item(s): C1, C2` before it calls `branchFix`.
- [unit] `ciRepairStep` at round 2 logs a step start line labelled `ci-repair r2`.
- [unit] `ciRepairStep` writes `CI repair session failed: <failure>` when `branchFix` returns a `failure`.
- [unit] `ciRepairStep` writes `auto-committed the CI repair's edits` when `branchFix` returns `autoCommitted: true`.
- [unit] `ciRepairStep` writes `CI repair left uncommitted edits: the auto-commit failed` when `branchFix` returns `dirty: true`.
- [unit] `ciRepairStep` with `rec.ciRepairRounds: 1` and limit `1` makes no `branchFix` call, writes `CI repair skipped: round 2 is past workflow.ciRepairRounds (1)`, and returns `{ patch: {} }`.
- [unit] `ciRepairStep` with no `ciRepairFindings` makes no `branchFix` call and returns `{ patch: { ciRepairRounds: 1 } }`.
- [unit] `finalGatesStep` with `fixRan: false` and `ciRepairRounds: 1` runs `env.steps.repoGates` instead of reusing the recorded repo gates.
- [unit] `FEATURE_GRAPH` passes validation, and its `ci-repair` node is kind `agent`, commits, and transitions to `final-gates`.
- [unit] `runFeatureMachine` calls `branchFix` once (with finding `C1`), then `repoGates`, then `publish` a second time, and ends with `ciRepairRounds: 1` and outcome `ready`, when the branch review returns no findings, `publishedSeq` is draft/failed then ready/green, and `ciFailures` holds one check.
- [unit] `runFeatureMachine` with `publish` always returning draft/failed and limit `ciRepairRounds: 1` calls `publish` exactly twice, and calls `branchFix` for CI repair exactly once.
- [unit] The feature `costStop` for node `ci-repair`, with non-empty `ciRepairFindings` and `env.costExceeded` returning true, skips the node to `final-gates` with `costLimited: true`.

### US-008

- [unit] `buildFeatureEnv` sets `limits.ciRepairRounds` from `workflow.ciRepairRounds` (a config value of `3` yields `3`).
- [unit] `buildFeatureEnv(...).steps.readCiFailures({ url: "https://github.com/o/r/pull/9", head: "abc" })` calls `_ciFailuresDeps.resolvePrRef` with `9` and the project dir.
- [integration] `buildFeatureEnv(...).steps.readCiFailures` calls the stubbed `_ciFailuresDeps.readFailedChecks` with the resolved `PrRef`, `"abc"`, the forge deps and the project dir, and returns its result.
- [unit] `readCiFailuresFor`, given a URL that has no PR number, rejects with a `NaxError` with code `WORKFLOW_CI_PR_URL`, and calls neither `resolvePrRef` nor `readFailedChecks`.
- [unit] `repairEvidence` for a record with `gateRepairRounds: 1` returns the line `Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed`.
- [unit] `repairEvidence` for a record with `ciRepairRounds: 2` returns the line `CI repair: 2 round(s) after CI failed on the PR; the repair diff was not re-reviewed`.
- [unit] `repairEvidence` for a record with neither field returns `[]`.
- [unit] `approvalEvidence` for a record with `ciRepairRounds: 1` includes the CI repair line.
- [unit] `buildWorkflowRunSummary` for a record with `ciRepairRounds: 2` returns a summary with `ciRepairRounds: 2`, and for a record without it returns a summary with no `ciRepairRounds` field.
- [unit] `reportWorkflowRun` for a run whose summary view has `ciRepairRounds: 2` logs a summary line containing `CI repair rounds 2`.
