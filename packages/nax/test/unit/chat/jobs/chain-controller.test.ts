import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import type { ChainStep } from "@/chat/jobs/chain-types";
import type { ChatJob, ChatJobState } from "@/chat/jobs/job-types";
import { NaxError } from "@/errors";

const originalDeps = { ..._chainStoreDeps };
const approvedAt = "2026-10-28T00:00:00.000Z";
const first: ChainStep = { kind: "run", argv: ["nax", "run", "f1"], target: "f1" };
const second: ChainStep = { kind: "run", argv: ["nax", "run", "f2"], target: "f2" };
let dir: string;
let chains: ChatChains;
let jobs: Map<string, ChatJob>;
let writes: number;
let waiters: { count: number; resolve: () => void }[];

function written(count: number): Promise<void> {
  if (writes >= count) return Promise.resolve();
  return new Promise((resolve) => waiters.push({ count, resolve }));
}
function job(state: ChatJobState): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "f1",
    argv: first.argv,
    cwd: dir,
    pid: 123,
    startedAt: approvedAt,
    state,
    logPath: "job.log",
    sessionId: "chat-1",
    approvedAt,
  };
}
function controller(): ChatChains {
  return createChainController({
    outputDir: dir,
    cwd: dir,
    sessionId: () => "chat-1",
    now: () => new Date(approvedAt),
    jobs: { get: (id) => jobs.get(id), onChange: () => () => {} },
  });
}
async function twoSteps(state?: ChatJobState, checkBefore?: string): Promise<string> {
  const chain = await chains.activate({ steps: [first, { ...second, checkBefore }] });
  expect(chains.admit(first).kind).toBe("auto");
  if (state) {
    jobs.set("run-1a2b3c4d", job(state));
    chains.started(chain.id, 1, "run-1a2b3c4d");
    await written(2);
  }
  return chain.id;
}
async function expectStopped(id: string, reason: string, launch = first): Promise<void> {
  expect(chains.admit(launch)).toEqual({ kind: "card", note: `chain ${id} stopped: ${reason}` });
  expect(chains.active()).toBeUndefined();
  await written(2);
}
beforeEach(() => {
  dir = makeTempDir("chain-controller-");
  jobs = new Map();
  writes = 0;
  waiters = [];
  _chainStoreDeps.rename = (from, to) => {
    originalDeps.rename(from, to);
    writes++;
    for (const waiter of waiters) if (writes >= waiter.count) waiter.resolve();
    waiters = waiters.filter((waiter) => writes < waiter.count);
  };
  chains = controller();
});
afterEach(() => {
  chains?.dispose();
  Object.assign(_chainStoreDeps, originalDeps);
  cleanupTempDir(dir);
});

describe("createChainController", () => {
  test("AC-1 activates the approved steps", async () => {
    expect((await chains.activate({ steps: [first] })).state).toBe("active");
  });
  test("AC-2 records the approving session", async () => {
    expect((await chains.activate({ steps: [first] })).sessionId).toBe("chat-1");
  });
  test("AC-3 records the approval time", async () => {
    expect((await chains.activate({ steps: [first] })).approvedAt).toBe(approvedAt);
  });
  test("AC-4 persists activation before publishing it", async () => {
    const chain = await chains.activate({ steps: [first] });
    expect(await readChainRecord(dir, chain.id)).toEqual(chain);
    expect(chain.state).toBe("active");
    expect(chain.cwd).toBe(dir);
    expect(chains.active()).toEqual(chain);
  });
  test("AC-5 fails closed on write failure and permits retry", async () => {
    _chainStoreDeps.write = async () => {
      throw new NaxError("write failed", "TEST_FAILURE", { stage: "test" });
    };
    await expect(chains.activate({ steps: [first] })).rejects.toMatchObject({
      code: "CHAT_CHAIN_WRITE_FAILED",
      context: { stage: "chat" },
    });
    expect(chains.active()).toBeUndefined();
    _chainStoreDeps.write = originalDeps.write;
    expect((await chains.activate({ steps: [first] })).state).toBe("active");
  });
  test("AC-6 rejects activation while active", async () => {
    await chains.activate({ steps: [first] });
    const attempt = chains.activate({ steps: [second] });
    await expect(attempt).rejects.toBeInstanceOf(NaxError);
    await expect(attempt).rejects.toMatchObject({ code: "CHAT_CHAIN_ACTIVE", context: { stage: "chat" } });
  });
  test("AC-7 guards activation synchronously while the durable write is pending", async () => {
    const gate = Promise.withResolvers<void>();
    _chainStoreDeps.write = async (destination, input, options) => {
      await gate.promise;
      if (typeof input !== "string") {
        throw new NaxError("Expected chain JSON string", "TEST_FAILURE", { stage: "test" });
      }
      return originalDeps.write(destination, input, options);
    };
    const one = chains.activate({ steps: [first] });
    const two = chains.activate({ steps: [second] });
    expect(chains.active()).toBeUndefined();
    const result = Promise.allSettled([one, two]);
    gate.resolve();
    const [a, b] = await result;
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "CHAT_CHAIN_ACTIVE" } });
  });
  test("AC-8 requires a card without an active chain, including a new host", async () => {
    expect(chains.admit(first)).toEqual({ kind: "card" });
    await chains.activate({ steps: [first] });
    expect(controller().admit(first)).toEqual({ kind: "card" });
  });
  test("AC-9 admits the exact approved launch", async () => {
    const chain = await chains.activate({ steps: [first] });
    expect(chains.admit(first)).toEqual({ kind: "auto", chainId: chain.id, step: 1, approvedAt });
  });
  test("AC-10 rejects additional argv tokens", async () => {
    const chain = await chains.activate({ steps: [first] });
    await expectStopped(chain.id, "off-card step", { ...first, argv: [...first.argv, "-m", "40"] });
  });
  test("AC-11 clears active chain after an off-card launch", async () => {
    const chain = await chains.activate({ steps: [first] });
    await expectStopped(chain.id, "off-card step", { ...first, argv: [] });
    expect(chains.active()).toBeUndefined();
  });
  test("AC-12 rejects a different kind even with identical argv", async () => {
    const chain = await chains.activate({ steps: [first] });
    await expectStopped(chain.id, "off-card step", { ...first, kind: "plan" });
  });
  test("AC-13 resolves the designated PR placeholder and binds the chain PR", async () => {
    const step: ChainStep = { kind: "bot_review", argv: ["nax", "bot", "review", "<pr>"], prIndex: 3, target: "" };
    const chain = await chains.activate({ steps: [step] });
    expect(chains.admit({ ...step, argv: ["nax", "bot", "review", "12"], pr: 12 }).kind).toBe("auto");
    expect(chains.active()?.pr).toBe(12);
    expect(chains.isActive(chain.id)).toBe(true);
  });
  test("AC-14 does not substitute a fixed PR", async () => {
    const step: ChainStep = { kind: "bot_review", argv: ["nax", "bot", "review", "12"], target: "12" };
    const chain = await chains.activate({ steps: [step] });
    expect(chains.admit({ ...step, argv: ["nax", "bot", "review", "13"], pr: 13 })).toEqual({
      kind: "card",
      note: `chain ${chain.id} stopped: off-card step`,
    });
    await written(2);
  });
  test("AC-15 reserves synchronously so a one-step chain cannot admit twice", async () => {
    const chain = await chains.activate({ steps: [first] });
    expect(chains.admit(first).kind).toBe("auto");
    await expectStopped(chain.id, "off-card step");
  });
  test.each([
    { ac: 16, state: "running" as const },
    { ac: 18, state: undefined },
  ])("AC-$ac refuses step 2 when step 1 has not succeeded ($state)", async ({ state }) => {
    const id = await twoSteps(state);
    expect(chains.admit(second)).toEqual({ kind: "card", note: `chain ${id} stopped: step 1 has not succeeded` });
    await written(state ? 3 : 2);
  });
  test("AC-17 admits step 2 after the previous job succeeded", async () => {
    const id = await twoSteps("succeeded");
    expect(chains.admit(second)).toEqual({ kind: "auto", chainId: id, step: 2, approvedAt });
  });
  test("AC-19 requires the named check after step 1 succeeded", async () => {
    const id = await twoSteps("succeeded", "PRD fidelity READY");
    expect(chains.admit(second)).toEqual({
      kind: "card",
      note: `chain ${id} stopped: check "PRD fidelity READY" not recorded`,
    });
    await written(3);
  });
  test("AC-20 persists the started job", async () => {
    const id = await twoSteps("running");
    expect((await readChainRecord(dir, id))?.steps[0]?.jobId).toBe("run-1a2b3c4d");
  });
  test("retains late-start audit data after stopping and ignores stale chain callbacks", async () => {
    const chain = await chains.activate({ steps: [first] });
    chains.admit(first);
    chains.stop("user");
    chains.started(chain.id, 1, "run-1a2b3c4d");
    await written(3);
    const record = await readChainRecord(dir, chain.id);
    expect(record?.state).toBe("stopped");
    expect(record?.steps[0]?.jobId).toBe("run-1a2b3c4d");
    expect(chains.stop("overwrite")).toBeUndefined();
    chains.started("chain-00000000", 1, "other");
    chains.startFailed("chain-00000000", 1, "stale");
    expect(chains.summary()?.stopReason).toBe("user");
    expect(chains.isActive(chain.id)).toBe(false);
    expect(writes).toBe(3);
  });
  test("exposes minimal check and summary contracts", async () => {
    expect(chains.summary()).toBeNull();
    expect(chains.recordCheck(1, true, "x")).toEqual({ ok: false, message: "no active chain" });
    const id = await twoSteps("succeeded", "READY");
    expect(chains.recordCheck(3, true, "x")).toEqual({ ok: false, message: "step 3 is not the next step" });
    expect(chains.recordCheck(2, true, "verified")).toEqual({ ok: true });
    await written(3);
    expect((await readChainRecord(dir, id))?.steps[1]?.check).toEqual({
      passed: true,
      note: "verified",
      at: approvedAt,
    });
    expect(chains.admit(second)).toMatchObject({ kind: "auto", step: 2 });
    expect(chains.summary()).toMatchObject({ id, state: "active", spent: 0 });
    expect(chains.summary()).not.toHaveProperty("next");
  });
  test("retains authoritative state and continues the write queue after a later write failure", async () => {
    const chain = await chains.activate({ steps: [first] });
    let attempts = 0;
    _chainStoreDeps.write = async (destination, input, options) => {
      if (++attempts === 1) throw new NaxError("write failed", "TEST_FAILURE", { stage: "test" });
      if (typeof input !== "string") {
        throw new NaxError("Expected chain JSON string", "TEST_FAILURE", { stage: "test" });
      }
      return originalDeps.write(destination, input, options);
    };
    chains.stop("user");
    chains.started(chain.id, 1, "run-1a2b3c4d");
    await written(2);
    expect(attempts).toBe(2);
    expect(chains.active()).toBeUndefined();
    expect(await readChainRecord(dir, chain.id)).toMatchObject({
      state: "stopped",
      stopReason: "user",
      steps: [{ jobId: "run-1a2b3c4d" }],
    });
  });
  test("AC-21 stops and persists a launch failure", async () => {
    const chain = await chains.activate({ steps: [first] });
    chains.admit(first);
    chains.startFailed(chain.id, 1, "checkout busy");
    expect(chains.active()).toBeUndefined();
    await written(2);
    expect((await readChainRecord(dir, chain.id))?.stopReason).toBe("step 1 could not start: checkout busy");
  });
});
