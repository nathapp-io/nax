# nax — Brief

## What
AI coding agent orchestrator (CLI, Bun + TypeScript). Takes a feature spec, decomposes into user stories via LLM, routes each to the right model tier by complexity, and executes them with auto-escalation and retry. Supports three-session TDD for quality-critical work. Currently v0.10.0 on master. Published as `@nathapp/nax` (not yet on npm — local/global install only).

## Architecture

```
spec.md + tasks.md
    ↓
nax analyze → prd.json (user stories with routing metadata)
    ↓
nax run → pipeline per story:
    routing → context → constitution → prompt → optimizer → execution → review → acceptance → completion
                                                  ↑                                ↑
                                            (v0.10 plugin)                   (v0.10 plugin)
    ↑                         ↑
  plugin routers        plugin context-providers
```

**Key modules:**

| Module | Purpose |
|:-------|:--------|
| `pipeline/` | Stage-based runner — each stage returns continue/skip/fail/escalate/pause |
| `routing/` | Strategy chain: keyword → LLM → adaptive → manual → plugin |
| `context/` | Builds per-story context from PRD + dependencies within token budget |
| `tdd/` | Three-session orchestrator: test-writer → implementer → verifier with git-diff isolation |
| `execution/` | Spawns `claude -p` via ClaudeCodeAdapter, handles timeouts and cost tracking |
| `acceptance/` | LLM-generated acceptance tests, validates story output |
| `agents/` | Adapter pattern — currently only Claude Code, designed for Codex/Gemini/OpenCode |
| `hooks/` | Lifecycle events (on-start, on-complete, on-pause, on-error) via shell commands |
| `config/` | Layered config: global (`~/.nax/`) → project (`nax/`) with Zod validation + deep merge |
| `constitution/` | Injected rules/constraints prepended to every agent prompt |
| `plugins/` | *(v0.10)* Plugin loader, registry, and extension point interfaces |
| `optimizer/` | *(v0.10)* Prompt optimization stage (rule-based built-in + plugin support) |

## Key Decisions

| Decision | Why | Date | Ref |
|:---------|:----|:-----|:----|
| Classify complexity upfront, not start-cheap | Avoids wasting cycles on wrong model; LLM routing is cheap (~$0.002/story) | 2026-02-16 | SPEC.md |
| Three-session TDD (not two) | Session 3 (verifier) catches cases where implementer subtly modifies tests; git-diff isolation between all sessions | 2026-02-16 | SPEC.md |
| LLM outputs testStrategy directly | Keyword matching caused false positives ("endpoint"→TDD). LLM handles nuance better | 2026-02-23 | #11, #12 |
| Stage-based pipeline over monolithic runner | Composable, testable, each stage can skip/fail independently | 2026-02-17 | v0.3-spec |
| Bun over Node | Faster test execution, native TypeScript, built-in file APIs | 2026-02-16 | — |
| Token budget for context | Prevents context overflow (200k window); reserves 100k for agent reasoning | 2026-02-17 | context/builder.ts |
| Constitution as separate file | Project-level rules (coding standards, forbidden patterns) injected into every prompt without modifying CLAUDE.md | 2026-02-18 | — |
| Hooks over built-in integrations | Users wire their own notifications/CI via shell commands; nax stays standalone | 2026-02-16 | SPEC.md |
| Dropped greenfield scaffolding (#13) | Chicken-and-egg: nax/ must exist inside project, but scaffolding creates the project. Manual US-000 works fine. Existing tools (na-cli, nest new) handle scaffolding better. | 2026-03-03 | #13 |
| Test-writer allowed paths for barrel exports | `src/index.ts` re-exports are common TDD collateral; soft-warn instead of hard-block | 2026-02-22 | #9 |
| Story pause doesn't block unrelated stories | Dependency graph determines which stories can proceed independently | 2026-02-22 | #10 |
| Use actual BuiltContext tokens in frontmatter | Re-estimating tokens independently caused mismatches; element-level tracking is more accurate for audit | 2026-02-23 | #15 |
| Shared TDD prompt module | Extracting TDD prompts from orchestrator ensures consistency between CLI and execution | 2026-02-23 | #15 |
| Plugin system over ad-hoc extension | Unified registration/loading for all extension points (optimizer, router, agent, reviewer, context, reporter). Reuses existing interfaces. | 2026-03-03 | #8, #14 |
| Deep merge for global+project config | More intuitive than section replace; users only override what they change. Hooks and constitution concatenate (global first). | 2026-03-03 | #14 |
| No LLM optimizer built-in | Fast-tier LLM rewrite adds cost/complexity. Rule-based covers deterministic wins. External LLM optimizers (LLMLingua, etc.) can be added via plugins. | 2026-03-03 | #8 |
| TDD-Lite over removing TDD | TDD is nax's differentiator; instead of dropping it, add a relaxed variant (lite) where only verifier stays isolated. Strict for TS libs, lite for UI/polyglot. | 2026-02-24 | #20 |
| Fix nax over replacing with dev-orchestrator | dev-orchestrator lacks TDD pipeline, structured logging, PRD workflow. Porting those is more work than fixing nax's weaknesses. | 2026-02-24 | `docs/20260224-nax-roadmap-phases.md` |
| Dry-run marks stories as passed | Previous dry-run never changed story status, causing infinite loop until maxIterations. Now marks passed + saves PRD for natural completion. | 2026-02-24 | `09996c8` |
| Targeted git reset for TDD fallback | `git checkout .` was too aggressive; now resets only files touched by the failed session, preserving other local changes. | 2026-02-24 | `d1dc4b9` |

## Config Reference

Config loaded from `~/.nax/config.json` (global) deep-merged with `nax/config.json` (project). CLI flags override both.

**Resolution order:** Built-in defaults → `~/.nax/config.json` → `nax/config.json` → CLI flags

| Section | Key | Type | Default | Purpose |
|:--------|:----|:-----|:--------|:--------|
| models | fast/balanced/powerful | ModelDef \| string | haiku/sonnet/opus | Maps abstract tiers to actual models |
| autoMode | complexityRouting | Record<Complexity, Tier> | simple→fast, medium→balanced, complex/expert→powerful | Which tier handles which complexity |
| autoMode | escalation.tierOrder | TierConfig[] | fast×5, balanced×3, powerful×2 | Retry budget per tier before escalating |
| routing | strategy | keyword\|llm\|manual\|adaptive\|custom | keyword | How stories get classified |
| routing | llm.mode | one-shot\|per-story\|hybrid | hybrid | Batch-route upfront + re-route on retry |
| execution | costLimit | number (USD) | 5.0 | Pause run when cost exceeds this |
| execution | sessionTimeoutSeconds | number | 600 | Kill agent session after this |
| execution | verificationTimeoutSeconds | number | 300 | Kill test/typecheck/lint subprocess |
| quality | commands.test | string | (auto-detect) | Custom test command |
| quality | forceExit | boolean | false | Append --forceExit to test command |
| quality | stripEnvVars | string[] | CLAUDECODE, REPL_ID, AGENT | Env vars removed during verification |
| tdd | sessionTiers | {testWriter, implementer, verifier} | balanced/story-tier/fast | Per-session model overrides |
| tdd | testWriterAllowedPaths | string[] | src/index.ts, src/**/index.ts | Soft-allowed paths for test-writer |
| constitution | path | string | constitution.md | Relative to config dir (~/.nax/ or nax/) |
| constitution | skipGlobal | boolean | false | *(v0.10)* Skip global constitution for this project |
| context | testCoverage.detail | names-only\|names-and-counts\|describe-blocks | names-and-counts | How much test info to inject |
| context | testCoverage.maxTokens | number | 500 | Token budget for test coverage section |
| context | testCoverage.scopeToStory | boolean | true | Filter test coverage to story-relevant files only |
| acceptance | enabled | boolean | true | Run LLM acceptance validation |
| analyze | llmEnhanced | boolean | true | Use LLM for story decomposition |
| optimizer | enabled | boolean | false | *(v0.10)* Enable prompt optimization stage |
| optimizer | strategy | noop\|rule-based | noop | *(v0.10)* Built-in optimizer strategy |
| hooks | skipGlobal | boolean | false | *(v0.10)* Skip global hooks for this project |
| plugins | (array) | PluginConfigEntry[] | [] | *(v0.10)* Explicit plugin modules + config |

Full schema with Zod validation: `src/config/schema.ts`

## v0.10 Specs

| Feature | Spec File | Stories | Summary |
|:--------|:----------|:--------|:--------|
| Plugin System | `docs/v0.10-plugin-system.md` | 9 | Loader, registry, 6 extension point interfaces (optimizer, router, agent, reviewer, context-provider, reporter) |
| Prompt Optimizer | `docs/v0.10-prompt-optimizer.md` | 5 | NoopOptimizer (default), RuleBasedOptimizer (strip whitespace, compact criteria, dedup context), optimizer pipeline stage |
| Global Config | `docs/v0.10-global-config.md` | 7 | `~/.nax/` directory, deep merge (project wins), hooks concatenate (global first), constitution concatenate, `nax init --global`, `skipGlobal` opt-out |

**Total: ~21 user stories** across 3 features.

### Plugin Extension Points

| Type | Behavior | v0.10 Scope |
|:-----|:---------|:------------|
| `optimizer` | Last loaded wins | ✅ Full (built-in + plugin wiring) |
| `router` | Chained before built-in strategies | 🔌 Interface + wiring |
| `agent` | Selected by config `agent` field | 🔌 Interface + wiring |
| `reviewer` | Additive — all run after built-in checks | 🔌 Interface + wiring |
| `context-provider` | Additive — token-budgeted, appended to context | 🔌 Interface + wiring |
| `reporter` | Additive — fire-and-forget lifecycle events | 🔌 Interface + wiring |

## Version History

| Version | What Changed | Issues |
|:--------|:-------------|:-------|
| v0.10.0 | Plugin system, Global config layering, Prompt optimizer stage | #8, #14 |
| v0.9.3 | Prompt Audit CLI (`nax prompts`), context isolation unit tests, scoped test coverage scanner | #15 |
| v0.10.1 | Fix dry-run infinite loop (mark stories passed), fix BUG-21 (null attempts escalation), fix BUG-22 (paused story loop), global hooks loading | #16, #17 |

## Roadmap

| Priority | Feature | Status | Ref |
|:---------|:--------|:-------|:----|
| **Done** | Phase 1: TDD-Lite strategy + zero-file fallback | ✅ Done | #20, `docs/20260224-nax-roadmap-phases.md` |
| **Next** | Phase 2: LLM Service Layer — agent interface with pluggable backends | 📋 Planned | #3 |
| **Next** | Phase 3: Worktree parallelism — N stories concurrent | 📋 Planned | — |
| **Backlog** | CLI for paused stories (`nax stories`, `nax resume`) | 📋 Planned | #18 |
| **Backlog** | Quality flags + review.checks unification | 📋 Planned | #19 |
| **Done** | v0.10.0: Plugin system & Global Config | ✅ Released | #8, #14 |
| **Done** | Dry-run infinite loop fix & targeted fallback reset | ✅ Released | `09996c8`, `d1dc4b9` |
| **Dropped** | ~~Greenfield project scaffolding~~ | ❌ Dropped (chicken-and-egg with nax/) | #13 |

### Phase Dependency Chain
```
Phase 1: tdd-lite + fallback     ← standalone, no blockers
    ↓
Phase 2: LLM Service Layer (#3)  ← abstracts agent spawning (claude-cli, openclaw, api)
    ↓
Phase 3: Worktree parallelism    ← needs Phase 2 for multi-agent coordination
    ↓
Memory optimization              ← comes free with Phase 3 (phase-by-phase execution)
```

## Known Weaknesses (2026-02-24 Analysis)

Compared against dev-orchestrator (OpenClaw skill) which handles execution differently:

| Weakness | Detail | Fix Phase |
|:---------|:-------|:----------|
| **No real parallelism** | Stories run sequentially; batch mode = same agent session | Phase 3 |
| **Memory hungry** | Peaks 3-4GB+, OOMs on 4GB VPS | Phase 3 (phase-by-phase agents) |
| **Single agent backend** | claude CLI only, no OpenClaw sub-agents or API direct | Phase 2 |
| **TDD too strict for non-TS** | Test-writer isolation breaks for UI/polyglot/integration | Phase 1 |
| **Over-generates stories** | `nax analyze` creates 23 stories when 3 would do | Backlog |
| **Setup overhead** | PRD → analyze → config → run vs "here's a task" | By design (structured) |

**nax strengths over dev-orchestrator:** structured JSONL logging, automatic escalation tiers, reproducible runs (same PRD = same result), `nax accept` post-run review, hooks/plugins, constitution injection.

## Gotchas

- **VPS OOMs Claude Code** — always run nax on Mac01 for real dogfood runs
- **`nax.lock` can go stale** — if process OOM-killed, lock file remains. nax checks PID liveness and auto-removes stale locks.
- **Keyword routing false positives** — words like "endpoint", "public api" triggered three-session-tdd on simple stories. Fixed in v0.9.1 (LLM-direct strategy).
- **`nax analyze` overwrites PRD** — re-running analyze regenerates the entire PRD. Back up manual edits first.
- **`nax analyze` doesn't generate scaffolding stories** — if repo is empty, manually add US-000 for project setup.
- **Bun stream workaround** — `drainTimeoutMs` exists because Bun doesn't always flush stdout/stderr after process kill.
- **`timeout` not on macOS** — use `gtimeout` from coreutils on Mac01.
- **PTY check on remote nodes** — use `CLAW_NO_PTY_CHECK=1` when running via `nohup` on remote nodes to bypass script-level PTY enforcement.

---
*Updated 2026-02-24*
