/**
 * pi-ai's side of auth: a credential-store adapter and an AuthResolver.
 *
 * On the ALLOWED list in scripts/check-pi-ai-imports.ts. Nothing here leaks a
 * pi-ai type through an export a consumer sees.
 */

import type { Credential, MutableModels, CredentialStore as PiCredentialStore } from "@earendil-works/pi-ai";
import type { CredentialStore, ModelRef, StoredCredential } from "../types.ts";
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
