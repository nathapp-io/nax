import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first executable regular file named `name` on `pathEnv` (POSIX; Windows is
 * unsupported, as for nax). A name containing "/" is checked as a path. Relative
 * paths and relative PATH entries resolve against `cwd`, as the spawned child sees them.
 */
export function which(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
  /** Defaults to "." : relative to the current directory, which a child with no cwd inherits. */
  cwd = ".",
): string | null {
  if (name.includes("/")) return isExecutableFile(resolve(cwd, name)) ? name : null;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(resolve(cwd, dir), name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
