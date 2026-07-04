/**
 * Triage seam — shared between the orchestrator wiring and any future
 * production binding to the real `triageFlakyFindings`. Lives in its own
 * module (no `rectification.ts` / `run-phase.ts` dependency) so both
 * `_storyOrchestratorDeps.triage` initialization and the orchestrator's
 * `triageGateFindings` import this without creating a circular import
 * between the two orchestrator files.
 */

import type { Finding } from "@/findings";

/** Triage result tuple shape — produced by `_storyOrchestratorDeps.triage`. */
export type TriageResult = readonly [Finding[], { quarantinedKeys: readonly string[] }];

/**
 * Triage seam signature — the orchestrator hands the gate's `failed-test`
 * findings to this function and receives the triaged set (entries may have
 * been relabeled to `category: "flaky-test"` and quarantined for the run)
 * plus the memo keys of every entry that was quarantined on this call.
 *
 * Async by contract: the real `triageFlakyFindings` (src/verification/flake-triage.ts)
 * is async because it probes subprocesses for isolation re-runs. Async is the
 * forward-compatible shape so a future wire-up that bridges to it does not
 * require a second signature change.
 *
 * Receives the gate's failed-test findings only (post-`extractPhaseFindings`
 * filter); the seam must NOT re-read or re-validate the gate output.
 */
export type TriageSeam = (gateFindings: Finding[]) => Promise<TriageResult>;

/**
 * Default production triage seam — a passthrough that returns findings
 * unchanged with an empty quarantine report. The actual triage
 * (probe + baseline detection + quarantine memo) is wired in by a future
 * story — this story ships the seam and the orchestrator integration; the
 * US-001 probe module is intentionally scoped OUT (see story scope). When
 * that wiring lands, this default is replaced (or wrapped) in run-phase.ts
 * at module-load time so `_storyOrchestratorDeps.triage` is always a callable
 * function — keeping the integration code path active even before the probe
 * wiring ships.
 */
export const defaultTriageSeam: TriageSeam = async (gateFindings) => [gateFindings, { quarantinedKeys: [] }];
