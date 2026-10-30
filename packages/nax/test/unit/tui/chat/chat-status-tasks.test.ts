import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { type FooterJob, footerModel, formatJobStrip, IDLE_STATUS } from "@/tui/chat/chat-status";
import { displayWidth } from "@/tui/chat/styled-line";

const NINE_WIDE = "界".repeat(9);

function chatState(): ChatHostState {
  return {
    sessionId: "abcdefgh-1234",
    mode: "guarded",
    model: "anthropic/m1",
    meta: {
      schemaVersion: 1,
      sessionId: "abcdefgh-1234",
      cwd: "/repo",
      mode: "ask",
      model: "anthropic/m1",
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
  };
}

const BASE = { state: chatState(), status: IDLE_STATUS, hint: "idle" as const };
const PLAN: FooterJob = { kind: "plan", target: "f1" };

describe("formatJobStrip with background tasks", () => {
  test.each<{ ac: string; jobs: FooterJob[]; commands: string[]; expected: string }>([
    { ac: "AC-1", jobs: [], commands: ["bun run test"], expected: "bash bun run test" },
    { ac: "AC-2", jobs: [PLAN], commands: ["ls"], expected: "plan f1 · bash ls" },
    {
      ac: "AC-3",
      jobs: [PLAN, { kind: "plan", target: "f2" }],
      commands: ["ls"],
      expected: "plan f1 · plan f2 +1",
    },
    { ac: "overflow among tasks", jobs: [PLAN], commands: ["a", "b", "c"], expected: "plan f1 · bash a +2" },
    { ac: "AC-4", jobs: [], commands: ["a-very-long-command-line"], expected: "bash a-very-long-com…" },
    {
      ac: "exactly 16 columns stays whole",
      jobs: [],
      commands: ["0123456789abcdef"],
      expected: "bash 0123456789abcdef",
    },
    { ac: "AC-5", jobs: [], commands: [NINE_WIDE], expected: `bash ${"界".repeat(7)}…` },
    { ac: "AC-6", jobs: [], commands: ["echo a\nls"], expected: "bash echo a ls" },
    { ac: "AC-6 crlf", jobs: [], commands: ["a\r\nb"], expected: "bash a b" },
  ])("$ac", ({ jobs, commands, expected }) => {
    expect(
      formatJobStrip(
        jobs,
        commands.map((command) => ({ command })),
      ),
    ).toBe(expected);
  });

  test("keeps the strip of jobs alone unchanged without tasks", () => {
    expect(formatJobStrip([PLAN])).toBe("plan f1");
    expect(formatJobStrip([])).toBe("");
  });
});

describe("footerModel tasks and stripWidth", () => {
  test("AC-7 draws the task strip first on the right", () => {
    expect(footerModel({ ...BASE, tasks: [{ command: "ls" }] }).right[0]?.text).toBe("bash ls");
  });

  test("AC-8 measures the task strip", () => {
    expect(footerModel({ ...BASE, tasks: [{ command: "ls" }] }).stripWidth).toBe(displayWidth("bash ls"));
  });

  test("AC-8 measures a wide task command in display columns", () => {
    const model = footerModel({ ...BASE, tasks: [{ command: NINE_WIDE }] });
    expect(model.stripWidth).toBe(displayWidth(`bash ${"界".repeat(7)}…`));
    expect(model.stripWidth).toBe(5 + 14 + 1);
  });

  test("AC-9 is zero with neither jobs nor tasks", () => {
    expect(footerModel(BASE).stripWidth).toBe(0);
    expect(footerModel({ ...BASE, jobs: [], tasks: [] }).stripWidth).toBe(0);
  });

  test("AC-10 keeps the right spans of a call without tasks", () => {
    expect(footerModel({ ...BASE, tasks: [] }).right).toEqual(footerModel(BASE).right);
  });

  test("AC-11 measures a job strip without tasks", () => {
    expect(footerModel({ ...BASE, jobs: [PLAN] }).stripWidth).toBe(7);
  });

  test("measures the combined strip only, not the separator", () => {
    const model = footerModel({ ...BASE, jobs: [PLAN], tasks: [{ command: "ls" }] });
    expect(model.stripWidth).toBe(displayWidth("plan f1 · bash ls"));
    expect(model.right[0]?.text).toBe("plan f1 · bash ls");
  });
});
