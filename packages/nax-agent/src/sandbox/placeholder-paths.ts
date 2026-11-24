/**
 * US-001 — where a Linux bwrap placeholder can appear, and what makes a path one.
 *
 * srt resolves its mandatory write-deny names (and nax's own literal `denyWrite`
 * entries) against `process.cwd()`, and for a deny path that is ABSENT whose
 * deepest existing ancestor is inside an allowed write root, bwrap creates a
 * mount placeholder at the first missing path component: an empty regular file
 * with mode 0444 and one link (the leaf), or an empty directory (an intermediate
 * component). Those placeholders are what the feature cleans up, so this module
 * answers the two questions every later step needs: which paths a wrap could
 * create one at, and whether a path on disk is still the very one recorded.
 *
 * Nothing here removes anything. `/proc` is not read here either: the parsers
 * live beside the answers they produce, and `placeholder-deps.ts` supplies the
 * host facts (the `/proc` files, the fs and the exit hook) through its
 * `_placeholderDeps` seam.
 *
 * Synchronous `node:fs` throughout, as `session-tmp.ts` is: the backend's
 * `commandFinished` and the exit listener that call into this are synchronous
 * (nax-agent is a Node library; it uses no Bun API).
 */
import { lstatSync, readdirSync, type Stats, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { NaxError } from "#src/infra/index";
import { SRT_MANDATORY_DENY_DIRS, SRT_MANDATORY_DENY_FILES } from "./defaults.ts";
import type { SandboxPolicy } from "./types.ts";

/** `/proc/<pid>/stat`'s starttime field number, counting from the whole line. */
const START_TICKS_FIELD = 22;

/** The field index of `START_TICKS_FIELD` after the last `)` (whose following field is field 3). */
const START_TICKS_AFTER_COMM_INDEX = START_TICKS_FIELD - 3;

/** `target` is `root` itself or lies beneath it — by path segment, so `/xy` is not under `/x`. */
function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when something (a file, a directory, a dangling symlink) occupies `path`. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // Any lstat failure — ENOENT, ENOTDIR, an unsearchable parent — means no
    // path is known to be there, so the caller may treat it as a gap.
    return false;
  }
}

/** True when `path` resolves to a directory (a worktree's `.git` file is not one). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Absent or unreadable: not a directory for our purposes.
    return false;
  }
}

/** A candidate mapped to the path a placeholder would appear at, with the ancestor that must be writable. */
interface FirstMissing {
  /** The first missing component of the candidate — the placeholder's path. */
  readonly placeholder: string;
  /** Its deepest EXISTING ancestor: the directory bwrap would create the placeholder in. */
  readonly anchor: string;
}

/**
 * The first missing path component of `candidate`, or `undefined` when the
 * candidate itself is on disk (srt creates no placeholder for an existing path).
 *
 * Walking up is what turns `<cwd>/.claude/commands` into `<cwd>/.claude` when
 * `.claude` is absent: bwrap creates the parent directory and then the leaf, and
 * both are the same placeholder.
 */
function firstMissing(candidate: string): FirstMissing | undefined {
  if (exists(candidate)) return undefined;
  let placeholder = candidate;
  let anchor = dirname(candidate);
  while (!exists(anchor)) {
    const above = dirname(anchor);
    // Nothing above `anchor` exists, not even the filesystem root: no write root
    // can contain a placeholder there.
    if (above === anchor) return undefined;
    placeholder = anchor;
    anchor = above;
  }
  return { placeholder, anchor };
}

/** The paths a wrap in `cwd` can create a placeholder at, deduplicated, in a fixed order. */
export function candidatePaths(cwd: string, policy: SandboxPolicy): string[] {
  const base = resolve(cwd);
  const writeRoots = policy.writeRoots.map((root) => resolve(base, root));
  const out: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates(base, policy)) {
    const missing = firstMissing(candidate);
    if (missing === undefined) continue;
    // srt creates a placeholder only inside an allowed write root.
    if (!writeRoots.some((root) => contains(root, missing.anchor))) continue;
    if (seen.has(missing.placeholder)) continue;
    seen.add(missing.placeholder);
    out.push(missing.placeholder);
  }
  return out;
}

/**
 * Every deny path the wrap will be given, in srt's own order: its mandatory
 * files, then its dangerous directories, then the two `.git` paths srt blocks in
 * place of the whole `.git` directory — added only when `.git` IS a directory,
 * because a linked worktree's `.git` file cannot hold either of them, so bwrap
 * creates no placeholder there — then the policy's own `denyWrite`.
 */
function candidates(base: string, policy: SandboxPolicy): string[] {
  const out: string[] = [
    ...SRT_MANDATORY_DENY_FILES.map((name) => resolve(base, name)),
    ...SRT_MANDATORY_DENY_DIRS.map((name) => resolve(base, name)),
  ];
  if (isDirectory(resolve(base, ".git"))) {
    out.push(resolve(base, ".git", "hooks"), resolve(base, ".git", "config"));
  }
  out.push(...policy.denyWrite.map((path) => resolve(base, path)));
  return out;
}

/** The placeholder's kind, as `lstat` reports it. */
export type PlaceholderKind = "file" | "dir";

/** What a recorded placeholder must still match: its kind and its identity on the device. */
export interface PlaceholderIdentity {
  readonly kind: PlaceholderKind;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The identity of the placeholder at `path`, or `undefined` when `path` is not
 * placeholder-shaped or does not exist.
 *
 * `lstat`, never `stat`: a symlink is not a placeholder even when it points at
 * one, because bwrap creates a file or a directory and nothing else.
 */
export function placeholderIdentity(path: string): PlaceholderIdentity | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    // Absent, or a parent nax may not search: nothing to identify.
    return undefined;
  }
  if (stats.isFile()) {
    // bwrap's leaf placeholder: empty, read-only for everyone, and unlinked
    // from anything else. A second link means the inode is shared with the
    // user's own file, which removing the name would not restore.
    const shaped = stats.size === 0 && (stats.mode & 0o222) === 0 && stats.nlink === 1;
    return shaped ? { kind: "file", dev: stats.dev, ino: stats.ino } : undefined;
  }
  if (stats.isDirectory()) {
    try {
      if (readdirSync(path).length > 0) return undefined;
    } catch {
      // Unreadable is not provably empty, and only an empty directory is the
      // intermediate placeholder bwrap makes.
      return undefined;
    }
    return { kind: "dir", dev: stats.dev, ino: stats.ino };
  }
  return undefined;
}

/** True when `path` is an empty 0444 single-link file or an empty directory. */
export function isPlaceholderShaped(path: string): boolean {
  return placeholderIdentity(path) !== undefined;
}

/**
 * Field 22 (starttime, in clock ticks since boot) of a `/proc/<pid>/stat` line.
 *
 * The command name in field 2 is parenthesised and may itself contain spaces and
 * parentheses, so the fields are counted from AFTER the LAST `)` — the state
 * character is then field 3. Pairing this with the boot id is what tells a
 * record's original process from an unrelated one that inherited its pid.
 *
 * @throws NaxError when the line has no `)`, too few fields, or a non-integer field.
 */
export function parseStartTicks(statLine: string): number {
  const close = statLine.lastIndexOf(")");
  if (close < 0) {
    throw new NaxError("[sandbox] malformed /proc stat line: no command terminator", "SANDBOX_PROC_STAT_INVALID", {
      stage: "sandbox",
      line: statLine,
    });
  }
  const fields = statLine
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const raw = fields[START_TICKS_AFTER_COMM_INDEX];
  const ticks = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(ticks)) {
    throw new NaxError("[sandbox] malformed /proc stat line: no starttime field", "SANDBOX_PROC_STAT_INVALID", {
      stage: "sandbox",
      field: START_TICKS_FIELD,
      line: statLine,
    });
  }
  return ticks;
}

/** The octal escapes `seq_file` uses for the characters a path field cannot hold literally. */
const MOUNTINFO_ESCAPES: Readonly<Record<string, string>> = {
  "\\040": " ",
  "\\011": "\t",
  "\\012": "\n",
  "\\134": "\\",
};

/**
 * Field 5 — the mount point — of every non-empty `/proc/<pid>/mountinfo` line,
 * with the four octal escapes decoded (a path with a space, tab, newline or
 * backslash is escaped there).
 *
 * A line with too few fields names no mount point and is skipped rather than
 * throwing: `/proc` content is read to build a set of comparisons, and one
 * unparsable line must not hide the other mounts.
 */
export function parseMountPoints(mountinfoText: string): string[] {
  const out: string[] = [];
  for (const line of mountinfoText.split("\n")) {
    if (line.trim() === "") continue;
    const mountPoint = line.split(" ")[4];
    if (mountPoint === undefined) continue;
    out.push(mountPoint.replace(/\\(?:040|011|012|134)/g, (octal) => MOUNTINFO_ESCAPES[octal] ?? octal));
  }
  return out;
}
