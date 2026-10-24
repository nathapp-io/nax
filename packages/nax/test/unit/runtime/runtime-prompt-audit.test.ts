import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import {
  _promptAuditorDeps,
  _runtimeLoggerDeps,
  type CreateRuntimeOptions,
  createNoOpPromptAuditor,
  createRuntime,
  type NaxRuntime,
  PromptAuditor,
} from "@/runtime";

const message = "Prompt audit is enabled but no feature name was given; prompts will not be audited";
const workdir = "/tmp/runtime-prompt-audit";
const original = { ..._runtimeLoggerDeps };
const runtimes: NaxRuntime[] = [];
let logger: ReturnType<typeof makeLogger>;

beforeEach(() => {
  logger = makeLogger();
  _runtimeLoggerDeps.getSafeLogger = () => logger;
});
afterEach(async () => {
  Object.assign(_runtimeLoggerDeps, original);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function runtime(enabled: boolean, options?: CreateRuntimeOptions): NaxRuntime {
  const created = createRuntime(makeNaxConfig({ agent: { promptAudit: { enabled } } }), workdir, options);
  runtimes.push(created);
  return created;
}

async function expectNoOp(created: NaxRuntime): Promise<void> {
  const append = spyOn(_promptAuditorDeps, "appendLine");
  const write = spyOn(_promptAuditorDeps, "write");
  try {
    expect(created.promptAuditor).not.toBeInstanceOf(PromptAuditor);
    created.promptAuditor.record({
      ts: 1,
      runId: created.runId,
      agentName: "claude",
      permissionProfile: "safe",
      prompt: "test prompt",
      response: "test response",
      durationMs: 0,
    });
    created.promptAuditor.recordError({
      ts: 2,
      runId: created.runId,
      agentName: "claude",
      errorCode: "TEST",
      durationMs: 0,
    });
    await created.promptAuditor.flush();
    expect(append).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    append.mockRestore();
    write.mockRestore();
  }
}

describe("createRuntime prompt audit", () => {
  test("AC-3 warns exactly once when enabled audit has no identity", () => {
    runtime(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("runtime", message, { workdir });
  });

  test("AC-4 includes the supplied workdir in warning data", () => {
    runtime(true);
    expect(logger.calls.filter((call) => call.message === message).map((call) => call.data)).toEqual([{ workdir }]);
  });

  test.each([
    ["AC-5 feature name", true, { featureName: "bot-pr-42" }],
    ["AC-6 custom auditor", true, { promptAuditor: createNoOpPromptAuditor() }],
    ["AC-7 disabled audit", false, undefined],
  ] satisfies [string, boolean, CreateRuntimeOptions | undefined][])(
    "%s suppresses the warning",
    (_name, enabled, options: CreateRuntimeOptions | undefined) => {
      const created = runtime(enabled, options);
      expect(logger.calls.filter((call) => call.level === "warn" && call.message === message)).toEqual([]);
      if (options?.featureName) expect(created.promptAuditor).toBeInstanceOf(PromptAuditor);
      if (options?.promptAuditor) expect(created.promptAuditor).toBe(options.promptAuditor);
    },
  );

  test("AC-8 returns a no-op auditor without throwing when logger is unavailable", async () => {
    _runtimeLoggerDeps.getSafeLogger = () => null;
    const created = runtime(true);
    await expectNoOp(created);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("AC-9 still returns a no-op auditor after warning", async () => {
    const created = runtime(true);
    expect(logger.warn).toHaveBeenCalledWith("runtime", message, { workdir });
    await expectNoOp(created);
  });
});
