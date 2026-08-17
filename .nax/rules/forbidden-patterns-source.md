---
priority: 5
appliesTo:
  - "src/**/*.ts"
  - "bin/*.ts"
stages:
  - "context"
  - "execution"
  - "tdd-implementer"
  - "rectify"
  - "autofix"
  - "single-session"
  - "tdd-simple"
  - "no-test"
  - "batch"
  - "review-semantic"
  - "review-adversarial"
---

# Forbidden Patterns

> Quick lookup table. For root-cause rationale and security context, see `docs/architecture/conventions.md` §2 and `docs/architecture/design-patterns.md` §12.

These patterns are **banned** from the nax codebase. Violations must be caught during implementation, not after.

## Source Code

| Forbidden | Use Instead | Why |
|:---|:---|:---|
| `mock.module()` | Dependency injection (`_deps` pattern) | Leaks globally in Bun 1.x, poisons other test files |
| `console.log` / `console.error` in src/ | Project logger (`src/logger`) | Unstructured output breaks test capture and log parsing |
| `fs.readFileSync` / `fs.writeFileSync` | `Bun.file()` / `Bun.write()` | Bun-native project — no Node.js file APIs |
| `child_process.spawn` / `child_process.exec` | `Bun.spawn()` / `Bun.spawnSync()` | Bun-native project — no Node.js process APIs. **Inverted under `flows/`** — see below |
| `Bun.spawn` / `Bun.file` / `Bun.write` **inside `flows/`** | `node:child_process` / `node:fs/promises` | `flows/` is loaded by `acpx flow run`, in acpx's own process, and the published `acpx` binary is a Node program. `Bun` is undefined there, so any `Bun.*` call throws `ReferenceError: Bun is not defined` at runtime. Invisible to the test suite (which runs under Bun), so it is enforced statically by `scripts/check-flows-no-bun.ts` in `bun run lint`. |
| `setTimeout` / `setInterval` for delays | `Bun.sleep()` | Bun-native equivalent for `src/` code. **Exception:** `setTimeout` is permitted (not `setInterval`) when the timer handle must be cancelled mid-flight via `clearTimeout` (e.g. kill/drain races). Document this at the call-site. Tests follow `docs/guides/testing-rules.md` and must not use `Bun.sleep()`. |
| Hardcoded timeouts in logic | Config values from schema | Hardcoded values can't be tuned per-environment |
| `import from "src/module/internal-file"` | `import from "src/module"` (barrel) | Prevents singleton fragmentation (BUG-035) |
| Test files > 800 lines | Split by concern | Violates the hard limit in `docs/guides/testing-rules.md` / `docs/guides/testing-conventions.md` |
| Prompt-building functions outside `src/prompts/builders/` | Add a method to the appropriate builder class | Orphan prompts scatter LLM instruction logic across subsystems, making them impossible to audit, test, or optimise centrally (see Prompt Builder Convention below) |
| Inline test-file classification outside `src/test-runners/` | `resolveTestFilePatterns(config, workdir, packageDir)` SSOT | ADR-009 — nax is language-agnostic and monorepo-aware. Hardcoded `test/unit/`, `.test.ts`, `_test.go`, `\.spec\.` regexes fragment the truth and break under polyglot monorepos (see Test-File Classification Convention below) |
| Hand-rolled LLM JSON extraction (`output.trim().replace(/\`\`\`json.../)`, bare `JSON.parse(output)`) | `parseLLMJson<T>(output)` from `src/utils/llm-json` | Single-tier parsing silently fails on fence-wrapped, preamble-padded, or trailing-comma responses. `parseLLMJson` runs three extraction tiers and is the SSOT for all LLM response parsing. |
| Direct `adapter.openSession` / `sendTurn` / `closeSession` / `complete` outside the wiring layer (`src/agents/manager.ts`, `src/agents/utils.ts`, `src/session/manager.ts`) | `callOp` for ops; manager / session APIs otherwise | ADR-019 §1 — bypassing loses middleware + descriptor correlation |
| `adapter.run` / `plan` / `decompose`, `agentManager.planAs` / `decomposeAs` | `callOp(ctx, planOp / decomposeOp, …)` or another `Operation` | Deleted (ADR-019 Phase D + ADR-018 Wave 3) |
| `new AgentManager(config)` / `createAgentManager(config, …)` outside `src/runtime/internal/` | `createRuntime(config, workdir)` and read `runtime.agentManager` | ADR-018 §2 — one runtime per run, no orphans |
| `runtime.configLoader.current()` inside an op's `build` / `parse` | `ctx.config` (sliced by `callOp` via `packageView.select`) | ADR-018 §4.2 — preserves per-package overrides |
| Resolving permissions outside `SessionManager.openSession` / `AgentManager.completeAs` | Pass `pipelineStage` upward; resource opener resolves once | ADR-019 §3 |
| `wrapAdapterAsManager` (production or test imports from `src/agents/utils`) | `createRuntime(config, workdir).agentManager` for production; `fakeAgentManager(adapter)` for tests | ADR-020 §D3 — privatized; all dispatch must flow through the middleware chain |
| `fakeAgentManager` in `src/` production code | `createRuntime(config, workdir).agentManager` | Test-only helper (see Test-Only Helpers below) |
| `join(homedir(), ".nax", ...)` / `path.join(os.homedir(), ".nax", ...)` outside `src/config/paths.ts` | `globalConfigDir()`, `getRunsDir()`, `getEventsRootDir()`, runtime path helpers | Hardcoding the real home-scoped `.nax` path bypasses test isolation and caused pollution under `~/.nax/nax-*-test-*`. Enforced by `scripts/check-no-real-global-nax.ts`. |
| `join(root, ".nax", "features", ...)` / `` `${root}/.nax/features/...` `` / a bare `".nax/features/..."` pattern, outside `src/config/paths.ts` | `featureDir(root, featureId)` / `featuresDir(root)` for paths; `PROJECT_FEATURES_DIR` for globs and gitignore entries — all from `@/config` | The feature tree holds `prd.json`, `status.json`, `stories/`, `sessions/`, `fragments/`, `context.md`. It was open-coded at 38 sites in 34 files; one dropped the `.nax` segment, so captured fragments landed in a stray top-level `features/` dir that no `.nax`-scoped gitignore entry covered and a run auto-committed them into the user's repo. Genuine prose in a string takes `// nax-feature-dir-allow: <reason>`. Enforced by `scripts/check-feature-dir-ssot.ts`. |
| Manual disk-recovery ladder in pipeline stages after `callOp` (reading disk to recover null/empty parse output — Tier-1/2/3 patterns) | Declare `verify`/`recover` on the op | Recovery logic belongs with the op (one place to maintain), not duplicated in every stage that calls it. ADR-020 §D4. |
| Passing `undefined` (or omitting) `onPidSpawned` when constructing an ACP client / opening a session / building `AgentRunOptions` / `CompleteOptions` | Forward the runtime's callback: `onPidSpawned: ctx.runtime.onPidSpawned` (ops via `callOp`) or `(pid) => pidRegistry.register(pid)` (pipeline stages with direct registry access) | Untracked acpx subprocesses orphan past run teardown — Ctrl+C leaves zombie acpx + agent server processes. Issue #792, commit `e65e78b9`. |
| New `HopBody` parse-retry implementations (handling parse failures via multi-turn session callbacks) | `op.retry` with `makeParseRetryStrategy` | HopBody is for genuine multi-turn interactions, not failure recovery. Parse retries belong in `op.retry` which uses `RetryStrategy` — consolidated framework (issue #856). |
| Hand-rolled parse-retry loops inside an `op.hopBody` | Declare `op.retry` and call `ctx.sendWithParseRetry` in the body | `op.retry` and `op.hopBody` compose — the body receives `ctx.sendWithParseRetry` with the retry loop baked in. Duplicating the loop in the body defeats the SSOT and bypasses the `MAX_COMPLETE_RETRY_ATTEMPTS` ceiling. |
| `makeTestRuntime()` / `makeMockRuntime()` in a test file without an `afterEach`/`afterAll` that calls `.close()` | Add `const createdRuntimes: NaxRuntime[] = []` + `afterEach(async () => { await Promise.allSettled(createdRuntimes.map(r => r.close())); createdRuntimes.length = 0; })` and push each created runtime | Each runtime owns an idle-watchdog `setTimeout` that only stops on `close()`. Without teardown, 86+ leaked runtimes across `bun test test/unit/` caused ~40 GB RAM growth. Enforced by `scripts/check-runtime-cleanup.sh`. |

## Prompt Builder Convention

**All LLM prompt-building logic lives in `src/prompts/builders/` — no exceptions.**

An "orphan prompt" is any function or template string outside `src/prompts/builders/` that:
- Returns a multi-line string sent to an LLM agent
- Contains `You are`, `## Instructions`, `Fix `, `Your task`, `IMPORTANT:`, or similar instructional text  <!-- nax-rules-allow: important-shouting -->
- Is named `build*Prompt`, `create*Prompt`, `make*Prompt`, or similar

### Wrong — prompt assembled in a pipeline stage

```typescript
// src/pipeline/stages/autofix.ts
function buildFixPrompt(checks: ReviewCheckResult[]): string {
  return `You are fixing lint errors.\n\n${checks.map(...).join("\n")}`;
}
```

### Correct — static method on the relevant builder

```typescript
// src/prompts/builders/rectifier-builder.ts
export class RectifierPromptBuilder {
  static continuation(checks: ReviewCheckResult[], ...): string {
    // prompt assembly lives here
  }
}
```

### Builder registry

| Builder class | Handles |
|:---|:---|
| `RectifierPromptBuilder` | All rectification prompts: TDD failures, verify failures, review findings, autofix retries |
| `ReviewPromptBuilder` | Semantic and adversarial review prompts |
| `TddPromptBuilder` | TDD session prompts (test-writer, implementer, verifier) |
| `AcceptancePromptBuilder` | Acceptance test generation, diagnosis, refinement, fix execution |
| `DebatePromptBuilder` | Multi-agent debate and review-dialogue prompts |
| `OneShotPromptBuilder` | Single-turn utility prompts (router, decomposer, auto-approver) |

If no existing builder fits, create `src/prompts/builders/<domain>-builder.ts` and export from `src/prompts/index.ts`.

### Wrapper functions are also banned

Thin wrappers that do nothing but delegate to a builder add indirection without value:

```typescript
// Wrong — pointless wrapper in src/acceptance/fix-executor.ts
function buildSourceFixPrompt(...): string {
  return new AcceptancePromptBuilder().buildSourceFixPrompt(...);
}

// Correct — call the builder directly at the use site
const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt(...);
```
