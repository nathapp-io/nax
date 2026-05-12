# SPEC: Plan Asymmetric Pipeline

## Summary

Add a third `nax plan` orchestration mode — `pipeline` — that runs `ground → draft → critic` as three sequential `callOp` invocations, bypassing the debate runner entirely. The pipeline reuses the existing grounder, facts manifest, citation parser, and mechanical checklist that enhanced-debate Phase 2 shipped, but replaces the N-debater synthesis resolver with a single citation-validating drafter and a closed-checklist critic. Behavior change is gated by `config.plan.mode = "pipeline"`; defaults preserve today's `debate` / `single` selection bit-for-bit. Proposal background: [`docs/specs/2026-05-10-plan-asymmetric-pipeline.md`](./2026-05-10-plan-asymmetric-pipeline.md).

## Motivation

Enhanced-debate Phase 2 added the grounder and a `verifier-pick` selector that ranks proposals by citation rate, but the structural failure persists: N debaters consume the manifest in parallel, then a synthesis resolver merges them with LLM judgment. The manifest's grounding gets diluted by convergence pressure — same-model proposers agree on the same hallucinations the manifest flagged. The gap analysis in [`docs/reports/enhanced-debate-phase-2-gap-analysis.md`](../reports/enhanced-debate-phase-2-gap-analysis.md) confirms the grounder runs correctly end-to-end but does not measurably improve final PRD quality.

The pipeline addresses this by removing the N-proposer fan-out entirely. One drafter consumes the manifest, emits a citation-bearing PRD; one critic runs the mechanical checklist plus targeted LLM judgment on AC testability. The drafter's `parse()` rejects outputs whose PRD-claim citation rate falls below threshold — wiring [`src/debate/citations.ts`](../../src/debate/citations.ts), which currently has no caller. The critic's closed checklist cannot drift into agreement: it isn't proposing alternatives, it's checking against rules.

Pipeline mode is opt-in. Users on `debate` continue to get debate-asymmetric composition; users on `single` continue to get today's single-call planner. Pipeline is a third orchestration shape behind a config flag for safe rollout and measurement.

## Design

### Config schema

Add three fields to the existing `PlanConfigSchema` in [`src/config/schemas-infra.ts`](../../src/config/schemas-infra.ts) (the schema lives there, not in `schemas.ts`). Pipeline is **not** a debate variant — it bypasses the debate runner — so the selector lives at `config.plan`, not under `config.debate.stages.plan`.

```typescript
// src/config/schemas-infra.ts — PlanConfigSchema (additive)
export const PlanConfigSchema = z.object({
  model: ConfiguredModelSchema,                                  // existing
  outputPath: z.string().min(1, "plan.outputPath must be non-empty"),  // existing
  timeoutSeconds: z.number().int().positive().default(600),     // existing
  decomposeTimeoutSeconds: z.number().int().min(30).max(1_800).optional(),  // existing

  // NEW in this spec:
  mode: z.enum(["single", "debate", "pipeline"]).optional(),
  citationThreshold: z.number().min(0).max(1).default(0.5),     // pipeline-mode drafter gate
  criticModel: ConfiguredModelSchema.default("fast"),           // pipeline-mode LLM critic model
});
```

`.optional()` on `mode` — the resolution order derives the mode at runtime so backward compatibility holds. `criticModel` defaults to `"fast"` (matches the grounder's `fast`-tier choice; the critic is a structured-extraction task, not a creative draft) and the drafter model defaults to `"fast"` via the resolver below; both can be overridden by the user.

The existing `planConfigSelector` and `PlanConfig` type alias in [`src/config/selectors.ts:24,117`](../../src/config/selectors.ts) already select the right slice (`plan` + `debate`); the new fields automatically appear on `PlanConfig` once the schema is extended.

### Resolution order

`src/cli/plan.ts` selects the orchestration mode using this precedence:

```typescript
function resolvePlanMode(config: NaxConfig): "single" | "debate" | "pipeline" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  if (config?.debate?.enabled && config?.debate?.stages?.plan?.enabled) return "debate";
  return "single";
}
```

When `plan.mode === "pipeline"` and `debate.enabled === true`, emit a one-time warning at startup (`storyId: undefined, mode: "pipeline", debateEnabled: true`) and pipeline wins. The user has likely configured both paths by mistake.

### Pipeline orchestration

`src/cli/plan.ts` adds a third branch alongside the existing `debateEnabled ? debate : single` dispatch:

```typescript
const mode = resolvePlanMode(config);
if (mode === "pipeline") {
  return runPlanPipeline(workdir, config, options);
} else if (mode === "debate") {
  /* existing debate branch */
} else {
  /* existing single branch */
}
```

`runPlanPipeline` sequences three ops via `callOp`:

```typescript
async function runPlanPipeline(workdir, config, options) {
  const rt = createPlanRuntime(config, workdir, options.feature);
  try {
    // Phase 1 — ground
    const manifest = await callOp(callCtx, groundOp, { specContent, codebaseContext, workdir });

    // Phase 2 — draft (citation-gated parse)
    const prd = await callOp(callCtx, planDraftOp, {
      manifestSection: renderManifestSection(manifest),
      manifest,
      specContent,
      codebaseContext,
      feature: options.feature,
      branchName,
      citationThreshold: config.plan?.citationThreshold ?? 0.5,
    });

    // Phase 3 — critic (mechanical checks + LLM judgment + one revision round)
    const verdict = await runPlanCritic({ prd, manifest, workdir, runId: rt.runId, storyId, config, callCtx });
    if (verdict.outcome === "failed") {
      throw new NaxError(`Plan rejected by critic: see ${verdict.specDeltasPath}`, "PLAN_CRITIC_BLOCKED", {
        stage: "plan", storyId, specDeltasPath: verdict.specDeltasPath,
      });
    }
    await Bun.write(outputPath, JSON.stringify(verdict.prd, null, 2));
    return outputPath;
  } finally {
    await rt.close().catch(() => {});
  }
}
```

The pipeline runs per-feature (single-story dispatch, matching debate behavior). `storyId` for run-scoped artifacts is the feature name — same convention `plan-checklist.ts` already uses.

### `planDraftOp` (new)

A `RunOperation` whose `parse()` runs `validatePlanOutput` then `validateDraftCitations`. On citation-rate failure, returns `ParseValidationError` and the strategy retries with a stricter prompt; on exhaustion, `exhaustedFallback` returns the parsed PRD with an `advisory` tag so the critic can still review it.

```typescript
// src/operations/plan-draft.ts
import type { FactsManifest } from "../debate/facts-manifest";
import type { PRD } from "../prd/types";

export interface PlanDraftInput {
  readonly manifestSection: string;
  readonly manifest: FactsManifest;
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly feature: string;
  readonly branchName: string;
  readonly citationThreshold: number;
  /** Optional: critic blockers from a prior round. When set, the builder appends a
   *  "Previous draft rejected for these issues" section. Used by `runPlanCritic`
   *  for the one-round revision pass. */
  readonly revisionFindings?: readonly VerifierFinding[];
}

export interface PlanDraftOutput {
  readonly prd: PRD;
  readonly citationRate: number;
  readonly advisory: boolean;     // true when citation gate exhausted but PRD is structurally valid
}

/** Last-resort fallback for the retry strategy. Mirrors the FAIL_OPEN pattern in
 *  semantic-review.ts. Returned only when both the citation gate fails AND
 *  `validatePlanOutput` cannot extract a structurally valid PRD from `lastOutput`. */
const FAIL_OPEN_DRAFT: PlanDraftOutput = {
  prd: { feature: "", project: "", branchName: "", createdAt: "", updatedAt: "", userStories: [] },
  citationRate: 0,
  advisory: true,
};

export const planDraftOp: RunOperation<PlanDraftInput, PlanDraftOutput, PlanConfig> = {
  kind: "run",
  name: "plan-draft",
  stage: "plan",
  session: { role: "plan", lifetime: "fresh" },
  noFallback: true,
  config: planConfigSelector,
  // planConfigSelector slices `plan` + `debate` only (no `routing`); fall back to "fast" tier
  // not "balanced" — drafter is structured extraction, matches grounder's tier choice.
  model: (_input, ctx) => ctx.config.plan?.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.timeoutSeconds ?? 600) * 1000,
  retry: createDraftRetryStrategy(),    // see "Retry strategy" below
  build(input, _ctx) {
    return new PlanPromptBuilder().buildDraft(input);
  },
  parse(output, input, _ctx) {
    return parsePlanDraft(output, input);   // see helper below — distinguishes the three failure kinds
  },
};
```

### `validateDraftCitations` helper (new, wires `citations.ts`)

```typescript
// src/plan/draft-citations.ts
import type { FactsManifest } from "../debate/facts-manifest";
import { extractClaims, citationRate } from "../debate/citations";

export interface DraftCitationResult {
  readonly ok: boolean;
  readonly rate: number;
  readonly threshold: number;
  readonly uncitedCount: number;
}

export function validateDraftCitations(
  output: string,
  _manifest: FactsManifest,
  threshold: number,
): DraftCitationResult {
  const claims = extractClaims(output);
  const rate = citationRate(claims);
  const uncitedCount = claims.filter((c) => !c.cited).length;
  return { ok: rate >= threshold, rate, threshold, uncitedCount };
}
```

The `_manifest` parameter is reserved for a future enhancement (rejecting citations to non-existent `factId`s); current implementation only measures rate.

### Tiered parse retry helper (shared)

Three ops in this spec all need the same retry shape: a multi-tier inspector that diagnoses *which* parse stage failed, a per-kind repair prompt, and a kind-aware exhaustion fallback. [`groundOp`](../../src/operations/ground.ts) introduced the pattern (`inspectGrounderOutput` + `createGrounderRetryStrategy` + per-kind `buildGrounderRetryPrompt`); `planDraftOp` and `planCriticLlmOp` need it next. `makeParseRetryStrategy` ([`src/agents/retry/parse-retry.ts`](../../src/agents/retry/parse-retry.ts)) only models two prompts (`invalid` / `truncated`), so it doesn't fit.

Land the shared abstraction at `src/agents/retry/tiered-parse-retry.ts`:

```typescript
// src/agents/retry/tiered-parse-retry.ts
import { ParseValidationError } from "./errors";
import { looksLikeTruncatedJson } from "@/review/truncation";
import { getSafeLogger } from "@/logger";
import type { RetryStrategy } from "./types";

export interface TieredInspection<TKind extends string, TPartial = unknown> {
  readonly ok: boolean;
  readonly kind?: TKind;
  readonly message?: string;
  /** Partially-parsed value the inspector recovered (e.g. valid PRD with low citation rate). */
  readonly partial?: TPartial;
}

export interface TieredParseRetryOpts<TOutput, TKind extends string, TPartial = unknown> {
  /** Tag for log lines — e.g. "plan-draft", "plan-critic-llm", "grounder". */
  readonly reviewerKind: string;
  /** Inclusive cap. `maxAttempts: 2` means one retry, then exhaust. */
  readonly maxAttempts: number;
  /** Run the inspector on `lastOutput` to produce the kind + partial value.
   *  Output-only signature matches the existing `inspectGrounderOutput` pattern;
   *  `RetryContext` does not carry the op's input (see [retry/types.ts:9-16](../../src/agents/retry/types.ts)),
   *  so the inspector cannot read per-call config. Diagnostic classification that
   *  depends on a config threshold uses the schema default; the op's `parse()`
   *  still enforces the configured threshold authoritatively. */
  readonly inspect: (output: string) => TieredInspection<TKind, TPartial>;
  /** Build the next-turn prompt from the inspection. Receives `isTruncated` so prompts
   *  can mention truncation when the output appears clipped. */
  readonly buildRetryPrompt: (inspection: TieredInspection<TKind, TPartial>, isTruncated: boolean) => string;
  /** Compute the op's output value when retries are exhausted. The inspection from the
   *  final attempt is passed so the fallback can prefer a structurally-valid partial
   *  result over a hard FAIL_OPEN. */
  readonly exhaustedFallback: (inspection: TieredInspection<TKind, TPartial>, lastOutput: string) => TOutput;
}

export function makeTieredParseRetryStrategy<TOutput, TKind extends string, TPartial = unknown>(
  opts: TieredParseRetryOpts<TOutput, TKind, TPartial>,
): RetryStrategy {
  return {
    shouldRetry(failure, attempt, ctx) {
      if (!(failure instanceof ParseValidationError)) return { retry: false };
      if (!ctx.lastOutput) return { retry: false };
      const inspection = opts.inspect(ctx.lastOutput);

      // Exhaustion: caller decides the fallback value from the partial inspection.
      if (attempt >= opts.maxAttempts - 1) {
        return { retry: false, fallback: opts.exhaustedFallback(inspection, ctx.lastOutput) };
      }

      const isTruncated = looksLikeTruncatedJson(ctx.lastOutput);
      getSafeLogger()?.warn(opts.reviewerKind, `Parse retry — ${inspection.kind ?? "unknown"}`, {
        storyId: ctx.storyId,
        kind: inspection.kind,
        isTruncated,
        originalByteSize: ctx.lastOutput.length,
      });
      return { retry: true, delayMs: 0, nextPrompt: opts.buildRetryPrompt(inspection, isTruncated) };
    },
  };
}
```

This is purely additive — `groundOp` can migrate to the helper in a follow-up (out of scope here; the existing implementation already works correctly). Both new ops in this spec consume the helper directly.

**Import paths verified against the codebase** (US-003 must import from these locations):
- `ParseValidationError` from `src/agents/retry/types.ts:46` (re-exported via `src/agents/retry/index.ts` and `src/agents/index.ts`)
- `RetryStrategy`, `RetryContext`, `RetryDecision` from `src/agents/retry/types.ts:5-38`
- `looksLikeTruncatedJson` from `src/review/truncation.ts:23`
- `getSafeLogger` from `src/logger/logger.ts:303` (barrel: `src/logger/index.ts:9`)

### Parse + retry strategy (drafter)

The drafter has **three** failure kinds the retry prompt must distinguish. With the tiered helper above, the op definition stays small:

```typescript
// src/operations/plan-draft.ts
type DraftFailureKind = "not-json" | "prd-invalid" | "citation-low";

interface DraftInspection extends TieredInspection<DraftFailureKind, PRD> {
  // `partial: PRD` is inherited from TieredInspection — populated when JSON + PRD shape parse OK.
  readonly citationRate?: number; // populated when citation gate ran
}

/** Output-only inspector (matches the `inspect: (output) => ...` contract of `makeTieredParseRetryStrategy`).
 *  Uses the schema-default citation threshold (`DEFAULT_CITATION_THRESHOLD = 0.5`) for kind classification.
 *  The op's `parse()` enforces the configured threshold authoritatively; this inspector exists only to
 *  choose the right repair prompt during retry. */
const DEFAULT_CITATION_THRESHOLD = 0.5;

function inspectDraftOutput(output: string): DraftInspection {
  // Tier 1: JSON validity (using parseLLMJson — the SSOT per forbidden-patterns.md)
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    return { ok: false, kind: "not-json", message: "Response was not valid JSON or could not be extracted from the response." };
  }

  // Tier 2: PRD schema validity (feature/branch passed empty — they only fill missing top-level fields,
  // they do not affect validity).
  let prd: PRD;
  try {
    prd = validatePlanOutput(raw, "", "");
  } catch (err) {
    return { ok: false, kind: "prd-invalid", message: `Response was valid JSON but failed PRD validation: ${errorMessage(err)}` };
  }

  // Tier 3: citation gate (against default threshold for diagnostic only)
  const claims = extractClaims(output);
  const rate = citationRate(claims);
  if (rate < DEFAULT_CITATION_THRESHOLD) {
    const uncited = claims.filter((c) => !c.cited).length;
    return { ok: false, kind: "citation-low", message: `Citation rate ${rate.toFixed(2)} below default ${DEFAULT_CITATION_THRESHOLD} (${uncited} uncited claims).`, partial: prd, citationRate: rate };
  }

  return { ok: true, partial: prd, citationRate: rate };
}

/** Authoritative parse — runs the configured threshold check (from input.citationThreshold). */
function parsePlanDraft(output: string, input: PlanDraftInput): PlanDraftOutput {
  // First reuse the output-only inspector for tiers 1 and 2.
  const inspection = inspectDraftOutput(output);
  if (inspection.kind === "not-json" || inspection.kind === "prd-invalid") {
    throw new ParseValidationError(inspection.message ?? "Plan draft validation failed");
  }
  // Tier 3 with the configured threshold (may differ from DEFAULT_CITATION_THRESHOLD).
  const citation = validateDraftCitations(output, input.manifest, input.citationThreshold);
  if (!citation.ok) {
    throw new ParseValidationError(
      `Citation rate ${citation.rate.toFixed(2)} below threshold ${input.citationThreshold} (${citation.uncitedCount} uncited claims).`,
    );
  }
  return { prd: inspection.partial!, citationRate: citation.rate, advisory: false };
}

function buildDraftRetryPrompt(inspection: DraftInspection, isTruncated: boolean): string {
  // Three distinct prompts — same SSOT pattern as GrounderPromptBuilder.jsonRepair
  switch (inspection.kind) {
    case "not-json":     return PlanDraftPromptBuilder.jsonRepair(isTruncated, inspection.message);
    case "prd-invalid":  return PlanDraftPromptBuilder.schemaRepair(inspection.message);
    case "citation-low": return PlanDraftPromptBuilder.citationRepair(inspection.message);
    default:             return PlanDraftPromptBuilder.jsonRepair(false, "Re-emit the complete PRD JSON.");
  }
}

function createDraftRetryStrategy() {
  return makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>({
    reviewerKind: "plan-draft",
    maxAttempts: 2,           // one retry, then exhaust
    inspect: inspectDraftOutput,
    buildRetryPrompt: buildDraftRetryPrompt,
    exhaustedFallback: (inspection) => inspection.partial
      ? { prd: inspection.partial, citationRate: inspection.citationRate ?? 0, advisory: true }
      : FAIL_OPEN_DRAFT,
  });
}
```

The strategy delegates `inspect` (the diagnostic) and `buildRetryPrompt` (the repair) to the op-specific functions; everything else — the `ParseValidationError` discrimination, the `looksLikeTruncatedJson` check, the structured warn-log with `storyId` + `kind`, the exhaustion gate — lives in the helper and stays consistent across ops.

Why this fixes the grounder issue mentioned in review: `inspectDraftOutput` runs the same multi-tier check on both the success path (via `parse()`) and the retry path (via the strategy). When zod schema validation fails, the inspector returns `kind: "prd-invalid"` and the retry prompt is built from `PlanDraftPromptBuilder.schemaRepair(message)` — not the generic "not valid JSON" prompt the old grounder retry used. Each kind gets its targeted repair.

Per [`retry-strategy.md`](../../.claude/rules/retry-strategy.md), a run-kind op with a strict throwing `parse()` MUST declare an escape hatch. The strategy's `{ retry: false, fallback }` decisions cover both exhaustion outcomes:
- If `lastOutput` parses to a valid PRD but failed only the citation gate → return the PRD with `advisory: true` (lets the critic see it; the critic's `claims-cited` finding will surface the citation gap).
- If `lastOutput` cannot produce any valid PRD → return `FAIL_OPEN_DRAFT` and let the critic's mechanical checks fail the run gracefully.

`PlanDraftPromptBuilder` is a new class on the existing `PlanPromptBuilder` module (or a sibling) that owns the three repair prompts plus `buildDraft`; all prompt assembly stays under `src/prompts/builders/` per the Prompt Builder Convention.

### Refactor: extract pure checks from `plan-checklist.ts`

The five mechanical check functions in [`src/debate/verifiers/plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts) are currently nested inside `planChecklistVerifier`, which has `PostDebateVerifier` shape (reads `selectorResult.output`, `stageConfig`). Extract them into a library so both paths call the same code.

```typescript
// src/debate/verifiers/checks.ts (NEW)
import type { PRD } from "@/prd/types";
import type { VerifierFinding } from "@/plan/spec-deltas";
import type { FactsManifest } from "../facts-manifest";

export interface CheckDeps {
  existsSync: (path: string) => boolean;
}

export function checkFilesExist(prd: PRD, workdir: string, deps?: CheckDeps): VerifierFinding[];
export function checkAcAnchored(prd: PRD): VerifierFinding[];
export function checkClaimsCited(manifest: FactsManifest | null, threshold: number): VerifierFinding[];
export function checkNoContradictions(prd: PRD, manifest: FactsManifest | null): VerifierFinding[];
export function checkSpecCoverage(manifest: FactsManifest | null): VerifierFinding[];
```

`plan-checklist.ts` becomes a thin adapter that imports from `checks.ts` and adapts to the debate `PostDebateVerifier` contract. Pipeline mode imports from `checks.ts` directly. No semantic change to debate behavior.

### `planCriticLlmOp` (new)

A `RunOperation` that runs LLM judgment on the two gaps the mechanical checklist does NOT cover: per-AC testability and failure-modes coverage. Called only after mechanical checks pass — if mechanical checks already produced blockers, the pipeline emits `spec-deltas.md` and aborts without invoking the LLM critic.

**Why run-kind, not complete-kind:** every other single-turn LLM op in the codebase is run-kind ([`groundOp`](../../src/operations/ground.ts), [`planInteractiveOp`](../../src/operations/plan.ts), [`semanticReviewOp`](../../src/operations/semantic-review.ts), [`adversarialReviewOp`](../../src/operations/adversarial-review.ts)). Run-kind's exhaustion semantics also fit better: when retry exhausts, `callOp` returns the strategy's `fallback` value directly. Complete-kind throws `CALL_OP_MAX_RETRIES` at the ceiling regardless of strategy ([retry-strategy.md](../../.claude/rules/retry-strategy.md) §"`callOp` is bounded by `MAX_COMPLETE_RETRY_ATTEMPTS`"). The critic must fail open on parse exhaustion — run-kind makes that the natural path.

```typescript
// src/operations/plan-critic-llm.ts
export interface PlanCriticLlmInput {
  readonly prd: PRD;
  readonly manifest: FactsManifest;
}

export interface PlanCriticLlmOutput {
  readonly findings: VerifierFinding[];      // checklistItem: "ac-testable" | "failure-modes-considered"
}

type CriticFailureKind = "not-json" | "schema-invalid";

interface CriticInspection {
  readonly ok: boolean;
  readonly kind?: CriticFailureKind;
  readonly message?: string;
  readonly findings?: VerifierFinding[];
}

function inspectCriticOutput(output: string): CriticInspection {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);   // SSOT — never bare JSON.parse per forbidden-patterns.md
  } catch {
    return { ok: false, kind: "not-json", message: "Response was not valid JSON or could not be extracted." };
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { findings?: unknown }).findings)) {
    return { ok: false, kind: "schema-invalid", message: "Response was valid JSON but did not have a `findings` array at the root." };
  }
  // Per-finding validation — entries with bad severity / missing checklistItem are dropped silently
  // (the critic is advisory; we keep the well-formed findings rather than blocking on a single bad entry).
  const findings = ((raw as { findings: unknown[] }).findings).filter(isValidVerifierFinding);
  return { ok: true, findings };
}

export const planCriticLlmOp: RunOperation<PlanCriticLlmInput, PlanCriticLlmOutput, PlanConfig> = {
  kind: "run",
  name: "plan-critic-llm",
  stage: "plan",
  session: { role: "plan-critic", lifetime: "fresh" },
  noFallback: true,                              // critic is its own quality gate; no agent-fallback chain
  config: planConfigSelector,
  // planConfigSelector slices `plan` + `debate` only (no `routing`); criticModel defaults to "fast"
  // via the schema, so this resolver simply reads it.
  model: (_input, ctx) => ctx.config.plan?.criticModel ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.timeoutSeconds ?? 600) * 1000,
  build(input, _ctx) { return new CriticPromptBuilder().build(input.prd, input.manifest); },   // RunOperation.build returns string
  parse(output, _input, _ctx) {
    const inspection = inspectCriticOutput(output);
    if (!inspection.ok) throw new ParseValidationError(inspection.message ?? "critic output invalid");
    return { findings: inspection.findings ?? [] };
  },
  retry: makeTieredParseRetryStrategy<PlanCriticLlmOutput, CriticFailureKind, VerifierFinding[]>({
    reviewerKind: "plan-critic-llm",
    maxAttempts: 2,
    inspect: inspectCriticOutput,
    buildRetryPrompt: buildCriticRetryPrompt,
    exhaustedFallback: () => ({ findings: [] }),   // fail-open per Failure Handling §
  }),
};

function buildCriticRetryPrompt(inspection: CriticInspection, isTruncated: boolean): string {
  switch (inspection.kind) {
    case "not-json":       return CriticPromptBuilder.jsonRepair(isTruncated, inspection.message);
    case "schema-invalid": return CriticPromptBuilder.schemaRepair(inspection.message);
    default:               return CriticPromptBuilder.jsonRepair(false, "Re-emit JSON of shape `{ findings: [...] }`.");
  }
}
```

Same diagnostic discipline as `planDraftOp`, same helper, no duplication: only `inspectCriticOutput` and `buildCriticRetryPrompt` are op-specific. The internal re-parser uses `parseLLMJson` (the SSOT) — bare `JSON.parse(output)` on LLM output is forbidden per [`forbidden-patterns.md`](../../.claude/rules/forbidden-patterns.md) because it silently fails on fence-wrapped, preamble-padded, or trailing-comma responses.

**Session role registration:** `"plan-critic"` is a new canonical role and must be added to `KNOWN_SESSION_ROLES` in [`src/runtime/session-role.ts`](../../src/runtime/session-role.ts) (same pattern Phase 2 used to add `"grounder"`). `planDraftOp.session.role = "plan"` reuses the role already used by the legacy single-mode planner [`src/operations/plan.ts:26`](../../src/operations/plan.ts) — no new registration needed for the drafter.

### `CriticPromptBuilder` (new)

```typescript
// src/prompts/builders/critic-builder.ts
export class CriticPromptBuilder {
  build(prd: PRD, manifest: FactsManifest): string {
    // Returns a prompt that asks the LLM to audit:
    // 1. For each AC, is the assertion observable (file/symbol/test reference)? Emit "ac-testable" findings.
    // 2. For each story, is there at least one negative-path AC? Emit "failure-modes-considered" findings.
    // Output: JSON { findings: [{ checklistItem, severity, message, storyId }] }
  }
}
```

Prompts live under `src/prompts/builders/` per [`forbidden-patterns.md`](../../.claude/rules/forbidden-patterns.md) Prompt Builder Convention.

### Critic orchestration + revision loop

`runPlanCritic` (a helper in `src/plan/critic.ts`, NOT an op — it orchestrates ops + pure functions):

```typescript
// src/plan/critic.ts
export interface PlanCriticInput {
  readonly prd: PRD;
  readonly manifest: FactsManifest;
  readonly workdir: string;
  readonly runId: string;
  readonly storyId: string;
  readonly config: NaxConfig;
  readonly callCtx: CallContext;
  readonly draftCtx: PlanDraftInput;         // for one-round revision
}

export interface PlanCriticVerdict {
  readonly outcome: "passed" | "failed";
  readonly prd: PRD;
  readonly findings: VerifierFinding[];
  readonly specDeltasPath?: string;
}

export async function runPlanCritic(input: PlanCriticInput): Promise<PlanCriticVerdict> {
  // 1. Run mechanical checks (extracted functions from US-002)
  const threshold = input.config.plan?.citationThreshold ?? 0.5;
  const mechFindings = [
    ...checkFilesExist(input.prd, input.workdir),
    ...checkAcAnchored(input.prd),
    ...checkClaimsCited(input.manifest, threshold),
    ...checkNoContradictions(input.prd, input.manifest),
    ...checkSpecCoverage(input.manifest),
  ];

  // 2. Mechanical blockers → emit spec-deltas, abort (no LLM call)
  const mechBlockers = mechFindings.filter((f) => f.severity === "blocker");
  if (mechBlockers.length > 0) {
    const path = await emitSpecDeltas(input, mechBlockers);
    return { outcome: "failed", prd: input.prd, findings: mechFindings, specDeltasPath: path };
  }

  // 3. Run LLM judgment (ac-testable, failure-modes-considered)
  const llmResult = await callOp(input.callCtx, planCriticLlmOp, { prd: input.prd, manifest: input.manifest });
  const allFindings = [...mechFindings, ...llmResult.findings];

  // 4. Apply one-round revision if any blocker findings from LLM
  const allBlockers = allFindings.filter((f) => f.severity === "blocker");
  if (allBlockers.length === 0) return { outcome: "passed", prd: input.prd, findings: allFindings };

  // Revision: re-run draft op with findings appended as additional context
  const revisedDraft = await callOp(input.callCtx, planDraftOp, {
    ...input.draftCtx,
    revisionFindings: allBlockers,    // new optional field on PlanDraftInput
  });

  // Re-run mechanical checks on revision (LLM checks NOT re-run — one round budget)
  const revFindings = [
    ...checkFilesExist(revisedDraft.prd, input.workdir),
    ...checkAcAnchored(revisedDraft.prd),
    ...checkClaimsCited(input.manifest, threshold),
    ...checkNoContradictions(revisedDraft.prd, input.manifest),
    ...checkSpecCoverage(input.manifest),
  ];
  const revBlockers = revFindings.filter((f) => f.severity === "blocker");
  if (revBlockers.length === 0) return { outcome: "passed", prd: revisedDraft.prd, findings: revFindings };

  const path = await emitSpecDeltas(input, revBlockers);
  return { outcome: "failed", prd: revisedDraft.prd, findings: revFindings, specDeltasPath: path };
}
```

`emitSpecDeltas` reuses [`formatSpecDeltas`](../../src/plan/spec-deltas.ts) and writes to `.nax/runs/<runId>/plan/<storyId>/spec-deltas.md` — the same path `plan-checklist.ts` uses.

### Plan-builder split

`src/prompts/builders/plan-builder.ts` gains a `buildDraft(input: PlanDraftInput)` method that consumes the rendered manifest section instead of the codebase scan:

```typescript
export class PlanPromptBuilder {
  build(input: PlanInput): { prompt: string };               // existing — single mode
  buildDraft(input: PlanDraftInput): { prompt: string };     // NEW — pipeline mode draft
}
```

`buildDraft` includes:
- The spec content
- The rendered manifest (verified facts + spec claims + gaps)
- Citation requirement: "Every concrete claim referencing existing code must cite [F-NNN] or [S-NNN] from the manifest. Stories whose acceptance criteria describe new behavior set `intent: true` and are exempt."
- The existing PRD schema instructions
- If `input.revisionFindings` is set, a "Previous draft rejected for the following issues" section

### Integration

- **Existing types to extend:** `NaxConfig.plan` in [`src/config/schemas.ts`](../../src/config/schemas.ts) (add `mode`, `citationThreshold`).
- **Integration points:** [`src/cli/plan.ts`](../../src/cli/plan.ts) — add `resolvePlanMode()` and the third branch before the existing `debateEnabled` branch.
- **Existing patterns to follow:** [`src/operations/ground.ts`](../../src/operations/ground.ts) for run-kind op with retry + hopBody; [`src/operations/plan.ts`](../../src/operations/plan.ts) (legacy single-mode op) for Pattern A `model: (_input, ctx) => ctx.config…`; [`src/debate/verifiers/plan-checklist.ts`](../../src/debate/verifiers/plan-checklist.ts) for the check functions to extract; [`src/prompts/builders/grounder-builder.ts`](../../src/prompts/builders/grounder-builder.ts) for builder shape.
- **Reuses Phase 2 infrastructure:** `groundOp`, `FactsManifest`, `renderManifestSection`, `formatSpecDeltas`, `citations.ts`, PRD schema citation fields (`verifiedBy`, `intent`, `contextFiles[].factId`).

### Approach

Pipeline mode is a config-driven third orchestration shape. Default behavior (no `plan.mode`) is bit-for-bit unchanged. The only refactor is extracting the check functions out of `plan-checklist.ts` so both the debate verifier and the pipeline critic call the same code (no logic duplication). All LLM calls go through `callOp` (Layer 4 per [`adapter-wiring.md`](../../.claude/rules/adapter-wiring.md)); the critic orchestrator is a plain async function that composes ops and pure functions — it is NOT itself an op because it crosses op boundaries (mechanical → optional LLM → revision) that no single op shape captures.

Pipeline runs single-story per feature, matching `nax plan` semantics today. `storyId` in artifact paths is the feature name, matching the convention `plan-checklist.ts` already follows.

### Failure Handling

- **Grounder failure** — `groundOp` already has retry + manifest schema validation. If `groundOp` throws after exhaustion, the pipeline aborts with `NaxError` code `PLAN_PIPELINE_GROUND_FAILED` and surfaces the error. No fallback to single mode; user fixes the spec or switches modes manually.
- **Draft citation rate below threshold** — `planDraftOp.parse()` throws `ParseValidationError`; retry strategy re-prompts once. On exhaustion, `exhaustedFallback` returns the structurally valid PRD with `advisory: true`; pipeline proceeds to the critic (which can still flag uncited claims as `claims-cited` findings).
- **Mechanical critic blockers** — pipeline emits `spec-deltas.md` and aborts with `NaxError` code `PLAN_CRITIC_BLOCKED`. No LLM judgment is run. User addresses spec deltas and re-runs.
- **LLM critic blockers** — trigger one revision round via `planDraftOp` with `revisionFindings`. If the revision still has mechanical blockers, emit `spec-deltas.md` and abort. LLM critic does NOT re-run after revision (one-round budget).
- **LLM critic crash / parse failure** — fail-open: log warning, treat as zero LLM findings, proceed with mechanical findings only. The mechanical layer is authoritative; LLM judgment is advisory.
- **Revision exhaustion** — same as mechanical critic blockers: emit `spec-deltas.md`, abort with `PLAN_CRITIC_BLOCKED`.
- **`plan.mode = "pipeline"` + `debate.enabled = true`** — pipeline wins; one-time warning logged at startup. No error.

## Stories

1. **US-001: `config.plan.mode` schema + pipeline branch stub** — adds `plan.mode` and `plan.citationThreshold` to `NaxConfigSchema`; implements `resolvePlanMode()` in `src/cli/plan.ts` with the documented precedence; adds the third branch that throws `NaxError` code `PLAN_PIPELINE_NOT_IMPLEMENTED` so subsequent stories can land behind the flag without behavior change; emits the dual-mode warning when both `plan.mode === "pipeline"` and `debate.enabled === true`.
2. **US-002: Extract pure check functions + draft citation validator** — refactors `src/debate/verifiers/plan-checklist.ts` to export `checkFilesExist`, `checkAcAnchored`, `checkClaimsCited`, `checkNoContradictions`, `checkSpecCoverage` from a new `src/debate/verifiers/checks.ts` module; `planChecklistVerifier` becomes a thin adapter that calls them (debate behavior unchanged); implements `src/plan/draft-citations.ts` with `validateDraftCitations` wiring `extractClaims` + `citationRate` from `citations.ts`.
3. **US-003: `planDraftOp` + `PlanPromptBuilder.buildDraft` + `makeTieredParseRetryStrategy` helper** — lands the shared retry helper at `src/agents/retry/tiered-parse-retry.ts` (consumed by US-003 and US-004; future migration target for `groundOp`); implements the run-kind drafter op with `inspectDraftOutput`, three-kind diagnosis, and a `buildDraft` repair-prompt builder; adds `buildDraft(input)` to `PlanPromptBuilder` that consumes the rendered manifest and emits the citation-required instruction, plus three repair-prompt static methods (`jsonRepair`, `schemaRepair`, `citationRepair`); adds optional `revisionFindings` field on `PlanDraftInput` that appends a "previous draft rejected for these issues" section to the prompt when present.
4. **US-004: `planCriticLlmOp` + `CriticPromptBuilder` + `"plan-critic"` session role** — adds `"plan-critic"` to `KNOWN_SESSION_ROLES` / `CanonicalSessionRole` in `src/runtime/session-role.ts`; implements the **run-kind** LLM judgment op (matches `groundOp`/`semanticReviewOp` shape — every single-turn LLM op in the codebase is run-kind) for `ac-testable` and `failure-modes-considered` checks; implements `CriticPromptBuilder.build(prd, manifest)` returning the audit prompt; output schema is `{ findings: VerifierFinding[] }`; uses the same `inspect → kind → targeted repair prompt` retry pattern as `planDraftOp`; exhaustion fallback is `{ findings: [] }` (fail-open per Failure Handling §).
5. **US-005: `runPlanPipeline` orchestrator + `runPlanCritic` helper** — implements `src/plan/critic.ts::runPlanCritic` composing mechanical checks → optional LLM judgment → one-round revision; implements `runPlanPipeline` in `src/cli/plan.ts` sequencing `groundOp → planDraftOp → runPlanCritic`; writes final PRD to `.nax/features/<feature>/prd.json`; replaces the US-001 stub.

### Dependencies

- US-001: depends on nothing (foundation)
- US-002: depends on US-001 (lands behind the flag with no behavior change)
- US-003: depends on US-002 (uses `validateDraftCitations`)
- US-004: depends on US-001 (config slice for `plan.criticModel`)
- US-005: depends on US-002, US-003, US-004 (composes all of them)

### Context Files (per story)

**US-001:**
- `src/config/schemas-infra.ts:10-16` — `PlanConfigSchema` lives here; add `mode`, `citationThreshold`, `criticModel` fields. Do NOT edit `src/config/schemas.ts` (it only references the schema)
- `src/config/selectors.ts:24,117` — `planConfigSelector` and `PlanConfig` already exist; the new fields auto-propagate via `ReturnType` once the schema is extended
- `src/cli/plan.ts:140-160` — current `debateEnabled` branch; new `resolvePlanMode()` slots here
- `src/config/schemas-debate.ts` — reference for `debate.enabled` / `debate.stages.plan.enabled` shape
- `src/errors.ts` — `NaxError` constructor for `PLAN_PIPELINE_NOT_IMPLEMENTED`
- `test/unit/config/schemas.test.ts` (if exists) — schema parsing test patterns

**US-002:**
- `src/debate/verifiers/plan-checklist.ts` — file to refactor; move the five check functions out
- `src/debate/verifiers/types.ts` — `PostDebateVerifier` contract that `planChecklistVerifier` continues to satisfy
- `src/debate/citations.ts` — `extractClaims`, `citationRate` to wire into `validateDraftCitations`
- `src/debate/facts-manifest.ts` — `FactsManifest` type for `validateDraftCitations` signature
- `src/plan/spec-deltas.ts` — `VerifierFinding` type used by the check functions
- `test/unit/debate/verifiers/plan-checklist.test.ts` (if exists) — assert no behavior change

**US-003:**
- `src/operations/types.ts` — `RunOperation` shape
- `src/operations/ground.ts` — reference for retry + parse + hopBody pattern; closest existing run-op (the `inspectGrounderOutput` + per-kind repair pattern is the model)
- `src/agents/retry/parse-retry.ts` — existing `makeParseRetryStrategy` for reference (the new helper sits next to it)
- `src/agents/retry/index.ts` — barrel to export `makeTieredParseRetryStrategy` from
- `src/agents/retry/types.ts` — `RetryStrategy` + `ParseValidationError`
- `src/review/truncation.ts` — `looksLikeTruncatedJson` consumed by the helper
- `src/logger/index.ts` — `getSafeLogger` consumed by the helper for the structured warn log
- `src/prompts/builders/plan-builder.ts` — file to extend with `buildDraft` and three repair-prompt static methods
- `src/prompts/builders/grounder-builder.ts` — builder shape reference
- `src/plan/draft-citations.ts` — `validateDraftCitations` from US-002
- `src/prd/schema.ts` — `validatePlanOutput` for the parse step
- `src/config/selectors.ts:24,117` — `planConfigSelector` and `PlanConfig` already exist; just import

**US-004:**
- `src/operations/types.ts` — `RunOperation` shape (NOT `CompleteOperation` — see Design §"Why run-kind, not complete-kind")
- `src/operations/ground.ts` — closest reference: run-kind op with custom retry strategy that diagnoses multiple failure kinds via an `inspectXxx` helper. Mirror this pattern exactly
- `src/operations/semantic-review.ts` — second reference: run-kind op with `FAIL_OPEN` constant + fail-open `exhaustedFallback` equivalent
- `src/prompts/builders/grounder-builder.ts` — builder shape reference
- `src/utils/llm-json.ts` — `parseLLMJson` for strict parsing
- `src/agents/retry/parse-retry.ts` — `makeParseRetryStrategy` API
- `src/plan/spec-deltas.ts` — `VerifierFinding` shape for output
- `src/runtime/session-role.ts` — `KNOWN_SESSION_ROLES`/`CanonicalSessionRole` to extend with `"plan-critic"`
- `src/prd/types.ts` — `PRD` type for input shape
- `src/debate/facts-manifest.ts` — `FactsManifest` type for input shape

**US-005:**
- `src/cli/plan.ts:80-260` — full file to extend with `runPlanPipeline`
- `src/cli/plan-runtime.ts` — `createPlanRuntime` to reuse
- `src/operations/call.ts` — `callOp` invocation
- `src/operations/ground.ts` — `groundOp` to invoke
- `src/debate/verifiers/checks.ts` — extracted check functions (from US-002) to invoke directly
- `src/plan/spec-deltas.ts` — `formatSpecDeltas` for artifact emission
- `src/debate/facts-manifest.ts` — `renderManifestSection` for the draft prompt
- `src/errors.ts` — `NaxError` for `PLAN_CRITIC_BLOCKED`, `PLAN_PIPELINE_GROUND_FAILED`

## Acceptance Criteria

### US-001: `config.plan.mode` schema + pipeline branch stub

- `NaxConfigSchema.parse({ plan: { mode } })` returns `result.plan.mode === mode` for each of `mode ∈ { "single", "debate", "pipeline" }`
- `NaxConfigSchema.parse({ plan: { mode: "unknown" } })` and `NaxConfigSchema.parse({ plan: { citationThreshold: 1.5 } })` each throw a `ZodError`
- `NaxConfigSchema.parse({ plan: {} })` returns `{ mode: undefined, citationThreshold: 0.5, criticModel: "fast" }` (`mode` has no default; threshold and criticModel apply schema defaults)
- `NaxConfigSchema.parse({ plan: { citationThreshold: 0.7, criticModel: "balanced" } })` returns those values verbatim (user overrides preserved)
- `resolvePlanMode({ plan: { mode: "pipeline" } })` returns `"pipeline"`
- `resolvePlanMode({ plan: { mode: "single" }, debate: { enabled: true, stages: { plan: { enabled: true } } } })` returns `"single"` (explicit `plan.mode` wins over `debate.enabled`)
- `resolvePlanMode({ debate: { enabled: true, stages: { plan: { enabled: true } } } })` returns `"debate"` (legacy precedence preserved)
- `resolvePlanMode({})` returns `"single"`
- `resolvePlanMode({ debate: { enabled: true, stages: { plan: { enabled: false } } } })` returns `"single"` (both `debate.enabled` and `stages.plan.enabled` required for `"debate"`)
- When `resolvePlanMode()` returns `"pipeline"`, `planCommand()` throws `NaxError` with `code === "PLAN_PIPELINE_NOT_IMPLEMENTED"` and `context.stage === "plan"` (replaced by US-005 implementation)
- When `resolvePlanMode()` returns `"pipeline"` AND `config.debate?.enabled === true`, `planCommand()` calls `logger.warn("plan", ...)` exactly once with `{ mode: "pipeline", debateEnabled: true }` before throwing the not-implemented error

### US-002: Extract pure check functions + draft citation validator

- `src/debate/verifiers/checks.ts` exports `checkFilesExist`, `checkAcAnchored`, `checkClaimsCited`, `checkNoContradictions`, `checkSpecCoverage` as named functions
- `checkFilesExist(prd, workdir, { existsSync: () => false })` returns one `VerifierFinding` per `contextFiles` entry with `severity === "blocker"` and `checklistItem === "files-exist"`
- `checkAcAnchored(prdWithNoVerifiedByAndIntentFalse)` returns one finding with `severity === "major"` and `checklistItem === "ac-anchored"` per story
- `checkClaimsCited(null, 0.5)` returns `[]` when manifest is null
- `checkClaimsCited({ specClaims: [verified, verified, unverified], ... }, 0.5)` returns `[]` because rate `0.666 >= 0.5`
- `checkClaimsCited({ specClaims: [verified, unverified, unverified], ... }, 0.5)` returns one finding because rate `0.333 < 0.5`
- `checkNoContradictions(prd, manifest)` returns a finding with `severity === "blocker"` for each PRD `contextFiles[].factId` that references a manifest `specClaim` with `verification.status === "contradicted"`
- `checkSpecCoverage(manifest)` returns one finding per `specClaims` entry where `kind === "factual"` AND `verification.status === "unverified"`
- `planChecklistVerifier(ctx)` invokes the five exported check functions and produces findings that are deep-equal to those produced before the refactor when given the same `prd` and `manifest` (no behavior change for debate path)
- `validateDraftCitations(output, manifest, 0.5)` exported from `src/plan/draft-citations.ts` returns `{ ok: true, rate, threshold: 0.5, uncitedCount }` when `citationRate(extractClaims(output)) >= 0.5`
- `validateDraftCitations(output, manifest, 0.5)` returns `{ ok: false, ... }` when citation rate is below threshold
- `validateDraftCitations("", manifest, 0.5)` returns `{ ok: false, rate: 0, threshold: 0.5, uncitedCount: 0 }` (empty input)

### US-003: `planDraftOp` + `PlanPromptBuilder.buildDraft` + `makeTieredParseRetryStrategy` helper

**Tiered parse retry helper (consumed by US-003 and US-004):**

- `makeTieredParseRetryStrategy` exported from `src/agents/retry/tiered-parse-retry.ts` (and re-exported from `src/agents/retry/index.ts`) returns a `RetryStrategy` whose `shouldRetry` returns `{ retry: false }` when `failure` is not a `ParseValidationError` OR `ctx.lastOutput` is missing (the strategy is output-only — `RetryContext` does not carry the op's input)
- When `shouldRetry(parseValidationError, attempt < maxAttempts - 1, ctx)` fires, the strategy calls `opts.inspect(ctx.lastOutput)` exactly once, then `opts.buildRetryPrompt(inspection, isTruncated)` exactly once, then `getSafeLogger()?.warn(opts.reviewerKind, "Parse retry — <kind>", { storyId, kind, isTruncated, originalByteSize })` exactly once, then returns `{ retry: true, delayMs: 0, nextPrompt: <buildRetryPrompt result> }`
- When `shouldRetry(parseValidationError, attempt >= maxAttempts - 1, ctx)` fires, the strategy returns `{ retry: false, fallback: <opts.exhaustedFallback(inspection, lastOutput) result> }` (exhaustion gate is idempotent past the threshold — multiple invocations all return fallback)

**Drafter op:**

- `planDraftOp` exported from `src/operations/plan-draft.ts` has `kind === "run"`, `name === "plan-draft"`, `stage === "plan"`, `session.role === "plan"`, `session.lifetime === "fresh"`, `noFallback === true`
- `planDraftOp.build({ manifestSection, ..., revisionFindings: undefined })` returns a prompt string containing the substring `manifestSection` AND `"intent"` (design-intent exemption) AND NOT containing `"Previous draft rejected"`; when called with `revisionFindings: [{ checklistItem: "ac-testable", severity: "blocker", message }]`, the returned prompt DOES contain `"Previous draft rejected"` and the finding message
- `planDraftOp.model({}, { config: { plan: {} } })` returns `"fast"` (default tier — no `routing` reference); `planDraftOp.model({}, { config: { plan: { model: "balanced" } } })` returns `"balanced"`
- `planDraftOp.parse(output, input, ctx)` returns `{ prd, citationRate, advisory: false }` when output is structurally valid JSON, valid PRD, AND citation rate `>= input.citationThreshold`
- `inspectDraftOutput(output)` is output-only (no input parameter — matches the `RetryContext` shape) and returns each of the three failure shapes for the corresponding fixture: `"not json" → { ok: false, kind: "not-json" }`; `validJsonInvalidPrd → { ok: false, kind: "prd-invalid", message }` (message references the underlying `validatePlanOutput` error); `validPrdLowCitationDefault → { ok: false, kind: "citation-low", partial, citationRate }` (`partial` is the validated PRD, `citationRate < DEFAULT_CITATION_THRESHOLD = 0.5`)
- `planDraftOp.parse(fixture, input, ctx)` throws `ParseValidationError` for each of the three failure fixtures above; the configured `input.citationThreshold` (not the default) is what determines whether `parse()` throws for `citation-low` — and the message contains the substring `"citation rate"`
- `createDraftRetryStrategy()` returns the result of `makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>({ reviewerKind: "plan-draft", maxAttempts: 2, inspect: inspectDraftOutput, buildRetryPrompt: buildDraftRetryPrompt, exhaustedFallback })`
- `buildDraftRetryPrompt(inspection, isTruncated)` returns `PlanDraftPromptBuilder.jsonRepair(isTruncated, message)` when `kind === "not-json"`; `PlanDraftPromptBuilder.schemaRepair(message)` when `kind === "prd-invalid"`; `PlanDraftPromptBuilder.citationRepair(message)` when `kind === "citation-low"`
- The `exhaustedFallback` callback returns `{ prd: inspection.partial, citationRate: inspection.citationRate ?? 0, advisory: true }` when `inspection.partial` is populated; returns `FAIL_OPEN_DRAFT` when `inspection.partial` is undefined

### US-004: `planCriticLlmOp` + `CriticPromptBuilder`

- `KNOWN_SESSION_ROLES` exported from `src/runtime/session-role.ts` includes `"plan-critic"` as a `CanonicalSessionRole` member
- `planCriticLlmOp` exported from `src/operations/plan-critic-llm.ts` has `kind === "run"`, `name === "plan-critic-llm"`, `stage === "plan"`, `session.role === "plan-critic"`, `noFallback === true`
- `planCriticLlmOp.build({ prd, manifest }, _ctx)` returns a non-empty `string` (RunOperation contract — not the `{ prompt }` shape used by CompleteOperation)
- `planCriticLlmOp.model({}, { config: { plan: {} } })` returns `"fast"` (schema default); `planCriticLlmOp.model({}, { config: { plan: { criticModel: "balanced" } } })` returns `"balanced"`
- `inspectCriticOutput` returns `{ ok: true, findings }` for valid input shapes, including markdown-fenced JSON (`'```json\n{"findings":[]}\n```'` parses successfully — verifies `parseLLMJson` is used; bare `JSON.parse` would have thrown here)
- `inspectCriticOutput("not json")` returns `{ ok: false, kind: "not-json" }`; `inspectCriticOutput('{"other":"x"}')` returns `{ ok: false, kind: "schema-invalid" }`
- `planCriticLlmOp.parse('{"findings":[]}', _, _)` returns `{ findings: [] }`; `planCriticLlmOp.parse(fixture, _, _)` throws `ParseValidationError` for `fixture ∈ { "not json", '{"other":"x"}' }`
- `planCriticLlmOp.retry` is the value returned by `makeTieredParseRetryStrategy({ reviewerKind: "plan-critic-llm", maxAttempts: 2, inspect: inspectCriticOutput, buildRetryPrompt: buildCriticRetryPrompt, exhaustedFallback: () => ({ findings: [] }) })`
- `buildCriticRetryPrompt(inspection, isTruncated)` returns `CriticPromptBuilder.jsonRepair(isTruncated, message)` when `kind === "not-json"`; returns `CriticPromptBuilder.schemaRepair(message)` when `kind === "schema-invalid"`
- `new CriticPromptBuilder().build(prd, manifest)` returns a string containing the substrings `"ac-testable"`, `"failure-modes-considered"` (closed checklist), AND the literal `prd.feature` value

### US-005: `runPlanPipeline` orchestrator + `runPlanCritic` helper

- `runPlanCritic(input)` exported from `src/plan/critic.ts` returns `{ outcome: "failed", prd, findings, specDeltasPath }` when mechanical checks produce at least one `severity === "blocker"` finding; the returned `specDeltasPath` points to `.nax/runs/<runId>/plan/<storyId>/spec-deltas.md` and the file has been written at that path
- When mechanical checks produce blockers, `runPlanCritic` does NOT invoke `planCriticLlmOp` (verified by spy / mock — the LLM op is called zero times)
- When mechanical checks pass and `planCriticLlmOp` returns zero blockers, `runPlanCritic` returns `{ outcome: "passed", prd: input.prd, findings: [...mechFindings, ...llmFindings] }` with no `specDeltasPath`
- When mechanical checks pass and `planCriticLlmOp` returns at least one `severity === "blocker"` finding, `runPlanCritic` invokes `callOp(callCtx, planDraftOp, { ...draftCtx, revisionFindings })` exactly once with the blockers passed as `revisionFindings`
- After the revision draft passes mechanical checks, `runPlanCritic` returns `{ outcome: "passed", prd: revisedDraft.prd, ... }`
- After the revision draft still has mechanical blockers, `runPlanCritic` returns `{ outcome: "failed", prd: revisedDraft.prd, ..., specDeltasPath }` and does NOT re-invoke `planCriticLlmOp`
- When `planCriticLlmOp` throws (LLM failure), `runPlanCritic` logs a warning with `storyId` and proceeds as if zero LLM findings were produced (fail-open)
- `runPlanPipeline(workdir, config, options)` exported from `src/cli/plan.ts` calls `callOp(callCtx, groundOp, ...)` exactly once before any other op
- `runPlanPipeline` calls `callOp(callCtx, planDraftOp, ...)` with `manifest` set to the result of the `groundOp` call and `citationThreshold` set to `config.plan?.citationThreshold ?? 0.5`
- `runPlanPipeline` calls `runPlanCritic` after `planDraftOp` returns
- When `runPlanCritic` returns `outcome === "passed"`, `runPlanPipeline` writes the verdict's `prd` to `.nax/features/<feature>/prd.json` and returns that path
- When `runPlanCritic` returns `outcome === "failed"`, `runPlanPipeline` throws `NaxError` with `code === "PLAN_CRITIC_BLOCKED"` and `context.specDeltasPath` equal to the verdict's `specDeltasPath`
- When `groundOp` throws, `runPlanPipeline` propagates the error wrapped as `NaxError` with `code === "PLAN_PIPELINE_GROUND_FAILED"` and `context.cause` set to the original error
- `runPlanPipeline` closes its `createPlanRuntime` runtime via `rt.close()` in a `finally` block regardless of success or failure
- After US-005 lands, `planCommand()` with `resolvePlanMode() === "pipeline"` no longer throws `PLAN_PIPELINE_NOT_IMPLEMENTED` — it returns the path written by `runPlanPipeline`
