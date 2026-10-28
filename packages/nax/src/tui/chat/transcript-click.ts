import { type LayoutOptions, layoutTranscript, transcriptLineOwners } from "./layout";
import type { TranscriptEntry } from "./transcript-model";

/** Toggle only structural header rows, never wrapped continuations or body text. */
export function toggleTranscriptLine(
  entries: readonly TranscriptEntry[],
  line: number,
  options: LayoutOptions,
): readonly TranscriptEntry[] {
  const owners = transcriptLineOwners(entries, options);
  const index = owners[line];
  if (index === undefined) return entries;
  const entry = entries[index];
  if (entry.kind !== "thinking" && entry.kind !== "tool" && entry.kind !== "skill") return entries;
  const first = owners.indexOf(index);
  const hint =
    entry.kind === "skill"
      ? first +
        layoutTranscript(
          [{ kind: "user", text: `/${entry.name}${entry.args === "" ? "" : ` ${entry.args}`}` }],
          options,
        ).length
      : first;
  if (line !== first && line !== hint) return entries;
  return entries.map((row, position) =>
    position === index ? { ...entry, open: !(entry.open ?? options.expanded) } : row,
  );
}
