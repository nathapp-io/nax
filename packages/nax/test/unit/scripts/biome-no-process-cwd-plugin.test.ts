/**
 * Pins the `process.cwd()` gate, which is a Biome GritQL plugin
 * (`biome-plugins/no-process-cwd.grit`) rather than the grep-based
 * `scripts/check-process-cwd.sh`, which retired once parity was proven: all
 * 32 real `process.cwd()` occurrences in `src/` sit inside the three
 * permitted paths, so the plugin's correct output on the real tree is
 * exactly 0.
 *
 * Why it needs its own test — the same reason its `as never` and
 * `no-empty-catch` siblings do, and with an extra dimension: this plugin is
 * wired through a scoped `biome.json` override (`src/**` minus the three
 * permitted paths via negated `includes`), not the root `plugins` array, so
 * the exemption itself is part of what can silently regress. Delete the
 * override, widen its `includes`, rename the .grit file, or introduce a
 * capturing regex group and nothing else in the suite notices — a GritQL
 * plugin that fails to load reports `<name> errored: ...` at **info**
 * severity with exit 0, indistinguishable from a clean run. The "does not
 * error" case below is the guard for it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const PLUGIN = join(REPO, "biome-plugins", "no-process-cwd.grit");
// The repo's own binary by absolute path: the probe runs in a temp cwd with no
// node_modules, where `bun x biome` resolves to nothing and prints empty stdout.
const BIOME = join(REPO, "node_modules", ".bin", "biome");

interface PluginRun {
  exitCode: number;
  messages: string[];
}

/**
 * Lints `relativePath` (written under a temp root that mirrors the repo's
 * `src/` layout) against the same scoped override shape biome.json uses,
 * returning the plugin's diagnostics.
 */
async function lintWithPlugin(relativePath: string, source: string): Promise<PluginRun> {
  const dir = makeTempDir("nax-grit-cwd-");
  try {
    writeFileSync(
      join(dir, "biome.json"),
      JSON.stringify({
        linter: { enabled: true, rules: { recommended: false } },
        overrides: [
          {
            includes: ["src/**", "!src/cli/**", "!src/commands/**", "!src/config/loader.ts"],
            plugins: [PLUGIN],
          },
        ],
      }),
    );
    const target = join(dir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
    const proc = Bun.spawn(
      [BIOME, "lint", "--config-path=.", relativePath, "--reporter=json", "--max-diagnostics=5000"],
      { cwd: dir, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const parsed = JSON.parse(out) as { diagnostics: Array<{ category?: string; message?: string }> };
    return {
      exitCode,
      messages: parsed.diagnostics.filter((d) => d.category === "plugin").map((d) => d.message ?? ""),
    };
  } finally {
    cleanupTempDir(dir);
  }
}

const flagged = (m: string[]): string[] => m.filter((s) => s.includes("process.cwd()"));

const SOURCE = "export const f = () => process.cwd();\n";

describe("biome-plugins/no-process-cwd.grit", () => {
  test("the plugin file exists and biome.json wires it into a scoped src/** override", async () => {
    expect(existsSync(PLUGIN)).toBe(true);
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      plugins?: string[];
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };
    expect(config.plugins ?? []).not.toContain("./biome-plugins/no-process-cwd.grit");
    const override = config.overrides?.find((o) => o.plugins?.includes("./biome-plugins/no-process-cwd.grit"));
    expect(override).toBeDefined();
    expect(override?.includes).toContain("src/**");
    expect(override?.includes).toContain("!src/cli/**");
    expect(override?.includes).toContain("!src/commands/**");
    expect(override?.includes).toContain("!src/config/loader.ts");
  });

  test("it never errors at load — this pins the silent-disarm trap the header documents", async () => {
    const { exitCode, messages } = await lintWithPlugin("src/probe.ts", "export const x = 1;\n");
    expect(messages.filter((m) => m.includes("errored"))).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("flags process.cwd() in a non-exempt src/ path, and biome exits non-zero", async () => {
    const { exitCode, messages } = await lintWithPlugin("src/routing/router.ts", SOURCE);
    expect(flagged(messages)).toHaveLength(1);
    expect(exitCode).not.toBe(0);
  });

  test.each([["src/cli/index.ts"], ["src/commands/run.ts"], ["src/config/loader.ts"]])(
    "stays silent in the permitted path %s",
    async (relativePath) => {
      const { exitCode, messages } = await lintWithPlugin(relativePath, SOURCE);
      expect(flagged(messages)).toEqual([]);
      expect(exitCode).toBe(0);
    },
  );

  test("does not flag a comment or a string that names the phrase", async () => {
    const { messages } = await lintWithPlugin(
      "src/routing/router.ts",
      ["// avoid process.cwd() here.", "export const s = 'a string mentioning process.cwd()';"].join("\n"),
    );
    expect(flagged(messages)).toEqual([]);
  });
});
