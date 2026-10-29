import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, waitForCondition } from "@test/helpers";
import { jobAsksDir } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _runAsksDeps, createRunAsks } from "@/chat/jobs/run-asks";
import { CHAT_ASK_POLL_MS, chatAskKey, RUN_ASK_POLL_MS } from "@/interaction/chat-ask-files";
import { _chatAskPluginDeps, ChatAskPlugin } from "@/interaction/plugins/chat";
import type { InteractionRequest } from "@/interaction/types";

test("AC-22,23 real plugin and registry resolve authenticated approval with chat-user provenance", async () => {
  const outputDir = makeTempDir("run-asks-round-trip-");
  const parentOriginal = { ..._runAsksDeps };
  const childOriginal = { ..._chatAskPluginDeps };
  const parent = makeFakeClock();
  const child = makeFakeClock();
  let scanned = Promise.resolve();
  Object.assign(_runAsksDeps, {
    setTimeout: (callback: () => void, ms: number) =>
      parent.setTimeout(() => {
        scanned = Promise.resolve(callback());
      }, ms),
    clearTimeout: parent.clearTimeout,
  });
  Object.assign(_chatAskPluginDeps, { now: child.now, setTimeout: child.setTimeout, clearTimeout: child.clearTimeout });
  const job: ChatJob = {
    schemaVersion: 1,
    id: "run-12345678",
    kind: "run",
    state: "running",
    target: "feature",
    argv: [],
    cwd: outputDir,
    pid: 123,
    startedAt: new Date(0).toISOString(),
    logPath: "log",
    sessionId: "chat",
    approvedAt: new Date(0).toISOString(),
  };
  const dir = jobAsksDir(outputDir, job.id);
  mkdirSync(dir, { recursive: true });
  const secret = new Uint8Array(32).fill(9);
  const plugin = new ChatAskPlugin({ dir, secret });
  const registry = createRunAsks({
    outputDir,
    now: () => new Date(parent.now()),
    logger: makeLogger(),
    chains: { isActive: () => false },
    jobs: { running: () => [job], get: () => job, askSecret: () => secret, onChange: () => () => {} },
    asks: { requestHostChoice: async () => "approve", requestHostQuestion: async () => null },
  });
  const request: InteractionRequest = {
    id: "seam-confirm",
    type: "confirm",
    featureName: "feature",
    stage: "cost",
    summary: "Proceed?",
    fallback: "abort",
    createdAt: 0,
  };
  try {
    await plugin.send(request);
    const received = plugin.receive(request.id, 60_000);
    await parent.advance(RUN_ASK_POLL_MS);
    await scanned;
    await waitForCondition(() => Bun.file(`${dir}/${chatAskKey(request.id)}.answer.json`).size > 0);
    await child.advance(CHAT_ASK_POLL_MS);
    expect(await received).toMatchObject({ action: "approve", respondedBy: "chat-user", requestId: request.id });
  } finally {
    registry.dispose();
    await plugin.destroy();
    Object.assign(_runAsksDeps, parentOriginal);
    Object.assign(_chatAskPluginDeps, childOriginal);
    cleanupTempDir(outputDir);
  }
});
