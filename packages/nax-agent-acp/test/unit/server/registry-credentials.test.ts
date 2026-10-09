import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { authRequired } from "#src/server/errors";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { fakeAgentSession } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "full",
  bashApproval: "escalate",
  tiers: [
    { tier: "fast", model: "openai/gpt-x" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5" },
  ],
  catalogOverrides: [],
};

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-credentials-");
});
afterEach(() => cleanupTempDir(dir));

/** `refused`: providers whose models the check refuses. */
function setup(refused: readonly string[]) {
  const opened: OpenSessionRequest[] = [];
  const closed: string[] = [];
  const checked: string[] = [];
  const port = fakePort();
  const { logger } = recordingLogger();
  const registry = createSessionRegistry({
    options: OPTIONS,
    openSession: async (request) => {
      opened.push(request);
      const fake = fakeAgentSession(request.sessionId, []);
      return {
        session: { ...fake.session, close: async () => void closed.push(request.model) },
        doc: null,
      };
    },
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts: createMemoryTranscriptStore(),
    newId: () => "s1",
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
    ensureCredentials: async (model) => {
      checked.push(model);
      const provider = model.slice(0, model.indexOf("/"));
      if (refused.includes(provider)) throw authRequired(`no credentials for provider "${provider}"`, { provider });
    },
  });
  return { registry, opened, closed, checked, input: { cwd: "/w", mcpServers: [], port: () => port.port } };
}

const codeOf = (e: unknown): number => (e instanceof RequestError ? e.code : 0);

describe("credential check (M-30)", () => {
  test("session/new is refused before the lock and before any open", async () => {
    const s = setup(["anthropic"]);
    expect(codeOf(await s.registry.create(s.input).catch((e: unknown) => e))).toBe(-32000);
    expect(s.opened).toEqual([]);
    expect(await readFile(join(dir, "s1.lock"), "utf8").catch(() => "none")).toBe("none");
  });

  test("a successful open does create the lock", async () => {
    const s = setup([]);
    await s.registry.create(s.input);
    expect(
      await readFile(join(dir, "s1.lock"), "utf8")
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  test("a model switch to a refused provider leaves the live session open and unchanged (final review I6)", async () => {
    const s = setup(["openai"]);
    await s.registry.create(s.input);
    const error = await s.registry.setConfigOption("s1", "model", "openai/gpt-x").catch((e: unknown) => e);
    expect(codeOf(error)).toBe(-32000);
    expect(s.closed).toEqual([]);
    expect(s.opened).toHaveLength(1);
    expect(s.checked).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-x"]);
  });

  test("a mode change does not re-check an unchanged model", async () => {
    const s = setup([]);
    await s.registry.create(s.input);
    await s.registry.setMode("s1", "read");
    expect(s.checked).toEqual(["anthropic/claude-sonnet-5-5"]);
  });
});
