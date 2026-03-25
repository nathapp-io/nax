# Spec Writing Guide

How to write specs that produce high-quality PRDs and successful nax runs.

## Structure

A good spec has 5 sections:

```markdown
# SPEC: [Feature Name]

## Summary
One paragraph: what this feature does and why it matters.

## Motivation
What problem does this solve? What's broken or missing today?

## Design
Key interfaces, data flow, or architecture decisions.
Include TypeScript signatures when defining new APIs.

## Stories
Break the feature into implementation units.
Each story should be independently testable.

## Acceptance Criteria
Per-story behavioral criteria (see format below).
```

## Acceptance Criteria Format

Every AC must be **behavioral and independently testable**.

### Use This Format

```
- [function/method] returns/throws/emits [specific value] when [condition]
- When [action], then [expected outcome]
- Given [precondition], when [action], then [result]
```

### Rules

1. **One AC = one assertion.** If an AC has "and" in it, split it.
2. **Use concrete identifiers.** Function names, return types, error messages, log levels.
3. **Specify HOW things connect.** "logger forwards to the run's logger" not "logger exists".
4. **Never list quality gates.** Typecheck, lint, and build are run automatically — don't waste ACs on them.
5. **Never use vague verbs.** "works correctly", "handles properly", "is valid" are untestable.
6. **Never write ACs about tests.** "Tests pass" or "test file exists" are meta-criteria, not behavior.

### Examples

❌ **Bad:**
- "TypeScript strict mode compiles with no errors" → quality gate
- "Interface defined with all required fields" → existence, not behavior
- "Function handles edge cases correctly" → vague
- "Tests added and passing" → meta

✅ **Good:**
- `buildPostRunContext()` returns `PostRunContext` where `logger.info('msg')` forwards to the run logger with `stage='post-run'`
- `getPostRunActions()` returns empty array when no plugins provide `'post-run-action'`
- `validatePostRunAction()` returns `false` and logs warning when `postRunAction.execute` is not a function
- When `action.execute()` throws, `cleanupRun()` logs at warn level and continues to the next action

## Story Sizing

| Size | ACs | LOC | Files | Guideline |
|:-----|:----|:----|:------|:----------|
| Simple | 3-5 | ≤50 | 1-2 | Single concern, purely additive |
| Medium | 5-8 | 50-200 | 2-5 | Standard patterns, clear requirements |
| Complex | 6-10 | 200-500 | 5+ | New abstractions, multiple modules |

**Split if:**
- More than 8 ACs per story
- Story touches more than 5 files
- Story has both "add new feature" and "refactor existing code"

## Context Hints

Help the agent by listing relevant files:

```markdown
### Context Files
- `src/plugins/extensions.ts` — existing extension interfaces (follow this pattern)
- `src/plugins/registry.ts` — registry getter pattern to replicate
- `test/unit/plugins/registry.test.ts` — existing test patterns
```

The plan phase uses these to populate `contextFiles` in the PRD, which the agent reads before coding.

## Dependencies

Mark story dependencies explicitly:

```markdown
### Stories
1. **US-001: Add types** — no dependencies
2. **US-002: Registry support** — depends on US-001
3. **US-003: Runner integration** — depends on US-002
```

nax executes stories in dependency order. Independent stories can run in parallel.

## Anti-Patterns

| Pattern | Problem | Fix |
|:--------|:--------|:----|
| Giant story (15+ ACs) | Agent gets confused, fails | Split into 2-3 focused stories |
| "Make it work" AC | Untestable | Specify exact behavior |
| Test-only story | Pipeline handles tests | Delete — each story gets tests automatically |
| Doc-only story | Not code | Put in analysis field or skip |
| Quality gate AC | Already automatic | Remove from ACs |
| Vague description | Agent guesses wrong | Include function signatures, types |

## Real Example

**Bad spec (vague):**
> Add a post-run action system to the plugin framework.
> Stories: 1) Add types 2) Add registry 3) Add runner integration

**Good spec:**
> See `docs/specs/SPEC-post-run-actions.md` — includes:
> - Interface definitions with TypeScript signatures
> - Per-story ACs with function names and expected behavior
> - Context files pointing to existing patterns
> - Clear dependency chain (US-001 → US-002 → US-003)

---

*See also: `docs/specs/` for real spec examples.*
