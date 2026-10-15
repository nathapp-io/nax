/**
 * The transcript and audit fields SessionManager forwards to adapter.openSession.
 *
 * Its own module because manager.ts is a grandfathered oversized file that may
 * not grow (as model-selection.ts). transcriptDir derivation is ADR-028 §3 (an
 * explicit caller value wins); transcriptOwner is nax#1877's ownership key; the
 * ACP SDK transport keeps its crash-leftover record in transcriptDir and reads
 * its run identifiers and tool-audit ledger from toolAudit (S4b spec §7.4).
 */
import { join } from "node:path";
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import type { NaxConfig } from "../config";
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
    | "providerTools"
    | "providerInstructions"
    | "declaredTools"
    | "sandbox"
    | "toolSurface"
  >,
  transcriptRoot: string | undefined,
  config?: Pick<NaxConfig, "agent">,
): Pick<
  OpenSessionOpts,
  | "transcriptDir"
  | "transcriptOwner"
  | "toolAudit"
  | "transcriptArchive"
  | "instructionDirectories"
  | "instructionFileName"
  | "instructionProtectedPaths"
  | "instructionDenyPaths"
  | "providerTools"
  | "providerInstructions"
  | "declaredTools"
  | "sandbox"
  | "toolSurface"
> {
  return {
    transcriptDir: opts.transcriptDir ?? deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot }),
    ...(opts.transcriptOwner !== undefined ? { transcriptOwner: opts.transcriptOwner } : {}),
    ...(opts.toolAudit !== undefined ? { toolAudit: opts.toolAudit } : {}),
    ...transcriptArchiveFor(opts.featureName, transcriptRoot, config),
    ...(opts.providerTools !== undefined ? { providerTools: opts.providerTools } : {}),
    ...(opts.providerInstructions !== undefined ? { providerInstructions: opts.providerInstructions } : {}),
    ...(opts.declaredTools !== undefined ? { declaredTools: opts.declaredTools } : {}),
    ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
    ...(opts.toolSurface !== undefined ? { toolSurface: opts.toolSurface } : {}),
    ...(opts.instructionDirectories !== undefined ? { instructionDirectories: opts.instructionDirectories } : {}),
    ...(opts.instructionFileName !== undefined ? { instructionFileName: opts.instructionFileName } : {}),
    ...(opts.instructionProtectedPaths !== undefined
      ? { instructionProtectedPaths: opts.instructionProtectedPaths }
      : {}),
    ...(opts.instructionDenyPaths !== undefined ? { instructionDenyPaths: opts.instructionDenyPaths } : {}),
  };
}

/**
 * The nax#2453 archive target: `<dir ?? <transcriptRoot>/transcript-audit>/<feature>`.
 * Empty when auditing is off, the feature is unknown, or there is nowhere to write.
 */
function transcriptArchiveFor(
  featureName: string | undefined,
  transcriptRoot: string | undefined,
  config: Pick<NaxConfig, "agent"> | undefined,
): Pick<OpenSessionOpts, "transcriptArchive"> {
  const audit = config?.agent?.transcriptAudit;
  if (!audit?.enabled || !featureName) return {};
  const root = audit.dir ?? (transcriptRoot === undefined ? undefined : join(transcriptRoot, "transcript-audit"));
  if (root === undefined) return {};
  return { transcriptArchive: { dir: join(root, featureName), maxRetained: audit.maxRetained ?? 200 } };
}
