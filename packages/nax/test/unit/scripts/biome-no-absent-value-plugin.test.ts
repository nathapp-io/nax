/**
 * Pins the `absentValue<T>()` / `nullValue<T>()` gate, which is a Biome GritQL
 * plugin rather than a counter in scripts/check-test-escape-hatches.ts.
 *
 * Why it needs its own test — the same reason its `as never` sibling does, and
 * now a sharper one: the `absentValue` regex counter retired on 2026-08-27
 * (STATUS §8.14), so this plugin is the ONLY thing standing between the idiom
 * and a green build. Delete the `plugins` entry, rename the .grit file, or move
 * the `test/**` override and nothing else in the suite notices.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const PLUGIN = join(REPO, "biome-plugins", "no-absent-value.grit");
// The repo's own binary by absolute path: the probe runs in a temp cwd with no
// node_modules, where `bun x biome` resolves to nothing and prints empty stdout.
const BIOME = join(REPO, "node_modules", ".bin", "biome");

/** Lint one file with the repo's plugin, returning biome's plugin diagnostics. */
async function lintWithPlugin(fileName: string, source: string): Promise<string[]> {
  const dir = makeTempDir("nax-grit-absent-");
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
    await proc.exited;
    const parsed = JSON.parse(out) as { diagnostics: Array<{ category?: string; message?: string }> };
    return parsed.diagnostics.filter((d) => d.category === "plugin").map((d) => d.message ?? "");
  } finally {
    cleanupTempDir(dir);
  }
}

describe("biome-plugins/no-absent-value.grit", () => {
  test("the plugin file exists and biome.json wires it into the test/** override", async () => {
    expect(existsSync(PLUGIN)).toBe(true);
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };
    const testOverride = config.overrides?.find((o) => o.includes?.some((i) => i.includes("test")));
    expect(testOverride?.plugins).toContain("./biome-plugins/no-absent-value.grit");
  });

  test("flags both absentValue<T>() and nullValue<T>() call sites", async () => {
    const found = await lintWithPlugin(
      "a.test.ts",
      ["export const a = absentValue<string>();", "export const b = nullValue<number>();"].join("\n"),
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("absentValue");
  });

  test("flags a call site in a .tsx file — the extension the regex counter's glob once missed", async () => {
    const found = await lintWithPlugin("a.test.tsx", "export const a = absentValue<string>();\n");
    expect(found).toHaveLength(1);
  });

  test("does not flag the helper's own declarations", async () => {
    // test/helpers/absent.ts DECLARES the two functions rather than calling
    // them, which is why the plugin needs no path exemption where the retired
    // regex counter did.
    const found = await lintWithPlugin(
      "absent.ts",
      [
        "export function absentValue<T>(): T { throw new Error('x'); }",
        "export function nullValue<T>(): T { throw new Error('x'); }",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  test("does not flag a comment, a string, or an unrelated generic call", async () => {
    const found = await lintWithPlugin(
      "a.test.ts",
      [
        "/** prefer a real fixture over absentValue<T>() here. */",
        "export const s = 'a string mentioning absentValue<T>()';",
        "export const u = makeThing<string>();",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });
});
