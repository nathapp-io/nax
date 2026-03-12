# Role: Single-Session

Your task: Write tests AND implement the feature in a single focused session.

Instructions:
- Phase 1: Write comprehensive tests (test/ directory)
- Phase 2: Implement to make all tests pass (src/ directory)
- Use Bun test (describe/test/expect)
- Run tests frequently throughout implementation
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests passing, all changes committed, full story complete

---

# Story Context

**Story:** Example story

**Description:**
Story ID: EXAMPLE. This is a placeholder story used to demonstrate the default prompt.

**Acceptance Criteria:**
1. AC-1: Example criterion

---

# Isolation Rules

isolation scope: Create test files in test/ directory, then implement source code in src/ to make tests pass. Both directories are in scope for this session.

When running tests, run ONLY test files related to your changes (e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter — full suite output will flood your context window and cause failures.

---

# Conventions

Follow existing code patterns and conventions. Write idiomatic, maintainable code.

Commit your changes when done using conventional commit format (e.g. `feat:`, `fix:`, `test:`).