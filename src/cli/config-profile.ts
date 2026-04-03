/**
 * config-profile.ts — CLI handlers for profile subcommands.
 *
 * Story US-003: Profile CLI commands (list, show, use, current, create)
 */

export interface ProfileShowOptions {
  unmask: boolean;
}

export const _profileCLIDeps = {
  env: process.env as Record<string, string | undefined>,
};

/**
 * Lists all profiles from global and project scopes, grouped by scope label.
 * The active profile is marked with "*".
 */
export async function profileListCommand(_startDir: string): Promise<string> {
  throw new Error("not implemented");
}

/**
 * Displays resolved profile JSON for the given profile name.
 * When unmask=false, masks values from $VAR substitution and keys matching
 * /key|token|secret|password|credential/i as "***".
 * When unmask=true, shows raw values and prepends a WARNING banner.
 */
export async function profileShowCommand(
  _profileName: string,
  _startDir: string,
  _opts: ProfileShowOptions,
): Promise<string> {
  throw new Error("not implemented");
}

/**
 * Writes the profile name into .nax/config.json.
 * When profileName is "default", removes the profile field entirely.
 * Returns a confirmation message.
 */
export async function profileUseCommand(_profileName: string, _startDir: string): Promise<string> {
  throw new Error("not implemented");
}

/**
 * Returns the resolved profile name following the priority chain:
 * CLI env (NAX_PROFILE) > config.json > "default".
 */
export async function profileCurrentCommand(_startDir: string): Promise<string> {
  throw new Error("not implemented");
}

/**
 * Scaffolds an empty profile JSON file at .nax/profiles/{name}.json.
 * Throws if the profile already exists.
 * Returns the created file path.
 */
export async function profileCreateCommand(_profileName: string, _startDir: string): Promise<string> {
  throw new Error("not implemented");
}
