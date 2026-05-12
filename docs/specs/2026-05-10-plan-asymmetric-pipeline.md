# Plan Stage — Asymmetric Pipeline Proposal

**Date:** 2026-05-10 (revised 2026-05-12)
**Status:** Proposal — partially landed via enhanced-debate Phase 2; remaining work is rewiring, not new subsystems.
**Scope:** `nax plan` — replace single-session planning with a 3-phase asymmetric pipeline to eliminate spec→codebase hallucination and produce stronger acceptance criteria.

**Revision note (2026-05-12):** Enhanced-debate Phase 2 (branch `feat/enhanced-debate-phase-2`, merged) shipped all of the shared primitives this proposal anticipated — facts manifest, grounder strategy + prompts, citation parser, plan-checklist verifier, and `spec-deltas.md` artifact. Per [`docs/reports/enhanced-debate-phase-2-gap-analysis.md`](../reports/enhanced-debate-phase-2-gap-analysis.md) the grounder runs correctly end-to-end now, but in practice the manifest gets diluted by the N-debater synthesis resolver (the structural failure mode predicted in §2). The remaining pipeline work is orchestration: route the existing grounder + drafter + critic ops sequentially in `src/cli/plan.ts` instead of feeding them through the debate runner.

**Codebase reconciliation (2026-05-12):** A read of [`src/prd/schema.ts`](../../src/prd/schema.ts), [`src/prd/types.ts`](../../src/prd/types.ts), [`src/debate/verifiers/plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts), [`src/debate/citations.ts`](../../src/debate/citations.ts), and [`src/operations/ground.ts`](../../src/operations/ground.ts) surfaced several drifts between the original proposal text and the current code. Corrections are inlined throughout; the key drifts:

1. **`verifiedBy` is a story-level field, not per-AC.** `acceptanceCriteria` is `string[]`. The original §3 Phase 2 example showed per-AC structured objects with embedded `verifiedBy` — that shape would require breaking-schema changes. The on-disk shape is story-level only. Spec example below revised.
2. **Schema citation fields already exist.** `verifiedBy`, `intent`, and `contextFiles[].factId` (via `ContextFileEntry`) are already in the schema and flow through to disk via `validatePlanOutput`. The original §5 "MODIFY (additive)" entry on `src/prd/schema.ts` is removed.
3. **`plan-checklist.ts` checklist items differ.** Implemented: `files-exist`, `ac-anchored`, `claims-cited`, `no-contradictions`, `spec-coverage` (5 items). The proposal originally named `ac-testable`, `contracts-respected`, `failure-modes-considered`. The checklist table below now reflects reality.
4. **`claims-cited` measures the wrong thing for Phase 2.** The implemented check measures **manifest specClaim verification rate** (verified+partial / total), not **PRD claim citation rate**. `citations.ts` (`extractClaims`, `citationRate`) is the PRD-claim parser the proposal needs, but it is not currently invoked by the verifier. Wiring `citations.ts` into the Phase 2 drafter's `parse()` is a real new piece of work.
5. **`plan-checklist.ts` is `PostDebateVerifier`-shaped, not op-shaped.** It reads `selectorResult.output` and a debate `stageConfig`. Pipeline reuse requires extracting the pure check functions (`checkFilesExist`, `checkAcAnchored`, etc.) into a library module called from both paths — not a "thin wrapper."
6. **Manifest path is per-story:** `.nax/runs/<runId>/plan/<storyId>/facts-manifest.json` (not `…/plan/facts-manifest.json` as originally stated).
7. **`groundOp` is bound to `debateConfigSelector`.** It reads `config.debate.grounder.{model, timeoutSeconds}`. Pipeline mode inherits this — even with `plan.mode = "pipeline"` and `debate.enabled = false`, the grounder still resolves its tuning knobs from the `debate.grounder` slice. Acceptable and documented below; do not duplicate the keys under `config.plan`.

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

**Output:** PRD JSON conforming to existing `src/prd/schema.ts` — citation metadata lives at the **story level** (the schema does not support per-AC structured objects; `acceptanceCriteria` is `string[]`):

```jsonc
{
  "userStories": [
    {
      "id": "US-001",
      "description": "...",
      "acceptanceCriteria": [
        "When validateUser() rejects an empty email, returns ValidationError"
      ],
      "verifiedBy": {
        "kind": "test",                            // "test" | "symbol" | "file"
        "anchor": "test/unit/validate.test.ts::rejects empty email",
        "factIds": ["F-014", "S-001"]              // grounded in verified facts
      },
      "intent": false,                             // true → no citation required (design intent)
      "contextFiles": [
        { "path": "src/models/user.ts", "factId": "F-012" }
      ]
    }
  ]
}
```

Anchoring is per-story rather than per-AC. The trade-off: weaker AC-level granularity (one anchor covers all ACs in a story) in exchange for staying within the existing schema. If per-AC anchoring proves necessary in practice, that requires a separate schema migration RFC — out of scope here.

**Hallucination gate (two layers):**
- **Schema-level (already enforced):** [`validatePlanOutput`](../../src/prd/schema.ts) rejects `verifiedBy.kind` outside the `"test" | "symbol" | "file"` set; `contextFiles` paths must be relative and free of `..`; story IDs are normalized.
- **Citation-level (new in pipeline mode):** the Phase 2 op's `parse()` runs [`extractClaims`](../../src/debate/citations.ts) + [`citationRate`](../../src/debate/citations.ts) over the drafter's structured output and rejects when the rate falls below a configurable threshold. Stories with `intent: true` are exempt. **This wiring does not exist today** — `citations.ts` ships, but it is not invoked anywhere in the verifier path; pipeline mode is the first consumer.

**This is the implementation-axis grounding** the recent adversarial review work added downstream ([commits 39a6a13a, a4d458bd](../../)) — pulled forward so review has anchors instead of intent statements.

### Phase 3 — Critic Audit (asymmetric, closed checklist)

**Mandate:** audit the draft against a fixed checklist. Not free-form debate; not symmetric agreement-seeking.

**Inputs:** facts manifest, PRD draft, file-read access.

**Output:** `critic-findings.json`. The shape mirrors [`VerifierFinding`](../../src/plan/spec-deltas.ts) already used by `plan-checklist.ts`:

```jsonc
{
  "findings": [
    {
      "checklistItem": "ac-anchored",
      "severity": "blocker" | "major",
      "message": "Story US-003 has no verifiedBy anchor and intent is not true",
      "storyId": "US-003"
    }
  ]
}
```

**Fixed checklist (closed set, no LLM creativity) — matches [`src/debate/verifiers/plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts):**

| Item | Severity | Check | Source |
|:---|:---|:---|:---|
| `files-exist` | blocker | Every `contextFiles[].path` exists on disk | `checkFilesExist` |
| `ac-anchored` | major | Each story has `verifiedBy` OR `intent === true` | `checkAcAnchored` |
| `claims-cited` | major | Manifest verification rate ≥ threshold (default 0.5) | `checkClaimsCited` |
| `no-contradictions` | blocker | No `contextFiles[].factId` references a `contradicted` spec claim | `checkNoContradictions` |
| `spec-coverage` | major | No unverified factual spec claims; no unresolved gaps | `checkSpecCoverage` |

**Two gaps from the original §3 proposal that the implementation does NOT cover:**

| Original proposal | Status |
|:---|:---|
| `ac-testable` — each AC names an observable signal | Partially covered by `ac-anchored` (story-level). True AC-level testability check would require LLM judgment — see `critic-builder.ts` work item below |
| `failure-modes-considered` — negative-path AC per story | Not implemented. Add either as a sixth mechanical check (heuristic: AC string contains negative keywords) or as part of the LLM testability judgment |

**Phase 2 claim-citation check (NEW work, not in `plan-checklist.ts`):** measure PRD-claim citation rate via [`citations.ts`](../../src/debate/citations.ts) on the drafter's structured output. This is distinct from `claims-cited` (which measures the manifest, not the draft) and is the actual hallucination gate.

**Revision loop:** author addresses findings; critic re-checks only the deltas (one round, not arbitrary back-and-forth). Blocker-severity findings unresolved after one round emit `spec-deltas.md` and surface to the user — the spec needs a re-roll, not more planning. `plan-checklist.ts` already supports `onBlocker: "block" | "tag-expert"`; pipeline mode reuses that knob.

**Revision loop:** author addresses findings; critic re-checks only the deltas (one round, not arbitrary back-and-forth). Blocker-severity findings unresolved after one round emit `spec-deltas.md` and surface to the user — the spec needs a re-roll, not more planning.

**Why asymmetric beats symmetric debate:** the critic has a different mandate (audit) and a closed checklist (no convergence pressure). It cannot drift into agreement with the drafter — it isn't proposing alternatives, it's checking against rules. This is the structural fix for the convergence-on-wrong-answer trap.

## 4. Artifacts

All run-scoped artifacts live under `.nax/runs/<runId>/plan/<storyId>/` (per-story subdirectory — matches the path `plan-checklist.ts` already reads from).

| Artifact | Phase | Purpose | Path |
|:---|:---|:---|:---|
| `facts-manifest.json` | 1 | Grounded evidence inventory | `.nax/runs/<runId>/plan/<storyId>/facts-manifest.json` |
| `prd-draft.json` | 2 | Citation-bearing draft PRD | `.nax/runs/<runId>/plan/<storyId>/prd-draft.json` |
| `critic-findings.json` | 3 | Audit results with severity | `.nax/runs/<runId>/plan/<storyId>/critic-findings.json` |
| `prd.json` | 3 (post-revision) | Final PRD, schema-conformant | `.nax/features/<feature>/prd.json` (existing location) |
| `spec-deltas.md` | 3 (on blocker) | Spec→codebase contradictions for user re-roll | `.nax/runs/<runId>/plan/<storyId>/spec-deltas.md` (already emitted here) |

`prd.json` uses the existing schema in [`src/prd/schema.ts`](../../src/prd/schema.ts) — `verifiedBy`, `intent`, `contextFiles[].factId` are all already accepted. No schema migration required.

## 5. Implementation Surface

The pipeline is plan-stage-only and does not modify the debate runner. Enhanced-debate Phase 2 has already landed all of the shared primitives; the remaining work is a new drafter op and the orchestration wiring.

### Already shipped (enhanced-debate Phase 2 — reusable)

| File | Status | Role in pipeline | Notes |
|:---|:---|:---|:---|
| [`src/debate/facts-manifest.ts`](../../src/debate/facts-manifest.ts) | DONE | Phase 1 output schema + parser | — |
| [`src/debate/pre-phase/grounder.ts`](../../src/debate/pre-phase/grounder.ts) | DONE | Phase 1 strategy | — |
| [`src/prompts/builders/grounder-builder.ts`](../../src/prompts/builders/grounder-builder.ts) | DONE | Phase 1 prompts | — |
| [`src/operations/ground.ts`](../../src/operations/ground.ts) | DONE | Phase 1 `callOp`-shaped op | Uses `debateConfigSelector`; tuning lives at `config.debate.grounder.*` even in pipeline mode |
| [`src/debate/citations.ts`](../../src/debate/citations.ts) | DONE (UNWIRED) | Phase 2 PRD-claim citation parser | `extractClaims` / `citationRate` exist but no caller — pipeline drafter is the first consumer |
| [`src/debate/verifiers/plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts) | DONE (DEBATE-SHAPED) | Phase 3 mechanical checks | Signature is `PostDebateVerifier(ctx)` reading `selectorResult.output` + `stageConfig`. Needs refactor to expose pure check functions |
| [`src/plan/spec-deltas.ts`](../../src/plan/spec-deltas.ts) | DONE | Phase 3 artifact emitter | — |
| [`src/prd/schema.ts`](../../src/prd/schema.ts) + [`src/prd/types.ts`](../../src/prd/types.ts) | DONE | Citation fields | `verifiedBy`, `intent`, `contextFiles[].factId` already accepted by `validatePlanOutput`. No schema work required. |
| [`src/runtime/session-role.ts`](../../src/runtime/session-role.ts) | DONE | `"grounder"` already a canonical session role | — |

### Remaining work (pipeline-specific)

| File | Status | Purpose |
|:---|:---|:---|
| `src/debate/verifiers/checks.ts` *(or `src/plan/checks.ts`)* | NEW | Refactor — extract the five pure check functions (`checkFilesExist`, `checkAcAnchored`, `checkClaimsCited`, `checkNoContradictions`, `checkSpecCoverage`) out of [`plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts) into a library. `plan-checklist.ts` becomes a `PostDebateVerifier` adapter that calls them; pipeline op calls them directly. No semantic change |
| `src/operations/plan-draft.ts` | NEW | Phase 2 op — `RunOperation` whose `parse()` runs `validatePlanOutput` then `citationRate(extractClaims(output)) >= threshold`. Must declare `retry` + `exhaustedFallback` (or `recover`) per [retry-strategy.md](../../.claude/rules/retry-strategy.md) so a low citation rate triggers a retry-with-prompt rather than throwing |
| `src/operations/plan-critic.ts` | NEW | Phase 3 op — invokes the extracted check functions on the validated draft, threads `manifest` from disk, applies revision loop (one round; blocker → emit `spec-deltas.md` and surface). Does NOT need an LLM call for the mechanical portion |
| `src/prompts/builders/critic-builder.ts` | NEW | Phase 3 LLM-judgment prompts — **closes the two gaps from §3**: (a) per-AC testability (currently covered only at story level by `ac-anchored`); (b) failure-modes-considered. Called from `plan-critic.ts` after mechanical checks pass |
| `src/prompts/builders/plan-builder.ts` | MODIFY | Split current `build()` into a draft-only variant that consumes the manifest text (via `renderManifestSection`) and the spec; drop the three-step prompt structure |
| `src/cli/plan.ts` | MODIFY | Add a third branch (after the existing debate / single branches) that calls `groundOp → planDraftOp → planCriticOp` sequentially via `callOp`. Reuse `createPlanRuntime` so packages/agentManager/sessionManager match the debate path |
| `src/config/schemas.ts` | MODIFY (additive) | Add `config.plan.mode = "single" | "debate" | "pipeline"` (see §5a) |

### Untouched

- `src/debate/` — debate stays as-is. `evidenceMode: "asymmetric"` keeps working for users who want the debate-shaped path. Pipeline is a parallel, simpler shape that bypasses the synthesis resolver.
- Downstream pipeline stages (TDD, review, acceptance) — they consume the same `prd.json` shape; citation fields are additive.

Per [adapter-wiring.md](../../.claude/rules/adapter-wiring.md): all three phases use `callOp` (Layer 4). Phase 1 already does; Phases 2 and 3 will. No direct adapter calls.

### Relationship to debate plug-points

`src/debate/{pre-phase,verifiers}/` is now the canonical home for grounder + checklist. The pipeline ops are thin wrappers around those strategies — no forking, no duplication. The only difference between debate-asymmetric and pipeline modes is the orchestration shape: debate-asymmetric routes the manifest into N parallel proposers + synthesis resolver; pipeline routes it into one drafter + one critic.

## 5a. Config Resolution

Enhanced-debate Phase 2 already added two relevant keys; pipeline mode must compose with them, not duplicate them. The current shape (see [`src/config/schemas-debate.ts`](../../src/config/schemas-debate.ts)):

```jsonc
{
  "debate": {
    "enabled": false,                       // master switch for the debate runner
    "stages": {
      "plan": {
        "enabled": true,                    // gates debate for the plan stage (only fires if master is on)
        "evidenceMode": "current" | "asymmetric"   // in-debate composition: adds grounder + verifier-pick selector
      }
    }
  }
}
```

And in [`src/cli/plan.ts`](../../src/cli/plan.ts) the existing branch is:

```typescript
const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;
if (debateEnabled) { /* debate runner */ } else { /* single planInteractiveOp */ }
```

Pipeline mode is a **third orchestration shape**, not a debate variant. Pick the SSOT key cleanly:

### Recommended: new `config.plan.mode` SSOT

Introduce a single, explicit selector on `config.plan` rather than overloading `evidenceMode` (which already has a well-defined meaning inside the debate runner):

```jsonc
{
  "plan": {
    "mode": "single" | "debate" | "pipeline"   // default: derived (see resolution order below)
  }
}
```

**Resolution order** (in `cli/plan.ts`, replaces the current `debateEnabled` line):

1. If `config.plan.mode` is set explicitly → use it.
2. Else if `config.debate.enabled && config.debate.stages.plan.enabled` → `"debate"` (preserves current behavior — no behavior change for existing users).
3. Else → `"single"`.

This keeps the three settings orthogonal:

| User intent | Set |
|:---|:---|
| Keep today's single-call planner | nothing (default) |
| Run debate, current evidence | `debate.enabled = true` (already works) |
| Run debate with grounder + verifier composition | `debate.enabled = true` + `debate.stages.plan.evidenceMode = "asymmetric"` (already works) |
| **Run the asymmetric pipeline (no debate)** | `plan.mode = "pipeline"` |

### Why not extend `evidenceMode` to `"pipeline"`?

`evidenceMode` lives under `debate.stages.plan` — semantically "how the debate runner composes itself for the plan stage." Adding `"pipeline"` there means "evidence mode = no debate at all," which is contradictory and forces every reader of the debate schema to know about a non-debate code path. Keep debate config debate-only; introduce a plan-stage selector at `config.plan` where it belongs.

### Interaction with `debate.stages.plan.enabled`

When `plan.mode = "pipeline"`:
- The pipeline runs regardless of `debate.stages.plan.enabled` (it bypasses the debate runner entirely).
- Emit a one-time warning at plan startup if both `plan.mode = "pipeline"` and `debate.enabled = true` — the user has likely configured both paths by accident; pipeline wins. This is the "explicit beats inherited" rule from [`config-patterns.md`](../../.claude/rules/config-patterns.md).
- No legacy-key rejection needed (per [`config-patterns.md`](../../.claude/rules/config-patterns.md) §"Migrating Deprecated Keys"): this is an additive change, not a rename. Existing users see zero behavior change.

### Schema additions

Append to `NaxConfigSchema` (in `src/config/schemas.ts`, not `schemas-debate.ts` — pipeline is not debate):

```typescript
plan: z.preprocess(toObject, z.object({
  // existing keys (timeoutSeconds, etc.)
  mode: z.enum(["single", "debate", "pipeline"]).optional(),
}))
```

`.optional()` not `.default("single")` — the resolution order above derives the default at runtime from existing debate keys for backward compatibility.

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

Phase 1 (grounder + manifest), the citation parser, the mechanical checklist, and the PRD schema's citation fields are all already in main. The PRD schema needs **no migration**. Remaining work, in order:

1. **Add `config.plan.mode`** to `src/config/schemas.ts` + the resolution order in `src/cli/plan.ts` (see §5a). Land this commit alone so subsequent work is gated behind the flag with no behavior change for existing users.
2. **Refactor `plan-checklist.ts`** — extract the five pure check functions into a library (e.g. `src/debate/verifiers/checks.ts`). The current `planChecklistVerifier` becomes a thin `PostDebateVerifier` adapter that calls the library. Pure functions are unit-testable in isolation and callable from the pipeline op. No semantic change to the debate path.
3. **Wire `citations.ts` into a draft validator** — write a `validateDraftCitations(output, threshold)` helper that runs `extractClaims` + `citationRate` and returns a structured pass/fail. This is the new hallucination gate the original §3 described but never landed.
4. **Implement `src/operations/plan-draft.ts`** — `RunOperation<{manifest, spec, codebase}, PRD, DebateConfig>` whose `parse()` runs `validatePlanOutput` then `validateDraftCitations`. Declare `retry` + `exhaustedFallback` per [retry-strategy.md](../../.claude/rules/retry-strategy.md). Session role: reuse `"plan"` from the canonical registry.
5. **Implement `src/operations/plan-critic.ts`** — calls the extracted check functions directly (no `PostDebateVerifier` shim needed in pipeline mode). Implements the one-round revision loop. Blocker findings unresolved after one revision emit `spec-deltas.md` (via `formatSpecDeltas`) and abort.
6. **Add `src/prompts/builders/critic-builder.ts`** — LLM-judgment prompts for per-AC testability + failure-modes coverage. These are the two checks the mechanical checklist explicitly does NOT cover (see §3 gap table).
7. **Split `src/prompts/builders/plan-builder.ts`** — extract a draft-only variant that consumes `renderManifestSection(manifest)` instead of the raw codebase scan.
8. **Rewire `src/cli/plan.ts`** — third branch: `groundOp → planDraftOp → planCriticOp`, all via `callOp`. Reuse `createPlanRuntime` so packages/agentManager/sessionManager match the debate path. Manifest path follows the per-story layout `plan-checklist.ts` already uses.
9. **Measure** — on 3–5 representative specs, compare across modes (`single`, `debate`, `debate+asymmetric`, `pipeline`):
   - Hallucination rate: count `contradicted` specClaims in the manifest that survive into final PRD's `contextFiles[].factId`.
   - PRD-claim citation rate: from `citationRate(extractClaims(prd))`.
   - AC quality: downstream test pass rate on PRDs run through TDD.
   - Cost delta: tokens + wall-clock vs. baseline.

Out of scope for this proposal (parking lot): cross-story consistency phase, manifest reuse by downstream stages (TDD/review consuming the same facts manifest), hybrid mode with parallel proposers between Phase 1 and Phase 2, per-AC structured `verifiedBy` (would require schema migration).
