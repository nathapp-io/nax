import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession, SessionMeta } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir, waitForCondition } from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import { createChatAskController } from "@/chat/ask-controller";
import { createHostJobs } from "@/chat/jobs";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { buildResourceCatalog } from "@/resources";

const dirs: string[] = [];
const hosts: ReturnType<typeof createChatHost>[] = [];
const compositions: ReturnType<typeof createHostJobs>[] = [];
const originalGit = _jobsLaunchDeps.git;
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
  _jobsLaunchDeps.git = originalGit;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function fixture() {
  const repoRoot = makeTempDir("host-chain-");
  dirs.push(repoRoot);
  const config = makeNaxConfig({ outputDir: join(repoRoot, "output"), execution: { approvalTimeout: 30_000 } });
  const logger = makeLogger();
  return {
    repoRoot,
    config,
    logger,
    now,
    naxEntry: ["bun", "/n.ts"],
    outputDir: config.outputDir,
    sessionId: () => "chat-chain",
  };
}
function compose() {
  const options = fixture();
  const asks = createChatAskController({ mode: "full", approvalTimeoutMs: 30_000, now, answer: () => {} });
  const approve = spyOn(asks, "requestHostApproval").mockResolvedValue("deny");
  const composed = createHostJobs({ ...options, asks });
  compositions.push(composed);
  return { ...options, ...composed, approve };
}
async function activate(f: ReturnType<typeof compose>) {
  await f.chains.activate({ steps: [{ kind: "run", argv: ["bun", "/n.ts", "run", "f1"], target: "f1" }] });
}

describe("createHostJobs chains", () => {
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
    const owned = spyOn(f.jobs, "owned").mockImplementation(() => {
      expect(f.chains.summary()?.stopReason).toBe("the chat closed");
      return [];
    });
    await f.confirmClose();
    expect(owned).toHaveBeenCalledTimes(1);
    expect(f.chains.active()).toBeUndefined();
    expect(f.approve).not.toHaveBeenCalled();
  });
  test("AC-16 stops before one close approval and keeps a declined job running", async () => {
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
    f.approve.mockImplementation(async () => {
      expect(f.chains.summary()?.stopReason).toBe("the chat closed");
      return "deny";
    });
    await f.confirmClose();
    expect(f.approve).toHaveBeenCalledTimes(1);
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
  const open = mock(async (_request: OpenChatSessionRequest) => ({ session, meta, release: async () => {} }));
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
describe("createChatHost chain composition", () => {
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
    expect(card.tool).toBe("nax-jobs__chain");
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
