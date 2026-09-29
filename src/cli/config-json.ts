/**
 * Config JSON Report
 *
 * One-document JSON view of the profile-resolved config plus the runtime
 * requirements an external orchestrator needs before dispatching a run.
 */

import { buildConfigRequirements, type ConfigRequirements } from "./config-requirements";

/** The single document `nax config --json` prints. */
export interface ConfigJsonReport {
  profile: string;
  profileChain: string[];
  sources: { global: string | null; project: string | null };
  requirements: ConfigRequirements;
  config: Record<string, unknown>;
}

/** Options for the JSON config command. */
export interface ConfigJsonOptions {
  dir: string;
  profile?: string[];
  explain?: boolean;
  diff?: boolean;
}

export const _configJsonDeps: {
  log: (text: string) => void;
  buildConfigRequirements: typeof buildConfigRequirements;
} = {
  log: (text: string) => console.log(text),
  buildConfigRequirements,
};

export async function configJsonCommand(_options: ConfigJsonOptions): Promise<number> {
  // Stub — the real handler (load, report, print) lands in the RED->GREEN step.
  return -1;
}
