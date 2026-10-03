/**
 * `callTool`'s branch bodies, extracted from `runtime.ts` for the A13
 * complexity drain (docs/plans/STATUS-complexity-drain.md).
 *
 * Each helper is one free function taking a single options object; the
 * closure-bound collaborators (`logCall`, `runTool`, the session-wide
 * `signal`) arrive BY REFERENCE and are read at call time, so the
 * `_codingToolDeps` seam stays defined in `runtime.ts` exactly as the barrel
 * (`src/tools/index.ts`) re-exports it. This file imports `runtime.ts`
 * TYPE-ONLY — a runtime import would cycle back to the factory.
 *
 * One asymmetry is preserved on purpose: the denial-path breach warn below and the
 * rejected-guard warn (US-004) call the module-level `getSafeLogger` import
 * directly, while the ledger `log` in `runtime.ts` reads
 * `_codingToolDeps.getLogger()`. Both behaved that way before the extraction;
 * the seam stub in the mirror suites has never covered either warn.
 */

import { randomUUID } from "node:crypto";
import { type CommandGuard, type CommandShadow, openShadowTap } from "#src/command-safety/index";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { ASK_CANCELLED_REASON, type AskControl, type AskResolver, type AskVerdict } from "#src/permissions/index";
import type { SandboxRecord } from "../sandbox/index.ts";
import { askDenyReason, askSummary } from "./ask-request.ts";
import { redirectForArgv, redirectForCommand, redirectForVerb } from "./denial-redirect.ts";
import type { CodingTool } from "./registry.ts";
import type { CodingToolOutcome, ToolCallContext } from "./runtime.ts";
import { BASH_TOOL_NAME, EXEC_TOOL_NAME, type ToolPolicy } from "./types.ts";

type PolicyVerdict = ReturnType<ToolPolicy["check"]>;

/** The verdict shape the ask and deny branches see: the policy said no. */
type DeniedVerdict = Extract<PolicyVerdict, { allowed: false }>;

/** Per-call audit data a tool's result carries into the ledger. */
export interface CallAudit {
  executed?: readonly string[];
  target?: "package" | "repoRoot";
  /** Exec only: forwarded to the command shadow; never written to the ledger. */
  cwd?: string;
  approval?: { decidedBy: string; remembered: boolean; latencyMs: number };
  sandbox?: SandboxRecord;
  exitCode?: number;
}

/** The per-call log wrapper `callTool` builds; settles the shadow tap too. */
export type LogCallFn = (
  tool: string,
  outcome: CodingToolOutcome["kind"] | "denied:ask",
  resultBytes: number,
  input: Record<string, unknown>,
  context: ToolCallContext | undefined,
  breach?: boolean,
  reason?: string,
  routineErrors?: boolean,
  audit?: CallAudit,
  resultBytesPreTruncation?: number,
) => void;

/** Executes a permitted call and records its outcome. */
export type RunToolFn = (
  target: CodingTool,
  callInput: Record<string, unknown>,
  resolvedPaths: readonly string[],
  approval?: { decidedBy: string; remembered: boolean; latencyMs: number },
) => Promise<CodingToolOutcome>;

type Approval = { decidedBy: string; remembered: boolean; latencyMs: number };

export interface PolicyIdentity {
  readonly policyIdentity: string;
  readonly argvField: string | undefined;
  readonly hasArgv: boolean;
}

/**
 * A call carrying the tool's declared argv field (RunCommand's `Exec`
 * branch) is checked, and ledgered, under the `Exec` identity rather
 * than the tool's own name. Left as `name`, an `Exec(...)` grant would
 * never be consulted — the call would run under RunCommand's own grant
 * (often a wildcard for its declared commands), making the allowlist
 * decorative. The tool's registered name is unaffected; this changes
 * only which identity the policy and ledger see for THIS call.
 */
export function resolvePolicyIdentity(name: string, tool: CodingTool, input: Record<string, unknown>): PolicyIdentity {
  const argvField = tool.scope.argvField;
  const hasArgv = argvField !== undefined && input[argvField] !== undefined;
  const policyIdentity = hasArgv ? EXEC_TOOL_NAME : name;
  return { policyIdentity, argvField, hasArgv };
}

/**
 * P5: observe the command now (not awaited), settled from the caller's
 * logCall below. Undefined whenever the runtime has no shadow configured.
 */
export function openCallShadowTap(p: {
  shadow: CommandShadow | undefined;
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  hasArgv: boolean;
  argvField: string | undefined;
  root: string;
  stage: string | undefined;
  storyId: string | undefined;
  callId: string | undefined;
  scopeId: string | undefined;
  context: ToolCallContext | undefined;
  verdict: PolicyVerdict;
}): ReturnType<typeof openShadowTap> | undefined {
  if (p.shadow === undefined) return undefined;
  return openShadowTap(p.shadow, {
    key: randomUUID(),
    identity: p.identity,
    command: p.tool.scope.commandField === undefined ? undefined : p.input[p.tool.scope.commandField],
    argv: p.hasArgv && p.argvField !== undefined ? p.input[p.argvField] : undefined,
    root: p.root,
    verdict: p.verdict,
    stage: p.stage ?? "unknown",
    ...(p.storyId !== undefined ? { storyId: p.storyId } : {}),
    ...(p.callId !== undefined ? { callId: p.callId } : {}),
    ...(p.scopeId !== undefined ? { scopeId: p.scopeId } : {}),
    ...(p.context?.turnId !== undefined ? { turnId: p.context.turnId } : {}),
    ...(p.context?.roundTrips !== undefined ? { roundTrips: p.context.roundTrips } : {}),
    ...(p.context?.toolCallId !== undefined ? { toolCallId: p.context.toolCallId } : {}),
  });
}

/**
 * The command string the guard assesses, or undefined for an identity the
 * guard does not cover. `Bash` reports its `command` field; `Exec` — the
 * identity a `RunCommand` call carrying `argv` resolves to — reports the argv
 * joined with single spaces, exactly the string the shadow observes and
 * classifies. Any other identity (and a malformed command / argv) is not
 * guarded; the policy has already refused that input.
 */
function guardCommand(p: {
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  argvField: string | undefined;
}): string | undefined {
  if (p.identity === BASH_TOOL_NAME) {
    const field = p.tool.scope.commandField;
    const value = field === undefined ? undefined : p.input[field];
    return typeof value === "string" ? value : undefined;
  }
  if (p.identity !== EXEC_TOOL_NAME || p.argvField === undefined) return undefined;
  const argv = p.input[p.argvField];
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) return undefined;
  return argv.join(" ");
}

/**
 * US-004: the guard's flag-for-review route for an ALLOWED command.
 *
 * Returns the ask-shaped denial the flagged call routes through
 * `resolveAskOutcome`, and undefined in every other case — no guard
 * configured, an identity other than `Bash`/`Exec`, or an unflagged
 * assessment — so the caller runs the tool exactly as it did before the guard
 * existed. The guard is total by contract (US-003); a rejection, or a resolved
 * decision the type does not actually hold, means that contract broke, so the
 * call runs unguarded rather than being refused, and the failure is logged once
 * per broken call.
 */
export async function resolveGuardDenial(p: {
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  argvField: string | undefined;
  guard: CommandGuard | undefined;
  root: string;
  tempConfined: boolean;
  resolvedPaths: readonly string[];
}): Promise<DeniedVerdict | undefined> {
  const { guard } = p;
  if (guard === undefined) return undefined;
  const command = guardCommand(p);
  if (command === undefined) return undefined;
  // The whole decision — the assessment AND reading its fields — sits inside
  // the fail-open try: the guard is total by contract, so anything that
  // escapes here means the contract broke, including a resolved decision whose
  // `score`/`threshold` is not the number the type promises. Both fail the
  // same way: the call runs unguarded rather than erroring out of callTool.
  try {
    const decision = await guard.assess({ command, cwd: p.root, tempConfined: p.tempConfined });
    if (!decision.flagged) return undefined;
    const { category, score, threshold } = decision;
    return {
      allowed: false,
      outcome: "ask",
      breach: false,
      rule: "command-safety",
      reason: `flagged for review by command safety: ${category ?? "blocked"} (score ${score.toFixed(2)} >= ${threshold})`,
      resolvedPaths: p.resolvedPaths,
    };
  } catch (err) {
    getSafeLogger()?.warn("command-safety", "Command-safety guard failed; the call runs unguarded", {
      error: errorMessage(err),
    });
    return undefined;
  }
}

/**
 * The ask branch: a call the policy gates matched an ask rule, so an
 * AskResolver decides. US-003: build the AskControl from the per-call
 * context. The turn's abort signal is forwarded verbatim, and onWaiting is
 * wired so the resolver can tell the turn loop a human prompt is pending.
 */
export async function resolveAskOutcome(p: {
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  context: ToolCallContext | undefined;
  verdict: DeniedVerdict;
  /** The runtime-level signal, falling back behind the per-call one. */
  runtimeSignal: AbortSignal | undefined;
  askResolver: AskResolver;
  stage: string | undefined;
  storyId: string | undefined;
  root: string;
  logCall: LogCallFn;
  runTool: RunToolFn;
}): Promise<CodingToolOutcome> {
  const { context, input, tool, verdict } = p;
  const callSignal = context?.signal ?? p.runtimeSignal;
  const askControl: AskControl = {
    ...(callSignal !== undefined ? { signal: callSignal } : {}),
    ...(context?.onWaiting !== undefined ? { onWaiting: context.onWaiting } : {}),
  };
  const ask = askSummary(p.identity, tool.scope, input);
  let askVerdict: AskVerdict;
  try {
    askVerdict = await p.askResolver.resolve(
      {
        tool: p.identity,
        stage: p.stage ?? "unknown",
        rule: verdict.rule ?? verdict.reason,
        ...(verdict.rule !== undefined ? { matchedRule: verdict.rule } : {}),
        summary: ask.summary,
        ...(ask.unshowable ? { unshowable: true as const } : {}),
        ...(typeof input[tool.scope.commandField ?? ""] === "string"
          ? { command: input[tool.scope.commandField as string] as string }
          : {}),
        root: p.root,
        reason: verdict.reason,
        ...(p.storyId !== undefined ? { storyId: p.storyId } : {}),
      },
      askControl,
    );
  } catch (err) {
    const content = errorMessage(err);
    p.logCall(p.identity, "error", content.length, input, context, false, content);
    return { kind: "error", content };
  }
  const approval: Approval = {
    decidedBy: askVerdict.decidedBy,
    remembered: false,
    latencyMs: askVerdict.latencyMs,
  };
  if (askVerdict.decision === "allow") {
    // US-003 AC11: recheck the turn signal AFTER the resolver returned
    // allow. A resolver that approves after the turn has been cancelled
    // would otherwise race ahead and execute the tool; we deny instead
    // with the same cancelled reason, so the agent never sees a tool
    // result from a turn that has already ended.
    if (callSignal?.aborted === true) {
      const reason = `${verdict.reason} -- ${ASK_CANCELLED_REASON}`;
      p.logCall(p.identity, "denied:ask", reason.length, input, context, false, reason, undefined, {
        approval,
      });
      return { kind: "denied", reason, breach: false };
    }
    return p.runTool(tool, input, verdict.resolvedPaths ?? [], approval);
  }
  const reason = `${verdict.reason} -- ${askDenyReason(askVerdict.decidedBy)}`;
  p.logCall(p.identity, "denied:ask", reason.length, input, context, false, reason, undefined, { approval });
  return { kind: "denied", reason, breach: false };
}

/**
 * The deny branch: a final policy refusal, sharpened where possible with a
 * redirect naming an advertised tool that serves the call's intent.
 */
export function resolveDenialOutcome(p: {
  name: string;
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  context: ToolCallContext | undefined;
  verdict: DeniedVerdict;
  argvField: string | undefined;
  /** What `advertised()` actually returned; a redirect names only these. */
  advertisedNames: ReadonlySet<string>;
  declaredCommands: ReadonlySet<string> | undefined;
  root: string;
  logCall: LogCallFn;
}): CodingToolOutcome {
  const { input, context, verdict } = p;
  if (verdict.breach) {
    // In band so an unattended run survives one bad path guess, but loud:
    // a path escaping the root can indicate prompt injection.
    getSafeLogger()?.warn("tools", "[policy] path resolved outside the permitted root", {
      tool: p.identity,
      reason: verdict.reason,
      root: p.root,
    });
  }
  const commandField = p.tool.scope.commandField;
  const rawCommand = commandField === undefined ? undefined : input[commandField];
  const rawArgv = p.argvField === undefined ? undefined : input[p.argvField];
  const verbField = p.tool.scope.verbField;
  const rawVerb = verbField === undefined ? undefined : input[verbField];
  const declared = p.declaredCommands ?? new Set<string>();
  // An argv call and a verb call deny through different policy branches;
  // before #1971 only the first could reach a redirect at all.
  const extra =
    typeof rawCommand === "string"
      ? redirectForCommand(rawCommand, p.advertisedNames, declared)
      : Array.isArray(rawArgv)
        ? redirectForArgv(rawArgv as readonly string[], p.advertisedNames, declared)
        : typeof rawVerb === "string"
          ? redirectForVerb(p.name, rawVerb, p.advertisedNames, declared)
          : undefined;
  const reason = extra === undefined ? verdict.reason : `${verdict.reason} -- ${extra}`;
  p.logCall(p.identity, "denied", reason.length, input, context, verdict.breach, reason);
  return { kind: "denied", reason, breach: verdict.breach };
}
