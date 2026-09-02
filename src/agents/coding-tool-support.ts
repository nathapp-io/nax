/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * This is the seam that makes coding tools reachable at all. It is deliberately
 * one small function with one caller, so "nothing ever supplied it" is a
 * compile-visible question rather than a silent runtime absence.
 */

import { NaxError } from "@/errors";
import {
  type CodingTool,
  type CodingToolName,
  type CodingToolRuntime,
  compileToolPolicy,
  createCodingToolRuntime,
  type ToolGrant,
} from "@/tools";

export interface CodingToolSupport {
  readonly runtime: CodingToolRuntime;
  readonly tools: readonly CodingTool[];
}

export function buildCodingToolSupport(args: {
  root?: string;
  grants?: readonly ToolGrant[];
  declared: readonly CodingToolName[];
}): CodingToolSupport | undefined {
  if (args.declared.length === 0) return undefined;
  const grants = args.grants ?? [];
  if (grants.length === 0) return undefined;

  // An empty root passed to a spawn or a path join silently means
  // process.cwd() — the directory nax was launched from, which under `-d` is a
  // different repository. That is the #1794 defect; refuse instead. Callers
  // pass packageWorkdir(view), which never yields "".
  if (args.root === undefined || args.root.trim() === "") {
    throw new NaxError(
      "Cannot enable coding tools: no working directory was supplied, so the permitted root is unknown.",
      "CODING_TOOL_ROOT_MISSING",
      { stage: "tools" },
    );
  }

  const runtime = createCodingToolRuntime({ policy: compileToolPolicy(grants, args.root) });
  const tools = runtime.advertised(args.declared);
  if (tools.length === 0) return undefined;
  return { runtime, tools };
}
