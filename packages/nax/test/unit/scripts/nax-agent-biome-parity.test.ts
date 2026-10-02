/**
 * nax-agent's biome.json is a copy of nax's rule set (S1-5 move script), not an
 * `extends` of it: a nested `"root": false` config inherits nothing in Biome
 * 2.5. This pins the copy so a rule tightened in one package cannot silently
 * stay loose in the other.
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

for (const pkg of ["nax-agent", "test-kit"]) {
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
