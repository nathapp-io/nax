import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";

export interface PostJsonDeps {
  fetch: typeof globalThis.fetch;
}

/** Default deps — injectable for tests. */
export const _postJsonDeps: PostJsonDeps = { fetch: globalThis.fetch };

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
      logger?.warn(opts.stage, "Telemetry POST returned non-2xx", { url, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger?.warn(opts.stage, "Telemetry POST failed", { url, error: errorMessage(err) });
    return false;
  }
}
