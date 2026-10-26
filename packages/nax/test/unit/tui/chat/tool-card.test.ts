import { describe, expect, test } from "bun:test";
import {
  type CardLine,
  CHILD_PREVIEW_LINES,
  TOOL_ARG_LIMIT,
  type ToolCardModel,
  toolCardModel,
  toolTitle,
} from "@/tui/chat/tool-card";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const AT = "2026-10-01T00:00:00.000Z";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type ToolChild = ToolEntry["children"][number];

function toolEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: "tool",
    turnId: "t1",
    callId: "c1",
    name: "Read",
    input: { path: "a.ts" },
    startedAt: AT,
    status: "running",
    children: [],
    ...overrides,
  };
}

function card(overrides: Partial<ToolEntry> = {}): ToolCardModel {
  return toolCardModel(toolEntry(overrides), { expanded: false });
}

function child(callId: string, name: string, input: unknown): ToolChild {
  return { callId, name, input, status: "running" };
}

/** Five children of one agent run: the preview keeps the last three, so two are counted. */
function fiveChildren(): readonly ToolChild[] {
  return [1, 2, 3, 4, 5].map((n) => child(`c${n}`, "Read", { path: `f${n}.ts` }));
}

const TITLE_CASES: Array<[string, string]> = [
  ["nax-skills__load", "Skill"],
  ["Read", "Read"],
  ["Bash", "Bash"],
];

const PATH_TOOLS: Array<[string, string]> = [
  ["Read", "src/a.ts"],
  ["Write", "src/a.ts"],
  ["Edit", "src/a.ts"],
  ["Delete", "src/a.ts"],
];

describe("toolTitle", () => {
  test("names the nax-agents run tool Agent", () => {
    expect(toolTitle("nax-agents__run")).toBe("Agent");
  });

  test.each(TITLE_CASES)("maps %s to %s", (name, expected) => {
    expect(toolTitle(name)).toBe(expected);
  });
});

describe("toolCardModel identity", () => {
  test("carries the title and the call's path for a running Read", () => {
    const model = card({ name: "Read", input: { path: "src/a.ts" } });
    expect(model.title).toBe("Read");
    expect(model.arg).toBe("src/a.ts");
  });

  test("is running with an empty summary while the call is in flight", () => {
    const model = card({ name: "Read", input: { path: "src/a.ts" } });
    expect(model.tone).toBe("running");
    expect(model.summary).toEqual([]);
  });
});

describe("toolCardModel arg", () => {
  test.each(PATH_TOOLS)("uses the path of a %s call", (name, path) => {
    expect(card({ name, input: { path } }).arg).toBe(path);
  });

  test("uses the first line of a Bash command", () => {
    expect(card({ name: "Bash", input: { command: "bun test\nexit" } }).arg).toBe("bun test");
  });

  test("keeps a single-line Bash command whole", () => {
    expect(card({ name: "Bash", input: { command: "bun run typecheck" } }).arg).toBe("bun run typecheck");
  });

  test("quotes a Grep pattern and appends the path when there is one", () => {
    expect(card({ name: "Grep", input: { pattern: "foo", path: "src" } }).arg).toBe('"foo", src');
  });

  test("quotes a Grep pattern that has no path", () => {
    expect(card({ name: "Grep", input: { pattern: "foo" } }).arg).toBe('"foo"');
  });

  test("uses a Glob's pattern", () => {
    expect(card({ name: "Glob", input: { pattern: "src/**/*.ts" } }).arg).toBe("src/**/*.ts");
  });

  test("uses a Git call's subcommand", () => {
    expect(card({ name: "Git", input: { subcommand: "log" } }).arg).toBe("log");
  });

  test("joins an agent call's agent and task", () => {
    const model = card({ name: "nax-agents__run", input: { agent: "explorer", task: "find x" } });
    expect(model.title).toBe("Agent");
    expect(model.arg).toBe("explorer: find x");
  });

  test("uses a skill call's name", () => {
    const model = card({ name: "nax-skills__load", input: { name: "review" } });
    expect(model.title).toBe("Skill");
    expect(model.arg).toBe("review");
  });

  test("truncates a value longer than the limit with the theme-independent ellipsis", () => {
    const path = `src/${"x".repeat(66)}`;
    expect(path).toHaveLength(70);
    expect(card({ name: "Read", input: { path } }).arg).toBe(`${path.slice(0, TOOL_ARG_LIMIT)}…`);
  });

  test("keeps a value of exactly the limit whole", () => {
    const path = "y".repeat(TOOL_ARG_LIMIT);
    expect(card({ name: "Read", input: { path } }).arg).toBe(path);
  });

  test("turns line breaks in a value into spaces", () => {
    expect(card({ name: "Read", input: { path: "src/a\nb.ts" } }).arg).toBe("src/a b.ts");
    expect(card({ name: "Read", input: { path: "src/a\r\nb.ts" } }).arg).toBe("src/a b.ts");
  });

  test("has no arg for a tool it does not know", () => {
    expect(card({ name: "acme__get", input: { path: "src/a.ts" } }).arg).toBeUndefined();
  });

  test("has no arg when the field it needs is not a string", () => {
    expect(card({ name: "Read", input: { path: 3 } }).arg).toBeUndefined();
    expect(card({ name: "Grep", input: { path: "src" } }).arg).toBeUndefined();
    expect(card({ name: "nax-agents__run", input: { agent: "explorer" } }).arg).toBeUndefined();
  });

  test("has no arg when the call carries no input at all", () => {
    expect(card({ name: "Read", input: null }).arg).toBeUndefined();
  });
});

describe("toolCardModel tone", () => {
  test("is success for an ok call", () => {
    expect(card({ status: "ok", preview: "done" }).tone).toBe("success");
  });

  test("is danger for an error call", () => {
    expect(card({ status: "error", preview: "boom" }).tone).toBe("danger");
  });
});

describe("toolCardModel error summary", () => {
  test("shows the first non-empty preview line", () => {
    const model = card({ status: "error", preview: "\n  boom\nmore" });
    expect(model.summary).toEqual([{ text: "boom", tone: "danger" }]);
  });

  test("says failed when the error carries no preview", () => {
    expect(card({ status: "error" }).summary).toEqual([{ text: "failed", tone: "danger" }]);
  });

  test("says failed when the preview is blank", () => {
    expect(card({ status: "error", preview: "\n   \n" }).summary).toEqual([{ text: "failed", tone: "danger" }]);
  });
});

describe("toolCardModel running agent summary", () => {
  test("counts the children it withholds and shows the last three", () => {
    const full = card({
      name: "nax-agents__run",
      input: { agent: "reviewer", task: "scan" },
      children: fiveChildren(),
    });
    expect(full.summary).toHaveLength(CHILD_PREVIEW_LINES + 1);
    expect(full.summary[0].text).toBe("+2 more tool uses");
    expect(full.summary.slice(1).every((line) => line.text.startsWith("Read("))).toBe(true);
  });

  test("lists the children by title and arg", () => {
    const model = card({
      name: "nax-agents__run",
      input: { agent: "reviewer", task: "scan" },
      children: fiveChildren(),
    });
    expect(model.summary.map((line) => line.text)).toEqual([
      "+2 more tool uses",
      "Read(f3.ts)",
      "Read(f4.ts)",
      "Read(f5.ts)",
    ]);
  });

  test("shows every child with no more-line when they fit", () => {
    const children = [child("c1", "Read", { path: "a.ts" }), child("c2", "Bash", { command: "ls\now" })];
    const model = card({ name: "nax-agents__run", input: { agent: "reviewer", task: "scan" }, children });
    expect(model.summary.map((line) => line.text)).toEqual(["Read(a.ts)", "Bash(ls)"]);
  });

  test("titles a child that has no arg with its name alone", () => {
    const model = card({
      name: "nax-agents__run",
      input: { agent: "reviewer", task: "scan" },
      children: [child("c1", "acme__ping", {})],
    });
    expect(model.summary.map((line) => line.text)).toEqual(["acme__ping"]);
  });

  test("tones every summary line muted", () => {
    const model = card({
      name: "nax-agents__run",
      input: { agent: "reviewer", task: "scan" },
      children: fiveChildren(),
    });
    const tones: Array<CardLine["tone"]> = model.summary.map((line) => line.tone);
    expect(tones).toHaveLength(CHILD_PREVIEW_LINES + 1);
    expect(tones.every((tone) => tone === "muted")).toBe(true);
  });
});
