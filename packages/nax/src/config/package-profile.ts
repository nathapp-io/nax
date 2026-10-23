import { join } from "node:path";
import type { getLogger } from "../logger";
import { applyConfigCompatShims, type createConfigWarnDedupe } from "./compat-shims";
import { warnQualityCommandChains } from "./config-guards";
import { loadProfile, parseProfileList, resolveProfileEnvVars } from "./profile";

interface PackageProfileOptions {
  profile?: string | string[];
  repoRoot: string;
  packageDir: string;
  logger: ReturnType<typeof getLogger> | null;
  warnDedupe: ReturnType<typeof createConfigWarnDedupe>;
}

/** Resolve package profiles once per resolution, preserving layer order and warning deduplication. */
export async function loadPackageProfileLayers({
  profile,
  repoRoot,
  packageDir,
  logger,
  warnDedupe,
}: PackageProfileOptions): Promise<{ chain: string[]; layers: Record<string, unknown>[] }> {
  const chain = parseProfileList(profile).filter((name) => name && name !== "default");
  const layers: Record<string, unknown>[] = [];
  const packageRoot = join(repoRoot, packageDir);
  for (const name of chain) {
    const profileData = await loadProfile(name, packageRoot);
    const resolvedProfileData = await resolveProfileEnvVars(
      name,
      packageRoot,
      profileData,
      `Per-package profile "${name}" (${packageDir})`,
      { packageDir },
    );
    const layer = applyConfigCompatShims(resolvedProfileData, logger, warnDedupe);
    warnQualityCommandChains(layer, warnDedupe.warn);
    layers.push(layer);
  }
  return { chain, layers };
}
