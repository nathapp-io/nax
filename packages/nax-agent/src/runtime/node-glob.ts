/** Node glob normalized to the agent contract and Bun's symlink traversal. */
import { type Dirent, globSync, lstatSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { AgentGlobOptions } from "./types.ts";

function scanOptions(pattern: string, opts: AgentGlobOptions) {
  const cwd = resolve(opts.cwd);
  if (!statSync(cwd).isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, glob '${cwd}'`), { code: "ENOTDIR", path: cwd });
  }
  const prefix: string[] = [];
  for (const part of pattern.split("/")) {
    if (/[*?[{]/.test(part.replace(/\\./g, ""))) break;
    prefix.push(part.replace(/\\(.)/g, "$1"));
  }
  const literalPrefix = relative(cwd, resolve(cwd, ...prefix));
  const symlinks = new Map<string, boolean>();
  const blockedSymlink = (path: string): boolean => {
    if (literalPrefix === path || literalPrefix.startsWith(`${path}${sep}`)) return false;
    if (!symlinks.has(path))
      symlinks.set(path, lstatSync(resolve(cwd, path), { throwIfNoEntry: false })?.isSymbolicLink() ?? false);
    return symlinks.get(path) === true;
  };
  const exclude = (entry: Dirent): boolean => {
    const path = relative(cwd, resolve(cwd, entry.parentPath, entry.name));
    if (path.split(sep).some((segment) => segment.startsWith("."))) return true;
    // Node can optimize brace/class segments without reporting their symlink
    // entries. Check lexical ancestors too, allowing only the literal prefix.
    const parts = path.split(sep);
    for (let end = 1; end <= parts.length; end++) {
      if (blockedSymlink(parts.slice(0, end).join(sep))) return true;
    }
    return false;
  };
  return { cwd, withFileTypes: true as const, exclude };
}

function filePath(entry: Dirent, cwd: string, absolute: boolean, pattern: string): string | null {
  const full = resolve(cwd, entry.parentPath, entry.name);
  if (
    !entry.isFile() &&
    !(
      !/[*?[{]/.test(pattern.replace(/\\./g, "")) &&
      entry.isSymbolicLink() &&
      statSync(full, { throwIfNoEntry: false })?.isFile()
    )
  )
    return null;
  const path = relative(cwd, full);
  if (path.split(sep).some((segment) => segment.startsWith("."))) return null;
  const dotPrefix = pattern.match(/^(?:\.\/)+/)?.[0] ?? "";
  return absolute ? resolve(full) : `${dotPrefix}${path}`;
}

function nodePattern(pattern: string): string {
  // Node treats backslash escapes differently; character classes express the
  // same literal metacharacters without changing the Bun-facing contract.
  return pattern.replace(/\\([[\]*?{}])/g, (_escape, char: string) => `[${char}]`);
}

export async function* nodeGlob(pattern: string, opts: AgentGlobOptions): AsyncIterable<string> {
  const options = scanOptions(pattern, opts);
  const seen = new Set<string>();
  for await (const entry of glob(nodePattern(pattern), options)) {
    if (options.exclude(entry)) continue;
    const path = filePath(entry, options.cwd, opts.absolute, pattern);
    if (path !== null && !seen.has(path)) {
      seen.add(path);
      yield path;
    }
  }
}

export function* nodeGlobSync(pattern: string, opts: AgentGlobOptions): Iterable<string> {
  const options = scanOptions(pattern, opts);
  const seen = new Set<string>();
  for (const entry of globSync(nodePattern(pattern), options)) {
    if (options.exclude(entry)) continue;
    const path = filePath(entry, options.cwd, opts.absolute, pattern);
    if (path !== null && !seen.has(path)) {
      seen.add(path);
      yield path;
    }
  }
}
