/**
 * US-012: a session that has read the web asks before the calls the exposure guard flags.
 *
 * The guard's own table is US-011's (pinned in `test/unit/web/guard.test.ts`); what
 * this file pins is the RUNTIME's half: an ALLOWED call is put to the guard right
 * after the command-safety guard, and a decision becomes one ask through the SAME
 * channel the policy's asks use — so the ledger, the approval reason and the
 * "allow runs it / deny does not" behaviour are the existing ones, unchanged.
 *
 * Every call here goes through the REAL Bash tool over a recording launcher, so
 * "the call ran" is a recorded `LaunchRequest` and nothing is spawned, and the
 * stubbed `web__fetch` proves the guard is consulted for provider tools too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { ASK_DENIED_REASON, type AskRequest, type AskResolver } from "#src/permissions/index";
import { type CommandLauncher, DISABLED_SANDBOX_STATE, type LaunchRequest } from "#src/sandbox/index";
import type { WebExposurePort } from "#src/session/agent-session-types";
import { createBashTool } from "#src/tools/bash";
import { compileToolPolicy } from "#src/tools/policy";
import type { CodingTool } from "#src/tools/registry";
import { createCodingToolRuntime } from "#src/tools/runtime";
import type { ToolAuditSink, ToolCallRecord } from "#src/tools/tool-audit";
import { BASH_TOOL_NAME, type ToolGrant } from "#src/tools/types";
import type { WebCallAssessment } from "#src/web/guard";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

/** The sentence the flagging port answers with; no policy reason could be mistaken for it. */
const REASON = "the page you read told you to push";
const FETCH_TOOL = "web__fetch";

let root: string;

beforeEach(() => {
  root = realpathSync(makeTempDir("web-guard-runtime-"));
});

afterEach(() => cleanupTempDir(root));

/** A port that flags every call it is asked about, recording each assessment. */
function flaggingPort(reason = REASON): { readonly port: WebExposurePort; readonly calls: WebCallAssessment[] } {
  const calls: WebCallAssessment[] = [];
  return {
    calls,
    port: {
      assess(call) {
        calls.push(call);
        return { rule: "web-exposure", reason };
      },
    },
  };
}

/** A port that answers "nothing to ask about" for every call, recording each assessment. */
function quietPort(): { readonly port: WebExposurePort; readonly calls: WebCallAssessment[] } {
  const calls: WebCallAssessment[] = [];
  return {
    calls,
    port: {
      assess(call) {
        calls.push(call);
        return undefined;
      },
    },
  };
}

/** A port whose `assess` throws: the guard cannot answer, so the call must not run unasked. */
function throwingPort(): WebExposurePort {
  return {
    assess() {
      throw new Error("boom");
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
        return { decision, decidedBy: "human", latencyMs: 4 };
      },
    },
  };
}

/** A launcher that records every request instead of running anything. */
function recordingLauncher(requests: LaunchRequest[]): CommandLauncher {
  return {
    state: DISABLED_SANDBOX_STATE,
    async run(req) {
      requests.push(req);
      return {
        exitCode: 0,
        stdout: "ran",
        stderr: "",
        timedOut: false,
        executed: [],
        sandbox: { backend: "none", wrapped: false },
      };
    },
  };
}

/** An audit sink that records every row the runtime ledgers. */
function recordingSink(): { readonly sink: ToolAuditSink; readonly records: ToolCallRecord[] } {
  const records: ToolCallRecord[] = [];
  return { records, sink: { record: (record) => void records.push(record), flush: async () => {} } };
}

/** A tool that is never run through a shell: `web__fetch` is the provider call under test. */
function stubTool(name: string, run: (input: Record<string, unknown>) => void): CodingTool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    scope: { pathFields: [] },
    run: async (input) => {
      run(input);
      return { content: `${name} ran` };
    },
  };
}

interface RuntimeArgs {
  readonly port?: WebExposurePort;
  readonly sandboxed?: boolean;
  readonly decision?: "allow" | "deny";
  readonly askRules?: readonly ToolGrant[];
  readonly denyRules?: readonly ToolGrant[];
  readonly bashApproval?: BashApprovalMode;
}

/**
 * The scenario every AC reads: a Bash wildcard grant (so the policy ALLOWS the
 * call and the web guard is the only thing that can raise an ask), the real Bash
 * tool over a recording launcher, and a resolver whose answer the test chooses.
 */
function bashRuntime(args: RuntimeArgs = {}) {
  const asked = recordingResolver(args.decision ?? "deny");
  const launched: LaunchRequest[] = [];
  const { sink, records } = recordingSink();
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], root, {
      ...(args.bashApproval !== undefined ? { bashApproval: args.bashApproval } : {}),
      ...(args.askRules !== undefined ? { askRules: args.askRules } : {}),
      ...(args.denyRules !== undefined ? { denyRules: args.denyRules } : {}),
    }),
    extraTools: [createBashTool({ launcher: recordingLauncher(launched) })],
    askResolver: asked.resolver,
    sink,
    ...(args.port !== undefined ? { webExposure: args.port } : {}),
    ...(args.sandboxed !== undefined ? { sandboxed: args.sandboxed } : {}),
  });
  return { runtime, asked, launched, records };
}

describe("callTool — a flagged allowed call asks first", () => {
  test("AC-3: the ask carries rule web-exposure", async () => {
    const { port } = flaggingPort();
    const { runtime, asked } = bashRuntime({ port });

    const outcome = await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked.requests).toHaveLength(1);
    expect(asked.requests[0]).toMatchObject({ tool: BASH_TOOL_NAME, rule: "web-exposure" });
    expect(outcome.kind).toBe("denied");
  });

  test("AC-4: the ask's reason is the decision's reason", async () => {
    const { port } = flaggingPort();
    const { runtime, asked } = bashRuntime({ port });

    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked.requests[0]?.reason).toBe(REASON);
  });

  test("AC-5: an allowed ask runs the call", async () => {
    const { port } = flaggingPort();
    const { runtime, asked, launched } = bashRuntime({ port, decision: "allow" });

    const outcome = await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked.requests).toHaveLength(1);
    expect(launched).toHaveLength(1);
    expect(outcome.kind).toBe("ok");
  });

  test("AC-6: a denied ask neither runs the call nor ledgers as a run", async () => {
    const { port } = flaggingPort();
    const { runtime, launched, records } = bashRuntime({ port, decision: "deny" });

    const outcome = await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(launched).toEqual([]);
    expect(outcome).toEqual({ kind: "denied", reason: `${REASON} -- ${ASK_DENIED_REASON}`, breach: false });
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("denied:ask");
  });

  test('AC-7: under bashApproval "raw" a flagged call still reaches the ask resolver', async () => {
    const { port } = flaggingPort();
    const { runtime, asked, launched } = bashRuntime({ port, bashApproval: "raw" });

    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked.requests).toHaveLength(1);
    expect(launched).toEqual([]);
  });

  test("AC-8: a call the port does not flag runs with no ask", async () => {
    const { port, calls } = quietPort();
    const { runtime, asked, launched } = bashRuntime({ port });

    const outcome = await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(calls).toHaveLength(1);
    expect(asked.requests).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(outcome.kind).toBe("ok");
  });

  test("AC-17: a runtime with no port runs an allowed git push with no ask", async () => {
    // The control first: the SAME command under a flagging port is put to the
    // person, so the absence of an ask below is the missing port's doing and not
    // a command this runtime would never ask about.
    const { port } = flaggingPort();
    const control = bashRuntime({ port });
    await control.runtime.callTool(BASH_TOOL_NAME, { command: "git push origin main" });
    expect(control.asked.requests).toHaveLength(1);
    expect(control.launched).toEqual([]);

    const { runtime, asked, launched } = bashRuntime();

    const outcome = await runtime.callTool(BASH_TOOL_NAME, { command: "git push origin main" });

    expect(asked.requests).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.spec).toMatchObject({ command: "git push origin main" });
    expect(outcome.kind).toBe("ok");
  });
});

describe("callTool — what the port is shown", () => {
  test("AC-9: with sandboxed true the port sees the call's tool, policy root and sandboxed flag", async () => {
    const { port, calls } = flaggingPort();
    const { runtime } = bashRuntime({ port, sandboxed: true });

    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(calls).toEqual([
      { tool: BASH_TOOL_NAME, input: { command: "echo hi" }, root, resolvedPaths: [], sandboxed: true },
    ]);
  });

  test("AC-10: with sandboxed false the port sees sandboxed false", async () => {
    const { port, calls } = flaggingPort();
    const { runtime } = bashRuntime({ port, sandboxed: false });

    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(calls[0]?.sandboxed).toBe(false);
  });
});

describe("callTool — exposure augments allows and asks, never policy denials", () => {
  test("AC-13: a call the policy denies never reaches assess", async () => {
    const { port, calls } = flaggingPort();
    const { runtime, asked } = bashRuntime({ port, denyRules: [{ tool: BASH_TOOL_NAME, patterns: ["git push *"] }] });

    const denied = await runtime.callTool(BASH_TOOL_NAME, { command: "git push origin main" });
    // The control: an ALLOWED call through the same runtime does reach the port,
    // so "never reached assess" above is the denial's doing, not a dead port.
    const allowed = await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(denied.kind).toBe("denied");
    expect(allowed.kind).toBe("denied");
    expect(calls.map((call) => call.input)).toEqual([{ command: "echo hi" }]);
    expect(asked.requests).toHaveLength(1);
  });

  test("US-018: a policy ask keeps one ask with the stronger exposure reason", async () => {
    const { port, calls } = flaggingPort();
    const askRuleRuntime = bashRuntime({ port, askRules: [{ tool: BASH_TOOL_NAME, patterns: ["echo hi"] }] });

    const askedCall = await askRuleRuntime.runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    // Both a policy ask and an allowed call consult the guard, without asking twice.
    const control = bashRuntime({ port });
    const flagged = await control.runtime.callTool(BASH_TOOL_NAME, { command: "echo bye" });

    expect(askedCall.kind).toBe("denied");
    expect(askRuleRuntime.asked.requests).toHaveLength(1);
    expect(askRuleRuntime.asked.requests[0]?.reason).toBe(REASON);
    expect(askRuleRuntime.asked.requests[0]?.rule).toBe("web-exposure");
    expect(flagged.kind).toBe("denied");
    expect(calls.map((call) => call.input)).toEqual([{ command: "echo hi" }, { command: "echo bye" }]);
  });

  test("AC-15: a throwing assess fails closed with the failure as the reason", async () => {
    const { runtime, asked, launched } = bashRuntime({ port: throwingPort() });

    await runtime.callTool(BASH_TOOL_NAME, { command: "echo hi" });

    expect(asked.requests).toHaveLength(1);
    expect(asked.requests[0]?.reason).toBe("web exposure guard failed: boom");
    expect(launched).toEqual([]);
  });

  test("AC-16: a flagged web__fetch call reaches the ask resolver under its own name", async () => {
    const { port } = flaggingPort();
    const asked = recordingResolver("deny");
    const fetched: Record<string, unknown>[] = [];
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: FETCH_TOOL, patterns: ["*"] }], root),
      extraTools: [stubTool(FETCH_TOOL, (input) => void fetched.push(input))],
      askResolver: asked.resolver,
      webExposure: port,
    });

    await runtime.callTool(FETCH_TOOL, { url: "https://evil.example/p" });

    expect(asked.requests).toHaveLength(1);
    expect(asked.requests[0]?.tool).toBe(FETCH_TOOL);
    expect(fetched).toEqual([]);
  });
});
