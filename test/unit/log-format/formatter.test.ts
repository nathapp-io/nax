import { describe, expect, test } from "bun:test";
import { formatLogEntry } from "../../../src/log-format";
import type { LogEntry } from "../../../src/logger/types";

const TS = "2026-05-29T11:35:59.000Z";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: TS,
    level: "info",
    stage: "agent-stream",
    message: "Agent call started",
    ...overrides,
  };
}

/** Strip ANSI color codes so assertions read against plain text. */
function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return s.replace(/\[[0-9;]*m/g, "");
}

function formatNormal(e: LogEntry): string {
  const { output } = formatLogEntry(e, { mode: "normal", useColor: false });
  return plain(output);
}

describe("formatLogEntry — default line enrichment (normal mode)", () => {
  test("surfaces agent name and model on agent-call lines", () => {
    const out = formatNormal(
      entry({ data: { storyId: "s-1", agentName: "claude", model: "claude-sonnet-4-6" } }),
    );
    expect(out).toContain("claude");
    expect(out).toContain("claude-sonnet-4-6");
    // composed as agentName·model, not two separate dumps
    expect(out).toContain("claude·claude-sonnet-4-6");
  });

  test("shows agent name alone when model is absent", () => {
    const out = formatNormal(entry({ data: { agentName: "claude" } }));
    expect(out).toContain("claude");
    expect(out).not.toContain("·");
  });

  test("renders session role as a tag", () => {
    const out = formatNormal(
      entry({ stage: "tdd", message: "Session complete", sessionRole: "verifier" }),
    );
    expect(out).toContain("verifier");
  });

  test("surfaces agent-stream activity counts on call-ended lines", () => {
    const out = formatNormal(
      entry({
        message: "Agent call ended",
        data: {
          storyId: "s-1",
          messageUpdates: 12,
          toolCallUpdates: 5,
          thinkingUpdates: 3,
          idleMs: 2500,
        },
      }),
    );
    expect(out).toContain("msg 12");
    expect(out).toContain("tools 5");
    expect(out).toContain("think 3");
    expect(out).toContain("idle 2.5s");
  });

  test("omits zero-valued activity counts", () => {
    const out = formatNormal(
      entry({
        message: "Agent call ended",
        data: { messageUpdates: 4, toolCallUpdates: 0, thinkingUpdates: 0 },
      }),
    );
    expect(out).toContain("msg 4");
    expect(out).not.toContain("tools");
    expect(out).not.toContain("think");
  });

  test("surfaces status and findings count on phase lines", () => {
    const out = formatNormal(
      entry({
        stage: "story-orchestrator",
        message: "Phase passed: verifier",
        data: { storyId: "s-1", status: "passed", findingsCount: 2 },
      }),
    );
    expect(out).toContain("status: passed");
    expect(out).toContain("2 finding");
  });

  test("renders phase progress counter when present", () => {
    const out = formatNormal(
      entry({
        stage: "story-orchestrator",
        message: "Phase passed: verifier",
        data: { storyId: "s-1", phaseIndex: 5, totalPhases: 8 },
      }),
    );
    expect(out).toContain("5/8");
  });

  test("still renders cost and duration (existing behavior preserved)", () => {
    const out = formatNormal(
      entry({
        stage: "middleware",
        message: "Agent call complete",
        data: { cost: 0.1234, durationMs: 32300 },
      }),
    );
    expect(out).toContain("$0.1234");
    expect(out).toContain("32.3s");
  });

  test("a bare line with no enrichable data renders message only", () => {
    const out = formatNormal(entry({ stage: "execution", message: "Run initialization complete" }));
    expect(out).toContain("Run initialization complete");
    expect(out).not.toContain("·");
    expect(out).not.toContain("msg ");
  });
});

describe("formatLogEntry — story start enrichment", () => {
  function storyStart(data: Record<string, unknown>): string {
    return formatNormal(
      entry({ stage: "story.start", message: "Implement slugify", data: { storyId: "US-001", ...data } }),
    );
  }

  test("renders story progress counter and agent in normal mode", () => {
    const out = storyStart({ complexity: "complex", modelTier: "fast", agent: "claude", storyNumber: 1, storyTotal: 3 });
    expect(out).toContain("1/3");
    expect(out).toContain("claude");
    expect(out).toContain("complex");
    expect(out).toContain("fast");
  });

  test("omits progress counter when counts are absent", () => {
    const out = storyStart({ complexity: "complex", modelTier: "fast" });
    expect(out).not.toContain("/");
  });

  test("shows agent row in verbose mode", () => {
    const { output } = formatLogEntry(
      entry({
        stage: "story.start",
        message: "Implement slugify",
        data: { storyId: "US-001", complexity: "complex", modelTier: "fast", agent: "claude" },
      }),
      { mode: "verbose", useColor: false },
    );
    expect(plain(output)).toContain("claude");
  });
});

describe("formatLogEntry — verbose mode does not double-print enriched fields", () => {
  test("known enriched fields are not dumped again as raw JSON", () => {
    const { output } = formatLogEntry(
      entry({
        stage: "agent-stream",
        message: "Agent call ended",
        data: { agentName: "claude", model: "m", messageUpdates: 2, status: "success" },
      }),
      { mode: "verbose", useColor: false },
    );
    const text = plain(output);
    // The JSON dump (if any) must not re-include these consumed keys.
    const jsonStart = text.indexOf("{");
    const jsonPart = jsonStart >= 0 ? text.slice(jsonStart) : "";
    expect(jsonPart).not.toContain("agentName");
    expect(jsonPart).not.toContain("messageUpdates");
  });
});
