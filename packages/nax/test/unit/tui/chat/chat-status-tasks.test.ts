import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { type FooterJob, footerModel, formatJobStrip, IDLE_STATUS } from "@/tui/chat/chat-status";
import { displayWidth } from "@/tui/chat/styled-line";

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
/** Three single-letter run targets: the shortest jobs that overflow JOB_STRIP_LIMIT. */
const RUNS_ABC: readonly FooterJob[] = [
  { kind: "run", target: "a" },
  { kind: "run", target: "b" },
  { kind: "run", target: "c" },
];
const shells = (...commands: string[]) => commands.map((command) => ({ command }));

describe("formatJobStrip with background tasks", () => {
  test("AC-1 counts one running task as one shell", () => {
    expect(formatJobStrip([], shells("bun run test"))).toBe("1 shell");
  });

  test("AC-2 draws the one job it shows, then the shells behind it", () => {
    expect(formatJobStrip([PLAN], shells("a", "b", "c"))).toBe("plan f1 · 3 shells");
  });

  test("AC-3 counts the hidden jobs after the two it draws, then the shells", () => {
    expect(formatJobStrip(RUNS_ABC, shells("sleep 60"))).toBe("run a · run b +1 · 1 shell");
  });

  test("AC-4 leaves the strip of jobs alone when no task runs", () => {
    expect(formatJobStrip([PLAN])).toBe("plan f1");
  });

  test("counts two shells as a plural part", () => {
    expect(formatJobStrip([], shells("a", "b"))).toBe("2 shells");
  });

  test("appends the hidden-job count to the last drawn job when no task runs", () => {
    expect(formatJobStrip([PLAN, { kind: "plan", target: "f2" }, { kind: "plan", target: "f3" }])).toBe(
      "plan f1 · plan f2 +1",
    );
  });

  test("draws no strip at all with neither jobs nor tasks", () => {
    expect(formatJobStrip([])).toBe("");
    expect(formatJobStrip([], [])).toBe("");
  });
});

describe("footerModel tasks and stripWidth", () => {
  test("AC-5 measures the one shell part it draws", () => {
    const model = footerModel({ ...BASE, tasks: shells("bun run test") });
    expect(model.stripWidth).toBe(displayWidth("1 shell"));
  });

  test("AC-6 draws the shell count first on the right, never the command", () => {
    const model = footerModel({ ...BASE, tasks: shells("ls") });
    expect(model.right[0]?.text).toBe("1 shell");
    expect(JSON.stringify(model.right)).not.toContain("bash");
  });

  test("counts every running shell in one part", () => {
    const model = footerModel({ ...BASE, tasks: shells("a", "b", "c") });
    expect(model.right[0]?.text).toBe("3 shells");
    expect(model.stripWidth).toBe(displayWidth("3 shells"));
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
    const model = footerModel({ ...BASE, jobs: [PLAN], tasks: shells("ls") });
    expect(model.stripWidth).toBe(displayWidth("plan f1 · 1 shell"));
    expect(model.right[0]?.text).toBe("plan f1 · 1 shell");
  });
});
