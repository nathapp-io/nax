/**
 * profile.ts — Profile resolution functions for layered config profiles.
 *
 * Story US-001-C
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "../errors";
import { parseDotenv } from "./dotenv";
import { deepMergeConfig } from "./merger";
import { globalConfigDir, projectConfigDir } from "./paths";

interface ProfileEntry {
  name: string;
  path: string;
}

/** Injectable deps for testability — avoids mutating the real process.env in tests. */
export const _profileDeps = {
  env: process.env as Record<string, string | undefined>,
};

/**
 * BUG-21 defense-in-depth: names excluded from the ambient process.env
 * fallback in loadProfileEnv. Mirrors SENSITIVE_KEY_PATTERN in
 * cli/config-profile.ts. Folding all of process.env into the $VAR
 * substitution base (to make `$HOME`/`$USER`-style references work) must not
 * also make secret-shaped ambient vars (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN,
 * ...) silently substitutable by a project-controlled profile.json — an
 * operator opting a var into a profile still does so explicitly via that
 * profile's own .env file, which is layered on top and always wins.
 *
 * BUG-37: broadened beyond the original key|token|secret|password|credential
 * set — DATABASE_URL, AUTHORIZATION, SESSION_ID, and similar secret-shaped
 * names carry no "key"/"token"/etc. substring but are equally sensitive.
 * Over-matching is the safe direction here: a var excluded from the ambient
 * fallback simply throws UnresolvedEnvVarError unless the profile's own .env
 * defines it explicitly — it never silently leaks.
 */
const SENSITIVE_ENV_KEY_PATTERN = /key|token|secret|password|credential|auth|session|cookie|private|dsn|url/i;

/**
 * SEC-08: reject path-traversal in a profile name. `profileName` flows
 * directly into `join(profilesDir, \`${profileName}.json\`)` in loadProfile
 * and loadProfileEnv, and `join` silently collapses `..` segments — e.g.
 * `join(profilesDir, "../../../.config/foo.json")` escapes the profiles
 * directory. `profileName` is attacker-influenced: it can come from CLI
 * `--profile`, the `NAX_PROFILE` env var, or (most dangerously) the
 * project-controlled `.nax/config.json` `profile` field, so a malicious repo
 * can cause reads of arbitrary `*.json` under the user's home directory,
 * deep-merged into the run config with profile precedence. Each name must be
 * a single non-empty path segment with no separators, NUL, or dot/dot-dot
 * values. Mirrors validatePathSegment in context/fragments/store.ts.
 */
function validateProfileName(profileName: string): void {
  if (profileName.length === 0) {
    throw new NaxError("Profile name must be non-empty", "PROFILE_NAME_INVALID", { stage: "config" });
  }
  if (profileName === "." || profileName === "..") {
    throw new NaxError(`Profile name must not be "." or ".."`, "PROFILE_NAME_INVALID", { stage: "config" });
  }
  for (let i = 0; i < profileName.length; i++) {
    const c = profileName.charCodeAt(i);
    if (c === 47 /* '/' */ || c === 92 /* '\\' */ || c === 0 /* NUL */) {
      throw new NaxError(
        `Profile name "${profileName}" must not contain path separators or NUL`,
        "PROFILE_NAME_INVALID",
        { stage: "config", profileName },
      );
    }
  }
}

/**
 * Loads a named profile by deep-merging global and project-scoped JSON files.
 * Project values take precedence over global values.
 * Throws when neither global nor project profile exists.
 */
export async function loadProfile(profileName: string, projectRoot: string): Promise<Record<string, unknown>> {
  validateProfileName(profileName);
  const globalPath = join(globalConfigDir(), "profiles", `${profileName}.json`);
  const projectPath = join(projectConfigDir(projectRoot), "profiles", `${profileName}.json`);

  const globalFile = Bun.file(globalPath);
  const projectFile = Bun.file(projectPath);

  const [globalExists, projectExists] = await Promise.all([globalFile.exists(), projectFile.exists()]);

  if (!globalExists && !projectExists) {
    const available = await listAvailableProfileNames(projectRoot);
    const availableList = available.length > 0 ? available.join(", ") : "(none)";
    throw new NaxError(`Profile "${profileName}" not found. Available: ${availableList}`, "PROFILE_NOT_FOUND", {
      stage: "config",
      profileName,
      available,
    });
  }

  let base: Record<string, unknown> = {};

  if (globalExists) {
    base = await globalFile.json();
  }

  if (projectExists) {
    const projectData = await projectFile.json();
    base = deepMergeConfig(base, projectData);
  }

  return base;
}

/**
 * Snapshot of `process.env` (via `_profileDeps.env` for testability) with
 * secret-shaped keys excluded — see SENSITIVE_ENV_KEY_PATTERN. Used as the
 * base `$VAR` substitution env everywhere config `$VAR`/`${VAR}` references
 * are resolved: profile chains (loadProfileEnv) and the global/project/
 * per-package config layers (CFG-2/CFG-3), which have no companion .env file
 * of their own.
 */
export function sensitiveFilteredProcessEnv(): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(_profileDeps.env)) {
    if (value !== undefined && !SENSITIVE_ENV_KEY_PATTERN.test(key)) filtered[key] = value;
  }
  return filtered;
}

/**
 * Loads and merges .env files for a named profile.
 * Project values override global, and both override process.env entries.
 * Returns an empty record when no .env files exist.
 */
export async function loadProfileEnv(profileName: string, projectRoot: string): Promise<Record<string, string>> {
  validateProfileName(profileName);
  const globalPath = join(globalConfigDir(), "profiles", `${profileName}.env`);
  const projectPath = join(projectConfigDir(projectRoot), "profiles", `${profileName}.env`);

  const globalFile = Bun.file(globalPath);
  const projectFile = Bun.file(projectPath);

  const [globalExists, projectExists] = await Promise.all([globalFile.exists(), projectFile.exists()]);

  // BUG-21 — process.env is the base layer so `$HOME`/`$GITHUB_TOKEN`-style
  // references resolve even when a profile's own .env files don't redefine
  // them, matching this function's documented contract ("both override
  // process.env entries"). Previously process.env was never folded in at
  // all, so any reference to an ambient (not profile-redefined) var
  // hard-failed config load before zod ever ran.
  let merged: Record<string, string> = sensitiveFilteredProcessEnv();

  if (!globalExists && !projectExists) {
    return merged;
  }

  if (globalExists) {
    const globalContent = await globalFile.text();
    merged = { ...merged, ...parseDotenv(globalContent) };
  }

  if (projectExists) {
    const projectContent = await projectFile.text();
    merged = { ...merged, ...parseDotenv(projectContent) };
  }

  return merged;
}

/**
 * Normalizes a profile override into an ordered chain of profile names.
 *
 * Accepts the comma form (`"a,b"`) AND the array form (`["a", "b"]`, from
 * repeated `--profile` flags); array entries may themselves contain commas and
 * are flattened. Whitespace is trimmed and empty segments dropped. Order is
 * preserved (later entries override earlier ones); duplicates are NOT removed.
 *
 * SSOT for "turn a profile override value into a chain" — used by the CLI,
 * loader, and run-side resolver so the comma form behaves identically everywhere.
 */
export function parseProfileList(input: string | string[] | null | undefined): string[] {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const segment of part.split(",")) {
      const trimmed = segment.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Derives the profile override to re-feed into `loadConfigForWorkdir` when
 * resolving a per-package / per-story effective config from an already-loaded
 * root config.
 *
 * Returns the resolved chain as an array (which {@link parseProfileList}
 * round-trips cleanly) — NEVER the composite display string (`"a+b"`), because
 * that string is joined with `+` and parseProfileList only splits on `,`, so
 * re-feeding it would resolve a bogus single profile named `"a+b"`.
 */
export function profileOverrideFromConfig(config: {
  profile?: string;
  profileChain?: string[];
}): { profile: string[] } | undefined {
  if (config.profileChain && config.profileChain.length > 0) {
    return { profile: config.profileChain };
  }
  // Back-compat: a config carrying only the single `profile` string (e.g. a
  // hand-built NaxConfig in tests, or a pre-chain serialized config).
  if (config.profile && config.profile !== "default") {
    return { profile: [config.profile] };
  }
  return undefined;
}

/** Reads and parses the `profile` field of a config.json in the given dir into a chain. */
async function readProfileChainFromConfig(dir: string): Promise<string[]> {
  const configFile = Bun.file(join(dir, "config.json"));
  if (!(await configFile.exists())) return [];
  const config = await configFile.json();
  return parseProfileList(config.profile as string | string[] | undefined);
}

/** A chain that carries no meaningful overlay (empty, or only the implicit "default"). */
function isDefaultOnlyChain(chain: string[]): boolean {
  return chain.length === 0 || (chain.length === 1 && chain[0] === "default");
}

/**
 * Resolves the active profile chain using priority:
 * CLI option > NAX_PROFILE env var > project config.json > global config.json > ["default"]
 *
 * Every source accepts the comma form (and the CLI also the array form). The
 * config.json fallback applies project before global — consistent with the
 * config merge order where project overrides global. A source that resolves to
 * only "default" is treated as unset and falls through to the next source.
 */
export async function resolveProfileNames(
  cliOptions: { profile?: string | string[] },
  env: Record<string, string | undefined>,
  projectRoot: string,
): Promise<string[]> {
  const fromCli = parseProfileList(cliOptions.profile);
  if (fromCli.length) return fromCli;

  const fromEnv = parseProfileList(env.NAX_PROFILE);
  if (fromEnv.length) return fromEnv;

  // Project config.json takes precedence over global config.json
  const projectChain = await readProfileChainFromConfig(projectConfigDir(projectRoot));
  if (!isDefaultOnlyChain(projectChain)) return projectChain;

  // Fall back to global config.json
  const globalChain = await readProfileChainFromConfig(globalConfigDir());
  if (!isDefaultOnlyChain(globalChain)) return globalChain;

  return ["default"];
}

/**
 * Resolves the single active profile name (back-compat wrapper around
 * {@link resolveProfileNames}). Returns the last meaningful name in the chain,
 * or "default" when nothing is set.
 */
export async function resolveProfileName(
  cliOptions: { profile?: string | string[] },
  env: Record<string, string | undefined>,
  projectRoot: string,
): Promise<string> {
  const chain = await resolveProfileNames(cliOptions, env, projectRoot);
  return chain[chain.length - 1] ?? "default";
}

/** Internal helper — returns deduplicated sorted profile names from both scopes. */
async function listAvailableProfileNames(projectRoot: string): Promise<string[]> {
  const entries = await listProfiles(projectRoot);
  const names = [...new Set(entries.map((e) => e.name))].sort();
  return names;
}

/**
 * Scans both global and project .nax/profiles/ directories and returns
 * profile names with their paths.
 */
export async function listProfiles(projectRoot: string): Promise<ProfileEntry[]> {
  const globalProfilesDir = join(globalConfigDir(), "profiles");
  const projectProfilesDir = join(projectConfigDir(projectRoot), "profiles");

  const entries: ProfileEntry[] = [];

  for (const dir of [globalProfilesDir, projectProfilesDir]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (file.endsWith(".json")) {
        const name = file.replace(/\.json$/, "");
        entries.push({ name, path: join(dir, file) });
      }
    }
  }

  return entries;
}
