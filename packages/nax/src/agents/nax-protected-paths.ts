/**
 * nax's protected-paths policy (S1 spec section 4.2, port 6): the knowledge
 * of which paths nax itself owns stays in nax and reaches the coding tools and
 * the sandbox as data. Built per dispatch so `NAX_GLOBAL_CONFIG_DIR` is read
 * live, as `globalConfigDir()` and `trustStorePath()` always were.
 */
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import type { ProtectedPathsPolicy } from "@/tools";
import { trustStorePath } from "@/trust";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

export function naxProtectedPaths(): ProtectedPathsPolicy {
  return {
    gitExcludePathspecs: NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    gitIgnorePatterns: NAX_GITIGNORE_ENTRIES,
    projectStateDir: PROJECT_NAX_DIR,
    credentialDir: globalConfigDir(),
    trustStoreFile: trustStorePath(),
  };
}
