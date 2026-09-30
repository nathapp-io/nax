/**
 * Config JSON Report
 *
 * One-document JSON view of the profile-resolved config plus the runtime
 * requirements an external orchestrator needs before dispatching a run.
 */

import { findProjectDir, loadConfig, validateDirectory } from "../config";
import { errorMessage } from "../utils/errors";
import { determineConfigSources } from "./config-display";
import { maskProfileValues } from "./config-profile";
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

export async function configJsonCommand(options: ConfigJsonOptions): Promise<number> {
  try {
    if (options.explain || options.diff) {
      throw Object.assign(new Error("--json cannot be combined with --explain or --diff"), {
        code: "CONFIG_FLAGS_CONFLICT",
      });
    }

    const dir = validateDirectory(options.dir);
    const projectDir = findProjectDir(dir);
    const profile = options.profile ?? [];
    const config = await loadConfig(projectDir ?? dir, { profile });
    const requirements = _configJsonDeps.buildConfigRequirements(config);
    const report: ConfigJsonReport = {
      profile: config.profile ?? "default",
      profileChain: config.profileChain ?? [],
      sources: determineConfigSources(options.dir),
      requirements,
      config: maskProfileValues(config as unknown as Record<string, unknown>),
    };
    _configJsonDeps.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (err) {
    const error = err as { code?: unknown };
    _configJsonDeps.log(
      JSON.stringify(
        {
          error: {
            code: typeof error.code === "string" ? error.code : "CONFIG_JSON_FAILED",
            message: errorMessage(err),
          },
        },
        null,
        2,
      ),
    );
    return 1;
  }
}
