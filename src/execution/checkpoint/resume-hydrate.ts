import type { ResumePlan } from "./resume-plan";
import type { TreeState } from "./types";

export interface CaptureTreeStateDeps {
  spawn: (cmd: string[], opts: unknown) => unknown;
  /**
   * Per-git-call deadline override. Defaults to TREE_CAPTURE_TIMEOUT_MS.
   * Injectable so the AC8 hang-path test can assert the SIGKILL contract
   * without burning the full per-call budget once per hung call in wall-clock.
   */
  timeoutMs?: number;
}

/** Resolve the per-call deadline, honouring a test-supplied override. */
function callTimeoutMs(deps: CaptureTreeStateDeps): number {
  return deps.timeoutMs ?? TREE_CAPTURE_TIMEOUT_MS;
}

export interface CaptureTreeStateOptions {
  _deps: CaptureTreeStateDeps;
}

/** Per-git-call timeout — mirrors the intent of `gitWithTimeout` (GIT_TIMEOUT_MS). */
/**
 * Tree-state capture uses a short per-git-call deadline. git rev-parse HEAD
 * and git status --porcelain are sub-30ms operations on typical repos, and
 * git diff on a dirty tree (only run when status is non-empty) stays in the
 * same order of magnitude for the story-sized diffs this captures. A hung
 * process is caught quickly rather than blocking the orchestrator startup.
 * Mirrors the intent of gitWithTimeout (GIT_TIMEOUT_MS) but with a tighter
 * bound appropriate for git sub-second commands.
 *
 * VER-4: was 75ms, budgeted for a *single* call — but each of status/diff/
 * diff-cached/hash-object gets its own 75ms deadline, and on cold page
 * cache, large monorepos, or network-mounted repos a slow-but-healthy git
 * call was routinely SIGKILLed, making `captureFailureSentinel()` fire and
 * `nax resume` silently re-run everything. Raised to 1s of headroom per call.
 */
const TREE_CAPTURE_TIMEOUT_MS = 1000;

interface SpawnedProc {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: unknown): void;
}

function spawnGit(deps: CaptureTreeStateDeps, args: string[], workdir: string): SpawnedProc {
  return deps.spawn(["git", ...args], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  }) as SpawnedProc;
}

async function spawnWithTimeout(proc: SpawnedProc, timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
  // VER-4/EXEC-6: the losing side of this race must be cleared, or a timer
  // that never fires (git won) still holds the event loop and later
  // SIGKILLs an already-exited pid.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const [exitCode, stdout] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { stdout, exitCode };
      })(),
      new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        timer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore kill failure
          }
          resolve({ stdout: "", exitCode: 1 });
        }, timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A capture failure (timeout, non-zero exit, thrown error) must never compare
 * equal to a genuinely clean tree's empty-string field, nor to another
 * failed capture — `buildResumePlan`'s tree-guard treats equal `headSha` +
 * `dirtyDigest` as "nothing moved" and allows a resume skip. Without a
 * distinct-every-time sentinel, two independent timeouts (e.g. one at
 * checkpoint-record time, one at resume-decision time) would both fall back
 * to `""` and be silently treated as a matching, trustworthy tree.
 */
function captureFailureSentinel(): string {
  return `__capture_failed__:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/** Cap on untracked files whose content is folded into the digest. */
const MAX_UNTRACKED_HASHED = 500;

/**
 * `git hash-object` over up to MAX_UNTRACKED_HASHED paths is a heavier call
 * than the sub-30ms plumbing commands above, so it gets a proportionally
 * larger deadline than TREE_CAPTURE_TIMEOUT_MS.
 */
const UNTRACKED_HASH_TIMEOUT_MS = 250;

/**
 * Digest input covering untracked files: their paths plus git's own content
 * hash for each.
 *
 * `git diff` and `git diff --cached` cover TRACKED files only, and
 * `git status --porcelain` lists an untracked file by name, never by content.
 * Without this, rewriting a file the implementer just created leaves status
 * and both diffs byte-identical, the digest unchanged, and the resume guard
 * reading "nothing moved" — issue #1521's exact symptom, which survived its
 * own fix for new files.
 *
 * Returns null when git fails, so the caller falls back to the capture-failure
 * sentinel (forcing a rerun) rather than silently hashing an incomplete view.
 * Every failure mode here must err toward "changed": a false rerun costs time,
 * a false "unchanged" skips the implementer.
 */
async function untrackedDigestInput(deps: CaptureTreeStateDeps, workdir: string): Promise<string | null> {
  const listed = await spawnWithTimeout(
    spawnGit(deps, ["ls-files", "--others", "--exclude-standard", "-z"], workdir),
    callTimeoutMs(deps),
  );
  if (listed.exitCode !== 0) return null;

  // -z so paths containing newlines or quote-worthy characters survive intact;
  // git would otherwise quote them and hash-object would receive the quotes.
  const paths = listed.stdout.split("\u0000").filter((p) => p !== "");
  if (paths.length === 0) return "0";

  paths.sort();
  // Bounded so a large untracked tree cannot blow the argument list or the
  // deadline. The total count is hashed unconditionally, so files past the cap
  // still move the digest as they appear or disappear.
  const capped = paths.slice(0, MAX_UNTRACKED_HASHED);
  const hashed = await spawnWithTimeout(
    spawnGit(deps, ["hash-object", "--", ...capped], workdir),
    UNTRACKED_HASH_TIMEOUT_MS,
  );
  if (hashed.exitCode !== 0) return null;

  return `${paths.length}\n${capped.join("\n")}\n${hashed.stdout.trim()}`;
}

export async function captureTreeState(workdir: string, options: CaptureTreeStateOptions): Promise<TreeState> {
  let headSha = "";
  let dirtyDigest = "";

  try {
    const proc = spawnGit(options._deps, ["rev-parse", "HEAD"], workdir);
    const { stdout, exitCode } = await spawnWithTimeout(proc, callTimeoutMs(options._deps));
    headSha = exitCode === 0 ? stdout.trim() : captureFailureSentinel();
  } catch {
    headSha = captureFailureSentinel();
  }

  try {
    const statusProc = spawnGit(options._deps, ["status", "--porcelain"], workdir);
    const status = await spawnWithTimeout(statusProc, callTimeoutMs(options._deps));
    if (status.exitCode === 0) {
      const trimmedStatus = status.stdout.trim();
      if (trimmedStatus) {
        // Working tree is dirty — `git status --porcelain` only lists filenames
        // and status codes, so rewriting an already-modified file leaves it
        // byte-identical (issue #1521). Fold in the actual content diff (both
        // unstaged and staged) so an edit to an already-modified file moves
        // the digest, not just a change to which files are touched. Both diffs
        // cover TRACKED files only, so untracked content is folded in
        // separately -- see untrackedDigestInput.
        const diffProc = spawnGit(options._deps, ["diff"], workdir);
        const diff = await spawnWithTimeout(diffProc, callTimeoutMs(options._deps));
        const cachedDiffProc = spawnGit(options._deps, ["diff", "--cached"], workdir);
        const cachedDiff = await spawnWithTimeout(cachedDiffProc, callTimeoutMs(options._deps));
        const untracked = await untrackedDigestInput(options._deps, workdir);
        if (diff.exitCode === 0 && cachedDiff.exitCode === 0 && untracked !== null) {
          const hasher = new Bun.CryptoHasher("sha256");
          hasher.update(trimmedStatus);
          hasher.update("\u0000");
          hasher.update(diff.stdout);
          hasher.update("\u0000");
          hasher.update(cachedDiff.stdout);
          hasher.update("\u0000");
          hasher.update(untracked);
          dirtyDigest = hasher.digest("hex") as string;
        } else {
          dirtyDigest = captureFailureSentinel();
        }
      }
    } else {
      dirtyDigest = captureFailureSentinel();
    }
  } catch {
    dirtyDigest = captureFailureSentinel();
  }

  return { headSha, dirtyDigest };
}

export function hydrateFromResumePlan(plan: ResumePlan, phaseOutputs: Record<string, unknown>): void {
  for (const phase of plan.skipPhases) {
    phaseOutputs[phase] = { success: true };
  }
}

export function buildCheckpointLogData(meta: Record<string, unknown>): Record<string, unknown> {
  const { storyId, ...rest } = meta;
  return { storyId, ...rest };
}
