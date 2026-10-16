# SPEC: Workflow Record and Promote

Closes: #2569

## Summary

Phase 3 of #2569; phases 1 (`nax workflow status`, #2574) and 2 (`nax gates run`, #2575) are merged. Two new subcommands of the `nax workflow` group finish the job of taking a workflow PR from draft to ready without a finishing tool re-implementing nax's data model. `nax workflow record -f <feature> [--decisions <file>] [--outcome <outcome>] [--json]` validates a human's rulings against the open-item ids `nax workflow status` emits and writes (or updates) the decisions sidecar `decisions-<timestamp>.json` in the newest run directory; it refuses `--outcome promoted` or `--outcome verified-ready` unless the forge reports the PR as ready. `nax workflow promote -f <feature> [--yes] [--json]` is a dry run by default: it checks that every open item has a recorded ruling and that the PR's checks are green on the pushed head and not conflicting; with `--yes` and every check passing it ticks the resolved lines of the PR body's "Before marking ready" checklist, posts one evidence comment built from the sidecar, marks the PR ready and records `promoted`. Both commands are workflow-mode only and read the run's `result.json` through the same loader `status` uses.

## Motivation

The nax-finish skill's workflow-draft path still does these steps by hand, and the issue lists how each one broke:

- **The decisions sidecar is hand-written.** One session wrote `outcome: "promoted"` minutes before the PR was ready, with zero-padded timestamps. The skill's shape rules (`disposition` values, `sha` required for `fixed`, one-line `reason`, a UTC timestamp with `:` and `.` replaced by `-`) are prose the agent reconstructs each time, and nothing validates an entry's `id` against what the run actually left open.
- **Promotion mechanics are prose.** Ticking the checklist (match each line by the exact `**<id>**` token nax rendered, append the disposition to that line only), posting one evidence comment, requiring checks green on the pushed head, and never promoting a conflicting PR are rules an agent re-derives on every run, with the forge CLIs' argv written out by hand.

Phase 1 made `verdict.openItems` the complete list (`src/workflow/open-items.ts`), so the ids a ruling must name now exist in one place. The pieces a promotion needs also exist: `waitForChecks` (`src/workflow/ci-wait.ts`) already binds a green poll to an expected head sha and reports `conflicting`, `no-checks` and `unavailable`; the forge layer (`src/forge`) already detects GitHub or GitLab and builds the `view` argv; `git rev-parse HEAD` through the forge runner reads HEAD. What is missing is the sidecar writer, the checklist tick, and the two commands that join them.

## Design

### Integration

Symbols this feature **only reads** (verified on `main` `e75a13014`):

- `OpenItem` (`packages/nax/src/workflow/types.ts:101`): `{ id; kind: "finding" | "ruling" | "cannot-verify" | "gate" | "advisor" | "story" | "ci" | "reason"; severity?; file?; line?; issue; suggestion?; ruling? }`.
- `buildOpenItems(rec)` and `buildVerdict(rec)` (`src/workflow/open-items.ts`): `buildVerdict` returns `{ workflowPassed, outcome, reasons, openItems }`, or `undefined` while the record has no `outcome`.
- `readResult(runDir)`, `runDirsNewestFirst(featureDir)`, `storyStatesFrom(stories)` (`src/workflow/result.ts`): the run loader `workflow status` uses. `_resultDeps = { mkdir, readdir, rename, stat }` (`result.ts:17`) is the injectable file-system seam.
- `workflowFeatureDir(projectDir, feature)` (`src/workflow/paths.ts`).
- `WorkflowFeatureRecord` (`types.ts`): `outcome?: FeatureOutcome` (`"ready" | "draft" | "local-only" | "pushed"`), `url?: string`, `head?: string`, `reasons: readonly string[]`.
- `waitForChecks(forge, prRef, opts: { cwd; timeoutMs; pollMs; signal?; expectedSha? }): Promise<CiWaitResult>` (`src/workflow/ci-wait.ts:337`), `CiWaitResult = { outcome: "green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable"; detail: string }`. With `timeoutMs: 0` and `pollMs: 0` it returns after one poll in practice (a forge call outlasts the clock tick): a would-be green poll whose reported sha differs from `expectedSha` ends as `unavailable` with the mismatch as `detail`.
- `detectForge(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null>`, `viewArgv(forge, branch, githubFields)`, `defaultForgeDeps`, `ForgeDeps { run(cmd, { cwd, timeoutMs? }): Promise<{ exitCode; stdout; stderr }>; readText }` (`src/forge`, barrel `@/forge`).
- `safeInline(text, max?)` (`src/workflow/pr-body-safe.ts:37`): redacted, `@`/`#<digit>`-neutralised, one-line text.
- The line format `openItemLine` in `src/workflow/pr-body.ts` (not exported) renders each unresolved checklist entry as `- [ ] **<id>** (<tags>) ...`, optionally followed by indented `  Suggestion:` / `  Advisor:` lines; a gate item renders as `- [ ] **<id>** (gate) — ...`.
- `validateFeatureName(feature)` (`src/utils/feature-name.ts`).
- `registerWorkflowCommand(program, deps)`, `WorkflowCliDeps { log; logErr; exit }`, `_workflowCliDeps` and the file-local `newestResult`, `fillStoryStates`, `reportFor`, `notStarted`, `noResult` (`src/cli/workflow.ts`).

Symbols this feature **changes** or **creates**. A baseline only locates the code; the target is the interface to implement.

- Run loading (`src/cli/workflow.ts`)
  - Baseline: `newestResult`, `fillStoryStates`, `notStarted` and `noResult` are file-local; `reportFor` builds `openItems` as `verdict?.openItems ?? buildOpenItems(filled)`.
  - Target: that loading moves, unchanged in behaviour and error messages, to `src/workflow/run-verdict.ts` as `export async function loadRunVerdict(dir: string, feature: string): Promise<LoadedRun>`, with `export interface LoadedRun { readonly runId: string; readonly runDir: string; readonly result: WorkflowResultFile; readonly record: WorkflowFeatureRecord; readonly openItems: readonly OpenItem[]; readonly reasons: readonly string[] }`. `record` is the record as stored, and `openItems` is built from the record with `storyStates` filled, as `status` does today. `reasons` is `record.reasons`. `loadRunVerdict` validates the feature name, takes the newest readable run, and throws the same `no workflow result for feature <feature>` and `workflow for <feature> has not started its feature steps (run <runId>)` errors as today. `workflowStatusCommand` builds its report from `loadRunVerdict`; its output and exit codes do not change.
- `registerWorkflowCommand` (`src/cli/workflow.ts`)
  - Baseline: `registerWorkflowCommand(program: Command, deps: WorkflowCliDeps = _workflowCliDeps): Command`, registering `status`.
  - Target: `registerWorkflowCommand(program: Command, deps: WorkflowCliDeps = _workflowCliDeps, forgeDeps: WorkflowForgeDeps = _workflowForgeDeps): Command`, registering `status`, `record` and `promote` in that order. A caller passing only `deps` (the existing tests) keeps working.
- `WorkflowForgeDeps` and `_workflowForgeDeps`, new in `src/cli/workflow-forge.ts`: `export interface WorkflowForgeDeps { forge: ForgeDeps; now: () => Date; waitForChecks: typeof waitForChecks }`. The real object uses `defaultForgeDeps`, `() => new Date()` and `waitForChecks`. HEAD is read through `forge.run(["git", "rev-parse", "HEAD"], { cwd: dir })`, not through `readHead`: `src/workflow/git.ts` imports `step-context`, which imports `@/cli`, so a value import of it from `src/cli` closes a runtime import cycle. `src/cli/workflow-forge.ts` and the modules below import `ci-wait`, `@/forge` and `pr-body-safe` only, none of which reach `@/cli` (after the `pr-body-safe` change under US-003).

New modules, all under `packages/nax/src`:

```typescript
// workflow/decisions-sidecar.ts  (US-001)
export const DISPOSITIONS = ["fixed", "waived", "confirmed", "overridden", "verified"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const SIDECAR_OUTCOMES = ["pending", "promoted", "verified-ready", "abandoned"] as const;
export type SidecarOutcome = (typeof SIDECAR_OUTCOMES)[number];
export const SIDECAR_KINDS = ["finding", "advisor", "gate", "ci", "story", "cannot-verify", "minor", "reason"] as const;
export type SidecarKind = (typeof SIDECAR_KINDS)[number];

export interface DecisionEntry {
  readonly id: string;
  readonly kind: SidecarKind;
  readonly disposition: Disposition;
  /** One non-empty line. */
  readonly reason: string;
  /** 7 to 40 hex characters; required when disposition is "fixed". */
  readonly sha?: string;
}

export interface DecisionsSidecar {
  /** "<runId>/result.json" */
  readonly artifact: string;
  readonly feature: string;
  /** UTC ISO-8601 with ":" and "." replaced by "-", e.g. "2026-10-13T09-12-00-417Z". */
  readonly resumedAt: string;
  readonly reasons: readonly string[];
  readonly decisions: readonly DecisionEntry[];
  readonly outcome: SidecarOutcome;
  readonly url?: string;
}

export function parseDecisionEntries(raw: unknown): DecisionEntry[]; // throws NaxError WORKFLOW_DECISIONS_INVALID
export function sidecarKindFor(item: OpenItem): SidecarKind; // "ruling" -> "advisor"; every other kind maps to itself
export function checkEntriesAgainstItems(entries: readonly DecisionEntry[], items: readonly OpenItem[]): void; // throws NaxError WORKFLOW_DECISIONS_INVALID
export function mergeDecisions(existing: readonly DecisionEntry[], incoming: readonly DecisionEntry[]): DecisionEntry[];
export function isoStamp(date: Date): string; // the resumedAt / file-name timestamp form
export function sidecarFileName(date: Date): string; // "decisions-<isoStamp>.json"
export async function newestSidecar(runDir: string): Promise<{ path: string; sidecar: DecisionsSidecar } | null>;
export async function writeSidecar(path: string, sidecar: DecisionsSidecar): Promise<void>; // temp file then rename

// workflow/pr-state.ts  (US-002)
export interface PrState { readonly isDraft: boolean; readonly body: string; readonly url?: string }
export async function readPrState(forge: ForgeKind, prRef: string, deps: ForgeDeps, cwd: string): Promise<PrState>; // throws NaxError WORKFLOW_PR_READ_FAILED

// workflow/promote.ts  (US-003)
export function tickChecklist(body: string, entries: readonly DecisionEntry[]): { body: string; ticked: string[] };
export function evidenceComment(entries: readonly DecisionEntry[]): string;
export function editBodyArgv(forge: ForgeKind, prRef: string, body: string): string[];
export function commentArgv(forge: ForgeKind, prRef: string, text: string): string[];
export function markReadyArgv(forge: ForgeKind, prRef: string): string[];
```

`src/cli/workflow-record.ts` exports `WorkflowRecordOptions { dir; feature; decisions?: string; outcome?: string; json }`, `WorkflowRecordReport { feature; runId; sidecar: string; outcome: SidecarOutcome; decisions: number; unruled: readonly string[] }` and `workflowRecordCommand(opts, deps: WorkflowCliDeps, forgeDeps: WorkflowForgeDeps): Promise<number>`. `src/cli/workflow-promote.ts` exports `WorkflowPromoteOptions { dir; feature; yes: boolean; json }`, `PromoteCheck { name: "items-ruled" | "ci-green"; passed: boolean; detail: string }`, `PromoteAction { name: "tick" | "comment" | "ready" | "record"; status: "done" | "skipped" }`, `WorkflowPromoteReport { feature; runId; url; dryRun: boolean; promoted: boolean; checks: readonly PromoteCheck[]; actions: readonly PromoteAction[] }` and `workflowPromoteCommand(opts, deps, forgeDeps): Promise<number>`. Both modules import the workflow leaves by relative path and `src/cli/workflow.ts` only by `import type`, for the reason `src/cli/workflow.ts` gives (the `@/workflow` barrel loads `step-context`, which imports `@/cli`); `bun run check:import-cycles` must stay clean.

### The decisions sidecar

One sidecar belongs to a run: `.nax/features/<feature>/workflow/<runId>/decisions-<timestamp>.json`, written next to `result.json`. Its shape is `DecisionsSidecar` above; the `reasons` field copies the run's `reasons` and `artifact` is `<runId>/result.json`. An entry's `kind` uses the sidecar vocabulary: an open item of kind `ruling` is an `advisor` entry and every other item kind maps to itself. `fixed` requires `sha`; `waived`, `confirmed`, `overridden` and `verified` take none. Every entry is validated before anything is written. Writes go to a temporary file in the same directory and are renamed over the target, so a reader never sees a partial file. The directory is git-ignored (`**/.nax/features/*/workflow/`); the commands leave the file uncommitted.

An entry's `id` must name an open item of the run (`LoadedRun.openItems`), with one exception: an entry of kind `ci` or `minor` may carry an id that is not an open item, because the finishing tool tracks live CI checks and fix-now minors that `verdict.openItems` does not list. Any other unknown id is an error naming the open ids.

### CLI Behavior

```
nax workflow record  -f <feature> [--decisions <file>] [--outcome <outcome>] [-d, --dir <path>] [--json]
nax workflow promote -f <feature> [--yes] [-d, --dir <path>] [--json]
```

`--dir` defaults to `process.cwd()` and is the project directory, as for `status`. `--json` prints exactly one JSON object on stdout; on an error it prints `{"error":"<message>"}` on stdout, and without `--json` the message goes to stderr through `deps.logErr` (the `status` convention).

**record.** Validation order, each step running only when the earlier ones passed: (1) the feature name; (2) at least one of `--decisions` and `--outcome` given, else `nothing to record: pass --decisions or --outcome`; (3) `--outcome`, when given, is one of `pending`, `promoted`, `verified-ready`, `abandoned`, else `outcome must be one of pending, promoted, verified-ready, abandoned`; (4) `loadRunVerdict`; (5) the decisions file, when given, is read and parsed (`cannot read decisions file: <path>`, `decisions file is not valid JSON: <path>`), its array validated by `parseDecisionEntries` and checked by `checkEntriesAgainstItems`; (6) for `--outcome promoted` or `--outcome verified-ready`, the record has a `url` (`cannot record outcome <outcome>: the workflow result has no PR url`), a forge is detected (`no forge detected for <dir>`) and `readPrState` reports the PR as not a draft (`cannot record outcome <outcome>: PR is still a draft`); (7) the write. The decisions file is a JSON array of entries, not an object. Step 7 loads the newest sidecar of the run: with none, it creates one (`outcome` is `--outcome` or `pending`, `resumedAt` is `isoStamp(forgeDeps.now())`, `url` is the record's `url` when it has one); with one, it merges the incoming entries by id (`mergeDecisions`), applies `--outcome` when given and keeps everything else, and rewrites the same file. `--outcome` with no `--decisions` and no existing sidecar fails with `no decisions sidecar for run <runId>; pass --decisions`. An outcome of `promoted` or `verified-ready` also stores the record's `url`. Exit `0` on success, `1` on any error. After a successful write, `unruled` lists the open item ids that have no entry in the sidecar; it does not change the exit code.

Plain output: `<feature>: recorded <n> decision(s) in <sidecar path relative to dir>; outcome <outcome>`, then `unruled: <ids joined by ", ">` when any. `--json` prints `WorkflowRecordReport`.

**promote.** Validation order: (1) the feature name; (2) `loadRunVerdict`; (3) the record's `outcome` is `draft`, else `workflow for <feature> ended <outcome or "not published">; only a draft can be promoted`; (4) the record has a `url`, else `the workflow result has no PR url`; (5) a forge is detected (`no forge detected for <dir>`); (6) `readPrState` reports the PR as a draft, else `PR is already ready: <url>`. Each failure exits `1` and writes nothing. Then both checks run, never short-circuiting each other:

- `items-ruled`: passes when every open item id has an entry in the newest sidecar of the run (vacuously when there are no open items). Otherwise `detail` is `no ruling recorded for <ids joined by ", ">`, and when the run has no sidecar at all, `no decisions recorded; run nax workflow record`.
- `ci-green`: `forgeDeps.waitForChecks(forge, url, { cwd: dir, timeoutMs: 0, pollMs: 0, expectedSha })`, where `expectedSha` is the trimmed stdout of `forgeDeps.forge.run(["git", "rev-parse", "HEAD"], { cwd: dir })`; a non-zero exit fails the command with `cannot read HEAD: <stderr or exit code>`. It passes only for outcome `green`; `no-checks`, `pending`, `unavailable`, `failed` and `conflicting` all fail, with `detail` `ci <outcome>: <the result's detail>`.

Without `--yes`, or with any check failed, no forge write happens. Exit `0` when both checks pass (the dry run reports `dryRun: true, promoted: false` and the line `ready to promote; rerun with --yes`), `2` when any check failed. With `--yes` and both checks passed, the actions run in this order, stopping at the first failure: `tick` (read the PR body again with `readPrState` immediately before writing, run `tickChecklist` over the newest sidecar's entries, and write it with `editBodyArgv` only when at least one line ticked; otherwise `skipped`), `comment` (one `evidenceComment` posted with `commentArgv`; `skipped` when the sidecar has no entries), `ready` (`markReadyArgv`), `record` (upsert the newest sidecar to `outcome: "promoted"` with the PR `url`, creating an empty-decisions sidecar when the run has none). A non-zero exit from a forge command fails the action with `promote stopped at <action>: <stderr or exit code>`, exits `1`, and leaves the sidecar's outcome as it was. A successful `--yes` run exits `0` with `promoted: true`.

Plain output of promote: one line per check (`pass  items-ruled` / `FAIL  ci-green  <detail>`), then one line per action when `--yes` ran, then the dry-run or result line. `--json` prints `WorkflowPromoteReport`.

`record` checks only what its outcome names: for `promoted` and `verified-ready`, that the PR is not a draft. It does not re-run the `promote` checks; a human recording an outcome is trusted, and the checks gate the write to the forge, not the record. `promote` ignores the sidecar's current `outcome` (including `abandoned`) and overwrites it with `promoted` on success. The open items `promote` and `record` compare against come from `LoadedRun.openItems` (the run's recorded verdict), so a `ci` item written at publish time still needs a ruling even when the checks are green now.

**Checklist tick.** `tickChecklist` changes only the first line of an entry that matches `- [ ] **<id>**` exactly (the id compared as a plain string, so `B1` never matches `**B10**` and ids such as `_run:ci` need no escaping), turning `[ ]` into `[x]` and appending to the end of that line one of: ` — fixed in <sha>`, ` — verified`, ` — confirmed`, ` — waived: <reason>`, ` — overridden: <reason>`. Indented continuation lines, already-ticked lines and every other line are returned unchanged, and an entry whose id has no checklist line is ignored.

**Evidence comment.** `evidenceComment` returns `## Resolved before ready`, a blank line, then one line per entry: `- <id> (<kind>) <disposition>: <reason>`, with ` (<sha>)` appended for a `fixed` entry. The id, the kind and the reason each pass through `safeInline`, and the tick suffixes ` — waived: <reason>` and ` — overridden: <reason>` pass the reason through it too. GitHub uses `gh pr edit <ref> --body <body>`, `gh pr comment <ref> --body <text>` and `gh pr ready <ref>`; GitLab uses `glab mr update <ref> --description <body>`, `glab mr note create <ref> -m <text>` and `glab mr update <ref> --ready`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Invalid feature name, no workflow run, run not started | exit 1 with `status`'s messages; nothing read or written beyond that. |
| `record`: nothing to record, bad outcome, unreadable or invalid decisions file, invalid entry, unknown id, kind mismatch | exit 1 with the message; the sidecar is not created or changed. |
| `record --outcome promoted` / `verified-ready` while the PR is a draft, has no url, or no forge is detected | exit 1; the sidecar is not created or changed. |
| `readPrState` cannot read the PR (non-zero exit, unparseable output) | exit 1 with `cannot read PR <ref>: <detail>` (code `WORKFLOW_PR_READ_FAILED`). |
| `promote`: outcome is not `draft`, no url, already ready, no forge | exit 1; nothing written. |
| `promote`: an open item has no ruling, or CI is not green on the pushed head | exit 2; nothing written, even with `--yes`. |
| `promote --yes`: a forge write fails | exit 1 at that action; earlier actions stay done; the sidecar is not marked `promoted`. A re-run before `ready` succeeded ticks idempotently and posts a second evidence comment; once `ready` has succeeded, a re-run exits 1 with `PR is already ready` and the recovery is `nax workflow record --outcome promoted`. |
| `promote`: HEAD cannot be read | exit 1 with `cannot read HEAD: <detail>`; nothing written. |

## Out of Scope

- Promoting a PR that is already ready (the ready-audit case) is out of scope: `nax workflow promote` exits `1` with `PR is already ready: <url>` and writes nothing. The `## Verified after ready` evidence comment stays a manual step; `nax workflow record --outcome verified-ready` still records the audit.
- `nax workflow promote` never waits for CI: it reads the checks once. There is no `--wait` or `--timeout` flag; a pending run exits `2` and the caller runs the command again.
- `nax workflow promote` does not push, commit, rebase, or inspect the working tree. "Checks green on the pushed head" means the checks the forge reports are for the sha `git rev-parse HEAD` returns in `--dir`; GitHub reports that sha through `waitForChecks`, and where the forge reports none the comparison is skipped, as `waitForChecks` already does.
- `nax workflow promote --yes` does not de-duplicate evidence comments: after a failure past the `comment` action, a re-run posts the comment again.
- `nax workflow promote` edits no part of the PR body except the first line of matched checklist entries; refreshing or rewriting the body is not offered.
- Converting a ready PR back to draft (`gh pr ready --undo`, `glab mr update --draft`) is out of scope for both commands.
- `nax workflow record` validates the `id` and `kind` of an entry of kind `ci` or `minor` that names no open item only for shape; it does not check that the CI check or minor exists.
- Neither command runs repository-controlled code (they run `git`, `gh` and `glab` only), so neither calls the project trust gate.
- `nax workflow promote` can mark a head ready that was not the one it checked: `gh pr ready` and `glab mr update --ready` take no sha, so a push between the `ci-green` read and the `ready` action goes unverified.
- `ci-green` is only as strong as `waitForChecks`: when the forge's auxiliary `gh pr view` read fails, `waitForChecks` skips both its head-sha binding and its conflict check, and `promote` does not add a second read.
- `waitForChecks` with `timeoutMs: 0` and `pollMs: 0` returns after one poll because the deadline check sees the clock advance during the forge call; `promote` does not add a single-poll branch to `waitForChecks`, and its tests stub `waitForChecks` rather than freeze the clock.
- `nax workflow record` validates the shape of a `fixed` entry's `sha` only; it does not check that the commit exists.
- Concurrent `record` and `promote` calls on one run are not serialised: each write is atomic, but a read-merge-write can lose an entry another call wrote in between.
- Neither command commits the decisions sidecar; the file is git-ignored and left where it is written.
- Updating the nax-finish skill to call `nax workflow record` and `nax workflow promote` happens in nathapp-io/nax-toolkit-skills, outside this run.
- Pipeline execution mode is frozen and out of scope; both commands read workflow-mode run directories only.

## Stories

### US-001 — The decisions sidecar module

Workdir: `packages/nax`

No dependencies.

Create `src/workflow/decisions-sidecar.ts` with the types, `parseDecisionEntries`, `sidecarKindFor`, `checkEntriesAgainstItems`, `mergeDecisions`, `isoStamp`, `sidecarFileName`, `newestSidecar` and `writeSidecar` from the Design. Every validation failure throws a `NaxError` with code `WORKFLOW_DECISIONS_INVALID` and the messages the ACs give.

### US-002 — `nax workflow record`

Workdir: `packages/nax`

Depends on US-001.

Move run loading into `src/workflow/run-verdict.ts` (`loadRunVerdict`) and switch `workflowStatusCommand` to it with no output change. Create `src/workflow/pr-state.ts` (`readPrState`), `src/cli/workflow-forge.ts` (`WorkflowForgeDeps` with `forge` and `now`, and `_workflowForgeDeps`) and `src/cli/workflow-record.ts`. Register `record` in `registerWorkflowCommand`, which gains the `forgeDeps` parameter. The record tests build their `WorkflowForgeDeps` by spreading `_workflowForgeDeps` and overriding `forge` and `now`, so a field US-004 adds needs no test change. Export the new command symbols from `src/cli/index.ts`. Add the `### nax workflow` section to `docs/guides/cli-reference.md`, covering `status` and `record`.

### US-003 — Checklist tick, evidence comment and forge argv

Workdir: `packages/nax`

Depends on US-001.

Create `src/workflow/promote.ts` with `tickChecklist`, `evidenceComment`, `editBodyArgv`, `commentArgv` and `markReadyArgv`. These are pure: they take a PR body or entries and return text or argv, and run nothing. `src/workflow/pr-body-safe.ts` imports `escapeInline` and `escapeTableCell` from the `@/finish` barrel, which loads `src/finish/context.ts` and its `@/cli` import; switch that import to the leaf `../finish/pr/escape` (which has no imports) so `promote.ts` can use `safeInline` without closing a runtime cycle. Behaviour of `pr-body-safe` is unchanged.

### US-004 — `nax workflow promote`: validation and the dry run

Workdir: `packages/nax`

Depends on US-002.

Add `waitForChecks` to `WorkflowForgeDeps`. Create `src/cli/workflow-promote.ts` with the validation steps, the `items-ruled` and `ci-green` checks, and the report; register `promote` (with its `--yes` flag) in `registerWorkflowCommand`; export its symbols from `src/cli/index.ts`. This story performs no forge write: with every check passing it prints the dry-run result whether or not `--yes` was given, and US-005, which lands in the same PR, adds the writes. Extend the `### nax workflow` section of `docs/guides/cli-reference.md` with `promote`: flags, the two checks and the exit codes.

### US-005 — `nax workflow promote --yes`: tick, comment, ready, record

Workdir: `packages/nax`

Depends on US-003, US-004.

In `src/cli/workflow-promote.ts`, make `--yes` with both checks passing run the `tick`, `comment`, `ready` and `record` actions in that order, using `tickChecklist`, `evidenceComment` and the argv builders from US-003, and stop at the first failing action. Extend the `promote` text in `docs/guides/cli-reference.md` with the actions.

Story split rationale: US-001 is the data contract both commands share, US-002 adds the writer and the live PR read, US-003 is the pure promotion text, US-004 is the read-only half of `promote`, and US-005 adds the forge writes behind `--yes`. Every story is within the 24-assertion `maxAcCount`.

### Context Files

**US-001**
- `packages/nax/src/workflow/result.ts` — `_resultDeps` and the temp-file-then-rename write pattern
- `packages/nax/src/workflow/types.ts` — `OpenItem`
- `packages/nax/test/unit/workflow/result.test.ts` — the temporary-directory test pattern

**US-002**
- `packages/nax/src/cli/workflow.ts` — the loader and command group being extended
- `packages/nax/src/workflow/open-items.ts` — `buildOpenItems`, `buildVerdict`
- `packages/nax/src/forge/pr.ts` — `viewArgv`
- `packages/nax/src/forge/detect.ts` — `detectForge`
- `packages/nax/test/unit/cli/workflow-status.test.ts` — the CLI test harness to mirror

**US-003**
- `packages/nax/src/workflow/pr-body.ts` — `openItemLine`, the checklist line format
- `packages/nax/src/workflow/pr-body-safe.ts` — `safeInline`
- `packages/nax/src/workflow/decisions-sidecar.ts` — `DecisionEntry`, created by US-001

**US-004**
- `packages/nax/src/cli/workflow.ts` — `registerWorkflowCommand`
- `packages/nax/src/workflow/ci-wait.ts` — `waitForChecks`
- `packages/nax/test/unit/cli/workflow-record.test.ts` — the harness for forge-backed commands, created by US-002

**US-005**
- `packages/nax/src/cli/workflow-promote.ts` — the command being extended, created by US-004
- `packages/nax/src/workflow/promote.ts` — `tickChecklist`, `evidenceComment`, the argv builders, created by US-003
- `packages/nax/src/finish/pr/open.ts` — the existing `gh pr ready` / `glab mr update --ready` argv
- `packages/nax/test/helpers/workflow-promote-fixture.ts` — the draft-run fixture, created by US-004

### Creates

**US-001**
- `packages/nax/src/workflow/decisions-sidecar.ts`
- `packages/nax/test/unit/workflow/decisions-sidecar.test.ts`

**US-002**
- `packages/nax/src/workflow/run-verdict.ts`
- `packages/nax/src/workflow/pr-state.ts`
- `packages/nax/src/cli/workflow-forge.ts`
- `packages/nax/src/cli/workflow-record.ts`
- `packages/nax/test/unit/workflow/pr-state.test.ts`
- `packages/nax/test/unit/cli/workflow-record.test.ts`

**US-003**
- `packages/nax/src/workflow/promote.ts`
- `packages/nax/test/unit/workflow/promote.test.ts`

**US-004**
- `packages/nax/src/cli/workflow-promote.ts`
- `packages/nax/test/unit/cli/workflow-promote.test.ts` — ACs 1-21.
- `packages/nax/test/helpers/workflow-promote-fixture.ts` — the draft-run fixture (a run directory with open item `B1`, a ruling sidecar, a stubbed forge reporting a draft PR whose body holds the `B1` checklist line, and `waitForChecks` returning `green`); US-004 and US-005 tests both import it.

**US-005**
- `packages/nax/test/unit/cli/workflow-promote-yes.test.ts` — ACs 1-8.

### Modifies

**US-002**
- `packages/nax/src/cli/workflow.ts` — the run-loading helpers move to the new run-verdict module, `workflowStatusCommand` builds its report from `loadRunVerdict`, and `registerWorkflowCommand` gains the `forgeDeps` parameter and registers `record`; the status output and exit codes are unchanged.
- `packages/nax/src/cli/index.ts` — also exports `workflowRecordCommand`, `WorkflowRecordOptions`, `WorkflowRecordReport`, `WorkflowForgeDeps` and `_workflowForgeDeps`.
- `packages/nax/test/unit/cli/workflow-status.test.ts` — "AC-15: the cli barrel exports the group and its status subcommand" expects the group's subcommand names to equal exactly `["status"]`; with `record` registered it expects `["status", "record"]`.
- `docs/guides/cli-reference.md` — adds the `### nax workflow` section with `status` and `record`.

**US-003**
- `packages/nax/src/workflow/pr-body-safe.ts` — the escape-helper import moves from the finish barrel to the finish escape leaf module, breaking the import cycle the new promote module would otherwise close; no function changes.

**US-004**
- `packages/nax/src/cli/workflow.ts` — `registerWorkflowCommand` also registers `promote`.
- `packages/nax/src/cli/index.ts` — also exports `workflowPromoteCommand`, `WorkflowPromoteOptions`, `WorkflowPromoteReport`, `PromoteCheck` and `PromoteAction`.
- `packages/nax/test/unit/cli/workflow-status.test.ts` — the registration test that US-002 changed to `["status", "record"]` now expects exactly `["status", "record", "promote"]`.
- `docs/guides/cli-reference.md` — adds `nax workflow promote` to the `### nax workflow` section.

**US-005**
- `docs/guides/cli-reference.md` — extends the `nax workflow promote` text with the `--yes` actions.

### Seams

- US-002 and US-004 consume `loadRunVerdict` and `readPrState`; US-005 consumes `tickChecklist`, `evidenceComment` and the argv builders from US-003, and `newestSidecar` / `writeSidecar` / `mergeDecisions` from US-001. US-004's and US-005's ACs enter at `promote` parsed by a `commander` program that `registerWorkflowCommand` registered, with `WorkflowForgeDeps` stubbed, and assert on the argv the stub recorded and on the sidecar file on disk.
- US-002's ACs enter at `record` parsed the same way and read the sidecar back from disk with `newestSidecar`.

## Acceptance Criteria

### US-001

1. [unit] `parseDecisionEntries([{ id: "B1", kind: "finding", disposition: "fixed", reason: "retry path fixed", sha: "a1b2c3d" }])` returns that one entry unchanged.
2. [unit] `parseDecisionEntries({ decisions: [] })` throws a `NaxError` with code `WORKFLOW_DECISIONS_INVALID` and message `decisions must be a JSON array`.
3. [unit] `parseDecisionEntries` on an entry whose `id` is `""` throws with message `decision 1: id must be a non-empty string`.
4. [unit] `parseDecisionEntries` on an entry `B1` whose `disposition` is `"accepted"` throws with message `decision B1: disposition must be one of fixed, waived, confirmed, overridden, verified`.
5. [unit] `parseDecisionEntries` on a `fixed` entry `B1` with no `sha` throws with message `decision B1: disposition fixed requires a sha`.
6. [unit] `parseDecisionEntries` on a `waived` entry `B1` carrying `sha` `a1b2c3d` throws with message `decision B1: sha is only allowed when disposition is fixed`.
7. [unit] `parseDecisionEntries` on an entry `B1` with `sha` `"xyz"` throws with message `decision B1: sha must be 7 to 40 hex characters`.
8. [unit] `parseDecisionEntries` on an entry `B1` whose `reason` is `"line one\nline two"` throws with message `decision B1: reason must be one non-empty line`.
9. [unit] `parseDecisionEntries` on an entry `B1` whose `reason` is `"   "` throws with message `decision B1: reason must be one non-empty line`.
10. [unit] `parseDecisionEntries` on two entries that both have `id` `B1` throws with message `decision B1 appears twice`.
11. [unit] `parseDecisionEntries` on an entry `B1` with `kind` `"bug"` throws with message `decision B1: kind must be one of finding, advisor, gate, ci, story, cannot-verify, minor, reason`.
12. [unit] `sidecarKindFor` returns `"advisor"` for an open item of kind `ruling` and `"finding"` for an open item of kind `finding`.
13. [unit] `checkEntriesAgainstItems` on an entry `B9` of kind `finding` and open items `B1` and `B2` throws with message `unknown item B9; open items: B1, B2`.
14. [unit] `checkEntriesAgainstItems` on an entry `B9` of kind `finding` and no open items throws with message `unknown item B9; open items: none`.
15. [unit] `checkEntriesAgainstItems` accepts an entry of kind `ci` with id `check:e2e` and an entry of kind `minor` with id `m1`, neither of which names an open item.
16. [unit] `checkEntriesAgainstItems` on an entry `B1` of kind `advisor` and an open item `B1` of kind `finding` throws with message `decision B1 has kind advisor but the open item is finding`.
17. [unit] `mergeDecisions` on existing entries `B1`, `B2` and an incoming entry `B2` with a new reason plus an entry `B3` returns `B1`, the new `B2`, then `B3`, in that order.
18. [unit] `sidecarFileName(new Date("2026-10-13T09:12:00.417Z"))` returns `decisions-2026-10-13T09-12-00-417Z.json`.
19. [unit] `newestSidecar` on a directory holding `decisions-2026-10-13T09-12-00-000Z.json`, `decisions-2026-10-14T10-00-00-000Z.json` and `result.json` returns the second file's path and parsed contents, and returns `null` for a directory with no `decisions-*.json` file.
20. [unit] After `writeSidecar(path, sidecar)`, `newestSidecar` on that directory returns `{ path, sidecar }` where `path` is the written path and `sidecar` equals the one written, and the directory holds no file other than the sidecar and those that were there before.

### US-002

1. [unit] `readPrState("github", "https://gh/pr/7", deps, cwd)` runs `gh pr view https://gh/pr/7 --json isDraft,body,url` and, for stdout `{"isDraft":true,"body":"B","url":"https://gh/pr/7"}`, returns `{ isDraft: true, body: "B", url: "https://gh/pr/7" }`.
2. [unit] `readPrState("gitlab", "7", deps, cwd)` on stdout `{"draft":true,"description":"D","web_url":"https://gl/mr/7"}` returns `isDraft` true, `body` `"D"` and `url` `"https://gl/mr/7"`, and on `{"work_in_progress":true}` returns `isDraft` true.
3. [unit] `readPrState` on a forge command that exits 1 with stderr `not found` throws a `NaxError` with code `WORKFLOW_PR_READ_FAILED` and message `cannot read PR https://gh/pr/7: not found`.
4. [unit] `readPrState` on stdout that is not JSON throws a `NaxError` with code `WORKFLOW_PR_READ_FAILED`.
5. [cli] `workflow record -f auth --decisions d.json --json -d <dir>`, where the run has open item `B1` of kind `finding` and `d.json` holds one `fixed` entry for `B1` with sha `a1b2c3d`, creates exactly one `decisions-*.json` file in the run directory whose `artifact` is `<runId>/result.json`, `feature` is `auth`, `outcome` is `pending`, `decisions` equals the file's entries and `reasons` equals the record's `reasons`.
6. [cli] That call exits 0 and prints one JSON object whose `feature` is `auth`, `runId` is the run directory's name, `sidecar` is the sidecar's path relative to `<dir>`, `outcome` is `pending`, `decisions` is 1 and `unruled` is `[]`.
7. [cli] With open items `B1` and `B2` and a decisions file ruling only `B1`, the printed `unruled` is `["B2"]` and the exit code is 0.
8. [cli] A second `workflow record` call with a decisions file holding an entry for `B2`, after the first created the sidecar, leaves exactly one `decisions-*.json` file in the run directory and its `decisions` holds the entries for `B1` then `B2`.
9. [cli] A second call whose decisions file re-rules `B1` as `waived` with a new reason replaces the `B1` entry in the same sidecar and keeps its position.
10. [cli] `workflow record -f auth --outcome abandoned` with an existing sidecar rewrites that sidecar's `outcome` to `abandoned` and leaves its `decisions` unchanged.
11. [cli] `workflow record -f auth --outcome abandoned` on a run with no sidecar exits 1 with error `no decisions sidecar for run <runId>; pass --decisions` and creates no file.
12. [cli] `workflow record -f auth` with neither `--decisions` nor `--outcome` exits 1 with error `nothing to record: pass --decisions or --outcome`.
13. [cli] `workflow record -f auth --outcome done` exits 1 with error `outcome must be one of pending, promoted, verified-ready, abandoned` and reads no run directory.
14. [cli] `workflow record -f auth --outcome promoted` with an existing sidecar, where the stubbed forge's `pr view` call reports `isDraft` true, exits 1 with error `cannot record outcome promoted: PR is still a draft` and leaves the sidecar's bytes unchanged.
15. [cli] `workflow record -f auth --outcome promoted` with an existing sidecar, where the forge reports the PR as ready, sets the sidecar's `outcome` to `promoted` and its `url` to the record's `url`.
16. [cli] `workflow record -f auth --outcome verified-ready` where the forge reports the PR as a draft exits 1 with error `cannot record outcome verified-ready: PR is still a draft`.
17. [cli] `workflow record -f auth --outcome promoted` on a run whose record has no `url` exits 1 with error `cannot record outcome promoted: the workflow result has no PR url`.
18. [cli] A decisions file holding an entry for id `B9` of kind `finding`, with open items `B1` only, exits 1 with error `unknown item B9; open items: B1` and creates no sidecar.
19. [cli] A decisions file whose content is not JSON exits 1 with error `decisions file is not valid JSON: <path>`, and a path that does not exist exits 1 with error `cannot read decisions file: <path>`.
20. [cli] `workflow record -f ../x --decisions d.json` exits 1 with error `Feature name must be a single path segment: ../x` and reads no file.
21. [cli] `workflow record -f auth --decisions d.json` without `--json` prints `auth: recorded 1 decision(s) in <relative sidecar path>; outcome pending` and, when an open item is unruled, a second line `unruled: B2`.
22. [unit] `registerWorkflowCommand(new Command())` returns a group named `workflow` whose subcommand names equal `["status", "record"]`.
23. [cli] `workflow record -f auth --outcome promoted` when no forge is detected exits 1 with error `no forge detected for <dir>`.
24. [cli] `workflow record -f auth --decisions d.json` where the run has no readable `result.json` exits 1 with error `no workflow result for feature auth`.

### US-003

1. [unit] `tickChecklist` on the body line ``- [ ] **B1** (important, finding) `a.ts:3` — leak`` and a `fixed` entry for `B1` with sha `a1b2c3d` returns the line ``- [x] **B1** (important, finding) `a.ts:3` — leak — fixed in a1b2c3d`` and `ticked` `["B1"]`.
2. [unit] `tickChecklist` appends ` — verified` for a `verified` entry, ` — confirmed` for a `confirmed` entry, ` — waived: <reason>` for a `waived` entry and ` — overridden: <reason>` for an `overridden` entry, each to its own line.
3. [unit] When the checklist line for `B1` is followed by the indented lines `  Suggestion: add a guard` and `  Advisor: fix — risk`, `tickChecklist` appends the suffix to the first line only and returns the two indented lines unchanged and in place.
4. [unit] `tickChecklist` for an entry `B1` on a body whose only checklist line is `- [ ] **B10** (finding) — x` returns the body unchanged and `ticked` `[]`.
5. [unit] `tickChecklist` for an entry `_run:ci` ticks the line `- [ ] **_run:ci** (ci) — CI failed`.
6. [unit] `tickChecklist` leaves a line that is already `- [x] **B1** ...` unchanged and does not list `B1` in `ticked`.
7. [unit] `tickChecklist` for an entry whose id is on no checklist line returns the body byte for byte and `ticked` `[]`.
8. [unit] `evidenceComment` on entries `B1` (kind `finding`, `fixed`, reason `retry fixed`, sha `a1b2c3d`) and `D-1` (kind `advisor`, `confirmed`, reason `deferral accepted`) returns `## Resolved before ready`, a blank line, then the lines `- B1 (finding) fixed: retry fixed (a1b2c3d)` and `- D-1 (advisor) confirmed: deferral accepted`.
9. [unit] `evidenceComment` on an entry whose reason is `ask @octocat` returns an entry line whose reason text equals `safeInline("ask @octocat")`, in which the `@` is followed by a zero-width space.
10. [unit] `tickChecklist` for a `waived` entry whose reason is `ask @octocat` appends ` — waived: ` followed by `safeInline("ask @octocat")`.
11. [unit] `evidenceComment` for an entry whose id is `@team` renders the id as `safeInline("@team")`.
12. [unit] `editBodyArgv("github", "https://gh/pr/7", "B")` returns `["gh", "pr", "edit", "https://gh/pr/7", "--body", "B"]` and `editBodyArgv("gitlab", "7", "B")` returns `["glab", "mr", "update", "7", "--description", "B"]`.
13. [unit] `commentArgv("github", "https://gh/pr/7", "T")` returns `["gh", "pr", "comment", "https://gh/pr/7", "--body", "T"]` and `commentArgv("gitlab", "7", "T")` returns `["glab", "mr", "note", "create", "7", "-m", "T"]`.
14. [unit] `markReadyArgv("github", "https://gh/pr/7")` returns `["gh", "pr", "ready", "https://gh/pr/7"]` and `markReadyArgv("gitlab", "7")` returns `["glab", "mr", "update", "7", "--ready"]`.

### US-004

1. [cli] `workflow promote -f auth --json -d <dir>` on a draft run with open item `B1`, a sidecar ruling `B1`, a PR the stubbed forge reports as a draft and `waitForChecks` returning `green`, exits 0 and prints one JSON object with `dryRun` true, `promoted` false and `checks` holding `items-ruled` and `ci-green` both `passed` true.
2. [cli] In that run the forge stub receives none of `gh pr edit`, `gh pr comment`, `gh pr ready`, `glab mr update` or `glab mr note create`.
3. [cli] With open items `B1` and `B2` and a sidecar ruling only `B1`, `promote` exits 2 and the `items-ruled` check has `passed` false and `detail` `no ruling recorded for B2`.
4. [cli] With open item `B1` and no sidecar in the run directory, the `items-ruled` check has `passed` false and `detail` `no decisions recorded; run nax workflow record`.
5. [cli] When `waitForChecks` returns `{ outcome: "pending", detail: "no CI result within 0ms" }`, `promote` exits 2 and the `ci-green` check has `passed` false and `detail` `ci pending: no CI result within 0ms`.
6. [cli] When `waitForChecks` returns outcome `no-checks`, `promote` exits 2 and `ci-green` has `passed` false.
7. [cli] When `waitForChecks` returns outcome `conflicting`, `promote` exits 2 and `ci-green` has `passed` false.
8. [cli] `promote` calls `waitForChecks` once, with the forge detected for `<dir>`, the record's `url` as the PR reference, `timeoutMs` 0 and `expectedSha` equal to the trimmed stdout of the stubbed forge's `git rev-parse HEAD` call.
9. [cli] When an open item is unruled and CI is `failed`, the report lists both checks with `passed` false (neither check hides the other).
10. [cli] When the stubbed forge's `pr view` call reports the PR as not a draft, `promote` exits 1 with error `PR is already ready: <url>` and the forge stub receives none of `gh pr edit`, `gh pr comment`, `gh pr ready`, `glab mr update` or `glab mr note create`.
11. [cli] On a run whose record `outcome` is `ready`, `promote` exits 1 with error `workflow for auth ended ready; only a draft can be promoted`.
12. [cli] On a run whose record has no `outcome`, `promote` exits 1 with error `workflow for auth ended not published; only a draft can be promoted`.
13. [cli] On a draft run whose record has no `url`, `promote` exits 1 with error `the workflow result has no PR url`.
14. [cli] When no forge is detected, `promote` exits 1 with error `no forge detected for <dir>`.
15. [cli] When the stubbed forge's `git rev-parse HEAD` call exits 128 with stderr `not a git repository`, `promote` exits 1 with error `cannot read HEAD: not a git repository`.
16. [cli] `workflow promote -f auth` without `--json` prints the lines `pass  items-ruled`, `pass  ci-green` and `ready to promote; rerun with --yes`.
17. [cli] `workflow promote -f auth` without `--json`, with CI pending, prints a line starting `FAIL  ci-green  ci pending`.
18. [cli] `workflow promote -f auth` where the run has no readable `result.json` exits 1 with error `no workflow result for feature auth`.
19. [cli] `workflow promote -f auth` where the newest `result.json` has no `featureWorkflow` exits 1 with an error starting `workflow for auth has not started its feature steps`.
20. [cli] When `waitForChecks` returns `{ outcome: "unavailable", detail: "checks report a1b2c3d4 but HEAD is e5f6a7b8" }`, `promote --yes` exits 2, `ci-green` has `passed` false and `detail` `ci unavailable: checks report a1b2c3d4 but HEAD is e5f6a7b8`, and the forge stub receives none of `gh pr edit`, `gh pr comment`, `gh pr ready`, `glab mr update` or `glab mr note create`.
21. [unit] `registerWorkflowCommand(new Command())` returns a group named `workflow` whose subcommand names equal `["status", "record", "promote"]`, and parsing `workflow promote -f auth --yes --json -d <dir>` calls `deps.exit` with the code `workflowPromoteCommand` returns for `{ dir: <dir>, feature: "auth", yes: true, json: true }`.

### US-005

All US-005 tests use the draft-run fixture from `test/helpers/workflow-promote-fixture.ts` (created by US-004) with every check passing unless an AC says otherwise.

1. [cli] `workflow promote -f auth --yes --json` issues forge commands in the order body edit, comment, ready; afterwards the sidecar on disk has `outcome` `promoted` and the record's `url`, the exit code is 0 and the report has `promoted` true.
2. [cli] In that run the body-edit command's body contains the PR body's `- [x] **B1**` line with the suffix for the sidecar's disposition of `B1`, and the comment command's text starts with `## Resolved before ready`.
3. [cli] When the PR body has no checklist line for any ruled id, `--yes` issues no body-edit command and the report marks the `tick` action `skipped`.
4. [cli] When the stubbed forge returns a changed body on its second `pr view` call (the first is the draft check, the second is the read immediately before the edit), the body written by the edit command contains that change.
5. [cli] `workflow promote -f auth --yes` with an unruled open item exits 2, the forge stub receives none of `gh pr edit`, `gh pr comment`, `gh pr ready`, `glab mr update` or `glab mr note create`, and the sidecar's bytes are unchanged.
6. [cli] `workflow promote -f auth --yes` with CI `failed` exits 2 and the forge stub receives none of `gh pr edit`, `gh pr comment`, `gh pr ready`, `glab mr update` or `glab mr note create`.
7. [cli] When the forge's comment command exits 1 with stderr `rate limited`, `promote --yes` exits 1 with error `promote stopped at comment: rate limited` and the forge stub receives no `gh pr ready` or `glab mr update --ready` command.
8. [cli] When the forge's ready command exits 1 with stderr `not mergeable`, `promote --yes` exits 1 with error `promote stopped at ready: not mergeable`, the body-edit and comment commands were already issued, and the sidecar's `outcome` is not `promoted`.
