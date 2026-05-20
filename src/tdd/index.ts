// Type re-exports. Canonical owners:
//   - Wrapper types (FailureCategory, IsolationCheck, TddSessionResult,
//     TddSessionRole, StoryRunResult): src/execution/types
//   - Verdict types: src/tdd/verdict
//   - Strategy options (ThreeSessionTddOptions): src/tdd/types
export type {
  FailureCategory,
  IsolationCheck,
  StoryRunResult,
  TddSessionResult,
  TddSessionRole,
} from "../execution/types";
export type { ThreeSessionTddOptions } from "./types";
export type { VerdictCategorization, VerifierVerdict } from "./verdict";

export { isTestFile } from "../test-runners";
export {
  getChangedFiles,
  isSourceFile,
  verifyImplementerIsolation,
  verifyTestWriterIsolation,
} from "./isolation";
export { cleanupProcessTree, getPgid } from "./cleanup";
export { VERDICT_FILE, categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";
export {
  implementTddOp,
  implementerOp,
  runTddSessionOp,
  testWriterOp,
  verifyTddOp,
  verifierOp,
  writeTddTestOp,
} from "./session-op";
