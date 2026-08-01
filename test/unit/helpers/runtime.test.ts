import { describe, expect, test } from "bun:test";
import { makeMockRuntime, makeTestRuntime } from "@test/helpers";

const autoCleanupCloseCalls: string[] = [];
const manualCloseCalls: string[] = [];

describe("test helper runtime cleanup", () => {
  test("closes helper-created runtimes after the test finishes", () => {
    for (const runtime of [makeTestRuntime(), makeMockRuntime()]) {
      const close = runtime.close.bind(runtime);
      runtime.close = async () => {
        autoCleanupCloseCalls.push(runtime.runId);
        await close();
      };
    }

    expect(autoCleanupCloseCalls).toHaveLength(0);
  });

  test("cleanup ran for helper-created runtimes from the prior test", () => {
    expect(autoCleanupCloseCalls).toHaveLength(2);
    autoCleanupCloseCalls.length = 0;
  });

  test("manual close unregisters helper-created runtimes from automatic teardown", async () => {
    const runtime = makeTestRuntime();
    const close = runtime.close.bind(runtime);

    runtime.close = async () => {
      manualCloseCalls.push(runtime.runId);
      await close();
    };

    await runtime.close();

    expect(manualCloseCalls).toHaveLength(1);
  });

  test("automatic teardown does not re-close manually closed runtimes", () => {
    expect(manualCloseCalls).toHaveLength(1);
    manualCloseCalls.length = 0;
  });
});