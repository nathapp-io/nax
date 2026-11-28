/**
 * Operator PAUSE at the run root, driven through the real dispatch loop (executeUnified ->
 * runIteration -> queue-check -> result handlers -> completion), with a fake implementer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { makePauseHarness, type PauseHarness, packageStory, restorePauseHarnessDeps } from "./operator-pause-harness";

let root: string;

beforeEach(() => {
  initLogger({ level: "silent" });
  root = makeTempDir("nax-operator-pause-");
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  mkdirSync(join(root, "packages", "b"), { recursive: true });
});

afterEach(() => {
  restorePauseHarnessDeps();
  pipelineEventBus.clear();
  resetLogger();
  cleanupTempDir(root);
});

async function twoStories(): Promise<PauseHarness> {
  return makePauseHarness(root, [packageStory("US-001", "packages/a"), packageStory("US-002", "packages/b")]);
}

function statusOf(prd: { userStories: { id: string; status: string }[] }, id: string): string | undefined {
  return prd.userStories.find((s) => s.id === id)?.status;
}

describe("operator PAUSE at the run root", () => {
  test("AC-1/2/3/4/8: in-flight story passes, no further implementer call, both statuses paused, pending untouched, no feature workflow", async () => {
    const h = await twoStories();
    h.onImplement = async () => {
      await h.queue("PAUSE\n"); // written while the implementer is held
      return undefined; // ...which then returns success
    };

    const { exitReason } = await h.invoke();

    expect(exitReason).toBe("queue-paused");
    expect(h.calls).toEqual(["US-001"]); // AC-2
    const prd = await h.prd();
    expect(statusOf(prd, "US-001")).toBe("passed"); // AC-1
    expect(statusOf(prd, "US-002")).toBe("pending"); // AC-4
    expect(await h.runStatuses()).toEqual({ project: "paused", feature: "paused" }); // AC-3
    expect(h.runWorkflowFeature).not.toHaveBeenCalled(); // AC-8
  });

  test("AC-5: the consumed PAUSE does not pause the resume; untouched story then runs", async () => {
    const h = await twoStories();
    h.onImplement = async () => {
      await h.queue("PAUSE\n");
      return undefined;
    };
    await h.invoke();
    h.onImplement = () => undefined;

    const { exitReason } = await h.invoke();

    expect(exitReason).toBe("completed");
    expect(h.calls).toEqual(["US-001", "US-002"]); // US-001 not rerun
    expect(statusOf(await h.prd(), "US-002")).toBe("passed");
    expect(await Bun.file(join(root, ".queue.txt")).exists()).toBe(false);
  });

  test("AC-6: a non-operator story-level pause still lets another independent story be selected", async () => {
    const h = await twoStories();
    h.onImplement = (story) => (story.id === "US-001" ? { action: "pause", reason: "needs a human" } : undefined);

    await h.invoke();

    expect(h.calls).toEqual(["US-001", "US-002"]);
    const prd = await h.prd();
    expect(statusOf(prd, "US-001")).toBe("paused");
    expect(statusOf(prd, "US-002")).toBe("passed");
    expect((await h.runStatuses()).project).not.toBe("paused");
  });

  test("AC-7: ABORT keeps skip-pending semantics rather than pause/resume", async () => {
    const h = await twoStories();
    h.onImplement = async () => {
      await h.queue("ABORT\n");
      return undefined;
    };

    await h.invoke();

    expect(h.calls).toEqual(["US-001"]);
    const prd = await h.prd();
    expect(statusOf(prd, "US-001")).toBe("passed");
    expect(statusOf(prd, "US-002")).toBe("skipped");
  });

  test("AC-9: INJECT relative.json reads the story stored only in the selected package", async () => {
    const h = await twoStories();
    await Bun.write(
      join(root, "packages", "a", "relative.json"),
      JSON.stringify({
        id: "US-099",
        title: "Injected",
        description: "from the package",
        acceptanceCriteria: ["it works"],
      }),
    );
    expect(await Bun.file(join(root, "relative.json")).exists()).toBe(false);
    await h.queue("INJECT relative.json\n");

    await h.invoke();

    const prd = await h.prd();
    expect(prd.userStories.map((s) => s.id)).toContain("US-099");
  });
});
