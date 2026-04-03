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
 */
export function resolveEnvVars(config: unknown, env: Record<string, string>): unknown {
  if (typeof config === "string") {
    return resolveString(config, env);
  }

  if (Array.isArray(config)) {
    return config.map((item) => resolveEnvVars(item, env));
  }

  if (config !== null && typeof config === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value, env);
    }
    return result;
  }

  return config;
}

const DOUBLE_DOLLAR_PLACEHOLDER = "__DOLLAR_ESCAPE__";

function resolveString(str: string, env: Record<string, string>): string {
  // First protect $$VAR escapes, then resolve $VAR references, then restore
  return str
    .replace(/\$\$([A-Za-z_][A-Za-z0-9_]*)/g, `${DOUBLE_DOLLAR_PLACEHOLDER}$1`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => {
      if (!(varName in env)) {
        throw new Error(`Environment variable $${varName} (${varName}) is not defined`);
      }
      return env[varName];
    })
    .replace(new RegExp(`${DOUBLE_DOLLAR_PLACEHOLDER}([A-Za-z_][A-Za-z0-9_]*)`, "g"), "$$$1");
}
