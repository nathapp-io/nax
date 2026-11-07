import { renderCommandSpec } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "../config";
import { detectLanguage } from "../project";

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

export interface SelfVerificationPromptInput {
  packageDir: string;
  language?: string;
  lintCommand?: string;
  typecheckCommand?: string;
}

export async function resolveSelfVerificationPromptInput(
  config: Pick<NaxConfig, "quality">,
  packageDir: string,
): Promise<SelfVerificationPromptInput> {
  return {
    packageDir,
    language: await detectLanguage(packageDir),
    lintCommand: renderCommandSpec(config.quality?.commands?.lint),
    typecheckCommand: renderCommandSpec(config.quality?.commands?.typecheck),
  };
}
