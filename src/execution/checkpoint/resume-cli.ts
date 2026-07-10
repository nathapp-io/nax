/**
 * applyResumeModeDeps — US-004 CLI seam.
 *
 * Wires `_storyOrchestratorDeps.loadCheckpoints` based on the user's chosen
 * resume mode so the orchestrator's `ExecutionPlan.run()` main loop seeds its
 * in-memory skip state correctly.
 *
 * Modes:
 *   - `"auto"` (default): override with the real `loadCheckpoints(featureDir)`.
 *     When `checkpoint.jsonl` exists for the feature, phases recorded green
 *     are skipped on the next run; when it does not exist, an empty Map is
 *     returned and every incomplete story runs from the top.
 *   - `"fresh"` / `"no-resume"`: override with a function that always returns
 *     an empty Map so the orchestrator seeds no skip phases and every
 *     incomplete story starts from the first phase. The on-disk
 *     `checkpoint.jsonl` is left untouched — these flags only change what the
 *     orchestrator seeds in memory, which is the spec contract.
 *
 * This helper is the single source of truth for the resume-mode → skip-state
 * mapping. The `nax run` and `nax resume` commands both call it before
 * dispatching to the orchestrator.
 */

import { _storyOrchestratorDeps } from "../story-orchestrator";
import { loadCheckpoints } from "./reader";

/**
 * Resume mode selected by the user (via `--fresh` / `--no-resume` or
 * `nax resume`). The CLI layer is responsible for parsing these flags and
 * passing the resolved mode to this helper.
 *
 *   - `"auto"`     — auto-resume when `checkpoint.jsonl` exists.
 *   - `"fresh"`    — ignore any prior checkpoint; run every incomplete story
 *                    from the top.
 *   - `"no-resume"`— same as `"fresh"`.
 */
export type ResumeMode = "auto" | "fresh" | "no-resume";

/**
 * Install the orchestrator's `loadCheckpoints` dep for the given feature
 * and resume mode. Callers must restore the original dep afterwards when
 * running multiple in-process runs (the runner handles this in its `finally`
 * block).
 */
export function applyResumeModeDeps(featureDir: string, mode: ResumeMode = "auto"): void {
  if (mode === "fresh" || mode === "no-resume") {
    _storyOrchestratorDeps.loadCheckpoints = async (_fd: string): Promise<unknown> => new Map();
    return;
  }
  // mode === "auto" — wire to the real reader so the orchestrator can seed
  // its in-memory skip state from any existing `checkpoint.jsonl`.
  _storyOrchestratorDeps.loadCheckpoints = async (fd: string): Promise<unknown> => loadCheckpoints(fd);
}
