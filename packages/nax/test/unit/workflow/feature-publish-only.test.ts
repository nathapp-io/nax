import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _fileLockDeps } from "@nathapp/nax-agent/internal";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { runWorkflowFeature } from "@/workflow/feature";
import { writeHandoffMark } from "@/workflow/handoff-mark";
import { handoffLockPath } from "@/workflow/paths";
import { _workflowDeps } from "@/workflow/step-context";
import { registerFeatureRunHarness, seedFinished, setup } from "./_feature-run-harness";

registerFeatureRunHarness();

describe("runWorkflowFeature --publish-only", () => {
  test.each(["local-only", "pushed"] as const)(
    "#2819 publishOnly resumes a %s prior at publish without rerunning the review",
    async (outcome) => {
      const { input, envs, featureDir } = setup();
      await seedFinished(featureDir, input.feature, { outcome });
      const result = await runWorkflowFeature({ ...input, publishOnly: true });
      expect(envs).toHaveLength(1);
      expect(envs[0]?.record.step).toBe("publish");
      expect(result?.outcome).toBe("draft");
    },
  );

  test("#2819 publishOnly with a published prior has nothing to do", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "draft", url: "https://x/pull/1" });
    expect((await runWorkflowFeature({ ...input, publishOnly: true }))?.outcome).toBe("already-finished");
    expect(envs).toHaveLength(0);
  });

  test("#2819 publishOnly without a finished run is refused before the machine starts", async () => {
    const { input, envs } = setup();
    await expect(runWorkflowFeature({ ...input, publishOnly: true })).rejects.toMatchObject({
      code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
    });
    expect(envs).toHaveLength(0);
  });

  /**
   * US-004: once a chat chain handed the feature to koda, koda is its publisher. The mark sits on the
   * newest run, whose record would otherwise resume publishing here.
   */
  test("US-004 AC-9 publishOnly refuses a feature whose newest run was handed off to koda", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "local-only" });
    const runDir = join(featureDir, "r-old");
    await writeHandoffMark(runDir, {
      schemaVersion: 1,
      at: "T",
      flowId: "fl1",
      url: "https://koda/flows/fl1",
    });
    await expect(runWorkflowFeature({ ...input, publishOnly: true })).rejects.toMatchObject({
      code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
      message: `[workflow] --publish-only: ${input.feature} was handed off to koda (flow fl1 https://koda/flows/fl1) at T; koda publishes it. Delete ${join(runDir, "handoff.json")} to publish it here instead`,
    });
    expect(envs).toHaveLength(0);
  });

  /** Start the publisher while another process holds the lock, then mutate state or abort. */
  async function withWaitingPublisher(
    setupRun: ReturnType<typeof setup>,
    check: (waiting: {
      moveHead: () => void;
      switchBranch: () => void;
      lockPath: string;
      release: () => Promise<void>;
      pending: ReturnType<typeof runWorkflowFeature>;
      retried: Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const { featureDir, input } = setupRun;
    await seedFinished(featureDir, input.feature, { outcome: "local-only" });
    const lockPath = handoffLockPath(featureDir);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        String.raw`
        import { withFileLock } from "@nathapp/nax-agent/internal";
        await withFileLock(process.argv[1], async () => {
          await Bun.write(Bun.stdout, "ready\n");
          await new Response(Bun.stdin.stream()).text();
        }, { lockName: "handoff", errorPrefix: "[test]" });
      `,
        lockPath,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        child.stdin.end();
      }
      expect(await child.exited).toBe(0);
    };
    const contended = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    const sleep = _fileLockDeps.sleep;
    let attempts = 0;
    _fileLockDeps.sleep = (ms, signal) => {
      (attempts++ === 0 ? contended : retried).resolve();
      return sleep(ms, signal);
    };
    let head = "headX";
    let branch = "feat/x";
    _workflowDeps.git = async (args) => {
      if (args[0] === "rev-parse") return { stdout: `${head}\n`, exitCode: 0 };
      if (args[0] === "branch") return { stdout: `${branch}\n`, exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    };
    let pending: ReturnType<typeof runWorkflowFeature> | undefined;
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value).trim()).toBe("ready");
      pending = runWorkflowFeature({ ...input, publishOnly: true });
      expect(await Promise.race([contended.promise.then(() => "waiting"), pending])).toBe("waiting");
      await check({
        moveHead: () => {
          head = "headY";
        },
        switchBranch: () => {
          branch = "feat/other";
        },
        lockPath,
        release,
        pending,
        retried: retried.promise,
      });
    } finally {
      await release();
      await pending?.catch(() => {});
    }
  }

  test("a waiting publisher refuses a handoff mark without emitting workflow:started", async () => {
    const run = setup();
    const events: string[] = [];
    const off = pipelineEventBus.onAll((event) => {
      events.push(event.type);
    });
    try {
      await withWaitingPublisher(run, async ({ release, pending }) => {
        await writeHandoffMark(join(run.featureDir, "r-old"), {
          schemaVersion: 1,
          at: "T",
          flowId: "fl1",
          url: "https://koda/flows/fl1",
        });
        await release();
        await expect(pending).rejects.toMatchObject({ code: "WORKFLOW_PUBLISH_ONLY_REFUSED" });
        expect(run.envs).toHaveLength(0);
        expect(events).not.toContain("workflow:started");
      });
    } finally {
      off();
    }
  });

  test("a waiting publisher refuses moved HEAD even when the holder leaves no mark", async () => {
    const run = setup();
    await withWaitingPublisher(run, async ({ moveHead, release, pending }) => {
      moveHead();
      await release();
      await expect(pending).rejects.toMatchObject({
        code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
        message: expect.stringContaining("HEAD moved since the workflow finished"),
      });
      expect(run.envs).toHaveLength(0);
    });
  });

  test("a waiting publisher refuses a checkout switched to another branch at the same HEAD", async () => {
    const run = setup();
    await withWaitingPublisher(run, async ({ switchBranch, release, pending }) => {
      switchBranch();
      await release();
      await expect(pending).rejects.toMatchObject({
        code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
        message: expect.stringContaining('the checkout is on "feat/other", not "feat/x"'),
      });
      expect(run.envs).toHaveLength(0);
    });
  });

  test("an aborted publisher stops waiting while the other process still holds the lock", async () => {
    const controller = new AbortController();
    const run = setup({ runSignal: controller.signal });
    await withWaitingPublisher(run, async ({ lockPath, pending, retried }) => {
      controller.abort();
      const result = await Promise.race([retried.then(() => "retried"), pending.catch((error) => error)]);
      expect(result).toMatchObject({ code: "WORKFLOW_ABORTED" });
      expect(await Bun.file(lockPath).exists()).toBe(true);
      expect(run.envs).toHaveLength(0);
    });
  });

  /**
   * US-001 (run-start-baseline-fixes): the refusal names the commits that moved HEAD.
   * `head` is what `rev-parse HEAD` answers; `log` answers the `git log` lookup, or
   * throws to stand for an unreadable history.
   */
  function stubHeadAndLog(head: string, log: () => { stdout: string; exitCode: number }): string[][] {
    const calls: string[][] = [];
    _workflowDeps.git = async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { stdout: `${head}\n`, exitCode: 0 };
      if (args[0] === "branch") return { stdout: "feat/x\n", exitCode: 0 };
      if (args[0] === "log") return log();
      return { stdout: "", exitCode: 1 };
    };
    return calls;
  }

  test("AC-17: a publish-only refusal for an all-auto-commit move says so", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "ready", head: "h1" });
    stubHeadAndLog("h2", () => ({
      stdout: "abc1234\tchore(f): auto-commit after run-summary session\n",
      exitCode: 0,
    }));

    await expect(runWorkflowFeature({ ...input, publishOnly: true })).rejects.toMatchObject({
      code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
      message: expect.stringContaining("by nax auto-commits only"),
    });
  });

  test("AC-18: an unreadable commit log falls back to the plain refusal", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "ready", head: "h1" });
    stubHeadAndLog("h2", () => {
      throw new Error("git log failed");
    });

    await expect(runWorkflowFeature({ ...input, publishOnly: true })).rejects.toMatchObject({
      code: "WORKFLOW_PUBLISH_ONLY_REFUSED",
      message: expect.stringContaining(
        "HEAD moved since the workflow finished; run nax run so the new commits are reviewed",
      ),
    });
  });

  test("AC-19: a prior recorded at the current HEAD never looks the commits up", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "ready", head: "headX" });
    const calls = stubHeadAndLog("headX", () => ({ stdout: "", exitCode: 0 }));

    expect((await runWorkflowFeature({ ...input, publishOnly: true }))?.outcome).toBe("already-finished");
    expect(calls.filter((args) => args[0] === "log")).toEqual([]);
  });
});
