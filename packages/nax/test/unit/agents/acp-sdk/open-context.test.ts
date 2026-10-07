import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryTranscriptStore, type OpenSessionOpts } from "@nathapp/nax-agent";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import { backendEnv, backendOptions, openContext, transcriptStoreFor } from "@/agents/acp-sdk/open-context";
import { createTurnSlot } from "@/agents/acp-sdk/turn-slot";

const OPTS: OpenSessionOpts = {
  agentName: "claude",
  workdir: "/repo",
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "anthropic", model: "sonnet[high]", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } },
  timeoutSeconds: 600,
  toolAudit: {
    dir: "/audit",
    header: { runId: "r1", featureName: "f", storyId: "US-001", sessionRole: "implementer" },
  },
};

const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  saved[key] = process.env[key];
  process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
});

describe("backendEnv (spec §6.1 step 3)", () => {
  test("is nax's allowlist plus the model env, all strings", () => {
    setEnv("CLAUDE_TEST_ALLOWED", "yes");
    setEnv("UNRELATED_SECRET", "no");
    const env = backendEnv({ ANTHROPIC_BASE_URL: "https://proxy.example" });
    expect(env.CLAUDE_TEST_ALLOWED).toBe("yes");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
  });

  test("drops a variable whose name the backend's option schema rejects (Review Focus 5)", () => {
    setEnv("CLAUDE_X-Y", "1");
    expect(backendEnv()).not.toHaveProperty("CLAUDE_X-Y");
  });
});

describe("backendOptions", () => {
  test("strips the effort suffix from the model and never inherits the whole env", () => {
    const options = backendOptions("claude", OPTS);
    expect(options).toMatchObject({ agent: "claude", allowUnsandboxed: true, model: "sonnet", inheritEnv: false });
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
  });

  test("process hooks are passed through when given", () => {
    const hooks = { spawned: () => {}, exited: () => {} };
    expect(backendOptions("claude", OPTS, hooks).onProcess).toBe(hooks);
    expect(backendOptions("claude", OPTS)).not.toHaveProperty("onProcess");
  });

  test("an empty model id sets no model option", () => {
    expect(backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "" } })).not.toHaveProperty(
      "model",
    );
  });
});

describe("openContext (spec §6.1 step 2)", () => {
  test("maps the session: profile, no tools, no instructions, metadata from the audit header", () => {
    const slot = createTurnSlot();
    const store = createMemoryTranscriptStore();
    const closer = new AbortController();
    const ctx = openContext({
      name: "nax-s",
      opts: OPTS,
      store,
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: closer.signal,
    });
    expect(ctx).toMatchObject({
      sessionId: "nax-s",
      workdir: "/repo",
      profile: "full",
      instructions: undefined,
      tools: [],
      resume: undefined,
      turnTimeoutSeconds: 600,
      metadata: { feature: "f", storyId: "US-001", role: "implementer" },
    });
    expect(ctx.transcriptStore).toBe(store);
    expect(ctx.openSignal).toBe(closer.signal);
    expect(ctx.turnSignal().aborted).toBe(false);
    expect(ctx.currentTurnId()).toBeUndefined();
  });

  test("approve-reads opens read; a leftover document is passed as resume", () => {
    const slot = createTurnSlot();
    const doc = { savedAt: "2026-10-07T00:00:00Z", messages: [] };
    const ctx = openContext({
      name: "nax-s",
      opts: { ...OPTS, resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" }, toolAudit: undefined },
      store: createMemoryTranscriptStore(),
      resume: doc,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.profile).toBe("read");
    expect(ctx.resume).toEqual({ doc });
    expect(ctx.metadata).toEqual({});
  });
});

describe("transcriptStoreFor", () => {
  test("no dir: an in-memory store", async () => {
    const store = transcriptStoreFor(undefined);
    await store.save("s", { savedAt: "t", messages: [] });
    expect(await store.load("s")).toMatchObject({ savedAt: "t" });
  });
});
