import { describe, expect, test } from "bun:test";
import { formatAdvisorySummary, formatLogEntry } from "../../../src/log-format";
import type { LogEntry } from "../../../src/logger/types";
import type { AdvisoryFindingSummaryEntry } from "../../../src/runtime";

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

// ── formatAdvisorySummary() — §2.1 surface sub-threshold review findings ───────

function advisoryFinding(overrides: Partial<AdvisoryFindingSummaryEntry> = {}): AdvisoryFindingSummaryEntry {
  return {
    storyId: "US-001",
    reviewer: "adversarial",
    severity: "warning",
    category: "correctness",
    file: "src/foo.ts",
    line: 12,
    issue: "off-AC edge case not handled",
    ...overrides,
  };
}

describe("formatAdvisorySummary", () => {
  test("returns empty string when there are no findings", () => {
    expect(formatAdvisorySummary([], { mode: "normal", useColor: false })).toBe("");
  });

  test("json mode returns a JSON array of the findings", () => {
    const findings = [advisoryFinding()];
    const output = formatAdvisorySummary(findings, { mode: "json", useColor: false });
    expect(JSON.parse(output)).toEqual(findings);
  });

  test("surfaces the coverage-gap demotion count and tags demoted findings", () => {
    const findings = [
      advisoryFinding({ storyId: "US-001", coverageGap: true, issue: "recurred out-of-scope" }),
      advisoryFinding({ storyId: "US-002", issue: "ordinary advisory" }),
    ];
    const output = plain(formatAdvisorySummary(findings, { mode: "normal", useColor: false }));
    expect(output).toContain("1 of 2 were coverage-gap demotions");
    expect(output).toContain("coverage-gap");
  });

  test("surfaces the no-action count and tags compliance notes (#1359)", () => {
    // These are reported but never fixed — the label is what tells an operator that
    // nothing was skipped by mistake.
    const findings = [
      advisoryFinding({ storyId: "US-004", actionRequired: false, issue: "correct per Out of Scope #10" }),
      advisoryFinding({ storyId: "US-005", issue: "ordinary advisory" }),
    ];
    const output = plain(formatAdvisorySummary(findings, { mode: "normal", useColor: false }));
    expect(output).toContain("1 of 2 asked for no change");
    expect(output).toContain("no-action");
  });

  test("omits the no-action line when every finding asks for a change (#1359)", () => {
    const output = plain(formatAdvisorySummary([advisoryFinding()], { mode: "normal", useColor: false }));
    expect(output).not.toContain("asked for no change");
  });

  test("omits the coverage-gap line when no finding was demoted", () => {
    const output = plain(formatAdvisorySummary([advisoryFinding()], { mode: "normal", useColor: false }));
    expect(output).not.toContain("coverage-gap demotions");
  });

  test("includes every finding's story ID, severity, and issue text", () => {
    const findings = [
      advisoryFinding({ storyId: "US-001", severity: "warning", issue: "issue A" }),
      advisoryFinding({ storyId: "US-002", severity: "info", issue: "issue B" }),
    ];
    const output = plain(formatAdvisorySummary(findings, { mode: "normal", useColor: false }));

    expect(output).toContain("US-001");
    expect(output).toContain("warning");
    expect(output).toContain("issue A");
    expect(output).toContain("US-002");
    expect(output).toContain("info");
    expect(output).toContain("issue B");
  });

  test("groups findings by severity, higher severity first", () => {
    const findings = [
      advisoryFinding({ storyId: "US-001", severity: "info", issue: "low" }),
      advisoryFinding({ storyId: "US-002", severity: "warning", issue: "mid" }),
    ];
    const output = plain(formatAdvisorySummary(findings, { mode: "normal", useColor: false }));

    expect(output.indexOf("mid")).toBeLessThan(output.indexOf("low"));
  });

  test("quiet mode still returns a non-empty summary (never silently dropped)", () => {
    const output = plain(formatAdvisorySummary([advisoryFinding()], { mode: "quiet", useColor: false }));
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("US-001");
  });
});

// SEC-09: agent-controlled/PRD-authored fields (message, storyId, story
// title, escalation reason) are not ANSI-sanitized upstream. A crafted
// value containing ESC (\x1b) sequences could move the cursor, clear the
// screen, or write to the clipboard (OSC 52) in the user's terminal.
describe("formatLogEntry — ANSI/control-char sanitization (SEC-09)", () => {
  test("strips a CSI sequence embedded in the message", () => {
    const { output } = formatLogEntry(
      entry({ stage: "execution", message: "before\x1b[2Jafter" }),
      { mode: "normal", useColor: false },
    );
    expect(output).not.toContain("\x1b[2J");
    expect(output).toContain("beforeafter");
  });

  test("strips an OSC 52 clipboard-write sequence embedded in storyId", () => {
    const { output } = formatLogEntry(
      entry({ stage: "execution", storyId: "US-\x1b]52;c;evil\x07001" }),
      { mode: "normal", useColor: false },
    );
    expect(output).not.toContain("\x1b]52");
    expect(output).toContain("US-001");
  });

  test("strips a CSI sequence embedded in the PRD-authored story title", () => {
    const { output } = formatLogEntry(
      entry({
        stage: "story.start",
        message: "irrelevant",
        data: { storyId: "US-001", title: "Login\x1b[31m form" },
      }),
      { mode: "normal", useColor: false },
    );
    expect(output).not.toContain("\x1b[31m");
    expect(output).toContain("Login form");
  });

  test("strips a CSI sequence embedded in the escalation reason", () => {
    const { output } = formatLogEntry(
      entry({
        stage: "story.complete",
        message: "irrelevant",
        data: { storyId: "US-001", success: false, reason: "crashed\x1b[2K here" },
      }),
      { mode: "verbose", useColor: false },
    );
    expect(output).not.toContain("\x1b[2K");
    expect(output).toContain("crashed here");
  });

  test("json mode is a raw passthrough — not sanitized (machine-consumed, not rendered)", () => {
    const { output } = formatLogEntry(entry({ stage: "execution", message: "raw\x1b[2Jvalue" }), {
      mode: "json",
      useColor: false,
    });
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe("raw\x1b[2Jvalue");
  });
});
