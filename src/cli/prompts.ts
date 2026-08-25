/**
 * Prompts CLI Commands
 *
 * Re-exports prompts-related commands for assembling, initializing, and exporting prompts.
 */

// Export command exports
export { type ExportPromptCommandOptions, exportPromptCommand } from "./prompts-export";

// Init command exports
export { _promptsInitDeps, type PromptsInitCommandOptions, promptsInitCommand } from "./prompts-init";
// Main prompts command exports
export { _promptsMainDeps, buildFrontmatter, type PromptsCommandOptions, promptsCommand } from "./prompts-main";

// TDD handling exports
export { handleThreeSessionTddPrompts } from "./prompts-tdd";
