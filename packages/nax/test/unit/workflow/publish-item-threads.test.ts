import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _featureDeps } from "@/workflow/feature-deps";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import { type ItemThreadsInput, postItemThreads } from "@/workflow/item-threads-post";
import { postItemThreadsAfterPublish } from "@/workflow/publish-item-threads";

const URL = "https://github.com/o/r/pull/7";
const HEAD = "a".repeat(40);
const published: PublishOutcome = { outcome: "draft", url: URL, ci: "pending", reasons: ["wait"] };
const result = { posted: 0, closed: 0, skipped: 0, failed: 0 };
function harness(out: PublishOutcome = published) {
  const base = makeFeatureMachineHarness(
    { published: out },
    { stories: [makeDoneStory("S1", { state: "complete-gate-open", reason: "held" })] },
  );
  const inputs: ItemThreadsInput[] = [];
  const bases: string[] = [];
  const env: FeatureEnv = {
    ...base.env,
    itemThreadsIdentity: { projectDir: "/captured/repo", feature: "demo" },
    steps: {
      ...base.env.steps,
      head: async () => HEAD,
      changedFiles: async (seed) => {
        bases.push(seed);
        return ["file.ts"];
      },
      postItemThreads: async (input) => {
        inputs.push(input);
        return result;
      },
    },
  };
  return { env, inputs, bases };
}
let logs: LogEntry[];
let remove: () => void;
const original = _featureDeps.forge;
beforeEach(() => {
  logs = [];
  initLogger({ level: "warn", suppressConsole: true });
  remove = addSink((entry) => {
    logs.push(entry);
  });
});
afterEach(() => {
  _featureDeps.forge = original;
  remove();
  resetLogger();
});

describe("postItemThreadsAfterPublish", () => {
  test.each(["draft", "ready"] as const)(
    "AC-10/11 %s calls once with publish facts, explicit identity, head and changed files",
    async (outcome) => {
      const out: PublishOutcome = {
        ...published,
        outcome,
        ciDetail: "detail",
        approval: { approved: false, rationale: "hold", decisionId: "D1" },
      };
      const h = harness(out);
      await postItemThreadsAfterPublish(h.env, h.env.record, out, HEAD);
      expect(h.inputs).toHaveLength(1);
      expect(h.bases).toEqual([h.env.record.seed ?? ""]);
      expect(h.inputs[0]).toMatchObject({
        url: URL,
        head: HEAD,
        projectDir: "/captured/repo",
        feature: "demo",
        changedFiles: ["file.ts"],
        record: {
          ...h.env.record,
          outcome,
          ci: out.ci,
          ciDetail: "detail",
          approval: out.approval,
          reasons: ["wait"],
          storyStates: [{ id: "S1", state: "complete-gate-open", reason: "held" }],
        },
      });
    },
  );
  test.each(["local-only", "pushed"] as const)("AC-12 %s does not post or read changed files", async (outcome) => {
    const h = harness();
    await postItemThreadsAfterPublish(h.env, h.env.record, { ...published, outcome }, HEAD);
    expect(h.inputs).toEqual([]);
    expect(h.bases).toEqual([]);
    await postItemThreadsAfterPublish(h.env, h.env.record, published, HEAD);
    expect(h.inputs).toHaveLength(1);
  });
  test("no URL or absent step does no additional work", async () => {
    const h = harness();
    await postItemThreadsAfterPublish(h.env, h.env.record, { ...published, url: undefined }, HEAD);
    await postItemThreadsAfterPublish(
      { ...h.env, steps: { ...h.env.steps, postItemThreads: undefined } },
      h.env.record,
      published,
      HEAD,
    );
    expect(h.inputs).toEqual([]);
    expect(h.bases).toEqual([]);
  });
  test("AC-13 changedFiles failure falls back to an empty list", async () => {
    const h = harness();
    h.env.steps.changedFiles = async () => {
      throw new Error("git failed");
    };
    await postItemThreadsAfterPublish(h.env, h.env.record, published, HEAD);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]?.changedFiles).toEqual([]);
  });
  test("empty seed never asks git for a range", async () => {
    const h = harness();
    await postItemThreadsAfterPublish(h.env, { ...h.env.record, seed: "" }, published, HEAD);
    expect(h.bases).toEqual([]);
    expect(h.inputs[0]?.changedFiles).toEqual([]);
  });
  test("AC-14 a throwing step warns and returns normally", async () => {
    const h = harness();
    let calls = 0;
    h.env.steps.postItemThreads = async () => {
      calls++;
      throw new Error("post unavailable");
    };
    await expect(postItemThreadsAfterPublish(h.env, h.env.record, published, HEAD)).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(logs.some((entry) => entry.level === "warn" && String(entry.data?.error).includes("post unavailable"))).toBe(
      true,
    );
  });
});

describe("publishStep item-thread seam", () => {
  test("AC-15 draft publish reaches the optional step once", async () => {
    const h = harness();
    const out = await publishStep(h.env, h.env.record);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]?.record.outcome).toBe("draft");
    expect(out.patch?.outcome).toBe("draft");
  });
  test("AC-16 local-only publish skips the step", async () => {
    const h = harness({ ...published, outcome: "local-only" });
    await publishStep(h.env, h.env.record);
    expect(h.inputs).toEqual([]);
    h.env.steps.publish = async () => published;
    await publishStep(h.env, h.env.record);
    expect(h.inputs).toHaveLength(1);
  });
  test("AC-17 defined, absent and throwing steps leave the same publish patch", async () => {
    const patches: NonNullable<Awaited<ReturnType<typeof publishStep>>["patch"]>[] = [];
    for (const mode of ["defined", "absent", "throws"]) {
      const h = harness();
      if (mode === "absent") h.env.steps.postItemThreads = undefined;
      if (mode === "throws")
        h.env.steps.postItemThreads = async () => {
          throw new Error("post failed");
        };
      const out = await publishStep(h.env, h.env.record);
      const { endedAt, ...patch } = out.patch ?? {};
      expect(endedAt).toEqual(expect.any(String));
      patches.push(patch);
      if (mode === "defined") expect(h.inputs).toHaveLength(1);
    }
    expect(patches[1]).toEqual(patches[0]);
    expect(patches[2]).toEqual(patches[0]);
  });
  test("AC-20 initial PR read failure preserves publish outcome", async () => {
    const h = harness();
    let calls = 0;
    _featureDeps.forge = {
      readText: async () => null,
      run: async () => {
        calls++;
        throw new Error("PR unavailable");
      },
    };
    h.env.steps.postItemThreads = postItemThreads;
    const out = await publishStep(h.env, h.env.record);
    expect(calls).toBe(1);
    expect(out.patch).toMatchObject({ outcome: "draft", url: URL, ci: "pending", reasons: ["wait"] });
    expect(logs.some((entry) => entry.message.includes("Initial PR read failed"))).toBe(true);
  });
});
