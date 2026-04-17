# Context Engine Review Follow-ups — Fix Branch

Date: 2026-04-17  
Branch: `fix/context-engine-review-followups-2026-04-17`

## Scope

Follow-up fixes applied after review findings from:

- `docs/reviews/today-commits-code-review-2026-04-17.md`
- `docs/reviews/context-engine-v2-final-review-2026-04-17.md`

## Implemented Fixes

### 1. Fallback execution wiring and handoff

- Multi-hop fallback traversal is now implemented in execution stage (tries next candidate when one swap fails).
- Rebuilt swap context is injected into retry prompt.
- Session handoff is persisted via `SessionManager.handoff(...)`.
- Protocol IDs are rebound after fallback attempts.

Files:

- `src/pipeline/stages/execution.ts`
- `src/session/manager.ts`
- `src/session/types.ts`

### 2. Canonical rules loader/spec parity improvements

- Canonical loader now supports:
  - `.nax/rules/*.md` and one-level nested files (`.nax/rules/*/*.md`)
  - YAML frontmatter parsing for `priority` and `appliesTo`
  - malformed frontmatter failure (`RULES_FRONTMATTER_INVALID`)
  - line-level linter overrides via `<!-- nax-rules-allow: <rule-id> -->`
- Added rule metadata (id/path/tokens/priority/appliesTo).
- Rules are ordered by `priority` then id/path deterministically.

Files:

- `src/context/rules/canonical-loader.ts`

### 3. Static rules provider wiring

- Canonical rules are now filtered by `appliesTo` against `request.touchedFiles`.
- Monorepo overlay now keys by canonical rule id (package override behavior retained).
- Legacy mode now loads full legacy set:
  - root shims (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`)
  - `.claude/rules/**/*.md`
  - no longer “first file only”.

Files:

- `src/context/engine/providers/static-rules.ts`

### 4. Structured adapter failure classification (no free-text keyword inference)

- `parseAgentError` now classifies from structured signals only:
  - JSON fields (`type`, `statusCode`, `code`, `acpxCode`, `detailCode`)
  - bracketed code suffixes
  - explicit key/value code pairs
- Free-text phrase inference is intentionally removed.

Files:

- `src/agents/acp/parse-agent-error.ts`

### 5. `availableBudgetTokens` propagation from call sites

- Added estimator and threaded `availableBudgetTokens` into `ContextRequest` in:
  - context stage
  - stage assembler

Files:

- `src/context/engine/available-budget.ts`
- `src/pipeline/stages/context.ts`
- `src/context/engine/stage-assembler.ts`

## Tests Updated / Added

- Canonical loader tests for nested loading, frontmatter, overrides, and malformed frontmatter.
- Static rules tests for `appliesTo` filtering and full legacy set loading.
- ACP parse tests rewritten for structured classification behavior.
- ACP adapter tests updated to use structured rate-limit inputs.
- Stage/context tests updated to assert `availableBudgetTokens` propagation.
- Existing fallback/session tests retained for handoff + multi-hop flow.

## Verification

Executed:

```bash
bun test test/unit/context/rules/canonical-loader.test.ts \
  test/unit/context/engine/providers/static-rules.test.ts \
  test/unit/context/engine/providers/static-rules-legacy-default.test.ts \
  test/unit/agents/acp/parse-agent-error.test.ts \
  test/unit/agents/acp/adapter.test.ts \
  test/unit/agents/acp/adapter-run.test.ts \
  test/unit/agents/acp/adapter-failure.test.ts \
  test/unit/context/engine/stage-assembler.test.ts \
  test/unit/pipeline/stages/context-digest.test.ts

bun run typecheck
bun run lint
```

Result: passing.

## Remaining Larger Items (Not Fully Closed Here)

- Full run-level centralized SessionManager ownership (startup/shutdown sweep + complete lifecycle ownership) is still larger-scope work.
- Some broader spec acceptance items outside these targeted fixes may still require separate follow-up slices.
