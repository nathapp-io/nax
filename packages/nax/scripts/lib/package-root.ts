/**
 * Which package a gate scans. A gate in packages/nax/scripts scans packages/nax
 * by default; `--package=<dir>` (relative to the cwd) points it at another
 * package, which is how packages/nax-agent runs nax's gates over its own code
 * (S1 spec section 7). A baseline lives with the package it describes.
 */
import { isAbsolute, join, resolve } from "node:path";

const FLAG = "--package=";

export function gatePackageRoot(scriptDir: string, argv: readonly string[] = process.argv): string {
  const flag = argv.find((a) => a.startsWith(FLAG));
  if (flag === undefined) return join(scriptDir, "..");
  const dir = flag.slice(FLAG.length);
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

export function gateBaselinePath(packageRoot: string, file: string): string {
  return join(packageRoot, "scripts", "baselines", file);
}
