import { afterEach, describe, expect, test } from "bun:test";
import {
  _resultDeps,
  appendRound,
  readRounds,
  resolveAuditDir,
  resultPath,
  roundsPath,
  writeResult,
} from "@flows/nax-finish/steps/result";
import type { FinishRound } from "@flows/nax-finish/types";

const originalWriteText = _resultDeps.writeText;
const originalAppendText = _resultDeps.appendText;
const originalReadText = _resultDeps.readText;

afterEach(() => {
  _resultDeps.writeText = originalWriteText;
  _resultDeps.appendText = originalAppendText;
  _resultDeps.readText = originalReadText;
});

const TARGET = {
  auditDir: "/home/u/.nax/proj/finish-audit/feat-x",
  workdir: "/repo",
  feature: "feat-x",
  runId: "run-2026-08-01T03-30-25-572Z",
};

const round = (over: Partial<FinishRound> = {}): FinishRound => ({
  ts: "2026-08-01T05:00:00.000Z",
  phase: "quality",
  attempt: 1,
  committed: true,
  findings: [],
  ...over,
});

/** Stub readText to return `raw`, and capture what writeResult/appendRound emit. */
function captureWrites(raw: string | null = null) {
  const wrote: { p: string; s: string }[] = [];
  const appended: { p: string; s: string }[] = [];
  _resultDeps.readText = async () => raw;
  _resultDeps.writeText = async (p, s) => {
    wrote.push({ p, s });
  };
  _resultDeps.appendText = async (p, s) => {
    appended.push({ p, s });
  };
  return { wrote, appended };
}

describe("audit paths", () => {
  test("live under the plugin-supplied global audit dir, not the repo", () => {
    expect(resolveAuditDir(TARGET)).toBe("/home/u/.nax/proj/finish-audit/feat-x");
    expect(resultPath(TARGET)).toBe(`/home/u/.nax/proj/finish-audit/feat-x/${TARGET.runId}.result.json`);
    expect(roundsPath(TARGET)).toBe(`/home/u/.nax/proj/finish-audit/feat-x/${TARGET.runId}.jsonl`);
  });

  test("are per-run, so a second finish of the same feature cannot overwrite the first", () => {
    const a = resultPath({ ...TARGET, runId: "run-a" });
    const b = resultPath({ ...TARGET, runId: "run-b" });
    expect(a).not.toBe(b);
  });

  test("fall back to a repo-local dir when the caller supplied no auditDir", () => {
    const { auditDir: _drop, ...noAuditDir } = TARGET;
    expect(resolveAuditDir(noAuditDir)).toBe("/repo/.nax/finish-audit/feat-x");
  });

  test("fall back to a fixed run id when the caller supplied none, rather than producing an undefined path", () => {
    const { runId: _drop, ...noRunId } = TARGET;
    expect(resultPath(noRunId)).toBe("/home/u/.nax/proj/finish-audit/feat-x/run.result.json");
  });
});

describe("appendRound", () => {
  test("appends one JSON line per round to the run's jsonl", async () => {
    const { appended } = captureWrites();
    await appendRound(TARGET, round({ attempt: 2 }));
    expect(appended).toHaveLength(1);
    expect(appended[0].p).toBe(roundsPath(TARGET));
    expect(appended[0].s.endsWith("\n")).toBe(true);
    expect(JSON.parse(appended[0].s)).toMatchObject({ phase: "quality", attempt: 2, committed: true });
  });

  // A round is a record of work already done; an unwritable ~/.nax must not
  // take down the flow mid-loop and lose the work itself.
  test("an unwritable audit dir does not propagate out of the fix loop", async () => {
    _resultDeps.appendText = async () => {
      throw new Error("EACCES");
    };
    expect(await appendRound(TARGET, round())).toBeUndefined();
  });
});

describe("readRounds", () => {
  test("parses every line back", async () => {
    captureWrites(`${JSON.stringify(round({ attempt: 1 }))}\n${JSON.stringify(round({ attempt: 2 }))}\n`);
    expect(await readRounds(TARGET)).toHaveLength(2);
  });

  test("a torn final line does not lose the rounds before it", async () => {
    captureWrites(`${JSON.stringify(round({ attempt: 1 }))}\n{"phase":"qual`);
    const rounds = await readRounds(TARGET);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].attempt).toBe(1);
  });

  test("no trail yet reads as no rounds, not an error", async () => {
    captureWrites(null);
    expect(await readRounds(TARGET)).toEqual([]);
  });

  // AC3 — the fix-commit SHA recorded by the live audit trail must survive a
  // round trip through JSONL, otherwise the terminal result loses "Fixed in
  // <sha>" and the only way back is `git log` matching timestamps.
  test("preserves a per-round sha through the JSONL round trip", async () => {
    captureWrites(`${JSON.stringify(round({ committed: true, sha: "abc123" }))}\n`);
    const [got] = await readRounds(TARGET);
    expect(got.sha).toBe("abc123");
  });
});

describe("writeResult", () => {
  test("writes the terminal result to the run-scoped audit path", async () => {
    const { wrote } = captureWrites();
    await writeResult(TARGET, { feature: "feat-x", status: "escalated", escalationReason: "design call" });
    expect(wrote[0].p).toBe(resultPath(TARGET));
    expect(JSON.parse(wrote[0].s)).toMatchObject({
      feature: "feat-x",
      status: "escalated",
      escalationReason: "design call",
    });
  });

  // The regression this exists for: a successful finish that took rounds to get
  // there recorded nothing, so the fixes it made were invisible after the fact.
  test("embeds the recorded rounds on a SUCCESS status, not only on escalations", async () => {
    const { wrote } = captureWrites(
      `${JSON.stringify(round({ phase: "gate", attempt: 1 }))}\n${JSON.stringify(round({ phase: "quality", attempt: 1 }))}\n`,
    );
    await writeResult(TARGET, { feature: "feat-x", status: "promoted", url: "https://forge/pr/1" });
    const parsed = JSON.parse(wrote[0].s);
    expect(parsed.status).toBe("promoted");
    expect(parsed.rounds).toHaveLength(2);
    expect(parsed.rounds[0]).toMatchObject({ phase: "gate", attempt: 1 });
  });

  test("omits the rounds key entirely when no round ran", async () => {
    const { wrote } = captureWrites(null);
    await writeResult(TARGET, { feature: "feat-x", status: "promoted" });
    expect(JSON.parse(wrote[0].s)).not.toHaveProperty("rounds");
  });

  // AC4 — the recorded SHA travels from the live audit trail into the terminal
  // result, so the consumer (PR body, status reporter) can cite "Fixed in <sha>"
  // without going back to `git log`.
  test("carries each recorded sha through to rounds[] in the result", async () => {
    const { wrote } = captureWrites(
      `${JSON.stringify(round({ attempt: 1, committed: true, sha: "sha-1" }))}\n${JSON.stringify(round({ phase: "gate", attempt: 1, committed: true, sha: "sha-2" }))}\n`,
    );
    await writeResult(TARGET, { feature: "feat-x", status: "promoted", url: "https://forge/pr/1" });
    const parsed = JSON.parse(wrote[0].s);
    expect(parsed.rounds).toHaveLength(2);
    expect(parsed.rounds[0].sha).toBe("sha-1");
    expect(parsed.rounds[1].sha).toBe("sha-2");
  });
});
