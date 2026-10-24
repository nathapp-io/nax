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
import type { BashApprovalMode } from "#src/config/bash-approval";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { ASK_CANCELLED_REASON, type AskControl, type AskResolver, type AskVerdict } from "#src/permissions/index";
import type { SandboxRecord } from "../sandbox/index.ts";
import { askDenyReason, askSummary, unsandboxedReasonSuffix } from "./ask-request.ts";
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

/** The content of the refusal a disabled escape request gets (spec US-005). */
const UNSANDBOXED_NOT_ENABLED = "unsandboxed commands are not enabled for this session (allowUnsandboxedCommands)";

/**
 * What `resolveUnsandboxedCall` answers for a call that really asked to run
 * outside the sandbox: `error` is the refusal, `unsandboxed` the permission.
 */
export type UnsandboxedCall =
  | { readonly kind: "error"; readonly content: string }
  | {
      readonly kind: "unsandboxed";
      /** The clause appended to any ask this call raises: WHY it wants out. */
      readonly suffix: string;
      /**
       * US-006: true when an ALLOWED verdict must still become an ask. False
       * under `raw`, which never asks by definition (ADR-030) — the mode's
       * whole point is that a command the policy let through runs.
       */
      readonly asksOnAllow: boolean;
    };

/**
 * US-005: the sandbox-escape gate, run once per call BEFORE the policy.
 *
 * Whether an escape is PERMITTED is the runtime's decision, not the tool's:
 * the tool only knows what the call asked for, and it runs exactly as it
 * always did once this gate lets it through. Three conditions narrow the field
 * to the calls that really are escape requests — the tool declares an
 * `unsandboxedField`, the policy identity is one the flag is defined for, and
 * the value is exactly `true` (a `"true"` string is not an escape: an opted-in
 * session's schema rejects it at the transport, and every other session reads
 * it as the ordinary call it is).
 *
 * - `error` — this session was not opened with `unsandboxed.enabled`, so the
 *   call never reaches the policy, an ask or a spawn. Deciding it here rather
 *   than in the tool is what makes "disabled" mean disabled.
 * - `unsandboxed` — the escape is allowed. `suffix` is the clause an ask this
 *   call raises must carry, so the person approving it is told the command
 *   runs outside the sandbox; `asksOnAllow` says whether an ALLOW still has to
 *   be raised as one (US-006). The policy itself is evaluated unchanged: the
 *   flag is not a policy input, so the verdict is the one the call would get
 *   without it.
 *
 * The mode is read from the runtime's option rather than the compiled policy:
 * `bashApproval` decides how an ENABLED request is ROUTED, which is the
 * runtime's business, while the policy line answers only "is this command
 * form granted". An `Exec` (argv) call is routed by the same mode — it is the
 * other model-authored identity, and no separate Exec approval mode exists.
 */
export function resolveUnsandboxedCall(p: {
  identity: string;
  tool: CodingTool;
  input: Record<string, unknown>;
  option: { readonly enabled: boolean; readonly bashApproval: BashApprovalMode } | undefined;
}): UnsandboxedCall | undefined {
  const field = p.tool.scope.unsandboxedField;
  if (field === undefined) return undefined;
  if (p.identity !== BASH_TOOL_NAME && p.identity !== EXEC_TOOL_NAME) return undefined;
  if (p.input[field] !== true) return undefined;
  if (p.option?.enabled !== true) return { kind: "error", content: UNSANDBOXED_NOT_ENABLED };
  return {
    kind: "unsandboxed",
    suffix: unsandboxedReasonSuffix(p.input),
    asksOnAllow: p.option.bashApproval !== "raw",
  };
}

/** The reason a converted allow carries (spec US-006), before the suffix. */
const UNSANDBOXED_ASK_REASON = "unsandboxed run requested";

/**
 * US-006: the ask a permitted escape request raises where the policy only
 * allowed it.
 *
 * An allow says "this command form is granted", nothing about the sandbox:
 * under `gated` that same grant runs the command WRAPPED, and under `escalate`
 * only a grant MISS asks. So an escape request the policy merely allowed would
 * otherwise run unwrapped with nobody told, which is the whole thing the
 * approval exists to prevent. `raw` is exempt (`asksOnAllow`), and a verdict
 * that already asks or denies is left to the ordinary paths.
 *
 * The rule is SYNTHETIC — `Unsandboxed(<identity>)` is expressible in no
 * config — so it goes on `rule` only; `matchedRule` stays unset (see
 * `SYNTHETIC_UNSANDBOXED_RULE`). `resolvedPaths` is carried over so an
 * approved call admits exactly what the policy resolved.
 */
export function convertUnsandboxedAllow(p: {
  identity: string;
  unsandboxed: UnsandboxedCall | undefined;
  verdict: PolicyVerdict;
}): DeniedVerdict | undefined {
  if (p.unsandboxed?.kind !== "unsandboxed" || !p.unsandboxed.asksOnAllow) return undefined;
  if (!p.verdict.allowed) return undefined;
  return {
    allowed: false,
    outcome: "ask",
    breach: false,
    rule: `Unsandboxed(${p.identity})`,
    reason: UNSANDBOXED_ASK_REASON,
    resolvedPaths: p.verdict.resolvedPaths,
  };
}

/**
 * The verdict this call raises an ask with, or undefined when it raises none.
 *
 * One place decides both the ask the policy itself produced (US-005) and the
 * one an ALLOWED escape request is converted into (US-006), so `callTool`
 * keeps a single ask branch and the conversion cannot drift from the ordinary
 * route. A denial that is final — `outcome` absent or "denied" — is NOT an
 * ask and comes back undefined, leaving `resolveDenialOutcome` to answer it.
 */
export function resolveAskVerdict(p: {
  identity: string;
  verdict: PolicyVerdict;
  unsandboxed: UnsandboxedCall | undefined;
}): DeniedVerdict | undefined {
  if (p.verdict.allowed) return convertUnsandboxedAllow(p);
  return p.verdict.outcome === "ask" ? p.verdict : undefined;
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
 * US-004: `Unsandboxed(<identity>)` is the SYNTHETIC rule US-006's
 * converted-allow verdict carries — not an ask rule anyone configured. It is
 * kept on `rule` (the request has to name what it is) but never becomes
 * `matchedRule`, because a remembered approval derives its `origin` from that
 * field and would then remember a rule that exists in no config.
 */
const SYNTHETIC_UNSANDBOXED_RULE = /^Unsandboxed\(.*\)$/;

/** The configured ask rule behind a verdict, or undefined when there is none. */
function matchedRuleOf(verdict: DeniedVerdict): string | undefined {
  if (verdict.rule === undefined) return undefined;
  return SYNTHETIC_UNSANDBOXED_RULE.test(verdict.rule) ? undefined : verdict.rule;
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
  /**
   * US-004: set when this ask is an unsandboxed run. `suffix` is
   * `unsandboxedReasonSuffix(...)`, appended to the request's `reason` so the
   * person sees WHY the call wants to leave the sandbox; the flag itself is
   * what a host keys on.
   */
  unsandboxed?: { readonly suffix: string };
}): Promise<CodingToolOutcome> {
  const { context, input, tool, verdict } = p;
  const callSignal = context?.signal ?? p.runtimeSignal;
  const askControl: AskControl = {
    ...(callSignal !== undefined ? { signal: callSignal } : {}),
    ...(context?.onWaiting !== undefined ? { onWaiting: context.onWaiting } : {}),
  };
  const ask = askSummary(p.identity, tool.scope, input);
  const askReason = p.unsandboxed === undefined ? verdict.reason : `${verdict.reason}${p.unsandboxed.suffix}`;
  const matchedRule = matchedRuleOf(verdict);
  let askVerdict: AskVerdict;
  try {
    askVerdict = await p.askResolver.resolve(
      {
        tool: p.identity,
        stage: p.stage ?? "unknown",
        rule: verdict.rule ?? verdict.reason,
        ...(matchedRule !== undefined ? { matchedRule } : {}),
        summary: ask.summary,
        ...(ask.unshowable ? { unshowable: true as const } : {}),
        ...(typeof input[tool.scope.commandField ?? ""] === "string"
          ? { command: input[tool.scope.commandField as string] as string }
          : {}),
        root: p.root,
        reason: askReason,
        ...(p.storyId !== undefined ? { storyId: p.storyId } : {}),
        ...(p.unsandboxed !== undefined ? { unsandboxed: true as const } : {}),
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
