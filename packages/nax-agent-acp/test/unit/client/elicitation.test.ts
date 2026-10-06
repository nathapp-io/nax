import { describe, expect, test } from "bun:test";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import {
  answerElicitation,
  type ElicitationContext,
  MAX_CHOICES,
  MAX_FORM_FIELDS,
  NO_MATCH_NOTE,
  QUESTION_MAX_BYTES,
  REQUIRED_NOTE,
} from "#src/client/elicitation";

const SECRET = "s3cr3t-token-value-0123";

function askPort(replies: readonly (string | null)[]) {
  const questions: string[] = [];
  const notes: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const asks: SessionAskPort = {
    requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
    recordAutoDecision: () => {},
    askQuestion: async (text, opts) => {
      questions.push(text);
      signals.push(opts?.signal);
      return replies[questions.length - 1] ?? null;
    },
    noteQuestion: (text) => {
      notes.push(text);
    },
  };
  return { asks, questions, notes, signals };
}

function context(asks: SessionAskPort, extra: Partial<ElicitationContext> = {}): ElicitationContext {
  return { profile: "ask", asks, secrets: [SECRET], signal: new AbortController().signal, ...extra };
}

/** A form request as the agent sends it; JSON.parse keeps malformed shapes possible without casts. */
function form(
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  message = "Pick one",
): CreateElicitationRequest {
  return JSON.parse(
    JSON.stringify({
      mode: "form",
      sessionId: "s",
      message,
      requestedSchema: { type: "object", properties, ...extra },
    }),
  );
}

/** Claude's AskUserQuestion with one single-select question (elicitation.js askUserQuestionsToCreateRequest). */
const CLAUDE_SINGLE = form({
  question_0: {
    type: "string",
    title: "Auth",
    oneOf: [
      { const: "OAuth", title: "OAuth", description: "Browser login" },
      { const: "API key", title: "API key" },
    ],
  },
  question_0_custom: { type: "string", title: "Other", description: "Type your own answer (optional)." },
});

async function answer(
  request: CreateElicitationRequest,
  replies: readonly (string | null)[],
  profile: AgentSessionProfile = "ask",
) {
  const port = askPort(replies);
  const response = await answerElicitation(request, context(port.asks, { profile }));
  return { response, ...port };
}

describe("answerElicitation: Claude's AskUserQuestion forms (D5-i)", () => {
  test("one question: message, header, numbered choices and the instruction; a number picks a choice", async () => {
    const { response, questions } = await answer(CLAUDE_SINGLE, ["2"]);
    expect(response).toEqual({ action: "accept", content: { question_0: "API key" } });
    expect(questions).toEqual([
      [
        "Pick one",
        "Auth",
        "1. OAuth - Browser login",
        "2. API key",
        "Reply with one number or choice, or type your own answer. Leave empty to skip.",
      ].join("\n"),
    ]);
  });

  test("a choice's text in any case, trimmed, picks it", async () => {
    expect((await answer(CLAUDE_SINGLE, ["  oauth "])).response).toEqual({
      action: "accept",
      content: { question_0: "OAuth" },
    });
  });

  test("a reply naming no choice becomes the custom answer", async () => {
    expect((await answer(CLAUDE_SINGLE, ["Use mTLS"])).response).toEqual({
      action: "accept",
      content: { question_0_custom: "Use mTLS" },
    });
  });

  test("an empty reply skips the optional question", async () => {
    expect((await answer(CLAUDE_SINGLE, [""])).response).toEqual({ action: "accept", content: {} });
  });

  test("several questions with a multi-select: one question each, comma lists, extras go to the custom field", async () => {
    const request = form(
      {
        question_0: {
          type: "string",
          title: "Auth",
          description: "Which auth method?",
          oneOf: [{ const: "OAuth", title: "OAuth" }],
        },
        question_0_custom: { type: "string", title: "Other" },
        question_1: {
          type: "array",
          title: "Cache",
          description: "Which caches?",
          items: {
            anyOf: [
              { const: "Redis", title: "Redis" },
              { const: "Memcached", title: "Memcached" },
            ],
          },
        },
        question_1_custom: { type: "string", title: "Other" },
      },
      {},
      "Please answer the following questions.",
    );
    const { response, questions } = await answer(request, ["1", "redis, 2, Hazelcast, Redis"]);
    expect(response).toEqual({
      action: "accept",
      content: { question_0: "OAuth", question_1: ["Redis", "Memcached"], question_1_custom: "Hazelcast" },
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]?.split("\n").slice(0, 2)).toEqual([
      "Please answer the following questions.",
      "(1/2) Auth: Which auth method?",
    ]);
    expect(questions[1]?.split("\n")[0]).toBe("(2/2) Cache: Which caches?");
    expect(questions[1]).toContain("Reply with numbers or choices, separated by commas, or type your own answer.");
  });
});

describe("answerElicitation: other forms (D5-i)", () => {
  test("message only: the message is asked; any reply accepts with empty content", async () => {
    const { response, questions } = await answer(form({}), ["ok"]);
    expect(response).toEqual({ action: "accept", content: {} });
    expect(questions).toEqual(["Pick one"]);
  });

  test("a single string field takes the reply as written", async () => {
    const request = form({ name: { type: "string", title: "Branch name" } });
    const { response, questions } = await answer(request, ["feat/x"]);
    expect(response).toEqual({ action: "accept", content: { name: "feat/x" } });
    expect(questions[0]).toBe("Pick one\nBranch name\nReply with your answer, or leave it empty to skip.");
  });

  test("an untitled enum matches by value", async () => {
    const request = form({ env: { type: "string", enum: ["staging", "prod"] } });
    expect((await answer(request, ["PROD"])).response).toEqual({ action: "accept", content: { env: "prod" } });
  });

  test("Claude's refusal-fallback prompt: a single oneOf field with no companion", async () => {
    const request = form({
      choice: {
        type: "string",
        oneOf: [
          { const: "retry_fallback", title: "Retry with Opus" },
          { const: "keep_refusal", title: "Keep the refusal" },
        ],
      },
    });
    expect((await answer(request, ["retry with opus"])).response).toEqual({
      action: "accept",
      content: { choice: "retry_fallback" },
    });
  });

  test("a reply naming no choice, with no companion, declines with a note", async () => {
    const request = form({ env: { type: "string", enum: ["staging", "prod"] } });
    const { response, notes } = await answer(request, ["qa"]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([NO_MATCH_NOTE]);
  });

  test("an empty reply to a required field declines with a note", async () => {
    const request = form({ name: { type: "string" } }, { required: ["name"] });
    const { response, notes } = await answer(request, ["  "]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([REQUIRED_NOTE]);
  });

  test("no reply cancels, and later questions are not asked", async () => {
    const request = form({ a: { type: "string" }, b: { type: "string" } });
    const { response, questions } = await answer(request, [null, "never asked"]);
    expect(response).toEqual({ action: "cancel" });
    expect(questions).toHaveLength(1);
  });

  test("a __proto__ field is answered as data", async () => {
    const request = form(JSON.parse('{"__proto__": {"type": "string"}}'));
    const { response } = await answer(request, ["x"]);
    expect(response.action).toBe("accept");
    expect(Object.prototype).not.toHaveProperty("type");
    expect(Object.getOwnPropertyNames("content" in response ? response.content : {})).toEqual(["__proto__"]);
  });
});

describe("answerElicitation: declined before asking (D5-i)", () => {
  test.each([
    ["a number field", { n: { type: "number" } }],
    ["a boolean field", { b: { type: "boolean" } }],
    ["an unknown type", { x: { type: "_custom" } }],
    ["an empty enum", { e: { type: "string", enum: [] } }],
    ["a malformed choice", { e: { type: "string", oneOf: [{ title: "no const" }] } }],
    ["too many choices", { e: { type: "string", enum: Array.from({ length: MAX_CHOICES + 1 }, (_, i) => `c${i}`) } }],
    ["a multi-select without choices", { m: { type: "array", items: { type: "string" } } }],
    [
      "too many fields",
      Object.fromEntries(Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => [`f${i}`, { type: "string" }])),
    ],
  ])("%s: noted and declined, nothing asked", async (_label, properties) => {
    const { response, questions, notes } = await answer(form(properties), ["x"]);
    expect(response).toEqual({ action: "decline" });
    expect(questions).toEqual([]);
    expect(notes).toEqual(["declined: Pick one"]);
  });

  test("a url-mode request is noted and declined", async () => {
    const request: CreateElicitationRequest = {
      mode: "url",
      sessionId: "s",
      message: "Log in",
      elicitationId: "e1",
      url: "https://example.com",
    };
    const { response, notes } = await answer(request, ["x"]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual(["declined: Log in"]);
  });

  test("under none and read: declined with no question and no note", async () => {
    for (const profile of ["none", "read"] as const) {
      const { response, questions, notes } = await answer(CLAUDE_SINGLE, ["1"], profile);
      expect(response).toEqual({ action: "decline" });
      expect(questions).toEqual([]);
      expect(notes).toEqual([]);
    }
  });
});

describe("answerElicitation: signal and hygiene (D5-i, D5-j)", () => {
  test("each question is asked under the context's signal", async () => {
    const port = askPort(["1"]);
    const signal = new AbortController().signal;
    await answerElicitation(CLAUDE_SINGLE, context(port.asks, { signal }));
    expect(port.signals).toHaveLength(1);
    expect(port.signals[0]).toBe(signal);
  });

  test("an aborted signal cancels without asking", async () => {
    const port = askPort(["1"]);
    const response = await answerElicitation(CLAUDE_SINGLE, context(port.asks, { signal: AbortSignal.abort() }));
    expect(response).toEqual({ action: "cancel" });
    expect(port.questions).toEqual([]);
  });

  test("a throwing ask port cancels", async () => {
    const port = askPort([]);
    const asks: SessionAskPort = {
      ...port.asks,
      askQuestion: async () => {
        throw new Error("port broke");
      },
    };
    expect(await answerElicitation(CLAUDE_SINGLE, context(asks))).toEqual({ action: "cancel" });
  });

  test("question text is stripped, scrubbed and capped", async () => {
    const message = `Use ${SECRET}?‮\u0007 ${"m".repeat(10_000)}`;
    const { questions } = await answer(form({}, {}, message), ["y"]);
    expect(questions[0]).not.toContain(SECRET);
    expect(questions[0]).not.toContain("‮");
    expect(questions[0]).not.toContain("\u0007");
    expect(Buffer.byteLength(questions[0] ?? "")).toBeLessThanOrEqual(QUESTION_MAX_BYTES);
  });

  test("a declined form's note is scrubbed too", async () => {
    const { notes } = await answer(form({ n: { type: "number" } }, {}, `token ${SECRET}`), []);
    expect(notes).toEqual(["declined: token [REDACTED]"]);
  });
});
