import { describe, expect, test } from "bun:test";
import type { SandboxState } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import {
  type FooterHint,
  type FooterJob,
  type FooterTask,
  footerModel,
  formatJobStrip,
  IDLE_STATUS,
  type TurnStatus,
} from "@/tui/chat/chat-status";
import { type FooterRole, type FooterSegment, footerSegments } from "@/tui/chat/footer-segments";
import { plainText } from "@/tui/chat/styled-line";

const MODEL = "opencode-go/deepseek-v4.1-flash";
const COST_USD = 0.42;
const SESSION_ID = "abcdefgh-1234";
/** The separator the fitted footer joins segments with. */
const SEPARATOR = " · ";

const AVAILABLE: SandboxState = { kind: "available", backend: "srt", network: "open" };
const UNAVAILABLE: SandboxState = { kind: "unavailable", backend: "srt", reason: "no bwrap" };

const PLAN_JOB: FooterJob = { kind: "plan", target: "f1" };
const RUN_JOB: FooterJob = { kind: "run", target: "feat", progress: { passed: 1, total: 3 } };

/** The story's fixture: guarded, `opencode-go/deepseek-v4.1-flash`, $0.42, sandbox available. */
function chatState(overrides: Partial<ChatHostState> = {}): ChatHostState {
  return {
    sessionId: SESSION_ID,
    mode: "guarded",
    model: MODEL,
    sandbox: AVAILABLE,
    meta: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      cwd: "/repo",
      mode: "ask",
      model: MODEL,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: COST_USD,
    },
    ...overrides,
  };
}

interface SegmentOptions {
  readonly state?: Partial<ChatHostState>;
  readonly status?: TurnStatus;
  readonly hint?: FooterHint;
  readonly jobs?: readonly FooterJob[];
  readonly tasks?: readonly FooterTask[];
}

/** The one input both `footerModel` and `footerSegments` take, so a case can compare them. */
function footerInput(options: SegmentOptions = {}): Parameters<typeof footerModel>[0] {
  return {
    state: chatState(options.state),
    status: options.status ?? IDLE_STATUS,
    hint: options.hint ?? "busy",
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
  };
}

function segmentsOf(options: SegmentOptions = {}) {
  return footerSegments(footerInput(options));
}

function rolesOf(side: readonly FooterSegment[]): FooterRole[] {
  return side.map((segment) => segment.role);
}

function textOf(side: readonly FooterSegment[]): string {
  return side.map((segment) => segment.span.text).join(SEPARATOR);
}

function roleSegment(side: readonly FooterSegment[], role: FooterRole): FooterSegment | undefined {
  return side.find((segment) => segment.role === role);
}

describe("footerSegments left", () => {
  test("AC-1 tags the mode and the hint's gesture for the busy hint", () => {
    expect(rolesOf(segmentsOf({ hint: "busy" }).left)).toEqual(["mode", "gesture"]);
  });

  test("AC-4 splits the idle hint into the / commands gesture and its shift+tab cycle extra", () => {
    const { left } = segmentsOf({ hint: "idle" });
    expect(rolesOf(left)).toEqual(["mode", "gesture", "gestureExtra"]);
    expect(left[1]?.span.text).toBe("/ commands");
    expect(left[2]?.span.text).toBe("shift+tab to cycle");
  });

  test("AC-5 splits the background hint's gesture from its ctrl+b extra", () => {
    const { left } = segmentsOf({ hint: "background" });
    expect(rolesOf(left)).toEqual(["mode", "gesture", "gestureExtra"]);
    expect(left[1]?.span.text).toBe("esc to interrupt");
    expect(left[2]?.span.text).toBe("ctrl+b to background");
  });

  test("AC-6 carries the tmux keybinding as the extra alone", () => {
    const extra = roleSegment(segmentsOf({ hint: "backgroundTmux" }).left, "gestureExtra");
    expect(extra?.span.text).toBe("ctrl+b ctrl+b to background");
  });

  test("AC-7 ends with a warning sandbox segment when the sandbox is unavailable", () => {
    const { left } = segmentsOf({ state: { sandbox: UNAVAILABLE } });
    const last = left[left.length - 1];
    expect(last?.role).toBe("sandbox");
    expect(last?.span).toEqual({ text: "sandbox unavailable", color: "warning" });
  });

  test("AC-7 keeps `sandbox off` as the last segment when no sandbox is reported", () => {
    const { left } = segmentsOf({ state: { sandbox: undefined } });
    expect(left[left.length - 1]?.span).toEqual({ text: "sandbox off", color: "muted" });
  });

  test("AC-11 makes a pending quit the left side's one warning gesture", () => {
    const { left } = segmentsOf({ hint: "quit" });
    expect(rolesOf(left)).toEqual(["gesture"]);
    expect(left[0]?.span).toEqual({ text: "press ctrl-c again to quit", color: "warning" });
  });

  test("keeps one gesture-only segment for the copied hint's own text", () => {
    const { left } = segmentsOf({ hint: "copied" });
    expect(rolesOf(left)).toEqual(["mode", "gesture"]);
    expect(left[1]?.span.text).toBe("copied 0 chars");
  });

  test("keeps the esc layer's hint as the gesture", () => {
    const { left } = footerSegments({
      ...footerInput({ hint: "layer" }),
      layerHint: "esc to close jobs",
    });
    expect(left[1]?.span.text).toBe("esc to close jobs");
  });
});

describe("footerSegments right", () => {
  test("AC-2 tags the model and the cost for a footer with no strip and no context", () => {
    expect(rolesOf(segmentsOf({ hint: "busy" }).right)).toEqual(["model", "cost"]);
  });

  test("AC-3 gives the cost segment the bare $0.42, never a leading separator", () => {
    const cost = roleSegment(segmentsOf().right, "cost");
    expect(cost?.span.text).toBe("$0.42");
    expect(cost?.span.text.startsWith(SEPARATOR)).toBe(false);
  });

  test("AC-8 begins with the job strip the footer already formats", () => {
    const jobs = [RUN_JOB];
    const { right } = segmentsOf({ jobs });
    expect(right[0]?.role).toBe("strip");
    expect(right[0]?.span.text).toBe(formatJobStrip(jobs, []));
  });

  test("AC-9 begins with the task strip when only background tasks run", () => {
    const tasks = [{ command: "bun test" }];
    const { right } = segmentsOf({ tasks });
    expect(right[0]?.role).toBe("strip");
    expect(right[0]?.span.text).toBe(formatJobStrip([], tasks));
  });

  test("AC-10 places the context segment between the model and the cost", () => {
    const { right } = segmentsOf({ status: { ...IDLE_STATUS, contextTokens: 1200 } });
    expect(rolesOf(right)).toEqual(["model", "context", "cost"]);
    expect(right[1]?.span.text).toBe("1.2k ctx");
  });

  test("AC-12 keeps the model and cost of a pending quit", () => {
    expect(rolesOf(segmentsOf({ hint: "quit" }).right)).toEqual(["model", "cost"]);
  });

  test("carries the short model name and the strip before it", () => {
    const { right } = segmentsOf({ jobs: [PLAN_JOB] });
    expect(rolesOf(right)).toEqual(["strip", "model", "cost"]);
    expect(right[1]?.span.text).toBe("deepseek-v4.1-flash");
  });
});

const COMPAT_SANDBOXES: ReadonlyArray<readonly [string, SandboxState | undefined]> = [
  ["available", AVAILABLE],
  ["unavailable", UNAVAILABLE],
  ["absent", undefined],
];

const COMPAT_JOBS: ReadonlyArray<readonly [string, readonly FooterJob[]]> = [
  ["no jobs", []],
  ["one job", [PLAN_JOB]],
];

const COMPAT_HINTS: readonly FooterHint[] = ["busy", "expanded", "clear", "quit"];

const COMPAT_CASES = COMPAT_HINTS.flatMap((hint) =>
  COMPAT_SANDBOXES.flatMap(([sandboxName, sandbox]) =>
    COMPAT_JOBS.map(([jobsName, jobs]) => ({ hint, sandboxName, sandbox, jobsName, jobs })),
  ),
);

describe("footerModel over the segments", () => {
  test.each(COMPAT_CASES)("AC-13 joins the right side for $hint, sandbox $sandboxName, $jobsName", (testCase) => {
    const input = footerInput({ hint: testCase.hint, state: { sandbox: testCase.sandbox }, jobs: testCase.jobs });
    expect(plainText(footerModel(input).right)).toBe(textOf(footerSegments(input).right));
  });

  test("AC-14 keeps the unfitted idle footer's spans and omits the / commands gesture", () => {
    expect(footerModel(footerInput({ hint: "idle" }))).toEqual({
      left: [
        { text: "⏵ guarded", color: "muted" },
        { text: SEPARATOR, color: "muted" },
        { text: "shift+tab to cycle", color: "muted" },
      ],
      right: [{ text: "deepseek-v4.1-flash" }, { text: `${SEPARATOR}$0.42`, color: "muted" }],
      stripWidth: 0,
    });
  });

  test("AC-13 holds with a context meter between the model and the cost", () => {
    const input = footerInput({
      state: { contextWindow: 200_000 },
      status: { ...IDLE_STATUS, contextTokens: 36_000 },
    });
    expect(plainText(footerModel(input).right)).toBe(textOf(footerSegments(input).right));
  });

  test("AC-13 holds for every segment-bearing input without a separator of its own", () => {
    for (const testCase of COMPAT_CASES) {
      const input = footerInput({ hint: testCase.hint, state: { sandbox: testCase.sandbox }, jobs: testCase.jobs });
      for (const segment of [...footerSegments(input).left, ...footerSegments(input).right]) {
        expect({ role: segment.role, text: segment.span.text }).toEqual({
          role: segment.role,
          text: segment.span.text.startsWith(SEPARATOR) ? segment.span.text.slice(SEPARATOR.length) : segment.span.text,
        });
      }
    }
  });
});
