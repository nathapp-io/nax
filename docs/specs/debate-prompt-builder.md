# Spec: DebatePromptBuilder — Unified Debate Prompt Construction

**Status:** Draft
**Origin:** Prompt audit of debate hybrid runs bench-03/04/05 (see `logs/debate-hybird/prompt-audit-report.md`)
**Priority:** High — Phase 1 fixes a functional degradation observed in every debate run

---

## Background

A prompt audit of three debate hybrid benchmark runs (bench-03-fix-overdue-stats, bench-04-add-export-command, bench-05-add-sort-option) uncovered systemic prompt quality issues in the debate pipeline. These issues fall into two categories:

1. **Structural defects** — contradictory instructions, format contamination, duplicate code
2. **Missing features** — no debater persona differentiation, no attribution in resolver

The root cause is that debate prompt construction is scattered across 6 files with two parallel, uncoordinated prompt systems — one for plan debate and one for review debate.

## Current Architecture

| Prompt universe | Files | Used by |
|----------------|-------|---------|
| Plan / generic debate | `src/debate/prompts.ts`, `session-helpers.ts`, `session-plan.ts`, `session-hybrid.ts` | Plan debate, future stages |
| Review debate | `src/review/dialogue-prompts.ts`, `dialogue.ts` | `ReviewerSession` |

These two universes have separate `buildProposalsSection()` implementations, separate critique/rebuttal builders, and no shared interface for persona injection or format separation.

## Target Architecture

A single `DebatePromptBuilder` class that owns all prompt text assembly for the debate system. Each stage (plan, review, future) provides a `StageContext` (task description + output format), and the builder handles proposals, rebuttals, critiques, personas, resolver framing, and session control.

## Phased Implementation

The refactor is split into 4 independently shippable phases. Each phase has its own detailed spec:

| Phase | Spec | Fixes | Risk | Shippable? |
|-------|------|-------|------|------------|
| **1** | [debate-prompt-phase1.md](debate-prompt-phase1.md) | G3 (contradictory hybrid instructions), G8 (schema bloat in rebuttals) | Low | Yes |
| **2** | [debate-prompt-phase2.md](debate-prompt-phase2.md) | G2/G4 (no debater differentiation), G7 (no proposal attribution) | Low | Yes |
| **3** | [debate-prompt-phase3.md](debate-prompt-phase3.md) | Code unification — extract `DebatePromptBuilder` class | Medium | Yes |
| **4** | [debate-prompt-phase4.md](debate-prompt-phase4.md) | Full SSOT — absorb `dialogue-prompts.ts` into builder | Medium-High | Yes |

### Dependency Chain

```
Phase 1 (taskContext/outputFormat split)
  └─ Phase 2 (persona injection)
       └─ Phase 3 (extract DebatePromptBuilder class)
            └─ Phase 4 (absorb dialogue-prompts.ts)
```

Each phase depends on the previous, but each is independently shippable — you can stop after any phase and have a working system.

## Builder Interface (target after Phase 4)

```typescript
// src/debate/prompt-builder.ts

interface StageContext {
  taskContext: string;    // Task description — spec, codebase, constraints. No output format.
  outputFormat: string;   // JSON schema, "output raw JSON", etc.
  stage: "plan" | "review" | "acceptance" | "rectification" | "escalation";
}

class DebatePromptBuilder {
  constructor(stageContext: StageContext, options: PromptBuilderOptions)

  // Proposal (round 0) — includes taskContext + outputFormat + persona
  buildProposalPrompt(debaterIndex: number): string

  // Panel-mode critique (round 1+) — excludes own proposal, no outputFormat
  buildCritiquePrompt(debaterIndex: number, proposals: Proposal[]): string

  // Hybrid-mode rebuttal (round 1+) — all proposals + prior rebuttals, no outputFormat
  buildRebuttalPrompt(debaterIndex: number, proposals: Proposal[], priorRebuttals: Rebuttal[]): string

  // Resolver prompts — all proposals + critiques + outputFormat
  buildSynthesisPrompt(proposals: Proposal[], critiques: Rebuttal[], promptSuffix?: string): string
  buildJudgePrompt(proposals: Proposal[], critiques: Rebuttal[]): string
  buildMajorityResolverPrompt(proposals: Proposal[], critiques: Rebuttal[]): string
  buildReReviewPrompt(proposals: Proposal[], critiques: Rebuttal[], updatedContext: string): string

  // Session control
  buildClosePrompt(): string
}
```

## Success Criteria

1. After Phase 1: rebuttal prompts contain no output format instructions — verified by prompt audit
2. After Phase 2: persona labels appear in proposals and critiques; 3x same-model debaters with distinct personas produce structurally divergent PRDs
3. After Phase 2: without personas (`autoPersona: false`), behaviour is identical to pre-Phase-2
4. After Phase 3: `src/debate/prompts.ts` is deleted; all plan/generic debate prompt construction goes through `DebatePromptBuilder`
5. After Phase 4: `src/review/dialogue-prompts.ts` is deleted; `ReviewerSession` uses builder exclusively
6. All phases: existing tests pass (updated to new signatures)
7. Benchmark: re-run bench-03/04/05 after Phase 1 and verify G3 no longer manifests
