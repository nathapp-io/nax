/**
 * The job panel's place in the transcript (chat-job-panel US-003): how a refreshed view
 * lands in the entry list without disturbing anything else in it.
 *
 * A `job` entry is a live row, not a message: the same job's panel is replaced in place on
 * every refresh, so its position and its own expansion survive, and every other entry keeps
 * its object — which is what the view's per-entry layout cache depends on. Both helpers are
 * pure; the input array is never mutated.
 */
import type { JobPanelView } from "@/chat";
import type { TranscriptEntry } from "./transcript-model";

/**
 * The index of the entry showing `jobId`, or -1 when the transcript has no panel for it.
 */
function panelIndex(entries: readonly TranscriptEntry[], jobId: string): number {
  return entries.findIndex((entry) => entry.kind === "job" && entry.view.jobId === jobId);
}

/**
 * `entries` with the panel for `view.jobId` replaced by `view` at its own index, its `open`
 * flag kept, or — with no panel for that job — `{ kind: "job", view }` appended.
 */
export function upsertJobPanel(entries: readonly TranscriptEntry[], view: JobPanelView): readonly TranscriptEntry[] {
  const found = panelIndex(entries, view.jobId);
  if (found < 0) return [...entries, { kind: "job", view }];
  return entries.map((entry, index) => (index === found && entry.kind === "job" ? { ...entry, view } : entry));
}

/** Whether the transcript holds a panel for `jobId`. */
export function hasJobPanel(entries: readonly TranscriptEntry[], jobId: string): boolean {
  return panelIndex(entries, jobId) >= 0;
}
