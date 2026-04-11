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

// Debate prompt builder — centralises all debate and review-dialogue prompt construction.
export { DebatePromptBuilder } from "./builders/debate-builder";
export type { StageContext, PromptBuilderOptions, ReviewStoryContext } from "./builders/debate-builder";

// Review prompt builder — semantic review prompt construction.
export { ReviewPromptBuilder } from "./builders/review-builder";

// Core types — re-exported for callsites that need them
export type { PromptRole, PromptSection, PromptOptions } from "./core/types";
