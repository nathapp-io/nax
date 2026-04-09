# Phase 2: Add Debater Persona Injection

**Status:** Draft
**Parent:** [debate-prompt-builder.md](debate-prompt-builder.md)
**Depends on:** [Phase 1](debate-prompt-phase1.md) (taskContext/outputFormat split)
**Fixes:** G2, G4, G7

---

## Problem

### G2 — No debater persona differentiation in plan phase

In the plan debate, all 3 debaters receive identical prompts. The only differentiation is:
- `prd-debate-${i}.json` — the output file path suffix (not visible in the prompt body)
- `"You are debater N"` — a bare number injected only during rebuttal rounds, not in the initial proposal

With same-model debaters (e.g. 3× Haiku/MiniMax-M2.7 as in the benchmark config), this produces 90%+ overlapping PRD outputs. The debate costs 3× a single planner call but adds minimal signal. In bench-03, all three debaters converged on the same fix with only cosmetic differences (line number references, contextFiles lists). The synthesis stage carried the entire value of the debate.

**Benchmark evidence:**
- bench-03: All 3 PRDs proposed the same 2-line fix, same test strategy, same branch name
- bench-04: Debaters 0 and 2 agreed on writeFileSync import status; debater 1 disagreed — but this divergence came from stochastic variation, not structured analysis
- bench-05: Most divergent run — debater-2 proposed a 3-story decomposition vs 2-story from others — but again, this was random, not directed

### G4 — No review debater differentiation

All 3 review-round-1 prompts are byte-identical. No reviewer persona, no assigned focus area, no different section of the code to examine. In bench-03, all three reviewers produced identical `{"passed":true,"findings":[]}`. In bench-04 and bench-05, same pattern — the review debate was a no-op in every run, producing 3× cost for 1× signal.

### G7 — All debater proposals labeled "claude" in final reviewer

In the resolver prompt, debater proposals are labeled by agent name only:
```
### claude
{"passed":true,"findings":[]}
### claude
{"passed":true,"findings":[]}
### claude
{"passed":true,"findings":[]}
```

When debaters disagree, the resolver has no way to reference which debater held which position ("the security-focused reviewer's concern about input validation" vs "debater 2's finding"). This degrades the resolver's ability to reason about conflicting positions.

---

## Solution

### Schema Changes

Add an optional `persona` field to each debater and an `autoPersona` flag at the stage level:

```typescript
// src/config/schemas.ts

const DebaterPersonaEnum = z.enum([
  "challenger",
  "pragmatist",
  "completionist",
  "security",
  "testability",
]);

const DebaterSchema = z.object({
  agent: z.string().min(1, "debater.agent must be non-empty"),
  model: z.string().min(1, "debater.model must be non-empty").optional(),
  persona: DebaterPersonaEnum.optional(),
});

// Inside DebateStageConfigSchema:
autoPersona: z.boolean().default(false),
```

```typescript
// src/debate/types.ts
export type DebaterPersona =
  | "challenger"
  | "pragmatist"
  | "completionist"
  | "security"
  | "testability";

export interface Debater {
  agent: string;
  model?: string;
  persona?: DebaterPersona;
}

// Add to DebateStageConfig:
/** When true, auto-assign personas to debaters that have no explicit persona. Default: false. */
autoPersona: boolean;
```

### Persona Presets

Five curated presets, each with an identity (who) and a lens (what to focus on):

| Preset | Identity | Lens |
|--------|----------|------|
| **challenger** | Stress-test proposals and find weaknesses | Question assumptions, look for missing edge cases, unhandled error states, scenarios where the approach breaks under real conditions |
| **pragmatist** | Find the simplest path that satisfies the spec | Favour minimal scope, fewest files, lowest complexity. Challenge unnecessary abstraction. If 5 lines works, don't use 50 |
| **completionist** | Ensure nothing is missed | Verify every AC is addressed, edge cases have tests, error messages are user-friendly, all status variants are handled. Flag ambiguous spec |
| **security** | Surface risks before they ship | Evaluate input validation, secret handling, injection vectors, trust boundaries. Scrutinise auth, permissions, external APIs |
| **testability** | Ensure the design is verifiable | Assess whether implementation can be tested without mocks, boundaries are clean, ACs are machine-verifiable. Challenge hidden side effects |

```typescript
// src/debate/personas.ts

export const PERSONA_FRAGMENTS: Record<DebaterPersona, { identity: string; lens: string }> = {
  challenger: {
    identity: "You are the challenger — your job is to stress-test proposals and find weaknesses.",
    lens:
      "Question every assumption. Look for missing edge cases, unhandled error states, " +
      "and scenarios where the proposed approach could break under real-world conditions. " +
      "If a proposal lacks justification for a design choice, call it out.",
  },
  pragmatist: {
    identity: "You are the pragmatist — your job is to find the simplest path that satisfies the spec.",
    lens:
      "Favour minimal scope, fewest files changed, and lowest complexity. " +
      "Challenge any proposal that adds abstraction, configuration, or code beyond what the spec requires. " +
      "If something can be done in 5 lines instead of 50, advocate for the 5-line version.",
  },
  completionist: {
    identity: "You are the completionist — your job is to ensure nothing is missed.",
    lens:
      "Verify every acceptance criterion is addressed. Check that edge cases have tests, " +
      "that error messages are user-friendly, and that the implementation handles all status/state variants. " +
      "If the spec is ambiguous, flag it and propose the safer interpretation.",
  },
  security: {
    identity: "You are the security reviewer — your job is to surface risks before they ship.",
    lens:
      "Evaluate input validation, secret handling, injection vectors, and trust boundaries. " +
      "Check that user-supplied data is never used unsanitised in commands, queries, or file paths. " +
      "If the proposal touches auth, permissions, or external APIs, apply extra scrutiny.",
  },
  testability: {
    identity: "You are the testability advocate — your job is to ensure the design is verifiable.",
    lens:
      "Assess whether the proposed implementation can be tested without mocks, " +
      "whether test boundaries are clean, and whether the acceptance criteria are machine-verifiable. " +
      "Challenge any design that makes testing harder (global state, tight coupling, hidden side effects).",
  },
};
```

### Auto-Assignment Logic (`autoPersona`)

When `autoPersona: true`, debaters without an explicit `persona` are assigned one from a stage-specific rotation. Explicit `persona` values always take priority.

```typescript
// src/debate/personas.ts

const PLAN_ROTATION: DebaterPersona[] = [
  "challenger", "pragmatist", "completionist", "security", "testability",
];

const REVIEW_ROTATION: DebaterPersona[] = [
  "security", "completionist", "testability", "challenger", "pragmatist",
];

export function resolvePersonas(
  debaters: Debater[],
  stage: "plan" | "review",
  autoPersona: boolean,
): Debater[] {
  if (!autoPersona) return debaters;

  const rotation = stage === "plan" ? PLAN_ROTATION : REVIEW_ROTATION;
  let rotationIndex = 0;

  return debaters.map((d) => {
    if (d.persona) return d;
    const assigned = rotation[rotationIndex % rotation.length];
    rotationIndex++;
    return { ...d, persona: assigned };
  });
}
```

**Default rotation by debater count:**

| Count | Plan rotation | Review rotation |
|-------|---------------|-----------------|
| 2 | challenger, pragmatist | security, completionist |
| 3 | challenger, pragmatist, completionist | security, completionist, testability |
| 4+ | full cycle | full cycle |

### Prompt Injection

Persona is injected into all debate prompt phases via a `## Your Role` block:

```typescript
function buildPersonaBlock(debater: Debater): string {
  if (!debater.persona) return "";
  const { identity, lens } = PERSONA_FRAGMENTS[debater.persona];
  return `\n\n## Your Role\n${identity}\n${lens}\n`;
}
```

**Proposal prompt (round 0):**
```
{taskContext}
{personaBlock}               ← NEW: "You are the challenger — ..."
{outputFormat}
```

**Rebuttal prompt (round 1+, from Phase 1):**
```
## Proposals ...
## Previous Rebuttals ...
{personaBlock}               ← NEW
## Your Task
You are debater N (challenger). Provide your critique in prose.
```

### Proposal Label Fix (G7)

Update proposal labels to include persona when available:

```typescript
// Instead of: "### claude"
// Produce:    "### claude (challenger)"
function buildDebaterLabel(debater: Debater): string {
  return debater.persona
    ? `${debater.agent} (${debater.persona})`
    : debater.agent;
}
```

### Config Examples

**Explicit personas (recommended for production):**
```json
{
  "debate": {
    "stages": {
      "plan": {
        "enabled": true,
        "debaters": [
          { "agent": "claude", "model": "haiku", "persona": "challenger" },
          { "agent": "claude", "model": "haiku", "persona": "pragmatist" },
          { "agent": "claude", "model": "haiku", "persona": "completionist" }
        ]
      },
      "review": {
        "enabled": true,
        "debaters": [
          { "agent": "claude", "model": "haiku", "persona": "security" },
          { "agent": "claude", "model": "haiku", "persona": "completionist" },
          { "agent": "claude", "model": "haiku", "persona": "testability" }
        ]
      }
    }
  }
}
```

**Auto-assign (let nax choose):**
```json
{
  "debate": {
    "stages": {
      "plan": {
        "enabled": true,
        "autoPersona": true,
        "debaters": [
          { "agent": "claude", "model": "haiku" },
          { "agent": "claude", "model": "haiku" },
          { "agent": "claude", "model": "haiku" }
        ]
      }
    }
  }
}
```

**Benchmark mode (no personas — current behaviour):**
```json
{
  "debaters": [
    { "agent": "claude", "model": "haiku" },
    { "agent": "claude", "model": "haiku" },
    { "agent": "claude", "model": "haiku" }
  ]
}
```
`autoPersona` defaults to `false`, so omitting it preserves current identical-prompt behaviour.

**Partial explicit — mix of explicit and auto-assigned:**
```json
{
  "autoPersona": true,
  "debaters": [
    { "agent": "claude", "model": "haiku", "persona": "security" },
    { "agent": "claude", "model": "haiku" },
    { "agent": "claude", "model": "haiku" }
  ]
}
```
Result: debater 0 = `security` (explicit), debater 1 = `challenger` (auto), debater 2 = `pragmatist` (auto).

---

## Files to Change

| File | Change |
|------|--------|
| `src/config/schemas.ts` | Add `persona` to `DebaterSchema`, `autoPersona` to `DebateStageConfigSchema` |
| `src/debate/types.ts` | Add `DebaterPersona` type, `persona` to `Debater`, `autoPersona` to `DebateStageConfig` |
| `src/debate/personas.ts` | **New** — `PERSONA_FRAGMENTS`, `resolvePersonas()`, `buildPersonaBlock()`, `buildDebaterLabel()` |
| `src/debate/prompts.ts` | Add persona block to `buildCritiquePrompt()`, `buildRebuttalContext()` (Phase 1 version); use `buildDebaterLabel()` in proposals section |
| `src/debate/session-plan.ts` | Call `resolvePersonas()` before dispatching debaters; inject persona into proposal prompt |
| `src/debate/session-hybrid.ts` | Pass resolved debaters (with personas) through rebuttal loop |
| `src/debate/index.ts` | Export `personas.ts` |
| `test/unit/debate/personas.test.ts` | **New** — preset validation, `resolvePersonas()` edge cases, `buildPersonaBlock()` output |
| `test/unit/debate/prompts.test.ts` | Add persona injection + label assertions |

---

## Risk Assessment

**Risk: Low.**

- `persona` is optional — when absent, no persona block is injected, behaviour is identical to today
- `autoPersona` defaults to `false` — existing configs produce zero change
- All changes are additive — no existing function signatures change (persona is injected inside existing functions)
- `DebaterSchema.parse()` with existing configs produces `persona: undefined`

**Potential issue:** On smaller models (Haiku), the persona instruction competes with the main task prompt for attention budget. The persona could cause the debater to "roleplay" instead of doing technical analysis. Mitigated by keeping persona text short (2–3 sentences) and framing it as analytical lens, not character roleplay.

---

## Verification

1. Run `bun test` — all existing tests pass unchanged (persona is optional)
2. Run debate bench with `autoPersona: true` — verify prompt audit shows persona blocks in debater prompts
3. Compare PRD outputs with/without personas — with personas, PRDs should show structural divergence (different AC counts, different complexity assessments, different risk callouts)
4. Verify proposal labels in resolver prompt show `"claude (challenger)"` format

---

## Success Criteria

- With 3× same-model debaters + distinct personas, plan PRDs show meaningful structural divergence
- With review personas, at least 2 of 3 debaters produce non-identical findings
- Without personas (`autoPersona: false`, no explicit `persona`), behaviour is byte-identical to pre-Phase-2
- Proposal labels in resolver include persona attribution (G7 resolved)

---

## Out of Scope

- **Freeform persona strings** — presets only; deferred to avoid bad user-authored personas degrading output
- **Per-round persona rotation** — same persona for all rounds; rotation adds complexity with unclear benefit
- **Persona for resolver agent** — resolver has its own framing via `buildResolverFraming()`
- **`autoPersona: true` as default** — deferred until benchmarks confirm persona-on consistently outperforms persona-off
