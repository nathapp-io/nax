/** A file-backed registry over fake S3 sessions, for registry tests (extracted from registry.test.ts). */
import { createMemoryTranscriptStore, type TranscriptStore } from "@nathapp/nax-agent";
import type { ConnectSessionMcp } from "#src/server/mcp/connect";
import type { OpenSessionRequest } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createSessionRegistry, type ReloadedOptions } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage, type SessionStorage } from "#src/server/storage";
import { type FakeAgentSession, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { ALL_FEATURES, fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

export const OPTIONS: ServerOptions = {
  configDir: "/cfg",
  sessionsDir: "/unused",
  defaultModel: "anthropic/claude-sonnet-5-5",
  defaultMode: "ask",
  bashApproval: "gated",
  tiers: [
    { tier: "fast", model: "anthropic/claude-haiku-4-5" },
    { tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 },
  ],
  catalogOverrides: [],
  mcpConnectTimeoutSeconds: 30,
};

export const said = (words: string): Script =>
  async function* () {
    yield { type: "text_delta", round: 1, text: words };
    yield turnEnd("completed");
  };

export interface RegistrySetupExtra {
  readonly transcripts?: TranscriptStore;
  readonly isAlive?: (pid: number) => boolean;
  readonly lastTurn?: FakeAgentSession["session"]["lastTurn"];
  readonly connectMcp?: ConnectSessionMcp;
  /** 1-based openSession calls that throw (after being recorded). */
  readonly failOpens?: readonly number[];
  /** Every openSession call waits for this first. */
  readonly openGate?: Promise<void>;
  /**
   * The 1-based openSession call from which `openGate` applies, so a test can
   * create a session and then gate only a switch's open. Unset: every call.
   */
  readonly openGateFrom?: number;
  readonly failWriteMeta?: boolean;
  readonly failUpdates?: boolean;
  /** Scripts for each opened session's turns; default: two short replies. */
  readonly scripts?: readonly Script[];
  /** Re-resolves the options when session/new finds no model (onboarding). */
  readonly reloadOptions?: () => Promise<ReloadedOptions>;
  readonly ensureCredentials?: (model: string) => Promise<void>;
}

export function setupRegistry(dir: string, options: ServerOptions = OPTIONS, extra: RegistrySetupExtra = {}) {
  const opened: OpenSessionRequest[] = [];
  const fakes: FakeAgentSession[] = [];
  const transcripts = extra.transcripts ?? createMemoryTranscriptStore();
  const port = fakePort({ features: ALL_FEATURES, ...(extra.failUpdates === true ? { failUpdates: true } : {}) });
  const { logger, lines } = recordingLogger();
  let next = 0;
  let releaseCalls = 0;
  const base = createSessionStorage({
    dir,
    pid: 1000,
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    logger,
    isAlive: extra.isAlive ?? (() => false),
  });
  const storage: SessionStorage = {
    ...base,
    ...(extra.failWriteMeta === true
      ? {
          writeMeta: async () => {
            throw new Error("disk full");
          },
        }
      : {}),
    // Counted here, not at the storage: every lock-release invocation after the
    // switch settled is a second cleanup owner.
    acquireLock: async (sessionId) => {
      const release = await base.acquireLock(sessionId);
      return async () => {
        releaseCalls += 1;
        await release();
      };
    },
  };
  const registry = createSessionRegistry({
    options,
    openSession: async (request) => {
      opened.push(request);
      // Unset openGateFrom means every call, so existing tests keep their behaviour.
      if (extra.openGate !== undefined && opened.length >= (extra.openGateFrom ?? 1)) await extra.openGate;
      if (extra.failOpens?.includes(opened.length) === true) throw new Error(`open ${opened.length} failed`);
      const fake = fakeAgentSession(request.sessionId, extra.scripts ?? [said("hi"), said("again")], {
        ...(extra.lastTurn !== undefined ? { lastTurn: extra.lastTurn } : {}),
      });
      fakes.push(fake);
      return { session: fake.session, doc: await transcripts.load(request.sessionId) };
    },
    storage,
    transcripts,
    newId: () => {
      next += 1;
      return `id-${next}`;
    },
    now: () => new Date("2026-10-09T01:00:00.000Z"),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
    ...(extra.connectMcp !== undefined ? { connectMcp: extra.connectMcp } : {}),
    ...(extra.reloadOptions !== undefined ? { reloadOptions: extra.reloadOptions } : {}),
    ...(extra.ensureCredentials !== undefined ? { ensureCredentials: extra.ensureCredentials } : {}),
  });
  const input = (cwd = "/w", mcpServers: readonly unknown[] = []) => ({ cwd, mcpServers, port: () => port.port });
  return {
    registry,
    input,
    port,
    lines,
    storage,
    transcripts,
    opened,
    fakes,
    dir,
    /** Every lock-release invocation `acquireLock` handed out, counted at call time. */
    releases: () => releaseCalls,
  };
}
