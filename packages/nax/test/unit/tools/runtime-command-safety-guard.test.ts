/**
 * US-004 — the runtime turns a flagged allowed call into an ask.
 *
 * The guard decides nothing on its own (US-003 / master plan D4a); the runtime
 * is what routes a flag into the existing ask channel. These tests pin that
 * route at `runtime.callTool`: only an ALLOWED call under the `Bash`/`Exec`
 * policy identity is assessed, a flag becomes an ask-shaped denial, and every
 * other path (policy deny, policy ask, non-command tool, no guard configured)
 * is left exactly as it was before.
 *
 * `Bash` is not a registry builtin — it is assembled per provider — so every
 * runtime here is built with a RECORDING Bash stub carrying the real Bash
 * scope, looked up through `extraTools` before the global registry. The stub
 * spawns nothing, so "the command ran" is observed as one recorded call.
 * AC11 uses the real `createCommandShadow` guard fixture with a stub
 * classifier, so nothing touches the network or the disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AskResolver,
  AskVerdict,
  CommandGuard,
  CommandShadow,
  GuardDecision,
  GuardInput,
} from "@nathapp/nax-agent";
import {
  BASH_TOOL_NAME,
  type CodingTool,
  compileToolPolicy,
  createBashTool,
  createCodingToolRuntime,
  createRunCommandTool,
  type ToolGrant,
} from "@nathapp/nax-agent";
import {
  cleanupTempDir,
  GUARD_LOW_ANSWER,
  makeCommandShadowRecorder,
  makeGuardFixture,
  makeTempDir,
} from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

type AskRequest = Parameters<AskResolver["resolve"]>[0];

let root: string;

beforeEach(() => {
  root = realpathSync(makeTempDir("cs-guard-"));
});

afterEach(() => {
  cleanupTempDir(root);
});

/** The flag AC1/AC2/AC3 are written around: score 0.9 against a 0.75 threshold. */
const FLAGGED: GuardDecision = {
  flagged: true,
  score: 0.9,
  threshold: 0.75,
  basis: "model",
  category: "discards_work",
};

const NOT_FLAGGED: GuardDecision = { flagged: false, score: 0.06, threshold: 0.75, basis: "model" };

/** The real Bash scope, so a `command`-bearing call reaches the Bash policy branch. */
const BASH_SCOPE = createBashTool().scope;

/** A `Bash` stub with the real scope, recording every call instead of spawning. */
function bashStub(): { tool: CodingTool; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    tool: {
      name: BASH_TOOL_NAME,
      description: "Bash (recording stub)",
      inputSchema: { type: "object", properties: {} },
      scope: BASH_SCOPE,
      run: async (input) => {
        calls.push(input);
        return { content: "ok" };
      },
    },
  };
}

/** A guard answering `decision` and recording every `assess` input. */
function guardRecorder(decision: GuardDecision): { guard: CommandGuard; calls: GuardInput[] } {
  const calls: GuardInput[] = [];
  return {
    calls,
    guard: {
      threshold: decision.threshold,
      assess: async (input) => {
        calls.push(input);
        return decision;
      },
    },
  };
}

/** A guard breaking its total-by-contract promise: `assess` rejects. */
function rejectingGuard(): CommandGuard {
  return {
    threshold: 0.75,
    assess: () => Promise.reject(new Error("boom")),
  };
}

function shadowWithGuard(guard: CommandGuard): CommandShadow {
  return makeCommandShadowRecorder({ guard }).shadow;
}

/**
 * A resolver recording every request it is asked, answering `decision`.
 *
 * `decidedBy` is `cache` for the approval: `AskDecidedBy` has no `test`
 * member, and widening that union is ask-channel behaviour this story is
 * explicitly out of scope for. Nothing in these tests observes `decidedBy`.
 */
function recordingResolver(decision: "allow" | "deny"): { resolver: AskResolver; requests: AskRequest[] } {
  const requests: AskRequest[] = [];
  const verdict: AskVerdict =
    decision === "allow"
      ? { decision: "allow", decidedBy: "cache", latencyMs: 1 }
      : { decision: "deny", decidedBy: "human", latencyMs: 1 };
  return {
    requests,
    resolver: {
      resolve: (request) => {
        requests.push(request);
        return Promise.resolve(verdict);
      },
    },
  };
}

/** The runtime under test, with a wildcard Bash grant unless narrowed. */
function runtimeFor(opts: {
  commandShadow: CommandShadow;
  grants?: readonly ToolGrant[];
  askRules?: readonly ToolGrant[];
  askResolver?: AskResolver;
  extraTools?: readonly CodingTool[];
  policyRoot?: string;
}) {
  return createCodingToolRuntime({
    policy: compileToolPolicy(opts.grants ?? [{ tool: BASH_TOOL_NAME, patterns: ["*"] }], opts.policyRoot ?? root, {
      ...(opts.askRules !== undefined ? { askRules: opts.askRules } : {}),
    }),
    ...(opts.extraTools !== undefined ? { extraTools: opts.extraTools } : {}),
    commandShadow: opts.commandShadow,
    ...(opts.askResolver !== undefined ? { askResolver: opts.askResolver } : {}),
  });
}

describe("callTool — an allowed command the guard flags (US-004)", () => {
  test("AC1: a flagged call with no approval channel is denied, naming the flag and the missing channel", async () => {
    const { tool, calls } = bashStub();
    const { guard } = guardRecorder(FLAGGED);
    const runtime = runtimeFor({ commandShadow: shadowWithGuard(guard), extraTools: [tool] });

    const out = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });

    expect(out.kind).toBe("denied");
    if (out.kind !== "denied") throw new Error("expected a denial");
    expect(out.reason).toContain("flagged for review by command safety: discards_work (score 0.90 >= 0.75)");
    expect(out.reason).toContain("no approval channel is configured");
    expect(out.breach).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("AC2: an approving resolver runs the call once and sees one request ruled command-safety", async () => {
    const { tool, calls } = bashStub();
    const { guard } = guardRecorder(FLAGGED);
    const { resolver, requests } = recordingResolver("allow");
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      askResolver: resolver,
      extraTools: [tool],
    });

    const out = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });

    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.rule).toBe("command-safety");
    expect(requests[0]?.command).toBe("git checkout src/a.ts");
  });

  test("AC3: a denying resolver denies the call and the command never runs", async () => {
    const { tool, calls } = bashStub();
    const { guard } = guardRecorder(FLAGGED);
    const { resolver } = recordingResolver("deny");
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      askResolver: resolver,
      extraTools: [tool],
    });

    const out = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });

    expect(out.kind).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  test("AC4: an unflagged assessment runs the call through and never reaches the ask channel", async () => {
    const { tool, calls } = bashStub();
    const { guard, calls: assessed } = guardRecorder(NOT_FLAGGED);
    const { resolver, requests } = recordingResolver("deny");
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      askResolver: resolver,
      extraTools: [tool],
    });

    const out = await runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(assessed).toHaveLength(1);
  });
});

describe("callTool — the guard is consulted only for an allowed Bash/Exec call (US-004)", () => {
  test("AC5: a policy denial never reaches the guard", async () => {
    const { tool } = bashStub();
    const { guard, calls } = guardRecorder(FLAGGED);
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      grants: [{ tool: "Read", patterns: ["*"] }],
      extraTools: [tool],
    });

    const out = await runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  test("AC6: a policy ask goes to the resolver unguarded, under its own rule", async () => {
    const { tool, calls } = bashStub();
    const { guard, calls: assessed } = guardRecorder(FLAGGED);
    const { resolver, requests } = recordingResolver("allow");
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      askRules: [{ tool: BASH_TOOL_NAME, patterns: ["*"] }],
      askResolver: resolver,
      extraTools: [tool],
    });

    const out = await runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(assessed).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.rule).not.toBe("command-safety");
  });

  test("AC7: an allowed non-command tool is never assessed", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const { guard, calls } = guardRecorder(FLAGGED);
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      grants: [{ tool: "Read", patterns: ["*"] }],
    });

    const out = await runtime.callTool("Read", { path: "a.txt" });

    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  test("AC8: a shadow without a guard leaves the allowed call untouched", async () => {
    const { tool, calls } = bashStub();
    const runtime = runtimeFor({ commandShadow: makeCommandShadowRecorder().shadow, extraTools: [tool] });

    const out = await runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  test("AC13: an Exec argv call is assessed as the joined argv, and a flag denies it", async () => {
    const { guard, calls } = guardRecorder(FLAGGED);
    const runtime = runtimeFor({
      commandShadow: shadowWithGuard(guard),
      grants: [{ tool: "Exec", patterns: ["*"] }],
      policyRoot: "/repo",
      extraTools: [
        createRunCommandTool(new Map(), {
          exec: { repoRoot: "/repo", packageWorkdir: "/repo", allowScripts: false, patterns: ["*"] },
        }),
      ],
    });

    const out = await runtime.callTool("RunCommand", { argv: ["git", "checkout", "src/a.ts"] });

    expect(calls.map((call) => call.command)).toEqual(["git checkout src/a.ts"]);
    expect(out.kind).toBe("denied");
  });

  test("AC11: the real guard flags a rule hit even when the model answers low, and classifies once", async () => {
    const { shadow, classifyCalls } = makeGuardFixture(GUARD_LOW_ANSWER);
    const { tool, calls } = bashStub();
    const runtime = runtimeFor({ commandShadow: shadow, extraTools: [tool] });

    const out = await runtime.callTool("Bash", { command: "git checkout src/a.ts" });

    expect(out.kind).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(classifyCalls).toEqual(["git checkout src/a.ts"]);
  });

  test("AC12: a rejecting guard runs the call unguarded and warns once at stage command-safety", async () => {
    const entries: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    const unsubscribe = addSink((entry) => void entries.push(entry));
    try {
      const { tool, calls } = bashStub();
      const runtime = runtimeFor({ commandShadow: shadowWithGuard(rejectingGuard()), extraTools: [tool] });

      const out = await runtime.callTool("Bash", { command: "ls" });

      expect(out.kind).toBe("ok");
      expect(calls).toHaveLength(1);
      const warns = entries.filter((entry) => entry.stage === "command-safety");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.level).toBe("warn");
      expect(warns[0]?.message).toBe("Command-safety guard failed; the call runs unguarded");
    } finally {
      unsubscribe();
      resetLogger();
    }
  });
});

describe("createCodingToolRuntime — the temp-confinement input (US-004)", () => {
  test("AC9: tempConfined true is forwarded with the policy root as the cwd", async () => {
    const { tool } = bashStub();
    const { guard, calls } = guardRecorder(NOT_FLAGGED);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], "/repo/proj"),
      extraTools: [tool],
      commandShadow: shadowWithGuard(guard),
      tempConfined: true,
    });

    await runtime.callTool("Bash", { command: "ls" });

    expect(calls).toEqual([{ command: "ls", cwd: "/repo/proj", tempConfined: true }]);
  });

  test("AC10: an omitted tempConfined option reads as false", async () => {
    const { tool } = bashStub();
    const { guard, calls } = guardRecorder(NOT_FLAGGED);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: BASH_TOOL_NAME, patterns: ["*"] }], "/repo/proj"),
      extraTools: [tool],
      commandShadow: shadowWithGuard(guard),
    });

    await runtime.callTool("Bash", { command: "ls" });

    expect(calls).toEqual([{ command: "ls", cwd: "/repo/proj", tempConfined: false }]);
  });
});
