import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeNaxConfig, makeTestRuntime, withTempDir } from "@test/helpers";
import { acceptanceGenConfigSelector } from "@/config";
import type { AcceptanceGenConfig } from "@/config/selectors";
import type { AcceptanceRepairInput } from "@/operations";
import { acceptanceRepairOp } from "@/operations";
import type { BuildContext, VerifyContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";
import { classifyAcceptanceCrash as classifyFromTestRunnersBarrel } from "@/test-runners";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/**
 * G2, verbatim (US-004). The repair prompt must repeat it so the repaired file
 * still loads before the implementation exists.
 */
const G2 =
  "The file must load before the implementation exists. In languages that resolve imports at runtime (TypeScript, JavaScript, Python), import modules this feature adds inside each test rather than at the top of the file, so a missing module fails only the tests that use it.";

const SAMPLE_INPUT: AcceptanceRepairInput = {
  targetTestFilePath: "/r/t.test.ts",
  outputTail: "error: Cannot find module 'x'",
};

function makeBuildCtx(): BuildContext<AcceptanceGenConfig> {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(acceptanceGenConfigSelector) };
}

function makeVerifyCtx(
  overrides: {
    readFile?: (path: string) => Promise<string | null>;
    fileExists?: (path: string) => Promise<boolean>;
  } = {},
): VerifyContext<AcceptanceGenConfig> {
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

/** Reads from the real filesystem so the verify tests exercise actual disk content. */
async function readDisk(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}

describe("acceptanceRepairOp shape", () => {
  test("AC14: is the acceptance-repair run op with the acceptance-gen session", () => {
    expect(acceptanceRepairOp.kind).toBe("run");
    expect(acceptanceRepairOp.name).toBe("acceptance-repair");
    expect(acceptanceRepairOp.stage).toBe("acceptance");
    expect(acceptanceRepairOp.session).toEqual({ role: "acceptance-gen", lifetime: "fresh" });
  });

  test("AC14: declares exactly the read/edit toolset", () => {
    expect(acceptanceRepairOp.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"]);
  });

  test.each(["Delete", "Exec", "Bash", "RunCommand"])("does not grant %s (US-004 boundary)", (tool) => {
    expect(acceptanceRepairOp.tools).not.toContain(tool);
  });

  test("resolves its model exactly as acceptanceGenerateOp does (generateModel, else model)", () => {
    const config = makeNaxConfig({
      acceptance: {
        model: { agent: "opencode", model: "opencode-go/minimax-m2.7" },
        generateModel: { agent: "claude", model: "balanced" },
      },
    });
    const runtime = makeTestRuntime({ config });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: BuildContext<AcceptanceGenConfig> = {
      packageView: view,
      config: view.select(acceptanceGenConfigSelector),
    };
    const modelResolver = acceptanceRepairOp.model as (
      input: AcceptanceRepairInput,
      ctx: BuildContext<AcceptanceGenConfig>,
    ) => unknown;

    expect(modelResolver(SAMPLE_INPUT, ctx)).toEqual({ agent: "claude", model: "balanced" });
  });
});

describe("acceptanceRepairOp.build()", () => {
  test("AC15: task section names the target path, carries the output tail and repeats G2", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRepairOp.build(SAMPLE_INPUT, ctx);

    expect(result.task.content).toContain("/r/t.test.ts");
    expect(result.task.content).toContain("error: Cannot find module 'x'");
    expect(result.task.content).toContain(G2);
  });

  test("AC15: names the path it is repairing and asks for the smallest load-only edit", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRepairOp.build(SAMPLE_INPUT, ctx);
    const content = result.task.content.toLowerCase();

    expect(content).toContain("smallest");
    expect(content).toContain("load");
    expect(result.task.content).toContain("AC-N");
  });
});

describe("acceptanceRepairOp.parse()", () => {
  test("extracts the fenced test code the model replied with", () => {
    const ctx = makeBuildCtx();
    const output = "Fixed it:\n```typescript\ndescribe('x', () => { test('AC-1: y', () => expect(1).toBe(1)); });\n```";
    const result = acceptanceRepairOp.parse(output, SAMPLE_INPUT, ctx);
    expect(String(result.testCode)).toContain("describe");
  });

  test.each(["I fixed `describe(...)` in place.", "The `import { test }` now works; describe(...) stays intact."])(
    "does not extract inline prose: %s",
    (output) => {
      expect(acceptanceRepairOp.parse(output, SAMPLE_INPUT, makeBuildCtx()).testCode).toBeNull();
    },
  );

  test("returns null testCode when the reply carries no code block", () => {
    const ctx = makeBuildCtx();
    const result = acceptanceRepairOp.parse("I edited the file in place.", SAMPLE_INPUT, ctx);
    expect(result.testCode).toBeNull();
  });
});

describe("acceptanceRepairOp.verify()", () => {
  test("returns parsed unchanged when the reply already carried test code", async () => {
    const ctx = makeVerifyCtx();
    const parsed = { testCode: "describe('x', () => {})" };
    const result = await acceptanceRepairOp.verify(parsed, SAMPLE_INPUT, ctx);
    expect(result).toEqual(parsed);
  });

  test("prefers changed disk content over conflicting fenced reply code", async () => {
    await withTempDir(async (dir) => {
      const targetTestFilePath = join(dir, "t.test.ts");
      const content = "test('AC-1: repaired', () => expect(2).toBe(2));";
      await Bun.write(targetTestFilePath, content);
      const result = await acceptanceRepairOp.verify(
        { testCode: "test('AC-1: stale reply', () => expect(1).toBe(1));" },
        { ...SAMPLE_INPUT, targetTestFilePath, previousContent: "broken source" },
        makeVerifyCtx({ readFile: readDisk }),
      );
      expect(result).toEqual({ testCode: content });
    });
  });

  test("uses fenced reply code when the disk file has not changed", async () => {
    const content = "test('AC-1: old', () => expect(1).toBe(1));";
    const parsed = { testCode: "test('AC-1: repaired', () => expect(2).toBe(2));" };
    expect(
      await acceptanceRepairOp.verify(
        parsed,
        { ...SAMPLE_INPUT, previousContent: content },
        makeVerifyCtx({ readFile: async () => content }),
      ),
    ).toEqual(parsed);
  });

  test("AC16: falls back to the target file's real test source when the reply carried no code", async () => {
    await withTempDir(async (dir) => {
      const targetTestFilePath = join(dir, "t.test.ts");
      const content =
        "import { describe, test, expect } from 'bun:test';\ndescribe('x', () => { test('AC-1: works', () => expect(1 + 1).toBe(2)); });";
      await Bun.write(targetTestFilePath, content);

      const ctx = makeVerifyCtx({ readFile: readDisk });
      const result = await acceptanceRepairOp.verify({ testCode: null }, { ...SAMPLE_INPUT, targetTestFilePath }, ctx);

      expect(result).toEqual({ testCode: content });
    });
  });

  test("AC17: returns null when no file exists at targetTestFilePath", async () => {
    const ctx = makeVerifyCtx({ readFile: async () => null });
    const result = await acceptanceRepairOp.verify(
      { testCode: null },
      { targetTestFilePath: "/r/does-not-exist.test.ts", outputTail: "" },
      ctx,
    );
    expect(result).toBeNull();
  });

  test("returns null when the target file still holds stub content", async () => {
    await withTempDir(async (dir) => {
      const targetTestFilePath = join(dir, "t.test.ts");
      await Bun.write(targetTestFilePath, "describe('x', () => { test('AC-1: y', () => expect(true).toBe(false)); });");

      const ctx = makeVerifyCtx({ readFile: readDisk });
      const result = await acceptanceRepairOp.verify({ testCode: null }, { ...SAMPLE_INPUT, targetTestFilePath }, ctx);

      expect(result).toBeNull();
    });
  });
});

describe("US-004 barrel exports", () => {
  test("AC18: acceptanceRepairOp comes off the @/operations barrel", () => {
    expect(acceptanceRepairOp.name).toBe("acceptance-repair");
  });

  test("AC18: classifyAcceptanceCrash comes off the @/test-runners barrel and is callable", () => {
    expect(typeof classifyFromTestRunnersBarrel).toBe("function");
    expect(classifyFromTestRunnersBarrel("./a_test.go:1:1: undefined: X", "go")).toBe("expected-red");
  });
});
