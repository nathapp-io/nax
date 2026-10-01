/**
 * Pins the `as never` gate, which is a Biome GritQL plugin rather than a
 * counter in scripts/check-test-escape-hatches.ts.
 *
 * Why it needs its own test: the regex counter is exercised by
 * check-test-escape-hatches.test.ts, but the plugin is wired through
 * biome.json and enforced by `bun run lint`. Delete the `plugins` line, rename
 * the .grit file, or move the `test/**` override and nothing else in the suite
 * notices — the gate just stops firing and every future `as never` lands green.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const PLUGIN = join(REPO, "biome-plugins", "no-as-never.grit");
// The repo's own binary by absolute path: the probe runs in a temp cwd with no
// node_modules, where `bun x biome` resolves to nothing and prints empty stdout.
const BIOME = join(REPO, "node_modules", ".bin", "biome");

/** Lint one file with the repo's plugin, returning biome's plugin diagnostics. */
async function lintWithPlugin(fileName: string, source: string): Promise<string[]> {
  const dir = makeTempDir("nax-grit-");
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

describe("biome-plugins/no-as-never.grit", () => {
  test("the plugin file exists and biome.json wires it at the ROOT, not in an override", async () => {
    // Root-level since 2026-08-27: `src/`'s last 2 sites were drained
    // (webhook-serve-compat.ts) and the scope widened to the whole repo. An
    // override entry would silently re-narrow it to `test/**` — the state it
    // was in when `src/` could add `as never` freely.
    expect(existsSync(PLUGIN)).toBe(true);
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      plugins?: string[];
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };
    expect(config.plugins).toContain("./biome-plugins/no-as-never.grit");
    for (const override of config.overrides ?? []) {
      expect(override.plugins ?? []).not.toContain("./biome-plugins/no-as-never.grit");
    }
  });

  test("flags `as never` in real code", async () => {
    const found = await lintWithPlugin("a.test.ts", "export const x = { a: 1 } as never;\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("as never");
  });

  test("flags `as never` in a .tsx file — the extension the regex counter's glob missed", async () => {
    const found = await lintWithPlugin("a.test.tsx", "export const x = { a: 1 } as never;\n");
    expect(found).toHaveLength(1);
  });

  test("does not flag a comment, a string, or a template literal that names the phrase", async () => {
    const found = await lintWithPlugin(
      "a.test.ts",
      [
        "/** asserts against the shape, not a `{} as never` cargo. */",
        "export const s = 'a string mentioning as never';",
        "export const t = `a template mentioning as never`;",
        "export const u = 1; // trailing comment: as never",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  test("does not flag other casts", async () => {
    const found = await lintWithPlugin(
      "a.test.ts",
      ["export const a = 1 as const;", "export const b = {} as Error;", "export const c = 1 as unknown;"].join("\n"),
    );
    expect(found).toEqual([]);
  });
});
