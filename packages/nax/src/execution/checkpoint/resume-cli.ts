/**
 * resume-cli — the workflow resume seam.
 *
 * `execution/` may not import `@/workflow` statically, so the run's resume mode
 * cannot ride a parameter from `run()` into `buildStoryEnv`; it travels this
 * module-global seam instead. `run()` writes it before the setup phase and
 * restores the prior value on both exits (the setup-error catch and the outer
 * `finally`).
 *
 * The orchestrator's checkpoint deps it used to install
 * (`_storyOrchestratorDeps.loadCheckpoints` / `recordGreen`, from the deleted
 * checkpoint reader and writer) are gone with them.
 */

/**
 * Resume mode selected by the user (via `--fresh` / `--no-resume` or
 * `nax resume`). The CLI layer is responsible for parsing these flags and
 * passing the resolved mode into `run()`.
 *
 *   - `"auto"`     — resume from the feature's workflow record.
 *   - `"fresh"`    — ignore any prior record; run every incomplete story from
 *                    the top.
 *   - `"no-resume"`— same as `"fresh"`.
 */
export type ResumeMode = "auto" | "fresh" | "no-resume";

/**
 * US-003 (nax#2511) — the run-start resume mode as the WORKFLOW stage reads it.
 *
 * `buildStoryEnv` reads `mode` here to decide whether to resume the feature's
 * workflow record or start a fresh one. Defaults to `"auto"` (today's
 * behaviour) so a `buildStoryEnv` call outside `run()` — tests, `nax workflow`
 * subcommands — still resumes.
 */
export const _workflowResumeDeps: { mode: ResumeMode } = { mode: "auto" };
