import { relative, resolve } from "node:path";

/**
 * Rebase a raw path (absolute or cwd-relative) to nax's workdir-relative convention.
 * Used by producer adapters (phases 3+) that receive paths in non-workdir-relative form.
 *
 * Per ADR-021 §3, every Finding.file must be relative to workdir.
 */
export function rebaseToWorkdir(rawPath: string, cwd: string, workdir: string): string {
  if (rawPath.startsWith("/")) {
    return relative(workdir, rawPath);
  }
  return relative(workdir, resolve(cwd, rawPath));
}
