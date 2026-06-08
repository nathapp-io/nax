import { describe, expect, test } from "bun:test";
import { typecheckCheckOp } from "@/operations";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) },
  } as any;
}

describe("typecheckCheckOp via packageView", () => {
  test("runs the typecheck command from packageView", async () => {
    let seen = "";
    const deps = {
      runQualityCommand: async (o: any) => {
        seen = o.command;
        return { commandName: "typecheck", command: o.command, success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false };
      },
      parseTypecheckOutput: () => null,
    } as any;
    await typecheckCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: { typecheck: "mypy packages/agent/src" } }), deps);
    expect(seen).toBe("mypy packages/agent/src");
  });

  test("skips with success when no typecheck command configured", async () => {
    let called = false;
    const deps = {
      runQualityCommand: async () => { called = true; return {} as any; },
      parseTypecheckOutput: () => null,
    } as any;
    const out = await typecheckCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: {} }), deps);
    expect(called).toBe(false);
    expect(out.success).toBe(true);
  });
});
