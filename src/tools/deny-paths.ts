/**
 * Match a Delete candidate against the repo-configurable `denyPaths`
 * denylist (nax#1972, `execution.denyPaths` in config).
 *
 * A separate file rather than an addition to src/tools/policy.ts on purpose:
 * that file already carries the containment seam and is close to the
 * project's file-size ratchet, and denyPaths is a narrower, single-tool
 * concern -- it has nothing to do with resolving or containing a path, only
 * with refusing one the policy already approved.
 *
 * The glob syntax deliberately matches globToRegExp in policy.ts (`**` spans
 * separators, `*` does not) so a `denyPaths` entry reads the same way a
 * ToolGrant pattern does elsewhere in config -- one mental model for "what
 * does a glob mean in nax config", not two subtly different ones. The
 * implementation is a small, independent copy rather than an export from
 * policy.ts: that keeps this file free to be read (and reasoned about) on
 * its own, and keeps policy.ts's containment logic untouched by a change
 * that has nothing to do with containment.
 */

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does `relativePath` match any pattern in `denyPaths`?
 *
 * `relativePath` is the path as the caller wrote it (e.g. `input.path`),
 * matched exactly as a ToolGrant pattern would match a path field -- not the
 * resolved absolute path, which would make every pattern implicitly rooted
 * at the filesystem instead of at the repo.
 */
export function matchesDenyPaths(relativePath: string, denyPaths: readonly string[] | undefined): boolean {
  if (denyPaths === undefined || denyPaths.length === 0) return false;
  return denyPaths.some((pattern) => globToRegExp(pattern).test(relativePath));
}
