/**
 * config-profile.ts — CLI handlers for profile subcommands.
 *
 * Story US-003: Profile CLI commands (list, show, use, current, create)
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveEnvVars } from "../config/dotenv";
import { globalConfigDir, projectConfigDir } from "../config/paths";
import { loadProfile, loadProfileEnv, resolveProfileName, validateProfileName } from "../config/profile";
import { NaxError } from "../errors";

export interface ProfileShowOptions {
  unmask: boolean;
}

export const _profileCLIDeps = {
  env: process.env as Record<string, string | undefined>,
};

// Deliberately narrower than SENSITIVE_ENV_KEY_PATTERN in config/profile.ts.
// That pattern only gates which ambient process.env vars get folded into a
// profile's $VAR base — a false positive there just means an explicit .env
// entry is required. This pattern instead masks KEYS across the entire
// NaxConfig tree for display (maskProfileValues is reused by both `nax
// config profile show` and `nax config`/`--explain`, cli/config-display.ts).
// A false positive here masks a whole subtree of a legitimate config
// section to a single "***" string, destroying real (non-secret) data — the
// BUG-37 broadening (adding auth|session|url|...) matched non-secret
// container keys like "tdd.sessionTiers" and "debate.*.sessionMode",
// breaking `nax config --explain` output. Keep this pattern narrow.
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;
const VAR_PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*/;

// Key names the pattern matches that never carry a secret. "Tokens" here
// counts LLM context, and "keyword" merely contains "key" — masking these
// destroyed real declared config, printing every one as "***" in
// `nax config`. agent.native.catalogOverrides[].maxTokens is how it
// surfaced: the operator's own declared output ceiling, unreadable in the
// one command that exists to show it (nax#1982).
//
// An explicit NAME list, deliberately not a value-type rule ("a number
// cannot be a secret"). loadProfile returns raw un-Zod'd JSON
// (config/profile.ts), so a profile may carry any key at all — and under a
// type rule a numeric passcode written as `"password": 8675309` would print
// in cleartext in the DEFAULT, non---unmask view, which exists precisely to
// be safe to paste into an issue. Narrowing by name cannot widen exposure:
// it only ever unmasks names listed right here.
//
// Kept current by a drift test in config-profile.test.ts, which walks
// DEFAULT_CONFIG and fails when a new non-string config key matches the
// pattern without being listed here.
const SENSITIVE_KEY_EXEMPTIONS = new Set([
  "maxTokens",
  "budgetTokens",
  "contextProviderTokenBudget",
  "emptyKeyword",
  "fallbackToKeywords",
  "recentKeyWindow",
]);

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

/**
 * Keys whose value is a header map, every value of which is masked (nax#2019).
 *
 * SENSITIVE_KEY_PATTERN cannot catch these: the commonest credential header is
 * `Authorization`, which contains none of key/token/secret/password/credential,
 * so a bearer token under `headers` printed in clear — in `nax config` too,
 * which shares this masker (config-display.ts, SEC-05).
 *
 * Values rather than the map wholesale, unlike a subtree under a sensitive key.
 * A header map is Record<string, string>: there is no deeper nesting for a
 * secret to hide in, so masking every value is already complete, and keeping
 * the NAMES readable is what makes a misrouted request diagnosable.
 */
const HEADER_MAP_KEYS = new Set(["headers"]);

/** Masks every value of a header map, preserving the header names. */
function maskHeaderValues(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return maskProfileValue(value);
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(value as Record<string, unknown>)) result[name] = "***";
  return result;
}

export function maskProfileValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && !SENSITIVE_KEY_EXEMPTIONS.has(key)) {
      result[key] = "***";
    } else if (HEADER_MAP_KEYS.has(key)) {
      result[key] = maskHeaderValues(value);
    } else {
      result[key] = maskProfileValue(value);
    }
  }
  return result;
}

/**
 * BUG-36: array elements are recursed into (not just skipped) so secrets
 * nested inside an array — e.g. `config.plugins[].config.apiKey` — are
 * masked the same way they would be outside an array.
 */
function maskProfileValue(value: unknown): unknown {
  if (typeof value === "string") {
    return VAR_PATTERN.test(value) ? "***" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskProfileValue(item));
  }
  if (value !== null && typeof value === "object") {
    return maskProfileValues(value as Record<string, unknown>);
  }
  return value;
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

  // Verify the profile actually exists before poisoning .nax/config.json with a
  // dangling reference — loadProfile throws a NaxError naming the available
  // profiles when it doesn't, which is exactly what a typo'd name needs (BUG-50).
  // A typo previously broke the next `nax run` with a confusing downstream error
  // instead of failing here where the mistake was made.
  await loadProfile(profileName, startDir);

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
  // SEC-18: the read side (loadProfile/loadProfileEnv) validates before
  // joining profileName into a path; the create/write side must too — the
  // asymmetry let `nax config profile create "../../evil"` escape profilesDir.
  validateProfileName(profileName);
  const profilesDir = join(projectConfigDir(startDir), "profiles");
  const profilePath = join(profilesDir, `${profileName}.json`);

  const profileFile = Bun.file(profilePath);
  if (await profileFile.exists()) {
    throw new NaxError(`Profile "${profileName}" already exists at ${profilePath}`, "PROFILE_ALREADY_EXISTS", {
      stage: "cli",
      profileName,
      profilePath,
    });
  }

  mkdirSync(profilesDir, { recursive: true });
  await Bun.write(profilePath, "{}");

  return profilePath;
}
