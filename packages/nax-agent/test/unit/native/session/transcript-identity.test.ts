import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { historyFromTranscript, transcriptDocFor } from "#src/native/session/transcript-identity";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import { assertNaxError } from "#test/helpers/index";

const msgs: ConversationMessage[] = [{ role: "user", content: "hello" }];
const doc = (fields: Partial<TranscriptDoc> = {}): TranscriptDoc => ({ savedAt: "t", messages: msgs, ...fields });

describe("historyFromTranscript", () => {
  test("no document is a new conversation", () => {
    expect(historyFromTranscript(null, { owner: "o" }, "s")).toEqual([]);
  });

  test("an owner mismatch reads as empty history", () => {
    expect(historyFromTranscript(doc({ owner: "a" }), { owner: "b" }, "s")).toEqual([]);
  });

  test("an owned reader drops an owner-less document (the legacy rule)", () => {
    expect(historyFromTranscript(doc(), { owner: "b" }, "s")).toEqual([]);
  });

  test("an owner-less reader reads an owned document", () => {
    expect(historyFromTranscript(doc({ owner: "a" }), {}, "s")).toEqual(msgs);
  });

  test("a recorded different model reads as empty history", () => {
    expect(historyFromTranscript(doc({ model: "p/m1" }), { model: "p/m2" }, "s")).toEqual([]);
  });

  test("a document with no recorded model reads for any model", () => {
    expect(historyFromTranscript(doc(), { model: "p/m2" }, "s")).toEqual(msgs);
  });

  test("schemaVersion 1 and an absent schemaVersion both read", () => {
    expect(historyFromTranscript(doc({ schemaVersion: 1 }), {}, "s")).toEqual(msgs);
    expect(historyFromTranscript(doc(), {}, "s")).toEqual(msgs);
  });

  test("an unknown schemaVersion fails loudly rather than starting over", () => {
    const future: TranscriptDoc = JSON.parse('{"schemaVersion":2,"savedAt":"t","messages":[]}');
    let caught: unknown;
    try {
      historyFromTranscript(future, {}, "s");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("TRANSCRIPT_SCHEMA_UNSUPPORTED");
  });

  test("the turn marker does not affect history", () => {
    expect(historyFromTranscript(doc({ turn: { turnId: "t1", state: "running" } }), {}, "s")).toEqual(msgs);
  });
});

describe("transcriptDocFor", () => {
  test("writes owner, model, savedAt, messages in that order and copies the array", () => {
    const out = transcriptDocFor(msgs, { owner: "o", model: "p/m" });
    expect(Object.keys(out)).toEqual(["owner", "model", "savedAt", "messages"]);
    expect(out.messages).toEqual(msgs);
    expect(out.messages).not.toBe(msgs);
  });

  test("omits undefined identity fields and never writes schemaVersion or turn", () => {
    expect(Object.keys(transcriptDocFor(msgs, {}))).toEqual(["savedAt", "messages"]);
  });
});
