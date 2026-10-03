/**
 * Shell interception seam: a string a provider may rewrite, validated before
 * nax hands it to `/bin/sh`.
 *
 * Unlike the argv site, this command is MODEL-AUTHORED and comes back out of a
 * provider subprocess, so the provider's answer is a proposal, not a fact. The
 * validator accepts a candidate only when it is the original plus literal `rtk `
 * insertions at command words, byte for byte (rules 1-6 in `validateShellRewrite`);
 * everything else declines and the original runs.
 *
 * `CommandInterceptor` is imported type-only: the barrel re-exports this file, so
 * a value edge back into it would close a runtime import cycle.
 */
import type { BashSegment, BashToken } from "#src/permissions/index";
import { lexBashCommand } from "#src/permissions/index";
import type { CommandInterceptor } from "./index.ts";

export interface ShellInterceptRequest {
  readonly kind: "shell";
  readonly command: string;
  readonly cwd: string;
  readonly site: "bash";
}

export type ShellInterceptResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly command: string; readonly provider: string }
  | { readonly kind: "declined"; readonly reason: string };

export interface ShellInterceptOutcome {
  /** What to execute: the original, or the validated rewrite. */
  readonly command: string;
  readonly provider?: string;
  readonly rewritten: boolean;
}

/** The four bytes an accepted rewrite may add, once or many times. */
const INSERTION = "rtk ";

/** A leading `NAME=value` assignment, which precedes (and is not) the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function decline(reason: string): ShellInterceptResult {
  return { kind: "declined", reason };
}

/**
 * Rule 1: walk the original and the candidate together. The only legal
 * divergence is the candidate holding `rtk ` while the original still has a
 * character to offer; any other difference, and any insertion trailing the
 * original's last character, is refused. Returns the insertion count, or -1.
 */
function countInsertions(original: string, candidate: string): number {
  let i = 0;
  let j = 0;
  let insertions = 0;
  while (j < candidate.length) {
    if (i < original.length && original[i] === candidate[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (i < original.length && candidate.startsWith(INSERTION, j)) {
      insertions += 1;
      j += INSERTION.length;
      continue;
    }
    return -1;
  }
  return i === original.length ? insertions : -1;
}

/** Rule 4's index: the command word follows the leading assignments, if any. */
function leadingAssignments(tokens: readonly BashToken[]): number {
  let k = 0;
  while (k < tokens.length && ASSIGNMENT.test(tokens[k].text)) k += 1;
  return k;
}

type SegmentRewrite = "equal" | "inserted" | "invalid";

/**
 * Rules 4 and 5 for one segment: its tokens either match the original's, or
 * match them with a single `rtk` inserted at the command word — and a segment
 * already prefixed with `rtk` is left alone.
 */
function classifySegment(original: BashSegment, candidate: BashSegment): SegmentRewrite {
  const before = original.tokens;
  const after = candidate.tokens;

  if (before.length === after.length) {
    for (let i = 0; i < before.length; i += 1) {
      if (before[i].text !== after[i].text) return "invalid";
    }
    return "equal";
  }
  if (after.length !== before.length + 1) return "invalid";

  const k = leadingAssignments(before);
  const inserted = after[k];
  if (inserted.text !== "rtk" || inserted.opaque) return "invalid";
  if (before[k]?.text === "rtk") return "invalid";
  for (let i = 0; i < k; i += 1) {
    if (before[i].text !== after[i].text) return "invalid";
  }
  for (let i = k; i < before.length; i += 1) {
    if (before[i].text !== after[i + 1].text) return "invalid";
  }
  return "inserted";
}

/**
 * Rule 6: a segment whose own separator is `|` writes into a pipe, and one
 * whose predecessor's separator is `|` reads from it. Compaction would change
 * what the neighbouring program sees, so neither is rewritten.
 */
function inPipeline(segments: readonly BashSegment[], index: number): boolean {
  return segments[index].separator === "|" || segments[index - 1]?.separator === "|";
}

/**
 * Accepts a rewrite only if it is the original plus `rtk ` insertions at command
 * words. The provider's own answer is never trusted: every rule below is checked
 * against the byte-exact candidate, and the first failure names why.
 */
export function validateShellRewrite(req: ShellInterceptRequest, result: ShellInterceptResult): ShellInterceptResult {
  if (result.kind !== "rewritten") return result;

  const insertions = countInsertions(req.command, result.command);
  if (insertions < 0) return decline("candidate is not the original plus `rtk ` insertions");
  if (insertions === 0) return { kind: "unchanged" };

  const before = lexBashCommand(req.command);
  const after = lexBashCommand(result.command);
  if (before.kind !== "ok" || after.kind !== "ok") return decline("original or candidate does not lex");
  if (before.segments.length !== after.segments.length) return decline("candidate changed the segment count");

  let inserted = 0;
  for (let i = 0; i < before.segments.length; i += 1) {
    const rewrite = classifySegment(before.segments[i], after.segments[i]);
    if (rewrite === "invalid") return decline(`segment ${i} is not the original plus an rtk command word`);
    if (rewrite === "inserted") {
      if (inPipeline(before.segments, i)) return decline("a rewritten segment would change what a pipe reads");
      inserted += 1;
    }
  }
  if (inserted !== insertions) return decline("insertions do not line up with commands");

  return { kind: "rewritten", command: result.command, provider: result.provider };
}

/**
 * The seam, one line at the call site.
 *
 * Fails open at REWRITE time only (R3): no interceptor, no shell method, a
 * throw or a failed validation all run the original command unchanged.
 */
export async function interceptShell(
  command: string,
  cwd: string,
  interceptor: CommandInterceptor | undefined,
): Promise<ShellInterceptOutcome> {
  if (interceptor === undefined || interceptor.interceptShell === undefined) {
    return { command, rewritten: false };
  }

  const req: ShellInterceptRequest = { kind: "shell", command, cwd, site: "bash" };
  let outcome: ShellInterceptResult;
  try {
    outcome = validateShellRewrite(req, await interceptor.interceptShell(req));
  } catch {
    outcome = decline("interceptor threw");
  }
  if (outcome.kind !== "rewritten") return { command, rewritten: false };
  return { command: outcome.command, provider: outcome.provider, rewritten: true };
}
