import type { ResumePlan } from "./resume-plan";
import type { TreeState } from "./types";

export interface CaptureTreeStateDeps {
  spawn: (cmd: string[], opts: unknown) => unknown;
}

export interface CaptureTreeStateOptions {
  _deps: CaptureTreeStateDeps;
}

/** Per-git-call timeout — mirrors the intent of `gitWithTimeout` (GIT_TIMEOUT_MS). */
/**
 * Tree-state capture uses a short per-git-call deadline. git rev-parse HEAD
 * and git status --porcelain are sub-30ms operations on typical repos. A hung
 * process is caught quickly rather than blocking the orchestrator startup.
 * Mirrors the intent of gitWithTimeout (GIT_TIMEOUT_MS) but with a tighter
 * bound appropriate for git sub-second commands.
 */
const TREE_CAPTURE_TIMEOUT_MS = 75;

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
  const result = await Promise.race([
    (async () => {
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { stdout, exitCode };
    })(),
    new Promise<{ stdout: string; exitCode: number }>((resolve) =>
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore kill failure
        }
        resolve({ stdout: "", exitCode: 1 });
      }, timeoutMs),
    ),
  ]);
  return result;
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

export async function captureTreeState(workdir: string, options: CaptureTreeStateOptions): Promise<TreeState> {
  let headSha = "";
  let dirtyDigest = "";

  try {
    const proc = spawnGit(options._deps, ["rev-parse", "HEAD"], workdir);
    const { stdout, exitCode } = await spawnWithTimeout(proc, TREE_CAPTURE_TIMEOUT_MS);
    headSha = exitCode === 0 ? stdout.trim() : captureFailureSentinel();
  } catch {
    headSha = captureFailureSentinel();
  }

  try {
    const proc = spawnGit(options._deps, ["status", "--porcelain"], workdir);
    const { stdout, exitCode } = await spawnWithTimeout(proc, TREE_CAPTURE_TIMEOUT_MS);
    if (exitCode === 0) {
      const trimmed = stdout.trim();
      if (trimmed) {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(trimmed);
        dirtyDigest = hasher.digest("hex") as string;
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
