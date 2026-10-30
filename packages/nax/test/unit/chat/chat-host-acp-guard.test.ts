/**
 * US-010 AC-17..AC-20: the host passes the ACP write guard to its ask controller,
 * driven through host.send with a session that emits an answerable approval.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession, SessionEvent, SessionMeta } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import { _jobRunnerDeps } from "@/chat/jobs/job-runner";
import { _jobsLaunchDeps } from "@/chat/jobs/jobs-launch";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { buildResourceCatalog } from "@/resources";

const originalRunner = { ..._jobRunnerDeps };
const originalLaunch = { ..._jobsLaunchDeps };
const NOW = new Date("2026-10-27T10:00:00Z");
const NATIVE = "openai/gpt-6";
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

function approvalEvent(tool: string): SessionEvent {
  return {
    type: "approval_requested",
    sessionId: "chat-guard",
    turnId: "t1",
    at: NOW.toISOString(),
    metadata: {},
    requestId: "r1",
    tool,
    summary: "edit a file",
    reason: "Approval required",
    expiresAt: "2026-10-27T11:00:00Z",
  };
}

function fixture(model: string) {
  const repoRoot = makeTempDir("host-acp-guard-");
  dirs.push(repoRoot);
  const config = makeNaxConfig({ outputDir: join(repoRoot, "output"), execution: { approvalTimeout: 30_000 } });
  const logger = makeLogger();
  const answer = mock((_id: string, _reply: unknown) => "accepted" as const);
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: "chat-guard",
    cwd: repoRoot,
    mode: "ask",
    model,
    bashApproval: "gated",
    title: null,
    createdAt: NOW.toISOString(),
    updatedAt: null,
  };
  const session: AgentSession = {
    id: meta.sessionId,
    backend: { kind: "acp", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      yield approvalEvent("edit");
      yield {
        type: "turn_end",
        sessionId: meta.sessionId,
        turnId: "t1",
        at: NOW.toISOString(),
        metadata: {},
        status: "completed",
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
      };
    },
    answer,
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
  _jobRunnerDeps.spawn = mock(() => ({ pid: 4242, exited: new Promise<number>(() => {}), unref() {} }));
  _jobRunnerDeps.isProcessAlive = () => false;
  _jobsLaunchDeps.git = async () => ({ exitCode: 0, stdout: "feat/f1\n", stderr: "" });
  const host = createChatHost({
    config,
    repoRoot,
    cwd: repoRoot,
    now: () => NOW,
    logger,
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => NOW, logger }),
    open,
    resources,
    naxEntry: ["bun", "/n.ts"],
  });
  hosts.push(host);
  const startJob = async () => {
    assertDefined(host.jobs, "host jobs runner");
    await host.jobs.start({
      kind: "run",
      target: "f1",
      argv: ["bun", "/n.ts"],
      sessionId: meta.sessionId,
      approvedAt: NOW.toISOString(),
    });
  };
  const send = async () => {
    await host.start({ mode: "guarded", model });
    return host;
  };
  return { host, answer, startJob, send };
}

describe("chat host ACP write guard", () => {
  test("AC-17 an ACP edit approval under a running run job is answered deny during send", async () => {
    const f = fixture("acp:codex");
    await f.send();
    await f.startJob();
    await f.host.send("edit it", () => {});
    expect(f.answer.mock.calls).toEqual([["r1", { decision: "deny" }]]);
    expect(f.host.asks.pending()).toEqual([]);
  });

  test("AC-18 the same approval on a native model becomes pending in guarded mode", async () => {
    const f = fixture(NATIVE);
    await f.send();
    await f.startJob();
    await f.host.send("edit it", () => {});
    expect(f.host.asks.pending().map((ask) => ask.requestId)).toEqual(["r1"]);
  });

  test("AC-19 the same approval on a native model is not answered", async () => {
    const f = fixture(NATIVE);
    await f.send();
    await f.startJob();
    await f.host.send("edit it", () => {});
    expect(f.answer).not.toHaveBeenCalled();
  });

  test("AC-20 an ACP approval with no running job becomes pending in guarded mode", async () => {
    const f = fixture("acp:codex");
    await f.send();
    await f.host.send("edit it", () => {});
    expect(f.host.asks.pending().map((ask) => ask.requestId)).toEqual(["r1"]);
    expect(f.answer).not.toHaveBeenCalled();
  });
});
