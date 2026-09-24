import { describe, expect, test } from "bun:test";
import { IDENTIFIER_KEYS, makeCommandShadowRecorder, observedOnly } from "@test/helpers";
import {
  type CommandShadow,
  type FinalOutcome,
  type MechanicalVerdict,
  type Observation,
  openShadowTap,
  type ShadowCall,
  toMechanical,
} from "@/command-safety";

/**
 * Like `recorder`, but keeps every argument each `settle` call received, so a
 * test can assert the ARITY: a Bash row is settled with two arguments, an Exec
 * row with three.
 */
function arityRecorder() {
  const observed: [string, Observation][] = [];
  const settled: unknown[][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (...args: [string, FinalOutcome, (readonly string[] | undefined)?]) => void settled.push(args),
    drain: async () => {},
  };
  return { shadow, observed, settled };
}

const allow = { allowed: true };

describe("openShadowTap", () => {
  test("US-001 AC1: a Bash call's five call identifiers reach the Observation", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "rm -rf x",
      argv: undefined,
      verdict: allow,
      stage: "run",
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 2,
      toolCallId: "tc1",
    });
    expect(observedOnly(r)).toMatchObject({
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 2,
      toolCallId: "tc1",
    });
  });

  test("US-001 AC2: an Exec call's five call identifiers reach the Observation", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Exec",
      command: undefined,
      argv: ["git", "status"],
      verdict: allow,
      stage: "run",
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 2,
      toolCallId: "tc1",
    });
    expect(observedOnly(r)).toMatchObject({
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 2,
      toolCallId: "tc1",
    });
  });

  test("US-001 AC3: a Bash call with no identifiers yields an Observation with none of the five keys", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "ls",
      argv: undefined,
      verdict: allow,
      stage: "run",
    });
    const observed = observedOnly(r);
    for (const key of IDENTIFIER_KEYS) expect(key in observed).toBe(false);
  });

  test("US-001 AC9: only the identifier sources that are defined reach the Observation", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "ls",
      argv: undefined,
      verdict: allow,
      stage: "run",
      callId: "c1",
      roundTrips: 0,
    });
    const observed = observedOnly(r);
    expect(observed.callId).toBe("c1");
    expect(observed.roundTrips).toBe(0);
    for (const key of ["scopeId", "turnId", "toolCallId"] as const) expect(key in observed).toBe(false);
  });

  test("no shadow -> no-op tap", () => {
    expect(() =>
      openShadowTap(undefined, {
        key: "k",
        identity: "Bash",
        command: "ls",
        argv: undefined,
        verdict: allow,
        stage: "run",
      }).settle("ok"),
    ).not.toThrow();
  });

  test("Bash with a string command is observed, then settled once", () => {
    const r = makeCommandShadowRecorder();
    const tap = openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "rm -rf x",
      argv: undefined,
      verdict: allow,
      stage: "run",
      storyId: "US-1",
    });
    tap.settle("ok");
    tap.settle("error");
    expect(r.observed).toEqual([
      [
        "k",
        {
          command: "rm -rf x",
          identity: "Bash",
          stage: "run",
          storyId: "US-1",
          mechanical: { verdict: "allow", breach: false },
        },
      ],
    ]);
    expect(r.settled).toEqual([["k", { ledger: "ok" }]]);
  });

  test("Exec with a string argv is observed with the joined command and argv verbatim", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Exec",
      command: undefined,
      argv: ["git", "status"],
      verdict: allow,
      stage: "run",
    });
    expect(r.observed[0]?.[1]).toMatchObject({ command: "git status", identity: "Exec", argv: ["git", "status"] });
  });

  test.each([
    ["a RunCommand verb call", { identity: "RunCommand", command: undefined, argv: undefined }],
    ["a Read call", { identity: "Read", command: undefined, argv: undefined }],
    ["Bash without a string command", { identity: "Bash", command: 42, argv: undefined }],
    ["Exec with a non-string argv entry", { identity: "Exec", command: undefined, argv: ["git", 1] }],
  ])("%s is not observed", (_label, call) => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, { key: "k", verdict: allow, stage: "run", ...call }).settle("ok");
    expect(r.observed).toHaveLength(0);
    expect(r.settled).toHaveLength(0);
  });

  test("settle carries decidedBy when present", () => {
    const r = makeCommandShadowRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "x",
      argv: undefined,
      verdict: allow,
      stage: "run",
    }).settle("denied:ask", "human");
    expect(r.settled[0]?.[1]).toEqual({ ledger: "denied:ask", decidedBy: "human" });
  });

  test("a throwing shadow never escapes the tap", () => {
    const boom: CommandShadow = {
      observe: () => {
        throw new Error("x");
      },
      settle: () => {
        throw new Error("y");
      },
      drain: async () => {},
    };
    const tap = openShadowTap(boom, {
      key: "k",
      identity: "Bash",
      command: "x",
      argv: undefined,
      verdict: allow,
      stage: "run",
    });
    expect(() => tap.settle("ok")).not.toThrow();
  });

  test("US-003 AC1: an Exec tap forwards executed as settle's third argument", () => {
    const r = arityRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Exec",
      command: undefined,
      argv: ["bun", "test"],
      verdict: allow,
      stage: "run",
    }).settle("ok", undefined, ["bun", "run", "--filter", "pkg", "test"]);
    expect(r.settled).toEqual([["k", { ledger: "ok" }, ["bun", "run", "--filter", "pkg", "test"]]]);
  });

  test("US-003 AC2: a Bash tap settles with exactly two arguments, dropping executed", () => {
    const r = arityRecorder();
    openShadowTap(r.shadow, {
      key: "k",
      identity: "Bash",
      command: "echo hi",
      argv: undefined,
      verdict: allow,
      stage: "run",
    }).settle("ok", undefined, ["/bin/sh", "-c", "echo hi"]);
    expect(r.settled).toEqual([["k", { ledger: "ok" }]]);
    expect(r.settled[0]?.length).toBe(2);
  });

  test("a throwing settle is caught inside the live tap", () => {
    const r = makeCommandShadowRecorder();
    const boomSettle: CommandShadow = {
      ...r.shadow,
      settle: () => {
        throw new Error("y");
      },
    };
    const tap = openShadowTap(boomSettle, {
      key: "k",
      identity: "Bash",
      command: "x",
      argv: undefined,
      verdict: allow,
      stage: "run",
    });
    expect(r.observed).toHaveLength(1);
    expect(() => tap.settle("ok")).not.toThrow();
  });
});

describe("toMechanical", () => {
  const cases: [ShadowCall["verdict"], MechanicalVerdict][] = [
    [{ allowed: true }, { verdict: "allow", breach: false }],
    [
      { allowed: false, outcome: "ask", breach: false, rule: "Bash(rm *)" },
      { verdict: "ask", breach: false, rule: "Bash(rm *)" },
    ],
    [
      { allowed: false, breach: true },
      { verdict: "deny", breach: true },
    ],
    [
      { allowed: false, outcome: "denied", breach: false },
      { verdict: "deny", breach: false },
    ],
  ];
  test.each(cases)("%j -> %j", (input, expected) => {
    expect(toMechanical(input)).toEqual(expected);
  });
});
