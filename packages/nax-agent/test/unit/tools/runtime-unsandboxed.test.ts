/**
 * US-005: the runtime's sandbox-escape routing, part 1 — refuse when the
 * session never enabled the escape, and leave every other call alone.
 *
 * A `Bash`/`Exec`-identity call carrying `unsandboxed: true` is answered
 * BEFORE the policy evaluates anything: refused when the runtime was not built
 * with `unsandboxed.enabled`, and otherwise routed exactly as it would be
 * without the flag (a deny keeps its reason and breach, an ordinary call
 * without the flag is untouched, a RunCommand-identity call is never routed).
 *
 * The tools here are stubs handed to `createCodingToolRuntime` through
 * `extraTools`, because the registry refuses a second reserved name: a stub
 * whose `run` records its input is the sharpest witness for "the tool did not
 * run", which is half of what this story must prove. What the REAL tools do
 * with the flag is pinned elsewhere — US-003 the advertisement, US-008 the
 * argv branch — so this file's subject stays the runtime's routing.
 *
 * Its own file rather than `runtime.test.ts` because that file is at 755 of
 * the 800-line test limit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AskRequest, AskResolver } from "#src/permissions/index";
import { compileToolPolicy } from "#src/tools/policy";
import type { CodingTool } from "#src/tools/registry";
import { createCodingToolRuntime } from "#src/tools/runtime";
import type { ToolAuditSink, ToolCallRecord } from "#src/tools/tool-audit";
import { BASH_TOOL_NAME, type ToolPolicy, type ToolScope } from "#src/tools/types";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

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
