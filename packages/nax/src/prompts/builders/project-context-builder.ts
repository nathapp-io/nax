/**
 * US-007 (SPEC-lazy-rules-delivery) — the run's project-context override section.
 *
 * One section, one place: the story brief and the branch review package render
 * the same heading over the same body, so an agent that has read one recognises
 * the other. The body is the operator's file verbatim — see
 * `buildProjectContextSection`.
 *
 * Prompt text lives here, not in `src/workflow/`, per the Prompt Builder
 * Convention (forbidden-patterns-source.md).
 */

/** The heading both carriers use. Private: the tests re-spell it, so a text change is caught. */
const PROJECT_CONTEXT_HEADING = "## Project context (run override)";

/**
 * The "## Project context (run override)" section, or "" when there is nothing to
 * show.
 *
 * Deliberately not `section()` in `workflow-implementer-builder.ts`: that helper
 * trims its body, and this body is the operator's file verbatim
 * (SPEC-lazy-rules-delivery § Project-context override section). Only the decision
 * whether to render at all looks at whitespace — a file that holds nothing but
 * blank lines would otherwise add a heading with no content under it.
 */
export function buildProjectContextSection(projectContextOverride: string | undefined): string {
  if (projectContextOverride === undefined || projectContextOverride.trim() === "") return "";
  return `${PROJECT_CONTEXT_HEADING}\n\n${projectContextOverride}\n`;
}
