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
import { byCodePoint } from "@/utils/sort";
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
 * Options for `buildNativeClient`. Production callers leave this empty —
 * every field has a sensible nax-ai default. The seam exists so tests can
 * opt out of paths the production retry policy was never meant to exercise.
 */
export interface BuildNativeClientOptions {
  /**
   * Transport-fault retry budget (nax-ai's `ClientOptions.transportRetries`,
   * default 2). Tests that want a single attempt pass `0`; the production
   * 2-retry schedule sleeps through 250ms + 500ms of backoff on the first
   * thrown "Provider is not configured" / 5xx, which is most of the wall-clock
   * in tests that intentionally fail at the protocol boundary.
   */
  readonly transportRetries?: number;
}

/**
 * The real builder. Exported on its own — not just as `_clientDeps.build` —
 * because test/preload.ts overwrites `_clientDeps.build` with a sentinel
 * before any test file loads (to stop a real client leaking into the
 * module-level cache across files), which would otherwise make this
 * synchronous, no-network construction path uncoverable by any test.
 */
export async function buildNativeClient(
  catalogOverrides: readonly ProviderCatalogOverride[] = [],
  options: BuildNativeClientOptions = {},
): Promise<Client> {
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
    // nax-ai defaults `transportRetries` to 2 (250ms + 500ms backoff).
    // Passed through verbatim when the caller asks, omitted when it doesn't,
    // so the production path stays byte-identical to before this seam.
    ...(options.transportRetries !== undefined ? { transportRetries: options.transportRetries } : {}),
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

/**
 * Recursively rebuild plain objects with keys sorted by code point. Array
 * order is preserved — model lists keep their declared order because nax-ai
 * replaces entries by id and a duplicate id is last-wins. Built with
 * `Object.fromEntries` (not key assignment) so a header literally named
 * `__proto__` survives as an own property instead of being swallowed by the
 * prototype setter.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => byCodePoint(a, b))
        .map(([key, val]): [string, unknown] => [key, canonicalise(val)]),
    );
  }
  return value;
}

/**
 * Deterministic serialisation of an override set (nax#2025): overrides sorted
 * by provider and object keys sorted by code point (`byCodePoint`, per CTX-5 —
 * the ordering feeds both the cache key and the digest, so it must be stable
 * across locales and ICU versions), so two sets that differ only in listing
 * order or header key order — semantically identical on the nax-ai side —
 * serialise identically. Two overrides with the SAME provider keep their
 * declared order: duplicate providers are last-wins by design, so their
 * relative order is part of the semantics.
 */
function canonicalOverrideKey(overrides: readonly ProviderCatalogOverride[]): string {
  const sorted = [...overrides].sort((a, b) => byCodePoint(a.provider, b.provider));
  return JSON.stringify(canonicalise(sorted));
}

/** Hex prefix length of the set digest used in error summaries. */
const DIGEST_LENGTH = 12;

/**
 * Secret-free summary of an override set for error context: provider names,
 * header key NAMES (never values — an `Authorization` header is a credential,
 * nax#2025), and a digest of the canonical key so sets that differ only in
 * redacted material stay distinguishable.
 *
 * The digest is an IDENTIFIER, not a security boundary: it hashes the raw
 * canonical key, so it must only ever appear next to the sanitised summary —
 * never logged beside the redacted-but-inferable override set.
 */
function summariseOverrides(overrides: readonly ProviderCatalogOverride[]): {
  providers: string[];
  headerKeys: string[];
  digest: string;
} {
  return {
    providers: overrides.map((o) => o.provider).sort(),
    headerKeys: [...new Set(overrides.flatMap((o) => Object.keys(o.headers ?? {})))].sort(),
    digest: new Bun.CryptoHasher("sha256")
      .update(canonicalOverrideKey(overrides))
      .digest("hex")
      .slice(0, DIGEST_LENGTH),
  };
}

let cached: Promise<Client> | undefined;
/** Override set the cached build was created for — kept for secret-free summarising. */
let cachedOverrides: readonly ProviderCatalogOverride[] | undefined;
/** Serialised override set the cached build was created for. */
let cachedOverridesKey: string | undefined;

export async function getNativeClient(catalogOverrides: readonly ProviderCatalogOverride[] = []): Promise<Client> {
  const overridesKey = canonicalOverrideKey(catalogOverrides);
  if (cached !== undefined && overridesKey !== cachedOverridesKey) {
    // The client is a constant of the process (catalog load is ~50ms / ~650KB),
    // so overrides must be collected into ONE set before the first build. A
    // silent second build would swap the client under in-flight sessions.
    throw new NaxError(
      "The native client was already built for a different catalog-override set. " +
        "Collect every override into one agent.native.catalogOverrides list instead of varying them per call.",
      "NATIVE_CLIENT_OVERRIDES_MISMATCH",
      { builtFor: summariseOverrides(cachedOverrides ?? []), requested: summariseOverrides(catalogOverrides) },
    );
  }
  if (cached === undefined) {
    // Shallow copy: the caller's array may later be mutated (e.g. a push), which
    // would mislabel `builtFor` — the summary must describe the set that was built.
    cachedOverrides = [...catalogOverrides];
    cachedOverridesKey = overridesKey;
    // Cache the promise, not the value, so concurrent callers share one build.
    // Drop it on rejection: a failed catalog load should not be permanent.
    cached = _clientDeps.build(catalogOverrides).catch((err: unknown) => {
      cached = undefined;
      cachedOverrides = undefined;
      cachedOverridesKey = undefined;
      throw err;
    });
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetNativeClient(): void {
  cached = undefined;
  cachedOverrides = undefined;
  cachedOverridesKey = undefined;
}
