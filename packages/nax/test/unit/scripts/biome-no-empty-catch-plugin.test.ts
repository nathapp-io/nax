/**
 * Pins the undocumented-empty-`catch` gate, which is a Biome GritQL plugin
 * (`biome-plugins/no-empty-catch.grit`) rather than a built-in rule.
 *
 * Why it needs its own test: nothing else in the suite watches this shape.
 * Delete the `plugins` entry, rename the .grit file, or introduce a capture
 * group into its regex and the gate just stops firing — every future
 * `} catch {}` lands green. That last failure mode is the nastiest: GritQL
 * reads a regex capture group as a variable binding and reports
 * `p1 errored: regex pattern matched N variables` at **info** severity with
 * exit 0, which is indistinguishable from a clean run. The `does not error`
 * case below is the guard for it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const PLUGIN = join(REPO, "biome-plugins", "no-empty-catch.grit");
// The repo's own binary by absolute path: the probe runs in a temp cwd with no
// node_modules, where `bun x biome` resolves to nothing and prints empty stdout.
const BIOME = join(REPO, "node_modules", ".bin", "biome");

interface PluginRun {
  exitCode: number;
  messages: string[];
}

/** Lint one file with the repo's plugin, returning its plugin diagnostics. */
async function lintWithPlugin(fileName: string, source: string): Promise<PluginRun> {
  const dir = makeTempDir("nax-grit-catch-");
  try {
    writeFileSync(
      join(dir, "biome.json"),
      JSON.stringify({
        linter: { enabled: true, rules: { recommended: false } },
        plugins: [PLUGIN],
      }),
    );
    writeFileSync(join(dir, fileName), source);
    const proc = Bun.spawn([BIOME, "lint", "--config-path=.", fileName, "--reporter=json", "--max-diagnostics=5000"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
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

const flagged = (m: string[]): string[] => m.filter((s) => s.includes("Empty `catch`"));

describe("biome-plugins/no-empty-catch.grit", () => {
  test("the plugin file exists and biome.json wires it at the ROOT, not in an override", async () => {
    // Root-level on purpose: an empty catch is as inert in src/ as in test/.
    // An override entry would silently narrow it to one tree.
    expect(existsSync(PLUGIN)).toBe(true);
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      plugins?: string[];
      overrides?: Array<{ plugins?: string[] }>;
    };
    expect(config.plugins).toContain("./biome-plugins/no-empty-catch.grit");
    for (const override of config.overrides ?? []) {
      expect(override.plugins ?? []).not.toContain("./biome-plugins/no-empty-catch.grit");
    }
  });

  test("it never errors at load — a capture group would disarm it silently at exit 0", async () => {
    const { exitCode, messages } = await lintWithPlugin("probe.ts", "export const x = 1;\n");
    expect(messages.filter((m) => m.includes("errored"))).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("an undocumented empty catch is reported, and biome exits non-zero", async () => {
    const { exitCode, messages } = await lintWithPlugin(
      "probe.ts",
      ["export function f(): void {", "  try {", "    f();", "  } catch {}", "}", ""].join("\n"),
    );
    expect(flagged(messages)).toHaveLength(1);
    expect(exitCode).not.toBe(0);
  });

  test("it also catches the bound-error form, `catch (e) {}`", async () => {
    const { messages } = await lintWithPlugin(
      "probe.ts",
      ["export function f(): void {", "  try {", "    f();", "  } catch (e) {}", "}", ""].join("\n"),
    );
    expect(flagged(messages)).toHaveLength(1);
  });

  test("a comment in the body satisfies it — matching biome's own noEmptyBlockStatements", async () => {
    // This is the sanctioned route, and the reason the plugin carries a regex on
    // the node's source text: comments are trivia, so the structural pattern
    // alone cannot see them and would flag all 204 documented catches in the repo.
    const { exitCode, messages } = await lintWithPlugin(
      "probe.ts",
      [
        "export function f(): void {",
        "  try {",
        "    f();",
        "  } catch {",
        "    // Process may have already exited.",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(flagged(messages)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("a real statement in the body satisfies it", async () => {
    const { messages } = await lintWithPlugin(
      "probe.ts",
      ["export function f(): void {", "  try {", "    f();", "  } catch {", "    void 0;", "  }", "}", ""].join("\n"),
    );
    expect(flagged(messages)).toEqual([]);
  });

  test("`p.catch(() => {})` is not a catch clause and is left alone", async () => {
    // The deliberate-ignore idiom for a promise. 1077 of the 1087 sites biome's
    // own noEmptyBlockStatements reports are this shape or a no-op mock stub —
    // which is exactly why that rule was not adopted.
    const { messages } = await lintWithPlugin(
      "probe.ts",
      "export const f = (): void => {\n  Promise.resolve().catch(() => {});\n};\n",
    );
    expect(flagged(messages)).toEqual([]);
  });
});
