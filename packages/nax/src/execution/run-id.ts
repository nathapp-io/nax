/**
 * Run ID — workdir-aware identifier for a run (US-005)
 *
 * Two worktrees of one project can both produce `run-<iso>` IDs at the same
 * ISO timestamp and clobber each other's log file and status.json. This
 * module is the single producer of run IDs: a short hash of the workdir
 * (anything but the basename, which collides for `git worktree add
 * ../repo-feat`) joined to a millisecond-precision ISO timestamp.
 *
 * The output contains no path separator and no character outside
 * [A-Za-z0-9._-] because it is interpolated into filenames and directory
 * names at more than 10 sites.
 */

/**
 * Build a workdir-aware run identifier for a run that started at `now`.
 *
 * The `workdir` is hashed (we cannot use the basename — two worktrees of one
 * project share one basename, e.g. `git worktree add ../repo-feat`). The
 * hash is included in the ID as a small lowercase-hex token.
 *
 * Filename safety: the returned string contains no path separator and no
 * character outside `[A-Za-z0-9._-]`.
 *
 * @param workdir - Absolute working directory the run is bound to.
 * @param now     - Wall-clock instant the run starts at.
 */
export function buildRunId(workdir: string, now: Date): string {
  // djb2-style hash of the absolute workdir. Short, deterministic, no
  // crypto dependency. Normalize trailing slashes so equivalent paths
  // (e.g. with/without trailing separator) hash identically.
  const normalized = stripTrailingSeparators(workdir);
  const hash = djb2Hex(normalized);

  // `now.toISOString()` is already YYYY-MM-DDTHH-mm-ss.sssZ — replace the
  // separators that would survive into a filename with `-` and drop the
  // trailing `Z` to keep the whole ID inside `[A-Za-z0-9._-]`. Millisecond
  // precision is preserved (`...000Z` → `...000`).
  const iso = now.toISOString().replace(/[:]/g, "-").replace(/Z$/, "");

  return `run-${hash}-${iso}`;
}

/**
 * Hash the normalized workdir with djb2 and return 8 lowercase hex chars.
 * 32 bits is plenty for the "different workdirs at the same instant"
 * collision property this SSOT is responsible for.
 */
function djb2Hex(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // djb2: hash * 33 + c, applied as unsigned 32-bit.
    hash = (hash * 33 + s.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stripTrailingSeparators(s: string): string {
  let end = s.length;
  while (end > 1 && (s[end - 1] === "/" || s[end - 1] === "\\")) {
    end--;
  }
  return s.slice(0, end);
}
