import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _agentOutputEnvDeps } from "#src/internal/agent-output-env";
import type { RunArgvOptions } from "#src/internal/argv-exec";
import type { CommandLauncher, LaunchRequest } from "#src/sandbox/index";
import { _launcherDeps, createCommandLauncher } from "#src/sandbox/index";
import { type CodingTool, createRunCommandTool } from "#src/tools/index";
import { _runCommandToolDeps, type RunCommandExecOptions } from "#src/tools/run-command";
import { runExecBranch } from "#src/tools/run-command-exec";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = makeTempDir("exec-sbx-");
  mkdirSync(join(root, "packages", "app"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

describe("Exec through the launcher", () => {
  withDepsRestore(_launcherDeps, ["runArgv"]);

  test("Review Focus 5: package target runs in the package dir, roots derive from ctx.root, audit carries the record", async () => {
    const backend = makeFakeSandboxBackend();
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    // B1: the spawn is stubbed, and every assertion below is about the
    // launcher's wiring — the cwd it hands over, the policy roots, and the
    // wrapped argv it records — never about the child's output. Running a real
    // `sh` here gave those assertions nothing to read and, when the host was
    // loaded, could stall on it: the `runArgv` deadline is 300s, so the whole
    // suite sat on this one test until bun's own 60s timeout failed the package
    // gate. The stub still drives the real wrapping path, and records the
    // request so the wrapped argv is asserted end to end.
    const seen: RunArgvOptions[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return { exitCode: 0, stdout: "1.4.3\n", stderr: "", timedOut: false };
    };
    const result = await runExecBranch({ argv: ["bun", "--version"], target: "package" }, ctx(), {
      exec: {
        repoRoot: root,
        packageWorkdir: join(root, "packages", "app"),
        allowScripts: false,
        patterns: ["bun *"],
        launcher,
      },
    });
    expect(backend.calls[0]?.cwd).toBe(join(root, "packages", "app"));
    expect(result.audit?.cwd).toBe(join(root, "packages", "app"));
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(result.audit?.sandbox).toEqual({
      backend: "srt",
      wrapped: true,
      argv: ["/bin/sh", "-c", "export NAX_SANDBOXED=1; 'bun' '--version'"],
    });
    // The wrapped argv the backend built is the argv that was handed to the spawn.
    expect(seen[0]?.argv).toEqual(["/bin/sh", "-c", "export NAX_SANDBOXED=1; 'bun' '--version'"]);
    expect(seen[0]?.cwd).toBe(join(root, "packages", "app"));
  });
});

// US-003: the Exec branch's description carries the sandbox sentence. Under a
// confined session the writable temp root is this run's own directory, so the
// description must stop promising "the system temp directories".
describe("US-003 — RunCommand description names the confined temp root", () => {
  const execTool = (state: "confined" | "shared") =>
    createRunCommandTool(new Map([["test", "bun test"]]), {
      exec: {
        repoRoot: root,
        packageWorkdir: root,
        allowScripts: false,
        patterns: ["bun *"],
        launcher: createCommandLauncher({
          state:
            state === "confined"
              ? { kind: "available", backend: "srt", network: "open", sharedTmp: false }
              : { kind: "available", backend: "srt", network: "open" },
          backend: makeFakeSandboxBackend(),
          policyFor,
        }),
      },
    });

  test("US-003 AC6: sharedTmp:false names this run's temp directory", () => {
    const description = execTool("confined").description;
    expect(description).toContain("this run's temp directory ($TMPDIR)");
    expect(description).not.toContain("the system temp directories");
  });

  test("US-003 AC6 boundary: a shared-temp launcher keeps the pre-change wording", () => {
    const description = execTool("shared").description;
    expect(description).toContain("the system temp directories");
    expect(description).not.toContain("this run's temp directory ($TMPDIR)");
  });
});

describe("Exec env overlay through the launcher", () => {
  withDepsRestore(_launcherDeps);
  withDepsRestore(_agentOutputEnvDeps, ["processEnv"]);

  // US-004 replaced this test's invariant: the launcher's env is no longer
  // exactly the Yarn key. Marker presence is read from the nax process
  // environment, so the overlay is stubbed marker-free here — otherwise the
  // assertion would flip depending on whether the suite was launched from an
  // agent shell. What must hold now: the Yarn no-scripts key survives wrapping
  // alongside the agent-output key.
  test("US-004 AC11: the Yarn no-scripts env overlay survives wrapping alongside AGENT=1", async () => {
    _agentOutputEnvDeps.processEnv = () => ({ PATH: "/usr/bin" });
    const seen: { env?: Readonly<Record<string, string>> }[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    await runExecBranch({ argv: ["yarn", "add", "left-pad"], target: "repoRoot" }, ctx(), {
      exec: { repoRoot: root, packageWorkdir: root, allowScripts: false, patterns: ["yarn *"], launcher },
    });
    expect(seen[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false", AGENT: "1" });
  });
});

// US-006: RunCommand's Exec note carries the same macOS ps sentence as the Bash
// tool, sourced from its own platform seam (patched here, never the global
// `process.platform`).
describe("US-006 — the darwin ps note in the RunCommand description", () => {
  withDepsRestore(_runCommandToolDeps, ["platform"]);

  const DARWIN_PS_SENTENCE =
    'On macOS the sandbox also refuses ps and other setuid programs ("Operation not permitted"), so a test that shells out to ps fails here for that reason alone.';

  const execTool = () =>
    createRunCommandTool(new Map([["test", "bun test"]]), {
      exec: {
        repoRoot: root,
        packageWorkdir: root,
        allowScripts: false,
        patterns: ["bun *"],
        launcher: createCommandLauncher({
          state: { kind: "available", backend: "srt", network: "open" },
          backend: makeFakeSandboxBackend(),
          policyFor,
        }),
      },
    }).description;

  test("AC-12: a darwin description names the ps note", () => {
    _runCommandToolDeps.platform = () => "darwin";
    expect(execTool()).toContain(DARWIN_PS_SENTENCE);
  });

  test("AC-12 boundary: a linux description omits it", () => {
    _runCommandToolDeps.platform = () => "linux";
    const description = execTool();
    expect(description).toContain('An "argv" call runs inside an OS sandbox');
    expect(description).not.toContain(DARWIN_PS_SENTENCE);
  });
});

// US-008: the argv branch offers the same per-call escape argument the Bash
// tool carries, and ONLY the argv branch: a declared command runs a
// project-authored shell command, so there is no argv to unwrap and the flag is
// refused by name rather than silently ignored (#2066's lesson -- 48 of 136
// declared calls carried a silently discarded field and the model re-sent it).
//
// The `scope.unsandboxedField` is declared whenever the argv branch exists,
// whether or not the session advertises the argument: the runtime reads the
// field, and advertisement is the option's business (US-003's rule for Bash).
describe("US-008 — RunCommand's argv branch offers unsandboxed", () => {
  const DECLARED = new Map([["test", "bun test"]]);
  const UNSANDBOXED_ARGV_SENTENCE =
    'Set "unsandboxed": true with an "unsandboxedReason" only when the argv needs the network, a local socket or a device the sandbox blocks.';

  /** The Exec option, with the launcher left to the caller. */
  const exec = (extra: Partial<RunCommandExecOptions> = {}): RunCommandExecOptions => ({
    repoRoot: root,
    packageWorkdir: root,
    allowScripts: false,
    patterns: ["bun *"],
    ...extra,
  });

  const tool = (opts: { exec?: RunCommandExecOptions; runner?: () => void } = {}): CodingTool =>
    createRunCommandTool(DECLARED, {
      ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
      ...(opts.runner !== undefined
        ? {
            runDeclaredCommand: async () => {
              opts.runner?.();
              return { success: true, exitCode: 0, output: "" };
            },
          }
        : {}),
    });

  /** `properties` keys, sorted — the schema's shape without depending on insertion order. */
  const propertyKeys = (built: CodingTool): string[] => {
    const properties: unknown = built.inputSchema.properties;
    if (typeof properties !== "object" || properties === null) throw new Error("expected inputSchema.properties");
    return Object.keys(properties).sort();
  };

  /** One property's declared `type`, read through descriptors so nothing is cast. */
  const propertyType = (built: CodingTool, field: string): unknown => {
    const properties: unknown = built.inputSchema.properties;
    if (typeof properties !== "object" || properties === null) throw new Error("expected inputSchema.properties");
    const entry: unknown = Object.getOwnPropertyDescriptor(properties, field)?.value;
    if (typeof entry !== "object" || entry === null) return undefined;
    return Object.getOwnPropertyDescriptor(entry, "type")?.value;
  };

  /** A launcher that records every request and runs nothing. */
  const recordingLauncher = (): { launcher: CommandLauncher; seen: LaunchRequest[] } => {
    const seen: LaunchRequest[] = [];
    return {
      seen,
      launcher: {
        state: { kind: "disabled" },
        run: async (req) => {
          seen.push(req);
          return {
            exitCode: 0,
            stdout: "1.4.3\n",
            stderr: "",
            timedOut: false,
            executed: [],
            sandbox: { backend: "none", wrapped: false },
          };
        },
      },
    };
  };

  test("AC-1: without the option the schema is exactly command, values, argv, target", () => {
    expect(propertyKeys(tool({ exec: exec() }))).toEqual(["argv", "command", "target", "values"]);
  });

  test("AC-2: without the option the description is the one unsandboxedCommands: false produces", () => {
    expect(tool({ exec: exec() }).description).toBe(tool({ exec: exec({ unsandboxedCommands: false }) }).description);
    expect(tool({ exec: exec() }).description).not.toContain(UNSANDBOXED_ARGV_SENTENCE);
  });

  test("AC-3: the argv branch always declares scope.unsandboxedField", () => {
    expect(tool({ exec: exec() }).scope.unsandboxedField).toBe("unsandboxed");
  });

  test("AC-4: without the argv branch the scope has no unsandboxedField key", () => {
    expect("unsandboxedField" in tool({}).scope).toBe(false);
  });

  test("AC-5: the opt-in schema declares the two argument fields", () => {
    const optIn = tool({ exec: exec({ unsandboxedCommands: true }) });
    expect(propertyType(optIn, "unsandboxed")).toBe("boolean");
    expect(propertyType(optIn, "unsandboxedReason")).toBe("string");
  });

  test("AC-6: the opt-in description ends with the argv-worded escape sentence", () => {
    const description = tool({ exec: exec({ unsandboxedCommands: true }) }).description;
    expect(
      description.endsWith("only when the argv needs the network, a local socket or a device the sandbox blocks."),
    ).toBe(true);
    expect(description.endsWith(UNSANDBOXED_ARGV_SENTENCE)).toBe(true);
  });

  // US-003's sandbox note and US-008's escape sentence compose: on a machine
  // whose sandbox is unavailable, every argv call already runs outside it, so
  // the note says so and the argument's sentence still follows it (the runtime
  // still routes an escape request through the approval). Both, or neither --
  // never the sentence without its separator.
  test("AC-6 boundary: an unavailable sandbox keeps its note and still ends on the sentence", () => {
    const unavailable = () =>
      createCommandLauncher({
        state: { kind: "unavailable", backend: "srt", reason: "no bwrap" },
        backend: makeFakeSandboxBackend(),
        policyFor,
      });
    const on = tool({ exec: exec({ launcher: unavailable(), unsandboxedCommands: true }) }).description;
    expect(on).toContain("Commands are NOT sandboxed on this machine (no bwrap).");
    expect(on.endsWith(UNSANDBOXED_ARGV_SENTENCE)).toBe(true);
    const off = tool({ exec: exec({ launcher: unavailable() }) }).description;
    expect(off).not.toContain(UNSANDBOXED_ARGV_SENTENCE);
  });

  test("AC-7: an unsandboxed argv request reaches the launcher unwrapped", async () => {
    const { launcher, seen } = recordingLauncher();
    await runExecBranch({ argv: ["bun", "--version"], unsandboxed: true, unsandboxedReason: "registry" }, ctx(), {
      exec: exec({ launcher, unsandboxedCommands: true }),
    });
    expect(seen[0]?.unwrapped).toBe(true);
    expect(seen[0]?.spec).toEqual({ kind: "argv", argv: ["bun", "--version"] });
  });

  test("AC-8: an ordinary argv request omits unwrapped entirely", async () => {
    const { launcher, seen } = recordingLauncher();
    await runExecBranch({ argv: ["bun", "--version"] }, ctx(), {
      exec: exec({ launcher, unsandboxedCommands: true }),
    });
    expect(seen.length).toBe(1);
    expect(seen[0] === undefined ? "missing" : "unwrapped" in seen[0]).toBe(false);
  });

  test("AC-9/AC-10: a declared command refuses the flag and never reaches the runner", async () => {
    let runs = 0;
    const result = await tool({ exec: exec({ unsandboxedCommands: true }), runner: () => (runs += 1) }).run(
      { command: "test", unsandboxed: true },
      ctx(),
    );
    expect(result).toEqual({ content: '"unsandboxed" applies only to "argv" calls', isError: true });
    expect(runs).toBe(0);
  });

  test("a declared command refuses a stray unsandboxedReason too, rather than dropping it", async () => {
    // The #2066 shape the refusal helper's own comment cites: a field belonging
    // to the OTHER branch, silently discarded. No escape was requested here, so
    // nothing unsafe happens either way -- but a silent drop teaches the model
    // nothing, and it re-sends the same call. The reason alone gets a
    // correction, the same way a stray `target` does.
    let runs = 0;
    const result = await tool({ exec: exec({ unsandboxedCommands: true }), runner: () => (runs += 1) }).run(
      { command: "test", unsandboxedReason: "needs network" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unsandboxedReason");
    expect(result.content).toContain("argv");
    expect(runs).toBe(0);
  });

  test("AC-12: a non-boolean unsandboxed value is not an escape request", async () => {
    const { launcher, seen } = recordingLauncher();
    await runExecBranch({ argv: ["bun", "--version"], unsandboxed: "true" }, ctx(), {
      exec: exec({ launcher, unsandboxedCommands: true }),
    });
    expect(seen.length).toBe(1);
    expect(seen[0] === undefined ? "missing" : "unwrapped" in seen[0]).toBe(false);
  });
});

// US-008 + US-002: the flag travels the WHOLE way — through the real launcher,
// which concludes this one command runs outside the sandbox and records WHY.
// Everything the argv branch already did (normalization, cwd, the audit record)
// still holds on an unwrapped call, which is what makes the escape an opt-out of
// the sandbox rather than of the tool's own guarantees.
describe("US-008 — an unwrapped argv call through the real launcher", () => {
  withDepsRestore(_launcherDeps, ["runArgv"]);

  test("normalizes the argv, skips wrapping, and records the requested sandbox", async () => {
    const backend = makeFakeSandboxBackend();
    const seen: RunArgvOptions[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor,
    });
    const result = await runExecBranch(
      { argv: ["bun", "add", "left-pad"], unsandboxed: true, unsandboxedReason: "registry" },
      ctx(),
      {
        exec: {
          repoRoot: root,
          packageWorkdir: join(root, "packages", "app"),
          allowScripts: false,
          patterns: ["bun *"],
          launcher,
          unsandboxedCommands: true,
        },
      },
    );
    // Normalization is retained: an install-shaped argv still gains
    // --ignore-scripts when the session does not allow scripts.
    expect(seen[0]?.argv).toEqual(["bun", "add", "left-pad", "--ignore-scripts"]);
    // ...and the backend was never asked to wrap it.
    expect(backend.calls).toEqual([]);
    expect(result.audit?.executed).toEqual(["bun", "add", "left-pad", "--ignore-scripts"]);
    expect(result.audit?.cwd).toBe(join(root, "packages", "app"));
    expect(result.audit?.sandbox).toEqual({ backend: "none", wrapped: false, reason: "requested" });
  });
});
