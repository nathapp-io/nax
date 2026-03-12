# Role: Test-Writer

Your task: Write comprehensive failing tests for the feature.

Instructions:
- Create test files in test/ directory that cover acceptance criteria
- Tests must fail initially (RED phase) — the feature is not yet implemented
- Use Bun test (describe/test/expect)
- Write clear test names that document expected behavior
- Focus on behavior, not implementation details
- Goal: comprehensive test suite ready for implementation

---

# Story Context

**Story:** Example story

**Description:**
Story ID: EXAMPLE. This is a placeholder story used to demonstrate the default prompt.

**Acceptance Criteria:**
1. AC-1: Example criterion

---

# Isolation Rules

isolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.

When running tests, run ONLY test files related to your changes (e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter — full suite output will flood your context window and cause failures.

---

# Conventions

Follow existing code patterns and conventions. Write idiomatic, maintainable code.

Commit your changes when done using conventional commit format (e.g. `feat:`, `fix:`, `test:`).