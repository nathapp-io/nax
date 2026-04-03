/**
 * config-profile.ts — CLI handlers for profile subcommands.
 *
 * Story US-003: Profile CLI commands (list, show, use, current, create)
 */

import { mkdirSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveEnvVars } from "../config/dotenv";
import { globalConfigDir, projectConfigDir } from "../config/paths";
import { loadProfile, loadProfileEnv, resolveProfileName } from "../config/profile";

export interface ProfileShowOptions {
  unmask: boolean;
}

export const _profileCLIDeps = {
  env: process.env as Record<string, string | undefined>,
};

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;
const VAR_PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Lists all profiles from global and project scopes, grouped by scope label.
 * The active profile is marked with "*".
 */
export async function profileListCommand(startDir: string): Promise<string> {
  const globalProfilesDir = join(globalConfigDir(), "profiles");
  const projectProfilesDir = join(projectConfigDir(startDir), "profiles");

  const globalProfiles = scanProfileDir(globalProfilesDir);
  const projectProfiles = scanProfileDir(projectProfilesDir);

  const activeProfile = await resolveProfileName({}, _profileCLIDeps.env, startDir);

  const lines: string[] = [];

  lines.push("global:");
  if (globalProfiles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of globalProfiles) {
      const marker = name === activeProfile ? "* " : "  ";
      lines.push(`${marker}${name}`);
    }
  }

  if (projectProfiles.length > 0) {
    lines.push("project:");
    for (const name of projectProfiles) {
      const marker = name === activeProfile ? "* " : "  ";
      lines.push(`${marker}${name}`);
    }
  }

  return lines.join("\n");
}

function scanProfileDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Displays resolved profile JSON for the given profile name.
 * When unmask=false, masks values from $VAR substitution and keys matching
 * /key|token|secret|password|credential/i as "***".
 * When unmask=true, shows raw values and prepends a WARNING banner.
 */
export async function profileShowCommand(
  profileName: string,
  startDir: string,
  opts: ProfileShowOptions,
): Promise<string> {
  const rawProfile = await loadProfile(profileName, startDir);
  const envVars = await loadProfileEnv(profileName, startDir);

  if (opts.unmask) {
    const resolved = resolveEnvVars(rawProfile, envVars) as Record<string, unknown>;
    const warning = "WARNING: Sensitive values are displayed in plaintext.";
    return `${warning}\n${JSON.stringify(resolved, null, 2)}`;
  }

  const masked = maskProfileValues(rawProfile);
  return JSON.stringify(masked, null, 2);
}

function maskProfileValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "***";
    } else if (typeof value === "string" && VAR_PATTERN.test(value)) {
      result[key] = "***";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = maskProfileValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Writes the profile name into .nax/config.json.
 * When profileName is "default", removes the profile field entirely.
 * Returns a confirmation message.
 */
export async function profileUseCommand(profileName: string, startDir: string): Promise<string> {
  const configPath = join(projectConfigDir(startDir), "config.json");
  const configFile = Bun.file(configPath);

  let existing: Record<string, unknown> = {};
  if (await configFile.exists()) {
    existing = await configFile.json();
  }

  if (profileName === "default") {
    const { profile: _removed, ...rest } = existing;
    await Bun.write(configPath, JSON.stringify(rest, null, 2));
    return "Profile reset to default.";
  }

  const updated = { ...existing, profile: profileName };
  await Bun.write(configPath, JSON.stringify(updated, null, 2));
  return `Now using profile: ${profileName}`;
}

/**
 * Returns the resolved profile name following the priority chain:
 * CLI env (NAX_PROFILE) > config.json > "default".
 */
export async function profileCurrentCommand(startDir: string): Promise<string> {
  return resolveProfileName({}, _profileCLIDeps.env, startDir);
}

/**
 * Scaffolds an empty profile JSON file at .nax/profiles/{name}.json.
 * Throws if the profile already exists.
 * Returns the created file path.
 */
export async function profileCreateCommand(profileName: string, startDir: string): Promise<string> {
  const profilesDir = join(projectConfigDir(startDir), "profiles");
  const profilePath = join(profilesDir, `${profileName}.json`);

  const profileFile = Bun.file(profilePath);
  if (await profileFile.exists()) {
    throw new Error(`Profile "${profileName}" already exists at ${profilePath}`);
  }

  mkdirSync(profilesDir, { recursive: true });
  await Bun.write(profilePath, "{}");

  return profilePath;
}
