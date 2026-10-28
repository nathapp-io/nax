import { describe, expect, test } from "bun:test";
import { layoutTranscript, transcriptLineOwners } from "@/tui/chat/layout";
import { plainText } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme = resolveChatTheme({ env: {}, colorLevel: 0 });
const thought: TranscriptEntry = {
  kind: "thinking",
  turnId: "t",
  text: "secret thought",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T00:00:01Z",
};
const skill: TranscriptEntry = { kind: "skill", name: "demo", args: "long arguments to wrap", body: "secret body" };
const tool: TranscriptEntry = {
  kind: "tool",
  turnId: "t",
  callId: "c",
  name: "Bash",
  input: { command: "echo demo" },
  status: "ok",
  startedAt: "2026-01-01T00:00:00Z",
  children: [],
  preview: "one\ntwo\nthree\nfour\nfive\nsix\nsecret output",
};
describe("transcriptLineOwners", () => {
  test.each([10, 40, 100])("AC-1 matches every line at width %i", (width) => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "long user message\nsecond row" },
      thought,
      skill,
      tool,
      { ...thought, endedAt: undefined },
    ];
    for (const expanded of [false, true]) {
      const options = { width, theme, expanded };
      const owners = transcriptLineOwners(entries, options);
      expect(owners).toHaveLength(layoutTranscript(entries, options).length);
      expect(owners.filter((owner) => owner !== undefined)).toEqual(
        entries.flatMap((entry, index) => layoutTranscript([entry], options).map(() => index)),
      );
    }
  });
  test("AC-2 owns user and thinking rows but not the separator", () => {
    expect(
      transcriptLineOwners([{ kind: "user", text: "first\nsecond" }, thought], { width: 100, theme, expanded: true }),
    ).toEqual([0, 0, undefined, 1, 1]);
  });
});
describe("layoutTranscript overrides", () => {
  test.each([
    ["AC-3/4 thinking", thought, "secret thought"],
    ["AC-5 tool", tool, "secret output"],
    ["AC-6 skill", skill, "secret body"],
  ] as const)("%s respects explicit open in both global states", (_name, entry, detail) => {
    const text = (open: boolean, expanded: boolean) =>
      layoutTranscript([{ ...entry, open }], { width: 100, theme, expanded })
        .map(plainText)
        .join("\n");
    expect([text(true, false).includes(detail), text(false, true).includes(detail)]).toEqual([true, false]);
  });
});
