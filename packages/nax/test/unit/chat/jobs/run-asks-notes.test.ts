import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { assertDefined, cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import type { HostChoiceCard } from "@/chat/ask-controller";
import { jobAsksDir } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _runAsksDeps, type ChatRunAsks, createRunAsks } from "@/chat/jobs/run-asks";
import {
  _chatAskFileDeps,
  chatAskKey,
  chatHeartbeatFresh,
  RUN_ASK_POLL_MS,
  readChatAnswer,
  verifyChatRecord,
  writeChatAsk,
  writeChatNotice,
  writeChatSettled,
} from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";

const secret = new Uint8Array(32).fill(7);
const original = { ..._runAsksDeps };
const originalFiles = { ..._chatAskFileDeps };
const request: InteractionRequest = {
  id: "ix-1",
  type: "confirm",
  featureName: "feature",
  stage: "cost",
  summary: "Cost limit exceeded",
  fallback: "abort",
  createdAt: 0,
};
let outputDir: string;
let dir: string;
let jobs: ChatJob[];
let clock = makeFakeClock();
let change: () => void;
let registry: ChatRunAsks;
let logger = makeLogger();
let choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
let scanned = Promise.resolve();
let hasSecret: boolean;
let unsubscribed: boolean;
function firstJob(): ChatJob {
  const job = jobs[0];
  assertDefined(job);
  return job;
}

beforeEach(() => {
  outputDir = makeTempDir("run-asks-notes-");
  dir = jobAsksDir(outputDir, "run-1a2b3c4d");
  mkdirSync(dir, { recursive: true });
  jobs = [
    {
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
    },
  ];
  clock = makeFakeClock();
  logger = makeLogger();
  hasSecret = true;
  unsubscribed = false;
  choice = mock((_card: HostChoiceCard) => new Promise<string>(() => {}));
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
    logger,
    chains: { isActive: () => false },
    asks: { requestHostChoice: choice, requestHostQuestion: async () => null },
    jobs: {
      running: () => jobs.filter((job) => job.state === "running"),
      get: (id) => jobs.find((job) => job.id === id),
      askSecret: () => (hasSecret ? secret : undefined),
      onChange: (listener) => {
        change = listener;
        return () => {
          unsubscribed = true;
        };
      },
    },
  });
});
afterEach(async () => {
  registry.dispose();
  await Promise.resolve();
  Object.assign(_runAsksDeps, original);
  Object.assign(_chatAskFileDeps, originalFiles);
  cleanupTempDir(outputDir);
});
async function tick(): Promise<void> {
  await clock.advance(RUN_ASK_POLL_MS);
  await scanned;
}
async function publish(): Promise<string> {
  return writeChatAsk(dir, request, new Date(0), secret);
}
async function settle(by: string, value?: string): Promise<void> {
  const key = await publish();
  await writeChatSettled(
    dir,
    key,
    { requestId: request.id, by, action: "approve", value, settledAt: new Date(0).toISOString() },
    secret,
  );
}

describe("createRunAsks notes and resource ownership", () => {
  test.each([
    ["telegram", "[run-1a2b3c4d] ask settled by telegram: approve"],
    ["timeout", "[run-1a2b3c4d] ask timed out: Cost limit exceeded"],
    ["chat-user", undefined],
    ["chat-agent", undefined],
    ["cancelled", undefined],
  ])("AC-1–5 settled by %s", async (by, expected) => {
    assertDefined(by);
    await settle(by);
    await tick();
    expect(registry.takeNotes()).toEqual(expected ? [expected] : []);
  });
  test("settled value takes precedence over action", async () => {
    await settle("telegram", "main");
    await tick();
    expect(registry.takeNotes()).toEqual(["[run-1a2b3c4d] ask settled by telegram: main"]);
  });
  test("AC-6,7,9 notice queues, notifies and drains once", async () => {
    const listener = mock(() => {});
    registry.onChange(listener);
    await writeChatNotice(
      dir,
      { ...request, type: "notify", summary: "advisor: ruling flagged for a human" },
      new Date(0),
      secret,
    );
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.takeNotes()).toEqual(["[run-1a2b3c4d] advisor: ruling flagged for a human"]);
    expect(registry.takeNotes()).toEqual([]);
  });
  test("job exit drains final notices and settlements without heartbeat or cards", async () => {
    await tick();
    await settle("timeout");
    await writeChatNotice(dir, { ...request, type: "notify", summary: "final advisor" }, new Date(0), secret);
    const heartbeat = mock(original.writeChatHeartbeat);
    _runAsksDeps.writeChatHeartbeat = heartbeat;
    jobs[0] = { ...firstJob(), state: "succeeded" };
    change();
    await tick();
    expect(registry.takeNotes()).toEqual([
      "[run-1a2b3c4d] final advisor",
      "[run-1a2b3c4d] ask timed out: Cost limit exceeded",
    ]);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(choice).not.toHaveBeenCalled();
    await tick();
    expect(registry.takeNotes()).toEqual([]);
  });
  test("AC-8 failed user answer adds delivery note", async () => {
    _runAsksDeps.writeChatAnswer = async () => {
      throw new Error("disk full");
    };
    choice.mockResolvedValue("approve");
    await publish();
    await tick();
    let notes: readonly string[] = [];
    await waitForCondition(() => {
      notes = registry.takeNotes();
      return notes.length > 0;
    });
    expect(notes).toEqual([`[run-1a2b3c4d] could not deliver your answer for run-1a2b3c4d/${chatAskKey("ix-1")}`]);
    expect(await readChatAnswer(dir, chatAskKey(request.id), secret)).toBeUndefined();
  });
  test("AC-9,10 settlement notifies only once across ticks", async () => {
    const listener = mock(() => {});
    registry.onChange(listener);
    await settle("telegram");
    await tick();
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.takeNotes()).toHaveLength(1);
  });
  test("AC-11,12 directory failure warns once, isolates jobs and retries", async () => {
    const other = { ...firstJob(), id: "run-2a2b3c4d" };
    jobs.push(other);
    const otherDir = jobAsksDir(outputDir, other.id);
    mkdirSync(otherDir, { recursive: true });
    await publish();
    await writeChatAsk(otherDir, request, new Date(0), secret);
    _runAsksDeps.readChatAsks = async (path, ...args) => {
      if (path === dir) throw new Error("unreadable");
      return original.readChatAsks(path, ...args);
    };
    const warn = mock(logger.warn);
    logger.warn = warn;
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(choice).toHaveBeenCalledTimes(1);
    _runAsksDeps.readChatAsks = original.readChatAsks;
    await tick();
    expect(choice).toHaveBeenCalledTimes(2);
  });
  test("AC-13,14 disposal removes all heartbeats, unsubscribes, stops timers and preserves asks", async () => {
    const otherDir = jobAsksDir(outputDir, "run-2a2b3c4d");
    jobs.push({ ...firstJob(), id: "run-2a2b3c4d" });
    mkdirSync(otherDir, { recursive: true });
    const key = await publish();
    await tick();
    registry.dispose();
    expect(await Bun.file(`${dir}/heartbeat.json`).exists()).toBe(false);
    expect(await Bun.file(`${otherDir}/heartbeat.json`).exists()).toBe(false);
    expect(await Bun.file(`${dir}/${key}.ask.json`).exists()).toBe(true);
    expect(unsubscribed).toBe(true);
    expect(clock.pending()).toBe(0);
    await clock.advance(RUN_ASK_POLL_MS);
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(false);
  });
  test.each(["cancelled", "succeeded", "lost"] as const)("AC-15,16 %s aborts card without answer", async (state) => {
    const reply = Promise.withResolvers<string>();
    choice.mockImplementation(() => reply.promise);
    const key = await publish();
    await tick();
    jobs[0] = { ...firstJob(), state };
    change();
    expect(choice.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    reply.resolve("approve");
    await Promise.resolve();
    await Promise.resolve();
    expect(await readChatAnswer(dir, key, secret)).toBeUndefined();
  });
  test.each(["unsigned", "wrong-secret"])("AC-17,18 %s ask ignored and warned once per file", async (kind) => {
    const key = await publish();
    const path = `${dir}/${key}.ask.json`;
    const raw = await Bun.file(path).json();
    if (kind === "unsigned") delete raw.mac;
    else raw.mac = "0".repeat(64);
    await Bun.write(path, JSON.stringify(raw));
    const warn = mock(logger.warn);
    logger.warn = warn;
    await tick();
    await tick();
    expect(choice).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test("AC-19 answer is signed with job secret", async () => {
    choice.mockResolvedValue("approve");
    const key = await publish();
    await tick();
    await waitForCondition(() => Bun.file(`${dir}/${key}.answer.json`).size > 0);
    expect(verifyChatRecord(secret, await Bun.file(`${dir}/${key}.answer.json`).json())).toBe(true);
  });
  test("AC-20 no secret means no heartbeat, directory read or card", async () => {
    hasSecret = false;
    await publish();
    const read = mock(original.readChatAsks);
    _runAsksDeps.readChatAsks = read;
    await tick();
    expect(await chatHeartbeatFresh(dir, clock.now())).toBe(false);
    expect(choice).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  test("dispose during directory read prevents cards", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof original.readChatAsks>>>();
    const key = await publish();
    const records = await original.readChatAsks(dir, secret);
    _runAsksDeps.readChatAsks = () => pending.promise;
    await clock.advance(RUN_ASK_POLL_MS);
    registry.dispose();
    pending.resolve(records);
    await scanned;
    expect(choice).not.toHaveBeenCalled();
    expect(await readChatAnswer(dir, key, secret)).toBeUndefined();
  });
  test.each(["heartbeat", "answer"])("dispose during %s publication prevents late rename", async (kind) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const key = await publish();
    _chatAskFileDeps.write = async (destination, data, options) => {
      // The protocol publishes JSON through string temporary-file paths only.
      if (typeof destination !== "string" || typeof data !== "string") {
        throw new Error("Expected a JSON temporary-file write");
      }
      const result = await originalFiles.write(destination, data, options);
      if (destination.includes(kind === "answer" ? ".answer.json." : "heartbeat.json.")) {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const rename = mock(originalFiles.rename);
    _chatAskFileDeps.rename = rename;
    if (kind === "answer") {
      choice.mockResolvedValue("approve");
      _runAsksDeps.writeChatAnswer = async (...args) => {
        try {
          await original.writeChatAnswer(...args);
        } finally {
          finished.resolve();
        }
      };
    }
    await clock.advance(RUN_ASK_POLL_MS);
    await entered.promise;
    registry.dispose();
    const renamesAtClose = rename.mock.calls.length;
    release.resolve();
    await scanned;
    if (kind === "answer") await finished.promise;
    expect(rename.mock.calls.length).toBe(renamesAtClose);
    expect(await Bun.file(`${dir}/heartbeat.json`).exists()).toBe(false);
    expect(await readChatAnswer(dir, key, secret)).toBeUndefined();
  });
  test.each(["notice", "settled"])("invalid %s warns once and queues no note", async (kind) => {
    const key = await publish();
    if (kind === "notice") await writeChatNotice(dir, request, new Date(0), secret);
    else await settle("telegram");
    const path = `${dir}/${key}.${kind}.json`;
    const raw = await Bun.file(path).json();
    delete raw.mac;
    await Bun.write(path, JSON.stringify(raw));
    const warn = mock(logger.warn);
    logger.warn = warn;
    await tick();
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(registry.takeNotes()).toEqual([]);
  });
});
