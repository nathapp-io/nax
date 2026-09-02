/**
 * SessionManager injectable deps and private path helpers.
 *
 * Extracted from manager.ts to keep each file within the 600-line project limit.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { featureDir, PROJECT_FEATURES_DIR } from "@/config";
import type { SessionDescriptor } from "./types";

export function resolveProjectDirFromScratchDir(scratchDir: string): string | undefined {
  const marker = `${sep}.nax${sep}features${sep}`;
  const markerIdx = scratchDir.lastIndexOf(marker);
  if (markerIdx > 0) return scratchDir.slice(0, markerIdx);

  // Backstop: tolerate persisted forward-slash paths regardless of platform.
  const posixIdx = scratchDir.lastIndexOf(`/${PROJECT_FEATURES_DIR}/`);
  if (posixIdx > 0) return scratchDir.slice(0, posixIdx);

  return undefined;
}

export function toProjectRelativePath(projectDir: string, pathValue: string): string {
  const relativePath = isAbsolute(pathValue) ? relative(projectDir, pathValue) : pathValue;
  return relativePath === "" ? "." : relativePath;
}

/**
 * Derive the native transcript directory for a session opened without one
 * explicitly (ADR-028 section 3; Phase B transcript relocation). Built from
 * the runtime-injected transcript root — `SessionManager.configureRuntime`'s
 * `transcriptRoot` option, threaded from `outputDir` in `runtime/index.ts` —
 * never from the project tree. The resulting directory is flat: the file
 * itself (`<name>.transcript.json`, per `transcriptPath` in
 * `agents/native/session/transcript-store.ts`) already identifies its
 * session, so there is no per-session subdirectory.
 *
 * Requires both `featureName` and `transcriptRoot` — when either is missing,
 * returning undefined and letting the native adapter throw its own
 * `NATIVE_TRANSCRIPT_DIR_MISSING` is honest; inventing a path here would be a
 * directory nobody looks in, exactly what that throw exists to prevent.
 */
export function deriveNativeTranscriptDir(opts: { featureName?: string; transcriptRoot?: string }): string | undefined {
  if (!opts.featureName || !opts.transcriptRoot) return undefined;
  return join(opts.transcriptRoot, "features", opts.featureName, "sessions");
}

export const _sessionManagerDeps = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  uuid: () => randomUUID(),
  sessionScratchDir: (projectDir: string, featureName: string, sessionId: string): string =>
    join(featureDir(projectDir, featureName), "sessions", sessionId),
  /**
   * Persist a minimal session descriptor to <scratchDir>/descriptor.json for
   * cross-iteration disk discovery (Finding 2 from the Context Engine v2
   * architecture review). Creates the scratch directory if it does not exist.
   * `handle` is omitted — it is process-bound and cannot be rehydrated.
   */
  writeDescriptor: async (scratchDir: string, descriptor: SessionDescriptor, projectDir?: string): Promise<void> => {
    await mkdir(scratchDir, { recursive: true });
    const { handle: _handle, ...persistable } = descriptor;
    const derivedProjectDir = projectDir ?? resolveProjectDirFromScratchDir(scratchDir);
    if (derivedProjectDir) {
      persistable.workdir = toProjectRelativePath(derivedProjectDir, persistable.workdir);
      if (persistable.scratchDir) {
        persistable.scratchDir = toProjectRelativePath(derivedProjectDir, persistable.scratchDir);
      }
    }
    await Bun.write(join(scratchDir, "descriptor.json"), JSON.stringify(persistable, null, 2));
  },
};
