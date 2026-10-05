/**
 * The facade's resume and per-session clients on real Node (S3 spec 8):
 * resume after a simulated restart reports the interrupted turn and carries
 * history from a file store; a different model is refused; two sessions with
 * different catalog overrides and memory credentials run in one process. This
 * file never calls configureCredentials, and vitest isolates each test file's
 * modules, so the process-wide credentials slot stays unset throughout.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CreateAgentSessionOptions,
  type CredentialSource,
  createAgentSession,
  createFileTranscriptStore,
  resumeAgentSession,
} from "#src/index";
import { _clientDeps, type NativeCatalogOverrides } from "#src/native/client";
import {
  collect,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
} from "#test/helpers/agent-session";

const CREDENTIALS: CredentialSource = { kind: "memory", credentials: { openai: { kind: "api-key", key: "sk-node" } } };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-agent-node-resume-"));
});
afterEach(async () => {
  resetScriptedProvider();
  await rm(dir, { recursive: true, force: true });
});

function nodeOptions(extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return sessionOptions({ credentials: CREDENTIALS, transcriptStore: createFileTranscriptStore(dir), ...extra });
}

describe("agent session on Node: resume", () => {
  test("resume after a simulated restart reports the interrupted turn and carries history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const first = await createAgentSession(nodeOptions({ sessionId: "node-resume" }));
    await collect(first.send("first"));
    await first.close();
    // The process dies after markTurn(running): the marker stays on disk.
    await createFileTranscriptStore(dir).markTurn("node-resume", { turnId: "t-dead", state: "running" });

    const resumed = await resumeAgentSession("node-resume", nodeOptions());
    expect(resumed.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect((await createFileTranscriptStore(dir).load("node-resume"))?.turn).toEqual({
      turnId: "t-dead",
      state: "ended",
    });
    expect(turnEndOf(await collect(resumed.send("second"))).output).toBe("two");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "first" },
      expect.objectContaining({ role: "assistant", content: "one" }),
      { role: "user", content: "second" },
    ]);
    await resumed.close();
  });

  test("resume with a different model is refused", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"));
    const first = await createAgentSession(nodeOptions({ sessionId: "node-model" }));
    await collect(first.send("first"));
    await first.close();
    await expect(resumeAgentSession("node-model", nodeOptions({ model: "openai/gpt-5.4" }))).rejects.toMatchObject({
      code: "AGENT_SESSION_MODEL_MISMATCH",
    });
  });
});

describe("agent session on Node: many sessions in one process", () => {
  test("two sessions with different catalog overrides and memory credentials each build their own client", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const scripted = _clientDeps.build;
    const builds: unknown[] = [];
    _clientDeps.build = async (overrides, options) => {
      builds.push(overrides);
      return scripted(overrides, options);
    };
    const proxyA: NativeCatalogOverrides = [{ provider: "proxy-a", models: [] }];
    const proxyB: NativeCatalogOverrides = [{ provider: "proxy-b", models: [] }];
    const a = await createAgentSession(nodeOptions({ catalogOverrides: proxyA }));
    const b = await createAgentSession(nodeOptions({ catalogOverrides: proxyB }));
    expect(turnEndOf(await collect(a.send("hi"))).status).toBe("completed");
    expect(turnEndOf(await collect(b.send("hi"))).status).toBe("completed");
    expect(builds).toEqual([proxyA, proxyB]);
    await a.close();
    await b.close();
  });
});
