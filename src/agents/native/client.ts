/**
 * The nax-ai client, built once per process.
 *
 * defaultProviders() loads nax-ai's bundled catalog (~1290 models), so building per
 * call would pay that cost on every completion. The build is memoised, but a
 * FAILED build is not: a transient failure must not poison the process.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts).
 */

import { type Client, createClient, defaultProtocols, defaultProviders } from "@nathapp/nax-ai";

import type { ProviderCatalogOverride } from "@/config/schema-types";
import { NaxError } from "@/errors";
import { naxCredentialStore } from "./credentials";
import { toProviderOverrides } from "./models";

/**
 * How nax names itself to a provider that reports on the calling application.
 *
 * nax-ai owns which vendor spells this in which header — OpenRouter reads
 * `HTTP-Referer` and `X-Title` into the `app_id`, `origin` and `http_referer`
 * fields of every generation record — and nax owns only the identity. Without
 * it, the sole identifying header on the wire is pi-ai's hardcoded
 * `User-Agent: pi (<platform> <release>; <arch>)`, which every pi-ai consumer
 * sends, so nax traffic cannot be told apart from anything else in the provider
 * account paying for it.
 *
 * A literal rather than a read of package.json: the bundle is built with
 * `bun build --target bun` and does not carry a package.json to read at
 * runtime. No version in the name — a display name that changed every release
 * would split one application into many rows on a provider's dashboard.
 */
const NAX_CLIENT_APP = { name: "nax", url: "https://github.com/nathapp-io/nax" } as const;

/**
 * The real builder. Exported on its own — not just as `_clientDeps.build` —
 * because test/preload.ts overwrites `_clientDeps.build` with a sentinel
 * before any test file loads (to stop a real client leaking into the
 * module-level cache across files), which would otherwise make this
 * synchronous, no-network construction path uncoverable by any test.
 */
export async function buildNativeClient(catalogOverrides: readonly ProviderCatalogOverride[] = []): Promise<Client> {
  return createClient({
    providers: await defaultProviders(),
    // The factory form, not the entries form: nax-ai has TWO catalogs — the
    // client's, which `model()` and `pricing()` read, and the protocol layer's,
    // which request-time resolution reads — and an override has to reach both.
    // Entries built without it reproduce #1982 exactly: the model resolves and
    // prices happily, then throws `Unknown model ... in the pi-ai catalog` on
    // the first real request. createClient hands the factory the array it was
    // constructed with, so the two sides cannot disagree — and nax-ai 0.1.11
    // rejects at construction a client whose entries never heard about an
    // override the client itself declared (nax-ai#36).
    protocols: ({ providerOverrides }) =>
      _clientDeps.defaultProtocols({
        // The credential seam: pi resolves the store first, then ambient sources
        // (env vars, AWS profiles, ADC), so a stored credential owns its provider
        // and CI with only an environment variable keeps working. Passing it here
        // is what makes `nax auth login` reach a run. This is the only inlet:
        // ClientOptions once carried a `credentials` field that createClient
        // never read, and nax-ai 0.1.4 removed it for exactly that reason.
        credentials: naxCredentialStore(),
        // Construction-time, like `credentials`: the identity is a constant of
        // the process, so nax-ai takes it here rather than on every request.
        clientApp: NAX_CLIENT_APP,
        providerOverrides,
      }),
    // nax-ai applies these last (`normaliseCatalog`), replacing any bundled
    // entry with the same id and lazily creating the provider bucket when the
    // id is unknown to pi-ai — that is what makes a model newer than the
    // snapshot resolvable (#1982). Omitted entirely when empty so the
    // no-override path stays byte-identical to before.
    ...(catalogOverrides.length > 0 ? { providerOverrides: toProviderOverrides(catalogOverrides) } : {}),
  });
}

/**
 * Test seam. `build` is replaced in tests so no catalog is loaded and no
 * network is reached. `defaultProtocols` is separately injectable so a test can
 * observe what buildNativeClient passes it (the credentials wiring above)
 * without loading the real catalog — see client.test.ts.
 */
export const _clientDeps = {
  build: buildNativeClient,
  defaultProtocols,
};

let cached: Promise<Client> | undefined;
/** Serialised override set the cached build was created for. */
let cachedOverridesKey: string | undefined;

export async function getNativeClient(catalogOverrides: readonly ProviderCatalogOverride[] = []): Promise<Client> {
  const overridesKey = JSON.stringify(catalogOverrides);
  if (cached !== undefined && overridesKey !== cachedOverridesKey) {
    // The client is a constant of the process (catalog load is ~50ms / ~650KB),
    // so overrides must be collected into ONE set before the first build. A
    // silent second build would swap the client under in-flight sessions.
    throw new NaxError(
      "The native client was already built for a different catalog-override set. " +
        "Collect every override into one agent.native.catalogOverrides list instead of varying them per call.",
      "NATIVE_CLIENT_OVERRIDES_MISMATCH",
      { builtFor: cachedOverridesKey, requested: overridesKey },
    );
  }
  if (cached === undefined) {
    cachedOverridesKey = overridesKey;
    // Cache the promise, not the value, so concurrent callers share one build.
    // Drop it on rejection: a failed catalog load should not be permanent.
    cached = _clientDeps.build(catalogOverrides).catch((err: unknown) => {
      cached = undefined;
      cachedOverridesKey = undefined;
      throw err;
    });
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetNativeClient(): void {
  cached = undefined;
  cachedOverridesKey = undefined;
}
