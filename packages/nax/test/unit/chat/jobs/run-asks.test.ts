import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import type { HostChoiceCard } from "@/chat/ask-controller";
import { jobAsksDir } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _runAsksDeps, type ChatRunAsks, createRunAsks } from "@/chat/jobs/run-asks";
import {
  chatHeartbeatFresh,
  RUN_ASK_POLL_MS,
  readChatAnswer,
  writeChatAsk,
  writeChatSettled,
} from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";

const secret = new Uint8Array(32).fill(7);
const original = { ..._runAsksDeps };
const request: InteractionRequest = {
  id: "ask-1",
  type: "confirm",
  featureName: "feature",
  stage: "cost",
  summary: "Continue?",
  detail: "cost $4.10 of $5.00",
  fallback: "abort",
  createdAt: 1,
};
let outputDir: string;
let dir: string;
let job: ChatJob;
let clock = makeFakeClock();
let change: () => void;
let registry: ChatRunAsks;
let choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
let question = mock((_card: { text: string; signal?: AbortSignal }) => new Promise<string | null>(() => {}));
let hasSecret: boolean;
let scanned = Promise.resolve();
beforeEach(() => {
  outputDir = makeTempDir("run-asks-");
  dir = jobAsksDir(outputDir, "run-12345678");
  mkdirSync(dir, { recursive: true });
  clock = makeFakeClock();
  Object.assign(_runAsksDeps, {
    setTimeout: (callback: () => void, ms: number) =>
      clock.setTimeout(() => {
        scanned = Promise.resolve(callback());
      }, ms),
    clearTimeout: clock.clearTimeout,
  });
  job = {
    schemaVersion: 1,
    id: "run-12345678",
    kind: "run",
    target: "feature",
    argv: [],
    cwd: outputDir,
    pid: 123,
    startedAt: new Date(0).toISOString(),
    state: "running",
    logPath: "log",
    sessionId: "session",
    approvedAt: new Date(0).toISOString(),
  };
  choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
  question = mock((_card: { text: string; signal?: AbortSignal }) => new Promise<string | null>(() => {}));
  hasSecret = true;
  registry = createRunAsks({
    outputDir,
    now: () => new Date(clock.now()),
    logger: makeLogger(),
    chains: { isActive: () => false },
    asks: { requestHostChoice: choice, requestHostQuestion: question },
    jobs: {
      running: () => (job.state === "running" ? [job] : []),
      get: () => job,
      askSecret: () => (hasSecret ? secret : undefined),
      onChange: (listener) => {
        change = listener;
        return () => {};
      },
    },
  });
});
afterEach(() => {
  registry?.dispose();
  Object.assign(_runAsksDeps, original);
  cleanupTempDir(outputDir);
});
async function tick(): Promise<void> {
  change();
  await clock.advance(RUN_ASK_POLL_MS);
  await scanned;
}
async function publish(req = request): Promise<string> {
  return writeChatAsk(dir, req, new Date(clock.now()), secret);
}

describe("createRunAsks", () => {
  test("AC-1 refreshes running heartbeat", async () => {
    await tick();
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(true);
  });
  test("AC-2 skips succeeded heartbeat", async () => {
    job = { ...job, state: "succeeded" };
    await tick();
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(false);
  });
  test("skips jobs without secret", async () => {
    hasSecret = false;
    await publish();
    await tick();
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(false);
    expect(choice).not.toHaveBeenCalled();
  });
  test("AC-3,5,6,7,8 confirm card fields; AC-21 no agent notice", async () => {
    await publish();
    await tick();
    expect(choice).toHaveBeenCalledTimes(1);
    expect(choice.mock.calls[0]?.[0]).toMatchObject({
      tool: "nax-run__ask",
      fallback: "closed",
      reason: "cost $4.10 of $5.00",
      summary: `${job.id}: Continue?`,
      choices: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Deny" },
      ],
    });
    expect(registry.peekNotice()).toBeUndefined();
  });
  test("AC-4 maps choose options and missing detail", async () => {
    await publish({
      ...request,
      type: "choose",
      detail: undefined,
      options: [
        { key: "allow", label: "Allow" },
        { key: "deny", label: "Deny" },
      ],
    });
    await tick();
    expect(choice.mock.calls[0]?.[0]).toMatchObject({
      reason: request.summary,
      choices: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  test("AC-9 input text includes detail", async () => {
    await publish({ ...request, type: "input" });
    await tick();
    expect(question.mock.calls[0]?.[0].text).toBe(`${job.id}: Continue?\ncost $4.10 of $5.00`);
  });
  test.each([
    ["confirm", "approve", { action: "approve" }],
    ["confirm", "reject", { action: "reject" }],
    ["choose", "allow", { action: "choose", value: "allow" }],
    ["input", "main", { action: "input", value: "main" }],
  ] as const)("AC-10–13 encodes %s response %s with chat-user provenance", async (type, answer, expected) => {
    choice.mockImplementation(async () => answer);
    question.mockImplementation(async () => answer);
    const key = await publish({ ...request, type, options: [{ key: "allow", label: "Allow" }] });
    await tick();
    await waitForCondition(() => clock.pending() === 1);
    await waitForCondition(() => Bun.file(`${dir}/${key}.answer.json`).size > 0);
    expect(await readChatAnswer(dir, key, secret)).toMatchObject({
      ...expected,
      requestId: request.id,
      respondedBy: "chat-user",
    });
  });
  test.each(["confirm", "input"] as const)("AC-14,15 closed %s writes nothing", async (type) => {
    choice.mockResolvedValue("closed");
    question.mockResolvedValue(null);
    const key = await publish({ ...request, type });
    await tick();
    expect(type === "input" ? question.mock.calls.length : choice.mock.calls.length).toBe(1);
    expect(await readChatAnswer(dir, key, secret)).toBeUndefined();
  });
  test("AC-16 settlement aborts open card and suppresses late answer", async () => {
    const reply = Promise.withResolvers<string>();
    choice.mockImplementation(() => reply.promise);
    const key = await publish();
    await tick();
    await writeChatSettled(
      dir,
      key,
      { requestId: request.id, by: "telegram", action: "reject", settledAt: new Date(clock.now()).toISOString() },
      secret,
    );
    await tick();
    expect(choice.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    reply.resolve("approve");
    await Promise.resolve();
    await Promise.resolve();
    expect(await readChatAnswer(dir, key, secret)).toBeUndefined();
  });
  test("AC-17 two ticks deduplicate without blocking scan", async () => {
    await publish();
    await tick();
    await tick();
    expect(choice).toHaveBeenCalledTimes(1);
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(true);
  });
  test.each(["confirm", "input"] as const)("AC-18 skips initially settled %s", async (type) => {
    const key = await publish({ ...request, type });
    await writeChatSettled(
      dir,
      key,
      { requestId: request.id, by: "timeout", action: "skip", settledAt: new Date(clock.now()).toISOString() },
      secret,
    );
    await tick();
    expect(choice).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
  });
  test("AC-19,20 job changes start a single polling timer", async () => {
    job = { ...job, state: "succeeded" };
    await clock.advance(RUN_ASK_POLL_MS);
    const schedule = mock(_runAsksDeps.setTimeout);
    _runAsksDeps.setTimeout = schedule;
    job = { ...job, state: "running" };
    change();
    change();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);
    await clock.advance(RUN_ASK_POLL_MS);
    await scanned;
    expect(schedule.mock.calls.at(-1)?.[1]).toBe(RUN_ASK_POLL_MS);
    expect(schedule.mock.calls.length).toBeGreaterThan(1);
  });
  test("later-story placeholders", async () => {
    expect(registry.takeNotice()).toBeUndefined();
    expect(registry.takeNotes()).toEqual([]);
    registry.noteUserTurn();
    expect(await registry.answer("job/key", { answer: "yes", reason: "ok" })).toEqual({
      ok: false,
      message: "[chat] ask job/key is not waiting for the agent",
    });
    registry.onChange(() => {})();
  });
});
