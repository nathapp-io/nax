import { describe, expect, test } from "bun:test";
import {
  type CardLine,
  CHILD_PREVIEW_LINES,
  DIFF_PREVIEW_LINES,
  diffLines,
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

/** An entry whose call has finished: the only status that carries a result summary. */
function okCard(overrides: Partial<ToolEntry> = {}, expanded = false): ToolCardModel {
  return toolCardModel(toolEntry({ status: "ok", ...overrides }), { expanded });
}

/** Five result lines: a collapsed card keeps the first `BASH_PREVIEW_LINES` of them. */
const FIVE_LINES = "l1\nl2\nl3\nl4\nl5";

/** `AT` plus 38 seconds, so an agent's duration is a whole number of seconds. */
const AT_PLUS_38S = "2026-10-01T00:00:38.000Z";

/** Ten removed and ten added lines: no common prefix or suffix, so a 20-line diff. */
const TEN_OLD_LINES = Array.from({ length: 10 }, (_, n) => `old${n}`).join("\n");
const TEN_NEW_LINES = Array.from({ length: 10 }, (_, n) => `new${n}`).join("\n");

/** `bytes` ASCII characters spread over `lines` lines, so the preview cap is reached exactly. */
function previewOfSize(bytes: number, lines: number): string {
  const chars = bytes - (lines - 1);
  const perLine = Math.floor(chars / lines);
  const rows = Array.from({ length: lines - 1 }, () => "x".repeat(perLine));
  rows.push("x".repeat(chars - perLine * (lines - 1)));
  return rows.join("\n");
}

/** One agent run's two finished children, in the order the card lists them. */
function twoChildren(): readonly ToolChild[] {
  return [child("c1", "Read", { path: "a.ts" }), child("c2", "Bash", { command: "ls" })];
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

/** Names every plain object already has: a lookup must not answer for these. */
const INHERITED_NAMES: Array<[string, string]> = [
  ["constructor", "constructor"],
  ["toString", "toString"],
  ["__proto__", "__proto__"],
  ["hasOwnProperty", "hasOwnProperty"],
];

describe("toolTitle", () => {
  test("names the nax-agents run tool Agent", () => {
    expect(toolTitle("nax-agents__run")).toBe("Agent");
  });

  test.each(TITLE_CASES)("maps %s to %s", (name, expected) => {
    expect(toolTitle(name)).toBe(expected);
  });

  test.each(INHERITED_NAMES)("leaves the inherited object name %s unchanged", (name, expected) => {
    expect(toolTitle(name)).toBe(expected);
  });
});

describe("toolCardModel identity", () => {
  test("carries the title and the call's path for a running Read", () => {
    const model = card({ name: "Read", input: { path: "src/a.ts" } });
    expect(model.title).toBe("Read");
    expect(model.arg).toBe("src/a.ts");
  });

  test.each(INHERITED_NAMES)("keeps the inherited object name %s as its title", (name, expected) => {
    expect(card({ name }).title).toBe(expected);
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

describe("diffLines", () => {
  test("keeps the common first and last lines as context around the change", () => {
    expect(diffLines("a\nb\nz", "a\nc\nz")).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "c" },
      { sign: " ", text: "z" },
    ]);
  });

  test("adds a line the old text does not have", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { sign: " ", text: "a" },
      { sign: "+", text: "b" },
    ]);
  });

  test("takes the common suffix only from what the common prefix left", () => {
    expect(diffLines("a\na", "a")).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "a" },
    ]);
  });

  test("returns no lines for two empty texts", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  test("does not treat a trailing newline as an empty line", () => {
    expect(diffLines("a\n", "a\n")).toEqual([{ sign: " ", text: "a" }]);
  });
});

describe("toolCardModel ok summary", () => {
  test("counts an Edit's new and replaced lines against the path", () => {
    const input = { path: "x.ts", old_string: "a\nb", new_string: "a\nc\nd" };
    expect(okCard({ name: "Edit", input }).summary.map((line) => line.text)).toEqual(["Updated x.ts (+3 -2)"]);
  });

  test("carries the Edit diff of the replaced text", () => {
    const input = { path: "x.ts", old_string: "a\nb", new_string: "a\nc\nd" };
    const model = okCard({ name: "Edit", input });
    expect(model.diff).toEqual(diffLines("a\nb", "a\nc\nd"));
    expect(model.diff.length).toBeGreaterThan(0);
  });

  test("tones an ok summary muted", () => {
    const input = { path: "x.ts", old_string: "a", new_string: "b" };
    expect(okCard({ name: "Edit", input }).summary.map((line) => line.tone)).toEqual(["muted"]);
  });

  test("counts a Write's content lines without the trailing newline", () => {
    const model = okCard({ name: "Write", input: { path: "y.ts", content: "1\n2\n3\n" } });
    expect(model.summary.map((line) => line.text)).toEqual(["Wrote 3 lines to y.ts"]);
  });

  test("shows no diff for a Write", () => {
    expect(okCard({ name: "Write", input: { path: "y.ts", content: "1\n2\n3\n" } }).diff).toEqual([]);
  });

  test("counts a Read's preview lines", () => {
    const model = okCard({ name: "Read", input: { path: "a.ts" }, preview: "a\nb" });
    expect(model.summary.map((line) => line.text)).toEqual(["Read 2 lines"]);
  });

  test("marks a Read whose preview reached the byte cap", () => {
    const preview = previewOfSize(4096, 50);
    expect(preview).toHaveLength(4096);
    const model = okCard({ name: "Read", input: { path: "a.ts" }, preview });
    expect(model.summary.map((line) => line.text)).toEqual(["Read 50+ lines"]);
  });

  test("does not mark a Read whose preview stayed under the byte cap", () => {
    const preview = previewOfSize(4095, 50);
    const model = okCard({ name: "Read", input: { path: "a.ts" }, preview });
    expect(model.summary.map((line) => line.text)).toEqual(["Read 50 lines"]);
  });

  test("shows the first three lines of a Bash result while collapsed", () => {
    const model = okCard({ name: "Bash", input: { command: "ls" }, preview: FIVE_LINES });
    expect(model.summary).toEqual([
      { text: "l1", tone: "plain" },
      { text: "l2", tone: "plain" },
      { text: "l3", tone: "plain" },
    ]);
  });

  test("counts the Bash lines the collapse withholds", () => {
    expect(okCard({ name: "Bash", input: { command: "ls" }, preview: FIVE_LINES }).hiddenLines).toBe(2);
  });

  test("shows every Bash line when expanded", () => {
    const model = okCard({ name: "Bash", input: { command: "ls" }, preview: FIVE_LINES }, true);
    expect(model.summary.map((line) => line.text)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    expect(model.hiddenLines).toBe(0);
  });

  test("says Done for a Bash result with no output", () => {
    expect(okCard({ name: "Bash", input: { command: "true" }, preview: "" }).summary).toEqual([
      { text: "Done", tone: "muted" },
    ]);
  });

  test("summarises a finished agent run with its tool count and duration", () => {
    const model = okCard({
      name: "nax-agents__run",
      input: { agent: "explorer", task: "find x" },
      children: twoChildren(),
      startedAt: AT,
      endedAt: AT_PLUS_38S,
    });
    expect(model.summary.map((line) => line.text)).toEqual(["Done (2 tool uses · 38s)"]);
  });

  test("counts an unparseable duration as no time", () => {
    const model = okCard({
      name: "nax-agents__run",
      input: { agent: "explorer", task: "find x" },
      children: [],
      startedAt: "now",
      endedAt: "now",
    });
    expect(model.summary.map((line) => line.text)).toEqual(["Done (0 tool uses · 0s)"]);
  });

  test("lists every child under an expanded agent run", () => {
    const model = okCard(
      {
        name: "nax-agents__run",
        input: { agent: "explorer", task: "find x" },
        children: twoChildren(),
        startedAt: AT,
        endedAt: AT_PLUS_38S,
      },
      true,
    );
    expect(model.summary.map((line) => line.text)).toEqual(["Done (2 tool uses · 38s)", "Read(a.ts)", "Bash(ls)"]);
  });

  test("lists no child under a collapsed agent run", () => {
    const model = okCard({
      name: "nax-agents__run",
      input: { agent: "explorer", task: "find x" },
      children: twoChildren(),
      startedAt: AT,
      endedAt: AT_PLUS_38S,
    });
    expect(model.summary).toHaveLength(1);
    expect(model.hiddenLines).toBe(2);
  });

  test("shows the first non-empty preview line of any other tool", () => {
    const model = okCard({ name: "Glob", input: { pattern: "src/**/*.ts" }, preview: "3 files\na\nb" });
    expect(model.summary).toEqual([{ text: "3 files", tone: "muted" }]);
  });

  test("says Done for a tool whose preview is empty", () => {
    const model = okCard({ name: "Glob", input: { pattern: "src/**/*.ts" }, preview: "" });
    expect(model.summary).toEqual([{ text: "Done", tone: "muted" }]);
  });
});

describe("toolCardModel ok collapsing", () => {
  const wideEdit = { path: "z.ts", old_string: TEN_OLD_LINES, new_string: TEN_NEW_LINES };

  test("keeps twelve diff lines of a twenty-line Edit while collapsed", () => {
    expect(okCard({ name: "Edit", input: wideEdit }).diff).toHaveLength(DIFF_PREVIEW_LINES);
  });

  test("counts the diff lines the collapse withholds", () => {
    expect(okCard({ name: "Edit", input: wideEdit }).hiddenLines).toBe(8);
  });

  test("shows the whole diff when expanded", () => {
    const model = okCard({ name: "Edit", input: wideEdit }, true);
    expect(model.diff).toHaveLength(20);
    expect(model.hiddenLines).toBe(0);
  });

  test("withholds nothing when the whole diff fits", () => {
    const input = { path: "x.ts", old_string: "a\nb", new_string: "a\nc\nd" };
    expect(okCard({ name: "Edit", input }).hiddenLines).toBe(0);
  });

  test("has no diff while the Edit is still running", () => {
    const model = card({ name: "Edit", input: { path: "z.ts", old_string: "a", new_string: "b" } });
    expect(model.diff).toEqual([]);
    expect(model.hiddenLines).toBe(0);
  });
});
