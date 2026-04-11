/**
 * Prompt Builder Core
 *
 * Internal shared engine — imported by builders only.
 * Other subsystems should import from src/prompts (the public barrel), not here.
 */

export { SectionAccumulator } from "./section-accumulator";
export { universalConstitutionSection, universalContextSection } from "./universal-sections";
export { wrapConstitution, wrapContext, SECTION_SEP } from "./wrappers";
export type { PromptOptions, PromptRole, PromptSection } from "./types";
export * from "./sections";
