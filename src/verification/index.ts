/**
 * Unified Verification Layer
 *
 * Central module for test execution, parsing, and verification gates.
 * Eliminates duplication across execution/, tdd/, and pipeline/stages/.
 */

export * from "./types";
export * from "./executor";
export * from "./runners";
export * from "./rectification";
export * from "./shared-rectification-loop";
export { _rectificationDeps } from "./rectification-loop";
