import { describe, expect, test } from "bun:test";
import type { SandboxState, SessionEvent } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import {
  type FooterHint,
  type FooterJob,
  footerModel,
  formatJobStrip,
  formatTokens,
  headerLines,
  IDLE_STATUS,
  reduceTurnStatus,
  shortModel,
  type TurnPhase,
  type TurnStatus,
  WORKING_TICK_MS,
  workingLine,
} from "@/tui/chat/chat-status";
import { displayWidth, MIN_LAYOUT_WIDTH, plainText, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatColorToken, resolveChatTheme } from "@/tui/chat/theme";

const AT = "2026-10-26T00:00:00.000Z";
const LATER = "2026-10-26T00:00:04.000Z";

interface EventOptions {
  readonly turnId?: string;
  readonly at?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function base(options: EventOptions = {}) {
  return {
    sessionId: "s1",
    turnId: options.turnId ?? "t1",
    at: options.at ?? AT,
    metadata: options.metadata ?? {},
  };
}

function turnStart(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "turn_start" };
}

function thinkingDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "thinking_delta", round: 1, text };
}

function textDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "text_delta", round: 1, text };
}

function toolCall(
  options: EventOptions & { readonly callId?: string; readonly name?: string; readonly input?: unknown } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "tool_call",
    callId: options.callId ?? "c1",
    name: options.name ?? "Read",
    input: "input" in options ? options.input : { path: "a.ts" },
  };
}

function toolResult(options: EventOptions & { readonly callId?: string } = {}): SessionEvent {
  return { ...base(options), type: "tool_result", callId: options.callId ?? "c1", isError: false, preview: "" };
}

function approvalRequested(
  options: EventOptions & { readonly requestId?: string; readonly answerable?: false } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "approval_requested",
    requestId: options.requestId ?? "r1",
    tool: "Write",
    summary: "write a.ts",
    reason: "outside the workdir",
    expiresAt: AT,
    ...(options.answerable === undefined ? {} : { answerable: options.answerable }),
  };
}

function approvalResolved(options: EventOptions & { readonly requestId?: string } = {}): SessionEvent {
  return {
    ...base(options),
    type: "approval_resolved",
    requestId: options.requestId ?? "r1",
    decision: "allow",
    decidedBy: "human",
  };
}

function compaction(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "compaction", reason: "proactive" };
}

function streamReset(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "stream_reset", round: 1, attempt: 2 };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  options: EventOptions & { readonly cacheRead?: number; readonly cacheWrite?: number } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "usage",
    round: 1,
    inputTokens,
    outputTokens,
    costUsd: 0.1,
    ...(options.cacheRead === undefined ? {} : { cacheRead: options.cacheRead }),
    ...(options.cacheWrite === undefined ? {} : { cacheWrite: options.cacheWrite }),
  };
}

function turnEnd(options: EventOptions = {}): SessionEvent {
  return {
    ...base(options),
    type: "turn_end",
    status: "completed",
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

/** A status mid-turn in the tool phase, so "unchanged" assertions have something to lose. */
const TOOL_STATUS: TurnStatus = {
  running: true,
  startedAt: AT,
  phase: "tool",
  toolName: "Bash",
  inputTokens: 7,
  outputTokens: 3,
};

describe("reduceTurnStatus turn start", () => {
  test("starts the turn in the thinking phase at the event's at", () => {
    const status = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(status).toEqual({ running: true, startedAt: AT, phase: "thinking", inputTokens: 0, outputTokens: 0 });
  });

  test("reports running and the event's startedAt", () => {
    const status = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(status.running).toBe(true);
    expect(status.phase).toBe("thinking");
    expect(status.startedAt).toBe(AT);
  });

  test("resets the token sums of a previous turn", () => {
    const used = reduceTurnStatus(TOOL_STATUS, usage(100, 10));
    const status = reduceTurnStatus(used, turnStart({ at: LATER }));
    expect(status.inputTokens).toBe(0);
    expect(status.outputTokens).toBe(0);
  });
});

describe("reduceTurnStatus phases", () => {
  test("sets writing on a text delta", () => {
    expect(reduceTurnStatus(TOOL_STATUS, textDelta("hi")).phase).toBe("writing");
  });

  test("sets thinking on a thinking delta", () => {
    expect(reduceTurnStatus(TOOL_STATUS, thinkingDelta("hmm")).phase).toBe("thinking");
  });

  test("sets tool and the call's name on a tool call", () => {
    const status = reduceTurnStatus(IDLE_STATUS, toolCall({ name: "Bash" }));
    expect(status.phase).toBe("tool");
    expect(status.toolName).toBe("Bash");
  });

  test("sets thinking on a tool result", () => {
    expect(reduceTurnStatus(TOOL_STATUS, toolResult({ callId: "c1" })).phase).toBe("thinking");
  });

  test("sets approval on an approval request", () => {
    expect(reduceTurnStatus(TOOL_STATUS, approvalRequested()).phase).toBe("approval");
  });

  test("leaves the phase unchanged on an unanswerable approval request", () => {
    const status = reduceTurnStatus(TOOL_STATUS, approvalRequested({ answerable: false }));
    expect(status.phase).toBe("tool");
  });

  test("sets thinking once an approval resolves", () => {
    const asked = reduceTurnStatus(TOOL_STATUS, approvalRequested());
    expect(reduceTurnStatus(asked, approvalResolved()).phase).toBe("thinking");
  });

  test("sets compacting on a compaction", () => {
    expect(reduceTurnStatus(TOOL_STATUS, compaction()).phase).toBe("compacting");
  });

  test("sets retrying on a stream reset", () => {
    expect(reduceTurnStatus(TOOL_STATUS, streamReset()).phase).toBe("retrying");
  });
});

describe("reduceTurnStatus usage", () => {
  test("adds the input and output tokens of two usage events", () => {
    const first = reduceTurnStatus(IDLE_STATUS, usage(100, 10));
    const status = reduceTurnStatus(first, usage(200, 20));
    expect(status.inputTokens).toBe(300);
    expect(status.outputTokens).toBe(30);
  });

  test("sets contextTokens to input plus cache read and cache write", () => {
    const status = reduceTurnStatus(IDLE_STATUS, usage(100, 10, { cacheRead: 50, cacheWrite: 5 }));
    expect(status.contextTokens).toBe(155);
  });
});

describe("reduceTurnStatus turn end", () => {
  test("stops the turn", () => {
    const running = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(reduceTurnStatus(running, turnEnd()).running).toBe(false);
  });

  test("keeps the context token count", () => {
    const used = reduceTurnStatus(IDLE_STATUS, usage(100, 10, { cacheRead: 50, cacheWrite: 5 }));
    expect(reduceTurnStatus(used, turnEnd()).contextTokens).toBe(155);
  });
});

describe("reduceTurnStatus subagent events", () => {
  test("returns the status unchanged for a call tagged with a running agent's task", () => {
    const before = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    const status = reduceTurnStatus(before, toolCall({ name: "Bash", metadata: { subagentTask: "scan" } }));
    expect(status).toBe(before);
  });
});

describe("formatTokens", () => {
  test("returns the integer below a thousand", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("returns one decimal and k from a thousand up", () => {
    expect(formatTokens(1234)).toBe("1.2k");
  });

  test("switches to k exactly at a thousand", () => {
    expect(formatTokens(1000)).toBe("1.0k");
  });
});

describe("shortModel", () => {
  test("returns the text after the last slash", () => {
    expect(shortModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  test("elides a name longer than 24 characters to 23 and an ellipsis", () => {
    const model = "abcdefghijklmnopqrstuvwxyz1234";
    expect(model).toHaveLength(30);
    expect(shortModel(model)).toBe(`${model.slice(0, 23)}…`);
  });

  test("keeps a name of exactly 24 characters whole", () => {
    const model = "abcdefghijklmnopqrstuvwx";
    expect(model).toHaveLength(24);
    expect(shortModel(model)).toBe(model);
  });
});

const FOOTER_COST_USD = 0.42;
const CONTEXT_WINDOW = 200_000;

const AVAILABLE_SANDBOX: SandboxState = { kind: "available", backend: "srt", network: "open" };

/** The footer fixture: guarded, model `anthropic/m1`, a $0.42 session, sandbox available. */
function chatState(overrides: Partial<ChatHostState> = {}): ChatHostState {
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
      costUsd: FOOTER_COST_USD,
    },
    sandbox: AVAILABLE_SANDBOX,
    ...overrides,
  };
}

function footer(overrides: { state?: Partial<ChatHostState>; status?: TurnStatus; hint?: FooterHint } = {}) {
  return footerModel({
    state: chatState(overrides.state),
    status: overrides.status ?? IDLE_STATUS,
    hint: overrides.hint ?? "idle",
  });
}

describe("formatJobStrip", () => {
  test.each<{ ac: string; jobs: FooterJob[]; expected: string }>([
    {
      ac: "AC-1",
      jobs: [{ kind: "run", target: "f1", progress: { passed: 3, total: 7 }, cost: 1.2 }],
      expected: "run f1 3/7 $1.20",
    },
    { ac: "AC-2", jobs: [{ kind: "plan", target: "f1" }], expected: "plan f1" },
    { ac: "AC-3", jobs: [{ kind: "bot_fix", target: "12" }], expected: "bot_fix #12" },
    {
      ac: "AC-4",
      jobs: ["f1", "f2", "f3", "f4"].map((target) => ({ kind: "plan", target })),
      expected: "plan f1 · plan f2 +2",
    },
    { ac: "AC-5", jobs: [{ kind: "plan", target: "a-very-long-feature-name" }], expected: "plan a-very-long-fea…" },
    { ac: "bot review", jobs: [{ kind: "bot_review", target: "42" }], expected: "bot_review #42" },
    {
      ac: "zero values",
      jobs: [{ kind: "run", target: "f1", cost: 0, progress: { passed: 0, total: 0 } }],
      expected: "run f1 0/0 $0.00",
    },
    { ac: "empty", jobs: [], expected: "" },
  ])("US-014 $ac formats jobs", ({ jobs, expected }) => {
    expect(formatJobStrip(jobs)).toBe(expected);
  });
  test("US-014 AC-6 prepends the job strip to the right footer", () => {
    const model = footerModel({
      state: chatState(),
      status: IDLE_STATUS,
      hint: "idle",
      jobs: [{ kind: "plan", target: "f1" }],
    });
    expect(model.right[0]?.text).toBe("plan f1");
  });
  test("US-014 AC-7 empty jobs preserve the footer", () => {
    const input = { state: chatState(), status: IDLE_STATUS, hint: "idle" as const };
    expect(footerModel({ ...input, jobs: [] }).right).toEqual(footerModel(input).right);
  });
});

describe("footerModel left", () => {
  test("copied feedback includes the character count and preserves mode and cost", () => {
    const model = footerModel({ state: chatState(), status: IDLE_STATUS, hint: "copied", copiedChars: 5 });
    expect(plainText(model.left)).toBe("⏵ guarded · copied 5 chars");
    expect(plainText(model.right)).toBe("m1 · $0.42");
  });
  test("gives the guarded mode, the idle hint and no sandbox suffix", () => {
    expect(plainText(footer().left)).toBe("⏵ guarded · shift+tab to cycle");
  });

  test("starts with the full mode label, coloured danger", () => {
    const { left } = footer({ state: { mode: "full" } });
    expect(plainText(left).startsWith("⏵⏵ full")).toBe(true);
    expect(left[0]).toEqual({ text: "⏵⏵ full", color: "danger" });
  });

  test("replaces the whole left side with the warning quit hint", () => {
    const { left } = footer({ hint: "quit" });
    expect(plainText(left)).toBe("press ctrl-c again to quit");
    expect(left.every((span) => span.color === "warning")).toBe(true);
  });

  const HINT_CASES: Array<[FooterHint, string]> = [
    ["clear", "esc again to clear"],
    ["busy", "esc to interrupt"],
    ["expanded", "ctrl+o to collapse"],
  ];

  test.each(HINT_CASES)("ends with the %s hint's text", (hint, text) => {
    expect(plainText(footer({ hint }).left).endsWith(text)).toBe(true);
  });

  const SANDBOX_CASES: Array<[string, SandboxState | undefined, string, ChatColorToken]> = [
    ["unavailable", { kind: "unavailable", backend: "srt", reason: "no bwrap" }, " · sandbox unavailable", "warning"],
    ["absent", undefined, " · sandbox off", "muted"],
    ["disabled", { kind: "disabled" }, " · sandbox off", "muted"],
  ];

  test.each(SANDBOX_CASES)("appends the suffix of a %s sandbox", (_name, sandbox, suffix, color) => {
    const { left } = footer({ state: { sandbox } });
    expect(plainText(left).endsWith(suffix)).toBe(true);
    expect(left.find((span) => span.text === suffix)).toEqual({ text: suffix, color });
  });
});

describe("footerModel right", () => {
  test("gives the short model and the cost", () => {
    expect(plainText(footer().right)).toBe("m1 · $0.42");
  });

  test("flattens a model carrying a line break onto the footer's one row", () => {
    const { right } = footer({ state: { model: "anthropic/m\n1" } });
    expect(plainText(right)).toBe("m 1 · $0.42");
    expect(plainText(right).includes("\n")).toBe(false);
  });

  const CONTEXT_CASES: Array<[number, string, ChatColorToken]> = [
    [36_000, "18% ctx", "muted"],
    [140_000, "70% ctx", "muted"],
    [150_000, "75% ctx", "warning"],
    [180_000, "90% ctx", "warning"],
    [190_000, "95% ctx", "danger"],
  ];

  test.each(CONTEXT_CASES)("shows %i context tokens as %s", (contextTokens, text, color) => {
    const { right } = footer({
      state: { contextWindow: CONTEXT_WINDOW },
      status: { ...IDLE_STATUS, contextTokens },
    });
    expect(plainText(right)).toBe(`m1 · ${text} · $0.42`);
    expect(right.find((span) => span.text.includes(text))?.color).toBe(color);
  });

  const NO_CONTEXT_CASES: Array<[string, Partial<ChatHostState>, TurnStatus]> = [
    ["an unknown token count", { contextWindow: CONTEXT_WINDOW }, IDLE_STATUS],
    ["an unknown context window", {}, { ...IDLE_STATUS, contextTokens: 36_000 }],
    ["a zero context window", { contextWindow: 0 }, { ...IDLE_STATUS, contextTokens: 36_000 }],
  ];

  test.each(NO_CONTEXT_CASES)("shows no percentage for %s", (_name, state, status) => {
    expect(plainText(footer({ state, status }).right)).toBe("m1 · $0.42");
  });
});

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const GLYPHS = THEME.glyphs;
const SPINNER_FRAME_MS = 120;
const STARTED_AT_MS = Date.parse(AT);
const TWELVE_SECONDS = 12_000;

/** The spinner frame the working line shows after `elapsedMs` of a turn. */
function frameAt(elapsedMs: number): string {
  return GLYPHS.spinner[Math.floor(elapsedMs / SPINNER_FRAME_MS) % GLYPHS.spinner.length];
}

/** A status running since `AT`, which most working-line cases start from. */
function runningStatus(overrides: Partial<TurnStatus> = {}): TurnStatus {
  return { running: true, startedAt: AT, phase: "thinking", inputTokens: 0, outputTokens: 0, ...overrides };
}

/** Twelve seconds into an agent run that has spent 8.4k in and 1.2k out. */
const AGENT_STATUS: TurnStatus = runningStatus({
  phase: "tool",
  toolName: "nax-agents__run",
  inputTokens: 8_400,
  outputTokens: 1_200,
});

/** The text a status draws at `elapsedMs` past its start. */
function workingText(status: TurnStatus, elapsedMs: number): string {
  return plainText(workingLine(status, STARTED_AT_MS + elapsedMs, GLYPHS) ?? []);
}

describe("workingLine", () => {
  test("gives no line while no turn runs", () => {
    expect(workingLine(IDLE_STATUS, 0, GLYPHS)).toBeUndefined();
  });

  test("spins a frame around the agent it runs, the seconds and the tokens", () => {
    expect(workingText(AGENT_STATUS, TWELVE_SECONDS)).toBe(
      `${frameAt(TWELVE_SECONDS)} Running Agent… (12s · ↑ 8.4k ↓ 1.2k tokens · esc to interrupt)`,
    );
  });

  test("paints the frame and the verb accent and the measurement muted", () => {
    const line = workingLine(AGENT_STATUS, STARTED_AT_MS + TWELVE_SECONDS, GLYPHS) ?? [];
    expect(line.find((span) => span.text.includes("Running Agent"))?.color).toBe("accent");
    expect(line.find((span) => span.text.includes("tokens"))?.color).toBe("muted");
  });

  test("shows the first frame at 0 ms elapsed", () => {
    expect(workingLine(runningStatus(), STARTED_AT_MS, GLYPHS)?.[0]).toEqual({
      text: `${GLYPHS.spinner[0]} `,
      color: "accent",
    });
  });

  test("shows the second frame at 120 ms elapsed", () => {
    expect(workingLine(runningStatus(), STARTED_AT_MS + SPINNER_FRAME_MS, GLYPHS)?.[0]).toEqual({
      text: `${GLYPHS.spinner[1]} `,
      color: "accent",
    });
  });

  test("wraps the frame around the set at the end of it", () => {
    const wrapAt = SPINNER_FRAME_MS * GLYPHS.spinner.length;
    expect(workingLine(runningStatus(), STARTED_AT_MS + wrapAt, GLYPHS)?.[0]).toEqual({
      text: `${GLYPHS.spinner[0]} `,
      color: "accent",
    });
  });

  test("waits for approval in the approval phase", () => {
    expect(workingText(runningStatus({ phase: "approval" }), 0)).toBe(
      `${GLYPHS.spinner[0]} Waiting for approval… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`,
    );
  });

  const VERB_CASES: Array<[TurnPhase, string]> = [
    ["thinking", "Thinking…"],
    ["writing", "Writing…"],
    ["compacting", "Compacting…"],
    ["retrying", "Retrying…"],
  ];

  test.each(VERB_CASES)("states the %s phase as %s", (phase, verb) => {
    expect(workingText(runningStatus({ phase }), 0)).toBe(
      `${GLYPHS.spinner[0]} ${verb} (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`,
    );
  });

  test("names a tool by its title, without the provider prefix", () => {
    expect(workingText(runningStatus({ phase: "tool", toolName: "Read" }), 0)).toContain("Running Read…");
  });

  test("flattens a tool name carrying a line break onto the one row it has", () => {
    const line = workingText(runningStatus({ phase: "tool", toolName: "Ba\nsh" }), 0);
    expect(line).toBe(`${GLYPHS.spinner[0]} Running Ba sh… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`);
    expect(line.includes("\n")).toBe(false);
  });

  test("counts a start that does not parse as no elapsed time", () => {
    expect(workingText(runningStatus({ startedAt: "now" }), 0)).toBe(
      `${GLYPHS.spinner[0]} Thinking… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`,
    );
  });

  test("draws no frame when the glyph set has none", () => {
    const bare = { ...GLYPHS, spinner: [] as readonly string[] };
    const line = plainText(workingLine(runningStatus(), STARTED_AT_MS, bare) ?? []);
    expect(line).toBe("Thinking… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)");
  });

  test("counts a missing start as no elapsed time", () => {
    const running: TurnStatus = { running: true, phase: "thinking", inputTokens: 0, outputTokens: 0 };
    const line = plainText(workingLine(running, STARTED_AT_MS, GLYPHS) ?? []);
    expect(line).toBe(`${GLYPHS.spinner[0]} Thinking… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`);
  });

  test("does not count a now before the start as negative time", () => {
    expect(workingText(runningStatus(), -TWELVE_SECONDS)).toBe(
      `${GLYPHS.spinner[0]} Thinking… (0s · ↑ 0 ↓ 0 tokens · esc to interrupt)`,
    );
  });

  test("ticks the screen every 250 ms", () => {
    expect(WORKING_TICK_MS).toBe(250);
  });
});

const HEADER_WIDTH = 60;
/** The columns a header path may take before the sandbox suffix needs the rest. */
const HEADER_PATH_BUDGET = HEADER_WIDTH - 20;
const HEADER_VERSION = "0.91.7";
const HEADER_CWD = "/Users/u/repo";
const HEADER_HOME = "/Users/u";

function header(
  options: { state?: Partial<ChatHostState>; version?: string; cwd?: string; home?: string; width?: number } = {},
): readonly StyledLine[] {
  return headerLines({
    state: chatState(options.state),
    version: options.version ?? HEADER_VERSION,
    cwd: options.cwd ?? HEADER_CWD,
    home: options.home ?? HEADER_HOME,
    width: options.width ?? HEADER_WIDTH,
  });
}

/** One of the header's three lines as text. */
function headerText(index: number, options: Parameters<typeof header>[0] = {}): string {
  return plainText(header(options)[index] ?? []);
}

describe("headerLines", () => {
  test("gives three lines", () => {
    expect(header()).toHaveLength(3);
  });

  test("names the product, its version, the model and the mode first", () => {
    expect(headerText(0)).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m1 · guarded`);
  });

  test("draws the title accent and bold and the facts muted", () => {
    const [title] = header();
    expect(title?.[0]).toEqual({ text: `${GLYPHS.thinking} nax chat`, color: "accent", bold: true });
    expect(title?.[1]).toEqual({ text: " v0.91.7 · m1 · guarded", color: "muted" });
  });

  test("names the full mode as full", () => {
    expect(headerText(0, { state: { mode: "full" } })).toBe(`${GLYPHS.thinking} nax chat v0.91.7 · m1 · full`);
  });

  test("puts the shortened home path two columns in and the sandbox after it", () => {
    const line = headerText(1);
    expect(line.startsWith("  ~/repo")).toBe(true);
    expect(line.endsWith("sandbox on")).toBe(true);
    expect(line).toBe("  ~/repo · sandbox on");
  });

  test("leaves a path outside the home as it is", () => {
    expect(headerText(1, { cwd: "/opt/repo" })).toBe("  /opt/repo · sandbox on");
  });

  test("shows the home itself as a tilde", () => {
    expect(headerText(1, { cwd: HEADER_HOME })).toBe("  ~ · sandbox on");
  });

  test("leaves the path alone when no home is known", () => {
    expect(headerText(1, { home: "" })).toBe("  /Users/u/repo · sandbox on");
  });

  test("flattens a cwd carrying a line break onto the one row the header gives it", () => {
    const lines = header({ cwd: "/Users/u/re\npo" });
    expect(lines).toHaveLength(3);
    expect(plainText(lines[1])).toBe("  ~/re po · sandbox on");
    expect(lines.some((line) => plainText(line).includes("\n"))).toBe(false);
  });

  test("flattens a home carrying a line break before it is matched", () => {
    expect(headerText(1, { cwd: "/Users/ u/repo", home: "/Users/\nu" })).toBe("  ~/repo · sandbox on");
  });

  test("flattens a version and a model carrying a line break", () => {
    const title = headerText(0, { version: "0.91.7\nx", state: { model: "anthropic/m\n1" } });
    expect(title).toBe(`${GLYPHS.thinking} nax chat v0.91.7 x · m 1 · guarded`);
    expect(title.includes("\n")).toBe(false);
  });

  const SANDBOX_CASES: Array<[string, SandboxState | undefined, string]> = [
    ["available", AVAILABLE_SANDBOX, "sandbox on"],
    ["disabled", { kind: "disabled" }, "sandbox off"],
    ["absent", undefined, "sandbox off"],
    ["unavailable", { kind: "unavailable", backend: "srt", reason: "no bwrap" }, "sandbox unavailable"],
  ];

  test.each(SANDBOX_CASES)("labels the %s sandbox at the end of the second line", (_name, sandbox, label) => {
    const line = header({ state: { sandbox } })[1] ?? [];
    expect(plainText(line).endsWith(label)).toBe(true);
    expect(line.at(-1)).toEqual({ text: ` · ${label}`, color: "muted" });
  });

  test("draws a border rule as wide as the header", () => {
    expect(headerText(2)).toBe(GLYPHS.rule.repeat(HEADER_WIDTH));
    expect(header()[2]?.[0]?.color).toBe("border");
  });

  test("clamps a width under the minimum before drawing the rule", () => {
    expect(headerText(2, { width: 4 })).toBe(GLYPHS.rule.repeat(MIN_LAYOUT_WIDTH));
  });

  test("elides a long path in the middle to the room the sandbox suffix leaves", () => {
    const cwd = `/Users/u/${"x".repeat(60)}`;
    const line = headerText(1, { cwd });
    const shown = line.slice(2, line.indexOf(" · sandbox"));
    expect(shown).toContain("…");
    expect(displayWidth(shown)).toBeLessThanOrEqual(HEADER_PATH_BUDGET);
    expect(shown.startsWith("~/")).toBe(true);
    expect(shown.endsWith("x")).toBe(true);
  });

  test("keeps a path that just fits the budget whole", () => {
    const cwd = `/Users/u/${"x".repeat(HEADER_PATH_BUDGET - 2)}`;
    const shown = headerText(1, { cwd }).slice(2, headerText(1, { cwd }).indexOf(" · sandbox"));
    expect(shown).toBe(cwd.replace(HEADER_HOME, "~"));
    expect(displayWidth(shown)).toBe(HEADER_PATH_BUDGET);
  });
});
