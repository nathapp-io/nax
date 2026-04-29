# Playbook — migrate review/autofix tests to runtime path (ADR-019 Wave 3)

**Date:** 2026-04-29
**Predecessor:** [2026-04-29 legacy `agentManager.run` cleanup analysis](./2026-04-29-legacy-agentmanager-run-cleanup.md)
**Goal:** migrate the seven test files listed below so each call into `runSemanticReview` / `runAdversarialReview` / `runAgentRectification` / `runTestWriterRectification` exercises the ADR-019 runtime/`callOp` dispatch path. After this playbook is done, the source-cleanup PR can drop the legacy `agentManager.run({ keepOpen: true })` fallback without breaking tests.

This document is the **agent prompt source of truth**. It must stay self-contained so an opencode (or any other agent CLI) run with a cheap model can follow it end-to-end without other context.

---

## TL;DR for humans

- Foundation PR (`chore/adr-019-test-migration-foundation`) introduces `makeMockRuntime` and migrates two reference test files. All tests stay green.
- This playbook describes how a remote agent migrates the remaining 7 files.
- After the migration PR lands, a small cleanup PR drops the legacy code path in `src/review/{semantic,adversarial}.ts` and `src/pipeline/stages/autofix-{agent,adversarial}.ts`.

---

## Context the agent needs

`nax` is a Bun + TypeScript project. It runs tests via `bun test`. ADR-019 migrated review and autofix dispatch to flow through a `NaxRuntime` (`callOp` → `runWithFallback` → `buildHopCallback` → `openSession` + `runAsSession`). The legacy code path used `agentManager.run({ keepOpen: true })` — that path is being removed.

Some tests still exercise the legacy path because they pass `agentManager` only and not `runtime`. This playbook adds a `runtime` parameter (or threads it through the test's `makeCtx` helper) so those tests run via the new path.

A new helper `makeMockRuntime` (in `test/helpers/runtime.ts`) builds a NaxRuntime suitable for unit tests:

```ts
import { makeMockRuntime } from "../../helpers";

const runtime = makeMockRuntime({ agentManager });   // wraps an existing agent-manager mock
```

`makeMockRuntime` accepts `{ agentManager?, sessionManager?, config?, workdir? }` and returns a real `NaxRuntime` built around the provided mocks via `createRuntime`. Always pass `agentManager` so the runtime's dispatch flows through the same mock the test set up.

---

## File list (the agent's whole job)

These seven files have tests that currently fail when the legacy path is removed. Process them in any order. Two reference files have already been migrated and serve as patterns; do not edit them.

### Reference migrations (DO NOT EDIT — copy patterns from these)

- `test/unit/review/semantic-parsing.test.ts` — pattern **T2-review**: hoist `agentManager`, build `runtime`, pass at the last positional slot.
- `test/unit/pipeline/stages/autofix-routing.test.ts` — pattern **T2-pipeline**: modify the file's `makeCtx()` helper to derive `runtime` from `overrides.agentManager`.

### Files to migrate

1. `test/unit/review/adversarial-pass-fail.test.ts` — apply T2-review.
2. `test/unit/review/semantic-agent-session.test.ts` — apply T2-review.
3. `test/unit/review/semantic-debate.test.ts` — apply T2-review.
4. `test/unit/review/semantic-findings.test.ts` — apply T2-review.
5. `test/unit/review/semantic-signature-diff.test.ts` — apply T2-review.
6. `test/unit/pipeline/stages/autofix-adversarial.test.ts` — apply T2-pipeline.
7. `test/unit/pipeline/stages/autofix-budget-prompts.test.ts` — apply T2-pipeline.

For each file: target failures only. If a file's tests already pass against the source-cleanup branch, mark it done and move on.

---

## Decision rule

For each file, look at how it calls `runSemanticReview`, `runAdversarialReview`, or any pipeline stage that goes through `runAgentRectification` / `runTestWriterRectification`:

| Shape of test | Pattern |
|:---|:---|
| Direct call to `runSemanticReview(...)` / `runAdversarialReview(...)` with positional args | **T2-review** |
| Test calls `autofixStage.execute(ctx)` or similar pipeline stage with a custom `makeCtx()` helper in the file | **T2-pipeline** |

If both shapes exist in one file: apply T2-pipeline first (helper change covers most usages), then T2-review for any residual direct calls.

---

## Pattern T2-review — direct review-function calls

### Step 1 — add the import

In the test file's import block, add `makeMockRuntime`:

```ts
import { makeMockAgentManager, makeMockRuntime, /* ...existing helpers... */ } from "../../helpers";
```

### Step 2 — hoist `agentManager`, build runtime, pass it

Replace each call to `runSemanticReview(... makeAgentManager(response))` with a call that passes both an `agentManager` and a `runtime`. Reference (from `semantic-parsing.test.ts`):

```ts
async function callRunSemanticReview(response: string) {
  const agentManager = makeAgentManager(response);
  const runtime = makeMockRuntime({ agentManager });
  return runSemanticReview(
    "/tmp/wd",
    "abc123",
    STORY,
    CONFIG,
    agentManager,
    undefined, // naxConfig
    undefined, // featureName
    undefined, // resolverSession
    undefined, // priorFailures
    undefined, // blockingThreshold
    undefined, // featureContextMarkdown
    undefined, // contextBundle
    undefined, // projectDir
    undefined, // naxIgnoreIndex
    runtime,
  );
}
```

The `runtime` parameter is the **15th positional argument** for `runSemanticReview` and the **15th positional argument** for `runAdversarialReview` (after `naxIgnoreIndex`, before `priorAdversarialFindings` for adversarial — check the actual signature in `src/review/{semantic,adversarial}.ts` if unclear).

If the file already extracts `agentManager` into a variable, you only need to add the `runtime` line and pass it as the last arg.

### Step 3 — verify

Run: `timeout 30 bun test <file> --timeout=10000`

If 0 fail: done. Commit. Move to next file.

If still failing: see "If a file resists the pattern" below.

---

## Pattern T2-pipeline — pipeline-stage tests with `makeCtx()` helper

### Step 1 — add the import

```ts
import { makeMockAgentManager, makeMockRuntime, /* ...existing helpers... */ } from "../../helpers";
```

### Step 2 — modify the file's `makeCtx()` helper

Find the local `makeCtx(overrides: Partial<PipelineContext>)` function in the file (commonly near the top). Extract `agentManager` once and derive `runtime` from it. Reference (from `autofix-routing.test.ts`):

```ts
function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  // ADR-019: derive runtime from agentManager so callOp dispatch flows through
  // the same mock the test set up. Override `runtime` explicitly when a test
  // needs a different shape.
  const agentManager = overrides.agentManager ?? makeMockAgentManager();
  return {
    // ...existing fields...
    agentManager,
    runtime: overrides.runtime ?? makeMockRuntime({ agentManager }),
    ...overrides,
  };
}
```

The two key changes:
- Hoist `agentManager` so the same instance can be reused.
- Add `runtime: overrides.runtime ?? makeMockRuntime({ agentManager })`.

If the file's `makeCtx` already uses `makeMockAgentManager()` inline, you can keep that call but assign the result to a `const agentManager =` first.

### Step 3 — verify

Run: `timeout 30 bun test <file> --timeout=10000`

If 0 fail: done. Commit. Move to next file.

If still failing: see "If a file resists the pattern" below.

---

## If a file resists the pattern

Some failures need extra care. The fallback is:

1. `git restore <file>` (revert your changes).
2. Append to `quarantine.md` at repo root, with format:
   ```
   ## <file>
   - Reason: <one-line summary of what didn't work>
   - First failing test: <name>
   - Last error line: <copy-paste>
   ```
3. Mark the file as `[~] <file>` in the progress tracker.
4. Move to next file.

A human will handle quarantined files after the batch.

---

## Workflow rules (the agent must follow)

1. Make a working branch off `main` (or off the foundation PR's merge once it lands): `chore/adr-019-test-migration-batch`.
2. Apply the source-cleanup commits *first* so legacy code is removed and the failing tests are visible (see "Bootstrap" below).
3. Process the file list in order. One file at a time.
4. For each file:
   - Run `timeout 30 bun test <file> --timeout=10000`.
   - If 0 fail: tick `[x]` in `migration-progress.md`, do NOT commit (no change), continue.
   - If failing: apply T2-review or T2-pipeline per decision rule, re-run, then commit on success or quarantine on failure.
5. After all files: run `bun run test` (full suite). Append result to `migration-progress.md`.
6. **STOP. Do NOT push. Do NOT call `gh pr create`. A human reviews and pushes.**

### Boundaries

The agent must NEVER edit files outside:
- The test file currently being migrated.
- `migration-progress.md`
- `quarantine.md`

The agent must NEVER call:
- `git push`
- `gh pr create` / `gh pr edit`
- Any network command except `bun install` (only if the install is missing — should not happen).

### Verification commands

| Purpose | Command |
|:---|:---|
| Test one file | `timeout 30 bun test <file> --timeout=10000` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Full test suite | `bun run test` |

If `bun run lint` fails with formatting errors after editing, run `bun run lint:fix` and commit the formatting changes.

---

## Bootstrap (run once before processing files)

The agent is expected to start on a branch where the legacy code has been removed so failures are visible. Bootstrap commands:

```bash
# Foundation must already be merged into main (or available on the foundation branch).
git fetch origin
git checkout main
git pull
git checkout -b chore/adr-019-test-migration-batch

# Apply the source-cleanup patches. These four files have one mechanical change:
# replace the `if (runtime) { ... } else { legacy ... }` with `if (!runtime) throw NaxError; ...`
# Pre-prepared patches live at scripts/adr-019-source-cleanup.patch — apply them:
git apply scripts/adr-019-source-cleanup.patch

# Sanity check: the bootstrap should leave the working tree dirty in 4 src/ files.
git status -s | wc -l   # expect 4

# Verify failures are visible
timeout 60 bun test test/unit/review/adversarial-pass-fail.test.ts --timeout=10000
# Expect ~13 fail with "DISPATCH_NO_RUNTIME"
```

If the patch does not apply cleanly, stop and write `quarantine.md` with the apply error.

---

## Progress tracker (the agent maintains this)

Create `migration-progress.md` at repo root with this initial content:

```markdown
# ADR-019 test migration progress

Started: <ISO timestamp>
Branch: chore/adr-019-test-migration-batch

## Files

- [ ] test/unit/review/adversarial-pass-fail.test.ts  (T2-review)
- [ ] test/unit/review/semantic-agent-session.test.ts (T2-review)
- [ ] test/unit/review/semantic-debate.test.ts        (T2-review)
- [ ] test/unit/review/semantic-findings.test.ts      (T2-review)
- [ ] test/unit/review/semantic-signature-diff.test.ts (T2-review)
- [ ] test/unit/pipeline/stages/autofix-adversarial.test.ts (T2-pipeline)
- [ ] test/unit/pipeline/stages/autofix-budget-prompts.test.ts (T2-pipeline)

## Final suite result
(populated when done)
```

After each file: tick `[x]` for success, `[~]` for quarantine, leave `[ ]` if skipped.

---

## Agent Prompt

Copy the section between the fences below and feed it to opencode.

```
You are migrating TypeScript test files in a Bun+TS project. The repo at the
current working directory is `nax`. Your goal: migrate seven specific test
files so they pass after the legacy `agentManager.run({ keepOpen: true })`
code path is removed.

Read this entire file BEFORE starting:
docs/findings/2026-04-29-legacy-run-test-migration-playbook.md

Specifically follow:
1. The "Bootstrap" section to set up the working branch and apply patches.
2. The "File list" section for the queue of files.
3. The "Decision rule" + "Pattern T2-review" / "Pattern T2-pipeline" sections
   for how to migrate each file.
4. The "Workflow rules" section for invariants — DO NOT push, DO NOT open PRs,
   DO NOT edit files outside the file currently being migrated +
   migration-progress.md + quarantine.md.

For each file in the queue:
  1. Run: timeout 30 bun test <file> --timeout=10000
  2. If exit 0: tick [x] in migration-progress.md, continue. Do NOT commit.
  3. If failing:
     a. Determine pattern (T2-review or T2-pipeline) using the Decision Rule.
     b. Apply the pattern by editing the test file. Use the Reference
        migrations as templates (semantic-parsing.test.ts and
        autofix-routing.test.ts).
     c. Re-run: timeout 30 bun test <file> --timeout=10000
     d. If exit 0: git add the file + migration-progress.md, commit with
        message "test: migrate <file> to runtime path (ADR-019 T2-review)" or
        "T2-pipeline" as appropriate. Continue.
     e. If still failing: git restore <file>, append to quarantine.md, tick
        [~] in migration-progress.md, continue.

After the last file:
  - Run: bun run test
  - Append the pass/fail counts to migration-progress.md.
  - Run: bun run typecheck
  - Run: bun run lint   (if it fails on formatting, run bun run lint:fix and
    commit the formatting fix as a separate commit).
  - Stop. Do NOT push. Do NOT open a PR. A human will review.

NEVER use git push, gh, or any network command.
NEVER edit src/ files.
NEVER edit docs/ files.
NEVER edit any test file other than the one currently being migrated.

If you get stuck or hit anything ambiguous, write the situation to
quarantine.md with full context and move on. Do not invent fixes.
```

---

## Acceptance criteria for the migration PR

- [ ] All seven listed test files migrated or quarantined.
- [ ] `bun run test` passes (any quarantined files left as-is, with their tests still passing on legacy path).
- [ ] `bun run typecheck` clean.
- [ ] `bun run lint` clean.
- [ ] `migration-progress.md` and `quarantine.md` checked in at repo root.
- [ ] No edits outside `test/unit/**/*.test.ts`, `migration-progress.md`, `quarantine.md`.
- [ ] No `git push` / no PR opened by the agent.
