import { type LayoutOptions, layoutTranscript, transcriptLineOwners } from "./layout";
import { attachmentExpandable } from "./layout-attachment";
import type { TranscriptEntry } from "./transcript-model";

/**
 * The entries whose detail a header row can open: everything with an `open` flag. A
 * collapsible listing carries one too, but only the jobs picker's output sets it.
 */
type CollapsibleEntry =
  | Extract<TranscriptEntry, { kind: "thinking" | "tool" | "skill" | "attachment" | "background" | "job" }>
  | Extract<TranscriptEntry, { kind: "listing" }>;

type BlockEntry = Extract<TranscriptEntry, { kind: "thinking" | "tool" | "skill" }>;

/** The kinds whose whole detail hangs off their first row: a notice and a job panel. */
type HeadlineEntry = Extract<TranscriptEntry, { kind: "background" | "job" }>;

/** The entry with its expansion flipped, sharing every other entry with the input array. */
function withToggled(
  entries: readonly TranscriptEntry[],
  index: number,
  entry: CollapsibleEntry,
  options: LayoutOptions,
): readonly TranscriptEntry[] {
  return entries.map((row, position) =>
    position === index ? { ...entry, open: !(entry.open ?? options.expanded) } : row,
  );
}

/**
 * The kinds whose headline is their first row and nothing else: a notice's summary and a job
 * panel's own headline. The lines they reveal never toggle them back.
 */
function headlineOnly(entry: TranscriptEntry): entry is HeadlineEntry {
  return entry.kind === "background" || entry.kind === "job";
}

/**
 * The row a thinking, tool or skill block toggles on beyond its first: a skill's own
 * invocation is a row of its own, drawn above its header, and both toggle it.
 */
function hintRow(entry: BlockEntry, first: number, options: LayoutOptions): number {
  if (entry.kind !== "skill") return first;
  const invocation: TranscriptEntry = {
    kind: "user",
    text: `/${entry.name}${entry.args === "" ? "" : ` ${entry.args}`}`,
  };
  return first + layoutTranscript([invocation], options).length;
}

/**
 * Toggle only structural header rows, never wrapped continuations or body text. An
 * attachment toggles on its label row alone, and only when its status carries a body:
 * `path-only` and `refused` rows have nothing to reveal. A notice and a job panel toggle on
 * their first row alone, and a collapsible listing on its title row — its count row and its
 * output never toggle it back — while a listing that was not opted in never toggles at all.
 */
export function toggleTranscriptLine(
  entries: readonly TranscriptEntry[],
  line: number,
  options: LayoutOptions,
): readonly TranscriptEntry[] {
  const owners = transcriptLineOwners(entries, options);
  const index = owners[line];
  if (index === undefined) return entries;
  const entry = entries[index];
  const first = owners.indexOf(index);
  if (entry.kind === "attachment") {
    if (!attachmentExpandable(entry.status) || line !== first) return entries;
    return withToggled(entries, index, entry, options);
  }
  if (headlineOnly(entry)) {
    if (line !== first) return entries;
    return withToggled(entries, index, entry, options);
  }
  // A collapsible listing's title is its first row; a slash listing never collapses at all.
  if (entry.kind === "listing") {
    if (entry.collapsible !== true || line !== first) return entries;
    return withToggled(entries, index, entry, options);
  }
  if (entry.kind !== "thinking" && entry.kind !== "tool" && entry.kind !== "skill") return entries;
  const hint = hintRow(entry, first, options);
  if (line !== first && line !== hint) return entries;
  return withToggled(entries, index, entry, options);
}
