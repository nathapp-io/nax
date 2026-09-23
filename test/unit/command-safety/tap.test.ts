import { describe, expect, test } from "bun:test";
import {
  type CommandShadow,
  type FinalOutcome,
  type MechanicalVerdict,
  type Observation,
  openShadowTap,
  type ShadowCall,
  toMechanical,
} from "@/command-safety";

function recorder() {
  const observed: [string, Observation][] = [];
  const settled: [string, FinalOutcome][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (k, o) => void settled.push([k, o]),
    drain: async () => {},
  };
  return { shadow, observed, settled };
}

const allow = { allowed: true };

describe("openShadowTap", () => {
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
    const r = recorder();
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
    const r = recorder();
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
    const r = recorder();
    openShadowTap(r.shadow, { key: "k", verdict: allow, stage: "run", ...call }).settle("ok");
    expect(r.observed).toHaveLength(0);
    expect(r.settled).toHaveLength(0);
  });

  test("settle carries decidedBy when present", () => {
    const r = recorder();
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
