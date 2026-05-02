/**
 * src/findings — unified Finding wire format.
 *
 * ADR-021 phase 1: types only, no behaviour. Producers migrate to emit
 * Finding[] in subsequent phases.
 *
 * Orchestration (Iteration, FixApplied, FixStrategy, runFixCycle, …) lives
 * in ADR-022 and will arrive in a separate file (e.g. cycle-types.ts) once
 * that ADR's phase 1 PR begins. Consumers should import only the wire-format
 * types from here for now.
 */

export type {
  Finding,
  FindingSeverity,
  FindingSource,
  FixTarget,
} from "./types";
