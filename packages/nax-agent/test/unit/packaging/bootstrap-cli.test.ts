import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

test("bootstrap CLI downloads only 0.1.0, compares payload and cleans up on success or failure", () => {
  const dir = makeTempDir("bootstrap-cli-");
  try {
    mkdirSync(join(dir, "scripts/lib"), { recursive: true });
    for (const file of ["verify-bootstrap.ts", "lib/bootstrap-artifact.ts"]) {
      cpSync(new URL(`../../../scripts/${file}`, import.meta.url), join(dir, "scripts", file));
    }
    const packageDir = join(dir, "registry/package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ publishConfig: { provenance: false } }));
    writeFileSync(join(packageDir, "index.js"), "export const answer = 42;");
    cpSync(packageDir, join(dir, ".publish"), { recursive: true });
    execFileSync("tar", ["-czf", join(dir, "registry.tgz"), "-C", join(dir, "registry"), "package"]);
    mkdirSync(join(dir, "bin"));
    const npm = join(dir, "bin/npm");
    writeFileSync(
      npm,
      `#!/bin/sh
echo "$*" > "$CALL_LOG"
if [ "$NPM_FAIL" = "1" ]; then exit 1; fi
cp "$REGISTRY_TARBALL" ./registry.tgz
echo '[{"filename":"registry.tgz"}]'
`,
    );
    chmodSync(npm, 0o755);
    const run = (env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join(dir, "scripts/verify-bootstrap.ts")], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          TMPDIR: dir,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          CALL_LOG: join(dir, "calls"),
          REGISTRY_TARBALL: join(dir, "registry.tgz"),
          ...env,
        },
      });
    expect(run().status).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("pack @nathapp/nax-agent@0.1.0 --json --ignore-scripts\n");
    writeFileSync(join(dir, ".publish/index.js"), "wrong");
    expect(run().status).not.toBe(0);
    expect(run({ NPM_FAIL: "1" }).status).not.toBe(0);
    expect(readdirSync(dir).filter((name) => name.startsWith("nax-agent-bootstrap-"))).toEqual([]);
  } finally {
    cleanupTempDir(dir);
  }
});
