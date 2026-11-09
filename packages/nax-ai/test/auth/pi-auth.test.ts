import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthFlowProhibitedError } from "../../src/auth/oauth-policy.ts";
import { createPiAuthResolver, toPiCredentialStore } from "../../src/auth/pi-auth.ts";
import { createFileCredentialStore } from "../../src/credentials/file-store.ts";
import { createMemoryCredentialStore as memoryStore } from "../../src/credentials/memory-store.ts";

describe("toPiCredentialStore", () => {
  it("presents an api-key credential in pi's shape", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } }));
    expect(await pi.read("deepseek")).toEqual({ type: "api_key", key: "sk-1" });
  });

  it("presents an oauth credential in pi's shape", async () => {
    const pi = toPiCredentialStore(
      memoryStore({ "openai-codex": { kind: "oauth", access: "a", refresh: "r", expires: 42 } }),
    );
    expect(await pi.read("openai-codex")).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 42 });
  });

  it("round-trips env through modify without dropping it", async () => {
    const store = memoryStore({
      cloudflare: { kind: "api-key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } },
    });
    const pi = toPiCredentialStore(store);

    await pi.modify("cloudflare", async (current) => {
      expect(current).toEqual({ type: "api_key", key: "$CF_KEY", env: { CF_ACCOUNT: "acct-1" } });
      return current;
    });

    expect(await store.read("cloudflare")).toEqual({
      kind: "api-key",
      key: "$CF_KEY",
      env: { CF_ACCOUNT: "acct-1" },
    });
  });

  it("treats key as opaque and never rewrites a template", async () => {
    const pi = toPiCredentialStore(memoryStore({ deepseek: { kind: "api-key", key: "!op read op://x/y" } }));
    expect((await pi.read("deepseek"))?.key).toBe("!op read op://x/y");
  });

  it("resolves undefined for a provider with no credential", async () => {
    expect(await toPiCredentialStore(memoryStore()).read("nope")).toBeUndefined();
  });

  it("deletes through to the underlying store", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).delete("deepseek");
    expect(await store.read("deepseek")).toBeUndefined();
  });

  it("leaves the credential unchanged when the modify fn returns undefined, pi's no-op-refresh contract", async () => {
    const store = memoryStore({ deepseek: { kind: "api-key", key: "sk-1" } });
    await toPiCredentialStore(store).modify("deepseek", async () => undefined);
    expect(await store.read("deepseek")).toEqual({ kind: "api-key", key: "sk-1" });
  });

  it("keeps a concurrently refreshed credential when a second modify fn declines with undefined", async () => {
    const store = memoryStore({ "openai-codex": { kind: "oauth", access: "stale", refresh: "r", expires: 1 } });
    const pi = toPiCredentialStore(store);

    // First caller refreshes under the store lock.
    await pi.modify("openai-codex", async () => ({ type: "oauth", access: "fresh", refresh: "r2", expires: 2 }));
    // Second caller sees the refreshed credential and yields to it: undefined.
    const seen = await pi.modify("openai-codex", async (current) => {
      expect(current).toEqual({ type: "oauth", access: "fresh", refresh: "r2", expires: 2 });
      return undefined;
    });

    expect(seen).toEqual({ type: "oauth", access: "fresh", refresh: "r2", expires: 2 });
    expect(await store.read("openai-codex")).toEqual({
      kind: "oauth",
      access: "fresh",
      refresh: "r2",
      expires: 2,
    });
  });

  it("enumerates nothing, because nax-ai does not own account listing", async () => {
    expect(await toPiCredentialStore(memoryStore({ a: { kind: "api-key", key: "k" } })).list()).toEqual([]);
  });
});

describe("createPiAuthResolver", () => {
  /** Stands in for pi-ai's Models, which is the only part of it we call. */
  function fakeModels(result: unknown) {
    return { getAuth: async () => result } as unknown as Parameters<typeof createPiAuthResolver>[0];
  }

  it("returns the resolved api key for a provider", async () => {
    const resolver = createPiAuthResolver(fakeModels({ auth: { apiKey: "sk-live" } }));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({ apiKey: "sk-live" });
  });

  it("forwards resolved headers and drops the nulls pi uses to suppress defaults", async () => {
    const resolver = createPiAuthResolver(
      fakeModels({ auth: { headers: { authorization: "Bearer t", "x-drop": null } } }),
    );
    expect(await resolver.resolve({ provider: "openai-codex", model: "gpt-5.4" })).toEqual({
      headers: { authorization: "Bearer t" },
    });
  });

  it("resolves empty for an unconfigured provider rather than throwing", async () => {
    const resolver = createPiAuthResolver(fakeModels(undefined));
    expect(await resolver.resolve({ provider: "deepseek", model: "deepseek-chat" })).toEqual({});
  });
});

describe("toPiCredentialStore OAuth policy", () => {
  const oauth = { kind: "oauth", access: "acc", refresh: "ref", expires: 99 } as const;

  it("hides an anthropic oauth credential from pi", async () => {
    expect(await toPiCredentialStore(memoryStore({ anthropic: oauth })).read("anthropic")).toBeUndefined();
  });

  it("hides a github-copilot oauth credential from pi", async () => {
    expect(await toPiCredentialStore(memoryStore({ "github-copilot": oauth })).read("github-copilot")).toBeUndefined();
  });

  it("keeps the hidden credential in the underlying store after a read", async () => {
    const store = memoryStore({ anthropic: oauth });
    await toPiCredentialStore(store).read("anthropic");
    expect(await store.read("anthropic")).toEqual(oauth);
  });

  it("still presents a permitted oauth credential", async () => {
    const pi = toPiCredentialStore(memoryStore({ "openai-codex": oauth }));
    expect(await pi.read("openai-codex")).toEqual({ type: "oauth", access: "acc", refresh: "ref", expires: 99 });
  });

  it("still presents an anthropic api-key credential", async () => {
    const pi = toPiCredentialStore(memoryStore({ anthropic: { kind: "api-key", key: "sk-test" } }));
    expect(await pi.read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
  });

  it("hands modify undefined as the current value for a hidden credential", async () => {
    const seen: unknown[] = [];
    await toPiCredentialStore(memoryStore({ anthropic: oauth })).modify("anthropic", async (current) => {
      seen.push(current);
      return undefined;
    });
    expect(seen).toEqual([undefined]);
  });

  it("rejects a modify that writes an oauth credential for a prohibited provider and leaves the store empty", async () => {
    const store = memoryStore();
    const pi = toPiCredentialStore(store);
    await expect(
      pi.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 })),
    ).rejects.toBeInstanceOf(OAuthFlowProhibitedError);
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("keeps the hidden credential when modify returns undefined", async () => {
    const store = memoryStore({ anthropic: oauth });
    await toPiCredentialStore(store).modify("anthropic", async () => undefined);
    expect(await store.read("anthropic")).toEqual(oauth);
  });

  it("does not expose a hidden credential through the modify result", async () => {
    const store = memoryStore({ anthropic: oauth });
    const result = await toPiCredentialStore(store).modify("anthropic", async () => undefined);
    expect(result).toBeUndefined();
  });

  it("still deletes a hidden credential through the explicit delete", async () => {
    const store = memoryStore({ anthropic: oauth });
    await toPiCredentialStore(store).delete("anthropic");
    expect(await store.read("anthropic")).toBeUndefined();
  });
});

describe("toPiCredentialStore with the real models and file store", () => {
  const saved = new Map<string, string | undefined>();
  let dir: string;

  beforeEach(async () => {
    for (const name of Object.keys(process.env).filter((key) => key.startsWith("ANTHROPIC_"))) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    dir = await mkdtemp(join(tmpdir(), "nax-ai-pi-auth-"));
  });

  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    saved.clear();
    await rm(dir, { recursive: true, force: true });
  });

  async function resolverWithHiddenOAuth() {
    const store = createFileCredentialStore({ path: join(dir, "credentials.json") });
    await store.modify("anthropic", async () => ({ kind: "oauth", access: "acc", refresh: "ref", expires: 99 }));
    return createPiAuthResolver(builtinModels({ credentials: toPiCredentialStore(store) }));
  }

  it("resolves no apiKey when only a hidden anthropic oauth credential exists", async () => {
    const resolved = await (await resolverWithHiddenOAuth()).resolve({ provider: "anthropic", model: "claude-x" });
    expect(resolved.apiKey).toBeUndefined();
  });

  it("resolves the environment api key rather than the hidden oauth credential", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-test";
    const resolved = await (await resolverWithHiddenOAuth()).resolve({ provider: "anthropic", model: "claude-x" });
    expect(resolved.apiKey).toBe("sk-env-test");
  });
});
