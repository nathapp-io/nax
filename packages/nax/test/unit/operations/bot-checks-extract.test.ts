import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime, opSelector } from "@test/helpers";
import { workflowConfigSelector } from "@/config";
import * as operations from "@/operations";
import * as prompts from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  runtimes.length = 0;
});
function ctx() {
  const runtime = makeTestRuntime();
  runtimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}
const input = { fileName: "AGENTS.md", text: "Run bun run test" } as const;
const reply = '{"gates":[{"gate":"test","command":"bun run test"}],"install":"bun install"}';

describe("parseBotChecksReply", () => {
  test("AC-8: extracts gates and install", () => {
    expect(operations.parseBotChecksReply(reply)).toEqual({
      gates: [{ gate: "test", command: "bun run test" }],
      install: "bun install",
    });
  });
  test.each([
    ["AC-9 invalid JSON", "not json"],
    ["AC-10 non-array gates", '{"gates":"x"}'],
    ["null", "null"],
    ["array", "[]"],
    ["scalar", "1"],
    ["missing gates", "{}"],
  ])("returns null for %s", (_name, output) => {
    expect(operations.parseBotChecksReply(output)).toBeNull();
  });
  test.each([
    ["AC-11 unknown gate", { gate: "deploy", command: "deploy" }],
    ["AC-12 line feed", { gate: "test", command: "bun\nrun test" }],
    ["AC-13 too long", { gate: "test", command: "x".repeat(301) }],
    ["AC-14 empty", { gate: "test", command: "  " }],
    ["carriage return", { gate: "test", command: "bun\rtest" }],
    ["NUL", { gate: "test", command: "bun\0test" }],
    ["non-string", { gate: "test", command: 1 }],
    ["null", null],
    ["scalar", 5],
  ])("drops %s", (_name, entry) => {
    expect(operations.parseBotChecksReply(JSON.stringify({ gates: [entry] }))).toEqual({ gates: [] });
  });
  test("AC-15: keeps the first valid entry per gate", () => {
    const gates = [
      { gate: "lint", command: " " },
      { gate: "lint", command: "first" },
      { gate: "lint", command: "second" },
    ];
    expect(operations.parseBotChecksReply(JSON.stringify({ gates }))).toEqual({
      gates: [{ gate: "lint", command: "first" }],
    });
  });
  test.each(["bun\rinstall", "bun\ninstall", "bun\0install", " ", "x".repeat(301), 5, null])(
    "AC-16: omits invalid install %j",
    (install) => {
      expect(operations.parseBotChecksReply(JSON.stringify({ gates: [], install }))).toEqual({ gates: [] });
    },
  );
  test("AC-17: trims commands and install", () => {
    expect(
      operations.parseBotChecksReply('{"gates":[{"gate":"build","command":"  build  "}],"install":"  install  "}'),
    ).toEqual({ gates: [{ gate: "build", command: "build" }], install: "install" });
  });
  test("keeps all four gates and inclusive length boundaries", () => {
    const gates = (["build", "typecheck", "lint", "test"] as const).map((gate) => ({ gate, command: "x".repeat(300) }));
    expect(operations.parseBotChecksReply(JSON.stringify({ gates, install: "x" }))).toEqual({ gates, install: "x" });
  });
  test("uses the shared tolerant JSON parser", () => {
    expect(operations.parseBotChecksReply(`\`\`\`json\n${reply}\n\`\`\``)).toEqual(
      operations.parseBotChecksReply(reply),
    );
  });
});

describe("botChecksExtractOp", () => {
  test("AC-18: is a complete operation", () => {
    expect(operations.botChecksExtractOp.kind).toBe("complete");
  });
  test("AC-19: declares its name, stage and config selector", () => {
    expect(operations.botChecksExtractOp.name).toBe("bot-checks-extract");
    expect(operations.botChecksExtractOp.stage).toBe("review");
    expect(operations.botChecksExtractOp.config).toBe(workflowConfigSelector);
  });
  test.each([
    ["AC-20", "balanced", "balanced"],
    ["AC-21", undefined, "fast"],
  ] as const)("%s: resolves model", (_ac, model, expected) => {
    const resolver = operations.botChecksExtractOp.model;
    expect(typeof resolver).toBe("function");
    if (typeof resolver !== "function") throw new Error("Expected model resolver");
    expect(resolver({ ...input, model }, ctx())).toBe(expected);
  });
  test("AC-22: delegates task content to the prompt builder", () => {
    const built = operations.botChecksExtractOp.build(input, ctx());
    expect(built.task.content).toBe(prompts.buildBotChecksExtractPrompt(input));
  });
  test.each([reply, "not json"])("AC-23: delegates parsing for %s", (output) => {
    expect(operations.botChecksExtractOp.parse(output, input, ctx())).toEqual(operations.parseBotChecksReply(output));
  });
});

test("trims surrounding newlines before validating commands", () => {
  expect(
    operations.parseBotChecksReply(
      JSON.stringify({ gates: [{ gate: "test", command: "\nbun run test\r\n" }], install: "npm ci\n" }),
    ),
  ).toEqual({ gates: [{ gate: "test", command: "bun run test" }], install: "npm ci" });
});
