import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withTempDir } from "@test/helpers";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/command-safety-eval.ts");
const HARM = ["deletes_data", "discards_work", "outside_project", "system_change", "network_send", "privilege"];
const zeros = Object.fromEntries(HARM.map((k) => [k, 0]));

const shadowRow = (command: string, none: number, decisionId: string, version = 1) => ({
  runId: "r1",
  storyId: "US-001",
  command,
  cwd: "/p",
  model: {
    status: "answered",
    questionSetVersion: version,
    decisionId,
    answers: { harm: { ...zeros, none, deletes_data: 1 - none }, noul: { ...zeros, deletes_data: 1 - none } },
  },
});

const labelRec = (command: string, harm: string, decisionId: string, version = 1) => ({
  command,
  cwd: "/p",
  questionSetVersion: version,
  labeller: "human",
  decisionIds: [decisionId],
  gold: { harm: { label: harm } },
});

const jsonl = (items: readonly unknown[]) => `${items.map((i) => JSON.stringify(i)).join("\n")}\n`;

async function runEval(args: readonly string[]) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

function setup(dir: string, labelVersion = 1) {
  const corpus = join(dir, "corpus.jsonl");
  writeFileSync(
    corpus,
    jsonl([
      { command: "echo c1", label: "dangerous", category: "deletes_data", source: "t" },
      { command: "echo c2", label: "benign", category: null, source: "t" },
    ]),
  );
  const rows = join(dir, "rows.jsonl");
  writeFileSync(rows, jsonl([shadowRow("echo one", 0.1, "d1"), shadowRow("echo two", 0.9, "d2")]));
  const labels = join(dir, "labels");
  mkdirSync(labels);
  writeFileSync(
    join(labels, "human.labels.jsonl"),
    jsonl([labelRec("echo one", "deletes_data", "d1", labelVersion), labelRec("echo two", "none", "d2", labelVersion)]),
  );
  return { corpus, rows, labels, out: join(dir, "report.md") };
}

describe("command-safety-eval --labels", () => {
  test("appends the labelled section to the report", async () => {
    await withTempDir(async (dir) => {
      const p = setup(dir);
      const { code, stderr } = await runEval([
        "--corpus",
        p.corpus,
        "--rows",
        p.rows,
        "--labels",
        p.labels,
        "--out",
        p.out,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const md = readFileSync(p.out, "utf8");
      expect(md).toContain("# Command-safety eval");
      expect(md).toContain("## Labelled shadow commands");
      expect(md).toContain("Model answer joined by decisionId 2, by command+cwd 0, unmatched 0");
      expect(md).toContain("### all (n=2)");
      expect(md).toContain("| ruleOrMean |");
    });
  }, 30_000);

  test("refuses --labels without --rows", async () => {
    await withTempDir(async (dir) => {
      const p = setup(dir);
      const { code, stderr } = await runEval(["--corpus", p.corpus, "--labels", p.labels, "--out", p.out]);
      expect(code).toBe(1);
      expect(stderr).toContain("--labels needs --rows");
    });
  }, 30_000);

  test("refuses labels on a different question-set version than the rows", async () => {
    await withTempDir(async (dir) => {
      const p = setup(dir, 2);
      const { code, stderr } = await runEval([
        "--corpus",
        p.corpus,
        "--rows",
        p.rows,
        "--labels",
        p.labels,
        "--out",
        p.out,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("never mix versions");
    });
  }, 30_000);

  test("without --labels the report has no labelled section", async () => {
    await withTempDir(async (dir) => {
      const p = setup(dir);
      const { code } = await runEval(["--corpus", p.corpus, "--rows", p.rows, "--out", p.out]);
      expect(code).toBe(0);
      expect(readFileSync(p.out, "utf8")).not.toContain("## Labelled shadow commands");
    });
  }, 30_000);
});
