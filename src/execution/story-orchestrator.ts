import { NaxError } from "../errors";
import type { Finding, FixCycle, FixCycleContext, FixStrategy, Iteration } from "../findings";
import { runFixCycle } from "../findings";
import { getSafeLogger } from "../logger";
import {
  adversarialReviewOp,
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  lintCheckOp,
  semanticReviewOp,
  testWriterOp,
  typecheckCheckOp,
  verifierOp,
  verifyScopedOp,
} from "../operations";
import type {
  CallContext,
  DeterministicOperation,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  LintCheckInput,
  Operation,
  RunOperation,
  SemanticReviewInput,
  TestWriterInput,
  TypecheckCheckInput,
  VerifierInput,
  VerifyScopedInput,
} from "../operations";
import type { AdversarialReviewInput } from "../operations";
import { callOp } from "../operations/call";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";

export const _storyOrchestratorDeps = {
  callOp,
  runFixCycle,
  captureGitRef,
};

/**
 * Greenfield-gate has inverse semantics: it "passes" when pre-existing tests
 * are found (= NOT greenfield, proceed normally) and "fails" when no tests are
 * found (= greenfield, pause TDD). The generic "Phase passed/failed: X" wording
 * reads as the opposite of what greenfield-gate actually decided, so we override
 * the message text for that phase only.
 *
 * Exported for unit testing — pure function over (opName, success).
 */
export function formatPhaseResultMessage(opName: string, success: boolean): string {
  if (opName === "greenfield-gate") {
    return success
      ? "Greenfield-gate: pre-existing tests detected (not greenfield) — proceeding with normal TDD"
      : "Greenfield-gate: no pre-existing tests — greenfield run, pausing TDD test-writer";
  }
  return success ? `Phase passed: ${opName}` : `Phase failed: ${opName}`;
}

const TDD_OP_NAMES = new Set<string>(["test-writer", "implementer", "verifier"]);
const STRICT_VERDICT_PHASE_NAMES = new Set<string>([
  fullSuiteGateOp.name,
  verifyScopedOp.name,
  lintCheckOp.name,
  typecheckCheckOp.name,
  verifierOp.name,
]);

export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}

export interface RectificationPhaseOptions {
  readonly maxAttempts: number;
  // biome-ignore lint/suspicious/noExplicitAny: rectification strategies are heterogeneous over their fixOp input/output
  readonly strategies: FixStrategy<Finding, any, any, any>[];
  readonly abortOnIncreasingFailures: boolean;
  /** Optional: transform findings after validate() returns, before next iteration's strategy selection. */
  readonly postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
  readonly rectificationExhausted?: boolean;
  readonly unfixedFindings?: readonly Finding[];
}

type PhaseKind =
  | "test-writer"
  | "greenfield-gate"
  | "implementer"
  | "full-suite-gate"
  | "verifier"
  | "verify-scoped"
  | "lint-check"
  | "typecheck-check"
  | "semantic-review"
  | "adversarial-review";

type DroppedFindingSummary = {
  code?: string;
  severity?: string;
  file?: string;
  line?: number;
  issue?: string;
  acIndex?: number;
};

type ReviewDecisionPayload =
  | {
      reviewer: "semantic" | "adversarial";
      parsed: true;
      passed: boolean;
      result: { passed: boolean; findings: unknown[] };
      acDropped?: DroppedFindingSummary[];
    }
  | {
      reviewer: "semantic" | "adversarial";
      parsed: false;
      passed?: boolean;
      failOpen?: boolean;
      looksLikeFail?: boolean;
      result: null;
    };
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot list is intentionally erased internally
type AnySlot = { op: RunOperation<any, any, any> | DeterministicOperation<any, any, any>; input: unknown };

interface InternalPhase {
  readonly kind: PhaseKind;
  readonly slot: AnySlot;
}

interface InternalBuildState {
  implementer?: InternalPhase;
  testWriter?: InternalPhase;
  greenfieldGate?: InternalPhase;
  fullSuiteGate?: InternalPhase;
  verifier?: InternalPhase;
  verifyScoped?: InternalPhase;
  lintCheck?: InternalPhase;
  typecheckCheck?: InternalPhase;
  semanticReview?: InternalPhase;
  adversarialReview?: InternalPhase;
  rectification?: RectificationPhaseOptions;
}

const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "full-suite-gate",
  "verifier",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "semantic-review",
  "adversarial-review",
];

function isSlot<I, O, C>(value: unknown): value is OrchestratorSlot<I, O, C> {
  return (
    value !== null &&
    typeof value === "object" &&
    "op" in value &&
    "input" in value &&
    typeof (value as { op?: { kind?: string } }).op?.kind === "string"
  );
}

const PHASE_KIND_TO_STATE_KEY: Record<PhaseKind, keyof InternalBuildState> = {
  "test-writer": "testWriter",
  "greenfield-gate": "greenfieldGate",
  implementer: "implementer",
  "full-suite-gate": "fullSuiteGate",
  verifier: "verifier",
  "verify-scoped": "verifyScoped",
  "lint-check": "lintCheck",
  "typecheck-check": "typecheckCheck",
  "semantic-review": "semanticReview",
  "adversarial-review": "adversarialReview",
};

function setPhase(state: InternalBuildState, kind: PhaseKind, slot: AnySlot): void {
  const key = PHASE_KIND_TO_STATE_KEY[kind];
  if (state[key] !== undefined) {
    throw new NaxError(
      `StoryOrchestratorBuilder: addX was called twice for phase "${kind}"`,
      "ORCHESTRATOR_PHASE_DUPLICATE",
      { stage: "execution", kind },
    );
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot widened intentionally
  (state as any)[key] = { kind, slot };
}

function collectOrderedPhases(state: InternalBuildState): InternalPhase[] {
  return CANONICAL_ORDER.flatMap((kind) => {
    if (kind === "test-writer" && state.testWriter) return [state.testWriter];
    if (kind === "greenfield-gate" && state.greenfieldGate) return [state.greenfieldGate];
    if (kind === "implementer" && state.implementer) return [state.implementer];
    if (kind === "full-suite-gate" && state.fullSuiteGate) return [state.fullSuiteGate];
    if (kind === "verifier" && state.verifier) return [state.verifier];
    if (kind === "verify-scoped" && state.verifyScoped) return [state.verifyScoped];
    if (kind === "lint-check" && state.lintCheck) return [state.lintCheck];
    if (kind === "typecheck-check" && state.typecheckCheck) return [state.typecheckCheck];
    if (kind === "semantic-review" && state.semanticReview) return [state.semanticReview];
    if (kind === "adversarial-review" && state.adversarialReview) return [state.adversarialReview];
    return [];
  });
}
/**
 * Stricter variant of `phasePassed` for SSOT carve-out logic. Where `phasePassed`
 * defensively treats missing/undefined/non-object outputs as "passed" (to avoid
 * fail-closing on ops that don't conform to the envelope), this requires an
 * affirmative `success === true` or `passed === true`. SSOT semantics ("verifier
 * judged this OK") must not trigger off a malformed envelope.
 */
function phaseExplicitlyPassed(output: unknown): boolean {
  if (output === null || output === undefined || typeof output !== "object") return false;
  const r = output as Record<string, unknown>;
  return r.success === true || r.passed === true;
}

function phasePassed(opName: string, output: unknown, storyId?: string): boolean {
  const strictVerdictPhase = STRICT_VERDICT_PHASE_NAMES.has(opName);
  if (output === null || output === undefined) {
    getSafeLogger()?.warn(
      "story-orchestrator",
      strictVerdictPhase
        ? "Strict phase produced no output — treating as fail"
        : "Phase produced no output — treating as pass",
      {
        storyId,
        phase: opName,
      },
    );
    return !strictVerdictPhase;
  }
  if (typeof output !== "object") {
    if (!strictVerdictPhase) return true;
    getSafeLogger()?.warn("story-orchestrator", "Strict phase produced non-object output — treating as fail", {
      storyId,
      phase: opName,
    });
    return false;
  }
  const r = output as Record<string, unknown>;
  if ("success" in r) return r.success !== false;
  if ("passed" in r) return r.passed !== false;
  getSafeLogger()?.warn(
    "story-orchestrator",
    strictVerdictPhase
      ? "Strict phase output has neither 'success' nor 'passed' — treating as fail"
      : "Phase output has neither 'success' nor 'passed' — treating as pass",
    {
      storyId,
      phase: opName,
    },
  );
  return !strictVerdictPhase;
}

/**
 * Extract structured Findings from a phase output. Ops that produce LLM-shape findings
 * (semanticReviewOp / adversarialReviewOp) expose a `normalizedFindings: Finding[]`
 * field with `source` already tagged — strategies' `appliesTo` gates on `source`, so
 * the un-tagged raw `findings` must NEVER reach the rectification cycle (issue: when
 * the cast lied, `source` was undefined and every strategy was filtered out, producing
 * "no matching strategy" exits despite real blocking findings). We prefer
 * `normalizedFindings` when present and fall back to `findings` for ops whose envelope
 * already speaks the `Finding` wire format (verifierOp etc.).
 */
function isFinding(value: unknown): value is Finding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { source?: unknown }).source === "string" &&
    (value as { source: string }).source.length > 0
  );
}

function extractPhaseFindings(output: unknown): Finding[] {
  if (output === null || output === undefined || typeof output !== "object") {
    return [];
  }
  const record = output as Record<string, unknown>;
  const rawArray = Array.isArray(record.normalizedFindings)
    ? record.normalizedFindings
    : Array.isArray(record.findings)
      ? record.findings
      : [];
  // Runtime guard: strip anything that isn't a source-tagged Finding. Strategies'
  // `appliesTo` predicates gate on `f.source` — entries without it cannot be
  // routed and previously caused the cycle to exit with "no matching strategy".
  const findings = rawArray.filter(isFinding);
  const success =
    "success" in record ? record.success === true : "passed" in record ? record.passed === true : findings.length === 0;
  return success ? [] : findings;
}

/**
 * Verifier-as-SSOT: when the verifier explicitly passed, full-suite-gate
 * failures represent unrelated regressions that this story did not cause.
 * Excluded from rectification (mirrors the carve-out in ExecutionPlan.run
 * success aggregation and post-run.ts:deriveFailureCategory).
 */
function shouldSkipPhaseForRectification(
  phase: InternalPhase,
  state: InternalBuildState,
  phaseOutputs: Record<string, unknown>,
): boolean {
  if (phase.kind !== "full-suite-gate") return false;
  const verifierName = state.verifier?.slot.op.name;
  if (!verifierName) return false;
  return phaseExplicitlyPassed(phaseOutputs[verifierName]);
}

function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  phases: readonly InternalPhase[],
  state: InternalBuildState,
): Finding[] {
  const findings: Finding[] = [];
  for (const phase of phases) {
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
  }
  return findings;
}

/**
 * Collect all phases that participate in the rectification validation sweep.
 * Verifier is included here because phasesToRevalidate() now allows it to be
 * re-dispatched when a code-editing strategy (full-suite-rectify, autofix-implementer,
 * autofix-test-writer) ran. Without this, a stale verifier failure from before
 * rectification would remain in phaseOutputs and mark the story failed even after
 * the gate goes green. shouldSkipPhaseForRectification() gates the gate phase
 * when verifier already explicitly passed (unrelated-regression case).
 */
function collectRectificationPhases(state: InternalBuildState): InternalPhase[] {
  return [
    state.fullSuiteGate,
    state.verifier,
    state.verifyScoped,
    state.lintCheck,
    state.typecheckCheck,
    state.semanticReview,
    state.adversarialReview,
  ].filter((phase): phase is InternalPhase => phase !== undefined);
}

const STRATEGY_TO_REVALIDATION_PHASES: Record<string, readonly PhaseKind[]> = {
  // Mechanical fixes are AST-preserving (import-sort, formatting, unused-var removal).
  // They cannot introduce semantic regressions, so only lint-check needs re-running.
  // If a mechanical fix strategy ever edits logic (not just style), widen this set.
  "mechanical-lintfix": ["lint-check"],
  "mechanical-formatfix": ["lint-check"],
  // Code-editing strategies may change behaviour — verifier re-judges the TDD verdict.
  "autofix-implementer": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verifier",
    "verify-scoped",
    "semantic-review",
    "adversarial-review",
  ],
  "autofix-test-writer": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verifier",
    "verify-scoped",
    "adversarial-review",
  ],
  "full-suite-rectify": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verifier",
    "verify-scoped",
    "semantic-review",
  ],
};

/**
 * Determine which phases to re-run after a fix iteration.
 *
 * The verifier IS eligible for revalidation when a strategy mapped to include
 * it ran (e.g. full-suite-rectify, autofix-implementer). Before this fix,
 * verifier was hard-stripped — leaving a stale failure verdict in phaseOutputs
 * after rectification fixed the underlying gate failure.
 *
 * Falls back to all phases when:
 * - strategiesRun is undefined/empty (conservative default)
 * - any strategy name is unknown to the mapping (plugin-supplied strategy)
 *
 * Exported for unit testing — pure function over (strategiesRun, allPhases).
 */
export function phasesToRevalidate(
  strategiesRun: readonly string[] | undefined,
  allPhases: readonly InternalPhase[],
): readonly InternalPhase[] {
  if (!strategiesRun || strategiesRun.length === 0) return allPhases;

  const unknown = strategiesRun.some((name) => STRATEGY_TO_REVALIDATION_PHASES[name] === undefined);
  if (unknown) return allPhases;

  const needed = new Set<PhaseKind>();
  for (const name of strategiesRun) {
    for (const kind of STRATEGY_TO_REVALIDATION_PHASES[name] ?? []) {
      needed.add(kind);
    }
  }
  return allPhases.filter((p) => needed.has(p.kind));
}

function toReviewDecisionPayload(opName: string, output: unknown): ReviewDecisionPayload | null {
  if (output === null || output === undefined || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;

  const reviewer = opName === "semantic-review" ? "semantic" : opName === "adversarial-review" ? "adversarial" : null;
  if (!reviewer) return null;

  if (record.failOpen === true) {
    return { reviewer, parsed: false, passed: true, failOpen: true, result: null };
  }
  if (record.looksLikeFail === true) {
    return { reviewer, parsed: false, passed: false, looksLikeFail: true, result: null };
  }

  if (typeof record.passed !== "boolean" || !Array.isArray(record.findings)) {
    return null;
  }

  const acDropped = Array.isArray(record.acDropped)
    ? (record.acDropped as unknown[]).map((d): DroppedFindingSummary => {
        const entry = (d ?? {}) as Record<string, unknown>;
        const finding = (entry.finding ?? {}) as Record<string, unknown>;
        return {
          code: typeof entry.code === "string" ? entry.code : undefined,
          severity: typeof finding.severity === "string" ? finding.severity : undefined,
          file: typeof finding.file === "string" ? finding.file : undefined,
          line: typeof finding.line === "number" ? finding.line : undefined,
          issue: typeof finding.issue === "string" ? finding.issue : undefined,
          acIndex: typeof finding.acIndex === "number" ? finding.acIndex : undefined,
        };
      })
    : undefined;

  return {
    reviewer,
    parsed: true,
    passed: record.passed,
    result: { passed: record.passed, findings: record.findings },
    acDropped,
  };
}

function emitReviewDecision(ctx: CallContext, opName: string, output: unknown): void {
  const payload = toReviewDecisionPayload(opName, output);
  if (!payload) return;

  ctx.runtime.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    runId: ctx.runtime.runId,
    reviewer: payload.reviewer,
    workdir: ctx.packageDir,
    projectDir: ctx.runtime.projectDir,
    outputDir: ctx.runtime.outputDir,
    storyId: ctx.storyId,
    featureName: ctx.featureName,
    timestamp: Date.now(),
    parsed: payload.parsed,
    looksLikeFail: payload.parsed ? undefined : payload.looksLikeFail,
    failOpen: payload.parsed ? false : payload.failOpen,
    passed: payload.passed,
    result: payload.result,
  });
}

function logUnifiedReviewPhaseStart(storyId: string | undefined, opName: string): void {
  const logger = getSafeLogger();
  if (opName === "semantic-review") {
    logger?.info("review", "Running semantic check", { storyId });
  } else if (opName === "adversarial-review") {
    logger?.info("review", "Running adversarial check", { storyId });
  }
}

/**
 * Generic phase outcome log for deterministic / verify / mechanical ops
 * (verify-scoped, full-suite-gate, lint-check, typecheck-check, etc.).
 *
 * TDD phases and review phases have their own dedicated loggers — skip those here
 * so a single phase doesn't produce duplicate outcome lines.
 */
function logDeterministicPhaseOutcome(
  storyId: string | undefined,
  opName: string,
  output: unknown,
  durationMs: number,
  isTddPhase: boolean,
): void {
  if (isTddPhase) return;
  if (opName === "semantic-review" || opName === "adversarial-review") return;
  if (output === null || output === undefined || typeof output !== "object") return;

  const logger = getSafeLogger();
  const r = output as Record<string, unknown>;
  const success = r.success === true || r.passed === true;
  const findingsCount = Array.isArray(r.findings) ? r.findings.length : undefined;
  const status = typeof r.status === "string" ? r.status : undefined;

  const data: Record<string, unknown> = { storyId, phase: opName, durationMs };
  if (findingsCount !== undefined) data.findingsCount = findingsCount;
  if (status !== undefined) data.status = status;

  const message = formatPhaseResultMessage(opName, success);
  if (success) {
    logger?.info("story-orchestrator", message, data);
  } else {
    logger?.warn("story-orchestrator", message, data);
  }
}

function logUnifiedReviewPhaseResult(storyId: string | undefined, opName: string, output: unknown): void {
  const logger = getSafeLogger();
  const payload = toReviewDecisionPayload(opName, output);
  if (!payload) return;

  if (!payload.parsed) {
    if (payload.failOpen) {
      logger?.warn("review", `${payload.reviewer} review fail-open`, { storyId });
    } else if (payload.looksLikeFail) {
      logger?.warn("review", `${payload.reviewer} review returned truncated failure`, { storyId });
    }
    return;
  }

  const findingsCount = payload.result.findings.length;
  const title = payload.reviewer === "semantic" ? "Semantic review" : "Adversarial review";

  if (payload.passed) {
    logger?.info("review", `${title} passed`, { storyId });
    return;
  }

  // passed:false with empty findings = model emitted failure without grounding
  // any concern in an AC. Surface this explicitly — otherwise the warn line
  // ("0 findings") reads as a silent success.
  if (findingsCount === 0) {
    const dropped = payload.acDropped ?? [];
    const droppedSummary = dropped.slice(0, 5);
    logger?.warn(
      "review",
      `${title} failed: 0 findings — ${
        dropped.length > 0
          ? `${dropped.length} blocking finding(s) dropped as ungrounded by AC-grounding filter`
          : "model emitted passed:false but produced no findings (likely empty output)"
      }`,
      {
        storyId,
        findingsCount,
        reason: dropped.length > 0 ? "ac-grounding-drop" : "passed-false-no-findings",
        droppedCount: dropped.length || undefined,
        droppedFindings: droppedSummary.length > 0 ? droppedSummary : undefined,
        droppedTruncated: dropped.length > droppedSummary.length || undefined,
      },
    );
    return;
  }

  const findingsSummary = payload.result.findings.slice(0, 5).map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    return {
      severity: typeof r.severity === "string" ? r.severity : undefined,
      file: typeof r.file === "string" ? r.file : undefined,
      line: typeof r.line === "number" ? r.line : undefined,
      rule: typeof r.rule === "string" ? r.rule : undefined,
      issue: typeof r.issue === "string" ? r.issue : typeof r.message === "string" ? r.message : undefined,
      acIndex: typeof r.acIndex === "number" ? r.acIndex : undefined,
    };
  });
  logger?.warn("review", `${title} failed: ${findingsCount} findings`, {
    storyId,
    findingsCount,
    findings: findingsSummary,
    truncated: findingsCount > findingsSummary.length,
  });
}

async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  isThreeSession = false,
): Promise<unknown> {
  const logger = getSafeLogger();
  const opName = slot.op.name;
  // Isolation enforcement + TDD-stage logs only apply when the orchestrator is
  // executing a three-session-tdd strategy. The single-session ("no-test") path
  // reuses implementerOp but has no boundary semantics to enforce, so capturing
  // beforeRef and emitting "Session: implementer" / "Isolation maintained" there
  // would be misleading.
  const isTddPhase = isThreeSession && TDD_OP_NAMES.has(opName);

  // Pre-phase: capture git ref for TDD phases; emit phase-begin log.
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : undefined;
  const dispatchInput =
    isTddPhase && beforeRef ? { ...(slot.input as Record<string, unknown>), beforeRef } : slot.input;

  if (isTddPhase) {
    logger?.info("tdd", `-> Session: ${opName}`, { storyId: ctx.storyId, role: opName });
  } else if (isThreeSession && opName === "full-suite-gate") {
    logger?.info("tdd", "-> Running full test suite gate (before Verifier)", { storyId: ctx.storyId });
  }
  logUnifiedReviewPhaseStart(ctx.storyId, opName);

  const phaseStartedAt = Date.now();
  const scope = ctx.runtime.costAggregator.openScope();
  try {
    const output = await _storyOrchestratorDeps.callOp({ ...ctx, scopeId: scope.scopeId }, slot.op, dispatchInput);
    phaseOutputs[opName] = output;
    emitReviewDecision(ctx, opName, output);
    logUnifiedReviewPhaseResult(ctx.storyId, opName, output);
    logDeterministicPhaseOutcome(ctx.storyId, opName, output, Date.now() - phaseStartedAt, isTddPhase);

    // Post-phase logs (TDD phases only).
    if (isTddPhase) {
      const durationMs = Date.now() - phaseStartedAt;
      logger?.info("tdd", `Session complete: ${opName}`, {
        storyId: ctx.storyId,
        role: opName,
        durationMs,
      });

      const filesChanged = (output as { filesChanged?: readonly string[] })?.filesChanged ?? [];
      if (opName === "test-writer" && filesChanged.length > 0) {
        logger?.info("tdd", "Created test files", {
          storyId: ctx.storyId,
          testFilesCount: filesChanged.length,
          testFiles: [...filesChanged],
        });
      }

      const isolation = (output as { isolation?: { passed: boolean; violations: string[] } })?.isolation;
      if (isolation) {
        if (isolation.passed) {
          logger?.info("tdd", "Isolation maintained", { storyId: ctx.storyId, role: opName });
        } else {
          logger?.error("tdd", "Isolation violated", {
            storyId: ctx.storyId,
            role: opName,
            violations: isolation.violations,
          });
        }
      }
    }

    return output;
  } finally {
    phaseCosts[opName] = (phaseCosts[opName] ?? 0) + scope.snapshot().totalCostUsd;
    scope.close();
  }
}

/**
 * Wrap each strategy with a bailWhen predicate that fires when the last iteration's
 * findingsAfter count exceeds its findingsBefore count. Preserves user-supplied bailWhen
 * if present (user predicate wins). Returns the unchanged strategies when the option is off.
 */
function withIncreasingFailuresBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  return strategies.map((strategy) => ({
    ...strategy,
    bailWhen: (iterations: Iteration<Finding>[]): string | null => {
      const userReason = strategy.bailWhen?.(iterations) ?? null;
      if (userReason !== null) return userReason;
      const last = iterations[iterations.length - 1];
      if (last && last.findingsAfter.length > last.findingsBefore.length) {
        return `failure count increased: ${last.findingsBefore.length} -> ${last.findingsAfter.length}`;
      }
      return null;
    },
  }));
}

/**
 * Run the rectification loop via `runFixCycle` (findings/cycle.ts) — the SSOT for
 * strategy selection, per-strategy attempt caps, bail predicates, outcome
 * classification, and iteration record-keeping. Replaces the ported
 * `selectExecutionGroup` that previously lived here (silent-drift risk vs ADR-022).
 *
 * Per spec §2D:
 *  - Failures aggregate verifier + semantic + adversarial findings on entry (fed to
 *    runFixCycle as initial `cycle.findings`).
 *  - `cycle.validate` re-runs the verifier only — semantic/adversarial outputs are
 *    stale between iterations, so the validator returns verifier-only findings to
 *    drive termination math.
 *  - `abortOnIncreasingFailures` is expressed as a per-strategy `bailWhen` wrapper
 *    so runFixCycle exits with reason "bail-when" when failures regress.
 *  - Implementer warm-lifetime handle reuse is owned by callOp middleware via
 *    `implementerOp.session.lifetime === "warm"`; the orchestrator does not manage
 *    a separate SessionKeeper.
 *  - Each fix-op + verifier dispatch is wrapped in `runPhase` so per-phase cost and
 *    phaseOutputs stay coherent with the rest of the plan.
 */
interface RectificationResult {
  rectificationExhausted?: boolean;
  unfixedFindings?: readonly Finding[];
}

async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<RectificationResult> {
  const rectification = state.rectification;
  const validationPhases = collectRectificationPhases(state);
  if (!rectification || validationPhases.length === 0) {
    return {};
  }
  if (ctx.runtime.signal?.aborted) {
    return {};
  }

  const initialFindings = gatherRectificationFindings(phaseOutputs, validationPhases, state);
  if (initialFindings.length === 0) {
    return {};
  }
  if (!ctx.storyId) {
    // runFixCycle requires storyId for parallel-log correlation.
    return {};
  }

  // Separate map for fix-op outputs so intermediate implementer results don't contaminate
  // the final phaseOutputs success aggregation. The validate callback continues to write
  // gate/verifier re-run results into phaseOutputs so they ARE reflected in the final success.
  const fixOpPhaseOutputs: Record<string, unknown> = {};
  const wrappedCallOp = async <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    // runFixCycle dispatches fixOps, which are Operation<I,O,C> (run or complete). The
    // builder's runPhase wrapper only needs op.name + dispatch, so widening the cast is safe.
    const slot: AnySlot = { op: op as unknown as RunOperation<unknown, unknown, unknown>, input };
    return (await runPhase(cycleCtx, slot, phaseCosts, fixOpPhaseOutputs)) as O;
  };

  const cycle: FixCycle<Finding> = {
    findings: [...initialFindings],
    iterations: [],
    strategies: withIncreasingFailuresBail(
      rectification.strategies as FixStrategy<Finding, unknown, unknown, unknown>[],
      rectification.abortOnIncreasingFailures,
    ),
    config: { maxAttemptsTotal: rectification.maxAttempts, validatorRetries: 1 },
    validate: async (_validateCtx, opts) => {
      if (ctx.runtime.signal?.aborted) return [];
      // opts is required by the FixCycle.validate contract but guard defensively for
      // plugin-supplied cycles that may call validate without opts (legacy shape).
      const lite = (opts?.mode ?? "full") === "lite";
      const phases = phasesToRevalidate(opts?.strategiesRun, validationPhases);
      getSafeLogger()?.debug("story-orchestrator", "rectification validate scope", {
        storyId: ctx.storyId,
        mode: opts?.mode ?? "full",
        strategiesRun: opts?.strategiesRun,
        phasesSelected: phases.map((p) => p.kind),
      });
      const findings: Finding[] = [];
      for (const phase of phases) {
        if (lite && phase.kind === "full-suite-gate") {
          continue;
        }
        await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
        if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
        findings.push(...extractPhaseFindings(phaseOutputs[phase.slot.op.name]));
      }
      return rectification.postValidate ? await rectification.postValidate(findings, _validateCtx) : findings;
    },
  };

  const cycleResult = await _storyOrchestratorDeps.runFixCycle(
    cycle,
    ctx as FixCycleContext,
    "story-orchestrator-rectification",
    { callOp: wrappedCallOp },
  );

  phaseOutputs.rectification = {
    success: cycleResult.exitReason === "resolved",
    iterationCount: cycleResult.iterations.length,
    exitReason: cycleResult.exitReason,
    finalFindingsCount: cycleResult.finalFindings.length,
  };

  // Rectification cycle summary — one line so the JSONL records what happened
  // (entry findings, iterations run, unfixed findings, exit reason, total cost).
  const rectLogger = getSafeLogger();
  const rectSummary = {
    storyId: ctx.storyId,
    initialFindingsCount: initialFindings.length,
    iterationCount: cycleResult.iterations.length,
    finalFindingsCount: cycleResult.finalFindings.length,
    exitReason: cycleResult.exitReason,
    costUsd: cycleResult.costUsd,
  };
  if (cycleResult.exitReason === "resolved") {
    rectLogger?.info("story-orchestrator", "Rectification resolved all findings", rectSummary);
  } else {
    rectLogger?.warn("story-orchestrator", `Rectification exited: ${cycleResult.exitReason}`, rectSummary);
  }

  // "validator-error" means runPhase threw during re-validation (e.g. session failure).
  // runFixCycle demotes it to a clean exit rather than throwing, so we surface it here
  // to prevent the failure from being completely silent.
  if (cycleResult.exitReason === "validator-error") {
    rectLogger?.warn("story-orchestrator", "rectification cycle aborted — validator infrastructure error", {
      storyId: ctx.storyId,
    });
  }

  const exhaustedReasons = new Set<string>([
    "max-attempts-total",
    "max-attempts-per-strategy",
    "bail-when",
    "no-strategy",
    "agent-gave-up",
  ]);
  if (exhaustedReasons.has(cycleResult.exitReason) && cycleResult.finalFindings.length > 0) {
    return { rectificationExhausted: true, unfixedFindings: cycleResult.finalFindings };
  }

  return {};
}

export class ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly state: InternalBuildState,
    /**
     * When true, the orchestrator emits TDD-stage logs and captures per-phase
     * `beforeRef` so isolation `verify` hooks run. The single-session path
     * reuses implementerOp but has no boundary semantics, so this stays false
     * for that strategy. Set by `buildPlanForStrategy` based on `isThreeSessionStrategy`.
     */
    private readonly isThreeSession: boolean = false,
  ) {}

  /**
   * Returns the names of all phases in canonical execution order.
   * Phase names correspond to op.name on each RunOperation.
   * When rectification is configured, the sentinel "rectification" appears last.
   */
  phaseNames(): readonly string[] {
    const names = collectOrderedPhases(this.state).map((p) => p.slot.op.name);
    if (this.state.rectification) {
      return [...names, "rectification"];
    }
    return names;
  }

  async run(): Promise<StoryOrchestratorResult> {
    const phaseCosts: Record<string, number> = {};
    const phaseOutputs: Record<string, unknown> = {};
    const startedAt = Date.now();
    const logger = getSafeLogger();

    // TDD RED → GREEN → handover contract: a gate failure halts the canonical
    // sequence unconditionally. Verifier and downstream review phases run only on
    // green (passing-gate) code — they must never judge a broken state.
    //
    // Rectification (when configured) is invoked *after* this loop regardless of
    // whether the loop broke early; it collects gate findings from phaseOutputs
    // and drives the fix cycle independently. After rectification drives the gate
    // back to green, phasesToRevalidate re-dispatches verifier and reviews so they
    // judge only the fixed code (Task 2).
    //
    // This reverts the verifierExempt path added in ff640e6b — that change let
    // the verifier run on broken-gate code as an "unrelated regression" escape
    // hatch, at the cost of every common case. The escalation boundary in
    // deriveTddFailureCategory now handles that case instead.
    for (const phase of collectOrderedPhases(this.state)) {
      try {
        await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs, this.isThreeSession);
      } catch (error) {
        logger?.error("story-orchestrator", "Phase threw unexpected error", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
          error: errorMessage(error),
        });
        throw error;
      }

      // Short-circuit on any phase failure (spec §2C: any phase returning success=false halts execution).
      // No exemptions — verifier and reviews must never judge broken-gate code. Gate findings are
      // captured in phaseOutputs before this check, so runRectification() still consumes them.
      if (!phasePassed(phase.slot.op.name, phaseOutputs[phase.slot.op.name], this.ctx.storyId)) {
        logger?.warn("story-orchestrator", "Short-circuiting on phase failure", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
        });
        break;
      }
    }

    const rectResult = await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);

    // Aggregate success across every op that produced output, including fix-ops
    // dispatched during rectification (spec §2C / AC: "success === false when
    // any op returns { success: false }").
    //
    // Verifier-as-SSOT carve-out: when a verifier ran AND passed, the full-suite
    // gate's failure represents pre-existing/unrelated regressions (verifier's
    // judgment). Exempt the gate from aggregation so the story doesn't roll back
    // over failures it didn't cause. The gate output stays in `phaseOutputs` for
    // diagnostics; rectification (when configured) still consumes its findings.
    const verifierName = this.state.verifier?.slot.op.name;
    const gateName = this.state.fullSuiteGate?.slot.op.name;
    // SSOT requires an explicit pass — see `phaseExplicitlyPassed` for why we
    // don't use the defensive `phasePassed` here.
    const verifierPassedSsot = verifierName !== undefined && phaseExplicitlyPassed(phaseOutputs[verifierName]);
    if (
      verifierPassedSsot &&
      gateName !== undefined &&
      !phasePassed(gateName, phaseOutputs[gateName], this.ctx.storyId)
    ) {
      logger?.warn(
        "story-orchestrator",
        "Full-suite gate failed but verifier judged story OK — treating gate failures as unrelated regressions",
        { storyId: this.ctx.storyId, packageDir: this.ctx.packageDir },
      );
    }
    const success = Object.entries(phaseOutputs).every(([name, output]) => {
      if (verifierPassedSsot && name === gateName) return true;
      return phasePassed(name, output, this.ctx.storyId);
    });
    const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);
    const durationMs = Date.now() - startedAt;

    // Final aggregate log — single end-of-run summary so anyone reading the JSONL
    // can see the orchestrator's verdict without correlating per-phase lines.
    const failedPhases = Object.entries(phaseOutputs)
      .filter(([name, output]) => {
        if (verifierPassedSsot && name === gateName) return false;
        return !phasePassed(name, output, this.ctx.storyId);
      })
      .map(([name]) => name);
    const summary: Record<string, unknown> = {
      storyId: this.ctx.storyId,
      success,
      totalCostUsd,
      durationMs,
      phaseCount: Object.keys(phaseOutputs).length,
      failedPhases: failedPhases.length > 0 ? failedPhases : undefined,
    };
    if (rectResult.rectificationExhausted) summary.rectificationExhausted = true;
    if (rectResult.unfixedFindings) summary.unfixedFindingsCount = rectResult.unfixedFindings.length;
    if (success) {
      logger?.info("story-orchestrator", "Story orchestration complete", summary);
    } else {
      logger?.warn("story-orchestrator", "Story orchestration failed", summary);
    }

    return {
      success,
      phaseCosts,
      totalCostUsd,
      durationMs,
      phaseOutputs,
      ...rectResult,
    };
  }
}

export class StoryOrchestratorBuilder {
  private readonly state: InternalBuildState = {};

  addImplementer<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addImplementer(input: ImplementerInput): this;
  addImplementer(value: ImplementerInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "implementer", isSlot(value) ? value : { op: implementerOp, input: value });
    return this;
  }

  addTestWriter<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addTestWriter(input: TestWriterInput): this;
  addTestWriter(value: TestWriterInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "test-writer", isSlot(value) ? value : { op: testWriterOp, input: value });
    return this;
  }

  addGreenfieldGate<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addGreenfieldGate(input: GreenfieldGateInput): this;
  addGreenfieldGate(value: GreenfieldGateInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "greenfield-gate", isSlot(value) ? value : { op: greenfieldGateOp, input: value });
    return this;
  }

  addVerifier<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addVerifier(input: VerifierInput): this;
  addVerifier(value: VerifierInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "verifier", isSlot(value) ? value : { op: verifierOp, input: value });
    return this;
  }

  addFullSuiteGate<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addFullSuiteGate(input: FullSuiteGateInput): this;
  addFullSuiteGate(value: FullSuiteGateInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "full-suite-gate", isSlot(value) ? value : { op: fullSuiteGateOp, input: value });
    return this;
  }

  addVerifyScoped<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addVerifyScoped(input: VerifyScopedInput): this;
  addVerifyScoped(value: VerifyScopedInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "verify-scoped", isSlot(value) ? value : { op: verifyScopedOp, input: value });
    return this;
  }

  addLintCheck<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addLintCheck(input: LintCheckInput): this;
  addLintCheck(value: LintCheckInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "lint-check", isSlot(value) ? value : { op: lintCheckOp, input: value });
    return this;
  }

  addTypecheckCheck<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addTypecheckCheck(input: TypecheckCheckInput): this;
  addTypecheckCheck(value: TypecheckCheckInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "typecheck-check", isSlot(value) ? value : { op: typecheckCheckOp, input: value });
    return this;
  }

  addSemanticReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addSemanticReview(input: SemanticReviewInput): this;
  addSemanticReview(value: SemanticReviewInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "semantic-review", isSlot(value) ? value : { op: semanticReviewOp, input: value });
    return this;
  }

  addAdversarialReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addAdversarialReview(input: AdversarialReviewInput): this;
  addAdversarialReview(value: AdversarialReviewInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "adversarial-review", isSlot(value) ? value : { op: adversarialReviewOp, input: value });
    return this;
  }

  addRectification(opts: RectificationPhaseOptions): this {
    this.state.rectification = opts;
    return this;
  }

  build(ctx: CallContext, opts: { isThreeSession?: boolean } = {}): ExecutionPlan {
    if (!this.state.implementer) {
      throw new NaxError(
        "StoryOrchestratorBuilder.build(): addImplementer() must be called before build()",
        "ORCHESTRATOR_NO_IMPLEMENTER",
        { stage: "execution" },
      );
    }

    return new ExecutionPlan(ctx, { ...this.state }, opts.isThreeSession ?? false);
  }
}
