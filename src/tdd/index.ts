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
export type { VerdictCategorization, VerifierVerdict } from "./verdict";

export { isTestFile } from "../test-runners";
export {
  _isolationDeps,
  getChangedFiles,
  isSourceFile,
  verifyImplementerIsolation,
  verifyTestWriterIsolation,
} from "./isolation";
export { cleanupProcessTree, getPgid } from "./cleanup";
export { VERDICT_FILE, categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";
export { _rollbackDeps, rollbackToRef } from "./rollback";
export { implementTddOp, implementerOp, testWriterOp, verifyTddOp, verifierOp, writeTddTestOp } from "../operations";
