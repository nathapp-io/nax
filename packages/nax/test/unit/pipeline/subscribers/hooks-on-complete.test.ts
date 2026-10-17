/**
 * wireHooks: the run:completed -> on-complete projection. The event now fires after the end phase,
 * so the hook reports the end-phase verdict (status), why it failed (NAX_REASON) and the PR (NAX_RESULT_URL).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { LoadedHooksConfig } from "@/hooks";
import { PipelineEventBus, type RunCompletedEvent } from "@/pipeline/event-bus";
import { wireHooks } from "@/pipeline/subscribers/hooks";

const BASE_EVENT: RunCompletedEvent = {
  type: "run:completed",
  totalStories: 1,
  passedStories: 1,
  failedStories: 0,
  skippedStories: 0,
  pausedStories: 0,
  durationMs: 1000,
};

let dir: string;
let bus: PipelineEventBus;
let envFile: string;

beforeEach(async () => {
  dir = makeTempDir("nax-hooks-on-complete-");
  envFile = join(dir, "env.txt");
  const script = join(dir, "record.sh");
  await Bun.write(script, `#!/bin/sh\nenv | grep '^NAX_' > "$1"\n`);
  const hooks: LoadedHooksConfig = {
    hooks: { "on-complete": { command: `sh ${script} ${envFile}`, enabled: true } },
  };
  bus = new PipelineEventBus();
  wireHooks(bus, hooks, dir, "feat");
});

afterEach(() => {
  cleanupTempDir(dir);
});

async function recordedEnv(): Promise<Record<string, string>> {
  const text = await Bun.file(envFile).text();
  const entries = text
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const);
  return Object.fromEntries(entries);
}

describe("wireHooks — on-complete carries the end-phase verdict", () => {
  test("a failed workflow gives NAX_STATUS failed, the joined NAX_REASON and NAX_RESULT_URL", async () => {
    bus.emit({
      ...BASE_EVENT,
      workflowPassed: false,
      reasons: ["final gates red: lint", "CI failed"],
      url: "https://github.com/o/r/pull/295",
    });
    await bus.drain();
    const env = await recordedEnv();
    expect(env.NAX_STATUS).toBe("failed");
    expect(env.NAX_REASON).toBe("final gates red: lint; CI failed");
    expect(env.NAX_RESULT_URL).toBe("https://github.com/o/r/pull/295");
  });

  test("a passing workflow with no reasons and no url sets neither NAX_REASON nor NAX_RESULT_URL", async () => {
    bus.emit({ ...BASE_EVENT, workflowPassed: true, reasons: [] });
    await bus.drain();
    const env = await recordedEnv();
    expect(env.NAX_STATUS).toBe("complete");
    expect("NAX_REASON" in env).toBe(false);
    expect("NAX_RESULT_URL" in env).toBe(false);
  });

  test("an event with no workflowPassed field is complete and still reports NAX_COST", async () => {
    bus.emit({ ...BASE_EVENT, totalCost: 4.9449 });
    await bus.drain();
    const env = await recordedEnv();
    expect(env.NAX_STATUS).toBe("complete");
    expect(env.NAX_COST).toBe("4.9449");
  });
});
