/**
 * nax#2500 R4: Claude's Write/Edit/MultiEdit/NotebookEdit are not covered by the
 * Bash sandbox, so under profile full their permission requests are checked
 * against the same write roots. This reads the request's display fields
 * (locations, rawInput paths) to DECIDE, deliberately overriding the D3-a "display
 * only" rule in tool-display.ts: there is no other source for the target path.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SandboxPolicy } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";

export const OUTSIDE_WRITE_ROOTS_REASON = "the edit target is outside the sandbox write roots";
const RAW_PATH_KEYS = ["file_path", "notebook_path"] as const;

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

/** Realpath of the deepest existing ancestor, with the missing tail re-appended. */
async function canonical(path: string): Promise<string> {
  let head = path;
  let tail: readonly string[] = [];
  for (;;) {
    try {
      return join(await realpath(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail = [basename(head), ...tail];
      head = parent;
    }
  }
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export async function firstOutsidePolicy(
  targets: readonly string[],
  policy: SandboxPolicy,
  cwd: string | undefined,
): Promise<string | undefined> {
  const roots = await Promise.all(policy.writeRoots.map(canonical));
  const denied = await Promise.all(policy.denyWrite.map(canonical));
  for (const target of targets) {
    const absolute = expand(target, cwd);
    if (absolute === undefined) return target;
    const real = await canonical(absolute);
    if (denied.some((d) => within(real, d)) || !roots.some((r) => within(real, r))) return target;
  }
  return undefined;
}
