/**
 * US-002 — native `ask_human` offers choice questions.
 *
 * The tool's schema gains an optional `questions` array, the turn loop's
 * `ask_human` branch parses it before dispatching, and the request it hands the
 * interaction handler carries the rendered text plus the parsed questions.
 * `createSessionInteractionHandler` prefers the ask port's `askChoices` when the
 * request carries questions and the port has one; every other path keeps
 * today's `askQuestion(text)`, which already carries the rendered options.
 *
 * The two harnesses are the ones this story was specified against:
 * `turn-loop-seam.test.ts` (a scripted `runNativeTurn`) and
 * `session-adapter-abort-reasons.test.ts` (`createSessionInteractionHandler`
 * over a fake `asks`). AC-9 / AC-10 additionally drive the REAL ask port over a
 * real pending-ask table, so the plain-text reply and the cancelled ask travel
 * the production path rather than a stub's return value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_HUMAN_TOOL_NAME, askHumanToolDefinition, NATIVE_CHOICE_MAX_OPTIONS } from "#src/native/session/ask-human";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { loadTranscript } from "#src/native/session/transcript-store";
import { handleAskHumanCall } from "#src/native/session/turn-ask-human";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { NativeTurnResponse } from "#src/native/session/turn-types";
import type { SessionEventBody } from "#src/session/agent-session-types";
import { type ChoiceAskResult, type ChoiceQuestion, renderChoiceQuestionsText } from "#src/session/choice-questions";
import type { AdapterInteraction, InteractionHandler } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import type { SessionAskPort } from "#src/session/session-backend";
import { createSessionInteractionHandler } from "#src/session/session-interaction";
import { compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import { seedNativeSession } from "#test/helpers/index";

const baseUsage = { inputTokens: 1, outputTokens: 1 };
const NO_OPERATOR = "No human operator is available for this run. Proceed on your best judgement.";
const INVALID_PREFIX = "Invalid questions: ";

/** The one question every harness test sends; `header` is absent, so the parser names it Q1. */
const RAW_QUESTION = {
  question: "Which checks?",
  options: [{ label: "lint" }, { label: "tests" }, { label: "types" }],
};

/** The same question as the parser builds it. */
const PARSED_QUESTION: ChoiceQuestion = {
  header: "Q1",
  question: "Which checks?",
  options: [{ label: "lint" }, { label: "tests" }, { label: "types" }],
  multiSelect: false,
  allowOther: true,
  required: true,
};

/** A hand-built question for the unit-level `handleAskHumanCall` cases. */
const UNIT_QUESTION: ChoiceQuestion = {
  header: "Checks",
  question: "Which checks?",
  options: [{ label: "lint" }, { label: "tests", description: "the full suite" }, { label: "types" }],
  multiSelect: true,
  allowOther: true,
  required: true,
};

const handle = { id: "sess-choice", agentName: "native" } as const;

let dir: string;
let sessionState: NativeSessionState;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-ask-choices-"));
  sessionState = seedNativeSession(createNativeSessionState(), handle.id, { transcriptDir: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── shared harness ───────────────────────────────────────────────────────────

interface ChoiceRecorder {
  readonly port: SessionAskPort;
  readonly choiceCalls: { prompt: string; questions: readonly ChoiceQuestion[] }[];
  readonly questionCalls: string[];
}

/** A fake ask port that HAS `askChoices`, recording what it was asked. */
function fakeAsks(
  reply: (prompt: string, questions: readonly ChoiceQuestion[]) => ChoiceAskResult | null,
): ChoiceRecorder {
  const choiceCalls: { prompt: string; questions: readonly ChoiceQuestion[] }[] = [];
  const questionCalls: string[] = [];
  return {
    choiceCalls,
    questionCalls,
    port: {
      requestApproval: async () => ({ decision: "allow", decidedBy: "profile" }),
      recordAutoDecision: () => {},
      askQuestion: async (text) => {
        questionCalls.push(text);
        return "typed the answer";
      },
      askChoices: async (prompt, questions) => {
        choiceCalls.push({ prompt, questions });
        return reply(prompt, questions);
      },
      noteQuestion: () => {},
    },
  };
}

/** A fake ask port with NO `askChoices`: the text path only. */
function textOnlyAsks(): { port: SessionAskPort; questionCalls: string[] } {
  const questionCalls: string[] = [];
  return {
    questionCalls,
    port: {
      requestApproval: async () => ({ decision: "allow", decidedBy: "profile" }),
      recordAutoDecision: () => {},
      askQuestion: async (text) => {
        questionCalls.push(text);
        return "typed the answer";
      },
      noteQuestion: () => {},
    },
  };
}

/** The production interaction handler over a real coding-tool runtime and `asks`. */
function sessionHandler(asks: SessionAskPort): InteractionHandler {
  return createSessionInteractionHandler({
    sessionId: handle.id,
    runtime: createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], dir) }),
    embedderTools: new Map(),
    asks,
    turnSignal: () => new AbortController().signal,
    setCurrentCallId: () => {},
  });
}

/** One scripted `ask_human` call, as the model would emit it. */
function askCall(id: string, input: { readonly text: string; readonly questions?: unknown }) {
  return { id, name: ASK_HUMAN_TOOL_NAME, input };
}

/** Replays `steps` in order; the last one repeats, which ends every turn with plain text. */
function scriptedTurn(steps: readonly NativeTurnResponse[]): () => Promise<NativeTurnResponse> {
  let round = 0;
  return async () => {
    const step = steps[Math.min(round, steps.length - 1)] ?? { text: "done", usage: baseUsage, costUsd: 0 };
    round += 1;
    return step;
  };
}

async function runScripted(options: {
  readonly interactionHandler: InteractionHandler;
  readonly steps: readonly NativeTurnResponse[];
  readonly maxInteractions?: number;
}): Promise<void> {
  await runNativeTurn(
    handle,
    "hi",
    {
      interactionHandler: options.interactionHandler,
      codingTools: [],
      maxInteractions: options.maxInteractions ?? 5,
    },
    { sessionState, complete: scriptedTurn(options.steps) },
  );
}

/** The tool-result message the model receives for one call id. */
async function toolResultFor(toolCallId: string) {
  const saved = await loadTranscript(dir, handle.id);
  const message = saved.find((m) => m.role === "tool-result" && m.toolCallId === toolCallId);
  return message === undefined || message.role !== "tool-result" ? undefined : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── AC-1: the tool schema advertises the optional questions array ─────────────

describe("askHumanToolDefinition — the questions property (AC-1)", () => {
  test("AC-1: properties.questions is an array, and required is still exactly [text]", () => {
    const schema = askHumanToolDefinition.inputSchema;
    expect(schema.required).toEqual(["text"]);

    const properties = schema.properties;
    if (!isRecord(properties)) throw new Error("expected the schema to declare properties");
    const questions = properties.questions;
    if (!isRecord(questions)) throw new Error("expected a questions property");
    expect(questions.type).toBe("array");

    // The description is what teaches the model the option range, multi-select
    // and that a person may always answer in their own words.
    const described = `${String(questions.description ?? "")}`;
    expect(described).toContain("2 to 8 options");
    expect(described).toContain("multiSelect");
    expect(described).toContain("own answer");
  });

  test("AC-8 (limit): NATIVE_CHOICE_MAX_OPTIONS is 8", () => {
    expect(NATIVE_CHOICE_MAX_OPTIONS).toBe(8);
  });
});

// ── AC-2 / AC-3: handleAskHumanCall's request shape ──────────────────────────

describe("handleAskHumanCall — the request it sends (AC-2 / AC-3)", () => {
  test("AC-2: with questions it sends the rendered text, the prompt and the questions once", async () => {
    const requests: AdapterInteraction[] = [];
    const questions = [UNIT_QUESTION];

    const outcome = await handleAskHumanCall({
      toolCallId: "q1",
      question: "Pick",
      questions,
      interactionsSoFar: 0,
      maxInteractions: 5,
      roundTrips: 1,
      interactionHandler: {
        onInteraction: async (request) => {
          requests.push(request);
          return { answer: "Which checks? -> tests" };
        },
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      kind: "question",
      text: renderChoiceQuestionsText("Pick", questions),
      prompt: "Pick",
      questions,
    });
    expect(outcome.result.content).toBe("Which checks? -> tests");
    expect(outcome.exchange).toEqual({
      turnIndex: 1,
      question: renderChoiceQuestionsText("Pick", questions),
      reply: "Which checks? -> tests",
    });
  });

  test("AC-3: without questions it sends exactly { kind, text }", async () => {
    const requests: AdapterInteraction[] = [];

    const outcome = await handleAskHumanCall({
      toolCallId: "q1",
      question: "which db?",
      interactionsSoFar: 0,
      maxInteractions: 5,
      roundTrips: 2,
      interactionHandler: {
        onInteraction: async (request) => {
          requests.push(request);
          return { answer: "postgres" };
        },
      },
    });

    expect(requests).toEqual([{ kind: "question", text: "which db?" }]);
    // Not merely equal — the request carries no `prompt` / `questions` KEY at all.
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual(["kind", "text"]);
    expect(outcome.result.content).toBe("postgres");
    expect(outcome.exchange).toEqual({ turnIndex: 2, question: "which db?", reply: "postgres" });
  });
});

// ── AC-6: a port without askChoices keeps the text path ─────────────────────

describe("createSessionInteractionHandler — a port with no askChoices (AC-6)", () => {
  test("AC-6: a question request carrying questions falls back to askQuestion(text)", async () => {
    const asks = textOnlyAsks();
    const handler = sessionHandler(asks.port);
    const text = renderChoiceQuestionsText("Pick", [UNIT_QUESTION]);

    const response = await handler.onInteraction({
      kind: "question",
      text,
      prompt: "Pick",
      questions: [UNIT_QUESTION],
    });

    expect(asks.questionCalls).toEqual([text]);
    expect(response).toEqual({ answer: "typed the answer" });
  });
});

// ── AC-4 / AC-5 / AC-7 / AC-8 / AC-9 / AC-10: the scripted native turn ──────

describe("native turn — ask_human with a questions set", () => {
  test("AC-4: a scripted turn's questions reach askChoices and its text is the tool result", async () => {
    const asks = fakeAsks(() => ({ text: "Which checks? -> tests" }));

    await runScripted({
      interactionHandler: sessionHandler(asks.port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [RAW_QUESTION] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    expect(asks.choiceCalls).toHaveLength(1);
    expect(asks.choiceCalls[0]?.prompt).toBe("Pick");
    expect(asks.choiceCalls[0]?.questions).toEqual([PARSED_QUESTION]);
    expect(asks.questionCalls).toEqual([]);
    const result = await toolResultFor("q1");
    expect(result?.content).toBe("Which checks? -> tests");
    expect(result?.isError).toBeUndefined();
  });

  test("AC-5: an invalid questions set is an error result, spends no budget, and the next ask is answered", async () => {
    const asks = fakeAsks(() => ({ text: "Which checks? -> lint" }));
    const oneOption = { question: "Which check?", options: [{ label: "lint" }] };

    await runScripted({
      // One exchange is the whole budget: if the refused call had spent it, the
      // second call would be answered with the budget notice instead.
      maxInteractions: 1,
      interactionHandler: sessionHandler(asks.port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [oneOption] })],
          usage: baseUsage,
          costUsd: 0,
        },
        {
          text: "",
          toolCalls: [askCall("q2", { text: "Pick", questions: [RAW_QUESTION] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    const invalid = await toolResultFor("q1");
    expect(String(invalid?.content).startsWith(INVALID_PREFIX)).toBe(true);
    expect(String(invalid?.content)).toContain("questions[0].options");
    expect(invalid?.isError).toBe(true);

    // No interaction at all for the refused call; the valid one was asked.
    expect(asks.choiceCalls).toHaveLength(1);
    expect(asks.choiceCalls[0]?.questions).toEqual([PARSED_QUESTION]);

    const answered = await toolResultFor("q2");
    expect(answered?.content).toBe("Which checks? -> lint");
    expect(answered?.isError).toBeUndefined();
  });

  test("AC-8: a questions entry with 9 options is rejected as invalid", async () => {
    const asks = fakeAsks(() => ({ text: "never asked" }));
    const nineOptions = {
      question: "Which check?",
      options: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].map((label) => ({ label })),
    };

    await runScripted({
      interactionHandler: sessionHandler(asks.port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [nineOptions] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    const rejected = await toolResultFor("q1");
    expect(String(rejected?.content).startsWith(INVALID_PREFIX)).toBe(true);
    expect(String(rejected?.content)).toContain("expected 2-8 options, got 9");
    expect(asks.choiceCalls).toEqual([]);
  });

  test("AC-7: a fake askChoices resolving null answers with the no-operator text", async () => {
    const asks = fakeAsks(() => null);

    await runScripted({
      interactionHandler: sessionHandler(asks.port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [RAW_QUESTION] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    expect(asks.choiceCalls).toHaveLength(1);
    const result = await toolResultFor("q1");
    expect(result?.content).toBe(NO_OPERATOR);
    expect(result?.isError).toBe(true);
  });

  test("AC-9: a plain { text } reply from the embedder is passed to the model unchanged", async () => {
    // The REAL ask port: the embedder answers the emitted question with a plain
    // { text } reply, i.e. a typed answer that is not one of the options.
    const table = createPendingAskTable(60_000);
    const events: SessionEventBody[] = [];
    const port = createSessionAskPort({
      table,
      emit: (body) => {
        events.push(body);
        if (body.type === "question") table.answer(body.requestId, { text: "none of these, run the smoke test" });
      },
      turn: () => ({ turnId: "turn-1", signal: new AbortController().signal }),
    });

    await runScripted({
      interactionHandler: sessionHandler(port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [RAW_QUESTION] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    // The ask really was a CHOICE ask (the port's choice path is the one that
    // emits `questions` / `prompt`), and the plain reply came back untouched.
    const asked = events.filter((event) => event.type === "question");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.type === "question" ? asked[0].questions : undefined).toEqual([PARSED_QUESTION]);
    const result = await toolResultFor("q1");
    expect(result?.content).toBe("none of these, run the smoke test");
    expect(result?.isError).toBeUndefined();
  });

  test("AC-10: a choice ask the turn cancels resolves null, answered like today", async () => {
    // The real ask port over a real table whose turn signal has already aborted:
    // the pending ask settles cancelled, `askChoices` resolves null, and the
    // loop answers exactly as it does for a text ask nobody could reach.
    const table = createPendingAskTable(60_000);
    const events: SessionEventBody[] = [];
    const cancelled = new AbortController();
    cancelled.abort();
    const port = createSessionAskPort({
      table,
      emit: (body) => {
        events.push(body);
      },
      turn: () => ({ turnId: "turn-2", signal: cancelled.signal }),
    });

    await runScripted({
      interactionHandler: sessionHandler(port),
      steps: [
        {
          text: "",
          toolCalls: [askCall("q1", { text: "Pick", questions: [RAW_QUESTION] })],
          usage: baseUsage,
          costUsd: 0,
        },
        { text: "done", usage: baseUsage, costUsd: 0 },
      ],
    });

    // The ask was issued to the host (the rendered options text) before it was
    // cancelled — the no-operator answer is the cancelled ask's, not a
    // never-issued one's.
    const asked = events.filter((event) => event.type === "question");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.type === "question" ? asked[0].text : "").toBe(
      renderChoiceQuestionsText("Pick", [PARSED_QUESTION]),
    );

    const result = await toolResultFor("q1");
    expect(result?.content).toBe(NO_OPERATOR);
    expect(result?.isError).toBe(true);
  });
});
