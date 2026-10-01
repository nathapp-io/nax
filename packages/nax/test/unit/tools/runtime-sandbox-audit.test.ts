import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _bashToolDeps, type CodingTool, compileToolPolicy, createBashTool, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
beforeAll(() => {
  root = makeTempDir("rt-sbx-audit-");
});
afterAll(() => cleanupTempDir(root));

function runtimeFor(tool: CodingTool, records: ToolCallRecord[]) {
  return createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
    sink: { record: (e) => void records.push(e), flush: async () => {} },
    extraTools: [tool],
  });
}

describe("tool-audit sandbox field", () => {
  test("a tool's audit.sandbox reaches the recorded row", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Wrapped",
      description: "Wrapped",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok", audit: { executed: ["x"], sandbox: { backend: "srt", wrapped: true } } }),
    };
    await runtimeFor(tool, records).callTool("Wrapped", {});
    expect(records[0]?.sandbox).toEqual({ backend: "srt", wrapped: true });
    expect(records[0]?.executed).toEqual(["x"]);
  });

  test("a tool with no sandbox record produces a row WITHOUT the key", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Plain",
      description: "Plain",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok" }),
    };
    await runtimeFor(tool, records).callTool("Plain", {});
    expect(records[0] !== undefined && "sandbox" in records[0]).toBe(false);
  });
});

describe("tool-audit exitCode field (nax#2227)", () => {
  const realRunArgv = _bashToolDeps.runArgv;
  afterEach(() => {
    _bashToolDeps.runArgv = realRunArgv;
  });

  function stubTool(result: Awaited<ReturnType<CodingTool["run"]>>): CodingTool {
    return {
      name: "Stub",
      description: "Stub",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => result,
    };
  }

  test("a tool's audit.exitCode reaches the row; a non-zero exit stays outcome error", async () => {
    const records: ToolCallRecord[] = [];
    await runtimeFor(
      stubTool({ content: "exit 1", isError: true, audit: { executed: ["x"], exitCode: 1 } }),
      records,
    ).callTool("Stub", {});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "error", exitCode: 1, executed: ["x"] });
  });

  test("exit 0 is recorded as exitCode 0, not dropped as falsy", async () => {
    const records: ToolCallRecord[] = [];
    await runtimeFor(stubTool({ content: "exit 0", audit: { executed: ["x"], exitCode: 0 } }), records).callTool(
      "Stub",
      {},
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "ok", exitCode: 0 });
  });

  test("a tool with no audit produces a row WITHOUT the key", async () => {
    const records: ToolCallRecord[] = [];
    await runtimeFor(stubTool({ content: "ok" }), records).callTool("Stub", {});
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("exitCode");
  });

  test("a denied Bash call records no exitCode: the tool never ran", async () => {
    const records: ToolCallRecord[] = [];
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([], root),
      sink: { record: (e) => void records.push(e), flush: async () => {} },
      extraTools: [createBashTool()],
    });
    await runtime.callTool("Bash", { command: "echo hi" });
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("denied");
    expect(records[0]).not.toHaveProperty("exitCode");
  });

  test("end to end: a no-match grep through the real Bash tool lands as outcome error with exitCode 1", async () => {
    _bashToolDeps.runArgv = async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false });
    const records: ToolCallRecord[] = [];
    await runtimeFor(createBashTool(), records).callTool("Bash", { command: "rg nomatch src" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: "Bash", outcome: "error", exitCode: 1 });
  });
});
