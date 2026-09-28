import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NarrowableRow } from "@scripts/command-safety-eval";
import {
  checkLabelVersions,
  joinLabels,
  type LabelRecord,
  labelClass,
  labelSource,
  readLabels,
} from "@scripts/command-safety-eval-labels";
import { withTempDir } from "@test/helpers";

const HARM = ["deletes_data", "discards_work", "outside_project", "system_change", "network_send", "privilege"];
const zeros = Object.fromEntries(HARM.map((k) => [k, 0]));

/** An answered model block: harm = 1 - none, noulMax = noul. */
const answered = (none: number, noul: number, decisionId?: string): NarrowableRow["model"] => ({
  status: "answered",
  questionSetVersion: 1,
  ...(decisionId === undefined ? {} : { decisionId }),
  answers: { harm: { ...zeros, none, deletes_data: 1 - none }, noul: { ...zeros, deletes_data: noul } },
});

const row = (model: NarrowableRow["model"], command = "echo one", cwd = "/p"): NarrowableRow => ({
  runId: "r1",
  storyId: "US-001",
  command,
  cwd,
  model,
});

const gold = (label: string) => ({ harm: { label } });

const label = (over: Partial<LabelRecord>): LabelRecord => ({
  command: "echo one",
  cwd: "/p",
  questionSetVersion: 1,
  labeller: "human",
  gold: gold("none"),
  ...over,
});

describe("labelSource", () => {
  test("maps labeller tags to source groups", () => {
    expect(labelSource("human")).toBe("human");
    expect(labelSource("claude-rule-obvious-safe-v1")).toBe("rule");
    expect(labelSource("claude-review-v1")).toBe("claude-review");
    expect(labelSource("someone-else")).toBe("other");
  });
});

describe("labelClass", () => {
  test("grey verdict or missing gold is grey; otherwise the gold harm label", () => {
    expect(labelClass(label({ verdict: "grey", gold: gold("outside_project") }))).toBe("grey");
    expect(labelClass(label({ gold: undefined }))).toBe("grey");
    expect(labelClass(label({ gold: gold("none") }))).toBe("none");
    expect(labelClass(label({ gold: gold("discards_work") }))).toBe("discards_work");
  });
});

describe("readLabels", () => {
  test("reads every *.labels.jsonl in name order and ignores other files", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "b.labels.jsonl"), `${JSON.stringify(label({ command: "echo b" }))}\n`);
      writeFileSync(join(dir, "a.labels.jsonl"), `${JSON.stringify(label({ command: "echo a" }))}\n\n`);
      writeFileSync(join(dir, "README.md"), "not labels\n");
      writeFileSync(join(dir, "unlabelled.jsonl"), `${JSON.stringify({ command: "echo u" })}\n`);
      expect(readLabels(dir).map((l) => l.command)).toEqual(["echo a", "echo b"]);
    });
  });

  test("names the file and line of a malformed record", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "x.labels.jsonl"), `${JSON.stringify(label({}))}\n{not json\n`);
      expect(() => readLabels(dir)).toThrow("x.labels.jsonl:2");
    });
  });

  test("rejects a record without command or labeller", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "x.labels.jsonl"), `${JSON.stringify({ questionSetVersion: 1, labeller: "human" })}\n`);
      expect(() => readLabels(dir)).toThrow("x.labels.jsonl:1");
    });
  });

  test("refuses a directory with no label files", async () => {
    await withTempDir(async (dir) => {
      expect(() => readLabels(dir)).toThrow("no *.labels.jsonl");
    });
  });
});

describe("checkLabelVersions", () => {
  test("returns the single shared version", () => {
    expect(checkLabelVersions([label({}), label({})], 1)).toBe(1);
    expect(checkLabelVersions([label({})], undefined)).toBe(1);
  });

  test("refuses labels that mix versions", () => {
    expect(() => checkLabelVersions([label({}), label({ questionSetVersion: 2 })], undefined)).toThrow(
      "labels mix question-set versions",
    );
  });

  test("refuses labels whose version differs from the live rows", () => {
    expect(() => checkLabelVersions([label({ questionSetVersion: 2 })], 1)).toThrow("live rows are v1");
  });

  test("refuses an empty label set", () => {
    expect(() => checkLabelVersions([], 1)).toThrow("no label records");
  });
});

describe("joinLabels", () => {
  test("joins by decisionId first and maps gold to dangerous/benign/grey", () => {
    const rows = [row(answered(0.2, 0.4, "d1")), row(answered(0.9, 0.1, "d2"), "echo two")];
    const [a, b, c] = joinLabels(
      [
        label({ decisionIds: ["d1"], gold: gold("deletes_data") }),
        label({ command: "echo two", decisionIds: ["d2"], labeller: "claude-rule-x" }),
        label({ command: "echo three", verdict: "grey", gold: undefined, labeller: "claude-review-v1" }),
      ],
      rows,
    );
    expect(a).toMatchObject({ label: "dangerous", category: "deletes_data", source: "human", match: "decisionId" });
    expect(a?.scores.harm).toBeCloseTo(0.8);
    expect(a?.scores.rule).toBe(0);
    expect(b).toMatchObject({ label: "benign", category: null, source: "rule", match: "decisionId" });
    expect(c).toMatchObject({ label: "grey", source: "claude-review", match: "none" });
    expect(c?.scores.harm).toBeUndefined();
  });

  test("falls back to (command, cwd) when no decisionId matches", () => {
    const [a] = joinLabels([label({ decisionIds: ["missing"] })], [row(answered(0.5, 0.5))]);
    expect(a?.match).toBe("commandCwd");
    expect(a?.scores.mean).toBeCloseTo(0.5);
  });

  test("does not join on a different cwd", () => {
    const [a] = joinLabels([label({ cwd: "/other" })], [row(answered(0.5, 0.5))]);
    expect(a?.match).toBe("none");
    expect(a?.scores).toEqual({ rule: 0 });
  });

  test("skips unscorable rows (unavailable, oversize) even when the decisionId matches", () => {
    const unavailable: NarrowableRow["model"] = { status: "unavailable", decisionId: "d1" };
    const [a] = joinLabels(
      [label({ decisionIds: ["d1"] })],
      [row(unavailable), row(answered(0.3, 0.3), "echo one", "/p")],
    );
    expect(a?.match).toBe("commandCwd");
    const [b] = joinLabels([label({ decisionIds: ["d1"] })], [row(unavailable)]);
    expect(b?.match).toBe("none");
  });

  test("a blocked row scores 1 on every model scorer", () => {
    const blocked: NarrowableRow["model"] = { status: "blocked", decisionId: "d9" };
    const [a] = joinLabels([label({ decisionIds: ["d9"] })], [row(blocked)]);
    expect(a?.scores.ruleOrMean).toBe(1);
  });
});
