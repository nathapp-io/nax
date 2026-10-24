/**
 * The runtime's sandbox-escape routing, in two halves.
 *
 * US-005 — refuse when the session never enabled the escape, and leave every
 * other call alone. A `Bash`/`Exec`-identity call carrying `unsandboxed: true`
 * is answered BEFORE the policy evaluates anything: refused when the runtime
 * was not built with `unsandboxed.enabled`, and otherwise routed exactly as it
 * would be without the flag (a deny keeps its reason and breach, an ordinary
 * call without the flag is untouched, a RunCommand-identity call is never
 * routed).
 *
 * US-006 — the routing of an ENABLED request: an ask verdict proceeds with the
 * flag and the reason suffix, and an ALLOWED verdict becomes an ask itself
 * (rule `Unsandboxed(<identity>)`) under every mode but `raw`. Those sections
 * live at the end of this file.
 *
 * The tools here are stubs handed to `createCodingToolRuntime` through
 * `extraTools`, because the registry refuses a second reserved name: a stub
 * whose `run` records its input is the sharpest witness for "the tool did not
 * run", which is half of what these stories must prove. US-006's last two
 * groups drive the REAL Bash tool, where `unwrapped` and the launcher's
 * `requested` sandbox record become observable; what the real tool does with
 * the flag on its own is pinned in US-003 (the advertisement) and US-008 (the
 * argv branch).
 *
 * Its own file rather than `runtime.test.ts` because that file is at 755 of
 * the 800-line test limit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { ASK_DENIED_REASON, type AskRequest, type AskResolver } from "#src/permissions/index";
import type { CommandLauncher, LaunchRequest, SandboxRecord } from "#src/sandbox/index";
import { _launcherDeps, createCommandLauncher, DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import { _bashToolDeps, createBashTool } from "#src/tools/bash";
import { compileToolPolicy } from "#src/tools/policy";
import type { CodingTool } from "#src/tools/registry";
import { type CodingToolRuntime, createCodingToolRuntime } from "#src/tools/runtime";
import type { ToolAuditSink, ToolCallRecord } from "#src/tools/tool-audit";
import { BASH_TOOL_NAME, EXEC_TOOL_NAME, type ToolGrant, type ToolPolicy, type ToolScope } from "#src/tools/types";
import { assertDefined, cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

/** The refusal the story pins verbatim (spec US-005). */
const NOT_ENABLED = "unsandboxed commands are not enabled for this session (allowUnsandboxedCommands)";

/** Bash's real scope minus the path fields the policy needs none of here. */
const BASH_SCOPE: ToolScope = { pathFields: [], commandField: "command", unsandboxedField: "unsandboxed" };

/**
 * RunCommand's declared-command (`command`) branch in the shape US-008 gives
 * it: the escape field is declared on the scope unconditionally, so this call
 * reaches the helper WITH `unsandboxed: true` on a scope that carries the
 * field — leaving the policy identity as the only thing that can keep it out
 * of the routing.
 */
const RUN_COMMAND_SCOPE: ToolScope = {
  pathFields: [],
  verbField: "command",
  allowedVerbs: ["test"],
  unsandboxedField: "unsandboxed",
};

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-runtime-unsandboxed-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** A stub tool that records every input its `run` received. */
function recordingTool(
  name: string,
  scope: ToolScope,
): { readonly tool: CodingTool; readonly runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = [];
  return {
    runs,
    tool: {
      name,
      description: `${name} stub`,
      inputSchema: { type: "object", properties: {} },
      scope,
      run: async (input) => {
        runs.push(input);
        return { content: `${name} ran` };
      },
    },
  };
}

/** An ask resolver that records every request and answers `decision`. */
function recordingResolver(decision: "allow" | "deny"): {
  readonly resolver: AskResolver;
  readonly requests: AskRequest[];
} {
  const requests: AskRequest[] = [];
  return {
    requests,
    resolver: {
      resolve: async (request) => {
        requests.push(request);
        return { decision, decidedBy: "human", latencyMs: 12 };
      },
    },
  };
}

/** An audit sink that records every row the runtime ledgers. */
function recordingSink(): { readonly sink: ToolAuditSink; readonly records: ToolCallRecord[] } {
  const records: ToolCallRecord[] = [];
  return { records, sink: { record: (record) => void records.push(record), flush: async () => {} } };
}

/** `policy`, with every `check` call recorded — the witness for "before policy evaluation". */
function spyingPolicy(policy: ToolPolicy): { readonly policy: ToolPolicy; readonly checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    policy: {
      root: policy.root,
      grantedTools: () => policy.grantedTools(),
      check: (tool, scope, input) => {
        checks.push(tool);
        return policy.check(tool, scope, input);
      },
    },
  };
}

describe("callTool — a sandbox-escape request this session never enabled", () => {
  /**
   * The scenario all five ACs read: an allow grant, a `Bash(*)` ask rule and
   * an always-allow resolver, so a single stray consult would both ask and
   * run — every "did not happen" assertion below fails loudly if it does.
   */
  function refusedBashCall() {
    const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
    const { policy, checks } = spyingPolicy(
      compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
        askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
      }),
    );
    const asked = recordingResolver("allow");
    const { sink, records } = recordingSink();
    const runtime = createCodingToolRuntime({ policy, extraTools: [bash.tool], askResolver: asked.resolver, sink });
    return { runtime, bash, asked, records, checks };
  }

  const escapeRequest = { command: "ls", unsandboxed: true };

  test("AC-1: returns the allowUnsandboxedCommands refusal", async () => {
    const { runtime } = refusedBashCall();
    expect(await runtime.callTool(BASH_TOOL_NAME, escapeRequest)).toEqual({ kind: "error", content: NOT_ENABLED });
  });

  test("AC-2: the tool's run is not invoked", async () => {
    const { runtime, bash } = refusedBashCall();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(bash.runs).toEqual([]);
  });

  test("AC-3: askResolver.resolve is not invoked, even with a Bash(*) ask rule configured", async () => {
    const { runtime, asked } = refusedBashCall();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(asked.requests).toEqual([]);
  });

  test("AC-4: the audit sink receives an error record for the Bash call", async () => {
    const { runtime, records } = refusedBashCall();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: BASH_TOOL_NAME, outcome: "error", reason: NOT_ENABLED });
  });

  test("AC-5: opts.policy.check is not invoked: the refusal precedes policy evaluation", async () => {
    const { runtime, checks } = refusedBashCall();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(checks).toEqual([]);
  });
});

describe("callTool — the flag does not change a deny", () => {
  function denyingCall() {
    const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
    const asked = recordingResolver("allow");
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root),
      extraTools: [bash.tool],
      askResolver: asked.resolver,
      unsandboxed: { enabled: true, bashApproval: "gated" },
    });
    return { runtime, bash, asked };
  }

  // `cat /etc/passwd` resolves outside the permitted root, so the policy's
  // containment check denies it with a breach flag — the strongest shape of
  // denial this invariant has to survive.
  const denied = { command: "cat /etc/passwd" };

  test("AC-6: the denial keeps its reason and breach", async () => {
    const { runtime } = denyingCall();
    const flagged = await runtime.callTool(BASH_TOOL_NAME, { ...denied, unsandboxed: true });
    const ordinary = await runtime.callTool(BASH_TOOL_NAME, denied);
    expect(flagged.kind).toBe("denied");
    expect(ordinary.kind).toBe("denied");
    if (flagged.kind === "denied" && ordinary.kind === "denied") {
      expect(flagged.reason).toBe(ordinary.reason);
      expect(flagged.breach).toBe(ordinary.breach);
    }
  });

  test("AC-7: askResolver.resolve is not invoked", async () => {
    const { runtime, asked } = denyingCall();
    await runtime.callTool(BASH_TOOL_NAME, { ...denied, unsandboxed: true });
    expect(asked.requests).toEqual([]);
  });

  test("AC-8: the tool's run is not invoked", async () => {
    const { runtime, bash } = denyingCall();
    await runtime.callTool(BASH_TOOL_NAME, { ...denied, unsandboxed: true });
    expect(bash.runs).toEqual([]);
  });
});

describe("callTool — a call without the flag is untouched", () => {
  test("AC-9: the ask carries no unsandboxed key and the verdict's own reason", async () => {
    const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
    const asked = recordingResolver("deny");
    const policy = compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
    });
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [bash.tool],
      askResolver: asked.resolver,
      unsandboxed: { enabled: true, bashApproval: "gated" },
    });

    const verdict = policy.check(BASH_TOOL_NAME, BASH_SCOPE, { command: "curl x" });
    if (verdict.allowed) throw new Error("the Bash(*) ask rule must turn this command into an ask");
    await runtime.callTool(BASH_TOOL_NAME, { command: "curl x" });

    const request = asked.requests[0];
    assertDefined(request, "the ask request");
    expect("unsandboxed" in request).toBe(false);
    expect(request.reason).toBe(verdict.reason);
  });
});

describe("callTool — a human deny on an unsandboxed ask", () => {
  function unsandboxedAsk() {
    const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
    const asked = recordingResolver("deny");
    const { sink, records } = recordingSink();
    const policy = compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
    });
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [bash.tool],
      askResolver: asked.resolver,
      sink,
      unsandboxed: { enabled: true, bashApproval: "gated" },
    });
    return { runtime, bash, asked, records, policy };
  }

  const escapeRequest = { command: "curl x", unsandboxed: true };

  test("AC-10: the outcome is denied", async () => {
    const { runtime } = unsandboxedAsk();
    expect((await runtime.callTool(BASH_TOOL_NAME, escapeRequest)).kind).toBe("denied");
  });

  test("AC-11: the tool's run is not invoked", async () => {
    const { runtime, bash } = unsandboxedAsk();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(bash.runs).toEqual([]);
  });

  test("AC-12: the ledger records denied:ask, with nothing spawned", async () => {
    const { runtime, records } = unsandboxedAsk();
    await runtime.callTool(BASH_TOOL_NAME, escapeRequest);
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("denied:ask");
    // Nothing spawned sandboxed or unwrapped: no execution reached the ledger.
    expect(records[0]?.executed).toBeUndefined();
    expect(records[0]?.sandbox).toBeUndefined();
  });

  // The marker an ENABLED session returns is what carries the escape to the
  // person being asked: without it the ask says the command runs in the
  // sandbox, which is the one thing this call has declared it will not do.
  // (Converting an ALLOW into an ask is US-006's; this ask already exists.)
  test("the ask tells the person the command runs outside the sandbox", async () => {
    const { runtime, asked, policy } = unsandboxedAsk();
    const verdict = policy.check(BASH_TOOL_NAME, BASH_SCOPE, escapeRequest);
    if (verdict.allowed) throw new Error("the Bash(*) ask rule must turn this command into an ask");

    await runtime.callTool(BASH_TOOL_NAME, { ...escapeRequest, unsandboxedReason: "needs network" });

    const request = asked.requests[0];
    assertDefined(request, "the ask request");
    expect(request.unsandboxed).toBe(true);
    expect(request.reason).toBe(`${verdict.reason} -- runs OUTSIDE the sandbox: needs network`);
    expect(request.matchedRule).toBe("Bash");
  });
});

describe("callTool — a RunCommand-identity call is untouched", () => {
  function runCommandCall(option?: { enabled: boolean; bashApproval: "gated" }) {
    const runCommand = recordingTool("RunCommand", RUN_COMMAND_SCOPE);
    const asked = recordingResolver("allow");
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "RunCommand", patterns: ["*"] }], root),
      extraTools: [runCommand.tool],
      askResolver: asked.resolver,
      ...(option !== undefined ? { unsandboxed: option } : {}),
    });
    return { runtime, runCommand, asked };
  }

  // A declared-command call: the declared-command branch is the TOOL's to
  // reject (US-008), and the runtime must not route it at all.
  const declaredCommand = { command: "test", unsandboxed: true };

  test("AC-13: the ask resolver is not consulted", async () => {
    const { runtime, asked } = runCommandCall({ enabled: true, bashApproval: "gated" });
    await runtime.callTool("RunCommand", declaredCommand);
    expect(asked.requests).toEqual([]);
  });

  test("AC-14: the registered tool's run receives the original input", async () => {
    const { runtime, runCommand } = runCommandCall({ enabled: true, bashApproval: "gated" });
    expect((await runtime.callTool("RunCommand", declaredCommand)).kind).toBe("ok");
    expect(runCommand.runs).toEqual([declaredCommand]);
  });

  test("the identity gate holds with the option off too: no refusal, the tool runs", async () => {
    const { runtime, runCommand } = runCommandCall();
    expect((await runtime.callTool("RunCommand", declaredCommand)).kind).toBe("ok");
    expect(runCommand.runs).toEqual([declaredCommand]);
  });

  // The other identity the helper routes: a RunCommand call carrying `argv`
  // resolves to `Exec`, so a disabled session refuses it exactly as it refuses
  // Bash. (What the real argv branch does with the flag is US-008's.)
  test("the Exec identity (RunCommand's argv branch) is routed, so a disabled session refuses it", async () => {
    const runCommand = recordingTool("RunCommand", {
      pathFields: [],
      argvField: "argv",
      unsandboxedField: "unsandboxed",
    });
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [
          { tool: "RunCommand", patterns: ["*"] },
          { tool: "Exec", patterns: ["*"] },
        ],
        root,
      ),
      extraTools: [runCommand.tool],
    });

    const escapeArgv = { argv: ["bun", "--version"], unsandboxed: true };
    expect(await runtime.callTool("RunCommand", escapeArgv)).toEqual({ kind: "error", content: NOT_ENABLED });
    expect(runCommand.runs).toEqual([]);
  });
});

describe("callTool — only a boolean true is an escape request", () => {
  test('AC-16: unsandboxed: "true" routes ordinarily and reaches the tool', async () => {
    const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root),
      extraTools: [bash.tool],
    });

    const input = { command: "ls", unsandboxed: "true" };
    expect((await runtime.callTool(BASH_TOOL_NAME, input)).kind).toBe("ok");
    expect(bash.runs).toEqual([input]);
  });
});

/**
 * US-006: the second half of the runtime's escape routing — an ALLOWED escape
 * request still goes to a human, in every mode but `raw`.
 *
 * The policy's line ("this command form is granted") says nothing about the
 * sandbox: under `gated` that same grant runs the command WRAPPED, and under
 * `escalate` only a grant MISS asks. So a permission the policy already
 * allowed is re-raised as an ask named `Unsandboxed(<identity>)` — a rule no
 * configuration can express, which is why `matchedRule` must stay unset (a
 * remembered approval derives its origin from that field, and this rule exists
 * in no config). `raw` is the one exception: it never asks by definition.
 *
 * The first sections drive a STUB Bash tool, so "the tool ran" and "the tool
 * did not run" are observable without a sandbox. The last two drive the REAL
 * Bash tool instead: that is where `unwrapped` reaches the launcher, where the
 * ledger records `sandbox.reason: "requested"`, and where the no-launcher
 * branch (a session whose launcher `allowUnsandboxed` dropped) direct-spawns.
 */

/** The one Bash escape request the stub cases make. */
const ESCAPE = { command: "curl x", unsandboxed: true };

/** The suffix every converted ask's reason carries, pinned verbatim from the story. */
const SANDBOX_CLAUSE = " -- runs OUTSIDE the sandbox: ";

/** The reason a converted allow carries, before the suffix. */
const ESCAPE_REASON = "unsandboxed run requested";

/** What a launcher records for a call it did not wrap. */
const NOT_WRAPPED: SandboxRecord = { backend: "none", wrapped: false };

/**
 * One enabled session: a `Bash(*)` grant, a stub Bash tool that records the
 * input it ran with, and a resolver that answers `decision`.
 */
function escapeCall(p: {
  readonly bashApproval: BashApprovalMode;
  readonly decision: "allow" | "deny";
  readonly askRules?: readonly ToolGrant[];
}): {
  readonly runtime: CodingToolRuntime;
  readonly bash: ReturnType<typeof recordingTool>;
  readonly asked: ReturnType<typeof recordingResolver>;
  readonly policy: ToolPolicy;
} {
  const bash = recordingTool(BASH_TOOL_NAME, BASH_SCOPE);
  const asked = recordingResolver(p.decision);
  const policy = compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
    ...(p.askRules !== undefined ? { askRules: p.askRules } : {}),
  });
  const runtime = createCodingToolRuntime({
    policy,
    extraTools: [bash.tool],
    askResolver: asked.resolver,
    unsandboxed: { enabled: true, bashApproval: p.bashApproval },
  });
  return { runtime, bash, asked, policy };
}

describe("callTool — an allowed escape request keeps the ask rule that already matched", () => {
  /**
   * AC-1's scenario: the policy itself asks, so the runtime only has to add
   * the flag and the reason clause. The matched rule stays what the operator
   * configured, so a remembered approval has a real origin.
   */
  function alreadyAsking() {
    const call = escapeCall({
      bashApproval: "gated",
      decision: "allow",
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
    });
    const verdict = call.policy.check(BASH_TOOL_NAME, BASH_SCOPE, ESCAPE);
    if (verdict.allowed) throw new Error("the Bash(*) ask rule must turn this command into an ask");
    return call;
  }

  test("US-006 AC-1: the ask carries the flag, the matched rule and the suffixed reason", async () => {
    const { runtime, asked } = alreadyAsking();
    await runtime.callTool(BASH_TOOL_NAME, { ...ESCAPE, unsandboxedReason: "needs network" });

    const request = asked.requests[0];
    assertDefined(request, "the ask request");
    expect(request.unsandboxed).toBe(true);
    expect(request.matchedRule).toBe("Bash");
    expect(request.reason).toEndWith(`${SANDBOX_CLAUSE}needs network`);
  });
});

describe("callTool — an allowed escape request becomes an ask", () => {
  test("US-006 AC-2: escalate with no ask rule asks with the Unsandboxed(Bash) rule", async () => {
    const { runtime, asked, policy } = escapeCall({ bashApproval: "escalate", decision: "deny" });
    expect(policy.check(BASH_TOOL_NAME, BASH_SCOPE, ESCAPE).allowed).toBe(true);

    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);

    const request = asked.requests[0];
    assertDefined(request, "the converted ask");
    expect(request.unsandboxed).toBe(true);
    expect(request.rule).toBe("Unsandboxed(Bash)");
    expect("matchedRule" in request).toBe(false);
    expect(request.reason).toBe(`${ESCAPE_REASON}${SANDBOX_CLAUSE}no reason given`);
  });

  test("US-006 AC-8: gated with no ask rule asks with the Unsandboxed(Bash) rule and no matchedRule", async () => {
    const { runtime, asked, policy } = escapeCall({ bashApproval: "gated", decision: "deny" });
    expect(policy.check(BASH_TOOL_NAME, BASH_SCOPE, ESCAPE).allowed).toBe(true);

    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);

    const request = asked.requests[0];
    assertDefined(request, "the converted ask");
    expect(request.rule).toBe("Unsandboxed(Bash)");
    expect("matchedRule" in request).toBe(false);
  });

  test("US-006 AC-13: a non-string reason says no reason given", async () => {
    const { runtime, asked } = escapeCall({ bashApproval: "gated", decision: "deny" });
    await runtime.callTool(BASH_TOOL_NAME, { ...ESCAPE, unsandboxedReason: 42 });

    const request = asked.requests[0];
    assertDefined(request, "the converted ask");
    expect(request.reason).toEndWith(`${SANDBOX_CLAUSE}no reason given`);
  });

  test("US-006 AC-14: an unshowable reason is withheld, and the ask still goes out", async () => {
    const { runtime, asked } = escapeCall({ bashApproval: "gated", decision: "deny" });
    // The same shell-syntax straddle `unsandboxedReasonSuffix` withholds: a
    // `Cookie` value containing `;` could hide code from the person approving.
    await runtime.callTool(BASH_TOOL_NAME, { ...ESCAPE, unsandboxedReason: "curl -H 'Cookie: a=b'" });

    const request = asked.requests[0];
    assertDefined(request, "the ask a withheld reason must not suppress");
    expect(request.unsandboxed).toBe(true);
    expect(request.reason).toEndWith(`${SANDBOX_CLAUSE}reason withheld`);
  });
});

describe("callTool — an ask-less Exec grant is converted under its own identity", () => {
  const ESCAPE_ARGV = { argv: ["bun", "--version"], unsandboxed: true, unsandboxedReason: "registry" };

  function execEscapeCall() {
    const runCommand = recordingTool("RunCommand", {
      pathFields: [],
      argvField: "argv",
      unsandboxedField: "unsandboxed",
    });
    const asked = recordingResolver("deny");
    const policy = compileToolPolicy([{ tool: EXEC_TOOL_NAME, patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({
      policy,
      extraTools: [runCommand.tool],
      askResolver: asked.resolver,
      unsandboxed: { enabled: true, bashApproval: "gated" },
    });
    return { runtime, runCommand, asked, policy };
  }

  test("US-006 AC-3: the ask names the Exec identity and carries the reason", async () => {
    const { runtime, asked, runCommand, policy } = execEscapeCall();
    // The scope's argvField makes this call an `Exec` call, which is the
    // identity the Exec grant allows and the rule must therefore name.
    expect(policy.check(EXEC_TOOL_NAME, runCommand.tool.scope, ESCAPE_ARGV).allowed).toBe(true);

    await runtime.callTool("RunCommand", ESCAPE_ARGV);

    const request = asked.requests[0];
    assertDefined(request, "the converted Exec ask");
    expect(request.unsandboxed).toBe(true);
    expect(request.rule).toBe("Unsandboxed(Exec)");
    expect(request.reason).toEndWith(`${SANDBOX_CLAUSE}registry`);
    expect(runCommand.runs).toEqual([]);
  });

  test("US-006 AC-9: the converted Exec ask carries no matchedRule key", async () => {
    const { runtime, asked } = execEscapeCall();
    await runtime.callTool("RunCommand", ESCAPE_ARGV);

    const request = asked.requests[0];
    assertDefined(request, "the converted Exec ask");
    expect("matchedRule" in request).toBe(false);
  });
});

describe("callTool — raw runs the escape without asking", () => {
  test("US-006 AC-4: an allowed escape call invokes the tool's run", async () => {
    const { runtime, bash } = escapeCall({ bashApproval: "raw", decision: "deny" });
    expect((await runtime.callTool(BASH_TOOL_NAME, ESCAPE)).kind).toBe("ok");
    expect(bash.runs).toEqual([ESCAPE]);
  });

  test("US-006 AC-5: raw never consults the ask resolver", async () => {
    const { runtime, asked } = escapeCall({ bashApproval: "raw", decision: "allow" });
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);
    expect(asked.requests).toEqual([]);
  });
});

describe("callTool — a human allow on a converted ask", () => {
  test("US-006 AC-6: the tool's run receives the ORIGINAL input, flag included", async () => {
    const { runtime, bash, asked } = escapeCall({ bashApproval: "gated", decision: "allow" });
    expect((await runtime.callTool(BASH_TOOL_NAME, ESCAPE)).kind).toBe("ok");
    expect(asked.requests).toHaveLength(1);
    expect(bash.runs).toEqual([ESCAPE]);
  });
});

describe("callTool — a human deny on a converted ask", () => {
  test("US-006 AC-15: the denial renders as the human ask denial of the escape reason", async () => {
    const { runtime, policy } = escapeCall({ bashApproval: "gated", decision: "deny" });
    expect(policy.check(BASH_TOOL_NAME, BASH_SCOPE, ESCAPE).allowed).toBe(true);

    expect(await runtime.callTool(BASH_TOOL_NAME, ESCAPE)).toEqual({
      kind: "denied",
      reason: `${ESCAPE_REASON} -- ${ASK_DENIED_REASON}`,
      breach: false,
    });
  });

  test("US-006 AC-16: the denied call never runs the tool", async () => {
    const { runtime, bash } = escapeCall({ bashApproval: "gated", decision: "deny" });
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);
    expect(bash.runs).toEqual([]);
  });
});

describe("callTool — the real Bash tool runs the escape it was granted", () => {
  withDepsRestore(_bashToolDeps, ["runArgv"]);
  withDepsRestore(_launcherDeps, ["runArgv"]);

  /** Every spawn the tool's direct branch made. */
  const spawned: Parameters<typeof _bashToolDeps.runArgv>[0][] = [];
  /** Every spawn the launcher made. */
  const launched: Parameters<typeof _launcherDeps.runArgv>[0][] = [];

  beforeEach(() => {
    spawned.length = 0;
    launched.length = 0;
    _bashToolDeps.runArgv = async (options) => {
      spawned.push(options);
      return { exitCode: 0, stdout: "out", stderr: "", timedOut: false };
    };
    _launcherDeps.runArgv = async (options) => {
      launched.push(options);
      return { exitCode: 0, stdout: "out", stderr: "", timedOut: false };
    };
  });

  /** A launcher that records every request instead of running anything. */
  function recordingLauncher(requests: LaunchRequest[]): CommandLauncher {
    return {
      state: DISABLED_SANDBOX_STATE,
      async run(req) {
        requests.push(req);
        return { exitCode: 0, stdout: "out", stderr: "", timedOut: false, executed: [], sandbox: NOT_WRAPPED };
      },
    };
  }

  /** One enabled `gated` runtime serving the real tool under test. */
  function bashToolRuntime(tool: CodingTool) {
    const asked = recordingResolver("allow");
    const { sink, records } = recordingSink();
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root),
      extraTools: [tool],
      askResolver: asked.resolver,
      sink,
      unsandboxed: { enabled: true, bashApproval: "gated" },
    });
    return { runtime, asked, records };
  }

  test("US-006 AC-7: with no launcher the approved call direct-spawns the shell", async () => {
    const { runtime, asked } = bashToolRuntime(createBashTool({ unsandboxedCommands: true }));
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);
    expect(asked.requests).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(["/bin/sh", "-c", "curl x"]);
  });

  test("US-006 AC-12: a launcher dropped by allowUnsandboxed still asks, then direct-spawns", async () => {
    const { runtime, asked } = bashToolRuntime(createBashTool({ unsandboxedCommands: true }));
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);

    const request = asked.requests[0];
    assertDefined(request, "the ask a dropped launcher must not skip");
    expect(request.unsandboxed).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  test("US-006 AC-10: the approved call asks the launcher to run unwrapped", async () => {
    const requests: LaunchRequest[] = [];
    const { runtime, asked } = bashToolRuntime(
      createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true }),
    );
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);

    expect(asked.requests).toHaveLength(1);
    assertDefined(requests[0], "the launcher request");
    expect(requests[0].unwrapped).toBe(true);
  });

  test("US-006 AC-11: a command launcher records sandbox.reason requested", async () => {
    const tool = createBashTool({
      launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }),
      unsandboxedCommands: true,
    });
    const { runtime, records, asked } = bashToolRuntime(tool);
    await runtime.callTool(BASH_TOOL_NAME, ESCAPE);

    expect(asked.requests).toHaveLength(1);
    expect(launched).toHaveLength(1);
    // A launcher nobody asked to unwrap records no `reason` at all, so
    // `requested` is what distinguishes the approved escape from an ordinary
    // run of the same command under a disabled sandbox.
    expect(records[0]?.sandbox).toEqual({ backend: "none", wrapped: false, reason: "requested" });
  });
});
