# Plan Stage — Asymmetric Pipeline Proposal

**Date:** 2026-05-10
**Status:** Proposal
**Scope:** `nax plan` — replace single-session planning with a 3-phase asymmetric pipeline to eliminate spec→codebase hallucination and produce stronger acceptance criteria.

---

## 1. Problem

Current `nax plan` ([src/operations/plan.ts](../../src/operations/plan.ts)) is a single LLM call that consumes a spec + codebase context (filenames only, no content) and produces `prd.json`. Two failure modes survive existing safeguards:

1. **Spec→codebase drift.** Specs authored upstream by Opus/Sonnet (even with codebase reading) confidently assert files, APIs, schemas, or behaviors that no longer exist or never existed. The plan stage faithfully transcribes these into PRD stories. `SPEC_ANCHOR_RULES` ([src/config/test-strategy.ts:183](../../src/config/test-strategy.ts#L183)) prevents the *opposite* drift (plan inventing claims beyond spec) but treats the spec as authoritative.
2. **Weak acceptance criteria.** ACs are produced in the same pass as the proposal — the planner is asked to *generate* and *justify testability* simultaneously, with no separate audit.

Why specs hallucinate even when the upstream model read the codebase first:
- **Confirmation bias in grep.** Models scan to confirm a hypothesis ("there's a `User` schema, right?") and stop on plausible matches; they don't scan to falsify.
- **Time-of-spec ≠ time-of-plan.** Branches merge between spec authoring and `nax plan`. The plan stage is the next checkpoint with live repo state but currently treats the spec as ground truth.

Why a single planner can't catch this: producing a draft and auditing it against codebase reality are different cognitive tasks. Asking one agent to do both in one pass biases toward producing a confident draft that defends itself.

## 2. Why Not Debate

The current debate runner ([src/debate/runner-plan.ts](../../src/debate/runner-plan.ts)) uses N parallel debaters with persona lenses ([src/debate/personas.ts](../../src/debate/personas.ts)). Personas are **opinion-asymmetric but evidence-symmetric** — all debaters consume the same input (spec text + filename list, no file content). When the spec is wrong, all N are confidently wrong on the same hallucination, and the synthesis resolver merges agreement into a confident PRD. Same-model debaters produce 90%+ overlap (acknowledged in [personas.ts:6](../../src/debate/personas.ts#L6)).

Adding rounds compounds convergence; adding personas with the same evidence access burns tokens for the same blind spot.

## 3. Proposal — Three-Phase Asymmetric Pipeline

Replace the single planner call with three sequential phases, each with a distinct mandate and a different agent role. The phases compose via structured artifacts, not free-form prose.

```
┌─────────────────────────────┐
│ Phase 1: Grounding          │  → facts-manifest.json
│ Extract evidence only.      │
│ No proposing.               │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Phase 2: Drafting           │  → prd-draft.json (with citations)
│ Citation-required.          │
│ Every claim cites a fact.   │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Phase 3: Critic Audit       │  → critic-findings.json
│ Closed checklist.           │  → prd.json (revised) | spec-deltas.md
│ Asymmetric — not symmetric  │
│ debate.                     │
└─────────────────────────────┘
```

### Phase 1 — Grounding (extraction-only)

**Mandate:** produce a facts manifest. Do not propose stories. Do not interpret. Extract.

**Inputs:** spec content, repo file tree, file-read tool access.

**Output:** structured `facts-manifest.json`:

```jsonc
{
  "repoFacts": [
    {
      "id": "F-001",
      "kind": "file" | "symbol" | "schema" | "contract" | "convention",
      "evidence": "src/agents/manager.ts:42-89",
      "summary": "AgentManager.completeAs accepts (model, prompt, options)"
    }
  ],
  "specClaims": [
    {
      "id": "S-001",
      "specSpan": "lines 23-25 of spec",
      "claim": "extends existing User schema with email field",
      "kind": "factual" | "intent",      // factual = about repo state; intent = about future changes
      "verification": {
        "status": "verified" | "unverified" | "partial" | "contradicted",
        "evidence": "src/models/user.ts:8 — User has {id, name}; no email field",
        "factId": "F-014"                 // when verified, link to the supporting fact
      }
    }
  ],
  "gaps": [
    {
      "id": "G-001",
      "kind": "missing-context" | "ignored-convention" | "boundary-not-considered",
      "note": "spec ignores existing retry middleware in src/agents/retry/",
      "evidence": "src/agents/retry/default-strategy.ts"
    }
  ]
}
```

**Hallucination gate:** the grounder is forbidden from emitting claims without `evidence` paths. Output schema validation rejects facts without file references.

**Distinguishing intent from claim** — the spec contains both "we will add `validateFoo()`" (intent — don't verify, doesn't exist yet) and "the existing retry middleware handles transient errors" (factual — must verify). Cheapest signal: tense + existence verbs ("existing", "current", "already", past tense) → factual; future/imperative ("add", "create", "extend") → intent. Misclassification surfaces in Phase 3 as findings.

**Why this phase exists:** you can't hallucinate what you're forbidden from inventing. Separating extraction from proposing makes the rest of the pipeline operate on grounded inputs.

### Phase 2 — Drafting (citation-required)

**Mandate:** produce `prd.json` where every concrete claim cites a `factId` (or is explicitly marked as design intent).

**Inputs:** spec content, facts manifest from Phase 1, file-read access.

**Output:** PRD JSON conforming to existing `src/prd/schema.ts`, plus per-claim citation fields:

```jsonc
{
  "userStories": [
    {
      "id": "US-001",
      "description": "...",
      "acceptanceCriteria": [
        {
          "text": "When validateUser() rejects an empty email, returns ValidationError",
          "verifiedBy": {
            "kind": "test" | "symbol" | "file",
            "anchor": "test/unit/validate.test.ts::rejects empty email",
            "factIds": ["F-014", "S-001"]      // grounded in verified facts
          }
        }
      ],
      "contextFiles": [
        { "path": "src/models/user.ts", "factId": "F-012" }
      ]
    }
  ]
}
```

**Hallucination gate:** uncited concrete claims (file paths, function names, existing behaviors) are rejected mechanically — no LLM judgment required. Design-intent claims must be tagged `kind: "intent"` and don't require citation.

**This is the implementation-axis grounding** the recent adversarial review work added downstream ([commits 39a6a13a, a4d458bd](../../)) — pulled forward so review has anchors instead of intent statements.

### Phase 3 — Critic Audit (asymmetric, closed checklist)

**Mandate:** audit the draft against a fixed checklist. Not free-form debate; not symmetric agreement-seeking.

**Inputs:** facts manifest, PRD draft, file-read access.

**Output:** `critic-findings.json`:

```jsonc
{
  "findings": [
    {
      "id": "FIND-001",
      "severity": "blocker" | "major" | "minor",
      "checklistItem": "ac-testable",
      "storyId": "US-003",
      "issue": "AC 'handles errors gracefully' has no observable assertion",
      "suggestedFix": "rephrase as 'When agent throws X, run completes with status=failed'"
    }
  ],
  "checklistResults": {
    "spec-coverage": "pass",
    "ac-testable": "fail",
    "claims-cited": "pass",
    "files-exist": "pass",
    "failure-modes-considered": "partial",
    "contracts-respected": "pass"
  }
}
```

**Fixed checklist (closed set, no LLM creativity):**

| Item | Check |
|:---|:---|
| `spec-coverage` | Every spec AC appears in the PRD or in a documented gap |
| `ac-testable` | Each AC names an observable signal (file/symbol/test) |
| `claims-cited` | Every concrete claim has `factIds` or is tagged intent |
| `files-exist` | Every cited file path exists on disk (mechanical) |
| `failure-modes-considered` | Each story has at least one negative-path AC or documented "no failure modes" |
| `contracts-respected` | No PRD claim contradicts a `contradicted` `specClaim` from the manifest |

**Revision loop:** author addresses findings; critic re-checks only the deltas (one round, not arbitrary back-and-forth). Blocker-severity findings unresolved after one round emit `spec-deltas.md` and surface to the user — the spec needs a re-roll, not more planning.

**Why asymmetric beats symmetric debate:** the critic has a different mandate (audit) and a closed checklist (no convergence pressure). It cannot drift into agreement with the drafter — it isn't proposing alternatives, it's checking against rules. This is the structural fix for the convergence-on-wrong-answer trap.

## 4. Artifacts

| Artifact | Phase | Purpose | Persistence |
|:---|:---|:---|:---|
| `facts-manifest.json` | 1 | Grounded evidence inventory | Saved to `.nax/runs/<runId>/plan/` |
| `prd-draft.json` | 2 | Citation-bearing draft PRD | Intermediate, kept for audit |
| `critic-findings.json` | 3 | Audit results with severity | Saved alongside manifest |
| `prd.json` | 3 (post-revision) | Final PRD, schema-conformant | Replaces current `nax plan` output |
| `spec-deltas.md` | 3 (on blocker) | Spec→codebase contradictions for user re-roll | Surfaced to terminal |

`prd.json` retains the existing schema in `src/prd/schema.ts`. Citation metadata lives in additional fields the schema must accept (additive change, no breaking changes for downstream consumers).

## 5. Implementation Surface

The pipeline is plan-stage-only and does not modify the debate runner. However, **components are placed for reuse with the enhanced-debate proposal** if both progress, so the same code serves both paths.

### New code (shared with debate proposal)

| File | Purpose | Also used by |
|:---|:---|:---|
| `src/debate/facts-manifest.ts` | Manifest Zod schema + parser | Enhanced-debate `grounder` strategy |
| `src/prompts/builders/grounder-builder.ts` | Grounder prompts | Enhanced-debate `grounder` strategy |
| `src/debate/verifiers/plan-checklist.ts` | Closed checklist + mechanical checks | Enhanced-debate `postDebateVerifier` strategy |
| `src/plan/spec-deltas.ts` | `spec-deltas.md` artifact format | Enhanced-debate verifier output |

(File locations match the enhanced-debate proposal so neither path duplicates.)

### New code (pipeline-specific)

- `src/operations/plan-grounding.ts` — Phase 1 op (`CompleteOperation`) — wraps the grounder strategy in an op
- `src/operations/plan-draft.ts` — Phase 2 op (`RunOperation` with citation-validating `parse()`)
- `src/operations/plan-critic.ts` — Phase 3 op — wraps the verifier strategy in an op
- `src/prompts/builders/critic-builder.ts` — Phase 3 prompts (LLM-judgment portion)

### Changed code

- `src/cli/plan.ts` — orchestrate the three ops sequentially via `callOp` (Layer 4 per [adapter-wiring.md](../../.claude/rules/adapter-wiring.md))
- `src/prompts/builders/plan-builder.ts` — split current `build()` into draft-only variant; remove three-step prompt structure
- `src/prd/schema.ts` — additive: `verifiedBy`, `factIds`, `contextFiles[].factId` (same SSOT as enhanced-debate)

### Untouched

- `src/debate/` — debate stays available as a separate code path; pipeline is the new default for plan stage. Debate retained for review/acceptance/rectification stages where divergence is the point.
- Pipeline stages downstream of plan — they consume the same `prd.json` shape.

Per [adapter-wiring.md](../../.claude/rules/adapter-wiring.md): all three phases use `callOp` (Layer 4). No direct adapter calls.

### Relationship to debate plug-points

If both proposals ship, `src/debate/{pre-phase,verifiers}/` (introduced by enhanced-debate) becomes the canonical home for grounder + checklist; pipeline ops are thin wrappers around those strategies. The pipeline gets framework-level reuse without forking — the only difference is the orchestration shape (sequential ops vs. composable debate stage).

## 6. Tradeoffs

### Costs
- **~3× LLM cost** vs. current single-call plan (grounder + drafter + critic). Mitigated by grounder being structured-extraction-only (smaller output, can use a cheaper tier).
- **Higher latency** — strictly sequential phases. No parallelism to hide cost behind.
- **More artifacts to manage** — facts manifest + draft + findings + final PRD per run.

### Risks
- **Citation as ceremony.** Drafter could cite the same fact for unrelated claims, defeating grounding. *Mitigation:* critic checks citation distribution; high reuse on unrelated claims is a finding.
- **Grounder hallucination.** If the grounder fabricates evidence paths, downstream phases inherit the lie. *Mitigation:* mechanical file-existence check on every `evidence` field rejects non-existent paths at the schema layer.
- **Over-flagged findings.** Aggressive critic generates noise; drafter spends cycles addressing low-value items. *Mitigation:* severity tiers — only blockers force revision; majors and minors surface as advisory.
- **Loss of divergence.** Single drafter has one blind-spot profile; debate's multi-lens proposers genuinely surface different edge cases. *Mitigation:* if AC quality regresses in practice, add a parallel-proposer phase between Phase 1 and Phase 2 (becomes the hybrid shape) — the pipeline degrades gracefully into enhanced debate.

### What this does NOT solve
- **Cross-story consistency.** Each story is audited independently. PRDs that fragment a feature across stories with conflicting assumptions still pass. Future enhancement: cross-story consistency check as a fourth phase.
- **Spec ambiguity.** If the spec is genuinely ambiguous (not hallucinated, just unclear), the pipeline produces a confident PRD using one interpretation. Critic can flag ambiguity but cannot resolve it.

## 7. Comparison to Enhanced Debate Alternative

A separate proposal ([`2026-05-10-plan-enhanced-debate.md`](./2026-05-10-plan-enhanced-debate.md)) extends the existing shared `DebateRunner` via composable plug-points (`preDebatePhase`, `selector`, `postDebateVerifier`) — same grounder, same citation discipline, same mechanical verifier, but reached through the debate framework so semantic review and future debate stages compose from the same primitives. The two proposals **converge structurally** — enhanced debate with a grounder + verifier *is* an asymmetric pipeline with parallel proposers in the middle phase.

| Dimension | Pipeline | Enhanced Debate |
|:---|:---|:---|
| Hallucination floor | Lower (single drafter, fewer bias entry points) | Higher (synthesis resolver still merges with LLM judgment) |
| AC edge-case coverage | Lower (one drafter blind-spot profile) | Higher (multi-persona divergence) |
| Cost | ~3 calls | ~6+ calls (grounder + N proposers + N rebuttals + resolver + verifier) |
| Debuggability | High (clear phase boundaries) | Lower (failure can hide in synthesis) |
| Implementation surface | New subsystem | Extends tested debate code |

Pick the pipeline if hallucination dominates. Pick enhanced debate if AC completeness dominates and you trust debate's divergence value. Hybrid path exists in either direction.

## 8. Open Questions

1. **Grounder model tier.** Structured extraction is cheap — can we use `fast` tier? Trade-off: cheaper but more likely to miss subtle codebase contradictions.
2. **Critic agent identity.** Same agent as drafter (different prompt) or different agent? Cross-agent improves independence but doubles agent-resolution complexity.
3. **Manifest persistence.** Do downstream stages (TDD, review) consume the manifest, or is it plan-internal? If shared, it becomes a project-wide grounding artifact — higher value, more scope.
4. **Failure mode when critic finds blockers.** Block the run and emit `spec-deltas.md`, or proceed with the draft and tag affected stories `routing.complexity = "expert"`? First is safer; second is more lenient for ambiguous specs.
5. **Schema migration.** Additive citation fields on `src/prd/schema.ts` — backward-compatible for existing consumers, but new downstream code can rely on them. Do we gate on a config flag during rollout?

## 9. Next Steps

If accepted:
1. Spike Phase 1 (grounder) standalone — measure manifest quality on 3–5 representative specs.
2. Define the citation schema additions to `src/prd/schema.ts` and verify downstream consumers tolerate the additive fields.
3. Implement `plan-grounding.ts` op + builder + manifest schema.
4. Implement Phase 2 with citation validation in `parse()`.
5. Implement Phase 3 critic with mechanical checks first (file existence, citation presence), then LLM-judgment checks (testability).
6. Integration: `src/cli/plan.ts` orchestration; gate behind `config.plan.pipeline = "asymmetric" | "single" | "debate"`.
7. Measure: hallucination rate (manifest contradictions), AC quality (downstream test pass rate), cost delta vs. baseline.
