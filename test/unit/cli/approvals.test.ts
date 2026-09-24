/**
 * `nax approvals list` — store resolution, registration and human output (US-003)
 *
 * AC1-AC3:   `resolveApprovalsFile` — a named config with an absolute
 *            outputDir, a config with no `name`, and a config that is not
 *            valid JSON.
 * AC4:       `registerApprovalsCommand` wires `approvals list -d <workdir>` to a
 *            single `readApprovalsFileDetailed` call at the resolved store path.
 * AC5:       the registered action forwards the command's return value to
 *            `deps.exit`.
 * AC6-AC8:   the `Approvals store:` / trust header and the remembered-approvals
 *            count.
 * AC9-AC13:  one entry block — entry line, root line and command lines, printed
 *            raw with the 10/12-space indents.
 * AC14-AC16: the taint trust line — pid alive, pid exited, and no pid.
 *
 * Hermetic by construction: the store lives in a temp outputDir reached through
 * a temp workdir's `.nax/config.json`, and stdout/stderr/exit are captured
 * through the injected `_approvalsCliDeps` seam — no real process exit, no
 * console, no network.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _approvalsCliDeps,
  approvalsListCommand,
  registerApprovalsCommand,
  resolveApprovalsFile,
} from "@/cli/approvals";
import {
  type ApprovalEntry,
  type ApprovalsFileRead,
  type ApprovalsTaint,
  approvalId,
  approvalsPath,
} from "@/permissions";
import { projectOutputDir } from "@/runtime";

type CliDeps = typeof _approvalsCliDeps;

const PROJECT_NAME = "approvals-cli";

const TAINT_PID = 4242;
const TAINT_SINCE = "2026-09-20T08:30:00.000Z";
const TAINT_RUN_ID = "run-7f3a";

const OK_READ: ApprovalsFileRead = {
  state: "ok",
  file: { entries: [], taint: undefined },
  droppedMalformed: 0,
};

function makeEntry(overrides: Partial<ApprovalEntry> = {}): ApprovalEntry {
  return {
    stage: "implementer",
    command: "bun run test",
    root: "/repo",
    origin: "escalate",
    matchedRule: null,
    approvedAt: "2026-09-22T10:00:00.000Z",
    approvedBy: "telegram:123",
    naxCommit: "7b37dbf74",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness — captures the CLI's terminal output, exit codes and store reads
// through the injected deps, so nothing touches the real stdout or process.exit.
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: CliDeps;
  readonly readPaths: string[];
  readonly exitCodes: number[];
  readonly pidsAsked: number[];
  stdoutLines(): string[];
}

function makeHarness(overrides: Partial<CliDeps> = {}): Harness {
  const logCalls: string[] = [];
  const readPaths: string[] = [];
  const exitCodes: number[] = [];
  const pidsAsked: number[] = [];
  const read = overrides.readApprovalsFileDetailed ?? _approvalsCliDeps.readApprovalsFileDetailed;
  const isAlive = overrides.isProcessAlive ?? _approvalsCliDeps.isProcessAlive;

  const deps: CliDeps = {
    ..._approvalsCliDeps,
    isTTY: () => false,
    log: (text: string) => {
      logCalls.push(text);
    },
    // Nothing the happy path prints to stderr is asserted here (US-004 owns the
    // missing/unparseable bodies); keep the real stream out of the test output.
    logErr: () => {},
    exit: (code: number) => {
      exitCodes.push(code);
    },
    ...overrides,
    readApprovalsFileDetailed: async (path: string) => {
      readPaths.push(path);
      return read(path);
    },
    isProcessAlive: (pid: number) => {
      pidsAsked.push(pid);
      return isAlive(pid);
    },
  };

  return {
    deps,
    readPaths,
    exitCodes,
    pidsAsked,
    stdoutLines: () => (logCalls.length === 0 ? [] : logCalls.join("\n").split("\n")),
  };
}

// ---------------------------------------------------------------------------
// Project fixtures — a temp workdir whose `.nax/config.json` names the project
// and points an absolute outputDir inside the same temp dir.
// ---------------------------------------------------------------------------

interface SeededProject {
  readonly workdir: string;
  readonly outputDir: string;
  readonly storePath: string;
}

/** `configFor` returning null means "this workdir has no `.nax/` at all". */
async function withProject(
  configFor: (outputDir: string) => string | null,
  fn: (project: SeededProject) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const workdir = join(dir, "project");
    const outputDir = join(dir, "out");
    await mkdir(workdir, { recursive: true });
    const config = configFor(outputDir);
    if (config !== null) {
      await mkdir(join(workdir, ".nax"), { recursive: true });
      await Bun.write(join(workdir, ".nax", "config.json"), config);
    }
    await fn({ workdir, outputDir, storePath: approvalsPath(outputDir) });
  });
}

/** The resolution AC1 pins: a `name` plus an absolute `outputDir`. */
function namedProjectConfig(outputDir: string): string {
  return JSON.stringify({ name: PROJECT_NAME, outputDir });
}

async function withSeededStore(
  seed: { readonly entries?: readonly ApprovalEntry[]; readonly taint?: ApprovalsTaint },
  fn: (project: SeededProject) => Promise<void>,
): Promise<void> {
  await withProject(namedProjectConfig, async (project) => {
    const entries = seed.entries ?? [];
    const body = seed.taint === undefined ? { entries } : { taint: seed.taint, entries };
    await mkdir(dirname(project.storePath), { recursive: true });
    await Bun.write(project.storePath, `${JSON.stringify(body, null, 2)}\n`);
    await fn(project);
  });
}

/** The default deps already read the real store; only the terminal seams are faked. */
async function listProject(project: SeededProject, harness: Harness): Promise<number> {
  return approvalsListCommand({ workdir: project.workdir, json: false }, harness.deps);
}

function registeredProgram(harness: Harness): Command {
  const program = new Command();
  program.exitOverride();
  registerApprovalsCommand(program, harness.deps);
  return program;
}

// ---------------------------------------------------------------------------
// AC1-AC3: resolveApprovalsFile
// ---------------------------------------------------------------------------

describe("resolveApprovalsFile", () => {
  test("AC1: returns <outputDir>/approvals.json when the config sets name and an absolute outputDir", async () => {
    await withProject(namedProjectConfig, async ({ workdir, outputDir }) => {
      expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(outputDir));
    });
  });

  test("AC1 boundary: a named config with no outputDir resolves under the global output dir for that name", async () => {
    await withProject(
      () => JSON.stringify({ name: PROJECT_NAME }),
      async ({ workdir }) => {
        expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(projectOutputDir(PROJECT_NAME, undefined)));
      },
    );
  });

  test("AC2: a config with no name falls back to basename(workdir)", async () => {
    await withProject(
      () => "{}",
      async ({ workdir }) => {
        expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(projectOutputDir(basename(workdir), undefined)));
      },
    );
  });

  test("AC2 boundary: a workdir with no .nax directory at all falls back to basename(workdir)", async () => {
    await withProject(
      () => null,
      async ({ workdir }) => {
        expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(projectOutputDir(basename(workdir), undefined)));
      },
    );
  });

  test("AC3: a .nax/config.json that is not valid JSON falls back to basename(workdir)", async () => {
    await withProject(
      () => '{ "name": "approvals-cli", "outputDir": ',
      async ({ workdir }) => {
        expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(projectOutputDir(basename(workdir), undefined)));
      },
    );
  });

  test("AC3 boundary: an unparseable config's outputDir is ignored, not used", async () => {
    let configuredOutputDir = "";
    await withProject(
      (outputDir) => {
        configuredOutputDir = outputDir;
        return `{"name": "${PROJECT_NAME}", "outputDir": "${outputDir}"`; // truncated: no closing brace
      },
      async ({ workdir }) => {
        const resolved = await resolveApprovalsFile(workdir);

        expect(resolved).toBe(approvalsPath(projectOutputDir(basename(workdir), undefined)));
        expect(resolved).not.toBe(approvalsPath(configuredOutputDir));
      },
    );
  });

  test("AC3 boundary: a zero-byte .nax/config.json falls back to basename(workdir)", async () => {
    await withProject(
      () => "",
      async ({ workdir }) => {
        expect(await resolveApprovalsFile(workdir)).toBe(approvalsPath(projectOutputDir(basename(workdir), undefined)));
      },
    );
  });
});

// ---------------------------------------------------------------------------
// _approvalsCliDeps defaults
// ---------------------------------------------------------------------------

describe("_approvalsCliDeps", () => {
  test("readApprovalsFileDetailed reads the real approvals store from disk", async () => {
    await withSeededStore({ entries: [makeEntry()] }, async ({ storePath }) => {
      const read = await _approvalsCliDeps.readApprovalsFileDetailed(storePath);

      expect(read.state).toBe("ok");
      expect(read.file.entries).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// AC4-AC5: registerApprovalsCommand
// ---------------------------------------------------------------------------

describe("registerApprovalsCommand", () => {
  test("registers an 'approvals' group whose 'list' subcommand exposes -d/--dir and --json", () => {
    const program = new Command();
    registerApprovalsCommand(program);

    const approvals = program.commands.find((c) => c.name() === "approvals");
    expect(approvals).toBeDefined();
    if (!approvals) throw new Error("approvals group not registered");
    const list = approvals.commands.find((c) => c.name() === "list");
    expect(list).toBeDefined();
    if (!list) throw new Error("approvals list subcommand not registered");

    const help = list.helpInformation();
    expect(help).toContain("--dir");
    expect(help).toContain("--json");
  });

  test("AC4: 'approvals list -d <workdir>' reads the store once at the path resolveApprovalsFile returns", async () => {
    await withProject(namedProjectConfig, async ({ workdir }) => {
      const readStub = mock(async (_path: string): Promise<ApprovalsFileRead> => OK_READ);
      const harness = makeHarness({ readApprovalsFileDetailed: readStub });
      const expectedPath = await resolveApprovalsFile(workdir);

      await registeredProgram(harness).parseAsync(["approvals", "list", "-d", workdir], { from: "user" });

      expect(readStub.mock.calls).toHaveLength(1);
      expect(readStub.mock.calls[0]?.[0]).toBe(expectedPath);
      expect(harness.readPaths).toEqual([expectedPath]);
    });
  });

  test("AC4 boundary: -d/--dir defaults to the current directory", async () => {
    const readStub = mock(async (_path: string): Promise<ApprovalsFileRead> => OK_READ);
    const harness = makeHarness({ readApprovalsFileDetailed: readStub });

    await registeredProgram(harness).parseAsync(["approvals", "list"], { from: "user" });

    expect(harness.readPaths).toEqual([await resolveApprovalsFile(process.cwd())]);
  });

  test("AC5: exits 0 for a store holding one remembered approval", async () => {
    await withSeededStore({ entries: [makeEntry()] }, async (project) => {
      const harness = makeHarness();

      await registeredProgram(harness).parseAsync(["approvals", "list", "-d", project.workdir], { from: "user" });

      expect(harness.exitCodes).toEqual([0]);
    });
  });

  test("AC5 boundary: exits 0 for an empty store", async () => {
    await withSeededStore({ entries: [] }, async (project) => {
      const harness = makeHarness();

      await registeredProgram(harness).parseAsync(["approvals", "list", "-d", project.workdir], { from: "user" });

      expect(harness.exitCodes).toEqual([0]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC5-AC16: approvalsListCommand
// ---------------------------------------------------------------------------

describe("approvalsListCommand — store header and count", () => {
  test("AC5: returns 0 for a store holding one remembered approval", async () => {
    await withSeededStore({ entries: [makeEntry()] }, async (project) => {
      expect(await listProject(project, makeHarness())).toBe(0);
    });
  });

  test("AC6: writes 'Approvals store: <path>' and 'Cache: trusted' as its first two stdout lines", async () => {
    await withSeededStore({ entries: [makeEntry()] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines[0]).toBe(`Approvals store: ${project.storePath}`);
      expect(lines[1]).toBe("Cache: trusted");
    });
  });

  test("AC7: writes the stdout line '2 remembered approvals' for a store with two entries", async () => {
    const entries = [makeEntry(), makeEntry({ command: "bun run lint", approvedAt: "2026-09-22T11:00:00.000Z" })];

    await withSeededStore({ entries }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain("2 remembered approvals");
    });
  });

  test("AC7 boundary: writes the stdout line '1 remembered approvals' for a store with exactly one entry", async () => {
    await withSeededStore({ entries: [makeEntry()] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain("1 remembered approvals");
    });
  });

  test("AC8: writes the stdout line '0 remembered approvals' for an empty untainted store", async () => {
    await withSeededStore({ entries: [] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain("0 remembered approvals");
    });
  });
});

describe("approvalsListCommand — entry block", () => {
  test("AC9: writes the entry's first line as '<id>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>'", async () => {
    const entry = makeEntry({
      stage: "verifier",
      command: "bun run verify",
      origin: "askRule",
      approvedAt: "2026-01-02T03:04:05.000Z",
      approvedBy: "console:alice",
      naxCommit: "abc1234",
    });

    await withSeededStore({ entries: [entry] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain(
        `${approvalId(entry)}  verifier  askRule  2026-01-02T03:04:05.000Z  console:alice  naxCommit abc1234`,
      );
    });
  });

  test("AC9 boundary: an entry with no approvedAt still prints, with an empty field between the separators", async () => {
    const entry = makeEntry({ approvedAt: "" });

    await withSeededStore({ entries: [entry] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain(
        `${approvalId(entry)}  implementer  escalate    telegram:123  naxCommit 7b37dbf74`,
      );
    });
  });

  test("AC10: writes the entry's root line as 10 spaces followed by 'root <root>'", async () => {
    await withSeededStore({ entries: [makeEntry({ root: "/repo/worktree-3" })] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain("          root /repo/worktree-3");
    });
  });

  test("AC11: writes a single-line command as 10 spaces followed by '$ <command>'", async () => {
    await withSeededStore({ entries: [makeEntry({ command: "bun run test" })] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      expect(harness.stdoutLines()).toContain("          $ bun run test");
    });
  });

  test("AC12: writes the second and later lines of a multi-line command each prefixed by 12 spaces", async () => {
    const entry = makeEntry({ command: "set -e\nbun run lint\nbun run build" });

    await withSeededStore({ entries: [entry] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines).toContain("          $ set -e");
      expect(lines).toContain("            bun run lint");
      expect(lines).toContain("            bun run build");
    });
  });

  test("AC13: writes a command containing API_KEY=abc123 to stdout with API_KEY=abc123 unaltered", async () => {
    const command = "export API_KEY=abc123 && bun run test";

    await withSeededStore({ entries: [makeEntry({ command })] }, async (project) => {
      const harness = makeHarness();

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines).toContain(`          $ ${command}`);
      expect(lines.some((line) => line.includes("API_KEY=abc123"))).toBe(true);
    });
  });
});

describe("approvalsListCommand — taint trust line", () => {
  test("AC14: writes the alive trust line for a taint whose pid is still running", async () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: TAINT_PID };

    await withSeededStore({ entries: [], taint }, async (project) => {
      const harness = makeHarness({ isProcessAlive: () => true });

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines[1]).toBe(
        `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid ${TAINT_PID}, alive) -- the cache is OFF; a trusted run will discard these entries.`,
      );
      expect(harness.pidsAsked).toEqual([TAINT_PID]);
    });
  });

  test("AC15: writes an exited trust line when the tainting pid is gone", async () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: TAINT_PID };

    await withSeededStore({ entries: [], taint }, async (project) => {
      const harness = makeHarness({ isProcessAlive: () => false });

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines[1]).toBe(
        `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid ${TAINT_PID}, exited) -- the cache is OFF; a trusted run will discard these entries.`,
      );
    });
  });

  test("AC16: writes the unknown-pid trust line when the taint carries no pid", async () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: undefined };

    await withSeededStore({ entries: [], taint }, async (project) => {
      const harness = makeHarness({ isProcessAlive: () => true });

      await listProject(project, harness);

      const lines = harness.stdoutLines();
      expect(lines[1]).toBe(
        `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid unknown) -- the cache is OFF; a trusted run will discard these entries.`,
      );
      expect(harness.pidsAsked).toEqual([]);
    });
  });
});
