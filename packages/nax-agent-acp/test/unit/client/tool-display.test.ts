import { describe, expect, test } from "bun:test";
import { TOOL_CALL_INPUT_BYTES } from "@nathapp/nax-agent";
import {
  COMMAND_RAW_MAX_BYTES,
  describeToolCall,
  SUMMARY_MAX_BYTES,
  SUMMARY_RAW_MAX_BYTES,
} from "#src/client/tool-display";

const SECRET = "s3cr3t-token-value-0123";
const GH_TOKEN = `ghp_${"a".repeat(36)}`;
/** maskForPrompt refuses it: an assignment secret spans shell syntax (nax-agent secret-spans.test.ts). */
const UNMASKABLE = "TOKEN=abc;rm x";

describe("describeToolCall (spec §6.4 untrusted fields, D3-a)", () => {
  test("title, kind and call id as given", () => {
    expect(describeToolCall({ toolCallId: "call-1", kind: "edit", title: "Edit `src/a.ts`" }, [])).toEqual({
      callId: "call-1",
      tool: "edit",
      summary: "Edit `src/a.ts`",
      showable: true,
    });
  });

  test("execute: rawInput.command becomes the command", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
      [],
    );
    expect(shown).toMatchObject({ tool: "execute", summary: "Run tests", command: "bun test ./x", showable: true });
  });

  test("a command is only taken from kind execute", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "edit", rawInput: { command: "rm -rf /" } }, []).command).toBe(
      undefined,
    );
  });

  test("no title: kind plus the first location path, else kind alone", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "read", locations: [{ path: "/w/a.ts" }] }, []).summary).toBe(
      "read /w/a.ts",
    );
    expect(describeToolCall({ toolCallId: "c", kind: "fetch", title: "   " }, []).summary).toBe("fetch tool call");
  });

  test("an unknown or missing kind is other", () => {
    expect(describeToolCall({ toolCallId: "c", kind: "__proto__" }, []).tool).toBe("other");
    expect(describeToolCall({ toolCallId: "c" }, []).tool).toBe("other");
  });

  test("malformed tool calls are described, not thrown on", () => {
    expect(describeToolCall(null, [])).toEqual({ tool: "other", summary: "other tool call", showable: true });
    const odd = JSON.parse('{"toolCallId":42,"title":["x"],"locations":"nope","rawInput":null,"kind":"execute"}');
    expect(describeToolCall(odd, [])).toEqual({ tool: "execute", summary: "execute tool call", showable: true });
  });

  test("an unusable call id is dropped", () => {
    expect(describeToolCall({ toolCallId: "" }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: "x".repeat(513) }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: "a\u0000b\u200b c" }, []).callId).toBe("abc");
  });

  test("a call id holding a secret is dropped, not shown masked", () => {
    expect(describeToolCall({ toolCallId: GH_TOKEN }, []).callId).toBe(undefined);
    expect(describeToolCall({ toolCallId: `id-${SECRET}` }, [SECRET]).callId).toBe(undefined);
  });

  test("summary is one line; a command keeps its newlines; invisible characters are stripped", () => {
    const shown = describeToolCall(
      {
        toolCallId: "c",
        kind: "execute",
        title: "Run\n  the\ttests\u202e",
        rawInput: { command: "cd x\nbun test" },
      },
      [],
    );
    expect(shown.summary).toBe("Run the tests");
    expect(shown.command).toBe("cd x\nbun test");
  });

  test("line and paragraph separators fold in the one-line summary but not the command", () => {
    const shown = describeToolCall(
      {
        toolCallId: "c",
        kind: "execute",
        title: "Line\u2028Break\u2029Here",
        rawInput: { command: "cd x\nbun test" },
      },
      [],
    );
    expect(shown.summary).toBe("Line Break Here");
    expect(/[\u2028\u2029]/.test(shown.summary)).toBe(false);
    expect(shown.command).toBe("cd x\nbun test");
    expect(shown.showable).toBe(true);
  });

  test("oversized raw text is withheld without being masked (maskForPrompt is quadratic)", () => {
    const flood = "sk-".repeat(100_000);
    const started = Date.now();
    const titled = describeToolCall({ toolCallId: "c", kind: "edit", title: flood }, []);
    const commanded = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run", rawInput: { command: flood } },
      [],
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(titled).toMatchObject({
      summary: "edit tool call (details withheld: they could not be shown safely)",
      showable: false,
    });
    expect(commanded).toMatchObject({ summary: "Run", showable: false });
    expect(commanded.command).toBe(undefined);
  });

  test("text at the raw limits is still shown", () => {
    expect(describeToolCall({ toolCallId: "c", title: "t".repeat(SUMMARY_RAW_MAX_BYTES) }, []).showable).toBe(true);
    const atLimit = { toolCallId: "c", kind: "execute", rawInput: { command: "c".repeat(COMMAND_RAW_MAX_BYTES) } };
    expect(describeToolCall(atLimit, []).showable).toBe(true);
  });

  test("control characters stripped; session secrets and pattern secrets masked", () => {
    const shown = describeToolCall(
      {
        toolCallId: "c",
        kind: "execute",
        title: `Use ${SECRET}\u001b[0m`,
        rawInput: { command: `curl -u ${GH_TOKEN} https://x?k=${SECRET}` },
      },
      [SECRET],
    );
    expect(shown.summary).toBe("Use [REDACTED][0m");
    expect(shown.command).not.toContain(SECRET);
    expect(shown.command).not.toContain(GH_TOKEN);
    expect(shown.command).toContain("[REDACTED");
    expect(shown.showable).toBe(true);
  });

  test("summary and command are capped", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "t".repeat(5_000), rawInput: { command: "c".repeat(20_000) } },
      [],
    );
    expect(Buffer.byteLength(shown.summary)).toBe(SUMMARY_MAX_BYTES);
    expect(Buffer.byteLength(shown.command ?? "")).toBe(TOOL_CALL_INPUT_BYTES);
  });

  test("a secret that cannot be masked safely makes the request unshowable (D3-b)", () => {
    const shown = describeToolCall(
      { toolCallId: "c", kind: "execute", title: "Run", rawInput: { command: UNMASKABLE } },
      [],
    );
    expect(shown.showable).toBe(false);
    expect(shown.command).toBe(undefined);
    const titled = describeToolCall({ toolCallId: "c", kind: "execute", title: UNMASKABLE }, []);
    expect(titled).toMatchObject({
      summary: "execute tool call (details withheld: they could not be shown safely)",
      showable: false,
    });
  });
});
