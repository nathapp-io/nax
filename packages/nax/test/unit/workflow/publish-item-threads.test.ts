import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { NaxError } from "@/errors";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _featureDeps } from "@/workflow/feature-deps";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import { _itemPublishPacerDeps } from "@/workflow/item-publish-pacer";
import { itemKey } from "@/workflow/item-threads";
import { type ItemThreadsInput, postItemThreads } from "@/workflow/item-threads-post";
import { buildOpenItems } from "@/workflow/open-items";
import { postItemThreadsAfterPublish } from "@/workflow/publish-item-threads";

const URL = "https://github.com/o/r/pull/7";
const HEAD = "a".repeat(40);
const published: PublishOutcome = { outcome: "draft", url: URL, ci: "pending", reasons: ["wait"] };
const result = { posted: 0, closed: 0, skipped: 0, failed: 0, indexWritten: true, indexMissing: false };
const RATE_LIMIT =
  "gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.";
const INDEX_REFUSAL = new NaxError(
  "[forge] Cannot write o/r#7: content creation is rate limited",
  "FORGE_COMMENT_WRITE_FAILED",
  {
    stage: "forge",
    stderr: RATE_LIMIT,
  },
);

/**
 * B1: a PR with no items, whose every index write the forge refuses and whose readback after such a
 * write fails too — the shape a scoped probe found the publish reading as "index present".
 */
function refusedIndexForge(state: { attempted: boolean }) {
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
  const carries = (cmd: readonly string[], needle: string) => cmd.some((arg) => arg.includes(needle));
  const threads = { nodes: [], pageInfo: { hasNextPage: false } };
  return {
    readText: async () => null,
    run: async (cmd: string[], _opts?: { cwd: string }) => {
      if (carries(cmd, "key=w-index")) {
        state.attempted = true;
        throw INDEX_REFUSAL;
      }
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      // The readback that follows the failed write fails too, so the PR cannot be consulted.
      if (carries(cmd, "/issues/7/comments?per_page=") && state.attempted) throw new Error("comments unreadable");
      if (cmd.includes("POST")) return ok({ id: 1 });
      if (cmd.includes("user")) return ok({ login: "bot", id: 1 });
      if (cmd.includes("graphql")) return ok({ data: { repository: { pullRequest: { reviewThreads: threads } } } });
      if (carries(cmd, "?per_page=")) return ok([]);
      return ok({ head: { sha: HEAD, ref: "feature" }, base: { ref: "main" }, user: { login: "author" } });
    },
  };
}

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
  // US-003: the publish needs the outcome, not only the side effects, so the record can say the
  // index the PR now lacks. Nothing posted means nothing to report, hence undefined.
  test("AC-1 returns the outcome the step resolved, and undefined when nothing was posted", async () => {
    const h = harness();
    const missing = { posted: 1, closed: 0, skipped: 2, failed: 3, indexWritten: false, indexMissing: true };
    h.env.steps.postItemThreads = async () => missing;
    await expect(postItemThreadsAfterPublish(h.env, h.env.record, published, HEAD)).resolves.toEqual(missing);
    await expect(
      postItemThreadsAfterPublish(h.env, h.env.record, { ...published, outcome: "local-only" }, HEAD),
    ).resolves.toBeUndefined();
  });
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
  // Fix round 1 (F1): recording the note is best effort, so a ledger failure must not discard the
  // outcome the step resolved — that outcome is the only thing that says whether the index landed.
  test("a throwing ledger write warns and still returns the step's outcome", async () => {
    const h = harness();
    const missing = { posted: 2, closed: 1, skipped: 0, failed: 0, indexWritten: false, indexMissing: true };
    h.env.steps.postItemThreads = async () => missing;
    h.env.sink.ledger = async () => {
      throw new Error("ledger unavailable");
    };
    await expect(postItemThreadsAfterPublish(h.env, h.env.record, published, HEAD)).resolves.toEqual(missing);
    expect(
      logs.some((entry) => entry.level === "warn" && String(entry.data?.error).includes("ledger unavailable")),
    ).toBe(true);
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
  // US-003: `itemIndexMissing` is the one key the modes differ on — it comes from the step's
  // outcome, so a mode that returns no outcome cannot state it. Everything else stays identical.
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
    const { itemIndexMissing, ...withThreads } = patches[0] ?? {};
    expect(itemIndexMissing).toBe(false);
    expect(patches[1]).toEqual(withThreads);
    expect(patches[2]).toEqual(withThreads);
  });
  // US-003: the publish records whether the PR it just published has an item index, so a genuinely
  // missing index is actionable at run end instead of only a `warn` line in the log.
  test.each([
    { ac: "AC-2", indexMissing: true, indexWritten: false },
    { ac: "AC-3", indexMissing: false, indexWritten: true },
  ])("$ac indexMissing $indexMissing reaches the patch, over the record it patches", async ({ ac, ...outcome }) => {
    const h = harness();
    h.env.steps.postItemThreads = async () => ({ posted: 0, closed: 0, skipped: 0, failed: 1, ...outcome });
    // An earlier publish recorded the opposite, so the patch has to write this one's answer.
    const earlier = { ...h.env.record, itemIndexMissing: !outcome.indexMissing };
    const out = await publishStep(h.env, earlier);
    expect(out.patch?.itemIndexMissing).toBe(outcome.indexMissing);
    expect({ ...earlier, ...out.patch }.itemIndexMissing).toBe(outcome.indexMissing);
  });
  test("AC-4 a throwing step leaves no itemIndexMissing key in the patch", async () => {
    const h = harness();
    h.env.steps.postItemThreads = async () => {
      throw new Error("post failed");
    };
    // An earlier publish recorded a missing index; this one reports nothing, so it must not clear it.
    const earlier = { ...h.env.record, itemIndexMissing: true };
    const thrown = await publishStep(h.env, earlier);
    expect(thrown.patch).not.toHaveProperty("itemIndexMissing");
    expect({ ...earlier, ...thrown.patch }.itemIndexMissing).toBe(true);
    // The control: the same environment, whose step resolves an outcome, does carry the key.
    h.env.steps.postItemThreads = async () => ({
      posted: 0,
      closed: 0,
      skipped: 0,
      failed: 0,
      indexWritten: false,
      indexMissing: true,
    });
    expect((await publishStep(h.env, earlier)).patch).toHaveProperty("itemIndexMissing", true);
  });
  // Fix round 1 (F1): the note is best effort, so a ledger failure cannot cost the record the index
  // state this publish resolved.
  test("a throwing item-thread ledger note leaves itemIndexMissing in the patch", async () => {
    const h = harness();
    h.env.steps.postItemThreads = async () => ({
      posted: 1,
      closed: 0,
      skipped: 0,
      failed: 0,
      indexWritten: false,
      indexMissing: true,
    });
    // Only the item-thread note fails; publishStep's own feature line still gets through.
    h.env.sink.ledger = async (line) => {
      if (line.includes("Item threads:")) throw new Error("ledger unavailable");
    };
    const out = await publishStep(h.env, h.env.record);
    expect(out.patch).toHaveProperty("itemIndexMissing", true);
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
  // B1: an outcome that could not confirm the index says nothing either way. Writing `false` from it
  // would clear the warning an earlier publish raised, so the patch states no key at all.
  test("B1 an outcome that cannot confirm the index leaves the record's earlier answer", async () => {
    const h = harness();
    h.env.steps.postItemThreads = async () => ({
      posted: 0,
      closed: 0,
      skipped: 0,
      failed: 1,
      indexWritten: false,
    });
    const earlier = { ...h.env.record, itemIndexMissing: true };
    const out = await publishStep(h.env, earlier);
    expect(out.patch).not.toHaveProperty("itemIndexMissing");
    expect({ ...earlier, ...out.patch }.itemIndexMissing).toBe(true);
  });
  // B1, end to end: the publish's own index write is refused by the forge, the readback that would
  // confirm it fails, and the record must still say the PR has no index — the warning the review
  // found the failed readback erasing.
  test("B1 a refused index write reaches the record as itemIndexMissing when the readback fails", async () => {
    const h = harness();
    const realSleep = _itemPublishPacerDeps.sleep;
    const realForge = _featureDeps.forge;
    _itemPublishPacerDeps.sleep = async () => {};
    const state = { attempted: false };
    _featureDeps.forge = refusedIndexForge(state);
    h.env.steps.postItemThreads = postItemThreads;
    try {
      const earlier = { ...h.env.record, itemIndexMissing: false, reviewOpen: [], cannotVerify: [] };
      const out = await publishStep(h.env, earlier);
      expect(state.attempted).toBe(true);
      expect(out.patch).toHaveProperty("itemIndexMissing", true);
    } finally {
      _itemPublishPacerDeps.sleep = realSleep;
      _featureDeps.forge = realForge;
    }
  });
});

test("publish indexes the same flagged decisions as its persisted record", async () => {
  const h = harness({ ...published, reasons: ["flagged advisor decision"] });
  h.env.steps.flaggedDecisions = async () => ["D1"];
  const out = await publishStep(h.env, h.env.record);
  const posted = h.inputs[0]?.record;
  expect(posted?.flaggedDecisions).toEqual(["D1"]);
  if (!posted) throw new Error("missing publish input");
  const keys = (record: typeof posted) =>
    buildOpenItems(record)
      .filter((item) => item.kind !== "ci")
      .map(itemKey);
  expect(keys(posted)).toEqual(keys({ ...h.env.record, ...out.patch }));
  expect(buildOpenItems(posted).map((item) => item.id)).toContain("D1");
});

test("publish preserves item-thread failure counts in its ledger", async () => {
  const h = harness();
  const lines: string[] = [];
  h.env.sink.ledger = async (line) => {
    lines.push(line);
  };
  h.env.steps.postItemThreads = async () => ({
    posted: 2,
    closed: 1,
    skipped: 3,
    failed: 4,
    indexWritten: true,
    indexMissing: false,
  });
  await publishStep(h.env, h.env.record);
  expect(lines.some((line) => line.includes("Item threads: posted=2, closed=1, skipped=3, failed=4"))).toBe(true);
});
