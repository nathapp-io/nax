/**
 * US-006 — the text helpers behind the unread tool-call follow-up: which tool
 * names an assistant reply wrote in its `<tool_call>` blocks, which declared
 * name is nearest to a written one, and the follow-up that names the mistake.
 */
import { describe, expect, test } from "bun:test";
import {
  buildUnreadToolCallFollowUp,
  MAX_SUGGEST_DISTANCE,
  nearestToolName,
  writtenToolNames,
} from "#src/native/session/unread-tool-call";

/** The lead sentence the follow-up has always carried, spelled out here. */
function existingText(names: string): string {
  return `Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: ${names}.`;
}

describe("writtenToolNames", () => {
  test("AC-1: the JSON name value of a block", () => {
    expect(writtenToolNames('<tool_call>{"name": "ScrashpadWrite", "arguments": {}}</tool_call>')).toEqual([
      "ScrashpadWrite",
    ]);
  });

  test("AC-2: a bare name at the start of the block", () => {
    expect(writtenToolNames("<tool_call>\nScrashpadWrite\n<arg_key>path</arg_key></tool_call>")).toEqual([
      "ScrashpadWrite",
    ]);
  });

  test("AC-3: no name value and the first non-whitespace character is not a name", () => {
    expect(writtenToolNames('<tool_call>{"arguments": {"path": "a"}}</tool_call>')).toEqual([]);
  });

  test("AC-4: two blocks naming the same tool yield one name", () => {
    expect(writtenToolNames('<tool_call>{"name": "Raed"}</tool_call><tool_call>{"name": "Raed"}</tool_call>')).toEqual([
      "Raed",
    ]);
  });

  test("AC-5: blocks keep first-seen order", () => {
    expect(writtenToolNames('<tool_call>{"name": "B"}</tool_call><tool_call>{"name": "A"}</tool_call>')).toEqual([
      "B",
      "A",
    ]);
  });

  test("AC-6: an empty block yields no name", () => {
    expect(writtenToolNames("<tool_call></tool_call>")).toEqual([]);
  });

  test("AC-7: an unterminated block is scanned to the end of the text", () => {
    expect(writtenToolNames('<tool_call>{"name":"Grep"')).toEqual(["Grep"]);
  });

  test("AC-8: a name value that is not a tool name is dropped", () => {
    expect(writtenToolNames('<tool_call>{"name": "bad name!"}</tool_call>')).toEqual([]);
  });

  test("AC-9: a name value longer than 64 characters is dropped, 64 is kept", () => {
    expect(writtenToolNames(`<tool_call>{"name": "${"x".repeat(65)}"}</tool_call>`)).toEqual([]);
    expect(writtenToolNames(`<tool_call>{"name": "${"x".repeat(64)}"}</tool_call>`)).toEqual(["x".repeat(64)]);
  });

  test("a bare run that is not a tool name contributes nothing", () => {
    expect(writtenToolNames("<tool_call>\n9lives\n</tool_call>")).toEqual([]);
    expect(writtenToolNames("<tool_call>\n.tool\n</tool_call>")).toEqual([]);
    // The run stops at the first non-name character, so this reads as `bad`.
    expect(writtenToolNames("<tool_call>\nbad name!\n</tool_call>")).toEqual(["bad"]);
  });

  test("text with no block has no names", () => {
    expect(writtenToolNames("plain reply naming Read")).toEqual([]);
  });
});

describe("nearestToolName", () => {
  test("AC-10: a transposed declared name is found", () => {
    expect(nearestToolName("ScrashpadWrite", ["Read", "ScratchpadWrite"])).toBe("ScratchpadWrite");
  });

  test("AC-11: the comparison is case-insensitive and returns declared casing", () => {
    expect(nearestToolName("read", ["Read", "Write"])).toBe("Read");
  });

  test("AC-12: nothing within the distance bound is undefined", () => {
    expect(nearestToolName("Deploy", ["Read", "Write"])).toBeUndefined();
  });

  test("AC-13: no declared names is undefined", () => {
    expect(nearestToolName("Read", [])).toBeUndefined();
  });

  test("AC-14: a tie returns the first in declared order", () => {
    expect(nearestToolName("Raad", ["Read", "Road"])).toBe("Read");
  });

  test("the bound is MAX_SUGGEST_DISTANCE characters of edit", () => {
    expect(MAX_SUGGEST_DISTANCE).toBe(2);
    expect(nearestToolName("Re", ["Read"])).toBe("Read");
    expect(nearestToolName("R", ["Read"])).toBeUndefined();
  });

  test("a name written in its own casing is distance 0", () => {
    expect(nearestToolName("read", ["read"])).toBe("read");
    expect(nearestToolName("Read", ["read", "Read"])).toBe("read");
  });
});

describe("buildUnreadToolCallFollowUp", () => {
  test("AC-15: an undeclared name with a near declared one is named and suggested", () => {
    expect(
      buildUnreadToolCallFollowUp('<tool_call>{"name": "ScrashpadWrite"}</tool_call>', ["Read", "ScratchpadWrite"]),
    ).toBe(
      "Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: Read, ScratchpadWrite. `ScrashpadWrite` is not a declared tool; did you mean `ScratchpadWrite`?",
    );
  });

  test("AC-16: an undeclared name with no near match gets no suggestion", () => {
    const text = buildUnreadToolCallFollowUp('<tool_call>{"name": "Deploy"}</tool_call>', ["Read"]);
    expect(text).toBe(
      "Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: Read. `Deploy` is not a declared tool.",
    );
    expect(text).toEndWith("`Deploy` is not a declared tool.");
  });

  test("AC-17: a declared name leaves the existing text unchanged", () => {
    expect(buildUnreadToolCallFollowUp('<tool_call>{"name": "Read"}</tool_call>', ["Read"])).toBe(
      "Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: Read.",
    );
  });

  test("AC-20: an unread block naming no valid tool adds no suggestion sentence", () => {
    const text = buildUnreadToolCallFollowUp('<tool_call>{"name": "bad name!"}</tool_call>', ["Read", "Write"]);
    expect(text).toBe(
      "Your reply contains a <tool_call> block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: Read, Write.",
    );
    expect(text).not.toContain("is not a declared tool.");
  });

  test("no declared tools still gets the (none) text and the mistake named", () => {
    expect(buildUnreadToolCallFollowUp('<tool_call>{"name": "ScrashpadWrite"}</tool_call>', [])).toBe(
      `${existingText("(none)")} \`ScrashpadWrite\` is not a declared tool.`,
    );
  });

  test("each undeclared name contributes its own sentence, in written order", () => {
    expect(
      buildUnreadToolCallFollowUp(
        '<tool_call>{"name": "Raed"}</tool_call><tool_call>{"name": "Deploy"}</tool_call><tool_call>{"name": "Read"}</tool_call>',
        ["Read", "ScratchpadWrite"],
      ),
    ).toBe(
      `${existingText("Read, ScratchpadWrite")} \`Raed\` is not a declared tool; did you mean \`Read\`? \`Deploy\` is not a declared tool.`,
    );
  });
});
