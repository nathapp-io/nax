import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { NaxError } from "@/errors";

const path = "/caller/decisions.json";
const example = {
  id: "D-12",
  statement: "Bot findings on generated files are not reported.",
  source: "koda memory 9f2c",
};
let subject: typeof import("@/bot/decisions");
let original: typeof subject._decisionsDeps | undefined;

function text(value: unknown): void {
  subject._decisionsDeps.readText = async () => JSON.stringify(value);
}

async function invalid(): Promise<void> {
  await expect(subject.loadBotDecisions(path)).rejects.toBeInstanceOf(NaxError);
  await expect(subject.loadBotDecisions(path)).rejects.toMatchObject({
    code: "BOT_DECISIONS_INVALID",
    message: expect.stringContaining(`[bot] Invalid decisions file ${path}: `),
  });
}

describe("loadBotDecisions", () => {
  beforeEach(async () => {
    subject = await import("@/bot/decisions");
    original = { ...subject._decisionsDeps };
    subject._decisionsDeps.fileSize = async () => 100;
    text({ version: 1, decisions: [] });
  });
  afterEach(() => {
    if (original) Object.assign(subject._decisionsDeps, original);
    original = undefined;
  });

  test("AC-1: returns the caller's design example", async () => {
    text({ version: 1, decisions: [example] });
    expect(await subject.loadBotDecisions(path)).toEqual([example]);
  });
  test("AC-2: accepts an empty decisions array", async () => {
    expect(await subject.loadBotDecisions(path)).toEqual([]);
  });
  test("AC-3: wraps a missing path stat failure", async () => {
    const cause = new Error("ENOENT");
    subject._decisionsDeps.fileSize = async () => {
      throw cause;
    };
    await expect(subject.loadBotDecisions(path)).rejects.toBeInstanceOf(NaxError);
    await expect(subject.loadBotDecisions(path)).rejects.toMatchObject({
      code: "BOT_DECISIONS_READ_FAILED",
      message: `[bot] Cannot read decisions file ${path}`,
      context: { stage: "bot", cause },
    });
  });
  test("AC-4: rejects non-JSON text", async () => {
    subject._decisionsDeps.readText = async () => "not JSON";
    await invalid();
  });
  test.each([
    ["AC-5: wrong version", { version: 2, decisions: [] }],
    [
      "AC-6: 101 decisions",
      { version: 1, decisions: Array.from({ length: 101 }, (_, i) => ({ id: `D-${i}`, statement: "S" })) },
    ],
    ["AC-7: id with space", { version: 1, decisions: [{ id: "has space", statement: "S" }] }],
    ["AC-8: empty statement", { version: 1, decisions: [{ id: "D-1", statement: "" }] }],
    ["AC-9: long statement", { version: 1, decisions: [{ id: "D-1", statement: "S".repeat(2_001) }] }],
    ["AC-10: long source", { version: 1, decisions: [{ id: "D-1", statement: "S", source: "s".repeat(201) }] }],
    ["empty id", { version: 1, decisions: [{ id: "", statement: "S" }] }],
    ["long id", { version: 1, decisions: [{ id: "D".repeat(65), statement: "S" }] }],
    ["missing decisions", { version: 1 }],
    ["null document", null],
    ["wrong source type", { version: 1, decisions: [{ id: "D-1", statement: "S", source: 3 }] }],
  ])("%s is invalid", async (_name, value) => {
    text(value);
    await invalid();
  });
  test("AC-11: identifies the first duplicate id", async () => {
    text({
      version: 1,
      decisions: [
        { id: "D-1", statement: "S" },
        { id: "D-1", statement: "T" },
      ],
    });
    await expect(subject.loadBotDecisions(path)).rejects.toMatchObject({
      code: "BOT_DECISIONS_INVALID",
      message: `[bot] Invalid decisions file ${path}: duplicate id D-1`,
    });
  });
  test("AC-12: rejects a file over the byte limit", async () => {
    subject._decisionsDeps.fileSize = async () => 262_145;
    await invalid();
  });
  test("AC-13: checks the byte limit before reading", async () => {
    subject._decisionsDeps.fileSize = async () => 262_145;
    const readText = mock(async () => "{}");
    subject._decisionsDeps.readText = readText;
    await invalid();
    expect(readText).not.toHaveBeenCalled();
  });
  test("AC-14: wraps an unreadable file's read failure", async () => {
    const cause = new Error("EACCES");
    subject._decisionsDeps.readText = async () => {
      throw cause;
    };
    await expect(subject.loadBotDecisions(path)).rejects.toBeInstanceOf(NaxError);
    await expect(subject.loadBotDecisions(path)).rejects.toMatchObject({
      code: "BOT_DECISIONS_READ_FAILED",
      message: `[bot] Cannot read decisions file ${path}`,
      context: { stage: "bot", cause },
    });
  });
  test("accepts inclusive limits, optional source and all allowed id punctuation", async () => {
    const decisions = Array.from({ length: 100 }, (_, i) => ({
      id: `${i}Aa._:-`.padEnd(64, "z"),
      statement: "S".repeat(2_000),
    }));
    const withSource = { ...example, source: "s".repeat(200) };
    decisions[0] = withSource;
    text({ version: 1, decisions });
    subject._decisionsDeps.fileSize = async () => 262_144;
    expect(await subject.loadBotDecisions(path)).toEqual(decisions);
  });
  test("reads a real file and classifies a real missing path with the default deps", async () => {
    if (!original) throw new Error("Dependency snapshot missing");
    Object.assign(subject._decisionsDeps, original);
    await withTempDir(async (dir) => {
      const file = join(dir, "decisions.json");
      await Bun.write(file, JSON.stringify({ version: 1, decisions: [example] }));
      expect(await subject.loadBotDecisions(file)).toEqual([example]);
      const missing = join(dir, "missing.json");
      await expect(subject.loadBotDecisions(missing)).rejects.toMatchObject({
        code: "BOT_DECISIONS_READ_FAILED",
        message: `[bot] Cannot read decisions file ${missing}`,
      });
    });
  });
  test("exports the loader and dependency seam from the bot barrel", async () => {
    const bot = await import("@/bot");
    expect(bot.loadBotDecisions).toBe(subject.loadBotDecisions);
    expect(bot._decisionsDeps).toBe(subject._decisionsDeps);
  });
});
