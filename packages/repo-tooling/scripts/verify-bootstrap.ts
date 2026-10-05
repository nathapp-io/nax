#!/usr/bin/env bun
/**
 * Verifies a manually bootstrapped first publish (the D23 procedure): packs
 * `<name>@<version>` from npm and compares it with the package's staged
 * `.publish/`. Only the deliberately disabled provenance metadata may differ.
 *
 *   bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.3.0
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertBootstrapArtifact } from "#scripts/lib/bootstrap-artifact";
import { gatePackageRoot } from "#scripts/lib/package-root";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionArg(argv: readonly string[]): string {
  const version = argv.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  if (version === undefined || !VERSION.test(version)) throw new Error("bootstrap: --version=X.Y.Z is required");
  return version;
}

function main(): void {
  const pkgDir = gatePackageRoot();
  const version = versionArg(process.argv);
  const name: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).name;
  if (typeof name !== "string") throw new Error("bootstrap: package.json has no name");
  const temp = mkdtempSync(join(tmpdir(), `bootstrap-${name.replace(/^@[^/]+\//, "")}-`));
  try {
    const output = execFileSync("npm", ["pack", `${name}@${version}`, "--json", "--ignore-scripts"], {
      cwd: temp,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const filename: unknown = JSON.parse(output)[0]?.filename;
    if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) {
      throw new Error("bootstrap: npm pack returned an invalid filename");
    }
    const tarball = join(temp, filename);
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 });
    for (const entry of entries.trim().split("\n")) {
      if (!entry.startsWith("package/") || entry.split("/").includes("..")) {
        throw new Error(`bootstrap: unsafe tar entry ${entry}`);
      }
    }
    execFileSync("tar", ["-xzf", tarball, "-C", temp], { timeout: 30_000 });
    assertBootstrapArtifact(join(pkgDir, ".publish"), join(temp, "package"));
    console.log(`bootstrap: registry ${name}@${version} matches the prepared artifact; upload already complete`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main();
