import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSandboxBackend } from "@nathapp/nax-agent";
import { _resetSandboxRegistryForTests } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

describe("resolveCodingToolSupport — dispatch visibility (#2066)", () => {
  let logCalls: LogEntry[];
  let dispatchRoot: string;

  beforeEach(() => {
    resetLogger();
    logCalls = [];
    initLogger({ level: "silent" });
    addSink((entry) => logCalls.push(entry));
  });

  afterEach(async () => {
    try {
      await resetSandboxBackend();
    } finally {
      _resetSandboxRegistryForTests();
      resetLogger();
      cleanupTempDir(dispatchRoot);
    }
  });

  test("logs the declared command keys and the resolved permission profile", async () => {
    dispatchRoot = makeTempDir("nax-dispatch-log-");
    const root = dispatchRoot;
    await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: root,
      pipelineStage: "run",
      storyId: "US-005",
      config: makeNaxConfig({ quality: { commands: { testScoped: "pkg-runner {{files}}" } } }),
    });

    const entry = logCalls.find((l) => l.message.includes("Declared commands resolved"));
    expect(entry).toBeDefined();
    expect(entry?.data?.commands).toEqual(["testScoped"]);
    expect(entry?.data?.storyId).toBe("US-005");
    // DEFAULT_CONFIG.execution.permissionProfile is "unrestricted"; the test's
    // quality override leaves it untouched, so that is the resolved value.
    expect(entry?.data?.permissionProfile).toBe("unrestricted");
  });
});
