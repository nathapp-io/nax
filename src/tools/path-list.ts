import { statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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
 * value decides by ordered evidence tiers (nax#1998 + US-002):
 *
 *   1. One token (or none) -> the whole value. Never an empty list: an empty
 *      list would leave a caller's per-element loop with nothing to check, and
 *      the field would be approved by falling off the end of it.
 *   2. The WHOLE value is an existing file -> the whole value. A path under
 *      `/tmp/my dir/` contains a space; its tokens are not separate paths. This
 *      is checked before every token-level test, so a space-bearing path can
 *      never be re-split.
 *   3. ANY token is an existing file or an existing DIRECTORY -> the tokens.
 *      The directory case is what gives `test/unit test/integration` two
 *      arguments today.
 *   4. EVERY token looks like a path -- contains a path separator, or ends in
 *      a file extension -> the tokens. This is deliberately language-neutral:
 *      it keys on path SYNTAX, never on a test-file naming convention, so it
 *      admits not-yet-created `test_foo.py` / `foo_test.go` / `Foo.test.ts`
 *      equally, without nax knowing the host project's language. It requires
 *      EVERY token to qualify, so a mixed name-filter-plus-path value where
 *      nothing exists keeps today's whole-value behaviour rather than guessing.
 *   5. Otherwise -> the whole value. A multi-token name filter lands here.
 */
export function pathListElements(value: string, root: string): string[] {
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length <= 1) return [value];
  if (isExistingFile(value, root)) return [value];
  if (tokens.some((token) => isExistingFile(token, root) || isExistingDir(token, root))) return tokens;
  if (tokens.every(looksLikePath)) return tokens;
  return [value];
}

function isExistingFile(candidate: string, root: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  return statSync(absolute, { throwIfNoEntry: false })?.isFile() === true;
}

function isExistingDir(candidate: string, root: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  return statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true;
}

function looksLikePath(token: string): boolean {
  return token.includes(sep) || /\.[A-Za-z0-9]+$/.test(token);
}
