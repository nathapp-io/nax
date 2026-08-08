/**
 * Pure `git status --porcelain` parser.
 *
 * Split out of `src/utils/git.ts` so the parser's string-handling code lives
 * on its own and tests can exercise it directly without involving the
 * `autoCommitIfDirty` orchestration in the same module. `src/utils/git.ts`
 * re-exports the public API so existing callers keep working.
 *
 * No I/O — the parser operates entirely on a porcelain string. All subprocess
 * spawning for `git status` itself lives in `src/utils/git.ts`.
 */

/**
 * One protected-path entry returned by `parsePorcelainForNaxPaths`.
 *
 * `staged` is true when the deletion/rename is already reflected in the index
 * (porcelain status has `D` or `R` in the index column). The auto-commit uses
 * this to choose between `git checkout -- <path>` (restore from the index — for
 * unstaged deletions, where the index still has the file) and
 * `git checkout HEAD -- <path>` (restore from the commit — for staged
 * deletions/renames, where the index says the file is gone and only HEAD
 * still has it).
 */
export interface NaxProtectedPath {
  /** The path to restore (the OLD path for renames, unquoted). */
  path: string;
  /** True when the index already records the deletion/rename. */
  staged: boolean;
}

/**
 * Parse `git status --porcelain` output and return the set of deleted-or-renamed
 * paths whose path lies under a `.nax/` segment. Structural discriminator — any
 * deletion or rename touching a `.nax/` segment is treated as a stray-agent
 * mistake the auto-commit must restore before staging.
 *
 * Exported so tests can exercise the parser against real porcelain strings
 * rather than via a spawn mock. Pure — no I/O.
 *
 * Porcelain format reference:
 *   `XY path` for non-renames, `XY old -> new` for renames. The XY status
 *   column is two characters: index (X) and worktree (Y). A deletion shows as
 *   ` D` (unstaged-delete), `D ` (staged-delete), or `DD` (both); a rename
 *   shows as `R ` (staged-rename) or ` R` (unstaged-rename). Paths containing
 *   special characters come back quoted by git (double quotes around the path,
 *   internal backslashes and quotes escaped). We unquote via a small parser
 *   rather than shelling out so the call is deterministic and testable.
 *
 * @param porcelain - The stdout of `git status --porcelain`
 * @returns Array of protected-path entries (old path for renames), in input order
 */
export function parsePorcelainForNaxPaths(porcelain: string): NaxProtectedPath[] {
  const protectedPaths: NaxProtectedPath[] = [];
  if (!porcelain) return protectedPaths;

  for (const rawLine of porcelain.split("\n")) {
    if (!rawLine) continue;
    // Malformed lines (e.g. status shorter than 3 chars) are not actionable.
    if (rawLine.length < 4) continue;
    const xStatus = rawLine[0];
    const yStatus = rawLine[1];
    // "?? untracked" has no meaningful index/worktree status — skip.
    if (xStatus === "?" && yStatus === "?") continue;
    // We only restore deletions and renames; modifications stay as the agent
    // left them. `D` in either column counts — `D ` is staged-delete (e.g.
    // after `git rm .nax/...`) and `git add -A` would otherwise keep it
    // staged, losing the path without a `git checkout` first.
    const isDeleted = xStatus === "D" || yStatus === "D";
    const isRename = xStatus === "R" || yStatus === "R";
    if (!isDeleted && !isRename) continue;

    // The deletion/rename is "staged" when the index column carries the
    // status letter. That is the case where the index no longer has the old
    // path and the restore must source from HEAD rather than the index.
    const staged = xStatus === "D" || xStatus === "R";

    const pathField = rawLine.slice(3);
    // Renames: "old -> new" — restore the OLD path so the file reappears at
    // the agent's last known location in HEAD. Splitting at the first ` -> `
    // is unsafe when the OLD path is quoted and itself contains ` -> `, so we
    // walk past a leading quoted region before searching for the separator.
    let targetPath: string;
    if (isRename) {
      const oldPath = splitRenameOldPath(pathField);
      if (oldPath === null) continue;
      targetPath = oldPath;
    } else {
      targetPath = pathField;
    }
    targetPath = unquotePorcelainPath(targetPath);

    // Structural check: any path segment equal to `.nax` qualifies. This is
    // broader than "the acceptance target" and deliberately so — it also
    // protects `prd.json`, `checkpoint.jsonl`, and `acceptance-meta.json`.
    if (!targetPath.split("/").includes(".nax")) continue;

    protectedPaths.push({ path: targetPath, staged });
  }
  return protectedPaths;
}

/**
 * Strip surrounding double quotes from a porcelain path and decode C-style
 * escape sequences that git emits inside quoted paths. Pure — no I/O.
 *
 * Git's `core.quotePath=true` (the default) wraps a path in double quotes and
 * escapes any byte that is unusual on a terminal:
 *   - `\\`      → `\`
 *   - `\"`      → `"`
 *   - `\NNN`    → byte with octal value NNN (1–3 digits, 000–377). Used for
 *                 non-ASCII UTF-8 bytes such as `é` → `\303\251`.
 *   - `\xNN`    → byte with hex value NN.
 *   - `\a\b\t\n\v\f\r` → the corresponding control character.
 *
 * Bytes that are not part of an escape sequence are passed through unchanged.
 * If the path is not double-quoted (the common case for ASCII-only paths with
 * no shell-special characters), it is returned as-is — git leaves such paths
 * bare in porcelain output.
 *
 * Non-ASCII escapes are emitted as raw bytes and decoded as UTF-8 at the end
 * so the result is a proper JS string that round-trips to the actual file
 * path on disk. Building the string byte-by-byte and decoding UTF-8 at the
 * end (rather than `String.fromCharCode` per byte) avoids the mojibake that
 * would otherwise corrupt a multi-byte UTF-8 sequence into several invalid
 * code points.
 */
function unquotePorcelainPath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\" || i + 1 >= inner.length) {
      bytes.push(c.charCodeAt(0));
      continue;
    }
    const next = inner[i + 1];
    if (next === '"' || next === "\\") {
      bytes.push(next.charCodeAt(0));
      i++;
      continue;
    }
    if (next === "a") {
      bytes.push(0x07);
      i++;
      continue;
    }
    if (next === "b") {
      bytes.push(0x08);
      i++;
      continue;
    }
    if (next === "t") {
      bytes.push(0x09);
      i++;
      continue;
    }
    if (next === "n") {
      bytes.push(0x0a);
      i++;
      continue;
    }
    if (next === "v") {
      bytes.push(0x0b);
      i++;
      continue;
    }
    if (next === "f") {
      bytes.push(0x0c);
      i++;
      continue;
    }
    if (next === "r") {
      bytes.push(0x0d);
      i++;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let j = i + 1;
      let digits = "";
      while (j < inner.length && digits.length < 3 && inner[j] >= "0" && inner[j] <= "7") {
        digits += inner[j];
        j++;
      }
      const byte = Number.parseInt(digits, 8);
      if (!Number.isNaN(byte)) {
        bytes.push(byte);
        i = j - 1;
        continue;
      }
    }
    if (next === "x") {
      const slice = inner.slice(i + 2, i + 4);
      if (slice.length === 2 && /^[0-9a-fA-F]{2}$/.test(slice)) {
        bytes.push(Number.parseInt(slice, 16));
        i += 3;
        continue;
      }
    }
    // Unknown escape — preserve the backslash verbatim so the path is at least
    // surfaced for debugging rather than silently corrupted.
    bytes.push(c.charCodeAt(0));
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/**
 * Given the path-field of a porcelain rename line (`"old" -> new` or
 * `old -> new`), return the OLD path with its leading quote preserved so the
 * caller can hand it to `unquotePorcelainPath`. Returns null if no
 * out-of-quotes ` -> ` separator is found.
 *
 * Naive `indexOf(" -> ")` truncates the OLD path when it is quoted and itself
 * contains ` -> ` (e.g. a file literally named `foo -> bar.txt`). This helper
 * walks past a leading quoted region before searching for the separator.
 */
function splitRenameOldPath(pathField: string): string | null {
  let start = 0;
  if (pathField.startsWith('"')) {
    // Walk the quoted region, respecting backslash escapes so `\"` does not
    // close the quote.
    let i = 1;
    while (i < pathField.length) {
      const c = pathField[i];
      if (c === "\\" && i + 1 < pathField.length) {
        i += 2;
        continue;
      }
      if (c === '"') {
        start = i + 1;
        break;
      }
      i++;
    }
  }
  const arrowIdx = pathField.indexOf(" -> ", start);
  if (arrowIdx < 0) return null;
  return pathField.slice(0, arrowIdx);
}
