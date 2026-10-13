/** nax#2491 P8: a session that logged >= 3 identical tool errors gets one line saying what happened next. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  describeRepeatedToolErrors,
  readToolEntriesSince,
  resetToolErrorClaims,
  type ToolRow,
  withToolErrorOutcome,
} from "@/workflow/tool-error-outcome";

const row = (tool: string, outcome: ToolRow["outcome"], file: string, extra: Partial<ToolRow> = {}): ToolRow => ({
  tool,
  outcome,
  input: { file_path: file },
  ...extra,
});
const edits = (n: number, file = "src/a.ts"): ToolRow[] => Array.from({ length: n }, () => row("Edit", "error", file));

describe("describeRepeatedToolErrors", () => {
  test("four Edit errors then a Write on the same file: succeeded via Write", () => {
    expect(describeRepeatedToolErrors([...edits(4), row("Write", "ok", "src/a.ts")])).toEqual([
      "4 Edit errors on src/a.ts, then succeeded via Write",
    ]);
  });

  test("the same tool succeeding later reads as plain success", () => {
    expect(describeRepeatedToolErrors([...edits(3), row("Edit", "ok", "src/a.ts")])).toEqual([
      "3 Edit errors on src/a.ts, then succeeded",
    ]);
  });

  test("no later success on that target: gave up", () => {
    expect(describeRepeatedToolErrors([...edits(3), row("Read", "ok", "src/other.ts")])).toEqual([
      "3 Edit errors on src/a.ts, then gave up",
    ]);
  });

  test("fewer than three is not worth a line", () => {
    expect(describeRepeatedToolErrors(edits(2))).toEqual([]);
  });

  test("errors on different targets do not add up", () => {
    expect(describeRepeatedToolErrors([...edits(2, "a.ts"), ...edits(2, "b.ts")])).toEqual([]);
  });

  test("Bash errors are told apart by exit code and target command", () => {
    const bash = (code: number): ToolRow => ({
      tool: "Bash",
      outcome: "error",
      input: { command: "bun test x" },
      exitCode: code,
    });
    expect(describeRepeatedToolErrors([bash(1), bash(1), bash(1), bash(2)])).toEqual([
      "3 Bash errors (exit 1) on bun test x, then gave up",
    ]);
  });

  test("an Exec error is keyed by its argv, and a call with no target is never grouped", () => {
    const exec = (outcome: string, argv: string[]): ToolRow => ({ tool: "Exec", outcome, input: { argv } });
    expect(
      describeRepeatedToolErrors([
        exec("error", ["bun", "test", "a"]),
        exec("error", ["bun", "test", "a"]),
        exec("error", ["bun", "test", "a"]),
        exec("ok", ["bun", "test", "a"]),
      ]),
    ).toEqual(["3 Exec errors on bun test a, then succeeded"]);
    const bare = (outcome: string): ToolRow => ({ tool: "Glob", outcome, input: {} });
    expect(describeRepeatedToolErrors([bare("error"), bare("error"), bare("error"), bare("ok")])).toEqual([]);
  });

  test("denied calls are not errors", () => {
    expect(describeRepeatedToolErrors([1, 2, 3].map(() => row("Edit", "denied", "src/a.ts")))).toEqual([]);
  });

  test("one line per repeated group", () => {
    const out = describeRepeatedToolErrors([...edits(3, "a.ts"), ...edits(3, "b.ts"), row("Write", "ok", "b.ts")]);
    expect(out).toEqual(["3 Edit errors on a.ts, then gave up", "3 Edit errors on b.ts, then succeeded via Write"]);
  });
});

describe("readToolEntriesSince", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map(cleanupTempDir));
    dirs.length = 0;
  });

  async function auditDir(files: Record<string, unknown>): Promise<string> {
    const out = makeTempDir("tool-err-");
    dirs.push(out);
    for (const [name, calls] of Object.entries(files)) {
      await Bun.write(join(out, "tool-audit", "feat", name), JSON.stringify({ calls }));
    }
    return out;
  }

  test("reads this run's files written at or after the cutoff, in file order", async () => {
    const out = await auditDir({
      "run1-1000-old.json": [row("Edit", "error", "old.ts")],
      "run1-2000-a.json": [row("Edit", "error", "a.ts")],
      "run1-3000-b.json": [row("Write", "ok", "a.ts")],
      "run2-2500-other.json": [row("Edit", "error", "x.ts")],
    });
    const entries = await readToolEntriesSince({ outputDir: out, feature: "feat", runId: "run1" }, 2000);
    expect(entries.map((e) => e.row.tool)).toEqual(["Edit", "Write"]);
  });

  test("a missing directory or a bad file is no rows, not an error", async () => {
    const out = makeTempDir("tool-err-none-");
    dirs.push(out);
    expect(await readToolEntriesSince({ outputDir: out, feature: "feat", runId: "run1" }, 0)).toEqual([]);
    await Bun.write(join(out, "tool-audit", "feat", "run1-5000-bad.json"), "{nope");
    expect(await readToolEntriesSince({ outputDir: out, feature: "feat", runId: "run1" }, 0)).toEqual([]);
  });
});

describe("withToolErrorOutcome windows and claims rows (ACP writes the file at session close)", () => {
  const dirs: string[] = [];
  let logs: LogEntry[] = [];
  beforeEach(() => {
    resetLogger();
    resetToolErrorClaims();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(async () => {
    resetLogger();
    await Promise.all(dirs.map(cleanupTempDir));
    dirs.length = 0;
  });
  const at = (ms: number): string => new Date(ms).toISOString();
  const timed = (ms: number, n: number, file = "src/a.ts"): ToolRow[] =>
    Array.from({ length: n }, () => ({ ...row("Edit", "error", file), at: at(ms) }));
  const step = (out: string, run: string, now: () => number) => ({
    outputDir: out,
    feature: "feat",
    runId: run,
    storyId: "_run",
    now,
  });
  const lines = () => logs.filter((e) => e.stage === "workflow").map((e) => e.message);

  test("rows stamped before the step began are not blamed on it", async () => {
    const out = makeTempDir("tool-err-win-");
    dirs.push(out);
    // One session file written at close holds an EARLIER step's errors (10_000) and this step's (50_000).
    await Bun.write(
      join(out, "tool-audit", "feat", "winrun-60000-s.json"),
      JSON.stringify({ calls: [...timed(10_000, 3, "old.ts"), ...timed(50_000, 3, "new.ts")] }),
    );
    let clock = 40_000;
    await withToolErrorOutcome(
      step(out, "winrun", () => clock),
      "step B",
      async () => {
        clock = 55_000;
      },
    );
    expect(lines()).toEqual(["step B: 3 Edit errors on new.ts, then gave up"]);
  });

  test("a row already reported by one step is not reported by the next", async () => {
    const out = makeTempDir("tool-err-claim-");
    dirs.push(out);
    await Bun.write(
      join(out, "tool-audit", "feat", "claimrun-60000-s.json"),
      JSON.stringify({ calls: timed(50_000, 3) }),
    );
    let clock = 40_000;
    const now = () => clock;
    await withToolErrorOutcome(step(out, "claimrun", now), "first", async () => {
      clock = 55_000;
    });
    clock = 40_000;
    await withToolErrorOutcome(step(out, "claimrun", now), "second", async () => {
      clock = 55_000;
    });
    expect(lines()).toEqual(["first: 3 Edit errors on src/a.ts, then gave up"]);
  });
});

describe("withToolErrorOutcome", () => {
  let logs: LogEntry[] = [];
  const dirs: string[] = [];
  beforeEach(() => {
    resetLogger();
    resetToolErrorClaims();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(async () => {
    resetLogger();
    await Promise.all(dirs.map(cleanupTempDir));
    dirs.length = 0;
  });

  test("logs one line after the step, labelled, when its session repeated an error", async () => {
    const out = makeTempDir("tool-err-wrap-");
    dirs.push(out);
    const result = await withToolErrorOutcome(
      { outputDir: out, feature: "feat", runId: "run1", storyId: "_run", now: () => 1_000 },
      "branch-fix",
      async () => {
        await Bun.write(
          join(out, "tool-audit", "feat", "run1-2000-s.json"),
          JSON.stringify({ calls: [...edits(4), row("Write", "ok", "src/a.ts")] }),
        );
        return "done";
      },
    );
    expect(result).toBe("done");
    const lines = logs.filter((e) => e.stage === "workflow").map((e) => e.message);
    expect(lines).toEqual(["branch-fix: 4 Edit errors on src/a.ts, then succeeded via Write"]);
  });

  test("a step with no repeated errors logs nothing and returns its result", async () => {
    const out = makeTempDir("tool-err-quiet-");
    dirs.push(out);
    const result = await withToolErrorOutcome(
      { outputDir: out, feature: "feat", runId: "run1", storyId: "US-001", now: () => 1_000 },
      "US-001 fix r1",
      async () => 7,
    );
    expect(result).toBe(7);
    expect(logs.filter((e) => e.stage === "workflow")).toEqual([]);
  });

  test("still reports when the step throws, and rethrows", async () => {
    const out = makeTempDir("tool-err-throw-");
    dirs.push(out);
    await expect(
      withToolErrorOutcome(
        { outputDir: out, feature: "feat", runId: "run1", storyId: "US-001", now: () => 1_000 },
        "US-001 fix r1",
        async () => {
          await Bun.write(join(out, "tool-audit", "feat", "run1-2000-s.json"), JSON.stringify({ calls: edits(3) }));
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(logs.filter((e) => e.stage === "workflow").map((e) => e.message)).toEqual([
      "US-001 fix r1: 3 Edit errors on src/a.ts, then gave up",
    ]);
  });
});
