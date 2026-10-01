import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { MonoPackageConfig } from "../operations/setup-generate";

export interface WriteSetupConfigResult {
  written: string[];
}

export const _writeSetupDeps = {
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  mkdir: async (path: string): Promise<void> => {
    const proc = Bun.spawn(["mkdir", "-p", path]);
    await proc.exited;
  },
};

/**
 * Writes the nax setup config files to disk.
 *
 * The collision check (refusing if .nax/config.json already exists without
 * --force) is intentionally kept in setupCommand, which runs before plan
 * generation and exits early with a user-facing message. At write time, the
 * plan has already been generated and the force decision has already been
 * made, so `opts.force` carries no additional write-time semantics here.
 */
export async function writeSetupConfig(
  workdir: string,
  config: NaxConfig,
  monoConfigs: MonoPackageConfig[],
  _opts?: { force?: boolean },
  deps: typeof _writeSetupDeps = _writeSetupDeps,
): Promise<WriteSetupConfigResult> {
  const naxDir = join(workdir, ".nax");
  const naxConfigPath = join(naxDir, "config.json");
  const written: string[] = [];

  await deps.mkdir(naxDir);
  await deps.writeFile(naxConfigPath, JSON.stringify(config, null, 2));
  written.push(naxConfigPath);

  for (const mc of monoConfigs) {
    const monoDir = join(naxDir, "mono", mc.relativeDir);
    const monoConfigPath = join(monoDir, "config.json");
    await deps.mkdir(monoDir);
    await deps.writeFile(monoConfigPath, JSON.stringify(mc.config, null, 2));
    written.push(monoConfigPath);
  }

  return { written };
}
