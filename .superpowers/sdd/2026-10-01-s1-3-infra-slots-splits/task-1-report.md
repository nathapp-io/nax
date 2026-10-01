# Task 1 report: Cost core split

## Implementation

- Extracted `toFiniteTokenCount`, `addTokenUsage`, and `inputClassTokens` into `packages/nax/src/agents/cost/usage-math.ts`; `calculate.ts` re-exports the two public functions and retains nax-only helpers.
- Added `packages/nax/src/agents/cost/core/index.ts` with the requested cost core exports.
- Redirected `estimate.ts` and the three native move-set importers to the new usage math/core locations.
- Added the identity and input-class token tests in `packages/nax/test/unit/agents/cost/cost-core-barrel.test.ts`.
- Added both paths to the move manifest and updated the agent-boundary baseline to 79.

## RED / GREEN and focused tests

- Baseline: `rtk bun test test/unit/agents/cost --timeout=60000` from `packages/nax` — **88 pass, 0 fail**, 5 files.
- RED: `rtk bun test test/unit/agents/cost/cost-core-barrel.test.ts --timeout=60000` — **0 pass, 1 error**; `Cannot find module '@/agents/cost/core'`.
- GREEN: `rtk bun test test/unit/agents/cost --timeout=60000` — **90 pass, 0 fail**, 6 files.
- Typecheck: `rtk bun run typecheck` from `packages/nax` — exit 0 (`tsc --noEmit` and test tsconfig checks).

## Boundary and mutation evidence

- Normal list: `rtk bun run check:agent-boundary -- --list` from `packages/nax` — **79 boundary edge(s)**. The cost edges from `estimate.ts` to `calculate.ts` and from all three native importers to `src/agents/cost/index.ts` are gone.
- Mutation: changed `turn-loop-round-trip.ts` to import `@/agents/cost`, then reran the same list command — the output included `src/agents/native/session/turn-loop-round-trip.ts -> src/agents/cost/index.ts` and ended with **80 boundary edge(s)**. Restored the new core import after the check.
- Baseline update: `rtk bun run check:agent-boundary:update` — `[OK] agent-boundary baseline saved: 79 edge(s)`.

## Formatting, lint, and repository checks

- Formatting: `rtk bun x biome check --write ...` across all task files — `Checked 16 files in 744ms. Fixed 1 file.`
- Package lint: `rtk bun run lint` from `packages/nax` — exit 0; Biome checked 2937 files and all package check scripts passed, including alias-internals, import-cycles, file-sizes, and agent-boundary (79).
- A root `rtk bun run test` was started, then stopped before the `@nathapp/nax` suite completed because the parent assigned whole-repository verification to Task 6. The visible partial output showed `@nathapp/nax-ai` 542/542 passing; this is not reported as a full root-suite result.

## Self-review and concerns

- The extraction preserves the function bodies and their docs; cost barrel consumers still receive the same exported function objects through re-exports.
- No implementation concern found. Repository-wide test/typecheck/lint/check:all verification remains with Task 6.
