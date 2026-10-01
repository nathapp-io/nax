/** Matches ${VAR_NAME} — uppercase, digits, underscore. */
const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Resolve ${ENV_VAR} placeholders in header values from `env` (default
 * `process.env`). Returns the resolved header map and the de-duplicated list
 * of variable names that were referenced but not set. Never throws.
 */
export function interpolateHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): { resolved: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(ENV_PLACEHOLDER, (_match, name: string) => {
      const v = env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  return { resolved, missing: [...missing] };
}
