import { type LayoutOptions, layoutTranscript, transcriptLineOwners } from "./layout";
import { attachmentExpandable } from "./layout-attachment";
import type { TranscriptEntry } from "./transcript-model";

/** The entries whose detail a header row can open: everything with an `open` flag. */
type CollapsibleEntry = Extract<TranscriptEntry, { kind: "thinking" | "tool" | "skill" | "attachment" }>;

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
 * Toggle only structural header rows, never wrapped continuations or body text. An
 * attachment toggles on its label row alone, and only when its status carries a body:
 * `path-only` and `refused` rows have nothing to reveal.
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
  if (entry.kind !== "thinking" && entry.kind !== "tool" && entry.kind !== "skill") return entries;
  const hint =
    entry.kind === "skill"
      ? first +
        layoutTranscript(
          [{ kind: "user", text: `/${entry.name}${entry.args === "" ? "" : ` ${entry.args}`}` }],
          options,
        ).length
      : first;
  if (line !== first && line !== hint) return entries;
  return withToggled(entries, index, entry, options);
}
