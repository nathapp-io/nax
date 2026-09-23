# SPEC: Raw-bash and approval follow-ups (nax#2189, nax#2193, nax#2192)

## Summary

Three independent follow-ups to the ADR-030 Bash approval modes. The `raw` mode's protected-path
screen lets a Bash write to `.nax/config.json` and `.nax/mono/<pkg>/config.json` through,
because the production path resolver hides exactly those files as `null` and the screen reads
`null` as "outside the root" (nax#2189). Remembered approvals record `naxCommit: "unknown"`
because the execution stage reads an environment variable nothing sets instead of the
`NAX_COMMIT` constant (nax#2193). And `bashApproval: gated`/`escalate` silently offer no Bash at
all when no `Bash(...)` allow rule resolves for a stage, so `escalate` never reaches a human and
nothing says why (nax#2192). This feature fixes the first two and adds a run-start warning plus
documentation for the third.

## Motivation

**nax#2189.** Under the shipped default `bashApproval: raw`, `screenRawBashCommand`
(`src/tools/policy-bash-raw.ts`) is the only thing between an agent mistake and nax's own run
configuration. Its `protectedHit` helper calls `args.resolvePath(candidate, directory)` and
`continue`s on `null`. In production that callback is
`resolveWithin(resolvedRoot, resolve(cwd, candidate))` (`src/tools/policy.ts:577`), and
`resolveWithin` (`src/tools/policy.ts:90`) deliberately returns `null` for nax config files so
typed tools never see them. The `isNaxConfigFile` check on the next line of `protectedHit` is
therefore never reached for the only paths it exists to catch. Through the production entry,
`echo x > .nax/config.json` returns `ok` and rewrites the file, while
`echo x > .nax/features/f1/prd.json` is correctly denied. The raw-screen unit suite missed it
because its `resolvePath` stub never returns `null` for an in-root path.

**nax#2193.** `executionStage.execute` (`src/pipeline/stages/execution.ts`) builds the human ask
link with an `onRemember` callback that appends an `ApprovalEntry` whose `naxCommit` is
`process.env.NAX_COMMIT ?? "unknown"`. Nothing sets that variable; the commit is the `NAX_COMMIT`
constant exported from `src/version.ts`, which `run.start` and review-audit already record. Every
entry in `approvals.json` is therefore untraceable to the build that asked for it.

**nax#2192.** `resolveBashSupport` (`src/agents/coding-tool-bash.ts`) synthesises a `Bash(*)`
grant only under `raw`. Under `gated`/`escalate` a stage is offered Bash only when its resolved
grants already contain a `Bash` entry, which comes solely from a human-written `Bash(...)` allow
rule. That is ADR-029 §3's design, but a user who sets `bashApproval: escalate` expecting
Telegram prompts gets zero prompts and no signal. The P2 exit runs hit exactly this.

## Design

### US-001 — protected config files in the raw screen

`protectedHit` keeps its loop over every live frame in `cwd`, but checks nax config files
**before and independently of** `args.resolvePath`:

1. For each `directory` in `cwd`, compute the lexical candidate
   `realOrRaw(resolve(directory, candidate))` (`realOrRaw` from `src/utils/realpath.ts` resolves
   the nearest existing ancestor, so a not-yet-created file under a symlinked temp root still
   compares equal to `realOrRaw(root)`).
2. If `isNaxConfigFile(args.root, lexical)` is true, return `candidate` (a hit).
3. Otherwise continue exactly as today: `args.resolvePath(candidate, directory)`, `continue` on
   `null`, then the `isNaxOwnedWritePath` check on the root-relative path.

`resolveWithin` is not changed: typed tools (Read, Grep, Write, Edit, ...) must keep receiving
`null` for these files. The fix lives entirely in `src/tools/policy-bash-raw.ts`;
`src/tools/policy.ts` is 587 lines against the 600-line source limit and gains nothing.

The screen denies any parseable token or redirect that names a nax config file, not only
writes; that is the screen's existing contract for every protected path and is unchanged.

### US-002 — `naxCommit` on remembered approvals

`onRemember` in `executionStage.execute` writes `naxCommit: NAX_COMMIT` (imported from
`@/version`) instead of reading `process.env.NAX_COMMIT`. To make the callback reachable from a
test without driving a real Telegram approval, `createHumanAskLink` is added to the existing
`_executionDeps` object in `src/pipeline/stages/execution.ts`, and the stage calls it through
`_executionDeps.createHumanAskLink` so a test can capture the options it receives.

### US-003 — warn when `gated`/`escalate` grants no Bash

Detection is a pure function in a new module `src/config/inert-bash-stages.ts`, re-exported
from the `src/config` barrel:

```ts
import type { PipelineStage } from "./permissions";
import type { NaxConfig } from "./runtime-types";

/** Stages that dispatch at least one operation declaring the Bash tool. */
export const BASH_DECLARING_STAGES: readonly PipelineStage[] = ["run", "review", "rectification", "acceptance"];

/** Stages whose resolved bashApproval is gated/escalate AND whose resolved grants hold no Bash entry. */
export function findInertBashStages(config: NaxConfig): readonly PipelineStage[];
```

Logging follows the existing run-setup warning precedent: `warnFallbackMisconfiguration(config,
agentGetFn, logger)` in `src/execution/lifecycle/run-setup-warnings.ts`, called directly from
`setupRun`. A sibling `warnInertBashStages(config: NaxConfig, logger: ReturnType<typeof getSafeLogger>): void`
goes in that same file and logs one warning per stage `findInertBashStages` returns.

`findInertBashStages` decides from `resolvePermissions(config, stage)` alone: the stage is inert
when the returned `bashApproval` is `"gated"` or `"escalate"` and no entry of `toolGrants` has
`tool === "Bash"`. An absent `toolGrants` counts as an empty list: the fail-closed branch for an
unrecognised `permissionProfile` returns `{ mode, bashApproval: "gated" }` with no `toolGrants`
field (`src/config/permissions.ts:281-282`). That is the same grant list `resolveBashSupport` searches, so the warning and
the tool offer cannot disagree. `BASH_DECLARING_STAGES` mirrors the `stage` field of the nine
operations that declare `Bash`: `implementerOp`, `testWriterOp` (`run`); `rectifyOp` (`review`);
`fullSuiteRectifyOp`, `finishFixOp`, `implementerRectifyOp`, `testWriterRectifyOp`
(`rectification`); `acceptanceFixSourceOp`, `acceptanceFixTestOp` (`acceptance`).

The warning is logged with stage `"permissions"`, and its message names the stage, the mode and
the fix, e.g.
`bashApproval "escalate" on stage "run" grants no Bash (no Bash(...) allow rule) -- the agent is not offered Bash, so nothing can escalate. Add one rule: "allow": ["Bash(ls *, cat *, git status*)"]`.
Its data object carries `{ storyId: "_setup", stage, bashApproval }`, matching the sibling
`warnFallbackMisconfiguration` warning's `storyId: "_setup"`. It is a warning, never an error: `gated`
without a rule is a legitimate "no shell" posture.

`setupRun` (`src/execution/lifecycle/run-setup.ts`) calls `warnInertBashStages(options.config,
logger)` once, next to its existing `warnFallbackMisconfiguration` call.

Documentation, same story:

- `docs/adr/ADR-030-bash-approval-modes.md` — the mode table's `gated` and `escalate` rows state
  that Bash is offered only where a `Bash(...)` allow rule resolves for the stage, with a
  single-expression example `"allow": ["Bash(ls *, cat *, git status*)"]`, and that one
  expression per stage is required (a second `Bash(...)` entry is a config load error).
- `src/config/schemas-execution.ts` — a docblock on the `bashApproval` field stating the same
  requirement with the same example.
- `docs/superpowers/specs/2026-09-22-p2-interactive-approval-gate-design.md` §9 — the exit
  instruction to set `bashApproval: escalate` also adds the `Bash(...)` allow rule.

### Integration

Read-only symbols (verified at `57454e7ab`):

- `screenRawBashCommand(args: RawScreenArgs): BashCheck` — `src/tools/policy-bash-raw.ts`
- `isNaxConfigFile(root: string, resolved: string): boolean` — `src/tools/nax-owned-writes.ts:34`
- `resolveWithin(root: string, candidate: string): string | null` — `src/tools/policy.ts:86`
- `resolveCodingToolSupport({ declaredTools, codingToolRoot, pipelineStage, config })` —
  `src/agents/coding-tool-support.ts`, the production entry exercised by
  `test/unit/agents/coding-tool-support-bash-approval.test.ts`
- `createHumanAskLink(opts: { chain, timeoutMs, featureName?, storyId?, onRemember?, abortSignal? }): HumanAskLink`
  — `src/interaction/ask-link.ts:56`
- `approvalsPath(outputDir)`, `readApprovals(path)` — `src/permissions/approvals-store.ts`
- `NAX_COMMIT: string` — `src/version.ts:42`
- `resolvePermissions(config, stage): ResolvedPermissions` (fields `bashApproval`, `toolGrants`) —
  `src/config/permissions.ts:245`
- `PipelineStage` — `src/config/permissions.ts:20`
- `withWarnSpy` — `test/helpers/warn-spy.ts`, via `@test/helpers`

Symbols this feature changes. The baseline exists only to locate the code; it is never the
interface to implement.

- `protectedHit` (file-local, `src/tools/policy-bash-raw.ts`)
  - Baseline: resolves through `args.resolvePath` first and skips a `null` result.
  - Target: checks `isNaxConfigFile` on the lexical `realOrRaw(resolve(directory, candidate))`
    first, then falls through to the baseline behaviour.
- `_executionDeps` (`src/pipeline/stages/execution.ts:304`)
  - Baseline: no `createHumanAskLink` entry; the stage calls the imported function directly.
  - Target: carries `createHumanAskLink`, and the stage calls it through `_executionDeps`.
- `setupRun` (`src/execution/lifecycle/run-setup.ts`)
  - Baseline: calls `warnFallbackMisconfiguration(options.config, options.agentGetFn, logger)`.
  - Target: additionally calls `warnInertBashStages(options.config, logger)` once.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| A raw Bash command names `.nax/config.json` or `.nax/mono/<pkg>/config.json` | Denied with the existing protected-path reason; the command does not run. |
| `findInertBashStages` receives a config whose `permissionProfile` is outside the schema enum | `resolvePermissions` returns `bashApproval: "gated"` with no `toolGrants`; the absent list counts as empty, so every Bash-declaring stage is reported and nothing throws. |
| A raw Bash command uses substitution the lexer cannot read | Allowed and unscreened, unchanged (the screen is advisory by construction). |

## Out of Scope

- nax#2194 (under `escalate`, Category B checks are skipped for ungranted or unlexable Bash
  commands) is not part of this feature; `checkBashCommand`'s evaluation order is unchanged.
- US-001 only: `resolveWithin` in `src/tools/policy.ts` is not modified; typed tools must keep
  receiving `null` for nax config files.
- US-001 only: the raw screen does not gain `.git/` protection or any containment check; `raw`
  enforces no root containment by design.
- US-001 only: commands the lexer refuses (substitution, heredocs, backticks) stay unscreened; the
  screen is an advisory mistake-catcher, and the OS sandbox is what makes the guarantee airtight.
- US-003 only: the warning reads the root run config only; per-package
  `.nax/mono/<pkg>/config.json` overrides of `bashApproval` or permissions are not inspected.
- US-003 only: op-level `toolPatterns` narrowing is not considered; a stage is inert only when
  its resolved grants contain no `Bash` entry at all.
- US-003 only: an inert stage is never turned into a config error or a run failure.
- Tool-audit `approval.remembered` always being `false` is not part of this feature.
- Tool-result truncation in `src/tools/bash.ts` (nax#2151) is not part of this feature.

## Stories

**US-001 — The raw screen protects nax config files (nax#2189)**
Make `protectedHit` in `src/tools/policy-bash-raw.ts` check `isNaxConfigFile` on the lexically
resolved candidate before calling `resolvePath`, so a raw Bash command naming `.nax/config.json`
or `.nax/mono/<pkg>/config.json` is denied through the production entry, while typed tools keep
their `null` from `resolveWithin`. No dependencies.

**US-002 — Remembered approvals record the real nax commit (nax#2193)**
Add `createHumanAskLink` to `_executionDeps`, call it through that entry, and write
`naxCommit: NAX_COMMIT` in the `onRemember` callback instead of reading the unset
`process.env.NAX_COMMIT`. No dependencies.

**US-003 — Warn when gated or escalate can never offer Bash (nax#2192)**
Create `src/config/inert-bash-stages.ts` with `BASH_DECLARING_STAGES` and `findInertBashStages`,
export them from the `src/config` barrel, add `warnInertBashStages` beside
`warnFallbackMisconfiguration` in `run-setup-warnings.ts`, call it once from `setupRun`, and document the `Bash(...)` rule requirement in ADR-030, the
`bashApproval` schema docblock, and the P2 spec's exit criteria. No dependencies.

### Context Files

**US-001**

- `src/tools/policy-bash-raw.ts` — `protectedHit` and the screen's frame-tracking contract
- `src/tools/nax-owned-writes.ts` — `isNaxConfigFile` and `isNaxOwnedWritePath`
- `src/tools/policy.ts` — `resolveWithin` and the production `resolvePath` callback (read only)
- `test/unit/tools/policy-bash-raw.test.ts` — the existing screen tests and their resolver stub
- `test/unit/agents/coding-tool-support-bash-approval.test.ts` — the production-entry test pattern to follow

**US-002**

- `src/pipeline/stages/execution.ts` — `_executionDeps` and the `onRemember` callback
- `src/interaction/ask-link.ts` — `createHumanAskLink` and its options
- `src/permissions/approvals-store.ts` — `approvalsPath`, `readApprovals`, `ApprovalEntry`
- `src/version.ts` — `NAX_COMMIT`
- `test/unit/pipeline/stages/execution-ask-reachability.test.ts` — the `executionStage.execute` harness to follow

**US-003**

- `src/config/permissions.ts` — `resolvePermissions`, `PipelineStage`, `ResolvedPermissions`
- `src/agents/coding-tool-bash.ts` — `resolveBashSupport`, the grant test the warning must agree with
- `src/execution/lifecycle/run-setup.ts` — `setupRun` and its `warnFallbackMisconfiguration` call site
- `test/unit/execution/lifecycle/run-setup-command-interceptor.test.ts` — the `setupRun` drive harness to follow
- `test/helpers/warn-spy.ts` — `withWarnSpy`

### Creates

**US-001**

- `test/unit/agents/coding-tool-support-raw-protected-config.test.ts` — production-entry tests for the protected config files (`test/unit/agents/coding-tool-support.test.ts` is at 797 of 800 lines)

**US-002**

- `test/unit/pipeline/stages/execution-remember-commit.test.ts` — the `onRemember` commit test

**US-003**

- `src/config/inert-bash-stages.ts` — `BASH_DECLARING_STAGES` and `findInertBashStages`
- `test/unit/config/inert-bash-stages.test.ts` — unit tests for the detection and the stage mirror
- `test/unit/execution/lifecycle/run-setup-warnings-inert-bash.test.ts` — unit tests for `warnInertBashStages`
- `test/unit/execution/lifecycle/run-setup-inert-bash.test.ts` — the `setupRun` seam tests

### Modifies

**US-001**

- `test/unit/tools/policy-bash-raw.test.ts` — may gain cases for the root nax config file and a per-package mono config file; its existing assertions stay valid and must not be weakened.

**US-003**

- `src/config/index.ts` — the barrel must re-export BASH_DECLARING_STAGES and findInertBashStages so the run-setup warnings module imports them through the config barrel.
- `src/execution/lifecycle/run-setup-warnings.ts` — gains `warnInertBashStages(config, logger)` beside `warnFallbackMisconfiguration`; existing warnings are unchanged.
- `src/config/schemas-execution.ts` — the `bashApproval` field gains a docblock stating that under `gated` and `escalate` Bash is offered only where a single `Bash(...)` allow expression resolves for the stage, with the example `"allow": ["Bash(ls *, cat *, git status*)"]`; no schema behaviour changes.
- `docs/adr/ADR-030-bash-approval-modes.md` — the mode table's `gated` and `escalate` rows must state that Bash is offered only where a `Bash(...)` allow rule resolves for the stage, give the single-expression example, and note that a second `Bash(...)` entry in one list is a config load error.
- `docs/superpowers/specs/2026-09-22-p2-interactive-approval-gate-design.md` — §9's instruction to set `bashApproval: escalate` on the P0 baseline corpora must also add the `Bash(...)` allow rule, or the exit run sends no prompts.

### Seams

- `[unit]` replace `_executionDeps.createHumanAskLink` with a recording double; run `executionStage.execute` with the ask-reachability harness; assert the double received an `onRemember` function.
- `[integration]` under `withWarnSpy`, drive the real `setupRun` (as the command-interceptor test does) with an `escalate` config holding no `Bash(...)` rule; assert a warning with stage `"permissions"` naming `"run"` was logged.

## Acceptance Criteria

### US-001 — The raw screen protects nax config files (nax#2189)

- `[unit]` with `bashApproval: "raw"` and `.nax/config.json` pre-written in the root, `runtime.callTool("Bash", { command: "echo x > .nax/config.json" })` on the support returned by `resolveCodingToolSupport` returns `kind: "denied"`.
- `[unit]` after that denied call, the bytes of `.nax/config.json` on disk equal the bytes written before the call.
- `[unit]` with `.nax/mono/packages/app/config.json` pre-written, `callTool("Bash", { command: "echo x > .nax/mono/packages/app/config.json" })` returns `kind: "denied"`.
- `[unit]` after that denied call, the bytes of `.nax/mono/packages/app/config.json` on disk are unchanged.
- `[unit]` `callTool("Bash", { command: "touch .nax/config.json" })` through the same production entry returns `kind: "denied"`.
- `[unit]` `callTool("Bash", { command: "echo x > .nax/features/f1/prd.json" })` through the same production entry still returns `kind: "denied"`.
- `[unit]` `callTool("Bash", { command: "echo hi > ../outside.txt" })` through the same production entry is not denied by the screen, so raw mode still enforces no containment.
- `[unit]` `callTool("Bash", { command: "echo ok > notes.txt" })` through the same production entry returns `kind: "ok"`.
- `[unit]` `resolveWithin(root, join(root, ".nax", "config.json"))` still returns `null`.
- `[unit]` `screenRawBashCommand` with a `resolvePath` that returns `null` for every candidate denies `echo x > .nax/config.json` with a reason naming `.nax/config.json`.

### US-002 — Remembered approvals record the real nax commit (nax#2193)

- `[unit]` with `process.env.NAX_COMMIT` unset, invoking the `onRemember` callback captured from `_executionDeps.createHumanAskLink` during `executionStage.execute` appends an entry to `approvalsPath(ctx.runtime.outputDir)` whose `naxCommit` equals `NAX_COMMIT` from `@/version`.
- `[unit]` that appended entry's `naxCommit` is not the string `"unknown"` when `NAX_COMMIT` is not `"unknown"`.
- `[unit]` that appended entry carries `origin: "escalate"` and the `command` of the `AskRequest` passed to `onRemember`.

### US-003 — Warn when gated or escalate can never offer Bash (nax#2192)

- `[unit]` `findInertBashStages` for a config with `bashApproval: "escalate"`, `permissionProfile: "unrestricted"` and no `permissions` block returns every entry of `BASH_DECLARING_STAGES`.
- `[unit]` `findInertBashStages` for a config with `bashApproval: "escalate"` and `permissions.run.allow` set to `["Bash(ls *)"]` does not include `"run"`.
- `[unit]` `findInertBashStages` for a config with `bashApproval: "gated"` and no `Bash(...)` rule returns every entry of `BASH_DECLARING_STAGES`.
- `[unit]` `findInertBashStages` for a config with `bashApproval: "raw"` returns an empty list.
- `[unit]` `findInertBashStages` for a config with global `bashApproval: "raw"` and `permissions.review.bashApproval` set to `"escalate"` with no `Bash(...)` rule returns exactly `["review"]`.
- `[unit]` `findInertBashStages` never returns a stage outside `BASH_DECLARING_STAGES`, including `"plan"` and `"verify"`, for a `gated` config with no `Bash(...)` rule.
- `[unit]` for a config with `bashApproval: "escalate"` and `permissions.run.allow` set to `["Bash(ls *)"]`, `resolveBashSupport` with `declared: ["Bash"]` and the grants `resolvePermissions(config, "run")` returns yields `allowBash: true` with a Bash grant present, agreeing with `findInertBashStages` excluding `"run"`.
- `[unit]` `findInertBashStages` for a config whose `permissionProfile` is a value outside the schema enum returns every entry of `BASH_DECLARING_STAGES` without throwing.
- `[unit]` the `stage` of each of `implementerOp`, `testWriterOp`, `rectifyOp`, `fullSuiteRectifyOp`, `finishFixOp`, `implementerRectifyOp`, `testWriterRectifyOp`, `acceptanceFixSourceOp` and `acceptanceFixTestOp` is an entry of `BASH_DECLARING_STAGES`.
- `[unit]` `warnInertBashStages` given an `escalate` config with `permissions.run.allow` set to `["Bash(ls *)"]` and a spy logger calls its `warn` exactly three times with stage `"permissions"`, one each for `"review"`, `"rectification"` and `"acceptance"`.
- `[unit]` each such warning's data object carries `storyId: "_setup"`, the inert `stage` and `bashApproval: "escalate"`.
- `[unit]` each such warning's message contains the text `Bash(`, naming the rule that would fix it.
- `[unit]` `warnInertBashStages` given a `raw` config and a spy logger never calls its `warn`.
- `[integration]` under `withWarnSpy`, driving the real `setupRun` with a config of `bashApproval: "escalate"` and no `Bash(...)` rule logs a warning with stage `"permissions"` whose data object carries `stage: "run"`.
- `[integration]` under `withWarnSpy`, driving the real `setupRun` with a config of `bashApproval: "raw"` logs no warning with stage `"permissions"` whose data object carries a `bashApproval` field.
