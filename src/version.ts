/**
 * Version and build info for nax.
 *
 * GIT_COMMIT is injected at build time via --define in the bun build script.
 * When running from source (bun run dev), it falls back to "dev".
 */

import pkg from "../package.json";

declare const GIT_COMMIT: string;

export const NAX_VERSION: string = pkg.version;

/** Short git commit hash, injected at build time. Falls back to "dev" from source. */
export const NAX_COMMIT: string = (() => {
  try {
    return GIT_COMMIT ?? "dev";
  } catch {
    return "dev";
  }
})();

export const NAX_BUILD_INFO = `v${NAX_VERSION} (${NAX_COMMIT})`;
