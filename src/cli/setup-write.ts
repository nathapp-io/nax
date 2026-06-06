import type { NaxConfig } from "../config";
import type { MonoPackageConfig } from "../operations/setup-generate";

export interface WriteSetupConfigResult {
  written: string[];
}

export async function writeSetupConfig(
  _workdir: string,
  _config: NaxConfig,
  _monoConfigs: MonoPackageConfig[],
  _opts?: { force?: boolean },
): Promise<WriteSetupConfigResult> {
  throw new Error("not implemented");
}
