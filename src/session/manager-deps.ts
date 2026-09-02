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
 * Derive the native transcriptDir for a session opened without one explicitly
 * (ADR-028 section 3; whole-branch review finding 1). Keyed by the session
 * NAME, not the session id: the id is generated inside `create()`, which runs
 * after `adapter.openSession` needs this value, so the id is not available yet.
 *
 * Requires both `featureName` and `projectDir` — when either is missing,
 * returning undefined and letting the native adapter throw its own
 * `NATIVE_TRANSCRIPT_DIR_MISSING` is honest; inventing a path here would be a
 * directory nobody looks in, exactly what that throw exists to prevent.
 */
export function deriveNativeTranscriptDir(
  name: string,
  opts: { featureName?: string; projectDir?: string },
): string | undefined {
  if (!opts.featureName || !opts.projectDir) return undefined;
  return _sessionManagerDeps.sessionScratchDir(opts.projectDir, opts.featureName, name);
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
