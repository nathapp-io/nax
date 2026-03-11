/**
 * Prompts CLI Commands
 *
 * Re-exports prompts-related commands for assembling, initializing, and exporting prompts.
 */

// Main prompts command exports
export { promptsCommand, buildFrontmatter, type PromptsCommandOptions } from "./prompts-main";

// Init command exports
export { promptsInitCommand, type PromptsInitCommandOptions } from "./prompts-init";

// Export command exports
export { exportPromptCommand, type ExportPromptCommandOptions } from "./prompts-export";

// TDD handling exports
export { handleThreeSessionTddPrompts } from "./prompts-tdd";
