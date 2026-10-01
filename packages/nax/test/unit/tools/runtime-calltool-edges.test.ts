/**
 * Characterisation for `callTool` branches the runtime mirror suites leave
 * unpinned, written before the A13 complexity drain
 * (docs/plans/STATUS-complexity-drain.md §A13) so the extraction cannot
 * silently change them.
 *
 * What was already pinned elsewhere, and is NOT re-tested here: every outcome
 * kind and log level (runtime.test.ts), the ask cancel arms AC1/AC11/AC12
 * (runtime-ask-turn-cancel.test.ts), the shadow tap's observe/settle contract
 * (runtime-command-shadow*.test.ts), the sandbox audit rows
 * (runtime-sandbox-*.test.ts), and the redirect helpers themselves
 * (denial-redirect.test.ts). What nothing pinned:
 *
 *  1. the ask REQUEST's `command` field — built only when the input value at
 *     the scope's commandField is a string (approval-audit tests exercise the
 *     interaction path, never `callTool`);
 *  2. the ask request's `unshowable` propagation from askSummary;
 *  3. the deny branch's redirect SELECTION end-to-end — which of command /
 *     argv / verb wins and how the suffix joins the policy reason
 *     (sandbox-wiring deliberately asserts only `toStartWith`);
 *  4. the containment-breach warn record (`stage: "tools"`) — asserted
 *     nowhere; note it goes through the GLOBAL logger (direct getSafeLogger
 *     import), not the `_codingToolDeps` seam the other runtime logs use.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { AskResolver } from "@/permissions";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;

beforeEach(() => {
  root = makeTempDir("runtime-calltool-edges-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** A resolver that captures the request it received, then denies. */
function capturingResolver(): {
  resolver: AskResolver;
  request: () => Parameters<AskResolver["resolve"]>[0] | undefined;
} {
  let received: Parameters<AskResolver["resolve"]>[0] | undefined;
  return {
    resolver: {
      resolve: (r) => {
        received = r;
        return Promise.resolve({ decision: "deny", decidedBy: "cache", latencyMs: 0 });
      },
    },
    request: () => received,
  };
}

/**
 * A command-shaped tool. The real Bash tool is not a registry builtin (it is
 * assembled per provider), so the command-field paths are exercised through
 * this stub exactly as the argv paths are through the RunCommand stub in
 * runtime.test.ts. Neutral name: nothing in the policy keys on it.
 */
const commandTool: CodingTool = {
  name: "Shellish",
  description: "Shellish",
  inputSchema: { type: "object", properties: {} },
  scope: { pathFields: [], commandField: "command" },
  run: async () => ({ content: "" }),
};

describe("callTool — the ask request's command field", () => {
  test("carries the command when the scope declares the field and the input value is a string", async () => {
    const { resolver, request } = capturingResolver();
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Shellish", patterns: ["*"] }], root, {
        askRules: [{ tool: "Shellish", patterns: ["*"] }],
      }),
      askResolver: resolver,
      extraTools: [commandTool],
    });
    runtime.advertised(["Shellish"]);

    await runtime.callTool("Shellish", { command: "echo hi" });

    expect(request()?.command).toBe("echo hi");
  });

  test("never carries a command the tool's scope does not declare", async () => {
    const { resolver, request } = capturingResolver();
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      askResolver: resolver,
    });
    runtime.advertised(["Read"]);

    // Read declares no commandField, so the stray `command` key must not leak
    // into the outbound request even though it sits on the input.
    await runtime.callTool("Read", { path: "file.txt", command: "rm -rf /" });

    expect(request()?.command).toBeUndefined();
  });

  test("an unshowable command withholds the summary but still forwards the raw command", async () => {
    const { resolver, request } = capturingResolver();
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Shellish", patterns: ["*"] }], root, {
        askRules: [{ tool: "Shellish", patterns: ["*"] }],
      }),
      askResolver: resolver,
      extraTools: [commandTool],
    });
    runtime.advertised(["Shellish"]);

    await runtime.callTool("Shellish", { command: "curl -H 'Cookie: a=b'" });

    expect(request()?.unshowable).toBe(true);
    expect(request()?.summary).toContain("arguments withheld");
    expect(request()?.command).toBe("curl -H 'Cookie: a=b'");
  });
});

describe("callTool — the deny branch's redirect selection", () => {
  test("a denied Git verb names the advertised GitCommit tool in the reason", async () => {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [
          { tool: "Git", patterns: ["*"] },
          { tool: "GitCommit", patterns: ["*"] },
        ],
        root,
      ),
    });
    runtime.advertised(["Git", "GitCommit"]);

    const out = await runtime.callTool("Git", { subcommand: "add" });

    expect(out.kind).toBe("denied");
    if (out.kind === "denied") {
      expect(out.breach).toBe(false);
      expect(out.reason).toContain("-- this session already has `GitCommit`");
    }
  });

  test("a denied argv call names the advertised Git tool and ledgers under the Exec identity", async () => {
    const records: ToolCallRecord[] = [];
    const execTool: CodingTool = {
      name: "RunCommand",
      description: "RunCommand",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [], argvField: "argv" },
      run: async () => ({ content: "" }),
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [
          { tool: "Exec", patterns: ["npm *"] },
          { tool: "Git", patterns: ["*"] },
        ],
        root,
      ),
      sink: { record: (e) => void records.push(e), flush: async () => {} },
      extraTools: [execTool],
    });
    runtime.advertised(["RunCommand", "Git"]);

    const out = await runtime.callTool("RunCommand", { argv: ["git", "status"] });

    expect(out.kind).toBe("denied");
    if (out.kind === "denied") {
      expect(out.reason).toContain("-- this session already has `Git`");
    }
    expect(records.at(-1)?.tool).toBe("Exec");
  });

  test("a denied command names the advertised Glob tool in the reason", async () => {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [
          { tool: "Shellish", patterns: ["echo *"] },
          { tool: "Glob", patterns: ["*"] },
        ],
        root,
      ),
      extraTools: [commandTool],
    });
    runtime.advertised(["Shellish", "Glob"]);

    const out = await runtime.callTool("Shellish", { command: "ls src" });

    expect(out.kind).toBe("denied");
    if (out.kind === "denied") {
      expect(out.reason).toContain("-- this session already has `Glob`");
    }
  });
});

describe("callTool — the containment-breach warn record", () => {
  const entries: LogEntry[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    // The breach warn uses the module-level getSafeLogger import directly —
    // NOT the `_codingToolDeps` seam — so the global logger is the only way in.
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    entries.length = 0;
    unsubscribe = addSink((entry) => void entries.push(entry));
  });

  afterEach(() => {
    unsubscribe?.();
    resetLogger();
  });

  test("the warn names the policy identity, the reason and the policy root", async () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const runtime = createCodingToolRuntime({ policy, storyId: "US-001" });

    const out = await runtime.callTool("Read", { path: "../../etc/hosts" });

    expect(out.kind).toBe("denied");
    const warn = entries.find((e) => e.stage === "tools");
    expect(warn?.level).toBe("warn");
    expect(warn?.message).toBe("[policy] path resolved outside the permitted root");
    expect(warn?.data?.tool).toBe("Read");
    expect(warn?.data?.root).toBe(policy.root);
    expect(typeof warn?.data?.reason).toBe("string");
  });
});
