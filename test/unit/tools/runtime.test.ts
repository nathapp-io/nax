import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "@test/helpers";
import {
  _codingToolDeps,
  _resetBuiltinsForTest,
  _resetRegistryForTest,
  compileToolPolicy,
  createCodingToolRuntime,
  registerCodingTool,
} from "@/tools";
import { _gitDeps } from "@/utils/git";

let root: string;
let gitRoot: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-runtime-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");

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
      resultBytes: "const a = 1;\n".length,
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
