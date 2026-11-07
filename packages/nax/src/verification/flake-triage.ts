/**
 * Flake Triage — Run-Scoped Quarantine Memo
 *
 * Keeps the run-scoped memo that records which tests an earlier gate in the
 * same run judged flaky, so a later gate does not re-probe a test already
 * quarantined. The classifier that composed the isolation probe with the
 * baseline pre-existing-test check went with the story orchestrator's
 * rectification phase (C1 wave B2b-3).
 */

/** Run-scoped quarantine memo — shared across gates within a single run. */
export interface QuarantineMemo {
  has(key: string): boolean;
  add(key: string): void;
}

/** Create a fresh, in-memory run-scoped quarantine memo. One per `NaxRuntime`. */
export function createQuarantineMemo(): QuarantineMemo {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      keys.add(key);
    },
  };
}
