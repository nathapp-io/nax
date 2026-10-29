import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cleanupTempDir, makeFakeClock, makeLogger, makeTempDir } from "@test/helpers";
import type { HostChoiceCard } from "@/chat/ask-controller";
import { jobAsksDir } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _runAsksDeps, type ChatRunAsks, createRunAsks } from "@/chat/jobs/run-asks";
import { RUN_ASK_POLL_MS, readChatAnswer, writeChatAsk, writeChatSettled } from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";
import { buildRunAskNotice } from "@/prompts/builders/run-ask-builder";

const original = { ..._runAsksDeps };
const secret = new Uint8Array(32).fill(7);
const request: InteractionRequest = {
  id: "ix-1",
  type: "confirm",
  featureName: "feature",
  stage: "cost",
  summary: "Cost limit exceeded",
  fallback: "abort",
  createdAt: 0,
};
const reply = { answer: "approve", reason: "within budget" };
let outputDir: string;
let dir: string;
let job: ChatJob;
let active: boolean;
let registry: ChatRunAsks;
let clock = makeFakeClock();
let scanned = Promise.resolve();
let change: () => void;
let choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
let question = mock(async () => null);
beforeEach(() => {
  outputDir = makeTempDir("run-asks-agent-");
  job = {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "feature",
    argv: [],
    cwd: outputDir,
    pid: 1,
    startedAt: new Date(0).toISOString(),
    state: "running",
    logPath: "log",
    sessionId: "session",
    approvedAt: new Date(0).toISOString(),
    chainId: "chain-1",
  };
  dir = jobAsksDir(outputDir, job.id);
  mkdirSync(dir, { recursive: true });
  active = true;
  clock = makeFakeClock();
  choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
  question = mock(async () => null);
  Object.assign(_runAsksDeps, {
    setTimeout: (callback: () => void | Promise<void>, ms: number) =>
      clock.setTimeout(() => {
        scanned = Promise.resolve(callback());
      }, ms),
    clearTimeout: clock.clearTimeout,
  });
  registry = createRunAsks({
    outputDir,
    now: () => new Date(clock.now()),
    logger: makeLogger(),
    chains: { isActive: (id) => active && id === "chain-1" },
    asks: { requestHostChoice: choice, requestHostQuestion: question },
    jobs: {
      running: () => (job.state === "running" ? [job] : []),
      get: () => job,
      askSecret: () => secret,
      onChange: (listener) => {
        change = listener;
        return () => {};
      },
    },
  });
});
afterEach(async () => {
  registry.dispose();
  await Promise.resolve();
  Object.assign(_runAsksDeps, original);
  cleanupTempDir(outputDir);
});
async function tick(): Promise<void> {
  await clock.advance(RUN_ASK_POLL_MS);
  await scanned;
}
async function publish(overrides: Partial<InteractionRequest> = {}): Promise<string> {
  const key = await writeChatAsk(dir, { ...request, ...overrides }, new Date(0), secret);
  await tick();
  return `${job.id}/${key}`;
}
function key(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}
async function settle(id: string): Promise<void> {
  await writeChatSettled(
    dir,
    key(id),
    { requestId: request.id, by: "telegram", action: "approve", settledAt: new Date(0).toISOString() },
    secret,
  );
}
function notWaiting(id: string) {
  return { ok: false, message: `[chat] ask ${id} is not waiting for the agent` };
}
describe("createRunAsks agent routing", () => {
  test("AC-1 agent route opens neither card type", async () => {
    await publish();
    await publish({ id: "input-1", type: "input" });
    expect(choice).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
  });
  test("AC-2,3,4 notice equals builder text and drains once", async () => {
    const id = await publish();
    const notice = buildRunAskNotice(id, request);
    expect(registry.peekNotice()).toBe(notice);
    expect(registry.takeNotice()).toBe(notice);
    expect(registry.peekNotice()).toBeUndefined();
    expect(registry.takeNotice()).toBeUndefined();
  });
  test("AC-5,6,7,8 signed answer stores action, attribution, reason and exact note once", async () => {
    const id = await publish();
    expect(await registry.answer(id, reply)).toEqual({ ok: true });
    expect(await readChatAnswer(dir, key(id), secret)).toMatchObject({
      action: "approve",
      respondedBy: "chat-agent",
      reason: "within budget",
    });
    expect(registry.takeNotes()).toEqual([`[${job.id}] agent answered approve: within budget`]);
    expect(registry.takeNotes()).toEqual([]);
    expect(registry.peekNotice()).toBeUndefined();
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
  });
  test("AC-9 allow-remember is refused without a file", async () => {
    const id = await publish({
      type: "choose",
      metadata: { approvalPrompt: true },
      options: [
        { key: "allow", label: "Allow" },
        { key: "allow-remember", label: "Remember" },
        { key: "deny", label: "Deny" },
      ],
    });
    expect(registry.peekNotice()).toBeDefined();
    expect((await registry.answer(id, { ...reply, answer: "allow-remember" })).ok).toBe(false);
    expect(await readChatAnswer(dir, key(id), secret)).toBeUndefined();
  });
  test("AC-10 invalid choose option is refused", async () => {
    const id = await publish({ type: "choose", options: [{ key: "skip", label: "Skip" }] });
    expect(registry.peekNotice()).toBeDefined();
    expect((await registry.answer(id, reply)).ok).toBe(false);
    expect(await readChatAnswer(dir, key(id), secret)).toBeUndefined();
  });
  test("valid choose answer encodes option key", async () => {
    const id = await publish({ type: "choose", options: [{ key: "skip", label: "Skip" }] });
    expect(await registry.answer(id, { ...reply, answer: "skip" })).toEqual({ ok: true });
    expect(await readChatAnswer(dir, key(id), secret)).toMatchObject({ action: "choose", value: "skip" });
  });
  test("AC-11 input preserves free text", async () => {
    const id = await publish({ type: "input" });
    expect(await registry.answer(id, { ...reply, answer: "use main" })).toEqual({ ok: true });
    expect(await readChatAnswer(dir, key(id), secret)).toMatchObject({ action: "input", value: "use main" });
  });
  test("AC-12,13 escalation removes notice, opens human card and writes nothing", async () => {
    const id = await publish();
    expect(await registry.answer(id, { ...reply, answer: "escalate" })).toEqual({ ok: true });
    expect(choice).toHaveBeenCalledTimes(1);
    expect(choice.mock.calls[0]?.[0].summary).toBe(`${job.id}: ${request.summary}`);
    expect(registry.peekNotice()).toBeUndefined();
    expect(await readChatAnswer(dir, key(id), secret)).toBeUndefined();
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
  });
  test("AC-14 unknown ask gives exact error", async () => {
    expect(await registry.answer("unknown", reply)).toEqual(notWaiting("unknown"));
  });
  test("AC-15 settled ask is ineligible even before next tick", async () => {
    const id = await publish();
    expect(registry.peekNotice()).toBeDefined();
    await settle(id);
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
    expect(await readChatAnswer(dir, key(id), secret)).toBeUndefined();
  });
  test("AC-16,17 fourth handoff opens card; user turn resets streak", async () => {
    for (let i = 0; i < 3; i++) await publish({ id: `ask-${i}` });
    expect(choice).not.toHaveBeenCalled();
    await publish({ id: "fourth" });
    expect(choice).toHaveBeenCalledTimes(1);
    registry.noteUserTurn();
    const id = await publish({ id: "fifth" });
    expect(choice).toHaveBeenCalledTimes(1);
    expect(await registry.answer(id, reply)).toEqual({ ok: true });
  });
  test("AC-18 settlement removes queued notice on tick", async () => {
    const id = await publish();
    expect(registry.peekNotice()).toBeDefined();
    await settle(id);
    await tick();
    expect(registry.peekNotice()).toBeUndefined();
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
  });
  test.each(["red", "inactive", "no-chain", "pre-merge", "human-review"])(
    "AC-19,20 %s routes to human",
    async (condition) => {
      if (condition === "inactive") active = false;
      if (condition === "no-chain") job = { ...job, chainId: undefined };
      const metadata = condition === "red" ? { safety: "red" } : { trigger: condition };
      const id = await publish({ metadata });
      expect(choice).toHaveBeenCalledTimes(1);
      expect(registry.peekNotice()).toBeUndefined();
      expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
    },
  );
  test("AC-21 escalation counts toward streak", async () => {
    for (let i = 0; i < 2; i++) {
      const id = await publish({ id: `answered-${i}` });
      expect(await registry.answer(id, reply)).toEqual({ ok: true });
    }
    const id = await publish({ id: "escalated" });
    await registry.answer(id, { ...reply, answer: "escalate" });
    await publish({ id: "fourth" });
    expect(choice).toHaveBeenCalledTimes(2);
  });
  test("AC-22 write failure resolves exact error and allows retry", async () => {
    const id = await publish();
    _runAsksDeps.writeChatAnswer = async () => {
      throw new Error("disk full");
    };
    expect(await registry.answer(id, reply)).toEqual({
      ok: false,
      message: `[chat] could not write the answer for ${id}`,
    });
    expect(registry.takeNotes()).toEqual([]);
    _runAsksDeps.writeChatAnswer = original.writeChatAnswer;
    expect(await registry.answer(id, reply)).toEqual({ ok: true });
  });
  test("competing answer after registry precheck cannot be overwritten by the agent", async () => {
    const id = await publish();
    const competing = {
      requestId: request.id,
      action: "reject" as const,
      respondedBy: "chat-user" as const,
      respondedAt: new Date(0).toISOString(),
      reason: "human denied",
    };
    _runAsksDeps.writeChatAnswer = async (...args) => {
      // This seam is reached only after the registry's answer-file precheck.
      await original.writeChatAnswer(dir, key(id), competing, secret);
      await original.writeChatAnswer(...args);
    };
    const result = await registry.answer(id, reply);
    expect(await readChatAnswer(dir, key(id), secret)).toEqual(competing);
    expect(result.ok).toBe(false);
    expect(registry.takeNotes()).toEqual([]);
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
    expect(registry.peekNotice()).toBeUndefined();
  });
  test("concurrent agent replies publish once", async () => {
    const id = await publish();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = mock(async (...args: Parameters<typeof original.writeChatAnswer>) => {
      entered.resolve();
      await release.promise;
      await original.writeChatAnswer(...args);
    });
    _runAsksDeps.writeChatAnswer = write;
    const first = registry.answer(id, reply);
    await entered.promise;
    expect(await registry.answer(id, reply)).toEqual(notWaiting(id));
    release.resolve();
    expect(await first).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(registry.takeNotes()).toHaveLength(1);
  });
  test("notices are FIFO and changes notify subscribers", async () => {
    const listener = mock(() => {});
    registry.onChange(listener);
    const first = await publish();
    const second = await publish({ id: "second" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.takeNotice()).toBe(buildRunAskNotice(first, request));
    expect(registry.takeNotice()).toBe(buildRunAskNotice(second, { ...request, id: "second" }));
    expect(registry.peekNotice()).toBeUndefined();
  });
  test("taken notice stays answerable; job end clears notices and eligibility", async () => {
    const id = await publish();
    expect(registry.takeNotice()).toBeDefined();
    expect(await registry.answer(id, reply)).toEqual({ ok: true });
    const other = await publish({ id: "other" });
    job = { ...job, state: "succeeded" };
    change();
    expect(registry.peekNotice()).toBeUndefined();
    expect(await registry.answer(other, reply)).toEqual(notWaiting(other));
  });
});
