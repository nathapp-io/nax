# Relentless vs ngent — Architecture Comparison & Port Recommendations

**Date:** 2026-02-16
**Relentless version:** v0.8.0 (~18,872 LOC src, 72 source files)
**ngent version:** v0.1 (~2,799 LOC src, 33 source files)

## Executive Summary

Relentless is a mature, feature-rich orchestrator with 6 agent adapters, a sophisticated routing system, and a polished TUI. ngent is a focused proof-of-concept with stronger TDD enforcement and simpler architecture. Rather than trying to match Relentless feature-for-feature, ngent should **selectively port the highest-impact features** while preserving its architectural advantages.

**Bottom line:** Port 5 features from Relentless. Skip 4. Keep 3 ngent strengths.

---

## Feature-by-Feature Comparison

### 1. Agent Adapters

| | Relentless | ngent |
|:---|:---|:---|
| **Agents** | 6 (Claude, Codex, Droid, OpenCode, Amp, Gemini) | 1 (Claude Code) |
| **LOC** | ~1,800 across 8 files | ~180 in 1 file |
| **Rate limit detection** | Yes (per-agent patterns) | No |
| **Cross-agent fallback** | Yes (cascade system) | No |

**Verdict:** ngent's single-agent focus is correct for v0.2. Multi-agent only matters when rate-limited or cost-optimizing with free models. **Port rate limit detection only** — cross-agent fallback is premature.

### 2. Routing & Classification

| | Relentless | ngent |
|:---|:---|:---|
| **Model matrix** | 4x4 (free/cheap/good/genius x simple/medium/complex/expert) | 2-tier (haiku/sonnet) |
| **Classifier** | Hybrid (regex heuristic + LLM fallback at <0.8 confidence) | Tag-based + complexity field |
| **Confidence scoring** | Yes (0.0-1.0) | No |
| **Cost estimation** | Per-model token estimates | Per-tier fixed estimates |

**Verdict:** The 4-mode matrix is overkill for Claude-only. But **expanding to 3 tiers** (haiku/sonnet/opus) with the hybrid classifier approach would improve routing accuracy. The confidence-based LLM fallback is clever — worth porting.

### 3. Cascade & Escalation

| | Relentless | ngent |
|:---|:---|:---|
| **Escalation path** | Configurable chain (e.g., haiku -> sonnet -> opus) | Simple tier bump |
| **Per-attempt cost tracking** | Yes (Zod schema, actual cost per step) | Partial (estimates only) |
| **Blocked detection** | Yes (marks stories as blocked with reason) | No |
| **Max attempts** | Configurable | Hardcoded (3) |

**Verdict:** ngent already has basic escalation. **Port per-attempt cost tracking and blocked detection.** Configurable max attempts is a quick win.

### 4. Context Optimization

| | Relentless | ngent |
|:---|:---|:---|
| **Approach** | Extract current story + dependencies from tasks.md | Token-budgeted element builder |
| **LOC** | 417 (single file, focused) | 276 (builder.ts) + integration |
| **Story extraction** | Regex-based section parsing from tasks.md | Generic element types (file/config/error/custom) |
| **Checklist filtering** | Tag-based ([US-XXX], [Constitution], [Edge Case]) | Not implemented |
| **Progress summary** | Auto-generated ("5/18 stories complete") | Not implemented |
| **Token savings claim** | ~84% | Not measured yet |

**Verdict:** Relentless's context builder is more practical — it works with the actual tasks.md format. ngent's is more generic but currently inert (relevantFiles empty until PRD populates them). **Port the story extraction approach** — parse the PRD/tasks to inject only the current story + dependencies into each session prompt. This is the #1 cost saver.

### 5. Queue & Mid-Run Control

| | Relentless | ngent |
|:---|:---|:---|
| **Queue file** | Custom format with commands | `.queue.txt` with cursor marker |
| **Commands** | PAUSE, ABORT, SKIP, RETRY | None (read-only) |
| **File locking** | Yes (lock.ts) | No |
| **Hot reload** | Yes (watches file changes) | Yes (reads between stories) |

**Verdict:** PAUSE/ABORT/SKIP are essential for production use. **Port queue commands.** File locking is nice-to-have.

### 6. Review System

| | Relentless | ngent |
|:---|:---|:---|
| **Post-run review** | 6 micro-tasks (typecheck, lint, test, security, quality, docs) | None |
| **Review prompts** | Templated per task type | N/A |
| **Review runner** | Dedicated (337 LOC) | N/A |

**Verdict:** The 6-phase review is valuable for production but heavy for POC stage. **Port a simplified 3-phase version** (typecheck, test, lint) for v0.3. Security/quality/docs can wait.

### 7. TUI

| | Relentless | ngent |
|:---|:---|:---|
| **Framework** | Ink (React for CLI) with 3-column layout | Console.log |
| **LOC** | ~2,000+ (App.tsx, components/, layouts/, hooks/) | 0 |
| **Live cost tracking** | Yes | No |
| **Story progress** | Visual grid | Text output |

**Verdict:** Ink TUI is polished but massive investment. **Skip for v0.2.** ngent's planned `node-pty` supervised mode serves the same need with less code. Consider a minimal progress display (single-line status updates) instead.

### 8. Configuration

| | Relentless | ngent |
|:---|:---|:---|
| **Schema** | Zod with full validation | Zod with validation |
| **Constitution** | Versioned constitution system | Not implemented |
| **Init wizard** | Interactive `init` command | Not implemented |

**Verdict:** Constitution system is interesting but not critical. **Skip for v0.2.**

---

## ngent Advantages to Preserve

### 1. Three-Session TDD (Architectural Enforcement)
Relentless uses prompt-based TDD ("write tests first, then implement"). ngent uses **session isolation** — separate Claude Code sessions for test writer, implementer, and verifier with git-diff verification. This is architecturally stronger and prevents the "AI writes tests that match its planned implementation" problem.

**Keep and strengthen.** This is ngent's #1 differentiator.

### 2. Actual Cost Tracking
ngent tracks real API costs from Claude Code's output. Relentless estimates costs from token counts. Actual > estimated.

**Keep.** Extend with per-attempt tracking (from Relentless).

### 3. Simplicity (2.8K vs 18.9K LOC)
ngent is 6.7x smaller. Easier to understand, modify, and debug. Every feature port should be evaluated against complexity cost.

**Keep.** Resist feature bloat. Each port must earn its LOC.

---

## Port Recommendations (Prioritized)

### P0 — Do in v0.2 (High Impact, Moderate Effort)

| # | Feature | Source | Est. LOC | Impact |
|:---|:---|:---|:---|:---|
| 1 | **Story-scoped context extraction** | `execution/context-builder.ts` | ~200 | #1 cost saver (~84% token reduction per session) |
| 2 | **Queue commands (PAUSE/ABORT/SKIP)** | `queue/processor.ts`, `queue/parser.ts` | ~150 | Essential for production mid-run control |
| 3 | **3-tier model routing** (haiku/sonnet/opus) | `routing/router.ts` | ~80 | Better cost optimization, already partially exists |

### P1 — Do in v0.3 (Medium Impact)

| # | Feature | Source | Est. LOC | Impact |
|:---|:---|:---|:---|:---|
| 4 | **Per-attempt cost tracking** | `routing/cascade.ts` | ~100 | Better cost visibility, debugging |
| 5 | **Hybrid classifier** (regex + LLM fallback) | `routing/classifier.ts` | ~150 | More accurate complexity routing |
| 6 | **Simplified review phase** (typecheck + test + lint) | `review/runner.ts`, `review/tasks/` | ~200 | Quality gate before marking story complete |
| 7 | **Blocked story detection** | `routing/cascade.ts` | ~50 | Avoid infinite retry loops |

### P2 — Consider for v0.4+ (Lower Priority)

| # | Feature | Source | Reason to Defer |
|:---|:---|:---|:---|
| 8 | Multi-agent adapters | `agents/*.ts` | Only useful when rate-limited or using free models |
| 9 | Ink TUI | `tui/` | ~2K LOC investment, node-pty serves similar need |
| 10 | Constitution system | `config/` | Nice-to-have, not a blocker |
| 11 | Init wizard | `init/` | One-time convenience, low ROI |

### Skip Entirely

| Feature | Reason |
|:---|:---|
| Cross-agent fallback | Claude-only for foreseeable future |
| File locking for queue | Single-instance execution = no contention |
| 4x4 mode-model matrix | Overkill for 1 agent; 3-tier sufficient |

---

## v0.2 Implementation Plan (from P0 items)

### Phase 1: Story-Scoped Context (~200 LOC)
Replace the generic context builder with Relentless-style story extraction:
- Parse PRD to get current story + dependency stories
- Inject only those sections into session prompt
- Add progress summary ("Story 5/12, 4 passed")
- Wire into both single-session and TDD paths

### Phase 2: Queue Commands (~150 LOC)
Extend `.queue.txt` parser:
- `PAUSE` — pause after current story completes
- `ABORT` — stop immediately, mark remaining as skipped
- `SKIP US-XXX` — skip a specific story
- Check queue between stories (existing hook point)

### Phase 3: 3-Tier Model Routing (~80 LOC)
Extend existing config:
- Add `opus` tier for expert-complexity stories
- Update router to support 3 tiers
- Keep backward compat with existing 2-tier configs

**Estimated total: ~430 LOC added to ngent (15% growth)**

---

## Metrics Comparison (12-Story Benchmark)

| Metric | Relentless (estimated*) | ngent v0.1 | ngent v0.2 (projected) |
|:---|:---|:---|:---|
| Session overhead | ~2-3 min (context optimization) | ~9 min (full context per session) | ~3-4 min (story-scoped) |
| Cost (12 stories) | ~$0.40-0.60* | $1.17 | ~$0.50-0.70 |
| Test coverage | Prompt-based TDD | Session-isolated TDD | Session-isolated TDD |
| Mid-run control | PAUSE/ABORT/SKIP/RETRY | None | PAUSE/ABORT/SKIP |
| Review phase | 6 micro-tasks | None | None (P1 for v0.3) |

*Relentless estimates based on context optimization claims and architecture analysis; no direct benchmark run.

---

## Conclusion

ngent v0.2 should focus on the **three P0 features** (context extraction, queue commands, 3-tier routing) which together address the two biggest pain points from benchmarking: **session cost** and **lack of mid-run control**. Combined with the existing TDD enforcement advantage, this would make ngent competitive with Relentless for our use case while staying at ~3.2K LOC (vs 18.9K).

The key insight: **don't try to be Relentless.** Port the ideas, not the code. ngent's value is in being opinionated and simple — a tool that does one thing well (orchestrate Claude Code with TDD) rather than a platform that supports everything.
