/**
 * nax-agent's and repo-tooling's biome.json are copies of nax's rule set
 * (S1-5 move script), not `extends` of it: a nested `"root": false` config
 * inherits nothing in Biome 2.5. nax-agent and repo-tooling are fully pinned:
 * their entire biome.json must equal nax's with every plugin path remapped —
 * the plugin-path remap is the only allowed difference. test-kit is partially
 * pinned (linter/formatter settings, root plugins, and the test/** override)
 * because it deliberately lacks nax's bin/** and scripts/** overrides — it has
 * neither directory.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..", "..", "..");

interface BiomeConfig {
  linter?: unknown;
  formatter?: unknown;
  plugins?: string[];
  overrides?: Array<{ includes?: string[]; plugins?: string[]; linter?: unknown }>;
}

async function config(pkg: string): Promise<BiomeConfig> {
  const parsed: BiomeConfig = await Bun.file(join(PACKAGES, pkg, "biome.json")).json();
  return parsed;
}

for (const pkg of ["nax-agent", "test-kit", "repo-tooling"]) {
  describe(`${pkg} biome config`, () => {
    test("has nax's linter and formatter settings", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy.linter).toEqual(nax.linter);
      expect(copy.formatter).toEqual(nax.formatter);
    });

    test("runs nax's root plugins from nax's biome-plugins directory", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy.plugins).toEqual(nax.plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/")));
    });

    test("keeps nax's test/** override", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      const testOverride = (c: BiomeConfig) => c.overrides?.find((o) => o.includes?.includes("**/test/**"));
      expect(testOverride(copy)?.linter).toEqual(testOverride(nax)?.linter);
    });
  });
}

/**
 * Full-config pin: nax-agent and repo-tooling carry the same override set as
 * nax, so their whole biome.json must equal nax's with every plugin path
 * remapped. test-kit lacks nax's bin/** and scripts/** overrides (it has
 * neither directory), so it stays on the partial pins above.
 */
function withRemappedPluginPaths(nax: BiomeConfig): BiomeConfig {
  const remap = (plugins?: string[]) => plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/"));
  return {
    ...nax,
    plugins: remap(nax.plugins),
    overrides: nax.overrides?.map((o) => ({ ...o, plugins: remap(o.plugins) })),
  };
}

for (const pkg of ["nax-agent", "repo-tooling"]) {
  describe(`${pkg} biome config — full pin`, () => {
    test("equals nax's config with every plugin path remapped", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy).toEqual(withRemappedPluginPaths(nax));
    });
  });
}
