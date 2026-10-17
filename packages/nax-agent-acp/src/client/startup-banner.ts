/**
 * An agent's startup banner (nax#2591). pi-acp answers session/new with
 * `_meta.piAcp.startupInfo` and then sends that same text as one message chunk,
 * which lands in the session's first turn. The collector drops a chunk of exactly
 * this text, so the banner is never mistaken for the agent's reply. The answer
 * is agent data: anything but a non-empty string is no banner.
 */
import { isRecord } from "#src/client/text";

export function startupBannerOf(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response._meta)) return undefined;
  const pi = response._meta.piAcp;
  if (!isRecord(pi)) return undefined;
  return typeof pi.startupInfo === "string" && pi.startupInfo !== "" ? pi.startupInfo : undefined;
}
