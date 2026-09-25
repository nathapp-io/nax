/**
 * US-003 — the normalized Exec argv (the one that actually ran) reaches the
 * command-safety shadow row, without changing the model argv classification
 * reads.
 *
 * A separate file from runtime.test.ts by design: that file is already past the
 * 650-line split target and the story forbids growing it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import {
  type CommandSafetyRow,
  type CommandShadow,
  createCommandShadow,
  type ExecRun,
  type FinalOutcome,
  type Observation,
} from "@/command-safety";
import { _codingToolDeps, type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
let rows: CommandSafetyRow[];
let origGetLogger: typeof _codingToolDeps.getLogger;

const write = async (row: CommandSafetyRow) => {
  rows.push(row);
};

beforeEach(() => {
  root = makeTempDir("rt-shadow-executed-");
  rows = [];
  origGetLogger = _codingToolDeps.getLogger;
  _codingToolDeps.getLogger = () => makeLogger();
});

afterEach(() => {
  _codingToolDeps.getLogger = origGetLogger;
  cleanupTempDir(root);
});

/** The single written row, or a loud failure. */
function writtenRow(): CommandSafetyRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("no row was written");
  return row;
}

/**
 * Records every argument each `settle` call received, so a test can assert the
 * ARITY — an Exec row's third argument, and a Bash row's absence of one.
 */
function recorder() {
  const observed: [string, Observation][] = [];
  const settled: unknown[][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (...args: [string, FinalOutcome, ExecRun?]) => void settled.push(args),
    drain: async () => {},
  };
  return { shadow, observed, settled };
}

/** The single settle call, or a loud failure. */
function settledOnly(r: { settled: unknown[][] }): unknown[] {
  expect(r.settled).toHaveLength(1);
  const args = r.settled[0];
  if (args === undefined) throw new Error("no settle call was recorded");
  return args;
}

/** A tool that carries RunCommand's argv branch, so the call takes the Exec identity. */
function execTool(run: CodingTool["run"]): CodingTool {
  return {
    name: "RunCommand",
    description: "RunCommand",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [], argvField: "argv" },
    run,
  };
}

/** A Bash-shaped tool whose run never spawns; the test is hermetic. */
function bashTool(): CodingTool {
  return {
    name: "Bash",
    description: "Bash",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [], commandField: "command" },
    run: async () => ({ content: "hi" }),
  };
}

const UNAVAILABLE = { status: "unavailable" as const, error: "test" };

describe("runtime.callTool — executed argv reaches the command shadow (US-003)", () => {
  test("AC7: an Exec tool's audit.executed and audit.cwd are settle's third argument", async () => {
    const r = recorder();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root),
      extraTools: [
        execTool(async () => ({
          content: "exit 0",
          audit: { executed: ["bun", "test", "--no-scripts"], cwd: "/repo/packages/app" },
        })),
      ],
      commandShadow: r.shadow,
    });
    const outcome = await rt.callTool("RunCommand", { argv: ["bun", "test"] });
    expect(outcome.kind).toBe("ok");
    const args = settledOnly(r);
    expect(args[0]).toBe(r.observed[0]?.[0]);
    expect(args[1]).toEqual({ ledger: "ok" });
    expect(args[2]).toEqual({ executed: ["bun", "test", "--no-scripts"], cwd: "/repo/packages/app" });
  });

  test("audit.cwd reaches the shadow only: the tool-audit ledger row has no cwd key", async () => {
    const recorded: ToolCallRecord[] = [];
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root),
      sink: { record: (entry: ToolCallRecord) => void recorded.push(entry), flush: async () => {} },
      extraTools: [execTool(async () => ({ content: "exit 0", audit: { executed: ["bun", "test"], cwd: "/repo" } }))],
      commandShadow: recorder().shadow,
    });
    await rt.callTool("RunCommand", { argv: ["bun", "test"] });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.executed).toEqual(["bun", "test"]);
    expect("cwd" in (recorded[0] ?? {})).toBe(false);
  });

  test("an Exec audit with no cwd settles with the executed argv alone", async () => {
    const r = recorder();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root),
      extraTools: [execTool(async () => ({ content: "exit 0", audit: { executed: ["bun", "test"] } }))],
      commandShadow: r.shadow,
    });
    await rt.callTool("RunCommand", { argv: ["bun", "test"] });
    expect(settledOnly(r)[2]).toStrictEqual({ executed: ["bun", "test"] });
  });

  test("a Bash call is observed with the policy root, the directory Bash runs in, as its cwd", async () => {
    const r = recorder();
    const policy = compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { bashApproval: "raw" });
    const rt = createCodingToolRuntime({ policy, extraTools: [bashTool()], commandShadow: r.shadow });
    await rt.callTool("Bash", { command: "echo hi" });
    expect(r.observed[0]?.[1].cwd).toBe(policy.root);
  });

  test("AC8: an Exec call denied by policy settles with no third argument", async () => {
    const r = recorder();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["bun *"] }], root),
      extraTools: [execTool(async () => ({ content: "unreachable" }))],
      commandShadow: r.shadow,
    });
    const outcome = await rt.callTool("RunCommand", { argv: ["git", "status"] });
    expect(outcome.kind).toBe("denied");
    const args = settledOnly(r);
    expect(args[1]).toEqual({ ledger: "denied" });
    expect(args).toHaveLength(2);
  });

  test('AC9: a raw Bash call settles with exactly [key, { ledger: "ok" }]', async () => {
    const r = recorder();
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { bashApproval: "raw" }),
      extraTools: [bashTool()],
      commandShadow: r.shadow,
    });
    const outcome = await rt.callTool("Bash", { command: "echo hi" });
    expect(outcome.kind).toBe("ok");
    const args = settledOnly(r);
    expect(args[1]).toEqual({ ledger: "ok" });
    expect(args).toHaveLength(2);
  });

  test("AC10: an Exec denied with denied:ask writes a row with no executed key", async () => {
    const s = createCommandShadow({ classify: async () => UNAVAILABLE, write, runId: "r", timeoutMs: 3000 });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root, {
        askRules: [{ tool: "Exec", patterns: ["*"] }],
      }),
      askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "human", latencyMs: 0 }) },
      extraTools: [execTool(async () => ({ content: "exit 0", audit: { executed: ["bun", "test"] } }))],
      commandShadow: s,
    });
    const outcome = await rt.callTool("RunCommand", { argv: ["bun", "test"] });
    expect(outcome.kind).toBe("denied");
    await s.drain();
    const row = writtenRow();
    expect(row.outcome.ledger).toBe("denied:ask");
    expect("executed" in row).toBe(false);
  });

  test("AC11: an Exec launch error writes a row with no executed key", async () => {
    const s = createCommandShadow({ classify: async () => UNAVAILABLE, write, runId: "r", timeoutMs: 3000 });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root),
      extraTools: [
        execTool(async () => {
          throw new Error("spawn ENOENT");
        }),
      ],
      commandShadow: s,
    });
    const outcome = await rt.callTool("RunCommand", { argv: ["bun", "test"] });
    expect(outcome.kind).toBe("error");
    await s.drain();
    const row = writtenRow();
    expect(row.outcome.ledger).toBe("error");
    expect("executed" in row).toBe(false);
  });

  test("AC12: a shadow whose settle throws never changes the tool outcome", async () => {
    const boom: CommandShadow = {
      observe: () => {},
      settle: () => {
        throw new Error("settle boom");
      },
      drain: async () => {},
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { bashApproval: "raw" }),
      extraTools: [bashTool()],
      commandShadow: boom,
    });
    const outcome = await rt.callTool("Bash", { command: "echo hi" });
    expect(outcome.kind).toBe("ok");
  });
});
