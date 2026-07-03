# nax — Improvement & Missing Feature Report

> Generated 2026-07-03 against `main` @ `fe94305e` (v0.70.8).
> Sources: full-source gap scan (TODO/FIXME/Phase-2 markers, ADRs 023–026, `docs/release-triage.md`, open GitHub issues) + docs-vs-code feature audit (CLI surface, plugins, queue, crash recovery, observability, cost).
> Scoped permissions (Phase 2 stub in `src/config/permissions.ts`) is **excluded** — already tracked as GitHub #374.

## What nax is (context)

nax is a Bun/TypeScript CLI that orchestrates AI coding agents rather than writing code itself. `nax plan` turns a spec into a PRD of user stories; `nax run` drives an ACP-compatible agent (Claude Code, Codex, Gemini CLI) through a loop per story: acceptance setup → model-tier routing → TDD execution (test-writer → implementer → verifier) → lint/typecheck gates → semantic + adversarial review → tier escalation (fast → balanced → powerful) → regression gate → acceptance. Around the core: a plugin system (6 extension points), per-package monorepo config, central run registry, crash recovery, cost tracking, context engine, and a curator that proposes rule updates from run observations.

The open-issue backlog is small and well-groomed (6 open issues), so most items below are **untracked** — candidates for new issues.

---

## 1. Genuine feature gaps (highest value)

### 1.1 No cost budget cap
- **Where:** `src/agents/cost/` (pricing, calculate, token-mapper) — tracking/estimation only.
- **Gap:** No `--max-cost` flag, no config field, no abort-on-overspend logic anywhere in `src/config/` or `src/execution/`. For a tool that autonomously loops and escalates to more expensive tiers, a spend ceiling is the most conspicuous missing safety feature.
- **Suggestion:** `execution.maxCostUsd` (run-level) + optional per-story ceiling; enforce in the runner loop via the existing `CostAggregator` middleware; abort → `status: "aborted"` with a clear exit summary.
- **Tracked:** No.

### 1.2 No mid-session resume
- **Where:** `src/execution/crash-*.ts`, `src/execution/story-selector.ts`.
- **Gap:** Crash recovery is implicit — rerunning `nax run` re-scans `prd.json` and restarts incomplete stories **from scratch**; in-flight agent session work is discarded. There is no `nax resume`.
- **Suggestion:** Persist per-story session checkpoints (last completed canonical-order step) so a rerun can skip already-green steps; or a `nax resume` that replays from the last verified state.
- **Tracked:** No.

### 1.3 Queue mid-run controls half-exposed
- **Where:** `src/queue/types.ts`, `src/queue/manager.ts`.
- **Gap:** Queue file accepts only `PAUSE` / `ABORT` / `SKIP <storyId>`. Yet `QueueManager` already has `resetToPending` (retry) and priority-sorted `enqueue` (reprioritize / inject) internally — none exposed as commands.
- **Suggestion:** Add `RETRY <storyId>`, `PRIORITY <storyId> <n>`, `INJECT <story-json-or-path>` queue commands; low effort, primitives exist.
- **Status:** ✅ `RETRY`/`PRIORITY` shipped in [PR #1290](https://github.com/nathapp-io/nax/pull/1290) — turned out the primitives weren't actually wired into the live execution path (`queue-check.ts` operates on `ctx.prd`/`ctx.stories` directly, bypassing `QueueManager`), so this was more than "just expose them": added `UserStory.priority`, `resetStoryToPending()`/`setStoryPriority()` PRD helpers, and priority-aware `getNextStory()` ordering. `INJECT` was scoped out as materially riskier (no schema to validate an ad hoc new story) — tracked in [#1288](https://github.com/nathapp-io/nax/issues/1288).
- **Tracked:** Yes — #1288 (INJECT).

### 1.4 No dashboard or metrics export
- **Where:** `src/metrics/` (rich `StoryMetrics` / `RunMetrics` / `AggregateMetrics`), output = JSONL under `~/.nax/<project>/…/runs/` + `nax status --cost`.
- **Gap:** No OpenTelemetry / Prometheus export, no web UI. `docs/ROADMAP.md` explicitly lists "Cost tracking dashboard" as unbuilt.
- **Suggestion:** Cheapest first step: `nax status --cost --json` stable export schema; later OTel exporter behind config.
- **Tracked:** Roadmap mention only, no issue.

### 1.5 Plugin ecosystem is empty
- **Where:** `src/plugins/` (all 6 extension points typed and wired), `examples/plugins/`.
- **Gap:** Only one example plugin ships (`console-reporter`, an `IReporter`). README name-drops auto-PR via `IPostRunAction`, but no bundled post-run action, context provider, router, or reviewer exists. The curator is a builtin wired outside the plugin mechanism.
- **Suggestion:** Ship 2–3 reference plugins — auto-PR `IPostRunAction` (gh/glab), a Jira/Linear `IContextProvider`, a cost-report `IReporter` — to make the extensibility claim real.
- **Tracked:** No.

### 1.6 LLM-driven run-time agent routing deferred
- **Where:** ADR-025 §7 "Part A — run-time routing (DEFERRED)".
- **Gap:** v1 ships a single global capability ladder; per-domain ladders and `routing.agents.strategy: "llm"` feeding `classifyRouteOp` are deferred with **no tracking issue** — risk of getting lost.
- **Suggestion:** File a backlog issue referencing ADR-025 §7.
- **Status:** ✅ Filed as [#1289](https://github.com/nathapp-io/nax/issues/1289).
- **Tracked:** Yes — #1289.

---

## 2. Known-but-unsurfaced quality issues

### 2.1 Adversarial review warnings dropped silently
- **Where:** review severity handling (adversarial review → fix cycle).
- **Gap:** Off-AC bugs found by adversarial review get downgraded to warning/info; with `review.blockingThreshold: "error"` they are never surfaced to the user at all. Real findings evaporate.
- **Suggestion:** Aggregate non-blocking findings and report them at run end (severity-graded summary) — aggregation + surfacing, not a new review pass. Related open issue #1157 (whack-a-mole within a file) touches the same subsystem.
- **Status:** ✅ Fixed in [PR #1290](https://github.com/nathapp-io/nax/pull/1290) — `ReviewAuditor.getAdvisoryFindings()` aggregates sub-threshold findings across the run; surfaced at run end via a severity-graded headless console summary (`formatAdvisorySummary`) plus a structured `logger.warn`. Aggregation only, no new review pass, per the suggestion.
- **Tracked:** Yes — closed by #1290 (adjacent: #1157, still open).

### 2.2 `tdd.sessionTiers.implementer` is dead config
- **Where:** `src/config/schemas-execution.ts:271-274` (intentionally not consumed — implementer follows `story.routing.modelTier` + escalation), but `src/cli/config-descriptions.ts:126` still documents it as "Model tier for implementer session".
- **Gap:** Schema-present, CLI-documented, silently inert — actively misleading. (`testWriter` and `verifier` sub-fields ARE consumed: `src/operations/write-test.ts:63`, `src/operations/verify.ts:156`.)
- **Suggestion:** Either warn at config load when set, or fix the CLI description to say it is ignored by design.
- **Status:** ✅ Fixed in [PR #1290](https://github.com/nathapp-io/nax/pull/1290) — CLI description now states it's ignored by design (chose the doc-fix option, not a config-load warning).
- **Tracked:** Yes — closed by #1290.

---

## 3. Debt / polish

| Item | Where | Tracked |
|---|---|---|
| `runTddSession` takes 19 positional params; options-object refactor flagged P4 | `src/tdd/session-runner.ts`, `docs/follow-up-runTddSession-options-refactor.md` | Doc only, no issue |
| `@deprecated` shims awaiting cleanup: `routeStory`/`routeTask`, `validateConfig`, `extractJsonFromMarkdown` wrapper, `decompose-prompt`, `RectifierPromptBuilder` class → static factories | `src/routing/router.ts:269-291`, `src/config/index.ts:53`, `src/routing/strategies/llm-parsing.ts:63`, `src/agents/shared/decompose-prompt.ts:2`, `src/prompts/builders/rectifier-builder.ts:10` | No |
| `routing.llm.batchMode` / `retries` deprecation shims | `src/config/loader.ts:198,289-320` | ✅ #856 closed (retry policy unified via `RetryStrategy`) |
| Rule-based prompt optimizer is real working code but off by default and undiscoverable; CLAUDE.md calls the optimizer "no-op" (only half true) | `src/optimizer/rule-based.optimizer.ts`, `src/optimizer/index.ts` | No |
| `nax setup` is functional but absent from README quick start / CLI table | `src/cli/setup.ts` | No |
| Stale docs: `docs/release-triage.md` generated 2026-04-21, well behind HEAD; `src/test-runners/resolver.ts:11` "[Phase 1: stub]" comment appears stale (replacement exported in `detect/index.ts:177`) | — | No |
| `modelDef.env` overrides ignored in `complete()`/`decompose()`/`plan()` | referenced as #391 in release-triage | ✅ #391 closed — verified fixed (`spawn-client.ts` now threads `opts.env`) |
| Worktree dependency `inherit` semantics / parallel routing / repo-root provisioning | — | **#574 (open)** |
| Agent-swap metric propagation deferred | `src/agents/manager.ts:217` | ✅ #1131 closed (post-refactor migration gaps resolved) |
| `IReviewPlugin` retention decision deferred by ADR-023 §6 | — | No |
| Reserved Phase-2 fields unused: debate citation/evidence-mode (`src/debate/types.ts:98`, `src/prd/schema.ts:335,355`), progressive context digest threading (`src/pipeline/stages/context.ts:86,177`), session retry-limit interface (`src/session/types.ts:153-155`) | — | No |

---

## 4. Suggested shortlist (value ÷ effort)

1. **Cost budget cap** (§1.1) — safety feature, infrastructure (cost middleware) already in place. **Not yet started.**
2. **Queue RETRY / PRIORITY / INJECT** (§1.3) — primitives exist, just expose them. **✅ RETRY/PRIORITY done (#1290); INJECT tracked (#1288).**
3. **Surface dropped adversarial-review warnings** (§2.1) — known correctness hole; aggregation + reporting only. **✅ Done (#1290).**
4. File tracking issues for §1.6 (ADR-025 Part A) and §2.2 (dead config) so they don't get lost. **✅ Done — #1289 filed for §1.6; §2.2 fixed directly rather than just tracked (#1290).**

### Remaining open items from this shortlist
> Re-verified 2026-07-03 (post-#1290): `maxCostUsd` absent from `src/config`/`src/execution` (grep-confirmed); #391, #856, #1131 in §3 are closed and fixed in code, updated above.

- **§1.1 Cost budget cap — not started. Recommended next pick** (highest value/effort ratio: `CostAggregator` middleware already exists, needs `execution.maxCostUsd` config field + abort-on-overspend check in the runner loop).
- §1.2 Mid-session resume — not started (second priority; larger surface, touches crash-recovery + session checkpointing).
- §1.4 Dashboard / metrics export — not started (cheapest slice is `nax status --cost --json` schema stabilization).
- §1.5 Plugin ecosystem — not started (needs 2-3 reference plugins to substantiate the extensibility claim).
- #1288 (INJECT queue command) and #1289 (ADR-025 §7 run-time routing) — tracked, not implemented.
