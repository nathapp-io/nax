# Phase 1: Split `taskContext` / `outputFormat` in Rebuttal Path

**Status:** Draft
**Parent:** [debate-prompt-builder.md](debate-prompt-builder.md)
**Depends on:** None
**Fixes:** G3, G8, B3-6, B5-4

---

## Problem

### G3 — Contradictory hybrid instructions

In hybrid debate mode, debaters alternate between proposing (round 0) and critiquing/rebutting (round 1+). The rebuttal prompt is constructed by `buildRebuttalContext()` in `src/debate/prompts.ts:71–95`:

```typescript
return `${prompt}              // ← the FULL plan prompt (~230 lines)

## Proposals
${proposalsSection}${rebuttalsSection}

## Your Task
You are debater ${debaterNumber}. Provide your rebuttal to the proposals and previous rebuttals above.`;
```

The `prompt` parameter is the original plan prompt — the same one used for round 0 proposals. It contains:
- "You are a senior software architect" (role instruction)
- Full PRD JSON schema with field descriptions (~30 lines)
- "Output ONLY the JSON object. Do NOT wrap in markdown." (format directive)
- Step-by-step analysis instructions

Then at the very bottom, a single line says "Provide your rebuttal."

**The model sees 230 lines of "produce JSON" and 1 line of "produce a rebuttal."** The JSON instruction dominates.

**Observed impact across 3 benchmark runs:**
- bench-03: Critique 2 started with prose ("Let me read the actual source files...") then output a JSON blob — mixed format contaminated the synthesis input
- bench-04: Critique 2 was a full JSON PRD embedded in the rebuttal section instead of prose analysis
- bench-05: Debater-3 in round 1 produced a complete PRD JSON instead of a critique, which propagated into synthesis as "Critique 3" even though it was a proposal

The same issue affects the review debate path. Review debaters receive "Your entire response must be a single JSON object" in the task prompt, then round-2 appends "critique these proposals and provide your refined analysis" — contradictory format requirements.

### G8 — Full PRD schema repeated in every rebuttal round

Because `buildRebuttalContext()` prepends the entire original prompt, the full PRD output schema (~90 lines of JSON template + complexity guide + acceptance criteria rules) is repeated verbatim in every rebuttal prompt. Across 3 debaters × 2 rounds × 3 features, that is 18 repetitions of boilerplate that the model doesn't need for a critique task.

**Estimated token waste per feature:** ~810 lines of redundant schema text across all hybrid rounds.

### B3-6 — Prose contamination in critiques

When debaters produce mixed format output (prose followed by JSON, or JSON followed by prose), that output is carried verbatim into the synthesis prompt under `## Critiques`. The synthesiser must parse a JSON blob embedded in what should be a prose critique section. This is a downstream consequence of G3 — if the critique prompt clearly asked for prose only, the model wouldn't mix formats.

### B5-4 — Debater produces JSON PRD instead of critique

Debater-3 in bench-05 round 1 produced a complete PRD JSON instead of a text critique. The synthesis agent received it as "Critique 3" and had to treat it as yet another proposal rather than analytical feedback. The debate round was effectively wasted — 3 proposals instead of 2 proposals + 1 critique.

### Duplicate `buildRebuttalContext()` implementations

Two versions exist:
- `src/debate/prompts.ts:71` — 4-arg positional signature, **used in production** by `session-hybrid.ts`
- `src/debate/session-helpers.ts:374` — single opts-object signature, **unused in production** but exported from the barrel `src/debate/index.ts`

An acceptance test asserts on the barrel-exported (unused) version. This creates maintenance confusion and divergence risk.

---

## Solution

Split the plan/review prompt into two parts at the caller boundary:

| Part | Contains | Used in |
|------|----------|---------|
| `taskContext` | Spec, codebase context, analysis instructions — what to think about | Proposal (round 0) + rebuttal (round 1+) |
| `outputFormat` | JSON schema, "Output ONLY the JSON object", format rules — how to format the answer | Proposal (round 0) only |

The rebuttal builder receives `taskContext` only — never `outputFormat`. It appends an explicit "Do NOT output JSON — provide your critique in prose" instruction.

### Before (current)

```
[Round 0 — proposal]
{full prompt = taskContext + outputFormat}

[Round 1 — rebuttal]
{full prompt = taskContext + outputFormat}   ← G3: outputFormat contradicts "provide rebuttal"
## Proposals ...
## Your Task: provide your rebuttal
```

### After (proposed)

```
[Round 0 — proposal]
{taskContext}
{outputFormat}

[Round 1 — rebuttal]
{taskContext}                                ← only in one-shot mode; omitted in stateful
## Proposals ...
## Previous Rebuttals ...
## Your Task
You are debater N. Provide your critique in prose.
Do NOT output JSON — focus on strengths, weaknesses, and specific improvements.
```

### `sessionMode` handling

In **stateful** mode (multi-turn ACP session), the debater already saw `taskContext` in turn 1 (the proposal round). Re-sending it in turn 2 is redundant. In **one-shot** mode, each round is a fresh prompt with no prior context, so `taskContext` must be included.

```typescript
function buildRebuttalContext(
  taskContext: string,            // was: prompt (full plan prompt)
  proposals: Array<{ debater: Debater; output: string }>,
  rebuttalOutputs: string[],
  currentDebaterIndex: number,
  sessionMode: "stateful" | "one-shot",
): string {
  const contextBlock = sessionMode === "one-shot" ? `${taskContext}\n\n` : "";
  const proposalsSection = proposals
    .map((p, i) => `### Proposal ${i + 1} (${p.debater.agent})\n${p.output}`)
    .join("\n\n");

  const rebuttalsSection =
    rebuttalOutputs.length > 0
      ? `\n\n## Previous Rebuttals\n${rebuttalOutputs.map((r, i) => `${i + 1}. ${r}`).join("\n\n")}`
      : "";

  const debaterNumber = currentDebaterIndex + 1;

  return `${contextBlock}## Proposals
${proposalsSection}${rebuttalsSection}

## Your Task
You are debater ${debaterNumber}. Provide your critique in prose.
Identify strengths, weaknesses, and specific improvements for each proposal.
Do NOT output JSON — focus on analysis only.`;
}
```

### `taskContext` / `outputFormat` split at the caller

`buildPlanningPrompt()` in `src/cli/plan.ts` currently returns a single string. It must be refactored to return both parts:

```typescript
interface PlanningPromptParts {
  taskContext: string;   // spec + codebase + analysis instructions
  outputFormat: string;  // PRD JSON schema + output rules
}

function buildPlanningPrompt(...): PlanningPromptParts {
  const taskContext = `...spec...codebase...analysis steps 1-2...`;
  const outputFormat = `...PRD JSON schema...Output ONLY the JSON object...`;
  return { taskContext, outputFormat };
}
```

Callers that need the full prompt (proposal round) concatenate: `taskContext + "\n\n" + outputFormat`.
Callers that need the rebuttal prompt pass `taskContext` only.

---

## Files to Change

| File | Change |
|------|--------|
| `src/debate/prompts.ts` | Change `buildRebuttalContext()` signature: `prompt` → `taskContext`, add `sessionMode`. Add explicit prose-only instruction. |
| `src/debate/session-hybrid.ts` | `runRebuttalLoop()` accepts `taskContext` instead of `originalPrompt`. Callers split before passing. |
| `src/debate/session-plan.ts` | Receive `{ taskContext, outputFormat }` from plan prompt builder. Pass `taskContext` to rebuttal loop, concatenate both for proposal round. |
| `src/cli/plan.ts` | `buildPlanningPrompt()` returns `{ taskContext, outputFormat }` instead of a single string. |
| `src/debate/session-helpers.ts` | Delete duplicate `buildRebuttalContext()` (the unused opts-object version). |
| `src/debate/index.ts` | Remove `buildRebuttalContext` re-export from `session-helpers`. |
| `test/unit/debate/prompts.test.ts` | Update assertions for new signature and prose-only instruction. |
| `.nax/features/debate-session-mode/.nax-acceptance.test.ts` | Remove or update (tests the deleted version). |

---

## Risk Assessment

**Risk: Low.**

- The core change is narrowing the input to `buildRebuttalContext()` — a pure function with no side effects
- Callers do the split at the boundary — `session-plan.ts` and `session-hybrid.ts` each pass `taskContext` instead of the full prompt
- `buildPlanningPrompt()` return type change is internal — no external API consumers
- The deleted `session-helpers.ts` version is unused in production; the acceptance test is the only consumer

**Potential issue:** `buildPlanningPrompt()` currently interleaves context and format instructions throughout a long template string. The split may require reorganising the template so all format instructions are in the second half. This is a mechanical refactor of the template, not a logic change.

---

## Verification

1. Run `bun test test/unit/debate/prompts.test.ts` — all assertions pass with new signature
2. Run a debate hybrid bench with prompt audit enabled — verify rebuttal audit files contain no PRD JSON schema or "Output ONLY the JSON object" text
3. Compare rebuttal outputs between before/after — debaters should produce prose critiques, not JSON PRDs
4. Run full test suite (`bun run test`) — no regressions

---

## Success Criteria

- Rebuttal prompts contain zero output format instructions — verified by prompt audit
- No debater produces a full JSON PRD in a rebuttal round (G3 resolved)
- Rebuttal prompts are ~90 lines shorter per round (G8 resolved)
- Critique outputs are prose, not mixed prose/JSON (B3-6 resolved)
- Only one `buildRebuttalContext()` exists in the codebase (duplicate deleted)
