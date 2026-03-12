# Isolation Rules

## Test-Writer (Strict)

isolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.

## Test-Writer (Lite)

isolation scope: Create test files in test/. MAY read src/ files and MAY import from src/ to ensure correct types/interfaces. May create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.

## Implementer

isolation scope: Implement source code in src/ to make tests pass. Do not modify test files. Run tests frequently to track progress.

## Verifier

isolation scope: Read-only inspection. Review all test results, implementation code, and acceptance criteria compliance. You MAY write a verdict file (.nax-verifier-verdict.json) and apply legitimate fixes if needed.

## Single-Session

isolation scope: Create test files in test/ directory, then implement source code in src/ to make tests pass. Both directories are in scope for this session.

## TDD-Simple

isolation scope: You may modify both src/ and test/ files. Write failing tests FIRST, then implement to make them pass.

---

**Test Filter Rule:** When running tests, run ONLY test files related to your changes (e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter — full suite output will flood your context window and cause failures.
