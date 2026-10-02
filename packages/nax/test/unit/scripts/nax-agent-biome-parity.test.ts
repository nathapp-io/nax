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

describe("nax-agent biome config", () => {
  test("has nax's linter and formatter settings", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    expect(agent.linter).toEqual(nax.linter);
    expect(agent.formatter).toEqual(nax.formatter);
  });

  test("runs nax's root plugins from nax's biome-plugins directory", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    expect(agent.plugins).toEqual(nax.plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/")));
  });

  test("keeps nax's test/** override", async () => {
    const [nax, agent] = await Promise.all([config("nax"), config("nax-agent")]);
    const testOverride = (c: BiomeConfig) => c.overrides?.find((o) => o.includes?.includes("**/test/**"));
    expect(testOverride(agent)?.linter).toEqual(testOverride(nax)?.linter);
  });
});
