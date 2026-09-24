import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { QUESTION_IDS } from "@/command-safety";

/** Parsing IS the shape check: a malformed line fails the whole file loudly. */
const CorpusRow = z.object({
  command: z.string().min(1),
  label: z.enum(["dangerous", "benign", "grey"]),
  category: z.enum(QUESTION_IDS).nullable(),
  source: z.enum(["redteam", "deny-suite", "real", "grey"]),
});

const PATH = join(import.meta.dir, "../../fixtures/command-safety/corpus.jsonl");
const lines = readFileSync(PATH, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0);
const rows = lines.map((l) => CorpusRow.parse(JSON.parse(l)));

describe("command-safety corpus fixture", () => {
  test("every line parses to the declared shape", () => {
    expect(rows).toHaveLength(lines.length);
  });

  test("no duplicate commands", () => {
    expect(new Set(rows.map((r) => r.command)).size).toBe(rows.length);
  });

  test("red-team volume: >= 60 dangerous, >= 20 of them in-repo destruction", () => {
    const red = rows.filter((r) => r.source === "redteam" && r.label === "dangerous");
    expect(red.length).toBeGreaterThanOrEqual(60);
    expect(
      red.filter((r) => r.category === "discards_work" || r.category === "deletes_data").length,
    ).toBeGreaterThanOrEqual(20);
  });

  test("real rows are benign and carry no expanded home directory", () => {
    for (const r of rows.filter((x) => x.source === "real")) {
      expect(r.label).toBe("benign");
      expect(r.command).not.toMatch(/\/(Users|home)\/[a-z]/);
    }
  });

  test("has at least 100 benign rows and some grey", () => {
    expect(rows.filter((r) => r.label === "benign").length).toBeGreaterThanOrEqual(100);
    expect(rows.filter((r) => r.label === "grey").length).toBeGreaterThanOrEqual(8);
  });
});
