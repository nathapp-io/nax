export type SelfVerificationTool = "lint" | "typecheck";
export type SelfVerificationStatus = "pass" | "skip" | "pre_existing" | "fail";

export interface PreExistingFailure {
  packageDir: string;
  file?: string;
  tool: SelfVerificationTool;
  message: string;
}

export interface SelfVerificationResult {
  lint: SelfVerificationStatus;
  typecheck: SelfVerificationStatus;
  preExistingFailures: PreExistingFailure[];
  rawMarker?: string;
  missingMarker?: boolean;
}
