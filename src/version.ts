/**
 * Version and build info for nax.
 *
 * GIT_COMMIT is injected at build time via --define in the bun build script.
 * When running from source (bin/nax.ts), falls back to runtime git rev-parse.
 *
 * `NAX_AI_VERSION` is the version of the pinned `@nathapp/nax-ai` catalog
 * package. The catalog's `exports` map declares only the package root (no
 * `./package.json` subpath), so a runtime read of the catalog's manifest
 * via a normal package import is not available. The read lives in
 * `src/agents/catalog/` (the only directory permitted by
 * `scripts/check-nax-ai-imports.ts`) and goes through `Bun.file()` on
 * `node_modules/@nathapp/nax-ai/package.json` so a missing or unparsable
 * manifest cannot crash module loading — that satisfies US-003 AC12.
 * The read is re-exported here as `NAX_AI_VERSION` for consumer
 * convenience.
 *
 * If the catalog pin is unreadable at build time — the dependency's
 * `package.json` is missing, the file cannot be parsed, or its `version`
 * field is empty/missing/non-string — `NAX_AI_VERSION` is `undefined`. A
 * cost row omits `catalogVersion` in that case rather than recording an
 * empty or placeholder string (`catalogVersion: ""` would falsely imply a
 * catalog origin). Detection of an installed package that differs from the
 * declared pin is out of scope.
 */

import { CATALOG_VERSION } from "@/agents/catalog";
import pkg from "../package.json";

declare const GIT_COMMIT: string;

export const NAX_VERSION: string = pkg.version;

/**
 * Version of the pinned `@nathapp/nax-ai` catalog package, inlined at
 * build time from its `package.json` via `src/agents/catalog`. `undefined`
 * when the catalog pin is unreadable at build time (US-003 AC12) — never
 * an empty string.
 */
export const NAX_AI_VERSION: string | undefined = CATALOG_VERSION;

/** Short git commit hash — injected at build time, or resolved at runtime from git. */
export const NAX_COMMIT: string = (() => {
  // Build-time injection (bun build --define GIT_COMMIT=...)
  // Guard: must be a non-empty string that looks like a real commit hash
  try {
    if (typeof GIT_COMMIT === "string" && /^[0-9a-f]{6,10}$/.test(GIT_COMMIT)) return GIT_COMMIT;
  } catch {
    // not injected — fall through to runtime resolution
  }
  // Runtime fallback: resolve from the source file's git repo (Bun-native)
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir,
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const hash = result.stdout.toString().trim();
      if (/^[0-9a-f]{6,10}$/.test(hash)) return hash;
    }
  } catch {
    // git not available
  }
  return "dev";
})();

/** Human-readable build info string — omits commit when unavailable. */
export const NAX_BUILD_INFO: string = NAX_COMMIT === "dev" ? `v${NAX_VERSION}` : `v${NAX_VERSION} (${NAX_COMMIT})`;
