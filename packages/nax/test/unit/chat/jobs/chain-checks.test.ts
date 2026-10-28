import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import { type ChatChains, createChainController } from "@/chat/jobs/chain-controller";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import type { ChainStep, ChatChain } from "@/chat/jobs/chain-types";
import type { ChatJob } from "@/chat/jobs/job-types";
import { NaxError } from "@/errors";
import { getLogger, initLogger, resetLogger } from "@/logger";

const originalDeps = { ..._chainStoreDeps };
const now = "2026-10-28T00:00:00.000Z";
const first: ChainStep = { kind: "run", argv: ["nax", "run", "f1"], target: "f1" };
const second: ChainStep = { kind: "run", argv: ["nax", "run", "f2"], target: "f2" };
const review: ChainStep = { kind: "bot_review", argv: ["nax", "bot", "review", "<pr>"], target: "", prIndex: 3 };
const fix: ChainStep = { kind: "bot_fix", argv: ["nax", "bot", "fix", "<pr>"], target: "", prIndex: 3 };
let dir: string;
let session: string;
let chains: ChatChains;
let jobs: Map<string, ChatJob>;
let logger: ReturnType<typeof makeLogger>;
let warnSpy: ReturnType<typeof spyOn>;
let published: number;

async function flushed(count: number): Promise<void> {
  await waitForCondition(() => published >= count, 1_000);
}
async function record(id: string, count: number): Promise<ChatChain | null> {
  await flushed(count);
  return readChainRecord(dir, id);
}
async function ready(checkBefore = "PRD fidelity READY"): Promise<ChatChain> {
  const chain = await chains.activate({ steps: [first, checkBefore ? { ...second, checkBefore } : second] });
  expect(chains.admit(first).kind).toBe("auto");
  succeed(chain.id);
  await flushed(2);
  return chain;
}
function succeed(id: string): void {
  jobs.set("run-1a2b3c4d", {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "f1",
    argv: first.argv,
    cwd: dir,
    pid: 123,
    startedAt: now,
    state: "succeeded",
    logPath: "job.log",
    sessionId: session,
    approvedAt: now,
  });
  chains.started(id, 1, "run-1a2b3c4d");
}
function botCall(step: ChainStep, pr: number) {
  return { kind: step.kind, argv: [...step.argv.slice(0, 3), String(pr)], pr };
}
beforeEach(() => {
  dir = makeTempDir("chain-checks-");
  session = "chat-1";
  jobs = new Map();
  published = 0;
  logger = makeLogger();
  initLogger({ level: "silent" });
  const currentLogger = getLogger();
  if (!currentLogger) throw new NaxError("Missing logger", "TEST_FAILURE", { stage: "test" });
  warnSpy = spyOn(currentLogger, "warn").mockImplementation(logger.warn);
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
    jobs: { get: (id) => jobs.get(id), onChange: () => () => {} },
    sessionId: () => session,
    now: () => new Date(now),
  });
});
afterEach(() => {
  chains.dispose();
  warnSpy.mockRestore();
  resetLogger();
  Object.assign(_chainStoreDeps, originalDeps);
  cleanupTempDir(dir);
});

describe("createChainController checks and stops", () => {
  test("AC-1 recorded passing check admits step 2", async () => {
    await ready();
    expect(chains.recordCheck(2, true, "READY")).toEqual({ ok: true });
    expect(chains.admit(second)).toMatchObject({ kind: "auto", step: 2 });
    await flushed(3);
  });
  test("AC-2 persists the check verdict and timestamp", async () => {
    const chain = await ready();
    expect(chains.recordCheck(2, true, "READY")).toEqual({ ok: true });
    expect((await record(chain.id, 3))?.steps[1]?.check).toEqual({ passed: true, note: "READY", at: now });
  });
  test("AC-3 failed check stops irreversibly with the named reason", async () => {
    const chain = await ready();
    expect(chains.recordCheck(2, false, "2 blockers")).toEqual({ ok: true });
    expect((await record(chain.id, 3))?.stopReason).toBe('check "PRD fidelity READY" did not pass: 2 blockers');
    expect(chains.recordCheck(2, true, "retry")).toEqual({ ok: false, message: "no active chain" });
    expect(chains.admit(second)).toEqual({ kind: "card" });
  });
  test("AC-4 rejects a step without a check", async () => {
    await ready("");
    expect(chains.recordCheck(2, true, "x")).toEqual({ ok: false, message: "step 2 has no check to record" });
    expect(published).toBe(2);
  });
  test("AC-5 rejects anything but the next step", async () => {
    await ready();
    expect(chains.recordCheck(3, true, "x")).toEqual({ ok: false, message: "step 3 is not the next step" });
    expect(published).toBe(2);
  });
  test("AC-6 rejects checks without activation", () => {
    expect(chains.recordCheck(1, true, "x")).toEqual({ ok: false, message: "no active chain" });
  });
  test("AC-7 stop returns reason and end time", async () => {
    await chains.activate({ steps: [first] });
    expect(chains.stop("user asked")).toMatchObject({ state: "stopped", stopReason: "user asked", endedAt: now });
    await flushed(2);
  });
  test("AC-8 stop persists stopped state", async () => {
    const chain = await chains.activate({ steps: [first] });
    chains.stop("user asked");
    expect((await record(chain.id, 2))?.state).toBe("stopped");
  });
  test("AC-9 no active chain means no stop write", () => {
    expect(chains.stop("x")).toBeUndefined();
    expect(published).toBe(0);
  });
  test("AC-10 isActive is false after stop", async () => {
    const chain = await chains.activate({ steps: [first] });
    expect(chains.isActive(chain.id)).toBe(true);
    chains.stop("x");
    expect(chains.isActive(chain.id)).toBe(false);
    await flushed(2);
  });
  test("AC-11 a foreign ID is not active", async () => {
    await chains.activate({ steps: [first] });
    expect(chains.isActive("chain-ffffffff")).toBe(false);
  });
  test("AC-12 ignores started for a foreign ID", async () => {
    await chains.activate({ steps: [first] });
    chains.started("chain-ffffffff", 1, "run-1a2b3c4d");
    expect(chains.active()?.steps[0]?.jobId).toBeUndefined();
    expect(published).toBe(1);
  });
  test("AC-13 active invalidates a changed session", async () => {
    const chain = await chains.activate({ steps: [first] });
    session = "chat-2";
    expect(chains.active()).toBeUndefined();
    expect((await record(chain.id, 2))?.stopReason).toBe("chat session changed");
  });
  test("AC-14 started preserves audit after stop", async () => {
    const chain = await chains.activate({ steps: [first] });
    chains.stop("x");
    chains.started(chain.id, 1, "run-1a2b3c4d");
    const saved = await record(chain.id, 3);
    expect(saved?.steps[0]?.jobId).toBe("run-1a2b3c4d");
    expect(saved?.state).toBe("stopped");
  });
  test("AC-15 admission reports session invalidation", async () => {
    const chain = await chains.activate({ steps: [first] });
    session = "chat-2";
    expect(chains.admit(first)).toEqual({ kind: "card", note: `chain ${chain.id} stopped: chat session changed` });
    await flushed(2);
  });
  test("AC-16 later PR-less bot step reuses PR", async () => {
    const chain = await chains.activate({ steps: [review, fix] });
    expect(chains.admit(botCall(review, 12)).kind).toBe("auto");
    succeed(chain.id);
    expect(chains.admit(botCall(fix, 12))).toMatchObject({ kind: "auto", step: 2 });
    expect(chains.active()?.pr).toBe(12);
    await flushed(2);
  });
  test("AC-17 later PR-less bot step cannot change PR", async () => {
    const chain = await chains.activate({ steps: [review, fix] });
    expect(chains.admit(botCall(review, 12)).kind).toBe("auto");
    succeed(chain.id);
    expect(chains.admit(botCall(fix, 13))).toEqual({
      kind: "card",
      note: `chain ${chain.id} stopped: PR 13 differs from PR 12 the chain already uses`,
    });
    await flushed(3);
  });
  test.each([18, 19])("AC-%i stop write failure retains state and logs warning", async () => {
    const chain = await chains.activate({ steps: [first] });
    _chainStoreDeps.write = async () => {
      throw new NaxError("disk full", "TEST_FAILURE", { stage: "test" });
    };
    expect(chains.stop("x")).toMatchObject({ state: "stopped" });
    expect(chains.active()).toBeUndefined();
    await waitForCondition(() => logger.calls.length > 0, 1_000);
    expect(logger.calls).toContainEqual({
      level: "warn",
      stage: "chat",
      message: "Failed to write chain record",
      data: { chainId: chain.id, error: `[chat] Failed to write chain ${chain.id}` },
    });
  });
  test("AC-20 check write failure does not revoke authorization", async () => {
    await ready();
    _chainStoreDeps.write = async () => {
      throw new NaxError("disk full", "TEST_FAILURE", { stage: "test" });
    };
    expect(chains.recordCheck(2, true, "READY")).toEqual({ ok: true });
    await waitForCondition(() => logger.calls.length > 0, 1_000);
    expect(chains.admit(second)).toMatchObject({ kind: "auto", step: 2 });
  });
  test.each(["summary", "recordCheck", "isActive"] as const)("%s invalidates session before use", async (method) => {
    const chain = await chains.activate({ steps: [{ ...first, checkBefore: "READY" }] });
    session = "chat-2";
    if (method === "summary")
      expect(chains.summary()).toMatchObject({ state: "stopped", stopReason: "chat session changed" });
    if (method === "recordCheck")
      expect(chains.recordCheck(1, true, "READY")).toEqual({ ok: false, message: "no active chain" });
    if (method === "isActive") expect(chains.isActive(chain.id)).toBe(false);
    expect((await record(chain.id, 2))?.state).toBe("stopped");
    session = "chat-1";
    expect(chains.active()).toBeUndefined();
    expect((await chains.activate({ steps: [first] })).state).toBe("active");
  });
});
