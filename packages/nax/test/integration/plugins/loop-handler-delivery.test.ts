/**
 * US-004 — a plugin's loop handler, loaded from a project's `.nax/plugins/` and
 * handed to the session manager, reaches the native loop's first model request.
 *
 * This is the delivery end to end, with nothing stubbed along the chain except
 * the model itself: the plugin file really is imported from disk by
 * `loadPlugins`, its `before_turn` handler really is staged by the registry,
 * `configureLoopHandlers` really is a `SessionManager`, and `sendPrompt` really
 * does drive the native adapter. The only observation is the messages the
 * scripted model was asked to answer — the point at which a plugin has actually
 * steered the loop.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NativeSessionAdapter } from "@nathapp/nax-agent";
import {
  _clientDeps,
  _resetNativeClient,
  clearNativeSessionState,
  nativeSessionStateOf,
} from "@nathapp/nax-agent/internal";
import type { Client, ConversationMessage, ResolvedModel } from "@nathapp/nax-ai";
import { assertDefined, cleanupTempDir, makeTempDir, withDerivedStream } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native-agent";
import { globalConfigDir, NATIVE_AGENT_NAME } from "@/config";
import { loadPlugins } from "@/plugins";
import { SessionManager } from "@/session/manager";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

/** The message the plugin's `before_turn` handler seeds. */
const SEEDED_MESSAGE: ConversationMessage = { role: "user", content: "SEED-NOTE" };

const PLUGIN_NAME = "seed-note-plugin";

/** The plugin file a project would ship in `<project>/.nax/plugins/`. */
const PLUGIN_SOURCE = `
export default {
  name: "${PLUGIN_NAME}",
  version: "1.0.0",
  provides: ["loop-handlers"],
  extensions: {
    loopHandlers: {
      register(on) {
        on("before_turn", () => ({ seed: [{ role: "user", content: "SEED-NOTE" }] }));
      },
    },
  },
};
`;

const REAL_BUILD = _clientDeps.build;

const tempDirs: string[] = [];
let sessionSeq = 0;

afterEach(() => {
  for (const dir of tempDirs) cleanupTempDir(dir);
  tempDirs.length = 0;
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/** A model that records every message array it is asked to answer. */
function scriptedClient(requests: (readonly ConversationMessage[])[]): Client {
  return withDerivedStream({
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async (_model: ResolvedModel, req: { readonly messages: readonly ConversationMessage[] }) => {
      requests.push([...req.messages]);
      return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" as const };
    },
    validate: () => {},
  });
}

/**
 * Drive one native session through the real `SessionManager`, with the plugin
 * loaded from the temp workdir's `.nax/plugins/`.
 *
 * `deliverHandlers` is the caller's `configureLoopHandlers` step: with it, the
 * loaded set reaches the manager; without it, nothing does — which is what makes
 * the seeded message attributable to the delivery rather than to the harness.
 */
async function driveNativeSession(deliverHandlers: boolean): Promise<(readonly ConversationMessage[])[]> {
  const workdir = tempDir("nax-loop-handler-delivery-");
  const pluginsDir = join(workdir, ".nax", "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await Bun.write(join(pluginsDir, "seed-note-plugin.ts"), PLUGIN_SOURCE);

  const registry = await loadPlugins(join(globalConfigDir(), "plugins"), pluginsDir, [], workdir);
  const set = registry.getLoopHandlers();
  expect(set.map((entry) => entry.plugin)).toEqual([PLUGIN_NAME]);

  const requests: (readonly ConversationMessage[])[] = [];
  _clientDeps.build = async () => scriptedClient(requests);

  const sessions = new NativeSessionAdapter();
  const adapter = new NativeAgentAdapter(undefined, [], sessions);
  const manager = new SessionManager({ getAdapter: () => adapter });
  if (deliverHandlers) manager.configureLoopHandlers(set);

  const sessionName = `sess-loop-handler-delivery-${++sessionSeq}`;
  try {
    const handle = await manager.openSession(sessionName, {
      agentName: NATIVE_AGENT_NAME,
      role: "implementer",
      workdir,
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      storyId: "US-004",
      featureName: "plugin-loop-handlers",
      transcriptDir: join(workdir, "transcripts"),
    });

    await manager.sendPrompt(handle, "hi");
    return requests;
  } finally {
    clearNativeSessionState(nativeSessionStateOf(sessions), sessionName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — the seeded message reaches the model
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — a project plugin's loop handler steers the native turn", () => {
  test("AC11: the seeded message is part of the first model request", async () => {
    const firstRequest = (await driveNativeSession(true))[0];
    assertDefined(firstRequest, "the first model request");

    expect(firstRequest).toContainEqual(SEEDED_MESSAGE);
  });

  test("AC11 (boundary): without delivery to the session manager the seed never reaches the model", async () => {
    const firstRequest = (await driveNativeSession(false))[0];
    assertDefined(firstRequest, "the first model request");

    expect(firstRequest).not.toContainEqual(SEEDED_MESSAGE);
    // ...and the turn really did run, with the caller's prompt alone.
    expect(firstRequest).toEqual([{ role: "user", content: "hi" }]);
  });
});
