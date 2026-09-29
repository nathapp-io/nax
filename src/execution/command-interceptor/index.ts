/**
 * Generic command-interception seam. rtk is a consumer, not a concept here (R1).
 *
 * Two request shapes, one per site: `argv` for the Git tool, validated by
 * `validateRewrite` below, and `shell` for the model-authored Bash string,
 * validated by `validateShellRewrite` in `./shell`. R10 keeps config-supplied
 * command strings out of both.
 */
import { GIT_ESCAPE_FLAGS } from "@/tools/git-flags";
import type { ShellInterceptRequest, ShellInterceptResult } from "./shell";

/** Two members: the Git argv site and the Bash shell site (R10). */
export type Site = "git" | "bash";

export interface InterceptRequest {
  readonly kind: "argv";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly site: Site;
}

export type InterceptResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly argv: readonly string[]; readonly provider: string }
  | { readonly kind: "declined"; readonly reason: string };

export interface CommandInterceptor {
  readonly provider: string;
  intercept(req: InterceptRequest): Promise<InterceptResult>;
  /** The Bash site's entry point. Absent on an argv-only interceptor. */
  interceptShell?(req: ShellInterceptRequest): Promise<ShellInterceptResult>;
  /** Consulted ONLY for output of a command this interceptor actually rewrote. */
  postProcess?(
    output: string,
    req: InterceptRequest | ShellInterceptRequest,
  ): { output: string; notes?: Record<string, string> };
}

export interface InterceptOutcome {
  readonly argv: readonly string[];
  readonly executed?: readonly string[];
  readonly provider?: string;
  readonly rewritten: boolean;
}

function decline(reason: string): InterceptResult {
  return { kind: "declined", reason };
}

/**
 * A rewrite may do exactly one thing: prefix the original argv with the
 * provider's own binary name. Anything else is refused.
 *
 * The argv analogue of R9's shell narrowing, and far tighter because it can be:
 * the mapping is static and built by nax, never a string parsed back out of a
 * subprocess.
 */
export function validateRewrite(req: InterceptRequest, result: InterceptResult): InterceptResult {
  if (result.kind !== "rewritten") return result;

  const { argv, provider } = result;
  if (argv.length !== req.argv.length + 1) return decline("rewrite must add exactly one leading token");
  if (argv[0] !== provider) return decline(`rewrite must lead with the provider binary, got ${argv[0]}`);
  for (const [i, token] of req.argv.entries()) {
    if (argv[i + 1] !== token) return decline(`rewrite altered token ${i}`);
  }
  if (argv.some((token) => GIT_ESCAPE_FLAGS.includes(token))) return decline("argv carries a git escape flag");
  return result;
}

/**
 * The whole seam, so call sites stay one line (see the file-size gate).
 *
 * Fails open at REWRITE time only (R3): if the interceptor is sick we run the
 * original. A rewritten command that actually RAN and failed keeps its exit
 * code — nax never re-runs raw to disambiguate one, because that makes
 * execution non-idempotent and can cost a full test-suite run.
 */
export async function interceptArgv(
  argv: readonly string[],
  cwd: string,
  interceptor: CommandInterceptor | undefined,
): Promise<InterceptOutcome> {
  if (interceptor === undefined) return { argv, rewritten: false };

  const req: InterceptRequest = { kind: "argv", argv, cwd, site: "git" };
  let outcome: InterceptResult;
  try {
    outcome = validateRewrite(req, await interceptor.intercept(req));
  } catch {
    outcome = decline("interceptor threw");
  }
  if (outcome.kind !== "rewritten") return { argv, rewritten: false };
  return { argv: outcome.argv, executed: outcome.argv, provider: outcome.provider, rewritten: true };
}

export * from "./shell";
