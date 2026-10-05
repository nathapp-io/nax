/**
 * The published build against the peer (S4 spec §8): a src/ file importing
 * `@nathapp/nax-agent` compiles with tsconfig.build.json, keeps the bare
 * specifier in its emit, and emits none of nax-agent's own files.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "../../..");
const TMP = join(PKG, "test/tmp/peer-build");

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("a source file importing the peer builds and emits only itself", () => {
  mkdirSync(join(TMP, "src"), { recursive: true });
  writeFileSync(
    join(TMP, "src/probe.ts"),
    [
      'import { AgentSessionError } from "@nathapp/nax-agent";',
      'export const make = (): AgentSessionError => new AgentSessionError("m", "AGENT_SESSION_CLOSED");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(TMP, "tsconfig.json"),
    JSON.stringify({
      extends: "../../../tsconfig.build.json",
      compilerOptions: { rootDir: "src", outDir: "out" },
      include: ["src/**/*.ts"],
      // The base config's exclude ("test", resolved against the base's directory) covers this probe; reset it.
      exclude: [],
    }),
  );
  const proc = Bun.spawnSync(["bun", "x", "tsc", "-p", join(TMP, "tsconfig.json")], { cwd: PKG });
  expect(proc.stdout.toString() + proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(readdirSync(join(TMP, "out")).sort()).toEqual(["probe.d.ts", "probe.js"]);
  expect(readFileSync(join(TMP, "out/probe.js"), "utf8")).toContain('from "@nathapp/nax-agent"');
});
