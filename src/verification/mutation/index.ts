/**
 * Mutation generation core — public surface.
 */

export * from "./types";
export { generateMutants } from "./mutator";
export { applyMutant, revertMutant } from "./apply";
export { classifyMutant } from "./classify";
