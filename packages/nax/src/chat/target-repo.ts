/** Resolves a tool's `repo` argument to a nax project inside the chat's folder. */
import { realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getProjectKey, loadConfig } from "@/config";
import { projectOutputDir } from "@/runtime";

export const _targetRepoDeps = { loadConfig };

export type TargetRepo = { readonly root: string } | { readonly error: string };

/** Both arguments are real paths: equal to, or below, root. */
export function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Containment after canonicalizing both sides (symlink spellings); falls back to the given spelling. */
export function isWithinRootCanonical(path: string, root: string): boolean {
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      // Missing path: compare the spelling as given.
      return p;
    }
  };
  return isWithinRoot(canon(path), canon(root));
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // A missing path is the caller's "does not exist" case.
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Absent or unreadable is not a directory.
    return false;
  }
}

export async function resolveTargetRepo(chatRoot: string, repo: unknown): Promise<TargetRepo> {
  if (repo === undefined) return { root: chatRoot };
  if (typeof repo !== "string" || !repo.trim()) return { error: "[chat] repo must be a non-empty string" };
  const real = realOrNull(resolve(chatRoot, repo));
  if (real === null) return { error: `[chat] repo ${repo} does not exist` };
  const realChat = realOrNull(chatRoot) ?? chatRoot;
  if (!isWithinRoot(real, realChat)) return { error: `[chat] repo ${repo} is outside ${chatRoot}` };
  if (real === realChat) return { root: chatRoot };
  if (!isDirectory(join(real, ".nax"))) return { error: `[chat] repo ${repo} is not a nax project: no .nax directory` };
  return { root: real };
}

/** The output directory of the nax project at `root`, computed as composeChat does for its own. */
export async function targetOutputDir(root: string): Promise<string> {
  const config = await _targetRepoDeps.loadConfig(join(root, ".nax"));
  return projectOutputDir(getProjectKey(config, root), config.outputDir);
}
