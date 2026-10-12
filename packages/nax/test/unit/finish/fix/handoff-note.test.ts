import { describe, expect, test } from "bun:test";
import { HANDOFF_MARKER, isHandoffNote, parseHandoffReply } from "@/finish/fix";

describe("handoff reply parsing (finish A)", () => {
  test("a non-handoff reply is null", () => {
    expect(parseHandoffReply("## DISPOSITIONS\n1. fixed")).toBeNull();
  });
  test("a marked reply with JSON yields interrupted + the note", () => {
    const out = parseHandoffReply(
      `${HANDOFF_MARKER}\nsure: {"findings":[{"index":1,"status":"partial","files":["a.ts"],"remaining":"tests"}]}`,
    );
    expect(out).toEqual({
      interrupted: true,
      handoffNote: { findings: [{ index: 1, status: "partial", files: ["a.ts"], remaining: "tests" }] },
    });
  });
  test("a marked reply without usable JSON is still interrupted, without a note", () => {
    expect(parseHandoffReply(`${HANDOFF_MARKER}\n`)).toEqual({ interrupted: true });
    expect(parseHandoffReply(`${HANDOFF_MARKER}\nno json here`)).toEqual({ interrupted: true });
  });
  test("isHandoffNote rejects a wrong status", () => {
    expect(isHandoffNote({ findings: [{ index: 1, status: "maybe", files: [], remaining: "" }] })).toBe(false);
  });
});
