import { describe, expect, test } from "bun:test";
import { slashSink } from "@/tui/chat/slash-sink";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

function collector(): { entries: TranscriptEntry[]; append: (entry: TranscriptEntry) => void } {
  const entries: TranscriptEntry[] = [];
  return { entries, append: (entry) => entries.push(entry) };
}

describe("slashSink", () => {
  test("appends one notice immediately per show when the title is undefined", () => {
    const { entries, append } = collector();
    const sink = slashSink(undefined, append);
    sink.show("first");
    expect(entries).toEqual([{ kind: "notice", text: "first" }]);
    sink.show("second");
    expect(entries).toEqual([
      { kind: "notice", text: "first" },
      { kind: "notice", text: "second" },
    ]);
    sink.flush();
    expect(entries).toHaveLength(2);
  });

  test("buffers shown rows until flush when a title is given", () => {
    const { entries, append } = collector();
    const sink = slashSink("Skills", append);
    sink.show("first");
    sink.show("second");
    expect(entries).toEqual([]);
  });

  test("flush appends one newline-joined listing entry", () => {
    const { entries, append } = collector();
    const sink = slashSink("Skills", append);
    sink.show("first");
    sink.show("second");
    sink.flush();
    expect(entries).toEqual([{ kind: "listing", title: "Skills", text: "first\nsecond" }]);
  });

  test("flush appends nothing when nothing was shown", () => {
    const { entries, append } = collector();
    slashSink("Skills", append).flush();
    expect(entries).toEqual([]);
  });
});
