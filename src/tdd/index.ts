// API surface: each name is both a type alias AND a namespace (runtime sentinel).
// Replaces separate `export type { X }` blocks so module reflection works
// while `import type { X }` still resolves to the correct type.
export {
  FailureCategory,
  IsolationCheck,
  StoryRunResult,
  TddSessionResult,
  TddSessionRole,
  ThreeSessionTddOptions,
  VerdictCategorization,
  VerifierVerdict,
} from "./api-surface";
// ThreeSessionTddResult kept as a type-only backward-compat re-export; absent from the runtime module.
export type { ThreeSessionTddResult } from "./types";
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
