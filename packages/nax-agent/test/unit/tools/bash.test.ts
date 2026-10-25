import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _agentOutputEnvDeps } from "#src/internal/agent-output-env";
import type { CommandLauncher, LaunchRequest } from "#src/sandbox/index";
import { createCommandLauncher, DISABLED_SANDBOX_STATE } from "#src/sandbox/index";
import { _bashToolDeps, BASH_TIMEOUT_MS, createBashTool } from "#src/tools/index";
import { assertDefined, cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

const realRunArgv = _bashToolDeps.runArgv;

let root: string;
let calls: Parameters<typeof realRunArgv>[0][];

function stubRunArgv(result: Partial<Awaited<ReturnType<typeof realRunArgv>>> = {}): void {
  _bashToolDeps.runArgv = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: "out", stderr: "", timedOut: false, ...result };
  };
}

const ctx = (maxBytes = 40_000) => ({ root, resolvedPaths: [], maxBytes, maxFileBytes: 2_000_000 });

/** A launcher that records every request and reports a clean run. */
function recordingLauncher(requests: LaunchRequest[]): CommandLauncher {
  return {
    state: DISABLED_SANDBOX_STATE,
    async run(req) {
      requests.push(req);
      return {
        exitCode: 0,
        stdout: "out",
        stderr: "",
        timedOut: false,
        executed: ["/bin/sh", "-c", "bun test"],
        sandbox: { backend: "none", wrapped: false },
      };
    },
  };
}

/**
 * The tool's `properties` map as an object, never a cast to a Capitalised type
 * (that spelling is what the looseCast ratchet counts).
 */
function schemaProperties(tool: { readonly inputSchema: Record<string, unknown> }): object {
  const properties: unknown = tool.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("expected the tool's inputSchema.properties to be an object");
  }
  return properties;
}

beforeEach(() => {
  root = makeTempDir("bash-tool-");
  calls = [];
});

afterEach(() => {
  _bashToolDeps.runArgv = realRunArgv;
  cleanupTempDir(root);
});

describe("createBashTool", () => {
  test("spawns the configured shell with -c and the command verbatim", async () => {
    stubRunArgv();
    const tool = createBashTool({ shell: "/bin/bash" });
    await tool.run({ command: "bun test && echo done" }, ctx());
    expect(calls[0]?.argv).toEqual(["/bin/bash", "-c", "bun test && echo done"]);
  });

  test("defaults to /bin/sh and runs in the permitted root, not the process cwd", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test" }, ctx());
    expect(calls[0]?.argv[0]).toBe("/bin/sh");
    expect(calls[0]?.cwd).toBe(root);
  });

  test("forwards the project's stripEnvVars", async () => {
    stubRunArgv();
    await createBashTool({ stripEnvVars: ["NPM_TOKEN"] }).run({ command: "bun test" }, ctx());
    expect(calls[0]?.stripEnvVars).toEqual(["NPM_TOKEN"]);
  });

  test("US-001 AC12: ToolRunContext.signal reaches runArgv when there is no launcher", async () => {
    const signal = new AbortController().signal;
    stubRunArgv();
    const tool = createBashTool();
    await tool.run({ command: "bun test" }, { ...ctx(), signal });
    expect(calls[0]?.signal).toBe(signal);
  });

  test("defaults the deadline to the Exec ceiling and clamps a larger request", async () => {
    stubRunArgv();
    const tool = createBashTool();
    await tool.run({ command: "bun test" }, ctx());
    expect(calls[0]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
    await tool.run({ command: "bun test", timeoutMs: BASH_TIMEOUT_MS * 10 }, ctx());
    expect(calls[1]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
  });

  test("honours a smaller requested deadline", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test", timeoutMs: 5_000 }, ctx());
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  test("reports exit code and output, and is not an error on exit 0", async () => {
    stubRunArgv({ stdout: "hello", stderr: "" });
    const result = await createBashTool().run({ command: "echo hello" }, ctx());
    expect(result.content).toContain("exit 0");
    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false);
  });

  test("a non-zero exit is an error result, not a throw", async () => {
    stubRunArgv({ exitCode: 1, stderr: "boom" });
    const result = await createBashTool().run({ command: "false" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  test("a timeout says so and reports the deadline", async () => {
    stubRunArgv({ timedOut: true });
    const result = await createBashTool().run({ command: "sleep 999", timeoutMs: 5_000 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 5000ms");
  });

  async function launcherResult(overrides: {
    exitCode: number;
    stdout: string;
    aborted: boolean;
    orphansKilled: boolean;
  }): Promise<{ content: string; isError?: boolean }> {
    const launcher: CommandLauncher = {
      state: DISABLED_SANDBOX_STATE,
      async run() {
        return {
          exitCode: overrides.exitCode,
          stdout: overrides.stdout,
          stderr: "",
          timedOut: false,
          aborted: overrides.aborted,
          orphansKilled: overrides.orphansKilled,
          executed: ["/bin/sh", "-c", "echo hi"],
          sandbox: { backend: "none", wrapped: false },
        };
      },
    };
    return createBashTool({ launcher }).run({ command: "echo hi" }, ctx());
  }

  test("US-001 AC14: an aborted launcher result is an isError opening with the Cancelled line and the partial output", async () => {
    const result = await launcherResult({
      exitCode: -1,
      stdout: "partial output",
      aborted: true,
      orphansKilled: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content.startsWith("Cancelled: the turn ended while this command was running.")).toBe(true);
    expect(result.content).toContain("partial output");
  });

  test("US-001 AC15: an orphansKilled launcher result appends the background-processes line", async () => {
    const result = await launcherResult({ exitCode: 0, stdout: "ok", aborted: false, orphansKilled: true });
    expect(result.content).toContain("ok");
    const lines = result.content.split("\n");
    expect(lines[lines.length - 1]).toStartWith("[nax] background processes still holding the output were killed");
  });

  test("US-003: bash returns up to readCeiling; pre-truncation size reports the full stdout", async () => {
    // US-003 replacement invariant: the tool bounds its I/O at
    // `ctx.readCeiling` (2_000_000 by default), NOT at `ctx.maxBytes`.
    // The model-facing cap and the exit-N preservation are the
    // `after_tool` policy's job, not the tool's. The full stdout
    // length is still surfaced via `resultBytesPreTruncation` so
    // downstream code can size the spill.
    stubRunArgv({ stdout: "x".repeat(5_000) });
    const result = await createBashTool().run({ command: "cat big" }, ctx(100));
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.content).toContain("x");
    expect(result.resultBytesPreTruncation).toBeGreaterThan(5_000);
  });

  test("a missing or empty command is an input error, never a spawn", async () => {
    stubRunArgv();
    for (const input of [{}, { command: "" }, { command: "   " }, { command: 7 }]) {
      const result = await createBashTool().run(input, ctx());
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("a spawn-time throw surfaces as a tool error", async () => {
    _bashToolDeps.runArgv = () => {
      throw new Error("cwd vanished");
    };
    const result = await createBashTool().run({ command: "bun test" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cwd vanished");
  });

  test("the description steers to the structured tools first (spec R2)", () => {
    const description = createBashTool({ patterns: ["bun test *"] }).description;
    expect(description).toContain("bun test *");
    expect(description.toLowerCase()).toContain("prefer");
  });

  test("declares the command field so the policy uses the Bash branch", () => {
    expect(createBashTool().scope.commandField).toBe("command");
  });
});

// US-004: the same AGENT=1 rule the quality and verification runners apply, at
// the agent-facing spawn site. Marker presence is read from the nax process
// environment (`_agentOutputEnvDeps.processEnv`), so these tests control it
// rather than depending on whether the suite itself was launched from an agent
// shell. `env` is passed only when the overlay exists — an inherited marker or a
// stripped AGENT must leave the child's environment to Bun.spawn's own inherit.
describe("US-004 — Bash opts its child into agent-friendly output", () => {
  withDepsRestore(_agentOutputEnvDeps, ["processEnv"]);

  const noMarker = (): Record<string, string | undefined> => ({ PATH: "/usr/bin" });

  test("AC6: with no launcher and no inherited marker, runArgv receives env { AGENT: '1' }", async () => {
    _agentOutputEnvDeps.processEnv = noMarker;
    stubRunArgv();

    await createBashTool().run({ command: "bun test" }, ctx());

    expect(calls[0]?.env).toEqual({ AGENT: "1" });
  });

  test("AC7: an inherited CLAUDECODE speaks for itself — runArgv receives no env key", async () => {
    _agentOutputEnvDeps.processEnv = () => ({ PATH: "/usr/bin", CLAUDECODE: "1" });
    stubRunArgv();

    await createBashTool().run({ command: "bun test" }, ctx());

    assertDefined(calls[0], "the runArgv call");
    expect("env" in calls[0]).toBe(false);
  });

  test("AC8: a configured strip of AGENT is not silently undone — runArgv receives no env key", async () => {
    _agentOutputEnvDeps.processEnv = noMarker;
    stubRunArgv();

    await createBashTool({ stripEnvVars: ["AGENT"] }).run({ command: "bun test" }, ctx());

    assertDefined(calls[0], "the runArgv call");
    expect("env" in calls[0]).toBe(false);
    expect(calls[0].stripEnvVars).toEqual(["AGENT"]);
  });

  test("AC9: with a launcher, the launch request carries env { AGENT: '1' }", async () => {
    _agentOutputEnvDeps.processEnv = noMarker;
    const requests: LaunchRequest[] = [];

    await createBashTool({ launcher: recordingLauncher(requests) }).run({ command: "bun test" }, ctx());

    expect(requests[0]?.env).toEqual({ AGENT: "1" });
  });

  test("AC9 boundary: with a launcher and a stripped AGENT, the request carries no env key", async () => {
    _agentOutputEnvDeps.processEnv = noMarker;
    const requests: LaunchRequest[] = [];

    await createBashTool({ stripEnvVars: ["AGENT"], launcher: recordingLauncher(requests) }).run(
      { command: "bun test" },
      ctx(),
    );

    assertDefined(requests[0], "the launch request");
    expect("env" in requests[0]).toBe(false);
  });
});

describe("US-001 Bash tool description variants", () => {
  // Each of the five descriptions `bashToolDescription` can return, selected
  // the way `createBashTool` wires them (spec US-001 AC16).
  const cases: Array<{ label: string; description: string }> = [
    { label: "gated", description: createBashTool({ bashApproval: "gated" }).description },
    {
      label: "escalate",
      description: createBashTool({ bashApproval: "escalate", humanApproval: true }).description,
    },
    {
      label: "raw with the contained sentence",
      description: createBashTool({
        bashApproval: "raw",
        launcher: createCommandLauncher({ state: { kind: "available", backend: "srt", network: "open" } }),
      }).description,
    },
    {
      label: "raw with the uncontained default",
      description: createBashTool({ bashApproval: "raw" }).description,
    },
    {
      label: "raw unavailable",
      description: createBashTool({
        bashApproval: "raw",
        launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
      }).description,
    },
  ];

  test.each(cases)("$label states that background processes are killed when the command exits", ({ description }) => {
    expect(description).toContain("background processes");
    expect(description).toContain("killed when the command exits");
  });
});

describe("Bash audit exitCode (nax#2227)", () => {
  test.each([0, 1, 2])("records the shell's own exit code %i on the audit; isError still follows it", async (code) => {
    stubRunArgv({ exitCode: code, stdout: "" });
    const r = await createBashTool().run({ command: "rg nomatch src" }, ctx());
    expect(r.audit).toEqual({ executed: ["/bin/sh", "-c", "rg nomatch src"], exitCode: code });
    expect(r.isError).toBe(code !== 0);
    expect(r.content.startsWith(`exit ${code}`)).toBe(true);
  });

  test("a timed-out call records no exitCode: the code is nax's kill, not the command's", async () => {
    stubRunArgv({ exitCode: 137, timedOut: true });
    const r = await createBashTool().run({ command: "sleep 999" }, ctx());
    expect(r.audit).toEqual({ executed: ["/bin/sh", "-c", "sleep 999"] });
    expect(r.isError).toBe(true);
  });

  test("a turn-aborted call records no exitCode", async () => {
    stubRunArgv({ exitCode: -1, aborted: true });
    const r = await createBashTool().run({ command: "sleep 999" }, ctx());
    expect(r.audit).toEqual({ executed: ["/bin/sh", "-c", "sleep 999"] });
    expect(r.isError).toBe(true);
  });

  test("an orphansKilled call keeps the exit code: the shell exited by itself", async () => {
    stubRunArgv({ exitCode: 0, orphansKilled: true });
    const r = await createBashTool().run({ command: "sleep 9 &" }, ctx());
    expect(r.audit?.exitCode).toBe(0);
  });

  test("the launcher path records the exit code beside the sandbox record", async () => {
    const launcher: CommandLauncher = {
      state: DISABLED_SANDBOX_STATE,
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        executed: ["/bin/sh", "-c", "false"],
        sandbox: { backend: "none", wrapped: false },
      }),
    };
    const r = await createBashTool({ launcher }).run({ command: "false" }, ctx());
    expect(r.audit).toEqual({
      executed: ["/bin/sh", "-c", "false"],
      sandbox: { backend: "none", wrapped: false },
      exitCode: 1,
    });
  });
});

/**
 * US-002: `raw` has no containment, so `find / -name x` was previously free to
 * run and hit the 300s Bash timeout (a second test-writer ran exactly that).
 * `rawDescription` gains ONE sentence naming the whole-filesystem `find`
 * refusal and pointing the model at the repository.
 */
describe("US-002 raw-mode Bash description: the whole-filesystem find refusal", () => {
  /**
   * Everything the description says from its first mention of `find` onward.
   * Reading the tail rather than one period-delimited sentence keeps the
   * assertion about CONTENT -- what the model is told about `find` -- and not
   * about punctuation, since a one- or two-sentence phrasing says the same
   * thing to the model.
   */
  function findGuidance(description: string): string {
    const at = description.indexOf("find");
    expect(at).toBeGreaterThan(-1);
    return description.slice(at);
  }

  test("AC18: the raw description refuses find from /, ~ or $HOME and points at the repository", () => {
    const guidance = findGuidance(createBashTool({ bashApproval: "raw" }).description);
    expect(guidance).toContain("/");
    expect(guidance).toContain("~");
    expect(guidance).toContain("$HOME");
    expect(guidance).toContain("refused");
    expect(guidance).toContain("repository");
  });

  test("AC18 boundary: the sandboxed (available-launcher) raw description carries the same guidance", () => {
    const guidance = findGuidance(
      createBashTool({
        bashApproval: "raw",
        launcher: createCommandLauncher({ state: { kind: "available", backend: "srt", network: "open" } }),
      }).description,
    );
    expect(guidance).toContain("$HOME");
    expect(guidance).toContain("refused");
    expect(guidance).toContain("repository");
  });
});

/**
 * US-003: `unsandboxedCommands` is the session-level opt-in for the per-call
 * `unsandboxed` argument. Off (or absent) the tool must be byte-identical to
 * before it existed; only an exact `true` on the INPUT reaches the launcher,
 * and the tool itself never reads the option when it runs.
 */
describe("US-003 — the unsandboxedCommands option on the Bash tool", () => {
  const UNSANDBOXED_SENTENCE =
    'Set "unsandboxed": true with an "unsandboxedReason" only when the command needs the network, a local socket or a device the sandbox blocks.';

  test("AC-1: with the option absent the schema declares exactly command, timeoutMs and description", () => {
    const tool = createBashTool({ shell: "/bin/sh" });
    expect(Object.keys(schemaProperties(tool)).sort()).toEqual(["command", "description", "timeoutMs"]);
  });

  test("AC-2: with the option absent the description equals the description with it explicitly false", () => {
    expect(createBashTool({ bashApproval: "gated" }).description).toBe(
      createBashTool({ bashApproval: "gated", unsandboxedCommands: false }).description,
    );
  });

  test("AC-3: the scope always declares unsandboxedField, and commandField is unchanged", () => {
    for (const unsandboxedCommands of [undefined, false, true]) {
      const scope = createBashTool({ unsandboxedCommands }).scope;
      expect(scope.unsandboxedField).toBe("unsandboxed");
      expect(scope.commandField).toBe("command");
    }
  });

  test("AC-4: the option adds boolean unsandboxed and string unsandboxedReason to the schema", () => {
    const tool = createBashTool({ unsandboxedCommands: true });
    expect(tool.inputSchema).toMatchObject({
      properties: { unsandboxed: { type: "boolean" }, unsandboxedReason: { type: "string" } },
    });
    // Still the three original properties, unchanged and still described.
    expect(Object.keys(schemaProperties(tool)).sort()).toEqual([
      "command",
      "description",
      "timeoutMs",
      "unsandboxed",
      "unsandboxedReason",
    ]);
  });

  test("AC-5: the option leaves the required list at exactly command", () => {
    expect(createBashTool({ unsandboxedCommands: true }).inputSchema.required).toEqual(["command"]);
  });

  test("AC-6: the option appends the one guidance sentence to the description", () => {
    expect(createBashTool({ unsandboxedCommands: true }).description).toEndWith(UNSANDBOXED_SENTENCE);
    expect(createBashTool({ unsandboxedCommands: false }).description).not.toContain(UNSANDBOXED_SENTENCE);
  });

  test("AC-7: an exact unsandboxed: true asks the launcher to run the call unwrapped", async () => {
    const requests: LaunchRequest[] = [];
    const tool = createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true });
    await tool.run({ command: "curl x", unsandboxed: true, unsandboxedReason: "needs network" }, ctx());
    assertDefined(requests[0], "the launcher request");
    expect(requests[0].unwrapped).toBe(true);
    expect(requests[0].spec).toEqual({ kind: "shell", shell: "/bin/sh", command: "curl x" });
  });

  test("AC-8: a call without the field carries no unwrapped key", async () => {
    const requests: LaunchRequest[] = [];
    const tool = createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true });
    await tool.run({ command: "ls" }, ctx());
    assertDefined(requests[0], "the launcher request");
    expect("unwrapped" in requests[0]).toBe(false);
  });

  test('AC-9: a truthy non-boolean "unsandboxed" is not the opt-in, so no unwrapped key', async () => {
    const requests: LaunchRequest[] = [];
    const tool = createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true });
    await tool.run({ command: "ls", unsandboxed: "true" }, ctx());
    assertDefined(requests[0], "the launcher request");
    expect("unwrapped" in requests[0]).toBe(false);
  });

  test("AC-10: with no launcher an unsandboxed: true call direct-spawns the shell", async () => {
    stubRunArgv();
    const tool = createBashTool({ unsandboxedCommands: true });
    await tool.run({ command: "ls", unsandboxed: true }, ctx());
    expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", "ls"]);
  });

  test("AC-11: that direct-spawned run is not an error result", async () => {
    stubRunArgv();
    const result = await createBashTool({ unsandboxedCommands: true }).run({ command: "ls", unsandboxed: true }, ctx());
    expect(result.isError).not.toBe(true);
  });

  test("AC-16: an empty command is refused before any launch, even with the escape flag", async () => {
    const requests: LaunchRequest[] = [];
    const tool = createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true });
    const result = await tool.run({ command: "", unsandboxed: true }, ctx());
    expect(result).toEqual({ content: '"command" must be a non-empty string', isError: true });
  });

  test("AC-17: that refusal invokes neither the launcher nor the direct spawn", async () => {
    const requests: LaunchRequest[] = [];
    stubRunArgv();
    const tool = createBashTool({ launcher: recordingLauncher(requests), unsandboxedCommands: true });
    await tool.run({ command: "", unsandboxed: true }, ctx());
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
