import { describe, expect, test } from "bun:test";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  CHOICE_HEADER_MAX_CHARS,
  type ChoiceAskResult,
  type ChoiceQuestion,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { answerElicitation, type ElicitationContext, NO_MATCH_NOTE, REQUIRED_NOTE } from "#src/client/elicitation";

const SECRET = "s3cr3t-token-value-0123";

/** One recorded `askChoices` call. */
interface Asked {
  readonly prompt: string;
  readonly questions: readonly ChoiceQuestion[];
  readonly signal: AbortSignal | undefined;
}

interface ChoicePortOptions {
  /** Text replies for the one-field-at-a-time path. */
  readonly replies?: readonly (string | null)[];
  /** Runs inside `askChoices` before it answers: a turn that ends mid-ask. */
  readonly duringAsk?: () => void;
}

/**
 * A scripted ask port that offers `askChoices`: `choice` is what it answers, an
 * Error is thrown, and `null` is the deadline/cancel/turn-end answer.
 */
function choicePort(choice: ChoiceAskResult | null | Error, options: ChoicePortOptions = {}) {
  const asked: Asked[] = [];
  const texts: string[] = [];
  const notes: string[] = [];
  const asks: SessionAskPort = {
    requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
    recordAutoDecision: () => {},
    askQuestion: async (text) => {
      texts.push(text);
      return options.replies?.[texts.length - 1] ?? null;
    },
    askChoices: async (prompt, questions, opts) => {
      asked.push({ prompt, questions, signal: opts?.signal });
      options.duringAsk?.();
      if (choice instanceof Error) throw choice;
      return choice;
    },
    noteQuestion: (text) => {
      notes.push(text);
    },
  };
  return { asks, asked, texts, notes };
}

/** A port with no choice surface: the one-field-at-a-time text path only. */
function textPort(replies: readonly (string | null)[]) {
  const texts: string[] = [];
  const notes: string[] = [];
  const asks: SessionAskPort = {
    requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
    recordAutoDecision: () => {},
    askQuestion: async (text) => {
      texts.push(text);
      return replies[texts.length - 1] ?? null;
    },
    noteQuestion: (text) => {
      notes.push(text);
    },
  };
  return { asks, texts, notes };
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

const RUNNER = { type: "string", title: "Runner", enum: ["bun", "vitest"] };

/** `runner` (bun, vitest) beside its free-text companion: the "Other" box Claude sends. */
function runnerForm(message = "Which runner?"): CreateElicitationRequest {
  return form({ runner: RUNNER, runner_custom: { type: "string", title: "Other" } }, {}, message);
}

function answered(...selected: number[]): ChoiceAskResult {
  return { text: "", answers: [{ selected }] };
}

describe("answerElicitation: a select-only form becomes one choice ask (US-003)", () => {
  test("AC-1: one askChoices call with the field as a choice question, and no text question", async () => {
    const port = choicePort(answered(1));
    const response = await answerElicitation(runnerForm(), context(port.asks));

    expect(port.asked).toHaveLength(1);
    expect(port.texts).toEqual([]);
    expect(port.asked[0]?.prompt).toBe("Which runner?");
    expect(port.asked[0]?.questions).toEqual([
      {
        header: "Runner",
        question: "Runner",
        options: [{ label: "bun" }, { label: "vitest" }],
        multiSelect: false,
        allowOther: true,
        required: false,
      },
    ]);
    expect(response.action).toBe("accept");
  });

  test("AC-2: the selected index accepts with that choice's value", async () => {
    expect(await answerElicitation(runnerForm(), context(choicePort(answered(1)).asks))).toEqual({
      action: "accept",
      content: { runner: "vitest" },
    });
  });

  test("AC-3: an other answer alone accepts with the companion field's key", async () => {
    const port = choicePort({ text: "", answers: [{ selected: [], other: "deno" }] });
    expect(await answerElicitation(runnerForm(), context(port.asks))).toEqual({
      action: "accept",
      content: { runner_custom: "deno" },
    });
  });

  test("AC-4: an empty answer to a non-required field accepts with empty content", async () => {
    expect(await answerElicitation(runnerForm(), context(choicePort(answered()).asks))).toEqual({
      action: "accept",
      content: {},
    });
  });
});

describe("answerElicitation: a required select keeps its rule under a choice ask (US-003)", () => {
  const AUTH = { type: "string", title: "Auth", enum: ["oauth", "api-key"] };
  const CHECKS = { type: "array", title: "Checks", items: { enum: ["lint", "typecheck", "tests"] } };

  test("AC-5: a required single-select with a companion offers no other", async () => {
    const request = form({ auth: AUTH, auth_custom: { type: "string" } }, { required: ["auth"] });
    const port = choicePort(answered(0));
    await answerElicitation(request, context(port.asks));

    expect(port.asked[0]?.questions[0]).toMatchObject({ allowOther: false, required: true, multiSelect: false });
  });

  test("AC-6: a required multi-select answered with only other declines as required", async () => {
    const request = form({ checks: CHECKS, checks_custom: { type: "string" } }, { required: ["checks"] });
    const port = choicePort({ text: "", answers: [{ selected: [], other: "e2e" }] });
    const response = await answerElicitation(request, context(port.asks));

    expect(port.asked[0]?.questions[0]).toMatchObject({ allowOther: true, required: true, multiSelect: true });
    expect(response).toEqual({ action: "decline" });
    expect(port.notes).toEqual([REQUIRED_NOTE]);
  });
});

describe("answerElicitation: mapping a choice ask back to form content (US-003)", () => {
  test("AC-7: a multi-select accepts its selected values in index order", async () => {
    const request = form({
      checks: { type: "array", title: "Checks", items: { enum: ["lint", "typecheck", "tests"] } },
    });
    const port = choicePort(answered(0, 2));
    const response = await answerElicitation(request, context(port.asks));

    expect(port.asked).toHaveLength(1);
    expect(response).toEqual({ action: "accept", content: { checks: ["lint", "tests"] } });
  });

  test("AC-8: two select fields are one call with two questions in field order", async () => {
    const request = form(
      { runner: RUNNER, mode: { type: "string", title: "Mode", enum: ["fast", "safe"] } },
      {},
      "Configure",
    );
    const port = choicePort({ text: "", answers: [{ selected: [1] }, { selected: [0] }] });
    const response = await answerElicitation(request, context(port.asks));

    expect(port.asked).toHaveLength(1);
    expect(port.asked[0]?.questions.map((question) => question.header)).toEqual(["Runner", "Mode"]);
    expect(response).toEqual({ action: "accept", content: { runner: "vitest", mode: "fast" } });
  });

  test("AC-9: control bytes are stripped from the prompt, header and option labels", async () => {
    const request = form(
      { runner: { type: "string", title: "Run\u001bner", enum: ["b\u001bun", "vitest"] } },
      {},
      "Run\u001b it",
    );
    const port = choicePort(answered(0));
    await answerElicitation(request, context(port.asks));

    expect(port.asked[0]?.prompt).toBe("Run it");
    expect(port.asked[0]?.questions[0]?.header).toBe("Runner");
    expect(port.asked[0]?.questions[0]?.options.map((option) => option.label)).toEqual(["bun", "vitest"]);
  });

  test("AC-9: a long field title becomes a header of CHOICE_HEADER_MAX_CHARS characters", async () => {
    const title = "R".repeat(40);
    const request = form({ runner: { type: "string", title, enum: ["bun", "vitest"] } });
    const port = choicePort(answered(0));
    await answerElicitation(request, context(port.asks));

    const header = port.asked[0]?.questions[0]?.header;
    expect(header).toHaveLength(CHOICE_HEADER_MAX_CHARS);
    expect(header).toBe(title.slice(0, CHOICE_HEADER_MAX_CHARS));
  });
});

describe("answerElicitation: a plain reply and a cancelled choice ask (US-003)", () => {
  test("AC-10: a one-field form's plain reply goes through the existing reply matching", async () => {
    const port = choicePort({ text: "2" });
    expect(await answerElicitation(runnerForm(), context(port.asks))).toEqual({
      action: "accept",
      content: { runner: "vitest" },
    });
  });

  test("AC-11: a two-field form's plain reply declines as no match", async () => {
    const request = form({ runner: RUNNER, mode: { type: "string", title: "Mode", enum: ["fast", "safe"] } });
    const port = choicePort({ text: "1" });
    const response = await answerElicitation(request, context(port.asks));

    expect(response).toEqual({ action: "decline" });
    expect(port.notes).toEqual([NO_MATCH_NOTE]);
  });

  test("AC-12: a null result and a rejecting askChoices both cancel", async () => {
    expect(await answerElicitation(runnerForm(), context(choicePort(null).asks))).toEqual({ action: "cancel" });
    const broken = choicePort(new Error("port broke"));
    expect(await answerElicitation(runnerForm(), context(broken.asks))).toEqual({ action: "cancel" });
    expect(broken.asked).toHaveLength(1);
  });

  test("AC-13: the context's signal is passed, and an aborted context cancels without asking", async () => {
    const signal = new AbortController().signal;
    const port = choicePort(answered(0));
    await answerElicitation(runnerForm(), context(port.asks, { signal }));
    expect(port.asked[0]?.signal).toBe(signal);

    const aborted = choicePort(answered(0));
    const response = await answerElicitation(runnerForm(), context(aborted.asks, { signal: AbortSignal.abort() }));
    expect(response).toEqual({ action: "cancel" });
    expect(aborted.asked).toEqual([]);
  });

  test("AC-17: a choice ask cut short by the turn ending (null) cancels", async () => {
    const controller = new AbortController();
    const port = choicePort(null, { duringAsk: () => controller.abort() });
    const response = await answerElicitation(runnerForm(), context(port.asks, { signal: controller.signal }));

    expect(port.asked).toHaveLength(1);
    expect(response).toEqual({ action: "cancel" });
    expect(port.notes).toEqual([]);
  });
});

describe("answerElicitation: forms that keep the one-field-at-a-time text path (US-003)", () => {
  test("AC-14: a form mixing a text field with a select field asks one field at a time", async () => {
    const request = form({ branch: { type: "string", title: "Branch" }, runner: RUNNER }, {}, "Set up");
    const port = choicePort(answered(0), { replies: ["feat/x", "2"] });
    const response = await answerElicitation(request, context(port.asks));

    expect(port.asked).toEqual([]);
    expect(port.texts).toHaveLength(2);
    expect(response).toEqual({ action: "accept", content: { branch: "feat/x", runner: "vitest" } });
  });

  test("AC-15: five select fields ask one field at a time", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: "string", title: `F${i}`, enum: ["a", "b"] }]),
    );
    const port = choicePort(answered(0), { replies: ["1", "1", "1", "1", "1"] });
    const response = await answerElicitation(form(properties), context(port.asks));

    expect(port.asked).toEqual([]);
    expect(port.texts).toHaveLength(5);
    expect(response).toEqual({
      action: "accept",
      content: { f0: "a", f1: "a", f2: "a", f3: "a", f4: "a" },
    });
  });

  test("AC-16: a port without askChoices asks the rendered fields as before", async () => {
    const port = textPort(["1"]);
    const response = await answerElicitation(runnerForm(), context(port.asks));

    expect(port.texts).toHaveLength(1);
    expect(port.texts[0]?.split("\n")).toEqual([
      "Which runner?",
      "Runner",
      "1. bun",
      "2. vitest",
      "Reply with one number or choice, or type your own answer. Leave empty to skip.",
    ]);
    expect(response).toEqual({ action: "accept", content: { runner: "bun" } });
  });
});
