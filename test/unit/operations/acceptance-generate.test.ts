import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { acceptanceGenerateOp } from "../../../src/operations/acceptance-generate";
import type { AcceptanceGenerateInput } from "../../../src/operations/acceptance-generate";
import type { VerifyContext } from "../../../src/operations/types";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import { withTempDir } from "../../helpers/temp";

const SAMPLE_INPUT: AcceptanceGenerateInput = {
  featureName: "my-feature",
  criteriaList: "AC-1: do X\nAC-2: do Y",
  frameworkOverrideLine: "",
  targetTestFilePath: "/tmp/acceptance.test.ts",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceGenerateOp.config) };
}

function makeVerifyCtx(overrides: {
  readFile?: (path: string) => Promise<string | null>;
  fileExists?: (path: string) => Promise<boolean>;
} = {}): VerifyContext<ReturnType<typeof acceptanceGenerateOp.config.select>> {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(acceptanceGenerateOp.config),
    readFile: overrides.readFile ?? (async () => null),
    fileExists: overrides.fileExists ?? (async () => false),
  };
}

describe("acceptanceGenerateOp shape", () => {
  test("kind is complete", () => {
    expect(acceptanceGenerateOp.kind).toBe("complete");
  });
  test("name is acceptance-generate", () => {
    expect(acceptanceGenerateOp.name).toBe("acceptance-generate");
  });
  test("jsonMode is false", () => {
    expect(acceptanceGenerateOp.jsonMode).toBe(false);
  });
  test("stage is acceptance", () => {
    expect(acceptanceGenerateOp.stage).toBe("acceptance");
  });
  test("model resolves from acceptance.model config", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
      },
    });
    const runtime = makeTestRuntime({ config });
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(acceptanceGenerateOp.config) };

    expect(acceptanceGenerateOp.model?.(SAMPLE_INPUT, ctx)).toEqual({
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
  test("task section content contains featureName", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("my-feature");
  });
  test("task section content contains criteria", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceGenerateOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("AC-1: do X");
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

  test("returns null when disk file is missing", async () => {
    const ctx = makeVerifyCtx({ readFile: async () => null });
    const result = await acceptanceGenerateOp.verify!({ testCode: null }, SAMPLE_INPUT, ctx);
    expect(result).toBeNull();
  });

  test("returns null when disk content is stub-shaped (raw, no fence)", async () => {
    const stubCode = "describe('x', () => { test('y', () => expect(true).toBe(false)); });";
    const ctx = makeVerifyCtx({ readFile: async () => stubCode });
    const result = await acceptanceGenerateOp.verify!({ testCode: null }, SAMPLE_INPUT, ctx);
    expect(result).toBeNull();
  });

  test("Tier 1: returns null when fenced block contains stub-shaped code (stub guard)", async () => {
    // extractTestCode extracts the content inside the fence — but since it's
    // stub-shaped the Tier-1 guard (!isStubTestContent) must reject it.
    const fencedStub =
      "```typescript\ndescribe('x', () => { test('y', () => expect(true).toBe(false)); });\n```";
    const ctx = makeVerifyCtx({ readFile: async () => fencedStub });
    const result = await acceptanceGenerateOp.verify!({ testCode: null }, SAMPLE_INPUT, ctx);
    expect(result).toBeNull();
  });

  test("returns null when disk content has no test markers", async () => {
    const ctx = makeVerifyCtx({ readFile: async () => "just some random text" });
    const result = await acceptanceGenerateOp.verify!({ testCode: null }, SAMPLE_INPUT, ctx);
    expect(result).toBeNull();
  });
});
