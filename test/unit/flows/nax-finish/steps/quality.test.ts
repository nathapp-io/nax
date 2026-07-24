import { afterEach, describe, expect, test } from "bun:test";
import { _qualityDeps, loadQualityCommands, runQualityGates } from "@flows/nax-finish/steps/quality";

const originalRun = _qualityDeps.run;
const originalReadText = _qualityDeps.readText;
afterEach(() => {
  _qualityDeps.run = originalRun;
  _qualityDeps.readText = originalReadText;
});

describe("quality gates", () => {
  test("passes when all set commands exit 0; skips unset", async () => {
    _qualityDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runQualityGates("/repo", { typecheck: "bun run typecheck", test: "bun run test" });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  test("collects failing gates by name", async () => {
    _qualityDeps.run = async (cmd) => ({ exitCode: cmd.join(" ").includes("lint") ? 1 : 0, stdout: "", stderr: "lint bad" });
    const r = await runQualityGates("/repo", { lint: "bun run lint", test: "bun run test" });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(["lint"]);
  });
});

describe("loadQualityCommands", () => {
  test("returns commands parsed from .nax/config.json", async () => {
    _qualityDeps.readText = async () =>
      JSON.stringify({ quality: { commands: { typecheck: "bun run typecheck", lint: "bun run lint" } } });
    const r = await loadQualityCommands("/repo");
    expect(r).toEqual({ typecheck: "bun run typecheck", lint: "bun run lint" });
  });

  test("returns {} when config file is missing", async () => {
    _qualityDeps.readText = async () => null;
    const r = await loadQualityCommands("/repo");
    expect(r).toEqual({});
  });
});
