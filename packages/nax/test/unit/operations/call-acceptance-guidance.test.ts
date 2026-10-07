import { expect, test } from "bun:test";
import { makeMockCallContext, makeStory, makeTestRuntime } from "@test/helpers";
import { implementerRectifyOp } from "@/operations/autofix-implementer";
import { buildDispatchPrologue } from "@/operations/call-dispatch-prologue";
import { rectifyOp } from "@/operations/rectify";

test.each(["autofix", "rectify"])("%s receives acceptance guidance at fix dispatch", async (kind) => {
  const runtime = makeTestRuntime();
  try {
    const ctx = makeMockCallContext({
      runtime,
      acceptanceExecution: [
        {
          testPath: "apps/api/acceptance.ts",
          cwd: "apps/api",
          command: "bunx jest --config jest.nax.config.js acceptance.ts",
          storyIds: ["US-006"],
          acIds: ["AC-58"],
          filtered: true,
        },
      ],
    });
    const input = { story: makeStory({ id: "US-006" }), failedChecks: [] };
    const result =
      kind === "autofix"
        ? buildDispatchPrologue(ctx, implementerRectifyOp, input)
        : buildDispatchPrologue(ctx, rectifyOp, input);
    expect(result.prompt).toContain("# Acceptance execution");
    expect(result.prompt).toContain("AC-58");
    expect(result.prompt).toContain("jest.nax.config.js");
    expect(result.prompt).not.toContain('RunCommand {"command": "testScoped"');
  } finally {
    await runtime.close();
  }
});
