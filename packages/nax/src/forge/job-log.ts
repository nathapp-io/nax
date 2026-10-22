/** Whole-job log reads and sanitization shared by CI excerpts and forge tools. */
import { redactSecrets } from "@/logger";
import { encodeProjectPath } from "./pr-read";
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

export type JobLogRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export const CI_ANNOTATION_LINES = 20;
export const CI_ANNOTATION_CHARS = 2_000;
/** Shared cap for CI excerpts and unavailable-log reasons. */
export const CI_EXCERPT_CHARS = 8_000;
const ESCAPE_FLAG = "--allow-escape-sequences";

/** ANSI CSI sequences: ESC `[`, parameter and intermediate bytes, one final byte. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC control bytes removes ANSI colour codes
const ANSI_CSI = /\u001b\[[\x20-\x3f]*[\x40-\x7e]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

/** Sanitize before bounding so a cut cannot conceal a credential's delimiter. */
function failureReason(stderr: string): string {
  const firstLine =
    stripAnsi(stderr)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "unknown";
  return redactSecrets(firstLine).slice(0, CI_EXCERPT_CHARS);
}

/** Read a whole job through its API, using the forge's default subprocess timeout. */
export async function readJobLog(ref: PrRef, checkId: string, deps: ForgeDeps, cwd: string): Promise<JobLogRead> {
  const cmd =
    ref.forge === "github"
      ? ["gh", "api", ESCAPE_FLAG, "--hostname", ref.host, `repos/${ref.repo}/actions/jobs/${checkId}/logs`]
      : ["glab", "api", "--hostname", ref.host, `projects/${encodeProjectPath(ref.repo)}/jobs/${checkId}/trace`];
  let result = await deps.run(cmd, { cwd });
  // Older gh versions lack this flag. Retry only that compatibility error, once.
  if (
    ref.forge === "github" &&
    result.exitCode !== 0 &&
    /unknown flag:\s*--allow-escape-sequences\b/i.test(stripAnsi(result.stderr))
  ) {
    result = await deps.run(
      cmd.filter((arg) => arg !== ESCAPE_FLAG),
      { cwd },
    );
  }
  return result.exitCode === 0
    ? { ok: true, text: redactSecrets(stripAnsi(result.stdout.replace(/^\uFEFF/, ""))) }
    : { ok: false, reason: failureReason(result.stderr) };
}
