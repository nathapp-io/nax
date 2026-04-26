# ADR-018 Wave 3 — Phase A Detailed Plan

**Date:** 2026-04-26
**Phase:** A — Acceptance ops ×4 + rectifier/acceptance builder slot migrations
**Tracking doc:** `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md`
**Status:** Ready to implement

---

## Scope

Phase A creates 4 acceptance ops (routing the LLM calls through `callOp`) and migrates the
`AcceptancePromptBuilder` and `RectifierPromptBuilder` to expose slot methods. Callers in
`acceptance-setup.ts` (stage) and `acceptance-fix.ts` (lifecycle) are updated to use `callOp`.

---

## Correction: op kinds (tracking doc has a kind inversion)

The Wave 3 tracking doc listed wrong `kind` values. Verified against actual callers:

| Op | Tracking doc | Correct | Evidence |
|:---|:---|:---|:---|
| `acceptance-generate` | `run` | **`complete`** | `generator.ts:214` — `manager.completeWithFallback()` |
| `acceptance-refine` | `run` | **`complete`** | `refinement.ts:121` — `manager.completeWithFallback()` |
| `acceptance-diagnose` | `complete` | **`run`** | `fix-diagnosis.ts:96` — `agentManager.run()` with `sessionRole: "diagnose"` |
| `acceptance-fix-source` | `run` | **`run`** | `fix-executor.ts:56` — `agentManager.run()` with `sessionRole: "source-fix"` |
| `acceptance-fix-test` | `run` | **`run`** | `fix-executor.ts:126` — `agentManager.run()` with `sessionRole: "test-fix"` |

Update the tracking doc in T10 after all phases pass.

---

## File Map

### New files

| File | Purpose |
|:---|:---|
| `src/operations/acceptance-generate.ts` | `acceptanceGenerateOp` — kind: `complete`, jsonMode: false |
| `src/operations/acceptance-refine.ts` | `acceptanceRefineOp` — kind: `complete`, jsonMode: true |
| `src/operations/acceptance-diagnose.ts` | `acceptanceDiagnoseOp` — kind: `run`, role: `"diagnose"` |
| `src/operations/acceptance-fix.ts` | `acceptanceFixSourceOp` + `acceptanceFixTestOp` — both kind: `run` |
| `test/unit/operations/acceptance-generate.test.ts` | Shape + parse contract tests |
| `test/unit/operations/acceptance-refine.test.ts` | Shape + parse contract tests |
| `test/unit/operations/acceptance-diagnose.test.ts` | Shape + parse contract tests |
| `test/unit/operations/acceptance-fix.test.ts` | Shape + parse contract tests for both fix ops |

### Modified files

| File | Change |
|:---|:---|
| `src/operations/index.ts` | Export 4 new op files (5 exported op objects) |
| `src/acceptance/generator.ts` | `extractTestCode` is already exported — no change needed |
| `src/acceptance/fix-diagnosis.ts` | Export `parseSourceFiles()` helper (lifted from `diagnoseAcceptanceFailure`) |
| `src/prompts/builders/acceptance-builder.ts` | Add slot methods; verify no ContextBundle/loadConstitution/loadStaticRules imports |
| `src/prompts/builders/rectifier-builder.ts` | Slot migration: audit full file (lines 200–720), extract large static methods into named slot helpers, de-async `build()` |
| `src/pipeline/stages/acceptance-setup.ts` | Replace `_acceptanceSetupDeps.refine()` / `generate()` with `callOp` |
| `src/execution/lifecycle/acceptance-fix.ts` | Replace `diagnoseAcceptanceFailure` / `executeSourceFix` / `executeTestFix` with `callOp` |

---

## Pre-flight

```bash
bun run typecheck   # must be clean before starting
bun run test        # must be green before starting
```

Read the full rectifier-builder before T6:
```bash
wc -l src/prompts/builders/rectifier-builder.ts
# expect ~720 lines — read lines 200–720 to understand all static methods
```

---

## Anti-patterns to avoid

- **AP-1**: Do not redefine types that exist in `src/acceptance/types.ts`
- **AP-2**: Do not copy-paste prompt constants — import from builder; never write inline prompt strings in `src/operations/`
- **AP-3**: Use `parseLLMJson<T>()` in `parse()` for JSON output — no hand-rolled fence stripping
- **AP-4**: `build()` must be synchronous and side-effect-free — all async pre-processing (file reads) belongs in the caller, passed via op input

---

## Task Sequence

---

### T1 — Write RED shape tests for all 4 op files

**Goal:** establish the contract before implementation. Tests fail with import errors (files don't exist yet).

**Template:** `test/unit/operations/classify-route.test.ts`

#### `test/unit/operations/acceptance-generate.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { acceptanceGenerateOp } from "../../../src/operations/acceptance-generate";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { BuildContext } from "../../../src/operations/types";

const ctx: BuildContext<typeof DEFAULT_CONFIG["acceptance"]> = {
  packageView: {} as never,
  config: DEFAULT_CONFIG.acceptance,
};

const SAMPLE_INPUT = {
  featureName: "my-feature",
  criteriaList: "AC-1: do X",
  frameworkOverrideLine: "",
  targetTestFilePath: "/tmp/acceptance.test.ts",
};

describe("acceptanceGenerateOp shape", () => {
  test("kind is complete", () => expect(acceptanceGenerateOp.kind).toBe("complete"));
  test("name is acceptance-generate", () => expect(acceptanceGenerateOp.name).toBe("acceptance-generate"));
  test("jsonMode is false", () => expect((acceptanceGenerateOp as any).jsonMode).toBe(false));
  test("stage is acceptance", () => expect(acceptanceGenerateOp.stage).toBe("acceptance"));
});

describe("acceptanceGenerateOp.build()", () => {
  test("returns ComposeInput with at least one section", () => {
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
  test("task section contains featureName", () => {
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    const sections = Object.values(result) as Array<{ content: string }>;
    const allContent = sections.map((s) => s.content).join("\n");
    expect(allContent).toContain("my-feature");
  });
});

describe("acceptanceGenerateOp.parse()", () => {
  test("extracts test code from fenced block", () => {
    const output = "Here is the code:\n```typescript\nconst x = 1;\n```";
    const result = acceptanceGenerateOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result.testCode).toContain("const x = 1");
  });
  test("returns null testCode when no code block present", () => {
    const result = acceptanceGenerateOp.parse("no code here", SAMPLE_INPUT, ctx);
    expect(result.testCode).toBeNull();
  });
});
```

#### `test/unit/operations/acceptance-refine.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { acceptanceRefineOp } from "../../../src/operations/acceptance-refine";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { BuildContext } from "../../../src/operations/types";

const ctx: BuildContext<typeof DEFAULT_CONFIG["acceptance"]> = {
  packageView: {} as never,
  config: DEFAULT_CONFIG.acceptance,
};

const SAMPLE_INPUT = {
  criteria: ["User can log in", "User can log out"],
  codebaseContext: "# Context\n...",
  storyId: "US-001",
};

describe("acceptanceRefineOp shape", () => {
  test("kind is complete", () => expect(acceptanceRefineOp.kind).toBe("complete"));
  test("name is acceptance-refine", () => expect(acceptanceRefineOp.name).toBe("acceptance-refine"));
  test("jsonMode is true", () => expect((acceptanceRefineOp as any).jsonMode).toBe(true));
});

describe("acceptanceRefineOp.build()", () => {
  test("returns ComposeInput with at least one section", () => {
    const result = acceptanceRefineOp.build(SAMPLE_INPUT, ctx);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
  test("content contains criteria text", () => {
    const result = acceptanceRefineOp.build(SAMPLE_INPUT, ctx);
    const sections = Object.values(result) as Array<{ content: string }>;
    const allContent = sections.map((s) => s.content).join("\n");
    expect(allContent).toContain("User can log in");
  });
});

describe("acceptanceRefineOp.parse()", () => {
  test("parses valid JSON array of RefinedCriterion", () => {
    const json = JSON.stringify([
      { original: "User can log in", refined: "login() returns true for valid credentials", testable: true, storyId: "US-001" },
    ]);
    const result = acceptanceRefineOp.parse(json, SAMPLE_INPUT, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].refined).toContain("login()");
  });
  test("falls back to original criteria on malformed JSON", () => {
    const result = acceptanceRefineOp.parse("not json", SAMPLE_INPUT, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].original).toBe("User can log in");
  });
});
```

#### `test/unit/operations/acceptance-diagnose.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { acceptanceDiagnoseOp } from "../../../src/operations/acceptance-diagnose";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { BuildContext } from "../../../src/operations/types";

const ctx: BuildContext<typeof DEFAULT_CONFIG["acceptance"]> = {
  packageView: {} as never,
  config: DEFAULT_CONFIG.acceptance,
};

const SAMPLE_INPUT = {
  testOutput: "FAIL: expected 1 but got 2",
  testFileContent: "test('x', () => expect(fn()).toBe(1))",
  sourceFiles: [{ path: "src/fn.ts", content: "export function fn() { return 2; }" }],
};

describe("acceptanceDiagnoseOp shape", () => {
  test("kind is run", () => expect(acceptanceDiagnoseOp.kind).toBe("run"));
  test("name is acceptance-diagnose", () => expect(acceptanceDiagnoseOp.name).toBe("acceptance-diagnose"));
  test("session.role is diagnose", () => expect(acceptanceDiagnoseOp.session.role).toBe("diagnose"));
  test("session.lifetime is fresh", () => expect(acceptanceDiagnoseOp.session.lifetime).toBe("fresh"));
});

describe("acceptanceDiagnoseOp.build()", () => {
  test("returns ComposeInput with at least one section", () => {
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
  test("content contains test output", () => {
    const result = acceptanceDiagnoseOp.build(SAMPLE_INPUT, ctx);
    const sections = Object.values(result) as Array<{ content: string }>;
    const allContent = sections.map((s) => s.content).join("\n");
    expect(allContent).toContain("FAIL: expected 1 but got 2");
  });
});

describe("acceptanceDiagnoseOp.parse()", () => {
  test("parses valid JSON diagnosis result", () => {
    const json = JSON.stringify({ verdict: "source_bug", reasoning: "fn returns wrong value", confidence: 0.9 });
    const result = acceptanceDiagnoseOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(0.9);
  });
  test("falls back to source_bug on malformed JSON", () => {
    const result = acceptanceDiagnoseOp.parse("could not diagnose", SAMPLE_INPUT, ctx);
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(0);
  });
});
```

#### `test/unit/operations/acceptance-fix.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { acceptanceFixSourceOp, acceptanceFixTestOp } from "../../../src/operations/acceptance-fix";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { BuildContext } from "../../../src/operations/types";

const ctx: BuildContext<typeof DEFAULT_CONFIG["acceptance"]> = {
  packageView: {} as never,
  config: DEFAULT_CONFIG.acceptance,
};

const SOURCE_INPUT = {
  testOutput: "FAIL: expected true but got false",
  diagnosisReasoning: "fn returns wrong value",
  acceptanceTestPath: "/tmp/acceptance.test.ts",
};

const TEST_INPUT = {
  testOutput: "FAIL: import not found",
  diagnosisReasoning: "test imports wrong path",
  failedACs: ["AC-1"],
  acceptanceTestPath: "/tmp/acceptance.test.ts",
};

describe("acceptanceFixSourceOp shape", () => {
  test("kind is run", () => expect(acceptanceFixSourceOp.kind).toBe("run"));
  test("name is acceptance-fix-source", () => expect(acceptanceFixSourceOp.name).toBe("acceptance-fix-source"));
  test("session.role is source-fix", () => expect(acceptanceFixSourceOp.session.role).toBe("source-fix"));
});

describe("acceptanceFixSourceOp.build()", () => {
  test("returns ComposeInput containing diagnosis reasoning", () => {
    const result = acceptanceFixSourceOp.build(SOURCE_INPUT, ctx);
    const sections = Object.values(result) as Array<{ content: string }>;
    const allContent = sections.map((s) => s.content).join("\n");
    expect(allContent).toContain("fn returns wrong value");
  });
});

describe("acceptanceFixSourceOp.parse()", () => {
  test("always returns applied: true (success is implicit if no throw)", () => {
    const result = acceptanceFixSourceOp.parse("Fix applied.", SOURCE_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
});

describe("acceptanceFixTestOp shape", () => {
  test("kind is run", () => expect(acceptanceFixTestOp.kind).toBe("run"));
  test("name is acceptance-fix-test", () => expect(acceptanceFixTestOp.name).toBe("acceptance-fix-test"));
  test("session.role is test-fix", () => expect(acceptanceFixTestOp.session.role).toBe("test-fix"));
});

describe("acceptanceFixTestOp.build()", () => {
  test("returns ComposeInput containing failedACs", () => {
    const result = acceptanceFixTestOp.build(TEST_INPUT, ctx);
    const sections = Object.values(result) as Array<{ content: string }>;
    const allContent = sections.map((s) => s.content).join("\n");
    expect(allContent).toContain("AC-1");
  });
});

describe("acceptanceFixTestOp.parse()", () => {
  test("always returns applied: true", () => {
    const result = acceptanceFixTestOp.parse("Fix applied.", TEST_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
});
```

Run all 4 test files — expect RED (import errors):
```bash
timeout 30 bun test test/unit/operations/acceptance-generate.test.ts test/unit/operations/acceptance-refine.test.ts test/unit/operations/acceptance-diagnose.test.ts test/unit/operations/acceptance-fix.test.ts --timeout=5000
```

Commit: `test: add RED shape tests for acceptance ops (Wave 3 Phase A)`

---

### T2 — Create `acceptance-generate` op

**Design decisions:**
- `build()` wraps the full builder output as a single `task` section (slot extraction deferred to T5)
- `parse()` calls `extractTestCode()` which is already exported from `generator.ts`
- Output carries `{ testCode: string | null }` — the caller handles null (agent-written file recovery, skeleton fallback)

**`src/operations/acceptance-generate.ts`:**

```typescript
import { pickSelector } from "../config";
import type { NaxConfig } from "../config";
import { extractTestCode } from "../acceptance/generator";
import { AcceptancePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface AcceptanceGenerateInput {
  featureName: string;
  criteriaList: string;
  frameworkOverrideLine: string;
  targetTestFilePath: string;
  implementationContext?: string;
  previousFailure?: string;
}

export interface AcceptanceGenerateOutput {
  testCode: string | null;
}

type AcceptanceSlice = Pick<NaxConfig, "acceptance">;

export const acceptanceGenerateOp: CompleteOperation<
  AcceptanceGenerateInput,
  AcceptanceGenerateOutput,
  AcceptanceSlice
> = {
  kind: "complete",
  name: "acceptance-generate",
  stage: "acceptance",
  jsonMode: false,
  config: pickSelector("acceptance-generate", "acceptance"),
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
      featureName: input.featureName,
      criteriaList: input.criteriaList,
      frameworkOverrideLine: input.frameworkOverrideLine,
      targetTestFilePath: input.targetTestFilePath,
      implementationContext: input.implementationContext,
      previousFailure: input.previousFailure,
    });
    return {
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return { testCode: extractTestCode(output) };
  },
};
```

**Verify tests pass (GREEN):**
```bash
timeout 30 bun test test/unit/operations/acceptance-generate.test.ts --timeout=5000
timeout 30 bun test test/unit/operations/classify-route.test.ts --timeout=5000  # regression
```

**Typecheck:**
```bash
bun run typecheck
```

Commit: `feat(adr-018): add acceptance-generate op (kind: complete)`

---

### T3 — Create `acceptance-refine` op

**Design decisions:**
- `parse()` delegates to `parseRefinementResponse()` which must be exported from `refinement.ts`
- Falls back gracefully to original criteria on malformed JSON (existing behavior preserved)
- `AcceptanceRefineInput` carries criteria strings and context (no file I/O in `build()`)

**Export `parseRefinementResponse` from `src/acceptance/refinement.ts`** (already defined there).

**`src/operations/acceptance-refine.ts`:**

```typescript
import { pickSelector } from "../config";
import type { NaxConfig } from "../config";
import { parseRefinementResponse } from "../acceptance/refinement";
import { AcceptancePromptBuilder } from "../prompts";
import type { RefinedCriterion } from "../acceptance/types";
import type { CompleteOperation } from "./types";

export interface AcceptanceRefineInput {
  criteria: string[];
  codebaseContext: string;
  storyId: string;
  testStrategy?: string;
  testFramework?: string;
  storyTitle?: string;
  storyDescription?: string;
}

type AcceptanceSlice = Pick<NaxConfig, "acceptance">;

export const acceptanceRefineOp: CompleteOperation<
  AcceptanceRefineInput,
  RefinedCriterion[],
  AcceptanceSlice
> = {
  kind: "complete",
  name: "acceptance-refine",
  stage: "acceptance",
  jsonMode: true,
  config: pickSelector("acceptance-refine", "acceptance"),
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildRefinementPrompt(
      input.criteria,
      input.codebaseContext,
      {
        testStrategy: input.testStrategy as never,
        testFramework: input.testFramework,
        storyTitle: input.storyTitle,
        storyDescription: input.storyDescription,
      },
    );
    return {
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    return parseRefinementResponse(output, input.criteria);
  },
};
```

**Verify tests pass (GREEN):**
```bash
timeout 30 bun test test/unit/operations/acceptance-refine.test.ts --timeout=5000
```

Commit: `feat(adr-018): add acceptance-refine op (kind: complete)`

---

### T4 — Create `acceptance-diagnose` op

**Design decisions:**
- `kind: "run"` — diagnosis is a full interactive session
- `build()` is synchronous — source file content must be pre-loaded by the caller and passed in `sourceFiles`
- The source file loading logic currently inside `diagnoseAcceptanceFailure()` must be lifted to the caller
- Export `loadSourceFilesForDiagnosis()` from `fix-diagnosis.ts` for reuse by the caller

**Changes to `src/acceptance/fix-diagnosis.ts`:**
- Extract `parseImportStatements()`, `resolveImportPaths()`, `readSourceFileContent()` into a single exported async helper:
  ```typescript
  export async function loadSourceFilesForDiagnosis(
    testFileContent: string,
    workdir: string,
  ): Promise<{ path: string; content: string }[]>
  ```
- Keep `parseDiagnosisResult()` exported (already handles malformed JSON gracefully)

**`src/operations/acceptance-diagnose.ts`:**

```typescript
import { pickSelector } from "../config";
import type { NaxConfig } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import { parseLLMJson } from "../utils/llm-json";
import type { DiagnosisResult, SemanticVerdict } from "../acceptance/types";
import type { RunOperation } from "./types";

export interface AcceptanceDiagnoseInput {
  testOutput: string;
  testFileContent: string;
  sourceFiles: { path: string; content: string }[];
  semanticVerdicts?: SemanticVerdict[];
  previousFailure?: string;
}

const FALLBACK_DIAGNOSIS: Omit<DiagnosisResult, "cost"> = {
  verdict: "source_bug",
  reasoning: "diagnosis failed — falling back to source fix",
  confidence: 0,
};

type AcceptanceSlice = Pick<NaxConfig, "acceptance">;

export const acceptanceDiagnoseOp: RunOperation<
  AcceptanceDiagnoseInput,
  DiagnosisResult,
  AcceptanceSlice
> = {
  kind: "run",
  name: "acceptance-diagnose",
  stage: "acceptance",
  session: { role: "diagnose", lifetime: "fresh" },
  config: pickSelector("acceptance-diagnose", "acceptance"),
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildDiagnosisPrompt({
      testOutput: input.testOutput,
      testFileContent: input.testFileContent,
      sourceFiles: input.sourceFiles,
      semanticVerdicts: input.semanticVerdicts,
      previousFailure: input.previousFailure,
    });
    return {
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = parseLLMJson<Record<string, unknown>>(output);
    if (
      raw &&
      typeof raw.verdict === "string" &&
      typeof raw.reasoning === "string" &&
      typeof raw.confidence === "number"
    ) {
      return {
        verdict: raw.verdict as DiagnosisResult["verdict"],
        reasoning: raw.reasoning,
        confidence: raw.confidence,
        testIssues: Array.isArray(raw.testIssues) ? (raw.testIssues as string[]) : undefined,
        sourceIssues: Array.isArray(raw.sourceIssues) ? (raw.sourceIssues as string[]) : undefined,
      };
    }
    return { ...FALLBACK_DIAGNOSIS };
  },
};
```

**Note:** `parseLLMJson` from `src/utils/llm-json` returns `T | null`. The parse above uses it directly (AP-3 compliant).

**Verify tests pass (GREEN):**
```bash
timeout 30 bun test test/unit/operations/acceptance-diagnose.test.ts --timeout=5000
```

Commit: `feat(adr-018): add acceptance-diagnose op (kind: run)`

---

### T5 — Create `acceptance-fix.ts` (two ops in one file)

**Design decisions:**
- `acceptanceFixSourceOp` and `acceptanceFixTestOp` share one file (both are fix ops)
- `parse()` returns `{ applied: true }` — success is implicit (no throw means run succeeded)
- Caller re-runs tests to determine real success; `applied` just signals the agent completed

**`src/operations/acceptance-fix.ts`:**

```typescript
import { pickSelector } from "../config";
import type { NaxConfig } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import type { RunOperation } from "./types";

export interface AcceptanceFixSourceInput {
  testOutput: string;
  diagnosisReasoning: string;
  acceptanceTestPath: string;
  testFileContent?: string;
}

export interface AcceptanceFixTestInput {
  testOutput: string;
  diagnosisReasoning: string;
  failedACs: string[];
  acceptanceTestPath: string;
  testFileContent?: string;
  previousFailure?: string;
}

export interface AcceptanceFixOutput {
  applied: true;
}

type AcceptanceSlice = Pick<NaxConfig, "acceptance">;

export const acceptanceFixSourceOp: RunOperation<
  AcceptanceFixSourceInput,
  AcceptanceFixOutput,
  AcceptanceSlice
> = {
  kind: "run",
  name: "acceptance-fix-source",
  stage: "acceptance",
  session: { role: "source-fix", lifetime: "fresh" },
  config: pickSelector("acceptance-fix-source", "acceptance"),
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
      testOutput: input.testOutput,
      diagnosisReasoning: input.diagnosisReasoning,
      acceptanceTestPath: input.acceptanceTestPath,
      testFileContent: input.testFileContent,
    });
    return {
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};

export const acceptanceFixTestOp: RunOperation<
  AcceptanceFixTestInput,
  AcceptanceFixOutput,
  AcceptanceSlice
> = {
  kind: "run",
  name: "acceptance-fix-test",
  stage: "acceptance",
  session: { role: "test-fix", lifetime: "fresh" },
  config: pickSelector("acceptance-fix-test", "acceptance"),
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildTestFixPrompt({
      testOutput: input.testOutput,
      diagnosisReasoning: input.diagnosisReasoning,
      failedACs: input.failedACs,
      acceptanceTestPath: input.acceptanceTestPath,
      testFileContent: input.testFileContent,
      previousFailure: input.previousFailure,
    });
    return {
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(_output, _input, _ctx) {
    return { applied: true };
  },
};
```

**Verify tests pass (GREEN):**
```bash
timeout 30 bun test test/unit/operations/acceptance-fix.test.ts --timeout=5000
```

**Export all ops from `src/operations/index.ts`:**

```typescript
export { acceptanceGenerateOp } from "./acceptance-generate";
export { acceptanceRefineOp } from "./acceptance-refine";
export { acceptanceDiagnoseOp } from "./acceptance-diagnose";
export { acceptanceFixSourceOp, acceptanceFixTestOp } from "./acceptance-fix";
export type { AcceptanceGenerateInput, AcceptanceGenerateOutput } from "./acceptance-generate";
export type { AcceptanceRefineInput } from "./acceptance-refine";
export type { AcceptanceDiagnoseInput } from "./acceptance-diagnose";
export type { AcceptanceFixSourceInput, AcceptanceFixTestInput, AcceptanceFixOutput } from "./acceptance-fix";
```

**Typecheck:**
```bash
bun run typecheck
```

Commit: `feat(adr-018): add acceptance-fix-source and acceptance-fix-test ops`

---

### T6 — `AcceptancePromptBuilder` slot migration

**Goal:** Verify no forbidden imports; expose slot methods for each logical section.

**Read the full file:**
```bash
wc -l src/prompts/builders/acceptance-builder.ts  # expect ~379 lines
```

**Check for forbidden imports:**
```bash
grep -n "ContextBundle\|loadConstitution\|loadStaticRules" src/prompts/builders/acceptance-builder.ts
# expect: no matches
```

The acceptance-builder is already clean. The slot migration means exposing the inner sections of each monolithic `build*Prompt()` method as named methods so plugins can override individual sections.

**Pattern to follow:** (see `RectifierPromptBuilder` fluent API at lines 53–117 of `rectifier-builder.ts`)

For each builder method that assembles a multi-section prompt:
1. Extract each logical section into a method: `roleSection()`, `taskSection()`, `criteriaSection()`, etc.
2. The main `build*Prompt()` method composes them

**Minimal slot exposure for Phase A** (callers don't need plugin override yet, just routing):
- The monolithic methods can remain as-is for now
- Add a `// slot: <name>` comment to each section for Phase B/C plugin wiring
- No behavior change required in this task — just verify cleanliness

If the file exceeds the 400-line limit after adding slots, split by method group.

Commit: `refactor(adr-018): verify acceptance-builder cleanliness; mark slot boundaries`

---

### T7 — `RectifierPromptBuilder` slot migration

**Goal:** Audit the full 720-line file, reduce to ~200 lines by extracting large static methods.

**Read remaining lines:**
```bash
# Read lines 200–720 to understand the full surface
```

**Expected static methods to audit** (lines 127+):
- `firstAttemptDelta()` (~30 lines) — inline delta prompt assembly
- `continuation()` (~30 lines) — retry continuation prompt
- `swapHandoff()` — swap handoff prompt (if present)
- `testWriterRectification()` — TDD test-writer rectification
- `noOpReprompt()` — no-op reprompt
- `escalated()` — escalation prompt
- Any `rectifierTaskFor()` helper and the large `PromptSection` switch

**Migration strategy:**

1. Confirm `build()` is already effectively sync (it wraps `Promise.resolve(this.acc.join())`) — can be changed to return `string` directly
2. Extract each large static method into a module-level helper or into `src/prompts/sections/rectifier-sections.ts` if > 50 lines
3. After extraction, `rectifier-builder.ts` should contain only: the class definition, the fluent slot methods, and short delegating static methods
4. Verify no imports of `ContextBundle`, `loadConstitution`, `loadStaticRules`
5. Confirm the existing slot methods (`.constitution()`, `.context()`, `.story()`, etc.) pass their args through unchanged

**Check forbidden imports:**
```bash
grep -n "ContextBundle\|loadConstitution\|loadStaticRules" src/prompts/builders/rectifier-builder.ts
# expect: no matches — universalConstitutionSection/universalContextSection are from ../core, not the banned list
```

**Run related tests after each extraction step:**
```bash
timeout 30 bun test test/unit/prompts/ --timeout=5000
```

**File size constraint:** if `rectifier-builder.ts` still exceeds 400 lines after extraction, split by concern into `rectifier-builder.ts` (fluent builder) + `rectifier-prompts.ts` (static helpers).

Commit: `refactor(adr-018): slot-migrate RectifierPromptBuilder (reduce to ~200 lines)`

---

### T8 — Update `acceptance-setup.ts` caller

**Goal:** Replace `_acceptanceSetupDeps.refine()` and `generate()` with `callOp`.

**Construct `CallContext` in the stage:**

```typescript
// Helper — build CallContext from PipelineContext at acceptance stage
function acceptanceCallCtx(ctx: PipelineContext): CallContext {
  if (!ctx.runtime) throw new NaxError("runtime is required", "CALL_OP_NO_RUNTIME", { stage: "acceptance" });
  if (!ctx.packageView) throw new NaxError("packageView is required", "CALL_OP_NO_PACKAGE_VIEW", { stage: "acceptance" });
  return {
    runtime: ctx.runtime,
    packageView: ctx.packageView,
    packageDir: ctx.packageDir,
    storyId: ctx.story.id,
    featureName: ctx.prd.feature,
    agentName: ctx.agentManager?.getDefault() ?? "claude",
  };
}
```

**Replace `_acceptanceSetupDeps.refine()` call** (lines ~256–268):

```typescript
// Before
const refined = await _acceptanceSetupDeps.refine(story.acceptanceCriteria, { ... });

// After
const callCtx = acceptanceCallCtx(ctx);
const refined = await callOp(callCtx, acceptanceRefineOp, {
  criteria: story.acceptanceCriteria,
  codebaseContext: "",
  storyId: story.id,
  testStrategy: ctx.config.acceptance.testStrategy as string | undefined,
  testFramework: ctx.config.acceptance.testFramework,
});
// refined is now RefinedCriterion[]
```

**Replace `_acceptanceSetupDeps.generate()` call** (lines ~300+):

```typescript
// Before
const result = await _acceptanceSetupDeps.generate(groupStories, groupRefined, { ... });

// After
const criteriaList = groupRefined.map((c, i) => `AC-${i + 1}: ${c.refined}`).join("\n");
const genResult = await callOp(callCtx, acceptanceGenerateOp, {
  featureName: ctx.prd.feature,
  criteriaList,
  frameworkOverrideLine: ctx.config.acceptance.testFramework
    ? `\n[FRAMEWORK OVERRIDE: Use ${ctx.config.acceptance.testFramework} as the test framework regardless of what you detect.]`
    : "",
  targetTestFilePath: testPath,
  implementationContext: buildImplementationContext(ctx),
  previousFailure: group.previousFailure,
});

// genResult.testCode is string | null — preserve existing null handling (agent-written file recovery + skeleton fallback)
if (!genResult.testCode) {
  // check if agent wrote the file directly
  const existing = await Bun.file(testPath).text().catch(() => null);
  const testCode = existing ? extractTestCode(existing) : null;
  // ... existing recovery logic
}
```

**Remove `refine` and `generate` from `_acceptanceSetupDeps`** once all callers are migrated.

**Check `acceptance/hardening.ts`:** Uses `_acceptanceSetupDeps` indirectly via `_generatorPRDDeps`. Verify it still works after the stage change. Do NOT change `hardening.ts` in this phase.

**Run targeted tests:**
```bash
timeout 30 bun test test/unit/pipeline/stages/acceptance-setup.test.ts --timeout=5000
```

Commit: `refactor(adr-018): wire acceptance-setup stage through callOp for refine+generate`

---

### T9 — Update `acceptance-fix.ts` lifecycle caller

**Goal:** Replace `diagnoseAcceptanceFailure`, `executeSourceFix`, `executeTestFix` with `callOp`.

**Important:** `diagnoseAcceptanceFailure` currently loads source files asynchronously before calling the agent. This I/O must be lifted to the caller (pre-loading before `callOp`) since `build()` must be synchronous.

**Step 1:** Export `loadSourceFilesForDiagnosis()` from `src/acceptance/fix-diagnosis.ts`:

```typescript
export async function loadSourceFilesForDiagnosis(
  testFileContent: string,
  workdir: string,
): Promise<{ path: string; content: string }[]> {
  const imports = parseImportStatements(testFileContent);
  const relativeImports = resolveImportPaths(imports, workdir);
  const results = await Promise.all(relativeImports.map((imp) => readSourceFileContent(imp, workdir)));
  return results.filter((f): f is { path: string; content: string } => f !== null);
}
```

**Step 2:** Build `CallContext` in `acceptance-fix.ts` lifecycle:

```typescript
function fixCallCtx(ctx: AcceptanceLoopContext): CallContext {
  if (!ctx.runtime) throw new NaxError("runtime required", "CALL_OP_NO_RUNTIME", { stage: "acceptance" });
  if (!ctx.packageView) throw new NaxError("packageView required", "CALL_OP_NO_PACKAGE_VIEW", { stage: "acceptance" });
  return {
    runtime: ctx.runtime,
    packageView: ctx.packageView,
    packageDir: ctx.packageDir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    agentName: ctx.agentManager?.getDefault() ?? "claude",
  };
}
```

**Step 3:** Replace `resolveAcceptanceDiagnosis()` internal call to `diagnoseAcceptanceFailure()`:

```typescript
// Before
const diagnosis = await diagnoseAcceptanceFailure(agentManager, { testOutput, testFileContent, config, workdir, ... });

// After
const sourceFiles = await loadSourceFilesForDiagnosis(diagnosisOpts.testFileContent, diagnosisOpts.workdir);
const diagnosis = await callOp(fixCallCtx(ctx), acceptanceDiagnoseOp, {
  testOutput: diagnosisOpts.testOutput,
  testFileContent: diagnosisOpts.testFileContent,
  sourceFiles,
  semanticVerdicts,
  previousFailure,
});
```

**Step 4:** Replace `applyFix()` internal calls:

```typescript
// Before — source fix
const result = await executeSourceFix(agentManager, { testOutput, diagnosisReasoning, ... });
return { success: result.success, cost: result.cost };

// After
await callOp(fixCallCtx(ctx), acceptanceFixSourceOp, {
  testOutput,
  diagnosisReasoning: diagnosis.reasoning,
  acceptanceTestPath,
  testFileContent,
});
return { success: true, cost: 0 };  // cost tracking TBD Wave 4

// Before — test fix
const result = await executeTestFix(agentManager, { testOutput, diagnosisReasoning, failedACs, ... });

// After
await callOp(fixCallCtx(ctx), acceptanceFixTestOp, {
  testOutput,
  diagnosisReasoning: diagnosis.reasoning,
  failedACs,
  acceptanceTestPath,
  testFileContent,
  previousFailure,
});
```

**Note on cost tracking:** The old `executeSourceFix` / `executeTestFix` returned `{ success, cost }`. `callOp` for `kind: "run"` ops does not currently surface cost. Return `{ success: true, cost: 0 }` for now; cost is a Wave 4 concern.

**Run targeted tests:**
```bash
timeout 30 bun test test/unit/execution/lifecycle/acceptance-fix.test.ts --timeout=5000
```

Commit: `refactor(adr-018): wire acceptance-fix lifecycle through callOp for diagnose+fix`

---

### T10 — Final gates

**Full typecheck:**
```bash
bun run typecheck
```

**Full test suite:**
```bash
bun run test
```

**Lint:**
```bash
bun run lint
```

**Manual audit:**
```bash
grep -rn "ContextBundle\|loadConstitution\|loadStaticRules" src/prompts/builders/
# expect: 0 matches

grep -rn "diagnosisOpts.workdir\|diagnoseAcceptanceFailure\|executeSourceFix\|executeTestFix" src/execution/
# expect: 0 matches from new callOp sites
```

**Update tracking doc:**
Update `docs/superpowers/plans/2026-04-26-adr-018-wave-3.md` Phase A table:
- Correct the kind column (generate→complete, refine→complete, diagnose→run)
- Mark Phase A status: `Done | PR#___`

Commit: `docs: update Wave 3 Phase A tracking — correct op kinds, mark done`

---

## Exit Criteria Checklist

- [ ] 4 acceptance ops route through `callOp` (`acceptance-generate`, `acceptance-refine`, `acceptance-diagnose`, `acceptance-fix-source`, `acceptance-fix-test`)
- [ ] No builder imports `ContextBundle`, `loadConstitution`, or `loadStaticRules`
- [ ] `rectifier-builder.ts` exposes slot methods; no monolithic build methods (or clearly marked for Phase B)
- [ ] `acceptance-setup.ts` uses `callOp` for refine and generate (no direct function calls)
- [ ] `acceptance-fix.ts` lifecycle uses `callOp` for diagnose, source-fix, test-fix
- [ ] `loadSourceFilesForDiagnosis()` exported from `fix-diagnosis.ts` (lifted from internal)
- [ ] `_acceptanceSetupDeps.refine` and `_acceptanceSetupDeps.generate` removed (or deprecated with a comment if still needed by hardening.ts)
- [ ] `bun run typecheck` clean
- [ ] `bun run test` green
- [ ] `bun run lint` clean

---

## Risks & Mitigations

| Risk | Mitigation |
|:---|:---|
| `AcceptanceMeta` / agent-written file recovery logic breaks after callOp wiring | Keep fallback path in the caller (acceptance-setup.ts stage); `parse()` returns `{ testCode: string \| null }` for caller to handle |
| `acceptance/hardening.ts` still uses `generateFromPRD` / `refineAcceptanceCriteria` directly | Do not touch `hardening.ts` in Phase A — it uses `_generatorPRDDeps` which is independent; schedule for Phase B cleanup |
| Cost tracking regresses (old code returned `estimatedCost`) | Accept `cost: 0` for now in `applyFix()` return; cost threading through `callOp` is Wave 4 |
| Rectifier-builder slot migration breaks existing autofix callers | Run `timeout 30 bun test test/unit/prompts/ --timeout=5000` after each extraction step |

---

## Commit Sequence Summary

1. `test: add RED shape tests for acceptance ops (Wave 3 Phase A)` — T1
2. `feat(adr-018): add acceptance-generate op (kind: complete)` — T2
3. `feat(adr-018): add acceptance-refine op (kind: complete)` — T3
4. `feat(adr-018): add acceptance-diagnose op (kind: run)` — T4
5. `feat(adr-018): add acceptance-fix-source and acceptance-fix-test ops` — T5 (includes index export)
6. `refactor(adr-018): verify acceptance-builder cleanliness; mark slot boundaries` — T6
7. `refactor(adr-018): slot-migrate RectifierPromptBuilder (reduce to ~200 lines)` — T7
8. `refactor(adr-018): wire acceptance-setup stage through callOp for refine+generate` — T8
9. `refactor(adr-018): wire acceptance-fix lifecycle through callOp for diagnose+fix` — T9
10. `docs: update Wave 3 Phase A tracking — correct op kinds, mark done` — T10
