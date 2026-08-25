// Type re-exports. Canonical owners:
//   - Wrapper types (FailureCategory, IsolationCheck, TddSessionResult,
//     TddSessionRole, StoryRunResult): src/execution/types
//   - Verdict types: src/tdd/verdict
export type {
  FailureCategory,
  IsolationCheck,
  StoryRunResult,
  TddSessionResult,
  TddSessionRole,
} from "../execution/types";
export { implementerOp, implementTddOp, testWriterOp, verifierOp, verifyTddOp, writeTddTestOp } from "../operations";

export { isTestFile } from "../test-runners";
export { cleanupProcessTree, getPgid } from "./cleanup";
export {
  _isolationDeps,
  getChangedFiles,
  isSourceFile,
  verifyImplementerIsolation,
  verifyTestWriterIsolation,
} from "./isolation";
export { _rollbackDeps, rollbackToRef } from "./rollback";
export type { VerdictCategorization, VerifierVerdict } from "./verdict";
export { categorizeVerdict, cleanupVerdict, readVerdict, VERDICT_FILE } from "./verdict";
