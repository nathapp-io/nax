# @nathapp/nax — AI Coding Agent Orchestrator

Standalone CLI (Bun + TypeScript) that orchestrates AI coding agents with smart model routing, three-session TDD, and lifecycle hooks. NOT an OpenClaw skill — independent npm package.

**CLI command:** `nax`

## Commands

```bash
bun test              # Run all tests (bun:test)
bun run typecheck     # TypeScript type checking (tsc --noEmit)
bun run lint          # Biome linter (src/ bin/)
bun run dev           # Run CLI locally
bun run build         # Bundle for distribution
```

## Architecture

```
bin/nax.ts          # CLI entry point (commander)
src/
  agents/             # AgentAdapter interface + implementations (claude.ts)
  cli/                # CLI commands (init, run, features, agents, status)
  config/             # NaxConfig schema + layered loader + validation (global → project)
  execution/          # Main orchestration loop (the core)
  hooks/              # Lifecycle hooks (hooks.json → shell commands + NAX_* env)
  pipeline/           # Pipeline orchestration utilities
  prd/                # PRD/user-story loader, ordering, completion tracking
  queue/              # Queue manager for multi-agent parallel execution
  routing/            # Complexity classifier + test strategy decision tree
  tdd/                # Three-session TDD types + file isolation checker + orchestrator
test/                 # Bun test files (*.test.ts)
```

### Key Concepts

- **Complexity Routing**: Tasks classified as simple/medium/complex/expert → mapped to model tiers (cheap/standard/premium)
- **Three-Session TDD**: Session 1 (test-writer, only test files) → Session 2 (implementer, only source files) → Session 3 (verifier, auto-approves legitimate fixes)
- **Isolation Enforcement**: Git diff verification between TDD sessions — test-writer can't touch source, implementer can't touch tests
- **Hook System**: `hooks.json` maps lifecycle events (on-start, on-complete, on-pause, on-error, on-story-start, on-story-end) to shell commands
- **Layered Config**: `~/.nax/config.json` (global) merged with `<project>/nax/config.json` (project overrides)

### Pipeline Architecture (v0.3 target)

The execution loop should be refactored from a monolithic `run()` into composable pipeline stages. This enables adding/removing/reordering stages without editing a 600+ line function.

```typescript
// src/pipeline/types.ts
interface PipelineStage {
  name: string;                                          // unique stage identifier
  enabled: (ctx: PipelineContext) => boolean;             // skip if false
  execute: (ctx: PipelineContext) => Promise<StageResult>; // do the work
}

interface PipelineContext {
  config: NaxConfig;
  prd: PRD;
  story: UserStory;           // current story (or batch leader)
  stories: UserStory[];       // batch (length 1 for single)
  routing: RoutingResult;
  workdir: string;
  featureDir?: string;
  hooks: HooksConfig;
  // accumulated through stages
  constitution?: string;
  contextMarkdown?: string;
  prompt?: string;
  agentResult?: AgentResult;
  reviewResult?: ReviewResult;
}

type StageResult =
  | { action: 'continue' }                    // proceed to next stage
  | { action: 'skip'; reason: string }        // skip this story
  | { action: 'fail'; reason: string }        // mark story failed
  | { action: 'escalate' }                    // retry with higher tier
  | { action: 'pause'; reason: string }       // pause execution (queue command)
```

**Default pipeline stages (in order):**
```typescript
const defaultPipeline: PipelineStage[] = [
  queueCheckStage,       // check for PAUSE/ABORT/SKIP commands
  routingStage,          // classify complexity → model tier
  constitutionStage,     // load & inject project constitution
  contextStage,          // build file context from relevant sources
  promptStage,           // assemble final prompt from story + context + constitution
  executionStage,        // spawn agent session (single, batch, or TDD)
  verifyStage,           // check agent output, tests pass
  reviewStage,           // post-impl quality gate (typecheck/lint/test)
  completionStage,       // mark story done, fire hooks, log progress
];
```

**Design rules:**
- Each stage is a separate file: `src/pipeline/stages/<name>.ts`
- Stages communicate via `PipelineContext` — no side-channel state
- The pipeline runner (`src/pipeline/runner.ts`) iterates stages, handles StageResult actions
- The outer loop (load PRD → pick story → run pipeline → repeat) stays in `src/execution/runner.ts` but delegates per-story work to the pipeline
- Hooks fire inside stages (e.g., `completionStage` fires `on-story-complete`), not in the outer loop
- Config can override stage order or disable stages: `config.pipeline.stages`

## Code Style

- Bun-native APIs preferred (Bun.file, Bun.write, Bun.spawn, Bun.sleep)
- Each module directory: `types.ts` (interfaces), implementation files, `index.ts` (barrel exports)
- Immutable patterns — avoid mutation
- No classes unless wrapping stateful adapters (like ClaudeCodeAdapter)
- Functional style for pure logic (routing, classification, isolation checks)
- Biome for formatting and linting

## Testing

- Test framework: `bun:test` (describe/test/expect)
- Test files: `test/*.test.ts`
- Test naming: `test/<module>.test.ts`
- All routing/classification logic must have unit tests
- Isolation checker must have unit tests
- Run `bun test` before committing — all tests must pass

## File Conventions

- Max ~400 lines per file, split if larger
- Types/interfaces in dedicated `types.ts` per module
- Barrel exports via `index.ts` — import from module path, not deep paths
- Config defaults co-located with schema (`DEFAULT_CONFIG` in `schema.ts`)

## Current Status (v0.2.0-dev)

**Tests:** 222 passing across 16 files, 504 assertions
**Last Review:** 2026-02-17 — Grade B+ (82/100) — see `docs/20260217-post-impl-review.md`

### Implemented (v0.1 → v0.2)
- [x] Agent adapter interface + Claude Code implementation
- [x] Config schema + layered loader + validation
- [x] Hook lifecycle system + **command injection prevention** (SEC-1 ✅)
- [x] Complexity-based routing + test strategy decision tree
- [x] TDD isolation checker + three-session TDD orchestrator
- [x] PRD loader/saver with dependency-aware ordering
- [x] Execution runner with cost tracking
- [x] Queue manager + **PAUSE/ABORT/SKIP commands** (v0.2 Phase 2 ✅)
- [x] CLI: init, run, analyze, features create/list, agents, status
- [x] **Story-scoped context extraction from PRD** (v0.2 Phase 1 ✅)
- [x] **Explicit 3-tier escalation chain** fast→balanced→powerful (v0.2 Phase 3 ✅)
- [x] **Story batching for simple stories** with --no-batch flag (v0.2 Phase 4 ✅)
- [x] **Path validation + bounds checking** (SEC-2 ✅) — `src/config/path-security.ts`
- [x] **Agent installation check + retry with exponential backoff** (BUG-1 partial ✅)
- [x] **Atomic queue file handling** — rename-before-read pattern (BUG-2 ✅)
- [x] **PRD size limits** — `maxStoriesPerFeature` config + validation (MEM-1 partial ✅)
- [x] **Improved cost estimation** — structured output parsing + confidence (BUG-3 partial ✅)
- [x] **Story dependency validation** in analyze command (BUG-6 ✅)
- [x] **Hook timeout messages** — clear timeout vs failure distinction (BUG-5 ✅)

### Remaining Issues (from review, by priority)

#### P1 — Reliability
- [ ] **MEM-1 (partial):** Lazy loading for large PRDs not implemented — only size limit validation exists. No memory pressure detection or streaming JSON parsing.
- [ ] **PERF-1:** O(n²) batch story selection — not yet optimized with pre-computed eligible stories.
- [ ] **BUG-3 (partial):** Cost estimation still falls back to duration-based guessing when structured output unavailable. No per-story confidence scores.

#### P2 — Quality
- [ ] **ENH-1:** JSDoc coverage ~40% — `src/agents/claude.ts` (1 JSDoc), `bin/nax.ts` (1 JSDoc) are underserved. Most exported functions in runner.ts have docs but `routeTask()`, `buildContext()`, `runThreeSessionTdd()` lack usage examples.
- [ ] **TYPE-1:** Config loader still uses `as unknown as` double-casting (2 instances). No Zod runtime validation.
- [ ] **BUG-4:** Batch failure still escalates only first story. No config option for batch-wide escalation.
- [ ] **ENH-2:** No agent capability negotiation — adapters don't declare supported tiers/features.
- [ ] **PERF-2:** PRD reloaded every iteration — no dirty flag optimization.
- [ ] **ENH-3:** Context builder doesn't load file content — stories only, no source code context.

#### P3 — Polish
- [ ] **STYLE-1:** `runner.ts` is 901 lines (was 779, grew with fixes). Needs splitting into prompts/batching/queue-handler/escalation modules.
- [ ] **ENH-4:** No progress bar or ETA display — only line-by-line iteration logging.
- [ ] **TYPE-2:** `QueueCommand` still mixed string literals + object — not discriminated union.
- [ ] **ENH-5:** No dry-run mode for three-session TDD.
- [ ] **PERF-3:** Token estimation still uses `Math.ceil(text.length / 3)` — no improved heuristic.

#### P4 — Consistency
- [ ] **STYLE-2:** Inconsistent error handling patterns (throw vs return null vs log warning).
- [ ] **STYLE-3:** Magic numbers not extracted as named constants.

## Git

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Run `bun test && bun run typecheck` before committing
- Keep commits atomic — one logical change per commit

## Important

- This is a Bun project — do NOT use Node.js APIs when Bun equivalents exist
- Agent adapters spawn external processes — always handle timeouts and cleanup
- Never hardcode API keys — agents use their own auth (e.g., Claude Code uses ANTHROPIC_API_KEY from env)
- The execution runner has `[TODO]` markers for unimplemented agent spawning — that's the next priority
