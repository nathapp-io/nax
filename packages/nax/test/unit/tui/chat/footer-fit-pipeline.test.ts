import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxState } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import { type FooterHint, type FooterJob, type FooterTask, IDLE_STATUS, type TurnStatus } from "@/tui/chat/chat-status";
import type { FooterSegment } from "@/tui/chat/footer-segments";
import { _statusLayoutDeps, fittedFooterModel } from "@/tui/chat/status-layout";
import { displayWidth, plainText } from "@/tui/chat/styled-line";

/**
 * The fitter's pipeline, observed through its one output: the sides it keeps and the columns
 * of job strip it reports. The story's fixture is guarded, `opencode-go/deepseek-v4.1-flash`,
 * $0.42, no jobs, no tasks, no context meter, Unicode glyphs and an idle turn status.
 */
const MODEL = "opencode-go/deepseek-v4.1-flash";
const COST_USD = 0.42;
const SESSION_ID = "fit-pipeline";
const AVAILABLE: SandboxState = { kind: "available", backend: "srt", network: "open" };
/** Two 20-character targets: wide enough that the drawn strip cannot fit beside the left side. */
const TARGET_A = "feat-0123456789abcde";
const TARGET_B = "feat-0123456789abcdf";
/** What the strip becomes once it is replaced whole by a count of what is running. */
const THREE_ACTIVE = "3 active (ctrl+g)";
/**
 * Segments whose texts say nothing about what they are: the fitter must drop them for their
 * role alone, so a case can hand it wording the footer never uses.
 */
const STUB_SEGMENTS: { readonly left: readonly FooterSegment[]; readonly right: readonly FooterSegment[] } = {
  left: [{ role: "gesture", span: { text: "KEEP" } }],
  right: [
    { role: "model", span: { text: "MODEL-TEXT" } },
    { role: "cost", span: { text: "COST-TEXT" } },
  ],
};

const originalFooterSegments = _statusLayoutDeps.footerSegments;
afterEach(() => {
  _statusLayoutDeps.footerSegments = originalFooterSegments;
});

/** The story's fixture state, with the fields a case cares about overridden. */
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

interface FitOptions {
  readonly width: number;
  readonly hint?: FooterHint;
  readonly state?: Partial<ChatHostState>;
  readonly status?: TurnStatus;
  readonly jobs?: readonly FooterJob[];
  readonly tasks?: readonly FooterTask[];
  readonly layerHint?: string;
}

/** The footer the fitter produces for one input, in the terms the criteria read it. */
function fitted(options: FitOptions) {
  const footer = fittedFooterModel({
    width: options.width,
    state: chatState(options.state),
    status: options.status ?? IDLE_STATUS,
    hint: options.hint ?? "busy",
    ...(options.layerHint === undefined ? {} : { layerHint: options.layerHint }),
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
  });
  return { footer, left: plainText(footer.left), right: plainText(footer.right) };
}

/** The colours the fitter drew on the left side, for the sandbox warning's own colour. */
function colorsOf(footer: { readonly left: readonly { readonly color?: string }[] }): readonly (string | undefined)[] {
  return footer.left.map((span) => span.color);
}

const ONE_JOB: readonly FooterJob[] = [{ kind: "run", target: "feat", progress: { passed: 1, total: 3 } }];
const THREE_JOBS: readonly FooterJob[] = [
  { kind: "run", target: TARGET_A },
  { kind: "run", target: TARGET_B },
  { kind: "run", target: "feat-third-run-job" },
];
const TWO_JOBS_AND_A_TASK: { readonly jobs: readonly FooterJob[]; readonly tasks: readonly FooterTask[] } = {
  jobs: [
    { kind: "run", target: TARGET_A },
    { kind: "run", target: TARGET_B },
  ],
  tasks: [{ command: "bun test" }],
};

describe("fittedFooterModel drops the right side first", () => {
  test("AC-1 at 40 columns the busy hint keeps the mode and the interrupt", () => {
    expect(fitted({ width: 40, hint: "busy" }).left).toBe("⏵ guarded · esc to interrupt");
  });

  test("AC-2 at 40 columns the busy hint keeps the cost once the model has gone", () => {
    expect(fitted({ width: 40, hint: "busy" }).right).toBe("$0.42");
  });

  test("AC-3 at 40 columns the background hint drops its extra keybinding before the gesture", () => {
    const footer = fitted({ width: 40, hint: "background" });
    expect({ left: footer.left, right: footer.right }).toEqual({
      left: "⏵ guarded · esc to interrupt",
      right: "$0.42",
    });
  });

  test("AC-4 at 60 columns the background hint keeps its extra keybinding", () => {
    expect(fitted({ width: 60, hint: "background" }).left).toBe("⏵ guarded · esc to interrupt · ctrl+b to background");
  });

  test("AC-5 at 40 columns the idle hint keeps / commands and drops shift+tab", () => {
    const footer = fitted({ width: 40, hint: "idle" });
    expect({ left: footer.left, right: footer.right }).toEqual({ left: "⏵ guarded · / commands", right: "$0.42" });
  });

  test("AC-6 at 60 columns one running job keeps its drawn strip beside the cost", () => {
    expect(fitted({ width: 60, jobs: ONE_JOB }).right).toBe("run feat 1/3 · $0.42");
  });

  test("AC-7 the strip the one job is drawn with reports its own display width", () => {
    expect(fitted({ width: 60, jobs: ONE_JOB }).footer.stripWidth).toBe(displayWidth("run feat 1/3"));
  });

  test("AC-8 at 60 columns two long jobs and a task become their count", () => {
    expect(fitted({ width: 60, ...TWO_JOBS_AND_A_TASK }).right).toBe(`${THREE_ACTIVE} · $0.42`);
  });

  test("AC-9 the counted strip reports the width of the count, not of the strip it replaced", () => {
    expect(fitted({ width: 60, ...TWO_JOBS_AND_A_TASK }).footer.stripWidth).toBe(displayWidth(THREE_ACTIVE));
  });

  test("AC-10 at 36 columns the counted strip goes too, and only the cost is left", () => {
    const footer = fitted({ width: 36, jobs: THREE_JOBS });
    expect({ stripWidth: footer.footer.stripWidth, right: footer.right }).toEqual({ stripWidth: 0, right: "$0.42" });
  });

  test("AC-11 at 45 columns the context meter is dropped before the cost", () => {
    const footer = fitted({ width: 45, status: { ...IDLE_STATUS, contextTokens: 1200 } });
    expect({ left: footer.left, right: footer.right }).toEqual({
      left: "⏵ guarded · esc to interrupt",
      right: "$0.42",
    });
  });
});

describe("fittedFooterModel drops the hint's extra last", () => {
  test("AC-12 at 30 columns the background hint shows no ctrl+b at all", () => {
    const footer = fitted({ width: 30, hint: "background" });
    expect(footer.left).not.toContain("ctrl+b");
    expect(footer.left).toContain("esc to interrupt");
  });

  test("AC-13 a layer hint's own text is kept where the idle hint's / commands would be", () => {
    const footer = fitted({ width: 40, hint: "layer", layerHint: "shift+tab to cycle" });
    expect(footer.left).toContain("shift+tab to cycle");
    expect(footer.left).not.toContain("/ commands");
  });

  test("AC-14 a pending quit is the whole left side, with the cost still metered", () => {
    const footer = fitted({ width: 40, hint: "quit" });
    expect({ left: footer.left, right: footer.right }).toEqual({
      left: "press ctrl-c again to quit",
      right: "$0.42",
    });
  });
});

describe("fittedFooterModel reads roles, never text", () => {
  test("drops a segment for its role whatever its text says", () => {
    _statusLayoutDeps.footerSegments = () => STUB_SEGMENTS;
    const footer = fittedFooterModel({
      width: 20,
      state: chatState(),
      status: IDLE_STATUS,
      hint: "busy",
    });
    expect(plainText(footer.left)).toBe("KEEP");
    expect(plainText(footer.right)).toBe("COST-TEXT");
  });

  test("stops at the first state that fits, dropping nothing", () => {
    const footer = fitted({ width: 80, jobs: ONE_JOB });
    expect(footer.right).toBe("run feat 1/3 · deepseek-v4.1-flash · $0.42");
    expect(footer.footer.stripWidth).toBe(displayWidth("run feat 1/3"));
  });
});

describe("fittedFooterModel keeps the warning sandbox it was given", () => {
  test("a dropped model never costs the sandbox warning its colour", () => {
    const { footer } = fitted({ width: 40, state: { sandbox: { kind: "unavailable", backend: "srt", reason: "no" } } });
    expect(colorsOf(footer)).toContain("warning");
  });
});
