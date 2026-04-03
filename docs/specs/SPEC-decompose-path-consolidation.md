# SPEC: Decompose Path Consolidation (#169)

## Summary
Consolidate decompose execution to a single implementation path so `nax plan --decompose` and adapter-driven decompose use the same parsing, response contract, and ACP session metadata. This removes divergent behavior (raw `JSON.parse` vs shared parser), eliminates markdown-fence parse failures, and standardizes decompose observability.

## Motivation
Today there are two decompose paths:
- `adapter.decompose()` → shared parser (`parseDecomposeOutput`) with markdown-fence handling and flat `DecomposedStory[]` output.
- `planDecomposeCommand()` path in `src/cli/plan.ts` using `adapter.complete()` + direct `JSON.parse` with a different `{ subStories: ... }` shape.

This duplication causes:
1. Parse fragility (code-fenced responses fail in `plan.ts`).
2. Contract drift (array vs envelope shape).
3. Missing ACP metadata (`workdir`, `storyId`, `featureName`, `sessionRole`) and poor session names.

## Design
Implementation approach: **single-source shared adapter path** (no regex/JSON parsing in CLI layer).

### Integration points
- `src/cli/plan.ts`: decompose command should call `adapter.decompose(...)` directly.
- `src/agents/shared/decompose.ts`: keep `parseDecomposeOutput()` as canonical parser.
- `src/agents/acp/adapter.ts` (and adapter interface): ensure decompose API accepts/forwards context needed for session naming.
- `src/agents/types.ts` (or equivalent): normalize decompose return contract to one shape consumed by plan.

### Target contract
- Canonical decompose output used by CLI: `DecomposedStory[]`.
- CLI converts this canonical output into PRD mutations; it does not parse raw LLM JSON itself.

### Context propagation
`plan --decompose` must propagate into adapter call:
- `workdir`
- `featureName`
- `storyId`
- `sessionRole: "decompose"`

### Failure handling
- **Fail-closed** for invalid decompose payloads:
  - if parser cannot recover JSON: throw a structured decompose parse error.
  - if required fields are missing: throw validation error with offending entry index.
- No silent fallback to raw story cloning.
- Preserve existing retry behavior (if any) at the caller/orchestrator layer; this spec does not add new retry loops.

## Stories
1. **US-001: Unify decompose invocation in plan CLI** — no dependencies  
2. **US-002: Standardize decompose payload contract and mapping** — depends on US-001  
3. **US-003: Ensure decompose context/session metadata propagation** — depends on US-001  
4. **US-004: Regression coverage for fenced JSON and contract parity** — depends on US-001, US-002, US-003

### Context Files (optional)
- `src/cli/plan.ts` — current `plan --decompose` flow and output mapping
- `src/agents/shared/decompose.ts` — canonical parser and decompose prompt/response handling
- `src/agents/acp/adapter.ts` — adapter decompose implementation and ACP call options
- `src/agents/types.ts` — adapter interfaces and decompose types
- `test/unit/cli/plan*.test.ts` and `test/unit/agents/**` — regression coverage

## Acceptance Criteria

### US-001: Unify decompose invocation in plan CLI
- Given `nax plan --decompose <storyId>`, when decompose is executed, then `plan.ts` calls `adapter.decompose()` and does not call `adapter.complete()` for decompose.
- Given decompose output handling in `plan.ts`, when parsing is needed, then no direct `JSON.parse(rawResponse)` is executed in the CLI decompose path.
- Given a code-fenced decompose LLM response, when plan decompose runs, then parsing succeeds through shared parser behavior.

### US-002: Standardize decompose payload contract and mapping
- Given decompose success, when adapter returns parsed output, then the contract consumed by plan is `DecomposedStory[]` only.
- Given decompose output mapping to PRD stories, when fields are normalized, then each resulting story has required PRD fields (`id`, `title`, `description`, `acceptanceCriteria`, `status`, `complexity`).
- Given malformed entries in parsed output, when validation runs, then error message reports the failing entry index and missing/invalid field.

### US-003: Ensure decompose context/session metadata propagation
- Given a plan decompose invocation, when adapter decompose is called, then call options include `workdir`, `featureName`, `storyId`, and `sessionRole="decompose"`.
- Given ACP adapter creates/uses a session, when decompose runs, then session naming includes feature + story decompose context rather than a generic run-only identifier.
- Given adapter call logging at debug level, when decompose starts, then log metadata includes story and feature identifiers used for session scoping.

### US-004: Regression coverage for fenced JSON and contract parity
- Given a mock adapter response wrapped in markdown fences, when decompose parser is exercised via plan flow, then test asserts successful parse and no thrown JSON token error.
- Given both plan and adapter decompose paths, when unit tests compare outputs, then both produce equivalent `DecomposedStory[]` shape for the same payload.
- Given decompose contract changes, when tests run, then no test asserts the deprecated `{ subStories: [...] }` envelope for plan decompose output.
