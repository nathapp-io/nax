# Plan Stage — Enhanced Debate Proposal

**Date:** 2026-05-10
**Status:** Proposal — codebase-grounded
**Scope:** `nax plan` debate mode — extend the shared `DebateRunner` framework with evidence-asymmetric grounding, citation discipline, verifier-pick selector, and a mechanical post-verifier to eliminate spec→codebase hallucination while preserving multi-agent divergence for AC quality.

**Companion to:** [`2026-05-10-plan-asymmetric-pipeline.md`](./2026-05-10-plan-asymmetric-pipeline.md) (alternative approach)

**Implementation specs:** [`SPEC-enhanced-debate-phase-1.md`](./SPEC-enhanced-debate-phase-1.md) (foundation + manifest), [`SPEC-enhanced-debate-phase-2.md`](./SPEC-enhanced-debate-phase-2.md) (plan composition).

---

## 0. Codebase Grounding Findings

This section captures findings from grounding the proposal against the actual code (post-design audit). It supersedes earlier risk estimates where they conflict.

### Findings that DE-RISK the proposal

1. **`completeAs` supports tool use including file-read in ACP** (confirmed). No architectural change needed for Enhancement 2 (file-read in proposers). Proposers stay as `callOp(debateProposeOp, ...)` and gain tool access via the existing `completeAs` path. Drops "file-read" from HIGH risk to LOW.
2. **`DebateRunner` is already shared as a class** ([runner.ts:40](../../src/debate/runner.ts#L40)) consumed by 4 production call sites: `src/review/semantic-debate.ts`, `src/review/semantic.ts`, `src/cli/plan.ts`, `src/cli/plan-decompose.ts`. Single-runner architecture is real, not aspirational.
3. **Operation pattern is established.** [`debateProposeOp`](../../src/operations/debate-propose.ts) and [`debateRebutOp`](../../src/operations/debate-rebut.ts) are existing `CompleteOperation`s using `callOp`. `groundOp` follows the same template — ~60 lines of new code.
4. **Plan default already uses `sessionMode: "stateful"`** ([schemas-debate.ts:61](../../src/config/schemas-debate.ts#L61)). The "default stateful" recommendation is already partly there.
5. **`DebateConfigSchema` is small (89 lines) and clean.** Adding optional plug-point fields is a ~20-line edit, isolated.
6. **Existing patterns and rules are accommodating** — `_deps` injection, `callOp` Layer 4, structured logging with `storyId`, Bun-native APIs. Nothing in the proposal requires breaking conventions.

### Findings that ADD risk or scope

1. **Plan debate is a separate dispatch path from main debate.** `DebateRunner.runPlan()` ([runner.ts:88-101](../../src/debate/runner.ts#L88)) calls into a 273-line standalone `runner-plan.ts` — it does NOT share the dispatch flow used by `run()` → `runPanelOneShot/runStateful/runHybrid`. **Plug-point dispatch must be wired in both places.** This was undercounted in earlier sections; the implementation surface in §6 is updated to reflect this.
2. **`semantic-debate.ts` is 356 lines** with non-trivial `getVerdict()` integration logic (sessionUsed detection, tool-verified verdict path, fallback). Extracting into a `dialogue-verdict` selector strategy is a careful refactor, not a one-line move.
3. **`ReviewerSession` is 537 lines** ([review/dialogue.ts](../../src/review/dialogue.ts)). The dialogue-verdict strategy needs to plumb `reviewerSession` through `SelectorContext` cleanly without leaking the abstraction.
4. **Citation parsing reliability is unknown until measured.** The codebase has `parseLLMJson` SSOT for the same problem class, but agent output format consistency varies. Build the parser using `parseLLMJson` + regex fallback; budget 1–2 iterations for tuning against real outputs.
5. **15 debate test files + 5 review integration tests** must stay green through the Phase 1 refactor. This is the primary safety net for behavior preservation.

### Adjusted risk tiers (post-grounding)

| Item | Original | Revised | Why |
|:---|:---|:---|:---|
| File-read in proposers | HIGH | **LOW** | `completeAs` supports tools in ACP |
| `runner-plan.ts` dispatch wiring | MED | **MED** (unchanged but acknowledged) | Two dispatch paths, not one |
| `semantic-debate.ts` extraction | MED | **MED** (unchanged) | 356 lines, careful refactor |
| Citation parsing reliability | HIGH | **MED** | Codebase has `parseLLMJson` SSOT to lean on |
| Grounder accuracy | HIGH | **MED** | Iterate on prompt within Phase 2 implementation; behavior gated by `evidenceMode` flag |
| Big-bang shipping | HIGH | **LOW** | `evidenceMode` flag enables ship-and-measure |

**Net:** zero HIGH-risk items remain. The proposal is implementable without spike gates given the `evidenceMode` flag as safety net (see §11 Phasing).

---

## 1. Problem

Same as the pipeline proposal — see [`2026-05-10-plan-asymmetric-pipeline.md` §1](./2026-05-10-plan-asymmetric-pipeline.md#1-problem). Briefly:

1. **Spec→codebase drift** — specs authored upstream confidently assert files/APIs/schemas that don't exist; current plan stage transcribes them.
2. **Weak acceptance criteria** — ACs produced without separate audit.

This proposal addresses both while keeping the current debate runner as the divergence engine.

## 2. Why Current Debate Falls Short

The existing debate runner ([src/debate/runner-plan.ts](../../src/debate/runner-plan.ts)) and persona system ([src/debate/personas.ts](../../src/debate/personas.ts)) have three structural gaps:

### Gap 1 — Personas are opinion-asymmetric, evidence-symmetric

All five personas (challenger / pragmatist / completionist / security / testability) consume identical input: spec text + filename list. They diverge on **lens**, not on **facts**. When the spec is wrong, all five agree on the same hallucination — different opinions about a shared lie.

The personas.ts file itself acknowledges this: *"Without personas, same-model debaters produce near-identical outputs with 90%+ overlap."* Personas reduce overlap but don't eliminate the shared-blindness problem.

### Gap 2 — No file content reaches debaters

The plan prompt builder ([src/prompts/builders/plan-builder.ts:125](../../src/prompts/builders/plan-builder.ts#L125)) explicitly says:

> The codebase context below contains file names and structure only — no file content. Do NOT assert specific line numbers.

Debaters cannot verify spec claims against actual code. They argue about a spec they all take at face value.

### Gap 3 — Synthesis launders agreement into confidence

The synthesis resolver ([src/debate/runner-plan.ts:234](../../src/debate/runner-plan.ts#L234)) merges N proposals + spec into one PRD. When all N agreed on a hallucination, the resolver inherits the agreement and produces a confident output. The `SPEC_ANCHOR_RULES` synthesis suffix ([runner-plan.ts:231](../../src/debate/runner-plan.ts#L231)) protects against plan→spec drift but treats the spec as authoritative — same blind spot as the single-call mode.

**Diagnosis:** debate isn't broken because debate is wrong. It's broken because **all debaters have symmetric access to unverified information**, and no mechanical check sits between synthesis and downstream consumers.

## 3. Architectural Constraint — Single Shared Runner, Composable Plug-Points

**`DebateRunner` must remain a single SSOT consumed by every stage.** Plan, semantic review, and future debate stages (acceptance, rectification) differ in *config*, not in *code path*. The mechanics introduced below are exposed as opt-in plug-points on `DebateStageConfig` so any stage can compose them.

This is non-negotiable for two reasons:

1. **Semantic review already shares the runner today** ([semantic-debate.ts:97-105](../../src/review/semantic-debate.ts#L97) force-narrows config but uses the same `DebateRunner`). Forking into plan-specific and review-specific runners would regress the existing architecture.
2. **Future debate stages get the framework for free** instead of forking again. When acceptance/rectification debate ships, it composes from the same plug-points.

### Plug-points added to `DebateStageConfig`

```typescript
interface DebateStageConfig {
  // ... existing fields unchanged

  // New: optional extension points (all default off — backward compatible)
  preDebatePhase?: {
    kind: "grounder" | "custom";
    builder?: PrePhaseBuilder;            // produces a manifest threaded into proposer prompts
  };

  proposers?: {
    citationsRequired?: boolean;          // gate uncited concrete claims at parse time
    fileReadAccess?: boolean;             // gate "no file content" instruction in prompt
  };

  selector?:
    | { kind: "synthesis" }
    | { kind: "verifier-pick"; patch?: { enabled: boolean; overlapThreshold?: number; maxDeltas?: number } }
    | { kind: "dialogue-verdict" };
  // default = { kind: "synthesis" } (current behavior)
  // semantic uses { kind: "dialogue-verdict" } (wraps existing getVerdict() path)
  // plan uses { kind: "verifier-pick", patch: { enabled: true } }

  postDebateVerifier?: {
    kind: "plan-checklist" | "review-grounding-filter" | "custom";
    runner?: VerifierFn;
  };
}
```

`DebateRunner` learns to:

1. If `preDebatePhase` is set → run it serially, thread output into proposer prompts
2. If `proposers.citationsRequired` → enforce at proposal parse time
3. Use `selector` to decide synthesis vs. verifier-pick vs. dialogue-verdict
4. If `postDebateVerifier` is set → run it after selection

### How each stage composes

**Plan composes** (this proposal):
```typescript
{
  preDebatePhase: { kind: "grounder" },
  proposers: { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
  sessionMode: "stateful",
  selector: { kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 } },
  postDebateVerifier: { kind: "plan-checklist" },
}
```

**Semantic composes** (preserves current behavior, expressed in new vocabulary — no behavior change):
```typescript
{
  // no preDebatePhase — ReviewerSession does grounding inline via tool calls
  proposers: { citationsRequired: true },        // already true via verifiedBy.observed
  sessionMode: "one-shot",                        // existing force-override
  mode: "panel",                                  // existing force-override
  selector: { kind: "dialogue-verdict" },         // wraps existing getVerdict() path
  postDebateVerifier: { kind: "review-grounding-filter" },
                                                  // wraps filterByAcGroundingMinimal +
                                                  // sanitizeRefModeFindings + isBlockingSeverity
}
```

**Future acceptance/rectification debate** composes whatever it needs — no fork required.

### What this means for the existing semantic code

- The force-override at [`semantic-debate.ts:97-105`](../../src/review/semantic-debate.ts#L97) becomes a *config build step* rather than a runtime override.
- `ReviewerSession.getVerdict()` becomes the implementation of the `"dialogue-verdict"` selector — same code, registered as a strategy.
- `filterByAcGroundingMinimal` + `sanitizeRefModeFindings` + `isBlockingSeverity` become the implementation of the `"review-grounding-filter"` verifier — same code, registered as a strategy.

**No semantic behavior change.** Existing logic is exposed through named plug-points instead of hardcoded in `semantic-debate.ts`.

### Strategy registration mechanism

Each plug-point category has a **static built-in registry** in its module — closed set, simple, easy to test:

```typescript
// src/debate/pre-phase/registry.ts
const STRATEGIES: Record<PreDebatePhaseKind, PreDebatePhase> = {
  grounder: grounderStrategy,
  custom: customStrategy,         // accepts user-supplied builder
};
export function resolvePreDebatePhase(config: PreDebatePhaseConfig): PreDebatePhase { ... }
```

Same pattern for `selectors/registry.ts` and `verifiers/registry.ts`. **Not** wired into the existing `IPlugin` system in `src/plugins/` — this is internal framework structure, not a user-extension surface. If a future need emerges to let plugins register strategies, the registry indirection makes that a one-method add (`register(kind, strategy)`).

### `evidenceMode` preset macro

Composing plug-points field-by-field is verbose for the common case. `config.debate.stages.plan.evidenceMode` is a **preset macro** that expands to a complete composition:

```typescript
type EvidenceMode = "current" | "asymmetric";

// "current"     → no plug-points set; today's debate behavior
// "asymmetric"  → expands to the plan composition shown above
```

Users who want fine-grained control can override individual plug-point fields after the macro expands; explicit fields take precedence. This keeps the simple case ergonomic and the advanced case possible.

### Migration for existing user configs

Existing user configs (`debaters: [...]`, custom personas, `rounds`, `mode: "hybrid"`) **continue to work unchanged**. All plug-point fields are additive-optional and default off. `evidenceMode` defaults to `"current"`. No user action required to retain today's behavior.

## 4. Proposal — Six Targeted Enhancements

Each enhancement is implemented as a plug-point per §3 (not as plan-only code) and as a *capability available to any composition*. Plan opts into a specific subset; semantic opts into a different subset; future stages opt into whatever they need. Ordered by leverage for plan; semantic uses Enhancements 3 + 5 (already present in spirit, formalized).

```
Current debate (default; what semantic uses today):
  spec + filenames ──> [N proposers] ──> rebuttals ──> synthesis ──> prd.json

Plan composition (this proposal; selector="verifier-pick", no rebuttals, no synthesis):
  spec ──> [grounder] ──> facts-manifest.json
                              │
                              ▼
  spec + manifest + file-read ──> [N proposers, parallel, stateful, citation-gated]
                                                  │
                                                  ▼
                              [verifier scores each proposal mechanically]
                                                  │
                              ┌───────────────────┴────────────────────┐
                              │                                        │
                proposals agree (AC overlap > θ)         proposals diverge
                              │                                        │
                              ▼                                        ▼
                      pick highest score        [patch: winner integrates top deltas in open session]
                              │                                        │
                              └───────────────────┬────────────────────┘
                                                  ▼
                                  [post-debate verifier checklist] ──> prd.json
                                                                       spec-deltas.md (if blockers)

Semantic composition (no behavior change; plug-points formalize existing logic):
  diff + reviewerSession ──> [N proposers, panel, one-shot, citation-encouraged]
                                                  │
                                                  ▼
                                  [dialogue-verdict via getVerdict()]
                                                  │
                                                  ▼
                          [review-grounding-filter via existing filterByAcGroundingMinimal etc]
```

The two flows share the **same `DebateRunner`** — they differ only in which plug-point strategies the stage's `DebateStageConfig` selects.

### Enhancement 1 — Add a `grounder` persona that runs before the proposer panel

**Different mandate, not a new lens.** The grounder doesn't propose a PRD. It runs serially before the parallel proposers and produces a structured facts manifest by reading the actual codebase.

**Output schema** (same as pipeline proposal — single SSOT):

```jsonc
{
  "repoFacts":   [{ "id": "F-001", "kind": "file"|"symbol"|"schema"|"contract"|"convention",
                    "evidence": "src/x.ts:42-89", "summary": "..." }],
  "specClaims":  [{ "id": "S-001", "specSpan": "lines 23-25", "claim": "...",
                    "kind": "factual"|"intent",
                    "verification": { "status": "verified"|"unverified"|"partial"|"contradicted",
                                      "evidence": "...", "factId": "F-014" } }],
  "gaps":        [{ "id": "G-001", "kind": "missing-context"|"ignored-convention"|"boundary-not-considered",
                    "note": "...", "evidence": "..." }]
}
```

**Wire-up (as a plug-point, not plan-only code):**
- New `src/debate/pre-phase/` directory — defines the `PreDebatePhase` contract and registers built-in strategies (`grounder`, `custom`) via static registry.
- New `src/operations/ground.ts` — `groundOp: CompleteOperation<GrounderInput, FactsManifest, GrounderConfig>`. The grounder is a single-agent structured-output call → textbook `CompleteOperation`, invoked via `callOp` (Layer 4 per [adapter-wiring.md](../../.claude/rules/adapter-wiring.md) Rule 1). **Not** `agentManager.runAsSession` — Layer 3 is reserved for parallel fan-out / dynamic agent names.
- New `src/debate/pre-phase/grounder.ts` — strategy implementation. Wraps `callOp(ctx, groundOp, input)`; handles failure-mode policy (see §8 Failure Modes).
- `src/debate/runner.ts` — at the dispatch entry point, if `stageConfig.preDebatePhase` is set, dispatch to the registered strategy via `resolvePreDebatePhase()` and inject its output into every proposer prompt via the existing `taskContext` parameter. Any stage can opt in — this is a generic mechanism.
- `src/prompts/builders/plan-builder.ts` — add a `manifest` section to `taskContext` when one is provided. The injection point is generic; any pre-phase output flows through it.
- New `src/debate/facts-manifest.ts` — Zod schema + parser; rejects facts without file references at parse time.
- **Do NOT add `grounder` to `personas.ts`** — keep it out of the `DebaterPersona` union to prevent it leaking into `REVIEW_ROTATION` or `PLAN_ROTATION`. It's a pre-phase role, not a debater persona.

**Semantic stays unchanged** — its config doesn't set `preDebatePhase` because `ReviewerSession` already does codebase grounding inline via tool calls.

**This is the one change that fixes spec hallucination at root.** Every downstream debater now sees the spec **annotated** with what's verifiable, what's contradicted, and what the spec ignored.

### Enhancement 2 — Give proposer debaters file-read access

Today's "no file content" constraint in [plan-builder.ts:125](../../src/prompts/builders/plan-builder.ts#L125) forces debaters to trust the spec textually. ACP and CLI agents have file-read tools available; let proposer rounds use them.

**Wire-up (as a plug-point):**
- `proposers.fileReadAccess` flag in `DebateStageConfig`. When true, `DebateRunner` selects the file-read variant of the proposer prompt builder.
- `src/prompts/builders/plan-builder.ts` — split the current "no file content" instruction into a conditional block gated by the flag.
- Update `DESCRIPTION_QUALITY_RULES` and `SPEC_ANCHOR_RULES` to reflect that proposers may now cite verbatim code excerpts when the flag is on.
- Cap file-read budget per proposer (e.g. 10 file reads max) via `proposers.fileReadBudget?: number`.

**Semantic implication:** semantic doesn't need to set this flag — `ReviewerSession` already has tool access via the dialogue path.

**Cost impact:** higher per proposer, but a debater can now respond *"spec claims `foo()` takes a string but `src/foo.ts:23` shows `(input: User)`"* — concrete grounding instead of textual disagreement.

### Enhancement 3 — Citation discipline for proposals (and rebuttals where present)

`proposers.citationsRequired` requires every concrete claim in a proposal to cite a `factId` from the manifest, a verbatim spec span, or be tagged as design intent. Uncited concrete claims are rejected at parse time. When the composition includes rebuttals (synthesis-selector compositions only — not plan), rebuttals get the same gate.

**Wire-up (as a plug-point):**
- `proposers.citationsRequired` flag in `DebateStageConfig` — when true, proposal prompts (always) and rebuttal prompts (only in synthesis compositions) include the citation requirement section.
- `src/prompts/builders/debate-builder.ts` (`buildProposalPrompt`, and `buildRebuttalPrompt` for synthesis paths) — add conditional citation requirement section.
- Proposal parse in `runner.ts` — when flag is on, parse output for citations; tag uncited concrete claims as advisory.

**Plan applicability:** **yes** — plan composition uses `citationsRequired: true` at proposal time. Plan has no rebuttal loop, so the rebuttal portion of this enhancement doesn't fire for plan.

**Semantic applicability:** **yes** at proposal time — semantic sets `citationsRequired: true` to formalize what `verifiedBy.observed` already enforces. Documentation/discipline upgrade, not a behavior change. Semantic has no rebuttals either (force-overridden to panel one-shot).

**Synthesis-using stages applicability:** rebuttal-citation discipline only fires when the composition keeps rebuttals — none of the current stages do, but future acceptance/rectification debate could.

**Why this matters:** citation discipline is the gate that makes the verifier (Enhancement 5) and the verifier-pick selector (Enhancement 4) meaningful. Without it, "verified" claims would just be confident-sounding text.

### Enhancement 4 — Selector strategies (verifier-pick, dialogue-verdict, synthesis)

The current synthesis path is one of three selector strategies; this enhancement formalizes the registry and adds two more.

| Selector | Mechanism | Used by |
|:---|:---|:---|
| `synthesis` | LLM merges N proposals into one (current behavior) | Current default; available for future compositions |
| `verifier-pick` | Mechanical: rank proposals by checklist + citation rate; highest wins; no LLM merge | Plan composition |
| `dialogue-verdict` | Resolver dispatches via `ReviewerSession.getVerdict()` for tool-verified resolution | Semantic composition |

**`verifier-pick` ranking signals** (mechanical, no LLM call):
- `citationRate` — fraction of concrete claims with `factId`
- `citationDistribution` — verified facts > spec spans > uncited
- `failureModesCovered` — count of negative-path ACs
- `contextFilesValid` — fraction of `contextFiles` that exist on disk

Highest combined score wins as-is; if Enhancement 6 (patch) is enabled and AC-overlap with runner-up is below threshold, the patch step runs in the winner's open session.

**Wire-up:**
- `src/debate/selectors/` — directory holding strategy implementations (`synthesis.ts`, `verifier-pick.ts`, `dialogue-verdict.ts`) + `registry.ts`.
- `src/debate/selectors/synthesis.ts` — extracted from current `resolvers.ts` (behavior-preserving). Optional citation-rate weighting in the prompt when manifest is present.
- `src/debate/selectors/verifier-pick.ts` — new mechanical ranker.
- `src/debate/selectors/dialogue-verdict.ts` — wraps existing `getVerdict()` path.
- Selector strategies receive a uniform `SelectorContext` carrying `proposals`, `manifest?`, `citationScores?`, `reviewerSession?` — each uses what it needs.

**Plan applicability:** uses `verifier-pick`. No LLM call at selection time → **selection cost is zero LLM calls**.

**Semantic applicability:** uses `dialogue-verdict`. No behavior change.

**Future compositions** can use `synthesis` with citation-rate weighting if they want LLM merging with grounding pressure.

### Enhancement 5 — Mechanical post-debate verifier (load-bearing)

After synthesis produces `prd.json`, run **one cheap deterministic pass** — no LLM judgment required:

| Check | Mechanism |
|:---|:---|
| `files-exist` | Every `contextFiles` path and every file referenced in story descriptions exists on disk |
| `ac-anchored` | Every AC has a `verifiedBy` anchor (file/symbol/test name) |
| `claims-cited` | Every concrete claim cites a verified `factId` or is tagged as design intent |
| `no-contradictions` | No PRD claim contradicts a `contradicted` `specClaim` from the manifest |
| `spec-coverage` | Every spec AC appears in the PRD or in a documented gap |

**Wire-up (as a plug-point):**
- `src/debate/verifiers/` — new directory holding verifier strategies (`plan-checklist.ts`, `review-grounding-filter.ts`, `custom`).
- `src/debate/verifiers/plan-checklist.ts` — closed checklist + mechanical checks. Reusable across both this proposal and the pipeline alternative.
- `src/debate/verifiers/review-grounding-filter.ts` — wraps existing `filterByAcGroundingMinimal` + `sanitizeRefModeFindings` + `isBlockingSeverity` from [semantic-debate.ts:245-257](../../src/review/semantic-debate.ts#L245). No behavior change for semantic.
- `DebateRunner` — after the selector emits its result, if `postDebateVerifier` is set, dispatch to the registered strategy.
- On blocker findings → emit `spec-deltas.md` (plan) or block via existing review machinery (semantic).

**Semantic implication:** semantic now declares `postDebateVerifier: { kind: "review-grounding-filter" }` instead of the logic being implicit in `semantic-debate.ts`. The behavior is identical; the plug-point just makes it explicit and consistent with plan.

**Why this is load-bearing, not optional:** without it, enhanced debate still has the synthesis-laundering problem from Gap 3. The verifier is the asymmetric audit smuggled into the debate flow — it's what closes the convergence-on-wrong-answer hole that pure debate has.

**Diagnostic value:** if the verifier rejects most synthesized PRDs in production, that's evidence debate's divergence isn't paying for itself. The verifier doubles as a measurement instrument for whether enhanced debate is earning its cost.

### Enhancement 6 — Optional patch step on proposal divergence (verifier-pick only)

Pure verifier-pick discards divergence value when proposals genuinely diverge — debater A's security AC and debater B's edge-case AC both die if only one proposal wins. The patch step recovers some of that without the synthesis-laundering risk.

**Mechanism:**
1. After verifier-pick selects a winner, compute AC overlap between winner and runner-up. Cheap signal: Jaccard on AC text after stopword normalization, or citation-set overlap.
2. If overlap > θ (default 0.8) → proposals converged organically; skip patch.
3. If overlap < θ → extract ACs from runner-up that have **no near-match in winner** (top K, e.g. K=5).
4. In the winner's already-open stateful session, send: *"You drafted PRD-A. Another debater proposed these ACs that have no near-match in your draft. For each, decide: integrate verbatim, integrate as `suggestedCriteria`, or reject with a one-line reason. Cite a `factId` for any AC you integrate."*
5. Single call in an open session (cheap), explicit alternatives, no symmetric merge.

**Wire-up:**
- `src/debate/selectors/verifier-pick.ts` — extend the strategy to optionally invoke a patch step. Configured via `selector` plug-point sub-field:

```typescript
selector: { kind: "verifier-pick", patch?: { enabled: boolean; overlapThreshold?: number; maxDeltas?: number } }
```

- New `src/prompts/builders/patch-builder.ts` — single prompt method `buildPatchPrompt(winner, deltas)`.
- Patch call uses `agentManager.runAsSession` against the winner's open handle (Layer 3 is permitted here: it's a continuation of an already-open session, not a new session opening — see [adapter-wiring.md](../../.claude/rules/adapter-wiring.md) Rule 3 wiring-layer carve-out).

**Plan applicability:** **yes** — plan composition enables patch with default threshold.

**Semantic applicability:** **no** — semantic uses `dialogue-verdict`, not `verifier-pick`.

**Cost:** 0 calls in the convergent case (overlap > θ); +1 call in the divergent case. Empirically, divergence rate determines amortized cost.

**Why not symmetric synthesis instead?** Symmetric synthesis re-introduces the laundering problem (Gap 3). Patch keeps one agent in control, with explicit alternatives and a citation requirement on integrations — it's grounded merge, not blind merge.

## 5. Artifacts

| Artifact | Source | Persistence | Plan composition? |
|:---|:---|:---|:---|
| `facts-manifest.json` | Enhancement 1 (grounder) | `.nax/runs/<runId>/plan/` | Yes |
| `proposal-N.json` (with citations) | Enhancement 2 (proposers) | Intermediate | Yes |
| `rebuttal-N-R.json` (with citations) | Enhancement 3 in synthesis compositions | Intermediate | **No** (plan has no rebuttals) |
| `synthesis-result.json` (with citation scores) | Enhancement 4 in synthesis compositions | Intermediate | **No** (plan uses verifier-pick) |
| `pick-result.json` (proposal scores + winner) | Enhancement 4 in verifier-pick compositions | Intermediate | Yes |
| `patch-result.json` (winner deltas + decisions) | Enhancement 6 (patch) | Intermediate | Yes (when divergent) |
| `verifier-findings.json` | Enhancement 5 (verifier) | `.nax/runs/<runId>/plan/` | Yes |
| `prd.json` | Final output | Replaces current debate output | Yes |
| `spec-deltas.md` | Verifier blockers | Surfaced to terminal | Yes (on blocker) |

### PRD schema additions (`src/prd/schema.ts`, additive)

```typescript
interface AcceptanceCriterion {
  text: string;
  // NEW — optional, additive
  verifiedBy?: {
    kind: "test" | "symbol" | "file";
    anchor: string;          // e.g. "test/unit/x.test.ts::rejects empty"
    factIds: string[];       // links to facts-manifest.json
  };
  intent?: boolean;          // true = design intent (no citation required)
}

interface ContextFile {
  path: string;
  factId?: string;           // NEW — links to facts-manifest.json
}
```

Single SSOT — both this proposal and the pipeline proposal share these fields.

### `verifier-findings.json` schema

```jsonc
{
  "checklistResults": {
    "spec-coverage":   "pass" | "fail" | "partial",
    "ac-anchored":     "pass" | "fail" | "partial",
    "claims-cited":    "pass" | "fail" | "partial",
    "files-exist":     "pass" | "fail",
    "no-contradictions": "pass" | "fail",
    "failure-modes-considered": "pass" | "fail" | "partial"
  },
  "findings": [
    {
      "id": "FIND-001",
      "severity": "blocker" | "major" | "minor",
      "checklistItem": "ac-anchored",
      "storyId": "US-003",
      "issue": "AC 'handles errors gracefully' has no observable assertion",
      "suggestedFix": "rephrase as 'When agent throws X, run completes with status=failed'"
    }
  ]
}
```

### `spec-deltas.md` format

Markdown surfaced to the user when the verifier emits blocker findings traceable to spec→codebase contradictions. Sections:

```markdown
# Spec Deltas — <feature>

## Contradicted spec claims
- **S-001** (spec: lines 23-25): "extends User schema with email field"
  - Verified evidence: `src/models/user.ts:8` — User has only `{id, name}`
  - Recommended action: re-roll spec OR rewrite spec claim

## Unverified spec claims (factual, not intent)
- **S-014**: "uses existing retry middleware"
  - No matching evidence found via grep on retry/middleware terms
  - Recommended action: confirm or rewrite

## Spec gaps surfaced by codebase
- **G-003**: spec ignores existing `src/agents/retry/` module
  - Recommended action: address in revised spec
```

Format owned by `src/plan/spec-deltas.ts` (shared with pipeline proposal).

## 6. Implementation Surface

The work is structured as **framework extension + per-stage composition**, not plan-only edits. The shared runner gains plug-points; plan and semantic register strategies; future stages compose what they need.

### Framework code (shared by all stages)

New directories:
- `src/debate/pre-phase/` — `PreDebatePhase` contract + built-in strategies (`grounder.ts`, registry)
- `src/debate/selectors/` — `Selector` contract + built-in strategies (`synthesis.ts`, `verifier-pick.ts`, `dialogue-verdict.ts`, registry)
- `src/debate/verifiers/` — `PostDebateVerifier` contract + built-in strategies (`plan-checklist.ts`, `review-grounding-filter.ts`, registry)

New files:
- `src/debate/facts-manifest.ts` — Zod schema + parser (also shared with pipeline proposal if both ship)
- `src/prompts/builders/grounder-builder.ts` — grounder prompt (also shared)

Changed files:
- `src/debate/types.ts` ([:45](../../src/debate/types.ts#L45)) — add optional `preDebatePhase`, `proposers`, `selector`, `postDebateVerifier` fields to `DebateStageConfig` (additive, defaults preserve current behavior)
- `src/debate/runner.ts` — primary dispatch point. Read plug-point config from `stageConfig`; dispatch to registered strategies for pre-phase, selector, verifier. Refactor existing synthesis call to go through `selectors/registry.ts`.
- `src/debate/runner-plan.ts`, `src/debate/runner-hybrid.ts`, `src/debate/runner-stateful.ts` — touched only where they currently inline synthesis or rebuttal logic that moves into selector strategies. No structural rewrites.
- `src/debate/resolvers.ts` — extract synthesis logic into `src/debate/selectors/synthesis.ts`; keep thin compat wrapper for any external callers.
- `src/prompts/builders/plan-builder.ts` — gate "no file content" instruction on `proposers.fileReadAccess`; accept manifest section in `taskContext`.
- `src/prompts/builders/debate-builder.ts` — gate citation requirement in proposal prompts on `proposers.citationsRequired`; same for rebuttal prompts (only fires in synthesis compositions).
- `src/prd/schema.ts` — additive citation fields (`verifiedBy`, `factIds`, `contextFiles[].factId`).

### Per-stage composition

Plan side:
- `src/cli/plan.ts` — when debate mode is active, build `DebateStageConfig` with the plan composition (preDebatePhase=grounder, citationsRequired=true, fileReadAccess=true, sessionMode=stateful, selector=verifier-pick, postDebateVerifier=plan-checklist)

Semantic side:
- `src/review/semantic-debate.ts` — refactor the force-override at lines 97-105 into an explicit composition call: build a `DebateStageConfig` with selector=dialogue-verdict, postDebateVerifier=review-grounding-filter. Existing `getVerdict()` and `filterByAcGroundingMinimal` logic moves into the strategy implementations — same behavior, exposed through plug-points.

### Untouched

- Single-call plan path (`planInteractiveOp`) — unchanged; this proposal only enhances debate mode
- Future debate stages (acceptance, rectification) — get the framework for free when they ship
- Downstream pipeline stages — consume same `prd.json` shape

### Adapter-wiring compliance

Per [adapter-wiring.md](../../.claude/rules/adapter-wiring.md):

- **Grounder** — `groundOp: CompleteOperation` invoked via `callOp` (Layer 4). Single-agent structured-output call. **Not** Layer 3.
- **Proposers** — unchanged from current debate; use `agentManager.runAsSession` (Layer 3) — sanctioned for parallel fan-out with dynamic agent names per Rule 3 carve-out.
- **Patch step (Enhancement 6)** — uses `agentManager.runAsSession` against the winner's already-open handle. Permitted as a continuation, not a fresh session opening.
- **Verifier strategies** — `plan-checklist` is mostly mechanical (file I/O + structural checks). For LLM-judgment portions (testability check), use `callOp` (Layer 4) with a dedicated `CompleteOperation`.
- **Selector strategies** — `synthesis` continues to use existing resolver path (`agentManager.completeAs` per current Layer 3 sanctioned debate consumer); `verifier-pick` makes no LLM calls; `dialogue-verdict` continues to dispatch through `ReviewerSession`.

No new direct adapter calls (`adapter.openSession` / `sendTurn` / `closeSession` / `complete`). Strategy implementations sit at the wiring boundary already established for debate.

## 7. Tradeoffs

### Costs (plan composition with N=2 proposers)

| Phase | LLM calls | Notes |
|:---|:---|:---|
| Grounder | 1 | Sequential, blocks the panel |
| Proposers | N (parallel) | Stateful sessions; file reads inside count as tool calls, not separate LLM turns |
| Selector (verifier-pick) | 0 | Mechanical ranking |
| Patch step (Enhancement 6) | 0–1 | Only fires when AC overlap < threshold |
| Verifier (mechanical portion) | 0 | File-existence + citation-presence checks |
| Verifier (LLM-judgment portion, e.g. testability) | 0–1 | Optional; can be mechanical-only |
| **Total** | **3–5 calls** | vs. current debate's 1 + N + N×rounds + 1 = ~6–8 calls |

**Plan's enhanced-debate composition is comparable to or cheaper than current debate**, primarily because dropping rebuttals + synthesis offsets the grounder cost. This corrects an earlier estimate of "1.5–2× current debate cost" — that estimate assumed rebuttals + synthesis remained, which the leaner plan composition does not.

Synthesis-using compositions (which plan does not use) retain higher cost: 1 (grounder) + N (proposers) + N×rounds (rebuttals if hybrid) + 1 (synthesis) + 1 (verifier) = 6+ calls.

### Latency
- **Grounder serializes** the start of the panel — no parallelism for the first call.
- **Proposers parallel** as today (capped by `maxConcurrentDebaters`).
- **No rebuttal rounds in plan composition** — wall-clock time drops vs. current debate with `rounds > 1`.

### Risks
- **Manifest hallucination cascades.** If grounder fabricates evidence paths, all downstream debaters are biased the same way. *Mitigation:* manifest schema requires `evidence` paths; verifier's `files-exist` check rejects fabricated paths mechanically.
- **Citation as ceremony.** Proposers cite the same fact for unrelated claims to satisfy the gate. *Mitigation:* verifier checks citation distribution; high reuse on unrelated claims is a finding.
- **Convergence on wrong manifest.** All N proposers see the same manifest — they can still converge on a manifest-level error. *Mitigation:* the verifier catches manifest-PRD inconsistencies; in compositions that retain rebuttals, citation-gated rebuttals expose disagreement on facts.
- **Verifier skipped → laundering returns.** Enhancement 5 is non-negotiable for any composition that drops rebuttals + synthesis — without it, the verifier-pick selector will cheerfully promote a high-citation-rate but factually-wrong proposal.
- **Patch step regression.** If the patch step's open session is in a degraded state (e.g. context window pressure), the winner may integrate badly. *Mitigation:* cap patch deltas at `maxDeltas` (default 5); any patch failure is logged and the un-patched winner is used.

### What this does NOT solve
- **Cross-story consistency** — same gap as pipeline; each story is debated independently.
- **Spec ambiguity** — debate may surface ambiguity (proposers disagree on grounded facts) but cannot resolve it. Verifier flags ambiguous claims.
- **Cost scaling with debater count** — proposer phase scales linearly with N; grounder + verifier are constant overhead.

## 8. Failure Modes

Each plug-point has a documented failure-mode policy. Where multiple policies are reasonable, the default is listed first; alternative is configurable.

| Failure | Default policy | Alternative | Configured by |
|:---|:---|:---|:---|
| Grounder times out | Proceed without manifest; debate runs in legacy mode for this story | Block story (mark failed) | `preDebatePhase.onFailure: "degrade" \| "block"` |
| Grounder parse error (after retries) | Same as timeout | Same as timeout | Same |
| Manifest contains zero verified facts | Proceed but log warning; verifier likely emits blockers downstream | Block story | Same |
| Proposer fails (current behavior preserved) | Skip; resolver/selector runs with N-1 | Same as today | Existing debate behavior |
| All proposers fail | `buildFailedResult` emits failed outcome (current behavior) | Same as today | Existing debate behavior |
| Selector returns no winner (verifier-pick: all proposals score 0) | Fall back to first proposal; emit critical warning | Block story | `selector.onEmpty: "fallback" \| "block"` |
| Patch step fails / times out | Use un-patched winner | Block story | `selector.patch.onFailure: "use-unpatched" \| "block"` |
| Verifier emits blockers | Emit `spec-deltas.md`; mark story for re-spec; do **not** propagate to TDD | Proceed but tag `routing.complexity = "expert"` | `postDebateVerifier.onBlocker: "block" \| "tag-expert"` |
| Verifier itself crashes (file I/O error) | Treat as critical infra failure; block story | n/a | Hard-coded |

**Why "proceed without manifest" is the default for grounder failure:** plan in legacy mode is still better than no plan. The verifier will catch the absence of grounding (every claim becomes "uncited") and emit blockers, which surfaces the issue without losing the run.

**Why "block on verifier blockers" is the default:** the leaner-shape's whole point is preventing hallucinated PRDs from propagating to TDD/review. Tagging "expert" instead of blocking trades safety for throughput — only sensible when human review is in the loop.

## 9. Comparison to Asymmetric Pipeline Alternative

See [`2026-05-10-plan-asymmetric-pipeline.md` §7](./2026-05-10-plan-asymmetric-pipeline.md#7-comparison-to-enhanced-debate-alternative) for the full comparison. Summary (plan composition only):

| Dimension | Enhanced Debate (plan composition) | Pipeline |
|:---|:---|:---|
| Hallucination floor | Equivalent — verifier-pick + verifier removes synthesis laundering | Equivalent — single drafter + critic |
| AC edge-case coverage | Higher (N proposers' divergence + patch step) | Lower (one drafter blind-spot profile) |
| Cost (N=2) | ~3–5 calls | ~3 calls |
| Debuggability | Medium (composition is explicit; phase artifacts persist) | Higher (clear sequential phase boundaries) |
| Implementation surface | Extends shared debate framework | New subsystem |
| Risk profile | Manifest-cascade across N proposers; mitigated by per-proposer file reads | Single-drafter blind spots |
| Reuse for semantic / future stages | Direct (same plug-points) | Indirect (shared components only) |

**Structural convergence:** enhanced debate with grounder + verifier *is* the pipeline with parallel proposers in the middle phase. The disagreement is whether the divergence in that middle phase is worth its cost.

**Pick this proposal when:**
- Existing debate infrastructure has institutional knowledge worth preserving
- AC completeness / edge-case surfacing is the dominant pain
- Multi-agent divergence has demonstrably found things single-agent missed
- Incremental rollout is preferred over new-subsystem rollout

**Pick the pipeline when:**
- Hallucination prevention is the dominant pain
- Cost / latency budget is tight
- Single-drafter debuggability is valuable
- New-subsystem investment is acceptable

**Migration path:** if enhanced debate ships first and the verifier rejects most PRDs in practice, that's the signal to fall back to the pipeline (the verifier doubles as a measurement of debate's value-add).

## 10. Open Questions

1. **Grounder scope: per-story vs. per-run.** A typical run has 5–20 stories. Per-story is N× cost; per-run is constant but may miss story-specific facts. Reasonable default: per-story for now (consistent with current per-story debate); revisit when grounder cost is measured.
2. **Grounder isolation: shared vs. per-proposer.** Run once and share the manifest across N proposers (cheaper, all proposers see same evidence) or once per proposer with isolated views (more independent verification, N× cost)? Default: shared.
3. **File-read budget.** What's the right cap per proposer? Too low → debaters can't ground claims; too high → cost explodes. Default: 10 file reads / proposer; tunable via `proposers.fileReadBudget`.
4. **Citation parsing robustness.** Regex extraction vs. structured output mode vs. LLM-judge for verifying claims have citations? Default: structured output mode where the agent emits a JSON `claims: [{text, factIds}]` array; regex fallback when agent emits prose.
5. **Patch step overlap metric.** Jaccard on AC text (after stopword + casing normalization) vs. citation-set overlap vs. embedding similarity? Default: Jaccard with stopword normalization (cheap, deterministic, no embeddings infra required).
6. **Cost ceiling.** Should we add a `config.debate.stages.plan.maxCostUsd` budget gate? Plan composition is comparable to current debate cost; budget gate is nice-to-have, not blocker.
7. **Manifest reuse downstream.** TDD/review/acceptance stages currently re-derive context. If they consumed the manifest, we'd amortize grounder cost across the run — but expand scope. Defer to a separate proposal.

## 11. Next Steps

Sequenced to land framework first, then plan composition, then semantic refactor (lowest risk last).

**Phase 0 — Foundation (framework only, no behavior change)**
1. Add additive-optional plug-point fields to `DebateStageConfig` ([types.ts:45](../../src/debate/types.ts#L45)).
2. Define `PreDebatePhase`, `Selector`, `PostDebateVerifier` contracts in `src/debate/{pre-phase,selectors,verifiers}/types.ts`.
3. Build static registries in `src/debate/{pre-phase,selectors,verifiers}/registry.ts`.
4. Refactor existing synthesis logic from `resolvers.ts` into `src/debate/selectors/synthesis.ts` — behavior-preserving extraction.
5. Refactor existing semantic dialogue path into `src/debate/selectors/dialogue-verdict.ts` — behavior-preserving extraction.
6. Refactor existing `filterByAcGroundingMinimal` etc. into `src/debate/verifiers/review-grounding-filter.ts` — behavior-preserving extraction.
7. **Add unit tests for plug-point registries** (resolution by kind, fallback when absent, override precedence).
8. **Add integration tests for both compositions** asserting they reproduce current behavior of plan-debate and semantic-debate paths.
9. Run full test suite (especially `test/unit/debate/`, `test/unit/review/`, `test/integration/review/`) — should pass.

**Phase 1 — Spike**
10. Spike grounder strategy standalone — measure manifest quality, accuracy, and cost on 3–5 representative specs (shared spike with pipeline proposal).
11. Define citation schema additions to `src/prd/schema.ts` (additive; same SSOT as pipeline).

**Phase 2 — Plan composition**
12. Implement `groundOp: CompleteOperation` in `src/operations/ground.ts`; wrap in `grounder` pre-phase strategy.
13. Implement facts-manifest schema in `src/debate/facts-manifest.ts`.
14. Implement `verifier-pick` selector strategy + ranking signals.
15. Implement `plan-checklist` post-debate verifier strategy — **non-negotiable**, ship together with selector change.
16. Implement Enhancement 6 patch step (in `verifier-pick.ts`).
17. Implement file-read access + citation requirement (gated by config flags).
18. Implement `evidenceMode` preset macro that expands to plan composition.
19. Update `src/cli/plan.ts` to read `evidenceMode` and build `DebateStageConfig` accordingly.
20. **Add tests** for: grounder failure modes (degrade vs block), verifier blocker handling, patch step (overlap above and below threshold), citation enforcement at parse time.

**Phase 3 — Semantic refactor (optional, behavior-preserving)**
21. Update `src/review/semantic-debate.ts` to express its existing config via plug-points (selector + verifier strategies). No behavior change. Keeps the codebase consistent and removes the hardcoded force-override at lines 97-105.

**Phase 4 — Measurement**
22. Measure: hallucination rate (verifier blocker rate per N runs), AC quality (downstream test pass rate), cost delta vs. current debate, divergence value (patch-step trigger rate), semantic regression rate (zero expected).

## 12. Shared Components With Pipeline Proposal

If both proposals progress, these components are designed once and reused. Locations updated to reflect the plug-point framework:

| Component | Used by | Owner location |
|:---|:---|:---|
| `facts-manifest.json` schema + parser | Both | `src/debate/facts-manifest.ts` (debate uses it; pipeline imports from here) |
| Grounder prompt builder | Both | `src/prompts/builders/grounder-builder.ts` |
| `plan-checklist` verifier (mechanical + LLM checks) | Both | `src/debate/verifiers/plan-checklist.ts` (debate strategy; pipeline calls the same module) |
| `verifiedBy` / `factIds` schema additions | Both | `src/prd/schema.ts` |
| `spec-deltas.md` artifact format | Both | `src/plan/spec-deltas.ts` |

The spike work for either proposal benefits the other; the choice between them is mostly about the middle phase (single drafter vs. parallel proposers + verifier-pick), not the surrounding infrastructure.

## 13. Cross-Stage Impact Summary

| Stage | Today | After this proposal | Behavior change? |
|:---|:---|:---|:---|
| Plan (debate mode) | Single-call or N-debater synthesis | Grounder + cited proposers + verifier-pick + checklist | **Yes — opt-in via `evidenceMode` flag** |
| Plan (single-call mode) | `planInteractiveOp` | Unchanged | No |
| Semantic review | Force-narrowed panel one-shot + `getVerdict()` + `filterByAcGroundingMinimal` | Same logic, expressed via plug-points (selector=dialogue-verdict, verifier=review-grounding-filter) | **No — refactor only** |
| Acceptance debate (future) | N/A | Composes from same plug-points | N/A |
| Rectification debate (future) | N/A | Composes from same plug-points | N/A |

The non-negotiable invariant: **`DebateRunner` remains a single shared SSOT.** Any change that requires forking it into stage-specific runners is wrong by construction and must be reworked as a plug-point instead.
