/**
 * @deprecated Import from @/prompts instead.
 * Re-exports DecomposePromptBuilder public API for backwards compatibility
 * during the migration period.
 */
export type { DecomposePromptInput } from "@/prompts/builders/decompose-builder";
export { buildDecomposePromptSync, buildDecomposePromptAsync } from "@/prompts";
