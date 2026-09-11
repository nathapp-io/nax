import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Split one string field into the path elements it really names.
 *
 * Lives on its own because two layers must agree on the answer exactly: the
 * policy resolves and grant-checks each element (`ToolScope.listPathFields`),
 * and the tool substitutes each element as its own shell argument. Were they
 * to disagree, the policy would approve one set of paths and the shell would
 * receive another (nax#1998).
 *
 * Whitespace is the separator, but only for a value that is really a LIST.
 * `{{files}}` is a project-declared placeholder and a project may mean a NAME
 * filter by it (`pytest -k {{files}}`, `jest -t {{files}}`), while a path may
 * itself contain a space. Splitting unconditionally would turn one filter into
 * several arguments and break any repo under `/tmp/my dir/`. So a multi-token
 * value splits only when at least one token is an existing FILE — the same
 * evidence #1936 already uses to tell a path from a filter, applied one level
 * up. Everything else is returned whole, which is the pre-#1998 behaviour.
 *
 * An empty or whitespace-only value returns `[value]`, never `[]`: an empty
 * list would leave a caller's per-element loop with nothing to check, and the
 * field would be approved by falling off the end of it.
 */
export function pathListElements(value: string, root: string): string[] {
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length <= 1) return [value];
  if (!tokens.some((token) => isExistingFile(token, root))) return [value];
  return tokens;
}

function isExistingFile(candidate: string, root: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  return statSync(absolute, { throwIfNoEntry: false })?.isFile() === true;
}
