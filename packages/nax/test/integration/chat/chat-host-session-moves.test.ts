import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { type AgentSession, createSessionStorage, LIST_PAGE_SIZE, type SessionStorage } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { type ChatResources, createChatHost } from "@/chat";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { buildResourceCatalog } from "@/resources";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const MODEL = "anthropic/test";
const MINUTE_MS = 60_000;
const PAGED_SESSIONS = LIST_PAGE_SIZE + 10;

let dir: string;
let storage: SessionStorage;
let hosts: ReturnType<typeof createChatHost>[];

beforeEach(() => {
  dir = makeTempDir("chat-host-moves-");
  hosts = [];
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
    isAlive: () => true,
  });
});
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  cleanupTempDir(dir);
});

/** Newest-first: index 0 is the newest session. The zz prefix keeps ids ordered the way the store sorts them. */
function storedId(index: number): string {
  return `zz${String(index).padStart(3, "0")}-session`;
}

async function storedSessions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const updatedAt = new Date(NOW.getTime() - index * MINUTE_MS).toISOString();
    await storage.writeMeta({
      schemaVersion: 1,
      sessionId: storedId(index),
      cwd: dir,
      mode: "ask",
      model: MODEL,
      bashApproval: "gated",
      title: `title ${index}`,
      createdAt: updatedAt,
      updatedAt,
    });
  }
}

async function liveHold(sessionId: string): Promise<void> {
  await Bun.write(
    join(storage.dir, `${sessionId}.lock`),
    JSON.stringify({ pid: 4242, startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), nonce: "other" }),
  );
}

function fixture() {
  const sessionClose = mock(async () => {});
  const teardown = mock(async () => {});
  const opened: OpenChatSessionRequest[] = [];
  const open = async (request: OpenChatSessionRequest) => {
    opened.push(request);
    const sessionId = request.resumeId ?? "fresh-session";
    const session: AgentSession = {
      id: sessionId,
      backend: { kind: "native", capabilities: {} },
      lastTurn: undefined,
      async *send() {},
      answer: () => "unknown",
      cancel() {},
      close: sessionClose,
    };
    const meta = (await storage.readMeta(sessionId)) ?? {
      schemaVersion: 1 as const,
      sessionId,
      cwd: dir,
      mode: "ask" as const,
      model: MODEL,
      bashApproval: "gated" as const,
      title: null,
      createdAt: NOW.toISOString(),
      updatedAt: null,
    };
    return { session, meta, release: async () => {} };
  };
  const resources: ChatResources = {
    catalog: buildResourceCatalog([]),
    toolProviders: [],
    pluginHandlers: [],
    naxPlugins: [],
    teardown,
  };
  const host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    storage,
    chain: null,
    now: () => NOW,
    logger: makeLogger(),
    open,
    resources,
  });
  hosts.push(host);
  return { host, opened, sessionClose, teardown };
}

describe("chat host session listing and final close", () => {
  test("AC-16 resume({}) skips a live-held first session and resumes the second", async () => {
    await storedSessions(3);
    await liveHold(storedId(0));
    const { host, opened } = fixture();
    await host.resume({});
    expect(opened.map((request) => request.resumeId)).toEqual([storedId(1)]);
    expect(host.current().sessionId).toBe(storedId(1));
  });

  test("AC-17 listSessions returns rows for sessions on both pages of a 60-session store", async () => {
    await storedSessions(PAGED_SESSIONS);
    const { host } = fixture();
    const ids = (await host.listSessions()).map((row) => row.sessionId);
    expect(ids).toHaveLength(PAGED_SESSIONS);
    expect(ids).toContain(storedId(0));
    expect(ids).toContain(storedId(PAGED_SESSIONS - 1));
  });

  test("AC-18 close closes the open session", async () => {
    const { host, sessionClose } = fixture();
    await host.start({ mode: "guarded", model: MODEL });
    await host.close();
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  test("AC-19 close calls the resources teardown once", async () => {
    const { host, teardown } = fixture();
    await host.start({ mode: "guarded", model: MODEL });
    await host.close();
    await host.close();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
