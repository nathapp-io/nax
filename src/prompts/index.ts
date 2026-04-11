/**
 * src/prompts — public barrel
 *
 * All prompt-building code in nax lives under this directory.
 * Other subsystems import from here — never from internal paths
 * (src/prompts/core/*, src/prompts/builders/*).
 */

// Primary export — use TddPromptBuilder for all TDD execution prompts
export { TddPromptBuilder } from "./builders/tdd-builder";

// Backwards-compatible alias — existing callsites continue to work without change.
// Migrate to TddPromptBuilder when touching adjacent code.
export { TddPromptBuilder as PromptBuilder } from "./builders/tdd-builder";

// Core types — re-exported for callsites that need them
export type { PromptRole, PromptSection, PromptOptions } from "./core/types";
