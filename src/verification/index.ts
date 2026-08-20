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
export * from "./flake-probe";
export * from "./flake-triage";
export * from "./flake-baseline-diff";
export * from "./mutation";
export * from "./shell-quote";
export { clearGitRootCache } from "./smart-runner";
