import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, SHUTTING_DOWN } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage, type SessionStorage } from "#src/server/storage";
import { fakeAgentSession } from "#test/helpers/fake-agent-session";
import { ALL_FEATURES, fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "full",
  bashApproval: "escalate",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5" },
  ],
  catalogOverrides: [],
  mcpConnectTimeoutSeconds: 30,
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-switch-");
});
afterEach(() => cleanupTempDir(dir));

function setup(
  open?: (request: OpenSessionRequest) => Promise<AgentSession>,
  features = ALL_FEATURES,
  storageOverride?: SessionStorage,
) {
  const opened: OpenSessionRequest[] = [];
  const port = fakePort({ features });
  const { logger, lines } = recordingLogger();
  const storage = storageOverride ?? createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger });
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => {
      opened.push(request);
      const session = open !== undefined ? await open(request) : fakeAgentSession(request.sessionId, []).session;
      return { session, doc: null };
    },
    storage,
    transcripts: createMemoryTranscriptStore(),
    newId: () => "s1",
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return { registry, port, opened, lines, storage, input: { cwd: "/w", mcpServers: [], port: () => port.port } };
}

const metaOf = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.session.json`), "utf8"));

describe("set_mode (spec §3.3, §5.3)", () => {
  test("reopens with the new mode, writes metadata, sends current_mode_update", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setMode("s1", "read");
    expect(s.opened.at(-1)).toMatchObject({ profile: "read" });
    expect((await metaOf("s1")).mode).toBe("read");
    expect(s.port.updates).toContainEqual({ sessionUpdate: "current_mode_update", currentModeId: "read" });
  });

  test("switching to ask coerces bash approval to gated and reports it (M-23)", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setMode("s1", "ask");
    expect(s.opened.at(-1)).toMatchObject({ profile: "ask", bashApproval: "gated" });
    expect(s.port.updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(true);
  });

  test("a failed reopen keeps the old settings and metadata and returns the error", async () => {
    let calls = 0;
    const s = setup(async (request) => {
      calls += 1;
      if (calls === 2) throw new Error("sandbox unavailable");
      return fakeAgentSession(request.sessionId, []).session;
    });
    await s.registry.create(s.input);
    await expect(s.registry.setMode("s1", "read")).rejects.toThrow("sandbox unavailable");
    expect((await metaOf("s1")).mode).toBe("full");
    expect(s.opened.at(-1)).toMatchObject({ profile: "full" });
  });

  test("an unknown session is resource_not_found; an unknown mode is invalid_params", async () => {
    const s = setup();
    expect(
      await s.registry.setMode("nope", "read").catch((e: unknown) => (e instanceof RequestError ? e.code : 0)),
    ).toBe(-32002);
    await s.registry.create(s.input);
    expect(await s.registry.setMode("s1", "yolo").catch((e: unknown) => (e instanceof RequestError ? e.code : 0))).toBe(
      -32602,
    );
  });
});

describe("set_config_option", () => {
  test("a model change reopens with the new model and returns the options", async () => {
    const s = setup();
    await s.registry.create(s.input);
    const options = await s.registry.setConfigOption("s1", "model", "anthropic/claude-haiku-4-5");
    expect(s.opened.at(-1)).toMatchObject({ model: "anthropic/claude-haiku-4-5" });
    expect(options[0]).toMatchObject({ currentValue: "anthropic/claude-haiku-4-5" });
    expect((await metaOf("s1")).model).toBe("anthropic/claude-haiku-4-5");
  });

  test("a config change always sends config_option_update (M-25)", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setConfigOption("s1", "bashApproval", "gated");
    expect(s.port.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "config_option_update" }));
  });

  test("an unchanged value does not reopen", async () => {
    const s = setup();
    await s.registry.create(s.input);
    await s.registry.setConfigOption("s1", "bashApproval", "escalate");
    expect(s.opened).toHaveLength(1);
  });
});

describe("closeAll (spec §5.5)", () => {
  test("releases every lock within the cap even when a close hangs, then refuses new opens (M-26)", async () => {
    const hung = fakeAgentSession("s1", [], { closeHangs: true });
    const s = setup(async () => hung.session);
    await s.registry.create(s.input);
    await s.registry.closeAll();
    await (await s.storage.acquireLock("s1"))();
    expect(s.lines.some((l) => l.level === "warn" && l.message.includes("did not close"))).toBe(true);
    const refused = await s.registry.create(s.input).catch((e: unknown) => e);
    expect(refused instanceof RequestError ? refused.message : "").toContain(SHUTTING_DOWN);
  });

  test("an open in flight when shutdown starts is closed and refused, its lock released (M-26)", async () => {
    let releaseOpen: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const late = fakeAgentSession("s1", []);
    const s = setup(async () => {
      await gate;
      return late.session;
    });
    const pending = s.registry.create(s.input).catch((e: unknown) => e);
    await waitForCondition(() => s.opened.length > 0);
    await s.registry.closeAll();
    releaseOpen();
    const refused = await pending;
    expect(refused instanceof RequestError ? refused.message : "").toContain(SHUTTING_DOWN);
    expect(late.closed()).toBe(true);
    await (await s.storage.acquireLock("s1"))();
  });

  test("a create whose metadata write is in flight when shutdown starts leaves no metadata and is refused (M-26)", async () => {
    const real = createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger: recordingLogger().logger });
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markStarted: () => void = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gated: SessionStorage = {
      ...real,
      async writeMeta(meta) {
        markStarted();
        await writeGate;
        await real.writeMeta(meta);
      },
    };
    const s = setup(undefined, ALL_FEATURES, gated);
    const pending = s.registry.create(s.input).catch((e: unknown) => e);
    await writeStarted;
    await s.registry.closeAll();
    releaseWrite();
    const refused = await pending;
    expect(refused instanceof RequestError ? refused.message : "").toContain(SHUTTING_DOWN);
    expect(await real.hasMeta("s1")).toBe(false);
    await (await real.acquireLock("s1"))();
  });
});
