import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanupTempDir, makeTempDir, waitForCondition } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import type { ChainStep, ChatChain } from "@/chat/jobs/chain-types";
import type { ChatJob, ChatJobState } from "@/chat/jobs/job-types";

const originalDeps = { ..._chainStoreDeps };
const now = "2026-10-28T00:00:00.000Z";
const first: ChainStep = { kind: "run", argv: ["nax", "run", "f1"], target: "f1" };
const second: ChainStep = { kind: "run", argv: ["nax", "run", "f2"], target: "f2" };
const review: ChainStep = { kind: "bot_review", argv: ["nax", "bot", "review", "12"], target: "12" };
const jobId = "run-1a2b3c4d";
let dir: string;
let chains: ChatChains;
let jobs: Map<string, ChatJob>;
let listener: () => void;
let published: number;
let write: ReturnType<typeof spyOn<typeof _chainStoreDeps, "write">>;
const unsubscribe = mock(() => {});

async function saved(chain: Pick<ChatChain, "id">, state: string): Promise<ChatChain | null> {
  await waitForCondition(() => {
    const input = write.mock.calls.at(-1)?.[1];
    return typeof input === "string" && JSON.parse(input).state === state && published === write.mock.calls.length;
  }, 1_000);
  return readChainRecord(dir, chain.id);
}
async function start(steps: readonly ChainStep[] = [first, second, review], costCap?: number): Promise<ChatChain> {
  const chain = await chains.activate({ steps, ...(costCap === undefined ? {} : { costCap }) });
  expect(chains.admit(steps[0] ?? first).kind).toBe("auto");
  setJob(jobId, "running");
  chains.started(chain.id, 1, jobId);
  return chain;
}
function setJob(id: string, state: ChatJobState, cost?: number): void {
  jobs.set(id, {
    schemaVersion: 1,
    id,
    kind: "run",
    target: "f1",
    argv: first.argv,
    cwd: dir,
    pid: 123,
    startedAt: now,
    state,
    logPath: "job.log",
    sessionId: "chat-1",
    approvedAt: now,
    ...(cost === undefined ? {} : { cost }),
  });
}
beforeEach(() => {
  dir = makeTempDir("chain-transitions-");
  jobs = new Map();
  published = 0;
  listener = () => {};
  unsubscribe.mockClear();
  write = spyOn(_chainStoreDeps, "write");
  _chainStoreDeps.rename = (from, to) => {
    originalDeps.rename(from, to);
    published++;
  };
  _chainStoreDeps.link = (from, to) => {
    originalDeps.link(from, to);
    published++;
  };
  chains = createChainController({
    outputDir: dir,
    cwd: dir,
    sessionId: () => "chat-1",
    now: () => new Date(now),
    jobs: {
      get: (id) => jobs.get(id),
      onChange: (callback) => {
        listener = callback;
        return unsubscribe;
      },
    },
  });
});
afterEach(async () => {
  chains.dispose();
  chains.stop("cleanup");
  const summary = chains.summary();
  if (summary) await saved(summary, summary.state);
  write.mockRestore();
  Object.assign(_chainStoreDeps, originalDeps);
  cleanupTempDir(dir);
});

describe("createChainController job-end transitions", () => {
  test.each([
    [1, "failed"],
    [2, "cancelled"],
    [3, "lost"],
  ] as const)("AC-%i stops and persists when the step ends %s", async (_ac, state) => {
    const chain = await start();
    setJob(jobId, state);
    listener();
    expect(chains.active()).toBeUndefined();
    expect(await saved(chain, "stopped")).toMatchObject({ state: "stopped", stopReason: `step 1 ended ${state}` });
  });
  test("AC-4 completes and persists the last step with the injected timestamp", async () => {
    const chain = await start([first]);
    setJob(jobId, "succeeded");
    listener();
    expect(await saved(chain, "completed")).toMatchObject({ state: "completed", endedAt: now });
  });
  test("AC-5 completed chain is no longer active", async () => {
    await start([first]);
    setJob(jobId, "succeeded");
    listener();
    expect(chains.active()).toBeUndefined();
  });
  test("AC-6 intermediate success without a cap stays active", async () => {
    const chain = await start();
    setJob(jobId, "succeeded");
    listener();
    expect(chains.active()?.id).toBe(chain.id);
  });
  test("AC-7 sums earlier jobs before enforcing the cap", async () => {
    const chain = await start([first, second, review], 10);
    setJob(jobId, "succeeded", 6);
    listener();
    expect(chains.admit(second)).toMatchObject({ kind: "auto", step: 2 });
    setJob("run-abcdef12", "succeeded", 5);
    chains.started(chain.id, 2, "run-abcdef12");
    listener();
    expect(await saved(chain, "stopped")).toMatchObject({ stopReason: "cost cap $10.00 reached: spent $11.00" });
    expect(chains.summary()?.spent).toBe(11);
  });
  test("AC-8 below-cap success stays active", async () => {
    const chain = await start([first, second], 10);
    setJob(jobId, "succeeded", 4);
    listener();
    expect(chains.active()?.id).toBe(chain.id);
  });
  test("AC-9 missing job cost contributes zero", async () => {
    await start();
    expect(chains.summary()?.spent).toBe(0);
  });
  test("AC-10 exact cap stops between steps", async () => {
    const chain = await start([first, second], 10);
    setJob(jobId, "succeeded", 10);
    listener();
    expect(await saved(chain, "stopped")).toMatchObject({ stopReason: "cost cap $10.00 reached: spent $10.00" });
  });
  test("AC-11 admission completes before validating any argv", async () => {
    const chain = await start([first]);
    setJob(jobId, "succeeded");
    expect(chains.admit({ kind: "plan", argv: ["anything"] })).toEqual({ kind: "card" });
    expect(await saved(chain, "completed")).toMatchObject({ state: "completed" });
  });
  test("AC-12 repeated terminal events do not write again", async () => {
    const chain = await start();
    setJob(jobId, "failed");
    listener();
    expect(await saved(chain, "stopped")).toMatchObject({ state: "stopped" });
    const count = write.mock.calls.length;
    listener();
    // A queued write would run before this continuation.
    await Promise.resolve();
    expect(write.mock.calls.length).toBe(count);
  });
  test("AC-13 running jobs stay active even over cap", async () => {
    const chain = await start([first, second], 10);
    setJob(jobId, "running", 20);
    listener();
    expect(chains.active()?.id).toBe(chain.id);
  });
  test("AC-14 admission reconciles missed failure events with a stop note", async () => {
    const chain = await start();
    setJob(jobId, "failed");
    expect(chains.admit(second)).toEqual({ kind: "card", note: `chain ${chain.id} stopped: step 1 ended failed` });
  });
  test("AC-15 summary before activation is null", () => {
    expect(chains.summary()).toBeNull();
  });
  test("AC-16 summary resolves jobs and reports the next unreserved step", async () => {
    const chain = await start([first, review], 25);
    expect(chains.summary()).toEqual({
      id: chain.id,
      state: "active",
      next: 2,
      steps: [
        { step: 1, kind: "run", argv: first.argv, job: jobId, jobState: "running" },
        { step: 2, kind: "bot_review", argv: review.argv },
      ],
      costCap: 25,
      spent: 0,
    });
  });
  test("AC-17 stopped summary retains the reason", async () => {
    const chain = await start();
    chains.stop("x");
    expect(chains.summary()).toMatchObject({ id: chain.id, state: "stopped", stopReason: "x" });
  });
  test("AC-18 stopped summary omits next", async () => {
    await start();
    chains.stop("x");
    expect(chains.summary()).not.toHaveProperty("next");
  });
  test("AC-19 disposal unsubscribes and guards captured callbacks", async () => {
    await start();
    chains.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    setJob(jobId, "failed");
    listener();
    expect(chains.summary()?.state).toBe("active");
    chains.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  test("unknown jobs are not reconciled", async () => {
    const chain = await start();
    jobs.delete(jobId);
    listener();
    expect(chains.active()?.id).toBe(chain.id);
  });
  test("last-step completion takes precedence over the cap", async () => {
    await start([first], 0);
    setJob(jobId, "succeeded", 10);
    listener();
    expect(chains.summary()).toMatchObject({ state: "completed", spent: 10 });
    expect(chains.summary()).not.toHaveProperty("next");
  });
});
