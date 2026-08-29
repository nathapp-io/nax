/**
 * Tier 4 — Directory Convention Fallback
 *
 * Checks for well-known test directories (test/, tests/, __tests__/, spec/).
 * When found, scans for file extensions within and emits generic globs.
 *
 * This tier runs last — only when Tiers 1–3 produce no results.
 */

import { killProcessGroup } from "@/utils/process-kill";
import type { DetectionSource } from "./types";

/** Well-known test directory names to probe */
const WELL_KNOWN_TEST_DIRS = ["test", "tests", "__tests__", "spec", "specs"] as const;

/** Directories to skip when scanning for extensions */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nax"]);

/**
 * Hard deadline on the per-directory `git ls-files` so a wedged git (NFS /
 * lock contention) does not stall Tier 4 detection indefinitely. Mirrors
 * `gitWithTimeout` in `src/utils/git.ts` and `_fileScanDeps.timeoutMs` in
 * `file-scan.ts`: SIGKILL the process group on expiry, degrade to the empty
 * listing (the existing "directory exists but is empty" fallback glob still
 * fires downstream, so the tier still emits a non-null source).
 */
const DIRECTORY_SCAN_GIT_TIMEOUT_MS = 10_000;

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
  killProcessGroup,
  timeoutMs: DIRECTORY_SCAN_GIT_TIMEOUT_MS,
};

/**
 * List files in a directory recursively using git ls-files scoped to the dir.
 * Falls back to Bun.glob when not a git repo, when `git ls-files` exits
 * non-zero, or when it exceeds its hard deadline (the SIGKILL-on-expiry
 * contract degrades to the same empty listing the non-zero exit produces).
 */
async function listFilesInDir(workdir: string, dir: string): Promise<string[]> {
  try {
    const proc = _directoryScanDeps.spawn(["git", "ls-files", dir], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Race `proc.exited` against a hard deadline so a wedged child cannot stall
    // the caller indefinitely. The timer resolves the race directly on expiry
    // — we do NOT rely on SIGKILL causing `proc.exited` to settle, because
    // that side-effect is an implementation detail of the child and not part
    // of the contract this helper guarantees. Mirrors the defensive
    // `awaitProcExit` shape from `src/execution/pid-registry.ts`.
    const exitCode: number = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        try {
          _directoryScanDeps.killProcessGroup(proc.pid, "SIGKILL");
        } catch {
          // Process may have already exited; the deadline below still wins.
        }
        finish(-1);
      }, _directoryScanDeps.timeoutMs);
      proc.exited.then(finish, () => finish(-1));
    });

    // Drain concurrently with the exit wait — a child that fills its pipe's OS
    // buffer before being read would otherwise block on the write and never
    // reach `exited`, defeating the SIGKILL the timeout relies on.
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");

    if (exitCode === 0) {
      const stdout = await stdoutPromise;
      void (await stderrPromise);
      return stdout.split("\n").filter(Boolean);
    }
  } catch {
    // fall through to glob
  }

  // Glob fallback (non-git workdir, e.g. test fixtures) — also reached when
  // git ls-files times out or fails, since the empty listing here lets the
  // caller's `${dir}/**/*` fallback glob still fire.
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
