/**
 * Pure helpers for MCP catalog entries: provider-safe server ids and shell-style
 * `${VAR}` / `${VAR:-default}` expansion. No I/O, no diagnostics — the merge
 * consumer picks the base name, builds `vars`, walks the connection fields and
 * turns an empty id or a `missing` variable into a dropped entry.
 */

/** `${NAME}` or `${NAME:-default}`; the default runs to the first `}` (no nesting). */
const MCP_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${NAME}` and `${NAME:-default}` in `value` from `vars`.
 *
 * `${NAME}` is `vars[NAME]` (an empty string is a value). `${NAME:-default}` is
 * `vars[NAME]` when set and non-empty, otherwise `default` (shell `:-`). Anything
 * else — a bare `$`, a malformed name, an unterminated `${` — is copied literally.
 * Returns `{ missing }` naming the first unset variable that has no default.
 */
export function expandMcpValue(
  value: string,
  vars: Readonly<Record<string, string | undefined>>,
): { readonly value: string } | { readonly missing: string } {
  let missing: string | undefined;
  const expanded = value.replace(MCP_VAR_RE, (_match, name: string, fallback: string | undefined) => {
    const current = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (fallback !== undefined) return current !== undefined && current !== "" ? current : fallback;
    if (current === undefined) {
      missing ??= name;
      return "";
    }
    return current;
  });
  return missing === undefined ? { value: expanded } : { missing };
}

/**
 * Normalize an entry's base name into a provider-safe server id.
 *
 * Lowercases, collapses each run of characters outside `[a-z0-9_-]` to `-`,
 * collapses runs of `_` to one, and strips leading non-alphanumerics. Any
 * nonempty result matches `MCP_SERVER_ID_RE` and contains no `__`. Returns `""`
 * when nothing usable remains; the caller drops the entry.
 */
export function mcpServerId(base: string): string {
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/^[^a-z0-9]+/, "");
}
