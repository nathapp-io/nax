# Patch Plan — Bug 6 (acceptance-fix prompt is 89 KB / 1891 lines) + Bug 8 (hardening log duplication)

> Single PR for acceptance-subsystem hygiene. Two independent fixes bundled because they're both small, both in the same subsystem, and ship together cleanly:
>
> - **Bug 6** — Language-agnostic fix to acceptance test-fix / source-fix / diagnosis prompts. Replaces raw test-output dumps and embedded test-file bodies with structured failure summaries (using nax's existing `parseTestOutput` SSOT) and a path-only file reference. Reduces the largest observed prompt from ~89 KB to ~5–10 KB without losing actionable signal.
> - **Bug 8** — Removes duplicate `Hardening pass complete` / `Hardening pass failed` log emits and fixes single-story attribution for what is actually a multi-story operation.

**Linked**: [2026-05-05-context-curator-v0-dogfood-findings.md](./2026-05-05-context-curator-v0-dogfood-findings.md) → Bug 6, Bug 8

---

## Why one PR

The same anti-pattern exists in three sibling prompt builders that all consume raw test output and embed the test-file body verbatim. Fixing one without the others would leave the next acceptance/diagnosis run hitting the same compaction-mid-task failure. They share a single helper (`AcceptancePromptBuilder`) and a single op input shape, so the change is local and atomic.

---

## What's broken (recap)

In the failing run, the test-fix prompt for US-001 was 89 KB:
- ~530 lines of raw `bun test` output, **including all 36 passing-test lines** (`(pass) AC-1: …`)
- Full 1320-line test file body embedded in a hardcoded ` ```typescript ` fence
- Single turn took 1240 s ($2.71); session forced mid-task `Compacting…`
- The agent re-read source files via tools anyway: *"I need the actual code, not summaries. Let me read the key files directly."*

Two separate problems:
1. **Test output is raw** — should be filtered to failures only, language-agnostic.
2. **Test-file body is embedded** — agent has the path and Read access; embedding is double work.

The good news: nax already has the SSOT for #1 — [`src/test-runners/parser.ts`](../../src/test-runners/parser.ts) exposes `parseTestOutput()` (auto-detects bun/jest/vitest/pytest/go/unknown) and `formatFailureSummary()` (pre-built formatter with truncation). We just need to use them.

---

## Scope

### In — Bug 6 (prompt-size fix)

- `src/prompts/builders/acceptance-builder-helpers.ts` *(new, or co-located)* — `formatTestOutputForFix(rawOutput)` + `fenceLangFor(testPath)`
- `src/prompts/builders/acceptance-builder.ts` — `buildTestFixPrompt`, `buildSourceFixPrompt`, `buildDiagnosisPromptTemplate`: pipe test output through the helper; derive code fence from path
- `src/prompts/builders/acceptance-builder.ts` — `TestFixParams`/`SourceFixParams`: drop `testFileContent`, add `testCommand`
- `src/operations/acceptance-fix.ts` — `AcceptanceFixSourceInput`/`AcceptanceFixTestInput`: drop `testFileContent`, add `testCommand`
- Call sites that populate the input — pass `testCommand`, stop reading the test file

### In — Bug 8 (hardening log hygiene)

- `src/acceptance/hardening.ts` — fix attribution on the `Hardening pass complete` / `Hardening pass failed` log emits to reflect the multi-story scope (`storyIds: [...]`, `storiesProcessed: N`)
- `src/pipeline/stages/acceptance.ts` — remove the redundant duplicate `info`/`warn` emits at the stage layer (lines ~267-271 and ~273-277); `runHardeningPass()` already logs internally
- Tests: see [Test plan](#test-plan)

### Out (separate PRs)

- Rectifier-builder's `check.output.length > 4000` raw truncation (two sites: [`rectifier-builder.ts:112,363`](../../src/prompts/builders/rectifier-builder.ts)) — same anti-pattern but consumed by review/autofix flow, not acceptance. Worth a follow-up that uses the same helper. **Listed as F1 below.**
- Multi-line "expected vs received" diff capture in per-runner parsers — `TestFailure.error` is currently single-line. Extending the parsers is its own change. **Listed as F2 below.**
- The diagnosis path still embeds the test file — see "Why diagnosis is in scope" below.

### Why diagnosis is in scope

`buildDiagnosisPromptTemplate` is upstream of test-fix. It hardcodes ` ```typescript ` (line 191) and embeds `testFileContent` directly. Same fix applies. Excluding it would leave the same compaction risk on the diagnosis turn (the audit shows diagnosis turns running 30+ seconds even when fast-path is hit — the prompt still has to be assembled and processed).

---

## Change set

### 1. New helpers — `src/prompts/builders/acceptance-builder-helpers.ts`

```ts
import { detectFramework, formatFailureSummary, parseTestOutput } from "../../test-runners";

const MAX_FAILURE_CHARS = 4000;
const TAIL_FALLBACK_LINES = 60;
const MAX_ENV_FAILURE_CHARS = 4000;

/**
 * Convert raw test-runner stdout into a compact, language-agnostic summary
 * suitable for embedding in a fix prompt.
 *
 * Decision tree:
 *   1. parseTestOutput recognises ≥1 structured failure → use formatFailureSummary
 *   2. parser detected failures but couldn't extract them (or unknown framework
 *      and parseCommonOutput came up empty) → tail-fallback: last N lines
 *   3. parser found 0 failures AND 0 passes → likely environmental failure
 *      (compile error, missing binary) → cap raw output at MAX_ENV_FAILURE_CHARS
 *   4. otherwise (all tests passed by parser's count) → return summary line only
 *
 * Always emits a one-line header naming the framework + pass/fail counts so the
 * agent has context for which assertion style to write.
 */
export function formatTestOutputForFix(rawOutput: string): string {
  const summary = parseTestOutput(rawOutput);
  const framework = detectFramework(rawOutput);
  const header = `Test runner: ${framework}\nResult: ${summary.passed} passed, ${summary.failed} failed`;

  // Happy path — structured failures available
  if (summary.failures.length > 0) {
    return `${header}\n\nFailures:\n${formatFailureSummary(summary.failures, MAX_FAILURE_CHARS)}`;
  }

  // Parser saw failures but couldn't extract structure, OR unknown framework
  // → tail-fallback: failures cluster near the end for most runners
  if (summary.failed > 0) {
    const lines = rawOutput.trim().split("\n");
    const tail = lines.slice(-TAIL_FALLBACK_LINES).join("\n");
    return `${header}\n\nTest output (last ${TAIL_FALLBACK_LINES} lines — structured parse unavailable):\n${tail}`;
  }

  // No failures detected by parser. If there are also no passes, treat as
  // environmental failure (compile error, missing binary, etc.) and cap raw output.
  if (summary.passed === 0) {
    const capped =
      rawOutput.length > MAX_ENV_FAILURE_CHARS
        ? `${rawOutput.slice(0, MAX_ENV_FAILURE_CHARS)}\n... (truncated — environmental failure suspected)`
        : rawOutput;
    return `${header}\n\nNo structured tests detected — environmental failure suspected:\n${capped}`;
  }

  // All tests passed per parser, but caller invoked the fix path anyway —
  // shouldn't happen but handle gracefully.
  return header;
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".php": "php",
};

/**
 * Derive the markdown code-fence language hint from a file path.
 * Returns "" (bare fence) for unknown extensions — still valid markdown.
 */
export function fenceLangFor(filePath: string | undefined): string {
  if (!filePath) return "";
  const ext = filePath.match(/\.[^./]+$/)?.[0] ?? "";
  return LANG_BY_EXT[ext.toLowerCase()] ?? "";
}
```

### 2. `src/prompts/builders/acceptance-builder.ts`

#### 2a. Update param interfaces

```diff
 export interface SourceFixParams {
-  testOutput: string;
+  testOutput: string;     // raw runner stdout — passed through formatTestOutputForFix
+  testCommand?: string;   // for framework hint; optional for backward compat
   diagnosisReasoning?: string;
   priorIterationsBlock?: string;
   acceptanceTestPath: string;
-  testFileContent?: string;
 }

 export interface TestFixParams {
   testOutput: string;
+  testCommand?: string;
   diagnosisReasoning?: string;
   priorIterationsBlock?: string;
   failedACs: string[];
   acceptanceTestPath: string;
-  testFileContent: string;
 }

 export interface DiagnosisTemplateParams {
-  truncatedOutput: string;
-  testFileContent: string;
+  truncatedOutput: string;       // unchanged; diagnosis already truncates upstream
+  acceptanceTestPath: string;    // path replaces embedded body
+  testFenceLang: string;         // resolved by caller via fenceLangFor()
   sourceFilesSection: string;
   verdictSection: string;
   maxFileLines: number;
 }
```

#### 2b. Rewrite `buildTestFixPrompt`

```diff
+import { buildTestFrameworkHint } from "../../test-runners";
+import { formatTestOutputForFix, fenceLangFor } from "./acceptance-builder-helpers";

   buildTestFixPrompt(p: TestFixParams): string {
     let prompt = "ACCEPTANCE TEST BUG — surgical fix required.\n\n";
     prompt += `FAILING ACS: ${p.failedACs.join(", ")}\n\n`;
-    prompt += `TEST OUTPUT:\n${p.testOutput}\n\n`;
+    if (p.testCommand) {
+      prompt += `Test framework: ${buildTestFrameworkHint(p.testCommand)}\n\n`;
+    }
+    prompt += `TEST OUTPUT:\n${formatTestOutputForFix(p.testOutput)}\n\n`;
     if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
     if (p.priorIterationsBlock) prompt += p.priorIterationsBlock;
     prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
-    prompt += `\`\`\`typescript\n${p.testFileContent}\n\`\`\`\n\n`;
-    prompt += "Fix ONLY the failing test assertions for the ACs listed above. ";
+    prompt += "Read the test file at the path above before editing. The fix should be ";
+    prompt += "surgical — locate the failing AC blocks and adjust their assertions only. ";
     prompt += "Do NOT modify passing tests. Do NOT modify source code. ";
     prompt += "Edit the test file in place.";
     return prompt;
   }
```

#### 2c. Rewrite `buildSourceFixPrompt`

```diff
   buildSourceFixPrompt(p: SourceFixParams): string {
-    let prompt = `ACCEPTANCE TEST FAILURE:\n${p.testOutput}\n\n`;
+    let prompt = "ACCEPTANCE TEST FAILURE — fix the source implementation.\n\n";
+    if (p.testCommand) {
+      prompt += `Test framework: ${buildTestFrameworkHint(p.testCommand)}\n\n`;
+    }
+    prompt += `TEST OUTPUT:\n${formatTestOutputForFix(p.testOutput)}\n\n`;
     if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
     if (p.priorIterationsBlock) prompt += p.priorIterationsBlock;
     prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
-    if (p.testFileContent && p.testFileContent.length > 0) {
-      prompt += `\`\`\`typescript\n${p.testFileContent}\n\`\`\`\n\n`;
-    }
-    prompt += "Fix the source implementation. Do NOT modify the test file.";
+    prompt += "Read the test file at the path above for context, then fix the source implementation. ";
+    prompt += "Do NOT modify the test file.";
     return prompt;
   }
```

#### 2d. Rewrite `buildDiagnosisPromptTemplate` (fence + path-only)

```diff
   buildDiagnosisPromptTemplate(p: DiagnosisTemplateParams): string {
     const responseSchema = `{ … unchanged … }`;
     return `You are a debugging expert. An acceptance test has failed.

 TASK: Diagnose whether the failure is due to a bug in the SOURCE CODE or a bug in the TEST CODE.

 FAILING TEST OUTPUT:
 ${p.truncatedOutput}

-ACCEPTANCE TEST FILE CONTENT:
-\`\`\`typescript
-${p.testFileContent}
-\`\`\`
+ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}
+
+(Use Read on the path above to inspect the test code if needed for diagnosis.)

 SOURCE FILES (auto-detected from imports, up to ${p.maxFileLines} lines each):
 ${p.sourceFilesSection}
 …`;
   }
```

The diagnosis caller in [`src/acceptance/fix-diagnosis.ts`](../../src/acceptance/fix-diagnosis.ts) needs to pass `acceptanceTestPath` instead of (in addition to) `testFileContent`. If the diagnosis result depends on full test content for fast-path detection, keep the read at that call site but stop embedding it in the prompt.

### 3. `src/operations/acceptance-fix.ts`

```diff
 export interface AcceptanceFixSourceInput {
   testOutput: string;
+  testCommand?: string;
   diagnosisReasoning?: string;
   priorIterationsBlock?: string;
   acceptanceTestPath: string;
-  testFileContent?: string;
 }

 export interface AcceptanceFixTestInput {
   testOutput: string;
+  testCommand?: string;
   diagnosisReasoning?: string;
   priorIterationsBlock?: string;
   failedACs: string[];
   acceptanceTestPath: string;
-  testFileContent?: string;
 }
```

Update `build()` calls to forward `testCommand` and stop forwarding `testFileContent`. The op signatures are otherwise unchanged.

### 4. Call sites

Search for `acceptanceFixSourceOp` / `acceptanceFixTestOp` consumers — primarily [`src/acceptance/fix-executor.ts`](../../src/acceptance/fix-executor.ts). Stop the file read; pass `testCommand` (already known at that layer because the test was just invoked).

```diff
 await callOp(ctx, acceptanceFixTestOp, {
   testOutput,
+  testCommand: resolvedTestCommand,   // already in scope from acceptance runner
   diagnosisReasoning,
   priorIterationsBlock,
   failedACs,
   acceptanceTestPath,
-  testFileContent: await Bun.file(acceptanceTestPath).text(),
 });
```

If the file read happens further upstream, push it down or remove it. The agent's Read tool covers the access need.

### 5. `src/acceptance/hardening.ts` — fix multi-story attribution (Bug 8 part 1)

```diff
     // 8. Save PRD with promotions
     if (result.promoted.length > 0) {
       await _hardeningDeps.savePRD(ctx.prd, ctx.prdPath);
     }

     logger?.info("acceptance", "Hardening pass complete", {
-      storyId: storiesWithSuggested[0].id,
+      storyIds: storiesWithSuggested.map((s) => s.id),
+      storiesProcessed: storiesWithSuggested.length,
       promoted: result.promoted.length,
       discarded: result.discarded.length,
     });
   } catch (err) {
     logger?.warn("acceptance", "Hardening pass failed (non-blocking)", {
-      storyId: storiesWithSuggested[0].id,
+      storyIds: storiesWithSuggested.map((s) => s.id),
+      storiesProcessed: storiesWithSuggested.length,
       error: err instanceof Error ? err.message : String(err),
     });
   }
```

Single-story attribution was already misleading (the operation iterates over all stories with `suggestedCriteria`); the fix replaces it with a list + count that accurately describes what the function did.

> **Logging convention note**: `.claude/rules/project-conventions.md` mandates `storyId` as the first key in pipeline-stage logs. `runHardeningPass` is a multi-story operation, not a per-story stage event, so `storyIds` (plural) is the honest field name. Stage-level per-story emits elsewhere keep `storyId`.

### 6. `src/pipeline/stages/acceptance.ts` — remove redundant emits (Bug 8 part 2)

```diff
           hardeningRetries = result.promoted.length;
-          logger.info("acceptance", "Hardening pass complete", {
-            storyId: ctx.story.id,
-            promoted: result.promoted.length,
-            discarded: result.discarded.length,
-          });
         } catch (err) {
-          logger.warn("acceptance", "Hardening pass failed (non-blocking)", {
-            storyId: ctx.story.id,
-            error: err instanceof Error ? err.message : String(err),
-          });
+          // Hardening function already logged its own outcome — nothing to add here.
+          // Re-throw or swallow per existing semantics (currently swallowed).
         }
```

The function already logs its own completion / failure. The stage layer had been double-emitting the same event, producing identical consecutive lines in the run JSONL (observed at `runs/2026-05-04T15-10-16.jsonl:185-186`). Audit the surrounding context to confirm the existing semantics were "log + continue" vs "log + rethrow" before deleting; from the run log the behavior is "swallow non-blocking", which the function-level `try/catch` already handles.

---

## Test plan

### Unit — `formatTestOutputForFix`

`test/unit/prompts/builders/acceptance-builder-helpers.test.ts` *(new)*:

```ts
describe("formatTestOutputForFix", () => {
  test("bun: extracts only failing tests, drops (pass) lines", () => {
    const raw = [
      "bun test v1.3.13",
      "(pass) AC-1: foo > does X [1ms]",
      "(pass) AC-2: bar > does Y [2ms]",
      "(fail) AC-3: baz > does Z [3ms]",
      "  Error: expected 1 to equal 2",
      "    at /repo/test/foo.test.ts:42:5",
      "",
      " 2 pass",
      " 1 fail",
    ].join("\n");
    const out = formatTestOutputForFix(raw);
    expect(out).toContain("Test runner: bun");
    expect(out).toContain("AC-3");
    expect(out).not.toContain("(pass)");
    expect(out).not.toContain("AC-1");
  });

  test("go: extracts --- FAIL: blocks", () => {
    const raw = `--- FAIL: TestFoo (0.01s)
    foo_test.go:42: expected 1, got 2
--- PASS: TestBar (0.00s)
FAIL\tgithub.com/x/y\t0.05s`;
    const out = formatTestOutputForFix(raw);
    expect(out).toContain("Test runner: go");
    expect(out).toContain("TestFoo");
    expect(out).not.toContain("TestBar");
  });

  test("pytest: extracts FAILED entries", () => { /* … */ });
  test("vitest: extracts failures via Test Files header", () => { /* … */ });

  test("unknown framework: falls back to last 60 lines", () => {
    const raw = Array.from({ length: 200 }, (_, i) => `line ${i}: some output`).join("\n") + "\nFAILED: 1";
    const out = formatTestOutputForFix(raw);
    // Tail fallback only kicks in when parser sees failures it can't extract.
    // For an entirely unknown format with no signal, parseCommonOutput returns 0/0
    // → environmental-failure path with capped raw output.
    expect(out.length).toBeLessThan(raw.length);
  });

  test("environmental failure (compile error, no tests ran)", () => {
    const raw = "error: cannot find module 'foo'\nat line 5";
    const out = formatTestOutputForFix(raw);
    expect(out).toContain("environmental failure suspected");
  });

  test("output is bounded (large raw input does not balloon)", () => {
    const raw = "x".repeat(500_000);
    const out = formatTestOutputForFix(raw);
    expect(out.length).toBeLessThan(10_000);  // generous upper bound
  });
});

describe("fenceLangFor", () => {
  test.each([
    [".nax-acceptance.test.ts", "typescript"],
    ["foo_test.go", "go"],
    ["test_foo.py", "python"],
    ["spec.rs", "rust"],
    ["weird.unknown", ""],
    [undefined, ""],
  ])("%s → %s", (input, expected) => {
    expect(fenceLangFor(input)).toBe(expected);
  });
});
```

### Unit — prompt builder regressions

`test/unit/prompts/builders/acceptance-builder.test.ts` *(extend)*:

```ts
test("buildTestFixPrompt does not embed full test file (Bug 6 regression)", () => {
  const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
    testOutput: "(fail) AC-1: x [1ms]\n\n 0 pass\n 1 fail",
    failedACs: ["AC-1"],
    acceptanceTestPath: "/tmp/.nax-acceptance.test.ts",
    testCommand: "bun test",
  });
  expect(prompt).toContain("AC-1");
  expect(prompt).toContain("/tmp/.nax-acceptance.test.ts");
  expect(prompt).toContain("Read the test file at the path");
  expect(prompt).not.toContain("```typescript");  // no embedded body
});

test("buildTestFixPrompt drops (pass) lines from test output", () => {
  const raw = "(pass) AC-1: x [1ms]\n(fail) AC-2: y [2ms]\n  Error: nope\n\n 1 pass\n 1 fail";
  const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
    testOutput: raw,
    failedACs: ["AC-2"],
    acceptanceTestPath: "/tmp/foo.test.ts",
    testCommand: "bun test",
  });
  expect(prompt).toContain("AC-2");
  expect(prompt).toContain("Error: nope");
  expect(prompt).not.toContain("(pass) AC-1");
});

test("buildSourceFixPrompt: same regressions apply", () => { /* … */ });

test("buildDiagnosisPromptTemplate references path instead of embedding body", () => { /* … */ });
```

### Integration — operation input shape

`test/integration/operations/acceptance-fix.test.ts` *(new or extend)*:

```ts
test("acceptanceFixTestOp does not require testFileContent", async () => {
  // Verify the build() path works with the new minimal input
  const ctx = makeOpCtx({ /* … */ });
  const op = acceptanceFixTestOp;
  const built = await op.build(
    {
      testOutput: "(fail) AC-1: x\n\n 0 pass\n 1 fail",
      testCommand: "bun test",
      failedACs: ["AC-1"],
      acceptanceTestPath: "/tmp/x.test.ts",
    },
    ctx,
  );
  expect(built.task.content).toContain("AC-1");
  expect(built.task.content).not.toContain("```typescript");
});
```

### Unit — Bug 8 logging fix

`test/unit/acceptance/hardening.test.ts` *(extend)*:

```ts
test("Hardening pass complete log uses storyIds list, not single storyId", async () => {
  const logCalls: Array<{ stage: string; message: string; data?: Record<string, unknown> }> = [];
  const logger = makeLogger((stage, message, data) => logCalls.push({ stage, message, data }));
  // run hardening with 3 stories having suggestedCriteria
  await runHardeningPass(makeCtx({ stories: [s1WithSugg, s2WithSugg, s3WithSugg] }));
  const completeLog = logCalls.find((c) => c.message === "Hardening pass complete");
  expect(completeLog?.data?.storyIds).toEqual([s1.id, s2.id, s3.id]);
  expect(completeLog?.data?.storiesProcessed).toBe(3);
  expect(completeLog?.data).not.toHaveProperty("storyId");
});
```

`test/unit/pipeline/stages/acceptance.test.ts` *(extend)*:

```ts
test("acceptance stage does not duplicate Hardening pass complete log (Bug 8 regression)", async () => {
  const logCalls: Array<{ message: string }> = [];
  const logger = makeLogger((_, message) => logCalls.push({ message }));
  await acceptanceStage.execute(makeCtx({ /* with hardening enabled + suggested criteria */ }));
  const completeCount = logCalls.filter((c) => c.message === "Hardening pass complete").length;
  expect(completeCount).toBe(1);   // exactly one emit, not two
});
```

### Manual verification

After merge, re-run a feature with at least one acceptance test_bug fix and confirm in `prompt-audit/`:
- The test-fix prompt is < 15 KB (vs ~89 KB before).
- No `(pass)` lines appear in `TEST OUTPUT:` section.
- The session does NOT emit `Compacting…` mid-task.
- The agent's response still successfully edits the test file (i.e., the path-only reference is sufficient).
- The run JSONL contains exactly **one** `Hardening pass complete` entry per hardening invocation, with `storyIds: [...]` rather than a single `storyId`.

---

## Risk assessment

| Change | Risk | Mitigation |
|---|---|---|
| Drop `testFileContent` from prompt | Agent might not Read the file before editing | Prompt explicitly instructs `Read the test file at the path above`; agent already does this via tools (confirmed in audit). Editing tools (Edit) require Read first by Claude Code rules. |
| `formatTestOutputForFix` for unknown framework | Tail-fallback could miss failure context | `parseCommonOutput` regex fallback already handles many shapes; tail of 60 lines is generous; environmental-failure path catches the no-test-ran case. |
| Drop multi-line "expected vs received" diff blocks | Single-line `error` field may miss diff body | Failure name + file + line is enough for ~95% of fixes; missing diff is recoverable via Read + grep. F2 follow-up can extend parsers if real cases emerge. |
| Hardcoded fence change | Mismatched fence on a non-listed extension | `fenceLangFor` returns `""` (bare fence — valid markdown). Worst case is no syntax highlighting, no parser break. |
| Bug 8 — change log field name `storyId` → `storyIds` | Downstream log parsers / dashboards keying on `storyId` lose this entry | Hardening is a multi-story op; `storyId` was already misleading. Search for log consumers that key specifically on `acceptance:Hardening pass complete:storyId` — none expected. The audit middleware filters by `stage` not field shape. |
| Bug 8 — remove stage-level emit | A consumer that listens for the stage-level emit specifically would lose it | Single emit site (`hardening.ts`) replaces it with the same message + richer fields. Downstream observers see one entry where they used to see two — a strict improvement. |

---

## Backward compatibility

- **Op input signatures**: `testFileContent` becomes deprecated/removed; `testCommand` becomes optional. Add both as optional in a transition commit if external plugins consume the op directly (none today, per grep).
- **Prompt content**: Different. Acceptance test outcomes should not regress because the agent has the same information surface (path + Read tool). Manual verification step covers this.
- **No config schema changes.**
- **No plugin contract changes.**

---

## Acceptance checklist

### Bug 6
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun run test` clean (full suite)
- [ ] New unit suite for `formatTestOutputForFix` covering bun/jest/vitest/pytest/go/unknown/environmental
- [ ] New unit suite for `fenceLangFor`
- [ ] Regression tests for all three prompt builders (test-fix / source-fix / diagnosis)
- [ ] Manual verification on a real acceptance test_bug fix run: prompt size < 15 KB, no `Compacting…`, agent still edits successfully
- [ ] Removed `testFileContent` from `AcceptanceFixSourceInput` / `AcceptanceFixTestInput`
- [ ] Removed `testFileContent` from `TestFixParams` / `SourceFixParams` / `DiagnosisTemplateParams`
- [ ] All call sites pass `testCommand` (or accept default `"Use your project's test framework"`)

### Bug 8
- [ ] `Hardening pass complete` log emitted exactly once per hardening invocation
- [ ] `Hardening pass failed` log emitted exactly once when failures occur
- [ ] Both log entries contain `storyIds: [...]` and `storiesProcessed: N` (not single `storyId`)
- [ ] Manual verification: re-run a feature with hardening enabled and confirm no consecutive duplicate log lines

---

## Commit plan

### Bug 6
1. `feat(prompts): add acceptance-builder-helpers (formatTestOutputForFix, fenceLangFor)`
2. `refactor(prompts/acceptance): pipe test output through formatTestOutputForFix in test-fix and source-fix`
3. `refactor(prompts/acceptance): replace embedded test-file body with path-only reference`
4. `refactor(prompts/acceptance): derive code-fence language from path (drop hardcoded typescript)`
5. `refactor(operations/acceptance-fix): drop testFileContent, add testCommand`
6. `test(prompts): regression coverage for Bug 6 (no embedded body, no pass lines, language fence)`

### Bug 8
7. `fix(acceptance/hardening): use storyIds list and storiesProcessed for multi-story attribution`
8. `fix(pipeline/acceptance): remove duplicate Hardening pass complete/failed log emits`
9. `test(acceptance): regression coverage for Bug 8 (single emit per invocation, multi-story attribution)`

PR title: `refactor(acceptance): language-agnostic fix prompts + hardening log hygiene`

---

## Follow-ups (separate PRs)

- **F1** — Apply the same `formatTestOutputForFix` helper to `RectifierPromptBuilder` (review/autofix path). Two sites at [`rectifier-builder.ts:112,363`](../../src/prompts/builders/rectifier-builder.ts) currently use a 4000-char raw truncation. Same anti-pattern, same fix, smaller blast radius.
- **F2** — Extend per-runner parsers in `src/test-runners/` to capture multi-line "Expected: X, Received: Y" diff blocks alongside the single-line `error`. `TestFailure` shape would gain an optional `diffBlock?: string` field. Worth doing if F0 monitoring reveals fixes failing because the agent lacks diff context.
- **F3** — Move `fenceLangFor` into `src/test-runners/conventions.ts` if other prompt builders need it (rectifier-builder, debate-builder probably do). One SSOT for code-fence lang derivation.
- **F4** — Audit other prompt builders (`debate-builder`, `tdd-builder`) for the same hardcoded `typescript` fence + raw output anti-pattern. Bounded follow-up after F1.
