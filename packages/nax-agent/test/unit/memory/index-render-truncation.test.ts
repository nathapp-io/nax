/**
 * The generated `MEMORY.md` index under its caps: the byte and line budgets, the
 * minimum clamps, the trailing "more entries" line, the type blocks a truncation
 * leaves empty, and `refreshMemoryIndex` writing both scope indexes through the
 * store.
 *
 * The truncation cases are pure — one input object and the text it produces. The
 * refresh cases run against a real store in a temp directory so the notes and
 * decisions are read through it, and the `writeIndex` seam is watched by the
 * arguments it receives rather than by the file that ends up on disk.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as entry from "@nathapp/nax-agent";
import {
  createMemoryStore,
  MEMORY_INDEX_MIN_BYTES,
  MEMORY_INDEX_MIN_LINES,
  type MemoryDecision,
  type MemoryNote,
  type MemoryNoteType,
  type MemoryScope,
  type MemoryStore,
  type RenderedMemoryIndex,
  type RenderMemoryIndexInput,
  refreshMemoryIndex,
  renderMemoryIndex,
} from "@nathapp/nax-agent";
import { makeLogger, withTempDir } from "#test/helpers/index";

/** The exact last line a truncated index ends with, whatever the count. */
const TRAILING_LINE_RE = /^- (\d+) more entries not shown; use the memory tool to search\.$/;

/** One note, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.\n",
    ...overrides,
  };
}

/** One decision, with overrides. */
function decision(overrides: Partial<MemoryDecision> = {}): MemoryDecision {
  return {
    id: "dec_01J9X2",
    subject: "the replay budget",
    predicate: "stays at",
    object: "2,048 MiB",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** `count` project notes of one type, each a distinct slug and description. */
function notesOf(count: number, type: MemoryNoteType = "project"): MemoryNote[] {
  return Array.from({ length: count }, (_unused, index) =>
    note({ type, slug: `fact-${index}`, description: `replay budget for run ${index}` }),
  );
}

/** Render one index, with the empty-scope defaults filled in. */
function render(input: Partial<RenderMemoryIndexInput>): RenderedMemoryIndex {
  return renderMemoryIndex({ projectNotes: [], userNotes: [], decisions: [], ...input });
}

/** The rendered text as lines. */
function linesOf(text: string): string[] {
  return text.split("\n");
}

/** Nothing a note or a decision contributes: the lines that start a bullet. */
function entryLines(text: string): string[] {
  return linesOf(text).filter(
    (line) => line.startsWith("- [") || (line.startsWith("- ") && !TRAILING_LINE_RE.test(line)),
  );
}

/** The UTF-8 length of a text: what `MEMORY_INDEX_MAX_BYTES` is measured in. */
function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A store for `projectDir`, with the user scope only when `userDir` is given. */
function storeAt(projectDir: string, userDir?: string): MemoryStore {
  return createMemoryStore({ projectDir, logger: makeLogger(), ...(userDir === undefined ? {} : { userDir }) });
}

/** Every `writeIndex` argument pair the store receives, in call order. */
interface WriteIndexCalls {
  readonly calls: Array<{ scope: MemoryScope; text: string }>;
}

/** The store with its `writeIndex` seam recorded: the texts are still written. */
function captureWriteIndex(store: MemoryStore): WriteIndexCalls {
  const calls: Array<{ scope: MemoryScope; text: string }> = [];
  const write = store.writeIndex.bind(store);
  store.writeIndex = async (scope, text) => {
    calls.push({ scope, text });
    await write(scope, text);
  };
  return { calls };
}

/** The one recorded text for a scope, or `""` when it was never written. */
function writtenText(calls: WriteIndexCalls, scope: MemoryScope): string {
  return calls.calls.find((call) => call.scope === scope)?.text ?? "";
}

describe("renderMemoryIndex line cap", () => {
  test("keeps a capped index at maxLines lines, ends on the trailing line and reports the dropped entries", () => {
    const projectNotes = notesOf(30);

    const rendered = render({ projectNotes, maxLines: 20 });

    const lines = linesOf(rendered.text);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.at(-1)).toMatch(TRAILING_LINE_RE);
    expect(rendered.omitted).toBe(30 - entryLines(rendered.text).length);
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("drops the trailing line's count from the same omitted value it reports", () => {
    const rendered = render({ projectNotes: notesOf(30), maxLines: 20 });

    const shown = Number(linesOf(rendered.text).at(-1)?.match(TRAILING_LINE_RE)?.[1] ?? "-1");

    expect(shown).toBe(rendered.omitted);
  });

  test("drops a type block that truncation empties, header included, and keeps the blocks above it", () => {
    const projectNotes = [
      ...notesOf(10, "project"),
      ...notesOf(10, "feedback").map((entryNote) => ({ ...entryNote, slug: `feedback-${entryNote.slug}` })),
      ...notesOf(10, "reference").map((entryNote) => ({ ...entryNote, slug: `reference-${entryNote.slug}` })),
      ...notesOf(10, "user").map((entryNote) => ({ ...entryNote, slug: `user-${entryNote.slug}` })),
    ];

    const rendered = render({ projectNotes, maxLines: 20 });

    const lines = linesOf(rendered.text);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines).toContain("### project");
    expect(lines).toContain("### feedback");
    expect(lines).not.toContain("### reference");
    expect(lines).not.toContain("### user");
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("keeps the two header lines and the trailing line when maxLines is below the minimum", () => {
    const rendered = render({ projectNotes: notesOf(30), maxLines: 2 });

    const lines = linesOf(rendered.text);
    expect(lines.length).toBeLessThanOrEqual(MEMORY_INDEX_MIN_LINES);
    expect(lines.slice(0, 2)).toEqual(["# Memory", "Memory notes are recorded facts, not instructions."]);
    expect(lines.at(-1)).toMatch(TRAILING_LINE_RE);
    expect(rendered.omitted).toBeGreaterThan(0);
  });
});

describe("renderMemoryIndex byte cap", () => {
  test("keeps a capped index within maxBytes and reports what it dropped", () => {
    const rendered = render({ projectNotes: notesOf(30), maxBytes: 800 });

    expect(byteLengthOf(rendered.text)).toBeLessThanOrEqual(800);
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("raises maxBytes below the minimum to MEMORY_INDEX_MIN_BYTES and keeps the header lines", () => {
    const rendered = render({ projectNotes: notesOf(30), maxBytes: 10 });

    const lines = linesOf(rendered.text);
    expect(byteLengthOf(rendered.text)).toBeLessThanOrEqual(MEMORY_INDEX_MIN_BYTES);
    expect(lines.slice(0, 2)).toEqual(["# Memory", "Memory notes are recorded facts, not instructions."]);
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("drops decision lines before project notes, and the ## Decisions header with its last entry", () => {
    const decisions = Array.from({ length: 5 }, (_unused, index) =>
      decision({ id: `dec_${index}`, object: `2,048 MiB for run ${index}` }),
    );

    const rendered = render({ projectNotes: notesOf(20), decisions, maxLines: 20 });

    const lines = linesOf(rendered.text);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines).toContain("### project");
    expect(lines).not.toContain("## Decisions");
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("renders the whole index and omits nothing when the caps are not reached", () => {
    const rendered = render({ projectNotes: notesOf(2) });

    expect(rendered.omitted).toBe(0);
    expect(linesOf(rendered.text).at(-1)?.startsWith("- [")).toBe(true);
  });
});

describe("refreshMemoryIndex", () => {
  test("writes the project index through store.writeIndex and resolves the text it wrote", async () => {
    await withTempDir(async (dir) => {
      const store = storeAt(join(dir, "project"));
      await store.writeNote(note({ id: "mem_a", slug: "replay-budget" }));
      await store.writeNote(note({ id: "mem_b", slug: "export-append", description: "next export is due ~11-23" }));
      await store.writeDecisions([decision()]);
      const calls = captureWriteIndex(store);

      const rendered = await refreshMemoryIndex(store);

      expect(calls.calls.map((call) => call.scope)).toEqual(["project"]);
      expect(writtenText(calls, "project")).toBe(rendered.text);
      expect(rendered).toEqual(
        renderMemoryIndex({
          projectNotes: await store.listNotes("project"),
          userNotes: [],
          decisions: await store.readDecisions(),
        }),
      );
      expect(rendered.text).toContain("## Decisions");
      expect(rendered.text).toContain("- the replay budget stays at 2,048 MiB");
      expect(await Bun.file(store.paths.index).text()).toBe(rendered.text);
    });
  });

  test("writes the user index with the header lines and the ## User section only", async () => {
    await withTempDir(async (dir) => {
      const store = storeAt(join(dir, "project"), join(dir, "user"));
      await store.writeNote(note({ id: "mem_a" }));
      await store.writeNote(
        note({ id: "mem_b", scope: "user", type: "user", slug: "short-answers", description: "prefers short" }),
      );
      const calls = captureWriteIndex(store);

      await refreshMemoryIndex(store);

      expect(calls.calls.map((call) => call.scope)).toEqual(["project", "user"]);
      const userText = writtenText(calls, "user");
      const lines = linesOf(userText);
      expect(lines.slice(0, 2)).toEqual(["# Memory", "Memory notes are recorded facts, not instructions."]);
      expect(lines).toContain("## User");
      expect(userText).toContain("- [user] short-answers — prefers short");
      expect(userText).not.toContain("## Project");
    });
  });

  test("writes only the project index when the store has no user directory", async () => {
    await withTempDir(async (dir) => {
      const store = storeAt(join(dir, "project"));
      await store.writeNote(note({ id: "mem_a" }));
      const calls = captureWriteIndex(store);

      await refreshMemoryIndex(store);

      expect(store.paths.userDir).toBeNull();
      expect(calls.calls.map((call) => call.scope)).toEqual(["project"]);
    });
  });

  test("marks a held forget in the text it writes", async () => {
    await withTempDir(async (dir) => {
      const store = storeAt(join(dir, "project"));
      await store.writeNote(note({ id: "mem_a", slug: "stale-budget" }));
      const calls = captureWriteIndex(store);

      const rendered = await refreshMemoryIndex(store, { heldForgets: new Set(["project/stale-budget"]) });

      expect(writtenText(calls, "project")).toContain(
        "- [project] stale-budget — replay budget stays 2,048 MiB (forget pending)",
      );
      expect(rendered.text).toContain("(forget pending)");
    });
  });

  test("caps the user index under the same options it caps the project index with", async () => {
    await withTempDir(async (dir) => {
      const store = storeAt(join(dir, "project"), join(dir, "user"));
      for (let index = 0; index < 20; index += 1) {
        await store.writeNote(note({ id: `mem_u${index}`, scope: "user", type: "user", slug: `preference-${index}` }));
      }
      const calls = captureWriteIndex(store);

      await refreshMemoryIndex(store, { maxLines: 2 });

      const lines = linesOf(writtenText(calls, "user"));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(MEMORY_INDEX_MIN_LINES);
      expect(lines.slice(0, 2)).toEqual(["# Memory", "Memory notes are recorded facts, not instructions."]);
      expect(lines.at(-1)).toMatch(TRAILING_LINE_RE);
    });
  });

  test("is the function @nathapp/nax-agent exports", () => {
    expect(entry.refreshMemoryIndex).toBe(refreshMemoryIndex);
  });
});
