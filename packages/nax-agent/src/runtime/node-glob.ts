/** Node glob normalized to the agent contract and Bun's symlink traversal. */
import { type Dirent, globSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { AgentGlobOptions } from "./types";

function scanOptions(pattern: string, opts: AgentGlobOptions) {
  const cwd = resolve(opts.cwd);
  if (!statSync(cwd).isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, glob '${cwd}'`), { code: "ENOTDIR", path: cwd });
  }
  const prefix: string[] = [];
  for (const part of pattern.split("/")) {
    if (/[*?[{]/.test(part)) break;
    prefix.push(part);
  }
  const literalPrefix = relative(cwd, resolve(cwd, ...prefix));
  const exclude = (entry: Dirent): boolean => {
    const path = relative(cwd, resolve(cwd, entry.parentPath, entry.name));
    if (path.split(sep).some((segment) => segment.startsWith("."))) return true;
    // Node follows directory symlinks in wildcard scans. Bun only follows an
    // explicitly named prefix, which this predicate leaves traversable.
    return entry.isSymbolicLink() && !(literalPrefix === path || literalPrefix.startsWith(`${path}${sep}`));
  };
  return { cwd, withFileTypes: true as const, exclude };
}

function filePath(entry: Dirent, cwd: string, absolute: boolean, pattern: string): string | null {
  const full = resolve(cwd, entry.parentPath, entry.name);
  if (
    !entry.isFile() &&
    !(!/[*?[{]/.test(pattern) && entry.isSymbolicLink() && statSync(full, { throwIfNoEntry: false })?.isFile())
  )
    return null;
  const path = relative(cwd, full);
  if (path.split(sep).some((segment) => segment.startsWith("."))) return null;
  const dotPrefix = pattern.match(/^(?:\.\/)+/)?.[0] ?? "";
  return absolute ? resolve(full) : `${dotPrefix}${path}`;
}

export async function* nodeGlob(pattern: string, opts: AgentGlobOptions): AsyncIterable<string> {
  const options = scanOptions(pattern, opts);
  const seen = new Set<string>();
  for await (const entry of glob(pattern, options)) {
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
  for (const entry of globSync(pattern, options)) {
    const path = filePath(entry, options.cwd, opts.absolute, pattern);
    if (path !== null && !seen.has(path)) {
      seen.add(path);
      yield path;
    }
  }
}
