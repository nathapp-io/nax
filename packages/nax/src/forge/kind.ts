/**
 * The forge kind nax is told to act as, captured once at CLI start.
 *
 * Detection classifies a remote by host name and then falls back to which forge
 * CLI is installed. Neither answers for a self-hosted forge on a neutral host
 * (`git.corp.example`) on a machine carrying both `gh` and `glab` — exactly a
 * shared job runner serving GitHub and GitLab repositories. So the caller gets
 * to say: `NAX_FORGE_KIND` for one invocation, `forge.kind` for the project.
 *
 * This names a forge kind only. It changes no credential, no identity and no
 * CLI login; `NAX_FORGE_FORGE_*` (see `./identity`) is a separate concern.
 *
 * State is process-local and read through `_forgeKind.current`; the config is
 * read through `_forgeKindDeps.configuredKind`, dynamically imported so this
 * module does not depend on `@/config` at load time.
 */

import { NaxError } from "@/errors";
import type { ForgeKind } from "./types";

/** The variable that names the forge kind for one invocation. */
export const FORGE_KIND_ENV = "NAX_FORGE_KIND";

/** Code carried by a refused `NAX_FORGE_KIND`. */
const FORGE_KIND_INVALID = "FORGE_KIND_INVALID";

/** Mutable holder in the `_deps` style; tests set it and must reset it to undefined in afterEach. */
export const _forgeKind: { current: ForgeKind | undefined } = { current: undefined };

/** `github` and `gitlab`, exact and lower case — the same vocabulary `forge.kind` uses. */
function isForgeKind(value: string): value is ForgeKind {
  return value === "github" || value === "gitlab";
}

/**
 * Default config read: `forge.kind` of the config resolved for `repoRoot`.
 *
 * The dynamic import keeps `@/config` out of this module's load-time imports —
 * the forge module is consumed by the CLI entry point, which must not pull the
 * whole config tree in before it is needed.
 */
async function defaultConfiguredKind(repoRoot: string): Promise<ForgeKind | undefined> {
  const { loadConfig } = await import("@/config");
  const config = await loadConfig(repoRoot);
  return config.forge?.kind;
}

/** Injectable seam for the config read; tests replace `configuredKind`. */
export const _forgeKindDeps: {
  /** `forge.kind` from the config resolved for `repoRoot`. */
  configuredKind(repoRoot: string): Promise<ForgeKind | undefined>;
} = {
  configuredKind: defaultConfiguredKind,
};

/**
 * Read `NAX_FORGE_KIND`, store it in `_forgeKind.current`, and return it.
 *
 * Unset or whitespace-only is absent, and clears any previously captured value —
 * a refused or dropped capture must not leave an earlier kind in force. Throws
 * `NaxError` code FORGE_KIND_INVALID when the value names no forge, before
 * storing anything.
 */
export function captureForgeKind(env: Record<string, string | undefined>): ForgeKind | undefined {
  _forgeKind.current = undefined;

  const raw = env[FORGE_KIND_ENV]?.trim();
  if (!raw) return undefined;

  if (!isForgeKind(raw)) {
    throw new NaxError(`[forge] Invalid ${FORGE_KIND_ENV} "${raw}": expected github or gitlab`, FORGE_KIND_INVALID, {
      stage: "forge",
      value: raw,
    });
  }

  _forgeKind.current = raw;
  return raw;
}

/**
 * The kind the caller declared: `NAX_FORGE_KIND` first, then `forge.kind` of the
 * config resolved for `repoRoot`, else undefined.
 *
 * A config that fails to load yields undefined rather than failing here — the
 * command that needs a forge already loaded its own config, and detection can
 * still decide.
 */
export async function resolveExplicitForgeKind(repoRoot: string): Promise<ForgeKind | undefined> {
  if (_forgeKind.current !== undefined) return _forgeKind.current;
  try {
    return await _forgeKindDeps.configuredKind(repoRoot);
  } catch {
    // Leave the decision to detection; the caller's own config load already reported.
    return undefined;
  }
}
