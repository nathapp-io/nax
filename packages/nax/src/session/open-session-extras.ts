/**
 * The transcript and audit fields SessionManager forwards to adapter.openSession.
 *
 * Its own module because manager.ts is a grandfathered oversized file that may
 * not grow (as model-selection.ts). transcriptDir derivation is ADR-028 §3 (an
 * explicit caller value wins); transcriptOwner is nax#1877's ownership key; the
 * ACP SDK transport keeps its crash-leftover record in transcriptDir and reads
 * its run identifiers and tool-audit ledger from toolAudit (S4b spec §7.4).
 */
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { deriveNativeTranscriptDir } from "./manager-deps";
import type { OpenSessionRequest } from "./types";

export function openSessionExtras(
  opts: Pick<
    OpenSessionRequest,
    | "transcriptDir"
    | "transcriptOwner"
    | "toolAudit"
    | "featureName"
    | "instructionDirectories"
    | "instructionFileName"
    | "instructionProtectedPaths"
    | "instructionDenyPaths"
  >,
  transcriptRoot: string | undefined,
): Pick<
  OpenSessionOpts,
  | "transcriptDir"
  | "transcriptOwner"
  | "toolAudit"
  | "instructionDirectories"
  | "instructionFileName"
  | "instructionProtectedPaths"
  | "instructionDenyPaths"
> {
  return {
    transcriptDir: opts.transcriptDir ?? deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot }),
    ...(opts.transcriptOwner !== undefined ? { transcriptOwner: opts.transcriptOwner } : {}),
    ...(opts.toolAudit !== undefined ? { toolAudit: opts.toolAudit } : {}),
    ...(opts.instructionDirectories !== undefined ? { instructionDirectories: opts.instructionDirectories } : {}),
    ...(opts.instructionFileName !== undefined ? { instructionFileName: opts.instructionFileName } : {}),
    ...(opts.instructionProtectedPaths !== undefined
      ? { instructionProtectedPaths: opts.instructionProtectedPaths }
      : {}),
    ...(opts.instructionDenyPaths !== undefined ? { instructionDenyPaths: opts.instructionDenyPaths } : {}),
  };
}
