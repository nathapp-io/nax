import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime, opSelector } from "@test/helpers";
import { reviewConfigSelector } from "@/config";
import type { Finding } from "@/findings";
import type { NbfWorthCheckOpInput } from "@/operations";
import * as operations from "@/operations";
import { buildNbfWorthCheckPrompt } from "@/prompts";

const findingA: Finding = {
  source: "adversarial-review",
  severity: "warning",
  category: "input",
  file: "src/a.ts",
  line: 12,
  message: "empty items still fires MARK_DELIVERING",
};
const findingB: Finding = {
  source: "adversarial-review",
  severity: "info",
  category: "convention",
  file: "src/b.ts",
  line: 3,
  message: "stale header comment",
};
const baseInput: NbfWorthCheckOpInput = {
  story: makeStory({
    id: "US-002",
    title: "Deliver orders",
    description: "d",
    acceptanceCriteria: ["AC one"],
    status: "in-progress",
    attempts: 1,
  }),
  diff: "+x",
  findings: [findingA, findingB],
  pendingStories: [],
};

function makeCtx(worthCheck?: { mode: "on"; model?: "powerful"; timeoutMs?: number }) {
  const config = makeNaxConfig(
    worthCheck === undefined
      ? {}
      : {
          review: { nonBlockingFix: { worthCheck } },
        },
  );
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(reviewConfigSelector)) };
}

const ctx = makeCtx();
type WorthOutput =
  | {
      readonly parsed: true;
      readonly verdicts: readonly {
        readonly index: number;
        readonly verdict: "fix" | "skip";
        readonly reason: string;
      }[];
    }
  | { readonly parsed: false; readonly unparsedPreview: string };
type ReplyParser = (output: string, findingCount: number) => WorthOutput;
type WorthOperation = {
  readonly kind: unknown;
  readonly name: unknown;
  readonly stage: unknown;
  readonly config: unknown;
  readonly session: unknown;
  readonly tools: unknown;
  readonly model: (input: NbfWorthCheckOpInput, context: ReturnType<typeof makeCtx>) => unknown;
  readonly timeoutMs: (input: NbfWorthCheckOpInput, context: ReturnType<typeof makeCtx>) => number;
  readonly parse: (output: string, input: NbfWorthCheckOpInput, context: ReturnType<typeof makeCtx>) => WorthOutput;
  readonly build: (
    input: NbfWorthCheckOpInput,
    context: ReturnType<typeof makeCtx>,
  ) => { readonly task: { readonly content: string } };
};

function getParser(): ReplyParser {
  const parser: unknown = Object.getOwnPropertyDescriptor(operations, "parseNbfWorthReply")?.value;
  const isReplyParser = (value: unknown): value is ReplyParser => typeof value === "function";
  expect(typeof parser).toBe("function");
  if (!isReplyParser(parser)) throw new Error("parseNbfWorthReply export is unavailable");
  return parser;
}

function getWorthOp(): WorthOperation {
  const operation: unknown = Object.getOwnPropertyDescriptor(operations, "nbfWorthCheckOp")?.value;
  const isOperation = (value: unknown): value is WorthOperation =>
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "name" in value &&
    "stage" in value &&
    "config" in value &&
    "session" in value &&
    "tools" in value &&
    "model" in value &&
    "timeoutMs" in value &&
    "parse" in value &&
    "build" in value;
  expect(isOperation(operation)).toBe(true);
  if (!isOperation(operation)) throw new Error("nbfWorthCheckOp export is unavailable");
  return operation;
}

function parseNbfWorthReply(output: string, findingCount: number): WorthOutput {
  return getParser()(output, findingCount);
}

const nbfWorthCheckOp: WorthOperation = {
  get kind() {
    return getWorthOp().kind;
  },
  get name() {
    return getWorthOp().name;
  },
  get stage() {
    return getWorthOp().stage;
  },
  get config() {
    return getWorthOp().config;
  },
  get session() {
    return getWorthOp().session;
  },
  get tools() {
    return getWorthOp().tools;
  },
  model: (input, context) => getWorthOp().model(input, context),
  timeoutMs: (input, context) => getWorthOp().timeoutMs(input, context),
  parse: (output, input, context) => getWorthOp().parse(output, input, context),
  build: (input, context) => getWorthOp().build(input, context),
};

describe("parseNbfWorthReply (US-002)", () => {
  test("US-002 AC1: normalizes valid verdicts into finding order", () => {
    expect(
      parseNbfWorthReply(
        '{"verdicts":[{"index":2,"verdict":"skip","reason":"stale comment"},{"index":1,"verdict":"fix","reason":"reachable"}]}',
        2,
      ),
    ).toEqual({
      parsed: true,
      verdicts: [
        { index: 1, verdict: "fix", reason: "reachable" },
        { index: 2, verdict: "skip", reason: "stale comment" },
      ],
    });
  });

  test("US-002 AC2: defaults missing in-range verdicts to fix", () => {
    expect(parseNbfWorthReply('{"verdicts":[{"index":5,"verdict":"skip","reason":"r"}]}', 2)).toEqual({
      parsed: true,
      verdicts: [
        { index: 1, verdict: "fix", reason: "(no verdict returned)" },
        { index: 2, verdict: "fix", reason: "(no verdict returned)" },
      ],
    });
  });

  test("US-002 AC3: keeps the first valid duplicate index", () => {
    expect(
      parseNbfWorthReply(
        '{"verdicts":[{"index":1,"verdict":"skip","reason":"nit"},{"index":1,"verdict":"fix","reason":"r"}]}',
        1,
      ),
    ).toEqual({
      parsed: true,
      verdicts: [{ index: 1, verdict: "skip", reason: "nit" }],
    });
  });

  test("US-002 AC4: selects a duplicate before validating its verdict", () => {
    expect(
      parseNbfWorthReply(
        '{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"},{"index":1,"verdict":"skip","reason":"nit"}]}',
        1,
      ),
    ).toEqual({
      parsed: true,
      verdicts: [{ index: 1, verdict: "fix", reason: "(invalid verdict)" }],
    });
  });

  test("US-002 AC5: ignores non-object entries in the verdict list", () => {
    expect(parseNbfWorthReply('{"verdicts":["skip",{"index":1,"verdict":"skip","reason":"nit"}]}', 1)).toEqual({
      parsed: true,
      verdicts: [{ index: 1, verdict: "skip", reason: "nit" }],
    });
  });

  test("US-002 AC6: treats a skip with a blank reason as fix", () => {
    expect(parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"skip","reason":"  "}]}', 1)).toEqual({
      parsed: true,
      verdicts: [{ index: 1, verdict: "fix", reason: "(skip without reason)" }],
    });
  });

  test("US-002 AC7: treats an unknown verdict as fix", () => {
    expect(parseNbfWorthReply('{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"}]}', 1)).toEqual({
      parsed: true,
      verdicts: [{ index: 1, verdict: "fix", reason: "(invalid verdict)" }],
    });
  });

  test("US-002 AC8: provides a non-empty preview for text without JSON", () => {
    const result = parseNbfWorthReply("no json here", 1);
    expect(result.parsed).toBe(false);
    expect(result.parsed ? "" : result.unparsedPreview).not.toBe("");
  });

  test("US-002 AC9: labels an empty response explicitly", () => {
    expect(parseNbfWorthReply("", 1)).toEqual({ parsed: false, unparsedPreview: "(empty response)" });
  });

  test("US-002 AC10: rejects an object without a verdicts array", () => {
    expect(parseNbfWorthReply('{"result":"ok"}', 1).parsed).toBe(false);
  });

  test("US-002 AC11: rejects a top-level JSON array", () => {
    expect(parseNbfWorthReply('[{"index":1,"verdict":"skip","reason":"r"}]', 1).parsed).toBe(false);
  });
});

describe("nbfWorthCheckOp (US-002)", () => {
  test("US-002 AC12: declares the review run operation with its review config selector", () => {
    expect(nbfWorthCheckOp.kind).toBe("run");
    expect(nbfWorthCheckOp.name).toBe("nbf-worth-check");
    expect(nbfWorthCheckOp.stage).toBe("review");
    expect(nbfWorthCheckOp.config).toBe(reviewConfigSelector);
  });

  test("US-002 AC12: declares a fresh worth-check session", () => {
    expect(nbfWorthCheckOp.session).toEqual({ role: "nbf-worth-check", lifetime: "fresh" });
  });

  test("US-002 AC13: declares only read-only repository tools", () => {
    expect(nbfWorthCheckOp.tools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("US-002 AC14: defaults its model to balanced", () => {
    const currentCtx = makeCtx({ mode: "on" });
    expect(
      typeof nbfWorthCheckOp.model === "function"
        ? nbfWorthCheckOp.model(baseInput, currentCtx)
        : nbfWorthCheckOp.model,
    ).toBe("balanced");
  });

  test("US-002 AC15: uses the configured worth-check model", () => {
    const currentCtx = makeCtx({ mode: "on", model: "powerful" });
    expect(
      typeof nbfWorthCheckOp.model === "function"
        ? nbfWorthCheckOp.model(baseInput, currentCtx)
        : nbfWorthCheckOp.model,
    ).toBe("powerful");
  });

  test("US-002 AC16: uses the configured worth-check timeout", () => {
    const currentCtx = makeCtx({ mode: "on", timeoutMs: 120000 });
    expect(nbfWorthCheckOp.timeoutMs(baseInput, currentCtx)).toBe(120000);
  });

  test("US-002 AC17: defaults timeout when non-blocking-fix config is absent", () => {
    expect(nbfWorthCheckOp.timeoutMs(baseInput, ctx)).toBe(300000);
  });

  test("US-002 AC18: parser uses the input finding count", () => {
    expect(
      nbfWorthCheckOp.parse('{"verdicts":[{"index":1,"verdict":"fix","reason":"reachable"}]}', baseInput, ctx),
    ).toEqual({
      parsed: true,
      verdicts: [
        { index: 1, verdict: "fix", reason: "reachable" },
        { index: 2, verdict: "fix", reason: "(no verdict returned)" },
      ],
    });
  });

  test("US-002 AC19: builds its task from the worth-check prompt builder", () => {
    expect(nbfWorthCheckOp.build(baseInput, ctx).task.content).toBe(buildNbfWorthCheckPrompt(baseInput));
  });
});
