/**
 * pi-ai's side of auth: a credential-store adapter and an AuthResolver.
 *
 * On the ALLOWED list in scripts/check-pi-ai-imports.ts. Nothing here leaks a
 * pi-ai type through an export a consumer sees.
 */

import type {
  Credential,
  MutableModels,
  AuthEvent as PiAuthEvent,
  AuthPrompt as PiAuthPrompt,
  CredentialStore as PiCredentialStore,
  Provider as PiProvider,
} from "@earendil-works/pi-ai";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import type { CredentialStore, ModelRef, ProviderId, StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError, LoginFailedError } from "./login-errors.ts";
import type { LoginEvent, LoginInteraction, LoginPrompt } from "./login-types.ts";
import { assertOAuthFlowPermitted, isOAuthFlowPermitted } from "./oauth-policy.ts";
import type { AuthResolver, ResolvedAuth } from "./resolver.ts";

function toPi(credential: StoredCredential | undefined): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "api-key") {
    return {
      type: "api_key",
      key: credential.key,
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

function fromPi(credential: Credential | undefined): StoredCredential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "api_key") {
    return {
      kind: "api-key",
      key: credential.key ?? "",
      ...(credential.env !== undefined ? { env: { ...credential.env } } : {}),
    };
  }
  return {
    kind: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

export function toPiCredentialStore(store: CredentialStore): PiCredentialStore {
  return {
    read: async (providerId) => toPi(await store.read(providerId)),

    // modify stays a single read-modify-write so the underlying store can hold
    // a lock across the whole operation. pi-ai runs OAuth refresh inside it.
    modify: async (providerId, fn) =>
      toPi(
        await store.modify(providerId, async (current) => {
          const next = await fn(toPi(current));
          // pi's modify contract treats an undefined return as "leave the
          // entry unchanged" — its OAuth refresh returns that when a
          // concurrent caller already rotated the token. nax-ai's undefined
          // means "remove", so the no-op is translated to the current
          // credential, never propagated; removal goes through delete().
          return next === undefined ? current : fromPi(next);
        }),
      ),

    delete: async (providerId) => {
      await store.delete(providerId);
    },

    // pi-ai requires `list` for account and status enumeration. nax-ai's
    // CredentialStore has no equivalent and nax-ai never enumerates accounts:
    // that belongs to login and logout, which are out of scope for M2. An
    // empty list is what "this store does not enumerate" looks like, and it is
    // only ever read by UI that nax-ai does not have.
    list: async () => [],
  };
}

export function createPiAuthResolver(models: MutableModels): AuthResolver {
  return {
    async resolve(ref: ModelRef): Promise<ResolvedAuth> {
      const result = await models.getAuth(ref.provider);
      const auth = result?.auth;
      if (auth === undefined) return {};
      return {
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers !== undefined
          ? {
              headers: Object.fromEntries(
                Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
              ),
            }
          : {}),
      };
    },
  };
}

export interface LoginRunner {
  /** Shown in the method prompt when a provider offers both. */
  readonly label: string;
  run(interaction: LoginInteraction, signal: AbortSignal): Promise<StoredCredential>;
}

export interface LoginTarget {
  readonly apiKey?: LoginRunner;
  readonly oauth?: LoginRunner;
}

/**
 * Test seam. The real read is a dynamic import because pi-ai's provider table
 * is large and only login and the ambient-auth probe need it, matching
 * pi-catalog.ts's own pattern.
 */
export const _loginDeps = {
  providers: async (): Promise<readonly PiProvider[]> => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    return builtinProviders();
  },
};

function required(credential: Credential, providerId: ProviderId): StoredCredential {
  const stored = fromPi(credential);
  if (stored === undefined) throw new LoginFailedError(providerId, "the flow returned no credential");
  return stored;
}

/**
 * Resolves which logins a provider can actually run.
 *
 * Reads pi's own two auth fields, NOT ResolvedProvider.auth: toProviderAuth
 * resolves api-key over oauth when a provider declares both, which hides
 * openrouter's OAuth flow (wrong) and anthropic's (right) indistinguishably.
 *
 * The allowlist is applied per method, not per provider, so a provider with a
 * disallowed OAuth flow keeps its api-key login.
 */
export async function resolveLoginTarget(providerId: ProviderId): Promise<LoginTarget> {
  const provider = (await _loginDeps.providers()).find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new AuthMethodUnavailableError(providerId);

  const target: { apiKey?: LoginRunner; oauth?: LoginRunner } = {};

  const apiKeyAuth = provider.auth.apiKey;
  if (apiKeyAuth?.login !== undefined) {
    // bind rather than call detached: pi's flows are object methods and may
    // read `this`.
    const run = apiKeyAuth.login.bind(apiKeyAuth);
    target.apiKey = {
      label: apiKeyAuth.name,
      run: async (interaction, signal) => required(await run({ ...toPiInteraction(interaction), signal }), providerId),
    };
  }

  const oauthAuth = provider.auth.oauth;
  if (oauthAuth !== undefined && isOAuthFlowPermitted(providerId)) {
    const run = oauthAuth.login.bind(oauthAuth);
    target.oauth = {
      label: oauthAuth.loginLabel ?? oauthAuth.name,
      run: async (interaction, signal) => {
        // Before the loader is touched, not after: pi bundles every flow behind
        // one lazy loader, so the gate must sit in front of it.
        assertOAuthFlowPermitted(providerId);
        return required(await run({ ...toPiInteraction(interaction), signal }), providerId);
      },
    };
  }

  if (target.apiKey === undefined && provider.auth.oauth !== undefined) {
    // The provider's only method is an OAuth flow this package refuses to run.
    // A policy refusal must not read as an absence: throw the policy error
    // rather than AuthMethodUnavailableError. assertOAuthFlowPermitted
    // distinguishes prohibited (OAuthFlowProhibitedError) from unknown.
    assertOAuthFlowPermitted(providerId);
  }

  return target;
}

function fromPiPrompt(prompt: PiAuthPrompt): LoginPrompt {
  const signal = prompt.signal !== undefined ? { signal: prompt.signal } : {};
  switch (prompt.type) {
    case "manual_code":
      return {
        ...signal,
        type: "manual-code",
        message: prompt.message,
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
      };
    case "select":
      return { ...signal, type: "select", message: prompt.message, options: prompt.options };
    default:
      return {
        ...signal,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
      };
  }
}

function fromPiEvent(event: PiAuthEvent): LoginEvent {
  switch (event.type) {
    case "auth_url":
      return {
        type: "auth-url",
        url: event.url,
        ...(event.instructions !== undefined ? { instructions: event.instructions } : {}),
      };
    case "device_code":
      return {
        type: "device-code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    case "info":
      return { type: "info", message: event.message, ...(event.links !== undefined ? { links: event.links } : {}) };
    default:
      return { type: "progress", message: event.message };
  }
}

/**
 * Presents a consumer's LoginInteraction to pi. pi calls us, so this maps
 * inward: pi's snake_case names become nax-ai's kebab-case ones.
 */
function toPiInteraction(interaction: LoginInteraction): {
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
} {
  return {
    prompt: async (prompt) => interaction.prompt(fromPiPrompt(prompt)),
    notify: (event) => {
      interaction.notify(fromPiEvent(event));
    },
  };
}

/**
 * Whether ambient auth alone would satisfy this provider.
 *
 * Enumerating env var names cannot answer this: ProviderAuth.env is
 * descriptive only, often absent, and never read by auth resolution. pi's own
 * resolve() returns undefined when a provider is not configured and already
 * merges env vars, AWS profiles and ADC files, so asking it with no credential
 * is the question exactly. check() is the side-effect-free variant, preferred
 * because resolve() may execute commands.
 *
 * A probe that throws is reported as "not available" rather than propagated:
 * this only ever decorates a diagnostic, and breaking the command it decorates
 * would be worse than a missing warning.
 */
let bundledOAuthFlows: Promise<void> | undefined;

/**
 * Registers pi-ai's OAuth flow modules so a bundled build of this package can
 * still find them.
 *
 * The bug this exists to fix: pi-ai's default loader (`auth/oauth/load.js`)
 * reaches each flow module through a *variable* import specifier, built from
 * `import.meta.url` at run time. From source that resolves fine inside
 * node_modules, but once this package is bundled `import.meta.url` points at
 * the bundle file, the flow module is not beside it on disk, and login fails
 * with "Cannot find module './openai-codex.js'". pi-ai ships a fix for this
 * exact shape: `registerBundledOAuthFlowLoaders`, which lets a bundler-aware
 * caller hand it the flow modules directly instead of letting it compute a
 * path at run time.
 *
 * The import below MUST stay a dynamic import of a LITERAL specifier string:
 *   - Literal, so a bundler can statically follow and include it — that is
 *     the entire fix. Building the specifier from a variable (even
 *     `"@earendil-works/pi-ai" + "/bun-oauth"`) reintroduces the original bug
 *     in a new spot.
 *   - Dynamic, so this cost is paid only by a consumer that actually logs in.
 *     A static top-level import would drag all seven OAuth flow modules plus
 *     their `node:http`/`node:crypto` dependencies into every consumer's
 *     eager import graph, including ones that never call this function.
 * A future "simplification" to a static import, or to a computed specifier,
 * would silently undo the fix this function exists to provide.
 *
 * Named without "bun": pi-ai exposes this at the subpath `bun-oauth` because
 * it was built for pi-ai's own standalone Bun binary, but nothing inside it
 * is Bun-specific — it is seven plain imports and one function call, and it
 * fixes the same bundler problem for any bundled build (Node included). This
 * package ships to Node and Deno consumers too, so an API named after Bun
 * here would misdescribe what it does.
 */
export function registerBundledOAuthFlows(): Promise<void> {
  bundledOAuthFlows ??= (async () => {
    const { registerBunOAuthFlows } = await import("@earendil-works/pi-ai/bun-oauth");
    registerBunOAuthFlows();
  })().catch((error: unknown) => {
    // Memoise the success, never the failure. Caching a rejected promise
    // would turn one transient import error into a permanent one: every
    // later login in this process would fail with it, and nothing would
    // clear it short of a restart.
    bundledOAuthFlows = undefined;
    throw error;
  });
  return bundledOAuthFlows;
}

export async function ambientAuthAvailable(providerId: ProviderId): Promise<boolean> {
  const provider = (await _loginDeps.providers()).find((candidate) => candidate.id === providerId);
  const apiKey = provider?.auth.apiKey;
  if (apiKey === undefined) return false;

  const ctx = defaultProviderAuthContext();
  const signal = new AbortController().signal;

  try {
    // Bind rather than call detached: pi's auth objects are methods that may read `this`.
    if (apiKey.check !== undefined) {
      return (await apiKey.check.bind(apiKey)({ ctx, signal })) !== undefined;
    }
    return (await apiKey.resolve.bind(apiKey)({ ctx, signal })) !== undefined;
  } catch {
    return false;
  }
}
