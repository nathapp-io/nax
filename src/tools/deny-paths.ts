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
  // Case-insensitive, and both sides NFC-normalized at the call site.
  // macOS and Windows default to case-insensitive filesystems, where ".ENV"
  // and ".env" are one file -- a case-sensitive compare there lets a denied
  // path be deleted by respelling it (nax#1972, reproduced). Applying the
  // flag unconditionally rather than probing the filesystem keeps the rule
  // one predictable thing: on a case-sensitive filesystem this over-refuses
  // a genuinely distinct ".ENV", which is the direction a denylist should
  // fail in.
  return new RegExp(`^${out}$`, "i");
}

/**
 * Does `relativePath` match any pattern in `denyPaths`?
 *
 * `relativePath` MUST already be canonical and repo-relative -- the caller
 * derives it from the resolved entry, never from `input.path`. This is not a
 * stylistic preference: matching the caller's own spelling means the denylist
 * and the policy that approved the call are reading different strings, and
 * every alternate spelling of one file ("./x", "x//y", "a/../x") walks past
 * the denylist (nax#1972, reproduced). Repo-relative rather than absolute so
 * a pattern is rooted at the repo, not at the filesystem.
 *
 * Both sides are NFC-normalized before comparison. macOS stores filenames
 * decomposed (NFD), so a pattern typed in a config file and the path that
 * comes back off disk can be byte-different while naming one file.
 */
export function matchesDenyPaths(relativePath: string, denyPaths: readonly string[] | undefined): boolean {
  if (denyPaths === undefined || denyPaths.length === 0) return false;
  const candidate = relativePath.normalize("NFC");
  return denyPaths.some((pattern) => globToRegExp(pattern.normalize("NFC")).test(candidate));
}
