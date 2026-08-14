/**
 * dotenv.ts — Pure utility functions for dotenv parsing and env var resolution.
 *
 * Story US-001-B
 */

/**
 * Parses dotenv file contents into a string record.
 * Strips comments, blank lines, export prefixes, and quotes.
 */
export function parseDotenv(content: string): Record<string, string> {
  if (!content) return {};

  const result: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eqIndex = stripped.indexOf("=");
    if (eqIndex === -1) continue;

    const key = stripped.slice(0, eqIndex).trim();
    let value = stripped.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Recursively walks a config object and replaces $VAR references with values
 * from the provided env map. Supports inline substitution, double-dollar
 * escaping ($$VAR → $VAR), and pass-through of non-string values.
 *
 * @param path - Internal recursion accumulator (JSON key path to the current
 *   node, e.g. `["agent", "default"]`) — surfaced on `UnresolvedEnvVarError`
 *   so callers can report exactly where an unresolved `$VAR` was found.
 */
export function resolveEnvVars(config: unknown, env: Record<string, string>, path: string[] = []): unknown {
  if (typeof config === "string") {
    return resolveString(config, env, path);
  }

  if (Array.isArray(config)) {
    return config.map((item, i) => resolveEnvVars(item, env, [...path, String(i)]));
  }

  if (config !== null && typeof config === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value, env, [...path, key]);
    }
    return result;
  }

  return config;
}

/**
 * BUG-21 — thrown by resolveString when a `$VAR` reference has no matching
 * entry in the resolved env map. Carries `varName` and `path` (the JSON key
 * path to the string containing the reference) so callers (loader.ts,
 * cli/config-profile.ts) can wrap it in a `NaxError` naming the profile.
 */
export class UnresolvedEnvVarError extends Error {
  constructor(
    readonly varName: string,
    readonly path: string[],
  ) {
    super(`Environment variable $${varName} is not defined (at config path "${path.join(".") || "(root)"}")`);
    this.name = "UnresolvedEnvVarError";
  }
}

const DOUBLE_DOLLAR_PLACEHOLDER = "__DOLLAR_ESCAPE__";

function resolveString(str: string, env: Record<string, string>, path: string[]): string {
  // First protect $$VAR escapes, then resolve $VAR references, then restore
  return str
    .replace(/\$\$([A-Za-z_][A-Za-z0-9_]*)/g, `${DOUBLE_DOLLAR_PLACEHOLDER}$1`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => {
      if (!(varName in env)) {
        throw new UnresolvedEnvVarError(varName, path);
      }
      return env[varName];
    })
    .replace(new RegExp(`${DOUBLE_DOLLAR_PLACEHOLDER}([A-Za-z_][A-Za-z0-9_]*)`, "g"), "$$$1");
}
