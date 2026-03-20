# BUG-072: Acceptance Test Generation Quality

**Status:** Spec approved  
**Component:** `src/acceptance/generator.ts`, `src/acceptance/fix-generator.ts`, `src/pipeline/stages/acceptance-setup.ts`, `src/execution/lifecycle/acceptance-loop.ts`  
**Found:** 2026-03-20 (koda/refactor-standard — 50 ACs, all skeleton stubs, fix loop produced zero fixes)

---

## Problem

When nax generates acceptance tests for a feature, the generated `acceptance.test.ts` contains only skeleton stubs (`expect(true).toBe(false)`) instead of real tests. The acceptance retry loop then generates fix stories targeting the **implementation** instead of the **test file**, producing zero progress across 10+ fix stories.

### Root Causes

1. **Empty codebase context (BUG-072B):** `acceptance-setup.ts` passes `codebaseContext: ""` to the generator. The LLM receives AC text but has zero project knowledge — no file tree, no imports, no module structure.

2. **Hardcoded adapter (BUG-072A):** `generator.ts` hardcodes `new ClaudeCodeAdapter()` regardless of the project's configured agent (acpx, aider, etc.). Projects using acpx get the wrong adapter for acceptance generation.

3. **No configurable timeout (BUG-072C):** ACP adapter `complete()` defaults to 2-minute timeout. For large projects (50+ ACs), this is insufficient. No `acceptance.timeoutMs` config exists.

4. **Hardcoded test framework (BUG-072D):** Generator prompt always emits `import { describe, test, expect } from "bun:test"` regardless of the project's actual framework (jest, vitest, pytest, go test, rspec).

5. **Fix loop blind to stubs (BUG-072E):** `acceptance-loop.ts` generates implementation-targeted fix stories when the real problem is the test file itself contains skeleton stubs.

6. **Weak prompt (BUG-072F):** The generator prompt is a single flat instruction with no step-by-step reasoning — unlike the ENH-006 plan prompt which uses a structured 3-step approach.

---

## Fix

### BUG-072A — Use configured agent, not hardcoded ClaudeCodeAdapter

**File:** `src/acceptance/generator.ts`

Remove the hardcoded `_generatorPRDDeps.adapter = new ClaudeCodeAdapter()`. Instead:
- `generateFromPRD()` accepts an `AgentAdapter` parameter (or uses `agentGetFn` from context)
- `acceptance-setup.ts` resolves the agent via `getAgent(config.autoMode.defaultAgent)` or `ctx.agentGetFn` and passes it through
- Fallback: if no agent resolved, use `ClaudeCodeAdapter` (backward compat)

### BUG-072B — Pass real codebase context

**File:** `src/pipeline/stages/acceptance-setup.ts`

Replace `codebaseContext: ""` with the project file tree scoped to the story's workdir:
- Read file tree from `ctx.workdir` (the story's working directory — correct for both single-repo and monorepo packages)
- Do NOT include `context.md` — that file is already consumed by the coding agent (e.g. generated into `claude.md`, `GEMINI.md`) and is not relevant to the acceptance generator
- Pass the file tree as `codebaseContext` to the generator

**Monorepo note:** `ctx.workdir` is already scoped to the package (e.g. `packages/api`) for package-scoped stories, so the file tree is naturally package-scoped. No additional handling needed.

### BUG-072C — Configurable timeout (default: 30 minutes)

**Files:** `src/config/schemas.ts`, `src/config/runtime-types.ts`, `src/config/defaults.ts`

Add `acceptance.timeoutMs` to schema:
```ts
timeoutMs: z.number().int().min(30000).max(3600000).default(1800000), // 30 min default
```

Pass `timeoutMs` through to `adapter.complete()` options in both `generateFromPRD()` and `generateAcceptanceTests()`.

### BUG-072D — Let LLM detect test framework from project files

**File:** `src/acceptance/generator.ts`

Remove hardcoded `bun:test` from the prompt. Instead, instruct the LLM to:
1. Examine project dependency files (`package.json`, `go.mod`, `Gemfile`, `pyproject.toml`, `Cargo.toml`)
2. Determine the test framework in use
3. Generate tests using that framework

If `acceptance.testFramework` is explicitly set in config, include it as an override hint in the prompt.

This is language-agnostic — works for JS/TS, Python, Go, Ruby, Rust without any detection logic in nax code.

### BUG-072E — Stub detection in fix loop

**File:** `src/execution/lifecycle/acceptance-loop.ts`

Before generating fix stories, check if the failure is a skeleton stub:
- Read `acceptance.test.ts` and check for `expect(true).toBe(false)` pattern
- If stubs detected → re-run the acceptance generator (with improved prompt) instead of generating fix stories
- If re-generation also produces stubs → escalate with clear message: "Acceptance test generation failed — manual implementation required"
- Only generate fix stories for **real** test failures (tests that have actual assertions but fail)

### BUG-072F — 3-step structured prompt (ENH-006 pattern)

**File:** `src/acceptance/generator.ts`

Replace the flat prompt with a structured 3-step approach. The prompt is **language-agnostic** — it does not assume TypeScript, bun, or any specific runtime.

```
You are a senior test engineer. Your task is to generate a complete acceptance test
file for the "${featureName}" feature.

## Step 1: Understand and Classify the Acceptance Criteria

Read each AC below and classify its verification type:
- **file-check**: Verify by reading source files (e.g. "no @nestjs/jwt imports",
  "file exists", "module registered", "uses registerAs pattern")
- **runtime-check**: Load and invoke code directly, assert on return values or behavior
- **integration-check**: Requires a running service (e.g. HTTP endpoint returns 200,
  11th request returns 429, database query succeeds)

ACCEPTANCE CRITERIA:
${criteriaList}

## Step 2: Explore the Project

Before writing any tests, examine the project to understand:
1. **Language and test framework** — check dependency manifests (package.json, go.mod,
   Gemfile, pyproject.toml, Cargo.toml, build.gradle, etc.) to identify the language
   and test runner (jest, vitest, bun:test, pytest, go test, rspec, JUnit, etc.)
2. **Existing test patterns** — read 1-2 existing test files to understand import style,
   describe/test/it conventions, assertion style, and available helpers or fixtures
3. **Project structure** — identify relevant source directories and module organization
   to determine correct import or load paths

PROJECT FILE TREE:
${codebaseContext}

[FRAMEWORK OVERRIDE: Use ${testFramework} regardless of what you detect.]
(only included when acceptance.testFramework is explicitly configured)

## Step 3: Generate the Acceptance Test File

Write the complete acceptance test file using the framework identified in Step 2.

Rules:
- **One test per AC**, named exactly "AC-N: <description>"
- **file-check ACs** → read source files using the language's standard file I/O,
  assert with string or regex checks. Do not start the application.
- **runtime-check ACs** → load or import the module directly and invoke it,
  assert on the return value or observable side effects
- **integration-check ACs** → use the language's HTTP client or existing test helpers;
  add a clear setup block (beforeAll/setup/TestMain/etc.) explaining what must be running
- **NEVER use placeholder assertions** — no always-passing or always-failing stubs,
  no TODO comments as the only content, no empty test bodies
- Every test MUST have real assertions that PASS when the feature is correctly
  implemented and FAIL when it is broken
- Output raw code only — no markdown fences, start directly with the language's
  import or package declaration
```

---

## Config Changes

```json
{
  "acceptance": {
    "enabled": true,
    "maxRetries": 3,
    "generateTests": true,
    "testPath": "acceptance.test.ts",
    "model": "balanced",
    "timeoutMs": 1800000,
    "testFramework": "jest",
    "refinement": true,
    "redGate": true
  }
}
```

| Field | Type | Default | Change |
|:------|:-----|:--------|:-------|
| `timeoutMs` | `number` | `1800000` (30 min) | **New** — configurable timeout for acceptance generation LLM call |
| `testFramework` | `string` | — | **Existing** — now used as LLM hint for test framework override |

---

## Files Changed

| File | Change |
|:-----|:-------|
| `src/acceptance/generator.ts` | New 3-step prompt, accept adapter param, pass timeoutMs + workdir to complete(), remove hardcoded bun:test |
| `src/acceptance/fix-generator.ts` | Add `isStubFailure()` detection |
| `src/pipeline/stages/acceptance-setup.ts` | Build real codebaseContext, resolve agent via agentGetFn, pass timeoutMs |
| `src/execution/lifecycle/acceptance-loop.ts` | Stub detection before fix generation, re-generate path |
| `src/config/schemas.ts` | Add `timeoutMs` to `AcceptanceConfigSchema` |
| `src/config/runtime-types.ts` | Add `timeoutMs` to `AcceptanceConfig` interface |
| `src/config/defaults.ts` | Add `timeoutMs: 1800000` |
| `src/cli/config-descriptions.ts` | Add `acceptance.timeoutMs` description |
| `docs/enhancements/BUG-072-acceptance-generation-quality.md` | This spec |

---

## Test Plan

1. Unit test for `isStubFailure()` — detects `expect(true).toBe(false)` pattern
2. Unit test for new prompt structure — verify 3-step format, framework hint injection, no hardcoded `bun:test`
3. Unit test for `acceptance-setup` — verify `codebaseContext` is non-empty when project has files
4. Unit test for stub detection in acceptance loop — verify re-generation path triggers instead of fix stories
5. Integration: re-run koda acceptance generation with fixed code — verify real tests generated

---

## Success Criteria

- [ ] Acceptance generator produces real tests (not stubs) for koda's 50 ACs
- [ ] Generator uses project's configured agent (acpx for koda)
- [ ] Generator prompt adapts to project's test framework without hardcoding
- [ ] Timeout is configurable (default 30 min)
- [ ] Fix loop detects stubs and re-generates instead of creating useless fix stories
- [ ] Existing acceptance tests still pass (no regressions)
