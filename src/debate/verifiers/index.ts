export type { CheckDeps } from "./checks";
export {
  checkAcAnchored,
  checkClaimsCited,
  checkFilesExist,
  checkNoContradictions,
  checkSpecCoverage,
} from "./checks";
export { _planChecklistDeps, planChecklistVerifier } from "./plan-checklist";
export { registerPostDebateVerifier, resolvePostDebateVerifier } from "./registry";
export type { PostDebateVerifier, PostDebateVerifierContext, PostDebateVerifierResult } from "./types";
