/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type { AcceptanceExecution } from "./execution-description";
export { _acceptanceExecutionDeps, resolveAcceptanceExecution } from "./execution-description";
export {
  buildAcceptanceRunCommand,
  effectiveAcceptanceFramework,
  substituteAcceptanceTestPath,
} from "./generator";
