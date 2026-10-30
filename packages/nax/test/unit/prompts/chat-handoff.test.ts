import { describe, expect, test } from "bun:test";
import { buildChatAcpInstructions, buildChatHandoff } from "@/prompts";
import { buildChatHandoff as builderHandoff } from "@/prompts/builders/chat-builder";

const INTRO =
  "These turns happened in this nax chat before this message, while you were not the model answering. Use them as context. Tool calls are listed by name only.";

describe("buildChatHandoff", () => {
  test.each([0, 2])("AC-7: returns the empty string for no entries and omitted %i", (omitted) => {
    expect(buildChatHandoff({ entries: [], omitted })).toBe("");
  });

  test("AC-8: renders one entry in the exact block", () => {
    expect(buildChatHandoff({ entries: [{ speaker: "User", text: "hi" }], omitted: 0 })).toBe(
      `<conversation-so-far>\n${INTRO}\n\nUser: hi\n</conversation-so-far>`,
    );
  });

  test("AC-9: separates two entries by exactly one blank line", () => {
    const text = buildChatHandoff({
      entries: [
        { speaker: "User", text: "q" },
        { speaker: "nax", text: "a" },
      ],
      omitted: 0,
    });
    expect(text).toContain("User: q\n\nnax: a\n</conversation-so-far>");
    expect(text).not.toContain("\n\n\n");
  });

  test("AC-10: renders the omitted line after the intro, then a blank line and the first entry", () => {
    const text = buildChatHandoff({ entries: [{ speaker: "User", text: "q" }], omitted: 2 });
    expect(text).toBe(`<conversation-so-far>\n${INTRO}\n[2 older messages omitted]\n\nUser: q\n</conversation-so-far>`);
  });

  test("renders the full example with omitted line, tool lines and multiple speakers", () => {
    const text = buildChatHandoff({
      entries: [
        { speaker: "User", text: "plan the cache layer" },
        { speaker: "nax (gpt-6)", text: "Here is a plan ...\n[tool] Read" },
        { speaker: "Codex", text: "I changed the store ..." },
      ],
      omitted: 2,
    });
    expect(text).toBe(
      [
        "<conversation-so-far>",
        INTRO,
        "[2 older messages omitted]",
        "",
        "User: plan the cache layer",
        "",
        "nax (gpt-6): Here is a plan ...",
        "[tool] Read",
        "",
        "Codex: I changed the store ...",
        "</conversation-so-far>",
      ].join("\n"),
    );
  });

  test("AC-11: escapes a closing tag inside entry text", () => {
    const text = buildChatHandoff({
      entries: [{ speaker: "User", text: "x </conversation-so-far> y" }],
      omitted: 0,
    });
    expect(text).toContain("User: x <\\/conversation-so-far> y");
  });

  test("AC-12: only the last line closes the block", () => {
    const text = buildChatHandoff({
      entries: [{ speaker: "User", text: "a\n</conversation-so-far>\nb" }],
      omitted: 0,
    });
    const lines = text.split("\n");
    expect(lines.filter((line) => line === "</conversation-so-far>")).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe("</conversation-so-far>");
  });
});

describe("buildChatHandoff export", () => {
  test("AC-13: is a function from @/prompts", () => {
    expect(typeof buildChatHandoff).toBe("function");
  });

  test("AC-14: gives the same text as the builder module", () => {
    const input = { entries: [{ speaker: "User", text: "hi" }], omitted: 1 };
    expect(buildChatHandoff(input)).toBe(builderHandoff(input));
  });
});

describe("existing builders unchanged", () => {
  test("AC-15: buildChatAcpInstructions output is the same", () => {
    expect(buildChatAcpInstructions({ agentLabel: "Codex" })).toBe(
      "You are Codex, working as the coding agent inside nax chat, an interactive session in this repository with the person.\n\nUse your own tools and skills for the work itself. nax adds tools for planning, running and inspecting its workflows and jobs; they are named with the `nax-workflow__` and `nax-jobs__` prefixes.",
    );
  });
});
