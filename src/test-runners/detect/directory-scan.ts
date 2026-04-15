/**
 * Tier 4 — Directory Convention Fallback
 *
 * Checks for well-known test directories (test/, tests/, __tests__/, spec/).
 * When found, scans for file extensions within and emits generic globs.
 *
 * This tier runs last — only when Tiers 1–3 produce no results.
 */

import type { DetectionSource } from "./types";

/** Well-known test directory names to probe */
const WELL_KNOWN_TEST_DIRS = ["test", "tests", "__tests__", "spec", "specs"] as const;

/** Directories to skip when scanning for extensions */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nax"]);

/** Injectable deps for testability */
export const _directoryScanDeps = {
  dirExists: async (path: string): Promise<boolean> => {
    const f = Bun.file(path);
    // Bun.file().exists() works for dirs in newer Bun; use stat fallback
    try {
      const stat = await f.stat();
      // Bun stat returns isFile() true only for files
      return !stat.isFile();
    } catch {
      return false;
    }
  },
  spawn: Bun.spawn as typeof Bun.spawn,
};

/**
 * List files in a directory recursively using git ls-files scoped to the dir.
 * Falls back to Bun.glob when not a git repo.
 */
async function listFilesInDir(workdir: string, dir: string): Promise<string[]> {
  try {
    const proc = _directoryScanDeps.spawn(["git", "ls-files", dir], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const output = await new Response(proc.stdout).text();
      return output.split("\n").filter(Boolean);
    }
  } catch {
    // fall through to glob
  }

  // Glob fallback (non-git workdir, e.g. test fixtures)
  const glob = new Bun.Glob(`${dir}/**/*`);
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: workdir, onlyFiles: true })) {
    if (!SKIP_DIRS.has(f.split("/")[0] ?? "")) files.push(f);
  }
  return files;
}

/** Extract unique file extensions from a list of paths (e.g. ".ts", ".go") */
function extractExtensions(files: string[]): string[] {
  const exts = new Set<string>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot > 0) exts.add(f.slice(dot)); // ".ts", ".go", ".py"
  }
  return [...exts];
}

/**
 * Scan well-known test directories and emit generic globs.
 * Returns null when no test directories are found.
 */
export async function detectFromDirectoryScan(workdir: string): Promise<DetectionSource | null> {
  const patterns: string[] = [];
  let foundPath: string | null = null;

  for (const dir of WELL_KNOWN_TEST_DIRS) {
    const exists = await _directoryScanDeps.dirExists(`${workdir}/${dir}`);
    if (!exists) continue;

    if (!foundPath) foundPath = `${workdir}/${dir}`;

    const files = await listFilesInDir(workdir, dir);
    const exts = extractExtensions(files);

    for (const ext of exts) {
      patterns.push(`${dir}/**/*${ext}`);
    }

    // Fallback glob when directory exists but is empty
    if (exts.length === 0) {
      patterns.push(`${dir}/**/*`);
    }
  }

  if (!foundPath || patterns.length === 0) return null;

  // Dedupe
  const unique = [...new Set(patterns)];

  return {
    type: "directory",
    path: foundPath,
    patterns: unique,
  };
}
