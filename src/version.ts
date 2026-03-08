/**
 * Version and build info for nax.
 *
 * GIT_COMMIT is injected at build time via --define in the bun build script.
 * When running from source (bin/nax.ts), falls back to runtime git rev-parse.
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

declare const GIT_COMMIT: string;

export const NAX_VERSION: string = pkg.version;

/** Short git commit hash — injected at build time, or resolved at runtime from git. */
export const NAX_COMMIT: string = (() => {
  // Build-time injection (bun build --define GIT_COMMIT=...)
  try {
    if (typeof GIT_COMMIT === "string" && GIT_COMMIT !== "dev") return GIT_COMMIT;
  } catch {
    // not injected — fall through to runtime resolution
  }
  // Runtime fallback: resolve from the source file's git repo
  try {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: sourceDir,
      encoding: "utf8",
      timeout: 2000,
    });
    const hash = result.stdout?.trim();
    if (hash && /^[0-9a-f]{6,10}$/.test(hash)) return hash;
  } catch {
    // git not available
  }
  return "dev";
})();

export const NAX_BUILD_INFO = `v${NAX_VERSION} (${NAX_COMMIT})`;
