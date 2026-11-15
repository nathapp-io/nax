import { join } from "node:path";
import type { getLogger } from "../logger";
import { applyConfigCompatShims, type createConfigWarnDedupe } from "./compat-shims";
import { rejectPipelineModeKeys, warnQualityCommandChains } from "./config-guards";
import { assertDeclaredStallDetection } from "./package-layer";
import { PROJECT_NAX_DIR } from "./paths";
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
    rejectPipelineModeKeys(layer, `per-package profile "${name}" (${packageDir})`);
    warnQualityCommandChains(layer, warnDedupe.warn);
    // Whole-branch review B3: a profile can declare `quality.stallDetection`
    // exactly as the package's own `config.json` can, and this layer merges in
    // AFTER the package file's own declaration was validated. Without this
    // check a profile's `silenceTimeoutSeconds: null` was completed to `0` by
    // `mergePackageConfig` (so both loaders accepted it) while
    // `resolveGateCommands` rejected the same file. The source is the profile
    // file, not the package config, so the error names the layer to fix.
    assertDeclaredStallDetection(layer, packageDir, join(packageDir, PROJECT_NAX_DIR, "profiles", `${name}.json`));
    layers.push(layer);
  }
  return { chain, layers };
}
