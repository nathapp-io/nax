/** Operator PAUSE at the final-story boundary: the run is paused, not completed. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { makePauseHarness, packageStory, restorePauseHarnessDeps } from "./operator-pause-harness";

let root: string;

beforeEach(() => {
  initLogger({ level: "silent" });
  root = makeTempDir("nax-operator-pause-final-");
  mkdirSync(join(root, "packages", "a"), { recursive: true });
});

afterEach(() => {
  restorePauseHarnessDeps();
  pipelineEventBus.clear();
  resetLogger();
  cleanupTempDir(root);
});

describe("operator PAUSE before the final story returns", () => {
  test("AC-10/11/12/13: story stays passed, run paused in both files, workflow held until explicit resume", async () => {
    const h = await makePauseHarness(root, [packageStory("US-001", "packages/a")]);
    h.onImplement = async () => {
      await h.queue("PAUSE\n");
      return undefined;
    };

    await h.invoke();

    expect((await h.prd()).userStories[0]?.status).toBe("passed"); // AC-10
    expect(await h.runStatuses()).toEqual({ project: "paused", feature: "paused" }); // AC-11
    expect(h.runWorkflowFeature).not.toHaveBeenCalled(); // AC-12

    h.onImplement = () => {
      throw new Error("passed story must not rerun");
    };
    const { exitReason } = await h.invoke(); // AC-13: explicit resume of the all-passed PRD

    expect(exitReason).toBe("completed");
    expect(h.calls).toEqual(["US-001"]);
    expect(h.runWorkflowFeature).toHaveBeenCalledTimes(1);
    expect((await h.runStatuses()).feature).toBe("completed");
  });
});
