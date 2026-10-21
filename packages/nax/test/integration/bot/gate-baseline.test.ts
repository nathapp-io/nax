import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _gateBaselineDeps, failingOnHead, logGateFailure, readHeadCi } from "@/bot";
import type { GateCommand, GateRunRecord } from "@/finish/gates/quality";

const original = { ..._gateBaselineDeps };
afterEach(() => Object.assign(_gateBaselineDeps, original));

const gates: GateCommand[] = [{ name: "lint", command: "bun run check:all", cwd: "/worktree" }];
const ok = { exitCode: 0, stdout: "", stderr: "" };

function record(overrides: Partial<GateRunRecord> = {}): GateRunRecord {
  return {
    name: "lint",
    cwd: "/worktree",
    status: "failed",
    exitCode: 1,
    durationMs: 5,
    output: "a\nb\nc",
    ...overrides,
  };
}

describe("readHeadCi", () => {
  test("reads CI once for the exact head without waiting", async () => {
    const read = mock(async () => ({ outcome: "green" as const, detail: "CI checks: 3/3 passed, 0 pending" }));
    _gateBaselineDeps.readChecksOnce = read;
    const result = await readHeadCi({ forge: "github", url: "https://x/pr/1", repoRoot: "/repo", headSha: "h1" });
    expect(result.outcome).toBe("green");
    expect(read).toHaveBeenCalledWith("github", "https://x/pr/1", { cwd: "/repo", expectedSha: "h1" });
  });
});

describe("failingOnHead", () => {
  test("re-runs the gates on the unmodified head, then restores the fix commit", async () => {
    const runGit = mock(async (_argv: string[], _cwd: string) => ok);
    const run = mock(async () => ({ passed: false, ran: ["lint"], failing: ["lint"], output: "" }));
    _gateBaselineDeps.runGit = runGit;
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = run;
    expect(await failingOnHead("/worktree", "h1", gates)).toEqual(["lint"]);
    expect(runGit.mock.calls.map(([argv]) => argv)).toEqual([
      ["status", "--porcelain", "--untracked-files=no"],
      ["checkout", "--detach", "h1"],
      ["checkout", "--detach", "fix-sha"],
    ]);
    expect(run).toHaveBeenCalledWith("/worktree", gates, { onGate: expect.any(Function) });
  });

  test("tracked edits left by the fix's gate run classify nothing: the head would not be unmodified", async () => {
    const runGit = mock(async (argv: string[], _cwd: string) =>
      argv[0] === "status" ? { ...ok, stdout: " M src/a.ts\n" } : ok,
    );
    const run = mock(async () => ({ passed: true, ran: [], failing: [], output: "" }));
    _gateBaselineDeps.runGit = runGit;
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = run;
    expect(await failingOnHead("/worktree", "h1", gates)).toBeUndefined();
    expect(runGit.mock.calls.map(([argv]) => argv[0])).toEqual(["status"]);
    expect(run).not.toHaveBeenCalled();
  });

  test("an unreachable head classifies nothing and runs no gate", async () => {
    const run = mock(async () => ({ passed: true, ran: [], failing: [], output: "" }));
    _gateBaselineDeps.runGit = async (argv) =>
      argv[0] === "status" ? ok : { exitCode: 1, stdout: "", stderr: "would be overwritten" };
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = run;
    expect(await failingOnHead("/worktree", "h1", gates)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  test("restores the fix commit even when the gate runner throws", async () => {
    const runGit = mock(async (_argv: string[], _cwd: string) => ok);
    _gateBaselineDeps.runGit = runGit;
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = async () => {
      throw new Error("spawn failed");
    };
    await expect(failingOnHead("/worktree", "h1", gates)).rejects.toThrow("spawn failed");
    expect(runGit.mock.calls.at(-1)?.[0]).toEqual(["checkout", "--detach", "fix-sha"]);
  });

  test("a failed restore is logged, not thrown: the baseline result still stands", async () => {
    const logger = makeLogger();
    _gateBaselineDeps.getLogger = () => logger;
    _gateBaselineDeps.runGit = async (argv) => (argv[2] === "fix-sha" ? { ...ok, exitCode: 1 } : ok);
    _gateBaselineDeps.readHead = async () => "fix-sha";
    _gateBaselineDeps.runQualityGates = async () => ({ passed: true, ran: ["lint"], failing: [], output: "" });
    expect(await failingOnHead("/worktree", "h1", gates)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("bot-fix", "Could not restore the fix commit after the baseline run", {
      worktree: "/worktree",
      fixSha: "fix-sha",
      stderr: "",
    });
  });
});

describe("logGateFailure", () => {
  test("logs a red gate with the tail of its output", () => {
    const logger = makeLogger();
    _gateBaselineDeps.getLogger = () => logger;
    logGateFailure("fix")(record());
    expect(logger.warn).toHaveBeenCalledWith("bot-fix", "Gate lint failed", {
      phase: "fix",
      gate: "lint",
      status: "failed",
      exitCode: 1,
      durationMs: 5,
      tail: "a\nb\nc",
    });
  });

  test("stays silent for a passing gate", () => {
    const logger = makeLogger();
    _gateBaselineDeps.getLogger = () => logger;
    logGateFailure("baseline")(record({ status: "passed", exitCode: 0 }));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
