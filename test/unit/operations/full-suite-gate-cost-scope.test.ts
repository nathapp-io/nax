import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp, _fullSuiteGateDeps } from "../../../src/operations/full-suite-gate";

describe("fullSuiteGateOp — cost scope attribution", () => {
  test("propagates ctx.scopeId to runRectificationLoop", async () => {
    let capturedScopeId: string | undefined;

    const fakeDeps: typeof _fullSuiteGateDeps = {
      resolveGateContext: async () => ({
        config: {} as any,
        testCmd: "bun test",
        fullSuiteTimeout: 30,
      }),
      runTests: async () => ({ passed: false, failed: 1, output: "fail" }),
      runRectificationLoop: async (_input, ctx) => {
        capturedScopeId = ctx.scopeId;
        return { exhausted: false, attempts: 1, fixedAll: true };
      },
    };

    const ctx = {
      scopeId: "scope-xyz",
      runtime: { agentManager: {} as any, sessionManager: {} as any },
      config: {} as any,
      packageView: { packageDir: "/tmp" } as any,
      packageDir: "/tmp",
      agentName: "claude",
    } as any;

    await fullSuiteGateOp.execute(
      {
        story: { id: "S1", title: "t" } as any,
        workdir: "/tmp",
        rectificationEnabled: true,
      },
      ctx,
      fakeDeps,
    );

    expect(capturedScopeId).toBe("scope-xyz");
  });
});
