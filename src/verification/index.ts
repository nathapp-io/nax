/**
 * Unified Verification Layer
 *
 * Central module for test execution, parsing, and verification gates.
 * Eliminates duplication across execution/, tdd/, and pipeline/stages/.
 */

export * from "./executor";
export * from "./flake-baseline-diff";
export * from "./flake-probe";
export * from "./flake-triage";
export * from "./flake-triage-telemetry";
export * from "./mutation";
export * from "./rectification";
export * from "./runners";
export * from "./shell-quote";
export { clearGitRootCache } from "./smart-runner";
export * from "./types";
