import { describe, expect, test } from "bun:test";
import type { ChatHostState } from "@/chat";
import { IDLE_STATUS } from "@/tui/chat/chat-status";
import { fittedFooterModel, fittedWorkingLine } from "@/tui/chat/status-layout";
import { plainText } from "@/tui/chat/styled-line";
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
