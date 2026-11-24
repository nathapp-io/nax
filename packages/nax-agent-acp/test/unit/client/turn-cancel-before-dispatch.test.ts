import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { endOf } from "#test/helpers/session-events";

const originalLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;
beforeEach(() => {
  workdir = makeTempDir("acp-cancel-before-dispatch-");
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  _acpBackendDeps.launch = originalLaunch;
  cleanupTempDir(workdir);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function open(fake: InMemoryAgent, markTurn: (state: "running" | "ended") => Promise<void> = async () => {}) {
  _acpBackendDeps.launch = fake.launch;
  const base = createMemoryTranscriptStore();
  const store = {
    load: (id: string) => base.load(id),
    save: (id: string, doc: Parameters<typeof base.save>[1]) => base.save(id, doc),
    retainFailed: (id: string) => base.retainFailed(id),
    delete: (id: string) => base.delete(id),
    markTurn: async (id: string, marker: Parameters<typeof base.markTurn>[1]) => {
      await markTurn(marker.state);
      await base.markTurn(id, marker);
    },
  };
  const session = await createAgentSession({
    backend: acpBackend({ agent: { name: "fake", command: "fake" }, allowUnsandboxed: true }),
    profile: "full",
    workdir,
    transcriptStore: store,
  });
  sessions.push(session);
  return session;
}

async function eventsOf(send: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of send) events.push(event);
  return events;
}
const prompts = (fake: InMemoryAgent) => fake.callsTo("session/prompt") as readonly PromptRequest[];

describe("ACP cancellation before prompt dispatch", () => {
  test("AC-1/2/3/4: cancellation during the running marker sends no prompt or cancel and ends cancelled with zero usage", async () => {
    const held = deferred();
    const entered = deferred();
    const fake = inMemoryAgent({
      turns: [
        {
          steps: [{ kind: "text", text: "scripted response" }],
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
      ],
    });
    const session = await open(fake, async (state) => {
      if (state === "running") {
        entered.resolve();
        await held.promise;
      }
    });
    const collected = eventsOf(session.send("look"));
    try {
      await entered.promise;
      session.cancel();
    } finally {
      held.resolve();
    }
    const events = await collected;
    const end = endOf(events);
    expect({ prompts: prompts(fake), cancels: fake.callsTo("session/cancel") }).toEqual({ prompts: [], cancels: [] });
    expect(end).toMatchObject({ status: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  test("AC-5: cancellation after dispatch sends one prompt and cancel and ends cancelled", async () => {
    const fake = inMemoryAgent({ turns: [{ steps: [{ kind: "waitForCancel" }] }] });
    const session = await open(fake);
    const collected = eventsOf(session.send("look"));
    while (prompts(fake).length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    session.cancel();
    expect(endOf(await collected).status).toBe("cancelled");
    expect(prompts(fake)).toHaveLength(1);
    expect(fake.callsTo("session/cancel")).toHaveLength(1);
  });

  test("AC-6: the same session accepts a successful send after pre-dispatch cancellation", async () => {
    const held = deferred();
    const entered = deferred();
    const fake = inMemoryAgent({
      turns: [
        { steps: [{ kind: "text", text: "must not be consumed" }] },
        { steps: [{ kind: "text", text: "again" }] },
      ],
    });
    let holdFirst = true;
    const session = await open(fake, async (state) => {
      if (state === "running" && holdFirst) {
        holdFirst = false;
        entered.resolve();
        await held.promise;
      }
    });
    const collected = eventsOf(session.send("look"));
    try {
      await entered.promise;
      session.cancel();
      held.resolve();
      const events = await collected;
      expect(endOf(events).status).toBe("cancelled");
    } finally {
      held.resolve();
    }
    const secondEvents = await eventsOf(session.send("again"));
    expect(endOf(secondEvents).status).toBe("completed");
    expect(prompts(fake)).toHaveLength(1);
  });
});
