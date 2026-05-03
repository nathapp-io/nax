/**
 * src/findings — unified Finding wire format (ADR-021) and cycle orchestration
 * types + runtime (ADR-022).
 *
 * ADR-021: Finding wire format — types, severity ordering, stable identity key,
 * and per-producer adapter converters.
 *
 * ADR-022 Phase 1: cycle orchestration types — Iteration, FixApplied,
 * FixStrategy, FixCycle, FixCycleResult, FixCycleContext, FixCycleConfig.
 *
 * ADR-022 Phase 2: runFixCycle and classifyOutcome behaviour.
 */

export type {
  Finding,
  FindingSeverity,
  FindingSource,
  FixTarget,
} from "./types";

export { SEVERITY_ORDER, compareSeverity, findingKey } from "./types";

export {
  acFailureToFinding,
  acSentinelToFinding,
  lintDiagnosticToFinding,
  pluginToFinding,
  reviewFindingToFinding,
  tscDiagnosticToFinding,
} from "./adapters";
export { rebaseToWorkdir } from "./path-utils";

export type {
  FixApplied,
  FixCycle,
  FixCycleConfig,
  FixCycleContext,
  FixCycleExitReason,
  FixCycleResult,
  FixStrategy,
  Iteration,
  IterationOutcome,
} from "./cycle-types";

export { classifyOutcome, runFixCycle, _cycleDeps } from "./cycle";
