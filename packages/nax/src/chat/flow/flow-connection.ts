/**
 * flow-connection.ts — the koda connection a flow is sent through.
 *
 * The connection is the one nax already has for koda: `memory.koda.url` (koda's API
 * root including its `/api` prefix) and `memory.koda.headers` (the literal
 * `Authorization: Bearer <agent key>` header). Both keys are global-only
 * (`KODA_GLOBAL_ONLY_KEYS`), so a repository's `.nax/config.json` cannot point the
 * agent key at another server, and `koda-http.ts` redacts the header values from
 * every error it builds.
 *
 * Presence is exactly what `createKodaClient` needs: a url and an `authorization`
 * header with a non-blank value, matched case-insensitively because HTTP header
 * names are. `memory.enabled`, `memory.provider` and `memory.koda.project` play no
 * part — koda resolves the repository from the remote URL it is sent.
 */
import { memoryConfigOf, type NaxConfig } from "@/config";

/** What a koda request needs: the API root and the headers that carry the agent key. */
export interface KodaFlowConnection {
  /** koda's API root, including its global prefix (e.g. `https://koda.example/api`). */
  readonly url: string;
  /** The configured headers, the bearer agent key included — never logged, never echoed. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The header name the connection requires, matched case-insensitively like HTTP itself. */
const AUTHORIZATION_HEADER = "authorization";

/**
 * The configured headers with HTTP's case-insensitive names folded to lowercase and
 * the last value winning — exactly the fold `createKodaClient` applies before it
 * sends them. Deciding presence any other way would answer a different question from
 * the one the request answers: a block holding `Authorization: Bearer k` and then
 * `authorization: ""` reaches koda with an empty credential, so it must read as no
 * connection here rather than as a usable one that fails only after the push.
 *
 * `headers` is typed optional here on purpose: `MemoryKodaConfig.headers` is
 * required by the interface but a `NaxConfig` assembled without the schema (a test
 * override, a hand-written partial) can leave it out at runtime.
 */
function foldedHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const folded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) folded[name.toLowerCase()] = value;
  return folded;
}

/** Whether the folded `authorization` value can authenticate a request: present and not blank. */
function hasAuthorization(folded: Readonly<Record<string, string>>): boolean {
  const value = folded[AUTHORIZATION_HEADER];
  return value !== undefined && value.trim().length > 0;
}

/**
 * The koda connection a flow is sent through, or `undefined` when nax has none —
 * in which case the `nax-flow` provider is not offered to the chat brain at all.
 *
 * A blank `memory.koda.url` counts as unset: the schema already rejects one, so
 * reaching that arm means the load was bypassed, and a request to no host cannot
 * work either.
 *
 * @param config - The loaded nax config; `memory` is read through `memoryConfigOf`
 */
export function kodaFlowConnection(config: Pick<NaxConfig, "memory">): KodaFlowConnection | undefined {
  const koda = memoryConfigOf(config).koda;
  const url = koda?.url;
  if (url === undefined || url.trim().length === 0) return undefined;
  const headers = koda?.headers;
  if (!hasAuthorization(foldedHeaders(headers))) return undefined;
  return { url, headers: headers ?? {} };
}
