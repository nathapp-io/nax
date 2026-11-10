/**
 * Non-JSON `nax config` CLI action: resolve the selected project directory,
 * load its effective config, and render the requested view.
 */

import { findProjectDir, loadConfig } from "../config";
import { configCommand } from "./config";

export interface ConfigDisplayActionOptions {
  dir: string;
  explain?: boolean;
  diff?: boolean;
  profile?: string[];
}

export async function configDisplayAction(options: ConfigDisplayActionOptions): Promise<void> {
  const projectDir = findProjectDir(options.dir);
  const config = await loadConfig(projectDir ?? options.dir, { profile: options.profile });
  await configCommand(config, {
    explain: options.explain,
    diff: options.diff,
    profile: options.profile,
    dir: options.dir,
  });
}
