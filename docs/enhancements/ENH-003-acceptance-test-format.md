# ENH-003: Acceptance test generator — enforce code-only output

**Type:** Bug / Enhancement  
**Component:** `src/acceptance/generator.ts`  
**Filed:** 2026-03-19  
**Status:** ✅ Done  
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

---

## Problem

`nax run --plan` generates `acceptance.test.ts` but the file contained LLM conversational prose instead of executable TypeScript:

```
File written to `nax/features/refactor-standard/acceptance.test.ts`. Here's a summary of the 43 tests...
```

The LLM's preamble text was dumped to disk verbatim. No executable tests existed for feature-level acceptance gating.

## Fixes Applied

### 1. Prompt enforcement (79291f5)

Prompt explicitly instructs: "Output raw TypeScript code only. Do NOT use markdown code fences. Start directly with the import statement."

### 2. Code extraction — `extractTestCode()` (79291f5)

Multi-strategy parser strips LLM noise:
1. Extract from markdown code fence (``` typescript ... ```)
2. Find `import {` and take everything from there
3. Find `describe(` and take everything from there
4. Validate extracted code contains at least one test keyword (`describe`/`test`/`it`/`expect`)

### 3. Skeleton fallback (170dcd8)

When `extractTestCode()` returns `null` (LLM output is entirely non-code), falls back to `generateSkeletonTests()` — always-valid bun:test stubs for each acceptance criterion.

## Acceptance Criteria

- [x] `acceptance.test.ts` contains valid TypeScript test code
- [x] Tests are runnable via `bun test acceptance.test.ts`
- [x] LLM preamble/summary text is never written to the file
- [x] Skeleton fallback when LLM produces non-code output
