import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { type FooterJob, type FooterTask, IDLE_STATUS } from "@/tui/chat/chat-status";
import { fittedFooterModel, fittedWorkingLine } from "@/tui/chat/status-layout";
import { displayWidth, plainText, type StyledLine } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";
import { footerStripHit } from "@/tui/chat/use-jobs-opener";
import { spansWidth } from "@/tui/chat/wrap";

const state: ChatHostState = {
  sessionId: "s",
  mode: "guarded",
  model: "opencode-go/deepseek-v4.1-flash",
  sandbox: { kind: "available", backend: "srt", network: "open" },
  meta: {
    schemaVersion: 1,
    sessionId: "s",
    cwd: "/repo",
    mode: "ask",
    model: "opencode-go/deepseek-v4.1-flash",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0.42,
  },
};

describe("fittedFooterModel", () => {
  test.each([10, 20, 40, 60, 80, 120])("fits %i columns with wide job names and sandbox warnings", (width) => {
    const footer = fittedFooterModel({
      width,
      state: { ...state, sandbox: { kind: "unavailable", backend: "srt", reason: "test" } },
      status: IDLE_STATUS,
      hint: "busy",
      jobs: [{ kind: "plan", target: "界".repeat(30) }],
    });
    expect(spansWidth(footer.left) + spansWidth(footer.right) + (footer.right.length ? 2 : 0)).toBeLessThanOrEqual(
      width,
    );
  });
  test("prioritizes an armed quit over model metadata", () => {
    const footer = fittedFooterModel({ width: 40, state, status: IDLE_STATUS, hint: "quit" });
    expect(plainText(footer.left)).toBe("press ctrl-c again to quit");
  });
  test("retains the overlay-specific escape action", () => {
    const footer = fittedFooterModel({
      width: 40,
      state,
      status: IDLE_STATUS,
      hint: "layer",
      layerHint: "esc to deny",
    });
    expect(plainText(footer.left)).toContain("esc to deny");
    expect(plainText(footer.right)).toContain("$0.42");
  });
  test("the fitted job strip matches its clickable columns", () => {
    const footer = fittedFooterModel({
      width: 80,
      state,
      status: IDLE_STATUS,
      hint: "busy",
      jobs: [{ kind: "run", target: "feature-with-long-name", progress: { passed: 2, total: 4 } }],
    });
    expect(footer.stripWidth).toBeGreaterThan(0);
    expect(plainText(footer.right)).not.toContain(" ·  · ");
    const first = 80 - spansWidth(footer.right) + 1;
    const hit = (x: number) =>
      footerStripHit({
        x,
        y: 20,
        footerRow: 20,
        columns: 80,
        rightWidth: spansWidth(footer.right),
        stripWidth: footer.stripWidth,
      });
    expect(hit(first)).toBe(true);
    expect(hit(first + footer.stripWidth - 1)).toBe(true);
    expect(hit(first - 1)).toBe(false);
    expect(hit(first + footer.stripWidth)).toBe(false);
  });
});

/** The one span of the line whose text is `text`, or undefined when the line draws none. */
function spanWith(line: StyledLine, text: string): StyledLine[number] | undefined {
  return line.find((span) => span.text === text);
}

/** Two 20-character run targets: a strip too wide to draw beside the model at 60 columns. */
const LONG_RUN_A: FooterJob = { kind: "run", target: "feat-0123456789abcde" };
const LONG_RUN_B: FooterJob = { kind: "run", target: "feat-0123456789abcdf" };
/** The fixture `footer-fit-pipeline.test.ts` summarises at 60 columns. */
const TWO_JOBS_AND_A_TASK: { readonly jobs: readonly FooterJob[]; readonly tasks: readonly FooterTask[] } = {
  jobs: [LONG_RUN_A, LONG_RUN_B],
  tasks: [{ command: "bun test" }],
};
const ONE_SHELL: readonly FooterTask[] = [{ command: "bun test" }];

describe("fittedFooterModel draws the strip as clickable", () => {
  test("AC-2 draws the one running shell's strip span in the accent colour, underlined", () => {
    const footer = fittedFooterModel({ width: 100, state, status: IDLE_STATUS, hint: "busy", tasks: ONE_SHELL });
    expect(spanWith(footer.right, "1 shell")).toEqual({ text: "1 shell", color: "accent", underline: true });
  });

  test("AC-3 draws the one running agent's strip span in the accent colour, underlined", () => {
    const footer = fittedFooterModel({
      width: 100,
      state,
      status: IDLE_STATUS,
      hint: "busy",
      tasks: [{ command: "review the diff", kind: "agent" }],
    });
    expect(spanWith(footer.right, "1 agent")).toEqual({ text: "1 agent", color: "accent", underline: true });
  });

  test("AC-4 underlines the whole run-and-shell strip a run without progress or cost shows", () => {
    const footer = fittedFooterModel({
      width: 100,
      state,
      status: IDLE_STATUS,
      hint: "busy",
      jobs: [{ kind: "run", target: "demo" }],
      tasks: ONE_SHELL,
    });
    expect(spanWith(footer.right, "run demo · 1 shell")).toEqual({
      text: "run demo · 1 shell",
      color: "accent",
      underline: true,
    });
  });

  test("AC-5 leaves the separator, the model and the cost of that footer un-underlined", () => {
    const footer = fittedFooterModel({
      width: 100,
      state,
      status: IDLE_STATUS,
      hint: "busy",
      jobs: [{ kind: "run", target: "demo" }],
      tasks: ONE_SHELL,
    });
    const strip = footer.right.findIndex((span) => span.text === "run demo · 1 shell");
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(footer.right[strip + 1]).toEqual({ text: " · ", color: "muted" });
    expect(spanWith(footer.right, "deepseek-v4.1-flash")?.underline).toBeUndefined();
    expect(spanWith(footer.right, " · $0.42")?.underline).toBeUndefined();
    // The strip is the only underlined span the whole row carries.
    expect([...footer.left, ...footer.right].filter((span) => span.underline === true)).toHaveLength(1);
  });

  test("AC-6 underlines the count a summarised strip is replaced by", () => {
    const footer = fittedFooterModel({ width: 60, state, status: IDLE_STATUS, hint: "busy", ...TWO_JOBS_AND_A_TASK });
    expect(spanWith(footer.right, "3 active (ctrl+g)")).toEqual({
      text: "3 active (ctrl+g)",
      color: "accent",
      underline: true,
    });
  });

  test("AC-7 draws nothing underlined when no job and no task runs", () => {
    const footer = fittedFooterModel({ width: 100, state, status: IDLE_STATUS, hint: "busy" });
    expect([...footer.left, ...footer.right].some((span) => span.underline === true)).toBe(false);
  });

  test("AC-8 measures the drawn shell count, so the click geometry is unchanged", () => {
    const footer = fittedFooterModel({ width: 100, state, status: IDLE_STATUS, hint: "busy", tasks: ONE_SHELL });
    expect(footer.stripWidth).toBe(displayWidth("1 shell"));
  });
});

describe("fittedWorkingLine", () => {
  const glyphs = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 }).glyphs;
  test("keeps phase and elapsed time on a narrow terminal", () => {
    const line =
      fittedWorkingLine(
        { ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z" },
        Date.parse("2026-11-11T00:00:12Z"),
        glyphs,
        undefined,
        40,
      ) ?? [];
    expect(plainText(line)).toContain("Thinking...");
    expect(plainText(line)).toContain("12s");
    expect(spansWidth(line)).toBeLessThanOrEqual(40);
  });
  test("idle claims no working row", () => {
    expect(fittedWorkingLine(IDLE_STATUS, 0, glyphs, undefined, 40)).toBeUndefined();
  });
});
