/**
 * US-002 — `runtime.callTool` must not drop the sandbox record's wrapped argv
 * on its way to the tool-audit row.
 *
 * A separate file from runtime.test.ts by design: that file is already past the
 * 650-line split target and the story forbids growing it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _codingToolDeps, type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
let recorded: ToolCallRecord[];
let origGetLogger: typeof _codingToolDeps.getLogger;

beforeEach(() => {
  root = makeTempDir("rt-sbx-argv-");
  recorded = [];
  origGetLogger = _codingToolDeps.getLogger;
  _codingToolDeps.getLogger = () => makeLogger();
});

afterEach(() => {
  _codingToolDeps.getLogger = origGetLogger;
  cleanupTempDir(root);
});

const sink = {
  record: (entry: ToolCallRecord) => {
    recorded.push(entry);
  },
  flush: async () => {},
};

/** A tool whose audit carries both the logical `executed` and a sandbox argv. */
function sandboxAuditTool(): CodingTool {
  return {
    name: "RunCommand",
    description: "RunCommand",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [], argvField: "argv" },
    run: async () => ({
      content: "exit 0",
      audit: {
        executed: ["x"],
        sandbox: { backend: "srt", wrapped: true, argv: ["w", "x"] },
      },
    }),
  };
}

describe("runtime.callTool — sandbox argv reaches the tool-audit row (US-002)", () => {
  test("AC8: the row carries sandbox.argv alongside the unchanged executed", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["*"] }], root),
      storyId: "US-002",
      sink,
      extraTools: [sandboxAuditTool()],
    });
    await rt.callTool("RunCommand", { argv: ["x"], target: "repoRoot" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sandbox?.argv).toEqual(["w", "x"]);
    expect(recorded[0]?.executed).toEqual(["x"]);
  });
});
