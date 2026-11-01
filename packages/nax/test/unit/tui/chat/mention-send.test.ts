/**
 * The send path's mention handling, in isolation: whether a typed message is worth expanding,
 * the prepare step that expands it once, and what a sent message becomes in the transcript.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ImageAttachment } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import {
  formatMentionMessage,
  imageNoteLabel,
  type MentionRecord,
  type MentionWhere,
  parseMentionMessage,
} from "@/chat";
import type { BackgroundTask } from "@/chat/background";
import { buildBackgroundTaskNotice } from "@/prompts";
import { buildSkillInvocationMessage } from "@/prompts/builders/skills-builder";
import { mentionTranscriptEntries } from "@/tui/chat/mention-entries";
import { mentionPrepare, needsMentionExpansion, sentEntries } from "@/tui/chat/mention-send";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

/** Where a mention is resolved: the process cwd, and the repo it must stay inside. */
const WHERE: MentionWhere = { cwd: "/repo/pkg", repoRoot: "/repo" };
/** A mention of a two-line file, as the expander records it. */
const ATTACHED_A: MentionRecord = { path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" };
/** A skill invocation, as nax's own prompt builder writes one. */
const SKILL_CONTENT = buildSkillInvocationMessage({
  skill: {
    kind: "skill",
    name: "brainstorming",
    qualifiedName: "superpowers:brainstorming",
    description: "test skill",
    body: "body",
    baseDir: "/skills/brainstorming",
    path: "/skills/brainstorming/SKILL.md",
    modelInvocable: true,
    origin: { kind: "claude-project" },
  },
  args: "",
});
/** A pasted 2×3 PNG, as the transcript labels it. */
const IMAGE: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 3, source: "clipboard" };
/** A background command as the registry records it; a case overrides the id and the state. */
const TASK: BackgroundTask = {
  id: "bash-00000000",
  command: "bun test",
  origin: "agent",
  startedAt: "2026-01-01T00:00:00.000Z",
  state: "running",
  logPath: "/o/chat-tasks/bash-00000000.log",
};

describe("needsMentionExpansion", () => {
  test.each([
    ["a mention token", "see @a.ts", true],
    ["a pasted trailer with no token", "x </nax-mentions y", true],
    ["neither a token nor a trailer", "hello", false],
    ["an empty message", "", false],
  ])("%s => %p", (_case, text, expected) => {
    expect(needsMentionExpansion(text)).toBe(expected);
  });
});

describe("mentionPrepare", () => {
  test("resolves the expanded message the expander returns", async () => {
    const expand = mock(async (text: string) => ({ message: `EXPANDED ${text}`, records: [] }));
    const prepare = mentionPrepare("see @a.ts", WHERE, expand);
    assertDefined(prepare, "a message with a mention is prepared");
    expect(await prepare()).toEqual({ message: "EXPANDED see @a.ts" });
  });

  test("asks the expander once, about the typed text and where the user is", async () => {
    const expand = mock(async (text: string) => ({ message: `EXPANDED ${text}`, records: [] }));
    const prepare = mentionPrepare("x </nax-mentions y", WHERE, expand);
    assertDefined(prepare, "a message with a trailer is prepared");
    await prepare();
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("x </nax-mentions y", WHERE);
  });

  test("is undefined for a message with nothing to expand, so the plain send is kept", () => {
    const expand = mock(async (text: string) => ({ message: text, records: [] }));
    expect(mentionPrepare("hello", WHERE, expand)).toBeUndefined();
    expect(expand).not.toHaveBeenCalled();
  });
});

describe("sentEntries", () => {
  test("keeps a skill invocation as its skill entry", () => {
    expect(sentEntries(SKILL_CONTENT)).toEqual([
      { kind: "skill", name: "superpowers:brainstorming", args: "", body: "body" },
    ]);
  });

  test("US-004 AC-11: rows a skill's lost image at its number, ahead of the one that survived", () => {
    const expected: readonly TranscriptEntry[] = [
      { kind: "skill", name: "superpowers:brainstorming", args: "", body: "body" },
      { kind: "image", label: "image 1 · missing" },
      { kind: "image", label: imageNoteLabel(2, IMAGE) },
    ];
    expect(sentEntries(SKILL_CONTENT, [IMAGE], [1])).toEqual(expected);
  });

  test("renders an expanded message as its mention entries", () => {
    const content = formatMentionMessage("see @a.ts", [ATTACHED_A]);
    const parsed = parseMentionMessage(content);
    assertDefined(parsed, "the expanded message parses");
    const entries = sentEntries(content);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "attachment"]);
    expect(entries).toEqual(mentionTranscriptEntries(parsed));
  });

  test("keeps a message nax did not expand as one user entry", () => {
    expect(sentEntries("see @a.ts")).toEqual([{ kind: "user", text: "see @a.ts" }]);
  });

  test("AC-1 a background task notice becomes one collapsed background entry", () => {
    const text = buildBackgroundTaskNotice([
      { ...TASK, id: "bash-11111111", state: "succeeded", exitCode: 0 },
      { ...TASK, id: "bash-22222222", state: "succeeded", exitCode: 0 },
      { ...TASK, id: "bash-33333333", state: "succeeded", exitCode: 0 },
    ]);
    expect(sentEntries(text)).toEqual([
      { kind: "background", summary: "3 background commands ended · 3 succeeded", text },
    ]);
  });

  test("AC-2 ordinary text is still one user entry", () => {
    expect(sentEntries("hello")).toEqual([{ kind: "user", text: "hello" }]);
  });

  test("AC-10 notice-looking text with no known notice line stays a user entry", () => {
    expect(sentEntries("[nax-tasks] something else")).toEqual([{ kind: "user", text: "[nax-tasks] something else" }]);
  });

  test("a notice-shaped message that carries a picture keeps the picture's row", () => {
    const text = buildBackgroundTaskNotice([{ ...TASK, id: "bash-44444444", state: "succeeded", exitCode: 0 }]);
    expect(sentEntries(text, [IMAGE])).toEqual([
      { kind: "user", text },
      { kind: "image", label: imageNoteLabel(1, IMAGE) },
    ]);
  });
});
