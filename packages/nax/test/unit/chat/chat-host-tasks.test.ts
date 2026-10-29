import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { BackgroundCommandEnd } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  makeAgentResource,
  makeLogger,
  makeNaxConfig,
  makeScriptedSession,
  makeTempDir,
  waitForCondition,
} from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import type { OpenChatSessionRequest } from "@/chat/open-chat-session";
import { buildResourceCatalog } from "@/resources";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
function fixture(resourcesEnabled = true, entry = false, agents = false) {
  const dir = makeTempDir("host-tasks-");
  const now = () => new Date("2026-10-29T00:00:00Z");
  const logger = makeLogger();
  const order: string[] = [];
  const session = makeScriptedSession("tasks", async function* () {});
  session.close = async () => {
    order.push("close");
  };
  const open = mock(async (request: OpenChatSessionRequest) => ({
    session,
    release: async () => {},
    meta: {
      schemaVersion: 1 as const,
      sessionId: request.resumeId ?? "tasks",
      cwd: dir,
      mode: "full" as const,
      model: request.model ?? "test",
      bashApproval: "gated" as const,
      title: null,
      createdAt: now().toISOString(),
      updatedAt: null,
    },
  }));
  const resources: ChatResources = {
    catalog: { ...buildResourceCatalog([]), agents: agents ? [makeAgentResource()] : [] },
    toolProviders: ["first", "second"].map((id) => ({
      id,
      kind: "static" as const,
      stages: ["*"],
      tools: async () => [],
    })),
    pluginHandlers: [],
    naxPlugins: [],
    teardown: async () => {
      order.push("resources");
    },
  };
  const host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    chain: null,
    now,
    logger,
    open,
    storage: createChatStorage({ pid: process.pid, now, logger }),
    ...(resourcesEnabled ? { resources } : {}),
    ...(entry ? { naxEntry: ["bun", "/n.ts"] } : {}),
  });
  disposers.push(async () => {
    await host.close();
    cleanupTempDir(dir);
  });
  return { host, open, order };
}
describe("chat host tasks", () => {
  test.each(["start", "resume", "switch"] as const)("AC-1/2/3 %s passes the host-owned port", async (method) => {
    const f = fixture();
    await f.host.start({ mode: "full", model: "test" });
    if (method === "resume") await f.host.resume({ id: "other" });
    if (method === "switch") await f.host.switchTo({ model: "p/other" });
    assertDefined(f.host.tasks, "host tasks");
    expect(f.open.mock.calls.at(-1)?.[0].backgroundCommands).toBe(f.host.tasks);
  });
  test("AC-4 providers end with jobs, tasks, agents", async () => {
    const f = fixture(true, true, true);
    await f.host.start({ mode: "full", model: "test" });
    expect(f.open.mock.calls[0]?.[0].toolProviders?.map((p) => p.id)).toEqual([
      "first",
      "second",
      "nax-jobs",
      "nax-tasks",
      "nax-agents",
    ]);
  });
  test("AC-5/6 without resources omits tasks and the request port", async () => {
    const f = fixture(false, true);
    await f.host.start({ mode: "full", model: "test" });
    expect(f.host.tasks).toBeUndefined();
    expect(f.open.mock.calls[0]?.[0]).not.toHaveProperty("backgroundCommands");
  });
  test("AC-9 closes the session before stopping tasks, then resources", async () => {
    const f = fixture();
    await f.host.start({ mode: "full", model: "test" });
    assertDefined(f.host.tasks, "host tasks");
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    f.host.tasks.adopt({
      command: "bun dev",
      origin: "agent",
      ended: end.promise,
      stop: () => {
        f.order.push("stop");
        end.resolve({ exitCode: 143, timedOut: false, aborted: true });
      },
    });
    await f.host.close();
    expect(f.order).toEqual(["close", "stop", "resources"]);
  });
  test("session changes preserve running tasks and their completion notice", async () => {
    const f = fixture();
    await f.host.start({ mode: "full", model: "test" });
    const tasks = f.host.tasks;
    assertDefined(tasks, "host tasks");
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    const stop = mock(() => {
      end.resolve({ exitCode: 143, timedOut: false, aborted: true });
    });
    const sink = tasks.adopt({ command: "bun dev", origin: "agent", ended: end.promise, stop });
    await f.host.clear();
    await f.host.resume({ id: "resumed" });
    await f.host.switchTo({ model: "p/other" });
    expect(f.host.tasks).toBe(tasks);
    expect(tasks.get(sink.id)?.state).toBe("running");
    expect(stop).not.toHaveBeenCalled();
    expect(f.open.mock.calls.every(([request]) => request.backgroundCommands === tasks)).toBe(true);
    end.resolve({ exitCode: 0, timedOut: false, aborted: false });
    await waitForCondition(() => tasks.peekNotice() !== undefined);
    expect(tasks.peekNotice()).toContain(sink.id);
  });
  test("AC-20 resources precede tasks without a nax entry", async () => {
    const f = fixture();
    await f.host.start({ mode: "full", model: "test" });
    expect(f.open.mock.calls[0]?.[0].toolProviders?.map((p) => p.id)).toEqual(["first", "second", "nax-tasks"]);
  });
});
