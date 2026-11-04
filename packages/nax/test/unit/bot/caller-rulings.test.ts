import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";

const path = "/caller/rulings.json";
const head = "a".repeat(40);
const entry = {
  item: "D-1",
  key: "w-D-1.12345678",
  ruling: "confirm: read 4f2e1aa store.ts:88; test green",
  by: "orchestrator:alice",
  at: "2026-01-02T00:00:00Z",
};
const file = (rulings: unknown[] = [entry]) => ({ version: 1 as const, headSha: head, rulings });
let subject: typeof import("@/bot/caller-rulings");
let original: typeof subject._callerRulingsDeps | undefined;

function text(value: unknown): void {
  subject._callerRulingsDeps.readText = async () => JSON.stringify(value);
}
async function invalid(contains?: string): Promise<void> {
  const failure = subject.loadCallerRulings(path);
  await expect(failure).rejects.toBeInstanceOf(NaxError);
  await expect(subject.loadCallerRulings(path)).rejects.toMatchObject({
    code: "BOT_RULINGS_INVALID",
    message: expect.stringContaining(contains ?? `[bot] Invalid rulings file ${path}: `),
  });
}

describe("loadCallerRulings", () => {
  beforeEach(async () => {
    subject = await import("@/bot/caller-rulings");
    original = { ...subject._callerRulingsDeps };
    subject._callerRulingsDeps.fileSize = async () => 100;
    text(file());
  });
  afterEach(() => {
    if (original) Object.assign(subject._callerRulingsDeps, original);
    original = undefined;
  });

  test("returns the parsed file", async () => {
    expect(await subject.loadCallerRulings(path)).toEqual(file() as never);
  });
  test("key is optional and an empty list is accepted", async () => {
    const { key: _key, ...bare } = entry;
    text(file([bare]));
    expect((await subject.loadCallerRulings(path)).rulings).toEqual([bare]);
    text(file([]));
    expect((await subject.loadCallerRulings(path)).rulings).toEqual([]);
  });
  test("rejects an oversized file before reading it", async () => {
    subject._callerRulingsDeps.fileSize = async () => 262_145;
    await invalid("exceeds 262144 bytes");
  });
  test("a missing file is a read failure", async () => {
    subject._callerRulingsDeps.fileSize = async () => {
      throw new Error("ENOENT");
    };
    await expect(subject.loadCallerRulings(path)).rejects.toMatchObject({ code: "BOT_RULINGS_READ_FAILED" });
  });
  test("rejects non-JSON text", async () => {
    subject._callerRulingsDeps.readText = async () => "{nope";
    await invalid();
  });
  test.each([
    ["wrong version", { ...file(), version: 2 }],
    ["short head sha", { ...file(), headSha: "abc" }],
    ["non-hex head sha", { ...file(), headSha: "z".repeat(40) }],
    ["more than 100 rulings", file(Array.from({ length: 101 }, (_, i) => ({ ...entry, item: `D-${i}`, key: undefined })))],
    ["empty ruling", file([{ ...entry, ruling: "" }])],
    ["ruling over 2000 chars", file([{ ...entry, ruling: `confirm: ${"x".repeat(2000)}` }])],
    ["ruling without a keyword", file([{ ...entry, ruling: "looks fine to me" }])],
    ["waive without a reason", file([{ ...entry, ruling: "waive:" }])],
    ["empty by", file([{ ...entry, by: "" }])],
    ["by over 100 chars", file([{ ...entry, by: "b".repeat(101) }])],
    ["by with a newline", file([{ ...entry, by: "a\nb" }])],
    ["bad timestamp", file([{ ...entry, at: "yesterday" }])],
    ["duplicate item", file([entry, { ...entry, ruling: "verified" }])],
    ["bad item id", file([{ ...entry, item: "has space" }])],
  ])("rejects %s", async (_name, value) => {
    text(value);
    await invalid();
  });
  test("keyword is read from the first non-empty line", async () => {
    text(file([{ ...entry, ruling: "\n  waive: accepted\nmore detail" }]));
    expect((await subject.loadCallerRulings(path)).rulings).toHaveLength(1);
  });
});
