/**
 * Which package a gate scans. Gates live in packages/repo-tooling and scan the
 * package they are run from: the current working directory by default (every
 * `bun run check:*` runs from its package directory), or `--package=<dir>`
 * resolved against the cwd. A baseline lives with the package it describes.
 */
import { isAbsolute, join, resolve } from "node:path";

const FLAG = "--package=";

export function gatePackageRoot(argv: readonly string[] = process.argv, cwd: string = process.cwd()): string {
  const flag = argv.find((a) => a.startsWith(FLAG));
  if (flag === undefined) return cwd;
  const dir = flag.slice(FLAG.length);
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

export function gateBaselinePath(packageRoot: string, file: string): string {
  return join(packageRoot, "scripts", "baselines", file);
}
