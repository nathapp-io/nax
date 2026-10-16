/**
 * US-002: `nax gates run` — run the project's configured quality gates.
 *
 * ACs 1-24 of `docs/specs/SPEC-gates-run.md`. Every test injects `GatesCliDeps`
 * with recording `log` / `logErr` / `exit` stubs, so no process state leaks
 * between cases. `dir` is a temp project (a `.nax/config.json` at its root) in
 * every test except AC-19, AC-20 and AC-21, so project resolution passes and
 * the resolved `projectDir` is `<dir>`'s `normalizeTrustPath` form.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  type GatesCliDeps,
  type GatesRunOptions,
  type GatesRunReport,
  gatesRunCommand,
  registerGatesCommand,
} from "@/cli";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  _qualityGateDeps,
  type GateRunRecord,
  type GateRunStatus,
  resolveGateCommands,
  runQualityGates,
} from "@/finish";
// `GateCommand` is not on the `@/finish` barrel; a unit test may reach the unit (test-architecture.md).
import type { GateCommand } from "@/finish/gates/quality";
import type { QualityCommandOptions, QualityCommandResult } from "@/quality";
import { normalizeTrustPath } from "@/trust";

const originalQualityDeps = { ..._qualityGateDeps };
afterEach(() => {
  _qualityGateDeps.run = originalQualityDeps.run;
  _qualityGateDeps.loadConfig = originalQualityDeps.loadConfig;
  _qualityGateDeps.loadPackageOverride = originalQualityDeps.loadPackageOverride;
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** One resolved root gate; `cwd` is irrelevant to the stubs but keeps the type honest. */
function gate(name: string): GateCommand {
  return { name, command: "true", cwd: "/repo" };
}

function record(
  over: Partial<GateRunRecord> & { name: string; status: GateRunStatus; exitCode: number },
): GateRunRecord {
  return { cwd: "/repo", durationMs: 0, output: "", ...over };
}

/** AC-1's three records: one green, one that never ran, one red. */
const THREE = [
  record({ name: "build", status: "passed", exitCode: 0, durationMs: 12300 }),
  record({
    name: "lint",
    status: "not-run",
    exitCode: 127,
    durationMs: 4,
    output: "/bin/sh: biome: command not found",
  }),
  record({ name: "test", status: "failed", exitCode: 1, durationMs: 48000, output: "boom" }),
];

/** A full `NaxConfig` with `quality.commands` overridden (never a partial cast). */
function configWithCommands(commands: NaxConfig["quality"]["commands"]): NaxConfig {
  return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands } };
}

interface Harness {
  deps: GatesCliDeps;
  out: string[];
  err: string[];
  codes: number[];
  trusted: { root: string; interactive: boolean }[];
  resolved: { repoRoot: string; packageDirs: readonly string[] }[];
  ran: { repoRoot: string; commands: readonly GateCommand[] }[];
}

interface HarnessOptions {
  /** What the stubbed `resolveGateCommands` returns. */
  commands?: GateCommand[];
  /** What the stubbed `runQualityGates` feeds `onGate`, in order. */
  records?: GateRunRecord[];
  /** What `deps.isInteractive()` answers. */
  interactive?: boolean;
  overrides?: Partial<GatesCliDeps>;
}

function harness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const trusted: Harness["trusted"] = [];
  const resolved: Harness["resolved"] = [];
  const ran: Harness["ran"] = [];
  const commands = options.commands ?? [];
  const records = options.records ?? [];

  const deps: GatesCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    isInteractive: () => options.interactive === true,
    ensureProjectTrusted: async (root, opts) => {
      trusted.push({ root, interactive: opts.interactive });
    },
    resolveGateCommands: async (repoRoot, packageDirs) => {
      resolved.push({ repoRoot, packageDirs });
      return commands;
    },
    runQualityGates: async (repoRoot, selected, opts) => {
      ran.push({ repoRoot, commands: selected });
      for (const rec of records) opts?.onGate?.(rec);
      return { passed: false, ran: [], failing: [], output: "" };
    },
    ...options.overrides,
  };

  return { deps, out, err, codes, trusted, resolved, ran };
}

/** A temp project: a `.nax/config.json` at `dir`'s root, so resolution passes. */
async function inProject(body: (dir: string, projectDir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".nax"), { recursive: true });
    await Bun.write(join(dir, ".nax", "config.json"), "{}\n");
    await body(dir, await normalizeTrustPath(dir));
  });
}

/** The single JSON document `--json` printed, asserting there is exactly one. */
function reportOf(out: readonly string[]): GatesRunReport {
  expect(out).toHaveLength(1);
  // `JSON.parse` is untyped by construction; the declared type is the schema
  // the assertions below hold the parsed document to.
  const report: GatesRunReport = JSON.parse(out[0] ?? "null");
  return report;
}

function errorOf(out: readonly string[]): { error: string } {
  expect(out).toHaveLength(1);
  const parsed: { error: string } = JSON.parse(out[0] ?? "null");
  return parsed;
}

// ─── AC-19/AC-20/AC-21 exceptions ────────────────────────────────────────────

describe("nax gates run (project resolution)", () => {
  test("AC-19: no .nax/config.json at or above --dir fails before the trust gate", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const code = await gatesRunCommand({ dir, gates: [], json: false }, h.deps);

      expect(code).toBe(1);
      expect(h.err).toEqual([`no nax project found at or above ${dir}`]);
      expect(h.out).toEqual([]);
      expect(h.trusted).toEqual([]);
      expect(h.resolved).toEqual([]);
      expect(h.ran).toEqual([]);
    });
  });

  test("AC-20: a .nax/config.json that IS the global config dir is not a project", async () => {
    await withTempDir(async (tmp) => {
      const home = join(tmp, "home");
      await mkdir(join(home, ".nax"), { recursive: true });
      await Bun.write(join(home, ".nax", "config.json"), "{}\n");

      const previous = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(home, ".nax");
      try {
        const h = harness();
        const code = await gatesRunCommand({ dir: home, gates: [], json: false }, h.deps);

        expect(code).toBe(1);
        expect(h.err).toEqual([`no nax project found at or above ${home}`]);
        expect(h.trusted).toEqual([]);
        expect(h.out).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
        else process.env.NAX_GLOBAL_CONFIG_DIR = previous;
      }
    });
  });

  test("AC-21: a subdirectory resolves to the project root, not the subdirectory", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, ".nax"), { recursive: true });
      await Bun.write(join(root, ".nax", "config.json"), "{}\n");
      await mkdir(join(root, "packages", "a"), { recursive: true });
      const projectDir = await normalizeTrustPath(root);

      const h = harness({
        commands: [gate("build")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
      });
      const code = await gatesRunCommand({ dir: join(root, "packages", "a"), gates: [], json: true }, h.deps);

      expect(code).toBe(0);
      expect(h.trusted.map((call) => call.root)).toEqual([projectDir]);
      expect(h.resolved.map((call) => call.repoRoot)).toEqual([projectDir]);
      expect(reportOf(h.out).projectDir).toBe(projectDir);
    });
  });
});

// ─── the resolved-and-run path ───────────────────────────────────────────────

describe("nax gates run --json (report)", () => {
  test("AC-1: one JSON document on stdout, exit 2, and the summary counts every status", async () => {
    await inProject(async (dir) => {
      const h = harness({ commands: [gate("build"), gate("lint"), gate("test")], records: THREE });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(2);
      const report = reportOf(h.out);
      expect(report.passed).toBe(false);
      expect(report.summary).toEqual({ passed: 1, failed: 1, notRun: 1, timedOut: 0 });
      expect(h.err).toEqual([]);
    });
  });

  test("AC-2: entries carry the records' fields in run order; a passed gate has no outputTail", async () => {
    await inProject(async (dir) => {
      const h = harness({ commands: [gate("build"), gate("lint"), gate("test")], records: THREE });
      await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      const gates = reportOf(h.out).gates;
      expect(gates.map((entry) => entry.name)).toEqual(["build", "lint", "test"]);
      expect(gates.map((entry) => entry.status)).toEqual(["passed", "not-run", "failed"]);
      expect(gates.map((entry) => entry.exitCode)).toEqual([0, 127, 1]);
      expect(gates.map((entry) => entry.durationMs)).toEqual([12300, 4, 48000]);
      expect(gates[1]).toEqual({
        name: "lint",
        status: "not-run",
        exitCode: 127,
        durationMs: 4,
        outputTail: "/bin/sh: biome: command not found",
      });
      expect("outputTail" in (gates[0] ?? {})).toBe(false);
    });
  });

  test("AC-3: outputTail is the last 40 lines, without a trailing newline", async () => {
    await inProject(async (dir) => {
      const hundred = `${Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
      const h = harness({
        commands: [gate("test")],
        records: [record({ name: "test", status: "failed", exitCode: 1, output: hundred })],
      });
      await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      const [entry] = reportOf(h.out).gates;
      expect(entry?.outputTail).toBe(Array.from({ length: 40 }, (_, i) => `line${i + 61}`).join("\n"));
    });
  });

  test("AC-4: every gate passed is exit 0 with passed true", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("build"), gate("test")],
        records: [
          record({ name: "build", status: "passed", exitCode: 0 }),
          record({ name: "test", status: "passed", exitCode: 0 }),
        ],
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(0);
      expect(reportOf(h.out).passed).toBe(true);
    });
  });

  test("AC-5: a timed-out gate is exit 2 and counted separately", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("build"), gate("typecheck"), gate("lint")],
        records: [
          record({ name: "build", status: "passed", exitCode: 0 }),
          record({ name: "typecheck", status: "timed-out", exitCode: -1, durationMs: 900000 }),
          record({ name: "lint", status: "passed", exitCode: 0 }),
        ],
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(2);
      expect(reportOf(h.out).summary.timedOut).toBe(1);
    });
  });

  test("AC-6: nothing configured runs nothing, reports no gates, and exits 2", async () => {
    await inProject(async (dir) => {
      const h = harness({ commands: [] });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(2);
      const report = reportOf(h.out);
      expect(report.passed).toBe(false);
      expect(report.gates).toEqual([]);
      expect(h.ran).toEqual([]);
    });
  });

  test("AC-8: the resolver gets the project root and an empty packageDirs; the runner gets the root", async () => {
    await inProject(async (dir, projectDir) => {
      const h = harness({
        commands: [gate("build")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
      });
      await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(h.resolved).toEqual([{ repoRoot: projectDir, packageDirs: [] }]);
      expect(h.ran.map((call) => call.repoRoot)).toEqual([projectDir]);
    });
  });

  test("AC-9: repeated and out-of-order --gate values select each gate once, in GATE_ORDER", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("build"), gate("lint"), gate("test")],
        records: [
          record({ name: "build", status: "passed", exitCode: 0 }),
          record({ name: "test", status: "passed", exitCode: 0 }),
        ],
      });
      await gatesRunCommand({ dir, gates: ["test", "build", "test"], json: true }, h.deps);

      expect(h.ran[0]?.commands).toEqual([gate("build"), gate("test")]);
    });
  });

  test("AC-24: a runner that throws mid-run discards the finished records and exits 1", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("build"), gate("test")],
        overrides: {
          runQualityGates: async (_repoRoot, _commands, opts) => {
            opts?.onGate?.(record({ name: "build", status: "passed", exitCode: 0 }));
            throw new Error("spawn refused");
          },
        },
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({ error: "spawn refused" });
      expect(h.err).toEqual([]);
    });
  });
});

// ─── plain output ────────────────────────────────────────────────────────────

describe("nax gates run (plain output)", () => {
  test("AC-7: nothing configured is one line naming the config file", async () => {
    await inProject(async (dir, projectDir) => {
      const h = harness({ commands: [] });
      const code = await gatesRunCommand({ dir, gates: [], json: false }, h.deps);

      expect(code).toBe(2);
      expect(h.out).toEqual([
        `no quality.commands configured in ${join(projectDir, ".nax", "config.json")}; nothing was verified`,
      ]);
    });
  });

  test("AC-17: a not-run gate prints exit=126, the did-not-run note, its tail block and the summary", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("build"), gate("lint")],
        records: [
          record({ name: "build", status: "passed", exitCode: 0, durationMs: 12300 }),
          record({
            name: "lint",
            status: "not-run",
            exitCode: 126,
            durationMs: 3,
            output: "/bin/sh: ./node_modules/.bin/biome: Permission denied",
          }),
        ],
      });
      const code = await gatesRunCommand({ dir, gates: [], json: false }, h.deps);

      expect(code).toBe(2);
      const lintLine = h.out.find((line) => line.includes("lint") && !line.startsWith("---"));
      expect(lintLine ?? "").toContain("not-run");
      expect(lintLine ?? "").toContain("exit=126");
      expect(lintLine ?? "").toContain("the gate did not run");
      expect(h.out).toContain("--- lint (last 40 lines) ---");
      expect(h.out).toContain("/bin/sh: ./node_modules/.bin/biome: Permission denied");
      expect(h.out).toContain("gates: 1 passed, 0 failed, 1 not run, 0 timed out");
      // Every non-passed gate gets a tail block; a passed one does not.
      expect(h.out).not.toContain("--- build (last 40 lines) ---");
    });
  });

  test("AC-18: a setup failure appends (setup failed) to the gate's line", async () => {
    await inProject(async (dir) => {
      const h = harness({
        commands: [gate("e2e")],
        records: [
          record({ name: "e2e", status: "failed", exitCode: 1, failedPhase: "setup", output: "compose up failed" }),
        ],
      });
      await gatesRunCommand({ dir, gates: [], json: false }, h.deps);

      const e2eLine = h.out.find((line) => line.includes("e2e") && line.includes("exit=1"));
      expect(e2eLine?.endsWith("(setup failed)")).toBe(true);
    });
  });
});

// ─── validation ──────────────────────────────────────────────────────────────

describe("nax gates run validation", () => {
  test("AC-10: an unknown gate fails before any I/O", async () => {
    await inProject(async (dir) => {
      const h = harness({ commands: [gate("build")] });
      const code = await gatesRunCommand({ dir, gates: ["format"], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({
        error: "unknown gate format; expected one of build, typecheck, lint, test, e2e",
      });
      expect(h.trusted).toEqual([]);
      expect(h.resolved).toEqual([]);
      expect(h.ran).toEqual([]);
    });
  });

  test("AC-11: a known gate the project does not configure fails before the runner", async () => {
    await inProject(async (dir) => {
      const h = harness({ commands: [gate("build"), gate("test")] });
      const code = await gatesRunCommand({ dir, gates: ["e2e"], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({ error: "gate e2e is not configured; configured gates: build, test" });
      expect(h.ran).toEqual([]);
    });
  });

  test("AC-16: an invalid config fails with the resolver's message", async () => {
    await inProject(async (dir) => {
      const h = harness({
        overrides: {
          resolveGateCommands: async () => {
            throw new Error("invalid config: quality.commands.test");
          },
        },
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({ error: "invalid config: quality.commands.test" });
      expect(h.err).toEqual([]);
    });
  });
});

// ─── trust ───────────────────────────────────────────────────────────────────

describe("nax gates run trust", () => {
  function untrusted(root: string): NaxError {
    return new NaxError(`[trust] project not trusted: ${root}`, "PROJECT_UNTRUSTED", {
      stage: "trust",
      root,
      hint: `run: nax trust add ${root}`,
    });
  }

  test("AC-12: an untrusted project prints two stderr lines and touches no config", async () => {
    await inProject(async (dir, projectDir) => {
      const h = harness({
        overrides: {
          ensureProjectTrusted: async () => {
            throw untrusted(projectDir);
          },
        },
      });
      const code = await gatesRunCommand({ dir, gates: [], json: false }, h.deps);

      expect(code).toBe(1);
      expect(h.err).toEqual([`Project not trusted: ${projectDir}`, `run: nax trust add ${projectDir}`]);
      expect(h.out).toEqual([]);
      expect(h.resolved).toEqual([]);
    });
  });

  test("AC-13: the same refusal with --json is one stdout line and no stderr", async () => {
    await inProject(async (dir, projectDir) => {
      const h = harness({
        overrides: {
          ensureProjectTrusted: async () => {
            throw untrusted(projectDir);
          },
        },
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({
        error: `Project not trusted: ${projectDir}; run: nax trust add ${projectDir}`,
      });
      expect(h.err).toEqual([]);
      expect(h.resolved).toEqual([]);
    });
  });

  test("AC-14: an unreadable trust store fails with the store's message", async () => {
    await inProject(async (dir) => {
      const h = harness({
        overrides: {
          ensureProjectTrusted: async () => {
            throw new NaxError("trust store unreadable: bad json", "TRUST_STORE_UNREADABLE", { stage: "trust" });
          },
        },
      });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(1);
      expect(errorOf(h.out)).toEqual({ error: "trust store unreadable: bad json" });
      expect(h.resolved).toEqual([]);
    });
  });

  test("AC-15: --json is never interactive, and a plain run is interactive only when the TTY says so", async () => {
    await inProject(async (dir) => {
      const jsonRun = harness({
        commands: [gate("build")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
        interactive: true,
      });
      await gatesRunCommand({ dir, gates: [], json: true }, jsonRun.deps);
      expect(jsonRun.trusted.map((call) => call.interactive)).toEqual([false]);

      const plainRun = harness({
        commands: [gate("build")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
        interactive: true,
      });
      await gatesRunCommand({ dir, gates: [], json: false }, plainRun.deps);
      expect(plainRun.trusted.map((call) => call.interactive)).toEqual([true]);
    });
  });
});

// ─── the real resolver and runner ────────────────────────────────────────────

describe("nax gates run (real resolver and runner)", () => {
  test("AC-22: the exit code reaching the report comes from the quality runner", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await Bun.write(join(dir, ".nax", "config.json"), "{}\n");

      const spawned: Pick<QualityCommandOptions, "commandName" | "command">[] = [];
      _qualityGateDeps.loadConfig = async () =>
        configWithCommands({ lint: "biome check .", formatFix: "biome format --write ." });
      _qualityGateDeps.run = async (opts): Promise<QualityCommandResult> => {
        spawned.push({ commandName: opts.commandName, command: opts.command });
        return {
          commandName: opts.commandName,
          command: "biome check .",
          success: false,
          exitCode: 127,
          output: "/bin/sh: biome: command not found",
          durationMs: 4,
          timedOut: false,
        };
      };

      const h = harness({ overrides: { ensureProjectTrusted: async () => {}, resolveGateCommands, runQualityGates } });
      const code = await gatesRunCommand({ dir, gates: [], json: true }, h.deps);

      expect(code).toBe(2);
      expect(reportOf(h.out).gates).toEqual([
        {
          name: "lint",
          status: "not-run",
          exitCode: 127,
          durationMs: 4,
          outputTail: "/bin/sh: biome: command not found",
        },
      ]);
      expect(spawned.map((call) => call.commandName)).toEqual(["lint"]);
      expect(spawned.map((call) => call.command)).not.toContain("biome format --write .");
    });
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("nax gates registration", () => {
  test("AC-23: the group registers only `run`, and its flags reach gatesRunCommand", async () => {
    await inProject(async (dir, projectDir) => {
      const options: GatesRunOptions = { dir, gates: ["test", "build"], json: true };
      const direct = harness({
        commands: [gate("build"), gate("test")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
      });
      const expected = await gatesRunCommand(options, direct.deps);

      const h = harness({
        commands: [gate("build"), gate("test")],
        records: [record({ name: "build", status: "passed", exitCode: 0 })],
      });
      const program = new Command();
      const group = registerGatesCommand(program, h.deps);
      expect(group.name()).toBe("gates");
      expect(group.commands.map((command) => command.name())).toEqual(["run"]);

      await program.parseAsync([
        "node",
        "nax",
        "gates",
        "run",
        "--gate",
        "test",
        "--gate",
        "build",
        "--json",
        "-d",
        dir,
      ]);

      expect(h.codes).toEqual([expected]);
      expect(h.resolved).toEqual([{ repoRoot: projectDir, packageDirs: [] }]);
      expect(h.ran[0]?.commands).toEqual([gate("build"), gate("test")]);
      expect(h.out).toEqual(direct.out);
    });
  });
});
