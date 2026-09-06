import { describe, expect, test } from "bun:test";
import { formatAdvisorySummary, formatLogEntry } from "@/log-format";
import type { LogEntry } from "@/logger/types";
import type { AdvisoryFindingSummaryEntry } from "@/runtime";

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
    const out = formatNormal(entry({ data: { storyId: "s-1", agentName: "claude", model: "claude-sonnet-4-6" } }));
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
    const out = formatNormal(entry({ stage: "tdd", message: "Session complete", sessionRole: "verifier" }));
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

  // nax#1853: a run that dies on an adapter error printed "Agent call failed"
  // and nothing else. The reason was already in the event's `error` field and
  // was only reachable by re-running the whole thing with --verbose.
  test("surfaces the failure reason on a warn line", () => {
    const out = formatNormal(
      entry({
        level: "warn",
        stage: "middleware",
        message: "Agent call failed",
        data: { agentName: "native", error: 'Native model "claude-sonnet-5" must be written "provider/model"' },
      }),
    );
    expect(out).toContain("Agent call failed");
    expect(out).toContain('Native model "claude-sonnet-5" must be written "provider/model"');
  });

  test("surfaces the failure reason on an error line", () => {
    const out = formatNormal(entry({ level: "error", stage: "execution", data: { error: "boom" } }));
    expect(out).toContain("boom");
  });

  test("collapses newlines in a multi-line failure reason so the line stays scannable", () => {
    const out = formatNormal(entry({ level: "error", stage: "execution", data: { error: "line one\nline two" } }));
    expect(out).toContain("line one line two");
    expect(out).not.toContain("\n");
  });

  test("truncates an overlong failure reason", () => {
    const out = formatNormal(entry({ level: "error", stage: "execution", data: { error: "x".repeat(500) } }));
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(400);
  });

  test("does not surface an error field on an info line", () => {
    // `error` on a non-failure line is not a failure reason; only warn/error
    // lines are the case this exists for.
    const out = formatNormal(entry({ level: "info", stage: "execution", data: { error: "not-a-failure" } }));
    expect(out).not.toContain("not-a-failure");
  });

  test("is suppressed in quiet mode", () => {
    const { output } = formatLogEntry(entry({ level: "warn", stage: "middleware", data: { error: "boom" } }), {
      mode: "quiet",
      useColor: false,
    });
    expect(plain(output)).not.toContain("boom");
  });
});

describe("formatLogEntry — story start enrichment", () => {
  function storyStart(data: Record<string, unknown>): string {
    return formatNormal(
      entry({ stage: "story.start", message: "Implement slugify", data: { storyId: "US-001", ...data } }),
    );
  }

  test("renders story progress counter and agent in normal mode", () => {
    const out = storyStart({
      complexity: "complex",
      modelTier: "fast",
      agent: "claude",
      storyNumber: 1,
      storyTotal: 3,
    });
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
    const { output } = formatLogEntry(entry({ stage: "execution", message: "before\x1b[2Jafter" }), {
      mode: "normal",
      useColor: false,
    });
    expect(output).not.toContain("\x1b[2J");
    expect(output).toContain("beforeafter");
  });

  test("strips an OSC 52 clipboard-write sequence embedded in storyId", () => {
    const { output } = formatLogEntry(entry({ stage: "execution", storyId: "US-\x1b]52;c;evil\x07001" }), {
      mode: "normal",
      useColor: false,
    });
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

describe("formatLogEntry — coding-tool call noise (normal mode)", () => {
  // The outcome-sniffing special case this block used to pin was removed: the
  // level now carries the decision (src/tools/runtime.ts picks debug for `ok`
  // and for a routineErrors tool's error, warn for every other failure, error
  // for a policy breach), so the generic debug filter does the same job for
  // every stage rather than for this one by name.
  function invoked(level: LogEntry["level"], outcome: string): LogEntry {
    return entry({
      level,
      stage: "coding-tool",
      message: `Edit ${outcome}`,
      data: { storyId: "US-001", tool: "Edit", outcome, resultBytes: 107 },
    });
  }

  test("a successful call is not displayed", () => {
    // 1020 of 1165 such calls in one observed run were outcome "ok" — per-call
    // console noise with no decision riding on it.
    expect(formatLogEntry(invoked("debug", "ok"), { mode: "normal", useColor: false }).shouldDisplay).toBe(false);
  });

  test("a denied call is still displayed", () => {
    // src/tools/runtime.ts logs every outcome precisely so a refused call stays
    // distinguishable from one never made. Suppressing that would defeat it.
    expect(formatLogEntry(invoked("warn", "denied"), { mode: "normal", useColor: false }).shouldDisplay).toBe(true);
  });

  test("a failed call is still displayed", () => {
    expect(formatLogEntry(invoked("warn", "error"), { mode: "normal", useColor: false }).shouldDisplay).toBe(true);
  });

  test("the console line names the tool and the outcome", () => {
    // Previously every one of these printed as a bare "coding-tool invoked",
    // so 145 visible failures in one run identified neither tool nor reason.
    const failed = entry({
      level: "warn",
      stage: "coding-tool",
      message: "GitCommit error",
      data: { storyId: "US-001", tool: "GitCommit", outcome: "error", resultBytes: 42, error: "nothing to commit" },
    });
    const { output } = formatLogEntry(failed, { mode: "normal", useColor: false });
    expect(output).toContain("GitCommit error");
    expect(output).toContain("nothing to commit");
  });

  test("verbose mode still shows successful calls", () => {
    expect(formatLogEntry(invoked("debug", "ok"), { mode: "verbose", useColor: false }).shouldDisplay).toBe(true);
  });

  test("json mode still shows successful calls", () => {
    expect(formatLogEntry(invoked("debug", "ok"), { mode: "json", useColor: false }).shouldDisplay).toBe(true);
  });

  test("an unrelated coding-tool message is untouched", () => {
    const other = entry({ level: "info", stage: "coding-tool", message: "runtime ready" });
    expect(formatLogEntry(other, { mode: "normal", useColor: false }).shouldDisplay).toBe(true);
  });

  test("a pull-tool invocation is untouched — the curator parses those", () => {
    // src/plugins/builtin/curator/collect.ts reads stage "pull-tool" + message
    // "invoked" back out of the log.
    const pull = entry({ level: "info", stage: "pull-tool", message: "invoked", data: { outcome: "ok" } });
    expect(formatLogEntry(pull, { mode: "normal", useColor: false }).shouldDisplay).toBe(true);
  });
});
