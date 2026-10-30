import type { TranscriptEntry } from "./transcript-model";

/** Slash output is one listing per run, or one notice per statement. */
export interface SlashSink {
  show(text: string): void;
  flush(): void;
}

export function slashSink(title: string | undefined, append: (entry: TranscriptEntry) => void): SlashSink {
  const rows: string[] = [];
  return {
    show(text) {
      if (title === undefined) {
        append({ kind: "notice", text });
        return;
      }
      rows.push(text);
    },
    flush() {
      if (title === undefined || rows.length === 0) return;
      append({ kind: "listing", title, text: rows.join("\n") });
    },
  };
}
