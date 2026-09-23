/**
 * The Bash branch of the tool policy, extracted from `policy.ts` to keep that
 * file under its 600-line source limit. `src/` reaches this module only
 * through `policy.ts`, so the barrel surface is unchanged.
 *
 * The Bash branch. Checked in policy-bash.ts, or policy-bash-raw.ts under the
 * `raw` mode, and never falling through: a command string is not a verb and
 * not a path, so neither of the other branches can judge it. Containment is
 * handed over as a callback because policy.ts imports this module, so
 * reaching `resolveWithin` back would close a cycle.
 */

import type { BashApprovalMode } from "@/config/bash-approval";
import { checkBashCommand } from "./policy-bash";
import { screenRawBashCommand } from "./policy-bash-raw";
import type { CompiledEntry } from "./policy-match";
import type { PolicyVerdict, ToolScope } from "./types";

export interface BashCommandBranchArgs {
  readonly tool: string;
  readonly scope: ToolScope;
  readonly input: Record<string, unknown>;
  readonly grant: CompiledEntry;
  readonly bashApproval: BashApprovalMode;
  /** P4: when set, the enabled sandbox is unavailable and `raw` denies every call (spec S5). */
  readonly rawBashRefusal?: string;
  readonly resolvedRoot: string;
  readonly denyBy: ReadonlyMap<string, CompiledEntry>;
  readonly askBy: ReadonlyMap<string, CompiledEntry>;
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  readonly deny: (reason: string, breach?: boolean, escalatable?: boolean) => PolicyVerdict;
  readonly askVerdict: (resolvedPaths: readonly string[], rule: string) => PolicyVerdict;
}

export function commandBranch(args: BashCommandBranchArgs): PolicyVerdict | undefined {
  const {
    tool,
    scope,
    input,
    grant,
    bashApproval,
    rawBashRefusal,
    resolvedRoot,
    denyBy,
    askBy,
    resolvePath,
    deny,
    askVerdict,
  } = args;
  if (scope.commandField === undefined) return undefined;

  if (bashApproval === "raw") {
    if (rawBashRefusal !== undefined) return deny(rawBashRefusal, false, false);
    const screened = screenRawBashCommand({
      tool,
      command: input[scope.commandField],
      initialPath: resolvedRoot,
      root: resolvedRoot,
      resolvePath,
    });
    if (screened.kind === "deny") return deny(screened.reason, screened.breach, screened.escalatable);
    return { allowed: true, resolvedPaths: [] };
  }

  const denyEntry = denyBy.get(tool);
  const askEntry = askBy.get(tool);
  const result = checkBashCommand({
    tool,
    command: input[scope.commandField],
    grant,
    ...(denyEntry !== undefined ? { denyEntry } : {}),
    ...(askEntry !== undefined ? { askEntry } : {}),
    initialPath: resolvedRoot,
    resolvePath,
  });
  if (result.kind === "deny") {
    // `escalate` converts only a denial the gate could not ADJUDICATE. A
    // breach, a denied flag or an explicit deny rule stays a hard refusal:
    // escalating those would dissolve the `breach` signal into an approval
    // prompt. See ADR-030 and the two escalatable sites in policy-bash.ts.
    if (bashApproval === "escalate" && result.escalatable) {
      // NOT `askVerdict(...)`: that helper REWRITES reason as
      // `matched ask rule "<rule>"`, which is false here — no ask rule
      // matched. Build the verdict directly so the original denial reason
      // survives into the ledger and into the human prompt. `rule` is
      // omitted; `runtime.ts` falls back to `verdict.reason`.
      return { allowed: false, reason: result.reason, breach: false, outcome: "ask", resolvedPaths: [] };
    }
    return deny(result.reason, result.breach, result.escalatable);
  }
  if (result.kind === "ask") return askVerdict([], result.rule);
  return { allowed: true, resolvedPaths: [] };
}
