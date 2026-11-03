import { describe, expect, test } from "bun:test";
import {
  findSecret,
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_NOTE_BODY_MAX_BYTES,
  type MemoryNoteWrite,
  validateMemoryNoteWrite,
} from "@nathapp/nax-agent";
import { forgetReasonRefusal } from "#src/memory/index";

/** A write that every check accepts; each test overrides the field it exercises. */
const VALID: MemoryNoteWrite = {
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "one line",
  body: "text",
};

const SOURCE = "nax-chat";

/** `ghp_` plus 20 alphanumerics: a GitHub personal access token. */
const GITHUB_TOKEN = `ghp_${"a".repeat(20)}`;

describe("findSecret", () => {
  test("returns the kind of the first secret-shaped run it finds", () => {
    expect(findSecret(`x ${GITHUB_TOKEN} y`)).toEqual({ kind: "github" });
  });

  test("returns null for text that carries no secret", () => {
    expect(findSecret("plain text")).toBeNull();
  });

  test("does not return a match from a stale lastIndex on the second call", () => {
    expect(findSecret(`x ${GITHUB_TOKEN} y`)).toEqual({ kind: "github" });
    expect(findSecret(`x ${GITHUB_TOKEN} y`)).toEqual({ kind: "github" });
  });

  test("applies url-credentials acceptMatch: a credential-less URL is not a secret", () => {
    expect(findSecret("see https://example.com/docs")).toBeNull();
    expect(findSecret("postgres://alice:s3cret@db.example/app")).toEqual({ kind: "url-credentials" });
  });
});

describe("validateMemoryNoteWrite: accepted writes", () => {
  test("returns null for a well-formed write", () => {
    const refusal = validateMemoryNoteWrite(
      { slug: "replay-budget", type: "project", scope: "project", description: "one line", body: "text" },
      "nax-chat",
    );
    expect(refusal).toBeNull();
  });
});

describe("validateMemoryNoteWrite: slug", () => {
  test("refuses a slug with an upper-case letter or an underscore", () => {
    expect(validateMemoryNoteWrite({ ...VALID, slug: "Replay_Budget" }, SOURCE)).toMatchObject({ field: "slug" });
  });

  test("refuses a 65-character slug, and accepts the 64-character maximum", () => {
    expect(validateMemoryNoteWrite({ ...VALID, slug: "a".repeat(65) }, SOURCE)).toMatchObject({ field: "slug" });
    expect(validateMemoryNoteWrite({ ...VALID, slug: "a".repeat(64) }, SOURCE)).toBeNull();
  });
});

describe("validateMemoryNoteWrite: type", () => {
  test("refuses a type that is not one of the four", () => {
    expect(validateMemoryNoteWrite({ ...VALID, type: "note" }, SOURCE)).toMatchObject({ field: "type" });
  });
});

describe("validateMemoryNoteWrite: description", () => {
  test("refuses a description carrying a line break", () => {
    expect(validateMemoryNoteWrite({ ...VALID, description: "two\nlines" }, SOURCE)).toMatchObject({
      field: "description",
    });
  });

  test("refuses an empty description", () => {
    expect(validateMemoryNoteWrite({ ...VALID, description: "" }, SOURCE)).toMatchObject({ field: "description" });
  });

  test("refuses a description of MEMORY_DESCRIPTION_MAX_CHARS + 1 characters", () => {
    const description = "a".repeat(MEMORY_DESCRIPTION_MAX_CHARS + 1);
    expect(validateMemoryNoteWrite({ ...VALID, description }, SOURCE)).toMatchObject({ field: "description" });
  });
});

describe("validateMemoryNoteWrite: source", () => {
  test("refuses a source carrying a line break", () => {
    expect(validateMemoryNoteWrite(VALID, "nax-chat\nnax-run")).toMatchObject({ field: "source" });
  });

  test("refuses an empty source", () => {
    expect(validateMemoryNoteWrite(VALID, "")).toMatchObject({ field: "source" });
  });
});

describe("validateMemoryNoteWrite: body", () => {
  test("refuses a body of MEMORY_NOTE_BODY_MAX_BYTES + 1 bytes built from multi-byte characters", () => {
    // "é" is two UTF-8 bytes, so 4,096 of them plus one ASCII byte is 8,193
    // bytes in 4,097 characters: the byte count is what refuses it.
    const body = `${"é".repeat(4096)}a`;
    expect(Buffer.byteLength(body, "utf8")).toBe(MEMORY_NOTE_BODY_MAX_BYTES + 1);
    expect(body.length).toBeLessThan(MEMORY_NOTE_BODY_MAX_BYTES);
    expect(validateMemoryNoteWrite({ ...VALID, body }, SOURCE)).toMatchObject({ field: "body" });
  });

  test("accepts a body of exactly MEMORY_NOTE_BODY_MAX_BYTES", () => {
    expect(validateMemoryNoteWrite({ ...VALID, body: "a".repeat(MEMORY_NOTE_BODY_MAX_BYTES) }, SOURCE)).toBeNull();
  });
});

describe("validateMemoryNoteWrite: secrets", () => {
  test("refuses a body carrying a GitHub token, naming the kind and not the token", () => {
    const refusal = validateMemoryNoteWrite({ ...VALID, body: `see ${GITHUB_TOKEN} here` }, SOURCE);
    expect(refusal).toMatchObject({ field: "body" });
    expect(refusal?.reason).toContain("github");
    expect(refusal?.reason).not.toContain(GITHUB_TOKEN);
    expect(refusal?.reason).not.toContain("ghp_");
  });

  test("refuses a description carrying a KEY=value assignment", () => {
    const refusal = validateMemoryNoteWrite({ ...VALID, description: "the key is API_KEY=abc123" }, SOURCE);
    expect(refusal).toMatchObject({ field: "description" });
    expect(refusal?.reason).toContain("assignment");
  });

  test("refuses a body carrying URL credentials", () => {
    const refusal = validateMemoryNoteWrite({ ...VALID, body: "postgres://alice:s3cret@db.example/app" }, SOURCE);
    expect(refusal).toMatchObject({ field: "body" });
    expect(refusal?.reason).toContain("url-credentials");
  });

  test("accepts a body with a credential-less URL and the word token", () => {
    const body = "see https://example.com/docs and the word token";
    expect(validateMemoryNoteWrite({ ...VALID, body }, SOURCE)).toBeNull();
  });

  test("refuses the same token body twice in a row (no stale regex state between calls)", () => {
    const write = { ...VALID, body: `see ${GITHUB_TOKEN} here` };
    expect(validateMemoryNoteWrite(write, SOURCE)).toMatchObject({ field: "body" });
    expect(validateMemoryNoteWrite(write, SOURCE)).toMatchObject({ field: "body" });
  });
});

describe("the package entry's validation surface", () => {
  test("exports validateMemoryNoteWrite and findSecret", () => {
    expect(validateMemoryNoteWrite).toBeFunction();
    expect(findSecret).toBeFunction();
  });

  test("exports the forget reason's length cap", () => {
    expect(MEMORY_FORGET_REASON_MAX_CHARS).toBe(200);
  });
});

describe("forgetReasonRefusal", () => {
  test("accepts a reason of exactly MEMORY_FORGET_REASON_MAX_CHARS", () => {
    expect(forgetReasonRefusal("a".repeat(MEMORY_FORGET_REASON_MAX_CHARS))).toBeNull();
  });

  test("refuses a reason one character over the cap, naming the cap", () => {
    const refusal = forgetReasonRefusal("a".repeat(MEMORY_FORGET_REASON_MAX_CHARS + 1));
    expect(refusal).toMatchObject({ field: "reason" });
    expect(refusal?.reason).toBe(`reason must be at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters`);
  });

  test("refuses an empty reason", () => {
    expect(forgetReasonRefusal("")).toMatchObject({ field: "reason" });
  });

  test("refuses a reason carrying a line break", () => {
    expect(forgetReasonRefusal("stale\nand wrong")).toMatchObject({ field: "reason" });
  });

  test("accepts an ordinary justification", () => {
    expect(forgetReasonRefusal("the replay budget was retired in 0.92")).toBeNull();
  });
});
