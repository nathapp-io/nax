import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { _qualityDeps, loadQualityCommands, runQualityGates } from "@flows/nax-finish/steps/quality";
import { withTempDir } from "@test/helpers";

const originalRunShell = _qualityDeps.runShell;
const originalReadText = _qualityDeps.readText;
afterEach(() => {
  _qualityDeps.runShell = originalRunShell;
  _qualityDeps.readText = originalReadText;
});

describe("quality gates", () => {
  test("passes when all set commands exit 0; skips unset", async () => {
    _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runQualityGates("/repo", { typecheck: "bun run typecheck", test: "bun run test" });
    expect(r.passed).toBe(true);
    expect(r.ran).toEqual(["typecheck", "test"]);
    expect(r.failing).toEqual([]);
  });

  test("collects failing gates by name", async () => {
    _qualityDeps.runShell = async (command) => ({
      exitCode: command.includes("lint") ? 1 : 0,
      stdout: "",
      stderr: "lint bad",
    });
    const r = await runQualityGates("/repo", { lint: "bun run lint", test: "bun run test" });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(["lint"]);
  });

  test("runs each command through a shell, so composed commands survive intact", async () => {
    const seen: { command: string; cwd: string; timeoutMs?: number }[] = [];
    _qualityDeps.runShell = async (command, opts) => {
      seen.push({ command, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runQualityGates("/repo", { lint: 'bun run lint && echo "done"' }, { timeoutMs: 4321 });
    expect(seen[0].command).toBe('bun run lint && echo "done"');
    expect(seen[0].cwd).toBe("/repo");
    expect(seen[0].timeoutMs).toBe(4321);
  });

  test("no configured commands is NOT a pass — nothing was verified", async () => {
    let called = false;
    _qualityDeps.runShell = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await runQualityGates("/repo", {});
    expect(called).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.ran).toEqual([]);
    expect(r.output).toContain("no quality.commands configured");
  });
});

describe("loadQualityCommands", () => {
  test("returns commands parsed from the repo-root .nax/config.json", async () => {
    const paths: string[] = [];
    _qualityDeps.readText = async (p) => {
      paths.push(p);
      return JSON.stringify({ quality: { commands: { typecheck: "bun run typecheck", lint: "bun run lint" } } });
    };
    const r = await loadQualityCommands("/repo");
    expect(paths).toEqual(["/repo/.nax/config.json"]);
    expect(r).toEqual({ typecheck: "bun run typecheck", lint: "bun run lint" });
  });

  test("returns {} when config file is missing", async () => {
    _qualityDeps.readText = async () => null;
    expect(await loadQualityCommands("/repo")).toEqual({});
  });

  test("throws a coded error when the config file is corrupt", async () => {
    _qualityDeps.readText = async () => "{ not json";
    await expect(loadQualityCommands("/repo")).rejects.toThrow(/Failed to parse .nax\/config.json/);
  });
});

/**
 * The default `readText` is the node:fs port of what used to be `Bun.file()` —
 * every test above injects over it, so without these it would ship uncovered,
 * exactly as the `Bun.file` version did before it threw inside acpx's Node
 * process. These exercise the real implementation against a real file.
 */
describe("_qualityDeps.readText (real fs)", () => {
  test("reads config through the real loader", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await writeFile(join(dir, ".nax", "config.json"), JSON.stringify({ quality: { commands: { test: "go test" } } }));
      expect(await loadQualityCommands(dir)).toEqual({ test: "go test" });
    });
  });

  test("returns null for a missing file rather than throwing ENOENT", async () => {
    await withTempDir(async (dir) => {
      expect(await _qualityDeps.readText(join(dir, "nope.json"))).toBeNull();
      expect(await loadQualityCommands(dir)).toEqual({});
    });
  });

  test("propagates non-ENOENT errors instead of silently reporting no commands", async () => {
    await withTempDir(async (dir) => {
      // A directory, not a file — read fails with EISDIR, which must not be
      // swallowed into a false "no quality commands configured".
      await mkdir(join(dir, "adir"));
      await expect(_qualityDeps.readText(join(dir, "adir"))).rejects.toThrow();
    });
  });
});
