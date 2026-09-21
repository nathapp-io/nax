import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "@test/helpers";
import type { AskResolver } from "@/permissions";
import {
  _codingToolDeps,
  _resetBuiltinsForTest,
  _resetRegistryForTest,
  type CodingTool,
  compileToolPolicy,
  createCodingToolRuntime,
  registerCodingTool,
} from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";
import { _gitDeps } from "@/utils/git";

let root: string;
let gitRoot: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-runtime-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
  // The ask-resolution tests below read `file.txt`; without it a missing file
  // would surface as kind:"error" and masquerade as a broken ask path.
  writeFileSync(join(root, "file.txt"), "hello");

  // A real git repo, for the Git-tool hard-boundary and no-regression tests
  // below — status/log/show run for real rather than through a mock, so a
  // regression in the argv builder would surface as a genuine git failure.
  gitRoot = mkdtempSync(join(tmpdir(), "nax-runtime-git-"));
  mkdirSync(join(gitRoot, "src"), { recursive: true });
  writeFileSync(join(gitRoot, "src", "a.ts"), "const a = 1;\n");
  const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: gitRoot, stdout: "pipe", stderr: "pipe" });
  await run(["init", "-q"]).exited;
  await run(["config", "user.email", "test@example.com"]).exited;
  await run(["config", "user.name", "Test"]).exited;
  await run(["add", "-A"]).exited;
  await run(["commit", "-q", "-m", "initial"]).exited;
});

function runtimeWith(grants: { tool: string; patterns: string[] }[], forRoot: string = root) {
  return createCodingToolRuntime({ policy: compileToolPolicy(grants, forRoot) });
}

describe("createCodingToolRuntime", () => {
  test("executes a permitted call", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain("const a = 1;");
  });

  // The distinction ADR-029 section 5 exists to protect: a refusal is not a crash.
  test("a policy refusal is 'denied', not 'error'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["docs/**"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("denied");
  });

  test("an ungranted tool is denied", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect((await rt.callTool("Write", { path: "src/a.ts", content: "x" })).kind).toBe("denied");
  });

  test("a containment breach is denied and flagged", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "../../etc/hosts" });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
  });

  test("a failing tool is 'error', distinct from 'denied'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/missing.ts" });
    expect(out.kind).toBe("error");
  });

  test("an unknown tool name is denied", async () => {
    const rt = runtimeWith([{ tool: "Nope", patterns: ["*"] }]);
    expect((await rt.callTool("Nope", {})).kind).toBe("denied");
  });

  test("a thrown tool becomes 'error', never an escaped exception", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }]);
    // A permitted verb that fails at execution (no git repo here): the verb
    // gate denies unknown subcommands before the tool runs, so failure must
    // come from the tool itself, surfacing as 'error', not 'denied'.
    const out = await rt.callTool("Git", { subcommand: "status" });
    expect(out.kind).toBe("error");
  });
});

describe("callTool — ask resolution (spec US-007)", () => {
  test("headless default refuses an ask-matched call with the ask reason and ledgers denied:ask", async () => {
    const records: { outcome: string; reason?: string }[] = [];
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      sink: { record: (e) => void records.push(e), flush: async () => {} },
    });
    runtime.advertised(["Read"]);
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(outcome.reason).toContain("approval");
      expect(outcome.breach).toBe(false);
    }
    expect(records.at(-1)?.outcome).toBe("denied:ask");
  });

  test("an approving resolver lets the call run", async () => {
    const approveAll: AskResolver = { resolve: () => Promise.resolve("allow") };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      askResolver: approveAll,
    });
    runtime.advertised(["Read"]);
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("ok");
  });

  test("passes the matched rule expression to an ask resolver", async () => {
    let request: Parameters<AskResolver["resolve"]>[0] | undefined;
    const resolver: AskResolver = {
      resolve: (received) => {
        request = received;
        return Promise.resolve("deny");
      },
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["file.txt"] }],
      }),
      askResolver: resolver,
    });

    await runtime.callTool("Read", { path: "file.txt" });
    expect(request?.rule).toBe("Read(file.txt)");
  });

  test("carries the pipeline stage and a payload-free summary to an ask resolver", async () => {
    let request: Parameters<AskResolver["resolve"]>[0] | undefined;
    const resolver: AskResolver = {
      resolve: (received) => {
        request = received;
        return Promise.resolve("deny");
      },
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root, {
        askRules: [{ tool: "Write", patterns: ["*"] }],
      }),
      askResolver: resolver,
      pipelineStage: "rectification",
    });

    await runtime.callTool("Write", { path: "src/a.ts", content: "SUPER-SECRET-PAYLOAD" });
    expect(request?.stage).toBe("rectification");
    expect(request?.summary).toContain("src/a.ts");
    expect(request?.summary).not.toContain("SUPER-SECRET-PAYLOAD");
  });

  test("contains a rejecting ask resolver as a tool error", async () => {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      askResolver: { resolve: () => Promise.reject(new Error("approval backend offline")) },
    });

    const outcome = await runtime.callTool("Read", { path: "file.txt" });

    expect(outcome).toEqual({ kind: "error", content: "approval backend offline" });
  });

  test("plain denials never consult the resolver", async () => {
    let consulted = 0;
    const counting: AskResolver = {
      resolve: () => {
        consulted++;
        return Promise.resolve("allow");
      },
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([], root), // nothing granted
      askResolver: counting,
    });
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("denied");
    expect(consulted).toBe(0);
  });
});

describe("advertised", () => {
  test("intersects the op's declaration with the policy's grants", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Glob", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read", "Write"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("a tool granted but not declared is not advertised", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Git", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("declaring nothing advertises nothing", () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect(rt.advertised([])).toEqual([]);
  });
});

describe("Git — paths and refs are contained within the permitted root", () => {
  test("an escaping paths entry is denied as a breach", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }], gitRoot);
    const out = await rt.callTool("Git", { subcommand: "diff", paths: ["../outside/secret.txt"] });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
  });

  test("an escaping <rev>:<path> ref is denied as a breach", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }], gitRoot);
    const out = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD:../outside/secret.ts"] });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
  });

  test("an in-root paths entry and a pure-revision ref are not denied", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }], gitRoot);
    const out = await rt.callTool("Git", { subcommand: "log", refs: ["HEAD"], paths: ["src/a.ts"] });
    expect(out.kind).not.toBe("denied");
    expect(out.kind).toBe("ok");
  });

  test("a ref with an empty path after ':' is treated as no path to check", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }], gitRoot);
    // "HEAD:" (empty path after the colon) refers to the root tree — valid
    // git syntax, and exactly the "no path to check" case the policy must
    // not crash on.
    const out = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD:"] });
    expect(out.kind).not.toBe("denied");
  });
});

// No built-in can throw — every failure path returns isError — so the
// runtime's catch branch needs a custom tool to be exercised at all.
describe("a thrown tool", () => {
  afterEach(() => {
    _resetRegistryForTest();
    _resetBuiltinsForTest();
  });

  test("becomes 'error', never an escaped exception", async () => {
    registerCodingTool({
      name: "Thrower",
      description: "Always throws, to exercise the runtime's containment.",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => {
        throw new Error("boom from Thrower");
      },
    });
    const rt = runtimeWith([{ tool: "Thrower", patterns: ["*"] }]);
    const out = await rt.callTool("Thrower", {});
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.content).toContain("boom from Thrower");
  });

  test("shapes an oversized thrown error before returning it to the model", async () => {
    registerCodingTool({
      name: "LargeThrower",
      description: "Throws a large error to exercise model-facing shaping.",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => {
        throw new Error("x".repeat(1_000));
      },
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "LargeThrower", patterns: ["*"] }], root),
      maxBytes: 32,
    });

    const out = await rt.callTool("LargeThrower", {});

    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(32);
  });
});

describe("after the thrown-tool cleanup", () => {
  test("built-ins re-register on the next runtime creation", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain("const a = 1;");
  });
});

/**
 * Observability: every coding-tool call is logged.
 *
 * Its sibling subsystem logs one `pull-tool`/`invoked` line per call, and that
 * is how "did the reviewer actually use a tool" gets answered from a run
 * record. Coding tools logged only policy breaches, so zero calls and zero
 * tools advertised looked identical — which is precisely how the first Phase C1
 * A/B was misread as "the model chose not to use its tools" when in fact it had
 * none. The ADR now requires a parity claim to show tools were invoked; this is
 * the line it reads.
 */
describe("createCodingToolRuntime — invocation logging", () => {
  let logger: ReturnType<typeof makeLogger>;
  let orig: typeof _codingToolDeps.getLogger;

  beforeEach(() => {
    logger = makeLogger();
    orig = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
  });

  afterEach(() => {
    _codingToolDeps.getLogger = orig;
  });

  // The message now names the tool and outcome ("Read ok"), so the selector
  // matches on stage; the level is asserted per-case because it is what the
  // console formatter filters on.
  function invoked() {
    return logger.calls.filter((c) => c.stage === "coding-tool");
  }

  test("logs a successful call with the story, tool and output size", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      storyId: "US-002",
    });

    const outcome = await rt.callTool("Read", { path: "src/a.ts" });

    expect(outcome.kind).toBe("ok");
    expect(invoked()).toHaveLength(1);
    expect(invoked()[0]?.level).toBe("debug");
    expect(invoked()[0]?.message).toBe("Read ok");
    expect(invoked()[0]?.data).toEqual({
      storyId: "US-002",
      tool: "Read",
      outcome: "ok",
      // The unranged Read now leads with a `[N lines]\n` header, so the
      // measured result size is the header plus the body.
      resultBytes: "[1 lines]\n".length + "const a = 1;\n".length,
    });
  });

  test("logs a denial, so a refused call is visible and not silence", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      storyId: "US-002",
    });

    await rt.callTool("Write", { path: "src/a.ts", content: "x" });

    // A denial is an operator-facing event, so it must not be demoted to the
    // debug level the console drops.
    expect(invoked()[0]?.level).toBe("warn");
    expect(invoked()[0]?.data).toMatchObject({ tool: "Write", outcome: "denied" });
    expect(invoked()[0]?.data?.error).toBeTruthy();
  });

  test("storyId is the first key, per the structured-log convention", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      storyId: "US-002",
    });

    await rt.callTool("Read", { path: "src/a.ts" });

    expect(Object.keys(invoked()[0]?.data ?? {})[0]).toBe("storyId");
  });
});

/**
 * Unit tests for coding-tool console signal (log level + failure reason).
 *
 * Every outcome is still recorded — the audit sink and the JSONL are unchanged.
 * What differs is the level, which is what the console formatter filters on:
 *
 *  - `ok`                        -> debug (bulk; 1020 of 1165 calls in one run)
 *  - `error` on a routineErrors  -> debug (RunCommand: the agent's own gate
 *    tool                                 loop, where a non-zero exit is TDD red)
 *  - `error` on any other tool   -> warn  (a malformed Read/Edit/GitCommit)
 *  - `denied`                    -> warn, or error when the policy flagged a
 *                                   breach (a path escaping the root)
 *
 * The reason travels under the `error` data key so the formatter's existing
 * readFailureReason() renders it inline — previously these lines printed as a
 * bare "coding-tool invoked" with no tool name and no reason at all, so 145
 * visible failures in one observed run identified neither.
 */

/** A stub tool whose single result is fixed, so only the logging is under test. */
function makeTool(name: string, result: { content: string; isError?: boolean }, routineErrors?: boolean): CodingTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    ...(routineErrors === undefined ? {} : { routineErrors }),
    run: async () => result,
  };
}

describe("coding-tool log levels", () => {
  let logger: ReturnType<typeof makeLogger>;
  let orig: typeof _codingToolDeps.getLogger;

  beforeEach(() => {
    logger = makeLogger();
    orig = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
  });

  afterEach(() => {
    _codingToolDeps.getLogger = orig;
  });

  const records = () => logger.calls.filter((c) => c.stage === "coding-tool");

  function runtimeWithTool(tool: CodingTool) {
    return createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
      storyId: "US-001",
      extraTools: [tool],
    });
  }

  test("a successful call is recorded at debug, not info", async () => {
    const rt = runtimeWithTool(makeTool("Ok", { content: "fine" }));
    const outcome = await rt.callTool("Ok", {});

    expect(outcome.kind).toBe("ok");
    expect(records()).toHaveLength(1);
    expect(records()[0]?.level).toBe("debug");
    expect(records()[0]?.data?.tool).toBe("Ok");
    expect(records()[0]?.data?.outcome).toBe("ok");
  });

  test("an error on an ordinary tool warns and carries the reason", async () => {
    const rt = runtimeWithTool(makeTool("Boom", { content: "no such file: a.ts", isError: true }));
    const outcome = await rt.callTool("Boom", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.data?.tool).toBe("Boom");
    expect(records()[0]?.data?.error).toBe("no such file: a.ts");
  });

  test("the message names the tool and outcome so the console line is legible", async () => {
    const rt = runtimeWithTool(makeTool("Boom", { content: "bad", isError: true }));
    await rt.callTool("Boom", {});

    expect(records()[0]?.message).toBe("Boom error");
  });

  test("an error on a routineErrors tool stays at debug", async () => {
    const rt = runtimeWithTool(makeTool("Runner", { content: "exit 1\nlint failed", isError: true }, true));
    const outcome = await rt.callTool("Runner", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("debug");
  });

  test("a routineErrors error is still recorded, with its reason", async () => {
    const rt = runtimeWithTool(makeTool("Runner", { content: "exit 1", isError: true }, true));
    await rt.callTool("Runner", {});

    expect(records()).toHaveLength(1);
    expect(records()[0]?.data?.outcome).toBe("error");
    expect(records()[0]?.data?.error).toBe("exit 1");
  });

  test("a thrown tool is a warning, carrying the thrown message", async () => {
    const thrower: CodingTool = {
      ...makeTool("Thrower", { content: "" }),
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const rt = runtimeWithTool(thrower);
    const outcome = await rt.callTool("Thrower", {});

    expect(outcome.kind).toBe("error");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.data?.error).toBe("kaboom");
  });

  test("an unknown tool is denied at warn with the reason", async () => {
    const rt = runtimeWithTool(makeTool("Ok", { content: "fine" }));
    const outcome = await rt.callTool("Nope", {});

    expect(outcome.kind).toBe("denied");
    expect(records()[0]?.level).toBe("warn");
    expect(records()[0]?.message).toBe("Nope denied");
    expect(String(records()[0]?.data?.error)).toContain("unknown tool");
  });

  test("a containment breach is an error, not a warning", async () => {
    // A path escaping the root can indicate prompt injection, so it is the one
    // tool outcome that earns the error level.
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      storyId: "US-001",
    });
    const outcome = await rt.callTool("Read", { path: "../elsewhere/secret.txt" });

    expect(outcome.kind).toBe("denied");
    const denial = records().find((c) => c.data?.outcome === "denied");
    expect(denial?.level).toBe("error");
    expect(denial?.data?.error).toBeTruthy();
  });

  test("an ordinary pattern denial is a warning, not an error", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["src/**"] }], root),
      storyId: "US-001",
    });
    const outcome = await rt.callTool("Write", { path: "src/a.ts", content: "x" });

    expect(outcome.kind).toBe("denied");
    expect(records()[0]?.level).toBe("warn");
  });

  test("storyId is still the first data key, per the structured-log convention", async () => {
    const rt = runtimeWithTool(makeTool("Ok", { content: "fine" }));
    await rt.callTool("Ok", {});

    expect(Object.keys(records()[0]?.data ?? {})[0]).toBe("storyId");
  });
});

describe("ledger fields reach the sink, not only the console logger", () => {
  let logger: ReturnType<typeof makeLogger>;
  let orig: typeof _codingToolDeps.getLogger;
  let recorded: ToolCallRecord[];
  const sink = {
    record: (entry: ToolCallRecord) => {
      recorded.push(entry);
    },
    flush: async () => {},
  };

  beforeEach(() => {
    logger = makeLogger();
    orig = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
    recorded = [];
  });

  afterEach(() => {
    _codingToolDeps.getLogger = orig;
  });

  test("a denial's reason is not dropped before sink.record -- error: null no longer loses it", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["src/**"] }], root),
      storyId: "US-001",
      sink,
    });
    await rt.callTool("Write", { path: "src/a.ts", content: "x" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("denied");
    expect(recorded[0]?.reason).toBeTruthy();
  });

  test("an argv call's ledger row carries executed and target alongside the requested argv", async () => {
    const execTool: CodingTool = {
      name: "RunCommand",
      description: "RunCommand",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [], argvField: "argv" },
      run: async () => ({
        content: "exit 0",
        audit: { executed: ["bun", "install", "--ignore-scripts"], target: "repoRoot" as const },
      }),
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["bun *"] }], root),
      storyId: "US-001",
      sink,
      extraTools: [execTool],
    });
    await rt.callTool("RunCommand", { argv: ["bun", "install"], target: "repoRoot" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.tool).toBe("Exec");
    const input = recorded[0]?.input as { argv: string[] } | undefined;
    expect(input?.argv).toEqual(["bun", "install"]);
    expect(recorded[0]?.executed).toEqual(["bun", "install", "--ignore-scripts"]);
    expect(recorded[0]?.target).toBe("repoRoot");
  });
});
