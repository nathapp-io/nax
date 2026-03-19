# ENH-003: Acceptance test generator — enforce code-only output

**Type:** Bug / Enhancement
**Component:** Acceptance test generation (plan stage)
**Filed:** 2026-03-19
**Status:** ✅ Fixed (uncommitted — ready for review)
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

## Problem

`nax run --plan` generates `acceptance.test.ts` but the file contains LLM conversational prose instead of executable TypeScript:

```
File written to `nax/features/refactor-standard/acceptance.test.ts`. Here's a summary of the 43 tests...
```

The LLM's preamble text was dumped to disk verbatim. No executable tests exist for feature-level acceptance gating.

## Expected Behavior

`acceptance.test.ts` should contain valid, executable test code (TypeScript with `describe`/`it`/`expect` blocks) that can be run by `bun test` or `jest`.

## Investigation Points

1. Where is acceptance test generation triggered? (plan command or run --plan?)
2. What prompt is used? Does it enforce structured output (code-only)?
3. Is there a parser that strips LLM preamble before writing to disk?
4. Should we use a code-fence extraction pattern? (extract content between ````typescript` fences)

## Proposed Fix

1. **Prompt enforcement:** Add explicit instruction: "Output ONLY the TypeScript test file content. No explanations, no preamble."
2. **Parser:** Extract code from markdown fences if present (```typescript ... ```)
3. **Validation:** After writing, check that the file starts with `import` or `describe` — if not, log a warning and retry once.

## Acceptance Criteria

- [ ] `acceptance.test.ts` contains valid TypeScript test code
- [ ] File is parseable by TypeScript compiler (no syntax errors)
- [ ] Tests are runnable via `bun test acceptance.test.ts`
- [ ] LLM preamble/summary text is never written to the file
