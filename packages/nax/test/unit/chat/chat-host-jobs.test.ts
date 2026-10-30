import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession, SessionMeta, ToolProvider } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  makeAgentResource,
  makeLogger,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
  waitForCondition,
} from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import { _jobRunnerDeps } from "@/chat/jobs/job-runner";
import { writeJobRecord } from "@/chat/jobs/job-store";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { featureDir, getProjectKey } from "@/config";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { buildResourceCatalog } from "@/resources";
import { projectOutputDir } from "@/runtime";

const originalRunner = { ..._jobRunnerDeps };
const originalLaunch = { ..._jobsLaunchDeps };
const hosts: ReturnType<typeof createChatHost>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.asks.reset();
    await host.close();
  }
  Object.assign(_jobRunnerDeps, originalRunner);
  Object.assign(_jobsLaunchDeps, originalLaunch);
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function fixture(entry = true, agents = true, resourcesEnabled = true) {
  const repoRoot = makeTempDir("host-jobs-");
  dirs.push(repoRoot);
  const now = () => new Date("2026-10-27T10:00:00Z");
  const config = makeNaxConfig({ outputDir: join(repoRoot, "output"), execution: { approvalTimeout: 30_000 } });
  const logger = makeLogger();
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: "chat-jobs",
    cwd: repoRoot,
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
  const open = mock(async (request: OpenChatSessionRequest) => ({
    session,
    meta: { ...meta, mode: request.mode === "guarded" ? ("ask" as const) : ("full" as const) },
    release: async () => {},
  }));
  const catalog = { ...buildResourceCatalog([]), agents: agents ? [makeAgentResource({ name: "reviewer" })] : [] };
  const resources: ChatResources = {
    catalog,
    toolProviders: [{ id: "fixture", kind: "static" as const, stages: ["*"], tools: async () => [] }],
    pluginHandlers: [{ plugin: "kit", event: "before_turn" as const, handler: async () => {} }],
    naxPlugins: [],
    teardown: async () => {},
  };
  _jobRunnerDeps.spawn = mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} }));
  _jobRunnerDeps.isProcessAlive = () => false;
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
  const host = createChatHost({
    config,
    repoRoot,
    cwd: repoRoot,
    now,
    logger,
    chain: null,
    storage: createChatStorage({ pid: process.pid, now, logger }),
    open,
    ...(resourcesEnabled ? { resources } : {}),
    ...(entry ? { naxEntry: ["bun", "/n.ts"] } : {}),
  });
  hosts.push(host);
  const outputDir = projectOutputDir(getProjectKey(config, repoRoot), config.outputDir);
  const start = (mode: "full" | "guarded" = "full") => host.start({ mode, model: "test" });
  const runTool = async () => {
    const provider = open.mock.calls[0]?.[0].toolProviders?.find((p) => p.id === "nax-jobs");
    assertDefined(provider, "provider");
    return jobsTool(provider, repoRoot);
  };
  const jobs = () => {
    const value = host.jobs;
    assertDefined(value, "host jobs runner");
    return value;
  };
  const owned = () =>
    jobs().start({
      kind: "run",
      target: "f1",
      argv: ["bun", "/n.ts"],
      sessionId: meta.sessionId,
      approvedAt: now().toISOString(),
    });
  return { host, open, repoRoot, outputDir, start, jobs, owned, resources, logger, now, runTool };
}

const toolContext = (root: string) => ({ root, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
async function jobsTool(provider: ToolProvider, root: string) {
  const tools = await provider.tools(root);
  return (name: string) => {
    const tool = tools.find((t) => t.localName === name);
    assertDefined(tool, `${name} tool`);
    return (input: Record<string, unknown>) => tool.run(input, toolContext(root));
  };
}
async function writePendingPrd(repoRoot: string) {
  await Bun.write(
    join(featureDir(repoRoot, "f1"), "prd.json"),
    JSON.stringify(makePRD({ userStories: [makeStory({ status: "pending", passes: false })] })),
  );
}

function closeCard(host: ReturnType<typeof createChatHost>) {
  const card = host.asks.pending()[0];
  assertDefined(card, "close approval");
  expect(card).toMatchObject({ tool: "nax-close" });
  return card;
}

describe("createChatHost jobs", () => {
  test("AC-1/4/5/23 composes ordered provider instructions and a frozen last guard", async () => {
    const f = fixture();
    await f.start();
    expect(f.host.runAsks).toBeDefined();
    const request = f.open.mock.calls[0]?.[0];
    assertDefined(request, "open request");
    expect(request.toolProviders?.slice(-3).map((p) => p.id)).toEqual(["nax-jobs", "nax-tasks", "nax-agents"]);
    expect(Object.isFrozen(request.loopHandlers)).toBe(true);
    expect(request.loopHandlers.at(-1)).toMatchObject({ plugin: "nax-jobs", event: "before_tool" });
    const provider = request.toolProviders?.find((p) => p.id === "nax-jobs");
    assertDefined(provider, "jobs provider");
    expect(await provider.instructions?.(f.repoRoot)).toContain("nax-jobs__run");
  });
  test("resources-only host has confirmation and preserves provider/handler ordering", async () => {
    const f = fixture(false, false);
    await f.start();
    const request = f.open.mock.calls[0]?.[0];
    assertDefined(request, "open request");
    expect(request.toolProviders?.slice(0, -1)).toEqual([...f.resources.toolProviders]);
    expect(request.toolProviders?.at(-1)?.id).toBe("nax-tasks");
    expect(request.toolProviders?.map((p) => p.id)).not.toContain("nax-jobs");
    expect(f.host.jobs).toBeUndefined();
    expect(f.host.confirmBeforeClose).toBeDefined();
    expect(Object.isFrozen(request.loopHandlers)).toBe(true);
    expect(request.loopHandlers[0]).toBe(f.resources.pluginHandlers[0]);
    expect(request.loopHandlers.slice(1).map((h) => [h.plugin, h.event])).toEqual(
      createRuleDeliveryHandlers({ repoRoot: f.repoRoot, overrideMode: "merge" }).map((h) => [h.plugin, h.event]),
    );
  });
  test("without resources an entry alone registers no jobs", async () => {
    const f = fixture(true, false, false);
    await f.start();
    expect(f.host.jobs).toBeUndefined();
    expect(f.host.confirmBeforeClose).toBeUndefined();
    expect(f.open.mock.calls[0]?.[0].toolProviders).toBeUndefined();
  });
  test("AC-6 actual last guard blocks writes while an owned run is running", async () => {
    const f = fixture();
    await f.start();
    await f.owned();
    const guard = f.open.mock.calls[0]?.[0].loopHandlers.at(-1);
    assertDefined(guard, "guard");
    expect(
      await guard.handler({ call: { id: "w1", name: "Write", input: {} }, tools: [] }, { sessionName: "chat" }),
    ).toMatchObject({ kind: "block" });
  });
  test.each(["start", "resume"] as const)("AC-7/8 %s finalizes a dead running record after open", async (method) => {
    const f = fixture();
    await writeJobRecord(f.outputDir, {
      schemaVersion: 1,
      id: "bot_review-12345678",
      kind: "bot_review",
      target: "1",
      cwd: f.repoRoot,
      pid: 4242,
      state: "running",
      sessionId: "old",
      argv: [],
      approvedAt: f.now().toISOString(),
      startedAt: f.now().toISOString(),
      logPath: join(f.outputDir, "job.log"),
    });
    if (method === "start") await f.start();
    else await f.host.resume({ id: "chat-jobs" });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.jobs().list()).toHaveLength(1);
    expect(f.jobs().list()[0]?.state).not.toBe("running");
  });
  test("AC-7/8 full mode launch spawns the job without a pending card", async () => {
    const f = fixture();
    await f.start("full");
    await writePendingPrd(f.repoRoot);
    const tool = await f.runTool();
    const result = await tool("run")({ feature: "f1" });
    expect(result.isError).not.toBe(true);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
    expect(f.host.asks.pending()).toEqual([]);
  });
  test("AC-11/12 full mode cancel sends the cancel without a pending card", async () => {
    const f = fixture();
    await f.start("full");
    _jobRunnerDeps.kill = mock(() => true);
    const job = await f.owned();
    const tool = await f.runTool();
    const result = await tool("cancel")({ job: job.id });
    expect(result.isError).not.toBe(true);
    expect(f.jobs().get(job.id)?.cancelRequested).toBe(true);
    expect(f.host.asks.pending()).toEqual([]);
  });
  test("AC-13/14 guarded mode launch waits on a real expiring host card and deny declines", async () => {
    const f = fixture();
    await f.start("guarded");
    await writePendingPrd(f.repoRoot);
    const tool = await f.runTool();
    const pending = tool("run")({ feature: "f1" });
    await waitForCondition(() => f.host.asks.pending().length === 1);
    expect(f.host.asks.pending()).toHaveLength(1);
    const card = f.host.asks.pending()[0];
    assertDefined(card, "launch card");
    expect(card).toMatchObject({ tool: "nax-jobs__run", expiresAt: "2026-10-27T10:00:30.000Z" });
    f.host.asks.resolve(card.requestId, "deny");
    expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining("declined") });
    expect(_jobRunnerDeps.spawn).not.toHaveBeenCalled();
  });
  test("AC-15 switching a guarded host to full stops the next launch asking", async () => {
    const f = fixture();
    await f.start("guarded");
    await writePendingPrd(f.repoRoot);
    await f.host.switchTo({ mode: "full" });
    expect(f.host.current().mode).toBe("full");
    // The provider registered on the first open reads the host's live mode.
    const tool = await f.runTool();
    const result = await tool("run")({ feature: "f1" });
    expect(result.isError).not.toBe(true);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
    expect(f.host.asks.pending()).toEqual([]);
  });
  test("AC-12 empty close confirmation does not ask", async () => {
    const f = fixture();
    await f.start();
    assertDefined(f.host.confirmBeforeClose, "confirmClose");
    await f.host.confirmBeforeClose();
    expect(f.host.asks.pending()).toEqual([]);
  });
  test.each(["stop", "leave"] as const)("AC-13/14/16 close confirmation %s", async (choice) => {
    const f = fixture();
    await f.start();
    const job = await f.owned();
    const cancel = spyOn(f.jobs(), "cancel").mockResolvedValue(job);
    assertDefined(f.host.confirmBeforeClose, "confirmClose");
    const pending = f.host.confirmBeforeClose();
    const card = closeCard(f.host);
    expect(card).toMatchObject({
      summary: `1 nax job(s) and 0 background command(s) still running: ${job.id}`,
    });
    f.host.asks.resolveChoice(card.requestId, choice);
    await pending;
    if (choice === "stop") expect(cancel).toHaveBeenCalledWith(job.id);
    else expect(cancel).not.toHaveBeenCalled();
  });
  test("AC-15 cancellation failure logs warn and still cancels the second owned job", async () => {
    const f = fixture();
    await f.start();
    await f.owned();
    const job = await f.owned();
    const ids = f
      .jobs()
      .owned()
      .map((j) => j.id);
    const cancel = spyOn(f.jobs(), "cancel").mockRejectedValueOnce(new Error("cancel failed")).mockResolvedValue(job);
    const warn = spyOn(f.logger, "warn");
    assertDefined(f.host.confirmBeforeClose, "confirmClose");
    const pending = f.host.confirmBeforeClose();
    f.host.asks.resolveChoice(closeCard(f.host).requestId, "stop");
    await pending;
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  test("AC-17/18 close disposes without cancelling running jobs", async () => {
    const f = fixture();
    await f.start();
    await f.owned();
    const cancel = spyOn(f.jobs(), "cancel");
    const dispose = spyOn(f.jobs(), "dispose");
    await f.host.close();
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.jobs().owned()).toHaveLength(1);
  });
});
