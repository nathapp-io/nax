import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "@nathapp/nax-agent";
import {
  createToolEvents,
  DIFF_COUNT_MAX_CHARS,
  diffSummary,
  inputOf,
  MAX_TRACKED_CALLS,
  previewOf,
  resultBytesOf,
  UNANSWERED_PREVIEW,
} from "#src/client/tool-events";

const SECRET = "s3cr3t-token-value-0123";

function setup(secrets: readonly string[] = []) {
  const events: TurnEvent[] = [];
  const tools = createToolEvents((event) => events.push(event), secrets);
  return { events, tools };
}

const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

describe("createToolEvents: when a call is announced (D5-c)", () => {
  test("a pending call with streaming input emits nothing until it is used", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c1", name: "Read", title: "Read", kind: "read", status: "pending", rawInput: {} });
    tools.onUpdate({ toolCallId: "c1", rawInput: { file_path: "/w/a.ts" } });
    expect(events).toEqual([]);
    tools.onUpdate({ toolCallId: "c1", status: "completed", content: [text("body")] });
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "/w/a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "body", resultBytes: 4 },
    ]);
  });

  test("in_progress announces; failed answers with isError", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c2", name: "Bash", status: "pending", rawInput: { command: "ls" } });
    tools.onUpdate({ toolCallId: "c2", status: "in_progress" });
    expect(events).toEqual([{ type: "tool_call", callId: "c2", name: "Bash", input: { command: "ls" } }]);
    tools.onUpdate({ toolCallId: "c2", status: "failed", content: [text("Permission denied: no")] });
    expect(events.at(-1)).toEqual({
      type: "tool_result",
      callId: "c2",
      isError: true,
      preview: "Permission denied: no",
      resultBytes: 21,
    });
  });

  test("announce() (a permission request) emits tool_call once; a later in_progress does not repeat it", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c3", name: "Edit", status: "pending" });
    tools.announce({ toolCallId: "c3", title: "Edit a.ts", rawInput: { path: "a.ts" } });
    tools.onUpdate({ toolCallId: "c3", status: "in_progress" });
    expect(events).toEqual([{ type: "tool_call", callId: "c3", name: "Edit", input: { path: "a.ts" } }]);
  });

  test("announce() for a call never seen before tracks and announces it", () => {
    const { events, tools } = setup();
    tools.announce({ toolCallId: "fresh", title: "Run tests", kind: "execute" });
    expect(events).toEqual([{ type: "tool_call", callId: "fresh", name: "Run tests", input: {} }]);
  });
});

describe("createToolEvents: one result per announced call (D5-e)", () => {
  test("a repeated terminal update is ignored", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c1", name: "Read", status: "completed", content: [text("a")] });
    tools.onUpdate({ toolCallId: "c1", status: "completed", content: [text("b")] });
    tools.onUpdate({ toolCallId: "c1", status: "failed" });
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });

  test("flush answers announced calls without a result, and only those", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "started", name: "Bash", status: "in_progress" });
    tools.onUpdate({ toolCallId: "done", name: "Read", status: "completed" });
    tools.onUpdate({ toolCallId: "never-used", name: "Grep", status: "pending" });
    tools.flush();
    tools.flush();
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.callId)).toEqual(["started", "done"]);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", callId: "done", isError: false, preview: "", resultBytes: 0 },
      { type: "tool_result", callId: "started", isError: true, preview: UNANSWERED_PREVIEW, resultBytes: 0 },
    ]);
  });

  test("an update with no id, an unusable id, or an id holding a secret emits nothing", () => {
    const { events, tools } = setup([SECRET]);
    tools.onUpdate({ status: "completed" });
    tools.onUpdate({ toolCallId: 7, status: "completed" });
    tools.onUpdate({ toolCallId: `id-${SECRET}`, status: "completed" });
    tools.onUpdate("not an object");
    tools.announce(null);
    expect(events).toEqual([]);
  });

  test(`at most ${MAX_TRACKED_CALLS} calls are tracked per turn; known calls still complete`, () => {
    const { events, tools } = setup();
    for (let i = 0; i < MAX_TRACKED_CALLS; i += 1) tools.onUpdate({ toolCallId: `c${i}`, status: "pending" });
    tools.onUpdate({ toolCallId: "one-too-many", name: "X", status: "completed" });
    tools.onUpdate({ toolCallId: "c0", name: "Y", status: "completed" });
    expect(events.map((e) => ("callId" in e ? e.callId : ""))).toEqual(["c0", "c0"]);
  });
});

describe("createToolEvents: names (D5-d)", () => {
  const nameOf = (update: Record<string, unknown>): string | undefined => {
    const { events, tools } = setup([SECRET]);
    tools.onUpdate({ toolCallId: "n", status: "in_progress", ...update });
    const first = events[0];
    return first?.type === "tool_call" ? first.name : undefined;
  };

  test("the agent's tool name first, then a real title, then kind, then 'tool'", () => {
    expect(nameOf({ name: "mcp__nax__lookup", title: "Lookup", kind: "other" })).toBe("mcp__nax__lookup");
    expect(nameOf({ title: "Read a.ts", kind: "read" })).toBe("Read a.ts");
    expect(nameOf({ title: "Tool Call", kind: "execute" })).toBe("execute");
    expect(nameOf({ title: "TOOL" })).toBe("tool");
    expect(nameOf({})).toBe("tool");
  });

  test("the first real title is kept over later ones", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "t", title: "tool call", status: "pending" });
    tools.onUpdate({ toolCallId: "t", title: "Read a.ts" });
    tools.onUpdate({ toolCallId: "t", title: "Read b.ts", status: "in_progress" });
    expect(events[0]).toMatchObject({ type: "tool_call", name: "Read a.ts" });
  });

  test("names are one line, visible, scrubbed and capped at 200 characters", () => {
    expect(nameOf({ name: `Bash\n‮${SECRET}` })).toBe("Bash [REDACTED]");
    expect(nameOf({ name: "n".repeat(500) })).toHaveLength(200);
  });
});

describe("inputOf and previewOf (D5-f)", () => {
  test("input: absent is {}; secrets scrubbed and redacted; small input kept as is", () => {
    expect(inputOf(undefined, [])).toEqual({});
    expect(inputOf(null, [])).toEqual({});
    expect(inputOf({ command: `curl ${SECRET}`, n: 1 }, [SECRET])).toEqual({ command: "curl [REDACTED]", n: 1 });
    expect(inputOf({ api_key: "abc123456789" }, [])).not.toEqual({ api_key: "abc123456789" });
  });

  test("input: over the JSON cap becomes { truncated, preview }", () => {
    const big = inputOf({ content: "x".repeat(20_000) }, []);
    expect(big).toMatchObject({ truncated: true });
    expect(JSON.stringify(big).length).toBeLessThan(9_000);
  });

  test("preview: text blocks, resource links and diffs, joined by newlines; terminals skipped", () => {
    expect(
      previewOf(
        {
          content: [
            text("line one"),
            { type: "content", content: { type: "resource_link", uri: "file:///w/a.ts", name: "a.ts" } },
            { type: "diff", path: "/w/b.ts", oldText: "a\nb\nc", newText: "a\nB\nc\nd" },
            { type: "terminal", terminalId: "t1" },
            { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
          ],
        },
        [],
      ),
    ).toBe("line one\nfile:///w/a.ts\nedit /w/b.ts (+2 -1)");
  });

  test("preview: rawOutput string when there is no content; scrubbed, stripped, capped at 4096 bytes", () => {
    expect(previewOf({ rawOutput: `out ${SECRET}\u0007` }, [SECRET])).toBe("out [REDACTED]");
    expect(previewOf({ rawOutput: { not: "a string" } }, [])).toBe("");
    expect(Buffer.byteLength(previewOf({ content: [text("y".repeat(100_000))] }, []))).toBeLessThanOrEqual(4096);
  });

  test("diffSummary: a new file, a deletion, a missing path, and a diff too large to count", () => {
    expect(diffSummary({ path: "/w/new.ts", newText: "a\nb" })).toBe("edit /w/new.ts (+2 -0)");
    expect(diffSummary({ path: "/w/gone.ts", oldText: "a\nb", newText: "" })).toBe("edit /w/gone.ts (+0 -2)");
    expect(diffSummary({ newText: "a" })).toBe("edit (unknown path) (+1 -0)");
    const huge = "z\n".repeat(DIFF_COUNT_MAX_CHARS);
    expect(diffSummary({ path: "/w/huge.ts", oldText: "", newText: huge })).toBe("edit /w/huge.ts");
  });
});

describe("resultBytes (S4b spec §7.4)", () => {
  test("a completed call carries the UTF-8 byte length of its full result", () => {
    const { events, tools } = setup();
    tools.onUpdate({
      toolCallId: "c1",
      name: "Read",
      status: "completed",
      rawInput: {},
      content: [text("h\u00e9llo")],
    });
    expect(events.at(-1)).toEqual({
      type: "tool_result",
      callId: "c1",
      isError: false,
      preview: "h\u00e9llo",
      resultBytes: 6,
    });
  });

  test("Review Focus 4: bytes count the raw output, not the capped preview or characters", () => {
    expect(resultBytesOf({ content: [text("\u00e9".repeat(100_000))] })).toBe(200_000);
    expect(resultBytesOf({ rawOutput: "abc" })).toBe(3);
    expect(resultBytesOf({ content: [text("a"), text("b")] })).toBe(3);
    expect(resultBytesOf({})).toBe(0);
  });

  test("an unanswered call reports 0 bytes", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c9", name: "Bash", status: "in_progress", rawInput: {} });
    tools.flush();
    expect(events.at(-1)).toMatchObject({ type: "tool_result", callId: "c9", isError: true, resultBytes: 0 });
  });
});

describe("tool_progress (S4b-0 finding f)", () => {
  test("a heartbeat on a running call emits tool_progress, throttled per call", () => {
    let now = 0;
    const events: TurnEvent[] = [];
    const tools = createToolEvents(
      (event) => events.push(event),
      [],
      () => now,
    );
    tools.onUpdate({ toolCallId: "c1", name: "Bash", status: "in_progress", rawInput: { command: "sleep" } });
    tools.onUpdate({ toolCallId: "c1" });
    now = 10_000;
    tools.onUpdate({ toolCallId: "c1" });
    now = 31_000;
    tools.onUpdate({ toolCallId: "c1", status: "in_progress" });
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Bash", input: { command: "sleep" } },
      { type: "tool_progress", callId: "c1" },
      { type: "tool_progress", callId: "c1" },
    ]);
  });

  test("the throttle is per call", () => {
    const events: TurnEvent[] = [];
    const tools = createToolEvents(
      (event) => events.push(event),
      [],
      () => 0,
    );
    tools.onUpdate({ toolCallId: "a", name: "Bash", status: "in_progress", rawInput: {} });
    tools.onUpdate({ toolCallId: "b", name: "Bash", status: "in_progress", rawInput: {} });
    tools.onUpdate({ toolCallId: "a" });
    tools.onUpdate({ toolCallId: "b" });
    expect(events.filter((e) => e.type === "tool_progress")).toEqual([
      { type: "tool_progress", callId: "a" },
      { type: "tool_progress", callId: "b" },
    ]);
  });

  test("no tool_progress before the call is announced or after it resolved", () => {
    let now = 0;
    const events: TurnEvent[] = [];
    const tools = createToolEvents(
      (event) => events.push(event),
      [],
      () => now,
    );
    tools.onUpdate({ toolCallId: "c2", name: "Read", status: "pending", rawInput: {} });
    tools.onUpdate({ toolCallId: "c2" });
    tools.onUpdate({ toolCallId: "c2", status: "completed", content: [text("x")] });
    now = 60_000;
    tools.onUpdate({ toolCallId: "c2" });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });
});
