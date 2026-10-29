import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  AgentSessionError,
  type CodingTool,
  createMemoryTranscriptStore,
  type OpenSessionOpts,
} from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";
import { assertCaughtInstanceOf, makeNaxConfig } from "@test/helpers";
import { createAskPort } from "@/agents/acp/ask-port";
import {
  _openContextDeps,
  acpOpenSummary,
  backendEnv,
  backendOptions,
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_STARTUP_DEADLINE_MS,
  openContext,
  transcriptStoreFor,
} from "@/agents/acp/open-context";
import { createTurnSlot } from "@/agents/acp/turn-slot";
import { globalConfigDir } from "@/config/paths";
import { resolvePermissions } from "@/config/permissions";
import { PermissionsBlockSchema } from "@/config/schemas-execution";
import { getLogger, initLogger, resetLogger } from "@/logger";

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

describe("backendOptions: effort and deadlines (spec §6.7, §7.2)", () => {
  test("the model spec's effort suffix becomes the effort option; the bare id is the model", () => {
    const options = backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "sonnet[high]" } });
    expect(options).toMatchObject({ model: "sonnet", effort: "high" });
  });

  test("no suffix, no effort", () => {
    const options = backendOptions("claude", { ...OPTS, modelDef: { provider: "anthropic", model: "sonnet" } });
    expect("effort" in options).toBe(false);
  });

  test("the configured deadlines become initializeTimeoutMs and cancelGraceMs", () => {
    const options = backendOptions("claude", {
      ...OPTS,
      trackedSpawnStartupDeadlineMs: 45_000,
      trackedSpawnDeadlineMs: 7_000,
    });
    expect(options).toMatchObject({ initializeTimeoutMs: 45_000, cancelGraceMs: 7_000 });
  });

  test("absent deadlines fall back to nax's schema defaults, not the backend's 60 s", () => {
    const { trackedSpawnDeadlineMs: _t, trackedSpawnStartupDeadlineMs: _s, ...bare } = OPTS;
    expect(backendOptions("claude", bare)).toMatchObject({
      initializeTimeoutMs: DEFAULT_STARTUP_DEADLINE_MS,
      cancelGraceMs: DEFAULT_CLOSE_DEADLINE_MS,
    });
    expect(DEFAULT_STARTUP_DEADLINE_MS).toBe(30_000);
    expect(DEFAULT_CLOSE_DEADLINE_MS).toBe(10_000);
  });

  test("over-max deadlines are clamped to what the backend accepts (D3-i)", () => {
    const options = backendOptions("claude", {
      ...OPTS,
      trackedSpawnStartupDeadlineMs: 9_000_000,
      trackedSpawnDeadlineMs: 9_000_000,
    });
    expect(options).toMatchObject({ initializeTimeoutMs: 3_600_000, cancelGraceMs: 600_000 });
  });
});

/**
 * SPEC-cursor-pi-acp-read-only US-005: a safe-profile review stage that allows exactly one Bash
 * command. The block is written with the key a caller uses (`allow`) and parsed by the schema that
 * declares it — `ExecutionConfig` (`src/config/runtime-types.ts`) still lists only the legacy
 * `allowedTools`, so a literal here would be checked against the narrower hand-written type (the
 * same gap `test/unit/config/inert-bash-stages.test.ts` documents).
 */
const SAFE_REVIEW = makeNaxConfig({
  execution: {
    permissionProfile: "safe",
    permissions: PermissionsBlockSchema.parse({ review: { allow: ["Bash(git status*)"] } }),
  },
});

describe("backendOptions: permission rules (SPEC US-005)", () => {
  test("AC-1: the resolved grants, denies and asks are forwarded as the backend's rules", () => {
    const options = backendOptions("opencode", {
      ...OPTS,
      resolvedPermissions: {
        mode: "approve-reads",
        bashApproval: "gated",
        toolGrants: [{ tool: "Read", patterns: ["*"] }],
        denyRules: [{ tool: "Bash", patterns: ["git push*"] }],
        askRules: [{ tool: "Bash", patterns: ["npm test*"] }],
      },
    });
    expect(options.rules).toEqual({
      allow: [{ tool: "Read", patterns: ["*"] }],
      deny: [{ tool: "Bash", patterns: ["git push*"] }],
      ask: [{ tool: "Bash", patterns: ["npm test*"] }],
    });
  });

  test("AC-2: a stage that configures no rules forwards three empty lists", () => {
    const options = backendOptions("opencode", {
      ...OPTS,
      resolvedPermissions: { mode: "approve-reads", bashApproval: "gated" },
    });
    expect(options.rules).toEqual({ allow: [], deny: [], ask: [] });
  });

  test("AC-3: the rule-policy state directory is nax's own global ACP directory", () => {
    expect(backendOptions("cursor", OPTS).stateDir).toBe(join(globalConfigDir(), "acp"));
  });

  test("AC-9: the fields this story does not touch keep their values", () => {
    expect(backendOptions("opencode", OPTS)).toMatchObject({
      agent: "opencode",
      allowUnsandboxed: true,
      inheritEnv: false,
      initializeTimeoutMs: 30_000,
      cancelGraceMs: 10_000,
    });
  });

  test("AC-4: a safe-profile review stage's resolved rules open a cursor backend", () => {
    const options = backendOptions("cursor", {
      ...OPTS,
      resolvedPermissions: resolvePermissions(SAFE_REVIEW, "review"),
    });
    expect(options.rules?.allow).toContainEqual({ tool: "Bash", patterns: ["git status*"] });
    expect(() => acpBackend(options)).not.toThrow();
  });

  test("AC-10: a malformed deny rule is refused by the backend, not silently dropped", () => {
    const opts: OpenSessionOpts = {
      ...OPTS,
      resolvedPermissions: { ...OPTS.resolvedPermissions, denyRules: [{ tool: "Read", patterns: [] }] },
    };
    let caught: unknown;
    try {
      acpBackend(backendOptions("opencode", opts));
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, AgentSessionError, "acpBackend rejection");
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(String(caught.context?.path).startsWith("rules.deny.0")).toBe(true);
  });
});

describe("openContext (spec §6.1 step 2)", () => {
  test("maps the session: profile, no tools, no instructions, metadata from the audit header", () => {
    const slot = createTurnSlot();
    const store = createMemoryTranscriptStore();
    const closer = new AbortController();
    const ctx = openContext({
      name: "nax-s",
      agent: "claude",
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
      agent: "claude",
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

describe("openContext: provider-tool delivery (nax#2444)", () => {
  const PROVIDER_TOOL: CodingTool = {
    name: "context7__query-docs",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    run: async () => ({ content: "ok" }),
  };

  test("claude with provider tools: the context opens with them, profile narrowed by the declaration", () => {
    const slot = createTurnSlot();
    const ctx = openContext({
      name: "nax-s",
      agent: "claude",
      opts: {
        ...OPTS,
        declaredTools: ["Read", "Glob", "Grep"],
        providerTools: [PROVIDER_TOOL],
        toolSurface: {
          stage: "review",
          declaredTools: ["Read", "Glob", "Grep"],
          advertised: [{ providerId: "context7", names: ["query-docs"] }],
          withheld: [],
          skippedProviders: [],
          failures: [],
        },
      },
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.tools.map((tool) => tool.name)).toEqual(["context7__query-docs"]);
    expect(ctx.profile).toBe("read");
  });

  test("gemini with provider tools: degrades to a tool-less open (Review Focus 4)", () => {
    const slot = createTurnSlot();
    const ctx = openContext({
      name: "nax-s",
      agent: "gemini",
      opts: { ...OPTS, providerTools: [PROVIDER_TOOL] },
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.tools).toEqual([]);
  });

  test("codex with provider tools: the context opens with them", () => {
    const slot = createTurnSlot();
    const ctx = openContext({
      name: "nax-s",
      agent: "codex",
      opts: { ...OPTS, providerTools: [PROVIDER_TOOL] },
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.tools.map((tool) => tool.name)).toEqual([PROVIDER_TOOL.name]);
  });

  test("no provider tools: the historical B5 shape (tools empty)", () => {
    const slot = createTurnSlot();
    const ctx = openContext({
      name: "nax-s",
      agent: "claude",
      opts: OPTS,
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
    expect(ctx.tools).toEqual([]);
  });
});

describe("transcriptStoreFor", () => {
  test("no dir: an in-memory store", async () => {
    const store = transcriptStoreFor(undefined);
    await store.save("s", { savedAt: "t", messages: [] });
    expect(await store.load("s")).toMatchObject({ savedAt: "t" });
  });
});

describe("openContext sandbox (nax#2500)", () => {
  const sandbox = {
    kind: "policy",
    policy: { writeRoots: ["/repo"], denyWrite: [], denyRead: [], network: {} },
  } as const;
  const build = (opts: OpenSessionOpts) => {
    const slot = createTurnSlot();
    return openContext({
      name: "s1",
      agent: "claude",
      opts,
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
  };

  test("a command-declaring op opens review and carries the sandbox", () => {
    const ctx = build({ ...OPTS, declaredTools: ["Read", "Bash"], sandbox });
    expect(ctx.profile).toBe("review");
    expect(ctx.sandbox).toEqual(sandbox);
  });

  test("a read profile never carries the sandbox", () => {
    const ctx = build({ ...OPTS, declaredTools: ["Read"], sandbox });
    expect(ctx.profile).toBe("read");
    expect(ctx.sandbox).toBeUndefined();
  });
});

describe("acpOpenSummary (nax#2500 observability)", () => {
  const policy = { writeRoots: ["/repo"], denyWrite: [], denyRead: [], network: {} };

  test("a reviewer declaration opens review with the policy sandbox", () => {
    const summary = acpOpenSummary({ ...OPTS, declaredTools: ["Read", "Bash"], sandbox: { kind: "policy", policy } });
    expect(summary).toEqual({ profile: "review", sandbox: "policy" });
  });

  test("an undeclared approve-all session opens full; an unavailable sandbox is named", () => {
    const summary = acpOpenSummary({ ...OPTS, sandbox: { kind: "unavailable", reason: "no srt" } });
    expect(summary).toEqual({ profile: "full", sandbox: "unavailable" });
  });

  test("a read session reports no sandbox even when one is supplied", () => {
    const summary = acpOpenSummary({ ...OPTS, declaredTools: ["Read"], sandbox: { kind: "policy", policy } });
    expect(summary).toEqual({ profile: "read", sandbox: "none" });
  });
});

describe("US-006 backend shell sandbox carrier", () => {
  const controls = {
    pi: { extensions: "user" },
    opencode: { projectConfig: "disable" },
    cursor: { onUnwrapped: "rules" },
  } as const;
  function carrierOpts(value: string): OpenSessionOpts {
    return { ...OPTS, modelDef: { ...OPTS.modelDef, env: { A: "1", NAX_ACP_SHELL_SANDBOX: value } } };
  }

  test("AC-10/AC-11: lifts valid controls with deterministic runner and removes only the carrier", () => {
    const deps = _openContextDeps;
    const original = { ...deps };
    try {
      Object.assign(deps, { execPath: () => "/bin/bun", entry: () => "/opt/nax/nax.js" });
      const opts = carrierOpts(JSON.stringify(controls));
      const result = backendOptions("opencode", opts);
      expect(result.shellSandbox).toEqual({
        runtime: "/bin/bun",
        runner: ["/opt/nax/nax.js", "sandbox", "exec", "--"],
        ...controls,
      });
      expect(result.env).not.toHaveProperty("NAX_ACP_SHELL_SANDBOX");
      expect(result.env?.A).toBe("1");
      expect(opts.modelDef.env).toHaveProperty("NAX_ACP_SHELL_SANDBOX");
    } finally {
      Object.assign(deps, original);
    }
  });

  test("AC-12: no carrier leaves shellSandbox absent", () => {
    expect(backendOptions("opencode", OPTS)).not.toHaveProperty("shellSandbox");
  });

  test.each([
    "{not json",
    '{"pi":{"extensions":"x"},"opencode":{"projectConfig":"disable"},"cursor":{"onUnwrapped":"rules"}}',
    "null",
    "{}",
    "[]",
    "",
  ])("AC-13/AC-14/AC-16: invalid carrier %s warns without exposing env data", (value) => {
    initLogger({ level: "silent" });
    const warn = spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const result = backendOptions("opencode", carrierOpts(value));
      expect(result).not.toHaveProperty("shellSandbox");
      expect(result.env).not.toHaveProperty("NAX_ACP_SHELL_SANDBOX");
      expect(result.env?.A).toBe("1");
      expect(warn).toHaveBeenCalledTimes(1);
      // A static diagnostic cannot expose JSON contents, env values, or parse-error excerpts.
      expect(warn.mock.calls[0]).toEqual(["acp", "[acp] Invalid shell sandbox carrier; ignoring sandbox settings"]);
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });

  test("AC-15: the lifted cursor option passes the real backend schema", () => {
    const options = backendOptions("cursor", carrierOpts(JSON.stringify(controls)));
    expect(options).toHaveProperty("shellSandbox");
    expect(() => acpBackend(options)).not.toThrow();
  });
});
