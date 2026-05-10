# SPEC: Enhanced Debate — Phase 2 (Plan Composition with Grounding)

## Summary

Wire the Phase 1 plug-point framework into a complete `nax plan` debate composition that prevents spec→codebase hallucination. This phase adds the `grounder` pre-debate strategy, citation discipline at proposal parse time, file-read access for proposers, the `verifier-pick` selector with mechanical ranking, the `plan-checklist` post-debate verifier, the `spec-deltas.md` artifact emitter, and the `evidenceMode` preset macro that lets users opt into the new composition. Existing `nax plan` behavior is preserved when `evidenceMode = "current"` (default); new behavior activates only when `evidenceMode = "asymmetric"`.

## Motivation

Today's `nax plan` debate transcribes spec hallucinations into PRDs because (a) all debaters consume the spec without verifying claims against the actual codebase, (b) the synthesis resolver merges N proposals using LLM judgment which launders shared agreements into confident output, and (c) no mechanical check sits between synthesis and downstream consumers (TDD, review, acceptance) who inherit the lie.

Phase 1 built the framework. Phase 2 makes it useful by composing the plan stage to:

- **Ground first** — a single pre-debate `groundOp` reads the codebase and produces a structured facts manifest annotating which spec claims are verified, contradicted, or unverifiable.
- **Cite always** — proposers see the manifest and must cite a `factId` for every concrete claim or tag it as design intent. Uncited concrete claims are tagged advisory at parse time.
- **Pick mechanically** — instead of LLM synthesis merging proposals, a `verifier-pick` selector ranks proposals by citation rate + checklist score and picks the highest-scoring one (no LLM laundering).
- **Verify mechanically** — a `plan-checklist` post-debate verifier runs deterministic checks (files exist, ACs anchored, claims cited, no contradictions) and emits `spec-deltas.md` on blockers.
- **Optional patch** — when top proposals diverge significantly, the winner's open session receives the runner-up's distinct ACs and decides which to integrate (preserves divergence value without symmetric merge).

This composition lives entirely in `DebateStageConfig` plug-points; no new code paths through the runner. Behavior change is gated by `config.debate.stages.plan.evidenceMode = "asymmetric"`, default `"current"` for safe rollout.

## Design

### Schema extensions (additive on Phase 1 schemas)

Phase 2 extends Phase 1's plug-point schemas with the new selector kind, verifier kind, plan-stage `evidenceMode` field, and three failure-mode policy fields. All additions are additive-optional with defaults — existing configs continue working.

```typescript
// src/config/schemas-debate.ts (Phase 2 additions, applied on top of Phase 1)

// 1. Extend selector union with verifier-pick (Phase 1 had 5 kinds: synthesis, majority-fail-closed,
//    majority-fail-open, judge, dialogue-verdict. Phase 2 adds verifier-pick.)
selector?:
  | { kind: "synthesis" }
  | { kind: "majority-fail-closed" }
  | { kind: "majority-fail-open" }
  | { kind: "judge" }
  | { kind: "dialogue-verdict" }
  | {                                                              // NEW in Phase 2
      kind: "verifier-pick";
      patch?: {
        enabled: boolean;
        overlapThreshold?: number;                                 // default 0.8
        maxDeltas?: number;                                        // default 5
        onFailure?: "use-unpatched" | "block";                     // default "use-unpatched"
      };
    };

// 2. Extend verifier kind union (Phase 1 had review-grounding-filter + custom; Phase 2 adds plan-checklist)
postDebateVerifier?: {
  kind: "plan-checklist" | "review-grounding-filter" | "custom";   // plan-checklist NEW in Phase 2
  onBlocker?: "block" | "tag-expert";                              // NEW in Phase 2; default "block"
};

// 3. Add onFailure to preDebatePhase (Phase 1 only had `kind` field)
preDebatePhase?: {
  kind: "grounder" | "custom";
  onFailure?: "degrade" | "block";                                 // NEW in Phase 2; default "degrade"
};

// 4. Add evidenceMode to plan stage (NOT to other stages — plan-specific)
// Implemented by extending the plan-stage schema in DebateConfigSchema.stages.plan,
// not the generic DebateStageConfigSchema (which is shared across all stages).
const PlanStageExtensions = z.object({
  evidenceMode: z.enum(["current", "asymmetric"]).default("current"),
});
// In DebateConfigSchema.stages.plan: z.preprocess(toObject, DebateStageConfigInner.merge(PlanStageExtensions))
// Other stages (review, acceptance, rectification, escalation) use the bare DebateStageConfigInner.
```

### Plan composition

`src/cli/plan.ts` builds `DebateStageConfig` from `evidenceMode` when debate mode is enabled:

```typescript
// evidenceMode = "asymmetric" expands to:
{
  preDebatePhase: { kind: "grounder" },
  proposers: { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
  sessionMode: "stateful",
  selector: { kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 } },
  postDebateVerifier: { kind: "plan-checklist" },
  // ... existing user-config fields preserved
}

// evidenceMode = "current" (default) expands to:
{
  // no plug-point fields — current debate behavior unchanged
  // ... existing user-config fields preserved
}
```

Explicit user-set plug-point fields override the macro expansion (advanced users can mix and match).

### `grounder` pre-debate strategy

Wraps `groundOp` from Phase 1. Per Phase 1 design (Shape A — config-driven), `groundOp` reads its model and timeout from `ctx.config.grounder` directly; the strategy does NOT thread model config through input. This matches the dominant config-driven op pattern in the codebase (see Phase 1 §"Top-level grounder block" rationale).

```typescript
// src/debate/pre-phase/grounder.ts
export const grounderStrategy: PreDebatePhase = async (ctx) => {
  if (!ctx.specContent) {
    return { manifestSection: "", costUsd: 0 };
  }
  const codebaseContext = await buildCodebaseContext(ctx.workdir);

  // groundOp reads model/timeout from ctx.config.grounder (Pattern A — config-driven, not input-threaded).
  // Strategy only passes data the op consumes; configuration is the op's responsibility.
  const result = await callOp(ctx.ctx, groundOp, {
    specContent: ctx.specContent,
    codebaseContext,
    workdir: ctx.workdir,
  });
  await writeManifestArtifact(ctx, result);
  return {
    manifestSection: renderManifestSection(result),
    costUsd: 0, // cost flows through middleware audit, same as resolver cost in synthesisResolver
  };
};
```

Manifest is written to `.nax/runs/<runId>/plan/<storyId>/facts-manifest.json` for inspection and downstream consumption.

User config example (model lives at the top-level `grounder` block, not on per-stage `preDebatePhase`):

```json
{
  "debate": {
    "grounder": { "model": "balanced", "timeoutSeconds": 600 },
    "stages": {
      "plan": {
        "evidenceMode": "asymmetric",
        "preDebatePhase": { "kind": "grounder" }
      }
    }
  }
}
```

### Citation parsing utility

`src/debate/citations.ts` exports a parser that uses `parseLLMJson` (codebase SSOT) with regex fallback for inline `[F-014]`-style citations.

```typescript
export interface ParsedClaim {
  text: string;
  factIds: string[];          // e.g. ["F-014", "S-001"]
  cited: boolean;
}

export function extractClaims(proposalOutput: string): ParsedClaim[];
export function citationRate(claims: ParsedClaim[]): number;          // fraction cited
export function citationDistribution(claims: ParsedClaim[], manifest: FactsManifest): {
  verifiedFacts: number; specSpans: number; uncited: number;
};
```

Parser priority order:
1. **Structured-output mode** — if proposal contains a JSON `claims` array per the citation prompt, use `parseLLMJson` to extract.
2. **Regex fallback** — extract `factId` references inline (`[F-001]`, `(F-001, S-002)`).
3. **Tolerance** — proposers that emit no citations at all return zero-rate; downstream verifier flags this. Parser does not throw.

### `verifier-pick` selector strategy

```typescript
// src/debate/selectors/verifier-pick.ts
interface PatchResult {
  output: string;          // patched PRD JSON, replaces winner.proposal.output
  cost: number;            // LLM cost of the patch call
}

export const verifierPickSelector: Selector = async (ctx) => {
  const manifest = extractManifestFromContext(ctx);
  const scored = ctx.proposals.map((p) => ({
    proposal: p,
    score: computeScore(p, manifest),
  }));
  scored.sort((a, b) => b.score.total - a.score.total);
  const winner = scored[0];
  const patchConfig = ctx.stageConfig.selector?.kind === "verifier-pick" ? ctx.stageConfig.selector.patch : undefined;

  if (patchConfig?.enabled) {
    const runnerUp = scored[1];
    if (runnerUp && acOverlap(winner, runnerUp) < (patchConfig.overlapThreshold ?? 0.8)) {
      try {
        const patched = await runPatchStep(ctx, winner, runnerUp, patchConfig.maxDeltas ?? 5);
        return { outcome: "passed", output: patched.output, resolverCostUsd: patched.cost };
      } catch (err) {
        // patchConfig.onFailure ?? "use-unpatched"
        if ((patchConfig.onFailure ?? "use-unpatched") === "block") {
          return { outcome: "failed", resolverCostUsd: 0 };
        }
        // Fall through to un-patched winner
      }
    }
  }

  return { outcome: "passed", output: winner.proposal.output, resolverCostUsd: 0 };
};
```

Score signals (mechanical, no LLM):
- `citationRate` — fraction of concrete claims with `factId`
- `citationDistribution` — verified facts > spec spans > uncited
- `failureModesCovered` — count of negative-path ACs
- `contextFilesValid` — fraction of `contextFiles` paths that exist on disk

### Patch step

When top-2 AC overlap < threshold, runs in winner's already-open stateful session. Single LLM call. Returns patched PRD output as a string (replaces the winner's original output).

```typescript
async function runPatchStep(
  ctx: SelectorContext,
  winner: ScoredProposal,
  runnerUp: ScoredProposal,
  maxDeltas: number,
): Promise<PatchResult> {
  const deltas = extractDistinctACs(winner.proposal, runnerUp.proposal, maxDeltas);
  const prompt = new PatchPromptBuilder().build(winner.proposal.output, deltas);
  // Layer 3 sanctioned: continuation of an already-open session, not a new opening.
  // Requires winner.proposal to carry the open session handle from the proposer fan-out
  // (sessionMode: "stateful" in plan composition ensures this).
  const result = await ctx.agentManager.runAsSession(
    winner.proposal.agentName,
    winner.proposal.handle,
    prompt,
    { storyId: ctx.storyId, pipelineStage: "plan" },
  );
  return { output: result.output, cost: result.estimatedCostUsd ?? 0 };
}
```

### `plan-checklist` verifier strategy

```typescript
// src/debate/verifiers/plan-checklist.ts
export const planChecklistVerifier: PostDebateVerifier = async (ctx) => {
  const prd = parsePrd(ctx.selectorResult.output);
  if (!prd) return { outcome: "failed", costUsd: 0 };

  const findings: VerifierFinding[] = [];
  findings.push(...checkFilesExist(prd, ctx.workdir));
  findings.push(...checkAcAnchored(prd));
  findings.push(...checkClaimsCited(prd));
  findings.push(...checkNoContradictions(prd, manifest));
  findings.push(...checkSpecCoverage(prd, ctx.stageConfig));

  const blockers = findings.filter((f) => f.severity === "blocker");
  if (blockers.length > 0) {
    await emitSpecDeltas(ctx, blockers);
    return { outcome: "failed", findings, costUsd: 0 };
  }
  return { outcome: "passed", findings, costUsd: 0 };
};
```

All checks are mechanical (file I/O, structural). No LLM calls.

### `spec-deltas.md` format

```markdown
# Spec Deltas — <feature>

## Contradicted spec claims
- **S-001** (spec: lines 23-25): "extends User schema with email field"
  - Verified evidence: `src/models/user.ts:8` — User has only `{id, name}`
  - Recommended action: re-roll spec OR rewrite spec claim

## Unverified spec claims (factual, not intent)
- **S-014**: "uses existing retry middleware"
  - No matching evidence found
  - Recommended action: confirm or rewrite

## Spec gaps surfaced by codebase
- **G-003**: spec ignores existing `src/agents/retry/` module
  - Recommended action: address in revised spec
```

Owned by `src/plan/spec-deltas.ts`. Surfaced to terminal on blocker findings. Persisted to `.nax/runs/<runId>/plan/<storyId>/spec-deltas.md`.

### PRD schema additions (additive, backward-compatible)

```typescript
// src/prd/schema.ts (additive Zod fields)
const VerifiedBySchema = z.object({
  kind: z.enum(["test", "symbol", "file"]),
  anchor: z.string().min(1),
  factIds: z.array(z.string()),
}).optional();

// AcceptanceCriterion gains:
verifiedBy: VerifiedBySchema,
intent: z.boolean().optional(),

// ContextFile gains:
factId: z.string().optional(),
```

Existing PRDs without these fields continue to validate; downstream consumers (TDD, review) ignore the new fields if present (Phase 3 in a separate proposal could consume them).

### File-read access flag

`src/prompts/builders/plan-builder.ts` gates the existing "no file content / do NOT assert specific line numbers" instruction on `proposers.fileReadAccess`. When the flag is true:
- The constraint is removed from the proposer prompt.
- A new instruction is added: *"You may use file-read tools to verify spec claims against actual code. Cite the resulting `factId` from the manifest, or include a `verbatim:` excerpt with `path:line-range` for any claim derived from a file you read directly."*
- File-read budget is enforced via `proposers.fileReadBudget` (default 10) — prompted to the agent as a soft cap.

### `evidenceMode` preset macro

`evidenceMode` is added to the plan-stage config (NOT all stages) per §"Schema extensions" above. The Zod implementation merges `PlanStageExtensions` into the plan-stage object so other stages remain unaffected.

`src/cli/plan.ts` consumes `evidenceMode` at composition build time:
1. Read `stageConfig.evidenceMode` (default `"current"`).
2. If `"asymmetric"`, expand to the plan composition (see "Plan composition" above).
3. Merge user-set plug-point fields **on top of** the macro expansion — user's explicit choice wins per field.

```typescript
// src/cli/plan.ts (sketch)
function buildPlanComposition(userStageConfig: DebateStageConfig & { evidenceMode: "current" | "asymmetric" }): DebateStageConfig {
  if (userStageConfig.evidenceMode === "current") return userStageConfig;
  // Asymmetric: macro defaults, user overrides
  return {
    ...userStageConfig,
    preDebatePhase: userStageConfig.preDebatePhase ?? { kind: "grounder" },
    proposers: userStageConfig.proposers ?? { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
    sessionMode: userStageConfig.sessionMode ?? "stateful",
    selector: userStageConfig.selector ?? { kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 } },
    postDebateVerifier: userStageConfig.postDebateVerifier ?? { kind: "plan-checklist" },
  };
}
```

### Integration

- **Existing types to extend:** `DebateStageConfig` (plug-point fields from Phase 1, plus `evidenceMode` on plan stage); `AcceptanceCriterion` and `ContextFile` in `src/prd/schema.ts`.
- **Integration points:** `src/cli/plan.ts::runPlanCommand()` (composition build); `src/debate/runner-plan.ts` (pre-phase + selector + verifier dispatch already wired in Phase 1 US-004).
- **Existing patterns to follow:** `src/debate/selectors/synthesis.ts` (extracted from `resolvers.ts` in Phase 1) for selector strategy shape; `src/debate/verifiers/review-grounding-filter.ts` (extracted from `semantic-debate.ts` in Phase 1) for verifier strategy shape; `src/debate/pre-phase/types.ts` (defined in Phase 1) for pre-phase contract; `src/operations/plan.ts` and `src/operations/acceptance-generate.ts` for Pattern A `model: (_input, ctx) => ctx.config.<slice>.model` in any new ops.
- **Reuses Phase 1 infrastructure:** `groundOp`, `FactsManifestSchema`, `parseFactsManifest`, `renderManifestSection`, registries.

### Approach

`evidenceMode` is a config-driven feature flag. Default `"current"` preserves today's behavior bit-for-bit. Setting `"asymmetric"` activates the new composition entirely through plug-points wired in Phase 1; no new dispatch paths are introduced. Citation parsing uses the codebase's `parseLLMJson` SSOT with regex fallback — not a new parser. The patch step uses `agentManager.runAsSession` against the winner's existing open handle (sanctioned by [adapter-wiring.md](../../.claude/rules/adapter-wiring.md) Rule 3 carve-out for session continuation).

### Failure Handling

- **Grounder timeout / parse failure** — proceed without manifest; debate runs in legacy mode for this story; verifier downstream catches the absence of grounding (every claim becomes uncited) and emits blockers. Configurable via `preDebatePhase.onFailure: "degrade" | "block"` (default `"degrade"`).
- **Manifest contains zero verified facts** — proceed but log warning; verifier likely emits blockers downstream.
- **Patch step fails / times out** — use un-patched winner; log warning. Configurable via `selector.patch.onFailure: "use-unpatched" | "block"` (default `"use-unpatched"`).
- **Verifier emits blockers** — emit `spec-deltas.md`; mark story for re-spec; do NOT propagate to TDD. Configurable via `postDebateVerifier.onBlocker: "block" | "tag-expert"` (default `"block"`).
- **Verifier crashes (file I/O error)** — treat as critical infra failure; block story (hard-coded, not configurable).
- **Citation parsing fails** — return zero-rate; verifier downstream emits "claims-cited: fail" finding.

## Stories

1. **US-001: Schema extensions for Phase 2 plug-points + PRD citations** — extends Phase 1's `selector` discriminated union to add the `verifier-pick` kind (with `patch` sub-config including `enabled`, `overlapThreshold`, `maxDeltas`, `onFailure`); extends `postDebateVerifier.kind` to add `plan-checklist`; adds optional `onFailure` to `preDebatePhase`; adds optional `onBlocker` to `postDebateVerifier`; adds `evidenceMode` to plan-stage schema only via merge (not other stages); adds optional `verifiedBy`, `intent`, and `contextFiles[].factId` fields to `src/prd/schema.ts`. All additions are additive — existing configs and PRDs continue validating.
2. **US-002: Citation parser + manifest threading + file-read flag** — implements `src/debate/citations.ts` with `extractClaims`, `citationRate`, `citationDistribution`; threads facts manifest from `PreDebatePhaseResult.manifestSection` into `DebateProposeInput` so proposers see it in their prompt; gates citation requirement section in `DebatePromptBuilder.proposeSlot()` on `stageConfig.proposers?.citationsRequired`; gates the "no file content" instruction in `plan-builder.ts` on `stageConfig.proposers?.fileReadAccess` and adds the file-read instruction with budget when flag is true.
3. **US-003: `grounder` pre-phase strategy + `verifier-pick` selector + patch step** — wraps Phase 1's `groundOp` as a `PreDebatePhase` strategy and registers it; implements `verifier-pick` selector with mechanical ranking (citation rate, citation distribution, failure-modes-covered, context-files-valid) and registers it; implements optional patch step gated on `selector.patch.enabled` with `onFailure` policy; implements `PatchPromptBuilder` for the patch-step prompt.
4. **US-004: `plan-checklist` verifier + `spec-deltas.md` formatter** — implements `src/debate/verifiers/plan-checklist.ts` with five mechanical checks (files-exist, ac-anchored, claims-cited, no-contradictions, spec-coverage) and registers it; implements `src/plan/spec-deltas.ts` with the formatter that produces the markdown artifact; wires blocker findings to emit the artifact and surface to terminal; respects `postDebateVerifier.onBlocker` policy.
5. **US-005: `evidenceMode` preset + `src/cli/plan.ts` wiring** — implements composition build in `src/cli/plan.ts` that expands `evidenceMode = "asymmetric"` into the full plug-point composition (explicit user fields take precedence over macro defaults); preserves byte-equivalent behavior when `evidenceMode = "current"`; wires the `preDebatePhase.onFailure` policy invocation in `runner-plan.ts` so the strategy's exception is caught and policy-routed.

### Dependencies

- US-001: depends on Phase 1 US-001 (Phase 1 schemas to extend)
- US-002: depends on US-001 (uses citation field on PRD), Phase 1 US-005 (`renderManifestSection`)
- US-003: depends on US-001 (selector schema with `verifier-pick`), US-002 (citations utility), Phase 1 US-005 (`groundOp`)
- US-004: depends on US-001 (verifier schema with `plan-checklist`, PRD citations), US-002 (citations), Phase 1 US-005 (manifest schema)
- US-005: depends on US-001 (`evidenceMode` schema field, all plug-point schemas), US-003 (grounder + verifier-pick registered), US-004 (plan-checklist registered)

### Context Files (per story)

**US-001:**
- `src/config/schemas-debate.ts` — Phase 1 plug-point schema to extend with `verifier-pick` selector kind, `plan-checklist` verifier kind, `onFailure`/`onBlocker` policy fields, and plan-stage `evidenceMode`
- `src/debate/types.ts` — TypeScript discriminated unions to extend in lockstep with the Zod schema
- `src/prd/schema.ts` — PRD Zod schema for additive citation fields (`verifiedBy`, `intent`, `contextFiles[].factId`)
- `src/prd/types.ts` — PRD TypeScript types to extend
- `src/config/schemas-model.ts` — `ConfiguredModelSchema` reference (already in use by Phase 1 grounder block)
- `test/unit/config/schemas-debate.test.ts` (if exists, otherwise create) — schema parsing test patterns

**US-002:**
- `src/debate/facts-manifest.ts` — manifest schema and `renderManifestSection` (created in Phase 1 US-005)
- `src/operations/debate-propose.ts` — `DebateProposeInput` to extend with `manifestSection?: string`
- `src/prompts/builders/debate-builder.ts` — `DebatePromptBuilder.proposeSlot()` to gate citation requirement section
- `src/prompts/builders/plan-builder.ts:125` — "no file content" instruction to gate on `proposers.fileReadAccess`
- `src/utils/llm-json.ts` — `parseLLMJson` SSOT for structured-output parsing
- `src/debate/runner.ts:131-143` — proposer fan-out where `manifestSection` must be threaded into `DebateProposeInput`
- `src/debate/runner-plan.ts` — same threading for the plan dispatch path
- `src/config/test-strategy.ts:183` — `SPEC_ANCHOR_RULES` referenced by plan-builder

**US-003:**
- `src/debate/pre-phase/types.ts` — `PreDebatePhase` contract (created in Phase 1)
- `src/debate/pre-phase/registry.ts` — registry to register `grounder` (created in Phase 1)
- `src/debate/selectors/types.ts` — `Selector` contract (created in Phase 1)
- `src/debate/selectors/registry.ts` — registry to register `verifier-pick` (created in Phase 1)
- `src/operations/ground.ts` — `groundOp` to invoke (created in Phase 1)
- `src/operations/call.ts` — `callOp` for invoking the ground op
- `src/agents/manager.ts` — `runAsSession` for patch step continuation
- `src/debate/session-helpers.ts` — `SuccessfulProposal` interface (must include `handle?: SessionHandle` for stateful proposers)
- `src/debate/citations.ts` — `citationRate` and `citationDistribution` (created in US-002)
- `src/prompts/builders/` — directory to add `patch-builder.ts`

**US-004:**
- `src/debate/verifiers/types.ts` — `PostDebateVerifier` contract (created in Phase 1)
- `src/debate/verifiers/registry.ts` — registry to register `plan-checklist` (created in Phase 1)
- `src/prd/schema.ts` — `verifiedBy` / `factIds` for ac-anchored and claims-cited checks (extended in US-001)
- `src/debate/facts-manifest.ts` — `FactsManifest` for no-contradictions check (created in Phase 1)
- `src/debate/citations.ts` — citation extraction (created in US-002)

**US-005:**
- `src/cli/plan.ts:147-180` — `createDebateRunner` call site where composition is built
- `src/cli/plan-runtime.ts` — runtime helpers used by plan command
- `src/debate/runner-plan.ts` — `preDebatePhase.onFailure` policy invocation point (caller of grounder strategy)
- `src/debate/pre-phase/grounder.ts` — strategy whose exception triggers the policy (created in US-003)

## Acceptance Criteria

### US-001: Schema extensions for Phase 2 plug-points + PRD citations

- `DebateStageConfigSchema.parse({ selector: { kind: "verifier-pick" } })` accepts the input and returns `result.selector.kind === "verifier-pick"` (Phase 2 union extension)
- `DebateStageConfigSchema.parse({ selector: { kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.7, maxDeltas: 3, onFailure: "block" } } })` returns all four `patch` fields preserved
- `DebateStageConfigSchema.parse({ selector: { kind: "verifier-pick", patch: { enabled: true } } })` returns `result.selector.patch.overlapThreshold === undefined` and `maxDeltas === undefined` (no defaults applied at parse — strategy applies them at use)
- `DebateStageConfigSchema.parse({ postDebateVerifier: { kind: "plan-checklist" } })` returns `result.postDebateVerifier.kind === "plan-checklist"`
- `DebateStageConfigSchema.parse({ postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" } })` returns `result.postDebateVerifier.onBlocker === "tag-expert"`
- `DebateStageConfigSchema.parse({ postDebateVerifier: { kind: "plan-checklist", onBlocker: "invalid" } })` throws a `ZodError`
- `DebateStageConfigSchema.parse({ preDebatePhase: { kind: "grounder", onFailure: "block" } })` returns `result.preDebatePhase.onFailure === "block"`
- `DebateStageConfigSchema.parse({ preDebatePhase: { kind: "grounder", onFailure: "invalid" } })` throws a `ZodError`
- `DebateConfigSchema.parse({ stages: { plan: { evidenceMode: "asymmetric" } } })` returns `result.stages.plan.evidenceMode === "asymmetric"`
- `DebateConfigSchema.parse({ stages: { plan: {} } })` returns `result.stages.plan.evidenceMode === "current"` (default applied)
- `DebateConfigSchema.parse({ stages: { plan: { evidenceMode: "unknown" } } })` throws a `ZodError`
- `DebateConfigSchema.parse({ stages: { review: { evidenceMode: "asymmetric" } } })` throws a `ZodError` because `evidenceMode` is plan-stage-only
- `PrdSchema.parse(prdWithoutCitations)` accepts a PRD that omits `verifiedBy`, `intent`, and `contextFiles[].factId` fields and returns a valid object (backward compatibility)
- `PrdSchema.parse(prdWithCitations)` accepts a PRD where an `acceptanceCriterion` includes `verifiedBy: { kind: "test", anchor: "test/x.test.ts::name", factIds: ["F-001"] }` and returns the field intact
- `PrdSchema.parse({ ... acceptanceCriteria: [{ text: "...", intent: true }] })` accepts the `intent: true` flag and returns it intact
- `PrdSchema.parse({ ... contextFiles: [{ path: "src/x.ts", factId: "F-001" }] })` accepts the `factId` field and returns it intact
- `PrdSchema.parse({ ... acceptanceCriteria: [{ text: "...", verifiedBy: { kind: "invalid-kind", anchor: "x", factIds: [] } }] })` throws a `ZodError` because `kind` is restricted to `"test" | "symbol" | "file"`

### US-002: Citation parser + manifest threading + file-read flag

- `extractClaims(output)` returns an array of `ParsedClaim` where `cited === true` for any claim containing `[F-NNN]` or a JSON `claims[].factIds` non-empty array
- `extractClaims(output)` returns `cited === false` for prose claims with no citation markers
- `citationRate(claims)` returns `0` when `claims` is empty; returns `claims.filter(c => c.cited).length / claims.length` otherwise
- `citationDistribution(claims, manifest)` returns `{ verifiedFacts: N, specSpans: M, uncited: K }` where `verifiedFacts` counts citations to `factIds` whose `verification.status === "verified"` in the manifest
- `DebateProposeInput` interface includes a new `manifestSection?: string` field (additive, optional)
- `DebateRunner.runPanelOneShot()` and `runner-plan.ts` pass `preDebatePhaseResult.manifestSection` (when present) into the `DebateProposeInput.manifestSection` field of every proposer call
- When `stageConfig.proposers?.citationsRequired === true`, `DebatePromptBuilder.proposeSlot(i)` includes a "Citations required" section that instructs the proposer to cite a `factId` for every concrete claim or tag it as design intent
- When `stageConfig.proposers?.citationsRequired === undefined` or `false`, `proposeSlot()` does NOT include the citation section (output is byte-equivalent to current behavior)
- When `stageConfig.proposers?.fileReadAccess === true`, `PlanPromptBuilder.build()` produces a `taskContext` that does NOT contain the substring `"file names and structure only"` and DOES contain an instruction permitting file-read tools
- When `stageConfig.proposers?.fileReadAccess === undefined` or `false`, `PlanPromptBuilder.build()` output is byte-equivalent to current behavior (still contains the "file names and structure only" instruction)
- When `stageConfig.proposers?.fileReadBudget === 10`, the file-read instruction includes the substring `"up to 10 file reads"`

### US-003: `grounder` pre-phase strategy + `verifier-pick` selector with patch

- `grounderStrategy` registered in `pre-phase/registry.ts` such that `resolvePreDebatePhase("grounder")` returns the strategy function
- `grounderStrategy(ctx)` returns `{ manifestSection: "", costUsd: 0 }` when `ctx.specContent` is undefined or empty
- `grounderStrategy(ctx)` invokes `callOp(ctx.ctx, groundOp, { specContent, codebaseContext, workdir })` exactly once when `ctx.specContent` is non-empty (no `agent` or `model` fields on the input — model resolution is `groundOp`'s responsibility via `ctx.config.grounder.model`)
- `grounderStrategy(ctx)` writes the manifest to `.nax/runs/<runId>/plan/<storyId>/facts-manifest.json` after a successful `groundOp` call
- `grounderStrategy` does NOT read `ctx.stageConfig.preDebatePhase.model` or `ctx.stageConfig.preDebatePhase.agent` (those fields do not exist on per-stage `preDebatePhase` in this design — model lives on top-level `DebateConfig.grounder.model` and is read by the op)
- `verifierPickSelector` registered in `selectors/registry.ts` such that `resolveSelector("verifier-pick")` returns the strategy function
- `verifierPickSelector(ctx)` returns `SelectorResult` where `outcome === "passed"` and `output === ctx.proposals[winnerIndex].output` when `winnerIndex` is the index of the proposal with the highest combined score
- `verifierPickSelector(ctx)` ranks proposals by `citationRate * 0.4 + citationDistributionScore * 0.3 + failureModesCovered * 0.15 + contextFilesValidRate * 0.15` (or any consistent linear combination documented in the strategy file)
- When `ctx.stageConfig.selector.patch?.enabled === true` and AC overlap between top-2 proposals is below `overlapThreshold` (default 0.8 when omitted), `verifierPickSelector` invokes the patch step exactly once and returns `SelectorResult` where `output` is the `PatchResult.output` string
- When AC overlap is above or equal to `overlapThreshold`, `verifierPickSelector` skips the patch step and returns the un-patched winner's output
- When `ctx.stageConfig.selector.patch?.enabled === false` (or undefined), patch step is never invoked regardless of overlap
- When the patch step throws and `patch.onFailure === "use-unpatched"` (default), `verifierPickSelector` returns the un-patched winner's output and logs a warning with `storyId`
- When the patch step throws and `patch.onFailure === "block"`, `verifierPickSelector` returns `SelectorResult` where `outcome === "failed"`
- `runPatchStep` invokes `ctx.agentManager.runAsSession(winner.proposal.agentName, winner.proposal.handle, prompt, { storyId, pipelineStage: "plan" })` exactly once and returns a `PatchResult` with the result's `output` string and `estimatedCostUsd`

### US-004: `plan-checklist` verifier + `spec-deltas.md` formatter

- `planChecklistVerifier` registered in `verifiers/registry.ts` such that `resolvePostDebateVerifier("plan-checklist")` returns the strategy function
- `planChecklistVerifier(ctx)` returns `outcome === "failed"` when `ctx.selectorResult.output` cannot be parsed as a valid PRD
- `planChecklistVerifier(ctx)` returns at least one `finding` with `severity === "blocker"` and `checklistItem === "files-exist"` when any `contextFiles` path in the PRD does not exist on disk under `ctx.workdir`
- `planChecklistVerifier(ctx)` returns at least one `finding` with `severity === "major"` and `checklistItem === "ac-anchored"` for every acceptance criterion that has neither `verifiedBy` nor `intent: true`
- `planChecklistVerifier(ctx)` returns at least one `finding` with `severity === "blocker"` and `checklistItem === "no-contradictions"` for any PRD claim that references a `factId` whose `verification.status === "contradicted"` in the facts manifest
- `planChecklistVerifier(ctx)` returns `outcome === "failed"` when any finding has `severity === "blocker"`; returns `outcome === "passed"` otherwise
- `formatSpecDeltas(blockers, manifest)` exported from `src/plan/spec-deltas.ts` returns a markdown string containing a section `"## Contradicted spec claims"` for every contradicted spec claim in the manifest
- `formatSpecDeltas` returns a markdown string containing a section `"## Unverified spec claims (factual, not intent)"` for every spec claim with `verification.status === "unverified"` and `kind === "factual"`
- `formatSpecDeltas` returns a markdown string containing a section `"## Spec gaps surfaced by codebase"` for every gap in the manifest
- When `planChecklistVerifier` produces blockers, the verifier writes the spec-deltas markdown to `.nax/runs/<runId>/plan/<storyId>/spec-deltas.md` and includes the file path in its returned `output` field
- When `planChecklistVerifier` produces blockers and `ctx.stageConfig.postDebateVerifier.onBlocker === "block"` (default when omitted), the verifier returns `outcome === "failed"` and `runner-plan.ts` propagates the failure to the `DebateResult`
- When `planChecklistVerifier` produces blockers and `ctx.stageConfig.postDebateVerifier.onBlocker === "tag-expert"`, the verifier returns `outcome === "passed"` (allows the run to proceed) but flags the result so downstream wiring sets every story's `routing.complexity = "expert"` in the resulting PRD

### US-005: `evidenceMode` preset + `src/cli/plan.ts` wiring

- When `stageConfig.evidenceMode === "asymmetric"` and no plug-point fields are user-set, `buildPlanComposition()` returns a `DebateStageConfig` where `preDebatePhase.kind === "grounder"`, `proposers.citationsRequired === true`, `proposers.fileReadAccess === true`, `proposers.fileReadBudget === 10`, `sessionMode === "stateful"`, `selector.kind === "verifier-pick"` with `patch.enabled === true`, and `postDebateVerifier.kind === "plan-checklist"`
- When `stageConfig.evidenceMode === "current"`, `buildPlanComposition()` returns the input `stageConfig` unchanged (no plug-point fields injected)
- When `stageConfig.evidenceMode === "asymmetric"` AND user explicitly sets `selector: { kind: "synthesis" }`, the returned composition has `selector.kind === "synthesis"` (user override wins)
- When `stageConfig.evidenceMode === "asymmetric"` AND user explicitly sets `preDebatePhase: { kind: "custom" }`, the returned composition has `preDebatePhase.kind === "custom"` (user override wins)
- `src/cli/plan.ts` invokes `buildPlanComposition()` before constructing `DebateStageConfig` for `createDebateRunner()` so the composition is applied at runner instantiation time
- When `grounderStrategy` throws during pre-phase invocation and `stageConfig.preDebatePhase.onFailure === "degrade"` (default when omitted), `runner-plan.ts` proceeds with `manifestSection: ""`, logs a warning containing `storyId` and the grounder error message, and continues to the proposer phase
- When `grounderStrategy` throws and `stageConfig.preDebatePhase.onFailure === "block"`, `runner-plan.ts` returns a `DebateResult` with `outcome === "failed"` and does not invoke any subsequent strategies
