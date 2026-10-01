/**
 * Post-parse verify/recover for `callOp`.
 *
 * Split out of call.ts, which sits exactly on the 600-line source limit: this is the one
 * self-contained concern in it — it runs after `op.parse`, reads only `verify`/`recover`
 * off the operation, and shares no state with the dispatch path.
 */

import type { BuildContext, CompleteOperation, RunOperation, VerifyContext } from "./types";

export function makeVerifyCtx<C>(buildCtx: BuildContext<C>): VerifyContext<C> {
  return {
    packageView: buildCtx.packageView,
    config: buildCtx.config,
    readFile: async (p) => {
      try {
        return await Bun.file(p).text();
      } catch {
        return null;
      }
    },
    fileExists: async (p) => Bun.file(p).exists(),
  };
}

export async function runPostParse<I, O, C>(
  op: RunOperation<I, O, C> | CompleteOperation<I, O, C>,
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  if (!op.verify && !op.recover) return parsed;

  const verifyCtx = makeVerifyCtx(buildCtx);

  let final: O | null = parsed;

  if (op.verify) {
    final = await op.verify(parsed, input, verifyCtx);
  }

  if (final === null && op.recover) {
    final = await op.recover(input, verifyCtx);
  }

  return (final ?? parsed) as O;
}

/**
 * Exported for unit testing only — exercises runPostParse without a full callOp setup.
 * Accepts a structural subtype of Operation (only verify/recover needed) and casts
 * internally. Safe because runPostParse only reads verify and recover from op.
 */
export async function _runPostParseForTest<I, O, C>(
  op: {
    readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;
    readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
  },
  parsed: O,
  input: I,
  buildCtx: BuildContext<C>,
): Promise<O> {
  return runPostParse(op as unknown as RunOperation<I, O, C> | CompleteOperation<I, O, C>, parsed, input, buildCtx);
}
