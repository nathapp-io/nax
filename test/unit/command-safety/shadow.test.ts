import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDENTIFIER_KEYS } from "@test/helpers";
import {
  _commandShadowDeps,
  type Classify,
  type CommandSafetyRow,
  createCommandShadow,
  type ModelResult,
  type Observation,
  QUESTION_SET_VERSION,
  shadowCacheKey,
} from "@/command-safety";

// Typed literals, not casts: the test ratchets count every cast in test/.
const ANSWERED: ModelResult = {
  status: "answered",
  answers: {
    harm: {
      none: 0.9,
      deletes_data: 0.01,
      discards_work: 0.01,
      outside_project: 0.01,
      system_change: 0.01,
      network_send: 0.01,
      privilege: 0.01,
    },
    noul: {
      deletes_data: 0.1,
      discards_work: 0.1,
      outside_project: 0.1,
      system_change: 0.1,
      network_send: 0.1,
      privilege: 0.1,
    },
  },
  model: "m",
  latencyMs: 7,
};

const obs = (command: string, extra: Partial<Observation> = {}): Observation => ({
  command,
  identity: "Bash",
  stage: "run",
  storyId: "US-001",
  mechanical: { verdict: "allow", breach: false },
  ...extra,
});

/** A classify whose answers the test releases by hand. */
function manualClassify() {
  const calls: string[] = [];
  const pending = new Map<string, (r: ModelResult) => void>();
  const classify: Classify = (command) => {
    calls.push(command);
    return new Promise((resolve) => pending.set(`${command}#${calls.length}`, resolve));
  };
  const answer = (command: string, nth: number, r: ModelResult) => pending.get(`${command}#${nth}`)?.(r);
  return { classify, calls, answer };
}

let rows: CommandSafetyRow[];
const write = async (r: CommandSafetyRow) => {
  rows.push(r);
};
const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => new Promise<void>((r) => queueMicrotask(r)));

/** The single row the shadow wrote, or a loud failure. */
function writtenRow(): CommandSafetyRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("no row was written");
  return row;
}

let origDeps: typeof _commandShadowDeps;
let fireTimer: () => void;
let cancelled: number;
beforeEach(() => {
  rows = [];
  origDeps = { ..._commandShadowDeps };
  cancelled = 0;
  _commandShadowDeps.timer = () => {
    let fire = () => {};
    const done = new Promise<void>((resolve) => {
      fire = resolve;
    });
    fireTimer = fire;
    return { done, cancel: () => void cancelled++ };
  };
  _commandShadowDeps.now = () => "2026-09-23T00:00:00.000Z";
});
afterEach(() => {
  Object.assign(_commandShadowDeps, origDeps);
});

describe("createCommandShadow", () => {
  test("observe -> settle -> answer writes one complete row", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "run-1", timeoutMs: 3000 });
    s.observe("k1", obs("git clean -fdx"));
    s.settle("k1", { ledger: "ok" });
    expect(rows).toHaveLength(0);
    m.answer("git clean -fdx", 1, ANSWERED);
    await flush();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.runId).toBe("run-1");
    expect(r?.storyId).toBe("US-001");
    expect(r?.outcome).toEqual({ ledger: "ok" });
    expect(r?.rules.hits.discards_work).toBe(true);
    expect(r?.model.status).toBe("answered");
    expect(r?.model.questionSetVersion).toBe(QUESTION_SET_VERSION);
    expect(r?.model.latencyMs).toBe(7);
  });

  test("answer before settle: the row is written at settle, carrying decidedBy", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("rm x"));
    m.answer("rm x", 1, ANSWERED);
    await flush();
    expect(rows).toHaveLength(0);
    s.settle("k", { ledger: "denied:ask", decidedBy: "human" });
    await flush();
    expect(rows[0]?.outcome).toEqual({ ledger: "denied:ask", decidedBy: "human" });
  });

  test("settle is exactly-once; an unknown key is ignored", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.settle("nope", { ledger: "ok" });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    s.settle("k", { ledger: "error" });
    m.answer("ls", 1, ANSWERED);
    await flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome.ledger).toBe("ok");
  });

  test("identical command in flight: one classify, two rows, the second cached (Review Focus 5)", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("a", obs("bun run test"));
    s.observe("b", obs("bun run test"));
    s.settle("a", { ledger: "ok" });
    s.settle("b", { ledger: "ok" });
    m.answer("bun run test", 1, ANSWERED);
    await flush();
    expect(m.calls).toEqual(["bun run test"]);
    expect(rows.map((r) => r.model.status).sort((a, b) => a.localeCompare(b))).toEqual(["answered", "cached"]);
    expect(rows.find((r) => r.model.status === "cached")?.model.answers).toEqual(
      ANSWERED.status === "answered" ? ANSWERED.answers : undefined,
    );
  });

  test("an unavailable result is not cached: the next identical command classifies again", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("a", obs("ls"));
    m.answer("ls", 1, { status: "unavailable", error: "network" });
    await flush();
    s.observe("b", obs("ls"));
    expect(m.calls).toEqual(["ls", "ls"]);
  });

  test("the cache key carries the question-set version", () => {
    expect(shadowCacheKey("ls")).toContain(String(QUESTION_SET_VERSION));
    expect(shadowCacheKey("ls")).not.toBe(shadowCacheKey("ls "));
  });

  test("a classify that throws synchronously or rejects -> model unavailable, rules still present", async () => {
    const s1 = createCommandShadow({
      classify: () => {
        throw new Error("boom");
      },
      write,
      runId: "r",
      timeoutMs: 3000,
    });
    const s2 = createCommandShadow({
      classify: () => Promise.reject(new Error("boom")),
      write,
      runId: "r",
      timeoutMs: 3000,
    });
    expect(() => s1.observe("a", obs("git reset --hard"))).not.toThrow();
    s2.observe("b", obs("git reset --hard"));
    s1.settle("a", { ledger: "ok" });
    s2.settle("b", { ledger: "ok" });
    await flush();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.model).toEqual({ status: "unavailable", questionSetVersion: 1, error: "threw" });
      expect(r.rules.hits.discards_work).toBe(true);
    }
  });

  test("drain: a hanging classify is written as unavailable/drained once the timer fires", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    const drained = s.drain();
    fireTimer();
    await drained;
    expect(rows[0]?.model).toEqual({ status: "unavailable", questionSetVersion: 1, error: "drained" });
    expect(rows[0]?.outcome.ledger).toBe("ok");
  });

  test("drain: an observation never settled is written as unsettled (Review Focus 1)", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    m.answer("ls", 1, ANSWERED);
    await flush();
    await s.drain();
    expect(rows[0]?.outcome).toEqual({ ledger: "unsettled" });
    expect(rows[0]?.model.status).toBe("answered");
  });

  test("drain cancels its timer when pending work finishes first", async () => {
    const m = manualClassify();
    const s = createCommandShadow({ classify: m.classify, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    const drained = s.drain();
    m.answer("ls", 1, ANSWERED);
    await drained;
    expect(cancelled).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("a failing write reports through onWriteError and never throws", async () => {
    const errors: unknown[] = [];
    const s = createCommandShadow({
      classify: async () => ANSWERED,
      write: () => Promise.reject(new Error("disk full")),
      runId: "r",
      timeoutMs: 3000,
      onWriteError: (e) => errors.push(e),
    });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    expect(errors).toHaveLength(1);
  });

  test("Exec observations keep argv verbatim", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("git status --short", { identity: "Exec", argv: ["git", "status", "--short"] }));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    expect(rows[0]?.identity).toBe("Exec");
    expect(rows[0]?.argv).toEqual(["git", "status", "--short"]);
  });

  test("US-001 AC4: the written row carries all five identifiers from the Observation", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls", { callId: "c1", scopeId: "s1", turnId: "t1", roundTrips: 2, toolCallId: "tc1" }));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    expect(writtenRow()).toMatchObject({
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 2,
      toolCallId: "tc1",
    });
  });

  test("US-001 AC5: a row from an Observation with no identifiers has none of the five keys", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    const row = writtenRow();
    for (const key of IDENTIFIER_KEYS) expect(key in row).toBe(false);
  });

  test("US-001 AC9: an undefined identifier source is omitted, never stored as undefined", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls", { callId: "c1", roundTrips: 0 }));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    const row = writtenRow();
    expect(row.callId).toBe("c1");
    expect(row.roundTrips).toBe(0);
    for (const key of ["scopeId", "turnId", "toolCallId"] as const) expect(key in row).toBe(false);
  });

  test("US-003 AC3: an executed argv is written alongside the unchanged argv and command", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("bun test", { identity: "Exec", argv: ["bun", "test"] }));
    s.settle("k", { ledger: "ok" }, { executed: ["bun", "test", "--no-scripts"] });
    await s.drain();
    const row = writtenRow();
    expect(row.executed).toEqual(["bun", "test", "--no-scripts"]);
    expect(row.argv).toEqual(["bun", "test"]);
    expect(row.command).toBe("bun test");
  });

  test("US-003 AC4: the classified text is the model argv, never the executed argv", async () => {
    const calls: string[] = [];
    const s = createCommandShadow({
      classify: (command) => {
        calls.push(command);
        return Promise.resolve(ANSWERED);
      },
      write,
      runId: "r",
      timeoutMs: 3000,
    });
    s.observe("k", obs("bun test", { identity: "Exec", argv: ["bun", "test"] }));
    s.settle("k", { ledger: "ok" }, { executed: ["bun", "test", "--no-scripts"] });
    await s.drain();
    expect(calls).toEqual(["bun test"]);
  });

  test("US-003 AC5: a row settled with no third argument has no executed key", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    expect("executed" in writtenRow()).toBe(false);
  });

  test("US-003 AC6: a row drained as unsettled has no executed key", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    await s.drain();
    const row = writtenRow();
    expect(row.outcome.ledger).toBe("unsettled");
    expect("executed" in row).toBe(false);
  });
});

describe("createCommandShadow: cwd on the row", () => {
  let rows: CommandSafetyRow[];
  const write = async (row: CommandSafetyRow) => {
    rows.push(row);
  };
  beforeEach(() => {
    rows = [];
  });

  test("a Bash row carries the observed cwd", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls ../x", { cwd: "/repo" }));
    s.settle("k", { ledger: "ok" });
    await s.drain();
    expect(rows[0]?.cwd).toBe("/repo");
  });

  test("an Exec row carries the cwd it ran in, from settle", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("bun test", { identity: "Exec", argv: ["bun", "test"] }));
    s.settle("k", { ledger: "ok" }, { executed: ["bun", "test"], cwd: "/repo/packages/app" });
    await s.drain();
    expect(rows[0]?.cwd).toBe("/repo/packages/app");
    expect(rows[0]?.executed).toEqual(["bun", "test"]);
  });

  test("a row with no cwd from either side has no cwd key", async () => {
    const s = createCommandShadow({ classify: async () => ANSWERED, write, runId: "r", timeoutMs: 3000 });
    s.observe("k", obs("ls"));
    await s.drain();
    expect("cwd" in (rows[0] ?? {})).toBe(false);
  });

  test("cwd never reaches the model: classify gets the command alone and the cache key ignores cwd", async () => {
    const calls: string[] = [];
    const s = createCommandShadow({
      classify: (command) => {
        calls.push(command);
        return Promise.resolve(ANSWERED);
      },
      write,
      runId: "r",
      timeoutMs: 3000,
    });
    s.observe("a", obs("ls", { cwd: "/one" }));
    s.observe("b", obs("ls", { cwd: "/two" }));
    s.settle("a", { ledger: "ok" });
    s.settle("b", { ledger: "ok" });
    await s.drain();
    expect(calls).toEqual(["ls"]);
  });
});
