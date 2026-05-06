# Issue 928 Plan: Self-Verification Gates Across Execution Strategies

## Context

Issue #928 proposes a self-verification gate so coding agents catch lint and typecheck-class mistakes before handing control back to nax. nax already has hard lint/typecheck enforcement in the review stage; this issue is about moving obvious failures earlier, into the agent handoff, so they do not cost a full review/autofix or rectification round. The first pass at this plan only covered the three-session TDD roles (`test-writer` and `implementer`). That is incomplete.

nax currently has two execution families:

| Family | `testStrategy` values | Runtime path | Prompt role |
|---|---|---|---|
| Three-session TDD | `three-session-tdd`, `three-session-tdd-lite` | `executionStage` -> `runThreeSessionTddFromCtx()` -> `runTddSessionOp()` -> `runTddSession()` | `test-writer`, `implementer`, `verifier` |
| Single-session | `no-test`, `test-after`, `tdd-simple` | `promptStage` builds one prompt, then `executionStage` runs one agent session | `no-test` for no-test stories; currently `tdd-simple` for both `test-after` and `tdd-simple` |

There is also a `PromptRole: "single-session"` and a `buildRoleTaskSection("single-session")` template, but the current pipeline path does not use that prompt role for single-story runtime execution. It remains supported by prompt export, overrides, tests, and historical compatibility. Runtime single-session strategies are represented by `no-test`, `test-after`, and `tdd-simple`.

`test-after` and `tdd-simple` can share the `tdd-simple` prompt role. `no-test` must stay on the dedicated `no-test` prompt role because it explicitly means no behavioral test creation or modification. Its self-verification gate is still useful, but only for static checks on whatever non-test files the story legitimately changed.

## Relevant Code

- `src/pipeline/stages/execution.ts`
  - branches `three-session-tdd` and `three-session-tdd-lite` into `runThreeSessionTddFromCtx()`
  - all other strategies use the one-session path with `ctx.prompt`
  - single-session agent runs use `sessionRole: "implementer"`
- `src/pipeline/stages/prompt.ts`
  - disabled for three-session TDD
  - builds prompts for `no-test`, `test-after`, `tdd-simple`, and batch
  - currently maps `test-after` and `tdd-simple` to `PromptBuilder.for("tdd-simple")`
- `src/tdd/session-runner.ts`
  - builds the three TDD role prompts internally
  - already computes `filesChanged` from `git diff` after each role
  - records `TddSessionResult` for scratch through `recordTddSessionOutcome`
- `src/tdd/orchestrator-ctx.ts`
  - writes per-role TDD scratch entries when context v2 is enabled
- `src/test-runners/resolver.ts`
  - exports `findPackageDir(filePath, workdir)` for monorepo package boundary detection
- `src/project/detector.ts`
  - exports `detectLanguage(packageDir)`
- `src/quality/runner.ts`
  - shared process runner for configured quality commands
- `src/quality/command-resolver.ts`
  - currently resolves test commands only; lint/typecheck self-verification needs a sibling resolver
- `src/review/runner.ts`
  - already resolves and runs configured lint/typecheck/build/test review checks as hard quality gates
  - #928 must not duplicate review ownership; it should reduce avoidable failures before review runs

## Design Goal

Add a self-verification contract once, then wire it into every agent role that creates or modifies code or tests:

- three-session TDD `test-writer`
- three-session TDD `implementer`
- single-session `no-test` for lint/typecheck only, not test execution or test creation
- single-session `test-after`
- single-session `tdd-simple`
- batch implementer, because batch sessions also create code and tests

Do not add this gate to the three-session `verifier`. The verifier should inspect and report. It should not be asked to fix its own diff.

This is an early feedback mechanism, not the authoritative quality gate. The review stage remains the hard enforcement point for configured lint/typecheck checks.

## Key Decision

Use a two-layer design:

1. Prompt-level self-verification instructions tell the agent what it must run before declaring completion.
2. Harness-level parsing and logging records the result, especially `PRE_EXISTING_FAILURES`, so downstream stages can distinguish "my changed file failed" from "unrelated existing debt".

Do not rely only on prompt text. The prompt tells the agent what to do, but nax should parse and surface the declared outcome in structured run state.

## Scope Rules

`CHANGED` means files created or modified by the current agent turn, scoped to the current package.

For three-session TDD, `runTddSession()` already receives `beforeRef` for the specific TDD role and calls `getChangedFiles(workdir, beforeRef)` after the role completes. This is the right baseline for `CHANGED`.

For single-session execution, use `ctx.storyGitRef` when present, falling back to the captured pre-execution ref used by the existing pipeline. The execution stage already auto-commits after a successful single-session run, so parsing must happen before any future cleanup mutates the visible output. Changed-file calculation can happen after the run, before or near the existing `autoCommitIfDirty()` call.

For monorepos, bucket changed files with `findPackageDir(file, ctx.projectDir)` or the appropriate repo root for the active worktree. Do not use naive path prefixes. If the current story has `story.workdir`, only files resolving to that package should be considered in-scope for that story. Other packages should become pre-existing or cross-package contamination notes, not blockers for the current story.

## Command Resolution

Create a new quality resolver, for example `src/quality/self-verification-resolver.ts`.

Responsibilities:

- Accept effective story config, repo root, package dir, role/strategy, and changed files.
- Resolve the active package with `findPackageDir`.
- Detect language with `detectLanguage(packageDir)`.
- Read configured commands from `config.quality.commands.lint` and `config.quality.commands.typecheck`.
- Do not hard-code tool names in the prompt.
- Return a structured plan:

```ts
interface SelfVerificationPlan {
  packageDir: string;
  language?: string;
  changedFiles: string[];
  lint?: {
    command: string;
    scope: "changed-files";
    files: string[];
  };
  typecheck?: {
    command: string;
    scope: "package" | "changed-files";
  };
  skipped: Array<{
    tool: "lint" | "typecheck";
    reason: "unconfigured" | "no-changed-files" | "unsupported-scope";
  }>;
}
```

The first implementation can be conservative:

- lint: changed-file scoped when a lint command is configured and changed files exist
- typecheck: package scoped when a typecheck command is configured
- no config: skip with an explicit logged note

Future language-specific changed-file typecheck support can extend the resolver without changing prompt call sites.

## Prompt Section

Add `src/prompts/sections/self-verification.ts` with a pure builder:

```ts
export function buildSelfVerificationSection(input: SelfVerificationPromptInput): string;
```

Inject it in `TddPromptBuilder.build()` after hermetic/isolation rules and before context/conventions. This is late enough to be operationally visible but still before the final story reminder.

Roles receiving the section:

- `test-writer`
- `implementer`
- `no-test`
- `tdd-simple`
- `single-session`
- `batch`

Roles not receiving it:

- `verifier`

The section should tell the agent:

- compute or inspect the changed files for this turn
- run the configured lint and typecheck gates if present
- fix failures in changed files
- do not modify unrelated files
- if a configured check fails only outside changed files, emit `PRE_EXISTING_FAILURES`
- if a gate is unconfigured, emit skip status rather than failing
- end with a strict marker block:

```text
SELF_VERIFICATION:
lint: pass|skip|pre_existing|fail
typecheck: pass|skip|pre_existing|fail
PRE_EXISTING_FAILURES: []
```

The prompt should include command labels and scope, not language/tool brand names. If commands are missing, it should explicitly say the gate is skipped because it is unconfigured.

## Three-Session TDD Wiring

Update `runTddSession()` in `src/tdd/session-runner.ts`.

Build-time:

- pass self-verification prompt input to `PromptBuilder.for("test-writer")`
- pass self-verification prompt input to `PromptBuilder.for("implementer")`
- do not pass it to `PromptBuilder.for("verifier")`

Run-result handling:

- parse `result.output` for `SELF_VERIFICATION`
- include parsed data on `TddSessionResult`
- keep `success` behavior conservative:
  - if the agent explicitly reports `fail` for lint/typecheck on changed files, mark the session unsuccessful or attach a failure category that routes to rectification
  - if it reports `pre_existing`, keep the session result successful but surface the data
  - if no marker appears, initially warn rather than hard-fail behind a feature flag

Scratch:

- extend `TddSessionScratchEntry` with optional `selfVerification`
- write parsed `PRE_EXISTING_FAILURES` through the existing scratch path in `src/tdd/orchestrator-ctx.ts`

## Single-Session Wiring

Update `promptStage` and `executionStage`.

Prompt build:

- `no-test`: inject the section into `PromptBuilder.for("no-test")`, with wording that preserves the no-tests contract and only asks for configured static checks
- `test-after`: inject the section into the current runtime prompt role, which is `PromptBuilder.for("tdd-simple")`
- `tdd-simple`: inject the section into `PromptBuilder.for("tdd-simple")`
- batch: inject the section into `PromptBuilder.for("batch")`

Execution result:

- parse `ctx.agentResult.output`
- store parsed result on `ctx.selfVerification` or a similar new `PipelineContext` field
- append to the main session scratch entry when context v2 is enabled
- log `PRE_EXISTING_FAILURES` as a separate structured field, not as a story failure

Important: `test-after` and `tdd-simple` currently share the `tdd-simple` prompt role, and that is acceptable for this issue. `no-test` should not share that role because it must not receive RED-phase or test-writing instructions.

## Data Types

Add shared types, likely in `src/quality/self-verification.ts` or `src/quality/types.ts`:

```ts
export type SelfVerificationTool = "lint" | "typecheck";
export type SelfVerificationStatus = "pass" | "skip" | "pre_existing" | "fail";

export interface PreExistingFailure {
  packageDir: string;
  file?: string;
  tool: SelfVerificationTool;
  message: string;
}

export interface SelfVerificationResult {
  lint: SelfVerificationStatus;
  typecheck: SelfVerificationStatus;
  preExistingFailures: PreExistingFailure[];
  rawMarker?: string;
  missingMarker?: boolean;
}
```

Add:

- `TddSessionResult.selfVerification?: SelfVerificationResult`
- `PipelineContext.selfVerification?: SelfVerificationResult`
- `TddSessionScratchEntry.selfVerification?: SelfVerificationResult`
- a new scratch entry kind for single-session execution if the existing scratch model does not already have an execution-session entry

## Parser

Add `parseSelfVerificationMarker(output: string): SelfVerificationResult`.

Keep the parser permissive enough for real agent output:

- find the last `SELF_VERIFICATION:` block
- parse `lint:` and `typecheck:` statuses case-insensitively
- parse `PRE_EXISTING_FAILURES:` as JSON when possible
- if JSON parsing fails, preserve the raw line as a message under `preExistingFailures`
- if no marker exists, return `{ missingMarker: true, lint: "skip", typecheck: "skip", preExistingFailures: [] }` and let rollout policy decide warning vs failure

## Rollout Policy

Use a feature flag or config option for enforcement. Suggested default for first release:

- inject prompt section by default when commands are configured
- parse and log always
- warn on missing marker
- do not hard-fail missing marker until at least one release has prompt-audit data
- hard-fail only explicit `fail` on changed files
- never hard-fail `pre_existing`

This avoids destabilizing runs while still collecting enough data to tune the marker format.

## Tests

Unit tests:

- `test/unit/prompts/sections/self-verification.test.ts`
  - renders configured lint and typecheck
  - renders skip path when unconfigured
  - does not name hard-coded tool brands
  - includes strict marker format
- `test/unit/prompts/builders/tdd-builder.test.ts`
  - includes section for `test-writer`
  - includes section for `implementer`
  - includes section for `no-test`
  - includes section for `tdd-simple`
  - includes section for `batch`
  - excludes section for `verifier`
- `test/unit/quality/self-verification-resolver.test.ts`
  - single repo changed files
  - monorepo same-package changed files
  - monorepo cross-package contamination
  - skip when lint/typecheck commands are absent
- `test/unit/quality/self-verification-parser.test.ts`
  - parses pass/skip/fail/pre_existing
  - parses JSON `PRE_EXISTING_FAILURES`
  - handles malformed JSON without throwing
  - handles missing marker
- `test/unit/tdd/session-runner.test.ts`
  - test-writer result includes parsed self-verification
  - implementer result includes parsed self-verification
  - verifier does not require marker
- `test/unit/pipeline/stages/prompt-tdd-simple.test.ts`
  - `test-after` prompt includes the section through the current `tdd-simple` role
  - `tdd-simple` prompt includes the section
  - `no-test` prompt includes the static-check section without test-writing or test-running instructions
- `test/unit/pipeline/stages/execution-tdd-simple.test.ts`
  - single-session execution parses and stores the marker
  - explicit changed-file failure escalates or fails according to the rollout policy
  - pre-existing failure logs but continues

Integration tests:

- one single-package fixture with configured lint/typecheck
- one monorepo fixture with two packages where package B has lint debt and package A is the active story
- one three-session-lite fixture where test-writer creates a source stub and self-verification is scoped to that role's changed files

## Documentation

Update `docs/architecture/subsystems.md` under:

- TDD orchestration
- Prompt / execution strategy descriptions
- Review and quality subsystem notes

The docs should say:

- self-verification is an agent-turn handoff contract
- it is not a replacement for review, verify, or autofix
- review remains the hard lint/typecheck enforcement stage
- `PRE_EXISTING_FAILURES` is observability, not a story failure
- lint/typecheck command names come from config, not hard-coded prompt text

## Decisions

1. `test-after` continues to use the `tdd-simple` prompt role for #928.
   - This is accepted. `test-after` and `tdd-simple` can share self-verification wording.
   - `no-test` remains separate and must not receive test-writing or RED-phase instructions.
2. Missing `SELF_VERIFICATION` marker warns first.
   - Do not hard-fail a story only because the agent omitted the marker in the first implementation.
   - Log the missing marker as structured observability so prompt compliance can be measured before enforcement.
3. nax does not add a second post-agent harness-run gate in the first #928 slice.
   - "Post-agent verification" would mean nax itself runs lint/typecheck after the agent returns, using the same `CHANGED` scope, regardless of whether the agent claims it already ran them.
   - nax already runs hard lint/typecheck checks in the review stage, so adding another immediate harness-run gate would duplicate enforcement unless it also solved story-scoped filtering.
   - A separate story-scoped harness gate overlaps with #931 because it needs robust changed-file/package scoping and cross-package contamination handling.
   - For #928, implement prompt self-verification plus structured parsing/logging. Review remains the hard quality gate.

## Proposed Implementation Order

1. Add shared self-verification types and parser.
2. Add resolver for package/language/config scoped self-verification prompt input.
3. Add prompt section and inject it into all non-verifier roles.
4. Wire three-session TDD parsing and scratch output.
5. Wire single-session parsing and pipeline context output.
6. Add tests for prompt coverage, parser, resolver, and strategy wiring.
7. Update architecture docs.
