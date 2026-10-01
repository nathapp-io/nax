/**
 * Prompt Builder Core
 *
 * Internal shared engine — imported by builders only.
 * Other subsystems should import from src/prompts (the public barrel), not here.
 */

export { SectionAccumulator } from "./section-accumulator";
export * from "./sections";
export type { PromptOptions, PromptRole, PromptSection } from "./types";
export { universalConstitutionSection, universalContextSection } from "./universal-sections";
export { SECTION_SEP, wrapConstitution, wrapContext } from "./wrappers";
