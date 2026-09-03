/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * This is the seam that makes coding tools reachable at all. Callers reach it
 * through resolveCodingToolSupport() below, which is the single entry point
 * both dispatch hops use — see its comment for why that matters.
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
import { resolvePermissions } from "../config/permissions";
import type { AgentRunOptions } from "./types";

export interface CodingToolSupport {
  readonly runtime: CodingToolRuntime;
  readonly tools: readonly CodingTool[];
}

export function buildCodingToolSupport(args: {
  root?: string;
  grants?: readonly ToolGrant[];
  declared: readonly CodingToolName[];
  storyId?: string;
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

  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy(grants, args.root),
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
  });
  const tools = runtime.advertised(args.declared);
  if (tools.length === 0) return undefined;
  return { runtime, tools };
}

/**
 * Resolve coding-tool support for one dispatch, from the run options alone.
 *
 * nax-permission-mode-allow: delegates the decision to resolvePermissions();
 * decides nothing itself.
 *
 * Exists because the producer above had exactly one caller, in
 * `session/manager-run.ts` — a path `callOp` never takes. Both real hops
 * (`operations/build-hop-callback.ts`, `runtime/session-run-hop.ts`) call this
 * so the two cannot drift: a tool wired into one hop and not the other is
 * invisible until an operation happens to dispatch through the other.
 */
export function resolveCodingToolSupport(
  options: Pick<AgentRunOptions, "declaredTools" | "codingToolRoot" | "config" | "pipelineStage" | "storyId">,
): CodingToolSupport | undefined {
  const declared = options.declaredTools ?? [];
  if (declared.length === 0) return undefined;
  const resolved = resolvePermissions(options.config, options.pipelineStage ?? "run");
  return buildCodingToolSupport({
    root: options.codingToolRoot,
    grants: resolved.toolGrants,
    declared,
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
  });
}
