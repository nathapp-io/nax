// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { AcceptanceStrategy } from "../../../../src/verification/strategies/acceptance";
import type { VerifyContext } from "../../../../src/verification/orchestrator-types";

function makeCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
    ...overrides,
  };
}

describe("AcceptanceStrategy", () => {
  test("name is acceptance", () => {
    expect(new AcceptanceStrategy().name).toBe("acceptance");
  });

  test("returns SKIPPED when no acceptanceTestPath", async () => {
    const result = await new AcceptanceStrategy().execute(makeCtx());
    expect(result.status).toBe("SKIPPED");
    expect(result.success).toBe(true);
  });

  test("returns SKIPPED when test file does not exist", async () => {
    const result = await new AcceptanceStrategy().execute(
      makeCtx({ acceptanceTestPath: "/nonexistent/path/acceptance.test.ts" }),
    );
    expect(result.status).toBe("SKIPPED");
  });
});
