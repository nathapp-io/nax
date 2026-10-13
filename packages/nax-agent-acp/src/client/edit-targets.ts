/**
 * nax#2500 R4: Claude's Write/Edit/MultiEdit/NotebookEdit are not covered by the
 * Bash sandbox, so under profile full their permission requests are checked
 * against the same write roots. This reads the request's display fields
 * (locations, rawInput paths) to DECIDE, deliberately overriding the D3-a "display
 * only" rule in tool-display.ts: there is no other source for the target path.
 * Known limitation (TOCTOU): the check runs at permission time; a path component
 * swapped for a symlink between the check and the write is not caught (only Bash
 * is under the OS sandbox).
 */
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SandboxPolicy } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";

export const OUTSIDE_WRITE_ROOTS_REASON = "the edit target is outside the sandbox write roots";
const RAW_PATH_KEYS = ["file_path", "notebook_path"] as const;
/** Test seam: the platform decides whether path comparison folds case (darwin and win32 filesystems are case-insensitive by default). */
export const _editTargetsDeps = { platform: (): string => process.platform };

export function editTargets(toolCall: unknown): readonly string[] {
  if (!isRecord(toolCall)) return [];
  const fromLocations = Array.isArray(toolCall.locations)
    ? toolCall.locations.flatMap((l: unknown) =>
        isRecord(l) && typeof l.path === "string" && l.path !== "" ? [l.path] : [],
      )
    : [];
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const fromRaw = RAW_PATH_KEYS.flatMap((k) => (typeof raw[k] === "string" && raw[k] !== "" ? [raw[k] as string] : []));
  return [...new Set([...fromLocations, ...fromRaw])];
}

/**
 * Absolute form of a target, or undefined when it is relative and there is no cwd
 * to resolve it against (fail closed: the caller treats that as outside).
 */
function expand(path: string, cwd: string | undefined): string | undefined {
  if (path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(1));
  if (isAbsolute(path)) return path;
  return cwd === undefined ? undefined : resolve(cwd, path);
}

/** R7: a `..` segment is outside, before any resolution (lexical `..` can disagree with the OS after a symlink). */
const SEPARATORS = sep === "/" ? /\// : /[/\\]/;
const hasDotDotSegment = (path: string): boolean => path.split(SEPARATORS).includes("..");

/** Symlink bound for canonical(): a longer chain, or a loop, is treated as outside. */
const MAX_SYMLINK_HOPS = 40;

/** The raw target of a symlink at `path`, or undefined when it is not one (or cannot be read). */
async function symlinkTarget(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? await readlink(path) : undefined;
  } catch {
    return undefined;
  }
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Follows a dangling symlink (R6) to its target, bounded by MAX_SYMLINK_HOPS; the missing tail is re-appended. */
async function followLink(
  linkPath: string,
  link: string,
  tail: readonly string[],
  hops: number,
): Promise<string | undefined> {
  if (hops >= MAX_SYMLINK_HOPS) return undefined;
  // R8: a raw `..` in the link target is outside: its meaning depends on the OS resolving it after symlinks.
  if (hasDotDotSegment(link)) return undefined;
  // R8b: a relative target resolves against the real parent directory (the link's own directory is real-resolved).
  const parent = await realpathOrUndefined(dirname(linkPath));
  if (parent === undefined) return undefined;
  const next = isAbsolute(link) ? link : resolve(parent, link);
  const resolved = await canonical(next, hops + 1);
  return resolved === undefined ? undefined : join(resolved, ...tail);
}

/**
 * Realpath of the deepest existing ancestor, with the missing tail re-appended. A
 * dangling symlink is followed to its target (R6): a write through it lands there.
 * Undefined = unresolvable (too many hops): the caller treats it as outside.
 */
async function canonical(path: string, hops = 0): Promise<string | undefined> {
  let head = path;
  let tail: readonly string[] = [];
  for (;;) {
    const real = await realpathOrUndefined(head);
    if (real !== undefined) return join(real, ...tail);
    const link = await symlinkTarget(head);
    if (link !== undefined) return followLink(head, link, tail, hops);
    const parent = dirname(head);
    if (parent === head) return path;
    tail = [basename(head), ...tail];
    head = parent;
  }
}

/** Policy paths: an unresolvable one keeps its raw form (a deny entry still matches its own spelling). */
const canonicalPolicyPath = async (path: string): Promise<string> => (await canonical(path)) ?? path;

/** Both sides of every comparison are NFC-normalised (R8b). */
const nfc = (path: string): string => path.normalize("NFC");

/** Case folding, only for denyWrite matching, on the platforms whose default filesystem ignores case (R8b). */
const foldCase = (path: string): string =>
  _editTargetsDeps.platform() === "darwin" || _editTargetsDeps.platform() === "win32" ? path.toLowerCase() : path;

const contains = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** writeRoots containment: exact (case-sensitive) comparison. */
const withinRoot = (path: string, root: string): boolean => contains(nfc(path), nfc(root));

/** denyWrite matching: case-folded on darwin and win32, so a differently cased spelling is still denied. */
const withinDenied = (path: string, denied: string): boolean => contains(foldCase(nfc(path)), foldCase(nfc(denied)));

export async function firstOutsidePolicy(
  targets: readonly string[],
  policy: SandboxPolicy,
  cwd: string | undefined,
): Promise<string | undefined> {
  const roots = await Promise.all(policy.writeRoots.map(canonicalPolicyPath));
  const denied = await Promise.all(policy.denyWrite.map(canonicalPolicyPath));
  for (const target of targets) {
    if (hasDotDotSegment(target)) return target;
    const absolute = expand(target, cwd);
    if (absolute === undefined) return target;
    const real = await canonical(absolute);
    if (real === undefined) return target;
    if (denied.some((d) => withinDenied(real, d)) || !roots.some((r) => withinRoot(real, r))) return target;
  }
  return undefined;
}
