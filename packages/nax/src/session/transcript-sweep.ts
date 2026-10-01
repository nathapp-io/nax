/**
 * Feature-scoped native transcript sweep (US-002).
 *
 * Retained native transcripts (kept on turn failure — `retainTranscript` in
 * `agents/native/session/transcript-store.ts`) are pruned down to
 * `MAX_RETAINED_TRANSCRIPTS` at run setup so the kept-on-failure set cannot
 * grow without bound. `sweepFeatureTranscripts` derives the feature's
 * `sessions/` directory under the runtime output dir
 * (`deriveNativeTranscriptDir`) and delegates the pruning to
 * `pruneRetainedTranscripts`.
 *
 * The sweep is a no-op — returns 0 without touching disk — when the directory
 * cannot be derived (either input missing), when dryRun is set, or when the
 * derived directory does not exist.
 */

import { pruneRetainedTranscripts } from "@/agents/native";
import { deriveNativeTranscriptDir } from "./manager-deps";

export interface SweepFeatureTranscriptsOptions {
  /** Feature name — part of the derived sessions/ path under the output dir. */
  featureName?: string;
  /** Runtime output dir the feature's native sessions live under. */
  transcriptRoot?: string;
  /** When true, skip disk work entirely and return 0. */
  dryRun?: boolean;
}

/**
 * Prune a feature's retained native transcripts under the runtime output dir.
 *
 * @returns The number of transcript files deleted (0 when the sweep is a no-op).
 */
export async function sweepFeatureTranscripts(opts: SweepFeatureTranscriptsOptions): Promise<number> {
  if (opts.dryRun) return 0;
  const dir = deriveNativeTranscriptDir(opts);
  if (!dir) return 0;
  return pruneRetainedTranscripts(dir);
}
