import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";

export interface PostJsonDeps {
  fetch: typeof globalThis.fetch;
}

/** Default deps — injectable for tests. */
export const _postJsonDeps: PostJsonDeps = { fetch: globalThis.fetch };

/**
 * Hex chars retained from the sha256 digest of the full URL — enough to
 * correlate repeated failures to one endpoint, too few to recover the secret.
 */
const URL_HASH_HEX_LENGTH = 12;
const REDACTED_ENDPOINT = "[REDACTED_ENDPOINT]";

/** Remove the configured endpoint from transport errors before they reach the logger. */
function redactEndpointFromError(error: unknown, url: string): string {
  return errorMessage(error).replaceAll(url, REDACTED_ENDPOINT);
}

/**
 * Log-safe descriptor for a webhook target.
 *
 * For Slack/Discord webhooks the URL path *is* the credential, so the full URL
 * must never reach the run log. The origin names the service and a short hash
 * of the full URL correlates repeated failures to the same endpoint without
 * carrying it. The digest is computed before parsing, so a malformed configured
 * URL still yields a hash and omits the origin rather than throwing out of the
 * error path.
 */
function describeEndpoint(url: string): { urlOrigin?: string; urlHash: string } {
  const urlHash = new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, URL_HASH_HEX_LENGTH);
  try {
    return { urlOrigin: new URL(url).origin, urlHash };
  } catch {
    return { urlHash };
  }
}

/**
 * POST `body` as JSON to `url` with a bounded timeout. Fire-and-forget:
 * non-2xx responses and thrown errors are logged at `warn` (under `stage`)
 * and swallowed — returns `true` only on a 2xx response. Resolved header
 * values are never logged.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: { headers: Record<string, string>; timeoutMs: number; stage: string; deps?: PostJsonDeps },
): Promise<boolean> {
  const deps = opts.deps ?? _postJsonDeps;
  const logger = getSafeLogger();
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      logger?.warn(opts.stage, "Telemetry POST returned non-2xx", {
        ...describeEndpoint(url),
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger?.warn(opts.stage, "Telemetry POST failed", {
      ...describeEndpoint(url),
      error: redactEndpointFromError(err, url),
    });
    return false;
  }
}
