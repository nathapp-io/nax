import { NaxError } from "@/errors";
import type { PrRef } from "./pr-types";
import type { ForgeRunResult } from "./types";

export function readError(what: string, result: ForgeRunResult, cause?: unknown): NaxError {
  return new NaxError(`[forge] Cannot read ${what}: ${result.stderr.trim()}`, "FORGE_RESPONSE_UNPARSEABLE", {
    stage: "forge",
    stderr: result.stderr,
    cause,
  });
}

export function parseReply(what: string, result: ForgeRunResult): Record<string, unknown> {
  let reply: unknown;
  try {
    reply = JSON.parse(result.stdout);
  } catch (cause) {
    throw readError(what, result, cause);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw readError(what, result);
  return reply as Record<string, unknown>;
}

export function api(ref: PrRef, endpoint: string): string[] {
  return [ref.forge === "github" ? "gh" : "glab", "api", "--hostname", ref.host, endpoint];
}
