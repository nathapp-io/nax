import { describe, expect, test } from "bun:test";
import { NaxError } from "@nathapp/nax-agent";
import type { AuthPorts } from "#src/server/auth";
import {
  createServerAuth,
  loadServerAuth,
  NAX_AGENT_AUTH,
  NO_SERVER_AUTH,
  providerOf,
  terminalAuthMethods,
} from "#src/server/auth";
import { recordingLogger } from "#test/helpers/recording-logger";

describe("NAX_AGENT_AUTH", () => {
  test("builds a terminal interaction around the given log", () => {
    const interaction = NAX_AGENT_AUTH.interaction(() => undefined);
    expect(typeof interaction.prompt).toBe("function");
    expect(typeof interaction.notify).toBe("function");
  });
});

const OPTIONS = {
  configDir: "/cfg",
  sessionsDir: "/cfg/s",
  defaultMode: "ask" as const,
  bashApproval: "gated" as const,
  tiers: [
    { tier: "fast" as const, model: "openrouter/m-fast" },
    { tier: "balanced" as const, model: "anthropic/claude-sonnet-5-5" },
    { tier: "powerful" as const, model: "anthropic/claude-opus-5-5" },
  ],
  catalogOverrides: [],
  mcpConnectTimeoutSeconds: 30,
};

function ports(overrides: Partial<AuthPorts> = {}): AuthPorts {
  return {
    loginProviderIds: async () => ["anthropic", "openrouter"],
    providersWithoutCredentials: async () => [],
    runLogin: async () => Promise.reject(new Error("unused")),
    interaction: () => ({ prompt: async () => "", notify: () => undefined }),
    ...overrides,
  };
}

describe("providerOf", () => {
  test("the prefix before the first slash; undefined without one", () => {
    expect(providerOf("anthropic/claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOf("openrouter/meta/llama")).toBe("openrouter");
    expect(providerOf("bare-model")).toBeUndefined();
    expect(providerOf("/x")).toBeUndefined();
  });
});

describe("terminalAuthMethods (M-33)", () => {
  test("one method per loginable provider, deduped, in order of appearance", () => {
    expect(
      terminalAuthMethods({
        models: ["openrouter/a", "anthropic/b", "anthropic/c", "minimax/d", "bare"],
        overridden: new Set(),
        loginProviders: ["anthropic", "openrouter"],
      }),
    ).toEqual([
      { id: "login-openrouter", name: "Log in to openrouter", type: "terminal", args: ["login", "openrouter"] },
      { id: "login-anthropic", name: "Log in to anthropic", type: "terminal", args: ["login", "anthropic"] },
    ]);
  });

  test("a catalog-override provider is never offered (Review Focus 4)", () => {
    expect(
      terminalAuthMethods({
        models: ["anthropic/b"],
        overridden: new Set(["anthropic"]),
        loginProviders: ["anthropic"],
      }),
    ).toEqual([]);
  });
});

describe("createServerAuth", () => {
  const methods = terminalAuthMethods({
    models: ["anthropic/b"],
    overridden: new Set(["minimax"]),
    loginProviders: ["anthropic"],
  });

  test("authenticate: present credential (stored or ambient) succeeds (M-29, Review Focus 3)", async () => {
    const seen: (readonly string[])[] = [];
    const auth = createServerAuth({
      methods,
      overridden: new Set(),
      missing: async (ids) => {
        seen.push(ids);
        return [];
      },
    });
    expect(await auth.authenticate("login-anthropic")).toEqual({});
    expect(seen).toEqual([["anthropic"]]);
  });

  test("authenticate: missing credential is auth_required", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });
    const error = await auth.authenticate("login-anthropic").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic" } });
  });

  test("authenticate: unknown method is invalid_params listing the advertised ids (M-31)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => [] });
    const error = await auth.authenticate("login-nope").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32602 });
    expect(error instanceof Error ? error.message : "").toContain("login-anthropic");
  });

  test("ensureCredentials: missing -> auth_required naming the provider (M-30)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });
    const error = await auth.ensureCredentials("anthropic/claude-sonnet-5-5").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic" } });
    expect(error instanceof Error ? error.message : "").toContain("nax-agent login anthropic");
  });

  test("ensureCredentials: ambient-only credential passes (Review Focus 3)", async () => {
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => [] });
    await auth.ensureCredentials("anthropic/claude-sonnet-5-5");
  });

  test("ensureCredentials: skipped for an override provider and a bare id (Review Focus 4)", async () => {
    const asked: (readonly string[])[] = [];
    const auth = createServerAuth({
      methods,
      overridden: new Set(["minimax"]),
      missing: async (ids) => {
        asked.push(ids);
        return [...ids];
      },
    });
    await auth.ensureCredentials("minimax/m2");
    await auth.ensureCredentials("bare-model");
    expect(asked).toEqual([]);
  });

  test("ensureCredentials: a credential-helper failure is auth_required, redacted", async () => {
    const auth = createServerAuth({
      methods,
      overridden: new Set(),
      missing: async () =>
        Promise.reject(new NaxError("helper said sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "CREDENTIAL_HELPER_FAILED")),
    });
    const error = await auth.ensureCredentials("anthropic/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32000, data: { provider: "anthropic", code: "CREDENTIAL_HELPER_FAILED" } });
    expect(error instanceof Error ? error.message : "").not.toContain("abcdefghijklmnop");
  });

  test("ensureCredentials: any other failure propagates unchanged", async () => {
    const boom = new Error("disk on fire");
    const auth = createServerAuth({ methods, overridden: new Set(), missing: async () => Promise.reject(boom) });
    expect(await auth.ensureCredentials("anthropic/x").catch((e: unknown) => e)).toBe(boom);
  });
});

describe("NO_SERVER_AUTH", () => {
  test("advertises nothing, refuses authenticate, checks nothing", async () => {
    expect(NO_SERVER_AUTH.methods).toEqual([]);
    expect(await NO_SERVER_AUTH.authenticate("login-x").catch((e: unknown) => e)).toMatchObject({ code: -32602 });
    await NO_SERVER_AUTH.ensureCredentials("anthropic/x");
  });
});

describe("loadServerAuth (M-33)", () => {
  test("methods from tiers plus the default model, minus overrides", async () => {
    const { logger } = recordingLogger();
    const auth = await loadServerAuth({
      options: { ...OPTIONS, defaultModel: "openai/gpt-x" },
      overrides: [{ provider: "openrouter", models: [] }],
      ports: ports({ loginProviderIds: async () => ["anthropic", "openrouter", "openai"] }),
      logger,
    });
    expect(auth.methods.map((m) => m.id)).toEqual(["login-anthropic", "login-openai"]);
  });

  test("a failing provider listing gives no methods and one warning", async () => {
    const { logger, lines } = recordingLogger();
    const auth = await loadServerAuth({
      options: OPTIONS,
      overrides: [],
      ports: ports({ loginProviderIds: async () => Promise.reject(new Error("catalog")) }),
      logger,
    });
    expect(auth.methods).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn" });
  });
});
