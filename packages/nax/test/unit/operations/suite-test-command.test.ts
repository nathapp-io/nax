import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeConfigSlice, makeNaxConfig } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import { resolveSuiteTestCommand } from "@/operations/suite-test-command";
import { _commandDefaultsDeps, clearCommandDefaultsCache } from "@/quality";
import type { PackageView } from "@/runtime";

type QualityCommands = NonNullable<NonNullable<NaxConfig["quality"]>["commands"]>;

const WORKDIR = "/repo/packages/a";
const REPO_ROOT = "/repo";

function packageView(opts: { config: NaxConfig; overlay?: Partial<NaxConfig> }): PackageView {
  return {
    packageDir: "packages/a",
    relativeFromRoot: "packages/a",
    repoRoot: REPO_ROOT,
    hasOverride: opts.overlay !== undefined,
    ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
    config: opts.config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(opts.config),
  };
}

/**
 * A raw per-package overlay declaring exactly the given `quality.commands` —
 * the shape `.nax/mono/<pkg>/config.json` produces before merging.
 */
function rawOverlay(commands: Partial<QualityCommands>): Partial<NaxConfig> {
  return { quality: makeConfigSlice("quality", { commands }) };
}

const savedDetectLanguage = _commandDefaultsDeps.detectLanguage;
const savedFileExists = _commandDefaultsDeps.fileExists;
const savedReadJson = _commandDefaultsDeps.readJson;

/** Force the detection fallback to yield `bun test` (a bun JS package with no test script). */
function detectBunTest(): void {
  _commandDefaultsDeps.detectLanguage = async () => "typescript";
  _commandDefaultsDeps.fileExists = async (p) => p.endsWith("bun.lock");
  _commandDefaultsDeps.readJson = async () => null;
}

/** Force the detection fallback to yield nothing at all. */
function detectNothing(): void {
  _commandDefaultsDeps.detectLanguage = async () => undefined;
  _commandDefaultsDeps.fileExists = async () => false;
  _commandDefaultsDeps.readJson = async () => null;
}

beforeEach(() => {
  clearCommandDefaultsCache();
});

afterEach(() => {
  _commandDefaultsDeps.detectLanguage = savedDetectLanguage;
  _commandDefaultsDeps.fileExists = savedFileExists;
  _commandDefaultsDeps.readJson = savedReadJson;
  clearCommandDefaultsCache();
});

describe("resolveSuiteTestCommand", () => {
  test("AC-1: an overlay declaring quality.commands.test runs from the package dir with provenance 'overlay'", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "bun run test" } } });

    const resolved = await resolveSuiteTestCommand({
      packageView: packageView({ config, overlay: rawOverlay({ test: "bun run test" }) }),
      workdir: WORKDIR,
      packageDir: "packages/a",
    });

    expect(resolved).toEqual({
      testCmd: "bun run test",
      cmdWorkdir: WORKDIR,
      provenance: "overlay",
    });
  });

  test("AC-2: an array test command is returned as the same array", async () => {
    const commands = ["bun run build", "bun run test"];
    const config = makeNaxConfig({ quality: { commands: { test: commands } } });

    const resolved = await resolveSuiteTestCommand({
      packageView: packageView({ config, overlay: rawOverlay({ test: commands }) }),
      workdir: WORKDIR,
      packageDir: "packages/a",
    });

    expect(resolved?.testCmd).toEqual(["bun run build", "bun run test"]);
    expect(resolved?.provenance).toBe("overlay");
  });

  test("AC-3: a root-only test command runs from the repo root with provenance 'root'", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "pytest" } } });

    const resolved = await resolveSuiteTestCommand({
      packageView: packageView({ config, overlay: rawOverlay({ lint: "eslint ." }) }),
      workdir: WORKDIR,
      packageDir: "packages/a",
    });

    expect(resolved?.testCmd).toBe("pytest");
    expect(resolved?.cmdWorkdir).toBe(REPO_ROOT);
    expect(resolved?.provenance).toBe("root");
  });

  test("AC-4: with nothing configured the detected command runs from the package dir with provenance 'detected'", async () => {
    detectBunTest();

    const resolved = await resolveSuiteTestCommand({
      packageView: packageView({ config: makeNaxConfig() }),
      workdir: WORKDIR,
      packageDir: "packages/a",
    });

    expect(resolved).toEqual({
      testCmd: "bun test",
      cmdWorkdir: WORKDIR,
      provenance: "detected",
    });
  });

  test("AC-5: with nothing configured and nothing detected it returns undefined", async () => {
    detectNothing();

    const resolved = await resolveSuiteTestCommand({
      packageView: packageView({ config: makeNaxConfig() }),
      workdir: WORKDIR,
      packageDir: "packages/a",
    });

    expect(resolved).toBeUndefined();
  });
});
