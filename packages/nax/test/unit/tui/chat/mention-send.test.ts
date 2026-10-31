/**
 * The send path's mention handling, in isolation: whether a typed message is worth expanding,
 * the prepare step that expands it once, and what a sent message becomes in the transcript.
 */
import { describe, expect, mock, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { formatMentionMessage, type MentionRecord, type MentionWhere, parseMentionMessage } from "@/chat";
import { buildSkillInvocationMessage } from "@/prompts/builders/skills-builder";
import { mentionTranscriptEntries } from "@/tui/chat/mention-entries";
import { mentionPrepare, needsMentionExpansion, sentEntries } from "@/tui/chat/mention-send";

/** Where a mention is resolved: the process cwd, and the repo it must stay inside. */
const WHERE: MentionWhere = { cwd: "/repo/pkg", repoRoot: "/repo" };
/** A mention of a two-line file, as the expander records it. */
const ATTACHED_A: MentionRecord = { path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" };

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
    const content = buildSkillInvocationMessage({
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
    expect(sentEntries(content)).toEqual([
      { kind: "skill", name: "superpowers:brainstorming", args: "", body: "body" },
    ]);
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
});
