---
title: Multi-Agent Debate
description: Resolver strategies, session modes, debater personas, and behavior matrices for the debate system
---

## Multi-Agent Debate

The debate system runs N independent agents in parallel on the same prompt, then resolves their proposals into a single verdict. It is available on the **review** and **plan** stages.

Enable via config:

```json
{
  "debate": {
    "enabled": true,
    "stages": {
      "review": {
        "enabled": true,
        "debaters": [
          { "agent": "claude", "model": "balanced" },
          { "agent": "claude", "model": "fast" }
        ],
        "resolver": { "type": "majority-fail-closed" }
      }
    }
  }
}
```

---

## Debater Personas

Each debater can be assigned an **analytical lens** that shapes how it frames its proposal or critique. Personas prevent same-model debaters from producing near-identical outputs and make the resolver's job easier by ensuring each proposal approaches the problem from a distinct angle.

### Available Personas

| Persona | Analytical focus |
|:--------|:-----------------|
| `challenger` | Challenges assumptions, identifies weak points, proposes alternative approaches |
| `pragmatist` | Prioritises deliverability — effort, risk, and timeline constraints |
| `completionist` | Ensures nothing is missed — edge cases, error paths, test coverage |
| `security` | Flags authentication, authorisation, injection, and data-exposure risks |
| `testability` | Evaluates testability, observability, and verification coverage |

### Auto-Rotation (`autoPersona`)

Set `autoPersona: true` on a stage to have nax automatically assign a persona to each debater in order. Debaters without an explicit `persona` field receive personas from a stage-specific rotation list:

| Stage | Rotation order |
|:------|:---------------|
| `plan` | `challenger → pragmatist → completionist → security → testability` |
| `review` | `security → completionist → testability → challenger → pragmatist` |

If there are more debaters than personas, the list wraps around. Explicit `persona` fields always override auto-rotation.

```json
{
  "debate": {
    "stages": {
      "plan": {
        "autoPersona": true
      },
      "review": {
        "autoPersona": true
      }
    }
  }
}
```

`autoPersona` defaults to `false` — existing configs are unaffected.

### Explicit Persona Assignment

Assign personas per debater directly in the `debaters` array. This gives full control and is useful when you want specific lenses regardless of debater count:

```json
{
  "debate": {
    "stages": {
      "plan": {
        "debaters": [
          { "agent": "claude", "model": "balanced", "persona": "challenger" },
          { "agent": "claude", "model": "balanced", "persona": "pragmatist" },
          { "agent": "claude", "model": "fast",     "persona": "completionist" }
        ]
      }
    }
  }
}
```

### How Personas Appear in Prompts

Personas are injected in all session modes — panel and hybrid alike:

| Prompt type | Panel | Hybrid |
|:------------|:-----:|:------:|
| Proposal (round 0) | ✓ | ✓ |
| Critique (`rounds > 1`) | ✓ | ✓ |
| Rebuttal | — | ✓ |

When a debater has a persona, a `## Your Role` block is injected into its prompt. The block contains an identity statement and a lens description specific to that persona. In critique and rebuttal prompts, proposals are also labelled with their originating debater's lens (e.g. `claude (challenger)`) so each debater knows which perspective produced each proposal.

---

## Resolver Types

Four resolver types are available. The resolver runs after all debater proposals are collected.

| Config value | Strategy | LLM call | Notes |
|:---|:---|:---:|:---|
| `majority-fail-closed` | Vote count — unparseable proposals count as **fail** | No (stateless) / Yes (with dialogue) | Safe default — errs toward failing |
| `majority-fail-open` | Vote count — unparseable proposals count as **pass** | No (stateless) / Yes (with dialogue) | Use when debaters are noisy |
| `synthesis` | `adapter.complete()` synthesises all proposals into one verdict | Yes | Good for nuanced decisions |
| `custom` | `adapter.complete()` with a judge prompt; uses `resolver.agent` | Yes | Full control over resolver behaviour |

### Asymmetric Resolver Model

The resolver can use a different model tier than the debaters via the `model` field on `resolver`:

```json
{
  "debate": {
    "stages": {
      "review": {
        "debaters": [
          { "agent": "claude", "model": "fast" },
          { "agent": "claude", "model": "fast" }
        ],
        "resolver": {
          "type": "synthesis",
          "model": "powerful"
        }
      }
    }
  }
}
```

This enables cost-effective configurations: cheap debaters for breadth, powerful resolver for final judgment.

When `review.dialogue.enabled` is also `true`, all four resolver types are upgraded: they route through `reviewerSession.resolveDebate()` instead of the stateless path, gaining tool access (READ, GREP) and session continuity. See [Behavior Matrix — Review Stage](./semantic-review.md#behavior-matrix--review-stage).

---

## Session Modes

| Mode | Debater calls | Rebuttal loop | Use when |
|:---|:---|:---:|:---|
| `one-shot` | `agent.complete()` (stateless) | No | Fast, cheap, no inter-debater context |
| `stateful` | `agent.run()` (persistent session) | Yes (hybrid mode) | Richer proposals, supports rebuttal |
| `hybrid` | `agent.plan()` for proposals + `agent.run()` for rebuttals | Yes | Plan-stage debates |

Configure via `debate.sessionMode` (default: `"one-shot"`).

---

## Behavior Matrix — Plan Stage

The plan stage dispatches `planOp` (a `kind:"complete"` Operation) for proposals — sessionless one-shots through `AgentManager.completeAs`. `review.dialogue` does **not** apply to plan — `ReviewerSession` is not created for plan-stage debates.

| debate | sessionMode | mode | Proposer | Rebuttal | Resolver |
|:---:|:---:|:---:|:---|:---|:---|
| off | — | — | Single `planOp` (complete) | None | N/A |
| on | one-shot | panel | N `planOp` (parallel completes) | None | Stateless resolver |
| on | stateful | panel | N `planOp` (parallel completes) | None | Stateless resolver |
| on | stateful | hybrid | N `planOp` (parallel completes) | Sequential via `callOp` run-kind ops (`runRebuttalLoop`) | Stateless resolver |
| on | one-shot | hybrid | N `planOp` (parallel completes) | **Skipped** — warns "hybrid requires stateful" | Stateless resolver |

The resolver on the plan stage is always stateless regardless of dialogue settings. This matrix is unchanged by the debate+dialogue feature (Phase 2).

---

## Debate + Dialogue (Review Stage Only)

When both `debate.stages.review.enabled` and `review.dialogue.enabled` are `true`, the resolver gains persistent session continuity and tool access via `ReviewerSession`. Individual debaters remain isolated and stateless.

```json
{
  "debate": {
    "enabled": true,
    "stages": {
      "review": {
        "enabled": true,
        "debaters": [
          { "agent": "claude", "model": "balanced" },
          { "agent": "claude", "model": "fast" }
        ],
        "resolver": { "type": "majority-fail-closed" }
      }
    }
  },
  "review": {
    "dialogue": {
      "enabled": true,
      "maxDialogueMessages": 20
    }
  }
}
```

What this enables:

- **Tool access for the resolver** — resolver can READ files and GREP for usage before giving its verdict, instead of ruling on unverified debater claims.
- **Session continuity across re-reviews** — when autofix triggers a re-review, the same `ReviewerSession` is reused. The resolver sees what it found last round and focuses on whether the implementer's fix addressed those findings.
- **Clarification channel** — the autofix implementer can send `CLARIFY:` questions to the reviewer session during rectification.

See [Behavior Matrix — Review Stage](./semantic-review.md#behavior-matrix--review-stage) for the full flag combination table.

---

## Failure Handling

| Failure | Recovery |
|:---|:---|
| Debater proposal fails / throws | Excluded from proposals; debate continues with remaining debaters |
| All debaters fail | `DebateResult.outcome = "failed"` — story escalates |
| `resolveDebate()` throws (dialogue path) | Falls back to stateless resolver (`majorityResolver` / `synthesisResolver` / `judgeResolver`) |
| `reReviewDebate()` throws | Falls back to full re-debate (debaters re-run, stateless resolver) |
| `ReviewerSession` already destroyed | `REVIEWER_SESSION_DESTROYED` — caught by fallback logic |
