import type { ResumePlan } from "./resume-plan";
import type { TreeState } from "./types";

export interface CaptureTreeStateDeps {
  spawn: (cmd: string[], opts: unknown) => unknown;
}

export interface CaptureTreeStateOptions {
  _deps: CaptureTreeStateDeps;
}

export async function captureTreeState(workdir: string, options: CaptureTreeStateOptions): Promise<TreeState> {
  let headSha = "";
  let dirtyDigest = "";

  try {
    const proc = options._deps.spawn(["git", "rev-parse", "HEAD"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    }) as { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) {
      headSha = stdout.trim();
    }
  } catch {
    // keep empty
  }

  try {
    const proc = options._deps.spawn(["git", "status", "--porcelain"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    }) as { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) {
      const trimmed = stdout.trim();
      if (trimmed) {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(trimmed);
        dirtyDigest = hasher.digest("hex") as string;
      }
    }
  } catch {
    // keep empty
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
