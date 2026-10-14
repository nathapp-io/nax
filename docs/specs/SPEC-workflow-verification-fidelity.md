# SPEC: Workflow Verification Fidelity

## Summary

A workflow run should report only what genuinely needs a human, and its telemetry should be accurate. Five
defects in the pre-release-hardening run (run `89cfafda`, nax 0.88.0-canary.1 `af2cadf7f`) broke that. This spec
fixes all five. nax#2523: nax's own test suites cannot pass inside a confined agent session, because 194 tests
fail there, almost all of them writing under a literal `/tmp/...`. A new confined test runner reproduces a session's sandbox, the failing tests
move onto the run's `$TMPDIR`, and CI runs the unit and integration suites confined. nax#2524: a partly fixed finding comes back
from a re-review twice. A new `PARTIAL` verdict carries the residual on the same finding id. nax#2525: the role
table drops cache read and write tokens. nax#2526: the publish step logs nothing for minutes while it waits for
CI. nax#2527: reviewers file `cannotVerify` items for checks that nax's own gates already cover. The review
prompts now state those gate results, expect a scoped test run, and narrow `cannotVerify`.

Closes: #2523, #2524, #2525, #2526, #2527, #2531

## Motivation

The pre-release-hardening workflow run ended as a draft PR with 2 rulings and 11 `cannot-verify` ledger lines.
Finishing it showed that most of those items were artefacts of the harness, not of the code:

- **nax#2523.** A census run inside a confined srt sandbox (the same `buildSandboxPolicy({ confined: true })` a
  session gets, `TMPDIR` set to the session dir) failed 15 nax-agent tests, 101 nax unit tests and 78 nax
  integration tests. Outside the sandbox the same tree is fully green. All but about a dozen of the 194 failures are a
  write under a literal `/tmp/...` path, which a confined session denies by design (nax#2301). The rest are
  nested-sandbox, detached-process and shared-`/tmp/nax` cases. So an agent session can never run the suite or the coverage gate, and every
  reviewer writes "could not run the full suite" as a `cannotVerify`.
- **nax#2527.** Reviewers had sandboxed Bash (nax#2500), and it worked. Yet 6 of 7 story reviewers ran nothing.
  The review prompt says reviewers "may" run commands. It never says that nax's lint, typecheck and scoped gates
  already ran green on the story, or that the full suite and repo gates run after the review. So "full suite
  not re-run" reads to the reviewer as a real gap. 9 of the run's 11 cannot-verify lines are this kind.
- **nax#2524.** The branch fix resolved most of finding B1. The re-review marked B1 `NOT_ADDRESSED` and also
  raised the leftover as a new critical finding B2, in a different file. One defect became two critical items
  and two advisor rulings.
- **nax#2525.** The advisor role showed `inputTokens: 4` for a $0.28 call. The cost ledger recorded
  `cacheRead: 54627, cacheWrite: 57056` for that call. `startTokenMeter` copies only `inputTokens` and
  `outputTokens`, so every role under-reports what it read.
- **nax#2526.** The publish step ran 4m 56s with no log line at any level between `final-gates green` and
  `publish draft <url>`. The time went to the CI wait, but the run looked hung.

## Design

### Approach

**Confined test runner (nax#2523).** A nax-agent script runs `bun test <paths>` inside the same OS sandbox a
confined agent session gets. It builds the policy with `buildSandboxPolicy({ confined: true, ... })`, wraps the
command with the srt backend, and exports `TMPDIR`/`TMP`/`TEMP` (the session temp dir under the run's own temp
root) plus `NAX_TEST_CONFINED=1`. It is the regression gate for test temp hygiene: a test that writes under a
literal `/tmp/...` path fails there exactly as it fails in an agent session, while a test that uses
`makeTempDir()` (which resolves through `os.tmpdir()`, and so through `$TMPDIR`) passes. Each package gets a
`test:confined` script, and CI runs it over `test/unit/` and `test/integration/` after the existing bubblewrap
install step. The runner lives in `packages/nax-agent/scripts/`, not `packages/repo-tooling/scripts/`, because it
imports nax-agent's own `src/sandbox` (repo-tooling may not import a package's `src/`).

The file lists in US-001, US-002 and US-003 are exhaustive for main `0bf6cef38`: the census ran every file under
`test/unit/` and `test/integration/` of both packages inside the confined sandbox. A failure a story finds outside
its list (a test added since) is fixed the same way, within the same story.

Failing tests are fixed by class:

- **Class A — the test makes its own temp dir or lock file under a literal `/tmp/...`.** Use `makeTempDir()` /
  `withTempDir()` / `cleanupTempDir()` from the package's `test/helpers`.
- **Class B — a "fake" fixture path the code under test actually writes** (for example
  `prdPath: "/tmp/test-prd.json"` reaching `savePRD`, which writes `/tmp/test-prd.json.tmp-<uuid>`). Point the
  fixture at a real temp dir, or stub the write through the module's existing `_deps` seam. These writes also
  leak into the host's `/tmp` on every ordinary run today.
- **Class C — the behaviour itself needs something a confined sandbox withholds** (a nested sandbox, a detached
  process probe, the shared `/tmp/nax` parent). Fix the test when its expectation is merely environment-dependent.
  Otherwise mark it `test.skipIf(isConfinedTestRun())`, with a comment that names what the sandbox withholds.

The `.nax/scratchpad/` directory is the agent's own notes space, written through the Scratchpad tools. It is not
a home for test fixtures: tests run on hosts and in CI too, and the test-side counterpart of the sandbox's own
"use $TMPDIR or .nax/scratchpad/, not /tmp" guidance is `$TMPDIR`.

**PARTIAL re-review verdict (nax#2524).** Both re-review prompts (story and branch) offer a third verdict,
`PARTIAL`, which must carry a `residual`. `parseReReviewReply` keeps the residual. A shared
`absorbReReviewVerdict` keeps the same finding id open with its issue replaced by the residual, and drops a new
finding that restates the residual at the same file and line. A `PARTIAL` with no usable residual fails closed
to `NOT_ADDRESSED`.

**Cache tokens (nax#2525).** `RoleTokens` gains optional `cacheReadTokens` and `cacheWriteTokens`.
`startTokenMeter` and `addRoleTokens` carry them, emitting each field only when it is non-zero, so every
existing role-entry shape is unchanged when there is no cache traffic. The workflow summary's role line appends
`cache r <n> w <n>` when either is non-zero. `inputTokens` keeps its meaning (uncached input).

**Publish progress (nax#2526).** `waitForChecks` logs a start line, a line whenever the check summary changes,
a heartbeat at least every 60 seconds while waiting, and an end line. `prMode` / `pushMode` / `finishPr` log
each publish sub-step.

**Reviewers see nax's gate results (nax#2527).** The workflow story review gets the story's gate states, and
the branch review gets the repo-gate summary. Both prompts get a "What nax already checked" block that states
those results and the gates that run after the review. They expect a scoped run of the story's own tests when a
shell tool is available, and they limit `cannotVerify` to what neither nax's gates nor a scoped command can
check. The shared `reviewerCommandsSection()` (also used by pipeline-mode reviewers) is unchanged.

### Integration

Symbols this feature only reads:

- `buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy` — `packages/nax-agent/src/sandbox/policy-builder.ts`
- `createSrtBackend(network): SandboxBackend`, `probeSandbox(backend): Promise<ProbeResult>`, `quoteArgvForShell` — `packages/nax-agent/src/sandbox/index.ts`
- `runTempRoots({ runTmpRoot, tmpdir }): string[]`, `resolveGitLayout(root)`, `listNaxEntries(root, stateDir)`, `listCredentialFiles` — `packages/nax-agent/src/sandbox/policy-inputs.ts`; `listGitGuardFiles` — `packages/nax-agent/src/sandbox/git-guards.ts`
- `realOrRaw(p)` — `packages/nax-agent/src/internal/realpath.ts` (every policy path passes through it, so `/tmp/...` reads `/private/tmp/...` on macOS)
- `SPAWN_CASES` — `packages/test-kit/src/cases/spawn-cases.ts` (the cases `node-runtime.test.ts` iterates)
- `DEFAULT_SANDBOX_CONFIG` — `packages/nax-agent/src/config/schemas-sandbox.ts`; `EMPTY_OWNED_PATHS_POLICY` — `packages/nax-agent/src/tools/owned-paths.ts`
- `runtimeSpawn` — `packages/nax-agent/src/runtime/index.ts`; `getGitRoot(workdir)` — `packages/nax-agent/src/internal/git-exec.ts`
- `makeTempDir`, `withTempDir`, `cleanupTempDir` — `packages/nax/test/helpers/index.ts` and `packages/nax-agent/test/helpers/index.ts`
- `GateName = "lint" | "typecheck" | "scoped" | "full-suite"` — `packages/nax/src/operations/workflow-types.ts`; `GateState = "green" | "red" | "skipped"`, `RepoGateSummary { ran; failing }` — `packages/nax/src/workflow/types.ts`
- `reviewerCommandsSection()` — `packages/nax/src/prompts/builders/reviewer-commands-section.ts` (unchanged)

Symbols this feature changes. The baseline only locates the code; implement the target.

- `ReReviewVerdict` — `packages/nax/src/operations/workflow-types.ts`
  - Baseline: `{ verdicts: readonly { id: string; addressed: boolean; note: string }[]; newFindings: readonly WorkflowFindingDraft[] }`
  - Target: each verdict entry gains `readonly residual?: ReReviewResidual`, where
    `ReReviewResidual = { readonly issue: string; readonly suggestion?: string; readonly file?: string; readonly line?: number }`
    is a new exported interface in the same file.
- `parseReReviewReply(output, openIds)` — `packages/nax/src/operations/workflow-replies.ts`
  - Target: a `verdict` of `"PARTIAL"` whose `residual` is an object with a non-empty string `issue` yields
    `addressed: false` plus `residual`; any other `verdict` value yields no `residual` key.
- `buildWorkflowReReviewPrompt` (`workflow-re-review-builder.ts`) and `buildWorkflowBranchReReviewPrompt` (`workflow-branch-builder.ts`)
  - Target: the reply contract reads
    `{"findings": [{"id": "F1", "verdict": "ADDRESSED|PARTIAL|NOT_ADDRESSED", "note": "one sentence", "residual": {"issue": "...", "suggestion": "...", "file": "path", "line": 0}}], "newFindings": [...]}`
    (`B1` in the branch prompt), with the instruction text in "Prompt and message text" below.
- `runStoryLoop` re-review absorption (`packages/nax/src/workflow/story-loop.ts`, the `stillOpen` block) and
  `branchReReviewStep` (`packages/nax/src/workflow/feature-machine.ts`) — Target: both call the new pure
  `absorbReReviewVerdict(asked, verdict)` exported from the new `packages/nax/src/workflow/re-review-absorb.ts`
  (no `@/operations` or `@/prompts` imports), which returns
  `{ open: readonly WorkflowFinding[]; newDrafts: readonly WorkflowFindingDraft[] }`:
  - `open` is `asked` in order, minus every finding whose verdict is `addressed: true`; a finding whose verdict has a
    `residual` is replaced by `{ ...finding, issue: residual.issue }`, with `suggestion`, `file` and `line` taken from the
    residual when present and kept from the finding otherwise, and with no `observed` key.
  - `newDrafts` is `verdict.newFindings` minus each draft whose `file` and `line` both equal a residual finding's
    effective `file` and `line` (the residual's value, else the original finding's). When either effective value is
    absent, nothing is dropped. A dropped draft reaches neither `reviewOpen`, the deferred minors, `newMinors` nor the
    ledger; the artifacts keep today's shape: `rereview-<R>.json` holds the parsed verdict, and `branch-rereview.json` holds it with
    `newFindings` replaced by the assigned blocking findings plus the non-blocking drafts, both taken from `newDrafts`.
  - `reReviewText` in `feature-machine.ts` gains the verdicts as a parameter so it can print `<id> PARTIAL`; for an
    item without a residual, both re-review summaries keep today's text byte for byte (pinned by
    `story-loop-log.test.ts` and `feature-machine-log.test.ts`).
  - `runStoryLoop` passes its `reviewOpen` as `asked`. `branchReReviewStep` passes `rec.reviewOpen` only (never the
    fix-now minors in its `items`), sets `reviewOpen` to `open` plus the newly assigned blocking drafts, and keeps its
    existing verdict-based `fix-now` → `leave` handling for minors.
- `parseReReviewReply` residual sanitising follows `toDraft`'s field rules: `issue` must be a non-empty string;
  `suggestion` and `file` are kept only as non-empty strings; `line` is kept only as a positive integer.
- `RoleTokens` — `packages/nax/src/workflow/types.ts`
  - Baseline: `{ inputTokens; outputTokens; costUsd; calls }`
  - Target: adds `readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number`. `MeterEvent.tokenUsage`
    in `tokens.ts` gains the same two optional fields; `WorkflowRoleUsage` in `packages/nax/src/log-format/types.ts`
    gains the same two optional fields.
- `waitForChecks(forge, prRef, opts)` — `packages/nax/src/workflow/ci-wait.ts` — Target: same signature and
  results, plus the progress log lines. A new exported constant `CI_WAIT_HEARTBEAT_MS = 60_000` sits in the same file.
- `StoryLoopSteps.storyReview` — `packages/nax/src/workflow/story-loop.ts`
  - Baseline: `storyReview(concerns: readonly string[])`
  - Target: `storyReview(concerns: readonly string[], gates?: Readonly<Partial<Record<GateName, GateState>>>)`;
    `runStoryReview(sc, concerns, gates = {})` in `story-review.ts` and the `buildStoryEnv` wiring in `stage-env.ts` follow.
    The parameter is optional so every existing two-argument caller and fake keeps compiling.
- `buildWorkflowStoryReviewPrompt(input)` — `packages/nax/src/prompts/builders/workflow-story-review-builder.ts`
  - Target: input gains `readonly gates?: Readonly<Partial<Record<"lint" | "typecheck" | "scoped" | "full-suite", "green" | "red" | "skipped">>>`
    (a local structural type, so the prompt builders keep importing nothing from `@/workflow`); absent means `{}`
    (every gate `not run`).
- `BranchReviewPromptInput` — `packages/nax/src/prompts/builders/workflow-branch-builder.ts`
  - Target: gains `readonly repoGates?: { readonly ran: readonly string[]; readonly failing: readonly string[] }` (structurally `RepoGateSummary`, declared locally for the same layering reason); `BranchReviewFacts` (`branch-review.ts`) picks it too,
    and `reviewFacts` in `feature-machine.ts` sets it from `rec.repoGates`.

New in nax-agent (US-001), in `packages/nax-agent/scripts/lib/confined-run.ts`:

```ts
export const CONFINED_TEST_ENV = "NAX_TEST_CONFINED";
export const SANDBOX_UNAVAILABLE_EXIT = 3;
export const USAGE_EXIT = 2;

export function confinedTestPolicy(input: {
  repoRoot: string; runTmpRoot: string; home: string; platform: NodeJS.Platform;
}): Promise<SandboxPolicy>;            // buildSandboxPolicy({ confined: true, tempRoots: runTempRoots(...), projectStateDir: ".nax", ... })

export function confinedTestCommand(input: {
  packageDir: string; tmpDir: string; paths: readonly string[]; timeoutMs: number;
}): string;                            // "export TMPDIR=… TMP=… TEMP=… NAX_TEST_CONFINED=1; cd <pkg> && bun test <paths> --timeout=<timeoutMs>"

export function probeConfinedSandbox(): Promise<ProbeResult>;
export function runConfinedTests(input: { packageDir: string; paths: readonly string[]; timeoutMs?: number }): Promise<number>;  // timeoutMs default 60_000
export const _confinedRunDeps: { backend; probe; gitRoot; spawn; mkdir; rm; tmpdir; homedir; platform; stdout; stderr };
// runConfinedTests: repoRoot = (await gitRoot(packageDir)) ?? packageDir; runTmpRoot = /tmp/nax/confined-<pid>-<random>;
// session temp dir = <runTmpRoot>/s; gitGuardFiles = listGitGuardFiles(...), credentialFiles = listCredentialFiles(...).
// spawn uses runtimeSpawn with stdin and stderr "inherit" and stdout "pipe" (AgentSpawnOptions.stdout is "pipe" only);
// the piped stdout is copied chunk by chunk to _confinedRunDeps.stdout (process.stdout by default).
```

`packages/nax-agent/scripts/run-confined-tests.ts` is the CLI over it:
`bun scripts/run-confined-tests.ts [--package=<dir>] [--timeout=<ms>] [--probe] <test paths...>`. Argument checks come first:
without `--probe` and with no test path the CLI exits 2 before any probe. `--probe` runs `probeConfinedSandbox()` only
(the srt backend built from `DEFAULT_SANDBOX_CONFIG.network`): exit 0 when available, otherwise exit 3 with
`sandbox unavailable: <reason>` on stderr.

Each `test:confined` script mirrors its package's normal test phases as separate runner invocations, so a
confined-only failure is never an artefact of mixing directories in one `bun test` process:

- nax-agent: `bun scripts/run-confined-tests.ts ./test/unit/ && bun scripts/run-confined-tests.ts ./test/integration/`
  (60 s per test, as its `test` script uses).
- nax: `bun ../nax-agent/scripts/run-confined-tests.ts --package=. --timeout=5000 ./test/unit/ && bun ../nax-agent/scripts/run-confined-tests.ts --package=. --timeout=5000 ./test/integration/`
  (5 s per test, as `scripts/run-tests-phases.ts` uses).

The wall-clock bound in CI is the job's `timeout-minutes`; each story raises its job's value if the added
confined step needs it.

The two confined fixtures are named `*.fixture.ts`, not `*.test.ts`, under `test/fixtures/confined/`: the runner
passes them as explicit `./` paths, which `bun test` runs whatever the suffix, while the package's normal
`bun test ./test/unit/ ./test/integration/` never collects them (`.nax/rules/forbidden-patterns-tests.md`).

### Prompt and message text

Re-review instruction, both prompts. It replaces "For each finding id, answer ADDRESSED or NOT_ADDRESSED.":

> For each finding id, answer ADDRESSED, PARTIAL or NOT_ADDRESSED. PARTIAL means the fix resolved part of the
> finding and a smaller problem remains: describe only what remains in "residual". Never list a residual again in
> "newFindings".

Story review block, inserted before the verdict instructions:

> ## What nax already checked
> nax ran these gates on this story before your review: lint <state>, typecheck <state>, scoped tests <state>.
> After your review nax runs the full test suite on this story, and once every story is done it runs the
> repository gates. Do not list any of these as something you could not verify.
> If you have a shell tool, run this story's own test files with one scoped test command before you give the spec verdict.

`<state>` is `green`, `red`, `skipped`, or `not run` when the gate has no state.

Story and branch `cannotVerify` sentence. It replaces "Put anything you could not check in "cannotVerify".":

> Put in "cannotVerify" only what neither nax's gates nor a scoped command can check, such as behaviour that needs a live external service.
> Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.

Branch review block:

> ## What nax already checked
> Repository gates before this review: <ran, comma-separated, or "not run">; failing: <failing, comma-separated, or "none">.
> nax runs them again after the branch fix. Do not list any of these as something you could not verify.

Publish log lines (stage `workflow`, data `storyId: "_run"` first):

- `CI wait: <prRef> (timeout <timeoutMs>ms, poll <pollMs>ms)`
- `CI checks: <passed>/<total> passed, <pending> pending` plus `, failing: <names>` when any check failed (GitHub;
  `passed` counts the `pass` and `skipping` buckets, the same set `classifyGh` treats as green);
  `CI pipeline: <status>` (GitLab)
- `CI wait: still waiting after <elapsed> (<last summary>)`
- `CI wait done: <green|failed|pending> after <elapsed>`
- `Publish: pushing <branch>` / `Publish: pushed <branch>` / `Publish: draft PR <url>` /
  `Publish: PR marked ready <url>` / `Publish: PR kept as draft <url>: <reasons joined with "; ">`

`<elapsed>` uses the existing `formatDuration`.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| No usable sandbox backend for the confined runner | `runConfinedTests` returns `SANDBOX_UNAVAILABLE_EXIT` (3) and writes `sandbox unavailable: <reason>` to stderr. It runs no tests and never falls back to an unsandboxed run |
| Removing the runner's temp root fails | Ignored; the exit code is the test run's |
| CLI called with no test path | Exit `USAGE_EXIT` (2), usage text on stderr |
| `runConfinedFiles` (nax test helper) | Resolves the runner's exit code unchanged; a failure to spawn `bun` rejects |
| `packageDir` is not inside a git work tree | The policy is built with `repoRoot` equal to `packageDir` |
| Confined-runner integration tests on a host with no sandbox, or inside a confined run | Skipped (no nested sandbox) |
| `PARTIAL` with no residual, or an empty residual `issue` | Treated as `NOT_ADDRESSED`; the finding stays open unchanged |
| A role record written before this change (no cache fields) | Read as zero cache tokens |
| No logger installed during the CI wait | Progress lines are skipped; `waitForChecks` returns as before |
| Story gates have no recorded state | Rendered as `not run` |
| Feature record has no `repoGates` | Branch block reads `Repository gates before this review: not run; failing: none.` |

## Out of Scope

- Making `ps` or other setuid programs runnable inside the macOS sandbox, and making a sandbox launch inside another sandbox work — tests that need either are skipped in a confined run instead.
- Changing the confined-session sandbox policy itself (the `/tmp` deny, the run temp roots, network rules) — this spec makes tests fit the policy, never the reverse.
- Running the confined runner over `test/ui/` or `test/e2e/` — only `test/unit/` and `test/integration/` are covered.
- A static lint for literal `/tmp/` strings in tests — most such strings are harmless path values that are never written; the confined CI run is the gate.
- Moving test fixtures into `.nax/scratchpad/` — the scratchpad is the agent's own notes space; tests use `$TMPDIR` through `makeTempDir()`.
- Changing `reviewerCommandsSection()` or any pipeline-mode (non-workflow) reviewer prompt.
- Feeding the confined runner's result into nax's own run gates or the workflow `full-suite` gate — it is a CI and developer gate only.
- An LLM or fuzzy-match dedupe of re-review new findings — only the exact file-and-line match against a `PARTIAL` residual is dropped.
- Splitting `inputTokens` into cached and uncached parts, or changing cost computation — the cache fields are additive telemetry.
- Cache token columns in the cost ledger, `run.complete` or metrics files other than the workflow role table and its summary line.
- Log lines for `workflow.publish` mode `none`, and progress lines for the ledger commit and ledger push.
- Configuring the CI-wait heartbeat interval — it is the constant `CI_WAIT_HEARTBEAT_MS`.
- Including the gate command lines in the review prompts — the story gate record holds states, not commands.

## Stories

### US-001 — Confined test runner and nax-agent test hygiene

Workdir: `packages/nax-agent`

Adds `scripts/lib/confined-run.ts` and the `scripts/run-confined-tests.ts` CLI, a `test:confined` script
(two invocations, unit then integration; see Design), the `isConfinedTestRun()` test helper,
and a "Test (confined sandbox)" step in the CI `nax-agent` job, after its bubblewrap install step. Fixes the
three nax-agent files that fail confined: `test/unit/internal/file-lock.test.ts` and
`test/unit/internal/path-file-lock.test.ts` (class A, `/tmp/nax-*-lock-test-*` dirs onto `makeTempDir()`), and
`test/unit/runtime/node-runtime.test.ts` (class C, the detached-process case skipped in a confined run).

Dependencies: none.

### US-002 — nax unit test hygiene

Workdir: `packages/nax`

Adds `test/helpers/confined.ts`, a sanctioned copy of nax-agent's `isConfinedTestRun()`, plus
`confinedSandboxAvailable()` and `runConfinedFiles(paths)`. These spawn
`bun ../nax-agent/scripts/run-confined-tests.ts --package=<packages/nax> ...` (with `--probe` for
availability). Also adds the `test:confined` script (two invocations at `--timeout=5000`, unit then integration; see Design)
and `test/integration/confined/unit-hygiene.test.ts`. Fixes the 21 unit files that fail confined:

- Class A: `execution/pid-registry`, `metrics/save-run-metrics`, `ui/tui-controls`, `utils/queue-file-lock`,
  `bakeoff/coordinator`, `bakeoff/preflight`, `bakeoff/report`.
- Class B (fake PRD/workdir paths that get written): `execution/pipeline-result-handler`,
  `execution/pipeline-result-handler-bug12`, `execution/pipeline-result-handler-worktree-cleanup`,
  `execution/unified-executor-cost`, `execution/unified-executor-dispatch`, `execution/unified-executor-failure`,
  `execution/unified-executor-fallback-seam`, `execution/unified-executor-results`,
  `execution/escalation/tier-escalation-retry-cap`, `execution/structured-failure`,
  `pipeline/stages/acceptance-setup-gate`.
- Class C: `agents/coding-tool-support-session-tmp`, `agents/coding-tool-support-command-shadow`,
  `agent-runtime/bun-runtime`.

Each is `test/unit/<name>.test.ts`.

Dependencies: US-001.

### US-003 — nax integration test hygiene and the CI gate

Workdir: `packages/nax`

Adds `test/integration/confined/integration-hygiene.test.ts` and a "Test (confined sandbox)" step
(`bun run test:confined`) in the CI `nax` job, after its bubblewrap install step. Fixes the 17 integration
files that fail confined:

- Class A/B: `execution/execution`, `execution/runner-parallel-metrics`,
  `execution/runner-parallel-metrics-rectification-events`, `execution/runner-fixes`,
  `execution/checkpoint/reader`, `execution/progress`, `plan/plan`, `plan/analyze-scanner`,
  `context/context-integration`, `config/security-loader`, `tdd/story-orchestrator-core`,
  `tdd/story-orchestrator-failureCategory`, `tdd/story-orchestrator-fallback`,
  `interaction/interaction-chain-pipeline`, `worktree/manager`.
- Class C: `permissions/bash-deny-suite` (launches a sandbox, so it nests) and
  `execution/lifecycle/run-tmp-wipe` (asserts the shared `/tmp/nax` parent).

Each is `test/integration/<name>.test.ts`.

Dependencies: US-002.

### US-004 — Re-review PARTIAL verdict carries the residual

Workdir: `packages/nax`

Adds `ReReviewResidual` and the `residual` verdict field, `PARTIAL` parsing in `parseReReviewReply`, the pure
`absorbReReviewVerdict` in the new `src/workflow/re-review-absorb.ts`, and its use in `runStoryLoop` and `branchReReviewStep`.
Both re-review reply contracts and instructions are updated, and both re-review log lines report `<id> PARTIAL`.

Dependencies: none.

### US-005 — Run telemetry: cache tokens and publish progress

Workdir: `packages/nax`

Carries `cacheReadTokens` / `cacheWriteTokens` through `startTokenMeter`, `addRoleTokens`, `buildWorkflowRunSummary`
and the workflow summary role line. Adds `CI_WAIT_HEARTBEAT_MS` and the CI-wait progress lines in
`waitForChecks`, and the publish sub-step lines in `prMode`, `pushMode` and `finishPr`.

Dependencies: none.

### US-006 — Workflow reviewers see nax's gate results

Workdir: `packages/nax`

Passes the story's gate states into `storyReview` → `runStoryReview` → `buildWorkflowStoryReviewPrompt`, and
`rec.repoGates` into the branch review facts → `buildWorkflowBranchReviewPrompt`. Adds the "What nax already
checked" blocks, the scoped-run expectation, the narrowed `cannotVerify` sentence and the evidence rule for
unavailability claims (nax#2531: a reviewer may not state an unchecked cause) to both workflow review prompts.

Dependencies: none. (Workflow mode runs stories one at a time in order, so US-006 already lands after US-001..US-003.)

### Context Files

**US-001**
- `packages/nax-agent/src/sandbox/policy-builder.ts` — `buildSandboxPolicy`, `SandboxPolicyInput`
- `packages/nax-agent/src/sandbox/policy-inputs.ts` — `runTempRoots`, `resolveGitLayout`, `listNaxEntries`
- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts` — `resolveSessionSandbox`, how a session builds its confined policy
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `createSrtBackend`, `wrap`, `commandFinished`, `reset`
- `packages/nax-agent/src/sandbox/probe.ts` — `probeSandbox`

**US-002**
- `packages/nax/test/helpers/temp.ts` — `makeTempDir`, `withTempDir`, `cleanupTempDir`
- `packages/nax/test/helpers/index.ts` — the helper barrel the new helpers join
- `packages/nax/src/prd/index.ts` — `savePRD`, the write class B fixtures reach
- `packages/nax/scripts/run-tests-phases.ts` — `SUITE_PHASES`, the per-phase layout and 5 s per-test timeout `test:confined` mirrors
- `packages/nax-agent/scripts/run-confined-tests.ts` — created by US-001, invoked here

**US-003**
- `.github/workflows/ci.yml` — the `nax` job and its bubblewrap install step
- `packages/nax/test/helpers/confined.ts` — created by US-002, used here
- `packages/nax/test/integration/confined/unit-hygiene.test.ts` — created by US-002, the pattern to mirror
- `packages/nax/test/helpers/temp.ts` — `makeTempDir`, `withTempDir`, `cleanupTempDir`

**US-004**
- `packages/nax/src/operations/workflow-replies.ts` — `parseReReviewReply`, `drafts`
- `packages/nax/src/operations/workflow-types.ts` — `ReReviewVerdict`, `WorkflowFindingDraft`
- `packages/nax/src/workflow/story-loop.ts` — the re-review block in `review`, `reReviewSummary`
- `packages/nax/src/workflow/feature-machine.ts` — `branchReReviewStep`, `reReviewText`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchReReviewPrompt`

**US-005**
- `packages/nax/src/workflow/tokens.ts` — `startTokenMeter`, `addRoleTokens`, `MeterEvent`
- `packages/nax/src/log-format/workflow-summary.ts` — `roleLine`, `formatWorkflowSummary`
- `packages/nax/src/workflow/ci-wait.ts` — `waitForChecks`, `classifyGh`, `classifyGlab`, `_ciWaitDeps`
- `packages/nax/src/workflow/finalize.ts` — `prMode`, `pushMode`, `finishPr`, `pushBranch`
- `packages/nax/test/unit/workflow/finalize.test.ts` — the `wire()` forge fakes

**US-006**
- `packages/nax/src/workflow/story-review.ts` — `runStoryReview`
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps.storyReview`, `review`, `s.gates`
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`, the `storyReview` wiring
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` — `buildWorkflowStoryReviewPrompt`
- `packages/nax/src/workflow/branch-review.ts` — `BranchReviewFacts`, `runBranchReview`

### Creates

**US-001**
- `packages/nax-agent/scripts/lib/confined-run.ts`
- `packages/nax-agent/scripts/run-confined-tests.ts`
- `packages/nax-agent/test/helpers/confined.ts`
- `packages/nax-agent/test/unit/scripts/confined-run.test.ts`
- `packages/nax-agent/test/integration/scripts/confined-run.test.ts`
- `packages/nax-agent/test/fixtures/confined/writes-literal-tmp.fixture.ts`
- `packages/nax-agent/test/fixtures/confined/writes-tmpdir.fixture.ts`

**US-002**
- `packages/nax/test/helpers/confined.ts`
- `packages/nax/test/unit/helpers/confined.test.ts`
- `packages/nax/test/integration/confined/unit-hygiene.test.ts`

**US-003**
- `packages/nax/test/integration/confined/integration-hygiene.test.ts`

**US-004**
- `packages/nax/src/workflow/re-review-absorb.ts`
- `packages/nax/test/unit/workflow/re-review-absorb.test.ts`

**US-005**
- None.

**US-006**
- None.

### Modifies

**US-001**
None. The test files this story fixes are its own work, named in its description; each keeps every assertion's meaning, so no existing assertion breaks. Its `package.json` and CI changes add a script and a step without altering existing ones.

**US-002**
None. The test files this story fixes are its own work, named in its description; each keeps every assertion's meaning, so no existing assertion breaks. Its `package.json` and CI changes add a script and a step without altering existing ones.

**US-003**
None. The test files this story fixes are its own work, named in its description; each keeps every assertion's meaning, so no existing assertion breaks. Its `package.json` and CI changes add a script and a step without altering existing ones.

**US-004**
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — asserts the branch re-review prompt contains the two-value verdict contract; the contract now lists three values, so the assertion becomes that the prompt contains the three-value contract `ADDRESSED|PARTIAL|NOT_ADDRESSED`.

**US-005**
None. The cache fields are emitted only when non-zero, so every existing closed-world role-entry assertion in the workflow token, run-summary and summary-format tests holds; the new log lines are additive.

**US-006**
None. The new `gates` parameter is optional on `storyReview`, `runStoryReview` and `buildWorkflowStoryReviewPrompt`, so the existing two-argument `runStoryReview(sc, [])` calls in `reviews.test.ts` / `reviews-hardening.test.ts` and the gate-less builder calls in `workflow-builders.test.ts` still compile and pass; no existing test pins the replaced cannotVerify sentence.

### Seams

- US-001 → US-002, US-003: `runConfinedTests` behind the `run-confined-tests.ts` CLI, invoked by nax's `runConfinedFiles` and `confinedSandboxAvailable`; a nax integration AC drives the CLI end to end.
- US-001 → US-002/US-003: the `NAX_TEST_CONFINED=1` environment variable set by `confinedTestCommand`, read by `isConfinedTestRun()` in both packages.
- US-004: `absorbReReviewVerdict` (`re-review-absorb.ts`) is consumed by `runStoryLoop` and `runFeatureMachine`; each consumer has an AC entering at that entry point.
- US-006: `storyReview`'s new `gates` argument, from `runStoryLoop` (entry point) to `buildWorkflowStoryReviewPrompt`; `BranchReviewFacts.repoGates`, from `runFeatureMachine` to `buildWorkflowBranchReviewPrompt`.

## Acceptance Criteria

### US-001

- [unit] `confinedTestPolicy({ repoRoot, runTmpRoot, home, platform: "linux" })` with `runTmpRoot` a fresh `mkdtemp` directory resolves to a policy whose `writeRoots` include `realOrRaw(runTmpRoot)`.
- [unit] `confinedTestPolicy` on platform `linux` resolves to a policy whose `writeRoots` include neither `/tmp` nor `/private/tmp`.
- [unit] `confinedTestPolicy` resolves to a policy whose `denyWrite` includes `realOrRaw(join(repoRoot, ".claude/settings.json"))`, the same deny a confined agent session gets.
- [unit] `confinedTestCommand({ packageDir: "/r/packages/x", tmpDir: "/tmp/nax/t/s", paths: ["./test/unit/"], timeoutMs: 5000 })` returns a string starting with `export TMPDIR='/tmp/nax/t/s' TMP='/tmp/nax/t/s' TEMP='/tmp/nax/t/s' NAX_TEST_CONFINED=1; `.
- [unit] `confinedTestCommand({ packageDir: "/r/packages/x", tmpDir: "/tmp/nax/t/s", paths: ["./test/unit/"], timeoutMs: 5000 })` returns a string ending with `cd '/r/packages/x' && bun test './test/unit/' --timeout=5000`.
- [cli] `bun scripts/run-confined-tests.ts --timeout=5000 <path>` passes `timeoutMs: 5000` to `runConfinedTests`, and without `--timeout` it passes 60000.
- [unit] `runConfinedTests` with `_confinedRunDeps.probe` resolving `{ available: false, reason: "no bwrap" }` returns `SANDBOX_UNAVAILABLE_EXIT` (3) and never calls `_confinedRunDeps.spawn`.
- [unit] `runConfinedTests` with an unavailable probe writes `sandbox unavailable: no bwrap` through `_confinedRunDeps.stderr`.
- [unit] `runConfinedTests` with `_confinedRunDeps.spawn` resolving exit code 1 returns 1.
- [unit] `runConfinedTests` copies every chunk of the spawn's piped stdout to `_confinedRunDeps.stdout`.
- [unit] `runConfinedTests` passes `_confinedRunDeps.spawn` exactly the argv the backend's `wrap` returned for the `confinedTestCommand` string.
- [unit] `runConfinedTests` calls `_confinedRunDeps.mkdir` for the session temp dir before it calls the backend's `wrap`.
- [unit] `runConfinedTests` calls `_confinedRunDeps.rm` on the run temp root after `spawn` resolves with a non-zero exit code.
- [unit] `runConfinedTests` returns the spawn's exit code when `_confinedRunDeps.rm` rejects.
- [unit] `runConfinedTests` calls the backend's `commandFinished` and then `reset` after `spawn` resolves.
- [unit] `runConfinedTests` with `_confinedRunDeps.gitRoot` resolving `null` builds the policy with `repoRoot` equal to `packageDir`.
- [unit] `isConfinedTestRun()` returns `true` when `process.env.NAX_TEST_CONFINED` is `"1"`.
- [cli] `bun scripts/run-confined-tests.ts` with no test path exits 2 and writes text starting with `usage: run-confined-tests` to stderr.
- [cli] `bun scripts/run-confined-tests.ts --probe` exits 0 when `probeConfinedSandbox()` on the same host reports available, and 3 when it reports unavailable.
- [integration] `runConfinedTests` over `test/fixtures/confined/writes-literal-tmp.fixture.ts` (a test that writes `/tmp/nax-confined-probe-<uuid>`) returns a non-zero exit code; skipped when `probeConfinedSandbox()` reports unavailable or `isConfinedTestRun()` is true.
- [integration] `runConfinedTests` over `test/fixtures/confined/writes-tmpdir.fixture.ts` (a test that writes under `makeTempDir()`) returns 0; same skip condition.
- [integration] `runConfinedTests` over `./test/unit/internal/file-lock.test.ts` and `./test/unit/internal/path-file-lock.test.ts` returns 0; same skip condition.
- [integration] `runConfinedTests` over `./test/unit/runtime/node-runtime.test.ts` returns 0; same skip condition.

Verification note: CI's `nax-agent` job runs `bun run test:confined` and fails on a non-zero exit.

### US-002

- [unit] nax's `isConfinedTestRun()` returns `true` when `process.env.NAX_TEST_CONFINED` is `"1"` and `false` when it is unset.
- [integration] `confinedSandboxAvailable()` resolves `true` exactly when `bun ../nax-agent/scripts/run-confined-tests.ts --probe` exits 0.
- [integration] `runConfinedFiles([])` resolves exit code 2, the runner's own usage exit, without needing a sandbox.
- [integration] `runConfinedFiles(["./test/unit/execution/pid-registry.test.ts"])` resolves exit code 0; skipped when `confinedSandboxAvailable()` is false or `isConfinedTestRun()` is true (every AC below shares this skip condition).
- [integration] `runConfinedFiles(["./test/unit/metrics/save-run-metrics.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/unit/ui/tui-controls.test.ts` and `./test/unit/utils/queue-file-lock.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/unit/bakeoff/coordinator.test.ts`, `./test/unit/bakeoff/preflight.test.ts` and `./test/unit/bakeoff/report.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles` over the three `./test/unit/execution/pipeline-result-handler*.test.ts` files listed in US-002 resolves exit code 0.
- [integration] `runConfinedFiles` over the five `./test/unit/execution/unified-executor-*.test.ts` files listed in US-002 resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/unit/execution/escalation/tier-escalation-retry-cap.test.ts` and `./test/unit/execution/structured-failure.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/unit/pipeline/stages/acceptance-setup-gate.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/unit/agents/coding-tool-support-session-tmp.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/unit/agents/coding-tool-support-command-shadow.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/unit/agent-runtime/bun-runtime.test.ts"])` resolves exit code 0.

### US-003

Every AC below is skipped when `confinedSandboxAvailable()` is false or `isConfinedTestRun()` is true.

- [integration] `runConfinedFiles(["./test/integration/execution/execution.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/integration/execution/runner-parallel-metrics.test.ts` and `./test/integration/execution/runner-parallel-metrics-rectification-events.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/execution/runner-fixes.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/execution/checkpoint/reader.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/execution/progress.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/integration/plan/plan.test.ts` and `./test/integration/plan/analyze-scanner.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/context/context-integration.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/config/security-loader.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles` over the three `./test/integration/tdd/story-orchestrator-*.test.ts` files listed in US-003 resolves exit code 0.
- [integration] `runConfinedFiles` over `./test/integration/interaction/interaction-chain-pipeline.test.ts` and `./test/integration/worktree/manager.test.ts` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/permissions/bash-deny-suite.test.ts"])` resolves exit code 0.
- [integration] `runConfinedFiles(["./test/integration/execution/lifecycle/run-tmp-wipe.test.ts"])` resolves exit code 0.

Verification note: CI's `nax` job runs `bun run test:confined` and fails on a non-zero exit.

### US-004

- [unit] `parseReReviewReply` on a reply whose finding `F1` has `verdict: "PARTIAL"` and `residual: { issue: "symlinks still bypass" }` returns a verdict for `F1` whose `residual.issue` is `"symlinks still bypass"`.
- [unit] `parseReReviewReply` on a `PARTIAL` verdict with no `residual` returns a verdict with no `residual` key, which `absorbReReviewVerdict` then keeps open unchanged.
- [unit] `parseReReviewReply` on a `PARTIAL` verdict whose `residual.issue` is `""` returns a verdict with no `residual` key.
- [unit] `parseReReviewReply` on a `NOT_ADDRESSED` verdict that carries a `residual` returns a verdict with no `residual` key.
- [unit] `absorbReReviewVerdict` with finding `B1` and a `PARTIAL` verdict whose residual issue is `"symlinks still bypass"` returns `open` holding one finding with `id` `B1` and `issue` `"symlinks still bypass"`.
- [unit] `absorbReReviewVerdict` with a residual that has a `suggestion` returns the open finding with that `suggestion`.
- [unit] `absorbReReviewVerdict` with a residual that omits `file` and `line` returns the open finding with the original finding's `file` and `line`.
- [unit] `absorbReReviewVerdict` with a residual returns the open finding without an `observed` key.
- [unit] `absorbReReviewVerdict` returns a `NOT_ADDRESSED` finding in `open` unchanged.
- [unit] `absorbReReviewVerdict` omits an `ADDRESSED` finding from `open`.
- [unit] `absorbReReviewVerdict` with a residual at `file: "a.ts", line: 53` and a new finding at `file: "a.ts", line: 53` returns `newDrafts` without that new finding.
- [unit] `absorbReReviewVerdict` with a residual at `file: "a.ts", line: 53` and a new finding at `file: "a.ts", line: 60` returns `newDrafts` containing that new finding.
- [unit] `absorbReReviewVerdict` with a residual that omits `file` and `line`, on a finding at `file: "b.ts", line: 9`, drops a new finding at `file: "b.ts", line: 9` from `newDrafts`.
- [unit] `absorbReReviewVerdict` with a residual and a finding that both lack `file` keeps every new finding in `newDrafts`.
- [unit] `parseReReviewReply` on a `PARTIAL` residual with `line: 0` returns a residual without a `line` key.
- [unit] `runStoryLoop` whose `reReview` step returns `PARTIAL` with residual issue `"still open"` for `F1` passes its next `fix` implement turn a `findings` list whose `F1` entry has `issue` `"still open"`.
- [unit] `runFeatureMachine` whose `branchReReview` step returns `PARTIAL` for `B1` plus a new critical finding at the residual's file and line ends with `reviewOpen` holding exactly one finding, `B1`, whose `issue` is the residual issue.
- [unit] `runFeatureMachine` with that `PARTIAL` verdict passes `adjudicate` exactly one item.
- [unit] The branch re-review step's done text contains `B1 PARTIAL` when the verdict for `B1` is `PARTIAL` with a residual.
- [unit] `runStoryLoop`'s story re-review step done text contains `F1 PARTIAL` when the verdict for `F1` is `PARTIAL` with a residual.
- [unit] `buildWorkflowReReviewPrompt` returns text containing `Never list a residual again in "newFindings".`
- [unit] `buildWorkflowBranchReReviewPrompt` returns text containing `ADDRESSED|PARTIAL|NOT_ADDRESSED`.

### US-005

- [unit] `startTokenMeter` given an `advisor` event with `tokenUsage: { inputTokens: 4, outputTokens: 10, cacheReadTokens: 54627, cacheWriteTokens: 57056 }` reports `byRole().advisor.cacheReadTokens` equal to 54627.
- [unit] The same meter reports `byRole().advisor.cacheWriteTokens` equal to 57056.
- [unit] `startTokenMeter` given an event without cache fields reports a role entry with no `cacheReadTokens` key and no `cacheWriteTokens` key.
- [unit] `addRoleTokens({ a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 } }, { a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, cacheReadTokens: 7 } })` returns `a.cacheReadTokens` equal to 7.
- [unit] `buildWorkflowRunSummary` over a result whose `featureWorkflow.tokensByRole.advisor` has `cacheReadTokens: 100` returns an `advisor` role entry with `cacheReadTokens` 100.
- [unit] `formatWorkflowSummary` with a role entry of `cacheReadTokens: 54627, cacheWriteTokens: 57056` renders a role line containing `cache r 54,627 w 57,056`.
- [unit] `formatWorkflowSummary` with a role entry that has no cache fields renders a role line not containing `cache`.
- [unit] `waitForChecks("github", "feat/x", { timeoutMs: 1200000, pollMs: 30000, cwd })` logs `CI wait: feat/x (timeout 1200000ms, poll 30000ms)` before its first poll.
- [unit] `waitForChecks` whose first GitHub poll returns 3 passing and 12 pending checks logs an info line `CI checks: 3/15 passed, 12 pending`.
- [unit] `waitForChecks` whose second poll returns the same summary as the first logs no second `CI checks:` line.
- [unit] `waitForChecks` whose poll returns a failed check named `lint` logs a `CI checks:` line ending with `failing: lint`.
- [unit] `waitForChecks` whose GitLab poll returns pipeline status `running` logs an info line `CI pipeline: running`.
- [unit] `waitForChecks` with `_ciWaitDeps.now` advancing 30s per unchanged poll logs a line starting with `CI wait: still waiting after` once 60s have passed since its last info line.
- [unit] `waitForChecks` with polls unchanged for under 60s logs no `still waiting` line.
- [unit] `waitForChecks` that returns `green` logs a final info line starting with `CI wait done: green after`.
- [unit] `waitForChecks` that times out logs a final info line starting with `CI wait done: pending after`.
- [unit] `waitForChecks` with no logger installed still returns `{ outcome: "green" }` when the checks pass.
- [unit] `publish` in `pr` mode with a successful push logs `Publish: pushed <branch>`.
- [unit] `publish` in `pr` mode logs `Publish: draft PR <url>` with the URL `openDraftFinishPr` returned.
- [unit] `publish` in `pr` mode whose approval is granted logs `Publish: PR marked ready <url>`.
- [unit] `publish` in `pr` mode with a readiness reason logs `Publish: PR kept as draft <url>: <reason>`.
- [unit] `publish` in `pr` mode whose push fails logs no `Publish: pushed` line.
- [unit] Every `CI wait`, `CI checks`, `CI pipeline` and `Publish:` line logged during a `publish` call in `pr` mode carries a data object whose first key is `storyId` with value `"_run"`.

### US-006

- [unit] `buildWorkflowStoryReviewPrompt` with `gates: { lint: "green", typecheck: "green", scoped: "green" }` returns text containing `lint green, typecheck green, scoped tests green`.
- [unit] `buildWorkflowStoryReviewPrompt` without `gates` returns text containing `lint not run, typecheck not run, scoped tests not run`.
- [unit] `runStoryReview(sc, [])` (no `gates`) passes `_workflowDeps.callOp` a prompt containing `lint not run`.
- [unit] `buildWorkflowStoryReviewPrompt` with `gates: { scoped: "skipped" }` returns text containing `scoped tests skipped`.
- [unit] `buildWorkflowStoryReviewPrompt` with `gates: { lint: "red" }` returns text containing `lint red`.
- [unit] `buildWorkflowStoryReviewPrompt` returns text containing `After your review nax runs the full test suite on this story`.
- [unit] `buildWorkflowStoryReviewPrompt` returns text containing `run this story's own test files with one scoped test command`.
- [unit] `buildWorkflowStoryReviewPrompt` returns text that does not include `Put anything you could not check in`.
- [unit] `buildWorkflowStoryReviewPrompt` returns text containing `only what neither nax's gates nor a scoped command can check`.
- [unit] `runStoryLoop` whose `gates` step returns states `{ lint: "green", typecheck: "green", scoped: "green" }` calls `storyReview` with those states as its second argument.
- [unit] `runStoryReview(sc, [], { lint: "red" })` passes `_workflowDeps.callOp` a prompt containing `lint red`.
- [unit] `buildWorkflowBranchReviewPrompt` with `repoGates: { ran: ["build", "test"], failing: [] }` returns text containing `Repository gates before this review: build, test; failing: none.`
- [unit] `buildWorkflowBranchReviewPrompt` with `repoGates: { ran: ["build", "test"], failing: ["test"] }` returns text containing `failing: test.`
- [unit] `buildWorkflowBranchReviewPrompt` without `repoGates` returns text containing `Repository gates before this review: not run; failing: none.`
- [unit] `buildWorkflowBranchReviewPrompt` returns text containing `only what neither nax's gates nor a scoped command can check`.
- [unit] `buildWorkflowStoryReviewPrompt` returns text containing `Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.`
- [unit] `buildWorkflowBranchReviewPrompt` returns text containing `Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.`
- [unit] `runFeatureMachine` whose record has `repoGates: { ran: ["lint"], failing: [] }` calls `branchReview` with facts whose `repoGates` equals that summary.
- [unit] `reviewerCommandsSection().content` still contains `you may run commands`.
