import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const SCRIPT = join(import.meta.dir, "../../../scripts/verify-bootstrap.ts");

test("verify-bootstrap packs <name>@<version>, compares the payload, and cleans up on success or failure", () => {
  const dir = makeTempDir("verify-bootstrap-");
  try {
    const pkgDir = join(dir, "pkg");
    mkdirSync(pkgDir);
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@nathapp/nax-agent-acp", version: "0.3.0" }));
    const registryPkg = join(dir, "registry/package");
    mkdirSync(registryPkg, { recursive: true });
    writeFileSync(join(registryPkg, "package.json"), JSON.stringify({ publishConfig: { provenance: false } }));
    writeFileSync(join(registryPkg, "index.js"), "export const answer = 42;");
    cpSync(registryPkg, join(pkgDir, ".publish"), { recursive: true });
    execFileSync("tar", ["-czf", join(dir, "registry.tgz"), "-C", join(dir, "registry"), "package"]);
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/npm"),
      `#!/bin/sh
echo "$*" > "$CALL_LOG"
if [ "$NPM_FAIL" = "1" ]; then exit 1; fi
cp "$REGISTRY_TARBALL" ./registry.tgz
echo '[{"filename":"registry.tgz"}]'
`,
    );
    chmodSync(join(dir, "bin/npm"), 0o755);
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          TMPDIR: tmp,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          CALL_LOG: join(dir, "calls"),
          REGISTRY_TARBALL: join(dir, "registry.tgz"),
          ...env,
        },
      });
    const ok = run(["--package=.", "--version=0.3.0"]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe(
      "pack @nathapp/nax-agent-acp@0.3.0 --json --ignore-scripts\n",
    );
    expect(run(["--package=."]).status).not.toBe(0);
    expect(run(["--package=.", "--version=0.3"]).status).not.toBe(0);
    writeFileSync(join(pkgDir, ".publish/index.js"), "wrong");
    expect(run(["--package=.", "--version=0.3.0"]).status).not.toBe(0);
    expect(run(["--package=.", "--version=0.3.0"], { NPM_FAIL: "1" }).status).not.toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    cleanupTempDir(dir);
  }
});
