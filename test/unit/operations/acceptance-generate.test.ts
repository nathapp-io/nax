import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { acceptanceGenerateOp } from "../../../src/operations/acceptance-generate";
import type { AcceptanceGenerateInput } from "../../../src/operations/acceptance-generate";
import type { BuildContext, VerifyContext } from "../../../src/operations/types";
import { acceptanceGenConfigSelector } from "../../../src/config";
import type { AcceptanceGenConfig } from "../../../src/config/selectors";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import { withTempDir } from "../../helpers/temp";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const SAMPLE_INPUT: AcceptanceGenerateInput = {
  featureName: "my-feature",
  criteriaList: "AC-1: do X\nAC-2: do Y",
  frameworkOverrideLine: "",
  targetTestFilePath: "/tmp/acceptance.test.ts",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceGenConfigSelector) };
}

function makeVerifyCtx(overrides: {
  readFile?: (path: string) => Promise<string | null>;
  fileExists?: (path: string) => Promise<boolean>;
} = {}): VerifyContext<AcceptanceGenConfig> {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(acceptanceGenConfigSelector),
    readFile: overrides.readFile ?? (async () => null),
    fileExists: overrides.fileExists ?? (async () => false),
  };
}

describe("acceptanceGenerateOp shape", () => {
  test.each([
    ["kind", acceptanceGenerateOp.kind, "run"],
    ["name", acceptanceGenerateOp.name, "acceptance-generate"],
    ["stage", acceptanceGenerateOp.stage, "acceptance"],
  ])("%s is %s", (_prop, actual, expected) => {
    expect(actual).toBe(expected);
  });
  test("session role is acceptance-gen with fresh lifetime", () => {
    expect(acceptanceGenerateOp.session).toEqual({ role: "acceptance-gen", lifetime: "fresh" });
  });
  test("model resolves from acceptance.model config", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceGenConfig> = { packageView: view, config: view.select(acceptanceGenConfigSelector) };
    const modelResolver = acceptanceGenerateOp.model as (input: AcceptanceGenerateInput, ctx: BuildContext<AcceptanceGenConfig>) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });

  test("model resolves from acceptance.generateModel when set (overrides acceptance.model)", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
        generateModel: { agent: "claude", model: "balanced" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceGenConfig> = { packageView: view, config: view.select(acceptanceGenConfigSelector) };
    const modelResolver = acceptanceGenerateOp.model as (input: AcceptanceGenerateInput, ctx: BuildContext<AcceptanceGenConfig>) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "claude",
      model: "balanced",
    });
  });

  test("model falls back to acceptance.model when generateModel is not set", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceGenConfig> = { packageView: view, config: view.select(acceptanceGenConfigSelector) };
    const modelResolver = acceptanceGenerateOp.model as (input: AcceptanceGenerateInput, ctx: BuildContext<AcceptanceGenConfig>) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({
      agent: "opencode",
      model: "opencode-go/minimax-m2.7",
    });
  });
});

describe("acceptanceGenerateOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test.each([
    ["featureName", "my-feature"],
    ["criteria", "AC-1: do X"],
  ])("task section content contains %s", (_label, needle) => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain(needle);
  });
});

describe("acceptanceGenerateOp.parse()", () => {
  test("extracts code from typescript fenced block", () => {
    const ctx = makeBuildCtx();
    const output = "Here is the test:\n```typescript\ndescribe('x', () => {\n  test('y', () => expect(1).toBe(1));\n});\n```";
    const result = acceptanceGenerateOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result.testCode).toContain("describe");
  });
  test("returns null testCode when no code block present", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.parse("no code here", SAMPLE_INPUT, ctx);
    expect(result.testCode).toBeNull();
  });
  test("extracts code from generic fenced block", () => {
    const ctx = makeBuildCtx();
    const output = "```\nimport { describe } from 'bun:test';\ndescribe('feature', () => {});\n```";
    const result = acceptanceGenerateOp.parse(output, SAMPLE_INPUT, ctx);
    expect(result.testCode).toContain("import");
  });
});

describe("acceptanceGenerateOp.verify()", () => {
  test("returns parsed unchanged when testCode is non-null (stdout had real code)", async () => {
    const ctx = makeVerifyCtx();
    const parsed = { testCode: "describe('x', () => {})" };
    const result = await acceptanceGenerateOp.verify!(parsed, SAMPLE_INPUT, ctx);
    expect(result).toEqual(parsed);
  });

  test("reads disk file when parsed.testCode is null", async () => {
    await withTempDir(async (dir) => {
      const testPath = join(dir, "acceptance.test.ts");
      const diskCode = "```typescript\ndescribe('x', () => { test('y', () => expect(1).toBe(1)); });\n```";
      await Bun.write(testPath, diskCode);

      const input = { ...SAMPLE_INPUT, targetTestFilePath: testPath };
      const ctx = makeVerifyCtx({
        readFile: async (p) => {
          const f = Bun.file(p);
          return (await f.exists()) ? await f.text() : null;
        },
      });

      const result = await acceptanceGenerateOp.verify!({ testCode: null }, input, ctx);
      expect(result?.testCode).toContain("describe");
    });
  });

  test("Tier 2: returns disk content when it looks like test source (no fenced block)", async () => {
    await withTempDir(async (dir) => {
      const testPath = join(dir, "acceptance.test.ts");
      const diskCode = "import { describe, test, expect } from 'bun:test';\ndescribe('x', () => { test('y', () => expect(1).toBe(1)); });";
      await Bun.write(testPath, diskCode);

      const input = { ...SAMPLE_INPUT, targetTestFilePath: testPath };
      const ctx = makeVerifyCtx({
        readFile: async (p) => {
          const f = Bun.file(p);
          return (await f.exists()) ? await f.text() : null;
        },
      });

      const result = await acceptanceGenerateOp.verify!({ testCode: null }, input, ctx);
      expect(result?.testCode).toBe(diskCode);
    });
  });

  test.each([
    ["disk file is missing", async () => null as string | null],
    ["disk content is stub-shaped (raw, no fence)", async () => "describe('x', () => { test('y', () => expect(true).toBe(false)); });"],
    ["fenced block contains stub-shaped code (Tier 1 stub guard)", async () => "```typescript\ndescribe('x', () => { test('y', () => expect(true).toBe(false)); });\n```"],
    ["disk content has no test markers", async () => "just some random text"],
  ])("returns null when %s", async (_label, readFile) => {
    const ctx = makeVerifyCtx({ readFile });
    const result = await acceptanceGenerateOp.verify!({ testCode: null }, SAMPLE_INPUT, ctx);
    expect(result).toBeNull();
  });
});
