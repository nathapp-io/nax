# SPEC: Post-0.88 Fixes

Closes: #2567, #2563, #2347, #2459

## Summary

Four independent fixes found after v0.88.0. The workflow `finish-approval` question gives the advisor a base commit, a changed-file inventory and the text of each deferred minor, so the advisor stops diffing against a stale local branch (#2567). `withTimerSpy` stops counting foreign timers and timers that already fired, in both the nax and nax-agent copies (#2563). The owned-path screen recognises case-variant spellings of nax's config, PRD and queue files when the project's filesystem is case-insensitive (#2347). The spec grammar reads a `Dependencies:` label, and `nax spec lint` warns about any story in a multi-story spec whose dependencies are still not stated (#2459).

## Motivation

**#2567.** `approvalEvidence` (`packages/nax/src/workflow/finalize.ts`) sends the advisor five summary lines and only the *count* of deferred minors. Advisor decision policy 4 reads "A review that did not read the whole diff is never an approval", so the advisor works out the diff itself. On run `auth-relogin-recovery` (PR #2566) it diffed against the local `main` branch, which was out of date: it saw 110 changed files instead of the PR's 26 and held a PR that met every deterministic ready condition. The base commit is already resolved: `resolveSeed` stores it on `WorkflowFeatureRecord.seed`. It never reaches the question.

**#2563.** `withTimerSpy` (`packages/nax/test/helpers/timer-spy.ts`) patches `globalThis.setTimeout` for the whole process while `fn()` is awaited, so it records every timer armed anywhere in the process during that window. `test:confined` runs files with `--parallel=4 --no-isolate`, which widens the window. The executor kill-path test failed in CI run 38782674709 with 7 consecutive foreign timer ids and passed on rerun. The spy also counts a timer that fired on its own as leaked, though a fired timer no longer holds the event loop open. `packages/nax-agent/test/helpers/timer-spy.ts` is a near-identical copy with the same two defects.

**#2347.** Verified on `main` `30b6ef799` on macOS (APFS, case-insensitive) under Bun, with a canonical temp root:

| Path | Typed Write / Edit | `resolveWithin` | Raw Bash screen (`bashRefusal`, redirect) |
|---|---|---|---|
| `.nax/config.json` (exists) | refused via `resolveWithin` | refused | refused |
| `.nax/mono/api/CONFIG.JSON` | refused (`naxStateRefusal`) | **allowed** | **allowed** |
| `.nax/mono/web/Config.json` (`web/` absent) | refused (`naxStateRefusal`) | **allowed** | **allowed** |
| `.NAX/config.json` | refused (`resolveWithin` canonicalises) | refused | **allowed** |

For `.nax/...` paths the typed write tools are already covered by a second layer, `naxStateRefusal`, which refuses every non-scratchpad `.nax/` path. Two typed-write rows are still open, both because the typed path compares case-sensitively and has no `root` to probe with. A typed Write to `.QUEUE.TXT` at the root is allowed: `naxOwnedKind` misses the queue name, and `naxStateRefusal` returns early because the first segment is not `.nax`. On APFS that overwrites the run-control file. When no `.nax/` directory exists yet, `realOrRaw` cannot canonicalise `.NAX/config.json`, so a typed Write creates a config nax will later read. The larger gap is the raw Bash screen. It matches the *lexical* candidate path case-sensitively, so `.NAX/config.json` (the real root config on APFS) and the case-variant package config names pass the owned-path screen. `resolveWithin` also lets read tools reach a case-variant name through `configRefusal`. A nax config file sets commands nax runs without the permission gate, so a planted or rewritten config changes what nax executes.

**#2459.** `packages/nax/src/prd/spec-structure-grammar.ts` reads a story's dependencies only from `depends on …` and `no dependencies`. A `Dependencies: US-001.` label matches neither, so the story's `dependsOn` is undefined, the binding table renders `(not stated)`, and `nax plan` writes `"dependencies": []`. Existing specs in this repo use the label form (`docs/specs/SPEC-acceptance-bridge.md`). `nax spec lint` has no dependency check, so the spec lints clean.

## Design

### Integration

Symbols this feature **only reads** (verified on `main` `30b6ef799`):

- `resolveSeed(projectDir: string, prd: PRD): Promise<string | null>` (`packages/nax/src/workflow/seed.ts:21`). Its result is stored as `WorkflowFeatureRecord.seed: string | null` (`src/workflow/types.ts:190`) and reaches `publish` as `input.record.seed`.
- `changedFilesSince(projectDir: string, base: string): Promise<string[]>` (`packages/nax/src/workflow/git.ts:74`). It runs `git diff --name-only <base>..HEAD` through `_workflowDeps.git` and throws `NaxError` `WORKFLOW_GIT_FAILED` on a git failure.
- `askApproval(advisor, { feature, evidence })` (`packages/nax/src/workflow/approval.ts:98`). It maps each evidence string to one `{ source: "review-round", text }` item on the `finish-approval` question.
- `MinorItem` (`src/workflow/types.ts:150`) and `bodyFacts` (`finalize.ts:129`). `bodyFacts` already builds `minorsLeft: string[]` as `"<storyId>: <text>"` for every `triage === "leave"` minor, followed by `record.newMinors`.
- `realOrRaw(p: string): string` from `@nathapp/nax-agent/internal`.
- `naxOwnedWriteRefusal(tool, rel, exemptRel?, optIns = NO_OPT_INS)` (`packages/nax/src/agents/nax-owned-writes.ts:242`). Its signature is unchanged; its behaviour changes only through `isNaxOwnedWritePath` and `naxStateRefusal`, listed below.
- `collectStoryDeclarations`, `readDependencyValue`, `DEPENDS_ON_NONE`, `DEPENDENCY_ID` (`packages/nax/src/prd/spec-structure-grammar.ts`) and `extractSpecStructure(specContent: string): SpecStructure` (`src/prd/spec-structure.ts:153`). `SpecStoryStructure.dependsOn` is `undefined` when nothing is stated and `[]` for "no dependencies".
- `SpecLintFinding` (`src/prd/spec-lint.ts:89`): `{ level: "error" | "warn"; code: string; message: string }`. `BLOCKING_SPEC_LINT_CODES` (`spec-lint.ts:80`) is unchanged, so the new code never blocks `nax plan`.

Symbols this feature **changes**. The baseline only locates the code; it is never the interface to implement.

- `approvalEvidence` (`packages/nax/src/workflow/finalize.ts:148`)
  - Baseline: `(input: Pick<PublishInput, "record" | "stories">, ci: Pick<CiWaitResult, "outcome" | "detail">, minorsLeft: number): string[]`
  - Target: `(input: Pick<PublishInput, "record" | "stories">, ci: Pick<CiWaitResult, "outcome" | "detail">, minorsLeft: readonly string[], changed: ChangedFilesEvidence): string[]`, where `export type ChangedFilesEvidence = { readonly kind: "files"; readonly files: readonly string[] } | { readonly kind: "unavailable"; readonly reason: string }` is declared in `finalize.ts`. The lines are listed under "Approval evidence" below.
- The `prMode` call site (`finalize.ts:~415`)
  - Baseline: `approvalEvidence(input, ci, body.minorsLeft.length)`
  - Target: it builds `changed` first. With `input.record.seed === null`, `changed` is `{ kind: "unavailable", reason: "no base commit was resolved" }`. Otherwise it awaits `changedFilesSince(fc.projectDir, input.record.seed)`; on success `changed` is `{ kind: "files", files }`, and on a throw it is `{ kind: "unavailable", reason: errorMessage(err) }`. Then it calls `approvalEvidence(input, ci, body.minorsLeft, changed)`. `changed` is computed only on the branch where the advisor is asked (`reasons.length === 0`).
- `withTimerSpy` (`packages/nax/test/helpers/timer-spy.ts`, and the copy at `packages/nax-agent/test/helpers/timer-spy.ts`)
  - Baseline: `withTimerSpy<T>(fn: () => Promise<T>): Promise<TimerSpyResult<T>>`, with `TimerSpyResult<T> = { result; armed; cleared; leaked }` and `leaked = armed` not in `cleared`.
  - Target: `withTimerSpy<T>(fn: () => Promise<T>, options?: TimerSpyOptions): Promise<TimerSpyResult<T>>`, with `export interface TimerSpyOptions { readonly origin?: string }` and `TimerSpyResult<T>` gaining `fired: Set<unknown>`. The spec under "Timer spy" below gives the target semantics.
- `isNaxConfigSegments` (`packages/nax/src/agents/nax-owned-writes.ts:82`)
  - Baseline: `(segments: readonly string[]): boolean`, exact-case compare.
  - Target: `(segments: readonly string[], foldCase = false): boolean`. With `foldCase` true, the `.nax`, `mono` and `config.json` segments are compared case-insensitively. Every existing caller passes nothing and keeps exact-case behaviour.
- `isNaxConfigFile(root: string, resolved: string): boolean` (`nax-owned-writes.ts:104`)
  - Baseline: `isNaxConfigSegments(rel.split(sep))`.
  - Target: `isNaxConfigSegments(rel.split(sep), isCaseInsensitiveFs(root))`.
- `naxOwnedKind` (`nax-owned-writes.ts:167`)
  - Baseline: `(rel: string): "prd" | "queue" | undefined`, exact-case compare.
  - Target: `(rel: string, foldCase = false): "prd" | "queue" | undefined`. With `foldCase` true, the `.nax`, `features` and `prd.json` segments and the `QUEUE_CONTROL_FILES` names are compared case-insensitively.
- `isNaxOwnedWritePath(rel)` / `naxOwnedWriteRefusal` / `naxStateRefusal` (`nax-owned-writes.ts:154`, `:242`, `:288`)
  - Baseline: `isNaxOwnedWritePath(rel)` calls `naxOwnedKind(rel)`, and `naxStateRefusal` checks `segments[0] !== ".nax"`, both exact-case.
  - Target: the typed-write path always folds case, because `OwnedPathsPolicy.writeRefusal`'s context carries no root to probe. `isNaxOwnedWritePath(rel)` calls `naxOwnedKind(rel, true)`, and `naxStateRefusal` compares the first segment with `.nax` case-insensitively. On a case-sensitive filesystem this also refuses a typed write to a stray `.QUEUE.TXT` or `.NAX/...`; such a path is never nax's own file there, but refusing it is harmless. The PRD path-exact exemption (`rel === exemptRel`) is unchanged. Two compares on this path stay exact-case, and both fail closed: `naxStateRefusal`'s own `isNaxConfigSegments(segments)` call (so `.NAX/config.json` is refused with the state text rather than skipped for `configRefusal`), and its `scratchpad` entry compare (so `.NAX/SCRATCHPAD/x` is refused). `createConfigReadGatePolicy`'s `writeRefusal` keeps calling `isNaxConfigSegments` with no fold for the same reason.
- `firstOwnedHit(root, candidates)` (`nax-owned-writes.ts:~314`) and `configCandidatesOnly(root, candidates)` (`packages/nax/src/agents/config-read-gate.ts:21`)
  - Baseline: `naxOwnedKind(candidate.rel)`.
  - Target: `naxOwnedKind(candidate.rel, isCaseInsensitiveFs(root))`.
- The spec grammar (`spec-structure-grammar.ts`)
  - Baseline: a story's dependencies are read only from `depends on …` (`DEPENDS_ON_MENTION`) and `no dependencies` (`NO_DEPENDENCIES`).
  - Target: a `Dependencies` label is read too. The accepted forms are listed under "Dependency label" below. The label's value goes through the existing `readDependencyValue`: ids join the story's `dependencyLists`, `none` sets `statesNone`, and a value with neither leaves the story unchanged. The scope is the same as `depends on`: outside fences and outside `### Modifies` / `### Seams` / `### Context Files` / `### Creates`.
- `lintSpecContent(text, options)` (`packages/nax/src/prd/spec-lint.ts:426`)
  - Baseline: Modifies, Out of Scope, Context Files and AC checks, plus `story-count-over-target`.
  - Target: it also appends the findings of `checkStoryDependencies(text)`, a new function in a new file `packages/nax/src/prd/spec-lint-dependencies.ts`. `spec-lint.ts` is at 448 of its 600-line limit.

New, in `packages/nax/src/agents/case-insensitive-fs.ts`:

```ts
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realOrRaw } from "@nathapp/nax-agent/internal";

export const _caseFsDeps = {
  stat: (p: string): { dev: number; ino: number } => statSync(p),
};

const cache = new Map<string, boolean>();

/** Test hook: forget every probed root. */
export function _resetCaseFsCache(): void {
  cache.clear();
}

/**
 * Is the filesystem holding `root` case-insensitive? Probed once per canonical
 * root: stat the nearest path (root or an ancestor) whose last segment has a
 * cased letter, and stat the same path with that segment's case swapped. The
 * same dev+ino means case-insensitive. Fails closed (true) when no cased
 * segment exists or the original path cannot be stat'ed.
 */
export function isCaseInsensitiveFs(root: string): boolean; // signature only
```

The probe stats the original path first. If that stat throws, it returns `true` without stat'ing the swapped spelling. Otherwise it stats the swapped spelling: `ENOENT` or `ENOTDIR` returns `false`, any other error returns `true`, and a successful stat returns `true` only when dev and ino both match. The probe path is the nearest of `realOrRaw(root)` and its ancestors whose last segment has a cased letter, so when the root's own last segment has one, the probe path is the root itself. The cache is keyed by `realOrRaw(root)`.

### Approval evidence

`approvalEvidence` returns these lines, in this order:

1. `Stories: …` (unchanged)
2. `Final gates: …, all green` (unchanged)
3. `CI: <outcome> (<detail>)` (unchanged)
4. `Branch review ran; open findings after the fix pass: <n>; branch rulings: <n>` (unchanged)
5. The base line:
   - `input.record.seed` set: `Base commit: <seed>. Diff against this sha (git diff <seed>..HEAD), never against a branch name such as main.`
   - `input.record.seed` null: `Base commit: unresolved. Establish the diff base from the pull request itself, never from a local branch.`
6. The inventory line:
   - `changed.kind === "files"`: `Changed files since the base commit (<count>): <path>, <path>, …`. It lists at most `MAX_EVIDENCE_FILES = 300` paths in the order given. When there are more, it ends with `, and <count - 300> more`. With zero files it reads `Changed files since the base commit (0): none`.
   - `changed.kind === "unavailable"`: `Changed files since the base commit: unavailable (<reason>)`
7. `Deferred minors left: <minorsLeft.length>` (unchanged text)
8. One line per `minorsLeft` entry, in order: `Deferred minor: <entry>`
9. `Gate repair: …` when `gateRepairRounds` is set (unchanged)

`MAX_EVIDENCE_FILES` is the only cap. The base line and the inventory line are independent: the base line reads only `record.seed`, and the inventory line reads only `changed`.

### Timer spy

Both copies of `withTimerSpy` get the same target behaviour:

- **Fired timers are not leaks.** When the handler is a function, the spy arms a wrapper that adds the timer's id to `fired` and then calls the original handler with its arguments. `leaked` is `armed` minus `cleared` minus `fired`. A string handler is passed through unwrapped.
- **Origin filter.** With `options.origin` set, a timer is pushed to `armed` only when the stack captured at arm time (`new Error().stack`, with `\` normalised to `/`) contains `options.origin`. A timer that doesn't match is still armed through the real `setTimeout` and still returned to its caller, but it is not recorded. With `origin` unset, every timer is recorded, as today.
- `cleared` keeps recording every id passed to `clearTimeout` (unchanged).

The nax executor test `executeWithTimeout > clears every timer it arms on the kill path` passes `{ origin: "src/verification/executor" }`. `executeWithTimeout` arms timers through `_executorDeps.setTimeout`, whose wrapper is defined in `src/verification/executor.ts`, and through `raceWithDeadline` in the same file, so both appear in the arming stack. The narrower `src/` prefix matters: the test file's own path, `test/unit/verification/executor.test.ts`, contains `verification/executor`, so a bare `verification/executor` would record the test's own timers too.

### Dependency label

The grammar reads a dependency label in these forms, case-insensitively, followed by the same value syntax `depends on` already takes (story ids with `,` / `;` / `and` separators, or `none`):

- `Dependencies: US-001` / `Dependencies: US-001, US-002` / `Dependencies: none`
- `**Dependencies:** US-001`
- `**Dependencies**: none`

A trailing `.` after the value is accepted, as it is today after `depends on`. A label whose value is neither story ids nor `none` (for example `Dependencies: zod`) is not a declaration. A `### Dependencies` heading is not a label.

### Spec lint dependency check

`checkStoryDependencies(text: string): SpecLintFinding[]` runs `extractSpecStructure(text)`. With fewer than two stories it returns `[]`. Otherwise it returns one finding per story whose `dependsOn` is `undefined` and that has no `dependsOn` entry in the structure's `warnings`, in story order. A story with a conflicting declaration (both `none` and ids) has `dependsOn` `undefined` and a warning, so it gets no finding:

```
{ level: "warn", code: "story-dependencies-not-stated",
  message: `${id} states no dependencies: write "Depends on US-00N", "No dependencies." or "Dependencies: US-00N" on its story line` }
```

`story-dependencies-not-stated` is not added to `BLOCKING_SPEC_LINT_CODES`, so `nax spec lint` still exits 0 and `nax plan`'s lint gate still passes when it is the only finding.

### Failure Handling

| Condition | Behaviour |
|---|---|
| `record.seed` is null at approval time | Base line reads `unresolved`; inventory line reads `unavailable (no base commit was resolved)`; the advisor is still asked. |
| `changedFilesSince` throws at approval time | Inventory line reads `unavailable (<error message>)`; base line still names the seed; the advisor is still asked. |
| Case probe: no ancestor segment of the root has a cased letter | `isCaseInsensitiveFs` returns `true` (fail closed). |
| Case probe: stat of the original path throws | `isCaseInsensitiveFs` returns `true` (fail closed). |
| Case probe: stat of the swapped path throws `ENOENT` / `ENOTDIR` | `isCaseInsensitiveFs` returns `false`. |
| Case probe: stat of the swapped path throws any other error | `isCaseInsensitiveFs` returns `true` (fail closed). |
| A `Dependencies:` label with a value that names no story id and is not `none` | Not a declaration; the story's dependencies are whatever else it states. |

### Quality gate notes

- `packages/nax/test/unit/workflow/finalize.test.ts` is at 795 of its 800-line limit. The new publish-level evidence tests go in `finalize-evidence.test.ts`, following the `wire()` harness pattern of `finalize-ci-gate.test.ts`.
- `bun run check:all` in `packages/nax` runs the file-size and complexity ratchets. A story that changes a function recorded in `scripts/baselines/complexity-baseline.json` regenerates it with `bun run check:complexity:update` only if the ratchet reports the row stale.

## Out of Scope

- Naming which ref the approval base commit came from (`origin/HEAD` merge-base, local `main` merge-base, or a story git ref): `resolveSeed` returns only a sha, and the sha is what the advisor diffs against.
- Changing the advisor decision policy text (`ADVISOR_POLICY` in `src/prompts/builders/advisor-builder.ts`) or the finish state machine's own `approvalEvidence` in `src/finish/advise.ts`.
- Making a changed-file inventory failure a readiness reason that keeps the PR a draft without asking the advisor.
- Tracking fired string-handler timers in `withTimerSpy`: a string handler is passed through unwrapped and, if it fires uncleared, still counts as leaked. No current call site arms one.
- Moving `withTimerSpy` into `@nathapp/nax-test-kit` or merging the two copies.
- Adding an `origin` filter to the `withTimerSpy` call sites other than the executor kill-path test.
- Switching nax-agent's `realOrRaw` or `resolveWithin` to `realpathSync.native`. nax runs on Bun, where `realpathSync` already returns on-disk casing for existing paths, and `naxOwnedPathsPolicy` is only installed by nax.
- Case-folding the `.git` metadata check (`entersGitMetadata` in nax-agent).
- Adding a `root` to `OwnedPathsPolicy.writeRefusal`'s context so the typed-write path can probe instead of always folding.
- Case-folding the sandbox's `rootWriteDenies` / `deniedEntries` lists.
- Whether the macOS sandbox profile matches the denied `.nax/` entries case-insensitively.
- Reading a `Depends:` label, or a dependency list under a separate `### Dependencies` section.
- Surfacing the grammar's existing `dependsOn` and `workdir` conflict warnings through `nax spec lint`.
- Updating the external spec-writing guide in nathapp-io/nax-spec-kit-skills.

## Stories

### US-001 — Finish-approval evidence carries the base, the file inventory and the minors

Workdir: `packages/nax`

No dependencies.

Add `ChangedFilesEvidence` and the target `approvalEvidence` signature and lines. In `prMode`, compute the changed-file inventory from `input.record.seed` on the branch where the advisor is asked, and pass `body.minorsLeft` (the strings) instead of their count. Closes #2567.

### US-002 — nax `withTimerSpy` ignores fired and foreign timers

Workdir: `packages/nax`

No dependencies.

Give `packages/nax/test/helpers/timer-spy.ts` the `fired` set, the fired-timer exclusion from `leaked` and the `origin` option. Export `TimerSpyOptions` from the helpers barrel. Add a test file for the helper, and pass `{ origin: "src/verification/executor" }` in the executor kill-path test. Fixes the nax half of #2563.

### US-003 — nax-agent `withTimerSpy` ignores fired and foreign timers

Workdir: `packages/nax-agent`

No dependencies.

Give `packages/nax-agent/test/helpers/timer-spy.ts` the same `fired` set, fired-timer exclusion and `origin` option, export `TimerSpyOptions` from its helpers barrel, and extend its existing helper test. Fixes the nax-agent half of #2563.

### US-004 — Owned-path screen recognises case-variant names on a case-insensitive filesystem

Workdir: `packages/nax`

No dependencies.

Create `src/agents/case-insensitive-fs.ts` with `isCaseInsensitiveFs`, `_caseFsDeps` and `_resetCaseFsCache`. Thread `foldCase` through `isNaxConfigSegments` and `naxOwnedKind`. Have `isNaxConfigFile`, `firstOwnedHit` and `configCandidatesOnly` pass `isCaseInsensitiveFs(root)`. Make the typed-write path (`isNaxOwnedWritePath`, `naxStateRefusal`) fold case unconditionally. Mirror both changed modules into nax-agent's test helpers verbatim and extend nax's copy-guard test to the probe, so nax-agent's engine tests keep running on nax's real rules. This is the one cross-package edit in a `packages/nax` story: the copies are test helpers that nax's own guard test pins, so they must change in the same commit. Verification note: `bun run typecheck` and `bun run test` in `packages/nax-agent` also pass, since its policy tests import the copy. This closes the raw-Bash-screen, `resolveWithin` and typed-write rows of #2347.

### US-005 — Spec grammar reads a `Dependencies:` label, and spec lint warns on unstated dependencies

Workdir: `packages/nax`

No dependencies.

Extend `collectStoryDeclarations` to read the `Dependencies` label forms. Add `checkStoryDependencies` in `src/prd/spec-lint-dependencies.ts` and call it from `lintSpecContent`. Closes #2459.

Story split rationale: the five stories touch disjoint files. US-002 and US-003 are the same change in two workspace packages, split so each story has one `Workdir`. Every story is within the 24-assertion `maxAcCount`; US-004 sits exactly at it.

### Context Files

**US-001**
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/workflow/git.ts`
- `packages/nax/src/workflow/approval.ts`
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — the `wire()` publish harness to follow
- `packages/nax/test/unit/workflow/finalize-evidence.test.ts`

**US-002**
- `packages/nax/test/helpers/timer-spy.ts`
- `packages/nax/test/helpers/index.ts`
- `packages/nax/src/verification/executor.ts`
- `packages/nax/test/unit/verification/executor.test.ts`
- `packages/nax/test/unit/helpers/fake-clock.test.ts` — precedent for a test of a test helper

**US-003**
- `packages/nax-agent/test/helpers/timer-spy.ts`
- `packages/nax-agent/test/helpers/index.ts`
- `packages/nax-agent/test/unit/helpers/timer-spy.test.ts`

**US-004**
- `packages/nax/src/agents/nax-owned-writes.ts`
- `packages/nax/src/agents/config-read-gate.ts`
- `packages/nax/test/unit/agents/nax-owned-writes.test.ts`
- `packages/nax-agent/src/tools/policy-paths-branch.ts` — `resolveWithin` and `outOfRootReason`, which call `configRefusal`
- `packages/nax-agent/test/unit/tools/credential-read-deny.test.ts` — precedent for a darwin-gated `test.if(process.platform === "darwin")` case

**US-005**
- `packages/nax/src/prd/spec-structure-grammar.ts`
- `packages/nax/src/prd/spec-structure.ts`
- `packages/nax/src/prd/spec-lint.ts`
- `packages/nax/test/unit/prd/spec-structure.test.ts`
- `packages/nax/test/unit/cli/spec-lint-command.test.ts`

### Creates

**US-002**
- `packages/nax/test/unit/helpers/timer-spy.test.ts` — ACs 1-8.
- `packages/nax/test/unit/helpers/fixtures/timer-spy-origin-fixture.ts` — exports one function that arms a timer with the handler and delay it is given and returns the id; ACs 5-6 import it so its frames carry `timer-spy-origin-fixture` in their path.

**US-003**
- `packages/nax-agent/test/unit/helpers/fixtures/timer-spy-origin-fixture.ts` — the same one-function fixture for nax-agent's AC 5.

**US-004**
- `packages/nax/src/agents/case-insensitive-fs.ts`
- `packages/nax/test/unit/agents/case-insensitive-fs.test.ts` — ACs 1-9 and 24. Its `afterEach` calls `_resetCaseFsCache()` and restores `_caseFsDeps.stat`.
- `packages/nax-agent/test/helpers/case-insensitive-fs.ts` — a verbatim copy of `src/agents/case-insensitive-fs.ts`, with the first line `// Verbatim copy of nax's src/agents/case-insensitive-fs.ts (post-088 US-004).` and its `realOrRaw` import pointed at `#src/internal/realpath`. nax-agent cannot import nax, and the nax-agent owned-paths copy imports it.
- `packages/nax/test/unit/agents/nax-owned-writes-case-fold.test.ts` — ACs 10-23. Its `afterEach` calls `_resetCaseFsCache()` and restores `_caseFsDeps.stat`, because the cache is keyed by root and ACs 14 and 17 give one root opposite answers.

**US-005**
- `packages/nax/src/prd/spec-lint-dependencies.ts`
- `packages/nax/test/unit/prd/spec-lint-dependencies.test.ts` — ACs 11-15.
- `packages/nax/test/unit/prd/spec-structure-dependency-label.test.ts` — ACs 1-9, split by concern because `spec-structure.test.ts` is at 547 lines.

### Modifies

**US-001**
- `packages/nax/src/workflow/finalize.ts` — `approvalEvidence` takes `minorsLeft: readonly string[]` and `changed: ChangedFilesEvidence` instead of a minor count, and the `prMode` call site builds `changed` from `record.seed`, as the Design states.
- `packages/nax/test/unit/workflow/finalize-evidence.test.ts` — both existing cases call `approvalEvidence(…, ci, 0)` with a numeric third argument. The target signature takes `minorsLeft: readonly string[]` and a fourth `changed: ChangedFilesEvidence`. The replacing calls pass `[]` and `{ kind: "files", files: [] }`; the two gate-repair assertions are unchanged.

**US-002**
- `packages/nax/test/helpers/timer-spy.ts` — `withTimerSpy` gains the options argument, the `fired` set, and the fired-timer exclusion from `leaked`, as the Design states.
- `packages/nax/test/helpers/index.ts` — also export the type `TimerSpyOptions` beside `withTimerSpy`.
- `packages/nax/test/unit/verification/executor.test.ts` — the "clears every timer it arms on the kill path" case calls `withTimerSpy(fn)` with no options, so foreign timers armed during the 300ms subprocess wait count against `executeWithTimeout`. The replacing call passes an options object whose origin is "src/verification/executor"; the result.timeout and leaked assertions are unchanged.

**US-003**
- `packages/nax-agent/test/helpers/timer-spy.ts` — `withTimerSpy` gains the options argument, the `fired` set, and the fired-timer exclusion from `leaked`, as the Design states.
- `packages/nax-agent/test/helpers/index.ts` — also export the type `TimerSpyOptions` beside `withTimerSpy`.
- `packages/nax-agent/test/unit/helpers/timer-spy.test.ts` — the existing two cases stay as they are; this story adds the fired-timer, string-handler and origin cases to the same `describe("withTimerSpy")` block.

**US-004**
- `packages/nax/src/agents/nax-owned-writes.ts` — `isNaxConfigSegments` and `naxOwnedKind` gain `foldCase`; `isNaxConfigFile` and `firstOwnedHit` pass `isCaseInsensitiveFs(root)`; the typed-write path folds unconditionally, as the Design states.
- `packages/nax/src/agents/config-read-gate.ts` — `configCandidatesOnly` passes `isCaseInsensitiveFs(root)` to `naxOwnedKind`.
- `packages/nax-agent/test/helpers/nax-owned-paths.ts` — nax's owned-writes copy-guard test requires this file to stay a verbatim copy of nax's owned-writes source module, apart from import lines and its one-line provenance header. Replace its body with the US-004 version of that module verbatim; its import of isCaseInsensitiveFs points at the nax-agent copy of the probe this story creates, and its realOrRaw import stays on the nax-agent internal realpath module.
- `packages/nax/test/unit/agents/nax-owned-writes-copy.test.ts` — the guard compares only the owned-writes pair. Add a second case, with the same normalisation, that compares nax-agent's case-insensitive-fs test helper with nax's case-insensitive-fs source module. The existing case is unchanged.

**US-005**
- `packages/nax/src/prd/spec-structure-grammar.ts` — `collectStoryDeclarations` also reads the `Dependencies` label forms. No existing grammar test uses a `Dependencies:` label, so no test assertion changes.
- `packages/nax/test/unit/prompts/builders/plan-builder-binding-structure.test.ts` — add AC 10, a binding-table case for a spec using the `Dependencies:` label; existing cases are unchanged.
- `packages/nax/test/unit/cli/spec-lint-command.test.ts` — add AC 16, a two-story spec with no dependency statements; existing cases are unchanged.
- `packages/nax/test/unit/plan/spec-lint-gate.test.ts` — add AC 17 for the same spec; existing cases are unchanged.
- `packages/nax/src/prd/spec-lint.ts` — `lintSpecContent` appends the findings of `checkStoryDependencies(text)`. Every empty-finding assertion in the spec-lint, spec-lint-command and spec-lint-gate tests uses a single-story fixture, for which the new check returns nothing, so no test assertion changes.

### Seams

- US-004 creates `isCaseInsensitiveFs` and consumes it in the same story. The seam ACs enter at `naxOwnedPathsPolicy.bashRefusal` and at nax-agent's `resolveWithin`, the outermost entries of the raw Bash screen and the path resolver, with `_caseFsDeps.stat` stubbed.
- US-005 creates `checkStoryDependencies` and consumes it in the same story. The seam AC enters at `specLintCommand`.
- US-001's inventory enters at `publish`, the outermost workflow entry that reaches `askApproval`.

## Acceptance Criteria

### US-001

1. [unit] `approvalEvidence` with `record.seed` `"abc123"`, `minorsLeft` `[]` and `changed` `{ kind: "files", files: ["a.ts", "b.ts"] }` returns a list containing `Base commit: abc123. Diff against this sha (git diff abc123..HEAD), never against a branch name such as main.`
2. [unit] That call's list contains `Changed files since the base commit (2): a.ts, b.ts`.
3. [unit] `approvalEvidence` with `record.seed` `null` and `changed` `{ kind: "unavailable", reason: "no base commit was resolved" }` returns a list containing `Base commit: unresolved. Establish the diff base from the pull request itself, never from a local branch.`
4. [unit] That call's list contains `Changed files since the base commit: unavailable (no base commit was resolved)`.
5. [unit] `approvalEvidence` with `changed` `{ kind: "files", files }` where `files` holds 302 distinct paths returns an inventory line that names the first 300 paths and ends with `, and 2 more`, and does not name the 301st path.
6. [unit] `approvalEvidence` with `changed` `{ kind: "files", files: [] }` returns a list containing `Changed files since the base commit (0): none`.
7. [unit] `approvalEvidence` with `minorsLeft` `["US-001: rename x", "unused import in y.ts"]` returns a list containing `Deferred minors left: 2`, followed directly by `Deferred minor: US-001: rename x` and then `Deferred minor: unused import in y.ts`.
8. [unit] In every `approvalEvidence` result, the base line comes directly after the `Branch review ran;` line, and the inventory line comes directly after the base line.
9. [unit] `publish`, wired as in `finalize-ci-gate.test.ts` with CI green, every ready condition met, `record.seed` `"abc123"`, and `_workflowDeps.git` answering `["diff", "--name-only", "abc123..HEAD"]` with stdout `"src/a.ts\nsrc/b.ts\n"`, sends a `finish-approval` question whose evidence texts include `Changed files since the base commit (2): src/a.ts, src/b.ts`.
10. [unit] That same `publish` call's `finish-approval` evidence texts include `Base commit: abc123. Diff against this sha (git diff abc123..HEAD), never against a branch name such as main.`
11. [unit] `publish`, wired the same way but with `_workflowDeps.git` answering that `diff --name-only` call with exit code 128 and stderr `bad revision`, still asks the `finish-approval` question, and its evidence includes a line starting `Changed files since the base commit: unavailable (`.
12. [unit] `publish`, wired the same way but with `record.minors` holding one item `{ storyId: "US-002", text: "tidy helper", triage: "leave" }` and `record.newMinors` `["late note"]`, sends evidence containing `Deferred minor: US-002: tidy helper` and `Deferred minor: late note`.
13. [unit] `publish` with CI failed (a deterministic readiness reason) never calls `_workflowDeps.git` with a `diff --name-only` argument list.

### US-002

1. [unit] `withTimerSpy` around a function that arms a 1ms timer with a function handler and waits for that handler to run with `waitForCondition` reports the timer's id in `armed` and in `fired`, and `leaked` is `[]`.
2. [unit] `withTimerSpy` around a function that arms a 60s timer and returns without clearing it reports that id in `leaked`.
3. [unit] A function handler armed through the spy is called with the extra arguments passed to `setTimeout` after the delay.
4. [unit] `withTimerSpy` around a function that arms a timer with a string handler and clears it reports `leaked` `[]` and does not throw.
5. [unit] `withTimerSpy(fn, { origin: "timer-spy-origin-fixture" })`, where `fn` arms one timer from a function declared in a fixture module whose path contains `timer-spy-origin-fixture` and one timer directly in the test file, records only the fixture's timer in `armed`.
6. [unit] In that origin-filtered call, the timer armed directly in the test file still fires its handler.
7. [unit] `withTimerSpy(fn)` with no options records every timer `fn` arms, as before.
8. [unit] Importing `withTimerSpy` and the type `TimerSpyOptions` from the nax test helpers barrel succeeds, and `withTimerSpy` is usable as a function taking `(fn, options)`.
9. [unit] `withTimerSpy(fn, { origin: "src/verification/executor" })`, where `fn` arms a 60s timer itself and then returns `executeWithTimeout("sleep 30", 0.1, undefined, { gracePeriodMs: 200, drainTimeoutMs: 500 })`, reports `result.timeout` `true` and `leaked` `[]`; the test clears the 60s timer afterwards.

### US-003

1. [unit] nax-agent's `withTimerSpy` around a function that arms a 1ms timer with a function handler and waits for that handler to run with `waitForCondition` reports the timer's id in `armed` and in `fired`, and `leaked` is `[]`.
2. [unit] nax-agent's `withTimerSpy` around a function that arms a 60s timer and returns without clearing it reports that id in `leaked`.
3. [unit] A function handler armed through nax-agent's spy is called with the extra arguments passed to `setTimeout` after the delay.
4. [unit] nax-agent's `withTimerSpy` around a function that arms a timer with a string handler and clears it reports `leaked` `[]` and does not throw.
5. [unit] nax-agent's `withTimerSpy(fn, { origin: "timer-spy-origin-fixture" })`, where `fn` arms one timer from a function declared in a fixture module whose path contains `timer-spy-origin-fixture` and one timer directly in the test file, records only the fixture's timer in `armed`.
6. [unit] Importing `withTimerSpy` and the type `TimerSpyOptions` from `#test/helpers/index` succeeds, and `withTimerSpy` is usable as a function taking `(fn, options)`.

### US-004

1. [unit] `isCaseInsensitiveFs(root)` returns `true` when `_caseFsDeps.stat` returns the same `{ dev, ino }` for the root and for the root with its last segment's case swapped.
2. [unit] `isCaseInsensitiveFs(root)` returns `false` when `_caseFsDeps.stat` succeeds for the root and throws an error with `code: "ENOENT"` for the case-swapped root.
3. [unit] `isCaseInsensitiveFs(root)` returns `false` when `_caseFsDeps.stat` succeeds for the root and throws an error with `code: "ENOTDIR"` for the case-swapped root.
4. [unit] `isCaseInsensitiveFs(root)` returns `false` when `_caseFsDeps.stat` returns a different `ino` for the case-swapped root.
5. [unit] `isCaseInsensitiveFs(root)` returns `true` when `_caseFsDeps.stat` succeeds for the root and throws an error with `code: "EACCES"` for the case-swapped root.
6. [unit] `isCaseInsensitiveFs(root)` returns `true` when `_caseFsDeps.stat` throws for the original root.
7. [unit] `isCaseInsensitiveFs("/1/2")` (no segment with a cased letter, root `/`) returns `true`.
8. [unit] `isCaseInsensitiveFs("/probe-x/Work/123")`, with `_caseFsDeps.stat` stubbed to return the same `{ dev, ino }` for every path, calls `_caseFsDeps.stat` with `"/probe-x/Work"` and with `"/probe-x/wORK"`, and never with a path ending in `123`.
9. [unit] Two `isCaseInsensitiveFs` calls on the same root call `_caseFsDeps.stat` for the first call only; after `_resetCaseFsCache()` a third call stats again.
10. [unit] `isNaxConfigSegments([".NAX", "mono", "api", "CONFIG.JSON"], true)` returns `true`.
11. [unit] `isNaxConfigSegments([".NAX", "mono", "api", "CONFIG.JSON"])` returns `false`.
12. [unit] `naxOwnedKind(".NAX/Features/x/PRD.JSON", true)` returns `"prd"`, and `naxOwnedKind(".QUEUE.TXT", true)` returns `"queue"`.
13. [unit] `naxOwnedKind(".NAX/Features/x/PRD.JSON")` returns `undefined`.
14. [unit] `naxOwnedPathsPolicy.bashRefusal("Bash", token, [{ lexical: join(root, ".NAX/config.json"), rel: ".NAX/config.json" }], { root, verb: "redirects into", sandboxWrapped: false })`, with `_caseFsDeps.stat` stubbed to report `root` as case-insensitive, returns a refusal string.
15. [unit] That same `bashRefusal` call with the candidate `{ lexical: join(root, ".nax/mono/api/CONFIG.JSON"), rel: ".nax/mono/api/CONFIG.JSON" }` returns a refusal string.
16. [unit] That same `bashRefusal` call with the candidate `{ lexical: join(root, ".nax/features/x/PRD.JSON"), rel: ".nax/features/x/PRD.JSON" }` returns a refusal string.
17. [unit] `naxOwnedPathsPolicy.bashRefusal` for the candidate `.NAX/config.json`, with `_caseFsDeps.stat` stubbed to report `root` as case-sensitive, returns `undefined`.
18. [unit] nax-agent's `resolveWithin(root, ".nax/mono/api/CONFIG.JSON", naxOwnedPathsPolicy)` with `root` canonical, `.nax/mono/api/` present on disk and `_caseFsDeps.stat` stubbed to report `root` as case-insensitive returns `null`.
19. [unit] That same `resolveWithin` call with `_caseFsDeps.stat` stubbed to report `root` as case-sensitive returns the resolved path.
20. [unit] `createConfigReadGatePolicy(naxOwnedPathsPolicy, true).bashRefusal("Bash", token, [{ lexical: join(root, ".NAX/config.json"), rel: ".NAX/config.json" }], { root, verb: "names", sandboxWrapped: true })`, with `root` reported case-insensitive, returns `undefined`: a sandboxed read that only names a case-variant config is treated like one naming `.nax/config.json`.
21. [unit] `naxOwnedWriteRefusal("Write", ".QUEUE.TXT")` returns a refusal string.
22. [unit] `naxOwnedWriteRefusal("Write", ".NAX/config.json")` returns a refusal string.
23. [unit] `naxOwnedWriteRefusal("Write", ".NAX/scratchpad/notes.md")` returns `undefined`.
24. [unit] On darwin only, `isCaseInsensitiveFs` on a fresh real temp directory (canonicalised with `realpathSync`), with the real `_caseFsDeps.stat`, returns the same answer as checking whether the directory's case-swapped spelling exists.

### US-005

1. [unit] `extractSpecStructure` on a two-story spec whose US-002 story line is followed by `Dependencies: US-001.` returns US-002 with `dependsOn` `["US-001"]`.
2. [unit] `extractSpecStructure` on a spec where US-001 states `Dependencies: none.` returns US-001 with `dependsOn` `[]`.
3. [unit] `extractSpecStructure` on a spec where US-003 states `**Dependencies:** US-001, US-002` returns US-003 with `dependsOn` `["US-001", "US-002"]`.
4. [unit] `extractSpecStructure` on a spec where US-002 states `**Dependencies**: none` returns US-002 with `dependsOn` `[]`.
5. [unit] `extractSpecStructure` on a spec where US-002 states `dependencies: us-001` returns US-002 with `dependsOn` `["US-001"]`.
6. [unit] `extractSpecStructure` on a spec where US-002 states only `Dependencies: zod` returns US-002 with `dependsOn` `undefined`.
7. [unit] `extractSpecStructure` on a spec where US-002 states both `Dependencies: none` and `Depends on US-001` returns US-002 with `dependsOn` `undefined` and a `dependsOn` warning for US-002.
8. [unit] `extractSpecStructure` on a spec where `Dependencies: US-001` appears only inside a fenced block under US-002 returns US-002 with `dependsOn` `undefined`.
9. [unit] `extractSpecStructure` on a spec where `Dependencies: US-001` appears only in a `### Modifies` entry's reason under `**US-002**` returns US-002 with `dependsOn` `undefined`.
10. [unit] `PlanPromptBuilder`'s binding structure section for a two-story spec whose US-002 states `Dependencies: US-001.` renders US-002's Depends on cell as `US-001`, not `(not stated)`.
11. [unit] `checkStoryDependencies` on a two-story spec where neither story states a dependency returns two findings, with level `warn` and code `story-dependencies-not-stated`, the first for US-001 and the second for US-002.
12. [unit] The US-002 finding's message is `US-002 states no dependencies: write "Depends on US-00N", "No dependencies." or "Dependencies: US-00N" on its story line`.
13. [unit] `checkStoryDependencies` on a two-story spec where US-001 states `No dependencies.` and US-002 states `Dependencies: US-001.` returns `[]`.
14. [unit] `checkStoryDependencies` on a two-story spec where US-001 states `No dependencies.` and US-002 states both `Dependencies: none` and `Depends on US-001` returns `[]`.
15. [unit] `checkStoryDependencies` on a single-story spec that states no dependency returns `[]`.
16. [unit] `specLintCommand` over a two-story spec whose stories state no dependency (otherwise clean) returns `exitCode` `0`, `reports[0].findings` codes containing `story-dependencies-not-stated`, and `reports[0].blocking` `[]`.
17. [unit] `assertSpecLintClean` over that same spec does not throw.
