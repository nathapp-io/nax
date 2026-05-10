# mock-structure-handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth `TEST_EDIT_REASON` escape valve (`mock_structure`) that lets the autofix implementer declare a structural test-rewrite handoff instead of emitting `UNRESOLVED` and triggering wasteful tier escalation.

**Architecture:** Extend the existing `TestEditDeclaration` union and parser (US-001). Add an async filesystem validator + synthetic-finding synthesis in autofix-cycle.ts (US-002). Add prompt Exception 4 and `mock-restructure` rendering mode (US-003). Wire the side-channel from `validate()` through `buildAutofixStrategies` to the test-writer op (US-004). Add post-commit safety guards and the `enforceTestWriterIsolation` config flag (US-005).

**Tech Stack:** Bun + TypeScript strict, `bun:test`, Zod schemas

---

## Dependency Chain

- US-001 (parser) → US-002 (validator + side-channel) → US-004 (strategy wiring) → US-005 (guards + config)
- US-003 (prompts) is independent; run in parallel with US-001/US-002

---

## File Map

| File | Purpose |
|:-----|:--------|
| `src/operations/test-edit-declaration.ts` | Extend `TestEditDeclaration` + `parseTestEditDeclarations` |
| `src/findings/types.ts` | Add `"implementer-handoff"` to `FindingSource` union |
| `src/pipeline/types.ts` | Add `pendingMockStructureHandoffs` to `PipelineContext` |
| `src/pipeline/stages/autofix-cycle.ts` | Add `validateMockStructureFiles`, extend `validate()`, extend `applyTestEditDeclarations` |
| `src/prompts/builders/rectifier-builder-helpers.ts` | Add Exception 4 to `CONTRADICTION_ESCAPE_HATCH` |
| `src/prompts/builders/rectifier-builder.ts` | Add `_testWriterMockRestructure`, extend `testWriterRectification` dispatch |
| `src/operations/autofix-test-writer.ts` | Extend `AutofixTestWriterInput` + extend `build` |
| `src/pipeline/stages/autofix-guards.ts` | **NEW** — `assertionSiteDiffCheck`, `runIsolationGuard`, `revertDiff` |
| `src/config/schemas-execution.ts` | Add `enforceTestWriterIsolation` to autofix Zod schema |
| `src/config/schemas.ts` | Add `enforceTestWriterIsolation: true` to autofix default literal |
| `src/config/runtime-types.ts` | Add `enforceTestWriterIsolation?` to autofix interface |

---

## Task 1: US-001 — Parse `mock_structure` declarations

**Files:**
- Modify: `src/operations/test-edit-declaration.ts`
- Test: `test/unit/operations/test-edit-declaration.test.ts`

- [ ] **Step 1: Read the existing file to understand current REASON_RE and block parsing**

Read `src/operations/test-edit-declaration.ts` lines 1–119.

- [ ] **Step 2: Write the failing test — mock_structure block parsing**

Add to `test/unit/operations/test-edit-declaration.test.ts`:

```typescript
describe("mock_structure", () => {
  it("parses a well-formed mock_structure block", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts, test/bar.test.ts
REASON: The mocks reference runAs but new code dispatches via runWithFallback`;

    const decls = parseTestEditDeclarations(output);
    expect(decls).toHaveLength(1);
    expect(decls[0].reason).toBe("mock_structure");
    expect(decls[0].file).toBe("test/foo.test.ts");
    expect(decls[0].files).toEqual(["test/foo.test.ts", "test/bar.test.ts"]);
    expect(decls[0].reasonDetail).toBe("The mocks reference runAs but new code dispatches via runWithFallback");
  });

  it("drops block with empty FILES", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES:
REASON: some reason`;
    expect(parseTestEditDeclarations(output)).toHaveLength(0);
  });

  it("drops block with missing FILES", () => {
    const output = `TEST_EDIT_REASON: mock_structure
REASON: some reason`;
    expect(parseTestEditDeclarations(output)).toHaveLength(0);
  });

  it("drops block with missing REASON", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts`;
    expect(parseTestEditDeclarations(output)).toHaveLength(0);
  });

  it("drops block with empty REASON", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts
REASON:`;
    expect(parseTestEditDeclarations(output)).toHaveLength(0);
  });

  it("trims whitespace around comma-separated FILES entries", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts ,  test/bar.test.ts
REASON: the reason`;
    const decls = parseTestEditDeclarations(output);
    expect(decls[0].files).toEqual(["test/foo.test.ts", "test/bar.test.ts"]);
  });

  it("coexists with prd_contract block in same output", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts
REASON: mock restructure

TEST_EDIT_REASON: prd_contract
FILE: test/bar.test.ts
PRD_QUOTE: "const x = 1"
TEST_BEFORE: const x = 1
TEST_AFTER: const x = 2`;
    const decls = parseTestEditDeclarations(output);
    expect(decls).toHaveLength(2);
    expect(decls[0].reason).toBe("mock_structure");
    expect(decls[1].reason).toBe("prd_contract");
  });
});
```

Run: `timeout 30 bun test test/unit/operations/test-edit-declaration.test.ts --timeout=5000`
Expected: FAIL — `reasonDetail`, `files` not yet in type

- [ ] **Step 3: Extend REASON_RE regex in test-edit-declaration.ts**

Change line 27 from:
```typescript
const REASON_RE = /^TEST_EDIT_REASON:\s*(prd_contract|lint_only|sibling_scope)\s*$/m;
```
To:
```typescript
const REASON_RE = /^TEST_EDIT_REASON:\s*(prd_contract|lint_only|sibling_scope|mock_structure)\s*$/m;
```

- [ ] **Step 4: Extend TestEditDeclaration interface**

Change the interface from:
```typescript
export interface TestEditDeclaration {
  reason: "prd_contract" | "lint_only" | "sibling_scope";
  file: string;
  prdQuote?: string;
  testBefore?: string;
  testAfter?: string;
  finding?: string;
}
```
To:
```typescript
export interface TestEditDeclaration {
  reason: "prd_contract" | "lint_only" | "sibling_scope" | "mock_structure";
  file: string;
  prdQuote?: string;
  testBefore?: string;
  testAfter?: string;
  finding?: string;
  /** mock_structure only — full file list including `file`. */
  files?: string[];
  /** mock_structure only — REASON paragraph verbatim. */
  reasonDetail?: string;
}
```

- [ ] **Step 5: Add mock_structure block parsing branch**

In `parseTestEditDeclarations`, after the `sibling_scope` branch (around line 88), add:
```typescript
} else if (reason === "mock_structure") {
  const rawFiles = readBlockField(block, "FILES");
  const reasonDetail = readBlockField(block, "REASON");
  if (!rawFiles || !reasonDetail) continue;
  const files = rawFiles.split(",").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) continue;
  result.push({ reason, file: files[0], files, reasonDetail });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/operations/test-edit-declaration.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/operations/test-edit-declaration.ts test/unit/operations/test-edit-declaration.test.ts
git commit -m "feat(parser): add mock_structure TEST_EDIT_REASON declaration (US-001)"
```

---

## Task 2: US-002 — Validate FILES, synthesize virtual findings, stash side-channel

**Files:**
- Modify: `src/findings/types.ts` — add `"implementer-handoff"` to `FindingSource`
- Modify: `src/pipeline/types.ts` — add `pendingMockStructureHandoffs` field
- Modify: `src/pipeline/stages/autofix-cycle.ts` — add `validateMockStructureFiles`, extend `applyTestEditDeclarations`, extend `validate()`
- Test: `test/unit/pipeline/stages/autofix-cycle.test.ts`

- [ ] **Step 1: Read findings/types.ts FindingSource**

Read `src/findings/types.ts` — find the `FindingSource` type definition (around lines 87–100).

- [ ] **Step 2: Add implementer-handoff to FindingSource**

Add `"implementer-handoff"` to the `FindingSource` union in `src/findings/types.ts`.

- [ ] **Step 3: Read autofix-cycle.ts applyTestEditDeclarations + validate()**

Read `src/pipeline/stages/autofix-cycle.ts` lines 265–414 (the `applyTestEditDeclarations` function and `runAgentRectificationV2`).

- [ ] **Step 4: Read test-runners/resolver.ts resolveTestFilePatterns**

Read `src/test-runners/resolver.ts` — find `resolveTestFilePatterns` signature.

- [ ] **Step 5: Read pipeline/types.ts PipelineContext**

Read `src/pipeline/types.ts` lines 63–259 to see `PipelineContext` interface.

- [ ] **Step 6: Add pendingMockStructureHandoffs to PipelineContext**

Add to the `PipelineContext` interface in `src/pipeline/types.ts`:
```typescript
/**
 * Mock-structure handoffs synthesized by validate() and consumed by the
 * test-writer strategy's buildInput. One-shot — cleared on consumption.
 */
pendingMockStructureHandoffs?: { files: string[]; reasonDetail: string }[];
```

- [ ] **Step 7: Write failing tests for validateMockStructureFiles**

Add to `test/unit/pipeline/stages/autofix-cycle.test.ts`:
```typescript
describe("validateMockStructureFiles", () => {
  async function fakeResolvePatterns(patterns: string[]): Promise<ResolvedTestPatterns> {
    return {
      globs: [],
      pathspec: patterns,
      regex: patterns.map((p) => new RegExp(p.replace(/\./g, "\\.").replace(/\*\*/g, ".*"))),
      testDirs: [],
    };
  }

  it("returns valid mock_structure decl when all paths exist and are test files", async () => {
    // Use a temp dir with a real test file
  });

  it("partitions invalid mock_structure decl with missing paths", async () => {
    // ...
  });

  it("passes through non-mock_structure declarations unchanged", async () => {
    // ...
  });
});
```

Run: tests fail (function not yet defined)

- [ ] **Step 8: Implement validateMockStructureFiles**

Add to `src/pipeline/stages/autofix-cycle.ts` (before `applyTestEditDeclarations`):

```typescript
import { resolveTestFilePatterns } from "../../test-runners/resolver";
import type { ResolvedTestPatterns } from "../../test-runners/resolver";

export async function validateMockStructureFiles(
  decls: TestEditDeclaration[],
  workdir: string,
  resolved: ResolvedTestPatterns,
): Promise<{
  valid: TestEditDeclaration[];
  invalid: { decl: TestEditDeclaration; missing: string[]; nonTest: string[] }[];
}> {
  const valid: TestEditDeclaration[] = [];
  const invalid: { decl: TestEditDeclaration; missing: string[]; nonTest: string[] }[] = [];

  for (const decl of decls) {
    if (decl.reason !== "mock_structure") {
      valid.push(decl);
      continue;
    }

    const files = decl.files ?? [decl.file];
    const missing: string[] = [];
    const nonTest: string[] = [];

    for (const f of files) {
      const abs = join(workdir, f);
      if (!Bun.file(abs).exists()) {
        missing.push(f);
      } else if (!resolved.regex.some((re) => re.test(f))) {
        nonTest.push(f);
      }
    }

    if (missing.length === 0 && nonTest.length === 0) {
      valid.push(decl);
    } else {
      invalid.push({ decl, missing, nonTest });
    }
  }

  return { valid, invalid };
}
```

- [ ] **Step 9: Extend applyTestEditDeclarations to handle mock_structure**

Modify `applyTestEditDeclarations` to accept an optional fourth parameter `invalidDecls?: { decl: TestEditDeclaration; missing: string[]; nonTest: string[] }[]`.

For each entry in `invalidDecls`, append one advisory finding:
```typescript
{
  source: "implementer-handoff",
  severity: "warning",
  category: "mock_structure_invalid_files",
  message: `mock_structure FILES: ${[...missing, ...nonTest].join(", ")}`,
  file: decl.file,
  fixTarget: "test",
}
```

For each valid `mock_structure` declaration, append one synthetic finding per path in `decl.files`:
```typescript
{
  source: "implementer-handoff",
  severity: "error",
  category: "test_mock_restructure",
  message: "Restructure mocks per implementer handoff",
  file: path,
  fixTarget: "test",
}
```

- [ ] **Step 10: Extend validate() in runAgentRectificationV2**

In the `validate` async callback inside `runAgentRectificationV2`, after `recheckReview` and before `applyTestEditDeclarations`, add:

```typescript
const resolved = await resolveTestFilePatterns(ctx.config, ctx.workdir, ctx.workdir);
const { valid, invalid } = await validateMockStructureFiles(pending, ctx.workdir, resolved);

// Stash handoffs for test-writer buildInput
if (valid.length > 0) {
  ctx.pendingMockStructureHandoffs = valid.map((decl) => ({
    files: decl.files ?? [decl.file],
    reasonDetail: decl.reasonDetail ?? "",
  }));
}

// Pass both valid (with mock_structure already filtered by validateMockStructureFiles
// passing through) and invalid to applyTestEditDeclarations
const retagged = applyTestEditDeclarations(fresh, pending, ctx.story, invalid);
```

Note: `applyTestEditDeclarations` currently handles all declaration types. The new version should skip `mock_structure` in the main loop (since synthetic findings are already added via the separate path above) but still accept `invalidDecls` for advisory findings. Refactor accordingly.

- [ ] **Step 11: Run tests**

Run: `timeout 60 bun test test/unit/pipeline/stages/autofix-cycle.test.ts --timeout=10000`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/findings/types.ts src/pipeline/types.ts src/pipeline/stages/autofix-cycle.ts
git commit -m "feat(pipeline): validate mock_structure FILES and synthesize virtual findings (US-002)"
```

---

## Task 3: US-003 — mock-restructure prompt mode and Exception 4

**Files:**
- Modify: `src/prompts/builders/rectifier-builder-helpers.ts` — add Exception 4 to CONTRADICTION_ESCAPE_HATCH
- Modify: `src/prompts/builders/rectifier-builder.ts` — add `_testWriterMockRestructure`, extend dispatch
- Test: `test/unit/prompts/builders/rectifier-builder.test.ts`

- [ ] **Step 1: Read rectifier-builder-helpers.ts**

Read `src/prompts/builders/rectifier-builder-helpers.ts` — find `CONTRADICTION_ESCAPE_HATCH` (around lines 19–74).

- [ ] **Step 2: Write failing test — Exception 4 in CONTRADICTION_ESCAPE_HATCH**

Add to `test/unit/prompts/builders/rectifier-builder.test.ts`:
```typescript
it("CONTRADICTION_ESCAPE_HATCH includes Exception 4", () => {
  const text = CONTRADICTION_ESCAPE_HATCH;
  expect(text).toContain("Exception 4");
  expect(text).toContain("mock_structure");
  expect(text).toContain("Do NOT also emit `UNRESOLVED:`");
});
```

Run: FAIL

- [ ] **Step 3: Append Exception 4 to CONTRADICTION_ESCAPE_HATCH**

Add to `CONTRADICTION_ESCAPE_HATCH` in `rectifier-builder-helpers.ts`:

```
### Exception 4 — Mock-structure handoff

Use ONLY when the only path to satisfy the ACs requires a structural test rewrite
that does NOT fit Exception 2. Examples: mocks reference primitives the new code
bypasses; assertion topology must change to match a new dispatch shape.

Declare with:
TEST_EDIT_REASON: mock_structure
FILES: <comma-separated test file paths>
REASON: <one paragraph: which mock is wrong vs which dispatch the new code uses>

Rules:
- Do NOT make any edits yourself; the test-writer will fulfill.
- Do NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff.
- FILES must list real test files. Each path must exist and be a test file.
```

Run: `timeout 15 bun test test/unit/prompts/builders/rectifier-builder.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 4: Read rectifier-builder.ts — testWriterRectification dispatch**

Read `src/prompts/builders/rectifier-builder.ts` — find `testWriterRectification` method (around lines 242–251).

- [ ] **Step 5: Write failing test — mock-restructure prompt rendering**

Add to `test/unit/prompts/builders/rectifier-builder.test.ts`:
```typescript
it("testWriterRectification with mock-restructure mode renders files and handoff reason", () => {
  const prompt = RectifierPromptBuilder.testWriterRectification(
    [{ check: "lint", success: false, findings: [] }],
    { id: "s1", title: "Test", description: "", acceptanceCriteria: ["AC1"], workdir: "" } as UserStory,
    {
      mode: "mock-restructure",
      handoffReason: "mocks reference runAs but new code uses runWithFallback",
      handoffFiles: ["test/foo.test.ts", "test/bar.test.ts"],
    },
  );
  expect(prompt).toContain("test/foo.test.ts");
  expect(prompt).toContain("test/bar.test.ts");
  expect(prompt).toContain("mocks reference runAs but new code uses runWithFallback");
  expect(prompt).toContain("Do NOT modify any source file");
  expect(prompt).toMatch(/expect\(|toBe\(|toEqual\(|toThrow\(/);
});
```

Run: FAIL — method doesn't accept `mode: "mock-restructure"`

- [ ] **Step 6: Add _testWriterMockRestructure method**

Add private static method to `RectifierPromptBuilder`:

```typescript
private static _testWriterMockRestructure(
  _findings: ReviewCheckResult[],
  story: UserStory,
  options: { handoffReason: string; handoffFiles: string[] },
): string {
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
  const filesList = options.handoffFiles.join("\n");
  return `You are restructuring test mocks to align with the AC-mandated dispatch shape.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Files to rewrite (only these)
${filesList}

### Implementer handoff
${options.handoffReason}

Rules:
1. Modify ONLY the files listed above.
2. Do NOT modify any source file.
3. Do NOT loosen, remove, or rewrite any assertion site (\`expect(\`, \`toBe\`, \`toEqual\`, \`toThrow\`, \`not.\`, language equivalents). Restructure mock setup, dispatch wiring, and arrangement only.
4. The tests must continue to encode the SPECIFICATION, not the current behavior.
5. Commit your changes when done.`;
}
```

- [ ] **Step 7: Extend testWriterRectification to dispatch to mock-restructure mode**

Change `testWriterRectification` signature to accept `mode?: "fix-test-files" | "write-failing-test" | "mock-restructure"` in options.

Add dispatch branch:
```typescript
if (options?.mode === "mock-restructure") {
  return RectifierPromptBuilder._testWriterMockRestructure(findings, story, {
    handoffReason: options.handoffReason ?? "",
    handoffFiles: options.handoffFiles ?? [],
  });
}
```

Also update `AutofixTestWriterInput` in `src/operations/autofix-test-writer.ts` to add `mode?: "fix-test-files" | "write-failing-test" | "mock-restructure"` and optional `handoffReason?: string`, `handoffFiles?: string[]`.

Run: `timeout 15 bun test test/unit/prompts/builders/rectifier-builder.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/prompts/builders/rectifier-builder-helpers.ts src/prompts/builders/rectifier-builder.ts src/operations/autofix-test-writer.ts test/unit/prompts/builders/rectifier-builder.test.ts
git commit -m "feat(prompts): add mock-restructure mode and Exception 4 (US-003)"
```

---

## Task 4: US-004 — Wire mock-restructure handoff through test-writer strategy

**Files:**
- Modify: `src/pipeline/stages/autofix-cycle.ts` — extend `buildAutofixStrategies` testWriter `buildInput`
- Modify: `src/operations/autofix-test-writer.ts` — extend `testWriterRectifyOp.build`
- Test: `test/integration/autofix-implementer-feedback.test.ts`

- [ ] **Step 1: Read autofix-test-writer.ts**

Read `src/operations/autofix-test-writer.ts` — find `testWriterRectifyOp.build` and `AutofixTestWriterInput`.

- [ ] **Step 2: Write failing integration test**

Add to `test/integration/autofix-implementer-feedback.test.ts` (create if absent):
```typescript
it("runAgentRectificationV2 emits mock-restructure mode to test-writer when implementer declares mock_structure", async () => {
  // Setup: mock review with one source-tagged finding
  // Implementer mock returns mock_structure declaration on first call
  // Test-writer mock returns success
  // Assert: at least one call to test-writer has mode === "mock-restructure"
  // Assert: source finding was never re-tagged to fixTarget: "test" in any callOp input
});
```

Run: FAIL (function not defined / test not yet written)

- [ ] **Step 3: Extend AutofixTestWriterInput interface**

In `src/operations/autofix-test-writer.ts`, add to `AutofixTestWriterInput`:
```typescript
mode?: "fix-test-files" | "write-failing-test" | "mock-restructure";
handoffReason?: string;
handoffFiles?: string[];
```

- [ ] **Step 4: Extend testWriterRectifyOp.build**

In `testWriterRectifyOp.build`, when `input.mode === "mock-restructure"`:
```typescript
return RectifierPromptBuilder.testWriterRectification(findings, story, {
  mode: input.mode,
  handoffReason: input.handoffReason,
  handoffFiles: input.handoffFiles,
  blockingThreshold: input.blockingThreshold,
});
```

- [ ] **Step 5: Extend buildAutofixStrategies testWriter buildInput**

In `buildAutofixStrategies` testWriter `buildInput`, before returning, check:
```typescript
if (ctx.pendingMockStructureHandoffs && ctx.pendingMockStructureHandoffs.length > 0) {
  const allFiles = ctx.pendingMockStructureHandoffs.flatMap((h) => h.files);
  const uniqueFiles = [...new Set(allFiles)];
  const reasonDetail = ctx.pendingMockStructureHandoffs.map((h) => h.reasonDetail).join("\n\n---\n\n");
  ctx.pendingMockStructureHandoffs = []; // clear on consumption
  return {
    failedChecks: collectTestTargetedChecks(ctx),
    story: ctx.story,
    mode: "mock-restructure",
    handoffFiles: uniqueFiles,
    handoffReason: reasonDetail,
    blockingThreshold: ctx.config.review?.blockingThreshold,
  };
}
```

- [ ] **Step 6: Run integration test**

Run: `timeout 90 bun test test/integration/autofix-implementer-feedback.test.ts --timeout=30000`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/stages/autofix-cycle.ts src/operations/autofix-test-writer.ts
git commit -m "feat(wiring): wire mock-restructure handoff to test-writer strategy (US-004)"
```

---

## Task 5: US-005 — Safety guards and config flag

**Files:**
- Create: `src/pipeline/stages/autofix-guards.ts`
- Modify: `src/config/schemas-execution.ts` — add `enforceTestWriterIsolation`
- Modify: `src/config/schemas.ts` — add `enforceTestWriterIsolation: true` to default literal
- Modify: `src/config/runtime-types.ts` — add `enforceTestWriterIsolation?` to autofix interface
- Modify: `src/pipeline/stages/autofix-cycle.ts` — wrap test-writer post-commit with guards
- Test: `test/unit/pipeline/stages/autofix-guards.test.ts`

- [ ] **Step 1: Read tdd/isolation.ts**

Read `src/tdd/isolation.ts` — find `verifyTestWriterIsolation` signature (around lines 66–93).

- [ ] **Step 2: Read config schemas**

Read `src/config/schemas-execution.ts` — find autofix Zod schema (around lines 152–166).
Read `src/config/schemas.ts` — find autofix default literal (around lines 147–153).
Read `src/config/runtime-types.ts` — find autofix interface (around lines 209–220).

- [ ] **Step 3: Write failing tests for autofix-guards**

Create `test/unit/pipeline/stages/autofix-guards.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { assertionSiteDiffCheck, runIsolationGuard, revertDiff } from "../../../src/pipeline/stages/autofix-guards";

describe("assertionSiteDiffCheck", () => {
  it("returns violated when diff contains expect(", async () => {
    // Create temp git repo, make commit, add line with expect(
  });

  it("returns not violated when diff contains only mock setup", async () => {
    // ...
  });
});

describe("runIsolationGuard", () => {
  it("returns violated when source file edited", async () => {
    // ...
  });

  it("returns skipped when enforceTestWriterIsolation is false", async () => {
    // ...
  });
});
```

Run: FAIL — file doesn't exist yet

- [ ] **Step 4: Create src/pipeline/stages/autofix-guards.ts**

Create the file with `_guardDeps` injectable pattern:

```typescript
import { join } from "node:path";
import { verifyTestWriterIsolation } from "../../tdd/isolation";
import { _gitDeps } from "../../utils/git";
import type { NaxConfig } from "../../config/schema";
import type { ResolvedTestPatterns } from "../../test-runners/resolver";

export const _guardDeps = {
  spawn: _gitDeps.spawn,
};

export interface GuardResult {
  violated: boolean;
  file?: string;
  line?: number;
  content?: string;
  skipped?: boolean;
}

const ASSERTION_RE = /expect\(|\.toBe\(|\.toEqual\(|\.toThrow\(|\bnot\.|\.toMatch\(|\bassert\./;

export async function assertionSiteDiffCheck(
  workdir: string,
  beforeRef: string,
  files: string[],
  _deps = _guardDeps,
): Promise<GuardResult> {
  if (files.length === 0) return { violated: false };
  for (const file of files) {
    const proc = _deps.spawn({
      cmd: ["git", "diff", "--unified=0", beforeRef, "--", file],
      cwd: workdir,
    });
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (proc.exitCode !== 0) continue; // no diff
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++") && ASSERTION_RE.test(line.slice(1))) {
        const numMatch = line.match(/^@@.*\+(\d+)/);
        return {
          violated: true,
          file,
          line: numMatch ? parseInt(numMatch[1], 10) : undefined,
          content: line.slice(1).trim(),
        };
      }
    }
  }
  return { violated: false };
}

export async function runIsolationGuard(
  workdir: string,
  beforeRef: string,
  config: NaxConfig,
  resolved: ResolvedTestPatterns,
  _deps = _guardDeps,
): Promise<GuardResult & { files?: string[] }> {
  if (config.quality?.autofix?.enforceTestWriterIsolation === false) {
    return { violated: false, skipped: true };
  }
  const allowedPaths = config.tdd?.testWriterAllowedPaths;
  const result = await verifyTestWriterIsolation(workdir, beforeRef, allowedPaths, resolved);
  if (!result.passed) {
    return { violated: true, files: result.violatedFiles };
  }
  return { violated: false };
}

export async function revertDiff(
  workdir: string,
  files: string[],
  _deps = _guardDeps,
): Promise<void> {
  if (files.length === 0) return;
  const proc = _deps.spawn({
    cmd: ["git", "checkout", "HEAD", "--", ...files],
    cwd: workdir,
  });
  const stderr = await new Response(proc.stderr).text();
  if (proc.exitCode !== 0) {
    throw new Error(`revertDiff failed: ${stderr}`);
  }
}
```

- [ ] **Step 5: Extend autofix Zod schema**

In `src/config/schemas-execution.ts`, add `enforceTestWriterIsolation: z.boolean().default(true)` to the autofix schema object.

- [ ] **Step 6: Extend autofix default literal**

In `src/config/schemas.ts` at the autofix default literal (~line 147), add `enforceTestWriterIsolation: true`.

- [ ] **Step 7: Extend autofix runtime-types interface**

In `src/config/runtime-types.ts` at the autofix interface (~lines 209–220), add `enforceTestWriterIsolation?: boolean`.

- [ ] **Step 8: Integrate guards in autofix-cycle.ts**

In `runAgentRectificationV2`, when the test-writer op completes in `mock-restructure` mode (detect via checking if the completed op was `testWriterRectifyOp` with `input.mode === "mock-restructure"`):

After the op result is available (before the next cycle iteration), call:
```typescript
if (input.mode === "mock-restructure" && result.applied === true) {
  const beforeRef = /* git rev-parse HEAD captured just before the test-writer op */;
  const guardResult = await assertionSiteDiffCheck(ctx.workdir, beforeRef, input.handoffFiles ?? []);
  if (guardResult.violated) {
    await revertDiff(ctx.workdir, input.handoffFiles ?? []);
    return {
      succeeded: false,
      cost: 0,
      unresolvedReason: `assertion_weakening:${guardResult.file}:${guardResult.line ?? 0}`,
    };
  }
  const isoResult = await runIsolationGuard(ctx.workdir, beforeRef, ctx.config, resolved);
  if (isoResult.violated) {
    await revertDiff(ctx.workdir, isoResult.files ?? []);
    return {
      succeeded: false,
      cost: 0,
      unresolvedReason: `test_writer_isolation_violation:${(isoResult.files ?? []).join(",")}`,
    };
  }
}
```

Note: Capture `beforeRef` via `git rev-parse HEAD` immediately before calling the test-writer op in `mock-restructure` mode. The guard integration point is after the op completes successfully.

- [ ] **Step 9: Run tests**

Run: `timeout 60 bun test test/unit/pipeline/stages/autofix-guards.test.ts --timeout=10000`
Run: `timeout 60 bun test test/unit/config/ --timeout=10000` (config schema tests)

Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/pipeline/stages/autofix-guards.ts src/config/schemas-execution.ts src/config/schemas.ts src/config/runtime-types.ts src/pipeline/stages/autofix-cycle.ts
git commit -m "feat(guards): add safety guards for mock-restructure mode (US-005)"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun run test:bail`

- [ ] **Step 2: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`

- [ ] **Step 3: Final review**

Verify the feature branch contains all changes across 5 stories.
Merge/PR against `main`.
