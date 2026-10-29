import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession, SessionMeta } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir, waitForCondition } from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import { createChatAskController } from "@/chat/ask-controller";
import { createCloseConfirm } from "@/chat/close-confirm";
import { createHostJobs } from "@/chat/jobs";
import { _chainStoreDeps, readChainRecord } from "@/chat/jobs/chain-store";
import { _jobRunnerDeps } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { featureDir } from "@/config";
import { buildResourceCatalog } from "@/resources";

const dirs: string[] = [];
const hosts: ReturnType<typeof createChatHost>[] = [];
const compositions: ReturnType<typeof createHostJobs>[] = [];
const originalLaunch = { ..._jobsLaunchDeps };
const originalRunner = { ..._jobRunnerDeps };
const originalWrite = _chainStoreDeps.write;
const originalRename = _chainStoreDeps.rename;
const now = () => new Date("2026-10-28T00:00:00Z");
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.asks.reset();
    await host.close();
  }
  for (const composition of compositions.splice(0)) {
    composition.chains?.dispose();
    composition.jobs.dispose();
  }
  Object.assign(_jobsLaunchDeps, originalLaunch);
  Object.assign(_jobRunnerDeps, originalRunner);
  _chainStoreDeps.write = originalWrite;
  _chainStoreDeps.rename = originalRename;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function fixture() {
  const repoRoot = makeTempDir("host-chain-");
  dirs.push(repoRoot);
  const outputDir = join(repoRoot, "output");
  const config = makeNaxConfig({ outputDir, execution: { approvalTimeout: 30_000 } });
  const logger = makeLogger();
  return {
    repoRoot,
    config,
    logger,
    now,
    naxEntry: ["bun", "/n.ts"],
    outputDir,
    sessionId: () => "chat-chain",
  };
}
function compose() {
  const options = fixture();
  const asks = createChatAskController({ mode: "full", approvalTimeoutMs: 30_000, now, answer: () => {} });
  const approve = spyOn(asks, "requestHostApproval").mockResolvedValue("deny");
  const composed = createHostJobs({ ...options, asks });
  compositions.push(composed);
  const choice = spyOn(asks, "requestHostChoice").mockResolvedValue("leave");
  const confirmClose = createCloseConfirm({ hostJobs: composed, asks, logger: options.logger });
  return { ...options, ...composed, approve, choice, confirmClose };
}
async function activate(f: ReturnType<typeof compose>) {
  await f.chains.activate({ steps: [{ kind: "run", argv: ["bun", "/n.ts", "run", "f1"], target: "f1" }] });
}

describe("createHostJobs chains", () => {
  test("session replacement during activation cannot survive a session round trip", async () => {
    const f = compose();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    _chainStoreDeps.write = async (path, data) => {
      if (typeof path !== "string" || typeof data !== "string") throw new Error("expected JSON audit write");
      writing.resolve();
      await release.promise;
      return originalWrite(path, data);
    };
    const pending = activate(f);
    await writing.promise;
    f.sessionChanged();
    f.sessionChanged();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "CHAT_CHAIN_SESSION_CHANGED" });
    expect(f.chains.active()).toBeUndefined();
    expect(f.chains.summary()).toMatchObject({ state: "stopped", stopReason: "chat session changed" });
  });
  test.each([false, true])("F3 close blocks an in-flight activation (owned job=%s)", async (owned) => {
    const f = compose();
    const writing = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const closeDecision = Promise.withResolvers<string>();
    const stoppedRecord = Promise.withResolvers<void>();
    _chainStoreDeps.rename = (from, to) => {
      originalRename(from, to);
      stoppedRecord.resolve();
    };
    _chainStoreDeps.write = async (path, data) => {
      if (typeof path !== "string" || typeof data !== "string") throw new Error("expected JSON audit write");
      writing.resolve();
      await releaseWrite.promise;
      return originalWrite(path, data);
    };
    if (owned) {
      spyOn(f.jobs, "owned").mockReturnValue([
        {
          schemaVersion: 1,
          id: "run-12345678",
          kind: "run",
          target: "f1",
          cwd: f.repoRoot,
          pid: 42,
          state: "running",
          sessionId: "chat-chain",
          argv: [],
          approvedAt: now().toISOString(),
          startedAt: now().toISOString(),
          logPath: join(f.repoRoot, "job.log"),
        },
      ]);
    }
    f.approve.mockResolvedValue("allow");
    f.choice.mockImplementation((card) =>
      card.tool === "nax-close" ? closeDecision.promise : Promise.resolve("stay"),
    );
    _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
    const chainTool = (await f.provider.tools(f.repoRoot)).find((t) => t.localName === "chain");
    assertDefined(chainTool, "chain tool");
    const activation = chainTool.run(
      { steps: [{ kind: "run", input: { feature: "f1" } }] },
      {
        root: f.repoRoot,
        resolvedPaths: [],
        maxBytes: 300_000,
        maxFileBytes: 300_000,
      },
    );
    await writing.promise;
    const closing = f.confirmClose().then((quit) => {
      if (quit) f.close();
    });
    closeDecision.resolve("leave");
    await closing;
    try {
      releaseWrite.resolve();
      const result = await activation;
      expect(f.chains.active()).toBeUndefined();
      expect(result.isError).toBe(true);
      expect(f.chains.summary()).toMatchObject({ state: "stopped", stopReason: "the chat closed" });
      const summary = f.chains.summary();
      assertDefined(summary, "stopped chain summary");
      expect(f.chains.admit({ kind: "run", argv: summary.steps[0]?.argv ?? [] }).kind).toBe("card");
      await stoppedRecord.promise;
      expect(await readChainRecord(f.outputDir, summary.id)).toMatchObject({
        state: "stopped",
        stopReason: "the chat closed",
      });
      await expect(activate(f)).rejects.toMatchObject({ code: "CHAT_CHAIN_CLOSED" });
      expect(f.approve).toHaveBeenCalledTimes(1);
      expect(f.choice).toHaveBeenCalledTimes(owned ? 1 : 0);
    } finally {
      releaseWrite.resolve();
      closeDecision.resolve("stay");
      await closing;
    }
  });
  test("AC-13 returns a fresh controller", () => {
    const f = compose();
    assertDefined(f.chains, "chains controller");
    expect(f.chains.active()).toBeUndefined();
    expect(f.chains.summary()).toBeNull();
  });
  test("AC-14 exposes all chain tools", async () => {
    const f = compose();
    expect((await f.provider.tools(f.repoRoot)).map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
      "chain",
      "chain_check",
      "chain_stop",
    ]);
  });
  test("AC-15 stops before an empty close without asking", async () => {
    const f = compose();
    await activate(f);
    const owned = spyOn(f.jobs, "owned").mockReturnValue([]);
    expect(await f.confirmClose()).toBe(true);
    expect(owned).toHaveBeenCalledTimes(1);
    expect(f.chains.summary()?.stopReason).toBe("the chat closed");
    expect(f.choice).not.toHaveBeenCalled();
    expect(f.chains.active()).toBeUndefined();
    expect(f.approve).not.toHaveBeenCalled();
  });
  test.each(["leave", "stay"])("close choice %s retains the job and only leave stops chains", async (choice) => {
    const f = compose();
    await activate(f);
    const job = {
      schemaVersion: 1 as const,
      id: "run-12345678",
      kind: "run" as const,
      target: "f1",
      cwd: f.repoRoot,
      pid: 42,
      state: "running" as const,
      sessionId: "chat-chain",
      argv: [],
      approvedAt: now().toISOString(),
      startedAt: now().toISOString(),
      logPath: join(f.repoRoot, "job.log"),
    };
    spyOn(f.jobs, "owned").mockReturnValue([job]);
    const cancel = spyOn(f.jobs, "cancel");
    f.choice.mockImplementation(async () => {
      expect(f.chains.active()).toBeDefined();
      return choice;
    });
    expect(await f.confirmClose()).toBe(choice === "leave");
    expect(f.choice).toHaveBeenCalledTimes(1);
    expect(Boolean(f.chains.active())).toBe(choice === "stay");
    if (choice === "leave") expect(f.chains.summary()?.stopReason).toBe("the chat closed");
    expect(cancel).not.toHaveBeenCalled();
    expect(job.state).toBe("running");
  });
});

async function parentHost() {
  const f = fixture();
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: "chat-chain",
    cwd: f.repoRoot,
    mode: "full",
    model: "test",
    bashApproval: "gated",
    title: null,
    createdAt: now().toISOString(),
    updatedAt: null,
  };
  const session: AgentSession = {
    id: meta.sessionId,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close: async () => {},
  };
  let generation = 0;
  const open = mock(async (request: OpenChatSessionRequest) => {
    const sessionId = request.resumeId ?? (generation++ === 0 ? meta.sessionId : `chat-new-${generation}`);
    return { session: { ...session, id: sessionId }, meta: { ...meta, sessionId }, release: async () => {} };
  });
  const resources: ChatResources = {
    catalog: buildResourceCatalog([]),
    toolProviders: [],
    pluginHandlers: [],
    naxPlugins: [],
    teardown: async () => {},
  };
  const host = createChatHost({
    ...f,
    cwd: f.repoRoot,
    chain: null,
    resources,
    storage: createChatStorage({ pid: process.pid, now, logger: f.logger }),
    open,
  });
  hosts.push(host);
  await host.start({ mode: "full", model: "test" });
  const provider = open.mock.calls[0]?.[0].toolProviders?.find((p) => p.id === "nax-jobs");
  assertDefined(provider, "parent jobs provider");
  return { ...f, host, tools: await provider.tools(f.repoRoot) };
}
function context(f: Awaited<ReturnType<typeof parentHost>>) {
  return { root: f.repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };
}
async function approveChain(f: Awaited<ReturnType<typeof parentHost>>) {
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
  const tool = f.tools.find((t) => t.localName === "chain");
  assertDefined(tool, "chain tool");
  const pending = tool.run({ steps: [{ kind: "run", input: { feature: "f1" } }] }, context(f));
  await waitForCondition(() => f.host.asks.pending().length === 1);
  const card = f.host.asks.pending()[0];
  assertDefined(card, "chain approval");
  f.host.asks.resolve(card.requestId, "allow_once");
  expect((await pending).isError).not.toBe(true);
}
async function chainSummary(f: Awaited<ReturnType<typeof parentHost>>) {
  const list = f.tools.find((t) => t.localName === "list");
  assertDefined(list, "list tool");
  return JSON.parse(String((await list.run({}, context(f))).content)).chain;
}
describe("createChatHost chain composition", () => {
  test("unconditional close revokes an auto launch paused at its final lock check", async () => {
    const f = await parentHost();
    await approveChain(f);
    await Bun.write(join(featureDir(f.repoRoot, "f1"), "prd.json"), JSON.stringify({ userStories: [] }));
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<number | null>();
    let checks = 0;
    _jobsLaunchDeps.lockHolder = async () => {
      if (++checks === 2) {
        locked.resolve();
        return release.promise;
      }
      return null;
    };
    const spawn = mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} }));
    _jobRunnerDeps.spawn = spawn;
    const run = f.tools.find((t) => t.localName === "run");
    assertDefined(run, "run tool");
    const pending = run.run({ feature: "f1" }, context(f));
    try {
      await locked.promise;
      const closing = f.host.close();
      release.resolve(null);
      const result = await pending;
      await closing;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("stopped before step 1 started; nothing started");
      expect(spawn).not.toHaveBeenCalled();
      expect(await chainSummary(f)).toMatchObject({ state: "stopped", stopReason: "the chat closed" });
    } finally {
      release.resolve(null);
    }
  });
  test("clear then resume cannot revive authorization without a fresh card", async () => {
    const f = await parentHost();
    await approveChain(f);
    const original = f.host.current().sessionId;
    await f.host.clear();
    expect(f.host.current().sessionId).not.toBe(original);
    // No chain observation in the intervening session.
    await f.host.resume({ id: original });
    expect(f.host.current().sessionId).toBe(original);
    expect(await chainSummary(f)).toMatchObject({ state: "stopped", stopReason: "chat session changed" });
    expect(await chainSummary(f)).not.toHaveProperty("next");
  });
  test("AC-17 registers chain tools on the session open request", async () => {
    const f = await parentHost();
    expect(f.tools.map((t) => t.localName)).toEqual([
      "plan",
      "run",
      "bot_review",
      "bot_fix",
      "list",
      "cancel",
      "chain",
      "chain_check",
      "chain_stop",
    ]);
  });
  test("AC-18 full mode keeps the chain card pending until explicitly resolved", async () => {
    const f = await parentHost();
    _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
    const tool = f.tools.find((t) => t.localName === "chain");
    assertDefined(tool, "chain tool");
    const pending = tool.run(
      { steps: [{ kind: "run", input: { feature: "f1" } }] },
      { root: f.repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 },
    );
    await waitForCondition(() => f.host.asks.pending().length === 1);
    const card = f.host.asks.pending()[0];
    assertDefined(card, "chain approval");
    expect(card).toMatchObject({ type: "approval_requested", tool: "nax-jobs__chain" });
    expect(f.host.asks.pending()).toHaveLength(1);
    f.host.asks.resolve(card.requestId, "allow_once");
    expect((await pending).isError).not.toBe(true);
    expect(f.host.asks.pending()).toEqual([]);
    const list = f.tools.find((t) => t.localName === "list");
    assertDefined(list, "list tool");
    const result = await list.run(
      {},
      { root: f.repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 },
    );
    expect(JSON.parse(String(result.content)).chain.state).toBe("active");
  });
});
