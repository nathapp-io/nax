import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import type { ChatApproval, ChatPendingAsk } from "@/chat";
import {
  ASK_NO,
  ASK_QUESTION_TITLE,
  ASK_YES,
  ASK_YES_SESSION,
  type AskCardApproval,
  type AskCardOptions,
  type AskCardQuestion,
  askCardModel,
} from "@/tui/chat/ask-card";
import { reduceTranscript, type TranscriptEntry } from "@/tui/chat/transcript-model";

/** An ISO instant; the model reads no clock, so any fixed value does. */
const AT = "2026-10-01T00:00:00.000Z";
const EXPIRES_AT = "2026-10-01T00:10:00.000Z";
/** A transcript with nothing in it: the shape an ask raised outside a tool call has. */
const NO_ENTRIES: readonly TranscriptEntry[] = [];

type ChatQuestion = Extract<ChatPendingAsk, { type: "question" }>;

/** One approval as the session raises it: a Bash ask that wants to run the tests. */
function approval(overrides: Partial<ChatApproval> = {}): ChatApproval {
  return {
    type: "approval_requested",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: {},
    requestId: "r1",
    tool: "Bash",
    summary: "Run the tests",
    command: "npm test",
    reason: "nax needs to run a command",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/** The approval branch of the model — a question card is the only other kind. */
function approvalCard(overrides: Partial<ChatApproval> = {}, options: Partial<AskCardOptions> = {}): AskCardApproval {
  const card = askCardModel(approval(overrides), { canRemember: true, entries: NO_ENTRIES, ...options });
  if (card.kind !== "approval") throw new Error(`expected an approval card, got ${card.kind}`);
  return card;
}

/** One question as the session raises it, for the card kind that asks rather than offers. */
function question(overrides: Partial<ChatQuestion> = {}): ChatQuestion {
  return {
    type: "question",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: {},
    requestId: "q1",
    text: "which package?",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/** The question branch of the model. */
function questionCard(overrides: Partial<ChatQuestion> = {}): AskCardQuestion {
  const card = askCardModel(question(overrides), { canRemember: false, entries: NO_ENTRIES });
  if (card.kind !== "question") throw new Error(`expected a question card, got ${card.kind}`);
  return card;
}

/** One tool call as the transcript recorded it, so an approval's `callId` has something to name. */
function toolEntry(callId: string, name: string, input: unknown): TranscriptEntry {
  return { kind: "tool", turnId: "t1", callId, name, input, startedAt: AT, status: "ok", children: [] };
}

/** The one recorded Edit call the approval tests name: `a` replaced by `b`. */
const REPLACEMENT = toolEntry("c1", "Edit", { path: "x.ts", old_string: "a", new_string: "b" });

/** One session event as the reducer takes it; a subagent's call carries the host's task tag. */
function toolCall(callId: string, name: string, input: unknown, subagentTask?: string): SessionEvent {
  return {
    type: "tool_call",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: subagentTask === undefined ? {} : { subagentTask },
    callId,
    name,
    input,
  };
}

/**
 * A transcript in which a subagent made the Edit call: the reducer keeps a nested call under
 * the agent card that ran it rather than beside it, which is the shape an attributed ask sees.
 */
function subagentEdit(): readonly TranscriptEntry[] {
  const task = "fix x";
  const withAgent = reduceTranscript([], toolCall("p1", "nax-agents__run", { agent: "explorer", task }));
  return reduceTranscript(withAgent, toolCall("c9", "Edit", { path: "x.ts", old_string: "a", new_string: "b" }, task));
}

describe("askCardModel", () => {
  test("titles a Bash ask by what it does", () => {
    expect(approvalCard().title).toBe("Bash command");
  });

  test("lists the three options in order when the ask may be remembered", () => {
    const card = approvalCard({}, { canRemember: true });
    expect(card.options.map((option) => option.label)).toEqual([ASK_YES, ASK_YES_SESSION, ASK_NO]);
    expect(card.options.map((option) => option.choice)).toEqual(["allow_once", "allow_session", "deny"]);
    expect(card.options.map((option) => option.index)).toEqual([1, 2, 3]);
  });

  test("drops the session option when the ask may not be remembered", () => {
    const card = approvalCard({}, { canRemember: false });
    expect(card.options.map((option) => option.label)).toEqual([ASK_YES, ASK_NO]);
    expect(card.options.map((option) => option.choice)).toEqual(["allow_once", "deny"]);
    expect(card.options.map((option) => option.index)).toEqual([1, 2]);
  });

  test("says an unsandboxed ask runs outside the sandbox", () => {
    expect(approvalCard({ unsandboxed: true }).title).toBe("Bash command · outside the sandbox");
  });

  test("tones the border danger outside the sandbox and warning otherwise", () => {
    expect(approvalCard({ unsandboxed: true }).border).toBe("danger");
    expect(approvalCard().border).toBe("warning");
  });

  test("titles an Edit ask by what it does", () => {
    expect(approvalCard({ tool: "Edit", command: undefined }).title).toBe("Edit file");
  });

  test("titles a Write ask by what it does", () => {
    expect(approvalCard({ tool: "Write", command: undefined }).title).toBe("Write file");
  });

  test("titles a Delete ask by what it does", () => {
    expect(approvalCard({ tool: "Delete", command: undefined }).title).toBe("Delete file");
  });

  test("titles an agent run Agent", () => {
    expect(approvalCard({ tool: "nax-agents__run" }).title).toBe("Agent");
  });

  test("titles any other provider-qualified tool as an MCP tool", () => {
    expect(approvalCard({ tool: "acme__put" }).title).toBe("MCP tool acme__put");
  });

  test("keeps a tool's own name when it has no title of its own", () => {
    expect(approvalCard({ tool: "Grep" }).title).toBe("Grep");
  });

  test("sanitises the tool, command, summary and reason it returns", () => {
    const card = approvalCard({
      tool: "\u001b[1mBash",
      command: "npm\ttest",
      summary: "Run\u001b[0m the tests",
      reason: "needs\u0007 to run",
    });
    expect(card.title).toBe("Bash command");
    expect(card.command).toBe("npm  test");
    expect(card.summary).toBe("Run the tests");
    expect(card.reason).toBe("needs to run");
  });
});

describe("askCardModel attribution", () => {
  test("takes the agent tag off the reason", () => {
    expect(approvalCard({ reason: "[agent reviewer] needs to run" }).reason).toBe("needs to run");
  });

  test("reports the agent tag it took off the reason", () => {
    expect(approvalCard({ reason: "[agent reviewer] needs to run" }).tag).toBe("[agent reviewer]");
  });

  test("reports no tag for a reason that names no agent", () => {
    expect(approvalCard({ reason: "needs to run" }).tag).toBeUndefined();
  });
});

describe("askCardModel diff", () => {
  test("diffs an Edit approval against the call its callId names", () => {
    const card = approvalCard({ tool: "Edit", callId: "c1", command: undefined }, { entries: [REPLACEMENT] });
    expect(card.diff).toEqual([
      { sign: "-", text: "a" },
      { sign: "+", text: "b" },
    ]);
  });

  test("diffs an Edit approval against a subagent call the transcript nested", () => {
    const entries = subagentEdit();
    const agent = entries[0];
    expect(agent.kind === "tool" && agent.children.map((child) => child.callId)).toEqual(["c9"]);
    const card = approvalCard({ tool: "Edit", callId: "c9", command: undefined }, { entries });
    expect(card.diff).toEqual([
      { sign: "-", text: "a" },
      { sign: "+", text: "b" },
    ]);
  });

  test("has no diff when no transcript entry carries the call", () => {
    const other = toolEntry("c2", "Edit", { path: "x.ts", old_string: "a", new_string: "b" });
    const card = approvalCard({ tool: "Edit", callId: "c1", command: undefined }, { entries: [other] });
    expect(card.diff).toEqual([]);
  });

  test("has no diff for a Bash approval", () => {
    const card = approvalCard({ tool: "Bash", callId: "c1" }, { entries: [REPLACEMENT] });
    expect(card.diff).toEqual([]);
  });

  test("has no diff for a Write approval", () => {
    const written = toolEntry("c1", "Write", { path: "y.ts", content: "1\n2\n" });
    const card = approvalCard({ tool: "Write", callId: "c1" }, { entries: [written] });
    expect(card.diff).toEqual([]);
  });

  test("has no diff for an Edit approval that names no call", () => {
    const card = approvalCard({ tool: "Edit", command: undefined }, { entries: [REPLACEMENT] });
    expect(card.diff).toEqual([]);
  });

  test("has no diff when the recorded call carries only one side of the replacement", () => {
    const partial = toolEntry("c1", "Edit", { path: "x.ts", new_string: "b" });
    const card = approvalCard({ tool: "Edit", callId: "c1", command: undefined }, { entries: [partial] });
    expect(card.diff).toEqual([]);
  });

  test("sanitises the diff lines it returns", () => {
    const old = toolEntry("c1", "Edit", { path: "x.ts", old_string: "\u001b[31ma", new_string: "b" });
    const card = approvalCard({ tool: "Edit", callId: "c1", command: undefined }, { entries: [old] });
    expect(card.diff).toEqual([
      { sign: "-", text: "a" },
      { sign: "+", text: "b" },
    ]);
  });
});

describe("askCardModel question", () => {
  test("titles a question nax asks", () => {
    expect(questionCard().title).toBe(ASK_QUESTION_TITLE);
  });

  test("returns the question's own text, sanitised", () => {
    expect(questionCard({ text: "which\u001b[0m package?" }).text).toBe("which package?");
  });
});

test("US-012 AC-9: host choice model carries numbered labels and opaque ids", () => {
  const model = askCardModel(
    {
      type: "host_choice",
      requestId: "host-choice-1",
      tool: "nax-close",
      summary: "Quit?",
      reason: "Tasks are running",
      fallback: "stay",
      at: AT,
      expiresAt: EXPIRES_AT,
      choices: [
        { id: "stop", label: "Quit and stop them" },
        { id: "stay", label: "Stay in chat" },
      ],
    },
    { canRemember: false, entries: [] },
  );
  expect(model).toEqual({
    kind: "choice",
    title: "nax-close",
    summary: "Quit?",
    reason: "Tasks are running",
    fallback: "stay",
    options: [
      { index: 1, label: "Quit and stop them", id: "stop" },
      { index: 2, label: "Stay in chat", id: "stay" },
    ],
  });
});
