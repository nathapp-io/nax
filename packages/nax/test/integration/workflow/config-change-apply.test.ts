/**
 * US-003 (gate-config-route, #2897/#2898): `applyConfigChange` against a **real** temporary
 * repository. The behaviour is the file bytes, the reload through the run's config chain and the
 * commit git actually creates, so nothing here fakes git unless the case under test is a git
 * failure. `_configChangeDeps` is the seam for the failures a real run cannot be made to produce
 * (a throwing write, a commit that exits non-zero, a package config that stops validating).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { createConfigLoader, loadConfigForPackage, type NaxConfig, qualityConfigSelector } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";
import type { PackageRegistry, PackageView } from "@/runtime/packages";
import { createPackageRegistry } from "@/runtime/packages";
import { _configChangeDeps, type ApplyConfigChangeInput, applyConfigChange } from "@/workflow/config-change";

const CONFIG_REL = ".nax/mono/apps/admin/config.json";
const PACKAGE_REL = "apps/admin/package.json";
const ROOT_CONFIG_REL = ".nax/config.json";
const SUBJECT = "chore(nax): set quality.commands.testScoped for apps/admin (advisor D-3)";
const OLD_COMMAND = "bun test {{files}}";
const NEW_COMMAND = "bun test --isolate {{files}}";

/**
 * The committed per-package config: the scoped command under test plus two keys no change may
 * disturb. The manifest's `test` script is the only source of a candidate.
 */
const CONFIG_BODY = {
  quality: { commands: { lint: "biome check .", typecheck: "tsc --noEmit", testScoped: OLD_COMMAND } },
};
const CONFIG_TEXT = `${JSON.stringify(CONFIG_BODY, null, 2)}\n`;

const dirs: string[] = [];
const origDeps = {
  git: _configChangeDeps.git,
  loadConfigForPackage: _configChangeDeps.loadConfigForPackage,
  readFile: _configChangeDeps.readFile,
  writeFile: _configChangeDeps.writeFile,
};

afterEach(() => {
  _configChangeDeps.git = origDeps.git;
  _configChangeDeps.loadConfigForPackage = origDeps.loadConfigForPackage;
  _configChangeDeps.readFile = origDeps.readFile;
  _configChangeDeps.writeFile = origDeps.writeFile;
  _clearPackageConfigCache();
  _clearRootConfigCache();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  return out.trim();
}

interface Fixture {
  readonly dir: string;
  /** The story's base commit: the seed commit that carries the manifest and the config. */
  readonly base: string;
  readonly registry: PackageRegistry;
  readonly currentConfig: NaxConfig;
}

/** A temp repo whose committed package config and manifest make `NEW_COMMAND` an offered change. */
async function makeRepo(opts: { trackConfig?: boolean } = {}): Promise<Fixture> {
  const dir = makeTempDir("cfg-apply-");
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, ROOT_CONFIG_REL), "{}\n");
  await Bun.write(join(dir, CONFIG_REL), CONFIG_TEXT);
  await Bun.write(
    join(dir, PACKAGE_REL),
    `${JSON.stringify({ name: "admin", scripts: { test: "bun test --isolate" } }, null, 2)}\n`,
  );
  await Bun.write(join(dir, "a.txt"), "one\n");
  if (opts.trackConfig === false) await git(dir, "add", ROOT_CONFIG_REL, PACKAGE_REL, "a.txt");
  else await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  const base = await git(dir, "rev-parse", "HEAD");
  const rootConfig = await loadConfigForPackage(dir, undefined, makeNaxConfig());
  const registry = createPackageRegistry(createConfigLoader(rootConfig), dir);
  await registry.hydrate(["apps/admin"]);
  const currentConfig = await loadConfigForPackage(dir, "apps/admin", rootConfig);
  return { dir, base, registry, currentConfig };
}

type Change = ApplyConfigChangeInput["change"];

/** The advisor's pick: the manifest's `test` script, in the `{{files}}` form the scoped gate needs. */
function change(over: Partial<Change> = {}): Change {
  return {
    kind: "config-change",
    key: "testScoped",
    to: NEW_COMMAND,
    script: "test",
    reason: "matches the package test script",
    decisionId: "D-3",
    needsHumanConfirm: false,
    ...over,
  };
}

function input(f: Fixture, over: Partial<ApplyConfigChangeInput> = {}): ApplyConfigChangeInput {
  return {
    projectDir: f.dir,
    packageDir: "apps/admin",
    base: f.base,
    change: change(),
    currentConfig: f.currentConfig,
    registry: f.registry,
    ...over,
  };
}

/**
 * A registry that delegates to the real one and can fail its first refresh. It counts calls, which
 * is how the "refresh again after the restore" requirement is observable at all.
 */
function countingRegistry(
  real: PackageRegistry,
  failFirst = false,
): { registry: PackageRegistry; refreshes: string[] } {
  const refreshes: string[] = [];
  const registry: PackageRegistry = {
    all: () => real.all(),
    resolve: (dir) => real.resolve(dir),
    repo: () => real.repo(),
    hydrate: (packageDirs, loadOverride) => real.hydrate(packageDirs, loadOverride),
    refresh: async (dir, loadOverride) => {
      refreshes.push(dir);
      if (failFirst && refreshes.length === 1) throw new Error("registry refresh failed");
      return real.refresh(dir, loadOverride);
    },
  };
  return { registry, refreshes };
}

const fileText = (dir: string, rel: string): Promise<string> => Bun.file(join(dir, rel)).text();
const configText = (dir: string): Promise<string> => fileText(dir, CONFIG_REL);
const headSha = (dir: string): Promise<string> => git(dir, "rev-parse", "HEAD");
const headPaths = (dir: string): Promise<string> => git(dir, "show", "--name-only", "--format=", "HEAD");
const headSubject = (dir: string): Promise<string> => git(dir, "log", "-1", "--format=%s");

/** The command a package view selects for the scoped gate — what the gate ops read. */
function selectedCommand(view: PackageView | undefined): string | string[] | undefined {
  return view?.select(qualityConfigSelector).quality.commands.testScoped;
}

/** The command the run would resolve for the package now, i.e. what the next gate would run. */
async function resolvedCommand(f: Fixture): Promise<string | string[] | undefined> {
  const config = await loadConfigForPackage(f.dir, "apps/admin", f.currentConfig);
  return config.quality.commands.testScoped;
}

describe("applyConfigChange — an offered change", () => {
  test("AC-1: applies and reports the command it replaced", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({
      applied: true,
      key: "testScoped",
      from: OLD_COMMAND,
      to: NEW_COMMAND,
    });
  });

  test("AC-2: the config file gains the new command and keeps its other keys", async () => {
    const f = await makeRepo();
    await applyConfigChange(input(f));
    expect(JSON.parse(await configText(f.dir))).toEqual({
      quality: { commands: { lint: "biome check .", typecheck: "tsc --noEmit", testScoped: NEW_COMMAND } },
    });
  });

  test("AC-3: HEAD's commit changes only the package config file", async () => {
    const f = await makeRepo();
    await applyConfigChange(input(f));
    expect(await headPaths(f.dir)).toBe(CONFIG_REL);
  });

  test("AC-4: the commit names the key, the package and the advisor decision", async () => {
    const f = await makeRepo();
    await applyConfigChange(input(f));
    expect(await headSubject(f.dir)).toBe(SUBJECT);
  });

  test("AC-5: an uncommitted edit to another file stays uncommitted", async () => {
    const f = await makeRepo();
    await Bun.write(join(f.dir, "a.txt"), "one\ntwo\n");
    await applyConfigChange(input(f));
    expect(await git(f.dir, "status", "--porcelain", "--", "a.txt")).toBe("M a.txt");
  });

  test("AC-6: the returned package view selects the new scoped command", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f));
    expect(selectedCommand(result.packageView)).toBe(NEW_COMMAND);
  });

  test("the returned config is the reloaded one, so the next gate reads the new command", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f));
    expect(result.config?.quality.commands.testScoped).toBe(NEW_COMMAND);
    expect(await resolvedCommand(f)).toBe(NEW_COMMAND);
  });
});

describe("applyConfigChange — refusals that touch nothing", () => {
  test("AC-7: a change that needs human confirmation is refused", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f, { change: change({ needsHumanConfirm: true }) }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "needs-confirm" });
  });

  test("AC-8: a needs-confirm refusal leaves the config file's bytes unchanged", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    await applyConfigChange(input(f, { change: change({ needsHumanConfirm: true }) }));
    expect(await configText(f.dir)).toBe(before);
  });

  test("AC-9: a story whose package is the repo root is refused", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f, { packageDir: "" }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "root-package" });
  });

  test("AC-10: a root-package refusal does not move HEAD", async () => {
    const f = await makeRepo();
    const before = await headSha(f.dir);
    await applyConfigChange(input(f, { packageDir: "" }));
    expect(await headSha(f.dir)).toBe(before);
  });

  test("AC-11: a root-package refusal leaves the root config's bytes unchanged", async () => {
    const f = await makeRepo();
    const before = await fileText(f.dir, ROOT_CONFIG_REL);
    await applyConfigChange(input(f, { packageDir: "" }));
    expect(await fileText(f.dir, ROOT_CONFIG_REL)).toBe(before);
  });

  test("a packageDir of '.' is the repo root too, and is refused the same way", async () => {
    const f = await makeRepo();
    const before = await headSha(f.dir);
    const result = await applyConfigChange(input(f, { packageDir: "." }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "root-package" });
    expect(await headSha(f.dir)).toBe(before);
    expect(await configText(f.dir)).toBe(CONFIG_TEXT);
  });

  test("AC-12: a value no candidate offers is refused", async () => {
    const f = await makeRepo();
    const result = await applyConfigChange(input(f, { change: change({ to: "bun test --watch {{files}}" }) }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "not-offered" });
  });

  test("AC-13: a not-offered refusal leaves the config file's bytes unchanged", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    await applyConfigChange(input(f, { change: change({ to: "bun test --watch {{files}}" }) }));
    expect(await configText(f.dir)).toBe(before);
  });

  test("AC-14: an untracked config file is refused", async () => {
    const f = await makeRepo({ trackConfig: false });
    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({ applied: false, reason: "untracked" });
  });

  test("AC-15: an untracked refusal leaves the config file's bytes unchanged", async () => {
    const f = await makeRepo({ trackConfig: false });
    const before = await configText(f.dir);
    await applyConfigChange(input(f));
    expect(await configText(f.dir)).toBe(before);
  });
});

describe("applyConfigChange — a failure after the write restores the file", () => {
  test("AC-16: a failing git commit is refused as commit-failed", async () => {
    const f = await makeRepo();
    _configChangeDeps.git = async (args, cwd) =>
      args[0] === "commit" ? { stdout: "", stderr: "hook failed", exitCode: 1 } : origDeps.git(args, cwd);

    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({ applied: false, reason: "commit-failed" });
  });

  test("AC-17: when the commit fails the config file has its original bytes", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    _configChangeDeps.git = async (args, cwd) =>
      args[0] === "commit" ? { stdout: "", stderr: "hook failed", exitCode: 1 } : origDeps.git(args, cwd);

    await applyConfigChange(input(f));
    expect(await configText(f.dir)).toBe(before);
  });

  // F1: the change's own `git add` staged the new bytes. Restoring the working tree alone would
  // leave them in the index, where the next commit in the run would sweep the change in.
  test("F1: a failed commit also takes the config path back out of the index, keeping other staged edits", async () => {
    const f = await makeRepo();
    await Bun.write(join(f.dir, "a.txt"), "one\ntwo\n");
    await git(f.dir, "add", "--", "a.txt");
    _configChangeDeps.git = async (args, cwd) =>
      args[0] === "commit" ? { stdout: "", stderr: "hook failed", exitCode: 1 } : origDeps.git(args, cwd);

    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({ applied: false, reason: "commit-failed" });
    // Only the unrelated edit is still staged, and the config path is clean in index and worktree.
    expect(await git(f.dir, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(await git(f.dir, "status", "--porcelain", "--", CONFIG_REL)).toBe("");
    expect(await git(f.dir, "status", "--porcelain", "--", "a.txt")).toBe("M  a.txt");
  });

  // F2: a rollback that cannot write the file leaves the tree in a state a plain refusal would hide.
  test("F2: a rollback that cannot write the file throws instead of reporting an ordinary refusal", async () => {
    const f = await makeRepo();
    const configPath = join(f.dir, CONFIG_REL);
    _configChangeDeps.writeFile = async (path) => {
      await Bun.write(path, "{");
      // The restore writes this same path, so make that impossible from here on.
      chmodSync(configPath, 0o444);
      throw new Error("EIO: write failed");
    };

    try {
      await expect(applyConfigChange(input(f))).rejects.toMatchObject({ code: "CONFIG_CHANGE_ROLLBACK_FAILED" });
    } finally {
      chmodSync(configPath, 0o644);
    }
  });

  test("AC-18: a config that stops resolving is refused as invalid-config", async () => {
    const f = await makeRepo();
    _configChangeDeps.loadConfigForPackage = async () => {
      throw new Error("quality.commands.testScoped: invalid");
    };

    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({ applied: false, reason: "invalid-config" });
  });

  test("AC-19: when the reload throws the config file has its original bytes", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    _configChangeDeps.loadConfigForPackage = async () => {
      throw new Error("quality.commands.testScoped: invalid");
    };

    await applyConfigChange(input(f));
    expect(await configText(f.dir)).toBe(before);
  });

  test("AC-20: when the reload throws HEAD does not move", async () => {
    const f = await makeRepo();
    const before = await headSha(f.dir);
    _configChangeDeps.loadConfigForPackage = async () => {
      throw new Error("quality.commands.testScoped: invalid");
    };

    await applyConfigChange(input(f));
    expect(await headSha(f.dir)).toBe(before);
  });

  test("AC-21: a throwing write is refused as write-failed", async () => {
    const f = await makeRepo();
    _configChangeDeps.writeFile = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    const result = await applyConfigChange(input(f));
    expect(result.outcome).toMatchObject({ applied: false, reason: "write-failed" });
  });

  test("AC-22: a write that changes the file and then throws still restores the original bytes", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    _configChangeDeps.writeFile = async (path) => {
      // A half-landed write: the destination is truncated, then the error surfaces.
      await Bun.write(path, `{"quality":{"commands":{"testScoped":`);
      throw new Error("EIO: write failed");
    };

    await applyConfigChange(input(f));
    expect(await configText(f.dir)).toBe(before);
  });

  test("AC-23: a registry refresh that throws for the new config is refused as invalid-config", async () => {
    const f = await makeRepo();
    const { registry } = countingRegistry(f.registry, true);

    const result = await applyConfigChange(input(f, { registry }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "invalid-config" });
  });

  test("AC-24: when the refresh throws the config file has its original bytes", async () => {
    const f = await makeRepo();
    const before = await configText(f.dir);
    const { registry } = countingRegistry(f.registry, true);

    await applyConfigChange(input(f, { registry }));
    expect(await configText(f.dir)).toBe(before);
  });

  test("AC-25: a failed reload or refresh clears the cache and refreshes again after the restore", async () => {
    const failingReload = await makeRepo();
    _configChangeDeps.loadConfigForPackage = async () => {
      throw new Error("quality.commands.testScoped: invalid");
    };
    const reloadRegistry = countingRegistry(failingReload.registry);
    await applyConfigChange(input(failingReload, { registry: reloadRegistry.registry }));
    // One refresh: the reload threw before the registry was touched, so the single call is the
    // post-restore one, and it lands on the original command.
    expect(reloadRegistry.refreshes).toEqual(["apps/admin"]);
    expect(selectedCommand(reloadRegistry.registry.resolve("apps/admin"))).toBe(OLD_COMMAND);
    _configChangeDeps.loadConfigForPackage = origDeps.loadConfigForPackage;

    const failingRefresh = await makeRepo();
    const refreshRegistry = countingRegistry(failingRefresh.registry, true);
    const result = await applyConfigChange(input(failingRefresh, { registry: refreshRegistry.registry }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "invalid-config" });
    // Two refreshes: the failing one, then the one that reloads the restored bytes.
    expect(refreshRegistry.refreshes).toEqual(["apps/admin", "apps/admin"]);
    expect(selectedCommand(refreshRegistry.registry.resolve("apps/admin"))).toBe(OLD_COMMAND);
    // The cache was cleared too, which is the only way the restored file is what resolves now.
    expect(await resolvedCommand(failingRefresh)).toBe(OLD_COMMAND);
  });

  test("AC-26: a failed commit clears the cache and refreshes the registry again after the restore", async () => {
    const f = await makeRepo();
    const { registry, refreshes } = countingRegistry(f.registry);
    _configChangeDeps.git = async (args, cwd) =>
      args[0] === "commit" ? { stdout: "", stderr: "hook failed", exitCode: 1 } : origDeps.git(args, cwd);

    const result = await applyConfigChange(input(f, { registry }));
    expect(result.outcome).toMatchObject({ applied: false, reason: "commit-failed" });
    expect(refreshes).toEqual(["apps/admin", "apps/admin"]);
    expect(selectedCommand(registry.resolve("apps/admin"))).toBe(OLD_COMMAND);
    expect(await resolvedCommand(f)).toBe(OLD_COMMAND);
  });
});
