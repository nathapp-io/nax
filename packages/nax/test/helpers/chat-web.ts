import { mock } from "bun:test";
import {
  createMemoryTranscriptStore,
  createSessionStorage,
  type SessionBackend,
  type SessionEvent,
  type ToolRunContext,
} from "@nathapp/nax-agent";
import { _webProviderDeps } from "@nathapp/nax-agent/internal";
import { _openChatSessionDeps, type OpenChatSessionRequest, openChatSession } from "@/chat/open-chat-session";
import { _chatWebDeps, type ChatWeb, createChatWeb } from "@/chat/web/wiring";
import { makeScriptedSession, turnEndEvent } from "./chat-subagents";
import { makeLogger } from "./mock-logger";
import { makeNaxConfig } from "./mock-nax-config";
import { cleanupTempDir, makeTempDir } from "./temp";

export const WEB_NOW = new Date("2026-11-01T00:00:00.000Z");
export const WEB_CONTEXT: ToolRunContext = { root: "/repo", resolvedPaths: [], maxBytes: 10000, maxFileBytes: 10000 };

export async function fetchChatPage(web: ChatWeb | undefined) {
  if (!web) throw new Error("missing session web");
  const tool = (await web.provider.tools("/repo")).find((t) => t.localName === "fetch");
  if (!tool) throw new Error("missing web__fetch");
  return tool.run({ url: "https://b.example/doc" }, WEB_CONTEXT);
}

export function makeChatWebHarness() {
  const dir = makeTempDir("chat-web-");
  const logger = makeLogger();
  const storage = createSessionStorage({ dir, pid: process.pid, now: () => WEB_NOW, logger });
  const savedWeb = { ..._chatWebDeps };
  const savedProvider = { ..._webProviderDeps };
  _chatWebDeps.env = () => ({});
  _chatWebDeps.gitRemoteHosts = async () => [];
  _webProviderDeps.fetchWebPage = async () => ({
    url: "https://b.example/doc",
    status: 200,
    contentType: "text/plain",
    text: "page",
    links: [],
    truncated: false,
    unsupported: false,
  });
  let web: ChatWeb | undefined;
  let script: () => AsyncIterable<SessionEvent> = async function* () {
    yield turnEndEvent();
  };
  const session = makeScriptedSession("web-session", () => script());
  const backend: SessionBackend = {
    kind: "native",
    async open() {
      throw new Error("unused backend");
    },
  };
  let id = 0;
  const deps = {
    ..._openChatSessionDeps,
    createChatWeb: mock(async (p: Parameters<typeof createChatWeb>[0]) => {
      const result = await createChatWeb(p);
      web = result.web;
      return result;
    }),
    getLogger: () => logger,
    randomUUID: () => `web-session-${++id}`,
    now: () => WEB_NOW,
    nativeBackend: mock((_options: Parameters<typeof _openChatSessionDeps.nativeBackend>[0]) => backend),
    createAgentSession: mock(async () => session),
    resumeAgentSession: mock(async () => session),
    createFileTranscriptStore: () => createMemoryTranscriptStore(),
    resolveRuleSet: async () => ({ rules: [], repoRulesTotal: 0, repoRulesMatchedPaths: 0, packageRulesCount: 0 }),
  };
  const config = makeNaxConfig({ chat: { web: { enabled: true, search: { backend: "tavily" } } } });
  const handles: Awaited<ReturnType<typeof openChatSession>>[] = [];
  return {
    dir,
    logger,
    storage,
    deps,
    session,
    config,
    handles,
    web: () => web,
    script(next: typeof script) {
      script = next;
    },
    async open(overrides: Partial<OpenChatSessionRequest> = {}) {
      const handle = await openChatSession(
        {
          storage,
          config,
          cwd: dir,
          repoRoot: dir,
          model: "anthropic/test",
          mode: "full",
          loopHandlers: [],
          ...overrides,
        },
        deps,
      );
      handles.push(handle);
      return handle;
    },
    async dispose() {
      for (const handle of handles) await handle.release();
      Object.assign(_chatWebDeps, savedWeb);
      Object.assign(_webProviderDeps, savedProvider);
      cleanupTempDir(dir);
    },
  };
}
