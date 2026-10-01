import type { Provider as PiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { _loginDeps, ambientAuthAvailable } from "../../src/auth/pi-auth.ts";

/**
 * A pi provider is a large structural type and this suite reads two fields of
 * it, so the doubles are built narrow and cast, matching pi-auth-login.test.ts.
 * Widening them would test the cast, not the probe.
 */
function piProvider(input: {
  id: string;
  apiKey?: { check?: (arg: { credential?: unknown }) => Promise<unknown>; resolve: () => Promise<unknown> };
  oauth?: boolean;
}): PiProvider {
  return {
    id: input.id,
    name: input.id,
    auth: {
      ...(input.apiKey !== undefined ? { apiKey: { name: input.id, ...input.apiKey } } : {}),
      ...(input.oauth === true
        ? { oauth: { name: "OAuth", login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }) } }
        : {}),
    },
  } as unknown as PiProvider;
}

const real = _loginDeps.providers;
afterEach(() => {
  _loginDeps.providers = real;
});

function withProviders(providers: readonly PiProvider[]): void {
  _loginDeps.providers = async () => providers;
}

describe("ambientAuthAvailable", () => {
  it("is false for a provider that is not in the catalog", async () => {
    withProviders([]);
    expect(await ambientAuthAvailable("nope")).toBe(false);
  });

  it("is false for a provider with no api-key auth", async () => {
    withProviders([piProvider({ id: "codex-only", oauth: true })]);
    expect(await ambientAuthAvailable("codex-only")).toBe(false);
  });

  it("prefers check() when the provider offers one, and passes no credential", async () => {
    let sawCredentialKey = true;
    withProviders([
      piProvider({
        id: "checked",
        apiKey: {
          check: async (arg) => {
            sawCredentialKey = "credential" in arg;
            return { type: "api_key" };
          },
          resolve: async () => {
            throw new Error("resolve must not be called when check exists");
          },
        },
      }),
    ]);

    expect(await ambientAuthAvailable("checked")).toBe(true);
    // Passing `credential: undefined` explicitly would read as "no credential"
    // to pi but is a different call; the probe omits the property entirely.
    expect(sawCredentialKey).toBe(false);
  });

  it("is false when check() reports nothing configured", async () => {
    withProviders([
      piProvider({ id: "unset", apiKey: { check: async () => undefined, resolve: async () => undefined } }),
    ]);
    expect(await ambientAuthAvailable("unset")).toBe(false);
  });

  it("falls back to resolve() when there is no check()", async () => {
    withProviders([piProvider({ id: "resolved", apiKey: { resolve: async () => ({ apiKey: "sk-live" }) } })]);
    expect(await ambientAuthAvailable("resolved")).toBe(true);
  });

  it("is false rather than throwing when the probe fails", async () => {
    withProviders([
      piProvider({
        id: "angry",
        apiKey: {
          resolve: async () => {
            throw new Error("the credential helper exited 1");
          },
        },
      }),
    ]);
    expect(await ambientAuthAvailable("angry")).toBe(false);
  });

  it("is false rather than throwing when check() itself throws", async () => {
    withProviders([
      piProvider({
        id: "check-throws",
        apiKey: {
          check: async () => {
            throw new Error("the credential helper exited 1");
          },
          resolve: async () => {
            throw new Error("resolve must not be called when check exists");
          },
        },
      }),
    ]);
    expect(await ambientAuthAvailable("check-throws")).toBe(false);
  });
});
