# Phase 3: Extract `DebatePromptBuilder` Class

**Status:** Draft
**Parent:** [debate-prompt-builder.md](debate-prompt-builder.md)
**Depends on:** [Phase 2](debate-prompt-phase2.md) (persona injection)
**Fixes:** Code duplication across debate prompt functions

---

## Problem

After Phase 1 and Phase 2, the debate prompt system works correctly but the implementation is still spread across multiple standalone functions in `src/debate/prompts.ts`:

- `buildCritiquePrompt()` — panel-mode critique (round 1+)
- `buildRebuttalContext()` — hybrid-mode rebuttal (round 1+)
- `buildSynthesisPrompt()` — synthesis resolver
- `buildJudgePrompt()` — judge resolver

Plus persona logic in `src/debate/personas.ts`:
- `buildPersonaBlock()` — persona fragment injection
- `buildDebaterLabel()` — persona-aware proposal labels

These functions share internal concerns (proposal formatting, critique formatting, persona injection, debater labeling) but each reimplements them independently. Adding a new debate stage or prompt phase means adding another standalone function with duplicated formatting logic.

The review debate path in `src/review/dialogue-prompts.ts` has its own parallel versions of `buildProposalsSection()` and `buildCritiquesSection()` — Phase 4 will absorb these, but only if Phase 3 establishes a clean builder interface first.

---

## Solution

Extract all plan/generic debate prompt functions into a `DebatePromptBuilder` class. The class owns all shared formatting logic as private methods and exposes one public method per prompt phase.

### Class Design

```typescript
// src/debate/prompt-builder.ts

import type { Debater, Proposal, Rebuttal, DebaterPersona } from "./types";
import { PERSONA_FRAGMENTS } from "./personas";

interface StageContext {
  /** Task description — spec, codebase, constraints. No output format instructions. */
  taskContext: string;
  /** Output format instructions — JSON schema, "output raw JSON", etc. */
  outputFormat: string;
  /** Stage name — determines default critique guidance text. */
  stage: "plan" | "review" | "acceptance" | "rectification" | "escalation";
}

interface PromptBuilderOptions {
  /** Debaters participating in this debate (with personas resolved). */
  debaters: Debater[];
  /** Session mode — affects whether taskContext is included in rebuttals. */
  sessionMode: "stateful" | "one-shot";
}

export class DebatePromptBuilder {
  constructor(
    private readonly stageContext: StageContext,
    private readonly options: PromptBuilderOptions,
  ) {}

  /** Round 0 — initial proposal. Includes taskContext + outputFormat + persona. */
  buildProposalPrompt(debaterIndex: number): string {
    const persona = this.buildPersonaBlock(debaterIndex);
    return `${this.stageContext.taskContext}${persona}\n\n${this.stageContext.outputFormat}`;
  }

  /** Panel-mode critique (round 1+). Excludes calling debater's own proposal. No outputFormat. */
  buildCritiquePrompt(debaterIndex: number, proposals: Proposal[]): string {
    const otherProposals = proposals.filter((_, i) => i !== debaterIndex);
    const proposalsSection = this.buildProposalsSection(otherProposals);
    const persona = this.buildPersonaBlock(debaterIndex);

    return `You are reviewing proposals for a ${this.stageContext.stage} task.

## Task
${this.stageContext.taskContext}

## Other Agents' Proposals
${proposalsSection}${persona}

Please critique these proposals and provide your refined analysis, identifying strengths, weaknesses, and your own updated position.`;
  }

  /** Hybrid-mode rebuttal (round 1+). All proposals + prior rebuttals. No outputFormat. */
  buildRebuttalPrompt(
    debaterIndex: number,
    proposals: Proposal[],
    priorRebuttals: Rebuttal[],
  ): string {
    const contextBlock =
      this.options.sessionMode === "one-shot"
        ? `${this.stageContext.taskContext}\n\n`
        : "";

    const proposalsSection = this.buildProposalsSection(proposals);
    const rebuttalsSection = this.buildRebuttalsSection(priorRebuttals);
    const persona = this.buildPersonaBlock(debaterIndex);
    const debaterNumber = debaterIndex + 1;

    return `${contextBlock}## Proposals
${proposalsSection}${rebuttalsSection}${persona}

## Your Task
You are debater ${debaterNumber}. Provide your critique in prose.
Identify strengths, weaknesses, and specific improvements for each proposal.
Do NOT output JSON — focus on analysis only.`;
  }

  /** Synthesis resolver — all proposals + critiques + outputFormat. */
  buildSynthesisPrompt(
    proposals: Proposal[],
    critiques: Rebuttal[],
    promptSuffix?: string,
  ): string {
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);

    return `You are a synthesis agent. Your task is to combine the strongest elements from multiple proposals into a single, optimal response.

${this.stageContext.taskContext}

## Proposals
${proposalsSection}

## Critiques
${critiquesSection}

Please synthesize these into the best possible unified response, incorporating the strongest elements from each proposal.
${this.stageContext.outputFormat}${promptSuffix ? `\n${promptSuffix}` : ""}`;
  }

  /** Judge resolver — same data, judge framing. */
  buildJudgePrompt(proposals: Proposal[], critiques: Rebuttal[]): string {
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);

    return `You are a judge evaluating multiple proposals. Select the best proposal or synthesize the optimal response.

${this.stageContext.taskContext}

## Proposals
${proposalsSection}

## Critiques
${critiquesSection}

Evaluate each proposal against the critiques and provide the best possible response.
${this.stageContext.outputFormat}`;
  }

  /** Termination signal. */
  buildClosePrompt(): string {
    return "Close this debate session.";
  }

  // --- Private helpers ---

  private buildPersonaBlock(debaterIndex: number): string {
    const debater = this.options.debaters[debaterIndex];
    if (!debater?.persona) return "";
    const { identity, lens } = PERSONA_FRAGMENTS[debater.persona];
    return `\n\n## Your Role\n${identity}\n${lens}`;
  }

  private buildProposalsSection(proposals: Proposal[]): string {
    return proposals
      .map((p, i) => `### Proposal ${i + 1} (${this.buildDebaterLabel(p.debater)})\n${p.output}`)
      .join("\n\n");
  }

  private buildRebuttalsSection(rebuttals: Rebuttal[]): string {
    if (rebuttals.length === 0) return "";
    return `\n\n## Previous Rebuttals\n${rebuttals.map((r, i) => `${i + 1}. ${r.output}`).join("\n\n")}`;
  }

  private buildCritiquesSection(critiques: Rebuttal[]): string {
    if (critiques.length === 0) return "";
    return critiques
      .map((c, i) => `### Critique ${i + 1} (${this.buildDebaterLabel(c.debater)})\n${c.output}`)
      .join("\n\n");
  }

  private buildDebaterLabel(debater: Debater): string {
    return debater.persona
      ? `${debater.agent} (${debater.persona})`
      : debater.agent;
  }
}
```

### Migration from standalone functions

Each existing function maps 1:1 to a builder method:

| Current function (`prompts.ts`) | Builder method | Notes |
|--------------------------------|----------------|-------|
| `buildCritiquePrompt(taskPrompt, allProposals, debaterIndex)` | `builder.buildCritiquePrompt(debaterIndex, proposals)` | `taskPrompt` comes from `stageContext.taskContext` |
| `buildRebuttalContext(taskContext, proposals, rebuttals, index, sessionMode)` | `builder.buildRebuttalPrompt(index, proposals, rebuttals)` | `taskContext` and `sessionMode` come from constructor |
| `buildSynthesisPrompt(proposals, critiques)` | `builder.buildSynthesisPrompt(proposals, critiques)` | Framing text now in builder |
| `buildJudgePrompt(proposals, critiques)` | `builder.buildJudgePrompt(proposals, critiques)` | Framing text now in builder |

### Caller migration example

```typescript
// session-plan.ts — BEFORE (Phase 2)
const debaterPrompt = `${taskContext}${personaBlock}\n\n${outputFormat}\n\nWrite the PRD JSON directly to...`;

// session-plan.ts — AFTER (Phase 3)
const builder = new DebatePromptBuilder(
  { taskContext, outputFormat, stage: "plan" },
  { debaters: resolvedDebaters, sessionMode: "stateful" },
);
const debaterPrompt = builder.buildProposalPrompt(i) + `\n\nWrite the PRD JSON directly to...`;
```

```typescript
// session-hybrid.ts — BEFORE (Phase 2)
const rebuttalPrompt = buildRebuttalContext(taskContext, proposalList, priorRebuttals, debaterIdx, "stateful");

// session-hybrid.ts — AFTER (Phase 3)
const rebuttalPrompt = builder.buildRebuttalPrompt(debaterIdx, proposalList, priorRebuttals);
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/debate/prompt-builder.ts` | **New** — `DebatePromptBuilder` class |
| `src/debate/prompts.ts` | Delete file (all functions moved to builder) |
| `src/debate/resolvers.ts` | Use builder for synthesis/judge prompts |
| `src/debate/session-plan.ts` | Construct builder, use `.buildProposalPrompt()` |
| `src/debate/session-hybrid.ts` | Use builder for rebuttal prompts |
| `src/debate/session-one-shot.ts` | Use builder for critique prompts |
| `src/debate/session-stateful.ts` | Use builder for critique prompts |
| `src/debate/index.ts` | Export `DebatePromptBuilder`, remove `prompts.ts` exports |
| `test/unit/debate/prompt-builder.test.ts` | **New** — builder method tests |
| `test/unit/debate/prompts.test.ts` | Delete (migrated to `prompt-builder.test.ts`) |

---

## Risk Assessment

**Risk: Medium.**

- Many callers need updating (6 files), but each change is a mechanical 1:1 replacement
- The builder methods produce the same output as the standalone functions — can be verified by diff-testing
- `prompts.ts` deletion is a breaking change for any external code importing from it — but `prompts.ts` is not exported from the barrel; only `buildRebuttalContext` was barrel-exported (and was deleted in Phase 1)
- `resolvers.ts` currently calls `buildSynthesisPrompt()` / `buildJudgePrompt()` directly — must receive a builder instance or construct one internally

**Potential issue:** `resolvers.ts` functions (`synthesisResolver`, `judgeResolver`) are called from `resolveOutcome()` in `session-helpers.ts`, which doesn't currently have access to a builder. Options:
1. Pass the builder to `resolveOutcome()` (clean, but adds a parameter)
2. Have `resolveOutcome()` construct its own builder from `config` + `stageConfig` (self-contained)
3. Have resolvers accept `taskContext` + `outputFormat` separately and construct the builder internally

Option 2 is recommended — `resolveOutcome()` already has access to all the data needed to construct a builder.

---

## Verification

1. Run `bun test` — all tests pass (migrated assertions)
2. `src/debate/prompts.ts` no longer exists
3. `grep -r "from.*prompts" src/debate/` returns zero hits (no imports from deleted file)
4. Run debate bench with prompt audit — output is identical to Phase 2 (no behavioural change)

---

## Success Criteria

- `src/debate/prompts.ts` is deleted
- All plan/generic debate prompt construction goes through `DebatePromptBuilder`
- Prompt audit output is identical to Phase 2 (pure refactor, no behavioural change)
- `DebatePromptBuilder` is exported from `src/debate/index.ts` and available for Phase 4
