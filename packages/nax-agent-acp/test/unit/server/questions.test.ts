import { describe, expect, test } from "bun:test";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { AnswerReply } from "@nathapp/nax-agent";
import {
  ANSWER_FIELD,
  createQuestionBroker,
  DECLINED_TEXT,
  NO_ANSWER_TEXT,
  type QuestionEvent,
} from "#src/server/questions";
import { ALL_FEATURES, type FakePortOptions, fakePort, NEVER } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");

function question(requestId: string, extra: Partial<QuestionEvent> = {}): QuestionEvent {
  return {
    sessionId: "s1",
    turnId: "t1",
    at: "2026-10-09T00:00:00.000Z",
    metadata: {},
    type: "question",
    requestId,
    text: "Which environment?",
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...extra,
  };
}

function setup(options: FakePortOptions = {}) {
  const fake = fakePort(options);
  const answers: { requestId: string; reply: AnswerReply }[] = [];
  const { logger, lines } = recordingLogger();
  const broker = createQuestionBroker({
    port: fake.port,
    deliver: (update) => fake.port.update(update),
    answer: (requestId, reply) => {
      answers.push({ requestId, reply });
      return "accepted";
    },
    logger,
    now: () => NOW,
  });
  return { ...fake, answers, lines, broker };
}

describe("createQuestionBroker with elicitation (spec §4.3)", () => {
  test("sends a form with one required answer field and passes the accepted text on", async () => {
    const s = setup({
      features: ALL_FEATURES,
      elicit: async () => ({ action: "accept", content: { [ANSWER_FIELD]: "staging" } }),
    });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.forms[0]).toEqual({
      message: "Which environment?",
      requestedSchema: {
        type: "object",
        properties: { [ANSWER_FIELD]: { type: "string", title: "Answer" } },
        required: [ANSWER_FIELD],
      },
    });
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: "staging" } }]);
  });

  test("decline, cancel and an empty accept all answer with the declined text", async () => {
    const replies: CreateElicitationResponse[] = [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: {} },
      { action: "accept", content: { [ANSWER_FIELD]: "   " } },
    ];
    for (const reply of replies) {
      const s = setup({ features: ALL_FEATURES, elicit: async () => reply });
      s.broker.ask(question("q1"));
      await s.broker.drain();
      expect(s.answers).toEqual([{ requestId: "q1", reply: { text: DECLINED_TEXT } }]);
    }
  });

  test("a failing elicitation answers with the no-answer text, logged at warn (M-13)", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: async () => Promise.reject(new Error("Method not found")) });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: NO_ANSWER_TEXT } }]);
    expect(s.lines[0]).toMatchObject({ level: "warn" });
  });

  test("the elicitation is aborted at expiresAt, with no answer (M-14)", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: NEVER });
    s.broker.ask(question("q1", { expiresAt: new Date(NOW + 20).toISOString() }));
    await s.broker.drain();
    expect(s.signals[0]?.aborted).toBe(true);
    expect(s.answers).toEqual([]);
  });

  test("abortAll stops waiting on an open elicitation", async () => {
    const s = setup({ features: ALL_FEATURES, elicit: NEVER });
    s.broker.ask(question("q1"));
    s.broker.abortAll();
    await s.broker.drain();
    expect(s.answers).toEqual([]);
  });
});

describe("createQuestionBroker without elicitation", () => {
  test("shows the question, then answers at once with the no-answer text", async () => {
    const s = setup({ features: { updates: { notices: true, compaction: false }, elicitation: false } });
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.forms).toEqual([]);
    expect(s.updates).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "The agent asked a question",
        description: "Which environment?",
      },
    ]);
    expect(s.answers).toEqual([{ requestId: "q1", reply: { text: NO_ANSWER_TEXT } }]);
  });

  test("a client without notices gets the question as agent text", async () => {
    const s = setup();
    s.broker.ask(question("q1"));
    await s.broker.drain();
    expect(s.updates[0]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    expect(JSON.stringify(s.updates[0])).toContain("Which environment?");
  });
});

describe("an unanswerable question (M-1)", () => {
  test("is shown as information and never answered or elicited", async () => {
    const s = setup({ features: ALL_FEATURES });
    s.broker.ask(question("q1", { answerable: false, text: "declined: pick a file" }));
    await s.broker.drain();
    expect(s.forms).toEqual([]);
    expect(s.answers).toEqual([]);
    expect(s.updates[0]).toMatchObject({
      sessionUpdate: "notice",
      severity: "info",
      description: "declined: pick a file",
    });
  });
});
