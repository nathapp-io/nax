/** US-004: operator-facing project trust management commands. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { Command } from "commander";
import { registerTrustCommand } from "@/cli/trust";
import { addTrustEntry, trustStorePath } from "@/trust";

const cli = await import("@/cli");
const fallbackDeps: Record<string, unknown> = {};

let globalDir: string;
let projectDir: string;
let originalGlobalDir: string | undefined;
let originalDeps: unknown;
let savedDeps: Map<string, unknown>;
let stdout: string[];
let stderr: string[];
let tty: boolean;
let confirmation: boolean;
let home: string;
let cwd: string;

function getExport(name: string): (...args: unknown[]) => unknown {
  const value = Reflect.get(cli, name);
  expect(typeof value).toBe("function");
  if (typeof value !== "function") throw new Error(`Missing CLI export: ${name}`);
  return value;
}

async function runCommand(name: string, options: object): Promise<unknown> {
  const command = getExport(name);
  return Reflect.apply(command, undefined, [options]);
}

function deps(): object {
  const value = Reflect.get(cli, "_cliTrustDeps");
  if (typeof value !== "object" || value === null) return fallbackDeps;
  return value;
}

function replaceDep(name: string, value: unknown): void {
  const target = deps();
  if (!savedDeps.has(name)) savedDeps.set(name, Reflect.get(target, name));
  Reflect.set(target, name, value);
}

function seedStore(paths: string[]): Promise<undefined[]> {
  return Promise.all(paths.map((path) => addTrustEntry(path, "cli").then(() => undefined)));
}

function linesStarting(prefix: string): string[] {
  return stdout.filter((line) => line.startsWith(prefix));
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

beforeEach(() => {
  globalDir = realpathSync(makeTempDir("nax-cli-trust-global-"));
  projectDir = realpathSync(makeTempDir("nax-cli-trust-project-"));
  originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  originalDeps = Reflect.get(cli, "_cliTrustDeps");
  savedDeps = new Map();
  stdout = [];
  stderr = [];
  tty = false;
  confirmation = false;
  home = realpathSync(makeTempDir("nax-cli-trust-home-"));
  cwd = projectDir;
  replaceDep("log", (text: string) => stdout.push(text));
  replaceDep("error", (text: string) => stderr.push(text));
  replaceDep("isTTY", () => tty);
  replaceDep("confirm", async () => confirmation);
  replaceDep("homedir", () => home);
  replaceDep("cwd", () => cwd);
});

afterEach(() => {
  if (typeof originalDeps === "object" && originalDeps !== null) {
    for (const [name, value] of savedDeps) Reflect.set(originalDeps, name, value);
  }
  if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  cleanupTempDir(globalDir);
  cleanupTempDir(projectDir);
  cleanupTempDir(home);
});

describe("trustListCommand", () => {
  test("US-004 AC1: marks the cwd-covering folder and indents other folder entries", async () => {
    const a = join(projectDir, "a");
    const b = join(projectDir, "b");
    mkdirSync(join(a, "x"), { recursive: true });
    await seedStore([a, b]);
    cwd = join(a, "x");

    await runCommand("trustListCommand", {});

    expect(linesStarting("* ").some((line) => line.includes(a))).toBe(true);
    expect(linesStarting("  ").some((line) => line.includes(b))).toBe(true);
  });

  test("US-004 AC2: emits the complete JSON list and cwd coverage", async () => {
    await seedStore([projectDir]);
    cwd = projectDir;

    await runCommand("trustListCommand", { json: true });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      path: trustStorePath(),
      folders: [{ path: projectDir, addedAt: expect.any(String), via: "cli" }],
      coveringCwd: projectDir,
    });
  });
});

describe("trustAddCommand", () => {
  test("US-004 AC3: adds the explicit directory to an absent store as a CLI entry", async () => {
    expect(await runCommand("trustAddCommand", { path: projectDir, yes: true })).toBe(0);
    const read = await (await import("@/trust")).readTrustStore();
    expect(read.state === "ok" ? read.file.folders : []).toEqual([
      { path: projectDir, addedAt: expect.any(String), via: "cli" },
    ]);
  });

  test("US-004 AC4: defaults the added path to the injected current directory", async () => {
    cwd = projectDir;
    expect(await runCommand("trustAddCommand", { yes: true })).toBe(0);
    const read = await (await import("@/trust")).readTrustStore();
    expect(read.state === "ok" ? read.file.folders.map((entry) => entry.path) : []).toEqual([projectDir]);
  });

  test("US-004 AC5: reports an existing covering folder without adding a descendant", async () => {
    await seedStore([projectDir]);
    const child = join(projectDir, "c");

    expect(await runCommand("trustAddCommand", { path: child, yes: true })).toBe(0);

    expect(stdout).toContain(`Already trusted: ${child} is covered by ${projectDir}`);
  });

  test("US-004 AC6: refuses filesystem root without force and does not create a store", async () => {
    expect(await runCommand("trustAddCommand", { path: "/", yes: true })).toBe(1);
    expect(stderr.join("\n")).toContain("Pass --force");
    expect(existsSync(trustStorePath())).toBe(false);
  });

  test("US-004 AC7: refuses the injected home directory without force", async () => {
    expect(await runCommand("trustAddCommand", { path: home, yes: true })).toBe(1);
    expect(existsSync(trustStorePath())).toBe(false);
  });

  test("US-004 AC8: force allows filesystem root to be trusted", async () => {
    expect(await runCommand("trustAddCommand", { path: "/", yes: true, force: true })).toBe(0);
    const read = await (await import("@/trust")).readTrustStore();
    expect(read.state === "ok" ? read.file.folders.map((entry) => entry.path) : []).toContain("/");
  });

  test("US-004 AC9: refuses a protected root before considering an existing covering entry", async () => {
    await seedStore(["/"]);
    expect(await runCommand("trustAddCommand", { path: "/", yes: true })).toBe(1);
  });

  test("US-004 AC10: protected-home refusal takes precedence over non-TTY refusal", async () => {
    tty = false;
    expect(await runCommand("trustAddCommand", { path: home })).toBe(1);
    expect(stderr.join("\n")).toContain("Pass --force");
    expect(stderr.join("\n")).not.toContain("stdin is not a TTY");
  });

  test("US-004 AC11: an already-covered descendant is accepted without a TTY", async () => {
    await seedStore([projectDir]);
    tty = false;
    expect(await runCommand("trustAddCommand", { path: join(projectDir, "c") })).toBe(0);
  });

  test("US-004 AC12: non-TTY add refuses without prompting or writing a store", async () => {
    let confirmed = false;
    replaceDep("confirm", async () => {
      confirmed = true;
      return true;
    });
    tty = false;

    expect(await runCommand("trustAddCommand", { path: projectDir })).toBe(1);
    expect(confirmed).toBe(false);
    expect(existsSync(trustStorePath())).toBe(false);
  });

  test("US-004 AC13: declines an interactive confirmation without writing", async () => {
    tty = true;
    confirmation = false;
    expect(await runCommand("trustAddCommand", { path: projectDir })).toBe(1);
    expect(stdout).toContain("Not trusted.");
    expect(existsSync(trustStorePath())).toBe(false);
  });

  test("US-004 AC14: adds the directory after interactive confirmation", async () => {
    tty = true;
    confirmation = true;
    expect(await runCommand("trustAddCommand", { path: projectDir })).toBe(0);
    const read = await (await import("@/trust")).readTrustStore();
    expect(read.state === "ok" ? read.file.folders.map((entry) => entry.path) : []).toContain(projectDir);
  });
});

describe("trustRmCommand", () => {
  test("US-004 AC15: removes the exact trusted entry", async () => {
    await seedStore([projectDir]);
    expect(await runCommand("trustRmCommand", { path: projectDir })).toBe(0);
    expect(stdout).toContain(`Removed ${projectDir}`);
    const read = await (await import("@/trust")).readTrustStore();
    expect(read.state === "ok" ? read.file.folders : []).toEqual([]);
  });

  test("US-004 AC16: reports a missing exact entry", async () => {
    expect(await runCommand("trustRmCommand", { path: projectDir })).toBe(1);
    expect(stderr.join("\n")).toContain(`No trust entry for ${projectDir}`);
  });

  test("US-004 AC17: reports when a removed descendant remains covered by its parent", async () => {
    await seedStore([projectDir]);
    const child = join(projectDir, "c");
    expect(await runCommand("trustRmCommand", { path: child })).toBe(1);
    expect(stderr.join("\n")).toContain(`${child} is still trusted through ${projectDir}`);
  });
});

describe("trustCheckCommand", () => {
  test("US-004 AC18: returns success for a trusted folder", async () => {
    await seedStore([projectDir]);
    expect(await runCommand("trustCheckCommand", { path: projectDir })).toBe(0);
  });

  test("US-004 AC19: reports an untrusted folder and returns failure", async () => {
    expect(await runCommand("trustCheckCommand", { path: projectDir })).toBe(1);
    expect(stdout).toContain(`untrusted: ${projectDir}`);
  });

  test("US-004 AC20: resolves a project root and emits covering-entry JSON", async () => {
    await seedStore([projectDir]);
    mkdirSync(join(projectDir, ".nax"), { recursive: true });
    writeFileSync(join(projectDir, ".nax", "config.json"), "{}");
    mkdirSync(join(projectDir, "src"), { recursive: true });

    await runCommand("trustCheckCommand", { path: join(projectDir, "src"), json: true });

    expect(JSON.parse(stdout.join("\n"))).toEqual({
      root: projectDir,
      trusted: true,
      coveredBy: projectDir,
    });
  });

  test("US-004 AC21: returns failure when the trust store cannot be parsed", async () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(trustStorePath(), "{not json");
    expect(await runCommand("trustCheckCommand", { path: projectDir })).toBe(1);
  });
});

async function runNax(args: string[], globalConfigDir: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalConfigDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout: output };
}

describe("trust CLI process behavior", () => {
  test("US-004 AC22: trust check --json exits 1 and prints JSON for an empty isolated store", async () => {
    const result = await runNax(["trust", "check", projectDir, "--json"], globalDir);
    expect(result.code).toBe(1);
    expect(parseJsonOrNull(result.stdout)).toMatchObject({ trusted: false });
  });

  test("US-004 AC23: trust add --yes persists trust for a subsequent CLI check", async () => {
    const add = await runNax(["trust", "add", projectDir, "--yes"], globalDir);
    const check = await runNax(["trust", "check", projectDir], globalDir);
    expect(add.code).toBe(0);
    expect(check.code).toBe(0);
  });
});

describe("trust CLI registration and refusal branches", () => {
  test.each([
    ["trustListCommand", {}],
    ["trustAddCommand", { path: "/unused", yes: true }],
    ["trustRmCommand", { path: "/unused" }],
  ])("%s refuses an unreadable store without writing", async (name, options) => {
    await Bun.write(trustStorePath(), "{not json");
    expect(await runCommand(name, options)).toBe(1);
    expect(stderr.join("\n")).toContain("could not be parsed");
    expect(stdout).toEqual([]);
    expect(await Bun.file(trustStorePath()).text()).toBe("{not json");
  });

  test("list reports an empty store", async () => {
    expect(await runCommand("trustListCommand", {})).toBe(0);
    expect(stdout).toEqual([`No trusted folders (${trustStorePath()})`]);
  });

  test("check JSON reports no covering entry", async () => {
    expect(await runCommand("trustCheckCommand", { json: true })).toBe(1);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ root: projectDir, trusted: false, coveredBy: null });
  });

  test("add reports concurrent coverage created during confirmation", async () => {
    tty = true;
    replaceDep("confirm", async () => {
      await addTrustEntry(projectDir, "cli");
      return true;
    });
    expect(await runCommand("trustAddCommand", { path: projectDir })).toBe(0);
    expect(stdout).toEqual([`Already trusted: ${projectDir} is covered by ${projectDir}`]);
  });

  test.each([
    ["list", ["trust", "list", "--json"], 0],
    ["add", ["trust", "add", "--yes"], 0],
    ["rm", ["trust", "rm", "/unused"], 1],
    ["check", ["trust", "check", "--json"], 1],
  ] as const)("registered %s action forwards flags and exit status", async (name, argv, code) => {
    const sentinel = new Error("captured trust command exit");
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });
    try {
      const program = new Command();
      registerTrustCommand(program);
      await expect(program.parseAsync([...argv], { from: "user" })).rejects.toBe(sentinel);
      expect(exit).toHaveBeenCalledWith(code);
      if (name === "list") expect(JSON.parse(stdout.join("\n"))).toMatchObject({ folders: [], coveringCwd: null });
      if (name === "add") expect(stdout).toEqual([`Trusted ${projectDir}`]);
      if (name === "rm") expect(stderr).toEqual(["No trust entry for /unused"]);
      if (name === "check") expect(JSON.parse(stdout.join("\n"))).toMatchObject({ trusted: false });
    } finally {
      exit.mockRestore();
    }
  });
});
