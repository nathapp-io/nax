/**
 * dotenv.ts — Pure utility functions for dotenv parsing and env var resolution.
 *
 * Story US-001-B
 */

/**
 * Parses dotenv file contents into a string record.
 * Strips comments, blank lines, export prefixes, and quotes.
 */
export function parseDotenv(_content: string): Record<string, string> {
  throw new Error("Not implemented");
}

/**
 * Recursively walks a config object and replaces $VAR references with values
 * from the provided env map. Supports inline substitution, double-dollar
 * escaping ($$VAR → $VAR), and pass-through of non-string values.
 */
export function resolveEnvVars(_config: unknown, _env: Record<string, string>): unknown {
  throw new Error("Not implemented");
}
