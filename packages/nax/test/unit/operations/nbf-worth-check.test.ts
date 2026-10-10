import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeStory, makeTestRuntime, opSelector } from "@test/helpers";
import { reviewConfigSelector } from "@/config";
import type { Finding } from "@/findings";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
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

type WorthRequest = {
  readonly ctx: ReturnType<typeof makeMockCallContext>;
  readonly findings: readonly Finding[];
  readonly cfg: { readonly mode: "on" | "off" | "shadow"; readonly timeoutMs?: number } | undefined;
};
type WorthRunner = (request: WorthRequest) => Promise<Finding[]>;

function capturedInput(value: unknown): NbfWorthCheckOpInput {
  if (!isNbfWorthInput(value)) throw new Error("Worth-check input was not captured");
  return value;
}

function isNbfWorthInput(value: unknown): value is NbfWorthCheckOpInput {
  return typeof value === "object" && value !== null && "diff" in value && typeof value.diff === "string";
}

type WorthDeps = {
  callOp: (...args: unknown[]) => Promise<unknown>;
  resolveEffectiveRef: (...args: unknown[]) => Promise<string | undefined>;
  collectDiff: (...args: unknown[]) => Promise<string | null>;
  collectDiffStat: (...args: unknown[]) => Promise<string>;
  loadPRD: (...args: unknown[]) => Promise<unknown>;
  writeAudit: (...args: unknown[]) => Promise<void>;
  now: () => number;
  costTotal: (...args: unknown[]) => number;
};

const originalWorthDeps = Object.getOwnPropertyDescriptor(operations, "_nbfWorthCheckDeps")?.value;
const originalAuditDeps = Object.getOwnPropertyDescriptor(operations, "_nbfWorthCheckAuditDeps")?.value;
const originalRunner = Object.getOwnPropertyDescriptor(operations, "runNbfWorthCheck")?.value;
const worthFunction = (value: unknown): value is WorthRunner => typeof value === "function";
const worthDepsObject = (value: unknown): value is WorthDeps => typeof value === "object" && value !== null;

function worthDeps(): WorthDeps | undefined {
  expect(worthDepsObject(originalWorthDeps)).toBe(true);
  return worthDepsObject(originalWorthDeps) ? originalWorthDeps : undefined;
}

function runWorth(request: WorthRequest): Promise<Finding[]> {
  expect(worthFunction(originalRunner)).toBe(true);
  return worthFunction(originalRunner) ? originalRunner(request) : Promise.resolve([...request.findings]);
}

afterEach(() => {
  if (worthDepsObject(originalAuditDeps)) {
    Object.assign(originalAuditDeps, {
      write: async () => undefined,
      now: () => Date.now(),
      costTotal: () => 0,
    });
  }
  resetLogger();
  if (worthDepsObject(originalWorthDeps)) {
    Object.assign(originalWorthDeps, {
      callOp: async () => ({ parsed: true, verdicts: [] }),
      resolveEffectiveRef: async () => "ref1",
      collectDiff: async () => "+x",
      collectDiffStat: async () => "",
      loadPRD: async () => ({ userStories: [] }),
      writeAudit: async () => undefined,
      now: () => 0,
      write: async () => undefined,
      costTotal: () => 0,
    });
  }
});

describe("runNbfWorthCheck (US-003)", () => {
  const findings = [findingA, findingB];
  const config: WorthRequest["cfg"] = { mode: "on" };
  const story = makeStory({
    id: "US-002",
    title: "Deliver orders",
    description: "d",
    acceptanceCriteria: ["AC one"],
    status: "in-progress",
    attempts: 1,
  });
  const makeRunnerCtx = (overrides: Partial<ReturnType<typeof makeMockCallContext>> = {}) =>
    makeMockCallContext({
      story,
      storyId: "US-002",
      featureName: "f",
      featureDir: "/repo/.nax/features/f",
      ...overrides,
    });
  const fixSkip = {
    parsed: true,
    verdicts: [
      { index: 1, verdict: "fix", reason: "r1" },
      { index: 2, verdict: "skip", reason: "nit" },
    ],
  };

  test("US-003 AC1: returns the seed unchanged when config is absent", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let called = false;
    deps.callOp = async () => {
      called = true;
      return fixSkip;
    };
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: undefined })).toEqual(findings);
    expect(called).toBe(false);
  });

  test("US-003 AC2: returns the seed unchanged when worth-check mode is off", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let called = false;
    deps.callOp = async () => {
      called = true;
      return fixSkip;
    };
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: { mode: "off", timeoutMs: 300000 } })).toEqual(
      findings,
    );
    expect(called).toBe(false);
  });

  test("US-003 AC3: dispatches the worth-check operation in on mode", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let calledOp: unknown;
    deps.callOp = async (_ctx, op) => {
      calledOp = op;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(calledOp).toBe(getWorthOp());
  });

  test("US-003 AC4: retains only findings judged fix", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.callOp = async () => fixSkip;
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config })).toEqual([findingA]);
  });

  test("US-003 AC5: returns no findings when every verdict is skip", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.callOp = async () => ({
      parsed: true,
      verdicts: [
        { index: 1, verdict: "skip", reason: "nit" },
        { index: 2, verdict: "skip", reason: "nit" },
      ],
    });
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config })).toEqual([]);
  });

  test("US-003 AC6: shadow mode returns the original seed", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.callOp = async () => ({ parsed: true, verdicts: [{ index: 1, verdict: "skip", reason: "nit" }] });
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: { mode: "shadow" } })).toEqual(findings);
  });

  test("US-003 AC7: keeps the seed when worth-check dispatch rejects", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.callOp = async () => {
      throw new Error("dispatch failed");
    };
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config })).toEqual(findings);
  });

  test("US-003 AC8: keeps the seed when the reply is unparseable", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.callOp = async () => ({ parsed: false, unparsedPreview: "junk" });
    expect(await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config })).toEqual(findings);
  });

  test("US-003 AC9: supplies only deliverable pending feature stories", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.loadPRD = async () => ({
      userStories: [
        story,
        makeStory({ id: "US-001", status: "passed" }),
        makeStory({ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"], status: "pending" }),
        makeStory({ id: "US-004", status: "failed" }),
        makeStory({ id: "US-005", status: "decomposed" }),
      ],
    });
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).pendingStories).toEqual([
      { id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] },
    ]);
  });

  test("US-003 AC10: continues with no pending stories when PRD loading rejects", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.loadPRD = async () => {
      throw new Error("PRD unavailable");
    };
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).pendingStories).toEqual([]);
  });

  test("US-003 AC11: does not load a PRD without a feature directory", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let loaded = false;
    deps.loadPRD = async () => {
      loaded = true;
      return { userStories: [] };
    };
    deps.callOp = async () => fixSkip;
    await runWorth({ ctx: makeRunnerCtx({ featureDir: undefined }), findings, cfg: config });
    expect(loaded).toBe(false);
  });

  test("US-003 AC12: gathers the story diff for the operation input", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).diff).toBe("+x");
  });

  test("US-003 AC13: uses an empty diff when no effective ref exists", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.resolveEffectiveRef = async () => undefined;
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).diff).toBe("");
  });

  test("US-003 AC14: uses an empty diff when diff collection rejects", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.collectDiff = async () => {
      throw new Error("diff unavailable");
    };
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).diff).toBe("");
  });

  test("US-003 AC15: returns the seed without dispatch when the story is absent", async () => {
    const deps = worthDeps();
    if (!deps) return;
    let called = false;
    deps.callOp = async () => {
      called = true;
      return fixSkip;
    };
    expect(await runWorth({ ctx: makeRunnerCtx({ story: undefined }), findings, cfg: config })).toEqual(findings);
    expect(called).toBe(false);
  });

  test("US-003 AC16: uses an empty diff when diff collection returns null", async () => {
    const deps = worthDeps();
    if (!deps) return;
    deps.collectDiff = async () => null;
    let input: unknown;
    deps.callOp = async (_ctx, _op, opInput) => {
      input = opInput;
      return fixSkip;
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(capturedInput(input).diff).toBe("");
  });

  test("US-004 AC1-3: logs ordered story context, verdict counts, and skipped finding details", async () => {
    const deps = worthDeps();
    if (!deps) return;
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => entries.push(entry));
    deps.callOp = async () => fixSkip;
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    const entry = entries.find((item) => item.message === "worth-check verdicts");
    expect(entry?.stage).toBe("nbf-worth-check");
    expect(Object.keys(entry?.data ?? {}).slice(0, 2)).toEqual(["storyId", "packageDir"]);
    expect(entry?.data).toMatchObject({ storyId: "US-002", packageDir: "/tmp/test", fix: 1, skip: 1 });
    expect(entry?.data?.skipped).toEqual([{ file: "src/b.ts", line: 3, reason: "nit" }]);
  });

  test("US-004 AC4-6: logs all-skip and failed judgments", async () => {
    const deps = worthDeps();
    if (!deps) return;
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => entries.push(entry));
    deps.callOp = async () => ({
      parsed: true,
      verdicts: [
        { index: 1, verdict: "skip", reason: "r1" },
        { index: 2, verdict: "skip", reason: "nit" },
      ],
    });
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(entries.find((item) => item.message === "all advisory findings skipped — NBF not run")?.data?.skip).toBe(2);
    deps.callOp = async () => {
      throw new Error("boom");
    };
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(entries.find((item) => item.message === "worth-check failed — fixing all findings")?.data?.error).toBe(
      "boom",
    );
    deps.callOp = async () => ({ parsed: false, unparsedPreview: "junk" });
    await runWorth({ ctx: makeRunnerCtx(), findings, cfg: config });
    expect(
      entries.filter((item) => item.message === "worth-check failed — fixing all findings").at(-1)?.data?.error,
    ).toBe("junk");
  });

  test("US-004 AC7-14: audits judged records, tolerates write failures, and uses unknown feature", async () => {
    const deps = worthDeps();
    if (!deps) return;
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => entries.push(entry));
    let audit: { path: string; record: import("@/operations").NbfWorthCheckAuditFile } | undefined;
    let writeCount = 0;
    const costs = [0, 0.02];
    const auditDeps = operations._nbfWorthCheckAuditDeps;
    auditDeps.now = () => 1000;
    auditDeps.costTotal = () => costs.shift() ?? 0.02;
    auditDeps.write = async (path, record) => {
      writeCount += 1;
      audit = { path, record };
    };
    deps.callOp = async () => fixSkip;
    const context = makeRunnerCtx();
    await runWorth({ ctx: context, findings, cfg: config });
    expect(audit?.path).toBe(`${context.runtime.outputDir}/nbf-worth-check/f/US-002-1000.json`);
    expect(audit?.record.costUsd).toBe(0.02);
    expect(audit?.record).toMatchObject({ mode: "on", parsed: true });
    expect(audit?.record.verdicts).toHaveLength(2);
    deps.callOp = async () => {
      throw new Error("boom");
    };
    await runWorth({ ctx: context, findings, cfg: config });
    expect(audit?.record).toMatchObject({ parsed: false, verdicts: [], unparsedPreview: "boom" });
    deps.callOp = async () => fixSkip;
    auditDeps.write = async () => {
      throw new Error("disk");
    };
    expect(await runWorth({ ctx: context, findings, cfg: config })).toEqual([findingA]);
    expect(entries.some((item) => item.message === "worth-check audit write failed" && item.level === "warn")).toBe(
      true,
    );
    auditDeps.write = async (path, record) => {
      audit = { path, record };
    };
    await runWorth({ ctx: context, findings, cfg: { mode: "shadow" } });
    expect(audit?.record.mode).toBe("shadow");
    expect(audit?.record.verdicts).toHaveLength(2);
    await runWorth({ ctx: makeRunnerCtx({ featureName: undefined }), findings, cfg: { mode: "shadow" } });
    expect(audit?.path).toContain("/nbf-worth-check/_unknown/");
    const writesBeforeOff = writeCount;
    await runWorth({ ctx: context, findings, cfg: { mode: "off" } });
    expect(writeCount).toBe(writesBeforeOff);
  });
});
