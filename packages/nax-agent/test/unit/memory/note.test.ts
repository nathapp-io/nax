import { describe, expect, test } from "bun:test";
import {
  isMemoryPushRejected,
  MEMORY_CLIENT_ID_RE,
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_MIN_BYTES,
  MEMORY_INDEX_MIN_LINES,
  MEMORY_NOTE_BODY_MAX_BYTES,
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PROBE_TIMEOUT_MS,
  MEMORY_PULL_MAX_PAGES,
  MEMORY_PULL_PAGE_SIZE,
  MEMORY_SLUG_RE,
  MEMORY_SOURCE_MAX_CHARS,
  type MemoryNote,
  NaxError,
  parseMemoryNote,
  serializeMemoryNote,
} from "@nathapp/nax-agent";
import { parseMemoryNoteRecord } from "#src/memory/index";

/** The example note from the memory-store design (spec § Note model). */
const EXAMPLE = `---
id: mem_01J9X2
slug: replay-budget
type: project
scope: project
description: replay budget stays 2,048 MiB
source: nax-chat
updatedAt: 2026-11-02T08:11:00.000Z
status: active
---

The replay budget stays at 2,048 MiB. Next export append is due ~11-23.`;

const BODY = "The replay budget stays at 2,048 MiB. Next export append is due ~11-23.";

const FIELDS: Record<string, string> = {
  id: "mem_01J9X2",
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "replay budget stays 2,048 MiB",
  source: "nax-chat",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
};

/** Frontmatter of the example with overrides; a `null` value drops the key. */
function noteText(overrides: Record<string, string | null> = {}, body = BODY): string {
  const lines = Object.entries({ ...FIELDS, ...overrides })
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  const head = `---\n${lines.join("\n")}\n---\n`;
  return body === "" ? head : `${head}\n${body}`;
}

describe("parseMemoryNote", () => {
  test("reads the example note's slug and its single body line", () => {
    const note: MemoryNote = parseMemoryNote(EXAMPLE);
    expect(note.slug).toBe("replay-budget");
    expect(note.body).toBe(BODY);
  });

  test("reads the example note's type, scope and status", () => {
    const note = parseMemoryNote(EXAMPLE);
    expect(note.type).toBe("project");
    expect(note.scope).toBe("project");
    expect(note.status).toBe("active");
  });

  test("keeps a description that contains ': ' and ignores an unknown key", () => {
    const note = parseMemoryNote(noteText({ description: "ratio: 2:1", extra: "x" }));
    expect(note.description).toBe("ratio: 2:1");
    expect(Object.hasOwn(note, "extra")).toBe(false);
  });
});

describe("parseMemoryNote rejections", () => {
  function parseError(text: string): unknown {
    try {
      parseMemoryNote(text);
      return null;
    } catch (error) {
      return error;
    }
  }

  function expectInvalidNote(text: string): string {
    const error = parseError(text);
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "MEMORY_NOTE_INVALID", context: { stage: "memory" } });
    return error instanceof NaxError ? error.message : "";
  }

  test("text with no leading --- line", () => {
    expect(parseMemoryNote(EXAMPLE).slug).toBe("replay-budget");
    expect(expectInvalidNote(BODY)).toContain("---");
    expect(expectInvalidNote(EXAMPLE.split("\n").slice(1).join("\n"))).toContain("---");
  });

  test("frontmatter missing slug names slug in the message", () => {
    expect(parseMemoryNote(noteText()).slug).toBe("replay-budget");
    expect(expectInvalidNote(noteText({ slug: null }))).toContain("slug");
  });

  test("frontmatter whose type is not one of the four", () => {
    expect(parseMemoryNote(noteText({ type: "project" })).type).toBe("project");
    expectInvalidNote(noteText({ type: "note" }));
  });

  test("frontmatter whose status is not one of the five", () => {
    expect(parseMemoryNote(noteText({ status: "active" })).status).toBe("active");
    expectInvalidNote(noteText({ status: "archived" }));
  });

  test("frontmatter whose slug is not a slug", () => {
    expect(parseMemoryNote(noteText({ slug: "replay-budget" })).slug).toBe("replay-budget");
    expectInvalidNote(noteText({ slug: "Bad_Slug" }));
  });

  test("[M1] a body that starts on the fence's next line, with no blank separator, is refused", () => {
    // `noteText` puts the blank separator in; this is the malformed spelling that omits it.
    const head = noteText({}, "");
    expect(parseMemoryNote(head).body).toBe("");
    expect(parseMemoryNote(`${head}\n${BODY}`).body).toBe(BODY);
    expect(expectInvalidNote(`${head}${BODY}`)).toContain("blank line");
  });
});

describe("serializeMemoryNote", () => {
  test("round-trips the example note through parse and back", () => {
    const note = parseMemoryNote(EXAMPLE);
    expect(parseMemoryNote(serializeMemoryNote(note))).toEqual(note);
  });

  test("writes the frontmatter keys in order, then ---, then one blank line, then the body", () => {
    const text = serializeMemoryNote(parseMemoryNote(EXAMPLE));
    expect(text.split("\n")).toEqual([
      "---",
      "id: mem_01J9X2",
      "slug: replay-budget",
      "type: project",
      "scope: project",
      "description: replay budget stays 2,048 MiB",
      "source: nax-chat",
      "updatedAt: 2026-11-02T08:11:00.000Z",
      "status: active",
      "---",
      "",
      BODY,
    ]);
  });

  test("parses an empty body and serializes it as a closing --- and a single line break", () => {
    const note = parseMemoryNote(noteText({}, ""));
    expect(note.body).toBe("");
    const text = serializeMemoryNote(note);
    expect(text.endsWith("---\n")).toBe(true);
    expect(text.endsWith("---\n\n")).toBe(false);
    expect(parseMemoryNote(text)).toEqual(note);
  });
});

describe("isMemoryPushRejected", () => {
  test("recognises a permanent push rejection", () => {
    expect(isMemoryPushRejected(new NaxError("slug is reserved", "MEMORY_PUSH_REJECTED"))).toBe(true);
  });

  test("does not treat another memory error or a plain Error as permanent", () => {
    expect(isMemoryPushRejected(new NaxError("bad note", "MEMORY_NOTE_INVALID"))).toBe(false);
    expect(isMemoryPushRejected(new Error("socket hang up"))).toBe(false);
    expect(isMemoryPushRejected("MEMORY_PUSH_REJECTED")).toBe(false);
    expect(isMemoryPushRejected(undefined)).toBe(false);
  });
});

describe("the package entry's memory surface", () => {
  test("exposes the codec and every MEMORY_* constant", () => {
    expect(parseMemoryNote).toBeFunction();
    expect(serializeMemoryNote).toBeFunction();
    expect(isMemoryPushRejected).toBeFunction();
    expect(MEMORY_SLUG_RE.test("replay-budget")).toBe(true);
    expect(MEMORY_SLUG_RE.test("Bad_Slug")).toBe(false);
    expect(MEMORY_CLIENT_ID_RE.test("01J9X2-abc_def")).toBe(true);
    expect({
      MEMORY_DESCRIPTION_MAX_CHARS,
      MEMORY_INDEX_MAX_BYTES,
      MEMORY_INDEX_MAX_LINES,
      MEMORY_INDEX_MIN_BYTES,
      MEMORY_INDEX_MIN_LINES,
      MEMORY_NOTE_BODY_MAX_BYTES,
      MEMORY_OP_TIMEOUT_MS,
      MEMORY_PROBE_TIMEOUT_MS,
      MEMORY_PULL_MAX_PAGES,
      MEMORY_PULL_PAGE_SIZE,
      MEMORY_SOURCE_MAX_CHARS,
    }).toEqual({
      MEMORY_DESCRIPTION_MAX_CHARS: 200,
      MEMORY_INDEX_MAX_BYTES: 24_576,
      MEMORY_INDEX_MAX_LINES: 200,
      MEMORY_INDEX_MIN_BYTES: 512,
      MEMORY_INDEX_MIN_LINES: 16,
      MEMORY_NOTE_BODY_MAX_BYTES: 8192,
      MEMORY_OP_TIMEOUT_MS: 10_000,
      MEMORY_PROBE_TIMEOUT_MS: 2000,
      MEMORY_PULL_MAX_PAGES: 50,
      MEMORY_PULL_PAGE_SIZE: 200,
      MEMORY_SOURCE_MAX_CHARS: 64,
    });
  });
});

describe("parseMemoryNoteRecord", () => {
  // The shared shape validation a provider pull reuses (spec § Note model): a
  // decoded note is rejected exactly where a note file would be.
  test("accepts a decoded note and rejects a field carrying a line break", () => {
    expect(parseMemoryNoteRecord({ ...FIELDS, body: "" }).slug).toBe("replay-budget");
    const error = parseErrorRecord({ ...FIELDS, description: "two\nlines", body: "" });
    expect(error).toMatchObject({ code: "MEMORY_NOTE_INVALID", context: { stage: "memory", key: "description" } });
    expect(error instanceof NaxError ? error.message : "").toContain("description");
  });

  test("accepts every capped field exactly at its model limit", () => {
    const note = parseMemoryNoteRecord({
      ...FIELDS,
      description: "d".repeat(MEMORY_DESCRIPTION_MAX_CHARS),
      source: "s".repeat(MEMORY_SOURCE_MAX_CHARS),
      body: "b".repeat(MEMORY_NOTE_BODY_MAX_BYTES),
    });
    expect(note.description).toHaveLength(MEMORY_DESCRIPTION_MAX_CHARS);
    expect(note.source).toHaveLength(MEMORY_SOURCE_MAX_CHARS);
    expect(note.body).toHaveLength(MEMORY_NOTE_BODY_MAX_BYTES);
  });

  test.each([
    ["description", { description: "d".repeat(MEMORY_DESCRIPTION_MAX_CHARS + 1) }],
    ["source", { source: "s".repeat(MEMORY_SOURCE_MAX_CHARS + 1) }],
    ["body", { body: "b".repeat(MEMORY_NOTE_BODY_MAX_BYTES + 1) }],
  ] as const)("rejects a %s one over its model limit", (key, over) => {
    expect(parseErrorRecord({ ...FIELDS, body: "", ...over })).toMatchObject({
      code: "MEMORY_NOTE_INVALID",
      context: { stage: "memory", key },
    });
  });

  test("counts the body cap in UTF-8 bytes, so a multi-byte body can fail below the character count", () => {
    const atCap = { ...FIELDS, body: "é".repeat(MEMORY_NOTE_BODY_MAX_BYTES / 2) };
    expect(parseMemoryNoteRecord(atCap).body).toHaveLength(MEMORY_NOTE_BODY_MAX_BYTES / 2);
    // Half as many characters again is only one character over — but two bytes over the cap.
    const overCap = { ...FIELDS, body: "é".repeat(MEMORY_NOTE_BODY_MAX_BYTES / 2 + 1) };
    expect(parseErrorRecord(overCap)).toMatchObject({ code: "MEMORY_NOTE_INVALID", context: { key: "body" } });
  });

  function parseErrorRecord(record: Record<string, unknown>): unknown {
    try {
      parseMemoryNoteRecord(record);
      return null;
    } catch (error) {
      return error;
    }
  }
});
