/**
 * dotenv.ts — Pure utility functions for dotenv parsing and env var resolution.
 *
 * Story US-001-B
 */

/**
 * Parses a dotenv value that starts with a quote character. Returns the
 * unescaped value (double-quoted values support `\"`, `\\`, `\n` escapes;
 * single-quoted values are literal, per standard dotenv semantics). Anything
 * after the closing quote (e.g. a trailing `# comment`) is discarded.
 */
function parseQuotedValue(raw: string, quote: '"' | "'"): string {
  let value = "";
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (quote === '"' && c === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") {
        value += "\n";
        i++;
        continue;
      }
      if (next === '"' || next === "\\") {
        value += next;
        i++;
        continue;
      }
      value += c;
      continue;
    }
    if (c === quote) {
      return value;
    }
    value += c;
  }
  // Unterminated quote — treat the rest of the line as the (unescaped) value.
  return value;
}

/**
 * Strips an inline `# comment` from an unquoted value — a `#` counts as a
 * comment marker only when it starts the value or is preceded by whitespace,
 * matching standard dotenv/shell behaviour (`FOO=bar#baz` keeps the `#`).
 */
function stripInlineComment(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/**
 * Parses dotenv file contents into a string record.
 * Strips comments (outside quotes), blank lines, export prefixes (including
 * the whole-assignment-quoted `export "KEY=value"` form), and quotes —
 * unescaping `\"`/`\\`/`\n` in double-quoted values.
 */
export function parseDotenv(content: string): Record<string, string> {
  if (!content) return {};

  const result: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();

    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("export ")) {
      line = line.slice(7).trim();
      // `export "KEY=value"` — the whole assignment is quoted, not just the value.
      if (line.length >= 2 && (line[0] === '"' || line[0] === "'") && line.endsWith(line[0])) {
        line = line.slice(1, -1);
      }
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();

    let value: string;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      value = parseQuotedValue(rawValue, rawValue[0] as '"' | "'");
    } else {
      value = stripInlineComment(rawValue).trim();
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

const DOUBLE_DOLLAR_PLACEHOLDER = "`__DOLLAR_ESCAPE__`";
// Matches the placeholder sentinel followed by an identifier (bare or brace
// form). The backtick wraps the marker so a user-authored literal that
// happens to spell the marker without backticks (e.g. `__DOLLAR_ESCAPE__HOME`)
// is not confused with a protected escape in the restoration pass — the bare
// text lacks the backtick delimiters and so does not match this regex.
const DOUBLE_DOLLAR_PLACEHOLDER_RE = new RegExp(
  `${DOUBLE_DOLLAR_PLACEHOLDER}(\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);

function resolveString(str: string, env: Record<string, string>, path: string[]): string {
  const resolveOne = (varName: string): string => {
    if (!(varName in env)) {
      throw new UnresolvedEnvVarError(varName, path);
    }
    return env[varName];
  };
  // First protect $$VAR/$${VAR} escapes, then resolve $VAR and ${VAR}
  // references (CFG-5 — the brace form previously passed through literally),
  // then restore the escaped form.
  return str
    .replace(/\$\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, `${DOUBLE_DOLLAR_PLACEHOLDER}$1`)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => resolveOne(varName))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => resolveOne(varName))
    .replace(DOUBLE_DOLLAR_PLACEHOLDER_RE, "$$$1");
}
